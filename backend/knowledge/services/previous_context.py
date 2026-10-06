"""Exact and semantically related user knowledge for a video."""

from __future__ import annotations

import logging
import math
import re
import time
from dataclasses import dataclass
from datetime import datetime
from numbers import Real

from django.conf import settings
from django.db.models import F, Window
from django.db.models.functions import RowNumber
from pgvector.django import CosineDistance

from knowledge.models import KnowledgeChunk
from knowledge.services.retrieval import _get_query_vector
from notes.models import Note
from users.models import User
from videos.models import Video, VideoAnalysis

logger = logging.getLogger("django.request")


DEFAULT_MAX_EXACT = 5
DEFAULT_MAX_RELATED = 5
DEFAULT_RELEVANCE_THRESHOLD = 0.35
MAX_CONCEPTS_PER_CATEGORY = 10
MAX_CONCEPT_PERSONAL_NOTES = DEFAULT_MAX_RELATED


def _log_timing(youtube_id: str, stage: str, started_at: float) -> None:
    if settings.DEBUG:
        logger.info(
            "previous_context_timing youtube_id=%s stage=%s elapsed_ms=%.3f",
            youtube_id,
            stage,
            (time.perf_counter() - started_at) * 1000,
        )


@dataclass(frozen=True)
class ExactVideoContext:
    note_id: int
    title: str
    content: str
    video_id: int
    youtube_id: str
    folder_id: int | None
    note_type: str
    created_at: datetime
    updated_at: datetime
    source: str = "EXACT_VIDEO"


@dataclass(frozen=True)
class RelatedPersonalContext:
    chunk_id: int
    note_id: int
    title: str
    content: str
    video_id: int | None
    folder_id: int | None
    distance: float
    source: str = "RELATED_PERSONAL"


@dataclass(frozen=True)
class PreviousContext:
    video_id: int
    youtube_id: str
    exact: tuple[ExactVideoContext, ...]
    related: tuple[RelatedPersonalContext, ...]
    concepts: ConceptContext


@dataclass(frozen=True)
class ConceptKnowledge:
    name: str
    type: str
    has_previous_knowledge: bool
    related_count: int
    reason: str | None
    evidence: str | None
    timestamps: tuple[ConceptTimestamp, ...]
    personal_notes: tuple[RelatedPersonalContext, ...]


@dataclass(frozen=True)
class ConceptTimestamp:
    seconds: float
    text: str


@dataclass(frozen=True)
class ConceptSource:
    name: str
    source: object


@dataclass(frozen=True)
class ConceptContext:
    prerequisites: tuple[ConceptKnowledge, ...]
    upcoming: tuple[ConceptKnowledge, ...]


def _positive_limit(value: int, name: str) -> None:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(f"{name} must be a non-negative integer.")


def _note_content(note: Note) -> str:
    document = note.document
    blocks = document.get("blocks") if isinstance(document, dict) else None
    content_parts = []
    if isinstance(blocks, list):
        for block in blocks:
            if not isinstance(block, dict):
                continue
            content = block.get("content")
            if isinstance(content, str) and content.strip():
                content_parts.append(content.strip())
    if content_parts:
        return "\n\n".join(content_parts)
    return note.content.strip()


def _video_representation(*, user: User, video: Video) -> str:
    parts = [video.title.strip()] if video.title.strip() else []
    has_analysis_context = False
    try:
        analysis = video.analysis
    except VideoAnalysis.DoesNotExist:
        analysis = None

    if analysis is not None:
        for label, value in (
            ("Summary", analysis.summary),
            ("Topics", analysis.topics),
            ("Concepts", analysis.concepts),
            ("Key points", analysis.key_points),
        ):
            if isinstance(value, str) and value.strip():
                parts.append(f"{label}: {value.strip()}")
                has_analysis_context = True
            elif isinstance(value, list):
                text_values = []
                for item in value:
                    if isinstance(item, str) and item.strip():
                        text_values.append(item.strip())
                    elif isinstance(item, dict):
                        text = item.get("text")
                        if isinstance(text, str) and text.strip():
                            text_values.append(text.strip())
                if text_values:
                    parts.append(f"{label}: {'; '.join(text_values)}")
                    has_analysis_context = True

    has_transcript_context = False
    if not has_analysis_context:
        transcript = video.transcript
        if isinstance(transcript, list):
            transcript_text = [
                segment["text"].strip()
                for segment in transcript
                if isinstance(segment, dict)
                and isinstance(segment.get("text"), str)
                and segment["text"].strip()
            ]
            parts.extend(transcript_text[:5])
            has_transcript_context = bool(transcript_text)

    if not has_analysis_context and not has_transcript_context:
        transcript_chunks = KnowledgeChunk.objects.filter(
            user=user,
            video=video,
            source_type=KnowledgeChunk.SourceType.VIDEO_TRANSCRIPT,
        ).order_by("chunk_index", "pk")
        parts.extend(
            chunk.content.strip()
            for chunk in transcript_chunks[:5]
            if chunk.content.strip()
        )
    return "\n".join(parts).strip()[:4000]


