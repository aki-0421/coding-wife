use std::future::Future;
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
pub const APP_SHUTDOWN_DEADLINE: Duration = Duration::from_secs(5);

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

#[derive(Clone, Debug, Eq, PartialEq)]
enum AppLifecycleState {
    Open,
    Confirming(AppCloseRequestedV1),
    ShuttingDown,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NativeCloseDecision {
    Prompt(AppCloseRequestedV1),
    BeginShutdown,
    AlreadyShuttingDown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ShutdownOutcome {
    Completed,
    TimedOut,
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
            AppLifecycleState::ShuttingDown => {
                return NativeCloseDecision::AlreadyShuttingDown;
            }
            AppLifecycleState::Open => {}
        }
        let Some(active) = active else {
            *state = AppLifecycleState::ShuttingDown;
            return NativeCloseDecision::BeginShutdown;
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

    pub fn confirm_quit(&self, request: &AppQuitRequestV1) -> Result<(), AppLifecycleError> {
        validate_quit_request(request, "app_quit_confirm")?;
        let mut state = self.state.lock().expect("app lifecycle lock poisoned");
        match &*state {
            AppLifecycleState::Confirming(current) if current.request_id == request.request_id => {
                *state = AppLifecycleState::ShuttingDown;
                Ok(())
            }
            _ => Err(AppLifecycleError::stale("app_quit_confirm")),
        }
    }

    pub fn is_shutting_down(&self) -> bool {
        matches!(
            *self.state.lock().expect("app lifecycle lock poisoned"),
            AppLifecycleState::ShuttingDown
        )
    }

    pub fn mark_exit_ready(&self) {
        self.exit_ready.store(true, Ordering::Release);
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
    lifecycle.confirm_quit(&request)?;
    spawn_app_shutdown(app);
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
            NativeCloseDecision::BeginShutdown => spawn_app_shutdown(app),
            NativeCloseDecision::AlreadyShuttingDown => {}
        }
    });
}

fn spawn_app_shutdown(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let supervisor = app.state::<CodexSupervisor>().inner().clone();
        let narration = app
            .try_state::<NarrationService>()
            .map(|state| state.inner().clone());
        let explanation = app
            .try_state::<CommitExplanationController>()
            .map(|state| state.inner().clone());
        let history = app
            .try_state::<WorkspaceHistoryService>()
            .map(|state| state.inner().clone());
        let outcome = run_with_shutdown_deadline(
            async {
                supervisor.shutdown().await;
                if let Some(narration) = narration {
                    let _ = narration.shutdown().await;
                }
                if let Some(explanation) = explanation {
                    explanation.shutdown().await;
                }
                if let Some(history) = history {
                    let _ = history.shutdown().await;
                }
            },
            APP_SHUTDOWN_DEADLINE,
        )
        .await;
        if outcome == ShutdownOutcome::TimedOut {
            let _ =
                tokio::time::timeout(Duration::from_millis(250), supervisor.force_shutdown_now())
                    .await;
        }
        app.state::<Arc<AppLifecycleCoordinator>>()
            .mark_exit_ready();
        app.exit(0);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

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

    #[test]
    fn idle_close_begins_shutdown_only_once() {
        let coordinator = AppLifecycleCoordinator::default();
        assert_eq!(
            coordinator.request_close(None),
            NativeCloseDecision::BeginShutdown
        );
        assert_eq!(
            coordinator.request_close(None),
            NativeCloseDecision::AlreadyShuttingDown
        );
        assert!(coordinator.is_shutting_down());
        assert!(!coordinator.can_exit());
        coordinator.mark_exit_ready();
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
}
