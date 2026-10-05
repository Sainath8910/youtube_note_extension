import json
import logging
import math
import os
import re
from dataclasses import dataclass
from numbers import Real
from typing import Any, Protocol, Sequence

from google import genai
from google.genai import types
from huggingface_hub import InferenceClient


logger = logging.getLogger(__name__)


@dataclass
class AnalysisResult:
    summary: str
    detailed_notes: dict[str, Any]
    topics: list[Any]
    concepts: list[Any]
    prerequisites: list[Any]
    upcoming_topics: list[Any]
    key_points: list[Any]
    claims: list[Any]
    questions: list[Any]
    model: str
    analysis_version: int


class AnalysisProvider(Protocol):
    def analyze(self, transcript: dict[str, Any]) -> AnalysisResult:
        """Return structured analysis for a persisted transcript."""


class AnalysisProviderError(Exception):
    """Base exception for controlled analysis provider failures."""


class RetryableProviderError(AnalysisProviderError):
    """Raised when a provider failure may be resolved by using another provider."""


class NonRetryableProviderError(AnalysisProviderError):
    """Raised when a provider cannot be used because of its configuration."""


class AnalysisProviderManagerError(AnalysisProviderError):
    """Raised when no configured analysis provider can produce a result."""


class AnalysisProviderManager:
    def __init__(self, providers: Sequence[AnalysisProvider]):
        self.providers = tuple(providers)
        if not self.providers:
            raise AnalysisProviderManagerError(
                "At least one analysis provider must be configured."
            )

    def analyze(self, transcript: dict[str, Any]) -> AnalysisResult:
        for provider in self.providers:
            try:
                return provider.analyze(transcript)
            except AnalysisProviderError:
                continue

        raise AnalysisProviderManagerError(
            "All configured analysis providers failed."
        ) from None


_ANALYSIS_FIELDS = (
    "summary",
    "detailed_notes",
    "topics",
    "concepts",
    "prerequisites",
    "upcoming_topics",
    "key_points",
    "claims",
    "questions",
)

_ANALYSIS_RESPONSE_SCHEMA = {
    "type": "object",
    "properties": {
        "summary": {"type": "string"},
        "detailed_notes": {
            "type": "object",
            "properties": {
                "sections": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "heading": {"type": "string"},
                            "content": {"type": "string"},
                        },
                        "required": ["heading", "content"],
                    },
                },
                "definitions": {
                    "type": "array",
                    "items": {"type": "string"},
                },
                "examples": {
                    "type": "array",
                    "items": {"type": "string"},
                },
            },
            "required": ["sections", "definitions", "examples"],
        },
        "topics": {"type": "array", "items": {"type": "string"}},
        "concepts": {"type": "array", "items": {"type": "string"}},
        "prerequisites": {"type": "array", "items": {"type": "string"}},
        "upcoming_topics": {"type": "array", "items": {"type": "string"}},
        "key_points": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "text": {"type": "string"},
                    "start": {"type": "number"},
                },
                "required": ["text", "start"],
            },
        },
        "claims": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "text": {"type": "string"},
                    "start": {"type": "number"},
                },
                "required": ["text", "start"],
            },
        },
        "questions": {"type": "array", "items": {"type": "string"}},
    },
    "required": list(_ANALYSIS_FIELDS),
}


def build_analysis_prompt(transcript: dict[str, Any]) -> str:
    transcript_json = json.dumps(transcript, ensure_ascii=False)
    return (
        "Analyze the complete timestamped video transcript below. Base every "
        "statement only on the transcript; do not invent facts, claims, "
        "prerequisites, later topics, or unrelated questions. Return only a "
        "JSON object matching the requested schema. Write a concise summary "
        "of what the video teaches or discusses. Provide detailed learner "
        "notes organized into sections, with supported definitions and "
        "examples (use empty arrays when none are supported). List major "
        "topics and explained concepts. Include prerequisites and upcoming "
        "topics only when supported by the transcript. Key points and factual "
        "claims must each include their exact source segment start timestamp "
        "as a numeric `start` value. Generate useful learner questions "
        "grounded in the transcript. `detailed_notes` must contain `sections` "
        "(objects with `heading` and `content`), `definitions`, and `examples`. "
        "`key_points` and `claims` must contain objects with `text` and `start`.\n\n"
        f"Transcript JSON:\n{transcript_json}"
    )


def _validate_timestamped_items(
    value: Any,
    field_name: str,
    source_timestamps: set[Real],
) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        raise ValueError(f"{field_name} must be a list.")

    for item in value:
        if (
            not isinstance(item, dict)
            or set(item) != {"text", "start"}
            or not isinstance(item["text"], str)
            or not item["text"].strip()
            or isinstance(item["start"], bool)
            or not isinstance(item["start"], Real)
            or not math.isfinite(item["start"])
            or item["start"] < 0
            or item["start"] not in source_timestamps
        ):
            raise ValueError(f"{field_name} contains an invalid item.")
    return value


