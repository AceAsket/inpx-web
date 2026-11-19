use std::fs::{self, File};
use std::io::{self, ErrorKind};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tempfile::{Builder, NamedTempFile};
use time::OffsetDateTime;

use crate::backup_transaction::Entry;
use crate::progress_journal::FILE_NAME as JOURNAL;
use crate::{Result, atomic_file, crypto_support, progress_snapshot};

const DATABASES: &[&str] = &["db", "db.previous", "web-access"];
const DATABASE_LOCKS: &[&str] = &["__lock", "__softlock", "__softlockcheck", "__inpx_lock"];
const EXTRA_STATE: &[&str] = &[
    "session-secret",
    "reader-backgrounds",
    JOURNAL,
    "public",
    "backups",
    "kosync.json",
    "kosync",
    "telegram-bot-state.json",
    "resource-benchmark.json",
];
const MIGRATION_MARKER: &str = ".data-dir-migration.json";

#[derive(Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Migration {
    source: PathBuf,
    config_file: PathBuf,
}

#[derive(Serialize)]
struct EntryStamp {
    entry: &'static str,
    size: u64,
    changed: serde_json::Number,
}

pub fn migrate(destination: &Path, source: &Path, config_file: &Path) -> Result<PathBuf> {
    let destination_root = destination.canonicalize()?;
    let source_root = source.canonicalize()?;
    if destination_root == source_root {
        return Err("Set --data-dir to a different directory to migrate legacy data".into());
    }
    let mut existing = Vec::new();
    let names = Entry::ALL
        .into_iter()
        .filter(|entry| *entry != Entry::Config)
        .map(Entry::name)
        .chain(EXTRA_STATE.iter().copied())
        .chain(DATABASES.iter().copied());
    for entry in names {
        let path = source.join(entry);
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
        };
        if metadata.is_dir() && destination_root.starts_with(source_root.join(entry)) {
            return Err(format!(
                "Migration destination is inside legacy entry: {}",
                path.display()
            )
            .into());
        }
        existing.push(EntryStamp {
            entry,
            size: metadata.len(),
            changed: changed_ms(&path, &metadata, false)?,
        });
    }
    if existing.is_empty() {
        return Ok(destination.into());
    }
    // Use the previous release's receipt identifier so an interrupted config save
    // can resume with the already published copy.
    let changed = changed_ms(config_file, &fs::metadata(config_file)?, true)?;
    let key = serde_json::to_vec(&(source, config_file, changed, &existing))?;
    let id = crypto_support::hex(&Sha256::digest(key)[..6]);
    let migrated = destination.join(format!("migrated-data-{id}"));
    let receipt = Migration {
        source: source.into(),
        config_file: config_file.into(),
    };
    if migration_complete(&migrated, &receipt)? {
        return Ok(migrated);
    }

    let stage = staging(".data-dir-migration-", destination)?;
    for source_entry in existing {
        let entry = source_entry.entry;
        let skip = if DATABASES.contains(&entry) {
            DATABASE_LOCKS
        } else {
            &[]
        };
        copy_tree(
            &source.join(entry),
            &stage.path().join(entry),
            skip,
            CopyKind::Migration,
        )?;
    }
    write_receipt(&stage.path().join(MIGRATION_MARKER), &receipt)?;
    match fs::rename(stage.path(), &migrated) {
        Ok(()) => atomic_file::sync_parent(&migrated)?,
        Err(error) if !migration_complete(&migrated, &receipt)? => return Err(error.into()),
        Err(_) => {}
    }
    Ok(migrated)
}

fn migration_complete(directory: &Path, expected: &Migration) -> Result<bool> {
    let Some(data) = read_optional(&directory.join(MIGRATION_MARKER))? else {
        return Ok(false);
    };
    Ok(serde_json::from_slice::<Migration>(&data)? == *expected)
}

#[cfg(unix)]
fn changed_ms(_: &Path, metadata: &fs::Metadata, _: bool) -> Result<serde_json::Number> {
    use std::os::unix::fs::MetadataExt;
    milliseconds(metadata.ctime(), metadata.ctime_nsec())
}

