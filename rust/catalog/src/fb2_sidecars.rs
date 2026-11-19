use std::collections::BTreeSet;
use std::fs::{self, File};
use std::io::{self, BufWriter, Seek, Write};
use std::path::Path;

use base64::{engine::general_purpose::STANDARD, write::EncoderWriter};
use quick_xml::{Reader, events::Event};

use crate::Result;
use crate::book_archive::{Failure, input_directory};
use crate::book_source::Input;
use crate::legacy_library_files::{Covers, read_member};
use crate::reader_document::Image;

// Keep full-sized illustrations in the downloaded book. The gallery applies
// its own thumbnail and response limits when it reads the prepared document.
const ASSET_LIMIT: usize = 64 * 1024 * 1024;

#[derive(Default)]
struct Layout {
    images: BTreeSet<String>,
    binaries: BTreeSet<String>,
    cover: Option<String>,
    title_start: Option<usize>,
    cover_tag: Option<(usize, usize, bool)>,
    end: usize,
}

fn layout(xml: &str) -> Option<Layout> {
    let mut reader = Reader::from_str(xml);
    let mut result = Layout::default();
    let mut stack = Vec::new();
    loop {
        let start = reader.buffer_position() as usize;
        let event = reader.read_event().ok()?;
        let empty = matches!(event, Event::Empty(_));
        match event {
            Event::Start(tag) | Event::Empty(tag) => {
                let name = tag.name().as_ref().to_ascii_lowercase();
                let end = reader.buffer_position() as usize;
                let in_title = stack.iter().map(String::as_str).eq([
                    "fictionbook",
                    "description",
                    "title-info",
                ]);
                if name == "title-info"
                    && !empty
                    && stack
                        .iter()
                        .map(String::as_str)
                        .eq(["fictionbook", "description"])
                {
                    result.title_start.get_or_insert(end);
                }
                if name == "coverpage" && in_title {
                    result.cover_tag.get_or_insert((start, end, empty));
                }
                if name == "image" || name == "binary" {
                    for attr in tag.attributes().flatten() {
                        let key = attr.key.as_ref().rsplit(':').next()?;
                        let value = attr
                            .normalized_value(quick_xml::XmlVersion::Implicit1_0)
                            .ok()?;
                        let id = value.trim();
                        if name == "binary" && key == "id" {
                            result.binaries.insert(id.to_owned());
                        } else if name == "image"
                            && key == "href"
                            && let Some(id) = id.strip_prefix('#')
                        {
                            if stack.iter().map(String::as_str).eq([
                                "fictionbook",
                                "description",
                                "title-info",
                                "coverpage",
                            ]) && result.cover.is_none()
                            {
                                result.cover = Some(id.to_owned());
                            }
                            result.images.insert(id.to_owned());
                        }
                    }
                }
                if !empty {
                    stack.push(name);
                }
            }
            Event::End(_) => {
                if stack.len() == 1 && stack[0] == "fictionbook" {
                    result.end = start;
                }
                stack.pop()?;
            }
            Event::Eof => return (result.end > 0 && stack.is_empty()).then_some(result),
            _ => (),
        }
    }
}

pub(crate) fn restore(
    raw: &Path,
    decoder: &Covers,
    cache: &Path,
    covers: Vec<Input>,
    images: Vec<Input>,
    limit: u64,
) -> Result<()> {
    let xml = fs::read_to_string(raw)?;
    let Some(mut layout) = layout(&xml) else {
        return Ok(());
    };
    let mut binaries = BufWriter::new(tempfile::tempfile_in(cache)?);
    let mut size = xml.len() as u64;
    let mut append = |id: &str, image: Image| -> Result<()> {
        let tag = format!(
            "<binary id=\"{}\" content-type=\"{}\">",
            quick_xml::escape::escape(id),
            image.content_type
        );
        size += (tag.len() + image.bytes.len().div_ceil(3) * 4 + "</binary>".len()) as u64;
        if size > limit {
            return Err(Failure::Limit.into());
        }
        binaries.write_all(tag.as_bytes())?;
        let mut encoded = EncoderWriter::new(&mut binaries, &STANDARD);
        encoded.write_all(&image.bytes)?;
        encoded.finish()?.write_all(b"</binary>")?;
        Ok(())
    };
    let mut link = None;
    if layout
        .cover
        .as_ref()
        .is_none_or(|id| !layout.binaries.contains(id))
        && let Some(image) = decoder
            .read_sidecars(covers, cache, ASSET_LIMIT)
            .ok()
            .flatten()
    {
        let id = layout.cover.clone().unwrap_or_else(|| {
            let mut id = String::from("sidecar-cover");
            while layout.images.contains(&id) || layout.binaries.contains(&id) {
                id.push('_');
            }
            id
        });
        if layout.cover.is_none()
            && let Some(start) = layout.title_start
        {
            let image_tag =
                format!("<image xmlns:l=\"http://www.w3.org/1999/xlink\" l:href=\"#{id}\"/>");
            link = Some(match layout.cover_tag {
                Some((a, b, true)) => (a, b, format!("<coverpage>{image_tag}</coverpage>")),
                Some((_, b, false)) => (b, b, image_tag),
                None => (start, start, format!("<coverpage>{image_tag}</coverpage>")),
            });
        }
        append(&id, image)?;
        layout.binaries.insert(id);
    }
    layout.images.retain(|id| {
        !layout.binaries.contains(id)
            && !id.is_empty()
            && id.len() <= 512
            && !id.contains(['/', '\\'])
            && !id.chars().any(char::is_control)
    });
    for input in images {
        if layout.images.is_empty() {
            break;
        }
        let Some(stem) = input.member else { continue };
        let Ok(mut archive) = input_directory(&input.path, input.file) else {
            continue;
        };
        let mut found = Vec::new();
        for id in &layout.images {
            let name = format!("{stem}/{id}");
            let data =
                read_member(&mut archive, &name, ASSET_LIMIT as u64).or_else(|error| match error {
                    Failure::Missing => {
                        read_member(&mut archive, &format!("{stem}\\{id}"), ASSET_LIMIT as u64)
                    }
                    other => Err(other),
                });
            if let Ok(bytes) = data
                && let Ok(Some(image)) = decoder.browser_image(bytes, cache, ASSET_LIMIT)
            {
                append(id, image)?;
                found.push(id.clone());
            }
        }
        for id in found {
            layout.images.remove(&id);
        }
    }
    let mut binaries = binaries.into_inner().map_err(|error| error.into_error())?;
    if binaries.stream_position()? == 0 {
        return Ok(());
    }
    if let Some((a, b, tag)) = &link
        && size + tag.len() as u64 - (b - a) as u64 > limit
    {
        return Err(Failure::Limit.into());
    }
    binaries.rewind()?;
    // raw is private staging. Preserve the original markup outside the two insertions.
    let mut output = BufWriter::new(File::create(raw)?);
    let mut start = 0;
    if let Some((a, b, tag)) = link {
        output.write_all(&xml.as_bytes()[..a])?;
        output.write_all(tag.as_bytes())?;
        start = b;
    }
    output.write_all(&xml.as_bytes()[start..layout.end])?;
    io::copy(&mut binaries, &mut output)?;
    output.write_all(&xml.as_bytes()[layout.end..])?;
    output.flush()?;
    Ok(())
}
