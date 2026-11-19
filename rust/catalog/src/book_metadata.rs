use std::collections::HashSet;
use std::io::{BufRead, BufReader, Cursor, Read, Seek};
use std::sync::LazyLock;

use flate2::bufread::MultiGzDecoder;
use regex::Regex;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::book_archive::{Directory, Failure};
use crate::epub_fb2_input::{Child, Node, parse_xml};
use crate::fb2_prepare::{decode, js_space};
use crate::isbn;

pub(crate) const FB2_PREFIX: u64 = 2 * 1024 * 1024;
const EPUB_CONTAINER: &str = "META-INF/container.xml";
const EPUB_CONTAINER_BYTES: u64 = 1024 * 1024;
const EPUB_PACKAGE_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Format {
    Fb2,
    Epub,
    #[serde(rename = "folderFb2")]
    FolderFb2,
}

pub(crate) fn read_stream(
    format: &Format,
    size: u64,
    reader: &mut dyn Read,
    limit: u64,
    isbn_only: bool,
) -> Result<Value, Failure> {
    if isbn_only && size > limit {
        return Err(Failure::Limit);
    }
    match format {
        Format::Fb2 => read_fb2(
            BufReader::with_capacity(if isbn_only { 1024 } else { 16 * 1024 }, reader),
            limit,
            isbn_only,
        ),
        Format::FolderFb2 => crate::folder_fb2::read(reader, limit),
        Format::Epub => {
            if size > limit {
                return Err(Failure::Unsupported);
            }
            let data = bounded(size, limit, reader)?;
            read_epub(Cursor::new(data), isbn_only)
        }
    }
}

pub(crate) fn read_fb2(
    mut reader: impl BufRead,
    limit: u64,
    isbn_only: bool,
) -> Result<Value, Failure> {
    static END: LazyLock<regex::bytes::Regex> =
        LazyLock::new(|| regex::bytes::Regex::new(r"(?i-u)</description\s*>").unwrap());
    let limit = limit.min(FB2_PREFIX);
    let parse = |text: &str| {
        let doc = document(text.as_bytes())?;
        doc.children
            .into_iter()
            .find_map(|item| match item {
                Child::Element(node) => Some(node),
                Child::Text(_) => None,
            })
            .ok_or(Failure::Unsupported)
    };
    let description = if reader.fill_buf()?.starts_with(b"\x1f\x8b") {
        read_description(MultiGzDecoder::new(reader), limit, &END, parse)?
    } else {
        read_description(reader, limit, &END, parse)?
    };
    let Some(description) = description else {
        return Ok(empty(isbn_only));
    };
    let title = child(&description, "title-info");
    let publication = child(&description, "publish-info");
    let number = field(publication, "isbn");
    if isbn_only {
        return Ok(json!(isbn::extract(&number)));
    }
    let mut annotation = String::new();
    if let Some(node) = title.and_then(|node| child(node, "annotation")) {
        append_annotation(node, &mut annotation);
    }
    let tags = field(title, "keywords");
    let tags: Vec<_> = tags
        .split([',', ';'])
        .map(|value| value.trim_matches(js_space))
        .filter(|value| !value.is_empty())
        .collect();
    Ok(json!({
        "description": clean_plain(&annotation),
        "publisher": field(publication,"publisher"), "publishedYear":field(publication,"year"),
        "isbn":number, "language":field(title,"lang"), "tags":tags,
    }))
}

