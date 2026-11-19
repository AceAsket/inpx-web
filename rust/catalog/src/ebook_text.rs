use std::io::{BufReader, Read};
use std::path::Path;

use quick_xml::{Reader, events::Event};

use crate::book_archive::Failure;
use crate::{Result, book_cache, fb2_prepare::js_space};

pub const FILE_LIMIT: u64 = 32 * 1024 * 1024;
pub const CHARACTER_LIMIT: usize = 2 * 1024 * 1024;

pub fn read(path: &Path) -> Result<Vec<u16>> {
    let file = book_cache::regular_file(path, true)?.ok_or(Failure::Missing)?;
    if file.metadata()?.len() > FILE_LIMIT {
        return Err(Failure::Limit.into());
    }
    let mut reader = Reader::from_reader(BufReader::new(file.take(FILE_LIMIT + 1)));
    let mut buffer = Vec::new();
    let mut stack = Vec::new();
    let mut body = false;
    let mut fictionbook = false;
    let mut text = Text::default();
    loop {
        let event = reader
            .read_event_into(&mut buffer)
            .map_err(|_| Failure::Unsupported)?;
        match event {
            Event::Start(tag) => {
                let local = tag.local_name();
                let name = local.as_ref();
                if stack.is_empty() {
                    fictionbook = name.eq_ignore_ascii_case("fictionbook");
                }
                if stack.len() == 1 && fictionbook {
                    body = name.eq_ignore_ascii_case("body");
                }
                if stack.len() >= 128 {
                    return Err(Failure::Limit.into());
                }
                let block = body && is_block(name);
                if block {
                    text.paragraph()?;
                }
                stack.push(block);
            }
            Event::End(_) => {
                if stack.pop().ok_or(Failure::Unsupported)? {
                    text.paragraph()?;
                }
                if stack.len() <= 1 {
                    body = false;
                }
            }
            Event::Empty(tag) if body && is_block(tag.local_name().as_ref()) => text.paragraph()?,
            Event::Text(value) if body => text.append(value.as_ref())?,
            Event::CData(value) if body => text.append(value.as_ref())?,
            Event::GeneralRef(value) if body => {
                let name: &str = value.as_ref();
                if let Some(character) = value.resolve_char_ref()? {
                    text.append(character.encode_utf8(&mut [0; 4]))?;
                } else if let Some(value) = quick_xml::escape::resolve_xml_entity(name) {
                    text.append(value)?;
                } else {
                    text.append("&")?;
                    text.append(name)?;
                    text.append(";")?;
                }
            }
            Event::Eof => break,
            _ => {}
        }
        if reader.buffer_position() > FILE_LIMIT {
            return Err(Failure::Limit.into());
        }
        buffer.clear();
    }
    if !fictionbook || !stack.is_empty() || text.units.is_empty() {
        return Err(Failure::Unsupported.into());
    }
    while text
        .units
        .last()
        .is_some_and(|&unit| char::from_u32(unit.into()).is_some_and(js_space))
    {
        text.units.pop();
    }
    if text.units.is_empty() {
        return Err(Failure::Unsupported.into());
    }
    Ok(text.units)
}

fn is_block(name: &str) -> bool {
    [
        "p",
        "v",
        "subtitle",
        "title",
        "empty-line",
        "stanza",
        "section",
    ]
    .iter()
    .any(|block| name.eq_ignore_ascii_case(block))
}

#[derive(Default)]
struct Text {
    units: Vec<u16>,
    pending: u8,
    total: usize,
}

impl Text {
    fn paragraph(&mut self) -> Result<()> {
        self.pending = 2;
        self.total += 2;
        if self.total > CHARACTER_LIMIT {
            return Err(Failure::Limit.into());
        }
        Ok(())
    }

    fn append(&mut self, value: &str) -> Result<()> {
        for character in value.chars() {
            self.total += character.len_utf16();
            if self.total > CHARACTER_LIMIT {
                return Err(Failure::Limit.into());
            }
            if matches!(character, ' ' | '\t' | '\r' | '\n') {
                self.pending = self.pending.max(1);
                continue;
            }
            if self.units.is_empty() && js_space(character) {
                continue;
            }
            if !self.units.is_empty() {
                match self.pending {
                    1 => self.units.push(u16::from(b' ')),
                    2 => self.units.extend([u16::from(b'\n'); 2]),
                    _ => {}
                }
            }
            self.pending = 0;
            self.units
                .extend(character.encode_utf16(&mut [0; 2]).iter().copied());
        }
        Ok(())
    }
}
