"""Optional CPU Silero service. No book text or generated audio is retained."""
import hmac
import json
import logging
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from speech_options import normalize_options, validate_segments, tuned_chunks, trailing_pause
from accentuation import StressProcessor, STRESS_VERSION

import torch
from num2words import num2words

MODEL_ID = os.environ.get("SILERO_MODEL", "v5_5_ru")
SPEAKERS = ("aidar", "baya", "kseniya", "xenia", "eugene")
SAMPLE_RATE = 24000
MAX_REQUEST = 16 * 1024 * 1024
MAX_TEXT = 3000000
MODEL_DIR = Path(os.environ.get("SILERO_MODEL_DIR", "/models"))
API_KEY = os.environ.get("SILERO_API_KEY", "")
LOCK = threading.Lock()
MODEL = None
STRESS = StressProcessor(os.environ.get("SILERO_STRESS_ENABLED", "true").lower() == "true")
STATE_LOCK = threading.Lock()
JOBS = {}
SPEED = max(1.0, float(os.environ.get("SILERO_ESTIMATED_CHARS_PER_SECOND", "15")))
SPEED_MEASURED = False


def update_job(request_id, **values):
    if not request_id:
        return
    with STATE_LOCK:
        if request_id not in JOBS:
            for key, job in list(JOBS.items()):
                if len(JOBS) < 128:
                    break
                if job.get("state") in ("ready", "error"):
                    del JOBS[key]
        JOBS.setdefault(request_id, {}).update(values)


def normalize_numbers(text):
    def words(match):
        digits = match.group()
        # Read long identifiers digit by digit rather than as enormous cardinals.
        if len(digits) > 15:
            value = " ".join(num2words(int(digit), lang="ru") for digit in digits)
        else:
            value = num2words(int(digits), lang="ru")
        return f" {value} "
    return re.sub(r"\s+", " ", re.sub(r"\d+", words, text)).strip()


def split_text(text, limit=700, accentuate=None):
    """Bound synthesis calls, preserving paragraph/sentence boundaries where possible."""
    for paragraph in re.split(r"\n\s*\n", text):
        paragraph = normalize_numbers(re.sub(r"\s+", " ", paragraph).strip())
        if accentuate is not None:
            paragraph = accentuate(paragraph)
        while paragraph:
            if len(paragraph) <= limit:
                if re.search(r"[А-Яа-яЁё]", paragraph):
                    yield paragraph
                break
            prefix = paragraph[:limit]
            ends = list(re.finditer(r"[.!?…](?:[\"»])?\s+", prefix))
            cut = ends[-1].end() if ends else prefix.rfind(" ")
            if cut < 1:
                cut = limit
            if paragraph[cut - 1] == "+":
                cut -= 1
            chunk = paragraph[:cut].strip()
            if re.search(r"[А-Яа-яЁё]", chunk):
                yield chunk
            paragraph = paragraph[cut:].strip()


def load_model():
    global MODEL
    if MODEL is not None:
        return MODEL
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    model_file = MODEL_DIR / f"{MODEL_ID}.pt"
    if not model_file.exists():
        logging.info("Downloading Silero model %s", MODEL_ID)
        temporary = model_file.with_suffix(".partial")
        try:
            with urllib.request.urlopen(
                f"https://models.silero.ai/models/tts/ru/{MODEL_ID}.pt", timeout=120
            ) as source, temporary.open("wb") as target:
                shutil.copyfileobj(source, target)
            temporary.replace(model_file)
        finally:
            temporary.unlink(missing_ok=True)
    torch.set_num_threads(max(1, min(16, int(os.environ.get("SILERO_THREADS", "4")))))
    MODEL = torch.package.PackageImporter(str(model_file)).load_pickle("tts_models", "model")
    MODEL.to(torch.device("cpu"))
    logging.info("Silero model loaded")
    return MODEL


