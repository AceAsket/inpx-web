use std::collections::HashSet;
use std::ffi::OsString;
use std::fs::{self, File};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::book_archive::Failure;
use crate::book_delivery::{Book, Cached, Representation};
use crate::{Result, atomic_file, book_cache, book_names, crypto_support, file_stamp};

#[path = "book_conversion_validation.rs"]
mod validation;

const MAX_CONFIG: u64 = 1024 * 1024;
const MAX_OUTPUT: u64 = 500 * 1024 * 1024;

#[derive(Clone, Copy, Eq, PartialEq)]
pub enum Format {
    Epub,
    Epub3,
    Kepub,
    Kfx,
    Azw3,
    Azw8,
    Mobi,
    Pdf,
}

impl Format {
    pub fn name(self) -> &'static str {
        match self {
            Self::Epub => "epub",
            Self::Epub3 => "epub3",
            Self::Kepub => "kepub",
            Self::Kfx => "kfx",
            Self::Azw3 => "azw3",
            Self::Azw8 => "azw8",
            Self::Mobi => "mobi",
            Self::Pdf => "pdf",
        }
    }

    pub fn extension(self) -> &'static str {
        match self {
            Self::Epub3 => "epub",
            Self::Kepub => "kepub.epub",
            _ => self.name(),
        }
    }
}

const FORMATS: [Format; 8] = [
    Format::Epub,
    Format::Epub3,
    Format::Kepub,
    Format::Kfx,
    Format::Azw3,
    Format::Azw8,
    Format::Mobi,
    Format::Pdf,
];

#[derive(Debug)]
pub enum Error {
    Busy,
    TimedOut,
}

impl std::fmt::Display for Error {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.write_str(match self {
            Self::Busy => "Очередь конвертации занята",
            Self::TimedOut => "Превышено время конвертации книги",
        })
    }
}

impl std::error::Error for Error {}

pub struct Conversion {
    formats: Vec<Format>,
    fbc: Option<Fb2cng>,
    kindling: Option<Tool>,
    pdf: Option<Pdf>,
    timeout: Duration,
    queue: Queue,
}

struct Fb2cng {
    tool: Tool,
    arguments: Vec<String>,
    yaml: Option<PathBuf>,
    title: String,
    yaml_lock: Mutex<()>,
}

pub(crate) struct Tool(PathBuf);

enum Pdf {
    MuPdf(Tool),
    Calibre(Tool),
}