#[cfg(windows)]
fn changed_ms(path: &Path, _: &fs::Metadata, follow: bool) -> Result<serde_json::Number> {
    use std::mem::{MaybeUninit, size_of};
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_BASIC_INFO, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
        FILE_READ_ATTRIBUTES, FileBasicInfo, GetFileInformationByHandleEx,
    };
    let mut flags = FILE_FLAG_BACKUP_SEMANTICS;
    if !follow {
        flags |= FILE_FLAG_OPEN_REPARSE_POINT;
    }
    let file = File::options()
        .access_mode(FILE_READ_ATTRIBUTES)
        .custom_flags(flags)
        .open(path)?;
    let mut info = MaybeUninit::<FILE_BASIC_INFO>::uninit();
    // The file owns a live handle and the buffer matches the layout for FileBasicInfo.
    if unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle(),
            FileBasicInfo,
            info.as_mut_ptr().cast(),
            size_of::<FILE_BASIC_INFO>() as u32,
        )
    } == 0
    {
        return Err(io::Error::last_os_error().into());
    }
    const UNIX_TICKS: i64 = 116_444_736_000_000_000;
    const TICKS_PER_SECOND: i64 = 10_000_000;
    let ticks = unsafe { info.assume_init() }.ChangeTime - UNIX_TICKS;
    milliseconds(
        ticks.div_euclid(TICKS_PER_SECOND),
        ticks.rem_euclid(TICKS_PER_SECOND) * 100,
    )
}

fn milliseconds(seconds: i64, nanos: i64) -> Result<serde_json::Number> {
    let millis = seconds as f64 * 1_000.0 + nanos as f64 / 1_000_000.0;
    Ok(if millis.fract() == 0.0 {
        serde_json::Number::from(millis as i64)
    } else {
        serde_json::Number::from_f64(millis).ok_or("Invalid data directory timestamp")?
    })
}

#[derive(Deserialize, Serialize)]
struct UpgradeMarker {
    version: String,
    #[serde(default)]
    runtime: String,
    snapshot: Option<PathBuf>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Manifest<'a> {
    created_at: String,
    target_version: &'a str,
    files: Vec<&'static str>,
    config_file: &'a Path,
}

#[derive(Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum Upgrade {
    Ready { snapshot: Option<PathBuf> },
    Legacy,
}

