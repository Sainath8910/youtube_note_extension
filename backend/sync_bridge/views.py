import uuid

from django.conf import settings
from django.db import IntegrityError
from django.utils import timezone
from rest_framework import status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import (
    IndexingJob,
    IdentityMapping,
    RecordState,
    SyncConflict,
    SyncHistory,
)
from .peer_client import PeerCommunicationError, peer_request
from .services import apply_change, installation_uuid, snapshot_rows


def _peer_snapshot(access_token):
    offset = 0
    snapshot_id = None
    records = []
    peer_id = None
    high_watermark = None
    while True:
        requested_snapshot_id = snapshot_id
        page = peer_request(
            "/api/sync/v1/peer/snapshot/",
            access_token,
            query={
                "offset": offset, "limit": 100,
                **({"snapshot_id": snapshot_id} if snapshot_id else {}),
            },
        )
        page_peer_id = page.get("installation_id")
        page_snapshot_id = page.get("snapshot_id")
        page_watermark = page.get("high_watermark")
        if (
            not isinstance(page_peer_id, str)
            or not isinstance(page_snapshot_id, str)
            or not isinstance(page_watermark, int)
            or page_watermark < 0
            or (peer_id is not None and peer_id != page_peer_id)
            or (requested_snapshot_id and requested_snapshot_id != page_snapshot_id)
            or (high_watermark is not None and high_watermark != page_watermark)
        ):
            raise PeerCommunicationError("The peer snapshot pages were inconsistent.")
        peer_id = page_peer_id
        snapshot_id = page_snapshot_id
        high_watermark = page_watermark
        page_records = page.get("records")
        if not isinstance(page_records, list) or not all(
            isinstance(record, dict) for record in page_records
        ):
            raise PeerCommunicationError("The peer snapshot was malformed.")
        records.extend(page_records)
        if len(records) > 2000:
            raise PeerCommunicationError(
                "The peer inventory exceeds the safe preview limit."
            )
        next_offset = page.get("next_offset")
        if next_offset is None:
            break
        try:
            next_offset_value = int(next_offset)
        except (TypeError, ValueError):
            raise PeerCommunicationError("The peer snapshot page was malformed.") from None
        if next_offset_value != offset + len(page_records) or not page_records:
            raise PeerCommunicationError("The peer snapshot pagination was invalid.")
        offset = next_offset_value
    if not peer_id:
        raise PeerCommunicationError("The peer did not identify its installation.")
    try:
        peer_uuid = uuid.UUID(peer_id)
        expected_peer_uuid = uuid.UUID(settings.NOTES_SYNC_PEER_INSTALLATION_ID)
    except (TypeError, ValueError):
        raise PeerCommunicationError("The configured peer installation identifier is invalid.") from None
    if peer_uuid != expected_peer_uuid:
        raise PeerCommunicationError("The configured peer installation did not match.")
    return peer_uuid, records


def _mapping_for(owner, direction, entity, source_uuid, peer_id):
    mappings = IdentityMapping.objects.filter(
        owner=owner, entity=entity, peer_installation=peer_id,
        status=IdentityMapping.Status.CONFIRMED,
    )
    if direction == "push":
        return mappings.filter(local_uuid=source_uuid).first()
    return mappings.filter(peer_uuid=source_uuid).first()


def _destination_uuid(direction, mapping, source_uuid):
    if mapping is None:
        return source_uuid
    return mapping.peer_uuid if direction == "push" else mapping.local_uuid


def _translate_relationships(
    owner, direction, entity, snapshot, peer_id, record_destination_uuid
):
    translated = dict(snapshot)
    translated["sync_uuid"] = str(record_destination_uuid)
    field = "parent_sync_uuid" if entity == "folder" else "folder_sync_uuid"
    referenced_uuid = translated.get(field)
    if referenced_uuid:
        mapping = _mapping_for(
            owner, direction, "folder", uuid.UUID(referenced_uuid), peer_id
        )
        translated[field] = str(_destination_uuid(
            direction, mapping, uuid.UUID(referenced_uuid)
        ))
    return translated