impl Conversion {
    pub fn new(config: &Value, exec_dir: &Path) -> Result<Option<Self>> {
        let enabled = std::env::var("INPX_ENABLE_CONVERSION")
            .map_or(config["conversionEnabled"] != false, |value| {
                value != "false"
            });
        if !enabled {
            return Ok(None);
        }
        let paths = &config["converterPaths"];
        let fbc = Tool::find(exec_dir, "fbc", &configured(paths, &["fb2cng", "fbc"]))
            .map(|tool| Fb2cng::new(config, tool))
            .transpose()?;
        let mobi_enabled = std::env::var("INPX_MOBI_ENABLED")
            .map_or(config["mobiEnabled"] != false, |value| value != "false");
        let kindling = mobi_enabled
            .then(|| {
                let path = std::env::var("INPX_KINDLING_PATH")
                    .ok()
                    .or_else(|| config["kindlingPath"].as_str().map(str::to_owned))
                    .filter(|value| !value.trim().is_empty());
                Tool::find(exec_dir, "kindling", &path.into_iter().collect::<Vec<_>>())
            })
            .flatten();
        let mutool = configured(paths, &["mutool", "mupdf"]);
        let calibre = configured(paths, &["calibre", "ebookConvert", "ebook-convert"]);
        let pdf = if mutool.is_empty() && !calibre.is_empty() {
            Tool::find(exec_dir, "ebook-convert", &calibre).map(Pdf::Calibre)
        } else {
            Tool::find(exec_dir, "mutool", &mutool)
                .map(Pdf::MuPdf)
                .or_else(|| {
                    mutool
                        .is_empty()
                        .then(|| Tool::find(exec_dir, "ebook-convert", &calibre).map(Pdf::Calibre))
                        .flatten()
                })
        };
        let requested = std::env::var("INPX_CONVERSION_FORMATS").ok();
        let formats: Vec<_> = FORMATS
            .into_iter()
            .filter(|format| {
                let enabled = requested.as_deref().map_or_else(
                    || {
                        config["conversionFormats"]
                            .as_array()
                            .is_none_or(|formats| {
                                formats.iter().any(|value| {
                                    value.as_str().is_some_and(|value| {
                                        value.trim().eq_ignore_ascii_case(format.name())
                                    })
                                })
                            })
                    },
                    |list| {
                        list.split(',')
                            .any(|value| value.trim().eq_ignore_ascii_case(format.name()))
                    },
                );
                enabled
                    && match format {
                        Format::Mobi => kindling.is_some() && fbc.is_some(),
                        Format::Pdf => pdf.is_some(),
                        _ => fbc.is_some(),
                    }
            })
            .collect();
        if formats.is_empty() {
            return Ok(None);
        }
        Ok(Some(Self {
            formats,
            fbc,
            kindling,
            pdf,
            timeout: milliseconds(
                config,
                &[
                    "INPX_RESOURCE_TASK_TIMEOUT_MS",
                    "INPX_CONVERSION_TIMEOUT_MS",
                ],
                "conversionTimeoutMs",
                120_000,
            ),
            queue: Queue::new(config),
        }))
    }

    pub fn formats(&self) -> impl Iterator<Item = &'static str> + '_ {
        self.formats.iter().map(|format| format.name())
    }

    pub fn format(&self, name: &str) -> Option<Format> {
        self.formats
            .iter()
            .copied()
            .find(|format| format.name() == name)
    }

    pub fn supports(&self, format: Format, source: &str) -> bool {
        self.formats.contains(&format)
            && (source.eq_ignore_ascii_case("fb2") || source.eq_ignore_ascii_case("epub"))
    }

