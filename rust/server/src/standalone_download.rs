use std::path::{Path, PathBuf};
use std::sync::Mutex;

use hyper::body::{Bytes, Incoming};
use hyper::header::{self, HeaderMap, HeaderValue};
use hyper::{Request, Response, StatusCode};
use inpx_catalog::Result as CatalogueResult;
use inpx_catalog::book_delivery::{self, Book, DownloadError, Representation};
use inpx_catalog::library_sources::Source;
use inpx_catalog::reader_document::{Document, Image};
use inpx_catalog::standalone_catalogue::Catalogue;
use serde_json::{Value, json};

use crate::download;
use crate::http::{Body, body, error};
use crate::standalone_access::Access;

pub(crate) struct Downloads {
    root: String,
    cache: PathBuf,
    template: String,
    cover_root: String,
    epub: bool,
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
}

impl Format {
    fn segment(self) -> &'static str {
        match self {
            Self::Raw => "raw",
            Self::Zip => "zip",
            Self::Fb2 => "fb2",
        }
    }
}

enum Target {
    ByUid,
    Hash(String),
}

pub(crate) enum Prepared {
    Redirect(String),
    File { path: PathBuf, headers: HeaderMap },
}

impl Downloads {
    pub(crate) fn new(
        data: &Path,
        prefix: &str,
        template: String,
        epub: bool,
    ) -> CatalogueResult<Self> {
        let prefix = prefix.trim_end_matches('/');
        Ok(Self {
            root: format!("{prefix}/book"),
            cache: book_delivery::cache_directory(data)?,
            template,
            cover_root: format!("{prefix}/cover/by-uid"),
            epub,
        })
    }

    pub(crate) fn root(&self) -> &str {
        &self.root
    }

    pub(crate) fn cache(&self) -> &Path {
        &self.cache
    }

    pub(crate) fn book_link(
        &self,
        uid: &str,
        catalogue: &Mutex<Option<Catalogue>>,
        sources: &[Source],
    ) -> CatalogueResult<Option<serde_json::Value>> {
        let Some(book) = load_book(catalogue, uid)? else {
            return Ok(None);
        };
        let Some(source) = book.source(sources) else {
            return Ok(None);
        };
        let cached = book_delivery::prepare(&self.cache, &book, source)?;
        let extension = book.extension().ok_or("Invalid book extension")?;
        Ok(Some(json!({
            "link":format!("{}/{}", self.root, cached.hash),
            "libFolder":book.folder,
            "libFile":format!("{}.{extension}", book.file),
            "downFileName":book.filename(&self.template)?,
            "size":cached.size(),
        })))
    }

