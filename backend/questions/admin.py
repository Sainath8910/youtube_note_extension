from django.contrib import admin

from .models import Question


@admin.register(Question)
class QuestionAdmin(admin.ModelAdmin):
    list_display = ("question_preview", "user", "video", "folder", "created_at")
    list_filter = ("user", "video", "folder")
    search_fields = ("question", "answer", "user__username")
    ordering = ("-created_at",)
    readonly_fields = ("created_at",)
    autocomplete_fields = ["user", "video", "folder"]

    @admin.display(description="Question")
    def question_preview(self, obj):
        preview = obj.question.strip()
        return (preview[:80] + "…") if len(preview) > 80 else preview or "—"
