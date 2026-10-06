from unittest.mock import patch, MagicMock
import json
import threading
from concurrent.futures import ThreadPoolExecutor

from django.contrib.auth import get_user_model
from django.db import connection, transaction
from django.test import TransactionTestCase

from knowledge.models import PreviousContextJobStatus, PreviousContextJob
from knowledge.services.previous_context import (
    ConceptContext,
    PreviousContext,
)
from knowledge.services.previous_context_jobs import (
    create_previous_context_job,
    get_previous_context_job,
    run_previous_context_job,
)
from knowledge.services.previous_context_events import (
    PreviousContextEventPublishError,
    build_previous_context_job_event,
    publish_previous_context_job,
)
from videos.models import Video


class PreviousContextJobTests(TransactionTestCase):
    def setUp(self):
        publish_patcher = patch(
            "knowledge.services.previous_context_jobs.publish_previous_context_job"
        )
        self.publish_previous_context_job = publish_patcher.start()
        self.addCleanup(publish_patcher.stop)
        self.user = get_user_model().objects.create_user(
            username="previous-context-job-user",
        )
        self.video = Video.objects.create(
            youtube_id="jobvideo001",
            title="Job test video",
        )
        self.context = PreviousContext(
            video_id=self.video.pk,
            youtube_id=self.video.youtube_id,
            exact=(),
            related=(),
            concepts=ConceptContext(prerequisites=(), upcoming=()),
        )

    @patch("knowledge.services.previous_context_jobs.get_previous_context")
    def test_creation_is_pending_and_does_not_compute_context(
        self,
        get_context,
    ):
        job = create_previous_context_job(
            user=self.user,
            youtube_id=self.video.youtube_id,
        )

        self.assertEqual(job.status, PreviousContextJobStatus.PENDING)
        self.assertEqual(job.user_id, self.user.pk)
        self.assertEqual(job.youtube_id, self.video.youtube_id)
        self.assertIsNone(job.result)
        self.assertIsNone(job.error)
        get_context.assert_not_called()

    @patch("knowledge.services.previous_context_jobs.get_previous_context")
    def test_worker_transitions_through_processing_to_ready_and_stores_result(
        self,
        get_context,
    ):
        job = create_previous_context_job(
            user=self.user,
            youtube_id=self.video.youtube_id,
        )
        get_context.return_value = self.context
        observed_statuses = []

        def compute_context(*, user, video):
            observed_statuses.append(
                get_previous_context_job(job.job_id).status
            )
            self.assertEqual(user.pk, self.user.pk)
            self.assertEqual(video.youtube_id, self.video.youtube_id)
            return self.context

        get_context.side_effect = compute_context

        completed = run_previous_context_job(job.job_id)

        self.assertEqual(observed_statuses, [PreviousContextJobStatus.PROCESSING])
        self.assertEqual(completed.status, PreviousContextJobStatus.READY)
        self.assertEqual(
            completed.result,
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
        self.assertIsNone(completed.error)
        get_context.assert_called_once()

    @patch("knowledge.services.previous_context_jobs.get_previous_context")
    def test_worker_marks_job_failed_with_safe_error_when_computation_raises(
        self,
        get_context,
    ):
        job = create_previous_context_job(
            user=self.user,
            youtube_id=self.video.youtube_id,
        )
        get_context.side_effect = RuntimeError("sensitive internal detail")

        failed = run_previous_context_job(job.job_id)

        self.assertEqual(failed.status, PreviousContextJobStatus.FAILED)
        self.assertIsNone(failed.result)
        self.assertEqual(
            failed.error,
            "Previous Context computation failed.",
        )
        self.assertNotIn("sensitive internal detail", failed.error)

    @patch("knowledge.services.previous_context_jobs.get_previous_context")
    def test_running_ready_job_again_does_not_repeat_computation(
        self,
        get_context,
    ):
        job = create_previous_context_job(
            user=self.user,
            youtube_id=self.video.youtube_id,
        )
        get_context.return_value = self.context

        ready = run_previous_context_job(job.job_id)
        rerun = run_previous_context_job(job.job_id)

        self.assertEqual(rerun.id, ready.id)
        self.assertEqual(rerun.status, PreviousContextJobStatus.READY)
        get_context.assert_called_once()

    @patch("knowledge.services.previous_context_jobs.get_previous_context")
    def test_running_processing_job_again_does_not_duplicate_work(
        self,
        get_context,
    ):
        job = create_previous_context_job(
            user=self.user,
            youtube_id=self.video.youtube_id,
        )
        get_context.return_value = self.context

        def compute_context(*, user, video):
            in_progress = run_previous_context_job(job.job_id)
            self.assertEqual(in_progress.id, job.id)
            self.assertEqual(
                in_progress.status,
                PreviousContextJobStatus.PROCESSING,
            )
            return self.context

        get_context.side_effect = compute_context

        completed = run_previous_context_job(job.job_id)

        self.assertEqual(completed.status, PreviousContextJobStatus.READY)
        get_context.assert_called_once()

    @patch("knowledge.services.previous_context_jobs.get_previous_context")
    def test_worker_fails_job_when_user_or_video_cannot_be_resolved(
        self,
        get_context,
    ):
        job = create_previous_context_job(
            user=self.user,
            youtube_id="missingvid01",
        )

        failed = run_previous_context_job(job.job_id)

        self.assertEqual(failed.status, PreviousContextJobStatus.FAILED)
        self.assertEqual(
            failed.error,
            "Previous Context computation failed.",
        )
        get_context.assert_not_called()

    @patch("knowledge.services.previous_context_jobs.get_previous_context")
    def test_concurrent_claiming_prevents_duplicate_work(self, get_context):
        job = create_previous_context_job(
            user=self.user,
            youtube_id=self.video.youtube_id,
        )
        get_context.return_value = self.context

        started_event = threading.Event()
        finish_event = threading.Event()
        
        def slow_compute(*, user, video):
            started_event.set()
            finish_event.wait()
            return self.context

        get_context.side_effect = slow_compute
        
        # We need to manually close database connections for thread pool threads in Django
        def worker():
            try:
                return run_previous_context_job(job.job_id)
            finally:
                connection.close()
                

        with ThreadPoolExecutor(max_workers=2) as executor:
            future1 = executor.submit(worker)
            
            # Wait for first worker to claim the job and reach compute
            started_event.wait()
            
            # Start second worker
            future2 = executor.submit(worker)
            
            import time
            time.sleep(0.5)
            
            # Release slow compute
            finish_event.set()
            
            res1 = future1.result()
            res2 = future2.result()

        # get_context must be called exactly once
        self.assertEqual(get_context.call_count, 1)
        self.assertEqual(res1.status, PreviousContextJobStatus.READY)
        self.assertEqual(res2.status, PreviousContextJobStatus.PROCESSING)

    def test_previous_context_job_event_is_versioned_and_json_serializable(self):
        job = PreviousContextJob.objects.create(
            user=self.user,
            youtube_id=self.video.youtube_id,
            status=PreviousContextJobStatus.PENDING,
        )
        job.video = self.video
        job.save()

        event = build_previous_context_job_event(job)
        payload = json.loads(json.dumps(event))

        self.assertEqual(
            payload,
            {
                "event_type": "previous_context.requested",
                "event_version": 1,
                "job_id": str(job.id),
                "user_id": self.user.id,
                "youtube_id": self.video.youtube_id,
                "video_id": self.video.id,
            },
        )

    @patch("knowledge.services.previous_context_events.get_producer")
    def test_publish_previous_context_job_event_format(self, mock_get_producer):
        from django.conf import settings

        mock_producer = MagicMock()
        mock_producer.flush.return_value = 0
        mock_get_producer.return_value = mock_producer

        job = PreviousContextJob.objects.create(
            user=self.user,
            youtube_id=self.video.youtube_id,
            status=PreviousContextJobStatus.PENDING,
        )
        job.video = self.video
        job.save()

        publish_previous_context_job(job)

        mock_producer.produce.assert_called_once()
        args, kwargs = mock_producer.produce.call_args

        self.assertEqual(args[0], settings.KNOWLEDGE_PREVIOUS_CONTEXT_KAFKA_TOPIC)
        self.assertEqual(kwargs["key"], str(job.id).encode("utf-8"))
        self.assertEqual(
            json.loads(kwargs["value"].decode("utf-8")),
            build_previous_context_job_event(job),
        )
        self.assertTrue(callable(kwargs["callback"]))
        mock_producer.flush.assert_called_once_with(timeout=5.0)

    @patch("knowledge.services.previous_context_events.get_producer")
    def test_previous_context_job_event_has_null_video_id_without_video(
        self,
        mock_get_producer,
    ):
        mock_producer = MagicMock()
        mock_producer.flush.return_value = 0
        mock_get_producer.return_value = mock_producer
        job = PreviousContextJob.objects.create(
            user=self.user,
            youtube_id=self.video.youtube_id,
            status=PreviousContextJobStatus.PENDING,
        )

        publish_previous_context_job(job)

        payload = json.loads(mock_producer.produce.call_args.kwargs["value"])
        self.assertIsNone(payload["video_id"])

    @patch("knowledge.services.previous_context_events.get_producer")
    def test_publisher_raises_when_produce_fails(self, mock_get_producer):
        mock_producer = MagicMock()
        mock_producer.produce.side_effect = RuntimeError("broker unavailable")
        mock_get_producer.return_value = mock_producer
        job = PreviousContextJob.objects.create(
            user=self.user,
            youtube_id=self.video.youtube_id,
            status=PreviousContextJobStatus.PENDING,
        )

        with self.assertRaisesRegex(
            PreviousContextEventPublishError,
            "broker unavailable",
        ):
            publish_previous_context_job(job)

    @patch("knowledge.services.previous_context_events.get_producer")
    def test_publisher_raises_when_delivery_is_rejected(self, mock_get_producer):
        mock_producer = MagicMock()

        def flush_with_delivery_error(*, timeout):
            callback = mock_producer.produce.call_args.kwargs["callback"]
            callback(RuntimeError("delivery rejected"), None)
            return 0

        mock_producer.flush.side_effect = flush_with_delivery_error
        mock_get_producer.return_value = mock_producer
        job = PreviousContextJob.objects.create(
            user=self.user,
            youtube_id=self.video.youtube_id,
            status=PreviousContextJobStatus.PENDING,
        )

        with self.assertRaisesRegex(
            PreviousContextEventPublishError,
            "delivery rejected",
        ):
            publish_previous_context_job(job)

    @patch("knowledge.services.previous_context_jobs.publish_previous_context_job")
    def test_job_creation_triggers_publication_on_commit(self, mock_publish):
        with transaction.atomic():
            job = create_previous_context_job(
                user=self.user,
                youtube_id=self.video.youtube_id,
            )
            mock_publish.assert_not_called()

        mock_publish.assert_called_once_with(job)
        persisted = PreviousContextJob.objects.get(id=job.id)
        self.assertEqual(persisted.status, PreviousContextJobStatus.PENDING)

    @patch("knowledge.services.previous_context_jobs.publish_previous_context_job")
    def test_job_creation_does_not_publish_on_rollback(self, mock_publish):
        try:
            with transaction.atomic():
                job = create_previous_context_job(
                    user=self.user,
                    youtube_id=self.video.youtube_id,
                )
                raise ValueError("Abort transaction")
        except ValueError:
            pass

        mock_publish.assert_not_called()
        self.assertFalse(
            PreviousContextJob.objects.filter(
                youtube_id=self.video.youtube_id,
            ).exists()
        )

    @patch("knowledge.services.previous_context_jobs.publish_previous_context_job")
    def test_job_remains_pending_when_publication_fails(self, mock_publish):
        mock_publish.side_effect = PreviousContextEventPublishError("Kafka down")

        job = create_previous_context_job(
            user=self.user,
            youtube_id=self.video.youtube_id,
        )

        db_job = PreviousContextJob.objects.get(id=job.id)
        self.assertEqual(db_job.status, PreviousContextJobStatus.PENDING)
