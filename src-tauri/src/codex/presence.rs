//! App-owned Luna presence-direction scheduling.
//!
//! Only semantic enums derived from normalized native events cross the model
//! boundary. Correlation identifiers remain in this scheduler and are attached
//! only after a strict Luna response has been validated.

use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::{Mutex as AsyncMutex, Notify};

use super::supervisor::CodexSupervisor;
use super::support::{
    validate_presence_direction, PresenceCue, PresenceDirectionV1, PresenceDirectorInputV1,
    PresenceElapsedBucket, PresenceLocale, PresenceSemanticState, PresenceTrigger,
    SupportConstructionControl, SupportPresenceRequest, SupportPresenceResult, SupportRuntime,
    SupportRuntimeError,
};
use super::types::{CodexEvent, CodexEventPayload, CODEX_PRESENCE_DIRECTOR_MODEL};

pub const PRESENCE_DIRECTION_EVENT_CHANNEL: &str = "coding-wife://presence-direction";
pub const PRESENCE_SCHEMA_VERSION: u16 = 1;
pub const PRESENCE_MODEL_ROLE: &str = "presence_director";

const DEFAULT_COOLDOWN: Duration = Duration::from_secs(30);
const DEFAULT_FIRST_MILESTONE: Duration = Duration::from_secs(45);
const DEFAULT_SECOND_MILESTONE: Duration = Duration::from_secs(120);
const EXECUTOR_SHUTDOWN_WAIT: Duration = Duration::from_secs(2);

type PresenceFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PresencePriority {
    Low,
    Normal,
    High,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PresenceDirectionEventV1 {
    pub schema_version: u16,
    pub request_id: String,
    pub workspace_id: String,
    pub workspace_generation: u64,
    pub source_event_id: String,
    pub trigger: PresenceTrigger,
    pub locale: PresenceLocale,
    pub utterance: String,
    pub cue: PresenceCue,
    pub priority: PresencePriority,
    pub model_role: String,
    pub model: String,
    pub occurred_at: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PresenceScopeRequestV1 {
    pub schema_version: u16,
    pub workspace_id: String,
    pub workspace_generation: u64,
    pub locale: PresenceLocale,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PresenceCommandError {
    pub code: String,
    pub operation: String,
    pub recoverable: bool,
    pub user_message_key: String,
}

impl PresenceCommandError {
    fn invalid(operation: &'static str) -> Self {
        Self {
            code: "CODEX-PRESENCE-SCOPE-INVALID".to_owned(),
            operation: operation.to_owned(),
            recoverable: false,
            user_message_key: "codex.error.generic".to_owned(),
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) struct PresenceAuditSnapshot {
    pub attempts: u64,
    pub successes: u64,
    pub failures: u64,
    pub canceled: u64,
    pub unavailable: u64,
    pub last_latency_ms: u64,
    pub last_input_tokens: u64,
    pub last_output_tokens: u64,
    pub last_error_code: Option<&'static str>,
}

pub(crate) trait PresenceExecutor: Send + Sync {
    fn execute<'a>(
        &'a self,
        request: SupportPresenceRequest,
    ) -> PresenceFuture<'a, Result<SupportPresenceResult, SupportRuntimeError>>;

    fn cancel<'a>(&'a self, request_id: &'a str) -> PresenceFuture<'a, bool>;

    fn shutdown<'a>(&'a self) -> PresenceFuture<'a, bool>;

    fn force_shutdown_now<'a>(&'a self) -> PresenceFuture<'a, bool>;
}

pub(crate) trait PresenceEventSink: Send + Sync {
    fn emit(&self, event: &PresenceDirectionEventV1);
}

pub(crate) trait PresenceEventObserver: Send + Sync {
    fn observe(&self, event: &CodexEvent);

    fn invalidate_generation<'a>(&'a self, generation: u64) -> PresenceFuture<'a, ()>;

    fn shutdown<'a>(&'a self) -> PresenceFuture<'a, bool>;

    fn force_shutdown_now<'a>(&'a self) -> PresenceFuture<'a, bool>;
}

pub(crate) trait VerifiedCommitPresenceSink: Send + Sync {
    fn verified_commit<'a>(
        &'a self,
        workspace_id: String,
        workspace_generation: u64,
        source_event_id: String,
    ) -> PresenceFuture<'a, ()>;
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct PresenceScope {
    workspace_id: String,
    workspace_generation: u64,
    locale: PresenceLocale,
}

#[derive(Clone)]
struct PresenceCandidate {
    request: SupportPresenceRequest,
    source_event_id: String,
    priority: PresencePriority,
    rank: u8,
    decision_id: Option<String>,
    turn_handle: Option<String>,
    canceled: Arc<AtomicBool>,
}

impl PresenceCandidate {
    fn bypasses_cooldown(&self) -> bool {
        matches!(
            self.request.input.trigger,
            PresenceTrigger::DecisionWait | PresenceTrigger::TerminalFailure
        )
    }

    fn scope_matches(&self, scope: &PresenceScope) -> bool {
        self.request.workspace_id == scope.workspace_id
            && self.request.workspace_generation == scope.workspace_generation
            && self.request.input.locale == scope.locale
    }
}

#[derive(Clone)]
struct ActiveTurn {
    workspace_id: String,
    workspace_generation: u64,
    turn_handle: String,
    epoch: u64,
}

#[derive(Default)]
struct PresenceData {
    scope: Option<PresenceScope>,
    active: Option<PresenceCandidate>,
    queued: Option<PresenceCandidate>,
    active_turn: Option<ActiveTurn>,
    next_turn_epoch: u64,
    worker_running: bool,
    shutting_down: bool,
    last_published: Option<(String, u64, Instant)>,
    audit: PresenceAuditSnapshot,
}

#[derive(Clone, Copy)]
struct PresenceTiming {
    cooldown: Duration,
    first_milestone: Duration,
    second_milestone: Duration,
}

impl Default for PresenceTiming {
    fn default() -> Self {
        Self {
            cooldown: DEFAULT_COOLDOWN,
            first_milestone: DEFAULT_FIRST_MILESTONE,
            second_milestone: DEFAULT_SECOND_MILESTONE,
        }
    }
}

struct PresenceDirectorInner {
    data: Mutex<PresenceData>,
    executor: Arc<dyn PresenceExecutor>,
    events: Arc<dyn PresenceEventSink>,
    wake: Notify,
    timing: PresenceTiming,
}

#[derive(Clone)]
pub struct PresenceDirector {
    inner: Arc<PresenceDirectorInner>,
}

#[derive(Clone)]
pub(crate) struct PresenceVerifiedCommitEnqueuer {
    inner: Weak<PresenceDirectorInner>,
}

impl PresenceDirector {
    pub fn production(supervisor: CodexSupervisor, app_handle: AppHandle) -> Self {
        Self::with_dependencies(
            Arc::new(IsolatedPresenceExecutor::new(supervisor)),
            Arc::new(TauriPresenceEventSink { app_handle }),
            PresenceTiming::default(),
        )
    }

    pub(crate) fn verified_commit_enqueuer(&self) -> PresenceVerifiedCommitEnqueuer {
        PresenceVerifiedCommitEnqueuer {
            inner: Arc::downgrade(&self.inner),
        }
    }

    fn with_dependencies(
        executor: Arc<dyn PresenceExecutor>,
        events: Arc<dyn PresenceEventSink>,
        timing: PresenceTiming,
    ) -> Self {
        Self {
            inner: Arc::new(PresenceDirectorInner {
                data: Mutex::new(PresenceData::default()),
                executor,
                events,
                wake: Notify::new(),
                timing,
            }),
        }
    }

