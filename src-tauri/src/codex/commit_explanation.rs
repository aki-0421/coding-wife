//! App-owned commit explanation queue and isolated support-process boundary.
//!
//! This module intentionally has no dependency on the main Codex event stream or
//! workspace conversation history. Only bounded commit evidence crosses into the
//! single-use support runtime.

use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Weak};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::sync::{Mutex, Notify};

use crate::git_review::types::CommitEvidenceV1;

use super::supervisor::CodexSupervisor;
use super::support::{
    CommitExplanationTrigger, CommitExplanationV1, SupportExplainRequest, SupportExplainResult,
    SupportRuntime, SupportRuntimeError, SupportUsage, SUPPORT_TASK_TIMEOUT,
};

pub const COMMIT_EXPLANATION_STATE_EVENT_CHANNEL: &str = "coding-wife://commit-explanation-state";
pub const COMMIT_EXPLANATION_PRESENTATION_EVENT_CHANNEL: &str =
    "coding-wife://commit-explanation-presentation";
pub const COMMIT_EXPLANATION_QUEUE_LIMIT: usize = 16;
pub const COMMIT_EXPLANATION_CACHE_LIMIT: usize = 64;

const OPERATION_REQUEST: &str = "commit_explanation.request";
const OPERATION_CANCEL: &str = "commit_explanation.cancel";
const OPERATION_PRESENT: &str = "commit_explanation.present";
const OPERATION_STATE: &str = "commit_explanation.state";
const OPERATION_SCOPE: &str = "commit_explanation.scope";

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
}

impl ExplanationKey {
    fn from_request(request: &CommitExplanationRequestedV1) -> Self {
        Self {
            workspace_id: request.workspace_id.clone(),
            workspace_generation: request.workspace_generation,
            commit_evidence_id: request.commit_evidence_id.clone(),
        }
    }

    fn from_state_request(request: &CommitExplanationStateRequestedV1) -> Self {
        Self {
            workspace_id: request.workspace_id.clone(),
            workspace_generation: request.workspace_generation,
            commit_evidence_id: request.commit_evidence_id.clone(),
        }
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
    cache: HashMap<ExplanationKey, CachedExplanation>,
    cache_order: VecDeque<ExplanationKey>,
}

trait CommitExplanationExecutor: Send + Sync {
    fn execute<'a>(
        &'a self,
        request: SupportExplainRequest,
        canceled: Arc<AtomicBool>,
    ) -> ExplanationFuture<'a, Result<SupportExplainResult, SupportRuntimeError>>;

    fn cancel<'a>(&'a self, request_id: &'a str) -> ExplanationFuture<'a, bool>;
}

trait CommitExplanationEventSink: Send + Sync {
    fn emit_state(&self, state: &CommitExplanationControllerStateV1);
    fn emit_presentation(&self, presentation: &CommitExplanationPresentationV1);
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
    active: Arc<Mutex<HashMap<String, SupportExecution>>>,
}

#[derive(Clone)]
struct SupportExecution {
    canceled: Arc<AtomicBool>,
    runtime: Option<Arc<SupportRuntime>>,
    completion: Arc<SupportExecutionCompletion>,
}

#[derive(Default)]
struct SupportExecutionCompletion {
    done: AtomicBool,
    notify: Notify,
}