def _normalize_concept_name(value: object) -> str | None:
    if value is None or isinstance(value, bool):
        return None

    if isinstance(value, str):
        normalized = " ".join(value.split())
        return normalized if normalized else None

    if isinstance(value, dict):
        for key in ("name", "concept", "title", "label", "value"):
            candidate = _normalize_concept_name(value.get(key))
            if candidate is not None:
                return candidate

        return _normalize_concept_name(value.get("text"))

    if isinstance(value, (list, tuple, set)):
        for item in value:
            candidate = _normalize_concept_name(item)
            if candidate is not None:
                return candidate
        return None

    return None


def _concept_sources(
    values: object,
    concept_type: str,
) -> tuple[ConceptSource, ...]:
    if not isinstance(values, list):
        return ()

    sources = []
    seen = set()
    for item in values:
        if isinstance(item, dict) and "type" in item:
            entry_type = item.get("type")
            if not isinstance(entry_type, str):
                continue
            normalized_type = entry_type.strip().casefold()
            if normalized_type not in {"prerequisite", "upcoming"}:
                continue
            if normalized_type != concept_type.casefold():
                continue
        name = _normalize_concept_name(item)
        if name is None:
            continue
        key = name.casefold()
        if key in seen:
            continue
        seen.add(key)
        sources.append(ConceptSource(name=name, source=item))
        if len(sources) == MAX_CONCEPTS_PER_CATEGORY:
            break
    return tuple(sources)


def _text_value(value: object) -> str | None:
    if isinstance(value, str):
        normalized = " ".join(value.split())
        return normalized if normalized else None
    if isinstance(value, (list, tuple)):
        parts = [
            text
            for item in value
            if (text := _text_value(item)) is not None
        ]
        return "\n".join(parts) if parts else None
    if isinstance(value, dict):
        for key in ("text", "evidence", "description", "definition"):
            text = _text_value(value.get(key))
            if text is not None:
                return text
    return None


def _metadata_text(source: object, keys: tuple[str, ...]) -> str | None:
    if not isinstance(source, dict):
        return None
    for key in keys:
        text = _text_value(source.get(key))
        if text is not None:
            return text
    return None


def _concept_mentioned(name: str, text: str) -> bool:
    words = [re.escape(word) for word in name.split()]
    pattern = r"(?<!\w)" + r"\s+".join(words) + r"(?!\w)"
    return re.search(pattern, text, flags=re.IGNORECASE) is not None


def _matching_concept_metadata(
    analysis: VideoAnalysis,
    name: str,
) -> tuple[str | None, tuple[str, ...]]:
    reason = None
    evidence = []
    concept_items = analysis.concepts
    if not isinstance(concept_items, list):
        return reason, ()

    for item in concept_items:
        item_name = _normalize_concept_name(item)
        if item_name is None or item_name.casefold() != name.casefold():
            continue
        if reason is None:
            reason = _metadata_text(
                item,
                ("reason", "rationale", "explanation", "why"),
            )
        for key in ("evidence", "description", "definition"):
            text = _metadata_text(item, (key,))
            if text is not None:
                evidence.append(text)
    return reason, tuple(evidence)


def _concept_analysis_details(
    analysis: VideoAnalysis,
    concept: ConceptSource,
) -> tuple[str | None, str | None, tuple[ConceptTimestamp, ...]]:
    reason = _metadata_text(
        concept.source,
        ("reason", "rationale", "explanation", "why"),
    )
    evidence = []
    explicit_evidence = _metadata_text(
        concept.source,
        ("evidence", "description", "definition"),
    )
    if explicit_evidence is not None:
        evidence.append(explicit_evidence)

    concept_reason, concept_evidence = _matching_concept_metadata(
        analysis,
        concept.name,
    )
    if reason is None:
        reason = concept_reason
    evidence.extend(concept_evidence)

    timestamps = []
    seen_timestamps = set()
    for field in ("key_points", "claims"):
        items = getattr(analysis, field)
        if not isinstance(items, list):
            continue
        for item in items:
            if not isinstance(item, dict):
                continue
            text = _text_value(item.get("text"))
            start = item.get("start")
            if (
                text is None
                or isinstance(start, bool)
                or not isinstance(start, Real)
                or not math.isfinite(start)
                or start < 0
                or not _concept_mentioned(concept.name, text)
            ):
                continue
            timestamp_key = (float(start), text.casefold())
            if timestamp_key not in seen_timestamps:
                seen_timestamps.add(timestamp_key)
                timestamps.append(
                    ConceptTimestamp(seconds=float(start), text=text)
                )
            evidence.append(text)

    unique_evidence = []
    seen_evidence = set()
    for text in evidence:
        key = text.casefold()
        if key not in seen_evidence:
            seen_evidence.add(key)
            unique_evidence.append(text)
    return reason, "\n".join(unique_evidence) or None, tuple(timestamps)