def _result_item(item, result):
    public_item = {
        key: value for key, value in item.items()
        if key not in {"payload", "source_snapshot"}
    }
    return {**public_item, **result}


def _send_push_batch(request, items):
    try:
        response = peer_request(
            "/api/sync/v1/peer/apply/",
            request.headers.get("Authorization", ""),
            method="POST",
            payload={"changes": [item["payload"] for item in items]},
        )
    except PeerCommunicationError as error:
        return [
            _result_item(item, {"status": "failed", "reason": str(error)})
            for item in items
        ]
    remote_results = response.get("results")
    if (
        not isinstance(remote_results, list)
        or len(remote_results) != len(items)
        or not all(isinstance(result, dict) for result in remote_results)
    ):
        return [
            _result_item(item, {
                "status": "failed",
                "reason": "The peer returned incomplete operation results.",
            })
            for item in items
        ]

    results = []
    for item, result in zip(items, remote_results):
        public_result = _result_item(item, result)
        results.append(public_result)
        if result.get("status") == "conflict":
            conflict_values = {
                "owner": request.user,
                "entity": item["entity"],
                "local_uuid": item["record_uuid"],
                "peer_uuid": item["destination_uuid"],
                "reason": result.get("reason", "peer_conflict"),
                "status": "open",
            }
            if not SyncConflict.objects.filter(**conflict_values).exists():
                state = RecordState.objects.filter(
                    owner=request.user, entity=item["entity"],
                    record_uuid=item["record_uuid"],
                ).first()
                SyncConflict.objects.create(
                    **conflict_values,
                    local_snapshot=state.snapshot if state else {},
                    incoming_snapshot=item["payload"]["snapshot"],
                    resolution={"direction": "push"},
                )
        if result.get("status") == "accepted":
            state = RecordState.objects.filter(
                owner=request.user, entity=item["entity"],
                record_uuid=item["record_uuid"],
            ).first()
            if state:
                state.peer_revision = max(
                    state.peer_revision or 0, result.get("revision") or 0
                )
                state.save(update_fields=["peer_revision", "updated_at"])
            try:
                peer_request(
                    "/api/sync/v1/peer/acknowledge/",
                    request.headers.get("Authorization", ""),
                    method="POST",
                    payload={
                        "entity": item["entity"],
                        "record_uuid": result.get("local_uuid", item["record_uuid"]),
                        "revision": result.get("revision"),
                    },
                )
            except PeerCommunicationError as error:
                public_result["acknowledgment"] = "pending"
                public_result["acknowledgment_error"] = str(error)
    return results


