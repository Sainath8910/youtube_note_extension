from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("users", "0002_user_supabase_uid"),
    ]

    operations = [
        migrations.AddField(
            model_name="user",
            name="public_username",
            field=models.CharField(
                blank=True,
                max_length=30,
                null=True,
                unique=True,
            ),
        ),
    ]
