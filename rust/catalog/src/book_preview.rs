use std::collections::HashSet;
use std::io::{BufRead, BufReader, Read};
use std::sync::LazyLock;

use flate2::bufread::MultiGzDecoder;
use quick_xml::{Reader, escape, events::Event};
use regex::Regex;
use serde_json::{Value, json};

use crate::book_archive::{Failure, read_member};
use crate::book_delivery::Book;
use crate::book_metadata::{self, FB2_PREFIX, Format, trim_incomplete_utf8};
use crate::library_sources::Source;
use crate::{book_source, fb2_prepare};

const EPUB_BYTES: u64 = 32 * 1024 * 1024;
const ANNOTATION_CHARS: usize = 6000;

pub fn read(uid: &str, book: Option<&Book>, sources: &[Source]) -> Value {
    let result = book.map_or_else(
        || Ok(response("unavailable", "")),
        |book| {
            let ext = book.ext.to_ascii_lowercase();
            if !matches!(ext.as_str(), "fb2" | "epub") {
                return Ok(response("unsupported", ""));
            }
            let source = book.source(sources).ok_or(Failure::Missing)?;
            preview(book, source, &ext)
        },
    );
    let mut result = match result {
        Ok(value) => value,
        Err(Failure::Limit) => response("limited", ""),
        Err(_) => response("unavailable", ""),
    };
    result["bookUid"] = uid.into();
    json!({"bookPreview":result})
}

fn preview(book: &Book, source: &Source, ext: &str) -> Result<Value, Failure> {
    let extension = book.extension().ok_or(Failure::InvalidType)?;
    let input = book_source::resolve(
        &source.lib_dir,
        &book.folder,
        &format!("{}.{extension}", book.file),
    )?;
    let process = |size, input: &mut dyn Read| {
        if ext == "fb2" {
            return fb2(BufReader::new(input));
        }
        if size > EPUB_BYTES {
            return Err(Failure::Limit);
        }
        let data = book_metadata::read_stream(&Format::Epub, size, input, EPUB_BYTES, false)?;
        let mut result = annotation(data["description"].as_str().unwrap_or_default(), false);
        let tags = tokens(
            data["tags"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str),
        );
        details(
            &mut result,
            year(data["publishedYear"].as_str().unwrap_or_default()),
            tags,
            Vec::new(),
        );
        Ok(result)
    };
    if let Some(member) = input.member {
        read_member(&input.path, input.file, &member, process)
    } else {
        let mut file = input.file;
        process(file.metadata()?.len(), &mut file)
    }
}

