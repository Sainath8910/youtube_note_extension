from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("users", "0003_user_public_username"),
    ]

    operations = [
        migrations.AlterField(
            model_name="user",
            name="public_username",
            field=models.CharField(
                blank=True,
                max_length=30,
                null=True,
            ),
        ),
        migrations.AddConstraint(
            model_name="user",
            constraint=models.UniqueConstraint(
                models.functions.Lower("public_username"),
                name="users_public_username_ci_unique",
            ),
        ),
    ]
