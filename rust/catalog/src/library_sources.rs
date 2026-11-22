use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::Result;
use crate::crypto_support::hex;
use crate::directory_diagnostics::ordered_entries;
use crate::fb2_prepare::js_space;
use crate::startup_paths::absolute;

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Options {
    configured: Vec<Value>,
    argument: String,
    environment: String,
    lib_dir: String,
    inpx: String,
    exec_dir: String,
    remote: Option<Remote>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Remote {
    inpx: PathBuf,
    lib_dir: PathBuf,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub kind: Option<Kind>,
    pub id: String,
    pub name: String,
    pub inpx: PathBuf,
    pub inpx_file: PathBuf,
    pub lib_dir: PathBuf,
    pub enabled: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub remote: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    Folder,
    Inpx,
}

pub fn resolve(options: Options) -> Result<Vec<Source>> {
    // RC15 parses an explicit CLI argument before choosing the remote library.
    let configured = if options.argument.is_empty() {
        options.configured
    } else {
        parse_sources(&options.argument)?
    };
    if let Some(remote) = options.remote {
        return Ok(vec![Source {
            kind: None,
            id: "remote".into(),
            name: "Remote library".into(),
            inpx_file: remote.inpx.clone(),
            inpx: remote.inpx,
            lib_dir: remote.lib_dir,
            enabled: true,
            remote: true,
        }]);
    }
    let environment = parse_sources(&options.environment)?;
    let mut rows = if environment.is_empty() {
        configured
    } else {
        environment
    };
    if rows.is_empty() {
        let directory = nonempty(&options.lib_dir).unwrap_or(&options.exec_dir);
        if !Path::new(directory).exists() {
            return Err(format!("Directory \"{directory}\" not exists").into());
        }
        let directory = absolute(Path::new(directory))?;
        let inpx = if options.inpx.is_empty() {
            find_inpx(&directory)?
        } else {
            PathBuf::from(&options.inpx)
        };
        rows.push(json!({"id":"main","name":"Main library","inpx":inpx,"libDir":directory}));
    }
    let result: Vec<_> = rows
        .into_iter()
        .enumerate()
        .filter(|(_, row)| row.get("enabled") != Some(&Value::Bool(false)))
        .map(|(index, row)| normalize(&row, index + 1))
        .collect::<Result<_>>()?;
    if result.is_empty() {
        return Err("No enabled INPX library sources configured".into());
    }
    Ok(result)
}

fn parse_sources(text: &str) -> Result<Vec<Value>> {
    let text = text.trim_matches(js_space);
    if text.starts_with(['[', '{']) {
        return Ok(match serde_json::from_str::<Value>(text)? {
            Value::Array(rows) => rows,
            source => vec![source],
        });
    }
    Ok(text
        .split(';')
        .map(|item| item.trim_matches(js_space))
        .filter(|item| !item.is_empty())
        .enumerate()
        .map(|(index, item)| {
            let mut fields = item.split('|').map(|field| field.trim_matches(js_space));
            let first = fields.next().unwrap_or_default();
            let second = fields.next().unwrap_or_default();
            match (fields.next(), fields.next()) {
                (Some(third), Some(fourth)) => {
                    json!({"id":first,"name":second,"inpx":third,"libDir":fourth})
                }
                (Some(third), None) => json!({"name":first,"inpx":second,"libDir":third}),
                _ => json!({"id":format!("source-{}", index + 1),"inpx":first,"libDir":second}),
            }
        })
        .collect())
}

pub fn has_environment_sources(value: &str) -> bool {
    parse_sources(value).is_ok_and(|sources| !sources.is_empty())
}

fn normalize(row: &Value, index: usize) -> Result<Source> {
    if row.is_null() {
        return Err("Cannot read properties of null (reading 'inpx')".into());
    }
    let field = |key| row.get(key).and_then(setting);
    let inpx = field("inpx")
        .or_else(|| field("inpxFile"))
        .unwrap_or_default();
    let inpx = nonempty(inpx.trim_matches(js_space))
        .map(|value| absolute(Path::new(value)))
        .transpose()?;
    let lib_dir = field("libDir")
        .or_else(|| field("libraryDir"))
        .unwrap_or_default();
    let directory = nonempty(lib_dir.trim_matches(js_space))
        .map(|value| absolute(Path::new(value)))
        .transpose()?
        .or_else(|| {
            inpx.as_deref()
                .and_then(Path::parent)
                .map(Path::to_path_buf)
        })
        .ok_or_else(|| format!("Library source #{index}: libDir is empty"))?;
    if !directory.exists() {
        return Err(format!(
            "Library source #{index}: directory \"{}\" not exists",
            directory.display()
        )
        .into());
    }
    let folder = row.get("type").and_then(Value::as_str) == Some("folder");
    let resolved = if folder {
        PathBuf::new()
    } else {
        let file = match inpx {
            Some(file) => file,
            None => find_inpx(&directory)?,
        };
        if !file.exists() {
            return Err(format!(
                "Library source #{index}: file \"{}\" not found",
                file.display()
            )
            .into());
        }
        file
    };
    let stem = resolved.file_stem().unwrap_or_default().to_string_lossy();
    let raw_name = field("name");
    let id_input = field("id").or_else(|| raw_name.clone()).unwrap_or_else(|| {
        nonempty(&stem)
            .map(str::to_owned)
            .unwrap_or_else(|| format!("source-{index}"))
    });
    let id = stable_id(&id_input, index);
    let name = raw_name
        .as_deref()
        .and_then(|name| nonempty(name.trim_matches(js_space)))
        .or_else(|| nonempty(&stem))
        .unwrap_or(&id)
        .into();
    Ok(Source {
        kind: Some(if folder { Kind::Folder } else { Kind::Inpx }),
        id,
        name,
        inpx_file: resolved.clone(),
        inpx: resolved,
        lib_dir: directory,
        enabled: true,
        remote: false,
    })
}

fn nonempty(value: &str) -> Option<&str> {
    (!value.is_empty()).then_some(value)
}

fn setting(value: &Value) -> Option<String> {
    match value {
        Value::Null | Value::Bool(false) => None,
        Value::Number(number) if number.as_f64() == Some(0.0) => None,
        Value::String(value) => nonempty(value).map(str::to_owned),
        _ => Some(js_string(value)),
    }
}

pub(crate) fn js_string(value: &Value) -> String {
    match value {
        Value::String(value) => value.clone(),
        Value::Array(values) => values
            .iter()
            .map(|value| {
                if value.is_null() {
                    String::new()
                } else {
                    js_string(value)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
        Value::Number(number) if number.as_f64() == Some(0.0) => "0".into(),
        Value::Number(number) => number.to_string().trim_end_matches(".0").into(),
        _ => value.to_string(),
    }
}

fn stable_id(value: &str, index: usize) -> String {
    let fallback = format!("source-{index}");
    let mut id = String::new();
    let mut in_separator = false;
    for ch in value.to_lowercase().chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-') {
            id.push(ch);
            in_separator = false;
        } else if !in_separator {
            id.push('-');
            in_separator = true;
        }
    }
    let id = id.trim_matches('-');
    if !id.is_empty() {
        return id[..id.len().min(40)].into();
    }
    let mut digest = [0; 20];
    // SHA-1 preserves the old identifier for names with no ASCII slug.
    // All buffers are live, disjoint, and sized for the call.
    unsafe { aws_lc_sys::SHA1(value.as_ptr(), value.len(), digest.as_mut_ptr()) };
    format!("{fallback}-{}", hex(&digest[..4]))
}

fn find_inpx(directory: &Path) -> Result<PathBuf> {
    let mut matches = Vec::new();
    for entry in ordered_entries(directory)? {
        let (name, entry) = entry?;
        let name = name.to_string_lossy();
        if !entry.file_type()?.is_dir()
            && Path::new(name.as_ref())
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case(OsStr::new("inpx")))
        {
            matches.push(directory.join(name.as_ref()));
        }
    }
    match matches.len() {
        1 => Ok(matches.pop().expect("one INPX file")),
        0 => Err(format!("No .inpx files found here: {}", directory.display()).into()),
        _ => Err(format!(
            "Found more than one .inpx files: \n{}",
            matches
                .iter()
                .map(|path| path.to_string_lossy())
                .collect::<Vec<_>>()
                .join("\n")
        )
        .into()),
    }
}
