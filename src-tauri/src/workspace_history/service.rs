use std::path::Path;
use std::sync::Arc;

use tokio::sync::Mutex;

use crate::codex::types::CodexCommandError;
use crate::codex::workspace::{ValidatedWorkspaceCandidate, WorkspaceService};

use super::store::WorkspaceHistoryStore;
use super::types::{
    AppendDomainEventRequest, AppendDomainEventResponse, ContextSnapshotView, ContextSource,
    HistoryMode, NormalizedDomainEvent, TimelinePage, WorkspaceCommandError,
    WorkspaceCreateSessionRequest, WorkspaceDeleteChallengeView, WorkspaceDeleteRequest,
    WorkspaceDraftView, WorkspaceHealth, WorkspacePickOutcome, WorkspacePickResponse,
    WorkspaceSaveContextRequest, WorkspaceSaveDraftRequest, WorkspaceSelectRequest,
    WorkspaceStateSnapshot, WorkspaceSummary, WorkspaceTimelineRequest,
    WorkspaceUpdateLifecycleRequest, WORKSPACE_HISTORY_SCHEMA_VERSION,
};

const PICK_CANCELED_CODE: &str = "CODEX-WORKSPACE-PICK-CANCELED";

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct StartupRestoreReport {
    pub ready: usize,
    pub changed: usize,
    pub unavailable: usize,
    pub skipped_read_only: bool,
}

#[derive(Clone)]
pub struct WorkspaceHistoryService {
    store: WorkspaceHistoryStore,
    workspace: WorkspaceService,
    operation_lock: Arc<Mutex<()>>,
}

impl WorkspaceHistoryService {
    pub fn new(store: WorkspaceHistoryStore, workspace: WorkspaceService) -> Self {
        Self {
            store,
            workspace,
            operation_lock: Arc::new(Mutex::new(())),
        }
    }

    pub fn list(&self) -> Result<WorkspaceStateSnapshot, WorkspaceCommandError> {
        self.store
            .snapshot(None)
            .map_err(|error| history_error("workspace_list", error))
    }

    pub async fn restore_startup(&self) -> StartupRestoreReport {
        let _operation = self.operation_lock.lock().await;
        let mut report = StartupRestoreReport::default();
        if self.store.status().mode != HistoryMode::Ready {
            report.skipped_read_only = true;
            return report;
        }
        let records = match self.store.private_workspace_records() {
            Ok(records) => records,
            Err(_) => {
                report.unavailable += 1;
                return report;
            }
        };

        for record in records {
            match self.workspace.validate_private_candidate(&record).await {
                Ok(candidate) => {
                    match self
                        .store
                        .update_preflight(&record.workspace_id, Ok(&candidate.git))
                    {
                        Ok(WorkspaceHealth::Ready) => {
                            if self.workspace.activate_candidate(candidate).await.is_ok() {
                                report.ready += 1;
                            } else {
                                let _ = self.store.update_preflight(
                                    &record.workspace_id,
                                    Err(WorkspaceHealth::Unreadable),
                                );
                                report.unavailable += 1;
                            }
                        }
                        Ok(WorkspaceHealth::Changed) => report.changed += 1,
                        Ok(_) | Err(_) => report.unavailable += 1,
                    }
                }
                Err(error) => {
                    let health = health_for_preflight_error(&error);
                    let _ = self
                        .store
                        .update_preflight(&record.workspace_id, Err(health));
                    report.unavailable += 1;
                }
            }
        }
        report
    }

    pub async fn pick_register(&self) -> Result<WorkspacePickResponse, WorkspaceCommandError> {
        let _operation = self.operation_lock.lock().await;
        let candidate = match self.workspace.pick_validated().await {
            Ok(candidate) => candidate,
            Err(error) if error.code == PICK_CANCELED_CODE => {
                return Ok(WorkspacePickResponse {
                    schema_version: WORKSPACE_HISTORY_SCHEMA_VERSION,
                    outcome: WorkspacePickOutcome::Canceled,
                    state: self
                        .store
                        .snapshot(None)
                        .map_err(|error| history_error("workspace_pick_register", error))?,
                });
            }
            Err(error) => return Err(codex_error("workspace_pick_register", error)),
        };
        let state = self
            .register_validated_candidate(candidate, "workspace_pick_register")
            .await?;
        Ok(WorkspacePickResponse {
            schema_version: WORKSPACE_HISTORY_SCHEMA_VERSION,
            outcome: WorkspacePickOutcome::Selected,
            state,
        })
    }

