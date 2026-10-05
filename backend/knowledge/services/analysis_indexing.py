import math
from collections import OrderedDict
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
from videos.models import Video, VideoAnalysis


TARGET_CHUNK_CHARACTERS = 2000
MAX_CHUNK_CHARACTERS = 2500


class VideoAnalysisIndexingError(RuntimeError):
    """Raised when persisted video analysis cannot be indexed safely."""


def _render_value(value: Any) -> str:
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, bool):
        return "Yes" if value else "No"
    if isinstance(value, Real):
        if not math.isfinite(value):
            return ""
        return str(value)
    if isinstance(value, list):
        return "\n".join(
            rendered
            for item in value
            if (rendered := _render_value(item))
        )
    if isinstance(value, dict):
        lines = []
        for key, nested_value in value.items():
            rendered = _render_value(nested_value)
            if not rendered:
                continue
            label = str(key).replace("_", " ").strip().capitalize()
            lines.append(f"{label}: {rendered}")
        return "\n".join(lines)
    return ""


def _item_subsection(item: Any) -> str | None:
    if not isinstance(item, dict):
        return None
    for key in ("heading", "concept", "topic", "name", "title"):
        value = item.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _timestamped_content(section: str, item: dict[str, Any]) -> str:
    text = item.get("text")
    if not isinstance(text, str) or not text.strip():
        return _render_value(item)

    start = item.get("start")
    if (
        isinstance(start, Real)
        and not isinstance(start, bool)
        and math.isfinite(start)
        and start >= 0
    ):
        return f"{text.strip()} (at {start:g}s)"
    return text.strip()


def _analysis_groups(
    analysis: VideoAnalysis,
) -> list[tuple[str, str | None, list[str]]]:
    groups: OrderedDict[tuple[str, str | None], list[str]] = OrderedDict()

    def add(section: str, subsection: str | None, text: str) -> None:
        normalized = text.strip()
        if normalized:
            groups.setdefault((section, subsection), []).append(normalized)

    summary = _render_value(analysis.summary)
    add("summary", None, summary)

    detailed_notes = analysis.detailed_notes
    if isinstance(detailed_notes, dict):
        for subsection, value in detailed_notes.items():
            subsection_name = (
                str(subsection).replace("_", " ").strip().lower()
            )
            if subsection == "sections" and isinstance(value, list):
                for section_item in value:
                    if not isinstance(section_item, dict):
                        rendered = _render_value(section_item)
                    else:
                        heading = section_item.get("heading")
                        content = section_item.get("content")
                        heading_text = (
                            heading.strip()
                            if isinstance(heading, str)
                            else ""
                        )
                        content_text = (
                            content.strip()
                            if isinstance(content, str)
                            else _render_value(content)
                        )
                        rendered = "\n".join(
                            value
                            for value in (heading_text, content_text)
                            if value
                        )
                    add("detailed_notes", subsection_name, rendered)
            elif isinstance(value, list):
                for item in value:
                    add(
                        "detailed_notes",
                        subsection_name,
                        _render_value(item),
                    )
            else:
                add(
                    "detailed_notes",
                    subsection_name,
                    _render_value(value),
                )

    for section in (
        "topics",
        "concepts",
        "prerequisites",
        "upcoming_topics",
        "key_points",
        "claims",
        "questions",
    ):
        values = getattr(analysis, section)
        if not isinstance(values, list):
            continue
        for item in values:
            if section in {"key_points", "claims"} and isinstance(item, dict):
                rendered = _timestamped_content(section, item)
            else:
                rendered = _render_value(item)
            add(section, _item_subsection(item), rendered)

    return [
        (section, subsection, entries)
        for (section, subsection), entries in groups.items()
    ]


