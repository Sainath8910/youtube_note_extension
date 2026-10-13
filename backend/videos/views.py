import logging
import re

from django.db.models import Count, Max, Q
from django.db.models.functions import Coalesce, Greatest, Lower
from django.shortcuts import get_object_or_404
from django.utils import timezone
from rest_framework import generics, status
from rest_framework.exceptions import ValidationError
from rest_framework.response import Response
from rest_framework.views import APIView

from knowledge.models import KnowledgeChunk
from notes.models import Note
from notes.serializers import NoteSerializer

from knowledge.services.analysis_indexing import index_video_analysis
from knowledge.services.transcript_indexing import index_video_transcript

from .models import Video, VideoAnalysis
from .pagination import VideoLibraryPagination
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
from .serializers import (
    VideoAnalysisSerializer,
    VideoLibrarySerializer,
    VideoSerializer,
)

logger = logging.getLogger(__name__)
_YOUTUBE_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{11}$")


def _videos_for_user(user):
    return (
        Video.objects.filter(
            Q(notes__user=user) | Q(viewing_sessions__user=user)
        )
        .annotate(
            notes_count=Count(
                "notes",
                filter=Q(
                    notes__user=user,
                    notes__note_type=Note.NoteType.VIDEO,
                ),
                distinct=True,
            ),
            library_updated_at=Coalesce(
                Greatest(
                    "updated_at",
                    Max("notes__updated_at", filter=Q(notes__user=user)),
                ),
                "updated_at",
            ),
        )
        .select_related("analysis")
        .distinct()
    )


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
                context={"request": request},
            ).data,
        })


class VideoLibraryView(APIView):
    pagination_class = VideoLibraryPagination
    availability_filters = {"all", "available", "missing", "processing", "failed"}
    sort_orders = {"updated", "added", "title", "notes"}

    def get(self, request):
        videos = _videos_for_user(request.user)
        query = request.query_params.get("q", "").strip()
        if query:
            videos = videos.filter(
                Q(title__icontains=query)
                | Q(channel_name__icontains=query)
            )

        transcript_filter = request.query_params.get("transcript", "all")
        analysis_filter = request.query_params.get("analysis", "all")
        for name, value in (
            ("transcript", transcript_filter),
            ("analysis", analysis_filter),
        ):
            if value not in self.availability_filters:
                raise ValidationError(
                    {name: "Choose a valid availability filter."},
                )

        if transcript_filter != "all":
            videos = self._filter_transcript_availability(
                videos,
                transcript_filter,
            )
        if analysis_filter != "all":
            videos = self._filter_analysis_availability(
                videos,
                analysis_filter,
            )

        sort_order = request.query_params.get("sort", "updated")
        if sort_order not in self.sort_orders:
            raise ValidationError(
                {"sort": "Choose a valid video sort order."},
            )
        orderings = {
            "updated": ("-library_updated_at", "youtube_id"),
            "added": ("-created_at", "youtube_id"),
            "title": (Lower("title"), "youtube_id"),
            "notes": ("-notes_count", Lower("title"), "youtube_id"),
        }
        videos = videos.order_by(*orderings[sort_order])

        paginator = self.pagination_class()
        page = paginator.paginate_queryset(videos, request, view=self)
        serializer = VideoLibrarySerializer(page, many=True)
        return paginator.get_paginated_response(serializer.data)

    @staticmethod
    def _filter_transcript_availability(videos, availability):
        usable_transcript = (
            Q(transcript_status=Video.TranscriptStatus.READY)
            & Q(transcript__isnull=False)
            & ~Q(transcript=[])
        )
        filters = {
            "available": usable_transcript,
            "processing": Q(
                transcript_status=Video.TranscriptStatus.FETCHING,
            ),
            "failed": Q(transcript_status=Video.TranscriptStatus.FAILED),
            "missing": (
                Q(transcript_status=Video.TranscriptStatus.NOT_STARTED)
                | (
                    Q(transcript_status=Video.TranscriptStatus.READY)
                    & ~usable_transcript
                )
            ),
        }
        return videos.filter(filters[availability])

    @staticmethod
    def _filter_analysis_availability(videos, availability):
        analysis_has_content = (
            Q(analysis__summary__gt="")
            | (
                Q(analysis__detailed_notes__isnull=False)
                & ~Q(analysis__detailed_notes={})
            )
            | (
                Q(analysis__topics__isnull=False)
                & ~Q(analysis__topics=[])
            )
            | (
                Q(analysis__concepts__isnull=False)
                & ~Q(analysis__concepts=[])
            )
            | (
                Q(analysis__prerequisites__isnull=False)
                & ~Q(analysis__prerequisites=[])
            )
            | (
                Q(analysis__upcoming_topics__isnull=False)
                & ~Q(analysis__upcoming_topics=[])
            )
            | (
                Q(analysis__key_points__isnull=False)
                & ~Q(analysis__key_points=[])
            )
            | (
                Q(analysis__claims__isnull=False)
                & ~Q(analysis__claims=[])
            )
            | (
                Q(analysis__questions__isnull=False)
                & ~Q(analysis__questions=[])
            )
        )
        usable_analysis = (
            Q(analysis_status=Video.AnalysisStatus.READY)
            & analysis_has_content
        )
        filters = {
            "available": usable_analysis,
            "processing": Q(
                analysis_status=Video.AnalysisStatus.ANALYZING,
            ),
            "failed": Q(analysis_status=Video.AnalysisStatus.FAILED),
            "missing": (
                Q(analysis_status=Video.AnalysisStatus.NOT_STARTED)
                | (
                    Q(analysis_status=Video.AnalysisStatus.READY)
                    & ~analysis_has_content
                )
            ),
        }
        return videos.filter(filters[availability])


class VideoDetailView(APIView):
    def get(self, request, youtube_id):
        if not _YOUTUBE_ID_PATTERN.fullmatch(youtube_id):
            return Response(
                {"error": "Invalid YouTube video ID."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        video = get_object_or_404(
            _videos_for_user(request.user),
            youtube_id=youtube_id,
        )
        notes = Note.objects.filter(
            user=request.user,
            video=video,
            note_type=Note.NoteType.VIDEO,
        ).select_related("folder", "video")
        return Response(
            {
                "video": VideoLibrarySerializer(video).data,
                "notes": NoteSerializer(
                    notes,
                    many=True,
                    context={"request": request},
                ).data,
            }
        )


class TranscriptView(APIView):
    def get(self, request, youtube_id):
        if not _YOUTUBE_ID_PATTERN.fullmatch(youtube_id):
            return Response(
                {"error": "Invalid YouTube video ID."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        video = get_object_or_404(
            _videos_for_user(request.user),
            youtube_id=youtube_id,
        )
        return self._response(video)

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
    def get(self, request, youtube_id):
        if not _YOUTUBE_ID_PATTERN.fullmatch(youtube_id):
            return Response(
                {"error": "Invalid YouTube video ID."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        try:
            video = _videos_for_user(request.user).get(
                youtube_id=youtube_id,
            )
        except Video.DoesNotExist:
            return Response(
                {"error": "Video not found."},
                status=status.HTTP_404_NOT_FOUND,
            )
        try:
            analysis = video.analysis
        except VideoAnalysis.DoesNotExist:
            analysis = None
        return Response(
            {
                "status": video.analysis_status,
                "video_id": video.youtube_id,
                "analysis": (
                    VideoAnalysisSerializer(analysis).data
                    if analysis is not None
                    else None
                ),
            }
        )

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
