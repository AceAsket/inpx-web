pub const TOKEN_BYTES: usize = 64;
pub const SNAPSHOT_BYTES: usize = TOKEN_BYTES + 16;
pub const UPDATE_BYTES: usize = TOKEN_BYTES + 24;
pub const REMOVAL_BYTES: usize = TOKEN_BYTES + 8;
pub const COUNTS_BYTES: usize = 8;

// Counts are little-endian u32. Records use hex token bytes and little-endian f64
// for the version, last-use timestamp and use count shared with the JS host.
pub struct Counts {
    pub updates: usize,
    pub removals: usize,
}

impl Counts {
    pub fn read(bytes: &[u8; COUNTS_BYTES]) -> Self {
        Self {
            updates: u32::from_le_bytes(bytes[..4].try_into().unwrap()) as usize,
            removals: u32::from_le_bytes(bytes[4..].try_into().unwrap()) as usize,
        }
    }

    pub fn byte_len(&self) -> Option<usize> {
        self.updates
            .checked_mul(UPDATE_BYTES)?
            .checked_add(self.removals.checked_mul(REMOVAL_BYTES)?)?
            .checked_add(COUNTS_BYTES)
    }
}

pub fn token(bytes: &[u8]) -> Option<&str> {
    if bytes.len() != TOKEN_BYTES || !bytes.iter().all(|b| matches!(b,b'0'..=b'9'|b'a'..=b'f')) {
        return None;
    }
    std::str::from_utf8(bytes).ok()
}

pub fn number(bytes: &[u8]) -> Option<u64> {
    let value = f64::from_le_bytes(bytes.try_into().ok()?);
    (value.fract() == 0.0 && (0.0..=u64::MAX as f64).contains(&value)).then_some(value as u64)
}
