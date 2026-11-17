use std::collections::HashSet;

use serde_json::{Map, Value, json};

use super::{ReaderState, now, number, string};
use crate::Result;

const INTERACTIONS: &[&str] = &["impression", "open", "start", "save", "download"];
const FEEDBACK: &[&str] = &[
    "more_like_this",
    "not_interested",
    "dislike_author",
    "dislike_genre",
    "already_read",
    "ignore_for_taste",
];
const MAX_COUNT: i64 = 1_000_000_000;
const MAX_BOOKS: usize = 5000;

impl ReaderState {
    pub fn discovery_metrics(&self, stamp: &str) -> Result<Value> {
        #[derive(serde::Deserialize)]
        struct Data {
            #[serde(default)]
            users: Vec<User>,
        }
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct User {
            #[serde(default)]
            discovery_preferences: Value,
        }
        let file = std::fs::File::open(&self.file)?;
        if crate::file_stamp::stamp(&file)?.to_string() != stamp {
            return Err("Файл профилей изменился, повторите запрос".into());
        }
        let data: Data = serde_json::from_reader(std::io::BufReader::new(file))?;
        let mut profiles = 0;
        let mut configured = 0;
        let mut totals = metric_counts(&Value::Null);
        let mut shelves = json!({});
        let add = |target: &mut Value, key: &str, value: &Value| {
            let before = target[key].as_i64().unwrap_or_default();
            target[key] = (before + value.as_i64().unwrap_or_default())
                .min(1_000_000_000)
                .into();
        };
        for user in data.users {
            let prefs = preferences(&user.discovery_preferences);
            let user_totals = prefs["metrics"]["totals"]
                .as_object()
                .expect("normalized totals");
            if user_totals
                .values()
                .any(|value| value.as_i64().unwrap_or_default() > 0)
            {
                profiles += 1;
            }
            let taste = &prefs["taste"];
            if !string(&taste["completedAt"]).is_empty()
                || ["genres", "authors", "languages"]
                    .iter()
                    .any(|field| !array(&taste[*field]).is_empty())
            {
                configured += 1;
            }
            for (key, value) in user_totals {
                add(&mut totals, key, value);
            }
            for (id, row) in prefs["metrics"]["shelves"]
                .as_object()
                .into_iter()
                .flatten()
            {
                let target = &mut shelves[id.as_str()];
                for (key, value) in row.as_object().into_iter().flatten() {
                    if key == "lastEventAt" {
                        if string(value) > string(&target["lastEventAt"]) {
                            target["lastEventAt"] = value.clone();
                        }
                    } else {
                        add(target, key, value);
                    }
                }
            }
        }
        let impressions = totals["impression"].as_f64().unwrap_or_default();
        let rate = |value: f64| {
            if impressions > 0.0 {
                (value / impressions * 10000.0).round() / 10000.0
            } else {
                0.0
            }
        };
        let get = |key: &str| totals[key].as_f64().unwrap_or_default();
        Ok(
            json!({"profiles":profiles,"configuredProfiles":configured,"totals":totals,"shelves":shelves,
            "rates":{"ctr":rate(get("open")),"start":rate(get("start")),"save":rate(get("save")),
              "negativeFeedback":rate(get("not_interested")+get("dislike_author")+get("dislike_genre"))}}),
        )
    }

    pub fn personal_discovery(&self, owner: &str, stamp: &str) -> Result<Value> {
        let mut data = self.snapshot(stamp)?.data;
        let lists = super::shelves::discovery_lists(&data, owner);
        let user = data["users"]
            .as_array_mut()
            .into_iter()
            .flatten()
            .find(|user| user["id"] == owner)
            .ok_or("need_profile_login")?;
        Ok(json!({
            "id":owner,"progress":user["readerProgress"].take(),"lists":lists,
            "preferences":preferences(&user["discoveryPreferences"]),
            "personalRecommendationsEnabled":user["personalRecommendationsEnabled"] != false,
        }))
    }

