use std::sync::Mutex;
use std::sync::atomic::{AtomicU8, Ordering};
use std::time::Duration;

use inpx_catalog::Result;
use inpx_catalog::library_sources::Source;
use inpx_catalog::standalone_catalogue::{Catalogue, CatalogueFiles};
use serde_json::{Value, json};

use super::VERSION;

const IDLE: u8 = 0;
const CHECKING: u8 = 1;
const UPDATING: u8 = 2;

pub(super) struct Index {
    files: CatalogueFiles,
    pub(super) catalogue: Mutex<Option<Catalogue>>,
    status: Mutex<Value>,
    job: AtomicU8,
}

impl Index {
    pub(super) fn open(files: CatalogueFiles, sources: &[Source]) -> Result<(Self, bool)> {
        let catalogue = files.open_or_create(sources)?;
        let created = catalogue.created;
        Ok((
            Self {
                files,
                status: Mutex::new(status(&catalogue, sources)),
                catalogue: Mutex::new(Some(catalogue)),
                job: AtomicU8::new(IDLE),
            },
            created,
        ))
    }

    pub(super) fn snapshot(&self) -> Value {
        self.status.lock().expect("index status").clone()
    }

    pub(super) fn start(&self, force: bool) -> bool {
        let mut job = self.job.load(Ordering::Acquire);
        loop {
            let next = match job {
                IDLE if !force => CHECKING,
                IDLE => UPDATING,
                CHECKING if force => UPDATING,
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

    pub(super) fn refresh(&self, sources: &[Source], force: bool) {
        match self.rebuild(sources, force) {
            Ok(false) => return,
            Ok(true) => {}
            Err(error) => {
                eprintln!("Index update failed: {error}");
                let catalogue = self.catalogue.lock().expect("open catalogue");
                let mut status = self.status.lock().expect("index status");
                if let Some(catalogue) = catalogue.as_ref() {
                    *status = self::status(catalogue, sources);
                } else {
                    status["state"] = "database_unavailable".into();
                    status["ready"] = false.into();
                    status["dbLoaded"] = false.into();
                    status["searchReady"] = false.into();
                    status["updating"] = false.into();
                }
                status["error"] = "Не удалось обновить поисковый индекс".into();
            }
        }
        self.job.store(IDLE, Ordering::Release);
    }

    fn rebuild(&self, sources: &[Source], force: bool) -> Result<bool> {
        let (generation, hash) = {
            let current = self.catalogue.lock().expect("open catalogue");
            let current = current
                .as_ref()
                .ok_or("Каталог недоступен. Перезапустите сервер.")?;
            (current.generation.clone(), current.inpx_hash.clone())
        };
        if !force && self.files.source_hash(sources)? == hash {
            self.status
                .lock()
                .expect("index status")
                .as_object_mut()
                .expect("status object")
                .remove("error");
            // A manual refresh can promote this check to a rebuild before it finishes.
            if self
                .job
                .compare_exchange(CHECKING, IDLE, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
            {
                return Ok(false);
            }
        }
        self.job.store(UPDATING, Ordering::Release);
        self.progress(
            json!({"updating":true,"job":"","jobStep":0,"jobStepCount":3,"progress":0,
            "recsLoaded":0,"jobMessage":"Подготовка нового индекса","error":null}),
        );
        let stage = self.files.prepare(sources, &generation, |patch| {
            self.progress(patch);
            Ok(())
        })?;
        self.progress(json!({"job":"publish","jobStep":3,"progress":0,"jobMessage":"Переключение поискового индекса"}));
        let mut catalogue = self.catalogue.lock().expect("open catalogue");
        self.files.publish(stage, &mut catalogue)?;
        *self.status.lock().expect("index status") =
            status(catalogue.as_ref().expect("published catalogue"), sources);
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
