use std::cell::RefCell;

use super::{
    INPUT, OUTPUT_LEN,
    web_access::{prune_pending, remove_pending, take_pending},
};
use crate::web_access_sessions::{Access, SessionValue, WebAccessSessions};

const TOKEN_BYTES: usize = 64;
// Counts are little-endian u32. A row contains the hex token followed by little-endian f64 fields.
const LOAD_BYTES: usize = TOKEN_BYTES + 16;
const REFRESH_BYTES: usize = TOKEN_BYTES + 24;
const REMOVAL_BYTES: usize = TOKEN_BYTES + 8;

thread_local! {
    static SESSIONS: RefCell<WebAccessSessions> = RefCell::new(WebAccessSessions::default());
    static GRANT: RefCell<[f64; 2]> = const { RefCell::new([0.0; 2]) };
    static BATCH: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

fn with_session<R>(f: impl FnOnce(&mut WebAccessSessions, &str) -> R) -> R {
    INPUT.with_borrow(|input| {
        let token = std::str::from_utf8(input).expect("host writes UTF-8");
        SESSIONS.with_borrow_mut(|sessions| f(sessions, token))
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn access_configure(timeout: f64) {
    let timeout = if timeout == 0.0 {
        None
    } else if timeout.is_nan() {
        Some(i64::MIN)
    } else {
        Some(timeout.ceil() as i64)
    };
    SESSIONS.with_borrow_mut(|sessions| *sessions = WebAccessSessions::new(timeout));
}

#[unsafe(no_mangle)]
pub extern "C" fn access_restore() -> u32 {
    INPUT.with_borrow(|input| {
        let (rows, trailing) = input.as_chunks::<LOAD_BYTES>();
        if !trailing.is_empty()
            || rows.iter().any(|row| {
                !row[..TOKEN_BYTES]
                    .iter()
                    .all(|byte| matches!(byte,b'0'..=b'9'|b'a'..=b'f'))
            })
        {
            return 0;
        }
        SESSIONS.with_borrow_mut(|sessions| {
            for row in rows {
                let token = std::str::from_utf8(&row[..TOKEN_BYTES]).expect("validated hex");
                let time = f64::from_le_bytes(row[TOKEN_BYTES..TOKEN_BYTES + 8].try_into().unwrap())
                    as i64;
                let used = f64::from_le_bytes(row[TOKEN_BYTES + 8..].try_into().unwrap()) as u64;
                sessions.restore(token, SessionValue { time, used });
            }
        });
        1
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn access_use(now: f64) -> f64 {
    with_session(|sessions, token| {
        let now = now as i64;
        match sessions.use_token(token, now, || take_pending(token, now)) {
            Access::Denied => 0.0,
            Access::Allowed => 1.0,
            Access::Save(version) => version as f64,
        }
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn access_grant(version: f64) -> *const f64 {
    with_session(|sessions, token| {
        let Some(value) = sessions.grant(token, version as u64) else {
            return std::ptr::null();
        };
        GRANT.with_borrow_mut(|output| {
            *output = [value.time as f64, value.used as f64];
            output.as_ptr()
        })
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn access_finish_grant(version: f64, saved_used: f64) -> u32 {
    with_session(|sessions, token| {
        u32::from(sessions.finish_grant(token, version as u64, saved_used as u64))
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn access_revoke() -> f64 {
    with_session(|sessions, token| {
        remove_pending(token);
        sessions.revoke(token).unwrap_or_default() as f64
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn access_finish_revocation(version: f64) {
    with_session(|sessions, token| sessions.finish_revocation(token, version as u64));
}

#[unsafe(no_mangle)]
pub extern "C" fn access_retry(version: f64) {
    with_session(|sessions, token| sessions.retry_refresh(token, version as u64));
}

#[unsafe(no_mangle)]
pub extern "C" fn access_count() -> usize {
    SESSIONS.with_borrow(WebAccessSessions::len)
}

#[unsafe(no_mangle)]
pub extern "C" fn access_collect(now: f64) -> *const u8 {
    prune_pending(now as i64);
    let changes = SESSIONS.with_borrow_mut(|sessions| sessions.collect(now as i64));
    if changes.updates.is_empty() && changes.removals.is_empty() {
        return std::ptr::null();
    }
    BATCH.with_borrow_mut(|output| {
        output.clear();
        output.reserve(
            8 + changes.updates.len() * REFRESH_BYTES + changes.removals.len() * REMOVAL_BYTES,
        );
        output.extend_from_slice(&(changes.updates.len() as u32).to_le_bytes());
        output.extend_from_slice(&(changes.removals.len() as u32).to_le_bytes());
        for row in changes.updates {
            output.extend_from_slice(row.token.as_bytes());
            output.extend_from_slice(&(row.version as f64).to_le_bytes());
            output.extend_from_slice(&(row.value.time as f64).to_le_bytes());
            output.extend_from_slice(&(row.value.used as f64).to_le_bytes());
        }
        for row in changes.removals {
            output.extend_from_slice(row.token.as_bytes());
            output.extend_from_slice(&(row.version as f64).to_le_bytes());
        }
        OUTPUT_LEN.set(output.len());
        output.as_ptr()
    })
}
