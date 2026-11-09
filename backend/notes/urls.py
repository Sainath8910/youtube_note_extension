from django.urls import path

from .views import (
    NoteAssistanceView,
    NoteDetailView,
    NoteListCreateView,
    TrashListView,
    TrashRestoreView,
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
    path("trash/", TrashListView.as_view(), name="trash-list"),
    path(
        "trash/<str:entity>/<int:pk>/restore/",
        TrashRestoreView.as_view(),
        name="trash-restore",
    ),
    path(
        "<int:pk>/assistance/",
        NoteAssistanceView.as_view(),
        name="note-assistance",
    ),
    path(
        "<int:pk>/",
        NoteDetailView.as_view(),
        name="note-detail",
    ),
]