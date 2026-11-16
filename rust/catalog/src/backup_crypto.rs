use std::io::{self, Read, Write};

use crate::crypto_support::{
    BLOCK_BYTES, Cipher, KEY_BYTES, NONCE_BYTES, Sensitive, TAG_BYTES, random,
};

pub(crate) const MAGIC: &[u8; 8] = b"INPXWEB1";
pub(crate) const SALT_BYTES: usize = 16;
const HEADER_BYTES: usize = MAGIC.len() + SALT_BYTES + NONCE_BYTES;
pub(crate) const OVERHEAD: usize = HEADER_BYTES + TAG_BYTES;
pub(crate) const MAX_PASSWORD_BYTES: usize = 3 * 1024;
const PASSWORD_ERROR: &str = "Пароль резервной копии должен содержать от 10 до 1024 символов";
const INVALID_ARCHIVE: &str = "Зашифрованная резервная копия повреждена";
const AUTHENTICATION_ERROR: &str = "Неверный пароль резервной копии или файл повреждён";
const CHUNK_BYTES: usize = 128 * 1024;

pub(crate) fn derive(
    password: &[u8],
    salt: &[u8; SALT_BYTES],
) -> io::Result<Sensitive<[u8; KEY_BYTES]>> {
    let characters = std::str::from_utf8(password)
        .map_err(|_| invalid(PASSWORD_ERROR))?
        .encode_utf16()
        .count();
    if !(10..=1024).contains(&characters) {
        return Err(invalid(PASSWORD_ERROR));
    }
    let mut key = Sensitive([0; KEY_BYTES]);
    let settings =
        scrypt::Params::new(15, 8, 1).map_err(|_| invalid("Некорректные параметры scrypt"))?;
    scrypt::scrypt(password, salt, &settings, &mut key.0)
        .map_err(|_| invalid("Не удалось получить ключ резервной копии"))?;
    Ok(key)
}

pub(crate) struct Encrypt<W> {
    output: W,
    cipher: Cipher,
    buffer: Sensitive<Vec<u8>>,
}

impl<W: Write> Encrypt<W> {
    pub(crate) fn new(
        mut output: W,
        key: &[u8; KEY_BYTES],
        salt: &[u8; SALT_BYTES],
    ) -> io::Result<Self> {
        let nonce = random::<NONCE_BYTES>()?;
        let cipher = Cipher::new(key, &nonce, true)?;
        output.write_all(MAGIC)?;
        output.write_all(salt)?;
        output.write_all(&nonce)?;
        Ok(Self {
            output,
            cipher,
            buffer: Sensitive(vec![0; CHUNK_BYTES + BLOCK_BYTES]),
        })
    }

    pub(crate) fn finish(mut self) -> io::Result<()> {
        let mut final_bytes = [0; BLOCK_BYTES];
        let written = self.cipher.finish(&mut final_bytes)?;
        let tag = self.cipher.get_tag()?;
        self.output.write_all(&final_bytes[..written])?;
        self.output.write_all(&tag)?;
        self.output.flush()
    }
}

impl<W: Write> Write for Encrypt<W> {
    fn write(&mut self, data: &[u8]) -> io::Result<usize> {
        if data.is_empty() {
            return Ok(0);
        }
        let length = data.len().min(CHUNK_BYTES);
        let written = self.cipher.update(&data[..length], &mut self.buffer.0)?;
        self.output.write_all(&self.buffer.0[..written])?;
        Ok(length)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.output.flush()
    }
}

pub(crate) fn decrypt(
    mut input: impl Read,
    length: u64,
    password: &[u8],
    mut destination: impl Write,
) -> io::Result<()> {
    let mut remaining = length
        .checked_sub(OVERHEAD as u64)
        .ok_or_else(|| invalid(INVALID_ARCHIVE))?;
    let mut header = [0; HEADER_BYTES];
    input.read_exact(&mut header)?;
    if &header[..MAGIC.len()] != MAGIC {
        return Err(invalid(INVALID_ARCHIVE));
    }
    let salt = header[MAGIC.len()..MAGIC.len() + SALT_BYTES]
        .try_into()
        .unwrap();
    let nonce = header[MAGIC.len() + SALT_BYTES..].try_into().unwrap();
    let key = derive(password, salt)?;
    let mut cipher = Cipher::new(&key.0, nonce, false)?;
    drop(key);
    let mut ciphertext = vec![0; remaining.min(CHUNK_BYTES as u64) as usize];
    let mut plaintext = Sensitive(vec![0; ciphertext.len() + BLOCK_BYTES]);
    while remaining != 0 {
        let count = remaining.min(ciphertext.len() as u64) as usize;
        input.read_exact(&mut ciphertext[..count])?;
        let written = cipher.update(&ciphertext[..count], &mut plaintext.0)?;
        destination.write_all(&plaintext.0[..written])?;
        remaining -= count as u64;
    }
    let mut tag = [0; TAG_BYTES];
    input.read_exact(&mut tag)?;
    cipher.set_tag(tag)?;
    let mut final_bytes = Sensitive([0; BLOCK_BYTES]);
    let written = cipher
        .finish(&mut final_bytes.0)
        .map_err(|_| invalid(AUTHENTICATION_ERROR))?;
    destination.write_all(&final_bytes.0[..written])?;
    destination.flush()
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}
