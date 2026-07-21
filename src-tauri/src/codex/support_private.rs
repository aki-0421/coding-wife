use std::ffi::OsString;
#[cfg(target_os = "macos")]
use std::ffi::{CStr, OsStr};
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
#[cfg(unix)]
use std::os::fd::AsRawFd;
#[cfg(target_os = "macos")]
use std::os::unix::ffi::OsStrExt;
#[cfg(windows)]
use std::os::windows::io::AsRawHandle;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex as StdMutex;

use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::platform_fs::{
    current_user_id, MetadataExt, OpenOptionsExt, PermissionsExt, O_CLOEXEC, O_DIRECTORY,
    O_NOFOLLOW,
};

use super::bundled_skill::{
    ResolvedBundledSkill, DIRECT_PRESENCE_SKILL_NAME, EXPLAIN_COMMIT_SKILL_NAME,
};
use super::support::{SupportRuntimeError, SUPPORT_PERMISSION_PROFILE};

const MAX_AUTH_BYTES: u64 = 1024 * 1024;
const RUN_DIRECTORY_PREFIX: &str = "coding-wife-support-";
const RUN_LOCK_FILE: &str = ".runtime.lock";

pub(super) struct PrivateRunDirectory {
    pub(super) root: PathBuf,
    pub(super) codex_home: PathBuf,
    pub(super) workspace: PathBuf,
    temp: PathBuf,
    root_parent: PathBuf,
    root_parent_descriptor: File,
    root_parent_identity: DirectoryIdentity,
    root_descriptor: File,
    root_identity: DirectoryIdentity,
    _lock: File,
    cleanup_lock: StdMutex<()>,
    displaced_root: StdMutex<Option<PathBuf>>,
    cleaned: AtomicBool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct DirectoryIdentity {
    device: u64,
    inode: u64,
    owner: u32,
}

struct PendingRunRoot {
    path: PathBuf,
    committed: bool,
}

impl Drop for PendingRunRoot {
    fn drop(&mut self) {
        if !self.committed {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }
}

impl PrivateRunDirectory {
    pub(super) fn create(label: &str) -> Result<Self, SupportRuntimeError> {
        cleanup_stale_run_directories()?;
        let root_parent = std::env::temp_dir();
        let root_parent_descriptor = open_directory_descriptor(&root_parent)?;
        let root_parent_identity = directory_identity(
            &root_parent_descriptor
                .metadata()
                .map_err(|_| SupportRuntimeError::PrivateRuntime)?,
        );
        let root = root_parent.join(format!(
            "{RUN_DIRECTORY_PREFIX}{label}-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        create_private_directory(&root)?;
        let mut pending_root = PendingRunRoot {
            path: root.clone(),
            committed: false,
        };
        let codex_home = root.join("codex-home");
        let workspace = root.join("workspace");
        let temp = root.join("tmp");
        let root_descriptor = open_directory_descriptor(&root)?;
        let root_identity = directory_identity(
            &root_descriptor
                .metadata()
                .map_err(|_| SupportRuntimeError::PrivateRuntime)?,
        );
        let lock = create_lock_file(&root.join(RUN_LOCK_FILE))?;
        let run = Self {
            root,
            codex_home,
            workspace,
            temp,
            root_parent,
            root_parent_descriptor,
            root_parent_identity,
            root_descriptor,
            root_identity,
            _lock: lock,
            cleanup_lock: StdMutex::new(()),
            displaced_root: StdMutex::new(None),
            cleaned: AtomicBool::new(false),
        };
        for directory in [&run.codex_home, &run.workspace, &run.temp] {
            create_private_directory(directory)?;
        }
        pending_root.committed = true;
        Ok(run)
    }

    pub(super) fn write_config(&self, contents: &str) -> Result<(), SupportRuntimeError> {
        write_private_file(&self.codex_home.join("config.toml"), contents.as_bytes())
    }

    pub(super) fn snapshot_support_skill(
        &self,
        skill: &ResolvedBundledSkill,
    ) -> Result<ResolvedBundledSkill, SupportRuntimeError> {
        if !matches!(
            skill.name.as_str(),
            EXPLAIN_COMMIT_SKILL_NAME | DIRECT_PRESENCE_SKILL_NAME
        ) || skill.content_digest
            != format!(
                "sha256:{}",
                hex::encode(Sha256::digest(skill.verified_entrypoint()))
            )
        {
            return Err(SupportRuntimeError::Skill);
        }
        let skills = self.root.join("skills");
        let skill_directory = skills.join(&skill.name);
        create_private_directory(&skills)?;
        create_private_directory(&skill_directory)?;
        let snapshot = skill_directory.join("SKILL.md");
        write_private_file(&snapshot, skill.verified_entrypoint())?;
        File::open(&skill_directory)
            .and_then(|directory| directory.sync_all())
            .map_err(|_| SupportRuntimeError::PrivateRuntime)?;
        let metadata = std::fs::symlink_metadata(&snapshot)
            .map_err(|_| SupportRuntimeError::PrivateRuntime)?;
        let bytes = std::fs::read(&snapshot).map_err(|_| SupportRuntimeError::PrivateRuntime)?;
        if metadata.file_type().is_symlink()
            || !metadata.is_file()
            || metadata.uid() != current_uid()
            || metadata.mode() & 0o777 != 0o600
            || metadata.nlink() != 1
            || bytes.as_slice() != skill.verified_entrypoint()
        {
            return Err(SupportRuntimeError::PrivateRuntime);
        }
        Ok(skill.with_snapshot_path(snapshot))
    }

    pub(super) fn environment(&self, include_test_fixture: bool) -> Vec<(OsString, OsString)> {
        let mut environment = vec![
            (OsString::from("HOME"), self.root.clone().into_os_string()),
            (
                OsString::from("CODEX_HOME"),
                self.codex_home.clone().into_os_string(),
            ),
            (OsString::from("TMPDIR"), self.temp.clone().into_os_string()),
            (
                OsString::from("LANG"),
                std::env::var_os("LANG").unwrap_or_else(|| OsString::from("C.UTF-8")),
            ),
        ];
        for name in [
            "PATH",
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "ALL_PROXY",
            "NO_PROXY",
            "SSL_CERT_FILE",
            "SSL_CERT_DIR",
            "NODE_EXTRA_CA_CERTS",
        ] {
            if let Some(value) = std::env::var_os(name) {
                environment.push((OsString::from(name), value));
            }
        }
        environment.extend(
            std::env::vars_os().filter(|(name, _)| name.to_string_lossy().starts_with("LC_")),
        );
        if include_test_fixture {
            for name in [
                "CODING_WIFE_CODEX_FAKE_MODE",
                "CODING_WIFE_CODEX_FAKE_STATE",
            ] {
                if let Some(value) = std::env::var_os(name) {
                    environment.push((OsString::from(name), value));
                }
            }
        }
        environment.push((
            OsString::from("CODING_WIFE_CODEX_EXECUTION_CLASS"),
            OsString::from("support"),
        ));
        environment
    }

    pub(super) fn cleanup(&self) -> Result<(), SupportRuntimeError> {
        let _cleanup = self
            .cleanup_lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if self.cleaned.load(Ordering::Acquire) {
            return Ok(());
        }
        let descriptor_metadata = self
            .root_descriptor
            .metadata()
            .map_err(|_| SupportRuntimeError::PrivateRuntime)?;
        if directory_identity(&descriptor_metadata) != self.root_identity
            || !descriptor_metadata.is_dir()
        {
            return Err(SupportRuntimeError::PrivateRuntime);
        }
        if descriptor_metadata.nlink() == 0 {
            self.cleaned.store(true, Ordering::Release);
            return Ok(());
        }
        let cleanup_root = self.locate_linked_root()?;
        let path_metadata = exact_directory_metadata(&cleanup_root, self.root_identity)?
            .ok_or(SupportRuntimeError::PrivateRuntime)?;
        if path_metadata.mode() & 0o777 != 0o700 {
            self.root_descriptor
                .set_permissions(std::fs::Permissions::from_mode(0o700))
                .map_err(|_| SupportRuntimeError::PrivateRuntime)?;
            let repaired = exact_directory_metadata(&cleanup_root, self.root_identity)?
                .ok_or(SupportRuntimeError::PrivateRuntime)?;
            if repaired.mode() & 0o777 != 0o700 {
                return Err(SupportRuntimeError::PrivateRuntime);
            }
        }
        std::fs::remove_dir_all(&cleanup_root).map_err(|_| SupportRuntimeError::PrivateRuntime)?;
        let unlinked = self
            .root_descriptor
            .metadata()
            .map_err(|_| SupportRuntimeError::PrivateRuntime)?;
        if directory_identity(&unlinked) != self.root_identity
            || !unlinked.is_dir()
            || !directory_descriptor_is_unlinked(&unlinked)
            || exact_directory_metadata(&cleanup_root, self.root_identity)?.is_some()
            || self.descriptor_linked_path()?.is_some()
            || self.scan_root_parent()?.is_some()
        {
            return Err(SupportRuntimeError::PrivateRuntime);
        }
        *self
            .displaced_root
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
        self.cleaned.store(true, Ordering::Release);
        Ok(())
    }

    fn locate_linked_root(&self) -> Result<PathBuf, SupportRuntimeError> {
        if exact_directory_metadata(&self.root, self.root_identity)?.is_some() {
            return Ok(self.root.clone());
        }
        if let Some(displaced) = self
            .displaced_root
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
        {
            if exact_directory_metadata(&displaced, self.root_identity)?.is_some() {
                validate_candidate_parent(&displaced)?;
                return Ok(displaced);
            }
        }

        if let Some(displaced) = self.descriptor_linked_path()? {
            *self
                .displaced_root
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(displaced.clone());
            return Ok(displaced);
        }

        let displaced = self
            .scan_root_parent()?
            .ok_or(SupportRuntimeError::PrivateRuntime)?;
        *self
            .displaced_root
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(displaced.clone());
        Ok(displaced)
    }

    fn descriptor_linked_path(&self) -> Result<Option<PathBuf>, SupportRuntimeError> {
        let Some(path) = descriptor_current_path(&self.root_descriptor)? else {
            return Ok(None);
        };
        if exact_directory_metadata(&path, self.root_identity)?.is_none() {
            return Ok(None);
        }
        validate_candidate_parent(&path)?;
        Ok(Some(path))
    }

    fn scan_root_parent(&self) -> Result<Option<PathBuf>, SupportRuntimeError> {
        self.validate_root_parent()?;
        let mut matched = None;
        for entry in
            std::fs::read_dir(&self.root_parent).map_err(|_| SupportRuntimeError::PrivateRuntime)?
        {
            let path = entry
                .map_err(|_| SupportRuntimeError::PrivateRuntime)?
                .path();
            if exact_directory_metadata(&path, self.root_identity)?.is_none() {
                continue;
            }
            let descriptor = open_directory_descriptor(&path)?;
            let opened = descriptor
                .metadata()
                .map_err(|_| SupportRuntimeError::PrivateRuntime)?;
            if directory_identity(&opened) != self.root_identity || opened.nlink() == 0 {
                return Err(SupportRuntimeError::PrivateRuntime);
            }
            if matched.replace(path).is_some() {
                return Err(SupportRuntimeError::PrivateRuntime);
            }
        }
        self.validate_root_parent()?;
        Ok(matched)
    }

    fn validate_root_parent(&self) -> Result<(), SupportRuntimeError> {
        let descriptor_metadata = self
            .root_parent_descriptor
            .metadata()
            .map_err(|_| SupportRuntimeError::PrivateRuntime)?;
        let path_metadata = std::fs::symlink_metadata(&self.root_parent)
            .map_err(|_| SupportRuntimeError::PrivateRuntime)?;
        if !descriptor_metadata.is_dir()
            || directory_identity(&descriptor_metadata) != self.root_parent_identity
            || path_metadata.file_type().is_symlink()
            || !path_metadata.is_dir()
            || directory_identity(&path_metadata) != self.root_parent_identity
        {
            return Err(SupportRuntimeError::PrivateRuntime);
        }
        Ok(())
    }
}

#[cfg(target_os = "macos")]
fn descriptor_current_path(file: &File) -> Result<Option<PathBuf>, SupportRuntimeError> {
    let mut buffer = [0 as libc::c_char; libc::PATH_MAX as usize];
    // SAFETY: `file` owns a valid descriptor and `buffer` is writable for PATH_MAX bytes.
    let result = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETPATH, buffer.as_mut_ptr()) };
    if result == -1 {
        let error = std::io::Error::last_os_error();
        return if error.kind() == std::io::ErrorKind::NotFound {
            Ok(None)
        } else {
            Err(SupportRuntimeError::PrivateRuntime)
        };
    }
    // SAFETY: a successful F_GETPATH writes a NUL-terminated path into `buffer`.
    let bytes = unsafe { CStr::from_ptr(buffer.as_ptr()) }.to_bytes();
    if bytes.is_empty() {
        return Ok(None);
    }
    Ok(Some(PathBuf::from(OsStr::from_bytes(bytes))))
}

#[cfg(not(target_os = "macos"))]
fn descriptor_current_path(_file: &File) -> Result<Option<PathBuf>, SupportRuntimeError> {
    Ok(None)
}

fn validate_candidate_parent(path: &Path) -> Result<(), SupportRuntimeError> {
    let parent = path.parent().ok_or(SupportRuntimeError::PrivateRuntime)?;
    let before =
        std::fs::symlink_metadata(parent).map_err(|_| SupportRuntimeError::PrivateRuntime)?;
    if before.file_type().is_symlink()
        || !before.is_dir()
        || before.uid() != current_uid()
        || before.mode() & 0o022 != 0
    {
        return Err(SupportRuntimeError::PrivateRuntime);
    }
    let descriptor = open_directory_descriptor(parent)?;
    let opened = descriptor
        .metadata()
        .map_err(|_| SupportRuntimeError::PrivateRuntime)?;
    let after =
        std::fs::symlink_metadata(parent).map_err(|_| SupportRuntimeError::PrivateRuntime)?;
    if directory_identity(&opened) != directory_identity(&before)
        || directory_identity(&after) != directory_identity(&before)
        || after.file_type().is_symlink()
        || !after.is_dir()
    {
        return Err(SupportRuntimeError::PrivateRuntime);
    }
    Ok(())
}

fn directory_descriptor_is_unlinked(metadata: &std::fs::Metadata) -> bool {
    #[cfg(target_os = "macos")]
    {
        metadata.nlink() == 2
    }
    #[cfg(not(target_os = "macos"))]
    {
        metadata.nlink() == 0
    }
}

fn exact_directory_metadata(
    path: &Path,
    identity: DirectoryIdentity,
) -> Result<Option<std::fs::Metadata>, SupportRuntimeError> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata)
            if !metadata.file_type().is_symlink()
                && metadata.is_dir()
                && directory_identity(&metadata) == identity =>
        {
            Ok(Some(metadata))
        }
        Ok(_) => Ok(None),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(SupportRuntimeError::PrivateRuntime),
    }
}

