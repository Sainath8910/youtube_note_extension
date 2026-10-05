from django.conf import settings
from rest_framework.authentication import BaseAuthentication
from rest_framework.exceptions import AuthenticationFailed

from .models import User


class DevHeaderAuthentication(BaseAuthentication):
    """
    Development-only authentication for local extension testing.

    The client identifies the development user with:
        X-Dev-User: devuser

    This must never be enabled in production.
    """

    def authenticate(self, request):
        if not settings.DEBUG:
            return None

        username = request.headers.get("X-Dev-User")

        if not username:
            return None

        try:
            user = User.objects.get(username=username)
        except User.DoesNotExist:
            raise AuthenticationFailed("Development user not found.")

        return (user, None)
    