import math
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.test import TestCase
from rest_framework import status
from rest_framework.test import APITestCase

from folders.models import Folder
from knowledge.models import KnowledgeChunk
from knowledge.services.embeddings import EMBEDDING_DIMENSION
from knowledge.services.previous_context import (
    DEFAULT_RELEVANCE_THRESHOLD,
    get_previous_context,
)
from notes.models import Note
from videos.models import Video, VideoAnalysis


PREVIOUS_CONTEXT_URL = "/api/knowledge/previous-context/"


def vector_with_similarity(similarity):
    vector = [0.0] * EMBEDDING_DIMENSION
    vector[0] = similarity
    vector[1] = math.sqrt(1 - similarity**2)
    return vector


class PreviousContextServiceTests(TestCase):
    def setUp(self):
        user_model = get_user_model()
        self.user = user_model.objects.create_user(
            username="previous-context-user",
        )
        self.other_user = user_model.objects.create_user(
            username="previous-context-other",
        )
        self.video = Video.objects.create(
            youtube_id="prevctx0001",
            title="Binary search explained",
        )
        self.folder = Folder.objects.create(
            user=self.user,
            name="Previous context folder",
        )
        self.query_vector = [0.0] * EMBEDDING_DIMENSION
        self.query_vector[0] = 1.0
        patcher = patch(
            "knowledge.services.previous_context._get_query_vector",
            side_effect=lambda _query: self.query_vector,
        )
        self.get_query_vector = patcher.start()
        self.addCleanup(patcher.stop)

    def create_note(
        self,
        *,
        user=None,
        title="A note",
        note_type=Note.NoteType.STANDALONE,
        video=None,
        folder=None,
        content="",
    ):
        return Note.objects.create(
            user=user or self.user,
            title=title,
            note_type=note_type,
            video=video,
            folder=folder,
            content=content,
            document={
                "version": 1,
                "blocks": [
                    {"id": "paragraph-1", "type": "paragraph", "content": content}
                ] if content else [],
            },
        )

    def create_note_chunk(
        self,
        note,
        *,
        content="Indexed note content",
        embedding=None,
        user=None,
        video=None,
        folder=None,
    ):
        return KnowledgeChunk.objects.create(
            user=user or note.user,
            note=note,
            video=video,
            folder=folder,
            content=content,
            content_type=KnowledgeChunk.ContentType.NOTE_BLOCK,
            source_type=KnowledgeChunk.SourceType.NOTE,
            embedding=embedding or self.query_vector,
        )

    def create_analysis(
        self,
        *,
        prerequisites=None,
        upcoming_topics=None,
        concepts=None,
    ):
        self.video.analysis_status = Video.AnalysisStatus.READY
        self.video.save(update_fields=["analysis_status", "updated_at"])
        return VideoAnalysis.objects.create(
            video=self.video,
            summary="Binary search divides a sorted search space.",
            concepts=concepts or [],
            prerequisites=prerequisites or [],
            upcoming_topics=upcoming_topics or [],
        )

    def set_query_embedding(self, query, vector):
        self.get_query_vector.side_effect = (
            lambda value: vector if value == query else self.query_vector
        )

    def test_exact_video_notes_are_owner_scoped_and_deterministically_ordered(self):
        older = self.create_note(
            title="Older exact",
            note_type=Note.NoteType.VIDEO,
            video=self.video,
            content="Older note content",
        )
        newer = self.create_note(
            title="Newer exact",
            note_type=Note.NoteType.VIDEO,
            video=self.video,
            content="Newer note content",
        )
        standalone = self.create_note(
            title="Standalone",
            content="Not tied to the video",
        )
        foreign = self.create_note(
            user=self.other_user,
            title="Another user's exact note",
            note_type=Note.NoteType.VIDEO,
            video=self.video,
        )
        Note.objects.filter(pk=older.pk).update(updated_at="2025-01-01T00:00:00Z")
        Note.objects.filter(pk=newer.pk).update(updated_at="2025-02-01T00:00:00Z")

        context = get_previous_context(
            self.user,
            self.video,
            max_exact=5,
            max_related=0,
        )

        self.assertEqual(
            [item.note_id for item in context.exact],
            [newer.pk, older.pk],
        )
        self.assertEqual(context.exact[0].title, "Newer exact")
        self.assertEqual(context.exact[0].content, "Newer note content")
        self.assertEqual(context.exact[0].video_id, self.video.pk)
        self.assertEqual(context.exact[0].youtube_id, self.video.youtube_id)
        self.assertEqual(context.exact[0].folder_id, None)
        self.assertEqual(context.exact[0].source, "EXACT_VIDEO")
        self.assertNotIn(standalone.pk, [item.note_id for item in context.exact])
        self.assertNotIn(foreign.pk, [item.note_id for item in context.exact])
        self.get_query_vector.assert_not_called()

    def test_related_personal_note_is_semantically_ranked_and_labeled(self):
        near_note = self.create_note(title="Related search note")
        near_chunk = self.create_note_chunk(
            near_note,
            content="A prior note about binary search trees.",
            embedding=vector_with_similarity(0.9),
        )
        farther_note = self.create_note(title="Another related note")
        farther_chunk = self.create_note_chunk(
            farther_note,
            content="A less similar note about searching.",
            embedding=vector_with_similarity(0.7),
        )
        unrelated_note = self.create_note(title="Unrelated testing note")
        self.create_note_chunk(
            unrelated_note,
            content="A note about backend test fixtures.",
            embedding=[0.0, 1.0] + [0.0] * (EMBEDDING_DIMENSION - 2),
        )

        context = get_previous_context(
            self.user,
            self.video,
            max_exact=3,
            max_related=3,
            relevance_threshold=0.35,
        )

        self.assertEqual(context.exact, ())
        self.assertEqual(
            [item.chunk_id for item in context.related],
            [near_chunk.pk, farther_chunk.pk],
        )
        self.assertEqual(
            [item.note_id for item in context.related],
            [near_note.pk, farther_note.pk],
        )
        self.assertTrue(
            all(item.source == "RELATED_PERSONAL" for item in context.related)
        )
        self.assertLess(
            context.related[0].distance,
            context.related[1].distance,
        )

    def test_related_results_exclude_foreign_and_non_note_video_chunks(self):
        own_note = self.create_note(title="My previous note")
        own_chunk = self.create_note_chunk(own_note)
        foreign_note = self.create_note(
            user=self.other_user,
            title="Foreign note",
        )
        self.create_note_chunk(foreign_note, user=self.other_user)
        KnowledgeChunk.objects.create(
            user=self.user,
            video=self.video,
            content="Transcript content",
            content_type=KnowledgeChunk.ContentType.TRANSCRIPT_CHUNK,
            source_type=KnowledgeChunk.SourceType.VIDEO_TRANSCRIPT,
            embedding=self.query_vector,
        )
        KnowledgeChunk.objects.create(
            user=self.user,
            video=self.video,
            content="Analysis content",
            content_type=KnowledgeChunk.ContentType.ANALYSIS_CHUNK,
            source_type=KnowledgeChunk.SourceType.VIDEO_ANALYSIS,
            embedding=self.query_vector,
        )

        context = get_previous_context(self.user, self.video)

        self.assertEqual(
            [item.chunk_id for item in context.related],
            [own_chunk.pk],
        )

    def test_exact_results_remain_primary_and_current_video_note_not_duplicated(self):
        exact_note = self.create_note(
            title="Exact video note",
            note_type=Note.NoteType.VIDEO,
            video=self.video,
            content="Exact context",
        )
        self.create_note_chunk(exact_note, video=self.video)
        related_note = self.create_note(title="Highly similar personal note")
        related_chunk = self.create_note_chunk(related_note)

        context = get_previous_context(self.user, self.video)

        self.assertEqual(
            [item.note_id for item in context.exact],
            [exact_note.pk],
        )
        self.assertEqual(
            [item.note_id for item in context.related],
            [related_note.pk],
        )
        self.assertNotIn(
            exact_note.pk,
            [item.note_id for item in context.related],
        )
        self.assertEqual(context.related[0].chunk_id, related_chunk.pk)

    def test_multiple_chunks_from_same_note_produce_one_related_note(self):
        note = self.create_note(title="Multiple indexed blocks")
        first_chunk = self.create_note_chunk(
            note,
            content="First block",
            embedding=vector_with_similarity(0.8),
        )
        self.create_note_chunk(
            note,
            content="Second block",
            embedding=vector_with_similarity(0.95),
        )

        context = get_previous_context(self.user, self.video)

        self.assertEqual(len(context.related), 1)
        self.assertNotEqual(context.related[0].chunk_id, first_chunk.pk)
        self.assertEqual(context.related[0].content, "Second block")

    def test_empty_video_knowledge_and_no_user_chunks_return_empty_related(self):
        context = get_previous_context(self.user, self.video)

        self.assertEqual(context.exact, ())
        self.assertEqual(context.related, ())
        self.get_query_vector.assert_not_called()

    def test_analysis_prerequisites_and_upcoming_topics_are_returned(self):
        self.create_analysis(
            prerequisites=["  Binary   Search ", "Time complexity"],
            upcoming_topics=["Balanced trees"],
        )

        context = get_previous_context(self.user, self.video)

        self.assertEqual(
            [item.name for item in context.concepts.prerequisites],
            ["Binary Search", "Time complexity"],
        )
        self.assertEqual(
            [item.type for item in context.concepts.prerequisites],
            ["PREREQUISITE", "PREREQUISITE"],
        )
        self.assertEqual(
            [item.name for item in context.concepts.upcoming],
            ["Balanced trees"],
        )
        self.assertEqual(context.concepts.upcoming[0].type, "UPCOMING")

    def test_relevant_user_note_satisfies_prerequisite_but_unrelated_does_not(self):
        self.create_analysis(
            prerequisites=["Binary Search", "Backend Testing"],
        )
        relevant_note = self.create_note(title="Binary search notes")
        relevant_chunk = self.create_note_chunk(
            relevant_note,
            content="Binary search divides a sorted search space.",
            embedding=self.query_vector,
        )
        unrelated_note = self.create_note(title="Testing notes")
        unrelated_vector = [0.0, 1.0] + [0.0] * (
            EMBEDDING_DIMENSION - 2
        )
        unrelated_chunk = self.create_note_chunk(
            unrelated_note,
            content="Backend unit testing.",
            embedding=unrelated_vector,
        )

        self.set_query_embedding(
            "Binary Search",
            self.query_vector,
        )
        self.set_query_embedding(
            "Backend Testing",
            [0.0, 0.0, 1.0] + [0.0] * (EMBEDDING_DIMENSION - 3),
        )

        context = get_previous_context(
            self.user,
            self.video,
            relevance_threshold=DEFAULT_RELEVANCE_THRESHOLD,
        )

        self.assertEqual(
            [item.chunk_id for item in context.related],
            [relevant_chunk.pk],
        )
        self.assertNotIn(
            unrelated_chunk.pk,
            [item.chunk_id for item in context.related],
        )
        self.assertEqual(
            [
                (
                    item.name,
                    item.has_previous_knowledge,
                    item.related_count,
                )
                for item in context.concepts.prerequisites
            ],
            [
                ("Binary Search", True, 1),
                ("Backend Testing", False, 0),
            ],
        )

    def test_concepts_include_stored_reason_evidence_timestamps_and_relevant_notes(
        self,
    ):
        self.create_analysis(
            prerequisites=[
                {
                    "name": "Binary Search",
                    "reason": "The video assumes the viewer knows binary search.",
                }
            ],
            upcoming_topics=[
                {
                    "name": "Binary Search Trees",
                    "reason": "The video indicates these will be covered next.",
                }
            ],
            concepts=[
                {
                    "concept": "Binary Search",
                    "definition": "A sorted search interval is repeatedly halved.",
                }
            ],
        )
        analysis = self.video.analysis
        analysis.key_points = [
            {
                "text": "Binary Search halves the sorted search interval.",
                "start": 12.5,
            },
            {"text": "The video then compares unrelated material.", "start": 18.0},
        ]
        analysis.claims = [
            {
                "text": "Binary Search has logarithmic time complexity.",
                "start": 15.0,
            }
        ]
        analysis.save(update_fields=["key_points", "claims"])

        first_note = self.create_note(title="Binary search notes")
        first_chunk = self.create_note_chunk(
            first_note,
            content="Personal notes on binary search.",
            embedding=vector_with_similarity(0.95),
        )
        self.create_note_chunk(
            first_note,
            content="A second indexed block from the same note.",
            embedding=vector_with_similarity(0.9),
        )
        second_note = self.create_note(title="Another binary search note")
        second_chunk = self.create_note_chunk(
            second_note,
            content="A second relevant personal note.",
            embedding=vector_with_similarity(0.8),
        )
        irrelevant_note = self.create_note(title="Unrelated note")
        self.create_note_chunk(
            irrelevant_note,
            content="Unrelated personal knowledge.",
            embedding=[0.0, 1.0] + [0.0] * (EMBEDDING_DIMENSION - 2),
        )
        self.set_query_embedding(
            "Binary Search Trees",
            [0.0, 0.0, 1.0] + [0.0] * (EMBEDDING_DIMENSION - 3),
        )

        context = get_previous_context(
            self.user,
            self.video,
            max_related=0,
        )

        prerequisite = context.concepts.prerequisites[0]
        self.assertEqual(
            prerequisite.reason,
            "The video assumes the viewer knows binary search.",
        )
        self.assertEqual(
            prerequisite.evidence,
            (
                "A sorted search interval is repeatedly halved.\n"
                "Binary Search halves the sorted search interval.\n"
                "Binary Search has logarithmic time complexity."
            ),
        )
        self.assertEqual(
            [(item.seconds, item.text) for item in prerequisite.timestamps],
            [
                (12.5, "Binary Search halves the sorted search interval."),
                (15.0, "Binary Search has logarithmic time complexity."),
            ],
        )
        self.assertEqual(
            [item.chunk_id for item in prerequisite.personal_notes],
            [first_chunk.pk, second_chunk.pk],
        )
        self.assertEqual(prerequisite.related_count, 2)
        self.assertEqual(
            context.concepts.upcoming[0].reason,
            "The video indicates these will be covered next.",
        )
        self.assertEqual(context.concepts.upcoming[0].personal_notes, ())
        self.assertEqual(self.get_query_vector.call_count, 2)

        repeated_context = get_previous_context(
            self.user,
            self.video,
            max_related=0,
        )
        self.assertEqual(repeated_context.concepts, context.concepts)

    def test_concept_without_analysis_metadata_has_no_fabricated_enrichment(self):
        self.create_analysis(prerequisites=["Binary Search"])

        context = get_previous_context(self.user, self.video)

        concept = context.concepts.prerequisites[0]
        self.assertIsNone(concept.reason)
        self.assertIsNone(concept.evidence)
        self.assertEqual(concept.timestamps, ())
        self.assertEqual(concept.personal_notes, ())
        self.get_query_vector.assert_not_called()

    def test_metadata_without_a_concept_name_does_not_create_a_concept(self):
        self.create_analysis(
            prerequisites=[
                {
                    "reason": "The video assumes prior knowledge.",
                    "evidence": "An analysis detail with no concept identity.",
                }
            ],
        )

        context = get_previous_context(self.user, self.video)

        self.assertEqual(context.concepts.prerequisites, ())
        self.get_query_vector.assert_not_called()

    def test_personal_notes_cannot_create_unrecorded_concepts(self):
        self.create_analysis()
        note = self.create_note(title="Binary search notes")
        self.create_note_chunk(note)

        context = get_previous_context(
            self.user,
            self.video,
            max_related=0,
        )

        self.assertEqual(context.concepts.prerequisites, ())
        self.assertEqual(context.concepts.upcoming, ())
        self.get_query_vector.assert_not_called()

    def test_another_users_note_cannot_satisfy_a_concept(self):
        self.create_analysis(prerequisites=["Binary Search"])
        foreign_note = self.create_note(
            user=self.other_user,
            title="Another user's note",
        )
        self.create_note_chunk(
            foreign_note,
            user=self.other_user,
            embedding=self.query_vector,
        )

        context = get_previous_context(self.user, self.video)

        self.assertFalse(
            context.concepts.prerequisites[0].has_previous_knowledge
        )
        self.assertEqual(
            context.concepts.prerequisites[0].related_count,
            0,
        )

    def test_exact_video_note_can_support_concept_knowledge(self):
        self.create_analysis(prerequisites=["Binary Search"])
        exact_note = self.create_note(
            title="Video note about binary search",
            note_type=Note.NoteType.VIDEO,
            video=self.video,
        )
        self.create_note_chunk(exact_note, video=self.video)

        context = get_previous_context(self.user, self.video)

        self.assertTrue(
            context.concepts.prerequisites[0].has_previous_knowledge
        )
        self.assertEqual(
            context.concepts.prerequisites[0].related_count,
            1,
        )

    def test_duplicate_concepts_are_normalized_and_deduplicated_in_order(self):
        self.create_analysis(
            prerequisites=[
                "  Binary   Search ",
                "binary search",
                " Time Complexity ",
                {"name": "time   complexity"},
            ],
            upcoming_topics=["Balanced trees", " balanced   TREES "],
        )

        context = get_previous_context(self.user, self.video)

        self.assertEqual(
            [item.name for item in context.concepts.prerequisites],
            ["Binary Search", "Time Complexity"],
        )
        self.assertEqual(
            [item.name for item in context.concepts.upcoming],
            ["Balanced trees"],
        )
        self.get_query_vector.assert_not_called()

    def test_structured_concept_entries_use_name_fields_without_merging_unrelated_items(self):
        self.create_analysis(
            prerequisites=[
                {"name": " Binary   Search ", "reason": "Assumes prerequisite."},
                {"concept": {"name": "binary search"}},
                {"name": "Time complexity", "evidence": "Complexity is discussed."},
                {"name": "Time   complexity"},
                {"name": "Binary Search Tree", "reason": "Different concept."},
            ],
            upcoming_topics=[
                {"title": " balanced   trees "},
                "Balanced trees",
                {"name": "Sorting"},
            ],
        )

        context = get_previous_context(self.user, self.video)

        self.assertEqual(
            [item.name for item in context.concepts.prerequisites],
            ["Binary Search", "Time complexity", "Binary Search Tree"],
        )
        self.assertEqual(
            [item.name for item in context.concepts.upcoming],
            ["balanced trees", "Sorting"],
        )
        self.assertEqual(
            [item.name for item in context.concepts.prerequisites if item.name == "Binary Search"],
            ["Binary Search"],
        )

    def test_same_name_can_be_a_prerequisite_and_upcoming_concept(self):
        self.create_analysis(
            prerequisites=[
                "Binary Search",
                " binary   search ",
                {"name": "binary SEARCH", "type": "prerequisite"},
                {"name": "Binary Search", "type": "unrecognized"},
                {"name": "Binary Search", "type": "upcoming"},
            ],
            upcoming_topics=[
                "Binary Search",
                {"name": " binary   search ", "type": "upcoming"},
                {"name": "Binary Search", "type": "prerequisite"},
            ],
        )

        context = get_previous_context(self.user, self.video)

        self.assertEqual(
            [item.name for item in context.concepts.prerequisites],
            ["Binary Search"],
        )
        self.assertEqual(
            [item.name for item in context.concepts.upcoming],
            ["Binary Search"],
        )
        self.assertEqual(
            [item.type for item in context.concepts.prerequisites],
            ["PREREQUISITE"],
        )
        self.assertEqual(
            [item.type for item in context.concepts.upcoming],
            ["UPCOMING"],
        )
        self.get_query_vector.assert_not_called()

    def test_unavailable_or_not_ready_analysis_has_no_concept_context(self):
        analysis = self.create_analysis(
            prerequisites=["Binary Search"],
            upcoming_topics=["Balanced trees"],
        )
        self.video.analysis_status = Video.AnalysisStatus.ANALYZING
        self.video.save(update_fields=["analysis_status", "updated_at"])

        context = get_previous_context(self.user, self.video)

        self.assertEqual(context.concepts.prerequisites, ())
        self.assertEqual(context.concepts.upcoming, ())
        self.assertEqual(analysis.prerequisites, ["Binary Search"])
        self.get_query_vector.assert_not_called()

    def test_exact_and_related_context_remain_separate_with_concepts(self):
        self.create_analysis(prerequisites=["Binary Search"])
        exact_note = self.create_note(
            title="Exact video note",
            note_type=Note.NoteType.VIDEO,
            video=self.video,
        )
        related_note = self.create_note(title="Related personal note")
        related_chunk = self.create_note_chunk(related_note)

        context = get_previous_context(self.user, self.video)

        self.assertEqual(
            [item.note_id for item in context.exact],
            [exact_note.pk],
        )
        self.assertEqual(
            [item.chunk_id for item in context.related],
            [related_chunk.pk],
        )
        self.assertEqual(
            context.concepts.prerequisites[0].name,
            "Binary Search",
        )


