use std::fs::File;
use std::io::{BufWriter, ErrorKind, Read, Write};
use std::path::{Path, PathBuf};

use indexmap::IndexMap;
use serde::{Deserialize, Deserializer, Serialize, Serializer, ser::SerializeMap};
use serde_json::value::RawValue;

use crate::file_stamp::stamp;
use crate::{Result, atomic_file, profile_decode, profile_snapshot, profile_totp, trusted_devices};

pub(crate) const CHANGED: &str = "Файл профилей изменился, повторите операцию";

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Account {
    pub(crate) id: String,
    #[serde(default)]
    pub(crate) name: String,
    pub(crate) login: String,
    pub(crate) password_hash: String,
    #[serde(default)]
    pub(crate) blocked: bool,
    #[serde(default)]
    pub(crate) otp_required: bool,
    pub(crate) profile_totp: Option<profile_totp::State>,
    #[serde(default)]
    pub(crate) profile_trusted_devices: Vec<trusted_devices::Device>,
    #[serde(default)]
    pub(crate) is_admin: bool,
    #[serde(default)]
    pub(crate) opds_enabled: bool,
    #[serde(default)]
    pub(crate) opds_auth_enabled: bool,
    #[serde(default)]
    pub(crate) opds_app_password_hash: String,
    #[serde(default)]
    pub(crate) default_opds_format: String,
    #[serde(default)]
    pub(crate) reader_progress_generation: u64,
    #[serde(default = "crate::profile_decode::default_enabled")]
    pub(crate) personal_recommendations_enabled: bool,
}

impl Account {
    pub(crate) fn bootstrapped_admin(&self) -> bool {
        self.is_admin
            && !self.opds_enabled
            && !self.opds_auth_enabled
            && !self.login.is_empty()
            && !self.password_hash.is_empty()
    }

    pub(crate) fn valid_login(login: &str) -> bool {
        login.is_empty()
            || (3..=64).contains(&login.len())
                && login
                    .bytes()
                    .all(|b| matches!(b,b'a'..=b'z'|b'0'..=b'9'|b'.'|b'_'|b'-'))
    }
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Policy {
    pub(crate) otp_required: bool,
    pub(crate) trusted_browsers_enabled: bool,
    pub(crate) trusted_browser_days: u32,
}

pub(crate) struct Document {
    pub(crate) users: Vec<(usize, Account)>,
    pub(crate) policy: Policy,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialPatch {
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) profile_totp: Option<Option<profile_totp::State>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) password_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) profile_trusted_devices: Option<Vec<trusted_devices::Device>>,
}

fn present<'de, T: Deserialize<'de>, D: Deserializer<'de>>(
    input: D,
) -> std::result::Result<Option<T>, D::Error> {
    T::deserialize(input).map(Some)
}

impl CredentialPatch {
    pub(crate) fn is_empty(&self) -> bool {
        self.profile_totp.is_none()
            && self.password_hash.is_none()
            && self.profile_trusted_devices.is_none()
    }
}

pub(crate) enum Lookup<'a> {
    Legacy,
    Missing,
    Changed,
    Found(&'a Account, Policy, Position),
}

pub(crate) enum CredentialUpdate {
    Stored,
    Legacy,
    Missing,
    Changed,
}

pub(crate) struct Position {
    pub(crate) stamp: String,
    pub(crate) index: usize,
}

pub(crate) enum Snapshot<'a> {
    Ready(&'a Document, &'a str),
    Legacy,
    Changed,
}

struct Cached {
    path: PathBuf,
    stamp: String,
    document: Option<Document>,
}

#[derive(Default)]
pub struct Store {
    cached: Option<Cached>,
}

