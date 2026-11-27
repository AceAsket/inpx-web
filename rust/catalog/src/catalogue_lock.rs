use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufRead, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::thread;
use std::time::{Duration, Instant};

use serde::Deserialize;

use crate::Result;
use crate::file_stamp::{FileStamp, path_stamp, stamp};
use crate::framed_protocol::{Frames, header, reply};

const OWNED: &[u8] = b"inpx-native-lock-v1\n";
const SOFT: &str = "__softlock";
const HARD: &str = "__lock";
const CHECK: &str = "__softlockcheck";

pub type OnLost = Arc<dyn Fn(String) + Send + Sync>;

pub struct CatalogueLease {
    stop: mpsc::Sender<()>,
    watcher: Option<thread::JoinHandle<()>>,
    lost: Arc<AtomicBool>,
}

impl CatalogueLease {
    pub fn open(directory: &Path) -> Result<Self> {
        Self::open_with_on_lost(directory, None)
    }

    pub fn open_with_on_lost(directory: &Path, on_lost: Option<OnLost>) -> Result<Self> {
        let lease = Lease::acquire(directory)?.ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::WouldBlock,
                format!("Database locked: {}", directory.display()),
            )
        })?;
        let leases = Mutex::new(HashMap::from([(directory.into(), lease)]));
        let (stop, parent) = mpsc::channel();
        let lost = Arc::new(AtomicBool::new(false));
        let watcher_lost = Arc::clone(&lost);
        let watcher = thread::Builder::new()
            .name("catalogue-lock".into())
            .spawn(move || {
                watch(
                    &leases,
                    parent,
                    false,
                    Some(&watcher_lost),
                    on_lost.as_ref(),
                )
            })?;
        Ok(Self {
            stop,
            watcher: Some(watcher),
            lost,
        })
    }

    pub fn is_lost(&self) -> bool {
        self.lost.load(Ordering::Acquire)
    }

    pub fn check(&self) -> Result<()> {
        if self.is_lost() {
            return Err("Catalogue lease lost".into());
        }
        Ok(())
    }
}

impl Drop for CatalogueLease {
    fn drop(&mut self) {
        let _ = self.stop.send(());
        if let Some(watcher) = self.watcher.take() {
            let _ = watcher.join();
        }
    }
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "lowercase")]
enum Command {
    Acquire { directory: PathBuf },
    Release { directory: PathBuf },
}

pub fn serve(mut input: impl BufRead, mut output: impl Write) -> Result<()> {
    let leases = Mutex::new(HashMap::new());
    let (stop, parent) = mpsc::channel();
    thread::scope(|scope| {
        let watcher = scope.spawn(|| watch(&leases, parent, true, None, None));
        let result = (|| {
            while let Some(command) = header(&mut input)? {
                let result = update(&leases, command).and_then(|applied| {
                    let value = if applied {
                        b"true".as_slice()
                    } else {
                        b"false".as_slice()
                    };
                    Frames(&mut output).write_all(value)?;
                    Ok(())
                });
                reply(&mut output, result)?;
            }
            Ok(())
        })();
        let _ = stop.send(());
        watcher.join().expect("catalogue lock watcher");
        result
    })
}

type Leases = Mutex<HashMap<PathBuf, Lease>>;

fn watch(
    leases: &Leases,
    parent: mpsc::Receiver<()>,
    exit_on_loss: bool,
    lost: Option<&AtomicBool>,
    on_lost: Option<&OnLost>,
) {
    while let Err(mpsc::RecvTimeoutError::Timeout) = parent.recv_timeout(Duration::from_millis(200))
    {
        let mut active = leases.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(error) = active.values().find_map(|lease| lease.acknowledge().err()) {
            let message = error.to_string();
            active.clear();
            drop(active);
            if let Some(lost) = lost {
                lost.store(true, Ordering::Release);
            }
            if exit_on_loss {
                // Standalone lock subprocess: parent closes associated stores when worker exits.
                eprintln!("inpx-catalog: {message}");
                std::process::exit(1);
            }
            log::error!(target: "inpx::index", "Catalogue lease lost: {message}");
            if let Some(notify) = on_lost {
                notify(message);
            }
            return;
        }
    }
}

fn update(leases: &Leases, command: Command) -> Result<bool> {
    match command {
        Command::Acquire { directory } => {
            if leases
                .lock()
                .expect("catalogue leases")
                .contains_key(&directory)
            {
                return Ok(false);
            }
            // A legacy challenge can wait one second. Other leases must still answer probes.
            let Some(lease) = Lease::acquire(&directory)? else {
                return Ok(false);
            };
            leases
                .lock()
                .expect("catalogue leases")
                .insert(directory, lease);
            Ok(true)
        }
        Command::Release { directory } => {
            let lease = leases.lock().expect("catalogue leases").remove(&directory);
            Ok(lease.is_some())
        }
    }
}

struct Lease {
    // Dropped after the compatibility marker so another Rust opener can claim the directory.
    _guard: File,
    marker: PathBuf,
    revision: FileStamp,
    probe: PathBuf,
}

