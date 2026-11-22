use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};

mod cover_cache;
use cover_cache::{CoverCache, CoverFile};

use hyper::body::{Bytes, Incoming};
use hyper::header::{self, HeaderMap, HeaderValue};
use hyper::{Request, Response, StatusCode};
use inpx_catalog::Result as CatalogueResult;
use inpx_catalog::book_conversion::{Conversion, Error as ConversionError, Format as Converted};
use inpx_catalog::book_delivery::{self, Book, DownloadError, Representation};
use inpx_catalog::legacy_library_files::{Covers, MissingDecoder};
use inpx_catalog::library_sources::Source;
use inpx_catalog::reader_document::{Document, Image};
use inpx_catalog::standalone_catalogue::Catalogue;
use serde_json::{Value, json};

use crate::download;
use crate::http::{Body, body, error};
use crate::standalone::remote::{Remote, Unavailable};
use crate::standalone::resources::{Budget, Kind};
use crate::standalone_access::Access;

pub(crate) struct Downloads {
    root: String,
    cache: PathBuf,
    template: RwLock<String>,
    resources: Arc<Budget>,
    cover_root: String,
    pub(super) covers: Covers,
    recent_covers: Mutex<CoverCache>,
    local_books: book_delivery::LocalBooks,
    media: RwLock<Media>,
    remote: Option<Arc<Remote>>,
}

struct Media {
    fb2: bool,
    conversion: Option<Arc<Conversion>>,
    previous: Option<Arc<Conversion>>,
}

pub(crate) struct Requested {
    target: Target,
    uid: Option<String>,
    format: Option<Format>,
    gzip: bool,
    ascii_only: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Format {
    Raw,
    Zip,
    Fb2,
    Converted(Converted),
}

impl Format {
    fn resource(self) -> Kind {
        match self {
            Self::Converted(_) | Self::Fb2 => Kind::Conversions,
            _ => Kind::Archives,
        }
    }

    fn segment(self) -> &'static str {
        match self {
            Self::Raw => "raw",
            Self::Zip => "zip",
            Self::Fb2 => "fb2",
            Self::Converted(format) => format.name(),
        }
    }

    fn extension(self) -> Option<&'static str> {
        match self {
            Self::Fb2 => Some("fb2"),
            Self::Converted(format) => Some(format.extension()),
            _ => None,
        }
    }
}

enum Target {
    ByUid,
    Hash(String),
}

pub(crate) enum Prepared {
    Redirect(String),
    File {
        path: PathBuf,
        headers: HeaderMap,
    },
    Bytes {
        data: Bytes,
        modified: std::time::SystemTime,
        headers: HeaderMap,
    },
}

impl Downloads {
    pub(crate) fn set_resource_limits(&self, limits: crate::standalone::resources::Limits) {
        self.covers.set_concurrency(limits.images);
        let media = self.media.read().expect("download formats");
        if let Some(conversions) = media.conversion.as_ref().or(media.previous.as_ref()) {
            conversions.set_concurrency(limits.conversions);
        }
    }

    pub(super) fn configure_media(&self, fb2: bool, mut conversion: Option<Conversion>) {
        let mut media = self.media.write().expect("download formats");
        let previous = media.conversion.take().or_else(|| media.previous.take());
        if let (Some(next), Some(old)) = (&mut conversion, &previous) {
            next.share_queue(old);
        }
        media.fb2 = fb2;
        media.previous = previous.filter(|_| conversion.is_none());
        media.conversion = conversion.map(Arc::new);
    }

    pub(super) fn configure_names_and_covers(&self, config: &Value) {
        *self.template.write().expect("filename template") =
            std::env::var("INPX_BOOK_FILENAME_TEMPLATE").unwrap_or_else(|_| {
                config["bookFilenameTemplate"]
                    .as_str()
                    .unwrap_or_default()
                    .into()
            });
        let decoder = std::env::var("INPX_JXL_DECODER")
            .unwrap_or_else(|_| config["jxlDecoder"].as_str().unwrap_or_default().into());
        self.covers.set_jxl_mode(&decoder);
        let mib = config["coverMemoryMb"].as_u64().unwrap_or(64).min(1024);
        self.recent_covers
            .lock()
            .expect("cover cache")
            .set_budget(mib as usize * 1024 * 1024);
    }

