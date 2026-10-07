import math
import re
from collections.abc import Iterable
from dataclasses import dataclass
from numbers import Real

from knowledge.models import KnowledgeChunk


SELECTED_BLOCK_MAX_CHARS = 4000
NOTE_CONTEXT_MAX_CHARS = 8000
TRANSCRIPT_CONTEXT_MAX_CHARS = 4000
TOTAL_ASSISTANCE_CONTEXT_MAX_CHARS = 12000
TRANSCRIPT_PRE_CONTEXT_SECONDS = 60
TRANSCRIPT_POST_CONTEXT_SECONDS = 120
NEIGHBOR_BLOCK_LIMIT = 2
_TIMESTAMP_PATTERN = re.compile(
    r"^(?:(?P<hours>[0-9]+):)?(?P<minutes>[0-9]+):"
    r"(?P<seconds>[0-9]{2})$"
)

MEANINGFUL_BLOCK_TYPES = {
    "paragraph",
    "heading",
    "equation",
    "timestamp",
}


class SelectedBlockTooLargeError(ValueError):
    pass


@dataclass(frozen=True)
class NoteContextBlock:
    block_id: str
    block_type: str
    content: str
    document_index: int

    def as_prompt_data(self) -> dict[str, str]:
        return {
            "block_id": self.block_id,
            "type": self.block_type,
            "content": self.content,
        }


@dataclass(frozen=True)
class NoteAssistanceContext:
    selected: NoteContextBlock
    context: tuple[NoteContextBlock, ...]
    transcript: tuple["TranscriptContextChunk", ...] = ()

    def as_prompt_data(self) -> dict[str, object]:
        return {
            "selected": self.selected.as_prompt_data(),
            "context": [
                block.as_prompt_data() for block in self.context
            ],
            "nearby_transcript": [
                chunk.as_prompt_data() for chunk in self.transcript
            ],
        }


@dataclass(frozen=True)
class TranscriptContextChunk:
    content: str
    start_seconds: float
    end_seconds: float
    chunk_index: int
    chunk_id: int

    def as_prompt_data(self) -> dict[str, object]:
        return {
            "start_seconds": self.start_seconds,
            "end_seconds": self.end_seconds,
            "content": self.content,
        }


def resolve_transcript_timestamp(
    note_timestamp_seconds: object,
    selected: NoteContextBlock,
    context: tuple[NoteContextBlock, ...] = (),
) -> float | None:
    if (
        isinstance(note_timestamp_seconds, Real)
        and not isinstance(note_timestamp_seconds, bool)
    ):
        try:
            timestamp = float(note_timestamp_seconds)
        except (OverflowError, ValueError):
            timestamp = -1
        if math.isfinite(timestamp) and timestamp >= 0:
            return timestamp

    timestamp_blocks = [
        block
        for block in (*context, selected)
        if block.block_type == "timestamp"
    ]
    timestamp_blocks.sort(
        key=lambda block: (
            abs(block.document_index - selected.document_index),
            0 if block.document_index < selected.document_index else 1,
        )
    )
    for block in timestamp_blocks:
        timestamp = _parse_timestamp(block.content)
        if timestamp is not None:
            return timestamp
    return None


def _parse_timestamp(content: str) -> float | None:
    match = _TIMESTAMP_PATTERN.fullmatch(content.strip())
    if match is None:
        return None

    try:
        seconds = int(match.group("seconds"))
        minutes = int(match.group("minutes"))
        hours_value = match.group("hours")
        hours = int(hours_value) if hours_value is not None else 0
    except ValueError:
        return None

    if seconds >= 60 or (hours_value is not None and minutes >= 60):
        return None
    try:
        timestamp = float(hours * 3600 + minutes * 60 + seconds)
    except OverflowError:
        return None
    return timestamp if math.isfinite(timestamp) else None


def _valid_transcript_time(value: object) -> float | None:
    if isinstance(value, bool) or not isinstance(value, Real):
        return None
    try:
        timestamp = float(value)
    except (OverflowError, ValueError):
        return None
    if not math.isfinite(timestamp) or timestamp < 0:
        return None
    return timestamp


