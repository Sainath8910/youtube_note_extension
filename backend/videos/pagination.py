from rest_framework.exceptions import ValidationError
from rest_framework.pagination import PageNumberPagination


class VideoLibraryPagination(PageNumberPagination):
    """Return the standard count/next/previous/results page response."""

    page_size = 10
    page_size_query_param = "page_size"
    max_page_size = 50

    def paginate_queryset(self, queryset, request, view=None):
        for parameter in (self.page_query_param, self.page_size_query_param):
            value = request.query_params.get(parameter)
            if value is None:
                continue
            try:
                parsed_value = int(value)
            except (TypeError, ValueError):
                raise ValidationError(
                    {parameter: "A positive integer is required."},
                ) from None
            if parsed_value < 1:
                raise ValidationError(
                    {parameter: "A positive integer is required."},
                )
        return super().paginate_queryset(queryset, request, view)
