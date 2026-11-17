use std::collections::HashSet;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use base64::{Engine, engine::general_purpose::STANDARD};
use quick_xml::{
    Reader,
    events::{BytesStart, Event},
};
use serde::{Serialize, Serializer};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::book_archive::Failure;
use crate::fb2_prepare::js_space;
use crate::{Result, book_cache};

#[path = "reader_speech.rs"]
mod speech;
pub use speech::{SpeechMode, SpeechPart, speech_anchor_key};

const MAX_BYTES: u64 = 500 * 1024 * 1024;
const GALLERY_LIMIT: usize = 18;
pub(crate) const IMAGE_LIMIT: usize = 2 * 1024 * 1024;
const GALLERY_BYTES: usize = 8 * 1024 * 1024;

enum Node {
    Element(Element),
    Text(u8, String),
}

impl Serialize for Node {
    fn serialize<S: Serializer>(&self, output: S) -> std::result::Result<S::Ok, S::Error> {
        match self {
            Self::Element(element) => element.serialize(output),
            Self::Text(kind, text) => (kind, text).serialize(output),
        }
    }
}

struct Element {
    name: String,
    attributes: Vec<(String, String)>,
    children: Vec<Node>,
}

#[derive(Serialize)]
struct ElementWire<'a>(u8, &'a str, Option<&'a [(String, String)]>, Children<'a>);

impl Serialize for Element {
    fn serialize<S: Serializer>(&self, output: S) -> std::result::Result<S::Ok, S::Error> {
        self.wire(None).serialize(output)
    }
}

impl Element {
    fn from_start(raw: &BytesStart<'_>) -> Result<Self> {
        let name = raw.name().as_ref().to_lowercase();
        let mut attributes = Vec::<(String, String)>::new();
        for attr in raw.attributes().with_checks(false) {
            let attr = attr?;
            let name = attr.key.as_ref().to_lowercase();
            let value = attr.value.replace(['\r', '\n', '\t'], " ");
            if let Some((_, current)) = attributes.iter_mut().find(|(key, _)| key == &name) {
                *current = value;
            } else {
                attributes.push((name, value));
            }
        }
        Ok(Self {
            name,
            attributes,
            children: Vec::new(),
        })
    }

    fn wire<'a>(&'a self, children: Option<Vec<&'a Node>>) -> ElementWire<'a> {
        let attrs = (!self.attributes.is_empty()).then_some(self.attributes.as_slice());
        let children = match children {
            Some(children) if children.is_empty() => Children::Empty,
            Some(children) => Children::Selected(children),
            None if self.children.is_empty() => Children::Empty,
            None => Children::All(&self.children),
        };
        ElementWire(1, &self.name, attrs, children)
    }

    fn children<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a Self> {
        self.children.iter().filter_map(move |child| match child {
            Node::Element(element) if element.name == name => Some(element),
            _ => None,
        })
    }

    fn child(&self, name: &str) -> Option<&Self> {
        match self
            .children
            .iter()
            .find(|child| matches!(child, Node::Element(element) if element.name == name))
        {
            Some(Node::Element(element)) => Some(element),
            _ => None,
        }
    }

    fn attr(&self, name: &str) -> &str {
        self.attributes
            .iter()
            .find(|(key, _)| key == name)
            .map_or("", |(_, value)| value)
    }

    fn text_chunks(&self, visit: &mut impl FnMut(&str)) {
        for node in &self.children {
            match node {
                Node::Text(2 | 3, text) => visit(text),
                Node::Element(child) => child.text_chunks(visit),
                _ => (),
            }
        }
    }

    fn summary(&self) -> String {
        let mut words = String::new();
        self.text_chunks(&mut |text| {
            for word in text.split(js_space).filter(|part| !part.is_empty()) {
                if !words.is_empty() {
                    words.push(' ');
                }
                words.push_str(word);
            }
        });
        words
    }
}

