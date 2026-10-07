import time

from rest_framework import status
from rest_framework.exceptions import NotFound
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from folders.models import Folder
from knowledge.models import (
    Conversation,
    ConversationMessage,
    PreviousContextJob,
    PreviousContextJobStatus,
)
from knowledge.serializers import (
    ConversationAskSerializer,
    ConversationContextSerializer,
    ConversationDetailSerializer,
    ConversationMessageSerializer,
    ConversationRenameSerializer,
    ConversationSerializer,
    PreviousContextQuerySerializer,
    PreviousContextSerializer,
    RAGAnswerSerializer,
    RAGQuestionSerializer,
)
from knowledge.services.generation import RAGGenerationError
from knowledge.services.previous_context import (
    _log_timing,
    get_previous_context,
)
from knowledge.services.rag import answer_question
from knowledge.services.retrieval import (
    KnowledgeContextAccessError,
    KnowledgeRetrievalError,
    RetrievalRequest,
    RetrievalScope,
)
from knowledge.services.previous_context_jobs import create_previous_context_job
from videos.models import Video


class ConversationListCreateView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        conversations = Conversation.objects.filter(user=request.user)
        return Response(
            ConversationSerializer(conversations, many=True).data,
            status=status.HTTP_200_OK,
        )

    def post(self, request):
        serializer = ConversationContextSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        values = serializer.validated_data
        conversation = Conversation.objects.create(
            user=request.user,
            title=values.get("title") or "New conversation",
            scope=values["scope"],
            youtube_id=values["youtube_id"],
        )
        return Response(
            ConversationSerializer(conversation).data,
            status=status.HTTP_201_CREATED,
        )


class ConversationDetailView(APIView):
    permission_classes = [IsAuthenticated]

    def get_object(self, request, conversation_id):
        try:
            return Conversation.objects.get(
                pk=conversation_id,
                user=request.user,
            )
        except Conversation.DoesNotExist:
            raise NotFound("Conversation not found.") from None

    def get(self, request, conversation_id):
        conversation = self.get_object(request, conversation_id)
        return Response(
            ConversationDetailSerializer(conversation).data,
            status=status.HTTP_200_OK,
        )

    def patch(self, request, conversation_id):
        conversation = self.get_object(request, conversation_id)
        serializer = ConversationRenameSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        conversation.title = serializer.validated_data["title"]
        conversation.save(update_fields=["title", "updated_at"])
        return Response(
            ConversationSerializer(conversation).data,
            status=status.HTTP_200_OK,
        )

    def delete(self, request, conversation_id):
        conversation = self.get_object(request, conversation_id)
        conversation.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


