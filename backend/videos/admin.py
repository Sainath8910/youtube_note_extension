from django.contrib import admin

from .models import Video, VideoAnalysis, ViewingSession


@admin.register(Video)
class VideoAdmin(admin.ModelAdmin):
    list_display = (
        "title",
        "youtube_id",
        "channel_name",
        "transcript_status",
        "analysis_status",
        "created_at",
    )
    list_filter = ("transcript_status", "analysis_status")
    search_fields = ("title", "youtube_id", "channel_name", "channel_handle")
    ordering = ("-created_at",)
    readonly_fields = ("created_at", "updated_at", "transcript_fetched_at")


@admin.register(ViewingSession)
class ViewingSessionAdmin(admin.ModelAdmin):
    list_display = ("user", "video", "last_position_seconds", "last_watched_at")
    list_filter = ("user",)
    search_fields = ("user__username", "video__title")
    ordering = ("-last_watched_at",)
    readonly_fields = ("last_watched_at",)
    autocomplete_fields = ["user", "video"]


@admin.register(VideoAnalysis)
class VideoAnalysisAdmin(admin.ModelAdmin):
    list_display = ("video", "model", "analysis_version", "created_at")
    list_filter = ("analysis_version", "model")
    search_fields = ("video__title", "video__youtube_id", "model")
    ordering = ("-created_at",)
    readonly_fields = ("created_at", "updated_at")
