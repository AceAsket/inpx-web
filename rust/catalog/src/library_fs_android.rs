use serde_json::{Value, json};
use std::fs::File;
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::net::UnixStream;
use std::path::{Component, Path};
use std::time::Duration;

pub(super) fn validate(path: &Path) -> io::Result<()> {
    let relative = path
        .strip_prefix("/__android_library__")
        .map_err(|_| invalid())?;
    let mut parts = relative.components();
    let Some(Component::Normal(source)) = parts.next() else {
        return Err(invalid());
    };
    if !source
        .to_string_lossy()
        .bytes()
        .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
        || !parts.all(|part| matches!(part, Component::Normal(_)))
        || path
            .to_str()
            .is_none_or(|value| value.contains(['\\', '\0']))
    {
        return Err(invalid());
    }
    Ok(())
}
fn invalid() -> io::Error {
    io::Error::new(
        io::ErrorKind::PermissionDenied,
        "Invalid Android library path",
    )
}

pub(super) fn request(operation: &str, path: &Path) -> io::Result<(Value, Option<File>)> {
    validate(path)?;
    let name = std::env::var("INPX_ANDROID_STORAGE_SOCKET")
        .map_err(|_| io::Error::other("Android storage broker unavailable"))?;
    // Android LocalServerSocket uses Linux's abstract AF_UNIX namespace.
    let mut address: libc::sockaddr_un = unsafe { std::mem::zeroed() };
    if name.len() + 1 >= address.sun_path.len() {
        return Err(invalid());
    }
    address.sun_family = libc::AF_UNIX as _;
    for (out, byte) in address.sun_path[1..].iter_mut().zip(name.bytes()) {
        *out = byte as _;
    }
    let fd = unsafe { libc::socket(libc::AF_UNIX, libc::SOCK_STREAM | libc::SOCK_CLOEXEC, 0) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    // Own the descriptor before any subsequent fallible operation.
    let mut stream = unsafe { UnixStream::from_raw_fd(fd) };
    let length =
        (std::mem::offset_of!(libc::sockaddr_un, sun_path) + 1 + name.len()) as libc::socklen_t;
    if unsafe { libc::connect(fd, (&address as *const libc::sockaddr_un).cast(), length) } < 0 {
        return Err(io::Error::last_os_error());
    }
    stream.set_read_timeout(Some(Duration::from_secs(20)))?;
    stream.set_write_timeout(Some(Duration::from_secs(20)))?;
    let bytes = serde_json::to_vec(&json!({"operation":operation,"path":path}))?;
    stream.write_all(&(bytes.len() as u32).to_be_bytes())?;
    stream.write_all(&bytes)?;
    let mut header = [0u8; 4];
    let mut vector = libc::iovec {
        iov_base: header.as_mut_ptr().cast(),
        iov_len: header.len(),
    };
    // usize keeps cmsghdr correctly aligned on ARM32 and ARM64.
    let mut control = [0usize; 16];
    let mut message: libc::msghdr = unsafe { std::mem::zeroed() };
    message.msg_iov = &mut vector;
    message.msg_iovlen = 1;
    message.msg_control = control.as_mut_ptr().cast();
    message.msg_controllen = std::mem::size_of_val(&control) as _;
    let count = loop {
        let count =
            unsafe { libc::recvmsg(stream.as_raw_fd(), &mut message, libc::MSG_CMSG_CLOEXEC) };
        if count >= 0 {
            break count as usize;
        }
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::Interrupted {
            return Err(error);
        }
    };
    let mut descriptors = Vec::new();
    unsafe {
        let mut item = libc::CMSG_FIRSTHDR(&message);
        while !item.is_null() {
            if (*item).cmsg_level == libc::SOL_SOCKET && (*item).cmsg_type == libc::SCM_RIGHTS {
                let bytes = ((*item).cmsg_len as usize).saturating_sub(libc::CMSG_LEN(0) as usize);
                let data = libc::CMSG_DATA(item).cast::<libc::c_int>();
                for index in 0..bytes / std::mem::size_of::<libc::c_int>() {
                    descriptors.push(File::from_raw_fd(data.add(index).read_unaligned()));
                }
            }
            item = libc::CMSG_NXTHDR(&message, item);
        }
    }
    if message.msg_flags & (libc::MSG_CTRUNC | libc::MSG_TRUNC) != 0 || count == 0 {
        return Err(io::Error::other("Truncated Android storage response"));
    }
    stream.read_exact(&mut header[count..])?;
    let length = u32::from_be_bytes(header) as usize;
    if length == 0 || length > 8 * 1024 * 1024 {
        return Err(io::Error::other("Invalid storage response size"));
    }
    let mut body = vec![0; length];
    stream.read_exact(&mut body)?;
    let response: Value = serde_json::from_slice(&body)?;
    if let Some(error) = response.get("error") {
        let kind = match error.as_str().unwrap_or_default() {
            "ENOENT" => io::ErrorKind::NotFound,
            "EACCES" | "EAUTH" => io::ErrorKind::PermissionDenied,
            "ENETUNREACH" | "ENODEV" => io::ErrorKind::NotConnected,
            _ => io::ErrorKind::Other,
        };
        return Err(io::Error::new(
            kind,
            response["message"]
                .as_str()
                .unwrap_or("Android storage error")
                .to_owned(),
        ));
    }
    if descriptors.len() != usize::from(operation == "open") {
        return Err(io::Error::other("Invalid storage descriptor count"));
    }
    Ok((
        response
            .get("value")
            .ok_or_else(|| io::Error::other("Missing storage result"))?
            .clone(),
        descriptors.pop(),
    ))
}