    pub async fn create_session(
        &self,
        request: WorkspaceCreateSessionRequest,
    ) -> Result<WorkspaceStateSnapshot, WorkspaceCommandError> {
        let _operation = self.operation_lock.lock().await;
        let persisted = self
            .store
            .create_session_workspace(
                &request.from_workspace_id,
                &request.name,
                &request.goal,
                &request.client_request_id,
            )
            .map_err(|error| history_error("workspace_create_session", error))?;
        let was_trusted = self
            .workspace
            .trusted_root(&persisted.workspace.workspace_id)
            .await
            .is_some();
        let candidate = match self
            .workspace
            .validate_private_candidate(&persisted.private_record)
            .await
        {
            Ok(candidate) => candidate,
            Err(error) => {
                if persisted.created {
                    let _ = self
                        .store
                        .rollback_registration(&persisted.workspace.workspace_id);
                }
                return Err(codex_error("workspace_create_session", error));
            }
        };
        let health = match self
            .store
            .update_preflight(&persisted.workspace.workspace_id, Ok(&candidate.git))
        {
            Ok(health) => health,
            Err(error) => {
                if persisted.created {
                    let _ = self
                        .store
                        .rollback_registration(&persisted.workspace.workspace_id);
                }
                return Err(history_error("workspace_create_session", error));
            }
        };
        if health != WorkspaceHealth::Ready {
            if persisted.created {
                let _ = self
                    .store
                    .rollback_registration(&persisted.workspace.workspace_id);
            }
            return Err(WorkspaceCommandError::new(
                "WORKSPACE-PREFLIGHT-CHANGED",
                "workspace_create_session",
                true,
            ));
        }
        if let Err(error) = self.workspace.activate_candidate(candidate).await {
            if persisted.created {
                let _ = self
                    .store
                    .rollback_registration(&persisted.workspace.workspace_id);
            }
            return Err(codex_error("workspace_create_session", error));
        }
        match self
            .store
            .select_workspace(&persisted.workspace.workspace_id)
        {
            Ok(state) => Ok(state),
            Err(error) => {
                if !was_trusted {
                    let _ = self
                        .workspace
                        .deactivate_workspace(&persisted.workspace.workspace_id)
                        .await;
                }
                if persisted.created {
                    let _ = self
                        .store
                        .rollback_registration(&persisted.workspace.workspace_id);
                }
                Err(history_error("workspace_create_session", error))
            }
        }
    }

    pub async fn select(
        &self,
        request: WorkspaceSelectRequest,
    ) -> Result<WorkspaceStateSnapshot, WorkspaceCommandError> {
        let _operation = self.operation_lock.lock().await;
        let was_trusted = self
            .workspace
            .trusted_root(&request.workspace_id)
            .await
            .is_some();
        let private_record = self
            .store
            .private_workspace_record(&request.workspace_id)
            .map_err(|error| history_error("workspace_select", error))?;
        let candidate = self
            .workspace
            .validate_private_candidate(&private_record)
            .await
            .map_err(|error| codex_error("workspace_select", error))?;
        let health = self
            .store
            .update_preflight(&request.workspace_id, Ok(&candidate.git))
            .map_err(|error| history_error("workspace_select", error))?;
        if health != WorkspaceHealth::Ready {
            return Err(WorkspaceCommandError::new(
                "WORKSPACE-PREFLIGHT-CHANGED",
                "workspace_select",
                true,
            ));
        }
        self.workspace
            .activate_candidate(candidate)
            .await
            .map_err(|error| codex_error("workspace_select", error))?;
        match self.store.select_workspace(&request.workspace_id) {
            Ok(state) => Ok(state),
            Err(error) => {
                if !was_trusted {
                    let _ = self
                        .workspace
                        .deactivate_workspace(&request.workspace_id)
                        .await;
                }
                Err(history_error("workspace_select", error))
            }
        }
    }

    pub async fn update_lifecycle(
        &self,
        request: WorkspaceUpdateLifecycleRequest,
    ) -> Result<WorkspaceSummary, WorkspaceCommandError> {
        let _operation = self.operation_lock.lock().await;
        self.store
            .update_lifecycle(
                &request.workspace_id,
                request.lifecycle,
                &request.expected_updated_at,
            )
            .map_err(|error| history_error("workspace_update_lifecycle", error))
    }

