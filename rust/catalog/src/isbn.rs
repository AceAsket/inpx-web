use std::collections::HashSet;
use std::sync::LazyLock;

use regex::Regex;

use crate::fb2_prepare::js_space;

fn separator(ch: char) -> bool {
    js_space(ch) || matches!(ch, '-' | '\u{2010}'..='\u{2015}')
}

pub(crate) fn normalize(raw: &str) -> Option<String> {
    static PREFIX: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?i)^(?:urn:isbn:|isbn(?:[ -]?1[03])?[\s\u{feff}]*:?[\s\u{feff}]*)").unwrap()
    });
    let raw = raw.trim_matches(js_space);
    if raw.encode_utf16().take(101).count() > 100 {
        return None;
    }
    let value = PREFIX
        .find(raw)
        .map_or(raw, |matched| &raw[matched.end()..]);
    let digits: String = value
        .chars()
        .filter(|&ch| !separator(ch))
        .map(|ch| ch.to_ascii_uppercase())
        .collect();
    canonical(&digits)
}

fn canonical(value: &str) -> Option<String> {
    let digits = value.as_bytes();
    match digits {
        [b'9', b'7', b'8' | b'9', rest @ ..]
            if rest.len() == 10 && rest.iter().all(u8::is_ascii_digit) =>
        {
            (weighted13(digits).is_multiple_of(10)).then(|| value.to_owned())
        }
        [prefix @ .., check]
            if prefix.len() == 9
                && prefix.iter().all(u8::is_ascii_digit)
                && (check.is_ascii_digit() || *check == b'X') =>
        {
            let total = prefix
                .iter()
                .enumerate()
                .map(|(index, value)| u32::from(value - b'0') * (10 - index as u32))
                .sum::<u32>()
                + if *check == b'X' {
                    10
                } else {
                    u32::from(check - b'0')
                };
            if !total.is_multiple_of(11) {
                return None;
            }
            let prefix = format!("978{}", &value[..9]);
            Some(format!(
                "{prefix}{}",
                (10 - weighted13(prefix.as_bytes()) % 10) % 10
            ))
        }
        _ => None,
    }
}

fn weighted13(value: &[u8]) -> u32 {
    value
        .iter()
        .enumerate()
        .map(|(i, byte)| u32::from(byte - b'0') * if i % 2 == 0 { 1 } else { 3 })
        .sum()
}

pub(crate) fn extract(raw: &str) -> Vec<String> {
    static CANDIDATE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^((?:97[89](?:[\s\u{feff}\u{2010}-\u{2015}-]*[0-9]){10}|(?:[0-9][\s\u{feff}\u{2010}-\u{2015}-]*){9}[0-9Xx]))(?:[^A-Za-z0-9]|$)").unwrap()
    });
    let mut units = 0;
    let mut value = raw;
    for (offset, ch) in raw.char_indices() {
        units += ch.len_utf16();
        if units > 16000 {
            value = &raw[..offset];
            break;
        }
    }
    let mut seen = HashSet::new();
    let mut numbers = Vec::new();
    let bytes = value.as_bytes();
    let mut offset = 0;
    while offset < bytes.len() {
        if bytes[offset].is_ascii_digit()
            && (offset == 0 || !bytes[offset - 1].is_ascii_alphanumeric())
            && let Some(candidate) = CANDIDATE.captures(&value[offset..]).and_then(|m| m.get(1))
        {
            let end = offset + candidate.end();
            if let Some(number) = normalize(candidate.as_str())
                && seen.insert(number.clone())
            {
                numbers.push(number);
            }
            offset = end;
            continue;
        }
        offset += 1;
    }
    numbers
}