    pub fn discovery_request(
        &self,
        owner: &str,
        stamp: &str,
        action: &str,
        request: &Value,
    ) -> Result<Value> {
        let mut snapshot = self.snapshot(stamp)?;
        let data = &mut snapshot.data;
        let user = data["users"]
            .as_array_mut()
            .into_iter()
            .flatten()
            .find(|user| user["id"] == owner)
            .ok_or("need_profile_login")?;
        if action == "update-shared-discovery-config" {
            if user["isAdmin"] != true {
                return Err("Требуются права администратора".into());
            }
            let config = shared_discovery(&data["sharedDiscoveryConfig"], &request["discovery"]);
            if data["sharedDiscoveryConfig"] != config {
                data["sharedDiscoveryConfig"] = config.clone();
                self.publish(snapshot, stamp)?;
            }
            return Ok(json!({"discovery":config}));
        }
        let updated = now();
        let mut value = preferences(&user["discoveryPreferences"]);
        let result = if action == "update-discovery-preferences" {
            update_preferences(&mut value, &request["preferences"], &updated);
            json!({"preferences":preferences(&value)})
        } else {
            let recorded = record_events(&mut value, &request["events"], &updated);
            if recorded == 0 {
                return Ok(json!({"recorded":0}));
            }
            json!({"recorded":recorded})
        };
        user["discoveryPreferences"] = preferences(&value);
        user["updatedAt"] = updated.into();
        self.publish(snapshot, stamp)?;
        Ok(result)
    }
}

pub fn shared_discovery(base: &Value, patch: &Value) -> Value {
    let field = |key| {
        patch
            .get(key)
            .or_else(|| base.get(key))
            .unwrap_or(&Value::Null)
    };
    let source = string(field("externalSource")).trim();
    let limit = |field_value: &Value, fallback, minimum, maximum| {
        let value = number(field_value).trunc() as i64;
        if value == 0 {
            fallback
        } else {
            value.clamp(minimum, maximum)
        }
    };
    json!({
        "externalSource":if source.is_empty() || source.eq_ignore_ascii_case("none") { "none" } else { "web-page" },
        "externalName":string(field("externalName")).trim(),
        "externalUrl":string(field("externalUrl")).trim(),
        "externalLimit":limit(field("externalLimit"),8,1,24),
        "externalTtlMinutes":limit(field("externalTtlMinutes"),1440,1440,10080),
    })
}

fn array(value: &Value) -> &[Value] {
    value.as_array().map_or(&[], Vec::as_slice)
}

fn uid(value: &Value) -> &str {
    value.as_str().unwrap_or_default().trim()
}

fn event_uid(value: &Value) -> &str {
    let original = uid(&value["bookUid"]);
    if original.is_empty() {
        uid(&value["_uid"])
    } else {
        original
    }
}

fn shelf_id(value: &str) -> String {
    let mut out = String::new();
    let mut separator = false;
    for ch in value.trim().chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_') {
            out.push(ch.to_ascii_lowercase());
            separator = false;
        } else if !separator {
            out.push('-');
            separator = true;
        }
        if out.len() == 80 {
            break;
        }
    }
    out
}

fn kind(value: &Value) -> String {
    string(value).trim().to_lowercase()
}

fn count(value: &Value, max: i64) -> i64 {
    (number(value).trunc() as i64).clamp(0, max)
}

fn metric_counts(value: &Value) -> Value {
    Value::Object(
        INTERACTIONS
            .iter()
            .chain(&["feedback"])
            .chain(FEEDBACK)
            .map(|key| (key.to_string(), count(&value[*key], MAX_COUNT).into()))
            .collect(),
    )
}

