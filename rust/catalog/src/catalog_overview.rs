use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use icu_collator::Collator;
use serde::Deserialize;
use serde_json::{Value, json};
use time::{Date, OffsetDateTime, format_description::well_known::Iso8601};

use crate::Result;
use crate::facets::{Facet, Label};
use crate::reader_state::number;
use crate::standalone_catalogue::Catalogue;

const WINDOWS: [i64; 5] = [7, 30, 90, 180, 365];
const TTL: Duration = Duration::from_secs(15 * 60);

#[derive(Default)]
pub(crate) struct ShelfCache {
    variants: HashMap<(usize, usize, Date), (Instant, Value)>,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Candidate {
    id: u32,
    #[serde(rename = "_uid")]
    uid: String,
    date: String,
    author: String,
    title: String,
    series: String,
    librate: i64,
    source_id: String,
    libid: String,
    folder: String,
    file: String,
    ext: String,
    insno: i64,
    size: i64,
}

struct Ranked {
    book: Candidate,
    copy: String,
    author: String,
    series: String,
    quality: i64,
    activity: u64,
}

impl Ranked {
    fn new(book: Candidate, activity: u64) -> Self {
        let copy = if book.libid.is_empty() {
            format!(
                "file:{}|{}|{}|{}|{}",
                book.source_id, book.folder, book.file, book.ext, book.insno
            )
        } else {
            format!("libid:{}:{}", book.source_id, book.libid)
        };
        let format = match book.ext.as_str() {
            "fb2" => 120,
            "epub" => 90,
            "mobi" => 70,
            "pdf" => 50,
            _ => 0,
        };
        let quality = (format + book.librate * 10) * 1_000_000 + book.size.min(50_000_000);
        Self {
            author: book.author.trim().to_lowercase(),
            series: book.series.trim().to_lowercase(),
            book,
            copy,
            quality,
            activity,
        }
    }
}

impl Catalogue {
    pub fn local_overview(
        &self,
        newest_limit: usize,
        popular_limit: usize,
        scores: &HashMap<String, u64>,
    ) -> Result<Value> {
        self.check_lease()?;
        let updated = crate::access_runtime::now_ms();
        let today = OffsetDateTime::from_unix_timestamp(updated / 1000)?.date();
        let key = (newest_limit, popular_limit, today);
        let mut cache = self
            .overview_cache
            .lock()
            .map_err(|_| "Кэш Обзора недоступен")?;
        if let Some((saved, shelves)) = cache.variants.get(&key)
            && saved.elapsed() < TTL
        {
            return Ok(shelves.clone());
        }
        let limits: Vec<_> = WINDOWS
            .iter()
            .map(|days| (today - time::Duration::days(*days)).to_string())
            .collect();
        let last = limits.last().expect("newest windows");
        let latest = today.to_string();
        let active = self.store.opds_books(&[])?;
        let mut ids = Vec::new();
        self.store
            .select_facet(
                Facet::Date,
                Some(&active),
                |label| matches!(label, Label::Text(date) if date >= last && date <= &latest),
            )?
            .extend_ids(&mut ids);
        self.store
            .select_facet(
                Facet::Librate,
                Some(&active),
                |label| matches!(label, Label::Number(rating) if *rating > 0),
            )?
            .extend_ids(&mut ids);
        let scored: Vec<_> = scores.keys().map(String::as_str).collect();
        for batch in scored.chunks(1000) {
            ids.extend(
                self.browser_books_by_uid(batch.iter().copied())?
                    .into_iter()
                    .filter_map(|book| book["id"].as_u64().and_then(|id| u32::try_from(id).ok()))
                    .filter(|id| active.contains(*id)),
            );
        }
        ids.sort_unstable();
        ids.dedup();

        let mut rows = Vec::with_capacity(ids.len());
        self.store
            .visit_search_rows(&self.generation, Some(&ids), |id, bytes| {
                let mut book: Candidate = serde_json::from_slice(bytes)?;
                if !book.uid.is_empty() && !book.title.is_empty() {
                    let activity = scores.get(&book.uid).copied().unwrap_or_default();
                    book.id = id;
                    rows.push(Ranked::new(book, activity));
                }
                Ok(())
            })?;
        let russian = Collator::try_new(icu_locale_core::locale!("ru").into(), Default::default())?;
        let ties = |a: &Ranked, b: &Ranked| {
            russian
                .compare(&a.book.author, &b.book.author)
                .then_with(|| russian.compare(&a.book.title, &b.book.title))
                .then_with(|| a.book.id.cmp(&b.book.id))
        };
        let recent = |a: &Ranked, b: &Ranked| {
            b.book
                .date
                .cmp(&a.book.date)
                .then_with(|| b.book.librate.cmp(&a.book.librate))
                .then_with(|| ties(a, b))
        };
        let popular = |a: &Ranked, b: &Ranked| {
            b.activity
                .cmp(&a.activity)
                .then_with(|| b.book.librate.cmp(&a.book.librate))
                .then_with(|| b.book.date.cmp(&a.book.date))
                .then_with(|| ties(a, b))
        };
        let mut seen = HashSet::new();
        let mut shelves = Vec::new();
        for (days, limit) in WINDOWS.into_iter().zip(limits) {
            let window = rows.iter().filter(|row| {
                row.book.date >= limit
                    && row.book.date <= latest
                    && !seen.contains(row.book.uid.as_str())
            });
            let selected = select(window, newest_limit, recent);
            if selected.is_empty() {
                continue;
            }
            seen.extend(selected.iter().map(|row| row.book.uid.as_str()));
            let items = self.overview_books(&selected, |book, _, row| {
                let age = Date::parse(&row.book.date, &Iso8601::PARSING)
                    .map_or(0, |date| (today - date).whole_days());
                book["discoveryReason"] = match age {
                    0 => "Добавлена сегодня".into(),
                    1 => "Добавлена вчера".into(),
                    days => format!("Добавлена {days} дн. назад").into(),
                };
            })?;
            shelves.push(json!({
                "id":format!("newest-{days}d"),"title":format!("Новинки за {days} дней"),
                "subtitle":format!("Книги, добавленные за последние {days} дней"),"mode":"newest",
                "source":"local","sourceName":"Локальная библиотека","updatedAt":updated,"items":items,
            }));
        }
        if shelves.is_empty() {
            shelves.push(json!({
                "id":"newest-0d","title":"Новинки не найдены","mode":"newest","source":"local",
                "subtitle":"В индексе нет книг с датой поступления за последний год",
                "sourceName":"Локальная библиотека","updatedAt":updated,"items":[],
                "emptyMessage":"Нет книг с датой поступления за последний год. Обновите индекс или используйте раздел «Книги».",
            }));
        }
        let ranked = rows
            .iter()
            .filter(|row| row.activity > 0 || row.book.librate > 0);
        let selected = select(ranked, popular_limit, popular);
        if !selected.is_empty() {
            let items = self.overview_books(&selected, |book, rating, row| {
                let mut reasons = Vec::new();
                if row.activity > 0 {
                    reasons.push("Популярно у читателей".into());
                }
                if rating > 0.0 {
                    reasons.push(format!("Оценка библиотеки {rating}/5"));
                }
                book["discoveryReason"] = reasons.join(" · ").into();
            })?;
            shelves.push(json!({
                "id":"popular","title":"Популярное в библиотеке","mode":"popular","source":"local",
                "subtitle":"Локальный рейтинг по чтению, спискам и оценкам","sourceName":"Локальная библиотека",
                "updatedAt":updated,"items":items,
            }));
        }
        let result = json!({"shelves":shelves});
        if cache.variants.len() >= 8 {
            cache.variants.clear();
        }
        cache.variants.insert(key, (Instant::now(), result.clone()));
        Ok(result)
    }

