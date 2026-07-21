use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Component, Path};

use chrono::Utc;
use sha2::{Digest, Sha256};

use crate::codex::workspace::validate_git_repository;
use crate::platform_fs::{current_user_id, MetadataExt, PermissionsExt};

use super::error::{git_error, GitReviewError};
pub(crate) use super::git_layout::is_object_id;
use super::git_layout::{GitLayoutError, GitRepositoryLayout};
use super::runner::{GitRunner, GitRunnerError};
use super::types::{
    ChangeKind, GitObservation, GitSupportState, ObserveGitRepositoryRequest,
    ProtectedChangeSummary, GIT_REVIEW_SCHEMA_VERSION, MAX_CHANGED_BYTES, MAX_CHANGED_FILES,
};

const OPERATION_INSPECT: &str = "inspect_git_baseline";
const MAX_INDEX_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Clone, Debug, Eq, PartialEq)]
struct IndexState {
    bytes_fingerprint: String,
    metadata_fingerprint: String,
    locked: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum FileMaterial {
    Missing,
    Regular(Vec<u8>),
    Symlink(Vec<u8>),
}

impl FileMaterial {
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

#[derive(Clone, Debug, Eq, PartialEq)]
struct StatusEntry {
    path: String,
    staged: bool,
    unstaged: bool,
    untracked: bool,
    conflicted: bool,
}

pub(crate) async fn capture_observation(
    runner: &GitRunner,
    request: &ObserveGitRepositoryRequest,
    root: &Path,
) -> Result<GitObservation, GitReviewError> {
    validate_workspace_id(&request.workspace_id)?;
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
            change_kind: if entry.untracked {
                ChangeKind::Added
            } else if matches!(entry.material, FileMaterial::Missing) {
                ChangeKind::Deleted
            } else {
                ChangeKind::Modified
            },
            staged: entry.staged,
            unstaged: entry.unstaged,
            untracked: entry.untracked,
        })
        .collect();
    let public = GitObservation {
        schema_version: GIT_REVIEW_SCHEMA_VERSION,
        observation_id: observation_id(request),
        workspace_id: request.workspace_id.clone(),
        workspace_generation: request.workspace_generation,
        reason: request.reason,
        work_unit_id: request.work_unit_id.clone(),
        source_event_id: request.source_event_id.clone(),
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
        history_sequence: None,
    };
    Ok(public)
}

