use std::borrow::Cow;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

const SOCKET_LIMIT: usize = 8;
const SERVER_LIMIT: usize = 64;

#[derive(Clone, Copy, Deserialize)]
pub(crate) struct Limits {
    message: usize,
    preferences: usize,
    import: usize,
    backup: usize,
}

#[derive(Deserialize, Serialize)]
struct Envelope<'a> {
    #[serde(borrow)]
    action: Cow<'a, str>,
    #[serde(borrow, rename = "requestId", skip_serializing_if = "Option::is_none")]
    request_id: Option<&'a RawValue>,
}

const VALIDATE_IN_APP: u8 = 0;
const WITHIN_LIMIT: u8 = 1;
const TOO_LARGE: u8 = 2;

impl Limits {
    pub(super) fn check(self, text: &[u8]) -> (u8, Cow<'_, [u8]>) {
        let minimum = self
            .message
            .min(self.preferences)
            .min(self.import)
            .min(self.backup);
        if text.len() <= minimum {
            return (WITHIN_LIMIT, Cow::Borrowed(text));
        }
        // Preserve the application's JSON errors for envelopes Rust can't interpret.
        let object = text.iter().find(|&&byte| !byte.is_ascii_whitespace()) == Some(&b'{');
        let request = object
            .then(|| serde_json::from_slice::<Envelope<'_>>(text).ok())
            .flatten();
        let Some(request) = request else {
            return (VALIDATE_IN_APP, Cow::Borrowed(text));
        };
        let maximum = match request.action.as_ref() {
            "update-reader-preferences" | "update-user-profile" => self.preferences,
            "import-reading-lists" | "import-admin-settings" => self.import,
            "import-admin-backup" | "preview-admin-backup" => self.backup,
            _ => self.message,
        };
        if text.len() <= maximum {
            return (WITHIN_LIMIT, Cow::Borrowed(text));
        }
        match serde_json::to_vec(&request) {
            Ok(envelope) => (TOO_LARGE, Cow::Owned(envelope)),
            Err(_) => (VALIDATE_IN_APP, Cow::Borrowed(text)),
        }
    }
}

pub(super) struct Gate {
    limits: Mutex<Limits>,
    active: Arc<Semaphore>,
    large: Arc<Semaphore>,
}

impl Gate {
    pub(super) fn new(limits: Limits) -> Self {
        Self {
            limits: Mutex::new(limits),
            active: Arc::new(Semaphore::new(SERVER_LIMIT)),
            large: Arc::new(Semaphore::new(1)),
        }
    }

    pub(super) fn configure(&self, limits: Limits) {
        *self.limits.lock().expect("request limits") = limits;
    }

    pub(super) fn reserve(&self, session: &Mutex<Session>, length: usize) -> Option<(u64, Limits)> {
        let mut session = session.lock().expect("request session");
        if session.active.len() >= SOCKET_LIMIT {
            return None;
        }
        let limits = *self.limits.lock().expect("request limits");
        let active = self.active.clone().try_acquire_owned().ok()?;
        let large = if length > limits.message {
            Some(self.large.clone().try_acquire_owned().ok()?)
        } else {
            None
        };
        session.sequence += 1;
        let ticket = session.sequence;
        session.active.insert(
            ticket,
            Slot {
                _active: active,
                _large: large,
            },
        );
        Some((ticket, limits))
    }
}

struct Slot {
    _active: OwnedSemaphorePermit,
    _large: Option<OwnedSemaphorePermit>,
}

#[derive(Default)]
pub(super) struct Session {
    sequence: u64,
    active: HashMap<u64, Slot>,
}

impl Session {
    pub(super) fn finish(&mut self, ticket: u64) -> bool {
        self.active.remove(&ticket).is_some()
    }

    pub(super) fn is_idle(&self) -> bool {
        self.active.is_empty()
    }
}
