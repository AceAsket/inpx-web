use std::fs;
use std::io::{Read, Write};
use std::path::PathBuf;

use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use super::{ReaderState, now, shelves::truthy, string};
use crate::{Result, atomic_file, book_cache, library_sources::js_string};

const VERSION: i64 = 2;
const IMAGE_BYTES: usize = 4 * 1024 * 1024;

impl ReaderState {
    pub fn update_preferences(
        &self,
        owner: &str,
        stamp: &str,
        patch: &Value,
        root: &str,
    ) -> Result<Value> {
        let mut snapshot = self.snapshot(stamp)?;
        let user = super::transfer::user_mut(&mut snapshot.data, owner)?;
        let mut value = normalize(&user["readerPreferences"]);
        if let Some(patch) = patch.as_object() {
            value
                .as_object_mut()
                .expect("reader preferences")
                .extend(patch.clone());
        }
        let mut value = normalize(&value);
        self.externalize_preferences(owner, root, &mut value)?;
        user["readerPreferences"] = value.clone();
        user["updatedAt"] = now().into();
        self.publish(snapshot, stamp)?;
        Ok(json!({"preferences":value}))
    }

    pub(super) fn externalize_preferences(
        &self,
        owner: &str,
        root: &str,
        value: &mut Value,
    ) -> Result<()> {
        for field in [None, Some("einkProfile")] {
            let settings = field.map_or_else(|| &*value, |field| &value[field]);
            let image = string(&settings["backgroundImage"]);
            let name = if let Some(name) = reference(image, owner) {
                name.to_owned()
            } else {
                let Some((head, encoded)) = image.split_once(',') else {
                    continue;
                };
                let head = head.to_ascii_lowercase();
                let Some(kind) = head
                    .strip_prefix("data:image/")
                    .and_then(|kind| kind.split(';').next())
                else {
                    continue;
                };
                let ext = match kind {
                    "png" | "gif" | "webp" => kind,
                    "jpg" | "jpeg" => "jpg",
                    _ => continue,
                };
                if !head.ends_with(";base64") || encoded.len() > IMAGE_BYTES.div_ceil(3) * 4 {
                    return Err("Фон должен быть PNG, JPEG, GIF или WebP размером до 4 МиБ".into());
                }
                let bytes = STANDARD.decode(encoded)?;
                if bytes.is_empty() || bytes.len() > IMAGE_BYTES {
                    return Err("Превышен размер фона".into());
                }
                let name = format!("{:x}.{ext}", Sha256::digest(&bytes));
                let path = self.background_path(owner, &name, true)?;
                if book_cache::regular_file(&path, false)?.is_none() {
                    let mut output = tempfile::NamedTempFile::new_in(
                        path.parent().expect("background directory"),
                    )?;
                    output.write_all(&bytes)?;
                    atomic_file::publish(output, &path, None)?;
                }
                name
            };
            let encoded_owner =
                percent_encoding::utf8_percent_encode(owner, percent_encoding::NON_ALPHANUMERIC);
            let link = format!("{root}/reader-background/{encoded_owner}/{name}");
            let settings = match field {
                Some(field) => &mut value[field],
                None => &mut *value,
            };
            settings["backgroundImage"] = link.into();
        }
        Ok(())
    }

    pub(super) fn inline_preferences(&self, owner: &str, value: &mut Value) -> Result<()> {
        for field in [None, Some("einkProfile")] {
            let settings = match field {
                Some(field) => &mut value[field],
                None => &mut *value,
            };
            if let Some(name) = reference(string(&settings["backgroundImage"]), owner) {
                let (mime, bytes) = self
                    .read_background(owner, name)?
                    .ok_or("Файл фона не найден")?;
                settings["backgroundImage"] =
                    format!("data:{mime};base64,{}", STANDARD.encode(bytes)).into();
            }
        }
        Ok(())
    }

    pub fn background(
        &self,
        owner: &str,
        stamp: &str,
        name: &str,
    ) -> Result<Option<(&'static str, Vec<u8>)>> {
        if image_type(name).is_none() {
            return Ok(None);
        }
        let snapshot = self.snapshot(stamp)?;
        let user = super::transfer::user(&snapshot.data, owner)?;
        let settings = &user["readerPreferences"];
        if [settings, &settings["einkProfile"]]
            .into_iter()
            .any(|value| reference(string(&value["backgroundImage"]), owner) == Some(name))
        {
            self.read_background(owner, name)
        } else {
            Ok(None)
        }
    }

