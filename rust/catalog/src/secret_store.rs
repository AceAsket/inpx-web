use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::Path;

use base64::{
    Engine, alphabet,
    engine::DecodePaddingMode,
    engine::general_purpose::{GeneralPurpose, GeneralPurposeConfig, STANDARD},
};

use crate::crypto_support::{
    BLOCK_BYTES, Cipher, KEY_BYTES, NONCE_BYTES, Sensitive, TAG_BYTES, random,
};
use crate::{Result, atomic_file};

pub(crate) const PREFIX: &str = "enc:v1:";
const INVALID: &str = "Invalid encrypted secret format";
const MISSING: &str = "Secret key is missing; restore secret.key from backup";
const BASE64: GeneralPurpose = GeneralPurpose::new(
    &alphabet::STANDARD,
    GeneralPurposeConfig::new()
        .with_decode_padding_mode(DecodePaddingMode::Indifferent)
        .with_decode_allow_trailing_bits(true),
);

fn decode(value: &[u8]) -> Result<Sensitive<Vec<u8>>> {
    if let Ok(decoded) = STANDARD.decode(value) {
        return Ok(Sensitive(decoded));
    }
    // Older Node readers accepted whitespace, URL-safe letters and omitted padding.
    let normalized = Sensitive(
        value
            .iter()
            .copied()
            .filter_map(|byte| match byte {
                b'-' => Some(b'+'),
                b'_' => Some(b'/'),
                byte if byte.is_ascii_alphanumeric() || b"+/=".contains(&byte) => Some(byte),
                _ => None,
            })
            .collect::<Vec<u8>>(),
    );
    Ok(Sensitive(BASE64.decode(&normalized.0)?))
}

pub(crate) fn key(path: &Path, create: bool) -> Result<Sensitive<[u8; KEY_BYTES]>> {
    match read_key(path) {
        Err(error)
            if error
                .downcast_ref::<io::Error>()
                .is_some_and(|io| io.kind() == io::ErrorKind::NotFound) => {}
        result => return result,
    }
    if !create {
        return Err(MISSING.into());
    }
    let parent = path.parent().ok_or("Missing secret key directory")?;
    fs::create_dir_all(parent)?;
    let mut staged = tempfile::Builder::new()
        .prefix(".secret-key-")
        .tempfile_in(parent)?;
    let generated = Sensitive(random::<KEY_BYTES>()?);
    let mut encoded = Sensitive([0; 44]);
    let size = STANDARD.encode_slice(&generated.0, &mut encoded.0)?;
    staged.write_all(&encoded.0[..size])?;
    if atomic_file::publish(staged, path, None)?.is_some() {
        return Ok(generated);
    }
    read_key(path)
}

fn read_key(path: &Path) -> Result<Sensitive<[u8; KEY_BYTES]>> {
    let mut options = File::options();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_BACKUP_SEMANTICS;
        options.custom_flags(FILE_FLAG_BACKUP_SEMANTICS);
    }
    let mut file = options.open(path)?;
    let mut encoded = Sensitive(Vec::new());
    file.read_to_end(&mut encoded.0)?;
    let decoded = decode(&encoded.0).map_err(|_| "Invalid secret key length")?;
    Ok(Sensitive(
        decoded
            .0
            .as_slice()
            .try_into()
            .map_err(|_| "Invalid secret key length")?,
    ))
}

pub(crate) fn seal(key: &[u8; KEY_BYTES], plaintext: &[u8]) -> Result<Sensitive<Vec<u8>>> {
    let nonce = random::<NONCE_BYTES>()?;
    let mut cipher = Cipher::new(key, &nonce, true)?;
    let mut ciphertext = vec![0; plaintext.len() + BLOCK_BYTES];
    let written = cipher.update(plaintext, &mut ciphertext)?;
    let mut final_bytes = [0; BLOCK_BYTES];
    let tail = cipher.finish(&mut final_bytes)?;
    ciphertext.truncate(written);
    ciphertext.extend_from_slice(&final_bytes[..tail]);
    let tag = cipher.get_tag()?;
    let wrapped = format!(
        "{PREFIX}{}:{}:{}",
        STANDARD.encode(nonce),
        STANDARD.encode(tag),
        STANDARD.encode(ciphertext)
    );
    Ok(Sensitive(wrapped.into_bytes()))
}

pub(crate) struct Envelope {
    nonce: [u8; NONCE_BYTES],
    tag: [u8; TAG_BYTES],
    ciphertext: Sensitive<Vec<u8>>,
}

impl Envelope {
    pub(crate) fn parse(encoded: &[u8]) -> Result<Self> {
        let mut fields = encoded
            .strip_prefix(PREFIX.as_bytes())
            .ok_or(INVALID)?
            .split(|&byte| byte == b':');
        let mut next = || {
            fields
                .next()
                .filter(|bytes| !bytes.is_empty())
                .ok_or(INVALID)
        };
        let nonce = decode(next()?).map_err(|_| INVALID)?;
        let tag = decode(next()?).map_err(|_| INVALID)?;
        let ciphertext = decode(next()?).map_err(|_| INVALID)?;
        Ok(Self {
            nonce: nonce.0.as_slice().try_into().map_err(|_| INVALID)?,
            tag: tag.0.as_slice().try_into().map_err(|_| INVALID)?,
            ciphertext,
        })
    }

    pub(crate) fn open(self, key: &[u8; KEY_BYTES]) -> Result<Sensitive<Vec<u8>>> {
        let mut cipher = Cipher::new(key, &self.nonce, false)?;
        let mut plaintext = Sensitive(vec![0; self.ciphertext.0.len() + BLOCK_BYTES]);
        let written = cipher.update(&self.ciphertext.0, &mut plaintext.0)?;
        cipher.set_tag(self.tag)?;
        let mut final_bytes = Sensitive([0; BLOCK_BYTES]);
        let tail = cipher
            .finish(&mut final_bytes.0)
            .map_err(|_| "Unsupported state or unable to authenticate data")?;
        plaintext.0.truncate(written);
        plaintext.0.extend_from_slice(&final_bytes.0[..tail]);
        Ok(plaintext)
    }
}
