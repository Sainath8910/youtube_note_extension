from django.urls import path

from .views import (
    BridgeConfirmView,
    BridgeConflictsView,
    BridgeConflictResolveView,
    BridgeHistoryView,
    BridgeIdentityCandidatesView,
    BridgeIndexingJobsView,
    BridgePreviewView,
    BridgeReconcileView,
    BridgeRetryAcknowledgmentsView,
    BridgeStatusView,
)

urlpatterns = [
    path("status/", BridgeStatusView.as_view(), name="notes-bridge-status"),
    path("preview/", BridgePreviewView.as_view(), name="notes-bridge-preview"),
    path("identities/", BridgeIdentityCandidatesView.as_view(), name="notes-bridge-identities"),
    path("runs/<uuid:run_id>/confirm/", BridgeConfirmView.as_view(), name="notes-bridge-confirm"),
    path("runs/<uuid:run_id>/retry-acknowledgments/", BridgeRetryAcknowledgmentsView.as_view(), name="notes-bridge-retry-acknowledgments"),
    path("history/", BridgeHistoryView.as_view(), name="notes-bridge-history"),
    path("indexing/", BridgeIndexingJobsView.as_view(), name="notes-bridge-indexing"),
    path("conflicts/", BridgeConflictsView.as_view(), name="notes-bridge-conflicts"),
    path("conflicts/<int:conflict_id>/resolve/", BridgeConflictResolveView.as_view(), name="notes-bridge-conflict-resolve"),
    path("reconcile/", BridgeReconcileView.as_view(), name="notes-bridge-reconcile"),
]
