use std::path::{Path, PathBuf};

#[cfg(windows)]
pub(crate) fn absolute(path: &Path) -> std::io::Result<PathBuf> {
    std::path::absolute(path)
}

pub(crate) fn realpath(path: &Path) -> std::io::Result<PathBuf> {
    let path = path.canonicalize()?;
    #[cfg(windows)]
    {
        use std::ffi::OsString;
        use std::path::{Component, Prefix};

        let mut parts = path.components();
        if let Some(Component::Prefix(prefix)) = parts.next() {
            let root = match prefix.kind() {
                Prefix::VerbatimDisk(drive) => OsString::from(format!("{}:\\", char::from(drive))),
                Prefix::VerbatimUNC(server, share) => {
                    let mut root = OsString::from(r"\\");
                    root.push(server);
                    root.push(r"\");
                    root.push(share);
                    root
                }
                _ => return Ok(path),
            };
            // Match the ordinary paths stored in receipts by the previous launcher.
            parts.next();
            return Ok(PathBuf::from(root).join(parts.as_path()));
        }
    }
    Ok(path)
}

#[cfg(unix)]
pub(crate) fn absolute(path: &Path) -> std::io::Result<PathBuf> {
    use std::path::Component;
    let joined = if path.is_absolute() {
        path.into()
    } else {
        std::env::current_dir()?.join(path)
    };
    let mut resolved = PathBuf::new();
    for component in joined.components() {
        match component {
            Component::ParentDir => {
                resolved.pop();
            }
            Component::CurDir => {}
            _ => resolved.push(component),
        }
    }
    Ok(resolved)
}
