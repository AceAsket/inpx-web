use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use icu_collator::Collator;
use serde::Deserialize;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use time::{
    Date, OffsetDateTime,
    format_description::well_known::{Iso8601, Rfc3339},
};

use crate::Result;
use crate::access_runtime::now_ms;
use crate::facets::{Facet, Label};
use crate::lookup::Table;
use crate::reader_state::number;
use crate::standalone_catalogue::Catalogue;

const DAY: i64 = 86_400_000;
const CACHE_TTL: Duration = Duration::from_secs(15 * 60);

type CacheKey = ([u8; 32], usize, i64);

#[derive(Default)]
pub(crate) struct RecommendationCache {
    items: HashMap<CacheKey, (Instant, Value)>,
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or_default()
}

fn items(value: &Value) -> &[Value] {
    value.as_array().map_or(&[], Vec::as_slice)
}

fn date_ms(value: &str) -> Option<i64> {
    OffsetDateTime::parse(value, &Rfc3339)
        .ok()
        .map(|date| (date.unix_timestamp_nanos() / 1_000_000) as i64)
        .or_else(|| {
            Date::parse(value, &Iso8601::PARSING)
                .ok()
                .map(|date| date.midnight().assume_utc().unix_timestamp() * 1000)
        })
}

fn age(now: i64, value: &str) -> Option<i64> {
    date_ms(value).map(|date| (now - date).max(0) / DAY)
}

fn shelf(id: &str, title: &str, subtitle: &str, updated: i64, books: Vec<Value>) -> Value {
    json!({"id":id,"title":title,"subtitle":subtitle,"source":"personal","sourceName":"Для вас",
        "updatedAt":updated,"items":books})
}

struct Reading<'a> {
    progress: &'a Value,
    lists: &'a [Value],
    prefs: &'a Value,
    hidden: HashSet<&'a str>,
    read: HashSet<&'a str>,
}

impl<'a> Reading<'a> {
    fn new(profile: &'a Value) -> Self {
        let progress = &profile["progress"];
        let lists = items(&profile["lists"]);
        let prefs = &profile["preferences"];
        let hidden = items(&prefs["hiddenBooks"])
            .iter()
            .filter_map(Value::as_str)
            .collect();
        let read = progress
            .as_object()
            .into_iter()
            .flatten()
            .filter(|(_, row)| number(&row["percent"]) >= 0.999)
            .map(|(uid, _)| uid.as_str())
            .chain(
                lists
                    .iter()
                    .flat_map(|row| items(&row["books"]))
                    .filter(|row| row["read"] == true)
                    .map(|row| text(row, "bookUid")),
            )
            .collect();
        Self {
            progress,
            lists,
            prefs,
            hidden,
            read,
        }
    }
}

