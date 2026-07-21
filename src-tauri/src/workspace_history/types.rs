use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const WORKSPACE_HISTORY_SCHEMA_VERSION: u16 = 1;
pub const DOMAIN_EVENT_SCHEMA_VERSION: u16 = 1;
pub const WORKSPACE_CONTEXT_SCHEMA_VERSION: u16 = 1;
pub const WORKSPACE_RESUME_STATE_SCHEMA_VERSION: u16 = 1;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceLifecycle {
    Backlog,
    InProgress,
    InReview,
    Done,
    Canceled,
}

impl WorkspaceLifecycle {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Backlog => "backlog",
            Self::InProgress => "in_progress",
            Self::InReview => "in_review",
            Self::Done => "done",
            Self::Canceled => "canceled",
        }
    }
}

impl TryFrom<&str> for WorkspaceLifecycle {
    type Error = ();

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value {
            "backlog" => Ok(Self::Backlog),
            "in_progress" => Ok(Self::InProgress),
            "in_review" => Ok(Self::InReview),
            "done" => Ok(Self::Done),
            "canceled" => Ok(Self::Canceled),
            _ => Err(()),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceAttention {
    NeedsAnswer,
    ApprovalRequired,
    TestFailed,
    HighRisk,
}

impl WorkspaceAttention {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NeedsAnswer => "needs_answer",
            Self::ApprovalRequired => "approval_required",
            Self::TestFailed => "test_failed",
            Self::HighRisk => "high_risk",
        }
    }
}

impl TryFrom<&str> for WorkspaceAttention {
    type Error = ();

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value {
            "needs_answer" => Ok(Self::NeedsAnswer),
            "approval_required" => Ok(Self::ApprovalRequired),
            "test_failed" => Ok(Self::TestFailed),
            "high_risk" => Ok(Self::HighRisk),
            _ => Err(()),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceHealth {
    Ready,
    Missing,
    Changed,
    Unreadable,
    ReadOnly,
    StaleBranch,
}

impl WorkspaceHealth {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ready => "ready",
            Self::Missing => "missing",
            Self::Changed => "changed",
            Self::Unreadable => "unreadable",
            Self::ReadOnly => "read_only",
            Self::StaleBranch => "stale_branch",
        }
    }
}

impl TryFrom<&str> for WorkspaceHealth {
    type Error = ();

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value {
            "ready" => Ok(Self::Ready),
            "missing" => Ok(Self::Missing),
            "changed" => Ok(Self::Changed),
            "unreadable" => Ok(Self::Unreadable),
            "read_only" => Ok(Self::ReadOnly),
            "stale_branch" => Ok(Self::StaleBranch),
            _ => Err(()),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HistoryMode {
    Ready,
    ReadOnly,
    RecoveryRequired,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ReasoningEffort {
    Off,
    Minimal,
    Low,
    Medium,
    High,
    Xhigh,
    Max,
    Ultra,
}

impl ReasoningEffort {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Minimal => "minimal",
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::Xhigh => "xhigh",
            Self::Max => "max",
            Self::Ultra => "ultra",
        }
    }
}

impl TryFrom<&str> for ReasoningEffort {
    type Error = ();

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value {
            "off" => Ok(Self::Off),
            "minimal" => Ok(Self::Minimal),
            "fast" | "low" => Ok(Self::Low),
            "medium" => Ok(Self::Medium),
            "high" => Ok(Self::High),
            "xhigh" => Ok(Self::Xhigh),
            "max" => Ok(Self::Max),
            "ultra" => Ok(Self::Ultra),
            _ => Err(()),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ContextSource {
    Files,
    GitDiff,
    TerminalOutput,
}

impl ContextSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Files => "files",
            Self::GitDiff => "git_diff",
            Self::TerminalOutput => "terminal_output",
        }
    }
}

