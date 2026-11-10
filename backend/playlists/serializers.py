from rest_framework import serializers

from videos.models import Video

from .models import Playlist, PlaylistVideo


class PlaylistVideoSerializer(serializers.ModelSerializer):
    youtube_id = serializers.CharField(source="video.youtube_id", read_only=True)
    title = serializers.CharField(source="video.title", read_only=True)
    channel_name = serializers.CharField(source="video.channel_name", read_only=True)
    thumbnail_url = serializers.CharField(source="video.thumbnail_url", read_only=True)
    notes_count = serializers.SerializerMethodField()

    class Meta:
        model = PlaylistVideo
        fields = [
            "youtube_id",
            "title",
            "channel_name",
            "thumbnail_url",
            "position",
            "notes_count",
            "added_at",
        ]

    def get_notes_count(self, item):
        return item.video.notes.filter(
            user=self.context["request"].user,
            deleted_at__isnull=True,
            note_type="VIDEO",
        ).count()


class PlaylistSerializer(serializers.ModelSerializer):
    videos_count = serializers.IntegerField(read_only=True)

    class Meta:
        model = Playlist
        fields = [
            "id",
            "sync_uuid",
            "kind",
            "title",
            "channel_name",
            "youtube_playlist_id",
            "thumbnail_url",
            "playlist_url",
            "videos_count",
            "created_at",
            "updated_at",
        ]
        read_only_fields = ["id", "sync_uuid", "videos_count", "created_at", "updated_at"]

    def validate(self, attrs):
        kind = attrs.get("kind", getattr(self.instance, "kind", None))
        playlist_id = attrs.get(
            "youtube_playlist_id",
            getattr(self.instance, "youtube_playlist_id", None),
        )
        if kind == Playlist.Kind.YOUTUBE and not playlist_id:
            raise serializers.ValidationError(
                {"youtube_playlist_id": "YouTube playlists require a playlist ID."}
            )
        if kind == Playlist.Kind.CUSTOM and playlist_id:
            raise serializers.ValidationError(
                {"youtube_playlist_id": "Custom playlists cannot have a YouTube playlist ID."}
            )
        return attrs


class PlaylistDetailSerializer(PlaylistSerializer):
    videos = PlaylistVideoSerializer(source="items", many=True, read_only=True)

    class Meta(PlaylistSerializer.Meta):
        fields = [*PlaylistSerializer.Meta.fields, "videos"]


class AddPlaylistVideoSerializer(serializers.Serializer):
    youtube_id = serializers.RegexField(r"^[A-Za-z0-9_-]{11}$")
    title = serializers.CharField(max_length=500, required=False, allow_blank=True)
    channel_name = serializers.CharField(max_length=255, required=False, allow_blank=True)
    thumbnail_url = serializers.URLField(max_length=200, required=False, allow_blank=True)
    position = serializers.IntegerField(min_value=0, required=False)

    def create(self, validated_data):
        youtube_id = validated_data.pop("youtube_id")
        validated_data.pop("position", None)
        video, _ = Video.objects.get_or_create(
            youtube_id=youtube_id,
            defaults=validated_data,
        )
        changed = []
        for field, value in validated_data.items():
            if value and not getattr(video, field):
                setattr(video, field, value)
                changed.append(field)
        if changed:
            changed.append("updated_at")
            video.save(update_fields=changed)
        return video
