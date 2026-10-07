from django.urls import path

from knowledge.views import (
    ConversationAskView,
    ConversationDetailView,
    ConversationListCreateView,
    KnowledgeAskView,
    PreviousContextJobCreateView,
    PreviousContextJobStatusView,
    PreviousContextView,
)


urlpatterns = [
    path("ask/", KnowledgeAskView.as_view(), name="knowledge-ask"),
    path(
        "conversations/",
        ConversationListCreateView.as_view(),
        name="knowledge-conversation-list-create",
    ),
    path(
        "conversations/<int:conversation_id>/",
        ConversationDetailView.as_view(),
        name="knowledge-conversation-detail",
    ),
    path(
        "conversations/<int:conversation_id>/ask/",
        ConversationAskView.as_view(),
        name="knowledge-conversation-ask",
    ),
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
