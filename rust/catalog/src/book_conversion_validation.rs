use std::borrow::Cow;
use std::fs::File;
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::LazyLock;
use std::time::Instant;

use encoding_rs::{UTF_16BE, UTF_16LE};
use regex::{Captures, Regex};

use crate::Result;
use crate::epub_fb2::invalid;
use crate::epub_fb2_input::{MB, Source, reference};

fn is_text_entry(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".xhtml")
        || lower.ends_with(".html")
        || lower.ends_with(".htm")
        || lower.ends_with(".xml")
        || lower.ends_with(".opf")
        || lower.ends_with(".ncx")
        || lower.ends_with(".svg")
        || lower.ends_with(".css")
        || lower.ends_with(".smil")
        || lower.ends_with(".js")
        || lower.ends_with(".mjs")
        || lower.ends_with(".txt")
}

fn decode_entry_text<'a>(name: &str, contents: &'a [u8]) -> Option<Cow<'a, str>> {
    if contents.starts_with(&[0xff, 0xfe]) {
        return Some(UTF_16LE.decode_without_bom_handling(&contents[2..]).0);
    }
    if contents.starts_with(&[0xfe, 0xff]) {
        return Some(UTF_16BE.decode_without_bom_handling(&contents[2..]).0);
    }
    if let [b'<', 0, _, 0, ..] = contents {
        return Some(UTF_16LE.decode_without_bom_handling(contents).0);
    }
    if let [0, b'<', 0, ..] = contents {
        return Some(UTF_16BE.decode_without_bom_handling(contents).0);
    }
    if let Ok(text) = std::str::from_utf8(contents) {
        return Some(Cow::Borrowed(text));
    }
    if is_text_entry(name) {
        return Some(String::from_utf8_lossy(contents));
    }
    None
}

pub(super) fn epub(file: &Path, deadline: Instant) -> Result<()> {
    static ATTRIBUTE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r#"(?i)\b((?:[\w-]+:)?(?:href|src|full-path|poster|data|action|formaction))\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>\x60=]+))"#).unwrap()
    });
    static SRCSET: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r#"(?i)\bsrcset\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>\x60=]+))"#).unwrap()
    });
    static UNSAFE_MARKUP: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r#"(?i)<!ENTITY|<!DOCTYPE[^>]*\bSYSTEM\b|\bxml:base\s*=|<\s*script\b|http-equiv\s*=\s*["']?\s*refresh\b"#).unwrap()
    });
    static COMMENTS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)/\*.*?\*/").unwrap());
    static ESCAPES: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"\\([0-9a-fA-F]{1,6})[ \t\r\n\x0c]?|\\([^\r\n])").unwrap());
    static CSS_URL: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(
            r#"(?i)url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)|@import\s+(?:"([^"]*)"|'([^']*)')"#,
        )
        .unwrap()
    });

    let mut source = Source::open_limited(BufReader::new(File::open(file)?), 512 * MB)?;
    if !source.has("META-INF/container.xml") {
        return Err(invalid("отсутствует META-INF/container.xml"));
    }
    let names = source.names().map(str::to_owned).collect::<Vec<_>>();
    for name in names {
        super::remaining(deadline)?;
        check_components(&name)?;
        let contents = source.read(&name, 64 * MB)?;
        let Some(text) = decode_entry_text(&name, &contents) else {
            continue;
        };
        let text = text.as_ref();
        if UNSAFE_MARKUP.is_match(text) {
            return Err(invalid(
                "недопустимые XML entities, скрипты или внешние ссылки",
            ));
        }
        let anchor_spans = anchor_tag_spans(text);
        for matched in ATTRIBUTE.captures_iter(text) {
            let value = (2..=4)
                .find_map(|index| matched.get(index))
                .expect("matched attribute");
            let attr_match = matched.get(0).expect("matched attribute span");
            let from = if matched[1].eq_ignore_ascii_case("full-path") {
                ""
            } else {
                &name
            };
            let allow_http = matched[1].eq_ignore_ascii_case("href")
                && span_contains(&anchor_spans, attr_match.start(), attr_match.end());
            check_reference(from, value.as_str(), allow_http)?;
        }
        for matched in SRCSET.captures_iter(text) {
            let value = (1..=3)
                .find_map(|index| matched.get(index))
                .expect("matched srcset");
            for candidate in value.as_str().split(',') {
                if let Some(url) = candidate.split_whitespace().next() {
                    check_reference(&name, url, false)?;
                }
            }
        }
        let css = html_escape::decode_html_entities(text);
        let css = COMMENTS.replace_all(&css, "");
        let css = ESCAPES.replace_all(&css, |matched: &Captures<'_>| {
            if let Some(hex) = matched.get(1) {
                let value = u32::from_str_radix(hex.as_str(), 16).expect("matched CSS hex");
                char::from_u32(value)
                    .unwrap_or(char::REPLACEMENT_CHARACTER)
                    .to_string()
            } else {
                matched[2].to_owned()
            }
        });
        for matched in CSS_URL.captures_iter(&css) {
            let value = (1..=5)
                .find_map(|index| matched.get(index))
                .expect("matched CSS URL");
            check_reference(&name, value.as_str(), false)?;
        }
    }
    Ok(())
}