    pub fn convert(
        &self,
        cache: &Path,
        book: &Book,
        cached: &Cached,
        format: Format,
    ) -> Result<PathBuf> {
        let source = book
            .extension()
            .ok_or(Failure::InvalidType)?
            .to_ascii_lowercase();
        if !self.supports(format, &source) {
            return Err(Failure::Unsupported.into());
        }
        let external = matches!(format, Format::Mobi | Format::Pdf);
        let fbc = (!external || format == Format::Mobi && source == "fb2")
            .then(|| self.fbc.as_ref().ok_or(Failure::Unsupported))
            .transpose()?;
        let settings = fbc
            .and_then(|fbc| fbc.yaml.as_deref())
            .map(bounded_config)
            .transpose()?;
        let title = fbc
            .map(|fbc| fbc.title(book, format))
            .transpose()?
            .flatten();
        let mut signature = vec![json!(cached.hash), json!(source), json!(format.name())];
        if let Some(fbc) = fbc {
            signature.extend(fbc.signature(settings.as_deref())?);
            if let Some(title) = &title {
                signature.push(json!(title));
            }
        }
        match format {
            Format::Mobi => signature.push(
                self.kindling
                    .as_ref()
                    .ok_or(Failure::Unsupported)?
                    .signature("dual-v1")?,
            ),
            Format::Pdf => {
                signature.push(self.pdf.as_ref().ok_or(Failure::Unsupported)?.signature()?)
            }
            _ => (),
        }
        let key = Sha256::digest(serde_json::to_vec(&signature)?);
        let tag = if external { "convert-v1" } else { "fbc-v1" };
        let target = cache.join(format!(
            "{}.{tag}-{}-{}.{}",
            cached.hash,
            format.name(),
            crypto_support::hex(&key[..12]),
            format.extension()
        ));
        if usable(&target)? {
            return Ok(target);
        }
        let ticket = self.queue.enter(&target)?;
        if usable(&target)? {
            drop(ticket);
            return Ok(target);
        }
        let deadline = Instant::now() + self.timeout;
        let directory = workspace(cache)?;
        let dir = directory.path();
        let result = match format {
            Format::Mobi => {
                let input = if let Some(fbc) = fbc {
                    let source = fb2_input(cache, cached, &source, dir)?;
                    fbc.render(
                        &source,
                        dir,
                        Format::Epub,
                        settings.as_deref(),
                        title.as_deref(),
                        deadline,
                    )?
                } else {
                    raw_input(cache, cached, dir, "epub")?
                };
                validation::epub(&input, deadline)?;
                let output = dir.join("output.mobi");
                let mut command = self
                    .kindling
                    .as_ref()
                    .ok_or(Failure::Unsupported)?
                    .command(dir);
                command
                    .arg("build")
                    .arg(&input)
                    .args(["--legacy-mobi", "--no-embed-source", "--no-validate", "-o"])
                    .arg(&output);
                run(command, deadline)?;
                sized_output(&output)?;
                validation::mobi(&output)?;
                output
            }
            Format::Pdf => {
                let input = raw_input(cache, cached, dir, &source)?;
                if source == "epub" {
                    validation::epub(&input, deadline)?;
                }
                let output = dir.join("output.pdf");
                self.pdf
                    .as_ref()
                    .ok_or(Failure::Unsupported)?
                    .render(&input, &output, &source, dir, deadline)?;
                sized_output(&output)?;
                validation::pdf(&output)?;
                output
            }
            _ => {
                let input = fb2_input(cache, cached, &source, dir)?;
                fbc.ok_or(Failure::Unsupported)?.render(
                    &input,
                    dir,
                    format,
                    settings.as_deref(),
                    title.as_deref(),
                    deadline,
                )?
            }
        };
        remaining(deadline)?;
        publish(cache, &target, &result)?;
        drop(ticket);
        Ok(target)
    }
}

impl Fb2cng {
    fn new(config: &Value, tool: Tool) -> Result<Self> {
        let arguments = std::env::var("INPX_FB2CNG_ARGS")
            .ok()
            .map(|value| {
                if value.trim().is_empty() {
                    Ok(json!([]))
                } else {
                    serde_json::from_str(&value)
                }
            })
            .transpose()?
            .unwrap_or_else(|| {
                config
                    .get("fb2cngArgs")
                    .cloned()
                    .unwrap_or_else(|| json!([]))
            });
        let arguments: Vec<String> = serde_json::from_value(arguments)
            .map_err(|_| "fb2cngArgs должен быть массивом строк")?;
        for arg in &arguments {
            let flag = arg.split('=').next().unwrap_or_default();
            if arg.trim().is_empty()
                || arg.contains('\0')
                || matches!(
                    flag,
                    "--config" | "-c" | "--to" | "--output-file" | "-o" | "--overwrite" | "--"
                )
                || arg.starts_with("-c")
                || arg.starts_with("-o")
            {
                return Err(
                    "fb2cngArgs не должен переопределять формат, конфиг или пути вывода".into(),
                );
            }
        }
        let yaml = std::env::var_os("INPX_FB2CNG_CONFIG")
            .or_else(|| std::env::var_os("FB2CNG_CONFIG"))
            .or_else(|| config["fb2cngConfigPath"].as_str().map(Into::into))
            .filter(|value| !value.is_empty())
            .map(|value| std::path::absolute(PathBuf::from(value)))
            .transpose()?;
        let title = std::env::var("INPX_BOOK_TITLE_TEMPLATE").unwrap_or_else(|_| {
            config["bookTitleTemplate"]
                .as_str()
                .unwrap_or_default()
                .into()
        });
        Ok(Self {
            tool,
            arguments,
            yaml,
            title,
            yaml_lock: Mutex::new(()),
        })
    }

