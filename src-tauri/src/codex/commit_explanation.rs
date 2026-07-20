//! App-owned commit explanation queue and isolated support-process boundary.
//!
//! This module intentionally has no dependency on the main Codex event stream or
//! workspace conversation history. Only bounded commit evidence crosses into the
//! single-use support runtime.

use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Weak};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::sync::{Mutex, Notify};

use crate::git_review::types::CommitEvidenceV1;

use super::bundled_skill::{
    resolve_bundled_skill, ResolvedBundledSkill, EXPLAIN_COMMIT_SKILL_NAME,
};
use super::supervisor::{CodexSupervisor, SupportReleaseIdentityEvidence};
use super::support::{
    CommitExplanationTrigger, CommitExplanationV1, SupportExplainRequest, SupportExplainResult,
    SupportRuntime, SupportRuntimeCleanup, SupportRuntimeError, SupportUsage, SUPPORT_TASK_TIMEOUT,
};
use super::support_control::{
    SupportAuditStore, SupportControlCommandError, SupportControlResult, SupportDurableAuditV1,
    SupportLatestOutcomeV1, SupportOutcomeStatus, SupportReadinessStatus,
    SupportReleaseReadinessV1, SupportSettingsStore, SupportSettingsV1, SupportUsageCountersV1,
    SUPPORT_MAX_QUEUE_CAPACITY, SUPPORT_MAX_SAFE_COUNTER,
};
use super::support_isolation::{
    SUPPORTED_ARM64_BINARY_SHA256, SUPPORTED_CLI_VERSION, SUPPORTED_EXPLAIN_SKILL_SHA256,
    SUPPORTED_EXPLAIN_SKILL_VERSION, SUPPORTED_SCHEMA_FINGERPRINT,
};
use super::types::CodexHealth;

pub const COMMIT_EXPLANATION_STATE_EVENT_CHANNEL: &str = "coding-wife://commit-explanation-state";
pub const COMMIT_EXPLANATION_PRESENTATION_EVENT_CHANNEL: &str =
    "coding-wife://commit-explanation-presentation";
pub const COMMIT_EXPLANATION_QUEUE_LIMIT: usize = SUPPORT_MAX_QUEUE_CAPACITY;
pub const COMMIT_EXPLANATION_CACHE_LIMIT: usize = 64;

const OPERATION_REQUEST: &str = "commit_explanation.request";
const OPERATION_CANCEL: &str = "commit_explanation.cancel";
const OPERATION_PRESENT: &str = "commit_explanation.present";
const OPERATION_STATE: &str = "commit_explanation.state";
const OPERATION_SCOPE: &str = "commit_explanation.scope";
const OPERATION_SHUTDOWN: &str = "commit_explanation.shutdown";
type ExplanationFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CommitExplanationControllerStatus {
    NotGenerated,
    Queued,
    Running,
    Generated,
    Failed,
    Unavailable,
    Canceled,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CommitExplanationPresentationMode {
    Show,
    ReplayNarration,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CommitExplanationCancelReason {
    User,
    SelectionChanged,
    WorkspaceChanged,
    RouteChanged,
    Superseded,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CommitExplanationRequestedV1 {
    pub schema_version: u16,
    pub request_id: String,
    pub workspace_id: String,
    pub workspace_generation: u64,
    pub commit_evidence_id: String,
    pub locale: String,
    pub selection_version: u64,
    pub trigger: CommitExplanationTrigger,
    pub requested_at: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CommitExplanationDispatchV1 {
    pub request: CommitExplanationRequestedV1,
    pub evidence: CommitEvidenceV1,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CommitExplanationCancelRequestedV1 {
    pub schema_version: u16,
    pub request_id: String,
    pub workspace_generation: u64,
    pub selection_version: u64,
    pub reason: CommitExplanationCancelReason,
    pub requested_at: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CommitExplanationPresentationRequestedV1 {
    pub schema_version: u16,
    pub workspace_id: String,
    pub workspace_generation: u64,
    pub commit_evidence_id: String,
    pub request_id: String,
    pub mode: CommitExplanationPresentationMode,
    pub requested_at: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CommitExplanationStateRequestedV1 {
    pub schema_version: u16,
    pub workspace_id: String,
    pub workspace_generation: u64,
    pub commit_evidence_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CommitExplanationScopeRequestedV1 {
    pub schema_version: u16,
    pub workspace_id: String,
    pub workspace_generation: u64,
    pub locale: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CommitExplanationControllerStateV1 {
    pub schema_version: u16,
    pub workspace_id: String,
    pub workspace_generation: u64,
    pub commit_evidence_id: String,
    pub request_id: Option<String>,
    pub locale: Option<String>,
    pub selection_version: Option<u64>,
    pub status: CommitExplanationControllerStatus,
    pub trigger: Option<CommitExplanationTrigger>,
    pub retryable: bool,
    pub presentation_available: bool,
    pub error_code: Option<String>,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CommitExplanationPresentationV1 {
    pub schema_version: u16,
    pub workspace_id: String,
    pub workspace_generation: u64,
    pub commit_evidence_id: String,
    pub request_id: String,
    pub selection_version: u64,
    pub trigger: CommitExplanationTrigger,
    pub locale: String,
    pub mode: CommitExplanationPresentationMode,
    pub explanation: CommitExplanationV1,
    pub usage: SupportUsage,
    pub latency_ms: u64,
    pub presented_at: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CommitExplanationControllerError {
    pub code: String,
    pub operation: String,
    pub recoverable: bool,
    pub user_message_key: String,
}

impl CommitExplanationControllerError {
    fn new(code: impl Into<String>, operation: &'static str, recoverable: bool) -> Self {
        Self {
            code: code.into(),
            operation: operation.to_owned(),
            recoverable,
            user_message_key: "gitReview.error.commitExplanation".to_owned(),
        }
    }
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct ExplanationKey {
    workspace_id: String,
    workspace_generation: u64,
    commit_evidence_id: String,
    locale: String,
}

impl ExplanationKey {
    fn from_request(request: &CommitExplanationRequestedV1) -> Self {
        Self {
            workspace_id: request.workspace_id.clone(),
            workspace_generation: request.workspace_generation,
            commit_evidence_id: request.commit_evidence_id.clone(),
            locale: request.locale.clone(),
        }
    }

    fn matches_state_request(&self, request: &CommitExplanationStateRequestedV1) -> bool {
        self.workspace_id == request.workspace_id
            && self.workspace_generation == request.workspace_generation
            && self.commit_evidence_id == request.commit_evidence_id
    }
}

#[derive(Clone)]
struct ExplanationTask {
    key: ExplanationKey,
    dispatch: CommitExplanationDispatchV1,
}

#[derive(Clone)]
struct ActiveTask {
    task: ExplanationTask,
    executor_request_id: String,
    canceled: Arc<AtomicBool>,
}

#[derive(Clone)]
struct CachedExplanation {
    request: CommitExplanationRequestedV1,
    result: SupportExplainResult,
}

#[derive(Default)]
struct ControllerData {
    active_scope: Option<CommitExplanationScopeRequestedV1>,
    generations: HashMap<String, u64>,
    states: HashMap<ExplanationKey, CommitExplanationControllerStateV1>,
    queue: VecDeque<ExplanationTask>,
    active: Option<ActiveTask>,
    worker_running: bool,
    worker_completion: Option<Arc<WorkerCompletion>>,
    shutting_down: bool,
    cache: HashMap<ExplanationKey, CachedExplanation>,
    cache_order: VecDeque<ExplanationKey>,
    settings: SupportSettingsV1,
    settings_recovery_code: Option<String>,
    usage: SupportUsageCountersV1,
    fallback_tasks: u64,
    latest_outcome: Option<SupportLatestOutcomeV1>,
    last_error_code: Option<String>,
    last_readiness: Option<SupportReleaseReadinessV1>,
}

trait CommitExplanationExecutor: Send + Sync {
    fn execute<'a>(
        &'a self,
        request: SupportExplainRequest,
        canceled: Arc<AtomicBool>,
    ) -> ExplanationFuture<'a, Result<SupportExplainResult, SupportRuntimeError>>;

    fn cancel<'a>(&'a self, request_id: &'a str) -> ExplanationFuture<'a, bool>;

    fn force_cleanup_now<'a>(&'a self) -> ExplanationFuture<'a, bool>;

    fn has_owned_executions<'a>(&'a self) -> ExplanationFuture<'a, bool>;

    fn shutdown<'a>(&'a self) -> ExplanationFuture<'a, bool>;

    fn force_shutdown_now<'a>(&'a self) -> ExplanationFuture<'a, bool>;
}

trait CommitExplanationEventSink: Send + Sync {
    fn emit_state(&self, state: &CommitExplanationControllerStateV1);
    fn emit_presentation(&self, presentation: &CommitExplanationPresentationV1);
}

trait SupportReadinessProvider: Send + Sync {
    fn snapshot<'a>(&'a self) -> ExplanationFuture<'a, SupportReleaseReadinessV1>;
}

#[derive(Clone)]
struct SupervisorSupportReadinessProvider {
    supervisor: CodexSupervisor,
    resource_directory: PathBuf,
}

impl SupportReadinessProvider for SupervisorSupportReadinessProvider {
    fn snapshot<'a>(&'a self) -> ExplanationFuture<'a, SupportReleaseReadinessV1> {
        Box::pin(async move {
            let evidence = self.supervisor.support_release_identity_evidence().await;
            let skill =
                resolve_bundled_skill(&self.resource_directory, EXPLAIN_COMMIT_SKILL_NAME).ok();
            evaluate_support_readiness(&evidence, skill.as_ref())
        })
    }
}

fn evaluate_support_readiness(
    evidence: &SupportReleaseIdentityEvidence,
    skill: Option<&ResolvedBundledSkill>,
) -> SupportReleaseReadinessV1 {
    let identity_matches = evidence.cli_version.as_deref() == Some(SUPPORTED_CLI_VERSION)
        && evidence.executable_sha256.as_deref() == Some(SUPPORTED_ARM64_BINARY_SHA256);
    let schema_matches = evidence.generated_by_same_binary
        && evidence.schema_fingerprint.as_deref() == Some(SUPPORTED_SCHEMA_FINGERPRINT);
    let skill_matches = skill.is_some_and(|value| {
        value.name == EXPLAIN_COMMIT_SKILL_NAME
            && value.version == SUPPORTED_EXPLAIN_SKILL_VERSION
            && value.content_digest == format!("sha256:{SUPPORTED_EXPLAIN_SKILL_SHA256}")
    });
    let has_observed_identity = evidence.cli_version.is_some()
        || evidence.executable_sha256.is_some()
        || evidence.schema_fingerprint.is_some();
    let status = if evidence.diagnostic.health == CodexHealth::Ready
        && identity_matches
        && schema_matches
        && skill_matches
    {
        SupportReadinessStatus::Approved
    } else if !has_observed_identity {
        SupportReadinessStatus::Unavailable
    } else {
        SupportReadinessStatus::Blocked
    };
    let reason_code = match status {
        SupportReadinessStatus::Approved => None,
        SupportReadinessStatus::Unavailable => Some("CODEX-SUPPORT-NOT-READY".to_owned()),
        SupportReadinessStatus::Blocked if !identity_matches => {
            Some("CODEX-SUPPORT-RELEASE-UNSUPPORTED".to_owned())
        }
        SupportReadinessStatus::Blocked if !schema_matches => {
            Some("CODEX-SUPPORT-SCHEMA-UNVERIFIED".to_owned())
        }
        SupportReadinessStatus::Blocked if !skill_matches => {
            Some("CODEX-SUPPORT-SKILL-INVALID".to_owned())
        }
        SupportReadinessStatus::Blocked => Some("CODEX-SUPPORT-NOT-READY".to_owned()),
    };
    let skill_digest = skill.map(|value| {
        value
            .content_digest
            .strip_prefix("sha256:")
            .unwrap_or(&value.content_digest)
    });
    SupportReleaseReadinessV1 {
        status,
        approved_cli_version: SUPPORTED_CLI_VERSION.to_owned(),
        approved_binary_hash_prefix: prefix16(SUPPORTED_ARM64_BINARY_SHA256),
        approved_schema_fingerprint_prefix: prefix16(SUPPORTED_SCHEMA_FINGERPRINT),
        observed_cli_version: evidence.cli_version.clone(),
        observed_binary_hash_prefix: evidence.executable_sha256.as_deref().map(prefix16),
        observed_schema_fingerprint_prefix: evidence.schema_fingerprint.as_deref().map(prefix16),
        skill_name: EXPLAIN_COMMIT_SKILL_NAME.to_owned(),
        skill_version: skill.map(|value| value.version.clone()),
        skill_digest_prefix: skill_digest.map(prefix16),
        reason_code,
        checked_at: now(),
    }
}

#[cfg(test)]
#[derive(Clone)]
struct ApprovedFixtureReadinessProvider;

#[cfg(test)]
impl SupportReadinessProvider for ApprovedFixtureReadinessProvider {
    fn snapshot<'a>(&'a self) -> ExplanationFuture<'a, SupportReleaseReadinessV1> {
        Box::pin(async move {
            SupportReleaseReadinessV1 {
                status: SupportReadinessStatus::Approved,
                approved_cli_version: SUPPORTED_CLI_VERSION.to_owned(),
                approved_binary_hash_prefix: prefix16(SUPPORTED_ARM64_BINARY_SHA256),
                approved_schema_fingerprint_prefix: prefix16(SUPPORTED_SCHEMA_FINGERPRINT),
                observed_cli_version: Some(SUPPORTED_CLI_VERSION.to_owned()),
                observed_binary_hash_prefix: Some(prefix16(SUPPORTED_ARM64_BINARY_SHA256)),
                observed_schema_fingerprint_prefix: Some(prefix16(SUPPORTED_SCHEMA_FINGERPRINT)),
                skill_name: EXPLAIN_COMMIT_SKILL_NAME.to_owned(),
                skill_version: Some("fixture".to_owned()),
                skill_digest_prefix: Some("0000000000000000".to_owned()),
                reason_code: None,
                checked_at: now(),
            }
        })
    }
}

struct TauriCommitExplanationEventSink {
    app_handle: AppHandle,
}

impl CommitExplanationEventSink for TauriCommitExplanationEventSink {
    fn emit_state(&self, state: &CommitExplanationControllerStateV1) {
        let _ = self
            .app_handle
            .emit(COMMIT_EXPLANATION_STATE_EVENT_CHANNEL, state);
    }

    fn emit_presentation(&self, presentation: &CommitExplanationPresentationV1) {
        let _ = self
            .app_handle
            .emit(COMMIT_EXPLANATION_PRESENTATION_EVENT_CHANNEL, presentation);
    }
}

#[derive(Clone)]
struct IsolatedSupportExecutor {
    supervisor: CodexSupervisor,
    active: Arc<Mutex<HashMap<(String, u64), SupportExecution>>>,
    next_generation: Arc<AtomicU64>,
    shutting_down: Arc<AtomicBool>,
}

#[derive(Clone)]
struct SupportExecution {
    generation: u64,
    canceled: Arc<AtomicBool>,
    force_requested: Arc<AtomicBool>,
    phase: SupportExecutionPhase,
    task: Arc<Mutex<Option<tokio::task::AbortHandle>>>,
    completion: Arc<SupportExecutionCompletion>,
}

#[derive(Clone)]
enum SupportExecutionPhase {
    Constructing,
    Running(Arc<SupportRuntime>),
    Unconverged(Arc<dyn SupportExecutionCleanup>),
    Terminal,
}

#[derive(Clone)]
struct SupportExecutionOutcome {
    result: Result<SupportExplainResult, SupportRuntimeError>,
    cleanup_converged: bool,
    pending_cleanup: Option<Arc<dyn SupportExecutionCleanup>>,
}

trait SupportExecutionCleanup: Send + Sync {
    fn shutdown<'a>(&'a self) -> ExplanationFuture<'a, bool>;
    fn force_shutdown_now<'a>(&'a self) -> ExplanationFuture<'a, bool>;
}