pub(super) fn fb2(file: &Path) -> Result<()> {
    static UNSAFE_XML: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?i)<!ENTITY|<!DOCTYPE[^>]*\bSYSTEM\b|\bxml:base\s*=").unwrap()
    });
    let mut head = Vec::new();
    File::open(file)?.take(512 * 1024).read_to_end(&mut head)?;
    if let Some(text) = decode_entry_text("book.fb2.xml", &head)
        && UNSAFE_XML.is_match(text.as_ref())
    {
        return Err(invalid("недопустимые XML entities или xml:base в FB2"));
    }
    Ok(())
}

fn check_components(name: &str) -> Result<()> {
    for segment in name.split('/') {
        let stem = segment
            .split('.')
            .next()
            .unwrap_or_default()
            .to_ascii_lowercase();
        let reserved = matches!(stem.as_str(), "con" | "prn" | "aux" | "nul")
            || stem.len() == 4
                && (stem.starts_with("com") || stem.starts_with("lpt"))
                && matches!(stem.as_bytes()[3], b'1'..=b'9');
        if segment.ends_with(['.', ' ']) || reserved {
            return Err(invalid("недопустимый путь внутри EPUB"));
        }
    }
    Ok(())
}

fn anchor_tag_spans(text: &str) -> Vec<std::ops::Range<usize>> {
    let bytes = text.as_bytes();
    let mut spans = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        let Some(rel) = bytes[i..].iter().position(|&b| b == b'<') else {
            break;
        };
        i += rel;
        let rest = &bytes[i..];
        if rest.starts_with(b"<!--") {
            let Some(end) = rest[4..].windows(3).position(|w| w == b"-->") else {
                break;
            };
            i += 4 + end + 3;
            continue;
        }
        if rest.starts_with(b"<![CDATA[") {
            let Some(end) = rest[9..].windows(3).position(|w| w == b"]]>") else {
                break;
            };
            i += 9 + end + 3;
            continue;
        }
        if rest.starts_with(b"<?") {
            let Some(end) = rest[2..].windows(2).position(|w| w == b"?>") else {
                break;
            };
            i += 2 + end + 2;
            continue;
        }
        if rest.starts_with(b"<!") {
            let Some(end) = rest[2..].iter().position(|&b| b == b'>') else {
                break;
            };
            i += 2 + end + 1;
            continue;
        }
        if rest.get(1) == Some(&b'/') {
            let Some(end) = rest[2..].iter().position(|&b| b == b'>') else {
                break;
            };
            i += 2 + end + 1;
            continue;
        }
        let name_start = i + 1;
        let mut name_end = name_start;
        while name_end < bytes.len()
            && (bytes[name_end].is_ascii_alphanumeric()
                || matches!(bytes[name_end], b'-' | b'_' | b':'))
        {
            name_end += 1;
        }
        if name_end == name_start {
            i += 1;
            continue;
        }
        let tag_name = &text[name_start..name_end];
        let is_style = tag_name.eq_ignore_ascii_case("style");
        let is_anchor = (tag_name.eq_ignore_ascii_case("a")
            || tag_name.eq_ignore_ascii_case("xhtml:a"))
            && bytes
                .get(name_end)
                .is_some_and(|b| matches!(b, b' ' | b'\t' | b'\r' | b'\n' | b'\x0c'));
        let mut j = name_end;
        let mut quote: Option<u8> = None;
        let mut saw_lt = false;
        let mut closed = false;
        while j < bytes.len() {
            let b = bytes[j];
            if let Some(q) = quote {
                if b == b'<' {
                    saw_lt = true;
                }
                if b == q {
                    quote = None;
                }
                j += 1;
                continue;
            }
            match b {
                b'"' | b'\'' => {
                    quote = Some(b);
                    j += 1;
                }
                b'<' => {
                    saw_lt = true;
                    break;
                }
                b'>' => {
                    closed = true;
                    break;
                }
                _ => j += 1,
            }
        }
        if quote.is_some() {
            // Unterminated quote: stop collecting anchor spans (fail closed).
            break;
        }
        if !closed {
            i = j;
            continue;
        }
        if is_anchor && !saw_lt {
            spans.push(name_end..j);
        }
        i = j + 1;
        if is_style {
            let tail = &bytes[i..];
            let Some(end) = tail
                .windows(8)
                .position(|w| w.eq_ignore_ascii_case(b"</style>"))
            else {
                break;
            };
            i += end + 8;
        }
    }
    spans
}

