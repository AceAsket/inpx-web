mod access_sessions;
mod enrollment;
mod web_access;

use std::cell::{Cell, RefCell};

use crate::browser_sessions::{BrowserSessions, SIGNATURE_SIZE};
use crate::login_rate::{Kind, LoginRate, METRIC_COUNT, Policy};
use crate::sessions::ProfileSessions;
use crate::totp_attempts::TotpAttempts;

thread_local! {
    static INPUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static METRICS: RefCell<[f64; METRIC_COUNT]> = const { RefCell::new([0.0; METRIC_COUNT]) };
    static RATE: RefCell<LoginRate> = RefCell::new(LoginRate::default());
    static PROFILE: RefCell<ProfileSessions> = RefCell::new(ProfileSessions::default());
    static OUTPUT_LEN: Cell<usize> = const { Cell::new(0) };
    static BROWSER: RefCell<BrowserSessions> = RefCell::new(BrowserSessions::default());
    static SIGNATURE: RefCell<[u8; SIGNATURE_SIZE]> = const { RefCell::new([0; SIGNATURE_SIZE]) };
    static TOTP: RefCell<TotpAttempts> = RefCell::new(TotpAttempts::default());
}

#[unsafe(no_mangle)]
pub extern "C" fn auth_input(size: usize) -> *mut u8 {
    INPUT.with_borrow_mut(|input| {
        input.resize(size, 0);
        input.as_mut_ptr()
    })
}

fn with_rate<R>(kind: u32, f: impl FnOnce(&mut LoginRate, Kind, &str) -> R) -> R {
    let kind = match kind {
        1 => Kind::Profile,
        2 => Kind::Opds,
        _ => Kind::Access,
    };
    INPUT.with_borrow(|input| {
        let ip = std::str::from_utf8(input).expect("host writes UTF-8");
        RATE.with_borrow_mut(|rate| f(rate, kind, ip))
    })
}

fn with_profile<R>(f: impl FnOnce(&mut ProfileSessions, &str) -> R) -> R {
    INPUT.with_borrow(|input| {
        let text = std::str::from_utf8(input).expect("host writes UTF-8");
        PROFILE.with_borrow_mut(|profiles| f(profiles, text))
    })
}

fn with_browser<R>(f: impl FnOnce(&mut BrowserSessions, &str) -> R) -> R {
    INPUT.with_borrow(|input| {
        let text = std::str::from_utf8(input).expect("host writes UTF-8");
        BROWSER.with_borrow_mut(|sessions| f(sessions, text))
    })
}

fn output(value: &str) -> *const u8 {
    // The host reads these bytes before executing another mutation.
    OUTPUT_LEN.set(value.len());
    value.as_ptr()
}

#[unsafe(no_mangle)]
pub extern "C" fn auth_output_len() -> usize {
    OUTPUT_LEN.get()
}

