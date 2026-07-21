use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;
use url::Url;

use super::process::{run_bounded_command, BoundedCommandError, BoundedCommandOutput};
use super::supervisor::{CodexSupervisor, WorkspaceCancellationGuard};
use super::types::CodexCommandError;

pub const WORKSPACE_REGISTRATION_SCHEMA_VERSION: u16 = 1;
const WORKSPACE_GIT_TIMEOUT: Duration = Duration::from_secs(5);
const WORKSPACE_GIT_STDERR_LIMIT: usize = 4 * 1024;

pub type PickerFuture<'a> = Pin<Box<dyn Future<Output = Option<PathBuf>> + Send + 'a>>;
pub(crate) type RepositoryValidationFuture<'a> =
    Pin<Box<dyn Future<Output = Result<GitRepositoryIdentity, CodexCommandError>> + Send + 'a>>;

pub trait FolderPicker: Send + Sync {
    fn pick_folder(&self) -> PickerFuture<'_>;
}

pub(crate) trait RepositoryValidator: Send + Sync {
    fn validate<'a>(&'a self, selected: &'a Path) -> RepositoryValidationFuture<'a>;
}

struct NativeRepositoryValidator;

impl RepositoryValidator for NativeRepositoryValidator {
    fn validate<'a>(&'a self, selected: &'a Path) -> RepositoryValidationFuture<'a> {
        Box::pin(validate_git_repository(selected))
    }
}

pub struct NativeFolderPicker;

impl FolderPicker for NativeFolderPicker {
    fn pick_folder(&self) -> PickerFuture<'_> {
        Box::pin(async {
            rfd::AsyncFileDialog::new()
                .set_title("Select a project folder")
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
    pub managed_worktree_identity: Option<AppPrivateManagedWorktreeIdentity>,
}

/// Immutable project linkage kept exclusively in app-private persistence.
/// Repair uses this as a compare-and-swap token and never accepts it over IPC.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AppPrivateProjectIdentity {
    pub project_id: String,
    pub canonical_root: PathBuf,
    pub project_identity: String,
    pub root_device: u64,
    pub root_inode: u64,
    pub git_device: u64,
    pub git_inode: u64,
    pub common_git_device: Option<u64>,
    pub common_git_inode: Option<u64>,
}

/// This record belongs to app-private settings and is deliberately not a
/// serializable IPC type.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AppPrivateBinaryRecord {
    pub canonical_path: PathBuf,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitRepositoryIdentity {
    pub canonical_root: PathBuf,
    /// The worktree-specific Git directory reported by `--absolute-git-dir`.
    pub canonical_git_dir: PathBuf,
    /// The shared Git directory reported by `--git-common-dir`.
    pub canonical_common_git_dir: PathBuf,
    pub root_device: u64,
    pub root_inode: u64,
    pub git_device: u64,
    pub git_inode: u64,
    /// The device and inode of the shared Git common directory.
    pub common_git_device: u64,
    pub common_git_inode: u64,
    /// The device and inode of the worktree's non-symlink `.git` marker.
    pub marker_device: u64,
    pub marker_inode: u64,
    pub project_identity: String,
    pub github_repository: Option<String>,
    pub branch: String,
    pub head: String,
    pub detached: bool,
}

pub(crate) const MANAGED_WORKTREE_PROVENANCE_VERSION: u16 = 1;

/// Durable app-private attestation created only with an app-owned worktree row.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AppPrivateManagedWorktreeIdentity {
    pub provenance_version: u16,
    pub root_device: u64,
    pub root_inode: u64,
    pub canonical_git_dir: PathBuf,
    pub git_device: u64,
    pub git_inode: u64,
    pub canonical_common_git_dir: PathBuf,
    pub common_git_device: u64,
    pub common_git_inode: u64,
    pub marker_device: u64,
    pub marker_inode: u64,
}

impl AppPrivateManagedWorktreeIdentity {
    pub(crate) fn from_repository(repository: &GitRepositoryIdentity) -> Self {
        Self {
            provenance_version: MANAGED_WORKTREE_PROVENANCE_VERSION,
            root_device: repository.root_device,
            root_inode: repository.root_inode,
            canonical_git_dir: repository.canonical_git_dir.clone(),
            git_device: repository.git_device,
            git_inode: repository.git_inode,
            canonical_common_git_dir: repository.canonical_common_git_dir.clone(),
            common_git_device: repository.common_git_device,
            common_git_inode: repository.common_git_inode,
            marker_device: repository.marker_device,
            marker_inode: repository.marker_inode,
        }
    }

