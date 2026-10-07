from dataclasses import dataclass


SELECTED_BLOCK_MAX_CHARS = 4000
NOTE_CONTEXT_MAX_CHARS = 8000
NEIGHBOR_BLOCK_LIMIT = 2

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

    def as_prompt_data(self) -> dict[str, object]:
        return {
            "selected": self.selected.as_prompt_data(),
            "context": [
                block.as_prompt_data() for block in self.context
            ],
        }


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
