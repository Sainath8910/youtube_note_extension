"""Application-level RAG orchestration boundary.

Retrieval/context assembly and generation remain separate lower-level services;
this module coordinates them without reimplementing either responsibility.
"""

from knowledge.services.context import RAGContext, assemble_rag_context
from knowledge.services.generation import (
    GenerationProvider,
    RAGAnswer,
    generate_rag_answer,
)
from knowledge.services.retrieval import RetrievalRequest
from users.models import User


def answer_question(
    *,
    user: User,
    question: str,
    request: RetrievalRequest,
    top_k: int = 5,
    provider: GenerationProvider | None = None,
) -> RAGAnswer:
    """Assemble scoped context and generate an answer from that exact context."""
    context: RAGContext = assemble_rag_context(
        user=user,
        question=question,
        request=request,
        top_k=top_k,
    )
    return generate_rag_answer(context=context, provider=provider)
