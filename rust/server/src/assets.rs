use std::collections::HashMap;
use std::fs::File;
use std::io::Read;
use std::ops::Range;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use hyper::body::{Body as _, Bytes, Incoming};
use hyper::header::{self, HeaderMap, HeaderName, HeaderValue};
use hyper::{Method, Request, Response, StatusCode};
use serde::Deserialize;

use crate::http::{Body, body};

pub const PROBE: HeaderName = HeaderName::from_static("x-inpx-managed-asset");
const FILE_LIMIT: usize = 8 * 1024 * 1024;
const TOTAL_LIMIT: usize = 32 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub(crate) directory: PathBuf,
    pub(crate) prefix: String,
    pub(crate) app_directory: String,
    pub(crate) metrics_path: String,
    pub(crate) opds_path: Option<String>,
}

#[derive(Deserialize)]
struct Manifest {
    files: Vec<String>,
}

pub struct Assets {
    files: HashMap<String, Asset>,
}

struct Asset {
    bytes: Bytes,
    headers: HeaderMap,
    modified: SystemTime,
}

pub struct Delivery<'a> {
    asset: &'a Asset,
    status: StatusCode,
    range: Option<Range<usize>>,
    head: bool,
    pub needs_probe: bool,
}

impl Assets {
    pub(crate) fn has_path(&self, path: &str) -> bool {
        self.files.contains_key(path)
    }

    pub fn load(config: Option<Config>) -> Self {
        let files = config.and_then(Self::read).unwrap_or_default();
        Self { files }
    }

    fn read(config: Config) -> Option<HashMap<String, Asset>> {
        let Config {
            directory,
            prefix,
            app_directory,
            metrics_path,
            opds_path,
        } = config;
        // Express route patterns could take precedence over a bundled asset.
        if !metrics_path.bytes().all(url_byte)
            || !prefix.bytes().all(url_byte)
            || opds_path
                .as_ref()
                .is_some_and(|path| !path.bytes().all(url_byte))
        {
            return None;
        }
        let metrics_path = metrics_path.trim_end_matches('/');
        let opds_path = opds_path
            .as_deref()
            .map(|path| path.trim_end_matches('/').to_ascii_lowercase());
        let is_reserved = |path: &str| {
            let path = path.trim_end_matches('/');
            [metrics_path, "/health", "/ready", "/api/index-status"]
                .iter()
                .any(|reserved| path.eq_ignore_ascii_case(reserved))
                || opds_path.as_ref().is_some_and(|prefix| {
                    path.to_ascii_lowercase()
                        .strip_prefix(prefix)
                        .is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
                })
        };
        let prefix = prefix.trim_end_matches('/');
        let root = directory.canonicalize().ok()?;
        let marker = root.join(".inpx-web-managed.json");
        if !marker.symlink_metadata().ok()?.is_file() {
            return None;
        }
        let mut manifest: Manifest =
            serde_json::from_reader(File::open(marker).ok()?.take(1024 * 1024)).ok()?;
        manifest.files.push("version.txt".to_owned());
        let mut remaining = TOTAL_LIMIT;
        let mut files = HashMap::new();
        for name in manifest.files {
            if !is_app_asset(&name, &app_directory) {
                continue;
            }
            let path = format!("{prefix}/{name}");
            if is_reserved(&path) || files.contains_key(&path) {
                continue;
            }
            if let Some(asset) =
                Asset::read(&root, &name, !prefix.is_empty(), remaining.min(FILE_LIMIT))
            {
                remaining -= asset.bytes.len();
                files.insert(path, asset);
            }
        }
        let home = format!("{prefix}/");
        if !is_reserved(&home)
            && let Some(index) = files.get(&format!("{prefix}/index.html"))
        {
            files.insert(
                home,
                Asset {
                    bytes: index.bytes.clone(),
                    headers: index.headers.clone(),
                    modified: index.modified,
                },
            );
        }
        Some(files)
    }

