from django.urls import path

from .views import PlaylistDetailView, PlaylistListCreateView, PlaylistVideoListCreateView

urlpatterns = [
    path("", PlaylistListCreateView.as_view(), name="playlist-list-create"),
    path("<int:pk>/", PlaylistDetailView.as_view(), name="playlist-detail"),
    path(
        "<int:pk>/videos/",
        PlaylistVideoListCreateView.as_view(),
        name="playlist-video-add",
    ),
    path(
        "<int:pk>/videos/<str:youtube_id>/",
        PlaylistVideoListCreateView.as_view(),
        name="playlist-video-remove",
    ),
]
