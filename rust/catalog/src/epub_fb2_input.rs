use std::collections::{HashMap, HashSet};
use std::io::{Read, Seek, SeekFrom};
use std::sync::LazyLock;

use quick_xml::{
    Reader,
    events::{BytesStart, Event},
};
use regex::Regex;
use sha2::{Digest, Sha256};
use zip::ZipArchive;

use crate::Result;
use crate::epub_fb2::invalid;

pub(crate) const MB: u64 = 1024 * 1024;

#[derive(Clone)]
pub(crate) enum Child {
    Text(String),
    Element(Node),
}

#[derive(Clone)]
pub(crate) struct Node {
    pub name: String,
    pub children: Vec<Child>,
    pub index: usize,
    attrs: HashMap<String, String>,
}

impl Node {
    pub(crate) fn attr(&self, name: &str) -> &str {
        self.attrs.get(name).map_or("", String::as_str)
    }

    pub(crate) fn elements(&self) -> impl DoubleEndedIterator<Item = &Node> {
        self.children.iter().filter_map(Child::element)
    }

    pub(crate) fn all(&self, name: &str) -> Vec<&Node> {
        let mut output = Vec::new();
        let mut stack: Vec<_> = self.elements().rev().collect();
        while let Some(node) = stack.pop() {
            if name.is_empty() || node.name == name {
                output.push(node);
            }
            stack.extend(node.elements().rev());
        }
        output
    }

    pub(crate) fn text(&self) -> String {
        fn append(node: &Node, result: &mut String) {
            if node.name == "br" {
                result.push('\n');
            } else if !ignored(&node.name) {
                for child in &node.children {
                    match child {
                        Child::Text(value) => result.push_str(value),
                        Child::Element(node) => append(node, result),
                    }
                }
            }
        }
        let mut result = String::new();
        append(self, &mut result);
        result
    }

    pub(crate) fn plain(&self) -> String {
        fold_space(&self.text())
            .trim_matches(crate::fb2_prepare::js_space)
            .into()
    }
}

impl Child {
    pub(crate) fn element(&self) -> Option<&Node> {
        match self {
            Self::Element(node) => Some(node),
            Self::Text(_) => None,
        }
    }
}

pub(crate) fn ignored(name: &str) -> bool {
    matches!(
        name,
        "head" | "script" | "style" | "nav" | "noscript" | "iframe" | "object"
    )
}

pub(crate) fn words(value: &str) -> impl Iterator<Item = &str> {
    value
        .split(crate::fb2_prepare::js_space)
        .filter(|word| !word.is_empty())
}

pub(crate) fn fold_space(value: &str) -> String {
    let mut result = String::with_capacity(value.len());
    let mut whitespace = false;
    for ch in value.chars() {
        if crate::fb2_prepare::js_space(ch) {
            if !whitespace {
                result.push(' ');
            }
            whitespace = true;
        } else {
            result.push(ch);
            whitespace = false;
        }
    }
    result
}

pub(crate) fn esc(value: &str) -> String {
    let mut result = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '&' => result.push_str("&amp;"),
            '<' => result.push_str("&lt;"),
            '>' => result.push_str("&gt;"),
            '"' => result.push_str("&quot;"),
            '\'' => result.push_str("&apos;"),
            _ => result.push(ch),
        }
    }
    result
}

pub(crate) fn hash(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))[..24].to_owned()
}

fn decode_xml(data: &[u8]) -> Result<std::borrow::Cow<'_, str>> {
    static DECLARED: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r#"(?i)encoding\s*=\s*['"]([^'"]+)['"]"#).unwrap());
    if data.starts_with(&[0xff, 0xfe]) {
        return Ok(encoding_rs::UTF_16LE.decode_with_bom_removal(data).0);
    }
    if data.starts_with(&[0xfe, 0xff]) {
        return Ok(encoding_rs::UTF_16BE.decode_with_bom_removal(data).0);
    }
    let head = String::from_utf8_lossy(&data[..data.len().min(200)]);
    let declared = DECLARED.captures(&head).and_then(|found| found.get(1));
    if let Some(label) = declared {
        let label = label.as_str();
        let encoding = match label.to_ascii_lowercase().as_str() {
            "latin1" | "iso-8859-1" => {
                return Ok(data
                    .iter()
                    .map(|&byte| char::from(byte))
                    .collect::<String>()
                    .into());
            }
            "cp866" => Some(encoding_rs::IBM866),
            _ => encoding_rs::Encoding::for_label(label.as_bytes()),
        };
        if let Some(encoding) = encoding.filter(|value| *value != encoding_rs::UTF_8) {
            return Ok(encoding.decode_with_bom_removal(data).0);
        }
    }
    Ok(
        std::str::from_utf8(data.strip_prefix(b"\xef\xbb\xbf").unwrap_or(data))
            .map_err(|_| invalid("неподдерживаемая кодировка документа"))?
            .into(),
    )
}

