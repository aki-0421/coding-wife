use serde::{Deserialize, Serialize};

pub const GIT_REVIEW_SCHEMA_VERSION: u16 = 1;
pub const MAX_CHANGED_FILES: usize = 500;
pub const MAX_CHANGED_BYTES: u64 = 50 * 1024 * 1024;
pub const MAX_CHANGED_LINES: u64 = 50_000;
pub const MAX_FILE_DIFF_BYTES: usize = 1024 * 1024;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitSupportState {
    Ready,
    ReadOnly,
    Blocked,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ChangeKind {
    Added,
    Modified,
    Deleted,
    TypeChanged,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OwnershipClass {
    Owned,
    PreExisting,
    External,
    Overlap,
    Unowned,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GateOutcome {
    Pass,
    NeedsReview,
    Fail,
    Unknown,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GateKind {
    Scope,
    Ownership,
    Verification,
    Risk,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RiskLevel {
    Low,
    Medium,
    High,
    Critical,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum VerificationResult {
    Passed,
    Failed,
    Skipped,
    Inconclusive,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CheckpointStatus {
    Blocked,
    ReviewReady,
    Failed,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CheckpointOperationState {
    Prepared,
    ObjectsReady,
    RefUpdated,
    HistoryComplete,
    Failed,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RestoreKind {
    RevertCommit,
    RecoveryBranch,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RestorePreviewStatus {
    Ready,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ProtectedChangeSummary {
    pub file_id: String,
    pub relative_path: String,
    pub staged: bool,
    pub unstaged: bool,
    pub untracked: bool,
    pub content_hash: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct GitBaseline {
    pub schema_version: u16,
    pub baseline_id: String,
    pub workspace_id: String,
    pub support_state: GitSupportState,
    pub head_sha: String,
    pub head_reference: Option<String>,
    pub branch: String,
    pub detached: bool,
    pub index_fingerprint: String,
    pub status_fingerprint: String,
    pub repository_fingerprint: String,
    pub pre_existing: Vec<ProtectedChangeSummary>,
    pub blocked_reasons: Vec<String>,
    pub captured_at: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct InspectGitBaselineRequest {
    pub workspace_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct GitFileEvent {
    pub event_id: String,
    pub relative_path: String,
    pub operation: ChangeKind,
    pub before_hash: Option<String>,
    pub after_hash: Option<String>,
    pub observed_head_sha: String,
    pub observed_index_fingerprint: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct VerificationEvidence {
    pub evidence_id: String,
    pub check: String,
    pub result: VerificationResult,
    pub duration_ms: u64,
    pub summary: String,
    pub observed_repository_fingerprint: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DecisionEvidence {
    pub decision_id: String,
    pub summary: String,
    pub answer: String,
    pub rationale: String,
    pub reversible: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct FailedAttemptEvidence {
    pub attempt_id: String,
    pub approach: String,
    pub outcome: String,
    pub learning: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct KnownRisk {
    pub risk_id: String,
    pub category: String,
    pub level: RiskLevel,
    pub summary: String,
    pub mitigation: String,
    pub resolved: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RiskApproval {
    pub approval_id: String,
    pub approved_categories: Vec<String>,
    pub observed_repository_fingerprint: String,
    pub approved_at: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct EvaluateCheckpointRequest {
    pub schema_version: u16,
    pub client_request_id: String,
    pub workspace_id: String,
    pub baseline_id: String,
    pub work_unit_id: String,
    pub objective: String,
    pub acceptance: Vec<String>,
    pub file_events: Vec<GitFileEvent>,
    pub verification: Vec<VerificationEvidence>,
    pub decisions: Vec<DecisionEvidence>,
    pub failed_attempts: Vec<FailedAttemptEvidence>,
    pub risks: Vec<KnownRisk>,
    pub risk_approval: Option<RiskApproval>,
    pub commit_message: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct GateResult {
    pub gate: GateKind,
    pub outcome: GateOutcome,
    pub reason_codes: Vec<String>,
    pub observed_repository_fingerprint: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ManifestEntry {
    pub file_id: String,
    pub relative_path: String,
    pub change_kind: ChangeKind,
    pub ownership: OwnershipClass,
    pub before_hash: Option<String>,
    pub after_hash: Option<String>,
    pub additions: u64,
    pub deletions: u64,
    pub reason_code: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DiffSummary {
    pub files_changed: u64,
    pub additions: u64,
    pub deletions: u64,
    pub binary_files: u64,
    pub total_bytes: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CheckpointIdentity {
    pub checkpoint_id: String,
    pub commit_sha: String,
    pub parent_sha: String,
    pub target_reference: String,
    pub message: String,
    pub author_name: String,
    pub author_email: String,
    pub created_at: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ReviewPack {
    pub schema_version: u16,
    pub checkpoint: CheckpointIdentity,
    pub workspace_id: String,
    pub work_unit_id: String,
    pub objective: String,
    pub acceptance: Vec<String>,
    pub gates: Vec<GateResult>,
    pub manifest: Vec<ManifestEntry>,
    pub diff_summary: DiffSummary,
    pub verification: Vec<VerificationEvidence>,
    pub decisions: Vec<DecisionEvidence>,
    pub failed_attempts: Vec<FailedAttemptEvidence>,
    pub risks: Vec<KnownRisk>,
    pub restore_guidance: Vec<String>,
    pub operation_state: CheckpointOperationState,
    pub pack_digest: String,
    pub history_sequence: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CheckpointEvaluation {
    pub schema_version: u16,
    pub status: CheckpointStatus,
    pub gates: Vec<GateResult>,
    pub manifest: Vec<ManifestEntry>,
    pub checkpoint: Option<CheckpointIdentity>,
    pub review_pack: Option<ReviewPack>,
    pub error_code: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ListReviewPacksRequest {
    pub workspace_id: String,
    pub before_sequence: Option<u64>,
    pub limit: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ReviewPackSummary {
    pub checkpoint_id: String,
    pub commit_sha: String,
    pub work_unit_id: String,
    pub objective: String,
    pub operation_state: CheckpointOperationState,
    pub files_changed: u64,
    pub verification_failures: u64,
    pub unresolved_risks: u64,
    pub created_at: String,
    pub history_sequence: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ReviewPackPage {
    pub schema_version: u16,
    pub items: Vec<ReviewPackSummary>,
    pub next_before_sequence: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ReviewPackDetailRequest {
    pub workspace_id: String,
    pub checkpoint_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ReadFileDiffRequest {
    pub workspace_id: String,
    pub checkpoint_id: String,
    pub file_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct FileDiffView {
    pub schema_version: u16,
    pub checkpoint_id: String,
    pub file_id: String,
    pub relative_path: String,
    pub change_kind: ChangeKind,
    pub ownership: OwnershipClass,
    pub content: String,
    pub truncated: bool,
    pub byte_count: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CompareCheckpointsRequest {
    pub workspace_id: String,
    pub from_checkpoint_id: String,
    pub to_checkpoint_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CompareCheckpointsView {
    pub schema_version: u16,
    pub from_commit_sha: String,
    pub to_commit_sha: String,
    pub diff_summary: DiffSummary,
    pub files: Vec<ManifestEntry>,
    pub verification_changes: Vec<String>,
    pub decision_changes: Vec<String>,
    pub risk_changes: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PreviewRestoreRequest {
    pub workspace_id: String,
    pub checkpoint_id: String,
    pub kind: RestoreKind,
    pub recovery_branch: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RestoreImpact {
    pub target_commit_sha: String,
    pub current_head_sha: String,
    pub affected_files: Vec<String>,
    pub additions: u64,
    pub deletions: u64,
    pub creates_new_commit: bool,
    pub checks_out_branch: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RestorePreview {
    pub schema_version: u16,
    pub status: RestorePreviewStatus,
    pub kind: RestoreKind,
    pub checkpoint_id: String,
    pub impact: RestoreImpact,
    pub confirmation_token: Option<String>,
    pub expires_at: Option<String>,
    pub blocked_reasons: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ConfirmRestoreRequest {
    pub workspace_id: String,
    pub confirmation_token: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CancelRestoreRequest {
    pub workspace_id: String,
    pub confirmation_token: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RestoreResult {
    pub schema_version: u16,
    pub kind: RestoreKind,
    pub checkpoint_id: String,
    pub created_commit_sha: Option<String>,
    pub created_reference: Option<String>,
    pub history_sequence: Option<u64>,
    pub completed_at: String,
}
