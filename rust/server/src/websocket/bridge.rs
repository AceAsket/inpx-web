use std::io;

use crate::profile_sessions::{MAX_PROOF_USER, Proof};
use bytes::{Buf, Bytes, BytesMut};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufWriter};
use tokio_tungstenite::tungstenite::{Message, protocol::CloseFrame};

pub(super) const TEXT: u8 = 1;
pub(super) const BINARY: u8 = 2;
pub(super) const REQUEST: u8 = 3;
const CLOSE: u8 = 8;
const COMPLETE: u8 = 9;
const TERMINATE: u8 = 10;
pub(super) const PEER_CLOSED: u8 = 11;
const HEADER: usize = 5;
const REQUEST_PREFIX: usize = 9;
const PROFILE_PREFIX: usize = 17;
const EXTENDED_PREFIX: usize = REQUEST_PREFIX + PROFILE_PREFIX + MAX_PROOF_USER;

pub(super) enum Packet {
    Message(Message),
    Complete(u64),
    Terminate,
}

pub(super) struct Reader<R> {
    input: R,
    buffer: BytesMut,
}

impl<R: AsyncRead + Unpin> Reader<R> {
    pub(super) fn new(input: R) -> Self {
        Self {
            input,
            buffer: BytesMut::with_capacity(8192),
        }
    }

    pub(super) async fn read_packet(&mut self) -> io::Result<Option<Packet>> {
        loop {
            if self.buffer.len() >= HEADER {
                let size =
                    u32::from_le_bytes(self.buffer[1..HEADER].try_into().expect("frame length"))
                        as usize;
                if self.buffer.len() - HEADER >= size {
                    let kind = self.buffer[0];
                    self.buffer.advance(HEADER);
                    let data = self.buffer.split_to(size).freeze();
                    let message = match kind {
                        TEXT => Message::Text(data.try_into().map_err(io::Error::other)?),
                        BINARY => Message::Binary(data),
                        CLOSE if data.is_empty() => Message::Close(None),
                        CLOSE if data.len() >= 2 => Message::Close(Some(CloseFrame {
                            code: u16::from_be_bytes([data[0], data[1]]).into(),
                            reason: data.slice(2..).try_into().map_err(io::Error::other)?,
                        })),
                        COMPLETE if data.len() == 8 => {
                            let ticket =
                                u64::from_le_bytes(data[..].try_into().expect("ticket size"));
                            return Ok(Some(Packet::Complete(ticket)));
                        }
                        TERMINATE if data.is_empty() => return Ok(Some(Packet::Terminate)),
                        _ => {
                            return Err(io::Error::new(
                                io::ErrorKind::InvalidData,
                                "invalid private WebSocket message",
                            ));
                        }
                    };
                    return Ok(Some(Packet::Message(message)));
                }
            }
            if self.buffer.len() == self.buffer.capacity() {
                self.buffer.reserve(8192);
            }
            if self.input.read_buf(&mut self.buffer).await? == 0 {
                return if self.buffer.is_empty() {
                    Ok(None)
                } else {
                    Err(io::Error::new(
                        io::ErrorKind::UnexpectedEof,
                        "incomplete private WebSocket message",
                    ))
                };
            }
        }
    }
}

pub(super) struct Writer<W> {
    output: BufWriter<W>,
    header: [u8; HEADER + EXTENDED_PREFIX],
    start: usize,
    end: usize,
    payload: Bytes,
}

impl<W: AsyncWrite + Unpin> Writer<W> {
    pub(super) fn new(output: W) -> Self {
        Self {
            output: BufWriter::with_capacity(16 * 1024, output),
            header: [0; HEADER + EXTENDED_PREFIX],
            start: 0,
            end: 0,
            payload: Bytes::new(),
        }
    }

    pub(super) async fn request(
        &mut self,
        ticket: u64,
        validation: u8,
        payload: Bytes,
        profile: Option<Proof>,
    ) -> io::Result<()> {
        let mut prefix = [0; EXTENDED_PREFIX];
        prefix[..8].copy_from_slice(&ticket.to_le_bytes());
        prefix[8] = validation;
        let mut end = REQUEST_PREFIX;
        if let Some(profile) = profile {
            prefix[8] |= 8;
            prefix[9..17].copy_from_slice(&profile.revision.to_le_bytes());
            prefix[17..25].copy_from_slice(&profile.deadline.to_le_bytes());
            prefix[25] = profile.user.len() as u8;
            end += PROFILE_PREFIX + profile.user.len();
            prefix[26..end].copy_from_slice(profile.user.as_bytes());
        }
        self.send(REQUEST, &prefix[..end], payload).await
    }

    pub(super) async fn send(&mut self, kind: u8, prefix: &[u8], payload: Bytes) -> io::Result<()> {
        let length = u32::try_from(prefix.len() + payload.len()).map_err(io::Error::other)?;
        self.header[0] = kind;
        self.header[1..HEADER].copy_from_slice(&length.to_le_bytes());
        self.start = 0;
        self.end = HEADER + prefix.len();
        self.header[HEADER..self.end].copy_from_slice(prefix);
        self.payload = payload;
        self.flush().await
    }

    // A public close can interrupt a private write. Retain the remainder so the
    // close notification is sent after that request and arrives on a frame boundary.
    pub(super) async fn flush(&mut self) -> io::Result<()> {
        while self.start < self.end {
            let written = self
                .output
                .write(&self.header[self.start..self.end])
                .await?;
            if written == 0 {
                return Err(io::ErrorKind::WriteZero.into());
            }
            self.start += written;
        }
        self.output.write_all_buf(&mut self.payload).await?;
        self.output.flush().await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn interrupted_request_is_flushed_before_the_close_notification() {
        let (output, mut input) = tokio::io::duplex(8);
        let mut writer = Writer::new(output);
        let payload = Bytes::from_static(b"{\"action\":\"test\"}");
        let mut received = Vec::new();
        tokio::select! {
            result = writer.request(17,1,payload.clone(),None) => panic!("write should still be pending: {result:?}"),
            first = input.read_u8() => received.push(first.unwrap()),
        }
        let notify = async {
            writer.flush().await.unwrap();
            writer.send(PEER_CLOSED, &[], Bytes::new()).await.unwrap();
            drop(writer);
        };
        let receive = input.read_to_end(&mut received);
        let (_, result) = tokio::join!(notify, receive);
        result.unwrap();
        let mut expected = vec![REQUEST];
        expected.extend_from_slice(&((payload.len() + 9) as u32).to_le_bytes());
        expected.extend_from_slice(&17_u64.to_le_bytes());
        expected.push(1);
        expected.extend_from_slice(&payload);
        expected.extend_from_slice(&[PEER_CLOSED, 0, 0, 0, 0]);
        assert_eq!(received, expected);
    }
}
