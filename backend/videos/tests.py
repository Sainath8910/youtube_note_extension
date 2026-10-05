import json
import os
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import MagicMock, patch

import yt_dlp
from django.test import TestCase as DjangoTestCase
from rest_framework.test import APIClient
from youtube_transcript_api._errors import YouTubeTranscriptApiException

from notes.models import Note
from users.models import User
from videos.models import Video
from videos.models import VideoAnalysis
from videos.serializers import VideoAnalysisSerializer
from videos.services.analysis import (
    AnalysisError,
    InvalidAnalysisResultError,
    TranscriptNotReadyError,
    TranscriptUnavailableForAnalysisError,
    analyze_video,
)
from videos.services.analysis_providers import (
    AnalysisProviderManager,
    AnalysisProviderManagerError,
    AnalysisResult,
    GeminiAnalysisProvider,
    HuggingFaceAnalysisProvider,
    MockAnalysisProvider,
    NonRetryableProviderError,
    RetryableProviderError,
)
from videos.services.youtube import (
    InvalidYouTubeVideoIdError,
    YouTubeMetadataError,
    fetch_youtube_metadata,
)
from videos.services.transcript import (
    TranscriptRetrievalError,
    TranscriptUnavailableError,
    fetch_youtube_transcript,
)


class FetchYouTubeMetadataTests(TestCase):
    @patch("videos.services.youtube.yt_dlp.YoutubeDL")
    def test_returns_backend_resolved_metadata(self, youtube_dl_class):
        info = {
            "title": "Example video",
            "channel": "Example channel",
            "uploader_id": "@example",
            "channel_id": "UCexample",
            "duration": 92.6,
        }
        youtube_dl = MagicMock()
        youtube_dl.extract_info.return_value = info
        youtube_dl_class.return_value.__enter__.return_value = youtube_dl

        metadata = fetch_youtube_metadata("abcdefghijk")

        self.assertEqual(
            metadata,
            {
                "title": "Example video",
                "channel_name": "Example channel",
                "channel_handle": "@example",
                "channel_id": "UCexample",
                "thumbnail_url": (
                    "https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg"
                ),
                "duration_seconds": 93,
            },
        )
        youtube_dl.extract_info.assert_called_once_with(
            "https://www.youtube.com/watch?v=abcdefghijk",
            download=False,
        )

    @patch("videos.services.youtube.yt_dlp.YoutubeDL")
    def test_rejects_missing_required_metadata(self, youtube_dl_class):
        youtube_dl = MagicMock()
        youtube_dl.extract_info.return_value = {"title": "No channel"}
        youtube_dl_class.return_value.__enter__.return_value = youtube_dl

        with self.assertRaises(YouTubeMetadataError):
            fetch_youtube_metadata("abcdefghijk")

    @patch("videos.services.youtube.yt_dlp.YoutubeDL")
    def test_wraps_youtube_extraction_failures(self, youtube_dl_class):
        youtube_dl = MagicMock()
        youtube_dl.extract_info.side_effect = yt_dlp.utils.DownloadError(
            "unavailable"
        )
        youtube_dl_class.return_value.__enter__.return_value = youtube_dl

        with self.assertRaises(YouTubeMetadataError):
            fetch_youtube_metadata("abcdefghijk")

    def test_rejects_invalid_video_ids_without_fetching(self):
        with patch("videos.services.youtube.yt_dlp.YoutubeDL") as youtube_dl:
            with self.assertRaises(InvalidYouTubeVideoIdError):
                fetch_youtube_metadata("not-an-id")

        youtube_dl.assert_not_called()


class FetchYouTubeTranscriptTests(TestCase):
    @patch("videos.services.transcript.YouTubeTranscriptApi")
    def test_prefers_english_and_preserves_timestamped_segments(self, api_class):
        french = MagicMock(language_code="fr")
        english = MagicMock(language_code="en")
        fetched = SimpleNamespace(
            language_code="en",
            snippets=[
                SimpleNamespace(
                    text="First segment",
                    start=12.34,
                    duration=4.56,
                )
            ],
        )
        english.fetch.return_value = fetched
        api_class.return_value.list.return_value = [french, english]

        result = fetch_youtube_transcript("abcdefghijk")

        self.assertEqual(
            result,
            {
                "language": "en",
                "segments": [
                    {
                        "text": "First segment",
                        "start": 12.34,
                        "duration": 4.56,
                    }
                ],
            },
        )
        english.fetch.assert_called_once_with()
        french.fetch.assert_not_called()

    @patch("videos.services.transcript.YouTubeTranscriptApi")
    def test_uses_available_non_english_transcript(self, api_class):
        transcript = MagicMock(language_code="fr")
        transcript.fetch.return_value = SimpleNamespace(
            language_code="fr",
            snippets=[
                SimpleNamespace(text="Bonjour", start=0, duration=2),
            ],
        )
        api_class.return_value.list.return_value = [transcript]

        result = fetch_youtube_transcript("abcdefghijk")

        self.assertEqual(result["language"], "fr")
        transcript.fetch.assert_called_once_with()

    @patch("videos.services.transcript.YouTubeTranscriptApi")
    def test_rejects_malformed_transcript_segment(self, api_class):
        transcript = MagicMock(language_code="en")
        transcript.fetch.return_value = SimpleNamespace(
            language_code="en",
            snippets=[
                SimpleNamespace(text="Bad timing", start=float("nan"), duration=1),
            ],
        )
        api_class.return_value.list.return_value = [transcript]

        with self.assertRaises(TranscriptRetrievalError):
            fetch_youtube_transcript("abcdefghijk")

    @patch("videos.services.transcript.YouTubeTranscriptApi")
    def test_reports_when_no_transcripts_are_available(self, api_class):
        api_class.return_value.list.return_value = []

        with self.assertRaises(TranscriptUnavailableError):
            fetch_youtube_transcript("abcdefghijk")

    @patch("videos.services.transcript.YouTubeTranscriptApi")
    def test_wraps_transcript_api_failures(self, api_class):
        api_class.return_value.list.side_effect = YouTubeTranscriptApiException(
            "private API detail"
        )

        with self.assertRaisesRegex(
            TranscriptRetrievalError,
            "YouTube could not provide the transcript",
        ):
            fetch_youtube_transcript("abcdefghijk")


