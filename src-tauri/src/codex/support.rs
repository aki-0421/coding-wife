use std::fmt;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use std::time::{Duration, Instant};

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use thiserror::Error;
use tokio::sync::{mpsc, Mutex, Notify};

use crate::git_review::public_evidence::contains_private_public_material;
use crate::git_review::types::CommitEvidenceV1;

use super::binary::{BinaryInfo, SchemaProbe};
use super::bundled_skill::{
    resolve_bundled_skill, ResolvedBundledSkill, DIRECT_PRESENCE_SKILL_NAME,
    EXPLAIN_COMMIT_SKILL_NAME,
};
use super::process::{spawn_support_process, ProcessRuntime};
use super::protocol::{
    account_read_params, parse_support_thread_policy_response, presence_turn_start_params,
    server_error, support_thread_start_params, support_turn_start_params, turn_interrupt_params,
    validate_support_thread_settings_notification, InboundMessage,
};
use super::redaction::redact_text;
#[cfg(test)]
use super::rpc::SUPPORT_MAX_JSONL_BUFFER_BYTES;
use super::rpc::{RuntimeSignal, SUPPORT_MAX_FRAME_BYTES};
use super::support_isolation::{
    initialize_support_process, map_rpc_error, run_isolation_probe_controlled, verify_release,
};
use super::support_private::{bridge_auth, support_config, PrivateRunDirectory};
use super::support_probe::EXPECTED_SUPPORT_TOOL_HASH;
use super::types::{
    TurnExecutionClass, CODEX_COMMIT_EXPLAINER_MODEL, CODEX_PRESENCE_DIRECTOR_MODEL,
};