    fn title(&self, book: &Book, format: Format) -> Result<Option<String>> {
        if self.title.trim().is_empty() {
            return Ok(None);
        }
        let rendered = book_names::render(book, &self.title, format.extension())?;
        let title = if rendered.is_empty() {
            book.title.trim().to_owned()
        } else {
            rendered
        };
        Ok((!title.is_empty()).then_some(title))
    }

    fn signature(&self, settings: Option<&[u8]>) -> Result<[Value; 5]> {
        let stamp = file_stamp::path_stamp(&self.tool.0)?.to_string();
        let hash = settings.map(|bytes| crypto_support::hex(&Sha256::digest(bytes)));
        Ok([
            json!(self.tool.0),
            json!(stamp),
            json!(self.arguments),
            json!(self.yaml),
            json!(hash),
        ])
    }

    fn render(
        &self,
        input: &Path,
        directory: &Path,
        format: Format,
        settings: Option<&[u8]>,
        title: Option<&str>,
        deadline: Instant,
    ) -> Result<PathBuf> {
        // fb2cng writes its logs in the original YAML directory when relative assets are configured.
        let _yaml = settings
            .map(|_| {
                self.yaml_lock
                    .lock()
                    .map_err(|_| "Конвертер книг недоступен")
            })
            .transpose()?;
        let cwd = self
            .yaml
            .as_deref()
            .and_then(Path::parent)
            .unwrap_or(directory);
        let settings = self.effective_yaml(directory, cwd, settings, title, deadline)?;
        let mut command = self.tool.command(cwd);
        if let Some(path) = settings {
            command.arg("--config").arg(path);
        }
        let output = directory.join("fb2cng");
        fs::create_dir(&output)?;
        let argument = if format == Format::Epub {
            "epub2"
        } else {
            format.name()
        };
        command.args(["convert", "--to", argument, "--overwrite"]);
        let mut arguments = self.arguments.iter();
        while let Some(arg) = arguments.next() {
            if arg.split('=').next() != Some("--kfx-compression") {
                command.arg(arg);
            } else if matches!(format, Format::Kfx | Format::Azw8) {
                command.arg(arg.replacen("--kfx-compression", "--compression", 1));
            } else if arg == "--kfx-compression" {
                arguments.next();
            }
        }
        command.arg(input).arg(&output);
        run(command, deadline)?;
        let suffix = format!(".{}", format.extension());
        let mut found = None;
        for item in fs::read_dir(output)? {
            let item = item?;
            if item.file_type()?.is_file()
                && item
                    .file_name()
                    .to_string_lossy()
                    .to_ascii_lowercase()
                    .ends_with(&suffix)
                && found.replace(item.path()).is_some()
            {
                return Err("fb2cng создал несколько выходных файлов".into());
            }
        }
        found.ok_or_else(|| format!("fb2cng не создал файл формата {}", format.name()).into())
    }

    fn effective_yaml(
        &self,
        directory: &Path,
        cwd: &Path,
        settings: Option<&[u8]>,
        title: Option<&str>,
        deadline: Instant,
    ) -> Result<Option<PathBuf>> {
        let snapshot = directory.join("settings.yaml");
        if let Some(settings) = settings {
            fs::write(&snapshot, settings)?;
        }
        let Some(title) = title else {
            return Ok(settings.map(|_| snapshot));
        };
        let literal = format!("{{{{ {} }}}}", serde_json::to_string(title)?);
        let effective = directory.join("config.yaml");
        if settings.is_some() {
            let normalized = directory.join("normalized.yaml");
            let mut command = self.tool.command(cwd);
            command
                .arg("--config")
                .arg(snapshot)
                .arg("dumpconfig")
                .arg(&normalized);
            run(command, deadline)?;
            let text = String::from_utf8(bounded_config(&normalized)?)?;
            fs::write(&effective, replace_title(&text, &literal)?)?;
        } else {
            // JSON is also valid YAML and safely quotes arbitrary catalogue titles.
            fs::write(
                &effective,
                serde_json::to_vec(
                    &json!({"document":{"metainformation":{"title_template":literal}}}),
                )?,
            )?;
        }
        Ok(Some(effective))
    }
}

