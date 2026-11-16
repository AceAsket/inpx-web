use std::borrow::Cow;
use std::time::{SystemTime, UNIX_EPOCH};

use hmac::{Hmac, KeyInit, Mac};
use percent_encoding::percent_decode_str;
use sha2::Sha256;

use super::Forward;

const COVER_LIFETIME_MS: u64 = 24 * 60 * 60 * 1_000;
const QUERY_PARAMETER_LIMIT: usize = 1_000;

pub(crate) struct CoverSigner(Hmac<Sha256>);

impl CoverSigner {
    pub(crate) fn new(token: &str) -> Self {
        let mut mac = Hmac::new_from_slice(token.as_bytes()).expect("HMAC accepts any key length");
        mac.update(b"abs-cover:");
        Self(mac)
    }

    pub(crate) fn signed(&self, uid: &str) -> (u64, String) {
        let expires = inpx_catalog::access_runtime::now_ms() as u64 + COVER_LIFETIME_MS;
        use std::fmt::Write;
        let mut signature = String::with_capacity(64);
        for byte in self.mac(uid, &expires.to_string()).finalize().into_bytes() {
            write!(signature, "{byte:02x}").expect("hex signature");
        }
        (expires, signature)
    }

    fn mac(&self, uid: &str, expires: &str) -> Hmac<Sha256> {
        let mut mac = self.0.clone();
        mac.update(uid.as_bytes());
        mac.update(b":");
        mac.update(expires.as_bytes());
        mac
    }

    pub(super) fn verify(&self, query: &str) -> Result<Option<u64>, Forward> {
        let [Some(uid), Some(expires), Some(signature)] =
            query_values(query, ["uid", "expires", "signature"])?
        else {
            return Ok(None);
        };
        if uid.is_empty() || uid.encode_utf16().count() > 256 {
            return Ok(None);
        }
        let mut digest = [0; 32];
        let (pairs, tail) = signature.as_bytes().as_chunks::<2>();
        if pairs.len() != digest.len() || !tail.is_empty() {
            return Ok(None);
        }
        for (byte, &[hi, lo]) in digest.iter_mut().zip(pairs) {
            let (Some(hi), Some(lo)) = (lower_hex(hi), lower_hex(lo)) else {
                return Ok(None);
            };
            *byte = (hi << 4) | lo;
        }
        let time = trim_js(&expires);
        if !time.bytes().all(|byte| byte.is_ascii_digit()) {
            // The old endpoint also accepts other JavaScript Number literals.
            return Err(Forward);
        }
        let Ok(time) = time.parse::<u64>() else {
            return Ok(None);
        };
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| Forward)?
            .as_millis() as u64;
        if time <= now || time > now + COVER_LIFETIME_MS {
            return Ok(None);
        }
        Ok(self
            .mac(&uid, &expires)
            .verify_slice(&digest)
            .is_ok()
            .then_some(time))
    }
}

pub(crate) fn trim_js(value: &str) -> &str {
    value.trim_matches(|ch: char| ch == '\u{feff}' || (ch.is_whitespace() && ch != '\u{85}'))
}

pub(crate) fn query_values<'a, const N: usize>(
    query: &'a str,
    names: [&str; N],
) -> Result<[Option<Cow<'a, str>>; N], Forward> {
    if !query.is_ascii() || query.contains('#') {
        return Err(Forward);
    }
    let mut values = [const { None }; N];
    for part in query.split('&').take(QUERY_PARAMETER_LIMIT) {
        let (raw_key, raw_value) = part.split_once('=').unwrap_or((part, ""));
        let key = decode(raw_key)?;
        // Express uses qs. It can select a later `]=` as the separator and merge
        // bracketed or duplicate keys into objects/arrays. Leave those shapes to qs.
        if key.contains(['[', ']'])
            || raw_value.as_bytes().windows(2).any(|pair| pair == b"]=")
            || raw_value
                .as_bytes()
                .windows(4)
                .any(|bytes| bytes[3] == b'=' && bytes[..3].eq_ignore_ascii_case(b"%5d"))
        {
            return Err(Forward);
        }
        if let Some(index) = names.iter().position(|name| *name == key) {
            if values[index].is_some() {
                return Err(Forward);
            }
            values[index] = Some(decode(raw_value)?);
        }
    }
    Ok(values)
}

pub(super) fn metrics_token(query: &str) -> Option<Cow<'_, str>> {
    if let Ok([value]) = query_values(query, ["token"]) {
        return value;
    }
    // Express accepts a single scalar in an array for this route, since its
    // authorization middleware converts the query parameter to a string.
    let mut result = None;
    for part in query.split('&').take(QUERY_PARAMETER_LIMIT) {
        let (key, value) = part.split_once('=').unwrap_or((part, ""));
        let key = decode(key).ok()?;
        match key.as_ref() {
            "token[]" | "token[0]" if result.is_none() => result = Some(decode(value).ok()?),
            "token" => return None,
            key if key.starts_with("token[") => return None,
            _ => {}
        }
    }
    result
}

fn decode(part: &str) -> Result<Cow<'_, str>, Forward> {
    let bytes = part.as_bytes();
    for (index, _) in bytes.iter().enumerate().filter(|(_, byte)| **byte == b'%') {
        if !bytes
            .get(index + 1..index + 3)
            .is_some_and(|pair| pair.iter().all(u8::is_ascii_hexdigit))
        {
            return Err(Forward);
        }
    }
    if part.contains('+') {
        let spaces = part.replace('+', " ");
        return percent_decode_str(&spaces)
            .decode_utf8()
            .map(|value| Cow::Owned(value.into_owned()))
            .map_err(|_| Forward);
    }
    percent_decode_str(part).decode_utf8().map_err(|_| Forward)
}

fn lower_hex(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        _ => None,
    }
}
