import hashlib
import json
import re
from collections import Counter
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.core.serializers.json import DjangoJSONEncoder
from django.db import connection, transaction
from django.db.migrations.executor import MigrationExecutor
from django.utils import timezone
from django.utils.dateparse import parse_datetime

from folders.models import Folder
from notes.models import Note
from users.models import User
from videos.models import Video


EXPECTED_EXPORT_SHA256 = (
    "98e7dec773f6eb370c9c0b05cfe48a9c5047105224d52582b49102d9f6788c21"
)
EXPECTED_NOTE_COUNT = 23
EXPECTED_FOLDER_COUNT = 6
DESTINATION_EMAIL = "bostonchamps96@gmail.com"
SOURCE_USERNAME = "devuser"
SOURCE_USER_ID = 1
VERIFIED_VIDEO_NOTE_IDS = {50, 51, 53, 55, 59, 63, 64}
YOUTUBE_ID_PATTERN = r"^[A-Za-z0-9_-]{11}$"


class PreciseDateTimeJSONEncoder(DjangoJSONEncoder):
    def default(self, value):
        if isinstance(value, datetime):
            return value.isoformat()
        return super().default(value)


@dataclass
class ImportPlan:
    video_actions: list
    folder_actions: list
    note_actions: list
    destination_folders: list
    destination_notes: list
    destination_videos: list
    unresolved_folders: list
    export: dict


def _sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _parse_timestamp(value, label):
    if not isinstance(value, str):
        raise CommandError(f"{label} must be an ISO-8601 string.")
    parsed = parse_datetime(value)
    if parsed is None or timezone.is_naive(parsed):
        raise CommandError(f"{label} must include a valid timezone.")
    return parsed


def _load_export(path):
    if not path.is_file():
        raise CommandError(f"Legacy export does not exist: {path}")
    actual_hash = _sha256(path)
    if actual_hash != EXPECTED_EXPORT_SHA256:
        raise CommandError(
            "Legacy export integrity check failed; no import was performed."
        )
    try:
        with path.open("r", encoding="utf-8") as stream:
            data = json.load(stream)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise CommandError("Legacy export is not valid UTF-8 JSON.") from error

    if not isinstance(data, dict):
        raise CommandError("Legacy export root must be a JSON object.")
    account = data.get("account")
    notes = data.get("notes")
    folders = data.get("folders")
    if (
        not isinstance(account, dict)
        or account.get("username") != SOURCE_USERNAME
        or account.get("id") != SOURCE_USER_ID
        or not isinstance(notes, list)
        or not isinstance(folders, list)
        or len(notes) != EXPECTED_NOTE_COUNT
        or len(folders) != EXPECTED_FOLDER_COUNT
    ):
        raise CommandError(
            "Legacy export account or record counts do not match the "
            "verified source; no import was performed."
        )

    folder_ids = set()
    for row in folders:
        if not isinstance(row, dict) or not {
            "id", "user_id", "name", "parent_id", "description",
            "created_at", "updated_at",
        } <= row.keys():
            raise CommandError("Legacy export contains a malformed folder.")
        if (
            not isinstance(row["id"], int)
            or isinstance(row["id"], bool)
            or row["id"] in folder_ids
            or row["user_id"] != SOURCE_USER_ID
            or not isinstance(row["name"], str)
            or not isinstance(row["description"], str)
        ):
            raise CommandError("Legacy export contains an invalid folder row.")
        folder_ids.add(row["id"])
        _parse_timestamp(row["created_at"], "Folder created_at")
        _parse_timestamp(row["updated_at"], "Folder updated_at")

    note_ids = set()
    for row in notes:
        if not isinstance(row, dict) or not {
            "id", "user_id", "title", "document", "content", "note_type",
            "folder_id", "video_id", "timestamp_seconds", "created_at",
            "updated_at", "folder", "video",
        } <= row.keys():
            raise CommandError("Legacy export contains a malformed note.")
        if (
            not isinstance(row["id"], int)
            or isinstance(row["id"], bool)
            or row["id"] in note_ids
            or row["user_id"] != SOURCE_USER_ID
            or not isinstance(row["title"], str)
            or not isinstance(row["document"], dict)
            or not isinstance(row["content"], str)
            or not isinstance(row["note_type"], str)
            or (
                row["timestamp_seconds"] is not None
                and (
                    not isinstance(row["timestamp_seconds"], int)
                    or isinstance(row["timestamp_seconds"], bool)
                )
            )
            or (row["folder"] is not None and not isinstance(row["folder"], dict))
            or (row["video"] is not None and not isinstance(row["video"], dict))
        ):
            raise CommandError("Legacy export contains an invalid note row.")
        note_ids.add(row["id"])
        _parse_timestamp(row["created_at"], "Note created_at")
        _parse_timestamp(row["updated_at"], "Note updated_at")
    return data


