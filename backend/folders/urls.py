from django.urls import path

from .views import (
    FolderDetailView,
    FolderListCreateView,
    FolderNotesListView,
    FolderSearchView,
)


urlpatterns = [
    path("", FolderListCreateView.as_view(), name="folder-list-create"),
    path("search/", FolderSearchView.as_view(), name="folder-search"),
    path(
        "<int:pk>/notes/",
        FolderNotesListView.as_view(),
        name="folder-notes-list",
    ),
    path(
        "<int:pk>/",
        FolderDetailView.as_view(),
        name="folder-detail",
    ),
]
