use std::path::Path;

use aws_lc_sys::{EVP_sha1, HMAC};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::Result;
use crate::crypto_support::{KEY_BYTES, Sensitive, equal, hex, parse_hex, random};
use crate::secret_store::{self, Envelope};

const ALPHABET: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const PERIOD_MS: i64 = 30_000;
const SECRET_BYTES: usize = 20;
const RECOVERY_COUNT: usize = 8;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct State {
    secret: String,
    last_step: i64,
    recovery_hashes: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Recovery {
    pub(crate) recovery_codes: Vec<String>,
    recovery_hashes: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Enrollment {
    state: State,
    recovery_codes: Vec<String>,
}

pub(crate) fn start() -> Result<String> {
    Ok(base32(&Sensitive(random::<SECRET_BYTES>()?).0))
}

fn base32(input: &[u8]) -> String {
    let mut result = String::with_capacity((input.len() * 8).div_ceil(5));
    let (mut value, mut bits) = (0_u16, 0);
    for &byte in input {
        value = (value << 8) | u16::from(byte);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            result.push(char::from(ALPHABET[usize::from((value >> bits) & 31)]));
        }
    }
    if bits != 0 {
        result.push(char::from(
            ALPHABET[usize::from((value << (5 - bits)) & 31)],
        ));
    }
    result
}

fn digit(letter: u8) -> Option<u8> {
    match letter {
        b'A'..=b'Z' => Some(letter - b'A'),
        b'2'..=b'7' => Some(letter - b'2' + 26),
        _ => None,
    }
}

fn key(secret: &str) -> Option<Sensitive<[u8; SECRET_BYTES]>> {
    if secret.len() != 32 {
        return None;
    }
    let mut result = Sensitive([0; SECRET_BYTES]);
    let (mut value, mut bits) = (0_u16, 0);
    let mut output = result.0.iter_mut();
    for byte in secret.bytes() {
        value = (value << 5) | u16::from(digit(byte)?);
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            *output.next()? = (value >> bits) as u8;
        }
    }
    Some(result)
}

pub(crate) fn numeric_code(provided: &str) -> Option<&[u8; 6]> {
    let bytes: &[u8; 6] = provided.as_bytes().try_into().ok()?;
    bytes.iter().all(u8::is_ascii_digit).then_some(bytes)
}

fn hotp(secret: &[u8; SECRET_BYTES], step: u64) -> Result<[u8; 6]> {
    let counter = step.to_be_bytes();
    let mut digest = Sensitive([0; SECRET_BYTES]);
    let mut length = 0;
    // SHA-1 writes a 20-byte digest. The key and counter are live for their exact lengths.
    let result = unsafe {
        HMAC(
            EVP_sha1(),
            secret.as_ptr().cast(),
            secret.len(),
            counter.as_ptr(),
            counter.len(),
            digest.0.as_mut_ptr(),
            &mut length,
        )
    };
    if result.is_null() || length as usize != SECRET_BYTES {
        return Err("Не удалось вычислить код двухфакторной защиты".into());
    }
    let offset = usize::from(digest.0[SECRET_BYTES - 1] & 15);
    let mut value =
        (u32::from_be_bytes(digest.0[offset..offset + 4].try_into()?) & 0x7fff_ffff) % 1_000_000;
    let mut code = [b'0'; 6];
    for byte in code.iter_mut().rev() {
        *byte += (value % 10) as u8;
        value /= 10;
    }
    Ok(code)
}

pub(crate) fn verify(secret: &str, code: &str, last_step: i64, now: i64) -> Result<Option<i64>> {
    let Some(code) = numeric_code(code) else {
        return Ok(None);
    };
    let secret = key(secret).ok_or("Некорректный секрет двухфакторной защиты")?;
    let step = now.div_euclid(PERIOD_MS);
    for candidate in [step, step - 1, step + 1] {
        if candidate >= 0 && equal(code, &hotp(&secret.0, candidate as u64)?) {
            return Ok((candidate > last_step).then_some(candidate));
        }
    }
    Ok(None)
}

