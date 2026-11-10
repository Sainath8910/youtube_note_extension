from videos.pagination import VideoLibraryPagination


class PlaylistLibraryPagination(VideoLibraryPagination):
    page_size = 10
    max_page_size = 50
