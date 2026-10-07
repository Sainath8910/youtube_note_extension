import math
from numbers import Real

from youtube_transcript_api import YouTubeTranscriptApi
from youtube_transcript_api._errors import (
    CouldNotRetrieveTranscript,
    InvalidVideoId,
    NoTranscriptFound,
    TranscriptsDisabled,
    VideoUnavailable,
    VideoUnplayable,
    YouTubeTranscriptApiException,
)


class TranscriptUnavailableError(Exception):
    """Raised when YouTube has no usable transcript for a video."""


class TranscriptRetrievalError(Exception):
    """Raised when YouTube cannot return a valid transcript."""


def fetch_youtube_transcript(youtube_id: str) -> dict:
    api = YouTubeTranscriptApi()

    try:
        available_transcripts = list(api.list(youtube_id))
        if not available_transcripts:
            raise TranscriptUnavailableError(
                "No captions or transcript are available for this video."
            )

        preferred_languages = ("en", "en-US", "en-GB")
        preferred_rank = {
            language: index
            for index, language in enumerate(preferred_languages)
        }
        selected_transcript = min(
            available_transcripts,
            key=lambda transcript: preferred_rank.get(
                transcript.language_code,
                len(preferred_languages),
            ),
        )
        fetched_transcript = selected_transcript.fetch()
    except (
        InvalidVideoId,
        NoTranscriptFound,
        TranscriptsDisabled,
        VideoUnavailable,
        VideoUnplayable,
    ) as error:
        raise TranscriptUnavailableError(
            "No captions or transcript are available for this video."
        ) from error
    except CouldNotRetrieveTranscript as error:
        raise TranscriptRetrievalError(
            "YouTube could not provide the transcript."
        ) from error
    except YouTubeTranscriptApiException as error:
        raise TranscriptRetrievalError(
            "YouTube could not provide the transcript."
        ) from error

    language = getattr(fetched_transcript, "language_code", None)
    snippets = getattr(fetched_transcript, "snippets", None)
    if not isinstance(language, str) or not language or not isinstance(
        snippets, list
    ):
        raise TranscriptRetrievalError(
            "YouTube returned an invalid transcript response."
        )

    segments = []
    for snippet in snippets:
        text = getattr(snippet, "text", None)
        start = getattr(snippet, "start", None)
        duration = getattr(snippet, "duration", None)
        if (
            not isinstance(text, str)
            or isinstance(start, bool)
            or not isinstance(start, Real)
            or not math.isfinite(start)
            or isinstance(duration, bool)
            or not isinstance(duration, Real)
            or not math.isfinite(duration)
            or duration < 0
        ):
            raise TranscriptRetrievalError(
                "YouTube returned an invalid transcript segment."
            )

        segments.append(
            {
                "text": text,
                "start": start,
                "duration": duration,
            }
        )

    if not segments:
        raise TranscriptRetrievalError(
            "YouTube returned an empty transcript."
        )

    return {
        "language": language,
        "segments": segments,
    }