pub(crate) fn parse_xml(data: &[u8]) -> Result<(Node, usize)> {
    static FORBIDDEN: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)<!ENTITY|\bxml:base\s*=").unwrap());
    static ENTITY: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)&([a-z][a-z\d]+);").unwrap());
    let decoded = decode_xml(data)?;
    if FORBIDDEN.is_match(&decoded) {
        return Err(invalid("XML entities и xml:base не поддерживаются"));
    }
    // Resolve named HTML references to XML numeric references without any DTD.
    let source = ENTITY.replace_all(&decoded, |capture: &regex::Captures<'_>| {
        let whole = &capture[0];
        if matches!(&capture[1], "amp" | "lt" | "gt" | "quot" | "apos") {
            return whole.to_owned();
        }
        let html = html_escape::decode_html_entities(whole);
        if html == whole {
            whole.to_owned()
        } else {
            html.chars().map(|ch| format!("&#{};", ch as u32)).collect()
        }
    });
    let mut reader = Reader::from_str(&source);
    let mut stack = vec![Node {
        name: "root".into(),
        children: Vec::new(),
        attrs: HashMap::new(),
        index: 0,
    }];
    let mut count = 0;
    let mut pending = String::new();
    let mut root_seen = false;
    loop {
        let event = reader
            .read_event()
            .map_err(|_| invalid("некорректный XML/XHTML"))?;
        match event {
            Event::Text(text) => {
                pending.push_str(text.as_ref());
                continue;
            }
            Event::GeneralRef(reference) => {
                if let Some(ch) = reference
                    .resolve_char_ref()
                    .map_err(|_| invalid("некорректный XML/XHTML"))?
                {
                    pending.push(ch);
                } else {
                    let entity = reference.as_ref();
                    let Some(value) = quick_xml::escape::resolve_predefined_entity(entity) else {
                        return Err(invalid("некорректный XML/XHTML"));
                    };
                    pending.push_str(value);
                }
                continue;
            }
            _ => {}
        }
        if !pending.is_empty() {
            if stack.len() == 1 && !pending.trim().is_empty() {
                return Err(invalid("некорректный XML/XHTML"));
            }
            append_text(
                stack.last_mut().expect("root node"),
                std::mem::take(&mut pending),
                tick(&mut count)?,
            );
        }
        match event {
            Event::Start(tag) => {
                open_root(&mut root_seen, stack.len())?;
                if stack.len() > 128 {
                    return Err(invalid("слишком глубокая вложенность документа"));
                }
                stack.push(element(&tag, tick(&mut count)?)?);
            }
            Event::Empty(tag) => {
                open_root(&mut root_seen, stack.len())?;
                if stack.len() > 128 {
                    return Err(invalid("слишком глубокая вложенность документа"));
                }
                stack
                    .last_mut()
                    .expect("root node")
                    .children
                    .push(Child::Element(element(&tag, tick(&mut count)?)?));
            }
            Event::End(_) => {
                if stack.len() == 1 {
                    return Err(invalid("некорректный XML/XHTML"));
                }
                let node = stack.pop().expect("element to close");
                stack
                    .last_mut()
                    .expect("parent node")
                    .children
                    .push(Child::Element(node));
            }
            Event::CData(text) if stack.len() > 1 => append_text(
                stack.last_mut().expect("element"),
                text.as_ref().to_owned(),
                tick(&mut count)?,
            ),
            Event::CData(_) => return Err(invalid("некорректный XML/XHTML")),
            Event::Eof => break,
            _ => {}
        }
    }
    if stack.len() != 1 || !root_seen {
        return Err(invalid("некорректный XML/XHTML"));
    }
    Ok((stack.pop().expect("root node"), count))
}

fn append_text(node: &mut Node, value: String, _index: usize) {
    if let Some(Child::Text(previous)) = node.children.last_mut() {
        previous.push_str(&value);
    } else {
        node.children.push(Child::Text(value));
    }
}