def _make_concept_knowledge(
    *,
    concept: ConceptSource,
    analysis: VideoAnalysis,
    concept_type: str,
    related_count: int,
    personal_notes: tuple[RelatedPersonalContext, ...] = (),
) -> ConceptKnowledge:
    reason, evidence, timestamps = _concept_analysis_details(
        analysis,
        concept,
    )
    return ConceptKnowledge(
        name=concept.name,
        type=concept_type,
        has_previous_knowledge=related_count > 0,
        related_count=related_count,
        reason=reason,
        evidence=evidence,
        timestamps=timestamps,
        personal_notes=personal_notes,
    )


def _concept_knowledge(
    *,
    user: User,
    video: Video,
    values: object,
    analysis: VideoAnalysis,
    concept_type: str,
    relevance_threshold: float,
) -> tuple[ConceptKnowledge, ...]:
    stage_started = time.perf_counter()
    concepts = _concept_sources(values, concept_type)
    if not concepts:
        _log_timing(
            video.youtube_id,
            f"concept_{concept_type.lower()}_processing",
            stage_started,
        )
        return ()

    candidates = KnowledgeChunk.objects.filter(
        user=user,
        note__isnull=False,
        note__user=user,
        source_type=KnowledgeChunk.SourceType.NOTE,
        embedding__isnull=False,
    )
    candidate_check_started = time.perf_counter()
    has_candidates = candidates.exists()
    _log_timing(
        video.youtube_id,
        f"concept_{concept_type.lower()}_candidate_check",
        candidate_check_started,
    )
    if not has_candidates:
        _log_timing(
            video.youtube_id,
            f"concept_{concept_type.lower()}_processing",
            stage_started,
        )
        return tuple(
            _make_concept_knowledge(
                concept=concept,
                analysis=analysis,
                concept_type=concept_type,
                related_count=0,
            )
            for concept in concepts
        )

    enriched_concepts = []
    for concept in concepts:
        embedding_started = time.perf_counter()
        query_vector = _get_query_vector(concept.name)
        _log_timing(
            video.youtube_id,
            f"concept_{concept_type.lower()}_embedding_generation",
            embedding_started,
        )
        retrieval_started = time.perf_counter()
        matching_note_count = (
            candidates.annotate(
                distance=CosineDistance("embedding", query_vector),
            )
            .filter(distance__lte=relevance_threshold)
            .values("note_id")
            .distinct()
            .count()
        )
        matching_note_chunks = ()
        if matching_note_count:
            best_chunk_per_note = (
                candidates.annotate(
                    distance=CosineDistance("embedding", query_vector),
                    note_rank=Window(
                        expression=RowNumber(),
                        partition_by=[F("note_id")],
                        order_by=[
                            F("distance").asc(),
                            F("pk").asc(),
                        ],
                    ),
                )
                .filter(
                    note_rank=1,
                    distance__lte=relevance_threshold,
                )
                .select_related("note")
                .order_by("distance", "note_id", "pk")[
                    :MAX_CONCEPT_PERSONAL_NOTES
                ]
            )
            matching_note_chunks = tuple(
                RelatedPersonalContext(
                    chunk_id=chunk.pk,
                    note_id=chunk.note_id,
                    title=chunk.note.title,
                    content=chunk.content,
                    video_id=chunk.video_id,
                    folder_id=chunk.folder_id,
                    distance=float(chunk.distance),
                )
                for chunk in best_chunk_per_note
            )
        _log_timing(
            video.youtube_id,
            f"concept_{concept_type.lower()}_pgvector_database_retrieval",
            retrieval_started,
        )
        enriched_concepts.append(
            _make_concept_knowledge(
                concept=concept,
                analysis=analysis,
                concept_type=concept_type,
                related_count=matching_note_count,
                personal_notes=matching_note_chunks,
            )
        )
    _log_timing(
        video.youtube_id,
        f"concept_{concept_type.lower()}_processing",
        stage_started,
    )
    return tuple(enriched_concepts)


