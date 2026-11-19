use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::{self, ErrorKind, Read};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tempfile::NamedTempFile;

use crate::{Result, atomic_file};

#[derive(Clone, Copy, Deserialize, Serialize, Eq, Hash, PartialEq)]
pub enum Entry {
    #[serde(rename = "config.json")]
    Config,
    #[serde(rename = "secret.key")]
    Secret,
    #[serde(rename = "reading-lists.json")]
    Profiles,
    #[serde(rename = "discovery-cache.json")]
    Discovery,
    #[serde(rename = "backup-vault.json")]
    Vault,
}

impl Entry {
    pub(crate) const ALL: [Self; 5] = [
        Self::Config,
        Self::Secret,
        Self::Profiles,
        Self::Discovery,
        Self::Vault,
    ];

    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::Config => "config.json",
            Self::Secret => "secret.key",
            Self::Profiles => "reading-lists.json",
            Self::Discovery => "discovery-cache.json",
            Self::Vault => "backup-vault.json",
        }
    }
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase")]
pub enum BackupRequest {
    Recover,
    Commit { files: Vec<Entry> },
    Finish,
}

#[derive(Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub(crate) enum BackupResponse {
    Clean,
    ClearProgress,
    Committed { profiles: bool },
    Failed { message: String, blocked: bool },
}

#[derive(Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
enum State {
    Prepared,
    Committed,
}

#[derive(Deserialize, Serialize)]
struct Manifest {
    state: State,
    files: Vec<Entry>,
    existed: HashMap<Entry, bool>,
}

pub(crate) struct BackupTransaction<'a> {
    data: &'a Path,
    config: &'a Path,
    folder: PathBuf,
}

impl<'a> BackupTransaction<'a> {
    pub(crate) fn new(data: &'a Path, config: &'a Path) -> Self {
        Self {
            data,
            config,
            folder: data.join(".restore-transaction"),
        }
    }

    pub(crate) fn run(&self, request: BackupRequest) -> BackupResponse {
        let result = match request {
            BackupRequest::Recover => self.recover(),
            BackupRequest::Commit { files } => self.commit(files),
            BackupRequest::Finish => self.finish(),
        };
        result.unwrap_or_else(|error| BackupResponse::Failed {
            message: error.to_string(),
            blocked: false,
        })
    }

    pub(crate) fn recover_startup(&self) -> Result<bool> {
        if self.folder.try_exists()? && matches!(self.recover()?, BackupResponse::ClearProgress) {
            let journal = self.data.join(crate::progress_journal::FILE_NAME);
            if !crate::progress_snapshot::clear_obsolete(&journal, &self.target(Entry::Profiles))? {
                return Ok(false);
            }
            self.finish()?;
        }
        Ok(true)
    }

    pub(crate) fn restore(&self, source: &Path, files: Vec<Entry>) -> Result<()> {
        fs::create_dir(&self.folder)?;
        let incoming = self.folder.join("incoming");
        let staged = (|| -> Result<()> {
            fs::create_dir(&incoming)?;
            for &entry in &files {
                fs::rename(source.join(entry.name()), incoming.join(entry.name()))?;
            }
            Ok(())
        })();
        if let Err(error) = staged {
            self.clean()?;
            return Err(error);
        }
        let result = self.commit(files);
        if result.is_err() && matches!(self.manifest(), Ok(None)) {
            self.clean()?;
        }
        match result? {
            BackupResponse::Committed { .. } => {
                if let Err(error) = self.recover_startup() {
                    // The commit is durable. Startup will retry cleanup.
                    eprintln!("Backup restore cleanup: {error}");
                }
                Ok(())
            }
            BackupResponse::Failed { message, .. } => Err(message.into()),
            _ => Err("Некорректное состояние восстановления резервной копии".into()),
        }
    }

    fn target(&self, entry: Entry) -> PathBuf {
        match entry {
            Entry::Config => self.config.into(),
            _ => self.data.join(entry.name()),
        }
    }

