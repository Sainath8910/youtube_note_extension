"""PostgreSQL-backed job boundary for Previous Context computation."""

from __future__ import annotations

import logging

from django.contrib.auth import get_user_model
from django.db import transaction

from knowledge.models import PreviousContextJob, PreviousContextJobStatus
from knowledge.serializers import PreviousContextSerializer
from knowledge.services.previous_context import get_previous_context
from knowledge.services.previous_context_events import (
    PreviousContextEventPublishError,
    publish_previous_context_job,
)
from users.models import User
from videos.models import Video

logger = logging.getLogger(__name__)

_JOB_FAILURE_MESSAGE = "Previous Context computation failed."


def create_previous_context_job(
    *,
    user: User,
    youtube_id: str,
) -> PreviousContextJob:
    """Register a PENDING job without performing any retrieval work."""
    if (
        not isinstance(user, get_user_model())
        or user.pk is None
        or not user.is_authenticated
    ):
        raise ValueError("user must be a saved authenticated user.")
    if not isinstance(youtube_id, str) or not youtube_id.strip():
        raise ValueError("youtube_id must be a non-empty string.")

    job = PreviousContextJob.objects.create(
        user=user,
        youtube_id=youtube_id.strip(),
        status=PreviousContextJobStatus.PENDING,
    )

    def _publish_event():
        try:
            publish_previous_context_job(job)
        except PreviousContextEventPublishError:
            logger.exception(
                "Previous Context job committed as PENDING, but Kafka "
                "publication failed job_id=%s",
                job.job_id,
            )

    transaction.on_commit(_publish_event)

    return job


def get_previous_context_job(job_id: str) -> PreviousContextJob:
    """Return the PostgreSQL job record."""
    try:
        return PreviousContextJob.objects.get(id=job_id)
    except PreviousContextJob.DoesNotExist:
        raise KeyError("Previous Context job not found.") from None


def run_previous_context_job(job_id: str) -> PreviousContextJob:
    """Run one PENDING job; safe to invoke explicitly from a shell or worker."""
    try:
        with transaction.atomic():
            job = PreviousContextJob.objects.select_for_update().get(id=job_id)
            
            if job.status != PreviousContextJobStatus.PENDING:
                return job

            job.status = PreviousContextJobStatus.PROCESSING
            job.save(update_fields=["status", "updated_at"])
    except PreviousContextJob.DoesNotExist:
        raise KeyError("Previous Context job not found.") from None

    logger.info("Previous Context job claimed job_id=%s", job.job_id)
    try:
        logger.info(
            "Previous Context computation started job_id=%s",
            job.job_id,
        )
        user = job.user
        video = Video.objects.get(youtube_id=job.youtube_id)
        context = get_previous_context(user=user, video=video)
        result = dict(PreviousContextSerializer(context).data)
    except Exception as exc:
        job.status = PreviousContextJobStatus.FAILED
        job.result = None
        job.error = _JOB_FAILURE_MESSAGE
        job.save(update_fields=["status", "result", "error", "updated_at"])
        
        logger.warning(
            "Previous Context job failed job_id=%s exception_type=%s",
            job.job_id,
            type(exc).__name__,
        )
        return job

    job.result = result
    job.error = None
    job.status = PreviousContextJobStatus.READY
    job.save(update_fields=["status", "result", "error", "updated_at"])
    logger.info("Previous Context computation succeeded job_id=%s", job.job_id)
    return job