fn cleanup_stale_run_directories() -> Result<(), SupportRuntimeError> {
    let temp = std::env::temp_dir();
    let current_process_marker = format!("-{}-", std::process::id());
    for entry in std::fs::read_dir(&temp).map_err(|_| SupportRuntimeError::PrivateRuntime)? {
        let entry = entry.map_err(|_| SupportRuntimeError::PrivateRuntime)?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.starts_with(RUN_DIRECTORY_PREFIX) || name.contains(&current_process_marker) {
            continue;
        }
        let path = entry.path();
        let before = match std::fs::symlink_metadata(&path) {
            Ok(metadata)
                if !metadata.file_type().is_symlink()
                    && metadata.is_dir()
                    && metadata.uid() == current_uid() =>
            {
                metadata
            }
            _ => continue,
        };
        let identity = directory_identity(&before);
        let descriptor = open_directory_descriptor(&path)?;
        let opened = descriptor
            .metadata()
            .map_err(|_| SupportRuntimeError::PrivateRuntime)?;
        if directory_identity(&opened) != identity || !opened.is_dir() {
            return Err(SupportRuntimeError::PrivateRuntime);
        }
        if opened.mode() & 0o777 != 0o700 {
            descriptor
                .set_permissions(std::fs::Permissions::from_mode(0o700))
                .map_err(|_| SupportRuntimeError::PrivateRuntime)?;
        }
        let lock = match open_existing_lock_file(&path.join(RUN_LOCK_FILE)) {
            Ok(lock) => lock,
            Err(_) => continue,
        };
        if !try_lock_file(&lock)? {
            continue;
        }
        let after =
            std::fs::symlink_metadata(&path).map_err(|_| SupportRuntimeError::PrivateRuntime)?;
        if after.file_type().is_symlink()
            || !after.is_dir()
            || directory_identity(&after) != identity
            || after.mode() & 0o777 != 0o700
        {
            return Err(SupportRuntimeError::PrivateRuntime);
        }
        std::fs::remove_dir_all(&path).map_err(|_| SupportRuntimeError::PrivateRuntime)?;
        if path.exists() {
            return Err(SupportRuntimeError::PrivateRuntime);
        }
    }
    Ok(())
}

