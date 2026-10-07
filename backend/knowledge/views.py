import time

from rest_framework import status
from rest_framework.exceptions import NotFound
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from folders.models import Folder
from knowledge.models import PreviousContextJob, PreviousContextJobStatus
from knowledge.serializers import (
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