    pub async fn save_draft(
        &self,
        request: WorkspaceSaveDraftRequest,
    ) -> Result<WorkspaceDraftView, WorkspaceCommandError> {
        let _operation = self.operation_lock.lock().await;
        self.store
            .save_draft(
                &request.workspace_id,
                &request.text,
                request.effort,
                request.expected_revision,
            )
            .map_err(|error| history_error("workspace_save_draft", error))
    }

    pub async fn save_context(
        &self,
        request: WorkspaceSaveContextRequest,
    ) -> Result<ContextSnapshotView, WorkspaceCommandError> {
        let _operation = self.operation_lock.lock().await;
        let root = self
            .workspace
            .trusted_root(&request.workspace_id)
            .await
            .ok_or_else(|| {
                WorkspaceCommandError::new(
                    "WORKSPACE-CONTEXT-PREFLIGHT",
                    "workspace_save_context_snapshot",
                    true,
                )
            })?;
        let (label, content) = capture_context(&root, request.source).await?;
        self.store
            .save_context_snapshot(&request.workspace_id, request.source, label, &content)
            .map_err(|error| history_error("workspace_save_context_snapshot", error))
    }

    pub fn timeline(
        &self,
        request: WorkspaceTimelineRequest,
    ) -> Result<TimelinePage, WorkspaceCommandError> {
        self.store
            .timeline(
                &request.workspace_id,
                request.before_sequence,
                request.limit,
                request.search.as_deref(),
            )
            .map_err(|error| history_error("workspace_list_timeline", error))
    }

    pub fn issue_delete_challenge(
        &self,
        workspace_id: &str,
    ) -> Result<WorkspaceDeleteChallengeView, WorkspaceCommandError> {
        let challenge = self
            .store
            .issue_delete_challenge(workspace_id)
            .map_err(|error| history_error("workspace_issue_delete_challenge", error))?;
        Ok(WorkspaceDeleteChallengeView {
            schema_version: WORKSPACE_HISTORY_SCHEMA_VERSION,
            workspace_id: challenge.workspace_id,
            token: challenge.token,
            expires_at: challenge.expires_at,
        })
    }

    pub async fn delete(
        &self,
        request: WorkspaceDeleteRequest,
    ) -> Result<WorkspaceStateSnapshot, WorkspaceCommandError> {
        let _operation = self.operation_lock.lock().await;
        let was_trusted = self
            .workspace
            .trusted_root(&request.workspace_id)
            .await
            .is_some();
        let restore_candidate = if was_trusted {
            match self.store.private_workspace_record(&request.workspace_id) {
                Ok(record) => self
                    .workspace
                    .validate_private_candidate(&record)
                    .await
                    .ok(),
                Err(_) => None,
            }
        } else {
            None
        };
        if was_trusted {
            self.workspace
                .deactivate_workspace(&request.workspace_id)
                .await
                .map_err(|error| codex_error("workspace_delete", error))?;
        }
        if let Err(error) = self
            .store
            .delete_workspace(&request.workspace_id, &request.token)
        {
            if let Some(candidate) = restore_candidate {
                let _ = self.workspace.activate_candidate(candidate).await;
            }
            return Err(history_error("workspace_delete", error));
        }
        self.store
            .snapshot(None)
            .map_err(|error| history_error("workspace_delete", error))
    }

    pub async fn append_domain_event(
        &self,
        request: AppendDomainEventRequest,
    ) -> Result<AppendDomainEventResponse, WorkspaceCommandError> {
        let _operation = self.operation_lock.lock().await;
        let result = self
            .store
            .append_event(&NormalizedDomainEvent {
                schema_version: request.schema_version,
                event_id: request.event_id,
                workspace_id: request.workspace_id,
                session_id: request.session_id,
                producer: request.producer,
                kind: request.kind,
                occurred_at: request.occurred_at,
                payload: request.payload,
            })
            .map_err(|error| history_error("history_append_domain_event", error))?;
        Ok(AppendDomainEventResponse {
            schema_version: WORKSPACE_HISTORY_SCHEMA_VERSION,
            sequence: result.sequence,
            inserted: result.inserted,
        })
    }

