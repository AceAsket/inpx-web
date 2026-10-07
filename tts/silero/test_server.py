import unittest
from server import normalize_numbers, split_text


class TextPreparationTests(unittest.TestCase):
    def test_numbers_and_chapter_separators(self):
        self.assertEqual(normalize_numbers("Глава 123"), "Глава сто двадцать три")
        self.assertEqual(list(split_text("***\n\n123\n\n—\n\nТекст книги.")),
                         ["сто двадцать три", "Текст книги."])

    def test_unsupported_foreign_paragraphs(self):
        self.assertEqual(list(split_text("Hello\n\nРусский текст.")), ["Русский текст."])
        self.assertEqual(list(split_text("Ёё")), ["Ёё"])

    def test_long_paragraphs_preserve_text_and_bound_calls(self):
        text = "Первое предложение. Второе предложение! " * 50
        chunks = list(split_text(text))
        self.assertGreater(len(chunks), 1)
        self.assertTrue(all(0 < len(chunk) <= 700 for chunk in chunks))
        self.assertEqual(" ".join(chunks), text.strip())

    def test_long_numeric_identifiers_do_not_overflow(self):
        text = "1" * 100
        chunks = list(split_text(text))
        self.assertEqual(" ".join(chunks), " ".join(["один"] * 100))


if __name__ == "__main__":
    unittest.main()
