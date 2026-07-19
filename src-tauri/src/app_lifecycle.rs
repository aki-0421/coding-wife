use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::codex::commit_explanation::CommitExplanationController;
use crate::codex::supervisor::CodexSupervisor;
use crate::narration::NarrationService;
use crate::workspace_history::WorkspaceHistoryService;

pub const APP_LIFECYCLE_SCHEMA_VERSION: u16 = 1;
pub const APP_CLOSE_REQUESTED_EVENT_CHANNEL: &str = "coding-wife://app-close-requested";
pub const APP_CLEANUP_FAILED_EVENT_CHANNEL: &str = "coding-wife://app-cleanup-failed";
pub const APP_SHUTDOWN_DEADLINE: Duration = Duration::from_secs(5);
const APP_FORCE_SHUTDOWN_STEP_DEADLINE: Duration = Duration::from_millis(500);

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ActiveTurnIdentity {
    pub workspace_id: String,
    pub workspace_generation: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct AppCloseRequestedV1 {
    pub schema_version: u16,
    pub request_id: String,
    pub workspace_id: String,
    pub workspace_generation: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct AppQuitRequestV1 {
    pub schema_version: u16,
    pub request_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct AppCleanupFailedV1 {
    pub schema_version: u16,
    pub request_id: String,
    pub attempt: u16,
    pub error_code: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AppShutdownAttempt {
    request_id: String,
    attempt: u16,
    previous_report: Option<AppShutdownReport>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum AppLifecycleState {
    Open,
    Confirming(AppCloseRequestedV1),
    ShuttingDown(AppShutdownAttempt),
    CleanupFailed {
        failure: AppCleanupFailedV1,
        report: AppShutdownReport,
    },
    ExitReady,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NativeCloseDecision {
    Prompt(AppCloseRequestedV1),
    BeginShutdown(AppShutdownAttempt),
    CleanupFailed(AppCleanupFailedV1),
    AlreadyShuttingDown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ShutdownOutcome {
    Completed,
    Failed,
    TimedOut,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ForceCleanupOutcome {
    NotRequired,
    Completed,
    Failed,
    TimedOut,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct AppShutdownReport {
    graceful: ShutdownOutcome,
    codex: ForceCleanupOutcome,
    narration: ForceCleanupOutcome,
    explanation: ForceCleanupOutcome,
    history: ForceCleanupOutcome,
}

impl AppShutdownReport {
    fn completed(self) -> bool {
        self.graceful == ShutdownOutcome::Completed
            || [self.codex, self.narration, self.explanation, self.history]
                .into_iter()
                .all(|outcome| outcome == ForceCleanupOutcome::Completed)
    }
}

type ShutdownFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

trait AppShutdownPlan: Send + Sync {
    fn graceful_shutdown(&self) -> ShutdownFuture<'_, bool>;
    fn force_codex(&self) -> ShutdownFuture<'_, bool>;
    fn force_narration(&self) -> ShutdownFuture<'_, bool>;
    fn force_explanation(&self) -> ShutdownFuture<'_, bool>;
    fn force_history(&self) -> ShutdownFuture<'_, bool>;
}

struct NativeAppShutdownPlan {
    supervisor: CodexSupervisor,
    narration: Option<NarrationService>,
    explanation: Option<CommitExplanationController>,
    history: Option<WorkspaceHistoryService>,
}

impl AppShutdownPlan for NativeAppShutdownPlan {
    fn graceful_shutdown(&self) -> ShutdownFuture<'_, bool> {
        Box::pin(async move {
            let mut converged = self.supervisor.shutdown().await;
            if let Some(narration) = self.narration.as_ref() {
                converged &= narration.shutdown().await.is_ok();
            }
            if let Some(explanation) = self.explanation.as_ref() {
                converged &= explanation.shutdown().await.is_ok();
            }
            if let Some(history) = self.history.as_ref() {
                converged &= history.shutdown().await.is_ok();
            }
            converged
        })
    }

    fn force_codex(&self) -> ShutdownFuture<'_, bool> {
        Box::pin(async move { self.supervisor.force_shutdown_now().await })
    }

    fn force_narration(&self) -> ShutdownFuture<'_, bool> {
        Box::pin(async move {
            match self.narration.as_ref() {
                Some(narration) => narration.force_shutdown_now().await,
                None => true,
            }
        })
    }

    fn force_explanation(&self) -> ShutdownFuture<'_, bool> {
        Box::pin(async move {
            match self.explanation.as_ref() {
                Some(explanation) => explanation.force_shutdown_now().await,
                None => true,
            }
        })
    }

    fn force_history(&self) -> ShutdownFuture<'_, bool> {
        Box::pin(async move {
            match self.history.as_ref() {
                Some(history) => history.force_shutdown_now().await.is_ok(),
                None => true,
            }
        })
    }
}

#[derive(Debug)]
pub struct AppLifecycleCoordinator {
    state: Mutex<AppLifecycleState>,
    exit_ready: AtomicBool,
}

impl Default for AppLifecycleCoordinator {
    fn default() -> Self {
        Self {
            state: Mutex::new(AppLifecycleState::Open),
            exit_ready: AtomicBool::new(false),
        }
    }
}

impl AppLifecycleCoordinator {
    pub fn request_close(&self, active: Option<ActiveTurnIdentity>) -> NativeCloseDecision {
        let mut state = self.state.lock().expect("app lifecycle lock poisoned");
        match &*state {
            AppLifecycleState::Confirming(request) => {
                return NativeCloseDecision::Prompt(request.clone());
            }
            AppLifecycleState::ShuttingDown(_) => {
                return NativeCloseDecision::AlreadyShuttingDown;
            }
            AppLifecycleState::CleanupFailed { failure, .. } => {
                return NativeCloseDecision::CleanupFailed(failure.clone());
            }
            AppLifecycleState::ExitReady => return NativeCloseDecision::AlreadyShuttingDown,
            AppLifecycleState::Open => {}
        }
        let Some(active) = active else {
            let attempt = AppShutdownAttempt {
                request_id: format!("app-quit-{}", uuid::Uuid::new_v4()),
                attempt: 1,
                previous_report: None,
            };
            *state = AppLifecycleState::ShuttingDown(attempt.clone());
            return NativeCloseDecision::BeginShutdown(attempt);
        };
        let request = AppCloseRequestedV1 {
            schema_version: APP_LIFECYCLE_SCHEMA_VERSION,
            request_id: format!("app-quit-{}", uuid::Uuid::new_v4()),
            workspace_id: active.workspace_id,
            workspace_generation: active.workspace_generation,
        };
        *state = AppLifecycleState::Confirming(request.clone());
        NativeCloseDecision::Prompt(request)
    }

    pub fn cancel_quit(&self, request: &AppQuitRequestV1) -> Result<(), AppLifecycleError> {
        validate_quit_request(request, "app_quit_cancel")?;
        let mut state = self.state.lock().expect("app lifecycle lock poisoned");
        match &*state {
            AppLifecycleState::Confirming(current) if current.request_id == request.request_id => {
                *state = AppLifecycleState::Open;
                Ok(())
            }
            _ => Err(AppLifecycleError::stale("app_quit_cancel")),
        }
    }

    pub fn confirm_quit(
        &self,
        request: &AppQuitRequestV1,
    ) -> Result<AppShutdownAttempt, AppLifecycleError> {
        validate_quit_request(request, "app_quit_confirm")?;
        let mut state = self.state.lock().expect("app lifecycle lock poisoned");
        match &*state {
            AppLifecycleState::Confirming(current) if current.request_id == request.request_id => {
                let attempt = AppShutdownAttempt {
                    request_id: request.request_id.clone(),
                    attempt: 1,
                    previous_report: None,
                };
                *state = AppLifecycleState::ShuttingDown(attempt.clone());
                Ok(attempt)
            }
            _ => Err(AppLifecycleError::stale("app_quit_confirm")),
        }
    }

    pub fn retry_cleanup(
        &self,
        request: &AppQuitRequestV1,
    ) -> Result<AppShutdownAttempt, AppLifecycleError> {
        validate_quit_request(request, "app_quit_retry_cleanup")?;
        let mut state = self.state.lock().expect("app lifecycle lock poisoned");
        match &*state {
            AppLifecycleState::CleanupFailed { failure, report }
                if failure.request_id == request.request_id =>
            {
                let attempt = AppShutdownAttempt {
                    request_id: request.request_id.clone(),
                    attempt: failure.attempt.saturating_add(1),
                    previous_report: Some(*report),
                };
                *state = AppLifecycleState::ShuttingDown(attempt.clone());
                Ok(attempt)
            }
            _ => Err(AppLifecycleError::stale("app_quit_retry_cleanup")),
        }
    }

    fn finish_shutdown_attempt(
        &self,
        attempt: &AppShutdownAttempt,
        report: AppShutdownReport,
    ) -> Result<Option<AppCleanupFailedV1>, AppLifecycleError> {
        let mut state = self.state.lock().expect("app lifecycle lock poisoned");
        let AppLifecycleState::ShuttingDown(current) = &*state else {
            return Err(AppLifecycleError::stale("app_quit_finish"));
        };
        if current.request_id != attempt.request_id || current.attempt != attempt.attempt {
            return Err(AppLifecycleError::stale("app_quit_finish"));
        }
        if report.completed() {
            *state = AppLifecycleState::ExitReady;
            self.exit_ready.store(true, Ordering::Release);
            return Ok(None);
        }
        let failure = AppCleanupFailedV1 {
            schema_version: APP_LIFECYCLE_SCHEMA_VERSION,
            request_id: attempt.request_id.clone(),
            attempt: attempt.attempt,
            error_code: "APP-QUIT-CLEANUP-INCOMPLETE".to_owned(),
        };
        *state = AppLifecycleState::CleanupFailed {
            failure: failure.clone(),
            report,
        };
        Ok(Some(failure))
    }

    pub fn is_shutting_down(&self) -> bool {
        matches!(
            *self.state.lock().expect("app lifecycle lock poisoned"),
            AppLifecycleState::ShuttingDown(_)
                | AppLifecycleState::CleanupFailed { .. }
                | AppLifecycleState::ExitReady
        )
    }

    pub fn can_exit(&self) -> bool {
        self.exit_ready.load(Ordering::Acquire)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct AppLifecycleError {
    pub code: String,
    pub operation: String,
    pub recoverable: bool,
    pub user_message_key: String,
}

impl AppLifecycleError {
    fn stale(operation: &str) -> Self {
        Self {
            code: "APP-QUIT-REQUEST-STALE".to_owned(),
            operation: operation.to_owned(),
            recoverable: false,
            user_message_key: "app.quit.error".to_owned(),
        }
    }

    fn invalid(operation: &str) -> Self {
        Self {
            code: "APP-QUIT-REQUEST-INVALID".to_owned(),
            operation: operation.to_owned(),
            recoverable: false,
            user_message_key: "app.quit.error".to_owned(),
        }
    }
}

fn validate_quit_request(
    request: &AppQuitRequestV1,
    operation: &str,
) -> Result<(), AppLifecycleError> {
    if request.schema_version != APP_LIFECYCLE_SCHEMA_VERSION
        || !valid_opaque_id(&request.request_id, "app-quit-")
    {
        return Err(AppLifecycleError::invalid(operation));
    }
    Ok(())
}

fn valid_opaque_id(value: &str, prefix: &str) -> bool {
    value.starts_with(prefix)
        && value.len() <= 128
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
}

pub async fn run_with_shutdown_deadline<F>(future: F, deadline: Duration) -> ShutdownOutcome
where
    F: Future<Output = ()>,
{
    match tokio::time::timeout(deadline, future).await {
        Ok(()) => ShutdownOutcome::Completed,
        Err(_) => ShutdownOutcome::TimedOut,
    }
}

async fn run_force_cleanup(
    cleanup: ShutdownFuture<'_, bool>,
    deadline: Duration,
) -> ForceCleanupOutcome {
    match tokio::time::timeout(deadline, cleanup).await {
        Ok(true) => ForceCleanupOutcome::Completed,
        Ok(false) => ForceCleanupOutcome::Failed,
        Err(_) => ForceCleanupOutcome::TimedOut,
    }
}

async fn execute_shutdown_plan<P>(
    plan: &P,
    previous_report: Option<AppShutdownReport>,
    graceful_deadline: Duration,
    force_step_deadline: Duration,
) -> AppShutdownReport
where
    P: AppShutdownPlan,
{
    let mut report = match previous_report {
        Some(report) => report,
        None => {
            let graceful =
                match tokio::time::timeout(graceful_deadline, plan.graceful_shutdown()).await {
                    Ok(true) => ShutdownOutcome::Completed,
                    Ok(false) => ShutdownOutcome::Failed,
                    Err(_) => ShutdownOutcome::TimedOut,
                };
            AppShutdownReport {
                graceful,
                codex: ForceCleanupOutcome::NotRequired,
                narration: ForceCleanupOutcome::NotRequired,
                explanation: ForceCleanupOutcome::NotRequired,
                history: ForceCleanupOutcome::NotRequired,
            }
        }
    };
    if report.graceful == ShutdownOutcome::Completed {
        return report;
    }
    if report.codex != ForceCleanupOutcome::Completed {
        report.codex = run_force_cleanup(plan.force_codex(), force_step_deadline).await;
    }
    if report.narration != ForceCleanupOutcome::Completed {
        report.narration = run_force_cleanup(plan.force_narration(), force_step_deadline).await;
    }
    if report.explanation != ForceCleanupOutcome::Completed {
        report.explanation = run_force_cleanup(plan.force_explanation(), force_step_deadline).await;
    }
    if report.history != ForceCleanupOutcome::Completed {
        report.history = run_force_cleanup(plan.force_history(), force_step_deadline).await;
    }
    report
}

#[tauri::command]
pub fn app_quit_cancel(
    request: AppQuitRequestV1,
    lifecycle: State<'_, Arc<AppLifecycleCoordinator>>,
) -> Result<(), AppLifecycleError> {
    lifecycle.cancel_quit(&request)
}

#[tauri::command]
pub fn app_quit_confirm(
    request: AppQuitRequestV1,
    lifecycle: State<'_, Arc<AppLifecycleCoordinator>>,
    app: AppHandle,
) -> Result<(), AppLifecycleError> {
    let attempt = lifecycle.confirm_quit(&request)?;
    spawn_app_shutdown(app, attempt);
    Ok(())
}

#[tauri::command]
pub fn app_quit_retry_cleanup(
    request: AppQuitRequestV1,
    lifecycle: State<'_, Arc<AppLifecycleCoordinator>>,
    app: AppHandle,
) -> Result<(), AppLifecycleError> {
    let attempt = lifecycle.retry_cleanup(&request)?;
    spawn_app_shutdown(app, attempt);
    Ok(())
}

pub fn raise_main_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}

pub fn request_app_close(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let supervisor = app.state::<CodexSupervisor>().inner().clone();
        let lifecycle = app.state::<Arc<AppLifecycleCoordinator>>().inner().clone();
        let active =
            supervisor
                .active_turn_identity()
                .await
                .map(|(workspace_id, workspace_generation)| ActiveTurnIdentity {
                    workspace_id,
                    workspace_generation,
                });
        match lifecycle.request_close(active) {
            NativeCloseDecision::Prompt(request) => {
                raise_main_window(&app);
                let _ = app.emit(APP_CLOSE_REQUESTED_EVENT_CHANNEL, request);
            }
            NativeCloseDecision::BeginShutdown(attempt) => spawn_app_shutdown(app, attempt),
            NativeCloseDecision::CleanupFailed(failure) => {
                raise_main_window(&app);
                let _ = app.emit(APP_CLEANUP_FAILED_EVENT_CHANNEL, failure);
            }
            NativeCloseDecision::AlreadyShuttingDown => {}
        }
    });
}

fn spawn_app_shutdown(app: AppHandle, attempt: AppShutdownAttempt) {
    tauri::async_runtime::spawn(async move {
        let plan = NativeAppShutdownPlan {
            supervisor: app.state::<CodexSupervisor>().inner().clone(),
            narration: app
                .try_state::<NarrationService>()
                .map(|state| state.inner().clone()),
            explanation: app
                .try_state::<CommitExplanationController>()
                .map(|state| state.inner().clone()),
            history: app
                .try_state::<WorkspaceHistoryService>()
                .map(|state| state.inner().clone()),
        };
        let lifecycle = app.state::<Arc<AppLifecycleCoordinator>>().inner().clone();
        let report = execute_shutdown_plan(
            &plan,
            attempt.previous_report,
            APP_SHUTDOWN_DEADLINE,
            APP_FORCE_SHUTDOWN_STEP_DEADLINE,
        )
        .await;
        match lifecycle.finish_shutdown_attempt(&attempt, report) {
            Ok(None) => app.exit(0),
            Ok(Some(failure)) => {
                raise_main_window(&app);
                let _ = app.emit(APP_CLEANUP_FAILED_EVENT_CHANNEL, failure);
            }
            Err(_) => {}
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Clone, Copy)]
    enum TestCleanupBehavior {
        Complete,
        Fail,
        Pending,
    }

    struct RecordingShutdownPlan {
        log: Arc<Mutex<Vec<&'static str>>>,
        graceful: TestCleanupBehavior,
        codex: TestCleanupBehavior,
        narration: TestCleanupBehavior,
        explanation: TestCleanupBehavior,
        history: TestCleanupBehavior,
    }

    impl RecordingShutdownPlan {
        fn new(log: Arc<Mutex<Vec<&'static str>>>, graceful: TestCleanupBehavior) -> Self {
            Self {
                log,
                graceful,
                codex: TestCleanupBehavior::Complete,
                narration: TestCleanupBehavior::Complete,
                explanation: TestCleanupBehavior::Complete,
                history: TestCleanupBehavior::Complete,
            }
        }

        fn cleanup(
            &self,
            label: &'static str,
            behavior: TestCleanupBehavior,
        ) -> ShutdownFuture<'_, bool> {
            Box::pin(async move {
                self.log.lock().expect("shutdown log").push(label);
                match behavior {
                    TestCleanupBehavior::Complete => true,
                    TestCleanupBehavior::Fail => false,
                    TestCleanupBehavior::Pending => std::future::pending::<bool>().await,
                }
            })
        }
    }

    impl AppShutdownPlan for RecordingShutdownPlan {
        fn graceful_shutdown(&self) -> ShutdownFuture<'_, bool> {
            self.cleanup("graceful", self.graceful)
        }

        fn force_codex(&self) -> ShutdownFuture<'_, bool> {
            self.cleanup("force-codex-descendants-absent", self.codex)
        }

        fn force_narration(&self) -> ShutdownFuture<'_, bool> {
            self.cleanup("force-narration-descendants-absent", self.narration)
        }

        fn force_explanation(&self) -> ShutdownFuture<'_, bool> {
            self.cleanup("force-explanation-descendants-absent", self.explanation)
        }

        fn force_history(&self) -> ShutdownFuture<'_, bool> {
            self.cleanup("force-history-interrupted-checkpoint", self.history)
        }
    }

    fn active(generation: u64) -> ActiveTurnIdentity {
        ActiveTurnIdentity {
            workspace_id: "workspace-safe".to_owned(),
            workspace_generation: generation,
        }
    }

    fn response(request: &AppCloseRequestedV1) -> AppQuitRequestV1 {
        AppQuitRequestV1 {
            schema_version: APP_LIFECYCLE_SCHEMA_VERSION,
            request_id: request.request_id.clone(),
        }
    }

    fn graceful_report() -> AppShutdownReport {
        AppShutdownReport {
            graceful: ShutdownOutcome::Completed,
            codex: ForceCleanupOutcome::NotRequired,
            narration: ForceCleanupOutcome::NotRequired,
            explanation: ForceCleanupOutcome::NotRequired,
            history: ForceCleanupOutcome::NotRequired,
        }
    }

    #[test]
    fn idle_close_begins_shutdown_only_once() {
        let coordinator = AppLifecycleCoordinator::default();
        let NativeCloseDecision::BeginShutdown(attempt) = coordinator.request_close(None) else {
            panic!("idle close must begin shutdown");
        };
        assert_eq!(
            coordinator.request_close(None),
            NativeCloseDecision::AlreadyShuttingDown
        );
        assert!(coordinator.is_shutting_down());
        assert!(!coordinator.can_exit());
        assert_eq!(
            coordinator
                .finish_shutdown_attempt(&attempt, graceful_report())
                .expect("complete shutdown"),
            None
        );
        assert!(coordinator.can_exit());
    }

    #[test]
    fn duplicate_running_close_reuses_one_request_and_cannot_bypass_confirmation() {
        let coordinator = AppLifecycleCoordinator::default();
        let NativeCloseDecision::Prompt(first) = coordinator.request_close(Some(active(7))) else {
            panic!("running close must prompt");
        };
        let NativeCloseDecision::Prompt(duplicate) = coordinator.request_close(Some(active(8)))
        else {
            panic!("duplicate close must keep prompting");
        };
        assert_eq!(duplicate, first);
        assert!(!coordinator.is_shutting_down());

        let mut stale = response(&first);
        stale.request_id = "app-quit-stale".to_owned();
        assert_eq!(
            coordinator
                .confirm_quit(&stale)
                .expect_err("stale rejected")
                .code,
            "APP-QUIT-REQUEST-STALE"
        );
        assert!(!coordinator.is_shutting_down());

        coordinator
            .confirm_quit(&response(&first))
            .expect("exact confirmation");
        assert!(coordinator.is_shutting_down());
        assert_eq!(
            coordinator.request_close(None),
            NativeCloseDecision::AlreadyShuttingDown
        );
    }

    #[test]
    fn dont_quit_returns_to_open_without_reusing_the_old_request() {
        let coordinator = AppLifecycleCoordinator::default();
        let NativeCloseDecision::Prompt(first) = coordinator.request_close(Some(active(3))) else {
            panic!("running close must prompt");
        };
        coordinator
            .cancel_quit(&response(&first))
            .expect("exact cancellation");
        assert!(!coordinator.is_shutting_down());
        let NativeCloseDecision::Prompt(second) = coordinator.request_close(Some(active(3))) else {
            panic!("later close must prompt");
        };
        assert_ne!(second.request_id, first.request_id);
    }

    #[tokio::test]
    async fn shutdown_deadline_reports_completion_and_timeout() {
        assert_eq!(
            run_with_shutdown_deadline(async {}, Duration::from_millis(20)).await,
            ShutdownOutcome::Completed
        );
        assert_eq!(
            run_with_shutdown_deadline(std::future::pending::<()>(), Duration::from_millis(10),)
                .await,
            ShutdownOutcome::TimedOut
        );
    }

    #[tokio::test]
    async fn graceful_shutdown_completes_without_invoking_force_cleanup() {
        let log = Arc::new(Mutex::new(Vec::new()));
        let plan = RecordingShutdownPlan::new(log.clone(), TestCleanupBehavior::Complete);
        let report = execute_shutdown_plan(
            &plan,
            None,
            Duration::from_millis(20),
            Duration::from_millis(20),
        )
        .await;

        assert_eq!(report.graceful, ShutdownOutcome::Completed);
        assert_eq!(report.codex, ForceCleanupOutcome::NotRequired);
        assert!(report.completed());
        assert_eq!(*log.lock().expect("shutdown log"), ["graceful"]);
    }

    #[tokio::test]
    async fn timeout_forces_every_service_in_privacy_safe_order() {
        let log = Arc::new(Mutex::new(Vec::new()));
        let plan = RecordingShutdownPlan::new(log.clone(), TestCleanupBehavior::Pending);
        let report = execute_shutdown_plan(
            &plan,
            None,
            Duration::from_millis(5),
            Duration::from_millis(20),
        )
        .await;

        assert_eq!(
            report,
            AppShutdownReport {
                graceful: ShutdownOutcome::TimedOut,
                codex: ForceCleanupOutcome::Completed,
                narration: ForceCleanupOutcome::Completed,
                explanation: ForceCleanupOutcome::Completed,
                history: ForceCleanupOutcome::Completed,
            }
        );
        let events = log.lock().expect("shutdown log").clone();
        assert_eq!(
            events,
            [
                "graceful",
                "force-codex-descendants-absent",
                "force-narration-descendants-absent",
                "force-explanation-descendants-absent",
                "force-history-interrupted-checkpoint",
            ]
        );
        assert!(!events.join(" ").contains("/Users/"));
        assert!(!events.join(" ").contains("token="));
    }

    #[tokio::test]
    async fn force_failure_stays_open_and_retry_runs_only_unfinished_cleanup() {
        let log = Arc::new(Mutex::new(Vec::new()));
        let mut plan = RecordingShutdownPlan::new(log.clone(), TestCleanupBehavior::Fail);
        plan.narration = TestCleanupBehavior::Fail;
        plan.explanation = TestCleanupBehavior::Pending;
        let report = execute_shutdown_plan(
            &plan,
            None,
            Duration::from_millis(20),
            Duration::from_millis(5),
        )
        .await;

        assert_eq!(report.graceful, ShutdownOutcome::Failed);
        assert_eq!(report.narration, ForceCleanupOutcome::Failed);
        assert_eq!(report.explanation, ForceCleanupOutcome::TimedOut);
        assert_eq!(report.history, ForceCleanupOutcome::Completed);
        assert!(!report.completed());

        let coordinator = AppLifecycleCoordinator::default();
        let NativeCloseDecision::BeginShutdown(first_attempt) = coordinator.request_close(None)
        else {
            panic!("idle close begins shutdown");
        };
        let failure = coordinator
            .finish_shutdown_attempt(&first_attempt, report)
            .expect("failed cleanup remains recoverable")
            .expect("cleanup failure event");
        assert_eq!(failure.error_code, "APP-QUIT-CLEANUP-INCOMPLETE");
        assert!(!coordinator.can_exit());
        assert_eq!(
            coordinator.request_close(None),
            NativeCloseDecision::CleanupFailed(failure.clone())
        );

        let retry = coordinator
            .retry_cleanup(&AppQuitRequestV1 {
                schema_version: APP_LIFECYCLE_SCHEMA_VERSION,
                request_id: failure.request_id.clone(),
            })
            .expect("retry cleanup");
        assert!(coordinator
            .retry_cleanup(&AppQuitRequestV1 {
                schema_version: APP_LIFECYCLE_SCHEMA_VERSION,
                request_id: failure.request_id,
            })
            .is_err());
        let retry_log = Arc::new(Mutex::new(Vec::new()));
        let retry_plan =
            RecordingShutdownPlan::new(retry_log.clone(), TestCleanupBehavior::Complete);
        let retry_report = execute_shutdown_plan(
            &retry_plan,
            retry.previous_report,
            Duration::from_millis(20),
            Duration::from_millis(20),
        )
        .await;
        assert_eq!(
            *retry_log.lock().expect("retry log"),
            [
                "force-narration-descendants-absent",
                "force-explanation-descendants-absent",
            ]
        );
        assert!(retry_report.completed());
        assert_eq!(
            coordinator
                .finish_shutdown_attempt(&retry, retry_report)
                .expect("retry completes"),
            None
        );
        assert!(coordinator.can_exit());
    }
}
