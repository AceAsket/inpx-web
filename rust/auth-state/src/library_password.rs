use ctutils::CtEq;
use sha2::{Digest, Sha256};

use crate::hex::hex32;

pub struct LibraryPassword {
    prepared: Sha256,
    digest: [u8; 32],
}

impl LibraryPassword {
    pub fn new(password: &[u8]) -> Self {
        let mut prepared = Sha256::new();
        prepared.update(password);
        let digest = prepared.clone().finalize().into();
        Self { prepared, digest }
    }

    pub fn fingerprint(&self) -> [u8; 64] {
        hex32(&self.digest)
    }

    pub fn verify(&self, password: &[u8]) -> bool {
        let actual: [u8; 32] = Sha256::digest(password).into();
        bool::from(self.digest.ct_eq(&actual))
    }

    pub(crate) fn challenge(&self, salt: &[u8; 64]) -> [u8; 64] {
        let mut hash = self.prepared.clone();
        hash.update(salt);
        hex32(&hash.finalize().into())
    }
}
