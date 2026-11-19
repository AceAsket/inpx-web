use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap, HashSet};

use redb::{ReadOnlyMultimapTable, ReadOnlyTable, ReadTransaction, ReadableTable};
use serde::{Deserialize, Serialize};

use crate::Result;
use crate::index::{BOOKS, Book, COPIES, DATES, RATED, UIDS};

const DAY_MS: i64 = 86_400_000;

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShelfRequest {
    pub generation: String,
    pub now_ms: i64,
    pub days_windows: Vec<u32>,
    pub newest_limit: usize,
    pub popular_limit: usize,
    #[serde(default)]
    pub scores: HashMap<String, u64>,
}

#[derive(Default)]
struct Diversity {
    authors: HashMap<String, usize>,
    series: HashMap<String, usize>,
}

impl Diversity {
    fn accepts(&mut self, book: &Book) -> bool {
        let author = &book.author_group;
        let series = &book.series_group;
        if (!author.is_empty() && self.authors.get(author).copied().unwrap_or(0) >= 2)
            || (!series.is_empty() && self.series.get(series).copied().unwrap_or(0) >= 2)
        {
            return false;
        }
        if !author.is_empty() {
            *self.authors.entry(author.clone()).or_default() += 1;
        }
        if !series.is_empty() {
            *self.series.entry(series.clone()).or_default() += 1;
        }
        true
    }
}

type Books = ReadOnlyTable<u64, &'static [u8]>;
type Copies = ReadOnlyMultimapTable<&'static str, u64>;

fn book_by_id(books: &Books, id: u64) -> Result<Book> {
    let entry = books
        .get(id)?
        .ok_or_else(|| format!("missing catalog record {id}"))?;
    Ok(serde_json::from_slice(entry.value())?)
}

fn cutoff(now: i64, days: u32) -> i64 {
    // The legacy age is floor((now - date) / DAY_MS) and includes the requested day.
    now.saturating_sub(DAY_MS * (i64::from(days) + 1) - 1)
}

fn newest(
    transaction: &ReadTransaction,
    books: &Books,
    request: &ShelfRequest,
) -> Result<Vec<Vec<String>>> {
    let Some(&widest) = request.days_windows.iter().max() else {
        return Ok(Vec::new());
    };
    if request.newest_limit == 0 {
        return Ok(vec![Vec::new(); request.days_windows.len()]);
    }
    let dates = transaction.open_table(DATES)?;
    let now = request.now_ms;
    let mut candidates = Vec::new();
    for entry in dates.range((cutoff(now, widest), 0)..=(now, u64::MAX))? {
        let (key, _) = entry?;
        candidates.push(book_by_id(books, key.value().1)?);
    }

    let mut seen = HashSet::new();
    let mut windows = Vec::new();
    let mut widest_so_far = 0;
    for &days in &request.days_windows {
        widest_so_far = widest_so_far.max(days);
        let after = cutoff(now, widest_so_far);
        let mut preferred: HashMap<&str, &Book> = HashMap::new();
        for book in &candidates
            [candidates.partition_point(|book| book.date_ms.unwrap_or_default() < after)..]
        {
            if !seen.contains(book.uid.as_str()) {
                let best = preferred.entry(&book.copy_key).or_insert(book);
                if book.better_copy_than(best) {
                    *best = book;
                }
            }
        }
        let ranked: Vec<_> = preferred.into_values().collect();
        let mut queue = BinaryHeap::from(
            ranked
                .iter()
                .enumerate()
                .map(|(index, book)| {
                    Reverse((
                        Reverse(book.date_order),
                        Reverse(book.rating),
                        book.author_order,
                        book.title_order,
                        book.id,
                        index,
                    ))
                })
                .collect::<Vec<_>>(),
        );
        let mut diversity = Diversity::default();
        let selected: Vec<_> = std::iter::from_fn(|| {
            queue
                .pop()
                .map(|Reverse((_, _, _, _, _, index))| ranked[index])
        })
        .filter(|book| diversity.accepts(book))
        .take(request.newest_limit)
        .collect();
        seen.extend(selected.iter().map(|book| book.uid.as_str()));
        windows.push(selected.into_iter().map(|book| book.uid.clone()).collect());
    }
    Ok(windows)
}

fn score(request: &ShelfRequest, book: &Book) -> u64 {
    request.scores.get(&book.uid).copied().unwrap_or(0)
}

fn best_popular_copy(
    books: &Books,
    copies: &Copies,
    request: &ShelfRequest,
    book: &Book,
) -> Result<bool> {
    for other in copies.get(book.copy_key.as_str())? {
        let id = other?.value();
        if id != book.id {
            let other = book_by_id(books, id)?;
            if (other.rating > 0 || score(request, &other) > 0) && other.better_copy_than(book) {
                return Ok(false);
            }
        }
    }
    Ok(true)
}

fn popular(
    transaction: &ReadTransaction,
    books: &Books,
    request: &ShelfRequest,
) -> Result<Vec<String>> {
    let uids = transaction.open_table(UIDS)?;
    let copies = transaction.open_multimap_table(COPIES)?;
    let rated = transaction.open_table(RATED)?;
    let mut scored = Vec::new();
    for (uid, &activity) in &request.scores {
        if activity > 0
            && let Some(id) = uids.get(uid.as_str())?
        {
            scored.push(book_by_id(books, id.value())?);
        }
    }
    scored.sort_unstable_by_key(|book| (Reverse(score(request, book)), book.rated_order()));
    let mut diversity = Diversity::default();
    let mut selected = Vec::new();
    // Score dominates rating. Once the activity candidates are exhausted,
    // the rating index supplies the remaining books in their final order.
    for book in scored {
        if best_popular_copy(books, &copies, request, &book)? && diversity.accepts(&book) {
            selected.push(book.uid);
            if selected.len() == request.popular_limit {
                return Ok(selected);
            }
        }
    }
    for entry in rated.iter()? {
        let (key, _) = entry?;
        let book = book_by_id(books, key.value().4)?;
        if score(request, &book) == 0
            && best_popular_copy(books, &copies, request, &book)?
            && diversity.accepts(&book)
        {
            selected.push(book.uid);
            if selected.len() == request.popular_limit {
                break;
            }
        }
    }
    Ok(selected)
}

pub(crate) fn select(
    transaction: &ReadTransaction,
    request: &ShelfRequest,
) -> Result<Vec<Vec<String>>> {
    let books = transaction.open_table(BOOKS)?;
    let mut windows = newest(transaction, &books, request)?;
    if request.popular_limit > 0 {
        windows.push(popular(transaction, &books, request)?);
    }
    Ok(windows)
}
