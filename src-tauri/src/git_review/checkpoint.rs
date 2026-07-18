//! Temporary-index checkpoint construction.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use super::error::{git_error, GitReviewError};
use super::ownership::{OwnershipEvaluation, PrivateMaterialDirectory};
use super::repository::{
    inspect_repository, is_object_id, read_local_config_value, read_worktree_material,
    same_repository_identity, worktree_mode, BaselineRecord, FileMaterial, RepositorySnapshot,
};
use super::runner::{
    os_path_list, trimmed_stdout, GitAuthor, GitExecutionContext, GitRunner, GitRunnerError,
};
use super::types::CheckpointIdentity;
use chrono::Utc;

const OPERATION: &str = "evaluate_and_checkpoint_work_unit";

#[derive(Debug)]
pub(crate) struct PreparedCheckpoint {
    _temp: PrivateMaterialDirectory,
    context: GitExecutionContext,
    baseline: BaselineRecord,
    expected_current_fingerprint: String,
    expected_index_fingerprint: String,
    expected_worktree: Vec<(String, Option<String>, Option<String>)>,
    identity: CheckpointIdentity,
    commit_sha: String,
    object_ids: Vec<String>,
}

impl PreparedCheckpoint {
    pub fn identity(&self) -> &CheckpointIdentity {
        &self.identity
    }

    pub fn object_ids(&self) -> &[String] {
        &self.object_ids
    }
}

#[derive(Debug)]
pub(crate) struct PromotedCheckpoint {
    prepared: PreparedCheckpoint,
    promoted_object_ids: Vec<String>,
}

impl PromotedCheckpoint {
    pub fn identity(&self) -> &CheckpointIdentity {
        &self.prepared.identity
    }

    pub fn promoted_object_ids(&self) -> &[String] {
        &self.promoted_object_ids
    }
}

#[derive(Clone, Debug)]
pub(crate) struct CommittedCheckpoint {
    pub identity: CheckpointIdentity,
    pub object_ids: Vec<String>,
    pub index_fingerprint_before: String,
    pub index_fingerprint_after: String,
}

