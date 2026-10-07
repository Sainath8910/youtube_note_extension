from rest_framework import generics, status
from rest_framework.exceptions import NotFound, ValidationError
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from notes.models import Note
from notes.serializers import NoteSerializer

from .models import Folder
from .serializers import FolderDetailSerializer, FolderSerializer


class FolderListCreateView(generics.ListCreateAPIView):
    serializer_class = FolderSerializer
    permission_classes = [IsAuthenticated]

    def get_queryset(self):
        folders = Folder.objects.filter(user=self.request.user)
        if "parent" not in self.request.query_params:
            return folders.order_by("name", "id")

        parent_id = self.request.query_params["parent"]
        if parent_id == "null":
            return folders.filter(parent__isnull=True).order_by("name", "id")

        try:
            parent_id = int(parent_id)
        except (TypeError, ValueError):
            raise ValidationError(
                {"parent": "Use 'null' or a valid folder ID."}
            ) from None
        if parent_id < 1:
            raise ValidationError(
                {"parent": "Use 'null' or a valid folder ID."}
            )
        if not folders.filter(pk=parent_id).exists():
            raise NotFound("Parent folder not found.")
        return folders.filter(parent_id=parent_id).order_by("name", "id")

    def perform_create(self, serializer):
        serializer.save(user=self.request.user)


class FolderSearchView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        query = request.query_params.get("q", "").strip()
        if not query:
            return Response({"results": []})

        matching_folders = Folder.objects.filter(
            user=request.user,
            name__icontains=query,
        )
        folders = {
            folder["id"]: folder
            for folder in Folder.objects.filter(
                user=request.user,
            ).values("id", "name", "parent_id")
        }
        path_cache = {}

        def folder_path(folder_id):
            if folder_id in path_cache:
                return path_cache[folder_id]

            chain = []
            visited = set()
            current_id = folder_id
            while current_id not in path_cache:
                if current_id in visited:
                    return []
                visited.add(current_id)
                folder = folders.get(current_id)
                if folder is None:
                    break
                chain.append(folder)
                if folder["parent_id"] is None:
                    break
                current_id = folder["parent_id"]

            path = list(path_cache.get(current_id, []))
            for folder in reversed(chain):
                path = [
                    *path,
                    {"id": folder["id"], "name": folder["name"]},
                ]
                path_cache[folder["id"]] = path
            return path_cache.get(folder_id, [])

        results = [
            {
                "id": folder_id,
                "name": folders[folder_id]["name"],
                "path": folder_path(folder_id),
            }
            for folder_id in sorted(
                (folder.pk for folder in matching_folders),
                key=lambda folder_id: (
                    folders[folder_id]["name"].casefold(),
                    folders[folder_id]["name"],
                    folder_id,
                ),
            )
        ]
        return Response({"results": results})


class FolderDetailView(generics.RetrieveAPIView):
    serializer_class = FolderDetailSerializer
    permission_classes = [IsAuthenticated]

    def get_queryset(self):
        return Folder.objects.filter(user=self.request.user)

    def patch(self, request, *args, **kwargs):
        folder = self.get_object()
        serializer = self.get_serializer(
            folder,
            data=request.data,
            partial=True,
        )
        serializer.is_valid(raise_exception=True)
        serializer.save()
        return Response(serializer.data, status=status.HTTP_200_OK)

    def delete(self, request, *args, **kwargs):
        folder = self.get_object()
        if folder.children.exists():
            raise ValidationError(
                {"detail": "Cannot delete a folder that contains subfolders."}
            )
        folder.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


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
