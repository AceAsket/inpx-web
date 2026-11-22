//! Keep native children tied to the Android service, including abrupt system termination.
use std::io;
use std::os::unix::process::CommandExt;
use std::process::Command;

fn watch(expected_parent: libc::pid_t) -> io::Result<()> {
    if expected_parent <= 1 || unsafe { libc::getppid() } != expected_parent {
        return Err(io::Error::from_raw_os_error(libc::EPIPE));
    }
    // This runs either at program entry or in pre_exec; use only libc calls here.
    if unsafe { libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL, 0, 0, 0) } != 0 {
        return Err(io::Error::last_os_error());
    }
    if unsafe { libc::getppid() } != expected_parent {
        return Err(io::Error::from_raw_os_error(libc::EPIPE));
    }
    Ok(())
}

pub fn watch_parent() -> io::Result<()> {
    watch(unsafe { libc::getppid() })
}

pub(crate) fn bind_child(command: &mut Command) {
    let parent = unsafe { libc::getpid() };
    // No allocator, locks or user callbacks are used between fork and exec.
    unsafe {
        command.pre_exec(move || watch(parent));
    }
}