def _plan_item(owner, direction, source, destination, peer_id):
    entity = source["entity"]
    source_uuid = uuid.UUID(source["record_uuid"])
    mapping = _mapping_for(owner, direction, entity, source_uuid, peer_id)
    destination_uuid = _destination_uuid(direction, mapping, source_uuid)
    target = destination.get((entity, str(destination_uuid)))
    source_snapshot = source.get("snapshot") or {}
    destination_snapshot = _translate_relationships(
        owner, direction, entity, source_snapshot, peer_id, destination_uuid
    )
    source_deleted = bool(source.get("deleted"))
    if source.get("needs_repair"):
        classification, reason = "conflict", "source_requires_repair"
    elif target and target.get("needs_repair"):
        classification, reason = "conflict", "destination_requires_repair"
    elif target is None:
        has_restorable_snapshot = bool(
            source_snapshot.get("title") or source_snapshot.get("name")
        )
        classification, reason = (
            ("new", "") if not source_deleted or has_restorable_snapshot
            else ("synchronized", "")
        )
    elif target.get("deleted") and not source_deleted:
        classification, reason = "conflict", "destination_deleted"
    elif bool(target.get("deleted")) == source_deleted and target.get("snapshot") == destination_snapshot:
        classification, reason = "synchronized", ""
    else:
        source_peer_revision = source.get("peer_revision")
        target_peer_revision = target.get("peer_revision")
        if source_peer_revision is None or target_peer_revision is None:
            classification, reason = "conflict", "baseline_required"
        else:
            source_changed = source.get("revision", 0) > target_peer_revision
            destination_changed = target.get("revision", 0) > source_peer_revision
            if source_changed and destination_changed:
                classification, reason = "conflict", "both_sides_changed"
            elif source_changed:
                classification, reason = "updated", ""
            elif destination_changed:
                classification, reason = "conflict", "destination_changed"
            else:
                classification, reason = "conflict", "revision_mismatch"

    operation_id = uuid.uuid4()
    payload = {
        "operation_id": str(operation_id),
        "entity": entity,
        "record_uuid": str(source_uuid),
        "mapping_id": str(mapping.mapping_id) if mapping else None,
        "source_revision": source.get("revision"),
        "base_revision": target.get("revision") if target else None,
        "snapshot": destination_snapshot,
        "deleted": source_deleted,
    }
    return {
        "operation_id": str(operation_id),
        "entity": entity,
        "record_uuid": str(source_uuid),
        "destination_uuid": str(destination_uuid),
        "label": source_snapshot.get("title") or source_snapshot.get("name") or "(untitled)",
        "source_snapshot": source_snapshot,
        "classification": classification,
        "reason": reason,
        "payload": payload,
        "source_revision": source.get("revision"),
    }


class BridgeStatusView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        last = SyncHistory.objects.filter(
            owner=request.user, status="completed"
        ).order_by("-updated_at").first()
        return Response({
            "installation_id": str(installation_uuid()),
            "configured": bool(
                settings.NOTES_SYNC_PEER_URL
                and len(settings.NOTES_SYNC_PEER_SECRET) >= 32
                and settings.NOTES_SYNC_PEER_INSTALLATION_ID
            ),
            "last_successful_sync": last.updated_at.isoformat() if last else None,
            "indexing_jobs": list(
                IndexingJob.objects.filter(owner=request.user)
                .exclude(status="completed")
                .order_by("created_at")
                .values("note_uuid", "status", "attempts", "last_error")[:100]
            ),
            "history": list(SyncHistory.objects.filter(owner=request.user)
                            .order_by("-created_at").values(
                                "run_id", "direction", "status", "result", "created_at"
                            )[:20]),
        })


class BridgeIndexingJobsView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        jobs = IndexingJob.objects.filter(owner=request.user).exclude(
            status="completed"
        ).order_by("created_at")[:100]
        return Response({"jobs": [
            {
                "note_uuid": str(job.note_uuid), "status": job.status,
                "attempts": job.attempts, "last_error": job.last_error,
            } for job in jobs
        ]})

    def post(self, request):
        note_uuid = request.data.get("note_uuid")
        jobs = IndexingJob.objects.filter(owner=request.user, status="failed")
        if note_uuid:
            try:
                note_uuid = uuid.UUID(note_uuid)
            except (TypeError, ValueError):
                return Response({"detail": "Invalid note UUID."}, status=400)
            jobs = jobs.filter(note_uuid=note_uuid)
        updated = jobs.update(status="pending", attempts=0, last_error="")
        return Response({"queued": updated})


