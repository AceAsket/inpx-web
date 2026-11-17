use std::fmt::Write;
use std::io;
use std::ptr::{self, NonNull};

use aws_lc_sys::{
    CRYPTO_memcmp, EVP_CIPHER_CTX, EVP_CIPHER_CTX_ctrl, EVP_CIPHER_CTX_free, EVP_CIPHER_CTX_new,
    EVP_CTRL_GCM_GET_TAG, EVP_CTRL_GCM_SET_TAG, EVP_CipherFinal_ex, EVP_CipherInit_ex,
    EVP_CipherUpdate, EVP_aes_256_gcm, OPENSSL_cleanse, RAND_bytes,
};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

pub(crate) const KEY_BYTES: usize = 32;
pub(crate) const NONCE_BYTES: usize = 12;
pub(crate) const TAG_BYTES: usize = 16;

pub(crate) fn md5(bytes: &[u8]) -> crate::Result<[u8; 16]> {
    let mut digest = [0; 16];
    // The legacy protocols and library archive names require MD5.
    let result = unsafe { aws_lc_sys::MD5(bytes.as_ptr(), bytes.len(), digest.as_mut_ptr()) };
    if result.is_null() {
        return Err("Не удалось вычислить MD5".into());
    }
    Ok(digest)
}
pub(crate) const BLOCK_BYTES: usize = 16;

pub(crate) fn random<const N: usize>() -> io::Result<[u8; N]> {
    let mut bytes = [0; N];
    // The whole array is writable and its length matches the AWS-LC output length.
    let ok = unsafe { RAND_bytes(bytes.as_mut_ptr(), bytes.len()) };
    check(ok, "Не удалось получить криптографическую случайность")?;
    Ok(bytes)
}

pub(crate) fn equal<const N: usize>(left: &[u8; N], right: &[u8; N]) -> bool {
    // Both fixed-size arrays are readable for N bytes.
    let differ = unsafe { CRYPTO_memcmp(left.as_ptr().cast(), right.as_ptr().cast(), N) };
    differ == 0
}

pub(crate) fn parse_hex<const N: usize>(value: &str) -> Option<[u8; N]> {
    if value.len() != 2 * N {
        return None;
    }
    let mut result = [0; N];
    for (output, piece) in result.iter_mut().zip(value.as_bytes().as_chunks::<2>().0) {
        *output = digit(piece[0])? * 16 + digit(piece[1])?;
    }
    Some(result)
}

fn digit(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        _ => None,
    }
}

pub(crate) fn append_hex(result: &mut String, bytes: &[u8]) {
    for byte in bytes {
        write!(result, "{byte:02x}").expect("writing to String cannot fail");
    }
}

pub(crate) fn hex(bytes: &[u8]) -> String {
    let mut result = String::with_capacity(bytes.len() * 2);
    append_hex(&mut result, bytes);
    result
}

pub(crate) struct Sensitive<T: AsMut<[u8]>>(pub(crate) T);

impl<T: AsMut<[u8]>> Drop for Sensitive<T> {
    fn drop(&mut self) {
        let bytes = self.0.as_mut();
        // AWS-LC erases exactly this live, exclusively borrowed byte range.
        unsafe { OPENSSL_cleanse(bytes.as_mut_ptr().cast(), bytes.len()) };
    }
}

pub(crate) struct Secret {
    bytes: Sensitive<Vec<u8>>,
}

impl Secret {
    pub(crate) fn new(value: String) -> Self {
        Self {
            bytes: Sensitive(value.into_bytes()),
        }
    }

    pub(crate) fn text(&self) -> &str {
        std::str::from_utf8(&self.bytes.0).expect("created from a UTF-8 string")
    }
}

impl<'de> Deserialize<'de> for Secret {
    fn deserialize<D: Deserializer<'de>>(input: D) -> std::result::Result<Self, D::Error> {
        String::deserialize(input).map(Self::new)
    }
}

