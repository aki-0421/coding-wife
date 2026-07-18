//! Read-only commit metadata, diff, gate, and redacted explanation projections.

use std::collections::BTreeMap;
use std::path::Path;

use crate::codex::redaction::redact_text;

use super::error::{git_error, GitReviewError};
use super::git_layout::is_object_id;
use super::repository::{file_id, validate_opaque_id, validate_relative_path};
use super::runner::{GitRunner, GitRunnerError};
use super::types::{
    ChangeKind, CommitChangeAggregate, CommitDiffFile, CommitEvidenceDetail, CommitEvidenceSummary,
    CommitEvidenceV1, CommitFileSummary, CommitIdentity, CommitProducer, DiffContentState,
    DiffSummary, GateKind, GateOutcome, GateResult, ObserveTerminalWorkUnitRequest, RiskLevel,
    VerificationResult, GIT_REVIEW_SCHEMA_VERSION, MAX_CHANGED_FILES, MAX_FILE_DIFF_BYTES,
};

const OPERATION: &str = "read_git_commit_evidence";
const MAX_COMMIT_MESSAGE_BYTES: usize = 64 * 1024;
const MAX_NEW_COMMITS: usize = 100;

pub(crate) fn commit_evidence_id(commit_sha: &str) -> Result<String, GitReviewError> {
    if !is_object_id(commit_sha) {
        return Err(git_error("GIT-COMMIT-ID", OPERATION, false));
    }
    Ok(format!("commit-{commit_sha}"))
}

pub(crate) fn commit_sha_from_evidence_id(value: &str) -> Result<String, GitReviewError> {
    validate_opaque_id(value, "GIT-COMMIT-EVIDENCE-ID")?;
    let commit_sha = value
        .strip_prefix("commit-")
        .ok_or_else(|| git_error("GIT-COMMIT-EVIDENCE-ID", OPERATION, false))?;
    if !is_object_id(commit_sha) {
        return Err(git_error("GIT-COMMIT-EVIDENCE-ID", OPERATION, false));
    }
    Ok(commit_sha.to_owned())
}

pub(crate) fn parse_cursor(value: Option<&str>) -> Result<usize, GitReviewError> {
    let Some(value) = value else {
        return Ok(0);
    };
    validate_opaque_id(value, "GIT-COMMIT-CURSOR")?;
    value
        .strip_prefix("offset-")
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| *value <= 100_000)
        .ok_or_else(|| git_error("GIT-COMMIT-CURSOR", OPERATION, false))
}

pub(crate) async fn list_commit_identities(
    runner: &GitRunner,
    root: &Path,
    skip: usize,
    limit: usize,
) -> Result<Vec<CommitIdentity>, GitReviewError> {
    let output = runner
        .log_commits(root, skip, limit)
        .await
        .map_err(runner_error)?;
    if !output.status.success() {
        return Err(git_error("GIT-COMMIT-LIST", OPERATION, true));
    }
    parse_commit_records(&output.stdout, root)
}

pub(crate) async fn read_commit_identity(
    runner: &GitRunner,
    root: &Path,
    commit_sha: &str,
) -> Result<CommitIdentity, GitReviewError> {
    if !is_object_id(commit_sha) {
        return Err(git_error("GIT-COMMIT-ID", OPERATION, false));
    }
    let output = runner
        .show_commit(root, commit_sha)
        .await
        .map_err(runner_error)?;
    if !output.status.success() {
        return Err(git_error("GIT-COMMIT-NOT-FOUND", OPERATION, false));
    }
    let mut records = parse_commit_records(&output.stdout, root)?;
    if records.len() != 1 || records[0].commit_sha != commit_sha {
        return Err(git_error("GIT-COMMIT-DECODE", OPERATION, false));
    }
    Ok(records.remove(0))
}

