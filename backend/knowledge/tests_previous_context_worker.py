import json
import signal
import uuid
from unittest.mock import MagicMock, patch

from django.contrib.auth import get_user_model
from django.test import TestCase, override_settings

from knowledge.management.commands.run_previous_context_worker import (
    Command,
    InvalidPreviousContextEvent,
    handle_previous_context_event,
    parse_previous_context_event,
)
from knowledge.models import PreviousContextJob, PreviousContextJobStatus
from knowledge.services.previous_context import ConceptContext, PreviousContext
from knowledge.services.previous_context_events import (
    build_previous_context_job_event,
)
from knowledge.services.previous_context_jobs import create_previous_context_job
from videos.models import Video


class PreviousContextWorkerTests(TestCase):
    def setUp(self):
        publisher = patch(
            "knowledge.services.previous_context_jobs.publish_previous_context_job"
        )
        self.publish_job = publisher.start()
        self.addCleanup(publisher.stop)

        self.user = get_user_model().objects.create_user(
            username="previous-context-worker-user",
        )
        self.video = Video.objects.create(
            youtube_id="worker-video-001",
            title="Worker test video",
        )
        self.context = PreviousContext(
            video_id=self.video.pk,
            youtube_id=self.video.youtube_id,
            exact=(),
            related=(),
            concepts=ConceptContext(prerequisites=(), upcoming=()),
        )
        self.command = Command()

    def create_job(self):
        return create_previous_context_job(
            user=self.user,
            youtube_id=self.video.youtube_id,
        )

    def message_for(self, event):
        message = MagicMock()
        message.value.return_value = json.dumps(event).encode("utf-8")
        return message

    def process(self, event, consumer=None):
        consumer = consumer or MagicMock()
        message = self.message_for(event)
        self.command._process_message(consumer, message)
        consumer.commit.assert_called_once_with(
            message=message,
            asynchronous=False,
        )
        return consumer, message

    def test_valid_event_is_decoded_and_validated(self):
        job = self.create_job()
        value = json.dumps(build_previous_context_job_event(job)).encode("utf-8")

        event = parse_previous_context_event(value)

        self.assertEqual(event["event_type"], "previous_context.requested")
        self.assertEqual(event["event_version"], 1)
        self.assertEqual(event["job_id"], str(job.id))
        self.assertEqual(event["user_id"], self.user.pk)
        self.assertEqual(event["youtube_id"], self.video.youtube_id)
        self.assertIsNone(event["video_id"])

    def test_malformed_events_are_safely_committed_without_computation(self):
        job = self.create_job()
        valid_event = build_previous_context_job_event(job)
        invalid_events = [
            b"{invalid json",
            b"\xff",
            json.dumps({**valid_event, "event_type": "unknown"}).encode("utf-8"),
            json.dumps({**valid_event, "event_version": 2}).encode("utf-8"),
            json.dumps(
                {key: value for key, value in valid_event.items() if key != "user_id"}
            ).encode("utf-8"),
        ]

        with patch(
            "knowledge.services.previous_context_jobs.get_previous_context"
        ) as get_context:
            for value in invalid_events:
                with self.subTest(value=value):
                    consumer = MagicMock()
                    message = MagicMock()
                    message.value.return_value = value

                    self.command._process_message(consumer, message)

                    consumer.commit.assert_called_once_with(
                        message=message,
                        asynchronous=False,
                    )
            get_context.assert_not_called()

        with self.assertRaises(InvalidPreviousContextEvent):
            parse_previous_context_event(b"[]")

    def test_orphan_event_is_committed_without_computation(self):
        event = {
            "event_type": "previous_context.requested",
            "event_version": 1,
            "job_id": str(uuid.uuid4()),
            "user_id": self.user.pk,
            "youtube_id": self.video.youtube_id,
            "video_id": None,
        }

        with patch(
            "knowledge.services.previous_context_jobs.get_previous_context"
        ) as get_context:
            self.process(event)

        get_context.assert_not_called()

    def test_event_identity_must_match_persisted_job(self):
        job = self.create_job()
        event = build_previous_context_job_event(job)
        event["youtube_id"] = "different-video"

        with patch(
            "knowledge.services.previous_context_jobs.get_previous_context"
        ) as get_context:
            self.process(event)

        job.refresh_from_db()
        self.assertEqual(job.status, PreviousContextJobStatus.PENDING)
        get_context.assert_not_called()

    def test_pending_job_is_processed_and_committed_after_ready(self):
        job = self.create_job()
        event = build_previous_context_job_event(job)
        observed_statuses = []

        def compute(*, user, video):
            current = PreviousContextJob.objects.get(pk=job.pk)
            observed_statuses.append(current.status)
            self.assertEqual(user.pk, self.user.pk)
            self.assertEqual(video.youtube_id, self.video.youtube_id)
            return self.context

        def commit_after_handling(*, message, asynchronous):
            current = PreviousContextJob.objects.get(pk=job.pk)
            self.assertEqual(current.status, PreviousContextJobStatus.READY)
            self.assertIsNotNone(current.result)
            self.assertIsNone(current.error)
            return []

        consumer = MagicMock()
        consumer.commit.side_effect = commit_after_handling
        with patch(
            "knowledge.services.previous_context_jobs.get_previous_context",
            side_effect=compute,
        ) as get_context:
            self.command._process_message(consumer, self.message_for(event))

        job.refresh_from_db()
        self.assertEqual(observed_statuses, [PreviousContextJobStatus.PROCESSING])
        self.assertEqual(job.status, PreviousContextJobStatus.READY)
        self.assertEqual(
            job.result,
            {
                "video": {
                    "id": self.video.pk,
                    "youtube_id": self.video.youtube_id,
                },
                "exact": [],
                "related": [],
                "concepts": {
                    "prerequisites": [],
                    "upcoming": [],
                },
            },
        )
        self.assertIsNone(job.error)
        get_context.assert_called_once()
        consumer.commit.assert_called_once()

    def test_failed_job_is_safely_stored_committed_and_not_retried(self):
        job = self.create_job()
        event = build_previous_context_job_event(job)

        with patch(
            "knowledge.services.previous_context_jobs.get_previous_context",
            side_effect=RuntimeError("sensitive internal detail"),
        ) as get_context:
            self.process(event)
            self.process(event)

        job.refresh_from_db()
        self.assertEqual(job.status, PreviousContextJobStatus.FAILED)
        self.assertEqual(
            job.error,
            "Previous Context computation failed.",
        )
        self.assertNotIn("sensitive internal detail", job.error)
        get_context.assert_called_once()

    def test_processing_ready_and_failed_jobs_are_not_executed_again(self):
        job = self.create_job()
        event = build_previous_context_job_event(job)

        for status in (
            PreviousContextJobStatus.PROCESSING,
            PreviousContextJobStatus.READY,
            PreviousContextJobStatus.FAILED,
        ):
            with self.subTest(status=status):
                job.status = status
                job.result = {"existing": status}
                job.error = "existing error"
                job.save(update_fields=["status", "result", "error"])

                with patch(
                    "knowledge.services.previous_context_jobs.get_previous_context"
                ) as get_context:
                    self.process(event)

                job.refresh_from_db()
                self.assertEqual(job.status, status)
                self.assertEqual(job.result, {"existing": status})
                self.assertEqual(job.error, "existing error")
                get_context.assert_not_called()

    def test_duplicate_successful_delivery_does_not_compute_twice(self):
        job = self.create_job()
        event = build_previous_context_job_event(job)

        with patch(
            "knowledge.services.previous_context_jobs.get_previous_context",
            return_value=self.context,
        ) as get_context:
            self.process(event)
            self.process(event)

        self.assertEqual(get_context.call_count, 1)
        job.refresh_from_db()
        self.assertEqual(job.status, PreviousContextJobStatus.READY)

    @override_settings(
        KNOWLEDGE_KAFKA_BOOTSTRAP_SERVERS="localhost:19092",
        KNOWLEDGE_PREVIOUS_CONTEXT_KAFKA_TOPIC="worker-test-topic",
        KNOWLEDGE_PREVIOUS_CONTEXT_KAFKA_GROUP="worker-test-group",
    )
    @patch("knowledge.management.commands.run_previous_context_worker.signal.signal")
    @patch(
        "knowledge.management.commands.run_previous_context_worker.signal.getsignal",
        return_value=signal.SIG_DFL,
    )
    @patch("knowledge.management.commands.run_previous_context_worker.Consumer")
    def test_worker_configuration_and_keyboard_shutdown(
        self,
        mock_consumer_class,
        _getsignal,
        _signal,
    ):
        consumer = mock_consumer_class.return_value
        consumer.poll.side_effect = [None, KeyboardInterrupt]

        self.command.handle()

        mock_consumer_class.assert_called_once_with(
            {
                "bootstrap.servers": "localhost:19092",
                "group.id": "worker-test-group",
                "auto.offset.reset": "earliest",
                "enable.auto.commit": False,
            }
        )
        consumer.subscribe.assert_called_once_with(["worker-test-topic"])
        consumer.close.assert_called_once()