impl SupportExecutionCleanup for SupportRuntime {
    fn shutdown<'a>(&'a self) -> ExplanationFuture<'a, bool> {
        Box::pin(async move { SupportRuntime::shutdown(self).await.is_ok() })
    }

    fn force_shutdown_now<'a>(&'a self) -> ExplanationFuture<'a, bool> {
        Box::pin(async move { SupportRuntime::force_shutdown_now(self).await.is_ok() })
    }
}

impl SupportExecutionCleanup for SupportRuntimeCleanup {
    fn shutdown<'a>(&'a self) -> ExplanationFuture<'a, bool> {
        Box::pin(async move { SupportRuntimeCleanup::shutdown(self).await.is_ok() })
    }

    fn force_shutdown_now<'a>(&'a self) -> ExplanationFuture<'a, bool> {
        Box::pin(async move { SupportRuntimeCleanup::force_shutdown_now(self).await })
    }
}

#[derive(Default)]
struct SupportExecutionCompletion {
    outcome: Mutex<Option<SupportExecutionOutcome>>,
    notify: Notify,
}

impl SupportExecutionCompletion {
    async fn finish(&self, outcome: SupportExecutionOutcome) {
        *self.outcome.lock().await = Some(outcome);
        self.notify.notify_waiters();
    }

    async fn wait(&self) -> SupportExecutionOutcome {
        loop {
            let notified = self.notify.notified();
            if let Some(outcome) = self.outcome.lock().await.clone() {
                return outcome;
            }
            notified.await;
        }
    }
}

#[derive(Default)]
struct WorkerCompletion {
    done: AtomicBool,
    notify: Notify,
}

impl WorkerCompletion {
    fn finish(&self) {
        self.done.store(true, Ordering::Release);
        self.notify.notify_waiters();
    }

    async fn wait(&self) {
        loop {
            let notified = self.notify.notified();
            if self.done.load(Ordering::Acquire) {
                return;
            }
            notified.await;
        }
    }
}

struct WorkerCompletionGuard(Arc<WorkerCompletion>);

impl Drop for WorkerCompletionGuard {
    fn drop(&mut self) {
        self.0.finish();
    }
}

impl IsolatedSupportExecutor {
    fn new(supervisor: CodexSupervisor) -> Self {
        Self {
            supervisor,
            active: Arc::new(Mutex::new(HashMap::new())),
            next_generation: Arc::new(AtomicU64::new(1)),
            shutting_down: Arc::new(AtomicBool::new(false)),
        }
    }

    async fn run_owned(
        self,
        request: SupportExplainRequest,
        canceled: Arc<AtomicBool>,
        force_requested: Arc<AtomicBool>,
        generation: u64,
    ) -> SupportExecutionOutcome {
        let request_id = request.request_id.clone();
        let key = (request_id.clone(), generation);
        let Some(context) = self
            .supervisor
            .support_runtime_context(&request.workspace_id, request.evidence.workspace_generation)
            .await
        else {
            return SupportExecutionOutcome {
                result: Err(SupportRuntimeError::UnsupportedRelease),
                cleanup_converged: true,
                pending_cleanup: None,
            };
        };
        if canceled.load(Ordering::Acquire) {
            return SupportExecutionOutcome {
                result: Err(SupportRuntimeError::Canceled),
                cleanup_converged: true,
                pending_cleanup: None,
            };
        }
        let runtime =
            match SupportRuntime::construct(&context.0, &context.1, &context.2, None).await {
                Ok(runtime) => Arc::new(runtime),
                Err(mut error) => {
                    let cleanup_converged = error.cleanup_converged();
                    let pending_cleanup = error
                        .take_pending_cleanup()
                        .map(|cleanup| Arc::new(cleanup) as Arc<dyn SupportExecutionCleanup>);
                    return SupportExecutionOutcome {
                        result: Err(error.reason()),
                        cleanup_converged,
                        pending_cleanup,
                    };
                }
            };
        let registered = {
            let mut active = self.active.lock().await;
            active.get_mut(&key).is_some_and(|execution| {
                execution.phase = SupportExecutionPhase::Running(runtime.clone());
                true
            })
        };
        if !registered {
            let cleanup_converged = runtime.force_shutdown_now().await.is_ok();
            return SupportExecutionOutcome {
                result: Err(SupportRuntimeError::Canceled),
                cleanup_converged,
                pending_cleanup: (!cleanup_converged)
                    .then_some(runtime as Arc<dyn SupportExecutionCleanup>),
            };
        }
        let result = if canceled.load(Ordering::Acquire) {
            if force_requested.load(Ordering::Acquire) {
                let _ = runtime.force_shutdown_now().await;
            } else {
                let _ = runtime.cancel().await;
            }
            Err(SupportRuntimeError::Canceled)
        } else {
            runtime.explain_commit(request).await
        };
        let cleanup = runtime.shutdown().await;
        let cleanup_converged = cleanup.is_ok();
        SupportExecutionOutcome {
            result: match (result, cleanup.as_ref()) {
                (Ok(result), Ok(())) => Ok(result),
                (Err(error), Ok(())) => Err(error),
                (_, Err(error)) => Err(*error),
            },
            cleanup_converged,
            pending_cleanup: (!cleanup_converged)
                .then_some(runtime as Arc<dyn SupportExecutionCleanup>),
        }
    }

    async fn stop_executions(&self, force: bool) -> bool {
        self.shutting_down.store(true, Ordering::Release);
        self.cleanup_executions(force).await
    }

    async fn cleanup_executions(&self, force: bool) -> bool {
        let executions = self
            .active
            .lock()
            .await
            .iter()
            .map(|(key, execution)| (key.clone(), execution.clone()))
            .collect::<Vec<_>>();
        self.stop_selected(executions, force).await
    }

    async fn stop_selected(
        &self,
        executions: Vec<((String, u64), SupportExecution)>,
        force: bool,
    ) -> bool {
        let mut converged = true;
        for (_, execution) in &executions {
            execution.canceled.store(true, Ordering::Release);
            if force {
                execution.force_requested.store(true, Ordering::Release);
            }
        }
        for (key, execution) in executions {
            let immediate = Self::stop_phase(execution.phase.clone(), force).await;
            let outcome = execution.completion.wait().await;
            if let Some(task) = execution.task.lock().await.clone() {
                while !task.is_finished() {
                    tokio::task::yield_now().await;
                }
            }
            let current_phase = self
                .active
                .lock()
                .await
                .get(&key)
                .filter(|current| current.generation == execution.generation)
                .map(|current| current.phase.clone());
            let late = if immediate.is_none() {
                match current_phase {
                    Some(phase @ SupportExecutionPhase::Unconverged(_))
                    | Some(phase @ SupportExecutionPhase::Running(_)) => {
                        Self::stop_phase(phase, force).await
                    }
                    _ => None,
                }
            } else {
                None
            };
            let execution_converged =
                outcome.cleanup_converged || immediate == Some(true) || late == Some(true);
            converged &= execution_converged;
            let mut active = self.active.lock().await;
            if execution_converged
                && active
                    .get(&key)
                    .is_some_and(|current| current.generation == execution.generation)
            {
                active.remove(&key);
            }
        }
        converged
    }

    async fn stop_phase(phase: SupportExecutionPhase, force: bool) -> Option<bool> {
        match phase {
            SupportExecutionPhase::Running(runtime) => {
                if force {
                    Some(runtime.force_shutdown_now().await.is_ok())
                } else {
                    let canceled = runtime.cancel().await.is_ok();
                    let shutdown = runtime.shutdown().await.is_ok();
                    Some(canceled && shutdown)
                }
            }
            SupportExecutionPhase::Unconverged(cleanup) => {
                if force {
                    Some(cleanup.force_shutdown_now().await)
                } else {
                    Some(cleanup.shutdown().await)
                }
            }
            SupportExecutionPhase::Constructing | SupportExecutionPhase::Terminal => None,
        }
    }
}

impl CommitExplanationExecutor for IsolatedSupportExecutor {
    fn execute<'a>(
        &'a self,
        request: SupportExplainRequest,
        canceled: Arc<AtomicBool>,
    ) -> ExplanationFuture<'a, Result<SupportExplainResult, SupportRuntimeError>> {
        Box::pin(async move {
            let request_id = request.request_id.clone();
            let generation = self.next_generation.fetch_add(1, Ordering::AcqRel);
            let key = (request_id, generation);
            let completion = Arc::new(SupportExecutionCompletion::default());
            let force_requested = Arc::new(AtomicBool::new(false));
            let mut active = self.active.lock().await;
            if self.shutting_down.load(Ordering::Acquire) {
                return Err(SupportRuntimeError::Canceled);
            }
            active.insert(
                key.clone(),
                SupportExecution {
                    generation,
                    canceled: canceled.clone(),
                    force_requested: force_requested.clone(),
                    phase: SupportExecutionPhase::Constructing,
                    task: Arc::new(Mutex::new(None)),
                    completion: completion.clone(),
                },
            );
            drop(active);
            let executor = self.clone();
            let task_completion = completion.clone();
            let task_key = key.clone();
            let task_start = Arc::new(Notify::new());
            let child_start = task_start.clone();
            let task = tokio::spawn(async move {
                child_start.notified().await;
                let outcome = executor
                    .clone()
                    .run_owned(request, canceled, force_requested, generation)
                    .await;
                if let Some(execution) = executor.active.lock().await.get_mut(&task_key) {
                    if execution.generation == generation {
                        execution.phase = match outcome.pending_cleanup.clone() {
                            Some(cleanup) => SupportExecutionPhase::Unconverged(cleanup),
                            None => SupportExecutionPhase::Terminal,
                        };
                    }
                }
                task_completion.finish(outcome).await;
            });
            let task_handle = task.abort_handle();
            drop(task);
            let task_slot = self
                .active
                .lock()
                .await
                .get(&key)
                .filter(|execution| execution.generation == generation)
                .map(|execution| execution.task.clone());
            if let Some(task_slot) = task_slot {
                *task_slot.lock().await = Some(task_handle.clone());
            }
            task_start.notify_one();
            let outcome = completion.wait().await;
            while !task_handle.is_finished() {
                tokio::task::yield_now().await;
            }
            if outcome.cleanup_converged {
                self.active.lock().await.remove(&key);
                outcome.result
            } else {
                Err(SupportRuntimeError::Process)
            }
        })
    }

    fn cancel<'a>(&'a self, request_id: &'a str) -> ExplanationFuture<'a, bool> {
        Box::pin(async move {
            let executions = self
                .active
                .lock()
                .await
                .iter()
                .filter(|((active_request_id, _), _)| active_request_id == request_id)
                .map(|(key, execution)| (key.clone(), execution.clone()))
                .collect::<Vec<_>>();
            if executions.is_empty() {
                return false;
            }
            self.stop_selected(executions, false).await
        })
    }

    fn force_cleanup_now<'a>(&'a self) -> ExplanationFuture<'a, bool> {
        Box::pin(async move { self.cleanup_executions(true).await })
    }

    fn has_owned_executions<'a>(&'a self) -> ExplanationFuture<'a, bool> {
        Box::pin(async move { !self.active.lock().await.is_empty() })
    }

    fn shutdown<'a>(&'a self) -> ExplanationFuture<'a, bool> {
        Box::pin(async move { self.stop_executions(false).await })
    }

    fn force_shutdown_now<'a>(&'a self) -> ExplanationFuture<'a, bool> {
        Box::pin(async move { self.stop_executions(true).await })
    }
}

struct CommitExplanationControllerInner {
    data: Mutex<ControllerData>,
    admission: Mutex<()>,
    executor: Arc<dyn CommitExplanationExecutor>,
    events: Arc<dyn CommitExplanationEventSink>,
    readiness: Arc<dyn SupportReadinessProvider>,
    settings_store: Option<SupportSettingsStore>,
    audit_store: Option<SupportAuditStore>,
    queue_limit: usize,
    cache_limit: usize,
    task_timeout: Duration,
}

#[derive(Clone)]
pub struct CommitExplanationController {
    inner: Arc<CommitExplanationControllerInner>,
}

#[derive(Clone)]
pub(crate) struct CommitExplanationTrustedEnqueuer {
    inner: Weak<CommitExplanationControllerInner>,
}

impl CommitExplanationController {
    pub fn production(
        supervisor: CodexSupervisor,
        app_handle: AppHandle,
        app_data_directory: &Path,
        resource_directory: &Path,
    ) -> Self {
        let opened = SupportSettingsStore::open(app_data_directory);
        let audit = SupportAuditStore::open(
            app_data_directory,
            opened
                .recovery_code
                .is_none()
                .then_some(opened.settings.version),
        );
        let recovery_code = opened.recovery_code.or(audit.recovery_code);
        let settings = if recovery_code.is_some() {
            SupportSettingsV1::fail_closed()
        } else {
            opened.settings
        };
        Self::with_control_dependencies(
            Arc::new(IsolatedSupportExecutor::new(supervisor.clone())),
            Arc::new(TauriCommitExplanationEventSink { app_handle }),
            Arc::new(SupervisorSupportReadinessProvider {
                supervisor: supervisor.clone(),
                resource_directory: resource_directory.to_path_buf(),
            }),
            opened.store,
            audit.store,
            settings,
            audit.state,
            recovery_code,
            COMMIT_EXPLANATION_QUEUE_LIMIT,
            COMMIT_EXPLANATION_CACHE_LIMIT,
            SUPPORT_TASK_TIMEOUT,
        )
    }

