use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{self, Cursor, Read, Seek};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use flate2::read::MultiGzDecoder;
use serde_json::Value;

use crate::Result;
use crate::book_archive::{Directory, Failure, extract_input, input_directory};
use crate::book_conversion::{Queue, Tool, configured, run};
use crate::book_delivery::Book;
use crate::book_source::{cover_inputs, open_within, within};
use crate::directory_diagnostics::ordered_entries;
use crate::library_sources::Source;
use crate::reader_document::{Document, IMAGE_LIMIT, Image, fb2_cover};

const FB2_LIMIT: u64 = 64 * 1024 * 1024;

pub fn reader_lab_source(library: &Path, requested: &str) -> io::Result<File> {
    let trimmed = requested.trim();
    let name = Path::new(trimmed)
        .file_name()
        .filter(|name| {
            Path::new(name)
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("fb2"))
        })
        .ok_or(io::ErrorKind::NotFound)?;
    let root = library.canonicalize()?;
    let path = within(&root, root.join(name).canonicalize()?)?;
    open_within(&root, &path)
}

pub struct Covers {
    archives: Mutex<Option<Arc<Archives>>>,
    decoders: Queue,
    webp: Option<Tool>,
    jxl: Option<Tool>,
}

struct Archives {
    sources: Arc<Vec<Source>>,
    scanned: Instant,
    covers: Vec<Archive>,
    books: Vec<Archive>,
}

struct Archive {
    root: PathBuf,
    path: PathBuf,
    source: usize,
    from: u64,
    to: u64,
}

#[derive(Debug)]
pub struct MissingDecoder;

impl std::fmt::Display for MissingDecoder {
    fn fmt(&self, format: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        format.write_str("Для чтения обложки требуется декодер dwebp или djxl")
    }
}

impl std::error::Error for MissingDecoder {}

impl Covers {
    pub fn new(exec: &Path, config: &Value, images: usize, queue_timeout: Duration) -> Self {
        let paths = &config["converterPaths"];
        Self {
            archives: Mutex::new(None),
            decoders: Queue::with_limits(images, 16, queue_timeout),
            webp: Tool::find(exec, "dwebp", &configured(paths, &["dwebp", "webp"])),
            jxl: Tool::find(exec, "djxl", &configured(paths, &["djxl", "jxl"])),
        }
    }

    pub fn read(
        &self,
        sources: Arc<Vec<Source>>,
        source: Option<&str>,
        libid: u64,
        cache: &Path,
    ) -> Result<Option<Image>> {
        let archives = {
            let mut state = self.archives.lock().expect("legacy cover archives");
            if state.as_ref().is_none_or(|existing| {
                !Arc::ptr_eq(&existing.sources, &sources)
                    || existing.scanned.elapsed().as_secs() >= 60
            }) {
                *state = Some(Arc::new(Archives::scan(sources)));
            }
            state.as_ref().expect("legacy cover inventory").clone()
        };
        let name = libid.to_string();
        let mut missing_decoder = false;
        for (items, covers) in [(&archives.covers, true), (&archives.books, false)] {
            for archive in items.iter().filter(|archive| {
                (archive.from..=archive.to).contains(&libid)
                    && source.is_none_or(|id| id == archives.sources[archive.source].id)
            }) {
                if let Ok(Some(bytes)) = archive.read(&name, covers) {
                    match self.normalize(bytes, cache, IMAGE_LIMIT) {
                        Ok(Some(image)) => return Ok(Some(image)),
                        Err(error) if error.is::<MissingDecoder>() => missing_decoder = true,
                        _ => {}
                    }
                }
            }
        }
        if missing_decoder {
            return Err(MissingDecoder.into());
        }
        Ok(None)
    }

    pub fn sidecar(&self, book: &Book, source: &Source, cache: &Path) -> Result<Option<Image>> {
        if !source.remote {
            return self.read_sidecars(
                cover_inputs(&source.lib_dir, &book.folder, &book.file)?,
                cache,
                IMAGE_LIMIT,
            );
        }
        Ok(None)
    }

    pub(crate) fn read_sidecars(
        &self,
        inputs: Vec<crate::book_source::Input>,
        cache: &Path,
        limit: usize,
    ) -> Result<Option<Image>> {
        let mut missing_decoder = false;
        for input in inputs {
            let mut bytes = Vec::new();
            if extract_input(input, &mut bytes, limit as u64).is_ok() {
                match self.browser_image(bytes, cache, limit) {
                    Ok(Some(image)) => return Ok(Some(image)),
                    Err(error) if error.is::<MissingDecoder>() => missing_decoder = true,
                    _ => {}
                }
            }
        }
        if missing_decoder {
            Err(MissingDecoder.into())
        } else {
            Ok(None)
        }
    }

    pub fn embedded(&self, document: &Document, cache: &Path) -> Result<Option<Image>> {
        match document.cover_bytes() {
            Some(bytes) => self.browser_image(bytes, cache, IMAGE_LIMIT),
            None => Ok(None),
        }
    }

