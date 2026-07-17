use tauri::State;

use super::attachment::{
    AttachmentPathRegistrationRequest, AttachmentRegistrationResponse, AttachmentSelectionRequest,
    AttachmentService, AttachmentWorkspaceContext,
};
use super::supervisor::CodexSupervisor;
use super::types::{
    AcceptedResponse, CodexCommandError, CodexConnectRequest, CodexDiagnostic,
    CodexFallbackDecisionRequest, CodexPendingResponseRequest, CodexReviewStartRequest,
    CodexThreadListRequest, CodexThreadResumeRequest, CodexThreadStartRequest,
    CodexTurnInterruptRequest, CodexTurnStartRequest, ReviewResponse, ThreadListResponse,
    ThreadResponse, TurnResponse,
};
use super::workspace::{WorkspaceRegistration, WorkspaceService};

async fn attachment_context(
    workspace_id: &str,
    supervisor: &CodexSupervisor,
    workspace_service: &WorkspaceService,
) -> Result<AttachmentWorkspaceContext, CodexCommandError> {
    let identity = workspace_service
        .trusted_identity(workspace_id)
        .await
        .ok_or_else(|| {
            CodexCommandError::new(
                "CODEX-ATTACHMENT-WORKSPACE-UNTRUSTED",
                "codex.attachment",
                false,
            )
        })?;
    let generation = supervisor.active_generation(workspace_id).await?;
    Ok(AttachmentWorkspaceContext {
        workspace_id: workspace_id.to_owned(),
        generation,
        canonical_root: identity.canonical_root,
        root_device: identity.root_device,
        root_inode: identity.root_inode,
    })
}

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
    workspace_service: State<'_, WorkspaceService>,
    attachment_service: State<'_, AttachmentService>,
) -> Result<TurnResponse, CodexCommandError> {
    let context = attachment_context(
        &request.workspace_id,
        supervisor.inner(),
        workspace_service.inner(),
    )
    .await?;
    let attachments = attachment_service
        .resolve_for_turn(context.clone(), &request.attachment_handles)
        .await?;
    let response = supervisor
        .turn_start_resolved(request, attachments.inputs, context.generation)
        .await?;
    attachment_service
        .consume(&context, &attachments.handles)
        .await;
    Ok(response)
}

#[tauri::command]
pub async fn codex_pick_attachments(
    request: AttachmentSelectionRequest,
    supervisor: State<'_, CodexSupervisor>,
    workspace_service: State<'_, WorkspaceService>,
    attachment_service: State<'_, AttachmentService>,
) -> Result<AttachmentRegistrationResponse, CodexCommandError> {
    let context = attachment_context(
        &request.workspace_id,
        supervisor.inner(),
        workspace_service.inner(),
    )
    .await?;
    attachment_service
        .pick_and_register(context, request.existing_handles)
        .await
}

#[tauri::command]
pub async fn codex_register_attachment_paths(
    request: AttachmentPathRegistrationRequest,
    supervisor: State<'_, CodexSupervisor>,
    workspace_service: State<'_, WorkspaceService>,
    attachment_service: State<'_, AttachmentService>,
) -> Result<AttachmentRegistrationResponse, CodexCommandError> {
    let context = attachment_context(
        &request.workspace_id,
        supervisor.inner(),
        workspace_service.inner(),
    )
    .await?;
    attachment_service
        .register_paths(
            context,
            request.source,
            request.paths,
            request.existing_handles,
        )
        .await
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

#[tauri::command]
pub async fn codex_answer_fallback_decision(
    request: CodexFallbackDecisionRequest,
    supervisor: State<'_, CodexSupervisor>,
) -> Result<TurnResponse, CodexCommandError> {
    supervisor.answer_fallback_decision(request).await
}
