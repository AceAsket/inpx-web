import unittest
import json
import threading
import urllib.request
import urllib.error
from http.server import ThreadingHTTPServer
import server
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

    def test_progress_history_is_bounded_and_does_not_retain_text(self):
        original = server.JOBS
        server.JOBS = {}
        try:
            for index in range(140):
                server.update_job(f"{index:064x}", state="ready", progress=1, remainingSeconds=0)
            self.assertEqual(len(server.JOBS), 128)
            self.assertTrue(all(set(job) == {"state", "progress", "remainingSeconds"} for job in server.JOBS.values()))
        finally:
            server.JOBS = original

    def test_estimate_and_progress_endpoints_require_service_key(self):
        original = server.API_KEY
        server.API_KEY = "test-only-key"
        http = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        thread = threading.Thread(target=http.serve_forever, daemon=True)
        thread.start()
        base = f"http://127.0.0.1:{http.server_address[1]}"
        request_id = "a" * 64
        server.update_job(request_id, state="generating", progress=0.5, remainingSeconds=12)
        try:
            with self.assertRaises(urllib.error.HTTPError) as error:
                urllib.request.urlopen(base + "/estimate")
            self.assertEqual(error.exception.code, 401)
            headers = {"Authorization": "Bearer test-only-key"}
            with urllib.request.urlopen(urllib.request.Request(base + "/estimate", headers=headers)) as response:
                estimate = json.load(response)
            self.assertGreater(estimate["charactersPerSecond"], 0)
            with urllib.request.urlopen(urllib.request.Request(base + "/jobs/" + request_id, headers=headers)) as response:
                status = json.load(response)
            self.assertEqual(status["progress"], 0.5)
            self.assertEqual(status["remainingSeconds"], 12)
        finally:
            http.shutdown()
            http.server_close()
            thread.join(timeout=2)
            server.API_KEY = original
            server.JOBS.pop(request_id, None)


if __name__ == "__main__":
    unittest.main()