class PreviousContextAPITests(APITestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(
            username="previous-context-api-user",
        )
        self.other_user = get_user_model().objects.create_user(
            username="previous-context-api-other",
        )
        self.video = Video.objects.create(
            youtube_id="prevctx0001",
            title="Video title",
        )
        self.client.force_authenticate(self.user)

    @patch("knowledge.services.previous_context._get_query_vector")
    def test_authenticated_request_returns_exact_and_related_provenance(
        self,
        get_query_vector,
    ):
        get_query_vector.return_value = [1.0] + [0.0] * (
            EMBEDDING_DIMENSION - 1
        )
        exact_note = Note.objects.create(
            user=self.user,
            title="Exact note",
            note_type=Note.NoteType.VIDEO,
            video=self.video,
            content="Exact note text",
            document={"version": 1, "blocks": []},
        )
        related_note = Note.objects.create(
            user=self.user,
            title="Related note",
            note_type=Note.NoteType.STANDALONE,
            document={"version": 1, "blocks": []},
        )
        related_chunk = KnowledgeChunk.objects.create(
            user=self.user,
            note=related_note,
            content="A related saved note.",
            content_type=KnowledgeChunk.ContentType.NOTE_BLOCK,
            source_type=KnowledgeChunk.SourceType.NOTE,
            embedding=get_query_vector.return_value,
        )
        response = self.client.get(
            PREVIOUS_CONTEXT_URL,
            {"youtube_id": self.video.youtube_id},
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data["video"]["id"], self.video.pk)
        self.assertEqual(
            response.data["video"]["youtube_id"],
            self.video.youtube_id,
        )
        self.assertEqual(response.data["exact"][0]["note_id"], exact_note.pk)
        self.assertEqual(response.data["exact"][0]["source"], "EXACT_VIDEO")
        self.assertIn("content", response.data["exact"][0])
        self.assertIn("updated_at", response.data["exact"][0])
        self.assertEqual(response.data["related"][0]["chunk_id"], related_chunk.pk)
        self.assertEqual(response.data["related"][0]["note_id"], related_note.pk)
        self.assertEqual(
            response.data["related"][0]["source"],
            "RELATED_PERSONAL",
        )
        self.assertEqual(
            response.data["concepts"],
            {"prerequisites": [], "upcoming": []},
        )

    @patch("knowledge.services.previous_context._get_query_vector")
    def test_api_includes_concept_context(self, get_query_vector):
        get_query_vector.return_value = [1.0] + [0.0] * (
            EMBEDDING_DIMENSION - 1
        )
        VideoAnalysis.objects.create(
            video=self.video,
            prerequisites=["Binary Search"],
            upcoming_topics=["Balanced trees"],
        )
        self.video.analysis_status = Video.AnalysisStatus.READY
        self.video.save(update_fields=["analysis_status", "updated_at"])

        response = self.client.get(
            PREVIOUS_CONTEXT_URL,
            {"youtube_id": self.video.youtube_id},
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(
            response.data["concepts"],
            {
                "prerequisites": [
                    {
                        "name": "Binary Search",
                        "type": "PREREQUISITE",
                        "has_previous_knowledge": False,
                        "related_count": 0,
                        "reason": None,
                        "evidence": None,
                        "timestamps": [],
                        "personal_notes": [],
                    },
                ],
                "upcoming": [
                    {
                        "name": "Balanced trees",
                        "type": "UPCOMING",
                        "has_previous_knowledge": False,
                        "related_count": 0,
                        "reason": None,
                        "evidence": None,
                        "timestamps": [],
                        "personal_notes": [],
                    },
                ],
            },
        )

    @patch("knowledge.services.previous_context._get_query_vector")
    def test_api_concept_contract_filters_bad_types_and_is_deterministic(
        self,
        get_query_vector,
    ):
        get_query_vector.return_value = [1.0] + [0.0] * (
            EMBEDDING_DIMENSION - 1
        )
        VideoAnalysis.objects.create(
            video=self.video,
            prerequisites=[
                " Binary   Search ",
                {"name": "binary search"},
                {"name": "Binary Search", "type": "prerequisite"},
                {"name": "Ignored invalid type", "type": "related"},
                {"name": "Wrong category", "type": "upcoming"},
            ],
            upcoming_topics=[
                "Binary Search",
                {"name": " binary search ", "type": "upcoming"},
            ],
        )
        self.video.analysis_status = Video.AnalysisStatus.READY
        self.video.save(update_fields=["analysis_status", "updated_at"])

        first = self.client.get(
            PREVIOUS_CONTEXT_URL,
            {"youtube_id": self.video.youtube_id},
        )
        second = self.client.get(
            PREVIOUS_CONTEXT_URL,
            {"youtube_id": self.video.youtube_id},
        )

        self.assertEqual(first.status_code, status.HTTP_200_OK)
        self.assertEqual(second.status_code, status.HTTP_200_OK)
        self.assertEqual(first.data, second.data)
        self.assertEqual(
            set(first.data),
            {"video", "exact", "related", "concepts"},
        )
        self.assertEqual(
            [item["name"] for item in first.data["concepts"]["prerequisites"]],
            ["Binary Search"],
        )
        self.assertEqual(
            [item["name"] for item in first.data["concepts"]["upcoming"]],
            ["Binary Search"],
        )
        self.assertEqual(
            first.data["concepts"]["prerequisites"][0]["type"],
            "PREREQUISITE",
        )
        self.assertEqual(
            first.data["concepts"]["upcoming"][0]["type"],
            "UPCOMING",
        )
        for category in ("prerequisites", "upcoming"):
            for concept in first.data["concepts"][category]:
                self.assertIsInstance(concept["name"], str)
                self.assertIsInstance(concept["type"], str)
                self.assertIn(concept["type"], {"PREREQUISITE", "UPCOMING"})
                self.assertIsInstance(concept["has_previous_knowledge"], bool)
                self.assertIsInstance(concept["related_count"], int)
                self.assertGreaterEqual(concept["related_count"], 0)
                self.assertIsNone(concept["reason"])
                self.assertIsNone(concept["evidence"])
                self.assertIsInstance(concept["timestamps"], list)
                self.assertIsInstance(concept["personal_notes"], list)
        get_query_vector.assert_not_called()

    @patch("knowledge.services.previous_context._get_query_vector")
    @patch(
        "knowledge.services.previous_context._video_representation",
        return_value="",
    )
    def test_api_serializes_enriched_concept_fields(
        self,
        _video_representation,
        get_query_vector,
    ):
        query_vector = [1.0] + [0.0] * (EMBEDDING_DIMENSION - 1)
        get_query_vector.return_value = query_vector
        VideoAnalysis.objects.create(
            video=self.video,
            prerequisites=[
                {
                    "name": "Binary Search",
                    "reason": "The video assumes binary search knowledge.",
                }
            ],
            key_points=[
                {
                    "text": "Binary Search halves the interval.",
                    "start": 12.5,
                }
            ],
        )
        self.video.analysis_status = Video.AnalysisStatus.READY
        self.video.save(update_fields=["analysis_status", "updated_at"])
        note = Note.objects.create(
            user=self.user,
            title="Binary search notes",
            note_type=Note.NoteType.STANDALONE,
            document={"version": 1, "blocks": []},
        )
        chunk = KnowledgeChunk.objects.create(
            user=self.user,
            note=note,
            content="My personal binary search notes.",
            content_type=KnowledgeChunk.ContentType.NOTE_BLOCK,
            source_type=KnowledgeChunk.SourceType.NOTE,
            embedding=query_vector,
        )

        response = self.client.get(
            PREVIOUS_CONTEXT_URL,
            {"youtube_id": self.video.youtube_id},
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        concept = response.data["concepts"]["prerequisites"][0]
        self.assertEqual(
            concept["reason"],
            "The video assumes binary search knowledge.",
        )
        self.assertEqual(
            concept["evidence"],
            "Binary Search halves the interval.",
        )
        self.assertEqual(
            concept["timestamps"],
            [
                {
                    "seconds": 12.5,
                    "text": "Binary Search halves the interval.",
                }
            ],
        )
        self.assertEqual(
            concept["personal_notes"][0]["chunk_id"],
            chunk.pk,
        )
        self.assertEqual(
            concept["personal_notes"][0]["note_id"],
            note.pk,
        )
        self.assertEqual(
            concept["personal_notes"][0]["source"],
            "RELATED_PERSONAL",
        )
        get_query_vector.assert_called_once_with("Binary Search")

    def test_unauthenticated_request_is_rejected(self):
        self.client.force_authenticate(user=None)

        response = self.client.get(
            PREVIOUS_CONTEXT_URL,
            {"youtube_id": self.video.youtube_id},
        )

        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)

    def test_unknown_video_is_not_created(self):
        video_count = Video.objects.count()

        response = self.client.get(
            PREVIOUS_CONTEXT_URL,
            {"youtube_id": "unknown0001"},
        )

        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)
        self.assertEqual(Video.objects.count(), video_count)

    def test_invalid_youtube_id_is_rejected(self):
        response = self.client.get(
            PREVIOUS_CONTEXT_URL,
            {"youtube_id": "invalid"},
        )

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

    @patch("knowledge.services.previous_context._get_query_vector")
    def test_api_does_not_return_another_users_note(self, get_query_vector):
        get_query_vector.return_value = [1.0] + [0.0] * (
            EMBEDDING_DIMENSION - 1
        )
        foreign_note = Note.objects.create(
            user=self.other_user,
            title="Private note",
            note_type=Note.NoteType.STANDALONE,
            document={"version": 1, "blocks": []},
        )
        KnowledgeChunk.objects.create(
            user=self.other_user,
            note=foreign_note,
            content="Private content",
            content_type=KnowledgeChunk.ContentType.NOTE_BLOCK,
            source_type=KnowledgeChunk.SourceType.NOTE,
            embedding=get_query_vector.return_value,
        )

        response = self.client.get(
            PREVIOUS_CONTEXT_URL,
            {"youtube_id": self.video.youtube_id},
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data["exact"], [])
        self.assertEqual(response.data["related"], [])