    async fn register_validated_candidate(
        &self,
        candidate: ValidatedWorkspaceCandidate,
        operation: &'static str,
    ) -> Result<WorkspaceStateSnapshot, WorkspaceCommandError> {
        let persisted = self
            .store
            .register_candidate(&candidate)
            .map_err(|error| history_error(operation, error))?;
        let was_trusted = self
            .workspace
            .trusted_root(&persisted.workspace.workspace_id)
            .await
            .is_some();
        let activation_candidate =
            if persisted.workspace.workspace_id == candidate.registration.workspace_id {
                candidate
            } else {
                match self
                    .workspace
                    .validate_private_candidate(&persisted.private_record)
                    .await
                {
                    Ok(candidate) => candidate,
                    Err(error) => {
                        if !persisted.duplicate {
                            let _ = self
                                .store
                                .rollback_registration(&persisted.workspace.workspace_id);
                        }
                        return Err(codex_error(operation, error));
                    }
                }
            };
        if let Err(error) = self
            .workspace
            .activate_candidate(activation_candidate)
            .await
        {
            if !persisted.duplicate {
                let _ = self
                    .store
                    .rollback_registration(&persisted.workspace.workspace_id);
            }
            return Err(codex_error(operation, error));
        }
        match self
            .store
            .select_workspace(&persisted.workspace.workspace_id)
        {
            Ok(state) => Ok(state),
            Err(error) => {
                if !was_trusted {
                    let _ = self
                        .workspace
                        .deactivate_workspace(&persisted.workspace.workspace_id)
                        .await;
                }
                if !persisted.duplicate {
                    let _ = self
                        .store
                        .rollback_registration(&persisted.workspace.workspace_id);
                }
                Err(history_error(operation, error))
            }
        }
    }
}

async fn capture_context(
    root: &Path,
    source: ContextSource,
) -> Result<(&'static str, String), WorkspaceCommandError> {
    match source {
        ContextSource::Files => Ok((
            "Repository files",
            run_git_capture(
                root,
                &["ls-files", "--cached", "--others", "--exclude-standard"],
            )
            .await?,
        )),
        ContextSource::GitDiff => {
            let staged = run_git_capture(
                root,
                &["diff", "--cached", "--no-ext-diff", "--no-textconv", "--"],
            )
            .await?;
            let working =
                run_git_capture(root, &["diff", "--no-ext-diff", "--no-textconv", "--"]).await?;
            let content = format!("Staged changes:\n{staged}\nWorking tree changes:\n{working}");
            if content.len() > 1024 * 1024 {
                return Err(WorkspaceCommandError::new(
                    "WORKSPACE-CONTEXT-TOO-LARGE",
                    "workspace_save_context_snapshot",
                    false,
                ));
            }
            Ok(("Working tree diff", content))
        }
        ContextSource::TerminalOutput => Err(WorkspaceCommandError::new(
            "WORKSPACE-CONTEXT-SOURCE-UNAVAILABLE",
            "workspace_save_context_snapshot",
            true,
        )),
    }
}

