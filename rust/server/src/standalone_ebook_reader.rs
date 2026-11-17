use std::collections::VecDeque;
use std::fmt::Write;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use inpx_catalog::book_delivery::{Book, DownloadError, classify};
use inpx_catalog::ebook_text::CHARACTER_LIMIT;
use serde_json::{Value, json};

use super::pages::{default, reader_args, saved};
use super::{
    Body, Failure, Page, Params, Response, Result, StatusCode, escape, get, hidden, html, number,
    redirect, text, with,
};

const LENGTHS: [usize; 4] = [1000, 1600, 3000, 360];
const FONTS: [usize; 6] = [18, 22, 24, 26, 30, 36];
const COMPACT: usize = 360;
const MAX_CACHE_BYTES: usize = 16 * 1024 * 1024;
const TTL: Duration = Duration::from_secs(300);

#[derive(Default)]
pub(super) struct Cache {
    entries: Mutex<VecDeque<Entry>>,
    loading: Mutex<()>,
}

struct Entry {
    generation: u64,
    uid: String,
    inserted: Instant,
    content: Arc<Text>,
}

struct Text {
    units: Vec<u16>,
    offsets: [Vec<usize>; LENGTHS.len()],
}

impl Text {
    fn new(units: Vec<u16>) -> Self {
        let offsets = LENGTHS.map(|length| offsets(&units, length));
        Self { units, offsets }
    }

    fn bytes(&self) -> usize {
        self.units.capacity() * size_of::<u16>()
            + self
                .offsets
                .iter()
                .map(|offset| offset.capacity() * size_of::<usize>())
                .sum::<usize>()
    }
}

impl Cache {
    fn read(&self, page: &Page<'_>, book: &Book) -> Result<(Arc<Text>, u64)> {
        let generation = page.state.index.generation();
        let uid = &book.uid;
        if let Some(text) = self.get(uid, generation) {
            return Ok((text, generation));
        }
        let _loading = self.loading.try_lock().map_err(|_| Failure::busy())?;
        if let Some(text) = self.get(uid, generation) {
            return Ok((text, generation));
        }
        let units = page
            .state
            .downloads
            .ebook_text(book, &page.state.index.sources())
            .map_err(read_error)?;
        if generation != page.state.index.generation() {
            return Err(Failure::busy());
        }
        let content = Arc::new(Text::new(units));
        let mut entries = self.entries.lock().expect("ebook reader cache");
        let mut size = content.bytes()
            + entries
                .iter()
                .map(|entry| entry.content.bytes())
                .sum::<usize>();
        while entries.len() >= 8 || size > MAX_CACHE_BYTES {
            let Some(entry) = entries.pop_front() else {
                break;
            };
            size -= entry.content.bytes();
        }
        entries.push_back(Entry {
            generation,
            uid: uid.clone(),
            inserted: Instant::now(),
            content: content.clone(),
        });
        Ok((content, generation))
    }

    fn get(&self, uid: &str, generation: u64) -> Option<Arc<Text>> {
        let mut entries = self.entries.lock().expect("ebook reader cache");
        entries.retain(|entry| entry.generation == generation && entry.inserted.elapsed() < TTL);
        let index = entries.iter().position(|entry| entry.uid == uid)?;
        let entry = entries.remove(index)?;
        let content = entry.content.clone();
        entries.push_back(entry);
        Some(content)
    }
}

struct Reading {
    book: Value,
    content: Arc<Text>,
    args: Params,
    book_args: Params,
    at: usize,
    page: usize,
    length_index: usize,
    font: usize,
    state: Value,
    catalogue_generation: u64,
}