pub(crate) fn observation_id(request: &ObserveGitRepositoryRequest) -> String {
    let mut hasher = Sha256::new();
    hasher.update(request.workspace_id.as_bytes());
    hasher.update(request.workspace_generation.to_le_bytes());
    hasher.update(request.client_request_id.as_bytes());
    hasher.update([request.reason as u8]);
    if let Some(work_unit_id) = &request.work_unit_id {
        hasher.update(work_unit_id.as_bytes());
    }
    if let Some(source_event_id) = &request.source_event_id {
        hasher.update(source_event_id.as_bytes());
    }
    format!("observation-{}", &hex::encode(hasher.finalize())[..24])
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
    let layout = GitRepositoryLayout::inspect(&canonical_root).map_err(layout_inspect_error)?;
    if layout.canonical_root != canonical_root || layout.canonical_git_dir != canonical_git_dir {
        return Err(git_error(
            "GIT-REPOSITORY-IDENTITY",
            OPERATION_INSPECT,
            false,
        ));
    }
    let canonical_common_dir = layout.canonical_common_dir.clone();
    let mut blocked_reasons = Vec::new();
    let head_sha = layout.head_sha.clone();
    if head_sha == "unborn" {
        blocked_reasons.push("GIT-HEAD-UNBORN".to_owned());
    }
    let head_reference = layout.head_reference.clone();
    let detached = head_reference.is_none();
    let branch = head_reference
        .as_deref()
        .and_then(|value| value.strip_prefix("refs/heads/"))
        .map(str::to_owned)
        .unwrap_or_else(|| head_sha.chars().take(12).collect());

    if is_submodule_layout(&canonical_common_dir) {
        blocked_reasons.push("GIT-SUBMODULE-ROOT-UNSUPPORTED".to_owned());
    }
    if let Some(value) = read_local_config_value(&canonical_common_dir, "core", "sparsecheckout")? {
        match parse_git_bool(&value) {
            Some(false) => {}
            Some(true) => blocked_reasons.push("GIT-SPARSE-CHECKOUT-UNSUPPORTED".to_owned()),
            None => blocked_reasons.push("GIT-SPARSE-CHECKOUT-UNKNOWN".to_owned()),
        }
    }
    for state in [
        "MERGE_HEAD",
        "CHERRY_PICK_HEAD",
        "REVERT_HEAD",
        "BISECT_LOG",
        "rebase-merge",
        "rebase-apply",
    ] {
        if metadata_state_exists(&canonical_git_dir, &canonical_common_dir, state)? {
            blocked_reasons.push(format!("GIT-OPERATION-IN-PROGRESS:{state}"));
        }
    }

    let index_state_before = read_index_state(&layout.index_file)?;
    if index_state_before.locked {
        blocked_reasons.push("GIT-INDEX-LOCKED".to_owned());
    }
    let index_output = runner
        .index_entries(&canonical_root)
        .await
        .map_err(runner_inspect_error)?;
    if !index_output.status.success() {
        return Err(git_error("GIT-INDEX-READ", OPERATION_INSPECT, true));
    }
    let index_fingerprint = index_fingerprint(&index_state_before, &index_output.stdout);
    let status_output = runner
        .status_porcelain(&canonical_root)
        .await
        .map_err(runner_inspect_error)?;
    if !status_output.status.success() {
        return Err(git_error("GIT-STATUS-READ", OPERATION_INSPECT, true));
    }
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

    let index_state_after = read_index_state(&layout.index_file)?;
    let index_after = runner
        .index_entries(&canonical_root)
        .await
        .map_err(runner_inspect_error)?;
    let status_after = runner
        .status_porcelain(&canonical_root)
        .await
        .map_err(runner_inspect_error)?;
    let layout_after =
        GitRepositoryLayout::inspect(&canonical_root).map_err(layout_inspect_error)?;
    if index_state_after != index_state_before
        || !index_after.status.success()
        || index_after.stdout != index_output.stdout
        || !status_after.status.success()
        || status_after.stdout != status_output.stdout
        || layout_after.head_sha != layout.head_sha
        || layout_after.head_reference != layout.head_reference
    {
        return Err(git_error("GIT-STATE-RACE", OPERATION_INSPECT, true));
    }
    for entry in changes.values() {
        let material = read_worktree_material(&canonical_root, &entry.relative_path).await?;
        let mode = worktree_mode(&canonical_root, &entry.relative_path).await?;
        if material != entry.material || mode != entry.mode {
            return Err(git_error("GIT-STATE-RACE", OPERATION_INSPECT, true));
        }
    }
    blocked_reasons.sort();
    blocked_reasons.dedup();

    let identity = RepositoryIdentity {
        root_device: validated.root_device,
        root_inode: validated.root_inode,
        git_device: validated.git_device,
        git_inode: validated.git_inode,
        head_sha,
        head_reference,
        branch,
        detached,
    };
    let status_fingerprint = status_fingerprint(&status_output.stdout, &changes);
    let repository_fingerprint =
        repository_fingerprint(&identity, &index_fingerprint, &status_fingerprint, &changes);
    Ok(RepositorySnapshot {
        identity,
        index_fingerprint,
        status_fingerprint,
        repository_fingerprint,
        changes,
        blocked_reasons,
    })
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
        if metadata.permissions().mode() & 0o111 != 0 {
            return Ok(Some("100755".to_owned()));
        }
    }
    Ok(Some("100644".to_owned()))
}

pub(crate) fn repository_fingerprint(
    identity: &RepositoryIdentity,
    index_fingerprint: &str,
    status_fingerprint: &str,
    changes: &BTreeMap<String, FileSnapshot>,
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
    hash_changes(&mut hasher, changes);
    format!("sha256:{}", hex::encode(hasher.finalize()))
}