    fn background_path(&self, owner: &str, name: &str, create: bool) -> Result<PathBuf> {
        let directory = self.file.with_file_name("reader-backgrounds");
        if create {
            fs::create_dir_all(&directory)?;
        }
        if !fs::symlink_metadata(&directory)?.file_type().is_dir() {
            return Err("Небезопасный каталог фонов".into());
        }
        Ok(directory.join(format!("{:x}-{name}", Sha256::digest(owner.as_bytes()))))
    }

    fn read_background(&self, owner: &str, name: &str) -> Result<Option<(&'static str, Vec<u8>)>> {
        let Some(mime) = image_type(name) else {
            return Ok(None);
        };
        let path = match self.background_path(owner, name, false) {
            Ok(path) => path,
            Err(error)
                if error
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound) =>
            {
                return Ok(None);
            }
            Err(error) => return Err(error),
        };
        let Some(file) = book_cache::regular_file(&path, false)? else {
            return Ok(None);
        };
        let mut bytes = Vec::new();
        file.take(IMAGE_BYTES as u64 + 1).read_to_end(&mut bytes)?;
        if bytes.len() > IMAGE_BYTES || format!("{:x}", Sha256::digest(&bytes)) != name[..64] {
            return Err("Файл фона повреждён".into());
        }
        Ok(Some((mime, bytes)))
    }
}

fn image_type(name: &str) -> Option<&'static str> {
    let (hash, ext) = name.split_once('.')?;
    if hash.len() != 64
        || !hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return None;
    }
    match ext {
        "png" => Some("image/png"),
        "jpg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

fn reference<'a>(value: &'a str, owner: &str) -> Option<&'a str> {
    let suffix = value.strip_prefix("reader-background/").or_else(|| {
        value
            .rsplit_once("/reader-background/")
            .map(|(_, suffix)| suffix)
    })?;
    let (id, name) = suffix.split_once('/')?;
    if percent_encoding::percent_decode_str(id)
        .decode_utf8()
        .ok()?
        .as_ref()
        == owner
    {
        image_type(name).map(|_| name)
    } else {
        None
    }
}

pub(super) fn normalize(value: &Value) -> Value {
    let legacy = integer(&value["readerPreferencesVersion"]) < VERSION;
    let mut main = runtime(value, false, legacy);
    let eink = &value["einkProfile"];
    let mut profile = runtime(eink, true, legacy);
    for (settings, source, ink) in [(&mut main, value, false), (&mut profile, eink, true)] {
        for key in ["regularProfile", "compactProfile"] {
            settings.insert(key.into(), device(&source[key], ink).into());
        }
    }
    main.insert("einkProfile".into(), profile.into());
    main.insert("readerPreferencesVersion".into(), VERSION.into());
    main.insert(
        "showPageFootnotes".into(),
        (value["showPageFootnotes"] != false).into(),
    );
    main.insert(
        "theme".into(),
        choice(&value["theme"], &["light", "sepia", "dark", "eink"], "dark"),
    );
    main.into()
}

