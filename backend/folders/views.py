from rest_framework import generics
from rest_framework.permissions import IsAuthenticated

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