pub(crate) fn file_id(relative_path: &str) -> String {
    let digest = Sha256::digest(relative_path.as_bytes());
    format!("file-{}", &hex::encode(digest)[..24])
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

pub(crate) fn read_local_config_value(
    common_dir: &Path,
    expected_section: &str,
    expected_key: &str,
) -> Result<Option<String>, GitReviewError> {
    let path = common_dir.join("config");
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(git_error("GIT-CONFIG-READ", OPERATION_INSPECT, true)),
    };
    let uid = current_user_id();
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() > 1024 * 1024
        || !matches!(metadata.uid(), owner if owner == uid || owner == 0)
        || metadata.permissions().mode() & 0o022 != 0
    {
        return Err(git_error("GIT-CONFIG-UNTRUSTED", OPERATION_INSPECT, false));
    }
    let contents = fs::read_to_string(path)
        .map_err(|_| git_error("GIT-CONFIG-READ", OPERATION_INSPECT, true))?;
    if contents.contains('\0') {
        return Err(git_error("GIT-CONFIG-UNTRUSTED", OPERATION_INSPECT, false));
    }
    let mut section = String::new();
    let mut result = None;
    for raw_line in contents.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with(';') {
            continue;
        }
        if line.starts_with('[') {
            let Some(value) = line
                .strip_prefix('[')
                .and_then(|value| value.strip_suffix(']'))
            else {
                return Err(git_error("GIT-CONFIG-UNTRUSTED", OPERATION_INSPECT, false));
            };
            section = value
                .split_ascii_whitespace()
                .next()
                .unwrap_or_default()
                .to_ascii_lowercase();
            continue;
        }
        if section != expected_section.to_ascii_lowercase() {
            continue;
        }
        let (key, value) = line
            .split_once('=')
            .map(|(key, value)| (key.trim(), value.trim()))
            .unwrap_or((line, "true"));
        if key.eq_ignore_ascii_case(expected_key) {
            result = Some(parse_config_scalar(value)?);
        }
    }
    Ok(result)
}

fn parse_config_scalar(value: &str) -> Result<String, GitReviewError> {
    let value = if value.starts_with('"') && value.ends_with('"') && value.len() >= 2 {
        &value[1..value.len() - 1]
    } else {
        value
    };
    if value.len() > 4_096 || value.chars().any(|character| character == '\0') {
        return Err(git_error("GIT-CONFIG-UNTRUSTED", OPERATION_INSPECT, false));
    }
    Ok(value.replace("\\\"", "\"").replace("\\\\", "\\"))
}

fn parse_git_bool(value: &str) -> Option<bool> {
    match value.trim().to_ascii_lowercase().as_str() {
        "true" | "yes" | "on" | "1" => Some(true),
        "false" | "no" | "off" | "0" | "" => Some(false),
        _ => None,
    }
}

fn is_submodule_layout(common_dir: &Path) -> bool {
    let components = common_dir
        .components()
        .filter_map(|component| component.as_os_str().to_str())
        .collect::<Vec<_>>();
    components
        .windows(2)
        .any(|pair| pair[0].eq_ignore_ascii_case(".git") && pair[1] == "modules")
}

fn metadata_state_exists(
    git_dir: &Path,
    common_dir: &Path,
    name: &str,
) -> Result<bool, GitReviewError> {
    for base in [git_dir, common_dir] {
        match fs::symlink_metadata(base.join(name)) {
            Ok(_) => return Ok(true),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(git_error("GIT-OPERATION-STATE", OPERATION_INSPECT, true)),
        }
    }
    Ok(false)
}