pub(crate) fn read_description<T>(
    mut reader: impl Read,
    limit: u64,
    end_tag: &regex::bytes::Regex,
    parse: impl FnOnce(&str) -> Result<T, Failure>,
) -> Result<Option<T>, Failure> {
    static START: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)<description\b").unwrap());
    let mut bytes = Vec::with_capacity(16 * 1024);
    let mut position = 0_usize;
    while (bytes.len() as u64) < limit {
        // Most descriptions fit near the start. Avoid inflating 16 KiB of book
        // text just to read a short header from a PPMd stream.
        let chunk = (bytes.len() as u64).clamp(1024, 16 * 1024);
        let count = reader
            .by_ref()
            .take((limit - bytes.len() as u64).min(chunk))
            .read_to_end(&mut bytes)?;
        let utf16 = matches!(
            &bytes[..],
            [0xff, 0xfe, ..] | [0xfe, 0xff, ..] | [b'<', 0, _, 0, ..] | [0, b'<', 0, ..]
        );
        // Search only the newly read bytes and the boundary with the prior chunk.
        let end = end_tag
            .find_at(&bytes, position.saturating_sub(22))
            .map(|m| m.end());
        if utf16 || end.is_some() {
            let content = trim_incomplete_utf8(&bytes[..end.unwrap_or(bytes.len())]);
            let text = decode(content).ok_or(Failure::Unsupported)?;
            if let Some(end) = end_tag.find(text.as_bytes())
                && let Some(start) = START.find(&text[..end.start()])
            {
                return parse(&text[start.start()..end.end()]).map(Some);
            }
        }
        if count == 0 {
            break;
        }
        position = bytes.len();
    }
    Ok(None)
}

pub(crate) fn trim_incomplete_utf8(bytes: &[u8]) -> &[u8] {
    if let Err(error) = std::str::from_utf8(bytes)
        && error.error_len().is_none()
    {
        return &bytes[..error.valid_up_to()];
    }
    bytes
}

pub(crate) fn read_epub(
    mut reader: impl BufRead + Seek,
    isbn_only: bool,
) -> Result<Value, Failure> {
    let seven_zip = reader.fill_buf()?.starts_with(b"7z\xbc\xaf\x27\x1c");
    let mut archive = Directory::open(reader, seven_zip)?;
    let Some(container) = archive.find_file(|name| {
        name.get(name.len().saturating_sub(EPUB_CONTAINER.len())..)
            .is_some_and(|suffix| {
                suffix.eq_ignore_ascii_case(EPUB_CONTAINER)
                    && (suffix.len() == name.len()
                        || name.as_bytes()[name.len() - suffix.len() - 1] == b'/')
            })
    }) else {
        return Ok(empty(isbn_only));
    };
    let container_doc = archive.read(&container, None, |size, entry| {
        document(&bounded(size, EPUB_CONTAINER_BYTES, entry)?)
    })?;
    let Some(root) = container_doc.all("rootfile").into_iter().next() else {
        return Ok(empty(isbn_only));
    };
    let package = root.attr("full-path");
    if package.is_empty() {
        return Ok(empty(isbn_only));
    }
    let prefix = &container[..container.len() - EPUB_CONTAINER.len()];
    let path = match lookup_path(prefix, package) {
        Some(value) => value,
        None => return Ok(empty(isbn_only)),
    };
    let package = match archive.read(&path, None, |size, entry| {
        document(&bounded(size, EPUB_PACKAGE_BYTES, entry)?)
    }) {
        Ok(package) => package,
        Err(Failure::Missing | Failure::InvalidType) => return Ok(empty(isbn_only)),
        Err(error) => return Err(error),
    };
    let Some(metadata) = package.all("metadata").into_iter().next() else {
        return Ok(empty(isbn_only));
    };
    let identifiers: Vec<_> = metadata
        .elements()
        .filter(|node| node.name == "identifier")
        .collect();
    let mut seen = HashSet::new();
    let isbns: Vec<_> = identifiers
        .iter()
        .flat_map(|node| isbn::extract(&clean_plain(first_text(node))))
        .filter(|key| seen.insert(key.clone()))
        .collect();
    if isbn_only {
        return Ok(json!(isbns));
    }
    let values = |name: &str| {
        metadata
            .elements()
            .filter(|node| node.name == name)
            .map(first_text)
            .filter(|value| !value.is_empty())
            .collect::<Vec<_>>()
    };
    let first = |name: &str| clean_plain(values(name).first().copied().unwrap_or(""));
    let isbn = identifiers
        .iter()
        .map(|node| (node.attr("opf:scheme"), first_text(node)))
        .find_map(|(scheme, value)| {
            if let Some(prefix) = value.get(..9)
                && prefix.eq_ignore_ascii_case("urn:isbn:")
            {
                return Some(clean_plain(&value[9..]));
            }
            scheme
                .to_ascii_lowercase()
                .contains("isbn")
                .then(|| clean_plain(value))
        })
        .unwrap_or_default();
    static YEAR: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?-u:\b)[0-9]{4}(?-u:\b)").unwrap());
    let date = values("date").first().copied().unwrap_or("");
    Ok(json!({
        "title":first("title"), "authors":values("creator").into_iter().map(clean_plain).collect::<Vec<_>>(),
        "description":clean_plain(&values("description").join("\n\n")),
        "publisher":first("publisher"), "publishedYear":YEAR.find(date).map_or("",|m|m.as_str()), "isbn":isbn,
        "isbns":isbns, "language":first("language"), "tags":values("subject").into_iter().map(clean_plain).collect::<Vec<_>>(),
    }))
}

