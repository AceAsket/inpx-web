use serde_json::{Value, json};

use super::State;

pub(super) fn snapshot(state: &State, owner: &str, admin: bool) -> inpx_catalog::Result<Value> {
    let mut tasks: Vec<_> = state.exchange.rating_task().into_iter().collect();
    let mut isbn = Value::Null;
    if admin {
        isbn = super::isbn::status(state)?;
        if isbn["state"] == "running" {
            let done = isbn["checked"].as_u64().unwrap_or(0);
            let total = isbn["total"].as_u64();
            tasks.push(
                json!({"id":"isbn","kind":"isbn","title":"Индекс ISBN","state":"running",
                "phase":"Чтение ISBN","done":done,"total":total,"progress":fraction(done,total),
                "remainingSeconds":isbn["remainingSeconds"]}),
            );
        }
        tasks.extend(state.diagnostics.tasks());
        let index = state.index.snapshot();
        if index["updating"] == true {
            let done = index["recsLoaded"].as_u64().unwrap_or(0);
            let total = index["totalRecords"].as_u64().filter(|total| *total != 0);
            tasks.push(json!({"id":"catalogue","kind":"catalogue","title":"Индекс каталога","state":"running",
                "phase":index["jobMessage"],"done":done,"total":total,"progress":index["progress"]}));
        }
    }
    tasks.extend(state.speech.tasks(owner, admin));
    tasks.extend(state.batch.tasks(owner, admin));
    tasks.extend(state.delivery.tasks(owner, admin));
    let resources = admin.then(|| summarize(&tasks));
    let audit = if admin {
        state.diagnostics.audit()
    } else {
        Value::Null
    };
    Ok(json!({"tasks":tasks,"resources":resources,"audit":audit,"isbnIndex":isbn,"isAdmin":admin}))
}

pub(super) fn resources(state: &State, owner: &str, admin: bool) -> Value {
    let tasks = state
        .speech
        .tasks(owner, admin)
        .into_iter()
        .chain(state.batch.tasks(owner, admin))
        .chain(state.delivery.tasks(owner, admin))
        .chain(state.diagnostics.tasks())
        .collect::<Vec<_>>();
    summarize(&tasks)
}

fn summarize(tasks: &[Value]) -> Value {
    let mut foreground = 0;
    let mut background = 0;
    let mut queued = 0;
    for task in tasks {
        match task["state"].as_str() {
            Some("queued") => queued += 1,
            Some("running" | "generating" | "cancelling") => {
                if matches!(
                    task["kind"].as_str(),
                    Some("audit" | "benchmark" | "isbn" | "catalogue" | "ratings")
                ) {
                    background += 1;
                } else {
                    foreground += 1;
                }
            }
            _ => (),
        }
    }
    json!({"active":foreground+background,"queued":queued,"foreground":foreground,"background":background})
}

pub(super) fn fraction(done: u64, total: Option<u64>) -> Option<f64> {
    total
        .filter(|total| *total != 0)
        .map(|total| (done as f64 / total as f64).min(1.0))
}
