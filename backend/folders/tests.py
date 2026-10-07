from datetime import timedelta

from django.contrib.auth import get_user_model
from django.db import IntegrityError, transaction
from django.test import TestCase
from django.utils import timezone
from rest_framework.test import APIClient

from notes.models import Note
from videos.models import Video

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

    def test_database_rejects_duplicate_root_names_for_one_user(self):
        Folder.objects.create(user=self.user, name="Study")

        with self.assertRaises(IntegrityError):
            with transaction.atomic():
                Folder.objects.create(user=self.user, name="Study")

    def test_foreign_parent_is_rejected_without_creating_a_root(self):
        parent = Folder.objects.create(
            user=self.other_user,
            name="Foreign parent",
        )

        response = self.client.post(
            "/api/folders/",
            {"name": "Child", "parent": parent.pk},
            format="json",
        )

        self.assertEqual(response.status_code, 400)
        self.assertFalse(
            Folder.objects.filter(user=self.user, name="Child").exists(),
        )

    def test_nested_folders_can_be_created_without_a_depth_limit(self):
        root_response = self.client.post(
            "/api/folders/",
            {"name": "A", "parent": None},
            format="json",
        )
        self.assertEqual(root_response.status_code, 201)

        parent_id = root_response.data["id"]
        for name in ("B", "C", "D"):
            with self.subTest(name=name):
                response = self.client.post(
                    "/api/folders/",
                    {"name": name, "parent": parent_id},
                    format="json",
                )
                self.assertEqual(response.status_code, 201)
                parent_id = response.data["id"]

        self.assertEqual(
            list(Folder.objects.filter(user=self.user).values_list(
                "name",
                flat=True,
            )),
            ["A", "B", "C", "D"],
        )

    def test_duplicate_sibling_name_is_rejected(self):
        parent = Folder.objects.create(user=self.user, name="Parent")
        Folder.objects.create(user=self.user, name="Java", parent=parent)

        response = self.client.post(
            "/api/folders/",
            {"name": "Java", "parent": parent.pk},
            format="json",
        )

        self.assertEqual(response.status_code, 400)

    def test_same_name_is_allowed_under_different_parents(self):
        first_parent = Folder.objects.create(user=self.user, name="First")
        second_parent = Folder.objects.create(user=self.user, name="Second")

        first_response = self.client.post(
            "/api/folders/",
            {"name": "Java", "parent": first_parent.pk},
            format="json",
        )
        second_response = self.client.post(
            "/api/folders/",
            {"name": "Java", "parent": second_parent.pk},
            format="json",
        )

        self.assertEqual(first_response.status_code, 201)
        self.assertEqual(second_response.status_code, 201)
        self.assertEqual(first_response.data["parent"], first_parent.pk)
        self.assertEqual(second_response.data["parent"], second_parent.pk)

    def test_missing_parent_is_rejected(self):
        response = self.client.post(
            "/api/folders/",
            {"name": "Orphan", "parent": 999999},
            format="json",
        )

        self.assertEqual(response.status_code, 400)
        self.assertFalse(Folder.objects.filter(user=self.user, name="Orphan"))

    def test_create_accepts_explicit_null_parent(self):
        response = self.client.post(
            "/api/folders/",
            {"name": "Root", "parent": None},
            format="json",
        )

        self.assertEqual(response.status_code, 201)
        self.assertIsNone(response.data["parent"])

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

    def test_list_can_return_only_roots_or_children(self):
        root = Folder.objects.create(user=self.user, name="Root")
        child = Folder.objects.create(
            user=self.user,
            name="Child",
            parent=root,
        )
        other_root = Folder.objects.create(user=self.user, name="Other root")

        roots_response = self.client.get("/api/folders/?parent=null")
        children_response = self.client.get(
            f"/api/folders/?parent={root.pk}",
        )

        self.assertEqual(roots_response.status_code, 200)
        self.assertEqual(
            [item["id"] for item in roots_response.data],
            [other_root.pk, root.pk],
        )
        self.assertEqual(children_response.status_code, 200)
        self.assertEqual(
            [item["id"] for item in children_response.data],
            [child.pk],
        )

    def test_list_rejects_foreign_or_nonexistent_parent(self):
        foreign_parent = Folder.objects.create(
            user=self.other_user,
            name="Foreign parent",
        )

        for parent_id in (foreign_parent.pk, 999999):
            with self.subTest(parent_id=parent_id):
                response = self.client.get(
                    f"/api/folders/?parent={parent_id}",
                )
                self.assertEqual(response.status_code, 404)

    def test_list_rejects_invalid_parent_query(self):
        response = self.client.get("/api/folders/?parent=invalid")

        self.assertEqual(response.status_code, 400)


