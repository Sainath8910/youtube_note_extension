import logging
import re

from django.shortcuts import get_object_or_404
from django.utils import timezone
from rest_framework import generics, status
from rest_framework.response import Response
from rest_framework.views import APIView

from knowledge.models import KnowledgeChunk
from notes.models import Note
from notes.serializers import NoteSerializer

from knowledge.services.analysis_indexing import index_video_analysis
from knowledge.services.transcript_indexing import index_video_transcript

from .models import Video, VideoAnalysis
from .services.analysis import (
    AnalysisError,
    TranscriptNotReadyError,
    TranscriptUnavailableForAnalysisError,
    analyze_video,
    build_analysis_provider_manager,
)
from .services.transcript import (
    TranscriptRetrievalError,
    TranscriptUnavailableError,
    fetch_youtube_transcript,
)
from .serializers import VideoAnalysisSerializer, VideoSerializer

logger = logging.getLogger(__name__)
_YOUTUBE_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{11}$")


def _ensure_transcript_indexed_for_user(video, user):
    indexed = KnowledgeChunk.objects.filter(
        user=user,
        video=video,
        source_type=KnowledgeChunk.SourceType.VIDEO_TRANSCRIPT,
        embedding__isnull=False,
    ).exists()
    if indexed:
        return

    try:
        index_video_transcript(video=video, user=user)
    except Exception as error:
        logger.error(
            "Transcript indexing failed for %s (%s)",
            video.youtube_id,
            type(error).__name__,
        )


def _ensure_analysis_indexed_for_user(video, user):
    indexed = KnowledgeChunk.objects.filter(
        user=user,
        video=video,
        source_type=KnowledgeChunk.SourceType.VIDEO_ANALYSIS,
        embedding__isnull=False,
    ).exists()
    if indexed:
        return

    try:
        index_video_analysis(video=video, user=user)
    except Exception as error:
        logger.error(
            "Video analysis indexing failed for %s (%s)",
            video.youtube_id,
            type(error).__name__,
        )


class VideoContextView(generics.RetrieveAPIView):
    serializer_class = VideoSerializer
    lookup_field = "youtube_id"

    def get_queryset(self):
        return Video.objects.all()

    def retrieve(self, request, *args, **kwargs):
        youtube_id = kwargs["youtube_id"]

        try:
            video = Video.objects.get(
                youtube_id=youtube_id,
            )
        except Video.DoesNotExist:
            return Response({
                "saved": False,
                "video": None,
                "notes": [],
            })

        notes = Note.objects.filter(
            user=request.user,
            video=video,
        ).select_related("folder")

        return Response({
            "saved": True,
            "video": VideoSerializer(video).data,
            "notes": NoteSerializer(
                notes,
                many=True,
            ).data,
        })


