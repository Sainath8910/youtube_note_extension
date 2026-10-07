from django.contrib import admin

from .models import Folder


@admin.register(Folder)
class FolderAdmin(admin.ModelAdmin):
    list_display = ("name", "user", "parent", "created_at")
    list_filter = ("user", "parent")
    search_fields = ("name", "description", "user__username")
    ordering = ("user__username", "name")
    readonly_fields = ("created_at", "updated_at")
    autocomplete_fields = ["user", "parent"]