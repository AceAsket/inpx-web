use sha2::{Digest, Sha256};

use crate::Result;
use crate::crypto_support::{KEY_BYTES, Sensitive, append_hex, equal, parse_hex, random};

const PREFIX: &str = "scrypt:v1:";
const SALT_BYTES: usize = 16;
pub(crate) const MAX_PASSWORD_BYTES: usize = 4096;

pub(crate) fn hash(password: &[u8]) -> Result<String> {
    let salt = random::<SALT_BYTES>()?;
    let value = derive(password, &salt)?;
    let mut stored = String::with_capacity(PREFIX.len() + 2 * (SALT_BYTES + KEY_BYTES) + 1);
    stored.push_str(PREFIX);
    append_hex(&mut stored, &salt);
    stored.push(':');
    append_hex(&mut stored, &value.0);
    Ok(stored)
}

pub(crate) fn verify(stored: &str, login: &[u8], password: &[u8]) -> Result<bool> {
    if password.len() > MAX_PASSWORD_BYTES {
        return Ok(false);
    }
    if let Some(parameters) = stored.strip_prefix(PREFIX) {
        let Some((salt, key)) = parameters.split_once(':') else {
            return Ok(false);
        };
        let (Some(salt), Some(expected)) =
            (parse_hex::<SALT_BYTES>(salt), parse_hex::<KEY_BYTES>(key))
        else {
            return Ok(false);
        };
        return Ok(equal(&derive(password, &salt)?.0, &expected));
    }
    let Some(expected) = parse_hex::<KEY_BYTES>(stored) else {
        return Ok(false);
    };
    let mut sha = Sha256::new();
    sha.update(login);
    sha.update(b"::");
    sha.update(password);
    let actual = Sensitive(<[u8; KEY_BYTES]>::from(sha.finalize()));
    Ok(equal(&actual.0, &expected))
}

/// Runs an equivalent scrypt derivation for missing/blocked logins so response
/// timing does not easily distinguish existing usernames from absent ones.
pub(crate) fn dummy_verify(password: &[u8]) {
    if password.len() <= MAX_PASSWORD_BYTES {
        let _ = derive(password, &[0x5a; SALT_BYTES]);
    }
}

fn derive(password: &[u8], salt: &[u8; SALT_BYTES]) -> Result<Sensitive<[u8; KEY_BYTES]>> {
    if password.len() > MAX_PASSWORD_BYTES {
        return Err("Пароль слишком длинный".into());
    }
    let settings =
        scrypt::Params::new(14, 8, 5).map_err(|_| "Некорректные параметры scrypt профиля")?;
    let mut value = Sensitive([0; KEY_BYTES]);
    scrypt::scrypt(password, salt, &settings, &mut value.0)
        .map_err(|_| "Не удалось проверить пароль профиля")?;
    Ok(value)
}
