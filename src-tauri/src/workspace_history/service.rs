use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{Mutex, Notify};
use tokio::task::JoinSet;

use crate::character::manifest::BUILTIN_HIYORI_PACK_ID;
use crate::character::CharacterService;
use crate::codex::process::{run_bounded_command, BoundedCommandError};
use crate::codex::types::CodexCommandError;
use crate::codex::workspace::{
    matches_saved_git_repository, matches_saved_repository_identity, same_git_common_directory,
    validate_git_repository, AppPrivateBinaryRecord, AppPrivateProjectIdentity,
    ValidatedWorkspaceCandidate, WorkspaceService,
};

use super::editable_context::{
    capture_project_reference_manifest, normalize_character_context, normalize_project_context,
    ProjectReferenceValidation,
};
use super::store::WorkspaceHistoryStore;
use super::types::{
    AppSaveCharacterContextRequest, AppendDomainEventRequest, AppendDomainEventResponse,
    CharacterGetContextRequest, ContextSnapshotView, ContextSource, HistoryMode, HistoryStatus,
    NormalizedDomainEvent, ProjectGetContextRequest, ProjectSaveContextRequest,
    ProjectSelectRequest, ProjectSetupGitStatus, ProjectSetupGithubOwnerStatus,
    ProjectSetupGithubRequest, ProjectSetupRequest, ProjectSetupView, TimelinePage,
    VersionedCharacterContext, VersionedProjectContext, WorkspaceArchiveRequest,
    WorkspaceCancelRequest, WorkspaceCommandError, WorkspaceCreateSessionRequest,
    WorkspaceDeleteChallengeView, WorkspaceDeleteRequest, WorkspaceDraftView, WorkspaceHealth,
    WorkspaceLoadEditableContextRequest, WorkspacePickOutcome, WorkspacePickResponse,
    WorkspaceRecheckRequest, WorkspaceSaveContextRequest, WorkspaceSaveDraftRequest,
    WorkspaceSaveTimelineAnchorRequest, WorkspaceSelectRequest, WorkspaceStateSnapshot,
    WorkspaceSummary, WorkspaceTimelineAnchorView, WorkspaceTimelineRequest,
    WorkspaceTurnContextSnapshot, WorkspaceUpdateLifecycleRequest,
    WORKSPACE_HISTORY_SCHEMA_VERSION,
};

const PICK_CANCELED_CODE: &str = "CODEX-WORKSPACE-PICK-CANCELED";
const CONTEXT_CAPTURE_TIMEOUT: Duration = Duration::from_secs(5);
const CONTEXT_STDOUT_LIMIT: usize = 1024 * 1024;
const CONTEXT_STDERR_LIMIT: usize = 4 * 1024;
const REPOSITORY_RECHECK_TIMEOUT: Duration = Duration::from_secs(1);
const WORKTREE_MUTATION_TIMEOUT: Duration = Duration::from_secs(30);
const WORKTREE_OUTPUT_LIMIT: usize = 4 * 1024;
const PROJECT_SETUP_GIT_TIMEOUT: Duration = Duration::from_secs(5);
const PROJECT_SETUP_GITHUB_TIMEOUT: Duration = Duration::from_secs(30);
const PROJECT_SETUP_OUTPUT_LIMIT: usize = 16 * 1024;
const PROJECT_SETUP_GITHUB_PROBE_CONCURRENCY: usize = 4;
const STARTUP_REPOSITORY_VALIDATION_CONCURRENCY: usize = 2;
const STARTUP_PENDING: u8 = 0;
const STARTUP_READY: u8 = 1;
const STARTUP_FAILED: u8 = 2;

struct StartupReadiness {
    state: AtomicU8,
    notify: Notify,
}

impl StartupReadiness {
    fn new(ready: bool) -> Self {
        Self {
            state: AtomicU8::new(if ready {
                STARTUP_READY
            } else {
                STARTUP_PENDING
            }),
            notify: Notify::new(),
        }
    }

    fn finish(&self, state: u8) {
        self.state.store(state, Ordering::Release);
        self.notify.notify_waiters();
    }
}

struct StartupRestoreGuard {
    readiness: Arc<StartupReadiness>,
    finished: bool,
}

#[derive(Default)]
struct HistoryShutdownCompletion {
    outcome: Mutex<Option<Result<usize, WorkspaceCommandError>>>,
    notify: Notify,
}

impl HistoryShutdownCompletion {
    async fn finish(&self, outcome: Result<usize, WorkspaceCommandError>) {
        *self.outcome.lock().await = Some(outcome);
        self.notify.notify_waiters();
    }

    async fn outcome(&self) -> Option<Result<usize, WorkspaceCommandError>> {
        self.outcome.lock().await.clone()
    }

    async fn wait(&self) -> Result<usize, WorkspaceCommandError> {
        loop {
            let notified = self.notify.notified();
            if let Some(outcome) = self.outcome().await {
                return outcome;
            }
            notified.await;
        }
    }
}

struct HistoryShutdownExecution {
    completion: Arc<HistoryShutdownCompletion>,
}

#[derive(Default)]
struct HistoryShutdownState {
    current: Option<HistoryShutdownExecution>,
}

#[derive(Clone, Debug)]
struct PendingProjectSetup {
    root: PathBuf,
    root_device: u64,
    root_inode: u64,
    folder_name: String,
    suggested_repository_name: String,
    git_initialized: bool,
}

#[derive(Clone, Debug)]
struct GithubOwnerProbe {
    status: ProjectSetupGithubOwnerStatus,
    owners: Vec<String>,
}

impl StartupRestoreGuard {
    fn complete(mut self) {
        self.readiness.finish(STARTUP_READY);
        self.finished = true;
    }
}