fn open_root(root_seen: &mut bool, depth: usize) -> Result<()> {
    if depth == 1 && std::mem::replace(root_seen, true) {
        return Err(invalid("некорректный XML/XHTML"));
    }
    Ok(())
}

fn tick(count: &mut usize) -> Result<usize> {
    *count += 1;
    if *count > 250000 {
        return Err(invalid("слишком много элементов документа"));
    }
    Ok(*count)
}

fn element(tag: &BytesStart<'_>, index: usize) -> Result<Node> {
    let local = tag.local_name();
    let name = local.as_ref().to_ascii_lowercase();
    let mut attrs = HashMap::new();
    for attr in tag.attributes() {
        let attr = attr.map_err(|_| invalid("некорректный XML/XHTML"))?;
        let key = attr.key.as_ref().to_ascii_lowercase();
        let value = quick_xml::escape::unescape(attr.value.as_ref())
            .map_err(|_| invalid("некорректный XML/XHTML"))?
            .into_owned();
        attrs.insert(key, value);
    }
    Ok(Node {
        name,
        children: Vec::new(),
        index,
        attrs,
    })
}

#[derive(Default)]
pub(crate) struct Reference {
    pub file: Option<String>,
    pub fragment: String,
    pub external: Option<String>,
}

pub(crate) fn reference(file: &str, value: &str) -> Result<Reference> {
    static SCHEME: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)^(?:[a-z][a-z\d+.-]*:|//)").unwrap());
    let value = value.trim_matches(crate::fb2_prepare::js_space);
    if SCHEME.is_match(value) {
        return Ok(Reference {
            external: Some(value.into()),
            ..Reference::default()
        });
    }
    let raw = value.split(['?', '#']).next().unwrap_or_default();
    let path = decode_percent(raw)?;
    let fragment = decode_percent(value.split_once('#').map_or("", |(_, fragment)| fragment))?;
    if path.starts_with('/')
        || path
            .bytes()
            .any(|byte| byte < 32 || matches!(byte, b':' | b'\\' | 127))
    {
        return Err(invalid("абсолютный путь к ресурсу"));
    }
    let path = if raw.is_empty() {
        file.to_owned()
    } else {
        let parent = file.rsplit_once('/').map_or("", |(parent, _)| parent);
        normalize_path(parent.split('/').chain(path.split('/')), true)?
    };
    Ok(Reference {
        file: Some(path),
        fragment,
        external: None,
    })
}

fn decode_percent(text: &str) -> Result<String> {
    let bytes = text.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut pos = 0;
    while pos < bytes.len() {
        if bytes[pos] != b'%' {
            decoded.push(bytes[pos]);
            pos += 1;
            continue;
        }
        let hex = bytes
            .get(pos + 1..pos + 3)
            .and_then(|hex| std::str::from_utf8(hex).ok())
            .filter(|hex| hex.bytes().all(|byte| byte.is_ascii_hexdigit()));
        let value = hex
            .and_then(|hex| u8::from_str_radix(hex, 16).ok())
            .ok_or_else(|| invalid("повреждённая ссылка на ресурс"))?;
        decoded.push(value);
        pos += 3;
    }
    String::from_utf8(decoded).map_err(|_| invalid("повреждённая ссылка на ресурс"))
}

fn normalize_path<'a>(parts: impl Iterator<Item = &'a str>, relative: bool) -> Result<String> {
    let mut path = Vec::new();
    for part in parts {
        match part {
            "" | "." => {}
            ".." if relative && path.pop().is_some() => {}
            ".." => return Err(invalid("недопустимый путь внутри книги")),
            _ => path.push(part),
        }
    }
    if path.is_empty() {
        return Err(invalid("недопустимый путь внутри книги"));
    }
    Ok(path.join("/"))
}

pub(crate) struct Source<R: Read + Seek> {
    zip: ZipArchive<R>,
    files: HashMap<String, (usize, u64)>,
}

impl<R: Read + Seek> Source<R> {
    pub(crate) fn open(reader: R) -> Result<Self> {
        Self::open_limited(reader, 256 * MB)
    }