pub(crate) async fn new_commit_shas(
    runner: &GitRunner,
    root: &Path,
    before: &str,
    after: &str,
) -> Result<Vec<String>, GitReviewError> {
    if before == after {
        return Ok(Vec::new());
    }
    if !is_object_id(before) || !is_object_id(after) {
        return Err(git_error("GIT-HEAD-ID", OPERATION, false));
    }
    let ancestor = runner
        .is_ancestor(root, before, after)
        .await
        .map_err(runner_error)?;
    if !ancestor.status.success() {
        return Err(git_error("GIT-HEAD-DIVERGED", OPERATION, false));
    }
    let output = runner
        .rev_list_range(root, before, after, MAX_NEW_COMMITS + 1)
        .await
        .map_err(runner_error)?;
    if !output.status.success() {
        return Err(git_error("GIT-COMMIT-RANGE", OPERATION, true));
    }
    let text = std::str::from_utf8(&output.stdout)
        .map_err(|_| git_error("GIT-COMMIT-RANGE-ENCODING", OPERATION, false))?;
    let commits = text
        .lines()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| {
            if is_object_id(value) {
                Ok(value.to_owned())
            } else {
                Err(git_error("GIT-COMMIT-RANGE-DECODE", OPERATION, false))
            }
        })
        .collect::<Result<Vec<_>, _>>()?;
    if commits.len() > MAX_NEW_COMMITS {
        return Err(git_error("GIT-COMMIT-RANGE-LIMIT", OPERATION, false));
    }
    Ok(commits)
}