pub const SUPPORT_MAX_SESSION_CAPACITY: usize = 1;
pub const SUPPORT_PERMISSION_PROFILE: &str = "coding-wife-support-zero";
const MAX_SUPPORT_INPUT_BYTES: usize = 64 * 1024;
const MAX_SUPPORT_OUTPUT_BYTES: usize = 64 * 1024;
const MAX_SUPPORT_NOTIFICATION_EVENTS: usize = 256;
const MAX_SUPPORT_NOTIFICATION_BYTES: usize = 512 * 1024;
const MAX_SUPPORT_AGENT_DELTA_BYTES: usize = 64 * 1024;
const MAX_SUPPORT_REASONING_BYTES: usize = 64 * 1024;
pub(super) const SUPPORT_SIGNAL_QUEUE_CAPACITY: usize = 8;
pub(crate) const SUPPORT_TASK_TIMEOUT: Duration = Duration::from_secs(15);
const SUPPORT_INTERRUPT_TIMEOUT: Duration = Duration::from_secs(1);
const SUPPORT_CONSTRUCTION_GRACEFUL_TIMEOUT: Duration = Duration::from_millis(1_500);
const SUPPORT_CONSTRUCTION_FORCE_WAIT: Duration = Duration::from_millis(400);
const SUPPORT_CONSTRUCTION_FORCE_BUDGET: Duration = Duration::from_millis(450);
const SUPPORT_CONSTRUCTION_CANCEL_BUDGET: Duration = Duration::from_secs(4);

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SupportFallbackRole {
    Presence,
    Narration,
    DecisionExplainer,
    CommitExplainer,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SupportModelRole {
    CommitExplainer,
    PresenceDirector,
}

impl SupportModelRole {
    pub fn exact_model(self) -> &'static str {
        match self {
            Self::CommitExplainer => CODEX_COMMIT_EXPLAINER_MODEL,
            Self::PresenceDirector => CODEX_PRESENCE_DIRECTOR_MODEL,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PresenceLocale {
    Ja,
    En,
}

impl PresenceLocale {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ja => "ja",
            Self::En => "en",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PresenceTrigger {
    MainMessage,
    DecisionWait,
    RecoverableFailure,
    TerminalFailure,
    LongMilestone,
    CommitReady,
    TurnCompleted,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PresenceSemanticState {
    Neutral,
    Working,
    Asking,
    Success,
    Warning,
    Error,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum PresenceElapsedBucket {
    #[serde(rename = "none")]
    None,
    #[serde(rename = "45s_plus")]
    Seconds45Plus,
    #[serde(rename = "120s_plus")]
    Seconds120Plus,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PresenceCue {
    Neutral,
    Working,
    Asking,
    Success,
    Warning,
    Error,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PresenceDirectorInputV1 {
    pub schema_version: u16,
    pub locale: PresenceLocale,
    pub trigger: PresenceTrigger,
    pub semantic_state: PresenceSemanticState,
    pub retrying: bool,
    pub elapsed_bucket: PresenceElapsedBucket,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_excerpt: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PresenceDirectionV1 {
    pub schema_version: u16,
    pub locale: PresenceLocale,
    pub utterance: String,
    pub cue: PresenceCue,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SupportPresenceRequest {
    pub request_id: String,
    pub workspace_id: String,
    pub workspace_generation: u64,
    pub input: PresenceDirectorInputV1,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SupportPresenceResult {
    pub direction: PresenceDirectionV1,
    pub usage: SupportUsage,
    pub latency_ms: u64,
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
    pub model_role: SupportModelRole,
    pub model: String,
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

#[derive(Clone)]
pub struct SupportRuntimeConstructionError {
    reason: SupportRuntimeError,
    pending_cleanup: Option<SupportRuntimeCleanup>,
}

impl SupportRuntimeConstructionError {
    fn clean(reason: SupportRuntimeError) -> Self {
        Self {
            reason,
            pending_cleanup: None,
        }
    }

    fn unconverged(reason: SupportRuntimeError, cleanup: SupportRuntimeCleanup) -> Self {
        Self {
            reason,
            pending_cleanup: Some(cleanup),
        }
    }

    pub fn reason(&self) -> SupportRuntimeError {
        self.reason
    }

    pub fn code(&self) -> &'static str {
        self.reason.code()
    }

    pub fn cleanup_converged(&self) -> bool {
        self.pending_cleanup
            .as_ref()
            .is_none_or(SupportRuntimeCleanup::cleanup_converged)
    }

    pub(crate) fn take_pending_cleanup(&mut self) -> Option<SupportRuntimeCleanup> {
        self.pending_cleanup.take()
    }

    pub async fn force_shutdown_now(&self) -> bool {
        match self.pending_cleanup.as_ref() {
            Some(cleanup) => cleanup.force_shutdown_now().await,
            None => true,
        }
    }
}

impl From<SupportRuntimeError> for SupportRuntimeConstructionError {
    fn from(reason: SupportRuntimeError) -> Self {
        Self::clean(reason)
    }
}

impl fmt::Debug for SupportRuntimeConstructionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SupportRuntimeConstructionError")
            .field("reason", &self.reason)
            .field("cleanup_converged", &self.cleanup_converged())
            .finish()
    }
}

impl fmt::Display for SupportRuntimeConstructionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.reason.fmt(formatter)
    }
}

impl std::error::Error for SupportRuntimeConstructionError {}

impl PartialEq<SupportRuntimeError> for SupportRuntimeConstructionError {
    fn eq(&self, other: &SupportRuntimeError) -> bool {
        self.reason == *other
    }
}

struct SupportRuntimeCleanupInner {
    runtime: Arc<ProcessRuntime>,
    run_directory: Arc<PrivateRunDirectory>,
    converged: AtomicBool,
    defer_graceful_once: AtomicBool,
}

#[derive(Clone)]
pub(crate) struct SupportRuntimeCleanup {
    inner: Arc<SupportRuntimeCleanupInner>,
}

impl SupportRuntimeCleanup {
    pub(super) fn new(
        runtime: Arc<ProcessRuntime>,
        run_directory: Arc<PrivateRunDirectory>,
        defer_graceful_once: bool,
    ) -> Self {
        Self {
            inner: Arc::new(SupportRuntimeCleanupInner {
                runtime,
                run_directory,
                converged: AtomicBool::new(false),
                defer_graceful_once: AtomicBool::new(defer_graceful_once),
            }),
        }
    }

    pub(crate) fn cleanup_converged(&self) -> bool {
        self.inner.converged.load(Ordering::Acquire)
    }

    pub(crate) async fn shutdown(&self) -> Result<(), SupportRuntimeError> {
        if self.cleanup_converged() {
            return Ok(());
        }
        if self.inner.defer_graceful_once.swap(false, Ordering::AcqRel) {
            return Err(SupportRuntimeError::Process);
        }
        let process = self
            .inner
            .runtime
            .shutdown_checked()
            .await
            .map_err(|_| SupportRuntimeError::Process);
        let directory = self.inner.run_directory.cleanup();
        self.finish_cleanup(process, directory)
    }

    pub(crate) async fn force_shutdown_now(&self) -> bool {
        if self.cleanup_converged() {
            return true;
        }
        let process = self
            .inner
            .runtime
            .force_shutdown_and_wait(SUPPORT_CONSTRUCTION_FORCE_WAIT)
            .await;
        let directory = self.inner.run_directory.cleanup().is_ok();
        let converged = process && directory;
        if converged {
            self.inner.converged.store(true, Ordering::Release);
        }
        converged
    }

    fn finish_cleanup(
        &self,
        process: Result<(), SupportRuntimeError>,
        directory: Result<(), SupportRuntimeError>,
    ) -> Result<(), SupportRuntimeError> {
        match (process, directory) {
            (Ok(()), Ok(())) => {
                self.inner.converged.store(true, Ordering::Release);
                Ok(())
            }
            (Err(error), _) | (_, Err(error)) => Err(error),
        }
    }

    pub(crate) fn signal_force_now(&self) {
        self.inner.runtime.force_shutdown_now();
    }

    pub(crate) fn same_identity(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.inner, &other.inner)
    }

    fn runtime(&self) -> &Arc<ProcessRuntime> {
        &self.inner.runtime
    }

    fn run_directory(&self) -> &PrivateRunDirectory {
        &self.inner.run_directory
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SupportConstructionPhase {
    Idle,
    Constructing,
    Ready,
    Released,
    Finished,
}

struct SupportConstructionState {
    phase: SupportConstructionPhase,
    active_cleanup: Option<SupportRuntimeCleanup>,
}

struct SupportConstructionControlInner {
    cancel_requested: AtomicBool,
    force_requested: AtomicBool,
    state: StdMutex<SupportConstructionState>,
    changed: Notify,
}

/// Owns construction cancellation and every process spawned before runtime handoff.
#[derive(Clone)]
pub(crate) struct SupportConstructionControl {
    inner: Arc<SupportConstructionControlInner>,
}

impl Default for SupportConstructionControl {
    fn default() -> Self {
        Self::new()
    }
}

impl SupportConstructionControl {
    pub(crate) fn new() -> Self {
        Self {
            inner: Arc::new(SupportConstructionControlInner {
                cancel_requested: AtomicBool::new(false),
                force_requested: AtomicBool::new(false),
                state: StdMutex::new(SupportConstructionState {
                    phase: SupportConstructionPhase::Idle,
                    active_cleanup: None,
                }),
                changed: Notify::new(),
            }),
        }
    }

    pub(crate) async fn cancel(&self) -> bool {
        let deadline = tokio::time::Instant::now() + SUPPORT_CONSTRUCTION_CANCEL_BUDGET;
        let (phase, cleanup) = self.request_shutdown(false);
        if let Some(cleanup) = cleanup.as_ref() {
            let converged = self.cleanup_with_requested_policy(cleanup).await;
            if phase == SupportConstructionPhase::Ready {
                self.finish_ready_cleanup(cleanup, converged);
            }
        }
        let terminal = self.wait_for_terminal(deadline).await;
        terminal && self.active_cleanup_converged()
    }

    pub(crate) async fn force_shutdown_now(&self) -> bool {
        let deadline = tokio::time::Instant::now() + SUPPORT_CONSTRUCTION_FORCE_BUDGET;
        let (phase, cleanup) = self.request_shutdown(true);
        let mut converged = cleanup.is_none();
        if let Some(cleanup) = cleanup.as_ref() {
            cleanup.signal_force_now();
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            converged = tokio::time::timeout(remaining, cleanup.force_shutdown_now())
                .await
                .unwrap_or(false);
            if phase == SupportConstructionPhase::Ready {
                self.finish_ready_cleanup(cleanup, converged);
            }
        }
        let terminal = self.wait_for_terminal(deadline).await;
        converged && terminal && self.active_cleanup_converged()
    }

    pub(crate) fn begin(&self) -> Result<(), SupportRuntimeError> {
        let mut state = self.lock_state();
        if self.cancel_requested() {
            state.phase = SupportConstructionPhase::Finished;
            drop(state);
            self.inner.changed.notify_waiters();
            return Err(SupportRuntimeError::Canceled);
        }
        if state.phase != SupportConstructionPhase::Idle {
            return Err(SupportRuntimeError::Process);
        }
        state.phase = SupportConstructionPhase::Constructing;
        Ok(())
    }

    pub(crate) async fn run_stage<F, T>(&self, stage: F) -> Result<T, SupportRuntimeError>
    where
        F: Future<Output = Result<T, SupportRuntimeError>>,
    {
        if self.cancel_requested() {
            return Err(SupportRuntimeError::Canceled);
        }
        tokio::select! {
            biased;
            _ = self.wait_for_cancel_request() => Err(SupportRuntimeError::Canceled),
            result = stage => result,
        }
    }

    pub(crate) fn register_cleanup(
        &self,
        cleanup: SupportRuntimeCleanup,
    ) -> Result<(), SupportRuntimeError> {
        let mut state = self.lock_state();
        if state.phase != SupportConstructionPhase::Constructing || state.active_cleanup.is_some() {
            return Err(SupportRuntimeError::Process);
        }
        state.active_cleanup = Some(cleanup);
        if self.cancel_requested() {
            Err(SupportRuntimeError::Canceled)
        } else {
            Ok(())
        }
    }

    pub(crate) fn unregister_cleanup(
        &self,
        cleanup: &SupportRuntimeCleanup,
    ) -> Result<(), SupportRuntimeError> {
        let mut state = self.lock_state();
        if !state
            .active_cleanup
            .as_ref()
            .is_some_and(|active| active.same_identity(cleanup))
        {
            return Err(SupportRuntimeError::Process);
        }
        state.active_cleanup = None;
        if self.cancel_requested() {
            Err(SupportRuntimeError::Canceled)
        } else {
            Ok(())
        }
    }

    fn mark_ready(&self, cleanup: &SupportRuntimeCleanup) -> Result<(), SupportRuntimeError> {
        let mut state = self.lock_state();
        if state.phase != SupportConstructionPhase::Constructing
            || !state
                .active_cleanup
                .as_ref()
                .is_some_and(|active| active.same_identity(cleanup))
        {
            return Err(SupportRuntimeError::Process);
        }
        if self.cancel_requested() {
            return Err(SupportRuntimeError::Canceled);
        }
        state.phase = SupportConstructionPhase::Ready;
        drop(state);
        self.inner.changed.notify_waiters();
        Ok(())
    }

    fn release(&self, cleanup: &SupportRuntimeCleanup) -> Result<(), SupportRuntimeError> {
        let mut state = self.lock_state();
        if self.cancel_requested() {
            return Err(SupportRuntimeError::Canceled);
        }
        if state.phase != SupportConstructionPhase::Ready
            || !state
                .active_cleanup
                .as_ref()
                .is_some_and(|active| active.same_identity(cleanup))
        {
            return Err(SupportRuntimeError::Process);
        }
        state.active_cleanup = None;
        state.phase = SupportConstructionPhase::Released;
        drop(state);
        self.inner.changed.notify_waiters();
        Ok(())
    }

    fn request_shutdown(
        &self,
        force: bool,
    ) -> (SupportConstructionPhase, Option<SupportRuntimeCleanup>) {
        if force {
            self.inner.force_requested.store(true, Ordering::Release);
        }
        self.inner.cancel_requested.store(true, Ordering::Release);
        let mut state = self.lock_state();
        if state.phase == SupportConstructionPhase::Idle {
            state.phase = SupportConstructionPhase::Finished;
        }
        let phase = state.phase;
        let cleanup = state.active_cleanup.clone();
        if force {
            if let Some(cleanup) = cleanup.as_ref() {
                cleanup.signal_force_now();
            }
        }
        drop(state);
        self.inner.changed.notify_waiters();
        (phase, cleanup)
    }

    fn request_force_without_waiting(&self) {
        let _ = self.request_shutdown(true);
    }

    async fn cleanup_with_requested_policy(&self, cleanup: &SupportRuntimeCleanup) -> bool {
        if self.force_requested() {
            cleanup.signal_force_now();
            return cleanup.force_shutdown_now().await;
        }
        match tokio::time::timeout(SUPPORT_CONSTRUCTION_GRACEFUL_TIMEOUT, cleanup.shutdown()).await
        {
            Ok(Ok(())) => true,
            Ok(Err(_)) | Err(_) => {
                cleanup.signal_force_now();
                cleanup.force_shutdown_now().await
            }
        }
    }

    async fn cleanup_after_failure(&self) -> (bool, Option<SupportRuntimeCleanup>) {
        let cleanup = self.lock_state().active_cleanup.clone();
        let Some(cleanup) = cleanup else {
            return (true, None);
        };
        let converged = if self.cancel_requested() {
            self.cleanup_with_requested_policy(&cleanup).await
        } else {
            cleanup.shutdown().await.is_ok()
        };
        (converged, Some(cleanup))
    }

    fn finish_ready_cleanup(&self, cleanup: &SupportRuntimeCleanup, converged: bool) {
        let mut state = self.lock_state();
        if state.phase == SupportConstructionPhase::Ready
            && state
                .active_cleanup
                .as_ref()
                .is_some_and(|active| active.same_identity(cleanup))
        {
            if converged {
                state.active_cleanup = None;
            }
            state.phase = SupportConstructionPhase::Finished;
        }
        drop(state);
        self.inner.changed.notify_waiters();
    }

    fn mark_finished(&self, cleanup_converged: bool) {
        let mut state = self.lock_state();
        if cleanup_converged {
            state.active_cleanup = None;
        }
        if state.phase != SupportConstructionPhase::Released {
            state.phase = SupportConstructionPhase::Finished;
        }
        drop(state);
        self.inner.changed.notify_waiters();
    }

    async fn wait_for_cancel_request(&self) {
        loop {
            let notified = self.inner.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.cancel_requested() {
                return;
            }
            notified.await;
        }
    }

    async fn wait_for_terminal(&self, deadline: tokio::time::Instant) -> bool {
        loop {
            let notified = self.inner.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if matches!(
                self.lock_state().phase,
                SupportConstructionPhase::Released | SupportConstructionPhase::Finished
            ) {
                return true;
            }
            if tokio::time::Instant::now() >= deadline
                || tokio::time::timeout_at(deadline, notified).await.is_err()
            {
                return false;
            }
        }
    }

    fn active_cleanup_converged(&self) -> bool {
        self.lock_state()
            .active_cleanup
            .as_ref()
            .is_none_or(SupportRuntimeCleanup::cleanup_converged)
    }

    fn cancel_requested(&self) -> bool {
        self.inner.cancel_requested.load(Ordering::Acquire)
    }

    fn force_requested(&self) -> bool {
        self.inner.force_requested.load(Ordering::Acquire)
    }

    fn lock_state(&self) -> std::sync::MutexGuard<'_, SupportConstructionState> {
        self.inner
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

pub(crate) struct SupportRuntimeConstructionLease {
    runtime: Option<Arc<SupportRuntime>>,
    control: SupportConstructionControl,
    released: bool,
}

impl SupportRuntimeConstructionLease {
    pub(crate) fn runtime(&self) -> Arc<SupportRuntime> {
        self.runtime
            .as_ref()
            .expect("construction lease must own its runtime")
            .clone()
    }

    pub(crate) fn release_after_registration(
        mut self,
    ) -> Result<Arc<SupportRuntime>, SupportRuntimeError> {
        let runtime = self.runtime.as_ref().ok_or(SupportRuntimeError::Process)?;
        self.control.release(&runtime.cleanup)?;
        self.released = true;
        self.runtime.take().ok_or(SupportRuntimeError::Process)
    }
}

impl Drop for SupportRuntimeConstructionLease {
    fn drop(&mut self) {
        if !self.released {
            self.control.request_force_without_waiting();
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
    cleanup: SupportRuntimeCleanup,
    signals: Mutex<mpsc::Receiver<RuntimeSignal>>,
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
    ) -> Result<Self, SupportRuntimeConstructionError> {
        Self::construct_compat(
            binary,
            schema,
            resource_directory,
            auth_source,
            SupportModelRole::CommitExplainer,
            false,
            false,
        )
        .await
    }

    pub async fn construct_presence(
        binary: &BinaryInfo,
        schema: &SchemaProbe,
        resource_directory: &Path,
        auth_source: Option<&Path>,
    ) -> Result<Self, SupportRuntimeConstructionError> {
        Self::construct_compat(
            binary,
            schema,
            resource_directory,
            auth_source,
            SupportModelRole::PresenceDirector,
            false,
            false,
        )
        .await
    }

    pub(crate) async fn construct_presence_controlled(
        binary: &BinaryInfo,
        schema: &SchemaProbe,
        resource_directory: &Path,
        auth_source: Option<&Path>,
        control: SupportConstructionControl,
    ) -> Result<SupportRuntimeConstructionLease, SupportRuntimeConstructionError> {
        Self::construct_controlled(
            binary,
            schema,
            resource_directory,
            auth_source,
            SupportModelRole::PresenceDirector,
            false,
            false,
            control,
        )
        .await
    }

    #[cfg(debug_assertions)]
    #[doc(hidden)]
    pub async fn construct_with_test_faults(
        binary: &BinaryInfo,
        schema: &SchemaProbe,
        resource_directory: &Path,
        auth_source: Option<&Path>,
        inject_initialization_failure: bool,
        defer_graceful_cleanup_once: bool,
    ) -> Result<Self, SupportRuntimeConstructionError> {
        if binary.source != super::types::BinarySource::TestFixture {
            return Err(SupportRuntimeError::UnsupportedRelease.into());
        }
        Self::construct_compat(
            binary,
            schema,
            resource_directory,
            auth_source,
            SupportModelRole::CommitExplainer,
            inject_initialization_failure,
            defer_graceful_cleanup_once,
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    async fn construct_compat(
        binary: &BinaryInfo,
        schema: &SchemaProbe,
        resource_directory: &Path,
        auth_source: Option<&Path>,
        model_role: SupportModelRole,
        inject_initialization_failure: bool,
        defer_graceful_cleanup_once: bool,
    ) -> Result<Self, SupportRuntimeConstructionError> {
        let control = SupportConstructionControl::new();
        let lease = Self::construct_controlled(
            binary,
            schema,
            resource_directory,
            auth_source,
            model_role,
            inject_initialization_failure,
            defer_graceful_cleanup_once,
            control,
        )
        .await?;
        let runtime = lease
            .release_after_registration()
            .map_err(SupportRuntimeConstructionError::clean)?;
        match Arc::try_unwrap(runtime) {
            Ok(runtime) => Ok(runtime),
            Err(runtime) => {
                let cleanup = runtime.cleanup.clone();
                drop(runtime);
                if cleanup.force_shutdown_now().await {
                    Err(SupportRuntimeConstructionError::clean(
                        SupportRuntimeError::Process,
                    ))
                } else {
                    Err(SupportRuntimeConstructionError::unconverged(
                        SupportRuntimeError::Process,
                        cleanup,
                    ))
                }
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn construct_controlled(
        binary: &BinaryInfo,
        schema: &SchemaProbe,
        resource_directory: &Path,
        auth_source: Option<&Path>,
        model_role: SupportModelRole,
        inject_initialization_failure: bool,
        defer_graceful_cleanup_once: bool,
        control: SupportConstructionControl,
    ) -> Result<SupportRuntimeConstructionLease, SupportRuntimeConstructionError> {
        control
            .begin()
            .map_err(SupportRuntimeConstructionError::clean)?;
        let construction = control
            .run_stage(Self::construct_inner_controlled(
                binary,
                schema,
                resource_directory,
                auth_source,
                model_role,
                inject_initialization_failure,
                defer_graceful_cleanup_once,
                &control,
            ))
            .await;
        match construction {
            Ok(runtime) => {
                if let Err(error) = control.mark_ready(&runtime.cleanup) {
                    let construction_error =
                        Self::finish_controlled_construction_failure(&control, error).await;
                    drop(runtime);
                    return Err(construction_error);
                }
                Ok(SupportRuntimeConstructionLease {
                    runtime: Some(Arc::new(runtime)),
                    control,
                    released: false,
                })
            }
            Err(error) => Err(Self::finish_controlled_construction_failure(&control, error).await),
        }
    }

    async fn finish_controlled_construction_failure(
        control: &SupportConstructionControl,
        error: SupportRuntimeError,
    ) -> SupportRuntimeConstructionError {
        let (converged, cleanup) = control.cleanup_after_failure().await;
        control.mark_finished(converged);
        match (converged, cleanup) {
            (true, _) | (false, None) => SupportRuntimeConstructionError::clean(error),
            (false, Some(cleanup)) => SupportRuntimeConstructionError::unconverged(error, cleanup),
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn construct_inner_controlled(
        binary: &BinaryInfo,
        schema: &SchemaProbe,
        resource_directory: &Path,
        auth_source: Option<&Path>,
        model_role: SupportModelRole,
        inject_initialization_failure: bool,
        defer_graceful_cleanup_once: bool,
        control: &SupportConstructionControl,
    ) -> Result<Self, SupportRuntimeError> {
        verify_release(binary, schema).await?;
        let skill_name = match model_role {
            SupportModelRole::CommitExplainer => EXPLAIN_COMMIT_SKILL_NAME,
            SupportModelRole::PresenceDirector => DIRECT_PRESENCE_SKILL_NAME,
        };
        let verified_skill = resolve_bundled_skill(resource_directory, skill_name)
            .map_err(|_| SupportRuntimeError::Skill)?;
        run_isolation_probe_controlled(binary, &verified_skill, model_role, control).await?;

        let run_directory = PrivateRunDirectory::create("runtime")?;
        let skill = run_directory.snapshot_support_skill(&verified_skill)?;
        let auth_source = auth_source
            .map(Path::to_path_buf)
            .or_else(default_auth_source)
            .ok_or(SupportRuntimeError::AuthBridge)?;
        bridge_auth(&auth_source, &run_directory.codex_home)?;
        run_directory.write_config(&support_config(model_role.exact_model(), None))?;
        let run_directory = Arc::new(run_directory);

        let (signals, receiver) = mpsc::channel(SUPPORT_SIGNAL_QUEUE_CAPACITY);
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
        let cleanup = SupportRuntimeCleanup::new(
            runtime.clone(),
            run_directory.clone(),
            defer_graceful_cleanup_once,
        );
        control.register_cleanup(cleanup.clone())?;
        let thread = async {
            if inject_initialization_failure {
                return Err(SupportRuntimeError::Protocol);
            }
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
                        model_role.exact_model(),
                        Some("openai"),
                    ),
                    Duration::from_secs(5),
                )
                .await
                .map_err(map_rpc_error)?;
            let thread = parse_support_thread_policy_response(
                &thread,
                &run_directory.workspace,
                model_role.exact_model(),
                Some("openai"),
            )
            .map_err(|_| SupportRuntimeError::Policy)?;
            if runtime.execution_class() != TurnExecutionClass::Support {
                return Err(SupportRuntimeError::Policy);
            }
            Ok(thread)
        }
        .await;
        let thread = thread?;

        Ok(Self {
            cleanup,
            signals: Mutex::new(receiver),
            thread_id: thread.thread_id,
            audit: SupportIsolationAudit {
                capacity: SUPPORT_MAX_SESSION_CAPACITY,
                execution_class: TurnExecutionClass::Support,
                model_role,
                model: model_role.exact_model().to_owned(),
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
        if self.audit.model_role != SupportModelRole::CommitExplainer {
            return Err(self.terminal_failure(SupportRuntimeError::Policy).await);
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
        let params = match support_turn_start_params(
            &self.thread_id,
            &self.cleanup.run_directory().workspace,
            &request.request_id,
            &input,
            &request.evidence.locale,
            CODEX_COMMIT_EXPLAINER_MODEL,
            &self.skill,
        ) {
            Ok(params) => params,
            Err(_) => return Err(self.terminal_failure(SupportRuntimeError::Skill).await),
        };
        if self.used.swap(true, Ordering::AcqRel) {
            return Err(SupportRuntimeError::AlreadyUsed);
        }
        if self.cancel_requested.load(Ordering::Acquire) {
            return Err(self.terminal_failure(SupportRuntimeError::Canceled).await);
        }
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
        let turn = match self
            .cleanup
            .runtime()
            .connection
            .request("turn/start", params, SUPPORT_TASK_TIMEOUT)
            .await
        {
            Ok(turn) => turn,
            Err(error) => {
                let error = if canceled.load(Ordering::Acquire) {
                    SupportRuntimeError::Canceled
                } else {
                    map_rpc_error(error)
                };
                return Err(self.terminal_failure(error).await);
            }
        };
        let Some(turn_id) = turn
            .pointer("/turn/id")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty() && value.len() <= 256)
            .map(str::to_owned)
        else {
            return Err(self.terminal_failure(SupportRuntimeError::Protocol).await);
        };
        let turn_was_addressed = {
            let mut active = self.active.lock().await;
            active.as_mut().is_some_and(|active| {
                active.turn_id = Some(turn_id.clone());
                true
            })
        };
        if !turn_was_addressed {
            return Err(self.terminal_failure(SupportRuntimeError::Protocol).await);
        }
        if canceled.load(Ordering::Acquire) {
            let _ = self.interrupt(&self.thread_id, &turn_id).await;
            return Err(self.terminal_failure(SupportRuntimeError::Canceled).await);
        }

        let remaining = SUPPORT_TASK_TIMEOUT.saturating_sub(started.elapsed());
        let terminal = self
            .wait_for_turn(&self.thread_id, &turn_id, remaining)
            .await;
        let terminal = match terminal {
            Ok(terminal) => terminal,
            Err(error) => {
                let _ = self.interrupt(&self.thread_id, &turn_id).await;
                let error = if canceled.load(Ordering::Acquire) {
                    SupportRuntimeError::Canceled
                } else {
                    error
                };
                return Err(self.terminal_failure(error).await);
            }
        };
        if canceled.load(Ordering::Acquire) || terminal.status == "interrupted" {
            return Err(self.terminal_failure(SupportRuntimeError::Canceled).await);
        }
        if terminal.status != "completed" {
            return Err(self.terminal_failure(SupportRuntimeError::Protocol).await);
        }
        let Some(text) = terminal.agent_message else {
            return Err(self.terminal_failure(SupportRuntimeError::Output).await);
        };
        let explanation = match parse_explanation(&text, &request.evidence.locale) {
            Ok(explanation) => explanation,
            Err(error) => return Err(self.terminal_failure(error).await),
        };
        let result = SupportExplainResult {
            request_id: request.request_id,
            explanation,
            usage: terminal.usage,
            latency_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
        };
        self.shutdown_and_cleanup().await?;
        *self.active.lock().await = None;
        Ok(result)
    }

    pub async fn direct_presence(
        &self,
        request: SupportPresenceRequest,
    ) -> Result<SupportPresenceResult, SupportRuntimeError> {
        if self.audit.model_role != SupportModelRole::PresenceDirector {
            return Err(self.terminal_failure(SupportRuntimeError::Policy).await);
        }
        if self.cancel_requested.load(Ordering::Acquire) {
            return Err(SupportRuntimeError::Canceled);
        }
        validate_presence_request(&request)?;
        let input = serde_json::to_vec(&request.input).map_err(|_| SupportRuntimeError::Output)?;
        if input.len() > MAX_SUPPORT_INPUT_BYTES {
            return Err(SupportRuntimeError::Output);
        }
        let input = String::from_utf8(input).map_err(|_| SupportRuntimeError::Output)?;
        let params = match presence_turn_start_params(
            &self.thread_id,
            &self.cleanup.run_directory().workspace,
            &request.request_id,
            &input,
            request.input.locale.as_str(),
            &self.skill,
        ) {
            Ok(params) => params,
            Err(_) => return Err(self.terminal_failure(SupportRuntimeError::Skill).await),
        };
        if self.used.swap(true, Ordering::AcqRel) {
            return Err(SupportRuntimeError::AlreadyUsed);
        }
        if self.cancel_requested.load(Ordering::Acquire) {
            return Err(self.terminal_failure(SupportRuntimeError::Canceled).await);
        }
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
        let turn = match self
            .cleanup
            .runtime()
            .connection
            .request("turn/start", params, SUPPORT_TASK_TIMEOUT)
            .await
        {
            Ok(turn) => turn,
            Err(error) => {
                let error = if canceled.load(Ordering::Acquire) {
                    SupportRuntimeError::Canceled
                } else {
                    map_rpc_error(error)
                };
                return Err(self.terminal_failure(error).await);
            }
        };
        let Some(turn_id) = turn
            .pointer("/turn/id")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty() && value.len() <= 256)
            .map(str::to_owned)
        else {
            return Err(self.terminal_failure(SupportRuntimeError::Protocol).await);
        };
        let turn_was_addressed = {
            let mut active = self.active.lock().await;
            active.as_mut().is_some_and(|active| {
                active.turn_id = Some(turn_id.clone());
                true
            })
        };
        if !turn_was_addressed {
            return Err(self.terminal_failure(SupportRuntimeError::Protocol).await);
        }
        if canceled.load(Ordering::Acquire) {
            let _ = self.interrupt(&self.thread_id, &turn_id).await;
            return Err(self.terminal_failure(SupportRuntimeError::Canceled).await);
        }

        let remaining = SUPPORT_TASK_TIMEOUT.saturating_sub(started.elapsed());
        let terminal = self
            .wait_for_turn(&self.thread_id, &turn_id, remaining)
            .await;
        let terminal = match terminal {
            Ok(terminal) => terminal,
            Err(error) => {
                let _ = self.interrupt(&self.thread_id, &turn_id).await;
                let error = if canceled.load(Ordering::Acquire) {
                    SupportRuntimeError::Canceled
                } else {
                    error
                };
                return Err(self.terminal_failure(error).await);
            }
        };
        if canceled.load(Ordering::Acquire) || terminal.status == "interrupted" {
            return Err(self.terminal_failure(SupportRuntimeError::Canceled).await);
        }
        if terminal.status != "completed" {
            return Err(self.terminal_failure(SupportRuntimeError::Protocol).await);
        }
        let Some(text) = terminal.agent_message else {
            return Err(self.terminal_failure(SupportRuntimeError::Output).await);
        };
        let direction = match parse_presence_direction(&text, &request.input) {
            Ok(direction) => direction,
            Err(error) => return Err(self.terminal_failure(error).await),
        };
        let result = SupportPresenceResult {
            direction,
            usage: terminal.usage,
            latency_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
        };
        self.shutdown_and_cleanup().await?;
        *self.active.lock().await = None;
        Ok(result)
    }

    pub async fn cancel(&self) -> Result<bool, SupportRuntimeError> {
        self.cancel_requested.store(true, Ordering::Release);
        let active = self.active.lock().await.clone();
        let Some(active) = active else {
            return Ok(self.used.load(Ordering::Acquire));
        };
        active.canceled.store(true, Ordering::Release);
        if let Some(turn_id) = active.turn_id {
            let _ = self.interrupt(&active.thread_id, &turn_id).await;
        }
        self.terminate_and_cleanup().await?;
        *self.active.lock().await = None;
        Ok(true)
    }

    async fn terminal_failure(&self, error: SupportRuntimeError) -> SupportRuntimeError {
        match self.terminate_and_cleanup().await {
            Ok(()) => {
                *self.active.lock().await = None;
                error
            }
            Err(terminal_error) => terminal_error,
        }
    }

    async fn terminate_and_cleanup(&self) -> Result<(), SupportRuntimeError> {
        self.cleanup
            .runtime()
            .terminate_checked()
            .await
            .map_err(|_| SupportRuntimeError::Process)?;
        self.cleanup.run_directory().cleanup()
    }

    async fn shutdown_and_cleanup(&self) -> Result<(), SupportRuntimeError> {
        self.cleanup.shutdown().await
    }

    async fn interrupt(&self, thread_id: &str, turn_id: &str) -> Result<(), SupportRuntimeError> {
        self.cleanup
            .runtime()
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
        let mut output_budget = SupportOutputBudget::default();
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
                        let _ = self.cleanup.runtime().connection.send(server_error(
                            &id,
                            -32601,
                            "Support runtime rejects server requests",
                        ));
                        return Err(SupportRuntimeError::Policy);
                    }
                    InboundMessage::Notification {
                        method,
                        params,
                        byte_count,
                    } => {
                        output_budget.observe_notification(&method, &params, byte_count)?;
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
                            "thread/settings/updated" => {
                                validate_support_thread_settings_notification(
                                    &params,
                                    thread_id,
                                    &self.cleanup.run_directory().workspace,
                                    &self.audit.model,
                                    Some("openai"),
                                )
                                .map_err(|_| SupportRuntimeError::Policy)?;
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
                            _ => return Err(SupportRuntimeError::Policy),
                        }
                    }
                    InboundMessage::Response { .. } => return Err(SupportRuntimeError::Protocol),
                },
            }
        }
    }

    pub async fn shutdown(&self) -> Result<(), SupportRuntimeError> {
        self.shutdown_and_cleanup().await
    }

    pub async fn force_shutdown_now(&self) -> Result<(), SupportRuntimeError> {
        self.cancel_requested.store(true, Ordering::Release);
        if let Ok(active) = self.active.try_lock() {
            if let Some(active) = active.as_ref() {
                active.canceled.store(true, Ordering::Release);
            }
        }
        self.cleanup
            .force_shutdown_now()
            .await
            .then_some(())
            .ok_or(SupportRuntimeError::Process)
    }
}

impl Drop for SupportRuntime {
    fn drop(&mut self) {
        self.cleanup.runtime().force_shutdown_now();
    }
}

struct TerminalTurn {
    status: String,
    agent_message: Option<String>,
    usage: SupportUsage,
}

#[derive(Default)]
struct SupportOutputBudget {
    notification_events: usize,
    notification_bytes: usize,
    agent_delta_bytes: usize,
    reasoning_bytes: usize,
}

impl SupportOutputBudget {
    fn observe_notification(
        &mut self,
        method: &str,
        params: &Value,
        byte_count: usize,
    ) -> Result<(), SupportRuntimeError> {
        if byte_count > SUPPORT_MAX_FRAME_BYTES {
            return Err(SupportRuntimeError::Output);
        }
        let notification_events =
            bounded_sum(self.notification_events, 1, MAX_SUPPORT_NOTIFICATION_EVENTS)?;
        let notification_bytes = bounded_sum(
            self.notification_bytes,
            byte_count,
            MAX_SUPPORT_NOTIFICATION_BYTES,
        )?;
        let delta_bytes = if method == "item/agentMessage/delta" {
            params
                .get("delta")
                .and_then(Value::as_str)
                .map_or(0, |delta| delta.len())
        } else {
            0
        };
        let agent_delta_bytes = bounded_sum(
            self.agent_delta_bytes,
            delta_bytes,
            MAX_SUPPORT_AGENT_DELTA_BYTES,
        )?;
        let reasoning_frame_bytes = usize::from(method.starts_with("item/reasoning/"))
            .checked_mul(byte_count)
            .ok_or(SupportRuntimeError::Output)?;
        let reasoning_bytes = bounded_sum(
            self.reasoning_bytes,
            reasoning_frame_bytes,
            MAX_SUPPORT_REASONING_BYTES,
        )?;

        self.notification_events = notification_events;
        self.notification_bytes = notification_bytes;
        self.agent_delta_bytes = agent_delta_bytes;
        self.reasoning_bytes = reasoning_bytes;
        Ok(())
    }
}

fn bounded_sum(
    current: usize,
    addition: usize,
    maximum: usize,
) -> Result<usize, SupportRuntimeError> {
    current
        .checked_add(addition)
        .filter(|total| *total <= maximum)
        .ok_or(SupportRuntimeError::Output)
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
    if contains_private_public_material(value) {
        return true;
    }
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

pub(crate) fn presence_public_text_is_safe(value: &str) -> bool {
    static CODE_OR_DIFF: OnceLock<Regex> = OnceLock::new();
    static BARE_FILENAME: OnceLock<Regex> = OnceLock::new();
    static OPAQUE_TOKEN: OnceLock<Regex> = OnceLock::new();
    let code_or_diff = CODE_OR_DIFF.get_or_init(|| {
        Regex::new(
            r#"(?ix)
            (?:^|\s)(?:diff\s+--git|index\s+[a-f0-9]+\.\.[a-f0-9]+|@@(?:\s|$)|---\s|\+\+\+\s)
            |```|~~~
            |\b(?:fn|function|class|struct|enum|impl)\s+[a-z_$][a-z0-9_$]*\s*(?:\([^)]*\))?\s*\{
            |\b(?:const|let|var)\s+[a-z_$][a-z0-9_$]*\s*=
            |\b[a-z_$][a-z0-9_$]*\s*\([^)]*\)\s*=>
            |\bconsole\.log\s*\(
            |<\/?[a-z][^>]*>
            |(?:^|\s)[+-](?:return\b|\s*(?:fn|function|const|let|var|class)\b|\s*[{}])
            "#,
        )
        .expect("presence code and diff regex")
    });
    let bare_filename = BARE_FILENAME.get_or_init(|| {
        Regex::new(
            r"(?i)(?:^|[^a-z0-9_.@+-])(?:dockerfile|makefile|[a-z0-9_.@+-]+\.(?:rs|ts|tsx|js|jsx|json|toml|ya?ml|md|py|go|java|kt|swift|c|cc|cpp|h|hpp|css|scss|html|sh|zsh|fish|sql|pem|key|env|log))(?:$|[^a-z0-9_])",
        )
        .expect("presence bare filename regex")
    });
    let opaque_token = OPAQUE_TOKEN.get_or_init(|| {
        Regex::new(r"(?i)\b(?:[a-f0-9]{32,}|[a-z0-9_+=-]{40,})\b")
            .expect("presence opaque token regex")
    });
    let canonical = value.split_whitespace().collect::<Vec<_>>().join(" ");
    canonical == value
        && !value.is_empty()
        && !value.chars().any(char::is_control)
        && !value_contains_private_string(&Value::String(value.to_owned()))
        && !value.contains("<external>")
        && !code_or_diff.is_match(value)
        && !bare_filename.is_match(value)
        && !opaque_token.is_match(value)
}

fn value_contains_control_character(value: &Value) -> bool {
    match value {
        Value::String(value) => value.chars().any(char::is_control),
        Value::Array(values) => values.iter().any(value_contains_control_character),
        Value::Object(values) => values.values().any(value_contains_control_character),
        Value::Null | Value::Bool(_) | Value::Number(_) => false,
    }
}

fn valid_full_sha(value: &str) -> bool {
    matches!(value.len(), 40 | 64)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn validate_presence_request(request: &SupportPresenceRequest) -> Result<(), SupportRuntimeError> {
    let valid_identifier = |value: &str| {
        !value.is_empty()
            && value.len() <= 128
            && value.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b':' | b'.')
            })
    };
    if !valid_identifier(&request.request_id)
        || !valid_identifier(&request.workspace_id)
        || request.workspace_generation == 0
    {
        return Err(SupportRuntimeError::Output);
    }
    validate_presence_input(&request.input)
}

pub(crate) fn validate_presence_input(
    input: &PresenceDirectorInputV1,
) -> Result<(), SupportRuntimeError> {
    use PresenceElapsedBucket::{Seconds120Plus, Seconds45Plus};
    use PresenceSemanticState::{Asking, Error, Success, Warning, Working};
    use PresenceTrigger::{
        CommitReady, DecisionWait, LongMilestone, MainMessage, RecoverableFailure, TerminalFailure,
        TurnCompleted,
    };

    let valid_shape = match (
        input.trigger,
        input.semantic_state,
        input.retrying,
        input.elapsed_bucket,
    ) {
        (MainMessage, Working, false, PresenceElapsedBucket::None)
        | (DecisionWait, Asking, false, PresenceElapsedBucket::None)
        | (RecoverableFailure, Warning, _, PresenceElapsedBucket::None)
        | (TerminalFailure, Error, false, PresenceElapsedBucket::None)
        | (LongMilestone, Working, false, Seconds45Plus | Seconds120Plus)
        | (CommitReady | TurnCompleted, Success, false, PresenceElapsedBucket::None) => true,
        _ => false,
    };
    let valid_excerpt = match (input.trigger, input.message_excerpt.as_deref()) {
        (MainMessage, Some(excerpt)) => {
            excerpt.chars().count() <= 240 && presence_public_text_is_safe(excerpt)
        }
        (MainMessage, None) => false,
        (_, None) => true,
        (_, Some(_)) => false,
    };
    (input.schema_version == 1 && valid_shape && valid_excerpt)
        .then_some(())
        .ok_or(SupportRuntimeError::Output)
}

pub(crate) fn validate_presence_direction(
    direction: &PresenceDirectionV1,
    input: &PresenceDirectorInputV1,
) -> Result<(), SupportRuntimeError> {
    validate_presence_input(input)?;
    let serialized = serde_json::to_vec(direction).map_err(|_| SupportRuntimeError::Output)?;
    let public_value = serde_json::to_value(direction).map_err(|_| SupportRuntimeError::Output)?;
    if serialized.len() > MAX_SUPPORT_OUTPUT_BYTES
        || direction.schema_version != 1
        || direction.locale != input.locale
        || direction.utterance.is_empty()
        || direction.utterance.trim() != direction.utterance
        || direction.utterance.chars().count() > 160
        || value_contains_private_string(&public_value)
        || !presence_public_text_is_safe(&direction.utterance)
        || value_contains_control_character(&public_value)
        || !presence_cue_allowed(input.trigger, direction.cue)
    {
        return Err(SupportRuntimeError::Output);
    }
    Ok(())
}

fn presence_cue_allowed(trigger: PresenceTrigger, cue: PresenceCue) -> bool {
    use PresenceCue::{Asking, Error, Neutral, Success, Warning, Working};
    use PresenceTrigger::{
        CommitReady, DecisionWait, LongMilestone, MainMessage, RecoverableFailure, TerminalFailure,
        TurnCompleted,
    };

    matches!(
        (trigger, cue),
        (MainMessage, Working | Neutral)
            | (DecisionWait, Asking | Neutral)
            | (RecoverableFailure, Warning | Neutral)
            | (TerminalFailure, Error | Warning | Neutral)
            | (LongMilestone, Working | Neutral)
            | (CommitReady | TurnCompleted, Success | Neutral)
    )
}

pub(crate) fn parse_presence_direction(
    text: &str,
    input: &PresenceDirectorInputV1,
) -> Result<PresenceDirectionV1, SupportRuntimeError> {
    if text.len() > MAX_SUPPORT_OUTPUT_BYTES {
        return Err(SupportRuntimeError::Output);
    }
    let direction: PresenceDirectionV1 =
        serde_json::from_str(text).map_err(|_| SupportRuntimeError::Output)?;
    validate_presence_direction(&direction, input)?;
    Ok(direction)
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
    let serialized = serde_json::to_vec(&explanation).map_err(|_| SupportRuntimeError::Output)?;
    let public_value =
        serde_json::to_value(&explanation).map_err(|_| SupportRuntimeError::Output)?;
    if serialized.len() > MAX_SUPPORT_OUTPUT_BYTES
        || value_contains_private_string(&public_value)
        || value_contains_control_character(&public_value)
    {
        return Err(SupportRuntimeError::Output);
    }
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

    #[test]
    fn support_model_roles_have_distinct_exact_models() {
        assert_eq!(
            SupportModelRole::CommitExplainer.exact_model(),
            "gpt-5.6-terra"
        );
        assert_eq!(
            SupportModelRole::PresenceDirector.exact_model(),
            "gpt-5.6-luna"
        );
        assert_ne!(
            SupportModelRole::CommitExplainer.exact_model(),
            SupportModelRole::PresenceDirector.exact_model()
        );
    }

    fn presence_input(
        trigger: PresenceTrigger,
        semantic_state: PresenceSemanticState,
        retrying: bool,
        elapsed_bucket: PresenceElapsedBucket,
    ) -> PresenceDirectorInputV1 {
        PresenceDirectorInputV1 {
            schema_version: 1,
            locale: PresenceLocale::Ja,
            trigger,
            semantic_state,
            retrying,
            elapsed_bucket,
            message_excerpt: None,
        }
    }

    fn presence_direction(utterance: &str, cue: PresenceCue) -> PresenceDirectionV1 {
        PresenceDirectionV1 {
            schema_version: 1,
            locale: PresenceLocale::Ja,
            utterance: utterance.to_owned(),
            cue,
        }
    }

    fn main_message_input(excerpt: &str) -> PresenceDirectorInputV1 {
        let mut input = presence_input(
            PresenceTrigger::MainMessage,
            PresenceSemanticState::Working,
            false,
            PresenceElapsedBucket::None,
        );
        input.message_excerpt = Some(excerpt.to_owned());
        input
    }

    #[test]
    fn presence_input_serializes_only_the_six_pathless_fields() {
        let input = presence_input(
            PresenceTrigger::DecisionWait,
            PresenceSemanticState::Asking,
            false,
            PresenceElapsedBucket::None,
        );
        let value = serde_json::to_value(&input).expect("presence input");

        assert_eq!(
            value,
            json!({
                "schemaVersion": 1,
                "locale": "ja",
                "trigger": "decision_wait",
                "semanticState": "asking",
                "retrying": false,
                "elapsedBucket": "none"
            })
        );
        assert_eq!(value.as_object().map(serde_json::Map::len), Some(6));
        for forbidden in [
            "requestId",
            "workspaceId",
            "workspaceGeneration",
            "path",
            "text",
            "diff",
            "secret",
        ] {
            assert!(value.get(forbidden).is_none(), "included {forbidden}");
        }
    }

    #[test]
    fn main_message_input_serializes_only_the_bounded_excerpt_extension() {
        let value = serde_json::to_value(main_message_input("実装の要点を整理しました。"))
            .expect("main message input");

        assert_eq!(
            value,
            json!({
                "schemaVersion": 1,
                "locale": "ja",
                "trigger": "main_message",
                "semanticState": "working",
                "retrying": false,
                "elapsedBucket": "none",
                "messageExcerpt": "実装の要点を整理しました。"
            })
        );
    }

    #[test]
    fn presence_input_accepts_only_documented_trigger_state_combinations() {
        use PresenceElapsedBucket::{None, Seconds120Plus, Seconds45Plus};
        use PresenceSemanticState::{Asking, Error, Success, Warning, Working};
        use PresenceTrigger::{
            CommitReady, DecisionWait, LongMilestone, RecoverableFailure, TerminalFailure,
            TurnCompleted,
        };
        for input in [
            presence_input(DecisionWait, Asking, false, None),
            presence_input(RecoverableFailure, Warning, false, None),
            presence_input(RecoverableFailure, Warning, true, None),
            presence_input(TerminalFailure, Error, false, None),
            presence_input(LongMilestone, Working, false, Seconds45Plus),
            presence_input(LongMilestone, Working, false, Seconds120Plus),
            presence_input(CommitReady, Success, false, None),
            presence_input(TurnCompleted, Success, false, None),
        ] {
            validate_presence_input(&input).expect("documented presence input");
        }
        validate_presence_input(&main_message_input("次の確認点を整理しました。"))
            .expect("documented main message input");

        for input in [
            presence_input(DecisionWait, Asking, true, None),
            presence_input(DecisionWait, Working, false, None),
            presence_input(TerminalFailure, Error, true, None),
            presence_input(LongMilestone, Working, false, None),
            presence_input(CommitReady, Success, false, Seconds45Plus),
        ] {
            assert_eq!(
                validate_presence_input(&input),
                Err(SupportRuntimeError::Output)
            );
        }
        let mut wrong_version = presence_input(DecisionWait, Asking, false, None);
        wrong_version.schema_version = 2;
        assert_eq!(
            validate_presence_input(&wrong_version),
            Err(SupportRuntimeError::Output)
        );

        for unsafe_excerpt in [
            "二重  spaceは拒否します。",
            "改行\nは拒否します。",
            "```rust fn main() {} ```",
            "diff --git old new @@ -1 +1 @@ -return false; +return true;",
            "fn main() {}",
            "console.log('secret')",
            "<div>secret</div>",
            "README.md を確認しました。",
            "secret-config.yaml を確認しました。",
            "private.pem secret.key Dockerfile Makefile",
            "https://example.com を確認しました。",
            "token=credential-value を確認しました。",
        ] {
            assert_eq!(
                validate_presence_input(&main_message_input(unsafe_excerpt)),
                Err(SupportRuntimeError::Output),
                "accepted {unsafe_excerpt:?}"
            );
        }

        let mut excerpt_on_other_trigger = presence_input(DecisionWait, Asking, false, None);
        excerpt_on_other_trigger.message_excerpt = Some("許可しません。".to_owned());
        assert_eq!(
            validate_presence_input(&excerpt_on_other_trigger),
            Err(SupportRuntimeError::Output)
        );
    }

    #[test]
    fn presence_direction_parser_is_closed_locale_bound_private_and_cue_scoped() {
        let input = presence_input(
            PresenceTrigger::DecisionWait,
            PresenceSemanticState::Asking,
            false,
            PresenceElapsedBucket::None,
        );
        let valid = serde_json::to_string(&presence_direction(
            "確認が必要なところで待っています。",
            PresenceCue::Asking,
        ))
        .expect("valid presence direction");
        parse_presence_direction(&valid, &input).expect("valid presence direction");

        for invalid in [
            json!({
                "schemaVersion": 1,
                "locale": "ja",
                "utterance": "待っています。",
                "cue": "asking",
                "extra": true
            }),
            json!({
                "schemaVersion": 1,
                "locale": "en",
                "utterance": "Waiting for your decision.",
                "cue": "asking"
            }),
            json!({
                "schemaVersion": 1,
                "locale": "ja",
                "utterance": "x".repeat(161),
                "cue": "asking"
            }),
            json!({
                "schemaVersion": 1,
                "locale": "ja",
                "utterance": " 余白は許可しません。",
                "cue": "asking"
            }),
            json!({
                "schemaVersion": 1,
                "locale": "ja",
                "utterance": "制御\n文字は許可しません。",
                "cue": "asking"
            }),
            json!({
                "schemaVersion": 1,
                "locale": "ja",
                "utterance": "src/private.rs を確認しています。",
                "cue": "asking"
            }),
            json!({
                "schemaVersion": 1,
                "locale": "ja",
                "utterance": "https://example.com を確認しています。",
                "cue": "asking"
            }),
            json!({
                "schemaVersion": 1,
                "locale": "ja",
                "utterance": "README.md private.pem secret.key Dockerfile Makefile",
                "cue": "asking"
            }),
            json!({
                "schemaVersion": 1,
                "locale": "ja",
                "utterance": "diff --git old new @@ -1 +1 @@ -return false; +return true;",
                "cue": "asking"
            }),
            json!({
                "schemaVersion": 1,
                "locale": "ja",
                "utterance": "console.log('secret') <div>secret</div>",
                "cue": "asking"
            }),
            json!({
                "schemaVersion": 1,
                "locale": "ja",
                "utterance": "二重  spaceは拒否します。",
                "cue": "asking"
            }),
            json!({
                "schemaVersion": 1,
                "locale": "ja",
                "utterance": "待っています。",
                "cue": "success"
            }),
        ] {
            let text = serde_json::to_string(&invalid).expect("invalid direction fixture");
            assert_eq!(
                parse_presence_direction(&text, &input),
                Err(SupportRuntimeError::Output),
                "accepted {text}"
            );
        }
    }

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

    fn explanation_at_serialized_size(target: usize) -> String {
        let mut value: Value = serde_json::from_str(&explanation("ja")).expect("base explanation");
        for field in [
            "changes",
            "reasons",
            "verification",
            "impact",
            "cautions",
            "howToReadNext",
        ] {
            value[field] = Value::Array((0..16).map(|_| Value::String("x".to_owned())).collect());
        }
        let current = serde_json::to_vec(&value)
            .expect("base serialized explanation")
            .len();
        assert!(current <= target, "target must fit the base explanation");
        let mut remaining = target - current;
        for field in [
            "changes",
            "reasons",
            "verification",
            "impact",
            "cautions",
            "howToReadNext",
        ] {
            for index in 0..16 {
                let additional = remaining.min(2047);
                let text = value[field][index].as_str().expect("explanation text slot");
                value[field][index] = Value::String(format!("{text}{}", "x".repeat(additional)));
                remaining -= additional;
                if remaining == 0 {
                    break;
                }
            }
            if remaining == 0 {
                break;
            }
        }
        assert_eq!(remaining, 0, "target must fit the bounded text slots");
        let encoded = serde_json::to_string(&value).expect("sized explanation");
        assert_eq!(encoded.len(), target);
        encoded
    }

    #[test]
    fn support_output_budget_accepts_exact_boundaries_and_rejects_one_beyond() {
        let mut frame = SupportOutputBudget::default();
        assert_eq!(
            frame.observe_notification("warning", &json!({}), SUPPORT_MAX_FRAME_BYTES),
            Ok(())
        );
        let mut oversized_frame = SupportOutputBudget::default();
        assert_eq!(
            oversized_frame.observe_notification(
                "warning",
                &json!({}),
                SUPPORT_MAX_FRAME_BYTES + 1,
            ),
            Err(SupportRuntimeError::Output)
        );

        let mut events = SupportOutputBudget::default();
        for _ in 0..MAX_SUPPORT_NOTIFICATION_EVENTS {
            events
                .observe_notification("warning", &json!({}), 0)
                .expect("exact event boundary");
        }
        assert_eq!(
            events.observe_notification("warning", &json!({}), 0),
            Err(SupportRuntimeError::Output)
        );

        let mut notifications = SupportOutputBudget::default();
        let mut remaining = MAX_SUPPORT_NOTIFICATION_BYTES;
        while remaining > 0 {
            let frame_bytes = remaining.min(SUPPORT_MAX_FRAME_BYTES);
            notifications
                .observe_notification("warning", &json!({}), frame_bytes)
                .expect("exact notification byte boundary");
            remaining -= frame_bytes;
        }
        assert_eq!(
            notifications.observe_notification("warning", &json!({}), 1),
            Err(SupportRuntimeError::Output)
        );

        let mut deltas = SupportOutputBudget::default();
        for _ in 0..64 {
            deltas
                .observe_notification(
                    "item/agentMessage/delta",
                    &json!({"delta": "x".repeat(1024)}),
                    1024,
                )
                .expect("exact aggregate delta boundary");
        }
        assert_eq!(
            deltas.observe_notification("item/agentMessage/delta", &json!({"delta": "x"}), 1,),
            Err(SupportRuntimeError::Output)
        );

        let mut reasoning = SupportOutputBudget::default();
        for _ in 0..64 {
            reasoning
                .observe_notification("item/reasoning/textDelta", &json!({}), 1024)
                .expect("exact aggregate reasoning boundary");
        }
        assert_eq!(
            reasoning.observe_notification("item/reasoning/textDelta", &json!({}), 1),
            Err(SupportRuntimeError::Output)
        );
    }

    #[test]
    fn support_reader_and_queue_leave_bounded_json_envelope_headroom() {
        assert_eq!(MAX_SUPPORT_OUTPUT_BYTES, 64 * 1024);
        assert_eq!(SUPPORT_MAX_FRAME_BYTES, 96 * 1024);
        assert_eq!(SUPPORT_MAX_JSONL_BUFFER_BYTES, 128 * 1024);
        assert_eq!(SUPPORT_SIGNAL_QUEUE_CAPACITY, 8);
        assert_eq!(
            SUPPORT_MAX_FRAME_BYTES * SUPPORT_SIGNAL_QUEUE_CAPACITY,
            768 * 1024
        );
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
    fn strict_explanation_checks_private_material_and_controls_in_every_text_slot() {
        for pointer in [
            "/summary",
            "/changes/0",
            "/reasons/0",
            "/verification/0",
            "/impact/0",
            "/cautions/0",
            "/howToReadNext/0",
            "/narrationChunks/0/text",
        ] {
            for rejected in ["src/private.rs", "contains\0control"] {
                let mut value: Value =
                    serde_json::from_str(&explanation("ja")).expect("base explanation");
                *value
                    .pointer_mut(pointer)
                    .expect("terminal explanation text slot") = Value::String(rejected.to_owned());
                let encoded = serde_json::to_string(&value).expect("rejected explanation");
                assert_eq!(
                    parse_explanation(&encoded, "ja"),
                    Err(SupportRuntimeError::Output),
                    "accepted {rejected:?} at {pointer}"
                );
            }
        }

        for private in [
            "/\u{0055}sers/alice/repository/private.rs",
            "../private/config.json",
            "<workspace>/private.rs",
            "https://example.invalid/private",
            r"private\config.json",
            "Bearer abcdefghijklmnop",
            "[REDACTED]",
            "chain-of-thought",
        ] {
            let mut value: Value =
                serde_json::from_str(&explanation("ja")).expect("base explanation");
            value["summary"] = Value::String(private.to_owned());
            let encoded = serde_json::to_string(&value).expect("private explanation");
            assert_eq!(
                parse_explanation(&encoded, "ja"),
                Err(SupportRuntimeError::Output),
                "accepted {private:?}"
            );
        }
    }

    #[test]
    fn strict_explanation_accepts_only_the_exact_64_kib_serialized_boundary() {
        let exact = explanation_at_serialized_size(MAX_SUPPORT_OUTPUT_BYTES);
        assert_eq!(
            serde_json::to_vec(
                &serde_json::from_str::<CommitExplanationV1>(&exact)
                    .expect("exact explanation shape")
            )
            .expect("exact compact explanation")
            .len(),
            MAX_SUPPORT_OUTPUT_BYTES
        );
        parse_explanation(&exact, "ja").expect("exact serialized boundary");

        let over = format!("{exact} ");
        assert_eq!(over.len(), MAX_SUPPORT_OUTPUT_BYTES + 1);
        assert_eq!(
            parse_explanation(&over, "ja"),
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
