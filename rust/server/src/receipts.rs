use std::io::{self, IoSlice};
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};

use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::sync::mpsc::UnboundedSender;

use crate::report::Event;

pub(crate) struct Receipt {
    id: u64,
    channel: UnboundedSender<Event>,
    count_on_flush: bool,
    flushed: bool,
}

impl Drop for Receipt {
    fn drop(&mut self) {
        let _ = self.channel.send(Event::Delivered {
            id: self.id,
            complete: self.flushed && self.count_on_flush,
        });
    }
}

#[derive(Clone)]
pub(crate) struct Receipts {
    awaiting_flush: Arc<Mutex<Vec<Receipt>>>,
    channel: UnboundedSender<Event>,
}

impl Receipts {
    pub fn new(channel: UnboundedSender<Event>) -> Self {
        Self {
            awaiting_flush: Arc::default(),
            channel,
        }
    }

    pub fn start(&self, id: u64) -> Receipt {
        Receipt {
            id,
            channel: self.channel.clone(),
            count_on_flush: false,
            flushed: false,
        }
    }

    pub fn ready(&self, mut receipt: Receipt, whole: bool) {
        // A complete body only counts once Hyper has flushed it to the public socket.
        receipt.count_on_flush = whole;
        self.awaiting_flush
            .lock()
            .expect("receipt lock")
            .push(receipt);
    }

    fn flush(&self) {
        for mut receipt in self.awaiting_flush.lock().expect("receipt lock").drain(..) {
            receipt.flushed = true;
            drop(receipt);
        }
    }
}

pub(crate) struct PublicStream<T> {
    stream: T,
    receipts: Receipts,
}

impl<T> PublicStream<T> {
    pub fn new(stream: T, receipts: Receipts) -> Self {
        Self { stream, receipts }
    }
}

impl<T: AsyncRead + Unpin> AsyncRead for PublicStream<T> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.stream).poll_read(cx, buffer)
    }
}

impl<T: AsyncWrite + Unpin> AsyncWrite for PublicStream<T> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.stream).poll_write(cx, bytes)
    }

    fn poll_write_vectored(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.stream).poll_write_vectored(cx, bytes)
    }

    fn is_write_vectored(&self) -> bool {
        self.stream.is_write_vectored()
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let result = Pin::new(&mut self.stream).poll_flush(cx);
        if let Poll::Ready(Ok(())) = result {
            self.receipts.flush();
        }
        result
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.stream).poll_shutdown(cx)
    }
}
