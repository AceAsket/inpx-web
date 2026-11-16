use std::io::{self, BufRead, Read, Write};

use flate2::bufread::GzDecoder;

pub(crate) fn inflate(
    mut input: impl BufRead,
    mut output: impl Write,
    limit: u64,
) -> io::Result<u64> {
    let mut bytes = 0;
    loop {
        let member = GzDecoder::new(&mut input);
        bytes += io::copy(&mut member.take(limit - bytes), &mut output)?;
        // zlib accepts zero padding at the end of a complete gzip stream.
        if bytes == limit || matches!(input.fill_buf()?.first(), None | Some(0)) {
            return Ok(bytes);
        }
    }
}
