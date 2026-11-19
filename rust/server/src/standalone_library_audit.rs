use std::sync::{Arc, Mutex};

use inpx_catalog::{Result, access_runtime::now_ms, book_audit};
use serde_json::{Value, json};

use super::{Job, SOURCE_CHANGED, State, integer};
use crate::standalone_access::BrowserProfileRequest;

#[derive(Default)]
pub(super) struct Audit {
    job: Mutex<Option<Arc<Job>>>,
}

impl Audit {
    pub(super) fn view(&self) -> Value {
        self.job
            .lock()
            .expect("audit slot")
            .as_ref()
            .map_or(Value::Null, |job| job.view())
    }

    pub(super) fn cancel(&self) -> Value {
        self.job
            .lock()
            .expect("audit slot")
            .as_ref()
            .map_or(Value::Null, |job| job.cancel())
    }

    pub(super) fn start(
        &self,
        state: &Arc<State>,
        owner: BrowserProfileRequest<'_>,
        deep: bool,
    ) -> Result<Value> {
        let mut slot = self.job.lock().expect("audit slot");
        if slot
            .as_ref()
            .is_some_and(|job| job.view()["running"] == true)
        {
            return Err("Проверка библиотеки уже выполняется".into());
        }
        let status = state.index.snapshot();
        if status["ready"] != true || status["updating"] == true {
            return Err("Каталог ещё не готов к проверке".into());
        }
        let generation = state.index.generation();
        let total = status["stats"]["bookCountAll"].as_u64().unwrap_or_default();
        let job = Job::new(
            owner,
            json!({"deep":deep,"checked":0,"total":total,"missing":0,"damaged":0,"skipped":0,
            "issues":[],"issuesTruncated":false,"startedAt":now_ms()}),
        )?;
        job.owner.authorize(state)?;
        let initial = job.view();
        *slot = Some(job.clone());
        state
            .diagnostics
            .log(state, "info", "audit", "Запущена проверка библиотеки");
        let state = state.clone();
        tokio::task::spawn_blocking(move || {
            let outcome = run(&state, &job, generation, deep);
            let error = outcome
                .err()
                .map(|error| error.to_string())
                .unwrap_or_default();
            let label = job.state_for(&error);
            job.change(|view| {
                view["state"] = label.into();
                view["running"] = false.into();
                view["finishedAt"] = now_ms().into();
                if !error.is_empty() {
                    view["error"] = error.as_str().into();
                }
            });
            state.diagnostics.log(
                &state,
                if label == "failed" { "error" } else { "info" },
                "audit",
                if error.is_empty() {
                    "Проверка библиотеки завершена"
                } else {
                    &error
                },
            );
        });
        Ok(initial)
    }
}

fn run(state: &State, job: &Job, generation: u64, deep: bool) -> Result<()> {
    job.ensure(state, generation)?;
    let settings = state.settings.snapshot();
    let limit = integer(&settings["auditMaxBookBytes"], 64 * 1024 * 1024)
        .clamp(1024 * 1024, 256 * 1024 * 1024) as u64;
    let sources = state.index.sources();
    for source in sources.iter() {
        if !source.lib_dir.is_dir() {
            return Err(format!("Источник библиотеки недоступен: {}", source.name).into());
        }
    }
    let mut cursor = None;
    let mut reader = book_audit::Reader::default();
    loop {
        job.ensure(state, generation)?;
        let _permit = state
            .resources
            .acquire(crate::standalone::resources::Kind::Background)?;
        let (rows, next) = {
            let catalogue = state.index.catalogue.read().expect("open catalogue");
            catalogue
                .as_ref()
                .ok_or(SOURCE_CHANGED)?
                .source_book_batch(cursor)?
        };
        for row in rows {
            job.ensure(state, generation)?;
            let deleted = row["del"] == true || row["del"].as_i64().is_some_and(|value| value != 0);
            let issue = if deleted {
                None
            } else {
                Some(reader.check(&row, &sources, deep, limit, || job.cancelled())?)
            };
            job.ensure(state, generation)?;
            job.change(|view| {
                view["checked"] = (view["checked"].as_u64().unwrap_or_default() + 1).into();
                if deleted {
                    view["skipped"] = (view["skipped"].as_u64().unwrap_or_default() + 1).into();
                } else if let Some(book_audit::Outcome::Issue(kind,message)) = issue {
                    view[kind] = (view[kind].as_u64().unwrap_or_default() + 1).into();
                    let issues = view["issues"].as_array_mut().expect("audit issues");
                    if issues.len() < 500 {
                        let field = |key: &str, limit: usize| row[key].as_str().unwrap_or_default().chars().take(limit).collect::<String>();
                        issues.push(json!({"bookUid":field("_uid",512),"title":field("title",500),
                            "folder":field("folder",500),"kind":kind,"message":message.chars().take(2000).collect::<String>()}));
                    } else {
                        view["issuesTruncated"] = true.into();
                    }
                }
            });
        }
        if next.is_none() {
            return job.ensure(state, generation);
        }
        cursor = next;
    }
}