class TranscriptView(APIView):
    def post(self, request, youtube_id):
        if not _YOUTUBE_ID_PATTERN.fullmatch(youtube_id):
            return Response(
                {"error": "Invalid YouTube video ID."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        video, _ = Video.objects.get_or_create(youtube_id=youtube_id)

        if video.transcript_status == Video.TranscriptStatus.READY:
            _ensure_transcript_indexed_for_user(video, request.user)
            return self._response(video)

        video.transcript_status = Video.TranscriptStatus.FETCHING
        video.save(update_fields=["transcript_status", "updated_at"])

        try:
            transcript = fetch_youtube_transcript(youtube_id)
        except TranscriptUnavailableError as error:
            return self._failed_response(
                video,
                str(error),
                status.HTTP_404_NOT_FOUND,
            )
        except TranscriptRetrievalError as error:
            return self._failed_response(
                video,
                str(error),
                status.HTTP_502_BAD_GATEWAY,
            )
        except Exception:
            logger.exception(
                "Unexpected failure while fetching transcript for %s",
                youtube_id,
            )
            return self._failed_response(
                video,
                "Transcript retrieval failed.",
                status.HTTP_502_BAD_GATEWAY,
            )

        video.transcript = transcript["segments"]
        video.transcript_language = transcript["language"]
        video.transcript_fetched_at = timezone.now()
        video.transcript_status = Video.TranscriptStatus.READY
        video.save(
            update_fields=[
                "transcript",
                "transcript_language",
                "transcript_fetched_at",
                "transcript_status",
                "updated_at",
            ]
        )
        try:
            index_video_transcript(video=video, user=request.user)
        except Exception as error:
            logger.error(
                "Transcript indexing failed for %s (%s)",
                youtube_id,
                type(error).__name__,
            )
        return self._response(video)

    @staticmethod
    def _response(video, response_status=status.HTTP_200_OK):
        return Response(
            {
                "youtube_id": video.youtube_id,
                "transcript_status": video.transcript_status,
                "transcript": (
                    {
                        "language": video.transcript_language,
                        "segments": video.transcript,
                    }
                    if video.transcript is not None
                    else None
                ),
                "transcript_fetched_at": video.transcript_fetched_at,
            },
            status=response_status,
        )

    @classmethod
    def _failed_response(cls, video, message, response_status):
        video.transcript_status = Video.TranscriptStatus.FAILED
        video.save(update_fields=["transcript_status", "updated_at"])
        return Response(
            {
                "youtube_id": video.youtube_id,
                "error": message,
                "transcript_status": video.transcript_status,
            },
            status=response_status,
        )


class VideoAnalysisView(APIView):
    def post(self, request, youtube_id):
        if not _YOUTUBE_ID_PATTERN.fullmatch(youtube_id):
            return Response(
                {"error": "Invalid YouTube video ID."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        try:
            video = Video.objects.get(youtube_id=youtube_id)
        except Video.DoesNotExist:
            return Response(
                {"error": "Video not found."},
                status=status.HTTP_404_NOT_FOUND,
            )

        if (
            video.analysis_status == Video.AnalysisStatus.READY
            and VideoAnalysis.objects.filter(video=video).exists()
        ):
            _ensure_analysis_indexed_for_user(video, request.user)
            return self._response(video, video.analysis)

        if (
            video.transcript_status != Video.TranscriptStatus.READY
            or not isinstance(video.transcript, list)
            or not video.transcript
        ):
            return Response(
                {
                    "video_id": video.youtube_id,
                    "error": (
                        "A ready transcript is required. Retrieve the transcript "
                        "before requesting analysis."
                    ),
                    "transcript_status": video.transcript_status,
                },
                status=status.HTTP_409_CONFLICT,
            )

        try:
            analysis = analyze_video(
                video,
                build_analysis_provider_manager(),
            )
        except (TranscriptNotReadyError, TranscriptUnavailableForAnalysisError) as error:
            return Response(
                {
                    "video_id": video.youtube_id,
                    "error": str(error),
                    "transcript_status": video.transcript_status,
                },
                status=status.HTTP_409_CONFLICT,
            )
        except AnalysisError as error:
            logger.error(
                "Video analysis failed for %s (%s)",
                youtube_id,
                type(error).__name__,
            )
            return Response(
                {
                    "video_id": video.youtube_id,
                    "error": "Video analysis failed.",
                    "analysis_status": Video.AnalysisStatus.FAILED,
                },
                status=status.HTTP_502_BAD_GATEWAY,
            )

        try:
            index_video_analysis(video=video, user=request.user)
        except Exception as error:
            logger.error(
                "Video analysis indexing failed for %s (%s)",
                youtube_id,
                type(error).__name__,
            )

        return self._response(video, analysis)

    @staticmethod
    def _response(video, analysis):
        return Response(
            {
                "status": Video.AnalysisStatus.READY,
                "video_id": video.youtube_id,
                "analysis": VideoAnalysisSerializer(analysis).data,
            },
            status=status.HTTP_200_OK,
        )
