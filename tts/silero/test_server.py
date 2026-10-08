import unittest
import json
import threading
import urllib.request
import urllib.error
import xml.etree.ElementTree as ET
import os
import subprocess
import sys
import tempfile
from unittest.mock import patch
from http.server import ThreadingHTTPServer
import server
from server import normalize_numbers, split_text
from speech_options import normalize_options, dictionary_replacer, tuned_chunks, validate_segments, trailing_pause
from accentuation import StressProcessor, context_blocks


class TextPreparationTests(unittest.TestCase):
    def test_stress_is_default_and_can_be_disabled_at_startup(self):
        for flag, expected in ((None, "True"), ("false", "False"), ("TRUE", "True")):
            env = dict(os.environ)
            env.pop("SILERO_STRESS_ENABLED", None)
            if flag is not None:
                env["SILERO_STRESS_ENABLED"] = flag
            result = subprocess.check_output([sys.executable, "-c", "import server; print(server.STRESS.enabled, server.STRESS.model is None)"], env=env, text=True)
            self.assertEqual(result.strip(), expected + " True", "Disabled/default imports must not load a stress model")

    def test_stress_is_lazy_restores_threads_and_precedes_ssml(self):
        calls = []
        class Accentor:
            def to(self, **kwargs):
                calls.append(kwargs)
            def __call__(self, text, **kwargs):
                calls.append(text)
                self_assert.assertNotIn("<speak>", text)
                self_assert.assertIn("Герми+она", text)
                return text.replace("замок", "з+амок")
        self_assert = self
        original_threads = server.torch.get_num_threads()
        def loader():
            server.torch.set_num_threads(1)
            calls.append("load")
            return Accentor()
        try:
            server.torch.set_num_threads(3)
            disabled = StressProcessor(False, loader)
            self.assertEqual(disabled("текст"), "текст")
            self.assertEqual(calls, [])
            self.assertEqual(disabled.cache_identity, "")
            enabled = StressProcessor(True, loader)
            options = normalize_options(dict(dictionary="Гермиона = Герми+она", pitch="low"))
            chunks = list(tuned_chunks([dict(text="Гермиона увидела замок.")], options, normalize_numbers, accentuate=enabled))
            self.assertEqual(server.torch.get_num_threads(), 3)
            self.assertIn("Герми+она", chunks[0][0])
            self.assertIn("з+амок", chunks[0][0])
            enabled("Герми+она закрыла книгу.")
            self.assertEqual(calls.count("load"), 1)
        finally:
            server.torch.set_num_threads(original_threads)

    def test_stress_context_calls_are_bounded_and_preserve_text(self):
        text = "Первое предложение. Следующее предложение! " * 200
        blocks = list(context_blocks(text))
        self.assertGreater(len(blocks), 1)
        self.assertTrue(all(len(block) <= 1500 for block in blocks))
        self.assertEqual(" ".join(blocks), text.strip())
        blocks = list(context_blocks("я" * 1499 + "+а"))
        self.assertTrue(all(not block.endswith("+") for block in blocks))

    def test_external_stress_disables_all_builtin_accentuation_flags(self):
        original = (server.MODEL, server.STRESS, server.SPEED, server.SPEED_MEASURED)
        calls = []
        class Tts:
            def apply_tts(self, **kwargs):
                calls.append(kwargs)
                return server.torch.zeros(10)
        class Accentor:
            def to(self, **kwargs):
                pass
            def __call__(self, text, **kwargs):
                return text.replace("замок", "з+амок")
        try:
            server.MODEL = Tts()
            server.STRESS = StressProcessor(True, lambda: Accentor())
            with tempfile.TemporaryDirectory() as directory, patch("server.subprocess.Popen") as encoder:
                encoder.return_value.wait.return_value = 0
                encoder.return_value.poll.return_value = 0
                options = normalize_options(dict(dictionary="Гермиона = Герми+она", chapterPauseMs=1000))
                server.synthesize("Гермиона увидела замок.", "xenia", directory, options=options,
                                  segments=[dict(text="Гермиона увидела замок.", chapterEnd=True)])
                self.assertIn("Герми+она", calls[0]["ssml_text"])
                self.assertIn("з+амок", calls[0]["ssml_text"])
                for key in ("put_accent", "put_yo", "put_stress_homo", "put_yo_homo", "stress_single_vowel"):
                    self.assertIs(calls[0][key], False)
                encoder.return_value.stdin.write.assert_any_call(bytes(server.SAMPLE_RATE * 2))
        finally:
            server.MODEL, server.STRESS, server.SPEED, server.SPEED_MEASURED = original

    def test_speech_controls_and_dictionary_are_bounded(self):
        for value in ([], {"pitch": "loud"}, {"sentencePauseMs": True}, {"chapterPauseMs": 10001},
                      {"paragraphPauseMs": -1}, {"dictionary": "Имя = <break/>"}, {"dictionary": "Имя = +слово"},
                      {"dictionary": "Имя = имя\nимя = имя"}):
            with self.assertRaises(ValueError):
                normalize_options(value)
        replace = dictionary_replacer("Гермиона = Герми+она\nНью Йорк = Нью-Й+орк")
        self.assertEqual(replace("ГЕРМИОНА, Гермиона! Гермионы. Нью Йорк."), "Герми+она, Герми+она! Гермионы. Нью-Й+орк.")
        with self.assertRaises(ValueError):
            dictionary_replacer("а = " + "я" * 200)("а " * 20000)

    def test_ssml_escapes_book_text_and_preserves_controls(self):
        options = normalize_options(dict(pitch="low", sentencePauseMs=300, paragraphPauseMs=1000,
                                        chapterPauseMs=2000, dictionary="Гермиона = Герми+она"))
        segments = [dict(text='Гермиона сказала: <голос> & текст. Второе предложение!\n\nСледующий абзац.', chapterEnd=True)]
        chunks = list(tuned_chunks(segments, options, normalize_numbers))
        roots = [ET.fromstring(ssml) for ssml, _ in chunks]
        text = " ".join("".join(root.itertext()) for root in roots)
        self.assertIn("Герми+она сказала: <голос> & текст.", text)
        self.assertTrue(all(root.find("prosody").get("pitch") == "low" for root in roots))
        self.assertEqual([node.get("time") for root in roots for node in root.iter("break")], ["300ms", "1000ms", "2000ms"])
        self.assertNotIn("rate=", "".join(ssml for ssml, _ in chunks), "Speed remains a player setting")
        self.assertEqual([trailing_pause(ssml)[1] for ssml, _ in chunks], [1000, 2000])
        self.assertNotIn('time="2000ms"', trailing_pause(chunks[-1][0])[0], 'Trailing pauses must be encoded as actual silence')

    def test_long_ssml_is_split_before_markup_and_chapter_pause_only_at_boundary(self):
        options = normalize_options(dict(chapterPauseMs=5000))
        segments = [dict(text="Длинное предложение без точки " * 100, chapterEnd=False),
                    dict(text="Конец главы.", chapterEnd=True)]
        chunks = list(tuned_chunks(segments, options, normalize_numbers))
        self.assertGreater(len(chunks), 2)
        self.assertTrue(all(count <= 700 for _, count in chunks))
        self.assertEqual("".join(ssml for ssml, _ in chunks).count('time="5000ms"'), 1)
        for ssml, _ in chunks:
            ET.fromstring(ssml)
        with self.assertRaises(ValueError):
            validate_segments([dict(text="текст", chapterEnd="yes")], "текст")

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