    pub fn set_scope(&self, request: PresenceScopeRequestV1) -> Result<(), PresenceCommandError> {
        const OPERATION: &str = "presence.set_scope";
        if request.schema_version != PRESENCE_SCHEMA_VERSION
            || !valid_opaque(&request.workspace_id)
            || request.workspace_generation == 0
        {
            return Err(PresenceCommandError::invalid(OPERATION));
        }
        let next = PresenceScope {
            workspace_id: request.workspace_id,
            workspace_generation: request.workspace_generation,
            locale: request.locale,
        };
        let active_to_cancel = {
            let mut data = self.inner.data.lock().expect("presence data lock poisoned");
            if data.shutting_down {
                return Err(PresenceCommandError {
                    code: "CODEX-PRESENCE-SHUTTING-DOWN".to_owned(),
                    operation: OPERATION.to_owned(),
                    recoverable: true,
                    user_message_key: "codex.error.generic".to_owned(),
                });
            }
            if data.scope.as_ref() == Some(&next) {
                return Ok(());
            }
            data.scope = Some(next);
            data.active_turn = None;
            data.queued = None;
            cancel_active_locked(&mut data)
        };
        self.cancel_executor(active_to_cancel);
        self.inner.wake.notify_one();
        Ok(())
    }

    pub fn observe(&self, event: &CodexEvent) {
        match &event.payload {
            CodexEventPayload::TurnStatus {
                turn_handle,
                status,
                ..
            } if matches!(status.as_str(), "running" | "inProgress") => {
                self.start_turn(event, turn_handle.clone());
            }
            CodexEventPayload::TurnStatus {
                turn_handle,
                status,
                ..
            } => {
                self.stop_turn(event, turn_handle, status == "completed");
                match status.as_str() {
                    "completed" => self.submit_from_event(
                        event,
                        PresenceTrigger::TurnCompleted,
                        None,
                        None,
                        PresenceElapsedBucket::None,
                        false,
                    ),
                    "failed" => self.submit_from_event(
                        event,
                        PresenceTrigger::TerminalFailure,
                        None,
                        None,
                        PresenceElapsedBucket::None,
                        false,
                    ),
                    _ => {}
                }
            }
            CodexEventPayload::PendingRequest { request } => self.submit_from_event(
                event,
                PresenceTrigger::DecisionWait,
                Some(request.pending_id.clone()),
                None,
                PresenceElapsedBucket::None,
                false,
            ),
            CodexEventPayload::PendingRequestResolved { pending_id, .. } => {
                self.cancel_decision(event.generation, pending_id)
            }
            CodexEventPayload::Diagnostic {
                will_retry: true, ..
            } => self.submit_from_event(
                event,
                PresenceTrigger::RecoverableFailure,
                None,
                None,
                PresenceElapsedBucket::None,
                true,
            ),
            _ => {}
        }
    }

    pub fn verified_commit(
        &self,
        workspace_id: String,
        workspace_generation: u64,
        source_event_id: String,
    ) {
        if !valid_opaque(&source_event_id) {
            return;
        }
        let candidate = self.candidate(
            workspace_id,
            workspace_generation,
            source_event_id,
            PresenceTrigger::CommitReady,
            None,
            None,
            PresenceElapsedBucket::None,
            false,
        );
        if let Some(candidate) = candidate {
            self.admit(candidate);
        }
    }

    #[cfg(test)]
    pub(crate) fn audit_snapshot(&self) -> PresenceAuditSnapshot {
        self.inner
            .data
            .lock()
            .expect("presence data lock poisoned")
            .audit
    }

    async fn invalidate_generation_inner(&self, generation: u64) {
        let active_to_cancel = {
            let mut data = self.inner.data.lock().expect("presence data lock poisoned");
            if data
                .scope
                .as_ref()
                .is_none_or(|scope| scope.workspace_generation != generation)
            {
                return;
            }
            data.scope = None;
            data.active_turn = None;
            data.queued = None;
            cancel_active_locked(&mut data)
        };
        if let Some(request_id) = active_to_cancel {
            let canceled = self.inner.executor.cancel(&request_id).await;
            if canceled {
                self.record_canceled();
            }
        }
        self.inner.wake.notify_one();
    }

    async fn shutdown_inner(&self, force: bool) -> bool {
        let active_to_cancel = {
            let mut data = self.inner.data.lock().expect("presence data lock poisoned");
            data.shutting_down = true;
            data.scope = None;
            data.active_turn = None;
            data.queued = None;
            cancel_active_locked(&mut data)
        };
        if let Some(request_id) = active_to_cancel {
            if !force {
                let _ = self.inner.executor.cancel(&request_id).await;
            }
            self.record_canceled();
        }
        self.inner.wake.notify_waiters();
        if force {
            self.inner.executor.force_shutdown_now().await
        } else {
            self.inner.executor.shutdown().await
        }
    }

    fn start_turn(&self, event: &CodexEvent, turn_handle: String) {
        let (marker, active_to_cancel) = {
            let mut data = self.inner.data.lock().expect("presence data lock poisoned");
            let Some(scope) = data.scope.as_ref() else {
                return;
            };
            if scope.workspace_id != event.workspace_id
                || scope.workspace_generation != event.generation
                || data.shutting_down
            {
                return;
            }
            if data.queued.as_ref().is_some_and(|candidate| {
                candidate.request.workspace_generation == event.generation
                    && candidate
                        .turn_handle
                        .as_deref()
                        .is_some_and(|candidate_turn| candidate_turn != turn_handle)
            }) {
                data.queued = None;
            }
            let active_to_cancel = if data.active.as_ref().is_some_and(|candidate| {
                candidate.request.workspace_generation == event.generation
                    && candidate
                        .turn_handle
                        .as_deref()
                        .is_some_and(|candidate_turn| candidate_turn != turn_handle)
            }) {
                cancel_active_locked(&mut data)
            } else {
                None
            };
            data.next_turn_epoch = data.next_turn_epoch.saturating_add(1);
            let marker = ActiveTurn {
                workspace_id: event.workspace_id.clone(),
                workspace_generation: event.generation,
                turn_handle,
                epoch: data.next_turn_epoch,
            };
            data.active_turn = Some(marker.clone());
            (marker, active_to_cancel)
        };
        self.cancel_executor(active_to_cancel);
        self.spawn_milestone(
            marker.clone(),
            PresenceElapsedBucket::Seconds45Plus,
            self.inner.timing.first_milestone,
        );
        self.spawn_milestone(
            marker,
            PresenceElapsedBucket::Seconds120Plus,
            self.inner.timing.second_milestone,
        );
    }

    fn stop_turn(&self, event: &CodexEvent, turn_handle: &str, preserve_verified_commit: bool) {
        let active_to_cancel = {
            let mut data = self.inner.data.lock().expect("presence data lock poisoned");
            if data.active_turn.as_ref().is_some_and(|active| {
                active.workspace_id == event.workspace_id
                    && active.workspace_generation == event.generation
                    && active.turn_handle == turn_handle
            }) {
                data.active_turn = None;
            }
            if data.queued.as_ref().is_some_and(|candidate| {
                candidate.request.workspace_generation == event.generation
                    && candidate.turn_handle.as_deref() == Some(turn_handle)
                    && !(preserve_verified_commit
                        && candidate.request.input.trigger == PresenceTrigger::CommitReady)
            }) {
                data.queued = None;
            }
            if data.active.as_ref().is_some_and(|candidate| {
                candidate.request.workspace_generation == event.generation
                    && candidate.turn_handle.as_deref() == Some(turn_handle)
                    && !(preserve_verified_commit
                        && candidate.request.input.trigger == PresenceTrigger::CommitReady)
            }) {
                cancel_active_locked(&mut data)
            } else {
                None
            }
        };
        self.cancel_executor(active_to_cancel);
        self.inner.wake.notify_one();
    }

    fn cancel_decision(&self, generation: u64, pending_id: &str) {
        let active_to_cancel = {
            let mut data = self.inner.data.lock().expect("presence data lock poisoned");
            if data.queued.as_ref().is_some_and(|candidate| {
                candidate.request.workspace_generation == generation
                    && candidate.decision_id.as_deref() == Some(pending_id)
            }) {
                data.queued = None;
            }
            if data.active.as_ref().is_some_and(|candidate| {
                candidate.request.workspace_generation == generation
                    && candidate.decision_id.as_deref() == Some(pending_id)
            }) {
                cancel_active_locked(&mut data)
            } else {
                None
            }
        };
        self.cancel_executor(active_to_cancel);
        self.inner.wake.notify_one();
    }

