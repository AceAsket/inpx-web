use std::fs::{File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom};
use std::ops::Range;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll, ready};

use http_body_util::{BodyExt, Limited};
use hyper::body::{Body as StreamBody, Bytes, Frame, Incoming, SizeHint};
use hyper::header::{self, HeaderMap, HeaderName, HeaderValue};
use hyper::{Method, Request, Response, StatusCode};
use serde::Deserialize;
use tokio::io::{AsyncRead, ReadBuf};

use crate::file_conditions::FileVersion;
use crate::http::{Body, BodyError, body, error};
use crate::receipts::{Receipt, Receipts};
use crate::upstream::Upstream;

pub(crate) const MODEL: HeaderName = HeaderName::from_static("x-inpx-file");
const FRAME: usize = 64 * 1024;
const INLINE: u64 = 128 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Config {
    book_route: String,
    cover_route: String,
    book: PathBuf,
    cover: PathBuf,
    batch: Option<PathBuf>,
}

#[derive(Deserialize)]
struct Model {
    kind: Kind,
    name: String,
    delivery: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Kind {
    Book,
    Cover,
    Batch,
}

#[derive(Clone, Copy)]
pub(crate) enum Route {
    Book,
    Cover,
}

impl Config {
    pub fn route(&self, path: &str, method: &Method, headers: &HeaderMap) -> Option<Route> {
        if !matches!(*method, Method::GET | Method::HEAD) || headers.contains_key(header::UPGRADE) {
            return None;
        }
        let below = |root: &str| path.strip_prefix(root)?.strip_prefix('/');
        if let Some(book) = below(&self.book_route) {
            let key = book.split('/').next().unwrap_or_default();
            if key == "batch" || hex(key, 128) {
                return Some(Route::Book);
            }
        }
        below(&self.cover_route).map(|_| Route::Cover)
    }

    fn path(&self, model: &Model) -> Option<PathBuf> {
        let name = &model.name;
        if name.is_empty()
            || name.len() > 240
            || name.starts_with('.')
            || name.ends_with('.')
            || !name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
        {
            return None;
        }
        let root = match model.kind {
            Kind::Book => {
                let (hash, suffix) = name.split_once('.').unwrap_or((name, ""));
                if !hex(hash, 128)
                    || !matches!(suffix, "" | "raw")
                        && !suffix.starts_with("converted-")
                        && !suffix
                            .strip_prefix("download-v3-")
                            .and_then(|value| value.strip_suffix(".zip"))
                            .is_some_and(|value| value.len() == 16 && hex(value, 16))
                {
                    return None;
                }
                &self.book
            }
            Kind::Cover => {
                if !name
                    .rsplit_once('.')
                    .is_some_and(|(_, ext)| matches!(ext, "jpg" | "png" | "gif"))
                {
                    return None;
                }
                &self.cover
            }
            Kind::Batch => {
                let token = name.strip_prefix("batch-")?.strip_suffix(".zip")?;
                if token.len() != 64 || !hex(token, 64) {
                    return None;
                }
                self.batch.as_ref()?
            }
        };
        Some(root.join(name))
    }
}

fn hex(value: &str, limit: usize) -> bool {
    !value.is_empty() && value.len() <= limit && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn open(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        options.custom_flags(OPEN_REPARSE_POINT);
    }
    options.open(path)
}

enum Data {
    Empty,
    Buffered(Bytes),
    Stream(File),
}

struct Prepared {
    version: FileVersion,
    status: StatusCode,
    total: u64,
    range: Range<u64>,
    data: Data,
}

fn prepare(path: &Path, conditions: &HeaderMap, head: bool) -> io::Result<Prepared> {
    let mut file = open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || is_reparse_point(&metadata) {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            "no regular cache file",
        ));
    }
    let total = metadata.len();
    let version = FileVersion::from_metadata(total, metadata.modified()?)
        .ok_or_else(|| io::Error::other("invalid cache modification time"))?;
    if let Some(status) = version.check(conditions) {
        return Ok(Prepared {
            version,
            status,
            total,
            range: 0..0,
            data: Data::Empty,
        });
    }
    let (status, range) = match version.range(conditions, total) {
        Ok(Some(range)) => (StatusCode::PARTIAL_CONTENT, range),
        Ok(None) => (StatusCode::OK, 0..total),
        Err(()) => {
            return Ok(Prepared {
                version,
                status: StatusCode::RANGE_NOT_SATISFIABLE,
                total,
                range: 0..0,
                data: Data::Empty,
            });
        }
    };
    let length = range.end - range.start;
    let data = if head || length == 0 {
        Data::Empty
    } else {
        if range.start != 0 {
            file.seek(SeekFrom::Start(range.start))?;
        }
        if length <= INLINE {
            let mut bytes = vec![0; length as usize];
            file.read_exact(&mut bytes)?;
            Data::Buffered(Bytes::from(bytes))
        } else {
            Data::Stream(file)
        }
    };
    Ok(Prepared {
        version,
        status,
        total,
        range,
        data,
    })
}