    #[cfg(test)]
    fn with_dependencies(
        executor: Arc<dyn CommitExplanationExecutor>,
        events: Arc<dyn CommitExplanationEventSink>,
        queue_limit: usize,
        cache_limit: usize,
        task_timeout: Duration,
    ) -> Self {
        Self::with_control_dependencies(
            executor,
            events,
            Arc::new(ApprovedFixtureReadinessProvider),
            None,
            None,
            SupportSettingsV1::default(),
            SupportDurableAuditV1::fresh(1),
            None,
            queue_limit,
            cache_limit,
            task_timeout,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn with_control_dependencies(
        executor: Arc<dyn CommitExplanationExecutor>,
        events: Arc<dyn CommitExplanationEventSink>,
        readiness: Arc<dyn SupportReadinessProvider>,
        settings_store: Option<SupportSettingsStore>,
        audit_store: Option<SupportAuditStore>,
        settings: SupportSettingsV1,
        audit: SupportDurableAuditV1,
        settings_recovery_code: Option<String>,
        queue_limit: usize,
        cache_limit: usize,
        task_timeout: Duration,
    ) -> Self {
        let data = ControllerData {
            settings,
            settings_recovery_code,
            usage: audit.usage,
            fallback_tasks: audit.fallback_tasks,
            latest_outcome: audit.latest_outcome,
            last_error_code: audit.last_error_code,
            ..ControllerData::default()
        };
        Self {
            inner: Arc::new(CommitExplanationControllerInner {
                data: Mutex::new(data),
                admission: Mutex::new(()),
                executor,
                events,
                readiness,
                settings_store,
                audit_store,
                queue_limit,
                cache_limit: cache_limit.max(1),
                task_timeout,
            }),
        }
    }

    pub(crate) fn trusted_enqueuer(&self) -> CommitExplanationTrustedEnqueuer {
        CommitExplanationTrustedEnqueuer {
            inner: Arc::downgrade(&self.inner),
        }
    }

    fn persist_audit(
        &self,
        data: &mut ControllerData,
        operation: &'static str,
    ) -> SupportControlResult<()> {
        let Some(store) = self.inner.audit_store.as_ref() else {
            return if self.inner.settings_store.is_some() {
                let code = data
                    .settings_recovery_code
                    .clone()
                    .unwrap_or_else(|| "CODEX-SUPPORT-AUDIT-UNAVAILABLE".to_owned());
                data.settings.global_enabled = false;
                data.settings.commit_explainer_enabled = false;
                data.settings_recovery_code = Some(code.clone());
                data.last_error_code = Some(code.clone());
                Err(SupportControlCommandError::new(code, operation, true))
            } else {
                // Unit harnesses without a filesystem store deliberately remain in-memory.
                Ok(())
            };
        };
        if let Err(error) = store.save(&durable_audit(data), operation) {
            let code = error.code.clone();
            data.settings.global_enabled = false;
            data.settings.commit_explainer_enabled = false;
            data.settings_recovery_code = Some(code.clone());
            data.last_error_code = Some(code);
            return Err(error);
        }
        Ok(())
    }

    fn record_blocked_state(
        &self,
        data: &mut ControllerData,
        key: ExplanationKey,
        request: &CommitExplanationRequestedV1,
        reason_code: &str,
        retryable: bool,
    ) -> CommitExplanationControllerStateV1 {
        record_blocked_outcome(data, request, reason_code);
        let persisted_reason = self
            .persist_audit(data, OPERATION_REQUEST)
            .err()
            .map_or_else(|| reason_code.to_owned(), |error| error.code);
        let state = terminal_state(
            request,
            CommitExplanationControllerStatus::Unavailable,
            retryable,
            Some(&persisted_reason),
        );
        data.states.insert(key, state.clone());
        state
    }

    pub async fn request(
        &self,
        dispatch: CommitExplanationDispatchV1,
    ) -> Result<CommitExplanationControllerStateV1, CommitExplanationControllerError> {
        validate_dispatch(&dispatch)?;
        let _admission = self.inner.admission.lock().await;
        let readiness = self.inner.readiness.snapshot().await;
        let key = ExplanationKey::from_request(&dispatch.request);
        let mut data = self.inner.data.lock().await;
        data.last_readiness = Some(readiness.clone());
        bounded_add(&mut data.usage.attempted_tasks, 1);
        if let Err(error) = self.persist_audit(&mut data, OPERATION_REQUEST) {
            let state =
                self.record_blocked_state(&mut data, key, &dispatch.request, &error.code, true);
            drop(data);
            self.inner.events.emit_state(&state);
            return Ok(state);
        }
        if let Some(reason_code) = support_gate_reason(&data, &readiness) {
            let state =
                self.record_blocked_state(&mut data, key, &dispatch.request, &reason_code, true);
            drop(data);
            self.inner.events.emit_state(&state);
            return Ok(state);
        }
        if data.shutting_down {
            let state = self.record_blocked_state(
                &mut data,
                key,
                &dispatch.request,
                "CODEX-SUPPORT-SHUTDOWN",
                false,
            );
            drop(data);
            self.inner.events.emit_state(&state);
            return Ok(state);
        }
        match data.generations.get(&key.workspace_id).copied() {
            Some(generation) if generation > key.workspace_generation => {
                let state = self.record_blocked_state(
                    &mut data,
                    key,
                    &dispatch.request,
                    "CODEX-SUPPORT-WORKSPACE-STALE",
                    true,
                );
                drop(data);
                self.inner.events.emit_state(&state);
                return Ok(state);
            }
            Some(generation) if generation < key.workspace_generation => {
                drop(data);
                self.set_scope(CommitExplanationScopeRequestedV1 {
                    schema_version: 1,
                    workspace_id: key.workspace_id.clone(),
                    workspace_generation: key.workspace_generation,
                    locale: dispatch.request.locale.clone(),
                })
                .await?;
                data = self.inner.data.lock().await;
            }
            None => {
                data.generations
                    .insert(key.workspace_id.clone(), key.workspace_generation);
            }
            _ => {}
        }

        if data.shutting_down {
            let state = self.record_blocked_state(
                &mut data,
                key,
                &dispatch.request,
                "CODEX-SUPPORT-SHUTDOWN",
                false,
            );
            drop(data);
            self.inner.events.emit_state(&state);
            return Ok(state);
        }

        match data.active_scope.as_ref() {
            None => {
                data.active_scope = Some(CommitExplanationScopeRequestedV1 {
                    schema_version: 1,
                    workspace_id: dispatch.request.workspace_id.clone(),
                    workspace_generation: dispatch.request.workspace_generation,
                    locale: dispatch.request.locale.clone(),
                });
            }
            Some(scope) if scope_matches_request(scope, &dispatch.request) => {}
            Some(_) => {
                let state = self.record_blocked_state(
                    &mut data,
                    key,
                    &dispatch.request,
                    "CODEX-SUPPORT-WORKSPACE-STALE",
                    true,
                );
                drop(data);
                self.inner.events.emit_state(&state);
                return Ok(state);
            }
        }

        if let Some(existing) = data.states.get(&key).cloned() {
            if !can_rebind_request(&existing, &dispatch.request) {
                return Ok(existing);
            }
            let terminal = matches!(
                existing.status,
                CommitExplanationControllerStatus::Failed
                    | CommitExplanationControllerStatus::Unavailable
                    | CommitExplanationControllerStatus::Canceled
            );
            if !terminal {
                let rebound = CommitExplanationControllerStateV1 {
                    status: existing.status,
                    retryable: existing.retryable,
                    presentation_available: existing.presentation_available,
                    error_code: existing.error_code,
                    updated_at: now(),
                    ..lifecycle_state(&dispatch.request, existing.status)
                };
                let rebound_applied = match existing.status {
                    CommitExplanationControllerStatus::Queued => data
                        .queue
                        .iter_mut()
                        .find(|task| task.key == key)
                        .map(|task| task.dispatch = dispatch.clone())
                        .is_some(),
                    CommitExplanationControllerStatus::Running => data
                        .active
                        .as_mut()
                        .filter(|active| active.task.key == key)
                        .map(|active| active.task.dispatch = dispatch.clone())
                        .is_some(),
                    CommitExplanationControllerStatus::Generated => data
                        .cache
                        .get_mut(&key)
                        .map(|cached| cached.request = dispatch.request.clone())
                        .is_some(),
                    _ => false,
                };
                if !rebound_applied {
                    return Err(controller_error(
                        "CODEX-SUPPORT-STATE-MISSING",
                        OPERATION_REQUEST,
                        false,
                    ));
                }
                data.states.insert(key, rebound.clone());
                drop(data);
                self.inner.events.emit_state(&rebound);
                return Ok(rebound);
            }
            if dispatch.request.trigger != CommitExplanationTrigger::UserRetry {
                let rebound = CommitExplanationControllerStateV1 {
                    status: existing.status,
                    retryable: existing.retryable,
                    presentation_available: existing.presentation_available,
                    error_code: existing.error_code,
                    updated_at: now(),
                    ..lifecycle_state(&dispatch.request, existing.status)
                };
                data.states.insert(key, rebound.clone());
                drop(data);
                self.inner.events.emit_state(&rebound);
                return Ok(rebound);
            }
        } else if dispatch.request.trigger == CommitExplanationTrigger::UserRetry {
            return Err(controller_error(
                "CODEX-SUPPORT-RETRY-STATE",
                OPERATION_REQUEST,
                false,
            ));
        }

        let outstanding = data.queue.len() + usize::from(data.active.is_some());
        if outstanding >= self.inner.queue_limit.saturating_add(1) {
            let state = self.record_blocked_state(
                &mut data,
                key,
                &dispatch.request,
                "CODEX-SUPPORT-QUEUE-FULL",
                true,
            );
            drop(data);
            self.inner.events.emit_state(&state);
            return Ok(state);
        }

        let state = lifecycle_state(&dispatch.request, CommitExplanationControllerStatus::Queued);
        data.states.insert(key.clone(), state.clone());
        data.queue.push_back(ExplanationTask { key, dispatch });
        let start_worker = !data.worker_running;
        let worker_completion = if start_worker {
            let completion = Arc::new(WorkerCompletion::default());
            data.worker_completion = Some(completion.clone());
            Some(completion)
        } else {
            None
        };
        if start_worker {
            data.worker_running = true;
        }
        drop(data);
        self.inner.events.emit_state(&state);
        if let Some(completion) = worker_completion {
            let controller = self.clone();
            tauri::async_runtime::spawn(async move {
                let _guard = WorkerCompletionGuard(completion);
                controller.run_worker().await;
            });
        }
        Ok(state)
    }

    async fn request_user(
        &self,
        dispatch: CommitExplanationDispatchV1,
    ) -> Result<CommitExplanationControllerStateV1, CommitExplanationControllerError> {
        if dispatch.request.trigger == CommitExplanationTrigger::AutoVerifiedCommit {
            return Err(controller_error(
                "CODEX-SUPPORT-AUTO-TRIGGER-FORBIDDEN",
                OPERATION_REQUEST,
                false,
            ));
        }
        self.request(dispatch).await
    }

    pub(crate) async fn enqueue_verified_commit(
        &self,
        workspace_id: String,
        workspace_generation: u64,
        commit_evidence_id: String,
        evidence: CommitEvidenceV1,
    ) -> Result<CommitExplanationControllerStateV1, CommitExplanationControllerError> {
        let now = now();
        self.request(CommitExplanationDispatchV1 {
            request: CommitExplanationRequestedV1 {
                schema_version: 1,
                request_id: format!("commit-explanation-{}", uuid::Uuid::new_v4()),
                workspace_id,
                workspace_generation,
                commit_evidence_id,
                locale: evidence.locale.clone(),
                selection_version: evidence.selection_version,
                trigger: CommitExplanationTrigger::AutoVerifiedCommit,
                requested_at: now,
            },
            evidence,
        })
        .await
    }

    pub async fn cancel(
        &self,
        request: CommitExplanationCancelRequestedV1,
    ) -> Result<Option<CommitExplanationControllerStateV1>, CommitExplanationControllerError> {
        validate_cancel(&request)?;
        let mut data = self.inner.data.lock().await;
        let active_key = data.active.as_ref().and_then(|active| {
            (active.task.dispatch.request.request_id == request.request_id
                && active.task.dispatch.request.workspace_generation
                    == request.workspace_generation
                && active.task.dispatch.request.selection_version == request.selection_version)
                .then(|| active.task.key.clone())
        });
        let mut active_executor_request_id = None;
        let key = if let Some(key) = active_key {
            if let Some(active) = data.active.as_ref() {
                active.canceled.store(true, Ordering::Release);
                active_executor_request_id = Some(active.executor_request_id.clone());
            }
            Some(key)
        } else {
            let position = data.queue.iter().position(|task| {
                task.dispatch.request.request_id == request.request_id
                    && task.dispatch.request.workspace_generation == request.workspace_generation
                    && task.dispatch.request.selection_version == request.selection_version
            });
            position.and_then(|position| data.queue.remove(position).map(|task| task.key))
        };
        let Some(key) = key else {
            return Ok(data
                .states
                .values()
                .find(|state| state.request_id.as_deref() == Some(&request.request_id))
                .cloned());
        };
        let previous = data.states.get(&key).cloned().ok_or_else(|| {
            controller_error("CODEX-SUPPORT-STATE-MISSING", OPERATION_CANCEL, false)
        })?;
        let state = CommitExplanationControllerStateV1 {
            status: CommitExplanationControllerStatus::Canceled,
            retryable: true,
            presentation_available: false,
            error_code: Some("CODEX-SUPPORT-CANCELED".to_owned()),
            updated_at: now(),
            ..previous
        };
        data.states.insert(key, state.clone());
        bounded_add(&mut data.usage.canceled_tasks, 1);
        data.latest_outcome = Some(SupportLatestOutcomeV1 {
            status: SupportOutcomeStatus::Canceled,
            trigger: state
                .trigger
                .map(trigger_name)
                .unwrap_or("unknown")
                .to_owned(),
            completed_at: state.updated_at.clone(),
            latency_ms: None,
            input_tokens: 0,
            output_tokens: 0,
            total_tokens: 0,
            error_code: Some("CODEX-SUPPORT-CANCELED".to_owned()),
        });
        data.last_error_code = Some("CODEX-SUPPORT-CANCELED".to_owned());
        let audit_error = self.persist_audit(&mut data, OPERATION_CANCEL).err();
        drop(data);
        self.inner.events.emit_state(&state);
        if let Some(executor_request_id) = active_executor_request_id {
            let _ = self.inner.executor.cancel(&executor_request_id).await;
        }
        if let Some(error) = audit_error {
            return Err(CommitExplanationControllerError::new(
                error.code,
                OPERATION_CANCEL,
                error.recoverable,
            ));
        }
        Ok(Some(state))
    }

    pub async fn present(
        &self,
        request: CommitExplanationPresentationRequestedV1,
    ) -> Result<CommitExplanationPresentationV1, CommitExplanationControllerError> {
        validate_presentation(&request)?;
        let cached = self
            .inner
            .data
            .lock()
            .await
            .cache
            .iter()
            .find(|(key, cached)| {
                key.workspace_id == request.workspace_id
                    && key.workspace_generation == request.workspace_generation
                    && key.commit_evidence_id == request.commit_evidence_id
                    && cached.request.request_id == request.request_id
            })
            .map(|(_, cached)| cached.clone())
            .ok_or_else(|| {
                controller_error(
                    "CODEX-SUPPORT-PRESENTATION-MISSING",
                    OPERATION_PRESENT,
                    true,
                )
            })?;
        let presentation = presentation(&cached, request.mode);
        self.inner.events.emit_presentation(&presentation);
        Ok(presentation)
    }

    pub async fn get_state(
        &self,
        request: CommitExplanationStateRequestedV1,
    ) -> Result<CommitExplanationControllerStateV1, CommitExplanationControllerError> {
        validate_state_request(&request)?;
        let data = self.inner.data.lock().await;
        let scoped_locale = data.active_scope.as_ref().and_then(|scope| {
            (scope.workspace_id == request.workspace_id
                && scope.workspace_generation == request.workspace_generation)
                .then_some(scope.locale.as_str())
        });
        let scoped = scoped_locale.and_then(|locale| {
            data.states.iter().find_map(|(key, state)| {
                (key.matches_state_request(&request) && key.locale == locale)
                    .then_some(state.clone())
            })
        });
        let fallback = data
            .states
            .iter()
            .filter(|(key, _)| key.matches_state_request(&request))
            .map(|(_, state)| state)
            .max_by(|left, right| left.updated_at.cmp(&right.updated_at))
            .cloned();
        Ok(scoped
            .or(fallback)
            .unwrap_or_else(|| CommitExplanationControllerStateV1 {
                schema_version: 1,
                workspace_id: request.workspace_id,
                workspace_generation: request.workspace_generation,
                commit_evidence_id: request.commit_evidence_id,
                request_id: None,
                locale: None,
                selection_version: None,
                status: CommitExplanationControllerStatus::NotGenerated,
                trigger: None,
                retryable: false,
                presentation_available: false,
                error_code: None,
                updated_at: now(),
            }))
    }

    pub async fn set_scope(
        &self,
        request: CommitExplanationScopeRequestedV1,
    ) -> Result<(), CommitExplanationControllerError> {
        validate_scope(&request)?;
        let mut data = self.inner.data.lock().await;
        if data
            .generations
            .get(&request.workspace_id)
            .is_some_and(|generation| *generation > request.workspace_generation)
        {
            return Err(controller_error(
                "CODEX-SUPPORT-WORKSPACE-STALE",
                OPERATION_SCOPE,
                false,
            ));
        }
        data.generations
            .insert(request.workspace_id.clone(), request.workspace_generation);
        data.active_scope = Some(request);
        Ok(())
    }

    async fn begin_shutdown(
        &self,
    ) -> (
        Vec<CommitExplanationControllerStateV1>,
        Option<String>,
        Option<Arc<WorkerCompletion>>,
        bool,
    ) {
        let mut data = self.inner.data.lock().await;
        data.shutting_down = true;
        let queued = data
            .queue
            .drain(..)
            .map(|task| task.key)
            .collect::<Vec<_>>();
        let mut changed = Vec::new();
        for key in queued {
            if let Some(previous) = data.states.get(&key).cloned() {
                let state = canceled_for_shutdown(previous);
                data.states.insert(key, state.clone());
                changed.push(state);
            }
        }
        let active = data.active.as_ref().map(|active| {
            active.canceled.store(true, Ordering::Release);
            (active.task.key.clone(), active.executor_request_id.clone())
        });
        if let Some((key, _)) = active.as_ref() {
            if let Some(previous) = data.states.get(key).cloned() {
                let state = canceled_for_shutdown(previous);
                data.states.insert(key.clone(), state.clone());
                changed.push(state);
            }
        }
        if !changed.is_empty() {
            bounded_add(
                &mut data.usage.canceled_tasks,
                u64::try_from(changed.len()).unwrap_or(u64::MAX),
            );
            data.latest_outcome = changed.last().map(|state| SupportLatestOutcomeV1 {
                status: SupportOutcomeStatus::Canceled,
                trigger: state
                    .trigger
                    .map(trigger_name)
                    .unwrap_or("unknown")
                    .to_owned(),
                completed_at: state.updated_at.clone(),
                latency_ms: None,
                input_tokens: 0,
                output_tokens: 0,
                total_tokens: 0,
                error_code: Some("CODEX-SUPPORT-SHUTDOWN".to_owned()),
            });
            data.last_error_code = Some("CODEX-SUPPORT-SHUTDOWN".to_owned());
        }
        let audit_persisted = self.persist_audit(&mut data, OPERATION_SHUTDOWN).is_ok();
        (
            changed,
            active.map(|(_, request_id)| request_id),
            data.worker_completion.clone(),
            audit_persisted,
        )
    }

    async fn shutdown_converged(&self, force: bool) -> bool {
        let (changed, active_request_id, worker_completion, audit_persisted) =
            self.begin_shutdown().await;
        for state in changed {
            self.inner.events.emit_state(&state);
        }
        let cancel_converged = if force {
            true
        } else if let Some(request_id) = active_request_id {
            self.inner.executor.cancel(&request_id).await
        } else {
            true
        };
        let executor_converged = if force {
            self.inner.executor.force_shutdown_now().await
        } else {
            self.inner.executor.shutdown().await
        };
        if let Some(completion) = worker_completion {
            completion.wait().await;
        }
        let executor_ownership_released = !self.inner.executor.has_owned_executions().await;
        let data = self.inner.data.lock().await;
        audit_persisted
            && cancel_converged
            && executor_converged
            && executor_ownership_released
            && data.queue.is_empty()
            && data.active.is_none()
            && !data.worker_running
    }

    pub async fn shutdown(&self) -> Result<(), CommitExplanationControllerError> {
        if self.shutdown_converged(false).await {
            Ok(())
        } else {
            Err(controller_error(
                "CODEX-SUPPORT-SHUTDOWN-INCOMPLETE",
                OPERATION_SHUTDOWN,
                true,
            ))
        }
    }

    pub async fn force_shutdown_now(&self) -> bool {
        self.shutdown_converged(true).await
    }

    async fn run_worker(&self) {
        loop {
            let (task, canceled, running, audit_failure) = {
                let mut data = self.inner.data.lock().await;
                let Some(task) = data.queue.pop_front() else {
                    data.worker_running = false;
                    return;
                };
                let canceled = Arc::new(AtomicBool::new(false));
                let running = lifecycle_state(
                    &task.dispatch.request,
                    CommitExplanationControllerStatus::Running,
                );
                data.states.insert(task.key.clone(), running.clone());
                bounded_add(&mut data.usage.started_tasks, 1);
                data.active = Some(ActiveTask {
                    task: task.clone(),
                    executor_request_id: task.dispatch.request.request_id.clone(),
                    canceled: canceled.clone(),
                });
                let audit_failure =
                    self.persist_audit(&mut data, OPERATION_REQUEST)
                        .err()
                        .map(|error| {
                            data.active = None;
                            record_blocked_outcome(&mut data, &task.dispatch.request, &error.code);
                            let state = terminal_state(
                                &task.dispatch.request,
                                CommitExplanationControllerStatus::Unavailable,
                                true,
                                Some(&error.code),
                            );
                            data.states.insert(task.key.clone(), state.clone());
                            state
                        });
                (task, canceled, running, audit_failure)
            };
            if let Some(state) = audit_failure {
                self.inner.events.emit_state(&state);
                continue;
            }
            self.inner.events.emit_state(&running);
            let support_request = SupportExplainRequest {
                schema_version: 1,
                request_id: task.dispatch.request.request_id.clone(),
                workspace_id: task.dispatch.request.workspace_id.clone(),
                full_commit_sha: task
                    .dispatch
                    .request
                    .commit_evidence_id
                    .trim_start_matches("commit-")
                    .to_owned(),
                trigger: task.dispatch.request.trigger,
                evidence: task.dispatch.evidence.clone(),
            };
            let outcome = match tokio::time::timeout(
                self.inner.task_timeout,
                self.inner.executor.execute(support_request, canceled),
            )
            .await
            {
                Ok(outcome) => outcome,
                Err(_) => {
                    let _ = self
                        .inner
                        .executor
                        .cancel(&task.dispatch.request.request_id)
                        .await;
                    Err(SupportRuntimeError::Timeout)
                }
            };

            let state = {
                let mut data = self.inner.data.lock().await;
                let rebound_request = data.active.as_ref().and_then(|active| {
                    (active.executor_request_id == task.dispatch.request.request_id)
                        .then(|| active.task.dispatch.request.clone())
                });
                if rebound_request.is_some() {
                    data.active = None;
                }
                let previous = data.states.get(&task.key).cloned();
                if rebound_request.is_none()
                    || previous.as_ref().is_some_and(|state| {
                        state.status == CommitExplanationControllerStatus::Canceled
                    })
                {
                    None
                } else {
                    let output_request = rebound_request
                        .as_ref()
                        .expect("active request checked above");
                    let mut state = match outcome {
                        Ok(result)
                            if result.request_id == task.dispatch.request.request_id
                                && result.explanation.locale == task.dispatch.request.locale =>
                        {
                            record_success_outcome(&mut data, &result, output_request.trigger);
                            let cached = CachedExplanation {
                                request: output_request.clone(),
                                result,
                            };
                            insert_cache(
                                &mut data,
                                task.key.clone(),
                                cached.clone(),
                                self.inner.cache_limit,
                            );
                            let state = CommitExplanationControllerStateV1 {
                                status: CommitExplanationControllerStatus::Generated,
                                retryable: false,
                                presentation_available: true,
                                error_code: None,
                                updated_at: now(),
                                ..lifecycle_state(
                                    output_request,
                                    CommitExplanationControllerStatus::Generated,
                                )
                            };
                            data.states.insert(task.key.clone(), state.clone());
                            Some(state)
                        }
                        Ok(result) => {
                            record_invalid_result_outcome(
                                &mut data,
                                &result,
                                output_request.trigger,
                            );
                            let state = terminal_state(
                                output_request,
                                CommitExplanationControllerStatus::Failed,
                                true,
                                Some("CODEX-SUPPORT-RESULT-STALE"),
                            );
                            data.states.insert(task.key.clone(), state.clone());
                            Some(state)
                        }
                        Err(error) => {
                            record_runtime_error_outcome(&mut data, error, output_request.trigger);
                            let (status, retryable) = error_state(error);
                            let state = terminal_state(
                                output_request,
                                status,
                                retryable,
                                Some(error.code()),
                            );
                            data.states.insert(task.key.clone(), state.clone());
                            Some(state)
                        }
                    };
                    if state.is_some() {
                        if let Err(error) = self.persist_audit(&mut data, OPERATION_REQUEST) {
                            data.cache.remove(&task.key);
                            data.cache_order.retain(|key| key != &task.key);
                            record_blocked_outcome(&mut data, output_request, &error.code);
                            let unavailable = terminal_state(
                                output_request,
                                CommitExplanationControllerStatus::Unavailable,
                                true,
                                Some(&error.code),
                            );
                            data.states.insert(task.key.clone(), unavailable.clone());
                            state = Some(unavailable);
                        }
                    }
                    state
                }
            };
            if let Some(state) = state {
                self.inner.events.emit_state(&state);
            }
        }
    }
}

impl CommitExplanationTrustedEnqueuer {
    pub(crate) async fn locale_for_scope(
        &self,
        workspace_id: &str,
        workspace_generation: u64,
    ) -> Option<String> {
        let inner = self.inner.upgrade()?;
        let data = inner.data.lock().await;
        data.active_scope
            .as_ref()
            .filter(|scope| {
                scope.workspace_id == workspace_id
                    && scope.workspace_generation == workspace_generation
            })
            .map(|scope| scope.locale.clone())
    }

    pub(crate) async fn enqueue_verified_commit(
        &self,
        workspace_id: String,
        workspace_generation: u64,
        commit_evidence_id: String,
        evidence: CommitEvidenceV1,
    ) -> Result<CommitExplanationControllerStateV1, CommitExplanationControllerError> {
        let inner = self
            .inner
            .upgrade()
            .ok_or_else(|| controller_error("CODEX-SUPPORT-SHUTDOWN", OPERATION_REQUEST, true))?;
        CommitExplanationController { inner }
            .enqueue_verified_commit(
                workspace_id,
                workspace_generation,
                commit_evidence_id,
                evidence,
            )
            .await
    }
}

fn insert_cache(
    data: &mut ControllerData,
    key: ExplanationKey,
    cached: CachedExplanation,
    cache_limit: usize,
) {
    data.cache_order.retain(|candidate| candidate != &key);
    data.cache_order.push_back(key.clone());
    data.cache.insert(key, cached);
    while data.cache.len() > cache_limit {
        let Some(oldest) = data.cache_order.pop_front() else {
            break;
        };
        data.cache.remove(&oldest);
        if data
            .states
            .get(&oldest)
            .is_some_and(|state| state.status == CommitExplanationControllerStatus::Generated)
        {
            data.states.remove(&oldest);
        }
    }
}

fn lifecycle_state(
    request: &CommitExplanationRequestedV1,
    status: CommitExplanationControllerStatus,
) -> CommitExplanationControllerStateV1 {
    CommitExplanationControllerStateV1 {
        schema_version: 1,
        workspace_id: request.workspace_id.clone(),
        workspace_generation: request.workspace_generation,
        commit_evidence_id: request.commit_evidence_id.clone(),
        request_id: Some(request.request_id.clone()),
        locale: Some(request.locale.clone()),
        selection_version: Some(request.selection_version),
        status,
        trigger: Some(request.trigger),
        retryable: false,
        presentation_available: false,
        error_code: None,
        updated_at: now(),
    }
}

fn can_rebind_request(
    existing: &CommitExplanationControllerStateV1,
    incoming: &CommitExplanationRequestedV1,
) -> bool {
    if existing
        .selection_version
        .is_some_and(|version| incoming.selection_version < version)
    {
        return false;
    }
    !(existing.trigger.is_some_and(|trigger| {
        matches!(
            trigger,
            CommitExplanationTrigger::UserRequest | CommitExplanationTrigger::UserRetry
        )
    }) && incoming.trigger == CommitExplanationTrigger::AutoVerifiedCommit)
}

fn terminal_state(
    request: &CommitExplanationRequestedV1,
    status: CommitExplanationControllerStatus,
    retryable: bool,
    error_code: Option<&str>,
) -> CommitExplanationControllerStateV1 {
    CommitExplanationControllerStateV1 {
        retryable,
        error_code: error_code.map(str::to_owned),
        updated_at: now(),
        ..lifecycle_state(request, status)
    }
}

fn canceled_for_shutdown(
    previous: CommitExplanationControllerStateV1,
) -> CommitExplanationControllerStateV1 {
    CommitExplanationControllerStateV1 {
        status: CommitExplanationControllerStatus::Canceled,
        retryable: true,
        presentation_available: false,
        error_code: Some("CODEX-SUPPORT-SHUTDOWN".to_owned()),
        updated_at: now(),
        ..previous
    }
}

fn support_gate_reason(
    data: &ControllerData,
    readiness: &SupportReleaseReadinessV1,
) -> Option<String> {
    if let Some(code) = data.settings_recovery_code.as_ref() {
        return Some(code.clone());
    }
    if !data.settings.global_enabled {
        return Some("CODEX-SUPPORT-DISABLED".to_owned());
    }
    if !data.settings.commit_explainer_enabled {
        return Some("CODEX-SUPPORT-COMMIT-EXPLAINER-DISABLED".to_owned());
    }
    if readiness.status != SupportReadinessStatus::Approved {
        return Some(
            readiness
                .reason_code
                .clone()
                .unwrap_or_else(|| "CODEX-SUPPORT-NOT-READY".to_owned()),
        );
    }
    None
}

fn durable_audit(data: &ControllerData) -> SupportDurableAuditV1 {
    SupportDurableAuditV1 {
        schema_version: 1,
        policy_version: data.settings.version,
        usage: data.usage.clone(),
        fallback_tasks: data.fallback_tasks,
        latest_outcome: data.latest_outcome.clone(),
        last_error_code: data.last_error_code.clone(),
        raw_transcript_persisted: false,
        updated_at: now(),
    }
}

fn bounded_add(counter: &mut u64, amount: u64) {
    *counter = counter.saturating_add(amount).min(SUPPORT_MAX_SAFE_COUNTER);
}

fn record_blocked_outcome(
    data: &mut ControllerData,
    request: &CommitExplanationRequestedV1,
    reason_code: &str,
) {
    bounded_add(&mut data.usage.unavailable_tasks, 1);
    bounded_add(&mut data.fallback_tasks, 1);
    data.latest_outcome = Some(SupportLatestOutcomeV1 {
        status: SupportOutcomeStatus::Unavailable,
        trigger: trigger_name(request.trigger).to_owned(),
        completed_at: now(),
        latency_ms: None,
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        error_code: Some(reason_code.to_owned()),
    });
    data.last_error_code = Some(reason_code.to_owned());
}

fn record_success_outcome(
    data: &mut ControllerData,
    result: &SupportExplainResult,
    trigger: CommitExplanationTrigger,
) {
    bounded_add(&mut data.usage.succeeded_tasks, 1);
    add_usage(data, result);
    data.latest_outcome = Some(SupportLatestOutcomeV1 {
        status: SupportOutcomeStatus::Generated,
        trigger: trigger_name(trigger).to_owned(),
        completed_at: now(),
        latency_ms: Some(result.latency_ms),
        input_tokens: result.usage.input_tokens,
        output_tokens: result.usage.output_tokens,
        total_tokens: result.usage.total_tokens,
        error_code: None,
    });
    data.last_error_code = None;
}

fn record_invalid_result_outcome(
    data: &mut ControllerData,
    result: &SupportExplainResult,
    trigger: CommitExplanationTrigger,
) {
    bounded_add(&mut data.usage.failed_tasks, 1);
    add_usage(data, result);
    data.latest_outcome = Some(SupportLatestOutcomeV1 {
        status: SupportOutcomeStatus::Failed,
        trigger: trigger_name(trigger).to_owned(),
        completed_at: now(),
        latency_ms: Some(result.latency_ms),
        input_tokens: result.usage.input_tokens,
        output_tokens: result.usage.output_tokens,
        total_tokens: result.usage.total_tokens,
        error_code: Some("CODEX-SUPPORT-RESULT-STALE".to_owned()),
    });
    data.last_error_code = Some("CODEX-SUPPORT-RESULT-STALE".to_owned());
}

fn record_runtime_error_outcome(
    data: &mut ControllerData,
    error: SupportRuntimeError,
    trigger: CommitExplanationTrigger,
) {
    let (controller_status, _) = error_state(error);
    let status = match controller_status {
        CommitExplanationControllerStatus::Canceled => {
            bounded_add(&mut data.usage.canceled_tasks, 1);
            SupportOutcomeStatus::Canceled
        }
        CommitExplanationControllerStatus::Unavailable => {
            bounded_add(&mut data.usage.unavailable_tasks, 1);
            bounded_add(&mut data.fallback_tasks, 1);
            SupportOutcomeStatus::Unavailable
        }
        _ => {
            bounded_add(&mut data.usage.failed_tasks, 1);
            SupportOutcomeStatus::Failed
        }
    };
    data.latest_outcome = Some(SupportLatestOutcomeV1 {
        status,
        trigger: trigger_name(trigger).to_owned(),
        completed_at: now(),
        latency_ms: None,
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        error_code: Some(error.code().to_owned()),
    });
    data.last_error_code = Some(error.code().to_owned());
}

fn add_usage(data: &mut ControllerData, result: &SupportExplainResult) {
    let remaining = SUPPORT_MAX_SAFE_COUNTER.saturating_sub(data.usage.total_tokens);
    let input = result.usage.input_tokens.min(remaining);
    bounded_add(&mut data.usage.input_tokens, input);
    let remaining = SUPPORT_MAX_SAFE_COUNTER.saturating_sub(
        data.usage
            .input_tokens
            .saturating_add(data.usage.output_tokens),
    );
    let output = result.usage.output_tokens.min(remaining);
    bounded_add(&mut data.usage.output_tokens, output);
    data.usage.total_tokens = data
        .usage
        .input_tokens
        .saturating_add(data.usage.output_tokens);
    bounded_add(&mut data.usage.total_latency_ms, result.latency_ms);
}

fn trigger_name(trigger: CommitExplanationTrigger) -> &'static str {
    match trigger {
        CommitExplanationTrigger::AutoVerifiedCommit => "auto_verified_commit",
        CommitExplanationTrigger::UserRequest => "user_request",
        CommitExplanationTrigger::UserRetry => "user_retry",
    }
}

fn prefix16(value: &str) -> String {
    value.chars().take(16).collect()
}

fn presentation(
    cached: &CachedExplanation,
    mode: CommitExplanationPresentationMode,
) -> CommitExplanationPresentationV1 {
    CommitExplanationPresentationV1 {
        schema_version: 1,
        workspace_id: cached.request.workspace_id.clone(),
        workspace_generation: cached.request.workspace_generation,
        commit_evidence_id: cached.request.commit_evidence_id.clone(),
        request_id: cached.request.request_id.clone(),
        selection_version: cached.request.selection_version,
        trigger: cached.request.trigger,
        locale: cached.request.locale.clone(),
        mode,
        explanation: cached.result.explanation.clone(),
        usage: cached.result.usage.clone(),
        latency_ms: cached.result.latency_ms,
        presented_at: now(),
    }
}

fn error_state(error: SupportRuntimeError) -> (CommitExplanationControllerStatus, bool) {
    match error {
        SupportRuntimeError::Canceled => (CommitExplanationControllerStatus::Canceled, true),
        SupportRuntimeError::UnsupportedRelease
        | SupportRuntimeError::Schema
        | SupportRuntimeError::PrivateRuntime
        | SupportRuntimeError::AuthBridge
        | SupportRuntimeError::Skill
        | SupportRuntimeError::IsolationProbe
        | SupportRuntimeError::Policy => (CommitExplanationControllerStatus::Unavailable, true),
        SupportRuntimeError::Process
        | SupportRuntimeError::Protocol
        | SupportRuntimeError::Busy
        | SupportRuntimeError::AlreadyUsed
        | SupportRuntimeError::Timeout
        | SupportRuntimeError::Output
        | SupportRuntimeError::EvidenceRedaction => {
            (CommitExplanationControllerStatus::Failed, true)
        }
    }
}

fn validate_dispatch(
    dispatch: &CommitExplanationDispatchV1,
) -> Result<(), CommitExplanationControllerError> {
    let request = &dispatch.request;
    if request.schema_version != 1
        || !valid_id(&request.request_id, 128)
        || !valid_id(&request.workspace_id, 128)
        || request.workspace_generation == 0
        || !valid_evidence_id(&request.commit_evidence_id)
        || !matches!(request.locale.as_str(), "ja" | "en")
        || request.selection_version == 0
        || !valid_timestamp(&request.requested_at)
        || dispatch.evidence.schema_version != 1
        || dispatch.evidence.workspace_generation != request.workspace_generation
        || dispatch.evidence.selection_version != request.selection_version
        || dispatch.evidence.locale != request.locale
        || dispatch.evidence.commit_id != request.commit_evidence_id
    {
        return Err(controller_error(
            "CODEX-SUPPORT-REQUEST-INVALID",
            OPERATION_REQUEST,
            false,
        ));
    }
    Ok(())
}

fn validate_cancel(
    request: &CommitExplanationCancelRequestedV1,
) -> Result<(), CommitExplanationControllerError> {
    if request.schema_version != 1
        || !valid_id(&request.request_id, 128)
        || request.workspace_generation == 0
        || request.selection_version == 0
        || !valid_timestamp(&request.requested_at)
    {
        return Err(controller_error(
            "CODEX-SUPPORT-CANCEL-INVALID",
            OPERATION_CANCEL,
            false,
        ));
    }
    Ok(())
}

fn validate_presentation(
    request: &CommitExplanationPresentationRequestedV1,
) -> Result<(), CommitExplanationControllerError> {
    if request.schema_version != 1
        || !valid_id(&request.request_id, 128)
        || !valid_id(&request.workspace_id, 128)
        || request.workspace_generation == 0
        || !valid_evidence_id(&request.commit_evidence_id)
        || !valid_timestamp(&request.requested_at)
    {
        return Err(controller_error(
            "CODEX-SUPPORT-PRESENTATION-INVALID",
            OPERATION_PRESENT,
            false,
        ));
    }
    Ok(())
}

fn validate_state_request(
    request: &CommitExplanationStateRequestedV1,
) -> Result<(), CommitExplanationControllerError> {
    if request.schema_version != 1
        || !valid_id(&request.workspace_id, 128)
        || request.workspace_generation == 0
        || !valid_evidence_id(&request.commit_evidence_id)
    {
        return Err(controller_error(
            "CODEX-SUPPORT-STATE-INVALID",
            OPERATION_STATE,
            false,
        ));
    }
    Ok(())
}

fn validate_scope(
    request: &CommitExplanationScopeRequestedV1,
) -> Result<(), CommitExplanationControllerError> {
    if request.schema_version != 1
        || !valid_id(&request.workspace_id, 128)
        || request.workspace_generation == 0
        || !matches!(request.locale.as_str(), "ja" | "en")
    {
        return Err(controller_error(
            "CODEX-SUPPORT-SCOPE-INVALID",
            OPERATION_SCOPE,
            false,
        ));
    }
    Ok(())
}

fn scope_matches_request(
    scope: &CommitExplanationScopeRequestedV1,
    request: &CommitExplanationRequestedV1,
) -> bool {
    scope.workspace_id == request.workspace_id
        && scope.workspace_generation == request.workspace_generation
        && scope.locale == request.locale
}

fn controller_error(
    code: &'static str,
    operation: &'static str,
    recoverable: bool,
) -> CommitExplanationControllerError {
    CommitExplanationControllerError::new(code, operation, recoverable)
}

fn valid_id(value: &str, maximum: usize) -> bool {
    !value.is_empty()
        && value.len() <= maximum
        && value
            .bytes()
            .all(|byte| byte.is_ascii_graphic() && !matches!(byte, b'/' | b'\\'))
}

fn valid_evidence_id(value: &str) -> bool {
    value.strip_prefix("commit-").is_some_and(valid_sha)
}

fn valid_sha(value: &str) -> bool {
    matches!(value.len(), 40 | 64)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_timestamp(value: &str) -> bool {
    value.len() <= 64 && chrono::DateTime::parse_from_rfc3339(value).is_ok()
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

#[tauri::command]
pub async fn commit_explanation_request(
    dispatch: CommitExplanationDispatchV1,
    controller: tauri::State<'_, CommitExplanationController>,
) -> Result<CommitExplanationControllerStateV1, CommitExplanationControllerError> {
    controller.request_user(dispatch).await
}

#[tauri::command]
pub async fn commit_explanation_cancel(
    request: CommitExplanationCancelRequestedV1,
    controller: tauri::State<'_, CommitExplanationController>,
) -> Result<Option<CommitExplanationControllerStateV1>, CommitExplanationControllerError> {
    controller.cancel(request).await
}

#[tauri::command]
pub async fn commit_explanation_present(
    request: CommitExplanationPresentationRequestedV1,
    controller: tauri::State<'_, CommitExplanationController>,
) -> Result<CommitExplanationPresentationV1, CommitExplanationControllerError> {
    controller.present(request).await
}

#[tauri::command]
pub async fn commit_explanation_get_state(
    request: CommitExplanationStateRequestedV1,
    controller: tauri::State<'_, CommitExplanationController>,
) -> Result<CommitExplanationControllerStateV1, CommitExplanationControllerError> {
    controller.get_state(request).await
}

#[tauri::command]
pub async fn commit_explanation_set_scope(
    request: CommitExplanationScopeRequestedV1,
    controller: tauri::State<'_, CommitExplanationController>,
) -> Result<(), CommitExplanationControllerError> {
    controller.set_scope(request).await
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex as StdMutex;

    use tokio::sync::Semaphore;

    use crate::git_review::types::{CommitEvidenceV1, DiffSummary};

    use super::*;

    #[derive(Clone, Copy)]
    enum FakeMode {
        Immediate,
        Block,
        Never,
    }

    struct InflightGuard<'a> {
        counter: &'a AtomicUsize,
    }

    impl Drop for InflightGuard<'_> {
        fn drop(&mut self) {
            self.counter.fetch_sub(1, Ordering::AcqRel);
        }
    }

    struct FakeExecutor {
        mode: FakeMode,
        calls: AtomicUsize,
        cancels: AtomicUsize,
        cancel_converges: AtomicBool,
        cleanup_forces: AtomicUsize,
        cleanup_force_converges: AtomicBool,
        shutdowns: AtomicUsize,
        shutdown_converges: AtomicBool,
        forces: AtomicUsize,
        inflight: AtomicUsize,
        maximum_inflight: AtomicUsize,
        release: Semaphore,
    }

    impl FakeExecutor {
        fn new(mode: FakeMode) -> Self {
            Self {
                mode,
                calls: AtomicUsize::new(0),
                cancels: AtomicUsize::new(0),
                cancel_converges: AtomicBool::new(true),
                cleanup_forces: AtomicUsize::new(0),
                cleanup_force_converges: AtomicBool::new(true),
                shutdowns: AtomicUsize::new(0),
                shutdown_converges: AtomicBool::new(true),
                forces: AtomicUsize::new(0),
                inflight: AtomicUsize::new(0),
                maximum_inflight: AtomicUsize::new(0),
                release: Semaphore::new(0),
            }
        }

        fn release_one(&self) {
            self.release.add_permits(1);
        }
    }

    impl CommitExplanationExecutor for FakeExecutor {
        fn execute<'a>(
            &'a self,
            request: SupportExplainRequest,
            canceled: Arc<AtomicBool>,
        ) -> ExplanationFuture<'a, Result<SupportExplainResult, SupportRuntimeError>> {
            Box::pin(async move {
                self.calls.fetch_add(1, Ordering::AcqRel);
                let inflight = self.inflight.fetch_add(1, Ordering::AcqRel) + 1;
                self.maximum_inflight.fetch_max(inflight, Ordering::AcqRel);
                let _guard = InflightGuard {
                    counter: &self.inflight,
                };
                match self.mode {
                    FakeMode::Immediate => {}
                    FakeMode::Block => {
                        self.release
                            .acquire()
                            .await
                            .expect("test semaphore")
                            .forget();
                    }
                    FakeMode::Never => std::future::pending::<()>().await,
                }
                if canceled.load(Ordering::Acquire) {
                    return Err(SupportRuntimeError::Canceled);
                }
                Ok(result(&request))
            })
        }