def get_previous_context(
    user: User,
    video: Video,
    *,
    max_exact: int = DEFAULT_MAX_EXACT,
    max_related: int = DEFAULT_MAX_RELATED,
    relevance_threshold: float = DEFAULT_RELEVANCE_THRESHOLD,
) -> PreviousContext:
    """Return exact notes first, then related personal note chunks.

    Related results are sourced only from indexed NOTE chunks and are
    deduplicated to one best-matching chunk per note.
    """
    _positive_limit(max_exact, "max_exact")
    if max_exact == 0:
        raise ValueError("max_exact must be a positive integer.")
    _positive_limit(max_related, "max_related")
    if (
        isinstance(relevance_threshold, bool)
        or not isinstance(relevance_threshold, (int, float))
        or not math.isfinite(relevance_threshold)
        or not 0 <= relevance_threshold <= 2
    ):
        raise ValueError("relevance_threshold must be between 0 and 2.")
    if not isinstance(user, User):
        raise ValueError("user must be a User instance.")
    if not isinstance(video, Video) or video.pk is None:
        raise ValueError("video must be a saved Video instance.")

    exact_started = time.perf_counter()
    exact_notes = list(
        Note.objects.filter(
            user=user,
            video=video,
            note_type=Note.NoteType.VIDEO,
        )
        .select_related("folder")
        .order_by("-updated_at", "-created_at", "-pk")[:max_exact]
    )
    exact = tuple(
        ExactVideoContext(
            note_id=note.pk,
            title=note.title,
            content=_note_content(note),
            video_id=video.pk,
            youtube_id=video.youtube_id,
            folder_id=note.folder_id,
            note_type=note.note_type,
            created_at=note.created_at,
            updated_at=note.updated_at,
        )
        for note in exact_notes
    )
    _log_timing(video.youtube_id, "exact_video_note_query", exact_started)

    related: tuple[RelatedPersonalContext, ...] = ()
    related_started = time.perf_counter()
    if max_related and len(exact) < max_exact:
        representation_started = time.perf_counter()
        representation = _video_representation(user=user, video=video)
        _log_timing(
            video.youtube_id,
            "related_query_representation",
            representation_started,
        )
        candidates = KnowledgeChunk.objects.filter(
            user=user,
            note__isnull=False,
            source_type=KnowledgeChunk.SourceType.NOTE,
            embedding__isnull=False,
        ).exclude(note__video=video)

        candidate_check_started = time.perf_counter()
        has_candidates = candidates.exists() if representation else False
        _log_timing(
            video.youtube_id,
            "related_candidate_check",
            candidate_check_started,
        )
        if representation and has_candidates:
            embedding_started = time.perf_counter()
            query_vector = _get_query_vector(representation)
            _log_timing(
                video.youtube_id,
                "related_query_embedding_generation",
                embedding_started,
            )
            retrieval_started = time.perf_counter()
            best_chunk_per_note = (
                candidates.annotate(
                    distance=CosineDistance("embedding", query_vector),
                    note_rank=Window(
                        expression=RowNumber(),
                        partition_by=[F("note_id")],
                        order_by=[
                            F("distance").asc(),
                            F("pk").asc(),
                        ],
                    ),
                )
                .filter(note_rank=1, distance__lte=relevance_threshold)
                .select_related("note")
                .order_by("distance", "note_id", "pk")[:max_related]
            )
            related = tuple(
                RelatedPersonalContext(
                    chunk_id=chunk.pk,
                    note_id=chunk.note_id,
                    title=chunk.note.title,
                    content=chunk.content,
                    video_id=chunk.video_id,
                    folder_id=chunk.folder_id,
                    distance=float(chunk.distance),
                )
                for chunk in best_chunk_per_note
            )
            _log_timing(
                video.youtube_id,
                "related_pgvector_database_retrieval",
                retrieval_started,
            )
    _log_timing(video.youtube_id, "related_personal_retrieval", related_started)

    prerequisites: tuple[ConceptKnowledge, ...] = ()
    upcoming: tuple[ConceptKnowledge, ...] = ()
    concepts_started = time.perf_counter()
    if video.analysis_status == Video.AnalysisStatus.READY:
        try:
            analysis = video.analysis
        except VideoAnalysis.DoesNotExist:
            analysis = None
        if analysis is not None:
            prerequisites = _concept_knowledge(
                user=user,
                video=video,
                values=analysis.prerequisites,
                analysis=analysis,
                concept_type="PREREQUISITE",
                relevance_threshold=relevance_threshold,
            )
            upcoming = _concept_knowledge(
                user=user,
                video=video,
                values=analysis.upcoming_topics,
                analysis=analysis,
                concept_type="UPCOMING",
                relevance_threshold=relevance_threshold,
            )
    _log_timing(
        video.youtube_id,
        "concept_intelligence_processing",
        concepts_started,
    )

    assembly_started = time.perf_counter()
    context = PreviousContext(
        video_id=video.pk,
        youtube_id=video.youtube_id,
        exact=exact,
        related=related,
        concepts=ConceptContext(
            prerequisites=prerequisites,
            upcoming=upcoming,
        ),
    )
    _log_timing(video.youtube_id, "context_assembly", assembly_started)
    return context