    pub(crate) fn matches(&self, repository: &GitRepositoryIdentity) -> bool {
        self.provenance_version == MANAGED_WORKTREE_PROVENANCE_VERSION
            && self.root_device == repository.root_device
            && self.root_inode == repository.root_inode
            && self.canonical_git_dir == repository.canonical_git_dir
            && self.git_device == repository.git_device
            && self.git_inode == repository.git_inode
            && self.canonical_common_git_dir == repository.canonical_common_git_dir
            && self.common_git_device == repository.common_git_device
            && self.common_git_inode == repository.common_git_inode
            && self.marker_device == repository.marker_device
            && self.marker_inode == repository.marker_inode
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) enum WorkspaceWriteProvenance {
    #[default]
    Unmanaged,
    AppManaged(AppPrivateManagedWorktreeIdentity),
}

impl WorkspaceWriteProvenance {
    pub fn managed_identity(&self) -> Option<&AppPrivateManagedWorktreeIdentity> {
        match self {
            Self::Unmanaged => None,
            Self::AppManaged(identity) => Some(identity),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct WorkspaceWriteAuthority {
    pub workspace_root: PathBuf,
    pub additional_writable_roots: Vec<PathBuf>,
}

impl WorkspaceWriteAuthority {
    pub fn runtime_workspace_roots(&self) -> Vec<PathBuf> {
        let mut roots = Vec::with_capacity(self.additional_writable_roots.len() + 1);
        roots.push(self.workspace_root.clone());
        roots.extend(self.additional_writable_roots.iter().cloned());
        roots
    }
}

#[derive(Clone, Debug)]
pub struct ValidatedWorkspaceCandidate {
    pub registration: WorkspaceRegistration,
    pub git: GitRepositoryIdentity,
    pub(crate) write_provenance: WorkspaceWriteProvenance,
}

#[derive(Clone, Debug)]
struct TrustedWorkspace {
    root: PathBuf,
    root_device: u64,
    root_inode: u64,
    github_repository: Option<String>,
    write_provenance: WorkspaceWriteProvenance,
    registration: WorkspaceRegistration,
}

#[derive(Clone, Debug)]
pub struct TrustedWorkspaceIdentity {
    pub canonical_root: PathBuf,
    pub root_device: u64,
    pub root_inode: u64,
}

#[derive(Clone)]
pub struct WorkspaceService {
    supervisor: CodexSupervisor,
    picker: Arc<dyn FolderPicker>,
    validator: Arc<dyn RepositoryValidator>,
    trusted: Arc<Mutex<HashMap<String, TrustedWorkspace>>>,
}

impl WorkspaceService {
    pub fn production(supervisor: CodexSupervisor) -> Self {
        Self::new(supervisor, Arc::new(NativeFolderPicker))
    }

    pub fn new(supervisor: CodexSupervisor, picker: Arc<dyn FolderPicker>) -> Self {
        Self::with_validator(supervisor, picker, Arc::new(NativeRepositoryValidator))
    }

    #[cfg(test)]
    pub(crate) fn new_with_repository_validator(
        supervisor: CodexSupervisor,
        picker: Arc<dyn FolderPicker>,
        validator: Arc<dyn RepositoryValidator>,
    ) -> Self {
        Self::with_validator(supervisor, picker, validator)
    }

    fn with_validator(
        supervisor: CodexSupervisor,
        picker: Arc<dyn FolderPicker>,
        validator: Arc<dyn RepositoryValidator>,
    ) -> Self {
        Self {
            supervisor,
            picker,
            validator,
            trusted: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn pick_and_register(&self) -> Result<WorkspaceRegistration, CodexCommandError> {
        let candidate = self.pick_validated().await?;
        self.activate_candidate(candidate).await
    }

    pub async fn pick_folder(&self) -> Result<PathBuf, CodexCommandError> {
        self.picker
            .pick_folder()
            .await
            .ok_or_else(|| workspace_error("CODEX-WORKSPACE-PICK-CANCELED", true))
    }

    pub async fn pick_validated(&self) -> Result<ValidatedWorkspaceCandidate, CodexCommandError> {
        let selected = self.pick_folder().await?;
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
            .validate_private_candidate(&AppPrivateWorkspaceRecord { alias, ..record })
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

    pub async fn trusted_identity(&self, workspace_id: &str) -> Option<TrustedWorkspaceIdentity> {
        self.trusted
            .lock()
            .await
            .get(workspace_id)
            .map(|record| TrustedWorkspaceIdentity {
                canonical_root: record.root.clone(),
                root_device: record.root_device,
                root_inode: record.root_inode,
            })
    }

    /// Returns private identity terms used only by the native Luna boundary.
    /// These values must never be serialized into a WebView or support-model request.
    pub(crate) async fn presence_identity_terms(&self, workspace_id: &str) -> Option<Vec<String>> {
        self.trusted.lock().await.get(workspace_id).map(|record| {
            let mut terms = vec![record.registration.alias.clone()];
            if let Some(root_basename) = record.root.file_name().and_then(|value| value.to_str()) {
                terms.push(root_basename.to_owned());
            }
            if let Some(repository) = record.github_repository.as_deref() {
                terms.push(repository.to_owned());
                if let Some((owner, name)) = repository.split_once('/') {
                    terms.push(owner.to_owned());
                    terms.push(name.to_owned());
                }
            }
            terms.sort_unstable();
            terms.dedup();
            terms
        })
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
        let candidate = self.revalidate_candidate(&candidate).await?;
        if let Some(existing) = self
            .trusted
            .lock()
            .await
            .get(&candidate.registration.workspace_id)
            .cloned()
        {
            if existing.root != candidate.git.canonical_root
                || existing.root_device != candidate.git.root_device
                || existing.root_inode != candidate.git.root_inode
                || existing.write_provenance != candidate.write_provenance
            {
                return Err(workspace_error("CODEX-WORKSPACE-IDENTITY-CHANGED", false));
            }
            return Ok(existing.registration);
        }
        let registration = candidate.registration;
        self.supervisor
            .register_validated_workspace(
                registration.workspace_id.clone(),
                &candidate.git,
                candidate.write_provenance.clone(),
            )
            .await?;
        self.trusted.lock().await.insert(
            registration.workspace_id.clone(),
            TrustedWorkspace {
                root: candidate.git.canonical_root,
                root_device: candidate.git.root_device,
                root_inode: candidate.git.root_inode,
                github_repository: candidate.git.github_repository,
                write_provenance: candidate.write_provenance,
                registration: registration.clone(),
            },
        );
        Ok(registration)
    }

    pub async fn revalidate_candidate(
        &self,
        candidate: &ValidatedWorkspaceCandidate,
    ) -> Result<ValidatedWorkspaceCandidate, CodexCommandError> {
        let live = self
            .validator
            .validate(&candidate.git.canonical_root)
            .await?;
        if candidate.git.canonical_root != live.canonical_root
            || candidate.git.canonical_git_dir != live.canonical_git_dir
            || candidate.git.canonical_common_git_dir != live.canonical_common_git_dir
            || !same_repository_identity(&candidate.git, &live)
            || candidate
                .write_provenance
                .managed_identity()
                .is_some_and(|identity| !identity.matches(&live))
        {
            return Err(workspace_error("CODEX-WORKSPACE-IDENTITY-CHANGED", false));
        }
        Ok(ValidatedWorkspaceCandidate {
            registration: candidate.registration.clone(),
            git: live,
            write_provenance: candidate.write_provenance.clone(),
        })
    }

    pub(crate) async fn begin_cancellation(
        &self,
        workspace_id: &str,
    ) -> Result<WorkspaceCancellationGuard, CodexCommandError> {
        self.supervisor
            .begin_workspace_cancellation(workspace_id)
            .await
    }

    pub async fn validate_private_candidate(
        &self,
        record: &AppPrivateWorkspaceRecord,
    ) -> Result<ValidatedWorkspaceCandidate, CodexCommandError> {
        validate_workspace_id(&record.workspace_id)?;
        let alias = validate_alias(&record.alias)?;
        let identity = record
            .managed_worktree_identity
            .clone()
            .ok_or_else(|| workspace_error("CODEX-WORKSPACE-MANAGED-PROVENANCE-MISSING", false))?;
        let mut candidate = self
            .validate_candidate(
                record.canonical_root.clone(),
                record.workspace_id.clone(),
                Some(alias),
            )
            .await?;
        if !identity.matches(&candidate.git)
            || candidate.git.canonical_git_dir == candidate.git.canonical_root.join(".git")
        {
            return Err(workspace_error("CODEX-WORKSPACE-IDENTITY-CHANGED", false));
        }
        candidate.write_provenance = WorkspaceWriteProvenance::AppManaged(identity);
        Ok(candidate)
    }

    pub async fn validate_workspace_root(
        &self,
        root: PathBuf,
        workspace_id: String,
        alias: String,
    ) -> Result<ValidatedWorkspaceCandidate, CodexCommandError> {
        self.validate_candidate(root, workspace_id, Some(alias))
            .await
    }

    async fn validate_candidate(
        &self,
        selected: PathBuf,
        workspace_id: String,
        alias: Option<String>,
    ) -> Result<ValidatedWorkspaceCandidate, CodexCommandError> {
        let git = self.validator.validate(&selected).await?;
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
        Ok(ValidatedWorkspaceCandidate {
            registration,
            git,
            write_provenance: WorkspaceWriteProvenance::Unmanaged,
        })
    }
}

pub fn same_repository_identity(
    left: &GitRepositoryIdentity,
    right: &GitRepositoryIdentity,
) -> bool {
    left.project_identity == right.project_identity
        && left.root_device == right.root_device
        && left.root_inode == right.root_inode
        && left.git_device == right.git_device
        && left.git_inode == right.git_inode
        && left.common_git_device == right.common_git_device
        && left.common_git_inode == right.common_git_inode
        && left.marker_device == right.marker_device
        && left.marker_inode == right.marker_inode
}

pub fn matches_saved_repository_identity(
    candidate: &GitRepositoryIdentity,
    saved: &AppPrivateProjectIdentity,
) -> bool {
    candidate.project_identity == saved.project_identity
        && candidate.root_device == saved.root_device
        && candidate.root_inode == saved.root_inode
        && candidate.git_device == saved.git_device
        && candidate.git_inode == saved.git_inode
        && saved
            .common_git_device
            .is_none_or(|device| device == candidate.common_git_device)
        && saved
            .common_git_inode
            .is_none_or(|inode| inode == candidate.common_git_inode)
}

pub fn matches_saved_git_repository(
    candidate: &GitRepositoryIdentity,
    saved: &AppPrivateProjectIdentity,
) -> bool {
    candidate.common_git_device == saved.common_git_device.unwrap_or(saved.git_device)
        && candidate.common_git_inode == saved.common_git_inode.unwrap_or(saved.git_inode)
}

pub fn same_git_common_directory(
    left: &GitRepositoryIdentity,
    right: &GitRepositoryIdentity,
) -> bool {
    left.common_git_device == right.common_git_device
        && left.common_git_inode == right.common_git_inode
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
    #[cfg(unix)]
    let (marker_device, marker_inode) = {
        use std::os::unix::fs::MetadataExt;
        (marker_metadata.dev(), marker_metadata.ino())
    };
    #[cfg(not(unix))]
    let (marker_device, marker_inode) = (0_u64, marker_metadata.len());
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
    let common_git_directory = validate_git_root_closure(&canonical, &git_directory).await?;
    repository_identity(
        canonical,
        git_directory,
        common_git_directory,
        marker_device,
        marker_inode,
    )
    .await
}

pub(crate) async fn validate_workspace_write_authority(
    expected: &GitRepositoryIdentity,
    managed_identity: Option<&AppPrivateManagedWorktreeIdentity>,
) -> Result<WorkspaceWriteAuthority, CodexCommandError> {
    let live = validate_git_repository(&expected.canonical_root).await?;
    if live.canonical_root != expected.canonical_root
        || live.canonical_git_dir != expected.canonical_git_dir
        || live.canonical_common_git_dir != expected.canonical_common_git_dir
        || !same_repository_identity(expected, &live)
    {
        return Err(workspace_error("CODEX-WORKSPACE-IDENTITY-CHANGED", false));
    }

    let in_tree_git_directory = live.canonical_root.join(".git");
    let Some(managed_identity) = managed_identity else {
        return Ok(WorkspaceWriteAuthority {
            workspace_root: live.canonical_root,
            additional_writable_roots: Vec::new(),
        });
    };
    if live.canonical_git_dir == in_tree_git_directory || !managed_identity.matches(&live) {
        return Err(workspace_error("CODEX-WORKSPACE-IDENTITY-CHANGED", false));
    }

    validate_private_directory_ancestry(&live.canonical_git_dir).await?;
    validate_private_directory_ancestry(&live.canonical_common_git_dir).await?;
    let mut additional_writable_roots = vec![live.canonical_git_dir.clone()];
    if live.canonical_common_git_dir != live.canonical_git_dir {
        additional_writable_roots.push(live.canonical_common_git_dir);
    }
    Ok(WorkspaceWriteAuthority {
        workspace_root: live.canonical_root,
        additional_writable_roots,
    })
}

async fn validate_private_directory_ancestry(path: &Path) -> Result<(), CodexCommandError> {
    let canonical = tokio::fs::canonicalize(path)
        .await
        .map_err(|_| workspace_error("CODEX-WORKSPACE-GIT-INVALID", false))?;
    if canonical != path {
        return Err(workspace_error("CODEX-WORKSPACE-GIT-CLOSURE", false));
    }

    for ancestor in canonical.ancestors() {
        let metadata = tokio::fs::symlink_metadata(ancestor)
            .await
            .map_err(|_| workspace_error("CODEX-WORKSPACE-GIT-INVALID", false))?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(workspace_error("CODEX-WORKSPACE-GIT-CLOSURE", false));
        }

        #[cfg(unix)]
        {
            use std::os::unix::fs::{MetadataExt, PermissionsExt};

            let uid = unsafe { libc::geteuid() };
            if metadata.uid() != uid && metadata.uid() != 0 {
                return Err(workspace_error("CODEX-WORKSPACE-OWNER-MISMATCH", false));
            }
            if metadata.permissions().mode() & 0o022 != 0 {
                return Err(workspace_error("CODEX-WORKSPACE-WRITABLE-POLICY", false));
            }
        }
    }
    Ok(())
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
) -> Result<PathBuf, CodexCommandError> {
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
    validate_repository_ownership(root, &reported_common_dir).await?;
    Ok(reported_common_dir)
}

async fn repository_identity(
    canonical_root: PathBuf,
    canonical_git_dir: PathBuf,
    canonical_common_git_dir: PathBuf,
    marker_device: u64,
    marker_inode: u64,
) -> Result<GitRepositoryIdentity, CodexCommandError> {
    let root_metadata = tokio::fs::metadata(&canonical_root)
        .await
        .map_err(|_| workspace_error("CODEX-WORKSPACE-MISSING", true))?;
    let git_metadata = tokio::fs::metadata(&canonical_git_dir)
        .await
        .map_err(|_| workspace_error("CODEX-WORKSPACE-GIT-INVALID", false))?;
    let common_git_metadata = tokio::fs::metadata(&canonical_common_git_dir)
        .await
        .map_err(|_| workspace_error("CODEX-WORKSPACE-GIT-INVALID", false))?;
    let head_value = tokio::fs::read_to_string(canonical_git_dir.join("HEAD"))
        .await
        .map_err(|_| workspace_error("CODEX-WORKSPACE-GIT-INVALID", false))?;
    if head_value.len() > 4_096 || head_value.contains('\0') {
        return Err(workspace_error("CODEX-WORKSPACE-GIT-INVALID", false));
    }
    let head_value = head_value.trim();
    let github_repository = read_github_repository(&canonical_root);
    let (branch, head, detached, github_repository) = if let Some(reference) =
        head_value.strip_prefix("ref: ")
    {
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
        let (head, github_repository) =
            tokio::join!(read_head_object_id(&canonical_root), github_repository);
        (branch.to_owned(), head?, false, github_repository)
    } else {
        if !is_git_object_id(head_value) {
            return Err(workspace_error("CODEX-WORKSPACE-GIT-INVALID", false));
        }
        let short = head_value.chars().take(12).collect::<String>();
        (short.clone(), short, true, github_repository.await)
    };

    #[cfg(unix)]
    let (root_device, root_inode, git_device, git_inode, common_git_device, common_git_inode) = {
        use std::os::unix::fs::MetadataExt;
        (
            root_metadata.dev(),
            root_metadata.ino(),
            git_metadata.dev(),
            git_metadata.ino(),
            common_git_metadata.dev(),
            common_git_metadata.ino(),
        )
    };
    #[cfg(not(unix))]
    let (root_device, root_inode, git_device, git_inode, common_git_device, common_git_inode) = (
        0_u64,
        root_metadata.len(),
        0_u64,
        git_metadata.len(),
        0_u64,
        common_git_metadata.len(),
    );

    let mut identity = Sha256::new();
    identity.update(root_device.to_le_bytes());
    identity.update(root_inode.to_le_bytes());
    identity.update(git_device.to_le_bytes());
    identity.update(git_inode.to_le_bytes());
    let project_identity = hex::encode(identity.finalize());

    Ok(GitRepositoryIdentity {
        canonical_root,
        canonical_git_dir,
        canonical_common_git_dir,
        root_device,
        root_inode,
        git_device,
        git_inode,
        common_git_device,
        common_git_inode,
        marker_device,
        marker_inode,
        project_identity,
        github_repository,
        branch,
        head,
        detached,
    })
}

async fn read_github_repository(root: &Path) -> Option<String> {
    let output = run_workspace_git(root, &["config", "--get", "remote.origin.url"], 2_048)
        .await
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let remote = String::from_utf8(output.stdout).ok()?;
    parse_github_repository(remote.trim())
}

fn parse_github_repository(remote: &str) -> Option<String> {
    if remote.is_empty() || remote.chars().any(char::is_control) {
        return None;
    }
    let normalized = if remote.contains("://") {
        remote.to_owned()
    } else {
        let (authority, path) = remote.split_once(':')?;
        if !authority
            .rsplit('@')
            .next()
            .is_some_and(|host| host.eq_ignore_ascii_case("github.com"))
        {
            return None;
        }
        format!("ssh://{authority}/{path}")
    };
    let parsed = Url::parse(&normalized).ok()?;
    if !parsed
        .host_str()
        .is_some_and(|host| host.eq_ignore_ascii_case("github.com"))
    {
        return None;
    }
    let segments = parsed
        .path_segments()?
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();
    if segments.len() != 2 {
        return None;
    }
    let owner = segments[0];
    let repository = segments[1].strip_suffix(".git").unwrap_or(segments[1]);
    if !is_github_slug_component(owner, 39) || !is_github_slug_component(repository, 100) {
        return None;
    }
    Some(format!("{owner}/{repository}"))
}

fn is_github_slug_component(value: &str, maximum: usize) -> bool {
    !value.is_empty()
        && value.len() <= maximum
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
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

    fn secure_fixture_directory(label: &str) -> PathBuf {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("repository root")
            .join(".context")
            .join(format!("codex-{label}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).expect("secure fixture directory");
        root
    }

    fn committed_repository(root: &Path) {
        fs::create_dir_all(root).expect("repository fixture root");
        let init = std::process::Command::new("/usr/bin/git")
            .args(["init", "-q", "-b", "main"])
            .arg(root)
            .status()
            .expect("initialize repository fixture");
        assert!(init.success());
        let commit = std::process::Command::new("/usr/bin/git")
            .arg("-C")
            .arg(root)
            .args([
                "-c",
                "user.name=Coding Wife Fixture",
                "-c",
                "user.email=fixture@example.invalid",
                "commit",
                "--allow-empty",
                "-q",
                "-m",
                "fixture",
            ])
            .status()
            .expect("commit repository fixture");
        assert!(commit.success());
    }

    #[test]
    fn github_repository_parser_accepts_https_ssh_and_scp_origins() {
        for remote in [
            "https://github.com/aki-0421/coding-wife.git",
            "ssh://git@github.com/aki-0421/coding-wife.git",
            "git@github.com:aki-0421/coding-wife.git",
        ] {
            assert_eq!(
                parse_github_repository(remote),
                Some("aki-0421/coding-wife".to_owned())
            );
        }
    }

    #[test]
    fn github_repository_parser_rejects_non_github_and_unsafe_paths() {
        for remote in [
            "https://gitlab.com/aki-0421/coding-wife.git",
            "https://github.com/aki-0421/coding-wife/extra",
            "https://token@github.com/aki-0421/%2Fsecret.git",
            "git@example.com:aki-0421/coding-wife.git",
        ] {
            assert_eq!(parse_github_repository(remote), None);
        }
    }

    #[tokio::test]
    async fn repository_identity_reads_github_origin_without_network_access() {
        let root = git_repository();
        let status = std::process::Command::new("/usr/bin/git")
            .arg("-C")
            .arg(&root)
            .args([
                "remote",
                "add",
                "origin",
                "git@github.com:aki-0421/coding-wife.git",
            ])
            .status()
            .expect("add origin");
        assert!(status.success());

        let identity = validate_git_repository(&root)
            .await
            .expect("repository identity");

        assert_eq!(
            identity.github_repository,
            Some("aki-0421/coding-wife".to_owned())
        );
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn presence_identity_terms_stay_native_and_cover_alias_root_and_repository() {
        let root = git_repository();
        let root_basename = root
            .file_name()
            .expect("root basename")
            .to_string_lossy()
            .into_owned();
        let status = std::process::Command::new("/usr/bin/git")
            .arg("-C")
            .arg(&root)
            .args([
                "remote",
                "add",
                "origin",
                "git@github.com:secret-owner/private-repo.git",
            ])
            .status()
            .expect("add origin");
        assert!(status.success());
        let service =
            WorkspaceService::new(CodexSupervisor::new(), Arc::new(FixedPicker(root.clone())));
        let candidate = service
            .validate_workspace_root(
                root.clone(),
                "workspace-private".to_owned(),
                "Private Acquisition".to_owned(),
            )
            .await
            .expect("validated workspace");
        service
            .activate_candidate(candidate)
            .await
            .expect("activated workspace");

        let terms = service
            .presence_identity_terms("workspace-private")
            .await
            .expect("native identity terms");
        for expected in [
            "Private Acquisition",
            root_basename.as_str(),
            "secret-owner/private-repo",
            "secret-owner",
            "private-repo",
        ] {
            assert!(
                terms.iter().any(|term| term == expected),
                "missing {expected}"
            );
        }
        let encoded = serde_json::to_string(
            &service
                .trusted
                .lock()
                .await
                .get("workspace-private")
                .expect("trusted workspace")
                .registration,
        )
        .expect("public registration");
        assert!(!encoded.contains("secret-owner"));
        assert!(!encoded.contains("private-repo"));
        let _ = fs::remove_dir_all(root);
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
    async fn candidate_revalidation_rejects_same_path_git_directory_replacement() {
        let root = git_repository();
        fs::write(root.join("README.md"), "preserve source\n").expect("source fixture");
        let service =
            WorkspaceService::new(CodexSupervisor::new(), Arc::new(FixedPicker(root.clone())));
        let candidate = service.pick_validated().await.expect("candidate");
        fs::rename(root.join(".git"), root.join(".git-preserved"))
            .expect("preserve original git directory");
        let status = std::process::Command::new("/usr/bin/git")
            .args(["init", "-q", "-b", "main"])
            .arg(&root)
            .status()
            .expect("replacement git init");
        assert!(status.success());
        let source_before = fs::read(root.join("README.md")).expect("source before");
        let head_before = fs::read(root.join(".git/HEAD")).expect("HEAD before");

        let error = service
            .revalidate_candidate(&candidate)
            .await
            .expect_err("replacement must be rejected");
        assert_eq!(error.code, "CODEX-WORKSPACE-IDENTITY-CHANGED");
        assert_eq!(
            fs::read(root.join("README.md")).expect("source after"),
            source_before
        );
        assert_eq!(
            fs::read(root.join(".git/HEAD")).expect("HEAD after"),
            head_before
        );
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn immutable_repository_identity_survives_a_same_filesystem_move() {
        let root = git_repository();
        let before = validate_git_repository(&root)
            .await
            .expect("identity before move");
        let moved = root.with_file_name(format!("coding-wife-repo-moved-{}", uuid::Uuid::new_v4()));
        fs::rename(&root, &moved).expect("move repository");
        let after = validate_git_repository(&moved)
            .await
            .expect("identity after move");

        assert_ne!(before.canonical_root, after.canonical_root);
        assert!(same_repository_identity(&before, &after));
        let _ = fs::remove_dir_all(moved);
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

        let project_identity = validate_git_repository(&root)
            .await
            .expect("project identity");
        let identity = validate_git_repository(&worktree)
            .await
            .expect("linked worktree identity");
        let marker = fs::read_to_string(worktree.join(".git")).expect("worktree marker");
        let raw_git_dir = marker.trim().trim_start_matches("gitdir: ");

        assert_eq!(identity.branch, "fixture-linked");
        assert_ne!(identity.head, "unborn");
        assert_eq!(identity.head.len(), 12);
        assert_ne!(identity.git_inode, project_identity.git_inode);
        assert_eq!(
            identity.common_git_device,
            project_identity.common_git_device
        );
        assert_eq!(identity.common_git_inode, project_identity.common_git_inode);
        assert_ne!(identity.root_inode, project_identity.root_inode);
        assert_ne!(identity.project_identity, project_identity.project_identity);
        assert!(matches_saved_git_repository(
            &identity,
            &AppPrivateProjectIdentity {
                project_id: "project-linked-fixture".to_owned(),
                canonical_root: project_identity.canonical_root.clone(),
                project_identity: project_identity.project_identity.clone(),
                root_device: project_identity.root_device,
                root_inode: project_identity.root_inode,
                git_device: project_identity.git_device,
                git_inode: project_identity.git_inode,
                common_git_device: Some(project_identity.common_git_device),
                common_git_inode: Some(project_identity.common_git_inode),
            },
        ));
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

    #[tokio::test]
    async fn write_authority_adds_only_linked_worktree_git_metadata_roots() {
        let fixture = secure_fixture_directory("write-authority");
        let project = fixture.join("project");
        let worktree = fixture.join("managed-worktree");
        committed_repository(&project);
        let add_worktree = std::process::Command::new("/usr/bin/git")
            .arg("-C")
            .arg(&project)
            .args(["worktree", "add", "-q", "-b", "managed-fixture"])
            .arg(&worktree)
            .status()
            .expect("create managed worktree fixture");
        assert!(add_worktree.success());

        let project_identity = validate_git_repository(&project)
            .await
            .expect("project identity");
        let project_authority = validate_workspace_write_authority(&project_identity, None)
            .await
            .expect("ordinary repository authority");
        assert!(project_authority.additional_writable_roots.is_empty());

        let worktree_identity = validate_git_repository(&worktree)
            .await
            .expect("worktree identity");
        let manual_authority = validate_workspace_write_authority(&worktree_identity, None)
            .await
            .expect("manual linked worktree authority");
        assert!(manual_authority.additional_writable_roots.is_empty());

        let managed_identity =
            AppPrivateManagedWorktreeIdentity::from_repository(&worktree_identity);
        let authority =
            validate_workspace_write_authority(&worktree_identity, Some(&managed_identity))
                .await
                .expect("managed worktree authority");
        assert_eq!(authority.workspace_root, worktree_identity.canonical_root);
        assert_eq!(
            authority.additional_writable_roots,
            vec![
                worktree_identity.canonical_git_dir.clone(),
                worktree_identity.canonical_common_git_dir.clone(),
            ]
        );
        assert!(!authority.additional_writable_roots.contains(&project));
        assert_eq!(
            authority.runtime_workspace_roots(),
            vec![
                worktree_identity.canonical_root,
                worktree_identity.canonical_git_dir,
                worktree_identity.canonical_common_git_dir,
            ]
        );

        let _ = fs::remove_dir_all(fixture);
    }

    #[tokio::test]
    async fn write_authority_rejects_a_retargeted_external_git_directory() {
        let fixture = secure_fixture_directory("write-authority-retarget");
        let first_project = fixture.join("first-project");
        let first_worktree = fixture.join("first-worktree");
        let second_project = fixture.join("second-project");
        let second_worktree = fixture.join("second-worktree");
        committed_repository(&first_project);
        committed_repository(&second_project);
        for (project, worktree, branch) in [
            (&first_project, &first_worktree, "first-managed"),
            (&second_project, &second_worktree, "second-managed"),
        ] {
            let status = std::process::Command::new("/usr/bin/git")
                .arg("-C")
                .arg(project)
                .args(["worktree", "add", "-q", "-b", branch])
                .arg(worktree)
                .status()
                .expect("create retarget fixture worktree");
            assert!(status.success());
        }
        let expected = validate_git_repository(&first_worktree)
            .await
            .expect("expected worktree identity");
        let managed_identity = AppPrivateManagedWorktreeIdentity::from_repository(&expected);
        let replacement = validate_git_repository(&second_worktree)
            .await
            .expect("replacement worktree identity");
        fs::write(
            first_worktree.join(".git"),
            format!("gitdir: {}\n", replacement.canonical_git_dir.display()),
        )
        .expect("retarget worktree marker");

        let error = validate_workspace_write_authority(&expected, Some(&managed_identity))
            .await
            .expect_err("retargeted metadata must fail closed");
        assert_eq!(error.code, "CODEX-WORKSPACE-IDENTITY-CHANGED");

        let _ = fs::remove_dir_all(fixture);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn manual_separate_git_directory_gets_no_additional_write_roots() {
        use std::os::unix::fs::PermissionsExt;

        let fixture = secure_fixture_directory("write-authority-separate-git-dir");
        let root = fixture.join("project");
        let git_dir = fixture.join("separate-git-dir");
        fs::create_dir_all(&root).expect("project root");
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
        fs::set_permissions(&git_dir, fs::Permissions::from_mode(0o700))
            .expect("secure git directory permissions");
        fs::set_permissions(root.join(".git"), fs::Permissions::from_mode(0o600))
            .expect("secure marker permissions");

        let identity = validate_git_repository(&root)
            .await
            .expect("manual separate-git-dir identity");
        let authority = validate_workspace_write_authority(&identity, None)
            .await
            .expect("manual separate-git-dir authority");

        assert_eq!(authority.workspace_root, identity.canonical_root);
        assert!(authority.additional_writable_roots.is_empty());
        assert_eq!(authority.runtime_workspace_roots().len(), 1);

        let _ = fs::remove_dir_all(fixture);
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