class BridgePreviewView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request):
        direction = request.data.get("direction")
        if direction not in {"push", "pull"}:
            return Response({"detail": "direction must be push or pull."}, status=400)
        auth_header = request.headers.get("Authorization", "")
        try:
            peer_id, peer_records = _peer_snapshot(auth_header)
        except PeerCommunicationError as error:
            return Response({"detail": str(error)}, status=503)
        local_records = snapshot_rows(request.user)
        if len(local_records) > 2000:
            return Response({"detail": "The AI inventory exceeds the safe preview limit."}, status=413)
        source = local_records if direction == "push" else peer_records
        target_records = peer_records if direction == "push" else local_records
        destination = {
            (item["entity"], item["record_uuid"]): item
            for item in target_records
        }
        plan = [
            _plan_item(request.user, direction, record, destination, peer_id)
            for record in source
        ]
        for item, source_record in zip(plan, source):
            if item["classification"] != "conflict":
                continue
            destination_record = destination.get(
                (item["entity"], item["destination_uuid"])
            )
            ai_uuid = (
                uuid.UUID(item["record_uuid"]) if direction == "push"
                else uuid.UUID(item["destination_uuid"])
            )
            non_ai_uuid = (
                uuid.UUID(item["destination_uuid"]) if direction == "push"
                else uuid.UUID(item["record_uuid"])
            )
            conflict_values = {
                "owner": request.user, "entity": item["entity"],
                "local_uuid": ai_uuid, "peer_uuid": non_ai_uuid,
                "reason": item["reason"] or "sync_conflict", "status": "open",
            }
            if not SyncConflict.objects.filter(**conflict_values).exists():
                SyncConflict.objects.create(
                    **conflict_values,
                    local_snapshot=(
                        source_record["snapshot"] if direction == "push"
                        else destination_record["snapshot"] if destination_record else {}
                    ),
                    incoming_snapshot=(
                        destination_record["snapshot"] if direction == "push" and destination_record
                        else source_record["snapshot"] if direction == "pull" else {}
                    ),
                    resolution={"direction": direction},
                )
        run = SyncHistory.objects.create(
            owner=request.user,
            direction=direction,
            plan=plan,
            status="preview",
        )
        counts = {
            name: sum(item["classification"] == name for item in plan)
            for name in ("new", "updated", "synchronized", "conflict")
        }
        return Response({
            "run_id": str(run.run_id),
            "direction": direction,
            "counts": counts,
            "items": [
                {
                    key: value for key, value in item.items()
                    if key not in {"payload", "source_snapshot"}
                }
                for item in plan
            ],
        })


class BridgeIdentityCandidatesView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        try:
            peer_id, peer_records = _peer_snapshot(
                request.headers.get("Authorization", "")
            )
        except PeerCommunicationError as error:
            return Response({"detail": str(error)}, status=503)
        local_records = snapshot_rows(request.user)
        if len(local_records) > 2000:
            return Response({"detail": "The AI inventory exceeds the safe identity-list limit."}, status=413)

        def summarize(records):
            return [{
                "entity": row["entity"],
                "record_uuid": row["record_uuid"],
                "label": (
                    row["snapshot"].get("title")
                    or row["snapshot"].get("name")
                    or "(untitled)"
                ),
                "deleted": row["deleted"],
                "needs_repair": row.get("needs_repair", False),
            } for row in records]

        return Response({
            "peer_installation": str(peer_id),
            "ai": summarize(local_records),
            "non_ai": summarize(peer_records),
        })


