use std::fs::File;
use std::io;
use std::path::Path;

// Match Node's bigint stat on the opened file so an atomic replacement
// cannot accidentally inherit an old journal offset.
#[derive(PartialEq, Eq)]
pub(crate) struct FileStamp {
    pub inode: u64,
    pub len: u64,
    pub modified_ns: i128,
}

impl std::fmt::Display for FileStamp {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "{}:{}:{}",
            self.inode, self.len, self.modified_ns
        )
    }
}

#[cfg(unix)]
pub(crate) fn stamp(file: &File) -> io::Result<FileStamp> {
    Ok(unix_stamp(file.metadata()?))
}

#[cfg(unix)]
pub(crate) fn path_stamp(path: &Path) -> io::Result<FileStamp> {
    Ok(unix_stamp(std::fs::metadata(path)?))
}

#[cfg(unix)]
fn unix_stamp(metadata: std::fs::Metadata) -> FileStamp {
    use std::os::unix::fs::MetadataExt;

    FileStamp {
        inode: metadata.ino(),
        len: metadata.len(),
        modified_ns: i128::from(metadata.mtime()) * 1_000_000_000
            + i128::from(metadata.mtime_nsec()),
    }
}

#[cfg(windows)]
pub(crate) fn path_stamp(path: &Path) -> io::Result<FileStamp> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::FILE_READ_ATTRIBUTES;

    let file = File::options()
        .access_mode(FILE_READ_ATTRIBUTES)
        .open(path)?;
    stamp(&file)
}

#[cfg(windows)]
pub(crate) fn stamp(file: &File) -> io::Result<FileStamp> {
    use std::mem::MaybeUninit;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle,
    };

    let mut info = MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::uninit();
    // The file owns a live HANDLE and the output buffer has the required size.
    let success = unsafe { GetFileInformationByHandle(file.as_raw_handle(), info.as_mut_ptr()) };
    if success == 0 {
        return Err(io::Error::last_os_error());
    }
    let info = unsafe { info.assume_init() };
    let combine = |high: u32, low: u32| (u64::from(high) << 32) | u64::from(low);
    let ticks = combine(
        info.ftLastWriteTime.dwHighDateTime,
        info.ftLastWriteTime.dwLowDateTime,
    );
    const UNIX_EPOCH_TICKS: i128 = 116_444_736_000_000_000;
    Ok(FileStamp {
        inode: combine(info.nFileIndexHigh, info.nFileIndexLow),
        len: combine(info.nFileSizeHigh, info.nFileSizeLow),
        modified_ns: (i128::from(ticks) - UNIX_EPOCH_TICKS) * 100,
    })
}
