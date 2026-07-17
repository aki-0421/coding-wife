//! Opaque-handle Tauri boundary for Git review operations.

use tauri::State;

use super::error::GitReviewError;
use super::service::GitReviewService;
use super::types::{
    CancelRestoreRequest, CheckpointEvaluation, CompareCheckpointsRequest, CompareCheckpointsView,
    ConfirmRestoreRequest, EvaluateCheckpointRequest, FileDiffView, GitBaseline,
    InspectGitBaselineRequest, ListReviewPacksRequest, PreviewRestoreRequest, ReadFileDiffRequest,
    RestorePreview, RestoreResult, ReviewPack, ReviewPackDetailRequest, ReviewPackPage,
};

#[tauri::command]
pub async fn inspect_git_baseline(
    request: InspectGitBaselineRequest,
    service: State<'_, GitReviewService>,
) -> Result<GitBaseline, GitReviewError> {
    service.inspect_baseline(request).await
}

#[tauri::command]
pub async fn evaluate_and_checkpoint_work_unit(
    request: EvaluateCheckpointRequest,
    service: State<'_, GitReviewService>,
) -> Result<CheckpointEvaluation, GitReviewError> {
    service.evaluate_checkpoint(request).await
}

#[tauri::command]
pub async fn list_git_review_packs(
    request: ListReviewPacksRequest,
    service: State<'_, GitReviewService>,
) -> Result<ReviewPackPage, GitReviewError> {
    service.list_review_packs(request).await
}

#[tauri::command]
pub async fn read_git_review_pack(
    request: ReviewPackDetailRequest,
    service: State<'_, GitReviewService>,
) -> Result<ReviewPack, GitReviewError> {
    service.review_pack_detail(request).await
}

#[tauri::command]
pub async fn read_evidence_diff(
    request: ReadFileDiffRequest,
    service: State<'_, GitReviewService>,
) -> Result<FileDiffView, GitReviewError> {
    service.read_file_diff(request).await
}

#[tauri::command]
pub async fn compare_checkpoints(
    request: CompareCheckpointsRequest,
    service: State<'_, GitReviewService>,
) -> Result<CompareCheckpointsView, GitReviewError> {
    service.compare_checkpoints(request).await
}

#[tauri::command]
pub async fn preview_git_restore(
    request: PreviewRestoreRequest,
    service: State<'_, GitReviewService>,
) -> Result<RestorePreview, GitReviewError> {
    service.preview_restore(request).await
}

#[tauri::command]
pub async fn confirm_git_restore(
    request: ConfirmRestoreRequest,
    service: State<'_, GitReviewService>,
) -> Result<RestoreResult, GitReviewError> {
    service.confirm_restore(request).await
}

#[tauri::command]
pub async fn cancel_git_restore(
    request: CancelRestoreRequest,
    service: State<'_, GitReviewService>,
) -> Result<(), GitReviewError> {
    service.cancel_restore(request).await
}

#[cfg(test)]
mod tests {
    use super::super::types::{InspectGitBaselineRequest, PreviewRestoreRequest};

    #[test]
    fn command_requests_reject_paths_git_arguments_and_unknown_fields() {
        assert!(
            serde_json::from_value::<InspectGitBaselineRequest>(serde_json::json!({
                "workspaceId": "workspace-fixture",
                "repositoryPath": "/tmp/repository"
            }))
            .is_err()
        );
        assert!(
            serde_json::from_value::<PreviewRestoreRequest>(serde_json::json!({
                "workspaceId": "workspace-fixture",
                "checkpointId": "checkpoint-fixture",
                "kind": "recovery_branch",
                "recoveryBranch": "recovery/fixture",
                "gitArgs": ["update-ref", "refs/heads/main"]
            }))
            .is_err()
        );
    }
}
