from rest_framework import serializers

from .models import Folder


class FolderSerializer(serializers.ModelSerializer):
    name = serializers.CharField(
        max_length=255,
        allow_blank=False,
        trim_whitespace=True,
    )
    parent = serializers.PrimaryKeyRelatedField(
        queryset=Folder.objects.none(),
        allow_null=True,
        required=False,
    )

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
        read_only_fields = ["id", "created_at", "updated_at"]
        validators = []

    def get_fields(self):
        fields = super().get_fields()
        request = self.context.get("request")
        if request is not None and request.user.is_authenticated:
            fields["parent"].queryset = Folder.objects.filter(
                user=request.user,
            )
        if self.instance is not None:
            fields["parent"].read_only = True
        if self.instance is not None and request is not None:
            if request.method in {"PATCH", "PUT"}:
                fields["description"].read_only = True
        return fields

    def validate(self, attrs):
        request = self.context["request"]
        name = attrs.get("name")
        if name is None:
            return attrs

        parent_id = (
            self.instance.parent_id
            if self.instance is not None
            else getattr(attrs.get("parent"), "pk", None)
        )
        folders = Folder.objects.filter(
            user=request.user,
            parent_id=parent_id,
            name=name,
        )
        if self.instance is not None:
            folders = folders.exclude(pk=self.instance.pk)
        if folders.exists():
            location = "root" if parent_id is None else "sibling"
            raise serializers.ValidationError(
                {"name": f"A {location} folder with this name already exists."}
            )
        return attrs


class FolderDetailSerializer(FolderSerializer):
    breadcrumbs = serializers.SerializerMethodField()

    class Meta(FolderSerializer.Meta):
        fields = [*FolderSerializer.Meta.fields, "breadcrumbs"]

    def get_breadcrumbs(self, folder):
        chain = []
        current = folder
        while current is not None:
            chain.append({"id": current.pk, "name": current.name})
            if current.parent_id is None:
                break
            current = Folder.objects.filter(
                pk=current.parent_id,
                user_id=folder.user_id,
            ).only(
                "id",
                "name",
                "parent_id",
                "user_id",
            ).first()
        return list(reversed(chain))