pub(crate) async fn prepare_checkpoint(
    runner: &GitRunner,
    baseline: &BaselineRecord,
    current: &RepositorySnapshot,
    ownership: &OwnershipEvaluation,
    commit_message: &str,
) -> Result<PreparedCheckpoint, GitReviewError> {
    if !ownership.reason_codes.is_empty() || ownership.owned_changes.is_empty() {
        return Err(git_error("GIT-GATE-NOT-PASSED", OPERATION, false));
    }
    validate_commit_message(commit_message)?;
    if baseline.repository.head_sha == "unborn" {
        return Err(git_error("GIT-HEAD-UNBORN", OPERATION, false));
    }
    if !same_repository_identity(&baseline.repository, &current.identity)
        || baseline.public.head_sha != current.identity.head_sha
        || baseline.public.index_fingerprint != current.index_fingerprint
    {
        return Err(git_error("GIT-STATE-STALE", OPERATION, false));
    }
    let author = read_author(runner, &baseline.repository.canonical_root).await?;
    let mut temp = PrivateMaterialDirectory::new("checkpoint")?;
    let object_directory = temp.create_directory("objects")?;
    let _ = create_private_directory(&object_directory, "info")?;
    let _ = create_private_directory(&object_directory, "pack")?;
    let index_file = temp.root().join("index");
    let context = GitExecutionContext {
        index_file: Some(index_file),
        object_directory: Some(object_directory.clone()),
        alternate_object_directories: Some(os_path_list(&[baseline
            .repository
            .object_directory
            .clone()])),
    };
    let read_tree = runner
        .read_tree(
            &baseline.repository.canonical_root,
            &baseline.repository.head_sha,
            &context,
        )
        .await
        .map_err(runner_error)?;
    if !read_tree.status.success() {
        return Err(git_error("GIT-TEMP-INDEX-INIT", OPERATION, true));
    }

    for owned in &ownership.owned_changes {
        match &owned.material {
            FileMaterial::Missing => {
                let output = runner
                    .update_index_remove(
                        &baseline.repository.canonical_root,
                        &owned.relative_path,
                        &context,
                    )
                    .await
                    .map_err(runner_error)?;
                if !output.status.success() {
                    return Err(git_error("GIT-TEMP-INDEX-REMOVE", OPERATION, true));
                }
            }
            FileMaterial::Regular(bytes) => {
                let mode = owned
                    .mode
                    .as_deref()
                    .filter(|mode| matches!(*mode, "100644" | "100755"))
                    .ok_or_else(|| git_error("GIT-FILE-MODE", OPERATION, false))?;
                let material_path = temp.write(bytes)?;
                let hash = runner
                    .hash_object_file(
                        &baseline.repository.canonical_root,
                        &material_path,
                        &context,
                    )
                    .await
                    .map_err(runner_error)?;
                if !hash.status.success() {
                    return Err(git_error("GIT-HASH-OBJECT", OPERATION, true));
                }
                let object_id = trimmed_stdout(&hash).map_err(runner_error)?;
                if !is_object_id(&object_id) {
                    return Err(git_error("GIT-OBJECT-ID", OPERATION, false));
                }
                let update = runner
                    .update_index_cacheinfo(
                        &baseline.repository.canonical_root,
                        mode,
                        &object_id,
                        &owned.relative_path,
                        &context,
                    )
                    .await
                    .map_err(runner_error)?;
                if !update.status.success() {
                    return Err(git_error("GIT-TEMP-INDEX-UPDATE", OPERATION, true));
                }
            }
            FileMaterial::Symlink(_) => {
                return Err(git_error("GIT-SYMLINK-UNSUPPORTED", OPERATION, false));
            }
        }
    }

    let tree = runner
        .write_tree(&baseline.repository.canonical_root, &context)
        .await
        .map_err(runner_error)?;
    if !tree.status.success() {
        return Err(git_error("GIT-WRITE-TREE", OPERATION, true));
    }
    let tree_id = trimmed_stdout(&tree).map_err(runner_error)?;
    if !is_object_id(&tree_id) {
        return Err(git_error("GIT-TREE-ID", OPERATION, false));
    }
    let head_tree = runner
        .rev_parse_tree(
            &baseline.repository.canonical_root,
            &baseline.repository.head_sha,
        )
        .await
        .map_err(runner_error)?;
    if !head_tree.status.success() {
        return Err(git_error("GIT-HEAD-TREE", OPERATION, true));
    }
    if trimmed_stdout(&head_tree).map_err(runner_error)? == tree_id {
        return Err(git_error("GIT-CHECKPOINT-EMPTY", OPERATION, false));
    }
    let message_file = temp.write(commit_message.as_bytes())?;
    let commit = runner
        .commit_tree(
            &baseline.repository.canonical_root,
            &tree_id,
            &baseline.repository.head_sha,
            &message_file,
            &author,
            &context,
        )
        .await
        .map_err(runner_error)?;
    if !commit.status.success() {
        return Err(git_error("GIT-COMMIT-TREE", OPERATION, true));
    }
    let commit_sha = trimmed_stdout(&commit).map_err(runner_error)?;
    if !is_object_id(&commit_sha) {
        return Err(git_error("GIT-COMMIT-ID", OPERATION, false));
    }
    let mut object_ids = enumerate_loose_objects(&object_directory, commit_sha.len())?;
    if !object_ids.iter().any(|value| value == &commit_sha) {
        let commit_type = runner
            .cat_object_type(&baseline.repository.canonical_root, &commit_sha)
            .await
            .map_err(runner_error)?;
        if !commit_type.status.success()
            || trimmed_stdout(&commit_type).map_err(runner_error)? != "commit"
        {
            return Err(git_error("GIT-COMMIT-OBJECT-MISSING", OPERATION, false));
        }
        object_ids.push(commit_sha.clone());
        object_ids.sort();
        object_ids.dedup();
    }
    let observed = inspect_repository(runner, &baseline.repository.canonical_root).await?;
    if observed.repository_fingerprint != current.repository_fingerprint {
        return Err(git_error("GIT-STATE-RACE", OPERATION, false));
    }
    let target_reference = baseline
        .repository
        .head_reference
        .clone()
        .unwrap_or_else(|| "HEAD".to_owned());
    let created_at = Utc::now().to_rfc3339();
    let identity = CheckpointIdentity {
        checkpoint_id: format!("checkpoint-{}", uuid::Uuid::new_v4()),
        commit_sha: commit_sha.clone(),
        parent_sha: baseline.repository.head_sha.clone(),
        target_reference,
        message: commit_message.to_owned(),
        author_name: author.name,
        author_email: author.email,
        created_at,
    };
    let expected_worktree = current
        .changes
        .values()
        .map(|entry| {
            (
                entry.relative_path.clone(),
                entry.material.content_hash(),
                entry.mode.clone(),
            )
        })
        .collect();
    Ok(PreparedCheckpoint {
        _temp: temp,
        context,
        baseline: baseline.clone(),
        expected_current_fingerprint: current.repository_fingerprint.clone(),
        expected_index_fingerprint: current.index_fingerprint.clone(),
        expected_worktree,
        identity,
        commit_sha,
        object_ids,
    })
}