class VideoContextEndpointTests(DjangoTestCase):
    def setUp(self):
        self.client = APIClient()
        self.user = User.objects.create_user(username="video-context-user")
        self.client.force_authenticate(user=self.user)
        self.url = "/api/videos/abcdefghijk/"

    def test_video_without_analysis_returns_null_analysis(self):
        video = Video.objects.create(
            youtube_id="abcdefghijk",
            title="Example video",
        )

        response = self.client.get(self.url)

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.data["saved"])
        self.assertEqual(response.data["video"]["id"], video.pk)
        self.assertEqual(response.data["video"]["youtube_id"], video.youtube_id)
        self.assertEqual(response.data["video"]["title"], video.title)
        self.assertIsNone(response.data["video"]["analysis"])
        self.assertEqual(response.data["notes"], [])

    def test_video_with_analysis_returns_full_persisted_analysis(self):
        video = Video.objects.create(
            youtube_id="abcdefghijk",
            analysis_status=Video.AnalysisStatus.READY,
        )
        analysis = VideoAnalysis.objects.create(
            video=video,
            summary="Persisted summary.",
            detailed_notes={"sections": [{"heading": "Topic", "content": "Notes"}]},
            topics=["topic"],
            concepts=["concept"],
            prerequisites=["basics"],
            upcoming_topics=["next topic"],
            key_points=[{"text": "Key point.", "start": 1.5}],
            claims=[{"text": "Claim.", "start": 2.5}],
            questions=["Question?"],
            model="persisted-model",
            analysis_version=3,
        )

        response = self.client.get(self.url)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.data["video"]["analysis"],
            VideoAnalysisSerializer(analysis).data,
        )

    def test_context_preserves_saved_video_and_user_scoped_notes(self):
        video = Video.objects.create(
            youtube_id="abcdefghijk",
            title="Example video",
        )
        other_user = User.objects.create_user(username="other-video-context-user")
        user_note = Note.objects.create(
            user=self.user,
            title="My note",
            document={"version": 1, "blocks": []},
            note_type=Note.NoteType.VIDEO,
            video=video,
        )
        Note.objects.create(
            user=other_user,
            title="Other user's note",
            document={"version": 1, "blocks": []},
            note_type=Note.NoteType.VIDEO,
            video=video,
        )

        response = self.client.get(self.url)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.data["video"]["youtube_id"],
            video.youtube_id,
        )
        self.assertEqual(
            [note["id"] for note in response.data["notes"]],
            [user_note.pk],
        )

    def test_missing_video_preserves_unsaved_context_response(self):
        response = self.client.get("/api/videos/zyxwvutsrqp/")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.data,
            {
                "saved": False,
                "video": None,
                "notes": [],
            },
        )