fn latest(
    value: &Value,
    size: usize,
    timestamp: &str,
    normalize: impl Fn(&str, &Value) -> Option<(String, Value)>,
) -> Value {
    let mut entries: Vec<_> = value
        .as_object()
        .into_iter()
        .flatten()
        .filter_map(|(key, row)| normalize(key, row))
        .collect();
    entries.sort_by(|a, b| string(&a.1[timestamp]).cmp(string(&b.1[timestamp])));
    let start = entries.len().saturating_sub(size);
    Value::Object(entries.into_iter().skip(start).collect())
}

fn timestamp(row: &Value, key: &str) -> Value {
    string(&row[key]).trim().into()
}

fn event_counts(row: &Value) -> Value {
    json!({
        "impressionCount":count(&row["impressionCount"],10000),
        "openCount":count(&row["openCount"],10000),
        "startCount":count(&row["startCount"],10000),
        "lastShownAt":timestamp(row,"lastShownAt"),"lastOpenedAt":timestamp(row,"lastOpenedAt"),
        "lastStartedAt":timestamp(row,"lastStartedAt"),"lastEventAt":timestamp(row,"lastEventAt"),
    })
}

fn taste(value: &Value) -> Value {
    let items = |field: &str, limit, max_len, lower| {
        let mut seen = HashSet::new();
        array(&value[field])
            .iter()
            .filter_map(|item| {
                let item = string(item)
                    .split(inpx_reader::js_whitespace)
                    .filter(|part| !part.is_empty())
                    .collect::<Vec<_>>()
                    .join(" ");
                (!item.is_empty()
                    && item.encode_utf16().count() <= max_len
                    && seen.insert(item.clone()))
                .then(|| if lower { item.to_lowercase() } else { item })
            })
            .take(limit)
            .collect::<Vec<_>>()
    };
    let exploration = number(&value["explorationRatio"]);
    json!({
        "genres":items("genres",20,80,true),"authors":items("authors",20,160,false),
        "languages":items("languages",10,20,true),
        "explorationRatio":if exploration == 0.0 {0.15} else {exploration.clamp(0.1,0.3)},
        "completedAt":timestamp(value,"completedAt"),"promptDismissedAt":timestamp(value,"promptDismissedAt"),
        "updatedAt":timestamp(value,"updatedAt"),
    })
}

pub(super) fn preferences(value: &Value) -> Value {
    let mut seen = HashSet::new();
    let hidden: Vec<_> = array(&value["hiddenBooks"])
        .iter()
        .map(uid)
        .filter(|uid| !uid.is_empty() && seen.insert(*uid))
        .take(MAX_BOOKS)
        .collect();
    let feedback = latest(&value["feedback"], MAX_BOOKS, "updatedAt", |uid, row| {
        let label = kind(&row["kind"]);
        (!uid.trim().is_empty() && FEEDBACK.contains(&label.as_str())).then(|| {
            (
                uid.trim().into(),
                json!({"kind":label,"updatedAt":timestamp(row,"updatedAt")}),
            )
        })
    });
    let events = latest(&value["events"], MAX_BOOKS, "lastEventAt", |uid, row| {
        (!uid.trim().is_empty() && row.is_object()).then(|| (uid.trim().into(), event_counts(row)))
    });
    let metrics = &value["metrics"];
    let shelves = latest(&metrics["shelves"], 100, "lastEventAt", |key, row| {
        let id = shelf_id(key);
        let mut counts = metric_counts(row);
        counts["lastEventAt"] = timestamp(row, "lastEventAt");
        (!id.is_empty()).then_some((id, counts))
    });
    json!({"hiddenBooks":hidden,"feedback":feedback,"events":events,"taste":taste(&value["taste"]),
        "metrics":{"totals":metric_counts(&metrics["totals"]),"shelves":shelves}})
}

fn bump_metric(metrics: &mut Value, key: &str, shelf: &str, now: &str) {
    let total = &mut metrics["totals"][key];
    *total = (count(total, MAX_COUNT - 1) + 1).into();
    let shelf = &mut metrics["shelves"][shelf];
    let current = &mut shelf[key];
    *current = (count(current, MAX_COUNT - 1) + 1).into();
    shelf["lastEventAt"] = now.into();
}

