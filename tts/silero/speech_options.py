"""Validated speech controls; book text is always escaped before creating SSML."""
import re
from xml.sax.saxutils import escape


def normalize_options(value=None):
    if value is None:
        value = {}
    if not isinstance(value, dict):
        raise ValueError("Invalid speech options")
    options = dict(pitch="medium", sentencePauseMs=None, paragraphPauseMs=None, chapterPauseMs=None, dictionary="")
    pitch = value.get("pitch", "medium")
    if pitch not in ("x-low", "low", "medium", "high", "x-high"):
        raise ValueError("Invalid pitch")
    options["pitch"] = pitch
    for key, maximum in (("sentencePauseMs", 2000), ("paragraphPauseMs", 5000), ("chapterPauseMs", 10000)):
        pause = value.get(key)
        if pause is not None and (type(pause) is not int or not 0 <= pause <= maximum):
            raise ValueError("Invalid pause")
        options[key] = pause
    dictionary = value.get("dictionary", "")
    if not isinstance(dictionary, str) or len(dictionary) > 10000:
        raise ValueError("Invalid dictionary")
    rules, seen = [], set()
    for line in filter(None, (line.strip() for line in dictionary.splitlines())):
        word, separator, pronunciation = line.partition("=")
        word, pronunciation = word.strip(), pronunciation.strip()
        if (not separator or not word or not pronunciation or len(word) > 100 or len(pronunciation) > 200
                or any(not (char.isalnum() or char in " '’.-") for char in word)
                or any(not (char.isalnum() or char in "+ '’.,!?-") for char in pronunciation)
                or not re.search(r"[а-яё]", pronunciation, re.I) or re.search(r"\+(?![аеёиоуыэюя])", pronunciation, re.I)
                or word.lower() in seen):
            raise ValueError("Invalid dictionary rule")
        seen.add(word.lower())
        rules.append(f"{word} = {pronunciation}")
    if len(rules) > 100:
        raise ValueError("Too many dictionary rules")
    options["dictionary"] = "\n".join(rules)
    return options


def dictionary_replacer(dictionary):
    rules = {word.strip().lower(): pronunciation.strip() for word, pronunciation in
             (line.split("=", 1) for line in dictionary.splitlines())}
    if not rules:
        return lambda text: text
    pattern = re.compile(r"(?<!\w)(?:" + "|".join(re.escape(word) for word in sorted(rules, key=len, reverse=True)) + r")(?!\w)", re.I)
    def replace(text):
        length = len(text)
        def replacement(match):
            nonlocal length
            value = rules[match.group().lower()]
            length += len(value) - len(match.group())
            if length > 3000000:
                raise ValueError("Dictionary expansion exceeds text limit")
            return value
        return pattern.sub(replacement, text)
    return replace


def validate_segments(segments, text):
    if segments is None:
        return [dict(text=text, chapterEnd=False, paragraphEnd=False)]
    if not isinstance(segments, list) or not segments or len(segments) > 20000:
        raise ValueError("Invalid speech segments")
    total = 0
    for segment in segments:
        if (not isinstance(segment, dict) or not isinstance(segment.get("text"), str)
                or not segment["text"].strip() or any(type(segment.get(key, False)) is not bool for key in ("chapterEnd", "paragraphEnd"))):
            raise ValueError("Invalid speech segment")
        total += len(segment["text"])
    if total > 3000000:
        raise ValueError("Speech segments exceed text limit")
    return segments


def tuned_chunks(segments, options, normalize_numbers, limit=700, accentuate=None):
    replace = dictionary_replacer(options["dictionary"])
    processed = 0
    for segment in segments:
        paragraphs = [paragraph.strip() for paragraph in re.split(r"\n\s*\n", segment["text"]) if paragraph.strip()]
        for index, original in enumerate(paragraphs):
            paragraph = normalize_numbers(replace(original))
            if accentuate is not None:
                paragraph = accentuate(paragraph)
            if not re.search(r"[А-Яа-яЁё]", paragraph):
                continue
            last = index == len(paragraphs) - 1
            sentences = [sentence.strip() for sentence in re.findall(r".*?(?:[.!?…]+[\"»”']*(?=\s|$)|$)", paragraph) if sentence.strip()]
            buffer, count = [], 0
            for number, sentence in enumerate(sentences):
                pieces = []
                while len(sentence) > limit:
                    cut = sentence[:limit].rfind(" ")
                    if cut < 1:
                        cut = limit
                    # Keep an explicit stress marker attached to its vowel.
                    if sentence[cut - 1] == "+":
                        cut -= 1
                    pieces.append(sentence[:cut].strip())
                    sentence = sentence[cut:].strip()
                pieces.append(sentence)
                for part, piece in enumerate(pieces):
                    processed += len(piece)
                    if processed > 3000000:
                        raise ValueError("Normalized speech exceeds text limit")
                    if count + len(piece) > limit and buffer:
                        yield wrap_ssml(" ".join(buffer), options["pitch"]), count
                        buffer, count = [], 0
                    markup = escape(piece)
                    if part == len(pieces) - 1:
                        pause = options["sentencePauseMs"]
                        end = number == len(sentences) - 1
                        paragraph_end = not last or segment.get("paragraphEnd", False)
                        if end and paragraph_end:
                            pause = options["paragraphPauseMs"]
                            if pause is None:
                                markup += '<break strength="x-strong"/>'
                        if end and last and segment.get("chapterEnd", False) and options["chapterPauseMs"] is not None:
                            pause = options["chapterPauseMs"]
                        if pause is not None:
                            markup += f'<break time="{pause}ms"/>'
                    buffer.append(markup)
                    count += len(piece)
            if buffer:
                yield wrap_ssml(" ".join(buffer), options["pitch"]), count


def wrap_ssml(text, pitch):
    if pitch != "medium":
        text = f'<prosody pitch="{pitch}">{text}</prosody>'
    return f"<speak>{text}</speak>"


def trailing_pause(ssml):
    # Silero drops a break after the last spoken token. Encode that silence in PCM.
    match = re.search(r'<break time="(\d+)ms"/>(?=</prosody></speak>$|</speak>$)', ssml)
    if match:
        return ssml[:match.start()] + ssml[match.end():], int(match.group(1))
    return ssml, 0