def parse_analysis_result(
    raw_output: str,
    model: str,
    transcript: dict[str, Any],
) -> AnalysisResult:
    try:
        parsed = json.loads(raw_output)
        if not isinstance(parsed, dict) or set(parsed) != set(_ANALYSIS_FIELDS):
            raise ValueError("Analysis output fields do not match the schema.")
        source_timestamps = {
            segment["start"]
            for segment in transcript["segments"]
        }

        if (
            not isinstance(parsed["summary"], str)
            or not parsed["summary"].strip()
        ):
            raise ValueError("Analysis summary must be a non-empty string.")

        detailed_notes = parsed["detailed_notes"]
        if (
            not isinstance(detailed_notes, dict)
            or set(detailed_notes) != {"sections", "definitions", "examples"}
            or not isinstance(detailed_notes["sections"], list)
            or not isinstance(detailed_notes["definitions"], list)
            or not isinstance(detailed_notes["examples"], list)
            or any(
                not isinstance(item, str) or not item.strip()
                for name in ("definitions", "examples")
                for item in detailed_notes[name]
            )
        ):
            raise ValueError("Detailed notes do not match the schema.")

        for section in detailed_notes["sections"]:
            if (
                not isinstance(section, dict)
                or set(section) != {"heading", "content"}
                or not isinstance(section["heading"], str)
                or not section["heading"].strip()
                or not isinstance(section["content"], str)
                or not section["content"].strip()
            ):
                raise ValueError("Detailed notes contain an invalid section.")

        for field_name in (
            "topics",
            "concepts",
            "prerequisites",
            "upcoming_topics",
            "questions",
        ):
            value = parsed[field_name]
            if (
                not isinstance(value, list)
                or any(not isinstance(item, str) or not item.strip() for item in value)
            ):
                raise ValueError(f"{field_name} must be a list of strings.")

        key_points = _validate_timestamped_items(
            parsed["key_points"],
            "key_points",
            source_timestamps,
        )
        claims = _validate_timestamped_items(
            parsed["claims"],
            "claims",
            source_timestamps,
        )
        json.dumps(parsed, allow_nan=False)
    except (json.JSONDecodeError, TypeError, ValueError, OverflowError):
        raise RetryableProviderError(
            "The analysis provider returned malformed structured output."
        ) from None

    return AnalysisResult(
        summary=parsed["summary"],
        detailed_notes=detailed_notes,
        topics=parsed["topics"],
        concepts=parsed["concepts"],
        prerequisites=parsed["prerequisites"],
        upcoming_topics=parsed["upcoming_topics"],
        key_points=key_points,
        claims=claims,
        questions=parsed["questions"],
        model=model,
        analysis_version=1,
    )


def _raise_api_failure(provider_name: str, error: Exception) -> None:
    if isinstance(error, (TypeError, ValueError)):
        raise NonRetryableProviderError(
            f"{provider_name} analysis configuration is invalid."
        ) from None

    status_code = getattr(error, "status_code", None)
    if status_code is None:
        status_code = getattr(error, "code", None)
    if status_code is None:
        response = getattr(error, "response", None)
        status_code = getattr(response, "status_code", None)

    try:
        status_code = int(status_code)
    except (TypeError, ValueError):
        status_code = None

    if (
        status_code is not None
        and 400 <= status_code < 500
        and status_code not in (408, 429)
    ):
        raise NonRetryableProviderError(
            f"{provider_name} rejected the analysis request."
        ) from None

    raise RetryableProviderError(
        f"{provider_name} analysis request failed."
    ) from None


def _log_gemini_failure(error: Exception, model: str, api_key: str) -> None:
    message = str(error)
    hf_token = os.getenv("HF_TOKEN", "").strip()
    for secret in (api_key, hf_token):
        if secret:
            message = message.replace(secret, "[REDACTED]")

    message = re.sub(
        r"(?i)(authorization['\"]?\s*[:=]\s*['\"]?\s*)"
        r"(?:bearer\s+)?[^,\s'\"}]+",
        r"\1[REDACTED]",
        message,
    )
    message = re.sub(
        r"(?i)(x-goog-api-key['\"]?\s*[:=]\s*['\"]?\s*)"
        r"[^,\s'\"}]+",
        r"\1[REDACTED]",
        message,
    )
    message = re.sub(
        r"(?i)\bbearer\s+[A-Za-z0-9._~+/=-]+",
        "Bearer [REDACTED]",
        message,
    )
    message = re.sub(
        r"(?i)(request\s+(?:body|payload|headers?)\s*[:=]).*$",
        r"\1[REDACTED]",
        message,
    )
    message = re.sub(
        r"(?i)(headers?\s*[:=]).*$",
        r"\1[REDACTED]",
        message,
    )
    message = re.sub(
        r"(?i)((?:contents|messages|prompt)\s*[:=]).*$",
        r"\1[REDACTED]",
        message,
    )

    logger.error(
        "Gemini analysis request failed (model=%s, exception_type=%s): %s",
        model,
        type(error).__name__,
        message,
    )


