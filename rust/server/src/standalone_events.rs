use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};

use serde_json::{Value, json};
use tokio::sync::broadcast;

use super::State;
use crate::request_access::Admission;

pub(super) struct Events {
    tx: broadcast::Sender<Arc<Event>>,
    next: AtomicU64,
}

pub(super) struct Event {
    pub(super) kind: &'static str,
    pub(super) origin: Option<u64>,
    pub(super) owner: String,
    pub(super) book_uid: String,
}

pub(super) enum Change {
    Unchanged,
    Clear,
    Subscribe(Subscription),
}

pub(super) struct Subscription {
    pub(super) owner: String,
    pub(super) token: String,
    pub(super) library_token: String,
}

impl Events {
    pub(super) fn new() -> Self {
        let (tx, _) = broadcast::channel(128);
        Self {
            tx,
            next: AtomicU64::new(0),
        }
    }

    pub(super) fn connect(&self) -> u64 {
        self.next.fetch_add(1, Ordering::Relaxed)
    }

    pub(super) fn subscribe(&self) -> broadcast::Receiver<Arc<Event>> {
        self.tx.subscribe()
    }

    pub(super) fn send(
        &self,
        kind: &'static str,
        origin: Option<u64>,
        owner: &str,
        book_uid: &str,
    ) {
        if self.tx.receiver_count() > 0 {
            let mut length = 0;
            let book_uid: String = book_uid
                .chars()
                .take_while(|ch| {
                    length += ch.len_utf16();
                    length <= 1024
                })
                .collect();
            let _ = self.tx.send(Arc::new(Event {
                kind,
                origin,
                owner: owner.into(),
                book_uid,
            }));
        }
    }
}

impl Subscription {
    pub(super) async fn authorized(
        self: Arc<Self>,
        state: Arc<State>,
        browser: String,
        admission: Arc<Admission>,
    ) -> bool {
        tokio::task::spawn_blocking(move || {
            state
                .access
                .library
                .allowed(&self.library_token)
                .unwrap_or(false)
                && state
                    .access
                    .browser(&browser, &self.token, admission.proxy_login.as_deref())
                    .is_ok_and(|access| {
                        access.owner.as_deref() == Some(self.owner.as_str())
                            && access.token == self.token
                    })
        })
        .await
        .unwrap_or(false)
    }
}

impl Event {
    pub(super) fn message(&self) -> Value {
        json!({"type":"client-event","kind":self.kind,"bookUid": self.book_uid})
    }
}
