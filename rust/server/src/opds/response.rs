use std::fmt::Write;

use http_body_util::{BodyExt, Limited};
use hyper::body::{Bytes, Incoming};
use hyper::header::{self, HeaderMap, HeaderName, HeaderValue};
use hyper::{Method, Response, StatusCode};
use sha2::{Digest, Sha256};

use super::{Model, atom, render};
use crate::http::{Body, body};

pub(crate) const MODEL: HeaderName = HeaderName::from_static("x-inpx-opds-model");
const LIMIT: usize = 16 * 1024 * 1024;

pub(crate) enum Format {
    Json,
    Atom,
    OpenSearch,
}

impl Format {
    pub(crate) fn from_response(marker: &HeaderValue, headers: &HeaderMap) -> Option<Self> {
        let kind = headers
            .get(header::CONTENT_TYPE)?
            .to_str()
            .ok()?
            .split(';')
            .next()?;
        match (marker.as_bytes(), kind) {
            (b"1", "application/opds+json" | "application/opds-publication+json") => {
                Some(Self::Json)
            }
            (b"atom", "application/atom+xml") => Some(Self::Atom),
            (b"opensearch", "application/opensearchdescription+xml") => Some(Self::OpenSearch),
            _ => None,
        }
    }
}

pub(crate) fn matches(
    path: &str,
    root: Option<&str>,
    method: &Method,
    headers: &HeaderMap,
) -> bool {
    matches!(*method, Method::GET | Method::HEAD | Method::POST)
        && !headers.contains_key(header::UPGRADE)
        && root.is_some_and(|root| {
            path.strip_prefix(root)
                .is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
        })
}

pub(crate) async fn send(
    response: Response<Incoming>,
    format: Format,
    conditions: &HeaderMap,
    head: bool,
) -> Option<Response<Body>> {
    let (parts, body_stream) = response.into_parts();
    let input = Limited::new(body_stream, LIMIT)
        .collect()
        .await
        .ok()?
        .to_bytes();
    let bytes = match format {
        Format::Json => render(serde_json::from_slice::<Model>(&input).ok()?),
        Format::Atom => atom::render(&input),
        Format::OpenSearch => atom::opensearch(&input),
    }?;
    document(parts, bytes, conditions, head)
}

pub(crate) fn document(
    mut parts: hyper::http::response::Parts,
    bytes: Vec<u8>,
    conditions: &HeaderMap,
    head: bool,
) -> Option<Response<Body>> {
    let length = bytes.len();
    let mut etag = String::with_capacity(2 + 2 + 2 * std::mem::size_of::<usize>() + 1 + 64);
    write!(etag, "W/\"{length:x}-").expect("formatting a string");
    for byte in Sha256::digest(&bytes) {
        write!(etag, "{byte:02x}").expect("formatting a string");
    }
    etag.push('"');
    let fresh = fresh(conditions, &etag);
    let headers = &mut parts.headers;
    headers.remove(header::TRANSFER_ENCODING);
    headers.remove(header::CONTENT_ENCODING);
    headers.remove(HeaderName::from_static("x-powered-by"));
    headers.insert(header::ETAG, HeaderValue::from_str(&etag).ok()?);
    if fresh {
        parts.status = StatusCode::NOT_MODIFIED;
        headers.remove(header::CONTENT_TYPE);
        headers.remove(header::CONTENT_LENGTH);
    } else {
        if let Some(content_type) = headers
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            && !content_type.contains(';')
        {
            headers.insert(
                header::CONTENT_TYPE,
                HeaderValue::from_str(&format!("{content_type}; charset=utf-8")).ok()?,
            );
        }
        headers.insert(header::CONTENT_LENGTH, HeaderValue::from(length));
    }
    let bytes = if head || fresh {
        Bytes::new()
    } else {
        Bytes::from(bytes)
    };
    Some(Response::from_parts(parts, body(bytes)))
}

fn fresh(conditions: &HeaderMap, etag: &str) -> bool {
    if conditions
        .get_all(header::CACHE_CONTROL)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .any(|value| value.trim().eq_ignore_ascii_case("no-cache"))
    {
        return false;
    }
    let tag = etag.strip_prefix("W/").unwrap_or(etag);
    conditions
        .get_all(header::IF_NONE_MATCH)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .map(str::trim)
        .any(|value| value == "*" || value.strip_prefix("W/").unwrap_or(value) == tag)
}
