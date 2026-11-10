import hashlib
import json
import re
import uuid
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import datetime, timezone as datetime_timezone

from django.db import transaction
from django.db.models import Prefetch
from django.utils import timezone

from folders.models import Folder
from notes.models import Note
from notes.trash import TRASH_RETENTION
from playlists.models import Playlist, PlaylistVideo
from videos.models import Video, ViewingSession

from .models import (
    ChangeEvent,
    IdentityMapping,
    Installation,
    RecordState,
    SyncConflict,
    SyncOperation,
    IndexingJob,
)

_suppressed = ContextVar("sync_capture_suppressed", default=False)


@contextmanager
def suppress_tracking():
    token = _suppressed.set(True)
    try:
        yield
    finally:
        _suppressed.reset(token)


def installation_uuid():
    row, _ = Installation.objects.get_or_create(pk=1)
    return row.installation_uuid


def portable_snapshot(instance):
    if isinstance(instance, Playlist):
        return {
            "sync_uuid": str(instance.sync_uuid),
            "kind": instance.kind,
            "title": instance.title,
            "channel_name": instance.channel_name,
            "youtube_playlist_id": instance.youtube_playlist_id,
            "thumbnail_url": instance.thumbnail_url,
            "playlist_url": instance.playlist_url,
            "videos": [
                {
                    "youtube_id": item.video.youtube_id,
                    "title": item.video.title,
                    "channel_name": item.video.channel_name,
                    "thumbnail_url": item.video.thumbnail_url,
                    "position": item.position,
                }
                for item in instance.items.select_related("video").all()
            ],
            "created_at": instance.created_at.isoformat(),
            "updated_at": instance.updated_at.isoformat(),
            "deleted_at": instance.deleted_at.isoformat() if instance.deleted_at else None,
            "trash_batch_id": str(instance.trash_batch_id) if instance.trash_batch_id else None,
        }
    if isinstance(instance, Folder):
        return {
            "sync_uuid": str(instance.sync_uuid),
            "name": instance.name,
            "description": instance.description,
            "parent_sync_uuid": str(instance.parent.sync_uuid) if instance.parent_id else None,
            "created_at": instance.created_at.isoformat(),
            "updated_at": instance.updated_at.isoformat(),
            "deleted_at": instance.deleted_at.isoformat() if instance.deleted_at else None,
            "trash_batch_id": str(instance.trash_batch_id) if instance.trash_batch_id else None,
        }
    snapshot = {
        "sync_uuid": str(instance.sync_uuid),
        "title": instance.title,
        "document": instance.document,
        "content": instance.content,
        "note_type": instance.note_type,
        "folder_sync_uuid": str(instance.folder.sync_uuid) if instance.folder_id else None,
        "video_youtube_id": instance.video.youtube_id if instance.video_id else None,
        "timestamp_seconds": instance.timestamp_seconds,
        "created_at": instance.created_at.isoformat(),
        "updated_at": instance.updated_at.isoformat(),
        "deleted_at": instance.deleted_at.isoformat() if instance.deleted_at else None,
        "trash_batch_id": str(instance.trash_batch_id) if instance.trash_batch_id else None,
    }
    if not instance.video_id:
        return snapshot

    video = instance.video
    snapshot["video_snapshot"] = {
        "youtube_id": video.youtube_id,
        "title": video.title,
        "channel_name": video.channel_name,
        "channel_handle": video.channel_handle,
        "channel_id": video.channel_id,
        "thumbnail_url": video.thumbnail_url,
        "duration_seconds": video.duration_seconds,
        "transcript_status": video.transcript_status,
        "transcript": video.transcript,
        "transcript_language": video.transcript_language,
        "transcript_fetched_at": (
            video.transcript_fetched_at.isoformat()
            if video.transcript_fetched_at else None
        ),
        "created_at": video.created_at.isoformat(),
        "updated_at": video.updated_at.isoformat(),
    }
    prefetched_sessions = getattr(video, "_sync_viewing_sessions", None)
    if prefetched_sessions is None:
        session = ViewingSession.objects.filter(
            user_id=instance.user_id, video_id=video.pk
        ).first()
    else:
        session = prefetched_sessions[0] if prefetched_sessions else None
    snapshot["viewing_session"] = ({
        "last_position_seconds": session.last_position_seconds,
        "last_watched_at": session.last_watched_at.isoformat(),
    } if session is not None else None)
    return snapshot