impl Catalogue {
    pub fn personal_overview(
        &self,
        profile: &Value,
        limit: usize,
        similar_limit: Option<usize>,
        recommendations_only: bool,
    ) -> Result<Vec<Value>> {
        self.check_lease()?;
        let reading = Reading::new(profile);
        let now = now_ms();
        let mut shelves = Vec::new();
        if !recommendations_only {
            let mut progress: Vec<_> = reading
                .progress
                .as_object()
                .into_iter()
                .flatten()
                .filter(|(uid, row)| {
                    row["hidden"] != true
                        && !reading.hidden.contains(uid.as_str())
                        && number(&row["percent"]) < 0.999
                })
                .collect();
            progress.sort_by(|a, b| text(b.1, "updatedAt").cmp(text(a.1, "updatedAt")));
            let continued = self.personal_books(
                progress.iter().map(|(uid, _)| uid.as_str()),
                limit,
                |book| {
                    let uid = text(book, "_uid");
                    let percent =
                        (number(&reading.progress[uid]["percent"]).clamp(0.0, 1.0) * 100.0).round();
                    book["discoveryReason"] = format!("Прогресс {percent}%").into();
                },
            )?;
            shelves.push(shelf(
                "continue-reading",
                "Продолжить чтение",
                "Книги, которые вы открывали недавно",
                now,
                continued,
            ));

            let mut entries: Vec<_> = reading
                .lists
                .iter()
                .flat_map(|list| {
                    let date = list_date(list);
                    items(&list["books"])
                        .iter()
                        .enumerate()
                        .map(move |(index, row)| {
                            (row["read"] == true, date, index, text(row, "bookUid"))
                        })
                })
                .filter(|entry| !reading.hidden.contains(entry.3))
                .collect();
            entries.sort_by(|a, b| {
                a.0.cmp(&b.0)
                    .then_with(|| b.1.cmp(a.1))
                    .then_with(|| a.2.cmp(&b.2))
            });
            let from_lists =
                self.personal_books(entries.iter().map(|entry| entry.3), limit, |book| {
                    book["discoveryRead"] = reading.read.contains(text(book, "_uid")).into();
                    book["discoveryReason"] = "На основе вашей библиотеки".into();
                })?;
            shelves.push(shelf(
                "from-your-lists",
                "Из ваших списков",
                "Книги из ваших личных списков чтения",
                now,
                from_lists,
            ));
            let series = self.unfinished_series(&reading, limit)?;
            shelves.push(shelf(
                "unfinished-series",
                "Незаконченные серии",
                "Следующие книги в сериях, которые вы уже начали",
                now,
                series,
            ));
        }
        if let Some(limit) = similar_limit
            && profile["personalRecommendationsEnabled"] != false
        {
            let similar = self.recommendations(profile, &reading, limit, now)?;
            if !recommendations_only || !items(&similar["items"]).is_empty() {
                shelves.push(similar);
            }
        }
        if !recommendations_only {
            let hidden_books = self.personal_books(
                items(&reading.prefs["hiddenBooks"])
                    .iter()
                    .rev()
                    .filter_map(Value::as_str),
                limit,
                |book| {
                    book["discoveryRead"] = reading.read.contains(text(book, "_uid")).into();
                    book["discoveryReason"] = "Скрыто из персональных витрин".into();
                },
            )?;
            shelves.push(shelf(
                "hidden-books",
                "Скрытые рекомендации",
                "Книги, которые вы скрыли из персональных витрин",
                now,
                hidden_books,
            ));
        }
        Ok(shelves)
    }

