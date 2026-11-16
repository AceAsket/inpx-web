use std::collections::{HashMap, HashSet};
use std::io::{Read, Seek, Write};
use std::sync::LazyLock;

use base64::{Engine, engine::general_purpose::STANDARD};
use regex::Regex;

use crate::Result;
use crate::epub_fb2::{Output, invalid};
use crate::epub_fb2_input::{MB, Node, Source, hash, reference};
use crate::fb2_prepare::js_space;

pub(crate) fn image_key(file: &str, value: &str) -> Result<Option<String>> {
    if value.starts_with("data:") {
        return Ok(Some(format!("data:{}", hash(value))));
    }
    Ok(reference(file, value)?.file)
}

pub(crate) fn check_svg(node: &Node) -> Result<()> {
    if node.all("").iter().any(|child| {
        matches!(
            child.name.as_str(),
            "path" | "rect" | "circle" | "polygon" | "polyline" | "line" | "text" | "ellipse"
        )
    }) {
        return Err(invalid(
            "векторную SVG-иллюстрацию нельзя перенести в FB2 без потери содержимого",
        ));
    }
    Ok(())
}

#[derive(Default)]
pub(crate) struct Images {
    pub aliases: HashMap<String, String>,
    images: Vec<Image>,
    inline_bytes: usize,
}

struct Image {
    id: String,
    media_type: &'static str,
    source: ImageSource,
}

enum ImageSource {
    File(String),
    Inline(Vec<u8>),
}

impl Images {
    pub(crate) fn add(
        &mut self,
        source: &mut Source<impl Read + Seek>,
        encrypted: &HashSet<String>,
        media_type: impl Fn(&str) -> String,
        file: &str,
        href: &str,
    ) -> Result<String> {
        let key = image_key(file, href)?
            .ok_or_else(|| invalid("удалённые изображения недоступны для преобразования"))?;
        self.resolve(source, encrypted, &media_type, key, href)
    }

    pub(crate) fn add_file(
        &mut self,
        source: &mut Source<impl Read + Seek>,
        encrypted: &HashSet<String>,
        media_type: impl Fn(&str) -> String,
        file: &str,
    ) -> Result<String> {
        self.resolve(source, encrypted, &media_type, file.into(), "")
    }

    fn resolve(
        &mut self,
        source: &mut Source<impl Read + Seek>,
        encrypted: &HashSet<String>,
        media_type: &impl Fn(&str) -> String,
        mut key: String,
        href: &str,
    ) -> Result<String> {
        let mut trail = HashSet::new();
        let mut inline = href.to_owned();
        let id = loop {
            if let Some(id) = self.aliases.get(&key) {
                break id.clone();
            }
            if key.starts_with("data:") {
                let (data, kind) = self.inline(&inline)?;
                break self.register(key, kind, ImageSource::Inline(data));
            }
            if encrypted.contains(&key) {
                return Err(invalid("содержимое защищено шифрованием"));
            }
            let kind = media_type(&key);
            let kind = if kind.is_empty() {
                match key
                    .rsplit_once('.')
                    .map(|(_, ext)| ext.to_ascii_lowercase())
                    .as_deref()
                {
                    Some("png") => "image/png",
                    Some("jpg" | "jpeg") => "image/jpeg",
                    Some("gif") => "image/gif",
                    Some("webp") => "image/webp",
                    Some("svg") => "image/svg+xml",
                    _ => "",
                }
            } else {
                &kind
            };
            if kind != "image/svg+xml" {
                let kind = supported(kind)
                    .ok_or_else(|| invalid("неподдерживаемый формат иллюстрации"))?;
                break self.register(key.clone(), kind, ImageSource::File(key));
            }
            if !trail.insert(key.clone()) {
                return Err(invalid("циклическая ссылка SVG"));
            }
            let (svg, _) = source.document(&key, 2 * MB)?;
            let embedded = svg.all("image");
            if embedded.len() != 1 {
                return Err(invalid(
                    "векторную SVG-иллюстрацию нельзя перенести в FB2 без потери содержимого",
                ));
            }
            check_svg(&svg)?;
            let href = embedded[0].attr("href");
            let href = if href.is_empty() {
                embedded[0].attr("xlink:href")
            } else {
                href
            };
            key = image_key(&key, href)?
                .ok_or_else(|| invalid("удалённые изображения недоступны для преобразования"))?;
            if key.starts_with("data:") {
                inline = href.to_owned();
            }
        };
        self.aliases
            .extend(trail.into_iter().map(|key| (key, id.clone())));
        Ok(id)
    }