class TranscriptEndpointTests(DjangoTestCase):
    def setUp(self):
        self.client = APIClient()
        self.client.force_authenticate(
            user=User.objects.create_user(username="transcript-test-user")
        )

    @patch("videos.views.fetch_youtube_transcript")
    def test_fetches_persists_and_does_not_refetch_ready_transcript(
        self,
        fetch_transcript,
    ):
        transcript = {
            "language": "en",
            "segments": [
                {"text": "Example", "start": 12.34, "duration": 4.56},
            ],
        }

        def fetch_while_fetching(youtube_id):
            video = Video.objects.get(youtube_id=youtube_id)
            self.assertEqual(
                video.transcript_status,
                Video.TranscriptStatus.FETCHING,
            )
            return transcript

        fetch_transcript.side_effect = fetch_while_fetching
        url = "/api/videos/abcdefghijk/transcript/"

        response = self.client.post(url, {}, format="json")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["transcript_status"], "READY")
        video = Video.objects.get(youtube_id="abcdefghijk")
        self.assertEqual(video.transcript, transcript["segments"])
        self.assertEqual(video.transcript_language, "en")
        self.assertIsNotNone(video.transcript_fetched_at)

        second_response = self.client.post(url, {}, format="json")

        self.assertEqual(second_response.status_code, 200)
        self.assertEqual(fetch_transcript.call_count, 1)

    @patch(
        "videos.views.fetch_youtube_transcript",
        side_effect=TranscriptUnavailableError(
            "No captions or transcript are available for this video."
        ),
    )
    def test_marks_unavailable_transcript_failed(self, _fetch_transcript):
        response = self.client.post(
            "/api/videos/abcdefghijk/transcript/",
            {},
            format="json",
        )

        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.data["transcript_status"], "FAILED")
        video = Video.objects.get(youtube_id="abcdefghijk")
        self.assertEqual(video.transcript_status, Video.TranscriptStatus.FAILED)
        self.assertIsNone(video.transcript)

    @patch(
        "videos.views.fetch_youtube_transcript",
        side_effect=TranscriptRetrievalError(
            "YouTube could not provide the transcript."
        ),
    )
    def test_failed_attempt_preserves_previous_transcript(self, _fetch_transcript):
        existing_transcript = [
            {"text": "Previously saved", "start": 0, "duration": 1},
        ]
        Video.objects.create(
            youtube_id="abcdefghijk",
            transcript=existing_transcript,
            transcript_language="en",
            transcript_status=Video.TranscriptStatus.FETCHING,
        )

        response = self.client.post(
            "/api/videos/abcdefghijk/transcript/",
            {},
            format="json",
        )

        self.assertEqual(response.status_code, 502)
        video = Video.objects.get(youtube_id="abcdefghijk")
        self.assertEqual(video.transcript_status, Video.TranscriptStatus.FAILED)
        self.assertEqual(video.transcript, existing_transcript)


class VideoAnalysisEndpointTests(DjangoTestCase):
    def setUp(self):
        self.client = APIClient()
        self.client.force_authenticate(
            user=User.objects.create_user(username="analysis-endpoint-user")
        )
        self.video = Video.objects.create(
            youtube_id="abcdefghijk",
            transcript_status=Video.TranscriptStatus.READY,
            transcript_language="en",
            transcript=[
                {
                    "text": "Python makes reliable testing easier.",
                    "start": 1.25,
                    "duration": 2.5,
                },
                {
                    "text": "Tests protect important behavior.",
                    "start": 3.75,
                    "duration": 2,
                },
            ],
        )
        self.url = "/api/videos/abcdefghijk/analyze/"
        self.result = AnalysisResult(
            summary="A structured analysis.",
            detailed_notes={"sections": [{"heading": "Testing", "content": "Notes"}]},
            topics=["testing"],
            concepts=["reliability"],
            prerequisites=["basics"],
            upcoming_topics=["advanced tests"],
            key_points=[{"text": "Tests improve confidence.", "start": 1.25}],
            claims=[{"text": "Testing detects regressions.", "start": 1.25}],
            questions=["Why write tests?"],
            model="Qwen/Qwen3-32B",
            analysis_version=1,
        )

    @staticmethod
    def build_manager(primary, fallback):
        return AnalysisProviderManager([primary, fallback])

    def test_successful_analysis_routes_and_persists_fallback_result(self):
        primary = MagicMock()
        primary.analyze.side_effect = RetryableProviderError(
            "private simulated Gemini failure"
        )
        fallback = MagicMock()
        fallback.analyze.return_value = self.result
        manager = self.build_manager(primary, fallback)

        with patch(
            "videos.views.build_analysis_provider_manager",
            return_value=manager,
        ) as manager_factory:
            response = self.client.post(self.url, {}, format="json")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["status"], "READY")
        self.assertEqual(response.data["video_id"], self.video.youtube_id)
        self.assertEqual(response.data["analysis"]["video"], self.video.pk)
        self.assertEqual(response.data["analysis"]["model"], "Qwen/Qwen3-32B")
        for field in (
            "summary",
            "detailed_notes",
            "topics",
            "concepts",
            "prerequisites",
            "upcoming_topics",
            "key_points",
            "claims",
            "questions",
            "analysis_version",
            "created_at",
            "updated_at",
        ):
            self.assertIn(field, response.data["analysis"])
        primary.analyze.assert_called_once()
        fallback.analyze.assert_called_once()
        manager_factory.assert_called_once_with()
        self.video.refresh_from_db()
        self.assertEqual(self.video.analysis_status, Video.AnalysisStatus.READY)
        self.assertEqual(VideoAnalysis.objects.filter(video=self.video).count(), 1)
        analysis = VideoAnalysis.objects.get(video=self.video)
        self.assertEqual(analysis.summary, self.result.summary)
        self.assertEqual(analysis.detailed_notes, self.result.detailed_notes)
        self.assertEqual(analysis.topics, self.result.topics)
        self.assertEqual(analysis.concepts, self.result.concepts)
        self.assertEqual(analysis.prerequisites, self.result.prerequisites)
        self.assertEqual(analysis.upcoming_topics, self.result.upcoming_topics)
        self.assertEqual(analysis.key_points, self.result.key_points)
        self.assertEqual(analysis.claims, self.result.claims)
        self.assertEqual(analysis.questions, self.result.questions)
        self.assertEqual(analysis.model, self.result.model)

    def test_missing_video_returns_404(self):
        response = self.client.post(
            "/api/videos/zyxwvutsrqp/analyze/",
            {},
            format="json",
        )

        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.data["error"], "Video not found.")

    def test_transcript_not_ready_does_not_attempt_analysis(self):
        self.video.transcript_status = Video.TranscriptStatus.FETCHING
        self.video.save(update_fields=["transcript_status"])

        with patch("videos.views.build_analysis_provider_manager") as factory:
            response = self.client.post(self.url, {}, format="json")

        self.assertEqual(response.status_code, 409)
        self.assertIn("Retrieve the transcript", response.data["error"])
        self.assertEqual(
            response.data["transcript_status"],
            Video.TranscriptStatus.FETCHING,
        )
        factory.assert_not_called()
        self.video.refresh_from_db()
        self.assertEqual(
            self.video.analysis_status,
            Video.AnalysisStatus.NOT_STARTED,
        )
        self.assertFalse(VideoAnalysis.objects.filter(video=self.video).exists())

    def test_ready_analysis_is_returned_without_creating_provider_manager(self):
        existing = analyze_video(self.video, MockAnalysisProvider())

        with patch("videos.views.build_analysis_provider_manager") as factory:
            response = self.client.post(self.url, {}, format="json")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["analysis"]["id"], existing.pk)
        self.assertEqual(response.data["analysis"]["model"], "mock")
        factory.assert_not_called()
        self.assertEqual(VideoAnalysis.objects.filter(video=self.video).count(), 1)

    def test_provider_failure_is_sanitized_and_preserves_existing_analysis(self):
        existing = analyze_video(self.video, MockAnalysisProvider())
        old_summary = existing.summary
        self.video.analysis_status = Video.AnalysisStatus.FAILED
        self.video.save(update_fields=["analysis_status"])
        primary = MagicMock()
        primary.analyze.side_effect = RetryableProviderError(
            "private Gemini exception"
        )
        fallback = MagicMock()
        fallback.analyze.side_effect = RetryableProviderError(
            "private Hugging Face exception"
        )
        manager = self.build_manager(primary, fallback)

        with patch(
            "videos.views.build_analysis_provider_manager",
            return_value=manager,
        ):
            response = self.client.post(self.url, {}, format="json")

        self.assertEqual(response.status_code, 502)
        self.assertEqual(response.data["error"], "Video analysis failed.")
        self.assertNotIn("private", str(response.data))
        self.video.refresh_from_db()
        existing.refresh_from_db()
        self.assertEqual(self.video.analysis_status, Video.AnalysisStatus.FAILED)
        self.assertEqual(existing.summary, old_summary)
        self.assertEqual(VideoAnalysis.objects.filter(video=self.video).count(), 1)