fn read_index_state(index_file: &Path) -> Result<IndexState, GitReviewError> {
    let lock_file = index_file.with_extension("lock");
    let lock_metadata = match fs::symlink_metadata(&lock_file) {
        Ok(metadata) => Some(metadata),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(_) => return Err(git_error("GIT-INDEX-LOCK", OPERATION_INSPECT, true)),
    };
    let locked = lock_metadata.is_some();
    let (bytes_fingerprint, mut metadata_fingerprint) = match fs::symlink_metadata(index_file) {
        Ok(before) => {
            validate_index_metadata(&before)?;
            let bytes = fs::read(index_file)
                .map_err(|_| git_error("GIT-INDEX-READ", OPERATION_INSPECT, true))?;
            let after = fs::symlink_metadata(index_file)
                .map_err(|_| git_error("GIT-INDEX-READ", OPERATION_INSPECT, true))?;
            validate_index_metadata(&after)?;
            if file_metadata_fingerprint(&before) != file_metadata_fingerprint(&after) {
                return Err(git_error("GIT-STATE-RACE", OPERATION_INSPECT, true));
            }
            (bytes_hash(&bytes), file_metadata_fingerprint(&after))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            ("missing".to_owned(), "missing".to_owned())
        }
        Err(_) => return Err(git_error("GIT-INDEX-READ", OPERATION_INSPECT, true)),
    };
    metadata_fingerprint.push('|');
    metadata_fingerprint.push_str(
        &lock_metadata
            .as_ref()
            .map(file_metadata_fingerprint)
            .unwrap_or_else(|| "unlocked".to_owned()),
    );
    Ok(IndexState {
        bytes_fingerprint,
        metadata_fingerprint,
        locked,
    })
}

fn validate_index_metadata(metadata: &fs::Metadata) -> Result<(), GitReviewError> {
    let uid = current_user_id();
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() > MAX_INDEX_BYTES
        || !matches!(metadata.uid(), owner if owner == uid || owner == 0)
        || metadata.permissions().mode() & 0o022 != 0
    {
        return Err(git_error("GIT-INDEX-UNTRUSTED", OPERATION_INSPECT, false));
    }
    Ok(())
}

fn file_metadata_fingerprint(metadata: &fs::Metadata) -> String {
    format!(
        "{}:{}:{}:{}:{}:{}:{}:{}:{}:{}",
        metadata.dev(),
        metadata.ino(),
        metadata.uid(),
        metadata.gid(),
        metadata.permissions().mode(),
        metadata.len(),
        metadata.mtime(),
        metadata.mtime_nsec(),
        metadata.ctime(),
        metadata.ctime_nsec(),
    )
}

fn index_fingerprint(index: &IndexState, canonical_entries: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(index.bytes_fingerprint.as_bytes());
    hasher.update(index.metadata_fingerprint.as_bytes());
    hasher.update([u8::from(index.locked)]);
    hasher.update(canonical_entries);
    format!("sha256:{}", hex::encode(hasher.finalize()))
}

fn status_fingerprint(porcelain_status: &[u8], changes: &BTreeMap<String, FileSnapshot>) -> String {
    let mut hasher = Sha256::new();
    hasher.update(porcelain_status);
    hash_changes(&mut hasher, changes);
    format!("sha256:{}", hex::encode(hasher.finalize()))
}

fn hash_changes(hasher: &mut Sha256, changes: &BTreeMap<String, FileSnapshot>) {
    for (path, entry) in changes {
        hasher.update((path.len() as u64).to_le_bytes());
        hasher.update(path.as_bytes());
        match &entry.material {
            FileMaterial::Missing => hasher.update([0]),
            FileMaterial::Regular(bytes) => {
                hasher.update([1]);
                hasher.update((bytes.len() as u64).to_le_bytes());
                hasher.update(Sha256::digest(bytes));
            }
            FileMaterial::Symlink(bytes) => {
                hasher.update([2]);
                hasher.update((bytes.len() as u64).to_le_bytes());
                hasher.update(Sha256::digest(bytes));
            }
        }
        if let Some(mode) = &entry.mode {
            hasher.update([1]);
            hasher.update(mode.as_bytes());
        } else {
            hasher.update([0]);
        }
        hasher.update([
            u8::from(entry.staged),
            u8::from(entry.unstaged),
            u8::from(entry.untracked),
        ]);
    }
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

fn layout_inspect_error(error: GitLayoutError) -> GitReviewError {
    match error {
        GitLayoutError::Invalid => git_error("GIT-REPOSITORY-IDENTITY", OPERATION_INSPECT, false),
        GitLayoutError::Io => git_error("GIT-REPOSITORY-READ", OPERATION_INSPECT, true),
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
