from django.contrib import admin
from django.contrib.auth.admin import UserAdmin

from .models import User


@admin.register(User)
class CustomUserAdmin(UserAdmin):
    list_display = ("username", "email", "first_name", "last_name", "is_staff", "is_active", "date_joined")
    search_fields = ("username", "first_name", "last_name", "email")
    list_filter = ("is_staff", "is_active", "is_superuser")
    ordering = ("-date_joined",)
