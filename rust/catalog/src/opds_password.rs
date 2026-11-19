use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use sha2::{Digest, Sha256};

use crate::Result;
use crate::crypto_support::{KEY_BYTES, Sensitive, equal, hex, parse_hex, random};

const PREFIX: &[u8] = b"inpx_";
pub(crate) const PASSWORD_BYTES: usize = PREFIX.len() + 32;

pub(crate) struct Issued {
    pub(crate) password: Sensitive<[u8; PASSWORD_BYTES]>,
    pub(crate) hash: String,
}

pub(crate) fn issue() -> Result<Issued> {
    let secret = Sensitive(random::<24>()?);
    let mut password = Sensitive([0; PASSWORD_BYTES]);
    let (prefix, token) = password.0.split_at_mut(PREFIX.len());
    prefix.copy_from_slice(PREFIX);
    URL_SAFE_NO_PAD.encode_slice(secret.0, token)?;
    let hash = hex(&Sha256::digest(password.0));
    Ok(Issued { password, hash })
}

pub(crate) fn verify(stored: &str, password: &[u8]) -> bool {
    if password.len() != PASSWORD_BYTES
        || !password.strip_prefix(PREFIX).is_some_and(|token| {
            token
                .iter()
                .all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(byte))
        })
    {
        return false;
    }
    parse_hex::<KEY_BYTES>(stored)
        .is_some_and(|expected| equal(&Sha256::digest(password).into(), &expected))
}
