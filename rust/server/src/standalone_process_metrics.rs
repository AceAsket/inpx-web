#[cfg(target_os = "linux")]
pub(in crate::standalone) fn rss() -> Option<u64> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    let kib = status
        .lines()
        .find_map(|line| line.strip_prefix("VmRSS:"))?
        .split_ascii_whitespace()
        .next()?
        .parse::<u64>()
        .ok()?;
    kib.checked_mul(1024)
}

#[cfg(target_os = "macos")]
pub(in crate::standalone) fn rss() -> Option<u64> {
    let mut info = std::mem::MaybeUninit::<libc::mach_task_basic_info_data_t>::zeroed();
    let mut count = libc::MACH_TASK_BASIC_INFO_COUNT;
    // task_info fills this structure for the current process.
    let result = unsafe {
        libc::task_info(
            libc::mach_task_self(),
            libc::MACH_TASK_BASIC_INFO,
            info.as_mut_ptr().cast(),
            &mut count,
        )
    };
    (result == libc::KERN_SUCCESS && count >= libc::MACH_TASK_BASIC_INFO_COUNT)
        .then(|| unsafe { info.assume_init() }.resident_size)
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
pub(in crate::standalone) fn rss() -> Option<u64> {
    None
}

#[cfg(unix)]
pub(in crate::standalone) fn cpu() -> Option<(f64, f64)> {
    let mut data = std::mem::MaybeUninit::<libc::rusage>::zeroed();
    // getrusage writes elapsed CPU times for the current process.
    if unsafe { libc::getrusage(libc::RUSAGE_SELF, data.as_mut_ptr()) } != 0 {
        return None;
    }
    let data = unsafe { data.assume_init() };
    let seconds = |value: libc::timeval| value.tv_sec as f64 + value.tv_usec as f64 / 1_000_000.0;
    Some((seconds(data.ru_utime), seconds(data.ru_stime)))
}

#[cfg(windows)]
mod windows {
    use std::mem;
    use windows_sys::Win32::Foundation::FILETIME;
    use windows_sys::Win32::System::ProcessStatus::{
        K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, GetProcessTimes};

    pub(in crate::standalone) fn rss() -> Option<u64> {
        let mut counters = PROCESS_MEMORY_COUNTERS {
            cb: mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
            ..Default::default()
        };
        // The current-process handle is valid for the duration of this call.
        let success =
            unsafe { K32GetProcessMemoryInfo(GetCurrentProcess(), &mut counters, counters.cb) };
        (success != 0).then_some(counters.WorkingSetSize as u64)
    }

    pub(in crate::standalone) fn cpu() -> Option<(f64, f64)> {
        let [mut creation, mut exit, mut kernel, mut user] = [FILETIME::default(); 4];
        // All four buffers live until GetProcessTimes returns.
        let success = unsafe {
            GetProcessTimes(
                GetCurrentProcess(),
                &mut creation,
                &mut exit,
                &mut kernel,
                &mut user,
            )
        };
        let seconds = |value: FILETIME| {
            let ticks = (u64::from(value.dwHighDateTime) << 32) | u64::from(value.dwLowDateTime);
            ticks as f64 / 10_000_000.0
        };
        (success != 0).then(|| (seconds(user), seconds(kernel)))
    }
}

#[cfg(windows)]
pub(in crate::standalone) use self::windows::{cpu, rss};

#[cfg(not(any(unix, windows)))]
pub(in crate::standalone) fn cpu() -> Option<(f64, f64)> {
    None
}
