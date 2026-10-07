from rest_framework import serializers

from .models import Folder


class FolderSerializer(serializers.ModelSerializer):
    name = serializers.CharField(
        max_length=255,
        allow_blank=False,
        trim_whitespace=True,
    )
    parent = serializers.PrimaryKeyRelatedField(read_only=True)

    class Meta:
        model = Folder
        fields = [
            "id",
            "name",
            "description",
            "parent",
            "created_at",
            "updated_at",
        ]
        read_only_fields = ["id", "parent", "created_at", "updated_at"]
        validators = []

    def validate_name(self, value):
        user = self.context["request"].user
        if Folder.objects.filter(
            user=user,
            parent__isnull=True,
            name=value,
        ).exists():
            raise serializers.ValidationError(
                "A root folder with this name already exists."
            )
        return value
