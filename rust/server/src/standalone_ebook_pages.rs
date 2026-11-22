use std::fmt::Write;

use super::{
    Body, FORMAT_NAMES, Failure, Page, Params, Response, Result, StatusCode, encode, escape, get,
    hidden, number, option, redirect, scalar, text, with,
};
use inpx_catalog::book_delivery::Book;
use inpx_catalog::reader_state::{apply_metadata_override, apply_search_metadata};
use serde_json::{Value, json};

const FORMATS: &[(&str, &str)] = &[
    ("", "Все форматы"),
    ("fb2", "FB2"),
    ("epub", "EPUB"),
    ("pdf", "PDF"),
    ("mobi", "MOBI"),
];
const FIELDS: &[(&str, &str)] = &[
    ("title", "Название книги"),
    ("author", "Автор"),
    ("series", "Серия"),
];
const MODES: &[(&str, &str)] = &[
    ("words", "Все слова"),
    ("contains", "Фраза внутри текста"),
    ("exact", "Точная запись"),
];

impl Page<'_> {
    pub(super) fn scope(&self, query: &Params) -> Result<Params> {
        let selected = |key, default, allowed: &[(&str, &str)]| -> Result<String> {
            let value = scalar(query, key, 12)?;
            let value = if value.is_empty() { default } else { value };
            if allowed.iter().any(|(key, _)| *key == value) {
                Ok(value.into())
            } else {
                Err(Failure::invalid())
            }
        };
        let field = selected("field", "title", FIELDS)?;
        let mode = selected("mode", "words", MODES)?;
        let lang = if query.contains_key("lang") {
            scalar(query, "lang", 40)?
        } else {
            &self.site.language
        };
        let ext = scalar(query, "ext", 12)?;
        if !lang
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b", _-".contains(&byte))
            || !ext.bytes().all(|byte| byte.is_ascii_alphanumeric())
        {
            return Err(Failure::invalid());
        }
        Ok(with(
            &Params::new(),
            &[
                ("q", scalar(query, "q", 160)?),
                (
                    "author",
                    if field == "author" {
                        ""
                    } else {
                        scalar(query, "author", 160)?
                    },
                ),
                ("field", &field),
                ("mode", &mode),
                ("lang", lang),
                ("ext", ext),
                ("sourceId", scalar(query, "sourceId", 64)?),
                (
                    "covers",
                    if scalar(query, "covers", 1)? == "1" {
                        "1"
                    } else {
                        "0"
                    },
                ),
                (
                    "page",
                    &number(query, "page", 1, 100000)?.unwrap_or(1).to_string(),
                ),
                (
                    "size",
                    &number(query, "size", 1, 20)?.unwrap_or(10).to_string(),
                ),
                ("back", scalar(query, "back", 2048)?),
            ],
        ))
    }

    pub(super) fn search(&self) -> Result<(String, String)> {
        let scope = self.scope(&self.query)?;
        let advanced = scalar(&self.query, "options", 1)? == "1";
        let mut content = self.search_form(&scope, advanced);
        if advanced {
            return Ok(("Параметры поиска".into(), content));
        }
        let title = "Поиск книг";
        let q = get(&scope, "q");
        let author = get(&scope, "author");
        if q.is_empty() && author.is_empty() {
            return Ok((title.into(), content));
        }
        let page = number(&scope, "page", 1, 100000)?.unwrap_or(1);
        let size = number(&scope, "size", 1, 20)?.unwrap_or(10);
        let mut query = json!({
            "lang":scope["lang"],"ext":scope["ext"],"sourceId":scope["sourceId"],"del":"0",
            "limit":size,"offset":(page-1)*size,
        });
        if !q.is_empty() {
            query[&scope["field"]] = term(q, &scope["mode"]).into();
        }
        if !author.is_empty() {
            query["author"] = term(author, "words").into();
        }
        let mut result = self.catalogue(|catalogue| {
            Ok(catalogue.browser_books(query.as_object().expect("search"))?)
        })?;
        apply_search_metadata(
            &mut result,
            self.state.access.metadata_overrides()?.as_ref(),
        );
        let count = result["totalFound"].as_u64().unwrap_or_default() as usize;
        let total = count.div_ceil(size).max(1);
        let _ = write!(
            content,
            r#"<div class="result-header"><h2>Найдено: {count}</h2></div>"#
        );
        if page > total {
            content.push_str("<p>На этой странице результатов нет.</p>");
            content.push_str(&self.site.link(
                "",
                &with(&scope, &[("page", "1")]),
                "К первой странице",
                "",
            ));
        } else {
            for book in list(&result["found"]) {
                content.push_str(&self.row(book, &scope));
            }
            content.push_str(&self.navigation("", &scope, page, total));
        }
        Ok((title.into(), content))
    }

    fn search_form(&self, p: &Params, advanced: bool) -> String {
        let field = get(p, "field");
        let label = FIELDS
            .iter()
            .find(|item| item.0 == field)
            .map_or("Название книги", |item| item.1);
        let author = if field == "author" {
            String::new()
        } else {
            format!(
                r#"<div class="field"><label for="author">Автор</label><input id="author" name="author" value="{}" maxlength="160"></div>"#,
                escape(get(p, "author"))
            )
        };
        let mut content = format!(
            r#"<p class="intro">Заполните одно или оба поля.</p><form class="search" action="{}" method="get"><div class="fields"><div class="field"><label for="q">{label}</label><input id="q" name="q" value="{}" maxlength="160"></div>{author}</div>"#,
            escape(&self.site.base),
            escape(get(p, "q"))
        );
        if advanced {
            let source = get(p, "sourceId");
            let sources = self.state.index.sources();
            let sources = sources.iter().fold(
                option("", "Все библиотеки", source),
                |mut items, row| {
                    items.push_str(&option(&row.id, &row.name, source));
                    items
                },
            );
            let _ = write!(
                content,
                r#"<label for="field">Где искать</label><select id="field" name="field">{}</select><label for="mode">Совпадение</label><select id="mode" name="mode">{}</select><fieldset><legend>Параметры поиска</legend><label for="lang">Язык (например, ru или en; пусто — все)</label><input id="lang" name="lang" value="{}" maxlength="40"><label for="ext">Формат</label><select id="ext" name="ext">{}</select><label for="sourceId">Библиотека</label><select id="sourceId" name="sourceId">{sources}</select><label for="size">Книг на странице</label><select id="size" name="size">{}</select><label for="covers">Обложки</label><select id="covers" name="covers">{}</select></fieldset><button type="submit">Применить параметры</button></form>"#,
                options(FIELDS, field),
                options(MODES, get(p, "mode")),
                escape(get(p, "lang")),
                options(FORMATS, get(p, "ext")),
                options(&[("10", "10"), ("20", "20")], get(p, "size")),
                options(
                    &[("0", "Без обложек"), ("1", "Показывать")],
                    get(p, "covers")
                )
            );
        } else {
            for key in ["field", "mode", "lang", "ext", "sourceId", "size", "covers"] {
                content.push_str(&hidden(key, get(p, key)));
            }
            let reset = self.site.link(
                "",
                &with(
                    &Params::new(),
                    &[("lang", get(p, "lang")), ("sourceId", get(p, "sourceId"))],
                ),
                "Сбросить",
                "reset",
            );
            let lang = match get(p, "lang") {
                "" => "Все языки",
                "ru" => "Русский язык",
                other => other,
            };
            let ext = get(p, "ext");
            let ext = if ext.is_empty() {
                "Все форматы".into()
            } else {
                ext.to_uppercase()
            };
            let _ = write!(
                content,
                r#"<div class="actions"><button class="primary" type="submit">Найти книги</button>{reset}<button class="options" name="options" value="1">Параметры поиска</button></div><p class="scope">{} · {}</p></form>"#,
                escape(lang),
                escape(&ext)
            );
        }
        content
    }

    pub(super) fn row(&self, book: &Value, scope: &Params) -> String {
        if book["unavailable"] == true {
            return r#"<article class="result"><h3>Книга недоступна</h3><p>Файл отсутствует в текущей библиотеке.</p></article>"#.into();
        }
        let uid = text(book, "_uid");
        let title = default(text(book, "title"), "Без названия");
        let link = self.site.link(
            "/book",
            &with(scope, &[("uid", uid)]),
            &short(title, 240),
            "",
        );
        let mut content = r#"<article class="result">"#.to_string();
        if scope.get("covers").is_some_and(|value| value == "1") {
            let query = encode(&with(&Params::new(), &[("uid", uid)]));
            let _ = write!(
                content,
                r#"<img class="cover" alt="" src="{}/cover/by-uid?{}">"#,
                escape(&self.site.root),
                escape(&query)
            );
        }
        let _ = write!(
            content,
            r#"<span class="book-format">Файл: {}</span><h3>{link}</h3><p class="author">{}</p>"#,
            escape(&text(book, "ext").to_uppercase()),
            escape(default(text(book, "author"), "Автор не указан"))
        );
        if let Some(series) = book["series"].as_str().filter(|series| !series.is_empty()) {
            let _ = write!(content, r#"<p class="series">{}</p>"#, escape(series));
        }
        let _ = write!(
            content,
            r#"<p class="book-meta">{}</p>"#,
            escape(&book_meta(book))
        );
        if self.owner().is_some() {
            content.push_str(&self.download_button(book, self.preferred(), false));
        }
        content.push_str("</article>");
        content
    }

    pub(super) fn find_book(&self, uid: &str) -> Result<Value> {
        let mut book = self.catalogue(|catalogue| {
            catalogue
                .browser_book(uid)?
                .ok_or_else(|| Failure::missing("Книга не найдена."))
        })?;
        if let Some(fields) = book.as_object_mut() {
            apply_metadata_override(fields, self.state.access.metadata_overrides()?.as_ref());
        }
        Ok(book)
    }

    pub(super) fn uid(&self) -> Result<&str> {
        let uid = scalar(&self.query, "uid", 512)?;
        if uid.is_empty() {
            return Err(Failure::new(StatusCode::BAD_REQUEST, "Не указана книга."));
        }
        Ok(uid)
    }

    pub(super) fn book(&self) -> Result<(String, String)> {
        let uid = self.uid()?;
        let book = self.find_book(uid)?;
        let scope = self.scope(&self.query)?;
        let title = default(text(&book, "title"), "Книга");
        let ext = text(&book, "ext").to_ascii_lowercase();
        let mut content = String::new();
        let back = get(&scope, "back");
        if !back.is_empty() {
            let _ = write!(
                content,
                r#"<p><a href="{}">К полке</a></p>"#,
                escape(&self.site.destination(back))
            );
        } else if !get(&scope, "q").is_empty() || !get(&scope, "author").is_empty() {
            content.push_str(&self.site.link("", &scope, "К результатам поиска", ""));
        }
        let authors = text(&book, "author")
            .split(',')
            .map(str::trim)
            .filter(|item| !item.is_empty())
            .take(20)
            .map(|name| {
                self.site.link(
                    "",
                    &with(
                        &scope,
                        &[
                            ("author", ""),
                            ("field", "author"),
                            ("mode", "words"),
                            ("q", &short(name, 160)),
                            ("page", "1"),
                            ("back", ""),
                        ],
                    ),
                    name,
                    "",
                )
            })
            .collect::<Vec<_>>();
        let _ = write!(content, "<p>{}</p>", authors.join(", "));
        let series = text(&book, "series");
        if !series.is_empty() {
            let link = self.site.link(
                "",
                &with(
                    &scope,
                    &[
                        ("field", "series"),
                        ("mode", "exact"),
                        ("q", &short(series, 160)),
                        ("page", "1"),
                    ],
                ),
                series,
                "",
            );
            let _ = write!(content, "<p>Серия: {link}</p>");
        }
        let _ = write!(
            content,
            r#"<p class="meta">{} · {}</p>"#,
            escape(&ext.to_uppercase()),
            escape(&book_meta(&book))
        );
        let args = with(&scope, &[("uid", uid)]);
        if self.owner().is_some() {
            content.push_str(&self.format_form(&self.site.url("/book", &args), &ext));
            content.push_str(&self.download_button(&book, self.preferred(), false));
        } else {
            let format = self.guest_format()?;
            let (selected, _, _) = self
                .selection(&ext, &format)
                .ok_or_else(|| unsupported(&format))?;
            let choices = self.state.downloads.ebook_formats(&ext);
            let mut values = option(
                "raw",
                &format!("Оригинал ({})", ext.to_uppercase()),
                selected,
            );
            for name in choices {
                values.push_str(&option(name, &name.to_uppercase(), selected));
            }
            let fields = args
                .iter()
                .map(|(key, value)| hidden(key, value))
                .collect::<String>();
            let _ = write!(
                content,
                r#"<form class="shelf-options guest-format-form" action="{}" method="get">{fields}<label for="format">Формат скачивания</label><select id="format" name="format">{values}</select><button type="submit">Применить формат</button></form>"#,
                escape(&self.site.url("/book", &Params::new()))
            );
            content.push_str(&self.download_button(&book, &format, true));
        }
        if self.readable(&ext) {
            let args = reader_args(&scope, uid);
            let state = self.progress(uid)?;
            let has_position = saved(&state);
            content.push_str(&self.site.link(
                "/read",
                &args,
                if has_position {
                    "Продолжить чтение"
                } else {
                    "Читать текст"
                },
                "button",
            ));
            if has_position {
                content.push_str(&self.site.link(
                    "/read",
                    &with(&args, &[("at", "0")]),
                    "С начала",
                    "button",
                ));
            }
        }
        let annotation = scalar(&self.query, "annotation", 1)? == "1";
        if annotation {
            let record: Book = serde_json::from_value(book.clone())
                .map_err(|error| Failure::from(Box::new(error) as Box<dyn std::error::Error>))?;
            let preview =
                inpx_catalog::book_preview::read(uid, Some(&record), &self.state.index.sources());
            let preview = &preview["bookPreview"];
            let value = text(preview, "annotation");
            content.push_str("<h2>Аннотация</h2>");
            if value.is_empty() {
                content.push_str(if preview["annotationStatus"] == "empty" {
                    "<p>Аннотация отсутствует.</p>"
                } else {
                    "<p>Аннотация пока недоступна.</p>"
                });
            } else {
                let _ = write!(
                    content,
                    r#"<div class="annotation">{}</div>"#,
                    escape(value)
                );
            }
        } else {
            let format = if self.owner().is_none() {
                self.guest_format()?
            } else {
                String::new()
            };
            content.push_str(&self.site.link(
                "/book",
                &with(&args, &[("annotation", "1"), ("format", &format)]),
                "Показать аннотацию",
                "button",
            ));
        }
        Ok((title.into(), content))
    }

    pub(super) fn readable(&self, extension: &str) -> bool {
        self.state.settings.online_reader() && self.state.downloads.ebook_readable(extension)
    }

    pub(super) fn progress(&self, uid: &str) -> Result<Value> {
        if self.owner().is_none() {
            return Ok(Value::Null);
        }
        Ok(self
            .state
            .access
            .with_personal_profile(self.profile_request(), |reader, owner, stamp| {
                reader.request(owner, stamp, uid, None)
            })?)
    }

    fn preferred(&self) -> &str {
        let format = text(&self.profile, "defaultDownloadFormat");
        if FORMAT_NAMES.contains(&format) {
            format
        } else {
            "original"
        }
    }

    fn guest_format(&self) -> Result<String> {
        let value = scalar(&self.query, "format", 12)?.to_ascii_lowercase();
        if value.is_empty() {
            return Ok("raw".into());
        }
        if matches!(value.as_str(), "raw" | "original") || FORMAT_NAMES.contains(&value.as_str()) {
            Ok(value)
        } else {
            Err(Failure::new(
                StatusCode::BAD_REQUEST,
                "Неизвестный формат скачивания.",
            ))
        }
    }

    fn selection<'a>(&self, ext: &str, wanted: &'a str) -> Option<(&'a str, String, String)> {
        let original = matches!(wanted, "original" | "raw") || wanted == ext;
        let choices = self.state.downloads.ebook_formats(ext);
        let (variant, extension) = if original {
            ("raw", ext)
        } else if choices.contains(&wanted) {
            (wanted, self.state.downloads.ebook_extension(wanted)?)
        } else {
            return None;
        };
        let label = if original {
            ext.to_uppercase()
        } else {
            wanted.to_uppercase()
        };
        let suffix = if safe_extension(extension) {
            format!("/book.{extension}")
        } else {
            String::new()
        };
        Some((variant, label, suffix))
    }

    pub(super) fn download_route(&self) -> bool {
        self.path == "/download"
            || self
                .path
                .strip_prefix("/download/book.")
                .is_some_and(safe_extension)
    }

    pub(super) fn download(&self) -> Result<Response<Body>> {
        let uid = self.uid()?;
        let book = self.find_book(uid)?;
        let ext = text(&book, "ext").to_ascii_lowercase();
        let guest;
        let wanted = if self.owner().is_some() {
            self.preferred()
        } else {
            guest = self.guest_format()?;
            &guest
        };
        let (format, _, suffix) = self
            .selection(&ext, wanted)
            .ok_or_else(|| unsupported(wanted))?;
        let params = encode(&with(
            &Params::new(),
            &[("uid", uid), ("format", format), ("filename", "ascii")],
        ));
        Ok(redirect(
            StatusCode::FOUND,
            &format!("{}/book/by-uid{suffix}?{params}", self.site.root),
        ))
    }

    fn download_button(&self, book: &Value, wanted: &str, guest: bool) -> String {
        let ext = text(book, "ext").to_ascii_lowercase();
        let Some((_, label, suffix)) = self.selection(&ext, wanted) else {
            return format!(
                r#"<p class="hint">{} Выберите другой формат в профиле.</p>"#,
                escape(&unsupported(wanted).message)
            );
        };
        let mut params = with(&Params::new(), &[("uid", text(book, "_uid"))]);
        if guest {
            params.insert("format".into(), wanted.into());
        }
        let title = text(book, "title");
        format!(
            r#"<p class="quick-download download-form"><a class="button" href="{}" aria-label="{}">Скачать {}</a></p>"#,
            escape(&self.site.url(&format!("/download{suffix}"), &params)),
            escape(&format!("Скачать «{title}» в формате {label}")),
            escape(&label)
        )
    }

    fn format_form(&self, next: &str, ext: &str) -> String {
        let selected = self.preferred();
        let mut choices = self.state.downloads.formats();
        for value in [ext, selected] {
            if let Some(&name) = FORMAT_NAMES.iter().find(|&&name| name == value)
                && !choices.contains(&name)
            {
                choices.push(name);
            }
        }
        let mut option_list = option("original", "Исходный формат", selected);
        for name in choices {
            option_list.push_str(&option(name, &name.to_uppercase(), selected));
        }
        format!(
            r#"<form class="shelf-options" method="post" action="{}">{}{}<label for="format">Формат скачивания</label><select id="format" name="format">{option_list}</select><p class="hint">Применяется ко всем скачиваниям в вашем профиле.</p><button>Сохранить формат</button></form>"#,
            escape(&self.site.url("/format", &Params::new())),
            hidden("csrf", &self.access.csrf),
            hidden("next", next)
        )
    }

    pub(super) fn recent(&self) -> Result<(String, String)> {
        let title = "Сейчас читаю";
        if self.owner().is_none() {
            return Ok((
                title.into(),
                format!(
                    "<p>Войдите в профиль, чтобы увидеть книги из истории.</p>{}",
                    self.site.link("/login", &Params::new(), "Войти", "")
                ),
            ));
        }
        let books = self.catalogue(|catalogue| {
            Ok(self
                .state
                .access
                .with_personal_profile(self.profile_request(), |reader, owner, stamp| {
                    reader.ebook_recent(owner, stamp, catalogue)
                })?)
        })?;
        let mut content = String::new();
        for book in list(&books) {
            content.push_str(&self.row(book, &Params::new()));
            let percent = book["percent"].as_f64().unwrap_or_default() * 100.0;
            let _ = write!(content, r#"<p class="meta">Прочитано {:.0}%</p>"#, percent);
            if book["unavailable"] != true && self.readable(text(book, "ext")) {
                content.push_str(&self.site.link(
                    "/read",
                    &with(&Params::new(), &[("uid", text(book, "_uid"))]),
                    "Продолжить чтение",
                    "button",
                ));
            }
        }
        if content.is_empty() {
            content.push_str("<p>В истории пока нет книг в процессе чтения.</p>");
        }
        Ok((title.into(), content))
    }

    pub(super) fn shelves(&self) -> Result<(String, String)> {
        let rows = self
            .state
            .access
            .with_personal_profile(self.profile_request(), |reader, owner, stamp| {
                reader.ebook_shelves(owner, stamp)
            })?;
        let page = number(&self.query, "page", 1, 100000)?.unwrap_or(1);
        let size = 20;
        let rows = list(&rows);
        let mut content =
            r#"<p class="intro">Ваши списки чтения. Откройте полку, чтобы скачать книги.</p>"#
                .to_string();
        if rows.is_empty() {
            content.push_str("<p>Полок пока нет. Создайте список в полной версии библиотеки.</p>");
        } else {
            for row in rows.iter().skip((page - 1) * size).take(size) {
                let link = self.site.link(
                    "/shelf",
                    &with(&Params::new(), &[("id", text(row, "id"))]),
                    text(row, "name"),
                    "",
                );
                let hint = if row["smart"] == true {
                    "Умная полка".into()
                } else {
                    format!("{} книг", row["bookCount"])
                };
                let _ = write!(
                    content,
                    r#"<article class="result"><h3>{link}</h3><p class="meta">{hint}</p></article>"#
                );
            }
            content.push_str(&self.navigation(
                "/shelves",
                &Params::new(),
                page,
                rows.len().div_ceil(size),
            ));
        }
        Ok(("Мои полки".into(), content))
    }

    pub(super) fn shelf(&self) -> Result<(String, String)> {
        let id = scalar(&self.query, "id", 128)?;
        if id.is_empty() {
            return Err(Failure::invalid());
        }
        let cursor = number(&self.query, "cursor", 0, 10_000_000)?.unwrap_or(0);
        let size = number(&self.query, "size", 1, 20)?.unwrap_or(10);
        let trail = scalar(&self.query, "trail", 200)?;
        let prior: Vec<_> = if trail.is_empty() {
            Vec::new()
        } else {
            trail
                .split(',')
                .map(|value| value.parse::<usize>().map_err(|_| Failure::invalid()))
                .collect::<Result<_>>()?
        };
        if prior.len() > 20
            || prior.last().is_some_and(|value| *value >= cursor)
            || prior.windows(2).any(|pair| pair[0] >= pair[1])
        {
            return Err(Failure::invalid());
        }
        let read = || {
            self.catalogue(|catalogue| {
                Ok(self.state.access.with_personal_profile(
                    self.profile_request(),
                    |reader, owner, stamp| {
                        reader.ebook_shelf(owner, stamp, id, cursor, size, catalogue)
                    },
                )?)
            })
        };
        let shelf = match read() {
            Err(error) if error.status == StatusCode::SERVICE_UNAVAILABLE => {
                self.state.exchange.prepare_rating_filter(self.state)?;
                read()?
            }
            result => result?,
        };
        let args = with(
            &Params::new(),
            &[
                ("id", id),
                ("cursor", &cursor.to_string()),
                ("size", &size.to_string()),
                ("trail", trail),
            ],
        );
        let back = self.site.url("/shelf", &args);
        let mut content = self.site.link("/shelves", &Params::new(), "Все полки", "");
        if shelf["unreadOnly"] == true {
            content.push_str(r#"<p class="hint">Только непрочитанные книги.</p>"#);
        }
        content.push_str(&self.format_form(&back, ""));
        let scope = with(&Params::new(), &[("back", &back)]);
        let books = list(&shelf["books"]);
        if books.is_empty() {
            content.push_str("<p>В этой части полки пока нет доступных книг.</p>");
        }
        for book in books {
            content.push_str(&self.row(book, &scope));
        }
        content.push_str(r#"<nav class="pagination" aria-label="Страницы">"#);
        if cursor > 0 {
            let mut previous = prior.clone();
            let offset = previous.pop().unwrap_or(0).to_string();
            content.push_str(&self.site.link(
                "/shelf",
                &with(
                    &args,
                    &[("cursor", &offset), ("trail", &trail_text(previous))],
                ),
                "Предыдущая",
                "",
            ));
        }
        if let Some(next) = shelf["next"].as_u64() {
            let trail = trail_text(
                prior
                    .into_iter()
                    .chain([cursor])
                    .rev()
                    .take(20)
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev(),
            );
            content.push_str(&self.site.link(
                "/shelf",
                &with(&args, &[("cursor", &next.to_string()), ("trail", &trail)]),
                "Следующая",
                "",
            ));
        }
        content.push_str("</nav>");
        Ok((text(&shelf, "name").into(), content))
    }

    fn navigation(&self, path: &str, scope: &Params, page: usize, total: usize) -> String {
        let previous = if page > 1 {
            self.site.link(
                path,
                &with(scope, &[("page", &(page - 1).to_string())]),
                "Предыдущая",
                "",
            )
        } else {
            String::new()
        };
        let next = if page < total {
            self.site.link(
                path,
                &with(scope, &[("page", &(page + 1).to_string())]),
                "Следующая",
                "",
            )
        } else {
            String::new()
        };
        format!(
            r#"<nav class="pagination" aria-label="Страницы">{previous} Страница {page} из {total} {next}</nav>"#
        )
    }
}

pub(super) fn saved(state: &Value) -> bool {
    let progress = &state["progress"];
    !text(progress, "updatedAt").is_empty() && text(progress, "relinkedTo").is_empty()
}

pub(super) fn reader_args(scope: &Params, uid: &str) -> Params {
    let page = default(get(scope, "page"), "1");
    let mut args = with(scope, &[("uid", uid), ("bookPage", page)]);
    args.remove("page");
    args
}

pub(super) fn default<'a>(value: &'a str, fallback: &'a str) -> &'a str {
    if value.is_empty() { fallback } else { value }
}

fn short(value: &str, maximum: usize) -> String {
    value.chars().take(maximum).collect()
}

fn list(value: &Value) -> &[Value] {
    value.as_array().map_or(&[], Vec::as_slice)
}

fn options(items: &[(&str, &str)], selected: &str) -> String {
    items
        .iter()
        .map(|(key, label)| option(key, label, selected))
        .collect()
}

fn term(value: &str, mode: &str) -> String {
    if mode == "exact" {
        format!("={value}")
    } else if mode == "contains" || value.starts_with(['~', '?', '#', '*', '=']) {
        format!("*{value}")
    } else {
        value.into()
    }
}

fn book_meta(book: &Value) -> String {
    let size = book["size"].as_u64().unwrap_or_default();
    let read = if book["_shelfRead"] == true {
        "Прочитана"
    } else {
        ""
    };
    let size = if size > 0 {
        format!("{} КБ", size.div_ceil(1024))
    } else {
        String::new()
    };
    [
        size.as_str(),
        text(book, "lang"),
        text(book, "sourceName"),
        read,
    ]
    .into_iter()
    .filter(|value| !value.is_empty())
    .collect::<Vec<_>>()
    .join(" · ")
}

fn safe_extension(ext: &str) -> bool {
    let mut parts = ext.split('.');
    let valid = |part: &str| {
        (1..=12).contains(&part.len())
            && part
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
    };
    parts.next().is_some_and(valid) && parts.next().is_none_or(valid) && parts.next().is_none()
}

fn unsupported(format: &str) -> Failure {
    Failure::new(
        StatusCode::UNSUPPORTED_MEDIA_TYPE,
        format!(
            "Скачивание {} для этой книги недоступно.",
            format.to_uppercase()
        ),
    )
}

fn trail_text(trail: impl IntoIterator<Item = usize>) -> String {
    trail
        .into_iter()
        .map(|offset| offset.to_string())
        .collect::<Vec<_>>()
        .join(",")
}