    fn personal_books<'a>(
        &self,
        ids: impl Iterator<Item = &'a str>,
        limit: usize,
        decorate: impl Fn(&mut Value),
    ) -> Result<Vec<Value>> {
        let mut seen = HashSet::new();
        let mut ids = ids.filter(|uid| !uid.is_empty() && seen.insert(*uid));
        let mut result = Vec::new();
        while result.len() < limit {
            let batch: Vec<_> = ids.by_ref().take(128).collect();
            if batch.is_empty() {
                break;
            }
            let mut books = self.books_by_uid(&batch)?;
            result.extend(
                batch
                    .into_iter()
                    .filter_map(|uid| {
                        let mut book = books.remove(uid)?;
                        decorate(&mut book);
                        Some(book)
                    })
                    .take(limit - result.len()),
            );
        }
        Ok(result)
    }

    fn books_by_uid(&self, input: &[&str]) -> Result<HashMap<String, Value>> {
        let mut result = HashMap::new();
        for batch in input.chunks(500) {
            for book in self.browser_books_by_uid(batch.iter().copied())? {
                if number(&book["del"]) == 0.0 {
                    result.insert(text(&book, "_uid").into(), book);
                }
            }
        }
        Ok(result)
    }

    fn unfinished_series(&self, reading: &Reading<'_>, limit: usize) -> Result<Vec<Value>> {
        let mut touched = HashMap::new();
        for (uid, row) in reading.progress.as_object().into_iter().flatten() {
            if row["hidden"] != true && number(&row["percent"]) > 0.0 {
                touched.insert(uid.as_str(), text(row, "updatedAt"));
            }
        }
        for list in reading.lists {
            for entry in items(&list["books"])
                .iter()
                .filter(|entry| entry["read"] == true)
            {
                let date = touched.entry(text(entry, "bookUid")).or_default();
                *date = (*date).max(list_date(list));
            }
        }
        let books = self.books_by_uid(&touched.keys().copied().collect::<Vec<_>>())?;
        let mut series = HashMap::new();
        for (uid, book) in &books {
            let name = text(book, "series");
            let volume = number(&book["serno"]);
            if name.is_empty() || volume <= 0.0 {
                continue;
            }
            let date = touched[uid.as_str()];
            let current =
                series
                    .entry(key(name))
                    .or_insert((name, volume, date, text(book, "title")));
            if volume > current.1 || volume == current.1 && date > current.2 {
                *current = (name, volume, date, text(book, "title"));
            }
        }
        let mut ranked: Vec<_> = series.into_values().collect();
        ranked.sort_by(|a, b| b.2.cmp(a.2).then_with(|| a.0.cmp(b.0)));
        let collator =
            Collator::try_new(icu_locale_core::locale!("ru").into(), Default::default())?;
        let query = Map::from_iter([("del".into(), "0".into())]);
        let mut result = Vec::new();
        for (name, volume, _, title) in ranked {
            let mut response = self.browser_series(name, &query)?;
            let mut books = response["books"].take();
            let Some(next) = books
                .as_array_mut()
                .into_iter()
                .flatten()
                .filter(|book| {
                    number(&book["serno"]) > volume
                        && !reading.read.contains(text(book, "_uid"))
                        && !reading.hidden.contains(text(book, "_uid"))
                })
                .min_by(|a, b| {
                    number(&a["serno"])
                        .total_cmp(&number(&b["serno"]))
                        .then_with(|| collator.compare(text(a, "title"), text(b, "title")))
                })
            else {
                continue;
            };
            next["discoveryReason"] = format!("Следующий том после «{title}»").into();
            next["discoveryRead"] = false.into();
            result.push(next.take());
            if result.len() >= limit {
                break;
            }
        }
        Ok(result)
    }

    fn recommendations(
        &self,
        profile: &Value,
        reading: &Reading<'_>,
        limit: usize,
        now: i64,
    ) -> Result<Value> {
        let digest = Sha256::digest(serde_json::to_vec(profile)?).into();
        let cache_key = (digest, limit, now / DAY);
        if let Some((saved, value)) = self
            .recommendation_cache
            .lock()
            .map_err(|_| "Кэш рекомендаций недоступен")?
            .items
            .get(&cache_key)
            && saved.elapsed() < CACHE_TTL
        {
            return Ok(value.clone());
        }
        let taste = &reading.prefs["taste"];
        let input = self.taste_profile(reading, now)?;
        let ratio = number(&taste["explorationRatio"]).clamp(0.1, 0.3);
        let mut candidates = Vec::new();
        if input.available() {
            candidates =
                self.rank_recommendations(&input, reading, limit, now, text(profile, "id"), ratio)?;
        }
        let more = candidates.len() > limit;
        candidates.truncate(limit);
        let books = self.books_by_uid(
            &candidates
                .iter()
                .map(|row| row.book.uid.as_str())
                .collect::<Vec<_>>(),
        )?;
        let mut books_on_shelf = Vec::new();
        for row in candidates {
            if let Some(mut book) = books.get(&row.book.uid).cloned() {
                let mut reasons = Vec::new();
                if row.explore {
                    reasons.push("Немного нового для разнообразия".into());
                    if row.book.librate >= 4.0 {
                        reasons.push("Высокая оценка".into());
                    }
                } else if input.weights[0].contains_key(&key(&row.book.author)) {
                    let author = &row.book.author;
                    let explicit = items(&taste["authors"])
                        .iter()
                        .any(|entry| entry.as_str().is_some_and(|name| key(name) == key(author)));
                    let reason = if explicit {
                        "Вы выбрали автора"
                    } else {
                        "Похожий автор"
                    };
                    reasons.push(format!("{reason}: {author}"));
                }
                if input.weights[1].contains_key(&key(&row.book.series)) {
                    reasons.push(format!("Серия: {}", row.book.series));
                }
                let themes: Vec<_> = row.book.features()[3]
                    .iter()
                    .filter(|name| input.weights[3].contains_key(*name))
                    .take(2)
                    .cloned()
                    .collect();
                if !themes.is_empty() {
                    reasons.push(format!("Темы: {}", themes.join(", ")));
                }
                book["_similarityScore"] = row.score.into();
                book["discoveryReason"] = if reasons.is_empty() {
                    "Похоже на то, что вы читали".into()
                } else {
                    reasons.join(" · ").into()
                };
                book["discoveryExploration"] = row.explore.into();
                book["discoveryRead"] = reading.read.contains(row.book.uid.as_str()).into();
                books_on_shelf.push(book);
            }
        }
        let mut result = shelf(
            "similar-books",
            "Похоже на то, что вы читали",
            "Подборка по авторам, сериям, жанрам и темам из вашей истории",
            now,
            books_on_shelf,
        );
        result["discoveryTaste"] = taste.clone();
        result["discoveryHasMore"] = more.into();
        result["discoveryNeedsTasteSetup"] = (text(taste, "completedAt").is_empty()
            && text(taste, "promptDismissedAt").is_empty())
        .into();
        result["discoveryExplorationRatio"] = ratio.into();
        result["emptyMessage"] =
            "Пока мало данных для рекомендаций. Почитайте ещё немного или добавьте книги в списки."
                .into();
        let mut cache = self
            .recommendation_cache
            .lock()
            .map_err(|_| "Кэш рекомендаций недоступен")?;
        cache
            .items
            .retain(|_, (saved, _)| saved.elapsed() < CACHE_TTL);
        if cache.items.len() >= 16
            && let Some(oldest) = cache
                .items
                .iter()
                .min_by_key(|(_, (saved, _))| *saved)
                .map(|(key, _)| *key)
        {
            cache.items.remove(&oldest);
        }
        cache
            .items
            .insert(cache_key, (Instant::now(), result.clone()));
        Ok(result)
    }

    fn taste_profile<'a>(&self, reading: &Reading<'a>, now: i64) -> Result<Taste<'a>> {
        let mut taste = Taste {
            known: reading.hidden.clone(),
            ..Default::default()
        };
        let feedback = reading.prefs["feedback"].as_object();
        let mut signals = HashMap::new();
        let mut signal = |uid: &'a str, amount: f64, date: &'a str| {
            taste.known.insert(uid);
            if amount > 0.0
                && !reading.hidden.contains(uid)
                && reading.prefs["feedback"][uid]["kind"] != "ignore_for_taste"
            {
                let row = signals.entry(uid).or_insert((0.0_f64, ""));
                row.0 = (row.0 + amount).min(4.5);
                row.1 = row.1.max(date);
            }
        };
        for (uid, row) in reading.progress.as_object().into_iter().flatten() {
            let percent = number(&row["percent"]);
            let weight = match percent {
                _ if row["hidden"] == true || percent < 0.03 => 0.0,
                _ if percent < 0.1 => 0.25,
                _ if percent < 0.5 => 1.0,
                _ if percent < 0.95 => 2.0,
                _ => 3.5,
            };
            signal(uid, weight, text(row, "updatedAt"));
        }
        for list in reading.lists {
            for row in items(&list["books"]) {
                signal(
                    text(row, "bookUid"),
                    if row["read"] == true { 2.5 } else { 0.8 },
                    list_date(list),
                );
            }
        }
        for (uid, row) in feedback.into_iter().flatten() {
            signal(
                uid,
                if row["kind"] == "more_like_this" {
                    4.0
                } else {
                    0.0
                },
                text(row, "updatedAt"),
            );
        }
        for (uid, row) in reading.prefs["events"].as_object().into_iter().flatten() {
            if number(&row["startCount"]) > 0.0 {
                taste.known.insert(uid);
            }
        }
        for (uid, book) in self.books_by_uid(&signals.keys().copied().collect::<Vec<_>>())? {
            let (weight, stamp) = signals[uid.as_str()];
            let multiplier = match age(now, stamp) {
                Some(0..=7) => 1.45,
                Some(8..=30) => 1.25,
                Some(31..=90) => 1.1,
                _ => 1.0,
            };
            let book: Candidate = serde_json::from_value(book)?;
            add_weights(
                &mut taste.weights,
                book.features(),
                [2.2, 1.2, 1.8, 1.4, 0.25].map(|value| value * weight * multiplier),
            );
        }
        let explicit = &reading.prefs["taste"];
        for (index, name, weight) in [
            (0, "authors", 5.0),
            (2, "genres", 4.0),
            (4, "languages", 2.0),
        ] {
            for value in items(&explicit[name]).iter().filter_map(Value::as_str) {
                *taste.weights[index].entry(key(value)).or_default() += weight;
            }
        }
        let mut rejected: Vec<_> = feedback.into_iter().flatten().collect();
        rejected.sort_by(|a, b| text(b.1, "updatedAt").cmp(text(a.1, "updatedAt")));
        let mut rejected: HashMap<_, _> = rejected
            .into_iter()
            .take(200)
            .filter_map(|(uid, row)| {
                rejection(text(row, "kind")).map(|weights| (uid.as_str(), weights))
            })
            .collect();
        for uid in items(&reading.prefs["hiddenBooks"])
            .iter()
            .rev()
            .filter_map(Value::as_str)
            .take(200)
        {
            if !feedback.is_some_and(|rows| rows.contains_key(uid)) {
                rejected.insert(uid, rejection("not_interested").expect("known feedback"));
            }
        }
        for (uid, book) in self.books_by_uid(&rejected.keys().copied().collect::<Vec<_>>())? {
            let book: Candidate = serde_json::from_value(book)?;
            add_weights(&mut taste.rejected, book.features(), rejected[uid.as_str()]);
        }
        Ok(taste)
    }

    fn rank_recommendations(
        &self,
        taste: &Taste<'_>,
        reading: &Reading<'_>,
        limit: usize,
        now: i64,
        owner: &str,
        ratio: f64,
    ) -> Result<Vec<Recommendation>> {
        let seed = owner.encode_utf16().fold(now / DAY % 9973, |sum, ch| {
            (sum * 31 + i64::from(ch)) % 9973
        });
        let cap = ((limit + 1) * 16 + 64).max(192);
        let mut affinity = Vec::new();
        let mut exploration = Vec::new();
        let ru = Collator::try_new(icu_locale_core::locale!("ru").into(), Default::default())?;
        let compare = |a: &Recommendation, b: &Recommendation| {
            b.score
                .total_cmp(&a.score)
                .then_with(|| ru.compare(&a.book.title, &b.book.title))
                .then_with(|| a.id.cmp(&b.id))
        };
        let candidates =
            self.recommendation_candidates(taste, limit + 1, seed.unsigned_abs() as usize, now)?;
        self.store
            .visit_search_rows(&self.generation, Some(&candidates), |id, bytes| {
                let book: Candidate = serde_json::from_slice(bytes)?;
                if book.del != 0
                    || book.uid.is_empty()
                    || book.title.is_empty()
                    || taste.known.contains(book.uid.as_str())
                {
                    return Ok(());
                }
                let Some((score, explore)) = rank(&book, taste, reading.prefs, now, seed) else {
                    return Ok(());
                };
                let rows = if explore {
                    &mut exploration
                } else {
                    &mut affinity
                };
                rows.push(Recommendation {
                    book,
                    score,
                    explore,
                    id,
                });
                if rows.len() >= cap * 2 {
                    rows.select_nth_unstable_by(cap, compare);
                    rows.truncate(cap);
                }
                Ok(())
            })?;
        affinity.sort_unstable_by(compare);
        exploration.sort_unstable_by(compare);
        affinity.truncate(cap);
        exploration.truncate(cap);
        Ok(diversify(affinity, exploration, limit, ratio))
    }

    fn recommendation_candidates(
        &self,
        taste: &Taste<'_>,
        limit: usize,
        seed: usize,
        now: i64,
    ) -> Result<Vec<u32>> {
        let mut ids = HashSet::new();
        for (i, maximum, budget) in [
            (0, 24, 32),
            (1, 16, 16),
            (2, 16, 32),
            (3, 24, 12),
            (4, 8, 16),
        ] {
            let mut weighted: Vec<_> = taste.weights[i].iter().collect();
            weighted.sort_unstable_by(|a, b| b.1.total_cmp(a.1).then_with(|| a.0.cmp(b.0)));
            let mut keys = std::collections::BTreeSet::new();
            for (key, _) in weighted.into_iter().take(maximum) {
                if i == 3 {
                    crate::catalog_text::words(key, |_, root| {
                        keys.insert(format!("title:{root}"));
                    });
                } else {
                    keys.insert(key.clone());
                }
            }
            if keys.is_empty() {
                continue;
            }
            let budget = limit * budget;
            match i {
                2 | 4 => {
                    self.store
                        .facet(if i == 2 { Facet::Genre } else { Facet::Lang }, |index| {
                            let lists = index.ok_or("missing taste facet")?.matching(
                                |key| matches!(key, Label::Text(text) if keys.contains(text)),
                            );
                            for list in &lists {
                                sample(list, budget / lists.len(), seed + i, |id| {
                                    ids.insert(*id);
                                });
                            }
                            Ok(())
                        })?;
                }
                _ => {
                    let table = match i {
                        0 => Table::Author,
                        1 => Table::Series,
                        _ => Table::Word,
                    };
                    for key in &keys {
                        self.lookup.visit_name_candidates(
                            &self.lookup_generation,
                            table,
                            &[key],
                            |label| label == key,
                            |_, _, _, _, books| {
                                sample(books, budget.div_ceil(keys.len()), seed + i, |id| {
                                    ids.insert(u32::from_le_bytes(*id));
                                });
                                Ok(())
                            },
                        )?;
                    }
                }
            }
        }
        for (facet, values, budget) in [
            (Facet::Librate, &[3, 4, 5][..], 8),
            (Facet::Del, &[0][..], 8),
        ] {
            self.store.facet(facet, |index| {
                let lists = index.ok_or("missing recommendation facet")?.matching(
                    |label| matches!(label, Label::Number(value) if values.contains(value)),
                );
                for list in &lists {
                    sample(
                        list,
                        (limit * budget).div_ceil(lists.len()),
                        seed + 6,
                        |id| {
                            ids.insert(*id);
                        },
                    );
                }
                Ok(())
            })?;
        }
        self.store.facet(Facet::Date, |index| {
            let index = index.ok_or("missing catalogue dates")?;
            let mut dates: Vec<_> = index
                .labels()
                .into_iter()
                .flatten()
                .filter_map(|(id, label)| {
                    let Label::Text(date) = label else {
                        return None;
                    };
                    Some((age(now, &date)?, id))
                })
                .filter(|(days, _)| (0..=365).contains(days))
                .collect();
            dates.sort_unstable();
            let mut remaining = [limit * 4; 3];
            for (days, id) in dates {
                let left = &mut remaining[if days <= 30 {
                    0
                } else if days <= 90 {
                    1
                } else {
                    2
                }];
                if *left > 0 {
                    let books = index.book_lists(&[id])?[0];
                    *left -= sample(books, *left, seed + 5, |id| {
                        ids.insert(*id);
                    });
                }
            }
            Ok(())
        })?;
        let mut result: Vec<_> = ids.into_iter().collect();
        result.sort_unstable();
        Ok(result)
    }
}

