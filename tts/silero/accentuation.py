"""Optional, lazy CPU accentuation before TTS/SSML. No text is retained."""
import re
import torch

STRESS_VERSION = "1.5"


class StressProcessor:
    def __init__(self, enabled=False, loader=None):
        self.enabled = enabled
        self.model = None
        self.loader = loader

    @property
    def cache_identity(self):
        return f"silero-stress-{STRESS_VERSION}-pipeline-v1" if self.enabled else ""

    def load(self):
        if self.model is None:
            threads = torch.get_num_threads()
            try:
                if self.loader is None:
                    from silero_stress import load_accentor
                    loader = load_accentor
                else:
                    loader = self.loader
                model = loader()
                model.to(device="cpu")
                self.model = model
            finally:
                # Importing silero_stress globally changes Torch to one thread.
                torch.set_num_threads(threads)
        return self.model

    def __call__(self, text):
        if not self.enabled:
            return text
        model = self.load()
        result = []
        with torch.inference_mode():
            for block in context_blocks(text):
                # Explicit + and ё from the pronunciation dictionary are preserved.
                result.append(model(block, stress_single_vowel=False))
        return " ".join(result)


def context_blocks(text, limit=1500):
    """Keep sentence context, bounding neural input even for huge FB2 paragraphs."""
    while len(text) > limit:
        prefix = text[:limit]
        ends = list(re.finditer(r'[.!?…][\"»”]*\s+', prefix))
        cut = ends[-1].end() if ends else prefix.rfind(" ")
        if cut < 1:
            cut = limit
        if text[cut - 1] == "+":
            cut -= 1
        yield text[:cut].strip()
        text = text[cut:].strip()
    if text:
        yield text
