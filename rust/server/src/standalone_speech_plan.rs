use inpx_catalog::Result;
use inpx_catalog::reader_document::{SpeechPart, speech_anchor_key};
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::HashSet;

#[derive(Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Options {
    pitch: Pitch,
    sentence_pause_ms: Option<u64>,
    paragraph_pause_ms: Option<u64>,
    chapter_pause_ms: Option<u64>,
    dictionary: String,
}

#[derive(Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum Pitch {
    XLow,
    Low,
    #[default]
    Medium,
    High,
    XHigh,
}

impl Options {
    pub(super) fn parse(value: Option<&Value>) -> Result<Option<Self>> {
        let Some(value) = value else { return Ok(None) };
        if !value.is_object() {
            return Err("Некорректные настройки озвучки.".into());
        }
        let pitch = match value.get("pitch").map(Value::as_str) {
            Some(Some("x-low")) => Pitch::XLow,
            Some(Some("low")) => Pitch::Low,
            None | Some(Some("medium")) => Pitch::Medium,
            Some(Some("high")) => Pitch::High,
            Some(Some("x-high")) => Pitch::XHigh,
            _ => return Err("Неизвестная высота голоса.".into()),
        };
        let pause = |key: &str, max| -> Result<Option<u64>> {
            let value = &value[key];
            if value.is_null() {
                return Ok(None);
            }
            value
                .as_f64()
                .filter(|n| n.fract() == 0.0 && *n >= 0.0 && *n <= max)
                .map(|n| Some(n as u64))
                .ok_or_else(|| "Недопустимая длительность паузы.".into())
        };
        let result = Self {
            pitch,
            sentence_pause_ms: pause("sentencePauseMs", 2000.0)?,
            paragraph_pause_ms: pause("paragraphPauseMs", 5000.0)?,
            chapter_pause_ms: pause("chapterPauseMs", 10000.0)?,
            dictionary: dictionary(value.get("dictionary"))?,
        };
        Ok((result != Self::default()).then_some(result))
    }
}

pub(super) fn russian(ch: char) -> bool {
    matches!(ch, 'а'..='я' | 'А'..='Я' | 'ё' | 'Ё')
}

fn dictionary(value: Option<&Value>) -> Result<String> {
    let Some(value) = value else {
        return Ok(String::new());
    };
    let value = value.as_str().ok_or("Словарь должен быть текстом.")?;
    if value.encode_utf16().count() > 10000 {
        return Err("Словарь слишком большой (до 10 000 символов).".into());
    }
    let mut seen = HashSet::new();
    let mut rules = Vec::new();
    let valid = |ch: char| ch.is_alphanumeric() || " '’.-".contains(ch);
    for line in value.lines().map(str::trim).filter(|line| !line.is_empty()) {
        let error = "Словарь: одна строка «слово = произношение», + перед ударной гласной.";
        let (word, pronunciation) = line.split_once('=').ok_or(error)?;
        let (word, pronunciation) = (word.trim(), pronunciation.trim());
        if word.is_empty()
            || word.encode_utf16().count() > 100
            || !word.chars().all(valid)
            || pronunciation.encode_utf16().count() > 200
            || !pronunciation.chars().any(russian)
            || !pronunciation
                .chars()
                .all(|ch| valid(ch) || "+,!?".contains(ch))
            || pronunciation
                .split('+')
                .skip(1)
                .any(|part| !part.starts_with(|ch| "аеёиоуыэюяАЕЁИОУЫЭЮЯ".contains(ch)))
        {
            return Err(error.into());
        }
        if !seen.insert(word.to_lowercase()) {
            return Err(format!("В словаре повторяется «{word}».").into());
        }
        rules.push(format!("{word} = {pronunciation}"));
    }
    if rules.len() > 100 {
        return Err("В словаре допускается до 100 замен.".into());
    }
    Ok(rules.join("\n"))
}

pub(super) fn chapters(
    parts: &[SpeechPart],
    anchor: &Value,
) -> Result<(Vec<Value>, Option<usize>, usize)> {
    let mut characters = 0;
    let mut full = String::new();
    let mut source_offset = 0;
    let mut starts = Vec::with_capacity(parts.len());
    let chapters = parts.iter().enumerate().map(|(index, part)| {
        starts.push(full.len());
        let count = part.text.encode_utf16().count();
        characters += count;
        let text = part.text.split_whitespace().collect::<Vec<_>>().join(" ");
        let snippet = truncate(&text, 180);
        let chapter = json!({"index":index,"title":part.title,"characters":count,"chapterEnd":part.chapter_end,
            "anchor":{"textSnippet":snippet,"textOffset":-1,"sourceOffset":source_offset}});
        let key = speech_anchor_key(&part.text);
        source_offset += key.encode_utf16().count();
        full.push_str(&key);
        chapter
    }).collect();
    let start = if anchor.is_null() || anchor == false || anchor == "" {
        None
    } else {
        Some(locate(&full, source_offset, &starts, anchor)?)
    };
    Ok((chapters, start, characters))
}

fn locate(full: &str, total: usize, starts: &[usize], anchor: &Value) -> Result<usize> {
    let snippet = speech_anchor_key(truncate(
        anchor["textSnippet"].as_str().unwrap_or_default(),
        500,
    ));
    let length = snippet.encode_utf16().count();
    if length < 8 {
        return Err("Не удалось определить место в тексте. Выберите фрагмент вручную".into());
    }
    let target = number(&anchor["sourceOffset"])
        .filter(|value| *value >= 0.0)
        .or_else(|| {
            number(&anchor["percent"]).map(|value| value.clamp(0.0, 100.0) * total as f64 / 100.0)
        })
        .unwrap_or_default();
    for limit in [120, 64, 24] {
        let needle = truncate(&snippet, limit);
        let mut offset = 0;
        let mut previous = 0;
        let mut nearest = None;
        for (index, _) in full.match_indices(needle) {
            offset += full[previous..index].encode_utf16().count();
            previous = index;
            let distance = (target - offset as f64).abs();
            if nearest.is_none_or(|(best, _)| distance < best) {
                nearest = Some((distance, index));
            }
            if offset as f64 >= target {
                break;
            }
        }
        if let Some((_, index)) = nearest {
            return Ok(starts
                .partition_point(|start| *start <= index)
                .saturating_sub(1));
        }
    }
    Err("Не удалось найти место в озвучке. Выберите фрагмент вручную".into())
}

fn truncate(value: &str, limit: usize) -> &str {
    let mut length = 0;
    let end = value.char_indices().find_map(|(index, ch)| {
        length += ch.len_utf16();
        (length > limit).then_some(index)
    });
    &value[..end.unwrap_or(value.len())]
}

pub(super) fn number(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| value.as_str()?.trim().parse().ok())
        .filter(|value| value.is_finite())
}
