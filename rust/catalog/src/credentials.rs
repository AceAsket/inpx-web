use std::io::{BufRead, Read, Write};
use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::Result;
use crate::crypto_support::Sensitive;
use crate::framed_protocol::{Frames, header, reply, with_body};
use crate::{opds_password, profile_password, profile_second_factor, secret_store};

const MAX_SECRET_BYTES: u64 = 256 * 1024 * 1024;
const MAX_LOGIN_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
enum Request {
    Key {
        file: PathBuf,
        create: bool,
    },
    Secrets {
        file: PathBuf,
        encrypt: bool,
        sizes: Vec<u32>,
    },
    Hash {
        password_bytes: u32,
    },
    Verify {
        stored: String,
        login_bytes: u32,
        password_bytes: u32,
    },
    SecondFactor {
        bytes: u32,
    },
    OpdsIssue,
    OpdsVerify {
        stored: String,
    },
}

pub fn serve(mut input: impl BufRead, mut output: impl Write) -> Result<()> {
    while let Some(request) = header(&mut input)? {
        let result = {
            let mut frames = Frames(&mut output);
            match request {
                Request::Key { file, create } => {
                    secret_store::key(&file, create).and_then(|key| Ok(frames.write_all(&key.0)?))
                }
                Request::Secrets {
                    file,
                    encrypt,
                    sizes,
                } => {
                    let size: u64 = sizes.iter().map(|&size| u64::from(size)).sum();
                    if size > MAX_SECRET_BYTES || sizes.len() > 5 {
                        return Err("Слишком большой запрос к хранилищу секретов".into());
                    }
                    with_body(&mut input, size, |body| {
                        secrets(&file, encrypt, sizes, body, &mut frames)
                    })?
                }
                Request::Hash { password_bytes } => {
                    password_size(password_bytes)?;
                    with_body(&mut input, u64::from(password_bytes), |body| {
                        let value = read_bytes(body, password_bytes)?;
                        let hash = profile_password::hash(&value.0)?;
                        Ok(frames.write_all(hash.as_bytes())?)
                    })?
                }
                Request::Verify {
                    stored,
                    login_bytes,
                    password_bytes,
                } => {
                    password_size(password_bytes)?;
                    if u64::from(login_bytes) > MAX_LOGIN_BYTES {
                        return Err("Слишком длинный логин".into());
                    }
                    with_body(
                        &mut input,
                        u64::from(login_bytes) + u64::from(password_bytes),
                        |body| {
                            let login = read_bytes(body, login_bytes)?;
                            let password = read_bytes(body, password_bytes)?;
                            let accepted =
                                profile_password::verify(&stored, &login.0, &password.0)?;
                            Ok(frames.write_all(&[u8::from(accepted)])?)
                        },
                    )?
                }
                Request::SecondFactor { bytes } => {
                    if bytes > 16 * 1024 * 1024 {
                        return Err("Слишком большой запрос двухфакторной защиты".into());
                    }
                    with_body(&mut input, u64::from(bytes), |body| {
                        let payload = read_bytes(body, bytes)?;
                        let request = serde_json::from_slice(&payload.0)
                            .map_err(|_| "Некорректный запрос двухфакторной защиты")?;
                        profile_second_factor::execute(request, &mut frames)
                    })?
                }
                Request::OpdsIssue => opds_password::issue().and_then(|issued| {
                    frames.write_all(&issued.password.0)?;
                    Ok(frames.write_all(issued.hash.as_bytes())?)
                }),
                Request::OpdsVerify { stored } => {
                    let size = opds_password::PASSWORD_BYTES;
                    with_body(&mut input, size as u64, |body| {
                        let mut password = Sensitive([0; opds_password::PASSWORD_BYTES]);
                        body.read_exact(&mut password.0)?;
                        let accepted = opds_password::verify(&stored, &password.0);
                        Ok(frames.write_all(&[u8::from(accepted)])?)
                    })?
                }
            }
        };
        reply(&mut output, result)?;
    }
    Ok(())
}

fn password_size(size: u32) -> Result<()> {
    if size as usize > profile_password::MAX_PASSWORD_BYTES {
        return Err("Пароль слишком длинный".into());
    }
    Ok(())
}

fn read_bytes(input: &mut impl Read, size: u32) -> Result<Sensitive<Vec<u8>>> {
    let mut value = Sensitive(vec![0; size as usize]);
    input.read_exact(&mut value.0)?;
    Ok(value)
}

fn secrets(
    file: &Path,
    encrypt: bool,
    sizes: Vec<u32>,
    input: &mut impl Read,
    mut output: impl Write,
) -> Result<()> {
    let mut key = None;
    let mut results = Vec::with_capacity(sizes.len());
    for size in sizes {
        let value = read_bytes(input, size)?;
        let envelope = if encrypt {
            None
        } else {
            Some(secret_store::Envelope::parse(&value.0)?)
        };
        let active_key = match &key {
            Some(key) => key,
            None => key.insert(secret_store::key(file, encrypt)?),
        };
        let value = match envelope {
            Some(envelope) => envelope.open(&active_key.0)?,
            None => secret_store::seal(&active_key.0, &value.0)?,
        };
        results.push(value);
    }
    for value in results {
        output.write_all(&u32::try_from(value.0.len())?.to_le_bytes())?;
        output.write_all(&value.0)?;
    }
    Ok(())
}