fn create_lock_file(path: &Path) -> Result<File, SupportRuntimeError> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(O_NOFOLLOW | O_CLOEXEC)
        .open(path)
        .map_err(|_| SupportRuntimeError::PrivateRuntime)?;
    validate_lock_file(&file)?;
    if !try_lock_file(&file)? {
        return Err(SupportRuntimeError::PrivateRuntime);
    }
    file.sync_all()
        .map_err(|_| SupportRuntimeError::PrivateRuntime)?;
    Ok(file)
}

fn open_existing_lock_file(path: &Path) -> Result<File, SupportRuntimeError> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .custom_flags(O_NOFOLLOW | O_CLOEXEC)
        .open(path)
        .map_err(|_| SupportRuntimeError::PrivateRuntime)?;
    validate_lock_file(&file)?;
    Ok(file)
}

fn validate_lock_file(file: &File) -> Result<(), SupportRuntimeError> {
    let metadata = file
        .metadata()
        .map_err(|_| SupportRuntimeError::PrivateRuntime)?;
    if !metadata.is_file()
        || metadata.uid() != current_uid()
        || metadata.mode() & 0o777 != 0o600
        || metadata.nlink() != 1
    {
        return Err(SupportRuntimeError::PrivateRuntime);
    }
    Ok(())
}