fn fb2(mut input: impl BufRead) -> Result<Value, Failure> {
    let mut bytes = Vec::new();
    if input.fill_buf()?.starts_with(b"\x1f\x8b") {
        MultiGzDecoder::new(input)
            .take(FB2_PREFIX)
            .read_to_end(&mut bytes)?;
    } else {
        input.take(FB2_PREFIX).read_to_end(&mut bytes)?;
    }
    let xml = fb2_prepare::decode(trim_incomplete_utf8(&bytes)).ok_or(Failure::Unsupported)?;
    let mut reader = Reader::from_str(&xml);
    reader.config_mut().expand_empty_elements = true;
    let mut path = Vec::<String>::new();
    let mut preview = Fb2Preview::default();
    loop {
        match reader.read_event() {
            Ok(Event::Start(tag) | Event::Empty(tag)) => {
                let label = local_name(tag.name().as_ref());
                path.push(label);
                if path.len() > 128 {
                    break;
                }
                if path.len() == 1 {
                    preview.root = path[0] == "fictionbook";
                }
                if path.len() == 2 && preview.root && matches!(path[1].as_str(), "body" | "binary")
                {
                    preview.finished = !preview.found;
                    break;
                }
                if let [root, description, info, field] = path.as_slice()
                    && root == "fictionbook"
                    && description == "description"
                    && info == "title-info"
                {
                    if field == "annotation" {
                        preview.found = true;
                    }
                    if field == "date" {
                        for attr in tag
                            .attributes()
                            .flatten()
                            .filter(|attr| attr.key.as_ref() == "value")
                        {
                            if let Ok(value) =
                                attr.normalized_value(quick_xml::XmlVersion::Implicit1_0)
                            {
                                preview.date_value = value.into_owned();
                            }
                        }
                    }
                }
                if preview.in_annotation(&path) && path.len() > 4 && block(path.last().unwrap()) {
                    preview.annotation.push_str("\n\n");
                }
            }
            Ok(Event::End(_)) => {
                if preview.in_annotation(&path) {
                    if path.len() == 4 {
                        preview.finished = true;
                    } else if block(path.last().unwrap()) {
                        preview.annotation.push_str("\n\n");
                    }
                }
                if let [root, description, info, field] = path.as_slice()
                    && root == "fictionbook"
                    && description == "description"
                    && info == "title-info"
                    && field == "genre"
                {
                    if !preview.genre.trim().is_empty() && preview.genres.len() < 12 {
                        preview.genres.push(std::mem::take(&mut preview.genre));
                    }
                    preview.genre.clear();
                }
                if path.len() == 2 && preview.root && path[1] == "description" {
                    preview.finished |= !preview.found;
                    break;
                }
                path.pop();
            }
            Ok(Event::Text(data)) => preview.text(&path, data.as_ref()),
            Ok(Event::CData(data)) => preview.text(&path, data.as_ref()),
            Ok(Event::GeneralRef(data)) => {
                if let Ok(Some(ch)) = data.resolve_char_ref() {
                    preview.text(&path, ch.encode_utf8(&mut [0; 4]));
                } else if let Some(value) = escape::resolve_predefined_entity(data.as_ref()) {
                    preview.text(&path, value);
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => (),
        }
    }
    if !preview.root {
        return Ok(response("unavailable", ""));
    }
    let mut result = annotation(&preview.annotation, !preview.finished || preview.limited);
    let year = [&preview.publication, &preview.date_value, &preview.date]
        .into_iter()
        .map(|value| year(value))
        .find(|year| !year.is_empty())
        .unwrap_or_default();
    details(
        &mut result,
        year,
        tokens(preview.keywords.split([',', ';', '\n'])),
        tokens(preview.genres.iter().map(String::as_str)),
    );
    Ok(result)
}

#[derive(Default)]
struct Fb2Preview {
    annotation: String,
    publication: String,
    date: String,
    date_value: String,
    keywords: String,
    genre: String,
    genres: Vec<String>,
    root: bool,
    found: bool,
    finished: bool,
    limited: bool,
}

impl Fb2Preview {
    fn in_annotation(&self, path: &[String]) -> bool {
        self.found
            && path.get(3).is_some_and(|field| field == "annotation")
            && path[2] == "title-info"
            && path[1] == "description"
            && self.root
    }

    fn text(&mut self, path: &[String], value: &str) {
        if self.in_annotation(path) && !self.limited {
            static SPACE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\t\r\n ]+").unwrap());
            let value = SPACE.replace_all(value, " ");
            self.annotation.push_str(if self.annotation.is_empty() {
                value.trim_start()
            } else {
                &value
            });
            if self.annotation.encode_utf16().count() > ANNOTATION_CHARS {
                self.limited = true;
            }
        }
        let [root, description, info, field] = path else {
            return;
        };
        if root != "fictionbook" || description != "description" {
            return;
        }
        let (value_for_field, limit): (_, usize) = match (info.as_str(), field.as_str()) {
            ("title-info", "keywords") => (&mut self.keywords, 1200),
            ("title-info", "date") => (&mut self.date, 64),
            ("title-info", "genre") => (&mut self.genre, 120),
            ("publish-info", "year") => (&mut self.publication, 32),
            _ => return,
        };
        value_for_field.push_str(clip(
            value,
            limit.saturating_sub(value_for_field.encode_utf16().count()),
        ));
    }
}

fn local_name(tag: &str) -> String {
    tag.rsplit(':')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase()
}

fn block(tag: &str) -> bool {
    matches!(tag, "p" | "subtitle" | "empty-line" | "stanza")
}

fn annotation(value: &str, limited: bool) -> Value {
    static CONTROLS: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]").unwrap());
    static SPACE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\t\r ]+").unwrap());
    static EDGES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r" *\n *").unwrap());
    static LINES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\n{3,}").unwrap());
    let clean = CONTROLS.replace_all(value, "");
    let clean = SPACE.replace_all(&clean, " ");
    let clean = EDGES.replace_all(&clean, "\n");
    let clean = LINES.replace_all(&clean, "\n\n");
    let clean = clean.trim_matches(fb2_prepare::js_space);
    let text = clip(clean, ANNOTATION_CHARS);
    let status = if limited || text.len() < clean.len() {
        "limited"
    } else if text.is_empty() {
        "empty"
    } else {
        "ready"
    };
    response(status, text)
}

fn clip(value: &str, limit: usize) -> &str {
    let mut count = 0;
    for (index, ch) in value.char_indices() {
        count += ch.len_utf16();
        if count > limit {
            return &value[..index];
        }
    }
    value
}

fn tokens<'a>(values: impl Iterator<Item = &'a str>) -> Vec<&'a str> {
    let mut seen = HashSet::new();
    values
        .map(|value| clip(value.trim(), 120))
        .filter(|value| !value.is_empty() && seen.insert(*value))
        .take(12)
        .collect()
}

fn year(value: &str) -> &str {
    let value = value.trim();
    value
        .get(..4)
        .filter(|year| {
            !year.starts_with('0')
                && year.bytes().all(|byte| byte.is_ascii_digit())
                && value[4..]
                    .chars()
                    .next()
                    .is_none_or(|ch| matches!(ch, '-' | '/' | '.') || fb2_prepare::js_space(ch))
        })
        .unwrap_or_default()
}

fn details(value: &mut Value, year: &str, tags: Vec<&str>, genres: Vec<&str>) {
    if !year.is_empty() {
        value["publishedYear"] = year.into();
    }
    if !tags.is_empty() {
        value["keywords"] = tags.join(", ").into();
    }
    if !genres.is_empty() {
        value["genres"] = json!(genres);
    }
}

fn response(status: &str, text: &str) -> Value {
    json!({"annotation":text,"annotationStatus":status,"annotationLimited":status=="limited"})
}
