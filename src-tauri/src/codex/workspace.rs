use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;

use super::process::{run_bounded_command, BoundedCommandError, BoundedCommandOutput};
use super::supervisor::CodexSupervisor;
use super::types::CodexCommandError;

pub const WORKSPACE_REGISTRATION_SCHEMA_VERSION: u16 = 1;
const WORKSPACE_GIT_TIMEOUT: Duration = Duration::from_secs(5);
const WORKSPACE_GIT_STDERR_LIMIT: usize = 4 * 1024;

pub type PickerFuture<'a> = Pin<Box<dyn Future<Output = Option<PathBuf>> + Send + 'a>>;

pub trait FolderPicker: Send + Sync {
    fn pick_folder(&self) -> PickerFuture<'_>;
}

pub struct NativeFolderPicker;

impl FolderPicker for NativeFolderPicker {
    fn pick_folder(&self) -> PickerFuture<'_> {
        Box::pin(async {
            rfd::AsyncFileDialog::new()
                .set_title("Select a Git repository")
                .pick_folder()
                .await
                .map(|handle| handle.path().to_path_buf())
        })
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct WorkspacePreflight {
    pub git_repository: bool,
    pub owned_by_current_user: bool,
    pub writable: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct WorkspaceRegistration {
    pub schema_version: u16,
    pub workspace_id: String,
    pub alias: String,
    pub preflight: WorkspacePreflight,
}

/// This record belongs to the app-private persistence layer. It must never be
/// accepted as an IPC command argument or serialized to the WebView.
#[derive(Clone, Debug)]
pub struct AppPrivateWorkspaceRecord {
    pub workspace_id: String,
    pub alias: String,
    pub canonical_root: PathBuf,
}

/// This record belongs to app-private settings and is deliberately not a
/// serializable IPC type.
#[derive(Clone, Debug)]
pub struct AppPrivateBinaryRecord {
    pub canonical_path: PathBuf,
}

#[derive(Clone, Debug)]
pub struct GitRepositoryIdentity {
    pub canonical_root: PathBuf,
    pub canonical_git_dir: PathBuf,
    pub root_device: u64,
    pub root_inode: u64,
    pub git_device: u64,
    pub git_inode: u64,
    pub project_identity: String,
    pub branch: String,
    pub head: String,
    pub detached: bool,
}

#[derive(Clone, Debug)]
pub struct ValidatedWorkspaceCandidate {
    pub registration: WorkspaceRegistration,
    pub git: GitRepositoryIdentity,
}

#[derive(Clone, Debug)]
struct TrustedWorkspace {
    root: PathBuf,
    registration: WorkspaceRegistration,
}

#[derive(Clone)]
pub struct WorkspaceService {
    supervisor: CodexSupervisor,
    picker: Arc<dyn FolderPicker>,
    trusted: Arc<Mutex<HashMap<String, TrustedWorkspace>>>,
}

impl WorkspaceService {
    pub fn production(supervisor: CodexSupervisor) -> Self {
        Self::new(supervisor, Arc::new(NativeFolderPicker))
    }

    pub fn new(supervisor: CodexSupervisor, picker: Arc<dyn FolderPicker>) -> Self {
        Self {
            supervisor,
            picker,
            trusted: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn pick_and_register(&self) -> Result<WorkspaceRegistration, CodexCommandError> {
        let candidate = self.pick_validated().await?;
        self.activate_candidate(candidate).await
    }

    pub async fn pick_validated(&self) -> Result<ValidatedWorkspaceCandidate, CodexCommandError> {
        let selected = self
            .picker
            .pick_folder()
            .await
            .ok_or_else(|| workspace_error("CODEX-WORKSPACE-PICK-CANCELED", true))?;
        self.validate_candidate(
            selected,
            format!("workspace-{}", uuid::Uuid::new_v4()),
            None,
        )
        .await
    }

    pub async fn restore_private_workspace(
        &self,
        record: AppPrivateWorkspaceRecord,
    ) -> Result<WorkspaceRegistration, CodexCommandError> {
        validate_workspace_id(&record.workspace_id)?;
        let alias = validate_alias(&record.alias)?;
        let candidate = self
            .validate_candidate(record.canonical_root, record.workspace_id, Some(alias))
            .await?;
        self.activate_candidate(candidate).await
    }

    pub async fn apply_private_binary(
        &self,
        record: AppPrivateBinaryRecord,
    ) -> Result<(), CodexCommandError> {
        let canonical_path = tokio::fs::canonicalize(record.canonical_path)
            .await
            .map_err(|_| workspace_error("CODEX-BINARY-PRIVATE-MISSING", true))?;
        if !tokio::fs::metadata(&canonical_path)
            .await
            .is_ok_and(|metadata| metadata.is_file())
        {
            return Err(workspace_error("CODEX-BINARY-PRIVATE-INVALID", false));
        }
        self.supervisor
            .set_explicit_binary(Some(canonical_path))
            .await;
        Ok(())
    }

    pub async fn trusted_root(&self, workspace_id: &str) -> Option<PathBuf> {
        self.trusted
            .lock()
            .await
            .get(workspace_id)
            .map(|record| record.root.clone())
    }

    pub async fn deactivate_workspace(&self, workspace_id: &str) -> Result<(), CodexCommandError> {
        self.supervisor
            .unregister_workspace_root(workspace_id)
            .await?;
        self.trusted.lock().await.remove(workspace_id);
        Ok(())
    }

    pub async fn activate_candidate(
        &self,
        candidate: ValidatedWorkspaceCandidate,
    ) -> Result<WorkspaceRegistration, CodexCommandError> {
        if let Some(existing) = self
            .trusted
            .lock()
            .await
            .get(&candidate.registration.workspace_id)
            .cloned()
        {
            if existing.root != candidate.git.canonical_root {
                return Err(workspace_error("CODEX-WORKSPACE-IDENTITY-CHANGED", false));
            }
            return Ok(existing.registration);
        }
        let registration = candidate.registration;
        self.supervisor
            .register_workspace_root(
                registration.workspace_id.clone(),
                &candidate.git.canonical_root,
            )
            .await?;
        self.trusted.lock().await.insert(
            registration.workspace_id.clone(),
            TrustedWorkspace {
                root: candidate.git.canonical_root,
                registration: registration.clone(),
            },
        );
        Ok(registration)
    }

    pub async fn validate_private_candidate(
        &self,
        record: &AppPrivateWorkspaceRecord,
    ) -> Result<ValidatedWorkspaceCandidate, CodexCommandError> {
        validate_workspace_id(&record.workspace_id)?;
        let alias = validate_alias(&record.alias)?;
        self.validate_candidate(
            record.canonical_root.clone(),
            record.workspace_id.clone(),
            Some(alias),
        )
        .await
    }

    async fn validate_candidate(
        &self,
        selected: PathBuf,
        workspace_id: String,
        alias: Option<String>,
    ) -> Result<ValidatedWorkspaceCandidate, CodexCommandError> {
        let git = validate_git_repository(&selected).await?;
        validate_workspace_id(&workspace_id)?;
        let alias = alias.unwrap_or_else(|| repository_alias(&git.canonical_root));
        let registration = WorkspaceRegistration {
            schema_version: WORKSPACE_REGISTRATION_SCHEMA_VERSION,
            workspace_id,
            alias,
            preflight: WorkspacePreflight {
                git_repository: true,
                owned_by_current_user: true,
                writable: true,
            },
        };
        Ok(ValidatedWorkspaceCandidate { registration, git })
    }
}

pub async fn validate_git_repository(
    selected: &Path,
) -> Result<GitRepositoryIdentity, CodexCommandError> {
    let canonical = tokio::fs::canonicalize(selected)
        .await
        .map_err(|_| workspace_error("CODEX-WORKSPACE-MISSING", true))?;
    let metadata = tokio::fs::symlink_metadata(&canonical)
        .await
        .map_err(|_| workspace_error("CODEX-WORKSPACE-MISSING", true))?;
    if !metadata.is_dir() {
        return Err(workspace_error("CODEX-WORKSPACE-NOT-DIRECTORY", false));
    }
    let marker = canonical.join(".git");
    let marker_metadata = tokio::fs::symlink_metadata(&marker)
        .await
        .map_err(|_| workspace_error("CODEX-WORKSPACE-NOT-GIT", false))?;
    if marker_metadata.file_type().is_symlink() {
        return Err(workspace_error("CODEX-WORKSPACE-GIT-SYMLINK", false));
    }
    let git_directory = if marker_metadata.is_dir() {
        marker
    } else if marker_metadata.is_file() {
        validate_private_regular_file(&marker_metadata)?;
        resolve_worktree_gitdir(&canonical, &marker).await?
    } else {
        return Err(workspace_error("CODEX-WORKSPACE-NOT-GIT", false));
    };
    let head = tokio::fs::symlink_metadata(git_directory.join("HEAD"))
        .await
        .map_err(|_| workspace_error("CODEX-WORKSPACE-GIT-INVALID", false))?;
    if !head.is_file() || head.file_type().is_symlink() {
        return Err(workspace_error("CODEX-WORKSPACE-GIT-INVALID", false));
    }
    validate_private_regular_file(&head)?;
    validate_repository_ownership(&canonical, &git_directory).await?;
    validate_git_root_closure(&canonical, &git_directory).await?;
    repository_identity(canonical, git_directory).await
}

fn validate_private_regular_file(metadata: &std::fs::Metadata) -> Result<(), CodexCommandError> {
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(workspace_error("CODEX-WORKSPACE-GIT-INVALID", false));
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};

        let uid = unsafe { libc::geteuid() };
        if metadata.uid() != uid && metadata.uid() != 0 {
            return Err(workspace_error("CODEX-WORKSPACE-OWNER-MISMATCH", false));
        }
        let mode = metadata.permissions().mode();
        if mode & 0o022 != 0 {
            return Err(workspace_error("CODEX-WORKSPACE-WRITABLE-POLICY", false));
        }
        if mode & 0o200 == 0 {
            return Err(workspace_error("CODEX-WORKSPACE-READ-ONLY", false));
        }
    }

    #[cfg(not(unix))]
    if metadata.permissions().readonly() {
        return Err(workspace_error("CODEX-WORKSPACE-READ-ONLY", false));
    }

    Ok(())
}

async fn resolve_worktree_gitdir(root: &Path, marker: &Path) -> Result<PathBuf, CodexCommandError> {
    let metadata = tokio::fs::metadata(marker)
        .await
        .map_err(|_| workspace_error("CODEX-WORKSPACE-GIT-INVALID", false))?;
    if metadata.len() > 4_096 {
        return Err(workspace_error("CODEX-WORKSPACE-GIT-INVALID", false));
    }
    let value = tokio::fs::read_to_string(marker)
        .await
        .map_err(|_| workspace_error("CODEX-WORKSPACE-GIT-INVALID", false))?;
    let relative = value
        .strip_prefix("gitdir:")
        .map(str::trim)
        .filter(|path| !path.is_empty() && !path.contains('\0'))
        .ok_or_else(|| workspace_error("CODEX-WORKSPACE-GIT-INVALID", false))?;
    let path = Path::new(relative);
    tokio::fs::canonicalize(if path.is_absolute() {
        path.to_path_buf()
    } else {
        root.join(path)
    })
    .await
    .map_err(|_| workspace_error("CODEX-WORKSPACE-GIT-INVALID", false))
}

async fn validate_repository_ownership(
    root: &Path,
    git_directory: &Path,
) -> Result<(), CodexCommandError> {
    let root_metadata = tokio::fs::metadata(root)
        .await
        .map_err(|_| workspace_error("CODEX-WORKSPACE-MISSING", true))?;
    let git_metadata = tokio::fs::metadata(git_directory)
        .await
        .map_err(|_| workspace_error("CODEX-WORKSPACE-GIT-INVALID", false))?;
    if !root_metadata.is_dir() || !git_metadata.is_dir() {
        return Err(workspace_error("CODEX-WORKSPACE-GIT-INVALID", false));
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};

        let uid = unsafe { libc::geteuid() };
        if !matches!(root_metadata.uid(), owner if owner == uid || owner == 0)
            || !matches!(git_metadata.uid(), owner if owner == uid || owner == 0)
        {
            return Err(workspace_error("CODEX-WORKSPACE-OWNER-MISMATCH", false));
        }
        let root_mode = root_metadata.permissions().mode();
        let git_mode = git_metadata.permissions().mode();
        if root_mode & 0o022 != 0 || git_mode & 0o022 != 0 {
            return Err(workspace_error("CODEX-WORKSPACE-WRITABLE-POLICY", false));
        }
        if root_metadata.uid() != uid
            || git_metadata.uid() != uid
            || root_mode & 0o200 == 0
            || git_mode & 0o200 == 0
        {
            return Err(workspace_error("CODEX-WORKSPACE-READ-ONLY", false));
        }
    }

    #[cfg(not(unix))]
    if root_metadata.permissions().readonly() || git_metadata.permissions().readonly() {
        return Err(workspace_error("CODEX-WORKSPACE-READ-ONLY", false));
    }

    Ok(())
}

async fn run_workspace_git(
    root: &Path,
    arguments: &[&str],
    stdout_limit: usize,
) -> Result<BoundedCommandOutput, CodexCommandError> {
    let mut command = tokio::process::Command::new("/usr/bin/git");
    command
        .arg("-C")
        .arg(root)
        .args(arguments)
        .env_clear()
        .env("LC_ALL", "C")
        .env("GIT_CONFIG_NOSYSTEM", "1");
    run_bounded_command(
        command,
        WORKSPACE_GIT_TIMEOUT,
        stdout_limit,
        WORKSPACE_GIT_STDERR_LIMIT,
    )
    .await
    .map_err(|error| match error {
        BoundedCommandError::Spawn | BoundedCommandError::Timeout => {
            workspace_error("CODEX-WORKSPACE-GIT-UNAVAILABLE", true)
        }
        _ => workspace_error("CODEX-WORKSPACE-GIT-INVALID", false),
    })
}

async fn validate_git_root_closure(
    root: &Path,
    git_directory: &Path,
) -> Result<(), CodexCommandError> {
    let output = run_workspace_git(
        root,
        &[
            "rev-parse",
            "--show-toplevel",
            "--absolute-git-dir",
            "--git-common-dir",
        ],
        12_288,
    )
    .await?;
    if !output.status.success() {
        return Err(workspace_error("CODEX-WORKSPACE-GIT-INVALID", false));
    }
    let stdout = String::from_utf8(output.stdout)
        .map_err(|_| workspace_error("CODEX-WORKSPACE-GIT-INVALID", false))?;
    let mut lines = stdout.lines();
    let reported_root = lines
        .next()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| workspace_error("CODEX-WORKSPACE-GIT-INVALID", false))?;
    let reported_git_dir = lines
        .next()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| workspace_error("CODEX-WORKSPACE-GIT-INVALID", false))?;
    let reported_common_dir = lines
        .next()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| workspace_error("CODEX-WORKSPACE-GIT-INVALID", false))?;
    if lines.next().is_some() {
        return Err(workspace_error("CODEX-WORKSPACE-GIT-INVALID", false));
    }

    let reported_root = tokio::fs::canonicalize(reported_root)
        .await
        .map_err(|_| workspace_error("CODEX-WORKSPACE-GIT-INVALID", false))?;
    let reported_git_dir = tokio::fs::canonicalize(reported_git_dir)
        .await
        .map_err(|_| workspace_error("CODEX-WORKSPACE-GIT-INVALID", false))?;
    let common_path = Path::new(reported_common_dir);
    let reported_common_dir = tokio::fs::canonicalize(if common_path.is_absolute() {
        common_path.to_path_buf()
    } else {
        root.join(common_path)
    })
    .await
    .map_err(|_| workspace_error("CODEX-WORKSPACE-GIT-INVALID", false))?;

    if reported_root != root || reported_git_dir != git_directory {
        return Err(workspace_error("CODEX-WORKSPACE-GIT-CLOSURE", false));
    }
    if reported_common_dir != reported_git_dir
        && !reported_git_dir.starts_with(&reported_common_dir)
    {
        return Err(workspace_error("CODEX-WORKSPACE-GIT-CLOSURE", false));
    }
    validate_repository_ownership(root, &reported_common_dir).await
}