pub(crate) fn bounded(size: u64, limit: u64, input: &mut dyn Read) -> Result<Vec<u8>, Failure> {
    if size > limit {
        return Err(Failure::Limit);
    }
    let mut bytes = Vec::with_capacity(size as usize);
    input
        .take(limit.saturating_add(1))
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(Failure::Limit);
    }
    if bytes.len() as u64 != size {
        return Err(std::io::Error::other("Неверный размер метаданных").into());
    }
    Ok(bytes)
}

fn lookup_path(prefix: &str, relative: &str) -> Option<String> {
    let mut parts = Vec::new();
    for part in prefix.split('/').chain(relative.split('/')) {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            _ => parts.push(part),
        }
    }
    Some(parts.join("/"))
}

fn document(data: &[u8]) -> Result<Node, Failure> {
    parse_xml(data)
        .map(|(doc, _)| doc)
        .map_err(|_| Failure::Unsupported)
}

fn empty(isbn_only: bool) -> Value {
    if isbn_only { json!([]) } else { json!({}) }
}

fn child<'a>(node: &'a Node, name: &str) -> Option<&'a Node> {
    node.elements().find(|node| node.name == name)
}

fn field(node: Option<&Node>, name: &str) -> String {
    node.and_then(|node| child(node, name))
        .map_or_else(String::new, |node| clean_plain(first_text(node)))
}

fn first_text(node: &Node) -> &str {
    node.children
        .iter()
        .find_map(|item| match item {
            Child::Text(value) => Some(value.as_str()),
            Child::Element(_) => None,
        })
        .unwrap_or("")
}

fn append_annotation(node: &Node, output: &mut String) {
    if matches!(
        node.name.as_str(),
        "br" | "empty-line" | "stanza" | "poem" | "table"
    ) {
        output.push('\n');
    }
    for child in &node.children {
        match child {
            Child::Text(value) => output.push_str(value),
            Child::Element(node) => append_annotation(node, output),
        }
    }
    if matches!(node.name.as_str(), "p" | "subtitle") {
        output.push('\n');
    }
}

fn clean_plain(value: &str) -> String {
    static BREAKS: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)<\s*(?:/p|br\s*/?)\s*>").unwrap());
    static MARKUP: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<[^>]*>").unwrap());
    static SPACE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[ \t]+").unwrap());
    static LINES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\n[\s\u{feff}]*\n+").unwrap());
    let value = BREAKS.replace_all(value, "\n");
    let value = MARKUP.replace_all(&value, "");
    let value = SPACE.replace_all(&value, " ");
    LINES
        .replace_all(&value, "\n\n")
        .trim_matches(js_space)
        .into()
}