@transaction.atomic
def write_change(owner, entity, record_uuid, snapshot, deleted=False,
                 origin_installation=None, origin_operation=None):
    state, created = RecordState.objects.select_for_update().get_or_create(
        owner=owner, entity=entity, record_uuid=record_uuid,
        defaults={
            "snapshot": snapshot, "deleted": deleted,
            "origin_installation": origin_installation,
            "origin_operation": origin_operation,
        },
    )
    if not created:
        state.revision += 1
        state.snapshot = snapshot
        state.deleted = deleted
        state.origin_installation = origin_installation
        state.origin_operation = origin_operation
        state.needs_repair = False
        state.save()
    operation_id = origin_operation or uuid.uuid4()
    ChangeEvent.objects.create(
        owner=owner, entity=entity, record_uuid=record_uuid,
        revision=state.revision, snapshot=snapshot, deleted=deleted,
        operation_id=operation_id, origin_installation=origin_installation,
        origin_operation=origin_operation,
    )
    return state


def capture_save(instance):
    if _suppressed.get() or instance.pk is None:
        return
    entity = (
        "note" if isinstance(instance, Note)
        else "folder" if isinstance(instance, Folder)
        else "playlist"
    )
    write_change(
        instance.user, entity, instance.sync_uuid, portable_snapshot(instance),
        deleted=instance.deleted_at is not None,
    )


def capture_video_save(video):
    if _suppressed.get():
        return
    for note in Note.objects.filter(video=video).select_related("user", "folder", "video"):
        _capture_video_note_change(note)


def capture_viewing_session_change(session, origin=None):
    if _suppressed.get() or (origin is not None and origin is not session):
        return
    for note in Note.objects.filter(
        user_id=session.user_id, video_id=session.video_id
    ).select_related("user", "folder", "video"):
        _capture_video_note_change(note)


def _capture_video_note_change(note):
    if note.deleted_at is not None:
        return
    snapshot = portable_snapshot(note)
    state = RecordState.objects.filter(
        owner_id=note.user_id, entity="note", record_uuid=note.sync_uuid
    ).first()
    if state and not state.deleted and not state.needs_repair and state.snapshot == snapshot:
        return
    write_change(note.user, "note", note.sync_uuid, snapshot)


def capture_delete(instance, origin):
    if _suppressed.get():
        return
    if instance.deleted_at is not None:
        return
    entity = (
        "note" if isinstance(instance, Note)
        else "folder" if isinstance(instance, Folder)
        else "playlist"
    )
    if origin is not instance:
        state = RecordState.objects.filter(
            owner_id=instance.user_id, entity=entity, record_uuid=instance.sync_uuid
        ).first()
        if state:
            state.needs_repair = True
            state.save(update_fields=("needs_repair", "updated_at"))
            SyncConflict.objects.create(
                owner_id=instance.user_id, entity=entity,
                local_uuid=instance.sync_uuid, reason="cascade_unconfirmed",
                local_snapshot=state.snapshot,
            )
        return
    if isinstance(instance, Folder):
        for note in Note.objects.filter(user_id=instance.user_id, folder_id=instance.pk):
            payload = portable_snapshot(note)
            payload["folder_sync_uuid"] = None
            write_change(note.user, "note", note.sync_uuid, payload)
    write_change(instance.user, entity, instance.sync_uuid, {}, deleted=True)