fn replace_title(normalized: &str, literal: &str) -> Result<String> {
    // Edit the canonical dump emitted by fb2cng, where these three keys are
    // real mappings and indentation also delimits the old block scalar.
    let lines: Vec<_> = normalized.lines().collect();
    let indent = |line: &str| line.len() - line.trim_start().len();
    let find = |start: usize, end: usize, key: &str| {
        let children = &lines[start..end];
        let level = children
            .iter()
            .filter(|line| !line.trim().is_empty())
            .map(|line| indent(line))
            .min()?;
        children
            .iter()
            .position(|line| indent(line) == level && line.trim_start().starts_with(key))
            .map(|index| index + start)
    };
    let end = |index: usize| {
        lines
            .iter()
            .enumerate()
            .skip(index + 1)
            .find(|(_, line)| !line.trim().is_empty() && indent(line) <= indent(lines[index]))
            .map_or(lines.len(), |(index, _)| index)
    };
    let missing = "В выводе fb2cng отсутствует шаблон заголовка книги";
    let document = find(0, lines.len(), "document:").ok_or(missing)?;
    let metadata = find(document + 1, end(document), "metainformation:").ok_or(missing)?;
    let title = find(metadata + 1, end(metadata), "title_template:").ok_or(missing)?;
    let mut result = lines[..title].join("\n");
    result.push_str(&format!(
        "\n{}title_template: {}\n",
        " ".repeat(indent(lines[title])),
        serde_json::to_string(literal)?
    ));
    result.push_str(&lines[end(title)..].join("\n"));
    result.push('\n');
    Ok(result)
}

impl Pdf {
    fn signature(&self) -> Result<Value> {
        match self {
            Self::MuPdf(tool) => tool.signature("mupdf"),
            Self::Calibre(tool) => tool.signature("calibre"),
        }
    }

    fn render(
        &self,
        input: &Path,
        output: &Path,
        source: &str,
        directory: &Path,
        deadline: Instant,
    ) -> Result<()> {
        match self {
            Self::MuPdf(tool) => {
                let mut command = tool.command(directory);
                command.args(["convert", "-o"]).arg(output).arg(input);
                run(command, deadline)
            }
            Self::Calibre(tool) => {
                let runtime = directory.join("qt");
                fs::create_dir(&runtime)?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    fs::set_permissions(&runtime, fs::Permissions::from_mode(0o700))?;
                }
                let convert = |input: &Path, output: &Path| -> Result<()> {
                    let mut command = tool.command(directory);
                    command.env("XDG_RUNTIME_DIR",&runtime).env("QTWEBENGINE_DISABLE_SANDBOX","1")
                        .env("QTWEBENGINE_CHROMIUM_FLAGS","--no-sandbox --disable-setuid-sandbox --disable-gpu --disable-dev-shm-usage")
                        .env("QT_QPA_PLATFORM",std::env::var_os("QT_QPA_PLATFORM").unwrap_or_else(||"offscreen".into()))
                        .arg(input).arg(output);
                    run(command, deadline)
                };
                if source == "fb2" {
                    let intermediate = directory.join("intermediate.epub");
                    convert(input, &intermediate)?;
                    sized_output(&intermediate)?;
                    validation::epub(&intermediate, deadline)?;
                    convert(&intermediate, output)
                } else {
                    convert(input, output)
                }
            }
        }
    }
}

