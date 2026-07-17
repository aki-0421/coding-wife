use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

pub const CODEX_ADAPTER_VERSION: u16 = 1;
pub const CODEX_EVENT_SCHEMA_VERSION: u16 = 1;
pub const CODEX_MODEL: &str = "gpt-5.6-sol";

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CapabilityState {
    Supported,
    Unavailable,
    Unverified,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CodexCapabilities {
    pub core_lifecycle: CapabilityState,
    pub model_discovery: CapabilityState,
    pub native_request_user_input: CapabilityState,
    pub dynamic_tools: CapabilityState,
    pub permissions_approval: CapabilityState,
    pub detached_review: CapabilityState,
    pub ephemeral_thread: CapabilityState,
    pub support_isolation: CapabilityState,
}

impl Default for CodexCapabilities {
    fn default() -> Self {
        Self {
            core_lifecycle: CapabilityState::Unverified,
            model_discovery: CapabilityState::Unverified,
            native_request_user_input: CapabilityState::Unverified,
            dynamic_tools: CapabilityState::Unverified,
            permissions_approval: CapabilityState::Unverified,
            detached_review: CapabilityState::Unverified,
            ephemeral_thread: CapabilityState::Unverified,
            // The 0.144.x contract cannot prove tool=0 and cwd=null.
            support_isolation: CapabilityState::Unavailable,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CodexHealth {
    BinaryMissing,
    BinaryUntrusted,
    SchemaUnsupported,
    Initializing,
    AuthRequired,
    ModelUnavailable,
    EffortUnavailable,
    Ready,
    Disconnected,
    ProtocolMismatch,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ChildState {
    Stopped,
    Probing,
    Spawning,
    Initializing,
    Ready,
    Restarting,
    Stopping,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BinarySource {
    Explicit,
    Path,
    KnownInstall,
    TestFixture,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CodexDiagnostic {
    pub adapter_version: u16,
    pub health: CodexHealth,
    pub checked_at: String,
    pub operation: String,
    pub recoverable: bool,
    pub cli_version: Option<String>,
    pub binary_source: Option<BinarySource>,
    pub binary_hash_prefix: Option<String>,
    pub schema_fingerprint_prefix: Option<String>,
    pub generated_by_same_binary: bool,
    pub experimental_api_requested: bool,
    pub experimental_api_accepted: bool,
    pub account_present: bool,
    pub auth_kind: Option<String>,
    pub requires_openai_auth: bool,
    pub model_available: bool,
    pub fast_available: bool,
    pub max_available: bool,
    pub config_model_present: bool,
    pub child_state: ChildState,
    pub last_successful_handshake_at: Option<String>,
    pub capabilities: CodexCapabilities,
    pub error_code: Option<String>,
    pub detail_ref: Option<String>,
}

impl Default for CodexDiagnostic {
    fn default() -> Self {
        Self {
            adapter_version: CODEX_ADAPTER_VERSION,
            health: CodexHealth::Disconnected,
            checked_at: chrono::Utc::now().to_rfc3339(),
            operation: "codex.initialize".to_owned(),
            recoverable: true,
            cli_version: None,
            binary_source: None,
            binary_hash_prefix: None,
            schema_fingerprint_prefix: None,
            generated_by_same_binary: false,
            experimental_api_requested: true,
            experimental_api_accepted: false,
            account_present: false,
            auth_kind: None,
            requires_openai_auth: false,
            model_available: false,
            fast_available: false,
            max_available: false,
            config_model_present: false,
            child_state: ChildState::Stopped,
            last_successful_handshake_at: None,
            capabilities: CodexCapabilities::default(),
            error_code: None,
            detail_ref: None,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CodexCommandError {
    pub code: String,
    pub operation: String,
    pub recoverable: bool,
    pub user_message_key: String,
    pub detail_ref: Option<String>,
}

impl CodexCommandError {
    pub fn new(code: impl Into<String>, operation: impl Into<String>, recoverable: bool) -> Self {
        Self {
            code: code.into(),
            operation: operation.into(),
            recoverable,
            user_message_key: "codex.error.generic".to_owned(),
            detail_ref: None,
        }
    }

    pub fn with_detail_ref(mut self, detail_ref: impl Into<String>) -> Self {
        self.detail_ref = Some(detail_ref.into());
        self
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CodexConnectRequest {
    pub workspace_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CodexDiagnoseRequest {
    pub workspace_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CodexThreadListRequest {
    pub workspace_id: String,
    pub cursor: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CodexThreadStartRequest {
    pub workspace_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CodexThreadResumeRequest {
    pub workspace_id: String,
    pub thread_handle: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ReasoningPreset {
    Low,
    Max,
}

impl ReasoningPreset {
    pub fn as_wire(self) -> &'static str {
        match self {
            Self::Low => "low",
            Self::Max => "max",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CodexTurnStartRequest {
    pub workspace_id: String,
    pub thread_handle: String,
    pub client_user_message_id: String,
    pub text: String,
    pub effort: ReasoningPreset,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CodexTurnInterruptRequest {
    pub workspace_id: String,
    pub thread_handle: String,
    pub turn_handle: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ReviewTarget {
    UncommittedChanges,
    BaseBranch { branch: String },
    Commit { sha: String, title: Option<String> },
    Custom { instructions: String },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CodexReviewStartRequest {
    pub workspace_id: String,
    pub thread_handle: String,
    pub target: ReviewTarget,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalDecision {
    ApproveOnce,
    Reject,
    Stop,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PendingResponse {
    Approval {
        decision: ApprovalDecision,
    },
    UserInput {
        answers: BTreeMap<String, Vec<String>>,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CodexPendingResponseRequest {
    pub workspace_id: String,
    pub pending_id: String,
    pub response: PendingResponse,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ThreadSummary {
    pub thread_handle: String,
    pub status: String,
    pub title: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ThreadListResponse {
    pub data: Vec<ThreadSummary>,
    pub next_cursor: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ThreadResponse {
    pub thread_handle: String,
    pub model: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TurnResponse {
    pub thread_handle: String,
    pub turn_handle: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ReviewResponse {
    pub review_thread_handle: String,
    pub turn_handle: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct AcceptedResponse {
    pub accepted: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PendingKind {
    CommandApproval,
    FileChangeApproval,
    PermissionsApproval,
    UserInput,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PendingOption {
    pub id: String,
    pub label: String,
    pub description: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PendingQuestion {
    pub id: String,
    pub header: String,
    pub question: String,
    pub options: Vec<PendingOption>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PendingRequestView {
    pub pending_id: String,
    pub kind: PendingKind,
    pub operation: String,
    pub target_alias: String,
    pub reason: Option<String>,
    pub questions: Vec<PendingQuestion>,
    pub allowed_decisions: Vec<ApprovalDecision>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", content = "payload", rename_all = "snake_case")]
pub enum CodexEventPayload {
    ThreadStatus {
        thread_handle: String,
        status: String,
    },
    TurnStatus {
        thread_handle: String,
        turn_handle: String,
        status: String,
    },
    ItemStatus {
        item_handle: String,
        item_type: String,
        status: String,
    },
    AgentMessageDelta {
        item_handle: String,
        delta: String,
    },
    AgentMessageCompleted {
        item_handle: String,
        text: String,
    },
    PlanUpdated {
        step_count: usize,
    },
    DiffUpdated {
        byte_count: usize,
        detail_ref: String,
    },
    ToolOutput {
        item_handle: String,
        excerpt: String,
    },
    FileChange {
        item_handle: String,
        path_alias: String,
        change_kind: String,
    },
    PendingRequest {
        request: PendingRequestView,
    },
    Diagnostic {
        code: String,
        will_retry: bool,
        detail_ref: String,
    },
    ModelViolation {
        from_model: String,
        to_model: String,
    },
    ProtocolUnsupported {
        method_hash: String,
        byte_count: usize,
        detail_ref: String,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CodexEvent {
    pub schema_version: u16,
    pub event_id: String,
    pub workspace_id: String,
    pub generation: u64,
    pub sequence: u64,
    pub occurred_at: String,
    #[serde(flatten)]
    pub payload: CodexEventPayload,
}