impl SupportExecutionCompletion {
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

impl IsolatedSupportExecutor {
    fn new(supervisor: CodexSupervisor) -> Self {
        Self {
            supervisor,
            active: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    async fn run_owned(
        self,
        request: SupportExplainRequest,
        canceled: Arc<AtomicBool>,
    ) -> Result<SupportExplainResult, SupportRuntimeError> {
        let request_id = request.request_id.clone();
        let context = self
            .supervisor
            .support_runtime_context(&request.workspace_id, request.evidence.workspace_generation)
            .await
            .ok_or(SupportRuntimeError::UnsupportedRelease)?;
        let runtime =
            Arc::new(SupportRuntime::construct(&context.0, &context.1, &context.2, None).await?);
        {
            let mut active = self.active.lock().await;
            let Some(execution) = active.get_mut(&request_id) else {
                runtime.shutdown().await?;
                return Err(SupportRuntimeError::Canceled);
            };
            execution.runtime = Some(runtime.clone());
        }
        let result = if canceled.load(Ordering::Acquire) {
            let _ = runtime.cancel().await;
            Err(SupportRuntimeError::Canceled)
        } else {
            runtime.explain_commit(request).await
        };
        let cleanup = runtime.shutdown().await;
        self.active.lock().await.remove(&request_id);
        match (result, cleanup) {
            (Ok(result), Ok(())) => Ok(result),
            (Err(error), _) => Err(error),
            (Ok(_), Err(error)) => Err(error),
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
            let completion = Arc::new(SupportExecutionCompletion::default());
            self.active.lock().await.insert(
                request_id,
                SupportExecution {
                    canceled: canceled.clone(),
                    runtime: None,
                    completion: completion.clone(),
                },
            );
            let executor = self.clone();
            let cleanup = self.clone();
            let cleanup_request_id = request.request_id.clone();
            tokio::spawn(async move {
                let result = executor.run_owned(request, canceled).await;
                completion.finish();
                cleanup.active.lock().await.remove(&cleanup_request_id);
                result
            })
            .await
            .unwrap_or(Err(SupportRuntimeError::Process))
        })
    }

    fn cancel<'a>(&'a self, request_id: &'a str) -> ExplanationFuture<'a, bool> {
        Box::pin(async move {
            let execution = self.active.lock().await.get(request_id).cloned();
            let Some(execution) = execution else {
                return false;
            };
            execution.canceled.store(true, Ordering::Release);
            if let Some(runtime) = execution.runtime {
                let _ = runtime.cancel().await;
                let _ = runtime.shutdown().await;
            }
            execution.completion.wait().await;
            true
        })
    }
}

struct CommitExplanationControllerInner {
    data: Mutex<ControllerData>,
    executor: Arc<dyn CommitExplanationExecutor>,
    events: Arc<dyn CommitExplanationEventSink>,
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
    pub fn production(supervisor: CodexSupervisor, app_handle: AppHandle) -> Self {
        Self::with_dependencies(
            Arc::new(IsolatedSupportExecutor::new(supervisor)),
            Arc::new(TauriCommitExplanationEventSink { app_handle }),
            COMMIT_EXPLANATION_QUEUE_LIMIT,
            COMMIT_EXPLANATION_CACHE_LIMIT,
            SUPPORT_TASK_TIMEOUT,
        )
    }

