use std::collections::HashSet;

use icu_collator::Collator;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::{ReaderState, now, number, string};
use crate::standalone_catalogue::Catalogue;
use crate::{Result, crypto_support};

const MAX_FOLLOWS: usize = 20;
const MAX_MATCHES: usize = 5000;
const PAGE_SIZE: usize = 200;

#[derive(Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(super) struct Follow {
    id: String,
    kind: String,
    value: String,
    revision: u64,
    created_at: String,
    known_uids: Vec<String>,
    new_uids: Vec<String>,
}

#[derive(Deserialize, Serialize)]
struct NewsBook {
    #[serde(rename = "_uid")]
    uid: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    author: String,
    #[serde(default)]
    series: String,
    #[serde(default)]
    ext: String,
    #[serde(default)]
    date: String,
}

impl ReaderState {
    pub fn library_follows(
        &self,
        owner: &str,
        stamp: &str,
        action: &str,
        request: &Value,
        catalogue: &Catalogue,
    ) -> Result<Value> {
        let mut snapshot = self.snapshot(stamp)?;
        let user = snapshot.data["users"]
            .as_array_mut()
            .into_iter()
            .flatten()
            .find(|user| user["id"] == owner)
            .ok_or("need_profile_login")?;
        let mut follows = normalize_follows(&user["libraryFollows"]);
        let options = if action == "get-library-follows" {
            &request["options"]
        } else {
            &request["payload"]
        };
        let refresh = action == "get-library-follows"
            && (options["refresh"] == true
                || options["autoRefresh"] == true
                    && self
                        .follow_checks
                        .lock()
                        .expect("subscription checks")
                        .get(owner)
                        != Some(&catalogue.generation));
        let changed = if action == "change-library-follow" {
            change(
                &mut follows,
                string(&request["operation"]),
                options,
                catalogue,
            )?
        } else if refresh {
            refresh_follows(&mut follows, catalogue)?
        } else {
            false
        };
        let reply = list(&follows, options, catalogue)?;
        if changed {
            user["libraryFollows"] = serde_json::to_value(follows)?;
            user["updatedAt"] = now().into();
            self.publish(snapshot, stamp)?;
        }
        if refresh {
            let mut checks = self.follow_checks.lock().expect("subscription checks");
            if checks.len() >= 256 {
                checks.clear();
            }
            checks.insert(owner.into(), catalogue.generation.clone());
        }
        Ok(reply)
    }
}