impl Drop for StartupRestoreGuard {
    fn drop(&mut self) {
        if !self.finished {
            self.readiness.finish(STARTUP_FAILED);
        }
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct StartupRestoreReport {
    pub ready: usize,
    pub changed: usize,
    pub unavailable: usize,
    pub skipped_read_only: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RepositoryReadinessState {
    Ready,
    NotSelected,
    Missing,
    Moved,
    Changed,
    Unreadable,
    ReadOnly,
    StaleBranch,
    Unavailable,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct RepositoryReadinessProbe {
    pub state: RepositoryReadinessState,
    pub identity_matches: bool,
    pub head_matches: bool,
    pub branch_matches: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct HistoryReadinessProbe {
    pub available: bool,
    pub mode: HistoryMode,
    pub integrity_ok: bool,
    pub writable: bool,
    pub writer_ready: bool,
    pub migration_current: bool,
    pub backup_valid: bool,
}

#[derive(Clone)]
pub struct WorkspaceHistoryService {
    store: WorkspaceHistoryStore,
    workspace: WorkspaceService,
    operation_lock: Arc<Mutex<()>>,
    accepting_writers: Arc<AtomicBool>,
    shutdown_state: Arc<Mutex<HistoryShutdownState>>,
    project_operations: Arc<Mutex<()>>,
    pending_project_setups: Arc<Mutex<HashMap<String, PendingProjectSetup>>>,
    character: Option<CharacterService>,
    startup: Arc<StartupReadiness>,
}

impl WorkspaceHistoryService {
    pub fn new(store: WorkspaceHistoryStore, workspace: WorkspaceService) -> Self {
        Self::with_startup_state(store, workspace, true)
    }

    pub fn new_pending_restore(store: WorkspaceHistoryStore, workspace: WorkspaceService) -> Self {
        Self::with_startup_state(store, workspace, false)
    }

    pub(crate) fn new_pending_restore_with_character(
        store: WorkspaceHistoryStore,
        workspace: WorkspaceService,
        character: CharacterService,
        project_operations: Arc<Mutex<()>>,
    ) -> Self {
        Self::with_character_state(store, workspace, false, Some(character), project_operations)
    }

    #[cfg(test)]
    fn new_with_character(
        store: WorkspaceHistoryStore,
        workspace: WorkspaceService,
        character: CharacterService,
        project_operations: Arc<Mutex<()>>,
    ) -> Self {
        Self::with_character_state(store, workspace, true, Some(character), project_operations)
    }

    fn with_startup_state(
        store: WorkspaceHistoryStore,
        workspace: WorkspaceService,
        ready: bool,
    ) -> Self {
        Self::with_character_state(store, workspace, ready, None, Arc::new(Mutex::new(())))
    }

    fn with_character_state(
        store: WorkspaceHistoryStore,
        workspace: WorkspaceService,
        ready: bool,
        character: Option<CharacterService>,
        project_operations: Arc<Mutex<()>>,
    ) -> Self {
        Self {
            store,
            workspace,
            operation_lock: Arc::new(Mutex::new(())),
            accepting_writers: Arc::new(AtomicBool::new(true)),
            shutdown_state: Arc::new(Mutex::new(HistoryShutdownState::default())),
            project_operations,
            pending_project_setups: Arc::new(Mutex::new(HashMap::new())),
            character,
            startup: Arc::new(StartupReadiness::new(ready)),
        }
    }

    pub fn list(&self) -> Result<WorkspaceStateSnapshot, WorkspaceCommandError> {
        self.store
            .snapshot(None)
            .map_err(|error| history_error("workspace_list", error))
    }

    pub fn history_mode(&self) -> HistoryMode {
        self.store.status().mode
    }

    pub fn history_status(&self) -> HistoryStatus {
        self.store.status()
    }

    pub(crate) fn save_private_binary_record(
        &self,
        record: Option<&AppPrivateBinaryRecord>,
    ) -> Result<(), WorkspaceCommandError> {
        self.store
            .save_private_binary_record(record)
            .map_err(|error| history_error("codex_binary_save", error))
    }

    pub(crate) async fn repository_readiness(&self) -> RepositoryReadinessProbe {
        let snapshot = match self.store.snapshot(None) {
            Ok(snapshot) => snapshot,
            Err(_) => return repository_probe(RepositoryReadinessState::Unavailable),
        };
        let Some(active_workspace_id) = snapshot.active_workspace_id.as_deref() else {
            return repository_probe(RepositoryReadinessState::NotSelected);
        };
        let Some(public) = snapshot
            .workspaces
            .iter()
            .find(|workspace| workspace.workspace_id == active_workspace_id)
        else {
            return repository_probe(RepositoryReadinessState::Unavailable);
        };
        let private_record = match self.store.private_workspace_record(active_workspace_id) {
            Ok(record) => record,
            Err(_) => return repository_probe(RepositoryReadinessState::Unavailable),
        };
        let saved_identity = match self.store.private_project_identity(active_workspace_id) {
            Ok(identity) => identity,
            Err(_) => return repository_probe(RepositoryReadinessState::Unavailable),
        };
        let candidate = match tokio::time::timeout(
            REPOSITORY_RECHECK_TIMEOUT,
            self.workspace.validate_private_candidate(&private_record),
        )
        .await
        {
            Ok(Ok(candidate)) => candidate,
            Ok(Err(error)) => {
                let state = match health_for_preflight_error(&error) {
                    WorkspaceHealth::Missing => RepositoryReadinessState::Missing,
                    WorkspaceHealth::ReadOnly => RepositoryReadinessState::ReadOnly,
                    WorkspaceHealth::Changed => RepositoryReadinessState::Changed,
                    WorkspaceHealth::Unreadable
                    | WorkspaceHealth::Ready
                    | WorkspaceHealth::StaleBranch => RepositoryReadinessState::Unreadable,
                };
                return repository_probe(state);
            }
            Err(_) => return repository_probe(RepositoryReadinessState::Unavailable),
        };

        let identity_matches = matches_saved_git_repository(&candidate.git, &saved_identity);
        let head_matches = public.head == candidate.git.head;
        let branch_matches =
            public.branch == candidate.git.branch && public.detached == candidate.git.detached;
        let state = if !identity_matches {
            RepositoryReadinessState::Changed
        } else if candidate.git.canonical_root != private_record.canonical_root {
            RepositoryReadinessState::Moved
        } else if !head_matches || !branch_matches {
            RepositoryReadinessState::StaleBranch
        } else {
            RepositoryReadinessState::Ready
        };
        RepositoryReadinessProbe {
            state,
            identity_matches,
            head_matches,
            branch_matches,
        }
    }

    pub(crate) async fn history_readiness(&self) -> HistoryReadinessProbe {
        let accepting_writers = self.accepting_writers.load(Ordering::Acquire);
        let store = self.store.clone();
        match tokio::time::timeout(
            Duration::from_secs(2),
            tokio::task::spawn_blocking(move || store.readiness_probe()),
        )
        .await
        {
            Ok(Ok(probe)) => HistoryReadinessProbe {
                available: true,
                mode: probe.mode,
                integrity_ok: probe.integrity_ok,
                writable: probe.writable,
                writer_ready: accepting_writers && probe.writer_ready,
                migration_current: probe.migration_current,
                backup_valid: probe.backup_valid,
            },
            _ => HistoryReadinessProbe {
                available: false,
                mode: self.store.status().mode,
                integrity_ok: false,
                writable: false,
                writer_ready: false,
                migration_current: false,
                backup_valid: false,
            },
        }
    }

    pub async fn list_after_startup(
        &self,
    ) -> Result<WorkspaceStateSnapshot, WorkspaceCommandError> {
        self.wait_for_startup_restore().await;
        self.ensure_startup_ready("workspace_list")?;
        self.list()
    }

    pub(crate) async fn wait_for_startup_restore(&self) {
        loop {
            let notified = self.startup.notify.notified();
            if self.startup.state.load(Ordering::Acquire) != STARTUP_PENDING {
                break;
            }
            notified.await;
        }
    }

    pub async fn restore_startup(&self) -> StartupRestoreReport {
        let guard = StartupRestoreGuard {
            readiness: self.startup.clone(),
            finished: false,
        };
        let mut report = StartupRestoreReport::default();
        if !self.accepting_writers.load(Ordering::Acquire) {
            report.unavailable += 1;
            guard.complete();
            return report;
        }
        let _operation = self.operation_lock.lock().await;
        if self.store.status().mode != HistoryMode::Ready {
            report.skipped_read_only = true;
            guard.complete();
            return report;
        }
        if self.store.recover_unfinished_turns().is_err() {
            report.unavailable += 1;
            guard.complete();
            return report;
        }
        let records = match self.store.private_workspace_records() {
            Ok(records) => records,
            Err(_) => {
                report.unavailable += 1;
                guard.complete();
                return report;
            }
        };

        let record_count = records.len();
        let mut records = records.into_iter().enumerate();
        let mut validations = JoinSet::new();
        for (index, record) in records
            .by_ref()
            .take(STARTUP_REPOSITORY_VALIDATION_CONCURRENCY)
        {
            let workspace = self.workspace.clone();
            validations.spawn(async move {
                let result = workspace.validate_private_candidate(&record).await;
                (index, record, result)
            });
        }
        let mut results = (0..record_count).map(|_| None).collect::<Vec<_>>();
        while let Some(validation) = validations.join_next().await {
            match validation {
                Ok((index, record, validation)) => {
                    results[index] = Some((record, validation));
                }
                Err(_) => report.unavailable += 1,
            }
            if let Some((index, record)) = records.next() {
                let workspace = self.workspace.clone();
                validations.spawn(async move {
                    let result = workspace.validate_private_candidate(&record).await;
                    (index, record, result)
                });
            }
        }

        for (record, validation) in results.into_iter().flatten() {
            match validation {
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
        guard.complete();
        report
    }

    async fn shutdown_completion(&self) -> Arc<HistoryShutdownCompletion> {
        self.accepting_writers.store(false, Ordering::Release);
        self.store.begin_shutdown();
        let mut state = self.shutdown_state.lock().await;
        if let Some(current) = state.current.as_ref() {
            match current.completion.outcome().await {
                None | Some(Ok(_)) => return current.completion.clone(),
                Some(Err(_)) => {}
            }
        }
        let completion = Arc::new(HistoryShutdownCompletion::default());
        let task_completion = completion.clone();
        let operation_lock = self.operation_lock.clone();
        let store = self.store.clone();
        tauri::async_runtime::spawn(async move {
            let _operation = operation_lock.lock().await;
            let outcome = tokio::task::spawn_blocking(move || store.force_shutdown_now())
                .await
                .map_err(|_| {
                    WorkspaceCommandError::new("HIST-SHUTDOWN-TASK", "history.shutdown", true)
                })
                .and_then(|result| {
                    result.map_err(|error| history_error("history.shutdown", error))
                });
            task_completion.finish(outcome).await;
        });
        state.current = Some(HistoryShutdownExecution {
            completion: completion.clone(),
        });
        completion
    }

    pub async fn shutdown(&self) -> Result<(), WorkspaceCommandError> {
        self.shutdown_completion().await.wait().await.map(|_| ())
    }

    pub async fn force_shutdown_now(&self) -> Result<usize, WorkspaceCommandError> {
        self.shutdown_completion().await.wait().await
    }

    pub async fn pick_register(&self) -> Result<WorkspacePickResponse, WorkspaceCommandError> {
        self.ensure_startup_ready("workspace_pick_register")?;
        let _operation = self.operation_lock.lock().await;
        let selected = match self.workspace.pick_folder().await {
            Ok(selected) => selected,
            Err(error) if error.code == PICK_CANCELED_CODE => {
                return Ok(WorkspacePickResponse {
                    schema_version: WORKSPACE_HISTORY_SCHEMA_VERSION,
                    outcome: WorkspacePickOutcome::Canceled,
                    state: self
                        .store
                        .snapshot(None)
                        .map_err(|error| history_error("workspace_pick_register", error))?,
                    setup: None,
                });
            }
            Err(error) => return Err(codex_error("workspace_pick_register", error)),
        };
        let pending = inspect_project_setup_root(selected)
            .await
            .map_err(|error| setup_error("workspace_pick_register", error))?;
        let marker_present = match tokio::fs::symlink_metadata(pending.root.join(".git")).await {
            Ok(_) => true,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
            Err(_) => {
                return Err(WorkspaceCommandError::new(
                    "PROJECT-SETUP-GIT-METADATA",
                    "workspace_pick_register",
                    true,
                ));
            }
        };
        let mut owner_probe = None;
        if marker_present {
            let candidate = self
                .workspace
                .validate_workspace_root(
                    pending.root.clone(),
                    format!("workspace-{}", uuid::Uuid::new_v4()),
                    pending.folder_name.clone(),
                )
                .await
                .map_err(|error| codex_error("workspace_pick_register", error))?;
            if candidate.git.github_repository.is_some()
                || git_origin_configured(&pending.root, "workspace_pick_register").await?
            {
                let state = self
                    .register_validated_candidate(candidate, "workspace_pick_register")
                    .await?;
                return Ok(project_pick_response(
                    WorkspacePickOutcome::Selected,
                    state,
                    None,
                ));
            }

            let probe = probe_github_owners().await;
            if let Some(full_name) =
                probe_existing_github_repository(&probe, &pending.suggested_repository_name).await
            {
                revalidate_project_setup_root(&pending, "workspace_pick_register").await?;
                if git_origin_configured(&pending.root, "workspace_pick_register").await? {
                    let candidate = self
                        .workspace
                        .validate_workspace_root(
                            pending.root.clone(),
                            format!("workspace-{}", uuid::Uuid::new_v4()),
                            pending.folder_name.clone(),
                        )
                        .await
                        .map_err(|error| codex_error("workspace_pick_register", error))?;
                    let state = self
                        .register_validated_candidate(candidate, "workspace_pick_register")
                        .await?;
                    return Ok(project_pick_response(
                        WorkspacePickOutcome::Selected,
                        state,
                        None,
                    ));
                }
                connect_existing_github_origin(
                    &pending.root,
                    &full_name,
                    "workspace_pick_register",
                )
                .await?;
                let candidate = self
                    .workspace
                    .validate_workspace_root(
                        pending.root.clone(),
                        format!("workspace-{}", uuid::Uuid::new_v4()),
                        pending.folder_name.clone(),
                    )
                    .await
                    .map_err(|error| codex_error("workspace_pick_register", error))?;
                if !candidate
                    .git
                    .github_repository
                    .as_deref()
                    .is_some_and(|value| value.eq_ignore_ascii_case(&full_name))
                {
                    return Err(WorkspaceCommandError::new(
                        "PROJECT-SETUP-ORIGIN-VERIFY",
                        "workspace_pick_register",
                        true,
                    ));
                }
                let state = self
                    .register_validated_candidate(candidate, "workspace_pick_register")
                    .await?;
                return Ok(project_pick_response(
                    WorkspacePickOutcome::Selected,
                    state,
                    None,
                ));
            }
            owner_probe = Some(probe);
        }

        let setup_id = format!("project-setup-{}", uuid::Uuid::new_v4());
        let pending = PendingProjectSetup {
            git_initialized: marker_present,
            ..pending
        };
        let setup = match owner_probe {
            Some(probe) => project_setup_view(&setup_id, &pending, probe),
            None => self.project_setup_view(&setup_id, &pending).await,
        };
        self.pending_project_setups
            .lock()
            .await
            .insert(setup_id, pending);
        let state = self
            .store
            .snapshot(None)
            .map_err(|error| history_error("workspace_pick_register", error))?;
        Ok(project_pick_response(
            WorkspacePickOutcome::SetupRequired,
            state,
            Some(setup),
        ))
    }

    pub async fn initialize_project_git(
        &self,
        request: ProjectSetupRequest,
    ) -> Result<WorkspacePickResponse, WorkspaceCommandError> {
        const OPERATION: &str = "workspace_project_setup_git_init";
        self.ensure_startup_ready(OPERATION)?;
        let _operation = self.operation_lock.lock().await;
        let mut pending = self
            .pending_project_setup(&request.setup_id, OPERATION)
            .await?;
        revalidate_project_setup_root(&pending, OPERATION).await?;
        let marker_present = match tokio::fs::symlink_metadata(pending.root.join(".git")).await {
            Ok(_) => true,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
            Err(_) => {
                return Err(WorkspaceCommandError::new(
                    "PROJECT-SETUP-GIT-METADATA",
                    OPERATION,
                    true,
                ));
            }
        };
        if !marker_present {
            run_project_setup_git(&pending.root, &["init"], OPERATION).await?;
        }
        let candidate = self
            .workspace
            .validate_workspace_root(
                pending.root.clone(),
                format!("workspace-{}", uuid::Uuid::new_v4()),
                pending.folder_name.clone(),
            )
            .await
            .map_err(|error| codex_error(OPERATION, error))?;
        pending.git_initialized = true;

        if candidate.git.github_repository.is_some()
            || git_origin_configured(&pending.root, OPERATION).await?
        {
            let state = self
                .register_validated_candidate(candidate, OPERATION)
                .await?;
            self.pending_project_setups
                .lock()
                .await
                .remove(&request.setup_id);
            return Ok(project_pick_response(
                WorkspacePickOutcome::Selected,
                state,
                None,
            ));
        }

        let setup = self.project_setup_view(&request.setup_id, &pending).await;
        self.pending_project_setups
            .lock()
            .await
            .insert(request.setup_id, pending);
        let state = self
            .store
            .snapshot(None)
            .map_err(|error| history_error(OPERATION, error))?;
        Ok(project_pick_response(
            WorkspacePickOutcome::SetupRequired,
            state,
            Some(setup),
        ))
    }

    pub async fn setup_project_github(
        &self,
        request: ProjectSetupGithubRequest,
    ) -> Result<WorkspacePickResponse, WorkspaceCommandError> {
        const OPERATION: &str = "workspace_project_setup_github";
        self.ensure_startup_ready(OPERATION)?;
        let _operation = self.operation_lock.lock().await;
        let pending = self
            .pending_project_setup(&request.setup_id, OPERATION)
            .await?;
        revalidate_project_setup_root(&pending, OPERATION).await?;
        if !pending.git_initialized {
            return Err(WorkspaceCommandError::new(
                "PROJECT-SETUP-GIT-REQUIRED",
                OPERATION,
                true,
            ));
        }
        let requested_repository = validate_github_repository_name(&request.repository)
            .ok_or_else(|| {
                WorkspaceCommandError::new("PROJECT-SETUP-REPOSITORY-NAME", OPERATION, true)
            })?;
        let owner_probe = probe_github_owners().await;
        if owner_probe.status != ProjectSetupGithubOwnerStatus::Ready {
            let setup = project_setup_view(&request.setup_id, &pending, owner_probe);
            let state = self
                .store
                .snapshot(None)
                .map_err(|error| history_error(OPERATION, error))?;
            return Ok(project_pick_response(
                WorkspacePickOutcome::SetupRequired,
                state,
                Some(setup),
            ));
        }
        if !owner_probe
            .owners
            .iter()
            .any(|owner| owner == &request.owner)
        {
            return Err(WorkspaceCommandError::new(
                "PROJECT-SETUP-GITHUB-OWNER",
                OPERATION,
                true,
            ));
        }

        let full_name = format!("{}/{}", request.owner, requested_repository);
        let before = self
            .workspace
            .validate_workspace_root(
                pending.root.clone(),
                format!("workspace-{}", uuid::Uuid::new_v4()),
                pending.folder_name.clone(),
            )
            .await
            .map_err(|error| codex_error(OPERATION, error))?;
        if git_origin_configured(&pending.root, OPERATION).await? {
            if !before
                .git
                .github_repository
                .as_deref()
                .is_some_and(|value| value.eq_ignore_ascii_case(&full_name))
            {
                return Err(WorkspaceCommandError::new(
                    "PROJECT-SETUP-ORIGIN-CONFLICT",
                    OPERATION,
                    true,
                ));
            }
        } else {
            setup_github_origin(&pending.root, &full_name, OPERATION).await?;
        }

        let candidate = self
            .workspace
            .validate_workspace_root(
                pending.root.clone(),
                format!("workspace-{}", uuid::Uuid::new_v4()),
                pending.folder_name.clone(),
            )
            .await
            .map_err(|error| codex_error(OPERATION, error))?;
        if !candidate
            .git
            .github_repository
            .as_deref()
            .is_some_and(|value| value.eq_ignore_ascii_case(&full_name))
        {
            return Err(WorkspaceCommandError::new(
                "PROJECT-SETUP-ORIGIN-VERIFY",
                OPERATION,
                true,
            ));
        }
        let state = self
            .register_validated_candidate(candidate, OPERATION)
            .await?;
        self.pending_project_setups
            .lock()
            .await
            .remove(&request.setup_id);
        Ok(project_pick_response(
            WorkspacePickOutcome::Selected,
            state,
            None,
        ))
    }

    pub async fn cancel_project_setup(
        &self,
        request: ProjectSetupRequest,
    ) -> Result<WorkspacePickResponse, WorkspaceCommandError> {
        const OPERATION: &str = "workspace_project_setup_cancel";
        self.ensure_startup_ready(OPERATION)?;
        let _operation = self.operation_lock.lock().await;
        self.pending_project_setups
            .lock()
            .await
            .remove(&request.setup_id);
        let state = self
            .store
            .snapshot(None)
            .map_err(|error| history_error(OPERATION, error))?;
        Ok(project_pick_response(
            WorkspacePickOutcome::Canceled,
            state,
            None,
        ))
    }

    async fn pending_project_setup(
        &self,
        setup_id: &str,
        operation: &'static str,
    ) -> Result<PendingProjectSetup, WorkspaceCommandError> {
        if !is_setup_id(setup_id) {
            return Err(WorkspaceCommandError::new(
                "PROJECT-SETUP-ID-INVALID",
                operation,
                false,
            ));
        }
        self.pending_project_setups
            .lock()
            .await
            .get(setup_id)
            .cloned()
            .ok_or_else(|| WorkspaceCommandError::new("PROJECT-SETUP-NOT-FOUND", operation, true))
    }

    async fn project_setup_view(
        &self,
        setup_id: &str,
        pending: &PendingProjectSetup,
    ) -> ProjectSetupView {
        let owner_probe = if pending.git_initialized {
            probe_github_owners().await
        } else {
            GithubOwnerProbe {
                status: ProjectSetupGithubOwnerStatus::NotChecked,
                owners: Vec::new(),
            }
        };
        project_setup_view(setup_id, pending, owner_probe)
    }

    pub async fn create_session(
        &self,
        request: WorkspaceCreateSessionRequest,
    ) -> Result<WorkspaceStateSnapshot, WorkspaceCommandError> {
        self.ensure_startup_ready("workspace_create_session")?;
        let _operation = self.operation_lock.lock().await;
        if let Some(existing) = self
            .store
            .session_workspace_for_request(&request.client_request_id)
            .map_err(|error| history_error("workspace_create_session", error))?
        {
            return self
                .store
                .select_workspace(&existing.workspace.workspace_id)
                .map_err(|error| history_error("workspace_create_session", error));
        }
        let project = self
            .store
            .private_project_identity_by_project_id(&request.project_id)
            .map_err(|error| history_error("workspace_create_session", error))?;
        let live_project = validate_git_repository(&project.canonical_root)
            .await
            .map_err(|error| codex_error("workspace_create_session", error))?;
        if !matches_saved_repository_identity(&live_project, &project) {
            return Err(WorkspaceCommandError::new(
                "WORKSPACE-PROJECT-IDENTITY-CHANGED",
                "workspace_create_session",
                false,
            ));
        }
        self.store
            .confirm_project_common_identity(&request.project_id, &live_project)
            .map_err(|error| history_error("workspace_create_session", error))?;
        let workspace_id = format!("workspace-{}", uuid::Uuid::new_v4());
        let branch = format!("coding-wife/{}", uuid::Uuid::new_v4());
        let worktree_root = self
            .store
            .managed_worktree_path(&request.project_id, &workspace_id)
            .map_err(|error| history_error("workspace_create_session", error))?;
        create_managed_worktree(&project.canonical_root, &worktree_root, &branch).await?;
        let candidate = match self
            .workspace
            .validate_workspace_root(
                worktree_root.clone(),
                workspace_id.clone(),
                request.name.clone(),
            )
            .await
        {
            Ok(candidate) => candidate,
            Err(error) => {
                rollback_managed_worktree(&project.canonical_root, &worktree_root, &branch).await;
                return Err(codex_error("workspace_create_session", error));
            }
        };
        if !same_git_common_directory(&candidate.git, &live_project) {
            rollback_managed_worktree(&project.canonical_root, &worktree_root, &branch).await;
            return Err(WorkspaceCommandError::new(
                "WORKSPACE-PROJECT-IDENTITY-CHANGED",
                "workspace_create_session",
                false,
            ));
        }
        let persisted = self
            .store
            .create_managed_session_workspace(
                &request.project_id,
                &workspace_id,
                &request.name,
                &request.client_request_id,
                &candidate,
            )
            .map_err(|error| history_error("workspace_create_session", error));
        let persisted = match persisted {
            Ok(persisted) => persisted,
            Err(error) => {
                rollback_managed_worktree(&project.canonical_root, &worktree_root, &branch).await;
                return Err(error);
            }
        };
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
                    rollback_managed_worktree(&project.canonical_root, &worktree_root, &branch)
                        .await;
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
                    rollback_managed_worktree(&project.canonical_root, &worktree_root, &branch)
                        .await;
                }
                return Err(history_error("workspace_create_session", error));
            }
        };
        if health != WorkspaceHealth::Ready {
            if persisted.created {
                let _ = self
                    .store
                    .rollback_registration(&persisted.workspace.workspace_id);
                rollback_managed_worktree(&project.canonical_root, &worktree_root, &branch).await;
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
                rollback_managed_worktree(&project.canonical_root, &worktree_root, &branch).await;
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
                    rollback_managed_worktree(&project.canonical_root, &worktree_root, &branch)
                        .await;
                }
                Err(history_error("workspace_create_session", error))
            }
        }
    }

    pub async fn select(
        &self,
        request: WorkspaceSelectRequest,
    ) -> Result<WorkspaceStateSnapshot, WorkspaceCommandError> {
        self.ensure_startup_ready("workspace_select")?;
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
        let candidate = match self
            .workspace
            .validate_private_candidate(&private_record)
            .await
        {
            Ok(candidate) => candidate,
            Err(error) => {
                let health = health_for_preflight_error(&error);
                self.store
                    .update_preflight(&request.workspace_id, Err(health))
                    .map_err(|error| history_error("workspace_select", error))?;
                return self
                    .store
                    .select_workspace(&request.workspace_id)
                    .map_err(|error| history_error("workspace_select", error));
            }
        };
        let health = self
            .store
            .update_preflight(&request.workspace_id, Ok(&candidate.git))
            .map_err(|error| history_error("workspace_select", error))?;
        if health != WorkspaceHealth::Ready {
            return self
                .store
                .select_workspace(&request.workspace_id)
                .map_err(|error| history_error("workspace_select", error));
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

    pub async fn recheck(
        &self,
        request: WorkspaceRecheckRequest,
    ) -> Result<WorkspaceStateSnapshot, WorkspaceCommandError> {
        self.ensure_startup_ready("workspace_recheck")?;
        let _operation = self.operation_lock.lock().await;
        let private_record = self
            .store
            .private_workspace_record(&request.workspace_id)
            .map_err(|error| history_error("workspace_recheck", error))?;
        let validation = tokio::time::timeout(
            REPOSITORY_RECHECK_TIMEOUT,
            self.workspace.validate_private_candidate(&private_record),
        )
        .await;
        let candidate = match validation {
            Ok(Ok(candidate)) => candidate,
            Ok(Err(error)) => {
                let health = health_for_preflight_error(&error);
                self.store
                    .update_preflight(&request.workspace_id, Err(health))
                    .map_err(|error| history_error("workspace_recheck", error))?;
                return self
                    .store
                    .snapshot(Some(&request.workspace_id))
                    .map_err(|error| history_error("workspace_recheck", error));
            }
            Err(_) => {
                self.store
                    .update_preflight(&request.workspace_id, Err(WorkspaceHealth::Unreadable))
                    .map_err(|error| history_error("workspace_recheck", error))?;
                return self
                    .store
                    .snapshot(Some(&request.workspace_id))
                    .map_err(|error| history_error("workspace_recheck", error));
            }
        };
        let health = if request.accept_observed_head {
            self.store
                .accept_preflight(&request.workspace_id, &candidate.git)
        } else {
            self.store
                .update_preflight(&request.workspace_id, Ok(&candidate.git))
        }
        .map_err(|error| history_error("workspace_recheck", error))?;
        if health == WorkspaceHealth::Ready {
            match tokio::time::timeout(
                REPOSITORY_RECHECK_TIMEOUT,
                self.workspace.activate_candidate(candidate),
            )
            .await
            {
                Ok(Ok(_)) => {}
                Ok(Err(error)) => {
                    let health = health_for_preflight_error(&error);
                    self.store
                        .update_preflight(&request.workspace_id, Err(health))
                        .map_err(|error| history_error("workspace_recheck", error))?;
                }
                Err(_) => {
                    self.store
                        .update_preflight(&request.workspace_id, Err(WorkspaceHealth::Unreadable))
                        .map_err(|error| history_error("workspace_recheck", error))?;
                }
            }
        }
        self.store
            .snapshot(Some(&request.workspace_id))
            .map_err(|error| history_error("workspace_recheck", error))
    }

    pub async fn repair(
        &self,
        request: WorkspaceSelectRequest,
    ) -> Result<WorkspaceStateSnapshot, WorkspaceCommandError> {
        self.ensure_startup_ready("workspace_repair")?;
        let _operation = self.operation_lock.lock().await;
        let original_records = self
            .store
            .private_project_workspace_records(&request.workspace_id)
            .map_err(|error| history_error("workspace_repair", error))?;
        let saved_identity = self
            .store
            .private_project_identity(&request.workspace_id)
            .map_err(|error| history_error("workspace_repair", error))?;
        let selected = match self.workspace.pick_validated().await {
            Ok(candidate) => candidate,
            Err(error) if error.code == PICK_CANCELED_CODE => {
                return self
                    .store
                    .snapshot(Some(&request.workspace_id))
                    .map_err(|error| history_error("workspace_repair", error));
            }
            Err(error) => return Err(codex_error("workspace_repair", error)),
        };
        let selected = self
            .workspace
            .revalidate_candidate(&selected)
            .await
            .map_err(|error| codex_error("workspace_repair", error))?;
        ensure_repair_identity(&selected, &saved_identity)?;

        let mut deactivated = Vec::new();
        for record in &original_records {
            if let Err(error) = self
                .workspace
                .deactivate_workspace(&record.workspace_id)
                .await
            {
                self.restore_private_records(&deactivated).await;
                return Err(codex_error("workspace_repair", error));
            }
            deactivated.push(record.clone());
        }

        let selected = match self.workspace.revalidate_candidate(&selected).await {
            Ok(candidate) => candidate,
            Err(error) => {
                self.restore_private_records(&original_records).await;
                return Err(codex_error("workspace_repair", error));
            }
        };
        if let Err(error) = ensure_repair_identity(&selected, &saved_identity) {
            self.restore_private_records(&original_records).await;
            return Err(error);
        }

        let mut activated_ids = Vec::new();
        for record in &original_records {
            let mut candidate = selected.clone();
            candidate.registration.workspace_id = record.workspace_id.clone();
            candidate.registration.alias = selected.registration.alias.clone();
            if let Err(error) = self.workspace.activate_candidate(candidate).await {
                self.deactivate_records(&activated_ids).await;
                self.restore_private_records(&original_records).await;
                return Err(codex_error("workspace_repair", error));
            }
            activated_ids.push(record.workspace_id.clone());
        }

        let selected = match self.workspace.revalidate_candidate(&selected).await {
            Ok(candidate) => candidate,
            Err(error) => {
                self.deactivate_records(&activated_ids).await;
                self.restore_private_records(&original_records).await;
                return Err(codex_error("workspace_repair", error));
            }
        };
        if let Err(error) = ensure_repair_identity(&selected, &saved_identity) {
            self.deactivate_records(&activated_ids).await;
            self.restore_private_records(&original_records).await;
            return Err(error);
        }

        match self
            .store
            .repair_project(&request.workspace_id, &saved_identity, &selected)
        {
            Ok(state) => Ok(state),
            Err(error) => {
                self.deactivate_records(&activated_ids).await;
                self.restore_private_records(&original_records).await;
                Err(history_error("workspace_repair", error))
            }
        }
    }

    pub async fn unregister(
        &self,
        request: ProjectSelectRequest,
    ) -> Result<WorkspaceStateSnapshot, WorkspaceCommandError> {
        self.ensure_startup_ready("workspace_unregister")?;
        let _operation = self.operation_lock.lock().await;
        let _project_operation = if self.character.is_some() {
            Some(self.project_operations.lock().await)
        } else {
            None
        };
        let records = self
            .store
            .private_project_workspace_records_by_project(&request.project_id)
            .map_err(|error| history_error("workspace_unregister", error))?;
        let mut deactivated = Vec::new();
        for record in &records {
            if let Err(error) = self
                .workspace
                .deactivate_workspace(&record.workspace_id)
                .await
            {
                self.restore_private_records(&deactivated).await;
                return Err(codex_error("workspace_unregister", error));
            }
            deactivated.push(record.clone());
        }
        match self.store.unregister_project(&request.project_id) {
            Ok(state) => Ok(state),
            Err(error) => {
                self.restore_private_records(&records).await;
                Err(history_error("workspace_unregister", error))
            }
        }
    }

    pub async fn archive(
        &self,
        request: WorkspaceArchiveRequest,
    ) -> Result<WorkspaceStateSnapshot, WorkspaceCommandError> {
        self.ensure_startup_ready("workspace_archive")?;
        let _operation = self.operation_lock.lock().await;
        let record = self
            .store
            .workspace_archive_record(&request.workspace_id)
            .map_err(|error| history_error("workspace_archive", error))?;
        let was_trusted = self
            .workspace
            .trusted_root(&request.workspace_id)
            .await
            .is_some();
        let guard = if was_trusted {
            Some(
                self.workspace
                    .begin_cancellation(&request.workspace_id)
                    .await
                    .map_err(|error| codex_error("workspace_archive", error))?,
            )
        } else {
            None
        };
        if was_trusted {
            self.workspace
                .deactivate_workspace(&request.workspace_id)
                .await
                .map_err(|error| codex_error("workspace_archive", error))?;
        }
        if record.managed_worktree {
            let expected = self
                .store
                .managed_worktree_path(&record.project_id, &request.workspace_id)
                .map_err(|error| history_error("workspace_archive", error))?;
            if record.private_record.canonical_root != expected {
                if let Some(guard) = guard {
                    guard.release().await;
                }
                return Err(WorkspaceCommandError::new(
                    "WORKSPACE-WORKTREE-ROOT-INVALID",
                    "workspace_archive",
                    false,
                ));
            }
            remove_managed_worktree(
                &record.project_root,
                &record.private_record.canonical_root,
                "workspace_archive",
            )
            .await?;
        }
        let result = self
            .store
            .archive_workspace(&request.workspace_id)
            .map_err(|error| history_error("workspace_archive", error));
        if let Some(guard) = guard {
            guard.release().await;
        }
        result
    }

    pub async fn update_lifecycle(
        &self,
        request: WorkspaceUpdateLifecycleRequest,
    ) -> Result<WorkspaceSummary, WorkspaceCommandError> {
        self.ensure_startup_ready("workspace_update_lifecycle")?;
        if request.lifecycle == super::types::WorkspaceLifecycle::Canceled {
            return Err(WorkspaceCommandError::new(
                "WORKSPACE-CANCEL-COMMAND-REQUIRED",
                "workspace_update_lifecycle",
                false,
            ));
        }
        let _operation = self.operation_lock.lock().await;
        self.store
            .update_lifecycle(
                &request.workspace_id,
                request.lifecycle,
                &request.expected_updated_at,
            )
            .map_err(|error| history_error("workspace_update_lifecycle", error))
    }

    pub async fn cancel(
        &self,
        request: WorkspaceCancelRequest,
    ) -> Result<WorkspaceSummary, WorkspaceCommandError> {
        self.ensure_startup_ready("workspace_cancel")?;
        let _operation = self.operation_lock.lock().await;
        let guard = self
            .workspace
            .begin_cancellation(&request.workspace_id)
            .await
            .map_err(|error| codex_error("workspace_cancel", error))?;
        let result = self.store.update_lifecycle(
            &request.workspace_id,
            super::types::WorkspaceLifecycle::Canceled,
            &request.expected_updated_at,
        );
        guard.release().await;
        result.map_err(|error| history_error("workspace_cancel", error))
    }

    pub async fn save_draft(
        &self,
        request: WorkspaceSaveDraftRequest,
    ) -> Result<WorkspaceDraftView, WorkspaceCommandError> {
        self.ensure_startup_ready("workspace_save_draft")?;
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

    pub async fn save_timeline_anchor(
        &self,
        request: WorkspaceSaveTimelineAnchorRequest,
    ) -> Result<WorkspaceTimelineAnchorView, WorkspaceCommandError> {
        self.ensure_startup_ready("workspace_save_timeline_anchor")?;
        let _operation = self.operation_lock.lock().await;
        self.store
            .save_timeline_anchor(
                &request.workspace_id,
                &request.event_id,
                request.sequence,
                request.offset,
            )
            .map_err(|error| history_error("workspace_save_timeline_anchor", error))
    }

    pub async fn save_context(
        &self,
        request: WorkspaceSaveContextRequest,
    ) -> Result<ContextSnapshotView, WorkspaceCommandError> {
        self.ensure_startup_ready("workspace_save_context_snapshot")?;
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

    pub fn project_context(
        &self,
        request: ProjectGetContextRequest,
    ) -> Result<VersionedProjectContext, WorkspaceCommandError> {
        self.ensure_startup_ready("project_context_get")?;
        self.store
            .project_context(&request.project_id)
            .map_err(|error| history_error("project_context_get", error))
    }

    pub async fn save_project_context(
        &self,
        request: ProjectSaveContextRequest,
    ) -> Result<VersionedProjectContext, WorkspaceCommandError> {
        self.ensure_startup_ready("project_context_save")?;
        let _operation = self.operation_lock.lock().await;
        let identity = self
            .store
            .private_project_identity_by_project_id(&request.project_id)
            .map_err(|error| history_error("project_context_save", error))?;
        let live_project = validate_git_repository(&identity.canonical_root)
            .await
            .map_err(|error| codex_error("project_context_save", error))?;
        if !matches_saved_repository_identity(&live_project, &identity) {
            return Err(WorkspaceCommandError::new(
                "PROJECT-CONTEXT-PREFLIGHT",
                "project_context_save",
                true,
            ));
        }
        let validation = ProjectReferenceValidation::new(
            identity.canonical_root,
            identity.root_device,
            identity.root_inode,
        );
        let context = normalize_project_context(request.context, Some(validation.root()))
            .map_err(|error| history_error("project_context_save", error))?;
        let reference_manifest = capture_project_reference_manifest(&context, &validation)
            .map_err(|error| history_error("project_context_save", error))?;
        self.store
            .save_project_context(
                &request.project_id,
                request.expected_version,
                context,
                Some(reference_manifest),
            )
            .map_err(|error| history_error("project_context_save", error))
    }

    pub fn character_context(
        &self,
        request: CharacterGetContextRequest,
    ) -> Result<VersionedCharacterContext, WorkspaceCommandError> {
        self.ensure_startup_ready("app_character_context_get")?;
        self.store
            .character_context(&request.pack_id, &request.display_name)
            .map_err(|error| history_error("app_character_context_get", error))
    }

    pub async fn save_character_context(
        &self,
        request: AppSaveCharacterContextRequest,
    ) -> Result<VersionedCharacterContext, WorkspaceCommandError> {
        self.ensure_startup_ready("app_character_context_save")?;
        let _operation = self.operation_lock.lock().await;
        let context = normalize_character_context(request.context)
            .map_err(|error| history_error("app_character_context_save", error))?;
        self.store
            .save_character_context(&request.pack_id, request.expected_version, context)
            .map_err(|error| history_error("app_character_context_save", error))
    }

    pub async fn turn_context_snapshot(
        &self,
        request: WorkspaceLoadEditableContextRequest,
    ) -> Result<WorkspaceTurnContextSnapshot, WorkspaceCommandError> {
        self.ensure_startup_ready("workspace_get_turn_context_snapshot")?;
        let _operation = self.operation_lock.lock().await;
        let identity = self
            .workspace
            .trusted_identity(&request.workspace_id)
            .await
            .ok_or_else(|| {
                WorkspaceCommandError::new(
                    "WORKSPACE-CONTEXT-PREFLIGHT",
                    "workspace_get_turn_context_snapshot",
                    true,
                )
            })?;
        let validation = ProjectReferenceValidation::new(
            identity.canonical_root,
            identity.root_device,
            identity.root_inode,
        );
        let (character_pack_id, character_display_name) =
            if let Some(character) = self.character.as_ref() {
                let library = character.app_library().await.map_err(|_| {
                    WorkspaceCommandError::new(
                        "WORKSPACE-CHARACTER-CONTEXT-PREFLIGHT",
                        "workspace_get_turn_context_snapshot",
                        true,
                    )
                })?;
                let selected = library
                    .packs
                    .iter()
                    .find(|pack| pack.pack_id == library.selected_pack_id)
                    .ok_or_else(|| {
                        WorkspaceCommandError::new(
                            "WORKSPACE-CHARACTER-CONTEXT-PREFLIGHT",
                            "workspace_get_turn_context_snapshot",
                            true,
                        )
                    })?;
                (selected.pack_id.clone(), selected.display_name.clone())
            } else {
                (BUILTIN_HIYORI_PACK_ID.to_owned(), "桃瀬ひより".to_owned())
            };
        self.store
            .turn_context_snapshot(
                &request.workspace_id,
                &character_pack_id,
                &character_display_name,
                &validation,
            )
            .map_err(|error| history_error("workspace_get_turn_context_snapshot", error))
    }

    pub fn timeline(
        &self,
        request: WorkspaceTimelineRequest,
    ) -> Result<TimelinePage, WorkspaceCommandError> {
        self.ensure_startup_ready("workspace_list_timeline")?;
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
        self.ensure_startup_ready("workspace_issue_delete_challenge")?;
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
        self.ensure_startup_ready("workspace_delete")?;
        let _operation = self.operation_lock.lock().await;
        self.store
            .delete_workspace(&request.workspace_id, &request.token)
            .map_err(|error| history_error("workspace_delete", error))?;
        self.store
            .snapshot(Some(&request.workspace_id))
            .map_err(|error| history_error("workspace_delete", error))
    }

    pub async fn append_domain_event(
        &self,
        request: AppendDomainEventRequest,
    ) -> Result<AppendDomainEventResponse, WorkspaceCommandError> {
        self.ensure_startup_ready("history_append_domain_event")?;
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
        let candidate = self
            .workspace
            .revalidate_candidate(&candidate)
            .await
            .map_err(|error| codex_error(operation, error))?;
        let persisted = self
            .store
            .register_project_candidate(&candidate)
            .map_err(|error| history_error(operation, error))?;
        let _ = persisted.project;
        let _ = persisted.duplicate;
        self.store
            .snapshot(None)
            .map_err(|error| history_error(operation, error))
    }

    async fn deactivate_records(&self, workspace_ids: &[String]) {
        for workspace_id in workspace_ids {
            let _ = self.workspace.deactivate_workspace(workspace_id).await;
        }
    }

    async fn restore_private_records(
        &self,
        records: &[crate::codex::workspace::AppPrivateWorkspaceRecord],
    ) {
        for record in records {
            let _ = self
                .workspace
                .restore_private_workspace(record.clone())
                .await;
        }
    }

    fn ensure_startup_ready(&self, operation: &str) -> Result<(), WorkspaceCommandError> {
        if !self.accepting_writers.load(Ordering::Acquire) {
            return Err(WorkspaceCommandError::new(
                "HIST-SHUTTING-DOWN",
                operation,
                false,
            ));
        }
        match self.startup.state.load(Ordering::Acquire) {
            STARTUP_READY => Ok(()),
            STARTUP_PENDING => Err(WorkspaceCommandError::new(
                "WORKSPACE-STARTUP-PENDING",
                operation,
                true,
            )),
            _ => Err(WorkspaceCommandError::new(
                "WORKSPACE-STARTUP-FAILED",
                operation,
                true,
            )),
        }
    }
}

async fn capture_context(
    root: &Path,
    source: ContextSource,
) -> Result<(&'static str, String), WorkspaceCommandError> {
    let deadline = tokio::time::Instant::now() + CONTEXT_CAPTURE_TIMEOUT;
    match source {
        ContextSource::Files => Ok((
            "Repository files",
            run_git_capture(
                root,
                &["ls-files", "--cached", "--others", "--exclude-standard"],
                deadline,
            )
            .await?,
        )),
        ContextSource::GitDiff => {
            let staged = run_git_capture(
                root,
                &["diff", "--cached", "--no-ext-diff", "--no-textconv", "--"],
                deadline,
            )
            .await?;
            let working = run_git_capture(
                root,
                &["diff", "--no-ext-diff", "--no-textconv", "--"],
                deadline,
            )
            .await?;
            let content = format!("Staged changes:\n{staged}\nWorking tree changes:\n{working}");
            if content.len() > CONTEXT_STDOUT_LIMIT {
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

fn project_pick_response(
    outcome: WorkspacePickOutcome,
    state: WorkspaceStateSnapshot,
    setup: Option<ProjectSetupView>,
) -> WorkspacePickResponse {
    WorkspacePickResponse {
        schema_version: WORKSPACE_HISTORY_SCHEMA_VERSION,
        outcome,
        state,
        setup,
    }
}

fn project_setup_view(
    setup_id: &str,
    pending: &PendingProjectSetup,
    owner_probe: GithubOwnerProbe,
) -> ProjectSetupView {
    ProjectSetupView {
        schema_version: WORKSPACE_HISTORY_SCHEMA_VERSION,
        setup_id: setup_id.to_owned(),
        folder_name: pending.folder_name.clone(),
        git_status: if pending.git_initialized {
            ProjectSetupGitStatus::Ready
        } else {
            ProjectSetupGitStatus::NotInitialized
        },
        github_owner_status: owner_probe.status,
        github_owners: owner_probe.owners,
        suggested_repository_name: pending.suggested_repository_name.clone(),
    }
}

fn setup_error(operation: &'static str, error: WorkspaceCommandError) -> WorkspaceCommandError {
    WorkspaceCommandError::new(error.code, operation, error.recoverable)
}

fn is_setup_id(value: &str) -> bool {
    value.len() <= 128
        && value.starts_with("project-setup-")
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
}

fn setup_folder_name(root: &Path) -> String {
    let value = root
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("Repository");
    let value = value
        .chars()
        .filter(|character| !character.is_control())
        .take(80)
        .collect::<String>();
    if value.trim().is_empty() {
        "Repository".to_owned()
    } else {
        value
    }
}

fn suggested_repository_name(folder_name: &str) -> String {
    let mut value = String::new();
    let mut separator = false;
    for character in folder_name.chars() {
        if character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-') {
            value.push(character);
            separator = false;
        } else if !separator && !value.is_empty() {
            value.push('-');
            separator = true;
        }
        if value.len() >= 100 {
            break;
        }
    }
    let value = value.trim_matches('-').trim_end_matches(".git").to_owned();
    if validate_github_repository_name(&value).is_some() {
        value
    } else {
        "repository".to_owned()
    }
}

async fn inspect_project_setup_root(
    selected: PathBuf,
) -> Result<PendingProjectSetup, WorkspaceCommandError> {
    let root = tokio::fs::canonicalize(selected).await.map_err(|_| {
        WorkspaceCommandError::new("PROJECT-SETUP-ROOT-MISSING", "project_setup.inspect", true)
    })?;
    let metadata = tokio::fs::symlink_metadata(&root).await.map_err(|_| {
        WorkspaceCommandError::new("PROJECT-SETUP-ROOT-MISSING", "project_setup.inspect", true)
    })?;
    validate_project_setup_root_metadata(&metadata, "project_setup.inspect")?;
    let folder_name = setup_folder_name(&root);

    #[cfg(unix)]
    let (root_device, root_inode) = {
        use std::os::unix::fs::MetadataExt;
        (metadata.dev(), metadata.ino())
    };
    #[cfg(not(unix))]
    let (root_device, root_inode) = (0, metadata.len());

    Ok(PendingProjectSetup {
        root,
        root_device,
        root_inode,
        suggested_repository_name: suggested_repository_name(&folder_name),
        folder_name,
        git_initialized: false,
    })
}

fn validate_project_setup_root_metadata(
    metadata: &std::fs::Metadata,
    operation: &'static str,
) -> Result<(), WorkspaceCommandError> {
    if !metadata.is_dir() {
        return Err(WorkspaceCommandError::new(
            "PROJECT-SETUP-NOT-DIRECTORY",
            operation,
            false,
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let uid = unsafe { libc::geteuid() };
        let mode = metadata.permissions().mode();
        if metadata.uid() != uid || mode & 0o022 != 0 || mode & 0o200 == 0 {
            return Err(WorkspaceCommandError::new(
                "PROJECT-SETUP-ROOT-PERMISSION",
                operation,
                false,
            ));
        }
    }
    #[cfg(not(unix))]
    if metadata.permissions().readonly() {
        return Err(WorkspaceCommandError::new(
            "PROJECT-SETUP-ROOT-PERMISSION",
            operation,
            false,
        ));
    }
    Ok(())
}

async fn revalidate_project_setup_root(
    pending: &PendingProjectSetup,
    operation: &'static str,
) -> Result<(), WorkspaceCommandError> {
    let canonical = tokio::fs::canonicalize(&pending.root)
        .await
        .map_err(|_| WorkspaceCommandError::new("PROJECT-SETUP-ROOT-MISSING", operation, true))?;
    if canonical != pending.root {
        return Err(WorkspaceCommandError::new(
            "PROJECT-SETUP-ROOT-CHANGED",
            operation,
            false,
        ));
    }
    let metadata = tokio::fs::symlink_metadata(&canonical)
        .await
        .map_err(|_| WorkspaceCommandError::new("PROJECT-SETUP-ROOT-MISSING", operation, true))?;
    validate_project_setup_root_metadata(&metadata, operation)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.dev() != pending.root_device || metadata.ino() != pending.root_inode {
            return Err(WorkspaceCommandError::new(
                "PROJECT-SETUP-ROOT-CHANGED",
                operation,
                false,
            ));
        }
    }
    #[cfg(not(unix))]
    if metadata.len() != pending.root_inode {
        return Err(WorkspaceCommandError::new(
            "PROJECT-SETUP-ROOT-CHANGED",
            operation,
            false,
        ));
    }
    Ok(())
}

async fn run_project_setup_git(
    root: &Path,
    arguments: &[&str],
    operation: &'static str,
) -> Result<crate::codex::process::BoundedCommandOutput, WorkspaceCommandError> {
    let mut command = tokio::process::Command::new("/usr/bin/git");
    command
        .arg("-C")
        .arg(root)
        .args(arguments)
        .env_clear()
        .env("LC_ALL", "C")
        .env("GIT_CONFIG_NOSYSTEM", "1");
    let output = run_bounded_command(
        command,
        PROJECT_SETUP_GIT_TIMEOUT,
        PROJECT_SETUP_OUTPUT_LIMIT,
        PROJECT_SETUP_OUTPUT_LIMIT,
    )
    .await
    .map_err(|error| {
        WorkspaceCommandError::new(
            if error == BoundedCommandError::Timeout {
                "PROJECT-SETUP-GIT-TIMEOUT"
            } else {
                "PROJECT-SETUP-GIT-UNAVAILABLE"
            },
            operation,
            true,
        )
    })?;
    if !output.status.success() {
        return Err(WorkspaceCommandError::new(
            "PROJECT-SETUP-GIT-FAILED",
            operation,
            true,
        ));
    }
    Ok(output)
}

async fn git_origin_configured(
    root: &Path,
    operation: &'static str,
) -> Result<bool, WorkspaceCommandError> {
    let mut command = tokio::process::Command::new("/usr/bin/git");
    command
        .arg("-C")
        .arg(root)
        .args(["config", "--get", "remote.origin.url"])
        .env_clear()
        .env("LC_ALL", "C")
        .env("GIT_CONFIG_NOSYSTEM", "1");
    let output = run_bounded_command(
        command,
        PROJECT_SETUP_GIT_TIMEOUT,
        2_048,
        PROJECT_SETUP_OUTPUT_LIMIT,
    )
    .await
    .map_err(|error| {
        WorkspaceCommandError::new(
            if error == BoundedCommandError::Timeout {
                "PROJECT-SETUP-GIT-TIMEOUT"
            } else {
                "PROJECT-SETUP-GIT-UNAVAILABLE"
            },
            operation,
            true,
        )
    })?;
    if !output.status.success() {
        return Ok(false);
    }
    let value = String::from_utf8(output.stdout).map_err(|_| {
        WorkspaceCommandError::new("PROJECT-SETUP-ORIGIN-INVALID", operation, false)
    })?;
    let value = value.trim();
    Ok(!value.is_empty() && !value.chars().any(char::is_control))
}

fn validate_github_slug_component(value: &str, maximum: usize) -> bool {
    !value.is_empty()
        && value.len() <= maximum
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

fn validate_github_repository_name(value: &str) -> Option<String> {
    let value = value.trim();
    if matches!(value, "." | "..")
        || value.to_ascii_lowercase().ends_with(".git")
        || !validate_github_slug_component(value, 100)
    {
        return None;
    }
    Some(value.to_owned())
}

#[cfg(unix)]
fn trusted_executable_metadata(path: &Path) -> bool {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let Ok(metadata) = std::fs::symlink_metadata(path) else {
        return false;
    };
    let uid = unsafe { libc::geteuid() };
    let parent_chain_trusted = path.ancestors().skip(1).all(|directory| {
        std::fs::symlink_metadata(directory).is_ok_and(|parent| {
            parent.is_dir()
                && !parent.file_type().is_symlink()
                && matches!(parent.uid(), owner if owner == uid || owner == 0)
                && parent.permissions().mode() & 0o002 == 0
                && (parent.uid() == uid || parent.permissions().mode() & 0o020 == 0)
        })
    });
    metadata.is_file()
        && matches!(metadata.uid(), owner if owner == uid || owner == 0)
        && metadata.permissions().mode() & 0o022 == 0
        && metadata.permissions().mode() & 0o111 != 0
        && parent_chain_trusted
}

#[cfg(not(unix))]
fn trusted_executable_metadata(path: &Path) -> bool {
    std::fs::metadata(path).is_ok_and(|metadata| metadata.is_file())
}

fn trusted_gh_executable() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(path) = std::env::var_os("PATH") {
        candidates.extend(std::env::split_paths(&path).map(|directory| directory.join("gh")));
    }
    candidates.extend([
        PathBuf::from("/opt/homebrew/bin/gh"),
        PathBuf::from("/usr/local/bin/gh"),
    ]);
    let mut seen = HashSet::new();
    for candidate in candidates {
        let Ok(canonical) = std::fs::canonicalize(candidate) else {
            continue;
        };
        if seen.insert(canonical.clone()) && trusted_executable_metadata(&canonical) {
            return Some(canonical);
        }
    }
    None
}

fn configure_gh_command(executable: &Path) -> tokio::process::Command {
    let mut command = tokio::process::Command::new(executable);
    command
        .env_clear()
        .env("GH_PROMPT_DISABLED", "1")
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin");
    for name in [
        "HOME",
        "GH_CONFIG_DIR",
        "GH_TOKEN",
        "GITHUB_TOKEN",
        "XDG_CONFIG_HOME",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "NO_PROXY",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
        "LANG",
    ] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    command
}

async fn run_project_setup_gh(
    command: tokio::process::Command,
    operation: &'static str,
) -> Result<crate::codex::process::BoundedCommandOutput, WorkspaceCommandError> {
    run_bounded_command(
        command,
        PROJECT_SETUP_GITHUB_TIMEOUT,
        PROJECT_SETUP_OUTPUT_LIMIT,
        PROJECT_SETUP_OUTPUT_LIMIT,
    )
    .await
    .map_err(|error| {
        WorkspaceCommandError::new(
            if error == BoundedCommandError::Timeout {
                "PROJECT-SETUP-GITHUB-TIMEOUT"
            } else {
                "PROJECT-SETUP-GITHUB-UNAVAILABLE"
            },
            operation,
            true,
        )
    })
}

async fn probe_github_owners() -> GithubOwnerProbe {
    let Some(executable) = trusted_gh_executable() else {
        return GithubOwnerProbe {
            status: ProjectSetupGithubOwnerStatus::CliMissing,
            owners: Vec::new(),
        };
    };
    let mut auth = configure_gh_command(&executable);
    auth.args(["auth", "status", "--hostname", "github.com"]);
    let Ok(auth) = run_project_setup_gh(auth, "workspace_project_setup_github").await else {
        return GithubOwnerProbe {
            status: ProjectSetupGithubOwnerStatus::Unavailable,
            owners: Vec::new(),
        };
    };
    if !auth.status.success() {
        return GithubOwnerProbe {
            status: ProjectSetupGithubOwnerStatus::AuthRequired,
            owners: Vec::new(),
        };
    }

    let mut user = configure_gh_command(&executable);
    user.args(["api", "user", "--jq", ".login"]);
    let mut organizations = configure_gh_command(&executable);
    organizations.args(["api", "--paginate", "user/orgs", "--jq", ".[].login"]);
    let (user, organizations) = tokio::join!(
        run_project_setup_gh(user, "workspace_project_setup_github"),
        run_project_setup_gh(organizations, "workspace_project_setup_github")
    );
    let (Ok(user), Ok(organizations)) = (user, organizations) else {
        return GithubOwnerProbe {
            status: ProjectSetupGithubOwnerStatus::Unavailable,
            owners: Vec::new(),
        };
    };
    if !user.status.success() || !organizations.status.success() {
        return GithubOwnerProbe {
            status: ProjectSetupGithubOwnerStatus::Unavailable,
            owners: Vec::new(),
        };
    }
    let Ok(user) = String::from_utf8(user.stdout) else {
        return GithubOwnerProbe {
            status: ProjectSetupGithubOwnerStatus::Unavailable,
            owners: Vec::new(),
        };
    };
    let Ok(organizations) = String::from_utf8(organizations.stdout) else {
        return GithubOwnerProbe {
            status: ProjectSetupGithubOwnerStatus::Unavailable,
            owners: Vec::new(),
        };
    };
    let mut seen = HashSet::new();
    let owners = user
        .lines()
        .chain(organizations.lines())
        .map(str::trim)
        .filter(|owner| validate_github_slug_component(owner, 39))
        .filter(|owner| seen.insert((*owner).to_owned()))
        .take(101)
        .map(str::to_owned)
        .collect::<Vec<_>>();
    GithubOwnerProbe {
        status: if owners.is_empty() {
            ProjectSetupGithubOwnerStatus::Unavailable
        } else {
            ProjectSetupGithubOwnerStatus::Ready
        },
        owners,
    }
}

async fn probe_existing_github_repository(
    owner_probe: &GithubOwnerProbe,
    repository: &str,
) -> Option<String> {
    if owner_probe.status != ProjectSetupGithubOwnerStatus::Ready
        || validate_github_repository_name(repository).is_none()
    {
        return None;
    }
    let mut owners = owner_probe.owners.iter().cloned();
    let mut probes = JoinSet::new();
    for owner in owners.by_ref().take(PROJECT_SETUP_GITHUB_PROBE_CONCURRENCY) {
        let repository = repository.to_owned();
        probes.spawn(async move { probe_github_repository(owner, repository).await });
    }
    let mut matched = None;
    while let Some(result) = probes.join_next().await {
        if let Ok(Some(full_name)) = result {
            if matched.is_some() {
                probes.abort_all();
                return None;
            }
            matched = Some(full_name);
        }
        if let Some(owner) = owners.next() {
            let repository = repository.to_owned();
            probes.spawn(async move { probe_github_repository(owner, repository).await });
        }
    }
    matched
}

async fn probe_github_repository(owner: String, repository: String) -> Option<String> {
    let executable = trusted_gh_executable()?;
    let full_name = format!("{owner}/{repository}");
    let mut view = configure_gh_command(&executable);
    view.args(["repo", "view"]).arg(&full_name).args([
        "--json",
        "nameWithOwner",
        "--jq",
        ".nameWithOwner",
    ]);
    let output = run_project_setup_gh(view, "workspace_pick_register")
        .await
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let detected = String::from_utf8(output.stdout).ok()?;
    if detected.trim().eq_ignore_ascii_case(&full_name) {
        Some(full_name)
    } else {
        None
    }
}

async fn connect_existing_github_origin(
    root: &Path,
    full_name: &str,
    operation: &'static str,
) -> Result<(), WorkspaceCommandError> {
    let origin = format!("https://github.com/{full_name}.git");
    if let Err(error) =
        run_project_setup_git(root, &["remote", "add", "origin", &origin], operation).await
    {
        if !git_origin_configured(root, operation).await? {
            return Err(error);
        }
    }
    Ok(())
}

async fn setup_github_origin(
    root: &Path,
    full_name: &str,
    operation: &'static str,
) -> Result<(), WorkspaceCommandError> {
    let executable = trusted_gh_executable().ok_or_else(|| {
        WorkspaceCommandError::new("PROJECT-SETUP-GITHUB-CLI-MISSING", operation, true)
    })?;
    let mut view = configure_gh_command(&executable);
    view.args(["repo", "view", full_name, "--json", "nameWithOwner"]);
    let view = run_project_setup_gh(view, operation).await?;
    if view.status.success() {
        let origin = format!("https://github.com/{full_name}.git");
        if let Err(error) =
            run_project_setup_git(root, &["remote", "add", "origin", &origin], operation).await
        {
            if !git_origin_configured(root, operation).await? {
                return Err(error);
            }
        }
        return Ok(());
    }

    let mut create = configure_gh_command(&executable);
    create
        .args(["repo", "create", full_name, "--private", "--source"])
        .arg(root)
        .args(["--remote", "origin"]);
    let create = run_project_setup_gh(create, operation).await?;
    if create.status.success() || git_origin_configured(root, operation).await? {
        Ok(())
    } else {
        Err(WorkspaceCommandError::new(
            "PROJECT-SETUP-GITHUB-FAILED",
            operation,
            true,
        ))
    }
}

async fn create_managed_worktree(
    project_root: &Path,
    worktree_root: &Path,
    branch: &str,
) -> Result<(), WorkspaceCommandError> {
    let Some(parent) = worktree_root.parent() else {
        return Err(WorkspaceCommandError::new(
            "WORKSPACE-WORKTREE-ROOT-INVALID",
            "workspace_create_session",
            false,
        ));
    };
    tokio::fs::create_dir_all(parent).await.map_err(|_| {
        WorkspaceCommandError::new(
            "WORKSPACE-WORKTREE-DIRECTORY-CREATE",
            "workspace_create_session",
            true,
        )
    })?;
    let mut command = tokio::process::Command::new("/usr/bin/git");
    command
        .arg("-C")
        .arg(project_root)
        .args(["worktree", "add", "-b", branch])
        .arg(worktree_root)
        .arg("HEAD")
        .env_clear()
        .env("LC_ALL", "C")
        .env("GIT_CONFIG_NOSYSTEM", "1");
    run_git_worktree_command(command, "workspace_create_session").await
}

async fn remove_managed_worktree(
    project_root: &Path,
    worktree_root: &Path,
    operation: &'static str,
) -> Result<(), WorkspaceCommandError> {
    let existed = tokio::fs::try_exists(worktree_root).await.unwrap_or(false);
    let mut command = tokio::process::Command::new("/usr/bin/git");
    command
        .arg("-C")
        .arg(project_root)
        .args(["worktree", "remove", "--force"])
        .arg(worktree_root)
        .env_clear()
        .env("LC_ALL", "C")
        .env("GIT_CONFIG_NOSYSTEM", "1");
    if run_git_worktree_command(command, operation).await.is_ok() {
        return Ok(());
    }
    if existed {
        return Err(WorkspaceCommandError::new(
            "WORKSPACE-WORKTREE-REMOVE-FAILED",
            operation,
            true,
        ));
    }
    let mut prune = tokio::process::Command::new("/usr/bin/git");
    prune
        .arg("-C")
        .arg(project_root)
        .args(["worktree", "prune"])
        .env_clear()
        .env("LC_ALL", "C")
        .env("GIT_CONFIG_NOSYSTEM", "1");
    let _ = run_git_worktree_command(prune, operation).await;
    Ok(())
}

async fn rollback_managed_worktree(project_root: &Path, worktree_root: &Path, branch: &str) {
    let _ = remove_managed_worktree(project_root, worktree_root, "workspace_create_session").await;
    let mut branch_delete = tokio::process::Command::new("/usr/bin/git");
    branch_delete
        .arg("-C")
        .arg(project_root)
        .args(["branch", "-D", branch])
        .env_clear()
        .env("LC_ALL", "C")
        .env("GIT_CONFIG_NOSYSTEM", "1");
    let _ = run_git_worktree_command(branch_delete, "workspace_create_session").await;
}

async fn run_git_worktree_command(
    command: tokio::process::Command,
    operation: &'static str,
) -> Result<(), WorkspaceCommandError> {
    let output = run_bounded_command(
        command,
        WORKTREE_MUTATION_TIMEOUT,
        WORKTREE_OUTPUT_LIMIT,
        WORKTREE_OUTPUT_LIMIT,
    )
    .await
    .map_err(|error| {
        let code = if error == BoundedCommandError::Timeout {
            "WORKSPACE-WORKTREE-GIT-TIMEOUT"
        } else {
            "WORKSPACE-WORKTREE-GIT-FAILED"
        };
        WorkspaceCommandError::new(code, operation, true)
    })?;
    if !output.status.success() {
        return Err(WorkspaceCommandError::new(
            "WORKSPACE-WORKTREE-GIT-FAILED",
            operation,
            true,
        ));
    }
    Ok(())
}

async fn run_git_capture(
    root: &Path,
    arguments: &[&str],
    deadline: tokio::time::Instant,
) -> Result<String, WorkspaceCommandError> {
    let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
    if remaining.is_zero() {
        return Err(WorkspaceCommandError::new(
            "WORKSPACE-CONTEXT-CAPTURE-TIMEOUT",
            "workspace_save_context_snapshot",
            true,
        ));
    }
    let mut command = tokio::process::Command::new("/usr/bin/git");
    command
        .arg("-C")
        .arg(root)
        .args(arguments)
        .env_clear()
        .env("LC_ALL", "C")
        .env("GIT_CONFIG_NOSYSTEM", "1");
    let output = run_bounded_command(
        command,
        remaining,
        CONTEXT_STDOUT_LIMIT,
        CONTEXT_STDERR_LIMIT,
    )
    .await
    .map_err(|error| {
        let (code, recoverable) = match error {
            BoundedCommandError::Spawn => ("WORKSPACE-CONTEXT-GIT-UNAVAILABLE", true),
            BoundedCommandError::Timeout => ("WORKSPACE-CONTEXT-CAPTURE-TIMEOUT", true),
            BoundedCommandError::StdoutLimit | BoundedCommandError::StderrLimit => {
                ("WORKSPACE-CONTEXT-TOO-LARGE", false)
            }
            _ => ("WORKSPACE-CONTEXT-CAPTURE-FAILED", true),
        };
        WorkspaceCommandError::new(code, "workspace_save_context_snapshot", recoverable)
    })?;
    if !output.status.success() {
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
        "CODEX-WORKSPACE-IDENTITY-CHANGED"
        | "CODEX-WORKSPACE-NOT-DIRECTORY"
        | "CODEX-WORKSPACE-NOT-GIT"
        | "CODEX-WORKSPACE-GIT-SYMLINK"
        | "CODEX-WORKSPACE-GIT-INVALID"
        | "CODEX-WORKSPACE-OWNER-MISMATCH" => WorkspaceHealth::Changed,
        _ => WorkspaceHealth::Unreadable,
    }
}

fn repository_probe(state: RepositoryReadinessState) -> RepositoryReadinessProbe {
    RepositoryReadinessProbe {
        state,
        identity_matches: false,
        head_matches: false,
        branch_matches: false,
    }
}

fn ensure_repair_identity(
    candidate: &ValidatedWorkspaceCandidate,
    saved: &AppPrivateProjectIdentity,
) -> Result<(), WorkspaceCommandError> {
    if matches_saved_repository_identity(&candidate.git, saved) {
        Ok(())
    } else {
        Err(WorkspaceCommandError::new(
            "WORKSPACE-REPAIR-IDENTITY-CHANGED",
            "workspace_repair",
            false,
        ))
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
    use std::collections::HashMap;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::AtomicUsize;
    use std::sync::Mutex as StdMutex;
    use std::time::{Duration, Instant};

    use sha2::{Digest, Sha256};

    use crate::character::manifest::{
        CharacterDimensions, CharacterTrustedFrame, BUILTIN_HIYORI_PACK_ID,
        CHARACTER_TRUSTED_FRAME_ASSET_ID,
    };
    use crate::character::service::{
        resolve_builtin_directory, CharacterDeleteRequest, CharacterLibraryRequest,
        CharacterSelectRequest,
    };
    use crate::character::validation::snapshot_character_model;
    use crate::character::CharacterStorage;
    use crate::codex::supervisor::CodexSupervisor;
    use crate::codex::workspace::{
        AppPrivateWorkspaceRecord, FolderPicker, GitRepositoryIdentity, NativeFolderPicker,
        PickerFuture, RepositoryValidationFuture, RepositoryValidator, WorkspaceService,
    };
    use crate::workspace_history::types::{
        CharacterContext, CharacterTone, ProjectContext, SpeechDensity,
    };

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

    struct FixedFolderPicker(PathBuf);

    impl FolderPicker for FixedFolderPicker {
        fn pick_folder(&self) -> PickerFuture<'_> {
            let root = self.0.clone();
            Box::pin(async move { Some(root) })
        }
    }

    #[derive(Clone)]
    struct InstrumentedRepositoryValidator {
        delay: Duration,
        armed: Arc<AtomicBool>,
        active: Arc<AtomicUsize>,
        peak: Arc<AtomicUsize>,
        calls: Arc<StdMutex<HashMap<PathBuf, usize>>>,
        activation_order: Arc<StdMutex<Vec<PathBuf>>>,
        fail_root: Arc<StdMutex<Option<PathBuf>>>,
    }

    impl InstrumentedRepositoryValidator {
        fn new(delay: Duration) -> Self {
            Self {
                delay,
                armed: Arc::new(AtomicBool::new(false)),
                active: Arc::new(AtomicUsize::new(0)),
                peak: Arc::new(AtomicUsize::new(0)),
                calls: Arc::new(StdMutex::new(HashMap::new())),
                activation_order: Arc::new(StdMutex::new(Vec::new())),
                fail_root: Arc::new(StdMutex::new(None)),
            }
        }

        fn arm(&self, fail_root: PathBuf) {
            self.active.store(0, Ordering::SeqCst);
            self.peak.store(0, Ordering::SeqCst);
            self.calls.lock().expect("calls lock").clear();
            self.activation_order
                .lock()
                .expect("activation order lock")
                .clear();
            *self.fail_root.lock().expect("fail root lock") = Some(fail_root);
            self.armed.store(true, Ordering::SeqCst);
        }

        fn peak(&self) -> usize {
            self.peak.load(Ordering::SeqCst)
        }

        fn activation_order(&self) -> Vec<PathBuf> {
            self.activation_order
                .lock()
                .expect("activation order lock")
                .clone()
        }
    }

    impl RepositoryValidator for InstrumentedRepositoryValidator {
        fn validate<'a>(&'a self, selected: &'a Path) -> RepositoryValidationFuture<'a> {
            let validator = self.clone();
            let selected = selected.to_owned();
            Box::pin(async move {
                let canonical_root = tokio::fs::canonicalize(selected).await.map_err(|_| {
                    CodexCommandError::new("CODEX-WORKSPACE-MISSING", "codex.workspace.pick", true)
                })?;
                if !validator.armed.load(Ordering::SeqCst) {
                    return Ok(fake_repository_identity(canonical_root));
                }

                let call = {
                    let mut calls = validator.calls.lock().expect("calls lock");
                    let call = calls.entry(canonical_root.clone()).or_default();
                    *call += 1;
                    *call
                };
                if call == 1 {
                    let active = validator.active.fetch_add(1, Ordering::SeqCst) + 1;
                    validator.peak.fetch_max(active, Ordering::SeqCst);
                    tokio::time::sleep(validator.delay).await;
                    validator.active.fetch_sub(1, Ordering::SeqCst);
                    if validator.fail_root.lock().expect("fail root lock").as_ref()
                        == Some(&canonical_root)
                    {
                        return Err(CodexCommandError::new(
                            "CODEX-WORKSPACE-MISSING",
                            "codex.workspace.pick",
                            true,
                        ));
                    }
                } else {
                    validator
                        .activation_order
                        .lock()
                        .expect("activation order lock")
                        .push(canonical_root.clone());
                }
                Ok(fake_repository_identity(canonical_root))
            })
        }
    }

    fn fake_repository_identity(canonical_root: PathBuf) -> GitRepositoryIdentity {
        let digest = Sha256::digest(canonical_root.to_string_lossy().as_bytes());
        let root_inode = u64::from_le_bytes(digest[..8].try_into().expect("root identity bytes"));
        let git_inode = u64::from_le_bytes(digest[8..16].try_into().expect("git identity bytes"));
        GitRepositoryIdentity {
            canonical_git_dir: canonical_root.join(".git"),
            canonical_root,
            root_device: 1,
            root_inode,
            git_device: 1,
            git_inode,
            common_git_device: 1,
            common_git_inode: git_inode,
            project_identity: hex::encode(digest),
            github_repository: Some("fixture-owner/fixture-repository".to_owned()),
            branch: "main".to_owned(),
            head: "unborn".to_owned(),
            detached: false,
        }
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

    fn ensure_repository_head(root: &Path) {
        let has_head = std::process::Command::new("/usr/bin/git")
            .arg("-C")
            .arg(root)
            .args(["rev-parse", "--verify", "HEAD"])
            .output()
            .expect("inspect fixture HEAD")
            .status
            .success();
        if has_head {
            return;
        }
        let status = std::process::Command::new("/usr/bin/git")
            .arg("-C")
            .arg(root)
            .args([
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.invalid",
                "commit",
                "--allow-empty",
                "-qm",
                "fixture",
            ])
            .status()
            .expect("create fixture HEAD");
        assert!(status.success());
    }

    async fn register_project_workspace(
        service: &WorkspaceHistoryService,
        project_root: &Path,
        label: &str,
    ) -> WorkspaceStateSnapshot {
        ensure_repository_head(project_root);
        let existing_project_ids = service
            .list()
            .expect("state before project registration")
            .projects
            .into_iter()
            .map(|project| project.project_id)
            .collect::<Vec<_>>();
        let registered = service
            .register_validated_candidate(
                candidate(&service.workspace, project_root).await,
                "workspace_pick_register",
            )
            .await
            .expect("register project");
        let project_id = registered
            .projects
            .iter()
            .find(|project| !existing_project_ids.contains(&project.project_id))
            .expect("newly registered project")
            .project_id
            .clone();
        service
            .create_session(WorkspaceCreateSessionRequest {
                project_id,
                name: format!("Fixture {label}"),
                client_request_id: format!("request-{label}-{}", uuid::Uuid::new_v4()),
            })
            .await
            .expect("create project worktree")
    }

    async fn registered_context_service(
        label: &str,
    ) -> (WorkspaceHistoryService, PathBuf, PathBuf, String) {
        let data = temp_directory(&format!("history-service-context-{label}"));
        let original_root = git_repository();
        let project_root = data.join("project");
        fs::rename(original_root, &project_root).expect("move fixture project into data root");
        let workspace = WorkspaceService::production(CodexSupervisor::new());
        let service = WorkspaceHistoryService::new(
            WorkspaceHistoryStore::open(&data).expect("store"),
            workspace.clone(),
        );
        let state = register_project_workspace(&service, &project_root, label).await;
        let workspace_id = state.active_workspace_id.expect("active workspace");
        let workspace_root = service
            .store
            .private_workspace_record(&workspace_id)
            .expect("private workspace root")
            .canonical_root;
        (service, workspace_root, data, workspace_id)
    }

    fn project_id_for_workspace(service: &WorkspaceHistoryService, workspace_id: &str) -> String {
        service
            .store
            .private_project_identity(workspace_id)
            .expect("project identity")
            .project_id
    }

    fn project_root_for_workspace(
        service: &WorkspaceHistoryService,
        workspace_id: &str,
    ) -> PathBuf {
        service
            .store
            .private_project_identity(workspace_id)
            .expect("project identity")
            .canonical_root
    }

    struct ProjectLifecycleFixture {
        history: WorkspaceHistoryService,
        character: CharacterService,
        storage: CharacterStorage,
        store: WorkspaceHistoryStore,
        project_operations: Arc<Mutex<()>>,
        root: PathBuf,
        data: PathBuf,
        workspace_id: String,
        project_id: String,
    }

    impl ProjectLifecycleFixture {
        fn cleanup(self) {
            let _ = fs::remove_dir_all(self.data);
            let _ = fs::remove_dir_all(self.root);
        }
    }

    fn run_git(root: &Path, args: &[&str]) -> String {
        let output = std::process::Command::new("/usr/bin/git")
            .arg("-C")
            .arg(root)
            .args(args)
            .output()
            .expect("git command");
        assert!(
            output.status.success(),
            "git command failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout)
            .expect("git stdout")
            .trim()
            .to_owned()
    }

    fn git_directory(root: &Path) -> PathBuf {
        fs::canonicalize(run_git(root, &["rev-parse", "--absolute-git-dir"]))
            .expect("canonical git directory")
    }

    async fn project_lifecycle_fixture(label: &str) -> ProjectLifecycleFixture {
        let data = temp_directory(&format!("history-character-{label}"));
        let root = git_repository();
        fs::write(root.join("README.md"), "project source remains unchanged\n")
            .expect("fixture source");
        run_git(&root, &["add", "README.md"]);
        run_git(
            &root,
            &[
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.com",
                "commit",
                "-qm",
                "fixture",
            ],
        );

        let workspace = WorkspaceService::production(CodexSupervisor::new());
        let store = WorkspaceHistoryStore::open(&data).expect("history store");
        let storage = CharacterStorage::open(&data).expect("character storage");
        let project_operations = Arc::new(Mutex::new(()));
        let character = CharacterService::production_with_operations(
            storage.clone(),
            resolve_builtin_directory(Path::new("/missing")),
            project_operations.clone(),
        );
        let history = WorkspaceHistoryService::new_with_character(
            store.clone(),
            workspace.clone(),
            character.clone(),
            project_operations.clone(),
        );
        let state = register_project_workspace(&history, &root, label).await;
        let workspace_id = state.active_workspace_id.expect("active workspace");
        let project_id = state
            .workspaces
            .iter()
            .find(|workspace| workspace.workspace_id == workspace_id)
            .expect("registered workspace")
            .project_id
            .clone();

        ProjectLifecycleFixture {
            history,
            character,
            storage,
            store,
            project_operations,
            root,
            data,
            workspace_id,
            project_id,
        }
    }

    fn persisted_context(
        storage: &CharacterStorage,
        snapshot_id: &str,
    ) -> (String, String, String, String) {
        let connection = rusqlite::Connection::open(storage.workspace_history_path())
            .expect("open history database");
        connection
            .query_row(
                "SELECT source, label, content_redacted, content_hash
                 FROM context_snapshots WHERE id = ?1",
                [snapshot_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .expect("persisted context")
    }

    fn project_is_registered(storage: &CharacterStorage, project_id: &str) -> bool {
        let connection = rusqlite::Connection::open(storage.workspace_history_path())
            .expect("open history database");
        connection
            .query_row(
                "SELECT registered FROM projects WHERE id = ?1",
                [project_id],
                |row| row.get::<_, bool>(0),
            )
            .expect("project registration")
    }

    fn publish_unused_custom_pack(
        storage: &CharacterStorage,
    ) -> crate::character::storage::StoredPack {
        let pack_id = format!("custom:{}", uuid::Uuid::new_v4());
        let model = resolve_builtin_directory(Path::new("/missing"))
            .join("runtime/hiyori_pro_t11.model3.json");
        let mut snapshot =
            snapshot_character_model(&model, pack_id, "2026-07-18T00:00:00.000Z".to_owned())
                .expect("validated custom pack snapshot");
        let mut thumbnail = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut thumbnail, 1, 1);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder.write_header().expect("trusted frame header");
            writer
                .write_image_data(&[255, 128, 64, 255])
                .expect("trusted frame pixels");
        }
        let trusted_frame = CharacterTrustedFrame {
            asset_id: CHARACTER_TRUSTED_FRAME_ASSET_ID.to_owned(),
            bytes: thumbnail.len() as u64,
            sha256: hex::encode(Sha256::digest(&thumbnail)),
            dimensions: CharacterDimensions {
                width: 1,
                height: 1,
            },
        };
        snapshot.manifest.compatibility.expected_parameters = Some(70);
        snapshot.manifest.compatibility.expected_parts = Some(24);
        snapshot.manifest.compatibility.expected_drawables = Some(134);
        snapshot.manifest.trusted_frame = Some(trusted_frame.clone());
        let quarantine = storage
            .prepare_quarantine(&uuid::Uuid::new_v4().to_string(), &snapshot)
            .expect("prepare custom pack quarantine");
        storage
            .persist_trusted_frame(&quarantine, &trusted_frame, &thumbnail)
            .expect("persist trusted frame");
        storage
            .publish(&quarantine, &snapshot.manifest)
            .expect("publish unused custom pack")
    }

    #[test]
    fn project_setup_repository_names_are_bounded_and_do_not_accept_git_suffixes() {
        assert_eq!(
            validate_github_repository_name("reviewable-tool"),
            Some("reviewable-tool".to_owned())
        );
        for invalid in ["", ".", "..", "owner/repository", "repository.git"] {
            assert_eq!(validate_github_repository_name(invalid), None);
        }
        assert_eq!(validate_github_repository_name(&"a".repeat(101)), None);
    }

    #[tokio::test]
    async fn project_setup_inspection_keeps_non_git_folder_unmodified() {
        let root = temp_directory("project-setup-inspection");
        let setup = inspect_project_setup_root(root.clone())
            .await
            .expect("inspect setup root");

        assert!(setup
            .folder_name
            .starts_with("coding-wife-project-setup-inspection-"));
        assert!(!setup.git_initialized);
        assert!(!root.join(".git").exists());
    }

    #[tokio::test]
    async fn project_origin_probe_accepts_git_config_output_with_trailing_newline() {
        let root = git_repository();
        run_git(
            &root,
            &[
                "remote",
                "add",
                "origin",
                "https://example.com/fixture/repository.git",
            ],
        );

        assert!(git_origin_configured(&root, "workspace_pick_register")
            .await
            .expect("probe origin"));
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn project_pick_with_origin_registers_without_setup_dialog() {
        let data = temp_directory("project-pick-origin-ready");
        let root = git_repository();
        ensure_repository_head(&root);
        run_git(
            &root,
            &[
                "remote",
                "add",
                "origin",
                "https://github.com/fixture-owner/fixture-repository.git",
            ],
        );
        let workspace = WorkspaceService::new(
            CodexSupervisor::new(),
            Arc::new(FixedFolderPicker(root.clone())),
        );
        let service = WorkspaceHistoryService::new(
            WorkspaceHistoryStore::open(&data).expect("store"),
            workspace,
        );

        let response = service.pick_register().await.expect("register project");

        assert_eq!(response.outcome, WorkspacePickOutcome::Selected);
        assert!(response.setup.is_none());
        assert!(response
            .state
            .projects
            .iter()
            .any(|project| project.github_repository.as_deref()
                == Some("fixture-owner/fixture-repository")));
        let _ = fs::remove_dir_all(data);
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn turn_snapshot_uses_the_selected_pack_context() {
        let fixture = project_lifecycle_fixture("selected-character-context").await;
        fixture
            .character
            .library(CharacterLibraryRequest {
                workspace_id: fixture.workspace_id.clone(),
            })
            .await
            .expect("initialize character library");
        let published = publish_unused_custom_pack(&fixture.storage);
        fixture
            .character
            .select_pack(CharacterSelectRequest {
                workspace_id: fixture.workspace_id.clone(),
                pack_id: published.manifest.pack_id.clone(),
            })
            .await
            .expect("select custom pack");
        let custom_context = CharacterContext {
            display_name: published.manifest.display_name.clone(),
            tone: CharacterTone::Concise,
            tone_notes: "短く、落ち着いて伝える。".to_owned(),
            speech_density: SpeechDensity::KeyEvents,
            behavior: "進捗の節目で、次に必要な行動を簡潔に示す。".to_owned(),
            prohibited_expressions: vec!["利用者を責める表現".to_owned()],
        };
        fixture
            .history
            .save_character_context(AppSaveCharacterContextRequest {
                pack_id: published.manifest.pack_id.clone(),
                expected_version: 1,
                context: custom_context.clone(),
            })
            .await
            .expect("save selected pack context");

        let snapshot = fixture
            .history
            .turn_context_snapshot(WorkspaceLoadEditableContextRequest {
                workspace_id: fixture.workspace_id.clone(),
            })
            .await
            .expect("selected pack turn snapshot");
        assert_eq!(snapshot.character_pack_id, published.manifest.pack_id);
        assert_eq!(snapshot.character_version, 2);
        assert_eq!(snapshot.character, custom_context);

        fixture.cleanup();
    }

    #[tokio::test]
    async fn unregister_preserves_global_character_selection_and_history_source_git() {
        let fixture = project_lifecycle_fixture("unregister-cleanup").await;
        fixture
            .character
            .library(CharacterLibraryRequest {
                workspace_id: fixture.workspace_id.clone(),
            })
            .await
            .expect("initialize project selection");
        assert_eq!(
            fixture
                .storage
                .load_state()
                .expect("selected state")
                .selected(),
            BUILTIN_HIYORI_PACK_ID
        );

        let context = fixture
            .store
            .save_context_snapshot(
                &fixture.workspace_id,
                ContextSource::Files,
                "Release evidence",
                "durable history body",
            )
            .expect("context snapshot");
        let context_before = persisted_context(&fixture.storage, &context.snapshot_id);
        let timeline_request = WorkspaceTimelineRequest {
            workspace_id: fixture.workspace_id.clone(),
            before_sequence: None,
            limit: 200,
            search: None,
        };
        let timeline_before = fixture
            .history
            .timeline(timeline_request.clone())
            .expect("timeline before unregister");
        let source_before = fs::read(fixture.root.join("README.md")).expect("source before");
        let head_before = run_git(&fixture.root, &["rev-parse", "HEAD"]);
        let status_before = run_git(&fixture.root, &["status", "--porcelain=v1"]);

        fixture
            .history
            .unregister(ProjectSelectRequest {
                project_id: fixture.project_id.clone(),
            })
            .await
            .expect("unregister project");

        assert!(!project_is_registered(
            &fixture.storage,
            &fixture.project_id
        ));
        assert_eq!(
            fixture
                .storage
                .load_state()
                .expect("global state")
                .selected(),
            BUILTIN_HIYORI_PACK_ID
        );
        assert_eq!(
            persisted_context(&fixture.storage, &context.snapshot_id),
            context_before
        );
        assert_eq!(
            fixture
                .history
                .timeline(timeline_request)
                .expect("timeline after unregister"),
            timeline_before
        );
        assert_eq!(
            fs::read(fixture.root.join("README.md")).expect("source after"),
            source_before
        );
        assert_eq!(run_git(&fixture.root, &["rev-parse", "HEAD"]), head_before);
        assert_eq!(
            run_git(&fixture.root, &["status", "--porcelain=v1"]),
            status_before
        );

        let restarted = CharacterService::production(
            fixture.storage.clone(),
            resolve_builtin_directory(Path::new("/missing")),
        );
        assert_eq!(
            restarted
                .library(CharacterLibraryRequest {
                    workspace_id: fixture.workspace_id.clone(),
                })
                .await
                .expect_err("unregistered project must not resolve after restart")
                .code,
            "CHARACTER-PROJECT-NOT-FOUND"
        );
        assert_eq!(
            fixture
                .storage
                .load_state()
                .expect("restart state")
                .selected(),
            BUILTIN_HIYORI_PACK_ID
        );

        fixture.cleanup();
    }

    #[tokio::test]
    async fn unregister_failure_leaves_global_character_selection_unchanged() {
        let fixture = project_lifecycle_fixture("unregister-rollback").await;
        fixture
            .character
            .library(CharacterLibraryRequest {
                workspace_id: fixture.workspace_id.clone(),
            })
            .await
            .expect("initialize project selection");
        let state_before = fixture.storage.load_state().expect("state before failure");
        fixture
            .store
            .install_unregister_failure_for_test()
            .expect("install unregister failure");

        let error = fixture
            .history
            .unregister(ProjectSelectRequest {
                project_id: fixture.project_id.clone(),
            })
            .await
            .expect_err("history failure must reject unregister");

        assert_eq!(error.code, "HIST-PROJECT-UPDATE");
        assert!(error.recoverable);
        assert!(project_is_registered(&fixture.storage, &fixture.project_id));
        assert_eq!(
            fixture.storage.load_state().expect("rolled back state"),
            state_before
        );
        assert!(fixture
            .history
            .workspace
            .trusted_root(&fixture.workspace_id)
            .await
            .is_some());
        fixture
            .character
            .library(CharacterLibraryRequest {
                workspace_id: fixture.workspace_id.clone(),
            })
            .await
            .expect("selection remains usable after rollback");

        fixture.cleanup();
    }

    #[tokio::test]
    async fn project_operations_serialize_select_unregister_and_delete_races() {
        let select_first = project_lifecycle_fixture("race-select-first").await;
        let held = select_first.project_operations.clone().lock_owned().await;
        let character = select_first.character.clone();
        let workspace_id = select_first.workspace_id.clone();
        let select = tokio::spawn(async move {
            character
                .select_pack(CharacterSelectRequest {
                    workspace_id,
                    pack_id: BUILTIN_HIYORI_PACK_ID.to_owned(),
                })
                .await
        });
        tokio::time::sleep(Duration::from_millis(20)).await;
        let history = select_first.history.clone();
        let project_id = select_first.project_id.clone();
        let unregister = tokio::spawn(async move {
            history
                .unregister(ProjectSelectRequest { project_id })
                .await
        });
        tokio::time::sleep(Duration::from_millis(20)).await;
        drop(held);
        tokio::time::timeout(Duration::from_secs(5), select)
            .await
            .expect("select timeout")
            .expect("select task")
            .expect("select before unregister");
        tokio::time::timeout(Duration::from_secs(5), unregister)
            .await
            .expect("unregister timeout")
            .expect("unregister task")
            .expect("unregister after select");
        assert_eq!(
            select_first
                .storage
                .load_state()
                .expect("select-first final state")
                .selected(),
            BUILTIN_HIYORI_PACK_ID
        );
        select_first.cleanup();

        let unregister_first = project_lifecycle_fixture("race-unregister-first").await;
        let held = unregister_first
            .project_operations
            .clone()
            .lock_owned()
            .await;
        let history = unregister_first.history.clone();
        let project_id = unregister_first.project_id.clone();
        let unregister = tokio::spawn(async move {
            history
                .unregister(ProjectSelectRequest { project_id })
                .await
        });
        tokio::time::sleep(Duration::from_millis(20)).await;
        let character = unregister_first.character.clone();
        let workspace_id = unregister_first.workspace_id.clone();
        let select = tokio::spawn(async move {
            character
                .select_pack(CharacterSelectRequest {
                    workspace_id,
                    pack_id: BUILTIN_HIYORI_PACK_ID.to_owned(),
                })
                .await
        });
        tokio::time::sleep(Duration::from_millis(20)).await;
        drop(held);
        tokio::time::timeout(Duration::from_secs(5), unregister)
            .await
            .expect("unregister timeout")
            .expect("unregister task")
            .expect("unregister before select");
        let error = tokio::time::timeout(Duration::from_secs(5), select)
            .await
            .expect("select timeout")
            .expect("select task")
            .expect_err("select after unregister must fail");
        assert_eq!(error.code, "CHARACTER-PROJECT-NOT-FOUND");
        assert_eq!(
            unregister_first
                .storage
                .load_state()
                .expect("unregister-first final state")
                .selected(),
            BUILTIN_HIYORI_PACK_ID
        );
        unregister_first.cleanup();

        let delete_race = project_lifecycle_fixture("race-delete").await;
        let observer_root = git_repository();
        let observer =
            register_project_workspace(&delete_race.history, &observer_root, "observer").await;
        let observer_workspace_id = observer
            .active_workspace_id
            .expect("observer active workspace");
        let published = publish_unused_custom_pack(&delete_race.storage);
        let custom_pack_id = published.manifest.pack_id.clone();
        let pack_directory = published.directory.clone();
        let manifest_bytes =
            fs::read(pack_directory.join("pack.json")).expect("published manifest bytes");
        let library_before = delete_race
            .character
            .library(CharacterLibraryRequest {
                workspace_id: observer_workspace_id.clone(),
            })
            .await
            .expect("observer library before race");
        let held = delete_race.project_operations.clone().lock_owned().await;
        let history = delete_race.history.clone();
        let project_id = delete_race.project_id.clone();
        let unregister = tokio::spawn(async move {
            history
                .unregister(ProjectSelectRequest { project_id })
                .await
        });
        tokio::time::sleep(Duration::from_millis(20)).await;
        let character = delete_race.character.clone();
        let workspace_id = delete_race.workspace_id.clone();
        let pack_id = custom_pack_id.clone();
        let delete = tokio::spawn(async move {
            character
                .delete_pack(CharacterDeleteRequest {
                    workspace_id,
                    pack_id,
                })
                .await
        });
        tokio::time::sleep(Duration::from_millis(20)).await;
        drop(held);
        tokio::time::timeout(Duration::from_secs(5), unregister)
            .await
            .expect("unregister timeout")
            .expect("unregister task")
            .expect("unregister before delete");
        let error = tokio::time::timeout(Duration::from_secs(5), delete)
            .await
            .expect("delete timeout")
            .expect("delete task")
            .expect_err("stale delete after unregister must fail");
        assert_eq!(error.code, "CHARACTER-PROJECT-NOT-FOUND");
        assert!(pack_directory.is_dir());
        assert_eq!(
            fs::read(pack_directory.join("pack.json")).expect("retained manifest bytes"),
            manifest_bytes
        );
        let retained = delete_race
            .storage
            .load_pack(&custom_pack_id)
            .expect("retained custom pack metadata");
        assert_eq!(retained.directory, published.directory);
        assert_eq!(retained.manifest, published.manifest);
        assert_eq!(retained.manifest_hash, published.manifest_hash);
        assert_eq!(
            delete_race
                .character
                .library(CharacterLibraryRequest {
                    workspace_id: observer_workspace_id.clone(),
                })
                .await
                .expect("observer library after stale delete"),
            library_before
        );
        assert_eq!(
            delete_race
                .storage
                .load_state()
                .expect("delete race final state")
                .selected(),
            BUILTIN_HIYORI_PACK_ID
        );

        let selected = delete_race
            .character
            .select_pack(CharacterSelectRequest {
                workspace_id: observer_workspace_id.clone(),
                pack_id: custom_pack_id.clone(),
            })
            .await
            .expect("select retained custom pack");
        assert_eq!(selected.selected_pack_id, custom_pack_id);
        delete_race
            .character
            .select_pack(CharacterSelectRequest {
                workspace_id: observer_workspace_id.clone(),
                pack_id: BUILTIN_HIYORI_PACK_ID.to_owned(),
            })
            .await
            .expect("select builtin before normal delete");
        let deleted = delete_race
            .character
            .delete_pack(CharacterDeleteRequest {
                workspace_id: observer_workspace_id,
                pack_id: custom_pack_id,
            })
            .await
            .expect("delete retained inactive pack");
        assert_eq!(deleted.selected_pack_id, BUILTIN_HIYORI_PACK_ID);
        assert_eq!(deleted.packs.len(), 1);
        assert!(!pack_directory.exists());
        let _ = fs::remove_dir_all(observer_root);
        delete_race.cleanup();
    }

    #[tokio::test]
    async fn project_context_normalizes_existing_references_and_rejects_missing_paths() {
        let (service, root, data, workspace_id) =
            registered_context_service("reference-save").await;
        let project_id = project_id_for_workspace(&service, &workspace_id);
        let project_root = project_root_for_workspace(&service, &workspace_id);
        for reference_root in [&project_root, &root] {
            fs::create_dir_all(reference_root.join("docs")).expect("docs directory");
            fs::write(reference_root.join("docs/guide.md"), "guide").expect("guide");
        }

        let saved = service
            .save_project_context(ProjectSaveContextRequest {
                project_id: project_id.clone(),
                expected_version: 1,
                context: ProjectContext {
                    technical_references: vec!["./docs//guide.md".to_owned()],
                    ..ProjectContext::default()
                },
            })
            .await
            .expect("save canonical reference");
        assert_eq!(saved.context.technical_references, ["docs/guide.md"]);

        let error = service
            .save_project_context(ProjectSaveContextRequest {
                project_id,
                expected_version: saved.version,
                context: ProjectContext {
                    technical_references: vec!["docs/missing.md".to_owned()],
                    ..ProjectContext::default()
                },
            })
            .await
            .expect_err("missing reference rejected");
        assert_eq!(error.code, "WORKSPACE-PROJECT-CONTEXT-REFERENCE-MISSING");
        let _ = fs::remove_dir_all(data);
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn turn_snapshot_revalidates_references_inside_each_worktree() {
        use std::os::unix::fs::symlink;

        let (service, root, data, workspace_id) =
            registered_context_service("reference-retarget").await;
        let project_id = project_id_for_workspace(&service, &workspace_id);
        let project_root = project_root_for_workspace(&service, &workspace_id);
        for reference_root in [&project_root, &root] {
            fs::create_dir_all(reference_root.join("docs")).expect("docs directory");
            fs::write(reference_root.join("docs/target-a.md"), "a").expect("target a");
            fs::write(reference_root.join("docs/target-b.md"), "b").expect("target b");
            symlink("target-a.md", reference_root.join("docs/current.md")).expect("symlink a");
        }

        service
            .save_project_context(ProjectSaveContextRequest {
                project_id: project_id.clone(),
                expected_version: 1,
                context: ProjectContext {
                    technical_references: vec!["docs/current.md".to_owned()],
                    ..ProjectContext::default()
                },
            })
            .await
            .expect("save symlink reference");
        service
            .turn_context_snapshot(WorkspaceLoadEditableContextRequest {
                workspace_id: workspace_id.clone(),
            })
            .await
            .expect("unchanged target snapshots");

        fs::remove_file(root.join("docs/current.md")).expect("remove symlink a");
        symlink("target-b.md", root.join("docs/current.md")).expect("symlink b");
        service
            .turn_context_snapshot(WorkspaceLoadEditableContextRequest {
                workspace_id: workspace_id.clone(),
            })
            .await
            .expect("branch-specific target snapshots");

        let outside = temp_directory("reference-outside");
        fs::write(outside.join("outside.md"), "outside").expect("outside target");
        fs::remove_file(root.join("docs/current.md")).expect("remove symlink b");
        symlink(outside.join("outside.md"), root.join("docs/current.md")).expect("outside symlink");
        let error = service
            .turn_context_snapshot(WorkspaceLoadEditableContextRequest { workspace_id })
            .await
            .expect_err("outside retarget blocked");
        assert_eq!(error.code, "WORKSPACE-PROJECT-CONTEXT-REFERENCE-BOUNDARY");
        let _ = fs::remove_dir_all(outside);
        let _ = fs::remove_dir_all(data);
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn missing_then_available_workspace_reference_is_revalidated() {
        let (service, root, data, workspace_id) =
            registered_context_service("reference-recreate").await;
        let project_id = project_id_for_workspace(&service, &workspace_id);
        let project_root = project_root_for_workspace(&service, &workspace_id);
        for reference_root in [&project_root, &root] {
            fs::create_dir_all(reference_root.join("docs")).expect("docs directory");
            fs::write(reference_root.join("docs/current.md"), "first").expect("current target");
            fs::write(reference_root.join("docs/replacement.md"), "replacement")
                .expect("replacement target");
        }
        service
            .save_project_context(ProjectSaveContextRequest {
                project_id: project_id.clone(),
                expected_version: 1,
                context: ProjectContext {
                    technical_references: vec!["docs/current.md".to_owned()],
                    ..ProjectContext::default()
                },
            })
            .await
            .expect("save current target");

        fs::remove_file(root.join("docs/current.md")).expect("remove current target");
        let missing = service
            .turn_context_snapshot(WorkspaceLoadEditableContextRequest {
                workspace_id: workspace_id.clone(),
            })
            .await
            .expect_err("missing target blocked");
        assert_eq!(missing.code, "WORKSPACE-PROJECT-CONTEXT-REFERENCE-MISSING");
        fs::rename(
            root.join("docs/replacement.md"),
            root.join("docs/current.md"),
        )
        .expect("make replacement available");
        service
            .turn_context_snapshot(WorkspaceLoadEditableContextRequest {
                workspace_id: workspace_id.clone(),
            })
            .await
            .expect("replacement accepted after workspace revalidation");
        let _ = fs::remove_dir_all(data);
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn turn_snapshot_rejects_replaced_workspace_root() {
        let (service, root, data, workspace_id) =
            registered_context_service("reference-root").await;
        let moved = root.with_extension("original");
        fs::rename(&root, &moved).expect("move original root");
        let status = std::process::Command::new("/usr/bin/git")
            .args(["init", "-q", "-b", "main"])
            .arg(&root)
            .status()
            .expect("replacement git init");
        assert!(status.success());

        let error = service
            .turn_context_snapshot(WorkspaceLoadEditableContextRequest { workspace_id })
            .await
            .expect_err("changed root blocked");
        assert_eq!(error.code, "WORKSPACE-PROJECT-CONTEXT-ROOT-CHANGED");
        let _ = fs::remove_dir_all(data);
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(moved);
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
    async fn canceled_lifecycle_requires_the_supervisor_gated_command() {
        let (service, root, data, workspace_id) =
            registered_context_service("cancel-command").await;
        let before = service
            .list()
            .expect("state")
            .workspaces
            .into_iter()
            .find(|workspace| workspace.workspace_id == workspace_id)
            .expect("workspace");

        let direct_error = service
            .update_lifecycle(WorkspaceUpdateLifecycleRequest {
                workspace_id: workspace_id.clone(),
                lifecycle: super::super::types::WorkspaceLifecycle::Canceled,
                expected_updated_at: before.updated_at.clone(),
            })
            .await
            .expect_err("generic command must reject canceled lifecycle");
        assert_eq!(direct_error.code, "WORKSPACE-CANCEL-COMMAND-REQUIRED");
        assert_eq!(
            service
                .list()
                .expect("unchanged state")
                .workspaces
                .into_iter()
                .find(|workspace| workspace.workspace_id == workspace_id)
                .expect("workspace")
                .lifecycle,
            before.lifecycle
        );

        let canceled = service
            .cancel(WorkspaceCancelRequest {
                workspace_id: workspace_id.clone(),
                expected_updated_at: before.updated_at,
            })
            .await
            .expect("dedicated cancel");
        assert_eq!(
            canceled.lifecycle,
            super::super::types::WorkspaceLifecycle::Canceled
        );

        let _ = fs::remove_dir_all(data);
        let _ = fs::remove_dir_all(root);
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
    async fn readiness_revalidates_the_active_private_repository_without_git_mutation() {
        let (service, root, data, _) = registered_context_service("readiness-repository").await;
        fs::write(root.join("untracked.txt"), "preserve\n").expect("untracked fixture");
        let git_directory = git_directory(&root);
        let head_before = fs::read(git_directory.join("HEAD")).expect("HEAD before readiness");
        let index_before = fs::read(git_directory.join("index")).ok();
        let status_before = std::process::Command::new("/usr/bin/git")
            .arg("-C")
            .arg(&root)
            .args(["status", "--porcelain=v1", "--untracked-files=all"])
            .output()
            .expect("status before readiness")
            .stdout;

        let ready = service.repository_readiness().await;
        assert_eq!(ready.state, RepositoryReadinessState::Ready);
        assert!(ready.identity_matches);
        assert!(ready.head_matches);
        assert!(ready.branch_matches);
        assert_eq!(
            fs::read(git_directory.join("HEAD")).expect("HEAD after readiness"),
            head_before,
        );
        assert_eq!(fs::read(git_directory.join("index")).ok(), index_before);
        assert_eq!(
            std::process::Command::new("/usr/bin/git")
                .arg("-C")
                .arg(&root)
                .args(["status", "--porcelain=v1", "--untracked-files=all"])
                .output()
                .expect("status after readiness")
                .stdout,
            status_before,
        );

        let symbolic_ref = std::process::Command::new("/usr/bin/git")
            .arg("-C")
            .arg(&root)
            .args(["symbolic-ref", "HEAD", "refs/heads/readiness-stale"])
            .status()
            .expect("change fixture branch");
        assert!(symbolic_ref.success());
        let stale = service.repository_readiness().await;
        assert_eq!(stale.state, RepositoryReadinessState::StaleBranch);
        assert!(stale.identity_matches);
        assert!(!stale.head_matches);
        assert!(!stale.branch_matches);
        fs::write(git_directory.join("HEAD"), &head_before).expect("restore fixture HEAD");

        let moved_root = root.with_file_name(format!(
            "{}-moved",
            root.file_name()
                .and_then(|name| name.to_str())
                .expect("fixture root name"),
        ));
        fs::rename(&root, &moved_root).expect("move selected repository");
        std::os::unix::fs::symlink(&moved_root, &root).expect("retain moved repository link");
        let moved = service.repository_readiness().await;
        assert_eq!(moved.state, RepositoryReadinessState::Moved);
        assert!(moved.identity_matches);
        assert!(moved.head_matches);
        assert!(moved.branch_matches);

        fs::remove_file(&root).expect("remove moved repository link");
        assert_eq!(
            service.repository_readiness().await.state,
            RepositoryReadinessState::Missing,
        );
        let _ = fs::remove_dir_all(moved_root);
        let _ = fs::remove_dir_all(data);
    }

    #[tokio::test]
    async fn readiness_blocks_a_changed_saved_common_git_identity() {
        let data = temp_directory("history-service-readiness-identity");
        let root = git_repository();
        let workspace = WorkspaceService::production(CodexSupervisor::new());
        let store = WorkspaceHistoryStore::open(&data).expect("store");
        let mut original = candidate(&workspace, &root).await;
        original.git.common_git_inode = original.git.common_git_inode.saturating_add(1);
        let registration = store
            .register_candidate(&original)
            .expect("register changed identity");
        store
            .select_workspace(&registration.workspace.workspace_id)
            .expect("select changed identity fixture");
        let service = WorkspaceHistoryService::new(store, workspace);

        assert_eq!(
            service.repository_readiness().await.state,
            RepositoryReadinessState::Changed,
        );
        let _ = fs::remove_dir_all(data);
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn recheck_keeps_missing_workspace_resume_state_and_other_projects_available() {
        let (service, root, data, workspace_id) =
            registered_context_service("missing-recheck").await;
        let other_root = git_repository();
        let other_workspace_id = register_project_workspace(&service, &other_root, "other")
            .await
            .active_workspace_id
            .expect("other workspace active");
        service
            .select(WorkspaceSelectRequest {
                workspace_id: workspace_id.clone(),
            })
            .await
            .expect("reselect first workspace");
        service
            .save_draft(WorkspaceSaveDraftRequest {
                workspace_id: workspace_id.clone(),
                text: "Draft survives a missing repository.".to_owned(),
                effort: super::super::types::ReasoningEffort::Max,
                expected_revision: 0,
            })
            .await
            .expect("save draft");
        let event_id = "event-missing-summary".to_owned();
        let appended = service
            .append_domain_event(AppendDomainEventRequest {
                schema_version: WORKSPACE_HISTORY_SCHEMA_VERSION,
                event_id: event_id.clone(),
                workspace_id: workspace_id.clone(),
                session_id: None,
                producer: "code".to_owned(),
                kind: "code.message.completed".to_owned(),
                occurred_at: "2026-07-18T00:00:00.000Z".to_owned(),
                payload: serde_json::json!({
                    "semanticVersion": 1,
                    "generation": 1,
                    "sourceSequence": 1,
                    "itemHandle": "item-missing-summary",
                    "text": "Summary survives a missing repository.",
                }),
            })
            .await
            .expect("append summary");
        service
            .save_timeline_anchor(WorkspaceSaveTimelineAnchorRequest {
                workspace_id: workspace_id.clone(),
                event_id: event_id.clone(),
                sequence: appended.sequence,
                offset: -9,
            })
            .await
            .expect("save anchor");
        fs::remove_dir_all(&root).expect("remove repository");

        let missing = service
            .recheck(WorkspaceRecheckRequest {
                workspace_id: workspace_id.clone(),
                accept_observed_head: false,
            })
            .await
            .expect("missing snapshot");
        assert_eq!(
            missing.active_workspace_id.as_deref(),
            Some(workspace_id.as_str())
        );
        assert_eq!(missing.workspaces.len(), 2);
        assert_eq!(
            missing
                .workspaces
                .iter()
                .find(|workspace| workspace.workspace_id == workspace_id)
                .expect("missing workspace")
                .health,
            WorkspaceHealth::Missing
        );
        assert_eq!(
            missing.draft.expect("preserved draft").text,
            "Draft survives a missing repository."
        );
        let resume = missing.resume_state.expect("preserved resume state");
        assert_eq!(
            resume.last_summary.expect("preserved summary").text,
            "Summary survives a missing repository."
        );
        assert_eq!(
            resume.timeline_anchor.expect("preserved anchor").event_id,
            event_id
        );

        let other = service
            .select(WorkspaceSelectRequest {
                workspace_id: other_workspace_id.clone(),
            })
            .await
            .expect("other project remains available");
        assert_eq!(
            other.active_workspace_id.as_deref(),
            Some(other_workspace_id.as_str())
        );
        assert_eq!(
            other
                .workspaces
                .iter()
                .find(|workspace| workspace.workspace_id == other_workspace_id)
                .expect("other workspace")
                .health,
            WorkspaceHealth::Ready
        );

        let _ = fs::remove_dir_all(data);
        let _ = fs::remove_dir_all(other_root);
    }

    #[tokio::test]
    async fn recheck_requires_explicit_acceptance_for_external_head_without_mutating_git() {
        let (service, root, data, workspace_id) =
            registered_context_service("external-head-recheck").await;
        let initial_head = service
            .list()
            .expect("initial state")
            .workspaces
            .into_iter()
            .find(|workspace| workspace.workspace_id == workspace_id)
            .expect("initial workspace")
            .head;
        fs::write(root.join("README.md"), "external change\n").expect("source fixture");
        for arguments in [
            vec!["-C", root.to_str().expect("root"), "add", "README.md"],
            vec![
                "-C",
                root.to_str().expect("root"),
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.invalid",
                "commit",
                "-q",
                "-m",
                "external commit",
            ],
        ] {
            assert!(std::process::Command::new("/usr/bin/git")
                .args(arguments)
                .status()
                .expect("git fixture command")
                .success());
        }
        let git_directory = git_directory(&root);
        let head_before = fs::read(git_directory.join("HEAD")).expect("HEAD before recheck");
        let status_before = std::process::Command::new("/usr/bin/git")
            .arg("-C")
            .arg(&root)
            .args(["status", "--porcelain=v1", "--untracked-files=all"])
            .output()
            .expect("status before recheck")
            .stdout;

        let stale = service
            .recheck(WorkspaceRecheckRequest {
                workspace_id: workspace_id.clone(),
                accept_observed_head: false,
            })
            .await
            .expect("stale snapshot");
        let stale_workspace = stale
            .workspaces
            .iter()
            .find(|workspace| workspace.workspace_id == workspace_id)
            .expect("stale workspace");
        assert_eq!(stale_workspace.health, WorkspaceHealth::StaleBranch);
        assert_eq!(stale_workspace.head, initial_head);

        let ready = service
            .recheck(WorkspaceRecheckRequest {
                workspace_id: workspace_id.clone(),
                accept_observed_head: true,
            })
            .await
            .expect("accepted snapshot");
        let ready_workspace = ready
            .workspaces
            .iter()
            .find(|workspace| workspace.workspace_id == workspace_id)
            .expect("ready workspace");
        assert_eq!(ready_workspace.health, WorkspaceHealth::Ready);
        assert_ne!(ready_workspace.head, initial_head);
        assert_eq!(
            fs::read(git_directory.join("HEAD")).expect("HEAD after recheck"),
            head_before
        );
        assert_eq!(
            std::process::Command::new("/usr/bin/git")
                .arg("-C")
                .arg(&root)
                .args(["status", "--porcelain=v1", "--untracked-files=all"])
                .output()
                .expect("status after recheck")
                .stdout,
            status_before
        );

        let _ = fs::remove_dir_all(data);
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn changed_repository_identity_remains_blocked_across_restore_attempts() {
        let data = temp_directory("history-service-changed");
        let root = git_repository();
        let workspace = WorkspaceService::production(CodexSupervisor::new());
        let store = WorkspaceHistoryStore::open(&data).expect("store");
        let mut original = candidate(&workspace, &root).await;
        original.git.common_git_inode = original.git.common_git_inode.saturating_add(1);
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
        let (service, root, data, workspace_id) =
            registered_context_service("capture-sources").await;
        fs::write(root.join("fixture.txt"), "fixture context\n").expect("fixture file");

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
        let _ = fs::remove_dir_all(data);
    }

    #[tokio::test]
    async fn startup_restore_of_twenty_repositories_stays_within_the_budget() {
        let data = temp_directory("history-service-restore-budget");
        let workspace = WorkspaceService::production(CodexSupervisor::new());
        let store = WorkspaceHistoryStore::open(&data).expect("store");
        let mut roots = Vec::new();
        for _ in 0..20 {
            let root = git_repository();
            store
                .register_candidate(&candidate(&workspace, &root).await)
                .expect("register fixture");
            roots.push(root);
        }
        let service = WorkspaceHistoryService::new(store, workspace);

        let started = Instant::now();
        let report = service.restore_startup().await;
        let elapsed = started.elapsed();

        assert_eq!(report.ready, 20);
        assert_eq!(report.changed, 0);
        assert_eq!(report.unavailable, 0);
        assert!(
            elapsed < Duration::from_secs(5),
            "real startup restore exceeded its five-second budget: {elapsed:?}"
        );
        let _ = fs::remove_dir_all(data);
        for root in roots {
            let _ = fs::remove_dir_all(root);
        }
    }

    #[tokio::test]
    async fn startup_restore_bounds_validation_and_applies_results_in_input_order() {
        let data = temp_directory("history-service-restore-concurrency");
        let validator = InstrumentedRepositoryValidator::new(Duration::from_millis(25));
        let workspace = WorkspaceService::new_with_repository_validator(
            CodexSupervisor::new(),
            Arc::new(NativeFolderPicker),
            Arc::new(validator.clone()),
        );
        let store = WorkspaceHistoryStore::open(&data).expect("store");
        let mut roots = Vec::new();
        for index in 0..20 {
            let root = temp_directory(&format!("history-service-bounded-{index:02}"));
            store
                .register_candidate(&candidate(&workspace, &root).await)
                .expect("register fixture");
            roots.push(root);
        }
        let records = store.private_workspace_records().expect("restore records");
        let initial_selection = store
            .snapshot(None)
            .expect("initial state")
            .active_workspace_id;
        let failed_root = records[7].canonical_root.clone();
        validator.arm(failed_root.clone());
        let service = WorkspaceHistoryService::new(store.clone(), workspace);

        let report = service.restore_startup().await;

        assert_eq!(report.ready, 19);
        assert_eq!(report.changed, 0);
        assert_eq!(report.unavailable, 1);
        assert_eq!(
            store
                .snapshot(None)
                .expect("restored state")
                .active_workspace_id,
            initial_selection
        );
        assert_eq!(validator.peak(), STARTUP_REPOSITORY_VALIDATION_CONCURRENCY);
        assert!(validator.peak() > 1);
        assert!(validator.peak() <= STARTUP_REPOSITORY_VALIDATION_CONCURRENCY);
        assert_eq!(
            validator.activation_order(),
            records
                .iter()
                .map(|record| record.canonical_root.clone())
                .filter(|root| root != &failed_root)
                .collect::<Vec<_>>()
        );

        let _ = fs::remove_dir_all(data);
        for root in roots {
            let _ = fs::remove_dir_all(root);
        }
    }

    #[tokio::test]
    async fn native_consumers_wait_for_restore_and_mutations_fail_while_pending() {
        let data = temp_directory("history-service-startup-gate");
        let workspace = WorkspaceService::production(CodexSupervisor::new());
        let service = WorkspaceHistoryService::new_pending_restore(
            WorkspaceHistoryStore::open(&data).expect("store"),
            workspace,
        );
        let list_service = service.clone();
        let list_task = tokio::spawn(async move { list_service.list_after_startup().await });
        let readiness_service = service.clone();
        let readiness_task =
            tokio::spawn(async move { readiness_service.wait_for_startup_restore().await });
        tokio::task::yield_now().await;

        assert!(!list_task.is_finished());
        assert!(!readiness_task.is_finished());
        assert_eq!(
            service
                .issue_delete_challenge("workspace-pending")
                .expect_err("startup must gate mutations")
                .code,
            "WORKSPACE-STARTUP-PENDING"
        );

        let report = service.restore_startup().await;
        assert_eq!(report.ready, 0);
        assert!(list_task
            .await
            .expect("list task")
            .expect("state")
            .workspaces
            .is_empty());
        readiness_task
            .await
            .expect("startup restore barrier");
        let _ = fs::remove_dir_all(data);
    }

    #[tokio::test]
    async fn shutdown_rejects_late_writers_and_joins_the_pending_database_task() {
        let data = temp_directory("history-service-shutdown-gate");
        let workspace = WorkspaceService::production(CodexSupervisor::new());
        let service = WorkspaceHistoryService::new(
            WorkspaceHistoryStore::open(&data).expect("store"),
            workspace,
        );
        let operation_guard = service.operation_lock.lock().await;

        let first = service.shutdown_completion().await;
        let duplicate = service.shutdown_completion().await;
        assert!(Arc::ptr_eq(&first, &duplicate));
        assert!(tokio::time::timeout(Duration::from_millis(5), first.wait())
            .await
            .is_err());
        assert_eq!(
            service
                .issue_delete_challenge("workspace-late")
                .expect_err("shutdown admission gate rejects late writers")
                .code,
            "HIST-SHUTTING-DOWN"
        );
        assert!(service
            .list()
            .expect("reads remain available")
            .workspaces
            .is_empty());

        drop(operation_guard);
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(1), duplicate.wait())
                .await
                .expect("database shutdown converges after the writer releases")
                .expect("database shutdown succeeds"),
            0
        );
        let completed = service.shutdown_completion().await;
        assert!(Arc::ptr_eq(&duplicate, &completed));
        assert_eq!(
            service
                .force_shutdown_now()
                .await
                .expect("duplicate force reuses completed shutdown"),
            0
        );

        let _ = fs::remove_dir_all(data);
    }
}