    pub(crate) fn browser_image(
        &self,
        bytes: Vec<u8>,
        cache: &Path,
        limit: usize,
    ) -> Result<Option<Image>> {
        if self.webp.is_none() && bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
            return Ok(Image::from_bytes_limited(bytes, limit));
        }
        self.normalize(bytes, cache, limit)
    }

    fn normalize(&self, bytes: Vec<u8>, cache: &Path, limit: usize) -> Result<Option<Image>> {
        let webp = bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP");
        let jxl = bytes.starts_with(b"\xff\x0a") || bytes.starts_with(b"\0\0\0\x0cJXL \r\n\x87\n");
        let (extension, tool) = match (webp, jxl) {
            (true, _) => ("webp", self.webp.as_ref()),
            (_, true) => ("jxl", self.jxl.as_ref()),
            _ => return Ok(Image::from_bytes_limited(bytes, limit)),
        };
        let tool = tool.ok_or(MissingDecoder)?;
        let temp = tempfile::tempdir_in(cache)?;
        // Cover decoding can also be reached from book preparation and gallery requests.
        let _decoder = self.decoders.enter(temp.path())?;
        let input = temp.path().join(format!("cover.{extension}"));
        let output = temp.path().join("cover.png");
        fs::write(&input, bytes)?;
        let mut command = tool.command(temp.path());
        command.arg(input);
        if webp {
            command.arg("-o");
        }
        command.arg(&output);
        run(command, Instant::now() + Duration::from_secs(15))?;
        let mut bytes = Vec::new();
        File::open(output)?
            .take(limit as u64 + 1)
            .read_to_end(&mut bytes)?;
        Ok(Image::from_bytes_limited(bytes, limit)
            .filter(|image| image.content_type == "image/png"))
    }
}

impl Archives {
    fn scan(sources: Arc<Vec<Source>>) -> Self {
        let mut covers = Vec::new();
        let mut books = Vec::new();
        for (source, item) in sources.iter().enumerate() {
            let Ok(root) = item.lib_dir.canonicalize() else {
                continue;
            };
            let parent = root.parent().unwrap_or(&root);
            for dir in [root.join("covers"), parent.join("covers")] {
                scan(&mut covers, &dir, parent, source);
            }
            scan(&mut books, &root, &root, source);
            if let Ok(entries) = ordered_entries(&root) {
                for (_, entry) in entries.flatten() {
                    if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                        scan(&mut books, &entry.path(), &root, source);
                    }
                }
            }
        }
        for items in [&mut covers, &mut books] {
            let mut seen = HashSet::new();
            items.retain(|item| seen.insert((item.path.clone(), item.source)));
            // RC15 prefers the narrowest matching range, then the lowest start.
            items.sort_by_key(|item| (item.to - item.from, item.from));
        }
        Self {
            sources,
            scanned: Instant::now(),
            covers,
            books,
        }
    }
}

fn scan(items: &mut Vec<Archive>, dir: &Path, boundary: &Path, source: usize) {
    let Ok(root) = fs::canonicalize(dir).and_then(|dir| within(boundary, dir)) else {
        return;
    };
    let Ok(entries) = ordered_entries(&root) else {
        return;
    };
    for (name, entry) in entries.flatten() {
        let path = Path::new(&name);
        if !path
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("zip") || ext.eq_ignore_ascii_case("7z"))
        {
            continue;
        }
        let Some((start, end)) = path
            .file_stem()
            .and_then(|name| name.to_str())
            .and_then(|name| name.rsplit_once('-'))
        else {
            continue;
        };
        let start = &start[start.trim_end_matches(|ch: char| ch.is_ascii_digit()).len()..];
        if start.len() < 4 || end.len() < 4 || !end.bytes().all(|byte| byte.is_ascii_digit()) {
            continue;
        }
        let (Ok(from), Ok(to)) = (start.parse(), end.parse()) else {
            continue;
        };
        if from <= to {
            items.push(Archive {
                root: boundary.into(),
                path: entry.path(),
                source,
                from,
                to,
            });
        }
    }
}

impl Archive {
    fn read(&self, name: &str, covers: bool) -> Result<Option<Vec<u8>>> {
        let path = within(&self.root, self.path.canonicalize()?)?;
        let file = open_within(&self.root, &path)?;
        let mut archive = input_directory(&self.path, file)?;
        if covers {
            return Ok(Some(read_member(&mut archive, name, IMAGE_LIMIT as u64)?));
        }
        Ok(embedded(&mut archive, name, true))
    }
}

fn embedded(
    archive: &mut Directory<impl Read + Seek>,
    id: &str,
    allow_nested: bool,
) -> Option<Vec<u8>> {
    let book = format!("{id}.fb2");
    let gzip = format!("{book}.gz");
    let zip = format!("{book}.zip");
    let mut names = Vec::new();
    archive.files(|name| {
        let leaf = name.rsplit(['/', '\\']).next().unwrap_or_default();
        if leaf.eq_ignore_ascii_case(&book)
            || leaf.eq_ignore_ascii_case(&gzip)
            || (allow_nested && leaf.eq_ignore_ascii_case(&zip))
        {
            names.push(name.to_owned());
        }
        true
    });
    names.sort_by_key(String::len);
    names.into_iter().find_map(|name| {
        let data = read_member(archive, &name, FB2_LIMIT).ok()?;
        if name.to_ascii_lowercase().ends_with(".zip") {
            return embedded(
                &mut Directory::open(Cursor::new(data), false).ok()?,
                id,
                false,
            );
        }
        if data.starts_with(b"\x1f\x8b") {
            let mut bytes = Vec::new();
            MultiGzDecoder::new(data.as_slice())
                .take(FB2_LIMIT + 1)
                .read_to_end(&mut bytes)
                .ok()?;
            return (bytes.len() as u64 <= FB2_LIMIT)
                .then(|| fb2_cover(&bytes))
                .flatten();
        }
        fb2_cover(&data)
    })
}

pub(crate) fn read_member(
    archive: &mut Directory<impl Read + Seek>,
    name: &str,
    limit: u64,
) -> std::result::Result<Vec<u8>, Failure> {
    archive.read(name, None, |size, reader| {
        if size > limit {
            return Err(Failure::Limit);
        }
        let mut bytes = Vec::new();
        reader.take(size + 1).read_to_end(&mut bytes)?;
        if bytes.len() as u64 != size {
            return Err(Failure::InvalidType);
        }
        Ok(bytes)
    })
}
