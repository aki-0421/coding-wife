use tauri::State;

use super::service::WorkspaceHistoryService;
use super::types::{
    AppSaveCharacterContextRequest, AppendDomainEventRequest, AppendDomainEventResponse,
    CharacterGetContextRequest, ContextSnapshotView, ProjectGetContextRequest,
    ProjectSaveContextRequest, ProjectSelectRequest, TimelinePage, VersionedCharacterContext,
    VersionedProjectContext, WorkspaceArchiveRequest, WorkspaceCancelRequest,
    WorkspaceCommandError, WorkspaceCreateSessionRequest, WorkspaceDeleteChallengeRequest,
    WorkspaceDeleteChallengeView, WorkspaceDeleteRequest, WorkspaceDraftView,
    WorkspaceLoadEditableContextRequest, WorkspacePickResponse, WorkspaceRecheckRequest,
    WorkspaceSaveContextRequest, WorkspaceSaveDraftRequest, WorkspaceSaveTimelineAnchorRequest,
    WorkspaceSelectRequest, WorkspaceStateSnapshot, WorkspaceSummary, WorkspaceTimelineAnchorView,
    WorkspaceTimelineRequest, WorkspaceTurnContextSnapshot, WorkspaceUpdateLifecycleRequest,
};

#[tauri::command]
pub async fn workspace_list(
    service: State<'_, WorkspaceHistoryService>,
) -> Result<WorkspaceStateSnapshot, WorkspaceCommandError> {
    service.list_after_startup().await
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
pub async fn workspace_recheck(
    request: WorkspaceRecheckRequest,
    service: State<'_, WorkspaceHistoryService>,
) -> Result<WorkspaceStateSnapshot, WorkspaceCommandError> {
    service.recheck(request).await
}

#[tauri::command]
pub async fn workspace_repair(
    request: WorkspaceSelectRequest,
    service: State<'_, WorkspaceHistoryService>,
) -> Result<WorkspaceStateSnapshot, WorkspaceCommandError> {
    service.repair(request).await
}

#[tauri::command]
pub async fn workspace_unregister(
    request: ProjectSelectRequest,
    service: State<'_, WorkspaceHistoryService>,
) -> Result<WorkspaceStateSnapshot, WorkspaceCommandError> {
    service.unregister(request).await
}

#[tauri::command]
pub async fn workspace_archive(
    request: WorkspaceArchiveRequest,
    service: State<'_, WorkspaceHistoryService>,
) -> Result<WorkspaceStateSnapshot, WorkspaceCommandError> {
    service.archive(request).await
}

#[tauri::command]
pub async fn workspace_update_lifecycle(
    request: WorkspaceUpdateLifecycleRequest,
    service: State<'_, WorkspaceHistoryService>,
) -> Result<WorkspaceSummary, WorkspaceCommandError> {
    service.update_lifecycle(request).await
}

#[tauri::command]
pub async fn workspace_cancel(
    request: WorkspaceCancelRequest,
    service: State<'_, WorkspaceHistoryService>,
) -> Result<WorkspaceSummary, WorkspaceCommandError> {
    service.cancel(request).await
}

#[tauri::command]
pub async fn workspace_save_draft(
    request: WorkspaceSaveDraftRequest,
    service: State<'_, WorkspaceHistoryService>,
) -> Result<WorkspaceDraftView, WorkspaceCommandError> {
    service.save_draft(request).await
}

#[tauri::command]
pub async fn workspace_save_timeline_anchor(
    request: WorkspaceSaveTimelineAnchorRequest,
    service: State<'_, WorkspaceHistoryService>,
) -> Result<WorkspaceTimelineAnchorView, WorkspaceCommandError> {
    service.save_timeline_anchor(request).await
}

#[tauri::command]
pub async fn workspace_save_context_snapshot(
    request: WorkspaceSaveContextRequest,
    service: State<'_, WorkspaceHistoryService>,
) -> Result<ContextSnapshotView, WorkspaceCommandError> {
    service.save_context(request).await
}

#[tauri::command]
pub fn project_context_get(
    request: ProjectGetContextRequest,
    service: State<'_, WorkspaceHistoryService>,
) -> Result<VersionedProjectContext, WorkspaceCommandError> {
    service.project_context(request)
}

#[tauri::command]
pub async fn project_context_save(
    request: ProjectSaveContextRequest,
    service: State<'_, WorkspaceHistoryService>,
) -> Result<VersionedProjectContext, WorkspaceCommandError> {
    service.save_project_context(request).await
}

#[tauri::command]
pub fn app_character_context_get(
    request: CharacterGetContextRequest,
    service: State<'_, WorkspaceHistoryService>,
) -> Result<VersionedCharacterContext, WorkspaceCommandError> {
    service.character_context(request)
}

#[tauri::command]
pub async fn app_character_context_save(
    request: AppSaveCharacterContextRequest,
    service: State<'_, WorkspaceHistoryService>,
) -> Result<VersionedCharacterContext, WorkspaceCommandError> {
    service.save_character_context(request).await
}

#[tauri::command]
pub async fn workspace_get_turn_context_snapshot(
    request: WorkspaceLoadEditableContextRequest,
    service: State<'_, WorkspaceHistoryService>,
) -> Result<WorkspaceTurnContextSnapshot, WorkspaceCommandError> {
    service.turn_context_snapshot(request).await
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