fn span_contains(spans: &[std::ops::Range<usize>], start: usize, end: usize) -> bool {
    let idx = spans.partition_point(|span| span.end <= start);
    spans
        .get(idx)
        .is_some_and(|span| span.start <= start && end <= span.end)
}

fn check_reference(from: &str, value: &str, allow_http: bool) -> Result<()> {
    let mut value = html_escape::decode_html_entities(value.trim()).into_owned();
    for _ in 0..3 {
        if value.is_empty() || value.starts_with('#') {
            break;
        }
        let resolved = reference(from, &value)?;
        if let Some(external) = resolved.external {
            let scheme = external
                .split_once(':')
                .map(|(name, rest)| (name.to_ascii_lowercase(), rest));
            match scheme.as_ref().map(|(s, r)| (s.as_str(), *r)) {
                Some(("http" | "https", _)) if allow_http => break,
                Some(("mailto" | "tel", _)) => break,
                Some(("data", rest)) => {
                    let mime = rest
                        .split([';', ','])
                        .next()
                        .unwrap_or_default()
                        .trim()
                        .to_ascii_lowercase();
                    if matches!(
                        mime.as_str(),
                        "image/png" | "image/jpeg" | "image/jpg" | "image/gif" | "image/webp"
                    ) {
                        break;
                    }
                    return Err(invalid("недопустимый data-URI в EPUB"));
                }
                _ => return Err(invalid("внешняя или абсолютная ссылка в EPUB запрещена")),
            }
        }
        if let Some(path) = resolved.file {
            check_components(&path)?;
        }
        // Recheck encoded separators if an external reader decodes twice.
        let decoded = percent_encoding::percent_decode_str(&value)
            .decode_utf8()
            .map_err(|_| invalid("повреждённая ссылка на ресурс"))?;
        if decoded == value {
            break;
        }
        value = decoded.into_owned();
    }
    Ok(())
}

fn read_at(file: &mut File, offset: u64, length: usize) -> Result<Vec<u8>> {
    file.seek(SeekFrom::Start(offset))?;
    let mut bytes = vec![0; length];
    file.read_exact(&mut bytes)?;
    Ok(bytes)
}

