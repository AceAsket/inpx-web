use std::path::Path;
use std::sync::Mutex;

use inpx_auth_state::{totp_attempts::TotpAttempts, totp_enrollment::TotpEnrollments};
use serde_json::{Value, json};

use super::profiles::{
    self, ADMIN_ONLY, ProfileChange, ProfileSessionsChange, has_password, remove,
};
use super::{ReaderState, now, string, transfer};
use crate::{
    Result, crypto_support, opds_password, profile_decode, profile_password, profile_totp,
};
use crate::{access_runtime::now_ms, trusted_devices};

pub const INVALID_CREDENTIALS: &str = "INPX_INVALID_PROFILE_CREDENTIALS";
const RESTART: &str = "Начните настройку двухфакторной защиты заново";
const UNKNOWN: &str = "Неизвестное действие с двухфакторной защитой";

pub struct ProfileSecurity {
    signed_in: TotpEnrollments,
    required: TotpEnrollments,
}

impl Default for ProfileSecurity {
    fn default() -> Self {
        Self {
            signed_in: TotpEnrollments::new(false),
            required: TotpEnrollments::new(true),
        }
    }
}

impl ProfileSecurity {
    pub fn revoke(&mut self, owner: &str) {
        self.signed_in.revoke(owner, "");
        self.required.revoke(owner, "");
    }

    pub fn clear_required(&mut self) {
        self.required.clear_except("");
    }
}

impl ReaderState {
    pub fn profile_totp_status(&self, owner: &str, stamp: &str) -> Result<Value> {
        let snapshot = self.snapshot(stamp)?;
        let user = transfer::user(&snapshot.data, owner)?;
        let state = factor(user);
        Ok(status(
            user,
            state.as_ref(),
            profile_decode::auth_policy(&snapshot.data["profileAuthPolicy"]).otp_required,
        ))
    }

    pub fn required_profile_totp(
        &self,
        security: &mut ProfileSecurity,
        stamp: &str,
        browser: &str,
        request: &Value,
    ) -> Result<ProfileChange> {
        let mut snapshot = self.snapshot(stamp)?;
        let global = profile_decode::auth_policy(&snapshot.data["profileAuthPolicy"]).otp_required;
        let payload = &request["payload"];
        let login = profiles::login(&payload["login"]);
        let user = snapshot.data["users"]
            .as_array_mut()
            .into_iter()
            .flatten()
            .find(|user| user["blocked"] != true && !login.is_empty() && user["login"] == login)
            .ok_or(INVALID_CREDENTIALS)?;
        let password = string(&payload["password"]);
        verify_password(user, password)?;
        if !(global || user["otpRequired"] == true) || factor(user).is_some() {
            return Err("Войдите в профиль заново".into());
        }
        let owner = string(&user["id"]).to_owned();
        let operation = string(&request["operation"]);
        let now = now_ms();
        if operation == "start" {
            if !security.required.prepare(now, &owner, |_| false) {
                return Err("Повторите настройку позже".into());
            }
            let id = crypto_support::hex(&crypto_support::random::<24>()?);
            let key = format!("{browser}:{id}");
            let mut reply = start(&mut security.required, &key, &owner, &login, now)?;
            reply["enrollmentId"] = id.into();
            return Ok(ProfileChange::reply(reply));
        }
        if operation != "enable" {
            return Err(UNKNOWN.into());
        }
        let id = string(&payload["enrollmentId"]);
        if id.len() != 48 {
            return Err(RESTART.into());
        }
        let enrolled = confirm(
            &self.file.with_file_name("secret.key"),
            &mut security.required,
            &format!("{browser}:{id}"),
            &owner,
            string(&payload["code"]),
            now,
        )?;
        user["profileTotp"] = serde_json::to_value(enrolled.state)?;
        if string(&user["passwordHash"]).len() == 64 {
            user["passwordHash"] = profile_password::hash(password.as_bytes())?.into();
        }
        self.publish(snapshot, stamp)?;
        security.revoke(&owner);
        Ok(ProfileChange {
            reply: json!({"recoveryCodes":enrolled.recovery_codes}),
            sessions: ProfileSessionsChange::Login(owner),
        })
    }