    fn with_dependencies(
        executor: Arc<dyn CommitExplanationExecutor>,
        events: Arc<dyn CommitExplanationEventSink>,
        queue_limit: usize,
        cache_limit: usize,
        task_timeout: Duration,
    ) -> Self {
        Self {
            inner: Arc::new(CommitExplanationControllerInner {
                data: Mutex::new(ControllerData::default()),
                executor,
                events,
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

    pub async fn request(
        &self,
        dispatch: CommitExplanationDispatchV1,
    ) -> Result<CommitExplanationControllerStateV1, CommitExplanationControllerError> {
        validate_dispatch(&dispatch)?;
        let key = ExplanationKey::from_request(&dispatch.request);
        let mut data = self.inner.data.lock().await;
        match data.generations.get(&key.workspace_id).copied() {
            Some(generation) if generation > key.workspace_generation => {
                let state = terminal_state(
                    &dispatch.request,
                    CommitExplanationControllerStatus::Unavailable,
                    true,
                    Some("CODEX-SUPPORT-WORKSPACE-STALE"),
                );
                data.states.insert(key, state.clone());
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
                let state = terminal_state(
                    &dispatch.request,
                    CommitExplanationControllerStatus::Unavailable,
                    true,
                    Some("CODEX-SUPPORT-WORKSPACE-STALE"),
                );
                data.states.insert(key, state.clone());
                drop(data);
                self.inner.events.emit_state(&state);
                return Ok(state);
            }
        }

        if let Some(existing) = data.states.get(&key).cloned() {
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
            let state = terminal_state(
                &dispatch.request,
                CommitExplanationControllerStatus::Unavailable,
                true,
                Some("CODEX-SUPPORT-QUEUE-FULL"),
            );
            data.states.insert(key, state.clone());
            drop(data);
            self.inner.events.emit_state(&state);
            return Ok(state);
        }

        let state = lifecycle_state(&dispatch.request, CommitExplanationControllerStatus::Queued);
        data.states.insert(key.clone(), state.clone());
        data.queue.push_back(ExplanationTask { key, dispatch });
        let start_worker = !data.worker_running;
        if start_worker {
            data.worker_running = true;
        }
        drop(data);
        self.inner.events.emit_state(&state);
        if start_worker {
            let controller = self.clone();
            tauri::async_runtime::spawn(async move {
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
        drop(data);
        self.inner.events.emit_state(&state);
        if let Some(executor_request_id) = active_executor_request_id {
            let _ = self.inner.executor.cancel(&executor_request_id).await;
        }
        Ok(Some(state))
    }

    pub async fn present(
        &self,
        request: CommitExplanationPresentationRequestedV1,
    ) -> Result<CommitExplanationPresentationV1, CommitExplanationControllerError> {
        validate_presentation(&request)?;
        let key = ExplanationKey {
            workspace_id: request.workspace_id.clone(),
            workspace_generation: request.workspace_generation,
            commit_evidence_id: request.commit_evidence_id.clone(),
        };
        let cached = self
            .inner
            .data
            .lock()
            .await
            .cache
            .get(&key)
            .cloned()
            .filter(|cached| cached.request.request_id == request.request_id)
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
        let key = ExplanationKey::from_state_request(&request);
        Ok(self
            .inner
            .data
            .lock()
            .await
            .states
            .get(&key)
            .cloned()
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
        data.active_scope = Some(request.clone());

        let stale_queue = data
            .queue
            .iter()
            .filter(|task| !scope_matches_task(&request, task))
            .map(|task| task.key.clone())
            .collect::<Vec<_>>();
        data.queue.retain(|task| !stale_queue.contains(&task.key));
        let mut changed = Vec::new();
        for key in stale_queue {
            if let Some(previous) = data.states.get(&key).cloned() {
                let state = canceled_for_scope(previous);
                data.states.insert(key, state.clone());
                changed.push(state);
            }
        }
        let stale_cache = data
            .cache
            .iter()
            .filter(|(key, cached)| {
                key.workspace_id == request.workspace_id
                    && key.workspace_generation == request.workspace_generation
                    && cached.request.locale != request.locale
            })
            .map(|(key, _)| key.clone())
            .collect::<Vec<_>>();
        for key in stale_cache {
            data.cache.remove(&key);
            data.cache_order.retain(|candidate| candidate != &key);
            if let Some(previous) = data.states.get(&key).cloned() {
                let state = canceled_for_scope(previous);
                data.states.insert(key, state.clone());
                changed.push(state);
            }
        }
        let active_request = data.active.as_ref().and_then(|active| {
            (!scope_matches_task(&request, &active.task)).then(|| {
                active.canceled.store(true, Ordering::Release);
                active.executor_request_id.clone()
            })
        });
        if let Some(active) = data.active.as_ref() {
            if active_request.is_some() {
                if let Some(previous) = data.states.get(&active.task.key).cloned() {
                    let key = active.task.key.clone();
                    let state = canceled_for_scope(previous);
                    data.states.insert(key, state.clone());
                    changed.push(state);
                }
            }
        }
        drop(data);
        for state in changed {
            self.inner.events.emit_state(&state);
        }
        if let Some(request_id) = active_request {
            let _ = self.inner.executor.cancel(&request_id).await;
        }
        Ok(())
    }

    pub async fn shutdown(&self) {
        let mut data = self.inner.data.lock().await;
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
        drop(data);
        for state in changed {
            self.inner.events.emit_state(&state);
        }
        if let Some((_, request_id)) = active {
            let _ = self.inner.executor.cancel(&request_id).await;
        }
    }

    async fn run_worker(&self) {
        loop {
            let (task, canceled, running) = {
                let mut data = self.inner.data.lock().await;
                let Some(task) = data.queue.pop_front() else {
                    data.worker_running = false;
                    return;
                };
                if !data
                    .active_scope
                    .as_ref()
                    .is_some_and(|scope| scope_matches_task(scope, &task))
                {
                    if let Some(previous) = data.states.get(&task.key).cloned() {
                        let state = canceled_for_scope(previous);
                        data.states.insert(task.key.clone(), state.clone());
                        drop(data);
                        self.inner.events.emit_state(&state);
                        continue;
                    }
                    continue;
                }
                let canceled = Arc::new(AtomicBool::new(false));
                let running = lifecycle_state(
                    &task.dispatch.request,
                    CommitExplanationControllerStatus::Running,
                );
                data.states.insert(task.key.clone(), running.clone());
                data.active = Some(ActiveTask {
                    task: task.clone(),
                    executor_request_id: task.dispatch.request.request_id.clone(),
                    canceled: canceled.clone(),
                });
                (task, canceled, running)
            };
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

            let (state, presentation) = {
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
                    || !data
                        .active_scope
                        .as_ref()
                        .is_some_and(|scope| scope_matches_task(scope, &task))
                    || previous.as_ref().is_some_and(|state| {
                        state.status == CommitExplanationControllerStatus::Canceled
                    })
                {
                    (None, None)
                } else {
                    let output_request = rebound_request
                        .as_ref()
                        .expect("active request checked above");
                    match outcome {
                        Ok(result)
                            if result.request_id == task.dispatch.request.request_id
                                && result.explanation.locale == task.dispatch.request.locale =>
                        {
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
                            (
                                Some(state),
                                Some(presentation(
                                    &cached,
                                    CommitExplanationPresentationMode::Show,
                                )),
                            )
                        }
                        Ok(_) => {
                            let state = terminal_state(
                                output_request,
                                CommitExplanationControllerStatus::Failed,
                                true,
                                Some("CODEX-SUPPORT-RESULT-STALE"),
                            );
                            data.states.insert(task.key.clone(), state.clone());
                            (Some(state), None)
                        }
                        Err(error) => {
                            let (status, retryable) = error_state(error);
                            let state = terminal_state(
                                output_request,
                                status,
                                retryable,
                                Some(error.code()),
                            );
                            data.states.insert(task.key.clone(), state.clone());
                            (Some(state), None)
                        }
                    }
                }
            };
            if let Some(state) = state {
                self.inner.events.emit_state(&state);
            }
            if let Some(presentation) = presentation {
                self.inner.events.emit_presentation(&presentation);
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

fn canceled_for_scope(
    previous: CommitExplanationControllerStateV1,
) -> CommitExplanationControllerStateV1 {
    CommitExplanationControllerStateV1 {
        status: CommitExplanationControllerStatus::Canceled,
        retryable: true,
        presentation_available: false,
        error_code: Some("CODEX-SUPPORT-WORKSPACE-STALE".to_owned()),
        updated_at: now(),
        ..previous
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

fn scope_matches_task(scope: &CommitExplanationScopeRequestedV1, task: &ExplanationTask) -> bool {
    scope_matches_request(scope, &task.dispatch.request)
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
                true
            })
        }
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
    async fn sha_generation_dedupe_reuses_cache_and_presentation() {
        let (controller, executor, events) =
            harness(FakeMode::Immediate, 2, 4, Duration::from_secs(1));
        let first = dispatch('a', "request-first", 1);
        controller.request(first.clone()).await.expect("first");
        let generated = wait_for_status(
            &controller,
            &first,
            CommitExplanationControllerStatus::Generated,
        )
        .await;

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
        assert_eq!(events.presentations.lock().expect("events").len(), 2);
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
    async fn generation_change_and_shutdown_terminalize_active_and_queued() {
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
        assert_eq!(
            wait_for_status(
                &controller,
                &active,
                CommitExplanationControllerStatus::Canceled,
            )
            .await
            .error_code
            .as_deref(),
            Some("CODEX-SUPPORT-WORKSPACE-STALE")
        );
        assert_eq!(
            wait_for_status(
                &controller,
                &queued,
                CommitExplanationControllerStatus::Canceled,
            )
            .await
            .status,
            CommitExplanationControllerStatus::Canceled
        );

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
        controller.shutdown().await;
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
        assert!(executor.cancels.load(Ordering::Acquire) >= 2);
    }

    #[tokio::test]
    async fn workspace_and_locale_scope_changes_cancel_old_work_without_losing_identity() {
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
        let canceled = wait_for_status(
            &controller,
            &active,
            CommitExplanationControllerStatus::Canceled,
        )
        .await;
        assert_eq!(canceled.locale.as_deref(), Some("ja"));
        assert_eq!(canceled.selection_version, Some(1));
        assert_eq!(executor.cancels.load(Ordering::Acquire), 1);
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
