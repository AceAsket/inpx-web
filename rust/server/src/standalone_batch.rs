use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use http_body_util::BodyExt;
use hyper::header::{self, HeaderMap, HeaderValue};
use hyper::{Request, Response, StatusCode, body::Incoming};
use inpx_catalog::Result;
use inpx_catalog::book_batch::{self, Batch, MAX_BOOKS};
use serde_json::{Value, json};

use super::{State, delivery::Queue};
use crate::http::{Body, error};
use crate::request_access::Admission;
use crate::standalone_access::BrowserProfileRequest;
use crate::standalone_download::{self, Prepared, load_book};

const LIFE: Duration = Duration::from_secs(15 * 60);
const LIMIT: u64 = 1024 * 1024 * 1024;
const FULL: &str = "Кэш пакетных ZIP заполнен. Повторите через 15 минут.";

pub(super) struct Downloads {
    root: String,
    directory: PathBuf,
    tickets: Mutex<HashMap<String, Arc<Ticket>>>,
    queue: Queue,
}

struct Ticket {
    owner: String,
    path: PathBuf,
    count: usize,
    bytes: u64,
    expires: Instant,
}

impl Drop for Ticket {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

impl Downloads {
    pub(super) fn new(data: &Path, book_root: &str) -> Self {
        Self {
            root: format!("{book_root}/batch/"),
            directory: data.join("batch-downloads"),
            tickets: Mutex::new(HashMap::new()),
            queue: Queue::new(1, 4, "batch-download", "Подготовка пакетного ZIP"),
        }
    }

    pub(super) fn matches(&self, path: &str) -> bool {
        path.starts_with(&self.root)
    }

    pub(super) fn tasks(&self, owner: &str, admin: bool) -> Vec<Value> {
        self.queue.tasks(owner, admin)
    }

    pub(super) fn prepare(
        &self,
        state: &State,
        profile: BrowserProfileRequest<'_>,
        selection: &Value,
    ) -> Result<Value> {
        let owner = state
            .access
            .with_profile(profile, |_, owner, _| Ok(owner.into()))?;
        let owner = owner.as_str().ok_or("need_profile_login")?;
        let task = self.queue.enter(owner)?;
        let uids = select(state, profile, selection)?;
        let output_budget = {
            let mut tickets = self.tickets.lock().expect("batch tickets");
            prune(&mut tickets);
            let retained: u64 = tickets.values().map(|ticket| ticket.bytes).sum();
            if tickets.len() >= 256 || retained >= LIMIT {
                return Err(FULL.into());
            }
            LIMIT - retained
        };
        std::fs::create_dir_all(&self.directory)?;
        let token = super::delivery::random_id()?;
        let path = self.directory.join(format!("batch-{token}.zip"));
        let mut archive = Batch::open(path.clone(), output_budget)?;
        let mut names = HashSet::new();
        task.progress("Подготовка ZIP", 0, uids.len());
        for (index, uid) in uids.iter().enumerate() {
            let mut add = || -> Result<()> {
                let book =
                    load_book(&state.index.catalogue, uid)?.ok_or("Книга не найдена в каталоге")?;
                let file = state
                    .downloads
                    .raw_book(&book, &state.index.sources())
                    .map_err(super::delivery::book_error)?;
                let name =
                    book_batch::entry_name(&book, state.downloads.template(), index, &mut names)?;
                archive.add_file(&file, name)
            };
            if let Err(error) = add() {
                return Ok(
                    json!({"error":format!("Книга {} из {}: {error}",index+1,uids.len()),
                    "bookUid":uid,"bookIndex":index,"count":uids.len()}),
                );
            }
            task.progress("Подготовка ZIP", index + 1, uids.len());
        }
        let bytes = archive.finish()?;
        let ticket = Arc::new(Ticket {
            owner: owner.into(),
            path,
            count: uids.len(),
            bytes,
            expires: Instant::now() + LIFE,
        });
        self.tickets
            .lock()
            .expect("batch tickets")
            .insert(token.clone(), ticket);
        Ok(json!({"url":format!("{}{token}", self.root),"count":uids.len()}))
    }

