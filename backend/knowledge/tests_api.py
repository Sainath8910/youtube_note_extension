from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.test import override_settings
from rest_framework import status
from rest_framework.test import APITestCase

from folders.models import Folder
from knowledge.services.context import RAGContextItem
from knowledge.services.generation import RAGAnswer, RAGGenerationError
from knowledge.services.retrieval import KnowledgeRetrievalError, RetrievalScope
from videos.models import Video


ASK_URL = "/api/knowledge/ask/"


class KnowledgeAskAPITests(APITestCase):
    def setUp(self):
        user_model = get_user_model()
        self.user = user_model.objects.create_user(username="ask-api-user")
        self.other_user = user_model.objects.create_user(
            username="ask-api-other-user"
        )
        self.client.force_authenticate(self.user)
        self.answer = RAGAnswer(
            answer="Binary search repeatedly divides the search space.",
            sources=(),
        )

    def personal_kb_payload(self, **overrides):
        payload = {
            "question": "What is binary search?",
            "scope": "PERSONAL_KB",
        }
        payload.update(overrides)
        return payload

    @patch("knowledge.views.answer_question")
    def test_personal_kb_request_passes_user_and_request(self, answer_question):
        answer_question.return_value = self.answer

        response = self.client.post(
            ASK_URL,
            self.personal_kb_payload(top_k=5),
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data["answer"], self.answer.answer)
        self.assertEqual(response.data["sources"], [])
        answer_question.assert_called_once()
        kwargs = answer_question.call_args.kwargs
        self.assertIs(kwargs["user"], self.user)
        self.assertEqual(kwargs["question"], "What is binary search?")
        self.assertEqual(kwargs["top_k"], 5)
        request = kwargs["request"]
        self.assertIs(request.user, self.user)
        self.assertEqual(request.query, "What is binary search?")
        self.assertEqual(request.scope, RetrievalScope.PERSONAL_KB)
        self.assertIsNone(request.video)
        self.assertIsNone(request.folder)

    @patch("knowledge.views.answer_question")
    def test_current_video_uses_resolved_video(self, answer_question):
        answer_question.return_value = self.answer
        video = Video.objects.create(youtube_id="askvideo001")

        response = self.client.post(
            ASK_URL,
            {
                "question": "Explain this video",
                "scope": "CURRENT_VIDEO",
                "youtube_id": video.youtube_id,
            },
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        request = answer_question.call_args.kwargs["request"]
        self.assertEqual(request.video.pk, video.pk)
        self.assertEqual(request.scope, RetrievalScope.CURRENT_VIDEO)
        self.assertIsNone(request.folder)

    @patch("knowledge.views.answer_question")
    def test_combined_scope_resolves_optional_video_and_owned_folder(
        self,
        answer_question,
    ):
        answer_question.return_value = self.answer
        video = Video.objects.create(youtube_id="combinedvideo1")
        folder = Folder.objects.create(user=self.user, name="Combined folder")

        response = self.client.post(
            ASK_URL,
            {
                "question": "Combine my knowledge",
                "scope": "COMBINED",
                "youtube_id": video.youtube_id,
                "folder_id": folder.pk,
            },
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        request = answer_question.call_args.kwargs["request"]
        self.assertEqual(request.scope, RetrievalScope.COMBINED)
        self.assertEqual(request.video.pk, video.pk)
        self.assertEqual(request.folder.pk, folder.pk)

    @patch("knowledge.views.answer_question")
    def test_combined_scope_can_omit_context(self, answer_question):
        answer_question.return_value = self.answer

        response = self.client.post(
            ASK_URL,
            {
                "question": "Use my personal knowledge",
                "scope": "COMBINED",
            },
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        request = answer_question.call_args.kwargs["request"]
        self.assertEqual(request.scope, RetrievalScope.COMBINED)
        self.assertIsNone(request.video)
        self.assertIsNone(request.folder)

    @patch("knowledge.views.answer_question")
    def test_missing_current_video_returns_404(self, answer_question):
        response = self.client.post(
            ASK_URL,
            {
                "question": "Explain this video",
                "scope": "CURRENT_VIDEO",
                "youtube_id": "absent00001",
            },
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)
        answer_question.assert_not_called()

    @patch("knowledge.views.answer_question")
    def test_current_folder_uses_exact_owned_folder(self, answer_question):
        answer_question.return_value = self.answer
        folder = Folder.objects.create(user=self.user, name="My folder")

        response = self.client.post(
            ASK_URL,
            {
                "question": "Explain my notes",
                "scope": "CURRENT_FOLDER",
                "folder_id": folder.pk,
            },
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        request = answer_question.call_args.kwargs["request"]
        self.assertEqual(request.folder.pk, folder.pk)
        self.assertEqual(request.scope, RetrievalScope.CURRENT_FOLDER)
        self.assertIsNone(request.video)

    @patch("knowledge.views.answer_question")
    def test_foreign_folder_returns_indistinguishable_404(self, answer_question):
        folder = Folder.objects.create(
            user=self.other_user,
            name="Private folder",
        )

        response = self.client.post(
            ASK_URL,
            {
                "question": "Explain my notes",
                "scope": "CURRENT_FOLDER",
                "folder_id": folder.pk,
            },
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)
        self.assertEqual(response.data["detail"], "Not found.")
        self.assertNotIn(folder.name, str(response.data))
        answer_question.assert_not_called()

        missing_response = self.client.post(
            ASK_URL,
            {
                "question": "Explain my notes",
                "scope": "CURRENT_FOLDER",
                "folder_id": folder.pk + 1000,
            },
            format="json",
        )
        self.assertEqual(missing_response.status_code, status.HTTP_404_NOT_FOUND)
        self.assertEqual(missing_response.data, response.data)

    @patch("knowledge.views.answer_question")
    def test_current_folder_without_folder_id_returns_400(self, answer_question):
        response = self.client.post(
            ASK_URL,
            {"question": "Question", "scope": "CURRENT_FOLDER"},
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        answer_question.assert_not_called()

    @patch("knowledge.views.answer_question")
    def test_invalid_scope_returns_400(self, answer_question):
        response = self.client.post(
            ASK_URL,
            self.personal_kb_payload(scope="OTHER"),
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        answer_question.assert_not_called()

    @patch("knowledge.views.answer_question")
    def test_missing_question_returns_400(self, answer_question):
        response = self.client.post(
            ASK_URL,
            {"scope": "PERSONAL_KB"},
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        answer_question.assert_not_called()

    @patch("knowledge.views.answer_question")
    def test_blank_question_returns_400(self, answer_question):
        response = self.client.post(
            ASK_URL,
            self.personal_kb_payload(question="  \n "),
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        answer_question.assert_not_called()

    @patch("knowledge.views.answer_question")
    def test_invalid_top_k_values_return_400(self, answer_question):
        for top_k in (0, -1, "five"):
            with self.subTest(top_k=top_k):
                response = self.client.post(
                    ASK_URL,
                    self.personal_kb_payload(top_k=top_k),
                    format="json",
                )
                self.assertEqual(
                    response.status_code,
                    status.HTTP_400_BAD_REQUEST,
                )
        answer_question.assert_not_called()

    @patch("knowledge.views.answer_question")
    def test_default_top_k_is_five(self, answer_question):
        answer_question.return_value = self.answer

        response = self.client.post(
            ASK_URL,
            self.personal_kb_payload(),
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(answer_question.call_args.kwargs["top_k"], 5)

    @patch("knowledge.views.answer_question")
    def test_empty_rag_result_is_success_with_empty_sources(self, answer_question):
        answer_question.return_value = RAGAnswer(
            answer="I don't have enough information in your knowledge base.",
            sources=(),
        )

        response = self.client.post(
            ASK_URL,
            self.personal_kb_payload(),
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data["sources"], [])
        self.assertEqual(
            response.data["answer"],
            "I don't have enough information in your knowledge base.",
        )

    @patch("knowledge.views.answer_question")
    def test_generation_error_returns_safe_502(self, answer_question):
        answer_question.side_effect = RAGGenerationError(
            "provider secret payload"
        )

        response = self.client.post(
            ASK_URL,
            self.personal_kb_payload(),
            format="json",
        )

        self.assertEqual(
            response.status_code,
            status.HTTP_502_BAD_GATEWAY,
        )
        self.assertEqual(
            response.data,
            {"detail": "The AI service could not generate an answer."},
        )
        self.assertNotIn("provider secret", str(response.data))

    @patch("knowledge.views.answer_question")
    def test_retrieval_error_returns_safe_bad_request(self, answer_question):
        answer_question.side_effect = KnowledgeRetrievalError(
            "internal retrieval details"
        )

        response = self.client.post(
            ASK_URL,
            self.personal_kb_payload(),
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertNotIn("internal retrieval details", str(response.data))

    @patch("knowledge.views.answer_question")
    def test_authentication_is_required(self, answer_question):
        self.client.force_authenticate(user=None)

        response = self.client.post(
            ASK_URL,
            self.personal_kb_payload(),
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)
        answer_question.assert_not_called()

    @patch("knowledge.views.answer_question")
    def test_response_preserves_all_source_fields_and_order(self, answer_question):
        answer_question.return_value = RAGAnswer(
            answer="Grounded answer",
            sources=(
                RAGContextItem(
                    chunk_id=101,
                    content="First source content",
                    distance=0.123456,
                    note_id=21,
                    video_id=31,
                    folder_id=41,
                    source_block_id="block-first",
                    chunk_index=2,
                    metadata={"position": "first", "nested": {"ok": True}},
                ),
                RAGContextItem(
                    chunk_id=102,
                    content="Second source content",
                    distance=0.654321,
                    note_id=None,
                    video_id=32,
                    folder_id=None,
                    source_block_id=None,
                    chunk_index=7,
                    metadata={"position": "second"},
                ),
            ),
        )

        response = self.client.post(
            ASK_URL,
            self.personal_kb_payload(),
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data["sources"], [
            {
                "chunk_id": 101,
                "content": "First source content",
                "distance": 0.123456,
                "note_id": 21,
                "video_id": 31,
                "folder_id": 41,
                "source_block_id": "block-first",
                "chunk_index": 2,
                "metadata": {"position": "first", "nested": {"ok": True}},
            },
            {
                "chunk_id": 102,
                "content": "Second source content",
                "distance": 0.654321,
                "note_id": None,
                "video_id": 32,
                "folder_id": None,
                "source_block_id": None,
                "chunk_index": 7,
                "metadata": {"position": "second"},
            },
        ])

    @override_settings(DEBUG=True)
    @patch("knowledge.views.answer_question")
    def test_dev_header_authentication_is_supported(self, answer_question):
        answer_question.return_value = self.answer
        self.client.force_authenticate(user=None)

        response = self.client.post(
            ASK_URL,
            self.personal_kb_payload(),
            format="json",
            HTTP_X_DEV_USER=self.user.username,
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