def build_nearby_transcript_context(
    chunks: Iterable[KnowledgeChunk],
    anchor_seconds: float,
    note_context: NoteAssistanceContext,
) -> NoteAssistanceContext:
    window_start = max(
        0,
        anchor_seconds - TRANSCRIPT_PRE_CONTEXT_SECONDS,
    )
    window_end = anchor_seconds + TRANSCRIPT_POST_CONTEXT_SECONDS
    candidates = []

    for chunk in chunks:
        content = chunk.content
        metadata = chunk.metadata
        if not isinstance(content, str) or not content.strip():
            continue
        if not isinstance(metadata, dict):
            continue

        start_seconds = _valid_transcript_time(
            metadata.get("start_seconds")
        )
        if start_seconds is None:
            continue
        end_seconds = _valid_transcript_time(metadata.get("end_seconds"))
        if end_seconds is None or end_seconds < start_seconds:
            end_seconds = start_seconds
        if start_seconds > window_end or end_seconds < window_start:
            continue

        candidates.append(
            TranscriptContextChunk(
                content=content,
                start_seconds=start_seconds,
                end_seconds=end_seconds,
                chunk_index=chunk.chunk_index,
                chunk_id=chunk.pk,
            )
        )

    candidates.sort(
        key=lambda chunk: (
            chunk.start_seconds,
            chunk.chunk_index,
            chunk.chunk_id,
        )
    )

    note_context_chars = len(note_context.selected.content) + sum(
        len(block.content) for block in note_context.context
    )
    remaining_chars = min(
        TRANSCRIPT_CONTEXT_MAX_CHARS,
        TOTAL_ASSISTANCE_CONTEXT_MAX_CHARS - note_context_chars,
    )
    selected_transcript = []
    for chunk in candidates:
        if len(chunk.content) <= remaining_chars:
            selected_transcript.append(chunk)
            remaining_chars -= len(chunk.content)

    return NoteAssistanceContext(
        selected=note_context.selected,
        context=note_context.context,
        transcript=tuple(selected_transcript),
    )


def build_note_assistance_context(
    blocks: list[dict[str, str]],
    selected_index: int,
) -> NoteAssistanceContext:
    if selected_index < 0 or selected_index >= len(blocks):
        raise ValueError("selected_index must identify a note block.")

    selected_block = blocks[selected_index]
    selected = NoteContextBlock(
        block_id=selected_block["id"],
        block_type=selected_block["type"],
        content=selected_block["content"],
        document_index=selected_index,
    )
    if len(selected.content) > SELECTED_BLOCK_MAX_CHARS:
        raise SelectedBlockTooLargeError

    meaningful_indices = [
        index
        for index, block in enumerate(blocks)
        if block["type"] in MEANINGFUL_BLOCK_TYPES
        and block["content"].strip()
    ]
    preceding_indices = [
        index for index in meaningful_indices if index < selected_index
    ][-NEIGHBOR_BLOCK_LIMIT:]
    following_indices = [
        index for index in meaningful_indices if index > selected_index
    ][:NEIGHBOR_BLOCK_LIMIT]

    preceding_headings = [
        index
        for index in meaningful_indices
        if index < selected_index and blocks[index]["type"] == "heading"
    ]
    heading_index = preceding_headings[-1] if preceding_headings else None

    priority_indices = []
    if heading_index is not None:
        priority_indices.append(heading_index)
    for offset in range(NEIGHBOR_BLOCK_LIMIT):
        before_offset = len(preceding_indices) - offset - 1
        if before_offset >= 0:
            priority_indices.append(preceding_indices[before_offset])
        if offset < len(following_indices):
            priority_indices.append(following_indices[offset])

    context_by_index = {}
    considered_indices = set()
    remaining_chars = NOTE_CONTEXT_MAX_CHARS - len(selected.content)
    for index in priority_indices:
        if index in considered_indices:
            continue
        considered_indices.add(index)

        block = blocks[index]
        context_block = NoteContextBlock(
            block_id=block["id"],
            block_type=block["type"],
            content=block["content"],
            document_index=index,
        )
        if len(context_block.content) <= remaining_chars:
            context_by_index[index] = context_block
            remaining_chars -= len(context_block.content)

    return NoteAssistanceContext(
        selected=selected,
        context=tuple(
            context_by_index[index] for index in sorted(context_by_index)
        ),
    )