def snapshot_rows(owner):
    rows = []
    folders = list(Folder.objects.filter(user=owner).select_related("parent"))
    folder_by_id = {folder.pk: folder for folder in folders}

    def folder_depth(folder):
        depth = 0
        parent = folder_by_id.get(folder.parent_id)
        visited = {folder.pk}
        while parent is not None:
            if parent.pk in visited:
                return 10000
            visited.add(parent.pk)
            depth += 1
            parent = folder_by_id.get(parent.parent_id)
        return depth

    folders.sort(key=lambda folder: (folder_depth(folder), folder.pk))
    for entity, queryset in (
        ("folder", folders),
        ("playlist", Playlist.objects.filter(user=owner).prefetch_related("items__video")),
        (
            "note",
            Note.objects.filter(user=owner)
            .select_related("folder", "folder__parent", "video")
            .prefetch_related(Prefetch(
                "video__viewing_sessions",
                queryset=ViewingSession.objects.filter(user=owner),
                to_attr="_sync_viewing_sessions",
            )),
        ),
    ):
        for record in queryset:
            snapshot = portable_snapshot(record)
            state, _ = RecordState.objects.get_or_create(
                owner=owner, entity=entity, record_uuid=record.sync_uuid,
                defaults={"snapshot": snapshot},
            )
            is_deleted = record.deleted_at is not None
            if state.deleted != is_deleted or state.snapshot != snapshot:
                if not state.needs_repair:
                    state.needs_repair = True
                    state.save(update_fields=("needs_repair", "updated_at"))
                    if not SyncConflict.objects.filter(
                        owner=owner, entity=entity, local_uuid=record.sync_uuid,
                        reason="untracked_change", status="open",
                    ).exists():
                        SyncConflict.objects.create(
                            owner=owner, entity=entity,
                            local_uuid=record.sync_uuid, reason="untracked_change",
                            local_snapshot=state.snapshot, incoming_snapshot=snapshot,
                        )
            rows.append({
                "entity": entity, "record_uuid": str(record.sync_uuid),
                "revision": state.revision, "peer_revision": state.peer_revision,
                "snapshot": snapshot, "deleted": is_deleted,
                "needs_repair": state.needs_repair,
                "origin_installation": str(state.origin_installation) if state.origin_installation else None,
            })
    included = {(row["entity"], row["record_uuid"]) for row in rows}
    for state in RecordState.objects.filter(owner=owner, deleted=True):
        if (state.entity, str(state.record_uuid)) in included:
            continue
        rows.append({
            "entity": state.entity, "record_uuid": str(state.record_uuid),
            "revision": state.revision, "peer_revision": state.peer_revision,
            "snapshot": state.snapshot, "deleted": True,
            "needs_repair": state.needs_repair,
            "origin_installation": str(state.origin_installation) if state.origin_installation else None,
        })
    for state in RecordState.objects.filter(owner=owner, needs_repair=True, deleted=False):
        if (state.entity, str(state.record_uuid)) in included:
            continue
        if not any(row["entity"] == state.entity and row["record_uuid"] == str(state.record_uuid)
                   for row in rows):
            rows.append({
                "entity": state.entity, "record_uuid": str(state.record_uuid),
                "revision": state.revision, "peer_revision": state.peer_revision,
                "snapshot": state.snapshot, "deleted": False,
                "needs_repair": True,
                "origin_installation": str(state.origin_installation) if state.origin_installation else None,
            })
    return rows


def _resolve_uuid(owner, entity, source_uuid, peer_installation, mapping_id):
    if not mapping_id:
        return source_uuid
    mapping = IdentityMapping.objects.filter(
        owner=owner, entity=entity, peer_installation=peer_installation,
        peer_uuid=source_uuid, mapping_id=mapping_id,
        status=IdentityMapping.Status.CONFIRMED,
    ).first()
    if mapping is None:
        raise ValueError("confirmed_identity_mapping_required")
    return mapping.local_uuid


def _record_model(entity):
    return {
        "note": Note,
        "folder": Folder,
        "playlist": Playlist,
    }[entity]


def _parse_time(value):
    if not value:
        return None
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return timezone.make_aware(parsed, datetime_timezone.utc) if timezone.is_naive(parsed) else parsed


