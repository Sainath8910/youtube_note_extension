from django.contrib import admin

from .models import Note


@admin.register(Note)
class NoteAdmin(admin.ModelAdmin):
    list_display = ("title", "user", "folder", "video", "note_type", "updated_at")
    list_filter = ("user", "note_type", "folder", "video")
    search_fields = ("title", "content", "user__username")
    ordering = ("-updated_at",)
    readonly_fields = ("created_at", "updated_at")
    autocomplete_fields = ["user", "folder", "video"]