    fn spawn_milestone(
        &self,
        marker: ActiveTurn,
        elapsed_bucket: PresenceElapsedBucket,
        delay: Duration,
    ) {
        let director = self.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(delay).await;
            director.submit_milestone_if_active(marker, elapsed_bucket);
        });
    }

    fn submit_milestone_if_active(
        &self,
        marker: ActiveTurn,
        elapsed_bucket: PresenceElapsedBucket,
    ) {
        let active = self
            .inner
            .data
            .lock()
            .expect("presence data lock poisoned")
            .active_turn
            .as_ref()
            .is_some_and(|active| {
                active.workspace_id == marker.workspace_id
                    && active.workspace_generation == marker.workspace_generation
                    && active.turn_handle == marker.turn_handle
                    && active.epoch == marker.epoch
            });
        if !active {
            return;
        }
        let candidate = self.candidate(
            marker.workspace_id,
            marker.workspace_generation,
            format!("presence-milestone-{}", uuid::Uuid::new_v4()),
            PresenceTrigger::LongMilestone,
            None,
            Some(marker.turn_handle),
            elapsed_bucket,
            false,
        );
        if let Some(candidate) = candidate {
            self.admit(candidate);
        }
    }

    fn submit_from_event(
        &self,
        event: &CodexEvent,
        trigger: PresenceTrigger,
        decision_id: Option<String>,
        turn_handle: Option<String>,
        elapsed_bucket: PresenceElapsedBucket,
        retrying: bool,
    ) {
        let candidate = self.candidate(
            event.workspace_id.clone(),
            event.generation,
            event.event_id.clone(),
            trigger,
            decision_id,
            turn_handle,
            elapsed_bucket,
            retrying,
        );
        if let Some(candidate) = candidate {
            self.admit(candidate);
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn candidate(
        &self,
        workspace_id: String,
        workspace_generation: u64,
        source_event_id: String,
        trigger: PresenceTrigger,
        decision_id: Option<String>,
        turn_handle: Option<String>,
        elapsed_bucket: PresenceElapsedBucket,
        retrying: bool,
    ) -> Option<PresenceCandidate> {
        let (scope, inferred_turn_handle) = {
            let data = self.inner.data.lock().expect("presence data lock poisoned");
            let scope = data.scope.clone()?;
            let inferred_turn_handle = data.active_turn.as_ref().and_then(|active| {
                (active.workspace_id == workspace_id
                    && active.workspace_generation == workspace_generation)
                    .then(|| active.turn_handle.clone())
            });
            (scope, inferred_turn_handle)
        };
        if scope.workspace_id != workspace_id
            || scope.workspace_generation != workspace_generation
            || !valid_opaque(&source_event_id)
        {
            return None;
        }
        let (semantic_state, priority, rank) = trigger_policy(trigger);
        let request_id = format!("presence-{}", uuid::Uuid::new_v4());
        Some(PresenceCandidate {
            request: SupportPresenceRequest {
                request_id,
                workspace_id,
                workspace_generation,
                input: PresenceDirectorInputV1 {
                    schema_version: PRESENCE_SCHEMA_VERSION,
                    locale: scope.locale,
                    trigger,
                    semantic_state,
                    retrying,
                    elapsed_bucket,
                },
            },
            source_event_id,
            priority,
            rank,
            decision_id,
            turn_handle: turn_handle.or(inferred_turn_handle),
            canceled: Arc::new(AtomicBool::new(false)),
        })
    }

    fn admit(&self, candidate: PresenceCandidate) {
        let should_start = {
            let mut data = self.inner.data.lock().expect("presence data lock poisoned");
            if data.shutting_down
                || data
                    .scope
                    .as_ref()
                    .is_none_or(|scope| !candidate.scope_matches(scope))
                || data.active.as_ref().is_some_and(|active| {
                    !active.canceled.load(Ordering::Acquire)
                        && active.request.input.trigger == candidate.request.input.trigger
                })
            {
                return;
            }
            match data.queued.as_ref() {
                Some(queued) if queued.request.input.trigger == candidate.request.input.trigger => {
                    data.queued = Some(candidate);
                }
                Some(queued) if queued.rank > candidate.rank => return,
                Some(_) | None => data.queued = Some(candidate),
            }
            if data.worker_running {
                false
            } else {
                data.worker_running = true;
                true
            }
        };
        self.inner.wake.notify_one();
        if should_start {
            let director = self.clone();
            tauri::async_runtime::spawn(async move {
                director.run_worker().await;
            });
        }
    }

    async fn run_worker(&self) {
        loop {
            enum Next {
                Execute(PresenceCandidate),
                Wait(Duration),
                Stop,
            }
            let next = {
                let mut data = self.inner.data.lock().expect("presence data lock poisoned");
                if data.shutting_down {
                    data.worker_running = false;
                    Next::Stop
                } else if data.active.is_some() {
                    Next::Wait(Duration::ZERO)
                } else if let Some(candidate) = data.queued.as_ref() {
                    let wait = cooldown_remaining_at(
                        &data,
                        candidate,
                        self.inner.timing.cooldown,
                        Instant::now(),
                    );
                    if wait.is_zero() {
                        let candidate = data.queued.take().expect("queued candidate checked");
                        data.active = Some(candidate.clone());
                        data.audit.attempts = data.audit.attempts.saturating_add(1);
                        Next::Execute(candidate)
                    } else {
                        Next::Wait(wait)
                    }
                } else {
                    data.worker_running = false;
                    Next::Stop
                }
            };
            match next {
                Next::Stop => return,
                Next::Wait(delay) if delay.is_zero() => self.inner.wake.notified().await,
                Next::Wait(delay) => {
                    tokio::select! {
                        _ = tokio::time::sleep(delay) => {}
                        _ = self.inner.wake.notified() => {}
                    }
                }
                Next::Execute(candidate) => {
                    // The single-use support runtime owns every protocol timeout
                    // and cleanup path. Dropping this future from an outer timeout
                    // would orphan its active ownership during construction.
                    let result = self.inner.executor.execute(candidate.request.clone()).await;
                    self.finish_candidate(candidate, result).await;
                }
            }
        }
    }

    async fn finish_candidate(
        &self,
        candidate: PresenceCandidate,
        result: Result<SupportPresenceResult, SupportRuntimeError>,
    ) {
        let mut event = None;
        let mut data = self.inner.data.lock().expect("presence data lock poisoned");
        let is_current = data
            .active
            .as_ref()
            .is_some_and(|active| active.request.request_id == candidate.request.request_id);
        if is_current {
            data.active = None;
        }
        let valid_scope = data
            .scope
            .as_ref()
            .is_some_and(|scope| candidate.scope_matches(scope));
        if !is_current || !valid_scope || candidate.canceled.load(Ordering::Acquire) {
            data.audit.canceled = data.audit.canceled.saturating_add(1);
            data.audit.last_error_code = Some(SupportRuntimeError::Canceled.code());
        } else {
            match result {
                Ok(result)
                    if validate_presence_direction(&result.direction, &candidate.request.input)
                        .is_ok() =>
                {
                    data.audit.successes = data.audit.successes.saturating_add(1);
                    data.audit.last_latency_ms = result.latency_ms;
                    data.audit.last_input_tokens = result.usage.input_tokens;
                    data.audit.last_output_tokens = result.usage.output_tokens;
                    data.audit.last_error_code = None;
                    data.last_published = Some((
                        candidate.request.workspace_id.clone(),
                        candidate.request.workspace_generation,
                        Instant::now(),
                    ));
                    event = Some(public_event(&candidate, result.direction));
                }
                Err(error) => {
                    data.audit.failures = data.audit.failures.saturating_add(1);
                    if error == SupportRuntimeError::UnsupportedRelease {
                        data.audit.unavailable = data.audit.unavailable.saturating_add(1);
                    }
                    data.audit.last_error_code = Some(error.code());
                }
                Ok(_) => {
                    data.audit.failures = data.audit.failures.saturating_add(1);
                    data.audit.last_error_code = Some(SupportRuntimeError::Output.code());
                }
            }
        }
        if let Some(event) = event.as_ref() {
            // Serialize publication with scope invalidation so a validated late
            // result cannot cross a workspace/generation change.
            self.inner.events.emit(event);
        }
        drop(data);
        self.inner.wake.notify_one();
    }

    fn cancel_executor(&self, request_id: Option<String>) {
        let Some(request_id) = request_id else {
            return;
        };
        let director = self.clone();
        tauri::async_runtime::spawn(async move {
            if director.inner.executor.cancel(&request_id).await {
                director.record_canceled();
            }
            director.inner.wake.notify_one();
        });
    }

    fn record_canceled(&self) {
        let mut data = self.inner.data.lock().expect("presence data lock poisoned");
        data.audit.canceled = data.audit.canceled.saturating_add(1);
        data.audit.last_error_code = Some(SupportRuntimeError::Canceled.code());
    }
}

impl PresenceEventObserver for PresenceDirector {
    fn observe(&self, event: &CodexEvent) {
        PresenceDirector::observe(self, event);
    }

    fn invalidate_generation<'a>(&'a self, generation: u64) -> PresenceFuture<'a, ()> {
        Box::pin(async move { self.invalidate_generation_inner(generation).await })
    }

    fn shutdown<'a>(&'a self) -> PresenceFuture<'a, bool> {
        Box::pin(async move { self.shutdown_inner(false).await })
    }

    fn force_shutdown_now<'a>(&'a self) -> PresenceFuture<'a, bool> {
        Box::pin(async move { self.shutdown_inner(true).await })
    }
}