pub(crate) struct Delivery {
    pub parts: hyper::http::response::Parts,
    model: Model,
    receipt: Option<Receipt>,
}

pub(crate) enum Reply {
    Proxy(Response<Incoming>),
    File(Delivery),
}

pub(crate) async fn resolve(
    upstream: Arc<Upstream>,
    request: Request<Incoming>,
    receipts: Receipts,
    route: Route,
) -> Result<Reply, ()> {
    let receive = async move {
        let mut response = upstream.send(request).await.map_err(|_| ())?;
        let Some(marker) = response.headers_mut().remove(&MODEL) else {
            return Ok(Reply::Proxy(response));
        };
        if marker != "1" || response.status() != StatusCode::OK {
            return Err(());
        }
        let (parts, input) = response.into_parts();
        let input = Limited::new(input, 4096).collect().await.map_err(|_| ())?;
        let model: Model = serde_json::from_slice(&input.to_bytes()).map_err(|_| ())?;
        let receipt = model.delivery.map(|id| receipts.start(id));
        Ok(Reply::File(Delivery {
            parts,
            model,
            receipt,
        }))
    };
    match route {
        // Read and release a ticket even if the client disconnects before the headers.
        Route::Book => tokio::spawn(receive).await.map_err(|_| ())?,
        Route::Cover => receive.await,
    }
}

pub(crate) async fn send(
    delivery: Delivery,
    config: &Config,
    conditions: HeaderMap,
    head: bool,
    receipts: &Receipts,
) -> Response<Body> {
    let Delivery {
        mut parts,
        model,
        receipt,
    } = delivery;
    let Some(path) = config.path(&model) else {
        return error(StatusCode::BAD_GATEWAY);
    };
    let prepared = match tokio::task::spawn_blocking(move || prepare(&path, &conditions, head))
        .await
    {
        Ok(Ok(prepared)) => prepared,
        Ok(Err(failure))
            if matches!(
                failure.kind(),
                io::ErrorKind::NotFound | io::ErrorKind::NotADirectory
            ) || link_open_error().is_some_and(|code| failure.raw_os_error() == Some(code)) =>
        {
            return error(StatusCode::NOT_FOUND);
        }
        _ => return error(StatusCode::INTERNAL_SERVER_ERROR),
    };
    let Prepared {
        version,
        status,
        total,
        range,
        data,
    } = prepared;
    parts.status = status;
    let headers = &mut parts.headers;
    headers.remove(header::TRANSFER_ENCODING);
    headers.remove(HeaderName::from_static("x-powered-by"));
    headers.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    headers
        .entry(header::CACHE_CONTROL)
        .or_insert(HeaderValue::from_static("public, max-age=0"));
    headers.insert(
        header::ETAG,
        HeaderValue::from_str(&version.etag).expect("valid cache ETag"),
    );
    headers.insert(
        header::LAST_MODIFIED,
        HeaderValue::from_str(&httpdate::fmt_http_date(version.modified))
            .expect("valid cache date"),
    );
    if !status.is_success() {
        for field in [
            header::CONTENT_ENCODING,
            header::CONTENT_LANGUAGE,
            header::CONTENT_RANGE,
            header::CONTENT_LENGTH,
            header::CONTENT_TYPE,
        ] {
            headers.remove(field);
        }
        if status == StatusCode::NOT_MODIFIED {
            return Response::from_parts(parts, body(Bytes::new()));
        }
        if status == StatusCode::RANGE_NOT_SATISFIABLE {
            headers.insert(
                header::CONTENT_RANGE,
                HeaderValue::from_str(&format!("bytes */{total}")).expect("valid file length"),
            );
        }
        let message = Bytes::from_static(status.canonical_reason().unwrap_or_default().as_bytes());
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("text/plain; charset=utf-8"),
        );
        headers.insert(header::CONTENT_LENGTH, HeaderValue::from(message.len()));
        return Response::from_parts(parts, body(if head { Bytes::new() } else { message }));
    }
    headers
        .entry(header::CONTENT_TYPE)
        .or_insert(HeaderValue::from_static("application/octet-stream"));
    let length = range.end - range.start;
    headers.insert(header::CONTENT_LENGTH, HeaderValue::from(length));
    if status == StatusCode::PARTIAL_CONTENT {
        headers.insert(
            header::CONTENT_RANGE,
            HeaderValue::from_str(&format!("bytes {}-{}/{total}", range.start, range.end - 1))
                .expect("valid byte range"),
        );
    }
    let whole = !head && length == total;
    let payload = match data {
        Data::Empty => {
            if let Some(receipt) = receipt {
                receipts.ready(receipt, whole);
            }
            body(Bytes::new())
        }
        Data::Buffered(bytes) => {
            FileBody::new(Payload::Buffered(bytes), length, receipts, receipt, whole).boxed_unsync()
        }
        Data::Stream(file) => {
            let mut file = tokio::fs::File::from_std(file);
            file.set_max_buf_size(FRAME);
            FileBody::new(
                Payload::Stream(file, Vec::new()),
                length,
                receipts,
                receipt,
                whole,
            )
            .boxed_unsync()
        }
    };
    Response::from_parts(parts, payload)
}

