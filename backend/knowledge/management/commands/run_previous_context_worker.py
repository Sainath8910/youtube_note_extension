from __future__ import annotations

import json
import logging
import signal
import uuid
from typing import Any

from confluent_kafka import Consumer
from django.conf import settings
from django.core.management.base import BaseCommand

from knowledge.models import PreviousContextJob, PreviousContextJobStatus
from knowledge.services.previous_context_jobs import run_previous_context_job

logger = logging.getLogger(__name__)

_EVENT_TYPE = "previous_context.requested"
_EVENT_VERSION = 1
_REQUIRED_FIELDS = {
    "event_type",
    "event_version",
    "job_id",
    "user_id",
    "youtube_id",
    "video_id",
}


class InvalidPreviousContextEvent(ValueError):
    """The Kafka payload is not a supported Previous Context request."""


def parse_previous_context_event(value: bytes | None) -> dict[str, Any]:
    """Decode and validate the versioned B2 event contract."""
    if not isinstance(value, bytes):
        raise InvalidPreviousContextEvent("message value is not UTF-8 bytes")

    try:
        event = json.loads(value.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise InvalidPreviousContextEvent("message value is not valid UTF-8 JSON") from exc

    if not isinstance(event, dict):
        raise InvalidPreviousContextEvent("event must be a JSON object")
    missing_fields = _REQUIRED_FIELDS.difference(event)
    if missing_fields:
        raise InvalidPreviousContextEvent(
            f"event is missing required field(s): {', '.join(sorted(missing_fields))}"
        )
    if event["event_type"] != _EVENT_TYPE:
        raise InvalidPreviousContextEvent("unsupported event_type")
    if (
        isinstance(event["event_version"], bool)
        or not isinstance(event["event_version"], int)
        or event["event_version"] != _EVENT_VERSION
    ):
        raise InvalidPreviousContextEvent("unsupported event_version")
    if not isinstance(event["job_id"], str):
        raise InvalidPreviousContextEvent("job_id must be a UUID string")
    try:
        event["job_id"] = str(uuid.UUID(event["job_id"]))
    except (ValueError, AttributeError) as exc:
        raise InvalidPreviousContextEvent("job_id must be a UUID string") from exc
    if isinstance(event["user_id"], bool) or not isinstance(event["user_id"], int):
        raise InvalidPreviousContextEvent("user_id must be an integer")
    if not isinstance(event["youtube_id"], str) or not event["youtube_id"].strip():
        raise InvalidPreviousContextEvent("youtube_id must be a non-empty string")
    video_id = event["video_id"]
    if video_id is not None and (
        isinstance(video_id, bool) or not isinstance(video_id, int)
    ):
        raise InvalidPreviousContextEvent("video_id must be an integer or null")

    return event


def handle_previous_context_event(event: dict[str, Any]) -> PreviousContextJob | None:
    """Treat the event as a pointer and use the PostgreSQL job as authority."""
    job = (
        PreviousContextJob.objects.filter(pk=event["job_id"])
        .select_related("user")
        .first()
    )
    if job is None:
        logger.warning(
            "Previous Context Kafka event references a missing job job_id=%s",
            event["job_id"],
        )
        return None

    if (
        job.user_id != event["user_id"]
        or job.youtube_id != event["youtube_id"]
        or job.video_id != event["video_id"]
    ):
        logger.warning(
            "Previous Context Kafka event identity does not match persisted job "
            "job_id=%s",
            job.job_id,
        )
        return job

    if job.status != PreviousContextJobStatus.PENDING:
        logger.info(
            "Previous Context job already handled; skipping job_id=%s status=%s",
            job.job_id,
            job.status,
        )
        return job

    logger.info("Claiming Previous Context job job_id=%s", job.job_id)
    try:
        job = run_previous_context_job(job.job_id)
    except KeyError:
        logger.warning(
            "Previous Context job disappeared before it could be claimed "
            "job_id=%s",
            event["job_id"],
        )
        return None

    if job.status == PreviousContextJobStatus.READY:
        logger.info("Previous Context computation succeeded job_id=%s", job.job_id)
    elif job.status == PreviousContextJobStatus.FAILED:
        logger.warning(
            "Previous Context computation failed job_id=%s error=%s",
            job.job_id,
            job.error,
        )
    else:
        logger.info(
            "Previous Context job was claimed by another worker; "
            "skipping job_id=%s status=%s",
            job.job_id,
            job.status,
        )
    return job


class Command(BaseCommand):
    help = "Consume Kafka requests and execute persisted Previous Context jobs."

    def _process_message(self, consumer: Consumer, message: Any) -> None:
        logger.info("Received Previous Context Kafka message")
        job_id = "unknown"
        try:
            event = parse_previous_context_event(message.value())
        except InvalidPreviousContextEvent as exc:
            logger.warning("Ignoring malformed Previous Context event: %s", exc)
        else:
            job_id = event["job_id"]
            handle_previous_context_event(event)

        try:
            committed_offsets = consumer.commit(
                message=message,
                asynchronous=False,
            )
        except Exception:
            logger.exception(
                "Failed to commit Previous Context Kafka offset job_id=%s",
                job_id,
            )
            raise
        for partition in committed_offsets or ():
            error = getattr(partition, "error", None)
            if error is not None:
                raise RuntimeError(
                    f"Failed to commit Previous Context Kafka offset "
                    f"job_id={job_id}: {error}"
                )
        logger.info(
            "Committed Previous Context Kafka offset job_id=%s",
            job_id,
        )

    def handle(self, *args: Any, **options: Any) -> None:
        consumer = Consumer(
            {
                "bootstrap.servers": settings.KNOWLEDGE_KAFKA_BOOTSTRAP_SERVERS,
                "group.id": settings.KNOWLEDGE_PREVIOUS_CONTEXT_KAFKA_GROUP,
                "auto.offset.reset": "earliest",
                "enable.auto.commit": False,
            }
        )
        stop_requested = False
        previous_handlers: dict[int, Any] = {}

        def request_stop(signum: int, _frame: Any) -> None:
            nonlocal stop_requested
            stop_requested = True
            logger.info("Previous Context worker received shutdown signal=%s", signum)

        try:
            for signum in (signal.SIGINT, signal.SIGTERM):
                previous_handlers[signum] = signal.getsignal(signum)
                signal.signal(signum, request_stop)

            consumer.subscribe([settings.KNOWLEDGE_PREVIOUS_CONTEXT_KAFKA_TOPIC])
            logger.info(
                "Previous Context worker started topic=%s group=%s",
                settings.KNOWLEDGE_PREVIOUS_CONTEXT_KAFKA_TOPIC,
                settings.KNOWLEDGE_PREVIOUS_CONTEXT_KAFKA_GROUP,
            )
            while not stop_requested:
                message = consumer.poll(timeout=1.0)
                if message is None:
                    continue
                if message.error():
                    logger.error(
                        "Kafka consumer returned an error; message was not committed: %s",
                        message.error(),
                    )
                    continue
                self._process_message(consumer, message)
        except KeyboardInterrupt:
            logger.info("Previous Context worker interrupted")
        finally:
            try:
                consumer.close()
            finally:
                for signum, handler in previous_handlers.items():
                    signal.signal(signum, handler)
                logger.info("Previous Context worker stopped")
