from django.urls import path

from .views import FolderListCreateView


urlpatterns = [
    path("", FolderListCreateView.as_view(), name="folder-list-create"),
]