def _json_key(value):
    try:
        return json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        )
    except (TypeError, ValueError) as error:
        raise CommandError("Export contains a value that is not valid JSON.") from error


def _source_folder_path(folder_id, folder_rows):
    path = []
    seen = set()
    current_id = folder_id
    while current_id is not None:
        if current_id in seen or current_id not in folder_rows:
            return None
        seen.add(current_id)
        folder = folder_rows[current_id]
        path.append(folder["name"])
        current_id = folder["parent_id"]
    return tuple(reversed(path))


def _source_note_signature(row, folder_path, youtube_id):
    return (
        row["title"],
        _json_key(row["document"]),
        row["content"],
        row["note_type"],
        row["timestamp_seconds"],
        _parse_timestamp(row["created_at"], "Note created_at"),
        _parse_timestamp(row["updated_at"], "Note updated_at"),
        folder_path,
        youtube_id,
    )


def _destination_note_signature(note):
    return (
        note.title,
        _json_key(note.document),
        note.content,
        note.note_type,
        note.timestamp_seconds,
        note.created_at,
        note.updated_at,
        note.folder_id,
        note.video.youtube_id if note.video_id else None,
    )


def _source_video_id(row):
    video_id = row["video_id"]
    video = row["video"]
    if video_id is None:
        return None, None
    if (
        not isinstance(video, dict)
        or not isinstance(video.get("youtube_id"), str)
        or not video["youtube_id"]
        or video.get("id") != video_id
    ):
        return None, "legacy video relationship is missing or inconsistent"
    return video["youtube_id"], None


def _verified_video_metadata(export):
    source_rows = {
        row["id"]: row
        for row in export["notes"]
        if row["id"] in VERIFIED_VIDEO_NOTE_IDS
    }
    if set(source_rows) != VERIFIED_VIDEO_NOTE_IDS:
        return {}, {
            note_id: "approved legacy note is missing from the verified export"
            for note_id in VERIFIED_VIDEO_NOTE_IDS - set(source_rows)
        }

    records = {}
    errors = {}
    for note_id, row in source_rows.items():
        video = row.get("video")
        youtube_id, relationship_error = _source_video_id(row)
        if (
            row.get("note_type") != Note.NoteType.VIDEO
            or relationship_error
            or youtube_id is None
            or not re.fullmatch(YOUTUBE_ID_PATTERN, youtube_id)
        ):
            errors[note_id] = "legacy video ID or note relationship is invalid"
            continue
        if (
            not isinstance(video.get("title"), str)
            or not video["title"].strip()
            or len(video["title"]) > 500
            or not isinstance(video.get("channel_name"), str)
            or not video["channel_name"].strip()
            or len(video["channel_name"]) > 255
            or not isinstance(video.get("channel_handle"), str)
            or len(video["channel_handle"]) > 255
            or not isinstance(video.get("channel_id"), str)
            or len(video["channel_id"]) > 255
            or not isinstance(video.get("thumbnail_url"), str)
            or video["thumbnail_url"]
            != f"https://i.ytimg.com/vi/{youtube_id}/hqdefault.jpg"
            or (
                video.get("duration_seconds") is not None
                and (
                    not isinstance(video["duration_seconds"], int)
                    or isinstance(video["duration_seconds"], bool)
                    or video["duration_seconds"] < 0
                )
            )
        ):
            errors[note_id] = "exported video metadata is incomplete or inconsistent"
            continue
        metadata = {
            "youtube_id": youtube_id,
            "title": video["title"],
            "channel_name": video["channel_name"],
            "channel_handle": video["channel_handle"],
            "channel_id": video["channel_id"],
            "thumbnail_url": video["thumbnail_url"],
            "duration_seconds": video["duration_seconds"],
        }
        previous = records.get(youtube_id)
        if previous is not None and previous != metadata:
            errors[note_id] = (
                "exported metadata conflicts with another note for this video"
            )
            continue
        records[youtube_id] = metadata

    errors_by_video = {
        source_rows[note_id]["video"]["youtube_id"]
        for note_id in errors
        if isinstance(source_rows[note_id].get("video"), dict)
        and isinstance(
            source_rows[note_id]["video"].get("youtube_id"),
            str,
        )
    }
    for youtube_id in errors_by_video:
        records.pop(youtube_id, None)
    return records, errors