class GeminiAnalysisProvider:
    def __init__(self):
        self.api_key = os.getenv("GEMINI_API_KEY", "").strip()
        self.model = os.getenv(
            "GEMINI_ANALYSIS_MODEL",
            "gemini-2.5-flash",
        ).strip()
        self._client: genai.Client | None = None

    def analyze(self, transcript: dict[str, Any]) -> AnalysisResult:
        if not self.api_key:
            raise NonRetryableProviderError(
                "Gemini API credentials are not configured."
            )
        if not self.model:
            raise NonRetryableProviderError(
                "Gemini analysis model configuration is invalid."
            )

        try:
            if self._client is None:
                self._client = genai.Client(api_key=self.api_key)
            response = self._client.models.generate_content(
                model=self.model,
                contents=build_analysis_prompt(transcript),
                config=types.GenerateContentConfig(
                    response_mime_type="application/json",
                    response_schema=_ANALYSIS_RESPONSE_SCHEMA,
                ),
            )
        except Exception as error:
            _log_gemini_failure(error, self.model, self.api_key)
            _raise_api_failure("Gemini", error)

        try:
            output = getattr(response, "text", None)
        except (AttributeError, TypeError, ValueError):
            output = None

        if not isinstance(output, str):
            raise RetryableProviderError(
                "Gemini returned malformed structured output."
            )
        return parse_analysis_result(output, self.model, transcript)


class HuggingFaceAnalysisProvider:
    def __init__(self):
        self.token = os.getenv("HF_TOKEN", "").strip()
        self.model = os.getenv(
            "HF_ANALYSIS_MODEL",
            "Qwen/Qwen3-32B",
        ).strip()

    def analyze(self, transcript: dict[str, Any]) -> AnalysisResult:
        if not self.token:
            raise NonRetryableProviderError(
                "Hugging Face credentials are not configured."
            )
        if not self.model:
            raise NonRetryableProviderError(
                "Hugging Face analysis model configuration is invalid."
            )

        try:
            client = InferenceClient(model=self.model, token=self.token)
            response = client.chat_completion(
                messages=[
                    {
                        "role": "user",
                        "content": build_analysis_prompt(transcript),
                    }
                ],
                response_format={
                    "type": "json_schema",
                    "json_schema": {
                        "name": "video_analysis",
                        "strict": True,
                        "schema": _ANALYSIS_RESPONSE_SCHEMA,
                    },
                },
                max_tokens=4096,
            )
        except Exception as error:
            _raise_api_failure("Hugging Face", error)

        try:
            output = response.choices[0].message.content
        except (AttributeError, IndexError, TypeError, ValueError):
            output = None
        if not isinstance(output, str):
            raise RetryableProviderError(
                "Hugging Face returned malformed structured output."
            )
        return parse_analysis_result(output, self.model, transcript)


class MockAnalysisProvider:
    model = "mock"
    analysis_version = 1

    def analyze(self, transcript: dict[str, Any]) -> AnalysisResult:
        segments = transcript["segments"]
        segment_texts = [
            segment["text"].strip()
            for segment in segments
            if isinstance(segment.get("text"), str)
            and segment["text"].strip()
        ]
        transcript_text = " ".join(segment_texts)

        words = []
        for word in transcript_text.lower().split():
            normalized = word.strip(".,!?;:\"'()[]{}")
            if len(normalized) >= 4 and normalized not in words:
                words.append(normalized)

        return AnalysisResult(
            summary=f"Transcript summary: {transcript_text[:240]}",
            detailed_notes={"transcript_segment_count": len(segments)},
            topics=words[:3],
            concepts=[],
            prerequisites=[],
            upcoming_topics=[],
            key_points=[
                {
                    "text": segment["text"],
                    "start": segment["start"],
                }
                for segment in segments[:3]
            ],
            claims=[],
            questions=[
                f"What is discussed here: {text}?"
                for text in segment_texts[:3]
            ],
            model=self.model,
            analysis_version=self.analysis_version,
        )
