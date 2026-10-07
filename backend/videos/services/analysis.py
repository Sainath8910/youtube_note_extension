import json
import math
from dataclasses import fields
from numbers import Real
from typing import Any

from django.db import transaction
from django.utils import timezone

from videos.models import Video, VideoAnalysis
from videos.services.analysis_providers import (
    AnalysisProvider,
    AnalysisProviderManager,
    AnalysisResult,
    GeminiAnalysisProvider,
    HuggingFaceAnalysisProvider,
)


class AnalysisError(Exception):
    """Base exception for video analysis service failures."""


class TranscriptNotReadyError(AnalysisError):
    """Raised when a video transcript is not ready for analysis."""


class TranscriptUnavailableForAnalysisError(AnalysisError):
    """Raised when a video has no usable persisted transcript."""


class InvalidAnalysisResultError(AnalysisError):
    """Raised when an analysis provider returns an invalid result."""


def build_analysis_provider_manager() -> AnalysisProviderManager:
    return AnalysisProviderManager(
        [
            GeminiAnalysisProvider(),
            HuggingFaceAnalysisProvider(),
        ]
    )


def _validate_transcript(video: Video) -> dict[str, Any]:
    if video.transcript_status != Video.TranscriptStatus.READY:
        raise TranscriptNotReadyError(
            "The video transcript is not ready for analysis."
        )

    segments = video.transcript
    if not isinstance(segments, list) or not segments:
        raise TranscriptUnavailableForAnalysisError(
            "The video has no usable persisted transcript."
        )

    for segment in segments:
        if not isinstance(segment, dict):
            raise TranscriptUnavailableForAnalysisError(
                "The video has no usable persisted transcript."
            )
        start = segment.get("start")
        duration = segment.get("duration")
        if (
            not isinstance(segment.get("text"), str)
            or isinstance(start, bool)
            or not isinstance(start, Real)
            or not math.isfinite(start)
            or isinstance(duration, bool)
            or not isinstance(duration, Real)
            or not math.isfinite(duration)
            or duration < 0
        ):
            raise TranscriptUnavailableForAnalysisError(
                "The video has no usable persisted transcript."
            )

    return {
        "language": video.transcript_language,
        "segments": segments,
    }


def _validate_result(result: AnalysisResult) -> dict[str, Any]:
    if not isinstance(result, AnalysisResult):
        raise InvalidAnalysisResultError(
            "The analysis provider returned an invalid result."
        )

    values = {
        field.name: getattr(result, field.name)
        for field in fields(AnalysisResult)
    }
    if (
        not isinstance(result.summary, str)
        or not isinstance(result.detailed_notes, dict)
        or any(
            not isinstance(getattr(result, name), list)
            for name in (
                "topics",
                "concepts",
                "prerequisites",
                "upcoming_topics",
                "key_points",
                "claims",
                "questions",
            )
        )
        or not isinstance(result.model, str)
        or isinstance(result.analysis_version, bool)
        or not isinstance(result.analysis_version, int)
        or result.analysis_version < 1
    ):
        raise InvalidAnalysisResultError(
            "The analysis provider returned an invalid result."
        )

    try:
        json.dumps(values, allow_nan=False)
    except (TypeError, ValueError) as error:
        raise InvalidAnalysisResultError(
            "The analysis provider returned non-JSON analysis data."
        ) from error

    return values


def _mark_failed(video: Video) -> None:
    video.analysis_status = Video.AnalysisStatus.FAILED
    video.save(update_fields=["analysis_status", "updated_at"])


def analyze_video(
    video: Video,
    provider: AnalysisProvider,
) -> VideoAnalysis:
    if video.pk is None:
        raise AnalysisError("Save the video before analyzing it.")

    try:
        transcript = _validate_transcript(video)
    except AnalysisError:
        _mark_failed(video)
        raise

    video.analysis_status = Video.AnalysisStatus.ANALYZING
    video.save(update_fields=["analysis_status", "updated_at"])

    try:
        result = provider.analyze(transcript)
        values = _validate_result(result)
    except Exception as error:
        _mark_failed(video)
        if isinstance(error, AnalysisError):
            raise
        raise AnalysisError("Video analysis failed.") from error

    try:
        with transaction.atomic():
            analysis, _ = VideoAnalysis.objects.update_or_create(
                video_id=video.pk,
                defaults=values,
            )
            video.analysis_status = Video.AnalysisStatus.READY
            video.save(update_fields=["analysis_status", "updated_at"])
    except Exception as error:
        _mark_failed(video)
        raise AnalysisError("Video analysis could not be saved.") from error

    return analysis