    pub(super) fn formats(&self) -> Vec<&'static str> {
        let media = self.media.read().expect("download formats");
        media
            .fb2
            .then_some("fb2")
            .into_iter()
            .chain(
                media
                    .conversion
                    .iter()
                    .flat_map(|conversion| conversion.formats()),
            )
            .collect()
    }

    pub(crate) fn new(
        data: &Path,
        prefix: &str,
        resources: Arc<Budget>,
        fb2_download: bool,
        conversions: Option<Conversion>,
        remote: Option<Arc<Remote>>,
        covers: Covers,
    ) -> CatalogueResult<Self> {
        let prefix = prefix.trim_end_matches('/');
        Ok(Self {
            root: format!("{prefix}/book"),
            cache: book_delivery::cache_directory(data)?,
            template: RwLock::default(),
            resources,
            cover_root: format!("{prefix}/cover/by-uid"),
            covers,
            recent_covers: Mutex::default(),
            local_books: Default::default(),
            media: RwLock::new(Media {
                fb2: fb2_download,
                conversion: conversions.map(Arc::new),
                previous: None,
            }),
            remote,
        })
    }

    pub(crate) fn root(&self) -> &str {
        &self.root
    }

    pub(crate) fn cache(&self) -> &Path {
        &self.cache
    }

    pub(super) fn remote(&self) -> Option<&Remote> {
        self.remote.as_deref()
    }

    pub(super) fn ebook_readable(&self, extension: &str) -> bool {
        self.remote.is_none() && reader_format(extension)
    }

    pub(super) fn ebook_formats(&self, extension: &str) -> Vec<&'static str> {
        self.formats()
            .into_iter()
            .filter(|format| {
                *format != extension
                    && self
                        .conversion(format)
                        .is_some_and(|format| self.supports(format, extension))
            })
            .collect()
    }

    pub(super) fn ebook_extension(&self, format: &str) -> Option<&'static str> {
        self.conversion(format).and_then(Format::extension)
    }

    pub(super) fn ebook_text(&self, book: &Book, sources: &[Source]) -> CatalogueResult<Vec<u16>> {
        let _permit = self.resources.acquire(Kind::Archives)?;
        let source = book.source(sources).ok_or_else(missing_book)?;
        let cached = self.local_books.prepare(
            &self.cache,
            book,
            source,
            &self.covers,
            Some(inpx_catalog::ebook_text::FILE_LIMIT),
        )?;
        let path = cached.reader_file(&self.cache, &book.ext)?;
        inpx_catalog::ebook_text::read(&path)
    }

    fn cache_book(&self, book: &Book, source: &Source) -> CatalogueResult<book_delivery::Cached> {
        if source.remote {
            let remote = self.remote().ok_or(Unavailable)?;
            return book_delivery::prepare_remote(
                &self.cache,
                book,
                source,
                |directory, cached| remote.download(book, directory, cached),
            );
        }
        self.local_books
            .prepare(&self.cache, book, source, &self.covers, None)
    }

    pub(super) fn raw_book(&self, book: &Book, sources: &[Source]) -> CatalogueResult<PathBuf> {
        let _permit = self.resources.acquire(Kind::Archives)?;
        let source = book.source(sources).ok_or_else(missing_book)?;
        let cached = self.cache_book(book, source)?;
        cached.file(&self.cache, "", Representation::Raw)
    }

    pub(super) fn template(&self) -> String {
        self.template.read().expect("filename template").clone()
    }

    pub(super) fn legacy_covers(&self) -> PathBuf {
        self.cache.with_file_name("cover")
    }

    pub(super) fn clear_cover_lookup(&self) {
        self.recent_covers.lock().expect("cover cache").clear();
    }

    pub(super) fn expire_covers(&self) {
        self.recent_covers.lock().expect("cover cache").expire();
    }

    pub(super) fn rebuild_cover(
        &self,
        uid: &str,
        catalogue: &RwLock<Option<Catalogue>>,
        sources: &[Source],
    ) -> CatalogueResult<Value> {
        use sha2::{Digest, Sha256};
        let mut row = load_row(catalogue, uid)?.ok_or("Книга не найдена")?;
        let book: Book = serde_json::from_value(row.clone())?;
        let mut removed = 0;
        let mut rebuilt = false;
        if let Some(image) = self.book_cover(&book, sources)? {
            removed += usize::from(image.rebuild(&self.cache)?);
            rebuilt = true;
        }
        let revision = if row["_recordHash"].is_null() {
            json!([row.get("inpxSize").unwrap_or(&row["size"]), row["date"]])
        } else {
            row["_recordHash"].take()
        };
        let key = serde_json::to_vec(&json!([
            uid,
            row["sourceId"],
            row["sourceLibDir"],
            row["folder"],
            row["file"],
            row["ext"],
            revision
        ]))?;
        let digest = Sha256::digest(key)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let key = format!("book-v3-{digest}");
        let legacy = self.legacy_covers();
        if rebuilt
            && std::fs::symlink_metadata(&legacy)
                .is_ok_and(|metadata| metadata.is_dir() && !metadata.is_symlink())
        {
            for entry in std::fs::read_dir(legacy)? {
                let entry = entry?;
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if let Some(suffix) = name.strip_prefix(&key)
                    && (matches!(suffix, ".jpg" | ".png" | ".gif")
                        || suffix.starts_with("-abs-")
                            && matches!(suffix.rsplit('.').next(), Some("jpg" | "png" | "gif")))
                    && entry.file_type()?.is_file()
                {
                    match std::fs::remove_file(entry.path()) {
                        Ok(()) => removed += 1,
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
                        Err(error) => return Err(error.into()),
                    }
                }
            }
        }
        let query = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("uid", uid)
            .finish();
        self.clear_cover_lookup();
        Ok(
            json!({"success":true,"bookUid":uid,"libid":row["libid"],"sourceId":row["sourceId"],
            "removed":removed,"rebuilt":rebuilt,"coverUrl":format!("{}?{query}",self.cover_root)}),
        )
    }

    pub(super) fn attachment(
        &self,
        book: &Book,
        sources: &[Source],
        explicit: &str,
        preferred: &str,
        archive: bool,
    ) -> CatalogueResult<(PathBuf, String)> {
        let source = book.source(sources).ok_or_else(missing_book)?;
        let ext = book.extension().ok_or_else(missing_book)?;
        let explicit = explicit.trim().to_ascii_lowercase();
        let preferred = preferred.trim().to_ascii_lowercase();
        let format = if explicit.is_empty() {
            &preferred
        } else {
            &explicit
        };
        let variant = if format.is_empty()
            || matches!(format.as_str(), "original" | "raw")
            || format.eq_ignore_ascii_case(ext)
        {
            Format::Raw
        } else if let Some(variant) = self
            .conversion(format)
            .filter(|variant| self.supports(*variant, ext))
        {
            variant
        } else if explicit.is_empty() {
            Format::Raw
        } else {
            return Err(format!("Неподдерживаемый формат отправки: {format}").into());
        };
        let cached = {
            let _permit = self.resources.acquire(Kind::Archives)?;
            self.cache_book(book, source)?
        };
        let mut name = book
            .filename(&self.template())?
            .replace(|ch: char| ch.is_ascii_control(), "_");
        if let Some(ext) = variant.extension() {
            name = replace_extension(&name, ext);
        }
        let mut file = self.variant(book, &cached, &name, Some(variant), false)?;
        if archive {
            let _permit = self.resources.acquire(Kind::Archives)?;
            file = book_delivery::archive_attachment(&self.cache, &file, &name)?;
            name.push_str(".zip");
        }
        Ok((file, name))
    }

    fn conversion(&self, name: &str) -> Option<Format> {
        let media = self.media.read().expect("download formats");
        if name == "fb2" && media.fb2 {
            Some(Format::Fb2)
        } else {
            media
                .conversion
                .as_ref()?
                .format(name)
                .map(Format::Converted)
        }
    }

    fn supports(&self, format: Format, extension: &str) -> bool {
        let media = self.media.read().expect("download formats");
        match format {
            Format::Fb2 => {
                media.fb2
                    && (extension.eq_ignore_ascii_case("fb2")
                        || extension.eq_ignore_ascii_case("epub"))
            }
            Format::Converted(format) => media
                .conversion
                .as_ref()
                .is_some_and(|conversions| conversions.supports(format, extension)),
            Format::Raw | Format::Zip => true,
        }
    }

    fn variant(
        &self,
        book: &Book,
        cached: &book_delivery::Cached,
        name: &str,
        variant: Option<Format>,
        compressed: bool,
    ) -> CatalogueResult<PathBuf> {
        if let Some(Format::Converted(format)) = variant {
            let conversion = self
                .media
                .read()
                .expect("download formats")
                .conversion
                .clone();
            return conversion
                .ok_or("Конвертер недоступен")?
                .convert(&self.cache, book, cached, format, || {
                    self.resources.acquire(Kind::Conversions)
                })
                .inspect_err(|error| {
                    let event = match error.downcast_ref::<ConversionError>() {
                        Some(ConversionError::Busy) => "conversion-queue-full",
                        Some(ConversionError::TimedOut) => "conversion-timeout",
                        _ => "conversion-failed",
                    };
                    crate::standalone::logging::warn_limited(
                        "inpx::conversion",
                        event,
                        format_args!("format={}", format.extension()),
                    );
                });
        }
        let _permit = self
            .resources
            .acquire(variant.unwrap_or(Format::Raw).resource())?;
        match variant {
            Some(Format::Fb2) => cached.reader_file(&self.cache, &book.ext),
            Some(Format::Zip) => cached.file(&self.cache, name, Representation::Zip),
            _ if compressed => cached.file(&self.cache, name, Representation::Gzip),
            _ => cached.file(&self.cache, name, Representation::Raw),
        }
    }

    pub(crate) fn book_link(
        &self,
        uid: &str,
        catalogue: &RwLock<Option<Catalogue>>,
        sources: &[Source],
    ) -> CatalogueResult<Option<serde_json::Value>> {
        let _permit = self.resources.acquire(Kind::Archives)?;
        let Some(book) = load_book(catalogue, uid)? else {
            return Ok(None);
        };
        let Some(source) = book.source(sources) else {
            return Ok(None);
        };
        let cached = self.cache_book(&book, source)?;
        let extension = book.extension().ok_or("Invalid book extension")?;
        Ok(Some(json!({
            "link":format!("{}/{}", self.root, cached.hash),
            "libFolder":book.folder,
            "libFile":format!("{}.{extension}", book.file),
            "downFileName":book.filename(&self.template())?,
            "size":cached.size(),
        })))
    }

    pub(crate) fn book_info(
        &self,
        uid: &str,
        catalogue: &RwLock<Option<Catalogue>>,
        sources: &[Source],
        card: bool,
        reader_only: bool,
    ) -> CatalogueResult<Option<Value>> {
        let _permit = self.resources.acquire(Kind::Archives)?;
        let Some(row) = load_row(catalogue, uid)? else {
            return Ok(None);
        };
        let book: Book = serde_json::from_value(row.clone())?;
        if !book.ext.eq_ignore_ascii_case("fb2")
            && !(reader_only && book.ext.eq_ignore_ascii_case("epub"))
        {
            return Ok(Some(json!({"bookInfo":{
                "book":row,"cover":"","fb2":false,"contents":[],"reviews":[],
                "libraryRating":null,"reviewsDeferred":card,
            }})));
        }
        let Some((document, cached)) = self.document(&book, sources)? else {
            return Ok(None);
        };
        let mut cover = String::new();
        if !card
            && (document.cover().is_some()
                || match self.source_cover(&book, sources, || {
                    self.covers.embedded(&document, &self.cache)
                }) {
                    Ok(image) => image.is_some(),
                    Err(error) if error.is::<MissingDecoder>() => false,
                    Err(error) => return Err(error),
                })
        {
            let query = url::form_urlencoded::Serializer::new(String::new())
                .append_pair("uid", uid)
                .finish();
            cover = format!("{}?{query}", self.cover_root);
        }
        let version = if book.ext.eq_ignore_ascii_case("epub") {
            "epub-reader-v2"
        } else {
            "fb2-images-v9"
        };
        let version = format!("{}:{version}", cached.hash);
        document
            .book_info(row, cached.size(), &version, &cover, card)
            .map(Some)
    }

    pub(crate) fn gallery(
        &self,
        uid: &str,
        catalogue: &RwLock<Option<Catalogue>>,
        sources: &[Source],
    ) -> CatalogueResult<Option<Value>> {
        let _permit = self.resources.acquire(Kind::Images)?;
        let Some(book) = load_book(catalogue, uid)? else {
            return Ok(None);
        };
        if !book.ext.eq_ignore_ascii_case("fb2") {
            return Ok(Some(json!({"images":[],"limited":true,"omitted":1})));
        }
        let Some(source) = book.source(sources) else {
            return Ok(None);
        };
        let cached = self.cache_book(&book, source)?;
        if cached.size() > 32 * 1024 * 1024 {
            return Ok(Some(json!({"images":[],"limited":true,"omitted":1})));
        }
        let file = cached.reader_file(&self.cache, &book.ext)?;
        Ok(Some(Document::read(&file)?.gallery()))
    }

    pub(super) fn speech_document(
        &self,
        uid: &str,
        catalogue: &RwLock<Option<Catalogue>>,
        sources: &[Source],
    ) -> CatalogueResult<(PathBuf, String)> {
        let _permit = self.resources.acquire(Kind::Archives)?;
        let book = load_book(catalogue, uid)?.ok_or("404 Файл не найден")?;
        let epub = book.ext.eq_ignore_ascii_case("epub");
        if !reader_format(&book.ext) {
            return Err("Озвучка доступна для книг FB2 и EPUB.".into());
        }
        let source = book.source(sources).ok_or("404 Файл не найден")?;
        let cached = self.cache_book(&book, source)?;
        let path = cached.reader_file(&self.cache, &book.ext)?;
        let format = if epub {
            "epub-reader-v2"
        } else {
            "fb2-images-v9"
        };
        Ok((path, format!("{}:{format}", cached.hash)))
    }

    fn document(
        &self,
        book: &Book,
        sources: &[Source],
    ) -> CatalogueResult<Option<(Document, book_delivery::Cached)>> {
        let Some(source) = book.source(sources) else {
            return Ok(None);
        };
        let cached = self.cache_book(book, source)?;
        let path = cached.reader_file(&self.cache, &book.ext)?;
        Ok(Some((Document::read(&path)?, cached)))
    }

    pub(super) fn kosync_fb2(
        &self,
        book: &Book,
        sources: &[Source],
    ) -> CatalogueResult<Option<PathBuf>> {
        let _permit = self.resources.acquire(Kind::Archives)?;
        let Some(source) = book.source(sources) else {
            return Ok(None);
        };
        let cached = self.cache_book(book, source)?;
        if cached.size() > 64 * 1024 * 1024 {
            return Ok(None);
        }
        Ok(Some(cached.reader_file(&self.cache, &book.ext)?))
    }

    pub(crate) fn cover_request(&self, request: &Request<Incoming>) -> Option<String> {
        (request.uri().path().trim_end_matches('/') == self.cover_root).then(|| {
            url::form_urlencoded::parse(request.uri().query().unwrap_or_default().as_bytes())
                .find(|(key, _)| key == "uid")
                .map(|(_, uid)| uid.trim().to_owned())
                .unwrap_or_default()
        })
    }

    fn source_cover(
        &self,
        book: &Book,
        sources: &[Source],
        embedded: impl FnOnce() -> CatalogueResult<Option<Image>>,
    ) -> CatalogueResult<Option<Image>> {
        let Some(source) = book.source(sources) else {
            return Ok(None);
        };
        match self.covers.sidecar(book, source, &self.cache) {
            Ok(None) => embedded(),
            Err(error) if error.is::<MissingDecoder>() => match embedded() {
                Ok(Some(image)) => Ok(Some(image)),
                _ => Err(error),
            },
            result => result,
        }
    }

    pub(crate) fn book_cover(
        &self,
        book: &Book,
        sources: &[Source],
    ) -> CatalogueResult<Option<Image>> {
        let _permit = self.resources.acquire(Kind::Images)?;
        self.source_cover(book, sources, || {
            if reader_format(&book.ext)
                && let Some((document, _)) = self.document(book, sources)?
            {
                return self.covers.embedded(&document, &self.cache);
            }
            Ok(None)
        })
    }

    pub(crate) fn cover(
        &self,
        uid: &str,
        catalogue: &RwLock<Option<Catalogue>>,
        generation: u64,
        sources: &[Source],
    ) -> Result<Prepared, StatusCode> {
        let (epoch, hit) = {
            let mut cache = self.recent_covers.lock().expect("cover cache");
            (cache.epoch, cache.get(generation, uid))
        };
        let file = match hit {
            Some(Some(file)) if file.bytes.is_some() || file.available() => file,
            Some(None) => return Err(StatusCode::NOT_FOUND),
            _ => {
                let book = load_book(catalogue, uid)
                    .map_err(failure)?
                    .ok_or(StatusCode::NOT_FOUND)?;
                let file = self
                    .book_cover(&book, sources)
                    .map_err(failure)?
                    .map(|image| CoverFile::stage(image, &self.cache))
                    .transpose()
                    .map_err(failure)?;
                self.recent_covers.lock().expect("cover cache").put(
                    epoch,
                    generation,
                    uid,
                    file.clone(),
                );
                file.ok_or(StatusCode::NOT_FOUND)?
            }
        };
        let mut headers = HeaderMap::new();
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static(file.content_type),
        );
        headers.insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static("private, no-cache"),
        );
        headers.insert(
            header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        );
        Ok(match file.bytes {
            Some(data) => Prepared::Bytes {
                data,
                modified: file.modified,
                headers,
            },
            None => Prepared::File {
                path: file.path,
                headers,
            },
        })
    }

    pub(crate) fn request(
        &self,
        request: &Request<Incoming>,
    ) -> Option<Result<Requested, StatusCode>> {
        let pathname = request
            .uri()
            .path()
            .strip_prefix(&self.root)?
            .strip_prefix('/')?;
        let mut segments = pathname.split('/');
        let key = segments.next()?;
        let path_format = segments.next();
        let filename = segments.next();
        if segments.next().is_some() || key == "by-uid" && filename.is_some() {
            return Some(Err(StatusCode::NOT_FOUND));
        }
        let target = match key {
            "by-uid" => Target::ByUid,
            hash if !hash.is_empty()
                && hash.len() <= 128
                && hash.bytes().all(|byte| byte.is_ascii_hexdigit()) =>
            {
                Target::Hash(hash.into())
            }
            _ => return Some(Err(StatusCode::NOT_FOUND)),
        };
        let mut uid = None;
        let mut ascii_only = false;
        let mut query_format = None;
        let mut zip = false;
        for (name, value) in
            url::form_urlencoded::parse(request.uri().query().unwrap_or_default().as_bytes())
        {
            match name.as_ref() {
                "uid" if uid.is_none() && !value.trim().is_empty() => {
                    uid = Some(value.trim().to_owned())
                }
                "filename" => ascii_only = value == "ascii",
                "format" if query_format.is_none() && !value.trim().is_empty() => {
                    query_format = Some(value.trim().to_ascii_lowercase())
                }
                "zip" => zip = value == "1",
                _ => {}
            }
        }
        let format = match target {
            Target::ByUid => query_format
                .as_deref()
                .or(if zip { Some("zip") } else { None }),
            Target::Hash(_) => path_format.filter(|value| !value.is_empty()),
        };
        let format = match format {
            Some("raw" | "original") => Some(Format::Raw),
            Some("zip") => Some(Format::Zip),
            Some(name) if self.conversion(name).is_some() => self.conversion(name),
            Some(other)
                if other.bytes().all(|byte| {
                    byte.is_ascii_lowercase()
                        || byte.is_ascii_digit()
                        || matches!(byte, b'_' | b'-')
                }) =>
            {
                return Some(Err(StatusCode::NOT_FOUND));
            }
            Some(_) => return Some(Err(StatusCode::BAD_REQUEST)),
            None => None,
        };
        Some(Ok(Requested {
            target,
            uid,
            format,
            gzip: accepts_gzip(request.headers()),
            ascii_only,
        }))
    }

    pub(crate) fn prepare(
        &self,
        request: Requested,
        catalogue: &RwLock<Option<Catalogue>>,
        sources: &[Source],
        sync: Option<&Access>,
    ) -> Result<Prepared, StatusCode> {
        let initial = match &request.target {
            Target::ByUid => None,
            Target::Hash(hash) => book_delivery::cached(&self.cache, hash).map_err(failure)?,
        };
        let uid = request
            .uid
            .as_deref()
            .or_else(|| initial.as_ref().map(book_delivery::Cached::uid))
            .ok_or(StatusCode::NOT_FOUND)?;
        let book = load_book(catalogue, uid)
            .map_err(failure)?
            .ok_or(StatusCode::NOT_FOUND)?;
        let source = book.source(sources).ok_or(StatusCode::NOT_FOUND)?;
        if request
            .format
            .is_some_and(|format| !self.supports(format, &book.ext))
        {
            return Err(StatusCode::NOT_FOUND);
        }
        let cached = match initial {
            Some(cached) if cached.matches(&book, source) => cached,
            _ => {
                let _permit = self.resources.acquire(Kind::Archives).map_err(failure)?;
                let cached = self.cache_book(&book, source).map_err(failure)?;
                if let Target::Hash(hash) = &request.target
                    && *hash != cached.hash
                {
                    return Err(StatusCode::NOT_FOUND);
                }
                cached
            }
        };
        let mut name = book.filename(&self.template()).map_err(failure)?;
        if let Target::ByUid = request.target {
            let mut href = format!("{}/{}", self.root, cached.hash);
            if let Some(variant) = request.format {
                let format = variant.segment();
                if let Some(ext) = variant
                    .extension()
                    .or((variant == Format::Zip).then_some("zip"))
                {
                    name = replace_extension(&name, ext);
                }
                href.push_str(&format!(
                    "/{format}/{}",
                    book_delivery::ascii_name(&name).replace(' ', "%20")
                ));
            }
            let mut query = url::form_urlencoded::Serializer::new(String::new());
            query.append_pair("uid", &book.uid);
            if request.ascii_only {
                query.append_pair("filename", "ascii");
            }
            href.push('?');
            href.push_str(&query.finish());
            return Ok(Prepared::Redirect(href));
        }
        let compressed = request.format.is_none() && request.gzip;
        let path = self
            .variant(&book, &cached, &name, request.format, compressed)
            .map_err(failure)?;
        let mut headers = HeaderMap::new();
        let media_type = if request.format == Some(Format::Zip) {
            name.push_str(".zip");
            "application/zip"
        } else if let Some(ext) = request.format.and_then(Format::extension) {
            name = replace_extension(&name, ext);
            mime(ext)
        } else {
            mime(&book.ext)
        };
        headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(media_type));
        headers.insert(
            header::CONTENT_DISPOSITION,
            HeaderValue::from_str(&book_delivery::disposition(&name, request.ascii_only))
                .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?,
        );
        if compressed {
            headers.insert(header::CONTENT_ENCODING, HeaderValue::from_static("gzip"));
        }
        if request.format.is_none() {
            headers.insert(header::VARY, HeaderValue::from_static("Accept-Encoding"));
        }
        if let Some(sync) = sync
            && request.format != Some(Format::Zip)
        {
            let ext = request
                .format
                .and_then(Format::extension)
                .map_or_else(|| book.ext.to_ascii_lowercase(), str::to_owned);
            if let Err(error) = sync.kosync_link(&book.uid, &ext, || {
                if compressed {
                    cached.file(&self.cache, &name, Representation::Raw)
                } else {
                    Ok(path.clone())
                }
            }) {
                log::error!(target: "inpx::kosync", "KOSync download: {error}");
            }
        }
        Ok(Prepared::File { path, headers })
    }
}

