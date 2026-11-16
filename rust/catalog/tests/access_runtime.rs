use std::path::Path;

use inpx_catalog::access_runtime::{AccessCommand, AccessReply, AccessRuntime};
use sha2::{Digest, Sha256};

const PASSWORD: &str = " пароль 🙂 ";
const TIMEOUT: i64 = 60_000;
const START: i64 = 100_000;

fn open(file: &Path, password: &str) -> AccessRuntime {
    AccessRuntime::open(file, password.as_bytes(), Some(TIMEOUT))
        .unwrap()
        .unwrap()
}

fn check(runtime: &mut AccessRuntime, token: &str, now: i64) -> AccessReply {
    runtime
        .run(
            AccessCommand::Check {
                token: token.into(),
            },
            now,
        )
        .unwrap()
}

#[test]
fn native_hot_and_command_paths_share_durable_sessions() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("sessions.redb");
    let mut access = open(&file, PASSWORD);
    let fast = access.sessions();
    let AccessReply::Challenge { salt } = access
        .run(
            AccessCommand::Issue {
                client: "fixture".into(),
            },
            START,
        )
        .unwrap()
    else {
        panic!("expected challenge");
    };
    let token = format!("{:x}", Sha256::digest(format!("{PASSWORD}{salt}")));
    assert!(!fast.check_durable(&token, START));
    assert!(matches!(
        check(&mut access, &token, START),
        AccessReply::Allowed
    ));
    assert!(fast.check_durable(&token, START + 50_000));
    access.flush(START + 50_000).unwrap();
    drop(access);

    let mut access = open(&file, PASSWORD);
    let fast = access.sessions();
    assert!(fast.check_durable(&token, START + 60_000));
    access
        .run(
            AccessCommand::Revoke {
                token: token.clone(),
            },
            START + 60_000,
        )
        .unwrap();
    assert!(!fast.check_durable(&token, START + 60_000));
    assert!(matches!(
        check(&mut access, &token, START + 60_000),
        AccessReply::Denied
    ));
    drop(access);
    assert!(
        !open(&file, PASSWORD)
            .sessions()
            .check_durable(&token, START + 60_000)
    );
}

#[test]
fn native_password_grant_respects_challenge_capacity_and_rotation() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("sessions.redb");
    let mut access = open(&file, PASSWORD);
    let login = |client: &str, password: &str| AccessCommand::Login {
        client: client.into(),
        password: password.into(),
    };
    assert!(matches!(
        access.run(login("other", PASSWORD.trim()), START).unwrap(),
        AccessReply::Denied
    ));
    for _ in 0..16 {
        assert!(matches!(
            access
                .run(
                    AccessCommand::Issue {
                        client: "full".into()
                    },
                    START
                )
                .unwrap(),
            AccessReply::Challenge { .. }
        ));
    }
    assert!(matches!(
        access.run(login("full", PASSWORD), START).unwrap(),
        AccessReply::ChallengeLimit
    ));
    let AccessReply::Granted { token } = access.run(login("other", PASSWORD), START).unwrap()
    else {
        panic!("expected durable form grant");
    };
    assert!(access.sessions().check_durable(&token, START));
    drop(access);
    let mut access = open(&file, PASSWORD);
    assert!(matches!(
        check(&mut access, &token, START + TIMEOUT),
        AccessReply::Denied
    ));
    drop(access);
    assert!(
        !open(&file, "rotated")
            .sessions()
            .check_durable(&token, START)
    );
}
