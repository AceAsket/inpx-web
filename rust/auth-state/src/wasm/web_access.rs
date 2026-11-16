use std::cell::RefCell;

use super::{INPUT, OUTPUT_LEN, SIGNATURE};
use crate::web_access_challenges::{Issue, WebAccessChallenges};

#[link(wasm_import_module = "inpx")]
unsafe extern "C" {
    fn random_fill(pointer: *mut u8, length: usize) -> u32;
}

thread_local! {
    static WEB_CHALLENGES: RefCell<WebAccessChallenges> = RefCell::new(WebAccessChallenges::default());
}

fn challenge_entropy() -> Option<[u8; 32]> {
    let mut bytes = [0; 32];
    // The host fills this writable array synchronously using the OS CSPRNG.
    let filled = unsafe { random_fill(bytes.as_mut_ptr(), bytes.len()) };
    (filled != 0).then_some(bytes)
}

#[unsafe(no_mangle)]
pub extern "C" fn challenge_issue(client_len: usize, now: f64, timeout: f64) -> isize {
    INPUT.with_borrow_mut(|input| {
        let (client, password) = input.split_at_mut(client_len);
        let client = std::str::from_utf8(client).expect("host writes UTF-8");
        let issued = WEB_CHALLENGES.with_borrow_mut(|rows| {
            rows.issue(
                client,
                password,
                now as i64,
                timeout.ceil() as i64,
                challenge_entropy,
            )
        });
        password.fill(0);
        match issued {
            Issue::Limited => 0,
            Issue::EntropyUnavailable => -1,
            Issue::Salt(salt) => SIGNATURE.with_borrow_mut(|slot| {
                *slot = salt;
                OUTPUT_LEN.set(slot.len());
                slot.as_ptr() as isize
            }),
        }
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn challenge_take(now: f64) -> u32 {
    INPUT.with_borrow(|input| {
        let token = std::str::from_utf8(input).expect("host writes UTF-8");
        u32::from(take_pending(token, now as i64))
    })
}

pub(super) fn take_pending(token: &str, now: i64) -> bool {
    WEB_CHALLENGES.with_borrow_mut(|rows| rows.take(token, now))
}

#[unsafe(no_mangle)]
pub extern "C" fn challenge_remove() {
    INPUT.with_borrow(|input| {
        let token = std::str::from_utf8(input).expect("host writes UTF-8");
        remove_pending(token);
    });
}

pub(super) fn remove_pending(token: &str) {
    WEB_CHALLENGES.with_borrow_mut(|rows| rows.remove(token));
}

#[unsafe(no_mangle)]
pub extern "C" fn challenge_prune(now: f64) {
    prune_pending(now as i64);
}

pub(super) fn prune_pending(now: i64) {
    WEB_CHALLENGES.with_borrow_mut(|rows| rows.prune(now));
}

#[unsafe(no_mangle)]
pub extern "C" fn challenge_count() -> usize {
    WEB_CHALLENGES.with_borrow(WebAccessChallenges::len)
}