pub fn snapshot(data: &Path, config_file: &Path, version: &str, runtime: &str) -> Result<Upgrade> {
    let marker_path = data.join(".upgrade-version.json");
    let expected = atomic_file::current_stamp(&marker_path)?;
    if let Some(previous) = read_optional(&marker_path)? {
        let previous: serde_json::Value = serde_json::from_slice(&previous)?;
        if previous.get("version").and_then(serde_json::Value::as_str) == Some(version)
            && previous.get("runtime").and_then(serde_json::Value::as_str) == Some(runtime)
        {
            return Ok(Upgrade::Ready {
                snapshot: previous
                    .get("snapshot")
                    .and_then(serde_json::Value::as_str)
                    .filter(|path| !path.is_empty())
                    .map(PathBuf::from),
            });
        }
    }
    let targets = Entry::ALL
        .into_iter()
        .map(|entry| {
            let path = if entry == Entry::Config {
                config_file.into()
            } else {
                data.join(entry.name())
            };
            (entry.name(), path)
        })
        .chain(["public", "reader-backgrounds"].map(|entry| (entry, data.join(entry))));
    let mut files = Vec::new();
    for (entry, path) in targets {
        // Match pathExists for optional state. copy_tree rejects links whose targets exist.
        match fs::metadata(&path) {
            Ok(_) => files.push((entry, path)),
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    let snapshot = if files.is_empty() {
        fs::create_dir_all(data)?;
        None
    } else {
        let root = data.join(".upgrade-backups");
        let mut builder = fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(&root)?;
        let stage = staging(".pending-", &root)?;
        for (name, path) in &files {
            let target = stage.path().join(name);
            copy_tree(path, &target, &[], CopyKind::Snapshot)?;
            if *name == Entry::Profiles.name()
                && !progress_snapshot::fold(&data.join(JOURNAL), &target)?
            {
                return Ok(Upgrade::Legacy);
            }
        }
        let elapsed = SystemTime::now().duration_since(UNIX_EPOCH)?;
        write_receipt(
            &stage.path().join("manifest.json"),
            &Manifest {
                created_at: iso_time(OffsetDateTime::from_unix_timestamp_nanos(
                    elapsed.as_nanos().try_into()?,
                )?),
                target_version: version,
                files: files.into_iter().map(|(name, _)| name).collect(),
                config_file,
            },
        )?;
        let suffix: String = version
            .encode_utf16()
            .map(|unit| {
                char::from_u32(u32::from(unit))
                    .filter(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-'))
                    .unwrap_or('_')
            })
            .collect();
        let mut published = root.join(format!("{}-{suffix}", elapsed.as_millis()));
        if published.try_exists()? {
            published = root.join(format!(
                "{}-{suffix}-{}",
                elapsed.as_millis(),
                crypto_support::hex(&crypto_support::random::<4>()?)
            ));
        }
        fs::rename(stage.path(), &published)?;
        atomic_file::sync_parent(&published)?;
        Some(published)
    };
    let status = UpgradeMarker {
        version: version.into(),
        runtime: runtime.into(),
        snapshot,
    };
    let mut temp = NamedTempFile::new_in(data)?;
    serde_json::to_writer(&mut temp, &status)?;
    if atomic_file::publish(temp, &marker_path, expected.as_deref())?.is_none() {
        let current: UpgradeMarker = serde_json::from_slice(&fs::read(&marker_path)?)?;
        if current.version != version || current.runtime != runtime {
            return Err("Upgrade marker changed during snapshot creation".into());
        }
        return Ok(Upgrade::Ready {
            snapshot: current.snapshot,
        });
    }
    Ok(Upgrade::Ready {
        snapshot: status.snapshot,
    })
}

fn iso_time(now: OffsetDateTime) -> String {
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        now.year(),
        now.month() as u8,
        now.day(),
        now.hour(),
        now.minute(),
        now.second(),
        now.millisecond()
    )
}

fn read_optional(path: &Path) -> io::Result<Option<Vec<u8>>> {
    match fs::read(path) {
        Ok(data) => Ok(Some(data)),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

fn write_receipt(path: &Path, receipt: &impl Serialize) -> Result<()> {
    let mut file = File::create_new(path)?;
    serde_json::to_writer_pretty(&mut file, receipt)?;
    file.sync_all()?;
    atomic_file::sync_parent(path)
}

fn staging(prefix: &str, parent: &Path) -> io::Result<tempfile::TempDir> {
    let mut builder = Builder::new();
    builder.prefix(prefix);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        builder.permissions(fs::Permissions::from_mode(0o700));
    }
    builder.tempdir_in(parent)
}

#[derive(Clone, Copy)]
enum CopyKind {
    Migration,
    Snapshot,
}

fn copy_tree(source: &Path, destination: &Path, skip: &[&str], kind: CopyKind) -> Result<()> {
    let metadata = fs::symlink_metadata(source)?;
    if metadata.is_symlink() {
        return Err(match kind {
            CopyKind::Migration => format!("Symbolic link in legacy data: {}", source.display()),
            CopyKind::Snapshot => "Символическая ссылка в данных резервной копии обновления".into(),
        }
        .into());
    }
    if metadata.is_dir() {
        fs::create_dir(destination)?;
        for item in fs::read_dir(source)? {
            let item = item?;
            let name = item.file_name();
            if !skip.iter().any(|skip| name == *skip) {
                copy_tree(&item.path(), &destination.join(name), &[], kind)?;
            }
        }
        fs::set_permissions(destination, metadata.permissions())?;
        atomic_file::sync_directory(destination)?;
    } else if metadata.is_file() {
        let mut source = File::open(source)?;
        let mut output = File::create_new(destination)?;
        io::copy(&mut source, &mut output)?;
        output.set_permissions(metadata.permissions())?;
        output.sync_all()?;
    } else {
        return Err(format!("Unsupported data entry: {}", source.display()).into());
    }
    Ok(())
}
