from rest_framework import serializers

from .models import Note
from folders.models import Folder
from videos.models import Video


class NoteVideoMetadataSerializer(serializers.ModelSerializer):
    class Meta:
        model = Video
        fields = [
            "id",
            "youtube_id",
            "title",
            "channel_name",
            "channel_handle",
            "thumbnail_url",
        ]
        read_only_fields = fields


class NoteSerializer(serializers.ModelSerializer):
    folder = serializers.PrimaryKeyRelatedField(
        queryset=Folder.objects.none(),
        allow_null=True,
        required=False,
    )
    video_detail = NoteVideoMetadataSerializer(
        source="video",
        read_only=True,
        allow_null=True,
    )
    folder_path = serializers.SerializerMethodField()

    class Meta:
        model = Note
        fields = [
            "id",
            "title",
            "document",
            "content",
            "note_type",
            "folder",
            "folder_path",
            "video",
            "video_detail",
            "timestamp_seconds",
            "created_at",
            "updated_at",
        ]
        read_only_fields = [
            "id",
            "created_at",
            "updated_at",
        ]

    def get_fields(self):
        fields = super().get_fields()
        request = self.context.get("request")
        if request is not None and request.user.is_authenticated:
            fields["folder"].queryset = Folder.objects.filter(user=request.user)
        return fields

    def get_folder_path(self, note):
        if note.folder_id is None:
            return []

        request = self.context.get("request")
        if (
            request is None
            or not request.user.is_authenticated
            or request.user.pk != note.user_id
        ):
            return []

        caches = self.context.setdefault("_folder_path_caches", {})
        cache = caches.get(note.user_id)
        if cache is None:
            folders = {
                folder["id"]: folder
                for folder in Folder.objects.filter(
                    user_id=note.user_id,
                ).values("id", "name", "parent_id")
            }
            cache = {"folders": folders, "paths": {}}
            caches[note.user_id] = cache

        folder_paths = cache["paths"]
        if note.folder_id in folder_paths:
            return list(folder_paths[note.folder_id])

        chain = []
        visited = set()
        current_id = note.folder_id
        while current_id not in folder_paths:
            if current_id in visited:
                return []
            visited.add(current_id)
            folder = cache["folders"].get(current_id)
            if folder is None:
                return []
            chain.append(folder)
            if folder["parent_id"] is None:
                break
            current_id = folder["parent_id"]

        path = list(folder_paths.get(current_id, []))
        for folder in reversed(chain):
            path = [*path, {"id": folder["id"], "name": folder["name"]}]
            folder_paths[folder["id"]] = path

        return list(folder_paths[note.folder_id])

    def validate_document(self, value):
        if not isinstance(value, dict):
            raise serializers.ValidationError(
                "Document must be an object."
            )

        version = value.get("version")
        blocks = value.get("blocks")

        if version != 1:
            raise serializers.ValidationError(
                "Document version must be 1."
            )

        if not isinstance(blocks, list):
            raise serializers.ValidationError(
                "Document blocks must be a list."
            )

        for index, block in enumerate(blocks):
            if not isinstance(block, dict):
                raise serializers.ValidationError(
                    f"Block {index} must be an object."
                )

            if not block.get("id"):
                raise serializers.ValidationError(
                    f"Block {index} is missing an id."
                )

            if not block.get("type"):
                raise serializers.ValidationError(
                    f"Block {index} is missing a type."
                )

            if "content" not in block:
                raise serializers.ValidationError(
                    f"Block {index} is missing content."
                )

        return value

    def validate(self, attrs):
        note_type = attrs.get("note_type")
        video = attrs.get("video")
        timestamp_seconds = attrs.get("timestamp_seconds")

        if note_type == Note.NoteType.VIDEO:
            if video is None:
                raise serializers.ValidationError({
                    "video": "Video notes must be associated with a video."
                })

        elif note_type == Note.NoteType.STANDALONE:
            if video is not None:
                raise serializers.ValidationError({
                    "video": "Standalone notes cannot be associated with a video."
                })

            if timestamp_seconds is not None:
                raise serializers.ValidationError({
                    "timestamp_seconds": (
                        "Standalone notes cannot have a timestamp."
                    )
                })

        return attrs


class NoteAssistanceTargetSerializer(serializers.Serializer):
    kind = serializers.CharField(required=True)
    block_id = serializers.CharField(required=True, allow_blank=False)

    def validate(self, attrs):
        if attrs["kind"] != "block":
            raise serializers.ValidationError(
                {"kind": "Only block targets are supported."}
            )
        return attrs


class NoteAssistanceRequestSerializer(serializers.Serializer):
    operation = serializers.CharField(required=True)
    target = NoteAssistanceTargetSerializer(required=True)
    base_updated_at = serializers.DateTimeField(
        required=True,
        help_text=(
            "ISO 8601 datetime copied from the note's updated_at field "
            "(the API returns UTC)."
        ),
    )

    def validate(self, attrs):
        unexpected = set(self.initial_data) - {
            "operation",
            "target",
            "base_updated_at",
        }
        if unexpected:
            raise serializers.ValidationError(
                "Unexpected request fields are not allowed."
            )
        target = self.initial_data.get("target")
        if isinstance(target, dict):
            unexpected_target_fields = set(target) - {"kind", "block_id"}
            if unexpected_target_fields:
                raise serializers.ValidationError(
                    {"target": "Unexpected target fields are not allowed."}
                )
        if attrs["operation"] != "improve":
            raise serializers.ValidationError(
                {"operation": "Only the improve operation is supported."}
            )
        return attrs