async fn repository_identity(
    canonical_root: PathBuf,
    canonical_git_dir: PathBuf,
) -> Result<GitRepositoryIdentity, CodexCommandError> {
    let root_metadata = tokio::fs::metadata(&canonical_root)
        .await
        .map_err(|_| workspace_error("CODEX-WORKSPACE-MISSING", true))?;
    let git_metadata = tokio::fs::metadata(&canonical_git_dir)
        .await
        .map_err(|_| workspace_error("CODEX-WORKSPACE-GIT-INVALID", false))?;
    let head_value = tokio::fs::read_to_string(canonical_git_dir.join("HEAD"))
        .await
        .map_err(|_| workspace_error("CODEX-WORKSPACE-GIT-INVALID", false))?;
    if head_value.len() > 4_096 || head_value.contains('\0') {
        return Err(workspace_error("CODEX-WORKSPACE-GIT-INVALID", false));
    }
    let head_value = head_value.trim();
    let (branch, head, detached) = if let Some(reference) = head_value.strip_prefix("ref: ") {
        if !is_safe_head_reference(reference) {
            return Err(workspace_error("CODEX-WORKSPACE-GIT-INVALID", false));
        }
        let branch = reference
            .strip_prefix("refs/heads/")
            .expect("validated head reference")
            .trim();
        if branch.is_empty() || branch.chars().count() > 240 || branch.chars().any(char::is_control)
        {
            return Err(workspace_error("CODEX-WORKSPACE-GIT-INVALID", false));
        }
        let head = read_head_object_id(&canonical_root).await?;
        (branch.to_owned(), head, false)
    } else {
        if !is_git_object_id(head_value) {
            return Err(workspace_error("CODEX-WORKSPACE-GIT-INVALID", false));
        }
        let short = head_value.chars().take(12).collect::<String>();
        (short.clone(), short, true)
    };

    #[cfg(unix)]
    let (root_device, root_inode, git_device, git_inode) = {
        use std::os::unix::fs::MetadataExt;
        (
            root_metadata.dev(),
            root_metadata.ino(),
            git_metadata.dev(),
            git_metadata.ino(),
        )
    };
    #[cfg(not(unix))]
    let (root_device, root_inode, git_device, git_inode) =
        (0, root_metadata.len(), 0, git_metadata.len());

    let mut identity = Sha256::new();
    identity.update(root_device.to_le_bytes());
    identity.update(root_inode.to_le_bytes());
    identity.update(git_device.to_le_bytes());
    identity.update(git_inode.to_le_bytes());
    let project_identity = hex::encode(identity.finalize());

    Ok(GitRepositoryIdentity {
        canonical_root,
        canonical_git_dir,
        root_device,
        root_inode,
        git_device,
        git_inode,
        project_identity,
        branch,
        head,
        detached,
    })
}