async fn run_git_capture(root: &Path, arguments: &[&str]) -> Result<String, WorkspaceCommandError> {
    let output = tokio::process::Command::new("/usr/bin/git")
        .arg("-C")
        .arg(root)
        .args(arguments)
        .env_clear()
        .env("LC_ALL", "C")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .kill_on_drop(true)
        .output()
        .await
        .map_err(|_| {
            WorkspaceCommandError::new(
                "WORKSPACE-CONTEXT-GIT-UNAVAILABLE",
                "workspace_save_context_snapshot",
                true,
            )
        })?;
    if !output.status.success() || output.stdout.len() > 1024 * 1024 || output.stderr.len() > 4096 {
        return Err(WorkspaceCommandError::new(
            "WORKSPACE-CONTEXT-CAPTURE-FAILED",
            "workspace_save_context_snapshot",
            true,
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn health_for_preflight_error(error: &CodexCommandError) -> WorkspaceHealth {
    match error.code.as_str() {
        "CODEX-WORKSPACE-MISSING" => WorkspaceHealth::Missing,
        "CODEX-WORKSPACE-READ-ONLY" | "CODEX-WORKSPACE-WRITABLE-POLICY" => {
            WorkspaceHealth::ReadOnly
        }
        _ => WorkspaceHealth::Unreadable,
    }
}

fn history_error(
    operation: &str,
    error: super::types::WorkspaceHistoryError,
) -> WorkspaceCommandError {
    WorkspaceCommandError::new(error.code, operation, error.recoverable)
}

fn codex_error(operation: &str, error: CodexCommandError) -> WorkspaceCommandError {
    WorkspaceCommandError::new(error.code, operation, error.recoverable)
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};

    use crate::codex::supervisor::CodexSupervisor;
    use crate::codex::workspace::{AppPrivateWorkspaceRecord, WorkspaceService};

    use super::*;

    fn temp_directory(label: &str) -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("coding-wife-{label}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).expect("temp directory");
        path
    }

    fn git_repository() -> PathBuf {
        let root = temp_directory("history-service-repo");
        let status = std::process::Command::new("/usr/bin/git")
            .args(["init", "-q", "-b", "main"])
            .arg(&root)
            .status()
            .expect("git init");
        assert!(status.success());
        root
    }

    async fn candidate(workspace: &WorkspaceService, root: &Path) -> ValidatedWorkspaceCandidate {
        workspace
            .validate_private_candidate(&AppPrivateWorkspaceRecord {
                workspace_id: format!("workspace-{}", uuid::Uuid::new_v4()),
                alias: "Fixture repository".to_owned(),
                canonical_root: root.to_owned(),
            })
            .await
            .expect("candidate")
    }

    #[tokio::test]
    async fn supervisor_failure_rolls_back_new_database_registration() {
        let data = temp_directory("history-service-data");
        let root = git_repository();
        let workspace = WorkspaceService::production(CodexSupervisor::new());
        let service = WorkspaceHistoryService::new(
            WorkspaceHistoryStore::open(&data).expect("store"),
            workspace.clone(),
        );
        let candidate = candidate(&workspace, &root).await;
        fs::remove_dir_all(&root).expect("remove selected repository");

        let error = service
            .register_validated_candidate(candidate, "workspace_pick_register")
            .await
            .expect_err("activation must fail");

        assert_eq!(error.code, "CODEX-WORKSPACE-MISSING");
        assert!(service.list().expect("state").workspaces.is_empty());
    }

    #[tokio::test]
    async fn startup_restore_marks_missing_repository_without_dropping_history() {
        let data = temp_directory("history-service-restore");
        let root = git_repository();
        let workspace = WorkspaceService::production(CodexSupervisor::new());
        let store = WorkspaceHistoryStore::open(&data).expect("store");
        let candidate = candidate(&workspace, &root).await;
        let workspace_id = store
            .register_candidate(&candidate)
            .expect("register")
            .workspace
            .workspace_id;
        fs::remove_dir_all(&root).expect("remove repository");
        let service = WorkspaceHistoryService::new(store, workspace);

        let report = service.restore_startup().await;
        let state = service.list().expect("state");

        assert_eq!(report.unavailable, 1);
        assert_eq!(state.workspaces.len(), 1);
        assert_eq!(state.workspaces[0].workspace_id, workspace_id);
        assert_eq!(state.workspaces[0].health, WorkspaceHealth::Missing);
    }

    #[tokio::test]
    async fn changed_repository_identity_remains_blocked_across_restore_attempts() {
        let data = temp_directory("history-service-changed");
        let root = git_repository();
        let workspace = WorkspaceService::production(CodexSupervisor::new());
        let store = WorkspaceHistoryStore::open(&data).expect("store");
        let mut original = candidate(&workspace, &root).await;
        original.git.project_identity = "known-original-identity".to_owned();
        store.register_candidate(&original).expect("register");
        let service = WorkspaceHistoryService::new(store, workspace);

        assert_eq!(service.restore_startup().await.changed, 1);
        assert_eq!(service.restore_startup().await.changed, 1);
        assert_eq!(
            service.list().expect("state").workspaces[0].health,
            WorkspaceHealth::Changed
        );
    }

    #[tokio::test]
    async fn context_capture_reads_only_allowlisted_native_git_sources() {
        let data = temp_directory("history-service-context");
        let root = git_repository();
        fs::write(root.join("fixture.txt"), "fixture context\n").expect("fixture file");
        let workspace = WorkspaceService::production(CodexSupervisor::new());
        let service = WorkspaceHistoryService::new(
            WorkspaceHistoryStore::open(&data).expect("store"),
            workspace.clone(),
        );
        let state = service
            .register_validated_candidate(
                candidate(&workspace, &root).await,
                "workspace_pick_register",
            )
            .await
            .expect("register and activate");
        let workspace_id = state.active_workspace_id.expect("active workspace");

        let snapshot = service
            .save_context(WorkspaceSaveContextRequest {
                workspace_id: workspace_id.clone(),
                source: ContextSource::Files,
            })
            .await
            .expect("capture repository files");
        assert_eq!(snapshot.label, "Repository files");
        assert!(snapshot.byte_count > 0);

        let error = service
            .save_context(WorkspaceSaveContextRequest {
                workspace_id,
                source: ContextSource::TerminalOutput,
            })
            .await
            .expect_err("terminal output has no trusted producer yet");
        assert_eq!(error.code, "WORKSPACE-CONTEXT-SOURCE-UNAVAILABLE");
    }
}