class BridgeConfirmView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request, run_id):
        run = SyncHistory.objects.filter(
            owner=request.user, run_id=run_id
        ).first()
        if run is None:
            return Response({"detail": "Preview not found."}, status=404)
        pending_acknowledgment = any(
            result.get("acknowledgment") == "pending"
            for result in run.result.get("results", [])
        )
        if run.status == "completed" and not pending_acknowledgment:
            return Response({"run_id": str(run.run_id), **run.result})
        selected = request.data.get("operation_ids")
        if not isinstance(selected, list) or not selected:
            return Response({"detail": "Select at least one operation."}, status=400)
        selected_ids = {str(value) for value in selected}
        eligible = [
            item for item in run.plan
            if item["operation_id"] in selected_ids
            and item["classification"] in {"new", "updated"}
        ]
        if len(eligible) != len(selected_ids):
            return Response({"detail": "Selection contains unavailable operations."}, status=400)
        run.status = "in_progress"
        run.save(update_fields=["status", "updated_at"])
        results = []
        if run.direction == "push":
            current_by_key = {
                (row["entity"], row["record_uuid"]): row
                for row in snapshot_rows(request.user)
            }
            transferable = []
            for item in eligible:
                current = current_by_key.get((item["entity"], item["record_uuid"]))
                if (
                    current is None
                    or current["needs_repair"]
                    or current["revision"] != item["source_revision"]
                    or current["snapshot"] != item["source_snapshot"]
                    or current["deleted"] != item["payload"]["deleted"]
                ):
                    results.append(_result_item(item, {
                        "status": "failed", "reason": "source_changed_since_preview",
                    }))
                else:
                    transferable.append(item)
            for start in range(0, len(transferable), 50):
                results.extend(_send_push_batch(
                    request, transferable[start:start + 50]
                ))
        else:
            try:
                peer_id, peer_records = _peer_snapshot(
                    request.headers.get("Authorization", "")
                )
            except PeerCommunicationError as error:
                peer_records = []
                peer_id = None
                results.extend(_result_item(item, {
                    "status": "failed", "reason": str(error)
                }) for item in eligible)
            if peer_id is not None:
                current_peer_by_key = {
                    (row["entity"], row["record_uuid"]): row
                    for row in peer_records
                }
                for item in eligible:
                    current = current_peer_by_key.get((item["entity"], item["record_uuid"]))
                    if (
                        current is None
                        or current.get("needs_repair")
                        or current["revision"] != item["source_revision"]
                        or current["snapshot"] != item["source_snapshot"]
                        or current["deleted"] != item["payload"]["deleted"]
                    ):
                        results.append(_result_item(item, {
                            "status": "failed", "reason": "source_changed_since_preview",
                        }))
                        continue
                    result = apply_change(
                        request.user,
                        item["payload"],
                        peer_id,
                    )
                    results.append(_result_item(item, result))
                    if result.get("status") == "accepted":
                        state = RecordState.objects.filter(
                            owner=request.user, entity=item["entity"],
                            record_uuid=result["local_uuid"],
                        ).first()
                        if state:
                            state.peer_revision = max(
                                state.peer_revision or 0, item["source_revision"] or 0
                            )
                            state.save(update_fields=["peer_revision", "updated_at"])
                        try:
                            peer_request(
                                "/api/sync/v1/peer/acknowledge/",
                                request.headers.get("Authorization", ""),
                                method="POST",
                                payload={
                                    "entity": item["entity"],
                                    "record_uuid": item["record_uuid"],
                                    "revision": result["revision"],
                                },
                            )
                        except PeerCommunicationError as error:
                            results[-1]["acknowledgment"] = "pending"
                            results[-1]["acknowledgment_error"] = str(error)
        succeeded = sum(result.get("status") in {"accepted", "already_applied"} for result in results)
        failed = len(results) - succeeded
        summary = {
            "results": results,
            "succeeded": succeeded,
            "failed": failed,
        }
        run.result = summary
        run.status = "completed" if failed == 0 else "partial"
        run.save(update_fields=["result", "status", "updated_at"])
        return Response({"run_id": str(run.run_id), **summary})


class BridgeHistoryView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        rows = SyncHistory.objects.filter(owner=request.user).order_by("-created_at")[:100]
        return Response({"history": [
            {
                "run_id": str(row.run_id), "direction": row.direction,
                "status": row.status, "result": row.result,
                "created_at": row.created_at.isoformat(),
            } for row in rows
        ]})


