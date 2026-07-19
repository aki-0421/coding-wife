//! Opaque-handle Tauri boundary for read-only Git observation and evidence.

use tauri::State;

use super::error::GitReviewError;
use super::service::GitReviewService;
use super::types::{
    CommitDiffFile, CommitEvidenceDetail, CommitEvidenceDetailRequest, CommitEvidencePage,
    CommitEvidenceV1, GitObservation, ListCommitEvidenceRequest, ObserveGitRepositoryRequest,
    ObserveTerminalWorkUnitRequest, PrepareCommitExplanationEvidenceRequest, ReadCommitDiffRequest,
    TerminalWorkUnitObservationResult,
};

#[tauri::command]
pub async fn observe_git_repository(
    request: ObserveGitRepositoryRequest,
    service: State<'_, GitReviewService>,
) -> Result<GitObservation, GitReviewError> {
    service.observe_repository(request).await
}

#[tauri::command]
pub async fn observe_terminal_work_unit(
    request: ObserveTerminalWorkUnitRequest,
    service: State<'_, GitReviewService>,
) -> Result<TerminalWorkUnitObservationResult, GitReviewError> {
    service.observe_terminal_work_unit(request).await
}

#[tauri::command]
pub async fn list_commit_evidence(
    request: ListCommitEvidenceRequest,
    service: State<'_, GitReviewService>,
) -> Result<CommitEvidencePage, GitReviewError> {
    service.list_commit_evidence(request).await
}

#[tauri::command]
pub async fn read_commit_evidence(
    request: CommitEvidenceDetailRequest,
    service: State<'_, GitReviewService>,
) -> Result<CommitEvidenceDetail, GitReviewError> {
    service.read_commit_evidence(request).await
}

#[tauri::command]
pub async fn read_commit_diff_file(
    request: ReadCommitDiffRequest,
    service: State<'_, GitReviewService>,
) -> Result<CommitDiffFile, GitReviewError> {
    service.read_commit_diff(request).await
}

#[tauri::command]
pub async fn prepare_commit_explanation_evidence(
    request: PrepareCommitExplanationEvidenceRequest,
    service: State<'_, GitReviewService>,
) -> Result<CommitEvidenceV1, GitReviewError> {
    service.prepare_explanation_evidence(request).await
}

#[cfg(test)]
mod tests {
    use super::super::types::CommitEvidenceDetailRequest;

    #[test]
    fn command_requests_reject_paths_git_arguments_and_unknown_fields() {
        assert!(
            serde_json::from_value::<CommitEvidenceDetailRequest>(serde_json::json!({
                "schemaVersion": 1,
                "workspaceId": "workspace-fixture",
                "workspaceGeneration": 1,
                "commitEvidenceId": format!("commit-{}", "a".repeat(40)),
                "repositoryPath": "/tmp/repository",
                "gitArgs": ["commit-tree"]
            }))
            .is_err()
        );
    }
}