    fn manifest(&self) -> Result<Option<Manifest>> {
        let path = self.folder.join("manifest.json");
        let mut file = match options().read(true).open(path) {
            Ok(file) => file,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        let mut data = Vec::new();
        file.read_to_end(&mut data)?;
        let manifest: Manifest =
            serde_json::from_slice(data.strip_prefix(b"\xef\xbb\xbf").unwrap_or(&data))
                .map_err(|_| "Invalid backup recovery journal")?;
        validate_files(&manifest.files)?;
        if !manifest
            .files
            .iter()
            .all(|name| manifest.existed.contains_key(name))
        {
            return Err("Invalid backup recovery journal".into());
        }
        Ok(Some(manifest))
    }

    fn save(&self, manifest: &Manifest) -> Result<()> {
        replace(
            &self.folder.join("manifest.json"),
            serde_json::to_vec(manifest)?.as_slice(),
        )
    }

    fn recover(&self) -> Result<BackupResponse> {
        if let Some(manifest) = self.manifest()? {
            if manifest.state == State::Committed {
                if manifest.files.contains(&Entry::Profiles) {
                    return Ok(BackupResponse::ClearProgress);
                }
            } else {
                self.rollback(&manifest)?;
            }
        }
        self.clean()
    }

    fn rollback(&self, manifest: &Manifest) -> Result<()> {
        for &entry in &manifest.files {
            let target = self.target(entry);
            if manifest.existed[&entry] {
                replace(
                    &target,
                    options().read(true).open(self.folder.join(entry.name()))?,
                )?;
            } else {
                match fs::remove_file(&target) {
                    Ok(()) => atomic_file::sync_parent(&target)?,
                    Err(error) if error.kind() == ErrorKind::NotFound => (),
                    Err(error) => return Err(error.into()),
                }
            }
        }
        Ok(())
    }

    fn commit(&self, files: Vec<Entry>) -> Result<BackupResponse> {
        validate_files(&files)?;
        if self.manifest()?.is_some() {
            return Err("A backup recovery journal must be resolved before restoring".into());
        }
        let incoming = self.folder.join("incoming");
        let mut manifest = Manifest {
            state: State::Prepared,
            files,
            existed: HashMap::new(),
        };
        for &entry in &manifest.files {
            if !incoming.join(entry.name()).symlink_metadata()?.is_file() {
                return Err("Invalid staged backup file".into());
            }
            manifest.existed.insert(entry, self.copy_original(entry)?);
        }
        atomic_file::sync_parent(&self.folder)?;
        self.save(&manifest)?;
        if let Err(error) = self.install(&mut manifest, &incoming) {
            // Inspect the persisted marker in case the final rename preceded a sync error.
            let recovery = self.manifest().and_then(|saved| match saved {
                Some(saved) if saved.state == State::Prepared => {
                    self.rollback(&saved)?;
                    self.clean()?;
                    Ok(())
                }
                _ => Err("The backup commit could not be synchronized".into()),
            });
            return Ok(BackupResponse::Failed {
                message: match &recovery {
                    Err(rollback) => format!(
                        "Backup rollback failed; recovery journal retained for restart ({error}; {rollback})"
                    ),
                    Ok(_) => error.to_string(),
                },
                blocked: recovery.is_err(),
            });
        }
        Ok(BackupResponse::Committed {
            profiles: manifest.files.contains(&Entry::Profiles),
        })
    }

    #[cfg(windows)]
    #[allow(clippy::permissions_set_readonly_false)] // Windows clears the read-only attribute of the staging copy.
    fn copy_original(&self, entry: Entry) -> io::Result<bool> {
        let destination = self.folder.join(entry.name());
        match fs::copy(self.target(entry), &destination) {
            Ok(_) => {}
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(error),
        }
        let copy = match options().write(true).open(&destination) {
            Err(error) if error.kind() == ErrorKind::PermissionDenied => {
                let mut permissions = destination.metadata()?.permissions();
                if !permissions.readonly() {
                    return Err(error);
                }
                permissions.set_readonly(false);
                fs::set_permissions(&destination, permissions)?;
                options().write(true).open(destination)?
            }
            result => result?,
        };
        copy.sync_all()?;
        Ok(true)
    }

    #[cfg(not(windows))]
    fn copy_original(&self, entry: Entry) -> io::Result<bool> {
        let mut source = match options().read(true).open(self.target(entry)) {
            Ok(file) => file,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(error),
        };
        let mut copy = options()
            .write(true)
            .create_new(true)
            .open(self.folder.join(entry.name()))?;
        io::copy(&mut source, &mut copy)?;
        copy.sync_all()?;
        Ok(true)
    }

    fn install(&self, manifest: &mut Manifest, incoming: &Path) -> Result<()> {
        for &entry in &manifest.files {
            install_staged(&incoming.join(entry.name()), &self.target(entry))?;
        }
        manifest.state = State::Committed;
        self.save(manifest)
    }

    fn finish(&self) -> Result<BackupResponse> {
        if self
            .manifest()?
            .is_some_and(|manifest| manifest.state == State::Committed)
        {
            self.clean()
        } else {
            Err("A committed backup recovery journal is required".into())
        }
    }

    fn clean(&self) -> Result<BackupResponse> {
        match fs::remove_dir_all(&self.folder) {
            Ok(()) => atomic_file::sync_parent(&self.folder)?,
            Err(error) if error.kind() == ErrorKind::NotFound => (),
            Err(error) => return Err(error.into()),
        }
        Ok(BackupResponse::Clean)
    }
}

fn options() -> OpenOptions {
    let mut options = OpenOptions::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_BACKUP_SEMANTICS;
        options.custom_flags(FILE_FLAG_BACKUP_SEMANTICS);
    }
    options
}

fn install_staged(source: &Path, target: &Path) -> Result<()> {
    fs::create_dir_all(target.parent().ok_or("missing backup target directory")?)?;
    options().write(true).open(source)?.sync_all()?;
    match fs::rename(source, target) {
        Ok(()) => {
            atomic_file::sync_parent(target)?;
            atomic_file::sync_parent(source)
        }
        Err(error) if error.kind() == ErrorKind::CrossesDevices => {
            replace(target, options().read(true).open(source)?)
        }
        Err(error) => Err(error.into()),
    }
}

fn replace(path: &Path, mut source: impl Read) -> Result<()> {
    let parent = path.parent().ok_or("missing backup target directory")?;
    fs::create_dir_all(parent)?;
    let mut temp = NamedTempFile::new_in(parent)?;
    io::copy(&mut source, temp.as_file_mut())?;
    temp.as_file().sync_all()?;
    temp.persist(path)?;
    atomic_file::sync_parent(path)
}

fn validate_files(files: &[Entry]) -> Result<()> {
    if files.iter().collect::<HashSet<_>>().len() != files.len() {
        return Err("Invalid backup recovery journal".into());
    }
    Ok(())
}
