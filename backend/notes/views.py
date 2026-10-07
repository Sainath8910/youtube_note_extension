# backend/notes/views.py
import logging

from django.db import transaction
from rest_framework import generics
from rest_framework.response import Response
from rest_framework import status
from rest_framework.exceptions import APIException

from knowledge.services.indexing import index_note
from videos.models import Video
from videos.serializers import VideoSerializer
from videos.services.youtube import (
    InvalidYouTubeVideoIdError,
    YouTubeMetadataError,
    fetch_youtube_metadata,
)

from .models import Note
from .serializers import NoteSerializer


logger = logging.getLogger(__name__)


class NoteIndexingUnavailable(APIException):
    status_code = status.HTTP_502_BAD_GATEWAY
    default_detail = "The note could not be synchronized to the knowledge base."
    default_code = "note_indexing_unavailable"


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

    def get_queryset(self):
        return Note.objects.filter(
            user=self.request.user
        ).select_related(
            "video",
            "folder",
        )

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