impl Store {
    pub(crate) fn lookup(&mut self, path: &Path, login: &str) -> Result<Lookup<'_>> {
        self.find(path, |account| account.login == login)
    }

    fn find(&mut self, path: &Path, matches: impl Fn(&Account) -> bool) -> Result<Lookup<'_>> {
        let (document, stamp) = match self.snapshot(path)? {
            Snapshot::Ready(document, stamp) => (document, stamp),
            Snapshot::Legacy => return Ok(Lookup::Legacy),
            Snapshot::Changed => return Ok(Lookup::Changed),
        };
        let Some((index, account)) = document.users.iter().find(|(_, account)| matches(account))
        else {
            return Ok(Lookup::Missing);
        };
        Ok(Lookup::Found(
            account,
            document.policy,
            Position {
                stamp: stamp.into(),
                index: *index,
            },
        ))
    }

    pub(crate) fn snapshot(&mut self, path: &Path) -> Result<Snapshot<'_>> {
        let Some(expected) = atomic_file::current_stamp(path)? else {
            self.cached = None;
            return Ok(Snapshot::Legacy);
        };
        if self
            .cached
            .as_ref()
            .is_none_or(|cache| cache.path != path || cache.stamp != expected)
        {
            let file = match File::open(path) {
                Ok(file) => file,
                Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Snapshot::Changed),
                Err(error) => return Err(error.into()),
            };
            if stamp(&file)?.to_string() != expected {
                return Ok(Snapshot::Changed);
            }
            self.cached = Some(Cached {
                path: path.into(),
                stamp: expected,
                document: profile_decode::read(file)?,
            });
        }
        let cache = self.cached.as_ref().expect("checked cached profile file");
        Ok(match &cache.document {
            Some(document) => Snapshot::Ready(document, &cache.stamp),
            None => Snapshot::Legacy,
        })
    }

    pub(crate) fn finish_login(
        &mut self,
        path: &Path,
        position: Position,
        patch: Option<&impl Serialize>,
    ) -> Result<String> {
        if let Some(patch) = patch {
            let file = publish_credentials(path, &position, patch, &[])?.ok_or(CHANGED)?;
            self.cached = None;
            return Ok(stamp(&file)?.to_string());
        } else if atomic_file::current_stamp(path)?.as_deref() != Some(&position.stamp) {
            return Err(CHANGED.into());
        }
        Ok(position.stamp)
    }

    pub(crate) fn update_credentials(
        &mut self,
        path: &Path,
        expected: Option<&str>,
        user: &str,
        mut patch: CredentialPatch,
    ) -> Result<CredentialUpdate> {
        if atomic_file::current_stamp(path)?.as_deref() != expected {
            return Ok(CredentialUpdate::Changed);
        }
        let (account, position) = match self.find(path, |account| account.id == user)? {
            Lookup::Found(account, _, position) => (account, position),
            Lookup::Legacy => return Ok(CredentialUpdate::Legacy),
            Lookup::Missing => return Ok(CredentialUpdate::Missing),
            Lookup::Changed => return Ok(CredentialUpdate::Changed),
        };
        if Some(position.stamp.as_str()) != expected {
            return Ok(CredentialUpdate::Changed);
        }
        patch.password_hash = patch
            .password_hash
            .filter(|password| !password.is_empty())
            .map(|password| password.trim_matches(crate::fb2_prepare::js_space).into());
        let sign_in_configured = !account.login.is_empty()
            && !patch
                .password_hash
                .as_deref()
                .unwrap_or(&account.password_hash)
                .is_empty();
        let has_totp = patch
            .profile_totp
            .as_ref()
            .map_or(account.profile_totp.is_some(), Option::is_some);
        let mut remove = Vec::new();
        if matches!(patch.profile_totp, Some(None)) {
            remove.push("profileTotp");
            patch.profile_totp = None;
        }
        if !has_totp
            || !sign_in_configured
            || account.blocked
            || patch
                .profile_trusted_devices
                .as_ref()
                .is_some_and(Vec::is_empty)
        {
            remove.push("profileTrustedDevices");
            patch.profile_trusted_devices = None;
        }
        if !account.opds_enabled || !sign_in_configured || !has_totp && !account.opds_auth_enabled {
            remove.push("opdsAppPasswordHash");
        }
        if publish_credentials(path, &position, &patch, &remove)?.is_none() {
            return Ok(CredentialUpdate::Changed);
        }
        self.cached = None;
        Ok(CredentialUpdate::Stored)
    }
}