impl VerifiedCommitPresenceSink for PresenceDirector {
    fn verified_commit<'a>(
        &'a self,
        workspace_id: String,
        workspace_generation: u64,
        source_event_id: String,
    ) -> PresenceFuture<'a, ()> {
        Box::pin(async move {
            PresenceDirector::verified_commit(
                self,
                workspace_id,
                workspace_generation,
                source_event_id,
            );
        })
    }
}

impl VerifiedCommitPresenceSink for PresenceVerifiedCommitEnqueuer {
    fn verified_commit<'a>(
        &'a self,
        workspace_id: String,
        workspace_generation: u64,
        source_event_id: String,
    ) -> PresenceFuture<'a, ()> {
        Box::pin(async move {
            let Some(inner) = self.inner.upgrade() else {
                return;
            };
            PresenceDirector { inner }.verified_commit(
                workspace_id,
                workspace_generation,
                source_event_id,
            );
        })
    }
}

struct TauriPresenceEventSink {
    app_handle: AppHandle,
}

impl PresenceEventSink for TauriPresenceEventSink {
    fn emit(&self, event: &PresenceDirectionEventV1) {
        let _ = self
            .app_handle
            .emit(PRESENCE_DIRECTION_EVENT_CHANNEL, event);
    }
}

#[derive(Default)]
struct PresenceExecutorState {
    active: Option<ActivePresenceExecution>,
    shutting_down: bool,
}

struct ActivePresenceExecution {
    request_id: String,
    canceled: bool,
    construction: SupportConstructionControl,
    runtime: Option<Arc<SupportRuntime>>,
}

struct IsolatedPresenceExecutor {
    supervisor: CodexSupervisor,
    state: AsyncMutex<PresenceExecutorState>,
    completion: Notify,
}

impl IsolatedPresenceExecutor {
    fn new(supervisor: CodexSupervisor) -> Self {
        Self {
            supervisor,
            state: AsyncMutex::new(PresenceExecutorState::default()),
            completion: Notify::new(),
        }
    }

    async fn clear_active(&self, request_id: &str) {
        let mut state = self.state.lock().await;
        if state
            .active
            .as_ref()
            .is_some_and(|active| active.request_id == request_id)
        {
            state.active = None;
            self.completion.notify_waiters();
        }
    }

    async fn wait_for_idle(&self) -> bool {
        tokio::time::timeout(EXECUTOR_SHUTDOWN_WAIT, async {
            loop {
                let notified = self.completion.notified();
                tokio::pin!(notified);
                notified.as_mut().enable();
                if self.state.lock().await.active.is_none() {
                    return;
                }
                notified.await;
            }
        })
        .await
        .is_ok()
    }
}

impl PresenceExecutor for IsolatedPresenceExecutor {
    fn execute<'a>(
        &'a self,
        request: SupportPresenceRequest,
    ) -> PresenceFuture<'a, Result<SupportPresenceResult, SupportRuntimeError>> {
        Box::pin(async move {
            let request_id = request.request_id.clone();
            let Some((binary, schema, resource_directory)) = self
                .supervisor
                .support_runtime_context(&request.workspace_id, request.workspace_generation)
                .await
            else {
                return Err(SupportRuntimeError::UnsupportedRelease);
            };
            let construction = SupportConstructionControl::new();
            {
                let mut state = self.state.lock().await;
                if state.shutting_down {
                    return Err(SupportRuntimeError::Canceled);
                }
                if state.active.is_some() {
                    return Err(SupportRuntimeError::Busy);
                }
                state.active = Some(ActivePresenceExecution {
                    request_id: request_id.clone(),
                    canceled: false,
                    construction: construction.clone(),
                    runtime: None,
                });
            }
            let lease = match SupportRuntime::construct_presence_controlled(
                &binary,
                &schema,
                &resource_directory,
                None::<&Path>,
                construction.clone(),
            )
            .await
            {
                Ok(lease) => lease,
                Err(error) => {
                    let reason = error.reason();
                    let _ = error.force_shutdown_now().await;
                    self.clear_active(&request_id).await;
                    return Err(reason);
                }
            };
            let runtime = lease.runtime();
            let registered = {
                let mut state = self.state.lock().await;
                let shutting_down = state.shutting_down;
                state.active.as_mut().is_some_and(|active| {
                    if active.request_id != request_id || active.canceled || shutting_down {
                        return false;
                    }
                    active.runtime = Some(runtime.clone());
                    true
                })
            };
            if !registered {
                let _ = construction.force_shutdown_now().await;
                self.clear_active(&request_id).await;
                return Err(SupportRuntimeError::Canceled);
            }
            let runtime = match lease.release_after_registration() {
                Ok(runtime) => runtime,
                Err(error) => {
                    let _ = construction.force_shutdown_now().await;
                    self.clear_active(&request_id).await;
                    return Err(error);
                }
            };
            let result = runtime.direct_presence(request).await;
            let cleanup = runtime.shutdown().await;
            self.clear_active(&request_id).await;
            match (result, cleanup) {
                (Ok(result), Ok(())) => Ok(result),
                (Err(error), Ok(())) => Err(error),
                (_, Err(error)) => Err(error),
            }
        })
    }

    fn cancel<'a>(&'a self, request_id: &'a str) -> PresenceFuture<'a, bool> {
        Box::pin(async move {
            let (runtime, construction) = {
                let mut state = self.state.lock().await;
                let Some(active) = state
                    .active
                    .as_mut()
                    .filter(|active| active.request_id == request_id)
                else {
                    return false;
                };
                active.canceled = true;
                (active.runtime.clone(), active.construction.clone())
            };
            if let Some(runtime) = runtime {
                let canceled = runtime.cancel().await.is_ok();
                let shutdown = runtime.shutdown().await.is_ok();
                canceled && shutdown
            } else {
                construction.cancel().await
            }
        })
    }

    fn shutdown<'a>(&'a self) -> PresenceFuture<'a, bool> {
        Box::pin(async move {
            let request_id = {
                let mut state = self.state.lock().await;
                state.shutting_down = true;
                state
                    .active
                    .as_ref()
                    .map(|active| active.request_id.clone())
            };
            if let Some(request_id) = request_id {
                let _ = self.cancel(&request_id).await;
            }
            self.wait_for_idle().await
        })
    }

    fn force_shutdown_now<'a>(&'a self) -> PresenceFuture<'a, bool> {
        Box::pin(async move {
            let active = {
                let mut state = self.state.lock().await;
                state.shutting_down = true;
                state.active.as_mut().map(|active| {
                    active.canceled = true;
                    (active.runtime.clone(), active.construction.clone())
                })
            };
            let converged = match active {
                Some((Some(runtime), _)) => runtime.force_shutdown_now().await.is_ok(),
                Some((None, construction)) => construction.force_shutdown_now().await,
                None => true,
            };
            converged && self.wait_for_idle().await
        })
    }
}

