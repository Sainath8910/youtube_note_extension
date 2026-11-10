import uuid

from django.conf import settings
from django.db import models
from django.db.models import Q


class Installation(models.Model):
    installation_uuid = models.UUIDField(default=uuid.uuid4, unique=True)
    created_at = models.DateTimeField(auto_now_add=True)


class RecordState(models.Model):
    class Entity(models.TextChoices):
        NOTE = "note", "Note"
        FOLDER = "folder", "Folder"
        PLAYLIST = "playlist", "Playlist"

    owner = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="sync_states"
    )
    entity = models.CharField(max_length=10, choices=Entity.choices)
    record_uuid = models.UUIDField()
    revision = models.PositiveBigIntegerField(default=1)
    peer_revision = models.PositiveBigIntegerField(null=True, blank=True)
    snapshot = models.JSONField(default=dict)
    deleted = models.BooleanField(default=False)
    needs_repair = models.BooleanField(default=False)
    origin_installation = models.UUIDField(null=True, blank=True)
    origin_operation = models.UUIDField(null=True, blank=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=("owner", "entity", "record_uuid"),
                                    name="sync_state_owner_entity_uuid_unique")
        ]


class ChangeEvent(models.Model):
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    entity = models.CharField(max_length=10, choices=RecordState.Entity.choices)
    record_uuid = models.UUIDField()
    revision = models.PositiveBigIntegerField()
    snapshot = models.JSONField(default=dict)
    deleted = models.BooleanField(default=False)
    operation_id = models.UUIDField(default=uuid.uuid4)
    origin_installation = models.UUIDField(null=True, blank=True)
    origin_operation = models.UUIDField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ("id",)
        indexes = [models.Index(fields=("owner", "id"))]


class SyncOperation(models.Model):
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    operation_id = models.UUIDField()
    request_hash = models.CharField(max_length=64)
    response = models.JSONField(default=dict)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=("owner", "operation_id"),
                                    name="sync_operation_owner_id_unique")
        ]


class IdentityMapping(models.Model):
    class Status(models.TextChoices):
        PENDING = "pending", "Pending"
        CONFIRMED = "confirmed", "Confirmed"
        DEFERRED = "deferred", "Deferred"
        REVOKED = "revoked", "Revoked"

    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    entity = models.CharField(max_length=10, choices=RecordState.Entity.choices)
    peer_installation = models.UUIDField()
    local_uuid = models.UUIDField()
    peer_uuid = models.UUIDField()
    mapping_id = models.UUIDField(default=uuid.uuid4, unique=True)
    status = models.CharField(max_length=12, choices=Status.choices,
                              default=Status.PENDING)
    audit = models.JSONField(default=list)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=("owner", "entity", "peer_installation", "local_uuid"),
                condition=~Q(status="revoked"),
                name="sync_map_local_identity_unique",
            ),
            models.UniqueConstraint(
                fields=("owner", "entity", "peer_installation", "peer_uuid"),
                condition=~Q(status="revoked"),
                name="sync_map_peer_identity_unique",
            ),
        ]


class SyncConflict(models.Model):
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    entity = models.CharField(max_length=10, choices=RecordState.Entity.choices)
    local_uuid = models.UUIDField()
    peer_uuid = models.UUIDField(null=True, blank=True)
    reason = models.CharField(max_length=64)
    local_snapshot = models.JSONField(default=dict)
    incoming_snapshot = models.JSONField(default=dict)
    status = models.CharField(max_length=16, default="open")
    resolution = models.JSONField(default=dict)
    created_at = models.DateTimeField(auto_now_add=True)
    resolved_at = models.DateTimeField(null=True, blank=True)


class SyncHistory(models.Model):
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    run_id = models.UUIDField(default=uuid.uuid4, unique=True)
    direction = models.CharField(max_length=8)
    status = models.CharField(max_length=16, default="preview")
    plan = models.JSONField(default=list)
    result = models.JSONField(default=dict)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)


class PeerNonce(models.Model):
    peer_installation = models.UUIDField()
    nonce = models.CharField(max_length=128)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=("peer_installation", "nonce"),
                                    name="sync_peer_nonce_unique")
        ]


class SyncCursor(models.Model):
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    peer_installation = models.UUIDField()
    last_event_id = models.PositiveBigIntegerField(default=0)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=("owner", "peer_installation"),
                                    name="sync_cursor_owner_peer_unique")
        ]


class BootstrapSnapshot(models.Model):
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    peer_installation = models.UUIDField()
    snapshot_id = models.UUIDField(default=uuid.uuid4, unique=True)
    high_watermark = models.PositiveBigIntegerField(default=0)
    records = models.JSONField(default=list)
    created_at = models.DateTimeField(auto_now_add=True)


class IndexingJob(models.Model):
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    note_uuid = models.UUIDField()
    status = models.CharField(max_length=16, default="pending")
    attempts = models.PositiveIntegerField(default=0)
    last_error = models.CharField(max_length=255, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=("owner", "note_uuid"),
                                    name="sync_index_job_owner_note_unique")
        ]