class AnalysisProviderManagerTests(TestCase):
    transcript = {"language": "en", "segments": []}

    @staticmethod
    def make_result(model):
        return AnalysisResult(
            summary=f"Result from {model}",
            detailed_notes={},
            topics=[],
            concepts=[],
            prerequisites=[],
            upcoming_topics=[],
            key_points=[],
            claims=[],
            questions=[],
            model=model,
            analysis_version=1,
        )

    def test_returns_first_success_without_calling_fallback(self):
        result = self.make_result("provider-a")
        provider_a = MagicMock()
        provider_a.analyze.return_value = result
        provider_b = MagicMock()
        manager = AnalysisProviderManager([provider_a, provider_b])

        returned = manager.analyze(self.transcript)

        self.assertIs(returned, result)
        self.assertEqual(returned.model, "provider-a")
        provider_a.analyze.assert_called_once_with(self.transcript)
        provider_b.analyze.assert_not_called()

    def test_retryable_failure_falls_back_in_order(self):
        result = self.make_result("provider-b")
        call_order = []
        provider_a = MagicMock()
        provider_b = MagicMock()

        def fail(transcript):
            self.assertEqual(transcript, self.transcript)
            call_order.append("provider-a")
            raise RetryableProviderError("temporarily unavailable")

        def succeed(transcript):
            self.assertEqual(transcript, self.transcript)
            call_order.append("provider-b")
            return result

        provider_a.analyze.side_effect = fail
        provider_b.analyze.side_effect = succeed
        manager = AnalysisProviderManager([provider_a, provider_b])

        returned = manager.analyze(self.transcript)

        self.assertIs(returned, result)
        self.assertEqual(call_order, ["provider-a", "provider-b"])

    def test_gemini_retryable_failure_falls_back_to_huggingface(self):
        result = self.make_result("Qwen/Qwen3-32B")
        call_order = []
        gemini = GeminiAnalysisProvider()
        huggingface = HuggingFaceAnalysisProvider()

        def fail_gemini(transcript):
            self.assertEqual(transcript, self.transcript)
            call_order.append("gemini")
            raise RetryableProviderError("private Gemini failure details")

        def succeed_huggingface(transcript):
            self.assertEqual(transcript, self.transcript)
            call_order.append("huggingface")
            return result

        with (
            patch.object(gemini, "analyze", side_effect=fail_gemini) as gemini_analyze,
            patch.object(
                huggingface,
                "analyze",
                side_effect=succeed_huggingface,
            ) as huggingface_analyze,
        ):
            manager = AnalysisProviderManager([gemini, huggingface])
            returned = manager.analyze(self.transcript)

        self.assertEqual(call_order, ["gemini", "huggingface"])
        gemini_analyze.assert_called_once_with(self.transcript)
        huggingface_analyze.assert_called_once_with(self.transcript)
        self.assertIs(returned, result)
        self.assertEqual(returned.model, "Qwen/Qwen3-32B")
        self.assertNotIn("private Gemini failure details", str(returned))

    def test_non_retryable_failure_skips_to_next_provider(self):
        result = self.make_result("provider-b")
        provider_a = MagicMock()
        provider_a.analyze.side_effect = NonRetryableProviderError(
            "provider is not configured"
        )
        provider_b = MagicMock()
        provider_b.analyze.return_value = result
        manager = AnalysisProviderManager([provider_a, provider_b])

        returned = manager.analyze(self.transcript)

        self.assertIs(returned, result)
        provider_a.analyze.assert_called_once_with(self.transcript)
        provider_b.analyze.assert_called_once_with(self.transcript)

    def test_all_failures_raise_sanitized_manager_error(self):
        provider_a = MagicMock()
        provider_a.analyze.side_effect = RetryableProviderError(
            "credential=secret"
        )
        provider_b = MagicMock()
        provider_b.analyze.side_effect = NonRetryableProviderError(
            "credential=secret"
        )
        manager = AnalysisProviderManager([provider_a, provider_b])

        with self.assertRaises(AnalysisProviderManagerError) as error:
            manager.analyze(self.transcript)

        self.assertNotIn("secret", str(error.exception))
        provider_a.analyze.assert_called_once_with(self.transcript)
        provider_b.analyze.assert_called_once_with(self.transcript)

    def test_rejects_empty_provider_list(self):
        with self.assertRaises(AnalysisProviderManagerError):
            AnalysisProviderManager([])


