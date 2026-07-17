//! Redacted review pack and read-only diff projection.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use sha2::{Digest, Sha256};

use crate::codex::redaction::redact_text;

use super::error::{git_error, GitReviewError};
use super::ownership::OwnershipEvaluation;
use super::repository::{file_id, validate_relative_path, RepositoryIdentity};
use super::runner::{GitRunner, GitRunnerError};
use super::types::{
    ChangeKind, CheckpointIdentity, CheckpointOperationState, CompareCheckpointsView, DiffSummary,
    EvaluateCheckpointRequest, FileDiffView, GateResult, ManifestEntry, OwnershipClass, ReviewPack,
    VerificationResult, GIT_REVIEW_SCHEMA_VERSION, MAX_FILE_DIFF_BYTES,
};

const OPERATION: &str = "read_git_review_evidence";

pub(crate) async fn build_review_pack(
    runner: &GitRunner,
    repository: &RepositoryIdentity,
    request: &EvaluateCheckpointRequest,
    gates: Vec<GateResult>,
    ownership: &OwnershipEvaluation,
    checkpoint: &CheckpointIdentity,
) -> Result<ReviewPack, GitReviewError> {
    let actual_summary = commit_diff_summary(
        runner,
        &repository.canonical_root,
        &checkpoint.parent_sha,
        &checkpoint.commit_sha,
    )
    .await?;
    if actual_summary.files_changed != ownership.diff_summary.files_changed
        || actual_summary.additions != ownership.diff_summary.additions
        || actual_summary.deletions != ownership.diff_summary.deletions
        || actual_summary.binary_files != ownership.diff_summary.binary_files
    {
        return Err(git_error("GIT-REVIEW-DIFF-MISMATCH", OPERATION, false));
    }

    let mut pack = ReviewPack {
        schema_version: GIT_REVIEW_SCHEMA_VERSION,
        checkpoint: checkpoint.clone(),
        workspace_id: request.workspace_id.clone(),
        work_unit_id: request.work_unit_id.clone(),
        objective: request.objective.clone(),
        acceptance: request.acceptance.clone(),
        gates,
        manifest: ownership.manifest.clone(),
        diff_summary: DiffSummary {
            total_bytes: ownership.diff_summary.total_bytes,
            ..actual_summary
        },
        verification: request.verification.clone(),
        decisions: request.decisions.clone(),
        failed_attempts: request.failed_attempts.clone(),
        risks: request.risks.clone(),
        restore_guidance: vec![
            "Preview the affected files before creating a revert commit.".to_owned(),
            "Use a recovery/<short-sha> branch when the current worktree is not safe to mutate."
                .to_owned(),
            "The original checkpoint is never deleted or rewritten.".to_owned(),
        ],
        operation_state: CheckpointOperationState::HistoryComplete,
        pack_digest: String::new(),
        history_sequence: None,
    };
    redact_pack(&mut pack, &repository.canonical_root);
    pack.pack_digest = pack_digest(&pack)?;
    Ok(pack)
}

pub(crate) async fn read_file_diff(
    runner: &GitRunner,
    repository: &RepositoryIdentity,
    pack: &ReviewPack,
    requested_file_id: &str,
) -> Result<FileDiffView, GitReviewError> {
    let entry = pack
        .manifest
        .iter()
        .find(|entry| entry.file_id == requested_file_id)
        .ok_or_else(|| git_error("GIT-FILE-ID-NOT-FOUND", OPERATION, false))?;
    validate_relative_path(&entry.relative_path)?;
    let output = runner
        .diff_file(
            &repository.canonical_root,
            &pack.checkpoint.parent_sha,
            &pack.checkpoint.commit_sha,
            &entry.relative_path,
            MAX_FILE_DIFF_BYTES + 1,
        )
        .await
        .map_err(runner_error)?;
    if !output.status.success() {
        return Err(git_error("GIT-FILE-DIFF", OPERATION, true));
    }
    let byte_count = output.stdout.len() as u64;
    let truncated = output.stdout.len() > MAX_FILE_DIFF_BYTES;
    let bytes = &output.stdout[..output.stdout.len().min(MAX_FILE_DIFF_BYTES)];
    let content = String::from_utf8_lossy(bytes);
    let content = redact_text(
        &content,
        Some(&repository.canonical_root),
        MAX_FILE_DIFF_BYTES,
    );
    Ok(FileDiffView {
        schema_version: GIT_REVIEW_SCHEMA_VERSION,
        checkpoint_id: pack.checkpoint.checkpoint_id.clone(),
        file_id: entry.file_id.clone(),
        relative_path: entry.relative_path.clone(),
        change_kind: entry.change_kind,
        ownership: entry.ownership,
        content,
        truncated,
        byte_count,
    })
}

