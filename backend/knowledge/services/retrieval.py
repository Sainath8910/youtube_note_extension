"""User-scoped semantic retrieval over persisted knowledge chunks."""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass
from enum import StrEnum
from typing import Any

from django.db.models import F, Q
from pgvector.django import CosineDistance

from folders.models import Folder
from knowledge.models import KnowledgeChunk
from knowledge.services.embeddings import (
    EMBEDDING_DIMENSION,
    get_embedding_service,
)
from users.models import User
from videos.models import Video


class KnowledgeRetrievalError(Exception):
    """Raised when a retrieval request or its query embedding is invalid."""


class KnowledgeContextAccessError(KnowledgeRetrievalError):
    """Raised when a requested video or folder context is not accessible."""


class RetrievalScope(StrEnum):
    """Candidate-source scopes supported by knowledge retrieval.

    CURRENT_VIDEO and CURRENT_FOLDER restrict candidates to the exact context.
    PERSONAL_KB searches the authenticated user's knowledge corpus. COMBINED
    prioritizes the selected video's candidates before that user's broader
    knowledge corpus.
    """

    CURRENT_VIDEO = "current_video"
    CURRENT_FOLDER = "current_folder"
    PERSONAL_KB = "personal_kb"
    COMBINED = "combined"


@dataclass(frozen=True)
class RetrievalRequest:
    user: User
    query: str
    scope: RetrievalScope
    top_k: int = 5
    video: Video | None = None
    folder: Folder | None = None


@dataclass(frozen=True)
class RetrievalResult:
    chunk: KnowledgeChunk
    distance: float


def _validate_query(query: str) -> str:
    if not isinstance(query, str):
        raise KnowledgeRetrievalError("Query must be a string.")

    normalized_query = query.strip()
    if not normalized_query:
        raise KnowledgeRetrievalError("Query must not be empty.")
    return normalized_query


def _validate_top_k(top_k: int) -> None:
    if isinstance(top_k, bool) or not isinstance(top_k, int) or top_k <= 0:
        raise KnowledgeRetrievalError("top_k must be a positive integer.")


def _validate_query_vector(vector: Any) -> list[float]:
    if isinstance(vector, (str, bytes)) or not isinstance(vector, Sequence):
        raise KnowledgeRetrievalError(
            "Embedding service returned no usable query vector."
        )
    if len(vector) != EMBEDDING_DIMENSION:
        raise KnowledgeRetrievalError(
            f"Query embedding has dimension {len(vector)}; "
            f"expected {EMBEDDING_DIMENSION}."
        )

    validated = []
    for index, value in enumerate(vector):
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise KnowledgeRetrievalError(
                f"Query embedding value {index} is not numeric."
            )
        numeric_value = float(value)
        if not math.isfinite(numeric_value):
            raise KnowledgeRetrievalError(
                f"Query embedding value {index} is not finite."
            )
        validated.append(numeric_value)

    if not any(validated):
        raise KnowledgeRetrievalError("Query embedding has zero magnitude.")
    return validated


def _validate_context_ownership(
    *,
    user: User,
    video: Video | None,
    folder: Folder | None,
) -> None:
    """Reject foreign folders and videos associated only with another user.

    Videos are global records in this project, so video ownership is inferred
    from their user-owned notes and knowledge chunks.
    """
    if folder is not None and folder.user_id != user.pk:
        raise KnowledgeContextAccessError(
            "The supplied folder does not belong to the requesting user."
        )

    if video is not None:
        has_user_video_context = (
            video.notes.filter(user=user).exists()
            or video.knowledge_chunks.filter(user=user).exists()
        )
        has_other_user_video_context = (
            video.notes.exclude(user=user).exists()
            or video.knowledge_chunks.exclude(user=user).exists()
        )
        if has_other_user_video_context and not has_user_video_context:
            raise KnowledgeContextAccessError(
                "The supplied video is associated with another user's data."
            )


def _retrieve_knowledge(
    *,
    user: User,
    query: str,
    top_k: int = 5,
    video: Video | None = None,
    folder: Folder | None = None,
) -> list[RetrievalResult]:
    normalized_query = _validate_query(query)
    _validate_top_k(top_k)

    query_vector = _get_query_vector(normalized_query)
    chunks = KnowledgeChunk.objects.filter(
        user=user,
        embedding__isnull=False,
    )
    if video is not None:
        chunks = chunks.filter(video=video)
    if folder is not None:
        chunks = chunks.filter(folder=folder)
    return _rank_chunks(chunks, query_vector, top_k)


def _get_query_vector(normalized_query: str) -> list[float]:
    try:
        service = get_embedding_service()
        return _validate_query_vector(
            service.embed_query(normalized_query)
        )
    except KnowledgeRetrievalError:
        raise
    except Exception as exc:
        raise KnowledgeRetrievalError(
            "Could not generate a valid query embedding."
        ) from exc


def _rank_chunks(
    chunks,
    query_vector: list[float],
    top_k: int,
) -> list[RetrievalResult]:
    ranked_chunks = chunks.annotate(
        distance=CosineDistance("embedding", query_vector),
    ).order_by(F("distance").asc(), "id")[:top_k]

    return [
        RetrievalResult(chunk=chunk, distance=float(chunk.distance))
        for chunk in ranked_chunks
    ]


def _video_chunks(*, user: User, video: Video):
    return KnowledgeChunk.objects.filter(
        user=user,
        video=video,
        embedding__isnull=False,
        source_type__in=(
            KnowledgeChunk.SourceType.NOTE,
            KnowledgeChunk.SourceType.VIDEO_TRANSCRIPT,
            KnowledgeChunk.SourceType.VIDEO_ANALYSIS,
        ),
    )


