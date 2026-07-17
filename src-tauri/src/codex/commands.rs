use tauri::State;

use super::supervisor::CodexSupervisor;
use super::types::{
    AcceptedResponse, CodexCommandError, CodexConnectRequest, CodexDiagnostic,
    CodexPendingResponseRequest, CodexReviewStartRequest, CodexThreadListRequest,
    CodexThreadResumeRequest, CodexThreadStartRequest, CodexTurnInterruptRequest,
    CodexTurnStartRequest, ReviewResponse, ThreadListResponse, ThreadResponse, TurnResponse,
};
use super::workspace::{WorkspaceRegistration, WorkspaceService};

#[tauri::command]
pub async fn codex_pick_workspace(
    workspace_service: State<'_, WorkspaceService>,
) -> Result<WorkspaceRegistration, CodexCommandError> {
    workspace_service.pick_and_register().await
}

#[tauri::command]
pub async fn codex_get_diagnostic(
    supervisor: State<'_, CodexSupervisor>,
) -> Result<CodexDiagnostic, CodexCommandError> {
    Ok(supervisor.diagnostic().await)
}

#[tauri::command]
pub async fn codex_probe(
    supervisor: State<'_, CodexSupervisor>,
) -> Result<CodexDiagnostic, CodexCommandError> {
    supervisor.probe().await
}

#[tauri::command]
pub async fn codex_connect(
    request: CodexConnectRequest,
    supervisor: State<'_, CodexSupervisor>,
) -> Result<CodexDiagnostic, CodexCommandError> {
    supervisor.connect(request).await
}

#[tauri::command]
pub async fn codex_thread_list(
    request: CodexThreadListRequest,
    supervisor: State<'_, CodexSupervisor>,
) -> Result<ThreadListResponse, CodexCommandError> {
    supervisor.thread_list(request).await
}

#[tauri::command]
pub async fn codex_thread_start(
    request: CodexThreadStartRequest,
    supervisor: State<'_, CodexSupervisor>,
) -> Result<ThreadResponse, CodexCommandError> {
    supervisor.thread_start(request).await
}

#[tauri::command]
pub async fn codex_thread_resume(
    request: CodexThreadResumeRequest,
    supervisor: State<'_, CodexSupervisor>,
) -> Result<ThreadResponse, CodexCommandError> {
    supervisor.thread_resume(request).await
}

#[tauri::command]
pub async fn codex_turn_start(
    request: CodexTurnStartRequest,
    supervisor: State<'_, CodexSupervisor>,
) -> Result<TurnResponse, CodexCommandError> {
    supervisor.turn_start(request).await
}

#[tauri::command]
pub async fn codex_turn_interrupt(
    request: CodexTurnInterruptRequest,
    supervisor: State<'_, CodexSupervisor>,
) -> Result<AcceptedResponse, CodexCommandError> {
    supervisor.turn_interrupt(request).await
}

#[tauri::command]
pub async fn codex_review_start(
    request: CodexReviewStartRequest,
    supervisor: State<'_, CodexSupervisor>,
) -> Result<ReviewResponse, CodexCommandError> {
    supervisor.review_start(request).await
}

#[tauri::command]
pub async fn codex_respond_pending(
    request: CodexPendingResponseRequest,
    supervisor: State<'_, CodexSupervisor>,
) -> Result<AcceptedResponse, CodexCommandError> {
    supervisor.respond_pending(request).await
}
