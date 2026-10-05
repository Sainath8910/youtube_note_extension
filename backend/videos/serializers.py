from rest_framework import serializers

from .models import Video, VideoAnalysis


class VideoAnalysisSerializer(serializers.ModelSerializer):
    class Meta:
        model = VideoAnalysis
        fields = [
            "id",
            "video",
            "summary",
            "detailed_notes",
            "topics",
            "concepts",
            "prerequisites",
            "upcoming_topics",
            "key_points",
            "claims",
            "questions",
            "model",
            "analysis_version",
            "created_at",
            "updated_at",
        ]
        read_only_fields = fields


class VideoSerializer(serializers.ModelSerializer):
    analysis = VideoAnalysisSerializer(read_only=True, allow_null=True)

    class Meta:
        model = Video
        fields = [
            "id",
            "youtube_id",
            "title",
            "channel_name",
            "channel_handle",
            "channel_id",
            "thumbnail_url",
            "duration_seconds",
            "transcript_status",
            "analysis_status",
            "analysis",
            "created_at",
            "updated_at",
        ]
        read_only_fields = [
            "id",
            "created_at",
            "updated_at",
        ]