async fn read_head_object_id(root: &Path) -> Result<String, CodexCommandError> {
    let output = run_workspace_git(root, &["rev-parse", "--verify", "HEAD"], 128).await?;
    if !output.status.success() {
        return Ok("unborn".to_owned());
    }
    let value = String::from_utf8(output.stdout)
        .map_err(|_| workspace_error("CODEX-WORKSPACE-GIT-INVALID", false))?;
    let value = value.trim();
    if !is_git_object_id(value) {
        return Err(workspace_error("CODEX-WORKSPACE-GIT-INVALID", false));
    }
    Ok(value.chars().take(12).collect())
}

fn is_git_object_id(value: &str) -> bool {
    matches!(value.len(), 40 | 64) && value.chars().all(|character| character.is_ascii_hexdigit())
}

fn is_safe_head_reference(value: &str) -> bool {
    value.starts_with("refs/heads/")
        && value.len() <= 251
        && !value.contains("..")
        && !value.contains("@{")
        && !value.ends_with('.')
        && !value.ends_with('/')
        && !value
            .chars()
            .any(|character| character.is_control() || " ~^:?*[\\".contains(character))
        && value.split('/').all(|component| {
            !component.is_empty() && component != "." && !component.ends_with(".lock")
        })
}

fn repository_alias(root: &Path) -> String {
    root.file_name()
        .and_then(|name| name.to_str())
        .and_then(|name| validate_alias(name).ok())
        .unwrap_or_else(|| "Repository".to_owned())
}

