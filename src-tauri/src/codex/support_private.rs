use std::ffi::OsString;
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::Value;
use sha2::{Digest, Sha256};

use super::bundled_skill::{ResolvedBundledSkill, EXPLAIN_COMMIT_SKILL_NAME};
use super::support::{SupportRuntimeError, SUPPORT_PERMISSION_PROFILE};
use super::types::CODEX_MODEL;

const MAX_AUTH_BYTES: u64 = 1024 * 1024;
const RUN_DIRECTORY_PREFIX: &str = "coding-wife-support-";
const RUN_LOCK_FILE: &str = ".runtime.lock";

pub(super) struct PrivateRunDirectory {
    pub(super) root: PathBuf,
    pub(super) codex_home: PathBuf,
    pub(super) workspace: PathBuf,
    temp: PathBuf,
    _lock: File,
    cleaned: AtomicBool,
}

impl PrivateRunDirectory {
    pub(super) fn create(label: &str) -> Result<Self, SupportRuntimeError> {
        cleanup_stale_run_directories()?;
        let root = std::env::temp_dir().join(format!(
            "{RUN_DIRECTORY_PREFIX}{label}-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        create_private_directory(&root)?;
        let lock = create_lock_file(&root.join(RUN_LOCK_FILE))?;
        let codex_home = root.join("codex-home");
        let workspace = root.join("workspace");
        let temp = root.join("tmp");
        for directory in [&codex_home, &workspace, &temp] {
            create_private_directory(directory)?;
        }
        Ok(Self {
            root,
            codex_home,
            workspace,
            temp,
            _lock: lock,
            cleaned: AtomicBool::new(false),
        })
    }

    pub(super) fn write_config(&self, contents: &str) -> Result<(), SupportRuntimeError> {
        write_private_file(&self.codex_home.join("config.toml"), contents.as_bytes())
    }

    pub(super) fn snapshot_support_skill(
        &self,
        skill: &ResolvedBundledSkill,
    ) -> Result<ResolvedBundledSkill, SupportRuntimeError> {
        if skill.name != EXPLAIN_COMMIT_SKILL_NAME
            || skill.content_digest
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
        if self.cleaned.swap(true, Ordering::AcqRel) {
            return Ok(());
        }
        validate_private_directory(&self.root)?;
        std::fs::remove_dir_all(&self.root).map_err(|_| SupportRuntimeError::PrivateRuntime)?;
        if self.root.exists() {
            return Err(SupportRuntimeError::PrivateRuntime);
        }
        Ok(())
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
                    && metadata.uid() == current_uid()
                    && metadata.mode() & 0o777 == 0o700 =>
            {
                metadata
            }
            _ => continue,
        };
        let lock = match open_existing_lock_file(&path.join(RUN_LOCK_FILE)) {
            Ok(lock) => lock,
            Err(_) => continue,
        };
        if !try_lock_file(&lock)? {
            continue;
        }
        let after =
            std::fs::symlink_metadata(&path).map_err(|_| SupportRuntimeError::PrivateRuntime)?;
        if before.dev() != after.dev()
            || before.ino() != after.ino()
            || after.file_type().is_symlink()
            || !after.is_dir()
            || after.uid() != current_uid()
            || after.mode() & 0o777 != 0o700
        {
            return Err(SupportRuntimeError::PrivateRuntime);
        }
        std::fs::remove_dir_all(&path).map_err(|_| SupportRuntimeError::PrivateRuntime)?;
    }
    Ok(())
}

fn create_lock_file(path: &Path) -> Result<File, SupportRuntimeError> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
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
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
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

impl Drop for PrivateRunDirectory {
    fn drop(&mut self) {
        if !self.cleaned.swap(true, Ordering::AcqRel) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
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
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
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
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
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

unsafe extern "C" {
    fn getuid() -> u32;
}

fn current_uid() -> u32 {
    // SAFETY: getuid has no arguments and cannot fail.
    unsafe { getuid() }
}

pub(super) fn support_config(mock_base_url: Option<&str>) -> String {
    let provider = mock_base_url.map_or_else(String::new, |base_url| {
        format!(
            "\n[model_providers.mock_provider]\nname = \"Support probe\"\nbase_url = \"{base_url}\"\nwire_api = \"responses\"\nrequest_max_retries = 0\nstream_max_retries = 0\nsupports_websockets = false\n"
        )
    });
    let model = CODEX_MODEL;
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
}
