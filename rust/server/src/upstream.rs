use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use hyper::body::Incoming;
use hyper::client::conn::http1::{SendRequest, handshake};
use hyper::{Request, Response};
use hyper_util::rt::TokioIo;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;
use tokio::sync::Mutex;

pub struct Upstream {
    address: SocketAddr,
    peer: SocketAddr,
    key: Arc<str>,
    sender: Mutex<Option<SendRequest<Incoming>>>,
}

impl Upstream {
    pub fn new(address: SocketAddr, peer: SocketAddr, key: Arc<str>) -> Self {
        Self {
            address,
            peer,
            key,
            sender: Mutex::new(None),
        }
    }

    async fn connect(
        &self,
    ) -> Result<SendRequest<Incoming>, Box<dyn std::error::Error + Send + Sync>> {
        let mut stream =
            tokio::time::timeout(Duration::from_secs(5), TcpStream::connect(self.address))
                .await??;
        stream.set_nodelay(true)?;
        let preface = format!(
            "INPX1 {} {} {}\n",
            self.key,
            self.peer.ip(),
            self.peer.port()
        );
        stream.write_all(preface.as_bytes()).await?;
        let (sender, connection) = handshake(TokioIo::new(stream)).await?;
        tokio::spawn(async move {
            let _ = connection.with_upgrades().await;
        });
        Ok(sender)
    }

    pub async fn send(
        &self,
        request: Request<Incoming>,
    ) -> Result<Response<Incoming>, Box<dyn std::error::Error + Send + Sync>> {
        let mut slot = self.sender.lock().await;
        if let Some(sender) = slot.as_mut()
            && sender.ready().await.is_err()
        {
            *slot = None;
        }
        if slot.is_none() {
            *slot = Some(self.connect().await?);
        }
        // A failed write may already have reached the handler. Let the client decide whether to retry.
        Ok(slot
            .as_mut()
            .expect("connected sender")
            .send_request(request)
            .await?)
    }
}