pub(crate) async fn compare_checkpoints(
    runner: &GitRunner,
    repository: &RepositoryIdentity,
    from: &ReviewPack,
    to: &ReviewPack,
) -> Result<CompareCheckpointsView, GitReviewError> {
    if from.workspace_id != to.workspace_id {
        return Err(git_error("GIT-COMPARE-WORKSPACE", OPERATION, false));
    }
    let stats = diff_stats(
        runner,
        &repository.canonical_root,
        &from.checkpoint.commit_sha,
        &to.checkpoint.commit_sha,
    )
    .await?;
    let status = diff_status(
        runner,
        &repository.canonical_root,
        &from.checkpoint.commit_sha,
        &to.checkpoint.commit_sha,
    )
    .await?;
    let mut files = Vec::new();
    for (path, change_kind) in status {
        let (additions, deletions, binary) = stats.get(&path).copied().unwrap_or((0, 0, false));
        files.push(ManifestEntry {
            file_id: file_id(&path),
            relative_path: path,
            change_kind,
            ownership: OwnershipClass::Owned,
            before_hash: None,
            after_hash: None,
            additions,
            deletions,
            reason_code: binary.then(|| "GIT-BINARY-DIFF".to_owned()),
        });
    }
    let summary = summary_from_stats(&stats, 0);
    Ok(CompareCheckpointsView {
        schema_version: GIT_REVIEW_SCHEMA_VERSION,
        from_commit_sha: from.checkpoint.commit_sha.clone(),
        to_commit_sha: to.checkpoint.commit_sha.clone(),
        diff_summary: summary,
        files,
        verification_changes: compare_verification(from, to),
        decision_changes: compare_ids(
            from.decisions.iter().map(|item| item.decision_id.as_str()),
            to.decisions.iter().map(|item| item.decision_id.as_str()),
        ),
        risk_changes: compare_ids(
            from.risks.iter().map(|item| item.risk_id.as_str()),
            to.risks.iter().map(|item| item.risk_id.as_str()),
        ),
    })
}

pub(crate) fn contains_redactable_secret(value: &str, root: &Path) -> bool {
    redact_text(value, Some(root), value.len().saturating_mul(2).max(256)) != value
}

async fn commit_diff_summary(
    runner: &GitRunner,
    root: &Path,
    from: &str,
    to: &str,
) -> Result<DiffSummary, GitReviewError> {
    let stats = diff_stats(runner, root, from, to).await?;
    Ok(summary_from_stats(&stats, 0))
}

async fn diff_stats(
    runner: &GitRunner,
    root: &Path,
    from: &str,
    to: &str,
) -> Result<BTreeMap<String, (u64, u64, bool)>, GitReviewError> {
    let output = runner
        .diff_numstat(root, from, to)
        .await
        .map_err(runner_error)?;
    if !output.status.success() {
        return Err(git_error("GIT-DIFF-STAT", OPERATION, true));
    }
    let mut stats = BTreeMap::new();
    for record in output.stdout.split(|byte| *byte == 0) {
        if record.is_empty() {
            continue;
        }
        let text = std::str::from_utf8(record)
            .map_err(|_| git_error("GIT-DIFF-ENCODING", OPERATION, false))?;
        let mut fields = text.splitn(3, '\t');
        let additions = fields.next().unwrap_or_default();
        let deletions = fields.next().unwrap_or_default();
        let path = fields.next().unwrap_or_default();
        validate_relative_path(path)?;
        let binary = additions == "-" || deletions == "-";
        let additions = if binary {
            0
        } else {
            additions
                .parse::<u64>()
                .map_err(|_| git_error("GIT-DIFF-DECODE", OPERATION, false))?
        };
        let deletions = if binary {
            0
        } else {
            deletions
                .parse::<u64>()
                .map_err(|_| git_error("GIT-DIFF-DECODE", OPERATION, false))?
        };
        stats.insert(path.to_owned(), (additions, deletions, binary));
    }
    Ok(stats)
}

async fn diff_status(
    runner: &GitRunner,
    root: &Path,
    from: &str,
    to: &str,
) -> Result<BTreeMap<String, ChangeKind>, GitReviewError> {
    let output = runner
        .diff_name_status(root, from, to)
        .await
        .map_err(runner_error)?;
    if !output.status.success() {
        return Err(git_error("GIT-DIFF-FILES", OPERATION, true));
    }
    let records = output
        .stdout
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
        .collect::<Vec<_>>();
    let mut status = BTreeMap::new();
    let mut index = 0;
    while index < records.len() {
        let record = records[index];
        index += 1;
        let text = std::str::from_utf8(record)
            .map_err(|_| git_error("GIT-DIFF-ENCODING", OPERATION, false))?;
        let (kind, path) = if let Some((kind, path)) = text.split_once('\t') {
            (kind, path)
        } else {
            let path_record = records
                .get(index)
                .copied()
                .ok_or_else(|| git_error("GIT-DIFF-DECODE", OPERATION, false))?;
            index += 1;
            (
                text,
                std::str::from_utf8(path_record)
                    .map_err(|_| git_error("GIT-DIFF-ENCODING", OPERATION, false))?,
            )
        };
        validate_relative_path(path)?;
        let change_kind = match kind.chars().next() {
            Some('A') => ChangeKind::Added,
            Some('D') => ChangeKind::Deleted,
            Some('M') => ChangeKind::Modified,
            Some('T') => ChangeKind::TypeChanged,
            _ => return Err(git_error("GIT-DIFF-DECODE", OPERATION, false)),
        };
        status.insert(path.to_owned(), change_kind);
    }
    Ok(status)
}

