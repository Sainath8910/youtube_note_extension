import math
from numbers import Real
from typing import Any

from django.contrib.auth import get_user_model
from django.db import transaction

from knowledge.models import KnowledgeChunk
from knowledge.services.embeddings import (
    EMBEDDING_DIMENSION,
    EmbeddingServiceError,
    get_embedding_service,
)
from videos.models import Video


TARGET_CHUNK_CHARACTERS = 2000
MAX_CHUNK_CHARACTERS = 2500
MIN_CHUNK_CHARACTERS = 1000


class TranscriptIndexingError(RuntimeError):
    """Raised when transcript chunks cannot be paired with embeddings."""


class TranscriptNotReadyError(TranscriptIndexingError):
    """Raised when the video's transcript has not finished loading."""


class TranscriptUnavailableError(TranscriptIndexingError):
    """Raised when the video has no usable persisted transcript."""


def _get_transcript_segments(transcript: Any) -> list[dict[str, Any]]:
    if not isinstance(transcript, list):
        return []

    segments = []
    for segment_index, segment in enumerate(transcript):
        if not isinstance(segment, dict):
            raise TranscriptUnavailableError(
                f"Transcript segment {segment_index} is invalid."
            )

        text = segment.get("text")
        normalized_text = text.strip() if isinstance(text, str) else ""
        if not normalized_text:
            continue

        start = segment.get("start")
        duration = segment.get("duration")
        if (
            isinstance(start, bool)
            or not isinstance(start, Real)
            or not math.isfinite(start)
            or start < 0
            or isinstance(duration, bool)
            or not isinstance(duration, Real)
            or not math.isfinite(duration)
            or duration < 0
        ):
            raise TranscriptUnavailableError(
                f"Transcript segment {segment_index} has invalid timing."
            )

        segments.append(
            {
                "text": normalized_text,
                "start_seconds": float(start),
                "end_seconds": float(start + duration),
            }
        )

    return segments


def _make_chunk(segments: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "content": "\n".join(segment["text"] for segment in segments),
        "start_seconds": segments[0]["start_seconds"],
        "end_seconds": segments[-1]["end_seconds"],
    }


def _build_transcript_chunks(
    transcript: Any,
) -> list[dict[str, Any]]:
    segments = _get_transcript_segments(transcript)
    if not segments:
        return []

    chunks = []
    current_segments = []
    current_length = 0

    for segment in segments:
        segment_length = len(segment["text"])
        combined_length = current_length + (1 if current_segments else 0)
        combined_length += segment_length

        if (
            current_segments
            and combined_length > TARGET_CHUNK_CHARACTERS
        ):
            chunks.append(_make_chunk(current_segments))
            current_segments = []
            current_length = 0

        current_segments.append(segment)
        current_length += (1 if current_length else 0) + segment_length

        if segment_length > TARGET_CHUNK_CHARACTERS:
            chunks.append(_make_chunk(current_segments))
            current_segments = []
            current_length = 0

    if current_segments:
        chunks.append(_make_chunk(current_segments))

    if len(chunks) > 1:
        final_chunk = chunks[-1]
        previous_chunk = chunks[-2]
        combined_length = (
            len(previous_chunk["content"])
            + 1
            + len(final_chunk["content"])
        )
        if (
            len(final_chunk["content"]) < MIN_CHUNK_CHARACTERS
            and combined_length <= MAX_CHUNK_CHARACTERS
        ):
            chunks[-2:] = [
                {
                    "content": (
                        previous_chunk["content"]
                        + "\n"
                        + final_chunk["content"]
                    ),
                    "start_seconds": previous_chunk["start_seconds"],
                    "end_seconds": final_chunk["end_seconds"],
                }
            ]

    return chunks


def _validate_inputs(video: Video, user: Any) -> None:
    if not isinstance(video, Video) or video.pk is None:
        raise TranscriptIndexingError(
            "A persisted video is required for transcript indexing."
        )

    user_model = get_user_model()
    if (
        not isinstance(user, user_model)
        or user.pk is None
        or not user.is_authenticated
    ):
        raise TranscriptIndexingError(
            "An authenticated project user is required for transcript indexing."
        )


def index_video_transcript(
    *,
    video: Video,
    user: Any,
) -> list[KnowledgeChunk]:
    """Replace one user's indexed transcript chunks for a video."""
    _validate_inputs(video, user)

    if video.transcript_status != Video.TranscriptStatus.READY:
        raise TranscriptNotReadyError(
            "The video transcript is not ready for indexing."
        )

    chunk_data = _build_transcript_chunks(video.transcript)
    if not chunk_data:
        return []

    texts = [chunk["content"] for chunk in chunk_data]
    try:
        embeddings = get_embedding_service().embed_documents(texts)
    except EmbeddingServiceError as error:
        raise TranscriptIndexingError(
            "Transcript embeddings could not be generated."
        ) from error

    if not isinstance(embeddings, (list, tuple)) or len(embeddings) != len(
        chunk_data
    ):
        actual_count = (
            len(embeddings)
            if hasattr(embeddings, "__len__")
            else "unknown"
        )
        raise TranscriptIndexingError(
            f"Embedding service returned {actual_count} vectors for "
            f"{len(chunk_data)} transcript chunks."
        )

    chunks = []
    for chunk_index, (data, embedding) in enumerate(
        zip(chunk_data, embeddings)
    ):
        if (
            isinstance(embedding, (str, bytes))
            or not hasattr(embedding, "__len__")
            or len(embedding) != EMBEDDING_DIMENSION
        ):
            actual_dimension = (
                len(embedding) if hasattr(embedding, "__len__") else "unknown"
            )
            raise TranscriptIndexingError(
                f"Embedding {chunk_index} has dimension {actual_dimension}; "
                f"expected {EMBEDDING_DIMENSION}."
            )

        chunks.append(
            KnowledgeChunk(
                user=user,
                video=video,
                note=None,
                folder=None,
                content=data["content"],
                content_type=KnowledgeChunk.ContentType.TRANSCRIPT_CHUNK,
                source_type=KnowledgeChunk.SourceType.VIDEO_TRANSCRIPT,
                source_block_id=None,
                chunk_index=chunk_index,
                metadata={
                    "source_type": KnowledgeChunk.SourceType.VIDEO_TRANSCRIPT,
                    "start_seconds": data["start_seconds"],
                    "end_seconds": data["end_seconds"],
                },
                embedding=embedding,
            )
        )

    with transaction.atomic():
        locked_video = Video.objects.select_for_update().get(pk=video.pk)
        KnowledgeChunk.objects.filter(
            user=user,
            video=locked_video,
            source_type=KnowledgeChunk.SourceType.VIDEO_TRANSCRIPT,
        ).delete()
        for chunk in chunks:
            chunk.video = locked_video
        return KnowledgeChunk.objects.bulk_create(chunks)
