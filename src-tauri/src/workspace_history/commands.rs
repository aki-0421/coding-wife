use tauri::State;

use super::service::WorkspaceHistoryService;
use super::types::{
    AppendDomainEventRequest, AppendDomainEventResponse, ContextSnapshotView, TimelinePage,
    WorkspaceCommandError, WorkspaceCreateSessionRequest, WorkspaceDeleteChallengeRequest,
    WorkspaceDeleteChallengeView, WorkspaceDeleteRequest, WorkspaceDraftView,
    WorkspacePickResponse, WorkspaceSaveContextRequest, WorkspaceSaveDraftRequest,
    WorkspaceSelectRequest, WorkspaceStateSnapshot, WorkspaceSummary, WorkspaceTimelineRequest,
    WorkspaceUpdateLifecycleRequest,
};

#[tauri::command]
pub fn workspace_list(
    service: State<'_, WorkspaceHistoryService>,
) -> Result<WorkspaceStateSnapshot, WorkspaceCommandError> {
    service.list()
}

#[tauri::command]
pub async fn workspace_pick_register(
    service: State<'_, WorkspaceHistoryService>,
) -> Result<WorkspacePickResponse, WorkspaceCommandError> {
    service.pick_register().await
}

#[tauri::command]
pub async fn workspace_create_session(
    request: WorkspaceCreateSessionRequest,
    service: State<'_, WorkspaceHistoryService>,
) -> Result<WorkspaceStateSnapshot, WorkspaceCommandError> {
    service.create_session(request).await
}

#[tauri::command]
pub async fn workspace_select(
    request: WorkspaceSelectRequest,
    service: State<'_, WorkspaceHistoryService>,
) -> Result<WorkspaceStateSnapshot, WorkspaceCommandError> {
    service.select(request).await
}

#[tauri::command]
pub async fn workspace_update_lifecycle(
    request: WorkspaceUpdateLifecycleRequest,
    service: State<'_, WorkspaceHistoryService>,
) -> Result<WorkspaceSummary, WorkspaceCommandError> {
    service.update_lifecycle(request).await
}

#[tauri::command]
pub async fn workspace_save_draft(
    request: WorkspaceSaveDraftRequest,
    service: State<'_, WorkspaceHistoryService>,
) -> Result<WorkspaceDraftView, WorkspaceCommandError> {
    service.save_draft(request).await
}

#[tauri::command]
pub async fn workspace_save_context_snapshot(
    request: WorkspaceSaveContextRequest,
    service: State<'_, WorkspaceHistoryService>,
) -> Result<ContextSnapshotView, WorkspaceCommandError> {
    service.save_context(request).await
}

#[tauri::command]
pub fn workspace_list_timeline(
    request: WorkspaceTimelineRequest,
    service: State<'_, WorkspaceHistoryService>,
) -> Result<TimelinePage, WorkspaceCommandError> {
    service.timeline(request)
}

#[tauri::command]
pub fn workspace_issue_delete_challenge(
    request: WorkspaceDeleteChallengeRequest,
    service: State<'_, WorkspaceHistoryService>,
) -> Result<WorkspaceDeleteChallengeView, WorkspaceCommandError> {
    service.issue_delete_challenge(&request.workspace_id)
}

#[tauri::command]
pub async fn workspace_delete(
    request: WorkspaceDeleteRequest,
    service: State<'_, WorkspaceHistoryService>,
) -> Result<WorkspaceStateSnapshot, WorkspaceCommandError> {
    service.delete(request).await
}

#[tauri::command]
pub async fn history_append_domain_event(
    request: AppendDomainEventRequest,
    service: State<'_, WorkspaceHistoryService>,
) -> Result<AppendDomainEventResponse, WorkspaceCommandError> {
    service.append_domain_event(request).await
}