impl Lease {
    fn acquire(directory: &Path) -> Result<Option<Self>> {
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options
                .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
                .mode(0o600);
        }
        let path = directory.join("__inpx_lock");
        if fs::symlink_metadata(&path).is_ok_and(|meta| !meta.is_file()) {
            return Err("Invalid catalogue lock file".into());
        }
        let guard = options.open(path)?;
        match guard.try_lock() {
            Ok(()) => {}
            Err(fs::TryLockError::WouldBlock) => return Ok(None),
            Err(fs::TryLockError::Error(error)) => return Err(error.into()),
        }
        if directory.join(HARD).try_exists()? {
            return Ok(None);
        }
        let marker = directory.join(SOFT);
        let probe = directory.join(CHECK);
        if let Some(previous) = current(&marker)? {
            // An OS lease guarantees a Rust marker without a holder is left by a stopped server.
            // Old Jemba owners must still answer their original challenge protocol.
            let stale_native = previous.len == OWNED.len() as u64 && rust_marker(&marker)?;
            if !stale_native && !legacy_inactive(&probe)? {
                return Ok(None);
            }
            if current(&marker)?.as_ref() != Some(&previous) || directory.join(HARD).try_exists()? {
                return Ok(None);
            }
            fs::remove_file(&marker)?;
        }
        let mut marker_file = match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&marker)
        {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        marker_file.write_all(OWNED)?;
        let created = stamp(&marker_file)?;
        drop(marker_file);
        let revision = path_stamp(&marker)?;
        if revision.inode != created.inode || revision.len != OWNED.len() as u64 {
            return Ok(None);
        }
        let lease = Self {
            _guard: guard,
            marker,
            revision,
            probe,
        };
        // A legacy peer could already be writing a challenge by the time we announce readiness.
        lease.clear_probe()?;
        Ok(Some(lease))
    }

    fn acknowledge(&self) -> io::Result<()> {
        if current(&self.marker)?.as_ref() != Some(&self.revision) {
            return Err(io::Error::other("Catalogue lock marker was replaced"));
        }
        self.clear_probe()
    }

    fn clear_probe(&self) -> io::Result<()> {
        if self.probe.try_exists()? {
            remove(&self.probe)
        } else {
            Ok(())
        }
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        if current(&self.marker).is_ok_and(|revision| revision.as_ref() == Some(&self.revision)) {
            let _ = remove(&self.probe);
            let _ = remove(&self.marker);
        }
    }
}

fn current(path: &Path) -> io::Result<Option<FileStamp>> {
    match path_stamp(path) {
        Ok(revision) => Ok(Some(revision)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

fn remove(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        result => result,
    }
}

fn rust_marker(path: &Path) -> io::Result<bool> {
    let mut buffer = [0; OWNED.len()];
    match File::open(path)?.read_exact(&mut buffer) {
        Ok(()) => Ok(buffer == OWNED),
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => Ok(false),
        Err(error) => Err(error),
    }
}

fn legacy_inactive(probe: &Path) -> io::Result<bool> {
    fs::write(probe, [])?;
    let own = current(probe)?;
    if own.is_none() {
        return Ok(false);
    }
    // The previous release responds via fs.watch or its fallback timer.
    let deadline = Instant::now() + Duration::from_secs(1);
    while Instant::now() < deadline {
        thread::sleep(
            deadline
                .saturating_duration_since(Instant::now())
                .min(Duration::from_millis(50)),
        );
        if current(probe)? != own {
            return Ok(false);
        }
    }
    remove(probe)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lease_loss_sets_flag_fires_callback_and_releases_lock() {
        let dir = tempfile::tempdir().unwrap();
        let (tx, rx) = mpsc::channel();
        let on_lost: OnLost = Arc::new(move |reason| {
            let _ = tx.send(reason);
        });
        let lease = CatalogueLease::open_with_on_lost(dir.path(), Some(on_lost)).unwrap();
        assert!(!lease.is_lost());
        assert!(lease.check().is_ok());

        let marker = dir.path().join(SOFT);
        fs::remove_file(&marker).unwrap();
        fs::write(&marker, b"other owner").unwrap();

        let reason = rx
            .recv_timeout(Duration::from_secs(3))
            .expect("on_lost callback should fire when marker is replaced");
        assert!(reason.contains("marker was replaced"), "{reason}");
        assert!(lease.is_lost());
        assert!(lease.check().is_err());
        assert_eq!(fs::read(&marker).unwrap(), b"other owner");

        drop(lease);
        assert_eq!(
            fs::read(&marker).unwrap(),
            b"other owner",
            "dropping a lost lease must not remove the replacement marker"
        );
    }

    #[test]
    fn lease_loss_fires_when_marker_is_removed() {
        let dir = tempfile::tempdir().unwrap();
        let (tx, rx) = mpsc::channel();
        let on_lost: OnLost = Arc::new(move |reason| {
            let _ = tx.send(reason);
        });
        let lease = CatalogueLease::open_with_on_lost(dir.path(), Some(on_lost)).unwrap();
        fs::remove_file(dir.path().join(SOFT)).unwrap();

        let reason = rx
            .recv_timeout(Duration::from_secs(3))
            .expect("on_lost callback should fire when marker is removed");
        assert!(reason.contains("marker was replaced"), "{reason}");
        assert!(lease.is_lost());
        assert!(lease.check().is_err());
    }
}
