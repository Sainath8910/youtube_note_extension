"""Deterministic assembly of retrieved knowledge for future RAG generation."""

from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Any

from knowledge.models import KnowledgeChunk
from knowledge.services.retrieval import (
    RetrievalRequest,
    RetrievalScope,
    retrieve_scoped_knowledge,
)
from users.models import User


@dataclass(frozen=True)
class RAGContextItem:
    chunk_id: int
    content: str
    distance: float
    note_id: int | None
    video_id: int | None
    folder_id: int | None
    source_block_id: str | None
    chunk_index: int
    metadata: dict[str, Any]


@dataclass(frozen=True)
class RAGContext:
    question: str
    scope: RetrievalScope
    items: tuple[RAGContextItem, ...]


def assemble_rag_context(
    *,
    user: User,
    question: str,
    request: RetrievalRequest,
    top_k: int = 5,
) -> RAGContext:
    """Retrieve scoped chunks and package their source data without generation."""
    if not isinstance(question, str):
        raise ValueError("question must be a string.")

    normalized_question = question.strip()
    if not normalized_question:
        raise ValueError("question must not be empty.")

    retrieval_request = replace(
        request,
        user=user,
        query=normalized_question,
        top_k=top_k,
    )
    results = retrieve_scoped_knowledge(retrieval_request)

    items = []
    seen_chunk_ids = set()
    for result in results:
        chunk: KnowledgeChunk = result.chunk
        chunk_id = chunk.pk
        if chunk_id in seen_chunk_ids:
            continue
        seen_chunk_ids.add(chunk_id)
        metadata = dict(chunk.metadata)
        source_type = getattr(chunk, "source_type", None)
        if source_type is not None:
            metadata["source_type"] = source_type
        items.append(
            RAGContextItem(
                chunk_id=chunk_id,
                content=chunk.content,
                distance=result.distance,
                note_id=chunk.note_id,
                video_id=chunk.video_id,
                folder_id=chunk.folder_id,
                source_block_id=chunk.source_block_id,
                chunk_index=chunk.chunk_index,
                metadata=metadata,
            )
        )

    return RAGContext(
        question=normalized_question,
        scope=retrieval_request.scope,
        items=tuple(items),
    )
