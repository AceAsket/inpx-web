use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::Result;
use crate::crypto_support::{KEY_BYTES, equal, hex, parse_hex, random};

const MAX_DEVICES: usize = 10;
const SECONDS_PER_DAY: u32 = 86_400;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Device {
    hash: String,
    expires_at: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Remember {
    devices: Vec<Device>,
    replaced: String,
    days: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Grant {
    token: String,
    max_age_seconds: u32,
    devices: Vec<Device>,
}

fn valid_token(token: &str) -> bool {
    token.len() == 64
        && token
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn digest(token: &str) -> [u8; KEY_BYTES] {
    Sha256::digest(token.as_bytes()).into()
}

pub(crate) fn recognizes(devices: &[Device], token: &str, now: i64) -> bool {
    if !valid_token(token) {
        return false;
    }
    let hash = digest(token);
    devices
        .iter()
        .skip(devices.len().saturating_sub(MAX_DEVICES))
        .any(|device| {
            device.expires_at > now
                && parse_hex::<KEY_BYTES>(&device.hash).is_some_and(|value| equal(&value, &hash))
        })
}

pub(crate) fn issue(request: Remember, now: i64) -> Result<Grant> {
    if !(1..=180).contains(&request.days) {
        return Err("Некорректный срок доверенного устройства".into());
    }
    let max_age_seconds = request.days * SECONDS_PER_DAY;
    let token = hex(&random::<32>()?);
    let replaced = valid_token(&request.replaced).then(|| hex(&digest(&request.replaced)));
    let mut devices = request.devices;
    devices.drain(..devices.len().saturating_sub(MAX_DEVICES));
    devices.retain(|device| {
        device.expires_at > now
            && valid_token(&device.hash)
            && replaced.as_ref().is_none_or(|hash| *hash != device.hash)
    });
    devices.push(Device {
        hash: hex(&digest(&token)),
        expires_at: now + i64::from(max_age_seconds) * 1000,
    });
    if devices.len() > MAX_DEVICES {
        devices.remove(0);
    }
    Ok(Grant {
        token,
        max_age_seconds,
        devices,
    })
}