class BridgeRetryAcknowledgmentsView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request, run_id):
        run = SyncHistory.objects.filter(owner=request.user, run_id=run_id).first()
        if run is None:
            return Response({"detail": "Sync history item not found."}, status=404)
        pending_items = run.result.get("results")
        if not isinstance(pending_items, list):
            pending_items = []
        attempted = 0
        pending = 0
        for item in pending_items:
            if not isinstance(item, dict) or item.get("acknowledgment") != "pending":
                continue
            if run.direction == "push":
                record_uuid = item.get("local_uuid", item.get("destination_uuid"))
                revision = item.get("source_revision")
            else:
                record_uuid = item.get("record_uuid")
                revision = item.get("revision")
            try:
                peer_request(
                    "/api/sync/v1/peer/acknowledge/",
                    request.headers.get("Authorization", ""),
                    method="POST",
                    payload={
                        "entity": item.get("entity"),
                        "record_uuid": record_uuid,
                        "revision": revision,
                    },
                )
            except PeerCommunicationError as error:
                item["acknowledgment_error"] = str(error)
                pending += 1
            else:
                item.pop("acknowledgment", None)
                item.pop("acknowledgment_error", None)
                attempted += 1

        one_result = run.result.get("result")
        if isinstance(one_result, dict) and one_result.get("acknowledgment") == "pending":
            payload = one_result.get("acknowledgment_payload")
            if isinstance(payload, dict):
                try:
                    peer_request(
                        "/api/sync/v1/peer/acknowledge/",
                        request.headers.get("Authorization", ""),
                        method="POST",
                        payload=payload,
                    )
                except PeerCommunicationError as error:
                    one_result["acknowledgment_error"] = str(error)
                    pending += 1
                else:
                    one_result.pop("acknowledgment", None)
                    one_result.pop("acknowledgment_error", None)
                    attempted += 1
        run.save(update_fields=["result", "updated_at"])
        return Response({"attempted": attempted, "pending": pending})


class BridgeConflictsView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        rows = SyncConflict.objects.filter(owner=request.user, status="open").order_by("created_at")[:100]
        return Response({"conflicts": [
            {
                "id": row.pk, "entity": row.entity,
                "local_uuid": str(row.local_uuid),
                "peer_uuid": str(row.peer_uuid) if row.peer_uuid else None,
                "reason": row.reason, "local": row.local_snapshot,
                "incoming": row.incoming_snapshot,
                "direction": row.resolution.get("direction", "pull"),
            } for row in rows
        ]})


