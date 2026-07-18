use serde::{Deserialize, Serialize};

pub const GIT_REVIEW_SCHEMA_VERSION: u16 = 1;
pub const MAX_CHANGED_FILES: usize = 500;
pub const MAX_CHANGED_BYTES: u64 = 50 * 1024 * 1024;
pub const MAX_CHANGED_LINES: u64 = 50_000;
pub const MAX_FILE_DIFF_BYTES: usize = 1024 * 1024;
pub const MAX_EVIDENCE_ITEMS: usize = 100;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitSupportState {
    Ready,
    Blocked,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitObservationReason {
    ActiveView,
    WorkUnitStarted,
    WorkUnitTerminal,
    ManualRefresh,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkUnitTerminalState {
    Completed,
    Failed,
    Interrupted,
    Canceled,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CommitProducer {
    MainCodex,
    ExternalUncorrelated,
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
pub enum DiffContentState {
    Text,
    Binary,
    Oversize,
    InvalidUtf8,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CommitEvidenceFilter {
    All,
    ThisWorkUnit,
    NeedsAttention,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SkillPathAuthority {
    AppBundle,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SkillInjectionMode {
    SkillInput,
    DeveloperInstructions,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ProtectedChangeSummary {
    pub file_id: String,
    pub relative_path: String,
    pub change_kind: ChangeKind,
    pub staged: bool,
    pub unstaged: bool,
    pub untracked: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct GitObservation {
    pub schema_version: u16,
    pub observation_id: String,
    pub workspace_id: String,
    pub workspace_generation: u64,
    pub reason: GitObservationReason,
    pub work_unit_id: Option<String>,
    pub source_event_id: Option<String>,
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
    pub history_sequence: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ObserveGitRepositoryRequest {
    pub schema_version: u16,
    pub client_request_id: String,
    pub workspace_id: String,
    pub workspace_generation: u64,
    pub reason: GitObservationReason,
    pub work_unit_id: Option<String>,
    pub source_event_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct VerificationEvidence {
    pub evidence_id: String,
    pub source_event_id: String,
    pub check: String,
    pub result: VerificationResult,
    pub duration_ms: u64,
    pub summary: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DecisionEvidence {
    pub decision_id: String,
    pub source_event_id: String,
    pub summary: String,
    pub answer: String,
    pub rationale: String,
    pub reversible: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct FailedAttemptEvidence {
    pub attempt_id: String,
    pub source_event_id: String,
    pub approach: String,
    pub outcome: String,
    pub learning: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct KnownRisk {
    pub risk_id: String,
    pub source_event_id: String,
    pub category: String,
    pub level: RiskLevel,
    pub summary: String,
    pub mitigation: String,
    pub resolved: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct GateResult {
    pub gate: GateKind,
    pub outcome: GateOutcome,
    pub reason_codes: Vec<String>,
    pub evidence_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CommitSkillInjectionAudit {
    pub schema_version: u16,
    pub skill_id: String,
    pub skill_version: String,
    pub content_digest: String,
    pub path_authority: SkillPathAuthority,
    pub injection_mode: SkillInjectionMode,
    pub workspace_generation: u64,
    pub work_unit_id: String,
    pub client_request_id: String,
    pub injected_at: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ObserveTerminalWorkUnitRequest {
    pub schema_version: u16,
    pub client_request_id: String,
    pub workspace_id: String,
    pub workspace_generation: u64,
    pub before_observation_id: String,
    pub work_unit_id: String,
    pub source_event_id: String,
    pub terminal_state: WorkUnitTerminalState,
    pub objective: String,
    pub acceptance: Vec<String>,
    pub verification: Vec<VerificationEvidence>,
    pub decisions: Vec<DecisionEvidence>,
    pub failed_attempts: Vec<FailedAttemptEvidence>,
    pub risks: Vec<KnownRisk>,
    pub commit_skill_injection: CommitSkillInjectionAudit,
    pub reported_commit_block_reason: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DiffSummary {
    pub files_changed: u64,
    pub additions: u64,
    pub deletions: u64,
    pub binary_files: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CommitIdentity {
    pub commit_sha: String,
    pub subject: String,
    pub body: String,
    pub author_name: String,
    pub author_email: String,
    pub authored_at: String,
    pub committed_at: String,
    pub parents: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CommitFileSummary {
    pub file_evidence_id: String,
    pub relative_path: String,
    pub change_kind: ChangeKind,
    pub additions: u64,
    pub deletions: u64,
    pub binary: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CommitEvidenceDetail {
    pub schema_version: u16,
    pub commit_evidence_id: String,
    pub workspace_id: String,
    pub producer: CommitProducer,
    pub identity: CommitIdentity,
    pub work_unit_id: Option<String>,
    pub objective: Option<String>,
    pub acceptance: Vec<String>,
    pub before_observation_id: Option<String>,
    pub after_observation_id: Option<String>,
    pub source_event_id: Option<String>,
    pub gates: Vec<GateResult>,
    pub files: Vec<CommitFileSummary>,
    pub diff_summary: DiffSummary,
    pub verification: Vec<VerificationEvidence>,
    pub decisions: Vec<DecisionEvidence>,
    pub failed_attempts: Vec<FailedAttemptEvidence>,
    pub risks: Vec<KnownRisk>,
    pub commit_skill_injection: Option<CommitSkillInjectionAudit>,
    pub observed_at: String,
    pub history_sequence: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CommitEvidenceSummary {
    pub commit_evidence_id: String,
    pub commit_sha: String,
    pub subject: String,
    pub author_name: String,
    pub authored_at: String,
    pub parent_count: u64,
    pub producer: CommitProducer,
    pub work_unit_id: Option<String>,
    pub verification_outcome: GateOutcome,
    pub risk_outcome: GateOutcome,
    pub diff_summary: DiffSummary,
    pub history_sequence: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CommitEvidencePage {
    pub schema_version: u16,
    pub items: Vec<CommitEvidenceSummary>,
    pub next_cursor: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct WorkUnitGitObservation {
    pub schema_version: u16,
    pub workspace_id: String,
    pub workspace_generation: u64,
    pub work_unit_id: String,
    pub source_event_id: String,
    pub terminal_state: WorkUnitTerminalState,
    pub before_observation_id: String,
    pub after_observation_id: String,
    pub new_commit_evidence_ids: Vec<String>,
    pub commit_skill_injection: CommitSkillInjectionAudit,
    pub reported_commit_block_reason: Option<String>,
    pub observed_at: String,
    pub history_sequence: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TerminalWorkUnitObservationResult {
    pub schema_version: u16,
    pub observation: GitObservation,
    pub work_unit: WorkUnitGitObservation,
    pub new_commits: Vec<CommitEvidenceSummary>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ListCommitEvidenceRequest {
    pub schema_version: u16,
    pub workspace_id: String,
    pub workspace_generation: u64,
    pub cursor: Option<String>,
    pub limit: u32,
    pub filter: CommitEvidenceFilter,
    pub work_unit_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CommitEvidenceDetailRequest {
    pub schema_version: u16,
    pub workspace_id: String,
    pub workspace_generation: u64,
    pub commit_evidence_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ReadCommitDiffRequest {
    pub schema_version: u16,
    pub workspace_id: String,
    pub workspace_generation: u64,
    pub commit_evidence_id: String,
    pub file_evidence_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PrepareCommitExplanationEvidenceRequest {
    pub schema_version: u16,
    pub workspace_id: String,
    pub workspace_generation: u64,
    pub commit_evidence_id: String,
    pub locale: String,
    pub selection_version: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CommitDiffFile {
    pub schema_version: u16,
    pub commit_evidence_id: String,
    pub file_evidence_id: String,
    pub relative_path: String,
    pub change_kind: ChangeKind,
    pub state: DiffContentState,
    pub content: String,
    pub byte_count: u64,
    pub additions: u64,
    pub deletions: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CommitChangeAggregate {
    pub change_kind: ChangeKind,
    pub file_count: u64,
    pub additions: u64,
    pub deletions: u64,
    pub binary_files: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CommitEvidenceV1 {
    pub schema_version: u16,
    pub commit_id: String,
    pub subject: String,
    pub body: String,
    pub changes: Vec<CommitChangeAggregate>,
    pub diff_summary: DiffSummary,
    pub verification: Vec<VerificationEvidence>,
    pub decisions: Vec<DecisionEvidence>,
    pub risks: Vec<KnownRisk>,
    pub locale: String,
    pub workspace_generation: u64,
    pub selection_version: u64,
}