pub(crate) async fn build_commit_evidence(
    runner: &GitRunner,
    root: &Path,
    workspace_id: &str,
    identity: CommitIdentity,
    correlation: Option<(&ObserveTerminalWorkUnitRequest, &str, &str, &str)>,
) -> Result<CommitEvidenceDetail, GitReviewError> {
    let files = commit_files(runner, root, &identity).await?;
    let diff_summary = summarize_files(&files);
    let (
        producer,
        work_unit_id,
        objective,
        acceptance,
        before_observation_id,
        after_observation_id,
        source_event_id,
        gates,
        verification,
        decisions,
        failed_attempts,
        risks,
        commit_skill_injection,
    ) = if let Some((request, before_id, after_id, _)) = correlation {
        (
            CommitProducer::MainCodex,
            Some(request.work_unit_id.clone()),
            Some(sanitize_text(&request.objective, root, 8 * 1024)),
            request
                .acceptance
                .iter()
                .map(|value| sanitize_text(value, root, 4 * 1024))
                .collect(),
            Some(before_id.to_owned()),
            Some(after_id.to_owned()),
            Some(request.source_event_id.clone()),
            evaluate_gates(request, &files),
            sanitize_verification(request.verification.clone(), root),
            sanitize_decisions(request.decisions.clone(), root),
            sanitize_failed_attempts(request.failed_attempts.clone(), root),
            sanitize_risks(request.risks.clone(), root),
            Some(request.commit_skill_injection.clone()),
        )
    } else {
        (
            CommitProducer::ExternalUncorrelated,
            None,
            None,
            Vec::new(),
            None,
            None,
            None,
            unknown_gates(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            None,
        )
    };
    Ok(CommitEvidenceDetail {
        schema_version: GIT_REVIEW_SCHEMA_VERSION,
        commit_evidence_id: commit_evidence_id(&identity.commit_sha)?,
        workspace_id: workspace_id.to_owned(),
        producer,
        observed_at: correlation
            .map(|(_, _, _, observed_at)| observed_at.to_owned())
            .unwrap_or_else(|| chrono::Utc::now().to_rfc3339()),
        identity,
        work_unit_id,
        objective,
        acceptance,
        before_observation_id,
        after_observation_id,
        source_event_id,
        gates,
        files,
        diff_summary,
        verification,
        decisions,
        failed_attempts,
        risks,
        commit_skill_injection,
        history_sequence: None,
    })
}

pub(crate) fn summarize(detail: &CommitEvidenceDetail) -> CommitEvidenceSummary {
    CommitEvidenceSummary {
        commit_evidence_id: detail.commit_evidence_id.clone(),
        commit_sha: detail.identity.commit_sha.clone(),
        subject: detail.identity.subject.clone(),
        author_name: detail.identity.author_name.clone(),
        authored_at: detail.identity.authored_at.clone(),
        parent_count: detail.identity.parents.len() as u64,
        producer: detail.producer,
        work_unit_id: detail.work_unit_id.clone(),
        verification_outcome: gate_outcome(detail, GateKind::Verification),
        risk_outcome: gate_outcome(detail, GateKind::Risk),
        diff_summary: detail.diff_summary.clone(),
        history_sequence: detail.history_sequence,
    }
}

pub(crate) async fn read_commit_diff(
    runner: &GitRunner,
    root: &Path,
    detail: &CommitEvidenceDetail,
    file_evidence_id: &str,
) -> Result<CommitDiffFile, GitReviewError> {
    validate_opaque_id(file_evidence_id, "GIT-FILE-EVIDENCE-ID")?;
    let file = detail
        .files
        .iter()
        .find(|file| file.file_evidence_id == file_evidence_id)
        .ok_or_else(|| git_error("GIT-FILE-EVIDENCE-NOT-FOUND", OPERATION, false))?;
    validate_relative_path(&file.relative_path)?;
    if file.binary {
        return Ok(diff_without_content(
            detail,
            file,
            DiffContentState::Binary,
            0,
        ));
    }
    let output = if let Some(parent) = detail.identity.parents.first() {
        runner
            .diff_file(
                root,
                parent,
                &detail.identity.commit_sha,
                &file.relative_path,
                MAX_FILE_DIFF_BYTES + 1,
            )
            .await
    } else {
        runner
            .root_diff_file(
                root,
                &detail.identity.commit_sha,
                &file.relative_path,
                MAX_FILE_DIFF_BYTES + 1,
            )
            .await
    };
    let output = match output {
        Ok(output) => output,
        Err(GitRunnerError::OutputLimit) => {
            return Ok(diff_without_content(
                detail,
                file,
                DiffContentState::Oversize,
                (MAX_FILE_DIFF_BYTES + 1) as u64,
            ))
        }
        Err(error) => return Err(runner_error(error)),
    };
    if !output.status.success() {
        return Err(git_error("GIT-FILE-DIFF", OPERATION, true));
    }
    let byte_count = output.stdout.len() as u64;
    let content = match String::from_utf8(output.stdout) {
        Ok(content) => sanitize_text(&content, root, MAX_FILE_DIFF_BYTES),
        Err(_) => {
            return Ok(diff_without_content(
                detail,
                file,
                DiffContentState::InvalidUtf8,
                byte_count,
            ))
        }
    };
    Ok(CommitDiffFile {
        schema_version: GIT_REVIEW_SCHEMA_VERSION,
        commit_evidence_id: detail.commit_evidence_id.clone(),
        file_evidence_id: file.file_evidence_id.clone(),
        relative_path: file.relative_path.clone(),
        change_kind: file.change_kind,
        state: DiffContentState::Text,
        content,
        byte_count,
        additions: file.additions,
        deletions: file.deletions,
    })
}

pub(crate) fn build_explanation_evidence(
    detail: &CommitEvidenceDetail,
    root: &Path,
    locale: &str,
    workspace_generation: u64,
    selection_version: u64,
) -> Result<CommitEvidenceV1, GitReviewError> {
    if !matches!(locale, "ja" | "en") {
        return Err(git_error("GIT-EXPLANATION-LOCALE", OPERATION, false));
    }
    let mut aggregates = BTreeMap::<u8, CommitChangeAggregate>::new();
    for file in &detail.files {
        let key = change_kind_key(file.change_kind);
        let aggregate = aggregates.entry(key).or_insert(CommitChangeAggregate {
            change_kind: file.change_kind,
            file_count: 0,
            additions: 0,
            deletions: 0,
            binary_files: 0,
        });
        aggregate.file_count += 1;
        aggregate.additions = aggregate.additions.saturating_add(file.additions);
        aggregate.deletions = aggregate.deletions.saturating_add(file.deletions);
        aggregate.binary_files += u64::from(file.binary);
    }
    Ok(CommitEvidenceV1 {
        schema_version: GIT_REVIEW_SCHEMA_VERSION,
        commit_id: detail.commit_evidence_id.clone(),
        subject: sanitize_text(&detail.identity.subject, root, 8 * 1024),
        body: sanitize_text(&detail.identity.body, root, 32 * 1024),
        changes: aggregates.into_values().collect(),
        diff_summary: detail.diff_summary.clone(),
        verification: sanitize_verification(detail.verification.clone(), root),
        decisions: sanitize_decisions(detail.decisions.clone(), root),
        risks: sanitize_risks(detail.risks.clone(), root),
        locale: locale.to_owned(),
        workspace_generation,
        selection_version,
    })
}

fn parse_commit_records(bytes: &[u8], root: &Path) -> Result<Vec<CommitIdentity>, GitReviewError> {
    let fields = bytes.split(|byte| *byte == 0).collect::<Vec<_>>();
    let fields = fields
        .strip_suffix(&[b"".as_slice()])
        .unwrap_or(fields.as_slice());
    if fields.is_empty() {
        return Ok(Vec::new());
    }
    if fields.len() % 7 != 0 {
        return Err(git_error("GIT-COMMIT-DECODE", OPERATION, false));
    }
    fields
        .chunks_exact(7)
        .map(|record| {
            let commit_sha = decode_field(record[0])?
                .trim_start_matches(['\r', '\n'])
                .to_owned();
            if !is_object_id(&commit_sha) {
                return Err(git_error("GIT-COMMIT-DECODE", OPERATION, false));
            }
            let parents = decode_field(record[1])?
                .split_ascii_whitespace()
                .map(|parent| {
                    if is_object_id(parent) {
                        Ok(parent.to_owned())
                    } else {
                        Err(git_error("GIT-COMMIT-DECODE", OPERATION, false))
                    }
                })
                .collect::<Result<Vec<_>, _>>()?;
            let message = decode_field(record[6])?;
            let message = sanitize_text(message, root, MAX_COMMIT_MESSAGE_BYTES);
            let mut lines = message.lines();
            let subject = lines.next().unwrap_or_default().trim().to_owned();
            let body = lines
                .collect::<Vec<_>>()
                .join("\n")
                .trim_start_matches(['\r', '\n'])
                .trim_end()
                .to_owned();
            if subject.is_empty() {
                return Err(git_error("GIT-COMMIT-MESSAGE", OPERATION, false));
            }
            Ok(CommitIdentity {
                commit_sha,
                subject,
                body,
                author_name: sanitize_text(decode_field(record[2])?, root, 512),
                author_email: sanitize_text(decode_field(record[3])?, root, 1024),
                authored_at: decode_field(record[4])?.to_owned(),
                committed_at: decode_field(record[5])?.to_owned(),
                parents,
            })
        })
        .collect()
}

async fn commit_files(
    runner: &GitRunner,
    root: &Path,
    identity: &CommitIdentity,
) -> Result<Vec<CommitFileSummary>, GitReviewError> {
    let (status, stats) = if let Some(parent) = identity.parents.first() {
        (
            runner
                .diff_name_status(root, parent, &identity.commit_sha)
                .await,
            runner
                .diff_numstat(root, parent, &identity.commit_sha)
                .await,
        )
    } else {
        (
            runner
                .root_diff_name_status(root, &identity.commit_sha)
                .await,
            runner.root_diff_numstat(root, &identity.commit_sha).await,
        )
    };
    let status = status.map_err(runner_error)?;
    let stats = stats.map_err(runner_error)?;
    if !status.status.success() || !stats.status.success() {
        return Err(git_error("GIT-COMMIT-DIFF", OPERATION, true));
    }
    let changes = parse_name_status(&status.stdout)?;
    let stats = parse_numstat(&stats.stdout)?;
    if changes.len() > MAX_CHANGED_FILES {
        return Err(git_error("GIT-LIMIT-FILES", OPERATION, false));
    }
    Ok(changes
        .into_iter()
        .map(|(relative_path, change_kind)| {
            let (additions, deletions, binary) =
                stats.get(&relative_path).copied().unwrap_or((0, 0, false));
            CommitFileSummary {
                file_evidence_id: file_id(&relative_path),
                relative_path,
                change_kind,
                additions,
                deletions,
                binary,
            }
        })
        .collect())
}

fn parse_name_status(bytes: &[u8]) -> Result<Vec<(String, ChangeKind)>, GitReviewError> {
    let fields = bytes
        .split(|byte| *byte == 0)
        .filter(|field| !field.is_empty())
        .collect::<Vec<_>>();
    if fields.len() % 2 != 0 {
        return Err(git_error("GIT-DIFF-DECODE", OPERATION, false));
    }
    fields
        .chunks_exact(2)
        .map(|record| {
            let change_kind = match record[0] {
                b"A" => ChangeKind::Added,
                b"M" => ChangeKind::Modified,
                b"D" => ChangeKind::Deleted,
                b"T" => ChangeKind::TypeChanged,
                _ => return Err(git_error("GIT-DIFF-DECODE", OPERATION, false)),
            };
            let path = decode_field(record[1])?.to_owned();
            validate_relative_path(&path)?;
            Ok((path, change_kind))
        })
        .collect()
}

fn parse_numstat(bytes: &[u8]) -> Result<BTreeMap<String, (u64, u64, bool)>, GitReviewError> {
    let mut stats = BTreeMap::new();
    for record in bytes.split(|byte| *byte == 0) {
        if record.is_empty() {
            continue;
        }
        let record = decode_field(record)?;
        let mut fields = record.splitn(3, '\t');
        let additions = fields.next().unwrap_or_default();
        let deletions = fields.next().unwrap_or_default();
        let path = fields.next().unwrap_or_default();
        validate_relative_path(path)?;
        let binary = additions == "-" || deletions == "-";
        let additions = if binary {
            0
        } else {
            additions
                .parse()
                .map_err(|_| git_error("GIT-DIFF-DECODE", OPERATION, false))?
        };
        let deletions = if binary {
            0
        } else {
            deletions
                .parse()
                .map_err(|_| git_error("GIT-DIFF-DECODE", OPERATION, false))?
        };
        stats.insert(path.to_owned(), (additions, deletions, binary));
    }
    Ok(stats)
}

fn summarize_files(files: &[CommitFileSummary]) -> DiffSummary {
    DiffSummary {
        files_changed: files.len() as u64,
        additions: files.iter().map(|file| file.additions).sum(),
        deletions: files.iter().map(|file| file.deletions).sum(),
        binary_files: files.iter().filter(|file| file.binary).count() as u64,
    }
}

fn evaluate_gates(
    request: &ObserveTerminalWorkUnitRequest,
    files: &[CommitFileSummary],
) -> Vec<GateResult> {
    let scope = if request.objective.trim().is_empty() || request.acceptance.is_empty() {
        gate(
            GateKind::Scope,
            GateOutcome::Unknown,
            "GIT-SCOPE-EVIDENCE-MISSING",
            &[],
        )
    } else {
        gate(
            GateKind::Scope,
            GateOutcome::Pass,
            "GIT-SCOPE-CORRELATED",
            &[],
        )
    };
    let ownership = if files.is_empty() {
        gate(
            GateKind::Ownership,
            GateOutcome::Unknown,
            "GIT-OWNERSHIP-NO-FILES",
            &[],
        )
    } else {
        gate(
            GateKind::Ownership,
            GateOutcome::Pass,
            "GIT-OWNERSHIP-REPORTED-BY-MAIN",
            &[],
        )
    };
    let verification_ids = request
        .verification
        .iter()
        .map(|item| item.evidence_id.clone())
        .collect::<Vec<_>>();
    let verification = if request.verification.is_empty() {
        gate(
            GateKind::Verification,
            GateOutcome::Unknown,
            "GIT-VERIFICATION-MISSING",
            &verification_ids,
        )
    } else if request
        .verification
        .iter()
        .any(|item| item.result == VerificationResult::Failed)
    {
        gate(
            GateKind::Verification,
            GateOutcome::Fail,
            "GIT-VERIFICATION-FAILED",
            &verification_ids,
        )
    } else if request
        .verification
        .iter()
        .all(|item| item.result == VerificationResult::Passed)
    {
        gate(
            GateKind::Verification,
            GateOutcome::Pass,
            "GIT-VERIFICATION-PASSED",
            &verification_ids,
        )
    } else {
        gate(
            GateKind::Verification,
            GateOutcome::Unknown,
            "GIT-VERIFICATION-INCONCLUSIVE",
            &verification_ids,
        )
    };
    let risk_ids = request
        .risks
        .iter()
        .map(|item| item.risk_id.clone())
        .collect::<Vec<_>>();
    let risk =
        if request.risks.is_empty() {
            gate(
                GateKind::Risk,
                GateOutcome::Unknown,
                "GIT-RISK-EVIDENCE-MISSING",
                &risk_ids,
            )
        } else if request.risks.iter().any(|risk| {
            !risk.resolved && matches!(risk.level, RiskLevel::High | RiskLevel::Critical)
        }) {
            gate(
                GateKind::Risk,
                GateOutcome::NeedsReview,
                "GIT-RISK-REVIEW-REQUIRED",
                &risk_ids,
            )
        } else if request.risks.iter().any(|risk| !risk.resolved) {
            gate(
                GateKind::Risk,
                GateOutcome::NeedsReview,
                "GIT-RISK-UNRESOLVED",
                &risk_ids,
            )
        } else {
            gate(
                GateKind::Risk,
                GateOutcome::Pass,
                "GIT-RISK-RESOLVED",
                &risk_ids,
            )
        };
    vec![scope, ownership, verification, risk]
}

fn unknown_gates() -> Vec<GateResult> {
    [
        GateKind::Scope,
        GateKind::Ownership,
        GateKind::Verification,
        GateKind::Risk,
    ]
    .into_iter()
    .map(|kind| gate(kind, GateOutcome::Unknown, "GIT-EVIDENCE-UNCORRELATED", &[]))
    .collect()
}

fn gate(
    gate_kind: GateKind,
    outcome: GateOutcome,
    reason: &str,
    evidence_ids: &[String],
) -> GateResult {
    GateResult {
        gate: gate_kind,
        outcome,
        reason_codes: vec![reason.to_owned()],
        evidence_ids: evidence_ids.to_vec(),
    }
}

fn gate_outcome(detail: &CommitEvidenceDetail, gate_kind: GateKind) -> GateOutcome {
    detail
        .gates
        .iter()
        .find(|gate| gate.gate == gate_kind)
        .map(|gate| gate.outcome)
        .unwrap_or(GateOutcome::Unknown)
}

fn diff_without_content(
    detail: &CommitEvidenceDetail,
    file: &CommitFileSummary,
    state: DiffContentState,
    byte_count: u64,
) -> CommitDiffFile {
    CommitDiffFile {
        schema_version: GIT_REVIEW_SCHEMA_VERSION,
        commit_evidence_id: detail.commit_evidence_id.clone(),
        file_evidence_id: file.file_evidence_id.clone(),
        relative_path: file.relative_path.clone(),
        change_kind: file.change_kind,
        state,
        content: String::new(),
        byte_count,
        additions: file.additions,
        deletions: file.deletions,
    }
}

fn decode_field(bytes: &[u8]) -> Result<&str, GitReviewError> {
    std::str::from_utf8(bytes).map_err(|_| git_error("GIT-COMMIT-ENCODING", OPERATION, false))
}

fn sanitize_text(value: &str, root: &Path, maximum: usize) -> String {
    redact_text(value, Some(root), maximum)
}

fn sanitize_verification(
    mut values: Vec<super::types::VerificationEvidence>,
    root: &Path,
) -> Vec<super::types::VerificationEvidence> {
    for value in &mut values {
        value.check = sanitize_text(&value.check, root, 1024);
        value.summary = sanitize_text(&value.summary, root, 4 * 1024);
    }
    values
}

fn sanitize_decisions(
    mut values: Vec<super::types::DecisionEvidence>,
    root: &Path,
) -> Vec<super::types::DecisionEvidence> {
    for value in &mut values {
        value.summary = sanitize_text(&value.summary, root, 4 * 1024);
        value.answer = sanitize_text(&value.answer, root, 4 * 1024);
        value.rationale = sanitize_text(&value.rationale, root, 4 * 1024);
    }
    values
}

fn sanitize_failed_attempts(
    mut values: Vec<super::types::FailedAttemptEvidence>,
    root: &Path,
) -> Vec<super::types::FailedAttemptEvidence> {
    for value in &mut values {
        value.approach = sanitize_text(&value.approach, root, 4 * 1024);
        value.outcome = sanitize_text(&value.outcome, root, 4 * 1024);
        value.learning = sanitize_text(&value.learning, root, 4 * 1024);
    }
    values
}

fn sanitize_risks(
    mut values: Vec<super::types::KnownRisk>,
    root: &Path,
) -> Vec<super::types::KnownRisk> {
    for value in &mut values {
        value.category = sanitize_text(&value.category, root, 256);
        value.summary = sanitize_text(&value.summary, root, 4 * 1024);
        value.mitigation = sanitize_text(&value.mitigation, root, 4 * 1024);
    }
    values
}

fn change_kind_key(value: ChangeKind) -> u8 {
    match value {
        ChangeKind::Added => 0,
        ChangeKind::Modified => 1,
        ChangeKind::Deleted => 2,
        ChangeKind::TypeChanged => 3,
    }
}

fn runner_error(error: GitRunnerError) -> GitReviewError {
    let (code, recoverable) = match error {
        GitRunnerError::BinaryUnavailable => ("GIT-BINARY-UNAVAILABLE", true),
        GitRunnerError::BinaryIdentityChanged => ("GIT-BINARY-IDENTITY", false),
        GitRunnerError::Spawn => ("GIT-PROCESS-SPAWN", true),
        GitRunnerError::Timeout => ("GIT-PROCESS-TIMEOUT", true),
        GitRunnerError::OutputLimit => ("GIT-PROCESS-OUTPUT-LIMIT", false),
        GitRunnerError::ProcessTree => ("GIT-PROCESS-TREE", false),
        GitRunnerError::Io => ("GIT-PROCESS-IO", true),
    };
    git_error(code, OPERATION, recoverable)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commit_records_handle_log_separator_newlines_without_paths() {
        let sha = "a".repeat(40);
        let parent = "b".repeat(40);
        let bytes = format!(
            "{sha}\0{parent}\0Sol\0sol@example.test\02026-07-18T00:00:00Z\02026-07-18T00:00:00Z\0feat: observe commits\n\n- explain intent\n\0\n{parent}\0\0Sol\0sol@example.test\02026-07-17T00:00:00Z\02026-07-17T00:00:00Z\0fix: previous\n\0"
        );
        let records =
            parse_commit_records(bytes.as_bytes(), Path::new("/safe/repository")).expect("records");
        assert_eq!(records.len(), 2);
        assert_eq!(records[0].subject, "feat: observe commits");
        assert_eq!(records[0].body, "- explain intent");
        assert_eq!(records[1].commit_sha, parent);
    }

    #[test]
    fn explanation_evidence_aggregates_changes_without_file_paths() {
        let sha = "a".repeat(40);
        let detail = CommitEvidenceDetail {
            schema_version: 1,
            commit_evidence_id: format!("commit-{sha}"),
            workspace_id: "workspace-one".to_owned(),
            producer: CommitProducer::MainCodex,
            identity: CommitIdentity {
                commit_sha: sha,
                subject: "feat: add observer".to_owned(),
                body: String::new(),
                author_name: "Sol".to_owned(),
                author_email: "sol@example.test".to_owned(),
                authored_at: "2026-07-18T00:00:00Z".to_owned(),
                committed_at: "2026-07-18T00:00:00Z".to_owned(),
                parents: Vec::new(),
            },
            work_unit_id: None,
            objective: None,
            acceptance: Vec::new(),
            before_observation_id: None,
            after_observation_id: None,
            source_event_id: None,
            gates: unknown_gates(),
            files: vec![CommitFileSummary {
                file_evidence_id: "file-one".to_owned(),
                relative_path: "src/private.rs".to_owned(),
                change_kind: ChangeKind::Modified,
                additions: 3,
                deletions: 1,
                binary: false,
            }],
            diff_summary: DiffSummary {
                files_changed: 1,
                additions: 3,
                deletions: 1,
                binary_files: 0,
            },
            verification: Vec::new(),
            decisions: Vec::new(),
            failed_attempts: Vec::new(),
            risks: Vec::new(),
            commit_skill_injection: None,
            observed_at: "2026-07-18T00:00:00Z".to_owned(),
            history_sequence: None,
        };
        let evidence =
            build_explanation_evidence(&detail, Path::new("/safe/repository"), "ja", 4, 2)
                .expect("evidence");
        let encoded = serde_json::to_string(&evidence).expect("encode");
        assert!(!encoded.contains("src/private.rs"));
        assert_eq!(evidence.changes[0].file_count, 1);
    }
}