#[cfg(unix)]
fn link_open_error() -> Option<i32> {
    Some(libc::ELOOP)
}
#[cfg(not(unix))]
fn link_open_error() -> Option<i32> {
    None
}

#[cfg(windows)]
fn is_reparse_point(metadata: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_attributes() & 0x400 != 0
}

#[cfg(not(windows))]
fn is_reparse_point(_metadata: &std::fs::Metadata) -> bool {
    false
}

enum Payload {
    Buffered(Bytes),
    Stream(tokio::fs::File, Vec<u8>),
}

struct FileBody {
    payload: Payload,
    remaining: u64,
    receipts: Receipts,
    receipt: Option<Receipt>,
    whole: bool,
}

impl FileBody {
    fn new(
        payload: Payload,
        remaining: u64,
        receipts: &Receipts,
        receipt: Option<Receipt>,
        whole: bool,
    ) -> Self {
        Self {
            payload,
            remaining,
            receipts: receipts.clone(),
            receipt,
            whole,
        }
    }
}

impl StreamBody for FileBody {
    type Data = Bytes;
    type Error = BodyError;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, BodyError>>> {
        if self.remaining == 0 {
            return Poll::Ready(None);
        }
        let length = self.remaining.min(FRAME as u64) as usize;
        let bytes = match &mut self.payload {
            Payload::Buffered(bytes) => std::mem::take(bytes),
            Payload::Stream(file, scratch) => {
                scratch.resize(length, 0);
                let mut read = ReadBuf::new(scratch);
                ready!(Pin::new(file).poll_read(cx, &mut read))?;
                let actual = read.filled().len();
                let mut bytes = std::mem::take(scratch);
                bytes.truncate(actual);
                Bytes::from(bytes)
            }
        };
        if bytes.is_empty() {
            return Poll::Ready(Some(Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "cache file changed during delivery",
            )
            .into())));
        }
        self.remaining -= bytes.len() as u64;
        if self.remaining == 0
            && let Some(receipt) = self.receipt.take()
        {
            self.receipts.ready(receipt, self.whole);
        }
        Poll::Ready(Some(Ok(Frame::data(bytes))))
    }

    fn is_end_stream(&self) -> bool {
        self.remaining == 0
    }

    fn size_hint(&self) -> SizeHint {
        SizeHint::with_exact(self.remaining)
    }
}