def _apply_video_snapshot(owner, youtube_id, video_data, session_data):
    video_defaults = None
    video_times = {}
    if video_data is not None:
        if not isinstance(video_data, dict) or video_data.get("youtube_id") != youtube_id:
            raise ValueError("invalid_video_snapshot")
        text_limits = {
            "title": 500,
            "channel_name": 255,
            "channel_handle": 255,
            "channel_id": 255,
            "thumbnail_url": 200,
            "transcript_language": 35,
        }
        defaults = {}
        for field, limit in text_limits.items():
            value = video_data.get(field, "")
            if not isinstance(value, str) or len(value) > limit:
                raise ValueError("invalid_video_snapshot")
            defaults[field] = value
        duration = video_data.get("duration_seconds")
        if duration is not None and (
            not isinstance(duration, int) or isinstance(duration, bool) or duration < 0
        ):
            raise ValueError("invalid_video_snapshot")
        transcript_status = video_data.get(
            "transcript_status", Video.TranscriptStatus.NOT_STARTED
        )
        if transcript_status not in Video.TranscriptStatus.values:
            raise ValueError("invalid_video_snapshot")
        try:
            json.dumps(video_data.get("transcript"))
        except (TypeError, ValueError):
            raise ValueError("invalid_video_snapshot") from None
        defaults.update({
            "duration_seconds": duration,
            "transcript_status": transcript_status,
            "transcript": video_data.get("transcript"),
        })
        for field in ("created_at", "updated_at", "transcript_fetched_at"):
            parsed = _parse_time(video_data.get(field))
            if parsed:
                video_times[field] = parsed
        video_defaults = defaults
    if session_data is not None:
        if not isinstance(session_data, dict):
            raise ValueError("invalid_viewing_session")
        position = session_data.get("last_position_seconds")
        watched_at = _parse_time(session_data.get("last_watched_at"))
        if (
            not isinstance(position, int) or isinstance(position, bool)
            or position < 0 or watched_at is None
        ):
            raise ValueError("invalid_viewing_session")
    if video_defaults is not None:
        video = Video.objects.filter(youtube_id=youtube_id).first()
        if video is None:
            video = Video.objects.create(youtube_id=youtube_id, **video_defaults)
            if video_times:
                Video.objects.filter(pk=video.pk).update(**video_times)
        else:
            destination_is_empty = (
                not any(getattr(video, field) for field in (
                    "title", "channel_name", "channel_handle", "channel_id",
                    "thumbnail_url", "transcript_language",
                ))
                and video.duration_seconds is None
                and video.transcript_status == Video.TranscriptStatus.NOT_STARTED
                and video.transcript is None
            )
            incoming_updated_at = video_times.get("updated_at")
            if destination_is_empty or (
                incoming_updated_at is not None
                and incoming_updated_at > video.updated_at
            ):
                Video.objects.filter(pk=video.pk).update(**video_defaults, **video_times)
                video.refresh_from_db()
    else:
        video, _ = Video.objects.get_or_create(youtube_id=youtube_id)
    if session_data is not None:
        session, created = ViewingSession.objects.get_or_create(
            user=owner, video=video,
            defaults={"last_position_seconds": position},
        )
        if created or watched_at >= session.last_watched_at:
            ViewingSession.objects.filter(pk=session.pk).update(
                last_position_seconds=position, last_watched_at=watched_at
            )
    return video


def _record_conflict(owner, operation_id, digest, entity, local_uuid,
                     peer_uuid, reason, local_snapshot, incoming_snapshot,
                     local_revision=None):
    conflict = SyncConflict.objects.filter(
        owner=owner, entity=entity, local_uuid=local_uuid,
        peer_uuid=peer_uuid, reason=reason, status="open",
    ).first()
    if conflict is None:
        conflict = SyncConflict.objects.create(
            owner=owner, entity=entity, local_uuid=local_uuid,
            peer_uuid=peer_uuid, reason=reason,
            local_snapshot=local_snapshot,
            incoming_snapshot=incoming_snapshot,
        )
    response = {
        "status": "conflict", "reason": reason,
        "conflict_id": conflict.pk, "local_revision": local_revision,
    }
    SyncOperation.objects.create(
        owner=owner, operation_id=operation_id,
        request_hash=digest, response=response,
    )
    return response