pub(crate) async fn promote_checkpoint_objects(
    runner: &GitRunner,
    prepared: PreparedCheckpoint,
) -> Result<PromotedCheckpoint, GitReviewError> {
    let source_root = prepared
        .context
        .object_directory
        .as_deref()
        .ok_or_else(|| git_error("GIT-TEMP-OBJECTS", OPERATION, false))?;
    let mut promoted = Vec::new();
    for object_id in &prepared.object_ids {
        let (directory, file) = object_id.split_at(2);
        let source = source_root.join(directory).join(file);
        let destination_directory = prepared
            .baseline
            .repository
            .object_directory
            .join(directory);
        create_repository_object_directory(&destination_directory)?;
        let destination = destination_directory.join(file);
        if destination.exists() {
            continue;
        }
        copy_object_noclobber(&source, &destination_directory, &destination)?;
        promoted.push(object_id.clone());
    }
    for object_id in &prepared.object_ids {
        let output = runner
            .cat_object_type(&prepared.baseline.repository.canonical_root, object_id)
            .await
            .map_err(runner_error)?;
        if !output.status.success() {
            return Err(git_error("GIT-OBJECT-PROMOTION", OPERATION, false));
        }
    }
    Ok(PromotedCheckpoint {
        prepared,
        promoted_object_ids: promoted,
    })
}

pub(crate) async fn update_checkpoint_reference(
    runner: &GitRunner,
    promoted: PromotedCheckpoint,
) -> Result<CommittedCheckpoint, GitReviewError> {
    let prepared = promoted.prepared;
    let current = inspect_repository(runner, &prepared.baseline.repository.canonical_root).await?;
    if current.repository_fingerprint != prepared.expected_current_fingerprint
        || !same_repository_identity(&prepared.baseline.repository, &current.identity)
    {
        return Err(
            git_error("GIT-STATE-RACE", OPERATION, false).with_detail_ref(format!(
                "orphaned-objects:{}",
                promoted.promoted_object_ids.len()
            )),
        );
    }
    let update = runner
        .update_ref(
            &prepared.baseline.repository.canonical_root,
            &prepared.identity.target_reference,
            &prepared.commit_sha,
            &prepared.baseline.repository.head_sha,
        )
        .await
        .map_err(runner_error)?;
    if !update.status.success() {
        return Err(
            git_error("GIT-REF-CAS", OPERATION, true).with_detail_ref(format!(
                "orphaned-objects:{}",
                promoted.promoted_object_ids.len()
            )),
        );
    }

    let after = match inspect_repository(runner, &prepared.baseline.repository.canonical_root).await
    {
        Ok(snapshot) => snapshot,
        Err(error) => {
            compensate_reference(runner, &prepared).await;
            return Err(error);
        }
    };
    if !same_repository_identity(&prepared.baseline.repository, &after.identity)
        || after.identity.head_sha != prepared.commit_sha
    {
        compensate_reference(runner, &prepared).await;
        return Err(git_error("GIT-REF-VERIFY", OPERATION, true));
    }
    let index_after = after.index_fingerprint;
    if index_after != prepared.expected_index_fingerprint {
        compensate_reference(runner, &prepared).await;
        return Err(git_error("GIT-INDEX-MUTATED", OPERATION, false));
    }
    for (path, expected_hash, expected_mode) in &prepared.expected_worktree {
        let material =
            read_worktree_material(&prepared.baseline.repository.canonical_root, path).await?;
        let mode = worktree_mode(&prepared.baseline.repository.canonical_root, path).await?;
        if material.content_hash() != *expected_hash || mode != *expected_mode {
            compensate_reference(runner, &prepared).await;
            return Err(git_error("GIT-WORKTREE-MUTATED", OPERATION, false));
        }
    }
    Ok(CommittedCheckpoint {
        identity: prepared.identity,
        object_ids: prepared.object_ids,
        index_fingerprint_before: prepared.expected_index_fingerprint,
        index_fingerprint_after: index_after,
    })
}