        fn cancel<'a>(&'a self, _request_id: &'a str) -> ExplanationFuture<'a, bool> {
            Box::pin(async move {
                self.cancels.fetch_add(1, Ordering::AcqRel);
                if matches!(self.mode, FakeMode::Block) {
                    self.release_one();
                }
                self.cancel_converges.load(Ordering::Acquire)
            })
        }

        fn shutdown<'a>(&'a self) -> ExplanationFuture<'a, bool> {
            Box::pin(async move {
                self.shutdowns.fetch_add(1, Ordering::AcqRel);
                if matches!(self.mode, FakeMode::Block) {
                    self.release_one();
                }
                self.shutdown_converges.load(Ordering::Acquire)
            })
        }

        fn force_cleanup_now<'a>(&'a self) -> ExplanationFuture<'a, bool> {
            Box::pin(async move {
                self.cleanup_forces.fetch_add(1, Ordering::AcqRel);
                if matches!(self.mode, FakeMode::Block) {
                    self.release_one();
                }
                self.cleanup_force_converges.load(Ordering::Acquire)
            })
        }

        fn has_owned_executions<'a>(&'a self) -> ExplanationFuture<'a, bool> {
            Box::pin(async move { self.inflight.load(Ordering::Acquire) != 0 })
        }

        fn force_shutdown_now<'a>(&'a self) -> ExplanationFuture<'a, bool> {
            Box::pin(async move {
                self.forces.fetch_add(1, Ordering::AcqRel);
                if matches!(self.mode, FakeMode::Block) {
                    self.release_one();
                }
                true
            })
        }
    }

    #[derive(Default)]
    struct RetryCleanupFixture {
        converges: AtomicBool,
        force_calls: AtomicUsize,
        audit: StdMutex<Vec<&'static str>>,
    }

    impl SupportExecutionCleanup for RetryCleanupFixture {
        fn shutdown<'a>(&'a self) -> ExplanationFuture<'a, bool> {
            Box::pin(async move {
                self.audit
                    .lock()
                    .expect("cleanup audit")
                    .push("construction-cleanup-graceful");
                self.converges.load(Ordering::Acquire)
            })
        }

        fn force_shutdown_now<'a>(&'a self) -> ExplanationFuture<'a, bool> {
            Box::pin(async move {
                self.force_calls.fetch_add(1, Ordering::AcqRel);
                self.audit
                    .lock()
                    .expect("cleanup audit")
                    .push("construction-cleanup-force");
                self.converges.load(Ordering::Acquire)
            })
        }
    }

    #[tokio::test]
    async fn force_shutdown_joins_the_exact_constructing_generation_twice() {
        let executor = IsolatedSupportExecutor::new(CodexSupervisor::new());
        let key = ("request-constructing".to_owned(), 7);
        let canceled = Arc::new(AtomicBool::new(false));
        let force_requested = Arc::new(AtomicBool::new(false));
        let completion = Arc::new(SupportExecutionCompletion::default());
        let task_slot = Arc::new(Mutex::new(None));
        executor.active.lock().await.insert(
            key.clone(),
            SupportExecution {
                generation: 7,
                canceled: canceled.clone(),
                force_requested: force_requested.clone(),
                phase: SupportExecutionPhase::Constructing,
                task: task_slot.clone(),
                completion: completion.clone(),
            },
        );
        let active = executor.active.clone();
        let task_key = key.clone();
        let task_canceled = canceled.clone();
        let task_force = force_requested.clone();
        let task_completion = completion.clone();
        let task = tokio::spawn(async move {
            while !task_canceled.load(Ordering::Acquire) {
                tokio::task::yield_now().await;
            }
            assert!(task_force.load(Ordering::Acquire));
            tokio::time::sleep(Duration::from_millis(5)).await;
            if let Some(execution) = active.lock().await.get_mut(&task_key) {
                execution.phase = SupportExecutionPhase::Terminal;
            }
            task_completion
                .finish(SupportExecutionOutcome {
                    result: Err(SupportRuntimeError::Canceled),
                    cleanup_converged: true,
                    pending_cleanup: None,
                })
                .await;
        });
        let task_handle = task.abort_handle();
        *task_slot.lock().await = Some(task_handle.clone());
        drop(task);

        assert!(
            tokio::time::timeout(Duration::from_millis(100), executor.stop_executions(true),)
                .await
                .expect("constructing cleanup deadline")
        );
        assert!(task_handle.is_finished());
        assert!(executor.active.lock().await.is_empty());
        assert!(executor.stop_executions(true).await);
    }

    #[tokio::test]
    async fn construction_cleanup_failure_is_retained_until_force_retry_converges() {
        let executor = IsolatedSupportExecutor::new(CodexSupervisor::new());
        let key = ("request-construction-failure".to_owned(), 11);
        let cleanup = Arc::new(RetryCleanupFixture::default());
        let cleanup_target = cleanup.clone() as Arc<dyn SupportExecutionCleanup>;
        let completion = Arc::new(SupportExecutionCompletion::default());
        completion
            .finish(SupportExecutionOutcome {
                result: Err(SupportRuntimeError::Protocol),
                cleanup_converged: false,
                pending_cleanup: Some(cleanup_target.clone()),
            })
            .await;
        executor.active.lock().await.insert(
            key.clone(),
            SupportExecution {
                generation: 11,
                canceled: Arc::new(AtomicBool::new(false)),
                force_requested: Arc::new(AtomicBool::new(false)),
                phase: SupportExecutionPhase::Unconverged(cleanup_target),
                task: Arc::new(Mutex::new(None)),
                completion,
            },
        );

        assert!(!executor.cancel("request-construction-failure").await);
        assert!(executor.active.lock().await.contains_key(&key));
        assert!(!executor.stop_executions(true).await);
        assert!(executor.active.lock().await.contains_key(&key));
        assert_eq!(cleanup.force_calls.load(Ordering::Acquire), 1);

        cleanup.converges.store(true, Ordering::Release);
        assert!(executor.stop_executions(true).await);
        assert!(executor.active.lock().await.is_empty());
        assert!(executor.stop_executions(true).await);
        assert_eq!(cleanup.force_calls.load(Ordering::Acquire), 2);
        let audit = cleanup.audit.lock().expect("cleanup audit").join(" ");
        assert!(!audit.contains("/Users/"));
        assert!(!audit.contains("token="));
    }

    #[tokio::test]
    async fn recovery_cleanup_does_not_arm_the_permanent_shutdown_latch() {
        let executor = IsolatedSupportExecutor::new(CodexSupervisor::new());
        assert!(executor.force_cleanup_now().await);
        assert!(!executor.shutting_down.load(Ordering::Acquire));

        assert!(executor.force_shutdown_now().await);
        assert!(executor.shutting_down.load(Ordering::Acquire));
    }

    #[tokio::test]
    async fn graceful_shutdown_reports_executor_failure_then_force_converges() {
        let (controller, executor, _) = harness(FakeMode::Immediate, 1, 2, Duration::from_secs(1));
        executor.shutdown_converges.store(false, Ordering::Release);

        let error = controller
            .shutdown()
            .await
            .expect_err("graceful executor failure");
        assert_eq!(error.code, "CODEX-SUPPORT-SHUTDOWN-INCOMPLETE");
        assert_eq!(executor.shutdowns.load(Ordering::Acquire), 1);
        assert!(controller.force_shutdown_now().await);
        assert_eq!(executor.forces.load(Ordering::Acquire), 1);

        let rejected = controller
            .request(dispatch('e', "request-after-shutdown", 1))
            .await
            .expect("typed shutdown state");
        assert_eq!(
            rejected.error_code.as_deref(),
            Some("CODEX-SUPPORT-SHUTDOWN")
        );
        assert!(!rejected.retryable);
    }

    #[tokio::test]
    async fn cancel_failure_cannot_be_hidden_by_an_empty_executor_shutdown() {
        let (controller, executor, _) = harness(FakeMode::Block, 1, 2, Duration::from_secs(1));
        let request = dispatch('f', "request-cancel-failure", 1);
        controller
            .request(request.clone())
            .await
            .expect("queued request");
        wait_for_status(
            &controller,
            &request,
            CommitExplanationControllerStatus::Running,
        )
        .await;
        executor.cancel_converges.store(false, Ordering::Release);

        let error = controller
            .shutdown()
            .await
            .expect_err("cancel failure must fail graceful shutdown");
        assert_eq!(error.code, "CODEX-SUPPORT-SHUTDOWN-INCOMPLETE");
        assert_eq!(executor.cancels.load(Ordering::Acquire), 1);
        assert_eq!(executor.shutdowns.load(Ordering::Acquire), 1);
        assert_eq!(executor.inflight.load(Ordering::Acquire), 0);

        assert!(controller.force_shutdown_now().await);
        assert_eq!(executor.forces.load(Ordering::Acquire), 1);
    }

    #[derive(Default)]
    struct RecordingEvents {
        states: StdMutex<Vec<CommitExplanationControllerStateV1>>,
        presentations: StdMutex<Vec<CommitExplanationPresentationV1>>,
    }

    impl CommitExplanationEventSink for RecordingEvents {
        fn emit_state(&self, state: &CommitExplanationControllerStateV1) {
            self.states.lock().expect("states").push(state.clone());
        }

        fn emit_presentation(&self, presentation: &CommitExplanationPresentationV1) {
            self.presentations
                .lock()
                .expect("presentations")
                .push(presentation.clone());
        }
    }

    fn harness(
        mode: FakeMode,
        queue_limit: usize,
        cache_limit: usize,
        timeout: Duration,
    ) -> (
        CommitExplanationController,
        Arc<FakeExecutor>,
        Arc<RecordingEvents>,
    ) {
        let executor = Arc::new(FakeExecutor::new(mode));
        let events = Arc::new(RecordingEvents::default());
        (
            CommitExplanationController::with_dependencies(
                executor.clone(),
                events.clone(),
                queue_limit,
                cache_limit,
                timeout,
            ),
            executor,
            events,
        )
    }

    #[derive(Clone)]
    struct FixedReadinessProvider(SupportReleaseReadinessV1);

    impl SupportReadinessProvider for FixedReadinessProvider {
        fn snapshot<'a>(&'a self) -> ExplanationFuture<'a, SupportReleaseReadinessV1> {
            Box::pin(async move { self.0.clone() })
        }
    }

    fn policy_harness(
        mode: FakeMode,
        readiness: SupportReleaseReadinessV1,
    ) -> (
        CommitExplanationController,
        Arc<FakeExecutor>,
        Arc<RecordingEvents>,
        PathBuf,
    ) {
        let root = std::env::temp_dir().join(format!(
            "coding-wife-support-policy-{}",
            uuid::Uuid::new_v4()
        ));
        let opened = SupportSettingsStore::open(&root);
        let audit = SupportAuditStore::open(&root, Some(opened.settings.version));
        let executor = Arc::new(FakeExecutor::new(mode));
        let events = Arc::new(RecordingEvents::default());
        let controller = CommitExplanationController::with_control_dependencies(
            executor.clone(),
            events.clone(),
            Arc::new(FixedReadinessProvider(readiness)),
            opened.store,
            audit.store,
            opened.settings,
            audit.state,
            opened.recovery_code,
            SUPPORT_MAX_QUEUE_CAPACITY,
            4,
            Duration::from_secs(2),
        );
        (controller, executor, events, root)
    }

    fn isolated_policy_harness(
        readiness: SupportReleaseReadinessV1,
    ) -> (
        CommitExplanationController,
        Arc<IsolatedSupportExecutor>,
        PathBuf,
    ) {
        let root = std::env::temp_dir().join(format!(
            "coding-wife-support-isolated-policy-{}",
            uuid::Uuid::new_v4()
        ));
        let opened = SupportSettingsStore::open(&root);
        let audit = SupportAuditStore::open(&root, Some(opened.settings.version));
        let executor = Arc::new(IsolatedSupportExecutor::new(CodexSupervisor::new()));
        let controller = CommitExplanationController::with_control_dependencies(
            executor.clone(),
            Arc::new(RecordingEvents::default()),
            Arc::new(FixedReadinessProvider(readiness)),
            opened.store,
            audit.store,
            opened.settings,
            audit.state,
            opened.recovery_code,
            SUPPORT_MAX_QUEUE_CAPACITY,
            4,
            Duration::from_secs(2),
        );
        (controller, executor, root)
    }

    async fn retain_unconverged_execution(
        executor: &IsolatedSupportExecutor,
        cleanup: Arc<RetryCleanupFixture>,
        request_id: &str,
        generation: u64,
    ) {
        let cleanup_target = cleanup as Arc<dyn SupportExecutionCleanup>;
        let completion = Arc::new(SupportExecutionCompletion::default());
        completion
            .finish(SupportExecutionOutcome {
                result: Err(SupportRuntimeError::Protocol),
                cleanup_converged: false,
                pending_cleanup: Some(cleanup_target.clone()),
            })
            .await;
        executor.active.lock().await.insert(
            (request_id.to_owned(), generation),
            SupportExecution {
                generation,
                canceled: Arc::new(AtomicBool::new(false)),
                force_requested: Arc::new(AtomicBool::new(false)),
                phase: SupportExecutionPhase::Unconverged(cleanup_target),
                task: Arc::new(Mutex::new(None)),
                completion,
            },
        );
    }

    fn approved_readiness() -> SupportReleaseReadinessV1 {
        SupportReleaseReadinessV1 {
            status: SupportReadinessStatus::Approved,
            approved_cli_version: SUPPORTED_CLI_VERSION.to_owned(),
            approved_binary_hash_prefix: prefix16(SUPPORTED_ARM64_BINARY_SHA256),
            approved_schema_fingerprint_prefix: prefix16(SUPPORTED_SCHEMA_FINGERPRINT),
            observed_cli_version: Some(SUPPORTED_CLI_VERSION.to_owned()),
            observed_binary_hash_prefix: Some(prefix16(SUPPORTED_ARM64_BINARY_SHA256)),
            observed_schema_fingerprint_prefix: Some(prefix16(SUPPORTED_SCHEMA_FINGERPRINT)),
            skill_name: EXPLAIN_COMMIT_SKILL_NAME.to_owned(),
            skill_version: Some("1.1.0".to_owned()),
            skill_digest_prefix: Some("0123456789abcdef".to_owned()),
            reason_code: None,
            checked_at: now(),
        }
    }

    fn approved_release_evidence() -> SupportReleaseIdentityEvidence {
        SupportReleaseIdentityEvidence {
            diagnostic: super::super::types::CodexDiagnostic {
                health: CodexHealth::Ready,
                ..super::super::types::CodexDiagnostic::default()
            },
            cli_version: Some(SUPPORTED_CLI_VERSION.to_owned()),
            executable_sha256: Some(SUPPORTED_ARM64_BINARY_SHA256.to_owned()),
            schema_fingerprint: Some(SUPPORTED_SCHEMA_FINGERPRINT.to_owned()),
            generated_by_same_binary: true,
        }
    }

    fn approved_release_skill() -> ResolvedBundledSkill {
        ResolvedBundledSkill {
            name: EXPLAIN_COMMIT_SKILL_NAME.to_owned(),
            version: SUPPORTED_EXPLAIN_SKILL_VERSION.to_owned(),
            content_digest: format!("sha256:{SUPPORTED_EXPLAIN_SKILL_SHA256}"),
            path: PathBuf::from("verified-fixture/SKILL.md"),
            verified_entrypoint: Arc::from(&b"verified fixture"[..]),
        }
    }

    fn same_prefix_tail_mismatch(value: &str) -> String {
        let mut bytes = value.as_bytes().to_vec();
        let last = bytes.last_mut().expect("nonempty identity");
        *last = if *last == b'0' { b'1' } else { b'0' };
        String::from_utf8(bytes).expect("ascii identity")
    }

    fn dispatch(hex: char, request_id: &str, generation: u64) -> CommitExplanationDispatchV1 {
        let sha = hex.to_string().repeat(40);
        let commit_evidence_id = format!("commit-{sha}");
        CommitExplanationDispatchV1 {
            request: CommitExplanationRequestedV1 {
                schema_version: 1,
                request_id: request_id.to_owned(),
                workspace_id: "workspace-fixture".to_owned(),
                workspace_generation: generation,
                commit_evidence_id: commit_evidence_id.clone(),
                locale: "ja".to_owned(),
                selection_version: 1,
                trigger: CommitExplanationTrigger::UserRequest,
                requested_at: "2026-07-18T00:00:00Z".to_owned(),
            },
            evidence: CommitEvidenceV1 {
                schema_version: 1,
                commit_id: commit_evidence_id,
                subject: "Commit subject".to_owned(),
                body: String::new(),
                changes: Vec::new(),
                diff_summary: DiffSummary {
                    files_changed: 1,
                    additions: 2,
                    deletions: 1,
                    binary_files: 0,
                },
                verification: Vec::new(),
                decisions: Vec::new(),
                risks: Vec::new(),
                locale: "ja".to_owned(),
                workspace_generation: generation,
                selection_version: 1,
            },
        }
    }

    fn result(request: &SupportExplainRequest) -> SupportExplainResult {
        SupportExplainResult {
            request_id: request.request_id.clone(),
            explanation: CommitExplanationV1 {
                schema_version: 1,
                locale: request.evidence.locale.clone(),
                summary: "要約".to_owned(),
                changes: vec!["変更".to_owned()],
                reasons: vec!["理由".to_owned()],
                verification: vec!["検証".to_owned()],
                impact: vec!["影響".to_owned()],
                cautions: vec!["注意".to_owned()],
                how_to_read_next: vec!["次".to_owned()],
                narration_chunks: vec![super::super::support::ExplanationNarrationChunk {
                    sequence: 1,
                    section: "summary".to_owned(),
                    text: "要約".to_owned(),
                }],
            },
            usage: SupportUsage {
                input_tokens: 10,
                output_tokens: 5,
                total_tokens: 15,
            },
            latency_ms: 12,
        }
    }

    async fn wait_for_status(
        controller: &CommitExplanationController,
        dispatch: &CommitExplanationDispatchV1,
        expected: CommitExplanationControllerStatus,
    ) -> CommitExplanationControllerStateV1 {
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let state = controller
                    .get_state(CommitExplanationStateRequestedV1 {
                        schema_version: 1,
                        workspace_id: dispatch.request.workspace_id.clone(),
                        workspace_generation: dispatch.request.workspace_generation,
                        commit_evidence_id: dispatch.request.commit_evidence_id.clone(),
                    })
                    .await
                    .expect("state");
                if state.status == expected {
                    return state;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("state timeout")
    }

    #[test]
    fn status_trigger_and_timeout_contracts_are_exact() {
        let statuses = [
            CommitExplanationControllerStatus::NotGenerated,
            CommitExplanationControllerStatus::Queued,
            CommitExplanationControllerStatus::Running,
            CommitExplanationControllerStatus::Generated,
            CommitExplanationControllerStatus::Failed,
            CommitExplanationControllerStatus::Unavailable,
            CommitExplanationControllerStatus::Canceled,
        ];
        assert_eq!(statuses.len(), 7);
        assert_eq!(
            statuses
                .iter()
                .map(|status| serde_json::to_string(status).expect("status"))
                .collect::<Vec<_>>(),
            vec![
                "\"not_generated\"",
                "\"queued\"",
                "\"running\"",
                "\"generated\"",
                "\"failed\"",
                "\"unavailable\"",
                "\"canceled\"",
            ]
        );
        assert!(serde_json::from_str::<CommitExplanationControllerStatus>("\"timeout\"").is_err());
        for trigger in ["auto_verified_commit", "user_request", "user_retry"] {
            assert!(
                serde_json::from_str::<CommitExplanationTrigger>(&format!("\"{trigger}\"")).is_ok()
            );
        }
        assert!(serde_json::from_str::<CommitExplanationTrigger>("\"selection\"").is_err());
        assert_eq!(SUPPORT_TASK_TIMEOUT, Duration::from_secs(15));
    }

    #[tokio::test]
    async fn queue_is_single_active_bounded_and_overflow_is_unavailable() {
        let (controller, executor, _) = harness(FakeMode::Block, 1, 4, Duration::from_secs(2));
        let first = dispatch('a', "request-first", 1);
        let second = dispatch('b', "request-second", 1);
        let third = dispatch('c', "request-third", 1);

        controller.request(first.clone()).await.expect("first");
        wait_for_status(
            &controller,
            &first,
            CommitExplanationControllerStatus::Running,
        )
        .await;
        assert_eq!(
            controller
                .request(second.clone())
                .await
                .expect("second")
                .status,
            CommitExplanationControllerStatus::Queued
        );
        assert_eq!(
            controller.request(third).await.expect("third").status,
            CommitExplanationControllerStatus::Unavailable
        );

        executor.release_one();
        wait_for_status(
            &controller,
            &first,
            CommitExplanationControllerStatus::Generated,
        )
        .await;
        wait_for_status(
            &controller,
            &second,
            CommitExplanationControllerStatus::Running,
        )
        .await;
        assert_eq!(executor.maximum_inflight.load(Ordering::Acquire), 1);
        executor.release_one();
        wait_for_status(
            &controller,
            &second,
            CommitExplanationControllerStatus::Generated,
        )
        .await;
    }

    #[tokio::test]
    async fn auto_generation_is_silent_and_explicit_request_reuses_cache_for_presentation() {
        let (controller, executor, events) =
            harness(FakeMode::Immediate, 2, 4, Duration::from_secs(1));
        let mut first = dispatch('a', "request-first", 1);
        first.request.trigger = CommitExplanationTrigger::AutoVerifiedCommit;
        controller.request(first.clone()).await.expect("first");
        let generated = wait_for_status(
            &controller,
            &first,
            CommitExplanationControllerStatus::Generated,
        )
        .await;
        assert!(events.presentations.lock().expect("events").is_empty());

        let mut duplicate = dispatch('a', "request-duplicate", 1);
        duplicate.request.selection_version = 2;
        duplicate.evidence.selection_version = 2;
        let duplicate_state = controller
            .request(duplicate.clone())
            .await
            .expect("duplicate");
        assert_eq!(
            duplicate_state.request_id.as_deref(),
            Some("request-duplicate")
        );
        assert_eq!(duplicate_state.selection_version, Some(2));
        assert_eq!(duplicate_state.status, generated.status);
        assert_eq!(executor.calls.load(Ordering::Acquire), 1);

        let replay = controller
            .present(CommitExplanationPresentationRequestedV1 {
                schema_version: 1,
                workspace_id: first.request.workspace_id.clone(),
                workspace_generation: 1,
                commit_evidence_id: first.request.commit_evidence_id.clone(),
                request_id: duplicate.request.request_id.clone(),
                mode: CommitExplanationPresentationMode::ReplayNarration,
                requested_at: now(),
            })
            .await
            .expect("replay");
        assert_eq!(
            replay.mode,
            CommitExplanationPresentationMode::ReplayNarration
        );
        assert_eq!(events.presentations.lock().expect("events").len(), 1);
    }

    #[tokio::test]
    async fn active_dedupe_rebinds_the_latest_selection_and_cancels_the_underlying_task() {
        let (controller, executor, _) = harness(FakeMode::Block, 2, 4, Duration::from_secs(2));
        let first = dispatch('a', "request-first", 1);
        controller.request(first.clone()).await.expect("first");
        wait_for_status(
            &controller,
            &first,
            CommitExplanationControllerStatus::Running,
        )
        .await;

        let mut rebound = dispatch('a', "request-rebound", 1);
        rebound.request.selection_version = 2;
        rebound.evidence.selection_version = 2;
        let state = controller.request(rebound.clone()).await.expect("rebound");
        assert_eq!(state.request_id.as_deref(), Some("request-rebound"));
        assert_eq!(state.selection_version, Some(2));
        assert_eq!(state.status, CommitExplanationControllerStatus::Running);
        assert_eq!(executor.calls.load(Ordering::Acquire), 1);

        let canceled = controller
            .cancel(CommitExplanationCancelRequestedV1 {
                schema_version: 1,
                request_id: "request-rebound".to_owned(),
                workspace_generation: 1,
                selection_version: 2,
                reason: CommitExplanationCancelReason::User,
                requested_at: now(),
            })
            .await
            .expect("cancel")
            .expect("canceled state");
        assert_eq!(canceled.request_id.as_deref(), Some("request-rebound"));
        assert_eq!(executor.cancels.load(Ordering::Acquire), 1);

        let mut terminal_rebound = dispatch('a', "request-terminal-rebound", 1);
        terminal_rebound.request.selection_version = 3;
        terminal_rebound.evidence.selection_version = 3;
        let terminal = controller
            .request(terminal_rebound)
            .await
            .expect("terminal rebound");
        assert_eq!(
            terminal.request_id.as_deref(),
            Some("request-terminal-rebound")
        );
        assert_eq!(terminal.selection_version, Some(3));
        assert_eq!(terminal.status, CommitExplanationControllerStatus::Canceled);
        assert_eq!(executor.calls.load(Ordering::Acquire), 1);
    }

    #[tokio::test]
    async fn explicit_rebind_is_monotonic_and_cannot_be_downgraded_by_concurrent_auto_replays() {
        let (controller, executor, _) = harness(FakeMode::Block, 2, 4, Duration::from_secs(2));
        let mut automatic = dispatch('a', "request-auto", 1);
        automatic.request.trigger = CommitExplanationTrigger::AutoVerifiedCommit;
        controller
            .request(automatic.clone())
            .await
            .expect("automatic request");
        wait_for_status(
            &controller,
            &automatic,
            CommitExplanationControllerStatus::Running,
        )
        .await;

        let mut explicit = dispatch('a', "request-explicit-v2", 1);
        explicit.request.selection_version = 2;
        explicit.evidence.selection_version = 2;
        let rebound = controller
            .request(explicit.clone())
            .await
            .expect("explicit rebound");
        assert_eq!(rebound.request_id.as_deref(), Some("request-explicit-v2"));
        assert_eq!(rebound.selection_version, Some(2));
        assert_eq!(rebound.trigger, Some(CommitExplanationTrigger::UserRequest));

        let mut stale_auto = automatic.clone();
        stale_auto.request.request_id = "request-auto-v1-replay".to_owned();
        let mut newer_auto = automatic.clone();
        newer_auto.request.request_id = "request-auto-v3-replay".to_owned();
        newer_auto.request.selection_version = 3;
        newer_auto.evidence.selection_version = 3;
        let (stale, newer) = tokio::join!(
            controller.request(stale_auto),
            controller.request(newer_auto)
        );
        for state in [stale.expect("stale auto"), newer.expect("newer auto")] {
            assert_eq!(state.request_id.as_deref(), Some("request-explicit-v2"));
            assert_eq!(state.selection_version, Some(2));
            assert_eq!(state.trigger, Some(CommitExplanationTrigger::UserRequest));
        }
        assert_eq!(executor.calls.load(Ordering::Acquire), 1);

        executor.release_one();
        let terminal = wait_for_status(
            &controller,
            &explicit,
            CommitExplanationControllerStatus::Generated,
        )
        .await;
        assert_eq!(terminal.request_id.as_deref(), Some("request-explicit-v2"));
        assert_eq!(terminal.selection_version, Some(2));
        assert_eq!(
            terminal.trigger,
            Some(CommitExplanationTrigger::UserRequest)
        );
        assert_eq!(executor.calls.load(Ordering::Acquire), 1);
    }

    #[tokio::test]
    async fn public_request_cannot_claim_auto_verified_authority_and_cache_is_bounded() {
        let (controller, executor, _) = harness(FakeMode::Immediate, 2, 1, Duration::from_secs(1));
        let mut forged = dispatch('a', "request-forged-auto", 1);
        forged.request.trigger = CommitExplanationTrigger::AutoVerifiedCommit;
        assert_eq!(
            controller
                .request_user(forged)
                .await
                .expect_err("public auto trigger")
                .code,
            "CODEX-SUPPORT-AUTO-TRIGGER-FORBIDDEN"
        );

        let first = dispatch('a', "request-first", 1);
        let second = dispatch('b', "request-second", 1);
        controller.request(first.clone()).await.expect("first");
        wait_for_status(
            &controller,
            &first,
            CommitExplanationControllerStatus::Generated,
        )
        .await;
        controller.request(second.clone()).await.expect("second");
        wait_for_status(
            &controller,
            &second,
            CommitExplanationControllerStatus::Generated,
        )
        .await;
        assert_eq!(executor.calls.load(Ordering::Acquire), 2);
        assert_eq!(
            controller
                .get_state(CommitExplanationStateRequestedV1 {
                    schema_version: 1,
                    workspace_id: first.request.workspace_id,
                    workspace_generation: 1,
                    commit_evidence_id: first.request.commit_evidence_id,
                })
                .await
                .expect("evicted state")
                .status,
            CommitExplanationControllerStatus::NotGenerated
        );
    }

    #[tokio::test]
    async fn active_cancel_interrupts_and_late_result_stays_canceled() {
        let (controller, executor, _) = harness(FakeMode::Block, 2, 4, Duration::from_secs(2));
        let task = dispatch('a', "request-cancel", 1);
        controller.request(task.clone()).await.expect("request");
        wait_for_status(
            &controller,
            &task,
            CommitExplanationControllerStatus::Running,
        )
        .await;
        let canceled = controller
            .cancel(CommitExplanationCancelRequestedV1 {
                schema_version: 1,
                request_id: task.request.request_id.clone(),
                workspace_generation: 1,
                selection_version: 1,
                reason: CommitExplanationCancelReason::User,
                requested_at: now(),
            })
            .await
            .expect("cancel")
            .expect("state");
        assert_eq!(canceled.status, CommitExplanationControllerStatus::Canceled);
        assert_eq!(executor.cancels.load(Ordering::Acquire), 1);
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert_eq!(
            wait_for_status(
                &controller,
                &task,
                CommitExplanationControllerStatus::Canceled,
            )
            .await
            .status,
            CommitExplanationControllerStatus::Canceled
        );
    }

    #[tokio::test]
    async fn timeout_calls_cancel_and_is_retryable_failed() {
        let (controller, executor, _) = harness(FakeMode::Never, 1, 4, Duration::from_millis(20));
        let task = dispatch('a', "request-timeout", 1);
        controller.request(task.clone()).await.expect("request");
        let failed = wait_for_status(
            &controller,
            &task,
            CommitExplanationControllerStatus::Failed,
        )
        .await;
        assert!(failed.retryable);
        assert_eq!(failed.error_code.as_deref(), Some("CODEX-SUPPORT-TIMEOUT"));
        assert_eq!(executor.cancels.load(Ordering::Acquire), 1);
    }

    #[tokio::test]
    async fn generation_change_preserves_old_jobs_while_shutdown_still_cancels() {
        let (controller, executor, _) = harness(FakeMode::Block, 2, 4, Duration::from_secs(2));
        let active = dispatch('a', "request-active", 1);
        let queued = dispatch('b', "request-queued", 1);
        controller.request(active.clone()).await.expect("active");
        wait_for_status(
            &controller,
            &active,
            CommitExplanationControllerStatus::Running,
        )
        .await;
        controller.request(queued.clone()).await.expect("queued");
        controller
            .set_scope(CommitExplanationScopeRequestedV1 {
                schema_version: 1,
                workspace_id: active.request.workspace_id.clone(),
                workspace_generation: 2,
                locale: "ja".to_owned(),
            })
            .await
            .expect("scope");
        assert_eq!(executor.cancels.load(Ordering::Acquire), 0);
        executor.release_one();
        wait_for_status(
            &controller,
            &active,
            CommitExplanationControllerStatus::Generated,
        )
        .await;
        wait_for_status(
            &controller,
            &queued,
            CommitExplanationControllerStatus::Running,
        )
        .await;
        executor.release_one();
        wait_for_status(
            &controller,
            &queued,
            CommitExplanationControllerStatus::Generated,
        )
        .await;

        let stale = dispatch('c', "request-stale", 1);
        assert_eq!(
            controller.request(stale).await.expect("stale").status,
            CommitExplanationControllerStatus::Unavailable
        );

        let current = dispatch('d', "request-current", 2);
        controller.request(current.clone()).await.expect("current");
        wait_for_status(
            &controller,
            &current,
            CommitExplanationControllerStatus::Running,
        )
        .await;
        controller.shutdown().await.expect("controller shutdown");
        assert_eq!(
            wait_for_status(
                &controller,
                &current,
                CommitExplanationControllerStatus::Canceled,
            )
            .await
            .error_code
            .as_deref(),
            Some("CODEX-SUPPORT-SHUTDOWN")
        );
        assert!(executor.cancels.load(Ordering::Acquire) >= 1);
    }

    #[tokio::test]
    async fn workspace_and_locale_scope_changes_preserve_old_work_and_cache() {
        let (controller, executor, _) = harness(FakeMode::Block, 2, 4, Duration::from_secs(2));
        controller
            .set_scope(CommitExplanationScopeRequestedV1 {
                schema_version: 1,
                workspace_id: "workspace-fixture".to_owned(),
                workspace_generation: 1,
                locale: "ja".to_owned(),
            })
            .await
            .expect("initial scope");
        let active = dispatch('a', "request-scoped", 1);
        controller.request(active.clone()).await.expect("request");
        let running = wait_for_status(
            &controller,
            &active,
            CommitExplanationControllerStatus::Running,
        )
        .await;
        assert_eq!(running.locale.as_deref(), Some("ja"));
        assert_eq!(running.selection_version, Some(1));

        controller
            .set_scope(CommitExplanationScopeRequestedV1 {
                schema_version: 1,
                workspace_id: "workspace-other".to_owned(),
                workspace_generation: 1,
                locale: "en".to_owned(),
            })
            .await
            .expect("workspace switch");
        let still_running = wait_for_status(
            &controller,
            &active,
            CommitExplanationControllerStatus::Running,
        )
        .await;
        assert_eq!(still_running.locale.as_deref(), Some("ja"));
        assert_eq!(still_running.selection_version, Some(1));
        assert_eq!(executor.cancels.load(Ordering::Acquire), 0);
        executor.release_one();
        wait_for_status(
            &controller,
            &active,
            CommitExplanationControllerStatus::Generated,
        )
        .await;
        controller
            .set_scope(CommitExplanationScopeRequestedV1 {
                schema_version: 1,
                workspace_id: "workspace-fixture".to_owned(),
                workspace_generation: 1,
                locale: "ja".to_owned(),
            })
            .await
            .expect("return to original scope");
        assert_eq!(
            controller
                .get_state(CommitExplanationStateRequestedV1 {
                    schema_version: 1,
                    workspace_id: active.request.workspace_id.clone(),
                    workspace_generation: 1,
                    commit_evidence_id: active.request.commit_evidence_id.clone(),
                })
                .await
                .expect("preserved state")
                .status,
            CommitExplanationControllerStatus::Generated
        );
        controller
            .set_scope(CommitExplanationScopeRequestedV1 {
                schema_version: 1,
                workspace_id: "workspace-other".to_owned(),
                workspace_generation: 1,
                locale: "en".to_owned(),
            })
            .await
            .expect("restore other scope");
        assert_eq!(
            controller
                .trusted_enqueuer()
                .locale_for_scope("workspace-other", 1)
                .await
                .as_deref(),
            Some("en")
        );
        assert!(controller
            .trusted_enqueuer()
            .locale_for_scope("workspace-fixture", 1)
            .await
            .is_none());
    }

    #[tokio::test]
    async fn unapproved_release_is_deterministic_fallback_without_model_use() {
        let mut readiness = approved_readiness();
        readiness.status = SupportReadinessStatus::Blocked;
        readiness.observed_cli_version = Some("0.145.0".to_owned());
        readiness.observed_binary_hash_prefix = Some("ffffffffffffffff".to_owned());
        readiness.reason_code = Some("CODEX-SUPPORT-RELEASE-UNSUPPORTED".to_owned());
        let (controller, executor, _, root) = policy_harness(FakeMode::Immediate, readiness);
        let request = dispatch('e', "request-unapproved-release", 1);
        let state = controller.request(request).await.expect("fallback");
        assert_eq!(state.status, CommitExplanationControllerStatus::Unavailable);
        assert_eq!(
            state.error_code.as_deref(),
            Some("CODEX-SUPPORT-RELEASE-UNSUPPORTED")
        );
        assert_eq!(executor.calls.load(Ordering::Acquire), 0);
        let data = controller.inner.data.lock().await;
        assert!(data.active.is_none());
        assert!(data.queue.is_empty());
        assert_eq!(data.usage.started_tasks, 0);
        assert_eq!(data.usage.unavailable_tasks, 1);
        let readiness = data.last_readiness.as_ref().expect("readiness snapshot");
        assert_eq!(
            support_gate_reason(&data, readiness).as_deref(),
            Some("CODEX-SUPPORT-RELEASE-UNSUPPORTED")
        );
        drop(data);
        std::fs::remove_dir_all(root).expect("cleanup");
    }

    #[tokio::test]
    async fn release_admission_uses_full_exact_identities_not_display_prefixes() {
        let evidence = approved_release_evidence();
        let skill = approved_release_skill();
        assert_eq!(
            evaluate_support_readiness(&evidence, Some(&skill)).status,
            SupportReadinessStatus::Approved
        );

        let mut binary_tail = evidence.clone();
        binary_tail.executable_sha256 = Some(same_prefix_tail_mismatch(
            binary_tail
                .executable_sha256
                .as_deref()
                .expect("binary identity"),
        ));
        let binary_blocked = evaluate_support_readiness(&binary_tail, Some(&skill));
        assert_eq!(binary_blocked.status, SupportReadinessStatus::Blocked);
        assert_eq!(
            binary_blocked.reason_code.as_deref(),
            Some("CODEX-SUPPORT-RELEASE-UNSUPPORTED")
        );
        assert_eq!(
            binary_blocked.observed_binary_hash_prefix,
            Some(prefix16(SUPPORTED_ARM64_BINARY_SHA256))
        );

        let mut schema_tail = evidence.clone();
        schema_tail.schema_fingerprint = Some(same_prefix_tail_mismatch(
            schema_tail
                .schema_fingerprint
                .as_deref()
                .expect("schema identity"),
        ));
        let schema_blocked = evaluate_support_readiness(&schema_tail, Some(&skill));
        assert_eq!(schema_blocked.status, SupportReadinessStatus::Blocked);
        assert_eq!(
            schema_blocked.reason_code.as_deref(),
            Some("CODEX-SUPPORT-SCHEMA-UNVERIFIED")
        );
        assert_eq!(
            schema_blocked.observed_schema_fingerprint_prefix,
            Some(prefix16(SUPPORTED_SCHEMA_FINGERPRINT))
        );

        let mut skill_tail = skill.clone();
        skill_tail.content_digest = format!(
            "sha256:{}",
            same_prefix_tail_mismatch(SUPPORTED_EXPLAIN_SKILL_SHA256)
        );
        let skill_blocked = evaluate_support_readiness(&evidence, Some(&skill_tail));
        assert_eq!(skill_blocked.status, SupportReadinessStatus::Blocked);
        assert_eq!(
            skill_blocked.reason_code.as_deref(),
            Some("CODEX-SUPPORT-SKILL-INVALID")
        );
        assert_eq!(
            skill_blocked.skill_digest_prefix,
            Some(prefix16(SUPPORTED_EXPLAIN_SKILL_SHA256))
        );

        let (controller, executor, _, root) = policy_harness(FakeMode::Immediate, binary_blocked);
        let state = controller
            .request(dispatch('f', "request-full-identity-tail", 1))
            .await
            .expect("deterministic fallback");
        assert_eq!(state.status, CommitExplanationControllerStatus::Unavailable);
        assert_eq!(executor.calls.load(Ordering::Acquire), 0);
        let data = controller.inner.data.lock().await;
        assert_eq!(data.usage.started_tasks, 0);
        assert_eq!(data.usage.succeeded_tasks, 0);
        assert_eq!(data.fallback_tasks, 1);
        drop(data);
        std::fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn events_are_dedicated_and_never_use_main_codex_channels() {
        assert_ne!(
            COMMIT_EXPLANATION_STATE_EVENT_CHANNEL,
            super::super::supervisor::CODEX_EVENT_CHANNEL
        );
        assert_ne!(
            COMMIT_EXPLANATION_PRESENTATION_EVENT_CHANNEL,
            super::super::supervisor::CODEX_EVENT_CHANNEL
        );
        assert_ne!(
            COMMIT_EXPLANATION_STATE_EVENT_CHANNEL,
            super::super::supervisor::DOMAIN_EVENT_CHANNEL
        );
        assert_ne!(
            COMMIT_EXPLANATION_PRESENTATION_EVENT_CHANNEL,
            super::super::supervisor::DOMAIN_EVENT_CHANNEL
        );
    }
}