class BridgeConflictResolveView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request, conflict_id):
        conflict = SyncConflict.objects.filter(
            owner=request.user, pk=conflict_id, status="open"
        ).first()
        if conflict is None:
            return Response({"detail": "Open conflict not found."}, status=404)
        choice = request.data.get("choice")
        if choice not in {"keep_ai", "keep_non_ai"}:
            return Response({"detail": "Choose which project version to keep."}, status=400)
        direction = conflict.resolution.get("direction", "pull")
        if direction not in {"push", "pull"} or conflict.peer_uuid is None:
            return Response({"detail": "This conflict requires manual repair and cannot be resolved by replacement."}, status=409)

        try:
            peer_id, peer_records = _peer_snapshot(
                request.headers.get("Authorization", "")
            )
        except PeerCommunicationError as error:
            return Response({"detail": str(error)}, status=503)
        local_records = snapshot_rows(request.user)
        local_uuid = conflict.local_uuid
        peer_uuid = conflict.peer_uuid
        source_uuid = local_uuid if direction == "push" else peer_uuid
        destination_uuid = peer_uuid if direction == "push" else local_uuid
        keep_source = (
            (direction == "push" and choice == "keep_ai")
            or (direction == "pull" and choice == "keep_non_ai")
        )
        source_records = local_records if direction == "push" else peer_records
        target_records = peer_records if direction == "push" else local_records
        source = next((
            row for row in source_records
            if row["entity"] == conflict.entity and row["record_uuid"] == str(source_uuid)
        ), None)
        target = next((
            row for row in target_records
            if row["entity"] == conflict.entity and row["record_uuid"] == str(destination_uuid)
        ), None)
        if (
            (source is not None and source.get("needs_repair"))
            or (target is not None and target.get("needs_repair"))
        ):
            return Response({
                "detail": "Repair flagged source and destination records before resolving this conflict."
            }, status=409)
        operation_id = uuid.uuid4()
        result = {"status": "kept_destination"}
        if keep_source:
            if source is None or source.get("needs_repair"):
                return Response({"detail": "The selected source record is unavailable or needs repair."}, status=409)
            mapping = _mapping_for(
                request.user, direction, conflict.entity, source_uuid, peer_id
            )
            expected_destination_uuid = _destination_uuid(
                direction, mapping, source_uuid
            )
            if str(expected_destination_uuid) != str(destination_uuid):
                return Response({"detail": "The current identity mapping does not match this conflict."}, status=409)
            change = {
                "operation_id": str(operation_id),
                "entity": conflict.entity,
                "record_uuid": str(source_uuid),
                "mapping_id": str(mapping.mapping_id) if mapping else None,
                "source_revision": source["revision"],
                "base_revision": target["revision"] if target else None,
                "snapshot": _translate_relationships(
                    request.user, direction, conflict.entity,
                    source["snapshot"], peer_id, destination_uuid,
                ),
                "deleted": source["deleted"],
            }
            if direction == "push":
                try:
                    response = peer_request(
                        "/api/sync/v1/peer/apply/",
                        request.headers.get("Authorization", ""),
                        method="POST",
                        payload={"changes": [change]},
                    )
                except PeerCommunicationError as error:
                    return Response({"detail": str(error)}, status=503)
                remote_results = response.get("results")
                if not isinstance(remote_results, list) or len(remote_results) != 1 or not isinstance(remote_results[0], dict):
                    return Response({"detail": "The peer returned an invalid resolution result."}, status=503)
                result = remote_results[0]
            else:
                result = apply_change(request.user, change, peer_id)
            if result.get("status") not in {"accepted", "already_applied"}:
                return Response({"detail": "The destination changed again; preview and review the conflict once more.", "result": result}, status=409)

        local_revision = (
            result.get("revision") if direction == "pull" and keep_source
            else source.get("revision") if direction == "push" and source
            else target.get("revision") if target else None
        )
        peer_revision = (
            result.get("revision") if direction == "push" and keep_source
            else source.get("revision") if direction == "pull" and source
            else target.get("revision") if target else None
        )
        local_state = RecordState.objects.filter(
            owner=request.user, entity=conflict.entity, record_uuid=local_uuid
        ).first()
        if local_state and peer_revision is not None:
            local_state.peer_revision = peer_revision
            local_state.save(update_fields=["peer_revision", "updated_at"])
        if local_revision is not None:
            acknowledgment_payload = {
                "entity": conflict.entity,
                "record_uuid": str(peer_uuid),
                "revision": local_revision,
            }
            try:
                peer_request(
                    "/api/sync/v1/peer/acknowledge/",
                    request.headers.get("Authorization", ""),
                    method="POST",
                    payload=acknowledgment_payload,
                )
            except PeerCommunicationError:
                result["acknowledgment"] = "pending"
                result["acknowledgment_payload"] = acknowledgment_payload

        conflict.status = "resolved"
        conflict.resolution = {
            "direction": direction,
            "choice": choice,
            "actor": str(request.user.supabase_uid),
            "operation_id": str(operation_id) if keep_source else None,
            "result": result,
        }
        conflict.resolved_at = timezone.now()
        conflict.save(update_fields=["status", "resolution", "resolved_at"])
        SyncHistory.objects.create(
            owner=request.user,
            direction=direction,
            status="completed",
            result={"conflict_id": conflict.pk, "choice": choice, "result": result},
        )
        return Response({"conflict_id": conflict.pk, "status": "resolved", "result": result})


