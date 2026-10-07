# backend/notes/views.py
import logging

from django.db import transaction
from django.db.models import Q, TextField
from django.db.models.functions import Cast
from rest_framework import generics, status
from rest_framework.exceptions import APIException, NotFound
from rest_framework.pagination import PageNumberPagination
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from knowledge.services.indexing import index_note
from videos.models import Video
from videos.serializers import VideoSerializer
from videos.services.youtube import (
    InvalidYouTubeVideoIdError,
    YouTubeMetadataError,
    fetch_youtube_metadata,
)

from .models import Note
from .serializers import NoteAssistanceRequestSerializer, NoteSerializer
from .services.assistance import (
    NoteAssistanceError,
    NoteAssistanceGenerationError,
    StaleNoteError,
    create_improvement_proposal,
)


logger = logging.getLogger(__name__)


class NoteIndexingUnavailable(APIException):
    status_code = status.HTTP_502_BAD_GATEWAY
    default_detail = "The note could not be synchronized to the knowledge base."
    default_code = "note_indexing_unavailable"


class NoteListPagination(PageNumberPagination):
    page_size = 10

    def get_page_number(self, request, paginator):
        requested_page = request.query_params.get(self.page_query_param, "1")
        if requested_page != self.last_page_strings[0]:
            try:
                page_number = int(requested_page)
            except (TypeError, ValueError):
                return super().get_page_number(request, paginator)
            if page_number > paginator.num_pages:
                return paginator.num_pages
        return super().get_page_number(request, paginator)

    def get_paginated_response(self, data):
        return Response(
            {
                "count": self.page.paginator.count,
                "next": self.get_next_link(),
                "previous": self.get_previous_link(),
                "page": self.page.number,
                "page_size": self.page_size,
                "results": data,
            }
        )


@transaction.atomic
def _save_and_index_note(serializer, **save_kwargs):
    note = serializer.save(**save_kwargs)
    try:
        index_note(note)
    except Exception as error:
        raise NoteIndexingUnavailable from error
    return note


class NoteListCreateView(generics.ListCreateAPIView):
    serializer_class = NoteSerializer
    pagination_class = NoteListPagination

    paginated_query_params = {"page", "search", "note_type", "ordering"}

    def get_queryset(self):
        return Note.objects.filter(
            user=self.request.user
        ).select_related(
            "video",
            "folder",
        )

    def list(self, request, *args, **kwargs):
        if not self.paginated_query_params.intersection(request.query_params):
            serializer = self.get_serializer(self.get_queryset(), many=True)
            return Response(serializer.data)

        queryset = self.get_queryset()
        search = request.query_params.get("search", "").strip()
        note_type = request.query_params.get("note_type", "ALL")
        ordering = request.query_params.get("ordering", "updated-desc")
        if note_type not in {"ALL", Note.NoteType.VIDEO, Note.NoteType.STANDALONE}:
            return Response(
                {"detail": "Unsupported note type filter."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        ordering_fields = {
            "updated-desc": ("-updated_at", "id"),
            "updated-asc": ("updated_at", "id"),
            "created-desc": ("-created_at", "id"),
            "created-asc": ("created_at", "id"),
        }
        if ordering not in ordering_fields:
            return Response(
                {"detail": "Unsupported note ordering."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        if note_type != "ALL":
            queryset = queryset.filter(note_type=note_type)
        if search:
            queryset = queryset.annotate(
                _document_search=Cast("document", output_field=TextField()),
            ).filter(
                Q(title__icontains=search)
                | Q(content__icontains=search)
                | Q(_document_search__icontains=search)
            )
        queryset = queryset.order_by(*ordering_fields[ordering])

        page = self.paginate_queryset(queryset)
        serializer = self.get_serializer(page, many=True)
        return self.get_paginated_response(serializer.data)

    def perform_create(self, serializer):
        _save_and_index_note(serializer, user=self.request.user)


class NoteDetailView(generics.RetrieveUpdateDestroyAPIView):
    serializer_class = NoteSerializer

    def get_queryset(self):
        return Note.objects.filter(
            user=self.request.user
        ).select_related(
            "video",
            "folder",
        )

    def perform_update(self, serializer):
        _save_and_index_note(serializer)


class NoteAssistanceView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request, pk):
        try:
            note = Note.objects.get(pk=pk, user=request.user)
        except Note.DoesNotExist:
            raise NotFound("Note not found.") from None

        serializer = NoteAssistanceRequestSerializer(data=request.data)
        if not serializer.is_valid():
            return Response(
                {
                    "detail": "The note assistance request is invalid.",
                    "code": "invalid_request",
                    "errors": serializer.errors,
                },
                status=status.HTTP_400_BAD_REQUEST,
            )

        values = serializer.validated_data
        try:
            proposal = create_improvement_proposal(
                note=note,
                user=request.user,
                block_id=values["target"]["block_id"],
                base_updated_at=values["base_updated_at"],
            )
        except StaleNoteError as error:
            return Response(
                {"detail": str(error), "code": "stale_note"},
                status=status.HTTP_409_CONFLICT,
            )
        except NoteAssistanceError as error:
            return Response(
                {"detail": str(error), "code": error.code},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except NoteAssistanceGenerationError:
            return Response(
                {
                    "detail": "AI assistance could not generate a proposal.",
                    "code": "generation_failed",
                },
                status=status.HTTP_502_BAD_GATEWAY,
            )

        return Response(proposal, status=status.HTTP_200_OK)


class VideoNoteCreateView(generics.CreateAPIView):
    serializer_class = NoteSerializer

    @transaction.atomic
    def create(self, request, *args, **kwargs):
        data = request.data.copy()

        youtube_id = data.get("youtube_id")

        if not youtube_id:
            return Response(
                {"error": "youtube_id is required."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        try:
            video_metadata = fetch_youtube_metadata(youtube_id)
            metadata_resolved = True
        except InvalidYouTubeVideoIdError:
            return Response(
                {"error": "youtube_id must be a valid YouTube video ID."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except YouTubeMetadataError:
            logger.warning(
                "YouTube metadata unavailable for youtube_id=%s; "
                "continuing with fallback metadata.",
                youtube_id,
            )
            video_metadata = {
                "title": "",
                "channel_name": "",
                "channel_handle": "",
                "channel_id": "",
                "thumbnail_url": (
                    f"https://i.ytimg.com/vi/{youtube_id}/hqdefault.jpg"
                ),
                "duration_seconds": None,
            }
            metadata_resolved = False

        video, created = Video.objects.get_or_create(
            youtube_id=youtube_id,
            defaults=video_metadata,
        )

        updated_fields = []

        for field, value in video_metadata.items():
            if value is None or value == "":
                continue

            current_value = getattr(video, field)
            should_update = (
                metadata_resolved and current_value != value
            ) or (not metadata_resolved and not current_value)
            if should_update:
                setattr(video, field, value)
                updated_fields.append(field)

        if updated_fields:
            updated_fields.append("updated_at")
            video.save(update_fields=updated_fields)

        data.pop("youtube_id", None)

        data["video"] = video.id

        serializer = self.get_serializer(
            data=data,
            context=self.get_serializer_context(),
        )

        serializer.is_valid(raise_exception=True)

        note = _save_and_index_note(
            serializer,
            user=request.user,
        )
        return Response(
            {
                "video_created": created,
                "metadata_resolved": metadata_resolved,
                "video": VideoSerializer(video).data,
                "note": NoteSerializer(note).data,
            },
            status=status.HTTP_201_CREATED,
        )