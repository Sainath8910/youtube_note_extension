from django.test import SimpleTestCase

from knowledge.services.embedding_validation import (
    QUERY_INSTRUCTION,
    format_query,
    validate_texts,
)


class EmbeddingValidationInputTests(SimpleTestCase):
    def test_rejects_empty_batches(self):
        with self.assertRaisesRegex(ValueError, "at least one"):
            validate_texts([], kind="Document")

    def test_rejects_whitespace_only_text(self):
        with self.assertRaisesRegex(ValueError, "must not be blank"):
            validate_texts(["   \n"], kind="Query")

    def test_formats_qwen_instruction_aware_query(self):
        self.assertEqual(
            format_query("How does binary search work?"),
            (
                f"Instruct: {QUERY_INSTRUCTION}\n"
                "Query:How does binary search work?"
            ),
        )
