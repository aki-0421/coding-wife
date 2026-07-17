//! Two-step revert and recovery-branch operations.

use std::path::Path;
use std::time::{Duration, Instant};

use chrono::{Duration as ChronoDuration, Utc};

use super::error::{git_error, GitReviewError};
use super::ownership::PrivateMaterialDirectory;
use super::repository::{
    inspect_repository, is_object_id, same_repository_identity, validate_relative_path,
    RepositoryIdentity, RepositorySnapshot,
};
use super::runner::{os_path_list, trimmed_stdout, GitExecutionContext, GitRunner, GitRunnerError};
use super::types::{
    RestoreImpact, RestoreKind, RestorePreview, RestorePreviewStatus, RestoreResult, ReviewPack,
    GIT_REVIEW_SCHEMA_VERSION, MAX_CHANGED_FILES,
};

const OPERATION_PREVIEW: &str = "preview_git_restore";
const OPERATION_CONFIRM: &str = "confirm_git_restore";
const TOKEN_TTL: Duration = Duration::from_secs(5 * 60);

#[derive(Clone, Debug)]
pub(crate) struct RestoreIntent {
    pub token: String,
    pub workspace_id: String,
    pub checkpoint_id: String,
    pub kind: RestoreKind,
    pub target_commit_sha: String,
    pub recovery_reference: Option<String>,
    pub expected_repository_fingerprint: String,
    pub expires_at: Instant,
}

pub(crate) async fn preview_restore(
    runner: &GitRunner,
    workspace_id: &str,
    repository: &RepositoryIdentity,
    pack: &ReviewPack,
    kind: RestoreKind,
    requested_branch: Option<&str>,
) -> Result<(RestorePreview, Option<RestoreIntent>), GitReviewError> {
    let current = inspect_repository(runner, &repository.canonical_root).await?;
    if !same_repository_identity(repository, &current.identity) {
        return Err(git_error(
            "GIT-RESTORE-REPOSITORY-IDENTITY",
            OPERATION_PREVIEW,
            false,
        ));
    }
    validate_commit(
        runner,
        &repository.canonical_root,
        &pack.checkpoint.commit_sha,
    )
    .await?;
    let target_parent_sha = single_parent(
        runner,
        &repository.canonical_root,
        &pack.checkpoint.commit_sha,
    )
    .await?;
    if target_parent_sha != pack.checkpoint.parent_sha {
        return Err(git_error(
            "GIT-RESTORE-PARENT-MISMATCH",
            OPERATION_PREVIEW,
            false,
        ));
    }

    let (affected_files, additions, deletions) = impact(
        runner,
        &repository.canonical_root,
        &pack.checkpoint.commit_sha,
        &target_parent_sha,
    )
    .await?;
    let mut blocked_reasons = current.blocked_reasons.clone();
    let recovery_reference = match kind {
        RestoreKind::RevertCommit => {
            if !current.changes.is_empty() {
                blocked_reasons.push("GIT-RESTORE-DIRTY".to_owned());
            }
            let ancestor = runner
                .is_ancestor(
                    &repository.canonical_root,
                    &pack.checkpoint.commit_sha,
                    &current.identity.head_sha,
                )
                .await
                .map_err(runner_preview_error)?;
            if !ancestor.status.success() {
                blocked_reasons.push("GIT-RESTORE-TARGET-NOT-ANCESTOR".to_owned());
            }
            if !predict_revert_tree(
                runner,
                &current,
                &pack.checkpoint.commit_sha,
                &target_parent_sha,
            )
            .await?
            {
                blocked_reasons.push("GIT-RESTORE-CONFLICT".to_owned());
            }
            None
        }
        RestoreKind::RecoveryBranch => {
            let branch = requested_branch.map(str::to_owned).unwrap_or_else(|| {
                format!(
                    "recovery/{}",
                    pack.checkpoint
                        .commit_sha
                        .chars()
                        .take(12)
                        .collect::<String>()
                )
            });
            if branch.len() > 240 || branch.starts_with('-') {
                blocked_reasons.push("GIT-RECOVERY-BRANCH-INVALID".to_owned());
            } else {
                let format = runner
                    .check_ref_format_branch(&repository.canonical_root, &branch)
                    .await
                    .map_err(runner_preview_error)?;
                if !format.status.success() {
                    blocked_reasons.push("GIT-RECOVERY-BRANCH-INVALID".to_owned());
                }
            }
            let reference = format!("refs/heads/{branch}");
            let exists = runner
                .ref_exists(&repository.canonical_root, &reference)
                .await
                .map_err(runner_preview_error)?;
            match exists.status.code() {
                Some(0) => blocked_reasons.push("GIT-RECOVERY-BRANCH-EXISTS".to_owned()),
                Some(1) => {}
                _ => blocked_reasons.push("GIT-RECOVERY-BRANCH-READ".to_owned()),
            }
            Some(reference)
        }
    };
    blocked_reasons.sort();
    blocked_reasons.dedup();

    let impact = RestoreImpact {
        target_commit_sha: pack.checkpoint.commit_sha.clone(),
        current_head_sha: current.identity.head_sha.clone(),
        affected_files,
        additions,
        deletions,
        creates_new_commit: kind == RestoreKind::RevertCommit,
        checks_out_branch: false,
    };
    if !blocked_reasons.is_empty() {
        return Ok((
            RestorePreview {
                schema_version: GIT_REVIEW_SCHEMA_VERSION,
                status: RestorePreviewStatus::Blocked,
                kind,
                checkpoint_id: pack.checkpoint.checkpoint_id.clone(),
                impact,
                confirmation_token: None,
                expires_at: None,
                blocked_reasons,
            },
            None,
        ));
    }

    let token = format!("restore-{}", uuid::Uuid::new_v4());
    let expires_at = Utc::now() + ChronoDuration::seconds(TOKEN_TTL.as_secs() as i64);
    let intent = RestoreIntent {
        token: token.clone(),
        workspace_id: workspace_id.to_owned(),
        checkpoint_id: pack.checkpoint.checkpoint_id.clone(),
        kind,
        target_commit_sha: pack.checkpoint.commit_sha.clone(),
        recovery_reference,
        expected_repository_fingerprint: current.repository_fingerprint,
        expires_at: Instant::now() + TOKEN_TTL,
    };
    Ok((
        RestorePreview {
            schema_version: GIT_REVIEW_SCHEMA_VERSION,
            status: RestorePreviewStatus::Ready,
            kind,
            checkpoint_id: pack.checkpoint.checkpoint_id.clone(),
            impact,
            confirmation_token: Some(token),
            expires_at: Some(expires_at.to_rfc3339()),
            blocked_reasons: Vec::new(),
        },
        Some(intent),
    ))
}