impl TryFrom<&str> for ContextSource {
    type Error = ();

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value {
            "files" => Ok(Self::Files),
            "git_diff" => Ok(Self::GitDiff),
            "terminal_output" => Ok(Self::TerminalOutput),
            _ => Err(()),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct HistoryStatus {
    pub schema_version: u16,
    pub mode: HistoryMode,
    pub error_code: Option<String>,
    pub backup_name: Option<String>,
}

impl HistoryStatus {
    pub fn ready() -> Self {
        Self {
            schema_version: WORKSPACE_HISTORY_SCHEMA_VERSION,
            mode: HistoryMode::Ready,
            error_code: None,
            backup_name: None,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct WorkspaceSummary {
    pub schema_version: u16,
    pub workspace_id: String,
    pub project_id: String,
    pub repository: String,
    pub github_repository: Option<String>,
    pub name: String,
    pub branch: String,
    pub head: String,
    pub detached: bool,
    pub lifecycle: WorkspaceLifecycle,
    pub attention: Option<WorkspaceAttention>,
    pub health: WorkspaceHealth,
    pub created_at: String,
    pub updated_at: String,
    pub last_selected_at: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ProjectSummary {
    pub schema_version: u16,
    pub project_id: String,
    pub name: String,
    pub github_repository: Option<String>,
    pub health: WorkspaceHealth,
    pub workspace_count: u64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct WorkspaceDraftView {
    pub schema_version: u16,
    pub workspace_id: String,
    pub text: String,
    pub effort: ReasoningEffort,
    pub revision: u64,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ContextSnapshotView {
    pub schema_version: u16,
    pub snapshot_id: String,
    pub workspace_id: String,
    pub source: ContextSource,
    pub label: String,
    pub captured_at: String,
    pub byte_count: u64,
    pub content_hash: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CharacterTone {
    Concise,
    Warm,
    Neutral,
}

impl CharacterTone {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Concise => "concise",
            Self::Warm => "warm",
            Self::Neutral => "neutral",
        }
    }
}

impl TryFrom<&str> for CharacterTone {
    type Error = ();

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value {
            "concise" => Ok(Self::Concise),
            "warm" => Ok(Self::Warm),
            "neutral" => Ok(Self::Neutral),
            _ => Err(()),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SpeechDensity {
    Quiet,
    KeyEvents,
    Detailed,
}

impl SpeechDensity {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Quiet => "quiet",
            Self::KeyEvents => "key_events",
            Self::Detailed => "detailed",
        }
    }
}

impl TryFrom<&str> for SpeechDensity {
    type Error = ();

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value {
            "quiet" => Ok(Self::Quiet),
            "key_events" => Ok(Self::KeyEvents),
            "detailed" => Ok(Self::Detailed),
            _ => Err(()),
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ProjectContext {
    pub goal: String,
    pub constraints: String,
    pub definition_of_done: Vec<String>,
    pub technical_references: Vec<String>,
    pub user_notes: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CharacterContext {
    pub display_name: String,
    pub tone: CharacterTone,
    pub tone_notes: String,
    pub speech_density: SpeechDensity,
    pub behavior: String,
    pub prohibited_expressions: Vec<String>,
}

impl Default for CharacterContext {
    fn default() -> Self {
        Self {
            display_name: "Sol".to_owned(),
            tone: CharacterTone::Neutral,
            tone_notes: String::new(),
            speech_density: SpeechDensity::KeyEvents,
            behavior: String::new(),
            prohibited_expressions: Vec::new(),
        }
    }
}

impl CharacterContext {
    pub fn hiyori_preset() -> Self {
        Self {
            display_name: "桃瀬ひより".to_owned(),
            tone: CharacterTone::Warm,
            tone_notes:
                "明るく親しみやすい口調で、相手を急かさず要点を簡潔に伝える。".to_owned(),
            speech_density: SpeechDensity::KeyEvents,
            behavior: "作業をそっと見守り、重要な変化や判断が必要な場面で声をかける。成功時は一緒に喜び、問題時は落ち着いて次の行動を示す。".to_owned(),
            prohibited_expressions: vec![
                "利用者を責める表現".to_owned(),
                "過度に馴れ馴れしい表現".to_owned(),
                "不確かなことを断定する表現".to_owned(),
            ],
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct VersionedProjectContext {
    pub schema_version: u16,
    pub project_id: String,
    pub version: u64,
    pub content_hash: String,
    pub updated_at: String,
    pub context: ProjectContext,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct VersionedCharacterContext {
    pub schema_version: u16,
    pub pack_id: String,
    pub version: u64,
    pub content_hash: String,
    pub updated_at: String,
    pub context: CharacterContext,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct WorkspaceEditableContext {
    pub schema_version: u16,
    pub workspace_id: String,
    pub project: VersionedProjectContext,
    pub character: VersionedCharacterContext,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct WorkspaceLoadEditableContextRequest {
    pub workspace_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ProjectGetContextRequest {
    pub project_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ProjectSaveContextRequest {
    pub project_id: String,
    pub expected_version: u64,
    pub context: ProjectContext,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct AppSaveCharacterContextRequest {
    pub pack_id: String,
    pub expected_version: u64,
    pub context: CharacterContext,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CharacterGetContextRequest {
    pub pack_id: String,
    pub display_name: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct WorkspaceTurnContextSnapshot {
    pub schema_version: u16,
    pub workspace_id: String,
    pub project_version: u64,
    pub project_hash: String,
    pub character_pack_id: String,
    pub character_version: u64,
    pub character_hash: String,
    pub snapshot_hash: String,
    pub captured_at: String,
    pub project: ProjectContext,
    pub character: CharacterContext,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TimelineEventView {
    pub schema_version: u16,
    pub event_id: String,
    pub workspace_id: String,
    pub session_id: Option<String>,
    pub sequence: u64,
    pub producer: String,
    pub kind: String,
    pub occurred_at: String,
    pub payload: Value,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TimelinePage {
    pub schema_version: u16,
    pub items: Vec<TimelineEventView>,
    pub next_before_sequence: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct WorkspaceLastSummaryView {
    pub schema_version: u16,
    pub workspace_id: String,
    pub event_id: String,
    pub sequence: u64,
    pub text: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct WorkspaceTimelineAnchorView {
    pub schema_version: u16,
    pub workspace_id: String,
    pub event_id: String,
    pub sequence: u64,
    pub offset: i64,
    pub revision: u64,
    pub updated_at: String,
    pub was_clamped: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct WorkspaceResumeStateView {
    pub schema_version: u16,
    pub workspace_id: String,
    pub last_summary: Option<WorkspaceLastSummaryView>,
    pub timeline_anchor: Option<WorkspaceTimelineAnchorView>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct WorkspaceStateSnapshot {
    pub schema_version: u16,
    pub history: HistoryStatus,
    pub projects: Vec<ProjectSummary>,
    pub workspaces: Vec<WorkspaceSummary>,
    pub active_workspace_id: Option<String>,
    pub draft: Option<WorkspaceDraftView>,
    pub context_snapshots: Vec<ContextSnapshotView>,
    pub timeline: TimelinePage,
    pub resume_state: Option<WorkspaceResumeStateView>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspacePickOutcome {
    Selected,
    Canceled,
    SetupRequired,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectSetupGitStatus {
    NotInitialized,
    Ready,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectSetupGithubOwnerStatus {
    NotChecked,
    Ready,
    CliMissing,
    AuthRequired,
    Unavailable,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ProjectSetupView {
    pub schema_version: u16,
    pub setup_id: String,
    pub folder_name: String,
    pub git_status: ProjectSetupGitStatus,
    pub github_owner_status: ProjectSetupGithubOwnerStatus,
    pub github_owners: Vec<String>,
    pub suggested_repository_name: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct WorkspacePickResponse {
    pub schema_version: u16,
    pub outcome: WorkspacePickOutcome,
    pub state: WorkspaceStateSnapshot,
    pub setup: Option<ProjectSetupView>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ProjectSetupRequest {
    pub setup_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ProjectSetupGithubRequest {
    pub setup_id: String,
    pub owner: String,
    pub repository: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct WorkspaceCreateSessionRequest {
    pub project_id: String,
    pub name: String,
    pub client_request_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ProjectSelectRequest {
    pub project_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct WorkspaceArchiveRequest {
    pub workspace_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct WorkspaceSelectRequest {
    pub workspace_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct WorkspaceRecheckRequest {
    pub workspace_id: String,
    pub accept_observed_head: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct WorkspaceUpdateLifecycleRequest {
    pub workspace_id: String,
    pub lifecycle: WorkspaceLifecycle,
    pub expected_updated_at: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct WorkspaceCancelRequest {
    pub workspace_id: String,
    pub expected_updated_at: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct WorkspaceSaveDraftRequest {
    pub workspace_id: String,
    pub text: String,
    pub effort: ReasoningEffort,
    pub expected_revision: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct WorkspaceSaveTimelineAnchorRequest {
    pub workspace_id: String,
    pub event_id: String,
    pub sequence: u64,
    pub offset: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct WorkspaceSaveContextRequest {
    pub workspace_id: String,
    pub source: ContextSource,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct WorkspaceTimelineRequest {
    pub workspace_id: String,
    pub before_sequence: Option<u64>,
    pub limit: u32,
    pub search: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct WorkspaceDeleteChallengeRequest {
    pub workspace_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct WorkspaceDeleteChallengeView {
    pub schema_version: u16,
    pub workspace_id: String,
    pub token: String,
    pub expires_at: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct WorkspaceDeleteRequest {
    pub workspace_id: String,
    pub token: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct AppendDomainEventRequest {
    pub schema_version: u16,
    pub event_id: String,
    pub workspace_id: String,
    pub session_id: Option<String>,
    pub producer: String,
    pub kind: String,
    pub occurred_at: String,
    pub payload: Value,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct AppendDomainEventResponse {
    pub schema_version: u16,
    pub sequence: u64,
    pub inserted: bool,
}

#[derive(Clone, Debug)]
pub struct NormalizedDomainEvent {
    pub schema_version: u16,
    pub event_id: String,
    pub workspace_id: String,
    pub session_id: Option<String>,
    pub producer: String,
    pub kind: String,
    pub occurred_at: String,
    pub payload: Value,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AppendEventResult {
    pub sequence: u64,
    pub inserted: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkspaceHistoryError {
    pub code: String,
    pub operation: String,
    pub recoverable: bool,
    pub detail_ref: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct WorkspaceCommandError {
    pub code: String,
    pub operation: String,
    pub recoverable: bool,
    pub user_message_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail_ref: Option<String>,
}

impl WorkspaceCommandError {
    pub fn new(code: impl Into<String>, operation: impl Into<String>, recoverable: bool) -> Self {
        Self {
            code: code.into(),
            operation: operation.into(),
            recoverable,
            user_message_key: "workspace.error.generic".to_owned(),
            detail_ref: None,
        }
    }
}

impl WorkspaceHistoryError {
    pub fn new(code: impl Into<String>, operation: impl Into<String>, recoverable: bool) -> Self {
        Self {
            code: code.into(),
            operation: operation.into(),
            recoverable,
            detail_ref: None,
        }
    }

    pub fn with_detail_ref(mut self, detail_ref: impl Into<String>) -> Self {
        self.detail_ref = Some(detail_ref.into());
        self
    }
}

impl std::fmt::Display for WorkspaceHistoryError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.code)
    }
}

impl std::error::Error for WorkspaceHistoryError {}

#[cfg(test)]
mod tests {
    use serde::Serialize;
    use serde_json::{json, Value};

    use super::*;

    const CONTRACT_FIXTURE: &str =
        include_str!("../../../src/test/fixtures/workspace-history.v1.json");

    fn fixture() -> Value {
        serde_json::from_str(CONTRACT_FIXTURE).expect("workspace contract fixture")
    }

    fn serialized(value: impl Serialize) -> Value {
        serde_json::to_value(value).expect("serialize contract")
    }

    fn summary() -> WorkspaceSummary {
        WorkspaceSummary {
            schema_version: 1,
            workspace_id: "workspace-fixture".to_owned(),
            project_id: "project-fixture".to_owned(),
            repository: "fixture-repository".to_owned(),
            github_repository: Some("fixture-owner/fixture-repository".to_owned()),
            name: "Fixture workspace".to_owned(),
            branch: "main".to_owned(),
            head: "0123456789ab".to_owned(),
            detached: false,
            lifecycle: WorkspaceLifecycle::InProgress,
            attention: Some(WorkspaceAttention::TestFailed),
            health: WorkspaceHealth::Ready,
            created_at: "2026-07-18T00:00:00.000Z".to_owned(),
            updated_at: "2026-07-18T00:01:00.000Z".to_owned(),
            last_selected_at: Some("2026-07-18T00:01:00.000Z".to_owned()),
        }
    }

    fn project() -> ProjectSummary {
        ProjectSummary {
            schema_version: 1,
            project_id: "project-fixture".to_owned(),
            name: "fixture-repository".to_owned(),
            github_repository: Some("fixture-owner/fixture-repository".to_owned()),
            health: WorkspaceHealth::Ready,
            workspace_count: 1,
            created_at: "2026-07-18T00:00:00.000Z".to_owned(),
            updated_at: "2026-07-18T00:01:00.000Z".to_owned(),
        }
    }

    fn draft() -> WorkspaceDraftView {
        WorkspaceDraftView {
            schema_version: 1,
            workspace_id: "workspace-fixture".to_owned(),
            text: "Verify the persisted workspace.".to_owned(),
            effort: ReasoningEffort::Max,
            revision: 2,
            updated_at: "2026-07-18T00:01:00.000Z".to_owned(),
        }
    }

    fn context() -> ContextSnapshotView {
        ContextSnapshotView {
            schema_version: 1,
            snapshot_id: "context-fixture".to_owned(),
            workspace_id: "workspace-fixture".to_owned(),
            source: ContextSource::GitDiff,
            label: "Working tree diff".to_owned(),
            captured_at: "2026-07-18T00:00:30.000Z".to_owned(),
            byte_count: 42,
            content_hash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
                .to_owned(),
        }
    }

    fn timeline() -> TimelinePage {
        TimelinePage {
            schema_version: 1,
            items: vec![TimelineEventView {
                schema_version: 1,
                event_id: "event-fixture".to_owned(),
                workspace_id: "workspace-fixture".to_owned(),
                session_id: None,
                sequence: 7,
                producer: "code".to_owned(),
                kind: "code.message.completed".to_owned(),
                occurred_at: "2026-07-18T00:00:45.000Z".to_owned(),
                payload: json!({
                    "semanticVersion": 1,
                    "generation": 7,
                    "sourceSequence": 7,
                    "itemHandle": "item-assistant-fixture",
                    "text": "First line\nSecond 😀",
                }),
            }],
            next_before_sequence: None,
        }
    }

    fn state() -> WorkspaceStateSnapshot {
        WorkspaceStateSnapshot {
            schema_version: 1,
            history: HistoryStatus::ready(),
            projects: vec![project()],
            workspaces: vec![summary()],
            active_workspace_id: Some("workspace-fixture".to_owned()),
            draft: Some(draft()),
            context_snapshots: vec![context()],
            timeline: timeline(),
            resume_state: None,
        }
    }

    #[test]
    fn serialized_contracts_match_the_cross_language_fixture() {
        let fixture = fixture();

        assert_eq!(serialized(state()), fixture["state"]);
        assert_eq!(serialized(summary()), fixture["summary"]);
        assert_eq!(serialized(draft()), fixture["draft"]);
        assert_eq!(serialized(context()), fixture["context"]);
        assert_eq!(serialized(timeline()), fixture["timeline"]);
        assert_eq!(
            serialized(WorkspaceDeleteChallengeView {
                schema_version: 1,
                workspace_id: "workspace-fixture".to_owned(),
                token: "delete-fixture".to_owned(),
                expires_at: "2026-07-18T00:02:00.000Z".to_owned(),
            }),
            fixture["challenge"]
        );
        assert_eq!(
            serialized(AppendDomainEventResponse {
                schema_version: 1,
                sequence: 7,
                inserted: true,
            }),
            fixture["append"]
        );
        assert_eq!(
            serialized(WorkspaceCommandError::new(
                "WORKSPACE-NOT-FOUND",
                "workspace_select",
                false,
            )),
            fixture["error"]
        );
        let pick = serialized(WorkspacePickResponse {
            schema_version: 1,
            outcome: WorkspacePickOutcome::Selected,
            state: state(),
            setup: None,
        });
        assert_eq!(pick["state"], fixture["state"]);
        assert_eq!(pick["outcome"], "selected");
    }

    #[test]
    fn fixture_and_public_responses_never_contain_private_paths() {
        let fixture_text = CONTRACT_FIXTURE.to_ascii_lowercase();
        assert!(!fixture_text.contains("/users/"));
        assert!(!fixture_text.contains("canonicalroot"));
        assert!(!fixture_text.contains("gitdir"));
        assert!(!fixture_text.contains("reasoning"));
    }

    #[test]
    fn command_requests_reject_unknown_and_snake_case_fields() {
        assert!(serde_json::from_value::<WorkspaceSelectRequest>(json!({
            "workspaceId": "workspace-fixture",
            "unexpected": true
        }))
        .is_err());
        assert!(serde_json::from_value::<WorkspaceSelectRequest>(json!({
            "workspace_id": "workspace-fixture"
        }))
        .is_err());
        assert!(serde_json::from_value::<WorkspaceRecheckRequest>(json!({
            "workspaceId": "workspace-fixture",
            "acceptObservedHead": false
        }))
        .is_ok());
        assert!(serde_json::from_value::<WorkspaceRecheckRequest>(json!({
            "workspaceId": "workspace-fixture",
            "acceptObservedHead": false,
            "unexpected": true
        }))
        .is_err());
        assert!(
            serde_json::from_value::<WorkspaceSaveTimelineAnchorRequest>(json!({
                "workspaceId": "workspace-fixture",
                "eventId": "event-fixture",
                "sequence": 7,
                "offset": -12
            }))
            .is_ok()
        );
    }
}
