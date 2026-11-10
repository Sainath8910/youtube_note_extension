import uuid

from django.db import transaction
from django.db.models import Count, Max, Prefetch, Q
from django.shortcuts import get_object_or_404
from django.utils import timezone
from rest_framework import status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from videos.models import Video

from .models import Playlist, PlaylistVideo
from .pagination import PlaylistLibraryPagination
from .serializers import (
    AddPlaylistVideoSerializer,
    PlaylistDetailSerializer,
    PlaylistSerializer,
)

def _playlists(user):
    return Playlist.objects.filter(user=user, deleted_at__isnull=True).annotate(
        videos_count=Count("items", distinct=True)
    )


class PlaylistListCreateView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        playlists = _playlists(request.user)
        query = request.query_params.get("q", "").strip()
        kind = request.query_params.get("kind", "all")
        ordering = request.query_params.get("sort", "updated")
        if query:
            playlists = playlists.filter(
                Q(title__icontains=query) | Q(channel_name__icontains=query)
            )
        if kind in {Playlist.Kind.YOUTUBE, Playlist.Kind.CUSTOM}:
            playlists = playlists.filter(kind=kind)
        elif kind != "all":
            return Response({"kind": "Choose all, YOUTUBE, or CUSTOM."}, status=400)
        orderings = {
            "updated": ("-updated_at", "id"),
            "added": ("-created_at", "id"),
            "title": ("title", "id"),
            "videos": ("-videos_count", "title", "id"),
        }
        if ordering not in orderings:
            return Response({"sort": "Choose updated, added, title, or videos."}, status=400)
        playlists = playlists.order_by(*orderings[ordering])
        paginator = PlaylistLibraryPagination()
        page = paginator.paginate_queryset(playlists, request, view=self)
        data = PlaylistSerializer(page, many=True, context={"request": request}).data
        return paginator.get_paginated_response(data)

    @transaction.atomic
    def post(self, request):
        serializer = PlaylistSerializer(data=request.data, context={"request": request})
        serializer.is_valid(raise_exception=True)
        if serializer.validated_data["kind"] == Playlist.Kind.YOUTUBE:
            attributes = serializer.validated_data
            playlist, _ = Playlist.objects.get_or_create(
                user=request.user,
                youtube_playlist_id=attributes["youtube_playlist_id"],
                defaults={
                    "kind": Playlist.Kind.YOUTUBE,
                    "title": attributes["title"],
                    "channel_name": attributes.get("channel_name", ""),
                    "thumbnail_url": attributes.get("thumbnail_url", ""),
                    "playlist_url": attributes.get("playlist_url", ""),
                },
            )
            fields = []
            for field in ("title", "channel_name", "thumbnail_url", "playlist_url"):
                value = attributes.get(field)
                if (
                    field == "title"
                    and value in {
                        "Untitled YouTube playlist",
                        f"YouTube playlist {attributes['youtube_playlist_id']}",
                    }
                    and playlist.title != value
                ):
                    continue
                if value and getattr(playlist, field) != value:
                    setattr(playlist, field, value)
                    fields.append(field)
            if playlist.deleted_at is not None:
                playlist.deleted_at = None
                playlist.trash_batch_id = None
                fields.extend(("deleted_at", "trash_batch_id"))
            if fields:
                playlist.save(update_fields=(*fields, "updated_at"))
        else:
            playlist = serializer.save(user=request.user)
        playlist = _playlists(request.user).get(pk=playlist.pk)
        return Response(
            PlaylistSerializer(playlist, context={"request": request}).data,
            status=status.HTTP_201_CREATED,
        )


class PlaylistDetailView(APIView):
    permission_classes = [IsAuthenticated]

    def get_object(self, request, pk):
        return get_object_or_404(
            _playlists(request.user).prefetch_related(
                Prefetch("items", queryset=PlaylistVideo.objects.select_related("video"))
            ),
            pk=pk,
        )

    def get(self, request, pk):
        playlist = self.get_object(request, pk)
        return Response(PlaylistDetailSerializer(
            playlist, context={"request": request}
        ).data)

    def patch(self, request, pk):
        playlist = self.get_object(request, pk)
        serializer = PlaylistSerializer(
            playlist, data=request.data, partial=True, context={"request": request}
        )
        serializer.is_valid(raise_exception=True)
        serializer.save()
        playlist = _playlists(request.user).get(pk=playlist.pk)
        return Response(PlaylistSerializer(
            playlist, context={"request": request}
        ).data)

    @transaction.atomic
    def delete(self, request, pk):
        playlist = get_object_or_404(
            Playlist.objects.select_for_update(),
            pk=pk,
            user=request.user,
            deleted_at__isnull=True,
        )
        playlist.deleted_at = timezone.now()
        playlist.trash_batch_id = uuid.uuid4()
        playlist.save(update_fields=("deleted_at", "trash_batch_id", "updated_at"))
        return Response(status=status.HTTP_204_NO_CONTENT)


class PlaylistVideoListCreateView(APIView):
    permission_classes = [IsAuthenticated]

    @transaction.atomic
    def post(self, request, pk):
        playlist = get_object_or_404(_playlists(request.user), pk=pk)
        videos = request.data.get("videos")
        if videos is not None:
            if not isinstance(videos, list) or not videos:
                return Response({"videos": "Provide a non-empty list of videos."}, status=400)
            if any(not isinstance(item, dict) for item in videos):
                return Response({"videos": "Each playlist video must be an object."}, status=400)
            serializers = []
            for item in videos:
                serializer = AddPlaylistVideoSerializer(data=item)
                serializer.is_valid(raise_exception=True)
                serializers.append(serializer)
            created = []
            for serializer in serializers:
                video = serializer.save()
                position = serializer.validated_data.get("position")
                if position is None:
                    position = (
                        playlist.items.aggregate(position=Max("position"))["position"]
                    )
                    position = (position if position is not None else -1) + 1
                membership, was_created = PlaylistVideo.objects.update_or_create(
                    playlist=playlist,
                    video=video,
                    defaults={"position": position},
                )
                created.append({
                    "youtube_id": video.youtube_id,
                    "position": membership.position,
                    "created": was_created,
                })
            return Response({"videos": created}, status=201)

        serializer = AddPlaylistVideoSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        video = serializer.save()
        last_position = playlist.items.aggregate(position=Max("position"))["position"]
        membership, created = PlaylistVideo.objects.get_or_create(
            playlist=playlist,
            video=video,
            defaults={"position": (last_position if last_position is not None else -1) + 1},
        )
        return Response(
            {"youtube_id": video.youtube_id, "position": membership.position},
            status=status.HTTP_201_CREATED if created else status.HTTP_200_OK,
        )

    def delete(self, request, pk, youtube_id):
        playlist = get_object_or_404(_playlists(request.user), pk=pk)
        membership = PlaylistVideo.objects.filter(
            playlist=playlist,
            video__youtube_id=youtube_id,
        ).first()
        if membership is None:
            return Response(status=status.HTTP_404_NOT_FOUND)
        membership.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)
