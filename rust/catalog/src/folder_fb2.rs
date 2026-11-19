use std::io::Read;
use std::sync::LazyLock;

use quick_xml::{
    Reader,
    events::{BytesStart, Event},
};
use serde_json::{Value, json};

use crate::book_archive::Failure;
use crate::book_metadata::{FB2_PREFIX, read_description};
use crate::fb2_prepare::js_space;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Tag {
    Description,
    TitleInfo,
    Author,
    Genre,
    Title,
    Language,
    Keywords,
    Sequence,
    LastName,
    FirstName,
    MiddleName,
    Nickname,
}

impl Tag {
    fn child(self, name: &str) -> Option<Self> {
        use Tag::*;
        let children: &[(&str, Self)] = match self {
            Description => &[("title-info", TitleInfo)],
            TitleInfo => &[
                ("author", Author),
                ("genre", Genre),
                ("book-title", Title),
                ("lang", Language),
                ("keywords", Keywords),
                ("sequence", Sequence),
            ],
            Author => &[
                ("last-name", LastName),
                ("first-name", FirstName),
                ("middle-name", MiddleName),
                ("nickname", Nickname),
            ],
            _ => return None,
        };
        children
            .iter()
            .find_map(|&(key, tag)| name.eq_ignore_ascii_case(key).then_some(tag))
    }
}

struct Element<'a> {
    tag: Tag,
    text: Option<&'a str>,
    series: String,
    number: String,
    children: Vec<Element<'a>>,
}

impl<'a> Element<'a> {
    fn new(tag: Tag, raw: &BytesStart<'_>) -> Result<Self, Failure> {
        let mut element = Self {
            tag,
            text: None,
            series: String::new(),
            number: String::new(),
            children: Vec::new(),
        };
        if tag == Tag::Sequence {
            for attribute in raw.attributes() {
                let attribute = attribute.map_err(|_| Failure::Unsupported)?;
                let key = attribute.key.as_ref();
                let value = if key.eq_ignore_ascii_case("name") {
                    &mut element.series
                } else if key.eq_ignore_ascii_case("number") {
                    &mut element.number
                } else {
                    continue;
                };
                *value = attribute.value.into_owned();
            }
        }
        Ok(element)
    }

    fn child(&self, tag: Tag) -> Option<&Element<'a>> {
        self.children.iter().find(|child| child.tag == tag)
    }

    fn field(&self, tag: Tag) -> Option<&'a str> {
        self.child(tag).and_then(|child| child.text)
    }
}

fn parse_elements(xml: &str) -> Result<Element<'_>, Failure> {
    let mut reader = Reader::from_str(xml);
    let mut stack: Vec<Option<Element>> = Vec::new();
    let mut text_start = None;
    loop {
        let start = reader.buffer_position() as usize;
        let event = reader.read_event().map_err(|_| Failure::Unsupported)?;
        if matches!(event, Event::Text(_) | Event::GeneralRef(_)) {
            text_start.get_or_insert(start);
            continue;
        }
        if let Some(text_start) = text_start.take()
            && let Some(Some(element)) = stack.last_mut()
            && element.text.is_none()
        {
            // The folder catalogue preserves the first direct text segment, including entities.
            let text = &xml[text_start..start];
            if !text.trim_matches(js_space).is_empty() {
                element.text = Some(text);
            }
        }
        match event {
            Event::Start(ref raw) | Event::Empty(ref raw) => {
                let name = raw.name();
                let tag = match stack.last() {
                    Some(parent) => parent
                        .as_ref()
                        .and_then(|parent| parent.tag.child(name.as_ref())),
                    None if name.as_ref().eq_ignore_ascii_case("description") => {
                        Some(Tag::Description)
                    }
                    None => return Err(Failure::Unsupported),
                };
                let element = tag.map(|tag| Element::new(tag, raw)).transpose()?;
                if matches!(event, Event::Start(_)) {
                    if stack.len() >= 128 {
                        return Err(Failure::Unsupported);
                    }
                    stack.push(element);
                } else if let (Some(Some(parent)), Some(element)) = (stack.last_mut(), element) {
                    parent.children.push(element);
                }
            }
            Event::End(_) => {
                let element = stack.pop().ok_or(Failure::Unsupported)?;
                if stack.is_empty() {
                    return element.ok_or(Failure::Unsupported);
                }
                if let (Some(Some(parent)), Some(element)) = (stack.last_mut(), element) {
                    parent.children.push(element);
                }
            }
            Event::CData(_) | Event::Comment(_) => {}
            _ => return Err(Failure::Unsupported),
        }
    }
}

fn author(element: &Element<'_>) -> String {
    let names = [Tag::LastName, Tag::FirstName, Tag::MiddleName]
        .into_iter()
        .filter_map(|tag| element.field(tag))
        .collect::<Vec<_>>();
    if names.is_empty() {
        element.field(Tag::Nickname).unwrap_or("").to_owned()
    } else {
        names.join(" ")
    }
}

fn parse(xml: &str) -> Result<Value, Failure> {
    let description = parse_elements(xml)?;
    let Some(title) = description.child(Tag::TitleInfo) else {
        return Ok(json!({}));
    };
    let authors = title
        .children
        .iter()
        .filter(|child| child.tag == Tag::Author)
        .map(author)
        .collect::<Vec<_>>()
        .join(",");
    let genres = title
        .children
        .iter()
        .filter(|child| child.tag == Tag::Genre)
        .map(|child| child.text.unwrap_or(""))
        .collect::<Vec<_>>()
        .join(",");
    let sequence = title.child(Tag::Sequence);
    Ok(json!({
        "title":title.field(Tag::Title), "author":authors, "genre":genres,
        "lang":title.field(Tag::Language), "keywords":title.field(Tag::Keywords),
        "series":sequence.map_or("",|node| &node.series), "seriesNumber":sequence.map_or("",|node| &node.number),
    }))
}

pub(crate) fn read(reader: impl Read, limit: u64) -> Result<Value, Failure> {
    static END: LazyLock<regex::bytes::Regex> =
        LazyLock::new(|| regex::bytes::Regex::new(r"(?i-u)</description>").unwrap());
    read_description(reader, limit.min(FB2_PREFIX), &END, parse)?.ok_or(Failure::Unsupported)
}
