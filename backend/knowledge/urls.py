from django.urls import path

from knowledge.views import (
    KnowledgeAskView,
    PreviousContextJobCreateView,
    PreviousContextJobStatusView,
    PreviousContextView,
)


urlpatterns = [
    path("ask/", KnowledgeAskView.as_view(), name="knowledge-ask"),
    path(
        "previous-context/",
        PreviousContextView.as_view(),
        name="knowledge-previous-context",
    ),
    path(
        "previous-context/jobs/",
        PreviousContextJobCreateView.as_view(),
        name="knowledge-previous-context-job-create",
    ),
    path(
        "previous-context/jobs/<uuid:job_id>/",
        PreviousContextJobStatusView.as_view(),
        name="knowledge-previous-context-job-status",
    ),
]