impl Page<'_> {
    fn reading(&self) -> Result<Reading> {
        let uid = self.uid()?;
        let font = number(&self.query, "font", 18, 36)?.unwrap_or(30);
        let legacy_page = number(&self.query, "page", 1, 2048)?;
        let length =
            number(&self.query, "length", 1, LENGTHS[2])?.unwrap_or(if legacy_page.is_some() {
                LENGTHS[2]
            } else {
                LENGTHS[0]
            });
        let length_index = LENGTHS
            .iter()
            .position(|item| *item == length)
            .ok_or_else(Failure::invalid)?;
        if !FONTS.contains(&font) {
            return Err(Failure::invalid());
        }
        let requested = number(&self.query, "at", 0, CHARACTER_LIMIT - 1)?;
        let book = self.find_book(uid)?;
        if !self.readable(text(&book, "ext")) {
            return Err(Failure::new(
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                "Скачайте книгу для чтения на устройстве.",
            ));
        }
        let record: Book = serde_json::from_value(book.clone())
            .map_err(|error| Failure::from(Box::new(error) as Box<dyn std::error::Error>))?;
        let (content, catalogue_generation) = self.site.text.read(self, &record)?;
        let boundaries = &content.offsets[length_index];
        let state = self.progress(uid)?;
        let mut at = match (requested, legacy_page) {
            (Some(requested), _) => requested,
            (None, Some(page)) => *boundaries
                .get(page - 1)
                .ok_or_else(|| Failure::missing("Страница не найдена."))?,
            (None, None) => resume(&content.units, &state),
        };
        if at >= content.units.len() {
            return Err(Failure::missing("Страница не найдена."));
        }
        if at > 0 && low_surrogate(content.units[at]) && high_surrogate(content.units[at - 1]) {
            at -= 1;
        }
        let page = boundaries.partition_point(|offset| *offset <= at);
        let page_of_book = number(&self.query, "bookPage", 1, 100000)?
            .unwrap_or(1)
            .to_string();
        let scope = with(&self.scope(&self.query)?, &[("page", &page_of_book)]);
        let book_args = with(&scope, &[("uid", uid)]);
        let args = with(
            &reader_args(&scope, uid),
            &[("font", &font.to_string()), ("length", &length.to_string())],
        );
        Ok(Reading {
            book,
            content,
            args,
            book_args,
            at,
            page,
            length_index,
            font,
            state,
            catalogue_generation,
        })
    }

    pub(super) fn read(&self, head: bool) -> Result<Response<Body>> {
        let page = self.reading()?;
        let Reading {
            book,
            content,
            args,
            book_args,
            at,
            page: index,
            length_index,
            font,
            state,
            ..
        } = page;
        let boundaries = &content.offsets[length_index];
        let total = boundaries.len() - 1;
        let compact = LENGTHS[length_index] == COMPACT;
        let previous = if at > boundaries[index - 1] {
            Some(boundaries[index - 1])
        } else {
            index.checked_sub(2).map(|previous| boundaries[previous])
        };
        let turn = |offset: usize, label: &str| {
            let args = with(&args, &[("at", &offset.to_string())]);
            if self.owner().is_none() {
                return self.site.link("/read", &args, label, "");
            }
            let generation = state["progressGeneration"].as_u64().unwrap_or_default();
            let revision = state["progress"]["revision"].as_u64().unwrap_or_default();
            format!(
                r#"<form method="post" action="{}">{}{}{}<button type="submit">{label}</button></form>"#,
                escape(&self.site.url("/read", &args)),
                hidden("csrf", &self.access.csrf),
                hidden("generation", &generation.to_string()),
                hidden("revision", &revision.to_string())
            )
        };
        let before = previous.map_or_else(String::new, |offset| {
            turn(
                offset,
                if compact {
                    "Назад"
                } else {
                    "Предыдущая"
                },
            )
        });
        let after = if index < total {
            turn(
                boundaries[index],
                if compact {
                    "Вперёд"
                } else {
                    "Следующая"
                },
            )
        } else {
            String::new()
        };
        let indicator = if compact {
            format!("{index} / {total}")
        } else {
            format!("Страница {index} из {total}")
        };
        let navigation = format!(
            r#"<nav class="pagination reader-pages" aria-label="Страницы">{before}<span>{indicator}</span>{after}</nav>"#
        );
        let current = with(&args, &[("at", &at.to_string())]);
        let (view, view_label) = if compact {
            ("1000", "Обычный вид")
        } else {
            ("360", "Малый экран")
        };
        let links = format!(
            r#"<div class="reader-view-links">{} {}</div>"#,
            self.site.link("/book", &book_args, "О книге", ""),
            self.site.link(
                "/read",
                &with(&current, &[("length", view)]),
                view_label,
                ""
            )
        );
        let mut body = String::new();
        if !compact {
            body.push_str(&links);
            body.push_str(r#"<nav class="reader-options" aria-label="Размер шрифта">Шрифт "#);
            for size in [24, 30, 36] {
                let size = size.to_string();
                if get(&args, "font") == size {
                    let _ = write!(body, "<strong>{size}</strong>");
                } else {
                    body.push_str(&self.site.link(
                        "/read",
                        &with(&current, &[("font", &size)]),
                        &size,
                        "",
                    ));
                }
            }
            body.push_str(
                r#"</nav><nav class="reader-options" aria-label="Длина страницы">Страницы "#,
            );
            for (size, label) in LENGTHS[..3].iter().zip(["Короткие", "Средние", "Длинные"])
            {
                if *size == LENGTHS[length_index] {
                    let _ = write!(body, "<strong>{label}</strong>");
                } else {
                    body.push_str(&self.site.link(
                        "/read",
                        &with(&current, &[("length", &size.to_string())]),
                        label,
                        "",
                    ));
                }
            }
            body.push_str("</nav>");
        }
        if self.owner().is_some() && get(&self.query, "progress") == "changed" {
            let _ = write!(
                body,
                r#"<p class="meta" role="status">Место в профиле изменилось. {}</p>"#,
                self.site
                    .link("/read", &args, "Открыть сохранённое место", "")
            );
        }
        if !compact {
            body.push_str(&navigation);
        }
        let font = if compact { font.min(20) } else { font };
        let _ = write!(body, r#"<div class="reading" style="font-size:{font}px">"#);
        for paragraph in String::from_utf16_lossy(&content.units[at..boundaries[index]])
            .lines()
            .filter(|text| !text.trim().is_empty())
        {
            let _ = write!(body, "<p>{}</p>", escape(paragraph));
        }
        body.push_str("</div>");
        body.push_str(&navigation);
        if compact {
            body.push_str(&links);
        }
        let title = default(text(&book, "title"), "Чтение");
        Ok(html(
            StatusCode::OK,
            self.site
                .document(title, &body, &self.account(), true, compact),
            head,
        ))
    }

    pub(super) fn save_reading(&self, form: &Params) -> Result<Response<Body>> {
        let generation = number(form, "generation", 0, 99_999_999)?.ok_or_else(Failure::invalid)?;
        let revision = number(form, "revision", 0, 99_999_999)?.ok_or_else(Failure::invalid)?;
        let page = self.reading()?;
        if page.catalogue_generation != self.state.index.generation() {
            return Err(Failure::busy());
        }
        let uid = self.uid()?;
        let text = &page.content.units;
        let until = safe_end(text, (page.at + 160).min(text.len()));
        let snippet = String::from_utf16_lossy(&text[page.at..until]);
        let snippet = snippet.trim().lines().next().unwrap_or_default().trim();
        let patch = json!({"percent":page.at as f64/text.len() as f64,"sectionId":"","pageIndex":0,
            "textOffset":-1,"textSnippet":snippet,"hidden":false,"generation":generation,"baseRevision":revision});
        self.check_identity()?;
        let result = self
            .state
            .access
            .with_personal_profile(self.profile_request(), |reader, owner, stamp| {
                reader.request(owner, stamp, uid, Some(&patch))
            })?;
        let progress = &result["progress"];
        let mut params = with(&page.args, &[("at", &page.at.to_string())]);
        if ["conflict", "generationMismatch", "reset"]
            .iter()
            .any(|field| progress[*field] == true)
        {
            params.insert("progress".into(), "changed".into());
        }
        Ok(redirect(
            StatusCode::SEE_OTHER,
            &self.site.url("/read", &params),
        ))
    }
}

fn read_error(error: Box<dyn std::error::Error>) -> Failure {
    match classify(error.as_ref()) {
        DownloadError::Missing => Failure::missing("Файл книги не найден."),
        DownloadError::Limit => Failure::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "Для текстового режима книга слишком велика. Скачайте файл для чтения на устройстве.",
        ),
        DownloadError::Unsupported => Failure::new(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "Текст книги не найден. Скачайте оригинал.",
        ),
        DownloadError::Internal => error.into(),
    }
}