class ExternalAnalysisProviderTests(TestCase):
    transcript = {
        "language": "en",
        "segments": [
            {
                "text": "A real transcript segment.",
                "start": 18.64,
                "duration": 3.24,
            }
        ],
    }
    output = {
        "summary": "The video explains a concept.",
        "detailed_notes": {
            "sections": [
                {
                    "heading": "Main idea",
                    "content": "The speaker explains the concept.",
                }
            ],
            "definitions": [],
            "examples": [],
        },
        "topics": ["Concept"],
        "concepts": ["Core idea"],
        "prerequisites": [],
        "upcoming_topics": [],
        "key_points": [
            {"text": "The main point.", "start": 18.64},
        ],
        "claims": [
            {"text": "A supported factual claim.", "start": 18.64},
        ],
        "questions": ["What is the main idea?"],
    }

    def expected_result(self, model):
        return AnalysisResult(
            **self.output,
            model=model,
            analysis_version=1,
        )

    def test_gemini_returns_valid_result_using_configured_model_and_transcript(self):
        with (
            patch.dict(
                os.environ,
                {
                    "GEMINI_API_KEY": "test-gemini-key",
                    "GEMINI_ANALYSIS_MODEL": "test-gemini-model",
                },
            ),
            patch("videos.services.analysis_providers.genai.Client") as client_class,
        ):
            client = client_class.return_value
            client.models.generate_content.return_value = SimpleNamespace(
                text=json.dumps(self.output)
            )

            result = GeminiAnalysisProvider().analyze(self.transcript)

        self.assertEqual(result, self.expected_result("test-gemini-model"))
        client_class.assert_called_once_with(api_key="test-gemini-key")
        request = client.models.generate_content.call_args.kwargs
        self.assertEqual(request["model"], "test-gemini-model")
        self.assertIn("A real transcript segment.", request["contents"])
        self.assertIn("18.64", request["contents"])
        self.assertEqual(
            request["config"].response_mime_type,
            "application/json",
        )
        self.assertEqual(
            set(request["config"].response_schema["required"]),
            set(self.output),
        )
        self.assertNotIn(
            "additionalProperties",
            json.dumps(request["config"].response_schema),
        )

    def test_gemini_reuses_live_client_for_repeated_analysis(self):
        with (
            patch.dict(os.environ, {"GEMINI_API_KEY": "test-gemini-key"}),
            patch("videos.services.analysis_providers.genai.Client") as client_class,
        ):
            client = client_class.return_value
            client.closed = False

            def generate_content(**kwargs):
                if client.closed:
                    raise RuntimeError(
                        "Cannot send a request, as the client has been closed."
                    )
                self.assertIn(
                    "A real transcript segment.",
                    kwargs["contents"],
                )
                return SimpleNamespace(text=json.dumps(self.output))

            client.models.generate_content.side_effect = generate_content
            provider = GeminiAnalysisProvider()

            first_result = provider.analyze(self.transcript)
            second_result = provider.analyze(self.transcript)

        self.assertEqual(first_result, self.expected_result("gemini-2.5-flash"))
        self.assertEqual(second_result, self.expected_result("gemini-2.5-flash"))
        client_class.assert_called_once_with(api_key="test-gemini-key")
        self.assertIs(provider._client, client)
        self.assertEqual(client.models.generate_content.call_count, 2)
        self.assertFalse(client.closed)

    def test_gemini_missing_api_key_is_non_retryable(self):
        with patch.dict(os.environ, {"GEMINI_API_KEY": ""}):
            with self.assertRaises(NonRetryableProviderError):
                GeminiAnalysisProvider().analyze(self.transcript)

    def test_gemini_api_failure_is_retryable(self):
        with (
            patch.dict(
                os.environ,
                {
                    "GEMINI_API_KEY": "test-gemini-key",
                    "GEMINI_ANALYSIS_MODEL": "test-gemini-model",
                    "HF_TOKEN": "test-hf-token",
                },
            ),
            patch("videos.services.analysis_providers.genai.Client") as client_class,
        ):
            client_class.return_value.models.generate_content.side_effect = (
                TimeoutError(
                    "simulated timeout Authorization: Bearer auth-secret "
                    "request payload={transcript secret}"
                )
            )

            with self.assertLogs(
                "videos.services.analysis_providers",
                level="ERROR",
            ) as captured_logs:
                with self.assertRaises(RetryableProviderError) as error:
                    GeminiAnalysisProvider().analyze(self.transcript)

        self.assertEqual(
            str(error.exception),
            "Gemini analysis request failed.",
        )
        log_output = "\n".join(captured_logs.output)
        self.assertIn("TimeoutError", log_output)
        self.assertIn("simulated timeout", log_output)
        self.assertIn("test-gemini-model", log_output)
        self.assertNotIn("test-gemini-key", log_output)
        self.assertNotIn("test-hf-token", log_output)
        self.assertNotIn("auth-secret", log_output)
        self.assertNotIn("transcript secret", log_output)

    def test_gemini_malformed_structured_response_is_retryable(self):
        with (
            patch.dict(os.environ, {"GEMINI_API_KEY": "test-gemini-key"}),
            patch("videos.services.analysis_providers.genai.Client") as client_class,
        ):
            client_class.return_value.models.generate_content.return_value = (
                SimpleNamespace(text='{"summary": "missing fields"}')
            )

            with self.assertRaises(RetryableProviderError):
                GeminiAnalysisProvider().analyze(self.transcript)

    def test_gemini_rejects_timestamps_not_present_in_transcript(self):
        malformed_output = json.loads(json.dumps(self.output))
        malformed_output["key_points"][0]["start"] = 99.9
        with (
            patch.dict(os.environ, {"GEMINI_API_KEY": "test-gemini-key"}),
            patch("videos.services.analysis_providers.genai.Client") as client_class,
        ):
            client_class.return_value.models.generate_content.return_value = (
                SimpleNamespace(text=json.dumps(malformed_output))
            )

            with self.assertRaises(RetryableProviderError):
                GeminiAnalysisProvider().analyze(self.transcript)

    def test_huggingface_returns_valid_result_using_configured_model_and_transcript(
        self,
    ):
        with (
            patch.dict(
                os.environ,
                {
                    "HF_TOKEN": "test-hf-token",
                    "HF_ANALYSIS_MODEL": "test-hf-model",
                },
            ),
            patch(
                "videos.services.analysis_providers.InferenceClient"
            ) as client_class,
        ):
            client = client_class.return_value
            client.chat_completion.return_value = SimpleNamespace(
                choices=[
                    SimpleNamespace(
                        message=SimpleNamespace(
                            content=json.dumps(self.output),
                        )
                    )
                ]
            )

            result = HuggingFaceAnalysisProvider().analyze(self.transcript)

        self.assertEqual(result, self.expected_result("test-hf-model"))
        client_class.assert_called_once_with(
            model="test-hf-model",
            token="test-hf-token",
        )
        request = client.chat_completion.call_args.kwargs
        self.assertEqual(
            request["messages"][0]["content"].count("A real transcript segment."),
            1,
        )
        self.assertIn("18.64", request["messages"][0]["content"])
        self.assertEqual(
            request["response_format"]["type"],
            "json_schema",
        )
        self.assertTrue(request["response_format"]["json_schema"]["strict"])

    def test_huggingface_missing_token_is_non_retryable(self):
        with patch.dict(os.environ, {"HF_TOKEN": ""}):
            with self.assertRaises(NonRetryableProviderError):
                HuggingFaceAnalysisProvider().analyze(self.transcript)

    def test_huggingface_api_failure_is_retryable(self):
        with (
            patch.dict(os.environ, {"HF_TOKEN": "test-hf-token"}),
            patch(
                "videos.services.analysis_providers.InferenceClient"
            ) as client_class,
        ):
            client_class.return_value.chat_completion.side_effect = (
                ConnectionError("private upstream details")
            )

            with self.assertRaises(RetryableProviderError) as error:
                HuggingFaceAnalysisProvider().analyze(self.transcript)

        self.assertNotIn("private upstream details", str(error.exception))

    def test_huggingface_malformed_response_is_retryable(self):
        with (
            patch.dict(os.environ, {"HF_TOKEN": "test-hf-token"}),
            patch(
                "videos.services.analysis_providers.InferenceClient"
            ) as client_class,
        ):
            client_class.return_value.chat_completion.return_value = (
                SimpleNamespace(
                    choices=[
                        SimpleNamespace(
                            message=SimpleNamespace(content="not JSON")
                        )
                    ]
                )
            )

            with self.assertRaises(RetryableProviderError):
                HuggingFaceAnalysisProvider().analyze(self.transcript)


