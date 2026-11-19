use std::fs::File;
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::LazyLock;
use std::time::Instant;

use regex::{Captures, Regex};

use crate::Result;
use crate::epub_fb2::invalid;
use crate::epub_fb2_input::{MB, Source, reference};

pub(super) fn epub(file: &Path, deadline: Instant) -> Result<()> {
    static ATTRIBUTE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r#"(?i)\b((?:[\w-]+:)?(?:href|src|full-path|poster|data))\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>\x60=]+))"#).unwrap()
    });
    static ENTITY: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)<!ENTITY|\bxml:base\s*=").unwrap());
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
        let Ok(text) = std::str::from_utf8(&contents) else {
            continue;
        };
        if ENTITY.is_match(text) {
            return Err(invalid("недопустимые XML entities или xml:base"));
        }
        for matched in ATTRIBUTE.captures_iter(text) {
            let value = (2..=4)
                .find_map(|index| matched.get(index))
                .expect("matched attribute");
            let from = if matched[1].eq_ignore_ascii_case("full-path") {
                ""
            } else {
                &name
            };
            check_reference(from, value.as_str())?;
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
            check_reference(&name, value.as_str())?;
        }
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

fn check_reference(from: &str, value: &str) -> Result<()> {
    let mut value = html_escape::decode_html_entities(value.trim()).into_owned();
    for _ in 0..3 {
        if value.is_empty() || value.starts_with('#') {
            break;
        }
        let resolved = reference(from, &value)?;
        if let Some(external) = resolved.external {
            let scheme = external
                .split_once(':')
                .map(|(name, _)| name.to_ascii_lowercase());
            if matches!(
                scheme.as_deref(),
                Some("http" | "https" | "mailto" | "tel" | "data")
            ) {
                break;
            }
            return Err(invalid("абсолютная ссылка на файл в EPUB"));
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