def _plan_folders(export, destination_folders):
    folder_rows = {row["id"]: row for row in export["folders"]}
    actions = {}
    mapped_ids = {}
    unresolved = []
    used_source_paths = {}
    pending = set(folder_rows)

    while pending:
        progressed = False
        for legacy_id in sorted(pending):
            row = folder_rows[legacy_id]
            parent_id = row["parent_id"]
            if parent_id is not None and parent_id not in folder_rows:
                actions[legacy_id] = {
                    "legacy_id": legacy_id,
                    "row": row,
                    "action": "unresolved",
                    "reason": "parent folder reference is missing",
                }
            elif parent_id is not None and parent_id not in actions:
                continue
            elif parent_id is not None and actions[parent_id]["action"] == "unresolved":
                actions[legacy_id] = {
                    "legacy_id": legacy_id,
                    "row": row,
                    "action": "unresolved",
                    "reason": "parent folder could not be mapped",
                }
            elif not row["name"].strip() or len(row["name"]) > 255:
                actions[legacy_id] = {
                    "legacy_id": legacy_id,
                    "row": row,
                    "action": "unresolved",
                    "reason": "folder name is blank or exceeds 255 characters",
                }
            else:
                parent_created = (
                    parent_id is not None
                    and actions[parent_id]["action"] == "create"
                )
                destination_parent_id = (
                    mapped_ids.get(parent_id) if parent_id is not None else None
                )
                source_path = _source_folder_path(legacy_id, folder_rows)
                if source_path in used_source_paths:
                    actions[legacy_id] = {
                        "legacy_id": legacy_id,
                        "row": row,
                        "action": "unresolved",
                        "reason": "duplicate legacy folder path is ambiguous",
                    }
                else:
                    used_source_paths[source_path] = legacy_id
                    matches = [
                        folder
                        for folder in destination_folders
                        if folder.parent_id == destination_parent_id
                        and folder.name == row["name"]
                    ] if not parent_created else []
                    if len(matches) > 1:
                        actions[legacy_id] = {
                            "legacy_id": legacy_id,
                            "row": row,
                            "action": "unresolved",
                            "reason": "multiple destination folders match this path",
                        }
                    elif matches:
                        matched = matches[0]
                        actions[legacy_id] = {
                            "legacy_id": legacy_id,
                            "row": row,
                            "action": "reuse",
                            "destination_id": matched.pk,
                            "description_conflict": (
                                matched.description != row["description"]
                            ),
                        }
                        mapped_ids[legacy_id] = matched.pk
                    else:
                        actions[legacy_id] = {
                            "legacy_id": legacy_id,
                            "row": row,
                            "action": "create",
                            "description_conflict": False,
                        }
            pending.remove(legacy_id)
            progressed = True
        if not progressed:
            for legacy_id in sorted(pending):
                actions[legacy_id] = {
                    "legacy_id": legacy_id,
                    "row": folder_rows[legacy_id],
                    "action": "unresolved",
                    "reason": "folder hierarchy contains a cycle",
                }
            break
    ordered_actions = list(actions.values())
    unresolved = [action for action in ordered_actions if action["action"] == "unresolved"]
    return folder_rows, ordered_actions, mapped_ids, unresolved


