use std::collections::{BTreeMap, BTreeSet};
use std::path::{Component, Path, PathBuf};

use chrono::Utc;
use sha2::{Digest, Sha256};

use crate::codex::workspace::validate_git_repository;

use super::error::{git_error, GitReviewError};
use super::runner::{trimmed_stdout, GitRunner, GitRunnerError};
use super::types::{
    GitBaseline, GitSupportState, ProtectedChangeSummary, GIT_REVIEW_SCHEMA_VERSION,
    MAX_CHANGED_BYTES, MAX_CHANGED_FILES,
};

const OPERATION_INSPECT: &str = "inspect_git_baseline";

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum FileMaterial {
    Missing,
    Regular(Vec<u8>),
    Symlink(Vec<u8>),
}

impl FileMaterial {
    pub fn content_hash(&self) -> Option<String> {
        match self {
            Self::Missing => None,
            Self::Regular(bytes) | Self::Symlink(bytes) => Some(content_hash(bytes)),
        }
    }

    pub fn bytes(&self) -> Option<&[u8]> {
        match self {
            Self::Regular(bytes) => Some(bytes),
            Self::Missing | Self::Symlink(_) => None,
        }
    }

    pub fn byte_count(&self) -> u64 {
        match self {
            Self::Missing => 0,
            Self::Regular(bytes) | Self::Symlink(bytes) => bytes.len() as u64,
        }
    }