class BridgeReconcileView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request):
        try:
            direction = request.data["direction"]
            entity = request.data["entity"]
            local_uuid = uuid.UUID(request.data["local_uuid"])
            peer_uuid = uuid.UUID(request.data["peer_uuid"])
            action = request.data["action"]
        except (KeyError, ValueError, TypeError):
            return Response({"detail": "Invalid reconciliation request."}, status=400)
        if direction not in {"push", "pull"} or entity not in {"note", "folder"}:
            return Response({"detail": "Unsupported reconciliation target."}, status=400)
        if action not in {"pair", "separate", "defer"}:
            return Response({"detail": "Unsupported reconciliation action."}, status=400)
        try:
            peer_id, _ = _peer_snapshot(request.headers.get("Authorization", ""))
            local_id, remote_id = (
                (local_uuid, peer_uuid) if direction == "push"
                else (peer_uuid, local_uuid)
            )
            local_rows = snapshot_rows(request.user)
            if action == "pair" and not any(
                row["entity"] == entity and row["record_uuid"] == str(local_id)
                and not row["deleted"]
                for row in local_rows
            ):
                return Response({"detail": "The selected AI record was not found."}, status=404)
            status_by_action = {
                "pair": IdentityMapping.Status.CONFIRMED,
                "defer": IdentityMapping.Status.DEFERRED,
                "separate": IdentityMapping.Status.REVOKED,
            }
            active_statuses = (
                IdentityMapping.Status.PENDING,
                IdentityMapping.Status.CONFIRMED,
                IdentityMapping.Status.DEFERRED,
            )
            mapping = IdentityMapping.objects.filter(
                owner=request.user, entity=entity,
                peer_installation=peer_id,
                local_uuid=local_id, status__in=active_statuses,
            ).first()
            if mapping and mapping.peer_uuid != remote_id:
                return Response({"detail": "Identity mapping conflicts with an existing mapping."}, status=409)
            if mapping is None and action == "separate":
                mapping = IdentityMapping.objects.filter(
                    owner=request.user, entity=entity,
                    peer_installation=peer_id, local_uuid=local_id,
                    peer_uuid=remote_id, status=IdentityMapping.Status.REVOKED,
                ).order_by("-updated_at").first()
            if mapping is None:
                try:
                    mapping = IdentityMapping.objects.create(
                        owner=request.user, entity=entity,
                        peer_installation=peer_id, local_uuid=local_id,
                        peer_uuid=remote_id, mapping_id=uuid.uuid4(),
                        status=IdentityMapping.Status.PENDING,
                        audit=[{
                            "action": action, "state": "requested",
                            "actor": str(request.user.supabase_uid),
                            "ai_uuid": str(local_id), "non_ai_uuid": str(remote_id),
                        }],
                    )
                except IntegrityError:
                    return Response({"detail": "Identity mapping conflicts with an existing mapping."}, status=409)
            if mapping.status != IdentityMapping.Status.PENDING:
                mapping.status = IdentityMapping.Status.PENDING
                mapping.audit = mapping.audit + [{
                    "action": action, "state": "requested",
                    "actor": str(request.user.supabase_uid),
                    "ai_uuid": str(local_id), "non_ai_uuid": str(remote_id),
                }]
                mapping.save(update_fields=["status", "audit", "updated_at"])
            peer_result = peer_request(
                "/api/sync/v1/peer/reconcile/",
                request.headers.get("Authorization", ""),
                method="POST",
                payload={
                    "entity": entity,
                    "local_uuid": str(remote_id),
                    "peer_uuid": str(local_id),
                    "mapping_id": str(mapping.mapping_id),
                    "action": action,
                },
            )
            if peer_result.get("mapping_id") != str(mapping.mapping_id):
                raise PeerCommunicationError("The peer confirmed a different identity mapping.")
            if peer_result.get("status") != status_by_action[action]:
                raise PeerCommunicationError("The peer did not confirm the requested identity decision.")
            mapping.status = status_by_action[action]
            mapping.audit = mapping.audit + [{
                "action": action, "state": "confirmed",
                "actor": str(request.user.supabase_uid),
                "ai_uuid": str(local_id), "non_ai_uuid": str(remote_id),
            }]
            mapping.save(update_fields=["status", "audit", "updated_at"])
        except PeerCommunicationError as error:
            return Response({"detail": str(error)}, status=503)
        return Response({"mapping_id": str(mapping.mapping_id), "status": mapping.status})