fn validate_alias(value: &str) -> Result<String, CodexCommandError> {
    let value = value.trim();
    if value.is_empty()
        || value.chars().count() > 80
        || value.contains('/')
        || value.contains('\\')
        || value.chars().any(char::is_control)
    {
        return Err(workspace_error("CODEX-WORKSPACE-ALIAS-INVALID", false));
    }
    Ok(value.to_owned())
}

fn validate_workspace_id(value: &str) -> Result<(), CodexCommandError> {
    if value.len() > 128
        || !value.starts_with("workspace-")
        || !value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
    {
        return Err(workspace_error("CODEX-WORKSPACE-ID-INVALID", false));
    }
    Ok(())
}

fn workspace_error(code: &str, recoverable: bool) -> CodexCommandError {
    CodexCommandError::new(code, "codex.workspace.pick", recoverable)
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    struct FixedPicker(PathBuf);

    impl FolderPicker for FixedPicker {
        fn pick_folder(&self) -> PickerFuture<'_> {
            let path = self.0.clone();
            Box::pin(async move { Some(path) })
        }
    }

    fn git_repository() -> PathBuf {
        let root = std::env::temp_dir().join(format!("coding-wife-repo-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).expect("git root");
        let status = std::process::Command::new("/usr/bin/git")
            .args(["init", "-q", "-b", "main"])
            .arg(&root)
            .status()
            .expect("git init");
        assert!(status.success());
        root
    }

    #[tokio::test]
    async fn picker_returns_only_an_opaque_registration() {
        let root = git_repository();
        let supervisor = CodexSupervisor::new();
        let service = WorkspaceService::new(supervisor, Arc::new(FixedPicker(root.clone())));
        let registration = service.pick_and_register().await.expect("register");
        let encoded = serde_json::to_string(&registration).expect("serialize");

        assert!(registration.workspace_id.starts_with("workspace-"));
        assert_eq!(
            registration.alias,
            root.file_name().unwrap().to_string_lossy()
        );
        assert!(!encoded.contains(&root.to_string_lossy().to_string()));
        assert_eq!(
            service.trusted_root(&registration.workspace_id).await,
            Some(fs::canonicalize(&root).expect("canonical root"))
        );
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn non_git_selection_is_rejected_without_registration() {
        let root = std::env::temp_dir().join(format!("coding-wife-dir-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).expect("directory");
        let service =
            WorkspaceService::new(CodexSupervisor::new(), Arc::new(FixedPicker(root.clone())));
        let error = service.pick_and_register().await.expect_err("not git");
        assert_eq!(error.code, "CODEX-WORKSPACE-NOT-GIT");
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn resolved_external_git_directory_is_verified_but_never_serialized() {
        let root =
            std::env::temp_dir().join(format!("coding-wife-worktree-{}", uuid::Uuid::new_v4()));
        let git_dir =
            std::env::temp_dir().join(format!("coding-wife-gitdir-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).expect("worktree root");
        let status = std::process::Command::new("/usr/bin/git")
            .arg("init")
            .arg("-q")
            .arg("-b")
            .arg("main")
            .arg("--separate-git-dir")
            .arg(&git_dir)
            .arg(&root)
            .status()
            .expect("separate git directory");
        assert!(status.success());

        let service =
            WorkspaceService::new(CodexSupervisor::new(), Arc::new(FixedPicker(root.clone())));
        let candidate = service.pick_validated().await.expect("validated candidate");
        let encoded = serde_json::to_string(&candidate.registration).expect("serialize public DTO");

        assert_eq!(
            candidate.git.canonical_git_dir,
            fs::canonicalize(&git_dir).expect("canonical git directory")
        );
        assert!(!encoded.contains(&git_dir.to_string_lossy().to_string()));

        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(git_dir);
    }

    #[tokio::test]
    async fn linked_worktree_uses_the_resolved_gitdir_and_common_refs() {
        let root = git_repository();
        fs::write(root.join("README.md"), "fixture\n").expect("fixture file");
        let add = std::process::Command::new("/usr/bin/git")
            .arg("-C")
            .arg(&root)
            .args(["add", "README.md"])
            .status()
            .expect("git add");
        assert!(add.success());
        let commit = std::process::Command::new("/usr/bin/git")
            .arg("-C")
            .arg(&root)
            .args([
                "-c",
                "user.name=Coding Wife Fixture",
                "-c",
                "user.email=fixture@example.invalid",
                "commit",
                "-q",
                "-m",
                "fixture",
            ])
            .status()
            .expect("git commit");
        assert!(commit.success());
        let worktree = std::env::temp_dir().join(format!(
            "coding-wife-linked-worktree-{}",
            uuid::Uuid::new_v4()
        ));
        let add_worktree = std::process::Command::new("/usr/bin/git")
            .arg("-C")
            .arg(&root)
            .args(["worktree", "add", "-q", "-b", "fixture-linked"])
            .arg(&worktree)
            .status()
            .expect("git worktree add");
        assert!(add_worktree.success());

        let identity = validate_git_repository(&worktree)
            .await
            .expect("linked worktree identity");
        let marker = fs::read_to_string(worktree.join(".git")).expect("worktree marker");
        let raw_git_dir = marker.trim().trim_start_matches("gitdir: ");

        assert_eq!(identity.branch, "fixture-linked");
        assert_ne!(identity.head, "unborn");
        assert_eq!(identity.head.len(), 12);
        assert_eq!(
            identity.canonical_git_dir,
            fs::canonicalize(raw_git_dir).expect("canonical linked git directory")
        );
        let public = serde_json::to_string(&WorkspaceRegistration {
            schema_version: WORKSPACE_REGISTRATION_SCHEMA_VERSION,
            workspace_id: "workspace-linked-fixture".to_owned(),
            alias: "Linked fixture".to_owned(),
            preflight: WorkspacePreflight {
                git_repository: true,
                owned_by_current_user: true,
                writable: true,
            },
        })
        .expect("serialize public registration");
        assert!(!public.contains(raw_git_dir));

        let remove = std::process::Command::new("/usr/bin/git")
            .arg("-C")
            .arg(&root)
            .args(["worktree", "remove", "--force"])
            .arg(&worktree)
            .status()
            .expect("git worktree remove");
        assert!(remove.success());
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn writable_external_git_directory_is_rejected() {
        use std::os::unix::fs::PermissionsExt;

        let root =
            std::env::temp_dir().join(format!("coding-wife-worktree-{}", uuid::Uuid::new_v4()));
        let git_dir =
            std::env::temp_dir().join(format!("coding-wife-gitdir-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).expect("worktree root");
        let status = std::process::Command::new("/usr/bin/git")
            .arg("init")
            .arg("-q")
            .arg("-b")
            .arg("main")
            .arg("--separate-git-dir")
            .arg(&git_dir)
            .arg(&root)
            .status()
            .expect("separate git directory");
        assert!(status.success());
        fs::set_permissions(&git_dir, fs::Permissions::from_mode(0o777))
            .expect("unsafe permissions");

        let error = validate_git_repository(&root)
            .await
            .expect_err("unsafe git directory");
        assert_eq!(error.code, "CODEX-WORKSPACE-WRITABLE-POLICY");

        fs::set_permissions(&git_dir, fs::Permissions::from_mode(0o700))
            .expect("restore permissions");
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(git_dir);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn group_writable_git_marker_file_is_rejected() {
        use std::os::unix::fs::PermissionsExt;

        let root =
            std::env::temp_dir().join(format!("coding-wife-worktree-{}", uuid::Uuid::new_v4()));
        let git_dir =
            std::env::temp_dir().join(format!("coding-wife-gitdir-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).expect("worktree root");
        let status = std::process::Command::new("/usr/bin/git")
            .arg("init")
            .arg("-q")
            .arg("-b")
            .arg("main")
            .arg("--separate-git-dir")
            .arg(&git_dir)
            .arg(&root)
            .status()
            .expect("separate git directory");
        assert!(status.success());
        let marker = root.join(".git");
        fs::set_permissions(&marker, fs::Permissions::from_mode(0o666))
            .expect("unsafe marker permissions");

        let error = validate_git_repository(&root)
            .await
            .expect_err("unsafe marker file");
        assert_eq!(error.code, "CODEX-WORKSPACE-WRITABLE-POLICY");

        fs::set_permissions(&marker, fs::Permissions::from_mode(0o600))
            .expect("restore marker permissions");
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(git_dir);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn group_writable_head_file_is_rejected() {
        use std::os::unix::fs::PermissionsExt;

        let root = git_repository();
        let head = root.join(".git/HEAD");
        fs::set_permissions(&head, fs::Permissions::from_mode(0o666))
            .expect("unsafe HEAD permissions");

        let error = validate_git_repository(&root)
            .await
            .expect_err("unsafe HEAD file");
        assert_eq!(error.code, "CODEX-WORKSPACE-WRITABLE-POLICY");

        fs::set_permissions(&head, fs::Permissions::from_mode(0o600))
            .expect("restore HEAD permissions");
        let _ = fs::remove_dir_all(root);
    }
}
