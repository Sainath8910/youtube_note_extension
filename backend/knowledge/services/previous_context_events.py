"""Kafka events emitted when a Previous Context job is committed.

Version 1 contains only the event type/version, persisted job/user/video IDs,
and the YouTube ID. It deliberately excludes content and computed results.
"""

from __future__ import annotations

import json
import threading
from typing import Any

from confluent_kafka import Producer
from django.conf import settings

from knowledge.models import PreviousContextJob

_producer: Producer | None = None
_producer_lock = threading.Lock()


class PreviousContextEventPublishError(RuntimeError):
    """Raised when Kafka does not confirm a Previous Context event."""


def get_producer() -> Producer:
    """Return the process-wide Kafka producer, initializing it on first use."""
    global _producer
    if _producer is None:
        with _producer_lock:
            if _producer is None:
                _producer = Producer(
                    {
                        "bootstrap.servers":
                            settings.KNOWLEDGE_KAFKA_BOOTSTRAP_SERVERS,
                    }
                )
    return _producer


def build_previous_context_job_event(job: PreviousContextJob) -> dict[str, Any]:
    """Build the documented version-1 event from persisted job fields."""
    return {
        "event_type": "previous_context.requested",
        "event_version": 1,
        "job_id": str(job.id),
        "user_id": job.user_id,
        "youtube_id": job.youtube_id,
        "video_id": job.video_id,
    }


def publish_previous_context_job(job: PreviousContextJob) -> None:
    """Publish one job event and wait for Kafka's delivery result."""
    event = build_previous_context_job_event(job)
    value = json.dumps(event).encode("utf-8")
    delivery_errors: list[Exception] = []

    def on_delivery(error: Exception | None, _message: Any) -> None:
        if error is not None:
            delivery_errors.append(error)

    try:
        producer = get_producer()
        producer.produce(
            settings.KNOWLEDGE_PREVIOUS_CONTEXT_KAFKA_TOPIC,
            key=str(job.id).encode("utf-8"),
            value=value,
            callback=on_delivery,
        )
        remaining = producer.flush(timeout=5.0)
        if remaining:
            raise PreviousContextEventPublishError(
                f"Kafka did not confirm Previous Context job event "
                f"job_id={job.id}; {remaining} message(s) remain queued."
            )
        if delivery_errors:
            raise PreviousContextEventPublishError(
                f"Kafka rejected Previous Context job event job_id={job.id}: "
                f"{delivery_errors[0]}"
            ) from delivery_errors[0]
    except PreviousContextEventPublishError:
        raise
    except Exception as exc:
        raise PreviousContextEventPublishError(
            f"Failed to publish Previous Context job event job_id={job.id}: {exc}"
        ) from exc
