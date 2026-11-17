use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::Result;
use crate::crypto_support::{KEY_BYTES, equal, hex, parse_hex, random};

const MAX_DEVICES: usize = 10;
const SECONDS_PER_DAY: u32 = 86_400;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Device {
    hash: String,
    expires_at: i64,
}

impl Device {
    pub(crate) fn active_count(value: &serde_json::Value, now: i64) -> usize {
        Self::from_stored(value)
            .iter()
            .filter(|device| device.expires_at > now)
            .count()
    }

    pub(crate) fn from_stored(value: &serde_json::Value) -> Vec<Self> {
        let Some(rows) = value.as_array() else {
            return Vec::new();
        };
        rows[rows.len().saturating_sub(MAX_DEVICES)..]
            .iter()
            .filter_map(|row| {
                let hash = row["hash"].as_str().filter(|hash| valid_token(hash))?;
                let expires_at = crate::profile_decode::safe_integer(&row["expiresAt"])?;
                Some(Self {
                    hash: hash.into(),
                    expires_at,
                })
            })
            .collect()
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Remember {
    pub(crate) devices: Vec<Device>,
    pub(crate) replaced: String,
    pub(crate) days: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Grant {
    pub(crate) token: String,
    pub(crate) max_age_seconds: u32,
    pub(crate) devices: Vec<Device>,
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
