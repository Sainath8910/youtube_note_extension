from django.shortcuts import get_object_or_404
from rest_framework import generics
from rest_framework.response import Response

from notes.models import Note
from notes.serializers import NoteSerializer

from .models import Video
from .serializers import VideoSerializer


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
