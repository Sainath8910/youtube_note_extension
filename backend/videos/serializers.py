import math

from rest_framework import serializers

from .models import Video, VideoAnalysis


class VideoLibrarySerializer(serializers.ModelSerializer):
    youtube_url = serializers.SerializerMethodField()
    notes_count = serializers.IntegerField(read_only=True)
    updated_at = serializers.DateTimeField(
        source="library_updated_at",
        read_only=True,
    )
    transcript_availability = serializers.SerializerMethodField()
    analysis_availability = serializers.SerializerMethodField()

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
            "youtube_url",
            "notes_count",
            "transcript_availability",
            "analysis_availability",
            "created_at",
            "updated_at",
        ]
        read_only_fields = fields

    def get_youtube_url(self, video):
        return f"https://www.youtube.com/watch?v={video.youtube_id}"

    def get_transcript_availability(self, video):
        statuses = {
            Video.TranscriptStatus.FETCHING: "processing",
            Video.TranscriptStatus.FAILED: "failed",
        }
        if video.transcript_status in statuses:
            return statuses[video.transcript_status]
        if (
            video.transcript_status == Video.TranscriptStatus.READY
            and isinstance(video.transcript, list)
            and video.transcript
            and all(
                isinstance(segment, dict)
                and isinstance(segment.get("text"), str)
                and isinstance(segment.get("start"), (int, float))
                and not isinstance(segment.get("start"), bool)
                and math.isfinite(segment["start"])
                and isinstance(segment.get("duration"), (int, float))
                and not isinstance(segment.get("duration"), bool)
                and math.isfinite(segment["duration"])
                for segment in video.transcript
            )
        ):
            return "available"
        return "missing"

    def get_analysis_availability(self, video):
        statuses = {
            Video.AnalysisStatus.ANALYZING: "processing",
            Video.AnalysisStatus.FAILED: "failed",
        }
        if video.analysis_status in statuses:
            return statuses[video.analysis_status]
        if video.analysis_status != Video.AnalysisStatus.READY:
            return "missing"
        try:
            analysis = video.analysis
        except VideoAnalysis.DoesNotExist:
            return "missing"
        available_fields = (
            analysis.summary.strip(),
            analysis.detailed_notes,
            analysis.topics,
            analysis.concepts,
            analysis.prerequisites,
            analysis.upcoming_topics,
            analysis.key_points,
            analysis.claims,
            analysis.questions,
        )
        return "available" if any(available_fields) else "missing"


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
            "transcript",
            "transcript_language",
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