def _make_chunks(analysis: VideoAnalysis) -> list[dict[str, Any]]:
    chunks = []
    for section, subsection, entries in _analysis_groups(analysis):
        current_entries = []
        current_length = 0
        for entry in entries:
            proposed_length = current_length + (2 if current_entries else 0)
            proposed_length += len(entry)
            if (
                current_entries
                and proposed_length > TARGET_CHUNK_CHARACTERS
            ):
                chunks.append(
                    {
                        "content": "\n\n".join(current_entries),
                        "section": section,
                        "subsection": subsection,
                    }
                )
                current_entries = []
                current_length = 0

            current_entries.append(entry)
            current_length += (2 if current_length else 0) + len(entry)

            if len(entry) > TARGET_CHUNK_CHARACTERS:
                chunks.append(
                    {
                        "content": "\n\n".join(current_entries),
                        "section": section,
                        "subsection": subsection,
                    }
                )
                current_entries = []
                current_length = 0

        if current_entries:
            chunks.append(
                {
                    "content": "\n\n".join(current_entries),
                    "section": section,
                    "subsection": subsection,
                }
            )

    if len(chunks) > 1:
        final_chunk = chunks[-1]
        previous_chunk = chunks[-2]
        combined_length = (
            len(previous_chunk["content"])
            + 2
            + len(final_chunk["content"])
        )
        if (
            len(final_chunk["content"]) < 300
            and combined_length <= MAX_CHUNK_CHARACTERS
            and previous_chunk["section"] == final_chunk["section"]
            and previous_chunk["subsection"] == final_chunk["subsection"]
        ):
            previous_chunk["content"] += "\n\n" + final_chunk["content"]
            chunks.pop()

    return chunks


def _validate_inputs(video: Video, user: Any) -> None:
    if not isinstance(video, Video) or video.pk is None:
        raise VideoAnalysisIndexingError(
            "A persisted video is required for analysis indexing."
        )

    user_model = get_user_model()
    if (
        not isinstance(user, user_model)
        or user.pk is None
        or not user.is_authenticated
    ):
        raise VideoAnalysisIndexingError(
            "An authenticated project user is required for analysis indexing."
        )


def index_video_analysis(
    *,
    video: Video,
    user: Any,
) -> list[KnowledgeChunk]:
    """Replace one user's indexed chunks for the video's saved analysis."""
    _validate_inputs(video, user)
    analysis = VideoAnalysis.objects.filter(video_id=video.pk).first()
    if analysis is None:
        return []

    chunk_data = _make_chunks(analysis)
    if not chunk_data:
        return []

    try:
        embeddings = get_embedding_service().embed_documents(
            [chunk["content"] for chunk in chunk_data]
        )
    except EmbeddingServiceError as error:
        raise VideoAnalysisIndexingError(
            "Video analysis embeddings could not be generated."
        ) from error

    if (
        isinstance(embeddings, (str, bytes))
        or not hasattr(embeddings, "__len__")
        or len(embeddings) != len(chunk_data)
    ):
        actual_count = (
            len(embeddings)
            if hasattr(embeddings, "__len__")
            else "unknown"
        )
        raise VideoAnalysisIndexingError(
            f"Embedding service returned {actual_count} vectors for "
            f"{len(chunk_data)} video analysis chunks."
        )

    chunks = []
    for chunk_index, (data, embedding) in enumerate(
        zip(chunk_data, embeddings)
    ):
        if (
            isinstance(embedding, (str, bytes))
            or not isinstance(embedding, (list, tuple))
            or len(embedding) != EMBEDDING_DIMENSION
            or any(
                isinstance(value, bool)
                or not isinstance(value, Real)
                or not math.isfinite(value)
                for value in embedding
            )
        ):
            raise VideoAnalysisIndexingError(
                f"Embedding {chunk_index} is malformed; expected a finite "
                f"{EMBEDDING_DIMENSION}-dimensional vector."
            )

        metadata = {
            "source_type": KnowledgeChunk.SourceType.VIDEO_ANALYSIS,
            "section": data["section"],
        }
        if data["subsection"] is not None:
            metadata["subsection"] = data["subsection"]
        chunks.append(
            KnowledgeChunk(
                user=user,
                video=video,
                note=None,
                folder=None,
                content=data["content"],
                content_type=KnowledgeChunk.ContentType.ANALYSIS_CHUNK,
                source_type=KnowledgeChunk.SourceType.VIDEO_ANALYSIS,
                source_block_id=None,
                chunk_index=chunk_index,
                metadata=metadata,
                embedding=embedding,
            )
        )

    with transaction.atomic():
        locked_video = Video.objects.select_for_update().get(pk=video.pk)
        KnowledgeChunk.objects.filter(
            user=user,
            video=locked_video,
            source_type=KnowledgeChunk.SourceType.VIDEO_ANALYSIS,
        ).delete()
        for chunk in chunks:
            chunk.video = locked_video
        return KnowledgeChunk.objects.bulk_create(chunks)