impl Serialize for Secret {
    fn serialize<S: Serializer>(&self, output: S) -> std::result::Result<S::Ok, S::Error> {
        output.serialize_str(self.text())
    }
}

pub(crate) struct Cipher(NonNull<EVP_CIPHER_CTX>);

impl Cipher {
    pub(crate) fn new(
        key: &[u8; KEY_BYTES],
        nonce: &[u8; NONCE_BYTES],
        encrypt: bool,
    ) -> io::Result<Self> {
        // The context is uniquely owned and freed by Drop, including on initialization failure.
        let raw = unsafe { EVP_CIPHER_CTX_new() };
        let ctx =
            Self(NonNull::new(raw).ok_or_else(|| invalid("Не удалось создать контекст AES-GCM"))?);
        // AES-256-GCM expects a 32-byte key and, by default, a 12-byte nonce.
        let ok = unsafe {
            EVP_CipherInit_ex(
                raw,
                EVP_aes_256_gcm(),
                ptr::null_mut(),
                key.as_ptr(),
                nonce.as_ptr(),
                i32::from(encrypt),
            )
        };
        check(ok, "Не удалось настроить AES-GCM")?;
        Ok(ctx)
    }

    pub(crate) fn update(&mut self, input: &[u8], output: &mut [u8]) -> io::Result<usize> {
        let length =
            i32::try_from(input.len()).map_err(|_| invalid("Слишком большой блок AES-GCM"))?;
        if output.len() < input.len() + BLOCK_BYTES {
            return Err(invalid("Недостаточный буфер AES-GCM"));
        }
        let mut written = 0;
        // The buffers are disjoint and the output has room for the input plus a cipher block.
        let ok = unsafe {
            EVP_CipherUpdate(
                self.0.as_ptr(),
                output.as_mut_ptr(),
                &mut written,
                input.as_ptr(),
                length,
            )
        };
        check(ok, "Не удалось обработать блок AES-GCM")?;
        output_len(written, output.len())
    }

    pub(crate) fn finish(&mut self, output: &mut [u8; BLOCK_BYTES]) -> io::Result<usize> {
        let mut written = 0;
        // A GCM finalization writes at most one block and verifies the received tag when decrypting.
        let ok = unsafe { EVP_CipherFinal_ex(self.0.as_ptr(), output.as_mut_ptr(), &mut written) };
        check(ok, "Не удалось проверить тег AES-GCM")?;
        output_len(written, output.len())
    }

    pub(crate) fn get_tag(&mut self) -> io::Result<[u8; TAG_BYTES]> {
        let mut tag = [0; TAG_BYTES];
        self.tag(EVP_CTRL_GCM_GET_TAG, &mut tag)?;
        Ok(tag)
    }

    pub(crate) fn set_tag(&mut self, mut tag: [u8; TAG_BYTES]) -> io::Result<()> {
        self.tag(EVP_CTRL_GCM_SET_TAG, &mut tag)
    }

    fn tag(&mut self, command: i32, tag: &mut [u8; TAG_BYTES]) -> io::Result<()> {
        // The EVP GCM controls read or write exactly the specified tag buffer.
        let ok = unsafe {
            EVP_CIPHER_CTX_ctrl(
                self.0.as_ptr(),
                command,
                TAG_BYTES as i32,
                tag.as_mut_ptr().cast(),
            )
        };
        check(ok, "Не удалось обработать тег AES-GCM")
    }
}

impl Drop for Cipher {
    fn drop(&mut self) {
        // The constructor made this the sole owner of the EVP context.
        unsafe { EVP_CIPHER_CTX_free(self.0.as_ptr()) };
    }
}

fn output_len(length: i32, capacity: usize) -> io::Result<usize> {
    usize::try_from(length)
        .ok()
        .filter(|&length| length <= capacity)
        .ok_or_else(|| invalid("Некорректная длина блока AES-GCM"))
}

fn check(ok: i32, message: &str) -> io::Result<()> {
    if ok == 1 {
        Ok(())
    } else {
        Err(invalid(message))
    }
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}