#[tauri::command]
pub fn presence_set_scope(
    request: PresenceScopeRequestV1,
    director: State<'_, Arc<PresenceDirector>>,
) -> Result<(), PresenceCommandError> {
    director.set_scope(request)
}

fn cancel_active_locked(data: &mut PresenceData) -> Option<String> {
    data.active.as_ref().map(|active| {
        active.canceled.store(true, Ordering::Release);
        active.request.request_id.clone()
    })
}

fn trigger_policy(trigger: PresenceTrigger) -> (PresenceSemanticState, PresencePriority, u8) {
    match trigger {
        PresenceTrigger::DecisionWait => (PresenceSemanticState::Asking, PresencePriority::High, 6),
        PresenceTrigger::TerminalFailure => {
            (PresenceSemanticState::Error, PresencePriority::High, 5)
        }
        PresenceTrigger::RecoverableFailure => {
            (PresenceSemanticState::Warning, PresencePriority::High, 4)
        }
        PresenceTrigger::CommitReady => {
            (PresenceSemanticState::Success, PresencePriority::Normal, 3)
        }
        PresenceTrigger::TurnCompleted => {
            (PresenceSemanticState::Success, PresencePriority::Normal, 2)
        }
        PresenceTrigger::LongMilestone => {
            (PresenceSemanticState::Working, PresencePriority::Low, 1)
        }
    }
}

fn cooldown_remaining_at(
    data: &PresenceData,
    candidate: &PresenceCandidate,
    cooldown: Duration,
    now: Instant,
) -> Duration {
    if candidate.bypasses_cooldown() {
        return Duration::ZERO;
    }
    let Some((workspace_id, generation, published_at)) = data.last_published.as_ref() else {
        return Duration::ZERO;
    };
    if workspace_id != &candidate.request.workspace_id
        || *generation != candidate.request.workspace_generation
    {
        return Duration::ZERO;
    }
    cooldown.saturating_sub(now.saturating_duration_since(*published_at))
}

fn public_event(
    candidate: &PresenceCandidate,
    direction: PresenceDirectionV1,
) -> PresenceDirectionEventV1 {
    PresenceDirectionEventV1 {
        schema_version: PRESENCE_SCHEMA_VERSION,
        request_id: candidate.request.request_id.clone(),
        workspace_id: candidate.request.workspace_id.clone(),
        workspace_generation: candidate.request.workspace_generation,
        source_event_id: candidate.source_event_id.clone(),
        trigger: candidate.request.input.trigger,
        locale: direction.locale,
        utterance: direction.utterance,
        cue: direction.cue,
        priority: candidate.priority,
        model_role: PRESENCE_MODEL_ROLE.to_owned(),
        model: CODEX_PRESENCE_DIRECTOR_MODEL.to_owned(),
        occurred_at: chrono::Utc::now().to_rfc3339(),
    }
}