async fn compensate_reference(runner: &GitRunner, prepared: &PreparedCheckpoint) {
    let _ = runner
        .update_ref(
            &prepared.baseline.repository.canonical_root,
            &prepared.identity.target_reference,
            &prepared.baseline.repository.head_sha,
            &prepared.commit_sha,
        )
        .await;
}

async fn read_author(runner: &GitRunner, root: &Path) -> Result<GitAuthor, GitReviewError> {
    let _ = runner;
    let layout = super::git_layout::GitRepositoryLayout::inspect(root)
        .map_err(|_| git_error("GIT-IDENTITY-READ", OPERATION, false))?;
    let name = read_local_config_value(&layout.canonical_common_dir, "user", "name")?
        .ok_or_else(|| git_error("GIT-IDENTITY-MISSING", OPERATION, false))?;
    let email = read_local_config_value(&layout.canonical_common_dir, "user", "email")?
        .ok_or_else(|| git_error("GIT-IDENTITY-MISSING", OPERATION, false))?;
    if name.is_empty()
        || name.chars().count() > 200
        || name.chars().any(char::is_control)
        || email.is_empty()
        || email.len() > 320
        || !email.contains('@')
        || email
            .chars()
            .any(|character| character.is_control() || character.is_whitespace())
    {
        return Err(git_error("GIT-IDENTITY-INVALID", OPERATION, false));
    }
    Ok(GitAuthor { name, email })
}

pub(crate) fn validate_commit_message(value: &str) -> Result<(), GitReviewError> {
    if value.is_empty()
        || value.len() > 8 * 1024
        || !value.is_ascii()
        || value.contains('\0')
        || value.lines().any(|line| line.len() > 200)
    {
        return Err(git_error("GIT-COMMIT-MESSAGE", OPERATION, false));
    }
    let mut lines = value.lines();
    let summary = lines.next().unwrap_or_default();
    let (prefix, description) = summary
        .split_once(": ")
        .ok_or_else(|| git_error("GIT-COMMIT-MESSAGE", OPERATION, false))?;
    let type_name = prefix.split(['(', '!']).next().unwrap_or_default();
    if !matches!(
        type_name,
        "feat"
            | "fix"
            | "docs"
            | "refactor"
            | "test"
            | "chore"
            | "perf"
            | "build"
            | "ci"
            | "style"
            | "revert"
    ) || description.trim().is_empty()
        || summary.len() > 100
        || lines.next() != Some("")
    {
        return Err(git_error("GIT-COMMIT-MESSAGE", OPERATION, false));
    }
    let body = lines.collect::<Vec<_>>();
    if body.is_empty()
        || body
            .iter()
            .any(|line| !line.starts_with("- ") || line.trim().len() <= 2)
    {
        return Err(git_error("GIT-COMMIT-MESSAGE", OPERATION, false));
    }
    Ok(())
}

fn enumerate_loose_objects(root: &Path, hash_length: usize) -> Result<Vec<String>, GitReviewError> {
    let suffix_length = hash_length.saturating_sub(2);
    if !matches!(hash_length, 40 | 64) {
        return Err(git_error("GIT-OBJECT-FORMAT", OPERATION, false));
    }
    let mut object_ids = Vec::new();
    for directory in
        fs::read_dir(root).map_err(|_| git_error("GIT-TEMP-OBJECTS", OPERATION, true))?
    {
        let directory = directory.map_err(|_| git_error("GIT-TEMP-OBJECTS", OPERATION, true))?;
        let name = directory.file_name().to_string_lossy().into_owned();
        if matches!(name.as_str(), "info" | "pack") {
            continue;
        }
        if name.len() != 2 || !name.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(git_error("GIT-TEMP-OBJECT-NAME", OPERATION, false));
        }
        let metadata = directory
            .metadata()
            .map_err(|_| git_error("GIT-TEMP-OBJECTS", OPERATION, true))?;
        if !metadata.is_dir() {
            return Err(git_error("GIT-TEMP-OBJECT-NAME", OPERATION, false));
        }
        for file in fs::read_dir(directory.path())
            .map_err(|_| git_error("GIT-TEMP-OBJECTS", OPERATION, true))?
        {
            let file = file.map_err(|_| git_error("GIT-TEMP-OBJECTS", OPERATION, true))?;
            let suffix = file.file_name().to_string_lossy().into_owned();
            if suffix.len() != suffix_length
                || !suffix.bytes().all(|byte| byte.is_ascii_hexdigit())
                || !file
                    .metadata()
                    .is_ok_and(|metadata| metadata.is_file() && metadata.len() <= 52 * 1024 * 1024)
            {
                return Err(git_error("GIT-TEMP-OBJECT-NAME", OPERATION, false));
            }
            object_ids.push(format!("{name}{suffix}"));
        }
    }
    object_ids.sort();
    object_ids.dedup();
    Ok(object_ids)
}

