use std::collections::HashSet;
use std::io::{ErrorKind, Read};

use serde::Deserialize;
use serde_json::{Value, value::RawValue};

use crate::fb2_prepare::js_space;
use crate::profile_store::{Account, Document, Policy};
use crate::{Result, profile_totp, trusted_devices};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot<'a> {
    #[serde(borrow, default)]
    users: Vec<&'a RawValue>,
    #[serde(default)]
    profile_auth_policy: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct User {
    #[serde(default = "default_user_id")]
    id: Value,
    #[serde(default)]
    name: Value,
    #[serde(default)]
    login: Value,
    #[serde(default)]
    password_hash: Value,
    #[serde(default)]
    is_admin: Value,
    #[serde(default)]
    blocked: Value,
    #[serde(default)]
    otp_required: Value,
    #[serde(default)]
    profile_totp: Value,
    #[serde(default)]
    profile_trusted_devices: Value,
    #[serde(default)]
    opds_enabled: Value,
    #[serde(default)]
    opds_auth_enabled: Value,
    #[serde(default)]
    opds_app_password_hash: Value,
    #[serde(default)]
    default_opds_format: Value,
    #[serde(default)]
    reader_progress_generation: Value,
    #[serde(default)]
    personal_recommendations_enabled: Value,
}

pub(crate) fn default_enabled() -> bool {
    true
}

fn default_user_id() -> Value {
    Value::String("default".into())
}

pub(crate) fn safe_integer(value: &Value) -> Option<i64> {
    let number = value.as_f64()?;
    (number.fract() == 0.0 && number.abs() <= 9_007_199_254_740_991.0).then_some(number as i64)
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null | Value::Bool(false) => false,
        Value::Number(number) => number.as_f64().is_some_and(|value| value != 0.0),
        Value::String(text) => !text.is_empty(),
        _ => true,
    }
}

pub(crate) fn text(value: &Value) -> std::result::Result<String, ()> {
    if !truthy(value) {
        return Ok(String::new());
    }
    match value {
        Value::String(value) => Ok(value.clone()),
        Value::Bool(true) => Ok("true".into()),
        Value::Number(_) => safe_integer(value).map(|value| value.to_string()).ok_or(()),
        _ => Err(()),
    }
}

impl User {
    fn normalize(self) -> std::result::Result<Option<Account>, ()> {
        let login = text(&self.login)?.trim_matches(js_space).to_lowercase();
        if !Account::valid_login(&login) {
            return Ok(None);
        }
        let raw_name = if truthy(&self.name) {
            text(&self.name)?
        } else {
            "Без профиля".into()
        };
        let name = raw_name
            .split(js_space)
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
        if name.is_empty() || name.encode_utf16().count() > 80 {
            return Ok(None);
        }
        let id = text(&self.id)?.trim_matches(js_space).to_string();
        if id.is_empty() {
            // The compatibility path handles profiles that need generated identifiers.
            return Err(());
        }
        let password_hash = text(&self.password_hash)?
            .trim_matches(js_space)
            .to_string();
        let is_admin = truthy(&self.is_admin);
        let guest = id == "default" && login.is_empty() && password_hash.is_empty();
        let blocked = self.blocked == Value::Bool(true) && !is_admin && !guest;
        let profile_totp = profile_totp::State::from_stored(&self.profile_totp);
        let profile_trusted_devices =
            if !blocked && profile_totp.is_some() && !login.is_empty() && !password_hash.is_empty()
            {
                trusted_devices::Device::from_stored(&self.profile_trusted_devices)
            } else {
                Vec::new()
            };
        Ok(Some(Account {
            id,
            name,
            login,
            password_hash,
            blocked,
            profile_totp,
            profile_trusted_devices,
            otp_required: self.otp_required == Value::Bool(true),
            is_admin,
            personal_recommendations_enabled: self.personal_recommendations_enabled != false,
            opds_enabled: self.opds_enabled != Value::Bool(false),
            opds_auth_enabled: self.opds_auth_enabled == Value::Bool(true),
            opds_app_password_hash: self
                .opds_app_password_hash
                .as_str()
                .unwrap_or_default()
                .to_owned(),
            default_opds_format: self
                .default_opds_format
                .as_str()
                .unwrap_or_default()
                .to_owned(),
            reader_progress_generation: crate::reader_state::number(
                &self.reader_progress_generation,
            )
            .max(0.0) as u64,
        }))
    }
}

pub(crate) fn read(mut reader: impl Read) -> Result<Option<Document>> {
    let mut input = String::new();
    match reader.read_to_string(&mut input) {
        Ok(_) => {}
        Err(error) if error.kind() == ErrorKind::InvalidData => return Ok(None),
        Err(error) => return Err(error.into()),
    }
    Ok(decode(&input).filter(|document| {
        document
            .users
            .first()
            .is_some_and(|(_, account)| account.bootstrapped_admin())
    }))
}

pub(crate) fn decode(input: &str) -> Option<Document> {
    let input = input.trim_matches(js_space);
    if !input.starts_with('{') {
        return None;
    }
    let snapshot = serde_json::from_str::<Snapshot<'_>>(input).ok()?;
    let mut ids = HashSet::with_capacity(snapshot.users.len());
    let mut users = Vec::with_capacity(snapshot.users.len());
    for (index, row) in snapshot.users.into_iter().enumerate() {
        if !row.get().starts_with('{') {
            return None;
        }
        let user = serde_json::from_str::<User>(row.get()).ok()?;
        if let Some(account) = user.normalize().ok()?
            && ids.insert(account.id.clone())
        {
            users.push((index, account));
        }
    }
    Some(Document {
        users,
        policy: auth_policy(&snapshot.profile_auth_policy),
    })
}

pub(crate) fn auth_policy(policy: &Value) -> Policy {
    Policy {
        otp_required: policy["otpRequired"] == true,
        trusted_browsers_enabled: policy["trustedBrowsersEnabled"].as_bool().unwrap_or(true),
        trusted_browser_days: safe_integer(&policy["trustedBrowserDays"])
            .filter(|value| (1..=180).contains(value))
            .unwrap_or(30) as u32,
    }
}