    pub fn change_profile_totp(
        &self,
        security: &mut ProfileSecurity,
        attempts: &Mutex<TotpAttempts>,
        (owner, token): (&str, &str),
        stamp: &str,
        request: &Value,
        live: impl FnMut(&str) -> bool,
    ) -> Result<ProfileChange> {
        let mut snapshot = self.snapshot(stamp)?;
        let global = profile_decode::auth_policy(&snapshot.data["profileAuthPolicy"]).otp_required;
        let user = transfer::user_mut(&mut snapshot.data, owner)?;
        if !has_password(user) {
            return Err("Для защиты нужен локальный профиль с логином и паролем".into());
        }
        let payload = &request["payload"];
        verify_password(user, string(&payload["password"]))?;
        let file = self.file.with_file_name("secret.key");
        let operation = string(&request["operation"]);
        let old = factor(user);
        let code = string(&payload["code"]);
        let now = now_ms();
        if matches!(operation, "start" | "enable") && old.is_some() {
            return Err("Двухфакторная защита уже включена".into());
        }
        let mut recovery = None;
        let mut app_password = None;
        let sessions = match operation {
            "start" => {
                if !security.signed_in.prepare(now, token, live) {
                    return Err("Повторите настройку позже".into());
                }
                return start(
                    &mut security.signed_in,
                    token,
                    owner,
                    string(&user["login"]),
                    now,
                )
                .map(ProfileChange::reply);
            }
            "enable" => {
                let enrolled = confirm(&file, &mut security.signed_in, token, owner, code, now)?;
                user["profileTotp"] = serde_json::to_value(enrolled.state)?;
                recovery = Some(enrolled.recovery_codes);
                ProfileSessionsChange::KeepCurrent
            }
            "create-opds-password" | "revoke-opds-password" => {
                if operation == "create-opds-password"
                    && (user["opdsEnabled"] == false
                        || user["opdsAuthEnabled"] != true && old.is_none())
                {
                    return Err("Включите авторизацию OPDS в настройках профиля".into());
                }
                if let Some(state) = old {
                    user["profileTotp"] =
                        serde_json::to_value(consume(&file, attempts, owner, state, code, now)?)?;
                }
                if operation == "create-opds-password" {
                    let issued = opds_password::issue()?;
                    user["opdsAppPasswordHash"] = issued.hash.into();
                    app_password = Some(std::str::from_utf8(&issued.password.0)?.to_owned());
                } else {
                    remove(user, "opdsAppPasswordHash");
                }
                ProfileSessionsChange::None
            }
            "disable" | "regenerate-recovery" | "revoke-trusted-devices" => {
                let old = old.ok_or("Двухфакторная защита не включена")?;
                if operation == "disable" && (global || user["otpRequired"] == true) {
                    return Err("OTP обязателен по настройке администратора".into());
                }
                let mut state = consume(&file, attempts, owner, old, code, now)?;
                remove(user, "profileTrustedDevices");
                if operation == "disable" {
                    remove(user, "profileTotp");
                    if user["opdsAuthEnabled"] != true {
                        remove(user, "opdsAppPasswordHash");
                    }
                } else {
                    if operation == "regenerate-recovery" {
                        recovery = Some(state.regenerate(owner)?);
                    }
                    user["profileTotp"] = serde_json::to_value(state)?;
                }
                ProfileSessionsChange::KeepCurrent
            }
            _ => return Err(UNKNOWN.into()),
        };
        let mut reply = status(user, factor(user).as_ref(), global);
        if let Some(codes) = recovery {
            reply["recoveryCodes"] = json!(codes);
        }
        if let Some(password) = app_password {
            reply["opdsAppPassword"] = password.into();
        }
        self.publish(snapshot, stamp)?;
        if matches!(sessions, ProfileSessionsChange::KeepCurrent) {
            security.revoke(owner);
        }
        Ok(ProfileChange { reply, sessions })
    }