fn u16_at(bytes: &[u8], index: usize) -> Option<usize> {
    Some(u16::from_be_bytes(bytes.get(index..index + 2)?.try_into().ok()?).into())
}

fn u32_at(bytes: &[u8], index: usize) -> Option<usize> {
    Some(u32::from_be_bytes(bytes.get(index..index + 4)?.try_into().ok()?) as usize)
}

pub(super) fn mobi(file: &Path) -> Result<()> {
    let invalid = || "Конвертер не создал корректный MOBI7/KF8 файл";
    let mut file = File::open(file)?;
    let size = usize::try_from(file.metadata()?.len())?;
    let header = read_at(&mut file, 0, 78)?;
    let count = u16_at(&header, 76)
        .filter(|count| *count >= 4)
        .ok_or_else(invalid)?;
    if header.get(60..68) != Some(b"BOOKMOBI") {
        return Err(invalid().into());
    }
    let table = read_at(&mut file, 78, count * 8)?;
    let offsets = table
        .as_chunks::<8>()
        .0
        .iter()
        .map(|record| u32_at(record, 0).expect("record offset"))
        .collect::<Vec<_>>();
    if offsets[0] < 78 + table.len()
        || offsets[count - 1] >= size
        || offsets.windows(2).any(|pair| pair[0] >= pair[1])
    {
        return Err(invalid().into());
    }
    let length = offsets[1] - offsets[0];
    if !(264..=1024 * 1024).contains(&length) {
        return Err(invalid().into());
    }
    let first = read_at(&mut file, offsets[0] as u64, length)?;
    let text_records = u16_at(&first, 8)
        .filter(|count| *count > 0)
        .ok_or_else(invalid)?;
    if first.get(16..20) != Some(b"MOBI")
        || u32_at(&first, 36) != Some(6)
        || u32_at(&first, 28) != Some(65001)
        || u32_at(&first, 4) == Some(0)
    {
        return Err(invalid().into());
    }
    let exth = u32_at(&first, 20)
        .and_then(|size| 16_usize.checked_add(size))
        .filter(|size| *size <= length - 12)
        .ok_or_else(invalid)?;
    if first.get(exth..exth + 4) != Some(b"EXTH") {
        return Err(invalid().into());
    }
    let end = u32_at(&first, exth + 4)
        .and_then(|size| exth.checked_add(size))
        .filter(|end| (exth + 12..=length).contains(end))
        .ok_or_else(invalid)?;
    let mut position = exth + 12;
    let mut kf8 = None;
    for _ in 0..u32_at(&first, exth + 8).expect("EXTH record count") {
        if position + 8 > end {
            return Err(invalid().into());
        }
        let size = u32_at(&first, position + 4)
            .filter(|size| (8..=end - position).contains(size))
            .ok_or_else(invalid)?;
        if u32_at(&first, position) == Some(121) && size == 12 {
            kf8 = u32_at(&first, position + 8);
        }
        position += size;
    }
    let kf8 = kf8
        .filter(|number| *number > text_records + 1 && *number < count)
        .ok_or_else(invalid)?;
    if offsets[kf8] - offsets[kf8 - 1] < 8
        || offsets.get(kf8 + 1).copied().unwrap_or(size) - offsets[kf8] < 40
        || read_at(&mut file, offsets[kf8 - 1] as u64, 8)? != b"BOUNDARY"
    {
        return Err(invalid().into());
    }
    let second = read_at(&mut file, offsets[kf8] as u64, 40)?;
    if second.get(16..20) != Some(b"MOBI") || u32_at(&second, 36) != Some(8) {
        return Err(invalid().into());
    }
    Ok(())
}