class ConversationAskView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request, conversation_id):
        try:
            conversation = Conversation.objects.get(
                pk=conversation_id,
                user=request.user,
            )
        except Conversation.DoesNotExist:
            raise NotFound("Conversation not found.") from None

        question_serializer = ConversationAskSerializer(data=request.data)
        question_serializer.is_valid(raise_exception=True)
        question = question_serializer.validated_data["question"]

        context_serializer = ConversationContextSerializer(
            data={
                "scope": conversation.scope,
                "youtube_id": conversation.youtube_id,
            },
        )
        context_serializer.is_valid(raise_exception=True)
        context = context_serializer.validated_data
        scope = RetrievalScope[context["scope"]]
        video = None
        if scope in (RetrievalScope.CURRENT_VIDEO, RetrievalScope.COMBINED):
            try:
                video = Video.objects.get(youtube_id=context["youtube_id"])
            except Video.DoesNotExist:
                raise NotFound("Not found.") from None

        user_message = ConversationMessage.objects.create(
            conversation=conversation,
            role=ConversationMessage.Role.USER,
            content=question,
        )
        conversation.save(update_fields=["updated_at"])
        retrieval_request = RetrievalRequest(
            user=request.user,
            query=question,
            scope=scope,
            video=video,
        )
        try:
            answer = answer_question(
                user=request.user,
                question=question,
                request=retrieval_request,
            )
        except KnowledgeContextAccessError:
            user_message.delete()
            raise NotFound("Not found.") from None
        except KnowledgeRetrievalError:
            user_message.delete()
            return Response(
                {"detail": "The knowledge retrieval request could not be completed."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except RAGGenerationError:
            user_message.delete()
            return Response(
                {"detail": "The AI service could not generate an answer."},
                status=status.HTTP_502_BAD_GATEWAY,
            )

        serialized_answer = RAGAnswerSerializer(answer).data
        video_ids = {
            source["video_id"]
            for source in serialized_answer["sources"]
            if source["video_id"] is not None
        }
        youtube_ids_by_video_id = dict(
            Video.objects.filter(pk__in=video_ids).values_list("pk", "youtube_id")
        )
        persisted_sources = []
        for source in serialized_answer["sources"]:
            persisted_source = dict(source)
            persisted_source.pop("distance", None)
            youtube_id = youtube_ids_by_video_id.get(source["video_id"])
            if youtube_id:
                persisted_source["youtube_id"] = youtube_id
            persisted_sources.append(persisted_source)

        assistant_message = ConversationMessage.objects.create(
            conversation=conversation,
            role=ConversationMessage.Role.ASSISTANT,
            content=serialized_answer["answer"],
            sources=persisted_sources,
        )
        conversation.save(update_fields=["updated_at"])
        return Response(
            {
                "conversation": ConversationSerializer(conversation).data,
                "user_message": ConversationMessageSerializer(user_message).data,
                "assistant_message": ConversationMessageSerializer(
                    assistant_message
                ).data,
            },
            status=status.HTTP_200_OK,
        )


class KnowledgeAskView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request):
        serializer = RAGQuestionSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        values = serializer.validated_data
        scope = RetrievalScope[values["scope"]]

        video = None
        folder = None
        if scope in (RetrievalScope.CURRENT_VIDEO, RetrievalScope.COMBINED):
            try:
                video = Video.objects.get(youtube_id=values["youtube_id"])
            except Video.DoesNotExist:
                raise NotFound("Not found.") from None
        if scope is RetrievalScope.CURRENT_FOLDER or (
            scope is RetrievalScope.COMBINED
            and values.get("folder_id") is not None
        ):
            try:
                folder = Folder.objects.get(
                    user=request.user,
                    pk=values["folder_id"],
                )
            except Folder.DoesNotExist:
                raise NotFound("Not found.") from None

        retrieval_request = RetrievalRequest(
            user=request.user,
            query=values["question"],
            scope=scope,
            video=video,
            folder=folder,
        )
        try:
            answer = answer_question(
                user=request.user,
                question=values["question"],
                request=retrieval_request,
                top_k=values["top_k"],
            )
        except KnowledgeContextAccessError:
            raise NotFound("Not found.") from None
        except KnowledgeRetrievalError:
            return Response(
                {"detail": "The knowledge retrieval request could not be completed."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except RAGGenerationError:
            return Response(
                {"detail": "The AI service could not generate an answer."},
                status=status.HTTP_502_BAD_GATEWAY,
            )

        return Response(
            RAGAnswerSerializer(answer).data,
            status=status.HTTP_200_OK,
        )


class PreviousContextView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        request_started = time.perf_counter()
        youtube_id = "unavailable"
        _log_timing(youtube_id, "request_entry", request_started)
        try:
            validation_started = time.perf_counter()
            serializer = PreviousContextQuerySerializer(
                data=request.query_params,
            )
            serializer.is_valid(raise_exception=True)
            youtube_id = serializer.validated_data["youtube_id"]
            _log_timing(youtube_id, "request_validation", validation_started)

            video_lookup_started = time.perf_counter()
            try:
                video = Video.objects.get(youtube_id=youtube_id)
            except Video.DoesNotExist:
                raise NotFound("Not found.") from None
            finally:
                _log_timing(youtube_id, "video_lookup", video_lookup_started)

            service_started = time.perf_counter()
            try:
                context = get_previous_context(
                    user=request.user,
                    video=video,
                )
            except KnowledgeRetrievalError:
                _log_timing(
                    youtube_id,
                    "previous_context_service",
                    service_started,
                )
                response_started = time.perf_counter()
                response = Response(
                    {
                        "detail": (
                            "Previous context retrieval could not be completed."
                        )
                    },
                    status=status.HTTP_503_SERVICE_UNAVAILABLE,
                )
                _log_timing(
                    youtube_id,
                    "error_response_construction",
                    response_started,
                )
                return response
            _log_timing(
                youtube_id,
                "previous_context_service",
                service_started,
            )

            serialization_started = time.perf_counter()
            serialized_context = PreviousContextSerializer(context).data
            _log_timing(
                youtube_id,
                "response_serialization",
                serialization_started,
            )
            response_started = time.perf_counter()
            response = Response(
                serialized_context,
                status=status.HTTP_200_OK,
            )
            _log_timing(
                youtube_id,
                "response_construction",
                response_started,
            )
            return response
        finally:
            _log_timing(youtube_id, "total_endpoint", request_started)


class PreviousContextJobCreateView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request):
        serializer = PreviousContextQuerySerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        job = create_previous_context_job(
            user=request.user,
            youtube_id=serializer.validated_data["youtube_id"],
        )
        return Response(
            {
                "job_id": job.job_id,
                "status": job.status,
                "youtube_id": job.youtube_id,
            },
            status=status.HTTP_201_CREATED,
        )


class PreviousContextJobStatusView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request, job_id):
        try:
            job = PreviousContextJob.objects.get(
                pk=job_id,
                user=request.user,
            )
        except PreviousContextJob.DoesNotExist:
            raise NotFound("Previous Context job not found.") from None

        response_data = {
            "job_id": job.job_id,
            "status": job.status,
            "youtube_id": job.youtube_id,
        }
        if job.status == PreviousContextJobStatus.READY:
            response_data["result"] = job.result
        elif job.status == PreviousContextJobStatus.FAILED:
            response_data["error"] = (
                job.error or "Previous Context computation failed."
            )
        return Response(response_data, status=status.HTTP_200_OK)
