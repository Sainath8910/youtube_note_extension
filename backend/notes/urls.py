from django.urls import path

from .views import (
    NoteDetailView,
    NoteListCreateView,
    VideoNoteCreateView,
)


urlpatterns = [
    path(
        "",
        NoteListCreateView.as_view(),
        name="note-list-create",
    ),
    path(
        "video/",
        VideoNoteCreateView.as_view(),
        name="video-note-create",
    ),
    path(
        "<int:pk>/",
        NoteDetailView.as_view(),
        name="note-detail",
    ),
]