pub(crate) async fn confirm_restore(
    runner: &GitRunner,
    repository: &RepositoryIdentity,
    intent: RestoreIntent,
) -> Result<RestoreResult, GitReviewError> {
    if Instant::now() > intent.expires_at {
        return Err(git_error(
            "GIT-RESTORE-TOKEN-EXPIRED",
            OPERATION_CONFIRM,
            false,
        ));
    }
    let current = inspect_repository(runner, &repository.canonical_root).await?;
    if !same_repository_identity(repository, &current.identity)
        || current.repository_fingerprint != intent.expected_repository_fingerprint
    {
        return Err(git_error("GIT-RESTORE-STALE", OPERATION_CONFIRM, false));
    }
    match intent.kind {
        RestoreKind::RecoveryBranch => {
            let reference = intent.recovery_reference.clone().ok_or_else(|| {
                git_error("GIT-RECOVERY-BRANCH-INVALID", OPERATION_CONFIRM, false)
            })?;
            let zero = "0".repeat(intent.target_commit_sha.len());
            let output = runner
                .update_ref(
                    &repository.canonical_root,
                    &reference,
                    &intent.target_commit_sha,
                    &zero,
                )
                .await
                .map_err(runner_confirm_error)?;
            if !output.status.success() {
                return Err(git_error(
                    "GIT-RECOVERY-BRANCH-CAS",
                    OPERATION_CONFIRM,
                    true,
                ));
            }
            let after = inspect_repository(runner, &repository.canonical_root).await?;
            if after.repository_fingerprint != current.repository_fingerprint {
                let _ = runner
                    .update_ref(
                        &repository.canonical_root,
                        &reference,
                        &zero,
                        &intent.target_commit_sha,
                    )
                    .await;
                return Err(git_error(
                    "GIT-RECOVERY-BRANCH-MUTATED-HEAD",
                    OPERATION_CONFIRM,
                    false,
                ));
            }
            Ok(RestoreResult {
                schema_version: GIT_REVIEW_SCHEMA_VERSION,
                kind: intent.kind,
                checkpoint_id: intent.checkpoint_id,
                created_commit_sha: None,
                created_reference: Some(reference),
                history_sequence: None,
                completed_at: Utc::now().to_rfc3339(),
            })
        }
        RestoreKind::RevertCommit => {
            if !current.changes.is_empty() {
                return Err(git_error("GIT-RESTORE-DIRTY", OPERATION_CONFIRM, false));
            }
            let output = runner
                .revert_commit(&repository.canonical_root, &intent.target_commit_sha)
                .await
                .map_err(runner_confirm_error)?;
            if !output.status.success() {
                let _ = runner.abort_revert(&repository.canonical_root).await;
                return Err(git_error("GIT-REVERT-FAILED", OPERATION_CONFIRM, true));
            }
            let after = inspect_repository(runner, &repository.canonical_root).await?;
            if !same_repository_identity(repository, &after.identity)
                || !after.changes.is_empty()
                || after.identity.head_sha == current.identity.head_sha
            {
                return Err(git_error("GIT-REVERT-VERIFY", OPERATION_CONFIRM, false));
            }
            Ok(RestoreResult {
                schema_version: GIT_REVIEW_SCHEMA_VERSION,
                kind: intent.kind,
                checkpoint_id: intent.checkpoint_id,
                created_commit_sha: Some(after.identity.head_sha),
                created_reference: after.identity.head_reference,
                history_sequence: None,
                completed_at: Utc::now().to_rfc3339(),
            })
        }
    }
}

