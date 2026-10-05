from django.urls import path

from knowledge.views import KnowledgeAskView


urlpatterns = [
    path("ask/", KnowledgeAskView.as_view(), name="knowledge-ask"),
]