// Rotate one selection within each evenly spaced part of a posting list.
fn sample<T>(books: &[T], count: usize, seed: usize, mut add: impl FnMut(&T)) -> usize {
    let take = count.min(books.len());
    for i in 0..take {
        let start = i * books.len() / take;
        let end = (i + 1) * books.len() / take;
        add(&books[start + seed % (end - start)]);
    }
    take
}

fn key(value: &str) -> String {
    value.trim().to_lowercase()
}
fn list_date(list: &Value) -> &str {
    let date = text(list, "updatedAt");
    if date.is_empty() {
        text(list, "createdAt")
    } else {
        date
    }
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Candidate {
    #[serde(rename = "_uid")]
    uid: String,
    author: String,
    series: String,
    title: String,
    genre: String,
    keywords: String,
    lang: String,
    date: String,
    librate: f64,
    del: u32,
}

impl Candidate {
    fn features(&self) -> [Vec<String>; 5] {
        [
            vec![key(&self.author)],
            vec![key(&self.series)],
            terms(&self.genre, &[','], 1),
            terms(&self.keywords, &[',', ';', '|'], 3),
            vec![key(&self.lang)],
        ]
    }
}

fn terms(value: &str, separators: &[char], minimum: usize) -> Vec<String> {
    let mut seen = HashSet::new();
    value
        .split(separators)
        .map(key)
        .filter(|term| term.chars().count() >= minimum && seen.insert(term.clone()))
        .collect()
}

#[derive(Default)]
struct Taste<'a> {
    weights: [HashMap<String, f64>; 5],
    rejected: [HashMap<String, f64>; 5],
    known: HashSet<&'a str>,
}