fn create_private_directory(parent: &Path, name: &str) -> Result<PathBuf, GitReviewError> {
    let path = parent.join(name);
    fs::create_dir(&path).map_err(|_| git_error("GIT-TEMP-CREATE", OPERATION, true))?;
    fs::set_permissions(&path, fs::Permissions::from_mode(0o700))
        .map_err(|_| git_error("GIT-TEMP-PERMISSION", OPERATION, false))?;
    Ok(path)
}

fn create_repository_object_directory(path: &Path) -> Result<(), GitReviewError> {
    match fs::create_dir(path) {
        Ok(()) => fs::set_permissions(path, fs::Permissions::from_mode(0o755))
            .map_err(|_| git_error("GIT-OBJECT-DIRECTORY", OPERATION, false)),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let metadata = fs::symlink_metadata(path)
                .map_err(|_| git_error("GIT-OBJECT-DIRECTORY", OPERATION, false))?;
            if metadata.is_dir() && !metadata.file_type().is_symlink() {
                Ok(())
            } else {
                Err(git_error("GIT-OBJECT-DIRECTORY", OPERATION, false))
            }
        }
        Err(_) => Err(git_error("GIT-OBJECT-DIRECTORY", OPERATION, true)),
    }
}

fn copy_object_noclobber(
    source: &Path,
    destination_directory: &Path,
    destination: &Path,
) -> Result<(), GitReviewError> {
    let bytes = fs::read(source).map_err(|_| git_error("GIT-OBJECT-READ", OPERATION, true))?;
    let temporary = destination_directory.join(format!(".coding-wife-{}", uuid::Uuid::new_v4()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|_| git_error("GIT-OBJECT-WRITE", OPERATION, true))?;
    let result = (|| {
        file.write_all(&bytes)
            .map_err(|_| git_error("GIT-OBJECT-WRITE", OPERATION, true))?;
        file.sync_all()
            .map_err(|_| git_error("GIT-OBJECT-SYNC", OPERATION, true))?;
        fs::set_permissions(&temporary, fs::Permissions::from_mode(0o444))
            .map_err(|_| git_error("GIT-OBJECT-PERMISSION", OPERATION, false))?;
        match fs::hard_link(&temporary, destination) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
            Err(_) => Err(git_error("GIT-OBJECT-PROMOTION", OPERATION, true)),
        }
    })();
    let _ = fs::remove_file(temporary);
    result
}

fn runner_error(error: GitRunnerError) -> GitReviewError {
    match error {
        GitRunnerError::BinaryUnavailable | GitRunnerError::Spawn => {
            git_error("GIT-BINARY-UNAVAILABLE", OPERATION, true)
        }
        GitRunnerError::BinaryIdentityChanged => {
            git_error("GIT-BINARY-IDENTITY-CHANGED", OPERATION, false)
        }
        GitRunnerError::Timeout => git_error("GIT-PROCESS-TIMEOUT", OPERATION, true),
        GitRunnerError::OutputLimit => git_error("GIT-PROCESS-OUTPUT-LIMIT", OPERATION, false),
        GitRunnerError::ProcessTree => git_error("GIT-PROCESS-TREE", OPERATION, false),
        GitRunnerError::Io => git_error("GIT-PROCESS-IO", OPERATION, true),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commit_messages_require_conventional_ascii_summary_and_bullets() {
        assert!(validate_commit_message(
            "feat(git): create isolated checkpoints\n\n- preserve the user index\n- update the ref with compare and swap"
        )
        .is_ok());
        assert!(validate_commit_message("checkpoint").is_err());
        assert!(validate_commit_message("feat: 日本語\n\n- detail").is_err());
        assert!(validate_commit_message("feat: summary\n\nbody").is_err());
    }
}
