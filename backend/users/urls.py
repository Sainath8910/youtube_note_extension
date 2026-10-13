from django.urls import path

from .views import CurrentUserView, ProfileView


urlpatterns = [
    path("me/", CurrentUserView.as_view(), name="current-user"),
    path("profile/", ProfileView.as_view(), name="user-profile"),
]