impl Taste<'_> {
    fn available(&self) -> bool {
        self.weights.iter().any(|map| !map.is_empty())
    }
}

fn add_weights(
    maps: &mut [HashMap<String, f64>; 5],
    features: [Vec<String>; 5],
    weights: [f64; 5],
) {
    for ((map, keys), weight) in maps.iter_mut().zip(features).zip(weights) {
        if weight == 0.0 {
            continue;
        }
        for key in keys.into_iter().filter(|key| !key.is_empty()) {
            *map.entry(key).or_default() += weight;
        }
    }
}

fn rejection(kind: &str) -> Option<[f64; 5]> {
    match kind {
        "dislike_author" => Some([4.0, 1.0, 0.25, 0.15, 0.0]),
        "dislike_genre" => Some([0.15, 0.15, 3.0, 1.0, 0.0]),
        "not_interested" => Some([1.5, 1.0, 1.0, 0.7, 0.0]),
        _ => None,
    }
}

struct Recommendation {
    book: Candidate,
    score: f64,
    explore: bool,
    id: u32,
}

fn rank(
    book: &Candidate,
    taste: &Taste<'_>,
    prefs: &Value,
    now: i64,
    seed: i64,
) -> Option<(f64, bool)> {
    let features = book.features();
    let sums = |maps: &[HashMap<String, f64>; 5]| -> [f64; 5] {
        std::array::from_fn(|i| features[i].iter().filter_map(|key| maps[i].get(key)).sum())
    };
    let [author, series, genres, keywords, lang] = sums(&taste.weights);
    let rejected = sums(&taste.rejected);
    let content = author * 32.0 + series * 36.0 + genres * 26.0 + keywords * 20.0;
    let explore = content <= 0.0;
    if explore
        && (rejected[0] > 0.0
            || rejected[1] > 0.0
            || (2..=3).any(|i| {
                features[i].iter().any(|key| {
                    taste.rejected[i]
                        .get(key)
                        .is_some_and(|weight| *weight >= 1.0)
                })
            }))
    {
        return None;
    }
    let event = &prefs["events"][book.uid.as_str()];
    let impressions = number(&event["impressionCount"]);
    let opened = number(&event["openCount"]);
    let shown_age = age(now, text(event, "lastShownAt")).unwrap_or(i64::MAX);
    if impressions >= 3.0 && opened == 0.0 && shown_age < 30 {
        return None;
    }
    let ignored = (impressions - (opened * 2.0).max(1.0)).max(0.0);
    let rating = book.librate.clamp(0.0, 5.0);
    let mut score = if explore {
        let language = items(&prefs["taste"]["languages"])
            .iter()
            .any(|row| row.as_str() == Some(book.lang.as_str()));
        22.0 + rating * 5.0 + if language { 6.0 } else { 0.0 } - (ignored * 10.0).min(40.0)
    } else {
        content + (lang * 2.0).min(8.0)
            - rejected[0] * 28.0
            - rejected[1] * 24.0
            - rejected[2] * 18.0
            - rejected[3] * 12.0
            - (ignored * 10.0).min(50.0)
    };
    if impressions > 0.0 && shown_age < 7 {
        score -= 8.0;
    }
    score += (opened * 4.0).min(12.0);
    if score <= 0.0 {
        return None;
    }
    if !explore {
        score += rating * 4.0;
    }
    if let Some(days) = age(now, &book.date) {
        let (window, bonus) = if explore { (730, 14.0) } else { (365, 12.0) };
        score += bonus * (1.0 - days.min(window) as f64 / window as f64);
    }
    let rotation = book
        .uid
        .encode_utf16()
        .fold(seed, |sum, ch| (sum * 33 + i64::from(ch) + seed) % 9973);
    Some((score + rotation as f64 * 8.0 / 9973.0, explore))
}

