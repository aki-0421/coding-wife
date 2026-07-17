use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use super::supervisor::CodexSupervisor;
use super::types::CodexCommandError;

pub const WORKSPACE_REGISTRATION_SCHEMA_VERSION: u16 = 1;

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
        let selected = self
            .picker
            .pick_folder()
            .await
            .ok_or_else(|| workspace_error("CODEX-WORKSPACE-PICK-CANCELED", true))?;
        self.register_new(selected).await
    }

    pub async fn restore_private_workspace(
        &self,
        record: AppPrivateWorkspaceRecord,
    ) -> Result<WorkspaceRegistration, CodexCommandError> {
        validate_workspace_id(&record.workspace_id)?;
        let alias = validate_alias(&record.alias)?;
        self.validate_and_register(record.canonical_root, Some(record.workspace_id), alias)
            .await
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

    async fn register_new(
        &self,
        selected: PathBuf,
    ) -> Result<WorkspaceRegistration, CodexCommandError> {
        let canonical = canonical_git_root(&selected).await?;
        if let Some(existing) = self
            .trusted
            .lock()
            .await
            .values()
            .find(|record| record.root == canonical)
            .map(|record| record.registration.clone())
        {
            return Ok(existing);
        }
        let alias = repository_alias(&canonical);
        self.validate_and_register(
            canonical,
            Some(format!("workspace-{}", uuid::Uuid::new_v4())),
            alias,
        )
        .await
    }

    async fn validate_and_register(
        &self,
        selected: PathBuf,
        workspace_id: Option<String>,
        alias: String,
    ) -> Result<WorkspaceRegistration, CodexCommandError> {
        let canonical = canonical_git_root(&selected).await?;
        validate_repository_ownership(&canonical).await?;
        let workspace_id =
            workspace_id.unwrap_or_else(|| format!("workspace-{}", uuid::Uuid::new_v4()));
        validate_workspace_id(&workspace_id)?;
        let registration = WorkspaceRegistration {
            schema_version: WORKSPACE_REGISTRATION_SCHEMA_VERSION,
            workspace_id: workspace_id.clone(),
            alias,
            preflight: WorkspacePreflight {
                git_repository: true,
                owned_by_current_user: true,
                writable: true,
            },
        };
        self.supervisor
            .register_workspace_root(workspace_id.clone(), &canonical)
            .await?;
        self.trusted.lock().await.insert(
            workspace_id,
            TrustedWorkspace {
                root: canonical,
                registration: registration.clone(),
            },
        );
        Ok(registration)
    }
}

async fn canonical_git_root(selected: &Path) -> Result<PathBuf, CodexCommandError> {
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
    Ok(canonical)
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

async fn validate_repository_ownership(root: &Path) -> Result<(), CodexCommandError> {
    let root_metadata = tokio::fs::metadata(root)
        .await
        .map_err(|_| workspace_error("CODEX-WORKSPACE-MISSING", true))?;
    let git_metadata = tokio::fs::metadata(root.join(".git"))
        .await
        .map_err(|_| workspace_error("CODEX-WORKSPACE-GIT-INVALID", false))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};

        let uid = unsafe { libc::geteuid() };
        if root_metadata.uid() != uid || git_metadata.uid() != uid {
            return Err(workspace_error("CODEX-WORKSPACE-OWNER-MISMATCH", false));
        }
        if root_metadata.permissions().mode() & 0o200 == 0 {
            return Err(workspace_error("CODEX-WORKSPACE-READ-ONLY", false));
        }
    }

    #[cfg(not(unix))]
    if root_metadata.permissions().readonly() {
        return Err(workspace_error("CODEX-WORKSPACE-READ-ONLY", false));
    }

    Ok(())
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
        fs::create_dir_all(root.join(".git/objects")).expect("git directories");
        fs::write(root.join(".git/HEAD"), "ref: refs/heads/main\n").expect("git HEAD");
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
}