    pub(crate) fn open_limited(mut reader: R, expanded_limit: u64) -> Result<Self> {
        let expected = archive_count(&mut reader)?;
        if expected.is_some_and(|count| count > 10000) {
            return Err(invalid("слишком много файлов или повторяющиеся имена"));
        }
        let mut zip = ZipArchive::new(reader).map_err(|_| invalid("некорректный ZIP EPUB"))?;
        if zip.len() > 10000 || expected.is_some_and(|count| count != zip.len()) {
            return Err(invalid("слишком много файлов или повторяющиеся имена"));
        }
        let mut expanded = 0;
        let mut names = HashSet::new();
        let mut files = HashMap::new();
        for i in 0..zip.len() {
            let entry = zip.by_index_raw(i)?;
            let name = entry.name().trim_end_matches('/');
            if name.starts_with('/')
                || name
                    .bytes()
                    .any(|byte| byte < 32 || matches!(byte, b'\\' | b':' | 127))
            {
                return Err(invalid("недопустимый путь внутри книги"));
            }
            let name = normalize_path(name.split('/'), false)?;
            if !names.insert(name.to_lowercase()) {
                return Err(invalid("повторяющийся путь"));
            }
            if entry.is_symlink() || entry.encrypted() {
                return Err(invalid("символическая ссылка или зашифрованный архив"));
            }
            expanded += entry.size().min(64 * MB + 1);
            if entry.size() > 64 * MB || expanded > expanded_limit {
                return Err(invalid("превышен распакованный размер книги"));
            }
            if !entry.is_dir() {
                files.insert(name, (i, entry.size()));
            }
        }
        Ok(Self { zip, files })
    }

    pub(crate) fn names(&self) -> impl Iterator<Item = &str> {
        self.files.keys().map(String::as_str)
    }

    pub(crate) fn has(&self, name: &str) -> bool {
        self.files.contains_key(name)
    }

    pub(crate) fn read(&mut self, name: &str, limit: u64) -> Result<Vec<u8>> {
        let (entry, size) = self.entry(name, limit)?;
        let mut data = Vec::with_capacity(size as usize);
        entry
            .take(limit + 1)
            .read_to_end(&mut data)
            .map_err(|_| invalid("неверная контрольная сумма ресурса"))?;
        if data.len() as u64 != size {
            return Err(invalid("неверный распакованный размер ресурса"));
        }
        Ok(data)
    }

    pub(crate) fn entry(&mut self, name: &str, limit: u64) -> Result<(impl Read + '_, u64)> {
        let Some(&(index, size)) = self.files.get(name) else {
            return Err(invalid(format!("не найден ресурс {name}")));
        };
        if size > limit {
            return Err(invalid("ресурс превышает допустимый размер"));
        }
        let entry = self
            .zip
            .by_index(index)
            .map_err(|_| invalid("некорректный ресурс ZIP EPUB"))?;
        Ok((entry, size))
    }

    pub(crate) fn document(&mut self, name: &str, limit: u64) -> Result<(Node, usize)> {
        let content = self.read(name, limit)?;
        let (parsed, nodes) = parse_xml(&content)?;
        Ok((
            parsed,
            content
                .len()
                .saturating_mul(2)
                .saturating_add(nodes.saturating_mul(160)),
        ))
    }
}

fn archive_count(reader: &mut (impl Read + Seek)) -> Result<Option<usize>> {
    let length = reader.seek(SeekFrom::End(0))?;
    let tail = length.min(65535 + 22);
    reader.seek(SeekFrom::Start(length - tail))?;
    let mut bytes = Vec::with_capacity(tail as usize);
    reader.take(tail).read_to_end(&mut bytes)?;
    let Some(offset) = (0..bytes.len().saturating_sub(21)).rev().find(|&offset| {
        if &bytes[offset..offset + 4] != b"PK\x05\x06" {
            return false;
        }
        let comment = u16::from_le_bytes([bytes[offset + 20], bytes[offset + 21]]);
        offset + 22 + usize::from(comment) == bytes.len()
    }) else {
        return Ok(None);
    };
    let count = u16::from_le_bytes(bytes[offset + 10..offset + 12].try_into()?);
    if count != u16::MAX {
        return Ok(Some(usize::from(count)));
    }
    let Some(locator) = offset
        .checked_sub(20)
        .filter(|&start| &bytes[start..start + 4] == b"PK\x06\x07")
    else {
        return Ok(None);
    };
    let location = u64::from_le_bytes(bytes[locator + 8..locator + 16].try_into()?);
    if location > length.saturating_sub(40) {
        return Ok(None);
    }
    reader.seek(SeekFrom::Start(location))?;
    let mut header = [0; 40];
    reader.read_exact(&mut header)?;
    if &header[..4] != b"PK\x06\x06" {
        return Ok(None);
    }
    Ok(Some(
        usize::try_from(u64::from_le_bytes(header[32..40].try_into()?)).unwrap_or(usize::MAX),
    ))
}
