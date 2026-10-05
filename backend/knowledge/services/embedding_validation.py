"""Standalone local evaluation for Qwen3-Embedding-0.6B.

Run from the backend directory with:
    python -m knowledge.services.embedding_validation
"""

from __future__ import annotations

import ctypes
import os
import sys
import time
from collections.abc import Sequence
from typing import Any


MODEL_ID = "Qwen/Qwen3-Embedding-0.6B"
MODEL_REVISION = "97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3"
EXPECTED_DIMENSION = 1024
MAX_LENGTH = 512
QUERY_INSTRUCTION = (
    "Given a technical question, retrieve relevant knowledge passages "
    "that answer it"
)

DOCUMENTS = (
    "Binary search repeatedly divides the sorted search space into two halves.",
    (
        "Binary search has logarithmic time complexity because each comparison "
        "eliminates approximately half of the remaining candidates."
    ),
    "Python lists are mutable sequences that can contain elements of different types.",
    "PostgreSQL can store vectors using the pgvector extension.",
    (
        "Cosine similarity measures the angle between two vectors and is "
        "commonly used for semantic similarity."
    ),
)

QUERIES = (
    "How does binary search reduce the amount of work?",
    "What is the time complexity of binary search?",
    "How can PostgreSQL store embeddings?",
    "What is cosine similarity?",
)


def validate_texts(texts: Sequence[str], *, kind: str) -> list[str]:
    """Reject empty batches and blank entries before tokenization."""
    if not texts:
        raise ValueError(f"{kind} input must contain at least one text.")

    values = list(texts)
    for index, text in enumerate(values):
        if not isinstance(text, str) or not text.strip():
            raise ValueError(f"{kind} input at index {index} must not be blank.")
    return values


def format_query(query: str) -> str:
    """Apply Qwen's documented instruction-aware query format."""
    validate_texts([query], kind="Query")
    return f"Instruct: {QUERY_INSTRUCTION}\nQuery:{query}"


def select_device(torch: Any) -> Any:
    """Prefer an available accelerator and otherwise use CPU."""
    if torch.cuda.is_available():
        return torch.device("cuda")
    if hasattr(torch, "xpu") and torch.xpu.is_available():
        return torch.device("xpu")
    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")


def _process_memory_bytes() -> int | None:
    if os.name == "nt":
        from ctypes import wintypes

        class ProcessMemoryCounters(ctypes.Structure):
            _fields_ = [
                ("cb", ctypes.c_ulong),
                ("PageFaultCount", ctypes.c_ulong),
                ("PeakWorkingSetSize", ctypes.c_size_t),
                ("WorkingSetSize", ctypes.c_size_t),
                ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                ("PagefileUsage", ctypes.c_size_t),
                ("PeakPagefileUsage", ctypes.c_size_t),
            ]

        counters = ProcessMemoryCounters()
        counters.cb = ctypes.sizeof(counters)
        psapi = ctypes.WinDLL("psapi", use_last_error=True)
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.GetCurrentProcess.restype = wintypes.HANDLE
        psapi.GetProcessMemoryInfo.argtypes = [
            wintypes.HANDLE,
            ctypes.POINTER(ProcessMemoryCounters),
            wintypes.DWORD,
        ]
        psapi.GetProcessMemoryInfo.restype = wintypes.BOOL
        succeeded = psapi.GetProcessMemoryInfo(
            kernel32.GetCurrentProcess(),
            ctypes.byref(counters),
            counters.cb,
        )
        return counters.WorkingSetSize if succeeded else None

    if sys.platform.startswith("linux"):
        with open("/proc/self/status", encoding="utf-8") as status_file:
            for line in status_file:
                if line.startswith("VmRSS:"):
                    return int(line.split()[1]) * 1024
    return None


def _memory_mib(value: int | None) -> str:
    return "unavailable" if value is None else f"{value / (1024 * 1024):.1f} MiB"


