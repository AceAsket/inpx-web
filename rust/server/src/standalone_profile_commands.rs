use std::collections::HashMap;

use inpx_auth_state::login_rate::Kind;
use inpx_catalog::reader_state::{INVALID_CREDENTIALS, ProfileChange, ProfileSessionsChange};
use serde_json::{Value, json};

use super::{
    Access, BLOCKED_PROFILE, BrowserAccess, BrowserProfileRequest, Identity, PROXY_SCOPE, State,
    bound_profile, now_ms, profile_scope,
};
use crate::request_access::Admission;

impl Access {
    pub(crate) fn profile_settings(
        &self,
        access: &BrowserAccess,
        owner: &str,
    ) -> inpx_catalog::Result<Value> {
        self.state
            .lock()
            .map_err(|_| "Хранилище профилей недоступно")?
            .reader
            .profile_settings(owner, &access.stamp)
    }

    pub(crate) fn profile_command(
        &self,
        query: BrowserProfileRequest<'_>,
        admission: &Admission,
        binding: bool,
        root: &str,
        action: &str,
        request: &Value,
    ) -> inpx_catalog::Result<Value> {
        let operation = text(request, "operation");
        if binding {
            match action {
                "profile-totp-enrollment" | "set-user-profile-totp-required" => {
                    return Err("Настройте второй фактор у провайдера SSO".into());
                }
                "set-profile-auth-policy" => {
                    return Err("Настройте защиту входа у провайдера SSO".into());
                }
                _ => (),
            }
        }
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Хранилище профилей недоступно")?;
        let browser = self
            .sessions
            .load(query.browser, query.token)
            .ok_or("need_profile_login")?;
        let profiles = state.profiles.browser_profiles(&self.file)?;
        let bound = bound_profile(&profiles, query.proxy_login).map_err(|_| BLOCKED_PROFILE)?;
        let required = action == "profile-totp-enrollment";
        let (owner, token) = if required {
            ("", "")
        } else if let Some(profile) = bound {
            if !profile_scope(profile, query.user) {
                return Err(PROXY_SCOPE.into());
            }
            if action == "profile-totp" && operation != "status" {
                return Err("Настройте второй фактор у провайдера SSO".into());
            }
            if action == "update-user-profile"
                && request["targetUserId"] == profile.id
                && request["profile"].get("login").is_some_and(|value| {
                    value.as_str().unwrap_or_default().trim().to_lowercase() != profile.login
                })
            {
                return Err("Логин профиля закреплён за пользователем proxy".into());
            }
            (profile.id.as_str(), "")
        } else if let Some((token, identity)) = browser.profile.as_ref() {
            let current = profiles
                .users
                .iter()
                .find(|profile| {
                    profile.id == identity.owner
                        && profile.credential_version == identity.credential_version
                })
                .ok_or("need_profile_login")?;
            if !profile_scope(current, query.user) {
                return Err("need_profile_login".into());
            }
            (current.id.as_str(), token.as_str())
        } else if !self.require_profile
            && !profiles.require_otp
            && query.token.is_empty()
            && (action == "update-user-profile"
                || action == "profile-totp" && operation == "status")
        {
            let current = profiles
                .users
                .iter()
                .find(|profile| {
                    profile.id == query.user
                        && !profile.is_admin
                        && !profile.anonymous_profile
                        && !profile.requires_login
                        && !profile.otp_required
                })
                .ok_or("need_profile_login")?;
            (current.id.as_str(), "")
        } else {
            return Err("need_profile_login".into());
        };
        if action == "profile-totp" && operation == "status" {
            return state.reader.profile_totp_status(owner, &profiles.stamp);
        }
        let rate_limited = matches!(
            action,
            "profile-totp-enrollment"
                | "profile-totp"
                | "set-profile-auth-policy"
                | "set-user-profile-totp-required"
                | "reset-user-profile-totp"
        );
        let peer = admission.client.to_string();
        if rate_limited {
            let retry = state
                .attempts
                .check(Kind::Profile, &peer, now_ms(), self.policy, true);
            if retry != 0 {
                return Ok(
                    json!({"error":"Слишком много попыток входа. Повторите позже.",
                    "errorCode":"INPX_LOGIN_RATE_LIMIT","retryAfterMs":u64::from(retry)*1000}),
                );
            }
        }
        let State {
            reader,
            profile_security,
            ..
        } = &mut *state;
        let stamp = &profiles.stamp;
        let result = match action {
            "profile-totp-enrollment" => {
                reader.required_profile_totp(profile_security, stamp, query.browser, request)
            }
            "profile-totp" => reader.change_profile_totp(
                profile_security,
                &self.totp,
                (owner, token),
                stamp,
                request,
                |token| self.sessions.has_profile(token),
            ),
            "set-profile-auth-policy"
            | "set-user-profile-totp-required"
            | "reset-user-profile-totp" => reader.admin_profile_security(
                &self.totp,
                owner,
                stamp,
                action,
                request,
                self.opds().shared.is_some(),
            ),
            _ => reader.manage_profile(owner, stamp, action, request, root),
        };
        let invalid = result
            .as_ref()
            .is_err_and(|error| error.to_string() == INVALID_CREDENTIALS);
        if rate_limited {
            let success = result.as_ref().is_ok_and(|change| {
                !required || matches!(change.sessions, ProfileSessionsChange::Login(_))
            });
            state.attempts.finish(
                Kind::Profile,
                &peer,
                now_ms(),
                self.policy,
                self.policy.enabled,
                if invalid {
                    Some(false)
                } else {
                    success.then_some(true)
                },
            );
        }
        if invalid {
            return Ok(
                json!({"error":"Неверный логин или пароль","errorCode":INVALID_CREDENTIALS}),
            );
        }
        let ProfileChange {
            mut reply,
            sessions,
        } = result?;
        if action == "set-profile-auth-policy" && request["otpRequired"] == false {
            state.profile_security.clear_required();
        }
        match sessions {
            ProfileSessionsChange::None => (),
            ProfileSessionsChange::Revoke(user) => {
                state.profile_security.revoke(&user);
                self.totp.lock().expect("TOTP attempts").reset(&user);
                self.sessions.revoke_owner(&user);
            }
            ProfileSessionsChange::KeepCurrent | ProfileSessionsChange::KeepCurrentOnly => {
                let identity = self.find_identity(&mut state, owner)?;
                self.sessions.refresh_profile(
                    token,
                    identity,
                    matches!(sessions, ProfileSessionsChange::KeepCurrent),
                    matches!(sessions, ProfileSessionsChange::KeepCurrentOnly),
                );
            }
            ProfileSessionsChange::RefreshScope(scope) => {
                let latest = state.profiles.browser_profiles(&self.file)?;
                let old: HashMap<_, _> = profiles
                    .users
                    .iter()
                    .map(|row| (row.id.as_str(), row.credential_version))
                    .collect();
                let versions = latest
                    .users
                    .iter()
                    .filter(|row| scope.as_ref().is_none_or(|id| *id == row.id))
                    .filter_map(|row| {
                        Some((
                            row.id.as_str(),
                            (*old.get(row.id.as_str())?, row.credential_version),
                        ))
                    })
                    .collect();
                self.sessions.refresh_credentials(&versions);
                if let Some(owner) = scope {
                    state.profile_security.revoke(&owner);
                }
            }
            ProfileSessionsChange::Login(owner) => {
                let identity = self.find_identity(&mut state, &owner)?;
                self.sessions.revoke_owner(&owner);
                let token = self.sessions.login(query.browser, identity)?;
                reply["userId"] = owner.into();
                reply["profileAccessToken"] = token.into();
            }
        }
        Ok(reply)
    }

    fn find_identity(&self, state: &mut State, owner: &str) -> inpx_catalog::Result<Identity> {
        let profiles = state.profiles.browser_profiles(&self.file)?;
        let profile = profiles
            .users
            .iter()
            .find(|profile| profile.id == owner)
            .ok_or("need_profile_login")?;
        Ok(Identity {
            owner: owner.into(),
            credential_version: profile.credential_version,
        })
    }
}

fn text<'a>(request: &'a Value, field: &str) -> &'a str {
    request[field].as_str().unwrap_or_default()
}