async fn validate_commit(
    runner: &GitRunner,
    root: &Path,
    commit: &str,
) -> Result<(), GitReviewError> {
    if !is_object_id(commit) {
        return Err(git_error("GIT-RESTORE-SHA", OPERATION_PREVIEW, false));
    }
    let object_type = runner
        .cat_object_type(root, commit)
        .await
        .map_err(runner_preview_error)?;
    if !object_type.status.success()
        || trimmed_stdout(&object_type).map_err(runner_preview_error)? != "commit"
    {
        return Err(git_error(
            "GIT-RESTORE-COMMIT-NOT-FOUND",
            OPERATION_PREVIEW,
            false,
        ));
    }
    Ok(())
}

async fn single_parent(
    runner: &GitRunner,
    root: &Path,
    commit: &str,
) -> Result<String, GitReviewError> {
    let output = runner
        .rev_list_parent(root, commit)
        .await
        .map_err(runner_preview_error)?;
    if !output.status.success() {
        return Err(git_error("GIT-RESTORE-PARENT", OPERATION_PREVIEW, true));
    }
    let value = trimmed_stdout(&output).map_err(runner_preview_error)?;
    let fields = value.split_ascii_whitespace().collect::<Vec<_>>();
    if fields.len() != 2 || fields[0] != commit || !is_object_id(fields[1]) {
        return Err(git_error(
            "GIT-RESTORE-SINGLE-PARENT-REQUIRED",
            OPERATION_PREVIEW,
            false,
        ));
    }
    Ok(fields[1].to_owned())
}