    pub fn select(&self, request: &Request<Incoming>, gate: bool) -> Option<Delivery<'_>> {
        if !matches!(*request.method(), Method::GET | Method::HEAD)
            || !request.body().is_end_stream()
        {
            return None;
        }
        let path = request.uri().path();
        let asset = self.files.get(path)?;
        let headers = request.headers();
        if [
            header::UPGRADE,
            header::IF_MATCH,
            header::IF_UNMODIFIED_SINCE,
            header::EXPECT,
        ]
        .iter()
        .any(|key| headers.contains_key(key))
        {
            return None;
        }
        if headers
            .get_all(header::IF_NONE_MATCH)
            .iter()
            .nth(1)
            .is_some()
        {
            return None;
        }
        let (status, range) = if asset.is_fresh(headers) {
            (StatusCode::NOT_MODIFIED, None)
        } else if let Some(value) = single_header(headers, header::RANGE)? {
            // Delegate less common range requests to the existing static handler.
            if headers.contains_key(header::IF_RANGE) {
                return None;
            }
            (
                StatusCode::PARTIAL_CONTENT,
                Some(byte_range(value, asset.bytes.len())?),
            )
        } else {
            (StatusCode::OK, None)
        };
        let needs_probe = gate
            || path.ends_with('/')
            || headers.contains_key(header::COOKIE)
            || headers.contains_key("x-forwarded-proto")
            || headers
                .get_all(header::ACCEPT)
                .iter()
                .any(|value| value.as_bytes().windows(9).any(|part| part == b"text/html"));
        Some(Delivery {
            asset,
            status,
            range,
            head: *request.method() == Method::HEAD,
            needs_probe,
        })
    }
}

fn url_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'.' | b'-' | b'_')
}

fn is_app_asset(name: &str, app_directory: &str) -> bool {
    if !name.bytes().all(url_byte)
        || name
            .split('/')
            .any(|part| part.is_empty() || part.starts_with('.') || part.ends_with('.'))
    {
        return false;
    }
    match name.split_once('/') {
        Some((folder, _)) => folder == app_directory,
        None => matches!(
            name,
            "index.html"
                | "version.txt"
                | "build-id.txt"
                | "sw.js"
                | "favicon.ico"
                | "robots.txt"
                | "manifest.webmanifest"
                | "reader.webmanifest"
                | "pwa-icon-192.png"
                | "pwa-icon-512.png"
                | "pwa-icon.svg"
                | "reader-icon-192.png"
                | "reader-icon-512.png"
                | "reader-icon.svg"
                | "reader-favicon.ico"
                | "shelves-icon.svg"
                | "inpx-reader-download-qr.svg"
        ),
    }
}

impl Asset {
    fn read(root: &Path, name: &str, prefixed: bool, limit: usize) -> Option<Self> {
        let (mime, rewritable) = content_type(name)?;
        let path = root.join(name).canonicalize().ok()?;
        if !path.starts_with(root)
            || (prefixed && rewritable && !root.join(format!("{name}.replaced")).is_file())
        {
            return None;
        }
        let file = File::open(path).ok()?;
        let metadata = file.metadata().ok()?;
        let length = usize::try_from(metadata.len()).ok()?;
        if !metadata.is_file() || length > limit {
            return None;
        }
        let elapsed = metadata.modified().ok()?.duration_since(UNIX_EPOCH).ok()?;
        // fs.Stats.mtime rounds fractional milliseconds before creating the Date.
        let millis = (elapsed.as_secs() as f64 * 1000.0
            + f64::from(elapsed.subsec_nanos()) / 1_000_000.0)
            .round() as u64;
        if millis / 1000 >= 253_402_300_800 {
            return None; // An HTTP date has a four-digit year.
        }
        let modified = UNIX_EPOCH + Duration::from_secs(millis / 1000);
        let mut bytes = Vec::with_capacity(length);
        file.take(length as u64 + 1).read_to_end(&mut bytes).ok()?;
        if bytes.len() != length {
            return None;
        }
        let mut headers = HeaderMap::new();
        headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(mime));
        headers.insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static(cache_control(name)),
        );
        headers.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
        headers.insert(
            header::ETAG,
            HeaderValue::from_str(&format!("W/\"{length:x}-{millis:x}\"")).ok()?,
        );
        headers.insert(
            header::LAST_MODIFIED,
            HeaderValue::from_str(&httpdate::fmt_http_date(modified)).ok()?,
        );
        headers.insert(
            "x-robots-tag",
            HeaderValue::from_static("noindex, nofollow"),
        );
        Some(Self {
            bytes: Bytes::from(bytes),
            headers,
            modified,
        })
    }

    fn is_fresh(&self, headers: &HeaderMap) -> bool {
        let has_no_cache = headers
            .get_all(header::CACHE_CONTROL)
            .iter()
            .filter_map(|value| value.to_str().ok())
            .flat_map(|value| value.split(','))
            .any(|token| token.trim() == "no-cache");
        let matches_etag = |value: &str| {
            let tag = self.headers[header::ETAG].to_str().expect("ASCII ETag");
            value == "*"
                || value
                    .split(',')
                    .map(str::trim)
                    .any(|candidate| candidate.strip_prefix("W/").unwrap_or(candidate) == &tag[2..])
        };
        let tag = headers
            .get(header::IF_NONE_MATCH)
            .filter(|value| !value.is_empty());
        let date = headers
            .get(header::IF_MODIFIED_SINCE)
            .filter(|value| !value.is_empty());
        !has_no_cache
            && (tag.is_some() || date.is_some())
            && tag.is_none_or(|value| value.to_str().is_ok_and(matches_etag))
            && date.is_none_or(|value| {
                value
                    .to_str()
                    .ok()
                    .and_then(|date| httpdate::parse_http_date(date).ok())
                    .is_some_and(|time| time >= self.modified)
            })
    }
}

