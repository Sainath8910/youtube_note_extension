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
    youtube_id = serializers.CharField(
        required=False,
        allow_null=True,
        allow_blank=False,
        max_length=20,
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
        if scope is RetrievalScope.CURRENT_VIDEO and not attrs.get("youtube_id"):
            raise serializers.ValidationError({
                "youtube_id": "This field is required for CURRENT_VIDEO."
            })
        if scope is RetrievalScope.CURRENT_FOLDER and attrs.get("folder_id") is None:
            raise serializers.ValidationError({
                "folder_id": "This field is required for CURRENT_FOLDER."
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
