import json
from datetime import datetime, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
from uuid import uuid4

from django.test import TestCase
from django.utils.dateparse import parse_datetime

from folders.models import Folder
from notes.management.commands.import_legacy_notes import (
    _backup_snapshot,
    apply_import_plan,
    build_import_plan,
)
from notes.models import Note
from users.models import User
from videos.models import Video


CREATED_AT = datetime(2020, 1, 2, 3, 4, 5, tzinfo=timezone.utc)
UPDATED_AT = datetime(2020, 2, 3, 4, 5, 6, tzinfo=timezone.utc)


def folder_row(folder_id, name, parent_id=None):
    return {
        "id": folder_id,
        "user_id": 1,
        "name": name,
        "parent_id": parent_id,
        "description": f"description for {name}",
        "created_at": CREATED_AT.isoformat(),
        "updated_at": UPDATED_AT.isoformat(),
    }


def note_row(note_id, *, note_type=Note.NoteType.STANDALONE, folder=None, video=None):
    return {
        "id": note_id,
        "user_id": 1,
        "title": f"Legacy note {note_id}",
        "document": {
            "version": 1,
            "blocks": [
                {
                    "id": f"block-{note_id}",
                    "type": "paragraph",
                    "content": f"Complete content {note_id}",
                    "attributes": {"preserve": ["all", note_id]},
                }
            ],
        },
        "content": f"Legacy plain text {note_id}",
        "note_type": note_type,
        "folder_id": folder["id"] if folder else None,
        "video_id": video["id"] if video else None,
        "timestamp_seconds": 35 if note_type == Note.NoteType.VIDEO else None,
        "created_at": CREATED_AT.isoformat(),
        "updated_at": UPDATED_AT.isoformat(),
        "folder": folder,
        "video": video,
    }


def export_rows(*, folders=None, notes=None):
    return {
        "account": {"id": 1, "username": "devuser"},
        "folders": folders or [],
        "notes": notes or [],
    }


class LegacyNoteImportTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            username="destination",
            email="destination@example.com",
            supabase_uid=uuid4(),
        )

    def plan(self, export):
        return build_import_plan(
            export,
            self.user,
            list(Folder.objects.filter(user=self.user).order_by("pk")),
            list(Note.objects.filter(user=self.user).select_related("video").order_by("pk")),
            list(Video.objects.all()),
        )

    def test_dry_run_planning_does_not_write_any_records(self):
        export = export_rows(notes=[note_row(101)])
        plan = self.plan(export)

        self.assertEqual(plan.note_actions[0]["decision"], "import")
        self.assertEqual(Note.objects.count(), 0)
        self.assertEqual(Folder.objects.count(), 0)

    def test_exact_note_match_is_skipped_without_relying_on_title_alone(self):
        row = note_row(102)
        existing = Note.objects.create(
            user=self.user,
            title=row["title"],
            document=row["document"],
            content=row["content"],
            note_type=row["note_type"],
        )
        Note.objects.filter(pk=existing.pk).update(
            created_at=CREATED_AT,
            updated_at=UPDATED_AT,
        )
        plan = self.plan(export_rows(notes=[row]))

        self.assertEqual(plan.note_actions[0]["decision"], "duplicate")
        self.assertEqual(Note.objects.filter(user=self.user).count(), 1)

        different = note_row(103)
        different["title"] = row["title"]
        different["content"] = "Different note content"
        different_plan = self.plan(export_rows(notes=[different]))
        self.assertEqual(different_plan.note_actions[0]["decision"], "import")

    def test_folder_mapping_preserves_parentage_and_note_fields(self):
        root = folder_row(81, "Root")
        child = folder_row(82, "Child", 81)
        note = note_row(
            111,
            folder={"id": 82, "name": "Child", "parent_id": 81},
        )
        plan = self.plan(export_rows(folders=[child, root], notes=[note]))

        result = apply_import_plan(plan, self.user)

        root_folder = Folder.objects.get(user=self.user, name="Root")
        child_folder = Folder.objects.get(user=self.user, name="Child")
        imported = Note.objects.get(pk=result["notes"][0])
        self.assertEqual(child_folder.parent_id, root_folder.pk)
        self.assertEqual(imported.user_id, self.user.pk)
        self.assertEqual(imported.folder_id, child_folder.pk)
        self.assertEqual(imported.document, note["document"])
        self.assertEqual(imported.content, note["content"])
        self.assertEqual(imported.created_at, CREATED_AT)
        self.assertEqual(imported.updated_at, UPDATED_AT)

    def test_video_match_uses_youtube_id_not_legacy_primary_key(self):
        video = Video.objects.create(
            youtube_id="StableVideoID1",
            title="Destination video",
        )
        row = note_row(
            121,
            note_type=Note.NoteType.VIDEO,
            video={"id": 91001, "youtube_id": video.youtube_id},
        )
        plan = self.plan(export_rows(notes=[row]))

        self.assertEqual(plan.note_actions[0]["video"].pk, video.pk)
        result = apply_import_plan(plan, self.user)
        imported = Note.objects.get(pk=result["notes"][0])
        self.assertEqual(imported.video_id, video.pk)
        self.assertNotEqual(imported.video_id, row["video_id"])

    def test_existing_foreign_records_are_never_reassigned_or_changed(self):
        other_user = User.objects.create_user(
            username="other",
            email="other@example.com",
        )
        foreign_folder = Folder.objects.create(
            user=other_user,
            name="Other folder",
            description="Keep this unchanged",
        )
        foreign_note = Note.objects.create(
            user=other_user,
            title="Other note",
            document={"version": 1, "blocks": []},
            content="Keep this unchanged",
            note_type=Note.NoteType.STANDALONE,
            folder=foreign_folder,
        )
        plan = self.plan(export_rows(notes=[note_row(131)]))

        apply_import_plan(plan, self.user)

        foreign_note.refresh_from_db()
        foreign_folder.refresh_from_db()
        self.assertEqual(foreign_note.user_id, other_user.pk)
        self.assertEqual(foreign_note.content, "Keep this unchanged")
        self.assertEqual(foreign_folder.user_id, other_user.pk)
        self.assertEqual(foreign_folder.description, "Keep this unchanged")

    def test_unexpected_error_rolls_back_created_folders(self):
        root = folder_row(91, "Rollback root")
        note = note_row(
            141,
            folder={"id": 91, "name": "Rollback root", "parent_id": None},
        )
        plan = self.plan(export_rows(folders=[root], notes=[note]))

        with patch(
            "notes.management.commands.import_legacy_notes.Note.objects.create",
            side_effect=RuntimeError("simulated insert failure"),
        ):
            with self.assertRaises(RuntimeError):
                apply_import_plan(plan, self.user)

        self.assertFalse(Folder.objects.filter(user=self.user).exists())
        self.assertFalse(Note.objects.filter(user=self.user).exists())

    def test_missing_video_is_reported_and_video_note_is_not_imported(self):
        row = note_row(
            151,
            note_type=Note.NoteType.VIDEO,
            video={"id": 999, "youtube_id": "NoDestinationVideo"},
        )
        plan = self.plan(export_rows(notes=[row]))

        self.assertEqual(plan.note_actions[0]["decision"], "unresolved")
        self.assertIn(
            "video note has no verified destination video match",
            plan.note_actions[0]["reasons"],
        )
        self.assertFalse(apply_import_plan(plan, self.user)["notes"])

    def test_backup_preserves_database_timestamp_microseconds(self):
        note = Note.objects.create(
            user=self.user,
            title="Precision check",
            document={"version": 1, "blocks": []},
            content="",
            note_type=Note.NoteType.STANDALONE,
        )
        precise_time = datetime(
            2020,
            1,
            2,
            3,
            4,
            5,
            123456,
            tzinfo=timezone.utc,
        )
        Note.objects.filter(pk=note.pk).update(
            created_at=precise_time,
            updated_at=precise_time,
        )
        note.refresh_from_db()

        with TemporaryDirectory() as temporary_directory:
            backup_path = Path(temporary_directory) / "backup.json"
            _backup_snapshot(self.user, [], [note], backup_path)
            backup = json.loads(backup_path.read_text(encoding="utf-8"))

        self.assertEqual(
            parse_datetime(backup["notes"][0]["created_at"]),
            precise_time,
        )
        self.assertEqual(
            parse_datetime(backup["notes"][0]["updated_at"]),
            precise_time,
        )

    def test_only_approved_complete_video_metadata_creates_videos_and_notes(self):
        video_rows = {
            50: ("mViFYTwWvcM", "IBM video", "IBM Technology", "UCKWaEZ-_VweaEx1j62do_vQ", "@IBMTechnology", 539),
            51: ("uzzHKuimPas", "Equity video", "Ali Abdaal", "UChfo46ZNOV-vtehDc25A1Ug", "@LifestyleBusinessAcademy", 162),
            53: ("83HMZrhL_Uw", "AI & Music", "IBM Technology", "UCKWaEZ-_VweaEx1j62do_vQ", "@IBMTechnology", 1037),
            55: ("83HMZrhL_Uw", "AI & Music", "IBM Technology", "UCKWaEZ-_VweaEx1j62do_vQ", "@IBMTechnology", 1037),
            59: ("UQDdI7LZOsc", "AI Music Methods", "Paul J Lipsky", "UCmeU2DYiVy80wMBGZzEWnbw", "@PaulJLipsky", 826),
            63: ("pg19Z8LL06w", "Docker Crash Course", "TechWorld with Nana", "UCdngmbVKX1Tgre699-XLlUA", "@TechWorldwithNana", 4059),
            64: ("3c-iBn73dDE", "Docker Tutorial", "TechWorld with Nana", "UCdngmbVKX1Tgre699-XLlUA", "@TechWorldwithNana", 9975),
        }
        notes = []
        for note_id, metadata in video_rows.items():
            youtube_id, title, channel, channel_id, handle, duration = metadata
            row = note_row(
                note_id,
                note_type=Note.NoteType.VIDEO,
                video={
                    "id": 1000 + note_id,
                    "youtube_id": youtube_id,
                    "title": title,
                    "channel_name": channel,
                    "channel_id": channel_id,
                    "channel_handle": handle,
                    "thumbnail_url": (
                        f"https://i.ytimg.com/vi/{youtube_id}/hqdefault.jpg"
                    ),
                    "duration_seconds": duration,
                },
            )
            row["video_id"] = 1000 + note_id
            row["title"] = f"Legacy note {note_id}"
            notes.append(row)
        notes[3]["video"] = dict(notes[2]["video"])
        notes[3]["video"]["id"] = notes[3]["video_id"]

        plan = build_import_plan(
            export_rows(notes=notes),
            self.user,
            [],
            [],
            [],
            create_verified_videos=True,
        )

        self.assertEqual(
            sum(action["action"] == "create" for action in plan.video_actions),
            6,
        )
        self.assertEqual(
            [action["decision"] for action in plan.note_actions],
            ["import"] * 7,
        )
        result = apply_import_plan(plan, self.user)
        self.assertEqual(len(result["videos"]), 6)
        self.assertEqual(len(result["notes"]), 7)
        self.assertEqual(Video.objects.count(), 6)
        self.assertEqual(Note.objects.filter(user=self.user).count(), 7)
        self.assertEqual(
            Note.objects.get(title="Legacy note 53").video.youtube_id,
            Note.objects.get(title="Legacy note 55").video.youtube_id,
        )