fn publish_credentials(
    path: &Path,
    position: &Position,
    patch: &impl Serialize,
    remove: &[&str],
) -> Result<Option<File>> {
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if stamp(&file)?.to_string() != position.stamp {
        return Ok(None);
    }
    let mut input = String::new();
    file.read_to_string(&mut input)?;
    drop(file);

    let root: IndexMap<String, &RawValue> =
        serde_json::from_str(input.trim_matches(crate::fb2_prepare::js_space))?;
    let mut users: Vec<&RawValue> = serde_json::from_str(root.get("users").ok_or(CHANGED)?.get())?;
    let row = users.get_mut(position.index).ok_or(CHANGED)?;
    let mut account: IndexMap<String, &RawValue> = serde_json::from_str(row.get())?;
    for field in remove {
        account.shift_remove(*field);
    }
    let encoded = serde_json::value::to_raw_value(patch)?;
    account.extend(serde_json::from_str::<IndexMap<String, &RawValue>>(
        encoded.get(),
    )?);
    let updated = serde_json::value::to_raw_value(&account)?;
    *row = &updated;

    publish_users(path, Some(&position.stamp), root, &users)
}

// The root preserves the journal checkpoint and unrelated fields during profile writes.
pub(crate) fn publish_users(
    path: &Path,
    expected: Option<&str>,
    root: IndexMap<String, &RawValue>,
    users: &[&RawValue],
) -> Result<Option<File>> {
    let mut staged = profile_snapshot::stage(path)?;
    {
        let mut output = BufWriter::new(staged.as_file_mut());
        let mut serializer = serde_json::Serializer::new(&mut output);
        let has_users = root.contains_key("users");
        let mut document = serializer.serialize_map(Some(root.len() + usize::from(!has_users)))?;
        for (key, value) in root {
            if key == "users" {
                document.serialize_entry(&key, users)?;
            } else {
                document.serialize_entry(&key, value)?;
            }
        }
        if !has_users {
            document.serialize_entry("users", users)?;
        }
        document.end()?;
        output.flush()?;
    }
    atomic_file::publish(staged, path, expected)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn credential_update_does_not_overwrite_a_newer_snapshot() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let path = dir.path().join("reading-lists.json");
        let original = json!({
            "version": 5,
            "readerProgressCheckpoint": "0".repeat(32),
            "profileAuthPolicy": {"otpRequired": false, "trustedBrowsersEnabled": true, "trustedBrowserDays": 30},
            "users": [{"id": "admin", "name": "Administrator", "login": "admin",
                "isAdmin": true, "passwordHash": "old-hash", "opdsEnabled": false, "opdsAuthEnabled": false}]
        });
        std::fs::write(&path, original.to_string())?;
        let mut store = Store::default();
        let Lookup::Found(_, _, position) = store.lookup(&path, "admin")? else {
            panic!("expected the current snapshot to be readable");
        };

        let mut replacement = original;
        replacement["users"][0]["passwordHash"] = json!("newer-password-hash");
        std::fs::write(&path, replacement.to_string())?;
        let result = store.finish_login(
            &path,
            position,
            Some(&json!({"passwordHash": "stale-hash"})),
        );
        assert_eq!(result.unwrap_err().to_string(), CHANGED);
        assert_eq!(std::fs::read_to_string(&path)?, replacement.to_string());
        let Lookup::Found(account, _, _) = store.lookup(&path, "admin")? else {
            panic!("expected the replacement to be readable");
        };
        assert_eq!(account.password_hash, "newer-password-hash");
        Ok(())
    }
}