impl Delivery<'_> {
    pub fn response(self, security: Option<&HeaderMap>) -> Response<Body> {
        let mut headers = self.asset.headers.clone();
        if let Some(security) = security {
            for name in [
                header::SET_COOKIE,
                header::STRICT_TRANSPORT_SECURITY,
                header::CONTENT_SECURITY_POLICY,
            ] {
                for value in security.get_all(&name) {
                    headers.append(&name, value.clone());
                }
            }
        }
        let bytes = if self.status == StatusCode::NOT_MODIFIED {
            headers.remove(header::CONTENT_TYPE);
            Bytes::new()
        } else {
            let bytes = if let Some(range) = self.range {
                headers.insert(
                    header::CONTENT_RANGE,
                    HeaderValue::from_str(&format!(
                        "bytes {}-{}/{}",
                        range.start,
                        range.end - 1,
                        self.asset.bytes.len()
                    ))
                    .expect("valid byte range"),
                );
                self.asset.bytes.slice(range)
            } else {
                self.asset.bytes.clone()
            };
            headers.insert(header::CONTENT_LENGTH, HeaderValue::from(bytes.len()));
            if self.head { Bytes::new() } else { bytes }
        };
        let mut response = Response::new(body(bytes));
        *response.status_mut() = self.status;
        *response.headers_mut() = headers;
        response
    }
}

fn single_header(headers: &HeaderMap, name: HeaderName) -> Option<Option<&str>> {
    let mut values = headers.get_all(name).into_iter();
    let value = values.next().map(HeaderValue::to_str).transpose().ok()?;
    (values.next().is_none()).then_some(value)
}

fn byte_range(value: &str, length: usize) -> Option<Range<usize>> {
    let (start, end) = value.strip_prefix("bytes=")?.split_once('-')?;
    let number = |part: &str| {
        (!part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
            .then(|| part.parse::<usize>().ok())
            .flatten()
    };
    if start.is_empty() {
        let count = number(end)?;
        return (count != 0 && length != 0).then(|| length.saturating_sub(count)..length);
    }
    let start = number(start)?;
    let end = if end.is_empty() {
        length
    } else {
        number(end)?.saturating_add(1).min(length)
    };
    (start < end).then_some(start..end)
}

fn cache_control(name: &str) -> &'static str {
    let file = name.rsplit('/').next().unwrap_or(name);
    match file {
        "index.html" => "no-cache, must-revalidate",
        "sw.js"
        | "manifest.webmanifest"
        | "reader.webmanifest"
        | "build-id.txt"
        | "version.txt" => "no-store",
        _ => {
            let mut parts = file.rsplit('.');
            let immutable = matches!(parts.next(), Some("js" | "css"))
                && parts.next().is_some_and(|hash| {
                    hash.len() >= 8 && hash.bytes().all(|byte| byte.is_ascii_hexdigit())
                })
                && parts.next().is_some();
            if immutable {
                "public, max-age=2592000, immutable"
            } else {
                "public, max-age=0"
            }
        }
    }
}

fn content_type(name: &str) -> Option<(&'static str, bool)> {
    Some(match name.rsplit('.').next()? {
        "html" => ("text/html; charset=UTF-8", true),
        "js" => ("application/javascript; charset=UTF-8", true),
        "css" => ("text/css; charset=UTF-8", true),
        "txt" => ("text/plain; charset=UTF-8", false),
        "json" | "map" => ("application/json; charset=UTF-8", false),
        "webmanifest" => ("application/manifest+json", false),
        "ico" => ("image/x-icon", false),
        "svg" => ("image/svg+xml", false),
        "png" => ("image/png", false),
        "webp" => ("image/webp", false),
        "jpg" | "jpeg" => ("image/jpeg", false),
        "woff" => ("font/woff", false),
        "woff2" => ("font/woff2", false),
        "ttf" => ("font/ttf", false),
        "wasm" => ("application/wasm", false),
        _ => return None,
    })
}