#[derive(Serialize)]
#[serde(untagged)]
enum Children<'a> {
    All(&'a [Node]),
    Selected(Vec<&'a Node>),
    Empty,
}

pub struct Document {
    root: Element,
}

impl Document {
    pub fn read(path: &Path) -> Result<Self> {
        let file = book_cache::regular_file(path, true)?.ok_or(Failure::Missing)?;
        let mut xml = String::new();
        file.take(MAX_BYTES + 1).read_to_string(&mut xml)?;
        if xml.len() as u64 > MAX_BYTES {
            return Err(Failure::Limit.into());
        }
        parse(&xml)
    }

    pub fn book_info(
        &self,
        mut book: Value,
        size: u64,
        version: &str,
        cover: &str,
        card: bool,
    ) -> Result<Value> {
        let selected = card.then(|| self.root.children.iter().filter(|node|
            !matches!(node, Node::Element(element) if matches!(element.name.as_str(), "body" | "binary")))
            .collect());
        let fb2 = serde_json::to_value([self.root.wire(selected)])?;
        if book["inpxSize"].is_null() && !book["size"].is_null() && book["size"] != size {
            book["inpxSize"] = book["size"].clone();
        }
        book["size"] = size.into();
        let mut response = json!({"bookInfo":{
            "book":book,"cover":cover,"contents":self.contents(),
            "annotationMeta":self.annotation(),"contentVersion":version,
            "galleryCount":self.images().count().min(GALLERY_LIMIT),
            "reviews":[],"libraryRating":null,"reviewsDeferred":card,
        }});
        response["bookInfo"]["fb2"] = fb2;
        Ok(response)
    }

    fn contents(&self) -> Vec<Value> {
        fn collect(section: &Element, level: usize, rows: &mut Vec<Value>) {
            if rows.len() >= 200 {
                return;
            }
            if let Some(title) = section
                .child("title")
                .map(Element::summary)
                .filter(|title| !title.is_empty())
            {
                rows.push(json!({"title":title,"level":level}));
            }
            for child in section.children("section") {
                collect(child, level + 1, rows);
            }
        }
        let mut rows = Vec::new();
        for body in self
            .root
            .children("body")
            .filter(|body| !body.attr("name").trim().eq_ignore_ascii_case("notes"))
        {
            for section in body.children("section") {
                collect(section, 0, &mut rows);
            }
        }
        rows
    }

    fn annotation(&self) -> Value {
        let mut letters = 0;
        let mut words = 0;
        let mut epigraph = Vec::new();
        let mut author = String::new();
        for body in self.root.children("body") {
            body.text_chunks(&mut |text| {
                for word in text.split(js_space).filter(|part| !part.is_empty()) {
                    words += 1;
                    letters += word.encode_utf16().count();
                }
            });
            for entry in body.children("epigraph") {
                epigraph.extend(
                    entry
                        .children("p")
                        .map(Element::summary)
                        .filter(|part| !part.is_empty())
                        .take(12usize.saturating_sub(epigraph.len())),
                );
                if author.is_empty() {
                    author = entry
                        .child("text-author")
                        .map(Element::summary)
                        .unwrap_or_default();
                }
            }
        }
        let pages = if words == 0 {
            0.0
        } else {
            ((words as f64 / 25.0).round() / 10.0).max(1.0)
        };
        let images = self
            .root
            .children("binary")
            .filter(|node| {
                node.attr("content-type")
                    .to_ascii_lowercase()
                    .starts_with("image/")
            })
            .count();
        json!({"epigraph":epigraph,"epigraphAuthor":author,"stats":{"letters":letters,"words":words,"pages":pages,"images":images}})
    }

    fn cover_id(&self) -> &str {
        let Some(image) = self
            .root
            .child("description")
            .and_then(|node| node.child("title-info"))
            .and_then(|node| node.child("coverpage"))
            .and_then(|node| node.child("image"))
        else {
            return "";
        };
        image
            .attributes
            .iter()
            .find(|(key, _)| key == "href" || key.ends_with(":href"))
            .map_or("", |(_, value)| value.strip_prefix('#').unwrap_or(value))
            .trim()
    }

    pub fn cover(&self) -> Option<Image> {
        let cover = self.cover_id();
        if cover.is_empty() {
            return None;
        }
        self.root
            .children("binary")
            .find(|node| node.attr("id") == cover)
            .and_then(decode_image)
    }

    fn images(&self) -> impl Iterator<Item = &Element> {
        let cover = self.cover_id();
        self.root.children("binary").filter(move |node| {
            let id = node.attr("id");
            let mime = node.attr("content-type").to_ascii_lowercase();
            !id.is_empty()
                && id != cover
                && id.encode_utf16().count() <= 128
                && !id
                    .chars()
                    .any(|c| c <= ' ' || "\u{7f}<>\u{22}'&\\".contains(c))
                && (mime.starts_with("image/") || mime == "application/octet-stream")
        })
    }

    pub fn gallery(&self) -> Value {
        let mut images = Vec::new();
        let mut seen = HashSet::new();
        let mut omitted = 0;
        let mut size = 0;
        for node in self.images() {
            let id = node.attr("id");
            if !seen.insert(id) {
                continue;
            }
            if seen.len() > GALLERY_LIMIT {
                omitted += 1;
                break;
            }
            if let Some(image) =
                decode_image(node).filter(|image| size + image.bytes.len() <= GALLERY_BYTES)
            {
                size += image.bytes.len();
                images.push(json!({"id":id,"contentType":image.content_type,"data":STANDARD.encode(&image.bytes)}));
            } else {
                omitted += 1;
            }
        }
        json!({"images":images,"limited":omitted>0,"omitted":omitted})
    }
}

pub struct Image {
    pub content_type: &'static str,
    pub bytes: Vec<u8>,
}

impl Image {
    pub(crate) fn from_bytes(bytes: Vec<u8>) -> Option<Self> {
        if bytes.len() > IMAGE_LIMIT {
            return None;
        }
        let content_type = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
            "image/png"
        } else if bytes.starts_with(b"\xff\xd8\xff") {
            "image/jpeg"
        } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
            "image/gif"
        } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
            "image/webp"
        } else {
            return None;
        };
        Some(Self {
            content_type,
            bytes,
        })
    }

    pub fn stage(&self, directory: &Path) -> Result<PathBuf> {
        let target = self.stage_path(directory);
        if book_cache::regular_file(&target, true)?.is_none() {
            let mut file = tempfile::NamedTempFile::new_in(directory)?;
            file.write_all(&self.bytes)?;
            match file.persist_noclobber(&target) {
                Ok(_) => (),
                Err(error)
                    if error.error.kind() == std::io::ErrorKind::AlreadyExists
                        && book_cache::regular_file(&target, true)?.is_some() => {}
                Err(error) => return Err(error.error.into()),
            }
        }
        Ok(target)
    }

    fn stage_path(&self, directory: &Path) -> PathBuf {
        let digest = crate::crypto_support::hex(&Sha256::digest(&self.bytes));
        directory.join(format!("{digest}.reader-cover"))
    }

    pub fn rebuild(&self, directory: &Path) -> Result<bool> {
        let target = self.stage_path(directory);
        let existed = book_cache::regular_file(&target, false)?.is_some();
        let mut staged = tempfile::NamedTempFile::new_in(directory)?;
        staged.write_all(&self.bytes)?;
        staged.persist(&target)?;
        Ok(existed)
    }
}