fn offsets(text: &[u16], maximum: usize) -> Vec<usize> {
    let mut result = vec![0];
    let mut start = 0;
    while start < text.len() {
        let mut end = (start + maximum).min(text.len());
        if end < text.len() {
            let middle = start + maximum / 2 + 1;
            let tail = &text[middle..=end];
            if let Some(boundary) = tail
                .iter()
                .rposition(|&unit| unit == u16::from(b'\n'))
                .or_else(|| tail.iter().rposition(|&unit| unit == u16::from(b' ')))
            {
                end = middle + boundary + 1;
            }
            end = safe_end(text, end);
        }
        result.push(end);
        start = end;
    }
    result
}

fn safe_end(text: &[u16], end: usize) -> usize {
    if end < text.len() && end > 0 && high_surrogate(text[end - 1]) && low_surrogate(text[end]) {
        end - 1
    } else {
        end
    }
}

fn high_surrogate(unit: u16) -> bool {
    (0xd800..=0xdbff).contains(&unit)
}
fn low_surrogate(unit: u16) -> bool {
    (0xdc00..=0xdfff).contains(&unit)
}

fn resume(units: &[u16], state: &Value) -> usize {
    if !saved(state) {
        return 0;
    }
    let progress = &state["progress"];
    let percent = progress["percent"]
        .as_f64()
        .unwrap_or_default()
        .clamp(0.0, 1.0);
    let near = ((units.len() as f64 * percent).round() as usize).min(units.len() - 1);
    let snippet: Vec<_> = text(progress, "textSnippet")
        .trim()
        .encode_utf16()
        .collect();
    if snippet.is_empty() || snippet.len() > units.len() {
        return near;
    }
    let last = units.len() - snippet.len();
    let before = (0..=near.min(last))
        .rev()
        .find(|&index| units[index..].starts_with(&snippet));
    let after = (near..=last).find(|&index| units[index..].starts_with(&snippet));
    match (before, after) {
        (Some(before), Some(after)) if near - before <= after - near => before,
        (_, Some(after)) => after,
        (Some(before), None) => before,
        (None, None) => near,
    }
}
