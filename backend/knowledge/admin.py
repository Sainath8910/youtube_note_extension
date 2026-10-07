from django.contrib import admin

from .models import KnowledgeChunk, PreviousContextJob


@admin.register(KnowledgeChunk)
class KnowledgeChunkAdmin(admin.ModelAdmin):
    list_display = (
        "user",
        "content_type",
        "source_type",
        "note",
        "video",
        "folder",
        "chunk_index",
        "created_at",
    )
    list_filter = ("user", "content_type", "source_type", "folder", "note", "video")
    search_fields = ("content", "source_block_id", "user__username")
    ordering = ("-created_at",)
    readonly_fields = ("created_at", "updated_at")
    autocomplete_fields = ["user", "note", "video", "folder"]


@admin.register(PreviousContextJob)
class PreviousContextJobAdmin(admin.ModelAdmin):
    list_display = ("user", "youtube_id", "video", "status", "created_at")
    list_filter = ("status", "user", "video")
    search_fields = ("youtube_id", "user__username", "error")
    ordering = ("-created_at",)
    readonly_fields = ("id", "created_at", "updated_at")
    autocomplete_fields = ["user", "video"]