fn try_lock_file(file: &File) -> Result<bool, SupportRuntimeError> {
    #[cfg(unix)]
    {
        // SAFETY: flock only observes the valid descriptor owned by `file`.
        let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
        if result == 0 {
            return Ok(true);
        }
        let error = std::io::Error::last_os_error();
        if error.kind() == std::io::ErrorKind::WouldBlock {
            Ok(false)
        } else {
            Err(SupportRuntimeError::PrivateRuntime)
        }
    }

    #[cfg(windows)]
    {
        type Handle = *mut std::ffi::c_void;
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn LockFile(
                file: Handle,
                offset_low: u32,
                offset_high: u32,
                bytes_low: u32,
                bytes_high: u32,
            ) -> i32;
        }

        // SAFETY: the handle is borrowed from a live File and LockFile does not retain it.
        let locked = unsafe { LockFile(file.as_raw_handle().cast(), 0, 0, u32::MAX, u32::MAX) };
        if locked != 0 {
            return Ok(true);
        }
        match std::io::Error::last_os_error().raw_os_error() {
            Some(32 | 33) => Ok(false),
            _ => Err(SupportRuntimeError::PrivateRuntime),
        }
    }
}

impl Drop for PrivateRunDirectory {
    fn drop(&mut self) {
        let _ = self.cleanup();
    }
}

