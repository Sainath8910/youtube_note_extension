from rest_framework import serializers

from .models import Note
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
    video_detail = NoteVideoMetadataSerializer(
        source="video",
        read_only=True,
        allow_null=True,
    )

    class Meta:
        model = Note
        fields = [
            "id",
            "title",
            "document",
            "content",
            "note_type",
            "folder",
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