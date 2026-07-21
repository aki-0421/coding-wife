use tauri::State;

#[cfg(feature = "desktop-qa")]
use std::path::{Path, PathBuf};

#[cfg(feature = "desktop-qa")]
use serde::Deserialize;

use super::attachment::{
    AttachmentPathRegistrationRequest, AttachmentRegistrationResponse, AttachmentSelectionRequest,
    AttachmentService, AttachmentWorkspaceContext,
};
use super::supervisor::CodexSupervisor;
use super::types::{
    AcceptedResponse, CodexCommandError, CodexDiagnostic, CodexFallbackDecisionRequest,
    CodexPendingResponseRequest, CodexReviewStartRequest, CodexThreadListRequest,
    CodexThreadResumeRequest, CodexThreadStartRequest, CodexTurnInterruptRequest,
    CodexTurnStartRequest, ReviewResponse, ThreadListResponse, ThreadResponse, TurnResponse,
};
use super::workspace::{WorkspaceRegistration, WorkspaceService};

#[cfg(feature = "desktop-qa")]
use crate::workspace_history::types::WorkspaceCommandError;
#[cfg(feature = "desktop-qa")]
use crate::workspace_history::WorkspaceHistoryService;

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

#[cfg(feature = "desktop-qa")]
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DesktopQaRegisterWorkspaceFixtureRequest {
    pub schema_version: u16,
    pub workspace_id: String,
    pub alias: String,
    pub path: String,
}

#[cfg(feature = "desktop-qa")]
async fn desktop_qa_fixture_path_allowed(path: &Path, app_data_path: &Path) -> bool {
    let mut allowed_roots = Vec::new();
    if let Ok(root) = tokio::fs::canonicalize(std::env::temp_dir()).await {
        allowed_roots.push(root);
    }
    if let Some(parent) = app_data_path.parent() {
        if let Ok(root) = tokio::fs::canonicalize(parent).await {
            allowed_roots.push(root);
        }
    }
    allowed_roots.iter().any(|root| path.starts_with(root))
}

#[cfg(feature = "desktop-qa")]
#[tauri::command]
pub async fn desktop_qa_register_workspace_fixture(
    request: DesktopQaRegisterWorkspaceFixtureRequest,
    history: State<'_, WorkspaceHistoryService>,
) -> Result<WorkspaceRegistration, WorkspaceCommandError> {
    const OPERATION: &str = "desktop_qa.register_workspace_fixture";
    let Some(app_data_path) = std::env::var_os("CODING_WIFE_DESKTOP_QA_DATA_DIR")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
    else {
        return Err(WorkspaceCommandError::new(
            "CODEX-DESKTOP-QA-UNAVAILABLE",
            OPERATION,
            false,
        ));
    };
    if request.schema_version != 1
        || request.path.is_empty()
        || request.path.len() > 4_096
        || request.path.trim() != request.path
        || request.path.chars().any(char::is_control)
    {
        return Err(WorkspaceCommandError::new(
            "CODEX-DESKTOP-QA-FIXTURE-INVALID",
            OPERATION,
            false,
        ));
    }
    let raw_path = PathBuf::from(request.path);
    if !raw_path.is_absolute() {
        return Err(WorkspaceCommandError::new(
            "CODEX-DESKTOP-QA-FIXTURE-INVALID",
            OPERATION,
            false,
        ));
    }
    let canonical_path = tokio::fs::canonicalize(raw_path).await.map_err(|_| {
        WorkspaceCommandError::new("CODEX-DESKTOP-QA-FIXTURE-MISSING", OPERATION, true)
    })?;
    if !desktop_qa_fixture_path_allowed(&canonical_path, &app_data_path).await {
        return Err(WorkspaceCommandError::new(
            "CODEX-DESKTOP-QA-FIXTURE-PATH-UNSAFE",
            OPERATION,
            false,
        ));
    }
    history
        .register_desktop_qa_workspace_fixture(canonical_path, request.workspace_id, request.alias)
        .await
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
    supervisor: State<'_, CodexSupervisor>,
) -> Result<CodexDiagnostic, CodexCommandError> {
    supervisor.connect().await
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
    let handles = attachments.handles().to_vec();
    let response = supervisor
        .turn_start_resolved(request, attachments, context.generation)
        .await?;
    attachment_service.consume(&context, &handles).await;
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