    pub fn admin_profile_security(
        &self,
        attempts: &Mutex<TotpAttempts>,
        owner: &str,
        stamp: &str,
        action: &str,
        request: &Value,
        shared_opds: bool,
    ) -> Result<ProfileChange> {
        let mut snapshot = self.snapshot(stamp)?;
        let data = &mut snapshot.data;
        let admin = transfer::user(data, owner)?;
        if !profiles::is_admin(admin) {
            return Err(ADMIN_ONLY.into());
        }
        let target = string(&request["targetUserId"]).trim();
        if action != "set-profile-auth-policy" && owner == target {
            return Err(
                "Свою двухфакторную защиту можно отключить в настройках своего профиля".into(),
            );
        }
        verify_password(admin, string(&request["password"]))?;
        let admin_totp = factor(admin)
            .map(|state| {
                consume(
                    &self.file.with_file_name("secret.key"),
                    attempts,
                    owner,
                    state,
                    string(&request["otp"]),
                    now_ms(),
                )
            })
            .transpose()?;
        let previous = profile_decode::auth_policy(&data["profileAuthPolicy"]);
        let result = match action {
            "set-profile-auth-policy" => {
                let days = profile_decode::safe_integer(&request["trustedBrowserDays"])
                    .filter(|days| (1..=180).contains(days));
                let (Some(required), Some(trust), Some(days)) = (
                    request["otpRequired"].as_bool(),
                    request["trustedBrowsersEnabled"].as_bool(),
                    days,
                ) else {
                    return Err("Срок доверия должен быть целым числом от 1 до 180 дней".into());
                };
                let activating = required && !previous.otp_required;
                if activating {
                    if admin_totp.is_none() {
                        return Err("Сначала настройте OTP в своём профиле".into());
                    }
                    let missing: Vec<_> = super::shelves::items(&data["users"])
                        .iter()
                        .filter(|user| !has_password(user) && !profiles::anonymous(user))
                        .map(|user| string(&user["name"]))
                        .collect();
                    if !missing.is_empty() {
                        let names = missing[..missing.len().min(5)].join(", ");
                        let more = if missing.len() > 5 {
                            format!(" и ещё {}", missing.len() - 5)
                        } else {
                            String::new()
                        };
                        return Err(
                            format!("Укажите логин и пароль для профилей: {names}{more}").into(),
                        );
                    }
                }
                if trust != previous.trusted_browsers_enabled
                    || days != i64::from(previous.trusted_browser_days)
                {
                    for user in data["users"].as_array_mut().into_iter().flatten() {
                        remove(user, "profileTrustedDevices");
                    }
                }
                let policy = json!({"otpRequired":required,"trustedBrowsersEnabled":trust,"trustedBrowserDays":days});
                data["profileAuthPolicy"] = policy.clone();
                ProfileChange {
                    reply: json!({"profileAuthPolicy":policy}),
                    sessions: if activating {
                        ProfileSessionsChange::KeepCurrentOnly
                    } else if previous.otp_required != required {
                        ProfileSessionsChange::RefreshScope(None)
                    } else {
                        ProfileSessionsChange::None
                    },
                }
            }
            "reset-user-profile-totp" | "set-user-profile-totp-required" => {
                let users = data["users"]
                    .as_array_mut()
                    .ok_or("Некорректный файл профилей")?;
                let index = profiles::target_index(users, target)?;
                let user = &mut users[index];
                if action == "reset-user-profile-totp" {
                    if factor(user).is_none() {
                        return Err("У профиля не включена двухфакторная защита".into());
                    }
                    if user["opdsEnabled"] != false && has_password(user) {
                        user["opdsAuthEnabled"] = true.into();
                        if shared_opds {
                            user["opdsEnabled"] = false.into();
                        }
                    }
                    for field in [
                        "profileTotp",
                        "profileTrustedDevices",
                        "opdsAppPasswordHash",
                    ] {
                        remove(user, field);
                    }
                    user["updatedAt"] = now().into();
                    ProfileChange {
                        reply: json!({"userId":target,"otpEnabled":false,"otpRequired":user["otpRequired"]==true,
                            "opdsAppPasswordSet":false,"opdsEnabled":user["opdsEnabled"]!=false,"opdsAuthEnabled":user["opdsAuthEnabled"]==true}),
                        sessions: ProfileSessionsChange::Revoke(target.into()),
                    }
                } else {
                    let required = request["required"]
                        .as_bool()
                        .ok_or("Укажите требование OTP")?;
                    if required && !has_password(user) {
                        return Err(
                            "Для обязательного OTP у профиля должны быть логин и пароль".into()
                        );
                    }
                    let changed = (user["otpRequired"] == true) != required;
                    if changed {
                        if required {
                            user["otpRequired"] = true.into();
                            remove(user, "profileTrustedDevices");
                        } else {
                            remove(user, "otpRequired");
                        }
                        user["updatedAt"] = now().into();
                    }
                    ProfileChange {
                        reply: json!({"userId":target,"otpRequired":required,"otpEnabled":factor(user).is_some()}),
                        sessions: if changed && required {
                            ProfileSessionsChange::Revoke(target.into())
                        } else if changed {
                            ProfileSessionsChange::RefreshScope(Some(target.into()))
                        } else {
                            ProfileSessionsChange::None
                        },
                    }
                }
            }
            _ => return Err(UNKNOWN.into()),
        };
        if let Some(state) = admin_totp {
            transfer::user_mut(data, owner)?["profileTotp"] = serde_json::to_value(state)?;
        }
        self.publish(snapshot, stamp)?;
        Ok(result)
    }
}