fn name(value: &str) -> String {
    value
        .split(inpx_reader::js_whitespace)
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn bounded(value: &str, limit: usize) -> String {
    let mut remaining = limit;
    value
        .chars()
        .take_while(|ch| {
            if ch.len_utf16() > remaining {
                return false;
            }
            remaining -= ch.len_utf16();
            true
        })
        .collect()
}

fn valid_uid(value: &Value) -> Option<&str> {
    value
        .as_str()
        .filter(|uid| !uid.is_empty() && uid.encode_utf16().count() <= 512)
}

fn stored_uids(value: &Value) -> Vec<String> {
    let mut uids: Vec<_> = value
        .as_array()
        .into_iter()
        .flatten()
        .take(MAX_MATCHES)
        .filter_map(valid_uid)
        .map(str::to_owned)
        .collect();
    uids.sort_unstable();
    uids.dedup();
    uids
}

fn valid_kind(kind: &str) -> bool {
    matches!(kind, "author" | "series")
}

pub(super) fn normalize_follows(value: &Value) -> Vec<Follow> {
    let mut keys = HashSet::new();
    value
        .as_array()
        .into_iter()
        .flatten()
        .take(MAX_FOLLOWS)
        .filter_map(|row| {
            let kind = string(&row["kind"]);
            let value = bounded(&name(string(&row["value"])), 200);
            if !valid_kind(kind) || value.is_empty() || !keys.insert((kind, value.to_lowercase())) {
                return None;
            }
            Some(Follow {
                id: bounded(string(&row["id"]), 80),
                kind: kind.into(),
                value,
                revision: row["revision"]
                    .as_u64()
                    .filter(|n| *n < (1 << 53))
                    .unwrap_or(0),
                created_at: bounded(string(&row["createdAt"]), 40),
                known_uids: stored_uids(&row["knownUids"]),
                new_uids: stored_uids(&row["newUids"]),
            })
        })
        .collect()
}

fn change(
    follows: &mut Vec<Follow>,
    operation: &str,
    options: &Value,
    catalogue: &Catalogue,
) -> Result<bool> {
    match operation {
        "add" => {
            let kind = string(&options["kind"]);
            let value = name(string(&options["value"]));
            if !valid_kind(kind) || value.is_empty() || value.encode_utf16().count() > 200 {
                return Err("Укажите автора или серию (до 200 символов)".into());
            }
            let key = value.to_lowercase();
            if follows
                .iter()
                .any(|follow| follow.kind == kind && follow.value.to_lowercase() == key)
            {
                return Ok(false);
            }
            if follows.len() >= MAX_FOLLOWS {
                return Err("Можно добавить до 20 авторов и серий".into());
            }
            let known_uids = catalogue.follow_uids(kind, &value, MAX_MATCHES)?;
            follows.push(Follow {
                id: crypto_support::hex(&crypto_support::random::<8>()?),
                kind: kind.into(),
                value,
                revision: 1,
                created_at: now(),
                known_uids,
                new_uids: Vec::new(),
            });
        }
        "seen-books" => {
            let invalid = "Некорректный список просмотренных книг";
            let seen = options["bookUids"]
                .as_array()
                .filter(|rows| (1..=PAGE_SIZE).contains(&rows.len()))
                .ok_or(invalid)?
                .iter()
                .map(|row| valid_uid(row).ok_or(invalid))
                .collect::<std::result::Result<HashSet<_>, _>>()?;
            let mut changed = false;
            for follow in follows {
                let before = follow.new_uids.len();
                follow.new_uids.retain(|uid| !seen.contains(uid.as_str()));
                if follow.new_uids.len() != before {
                    follow.revision += 1;
                    changed = true;
                }
            }
            return Ok(changed);
        }
        "remove" | "seen" => {
            let Some(index) = follows.iter().position(|follow| options["id"] == follow.id) else {
                return Ok(false);
            };
            if operation == "remove" {
                follows.remove(index);
            } else {
                let follow = &mut follows[index];
                follow.new_uids.clear();
                follow.revision += 1;
            }
        }
        _ => return Err("Неизвестное действие с избранным".into()),
    }
    Ok(true)
}

fn refresh_follows(follows: &mut [Follow], catalogue: &Catalogue) -> Result<bool> {
    let mut changed = false;
    for follow in follows {
        let current = catalogue.follow_uids(&follow.kind, &follow.value, MAX_MATCHES)?;
        let fresh: Vec<_> = current
            .iter()
            .filter(|uid| {
                follow.known_uids.binary_search(uid).is_err()
                    || follow.new_uids.binary_search(uid).is_ok()
            })
            .cloned()
            .collect();
        if current != follow.known_uids || fresh != follow.new_uids {
            follow.known_uids = current;
            follow.new_uids = fresh;
            follow.revision += 1;
            changed = true;
        }
    }
    Ok(changed)
}

fn list(follows: &[Follow], options: &Value, catalogue: &Catalogue) -> Result<Value> {
    let offset = options["offset"].as_u64().unwrap_or(0).min((1 << 53) - 1);
    let size = options["limit"]
        .as_u64()
        .unwrap_or(PAGE_SIZE as u64)
        .min(PAGE_SIZE as u64);
    let wanted: HashSet<_> = follows
        .iter()
        .flat_map(|follow| follow.new_uids.iter().map(String::as_str))
        .collect();
    let wanted: Vec<_> = wanted.into_iter().collect();
    let mut books: Vec<NewsBook> = Vec::new();
    for batch in wanted.chunks(1000) {
        for book in catalogue.browser_books_by_uid(batch.iter().copied())? {
            if number(&book["del"]) == 0.0 {
                books.push(serde_json::from_value(book)?);
            }
        }
    }
    let available: HashSet<_> = books.iter().map(|book| book.uid.as_str()).collect();
    let summaries: Vec<_> = follows
        .iter()
        .map(|row| {
            json!({
                "id":row.id, "kind":row.kind, "value":row.value, "revision":row.revision,
                "createdAt":row.created_at,
                "unread":row.new_uids.iter().filter(|uid| available.contains(uid.as_str())).count(),
            })
        })
        .collect();
    if size > 0 && books.len() > 1 {
        let collator =
            Collator::try_new(icu_locale_core::locale!("ru").into(), Default::default())?;
        books.sort_unstable_by(|a, b| {
            b.date
                .cmp(&a.date)
                .then_with(|| collator.compare(&a.title, &b.title))
                .then_with(|| a.uid.cmp(&b.uid))
        });
    }
    let total = books.len() as u64;
    let page: Vec<_> = books
        .into_iter()
        .skip(offset.min(total) as usize)
        .take(size as usize)
        .collect();
    Ok(
        json!({"follows":summaries,"books":page,"unseenCount":total,"truncated":offset + size < total}),
    )
}
