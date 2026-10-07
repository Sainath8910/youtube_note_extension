from django.contrib.auth import get_user_model
from django.test import TestCase
from rest_framework.test import APIClient

from .models import Folder


class FolderListCreateTests(TestCase):
    def setUp(self):
        user_model = get_user_model()
        self.user = user_model.objects.create_user(username="folder-owner")
        self.other_user = user_model.objects.create_user(
            username="other-folder-owner",
        )
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def test_list_returns_only_owned_folders_in_deterministic_order(self):
        second = Folder.objects.create(user=self.user, name="Beta")
        first = Folder.objects.create(user=self.user, name="Alpha")
        Folder.objects.create(user=self.other_user, name="Private")

        response = self.client.get("/api/folders/")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            [folder["id"] for folder in response.data],
            [first.pk, second.pk],
        )
        self.assertNotIn("Private", str(response.data))
        self.assertEqual(
            set(response.data[0]),
            {
                "id",
                "name",
                "description",
                "parent",
                "created_at",
                "updated_at",
            },
        )

    def test_create_assigns_authenticated_user_and_returns_root_folder(self):
        response = self.client.post(
            "/api/folders/",
            {
                "name": "Study",
                "description": "Learning notes",
                "user": self.other_user.pk,
            },
            format="json",
        )

        self.assertEqual(response.status_code, 201)
        folder = Folder.objects.get(pk=response.data["id"])
        self.assertEqual(folder.user, self.user)
        self.assertEqual(folder.name, "Study")
        self.assertEqual(folder.description, "Learning notes")
        self.assertIsNone(folder.parent)
        self.assertIsNone(response.data["parent"])
        self.assertNotIn("user", response.data)

    def test_create_rejects_blank_and_whitespace_only_names(self):
        for payload in ({}, {"name": ""}, {"name": " \t\n "}):
            name = payload.get("name", "<missing>")
            with self.subTest(name=name):
                response = self.client.post(
                    "/api/folders/",
                    payload,
                    format="json",
                )
                self.assertEqual(response.status_code, 400)

    def test_create_rejects_names_longer_than_model_maximum(self):
        response = self.client.post(
            "/api/folders/",
            {"name": "x" * 256},
            format="json",
        )

        self.assertEqual(response.status_code, 400)

    def test_create_trims_name_surrounding_whitespace(self):
        response = self.client.post(
            "/api/folders/",
            {"name": "  Study notes  "},
            format="json",
        )

        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.data["name"], "Study notes")

    def test_duplicate_root_name_is_rejected_for_same_user(self):
        Folder.objects.create(user=self.user, name="Study")

        response = self.client.post(
            "/api/folders/",
            {"name": "  Study  "},
            format="json",
        )

        self.assertEqual(response.status_code, 400)

    def test_same_root_name_is_allowed_for_different_users(self):
        Folder.objects.create(user=self.other_user, name="Study")

        response = self.client.post(
            "/api/folders/",
            {"name": "Study"},
            format="json",
        )

        self.assertEqual(response.status_code, 201)

    def test_foreign_parent_is_not_accepted_for_root_folder_creation(self):
        parent = Folder.objects.create(
            user=self.other_user,
            name="Foreign parent",
        )

        response = self.client.post(
            "/api/folders/",
            {"name": "Child", "parent": parent.pk},
            format="json",
        )

        self.assertEqual(response.status_code, 201)
        folder = Folder.objects.get(pk=response.data["id"])
        self.assertIsNone(folder.parent)

    def test_unauthenticated_list_and_create_are_rejected(self):
        self.client.force_authenticate(user=None)

        list_response = self.client.get("/api/folders/")
        create_response = self.client.post(
            "/api/folders/",
            {"name": "Study"},
            format="json",
        )

        self.assertIn(list_response.status_code, (401, 403))
        self.assertIn(create_response.status_code, (401, 403))