    fn overview_books(
        &self,
        selected: &[&Ranked],
        decorate: impl Fn(&mut Value, f64, &Ranked),
    ) -> Result<Vec<Value>> {
        let ids = selected.iter().map(|row| row.book.id).collect();
        let mut books: HashMap<_, _> = self
            .store
            .catalogue_rows(&self.generation, ids)?
            .into_iter()
            .filter_map(|book| book.get("id")?.as_u64().map(|id| (id as u32, book)))
            .collect();
        Ok(selected
            .iter()
            .filter_map(|row| {
                let mut book =
                    serde_json::to_value(books.remove(&row.book.id)?).expect("catalogue row");
                let rating = number(&book["librate"]);
                decorate(&mut book, rating, row);
                Some(book)
            })
            .collect())
    }
}

fn select<'a>(
    rows: impl Iterator<Item = &'a Ranked>,
    limit: usize,
    compare: impl Fn(&Ranked, &Ranked) -> Ordering,
) -> Vec<&'a Ranked> {
    let mut copies: HashMap<&str, &Ranked> = HashMap::new();
    for row in rows {
        let current = copies.entry(row.copy.as_str()).or_insert(row);
        if (row.quality, std::cmp::Reverse(row.book.id))
            > (current.quality, std::cmp::Reverse(current.book.id))
        {
            *current = row;
        }
    }
    let mut rows: Vec<_> = copies.into_values().collect();
    let mut count = rows.len().min(64.max(limit * 8));
    loop {
        if count < rows.len() {
            rows.select_nth_unstable_by(count, |a, b| compare(a, b));
        }
        rows[..count].sort_unstable_by(|a, b| compare(a, b));
        let mut authors = HashMap::new();
        let mut series = HashMap::new();
        let mut selected = Vec::new();
        for &row in &rows[..count] {
            let author = authors.entry(row.author.as_str()).or_insert(0);
            let series = series.entry(row.series.as_str()).or_insert(0);
            if (!row.author.is_empty() && *author >= 2) || (!row.series.is_empty() && *series >= 2)
            {
                continue;
            }
            *author += 1;
            *series += 1;
            selected.push(row);
            if selected.len() == limit {
                return selected;
            }
        }
        if count == rows.len() {
            return selected;
        }
        count = rows.len().min(count * 2);
    }
}