fn decode_image(node: &Element) -> Option<Image> {
    let maximum = IMAGE_LIMIT.div_ceil(3) * 4;
    let mut encoded = String::new();
    node.text_chunks(&mut |text| {
        if encoded.len() <= maximum {
            encoded.extend(
                text.chars()
                    .filter(|ch| !js_space(*ch))
                    .take(maximum + 1 - encoded.len()),
            );
        }
    });
    if encoded.len() > maximum {
        return None;
    }
    Image::from_bytes(STANDARD.decode(encoded).ok()?)
}

fn parse(xml: &str) -> Result<Document> {
    let mut reader = Reader::from_str(xml);
    let mut stack = Vec::<Element>::new();
    let mut root = None;
    let mut text_start = None;
    loop {
        let start = reader.buffer_position() as usize;
        let event = reader.read_event().map_err(|_| Failure::Unsupported)?;
        if matches!(event, Event::Text(_) | Event::GeneralRef(_)) {
            text_start.get_or_insert(start);
            continue;
        }
        if let Some(first) = text_start.take()
            && let Some(element) = stack.last_mut()
        {
            let text = &xml[first..start];
            if !text.trim_matches(js_space).is_empty() {
                element.children.push(Node::Text(2, text.to_owned()));
            }
        }
        match event {
            Event::Start(raw) => {
                if stack.len() >= 128 {
                    return Err(Failure::Limit.into());
                }
                stack.push(Element::from_start(&raw)?);
            }
            Event::Empty(raw) => attach(&mut root, &mut stack, Element::from_start(&raw)?)?,
            Event::End(_) => {
                let element = stack.pop().ok_or(Failure::Unsupported)?;
                attach(&mut root, &mut stack, element)?;
            }
            Event::CData(text) => {
                if let Some(parent) = stack.last_mut() {
                    parent.children.push(Node::Text(3, text.as_ref().into()));
                }
            }
            Event::Comment(text) => {
                if let Some(parent) = stack.last_mut() {
                    parent.children.push(Node::Text(4, text.as_ref().into()));
                }
            }
            Event::Eof => break,
            _ => (),
        }
    }
    let root = root
        .filter(|element| element.name == "fictionbook" && stack.is_empty())
        .ok_or(Failure::Unsupported)?;
    Ok(Document { root })
}

fn attach(root: &mut Option<Element>, stack: &mut [Element], element: Element) -> Result<()> {
    if let Some(parent) = stack.last_mut() {
        parent.children.push(Node::Element(element));
    } else if root.is_some() {
        return Err(Failure::Unsupported.into());
    } else {
        *root = Some(element);
    }
    Ok(())
}