fn recovery_digest(user: &str, code: &str) -> [u8; KEY_BYTES] {
    let mut sha = Sha256::new();
    sha.update(user);
    sha.update(b"\0");
    sha.update(code);
    sha.finalize().into()
}

pub(crate) fn recovery(user: &str) -> Result<Recovery> {
    let mut recovery_codes = Vec::with_capacity(RECOVERY_COUNT);
    let mut recovery_hashes = Vec::with_capacity(RECOVERY_COUNT);
    for _ in 0..RECOVERY_COUNT {
        let encoded = base32(&Sensitive(random::<12>()?).0);
        recovery_hashes.push(hex(&recovery_digest(user, &encoded)));
        recovery_codes.push(
            [
                &encoded[0..5],
                &encoded[5..10],
                &encoded[10..15],
                &encoded[15..20],
            ]
            .join("-"),
        );
    }
    Ok(Recovery {
        recovery_codes,
        recovery_hashes,
    })
}

pub(crate) fn enable(file: &Path, user: &str, secret: &str, last_step: i64) -> Result<Enrollment> {
    key(secret).ok_or("Некорректный секрет двухфакторной защиты")?;
    let recovery = recovery(user)?;
    let key = secret_store::key(file, true)?;
    let plaintext = Sensitive(format!("{user}\n{secret}").into_bytes());
    let sealed = secret_store::seal(&key.0, &plaintext.0)?;
    Ok(Enrollment {
        state: State {
            secret: std::str::from_utf8(&sealed.0)?.to_owned(),
            last_step,
            recovery_hashes: recovery.recovery_hashes,
        },
        recovery_codes: recovery.recovery_codes,
    })
}

pub(crate) fn read_secret(file: &Path, user: &str, state: &State) -> Result<Sensitive<Vec<u8>>> {
    let envelope = Envelope::parse(state.secret.as_bytes())?;
    let stored = secret_store::key(file, false)?;
    let plaintext = envelope.open(&stored.0)?;
    let secret = plaintext
        .0
        .strip_prefix(user.as_bytes())
        .and_then(|value| value.strip_prefix(b"\n"));
    let secret = secret
        .filter(|value| value.len() == 32 && value.iter().all(|byte| digit(*byte).is_some()))
        .ok_or("Секрет двухфакторной защиты повреждён")?;
    Ok(Sensitive(secret.to_vec()))
}

pub(crate) fn consume(
    file: &Path,
    user: &str,
    mut state: State,
    provided: &str,
    now: i64,
) -> Result<Option<State>> {
    if provided.encode_utf16().count() > 64 {
        return Ok(None);
    }
    if numeric_code(provided).is_some() {
        let Ok(secret) = read_secret(file, user, &state) else {
            return Ok(None);
        };
        let Some(step) = verify(
            std::str::from_utf8(&secret.0)?,
            provided,
            state.last_step,
            now,
        )?
        else {
            return Ok(None);
        };
        state.last_step = step;
        return Ok(Some(state));
    }
    let code: String = provided
        .chars()
        .filter(|&char| char != '-' && !js_space(char))
        .flat_map(char::to_uppercase)
        .collect();
    if code.len() != 20 || !code.bytes().all(|byte| digit(byte).is_some()) {
        return Ok(None);
    }
    let digest = Sensitive(recovery_digest(user, &code));
    let original = state.recovery_hashes.len();
    state.recovery_hashes.retain(|value| {
        parse_hex::<KEY_BYTES>(value).is_none_or(|expected| !equal(&digest.0, &expected))
    });
    Ok((state.recovery_hashes.len() != original).then_some(state))
}

fn js_space(value: char) -> bool {
    matches!(value,'\u{0009}'..='\u{000d}'|' '| '\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'
        |'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}')
}
