use std::sync::atomic::{AtomicBool, AtomicU8, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use inpx_catalog::Result;
use inpx_catalog::catalogue_lock::OnLost;
use inpx_catalog::isbn_store::IsbnIndex;
use inpx_catalog::library_sources::Source;
use inpx_catalog::standalone_catalogue::{Catalogue, CatalogueFiles};
use serde_json::{Value, json};

use super::VERSION;

const IDLE: u8 = 0;
const CHECKING: u8 = 1;
const UPDATING: u8 = 2;

pub(super) struct Index {
    pub(super) starting: AtomicBool,
    pub(super) isbn: Arc<IsbnIndex>,
    files: RwLock<CatalogueFiles>,
    pub(super) catalogue: RwLock<Option<Catalogue>>,
    sources: RwLock<Arc<Vec<Source>>>,
    status: Mutex<Value>,
    job: AtomicU8,
    generation: AtomicU64,
    lease_lost: Arc<AtomicBool>,
    on_lease_lost: OnLost,
}

impl Index {
    pub(super) fn new(
        files: CatalogueFiles,
        sources: Arc<Vec<Source>>,
        lease_lost: Arc<AtomicBool>,
        on_lease_lost: OnLost,
    ) -> Self {
        Self {
            starting: AtomicBool::new(true),
            isbn: Arc::new(IsbnIndex::new(files.data.join("isbn-index.json"))),
            files: RwLock::new(files),
            status: Mutex::new(
                json!({"ready":false,"updating":true,"job":"open","jobMessage":"Открытие каталога"}),
            ),
            catalogue: RwLock::new(None),
            sources: RwLock::new(sources),
            job: AtomicU8::new(IDLE),
            generation: AtomicU64::new(0),
            lease_lost,
            on_lease_lost,
        }
    }

    pub(super) fn is_lease_lost(&self) -> bool {
        self.lease_lost.load(Ordering::Acquire)
            || self
                .catalogue
                .try_read()
                .ok()
                .is_some_and(|guard| guard.as_ref().is_some_and(Catalogue::is_lease_lost))
    }

    pub(super) fn close(&self) {
        self.lease_lost.store(true, Ordering::Release);
        *self.catalogue.write().unwrap_or_else(|e| e.into_inner()) = None;
        {
            let mut status = self.status.lock().unwrap_or_else(|e| e.into_inner());
            status["state"] = "database_unavailable".into();
            status["ready"] = false.into();
            status["dbLoaded"] = false.into();
            status["searchReady"] = false.into();
            status["updating"] = false.into();
            status["error"] = "Потеряна блокировка каталога".into();
        }
        self.job.store(IDLE, Ordering::Release);
    }

    pub(super) fn initialize(&self, recreate: bool) -> Result<bool> {
        let started = Instant::now();
        let mut last_output = started;
        let mut job = String::new();
        let mut message = String::new();
        let sources = self.sources();
        let files = self.files();
        let mut catalogue = files.open_or_create_with_on_lost(
            &sources,
            Some(self.on_lease_lost.clone()),
            |patch| {
                if self.lease_lost.load(Ordering::Acquire) {
                    return Err("Catalogue lease lost".into());
                }
                let mut phase_changed = false;
                let leaving_identities = job == "previous identities"
                    && patch["job"].as_str().is_some_and(|next| next != job);
                if let Some(next) = patch["job"].as_str() {
                    phase_changed = next != job
                        || patch["jobMessage"]
                            .as_str()
                            .is_some_and(|next| next != message);
                    job.clear();
                    job.push_str(next);
                }
                if let Some(next) = patch["jobMessage"].as_str() {
                    message.clear();
                    message.push_str(next);
                }
                if phase_changed || last_output.elapsed() >= Duration::from_secs(3) {
                    let mut details = String::new();
                    if let Some(records) = patch["recsLoaded"].as_u64() {
                        details = format!(" · записей {records}");
                        if let Some(total) = patch["totalRecords"].as_u64() {
                            details.push_str(&format!("/{total}"));
                        }
                    }
                    if let (Some(current), Some(total)) =
                        (patch["current"].as_u64(), patch["totalFiles"].as_u64())
                    {
                        details.push_str(&format!(" · частей {current}/{total}"));
                    }
                    if let Some(table) = patch["lookupTable"].as_str() {
                        details.push_str(&format!(" · {table}"));
                    }
                    let level = if matches!(job.as_str(), "checkpoint" | "resume" | "migration") {
                        log::Level::Info
                    } else {
                        log::Level::Debug
                    };
                    log::log!(target: "inpx::index", level,
                        "Индекс [{job}, {:.1} с]: {message}{details}",
                        started.elapsed().as_secs_f64()
                    );
                    last_output = Instant::now();
                }
                let mut status = self.status.lock().expect("index status");
                if leaving_identities {
                    status.as_object_mut().unwrap().remove("recsLoaded");
                }
                if matches!(job.as_str(), "migration" | "resume") {
                    status["migration"] = true.into();
                }
                if phase_changed {
                    for field in [
                        "sourceName",
                        "current",
                        "totalFiles",
                        "totalRecords",
                        "lookupTable",
                    ] {
                        status.as_object_mut().unwrap().remove(field);
                    }
                }
                status
                    .as_object_mut()
                    .unwrap()
                    .extend(patch.as_object().expect("progress object").clone());
                Ok(())
            },
        )?;
        catalogue.attach_isbn_index(self.isbn.clone());
        if self.isbn.has_saved() {
            catalogue.refresh_isbn_signature(&sources)?;
        }
        let created = catalogue.created;
        if created {
            log::info!(target: "inpx::index",
                "Индекс [ready, {:.1} с]: каталог готов, записей {}",
                started.elapsed().as_secs_f64(),
                catalogue.stats["recsLoaded"].as_u64().unwrap_or_default()
            );
        }
        {
            let mut active = self.catalogue.write().expect("open catalogue");
            if self.lease_lost.load(Ordering::Acquire) || catalogue.is_lease_lost() {
                drop(active);
                drop(catalogue);
                return Err("Catalogue lease lost".into());
            }
            let ready = status(&catalogue, &sources);
            *active = Some(catalogue);
            *self.status.lock().expect("index status") = ready;
        }
        if recreate && !created {
            self.start(true);
            let _ = self.refresh(sources, true, files);
        }
        self.starting.store(false, Ordering::Release);
        Ok(created)
    }

    pub(super) fn snapshot(&self) -> Value {
        self.status.lock().expect("index status").clone()
    }

    pub(super) fn generation(&self) -> u64 {
        self.generation.load(Ordering::Relaxed)
    }

    pub(super) fn sources(&self) -> Arc<Vec<Source>> {
        self.sources.read().expect("library sources").clone()
    }

    pub(super) fn files(&self) -> CatalogueFiles {
        self.files.read().expect("catalogue options").clone()
    }

    pub(super) fn start(&self, force: bool) -> bool {
        if self.lease_lost.load(Ordering::Acquire) {
            return false;
        }
        let mut job = self.job.load(Ordering::Acquire);
        loop {
            let next = match job {
                IDLE if !force => CHECKING,
                IDLE => UPDATING,
                _ => return false,
            };
            match self
                .job
                .compare_exchange(job, next, Ordering::AcqRel, Ordering::Acquire)
            {
                Ok(_) => return job == IDLE,
                Err(current) => job = current,
            }
        }
    }

    pub(super) fn refresh(
        &self,
        sources: Arc<Vec<Source>>,
        force: bool,
        files: CatalogueFiles,
    ) -> Option<bool> {
        let started = Instant::now();
        match self.rebuild(sources, force, &files) {
            Ok(false) => Some(false),
            Ok(true) => {
                *self.files.write().expect("catalogue options") = files;
                log::info!(target: "inpx::index", "phase=ready elapsed_ms={}", started.elapsed().as_millis());
                self.job.store(IDLE, Ordering::Release);
                Some(true)
            }
            Err(error) => {
                self.failed("Не удалось обновить поисковый индекс", Some(error.as_ref()));
                None
            }
        }
    }

    pub(super) fn failed(&self, message: &str, detail: Option<&dyn std::error::Error>) {
        if let Some(detail) = detail {
            log::error!(target: "inpx::index", "Index update failed: {detail}");
        } else {
            log::error!(target: "inpx::index", "Index update failed: {message}");
        }
        let catalogue = self.catalogue.read().expect("open catalogue");
        let mut status = self.status.lock().expect("index status");
        if let Some(catalogue) = catalogue.as_ref().filter(|c| !c.is_lease_lost())
            && !self.lease_lost.load(Ordering::Acquire)
        {
            *status = self::status(catalogue, &self.sources());
        } else {
            status["state"] = "database_unavailable".into();
            status["ready"] = false.into();
            status["dbLoaded"] = false.into();
            status["searchReady"] = false.into();
            status["updating"] = false.into();
        }
        status["error"] = message.into();
        self.job.store(IDLE, Ordering::Release);
    }
    fn rebuild(
        &self,
        sources: Arc<Vec<Source>>,
        force: bool,
        files: &CatalogueFiles,
    ) -> Result<bool> {
        if self.is_lease_lost() {
            return Err("Catalogue lease lost".into());
        }
        let (generation, hash, store) = {
            let current = self.catalogue.read().expect("open catalogue");
            let current = current
                .as_ref()
                .ok_or("Каталог недоступен. Перезапустите сервер.")?;
            current.check_lease()?;
            (
                current.generation.clone(),
                current.inpx_hash.clone(),
                current.store.clone(),
            )
        };
        if !force && files.source_hash(&sources)? == hash {
            if self.isbn.has_saved() {
                let active = self.catalogue.read().expect("open catalogue");
                if let Some(catalogue) = active.as_ref() {
                    catalogue.check_lease()?;
                    catalogue.refresh_isbn_signature(&sources)?;
                }
            }
            self.status
                .lock()
                .expect("index status")
                .as_object_mut()
                .expect("status object")
                .remove("error");
            if self
                .job
                .compare_exchange(CHECKING, IDLE, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
            {
                return Ok(false);
            }
        }
        self.job.store(UPDATING, Ordering::Release);
        log::info!(target: "inpx::index", "phase=start sources={} forced={force} low_memory={}",
            sources.len(), files.low_memory);
        self.progress(
            json!({"updating":true,"job":"","jobStep":0,"jobStepCount":3,"progress":0,
            "recsLoaded":0,"jobMessage":"Подготовка нового индекса","error":null}),
        );
        let stage = files.prepare(&sources, &generation, &store, |patch| {
            if self.is_lease_lost() {
                return Err("Catalogue lease lost".into());
            }
            self.progress(patch);
            Ok(())
        })?;
        let isbn_revision = self
            .isbn
            .has_saved()
            .then(|| stage.isbn_revision(&sources))
            .flatten();
        drop(store);
        self.progress(json!({"job":"publish","jobStep":3,"progress":0,"jobMessage":"Переключение поискового индекса"}));
        // Publication needs exclusive access while the store files are closed and replaced.
        let mut catalogue = self.catalogue.write().expect("open catalogue");
        if self.lease_lost.load(Ordering::Acquire)
            || catalogue.as_ref().is_some_and(Catalogue::is_lease_lost)
        {
            return Err("Catalogue lease lost".into());
        }
        let previous_isbn_revision = catalogue
            .as_ref()
            .map(Catalogue::isbn_signature)
            .transpose()?;
        let published =
            files.publish_with_on_lost(stage, &mut catalogue, Some(self.on_lease_lost.clone()));
        if let Some(catalogue) = catalogue.as_mut() {
            catalogue.attach_isbn_index(self.isbn.clone());
            catalogue.set_isbn_revision(if published.is_ok() {
                isbn_revision
            } else {
                previous_isbn_revision
            });
        }
        published?;
        *self.sources.write().expect("library sources") = sources.clone();
        self.generation.fetch_add(1, Ordering::Relaxed);
        *self.status.lock().expect("index status") =
            status(catalogue.as_ref().expect("published catalogue"), &sources);
        Ok(true)
    }

    fn progress(&self, patch: Value) {
        self.status
            .lock()
            .expect("index status")
            .as_object_mut()
            .expect("status object")
            .extend(patch.as_object().expect("progress object").clone());
    }
}

pub(super) fn interval(value: &Value) -> Option<Duration> {
    let minutes = value.as_f64().or_else(|| value.as_str()?.parse().ok())?;
    Duration::try_from_secs_f64(minutes * 60.0)
        .ok()
        .filter(|duration| !duration.is_zero())
}

fn status(catalogue: &Catalogue, sources: &[Source]) -> Value {
    let sources: Vec<_> = sources
        .iter()
        .map(|source| json!({ "id":source.id,"name":source.name,"enabled":true }))
        .collect();
    let recs_loaded = if catalogue.created {
        catalogue.stats["recsLoaded"].as_u64().unwrap_or_default()
    } else {
        0
    };
    json!({"ready":true,"serverReady":true,"dbLoaded":true,"searchReady":true,"updating":false,
        "state":"normal","job":"","jobStep":0,"jobStepCount":0,"serverMessage":"","jobMessage":"",
        "progress":1,"recsLoaded":recs_loaded,"version":VERSION,"sources":sources,
        "inpxHash":catalogue.inpx_hash,"stats":catalogue.stats,"inpxInfo":catalogue.info,
        "indexUpdate":catalogue.index_update})
}