def _combined_candidates(
    *,
    user: User,
    video: Video | None,
    folder: Folder | None,
):
    candidates = KnowledgeChunk.objects.filter(
        user=user,
        embedding__isnull=False,
    )
    contextual_filters = []
    if video is not None:
        video_filter = Q(
            video=video,
            source_type__in=(
                KnowledgeChunk.SourceType.NOTE,
                KnowledgeChunk.SourceType.VIDEO_TRANSCRIPT,
                KnowledgeChunk.SourceType.VIDEO_ANALYSIS,
            ),
        )
        contextual_filters.append(video_filter)
    if folder is not None:
        contextual_filters.append(Q(folder=folder))

    if contextual_filters:
        combined_filter = contextual_filters[0]
        for contextual_filter in contextual_filters[1:]:
            combined_filter |= contextual_filter
        candidates = candidates.exclude(combined_filter)
    return candidates


def retrieve_scoped_knowledge(
    request: RetrievalRequest,
) -> list[RetrievalResult]:
    """Retrieve candidates using the requested scope.

    CURRENT_VIDEO and CURRENT_FOLDER restrict candidates to their exact
    context. PERSONAL_KB searches only the authenticated user's chunks.
    COMBINED prioritizes the selected video's results, then fills remaining
    slots from that user's broader knowledge corpus. The ask API requires a
    YouTube ID for CURRENT_VIDEO and COMBINED; direct service callers retain
    the existing optional-context behavior for COMBINED.
    """
    if not isinstance(request, RetrievalRequest):
        raise KnowledgeRetrievalError(
            "request must be a RetrievalRequest instance."
        )
    try:
        scope = RetrievalScope(request.scope)
    except (TypeError, ValueError) as exc:
        raise KnowledgeRetrievalError("Unknown retrieval scope.") from exc

    _validate_context_ownership(
        user=request.user,
        video=request.video,
        folder=request.folder,
    )

    if scope is RetrievalScope.CURRENT_VIDEO:
        if request.video is None:
            raise KnowledgeRetrievalError(
                "CURRENT_VIDEO retrieval requires a video."
            )
        normalized_query = _validate_query(request.query)
        _validate_top_k(request.top_k)
        query_vector = _get_query_vector(normalized_query)
        return _rank_chunks(
            _video_chunks(user=request.user, video=request.video),
            query_vector,
            request.top_k,
        )
    elif scope is RetrievalScope.CURRENT_FOLDER:
        if request.folder is None:
            raise KnowledgeRetrievalError(
                "CURRENT_FOLDER retrieval requires a folder."
            )
        return _retrieve_knowledge(
            user=request.user,
            query=request.query,
            top_k=request.top_k,
            folder=request.folder,
        )
    elif scope is RetrievalScope.PERSONAL_KB:
        return _retrieve_knowledge(
            user=request.user,
            query=request.query,
            top_k=request.top_k,
        )

    normalized_query = _validate_query(request.query)
    _validate_top_k(request.top_k)
    query_vector = _get_query_vector(normalized_query)
    if request.video is not None:
        video_results = _rank_chunks(
            _video_chunks(user=request.user, video=request.video),
            query_vector,
            request.top_k,
        )
        personal_candidates = KnowledgeChunk.objects.filter(
            user=request.user,
            embedding__isnull=False,
        )
        # At most len(video_results) top personal matches can overlap these.
        personal_results = _rank_chunks(
            personal_candidates,
            query_vector,
            request.top_k + len(video_results),
        )
        candidate_results = {
            result.chunk.pk: result for result in video_results
        }
        for result in personal_results:
            candidate_results.setdefault(result.chunk.pk, result)
        return list(candidate_results.values())[: request.top_k]

    candidate_results = {}
    candidate_sets = []
    if request.folder is not None:
        candidate_sets.append(
            _rank_chunks(
                KnowledgeChunk.objects.filter(
                    user=request.user,
                    folder=request.folder,
                    embedding__isnull=False,
                ),
                query_vector,
                request.top_k,
            )
        )

    personal_candidates = _combined_candidates(
        user=request.user,
        video=request.video,
        folder=request.folder,
    )
    if request.video is not None or request.folder is not None:
        contextual_ids = set()
        if request.video is not None:
            contextual_ids.update(
                _video_chunks(
                    user=request.user,
                    video=request.video,
                ).values_list("pk", flat=True)
            )
        if request.folder is not None:
            contextual_ids.update(
                KnowledgeChunk.objects.filter(
                    user=request.user,
                    folder=request.folder,
                ).values_list("pk", flat=True)
            )
        personal_candidates = personal_candidates.exclude(pk__in=contextual_ids)
    candidate_sets.append(
        _rank_chunks(personal_candidates, query_vector, request.top_k)
    )

    for candidate_set in candidate_sets:
        for result in candidate_set:
            candidate_results.setdefault(result.chunk.pk, result)
    return sorted(
        candidate_results.values(),
        key=lambda result: (result.distance, result.chunk.pk),
    )[: request.top_k]


def retrieve_knowledge(
    *,
    user: User,
    query: str,
    top_k: int = 5,
    video: Video | None = None,
    folder: Folder | None = None,
) -> list[RetrievalResult]:
    """Compatibility API applying optional exact video/folder filters together."""
    _validate_context_ownership(user=user, video=video, folder=folder)
    return _retrieve_knowledge(
        user=user,
        query=query,
        top_k=top_k,
        video=video,
        folder=folder,
    )