impl Tool {
    pub(crate) fn find(exec: &Path, name: &str, configured: &[String]) -> Option<Self> {
        let extension = if cfg!(windows) { ".exe" } else { "" };
        let find = |candidate: PathBuf| {
            if candidate.is_file() {
                std::path::absolute(candidate).ok()
            } else {
                None
            }
        };
        let search = |name: &str| {
            let path = Path::new(name);
            if path.is_absolute() || name.contains(['/', '\\']) {
                return find(path.to_owned());
            }
            let names = [
                OsString::from(name),
                OsString::from(format!("{name}{extension}")),
            ];
            std::env::var_os("PATH").into_iter().find_map(|path| {
                std::env::split_paths(&path)
                    .find_map(|dir| names.iter().find_map(|name| find(dir.join(name))))
            })
        };
        if !configured.is_empty() {
            return configured.iter().find_map(|path| search(path)).map(Self);
        }
        let executable = format!("{name}{extension}");
        [exec.join("bin").join(&executable), exec.join(executable)]
            .into_iter()
            .find_map(find)
            .or_else(|| search(name))
            .map(Self)
    }

    pub(crate) fn command(&self, directory: &Path) -> Command {
        let mut command = Command::new(&self.0);
        command.current_dir(directory);
        command
    }

    fn signature(&self, format: &str) -> Result<Value> {
        Ok(json!([
            format,
            self.0,
            file_stamp::path_stamp(&self.0)?.to_string()
        ]))
    }
}

pub(crate) fn configured(paths: &Value, aliases: &[&str]) -> Vec<String> {
    aliases
        .iter()
        .flat_map(|name| {
            let value = &paths[*name];
            value
                .as_array()
                .map_or_else(|| std::slice::from_ref(value), Vec::as_slice)
        })
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(str::to_owned)
        .collect()
}

fn limit(config: &Value, variables: &[&str], key: &str, default: u64) -> u64 {
    variables
        .iter()
        .find_map(|variable| std::env::var(variable).ok()?.trim().parse().ok())
        .or_else(|| config[key].as_u64())
        .unwrap_or(default)
}

fn milliseconds(config: &Value, variables: &[&str], key: &str, default: u64) -> Duration {
    Duration::from_millis(limit(config, variables, key, default).clamp(1_000, 3_600_000))
}

struct Queue {
    active: Mutex<(HashSet<PathBuf>, usize)>,
    changed: Condvar,
    limit: usize,
    max_waiting: usize,
    timeout: Duration,
}

struct Ticket<'a> {
    queue: &'a Queue,
    path: &'a Path,
}

impl Queue {
    fn new(config: &Value) -> Self {
        let concurrency = limit(
            config,
            &["INPX_RESOURCE_CONVERSIONS", "INPX_CONVERSION_CONCURRENCY"],
            "conversionConcurrency",
            2,
        )
        .clamp(1, 16) as usize;
        let max_waiting = limit(
            config,
            &["INPX_CONVERSION_QUEUE_LIMIT"],
            "conversionQueueLimit",
            16,
        )
        .min(256) as usize;
        Self {
            active: Mutex::default(),
            changed: Condvar::new(),
            limit: concurrency,
            max_waiting,
            timeout: milliseconds(
                config,
                &["INPX_CONVERSION_QUEUE_TIMEOUT_MS"],
                "conversionQueueTimeoutMs",
                120_000,
            ),
        }
    }

    fn enter<'a>(&'a self, path: &'a Path) -> Result<Ticket<'a>> {
        let mut state = self
            .active
            .lock()
            .map_err(|_| "Конвертер книг недоступен")?;
        let busy = |active: &HashSet<PathBuf>| active.len() >= self.limit || active.contains(path);
        if busy(&state.0) {
            if state.1 >= self.max_waiting {
                return Err(Error::Busy.into());
            }
            state.1 += 1;
            let (mut waiting, _) = self
                .changed
                .wait_timeout_while(state, self.timeout, |state| busy(&state.0))
                .map_err(|_| "Конвертер книг недоступен")?;
            waiting.1 -= 1;
            if busy(&waiting.0) {
                return Err(Error::Busy.into());
            }
            state = waiting;
        }
        state.0.insert(path.to_owned());
        Ok(Ticket { queue: self, path })
    }
}

