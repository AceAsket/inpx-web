use std::io::Write;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::Result;
use crate::crypto_support::Sensitive;
use crate::{profile_totp as totp, trusted_devices as trust};

#[derive(Deserialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum Request {
    Start,
    Confirm {
        file: PathBuf,
        user: String,
        secret: String,
        code: String,
        now: i64,
    },
    Enable {
        file: PathBuf,
        user: String,
        secret: String,
        last_step: i64,
    },
    Read {
        file: PathBuf,
        user: String,
        state: totp::State,
    },
    Consume {
        file: PathBuf,
        user: String,
        state: totp::State,
        code: String,
        now: i64,
        remember: Option<trust::Remember>,
    },
    Recovery {
        user: String,
    },
    Recognizes {
        devices: Vec<trust::Device>,
        token: String,
        now: i64,
    },
}

#[derive(Serialize)]
struct Accepted {
    state: totp::State,
    grant: Option<trust::Grant>,
}

pub(crate) fn execute(request: Request, output: impl Write) -> Result<()> {
    match request {
        Request::Start => write(output, &totp::start()?),
        Request::Confirm {
            file,
            user,
            secret,
            code,
            now,
        } => {
            let accepted = totp::verify(&secret, &code, -1, now)?
                .map(|step| totp::enable(&file, &user, &secret, step))
                .transpose()?;
            write(output, &accepted)
        }
        Request::Enable {
            file,
            user,
            secret,
            last_step,
        } => write(output, &totp::enable(&file, &user, &secret, last_step)?),
        Request::Read { file, user, state } => {
            let secret = totp::read_secret(&file, &user, &state)?;
            write(output, std::str::from_utf8(&secret.0)?)
        }
        Request::Consume {
            file,
            user,
            state,
            code,
            now,
            remember,
        } => {
            let Some(state) = totp::consume(&file, &user, state, &code, now)? else {
                return write(output, &Option::<Accepted>::None);
            };
            let grant = remember
                .filter(|_| totp::numeric_code(&code).is_some())
                .map(|remember| trust::issue(remember, now))
                .transpose()?;
            write(output, &Accepted { state, grant })
        }
        Request::Recovery { user } => write(output, &totp::recovery(&user)?),
        Request::Recognizes {
            devices,
            token,
            now,
        } => write(output, &trust::recognizes(&devices, &token, now)),
    }
}

fn write(mut output: impl Write, value: &(impl Serialize + ?Sized)) -> Result<()> {
    // Serialize before framing so JSON fragments do not become individual pipe messages.
    let mut bytes = Sensitive(Vec::new());
    serde_json::to_writer(&mut bytes.0, value)?;
    output.write_all(&bytes.0)?;
    Ok(())
}