fn verify_password(user: &Value, password: &str) -> Result<()> {
    if !has_password(user)
        || !profile_password::verify(
            string(&user["passwordHash"]),
            string(&user["login"]).as_bytes(),
            password.as_bytes(),
        )?
    {
        return Err(INVALID_CREDENTIALS.into());
    }
    Ok(())
}

fn factor(user: &Value) -> Option<profile_totp::State> {
    profile_totp::State::from_stored(&user["profileTotp"])
}

fn status(user: &Value, factor: Option<&profile_totp::State>, global: bool) -> Value {
    json!({"otpEnabled":factor.is_some(),"otpRequired":global || user["otpRequired"]==true,
        "recoveryCodesRemaining":factor.map_or(0, profile_totp::State::remaining),
        "opdsAppPasswordSet":!string(&user["opdsAppPasswordHash"]).is_empty(),
        "hasPassword":has_password(user),"trustedDeviceCount":trusted_devices::Device::active_count(&user["profileTrustedDevices"],now_ms())})
}

fn start(
    pending: &mut TotpEnrollments,
    key: &str,
    owner: &str,
    login: &str,
    now: i64,
) -> Result<Value> {
    let secret = crypto_support::Secret::new(profile_totp::start()?);
    if !pending.create(key, owner, secret.text(), now) {
        return Err("Повторите настройку позже".into());
    }
    Ok(json!({"secret":secret.text(),
        "otpAuthUri":format!("otpauth://totp/inpx-web:{login}?secret={}&issuer=inpx-web&algorithm=SHA1&digits=6&period=30",secret.text())}))
}

fn confirm(
    file: &Path,
    pending: &mut TotpEnrollments,
    key: &str,
    owner: &str,
    code: &str,
    now: i64,
) -> Result<profile_totp::Enrollment> {
    let confirmed = pending
        .secret(key, owner, now, |secret| -> Result<_> {
            profile_totp::verify(secret, code, -1, now)?
                .map(|step| profile_totp::enable(file, owner, secret, step))
                .transpose()
        })
        .ok_or(RESTART)??;
    let Some(confirmed) = confirmed else {
        pending.failed(key, owner);
        return Err(INVALID_CREDENTIALS.into());
    };
    Ok(confirmed)
}

fn consume(
    file: &Path,
    attempts: &Mutex<TotpAttempts>,
    owner: &str,
    state: profile_totp::State,
    code: &str,
    now: i64,
) -> Result<profile_totp::State> {
    let mut attempts = attempts.lock().expect("TOTP attempts");
    if !attempts.allows(owner, now) {
        return Err(INVALID_CREDENTIALS.into());
    }
    if let Some(state) = profile_totp::consume(file, owner, state, code, now)? {
        attempts.reset(owner);
        Ok(state)
    } else {
        attempts.failed(owner, now);
        Err(INVALID_CREDENTIALS.into())
    }
}
