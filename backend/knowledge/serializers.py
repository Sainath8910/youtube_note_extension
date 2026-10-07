from rest_framework import serializers

from knowledge.services.retrieval import RetrievalScope


class RAGQuestionSerializer(serializers.Serializer):
    question = serializers.CharField(
        required=True,
        allow_blank=False,
        trim_whitespace=True,
    )
    scope = serializers.ChoiceField(
        choices=[(scope.name, scope.name) for scope in RetrievalScope],
        required=True,
    )
    youtube_id = serializers.RegexField(
        regex=r"^[A-Za-z0-9_-]{11}$",
        required=False,
        allow_null=True,
    )
    folder_id = serializers.IntegerField(
        required=False,
        allow_null=True,
        min_value=1,
    )
    top_k = serializers.IntegerField(
        required=False,
        default=5,
        min_value=1,
    )

    def validate(self, attrs):
        scope = RetrievalScope[attrs["scope"]]
        youtube_id = attrs.get("youtube_id")
        folder_id = attrs.get("folder_id")

        if (
            scope in (RetrievalScope.CURRENT_VIDEO, RetrievalScope.COMBINED)
            and youtube_id is None
        ):
            raise serializers.ValidationError({
                "youtube_id": (
                    f"This field is required for {scope.name}."
                )
            })
        if (
            scope is RetrievalScope.CURRENT_FOLDER
            and folder_id is None
        ):
            raise serializers.ValidationError({
                "folder_id": "This field is required for CURRENT_FOLDER."
            })
        if (
            scope in (RetrievalScope.PERSONAL_KB, RetrievalScope.CURRENT_FOLDER)
            and youtube_id is not None
        ):
            raise serializers.ValidationError({
                "youtube_id": (
                    f"This field is not valid for {scope.name}."
                )
            })
        if (
            scope in (RetrievalScope.PERSONAL_KB, RetrievalScope.CURRENT_VIDEO)
            and folder_id is not None
        ):
            raise serializers.ValidationError({
                "folder_id": f"This field is not valid for {scope.name}."
            })
        return attrs


class RAGContextItemSerializer(serializers.Serializer):
    chunk_id = serializers.IntegerField()
    content = serializers.CharField()
    distance = serializers.FloatField()
    note_id = serializers.IntegerField(allow_null=True)
    video_id = serializers.IntegerField(allow_null=True)
    folder_id = serializers.IntegerField(allow_null=True)
    source_block_id = serializers.CharField(allow_null=True)
    chunk_index = serializers.IntegerField()
    metadata = serializers.JSONField()


class RAGAnswerSerializer(serializers.Serializer):
    answer = serializers.CharField()
    sources = RAGContextItemSerializer(many=True)


class PreviousContextQuerySerializer(serializers.Serializer):
    youtube_id = serializers.RegexField(
        regex=r"^[A-Za-z0-9_-]{11}$",
        required=True,
    )


class ExactVideoContextSerializer(serializers.Serializer):
    note_id = serializers.IntegerField()
    title = serializers.CharField()
    content = serializers.CharField()
    video_id = serializers.IntegerField()
    youtube_id = serializers.CharField()
    folder_id = serializers.IntegerField(allow_null=True)
    note_type = serializers.CharField()
    created_at = serializers.DateTimeField()
    updated_at = serializers.DateTimeField()
    source = serializers.CharField()


class RelatedPersonalContextSerializer(serializers.Serializer):
    chunk_id = serializers.IntegerField()
    note_id = serializers.IntegerField()
    title = serializers.CharField()
    content = serializers.CharField()
    video_id = serializers.IntegerField(allow_null=True)
    folder_id = serializers.IntegerField(allow_null=True)
    distance = serializers.FloatField()
    source = serializers.CharField()


class PreviousContextVideoSerializer(serializers.Serializer):
    id = serializers.IntegerField(source="video_id")
    youtube_id = serializers.CharField()


class PreviousContextConceptTimestampSerializer(serializers.Serializer):
    seconds = serializers.FloatField(min_value=0)
    text = serializers.CharField()


class PreviousContextConceptSerializer(serializers.Serializer):
    name = serializers.CharField()
    type = serializers.ChoiceField(choices=("PREREQUISITE", "UPCOMING"))
    has_previous_knowledge = serializers.BooleanField()
    related_count = serializers.IntegerField(min_value=0)
    reason = serializers.CharField(allow_null=True)
    evidence = serializers.CharField(allow_null=True)
    timestamps = PreviousContextConceptTimestampSerializer(many=True)
    personal_notes = RelatedPersonalContextSerializer(many=True)


class PreviousContextConceptsSerializer(serializers.Serializer):
    prerequisites = PreviousContextConceptSerializer(many=True)
    upcoming = PreviousContextConceptSerializer(many=True)


class PreviousContextSerializer(serializers.Serializer):
    video = PreviousContextVideoSerializer(source="*")
    exact = ExactVideoContextSerializer(many=True)
    related = RelatedPersonalContextSerializer(many=True)
    concepts = PreviousContextConceptsSerializer()
