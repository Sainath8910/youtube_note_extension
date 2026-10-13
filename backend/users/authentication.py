from functools import lru_cache
from urllib.error import URLError
from urllib.parse import urlsplit
from uuid import UUID

import jwt
from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.exceptions import ImproperlyConfigured
from django.db import IntegrityError, transaction
from jwt import PyJWKClient
from rest_framework.authentication import BaseAuthentication
from rest_framework.exceptions import AuthenticationFailed


ASYMMETRIC_ALGORITHMS = ("ES256", "RS256", "EdDSA")


@lru_cache(maxsize=4)
def get_jwks_client(jwks_url):
    return PyJWKClient(
        jwks_url,
        cache_jwk_set=True,
        lifespan=300,
        timeout=5,
    )


def _display_name_from_claims(claims):
    user_metadata = claims.get("user_metadata")
    if not isinstance(user_metadata, dict):
        user_metadata = {}

    for value in (
        user_metadata.get("full_name"),
        user_metadata.get("name"),
        claims.get("name"),
    ):
        if isinstance(value, str) and value.strip():
            return value.strip()[:300]
    return ""


def _get_or_create_user(claims, supabase_uid):
    User = get_user_model()
    display_name = _display_name_from_claims(claims)
    first_name, _, last_name = display_name.partition(" ")
    email = claims.get("email")
    if not isinstance(email, str):
        email = ""

    try:
        with transaction.atomic():
            existing_user = User.objects.filter(
                supabase_uid=supabase_uid
            ).first()
            if existing_user is not None:
                return existing_user

            return User.objects.create_user(
                username=f"supabase_{supabase_uid.hex}",
                password=None,
                email=email[:254],
                first_name=first_name[:150],
                last_name=last_name[:150],
                supabase_uid=supabase_uid,
            )
    except IntegrityError:
        # The unique UID constraint arbitrates concurrent first logins. The
        # query happens after the failed transaction has rolled back.
        try:
            return User.objects.get(supabase_uid=supabase_uid)
        except User.DoesNotExist:
            raise AuthenticationFailed(
                "The Supabase identity could not be provisioned."
            ) from None


class DevHeaderAuthentication(BaseAuthentication):
    """
    Development-only authentication for local extension testing.

    The client identifies the development user with:
        X-Dev-User: devuser

    This must never be enabled in production.
    """

    def authenticate(self, request):
        if (
            not settings.DEBUG
            or settings.DJANGO_ENV != "development"
            or not settings.ENABLE_DEV_HEADER_AUTH
        ):
            return None

        username = request.headers.get("X-Dev-User")

        if not username:
            return None

        try:
            user = get_user_model().objects.get(username=username)
        except get_user_model().DoesNotExist:
            raise AuthenticationFailed("Development user not found.")

        return (user, None)


class SupabaseJWTAuthentication(BaseAuthentication):
    def authenticate(self, request):
        authorization = request.headers.get("Authorization", "")
        if not authorization:
            return None

        parts = authorization.split()
        if len(parts) != 2 or parts[0].lower() != "bearer":
            if parts and parts[0].lower() == "bearer":
                raise AuthenticationFailed("Invalid bearer token.")
            return None

        token = parts[1]
        supabase_url = settings.SUPABASE_URL.rstrip("/")
        audience = settings.SUPABASE_JWT_AUDIENCE
        if not supabase_url or not audience:
            raise ImproperlyConfigured(
                "SUPABASE_URL and SUPABASE_JWT_AUDIENCE must be configured."
            )
        parsed_url = urlsplit(supabase_url)
        is_local_http = (
            settings.DEBUG
            and parsed_url.hostname in {"localhost", "127.0.0.1", "::1"}
        )
        if (
            (parsed_url.scheme != "https" and not is_local_http)
            or not parsed_url.hostname
            or parsed_url.path not in ("", "/")
            or parsed_url.query
            or parsed_url.fragment
        ):
            raise ImproperlyConfigured(
                "SUPABASE_URL must be an HTTPS project URL."
            )

        issuer = f"{supabase_url}/auth/v1"
        try:
            header = jwt.get_unverified_header(token)
            algorithm = header.get("alg")
            if algorithm in ASYMMETRIC_ALGORITHMS:
                signing_key = get_jwks_client(
                    f"{supabase_url}/auth/v1/.well-known/jwks.json"
                ).get_signing_key_from_jwt(token)
                key = signing_key.key
                allowed_algorithms = list(ASYMMETRIC_ALGORITHMS)
            elif algorithm == "HS256" and settings.SUPABASE_JWT_SECRET:
                key = settings.SUPABASE_JWT_SECRET
                allowed_algorithms = ["HS256"]
            else:
                raise AuthenticationFailed("Invalid bearer token.")

            claims = jwt.decode(
                token,
                key,
                algorithms=allowed_algorithms,
                issuer=issuer,
                audience=audience,
                options={"require": ["exp", "sub", "iss", "aud"]},
            )
            supabase_uid = UUID(claims["sub"])
        except AuthenticationFailed:
            raise
        except (jwt.PyJWTError, ValueError, TypeError, KeyError) as error:
            raise AuthenticationFailed("Invalid bearer token.") from error
        except (URLError, TimeoutError, OSError) as error:
            raise AuthenticationFailed(
                "Supabase token verification is unavailable."
            ) from error

        user = _get_or_create_user(claims, supabase_uid)
        if not user.is_active:
            raise AuthenticationFailed("User account is inactive.")

        return (user, claims)

    def authenticate_header(self, request):
        return "Bearer"
    