impl Drop for Ticket<'_> {
    fn drop(&mut self) {
        self.queue
            .active
            .lock()
            .expect("conversion queue")
            .0
            .remove(self.path);
        self.queue.changed.notify_all();
    }
}

fn workspace(cache: &Path) -> Result<tempfile::TempDir> {
    let mut builder = tempfile::Builder::new();
    builder.prefix(".conversion-");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        builder.permissions(fs::Permissions::from_mode(0o700));
    }
    Ok(builder.tempdir_in(cache)?)
}

fn raw_input(cache: &Path, book: &Cached, dir: &Path, source: &str) -> Result<PathBuf> {
    let input = dir.join(format!("source.{source}"));
    fs::copy(book.file(cache, "", Representation::Raw)?, &input)?;
    Ok(input)
}

fn fb2_input(cache: &Path, book: &Cached, source: &str, dir: &Path) -> Result<PathBuf> {
    let input = dir.join("source.fb2");
    fs::copy(book.reader_file(cache, source)?, &input)?;
    Ok(input)
}

fn usable(path: &Path) -> Result<bool> {
    let Some(file) = book_cache::regular_file(path, true)? else {
        return Ok(false);
    };
    if file.metadata()?.len() == 0 {
        return Err("Пустой файл в кэше конвертации".into());
    }
    file.set_modified(std::time::SystemTime::now())?;
    Ok(true)
}

fn bounded_config(path: &Path) -> Result<Vec<u8>> {
    let mut content = Vec::new();
    File::open(path)?
        .take(MAX_CONFIG + 1)
        .read_to_end(&mut content)?;
    if content.len() as u64 > MAX_CONFIG {
        return Err("Конфигурация fb2cng превышает допустимый размер".into());
    }
    Ok(content)
}

fn sized_output(path: &Path) -> Result<File> {
    let file = book_cache::regular_file(path, false)?.ok_or("Файл конвертации недоступен")?;
    match file.metadata()?.len() {
        0 => Err("Конвертер создал пустой файл".into()),
        size if size > MAX_OUTPUT => Err(Failure::Limit.into()),
        _ => Ok(file),
    }
}

fn publish(cache: &Path, target: &Path, result: &Path) -> Result<()> {
    let file = sized_output(result)?;
    let mut staged = tempfile::NamedTempFile::new_in(cache)?;
    if io::copy(&mut file.take(MAX_OUTPUT + 1), staged.as_file_mut())? > MAX_OUTPUT {
        return Err(Failure::Limit.into());
    }
    if atomic_file::publish(staged, target, None)?.is_none() && !usable(target)? {
        return Err("Файл конвертации не опубликован".into());
    }
    Ok(())
}

fn remaining(deadline: Instant) -> Result<()> {
    if Instant::now() >= deadline {
        return Err(Error::TimedOut.into());
    }
    Ok(())
}

pub(crate) fn run(mut command: Command, deadline: Instant) -> Result<()> {
    remaining(deadline)?;
    let program = Path::new(command.get_program())
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(()),
            Ok(Some(status)) => {
                return Err(format!("{program} завершился с ошибкой ({status})").into());
            }
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(25)),
            state => {
                #[cfg(unix)]
                // The converter started in its own group. Stop subprocesses before removing its files.
                unsafe {
                    libc::kill(-(child.id() as i32), libc::SIGKILL);
                }
                let _ = child.kill();
                let _ = child.wait();
                state?;
                return Err(Error::TimedOut.into());
            }
        }
    }
}