def build_import_plan(
    export,
    user,
    destination_folders,
    destination_notes,
    destination_videos,
    create_verified_videos=False,
):
    folder_rows, folder_actions, folder_map, unresolved_folders = _plan_folders(
        export,
        destination_folders,
    )
    videos_by_youtube_id = {}
    for video in destination_videos:
        videos_by_youtube_id.setdefault(video.youtube_id, []).append(video)

    verified_video_records, video_metadata_errors = _verified_video_metadata(export)
    video_actions = []
    planned_videos_by_youtube_id = {}
    if create_verified_videos:
        for youtube_id, metadata in sorted(verified_video_records.items()):
            matches = videos_by_youtube_id.get(youtube_id, [])
            if len(matches) == 1:
                video_actions.append({
                    "youtube_id": youtube_id,
                    "action": "reuse",
                    "video": matches[0],
                    "metadata": metadata,
                    "metadata_conflict": any(
                        getattr(matches[0], field) != value
                        for field, value in metadata.items()
                        if field != "youtube_id"
                        and getattr(matches[0], field) not in ("", None)
                    ),
                })
            elif len(matches) > 1:
                video_actions.append({
                    "youtube_id": youtube_id,
                    "action": "unresolved",
                    "video": None,
                    "metadata": metadata,
                    "reason": "multiple destination video records match this ID",
                })
            else:
                candidate = {"youtube_id": youtube_id, **metadata}
                planned_videos_by_youtube_id[youtube_id] = candidate
                video_actions.append({
                    "youtube_id": youtube_id,
                    "action": "create",
                    "video": candidate,
                    "metadata": metadata,
                })

    source_signatures = Counter()
    normalized_notes = []
    for row in export["notes"]:
        youtube_id, video_error = _source_video_id(row)
        folder_path = (
            ()
            if row["folder_id"] is None
            else _source_folder_path(row["folder_id"], folder_rows)
        )
        signature = _source_note_signature(row, folder_path, youtube_id)
        source_signatures[signature] += 1
        normalized_notes.append((row, youtube_id, video_error, folder_path, signature))

    existing_signatures = {}
    same_title = {}
    for note in destination_notes:
        existing_signatures.setdefault(_destination_note_signature(note), []).append(note)
        same_title.setdefault((note.title, note.note_type), []).append(note)

    note_actions = []
    reserved_signatures = set()
    for row, youtube_id, video_error, folder_path, signature in normalized_notes:
        reasons = []
        folder_id = row["folder_id"]
        folder_action = next(
            (
                action
                for action in folder_actions
                if action["legacy_id"] == folder_id
            ),
            None,
        ) if folder_id is not None else None
        folder_valid = folder_id is None or (
            folder_action is not None
            and folder_action["action"] != "unresolved"
        )
        planned_new_folder = bool(
            folder_action is not None and folder_action["action"] == "create"
        )
        destination_folder_id = (
            folder_map.get(folder_id) if folder_id is not None else None
        )
        if not folder_valid:
            reasons.append("folder relationship is unresolved; note will be unfiled")
            destination_folder_id = None
        elif folder_id is not None and (
            row["folder"] is None or row["folder"].get("id") != folder_id
        ):
            reasons.append("embedded folder relationship is inconsistent")
            folder_valid = False
            destination_folder_id = None
        if video_error:
            reasons.append(video_error)
        matching_videos = videos_by_youtube_id.get(youtube_id, []) if youtube_id else []
        if len(matching_videos) > 1:
            video_error = "multiple destination videos share the legacy YouTube ID"
            reasons.append(video_error)
        matched_video = matching_videos[0] if len(matching_videos) == 1 else None
        if (
            matched_video is None
            and create_verified_videos
            and row["id"] in VERIFIED_VIDEO_NOTE_IDS
        ):
            matched_video = planned_videos_by_youtube_id.get(youtube_id)
            if matched_video is None:
                reasons.append(
                    video_metadata_errors.get(
                        row["id"],
                        "verified video metadata is unavailable",
                    )
                )

        if row["note_type"] not in Note.NoteType.values:
            reasons.append("note type is not supported by the destination model")
            decision = "unresolved"
        elif row["note_type"] == Note.NoteType.VIDEO and matched_video is None:
            reasons.append("video note has no verified destination video match")
            decision = "unresolved"
        elif row["note_type"] == Note.NoteType.STANDALONE and youtube_id is not None:
            reasons.append("standalone note has a legacy video relationship")
            decision = "unresolved"
        elif (
            row["note_type"] == Note.NoteType.STANDALONE
            and row["timestamp_seconds"] is not None
        ):
            reasons.append("standalone note has a video timestamp")
            decision = "unresolved"
        elif len(row["title"]) > 500:
            reasons.append("title exceeds the destination model limit")
            decision = "unresolved"
        elif (
            row["timestamp_seconds"] is not None
            and row["timestamp_seconds"] < 0
        ):
            reasons.append("timestamp is outside the destination field range")
            decision = "unresolved"
        elif source_signatures[signature] > 1:
            reasons.append("indistinguishable duplicate legacy note records")
            decision = "unresolved"
        else:
            if any(
                candidate["action"] == "unresolved"
                and candidate["row"]["id"] == folder_id
                for candidate in folder_actions
            ) and folder_id is not None:
                reasons.append("folder relationship will not be preserved")
            comparable_folder = (
                destination_folder_id
                if folder_id is None or not planned_new_folder
                else object()
            )
            destination_signature = (
                row["title"],
                _json_key(row["document"]),
                row["content"],
                row["note_type"],
                row["timestamp_seconds"],
                _parse_timestamp(row["created_at"], "Note created_at"),
                _parse_timestamp(row["updated_at"], "Note updated_at"),
                comparable_folder,
                (
                    matched_video["youtube_id"]
                    if isinstance(matched_video, dict)
                    else matched_video.youtube_id
                    if matched_video
                    else None
                ),
            )
            duplicates = existing_signatures.get(destination_signature, [])
            if duplicates:
                decision = "duplicate"
                reasons.append("exact destination note match")
            elif signature in reserved_signatures:
                decision = "unresolved"
                reasons.append("duplicate legacy note cannot be distinguished safely")
            else:
                decision = "import"
                reserved_signatures.add(signature)
                if same_title.get((row["title"], row["note_type"])):
                    reasons.append("same title exists but note fields differ")

        note_actions.append({
            "legacy_id": row["id"],
            "row": row,
            "decision": decision,
            "reasons": reasons,
            "folder_valid": folder_valid,
            "destination_folder_id": destination_folder_id,
            "planned_new_folder": planned_new_folder,
            "video": matched_video,
            "youtube_id": youtube_id,
        })

    return ImportPlan(
        video_actions=video_actions,
        folder_actions=folder_actions,
        note_actions=note_actions,
        destination_folders=list(destination_folders),
        destination_notes=list(destination_notes),
        destination_videos=list(destination_videos),
        unresolved_folders=unresolved_folders,
        export=export,
    )


def _folder_state(folder):
    return (
        folder.pk,
        folder.user_id,
        folder.name,
        folder.description,
        folder.parent_id,
        folder.created_at,
        folder.updated_at,
    )


