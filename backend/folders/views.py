from rest_framework import generics
from rest_framework.exceptions import NotFound
from rest_framework.permissions import IsAuthenticated

from notes.models import Note
from notes.serializers import NoteSerializer

from .models import Folder
from .serializers import FolderSerializer


class FolderListCreateView(generics.ListCreateAPIView):
    serializer_class = FolderSerializer
    permission_classes = [IsAuthenticated]

    def get_queryset(self):
        return Folder.objects.filter(user=self.request.user).order_by(
            "name",
            "id",
        )

    def perform_create(self, serializer):
        serializer.save(user=self.request.user, parent=None)


class FolderDetailView(generics.RetrieveAPIView):
    serializer_class = FolderSerializer
    permission_classes = [IsAuthenticated]

    def get_queryset(self):
        return Folder.objects.filter(user=self.request.user)


class FolderNotesListView(generics.ListAPIView):
    serializer_class = NoteSerializer
    permission_classes = [IsAuthenticated]

    def get_queryset(self):
        folder_id = self.kwargs["pk"]
        if not Folder.objects.filter(
            pk=folder_id,
            user=self.request.user,
        ).exists():
            raise NotFound("Folder not found.")

        return Note.objects.filter(
            folder_id=folder_id,
            user=self.request.user,
        ).select_related(
            "video",
            "folder",
        ).order_by(
            "-updated_at",
            "-id",
        )
