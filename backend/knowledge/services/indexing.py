from django.db import transaction

from knowledge.models import KnowledgeChunk
from knowledge.services.embeddings import get_embedding_service


TEXT_BLOCK_TYPES = {"paragraph", "equation", "timestamp"}
EMBEDDING_DIMENSION = 1024


class NoteIndexingError(RuntimeError):
    """Raised when note chunks cannot be paired with their embeddings."""


def _block_id(block):
    block_id = block.get("id")
    return block_id if isinstance(block_id, str) and block_id else None


def _make_chunk_data(block, heading_block=None, heading_content=None):
    content = block["content"].strip()
    metadata = {"block_type": block["type"]}

    if heading_block is not None and heading_content is not None:
        content = f"{heading_content}\n\n{content}"
        metadata["heading_block_id"] = _block_id(heading_block)

    return {
        "content": content,
        "source_block_id": _block_id(block),
        "metadata": metadata,
    }


def _get_chunk_data(note):
    document = note.document
    if not isinstance(document, dict):
        return []

    blocks = document.get("blocks")
    if not isinstance(blocks, list):
        return []

    chunk_data = []
    pending_heading = None

    for block in blocks:
        if not isinstance(block, dict):
            if pending_heading is not None:
                chunk_data.append(_make_chunk_data(pending_heading[0]))
                pending_heading = None
            continue

        block_type = block.get("type")
        content = block.get("content")
        normalized_content = content.strip() if isinstance(content, str) else ""

        if pending_heading is not None:
            if block_type in TEXT_BLOCK_TYPES and normalized_content:
                chunk_data.append(
                    _make_chunk_data(
                        block,
                        heading_block=pending_heading[0],
                        heading_content=pending_heading[1],
                    )
                )
                pending_heading = None
                continue

            chunk_data.append(_make_chunk_data(pending_heading[0]))
            pending_heading = None

        if block_type == "heading":
            if normalized_content:
                pending_heading = (block, normalized_content)
        elif block_type in TEXT_BLOCK_TYPES and normalized_content:
            chunk_data.append(_make_chunk_data(block))

    if pending_heading is not None:
        chunk_data.append(_make_chunk_data(pending_heading[0]))

    return chunk_data


@transaction.atomic
def index_note(note):
    """Replace a note's chunks with deterministic chunks from its text blocks.

    A heading is included in the immediately following meaningful text block's
    chunk; headings without such a following block become chunks of their own.
    """
    chunk_data_list = _get_chunk_data(note)
    if not chunk_data_list:
        KnowledgeChunk.objects.filter(note=note).delete()
        return []

    texts = [chunk_data["content"] for chunk_data in chunk_data_list]
    embedding_service = get_embedding_service()
    embeddings = embedding_service.embed_documents(texts)
    if len(embeddings) != len(chunk_data_list):
        raise NoteIndexingError(
            "Embedding service returned "
            f"{len(embeddings)} vectors for {len(chunk_data_list)} note chunks."
        )

    chunks = []
    for chunk_index, (chunk_data, embedding) in enumerate(
        zip(chunk_data_list, embeddings)
    ):
        if len(embedding) != EMBEDDING_DIMENSION:
            raise NoteIndexingError(
                f"Embedding {chunk_index} has dimension {len(embedding)}; "
                f"expected {EMBEDDING_DIMENSION}."
            )
        chunks.append(
            KnowledgeChunk(
                user=note.user,
                note=note,
                video=note.video,
                folder=note.folder,
                content=chunk_data["content"],
                content_type=KnowledgeChunk.ContentType.NOTE_BLOCK,
                source_type=KnowledgeChunk.SourceType.NOTE,
                source_block_id=chunk_data["source_block_id"],
                chunk_index=chunk_index,
                metadata=chunk_data["metadata"],
                embedding=embedding,
            )
        )

    KnowledgeChunk.objects.filter(note=note).delete()
    return KnowledgeChunk.objects.bulk_create(chunks)
