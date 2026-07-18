use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use thiserror::Error;
use tokio::sync::{mpsc, Mutex};

use crate::git_review::types::CommitEvidenceV1;

use super::binary::{BinaryInfo, SchemaProbe};
use super::bundled_skill::{
    resolve_bundled_skill, ResolvedBundledSkill, EXPLAIN_COMMIT_SKILL_NAME,
};
use super::process::{spawn_support_process, ProcessRuntime};
use super::protocol::{
    account_read_params, parse_support_thread_policy_response, server_error,
    support_thread_start_params, support_turn_start_params, turn_interrupt_params, InboundMessage,
};
use super::redaction::redact_text;
use super::rpc::RuntimeSignal;
use super::support_isolation::{
    initialize_support_process, map_rpc_error, run_isolation_probe, verify_release,
};
use super::support_private::{bridge_auth, support_config, PrivateRunDirectory};
use super::support_probe::EXPECTED_SUPPORT_TOOL_HASH;
use super::types::{TurnExecutionClass, CODEX_MODEL};

pub const SUPPORT_MAX_SESSION_CAPACITY: usize = 1;
pub const SUPPORT_PERMISSION_PROFILE: &str = "coding-wife-support-zero";
const MAX_SUPPORT_INPUT_BYTES: usize = 64 * 1024;
const MAX_SUPPORT_OUTPUT_BYTES: usize = 64 * 1024;
pub(crate) const SUPPORT_TASK_TIMEOUT: Duration = Duration::from_secs(15);
const SUPPORT_INTERRUPT_TIMEOUT: Duration = Duration::from_secs(1);

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SupportFallbackRole {
    Presence,
    Narration,
    DecisionExplainer,
    CommitExplainer,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SupportFallback {
    pub schema_version: u16,
    pub role: SupportFallbackRole,
    pub source_event_id: String,
    pub generation: u64,
    pub summary_key: String,
    pub status: String,
    pub reason_code: String,
    pub active_sessions: usize,
    pub queued_sessions: usize,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CommitExplanationTrigger {
    AutoVerifiedCommit,
    UserRequest,
    UserRetry,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SupportExplainRequest {
    pub schema_version: u16,
    pub request_id: String,
    pub workspace_id: String,
    pub full_commit_sha: String,
    pub trigger: CommitExplanationTrigger,
    pub evidence: CommitEvidenceV1,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ExplanationNarrationChunk {
    pub sequence: u32,
    pub section: String,
    pub text: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CommitExplanationV1 {
    pub schema_version: u16,
    pub locale: String,
    pub summary: String,
    pub changes: Vec<String>,
    pub reasons: Vec<String>,
    pub verification: Vec<String>,
    pub impact: Vec<String>,
    pub cautions: Vec<String>,
    pub how_to_read_next: Vec<String>,
    pub narration_chunks: Vec<ExplanationNarrationChunk>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SupportUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub total_tokens: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SupportExplainResult {
    pub request_id: String,
    pub explanation: CommitExplanationV1,
    pub usage: SupportUsage,
    pub latency_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SupportIsolationAudit {
    pub capacity: usize,
    pub execution_class: TurnExecutionClass,
    pub cli_version: String,
    pub binary_hash_prefix: String,
    pub schema_fingerprint_prefix: String,
    pub tool_hash_prefix: String,
    pub permission_profile: String,
    pub skill_name: String,
    pub skill_version: String,
    pub skill_digest_prefix: String,
    pub malicious_canary_passed: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Error)]
pub enum SupportRuntimeError {
    #[error("the support release identity was not approved")]
    UnsupportedRelease,
    #[error("the support schema proof was not valid")]
    Schema,
    #[error("the support private runtime could not be created")]
    PrivateRuntime,
    #[error("the support authentication bridge was unsafe or unavailable")]
    AuthBridge,
    #[error("the support bundled skill was unavailable")]
    Skill,
    #[error("the support native isolation probe failed")]
    IsolationProbe,
    #[error("the support app-server process failed")]
    Process,
    #[error("the support app-server protocol failed")]
    Protocol,
    #[error("the support runtime violated its isolation policy")]
    Policy,
    #[error("the support runtime is already in use")]
    Busy,
    #[error("the support runtime is single use")]
    AlreadyUsed,
    #[error("the support task was canceled")]
    Canceled,
    #[error("the support task timed out")]
    Timeout,
    #[error("the support output did not match its strict schema")]
    Output,
    #[error("the support evidence did not pass path and secret redaction")]
    EvidenceRedaction,
}

impl SupportRuntimeError {
    pub fn code(self) -> &'static str {
        match self {
            Self::UnsupportedRelease => "CODEX-SUPPORT-RELEASE-UNSUPPORTED",
            Self::Schema => "CODEX-SUPPORT-SCHEMA-UNVERIFIED",
            Self::PrivateRuntime => "CODEX-SUPPORT-RUNTIME-UNSAFE",
            Self::AuthBridge => "CODEX-SUPPORT-AUTH-BRIDGE-UNAVAILABLE",
            Self::Skill => "CODEX-SUPPORT-SKILL-INVALID",
            Self::IsolationProbe => "CODEX-SUPPORT-ISOLATION-UNVERIFIED",
            Self::Process => "CODEX-SUPPORT-PROCESS-FAILED",
            Self::Protocol => "CODEX-SUPPORT-PROTOCOL-MISMATCH",
            Self::Policy => "CODEX-SUPPORT-POLICY-VIOLATION",
            Self::Busy => "CODEX-SUPPORT-BUSY",
            Self::AlreadyUsed => "CODEX-SUPPORT-RUNTIME-USED",
            Self::Canceled => "CODEX-SUPPORT-CANCELED",
            Self::Timeout => "CODEX-SUPPORT-TIMEOUT",
            Self::Output => "CODEX-SUPPORT-OUTPUT-INVALID",
            Self::EvidenceRedaction => "CODEX-SUPPORT-EVIDENCE-REDACTION",
        }
    }
}

pub fn deterministic_fallback(
    role: SupportFallbackRole,
    source_event_id: impl Into<String>,
    generation: u64,
    reason: SupportRuntimeError,
) -> SupportFallback {
    let summary_key = match role {
        SupportFallbackRole::Presence => "support.fallback.presence",
        SupportFallbackRole::Narration => "support.fallback.narration",
        SupportFallbackRole::DecisionExplainer => "support.fallback.decision",
        SupportFallbackRole::CommitExplainer => "support.fallback.commit_explanation",
    };
    SupportFallback {
        schema_version: 1,
        role,
        source_event_id: source_event_id.into(),
        generation,
        summary_key: summary_key.to_owned(),
        status: "fallback".to_owned(),
        reason_code: reason.code().to_owned(),
        active_sessions: 0,
        queued_sessions: 0,
    }
}

pub fn default_auth_source() -> Option<PathBuf> {
    std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .map(|home| home.join("auth.json"))
        .or_else(|| {
            std::env::var_os("HOME")
                .map(PathBuf::from)
                .map(|home| home.join(".codex/auth.json"))
        })
        .filter(|path| path.exists())
}

pub struct SupportRuntime {
    runtime: Arc<ProcessRuntime>,
    signals: Mutex<mpsc::Receiver<RuntimeSignal>>,
    run_directory: PrivateRunDirectory,
    thread_id: String,
    skill: ResolvedBundledSkill,
    audit: SupportIsolationAudit,
    used: AtomicBool,
    cancel_requested: AtomicBool,
    active: Mutex<Option<ActiveSupportTurn>>,
}

#[derive(Clone)]
struct ActiveSupportTurn {
    thread_id: String,
    turn_id: Option<String>,
    canceled: Arc<AtomicBool>,
}

impl SupportRuntime {
    pub async fn construct(
        binary: &BinaryInfo,
        schema: &SchemaProbe,
        resource_directory: &Path,
        auth_source: Option<&Path>,
    ) -> Result<Self, SupportRuntimeError> {
        verify_release(binary, schema).await?;
        let verified_skill = resolve_bundled_skill(resource_directory, EXPLAIN_COMMIT_SKILL_NAME)
            .map_err(|_| SupportRuntimeError::Skill)?;
        run_isolation_probe(binary, &verified_skill).await?;

        let run_directory = PrivateRunDirectory::create("runtime")?;
        let skill = run_directory.snapshot_support_skill(&verified_skill)?;
        let auth_source = auth_source
            .map(Path::to_path_buf)
            .or_else(default_auth_source)
            .ok_or(SupportRuntimeError::AuthBridge)?;
        bridge_auth(&auth_source, &run_directory.codex_home)?;
        run_directory.write_config(&support_config(None))?;

        let (signals, receiver) = mpsc::channel(256);
        let runtime = Arc::new(
            spawn_support_process(
                binary,
                &run_directory.workspace,
                &run_directory.root,
                1,
                signals,
                run_directory.environment(binary.source == super::types::BinarySource::TestFixture),
            )
            .await
            .map_err(|_| SupportRuntimeError::Process)?,
        );
        let thread = async {
            initialize_support_process(&runtime).await?;
            let account = runtime
                .connection
                .request(
                    "account/read",
                    account_read_params(),
                    Duration::from_secs(5),
                )
                .await
                .map_err(map_rpc_error)?;
            if account.get("account").is_none_or(Value::is_null) {
                return Err(SupportRuntimeError::AuthBridge);
            }
            let thread = runtime
                .connection
                .request(
                    "thread/start",
                    support_thread_start_params(
                        &run_directory.workspace,
                        CODEX_MODEL,
                        Some("openai"),
                    ),
                    Duration::from_secs(5),
                )
                .await
                .map_err(map_rpc_error)?;
            let thread = parse_support_thread_policy_response(
                &thread,
                &run_directory.workspace,
                CODEX_MODEL,
                Some("openai"),
            )
            .map_err(|_| SupportRuntimeError::Policy)?;
            if runtime.execution_class() != TurnExecutionClass::Support {
                return Err(SupportRuntimeError::Policy);
            }
            Ok(thread)
        }
        .await;
        let thread = match thread {
            Ok(thread) => thread,
            Err(error) => {
                runtime.shutdown().await;
                return Err(error);
            }
        };

        Ok(Self {
            runtime,
            signals: Mutex::new(receiver),
            run_directory,
            thread_id: thread.thread_id,
            audit: SupportIsolationAudit {
                capacity: SUPPORT_MAX_SESSION_CAPACITY,
                execution_class: TurnExecutionClass::Support,
                cli_version: binary.cli_version.clone(),
                binary_hash_prefix: prefix(&binary.executable_sha256),
                schema_fingerprint_prefix: prefix(&schema.fingerprint),
                tool_hash_prefix: prefix(EXPECTED_SUPPORT_TOOL_HASH),
                permission_profile: SUPPORT_PERMISSION_PROFILE.to_owned(),
                skill_name: skill.name.clone(),
                skill_version: skill.version.clone(),
                skill_digest_prefix: prefix(
                    skill
                        .content_digest
                        .strip_prefix("sha256:")
                        .unwrap_or(&skill.content_digest),
                ),
                malicious_canary_passed: true,
            },
            skill,
            used: AtomicBool::new(false),
            cancel_requested: AtomicBool::new(false),
            active: Mutex::new(None),
        })
    }

    pub fn audit(&self) -> &SupportIsolationAudit {
        &self.audit
    }

    pub async fn explain_commit(
        &self,
        request: SupportExplainRequest,
    ) -> Result<SupportExplainResult, SupportRuntimeError> {
        if self.used.swap(true, Ordering::AcqRel) {
            return Err(SupportRuntimeError::AlreadyUsed);
        }
        if self.cancel_requested.load(Ordering::Acquire) {
            return Err(SupportRuntimeError::Canceled);
        }
        validate_explain_request(&request)?;
        let input = serde_json::to_vec(&json!({
            "schemaVersion": 1,
            "requestId": request.request_id,
            "trigger": request.trigger,
            "evidence": request.evidence,
        }))
        .map_err(|_| SupportRuntimeError::Output)?;
        if input.len() > MAX_SUPPORT_INPUT_BYTES {
            return Err(SupportRuntimeError::Output);
        }
        let input = String::from_utf8(input).map_err(|_| SupportRuntimeError::Output)?;
        let started = Instant::now();
        let canceled = Arc::new(AtomicBool::new(
            self.cancel_requested.load(Ordering::Acquire),
        ));
        {
            let mut active = self.active.lock().await;
            if active.is_some() {
                return Err(SupportRuntimeError::Busy);
            }
            *active = Some(ActiveSupportTurn {
                thread_id: self.thread_id.clone(),
                turn_id: None,
                canceled: canceled.clone(),
            });
        }
        let params = support_turn_start_params(
            &self.thread_id,
            &self.run_directory.workspace,
            &request.request_id,
            &input,
            &request.evidence.locale,
            CODEX_MODEL,
            &self.skill,
        )
        .map_err(|_| SupportRuntimeError::Skill)?;
        let turn = match self
            .runtime
            .connection
            .request("turn/start", params, SUPPORT_TASK_TIMEOUT)
            .await
        {
            Ok(turn) => turn,
            Err(error) => {
                *self.active.lock().await = None;
                return Err(map_rpc_error(error));
            }
        };
        let turn_id = turn
            .pointer("/turn/id")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty() && value.len() <= 256)
            .map(str::to_owned)
            .ok_or(SupportRuntimeError::Protocol)?;
        {
            let mut active = self.active.lock().await;
            let Some(active) = active.as_mut() else {
                return Err(SupportRuntimeError::Protocol);
            };
            active.turn_id = Some(turn_id.clone());
        }
        if canceled.load(Ordering::Acquire) {
            let _ = self.interrupt(&self.thread_id, &turn_id).await;
        }

        let remaining = SUPPORT_TASK_TIMEOUT.saturating_sub(started.elapsed());
        let terminal = self
            .wait_for_turn(&self.thread_id, &turn_id, remaining)
            .await;
        *self.active.lock().await = None;
        let terminal = match terminal {
            Ok(terminal) => terminal,
            Err(error) => {
                let _ = self.interrupt(&self.thread_id, &turn_id).await;
                return Err(error);
            }
        };
        if canceled.load(Ordering::Acquire) || terminal.status == "interrupted" {
            return Err(SupportRuntimeError::Canceled);
        }
        if terminal.status != "completed" {
            return Err(SupportRuntimeError::Protocol);
        }
        let text = terminal.agent_message.ok_or(SupportRuntimeError::Output)?;
        let explanation = parse_explanation(&text, &request.evidence.locale)?;
        Ok(SupportExplainResult {
            request_id: request.request_id,
            explanation,
            usage: terminal.usage,
            latency_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
        })
    }

    pub async fn cancel(&self) -> Result<bool, SupportRuntimeError> {
        self.cancel_requested.store(true, Ordering::Release);
        let active = self.active.lock().await.clone();
        let Some(active) = active else {
            return Ok(self.used.load(Ordering::Acquire));
        };
        active.canceled.store(true, Ordering::Release);
        if let Some(turn_id) = active.turn_id {
            self.interrupt(&active.thread_id, &turn_id).await?;
        }
        Ok(true)
    }

    async fn interrupt(&self, thread_id: &str, turn_id: &str) -> Result<(), SupportRuntimeError> {
        self.runtime
            .connection
            .request(
                "turn/interrupt",
                turn_interrupt_params(thread_id, turn_id),
                SUPPORT_INTERRUPT_TIMEOUT,
            )
            .await
            .map(|_| ())
            .map_err(map_rpc_error)
    }

    async fn wait_for_turn(
        &self,
        thread_id: &str,
        turn_id: &str,
        timeout: Duration,
    ) -> Result<TerminalTurn, SupportRuntimeError> {
        let deadline = tokio::time::Instant::now() + timeout;
        let mut signals = self.signals.lock().await;
        let mut agent_message = None;
        let mut usage = SupportUsage::default();
        loop {
            let signal = tokio::time::timeout_at(deadline, signals.recv())
                .await
                .map_err(|_| SupportRuntimeError::Timeout)?
                .ok_or(SupportRuntimeError::Protocol)?;
            match signal {
                RuntimeSignal::ProtocolViolation { .. } | RuntimeSignal::Disconnected { .. } => {
                    return Err(SupportRuntimeError::Protocol)
                }
                RuntimeSignal::Inbound { message, .. } => match message {
                    InboundMessage::ServerRequest { id, .. } => {
                        let _ = self.runtime.connection.send(server_error(
                            &id,
                            -32601,
                            "Support runtime rejects server requests",
                        ));
                        return Err(SupportRuntimeError::Policy);
                    }
                    InboundMessage::Notification { method, params, .. } => {
                        if method == "turn/plan/updated"
                            || method.contains("requestApproval")
                            || method.contains("requestUserInput")
                        {
                            return Err(SupportRuntimeError::Policy);
                        }
                        match method.as_str() {
                            "remoteControl/status/changed"
                            | "deprecationNotice"
                            | "warning"
                            | "thread/status/changed"
                            | "account/rateLimits/updated" => {}
                            "thread/started" => {
                                if params.pointer("/thread/id").and_then(Value::as_str)
                                    != Some(thread_id)
                                    || params.pointer("/thread/ephemeral").and_then(Value::as_bool)
                                        != Some(true)
                                {
                                    return Err(SupportRuntimeError::Policy);
                                }
                            }
                            "turn/started" => {
                                if !matches_context(&params, thread_id, turn_id) {
                                    return Err(SupportRuntimeError::Protocol);
                                }
                            }
                            "item/started" | "item/completed" => {
                                if !matches_context(&params, thread_id, turn_id) {
                                    return Err(SupportRuntimeError::Protocol);
                                }
                                let item_type = params
                                    .pointer("/item/type")
                                    .and_then(Value::as_str)
                                    .ok_or(SupportRuntimeError::Protocol)?;
                                if !matches!(
                                    item_type,
                                    "userMessage" | "agentMessage" | "reasoning"
                                ) {
                                    return Err(SupportRuntimeError::Policy);
                                }
                                if method == "item/completed" && item_type == "agentMessage" {
                                    if agent_message.is_some() {
                                        return Err(SupportRuntimeError::Output);
                                    }
                                    let text = params
                                        .pointer("/item/text")
                                        .and_then(Value::as_str)
                                        .filter(|text| text.len() <= MAX_SUPPORT_OUTPUT_BYTES)
                                        .ok_or(SupportRuntimeError::Output)?;
                                    agent_message = Some(text.to_owned());
                                }
                            }
                            "item/agentMessage/delta" => {
                                if !matches_context(&params, thread_id, turn_id)
                                    || params.get("delta").and_then(Value::as_str).is_none()
                                {
                                    return Err(SupportRuntimeError::Protocol);
                                }
                            }
                            "thread/tokenUsage/updated" => {
                                if !matches_context(&params, thread_id, turn_id) {
                                    return Err(SupportRuntimeError::Protocol);
                                }
                                usage = parse_usage(&params).unwrap_or_default();
                            }
                            "turn/completed" => {
                                if !matches_context(&params, thread_id, turn_id) {
                                    return Err(SupportRuntimeError::Protocol);
                                }
                                let status = params
                                    .pointer("/turn/status")
                                    .and_then(Value::as_str)
                                    .filter(|status| {
                                        matches!(*status, "completed" | "interrupted" | "failed")
                                    })
                                    .ok_or(SupportRuntimeError::Protocol)?;
                                return Ok(TerminalTurn {
                                    status: status.to_owned(),
                                    agent_message,
                                    usage,
                                });
                            }
                            method if method.starts_with("item/reasoning/") => {
                                if !matches_context(&params, thread_id, turn_id) {
                                    return Err(SupportRuntimeError::Protocol);
                                }
                            }
                            _ => {
                                return Err(SupportRuntimeError::Policy);
                            }
                        }
                    }
                    InboundMessage::Response { .. } => return Err(SupportRuntimeError::Protocol),
                },
            }
        }
    }

    pub async fn shutdown(&self) -> Result<(), SupportRuntimeError> {
        self.runtime.shutdown().await;
        self.run_directory.cleanup()
    }
}

struct TerminalTurn {
    status: String,
    agent_message: Option<String>,
    usage: SupportUsage,
}

fn validate_explain_request(request: &SupportExplainRequest) -> Result<(), SupportRuntimeError> {
    if request.schema_version != 1
        || request.request_id.is_empty()
        || request.request_id.len() > 128
        || request.workspace_id.is_empty()
        || request.workspace_id.len() > 128
        || !valid_full_sha(&request.full_commit_sha)
        || request.evidence.schema_version != 1
        || !matches!(request.evidence.locale.as_str(), "ja" | "en")
    {
        return Err(SupportRuntimeError::Output);
    }
    let evidence = serde_json::to_value(&request.evidence)
        .map_err(|_| SupportRuntimeError::EvidenceRedaction)?;
    if value_contains_private_string(&evidence) {
        return Err(SupportRuntimeError::EvidenceRedaction);
    }
    Ok(())
}

fn value_contains_private_string(value: &Value) -> bool {
    match value {
        Value::String(value) => private_evidence_string(value),
        Value::Array(values) => values.iter().any(value_contains_private_string),
        Value::Object(values) => values.values().any(value_contains_private_string),
        Value::Null | Value::Bool(_) | Value::Number(_) => false,
    }
}

fn private_evidence_string(value: &str) -> bool {
    static SECRET: OnceLock<Regex> = OnceLock::new();
    static RELATIVE_PATH: OnceLock<Regex> = OnceLock::new();
    let secret = SECRET.get_or_init(|| {
        Regex::new(
            r"(?i)(?:\bgh[pousr]_[a-z0-9]{20,}\b|\bgithub_pat_[a-z0-9_]{20,}\b|\b(?:AKIA|ASIA)[0-9A-Z]{16}\b|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)",
        )
        .expect("support secret regex")
    });
    let relative_path = RELATIVE_PATH.get_or_init(|| {
        Regex::new(
            r#"(?x)(?:^|[\s`'"(])(?:\.\.?/|(?:src|app|docs|test|tests|packages|crates|\.github)/)[A-Za-z0-9_.@+{}$%/-]+"#,
        )
        .expect("support relative path regex")
    });
    if value.contains("://")
        || value.contains("file:")
        || value.contains('\\')
        || secret.is_match(value)
        || relative_path.is_match(value)
    {
        return true;
    }
    let redacted = redact_text(value, None, value.len().saturating_add(1));
    redacted != value
}

fn valid_full_sha(value: &str) -> bool {
    matches!(value.len(), 40 | 64)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub(super) fn parse_explanation(
    text: &str,
    expected_locale: &str,
) -> Result<CommitExplanationV1, SupportRuntimeError> {
    if text.len() > MAX_SUPPORT_OUTPUT_BYTES {
        return Err(SupportRuntimeError::Output);
    }
    let explanation: CommitExplanationV1 =
        serde_json::from_str(text).map_err(|_| SupportRuntimeError::Output)?;
    if explanation.schema_version != 1
        || explanation.locale != expected_locale
        || explanation.summary.is_empty()
        || explanation.summary.chars().count() > 4096
    {
        return Err(SupportRuntimeError::Output);
    }
    for values in [
        &explanation.changes,
        &explanation.reasons,
        &explanation.verification,
        &explanation.impact,
        &explanation.cautions,
        &explanation.how_to_read_next,
    ] {
        if values.is_empty()
            || values.len() > 16
            || values
                .iter()
                .any(|value| value.is_empty() || value.chars().count() > 2048)
        {
            return Err(SupportRuntimeError::Output);
        }
    }
    if explanation.narration_chunks.is_empty() || explanation.narration_chunks.len() > 32 {
        return Err(SupportRuntimeError::Output);
    }
    let mut previous_section = 0_usize;
    for (index, chunk) in explanation.narration_chunks.iter().enumerate() {
        let section = section_index(&chunk.section).ok_or(SupportRuntimeError::Output)?;
        if chunk.sequence != u32::try_from(index + 1).unwrap_or(u32::MAX)
            || section < previous_section
            || chunk.text.is_empty()
            || chunk.text.chars().count() > 240
        {
            return Err(SupportRuntimeError::Output);
        }
        previous_section = section;
    }
    Ok(explanation)
}

fn section_index(section: &str) -> Option<usize> {
    [
        "summary",
        "changes",
        "reasons",
        "verification",
        "impact",
        "cautions",
        "howToReadNext",
    ]
    .iter()
    .position(|candidate| candidate == &section)
}

fn matches_context(params: &Value, thread_id: &str, turn_id: &str) -> bool {
    params.get("threadId").and_then(Value::as_str) == Some(thread_id)
        && (params.get("turnId").and_then(Value::as_str) == Some(turn_id)
            || params.pointer("/turn/id").and_then(Value::as_str) == Some(turn_id))
}

fn parse_usage(params: &Value) -> Option<SupportUsage> {
    let total = params.pointer("/tokenUsage/total")?;
    Some(SupportUsage {
        input_tokens: total.get("inputTokens")?.as_u64()?,
        output_tokens: total.get("outputTokens")?.as_u64()?,
        total_tokens: total.get("totalTokens")?.as_u64()?,
    })
}

fn prefix(value: &str) -> String {
    value.chars().take(12).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn explanation(locale: &str) -> String {
        serde_json::to_string(&json!({
            "schemaVersion": 1,
            "locale": locale,
            "summary": "Summary",
            "changes": ["Change"],
            "reasons": ["Reason"],
            "verification": ["Verified"],
            "impact": ["Impact"],
            "cautions": ["None"],
            "howToReadNext": ["Read evidence"],
            "narrationChunks": [
                {"sequence": 1, "section": "summary", "text": "Summary"},
                {"sequence": 2, "section": "changes", "text": "Change"}
            ]
        }))
        .expect("explanation")
    }

    #[test]
    fn strict_explanation_rejects_locale_sequence_and_unknown_fields() {
        assert!(parse_explanation(&explanation("ja"), "ja").is_ok());
        assert_eq!(
            parse_explanation(&explanation("en"), "ja"),
            Err(SupportRuntimeError::Output)
        );
        let invalid = explanation("ja").replace("\"sequence\":2", "\"sequence\":3");
        assert_eq!(
            parse_explanation(&invalid, "ja"),
            Err(SupportRuntimeError::Output)
        );
        let invalid = explanation("ja").replace(
            "\"summary\":\"Summary\"",
            "\"extra\":true,\"summary\":\"Summary\"",
        );
        assert_eq!(
            parse_explanation(&invalid, "ja"),
            Err(SupportRuntimeError::Output)
        );

        let items = vec!["x".repeat(1024); 16];
        let oversized = serde_json::to_string(&json!({
            "schemaVersion": 1,
            "locale": "ja",
            "summary": "Summary",
            "changes": items.clone(),
            "reasons": items.clone(),
            "verification": items.clone(),
            "impact": items.clone(),
            "cautions": items.clone(),
            "howToReadNext": items,
            "narrationChunks": [
                {"sequence": 1, "section": "summary", "text": "Summary"}
            ]
        }))
        .expect("oversized explanation");
        assert!(oversized.len() > MAX_SUPPORT_OUTPUT_BYTES);
        assert_eq!(
            parse_explanation(&oversized, "ja"),
            Err(SupportRuntimeError::Output)
        );
    }

    #[test]
    fn fallback_is_deterministic_and_contains_no_generated_content() {
        let first = deterministic_fallback(
            SupportFallbackRole::CommitExplainer,
            "event-1",
            7,
            SupportRuntimeError::IsolationProbe,
        );
        let second = deterministic_fallback(
            SupportFallbackRole::CommitExplainer,
            "event-1",
            7,
            SupportRuntimeError::IsolationProbe,
        );
        assert_eq!(first, second);
        assert_eq!(first.summary_key, "support.fallback.commit_explanation");
        assert_eq!(first.active_sessions, 0);
        assert_eq!(first.queued_sessions, 0);
    }
}
