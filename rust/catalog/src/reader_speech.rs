use std::sync::LazyLock;

use regex::Regex;
use serde::Serialize;
use unicode_normalization::UnicodeNormalization;

use super::{Document, Element, Node, js_space};
use crate::Result;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum SpeechMode {
    Book,
    Online,
    Chapters,
}

impl SpeechMode {
    pub fn parse(mode: &str) -> Result<Self> {
        match mode {
            "book" => Ok(Self::Book),
            "online" => Ok(Self::Online),
            "chapters" => Ok(Self::Chapters),
            _ => Err("Неизвестный режим озвучки.".into()),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechPart {
    #[serde(skip)]
    pub title: String,
    pub text: String,
    pub chapter_end: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub paragraph_end: Option<bool>,
}

const NO_TEXT: &str = "В книге нет текста для озвучки. Поддерживается FB2.";
const TEXT_LIMIT: usize = 3_000_000;
static SENTENCE_END: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"[.!?…](?:["»])?\s+"#).expect("sentence end"));
static PARAGRAPH_END: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\s*\n\s*\n").expect("paragraph end"));
static NON_WORD: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[^\p{L}\p{N}]").expect("speech anchor characters"));

pub fn speech_anchor_key(text: &str) -> String {
    let normalized = text
        .nfkc()
        .collect::<String>()
        .to_lowercase()
        .replace('ё', "е");
    NON_WORD.replace_all(&normalized, "").into_owned()
}

impl Document {
    pub fn speech_parts(&self, mode: SpeechMode) -> Result<Vec<SpeechPart>> {
        let mut units = Vec::new();
        let mut total = 0;
        for body in self
            .root
            .children("body")
            .filter(|body| !body.attr("name").eq_ignore_ascii_case("notes"))
        {
            collect_units(&body.children, "", &mut units, &mut total)?;
        }
        if units.is_empty() {
            return Err(NO_TEXT.into());
        }
        if mode == SpeechMode::Book {
            return Ok(vec![SpeechPart {
                title: "Вся книга".into(),
                text: units
                    .into_iter()
                    .map(|unit| unit.text)
                    .collect::<Vec<_>>()
                    .join("\n\n"),
                chapter_end: true,
                paragraph_end: None,
            }]);
        }
        let limit = if mode == SpeechMode::Online {
            700
        } else {
            6000
        };
        let mut parts = Vec::new();
        let mut heading = String::new();
        for unit in units {
            heading.push_str(&unit.text);
            if unit.heading_only {
                heading.push_str("\n\n");
                continue;
            }
            let title = if unit.title.is_empty() {
                format!("Глава {}", parts.len() + 1)
            } else {
                unit.title
            };
            append_parts(&mut parts, &heading, &title, limit, false);
            heading.clear();
        }
        if !heading.is_empty() {
            append_parts(&mut parts, heading.trim_end(), "Заключение", limit, true);
        }
        Ok(parts)
    }
}

struct Unit {
    title: String,
    text: String,
    heading_only: bool,
}

fn collect_units(
    nodes: &[Node],
    inherited: &str,
    units: &mut Vec<Unit>,
    total: &mut usize,
) -> Result<()> {
    let title = nodes
        .iter()
        .find_map(|node| match node {
            Node::Element(element) if element.name == "title" => {
                let mut text = String::new();
                Some(paragraphs(element, &mut text, &mut 0).map(|()| collapse(&text)))
            }
            _ => None,
        })
        .transpose()?
        .filter(|title| !title.is_empty());
    let title = title.as_deref().unwrap_or(inherited);
    let mut text = String::new();
    let mut heading_only = true;
    for node in nodes {
        let Node::Element(element) = node else {
            continue;
        };
        if element.name == "section" {
            flush(units, title, &mut text, heading_only);
            heading_only = true;
            collect_units(&element.children, title, units, total)?;
        } else {
            heading_only &= matches!(element.name.as_str(), "title" | "image" | "empty-line");
            paragraphs(element, &mut text, total)?;
        }
    }
    flush(units, title, &mut text, heading_only);
    Ok(())
}

fn flush(units: &mut Vec<Unit>, title: &str, text: &mut String, heading_only: bool) {
    if !text.is_empty() {
        units.push(Unit {
            title: title.into(),
            text: std::mem::take(text),
            heading_only,
        });
    }
}

fn paragraphs(element: &Element, output: &mut String, total: &mut usize) -> Result<()> {
    match element.name.as_str() {
        "p" | "v" | "subtitle" | "text-author" => {
            let mut text = String::new();
            inline(element, &mut text);
            let text = collapse(&text);
            if !text.is_empty() {
                *total += text.encode_utf16().count() + usize::from(*total > 0) * 2;
                if *total > TEXT_LIMIT {
                    return Err(
                        "Текст книги слишком большой для озвучки (лимит 3 млн символов).".into(),
                    );
                }
                if !output.is_empty() {
                    output.push_str("\n\n");
                }
                output.push_str(&text);
            }
        }
        "image" | "binary" => {}
        _ => {
            for node in &element.children {
                if let Node::Element(child) = node {
                    paragraphs(child, output, total)?;
                }
            }
        }
    }
    Ok(())
}

fn inline(element: &Element, output: &mut String) {
    if matches!(element.name.as_str(), "image" | "binary")
        || element.name == "a" && element.attr("type") == "note"
    {
        return;
    }
    for node in &element.children {
        match node {
            Node::Text(2, text) => output.push_str(&html_escape::decode_html_entities(text)),
            Node::Text(3, text) => output.push_str(text),
            Node::Element(child) => inline(child, output),
            _ => {}
        }
    }
}

fn collapse(text: &str) -> String {
    text.split(js_space)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn append_parts(
    parts: &mut Vec<SpeechPart>,
    mut source: &str,
    title: &str,
    limit: usize,
    trailing: bool,
) {
    let start = parts.len();
    while !source.is_empty() {
        let mut chars = 0;
        let boundary = source.char_indices().find_map(|(index, ch)| {
            chars += ch.len_utf16();
            (chars > limit).then_some(index)
        });
        let cut = if let Some(boundary) = boundary {
            let prefix = &source[..boundary];
            match prefix
                .rfind("\n\n")
                .filter(|offset| prefix[..*offset].encode_utf16().count() >= limit / 2)
            {
                Some(cut) => cut,
                None => SENTENCE_END
                    .find_iter(prefix)
                    .last()
                    .map(|end| end.end())
                    .or_else(|| prefix.rfind(' '))
                    .filter(|cut| *cut > 0)
                    .unwrap_or(boundary),
            }
        } else {
            source.len()
        };
        let text = source[..cut].trim_end_matches(js_space);
        let paragraph_end = PARAGRAPH_END.is_match(&source[text.len()..]);
        source = source[cut..].trim_start_matches(js_space);
        parts.push(SpeechPart {
            title: title.into(),
            text: text.into(),
            chapter_end: source.is_empty(),
            paragraph_end: (!trailing).then_some(paragraph_end),
        });
    }
    let count = parts.len() - start;
    if count > 1 && !trailing {
        for (index, part) in parts[start..].iter_mut().enumerate() {
            part.title = format!("{title} · часть {}/{count}", index + 1);
        }
    }
}
