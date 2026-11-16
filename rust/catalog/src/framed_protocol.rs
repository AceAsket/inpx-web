use serde::Serialize;
use std::io::{self, BufRead, Read, Write};

use crate::Result;

#[derive(Serialize)]
struct Completion {
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<&'static str>,
}

pub(crate) fn reply(output: &mut impl Write, result: Result<()>) -> Result<()> {
    complete(output, result.err().map(|error| error.to_string()), None)
}

pub(crate) fn complete(
    output: &mut impl Write,
    error: Option<String>,
    code: Option<&'static str>,
) -> Result<()> {
    output.write_all(&0_u32.to_le_bytes())?;
    let response = serde_json::to_vec(&Completion { error, code })?;
    output.write_all(&(response.len() as u32).to_le_bytes())?;
    output.write_all(&response)?;
    output.flush()?;
    Ok(())
}

pub(crate) fn with_body<R: BufRead, T>(
    input: &mut R,
    size: u64,
    consume: impl FnOnce(&mut io::Take<&mut R>) -> Result<T>,
) -> Result<Result<T>> {
    let mut body = input.take(size);
    let result = consume(&mut body);
    // Consume the remainder after a failed operation before reading another request.
    io::copy(&mut body, &mut io::sink())?;
    if body.limit() != 0 {
        return Err("Неполные данные запроса к Rust".into());
    }
    Ok(result)
}

pub(crate) struct Frames<W>(pub(crate) W);

impl<W: Write> Write for Frames<W> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let length = bytes.len().min(128 * 1024);
        if length != 0 {
            self.0.write_all(&(length as u32).to_le_bytes())?;
            self.0.write_all(&bytes[..length])?;
        }
        Ok(length)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.0.flush()
    }
}

pub(crate) fn header<T: serde::de::DeserializeOwned>(
    input: &mut impl BufRead,
) -> Result<Option<T>> {
    let mut line = String::new();
    input.take(64 * 1024).read_line(&mut line)?;
    if line.is_empty() {
        return Ok(None);
    }
    if !line.ends_with('\n') {
        return Err("Некорректный заголовок запроса к Rust".into());
    }
    serde_json::from_str(&line)
        .map(Some)
        .map_err(|_| "Некорректный запрос Rust-процесса".into())
}
