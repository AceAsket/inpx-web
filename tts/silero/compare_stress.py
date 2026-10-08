"""Optional local comparison with the accentor embedded in the configured TTS model."""
import json
import time
from pathlib import Path
import argparse
from accentuation import StressProcessor
from server import load_model

CASES = [
    ("Дверной замок сломался.", "зам+ок"),
    ("На горе стоит старый замок.", "з+амок"),
    ("Ключ не подходит к замку.", "замк+у"),
    ("Крепостная стена ведёт к замку.", "з+амку"),
    ("Эта книга стоит дорого.", "ст+оит"),
    ("На полке стоит книга.", "сто+ит"),
    ("Он уже пришёл.", "уж+е"),
    ("Этот проход уже предыдущего.", "+уже"),
    ("Пшеничная мука лежит в пакете.", "мук+а"),
    ("Для него ожидание — настоящая мука.", "м+ука"),
    ("Атлас мира лежит на столе.", "+атлас"),
    ("Платье сшито из атласа.", "атл+аса"),
    ("Кружки стоят на столе.", "кр+ужки"),
    ("Дети посещают кружки.", "кружк+и"),
    ("Тонкие стрелки часов.", "стр+елки"),
    ("Опытные стрелки попали в мишень.", "стрелк+и"),
    ("В саду растут гвоздики.", "гвозд+ики"),
    ("Маленькие гвоздики лежат в коробке.", "гв+оздики"),
    ("Герми+она открыла книгу.", "Герми+она"),
    ("Лёва закрыл дверь.", "Л+ёва"),
]


def compare():
    tts = load_model()
    builtin = tts.packages[tts.speaker_to_package["xenia"]].accentor
    external = StressProcessor(True)
    started = time.perf_counter()
    external.load()
    load_seconds = time.perf_counter() - started
    # Warm both engines before timing; this is a small diagnostic, not a benchmark dataset.
    builtin(CASES[0][0], stress_single_vowel=False)
    external(CASES[0][0])
    rows, times = [], {"builtin": 0.0, "external": 0.0}
    for text, expected in CASES:
        values = {}
        for name, engine in (("builtin", lambda value: builtin(value, stress_single_vowel=False)), ("external", external)):
            started = time.perf_counter()
            values[name] = engine(text)
            times[name] += time.perf_counter() - started
        rows.append(dict(text=text, expected=expected, **values,
                         builtinCorrect=expected.lower() in values["builtin"].lower(),
                         externalCorrect=expected.lower() in values["external"].lower()))
    return dict(cases=len(rows), builtinCorrect=sum(row["builtinCorrect"] for row in rows),
                externalCorrect=sum(row["externalCorrect"] for row in rows), loadSeconds=round(load_seconds, 3),
                seconds={name: round(value, 3) for name, value in times.items()}, rows=rows)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output")
    args = parser.parse_args()
    result = compare()
    encoded = json.dumps(result, ensure_ascii=False, indent=2)
    if args.output:
        Path(args.output).write_text(encoded, encoding="utf-8")
    print(encoded)