    pub(crate) fn book_info(
        &self,
        uid: &str,
        catalogue: &Mutex<Option<Catalogue>>,
        sources: &[Source],
        card: bool,
        reader_only: bool,
    ) -> CatalogueResult<Option<Value>> {
        let Some(row) = load_row(catalogue, uid)? else {
            return Ok(None);
        };
        let book: Book = serde_json::from_value(row.clone())?;
        if !book.ext.eq_ignore_ascii_case("fb2")
            && !(self.epub && reader_only && book.ext.eq_ignore_ascii_case("epub"))
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
        if !card && document.cover().is_some() {
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
        catalogue: &Mutex<Option<Catalogue>>,
        sources: &[Source],
    ) -> CatalogueResult<Option<Value>> {
        let Some(book) = load_book(catalogue, uid)? else {
            return Ok(None);
        };
        if !book.ext.eq_ignore_ascii_case("fb2") {
            return Ok(Some(json!({"images":[],"limited":true,"omitted":1})));
        }
        let Some(source) = book.source(sources) else {
            return Ok(None);
        };
        let cached = book_delivery::prepare(&self.cache, &book, source)?;
        if cached.size() > 32 * 1024 * 1024 {
            return Ok(Some(json!({"images":[],"limited":true,"omitted":1})));
        }
        let file = cached.reader_file(&self.cache, &book.ext)?;
        Ok(Some(Document::read(&file)?.gallery()))
    }

    fn document(
        &self,
        book: &Book,
        sources: &[Source],
    ) -> CatalogueResult<Option<(Document, book_delivery::Cached)>> {
        let Some(source) = book.source(sources) else {
            return Ok(None);
        };
        let cached = book_delivery::prepare(&self.cache, book, source)?;
        let path = cached.reader_file(&self.cache, &book.ext)?;
        Ok(Some((Document::read(&path)?, cached)))
    }

    pub(super) fn kosync_fb2(
        &self,
        book: &Book,
        sources: &[Source],
    ) -> CatalogueResult<Option<PathBuf>> {
        let Some(source) = book.source(sources) else {
            return Ok(None);
        };
        let cached = book_delivery::prepare(&self.cache, book, source)?;
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

    pub(crate) fn provider_image(
        &self,
        book: &Book,
        sources: &[Source],
    ) -> CatalogueResult<Option<Image>> {
        let Some(source) = book.source(sources) else {
            return Ok(None);
        };
        if let Some(image) = book_delivery::sidecar_cover(book, source)? {
            return Ok(Some(image));
        }
        if book.ext.eq_ignore_ascii_case("fb2") {
            return Ok(self
                .document(book, sources)?
                .and_then(|(document, _)| document.cover()));
        }
        Ok(None)
    }

    pub(crate) fn cover(
        &self,
        uid: &str,
        catalogue: &Mutex<Option<Catalogue>>,
        sources: &[Source],
    ) -> Result<Prepared, StatusCode> {
        let book = load_book(catalogue, uid)
            .map_err(failure)?
            .ok_or(StatusCode::NOT_FOUND)?;
        if !book.ext.eq_ignore_ascii_case("fb2")
            && !(self.epub && book.ext.eq_ignore_ascii_case("epub"))
        {
            return Err(StatusCode::NOT_FOUND);
        }
        let (document, _) = self
            .document(&book, sources)
            .map_err(failure)?
            .ok_or(StatusCode::NOT_FOUND)?;
        let image = document.cover().ok_or(StatusCode::NOT_FOUND)?;
        let path = image.stage(&self.cache).map_err(failure)?;
        let mut headers = HeaderMap::new();
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static(image.content_type),
        );
        headers.insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static("private, no-cache"),
        );
        headers.insert(
            header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        );
        Ok(Prepared::File { path, headers })
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
            Some("raw") => Some(Format::Raw),
            Some("zip") => Some(Format::Zip),
            Some("fb2") if self.epub => Some(Format::Fb2),
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
        catalogue: &Mutex<Option<Catalogue>>,
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
        if request.format == Some(Format::Fb2)
            && !matches!(book.ext.to_ascii_lowercase().as_str(), "epub" | "fb2")
        {
            return Err(StatusCode::NOT_FOUND);
        }
        let cached = match initial {
            Some(cached) if cached.matches(&book, source) => cached,
            _ => {
                let cached = book_delivery::prepare(&self.cache, &book, source).map_err(failure)?;
                if let Target::Hash(hash) = &request.target
                    && *hash != cached.hash
                {
                    return Err(StatusCode::NOT_FOUND);
                }
                cached
            }
        };
        let mut name = book.filename(&self.template).map_err(failure)?;
        if let Target::ByUid = request.target {
            let mut href = format!("{}/{}", self.root, cached.hash);
            if let Some(variant) = request.format {
                let format = variant.segment();
                if variant != Format::Raw {
                    name = replace_extension(&name, format);
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
        let path = match request.format {
            Some(Format::Fb2) => cached.reader_file(&self.cache, &book.ext),
            Some(Format::Zip) => cached.file(&self.cache, &name, Representation::Zip),
            _ if compressed => cached.file(&self.cache, &name, Representation::Gzip),
            _ => cached.file(&self.cache, &name, Representation::Raw),
        }
        .map_err(failure)?;
        let mut headers = HeaderMap::new();
        let media_type = if request.format == Some(Format::Zip) {
            name.push_str(".zip");
            "application/zip"
        } else if request.format == Some(Format::Fb2) {
            name = replace_extension(&name, "fb2");
            mime("fb2")
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
            let ext = if request.format == Some(Format::Fb2) {
                "fb2".to_owned()
            } else {
                book.ext.to_ascii_lowercase()
            };
            if let Err(error) = sync.kosync_link(&book.uid, &ext, || {
                if compressed {
                    cached.file(&self.cache, &name, Representation::Raw)
                } else {
                    Ok(path.clone())
                }
            }) {
                eprintln!("KOSync download: {error}");
            }
        }
        Ok(Prepared::File { path, headers })
    }
}

fn replace_extension(name: &str, ext: &str) -> String {
    let stem = name.rsplit_once('.').map_or(name, |(stem, _)| stem);
    format!("{stem}.{ext}")
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
        Err(status) => error(status),
    }
}

pub(super) fn load_book(
    catalogue: &Mutex<Option<Catalogue>>,
    uid: &str,
) -> CatalogueResult<Option<Book>> {
    load_row(catalogue, uid)?
        .map(|row| serde_json::from_value(row).map_err(Into::into))
        .transpose()
}

fn load_row(catalogue: &Mutex<Option<Catalogue>>, uid: &str) -> CatalogueResult<Option<Value>> {
    let catalogue = catalogue.lock().expect("open catalogue");
    catalogue
        .as_ref()
        .ok_or("Каталог недоступен. Перезапустите сервер.")?
        .browser_book(uid)
}

fn failure(error: Box<dyn std::error::Error>) -> StatusCode {
    match book_delivery::classify(error.as_ref()) {
        DownloadError::Missing => StatusCode::NOT_FOUND,
        DownloadError::Limit => StatusCode::PAYLOAD_TOO_LARGE,
        DownloadError::Unsupported => StatusCode::UNSUPPORTED_MEDIA_TYPE,
        DownloadError::Internal => {
            eprintln!("Book download: {error}");
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
        "epub" => "application/epub+zip",
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
