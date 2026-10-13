from datetime import datetime, timedelta, timezone
from unittest.mock import Mock, patch
from uuid import uuid4

import jwt
from cryptography.hazmat.primitives.asymmetric import rsa
from django.contrib.auth import get_user_model
from django.test import TestCase, override_settings
from rest_framework.test import APIClient

from folders.models import Folder
from notes.models import Note


@override_settings(
    SUPABASE_URL="https://project.supabase.co",
    SUPABASE_JWT_AUDIENCE="authenticated",
    SUPABASE_JWT_SECRET="",
)
class SupabaseAuthenticationTests(TestCase):
    issuer = "https://project.supabase.co/auth/v1"

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.private_key = rsa.generate_private_key(
            public_exponent=65537,
            key_size=2048,
        )
        cls.public_key = cls.private_key.public_key()

    def setUp(self):
        self.client = APIClient()
        self.jwks_client = Mock()
        self.jwks_client.get_signing_key_from_jwt.return_value.key = (
            self.public_key
        )
        jwks_patcher = patch(
            "users.authentication.get_jwks_client",
            return_value=self.jwks_client,
        )
        jwks_patcher.start()
        self.addCleanup(jwks_patcher.stop)

    def make_token(self, **claim_overrides):
        claims = {
            "sub": str(uuid4()),
            "iss": self.issuer,
            "aud": "authenticated",
            "exp": datetime.now(timezone.utc) + timedelta(minutes=5),
            "email": "learner@example.com",
            "user_metadata": {"full_name": "YouTube Learner"},
        }
        claims.update(claim_overrides)
        return jwt.encode(
            claims,
            self.private_key,
            algorithm="RS256",
            headers={"kid": "test-key"},
        )

    def get_me(self, token=None, **headers):
        request_headers = dict(headers)
        if token is not None:
            request_headers["HTTP_AUTHORIZATION"] = f"Bearer {token}"
        return self.client.get("/api/users/me/", **request_headers)

    def test_missing_bearer_token_returns_401(self):
        response = self.get_me()

        self.assertEqual(response.status_code, 401)
        self.assertIn("Bearer", response.headers["WWW-Authenticate"])

    def test_malformed_and_invalid_tokens_return_401(self):
        for authorization in ("Bearer", "Bearer not-a-jwt"):
            with self.subTest(authorization=authorization):
                response = self.client.get(
                    "/api/users/me/",
                    HTTP_AUTHORIZATION=authorization,
                )
                self.assertEqual(response.status_code, 401)

    def test_invalid_signature_returns_401(self):
        other_private_key = rsa.generate_private_key(
            public_exponent=65537,
            key_size=2048,
        )
        token = jwt.encode(
            {
                "sub": str(uuid4()),
                "iss": self.issuer,
                "aud": "authenticated",
                "exp": datetime.now(timezone.utc) + timedelta(minutes=5),
            },
            other_private_key,
            algorithm="RS256",
            headers={"kid": "test-key"},
        )

        response = self.get_me(token)

        self.assertEqual(response.status_code, 401)

    def test_hs256_is_rejected_without_legacy_secret_configuration(self):
        token = jwt.encode(
            {
                "sub": str(uuid4()),
                "iss": self.issuer,
                "aud": "authenticated",
                "exp": datetime.now(timezone.utc) + timedelta(minutes=5),
            },
            "test-only-unconfigured-secret-for-unit-tests",
            algorithm="HS256",
        )

        response = self.get_me(token)

        self.assertEqual(response.status_code, 401)

    @override_settings(
        SUPABASE_JWT_SECRET="test-only-supabase-legacy-secret-for-unit-tests"
    )
    def test_hs256_uses_only_the_configured_legacy_secret(self):
        token = jwt.encode(
            {
                "sub": str(uuid4()),
                "iss": self.issuer,
                "aud": "authenticated",
                "exp": datetime.now(timezone.utc) + timedelta(minutes=5),
            },
            "test-only-supabase-legacy-secret-for-unit-tests",
            algorithm="HS256",
        )

        response = self.get_me(token)

        self.assertEqual(response.status_code, 200)

    def test_invalid_issuer_returns_401(self):
        response = self.get_me(token=self.make_token(iss="https://attacker/"))

        self.assertEqual(response.status_code, 401)

    def test_invalid_audience_returns_401(self):
        response = self.get_me(token=self.make_token(aud="some-other-app"))

        self.assertEqual(response.status_code, 401)

    def test_expired_token_returns_401(self):
        response = self.get_me(
            token=self.make_token(
                exp=datetime.now(timezone.utc) - timedelta(minutes=1)
            )
        )

        self.assertEqual(response.status_code, 401)

    def test_verified_identity_is_mapped_to_a_new_django_user(self):
        token = self.make_token()

        response = self.get_me(token)

        user = get_user_model().objects.get(pk=response.data["id"])
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.data,
            {
                "id": user.pk,
                "email": "learner@example.com",
                "display_name": "YouTube Learner",
            },
        )
        self.assertFalse(user.has_usable_password())
        self.assertEqual(
            set(response.data),
            {"id", "email", "display_name"},
        )

    def test_repeated_login_does_not_create_duplicate_users(self):
        token = self.make_token()

        first_response = self.get_me(token)
        second_response = self.get_me(token)

        self.assertEqual(first_response.status_code, 200)
        self.assertEqual(second_response.status_code, 200)
        self.assertEqual(first_response.data["id"], second_response.data["id"])
        self.assertEqual(get_user_model().objects.count(), 1)

    def test_email_collision_does_not_link_existing_django_account(self):
        user_model = get_user_model()
        existing_user = user_model.objects.create_user(
            username="existing-account",
            email="learner@example.com",
            password=None,
        )

        response = self.get_me(self.make_token())

        existing_user.refresh_from_db()
        new_user = user_model.objects.get(
            supabase_uid__isnull=False,
            email="learner@example.com",
        )
        self.assertEqual(response.status_code, 200)
        self.assertIsNone(existing_user.supabase_uid)
        self.assertEqual(new_user.pk, response.data["id"])
        self.assertEqual(new_user.email, existing_user.email)
        self.assertEqual(
            user_model.objects.filter(email=existing_user.email).count(),
            2,
        )

    def test_me_returns_only_safe_profile_fields_for_authenticated_user(self):
        token = self.make_token()

        response = self.get_me(token)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["email"], "learner@example.com")
        self.assertEqual(response.data["display_name"], "YouTube Learner")
        self.assertNotIn("password", response.data)
        self.assertNotIn("access_token", response.data)

    def test_verified_user_cannot_access_another_users_notes_or_folders(self):
        user_model = get_user_model()
        owner = user_model.objects.create_user(
            username="resource-owner",
            password=None,
        )
        folder = Folder.objects.create(user=owner, name="Private folder")
        note = Note.objects.create(
            user=owner,
            folder=folder,
            title="Private note",
            note_type=Note.NoteType.STANDALONE,
        )

        token = self.make_token()
        note_response = self.client.get(
            f"/api/notes/{note.pk}/",
            HTTP_AUTHORIZATION=f"Bearer {token}",
        )
        folder_response = self.client.get(
            f"/api/folders/{folder.pk}/",
            HTTP_AUTHORIZATION=f"Bearer {token}",
        )

        self.assertEqual(note_response.status_code, 404)
        self.assertEqual(folder_response.status_code, 404)

    @override_settings(
        DEBUG=True,
        DJANGO_ENV="development",
        ENABLE_DEV_HEADER_AUTH=False,
    )
    def test_development_header_authentication_is_disabled_by_default(self):
        user = get_user_model().objects.create_user(username="dev-user")

        response = self.get_me(HTTP_X_DEV_USER=user.username)

        self.assertEqual(response.status_code, 401)

    @override_settings(
        DEBUG=True,
        DJANGO_ENV="development",
        ENABLE_DEV_HEADER_AUTH=True,
    )
    def test_development_header_authentication_requires_explicit_enablement(self):
        user = get_user_model().objects.create_user(username="dev-user")

        response = self.get_me(HTTP_X_DEV_USER=user.username)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["id"], user.pk)

    @override_settings(
        DEBUG=True,
        DJANGO_ENV="production",
        ENABLE_DEV_HEADER_AUTH=True,
    )
    def test_development_header_authentication_cannot_bypass_production(self):
        user = get_user_model().objects.create_user(username="dev-user")

        response = self.get_me(HTTP_X_DEV_USER=user.username)

        self.assertEqual(response.status_code, 401)
