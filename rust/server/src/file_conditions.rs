use std::ops::Range;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use hyper::StatusCode;
use hyper::header::{self, HeaderMap, HeaderName};

pub(crate) struct FileVersion {
    pub etag: String,
    pub modified: SystemTime,
}

impl FileVersion {
    pub fn from_metadata(length: u64, modified: SystemTime) -> Option<Self> {
        let elapsed = modified.duration_since(UNIX_EPOCH).ok()?;
        let millis = (elapsed.as_secs() as f64 * 1000.0
            + f64::from(elapsed.subsec_nanos()) / 1_000_000.0)
            .round() as u64;
        if millis / 1000 >= 253_402_300_800 {
            return None;
        }
        Some(Self {
            etag: format!("W/\"{length:x}-{millis:x}\""),
            modified: UNIX_EPOCH + Duration::from_secs(millis / 1000),
        })
    }

    pub fn check(&self, headers: &HeaderMap) -> Option<StatusCode> {
        if let Some(tags) = first(headers, header::IF_MATCH) {
            if !etag_matches(tags, &self.etag) {
                return Some(StatusCode::PRECONDITION_FAILED);
            }
        } else if date(headers, header::IF_UNMODIFIED_SINCE)
            .is_some_and(|time| self.modified > time)
        {
            return Some(StatusCode::PRECONDITION_FAILED);
        }
        let tag = first(headers, header::IF_NONE_MATCH);
        let since = first(headers, header::IF_MODIFIED_SINCE);
        if (tag.is_some() || since.is_some())
            && !no_cache(headers)
            && tag.is_none_or(|etag| etag_matches(etag, &self.etag))
            && since.is_none_or(|value| {
                httpdate::parse_http_date(value).is_ok_and(|time| self.modified <= time)
            })
        {
            return Some(StatusCode::NOT_MODIFIED);
        }
        None
    }

    pub fn range(&self, headers: &HeaderMap, length: u64) -> Result<Option<Range<u64>>, ()> {
        if let Some(conditional) = first(headers, header::IF_RANGE) {
            let matched = if conditional.contains('"') {
                conditional.contains(&self.etag)
            } else {
                httpdate::parse_http_date(conditional).is_ok_and(|time| self.modified <= time)
            };
            if !matched {
                return Ok(None);
            }
        }
        let Some(value) = first(headers, header::RANGE)
            .and_then(|raw| raw.trim_start_matches(' ').strip_prefix("bytes="))
        else {
            return Ok(None);
        };
        let mut ranges: Vec<_> = value
            .split(',')
            .filter_map(|value| range(value, length))
            .collect();
        if ranges.is_empty() {
            return Err(());
        }
        ranges.sort_unstable_by_key(|range| range.start);
        let mut result = ranges[0].clone();
        for range in &ranges[1..] {
            // The existing HTTP contract combines adjacent and overlapping ranges,
            // and serves a full response for disconnected ranges.
            if result.end < range.start {
                return Ok(None);
            }
            result.end = result.end.max(range.end);
        }
        Ok(Some(result))
    }
}

fn first(headers: &HeaderMap, key: HeaderName) -> Option<&str> {
    headers
        .get(key)
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty())
}

fn date(headers: &HeaderMap, key: HeaderName) -> Option<SystemTime> {
    httpdate::parse_http_date(first(headers, key)?).ok()
}

pub(crate) fn no_cache(headers: &HeaderMap) -> bool {
    headers
        .get_all(header::CACHE_CONTROL)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .any(|value| value.trim().eq_ignore_ascii_case("no-cache"))
}

pub(crate) fn etag_matches(tags: &str, etag: &str) -> bool {
    let expected = etag.strip_prefix("W/").unwrap_or(etag);
    tags.trim() == "*"
        || tags
            .split(',')
            .map(str::trim)
            .any(|value| value.strip_prefix("W/").unwrap_or(value) == expected)
}

fn range(value: &str, length: u64) -> Option<Range<u64>> {
    let mut parts = value.split('-');
    let start = number(parts.next().unwrap_or_default());
    let end = parts.next().and_then(number);
    let (start, end) = match (start, end) {
        (Some(start), end) => (
            start,
            end.map_or(length, |value| length.min(value.saturating_add(1))),
        ),
        (None, Some(suffix)) => (length.checked_sub(suffix)?, length),
        _ => return None,
    };
    (start < end).then_some(start..end)
}

fn number(value: &str) -> Option<u64> {
    let raw = value.trim_start();
    let raw = raw.strip_prefix('+').unwrap_or(raw);
    let mut digits = raw.bytes().take_while(u8::is_ascii_digit);
    let first = digits.next()?;
    Some(digits.fold(u64::from(first - b'0'), |value, byte| {
        value
            .saturating_mul(10)
            .saturating_add(u64::from(byte - b'0'))
    }))
}