pub(super) fn pdf(file: &Path) -> Result<()> {
    let mut magic = [0; 5];
    File::open(file)?.read_exact(&mut magic)?;
    if &magic != b"%PDF-" {
        return Err("Конвертер не создал корректный PDF".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::io::Write;
    use std::time::Duration;

    use tempfile::NamedTempFile;
    use zip::ZipWriter;
    use zip::write::SimpleFileOptions;

    use super::*;

    fn write_epub(body: &str) -> NamedTempFile {
        let file = NamedTempFile::new().unwrap();
        let mut zip = ZipWriter::new(file.reopen().unwrap());
        let opts = SimpleFileOptions::default();
        zip.start_file("mimetype", opts).unwrap();
        zip.write_all(b"application/epub+zip").unwrap();
        zip.start_file("META-INF/container.xml", opts).unwrap();
        zip.write_all(
            br#"<container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>"#,
        )
        .unwrap();
        zip.start_file("OPS/book.opf", opts).unwrap();
        zip.write_all(br#"<package><manifest><item href="Text/book.xhtml"/></manifest></package>"#)
            .unwrap();
        zip.start_file("OPS/Text/book.xhtml", opts).unwrap();
        zip.write_all(body.as_bytes()).unwrap();
        zip.finish().unwrap();
        file
    }

    #[test]
    fn epub_allows_http_hyperlinks_on_anchors() {
        let valid = r##"<html><head><link href="../Styles/book.css"/></head><body>
            <a href="#note">Примечание</a>
            <a href="https://example.org/book?a=1&amp;b=2">Внешняя ссылка</a>
            <A class="ext" title="a > b" HREF='http://example.org/info'>HTTP</A>
            <a href="mailto:user@example.org">Mail</a>
            <img src="../Images/cover.png"/>
        </body></html>"##;
        let file = write_epub(valid);
        let deadline = Instant::now() + Duration::from_secs(10);
        epub(file.path(), deadline).expect("valid EPUB with anchor http/https links should pass");
    }

    #[test]
    fn epub_blocks_http_on_resource_attributes_elements_and_css() {
        let deadline = Instant::now() + Duration::from_secs(10);
        for blocked in [
            r#"<html><body><img src="https://evil.example/img.png"/></body></html>"#,
            r#"<html><body><img srcset="https://evil.example/img.png 2x"/></body></html>"#,
            r#"<html><head><link rel="stylesheet" href="https://evil.example/a.css"/></head></html>"#,
            r#"<html><head><base href="https://evil.example/"/></head></html>"#,
            r#"<html><body><video poster="https://evil.example/p.png"></video></body></html>"#,
            r#"<html><body><object data="https://evil.example/o.svg"></object></body></html>"#,
            r#"<html><body><form action="https://evil.example/post"></form></body></html>"#,
            r#"<html><body><button formaction="https://evil.example/post"></button></body></html>"#,
            r#"<html><body><svg><image href="https://evil.example/i.png"/></svg></body></html>"#,
            r#"<html><body><svg><use xlink:href="https://evil.example/s.svg#id"/></svg></body></html>"#,
            r#"<html><head><style>body { background: url(https://evil.example/bg.png); }</style></head></html>"#,
            r#"<html><head><style>@import "https://evil.example/a.css";</style></head></html>"#,
            r#"<html><body><a href="javascript:alert(1)">js</a></body></html>"#,
            r#"<html><body><a href="file:///etc/passwd">file</a></body></html>"#,
            r#"<html><body><a href="//evil.example/proto-rel">rel</a></body></html>"#,
            r#"<html><body><a href="https://ok.example">ok</a><link href="https://evil.example/a.css"/></body></html>"#,
            r#"<html><body><link title="<a " href="https://evil.example/a.css"/></body></html>"#,
            r#"<html><head><style>/* <a ' */</style><link href="https://evil.example/a.css"/>'</head></html>"#,
            r#"<html><body><a href="https://ok.example" style="background:url(https://evil.example/bg.png)">ok</a></body></html>"#,
        ] {
            let file = write_epub(blocked);
            assert!(
                epub(file.path(), deadline).is_err(),
                "expected EPUB validation to reject: {blocked}"
            );
        }
    }
}