fn valid_opaque(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value
            .chars()
            .all(|character| !character.is_control() && !character.is_whitespace())
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicUsize, Ordering};

    use serde_json::json;
    use tokio::sync::Mutex as AsyncMutex;

    use super::*;
    use crate::codex::binary::{discover_binary, probe_schema};
    use crate::codex::support::SupportUsage;
    use crate::codex::types::{
        BinarySource, DecisionContext, PendingKind, PendingRequestView, PendingResponseKind,
    };

    static SUPPORT_ENVIRONMENT_LOCK: AsyncMutex<()> = AsyncMutex::const_new(());

    #[derive(Default)]
    struct FakeExecutor {
        requests: AsyncMutex<Vec<SupportPresenceRequest>>,
        results: AsyncMutex<VecDeque<Result<SupportPresenceResult, SupportRuntimeError>>>,
        active: AtomicUsize,
        max_active: AtomicUsize,
        cancels: AtomicUsize,
        shutdowns: AtomicUsize,
        forces: AtomicUsize,
        delay: Duration,
    }

    impl FakeExecutor {
        fn with_delay(delay: Duration) -> Self {
            Self {
                delay,
                ..Self::default()
            }
        }

        async fn push_result(&self, result: Result<SupportPresenceResult, SupportRuntimeError>) {
            self.results.lock().await.push_back(result);
        }
    }

    impl PresenceExecutor for FakeExecutor {
        fn execute<'a>(
            &'a self,
            request: SupportPresenceRequest,
        ) -> PresenceFuture<'a, Result<SupportPresenceResult, SupportRuntimeError>> {
            Box::pin(async move {
                let active = self.active.fetch_add(1, Ordering::AcqRel) + 1;
                self.max_active.fetch_max(active, Ordering::AcqRel);
                self.requests.lock().await.push(request.clone());
                if !self.delay.is_zero() {
                    tokio::time::sleep(self.delay).await;
                }
                self.active.fetch_sub(1, Ordering::AcqRel);
                let configured = self.results.lock().await.pop_front();
                match configured {
                    Some(result) => result,
                    None => Ok(valid_result(&request)),
                }
            })
        }

        fn cancel<'a>(&'a self, _request_id: &'a str) -> PresenceFuture<'a, bool> {
            Box::pin(async move {
                self.cancels.fetch_add(1, Ordering::AcqRel);
                true
            })
        }

        fn shutdown<'a>(&'a self) -> PresenceFuture<'a, bool> {
            Box::pin(async move {
                self.shutdowns.fetch_add(1, Ordering::AcqRel);
                true
            })
        }

        fn force_shutdown_now<'a>(&'a self) -> PresenceFuture<'a, bool> {
            Box::pin(async move {
                self.forces.fetch_add(1, Ordering::AcqRel);
                true
            })
        }
    }

    #[derive(Default)]
    struct CapturingEvents(Mutex<Vec<PresenceDirectionEventV1>>);

    impl PresenceEventSink for CapturingEvents {
        fn emit(&self, event: &PresenceDirectionEventV1) {
            self.0.lock().expect("event lock").push(event.clone());
        }
    }

    fn director(
        executor: Arc<FakeExecutor>,
        events: Arc<CapturingEvents>,
        timing: PresenceTiming,
    ) -> PresenceDirector {
        let executor: Arc<dyn PresenceExecutor> = executor;
        let events: Arc<dyn PresenceEventSink> = events;
        PresenceDirector::with_dependencies(executor, events, timing)
    }

    fn scope(locale: PresenceLocale) -> PresenceScopeRequestV1 {
        PresenceScopeRequestV1 {
            schema_version: 1,
            workspace_id: "workspace-fixture".to_owned(),
            workspace_generation: 7,
            locale,
        }
    }

    fn event(event_id: &str, payload: CodexEventPayload) -> CodexEvent {
        CodexEvent {
            schema_version: 1,
            event_id: event_id.to_owned(),
            workspace_id: "workspace-fixture".to_owned(),
            generation: 7,
            sequence: 1,
            occurred_at: "2026-07-21T00:00:00Z".to_owned(),
            payload,
        }
    }

    fn pending_event(event_id: &str, pending_id: &str) -> CodexEvent {
        event(
            event_id,
            CodexEventPayload::PendingRequest {
                request: Box::new(PendingRequestView {
                    pending_id: pending_id.to_owned(),
                    kind: PendingKind::UserInput,
                    response_kind: PendingResponseKind::NativeServerRequest,
                    operation: "fixture".to_owned(),
                    target_alias: "fixture".to_owned(),
                    reason: None,
                    questions: Vec::new(),
                    allowed_decisions: Vec::new(),
                    decision_context: DecisionContext {
                        schema_version: 1,
                        category: "fixture".to_owned(),
                        target_kind: "fixture".to_owned(),
                        target_alias: "fixture".to_owned(),
                        effect: "fixture".to_owned(),
                        scope: "fixture".to_owned(),
                        risk: "low".to_owned(),
                        reversibility: "reversible".to_owned(),
                        recommendation: None,
                        evidence: Vec::new(),
                        uncertainty: "none".to_owned(),
                    },
                }),
            },
        )
    }

    fn valid_result(request: &SupportPresenceRequest) -> SupportPresenceResult {
        let result = SupportPresenceResult {
            direction: PresenceDirectionV1 {
                schema_version: 1,
                locale: request.input.locale,
                utterance: match request.input.locale {
                    PresenceLocale::Ja => "進行中です。".to_owned(),
                    PresenceLocale::En => "Still working.".to_owned(),
                },
                cue: match request.input.trigger {
                    PresenceTrigger::DecisionWait => PresenceCue::Asking,
                    PresenceTrigger::RecoverableFailure => PresenceCue::Warning,
                    PresenceTrigger::TerminalFailure => PresenceCue::Error,
                    PresenceTrigger::LongMilestone => PresenceCue::Working,
                    PresenceTrigger::CommitReady | PresenceTrigger::TurnCompleted => {
                        PresenceCue::Success
                    }
                },
            },
            usage: SupportUsage {
                input_tokens: 4,
                output_tokens: 3,
                total_tokens: 7,
            },
            latency_ms: 8,
        };
        validate_presence_direction(&result.direction, &request.input)
            .expect("fixture direction must satisfy the production validator");
        result
    }

    fn fast_timing() -> PresenceTiming {
        PresenceTiming {
            cooldown: Duration::from_millis(20),
            first_milestone: Duration::from_millis(10),
            second_milestone: Duration::from_millis(20),
        }
    }

    async fn wait_until(predicate: impl Fn() -> bool) {
        for _ in 0..1_000 {
            if predicate() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("condition did not converge");
    }

    struct ConstructionFixture {
        state: PathBuf,
        app_data: PathBuf,
    }

    impl ConstructionFixture {
        fn new(mode: &str) -> Self {
            let state = std::env::temp_dir().join(format!(
                "coding-wife-presence-construction-state-{}-{}",
                std::process::id(),
                uuid::Uuid::new_v4()
            ));
            let app_data = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .expect("repository root")
                .join(".context")
                .join(format!(
                    "presence-construction-app-data-{}",
                    uuid::Uuid::new_v4()
                ));
            std::env::set_var("CODING_WIFE_CODEX_FAKE_MODE", mode);
            std::env::set_var("CODING_WIFE_CODEX_FAKE_STATE", &state);
            Self { state, app_data }
        }

        fn auth_source(&self) -> PathBuf {
            std::fs::create_dir_all(&self.app_data).expect("auth fixture directory");
            std::fs::set_permissions(&self.app_data, std::fs::Permissions::from_mode(0o700))
                .expect("auth fixture directory mode");
            let auth = self.app_data.join("auth.json");
            std::fs::write(&auth, br#"{"fixture":"support-auth"}"#).expect("auth fixture");
            std::fs::set_permissions(&auth, std::fs::Permissions::from_mode(0o600))
                .expect("auth fixture mode");
            auth
        }
    }

    impl Drop for ConstructionFixture {
        fn drop(&mut self) {
            std::env::remove_var("CODING_WIFE_CODEX_FAKE_MODE");
            std::env::remove_var("CODING_WIFE_CODEX_FAKE_STATE");
            let _ = std::fs::remove_file(&self.state);
            let _ = std::fs::remove_dir_all(&self.app_data);
        }
    }

    async fn fixture_support_binary() -> crate::codex::binary::BinaryInfo {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/fake_codex_app_server.py");
        let mut binary = discover_binary(Some(&path)).await.expect("fixture binary");
        binary.source = BinarySource::TestFixture;
        binary
    }

    async fn wait_for_probe_process(state_path: &Path) -> u32 {
        for _ in 0..500 {
            let state = std::fs::read_to_string(state_path).unwrap_or_default();
            if let Some(pid) = state.lines().rev().find_map(|line| {
                line.strip_prefix("support_grandchild_started:")?
                    .split(':')
                    .next()?
                    .parse::<u32>()
                    .ok()
            }) {
                return pid;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("isolation probe process did not start");
    }

    fn fixture_process_group_exists(pid: u32) -> bool {
        let Ok(pid) = i32::try_from(pid) else {
            return false;
        };
        // SAFETY: signal zero only probes the fixture-owned process group.
        unsafe { libc::kill(-pid, 0) == 0 }
    }

    async fn wait_for_process_group_exit(pid: u32) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        while fixture_process_group_exists(pid) && tokio::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(
            !fixture_process_group_exists(pid),
            "support process group {pid} survived construction cleanup"
        );
    }

    struct FixtureProcessGroupGuard(u32);

    impl Drop for FixtureProcessGroupGuard {
        fn drop(&mut self) {
            if let Ok(pid) = i32::try_from(self.0) {
                // SAFETY: this guard owns the process group created by the fixture.
                let _ = unsafe { libc::kill(-pid, libc::SIGKILL) };
            }
        }
    }

    fn current_support_run_directories() -> Vec<PathBuf> {
        let process_marker = format!("-{}-", std::process::id());
        let mut directories = std::fs::read_dir(std::env::temp_dir())
            .expect("temporary directory")
            .filter_map(Result::ok)
            .filter_map(|entry| {
                let name = entry.file_name();
                let name = name.to_str()?;
                (name.starts_with("coding-wife-support-") && name.contains(&process_marker))
                    .then(|| entry.path())
            })
            .collect::<Vec<_>>();
        directories.sort();
        directories
    }

    async fn assert_controlled_construction_close_converges(mode: &str, force: bool) {
        let _environment = SUPPORT_ENVIRONMENT_LOCK.lock().await;
        let fixture = ConstructionFixture::new(mode);
        let initial_directories = current_support_run_directories();
        let binary = fixture_support_binary().await;
        let schema = probe_schema(&binary).await.expect("fixture schema");
        let auth = fixture.auth_source();
        let resource_directory = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let control = SupportConstructionControl::new();
        let task_control = control.clone();
        let construction = tokio::spawn(async move {
            SupportRuntime::construct_presence_controlled(
                &binary,
                &schema,
                &resource_directory,
                Some(&auth),
                task_control,
            )
            .await
        });
        let pid = wait_for_probe_process(&fixture.state).await;
        let _process_guard = FixtureProcessGroupGuard(pid);

        let converged = if force {
            tokio::time::timeout(Duration::from_millis(500), control.force_shutdown_now())
                .await
                .expect("force cleanup must stay inside the app lifecycle step")
        } else {
            tokio::time::timeout(Duration::from_secs(5), control.cancel())
                .await
                .expect("graceful construction cleanup deadline")
        };
        assert!(converged, "construction cleanup must converge");
        let outcome = tokio::time::timeout(Duration::from_secs(2), construction)
            .await
            .expect("construction task completion")
            .expect("construction task join");
        match outcome {
            Err(error) => assert_eq!(error.reason(), SupportRuntimeError::Canceled),
            Ok(_) => panic!("canceled construction must not return a runtime lease"),
        }
        wait_for_process_group_exit(pid).await;
        wait_until(|| {
            current_support_run_directories()
                .iter()
                .all(|directory| initial_directories.contains(directory))
        })
        .await;
    }

    #[test]
    fn semantic_projection_contains_only_the_exact_pathless_input() {
        let executor = Arc::new(FakeExecutor::default());
        let events = Arc::new(CapturingEvents::default());
        let director = director(executor, events, fast_timing());
        director
            .set_scope(scope(PresenceLocale::Ja))
            .expect("scope");
        let candidate = director
            .candidate(
                "workspace-fixture".to_owned(),
                7,
                "event-fixture".to_owned(),
                PresenceTrigger::DecisionWait,
                Some("pending-fixture".to_owned()),
                None,
                PresenceElapsedBucket::None,
                false,
            )
            .expect("candidate");
        assert_eq!(
            serde_json::to_value(candidate.request.input).expect("serialize input"),
            json!({
                "schemaVersion": 1,
                "locale": "ja",
                "trigger": "decision_wait",
                "semanticState": "asking",
                "retrying": false,
                "elapsedBucket": "none"
            })
        );
    }

    #[test]
    fn cooldown_boundary_uses_an_explicit_clock_and_documented_bypasses() {
        let executor = Arc::new(FakeExecutor::default());
        let events = Arc::new(CapturingEvents::default());
        let director = director(executor, events, fast_timing());
        director
            .set_scope(scope(PresenceLocale::Ja))
            .expect("scope");
        let routine = director
            .candidate(
                "workspace-fixture".to_owned(),
                7,
                "event-completed".to_owned(),
                PresenceTrigger::TurnCompleted,
                None,
                None,
                PresenceElapsedBucket::None,
                false,
            )
            .expect("routine candidate");
        let urgent = director
            .candidate(
                "workspace-fixture".to_owned(),
                7,
                "event-decision".to_owned(),
                PresenceTrigger::DecisionWait,
                Some("pending-fixture".to_owned()),
                None,
                PresenceElapsedBucket::None,
                false,
            )
            .expect("urgent candidate");
        let published_at = Instant::now();
        let data = PresenceData {
            last_published: Some(("workspace-fixture".to_owned(), 7, published_at)),
            ..PresenceData::default()
        };
        let cooldown = Duration::from_secs(30);

        assert_eq!(
            cooldown_remaining_at(
                &data,
                &routine,
                cooldown,
                published_at + Duration::from_secs(29),
            ),
            Duration::from_secs(1)
        );
        assert_eq!(
            cooldown_remaining_at(
                &data,
                &routine,
                cooldown,
                published_at + Duration::from_secs(30),
            ),
            Duration::ZERO
        );
        assert_eq!(
            cooldown_remaining_at(&data, &urgent, cooldown, published_at),
            Duration::ZERO
        );
    }

    #[test]
    fn routine_tool_events_and_nonretrying_warnings_do_not_start_luna() {
        let executor = Arc::new(FakeExecutor::default());
        let events = Arc::new(CapturingEvents::default());
        let director = director(executor, events, fast_timing());
        director
            .set_scope(scope(PresenceLocale::Ja))
            .expect("scope");
        director.observe(&event(
            "event-tool",
            CodexEventPayload::ToolStatus {
                item_handle: "item-fixture".to_owned(),
                tool_kind: "commandExecution".to_owned(),
                provider_name: None,
                tool_name: "tool-fixture".to_owned(),
                summary: None,
                duration_ms: Some(1),
                status: "completed".to_owned(),
            },
        ));
        director.observe(&event(
            "event-warning",
            CodexEventPayload::Diagnostic {
                code: "CODEX-WARNING".to_owned(),
                will_retry: false,
                detail_ref: "detail-fixture".to_owned(),
            },
        ));
        let data = director
            .inner
            .data
            .lock()
            .expect("presence data lock poisoned");
        assert!(data.active.is_none());
        assert!(data.queued.is_none());
        assert!(!data.worker_running);
        assert_eq!(data.audit.attempts, 0);
    }

    #[tokio::test]
    async fn scheduler_keeps_capacity_one_and_highest_latest_waiting_candidate() {
        let executor = Arc::new(FakeExecutor::with_delay(Duration::from_millis(25)));
        let events = Arc::new(CapturingEvents::default());
        let director = director(executor.clone(), events.clone(), fast_timing());
        director
            .set_scope(scope(PresenceLocale::En))
            .expect("scope");

        director.observe(&event(
            "event-retry",
            CodexEventPayload::Diagnostic {
                code: "CODEX-FIXTURE".to_owned(),
                will_retry: true,
                detail_ref: "detail-fixture".to_owned(),
            },
        ));
        tokio::time::sleep(Duration::from_millis(2)).await;
        director.verified_commit(
            "workspace-fixture".to_owned(),
            7,
            "commit-fixture".to_owned(),
        );
        director.observe(&pending_event("event-decision-old", "pending-old"));
        director.observe(&pending_event("event-decision-latest", "pending-latest"));

        wait_until(|| events.0.lock().expect("events").len() == 2).await;
        let requests = executor.requests.lock().await.clone();
        assert_eq!(executor.max_active.load(Ordering::Acquire), 1);
        assert_eq!(requests.len(), 2);
        assert_eq!(
            requests[0].input.trigger,
            PresenceTrigger::RecoverableFailure
        );
        assert_eq!(requests[1].input.trigger, PresenceTrigger::DecisionWait);
        let emitted = events.0.lock().expect("events");
        assert_eq!(emitted[1].source_event_id, "event-decision-latest");
    }

    #[tokio::test]
    async fn verified_commit_survives_the_immediately_following_turn_completion() {
        let executor = Arc::new(FakeExecutor::with_delay(Duration::from_millis(25)));
        let events = Arc::new(CapturingEvents::default());
        let director = director(executor, events.clone(), fast_timing());
        director
            .set_scope(scope(PresenceLocale::Ja))
            .expect("scope");
        director.observe(&event(
            "event-started",
            CodexEventPayload::TurnStatus {
                thread_handle: "thread-fixture".to_owned(),
                turn_handle: "turn-fixture".to_owned(),
                status: "running".to_owned(),
            },
        ));
        director.verified_commit(
            "workspace-fixture".to_owned(),
            7,
            "commit-fixture".to_owned(),
        );
        tokio::time::sleep(Duration::from_millis(2)).await;
        director.observe(&event(
            "event-completed",
            CodexEventPayload::TurnStatus {
                thread_handle: "thread-fixture".to_owned(),
                turn_handle: "turn-fixture".to_owned(),
                status: "completed".to_owned(),
            },
        ));

        wait_until(|| !events.0.lock().expect("events").is_empty()).await;
        assert_eq!(
            events.0.lock().expect("events")[0].trigger,
            PresenceTrigger::CommitReady
        );
    }

    #[tokio::test]
    async fn cooldown_holds_routine_event_but_terminal_failure_bypasses_it() {
        let executor = Arc::new(FakeExecutor::default());
        let events = Arc::new(CapturingEvents::default());
        let timing = PresenceTiming {
            cooldown: Duration::from_millis(200),
            ..fast_timing()
        };
        let director = director(executor, events.clone(), timing);
        director
            .set_scope(scope(PresenceLocale::Ja))
            .expect("scope");
        director.verified_commit(
            "workspace-fixture".to_owned(),
            7,
            "commit-fixture".to_owned(),
        );
        wait_until(|| events.0.lock().expect("events").len() == 1).await;
        director.observe(&event(
            "event-completed",
            CodexEventPayload::TurnStatus {
                thread_handle: "thread-fixture".to_owned(),
                turn_handle: "turn-fixture".to_owned(),
                status: "completed".to_owned(),
            },
        ));
        tokio::time::sleep(Duration::from_millis(10)).await;
        assert_eq!(events.0.lock().expect("events").len(), 1);
        director.observe(&event(
            "event-failed",
            CodexEventPayload::TurnStatus {
                thread_handle: "thread-fixture".to_owned(),
                turn_handle: "turn-fixture-2".to_owned(),
                status: "failed".to_owned(),
            },
        ));
        wait_until(|| events.0.lock().expect("events").len() == 2).await;
        assert_eq!(
            events.0.lock().expect("events")[1].trigger,
            PresenceTrigger::TerminalFailure
        );
    }

    #[tokio::test]
    async fn milestone_buckets_are_admitted_only_while_the_same_turn_is_active() {
        let executor = Arc::new(FakeExecutor::default());
        let events = Arc::new(CapturingEvents::default());
        let timing = PresenceTiming {
            cooldown: Duration::ZERO,
            first_milestone: Duration::from_secs(3_600),
            second_milestone: Duration::from_secs(7_200),
        };
        let director = director(executor, events.clone(), timing);
        director
            .set_scope(scope(PresenceLocale::Ja))
            .expect("scope");
        director.observe(&event(
            "event-started",
            CodexEventPayload::TurnStatus {
                thread_handle: "thread-fixture".to_owned(),
                turn_handle: "turn-fixture".to_owned(),
                status: "running".to_owned(),
            },
        ));
        let marker = director
            .inner
            .data
            .lock()
            .expect("presence data")
            .active_turn
            .clone()
            .expect("active turn");
        director.submit_milestone_if_active(marker.clone(), PresenceElapsedBucket::Seconds45Plus);
        wait_until(|| events.0.lock().expect("events").len() == 1).await;
        director.submit_milestone_if_active(marker.clone(), PresenceElapsedBucket::Seconds120Plus);
        wait_until(|| events.0.lock().expect("events").len() == 2).await;
        let emitted = events.0.lock().expect("events");
        assert!(emitted
            .iter()
            .all(|event| event.trigger == PresenceTrigger::LongMilestone));
        drop(emitted);
        director.observe(&event(
            "event-interrupted",
            CodexEventPayload::TurnStatus {
                thread_handle: "thread-fixture".to_owned(),
                turn_handle: "turn-fixture".to_owned(),
                status: "interrupted".to_owned(),
            },
        ));
        director.submit_milestone_if_active(marker, PresenceElapsedBucket::Seconds120Plus);
        assert_eq!(events.0.lock().expect("events").len(), 2);
        assert_eq!(
            PresenceTiming::default().first_milestone,
            Duration::from_secs(45)
        );
        assert_eq!(
            PresenceTiming::default().second_milestone,
            Duration::from_secs(120)
        );
    }

    #[tokio::test]
    async fn resolved_decision_discards_a_late_result() {
        let executor = Arc::new(FakeExecutor::with_delay(Duration::from_millis(15)));
        let events = Arc::new(CapturingEvents::default());
        let director = director(executor.clone(), events.clone(), fast_timing());
        director
            .set_scope(scope(PresenceLocale::Ja))
            .expect("scope");
        director.observe(&pending_event("event-decision", "pending-fixture"));
        tokio::time::sleep(Duration::from_millis(2)).await;
        director.observe(&event(
            "event-resolved",
            CodexEventPayload::PendingRequestResolved {
                pending_id: "pending-fixture".to_owned(),
                status: crate::codex::types::PendingResolutionStatus::Accepted,
            },
        ));
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert!(events.0.lock().expect("events").is_empty());
        assert!(director.audit_snapshot().canceled > 0);
    }

    #[tokio::test]
    async fn invalid_result_emits_nothing_and_records_only_a_safe_code() {
        let executor = Arc::new(FakeExecutor::default());
        let events = Arc::new(CapturingEvents::default());
        let director = director(executor.clone(), events.clone(), fast_timing());
        director
            .set_scope(scope(PresenceLocale::Ja))
            .expect("scope");
        executor.push_result(Err(SupportRuntimeError::Output)).await;
        director.verified_commit(
            "workspace-fixture".to_owned(),
            7,
            "commit-fixture".to_owned(),
        );
        wait_until(|| {
            director.audit_snapshot().last_error_code == Some(SupportRuntimeError::Output.code())
        })
        .await;
        assert!(events.0.lock().expect("events").is_empty());
        assert_eq!(
            director.audit_snapshot().last_error_code,
            Some(SupportRuntimeError::Output.code())
        );
    }

    #[tokio::test]
    async fn runtime_timeout_is_terminal_and_the_next_candidate_still_runs() {
        let executor = Arc::new(FakeExecutor::default());
        let events = Arc::new(CapturingEvents::default());
        let director = director(executor.clone(), events.clone(), fast_timing());
        director
            .set_scope(scope(PresenceLocale::En))
            .expect("scope");
        executor
            .push_result(Err(SupportRuntimeError::Timeout))
            .await;
        director.verified_commit(
            "workspace-fixture".to_owned(),
            7,
            "commit-timeout".to_owned(),
        );
        wait_until(|| {
            director.audit_snapshot().last_error_code == Some(SupportRuntimeError::Timeout.code())
        })
        .await;
        assert!(events.0.lock().expect("events").is_empty());

        director.verified_commit(
            "workspace-fixture".to_owned(),
            7,
            "commit-after-timeout".to_owned(),
        );
        wait_until(|| events.0.lock().expect("events").len() == 1).await;
        assert_eq!(executor.requests.lock().await.len(), 2);
        assert_eq!(
            events.0.lock().expect("events")[0].source_event_id,
            "commit-after-timeout"
        );
    }

    #[tokio::test]
    async fn generation_change_cancels_an_active_result_before_publication() {
        let executor = Arc::new(FakeExecutor::with_delay(Duration::from_millis(20)));
        let events = Arc::new(CapturingEvents::default());
        let director = director(executor, events.clone(), fast_timing());
        director
            .set_scope(scope(PresenceLocale::En))
            .expect("initial scope");
        director.verified_commit(
            "workspace-fixture".to_owned(),
            7,
            "commit-fixture".to_owned(),
        );
        tokio::time::sleep(Duration::from_millis(2)).await;
        director
            .set_scope(PresenceScopeRequestV1 {
                schema_version: 1,
                workspace_id: "workspace-fixture".to_owned(),
                workspace_generation: 8,
                locale: PresenceLocale::En,
            })
            .expect("new generation scope");
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert!(events.0.lock().expect("events").is_empty());
        assert!(director.audit_snapshot().canceled > 0);
    }

    #[tokio::test]
    async fn force_shutdown_skips_graceful_cancel_and_discards_the_late_result() {
        let executor = Arc::new(FakeExecutor::with_delay(Duration::from_millis(25)));
        let events = Arc::new(CapturingEvents::default());
        let director = director(executor.clone(), events.clone(), fast_timing());
        director
            .set_scope(scope(PresenceLocale::Ja))
            .expect("scope");
        director.verified_commit(
            "workspace-fixture".to_owned(),
            7,
            "commit-fixture".to_owned(),
        );
        wait_until(|| executor.active.load(Ordering::Acquire) == 1).await;

        assert!(director.shutdown_inner(true).await);
        assert_eq!(executor.cancels.load(Ordering::Acquire), 0);
        assert_eq!(executor.shutdowns.load(Ordering::Acquire), 0);
        assert_eq!(executor.forces.load(Ordering::Acquire), 1);
        tokio::time::sleep(Duration::from_millis(35)).await;
        assert!(events.0.lock().expect("events").is_empty());
    }

    #[tokio::test]
    async fn graceful_close_during_isolation_probe_joins_the_owned_process_tree() {
        assert_controlled_construction_close_converges("support_probe_slow_grandchild", false)
            .await;
    }

    #[tokio::test]
    async fn force_close_during_isolation_probe_joins_the_owned_process_tree() {
        assert_controlled_construction_close_converges("support_probe_slow_grandchild", true).await;
    }

    #[tokio::test]
    async fn force_close_during_sandbox_probe_joins_the_unregistered_process_tree() {
        assert_controlled_construction_close_converges("support_sandbox_slow_grandchild", true)
            .await;
    }

    #[tokio::test]
    async fn force_close_during_runtime_initialization_joins_the_owned_process_tree() {
        assert_controlled_construction_close_converges(
            "support_initialization_slow_grandchild",
            true,
        )
        .await;
    }
}