fn open_directory_descriptor(path: &Path) -> Result<File, SupportRuntimeError> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        .open(path)
        .map_err(|_| SupportRuntimeError::PrivateRuntime)?;
    let metadata = file
        .metadata()
        .map_err(|_| SupportRuntimeError::PrivateRuntime)?;
    if !metadata.is_dir() || metadata.uid() != current_uid() {
        return Err(SupportRuntimeError::PrivateRuntime);
    }
    Ok(file)
}

fn directory_identity(metadata: &std::fs::Metadata) -> DirectoryIdentity {
    DirectoryIdentity {
        device: metadata.dev(),
        inode: metadata.ino(),
        owner: metadata.uid(),
    }
}

fn create_private_directory(path: &Path) -> Result<(), SupportRuntimeError> {
    std::fs::create_dir(path).map_err(|_| SupportRuntimeError::PrivateRuntime)?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
        .map_err(|_| SupportRuntimeError::PrivateRuntime)?;
    validate_private_directory(path)
}

fn validate_private_directory(path: &Path) -> Result<(), SupportRuntimeError> {
    let metadata =
        std::fs::symlink_metadata(path).map_err(|_| SupportRuntimeError::PrivateRuntime)?;
    if metadata.file_type().is_symlink()
        || !metadata.is_dir()
        || metadata.uid() != current_uid()
        || metadata.mode() & 0o777 != 0o700
    {
        return Err(SupportRuntimeError::PrivateRuntime);
    }
    Ok(())
}

pub(super) fn write_private_file(path: &Path, contents: &[u8]) -> Result<(), SupportRuntimeError> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(O_NOFOLLOW | O_CLOEXEC)
        .open(path)
        .map_err(|_| SupportRuntimeError::PrivateRuntime)?;
    file.write_all(contents)
        .and_then(|_| file.sync_all())
        .map_err(|_| SupportRuntimeError::PrivateRuntime)?;
    let metadata = file
        .metadata()
        .map_err(|_| SupportRuntimeError::PrivateRuntime)?;
    if !metadata.is_file() || metadata.uid() != current_uid() || metadata.mode() & 0o777 != 0o600 {
        return Err(SupportRuntimeError::PrivateRuntime);
    }
    Ok(())
}

pub(super) fn bridge_auth(source: &Path, codex_home: &Path) -> Result<(), SupportRuntimeError> {
    validate_auth_parent_chain(source.parent().ok_or(SupportRuntimeError::AuthBridge)?)?;
    let before = std::fs::symlink_metadata(source).map_err(|_| SupportRuntimeError::AuthBridge)?;
    if before.file_type().is_symlink()
        || !before.is_file()
        || before.uid() != current_uid()
        || before.mode() & 0o777 != 0o600
        || before.nlink() != 1
        || before.len() == 0
        || before.len() > MAX_AUTH_BYTES
    {
        return Err(SupportRuntimeError::AuthBridge);
    }
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(O_NOFOLLOW | O_CLOEXEC)
        .open(source)
        .map_err(|_| SupportRuntimeError::AuthBridge)?;
    let opened = file
        .metadata()
        .map_err(|_| SupportRuntimeError::AuthBridge)?;
    if file_identity(&opened) != file_identity(&before) {
        return Err(SupportRuntimeError::AuthBridge);
    }
    let mut bytes = Vec::with_capacity(usize::try_from(before.len()).unwrap_or(0));
    std::io::Read::by_ref(&mut file)
        .take(MAX_AUTH_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| SupportRuntimeError::AuthBridge)?;
    let after = std::fs::symlink_metadata(source).map_err(|_| SupportRuntimeError::AuthBridge)?;
    if file_identity(&after) != file_identity(&before)
        || bytes.len() as u64 != before.len()
        || !serde_json::from_slice::<Value>(&bytes)
            .ok()
            .is_some_and(|value| value.is_object())
    {
        return Err(SupportRuntimeError::AuthBridge);
    }

    let temporary = codex_home.join(format!(".auth-{}.tmp", uuid::Uuid::new_v4()));
    write_private_file(&temporary, &bytes).map_err(|_| SupportRuntimeError::AuthBridge)?;
    let destination = codex_home.join("auth.json");
    std::fs::rename(&temporary, &destination).map_err(|_| SupportRuntimeError::AuthBridge)?;
    File::open(codex_home)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| SupportRuntimeError::AuthBridge)?;
    let destination_metadata =
        std::fs::symlink_metadata(destination).map_err(|_| SupportRuntimeError::AuthBridge)?;
    if !destination_metadata.is_file()
        || destination_metadata.file_type().is_symlink()
        || destination_metadata.uid() != current_uid()
        || destination_metadata.mode() & 0o777 != 0o600
    {
        return Err(SupportRuntimeError::AuthBridge);
    }
    Ok(())
}

