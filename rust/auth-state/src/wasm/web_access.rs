use std::cell::RefCell;

use super::{INPUT, OUTPUT_LEN, RATE, SIGNATURE, access_sessions::issue_verified, policy};
use crate::web_access_challenges::{Issue, WebAccessChallenges};
use crate::{hex::hex32, library_password::LibraryPassword, login_rate::Kind};

#[link(wasm_import_module = "inpx")]
unsafe extern "C" {
    fn random_fill(pointer: *mut u8, length: usize) -> u32;
}

thread_local! {
    static WEB_CHALLENGES: RefCell<WebAccessChallenges> = RefCell::new(WebAccessChallenges::default());
    static PASSWORD: RefCell<Option<LibraryPassword>> = const {RefCell::new(None)};
    static LOGIN_REPLY: RefCell<[u8; 80]> = const {RefCell::new([0; 80])};
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
        issue_reply(issued)
    })
}

fn signature_reply(value: [u8; 64]) -> *const u8 {
    SIGNATURE.with_borrow_mut(|slot| {
        *slot = value;
        OUTPUT_LEN.set(slot.len());
        slot.as_ptr()
    })
}

fn issue_reply(issued: Issue) -> isize {
    match issued {
        Issue::Limited => 0,
        Issue::EntropyUnavailable => -1,
        Issue::Salt(salt) => signature_reply(salt) as isize,
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn library_password_configure() -> *const u8 {
    INPUT.with_borrow_mut(|input| {
        let password = LibraryPassword::new(input);
        input.fill(0);
        let fingerprint = password.fingerprint();
        PASSWORD.with_borrow_mut(|current| *current = Some(password));
        signature_reply(fingerprint)
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn library_challenge_issue(now: f64, timeout: f64) -> isize {
    INPUT.with_borrow(|input| {
        let client = std::str::from_utf8(input).expect("host writes UTF-8");
        PASSWORD.with_borrow(|configured| {
            let Some(password) = configured else {
                return -1;
            };
            let result = WEB_CHALLENGES.with_borrow_mut(|rows| {
                rows.issue_configured(
                    client,
                    password,
                    now as i64,
                    timeout.ceil() as i64,
                    challenge_entropy,
                )
            });
            issue_reply(result)
        })
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn library_socket_attempt(
    now: f64,
    enabled: u32,
    window: f64,
    max_attempts: u32,
    success: u32,
) -> u32 {
    INPUT.with_borrow(|input| {
        let ip = std::str::from_utf8(input).expect("host writes UTF-8");
        let policy = policy(enabled, window, max_attempts);
        RATE.with_borrow_mut(|rate| {
            if success == 0 {
                let retry = rate.check(Kind::Access, ip, now as i64, policy, false);
                if retry != 0 {
                    return retry;
                }
            }
            rate.finish(
                Kind::Access,
                ip,
                now as i64,
                policy,
                false,
                Some(success != 0),
            );
            0
        })
    })
}

enum LoginStatus {
    IncorrectPassword = 0,
    Granted = 1,
    RateLimited = 2,
    Unavailable = 3,
    TooManyChallenges = 4,
}

fn login_reply(status: LoginStatus, retry: u32, grant: Option<(u64, [u8; 64])>) -> *const u8 {
    LOGIN_REPLY.with_borrow_mut(|reply| {
        reply[..4].copy_from_slice(&(status as u32).to_le_bytes());
        reply[4..8].copy_from_slice(&retry.to_le_bytes());
        if let Some((version, token)) = grant {
            reply[8..16].copy_from_slice(&(version as f64).to_le_bytes());
            reply[16..].copy_from_slice(&token);
        } else {
            reply[8..].fill(0);
        }
        reply.as_ptr()
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn library_password_login(
    client_len: usize,
    now: f64,
    enabled: u32,
    window: f64,
    max_attempts: u32,
) -> *const u8 {
    INPUT.with_borrow_mut(|input| {
        let (client, supplied) = input.split_at_mut(client_len);
        let client = std::str::from_utf8(client).expect("host writes UTF-8");
        let ip = if client.is_empty() { "unknown" } else { client };
        let now = now as i64;
        let policy = policy(enabled, window, max_attempts);
        let retry = RATE.with_borrow_mut(|rate| rate.check(Kind::Access, ip, now, policy, false));
        if retry != 0 {
            supplied.fill(0);
            return login_reply(LoginStatus::RateLimited, retry, None);
        }
        let valid = PASSWORD.with_borrow(|current| {
            current
                .as_ref()
                .is_some_and(|password| password.verify(supplied))
        });
        supplied.fill(0);
        RATE.with_borrow_mut(|rate| rate.finish(Kind::Access, ip, now, policy, false, Some(valid)));
        if !valid {
            return login_reply(LoginStatus::IncorrectPassword, 0, None);
        }
        if !WEB_CHALLENGES.with_borrow_mut(|rows| rows.has_capacity(client, now)) {
            return login_reply(LoginStatus::TooManyChallenges, 0, None);
        }
        let Some(random) = challenge_entropy() else {
            return login_reply(LoginStatus::Unavailable, 0, None);
        };
        let token = hex32(&random);
        let token_text = std::str::from_utf8(&token).expect("hex is ASCII");
        let Some(version) = issue_verified(token_text, now) else {
            return login_reply(LoginStatus::Unavailable, 0, None);
        };
        login_reply(LoginStatus::Granted, 0, Some((version, token)))
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