async fn impact(
    runner: &GitRunner,
    root: &Path,
    from: &str,
    to: &str,
) -> Result<(Vec<String>, u64, u64), GitReviewError> {
    let names = runner
        .diff_name_status(root, from, to)
        .await
        .map_err(runner_preview_error)?;
    let stats = runner
        .diff_numstat(root, from, to)
        .await
        .map_err(runner_preview_error)?;
    if !names.status.success() || !stats.status.success() {
        return Err(git_error("GIT-RESTORE-DIFF", OPERATION_PREVIEW, true));
    }
    let records = names
        .stdout
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
        .collect::<Vec<_>>();
    let mut affected = Vec::new();
    let mut index = 0;
    while index < records.len() {
        let status = std::str::from_utf8(records[index])
            .map_err(|_| git_error("GIT-RESTORE-DIFF-DECODE", OPERATION_PREVIEW, false))?;
        index += 1;
        let path = if let Some((_, path)) = status.split_once('\t') {
            path
        } else {
            let path = records
                .get(index)
                .ok_or_else(|| git_error("GIT-RESTORE-DIFF-DECODE", OPERATION_PREVIEW, false))?;
            index += 1;
            std::str::from_utf8(path)
                .map_err(|_| git_error("GIT-RESTORE-DIFF-DECODE", OPERATION_PREVIEW, false))?
        };
        validate_relative_path(path)?;
        affected.push(path.to_owned());
    }
    if affected.len() > MAX_CHANGED_FILES {
        return Err(git_error("GIT-LIMIT-FILES", OPERATION_PREVIEW, false));
    }
    let mut additions = 0_u64;
    let mut deletions = 0_u64;
    for record in stats.stdout.split(|byte| *byte == 0) {
        if record.is_empty() {
            continue;
        }
        let value = std::str::from_utf8(record)
            .map_err(|_| git_error("GIT-RESTORE-DIFF-DECODE", OPERATION_PREVIEW, false))?;
        let mut fields = value.splitn(3, '\t');
        let added = fields.next().unwrap_or_default();
        let deleted = fields.next().unwrap_or_default();
        let path = fields.next().unwrap_or_default();
        validate_relative_path(path)?;
        if added != "-" && deleted != "-" {
            additions = additions.saturating_add(
                added
                    .parse()
                    .map_err(|_| git_error("GIT-RESTORE-DIFF-DECODE", OPERATION_PREVIEW, false))?,
            );
            deletions = deletions.saturating_add(
                deleted
                    .parse()
                    .map_err(|_| git_error("GIT-RESTORE-DIFF-DECODE", OPERATION_PREVIEW, false))?,
            );
        }
    }
    affected.sort();
    affected.dedup();
    Ok((affected, additions, deletions))
}

async fn predict_revert_tree(
    runner: &GitRunner,
    current: &RepositorySnapshot,
    target: &str,
    target_parent: &str,
) -> Result<bool, GitReviewError> {
    let temp = PrivateMaterialDirectory::new("restore-preview")?;
    let objects = temp.create_directory("objects")?;
    std::fs::create_dir(objects.join("info"))
        .map_err(|_| git_error("GIT-TEMP-CREATE", OPERATION_PREVIEW, true))?;
    std::fs::create_dir(objects.join("pack"))
        .map_err(|_| git_error("GIT-TEMP-CREATE", OPERATION_PREVIEW, true))?;
    let context = GitExecutionContext {
        index_file: Some(temp.root().join("index")),
        object_directory: Some(objects),
        alternate_object_directories: Some(os_path_list(&[current
            .identity
            .object_directory
            .clone()])),
    };
    let merge = runner
        .read_tree_merge(
            &current.identity.canonical_root,
            target,
            &current.identity.head_sha,
            target_parent,
            &context,
        )
        .await
        .map_err(runner_preview_error)?;
    if !merge.status.success() {
        return Ok(false);
    }
    let tree = runner
        .write_tree(&current.identity.canonical_root, &context)
        .await
        .map_err(runner_preview_error)?;
    Ok(tree.status.success())
}

fn runner_preview_error(error: GitRunnerError) -> GitReviewError {
    runner_error(error, OPERATION_PREVIEW)
}

fn runner_confirm_error(error: GitRunnerError) -> GitReviewError {
    runner_error(error, OPERATION_CONFIRM)
}

fn runner_error(error: GitRunnerError, operation: &'static str) -> GitReviewError {
    let (code, recoverable) = match error {
        GitRunnerError::BinaryUnavailable | GitRunnerError::Spawn => {
            ("GIT-BINARY-UNAVAILABLE", true)
        }
        GitRunnerError::BinaryIdentityChanged => ("GIT-BINARY-IDENTITY-CHANGED", false),
        GitRunnerError::Timeout => ("GIT-PROCESS-TIMEOUT", true),
        GitRunnerError::OutputLimit => ("GIT-PROCESS-OUTPUT-LIMIT", false),
        GitRunnerError::ProcessTree => ("GIT-PROCESS-TREE", false),
        GitRunnerError::Io => ("GIT-PROCESS-IO", true),
    };
    git_error(code, operation, recoverable)
}