class FolderDetailAndNotesTests(TestCase):
    def setUp(self):
        user_model = get_user_model()
        self.user = user_model.objects.create_user(username="folder-detail-owner")
        self.other_user = user_model.objects.create_user(
            username="other-folder-detail-owner",
        )
        self.client = APIClient()
        self.client.force_authenticate(self.user)
        self.folder = Folder.objects.create(
            user=self.user,
            name="Programming",
            description="Programming notes",
        )
        self.other_folder = Folder.objects.create(
            user=self.user,
            name="Other",
        )
        self.foreign_folder = Folder.objects.create(
            user=self.other_user,
            name="Private folder",
        )

    def create_note(
        self,
        *,
        user=None,
        folder=None,
        title="Folder note",
        updated_at=None,
        video=None,
        timestamp_seconds=None,
        note_type=Note.NoteType.STANDALONE,
    ):
        note = Note.objects.create(
            user=user or self.user,
            title=title,
            content=f"{title} content",
            document={
                "version": 1,
                "blocks": [
                    {
                        "id": f"block-{title}",
                        "type": "paragraph",
                        "content": f"{title} content",
                    }
                ],
            },
            note_type=note_type,
            folder=folder,
            video=video,
            timestamp_seconds=timestamp_seconds,
        )
        if updated_at is not None:
            Note.objects.filter(pk=note.pk).update(updated_at=updated_at)
            note.refresh_from_db()
        return note

    def test_authenticated_user_can_retrieve_own_folder_with_shape(self):
        response = self.client.get(f"/api/folders/{self.folder.pk}/")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            set(response.data),
            {
                "id",
                "name",
                "description",
                "parent",
                "created_at",
                "updated_at",
                "breadcrumbs",
            },
        )
        self.assertEqual(response.data["id"], self.folder.pk)
        self.assertEqual(response.data["name"], "Programming")
        self.assertEqual(response.data["description"], "Programming notes")
        self.assertIsNone(response.data["parent"])
        self.assertEqual(
            response.data["breadcrumbs"],
            [{"id": self.folder.pk, "name": "Programming"}],
        )
        self.assertNotIn("user", response.data)

    def test_detail_breadcrumbs_are_ordered_root_to_current(self):
        java = Folder.objects.create(
            user=self.user,
            name="Java",
            parent=self.folder,
        )
        dsa = Folder.objects.create(
            user=self.user,
            name="DSA",
            parent=java,
        )
        oop = Folder.objects.create(
            user=self.user,
            name="OOP",
            parent=dsa,
        )

        response = self.client.get(f"/api/folders/{oop.pk}/")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.data["breadcrumbs"],
            [
                {"id": self.folder.pk, "name": "Programming"},
                {"id": java.pk, "name": "Java"},
                {"id": dsa.pk, "name": "DSA"},
                {"id": oop.pk, "name": "OOP"},
            ],
        )

    def test_breadcrumbs_do_not_expose_foreign_parent_names(self):
        child = Folder.objects.create(
            user=self.user,
            name="Owned child",
            parent=self.foreign_folder,
        )

        response = self.client.get(f"/api/folders/{child.pk}/")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.data["breadcrumbs"],
            [{"id": child.pk, "name": "Owned child"}],
        )
        self.assertNotIn(self.foreign_folder.name, str(response.data))

    def test_foreign_folder_detail_is_not_found(self):
        response = self.client.get(
            f"/api/folders/{self.foreign_folder.pk}/",
        )

        self.assertEqual(response.status_code, 404)
        self.assertNotIn(self.foreign_folder.name, str(response.data))

    def test_nonexistent_folder_detail_is_not_found(self):
        response = self.client.get("/api/folders/999999/")

        self.assertEqual(response.status_code, 404)

    def test_unauthenticated_folder_detail_and_notes_are_rejected(self):
        self.client.force_authenticate(user=None)

        detail_response = self.client.get(f"/api/folders/{self.folder.pk}/")
        notes_response = self.client.get(
            f"/api/folders/{self.folder.pk}/notes/",
        )

        self.assertIn(detail_response.status_code, (401, 403))
        self.assertIn(notes_response.status_code, (401, 403))

    def test_folder_notes_include_only_owned_notes_for_requested_folder(self):
        own_note = self.create_note(folder=self.folder, title="Own note")
        self.create_note(folder=self.other_folder, title="Other folder note")
        self.create_note(
            user=self.other_user,
            folder=self.folder,
            title="Foreign user's note",
        )

        response = self.client.get(
            f"/api/folders/{self.folder.pk}/notes/",
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual([item["id"] for item in response.data], [own_note.pk])
        self.assertNotIn("Other folder note", str(response.data))
        self.assertNotIn("Foreign user's note", str(response.data))

    def test_foreign_folder_notes_are_not_found(self):
        self.create_note(
            user=self.other_user,
            folder=self.foreign_folder,
            title="Private note",
        )

        response = self.client.get(
            f"/api/folders/{self.foreign_folder.pk}/notes/",
        )

        self.assertEqual(response.status_code, 404)
        self.assertNotIn("Private note", str(response.data))

    def test_empty_folder_returns_empty_notes_array(self):
        response = self.client.get(
            f"/api/folders/{self.folder.pk}/notes/",
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data, [])

    def test_folder_notes_are_ordered_by_updated_at_and_id(self):
        same_time = timezone.now()
        older_note = self.create_note(
            folder=self.folder,
            title="Older",
            updated_at=same_time - timedelta(days=1),
        )
        same_time_first_id = self.create_note(
            folder=self.folder,
            title="Same time first",
            updated_at=same_time,
        )
        same_time_second_id = self.create_note(
            folder=self.folder,
            title="Same time second",
            updated_at=same_time,
        )

        response = self.client.get(
            f"/api/folders/{self.folder.pk}/notes/",
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            [item["id"] for item in response.data],
            [same_time_second_id.pk, same_time_first_id.pk, older_note.pk],
        )

    def test_folder_notes_preserve_note_serializer_fields_and_video_metadata(self):
        video = Video.objects.create(
            youtube_id="folder12345",
            title="Folder video",
            channel_name="Learning Channel",
            channel_handle="@learning",
            thumbnail_url="https://example.com/folder-video.jpg",
        )
        note = self.create_note(
            folder=self.folder,
            title="Video note",
            video=video,
            timestamp_seconds=92,
            note_type=Note.NoteType.VIDEO,
        )

        response = self.client.get(
            f"/api/folders/{self.folder.pk}/notes/",
        )

        self.assertEqual(response.status_code, 200)
        returned_note = response.data[0]
        self.assertEqual(returned_note["id"], note.pk)
        self.assertEqual(
            set(returned_note),
            {
                "id",
                "title",
                "document",
                "content",
                "note_type",
                "folder",
                "folder_path",
                "video",
                "video_detail",
                "timestamp_seconds",
                "created_at",
                "updated_at",
            },
        )
        self.assertEqual(returned_note["note_type"], Note.NoteType.VIDEO)
        self.assertEqual(returned_note["folder"], self.folder.pk)
        self.assertEqual(
            returned_note["folder_path"],
            [{"id": self.folder.pk, "name": self.folder.name}],
        )
        self.assertEqual(returned_note["video"], video.pk)
        self.assertEqual(returned_note["timestamp_seconds"], 92)
        self.assertEqual(returned_note["document"], note.document)
        self.assertEqual(
            returned_note["video_detail"],
            {
                "id": video.pk,
                "youtube_id": video.youtube_id,
                "title": video.title,
                "channel_name": video.channel_name,
                "channel_handle": video.channel_handle,
                "thumbnail_url": video.thumbnail_url,
            },
        )


class FolderManagementTests(TestCase):
    def setUp(self):
        user_model = get_user_model()
        self.user = user_model.objects.create_user(username="folder-manager")
        self.other_user = user_model.objects.create_user(
            username="other-folder-manager",
        )
        self.client = APIClient()
        self.client.force_authenticate(self.user)
        self.folder = Folder.objects.create(user=self.user, name="Java")
        self.other_folder = Folder.objects.create(
            user=self.user,
            name="Python",
        )
        self.foreign_folder = Folder.objects.create(
            user=self.other_user,
            name="Private",
        )

    def test_owner_can_rename_folder_and_trim_name(self):
        response = self.client.patch(
            f"/api/folders/{self.other_folder.pk}/",
            {
                "name": "  Rust  ",
                "description": "Must remain unchanged",
                "parent": self.folder.pk,
                "user": self.other_user.pk,
            },
            format="json",
        )

        self.assertEqual(response.status_code, 200)
        self.other_folder.refresh_from_db()
        self.assertEqual(self.other_folder.name, "Rust")
        self.assertEqual(self.other_folder.description, "")
        self.assertIsNone(self.other_folder.parent)
        self.assertEqual(self.other_folder.user, self.user)
        self.assertNotIn("user", response.data)

    def test_rename_rejects_blank_and_overlength_names(self):
        for name in ("", " \t\n ", "x" * 256):
            with self.subTest(name=name[:20]):
                response = self.client.patch(
                    f"/api/folders/{self.other_folder.pk}/",
                    {"name": name},
                    format="json",
                )
                self.assertEqual(response.status_code, 400)

    def test_rename_rejects_duplicate_root_name(self):
        response = self.client.patch(
            f"/api/folders/{self.other_folder.pk}/",
            {"name": "Java"},
            format="json",
        )

        self.assertEqual(response.status_code, 400)

    def test_rename_preserves_parent_and_rejects_duplicate_sibling(self):
        child = Folder.objects.create(
            user=self.user,
            name="Child",
            parent=self.folder,
        )
        sibling = Folder.objects.create(
            user=self.user,
            name="Sibling",
            parent=self.folder,
        )

        rename_response = self.client.patch(
            f"/api/folders/{child.pk}/",
            {"name": "Renamed", "parent": None},
            format="json",
        )
        duplicate_response = self.client.patch(
            f"/api/folders/{child.pk}/",
            {"name": sibling.name},
            format="json",
        )

        self.assertEqual(rename_response.status_code, 200)
        self.assertEqual(rename_response.data["parent"], self.folder.pk)
        child.refresh_from_db()
        self.assertEqual(child.parent, self.folder)
        self.assertEqual(duplicate_response.status_code, 400)

    def test_folder_can_be_renamed_to_its_current_name(self):
        response = self.client.patch(
            f"/api/folders/{self.folder.pk}/",
            {"name": " Java "},
            format="json",
        )

        self.assertEqual(response.status_code, 200)
        self.folder.refresh_from_db()
        self.assertEqual(self.folder.name, "Java")

    def test_same_name_is_allowed_for_a_different_user(self):
        response = self.client.patch(
            f"/api/folders/{self.other_folder.pk}/",
            {"name": "Private"},
            format="json",
        )

        self.assertEqual(response.status_code, 200)

    def test_foreign_and_nonexistent_folders_cannot_be_renamed(self):
        foreign_response = self.client.patch(
            f"/api/folders/{self.foreign_folder.pk}/",
            {"name": "Changed"},
            format="json",
        )
        missing_response = self.client.patch(
            "/api/folders/999999/",
            {"name": "Changed"},
            format="json",
        )

        self.assertEqual(foreign_response.status_code, 404)
        self.assertEqual(missing_response.status_code, 404)
        self.foreign_folder.refresh_from_db()
        self.assertEqual(self.foreign_folder.name, "Private")

    def test_unauthenticated_rename_is_rejected(self):
        self.client.force_authenticate(user=None)

        response = self.client.patch(
            f"/api/folders/{self.folder.pk}/",
            {"name": "Changed"},
            format="json",
        )

        self.assertIn(response.status_code, (401, 403))

    def test_owner_can_delete_folder_and_notes_become_unassigned(self):
        note = Note.objects.create(
            user=self.user,
            title="Survives deletion",
            content="Note content",
            note_type=Note.NoteType.STANDALONE,
            folder=self.folder,
        )

        response = self.client.delete(f"/api/folders/{self.folder.pk}/")

        self.assertEqual(response.status_code, 204)
        self.assertFalse(Folder.objects.filter(pk=self.folder.pk).exists())
        note.refresh_from_db()
        self.assertIsNone(note.folder)
        self.assertTrue(Note.objects.filter(pk=note.pk).exists())

    def test_owner_can_delete_leaf_child_folder(self):
        child = Folder.objects.create(
            user=self.user,
            name="Child",
            parent=self.folder,
        )

        response = self.client.delete(f"/api/folders/{child.pk}/")

        self.assertEqual(response.status_code, 204)
        self.assertFalse(Folder.objects.filter(pk=child.pk).exists())
        self.assertTrue(Folder.objects.filter(pk=self.folder.pk).exists())

    def test_foreign_and_nonexistent_folders_cannot_be_deleted(self):
        foreign_response = self.client.delete(
            f"/api/folders/{self.foreign_folder.pk}/",
        )
        missing_response = self.client.delete("/api/folders/999999/")

        self.assertEqual(foreign_response.status_code, 404)
        self.assertEqual(missing_response.status_code, 404)
        self.assertTrue(
            Folder.objects.filter(pk=self.foreign_folder.pk).exists(),
        )

    def test_unauthenticated_delete_is_rejected(self):
        self.client.force_authenticate(user=None)

        response = self.client.delete(f"/api/folders/{self.folder.pk}/")

        self.assertIn(response.status_code, (401, 403))
        self.assertTrue(Folder.objects.filter(pk=self.folder.pk).exists())

    def test_delete_is_rejected_when_folder_has_children(self):
        child = Folder.objects.create(
            user=self.user,
            name="Child",
            parent=self.folder,
        )

        response = self.client.delete(f"/api/folders/{self.folder.pk}/")

        self.assertEqual(response.status_code, 400)
        self.assertIn("contains subfolders", str(response.data))
        self.assertTrue(Folder.objects.filter(pk=self.folder.pk).exists())
        self.assertTrue(Folder.objects.filter(pk=child.pk).exists())
