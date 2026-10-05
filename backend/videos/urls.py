from django.urls import path

from .views import VideoContextView


urlpatterns = [
    path(
        "<str:youtube_id>/",
        VideoContextView.as_view(),
        name="video-context",
    ),
]