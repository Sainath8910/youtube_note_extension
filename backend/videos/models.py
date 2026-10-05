from django.db import models


class Video(models.Model):

    class TranscriptStatus(models.TextChoices):
        NOT_STARTED = "NOT_STARTED", "Not started"
        FETCHING = "FETCHING", "Fetching"
        READY = "READY", "Ready"
        FAILED = "FAILED", "Failed"

    class AnalysisStatus(models.TextChoices):
        NOT_STARTED = "NOT_STARTED", "Not started"
        ANALYZING = "ANALYZING", "Analyzing"
        READY = "READY", "Ready"
        FAILED = "FAILED", "Failed"

    youtube_id = models.CharField(
        max_length=20,
        unique=True,
    )

    title = models.CharField(
        max_length=500,
        blank=True,
    )

    channel_name = models.CharField(
        max_length=255,
        blank=True,
    )

    channel_handle = models.CharField(
        max_length=255,
        blank=True,
    )

    channel_id = models.CharField(
        max_length=255,
        blank=True,
    )

    thumbnail_url = models.URLField(
        blank=True,
    )

    duration_seconds = models.PositiveIntegerField(
        null=True,
        blank=True,
    )

    transcript_status = models.CharField(
        max_length=20,
        choices=TranscriptStatus.choices,
        default=TranscriptStatus.NOT_STARTED,
    )

    transcript = models.JSONField(
        null=True,
        blank=True,
    )

    transcript_language = models.CharField(
        max_length=35,
        blank=True,
    )

    transcript_fetched_at = models.DateTimeField(
        null=True,
        blank=True,
    )

    analysis_status = models.CharField(
        max_length=20,
        choices=AnalysisStatus.choices,
        default=AnalysisStatus.NOT_STARTED,
    )

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    def __str__(self):
        return self.title or self.youtube_id


class ViewingSession(models.Model):
    user = models.ForeignKey(
        "users.User",
        on_delete=models.CASCADE,
        related_name="viewing_sessions",
    )

    video = models.ForeignKey(
        Video,
        on_delete=models.CASCADE,
        related_name="viewing_sessions",
    )

    last_position_seconds = models.PositiveIntegerField(
        default=0,
    )

    last_watched_at = models.DateTimeField(
        auto_now=True,
    )

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["user", "video"],
                name="unique_user_video_session",
            )
        ]

    def __str__(self):
        return f"{self.user} - {self.video}"


class VideoAnalysis(models.Model):
    video = models.OneToOneField(
        Video,
        on_delete=models.CASCADE,
        related_name="analysis",
    )
    summary = models.TextField(
        blank=True,
        default="",
    )
    detailed_notes = models.JSONField(
        default=dict,
        blank=True,
    )
    topics = models.JSONField(
        default=list,
        blank=True,
    )
    concepts = models.JSONField(
        default=list,
        blank=True,
    )
    prerequisites = models.JSONField(
        default=list,
        blank=True,
    )
    upcoming_topics = models.JSONField(
        default=list,
        blank=True,
    )
    key_points = models.JSONField(
        default=list,
        blank=True,
    )
    claims = models.JSONField(
        default=list,
        blank=True,
    )
    questions = models.JSONField(
        default=list,
        blank=True,
    )
    model = models.CharField(
        max_length=200,
        blank=True,
        default="",
    )
    analysis_version = models.PositiveIntegerField(
        default=1,
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)