fn validate_auth_parent_chain(directory: &Path) -> Result<(), SupportRuntimeError> {
    let mut current = Some(directory);
    while let Some(path) = current {
        let metadata =
            std::fs::symlink_metadata(path).map_err(|_| SupportRuntimeError::AuthBridge)?;
        let owner = metadata.uid();
        if metadata.file_type().is_symlink()
            || !metadata.is_dir()
            || !matches!(owner, 0) && owner != current_uid()
            || metadata.mode() & 0o022 != 0
        {
            return Err(SupportRuntimeError::AuthBridge);
        }
        current = path.parent();
    }
    Ok(())
}

fn file_identity(metadata: &std::fs::Metadata) -> (u64, u64, u64, i64, i64, u32, u32) {
    (
        metadata.dev(),
        metadata.ino(),
        metadata.len(),
        metadata.mtime(),
        metadata.mtime_nsec(),
        metadata.uid(),
        metadata.mode(),
    )
}

fn current_uid() -> u32 {
    current_user_id()
}

pub(super) fn support_config(model: &str, mock_base_url: Option<&str>) -> String {
    let provider = mock_base_url.map_or_else(String::new, |base_url| {
        format!(
            "\n[model_providers.mock_provider]\nname = \"Support probe\"\nbase_url = \"{base_url}\"\nwire_api = \"responses\"\nrequest_max_retries = 0\nstream_max_retries = 0\nsupports_websockets = false\n"
        )
    });
    let model_provider = if mock_base_url.is_some() {
        "model_provider = \"mock_provider\"\n"
    } else {
        ""
    };
    format!(
        "model = \"{model}\"\n{model_provider}approval_policy = \"never\"\ndefault_permissions = \"{SUPPORT_PERMISSION_PROFILE}\"\nweb_search = \"disabled\"\n\n[shell_environment_policy]\ninherit = \"none\"\nignore_default_excludes = false\n\n[tools.experimental_request_user_input]\nenabled = false\n\n[orchestrator.skills]\nenabled = false\n\n[orchestrator.mcp]\nenabled = false\n\n[skills]\ninclude_instructions = false\n\n[skills.bundled]\nenabled = false\n\n[features]\nshell_tool = false\nmulti_agent = false\napps = false\nplugins = false\nimage_generation = false\ngoals = false\nenable_fanout = false\nrequest_permissions = false\nexec_permission_approvals = false\ndefault_mode_request_user_input = false\n\n[permissions.{SUPPORT_PERMISSION_PROFILE}]\ndescription = \"No tool authority support runtime\"\n\n[permissions.{SUPPORT_PERMISSION_PROFILE}.filesystem]\n\":minimal\" = \"read\"\n\n[permissions.{SUPPORT_PERMISSION_PROFILE}.network]\nenabled = false\n{provider}"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn support_config_pins_the_requested_role_model_and_zero_authority() {
        let terra = support_config(crate::codex::types::CODEX_COMMIT_EXPLAINER_MODEL, None);

        assert!(terra.contains("model = \"gpt-5.6-terra\""));
        assert!(!terra.contains("gpt-5.6-sol"));
        assert!(!terra.contains("gpt-5.6-luna"));
        assert!(terra.contains("default_permissions = \"coding-wife-support-zero\""));

        let luna = support_config(crate::codex::types::CODEX_PRESENCE_DIRECTOR_MODEL, None);
        assert!(luna.contains("model = \"gpt-5.6-luna\""));
        assert!(!luna.contains("gpt-5.6-sol"));
        assert!(!luna.contains("gpt-5.6-terra"));
        assert!(luna.contains("default_permissions = \"coding-wife-support-zero\""));
    }

    fn write_auth_copy(run: &PrivateRunDirectory) -> PathBuf {
        let auth = run.codex_home.join("auth.json");
        write_private_file(&auth, br#"{"token":"fixture"}"#).expect("private auth copy");
        auth
    }

    #[test]
    fn next_runtime_removes_only_an_unlocked_stale_private_directory() {
        let stale = std::env::temp_dir().join(format!(
            "{RUN_DIRECTORY_PREFIX}stale-0-{}",
            uuid::Uuid::new_v4()
        ));
        create_private_directory(&stale).expect("stale support directory");
        let lock = create_lock_file(&stale.join(RUN_LOCK_FILE)).expect("stale support lock");
        write_private_file(&stale.join("auth-copy"), b"stale").expect("stale private contents");
        drop(lock);

        let active = PrivateRunDirectory::create("cleanup-test").expect("active support runtime");
        assert!(!stale.exists());
        assert!(active.root.exists());
        active.cleanup().expect("active support cleanup");
    }

    #[test]
    fn cleanup_repairs_same_identity_mode_drift_and_removes_auth() {
        let run = PrivateRunDirectory::create("unsafe-mode-cleanup").expect("support runtime");
        let root = run.root.clone();
        let auth = write_auth_copy(&run);
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o711))
            .expect("drift root mode");

        run.cleanup().expect("identity-safe cleanup");

        assert!(!auth.exists(), "copied auth survived cleanup");
        assert!(!root.exists(), "private root survived cleanup");
    }

    #[test]
    fn rename_only_cleanup_removes_the_displaced_auth_inode() {
        let run = PrivateRunDirectory::create("rename-only-cleanup").expect("support runtime");
        let root = run.root.clone();
        let displaced = root.with_extension("displaced");
        let auth = write_auth_copy(&run);
        std::fs::rename(&root, &displaced).expect("displace original root");

        let result = run.cleanup();
        let auth_survived = displaced.join("codex-home/auth.json").exists() || auth.exists();
        let displaced_survived = displaced.exists();
        let descriptor_unlinked = directory_descriptor_is_unlinked(
            &run.root_descriptor
                .metadata()
                .expect("root descriptor metadata"),
        );
        let cleaned = run.cleaned.load(Ordering::Acquire);
        let _ = std::fs::remove_dir_all(&displaced);
        drop(run);

        assert_eq!(result, Ok(()));
        assert!(!auth_survived, "copied auth survived rename-only cleanup");
        assert!(
            !displaced_survived,
            "displaced private root survived cleanup"
        );
        assert!(descriptor_unlinked, "auth-bearing inode remained linked");
        assert!(
            cleaned,
            "verified disappearance did not mark cleanup complete"
        );
    }

    #[test]
    fn rename_with_replacement_removes_only_the_displaced_auth_inode() {
        let run =
            PrivateRunDirectory::create("rename-replacement-cleanup").expect("support runtime");
        let root = run.root.clone();
        let displaced = root.with_extension("displaced");
        write_auth_copy(&run);
        std::fs::rename(&root, &displaced).expect("displace original root");
        create_private_directory(&root).expect("replacement root");
        let replacement_marker = root.join("replacement-marker");
        write_private_file(&replacement_marker, b"keep").expect("replacement marker");
        let replacement_identity =
            directory_identity(&std::fs::symlink_metadata(&root).expect("replacement metadata"));

        let result = run.cleanup();
        let displaced_auth_survived = displaced.join("codex-home/auth.json").exists();
        let displaced_survived = displaced.exists();
        let replacement_untouched = replacement_marker.exists()
            && std::fs::symlink_metadata(&root)
                .ok()
                .is_some_and(|metadata| directory_identity(&metadata) == replacement_identity);
        let descriptor_unlinked = directory_descriptor_is_unlinked(
            &run.root_descriptor
                .metadata()
                .expect("root descriptor metadata"),
        );
        let _ = std::fs::remove_dir_all(&displaced);
        let _ = std::fs::remove_dir_all(&root);
        drop(run);

        assert_eq!(result, Ok(()));
        assert!(!displaced_auth_survived, "displaced auth survived cleanup");
        assert!(
            !displaced_survived,
            "displaced private root survived cleanup"
        );
        assert!(
            replacement_untouched,
            "cleanup changed the replacement inode"
        );
        assert!(descriptor_unlinked, "auth-bearing inode remained linked");
    }

    #[test]
    fn renamed_mode_drift_is_repaired_before_cleanup() {
        let run = PrivateRunDirectory::create("renamed-mode-cleanup").expect("support runtime");
        let root = run.root.clone();
        let displaced = root.with_extension("displaced");
        write_auth_copy(&run);
        std::fs::rename(&root, &displaced).expect("displace original root");
        std::fs::set_permissions(&displaced, std::fs::Permissions::from_mode(0o711))
            .expect("drift displaced root mode");

        let result = run.cleanup();
        let displaced_survived = displaced.exists();
        let descriptor_unlinked = directory_descriptor_is_unlinked(
            &run.root_descriptor
                .metadata()
                .expect("root descriptor metadata"),
        );
        let _ = std::fs::set_permissions(&displaced, std::fs::Permissions::from_mode(0o700));
        let _ = std::fs::remove_dir_all(&displaced);
        drop(run);

        assert_eq!(result, Ok(()));
        assert!(!displaced_survived, "mode-drifted displaced root survived");
        assert!(descriptor_unlinked, "mode-drifted inode remained linked");
    }

    #[test]
    fn failed_displaced_removal_keeps_drop_retry_enabled() {
        let run = PrivateRunDirectory::create("cleanup-retry").expect("support runtime");
        let root = run.root.clone();
        let container = std::env::temp_dir().join(format!(
            ".coding-wife-support-container-{}",
            uuid::Uuid::new_v4()
        ));
        create_private_directory(&container).expect("displacement container");
        let nested_displaced = container.join("private-root");
        write_auth_copy(&run);
        std::fs::rename(&root, &nested_displaced).expect("hide original root from parent scan");
        std::fs::set_permissions(&container, std::fs::Permissions::from_mode(0o500))
            .expect("block removal from displacement container");

        let result = run.cleanup();
        let cleaned_after_failure = run.cleaned.load(Ordering::Acquire);
        let inode_remained_for_retry = nested_displaced.exists();
        std::fs::set_permissions(&container, std::fs::Permissions::from_mode(0o700))
            .expect("restore displacement container mode");
        std::fs::rename(&nested_displaced, &root).expect("restore original root identity");
        drop(run);
        let root_survived_drop = root.exists();
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&container);

        assert_eq!(result, Err(SupportRuntimeError::PrivateRuntime));
        assert!(!cleaned_after_failure, "failed cleanup disabled Drop retry");
        assert!(
            inode_remained_for_retry,
            "failed cleanup lost the auth-bearing inode before retry"
        );
        assert!(!root_survived_drop, "Drop did not retry the failed cleanup");
    }

    #[test]
    fn next_runtime_recovers_a_displaced_stale_auth_without_touching_replacement() {
        let stale = std::env::temp_dir().join(format!(
            "{RUN_DIRECTORY_PREFIX}stale-0-{}",
            uuid::Uuid::new_v4()
        ));
        let displaced = stale.with_extension("displaced");
        create_private_directory(&stale).expect("stale support directory");
        let lock = create_lock_file(&stale.join(RUN_LOCK_FILE)).expect("stale support lock");
        let stale_home = stale.join("codex-home");
        create_private_directory(&stale_home).expect("stale Codex home");
        write_private_file(&stale_home.join("auth.json"), br#"{"token":"stale"}"#)
            .expect("stale auth copy");
        std::fs::rename(&stale, &displaced).expect("displace stale private root");
        create_private_directory(&stale).expect("replacement root");
        let replacement_marker = stale.join("replacement-marker");
        write_private_file(&replacement_marker, b"keep").expect("replacement marker");
        let replacement_identity =
            directory_identity(&std::fs::symlink_metadata(&stale).expect("replacement metadata"));
        drop(lock);

        let active =
            PrivateRunDirectory::create("displaced-stale-recovery").expect("next support runtime");

        assert!(
            !displaced.exists(),
            "next start left displaced auth on disk"
        );
        assert!(
            replacement_marker.exists(),
            "next start removed replacement content"
        );
        assert_eq!(
            directory_identity(&std::fs::symlink_metadata(&stale).expect("replacement metadata")),
            replacement_identity,
            "next start replaced the replacement inode"
        );
        active.cleanup().expect("active support cleanup");
        std::fs::remove_dir_all(&stale).expect("remove replacement root");
    }

    #[test]
    fn next_runtime_recovers_unlocked_stale_auth_after_mode_drift() {
        let stale = std::env::temp_dir().join(format!(
            "{RUN_DIRECTORY_PREFIX}stale-0-{}",
            uuid::Uuid::new_v4()
        ));
        create_private_directory(&stale).expect("stale support directory");
        let lock = create_lock_file(&stale.join(RUN_LOCK_FILE)).expect("stale support lock");
        let stale_home = stale.join("codex-home");
        create_private_directory(&stale_home).expect("stale Codex home");
        write_private_file(&stale_home.join("auth.json"), br#"{"token":"stale"}"#)
            .expect("stale auth copy");
        std::fs::set_permissions(&stale, std::fs::Permissions::from_mode(0o711))
            .expect("drift stale mode");
        drop(lock);

        let active = PrivateRunDirectory::create("stale-recovery").expect("next runtime");

        assert!(!stale.exists(), "next start left stale auth on disk");
        active.cleanup().expect("active support cleanup");
    }
}