fn diversify(
    mut affinity: Vec<Recommendation>,
    mut explore: Vec<Recommendation>,
    limit: usize,
    ratio: f64,
) -> Vec<Recommendation> {
    let desired = ((limit as f64 * ratio).round() as usize)
        .max(1)
        .min(explore.len());
    let mut exploratory = 0;
    let mut counts: [HashMap<String, usize>; 3] = Default::default();
    let mut result = Vec::new();
    while result.len() <= limit {
        let due =
            exploratory < desired && (result.len() + 1) * desired >= (exploratory + 1) * limit;
        let (first, second) = if due {
            (&mut explore, &mut affinity)
        } else {
            (&mut affinity, &mut explore)
        };
        let Some(book) = pick(first, &counts).or_else(|| pick(second, &counts)) else {
            break;
        };
        exploratory += usize::from(book.explore);
        let features = book.book.features();
        for (map, keys) in counts.iter_mut().zip(features.into_iter().take(3)) {
            for key in keys.into_iter().filter(|key| !key.is_empty()) {
                *map.entry(key).or_default() += 1;
            }
        }
        result.push(book);
    }
    result
}

fn pick(
    rows: &mut Vec<Recommendation>,
    counts: &[HashMap<String, usize>; 3],
) -> Option<Recommendation> {
    let mut best = None;
    let mut highest = f64::NEG_INFINITY;
    for (index, row) in rows.iter().enumerate() {
        let author = counts[0]
            .get(&key(&row.book.author))
            .copied()
            .unwrap_or_default();
        let series = counts[1]
            .get(&key(&row.book.series))
            .copied()
            .unwrap_or_default();
        if author >= 2 || series >= 1 {
            continue;
        }
        let penalty: usize = terms(&row.book.genre, &[','], 1)
            .iter()
            .filter_map(|genre| counts[2].get(genre))
            .sum();
        let score = row.score - 35.0 * author as f64 - 10.0 * penalty as f64;
        if score > highest {
            highest = score;
            best = Some(index);
        }
    }
    best.map(|index| rows.remove(index))
}