fn runtime(value: &Value, eink: bool, legacy: bool) -> Map<String, Value> {
    let mut result = Map::new();
    for (key, accepted, default, invalid) in [
        (
            "readMode",
            &["paged"][..],
            if eink { "paged" } else { "scroll" },
            "scroll",
        ),
        ("pagedNavigation", &["wheel"][..], "tap", "tap"),
        (
            "pagedDirection",
            &["horizontal"][..],
            "vertical",
            "vertical",
        ),
        (
            "pageAnimation",
            &["none", "soft", "slide"][..],
            if eink { "none" } else { "soft" },
            "soft",
        ),
        (
            "pageAnimationSpeed",
            &["fast", "normal", "slow"][..],
            if eink { "fast" } else { "normal" },
            "normal",
        ),
        (
            "statusBarProgressPosition",
            &["side"][..],
            "bottom",
            "bottom",
        ),
        ("statusBarAlign", &["edge"][..], "center", "center"),
        (
            "fontFamily",
            &["serif", "sans", "mono", "system"][..],
            "serif",
            "serif",
        ),
        ("contentWidthMode", &["viewport"][..], "fixed", "fixed"),
        ("pagedSpreadMode", &["dual"][..], "single", "single"),
    ] {
        result.insert(
            key.into(),
            if let Some(value) = value.get(key) {
                choice(value, accepted, invalid)
            } else {
                default.into()
            },
        );
    }
    for key in [
        "showStatusBar",
        "statusBarClock",
        "statusBarProgressBar",
        "statusBarRemaining",
        "textShadow",
        "backgroundTransparentPages",
        "backgroundTransparentStatus",
    ] {
        let checked = match key {
            "showStatusBar" => value[key] != false,
            "textShadow" => !legacy && value[key] == true,
            _ => value[key] == true,
        };
        result.insert(key.into(), checked.into());
    }
    for (key, default, zero, min, max) in [
        ("statusBarSize", 12, 12, 10, 18),
        ("fontSize", if eink { 19 } else { 18 }, 18, 14, 30),
        (
            "contentWidth",
            if eink { 920 } else { 1040 },
            1040,
            480,
            2200,
        ),
        ("dualPageGap", 28, 0, 0, 240),
        ("pageVerticalPadding", 18, 0, 0, 160),
        ("pageHorizontalPadding", 18, 0, 0, 220),
        ("pagePaddingTop", 18, 0, 0, 160),
        ("pagePaddingBottom", 22, 0, 0, 160),
        ("pagePaddingLeft", 18, 0, 0, 220),
        ("pagePaddingRight", 18, 0, 0, 220),
        ("pageOuterGap", 28, 0, 0, 220),
        ("pageOuterGapTop", 28, 0, 0, 220),
        ("pageOuterGapBottom", 28, 0, 0, 220),
        ("einkContrast", 92, 92, 72, 100),
        ("einkPaperTone", 94, 94, 84, 99),
        ("einkInkTone", 10, 10, 4, 26),
    ] {
        let amount = value.get(key).map_or(default, |value| {
            let n = integer(value);
            if n == 0 { zero } else { n }
        });
        result.insert(key.into(), amount.clamp(min, max).into());
    }
    let line_height = value
        .get("lineHeight")
        .map_or(if eink { 1.8 } else { 1.7 }, |value| {
            let n = if value == true {
                1.0
            } else {
                super::number(value)
            };
            if n == 0.0 { 1.7 } else { n }
        });
    result.insert("lineHeight".into(), line_height.clamp(1.15, 2.2).into());
    result.insert(
        "backgroundImage".into(),
        text(&value["backgroundImage"]).trim().into(),
    );
    result.insert(
        "backgroundImageName".into(),
        clip(text(&value["backgroundImageName"]).trim(), 160).into(),
    );
    result
}

fn device(value: &Value, eink: bool) -> Map<String, Value> {
    let mut settings = runtime(value, eink, false);
    settings.retain(|key, _| {
        matches!(
            key.as_str(),
            "readMode"
                | "pagedNavigation"
                | "pagedDirection"
                | "pageAnimation"
                | "pageAnimationSpeed"
                | "contentWidth"
                | "contentWidthMode"
                | "pagedSpreadMode"
                | "dualPageGap"
                | "pageVerticalPadding"
                | "pageHorizontalPadding"
                | "pagePaddingTop"
                | "pagePaddingBottom"
                | "pagePaddingLeft"
                | "pagePaddingRight"
                | "pageOuterGap"
                | "pageOuterGapTop"
                | "pageOuterGapBottom"
        ) && (value.get(key).is_some()
            || match key.as_str() {
                "pagePaddingTop" | "pagePaddingBottom" => {
                    value.get("pageVerticalPadding").is_some()
                }
                "pagePaddingLeft" | "pagePaddingRight" => {
                    value.get("pageHorizontalPadding").is_some()
                }
                "pageOuterGapTop" | "pageOuterGapBottom" => value.get("pageOuterGap").is_some(),
                _ => false,
            })
    });
    settings
}

fn choice(value: &Value, accepted: &[&str], fallback: &str) -> Value {
    let value = text(value).trim().to_lowercase();
    if accepted.contains(&value.as_str()) {
        value.into()
    } else {
        fallback.into()
    }
}

pub(super) fn text(value: &Value) -> String {
    if truthy(value) {
        js_string(value)
    } else {
        String::new()
    }
}

pub(super) fn clip(value: &str, mut remaining: usize) -> &str {
    let end = value
        .char_indices()
        .find_map(|(offset, ch)| match remaining.checked_sub(ch.len_utf16()) {
            Some(left) => {
                remaining = left;
                None
            }
            None => Some(offset),
        })
        .unwrap_or(value.len());
    &value[..end]
}

pub(super) fn integer(value: &Value) -> i64 {
    let text = text(value);
    let input = text.trim_start();
    let digits = input.trim_start_matches(['+', '-']);
    let end = digits.bytes().take_while(u8::is_ascii_digit).count();
    if end == 0 {
        return 0;
    }
    input[..input.len() - digits.len() + end]
        .parse()
        .unwrap_or_else(|_| {
            if input.starts_with('-') {
                i64::MIN
            } else {
                i64::MAX
            }
        })
}