fn summary_from_stats(stats: &BTreeMap<String, (u64, u64, bool)>, total_bytes: u64) -> DiffSummary {
    DiffSummary {
        files_changed: stats.len() as u64,
        additions: stats.values().map(|value| value.0).sum(),
        deletions: stats.values().map(|value| value.1).sum(),
        binary_files: stats.values().filter(|value| value.2).count() as u64,
        total_bytes,
    }
}

fn compare_verification(from: &ReviewPack, to: &ReviewPack) -> Vec<String> {
    let left = from
        .verification
        .iter()
        .map(|item| (item.evidence_id.as_str(), item.result))
        .collect::<BTreeMap<_, _>>();
    let right = to
        .verification
        .iter()
        .map(|item| (item.evidence_id.as_str(), item.result))
        .collect::<BTreeMap<_, _>>();
    let mut keys = BTreeSet::new();
    keys.extend(left.keys().copied());
    keys.extend(right.keys().copied());
    keys.into_iter()
        .filter_map(|key| {
            let before = left.get(key).copied();
            let after = right.get(key).copied();
            (before != after).then(|| {
                format!(
                    "{key}:{}->{}",
                    verification_label(before),
                    verification_label(after)
                )
            })
        })
        .collect()
}

fn verification_label(value: Option<VerificationResult>) -> &'static str {
    match value {
        Some(VerificationResult::Passed) => "passed",
        Some(VerificationResult::Failed) => "failed",
        Some(VerificationResult::Skipped) => "skipped",
        Some(VerificationResult::Inconclusive) => "inconclusive",
        None => "missing",
    }
}

fn compare_ids<'a>(
    left: impl Iterator<Item = &'a str>,
    right: impl Iterator<Item = &'a str>,
) -> Vec<String> {
    let left = left.collect::<BTreeSet<_>>();
    let right = right.collect::<BTreeSet<_>>();
    left.difference(&right)
        .map(|value| format!("removed:{value}"))
        .chain(
            right
                .difference(&left)
                .map(|value| format!("added:{value}")),
        )
        .collect()
}

fn redact_pack(pack: &mut ReviewPack, root: &Path) {
    pack.objective = redact_text(&pack.objective, Some(root), 4_096);
    for item in &mut pack.acceptance {
        *item = redact_text(item, Some(root), 1_024);
    }
    pack.checkpoint.message = redact_text(&pack.checkpoint.message, Some(root), 8 * 1024);
    pack.checkpoint.author_name = redact_text(&pack.checkpoint.author_name, None, 256);
    pack.checkpoint.author_email = redact_text(&pack.checkpoint.author_email, None, 512);
    for entry in &mut pack.manifest {
        entry.relative_path = redact_text(&entry.relative_path, Some(root), 4_096);
    }
    for evidence in &mut pack.verification {
        evidence.check = redact_text(&evidence.check, Some(root), 512);
        evidence.summary = redact_text(&evidence.summary, Some(root), 4_096);
    }
    for decision in &mut pack.decisions {
        decision.summary = redact_text(&decision.summary, Some(root), 2_048);
        decision.answer = redact_text(&decision.answer, Some(root), 2_048);
        decision.rationale = redact_text(&decision.rationale, Some(root), 4_096);
    }
    for attempt in &mut pack.failed_attempts {
        attempt.approach = redact_text(&attempt.approach, Some(root), 2_048);
        attempt.outcome = redact_text(&attempt.outcome, Some(root), 1_024);
        attempt.learning = redact_text(&attempt.learning, Some(root), 2_048);
    }
    for risk in &mut pack.risks {
        risk.category = redact_text(&risk.category, None, 256);
        risk.summary = redact_text(&risk.summary, Some(root), 2_048);
        risk.mitigation = redact_text(&risk.mitigation, Some(root), 2_048);
    }
}

fn pack_digest(pack: &ReviewPack) -> Result<String, GitReviewError> {
    let encoded =
        serde_json::to_vec(pack).map_err(|_| git_error("GIT-REVIEW-ENCODE", OPERATION, false))?;
    Ok(format!("sha256:{}", hex::encode(Sha256::digest(encoded))))
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
        GitRunnerError::OutputLimit => git_error("GIT-DIFF-TOO-LARGE", OPERATION, false),
        GitRunnerError::ProcessTree => git_error("GIT-PROCESS-TREE", OPERATION, false),
        GitRunnerError::Io => git_error("GIT-PROCESS-IO", OPERATION, true),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_detection_runs_before_pack_persistence() {
        assert!(contains_redactable_secret(
            "Authorization: Bearer secret-value",
            Path::new("/tmp/workspace")
        ));
        assert!(!contains_redactable_secret(
            "feat(git): add checkpoint",
            Path::new("/tmp/workspace")
        ));
    }
}