fn policy(enabled: u32, window: f64, max_attempts: u32) -> Policy {
    Policy {
        enabled: enabled != 0,
        window_ms: window as i64,
        max_attempts,
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn login_check(
    kind: u32,
    now: f64,
    enabled: u32,
    window: f64,
    max_attempts: u32,
    reserve: u32,
) -> u32 {
    with_rate(kind, |rate, kind, ip| {
        rate.check(
            kind,
            ip,
            now as i64,
            policy(enabled, window, max_attempts),
            reserve != 0,
        )
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn login_finish(
    kind: u32,
    now: f64,
    enabled: u32,
    window: f64,
    max_attempts: u32,
    reserved: u32,
    outcome: i32,
) {
    let outcome = match outcome {
        0 => Some(false),
        1 => Some(true),
        _ => None,
    };
    with_rate(kind, |rate, kind, ip| {
        rate.finish(
            kind,
            ip,
            now as i64,
            policy(enabled, window, max_attempts),
            reserved != 0,
            outcome,
        );
    });
}

#[unsafe(no_mangle)]
pub extern "C" fn login_metrics(now: f64, max_attempts: u32) -> *const f64 {
    let values = RATE.with_borrow_mut(|rate| rate.metrics(now as i64, max_attempts));
    METRICS.with_borrow_mut(|output| {
        *output = values.map(|value| value as f64);
        output.as_ptr()
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn profile_create(token_len: usize, now: f64) {
    with_profile(|sessions, input| {
        let (token, user) = input.split_at(token_len);
        sessions.insert(token, user.into(), now as i64);
    });
}

#[unsafe(no_mangle)]
pub extern "C" fn profile_user(now: f64) -> *const u8 {
    with_profile(|sessions, token| {
        sessions
            .with_session(token, now as i64, |user| Some(output(user)))
            .unwrap_or(std::ptr::null())
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn profile_has() -> u32 {
    with_profile(|sessions, token| u32::from(sessions.has(token)))
}

#[unsafe(no_mangle)]
pub extern "C" fn profile_delete() {
    with_profile(|sessions, token| sessions.remove(token));
}

#[unsafe(no_mangle)]
pub extern "C" fn profile_revoke(user_len: usize) {
    with_profile(|sessions, input| {
        let (user, keep) = input.split_at(user_len);
        sessions.revoke(user, keep);
    });
}

#[unsafe(no_mangle)]
pub extern "C" fn profile_clear() {
    with_profile(|sessions, token| sessions.clear_except(token));
}

#[unsafe(no_mangle)]
pub extern "C" fn profile_count() -> usize {
    PROFILE.with_borrow(ProfileSessions::len)
}

#[unsafe(no_mangle)]
pub extern "C" fn browser_key() {
    INPUT.with_borrow_mut(|input| {
        BROWSER.with_borrow_mut(|sessions| sessions.replace_key(input));
        input.fill(0);
    });
}

#[unsafe(no_mangle)]
pub extern "C" fn browser_sign() -> *const u8 {
    with_browser(|sessions, value| {
        SIGNATURE.with_borrow_mut(|slot| {
            *slot = sessions.signature(value);
            OUTPUT_LEN.set(slot.len());
            slot.as_ptr()
        })
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn browser_signature_valid(value_len: usize) -> u32 {
    with_browser(|sessions, input| {
        let (value, signature) = input.split_at(value_len);
        u32::from(sessions.verify_signature(value.as_bytes(), signature.as_bytes()))
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn browser_create(token_len: usize, now: f64) {
    with_browser(|sessions, input| {
        let (token, csrf) = input.split_at(token_len);
        sessions.create(token, csrf, now as i64);
    });
}

#[unsafe(no_mangle)]
pub extern "C" fn browser_load(token_len: usize, verify_signature: u32, now: f64) -> *const u8 {
    with_browser(|sessions, input| {
        let (token, signature) = input.split_at(token_len);
        sessions
            .load(
                token,
                (verify_signature != 0).then_some(signature.as_bytes()),
                now as i64,
                output,
            )
            .unwrap_or(std::ptr::null())
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn browser_csrf(token_len: usize) -> u32 {
    with_browser(|sessions, input| {
        let (token, csrf) = input.split_at(token_len);
        u32::from(sessions.verify_csrf(token, csrf))
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn browser_field(index: usize) -> *const u8 {
    with_browser(|sessions, token| {
        sessions
            .field(token, index)
            .map_or(std::ptr::null(), output)
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn browser_put(token_len: usize, index: usize, present: u32) {
    with_browser(|sessions, input| {
        let (token, value) = input.split_at(token_len);
        sessions.set_field(token, index, (present != 0).then_some(value));
    });
}

#[unsafe(no_mangle)]
pub extern "C" fn browser_count() -> usize {
    BROWSER.with_borrow(BrowserSessions::len)
}

fn with_totp<R>(apply: impl FnOnce(&mut TotpAttempts, &str) -> R) -> R {
    INPUT.with_borrow(|input| {
        let user = std::str::from_utf8(input).expect("host writes UTF-8");
        TOTP.with_borrow_mut(|attempts| apply(attempts, user))
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn totp_allows(now: f64) -> u32 {
    with_totp(|attempts, user| u32::from(attempts.allows(user, now as i64)))
}

#[unsafe(no_mangle)]
pub extern "C" fn totp_failed(now: f64) {
    with_totp(|attempts, user| attempts.failed(user, now as i64));
}

#[unsafe(no_mangle)]
pub extern "C" fn totp_reset() {
    with_totp(TotpAttempts::reset);
}

#[unsafe(no_mangle)]
pub extern "C" fn totp_clear() {
    TOTP.with_borrow_mut(|attempts| *attempts = TotpAttempts::default());
}
