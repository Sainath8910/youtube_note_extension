from unittest.mock import patch

from django.contrib.auth import get_user_model
from rest_framework import status
from rest_framework.test import APITestCase

from knowledge.models import (
    KnowledgeChunk,
    PreviousContextJob,
    PreviousContextJobStatus,
)
from knowledge.serializers import PreviousContextSerializer
from knowledge.services.embeddings import EMBEDDING_DIMENSION
from knowledge.services.previous_context import get_previous_context
from knowledge.services.previous_context_jobs import (
    create_previous_context_job,
    run_previous_context_job,
)
from notes.models import Note
from videos.models import Video, VideoAnalysis


CREATE_JOB_URL = "/api/knowledge/previous-context/jobs/"
JOB_URL = "/api/knowledge/previous-context/jobs/{job_id}/"


class PreviousContextJobsAPITests(APITestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(
            username="previous-context-jobs-api-user",
        )
        self.other_user = get_user_model().objects.create_user(
            username="previous-context-jobs-api-other",
        )
        self.video = Video.objects.create(
            youtube_id="jobapi00001",
            title="Previous Context API video",
        )
        self.client.force_authenticate(self.user)

    @patch("knowledge.services.previous_context_jobs.get_previous_context")
    @patch("knowledge.services.previous_context_jobs.publish_previous_context_job")
    def test_create_job_is_pending_and_does_not_compute_context(
        self,
        publish_job,
        get_context,
    ):
        with self.captureOnCommitCallbacks(execute=True):
            response = self.client.post(
                CREATE_JOB_URL,
                {"youtube_id": self.video.youtube_id},
                format="json",
            )
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        job = PreviousContextJob.objects.get(pk=response.data["job_id"])
        self.assertEqual(response.data["status"], PreviousContextJobStatus.PENDING)
        self.assertEqual(response.data["youtube_id"], self.video.youtube_id)
        self.assertEqual(job.status, PreviousContextJobStatus.PENDING)
        self.assertEqual(job.youtube_id, self.video.youtube_id)
        publish_job.assert_called_once_with(job)
        get_context.assert_not_called()

    def test_create_job_does_not_create_unknown_video(self):
        video_count = Video.objects.count()

        with patch(
            "knowledge.services.previous_context_jobs.publish_previous_context_job"
        ):
            response = self.client.post(
                CREATE_JOB_URL,
                {"youtube_id": "unknown0001"},
                format="json",
            )

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(Video.objects.count(), video_count)
        self.assertFalse(
            PreviousContextJob.objects.get(pk=response.data["job_id"]).video_id
        )

    def test_create_job_requires_authentication_and_valid_youtube_id(self):
        self.client.force_authenticate(user=None)
        response = self.client.post(
            CREATE_JOB_URL,
            {"youtube_id": self.video.youtube_id},
            format="json",
        )
        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)

        self.client.force_authenticate(self.user)
        response = self.client.post(
            CREATE_JOB_URL,
            {"youtube_id": "bad-id"},
            format="json",
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

    def make_job(self, **updates):
        job = create_previous_context_job(
            user=self.user,
            youtube_id=self.video.youtube_id,
        )
        for field, value in updates.items():
            setattr(job, field, value)
        if updates:
            job.save(update_fields=[*updates, "updated_at"])
        return job

    def get_status(self, job):
        return self.client.get(JOB_URL.format(job_id=job.pk))

    @patch("knowledge.services.previous_context_jobs.publish_previous_context_job")
    def test_status_endpoint_returns_pending_and_processing(self, _publish):
        job = self.make_job()

        pending = self.get_status(job)
        self.assertEqual(pending.status_code, status.HTTP_200_OK)
        self.assertEqual(
            pending.data,
            {
                "job_id": str(job.pk),
                "status": PreviousContextJobStatus.PENDING,
                "youtube_id": self.video.youtube_id,
            },
        )

        job.status = PreviousContextJobStatus.PROCESSING
        job.save(update_fields=["status", "updated_at"])
        processing = self.get_status(job)
        self.assertEqual(processing.status_code, status.HTTP_200_OK)
        self.assertEqual(processing.data["status"], "PROCESSING")
        self.assertNotIn("result", processing.data)

    @patch("knowledge.services.previous_context_jobs.publish_previous_context_job")
    def test_status_endpoint_returns_persisted_ready_result(self, _publish):
        job = self.make_job(
            status=PreviousContextJobStatus.READY,
            result={
                "video": {"id": self.video.pk, "youtube_id": self.video.youtube_id},
                "exact": [],
                "related": [],
                "concepts": {
                    "prerequisites": [
                        {
                            "name": "Binary Search",
                            "type": "PREREQUISITE",
                            "has_previous_knowledge": True,
                            "related_count": 1,
                            "reason": "Stored analysis reason.",
                            "evidence": "Stored analysis evidence.",
                            "timestamps": [
                                {
                                    "seconds": 12.5,
                                    "text": "Binary Search is discussed.",
                                }
                            ],
                            "personal_notes": [
                                {
                                    "chunk_id": 17,
                                    "note_id": 9,
                                    "title": "Binary Search notes",
                                    "content": "Personal note content.",
                                    "video_id": None,
                                    "folder_id": None,
                                    "distance": 0.1,
                                    "source": "RELATED_PERSONAL",
                                }
                            ],
                        }
                    ],
                    "upcoming": [],
                },
            },
        )

        response = self.get_status(job)

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data["status"], "READY")
        self.assertEqual(response.data["result"], job.result)

    @patch("knowledge.services.previous_context._get_query_vector")
    def test_ready_job_result_matches_service_and_synchronous_api(
        self,
        get_query_vector,
    ):
        query_vector = [1.0] + [0.0] * (EMBEDDING_DIMENSION - 1)
        get_query_vector.return_value = query_vector
        VideoAnalysis.objects.create(
            video=self.video,
            summary="Binary Search halves a sorted interval.",
            prerequisites=[
                {
                    "name": "Binary Search",
                    "reason": "The video assumes binary search knowledge.",
                },
                " binary   search ",
            ],
            upcoming_topics=[
                {
                    "name": "Search Trees",
                    "reason": "The video says search trees come next.",
                }
            ],
            key_points=[
                {
                    "text": "Binary Search halves the interval.",
                    "start": 12.5,
                }
            ],
        )
        self.video.analysis_status = Video.AnalysisStatus.READY
        self.video.save(update_fields=["analysis_status", "updated_at"])
        note = Note.objects.create(
            user=self.user,
            title="Binary Search notes",
            note_type=Note.NoteType.STANDALONE,
            document={"version": 1, "blocks": []},
        )
        KnowledgeChunk.objects.create(
            user=self.user,
            note=note,
            content="My notes on binary search.",
            content_type=KnowledgeChunk.ContentType.NOTE_BLOCK,
            source_type=KnowledgeChunk.SourceType.NOTE,
            embedding=query_vector,
        )
        job = PreviousContextJob.objects.create(
            user=self.user,
            youtube_id=self.video.youtube_id,
            status=PreviousContextJobStatus.PENDING,
        )

        expected_context = get_previous_context(self.user, self.video)
        expected_result = dict(PreviousContextSerializer(expected_context).data)
        completed_job = run_previous_context_job(str(job.pk))
        self.assertEqual(completed_job.status, PreviousContextJobStatus.READY)
        self.assertEqual(completed_job.result, expected_result)

        job_response = self.get_status(completed_job)
        sync_response = self.client.get(
            "/api/knowledge/previous-context/",
            {"youtube_id": self.video.youtube_id},
        )
        self.assertEqual(job_response.status_code, status.HTTP_200_OK)
        self.assertEqual(sync_response.status_code, status.HTTP_200_OK)
        self.assertEqual(job_response.data["result"], sync_response.data)
        query_texts = [
            call.args[0]
            for call in get_query_vector.call_args_list
        ]
        self.assertEqual(query_texts.count("Binary Search"), 3)
        self.assertEqual(query_texts.count("Search Trees"), 3)
        self.assertEqual(get_query_vector.call_count, 9)

    @patch("knowledge.services.previous_context_jobs.publish_previous_context_job")
    def test_status_endpoint_returns_safe_failure(self, _publish):
        job = self.make_job(
            status=PreviousContextJobStatus.FAILED,
            error="Previous Context computation failed.",
        )

        response = self.get_status(job)

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data["status"], "FAILED")
        self.assertEqual(
            response.data["error"],
            "Previous Context computation failed.",
        )

    @patch("knowledge.services.previous_context_jobs.publish_previous_context_job")
    def test_user_cannot_read_another_users_job(self, _publish):
        job = create_previous_context_job(
            user=self.other_user,
            youtube_id=self.video.youtube_id,
        )

        response = self.get_status(job)

        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)

    def test_missing_job_returns_not_found(self):
        response = self.client.get(
            JOB_URL.format(job_id="00000000-0000-0000-0000-000000000001")
        )

        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)

    @patch("knowledge.services.previous_context_jobs.publish_previous_context_job")
    @patch("knowledge.services.previous_context_jobs.get_previous_context")
    def test_status_poll_does_not_execute_computation(self, get_context, _publish):
        job = self.make_job()

        response = self.get_status(job)

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        get_context.assert_not_called()