def synthesize(text, speaker, directory, request_id="", options=None, segments=None):
    global SPEED, SPEED_MEASURED
    update_job(request_id, state="loading", progress=0, remainingSeconds=None)
    model = load_model()
    custom = options is not None
    started = time.monotonic()
    accentuate = STRESS if STRESS.enabled else None
    source = tuned_chunks(segments, options, normalize_numbers, accentuate=accentuate) if custom else (
        (chunk, len(chunk)) for chunk in split_text(text, accentuate=accentuate))
    chunks, total = [], 0
    preparation_share = 0.1 if STRESS.enabled else 0
    if STRESS.enabled:
        update_job(request_id, state="preparing", progress=0, remainingSeconds=None)
    for chunk, count in source:
        total += count
        if total > MAX_TEXT:
            raise ValueError("Normalized text exceeds synthesis limit")
        chunks.append((chunk, count))
        if STRESS.enabled:
            update_job(request_id, progress=preparation_share * min(1, total / max(1, len(text))))
    if not total or total > MAX_TEXT:
        raise ValueError("Normalized text exceeds synthesis limit or is empty")
    update_job(request_id, state="generating", progress=preparation_share, remainingSeconds=round(total / SPEED))
    mp3_file = Path(directory) / "speech.mp3"
    # Encode incrementally: a whole-book PCM/WAV file can occupy gigabytes.
    encoder = subprocess.Popen(
        ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
         "-f", "s16le", "-ar", str(SAMPLE_RATE), "-ac", "1", "-i", "pipe:0",
         "-codec:a", "libmp3lame", "-b:a", "64k", str(mp3_file)],
        stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    generated_characters = 0
    try:
        with torch.inference_mode():
            for chunk, count in chunks:
                generated_characters += count
                if generated_characters > MAX_TEXT:
                    raise ValueError("Normalized text exceeds synthesis limit")
                chunk, silence_ms = trailing_pause(chunk) if custom else (chunk, 0)
                audio = model.apply_tts(**({"ssml_text": chunk} if custom else {"text": chunk}),
                                        speaker=speaker, sample_rate=SAMPLE_RATE, put_accent=not STRESS.enabled, put_yo=not STRESS.enabled,
                                        **({"put_stress_homo": False, "put_yo_homo": False, "stress_single_vowel": False} if STRESS.enabled else {}))
                pcm = (audio.detach().cpu().clamp(-1, 1) * 32767).to(torch.int16)
                encoder.stdin.write(pcm.numpy().astype("<i2", copy=False).tobytes())
                if silence_ms:
                    encoder.stdin.write(bytes(SAMPLE_RATE * silence_ms // 1000 * 2))
                elapsed = max(0.01, time.monotonic() - started)
                update_job(request_id, progress=preparation_share + (1 - preparation_share) * generated_characters / total,
                           remainingSeconds=round((total - generated_characters) * elapsed / generated_characters))
        encoder.stdin.close()
        if encoder.wait(timeout=300) != 0:
            raise RuntimeError("FFmpeg encoding failed")
    finally:
        if encoder.poll() is None:
            encoder.kill()
            encoder.wait(timeout=10)
        if not encoder.stdin.closed:
            encoder.stdin.close()
    elapsed = max(0.01, time.monotonic() - started)
    with STATE_LOCK:
        observed = total / elapsed
        SPEED = (SPEED * 0.7 + observed * 0.3) if SPEED_MEASURED else observed
        SPEED_MEASURED = True
    update_job(request_id, state="ready", progress=1, remainingSeconds=0)
    return mp3_file


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, format_string, *args):
        # Requests contain no credentials or text in their URLs.
        logging.info(format_string, *args)

    def reply(self, code, message):
        data = json.dumps({"error": message}, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(data)
        self.close_connection = True

    def do_GET(self):
        if self.path != "/health" and API_KEY and not hmac.compare_digest(self.headers.get("Authorization", ""), f"Bearer {API_KEY}"):
            return self.reply(401, "Unauthorized")
        if self.path == "/estimate":
            with STATE_LOCK:
                result = {"charactersPerSecond": SPEED, "measured": SPEED_MEASURED,
                          "warmupSeconds": 0 if MODEL is not None and (not STRESS.enabled or STRESS.model is not None) else 120,
                          "cacheIdentity": STRESS.cache_identity}
        elif re.fullmatch(r"/jobs/[a-f0-9]{64}", self.path):
            with STATE_LOCK:
                result = dict(JOBS.get(self.path.rsplit("/", 1)[-1], {}))
            if not result:
                return self.reply(404, "Job not found")
        elif self.path == "/health":
            result = {"ok": True, "model": MODEL_ID, "loaded": MODEL is not None, "cacheIdentity": STRESS.cache_identity,
                      "stressEnabled": STRESS.enabled, "stressVersion": STRESS_VERSION if STRESS.enabled else None, "stressLoaded": STRESS.model is not None}
        else:
            return self.reply(404, "Not found")
        data = json.dumps(result).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(data)
        self.close_connection = True

    def do_POST(self):
        if self.path != "/synthesize":
            return self.reply(404, "Not found")
        if API_KEY and not hmac.compare_digest(self.headers.get("Authorization", ""), f"Bearer {API_KEY}"):
            return self.reply(401, "Unauthorized")
        try:
            self.connection.settimeout(30)
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= MAX_REQUEST:
                return self.reply(413, "Invalid request size")
            data = json.loads(self.rfile.read(length))
            self.connection.settimeout(None)
            text = data.get("text", "")
            speaker = data.get("speaker", "xenia")
            request_id = data.get("requestId", "")
            if not isinstance(request_id, str) or (request_id and not re.fullmatch(r"[a-f0-9]{64}", request_id)):
                return self.reply(400, "Invalid request ID")
            if not isinstance(text, str) or not re.search(r"[А-Яа-яЁё\d]", text) or len(text) > MAX_TEXT:
                return self.reply(400, "Invalid text")
            if speaker not in SPEAKERS or data.get("model", MODEL_ID) != MODEL_ID:
                return self.reply(400, "Unsupported speaker or model")
            options = normalize_options(data["options"]) if "options" in data else None
            segments = validate_segments(data.get("segments"), text) if options is not None else None
        except (ValueError, TypeError, AttributeError, TimeoutError):
            return self.reply(400, "Invalid JSON")
        if not LOCK.acquire(blocking=False):
            return self.reply(429, "Synthesis is busy")
        try:
            with tempfile.TemporaryDirectory(prefix="silero-") as directory:
                audio = synthesize(text, speaker, directory, request_id, options, segments)
                self.send_response(200)
                self.send_header("Content-Type", "audio/mpeg")
                self.send_header("X-INPX-Speech-Options", "1")
                self.send_header("X-INPX-Speech-Engine", STRESS.cache_identity or "builtin")
                self.send_header("Content-Length", str(audio.stat().st_size))
                self.send_header("Connection", "close")
                self.end_headers()
                with audio.open("rb") as source:
                    shutil.copyfileobj(source, self.wfile)
                self.close_connection = True
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            update_job(request_id, state="error", remainingSeconds=None)
            logging.exception("Synthesis failed")
            self.reply(500, "Synthesis failed; check service logs")
        finally:
            LOCK.release()


if __name__ == "__main__":
    if not re.fullmatch(r"v5(?:_\d+)?_ru", MODEL_ID):
        raise ValueError("SILERO_MODEL must be a Russian Silero v5 model")
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    ThreadingHTTPServer(("0.0.0.0", int(os.environ.get("SILERO_PORT", "8000"))), Handler).serve_forever()
