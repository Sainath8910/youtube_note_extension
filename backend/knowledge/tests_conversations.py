import json
from unittest.mock import patch

from django.contrib.auth import get_user_model
from rest_framework import status
from rest_framework.test import APITestCase

from knowledge.models import Conversation, ConversationMessage
from knowledge.services.context import RAGContextItem
from knowledge.services.generation import RAGAnswer, RAGGenerationError
from knowledge.services.retrieval import (
    KnowledgeContextAccessError,
    RetrievalScope,
)
from videos.models import Video


CONVERSATIONS_URL = "/api/knowledge/conversations/"


class KnowledgeConversationAPITests(APITestCase):
    def setUp(self):
        user_model = get_user_model()
        self.user = user_model.objects.create_user(username="conversation-user")
        self.other_user = user_model.objects.create_user(
            username="conversation-other-user"
        )
        self.client.force_authenticate(self.user)
        self.personal_conversation = Conversation.objects.create(
            user=self.user,
            title="Personal learning",
            scope=Conversation.Scope.PERSONAL_KB,
        )
        self.other_conversation = Conversation.objects.create(
            user=self.other_user,
            title="Private conversation",
            scope=Conversation.Scope.PERSONAL_KB,
        )
        self.answer = RAGAnswer(
            answer="The answer is grounded in your knowledge.",
            sources=(),
        )

    def conversation_url(self, conversation):
        return f"{CONVERSATIONS_URL}{conversation.pk}/"

    def ask_url(self, conversation):
        return f"{self.conversation_url(conversation)}ask/"

    def test_create_personal_conversation_without_video(self):
        response = self.client.post(
            CONVERSATIONS_URL,
            {
                "title": "My first question",
                "scope": "PERSONAL_KB",
            },
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        conversation = Conversation.objects.get(pk=response.data["id"])
        self.assertEqual(conversation.user, self.user)
        self.assertEqual(conversation.scope, Conversation.Scope.PERSONAL_KB)
        self.assertIsNone(conversation.youtube_id)

    def test_create_current_video_and_combined_conversations(self):
        for scope in ("CURRENT_VIDEO", "COMBINED"):
            with self.subTest(scope=scope):
                response = self.client.post(
                    CONVERSATIONS_URL,
                    {
                        "scope": scope,
                        "youtube_id": "video123456",
                    },
                    format="json",
                )

                self.assertEqual(response.status_code, status.HTTP_201_CREATED)
                self.assertEqual(response.data["scope"], scope)
                self.assertEqual(response.data["youtube_id"], "video123456")

    def test_invalid_or_missing_video_context_is_rejected(self):
        for payload in (
            {"scope": "CURRENT_VIDEO"},
            {"scope": "COMBINED", "youtube_id": None},
            {"scope": "CURRENT_VIDEO", "youtube_id": "17"},
            {
                "scope": "PERSONAL_KB",
                "youtube_id": "videoId12345",
            },
        ):
            with self.subTest(payload=payload):
                response = self.client.post(
                    CONVERSATIONS_URL,
                    payload,
                    format="json",
                )
                self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

    def test_unsupported_scope_is_rejected(self):
        response = self.client.post(
            CONVERSATIONS_URL,
            {"scope": "CURRENT_FOLDER"},
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

    def test_list_contains_only_authenticated_users_conversations(self):
        response = self.client.get(CONVERSATIONS_URL)

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(
            [item["id"] for item in response.data],
            [self.personal_conversation.pk],
        )
        self.assertNotIn("Private conversation", str(response.data))

    def test_owner_can_retrieve_ordered_messages(self):
        user_message = ConversationMessage.objects.create(
            conversation=self.personal_conversation,
            role=ConversationMessage.Role.USER,
            content="Question",
        )
        assistant_message = ConversationMessage.objects.create(
            conversation=self.personal_conversation,
            role=ConversationMessage.Role.ASSISTANT,
            content="Answer",
            sources=[],
        )

        response = self.client.get(
            self.conversation_url(self.personal_conversation)
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(
            [message["id"] for message in response.data["messages"]],
            [user_message.pk, assistant_message.pk],
        )

    def test_detail_serializes_persisted_messages_for_extension_contract(self):
        create_response = self.client.post(
            CONVERSATIONS_URL,
            {"title": "Persisted conversation", "scope": "PERSONAL_KB"},
            format="json",
        )
        self.assertEqual(create_response.status_code, status.HTTP_201_CREATED)
        conversation = Conversation.objects.get(pk=create_response.data["id"])
        ConversationMessage.objects.create(
            conversation=conversation,
            role=ConversationMessage.Role.USER,
            content="What did I learn?",
        )
        sources = [
            {
                "chunk_id": 9,
                "content": "Transcript excerpt",
                "note_id": None,
                "video_id": 4,
                "folder_id": None,
                "source_block_id": None,
                "chunk_index": 3,
                "metadata": {
                    "source_type": "VIDEO_TRANSCRIPT",
                    "start_seconds": 12.5,
                    "end_seconds": 18.0,
                },
                "youtube_id": "video123456",
            },
            {
                "chunk_id": 10,
                "content": "Legacy transcript excerpt",
                "note_id": None,
                "video_id": 5,
                "folder_id": None,
                "source_block_id": None,
                "chunk_index": 4,
                "metadata": {
                    "source_type": "VIDEO_TRANSCRIPT",
                    "start_seconds": 22.0,
                    "end_seconds": 27.0,
                },
                "youtube_id": "video12345",
            },
        ]
        ConversationMessage.objects.create(
            conversation=conversation,
            role=ConversationMessage.Role.ASSISTANT,
            content="A persisted answer.",
            sources=sources,
        )

        response = self.client.get(self.conversation_url(conversation))

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        payload = response.json()
        self.assertEqual(
            set(payload),
            {
                "id",
                "title",
                "scope",
                "youtube_id",
                "created_at",
                "updated_at",
                "messages",
            },
        )
        self.assertEqual(len(payload["messages"]), 2)
        self.assertIsInstance(payload["id"], int)
        self.assertIsInstance(payload["created_at"], str)
        self.assertIsInstance(payload["updated_at"], str)
        for message in payload["messages"]:
            self.assertEqual(
                set(message),
                {"id", "role", "content", "sources", "created_at"},
            )
            self.assertIsInstance(message["id"], int)
            self.assertIsInstance(message["created_at"], str)
            self.assertIsInstance(message["sources"], list)

        user_message, assistant_message = payload["messages"]
        self.assertEqual(user_message["role"], "USER")
        self.assertEqual(user_message["sources"], [])
        self.assertEqual(assistant_message["role"], "ASSISTANT")
        self.assertEqual(assistant_message["content"], "A persisted answer.")
        self.assertEqual(len(assistant_message["sources"]), 2)
        expected_source_fields = {
            "chunk_id",
            "content",
            "note_id",
            "video_id",
            "folder_id",
            "source_block_id",
            "chunk_index",
            "metadata",
        }
        self.assertEqual(
            set(assistant_message["sources"][0]),
            expected_source_fields | {"youtube_id"},
        )
        self.assertEqual(
            set(assistant_message["sources"][1]),
            expected_source_fields,
        )
        self.assertEqual(
            assistant_message["sources"][0]["youtube_id"],
            "video123456",
        )
        self.assertEqual(
            assistant_message["sources"][0]["metadata"]["start_seconds"],
            12.5,
        )
        self.assertEqual(
            assistant_message["sources"][0]["metadata"]["end_seconds"],
            18.0,
        )
        self.assertNotIn("youtube_id", assistant_message["sources"][1])
        self.assertEqual(
            assistant_message["sources"][1]["metadata"]["start_seconds"],
            22.0,
        )

    def test_detail_normalizes_json_encoded_persisted_sources(self):
        source = {
            "chunk_id": 11,
            "content": "Persisted transcript excerpt",
            "note_id": None,
            "video_id": 6,
            "folder_id": None,
            "source_block_id": None,
            "chunk_index": 5,
            "metadata": {
                "source_type": "VIDEO_TRANSCRIPT",
                "start_seconds": 31.0,
            },
            "youtube_id": "video123456",
        }
        ConversationMessage.objects.create(
            conversation=self.personal_conversation,
            role=ConversationMessage.Role.ASSISTANT,
            content="An answer with encoded sources.",
            sources=json.dumps([source]),
        )

        response = self.client.get(
            self.conversation_url(self.personal_conversation)
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(
            response.json()["messages"][0]["sources"],
            [source],
        )

    def test_foreign_conversation_is_hidden_for_get_delete_and_ask(self):
        for method, url, data in (
            ("get", self.conversation_url(self.other_conversation), None),
            (
                "patch",
                self.conversation_url(self.other_conversation),
                {"title": "Hijacked title"},
            ),
            ("delete", self.conversation_url(self.other_conversation), None),
            ("post", self.ask_url(self.other_conversation), {"question": "Hi"}),
        ):
            with self.subTest(method=method):
                response = getattr(self.client, method)(
                    url,
                    data=data,
                    format="json" if data is not None else None,
                )
                self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)

        self.assertTrue(
            Conversation.objects.filter(pk=self.other_conversation.pk).exists()
        )
        self.other_conversation.refresh_from_db()
        self.assertEqual(self.other_conversation.title, "Private conversation")

    def test_owner_can_rename_and_delete_conversation(self):
        ConversationMessage.objects.create(
            conversation=self.personal_conversation,
            role=ConversationMessage.Role.USER,
            content="A message to cascade",
        )
        rename_response = self.client.patch(
            self.conversation_url(self.personal_conversation),
            {"title": "Renamed"},
            format="json",
        )
        self.assertEqual(rename_response.status_code, status.HTTP_200_OK)
        self.assertEqual(rename_response.data["title"], "Renamed")

        delete_response = self.client.delete(
            self.conversation_url(self.personal_conversation)
        )
        self.assertEqual(
            delete_response.status_code,
            status.HTTP_204_NO_CONTENT,
        )
        self.assertFalse(
            Conversation.objects.filter(pk=self.personal_conversation.pk).exists()
        )
        self.assertFalse(
            ConversationMessage.objects.filter(
                conversation_id=self.personal_conversation.pk
            ).exists()
        )

    @patch("knowledge.views.answer_question")
    def test_personal_knowledge_ask_does_not_require_video(
        self,
        answer_question,
    ):
        answer_question.return_value = self.answer

        response = self.client.post(
            self.ask_url(self.personal_conversation),
            {"question": "What have I saved?"},
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        kwargs = answer_question.call_args.kwargs
        self.assertIs(kwargs["user"], self.user)
        self.assertIsNone(kwargs["request"].video)
        self.assertIsNone(kwargs["request"].folder)
        self.assertEqual(kwargs["request"].scope, RetrievalScope.PERSONAL_KB)

    @patch("knowledge.views.answer_question")
    def test_ask_persists_user_assistant_and_safe_source_provenance(
        self,
        answer_question,
    ):
        video = Video.objects.create(youtube_id="video123456")
        conversation = Conversation.objects.create(
            user=self.user,
            scope=Conversation.Scope.CURRENT_VIDEO,
            youtube_id=video.youtube_id,
        )
        answer_question.return_value = RAGAnswer(
            answer="A grounded response.",
            sources=(
                RAGContextItem(
                    chunk_id=9,
                    content="Useful transcript excerpt",
                    distance=0.2,
                    note_id=None,
                    video_id=video.pk,
                    folder_id=None,
                    source_block_id=None,
                    chunk_index=3,
                    metadata={
                        "source_type": "VIDEO_TRANSCRIPT",
                        "start_seconds": 12.5,
                        "end_seconds": 18.0,
                    },
                ),
            ),
        )

        response = self.client.post(
            self.ask_url(conversation),
            {"question": "Explain this moment"},
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(
            [message.role for message in conversation.messages.all()],
            [
                ConversationMessage.Role.USER,
                ConversationMessage.Role.ASSISTANT,
            ],
        )
        persisted_assistant = conversation.messages.get(
            role=ConversationMessage.Role.ASSISTANT
        )
        self.assertEqual(persisted_assistant.sources[0]["content"], "Useful transcript excerpt")
        self.assertEqual(
            persisted_assistant.sources[0]["metadata"]["start_seconds"],
            12.5,
        )
        self.assertEqual(
            persisted_assistant.sources[0]["youtube_id"],
            video.youtube_id,
        )
        self.assertNotIn("distance", persisted_assistant.sources[0])
        self.assertEqual(
            response.data["assistant_message"]["sources"],
            persisted_assistant.sources,
        )
        kwargs = answer_question.call_args.kwargs
        self.assertEqual(kwargs["user"], self.user)
        self.assertEqual(kwargs["question"], "Explain this moment")
        self.assertEqual(
            kwargs["request"].scope,
            RetrievalScope.CURRENT_VIDEO,
        )
        self.assertEqual(kwargs["request"].video, video)
        self.assertIsNone(kwargs["request"].folder)

    @patch("knowledge.views.answer_question")
    def test_combined_ask_uses_requesting_users_knowledge_scope(self, answer_question):
        answer_question.return_value = self.answer
        video = Video.objects.create(youtube_id="combined123")
        conversation = Conversation.objects.create(
            user=self.user,
            scope=Conversation.Scope.COMBINED,
            youtube_id=video.youtube_id,
        )

        response = self.client.post(
            self.ask_url(conversation),
            {"question": "Combine these sources"},
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        kwargs = answer_question.call_args.kwargs
        self.assertIs(kwargs["user"], self.user)
        self.assertIs(kwargs["request"].user, self.user)
        self.assertEqual(kwargs["request"].scope, RetrievalScope.COMBINED)

    @patch("knowledge.views.answer_question")
    def test_generation_failure_does_not_persist_a_false_assistant_message(
        self,
        answer_question,
    ):
        answer_question.side_effect = RAGGenerationError("provider internals")

        response = self.client.post(
            self.ask_url(self.personal_conversation),
            {"question": "Retry this question"},
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_502_BAD_GATEWAY)
        self.assertFalse(
            self.personal_conversation.messages.filter(
                role=ConversationMessage.Role.ASSISTANT
            ).exists()
        )
        self.assertFalse(
            self.personal_conversation.messages.filter(
                content="Retry this question"
            ).exists()
        )
        self.assertNotIn("provider internals", str(response.data))

    @patch("knowledge.views.answer_question")
    def test_unauthorized_video_context_does_not_leave_messages(
        self,
        answer_question,
    ):
        video = Video.objects.create(youtube_id="foreign1234")
        conversation = Conversation.objects.create(
            user=self.user,
            scope=Conversation.Scope.CURRENT_VIDEO,
            youtube_id=video.youtube_id,
        )
        answer_question.side_effect = KnowledgeContextAccessError(
            "private context"
        )

        response = self.client.post(
            self.ask_url(conversation),
            {"question": "Access private knowledge"},
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)
        self.assertFalse(conversation.messages.exists())
        self.assertNotIn("private context", str(response.data))

    def test_authentication_is_required(self):
        self.client.force_authenticate(user=None)

        response = self.client.get(CONVERSATIONS_URL)

        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)