fn reader_format(extension: &str) -> bool {
    extension.eq_ignore_ascii_case("fb2") || extension.eq_ignore_ascii_case("epub")
}

fn replace_extension(name: &str, ext: &str) -> String {
    let stem = name.rsplit_once('.').map_or(name, |(stem, _)| stem);
    format!("{stem}.{ext}")
}

fn missing_book() -> std::io::Error {
    std::io::ErrorKind::NotFound.into()
}

pub(crate) async fn respond(
    prepared: Result<Prepared, StatusCode>,
    conditions: HeaderMap,
    head: bool,
) -> Response<Body> {
    match prepared {
        Ok(Prepared::Redirect(location)) => Response::builder()
            .status(StatusCode::FOUND)
            .header(header::LOCATION, location)
            .body(body(Bytes::new()))
            .expect("ASCII download URL"),
        Ok(Prepared::File { path, headers }) => {
            download::send_local(path, headers, conditions, head).await
        }
        Ok(Prepared::Bytes {
            data,
            modified,
            headers,
        }) => download::send_bytes(data, modified, headers, conditions, head),
        Err(status) => error(status),
    }
}

pub(super) fn load_book(
    catalogue: &RwLock<Option<Catalogue>>,
    uid: &str,
) -> CatalogueResult<Option<Book>> {
    load_row(catalogue, uid)?
        .map(|row| serde_json::from_value(row).map_err(Into::into))
        .transpose()
}

