from rest_framework import status
from rest_framework.exceptions import NotFound
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from folders.models import Folder
from knowledge.serializers import RAGAnswerSerializer, RAGQuestionSerializer
from knowledge.services.generation import RAGGenerationError
from knowledge.services.rag import answer_question
from knowledge.services.retrieval import (
    KnowledgeRetrievalError,
    RetrievalRequest,
    RetrievalScope,
)
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
        if scope is RetrievalScope.CURRENT_VIDEO or (
            scope is RetrievalScope.COMBINED and values.get("youtube_id")
        ):
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