class VideoAnalysisServiceTests(DjangoTestCase):
    def setUp(self):
        self.video = Video.objects.create(
            youtube_id="abcdefghijk",
            transcript_status=Video.TranscriptStatus.READY,
            transcript_language="en",
            transcript=[
                {
                    "text": "Python makes reliable testing easier.",
                    "start": 1.25,
                    "duration": 2.5,
                },
                {
                    "text": "Tests protect important behavior.",
                    "start": 3.75,
                    "duration": 2,
                },
            ],
        )
        self.provider = MockAnalysisProvider()

    def test_successful_analysis_persists_mock_result(self):
        provider = MagicMock(wraps=self.provider)
        analysis = analyze_video(self.video, provider)

        self.video.refresh_from_db()
        self.assertEqual(self.video.analysis_status, Video.AnalysisStatus.READY)
        provider.analyze.assert_called_once_with(
            {
                "language": "en",
                "segments": self.video.transcript,
            }
        )
        self.assertEqual(analysis.summary, (
            "Transcript summary: Python makes reliable testing easier. "
            "Tests protect important behavior."
        ))
        self.assertEqual(
            analysis.detailed_notes,
            {"transcript_segment_count": 2},
        )
        self.assertEqual(analysis.topics, ["python", "makes", "reliable"])
        self.assertEqual(
            analysis.key_points,
            [
                {
                    "text": "Python makes reliable testing easier.",
                    "start": 1.25,
                },
                {
                    "text": "Tests protect important behavior.",
                    "start": 3.75,
                },
            ],
        )
        self.assertEqual(
            analysis.questions,
            [
                "What is discussed here: Python makes reliable testing easier.?",
                "What is discussed here: Tests protect important behavior.?",
            ],
        )
        self.assertEqual(analysis.concepts, [])
        self.assertEqual(analysis.prerequisites, [])
        self.assertEqual(analysis.upcoming_topics, [])
        self.assertEqual(analysis.claims, [])
        self.assertEqual(analysis.model, "mock")
        self.assertEqual(analysis.analysis_version, 1)

    def test_reanalysis_updates_existing_analysis(self):
        existing = analyze_video(self.video, self.provider)

        class UpdatedProvider:
            def analyze(self, transcript):
                result = MockAnalysisProvider().analyze(transcript)
                result.summary = "Updated deterministic summary."
                return result

        updated = analyze_video(self.video, UpdatedProvider())

        self.assertEqual(VideoAnalysis.objects.filter(video=self.video).count(), 1)
        self.assertEqual(updated.pk, existing.pk)
        self.assertEqual(updated.summary, "Updated deterministic summary.")

    def test_gemini_failure_huggingface_fallback_persists_analysis(self):
        existing = analyze_video(self.video, self.provider)
        original_id = existing.pk
        fallback_result = AnalysisResult(
            summary="Persisted from Hugging Face fallback.",
            detailed_notes={"sections": [{"heading": "Fallback", "content": "Notes."}]},
            topics=["fallback-topic"],
            concepts=["fallback-concept"],
            prerequisites=["fallback-prerequisite"],
            upcoming_topics=["fallback-upcoming"],
            key_points=[{"text": "Fallback key point.", "start": 1.25}],
            claims=[{"text": "Fallback claim.", "start": 1.25}],
            questions=["Fallback question?"],
            model="Qwen/Qwen3-32B",
            analysis_version=1,
        )
        gemini = GeminiAnalysisProvider()
        huggingface = HuggingFaceAnalysisProvider()

        with (
            patch.object(
                gemini,
                "analyze",
                side_effect=RetryableProviderError(
                    "private simulated Gemini exception"
                ),
            ) as gemini_analyze,
            patch.object(
                huggingface,
                "analyze",
                return_value=fallback_result,
            ) as huggingface_analyze,
        ):
            manager = AnalysisProviderManager([gemini, huggingface])
            analysis = analyze_video(self.video, manager)

        transcript = {
            "language": "en",
            "segments": self.video.transcript,
        }
        gemini_analyze.assert_called_once_with(transcript)
        huggingface_analyze.assert_called_once_with(transcript)
        self.assertEqual(analysis.pk, original_id)
        self.assertEqual(VideoAnalysis.objects.filter(video=self.video).count(), 1)
        self.assertEqual(analysis.summary, fallback_result.summary)
        self.assertEqual(analysis.detailed_notes, fallback_result.detailed_notes)
        self.assertEqual(analysis.topics, fallback_result.topics)
        self.assertEqual(analysis.concepts, fallback_result.concepts)
        self.assertEqual(analysis.prerequisites, fallback_result.prerequisites)
        self.assertEqual(analysis.upcoming_topics, fallback_result.upcoming_topics)
        self.assertEqual(analysis.key_points, fallback_result.key_points)
        self.assertEqual(analysis.claims, fallback_result.claims)
        self.assertEqual(analysis.questions, fallback_result.questions)
        self.assertEqual(analysis.model, "Qwen/Qwen3-32B")
        self.video.refresh_from_db()
        self.assertEqual(self.video.analysis_status, Video.AnalysisStatus.READY)

    def test_all_manager_providers_failing_preserves_existing_analysis(self):
        existing = analyze_video(self.video, self.provider)
        old_values = {
            "summary": existing.summary,
            "detailed_notes": existing.detailed_notes,
            "topics": existing.topics,
            "concepts": existing.concepts,
            "prerequisites": existing.prerequisites,
            "upcoming_topics": existing.upcoming_topics,
            "key_points": existing.key_points,
            "claims": existing.claims,
            "questions": existing.questions,
            "model": existing.model,
            "analysis_version": existing.analysis_version,
        }
        gemini = GeminiAnalysisProvider()
        huggingface = HuggingFaceAnalysisProvider()

        with (
            patch.object(
                gemini,
                "analyze",
                side_effect=RetryableProviderError(
                    "private simulated Gemini exception"
                ),
            ),
            patch.object(
                huggingface,
                "analyze",
                side_effect=RetryableProviderError(
                    "private simulated Hugging Face exception"
                ),
            ),
        ):
            manager = AnalysisProviderManager([gemini, huggingface])
            with self.assertRaises(AnalysisError) as error:
                analyze_video(self.video, manager)

        self.assertEqual(str(error.exception), "Video analysis failed.")
        self.assertNotIn("private simulated", str(error.exception))
        existing.refresh_from_db()
        self.video.refresh_from_db()
        self.assertEqual(
            VideoAnalysis.objects.filter(video=self.video).count(),
            1,
        )
        for field, value in old_values.items():
            self.assertEqual(getattr(existing, field), value)
        self.assertEqual(self.video.analysis_status, Video.AnalysisStatus.FAILED)

    def test_missing_transcript_is_rejected_and_status_is_not_ready(self):
        self.video.transcript = None
        self.video.save(update_fields=["transcript"])

        with self.assertRaises(TranscriptUnavailableForAnalysisError):
            analyze_video(self.video, self.provider)

        self.video.refresh_from_db()
        self.assertEqual(self.video.analysis_status, Video.AnalysisStatus.FAILED)
        self.assertFalse(VideoAnalysis.objects.filter(video=self.video).exists())

    def test_non_ready_transcript_is_not_sent_to_provider(self):
        self.video.transcript_status = Video.TranscriptStatus.FETCHING
        self.video.save(update_fields=["transcript_status"])
        provider = MagicMock()

        with self.assertRaises(TranscriptNotReadyError):
            analyze_video(self.video, provider)

        provider.analyze.assert_not_called()
        self.video.refresh_from_db()
        self.assertEqual(self.video.analysis_status, Video.AnalysisStatus.FAILED)
        self.assertFalse(VideoAnalysis.objects.filter(video=self.video).exists())

    def test_provider_failure_preserves_existing_analysis(self):
        existing = analyze_video(self.video, self.provider)
        old_summary = existing.summary

        class FailingProvider:
            def analyze(self, transcript):
                raise RuntimeError("internal provider detail")

        with self.assertRaises(AnalysisError) as error:
            analyze_video(self.video, FailingProvider())

        self.assertNotIn("internal provider detail", str(error.exception))
        self.video.refresh_from_db()
        existing.refresh_from_db()
        self.assertEqual(self.video.analysis_status, Video.AnalysisStatus.FAILED)
        self.assertEqual(existing.summary, old_summary)

    def test_invalid_provider_result_preserves_existing_analysis(self):
        existing = analyze_video(self.video, self.provider)
        old_summary = existing.summary

        class InvalidProvider:
            def analyze(self, transcript):
                return AnalysisResult(
                    summary="invalid",
                    detailed_notes=[],
                    topics=[],
                    concepts=[],
                    prerequisites=[],
                    upcoming_topics=[],
                    key_points=[],
                    claims=[],
                    questions=[],
                    model="invalid",
                    analysis_version=1,
                )

        with self.assertRaises(InvalidAnalysisResultError):
            analyze_video(self.video, InvalidProvider())

        self.video.refresh_from_db()
        existing.refresh_from_db()
        self.assertEqual(self.video.analysis_status, Video.AnalysisStatus.FAILED)
        self.assertEqual(existing.summary, old_summary)