@transaction.atomic
def apply_change(owner, change, peer_installation):
    entity = change.get("entity")
    if entity not in {"note", "folder", "playlist"}:
        return {"status": "invalid", "reason": "invalid_entity"}
    try:
        source_uuid = uuid.UUID(change["record_uuid"])
        operation_id = uuid.UUID(change["operation_id"])
    except (KeyError, ValueError, TypeError):
        return {"status": "invalid", "reason": "invalid_identity"}
    type(owner)._base_manager.select_for_update().get(pk=owner.pk)
    digest = hashlib.sha256(json.dumps(
        change, sort_keys=True, separators=(",", ":"), ensure_ascii=False
    ).encode("utf-8")).hexdigest()
    prior = SyncOperation.objects.filter(owner=owner, operation_id=operation_id).first()
    if prior:
        return prior.response if prior.request_hash == digest else {
            "status": "conflict", "reason": "idempotency_key_reused"
        }
    try:
        local_uuid = _resolve_uuid(
            owner, entity, source_uuid, peer_installation, change.get("mapping_id")
        )
    except ValueError as error:
        return {"status": "conflict", "reason": str(error)}
    model = _record_model(entity)
    other_owner = model.objects.filter(sync_uuid=local_uuid).exclude(user=owner).exists()
    if other_owner:
        return {"status": "conflict", "reason": "identity_owner_conflict"}
    state = RecordState.objects.select_for_update().filter(
        owner=owner, entity=entity, record_uuid=local_uuid
    ).first()
    existing = model.objects.filter(user=owner, sync_uuid=local_uuid).first()
    if state is None and existing:
        state = RecordState.objects.create(
            owner=owner, entity=entity, record_uuid=local_uuid,
            revision=1, snapshot=portable_snapshot(existing),
            deleted=existing.deleted_at is not None,
        )
    if state:
        if state.needs_repair:
            return _record_conflict(
                owner, operation_id, digest, entity, local_uuid, source_uuid,
                "destination_requires_repair", state.snapshot,
                change.get("snapshot", {}), state.revision,
            )
        current_snapshot = portable_snapshot(existing) if existing else None
        existing_deleted = bool(existing and existing.deleted_at is not None)
        if (
            (state.deleted != existing_deleted and existing is not None)
            or (not state.deleted and existing is None)
            or (existing is not None and current_snapshot != state.snapshot)
        ):
            state.needs_repair = True
            state.save(update_fields=("needs_repair", "updated_at"))
            return _record_conflict(
                owner, operation_id, digest, entity, local_uuid, source_uuid,
                "destination_untracked_change", state.snapshot,
                change.get("snapshot", {}), state.revision,
            )
    expected = change.get("base_revision")
    if (state.revision if state else None) != expected:
        return _record_conflict(
            owner, operation_id, digest, entity, local_uuid, source_uuid,
            "revision_conflict", state.snapshot if state else {},
            change.get("snapshot", {}), state.revision if state else None,
        )
    snapshot = change.get("snapshot") or {}
    if not isinstance(snapshot, dict):
        return {"status": "invalid", "reason": "invalid_snapshot"}
    incoming_deleted_at = _parse_time(snapshot.get("deleted_at")) or timezone.now()
    expired_tombstone = (
        bool(change.get("deleted"))
        and (
            incoming_deleted_at <= timezone.now() - TRASH_RETENTION
            or not snapshot.get("title") and not snapshot.get("name")
        )
    )
    try:
        incoming_batch_id = (
            uuid.UUID(snapshot["trash_batch_id"])
            if change.get("deleted") and snapshot.get("trash_batch_id")
            else uuid.uuid4() if change.get("deleted") else None
        )
    except (ValueError, TypeError):
        return {"status": "invalid", "reason": "invalid_trash_batch"}
    if change.get("deleted") and expired_tombstone:
        with suppress_tracking():
            if existing is not None:
                existing.delete()
        snapshot = {"deleted_at": incoming_deleted_at.isoformat()}
    else:
        try:
            with suppress_tracking():
                if entity == "folder":
                    parent_uuid = snapshot.get("parent_sync_uuid")
                    parent = Folder.objects.get(
                        user=owner, sync_uuid=uuid.UUID(parent_uuid)
                    ) if parent_uuid else None
                    ancestor = parent
                    while ancestor is not None:
                        if ancestor.sync_uuid == local_uuid:
                            raise ValueError("folder_cycle")
                        ancestor = ancestor.parent
                    duplicate_name = Folder.objects.filter(
                        user=owner, parent=parent, name=snapshot["name"],
                        deleted_at__isnull=True,
                    ).exclude(sync_uuid=local_uuid).exists()
                    if duplicate_name:
                        raise ValueError("folder_name_conflict")
                    name = snapshot.get("name")
                    description = snapshot.get("description", "")
                    if (
                        not isinstance(name, str) or not name.strip() or len(name) > 255
                        or not isinstance(description, str)
                    ):
                        raise ValueError("invalid_folder_snapshot")
                    record, _ = Folder.objects.update_or_create(
                        user=owner, sync_uuid=local_uuid,
                        defaults={
                            "name": name,
                            "description": description,
                            "parent": parent,
                            "deleted_at": incoming_deleted_at if change.get("deleted") else None,
                            "trash_batch_id": incoming_batch_id,
                        },
                    )
                elif entity == "playlist":
                    title = snapshot.get("title")
                    channel_name = snapshot.get("channel_name", "")
                    kind = snapshot.get("kind")
                    playlist_id = snapshot.get("youtube_playlist_id")
                    thumbnail_url = snapshot.get("thumbnail_url", "")
                    playlist_url = snapshot.get("playlist_url", "")
                    videos = snapshot.get("videos")
                    if (
                        not isinstance(title, str) or not title.strip() or len(title) > 255
                        or not isinstance(channel_name, str) or len(channel_name) > 255
                        or kind not in Playlist.Kind.values
                        or not isinstance(thumbnail_url, str) or len(thumbnail_url) > 500
                        or not isinstance(playlist_url, str) or len(playlist_url) > 500
                        or not isinstance(videos, list) or len(videos) > 5000
                    ):
                        raise ValueError("invalid_playlist_snapshot")
                    if kind == Playlist.Kind.YOUTUBE:
                        if not isinstance(playlist_id, str) or not re.fullmatch(
                            r"[A-Za-z0-9_-]{1,128}", playlist_id
                        ):
                            raise ValueError("invalid_playlist_snapshot")
                    elif playlist_id is not None:
                        raise ValueError("invalid_playlist_snapshot")
                    record, _ = Playlist.objects.update_or_create(
                        user=owner,
                        sync_uuid=local_uuid,
                        defaults={
                            "kind": kind,
                            "title": title,
                            "channel_name": channel_name,
                            "youtube_playlist_id": playlist_id,
                            "thumbnail_url": thumbnail_url,
                            "playlist_url": playlist_url,
                            "deleted_at": incoming_deleted_at if change.get("deleted") else None,
                            "trash_batch_id": incoming_batch_id,
                        },
                    )
                    video_ids = set()
                    for item in videos:
                        if not isinstance(item, dict):
                            raise ValueError("invalid_playlist_video")
                        youtube_id = item.get("youtube_id")
                        position = item.get("position")
                        if (
                            not isinstance(youtube_id, str)
                            or not re.fullmatch(r"[A-Za-z0-9_-]{11}", youtube_id)
                            or not isinstance(position, int)
                            or isinstance(position, bool)
                            or position < 0
                            or youtube_id in video_ids
                        ):
                            raise ValueError("invalid_playlist_video")
                        video_ids.add(youtube_id)
                        video_data = {}
                        for field, limit in (
                            ("title", 500),
                            ("channel_name", 255),
                            ("thumbnail_url", 200),
                        ):
                            value = item.get(field, "")
                            if not isinstance(value, str) or len(value) > limit:
                                raise ValueError("invalid_playlist_video")
                            video_data[field] = value
                        video, _ = Video.objects.get_or_create(
                            youtube_id=youtube_id,
                            defaults=video_data,
                        )
                        changed = [
                            field for field, value in video_data.items()
                            if value and not getattr(video, field)
                        ]
                        if changed:
                            for field in changed:
                                setattr(video, field, video_data[field])
                            video.save(update_fields=(*changed, "updated_at"))
                        PlaylistVideo.objects.update_or_create(
                            playlist=record,
                            video=video,
                            defaults={"position": position},
                        )
                    record.items.exclude(video__youtube_id__in=video_ids).delete()
                else:
                    doc = snapshot.get("document")
                    note_type = snapshot.get("note_type", Note.NoteType.STANDALONE)
                    title = snapshot.get("title")
                    content = snapshot.get("content", "")
                    if (
                        not isinstance(doc, dict)
                        or not isinstance(title, str)
                        or len(title) > 500
                        or not isinstance(content, str)
                    ):
                        raise ValueError("invalid_note_snapshot")
                    if note_type not in {Note.NoteType.VIDEO, Note.NoteType.STANDALONE}:
                        raise ValueError("invalid_note_type")
                    folder_uuid = snapshot.get("folder_sync_uuid")
                    folder = Folder.objects.get(
                        user=owner, sync_uuid=uuid.UUID(folder_uuid)
                    ) if folder_uuid else None
                    video_id = snapshot.get("video_youtube_id")
                    video = None
                    if video_id:
                        if not isinstance(video_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{11}", video_id):
                            raise ValueError("invalid_youtube_id")
                        video = _apply_video_snapshot(
                            owner, video_id, snapshot.get("video_snapshot"),
                            snapshot.get("viewing_session"),
                        )
                    timestamp = snapshot.get("timestamp_seconds")
                    if timestamp is not None and (
                        not isinstance(timestamp, int) or isinstance(timestamp, bool)
                        or timestamp < 0
                    ):
                        raise ValueError("invalid_timestamp")
                    if note_type == Note.NoteType.VIDEO and video is None:
                        raise ValueError("video_note_requires_video")
                    if note_type == Note.NoteType.STANDALONE and (
                        video is not None or timestamp is not None
                    ):
                        raise ValueError("standalone_note_has_video_or_timestamp")
                    record, _ = Note.objects.update_or_create(
                        user=owner, sync_uuid=local_uuid,
                        defaults={
                            "title": title, "document": doc,
                            "content": content,
                            "note_type": note_type, "folder": folder,
                            "video": video,
                            "timestamp_seconds": snapshot.get("timestamp_seconds"),
                            "deleted_at": incoming_deleted_at if change.get("deleted") else None,
                            "trash_batch_id": incoming_batch_id,
                        },
                    )
                    IndexingJob.objects.update_or_create(
                        owner=owner, note_uuid=local_uuid,
                        defaults={"status": "pending", "last_error": ""},
                    )
            for field in ("created_at", "updated_at"):
                parsed = _parse_time(snapshot.get(field))
                if parsed:
                    type(record).objects.filter(pk=record.pk).update(**{field: parsed})
            snapshot = portable_snapshot(record)
            if change.get("deleted"):
                record.deleted_at = incoming_deleted_at
                record.trash_batch_id = incoming_batch_id
                with suppress_tracking():
                    record.save(update_fields=(
                        "deleted_at", "trash_batch_id", "updated_at"
                    ))
                snapshot = portable_snapshot(record)
        except (KeyError, ValueError, TypeError, Folder.DoesNotExist):
            return {"status": "invalid", "reason": "invalid_or_missing_dependency"}

    next_revision = state.revision + 1 if state else 1
    state, _ = RecordState.objects.update_or_create(
        owner=owner, entity=entity, record_uuid=local_uuid,
        defaults={
            "revision": next_revision, "snapshot": snapshot,
            "deleted": bool(change.get("deleted")),
            "origin_installation": peer_installation,
            "origin_operation": operation_id, "needs_repair": False,
        },
    )
    ChangeEvent.objects.create(
        owner=owner, entity=entity, record_uuid=local_uuid,
        revision=state.revision, snapshot=snapshot, deleted=state.deleted,
        operation_id=operation_id, origin_installation=peer_installation,
        origin_operation=operation_id,
    )
    response = {
        "status": "accepted", "local_uuid": str(local_uuid),
        "revision": state.revision,
    }
    SyncOperation.objects.create(
        owner=owner, operation_id=operation_id,
        request_hash=digest, response=response,
    )
    return response