    fn inline(&mut self, href: &str) -> Result<(Vec<u8>, &'static str)> {
        static INLINE: LazyLock<Regex> = LazyLock::new(|| {
            Regex::new(r"(?i)^data:(image/(?:png|jpeg|gif|webp));base64,([a-z\d+/=\s]+)$").unwrap()
        });
        let fields = INLINE
            .captures(href)
            .filter(|_| href.len() <= 12 * MB as usize)
            .ok_or_else(|| invalid("неподдерживаемое встроенное изображение"))?;
        let kind = supported(&fields[1].to_ascii_lowercase()).expect("checked media type");
        let encoded: Vec<_> = fields[2]
            .split('=')
            .next()
            .unwrap_or_default()
            .chars()
            .filter(|&ch| !js_space(ch))
            .map(|ch| ch as u8)
            .collect();
        let decoder = base64::engine::GeneralPurpose::new(
            &base64::alphabet::STANDARD,
            base64::engine::GeneralPurposeConfig::new()
                .with_decode_allow_trailing_bits(true)
                .with_decode_padding_mode(base64::engine::DecodePaddingMode::Indifferent),
        );
        let data = decoder
            .decode(&encoded[..encoded.len() - usize::from(encoded.len() % 4 == 1)])
            .map_err(|_| invalid("неподдерживаемое встроенное изображение"))?;
        self.inline_bytes += data.len();
        if self.inline_bytes > 32 * MB as usize {
            return Err(invalid("слишком много встроенных изображений"));
        }
        Ok((data, kind))
    }

    fn register(&mut self, key: String, media_type: &'static str, source: ImageSource) -> String {
        let id = format!("img_{}", hash(&key));
        self.aliases.insert(key, id.clone());
        self.images.push(Image {
            id: id.clone(),
            media_type,
            source,
        });
        id
    }

    pub(crate) fn render(
        &self,
        source: &mut Source<impl Read + Seek>,
        output: &mut Output<impl Write>,
    ) -> Result<()> {
        let mut bytes = vec![0; 48 * 1024];
        let mut encoded = String::with_capacity(64 * 1024);
        for image in &self.images {
            output.write(&format!(
                "<binary id=\"{}\" content-type=\"{}\">",
                image.id, image.media_type
            ))?;
            match &image.source {
                ImageSource::File(file) => {
                    let (mut entry, size) = source.entry(file, 64 * MB)?;
                    let mut remaining = size;
                    while remaining > 0 {
                        let count = remaining.min(bytes.len() as u64) as usize;
                        entry
                            .read_exact(&mut bytes[..count])
                            .map_err(|_| invalid("неверная контрольная сумма ресурса"))?;
                        if remaining == size {
                            check_signature(image.media_type, &bytes[..count])?;
                        }
                        write_base64(output, &bytes[..count], &mut encoded)?;
                        remaining -= count as u64;
                    }
                    if entry
                        .read(&mut bytes[..1])
                        .map_err(|_| invalid("неверная контрольная сумма ресурса"))?
                        != 0
                    {
                        return Err(invalid("неверный распакованный размер ресурса"));
                    }
                }
                ImageSource::Inline(data) => {
                    check_signature(image.media_type, data)?;
                    for part in data.chunks(bytes.len()) {
                        write_base64(output, part, &mut encoded)?;
                    }
                }
            }
            output.write("</binary>")?;
        }
        Ok(())
    }
}

fn write_base64(output: &mut Output<impl Write>, data: &[u8], encoded: &mut String) -> Result<()> {
    encoded.clear();
    STANDARD.encode_string(data, &mut *encoded);
    output.write(encoded)
}

fn supported(kind: &str) -> Option<&'static str> {
    ["image/png", "image/jpeg", "image/gif", "image/webp"]
        .into_iter()
        .find(|&value| value == kind)
}

fn check_signature(kind: &str, data: &[u8]) -> Result<()> {
    let valid = match kind {
        "image/png" => data.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg" => data.starts_with(b"\xff\xd8"),
        "image/gif" => data.starts_with(b"GIF"),
        "image/webp" => data.starts_with(b"RIFF") && data.get(8..12) == Some(b"WEBP"),
        _ => false,
    };
    if !valid {
        return Err(invalid(
            "формат иллюстрации не соответствует её содержимому",
        ));
    }
    Ok(())
}