    pub(super) async fn serve(
        &self,
        state: &Arc<State>,
        request: Request<Incoming>,
        admission: Admission,
    ) -> Response<Body> {
        let head = request.method() == hyper::Method::HEAD;
        let token = request
            .uri()
            .path()
            .strip_prefix(&self.root)
            .unwrap_or_default();
        let ticket = self
            .tickets
            .lock()
            .expect("batch tickets")
            .get(token)
            .filter(|ticket| ticket.expires > Instant::now())
            .cloned();
        let Some(ticket) = ticket else {
            return error(StatusCode::NOT_FOUND);
        };
        let conditions = request.headers().clone();
        let server = state.clone();
        let expected_owner = ticket.owner.clone();
        let grant = tokio::task::spawn_blocking(move || {
            let grant = server.access.check(
                &request,
                &admission,
                inpx_catalog::opds_access::Resource::Download,
            )?;
            Ok::<_, crate::standalone_access::Rejection>(server.access.download_profile(
                request.headers(),
                admission.cookie_port,
                &grant,
            ))
        })
        .await;
        match grant {
            Ok(Ok(Some(owner))) if owner != expected_owner => return error(StatusCode::FORBIDDEN),
            Ok(Err(rejected)) => return rejected.response(),
            Err(_) => return error(StatusCode::INTERNAL_SERVER_ERROR),
            _ => {}
        }
        let mut headers = HeaderMap::new();
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/zip"),
        );
        headers.insert(
            header::CONTENT_DISPOSITION,
            HeaderValue::from_static("attachment; filename=\"books.zip\""),
        );
        headers.insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static("private, no-store"),
        );
        let prepared = Prepared::File {
            path: ticket.path.clone(),
            headers,
        };
        let mut response = standalone_download::respond(Ok(prepared), conditions, head).await;
        if !head && let Some(activity) = &state.metrics.activity {
            response = super::metrics::track_downloads(
                response,
                activity,
                Some(expected_owner),
                ticket.count as u64,
            );
        }
        response.map(|body| {
            body.map_frame(move |frame| {
                let _lease = &ticket;
                frame
            })
            .boxed_unsync()
        })
    }

    pub(super) fn cleanup(&self) {
        prune(&mut self.tickets.lock().expect("batch tickets"));
    }
}

fn prune(tickets: &mut HashMap<String, Arc<Ticket>>) {
    let now = Instant::now();
    tickets.retain(|_, ticket| ticket.expires > now || Arc::strong_count(ticket) > 1);
}

fn select(
    state: &State,
    profile: BrowserProfileRequest<'_>,
    selection: &Value,
) -> Result<Vec<String>> {
    let list = selection["listId"].as_str().unwrap_or_default().trim();
    let series = selection["series"].as_str().unwrap_or_default();
    let values = state.access.with_profile(profile, |store, owner, stamp| {
        if list.is_empty() {
            return Ok(selection["bookUids"].clone());
        }
        let catalogue = state.index.catalogue.read().expect("open catalogue");
        let catalogue = catalogue
            .as_ref()
            .ok_or("Каталог недоступен. Перезапустите сервер.")?;
        store.batch_shelf(owner, stamp, list, catalogue)
    })?;
    let values = if list.is_empty() && !series.is_empty() {
        if series.encode_utf16().count() > 100 {
            return Err("Для длинного названия серии выберите книги вручную".into());
        }
        let query =
            json!({"series":format!("={series}"),"del":"0","limit":MAX_BOOKS,"hideCopies":false});
        let catalogue = state.index.catalogue.read().expect("open catalogue");
        let catalogue = catalogue
            .as_ref()
            .ok_or("Каталог недоступен. Перезапустите сервер.")?;
        let mut result = catalogue.browser_books(query.as_object().expect("series query"))?;
        if result["totalFound"].as_u64().unwrap_or_default() > MAX_BOOKS as u64 {
            return Err("В одном ZIP может быть не больше 200 книг".into());
        }
        let mut rows = result["found"]
            .take()
            .as_array_mut()
            .map(std::mem::take)
            .unwrap_or_default();
        rows.sort_by(|a, b| {
            a["serno"]
                .as_f64()
                .unwrap_or_default()
                .total_cmp(&b["serno"].as_f64().unwrap_or_default())
                .then_with(|| a["title"].as_str().cmp(&b["title"].as_str()))
        });
        Value::Array(
            rows.into_iter()
                .map(|mut book| book["_uid"].take())
                .collect(),
        )
    } else {
        values
    };
    let values = values
        .as_array()
        .filter(|uids| (1..=MAX_BOOKS).contains(&uids.len()))
        .ok_or("Выберите от 1 до 200 книг")?;
    let mut unique = HashSet::new();
    let mut uids = Vec::with_capacity(values.len());
    for value in values {
        let uid = value
            .as_str()
            .map(str::trim)
            .filter(|uid| !uid.is_empty() && uid.encode_utf16().count() <= 512)
            .ok_or("Некорректный идентификатор книги")?;
        if unique.insert(uid) {
            uids.push(uid.to_owned());
        }
    }
    Ok(uids)
}
