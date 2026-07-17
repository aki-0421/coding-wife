use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const WORKSPACE_HISTORY_SCHEMA_VERSION: u16 = 1;
pub const DOMAIN_EVENT_SCHEMA_VERSION: u16 = 1;

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
}

impl WorkspaceHealth {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ready => "ready",
            Self::Missing => "missing",
            Self::Changed => "changed",
            Self::Unreadable => "unreadable",
            Self::ReadOnly => "read_only",
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
    Fast,
    Max,
}

impl ReasoningEffort {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Fast => "fast",
            Self::Max => "max",
        }
    }
}

impl TryFrom<&str> for ReasoningEffort {
    type Error = ();

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value {
            "fast" => Ok(Self::Fast),
            "max" => Ok(Self::Max),
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

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct WorkspaceStateSnapshot {
    pub schema_version: u16,
    pub history: HistoryStatus,
    pub workspaces: Vec<WorkspaceSummary>,
    pub active_workspace_id: Option<String>,
    pub draft: Option<WorkspaceDraftView>,
    pub context_snapshots: Vec<ContextSnapshotView>,
    pub timeline: TimelinePage,
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
