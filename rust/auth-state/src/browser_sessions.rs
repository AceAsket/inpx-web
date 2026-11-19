use ctutils::CtEq;
use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha256;

use crate::hex::hex32;
use crate::sessions::{SessionData, SessionTable};

pub const SIGNATURE_SIZE: usize = 64;

pub struct BrowserSession {
    csrf: Box<str>,
    signature: [u8; SIGNATURE_SIZE],
    fields: [Option<Box<str>>; 4],
}

impl SessionData for BrowserSession {}

pub struct BrowserSessions {
    signer: Hmac<Sha256>,
    sessions: SessionTable<BrowserSession>,
}

impl Default for BrowserSessions {
    fn default() -> Self {
        Self {
            signer: Self::signer(b""),
            sessions: SessionTable::default(),
        }
    }
}

impl BrowserSessions {
    fn signer(key: &[u8]) -> Hmac<Sha256> {
        Hmac::new_from_slice(key).expect("HMAC accepts all key lengths")
    }

    pub fn replace_key(&mut self, key: &[u8]) {
        self.signer = Self::signer(key);
        // Browser cookies issued under the previous key lose their sessions.
        self.sessions = SessionTable::default();
    }

    fn sign(&self, value: &[u8]) -> [u8; SIGNATURE_SIZE] {
        let mut signer = self.signer.clone();
        signer.update(value);
        hex32(&signer.finalize().into_bytes().into())
    }

    pub fn signature(&self, value: &str) -> [u8; SIGNATURE_SIZE] {
        self.sessions
            .get(value)
            .map_or_else(|| self.sign(value.as_bytes()), |session| session.signature)
    }

    pub fn verify_signature(&self, value: &[u8], signature: &[u8]) -> bool {
        bool::from(self.sign(value).as_slice().ct_eq(signature))
    }

    pub fn create(&mut self, token: &str, csrf: &str, now: i64) {
        self.sessions.insert(
            token,
            BrowserSession {
                csrf: csrf.into(),
                signature: self.sign(token.as_bytes()),
                fields: Default::default(),
            },
            now,
        );
    }

    pub fn load<R>(
        &mut self,
        token: &str,
        signature: Option<&[u8]>,
        now: i64,
        read: impl FnOnce(&str) -> R,
    ) -> Option<R> {
        self.sessions.with_session(token, now, |session| {
            if let Some(signature) = signature
                && !bool::from(session.signature.as_slice().ct_eq(signature))
            {
                return None;
            }
            Some(read(&session.csrf))
        })
    }

    pub fn verify_csrf(&self, token: &str, supplied: &str) -> bool {
        self.sessions
            .get(token)
            .is_some_and(|session| bool::from(session.csrf.as_bytes().ct_eq(supplied.as_bytes())))
    }

    pub fn field(&self, token: &str, index: usize) -> Option<&str> {
        self.sessions.get(token)?.fields.get(index)?.as_deref()
    }

    pub fn set_field(&mut self, token: &str, index: usize, value: Option<&str>) {
        if let Some(session) = self.sessions.get_mut(token)
            && let Some(field) = session.fields.get_mut(index)
        {
            *field = value.map(Box::from);
        }
    }

    pub fn len(&self) -> usize {
        self.sessions.len()
    }

    pub fn is_empty(&self) -> bool {
        self.sessions.is_empty()
    }
}