fn load_row(catalogue: &RwLock<Option<Catalogue>>, uid: &str) -> CatalogueResult<Option<Value>> {
    let catalogue = catalogue.read().expect("open catalogue");
    catalogue
        .as_ref()
        .ok_or("Каталог недоступен. Перезапустите сервер.")?
        .browser_book(uid)
}

fn failure(error: Box<dyn std::error::Error>) -> StatusCode {
    if error
        .downcast_ref::<std::io::Error>()
        .is_some_and(|cause| cause.kind() == std::io::ErrorKind::TimedOut)
    {
        return StatusCode::SERVICE_UNAVAILABLE;
    }
    if error.is::<MissingDecoder>() {
        crate::standalone::logging::warn_limited(
            "inpx::cover",
            "decoder-unavailable",
            format_args!("status=503"),
        );
        return StatusCode::SERVICE_UNAVAILABLE;
    }
    if error.is::<Unavailable>() {
        return StatusCode::BAD_GATEWAY;
    }
    if let Some(error) = error.downcast_ref::<ConversionError>() {
        return match error {
            ConversionError::Busy => StatusCode::SERVICE_UNAVAILABLE,
            ConversionError::TimedOut => StatusCode::GATEWAY_TIMEOUT,
        };
    }
    match book_delivery::classify(error.as_ref()) {
        DownloadError::Missing => StatusCode::NOT_FOUND,
        DownloadError::Limit => StatusCode::PAYLOAD_TOO_LARGE,
        DownloadError::Unsupported => StatusCode::UNSUPPORTED_MEDIA_TYPE,
        DownloadError::DecoderMemory => StatusCode::UNPROCESSABLE_ENTITY,
        DownloadError::Internal => {
            log::error!(target: "inpx::download", "Не удалось подготовить скачивание");
            StatusCode::INTERNAL_SERVER_ERROR
        }
    }
}