    pub fn is_symlink(&self) -> bool {
        matches!(self, Self::Symlink(_))
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct FileSnapshot {
    pub relative_path: String,
    pub material: FileMaterial,
    pub mode: Option<String>,
    pub staged: bool,
    pub unstaged: bool,
    pub untracked: bool,
}

#[derive(Clone, Debug)]
pub(crate) struct RepositoryIdentity {
    pub canonical_root: PathBuf,
    pub canonical_git_dir: PathBuf,
    pub canonical_common_dir: PathBuf,
    pub object_directory: PathBuf,
    pub root_device: u64,
    pub root_inode: u64,
    pub git_device: u64,
    pub git_inode: u64,
    pub head_sha: String,
    pub head_reference: Option<String>,
    pub branch: String,
    pub detached: bool,
}

#[derive(Clone, Debug)]
pub(crate) struct RepositorySnapshot {
    pub identity: RepositoryIdentity,
    pub index_fingerprint: String,
    pub status_fingerprint: String,
    pub repository_fingerprint: String,
    pub changes: BTreeMap<String, FileSnapshot>,
    pub blocked_reasons: Vec<String>,
}

#[derive(Clone, Debug)]
pub(crate) struct BaselineRecord {
    pub public: GitBaseline,
    pub repository: RepositoryIdentity,
    pub pre_existing: BTreeMap<String, FileSnapshot>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct StatusEntry {
    path: String,
    staged: bool,
    unstaged: bool,
    untracked: bool,
    conflicted: bool,
}

pub(crate) async fn capture_baseline(
    runner: &GitRunner,
    workspace_id: &str,
    root: &Path,
) -> Result<BaselineRecord, GitReviewError> {
    validate_workspace_id(workspace_id)?;
    let snapshot = inspect_repository(runner, root).await?;
    let support_state = if snapshot.blocked_reasons.is_empty() {
        GitSupportState::Ready
    } else {
        GitSupportState::Blocked
    };
    let pre_existing = snapshot
        .changes
        .values()
        .map(|entry| ProtectedChangeSummary {
            file_id: file_id(&entry.relative_path),
            relative_path: entry.relative_path.clone(),
            staged: entry.staged,
            unstaged: entry.unstaged,
            untracked: entry.untracked,
            content_hash: entry.material.content_hash(),
        })
        .collect();
    let public = GitBaseline {
        schema_version: GIT_REVIEW_SCHEMA_VERSION,
        baseline_id: format!("baseline-{}", uuid::Uuid::new_v4()),
        workspace_id: workspace_id.to_owned(),
        support_state,
        head_sha: snapshot.identity.head_sha.clone(),
        head_reference: snapshot.identity.head_reference.clone(),
        branch: snapshot.identity.branch.clone(),
        detached: snapshot.identity.detached,
        index_fingerprint: snapshot.index_fingerprint.clone(),
        status_fingerprint: snapshot.status_fingerprint.clone(),
        repository_fingerprint: snapshot.repository_fingerprint.clone(),
        pre_existing,
        blocked_reasons: snapshot.blocked_reasons.clone(),
        captured_at: Utc::now().to_rfc3339(),
    };
    Ok(BaselineRecord {
        public,
        repository: snapshot.identity,
        pre_existing: snapshot.changes,
    })
}

pub(crate) async fn inspect_repository(
    runner: &GitRunner,
    root: &Path,
) -> Result<RepositorySnapshot, GitReviewError> {
    let validated = validate_git_repository(root)
        .await
        .map_err(|_| git_error("GIT-REPOSITORY-UNTRUSTED", OPERATION_INSPECT, false))?;
    let canonical_root = validated.canonical_root;
    let canonical_git_dir = validated.canonical_git_dir;

    let common_output = runner
        .git_common_dir(&canonical_root)
        .await
        .map_err(runner_inspect_error)?;
    if !common_output.status.success() {
        return Err(git_error(
            "GIT-REPOSITORY-IDENTITY",
            OPERATION_INSPECT,
            false,
        ));
    }
    let common_value = trimmed_stdout(&common_output).map_err(runner_inspect_error)?;
    let common_path = Path::new(&common_value);
    let canonical_common_dir = tokio::fs::canonicalize(if common_path.is_absolute() {
        common_path.to_path_buf()
    } else {
        canonical_root.join(common_path)
    })
    .await
    .map_err(|_| git_error("GIT-REPOSITORY-IDENTITY", OPERATION_INSPECT, false))?;
    if canonical_common_dir != canonical_git_dir
        && !canonical_git_dir.starts_with(&canonical_common_dir)
    {
        return Err(git_error(
            "GIT-REPOSITORY-CLOSURE",
            OPERATION_INSPECT,
            false,
        ));
    }
    let object_directory = canonical_common_dir.join("objects");
    let object_metadata = tokio::fs::symlink_metadata(&object_directory)
        .await
        .map_err(|_| git_error("GIT-OBJECT-DIRECTORY", OPERATION_INSPECT, false))?;
    if !object_metadata.is_dir() || object_metadata.file_type().is_symlink() {
        return Err(git_error("GIT-OBJECT-DIRECTORY", OPERATION_INSPECT, false));
    }

    let head_output = runner
        .rev_parse_head(&canonical_root)
        .await
        .map_err(runner_inspect_error)?;
    let mut blocked_reasons = Vec::new();
    let head_sha = if head_output.status.success() {
        let value = trimmed_stdout(&head_output).map_err(runner_inspect_error)?;
        if !is_object_id(&value) {
            return Err(git_error("GIT-HEAD-INVALID", OPERATION_INSPECT, false));
        }
        value
    } else {
        blocked_reasons.push("GIT-HEAD-UNBORN".to_owned());
        "unborn".to_owned()
    };
    let symbolic = runner
        .symbolic_head(&canonical_root)
        .await
        .map_err(runner_inspect_error)?;
    let head_reference = if symbolic.status.success() {
        let value = trimmed_stdout(&symbolic).map_err(runner_inspect_error)?;
        if !is_safe_head_reference(&value) {
            return Err(git_error("GIT-HEAD-REFERENCE", OPERATION_INSPECT, false));
        }
        Some(value)
    } else {
        None
    };
    let detached = head_reference.is_none();
    let branch = head_reference
        .as_deref()
        .and_then(|value| value.strip_prefix("refs/heads/"))
        .map(str::to_owned)
        .unwrap_or_else(|| head_sha.chars().take(12).collect());

    let superproject = runner
        .show_superproject(&canonical_root)
        .await
        .map_err(runner_inspect_error)?;
    if !superproject.status.success() {
        blocked_reasons.push("GIT-SUBMODULE-STATE-UNKNOWN".to_owned());
    } else if !trimmed_stdout(&superproject)
        .map_err(runner_inspect_error)?
        .is_empty()
    {
        blocked_reasons.push("GIT-SUBMODULE-ROOT-UNSUPPORTED".to_owned());
    }
    let sparse = runner
        .config_get(&canonical_root, "core.sparseCheckout")
        .await
        .map_err(runner_inspect_error)?;
    if sparse.status.success()
        && trimmed_stdout(&sparse)
            .map_err(runner_inspect_error)?
            .eq_ignore_ascii_case("true")
    {
        blocked_reasons.push("GIT-SPARSE-CHECKOUT-UNSUPPORTED".to_owned());
    }
    for state in [
        "MERGE_HEAD",
        "CHERRY_PICK_HEAD",
        "REVERT_HEAD",
        "BISECT_LOG",
        "rebase-merge",
        "rebase-apply",
    ] {
        let output = runner
            .git_path(&canonical_root, state)
            .await
            .map_err(runner_inspect_error)?;
        if !output.status.success() {
            blocked_reasons.push("GIT-OPERATION-STATE-UNKNOWN".to_owned());
            continue;
        }
        let value = trimmed_stdout(&output).map_err(runner_inspect_error)?;
        let path = Path::new(&value);
        let resolved = if path.is_absolute() {
            path.to_path_buf()
        } else {
            canonical_root.join(path)
        };
        if tokio::fs::symlink_metadata(&resolved).await.is_ok() {
            blocked_reasons.push(format!("GIT-OPERATION-IN-PROGRESS:{state}"));
        }
    }

    let index_output = runner
        .index_entries(&canonical_root)
        .await
        .map_err(runner_inspect_error)?;
    if !index_output.status.success() {
        return Err(git_error("GIT-INDEX-READ", OPERATION_INSPECT, true));
    }
    let index_fingerprint = bytes_hash(&index_output.stdout);
    let status_output = runner
        .status_porcelain(&canonical_root)
        .await
        .map_err(runner_inspect_error)?;
    if !status_output.status.success() {
        return Err(git_error("GIT-STATUS-READ", OPERATION_INSPECT, true));
    }
    let status_fingerprint = bytes_hash(&status_output.stdout);
    let entries = parse_status(&status_output.stdout)?;
    if entries.len() > MAX_CHANGED_FILES {
        blocked_reasons.push("GIT-LIMIT-FILES".to_owned());
    }
    if entries.iter().any(|entry| entry.conflicted) {
        blocked_reasons.push("GIT-INDEX-CONFLICT".to_owned());
    }
    let mut changes = BTreeMap::new();
    let mut total_bytes = 0_u64;
    for entry in entries.into_iter().take(MAX_CHANGED_FILES + 1) {
        let material = read_worktree_material(&canonical_root, &entry.path).await?;
        total_bytes = total_bytes.saturating_add(material.byte_count());
        let mode = worktree_mode(&canonical_root, &entry.path).await?;
        if material.is_symlink() {
            blocked_reasons.push(format!("GIT-SYMLINK-UNSUPPORTED:{}", entry.path));
        }
        changes.insert(
            entry.path.clone(),
            FileSnapshot {
                relative_path: entry.path,
                material,
                mode,
                staged: entry.staged,
                unstaged: entry.unstaged,
                untracked: entry.untracked,
            },
        );
    }
    if total_bytes > MAX_CHANGED_BYTES {
        blocked_reasons.push("GIT-LIMIT-BYTES".to_owned());
    }
    blocked_reasons.sort();
    blocked_reasons.dedup();

    let identity = RepositoryIdentity {
        canonical_root,
        canonical_git_dir,
        canonical_common_dir,
        object_directory,
        root_device: validated.root_device,
        root_inode: validated.root_inode,
        git_device: validated.git_device,
        git_inode: validated.git_inode,
        head_sha,
        head_reference,
        branch,
        detached,
    };
    let repository_fingerprint =
        repository_fingerprint(&identity, &index_fingerprint, &status_fingerprint);
    Ok(RepositorySnapshot {
        identity,
        index_fingerprint,
        status_fingerprint,
        repository_fingerprint,
        changes,
        blocked_reasons,
    })
}

pub(crate) fn same_repository_identity(
    expected: &RepositoryIdentity,
    actual: &RepositoryIdentity,
) -> bool {
    expected.canonical_root == actual.canonical_root
        && expected.canonical_git_dir == actual.canonical_git_dir
        && expected.canonical_common_dir == actual.canonical_common_dir
        && expected.root_device == actual.root_device
        && expected.root_inode == actual.root_inode
        && expected.git_device == actual.git_device
        && expected.git_inode == actual.git_inode
}

pub(crate) async fn read_worktree_material(
    root: &Path,
    relative_path: &str,
) -> Result<FileMaterial, GitReviewError> {
    validate_relative_path(relative_path)?;
    reject_symlink_ancestors(root, relative_path).await?;
    let path = root.join(relative_path);
    let metadata = match tokio::fs::symlink_metadata(&path).await {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(FileMaterial::Missing)
        }
        Err(_) => return Err(git_error("GIT-FILE-READ", OPERATION_INSPECT, true)),
    };
    if metadata.file_type().is_symlink() {
        let target = tokio::fs::read_link(&path)
            .await
            .map_err(|_| git_error("GIT-SYMLINK-READ", OPERATION_INSPECT, false))?;
        return Ok(FileMaterial::Symlink(
            target.as_os_str().to_string_lossy().as_bytes().to_vec(),
        ));
    }
    if !metadata.is_file() || metadata.len() > MAX_CHANGED_BYTES {
        return Err(git_error("GIT-FILE-UNSUPPORTED", OPERATION_INSPECT, false));
    }
    let bytes = tokio::fs::read(path)
        .await
        .map_err(|_| git_error("GIT-FILE-READ", OPERATION_INSPECT, true))?;
    Ok(FileMaterial::Regular(bytes))
}

pub(crate) async fn worktree_mode(
    root: &Path,
    relative_path: &str,
) -> Result<Option<String>, GitReviewError> {
    let path = root.join(relative_path);
    let metadata = match tokio::fs::symlink_metadata(path).await {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(git_error("GIT-FILE-METADATA", OPERATION_INSPECT, true)),
    };
    if metadata.file_type().is_symlink() {
        return Ok(Some("120000".to_owned()));
    }
    if !metadata.is_file() {
        return Err(git_error("GIT-FILE-UNSUPPORTED", OPERATION_INSPECT, false));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o111 != 0 {
            return Ok(Some("100755".to_owned()));
        }
    }
    Ok(Some("100644".to_owned()))
}

pub(crate) async fn head_material(
    runner: &GitRunner,
    repository: &RepositoryIdentity,
    relative_path: &str,
) -> Result<(FileMaterial, Option<String>), GitReviewError> {
    validate_relative_path(relative_path)?;
    if repository.head_sha == "unborn" {
        return Ok((FileMaterial::Missing, None));
    }
    let output = runner
        .ls_tree_entry(
            &repository.canonical_root,
            &repository.head_sha,
            relative_path,
        )
        .await
        .map_err(runner_inspect_error)?;
    if !output.status.success() {
        return Err(git_error("GIT-TREE-READ", OPERATION_INSPECT, true));
    }
    if output.stdout.is_empty() {
        return Ok((FileMaterial::Missing, None));
    }
    let record = output
        .stdout
        .strip_suffix(&[0])
        .ok_or_else(|| git_error("GIT-TREE-DECODE", OPERATION_INSPECT, false))?;
    let separator = record
        .iter()
        .position(|byte| *byte == b'\t')
        .ok_or_else(|| git_error("GIT-TREE-DECODE", OPERATION_INSPECT, false))?;
    let (metadata, path_with_separator) = record.split_at(separator);
    let path = &path_with_separator[1..];
    let path = std::str::from_utf8(path)
        .map_err(|_| git_error("GIT-PATH-ENCODING", OPERATION_INSPECT, false))?;
    if path != relative_path {
        return Err(git_error("GIT-TREE-PATH", OPERATION_INSPECT, false));
    }
    let metadata = std::str::from_utf8(metadata)
        .map_err(|_| git_error("GIT-TREE-DECODE", OPERATION_INSPECT, false))?;
    let mut fields = metadata.split_ascii_whitespace();
    let mode = fields.next().unwrap_or_default();
    let kind = fields.next().unwrap_or_default();
    let object_id = fields.next().unwrap_or_default();
    if fields.next().is_some() || !is_object_id(object_id) {
        return Err(git_error("GIT-TREE-DECODE", OPERATION_INSPECT, false));
    }
    if mode == "160000" || kind == "commit" {
        return Err(git_error(
            "GIT-SUBMODULE-UNSUPPORTED",
            OPERATION_INSPECT,
            false,
        ));
    }
    if mode == "120000" {
        return Err(git_error(
            "GIT-SYMLINK-UNSUPPORTED",
            OPERATION_INSPECT,
            false,
        ));
    }
    if kind != "blob" || !matches!(mode, "100644" | "100755") {
        return Err(git_error("GIT-TREE-TYPE", OPERATION_INSPECT, false));
    }
    let blob = runner
        .cat_blob(&repository.canonical_root, object_id)
        .await
        .map_err(runner_inspect_error)?;
    if !blob.status.success() {
        return Err(git_error("GIT-BLOB-READ", OPERATION_INSPECT, true));
    }
    if blob.stdout.len() as u64 > MAX_CHANGED_BYTES {
        return Err(git_error("GIT-LIMIT-BYTES", OPERATION_INSPECT, false));
    }
    Ok((FileMaterial::Regular(blob.stdout), Some(mode.to_owned())))
}

pub(crate) fn repository_fingerprint(
    identity: &RepositoryIdentity,
    index_fingerprint: &str,
    status_fingerprint: &str,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(identity.root_device.to_le_bytes());
    hasher.update(identity.root_inode.to_le_bytes());
    hasher.update(identity.git_device.to_le_bytes());
    hasher.update(identity.git_inode.to_le_bytes());
    hasher.update(identity.head_sha.as_bytes());
    if let Some(reference) = &identity.head_reference {
        hasher.update(reference.as_bytes());
    }
    hasher.update(index_fingerprint.as_bytes());
    hasher.update(status_fingerprint.as_bytes());
    format!("sha256:{}", hex::encode(hasher.finalize()))
}

pub(crate) fn content_hash(bytes: &[u8]) -> String {
    bytes_hash(bytes)
}

pub(crate) fn file_id(relative_path: &str) -> String {
    let digest = Sha256::digest(relative_path.as_bytes());
    format!("file-{}", &hex::encode(digest)[..24])
}

pub(crate) fn is_object_id(value: &str) -> bool {
    matches!(value.len(), 40 | 64) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

pub(crate) fn validate_workspace_id(value: &str) -> Result<(), GitReviewError> {
    validate_opaque_id(value, "GIT-WORKSPACE-ID")
}

pub(crate) fn validate_opaque_id(value: &str, code: &'static str) -> Result<(), GitReviewError> {
    if value.is_empty()
        || value.len() > 160
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err(git_error(code, OPERATION_INSPECT, false));
    }
    Ok(())
}

pub(crate) fn validate_relative_path(value: &str) -> Result<(), GitReviewError> {
    if value.is_empty()
        || value.len() > 4096
        || value.contains('\0')
        || value.starts_with('-')
        || value.contains(',')
    {
        return Err(git_error("GIT-PATH-INVALID", OPERATION_INSPECT, false));
    }
    let path = Path::new(value);
    if path.is_absolute() {
        return Err(git_error("GIT-PATH-INVALID", OPERATION_INSPECT, false));
    }
    let mut components = BTreeSet::new();
    for component in path.components() {
        match component {
            Component::Normal(value) => {
                let value = value
                    .to_str()
                    .ok_or_else(|| git_error("GIT-PATH-ENCODING", OPERATION_INSPECT, false))?;
                if value.eq_ignore_ascii_case(".git") {
                    return Err(git_error("GIT-PATH-METADATA", OPERATION_INSPECT, false));
                }
                components.insert(value.to_owned());
            }
            _ => return Err(git_error("GIT-PATH-INVALID", OPERATION_INSPECT, false)),
        }
    }
    if components.is_empty() {
        return Err(git_error("GIT-PATH-INVALID", OPERATION_INSPECT, false));
    }
    Ok(())
}

fn parse_status(bytes: &[u8]) -> Result<Vec<StatusEntry>, GitReviewError> {
    let records = bytes.split(|byte| *byte == 0).collect::<Vec<_>>();
    let mut entries = Vec::new();
    let mut index = 0;
    while index < records.len() {
        let record = records[index];
        index += 1;
        if record.is_empty() {
            continue;
        }
        let kind = record[0];
        match kind {
            b'?' => {
                let path = parse_status_path(record.get(2..).unwrap_or_default())?;
                entries.push(StatusEntry {
                    path,
                    staged: false,
                    unstaged: false,
                    untracked: true,
                    conflicted: false,
                });
            }
            b'1' | b'2' | b'u' => {
                let field_count = match kind {
                    b'1' => 9,
                    b'2' => 10,
                    _ => 11,
                };
                let fields = record
                    .splitn(field_count, |byte| *byte == b' ')
                    .collect::<Vec<_>>();
                if fields.len() != field_count || fields[1].len() != 2 {
                    return Err(git_error("GIT-STATUS-DECODE", OPERATION_INSPECT, false));
                }
                let path = parse_status_path(fields[field_count - 1])?;
                let xy = fields[1];
                entries.push(StatusEntry {
                    path,
                    staged: xy[0] != b'.',
                    unstaged: xy[1] != b'.',
                    untracked: false,
                    conflicted: kind == b'u',
                });
                if kind == b'2' {
                    let origin = records
                        .get(index)
                        .copied()
                        .ok_or_else(|| git_error("GIT-STATUS-DECODE", OPERATION_INSPECT, false))?;
                    index += 1;
                    entries.push(StatusEntry {
                        path: parse_status_path(origin)?,
                        staged: xy[0] != b'.',
                        unstaged: xy[1] != b'.',
                        untracked: false,
                        conflicted: false,
                    });
                }
            }
            b'!' => {}
            _ => return Err(git_error("GIT-STATUS-DECODE", OPERATION_INSPECT, false)),
        }
    }
    entries.sort_by(|left, right| left.path.cmp(&right.path));
    entries.dedup_by(|left, right| {
        if left.path == right.path {
            right.staged |= left.staged;
            right.unstaged |= left.unstaged;
            right.untracked |= left.untracked;
            right.conflicted |= left.conflicted;
            true
        } else {
            false
        }
    });
    Ok(entries)
}

fn parse_status_path(bytes: &[u8]) -> Result<String, GitReviewError> {
    let path = std::str::from_utf8(bytes)
        .map_err(|_| git_error("GIT-PATH-ENCODING", OPERATION_INSPECT, false))?;
    validate_relative_path(path)?;
    Ok(path.to_owned())
}

async fn reject_symlink_ancestors(root: &Path, relative_path: &str) -> Result<(), GitReviewError> {
    let mut current = root.to_path_buf();
    let components = Path::new(relative_path).components().collect::<Vec<_>>();
    for component in components.iter().take(components.len().saturating_sub(1)) {
        let Component::Normal(component) = component else {
            return Err(git_error("GIT-PATH-INVALID", OPERATION_INSPECT, false));
        };
        current.push(component);
        let metadata = tokio::fs::symlink_metadata(&current)
            .await
            .map_err(|_| git_error("GIT-PATH-ANCESTOR", OPERATION_INSPECT, false))?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(git_error("GIT-PATH-SYMLINK", OPERATION_INSPECT, false));
        }
    }
    Ok(())
}

fn bytes_hash(bytes: &[u8]) -> String {
    format!("sha256:{}", hex::encode(Sha256::digest(bytes)))
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

fn runner_inspect_error(error: GitRunnerError) -> GitReviewError {
    match error {
        GitRunnerError::BinaryUnavailable | GitRunnerError::Spawn => {
            git_error("GIT-BINARY-UNAVAILABLE", OPERATION_INSPECT, true)
        }
        GitRunnerError::BinaryIdentityChanged => {
            git_error("GIT-BINARY-IDENTITY-CHANGED", OPERATION_INSPECT, false)
        }
        GitRunnerError::Timeout => git_error("GIT-PROCESS-TIMEOUT", OPERATION_INSPECT, true),
        GitRunnerError::OutputLimit => {
            git_error("GIT-PROCESS-OUTPUT-LIMIT", OPERATION_INSPECT, false)
        }
        GitRunnerError::ProcessTree => git_error("GIT-PROCESS-TREE", OPERATION_INSPECT, false),
        GitRunnerError::Io => git_error("GIT-PROCESS-IO", OPERATION_INSPECT, true),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_paths_reject_metadata_parent_and_argument_like_values() {
        for invalid in [
            "",
            "../secret",
            ".git/config",
            "src/.GIT/config",
            "-n",
            "a,b",
        ] {
            assert!(validate_relative_path(invalid).is_err(), "{invalid}");
        }
        assert!(validate_relative_path("src/main.rs").is_ok());
    }

    #[test]
    fn porcelain_v2_status_is_decoded_without_shell_quoting() {
        let value = b"1 M. N... 100644 100644 100644 aaaaaaa bbbbbbb src/main.rs\0? notes.txt\0";
        let parsed = parse_status(value).expect("status");
        assert_eq!(parsed.len(), 2);
        assert!(parsed[0].untracked || parsed[1].untracked);
        assert!(parsed.iter().any(|entry| entry.staged));
    }
}