def _note_state(note):
    return (
        note.pk,
        note.user_id,
        note.title,
        _json_key(note.document),
        note.content,
        note.note_type,
        note.folder_id,
        note.video.youtube_id if note.video_id else None,
        note.timestamp_seconds,
        note.created_at,
        note.updated_at,
    )


def _backup_snapshot(
    user,
    folders,
    notes,
    path,
    backup_type="application-level destination account notes and folders",
):
    video_by_id = {}
    for note in notes:
        if note.video_id:
            video = note.video
            video_by_id[video.pk] = {
                "id": video.pk,
                "youtube_id": video.youtube_id,
                "title": video.title,
                "channel_name": video.channel_name,
                "channel_handle": video.channel_handle,
                "channel_id": video.channel_id,
                "thumbnail_url": video.thumbnail_url,
                "duration_seconds": video.duration_seconds,
            }
    backup = {
        "format_version": 1,
        "backup_type": backup_type,
        "created_at": timezone.now(),
        "account": {"id": user.pk, "email": user.email},
        "folders": [
            {
                "id": folder.pk,
                "user_id": folder.user_id,
                "name": folder.name,
                "parent_id": folder.parent_id,
                "description": folder.description,
                "created_at": folder.created_at,
                "updated_at": folder.updated_at,
            }
            for folder in folders
        ],
        "notes": [
            {
                "id": note.pk,
                "user_id": note.user_id,
                "title": note.title,
                "document": note.document,
                "content": note.content,
                "note_type": note.note_type,
                "folder_id": note.folder_id,
                "video_id": note.video_id,
                "timestamp_seconds": note.timestamp_seconds,
                "created_at": note.created_at,
                "updated_at": note.updated_at,
                "video": video_by_id.get(note.video_id),
            }
            for note in notes
        ],
        "videos": list(video_by_id.values()),
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        raise CommandError(f"Refusing to overwrite existing backup: {path}")
    try:
        with path.open("x", encoding="utf-8", newline="\n") as stream:
            json.dump(
                backup,
                stream,
                cls=PreciseDateTimeJSONEncoder,
                ensure_ascii=False,
                indent=2,
            )
            stream.write("\n")
        with path.open("r", encoding="utf-8") as stream:
            verified = json.load(stream)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise CommandError("Destination backup could not be written and verified.") from error
    if (
        len(verified.get("notes", [])) != len(notes)
        or len(verified.get("folders", [])) != len(folders)
        or verified.get("account", {}).get("id") != user.pk
        or json.dumps(
            verified,
            cls=PreciseDateTimeJSONEncoder,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        != json.dumps(
            backup,
            cls=PreciseDateTimeJSONEncoder,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
    ):
        raise CommandError("Destination backup verification failed.")
    return {
        "path": str(path.resolve()),
        "notes": len(notes),
        "folders": len(folders),
        "bytes": path.stat().st_size,
        "sha256": _sha256(path),
    }


@transaction.atomic
def apply_import_plan(plan, user):
    video_map = {}
    created_videos = []
    for action in plan.video_actions:
        if action["action"] != "create":
            continue
        video = Video.objects.create(**action["metadata"])
        video_map[action["youtube_id"]] = video
        action["video"] = video
        created_videos.append((action, video.pk))

    for action in plan.note_actions:
        if isinstance(action["video"], dict):
            action["video"] = video_map.get(action["youtube_id"])

    folder_map = {
        action["legacy_id"]: action["destination_id"]
        for action in plan.folder_actions
        if action["action"] == "reuse"
    }
    created_folders = []
    for action in plan.folder_actions:
        if action["action"] != "create":
            continue
        row = action["row"]
        parent_id = folder_map.get(row["parent_id"]) if row["parent_id"] is not None else None
        folder = Folder.objects.create(
            user=user,
            name=row["name"],
            description=row["description"],
            parent_id=parent_id,
        )
        Folder.objects.filter(pk=folder.pk).update(
            created_at=_parse_timestamp(row["created_at"], "Folder created_at"),
            updated_at=_parse_timestamp(row["updated_at"], "Folder updated_at"),
        )
        folder_map[action["legacy_id"]] = folder.pk
        created_folders.append((action, folder.pk))

    created_notes = []
    for action in plan.note_actions:
        if action["decision"] != "import":
            continue
        row = action["row"]
        folder_id = None
        if row["folder_id"] is not None and action["folder_valid"]:
            folder_id = folder_map.get(row["folder_id"])
        note = Note.objects.create(
            user=user,
            title=row["title"],
            document=row["document"],
            content=row["content"],
            note_type=row["note_type"],
            folder_id=folder_id,
            video=action["video"],
            timestamp_seconds=row["timestamp_seconds"],
        )
        Note.objects.filter(pk=note.pk).update(
            created_at=_parse_timestamp(row["created_at"], "Note created_at"),
            updated_at=_parse_timestamp(row["updated_at"], "Note updated_at"),
        )
        created_notes.append((action, note.pk))

    if len(created_folders) != sum(
        action["action"] == "create" for action in plan.folder_actions
    ):
        raise CommandError("Created folder count did not match the approved plan.")
    if len(created_videos) != sum(
        action["action"] == "create" for action in plan.video_actions
    ):
        raise CommandError("Created video count did not match the approved plan.")
    if len(created_notes) != sum(
        action["decision"] == "import" for action in plan.note_actions
    ):
        raise CommandError("Created note count did not match the approved plan.")
    _verify_imported_rows(user, created_folders, created_notes, folder_map)
    for action, video_pk in created_videos:
        video = Video.objects.get(pk=video_pk)
        if any(
            getattr(video, field) != value
            for field, value in action["metadata"].items()
        ):
            raise CommandError(
                f"Video verification failed for YouTube ID {action['youtube_id']}."
            )
    _verify_existing_rows_unchanged(plan, user)
    return {
        "videos": [pk for action, pk in created_videos],
        "folders": [pk for action, pk in created_folders],
        "notes": [pk for action, pk in created_notes],
    }


def _verify_imported_rows(user, created_folders, created_notes, folder_map):
    for action, folder_pk in created_folders:
        row = action["row"]
        folder = Folder.objects.get(pk=folder_pk)
        expected_parent_id = (
            folder_map.get(row["parent_id"]) if row["parent_id"] is not None else None
        )
        if (
            folder.user_id != user.pk
            or folder.name != row["name"]
            or folder.description != row["description"]
            or folder.parent_id != expected_parent_id
            or folder.created_at != _parse_timestamp(row["created_at"], "Folder created_at")
            or folder.updated_at != _parse_timestamp(row["updated_at"], "Folder updated_at")
        ):
            raise CommandError(f"Folder verification failed for legacy ID {action['legacy_id']}.")
    for action, note_pk in created_notes:
        row = action["row"]
        note = Note.objects.select_related("video").get(pk=note_pk)
        expected_folder_id = (
            folder_map.get(row["folder_id"])
            if row["folder_id"] is not None and action["folder_valid"]
            else None
        )
        if (
            note.user_id != user.pk
            or note.title != row["title"]
            or _json_key(note.document) != _json_key(row["document"])
            or note.content != row["content"]
            or note.note_type != row["note_type"]
            or note.folder_id != expected_folder_id
            or note.timestamp_seconds != row["timestamp_seconds"]
            or note.created_at != _parse_timestamp(row["created_at"], "Note created_at")
            or note.updated_at != _parse_timestamp(row["updated_at"], "Note updated_at")
            or (
                note.video.youtube_id if note.video_id else None
            ) != action["youtube_id"]
        ):
            raise CommandError(f"Note verification failed for legacy ID {action['legacy_id']}.")


def _verify_existing_rows_unchanged(plan, user):
    folder_ids = [folder.pk for folder in plan.destination_folders]
    note_ids = [note.pk for note in plan.destination_notes]
    folders_after = list(
        Folder.objects.filter(user=user, pk__in=folder_ids).order_by("pk")
    )
    notes_after = list(
        Note.objects.filter(user=user, pk__in=note_ids)
        .select_related("video")
        .order_by("pk")
    )
    expected_folders = sorted(
        (_folder_state(folder) for folder in plan.destination_folders),
        key=lambda state: state[0],
    )
    expected_notes = sorted(
        (_note_state(note) for note in plan.destination_notes),
        key=lambda state: state[0],
    )
    if (
        [_folder_state(folder) for folder in folders_after] != expected_folders
        or [_note_state(note) for note in notes_after] != expected_notes
    ):
        raise CommandError(
            "Pre-existing destination notes or folders changed; rolling back import."
        )


def _destination_user(email, expected_user_id=None):
    users = list(User.objects.filter(email=email))
    if len(users) != 1:
        raise CommandError(
            "Destination email must match exactly one Django user; no import was performed."
        )
    user = users[0]
    if expected_user_id is not None and user.pk != expected_user_id:
        raise CommandError("Destination user ID changed since verification.")
    if not user.is_active or user.supabase_uid is None:
        raise CommandError(
            "Destination user is not an active Supabase-mapped account."
        )
    try:
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT id::text, email FROM auth.users "
                "WHERE id = %s AND email = %s",
                [str(user.supabase_uid), email],
            )
            rows = cursor.fetchall()
    except Exception as error:
        raise CommandError(
            "Could not verify the destination user's Supabase auth mapping."
        ) from error
    if len(rows) != 1 or rows[0][0].lower() != str(user.supabase_uid).lower() or rows[0][1] != email:
        raise CommandError(
            "Django user does not map to exactly one matching Supabase auth user."
        )
    return user


def _check_destination_database():
    config = connection.settings_dict
    host = (config.get("HOST") or "").lower()
    if (
        config.get("ENGINE") != "django.db.backends.postgresql"
        or config.get("NAME") != "postgres"
        or not host.endswith(".supabase.com")
        or not settings.SUPABASE_URL.lower().endswith(".supabase.co")
    ):
        raise CommandError(
            "Configured database is not the expected Supabase PostgreSQL destination."
        )
    required_tables = {"users_user", "notes_note", "folders_folder", "videos_video"}
    tables = set(connection.introspection.table_names())
    if not required_tables <= tables:
        raise CommandError("Destination database schema is missing required tables.")
    required_columns = {
        "users_user": {"email", "supabase_uid", "is_active"},
        "notes_note": {
            "user_id", "title", "document", "content", "note_type",
            "folder_id", "video_id", "timestamp_seconds", "created_at",
            "updated_at",
        },
        "folders_folder": {
            "user_id", "name", "description", "parent_id", "created_at",
            "updated_at",
        },
        "videos_video": {"youtube_id"},
    }
    for table, expected_columns in required_columns.items():
        with connection.cursor() as cursor:
            actual_columns = {
                column.name
                for column in connection.introspection.get_table_description(
                    cursor,
                    table,
                )
            }
        if not expected_columns <= actual_columns:
            raise CommandError(
                f"Destination database schema is incomplete for {table}."
            )
    executor = MigrationExecutor(connection)
    if executor.migration_plan(executor.loader.graph.leaf_nodes()):
        raise CommandError(
            "Destination database has unapplied migrations; no import was performed."
        )


def _read_snapshot(user, export):
    destination_folders = list(
        Folder.objects.filter(user=user).order_by("pk")
    )
    destination_notes = list(
        Note.objects.filter(user=user).select_related("video").order_by("pk")
    )
    youtube_ids = {
        row["video"]["youtube_id"]
        for row in export["notes"]
        if row["video"] is not None and row["video"].get("youtube_id")
    }
    destination_videos = list(
        Video.objects.filter(youtube_id__in=youtube_ids).order_by("pk")
    )
    return destination_folders, destination_notes, destination_videos


def _backup_path(value):
    recovery_dir = (settings.BASE_DIR / "recovery").resolve()
    path = (Path(value) if Path(value).is_absolute() else settings.BASE_DIR / value).resolve()
    if path == recovery_dir or recovery_dir not in path.parents:
        raise CommandError("Destination backup must be stored under backend/recovery/.")
    return path


def _render_report(plan, user, email, backup=None, result=None):
    video_action_counts = Counter(action["action"] for action in plan.video_actions)
    folder_action_counts = Counter(action["action"] for action in plan.folder_actions)
    note_decisions = Counter(action["decision"] for action in plan.note_actions)
    imported_notes = [
        action for action in plan.note_actions if action["decision"] == "import"
    ]
    matching_videos = [
        action
        for action in plan.note_actions
        if action["video"] is not None
        and action["decision"] in {"import", "duplicate"}
    ]
    matchable_videos = [
        action for action in plan.note_actions if action["video"] is not None
    ]
    missing_video_notes = [
        action
        for action in plan.note_actions
        if (
            action["row"]["video_id"] is not None
            or action["row"]["note_type"] == Note.NoteType.VIDEO
        )
        and action["video"] is None
    ]
    invalid_folder_references = sum(
        action["row"]["folder_id"] is not None
        and (
            not action["folder_valid"]
            or action["planned_new_folder"] is False
            and action["destination_folder_id"] is None
        )
        for action in plan.note_actions
    )
    report = {
        "status": "EXECUTED" if result is not None else "DRY RUN",
        "destination": {
            "verified": True,
            "email": email,
            "user_id": user.pk,
            "supabase_uid_verified": True,
        },
        "legacy": {
            "notes": len(plan.note_actions),
            "folders": len(plan.folder_actions),
        },
        "existing_destination": {
            "notes": len(plan.destination_notes),
            "folders": len(plan.destination_folders),
        },
        "folders": {
            "to_create": folder_action_counts["create"],
            "reused_as_duplicates": folder_action_counts["reuse"],
            "unresolved": folder_action_counts["unresolved"],
            "created": len(result["folders"]) if result is not None else 0,
            "plan": [
                {
                    "legacy_id": action["legacy_id"],
                    "name": action["row"]["name"],
                    "parent_legacy_id": action["row"]["parent_id"],
                    "action": action["action"],
                    "destination_id": action.get("destination_id"),
                    "description_conflict": action.get("description_conflict", False),
                    "reason": action.get("reason"),
                }
                for action in plan.folder_actions
            ],
        },
        "notes": {
            "would_import": note_decisions["import"],
            "skipped_as_duplicates": note_decisions["duplicate"],
            "unresolved_or_skipped": note_decisions["unresolved"],
            "special_handling": sum(
                action["decision"] == "unresolved"
                or any(
                    reason != "exact destination note match"
                    for reason in action["reasons"]
                )
                for action in plan.note_actions
            ),
            "created": len(result["notes"]) if result is not None else 0,
            "plan": [
                {
                    "legacy_id": action["legacy_id"],
                    "decision": action["decision"],
                    "title": action["row"]["title"],
                    "folder_legacy_id": action["row"]["folder_id"],
                    "folder_name": (
                        action["row"]["folder"]["name"]
                        if action["row"]["folder"] is not None
                        else None
                    ),
                    "folder_destination_id": action["destination_folder_id"],
                    "youtube_id": action["youtube_id"],
                    "timestamp_seconds": action["row"]["timestamp_seconds"],
                    "reasons": action["reasons"],
                }
                for action in plan.note_actions
            ],
        },
        "videos": {
            "to_create": video_action_counts["create"],
            "reused": video_action_counts["reuse"],
            "unresolved": video_action_counts["unresolved"],
            "created": len(result["videos"]) if result is not None else 0,
            "plan": [
                {
                    "youtube_id": action["youtube_id"],
                    "action": action["action"],
                    "metadata_conflict": action.get("metadata_conflict", False),
                    "metadata": action["metadata"],
                    "reason": action.get("reason"),
                }
                for action in plan.video_actions
            ],
            "associations_preserved": len(matching_videos),
            "missing_or_unresolved": len(missing_video_notes),
            "matchable_associations": len(matchable_videos),
            "matched_youtube_ids": sorted(
                {action["youtube_id"] for action in matchable_videos}
            ),
            "unresolved_legacy_note_ids": [
                action["legacy_id"] for action in missing_video_notes
            ],
            "unresolved_youtube_ids": sorted(
                {
                    action["youtube_id"]
                    for action in missing_video_notes
                    if action["youtube_id"]
                }
            ),
        },
        "relationships": {
            "invalid_or_unmapped_folder_references": invalid_folder_references,
            "unresolved_video_references": len(missing_video_notes),
        },
        "preservation": {
            "preserved_fields": [
                "title", "document", "content", "note_type", "timestamps",
                "timestamp_seconds", "folder hierarchy", "matched video association",
            ],
            "not_preserved_for_skipped_records": [
                "note data and video associations for video notes without a verified destination video"
            ] if missing_video_notes else [],
            "existing_records_overwritten": 0,
        },
        "backup": backup,
    }
    return report


class Command(BaseCommand):
    help = "Safely import the verified devuser notes export into a Supabase account."

    def add_arguments(self, parser):
        parser.add_argument("--email", required=True)
        parser.add_argument("--expected-user-id", type=int)
        parser.add_argument(
            "--export",
            default=str(settings.BASE_DIR / "recovery" / "legacy_devuser_notes_and_folders.json"),
        )
        mode = parser.add_mutually_exclusive_group()
        mode.add_argument("--dry-run", action="store_true")
        mode.add_argument("--execute", action="store_true")
        parser.add_argument("--backup")
        parser.add_argument(
            "--create-verified-missing-videos",
            action="store_true",
            help="Create only the explicitly approved videos with complete, "
            "consistent metadata in the verified legacy export.",
        )

    def handle(self, *args, **options):
        if options["email"] != DESTINATION_EMAIL:
            raise CommandError(
                "This verified recovery command only accepts the approved destination email."
            )
        export_path = Path(options["export"]).resolve()
        export = _load_export(export_path)
        execute = options["execute"]

        _check_destination_database()
        backup_result = None
        result = None
        with transaction.atomic():
            if not execute:
                with connection.cursor() as cursor:
                    cursor.execute("SET TRANSACTION READ ONLY")
                    cursor.execute("SHOW transaction_read_only")
                    if cursor.fetchone()[0] != "on":
                        raise CommandError("Could not enforce a read-only dry run.")
            user = _destination_user(options["email"], options["expected_user_id"])
            if execute:
                user = User.objects.select_for_update().get(pk=user.pk)
                user = _destination_user(options["email"], user.pk)
            folders, notes, videos = _read_snapshot(user, export)
            plan = build_import_plan(
                export,
                user,
                folders,
                notes,
                videos,
                create_verified_videos=options["create_verified_missing_videos"],
            )
            if execute:
                backup_default = (
                    settings.BASE_DIR
                    / "recovery"
                    / f"destination_backup_{timezone.now():%Y%m%dT%H%M%S%fZ}.json"
                )
                backup_result = _backup_snapshot(
                    user,
                    folders,
                    notes,
                    _backup_path(options["backup"] or str(backup_default)),
                )
                result = apply_import_plan(plan, user)
            report = _render_report(
                plan,
                user,
                options["email"],
                backup=backup_result,
                result=result,
            )
            self.stdout.write(json.dumps(report, indent=2, ensure_ascii=False))
