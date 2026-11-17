use std::io::{self, Cursor, ErrorKind, Read};

use quick_xml::{Reader as XmlReader, XmlVersion, events::Event};
use serde_json::Value;
use zip::ZipArchive;

use crate::Result;
use crate::book_archive::{AuditArchive, Failure};
use crate::book_delivery::Book;
use crate::library_sources::Source;
use crate::{book_source, fb2_prepare, gzip};

#[derive(Default)]
pub struct Reader(AuditArchive);

pub enum Outcome {
    Valid,
    Issue(&'static str, String),
}

impl Reader {
    pub fn check(
        &mut self,
        row: &Value,
        sources: &[Source],
        deep: bool,
        limit: u64,
        cancelled: impl Fn() -> bool,
    ) -> Result<Outcome> {
        let book: Book = serde_json::from_value(row.clone())?;
        let source = book.source(sources).ok_or("Источник книги недоступен")?;
        let extension = book.extension().ok_or("Некорректный формат книги")?;
        let format = extension.to_ascii_lowercase();
        let supported = matches!(format.as_str(), "fb2" | "epub");
        let result = book_source::resolve(
            &source.lib_dir,
            &book.folder,
            &format!("{}.{extension}", book.file),
        )
        .map_err(Failure::from)
        .and_then(|input| {
            self.0.check(input, deep && supported, |size, file| {
                validate(size, file, &format, limit, &cancelled)
            })
        });
        Ok(match result {
            Ok(_) if deep && !supported => Outcome::Issue(
                "skipped",
                "Проверка содержимого доступна для FB2 и EPUB".into(),
            ),
            Ok(_) => Outcome::Valid,
            Err(Failure::Missing) => Outcome::Issue("missing", "Архив или файл отсутствует".into()),
            Err(Failure::Limit) => {
                Outcome::Issue("skipped", "Превышен размер файла для проверки".into())
            }
            Err(Failure::Unsupported) => {
                Outcome::Issue("skipped", "Формат архива недоступен для проверки".into())
            }
            Err(Failure::Other(error))
                if error
                    .downcast_ref::<io::Error>()
                    .is_some_and(|error| error.kind() == ErrorKind::NotFound) =>
            {
                Outcome::Issue("missing", "Архив или файл отсутствует".into())
            }
            Err(error) => Outcome::Issue("damaged", error.to_string()),
        })
    }
}

fn validate(
    size: u64,
    file: &mut dyn Read,
    format: &str,
    limit: u64,
    cancelled: &impl Fn() -> bool,
) -> std::result::Result<(), Failure> {
    if size == 0 {
        return Err(Failure::Other("Файл книги пуст".into()));
    }
    if size > limit {
        return Err(Failure::Limit);
    }
    let mut bytes = Vec::new();
    let mut source = file.take(size + 1);
    let mut chunk = [0; 64 * 1024];
    loop {
        if cancelled() {
            return Err(Failure::Other("Проверка отменена".into()));
        }
        let len = source.read(&mut chunk)?;
        if len == 0 {
            break;
        }
        bytes.extend_from_slice(&chunk[..len]);
    }
    if bytes.len() as u64 != size {
        return Err(Failure::Other("Размер файла книги изменился".into()));
    }
    if format == "epub" {
        return validate_epub(&bytes, cancelled);
    }
    if bytes.starts_with(b"\x1f\x8b") {
        let mut decoded = Vec::new();
        if gzip::inflate(&bytes[..], &mut decoded, limit + 1)? > limit {
            return Err(Failure::Limit);
        }
        bytes = decoded;
    }
    xml(&bytes, "FictionBook", false, cancelled)?;
    Ok(())
}

fn validate_epub(bytes: &[u8], cancelled: &impl Fn() -> bool) -> std::result::Result<(), Failure> {
    let mut archive = ZipArchive::new(Cursor::new(bytes))?;
    let container = epub_entry(&mut archive, "META-INF/container.xml", 1024 * 1024)?;
    let package = xml(&container, "container", true, cancelled)?
        .filter(|path| {
            !path.is_empty()
                && !path.starts_with('/')
                && !path.contains(['\\', ':'])
                && !path.split('/').any(|part| part == "..")
        })
        .ok_or_else(|| Failure::Other("Пакет EPUB отсутствует".into()))?;
    let opf = epub_entry(&mut archive, &package, 4 * 1024 * 1024)?;
    xml(&opf, "package", false, cancelled)?;
    Ok(())
}

fn epub_entry(
    archive: &mut ZipArchive<Cursor<&[u8]>>,
    name: &str,
    limit: u64,
) -> std::result::Result<Vec<u8>, Failure> {
    let entry = archive
        .by_name(name)
        .map_err(|_| Failure::Other(format!("В EPUB отсутствует {name}").into()))?;
    if entry.is_dir() || entry.is_symlink() {
        return Err(Failure::InvalidType);
    }
    if entry.size() > limit {
        return Err(Failure::Limit);
    }
    let mut bytes = Vec::new();
    entry.take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(Failure::Limit);
    }
    Ok(bytes)
}

fn xml(
    bytes: &[u8],
    root: &str,
    find_package: bool,
    cancelled: &impl Fn() -> bool,
) -> std::result::Result<Option<String>, Failure> {
    let invalid = || Failure::Other("Некорректный XML книги".into());
    let text = fb2_prepare::decode(bytes).ok_or_else(invalid)?;
    let mut reader = XmlReader::from_str(text.trim_start_matches('\u{feff}'));
    let mut seen = false;
    let mut depth = 0_u32;
    let mut package = None;
    loop {
        if cancelled() {
            return Err(Failure::Other("Проверка отменена".into()));
        }
        let event = reader
            .read_event()
            .map_err(|error| Failure::Other(error.into()))?;
        match &event {
            Event::Start(tag) | Event::Empty(tag) => {
                if depth == 0 {
                    if seen || tag.local_name().as_ref() != root {
                        return Err(invalid());
                    }
                    seen = true;
                }
                for attr in tag.attributes() {
                    let attr = attr.map_err(|error| Failure::Other(error.into()))?;
                    let value = attr
                        .normalized_value(XmlVersion::Implicit1_0)
                        .map_err(|error| Failure::Other(error.into()))?;
                    if find_package
                        && tag.local_name().as_ref() == "rootfile"
                        && attr.key.as_ref() == "full-path"
                        && package.is_none()
                    {
                        package = Some(value.into_owned());
                    }
                }
                if matches!(event, Event::Start(_)) {
                    depth += 1;
                }
            }
            Event::End(_) => depth = depth.checked_sub(1).ok_or_else(invalid)?,
            Event::Text(text)
                if depth == 0 && !text.as_ref().as_bytes().iter().all(u8::is_ascii_whitespace) =>
            {
                return Err(invalid());
            }
            Event::Eof => break,
            _ => (),
        }
    }
    if !seen || depth != 0 {
        return Err(invalid());
    }
    Ok(package)
}
