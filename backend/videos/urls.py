from django.urls import path

from .views import (
    TranscriptView,
    VideoAnalysisView,
    VideoContextView,
    VideoDetailView,
    VideoLibraryView,
)


urlpatterns = [
    path("", VideoLibraryView.as_view(), name="video-library"),
    path(
        "<str:youtube_id>/details/",
        VideoDetailView.as_view(),
        name="video-detail",
    ),
    path(
        "<str:youtube_id>/transcript/",
        TranscriptView.as_view(),
        name="video-transcript",
    ),
    path(
        "<str:youtube_id>/analyze/",
        VideoAnalysisView.as_view(),
        name="video-analyze",
    ),
    path(
        "<str:youtube_id>/",
        VideoContextView.as_view(),
        name="video-context",
    ),
]