class QwenEmbeddingValidator:
    """Loads the selected model once and batches local document/query encoding."""

    def __init__(self) -> None:
        import torch
        import torch.nn.functional as functional
        from transformers import AutoModel, AutoTokenizer

        self.torch = torch
        self.functional = functional
        self.device = select_device(torch)
        self.dtype = (
            torch.float16
            if self.device.type == "mps"
            else torch.bfloat16
        )
        self.tokenizer = AutoTokenizer.from_pretrained(
            MODEL_ID,
            revision=MODEL_REVISION,
            padding_side="left",
        )
        self.model = AutoModel.from_pretrained(
            MODEL_ID,
            revision=MODEL_REVISION,
            dtype=self.dtype,
        ).to(self.device)
        self.model.eval()

        model_dimension = getattr(self.model.config, "hidden_size", None)
        if model_dimension != EXPECTED_DIMENSION:
            raise RuntimeError(
                f"Expected native model dimension {EXPECTED_DIMENSION}, "
                f"got {model_dimension!r}."
            )

    def _embed(self, texts: Sequence[str]):
        batch = self.tokenizer(
            list(texts),
            padding=True,
            truncation=True,
            max_length=MAX_LENGTH,
            return_tensors="pt",
        )
        batch = {key: value.to(self.device) for key, value in batch.items()}

        with self.torch.inference_mode():
            output = self.model(**batch)
            attention_mask = batch["attention_mask"]
            if bool((attention_mask[:, -1] == 1).all()):
                pooled = output.last_hidden_state[:, -1]
            else:
                final_indices = attention_mask.sum(dim=1) - 1
                row_indices = self.torch.arange(
                    output.last_hidden_state.shape[0],
                    device=self.device,
                )
                pooled = output.last_hidden_state[row_indices, final_indices]

            embeddings = self.functional.normalize(
                pooled.to(dtype=self.torch.float32),
                p=2,
                dim=1,
            )

        if embeddings.shape[1] != EXPECTED_DIMENSION:
            raise RuntimeError(
                f"Expected {EXPECTED_DIMENSION}-dimensional embeddings, "
                f"got {embeddings.shape[1]}."
            )
        return embeddings

    def embed_documents(self, documents: Sequence[str]):
        return self._embed(validate_texts(documents, kind="Document"))

    def embed_queries(self, queries: Sequence[str]):
        validated = validate_texts(queries, kind="Query")
        return self._embed([format_query(query) for query in validated])


def run_validation() -> None:
    import torch

    memory_before = _process_memory_bytes()
    load_started = time.perf_counter()
    embedder = QwenEmbeddingValidator()
    model_load_seconds = time.perf_counter() - load_started
    memory_after_load = _process_memory_bytes()

    print(f"Model: {MODEL_ID}")
    print(f"Revision: {MODEL_REVISION}")
    print(f"Dimension: {EXPECTED_DIMENSION}")
    print(f"Device: {embedder.device}")
    print(f"Model load time: {model_load_seconds:.2f}s")
    print(f"Process memory before load: {_memory_mib(memory_before)}")
    print(f"Process memory after load: {_memory_mib(memory_after_load)}")
    if memory_before is not None and memory_after_load is not None:
        print(
            "Approximate model-load memory increase: "
            f"{(memory_after_load - memory_before) / (1024 * 1024):.1f} MiB"
        )

    started = time.perf_counter()
    document_embeddings = embedder.embed_documents(DOCUMENTS)
    document_seconds = time.perf_counter() - started

    started = time.perf_counter()
    query_embeddings = embedder.embed_queries(QUERIES)
    query_seconds = time.perf_counter() - started

    repeat_embeddings = embedder.embed_queries([QUERIES[0], QUERIES[0]])
    repeat_is_deterministic = torch.allclose(
        repeat_embeddings[0],
        repeat_embeddings[1],
        rtol=1e-5,
        atol=1e-6,
    )
    if not repeat_is_deterministic:
        raise RuntimeError("Repeated query embedding was not deterministic.")

    scores = query_embeddings @ document_embeddings.T

    print(f"Document embedding time (batch of {len(DOCUMENTS)}): {document_seconds:.2f}s")
    print(f"Query embedding time (batch of {len(QUERIES)}): {query_seconds:.2f}s")
    print(f"Document embedding shape: {tuple(document_embeddings.shape)}")
    print(f"Query embedding shape: {tuple(query_embeddings.shape)}")
    print(f"Repeated embedding deterministic: {repeat_is_deterministic}")
    print(f"Process memory after validation: {_memory_mib(_process_memory_bytes())}")

    for query_index, query in enumerate(QUERIES):
        ranking = sorted(
            enumerate(scores[query_index].tolist()),
            key=lambda result: (-result[1], result[0]),
        )
        print(f'\nQuery: "{query}"')
        for rank, (document_index, similarity) in enumerate(ranking, start=1):
            print(
                f"  {rank}. Document {document_index + 1} "
                f"(cosine={similarity:.4f}): {DOCUMENTS[document_index]}"
            )


if __name__ == "__main__":
    run_validation()
