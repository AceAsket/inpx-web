use std::fs::File;
use std::path::Path;
use std::sync::Arc;

use hyper::body::{Bytes, Incoming};
use hyper::header::{self, HeaderMap, HeaderValue};
use hyper::{Method, Request, Response, StatusCode};
use inpx_catalog::legacy_library_files::{Covers, MissingDecoder, reader_lab_source};
use inpx_catalog::opds_access::Resource;
use percent_encoding::percent_decode_str;
use serde_json::Value;

use super::State;
use crate::download;
use crate::http::{Body, body, error};
use crate::request_access::Admission;
use crate::standalone_download::Prepared;

pub(super) struct Routes {
    reset: String,
    reset_page: Bytes,
    reader_lab: String,
    cover: String,
    covers: Covers,
}

pub(super) enum Route {
    Reset,
    ReaderLab(String),
    Cover(String),
}

enum FileReply {
    Lab(File),
    Cover(Prepared),
}

impl Routes {
    pub(super) fn new(prefix: &str, exec: &Path, config: &Value) -> Self {
        let root = prefix.trim().trim_matches('/');
        let prefix = if root.is_empty() {
            String::new()
        } else {
            format!("/{root}")
        };
        let base = Value::String(format!("{prefix}/"))
            .to_string()
            .replace('<', "\\u003c");
        let page = include_str!("../../../shared/app-reset.html")
            .trim_end()
            .replace("__INPX_APP_BASE_PATH__", &base);
        Self {
            reset: format!("{prefix}/app-reset"),
            reset_page: page.into(),
            reader_lab: format!("{prefix}/reader-lab-source/"),
            cover: format!("{prefix}/cover/"),
            covers: Covers::new(exec, config),
        }
    }

    pub(super) fn route(&self, request: &Request<Incoming>) -> Option<Route> {
        if !matches!(*request.method(), Method::GET | Method::HEAD) {
            return None;
        }
        let path = request.uri().path().trim_end_matches('/');
        if path == self.reset {
            return Some(Route::Reset);
        }
        if let Some(file) = path
            .strip_prefix(&self.reader_lab)
            .filter(|file| !file.contains('/'))
        {
            return Some(Route::ReaderLab(file.into()));
        }
        path.strip_prefix(&self.cover)
            .filter(|path| *path != "by-uid")
            .map(|path| Route::Cover(path.into()))
    }

    pub(super) async fn serve(
        state: &Arc<State>,
        route: Route,
        request: Request<Incoming>,
        admission: Admission,
    ) -> Response<Body> {
        let head = request.method() == Method::HEAD;
        if matches!(route, Route::Reset) {
            return state.legacy.recovery(head);
        }
        let cover = matches!(&route, Route::Cover(_));
        let Ok(permit) = state.download_slots.clone().try_acquire_owned() else {
            return error(StatusCode::SERVICE_UNAVAILABLE);
        };
        let state = state.clone();
        let conditions = request.headers().clone();
        let result = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            let grant = state
                .access
                .check(&request, &admission, Resource::Download)
                .map_err(|rejected| Box::new(rejected.response()))?;
            let sources = state.index.sources();
            let file = match route {
                Route::Cover(path) => state
                    .legacy
                    .cover_file(&path, sources, state.downloads.cache())
                    .map(FileReply::Cover),
                Route::ReaderLab(file) => {
                    let decoded = percent_decode_str(&file).decode_utf8().ok();
                    sources
                        .first()
                        .zip(decoded)
                        .and_then(|(source, file)| reader_lab_source(&source.lib_dir, &file).ok())
                        .map(FileReply::Lab)
                        .ok_or(StatusCode::NOT_FOUND)
                }
                Route::Reset => unreachable!(),
            };
            file.map(|file| (file, grant.private()))
                .map_err(|status| Box::new(error(status)))
        })
        .await;
        let (file, private) = match result {
            Ok(Ok(reply)) => reply,
            Ok(Err(response)) => return *response,
            Err(_) => return error(StatusCode::INTERNAL_SERVER_ERROR),
        };
        let mut response = match file {
            FileReply::Lab(file) => {
                download::send_open(
                    file,
                    HeaderMap::from_iter([
                        (
                            header::CONTENT_TYPE,
                            HeaderValue::from_static("application/xml; charset=utf-8"),
                        ),
                        (header::CACHE_CONTROL, HeaderValue::from_static("no-store")),
                    ]),
                    conditions,
                    head,
                )
                .await
            }
            FileReply::Cover(cover) => {
                crate::standalone_download::respond(Ok(cover), conditions, head).await
            }
        };
        if private && cover {
            crate::standalone_access::private(response.headers_mut());
        }
        response
    }

    fn recovery(&self, head: bool) -> Response<Body> {
        Response::builder()
            .header(header::CACHE_CONTROL, "no-store, no-cache, must-revalidate")
            .header(header::PRAGMA, "no-cache")
            .header(header::EXPIRES, "0")
            .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
            .header(header::CONTENT_LENGTH, self.reset_page.len())
            .body(body(if head {
                Bytes::new()
            } else {
                self.reset_page.clone()
            }))
            .expect("static recovery page headers")
    }

    fn cover_file(
        &self,
        path: &str,
        sources: Arc<Vec<inpx_catalog::library_sources::Source>>,
        cache: &Path,
    ) -> Result<Prepared, StatusCode> {
        let (source, libid) = path.split_once('/').unwrap_or(("", path));
        if libid.contains('/') {
            return Err(StatusCode::NOT_FOUND);
        }
        let (Ok(source), Ok(libid)) = (
            percent_decode_str(source).decode_utf8(),
            percent_decode_str(libid).decode_utf8(),
        ) else {
            return Err(StatusCode::NOT_FOUND);
        };
        let id = libid.trim_start();
        let id = id.strip_prefix('+').unwrap_or(id);
        let digits = &id[..id.bytes().take_while(u8::is_ascii_digit).count()];
        let id = digits
            .parse::<u64>()
            .ok()
            .filter(|id| *id > 0)
            .ok_or(StatusCode::NOT_FOUND)?;
        let source = source.trim();
        let image = self
            .covers
            .read(sources, (!source.is_empty()).then_some(source), id, cache)
            .map_err(|error| {
                if error.is::<MissingDecoder>() {
                    StatusCode::SERVICE_UNAVAILABLE
                } else {
                    StatusCode::NOT_FOUND
                }
            })?
            .ok_or(StatusCode::NOT_FOUND)?;
        let path = image
            .stage(cache)
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        let headers = HeaderMap::from_iter([
            (
                header::CONTENT_TYPE,
                HeaderValue::from_static(image.content_type),
            ),
            (
                header::CACHE_CONTROL,
                HeaderValue::from_static("private, no-cache"),
            ),
            (
                header::X_CONTENT_TYPE_OPTIONS,
                HeaderValue::from_static("nosniff"),
            ),
        ]);
        Ok(Prepared::File { path, headers })
    }
}
