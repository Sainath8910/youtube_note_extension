import re

from django.db import IntegrityError, transaction
from rest_framework import serializers, status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView


USERNAME_PATTERN = re.compile(r"^[a-z0-9_]{3,30}$")


class ProfileUsernameSerializer(serializers.Serializer):
    username = serializers.CharField(
        min_length=3,
        max_length=30,
        trim_whitespace=True,
    )

    def validate_username(self, value):
        normalized = value.strip().lower()
        if not USERNAME_PATTERN.fullmatch(normalized):
            raise serializers.ValidationError(
                "Use 3–30 letters, numbers, or underscores.",
            )
        if (
            self.context["user"].__class__.objects
            .filter(public_username=normalized)
            .exclude(pk=self.context["user"].pk)
            .exists()
        ):
            raise serializers.ValidationError("This username is already taken.")
        return normalized


class CurrentUserView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        user = request.user
        return Response(
            {
                "id": user.pk,
                "email": user.email,
                "display_name": user.get_full_name() or user.email or "",
            }
        )


class ProfileView(APIView):
    permission_classes = [IsAuthenticated]

    @staticmethod
    def _response(user):
        return Response(
            {
                "email": user.email,
                "username": user.public_username or "",
            }
        )

    def get(self, request):
        return self._response(request.user)

    def patch(self, request):
        serializer = ProfileUsernameSerializer(
            data=request.data,
            context={"user": request.user},
        )
        serializer.is_valid(raise_exception=True)
        try:
            with transaction.atomic():
                request.user.public_username = serializer.validated_data[
                    "username"
                ]
                request.user.save(update_fields=["public_username"])
        except IntegrityError:
            return Response(
                {"username": ["This username is already taken."]},
                status=status.HTTP_409_CONFLICT,
            )
        return self._response(request.user)
