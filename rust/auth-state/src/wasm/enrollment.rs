use std::cell::RefCell;

use super::{INPUT, PROFILE, output};
use crate::totp_enrollment::TotpEnrollments;

thread_local! {
    static ENROLLMENTS: RefCell<[TotpEnrollments; 2]> = RefCell::new([TotpEnrollments::new(false), TotpEnrollments::new(true)]);
}

fn with_enrollment<R>(required: u32, apply: impl FnOnce(&mut TotpEnrollments, &str) -> R) -> R {
    INPUT.with_borrow(|input| {
        let text = std::str::from_utf8(input).expect("host writes UTF-8");
        ENROLLMENTS.with_borrow_mut(|rows| apply(&mut rows[usize::from(required != 0)], text))
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn enrollment_prepare(required: u32, now: f64) -> u32 {
    with_enrollment(required, |rows, key| {
        PROFILE.with_borrow(|profiles| {
            u32::from(rows.prepare(now as i64, key, |token| profiles.has(token)))
        })
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn enrollment_create(
    required: u32,
    key_len: usize,
    user_len: usize,
    now: f64,
) -> u32 {
    INPUT.with_borrow_mut(|input| {
        let (key, rest) = input.split_at_mut(key_len);
        let (user, secret) = rest.split_at_mut(user_len);
        let key = std::str::from_utf8(key).expect("host writes UTF-8");
        let user = std::str::from_utf8(user).expect("host writes UTF-8");
        let value = std::str::from_utf8(secret).expect("host writes UTF-8");
        let saved = ENROLLMENTS.with_borrow_mut(|rows| {
            rows[usize::from(required != 0)].create(key, user, value, now as i64)
        });
        secret.fill(0);
        u32::from(saved)
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn enrollment_secret(required: u32, key_len: usize, now: f64) -> *const u8 {
    with_enrollment(required, |rows, input| {
        let (key, user) = input.split_at(key_len);
        rows.secret(key, user, now as i64, output)
            .unwrap_or(std::ptr::null())
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn enrollment_failed(required: u32, key_len: usize) {
    with_enrollment(required, |rows, input| {
        let (key, user) = input.split_at(key_len);
        rows.failed(key, user);
    });
}

#[unsafe(no_mangle)]
pub extern "C" fn enrollment_has(required: u32) -> u32 {
    with_enrollment(required, |rows, key| u32::from(rows.has(key)))
}

#[unsafe(no_mangle)]
pub extern "C" fn enrollment_delete(required: u32) {
    with_enrollment(required, |rows, key| rows.remove(key));
}

#[unsafe(no_mangle)]
pub extern "C" fn enrollment_revoke(required: u32, user_len: usize) {
    with_enrollment(required, |rows, input| {
        let (user, keep) = input.split_at(user_len);
        rows.revoke(user, keep);
    });
}

#[unsafe(no_mangle)]
pub extern "C" fn enrollment_clear(required: u32) {
    with_enrollment(required, |rows, keep| rows.clear_except(keep));
}