fn accepts_gzip(headers: &HeaderMap) -> bool {
    let mut wildcard = false;
    for value in headers
        .get_all(header::ACCEPT_ENCODING)
        .iter()
        .filter_map(|value| value.to_str().ok())
    {
        for encoding in value.split(',') {
            let mut fields = encoding.split(';');
            let name = fields.next().unwrap_or_default().trim();
            let quality = fields
                .find_map(|field| field.trim().strip_prefix("q="))
                .map_or(1.0, |field| field.trim().parse::<f32>().unwrap_or_default());
            if name.eq_ignore_ascii_case("gzip") {
                return quality > 0.0;
            }
            if name == "*" {
                wildcard = quality > 0.0;
            }
        }
    }
    wildcard
}

fn mime(extension: &str) -> &'static str {
    match extension.to_ascii_lowercase().as_str() {
        "fb2" => "application/x-fictionbook+xml; charset=utf-8",
        "epub" | "kepub.epub" => "application/epub+zip",
        "zip" => "application/zip",
        "pdf" => "application/pdf",
        "txt" => "text/plain; charset=utf-8",
        "rtf" => "application/rtf",
        "mobi" => "application/x-mobipocket-ebook",
        "azw" | "azw3" | "azw8" | "kfx" => "application/vnd.amazon.ebook",
        "doc" => "application/msword",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        _ => "application/octet-stream",
    }
}