fn selection(value: &Value, fallback: &str) -> String {
    let shelf = shelf_id(string(value));
    if shelf.is_empty() {
        fallback.into()
    } else {
        shelf
    }
}

fn update_preferences(value: &mut Value, patch: &Value, now: &str) {
    if let Some(fields) = patch.get("taste") {
        let taste = value["taste"].as_object_mut().expect("normalized taste");
        if let Some(fields) = fields.as_object() {
            taste.extend(fields.clone());
        }
        let completed = taste.entry("completedAt").or_insert(Value::Null);
        if string(completed).trim().is_empty() {
            *completed = now.into();
        }
        taste.insert("updatedAt".into(), now.into());
    }
    if let Some(dismissed) = patch.get("tastePromptDismissedAt") {
        let dismissed = string(dismissed).trim();
        value["taste"]["promptDismissedAt"] =
            if dismissed.is_empty() { now } else { dismissed }.into();
    }
    if let Some(hidden) = patch.get("hiddenBooks") {
        value["hiddenBooks"] = array(hidden).to_vec().into();
    }
    let mut hidden = value["hiddenBooks"].take();
    let books = hidden.as_array_mut().expect("normalized hidden books");
    books.extend(array(&patch["hiddenBooksAdd"]).iter().cloned());
    remove_hidden(
        books,
        value["feedback"]
            .as_object_mut()
            .expect("normalized feedback"),
        &patch["hiddenBooksRemove"],
    );
    for item in array(&patch["feedbackSet"]).iter().take(200) {
        let book = event_uid(item);
        let label = kind(&item["kind"]);
        if book.is_empty() || !FEEDBACK.contains(&label.as_str()) {
            continue;
        }
        value["feedback"][book] = json!({"kind":label,"updatedAt":now});
        if matches!(label.as_str(), "more_like_this" | "ignore_for_taste") {
            books.retain(|hidden| uid(hidden) != book);
        } else if !books.iter().any(|hidden| uid(hidden) == book) {
            books.push(book.into());
        }
        let shelf = selection(&item["shelfId"], "similar-books");
        bump_metric(&mut value["metrics"], "feedback", &shelf, now);
        bump_metric(&mut value["metrics"], &label, &shelf, now);
    }
    let feedback = value["feedback"]
        .as_object_mut()
        .expect("normalized feedback");
    for entry in array(&patch["feedbackRemove"]) {
        feedback.remove(uid(entry));
    }
    value["hiddenBooks"] = hidden;
}

fn remove_hidden(books: &mut Vec<Value>, feedback: &mut Map<String, Value>, list: &Value) {
    let remove: HashSet<_> = array(list).iter().map(uid).collect();
    books.retain(|book| !remove.contains(uid(book)));
    for uid in remove {
        feedback.remove(uid);
    }
}

fn record_events(value: &mut Value, input: &Value, now: &str) -> usize {
    let mut seen = HashSet::new();
    for item in array(input).iter().take(200) {
        let book = event_uid(item);
        let kind = kind(&item["type"]);
        let shelf = selection(&item["shelfId"], "unknown");
        if book.is_empty()
            || !INTERACTIONS.contains(&kind.as_str())
            || !seen.insert((book, kind.clone(), shelf.clone()))
        {
            continue;
        }
        let row = &mut value["events"][book];
        let (counter, date) = match kind.as_str() {
            "impression" => ("impressionCount", "lastShownAt"),
            "open" | "save" => ("openCount", "lastOpenedAt"),
            _ => ("startCount", "lastStartedAt"),
        };
        row[counter] = (count(&row[counter], 9999) + 1).into();
        row[date] = now.into();
        row["lastEventAt"] = now.into();
        bump_metric(&mut value["metrics"], &kind, &shelf, now);
    }
    seen.len()
}
