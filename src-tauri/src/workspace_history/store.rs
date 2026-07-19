use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, SystemTime};

use chrono::{SecondsFormat, Utc};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, Transaction};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::codex::redaction::redact_text;
use crate::codex::types::{ApprovalDecision, PendingKind, PendingRequestView, PendingResponseKind};
use crate::codex::workspace::{
    matches_saved_repository_identity, AppPrivateProjectIdentity, AppPrivateWorkspaceRecord,
    GitRepositoryIdentity, ValidatedWorkspaceCandidate,
};
use crate::git_review::repository::{
    is_object_id, validate_opaque_id as validate_git_opaque_id, validate_relative_path,
};
use crate::git_review::types::{
    valid_git_text, CommitEvidenceDetail, CommitProducer, DecisionEvidence, FailedAttemptEvidence,
    GateKind, GateResult, GitObservation, GitSupportState, KnownRisk, SkillInjectionMode,
    SkillPathAuthority, VerificationEvidence, WorkUnitGitObservation, GIT_REVIEW_SCHEMA_VERSION,
    MAX_CHANGED_FILES, MAX_CHANGED_LINES, MAX_EVIDENCE_ITEMS, MAX_GIT_ACCEPTANCE_CHARS,
    MAX_GIT_ATTEMPT_APPROACH_CHARS, MAX_GIT_ATTEMPT_LEARNING_CHARS, MAX_GIT_ATTEMPT_OUTCOME_CHARS,
    MAX_GIT_AUTHOR_EMAIL_CHARS, MAX_GIT_AUTHOR_NAME_CHARS, MAX_GIT_BLOCK_REASON_CHARS,
    MAX_GIT_COMMIT_BODY_CHARS, MAX_GIT_COMMIT_SUBJECT_CHARS, MAX_GIT_DECISION_ANSWER_CHARS,
    MAX_GIT_DECISION_RATIONALE_CHARS, MAX_GIT_DECISION_SUMMARY_CHARS, MAX_GIT_OBJECTIVE_CHARS,
    MAX_GIT_RISK_CATEGORY_CHARS, MAX_GIT_RISK_MITIGATION_CHARS, MAX_GIT_RISK_SUMMARY_CHARS,
    MAX_GIT_VERIFICATION_CHECK_CHARS, MAX_GIT_VERIFICATION_SUMMARY_CHARS,
};

use super::editable_context::{
    canonical_json, content_hash, encode_project_reference_manifest, normalize_character_context,
    normalize_project_context, snapshot_hash, validate_project_reference_manifest,
    validate_turn_snapshot, ProjectReferenceManifest, ProjectReferenceValidation,
    DEFAULT_CHARACTER_HASH, DEFAULT_CHARACTER_JSON, DEFAULT_PROJECT_HASH, DEFAULT_PROJECT_JSON,
};
use super::types::{
    AppendEventResult, CharacterContext, ContextSnapshotView, ContextSource, HistoryMode,
    HistoryStatus, NormalizedDomainEvent, ProjectContext, ReasoningEffort, TimelineEventView,
    TimelinePage, VersionedCharacterContext, VersionedProjectContext, WorkspaceAttention,
    WorkspaceDraftView, WorkspaceEditableContext, WorkspaceHealth, WorkspaceHistoryError,
    WorkspaceLastSummaryView, WorkspaceLifecycle, WorkspaceResumeStateView, WorkspaceStateSnapshot,
    WorkspaceSummary, WorkspaceTimelineAnchorView, WorkspaceTurnContextSnapshot,
    DOMAIN_EVENT_SCHEMA_VERSION, WORKSPACE_CONTEXT_SCHEMA_VERSION,
    WORKSPACE_HISTORY_SCHEMA_VERSION, WORKSPACE_RESUME_STATE_SCHEMA_VERSION,
};

const DATABASE_FILE_NAME: &str = "workspace-history.sqlite3";
const CURRENT_DATABASE_VERSION: i64 = 5;
const MAX_EVENT_BYTES: usize = 256 * 1024;
const MAX_EVENT_ARRAY_ITEMS: usize = 512;
const MAX_CONTEXT_BYTES: usize = 1024 * 1024;
const MAX_TIMELINE_PAGE: u32 = 200;
const MAX_WORKSPACES: i64 = 200;
const MAX_TIMELINE_ANCHOR_OFFSET: i64 = 1_000_000;
const DELETE_TOKEN_TTL: Duration = Duration::from_secs(60);

const WORKSPACE_SELECT: &str = r#"
SELECT
  w.id, w.project_id, p.alias, w.name, p.branch, p.head, p.detached,
  w.lifecycle, w.attention, w.health, w.created_at, w.updated_at, w.last_selected_at
FROM workspaces w
JOIN projects p ON p.id = w.project_id
"#;

const MIGRATION_1: &str = r#"
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  canonical_root BLOB NOT NULL UNIQUE,
  alias TEXT NOT NULL,
  project_identity TEXT NOT NULL,
  root_device INTEGER NOT NULL,
  root_inode INTEGER NOT NULL,
  git_device INTEGER NOT NULL,
  git_inode INTEGER NOT NULL,
  branch TEXT NOT NULL,
  head TEXT NOT NULL,
  detached INTEGER NOT NULL CHECK (detached IN (0, 1)),
  health TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  goal TEXT NOT NULL DEFAULT '',
  lifecycle TEXT NOT NULL,
  attention TEXT,
  health TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_selected_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  client_request_id TEXT UNIQUE,
  status TEXT NOT NULL,
  last_summary TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspace_preferences (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  draft_text TEXT NOT NULL DEFAULT '',
  effort TEXT NOT NULL DEFAULT 'fast',
  draft_revision INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS context_snapshots (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  label TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  byte_count INTEGER NOT NULL,
  content_redacted TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  schema_version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS domain_events (
  event_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  sequence INTEGER NOT NULL,
  producer TEXT NOT NULL,
  kind TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(workspace_id, sequence)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  version INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workspaces_project ON workspaces(project_id);
CREATE INDEX IF NOT EXISTS idx_workspaces_lifecycle ON workspaces(lifecycle, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON sessions(workspace_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_context_workspace ON context_snapshots(workspace_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_workspace_sequence ON domain_events(workspace_id, sequence DESC);
CREATE INDEX IF NOT EXISTS idx_events_workspace_kind ON domain_events(workspace_id, kind, sequence DESC);
"#;

const MIGRATION_2: &str = r#"
CREATE TABLE IF NOT EXISTS workspace_contexts (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  project_json TEXT NOT NULL,
  project_version INTEGER NOT NULL CHECK (project_version >= 1),
  project_hash TEXT NOT NULL,
  project_updated_at TEXT NOT NULL,
  character_json TEXT NOT NULL,
  character_version INTEGER NOT NULL CHECK (character_version >= 1),
  character_hash TEXT NOT NULL,
  character_updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO workspace_contexts (
  workspace_id, project_json, project_version, project_hash, project_updated_at,
  character_json, character_version, character_hash, character_updated_at
)
SELECT
  id,
  '{"goal":"","constraints":"","definitionOfDone":[],"technicalReferences":[],"userNotes":""}',
  1,
  'e0da727f2381a1c290ddcb74bdb52b44b0ec890559443d795f29731d68fe1323',
  updated_at,
  '{"displayName":"Sol","tone":"neutral","toneNotes":"","speechDensity":"key_events","behavior":"","prohibitedExpressions":[]}',
  1,
  '0ab87e72a74abd7bebaaf2b5c4e568e6e3e4bae7e21febca76a6b079f6d33c8c',
  updated_at
FROM workspaces;

CREATE INDEX IF NOT EXISTS idx_workspace_context_versions
  ON workspace_contexts(workspace_id, project_version, character_version);
"#;

const MIGRATION_3: &str = r#"
ALTER TABLE workspace_contexts
  ADD COLUMN project_reference_manifest_json TEXT;
"#;

const MIGRATION_4: &str = r#"
ALTER TABLE projects
  ADD COLUMN registered INTEGER NOT NULL DEFAULT 1 CHECK (registered IN (0, 1));

CREATE INDEX IF NOT EXISTS idx_projects_registered
  ON projects(registered, updated_at DESC);
"#;

const MIGRATION_5: &str = r#"
CREATE TABLE IF NOT EXISTS workspace_resume_states (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  last_summary_event_id TEXT,
  last_summary_sequence INTEGER CHECK (last_summary_sequence >= 1),
  last_summary_text TEXT,
  last_summary_updated_at TEXT,
  timeline_anchor_event_id TEXT,
  timeline_anchor_sequence INTEGER CHECK (timeline_anchor_sequence >= 1),
  timeline_anchor_offset INTEGER,
  timeline_anchor_revision INTEGER NOT NULL DEFAULT 0 CHECK (timeline_anchor_revision >= 0),
  timeline_anchor_updated_at TEXT,
  CHECK (
    (last_summary_event_id IS NULL AND last_summary_sequence IS NULL AND
      last_summary_text IS NULL AND last_summary_updated_at IS NULL) OR
    (last_summary_event_id IS NOT NULL AND last_summary_sequence IS NOT NULL AND
      last_summary_text IS NOT NULL AND last_summary_updated_at IS NOT NULL)
  ),
  CHECK (
    (timeline_anchor_event_id IS NULL AND timeline_anchor_sequence IS NULL AND
      timeline_anchor_offset IS NULL AND timeline_anchor_updated_at IS NULL) OR
    (timeline_anchor_event_id IS NOT NULL AND timeline_anchor_sequence IS NOT NULL AND
      timeline_anchor_offset IS NOT NULL AND timeline_anchor_updated_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_resume_summary_sequence
  ON workspace_resume_states(workspace_id, last_summary_sequence);
CREATE INDEX IF NOT EXISTS idx_resume_anchor_sequence
  ON workspace_resume_states(workspace_id, timeline_anchor_sequence);
"#;

#[derive(Debug)]
struct StoreInner {
    connection: Connection,
    status: HistoryStatus,
    database_path: Option<PathBuf>,
}

#[derive(Clone, Debug)]
struct DeleteChallengeRecord {
    workspace_id: String,
    expires_at: SystemTime,
}

#[derive(Clone, Debug)]
pub struct DeleteChallenge {
    pub token: String,
    pub workspace_id: String,
    pub expires_at: String,
}

#[derive(Clone, Debug)]
pub struct PersistedWorkspaceRegistration {
    pub workspace: WorkspaceSummary,
    pub private_record: AppPrivateWorkspaceRecord,
    pub duplicate: bool,
}

#[derive(Clone, Debug)]
struct StoredProjectLinkage {
    project_id: String,
    workspace_id: String,
    canonical_root: PathBuf,
    registered: bool,
    project_identity: String,
    root_device: u64,
    root_inode: u64,
    git_device: u64,
    git_inode: u64,
}

impl StoredProjectLinkage {
    fn matches(&self, candidate: &GitRepositoryIdentity) -> bool {
        self.project_identity == candidate.project_identity
            && self.root_device == candidate.root_device
            && self.root_inode == candidate.root_inode
            && self.git_device == candidate.git_device
            && self.git_inode == candidate.git_inode
    }

    fn private_identity(&self) -> AppPrivateProjectIdentity {
        AppPrivateProjectIdentity {
            project_id: self.project_id.clone(),
            canonical_root: self.canonical_root.clone(),
            project_identity: self.project_identity.clone(),
            root_device: self.root_device,
            root_inode: self.root_inode,
            git_device: self.git_device,
            git_inode: self.git_inode,
        }
    }
}

#[derive(Clone, Debug)]
pub struct PersistedSessionWorkspace {
    pub workspace: WorkspaceSummary,
    pub private_record: AppPrivateWorkspaceRecord,
    pub created: bool,
}

#[derive(Clone)]
pub struct WorkspaceHistoryStore {
    inner: Arc<Mutex<StoreInner>>,
    delete_challenges: Arc<Mutex<HashMap<String, DeleteChallengeRecord>>>,
    accepting_writes: Arc<AtomicBool>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct StoreReadinessProbe {
    pub mode: HistoryMode,
    pub integrity_ok: bool,
    pub writable: bool,
    pub writer_ready: bool,
    pub migration_current: bool,
    pub backup_valid: bool,
}

impl WorkspaceHistoryStore {
    pub fn open(app_data_directory: impl AsRef<Path>) -> Result<Self, WorkspaceHistoryError> {
        let directory = app_data_directory.as_ref();
        fs::create_dir_all(directory).map_err(|_| history_error("HIST-DIRECTORY", true))?;
        set_private_directory_permissions(directory)
            .map_err(|_| history_error("HIST-DIRECTORY-PERMISSION", false))?;
        let database_path = directory.join(DATABASE_FILE_NAME);
        let existed = database_path.exists();

        match open_configured_connection(&database_path, existed) {
            Ok((connection, status)) => Ok(Self::from_connection(
                connection,
                status,
                Some(database_path),
            )),
            Err(failure) => {
                let backup_name = backup_database_files(&database_path).ok().flatten();
                let connection = Connection::open_in_memory()
                    .map_err(|_| history_error("HIST-RECOVERY-OPEN", false))?;
                configure_connection(&connection)
                    .map_err(|_| history_error("HIST-RECOVERY-CONFIGURE", false))?;
                apply_migrations(
                    &connection,
                    &[
                        (1, MIGRATION_1),
                        (2, MIGRATION_2),
                        (3, MIGRATION_3),
                        (4, MIGRATION_4),
                        (5, MIGRATION_5),
                    ],
                )
                .map_err(|_| history_error("HIST-RECOVERY-SCHEMA", false))?;
                Ok(Self::from_connection(
                    connection,
                    HistoryStatus {
                        schema_version: WORKSPACE_HISTORY_SCHEMA_VERSION,
                        mode: HistoryMode::RecoveryRequired,
                        error_code: Some(failure.code),
                        backup_name,
                    },
                    Some(database_path),
                ))
            }
        }
    }

    fn from_connection(
        connection: Connection,
        status: HistoryStatus,
        database_path: Option<PathBuf>,
    ) -> Self {
        Self {
            inner: Arc::new(Mutex::new(StoreInner {
                connection,
                status,
                database_path,
            })),
            delete_challenges: Arc::new(Mutex::new(HashMap::new())),
            accepting_writes: Arc::new(AtomicBool::new(true)),
        }
    }

    pub fn status(&self) -> HistoryStatus {
        self.lock().status.clone()
    }

    pub(crate) fn readiness_probe(&self) -> StoreReadinessProbe {
        let accepting_writes = self.accepting_writes.load(Ordering::Acquire);
        let inner = self.lock();
        let integrity_ok = inner
            .connection
            .query_row("PRAGMA quick_check", [], |row| row.get::<_, String>(0))
            .is_ok_and(|value| value == "ok");
        let query_only = inner
            .connection
            .query_row("PRAGMA query_only", [], |row| row.get::<_, i64>(0))
            .unwrap_or(1);
        let migration_current = inner
            .connection
            .query_row(
                "SELECT COUNT(*), COALESCE(MAX(version), 0) FROM schema_migrations",
                [],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
            )
            .is_ok_and(|(count, maximum)| {
                count == CURRENT_DATABASE_VERSION && maximum == CURRENT_DATABASE_VERSION
            });
        let writable = inner.status.mode == HistoryMode::Ready
            && query_only == 0
            && integrity_ok
            && migration_current;
        let writer_ready = writable && accepting_writes && inner.connection.is_autocommit();
        let backup_valid = validate_readiness_backup(inner.database_path.as_deref(), &inner.status);
        StoreReadinessProbe {
            mode: inner.status.mode,
            integrity_ok,
            writable,
            writer_ready,
            migration_current,
            backup_valid,
        }
    }

    pub fn database_file_name(&self) -> &'static str {
        DATABASE_FILE_NAME
    }

    pub fn recover_unfinished_turns(&self) -> Result<usize, WorkspaceHistoryError> {
        self.ensure_writable("history.recover_unfinished_turns")?;
        self.recover_unfinished_turns_for_shutdown()
    }

    fn recover_unfinished_turns_for_shutdown(&self) -> Result<usize, WorkspaceHistoryError> {
        let mut inner = self.lock();
        let persisted = {
            let mut statement = inner
                .connection
                .prepare(
                    "SELECT workspace_id, session_id, payload_json
                     FROM domain_events
                     WHERE producer = 'code' AND kind = 'code.session.status.changed'
                     ORDER BY workspace_id ASC, sequence ASC",
                )
                .map_err(|_| history_error("HIST-RECOVERY-QUERY", true))?;
            let rows = statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                })
                .map_err(|_| history_error("HIST-RECOVERY-QUERY", true))?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|_| history_error("HIST-RECOVERY-DECODE", false))?
        };
        let mut latest = HashMap::<(String, String), UnfinishedTurnRecord>::new();
        for (workspace_id, session_id, payload_json) in persisted {
            let Ok(payload) = serde_json::from_str::<Value>(&payload_json) else {
                continue;
            };
            let Some(object) = payload.as_object() else {
                continue;
            };
            let (
                Some(generation),
                Some(source_sequence),
                Some(thread_handle),
                Some(turn_handle),
                Some(status),
            ) = (
                object.get("generation").and_then(Value::as_u64),
                object.get("sourceSequence").and_then(Value::as_u64),
                object.get("threadHandle").and_then(Value::as_str),
                object.get("turnHandle").and_then(Value::as_str),
                object.get("status").and_then(Value::as_str),
            )
            else {
                continue;
            };
            latest.insert(
                (workspace_id.clone(), turn_handle.to_owned()),
                UnfinishedTurnRecord {
                    workspace_id,
                    session_id,
                    generation,
                    source_sequence,
                    thread_handle: thread_handle.to_owned(),
                    turn_handle: turn_handle.to_owned(),
                    status: status.to_owned(),
                },
            );
        }

        let transaction = inner
            .connection
            .transaction()
            .map_err(|_| history_error("HIST-TRANSACTION-BEGIN", true))?;
        let mut recovered = 0usize;
        for record in latest
            .values()
            .filter(|record| matches!(record.status.as_str(), "running" | "inProgress" | "waiting"))
        {
            append_event_in_transaction(
                &transaction,
                &NormalizedDomainEvent {
                    schema_version: DOMAIN_EVENT_SCHEMA_VERSION,
                    event_id: format!("event-app-recovery-{}", uuid::Uuid::new_v4()),
                    workspace_id: record.workspace_id.clone(),
                    session_id: record.session_id.clone(),
                    producer: "code".to_owned(),
                    kind: "code.session.status.changed".to_owned(),
                    occurred_at: now(),
                    payload: json!({
                        "semanticVersion": 1,
                        "generation": record.generation,
                        "sourceSequence": record.source_sequence.saturating_add(1),
                        "threadHandle": record.thread_handle,
                        "turnHandle": record.turn_handle,
                        "status": "interrupted",
                    }),
                },
                None,
            )?;
            recovered = recovered.saturating_add(1);
        }
        transaction
            .commit()
            .map_err(|_| history_error("HIST-TRANSACTION-COMMIT", true))?;
        Ok(recovered)
    }

    pub fn checkpoint_for_shutdown(&self) -> Result<(), WorkspaceHistoryError> {
        self.ensure_writable("history.shutdown")?;
        self.checkpoint_after_admission_closed()
    }

    fn checkpoint_after_admission_closed(&self) -> Result<(), WorkspaceHistoryError> {
        let inner = self.lock();
        let (busy, _, _) = inner
            .connection
            .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })
            .map_err(|_| history_error("HIST-SHUTDOWN-CHECKPOINT", true))?;
        if busy != 0 {
            return Err(history_error("HIST-SHUTDOWN-BUSY", true));
        }
        Ok(())
    }

    pub fn force_shutdown_now(&self) -> Result<usize, WorkspaceHistoryError> {
        self.begin_shutdown();
        let interrupted = self.recover_unfinished_turns_for_shutdown()?;
        self.checkpoint_after_admission_closed()?;
        Ok(interrupted)
    }

    pub fn begin_shutdown(&self) {
        self.accepting_writes.store(false, Ordering::Release);
        self.delete_challenges
            .lock()
            .expect("delete challenges lock poisoned")
            .clear();
    }

    #[cfg(test)]
    pub(crate) fn install_unregister_failure_for_test(&self) -> Result<(), WorkspaceHistoryError> {
        self.lock()
            .connection
            .execute_batch(
                "CREATE TEMP TRIGGER fail_unregister_project
                 BEFORE UPDATE OF registered ON projects
                 WHEN NEW.registered = 0
                 BEGIN
                   SELECT RAISE(ABORT, 'test unregister failure');
                 END;",
            )
            .map_err(|_| history_error("HIST-TEST-UNREGISTER-FAILURE", false))
    }

    pub fn register_candidate(
        &self,
        candidate: &ValidatedWorkspaceCandidate,
    ) -> Result<PersistedWorkspaceRegistration, WorkspaceHistoryError> {
        self.ensure_writable("workspace.pick_register")?;
        let mut inner = self.lock();
        let transaction = inner
            .connection
            .transaction()
            .map_err(|_| history_error("HIST-TRANSACTION-BEGIN", true))?;
        let root_bytes = path_to_bytes(&candidate.git.canonical_root);

        if let Some(existing) = project_linkage_at_root(&transaction, &root_bytes)? {
            if !existing.matches(&candidate.git) {
                if existing.registered {
                    return Err(history_error("WORKSPACE-PROJECT-IDENTITY-CHANGED", false));
                }
                move_unregistered_project_to_private_root(&transaction, &existing.project_id)?;
            } else {
                let existing_id = existing.workspace_id;
                let now = now();
                transaction
                    .execute(
                        "UPDATE projects SET registered = 1, alias = ?1,
                           branch = ?2, head = ?3, detached = ?4, health = 'ready', updated_at = ?5
                         WHERE id = ?6",
                        params![
                            candidate.registration.alias,
                            candidate.git.branch,
                            candidate.git.head,
                            i64::from(candidate.git.detached),
                            now,
                            existing.project_id,
                        ],
                    )
                    .map_err(|_| history_error("HIST-PROJECT-UPDATE", true))?;
                transaction
                    .execute(
                        "UPDATE workspaces SET health = 'ready', updated_at = ?1
                         WHERE project_id = ?2",
                        params![now, existing.project_id],
                    )
                    .map_err(|_| history_error("HIST-WORKSPACE-UPDATE", true))?;
                let workspace = workspace_by_id(&transaction, &existing_id)?;
                let private_record = private_workspace_by_id(&transaction, &existing_id)?;
                transaction
                    .commit()
                    .map_err(|_| history_error("HIST-TRANSACTION-COMMIT", true))?;
                return Ok(PersistedWorkspaceRegistration {
                    workspace,
                    private_record,
                    duplicate: true,
                });
            }
        }

        if let Some(existing) = project_linkage_by_identity(&transaction, &candidate.git)? {
            if existing.registered {
                return Err(history_error("WORKSPACE-PROJECT-ALREADY-REGISTERED", false));
            }
            let now = now();
            transaction
                .execute(
                    "UPDATE projects SET canonical_root = ?1, registered = 1, alias = ?2,
                       branch = ?3, head = ?4, detached = ?5, health = 'ready', updated_at = ?6
                     WHERE id = ?7",
                    params![
                        root_bytes,
                        candidate.registration.alias,
                        candidate.git.branch,
                        candidate.git.head,
                        i64::from(candidate.git.detached),
                        now,
                        existing.project_id,
                    ],
                )
                .map_err(|_| history_error("HIST-PROJECT-UPDATE", true))?;
            transaction
                .execute(
                    "UPDATE workspaces SET health = 'ready', updated_at = ?1
                     WHERE project_id = ?2",
                    params![now, existing.project_id],
                )
                .map_err(|_| history_error("HIST-WORKSPACE-UPDATE", true))?;
            let workspace = workspace_by_id(&transaction, &existing.workspace_id)?;
            let private_record = private_workspace_by_id(&transaction, &existing.workspace_id)?;
            transaction
                .commit()
                .map_err(|_| history_error("HIST-TRANSACTION-COMMIT", true))?;
            return Ok(PersistedWorkspaceRegistration {
                workspace,
                private_record,
                duplicate: true,
            });
        }
        ensure_workspace_capacity(&transaction)?;

        let now = now();
        let project_id = format!("project-{}", uuid::Uuid::new_v4());
        let workspace_id = candidate.registration.workspace_id.clone();
        let session_id = format!("session-{}", uuid::Uuid::new_v4());
        transaction
            .execute(
                "INSERT INTO projects (
                   id, canonical_root, alias, project_identity, root_device, root_inode,
                   git_device, git_inode, branch, head, detached, health, created_at, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'ready', ?12, ?12)",
                params![
                    project_id,
                    root_bytes,
                    candidate.registration.alias,
                    candidate.git.project_identity,
                    candidate.git.root_device as i64,
                    candidate.git.root_inode as i64,
                    candidate.git.git_device as i64,
                    candidate.git.git_inode as i64,
                    candidate.git.branch,
                    candidate.git.head,
                    i64::from(candidate.git.detached),
                    now,
                ],
            )
            .map_err(|_| history_error("HIST-PROJECT-INSERT", true))?;
        transaction
            .execute(
                "INSERT INTO workspaces (
                   id, project_id, name, goal, lifecycle, attention, health,
                   created_at, updated_at, last_selected_at
                 ) VALUES (?1, ?2, ?3, '', 'backlog', NULL, 'ready', ?4, ?4, NULL)",
                params![workspace_id, project_id, candidate.registration.alias, now],
            )
            .map_err(|_| history_error("HIST-WORKSPACE-INSERT", true))?;
        transaction
            .execute(
                "INSERT INTO sessions (id, workspace_id, client_request_id, status, created_at, updated_at)
                 VALUES (?1, ?2, NULL, 'idle', ?3, ?3)",
                params![session_id, workspace_id, now],
            )
            .map_err(|_| history_error("HIST-SESSION-INSERT", true))?;
        transaction
            .execute(
                "INSERT INTO workspace_preferences (workspace_id, draft_text, effort, draft_revision, updated_at)
                 VALUES (?1, '', 'fast', 0, ?2)",
                params![workspace_id, now],
            )
            .map_err(|_| history_error("HIST-PREFERENCE-INSERT", true))?;
        insert_default_editable_context(&transaction, &workspace_id, &now)?;
        append_event_in_transaction(
            &transaction,
            &NormalizedDomainEvent {
                schema_version: DOMAIN_EVENT_SCHEMA_VERSION,
                event_id: format!("event-{}", uuid::Uuid::new_v4()),
                workspace_id: workspace_id.clone(),
                session_id: Some(session_id),
                producer: "work".to_owned(),
                kind: "work.workspace.lifecycle.changed".to_owned(),
                occurred_at: now.clone(),
                payload: json!({ "lifecycle": "backlog" }),
            },
            Some(&candidate.git.canonical_root),
        )?;
        let workspace = workspace_by_id(&transaction, &workspace_id)?;
        let private_record = AppPrivateWorkspaceRecord {
            workspace_id: workspace_id.clone(),
            alias: candidate.registration.alias.clone(),
            canonical_root: candidate.git.canonical_root.clone(),
        };
        transaction
            .commit()
            .map_err(|_| history_error("HIST-TRANSACTION-COMMIT", true))?;

        Ok(PersistedWorkspaceRegistration {
            workspace,
            private_record,
            duplicate: false,
        })
    }

    pub fn rollback_registration(&self, workspace_id: &str) -> Result<(), WorkspaceHistoryError> {
        self.ensure_writable("workspace.pick_register.rollback")?;
        let mut inner = self.lock();
        let transaction = inner
            .connection
            .transaction()
            .map_err(|_| history_error("HIST-TRANSACTION-BEGIN", true))?;
        let project_id = transaction
            .query_row(
                "SELECT project_id FROM workspaces WHERE id = ?1",
                params![workspace_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|_| history_error("HIST-WORKSPACE-LOOKUP", true))?;
        transaction
            .execute(
                "DELETE FROM workspaces WHERE id = ?1",
                params![workspace_id],
            )
            .map_err(|_| history_error("HIST-WORKSPACE-DELETE", true))?;
        let active_workspace_id = transaction
            .query_row(
                "SELECT value FROM settings WHERE key = 'active_workspace_id'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|_| history_error("HIST-SETTING-READ", true))?;
        if active_workspace_id.as_deref() == Some(workspace_id) {
            let fallback_workspace_id = transaction
                .query_row(
                    "SELECT id FROM workspaces
                     ORDER BY last_selected_at DESC, updated_at DESC, id ASC LIMIT 1",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(|_| history_error("HIST-WORKSPACE-LOOKUP", true))?;
            if let Some(fallback_workspace_id) = fallback_workspace_id {
                set_active_workspace(&transaction, &fallback_workspace_id)?;
            } else {
                transaction
                    .execute("DELETE FROM settings WHERE key = 'active_workspace_id'", [])
                    .map_err(|_| history_error("HIST-SETTING-WRITE", true))?;
            }
        }
        if let Some(project_id) = project_id {
            transaction
                .execute(
                    "DELETE FROM projects WHERE id = ?1 AND NOT EXISTS (
                       SELECT 1 FROM workspaces WHERE project_id = ?1
                     )",
                    params![project_id],
                )
                .map_err(|_| history_error("HIST-PROJECT-DELETE", true))?;
        }
        transaction
            .commit()
            .map_err(|_| history_error("HIST-TRANSACTION-COMMIT", true))
    }

    pub fn private_workspace_records(
        &self,
    ) -> Result<Vec<AppPrivateWorkspaceRecord>, WorkspaceHistoryError> {
        let inner = self.lock();
        let mut statement = inner
            .connection
            .prepare(
                "SELECT w.id, p.alias, p.canonical_root
                 FROM workspaces w JOIN projects p ON p.id = w.project_id
                 WHERE p.registered = 1
                 ORDER BY w.created_at ASC",
            )
            .map_err(|_| history_error("HIST-WORKSPACE-QUERY", true))?;
        let rows = statement
            .query_map([], |row| {
                let bytes = row.get::<_, Vec<u8>>(2)?;
                Ok(AppPrivateWorkspaceRecord {
                    workspace_id: row.get(0)?,
                    alias: row.get(1)?,
                    canonical_root: path_from_bytes(bytes),
                })
            })
            .map_err(|_| history_error("HIST-WORKSPACE-QUERY", true))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|_| history_error("HIST-WORKSPACE-DECODE", false))
    }

    pub fn private_workspace_record(
        &self,
        workspace_id: &str,
    ) -> Result<AppPrivateWorkspaceRecord, WorkspaceHistoryError> {
        validate_workspace_id(workspace_id)?;
        let inner = self.lock();
        private_workspace_by_id(&inner.connection, workspace_id)
    }

    pub fn private_project_workspace_records(
        &self,
        workspace_id: &str,
    ) -> Result<Vec<AppPrivateWorkspaceRecord>, WorkspaceHistoryError> {
        validate_workspace_id(workspace_id)?;
        let inner = self.lock();
        let mut statement = inner
            .connection
            .prepare(
                "SELECT sibling.id, p.alias, p.canonical_root
                 FROM workspaces selected
                 JOIN projects p ON p.id = selected.project_id
                 JOIN workspaces sibling ON sibling.project_id = p.id
                 WHERE selected.id = ?1 AND p.registered = 1
                 ORDER BY sibling.created_at ASC",
            )
            .map_err(|_| history_error("HIST-WORKSPACE-QUERY", true))?;
        let rows = statement
            .query_map(params![workspace_id], |row| {
                Ok(AppPrivateWorkspaceRecord {
                    workspace_id: row.get(0)?,
                    alias: row.get(1)?,
                    canonical_root: path_from_bytes(row.get::<_, Vec<u8>>(2)?),
                })
            })
            .map_err(|_| history_error("HIST-WORKSPACE-QUERY", true))?;
        let records = rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| history_error("HIST-WORKSPACE-DECODE", false))?;
        if records.is_empty() {
            return Err(history_error("WORKSPACE-NOT-FOUND", false));
        }
        Ok(records)
    }

    pub fn private_project_identity(
        &self,
        workspace_id: &str,
    ) -> Result<AppPrivateProjectIdentity, WorkspaceHistoryError> {
        validate_workspace_id(workspace_id)?;
        let inner = self.lock();
        let linkage = inner
            .connection
            .query_row(
                "SELECT p.id, w.id, p.canonical_root, p.registered, p.project_identity,
                        p.root_device, p.root_inode, p.git_device, p.git_inode
                 FROM workspaces w JOIN projects p ON p.id = w.project_id
                 WHERE w.id = ?1 AND p.registered = 1",
                params![workspace_id],
                decode_project_linkage,
            )
            .optional()
            .map_err(|_| history_error("HIST-PROJECT-LOOKUP", true))?
            .ok_or_else(|| history_error("WORKSPACE-NOT-FOUND", false))?;
        Ok(linkage.private_identity())
    }

    pub fn repair_project(
        &self,
        workspace_id: &str,
        expected: &AppPrivateProjectIdentity,
        candidate: &ValidatedWorkspaceCandidate,
    ) -> Result<WorkspaceStateSnapshot, WorkspaceHistoryError> {
        validate_workspace_id(workspace_id)?;
        self.ensure_writable("workspace.repair")?;
        let mut inner = self.lock();
        let transaction = inner
            .connection
            .transaction()
            .map_err(|_| history_error("HIST-TRANSACTION-BEGIN", true))?;
        let current = transaction
            .query_row(
                "SELECT p.id, w.id, p.canonical_root, p.registered, p.project_identity,
                        p.root_device, p.root_inode, p.git_device, p.git_inode
                 FROM workspaces w JOIN projects p ON p.id = w.project_id
                 WHERE w.id = ?1 AND p.registered = 1",
                params![workspace_id],
                decode_project_linkage,
            )
            .optional()
            .map_err(|_| history_error("HIST-PROJECT-LOOKUP", true))?
            .ok_or_else(|| history_error("WORKSPACE-NOT-FOUND", false))?;
        if current.private_identity() != *expected {
            return Err(history_error("WORKSPACE-REPAIR-LINKAGE-STALE", true));
        }
        if !matches_saved_repository_identity(&candidate.git, expected) {
            return Err(history_error("WORKSPACE-REPAIR-IDENTITY-CHANGED", false));
        }
        let project_id = current.project_id;
        let root_bytes = path_to_bytes(&candidate.git.canonical_root);
        let root_owner = transaction
            .query_row(
                "SELECT id, registered FROM projects WHERE canonical_root = ?1 AND id != ?2",
                params![root_bytes, project_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? != 0)),
            )
            .optional()
            .map_err(|_| history_error("HIST-PROJECT-LOOKUP", true))?;
        if let Some((owner_id, registered)) = root_owner {
            if registered {
                return Err(history_error("WORKSPACE-REPAIR-ROOT-IN-USE", false));
            }
            move_unregistered_project_to_private_root(&transaction, &owner_id)?;
        }
        let updated_at = now();
        transaction
            .execute(
                "UPDATE projects SET canonical_root = ?1, alias = ?2,
                   branch = ?3, head = ?4, detached = ?5, health = 'ready',
                   registered = 1, updated_at = ?6 WHERE id = ?7",
                params![
                    root_bytes,
                    candidate.registration.alias,
                    candidate.git.branch,
                    candidate.git.head,
                    i64::from(candidate.git.detached),
                    updated_at,
                    project_id,
                ],
            )
            .map_err(|_| history_error("HIST-PROJECT-UPDATE", true))?;
        transaction
            .execute(
                "UPDATE workspaces SET health = 'ready', updated_at = ?1 WHERE project_id = ?2",
                params![updated_at, project_id],
            )
            .map_err(|_| history_error("HIST-WORKSPACE-UPDATE", true))?;
        set_active_workspace(&transaction, workspace_id)?;
        transaction
            .commit()
            .map_err(|_| history_error("HIST-TRANSACTION-COMMIT", true))?;
        drop(inner);
        self.snapshot(Some(workspace_id))
    }

    pub fn unregister_project(
        &self,
        workspace_id: &str,
    ) -> Result<WorkspaceStateSnapshot, WorkspaceHistoryError> {
        validate_workspace_id(workspace_id)?;
        self.ensure_writable("workspace.unregister")?;
        let mut inner = self.lock();
        let transaction = inner
            .connection
            .transaction()
            .map_err(|_| history_error("HIST-TRANSACTION-BEGIN", true))?;
        let project_id = transaction
            .query_row(
                "SELECT p.id FROM workspaces w JOIN projects p ON p.id = w.project_id
                 WHERE w.id = ?1 AND p.registered = 1",
                params![workspace_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|_| history_error("HIST-PROJECT-LOOKUP", true))?
            .ok_or_else(|| history_error("WORKSPACE-NOT-FOUND", false))?;
        transaction
            .execute(
                "UPDATE projects SET registered = 0, canonical_root = ?1, updated_at = ?2
                 WHERE id = ?3",
                params![private_unregistered_root(&project_id), now(), project_id],
            )
            .map_err(|_| history_error("HIST-PROJECT-UPDATE", true))?;
        let active_workspace_id = active_workspace(&transaction)?;
        let active_belongs_to_project = active_workspace_id.as_deref().is_some_and(|active_id| {
            transaction
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM workspaces WHERE id = ?1 AND project_id = ?2)",
                    params![active_id, project_id],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap_or(0)
                != 0
        });
        if active_belongs_to_project {
            let fallback_workspace_id = transaction
                .query_row(
                    "SELECT w.id FROM workspaces w JOIN projects p ON p.id = w.project_id
                     WHERE p.registered = 1
                     ORDER BY w.last_selected_at DESC, w.updated_at DESC, w.id ASC LIMIT 1",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(|_| history_error("HIST-WORKSPACE-LOOKUP", true))?;
            if let Some(fallback_workspace_id) = fallback_workspace_id {
                set_active_workspace(&transaction, &fallback_workspace_id)?;
            } else {
                transaction
                    .execute("DELETE FROM settings WHERE key = 'active_workspace_id'", [])
                    .map_err(|_| history_error("HIST-SETTING-WRITE", true))?;
            }
        }
        transaction
            .commit()
            .map_err(|_| history_error("HIST-TRANSACTION-COMMIT", true))?;
        drop(inner);
        self.snapshot(None)
    }

    pub fn create_session_workspace(
        &self,
        from_workspace_id: &str,
        name: &str,
        goal: &str,
        client_request_id: &str,
    ) -> Result<PersistedSessionWorkspace, WorkspaceHistoryError> {
        validate_workspace_id(from_workspace_id)?;
        validate_client_request_id(client_request_id)?;
        let name = validate_workspace_name(name)?;
        let goal = validate_goal(goal)?;
        self.ensure_writable("workspace.create_session")?;
        let mut inner = self.lock();
        let transaction = inner
            .connection
            .transaction()
            .map_err(|_| history_error("HIST-TRANSACTION-BEGIN", true))?;

        if let Some(existing_workspace_id) = transaction
            .query_row(
                "SELECT workspace_id FROM sessions WHERE client_request_id = ?1",
                params![client_request_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|_| history_error("HIST-SESSION-LOOKUP", true))?
        {
            let workspace = workspace_by_id(&transaction, &existing_workspace_id)?;
            let private_record = private_workspace_by_id(&transaction, &existing_workspace_id)?;
            return Ok(PersistedSessionWorkspace {
                workspace,
                private_record,
                created: false,
            });
        }
        ensure_workspace_capacity(&transaction)?;

        let project_id = transaction
            .query_row(
                "SELECT project_id FROM workspaces WHERE id = ?1",
                params![from_workspace_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|_| history_error("HIST-WORKSPACE-LOOKUP", true))?
            .ok_or_else(|| history_error("WORKSPACE-NOT-FOUND", false))?;
        let workspace_id = format!("workspace-{}", uuid::Uuid::new_v4());
        let session_id = format!("session-{}", uuid::Uuid::new_v4());
        let now = now();
        transaction
            .execute(
                "INSERT INTO workspaces (
                   id, project_id, name, goal, lifecycle, attention, health,
                   created_at, updated_at, last_selected_at
                 ) VALUES (?1, ?2, ?3, ?4, 'backlog', NULL, 'ready', ?5, ?5, NULL)",
                params![workspace_id, project_id, name, goal, now],
            )
            .map_err(|_| history_error("HIST-WORKSPACE-INSERT", true))?;
        transaction
            .execute(
                "INSERT INTO sessions (id, workspace_id, client_request_id, status, created_at, updated_at)
                 VALUES (?1, ?2, ?3, 'idle', ?4, ?4)",
                params![session_id, workspace_id, client_request_id, now],
            )
            .map_err(|_| history_error("HIST-SESSION-INSERT", true))?;
        transaction
            .execute(
                "INSERT INTO workspace_preferences (workspace_id, draft_text, effort, draft_revision, updated_at)
                 VALUES (?1, ?2, 'fast', 0, ?3)",
                params![workspace_id, goal, now],
            )
            .map_err(|_| history_error("HIST-PREFERENCE-INSERT", true))?;
        insert_default_editable_context(&transaction, &workspace_id, &now)?;
        append_event_in_transaction(
            &transaction,
            &NormalizedDomainEvent {
                schema_version: DOMAIN_EVENT_SCHEMA_VERSION,
                event_id: format!("event-{}", uuid::Uuid::new_v4()),
                workspace_id: workspace_id.clone(),
                session_id: Some(session_id),
                producer: "work".to_owned(),
                kind: "work.workspace.lifecycle.changed".to_owned(),
                occurred_at: now,
                payload: json!({ "lifecycle": "backlog" }),
            },
            None,
        )?;
        let workspace = workspace_by_id(&transaction, &workspace_id)?;
        let private_record = private_workspace_by_id(&transaction, &workspace_id)?;
        transaction
            .commit()
            .map_err(|_| history_error("HIST-TRANSACTION-COMMIT", true))?;
        Ok(PersistedSessionWorkspace {
            workspace,
            private_record,
            created: true,
        })
    }

    pub fn select_workspace(
        &self,
        workspace_id: &str,
    ) -> Result<WorkspaceStateSnapshot, WorkspaceHistoryError> {
        validate_workspace_id(workspace_id)?;
        self.ensure_writable("workspace.select")?;
        let mut inner = self.lock();
        let transaction = inner
            .connection
            .transaction()
            .map_err(|_| history_error("HIST-TRANSACTION-BEGIN", true))?;
        workspace_by_id(&transaction, workspace_id)?;
        set_active_workspace(&transaction, workspace_id)?;
        transaction
            .commit()
            .map_err(|_| history_error("HIST-TRANSACTION-COMMIT", true))?;
        drop(inner);
        self.snapshot(Some(workspace_id))
    }

    pub fn update_lifecycle(
        &self,
        workspace_id: &str,
        lifecycle: WorkspaceLifecycle,
        expected_updated_at: &str,
    ) -> Result<WorkspaceSummary, WorkspaceHistoryError> {
        validate_workspace_id(workspace_id)?;
        validate_timestamp(expected_updated_at)?;
        self.ensure_writable("workspace.update_lifecycle")?;
        let mut inner = self.lock();
        let transaction = inner
            .connection
            .transaction()
            .map_err(|_| history_error("HIST-TRANSACTION-BEGIN", true))?;
        let now = now();
        let changed = transaction
            .execute(
                "UPDATE workspaces SET lifecycle = ?1, updated_at = ?2
                 WHERE id = ?3 AND updated_at = ?4",
                params![lifecycle.as_str(), now, workspace_id, expected_updated_at],
            )
            .map_err(|_| history_error("HIST-WORKSPACE-UPDATE", true))?;
        if changed != 1 {
            return Err(history_error("WORKSPACE-REVISION-CONFLICT", true));
        }
        append_event_in_transaction(
            &transaction,
            &NormalizedDomainEvent {
                schema_version: DOMAIN_EVENT_SCHEMA_VERSION,
                event_id: format!("event-{}", uuid::Uuid::new_v4()),
                workspace_id: workspace_id.to_owned(),
                session_id: None,
                producer: "work".to_owned(),
                kind: "work.workspace.lifecycle.changed".to_owned(),
                occurred_at: now,
                payload: json!({ "lifecycle": lifecycle.as_str() }),
            },
            None,
        )?;
        let workspace = workspace_by_id(&transaction, workspace_id)?;
        transaction
            .commit()
            .map_err(|_| history_error("HIST-TRANSACTION-COMMIT", true))?;
        Ok(workspace)
    }

    pub fn save_draft(
        &self,
        workspace_id: &str,
        text: &str,
        effort: ReasoningEffort,
        expected_revision: u64,
    ) -> Result<WorkspaceDraftView, WorkspaceHistoryError> {
        validate_workspace_id(workspace_id)?;
        if text.chars().count() > 32_000 || text.contains('\0') {
            return Err(history_error("WORKSPACE-DRAFT-INVALID", false));
        }
        let redacted = redact_text(text, None, 128 * 1024);
        if redacted != text {
            return Err(history_error("WORKSPACE-DRAFT-REDACTION-REQUIRED", true));
        }
        self.ensure_writable("workspace.save_draft")?;
        let inner = self.lock();
        let now = now();
        let changed = inner
            .connection
            .execute(
                "UPDATE workspace_preferences
                 SET draft_text = ?1, effort = ?2, draft_revision = draft_revision + 1, updated_at = ?3
                 WHERE workspace_id = ?4 AND draft_revision = ?5",
                params![text, effort.as_str(), now, workspace_id, expected_revision as i64],
            )
            .map_err(|_| history_error("HIST-DRAFT-WRITE", true))?;
        if changed != 1 {
            return Err(history_error("WORKSPACE-DRAFT-CONFLICT", true));
        }
        draft_by_workspace(&inner.connection, workspace_id)
    }

    pub fn save_timeline_anchor(
        &self,
        workspace_id: &str,
        event_id: &str,
        sequence: u64,
        offset: i64,
    ) -> Result<WorkspaceTimelineAnchorView, WorkspaceHistoryError> {
        validate_workspace_id(workspace_id)?;
        validate_opaque_id(event_id, "HIST-EVENT-ID")?;
        if sequence == 0
            || sequence > i64::MAX as u64
            || offset.unsigned_abs() > MAX_TIMELINE_ANCHOR_OFFSET as u64
        {
            return Err(history_error("WORKSPACE-TIMELINE-ANCHOR-INVALID", false));
        }
        self.ensure_writable("workspace.save_timeline_anchor")?;
        let mut inner = self.lock();
        let transaction = inner
            .connection
            .transaction()
            .map_err(|_| history_error("HIST-TRANSACTION-BEGIN", true))?;
        let event_exists = transaction
            .query_row(
                "SELECT EXISTS(
                   SELECT 1 FROM domain_events
                   WHERE workspace_id = ?1 AND event_id = ?2 AND sequence = ?3
                 )",
                params![workspace_id, event_id, sequence as i64],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|_| history_error("HIST-EVENT-LOOKUP", true))?
            != 0;
        if !event_exists {
            return Err(history_error("WORKSPACE-TIMELINE-ANCHOR-STALE", true));
        }
        let updated_at = now();
        transaction
            .execute(
                "INSERT INTO workspace_resume_states (
                   workspace_id, timeline_anchor_event_id, timeline_anchor_sequence,
                   timeline_anchor_offset, timeline_anchor_revision, timeline_anchor_updated_at
                 ) VALUES (?1, ?2, ?3, ?4, 1, ?5)
                 ON CONFLICT(workspace_id) DO UPDATE SET
                   timeline_anchor_event_id = excluded.timeline_anchor_event_id,
                   timeline_anchor_sequence = excluded.timeline_anchor_sequence,
                   timeline_anchor_offset = excluded.timeline_anchor_offset,
                   timeline_anchor_revision = workspace_resume_states.timeline_anchor_revision + 1,
                   timeline_anchor_updated_at = excluded.timeline_anchor_updated_at",
                params![workspace_id, event_id, sequence as i64, offset, updated_at],
            )
            .map_err(|_| history_error("HIST-TIMELINE-ANCHOR-WRITE", true))?;
        let anchor = timeline_anchor_by_workspace(&transaction, workspace_id)?
            .ok_or_else(|| history_error("HIST-TIMELINE-ANCHOR-READ", true))?;
        transaction
            .commit()
            .map_err(|_| history_error("HIST-TRANSACTION-COMMIT", true))?;
        Ok(anchor)
    }

    pub fn load_editable_context(
        &self,
        workspace_id: &str,
    ) -> Result<WorkspaceEditableContext, WorkspaceHistoryError> {
        validate_workspace_id(workspace_id)?;
        let inner = self.lock();
        editable_context_by_workspace(&inner.connection, workspace_id)
    }

    pub(super) fn save_project_context(
        &self,
        workspace_id: &str,
        expected_version: u64,
        context: ProjectContext,
        reference_manifest: Option<ProjectReferenceManifest>,
    ) -> Result<VersionedProjectContext, WorkspaceHistoryError> {
        validate_workspace_id(workspace_id)?;
        let context = normalize_project_context(context, None)?;
        let reference_manifest_json =
            encode_project_reference_manifest(&context, reference_manifest.as_ref())?;
        self.ensure_writable("workspace.save_project_context")?;
        let mut inner = self.lock();
        let transaction = inner
            .connection
            .transaction()
            .map_err(|_| history_error("HIST-TRANSACTION-BEGIN", true))?;
        let current = editable_context_by_workspace(&transaction, workspace_id)?;
        if current.project.version != expected_version {
            return Err(history_error("WORKSPACE-PROJECT-CONTEXT-CONFLICT", true));
        }
        let project_json = canonical_json(&context)?;
        let project_hash = content_hash(&project_json);
        let updated_at = now();
        let changed = transaction
            .execute(
                "UPDATE workspace_contexts
                 SET project_json = ?1, project_version = project_version + 1,
                     project_hash = ?2, project_updated_at = ?3,
                     project_reference_manifest_json = ?4
                 WHERE workspace_id = ?5 AND project_version = ?6",
                params![
                    project_json,
                    project_hash,
                    updated_at,
                    reference_manifest_json,
                    workspace_id,
                    expected_version as i64,
                ],
            )
            .map_err(|_| history_error("HIST-PROJECT-CONTEXT-WRITE", true))?;
        if changed != 1 {
            return Err(history_error("WORKSPACE-PROJECT-CONTEXT-CONFLICT", true));
        }
        let saved = editable_context_by_workspace(&transaction, workspace_id)?.project;
        transaction
            .commit()
            .map_err(|_| history_error("HIST-TRANSACTION-COMMIT", true))?;
        Ok(saved)
    }

    pub fn save_character_context(
        &self,
        workspace_id: &str,
        expected_version: u64,
        context: CharacterContext,
    ) -> Result<VersionedCharacterContext, WorkspaceHistoryError> {
        validate_workspace_id(workspace_id)?;
        let context = normalize_character_context(context)?;
        self.ensure_writable("workspace.save_character_context")?;
        let mut inner = self.lock();
        let transaction = inner
            .connection
            .transaction()
            .map_err(|_| history_error("HIST-TRANSACTION-BEGIN", true))?;
        let current = editable_context_by_workspace(&transaction, workspace_id)?;
        if current.character.version != expected_version {
            return Err(history_error("WORKSPACE-CHARACTER-CONTEXT-CONFLICT", true));
        }
        let character_json = canonical_json(&context)?;
        let character_hash = content_hash(&character_json);
        let updated_at = now();
        let changed = transaction
            .execute(
                "UPDATE workspace_contexts
                 SET character_json = ?1, character_version = character_version + 1,
                     character_hash = ?2, character_updated_at = ?3
                 WHERE workspace_id = ?4 AND character_version = ?5",
                params![
                    character_json,
                    character_hash,
                    updated_at,
                    workspace_id,
                    expected_version as i64,
                ],
            )
            .map_err(|_| history_error("HIST-CHARACTER-CONTEXT-WRITE", true))?;
        if changed != 1 {
            return Err(history_error("WORKSPACE-CHARACTER-CONTEXT-CONFLICT", true));
        }
        let saved = editable_context_by_workspace(&transaction, workspace_id)?.character;
        transaction
            .commit()
            .map_err(|_| history_error("HIST-TRANSACTION-COMMIT", true))?;
        Ok(saved)
    }

    pub(super) fn turn_context_snapshot(
        &self,
        workspace_id: &str,
        reference_validation: &ProjectReferenceValidation,
    ) -> Result<WorkspaceTurnContextSnapshot, WorkspaceHistoryError> {
        validate_workspace_id(workspace_id)?;
        let mut inner = self.lock();
        let transaction = inner
            .connection
            .transaction()
            .map_err(|_| history_error("HIST-TRANSACTION-BEGIN", true))?;
        let bundle = editable_context_by_workspace(&transaction, workspace_id)?;
        let reference_manifest_json =
            project_reference_manifest_by_workspace(&transaction, workspace_id)?;
        validate_project_reference_manifest(
            &bundle.project.context,
            reference_manifest_json.as_deref(),
            reference_validation,
        )?;
        let snapshot_hash = snapshot_hash(
            bundle.project.version,
            &bundle.project.content_hash,
            bundle.character.version,
            &bundle.character.content_hash,
        )?;
        let snapshot = WorkspaceTurnContextSnapshot {
            schema_version: WORKSPACE_CONTEXT_SCHEMA_VERSION,
            workspace_id: workspace_id.to_owned(),
            project_version: bundle.project.version,
            project_hash: bundle.project.content_hash,
            character_version: bundle.character.version,
            character_hash: bundle.character.content_hash,
            snapshot_hash,
            captured_at: now(),
            project: bundle.project.context,
            character: bundle.character.context,
        };
        validate_turn_snapshot(&snapshot)?;
        transaction
            .commit()
            .map_err(|_| history_error("HIST-TRANSACTION-COMMIT", true))?;
        Ok(snapshot)
    }

    pub fn save_context_snapshot(
        &self,
        workspace_id: &str,
        source: ContextSource,
        label: &str,
        content: &str,
    ) -> Result<ContextSnapshotView, WorkspaceHistoryError> {
        validate_workspace_id(workspace_id)?;
        let label = validate_label(label)?;
        if content.len() > MAX_CONTEXT_BYTES || content.contains('\0') {
            return Err(history_error("WORKSPACE-CONTEXT-TOO-LARGE", false));
        }
        self.ensure_writable("workspace.save_context")?;
        let mut inner = self.lock();
        let transaction = inner
            .connection
            .transaction()
            .map_err(|_| history_error("HIST-TRANSACTION-BEGIN", true))?;
        let root = private_root_by_workspace(&transaction, workspace_id)?;
        let redacted_label = redact_text(&label, Some(&root), 512);
        let redacted_content = redact_text(content, Some(&root), MAX_CONTEXT_BYTES);
        let mut hasher = Sha256::new();
        hasher.update(redacted_content.as_bytes());
        let content_hash = hex::encode(hasher.finalize());
        let snapshot_id = format!("context-{}", uuid::Uuid::new_v4());
        let captured_at = now();
        transaction
            .execute(
                "INSERT INTO context_snapshots (
                   id, workspace_id, source, label, captured_at, byte_count,
                   content_redacted, content_hash, schema_version
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    snapshot_id,
                    workspace_id,
                    source.as_str(),
                    redacted_label,
                    captured_at,
                    redacted_content.len() as i64,
                    redacted_content,
                    content_hash,
                    WORKSPACE_HISTORY_SCHEMA_VERSION,
                ],
            )
            .map_err(|_| history_error("HIST-CONTEXT-WRITE", true))?;
        transaction
            .execute(
                "DELETE FROM context_snapshots WHERE workspace_id = ?1 AND id NOT IN (
                   SELECT id FROM context_snapshots WHERE workspace_id = ?1
                   ORDER BY captured_at DESC, id DESC LIMIT 10
                 )",
                params![workspace_id],
            )
            .map_err(|_| history_error("HIST-CONTEXT-BOUND", true))?;
        let view = context_by_id(&transaction, &snapshot_id)?;
        transaction
            .commit()
            .map_err(|_| history_error("HIST-TRANSACTION-COMMIT", true))?;
        Ok(view)
    }

    pub fn append_event(
        &self,
        event: &NormalizedDomainEvent,
    ) -> Result<AppendEventResult, WorkspaceHistoryError> {
        self.ensure_writable("history.append_event")?;
        let mut inner = self.lock();
        let transaction = inner
            .connection
            .transaction()
            .map_err(|_| history_error("HIST-TRANSACTION-BEGIN", true))?;
        let root = private_root_by_workspace(&transaction, &event.workspace_id)?;
        let result = append_event_in_transaction(&transaction, event, Some(&root))?;
        transaction
            .commit()
            .map_err(|_| history_error("HIST-TRANSACTION-COMMIT", true))?;
        Ok(result)
    }

    pub fn timeline(
        &self,
        workspace_id: &str,
        before_sequence: Option<u64>,
        limit: u32,
        search: Option<&str>,
    ) -> Result<TimelinePage, WorkspaceHistoryError> {
        validate_workspace_id(workspace_id)?;
        let limit = limit.clamp(1, MAX_TIMELINE_PAGE);
        let search = search.map(str::trim).filter(|value| !value.is_empty());
        if search.is_some_and(|value| value.chars().count() > 200 || value.contains('\0')) {
            return Err(history_error("HIST-QUERY-INVALID", false));
        }
        let inner = self.lock();
        let mut items = Vec::new();
        let query_limit = i64::from(limit) + 1;
        if let Some(search) = search {
            let pattern = format!("%{}%", escape_like(search));
            let mut statement = inner
                .connection
                .prepare(
                    "SELECT event_id, workspace_id, session_id, sequence, producer, kind,
                            occurred_at, payload_json, schema_version
                     FROM domain_events
                     WHERE workspace_id = ?1 AND (?2 IS NULL OR sequence < ?2)
                       AND (kind LIKE ?3 ESCAPE '\\' OR payload_json LIKE ?3 ESCAPE '\\')
                     ORDER BY sequence DESC LIMIT ?4",
                )
                .map_err(|_| history_error("HIST-QUERY-PREPARE", true))?;
            let rows = statement
                .query_map(
                    params![
                        workspace_id,
                        before_sequence.map(|value| value as i64),
                        pattern,
                        query_limit
                    ],
                    decode_event_row,
                )
                .map_err(|_| history_error("HIST-QUERY", true))?;
            items.extend(
                rows.collect::<Result<Vec<_>, _>>()
                    .map_err(|_| history_error("HIST-EVENT-DECODE", false))?,
            );
        } else {
            let mut statement = inner
                .connection
                .prepare(
                    "SELECT event_id, workspace_id, session_id, sequence, producer, kind,
                            occurred_at, payload_json, schema_version
                     FROM domain_events
                     WHERE workspace_id = ?1 AND (?2 IS NULL OR sequence < ?2)
                     ORDER BY sequence DESC LIMIT ?3",
                )
                .map_err(|_| history_error("HIST-QUERY-PREPARE", true))?;
            let rows = statement
                .query_map(
                    params![
                        workspace_id,
                        before_sequence.map(|value| value as i64),
                        query_limit
                    ],
                    decode_event_row,
                )
                .map_err(|_| history_error("HIST-QUERY", true))?;
            items.extend(
                rows.collect::<Result<Vec<_>, _>>()
                    .map_err(|_| history_error("HIST-EVENT-DECODE", false))?,
            );
        }
        let has_more = items.len() > limit as usize;
        items.truncate(limit as usize);
        items.reverse();
        let next_before_sequence = if has_more {
            items.first().map(|item| item.sequence)
        } else {
            None
        };
        Ok(TimelinePage {
            schema_version: WORKSPACE_HISTORY_SCHEMA_VERSION,
            items,
            next_before_sequence,
        })
    }

    pub fn snapshot(
        &self,
        selected_workspace_id: Option<&str>,
    ) -> Result<WorkspaceStateSnapshot, WorkspaceHistoryError> {
        let status = self.status();
        let inner = self.lock();
        let workspaces = all_workspaces(&inner.connection)?;
        let active_workspace_id = selected_workspace_id
            .map(str::to_owned)
            .or_else(|| active_workspace(&inner.connection).ok().flatten())
            .filter(|id| {
                workspaces
                    .iter()
                    .any(|workspace| &workspace.workspace_id == id)
            });
        let draft = active_workspace_id
            .as_deref()
            .map(|id| draft_by_workspace(&inner.connection, id))
            .transpose()?;
        let context_snapshots = active_workspace_id
            .as_deref()
            .map(|id| contexts_by_workspace(&inner.connection, id))
            .transpose()?
            .unwrap_or_default();
        let resume_state = active_workspace_id
            .as_deref()
            .map(|id| resume_state_by_workspace(&inner.connection, id))
            .transpose()?
            .flatten();
        drop(inner);
        let timeline = active_workspace_id
            .as_deref()
            .map(|id| self.timeline(id, None, MAX_TIMELINE_PAGE, None))
            .transpose()?
            .unwrap_or(TimelinePage {
                schema_version: WORKSPACE_HISTORY_SCHEMA_VERSION,
                items: Vec::new(),
                next_before_sequence: None,
            });
        Ok(WorkspaceStateSnapshot {
            schema_version: WORKSPACE_HISTORY_SCHEMA_VERSION,
            history: status,
            workspaces,
            active_workspace_id,
            draft,
            context_snapshots,
            timeline,
            resume_state,
        })
    }

    pub fn update_preflight(
        &self,
        workspace_id: &str,
        result: Result<&GitRepositoryIdentity, WorkspaceHealth>,
    ) -> Result<WorkspaceHealth, WorkspaceHistoryError> {
        self.update_preflight_observation(workspace_id, result, false)
    }

    pub fn accept_preflight(
        &self,
        workspace_id: &str,
        git: &GitRepositoryIdentity,
    ) -> Result<WorkspaceHealth, WorkspaceHistoryError> {
        self.update_preflight_observation(workspace_id, Ok(git), true)
    }

    fn update_preflight_observation(
        &self,
        workspace_id: &str,
        result: Result<&GitRepositoryIdentity, WorkspaceHealth>,
        accept_observed_head: bool,
    ) -> Result<WorkspaceHealth, WorkspaceHistoryError> {
        validate_workspace_id(workspace_id)?;
        self.ensure_writable("workspace.restore_preflight")?;
        let mut inner = self.lock();
        let transaction = inner
            .connection
            .transaction()
            .map_err(|_| history_error("HIST-TRANSACTION-BEGIN", true))?;
        let project_id = transaction
            .query_row(
                "SELECT project_id FROM workspaces WHERE id = ?1",
                params![workspace_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|_| history_error("HIST-WORKSPACE-LOOKUP", true))?
            .ok_or_else(|| history_error("WORKSPACE-NOT-FOUND", false))?;
        let now = now();
        let health = match result {
            Ok(git) => {
                let (
                    prior_identity,
                    prior_root_device,
                    prior_root_inode,
                    prior_git_device,
                    prior_git_inode,
                    prior_branch,
                    prior_head,
                    prior_detached,
                ) = transaction
                    .query_row(
                        "SELECT project_identity, root_device, root_inode,
                                git_device, git_inode, branch, head, detached
                         FROM projects WHERE id = ?1",
                        params![project_id],
                        |row| {
                            Ok((
                                row.get::<_, String>(0)?,
                                row.get::<_, i64>(1)? as u64,
                                row.get::<_, i64>(2)? as u64,
                                row.get::<_, i64>(3)? as u64,
                                row.get::<_, i64>(4)? as u64,
                                row.get::<_, String>(5)?,
                                row.get::<_, String>(6)?,
                                row.get::<_, i64>(7)? != 0,
                            ))
                        },
                    )
                    .map_err(|_| history_error("HIST-PROJECT-LOOKUP", true))?;
                let health = if prior_identity != git.project_identity
                    || prior_root_device != git.root_device
                    || prior_root_inode != git.root_inode
                    || prior_git_device != git.git_device
                    || prior_git_inode != git.git_inode
                {
                    WorkspaceHealth::Changed
                } else if !accept_observed_head
                    && (prior_branch != git.branch
                        || prior_head != git.head
                        || prior_detached != git.detached)
                {
                    WorkspaceHealth::StaleBranch
                } else {
                    WorkspaceHealth::Ready
                };
                if health == WorkspaceHealth::Ready {
                    transaction
                        .execute(
                            "UPDATE projects SET branch = ?1, head = ?2, detached = ?3,
                               health = ?4, updated_at = ?5 WHERE id = ?6",
                            params![
                                git.branch,
                                git.head,
                                i64::from(git.detached),
                                health.as_str(),
                                now,
                                project_id,
                            ],
                        )
                        .map_err(|_| history_error("HIST-PROJECT-UPDATE", true))?;
                } else {
                    transaction
                        .execute(
                            "UPDATE projects SET health = ?1, updated_at = ?2 WHERE id = ?3",
                            params![health.as_str(), now, project_id],
                        )
                        .map_err(|_| history_error("HIST-PROJECT-UPDATE", true))?;
                }
                transaction
                    .execute(
                        "UPDATE workspaces SET health = ?1, updated_at = ?2 WHERE project_id = ?3",
                        params![health.as_str(), now, project_id],
                    )
                    .map_err(|_| history_error("HIST-WORKSPACE-UPDATE", true))?;
                health
            }
            Err(health) => {
                transaction
                    .execute(
                        "UPDATE projects SET health = ?1, updated_at = ?2 WHERE id = ?3",
                        params![health.as_str(), now, project_id],
                    )
                    .map_err(|_| history_error("HIST-PROJECT-UPDATE", true))?;
                transaction
                    .execute(
                        "UPDATE workspaces SET health = ?1, updated_at = ?2 WHERE project_id = ?3",
                        params![health.as_str(), now, project_id],
                    )
                    .map_err(|_| history_error("HIST-WORKSPACE-UPDATE", true))?;
                health
            }
        };
        transaction
            .commit()
            .map_err(|_| history_error("HIST-TRANSACTION-COMMIT", true))?;
        Ok(health)
    }

    pub fn issue_delete_challenge(
        &self,
        workspace_id: &str,
    ) -> Result<DeleteChallenge, WorkspaceHistoryError> {
        validate_workspace_id(workspace_id)?;
        self.ensure_writable("workspace.delete.challenge")?;
        {
            let inner = self.lock();
            workspace_by_id(&inner.connection, workspace_id)?;
        }
        let token = format!("delete-{}", uuid::Uuid::new_v4());
        let expires_at = SystemTime::now() + DELETE_TOKEN_TTL;
        self.delete_challenges
            .lock()
            .expect("delete challenge lock")
            .insert(
                token.clone(),
                DeleteChallengeRecord {
                    workspace_id: workspace_id.to_owned(),
                    expires_at,
                },
            );
        Ok(DeleteChallenge {
            token,
            workspace_id: workspace_id.to_owned(),
            expires_at: (Utc::now() + chrono::Duration::seconds(60))
                .to_rfc3339_opts(SecondsFormat::Millis, true),
        })
    }

    pub fn delete_workspace(
        &self,
        workspace_id: &str,
        token: &str,
    ) -> Result<(), WorkspaceHistoryError> {
        validate_workspace_id(workspace_id)?;
        self.ensure_writable("workspace.delete")?;
        let challenge = self
            .delete_challenges
            .lock()
            .expect("delete challenge lock")
            .remove(token)
            .filter(|challenge| {
                challenge.workspace_id == workspace_id && challenge.expires_at >= SystemTime::now()
            })
            .ok_or_else(|| history_error("WORKSPACE-DELETE-TOKEN-INVALID", false))?;
        drop(challenge);
        self.rollback_registration(workspace_id)
    }

    fn ensure_writable(&self, operation: &str) -> Result<(), WorkspaceHistoryError> {
        if !self.accepting_writes.load(Ordering::Acquire) {
            return Err(WorkspaceHistoryError::new(
                "HIST-SHUTTING-DOWN",
                operation,
                false,
            ));
        }
        if self.status().mode != HistoryMode::Ready {
            Err(WorkspaceHistoryError::new(
                "HIST-READ-ONLY",
                operation,
                true,
            ))
        } else {
            Ok(())
        }
    }

    fn lock(&self) -> MutexGuard<'_, StoreInner> {
        self.inner.lock().expect("workspace history lock poisoned")
    }
}

#[derive(Debug)]
struct OpenFailure {
    code: String,
}

fn open_configured_connection(
    database_path: &Path,
    existed: bool,
) -> Result<(Connection, HistoryStatus), OpenFailure> {
    let (connection, status) = open_configured_connection_with_migrations(
        database_path,
        existed,
        &[
            (1, MIGRATION_1),
            (2, MIGRATION_2),
            (3, MIGRATION_3),
            (4, MIGRATION_4),
            (5, MIGRATION_5),
        ],
    )?;
    if status.mode == HistoryMode::Ready {
        normalize_legacy_project_references(&connection).map_err(|_| OpenFailure {
            code: "HIST-MIGRATION-FAILED".to_owned(),
        })?;
    }
    Ok((connection, status))
}

fn open_configured_connection_with_migrations(
    database_path: &Path,
    existed: bool,
    migrations: &[(i64, &str)],
) -> Result<(Connection, HistoryStatus), OpenFailure> {
    let connection = Connection::open_with_flags(
        database_path,
        OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_CREATE
            | OpenFlags::SQLITE_OPEN_FULL_MUTEX,
    )
    .map_err(|_| OpenFailure {
        code: "HIST-DATABASE-OPEN".to_owned(),
    })?;
    set_private_file_permissions(database_path).map_err(|_| OpenFailure {
        code: "HIST-DATABASE-PERMISSION".to_owned(),
    })?;
    configure_connection(&connection).map_err(|_| OpenFailure {
        code: "HIST-DATABASE-CONFIGURE".to_owned(),
    })?;
    set_private_database_permissions(database_path).map_err(|_| OpenFailure {
        code: "HIST-DATABASE-PERMISSION".to_owned(),
    })?;
    let integrity = connection
        .query_row("PRAGMA quick_check", [], |row| row.get::<_, String>(0))
        .map_err(|_| OpenFailure {
            code: "HIST-DATABASE-CORRUPT".to_owned(),
        })?;
    if integrity != "ok" {
        return Err(OpenFailure {
            code: "HIST-DATABASE-CORRUPT".to_owned(),
        });
    }
    let current_version = connection
        .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
        .map_err(|_| OpenFailure {
            code: "HIST-MIGRATION-VERSION".to_owned(),
        })?;
    if current_version > CURRENT_DATABASE_VERSION {
        return Ok((
            connection,
            HistoryStatus {
                schema_version: WORKSPACE_HISTORY_SCHEMA_VERSION,
                mode: HistoryMode::ReadOnly,
                error_code: Some("HIST-SCHEMA-FUTURE".to_owned()),
                backup_name: None,
            },
        ));
    }
    let backup_name = if existed && current_version < CURRENT_DATABASE_VERSION {
        connection
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
            .map_err(|_| OpenFailure {
                code: "HIST-MIGRATION-CHECKPOINT".to_owned(),
            })?;
        backup_database_files(database_path).map_err(|_| OpenFailure {
            code: "HIST-MIGRATION-BACKUP".to_owned(),
        })?
    } else {
        None
    };
    apply_migrations(&connection, migrations).map_err(|_| OpenFailure {
        code: "HIST-MIGRATION-FAILED".to_owned(),
    })?;
    set_private_database_permissions(database_path).map_err(|_| OpenFailure {
        code: "HIST-DATABASE-PERMISSION".to_owned(),
    })?;
    Ok((
        connection,
        HistoryStatus {
            backup_name,
            ..HistoryStatus::ready()
        },
    ))
}

fn configure_connection(connection: &Connection) -> rusqlite::Result<()> {
    connection.busy_timeout(Duration::from_secs(5))?;
    connection.execute_batch(
        "PRAGMA foreign_keys = ON;
         PRAGMA journal_mode = WAL;
         PRAGMA synchronous = FULL;
         PRAGMA wal_autocheckpoint = 1000;",
    )
}

fn apply_migrations(connection: &Connection, migrations: &[(i64, &str)]) -> rusqlite::Result<()> {
    let current = connection.query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))?;
    for (version, sql) in migrations.iter().filter(|(version, _)| *version > current) {
        let transaction = connection.unchecked_transaction()?;
        transaction.execute_batch(sql)?;
        if *version == 5 {
            backfill_legacy_resume_summaries(&transaction)?;
        }
        transaction.execute(
            "INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?1, ?2)",
            params![version, now()],
        )?;
        transaction.execute_batch(&format!("PRAGMA user_version = {version};"))?;
        transaction.commit()?;
    }
    Ok(())
}

fn backfill_legacy_resume_summaries(transaction: &Transaction<'_>) -> rusqlite::Result<()> {
    let candidates = {
        let mut statement = transaction.prepare(
            "SELECT e.event_id, e.workspace_id, e.session_id, e.sequence,
                    e.occurred_at, e.payload_json, e.schema_version,
                    s.last_summary, s.workspace_id
             FROM domain_events e
             LEFT JOIN sessions s ON s.id = e.session_id
             WHERE e.producer = 'code' AND e.kind = 'code.message.completed'
             ORDER BY e.workspace_id ASC, e.sequence DESC, e.event_id ASC",
        )?;
        let candidates = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, Option<String>>(8)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        candidates
    };
    let mut restored_workspaces = HashSet::new();
    for (
        event_id,
        workspace_id,
        session_id,
        sequence,
        occurred_at,
        payload_json,
        schema_version,
        legacy_session_summary,
        session_workspace_id,
    ) in candidates
    {
        if restored_workspaces.contains(&workspace_id)
            || sequence < 1
            || schema_version != i64::from(DOMAIN_EVENT_SCHEMA_VERSION)
            || payload_json.len() > MAX_EVENT_BYTES
            || (session_id.is_some() && session_workspace_id.as_deref() != Some(&workspace_id))
        {
            continue;
        }
        let Ok(payload) = serde_json::from_str::<Value>(&payload_json) else {
            continue;
        };
        let event = NormalizedDomainEvent {
            schema_version: DOMAIN_EVENT_SCHEMA_VERSION,
            event_id: event_id.clone(),
            workspace_id: workspace_id.clone(),
            session_id,
            producer: "code".to_owned(),
            kind: "code.message.completed".to_owned(),
            occurred_at: occurred_at.clone(),
            payload: payload.clone(),
        };
        if validate_domain_event(&event).is_err() || validate_event_shape(&event, &payload).is_err()
        {
            continue;
        }
        let Some(event_text) = payload.get("text").and_then(Value::as_str) else {
            continue;
        };
        let summary_text = legacy_session_summary
            .as_deref()
            .filter(|summary| *summary == event_text && public_multiline(summary, 64 * 1024, true))
            .unwrap_or(event_text);
        transaction.execute(
            "INSERT INTO workspace_resume_states (
               workspace_id, last_summary_event_id, last_summary_sequence,
               last_summary_text, last_summary_updated_at, timeline_anchor_revision
             ) VALUES (?1, ?2, ?3, ?4, ?5, 0)
             ON CONFLICT(workspace_id) DO UPDATE SET
               last_summary_event_id = excluded.last_summary_event_id,
               last_summary_sequence = excluded.last_summary_sequence,
               last_summary_text = excluded.last_summary_text,
               last_summary_updated_at = excluded.last_summary_updated_at
             WHERE workspace_resume_states.last_summary_event_id IS NULL",
            params![
                event.workspace_id,
                event.event_id,
                sequence,
                summary_text,
                occurred_at
            ],
        )?;
        restored_workspaces.insert(workspace_id);
    }
    Ok(())
}

fn normalize_legacy_project_references(connection: &Connection) -> rusqlite::Result<()> {
    let transaction = connection.unchecked_transaction()?;
    let records = {
        let mut statement = transaction.prepare(
            "SELECT workspace_id, project_json
             FROM workspace_contexts
             WHERE project_reference_manifest_json IS NULL",
        )?;
        let records = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        records
    };
    for (workspace_id, project_json) in records {
        let project = serde_json::from_str::<ProjectContext>(&project_json)
            .map_err(|_| rusqlite::Error::InvalidQuery)?;
        let project =
            normalize_project_context(project, None).map_err(|_| rusqlite::Error::InvalidQuery)?;
        let canonical = canonical_json(&project).map_err(|_| rusqlite::Error::InvalidQuery)?;
        if canonical == project_json {
            continue;
        }
        let hash = content_hash(&canonical);
        transaction.execute(
            "UPDATE workspace_contexts
             SET project_json = ?1, project_hash = ?2
             WHERE workspace_id = ?3 AND project_reference_manifest_json IS NULL",
            params![canonical, hash, workspace_id],
        )?;
    }
    transaction.commit()
}

fn set_active_workspace(
    transaction: &Transaction<'_>,
    workspace_id: &str,
) -> Result<(), WorkspaceHistoryError> {
    let now = now();
    let changed = transaction
        .execute(
            "UPDATE workspaces SET last_selected_at = ?1, updated_at = ?1 WHERE id = ?2",
            params![now, workspace_id],
        )
        .map_err(|_| history_error("HIST-WORKSPACE-SELECT", true))?;
    if changed != 1 {
        return Err(history_error("WORKSPACE-NOT-FOUND", false));
    }
    transaction
        .execute(
            "INSERT INTO settings (key, value, version, updated_at)
             VALUES ('active_workspace_id', ?1, 1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value,
               version = settings.version + 1, updated_at = excluded.updated_at",
            params![workspace_id, now],
        )
        .map_err(|_| history_error("HIST-SETTING-WRITE", true))?;
    Ok(())
}

fn ensure_workspace_capacity(transaction: &Transaction<'_>) -> Result<(), WorkspaceHistoryError> {
    let count = transaction
        .query_row("SELECT COUNT(*) FROM workspaces", [], |row| {
            row.get::<_, i64>(0)
        })
        .map_err(|_| history_error("HIST-WORKSPACE-COUNT", true))?;
    if count >= MAX_WORKSPACES {
        return Err(history_error("WORKSPACE-LIMIT", false));
    }
    Ok(())
}

fn insert_default_editable_context(
    transaction: &Transaction<'_>,
    workspace_id: &str,
    updated_at: &str,
) -> Result<(), WorkspaceHistoryError> {
    transaction
        .execute(
            "INSERT INTO workspace_contexts (
               workspace_id, project_json, project_version, project_hash, project_updated_at,
               character_json, character_version, character_hash, character_updated_at
             ) VALUES (?1, ?2, 1, ?3, ?4, ?5, 1, ?6, ?4)",
            params![
                workspace_id,
                DEFAULT_PROJECT_JSON,
                DEFAULT_PROJECT_HASH,
                updated_at,
                DEFAULT_CHARACTER_JSON,
                DEFAULT_CHARACTER_HASH,
            ],
        )
        .map_err(|_| history_error("HIST-EDITABLE-CONTEXT-INSERT", true))?;
    Ok(())
}

fn editable_context_by_workspace(
    connection: &Connection,
    workspace_id: &str,
) -> Result<WorkspaceEditableContext, WorkspaceHistoryError> {
    let row = connection
        .query_row(
            "SELECT project_json, project_version, project_hash, project_updated_at,
                    character_json, character_version, character_hash, character_updated_at
             FROM workspace_contexts WHERE workspace_id = ?1",
            params![workspace_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                ))
            },
        )
        .optional()
        .map_err(|_| history_error("HIST-EDITABLE-CONTEXT-READ", true))?
        .ok_or_else(|| history_error("WORKSPACE-NOT-FOUND", false))?;
    let (
        project_json,
        project_version,
        project_hash,
        project_updated_at,
        character_json,
        character_version,
        character_hash,
        character_updated_at,
    ) = row;
    if project_version < 1 || character_version < 1 {
        return Err(history_error("HIST-EDITABLE-CONTEXT-CORRUPT", false));
    }
    let project = serde_json::from_str::<ProjectContext>(&project_json)
        .map_err(|_| history_error("HIST-PROJECT-CONTEXT-DECODE", false))?;
    let character = serde_json::from_str::<CharacterContext>(&character_json)
        .map_err(|_| history_error("HIST-CHARACTER-CONTEXT-DECODE", false))?;
    let project = normalize_project_context(project, None)?;
    let character = normalize_character_context(character)?;
    let canonical_project = canonical_json(&project)?;
    let canonical_character = canonical_json(&character)?;
    if canonical_project != project_json
        || content_hash(&canonical_project) != project_hash
        || canonical_character != character_json
        || content_hash(&canonical_character) != character_hash
    {
        return Err(history_error("HIST-EDITABLE-CONTEXT-INTEGRITY", false));
    }
    Ok(WorkspaceEditableContext {
        schema_version: WORKSPACE_CONTEXT_SCHEMA_VERSION,
        workspace_id: workspace_id.to_owned(),
        project: VersionedProjectContext {
            schema_version: WORKSPACE_CONTEXT_SCHEMA_VERSION,
            workspace_id: workspace_id.to_owned(),
            version: project_version as u64,
            content_hash: project_hash,
            updated_at: project_updated_at,
            context: project,
        },
        character: VersionedCharacterContext {
            schema_version: WORKSPACE_CONTEXT_SCHEMA_VERSION,
            workspace_id: workspace_id.to_owned(),
            version: character_version as u64,
            content_hash: character_hash,
            updated_at: character_updated_at,
            context: character,
        },
    })
}

fn project_reference_manifest_by_workspace(
    connection: &Connection,
    workspace_id: &str,
) -> Result<Option<String>, WorkspaceHistoryError> {
    connection
        .query_row(
            "SELECT project_reference_manifest_json
             FROM workspace_contexts WHERE workspace_id = ?1",
            params![workspace_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map_err(|_| history_error("HIST-PROJECT-REFERENCE-MANIFEST-READ", true))?
        .ok_or_else(|| history_error("WORKSPACE-NOT-FOUND", false))
}

fn append_event_in_transaction(
    transaction: &Transaction<'_>,
    event: &NormalizedDomainEvent,
    workspace_root: Option<&Path>,
) -> Result<AppendEventResult, WorkspaceHistoryError> {
    validate_domain_event(event)?;
    if event.producer == "code" {
        // CODE payloads are already a public semantic boundary. Validate the
        // original value so private/control material cannot be hidden by the
        // generic history sanitizer.
        validate_event_shape(event, &event.payload)?;
    }
    let sanitized = sanitize_json(&event.payload, workspace_root, 0)?;
    validate_event_shape(event, &sanitized)?;
    let payload_json =
        serde_json::to_string(&sanitized).map_err(|_| history_error("HIST-EVENT-ENCODE", false))?;
    if payload_json.len() > MAX_EVENT_BYTES {
        return Err(history_error("HIST-EVENT-TOO-LARGE", false));
    }
    if let Some(existing) = transaction
        .query_row(
            "SELECT workspace_id, session_id, sequence, producer, kind, occurred_at,
                    payload_json, schema_version
             FROM domain_events WHERE event_id = ?1",
            params![event.event_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, i64>(7)?,
                ))
            },
        )
        .optional()
        .map_err(|_| history_error("HIST-EVENT-LOOKUP", true))?
    {
        let (
            workspace_id,
            session_id,
            sequence,
            producer,
            kind,
            occurred_at,
            existing_payload_json,
            schema_version,
        ) = existing;
        let is_exact_replay = workspace_id == event.workspace_id
            && session_id == event.session_id
            && producer == event.producer
            && kind == event.kind
            && occurred_at == event.occurred_at
            && existing_payload_json == payload_json
            && schema_version == i64::from(event.schema_version);
        if !is_exact_replay {
            return Err(history_error("HIST-EVENT-IDEMPOTENCY-CONFLICT", false));
        }
        return Ok(AppendEventResult {
            sequence: sequence as u64,
            inserted: false,
        });
    }
    if event.schema_version != DOMAIN_EVENT_SCHEMA_VERSION {
        return Err(history_error("HIST-EVENT-SCHEMA", false));
    }
    if let Some(session_id) = event.session_id.as_deref() {
        let session_workspace_id = transaction
            .query_row(
                "SELECT workspace_id FROM sessions WHERE id = ?1",
                params![session_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|_| history_error("HIST-SESSION-LOOKUP", true))?
            .ok_or_else(|| history_error("HIST-EVENT-SESSION-NOT-FOUND", false))?;
        if session_workspace_id != event.workspace_id {
            return Err(history_error("HIST-EVENT-SESSION-WORKSPACE", false));
        }
    }
    let sequence = transaction
        .query_row(
            "SELECT COALESCE(MAX(sequence), 0) + 1 FROM domain_events WHERE workspace_id = ?1",
            params![event.workspace_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|_| history_error("HIST-SEQUENCE", true))?;
    transaction
        .execute(
            "INSERT INTO domain_events (
               event_id, workspace_id, session_id, sequence, producer, kind,
               occurred_at, payload_json, schema_version, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                event.event_id,
                event.workspace_id,
                event.session_id,
                sequence,
                event.producer,
                event.kind,
                event.occurred_at,
                payload_json,
                event.schema_version,
                now(),
            ],
        )
        .map_err(|_| history_error("HIST-EVENT-WRITE", true))?;
    if event.kind == "code.session.status.changed" {
        if let (Some(session_id), Some(status)) = (
            event.session_id.as_deref(),
            sanitized.get("status").and_then(Value::as_str),
        ) {
            transaction
                .execute(
                    "UPDATE sessions SET status = ?1, updated_at = ?2 WHERE id = ?3",
                    params![status, now(), session_id],
                )
                .map_err(|_| history_error("HIST-SESSION-STATUS-WRITE", true))?;
        }
    }
    if event.producer == "code" && event.kind == "code.message.completed" {
        let text = sanitized
            .get("text")
            .and_then(Value::as_str)
            .ok_or_else(|| history_error("HIST-EVENT-PAYLOAD", false))?;
        transaction
            .execute(
                "INSERT INTO workspace_resume_states (
                   workspace_id, last_summary_event_id, last_summary_sequence,
                   last_summary_text, last_summary_updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(workspace_id) DO UPDATE SET
                   last_summary_event_id = excluded.last_summary_event_id,
                   last_summary_sequence = excluded.last_summary_sequence,
                   last_summary_text = excluded.last_summary_text,
                   last_summary_updated_at = excluded.last_summary_updated_at",
                params![
                    event.workspace_id,
                    event.event_id,
                    sequence,
                    text,
                    event.occurred_at,
                ],
            )
            .map_err(|_| history_error("HIST-LAST-SUMMARY-WRITE", true))?;
        if let Some(session_id) = event.session_id.as_deref() {
            transaction
                .execute(
                    "UPDATE sessions SET last_summary = ?1, updated_at = ?2 WHERE id = ?3",
                    params![text, event.occurred_at, session_id],
                )
                .map_err(|_| history_error("HIST-LAST-SUMMARY-WRITE", true))?;
        }
    }
    Ok(AppendEventResult {
        sequence: sequence as u64,
        inserted: true,
    })
}

#[derive(Clone, Debug)]
struct UnfinishedTurnRecord {
    workspace_id: String,
    session_id: Option<String>,
    generation: u64,
    source_sequence: u64,
    thread_handle: String,
    turn_handle: String,
    status: String,
}

fn validate_domain_event(event: &NormalizedDomainEvent) -> Result<(), WorkspaceHistoryError> {
    validate_opaque_id(&event.event_id, "HIST-EVENT-ID")?;
    validate_workspace_id(&event.workspace_id)?;
    if let Some(session_id) = &event.session_id {
        validate_opaque_id(session_id, "HIST-SESSION-ID")?;
    }
    validate_timestamp(&event.occurred_at)
}

fn validate_event_shape(
    event: &NormalizedDomainEvent,
    payload: &Value,
) -> Result<(), WorkspaceHistoryError> {
    let object = payload
        .as_object()
        .ok_or_else(|| history_error("HIST-EVENT-PAYLOAD", false))?;
    let exact = |required: &[&str], optional: &[&str]| {
        required.iter().all(|key| object.contains_key(*key))
            && object
                .keys()
                .all(|key| required.contains(&key.as_str()) || optional.contains(&key.as_str()))
    };
    let optional_public_string = |key: &str| {
        object.get(key).is_none_or(|value| {
            value.as_str().is_some_and(|value| {
                !value.trim().is_empty()
                    && value.chars().count() <= 128
                    && !value.chars().any(char::is_control)
            })
        })
    };
    match (event.producer.as_str(), event.kind.as_str()) {
        ("app", "app.runtime.changed") => {
            if !exact(&["mode", "state"], &[])
                || !matches!(
                    object.get("mode").and_then(Value::as_str),
                    Some("tauri" | "demo")
                )
                || !matches!(
                    object.get("state").and_then(Value::as_str),
                    Some("ready" | "demo_only" | "unavailable")
                )
            {
                return Err(history_error("HIST-EVENT-PAYLOAD", false));
            }
        }
        ("work", "work.workspace.lifecycle.changed") => {
            if !exact(&["lifecycle"], &[])
                || !matches!(
                    object.get("lifecycle").and_then(Value::as_str),
                    Some("backlog" | "in_progress" | "in_review" | "done" | "canceled")
                )
            {
                return Err(history_error("HIST-EVENT-PAYLOAD", false));
            }
        }
        ("code", kind) => {
            if !validate_codex_history_event(kind, object) {
                return Err(history_error("HIST-EVENT-PAYLOAD", false));
            }
        }
        ("live", "live.renderer.status.changed") => {
            if !exact(&["level"], &["errorCode"])
                || !matches!(
                    object.get("level").and_then(Value::as_str),
                    Some("animated" | "reduced" | "static" | "text_only")
                )
                || !optional_public_string("errorCode")
            {
                return Err(history_error("HIST-EVENT-PAYLOAD", false));
            }
        }
        ("hist", "hist.writer.status.changed") => {
            if !exact(&["status"], &["errorCode"])
                || !matches!(
                    object.get("status").and_then(Value::as_str),
                    Some("ready" | "read_only" | "blocked")
                )
                || !optional_public_string("errorCode")
            {
                return Err(history_error("HIST-EVENT-PAYLOAD", false));
            }
        }
        (
            "git",
            "git.observation.recorded" | "git.work_unit.observed" | "git.commit_evidence.recorded",
        ) => {
            if !validate_git_history_event(event, object) {
                return Err(history_error("HIST-EVENT-PAYLOAD", false));
            }
        }
        _ => return Err(history_error("HIST-EVENT-KIND", false)),
    }
    Ok(())
}

fn validate_git_history_event(
    event: &NormalizedDomainEvent,
    object: &serde_json::Map<String, Value>,
) -> bool {
    if event.session_id.is_some() {
        return false;
    }
    let payload = Value::Object(object.clone());
    match event.kind.as_str() {
        "git.observation.recorded" => serde_json::from_value::<GitObservation>(payload)
            .is_ok_and(|observation| validate_git_observation(&observation, &event.workspace_id)),
        "git.work_unit.observed" => serde_json::from_value::<WorkUnitGitObservation>(payload)
            .is_ok_and(|observation| validate_git_work_unit(&observation, &event.workspace_id)),
        "git.commit_evidence.recorded" => serde_json::from_value::<CommitEvidenceDetail>(payload)
            .is_ok_and(|evidence| validate_git_commit_evidence(&evidence, &event.workspace_id)),
        _ => false,
    }
}

fn validate_git_observation(observation: &GitObservation, workspace_id: &str) -> bool {
    observation.schema_version == GIT_REVIEW_SCHEMA_VERSION
        && observation.workspace_id == workspace_id
        && valid_git_id(&observation.observation_id)
        && valid_git_id(&observation.workspace_id)
        && observation.work_unit_id.as_deref().is_none_or(valid_git_id)
        && observation
            .source_event_id
            .as_deref()
            .is_none_or(valid_git_id)
        && (observation.head_sha == "unborn" || is_object_id(&observation.head_sha))
        && observation
            .head_reference
            .as_deref()
            .is_none_or(|value| valid_git_text(value, 512, false))
        && valid_git_text(&observation.branch, 512, false)
        && valid_sha256(&observation.index_fingerprint)
        && valid_sha256(&observation.status_fingerprint)
        && valid_sha256(&observation.repository_fingerprint)
        && observation.pre_existing.len() <= MAX_CHANGED_FILES
        && observation.pre_existing.iter().all(|change| {
            valid_git_id(&change.file_id)
                && validate_relative_path(&change.relative_path).is_ok()
                && (change.staged || change.unstaged || change.untracked)
        })
        && observation.blocked_reasons.len() <= 20
        && observation
            .blocked_reasons
            .iter()
            .all(|reason| valid_git_text(reason, 256, false))
        && (observation.support_state == GitSupportState::Blocked
            || observation.blocked_reasons.is_empty())
        && validate_timestamp(&observation.captured_at).is_ok()
        && observation.history_sequence.is_none()
}

fn validate_git_work_unit(observation: &WorkUnitGitObservation, workspace_id: &str) -> bool {
    observation.schema_version == GIT_REVIEW_SCHEMA_VERSION
        && observation.workspace_id == workspace_id
        && valid_git_id(&observation.workspace_id)
        && valid_git_id(&observation.work_unit_id)
        && valid_git_id(&observation.source_event_id)
        && valid_git_id(&observation.before_observation_id)
        && valid_git_id(&observation.after_observation_id)
        && observation.new_commit_evidence_ids.len() <= MAX_EVIDENCE_ITEMS
        && observation
            .new_commit_evidence_ids
            .iter()
            .all(|value| valid_git_id(value))
        && validate_commit_skill_audit(
            &observation.commit_skill_injection,
            observation.workspace_generation,
            &observation.work_unit_id,
        )
        && observation
            .reported_commit_block_reason
            .as_deref()
            .is_none_or(|value| valid_git_text(value, MAX_GIT_BLOCK_REASON_CHARS, false))
        && validate_timestamp(&observation.observed_at).is_ok()
        && observation.history_sequence.is_none()
}

fn validate_git_commit_evidence(evidence: &CommitEvidenceDetail, workspace_id: &str) -> bool {
    if evidence.schema_version != GIT_REVIEW_SCHEMA_VERSION
        || evidence.workspace_id != workspace_id
        || !valid_git_id(&evidence.commit_evidence_id)
        || !valid_git_id(&evidence.workspace_id)
        || !is_object_id(&evidence.identity.commit_sha)
        || !valid_git_text(
            &evidence.identity.subject,
            MAX_GIT_COMMIT_SUBJECT_CHARS,
            false,
        )
        || !valid_git_text(&evidence.identity.body, MAX_GIT_COMMIT_BODY_CHARS, true)
        || !valid_git_text(
            &evidence.identity.author_name,
            MAX_GIT_AUTHOR_NAME_CHARS,
            false,
        )
        || !valid_git_text(
            &evidence.identity.author_email,
            MAX_GIT_AUTHOR_EMAIL_CHARS,
            false,
        )
        || validate_timestamp(&evidence.identity.authored_at).is_err()
        || validate_timestamp(&evidence.identity.committed_at).is_err()
        || evidence.identity.parents.len() > 32
        || !evidence
            .identity
            .parents
            .iter()
            .all(|sha| is_object_id(sha))
        || !evidence.work_unit_id.as_deref().is_none_or(valid_git_id)
        || !evidence
            .objective
            .as_deref()
            .is_none_or(|value| valid_git_text(value, MAX_GIT_OBJECTIVE_CHARS, false))
        || evidence.acceptance.len() > 20
        || !evidence
            .acceptance
            .iter()
            .all(|item| valid_git_text(item, MAX_GIT_ACCEPTANCE_CHARS, false))
        || !evidence
            .before_observation_id
            .as_deref()
            .is_none_or(valid_git_id)
        || !evidence
            .after_observation_id
            .as_deref()
            .is_none_or(valid_git_id)
        || !evidence.source_event_id.as_deref().is_none_or(valid_git_id)
        || !validate_git_gates(&evidence.gates)
        || evidence.files.len() > MAX_CHANGED_FILES
        || !evidence.files.iter().all(|file| {
            valid_git_id(&file.file_evidence_id)
                && validate_relative_path(&file.relative_path).is_ok()
                && file.additions <= MAX_CHANGED_LINES
                && file.deletions <= MAX_CHANGED_LINES
        })
        || evidence.diff_summary.files_changed != evidence.files.len() as u64
        || evidence.diff_summary.files_changed > MAX_CHANGED_FILES as u64
        || evidence.diff_summary.binary_files > evidence.diff_summary.files_changed
        || evidence
            .diff_summary
            .additions
            .saturating_add(evidence.diff_summary.deletions)
            > MAX_CHANGED_LINES
        || evidence.verification.len() > MAX_EVIDENCE_ITEMS
        || !evidence.verification.iter().all(validate_git_verification)
        || evidence.decisions.len() > MAX_EVIDENCE_ITEMS
        || !evidence.decisions.iter().all(validate_git_decision)
        || evidence.failed_attempts.len() > MAX_EVIDENCE_ITEMS
        || !evidence
            .failed_attempts
            .iter()
            .all(validate_git_failed_attempt)
        || evidence.risks.len() > MAX_EVIDENCE_ITEMS
        || !evidence.risks.iter().all(validate_git_risk)
        || evidence
            .commit_skill_injection
            .as_ref()
            .is_some_and(|audit| {
                !evidence
                    .work_unit_id
                    .as_deref()
                    .is_some_and(|work_unit_id| {
                        validate_commit_skill_audit(audit, audit.workspace_generation, work_unit_id)
                    })
            })
        || validate_timestamp(&evidence.observed_at).is_err()
        || evidence.history_sequence.is_some()
    {
        return false;
    }

    let correlated = evidence.work_unit_id.is_some()
        && evidence.before_observation_id.is_some()
        && evidence.after_observation_id.is_some()
        && evidence.source_event_id.is_some()
        && evidence.commit_skill_injection.is_some();
    match evidence.producer {
        CommitProducer::MainCodex => correlated,
        CommitProducer::ExternalUncorrelated => {
            !correlated
                && evidence.work_unit_id.is_none()
                && evidence.before_observation_id.is_none()
                && evidence.after_observation_id.is_none()
                && evidence.source_event_id.is_none()
                && evidence.commit_skill_injection.is_none()
        }
    }
}

fn validate_commit_skill_audit(
    audit: &crate::git_review::types::CommitSkillInjectionAudit,
    workspace_generation: u64,
    work_unit_id: &str,
) -> bool {
    audit.schema_version == GIT_REVIEW_SCHEMA_VERSION
        && audit.skill_id == "coding-wife-commit-work"
        && valid_git_text(&audit.skill_version, 64, false)
        && valid_sha256(&audit.content_digest)
        && audit.path_authority == SkillPathAuthority::AppBundle
        && audit.injection_mode == SkillInjectionMode::SkillInput
        && audit.workspace_generation == workspace_generation
        && audit.work_unit_id == work_unit_id
        && valid_git_id(&audit.work_unit_id)
        && valid_git_id(&audit.client_request_id)
        && validate_timestamp(&audit.injected_at).is_ok()
}

fn validate_git_gates(gates: &[GateResult]) -> bool {
    if gates.len() != 4 {
        return false;
    }
    let mut seen = [false; 4];
    for gate in gates {
        let index = match gate.gate {
            GateKind::Scope => 0,
            GateKind::Ownership => 1,
            GateKind::Verification => 2,
            GateKind::Risk => 3,
        };
        if seen[index]
            || gate.reason_codes.len() > 20
            || !gate
                .reason_codes
                .iter()
                .all(|code| valid_git_text(code, 256, false))
            || gate.evidence_ids.len() > MAX_EVIDENCE_ITEMS
            || !gate.evidence_ids.iter().all(|value| valid_git_id(value))
        {
            return false;
        }
        seen[index] = true;
    }
    seen.into_iter().all(|value| value)
}

fn validate_git_verification(evidence: &VerificationEvidence) -> bool {
    valid_git_id(&evidence.evidence_id)
        && valid_git_id(&evidence.source_event_id)
        && valid_git_text(&evidence.check, MAX_GIT_VERIFICATION_CHECK_CHARS, false)
        && evidence.duration_ms <= 24 * 60 * 60 * 1_000
        && valid_git_text(&evidence.summary, MAX_GIT_VERIFICATION_SUMMARY_CHARS, true)
}

fn validate_git_decision(decision: &DecisionEvidence) -> bool {
    valid_git_id(&decision.decision_id)
        && valid_git_id(&decision.source_event_id)
        && valid_git_text(&decision.summary, MAX_GIT_DECISION_SUMMARY_CHARS, false)
        && valid_git_text(&decision.answer, MAX_GIT_DECISION_ANSWER_CHARS, false)
        && valid_git_text(&decision.rationale, MAX_GIT_DECISION_RATIONALE_CHARS, true)
}

fn validate_git_failed_attempt(attempt: &FailedAttemptEvidence) -> bool {
    valid_git_id(&attempt.attempt_id)
        && valid_git_id(&attempt.source_event_id)
        && valid_git_text(&attempt.approach, MAX_GIT_ATTEMPT_APPROACH_CHARS, false)
        && valid_git_text(&attempt.outcome, MAX_GIT_ATTEMPT_OUTCOME_CHARS, false)
        && valid_git_text(&attempt.learning, MAX_GIT_ATTEMPT_LEARNING_CHARS, true)
}

fn validate_git_risk(risk: &KnownRisk) -> bool {
    valid_git_id(&risk.risk_id)
        && valid_git_id(&risk.source_event_id)
        && valid_git_text(&risk.category, MAX_GIT_RISK_CATEGORY_CHARS, false)
        && valid_git_text(&risk.summary, MAX_GIT_RISK_SUMMARY_CHARS, false)
        && valid_git_text(&risk.mitigation, MAX_GIT_RISK_MITIGATION_CHARS, true)
}

fn valid_git_id(value: &str) -> bool {
    validate_git_opaque_id(value, "GIT-HISTORY-ID").is_ok()
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value[7..].bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn public_text(value: &str, maximum: usize, allow_empty: bool, multiline: bool) -> bool {
    if (!allow_empty && value.trim().is_empty())
        || value.chars().count() > maximum
        || redact_text(value, None, MAX_EVENT_BYTES) != value
        || value.to_ascii_lowercase().contains("chain-of-thought")
    {
        return false;
    }
    value.chars().all(|character| {
        if matches!(character, '\n' | '\t') {
            return multiline;
        }
        character != '\r' && !character.is_control()
    })
}

fn public_single_line(value: &str, maximum: usize, allow_empty: bool) -> bool {
    public_text(value, maximum, allow_empty, false)
}

fn public_multiline(value: &str, maximum: usize, allow_empty: bool) -> bool {
    public_text(value, maximum, allow_empty, true)
}

fn validate_persisted_pending_request(value: &Value, approval_expected: bool) -> bool {
    let Ok(request) = serde_json::from_value::<PendingRequestView>(value.clone()) else {
        return false;
    };
    if !public_single_line(&request.pending_id, 128, false)
        || !public_single_line(&request.operation, 128, false)
        || !public_single_line(&request.target_alias, 256, false)
        || !request
            .reason
            .as_deref()
            .is_none_or(|reason| public_multiline(reason, 4_096, true))
    {
        return false;
    }

    let mut question_ids = HashSet::new();
    for question in &request.questions {
        if !public_single_line(&question.id, 128, false)
            || !question_ids.insert(question.id.as_str())
            || !public_single_line(&question.header, 256, false)
            || !public_multiline(&question.question, 4_096, false)
            || !(2..=3).contains(&question.options.len())
        {
            return false;
        }
        let mut option_ids = HashSet::new();
        let mut option_labels = HashSet::new();
        for option in &question.options {
            if !public_single_line(&option.id, 128, false)
                || !option_ids.insert(option.id.as_str())
                || !public_single_line(&option.label, 256, false)
                || !option_labels.insert(option.label.as_str())
                || !public_multiline(&option.description, 1_024, true)
            {
                return false;
            }
        }
    }

    let approval = request.kind != PendingKind::UserInput;
    if approval != approval_expected {
        return false;
    }
    let context = &request.decision_context;
    let mut evidence = HashSet::new();
    if context.schema_version != 1
        || !public_single_line(&context.target_alias, 256, false)
        || context.target_alias != request.target_alias
        || !["command", "turn"].contains(&context.scope.as_str())
        || !["low", "medium", "high"].contains(&context.risk.as_str())
        || ![
            "reversible",
            "partially_reversible",
            "not_reversible",
            "unknown",
        ]
        .contains(&context.reversibility.as_str())
        || !["none", "limited_context", "unknown_effects"].contains(&context.uncertainty.as_str())
        || !context
            .recommendation
            .as_deref()
            .is_none_or(|recommendation| public_single_line(recommendation, 256, false))
        || !(1..=8).contains(&context.evidence.len())
        || context
            .evidence
            .iter()
            .any(|item| !public_multiline(item, 512, false) || !evidence.insert(item.as_str()))
    {
        return false;
    }
    if !approval {
        let option_ids = request
            .questions
            .iter()
            .flat_map(|question| question.options.iter().map(|option| option.id.as_str()))
            .collect::<HashSet<_>>();
        return request.allowed_decisions.is_empty()
            && (1..=3).contains(&request.questions.len())
            && context.category == "user_decision"
            && context.target_kind == "active_turn"
            && context.effect == "continue_turn"
            && context.scope == "turn"
            && context
                .recommendation
                .as_deref()
                .is_none_or(|recommendation| option_ids.contains(recommendation))
            && match request.response_kind {
                PendingResponseKind::FallbackDecision => {
                    request.operation == "decision_fallback" && request.questions.len() == 1
                }
                PendingResponseKind::NativeServerRequest => true,
            };
    }

    let (expected_category, expected_effect) = match request.kind {
        PendingKind::CommandApproval => ("command_execution", "execute_command"),
        PendingKind::FileChangeApproval => ("file_change", "apply_file_change"),
        PendingKind::PermissionsApproval => ("permissions", "grant_permissions"),
        PendingKind::UserInput => return false,
    };
    let decisions_unique = request
        .allowed_decisions
        .iter()
        .enumerate()
        .all(|(index, decision)| !request.allowed_decisions[..index].contains(decision));
    let recommendation_allowed = context
        .recommendation
        .as_deref()
        .is_some_and(|recommended| {
            request.allowed_decisions.iter().any(|decision| {
                recommended
                    == match decision {
                        ApprovalDecision::ApproveOnce => "approve_once",
                        ApprovalDecision::Reject => "reject",
                        ApprovalDecision::Stop => "stop",
                    }
            })
        });
    request.response_kind == PendingResponseKind::NativeServerRequest
        && request.questions.is_empty()
        && (1..=3).contains(&request.allowed_decisions.len())
        && decisions_unique
        && context.category == expected_category
        && ["network_host", "workspace", "workspace_path"].contains(&context.target_kind.as_str())
        && context.effect == expected_effect
        && recommendation_allowed
}

fn validate_codex_history_event(kind: &str, object: &serde_json::Map<String, Value>) -> bool {
    let exact = |fields: &[&str]| {
        let required = ["semanticVersion", "generation", "sourceSequence"]
            .into_iter()
            .chain(fields.iter().copied())
            .collect::<Vec<_>>();
        required.iter().all(|key| object.contains_key(*key))
            && object.keys().all(|key| required.contains(&key.as_str()))
    };
    let bounded_single_line = |key: &str, maximum: usize, allow_empty: bool| {
        object
            .get(key)
            .and_then(Value::as_str)
            .is_some_and(|value| public_single_line(value, maximum, allow_empty))
    };
    let bounded_multiline = |key: &str, maximum: usize, allow_empty: bool| {
        object
            .get(key)
            .and_then(Value::as_str)
            .is_some_and(|value| public_multiline(value, maximum, allow_empty))
    };
    let unsigned = |key: &str, maximum: u64| {
        object
            .get(key)
            .and_then(Value::as_u64)
            .is_some_and(|value| value <= maximum)
    };
    let one_of = |key: &str, values: &[&str]| {
        object
            .get(key)
            .and_then(Value::as_str)
            .is_some_and(|value| values.contains(&value))
    };
    let base = object.get("semanticVersion").and_then(Value::as_u64) == Some(1)
        && unsigned("generation", u64::MAX)
        && object
            .get("generation")
            .and_then(Value::as_u64)
            .is_some_and(|value| value > 0)
        && unsigned("sourceSequence", u64::MAX);
    if !base {
        return false;
    }

    match kind {
        "code.thread.status.changed" => {
            exact(&["threadHandle", "status"])
                && bounded_single_line("threadHandle", 128, false)
                && one_of("status", &["active", "idle", "systemError", "notLoaded"])
        }
        "code.session.status.changed" => {
            exact(&["threadHandle", "turnHandle", "status"])
                && bounded_single_line("threadHandle", 128, false)
                && bounded_single_line("turnHandle", 128, false)
                && one_of(
                    "status",
                    &[
                        "running",
                        "inProgress",
                        "waiting",
                        "interrupted",
                        "failed",
                        "completed",
                        "canceled",
                    ],
                )
        }
        "code.user.instruction.accepted" => {
            exact(&["text", "effort", "attachmentCount"])
                && bounded_multiline("text", 64 * 1024, true)
                && one_of("effort", &["low", "max"])
                && unsigned("attachmentCount", 10)
        }
        "code.item.status.changed" => {
            exact(&["itemHandle", "itemType", "status"])
                && bounded_single_line("itemHandle", 128, false)
                && one_of(
                    "itemType",
                    &[
                        "agentMessage",
                        "commandExecution",
                        "fileChange",
                        "mcpToolCall",
                        "webSearch",
                        "plan",
                        "userMessage",
                        "enteredReviewMode",
                        "exitedReviewMode",
                        "contextCompaction",
                    ],
                )
                && one_of("status", &["running", "completed"])
        }
        "code.message.completed" => {
            exact(&["itemHandle", "text"])
                && bounded_single_line("itemHandle", 128, false)
                && bounded_multiline("text", 64 * 1024, true)
        }
        "code.plan.updated" => exact(&["stepCount"]) && unsigned("stepCount", 1_000),
        "code.diff.updated" => {
            exact(&["byteCount", "detailRef"])
                && unsigned("byteCount", 1024 * 1024)
                && bounded_single_line("detailRef", 128, false)
        }
        "code.tool.output" => {
            exact(&["itemHandle", "excerpt"])
                && bounded_single_line("itemHandle", 128, false)
                && bounded_multiline("excerpt", 16 * 1024, true)
        }
        "code.file_change.updated" => {
            exact(&["itemHandle", "pathAlias", "changeKind"])
                && bounded_single_line("itemHandle", 128, false)
                && bounded_single_line("pathAlias", 512, false)
                && one_of("changeKind", &["create", "update", "delete", "unknown"])
        }
        "code.decision.requested" | "code.approval.requested" => {
            exact(&["request"])
                && object.get("request").is_some_and(|request| {
                    validate_persisted_pending_request(request, kind == "code.approval.requested")
                })
        }
        "code.pending.resolved" => {
            exact(&["pendingId", "status"])
                && bounded_single_line("pendingId", 128, false)
                && one_of("status", &["accepted", "expired", "failed"])
        }
        "code.session.diagnostic" => {
            exact(&["code", "willRetry", "detailRef"])
                && bounded_single_line("code", 128, false)
                && object.get("willRetry").is_some_and(Value::is_boolean)
                && bounded_single_line("detailRef", 128, false)
        }
        "code.model.violation" => {
            exact(&["fromModel", "toModel"])
                && bounded_single_line("fromModel", 128, false)
                && bounded_single_line("toModel", 128, false)
        }
        "code.protocol.unsupported" => {
            exact(&["methodHash", "byteCount", "detailRef"])
                && bounded_single_line("methodHash", 128, false)
                && unsigned("byteCount", 1024 * 1024)
                && bounded_single_line("detailRef", 128, false)
        }
        _ => false,
    }
}

fn sanitize_json(
    value: &Value,
    workspace_root: Option<&Path>,
    depth: usize,
) -> Result<Value, WorkspaceHistoryError> {
    if depth > 32 {
        return Err(history_error("HIST-EVENT-DEPTH", false));
    }
    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) => Ok(value.clone()),
        Value::String(value) => Ok(Value::String(redact_text(
            value,
            workspace_root,
            MAX_EVENT_BYTES,
        ))),
        Value::Array(values) => {
            if values.len() > MAX_EVENT_ARRAY_ITEMS {
                return Err(history_error("HIST-EVENT-ARRAY", false));
            }
            values
                .iter()
                .map(|value| sanitize_json(value, workspace_root, depth + 1))
                .collect::<Result<Vec<_>, _>>()
                .map(Value::Array)
        }
        Value::Object(values) => {
            if values.len() > 64 {
                return Err(history_error("HIST-EVENT-OBJECT", false));
            }
            let mut sanitized = serde_json::Map::new();
            for (key, value) in values {
                let normalized = key.to_ascii_lowercase().replace(['_', '-'], "");
                if matches!(
                    normalized.as_str(),
                    "reasoning"
                        | "rawreasoning"
                        | "chainofthought"
                        | "audio"
                        | "audiobytes"
                        | "supportprompt"
                        | "supportresponse"
                        | "rawstderr"
                ) {
                    return Err(history_error("HIST-EVENT-FORBIDDEN-FIELD", false));
                }
                sanitized.insert(
                    key.clone(),
                    sanitize_json(value, workspace_root, depth + 1)?,
                );
            }
            Ok(Value::Object(sanitized))
        }
    }
}

fn workspace_by_id(
    connection: &Connection,
    workspace_id: &str,
) -> Result<WorkspaceSummary, WorkspaceHistoryError> {
    connection
        .query_row(
            &format!("{WORKSPACE_SELECT} WHERE w.id = ?1 AND p.registered = 1"),
            params![workspace_id],
            decode_workspace_row,
        )
        .optional()
        .map_err(|_| history_error("HIST-WORKSPACE-QUERY", true))?
        .ok_or_else(|| history_error("WORKSPACE-NOT-FOUND", false))
}

fn all_workspaces(connection: &Connection) -> Result<Vec<WorkspaceSummary>, WorkspaceHistoryError> {
    let mut statement = connection
        .prepare(&format!(
            "{WORKSPACE_SELECT} WHERE p.registered = 1 ORDER BY CASE w.lifecycle
               WHEN 'done' THEN 0 WHEN 'in_review' THEN 1 WHEN 'in_progress' THEN 2
               WHEN 'backlog' THEN 3 ELSE 4 END, w.updated_at DESC"
        ))
        .map_err(|_| history_error("HIST-WORKSPACE-QUERY", true))?;
    let rows = statement
        .query_map([], decode_workspace_row)
        .map_err(|_| history_error("HIST-WORKSPACE-QUERY", true))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|_| history_error("HIST-WORKSPACE-DECODE", false))
}

fn decode_workspace_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<WorkspaceSummary> {
    let lifecycle = row.get::<_, String>(7)?;
    let attention = row.get::<_, Option<String>>(8)?;
    let health = row.get::<_, String>(9)?;
    Ok(WorkspaceSummary {
        schema_version: WORKSPACE_HISTORY_SCHEMA_VERSION,
        workspace_id: row.get(0)?,
        project_id: row.get(1)?,
        repository: row.get(2)?,
        name: row.get(3)?,
        branch: row.get(4)?,
        head: row.get(5)?,
        detached: row.get::<_, i64>(6)? != 0,
        lifecycle: WorkspaceLifecycle::try_from(lifecycle.as_str())
            .unwrap_or(WorkspaceLifecycle::Canceled),
        attention: attention
            .as_deref()
            .and_then(|value| WorkspaceAttention::try_from(value).ok()),
        health: WorkspaceHealth::try_from(health.as_str()).unwrap_or(WorkspaceHealth::Unreadable),
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
        last_selected_at: row.get(12)?,
    })
}

fn decode_project_linkage(row: &rusqlite::Row<'_>) -> rusqlite::Result<StoredProjectLinkage> {
    Ok(StoredProjectLinkage {
        project_id: row.get(0)?,
        workspace_id: row.get(1)?,
        canonical_root: path_from_bytes(row.get::<_, Vec<u8>>(2)?),
        registered: row.get::<_, i64>(3)? != 0,
        project_identity: row.get(4)?,
        root_device: row.get::<_, i64>(5)? as u64,
        root_inode: row.get::<_, i64>(6)? as u64,
        git_device: row.get::<_, i64>(7)? as u64,
        git_inode: row.get::<_, i64>(8)? as u64,
    })
}

fn project_linkage_at_root(
    transaction: &Transaction<'_>,
    root: &[u8],
) -> Result<Option<StoredProjectLinkage>, WorkspaceHistoryError> {
    transaction
        .query_row(
            "SELECT p.id, w.id, p.canonical_root, p.registered, p.project_identity,
                    p.root_device, p.root_inode, p.git_device, p.git_inode
             FROM projects p JOIN workspaces w ON w.project_id = p.id
             WHERE p.canonical_root = ?1
             ORDER BY w.created_at ASC LIMIT 1",
            params![root],
            decode_project_linkage,
        )
        .optional()
        .map_err(|_| history_error("HIST-PROJECT-LOOKUP", true))
}

fn project_linkage_by_identity(
    transaction: &Transaction<'_>,
    identity: &GitRepositoryIdentity,
) -> Result<Option<StoredProjectLinkage>, WorkspaceHistoryError> {
    transaction
        .query_row(
            "SELECT p.id, w.id, p.canonical_root, p.registered, p.project_identity,
                    p.root_device, p.root_inode, p.git_device, p.git_inode
             FROM projects p JOIN workspaces w ON w.project_id = p.id
             WHERE p.project_identity = ?1 AND p.root_device = ?2 AND p.root_inode = ?3
               AND p.git_device = ?4 AND p.git_inode = ?5
             ORDER BY p.registered DESC, p.created_at ASC, w.created_at ASC LIMIT 1",
            params![
                identity.project_identity,
                identity.root_device as i64,
                identity.root_inode as i64,
                identity.git_device as i64,
                identity.git_inode as i64,
            ],
            decode_project_linkage,
        )
        .optional()
        .map_err(|_| history_error("HIST-PROJECT-LOOKUP", true))
}

fn private_unregistered_root(project_id: &str) -> Vec<u8> {
    format!("\0coding-wife-unregistered:{project_id}").into_bytes()
}

fn move_unregistered_project_to_private_root(
    transaction: &Transaction<'_>,
    project_id: &str,
) -> Result<(), WorkspaceHistoryError> {
    transaction
        .execute(
            "UPDATE projects SET canonical_root = ?1 WHERE id = ?2 AND registered = 0",
            params![private_unregistered_root(project_id), project_id],
        )
        .map_err(|_| history_error("HIST-PROJECT-UPDATE", true))?;
    Ok(())
}

fn private_workspace_by_id(
    connection: &Connection,
    workspace_id: &str,
) -> Result<AppPrivateWorkspaceRecord, WorkspaceHistoryError> {
    connection
        .query_row(
            "SELECT w.id, p.alias, p.canonical_root
             FROM workspaces w JOIN projects p ON p.id = w.project_id
             WHERE w.id = ?1 AND p.registered = 1",
            params![workspace_id],
            |row| {
                Ok(AppPrivateWorkspaceRecord {
                    workspace_id: row.get(0)?,
                    alias: row.get(1)?,
                    canonical_root: path_from_bytes(row.get::<_, Vec<u8>>(2)?),
                })
            },
        )
        .optional()
        .map_err(|_| history_error("HIST-WORKSPACE-QUERY", true))?
        .ok_or_else(|| history_error("WORKSPACE-NOT-FOUND", false))
}

fn private_root_by_workspace(
    connection: &Connection,
    workspace_id: &str,
) -> Result<PathBuf, WorkspaceHistoryError> {
    connection
        .query_row(
            "SELECT p.canonical_root FROM workspaces w JOIN projects p ON p.id = w.project_id
             WHERE w.id = ?1",
            params![workspace_id],
            |row| Ok(path_from_bytes(row.get::<_, Vec<u8>>(0)?)),
        )
        .optional()
        .map_err(|_| history_error("HIST-WORKSPACE-QUERY", true))?
        .ok_or_else(|| history_error("WORKSPACE-NOT-FOUND", false))
}

fn draft_by_workspace(
    connection: &Connection,
    workspace_id: &str,
) -> Result<WorkspaceDraftView, WorkspaceHistoryError> {
    connection
        .query_row(
            "SELECT workspace_id, draft_text, effort, draft_revision, updated_at
             FROM workspace_preferences WHERE workspace_id = ?1",
            params![workspace_id],
            |row| {
                let effort = row.get::<_, String>(2)?;
                Ok(WorkspaceDraftView {
                    schema_version: WORKSPACE_HISTORY_SCHEMA_VERSION,
                    workspace_id: row.get(0)?,
                    text: row.get(1)?,
                    effort: ReasoningEffort::try_from(effort.as_str())
                        .unwrap_or(ReasoningEffort::Fast),
                    revision: row.get::<_, i64>(3)? as u64,
                    updated_at: row.get(4)?,
                })
            },
        )
        .optional()
        .map_err(|_| history_error("HIST-DRAFT-QUERY", true))?
        .ok_or_else(|| history_error("WORKSPACE-NOT-FOUND", false))
}

fn timeline_anchor_by_workspace(
    connection: &Connection,
    workspace_id: &str,
) -> Result<Option<WorkspaceTimelineAnchorView>, WorkspaceHistoryError> {
    let stored = connection
        .query_row(
            "SELECT timeline_anchor_event_id, timeline_anchor_sequence,
                    timeline_anchor_offset, timeline_anchor_revision,
                    timeline_anchor_updated_at
             FROM workspace_resume_states WHERE workspace_id = ?1",
            params![workspace_id],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<i64>>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, Option<String>>(4)?,
                ))
            },
        )
        .optional()
        .map_err(|_| history_error("HIST-TIMELINE-ANCHOR-READ", true))?;
    let Some((Some(event_id), Some(sequence), Some(offset), revision, Some(updated_at))) = stored
    else {
        return Ok(None);
    };
    if sequence < 1 || revision < 0 || offset.unsigned_abs() > MAX_TIMELINE_ANCHOR_OFFSET as u64 {
        return Err(history_error("HIST-TIMELINE-ANCHOR-DECODE", false));
    }
    let exact = connection
        .query_row(
            "SELECT event_id, sequence FROM domain_events
             WHERE workspace_id = ?1 AND event_id = ?2 AND sequence = ?3",
            params![workspace_id, event_id, sequence],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
        )
        .optional()
        .map_err(|_| history_error("HIST-EVENT-LOOKUP", true))?;
    let (event_id, sequence, was_clamped) = if let Some((event_id, sequence)) = exact {
        (event_id, sequence, false)
    } else {
        let nearest = connection
            .query_row(
                "SELECT event_id, sequence FROM domain_events
                 WHERE workspace_id = ?1
                 ORDER BY ABS(sequence - ?2) ASC, sequence ASC, event_id ASC LIMIT 1",
                params![workspace_id, sequence],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
            )
            .optional()
            .map_err(|_| history_error("HIST-EVENT-LOOKUP", true))?;
        let Some((event_id, sequence)) = nearest else {
            return Ok(None);
        };
        (event_id, sequence, true)
    };
    Ok(Some(WorkspaceTimelineAnchorView {
        schema_version: WORKSPACE_RESUME_STATE_SCHEMA_VERSION,
        workspace_id: workspace_id.to_owned(),
        event_id,
        sequence: sequence as u64,
        offset,
        revision: revision as u64,
        updated_at,
        was_clamped,
    }))
}

fn resume_state_by_workspace(
    connection: &Connection,
    workspace_id: &str,
) -> Result<Option<WorkspaceResumeStateView>, WorkspaceHistoryError> {
    let summary = connection
        .query_row(
            "SELECT last_summary_event_id, last_summary_sequence,
                    last_summary_text, last_summary_updated_at
             FROM workspace_resume_states WHERE workspace_id = ?1",
            params![workspace_id],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<i64>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            },
        )
        .optional()
        .map_err(|_| history_error("HIST-RESUME-STATE-READ", true))?
        .and_then(|(event_id, sequence, text, updated_at)| {
            match (event_id, sequence, text, updated_at) {
                (Some(event_id), Some(sequence), Some(text), Some(updated_at)) if sequence >= 1 => {
                    Some(WorkspaceLastSummaryView {
                        schema_version: WORKSPACE_RESUME_STATE_SCHEMA_VERSION,
                        workspace_id: workspace_id.to_owned(),
                        event_id,
                        sequence: sequence as u64,
                        text,
                        updated_at,
                    })
                }
                _ => None,
            }
        });
    let timeline_anchor = timeline_anchor_by_workspace(connection, workspace_id)?;
    if summary.is_none() && timeline_anchor.is_none() {
        return Ok(None);
    }
    Ok(Some(WorkspaceResumeStateView {
        schema_version: WORKSPACE_RESUME_STATE_SCHEMA_VERSION,
        workspace_id: workspace_id.to_owned(),
        last_summary: summary,
        timeline_anchor,
    }))
}

fn context_by_id(
    connection: &Connection,
    snapshot_id: &str,
) -> Result<ContextSnapshotView, WorkspaceHistoryError> {
    connection
        .query_row(
            "SELECT id, workspace_id, source, label, captured_at, byte_count, content_hash
             FROM context_snapshots WHERE id = ?1",
            params![snapshot_id],
            decode_context_row,
        )
        .optional()
        .map_err(|_| history_error("HIST-CONTEXT-QUERY", true))?
        .ok_or_else(|| history_error("HIST-CONTEXT-NOT-FOUND", false))
}

fn contexts_by_workspace(
    connection: &Connection,
    workspace_id: &str,
) -> Result<Vec<ContextSnapshotView>, WorkspaceHistoryError> {
    let mut statement = connection
        .prepare(
            "SELECT id, workspace_id, source, label, captured_at, byte_count, content_hash
             FROM context_snapshots WHERE workspace_id = ?1 ORDER BY captured_at ASC, id ASC",
        )
        .map_err(|_| history_error("HIST-CONTEXT-QUERY", true))?;
    let rows = statement
        .query_map(params![workspace_id], decode_context_row)
        .map_err(|_| history_error("HIST-CONTEXT-QUERY", true))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|_| history_error("HIST-CONTEXT-DECODE", false))
}

fn decode_context_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ContextSnapshotView> {
    let source = row.get::<_, String>(2)?;
    Ok(ContextSnapshotView {
        schema_version: WORKSPACE_HISTORY_SCHEMA_VERSION,
        snapshot_id: row.get(0)?,
        workspace_id: row.get(1)?,
        source: ContextSource::try_from(source.as_str()).unwrap_or(ContextSource::Files),
        label: row.get(3)?,
        captured_at: row.get(4)?,
        byte_count: row.get::<_, i64>(5)? as u64,
        content_hash: row.get(6)?,
    })
}

fn decode_event_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<TimelineEventView> {
    let payload_json = row.get::<_, String>(7)?;
    let payload = serde_json::from_str(&payload_json)
        .unwrap_or_else(|_| json!({ "status": "blocked", "errorCode": "HIST-EVENT-DECODE" }));
    Ok(TimelineEventView {
        event_id: row.get(0)?,
        workspace_id: row.get(1)?,
        session_id: row.get(2)?,
        sequence: row.get::<_, i64>(3)? as u64,
        producer: row.get(4)?,
        kind: row.get(5)?,
        occurred_at: row.get(6)?,
        payload,
        schema_version: row.get::<_, i64>(8)? as u16,
    })
}

fn active_workspace(connection: &Connection) -> Result<Option<String>, WorkspaceHistoryError> {
    connection
        .query_row(
            "SELECT value FROM settings WHERE key = 'active_workspace_id'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|_| history_error("HIST-SETTING-QUERY", true))
}

fn validate_workspace_id(value: &str) -> Result<(), WorkspaceHistoryError> {
    if !value.starts_with("workspace-")
        || value.len() > 128
        || !value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
    {
        return Err(history_error("WORKSPACE-ID-INVALID", false));
    }
    Ok(())
}

fn validate_opaque_id(value: &str, code: &str) -> Result<(), WorkspaceHistoryError> {
    if value.is_empty()
        || value.len() > 160
        || !value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err(history_error(code, false));
    }
    Ok(())
}

fn validate_client_request_id(value: &str) -> Result<(), WorkspaceHistoryError> {
    validate_opaque_id(value, "WORKSPACE-REQUEST-ID-INVALID")
}

fn validate_workspace_name(value: &str) -> Result<String, WorkspaceHistoryError> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > 80 || value.contains(['\n', '\r', '\0']) {
        return Err(history_error("WORKSPACE-NAME-INVALID", false));
    }
    let redacted = redact_text(value, None, 512);
    if redacted != value {
        return Err(history_error("WORKSPACE-NAME-PRIVATE", false));
    }
    Ok(value.to_owned())
}

fn validate_goal(value: &str) -> Result<String, WorkspaceHistoryError> {
    if value.chars().count() > 4_000 || value.contains('\0') {
        return Err(history_error("WORKSPACE-GOAL-INVALID", false));
    }
    let redacted = redact_text(value, None, 32 * 1024);
    if redacted != value {
        return Err(history_error("WORKSPACE-GOAL-PRIVATE", false));
    }
    Ok(value.to_owned())
}

fn validate_label(value: &str) -> Result<String, WorkspaceHistoryError> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > 120 || value.chars().any(char::is_control) {
        return Err(history_error("WORKSPACE-CONTEXT-LABEL-INVALID", false));
    }
    Ok(value.to_owned())
}

fn validate_timestamp(value: &str) -> Result<(), WorkspaceHistoryError> {
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|_| ())
        .map_err(|_| history_error("HIST-TIMESTAMP-INVALID", false))
}

fn escape_like(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

fn history_error(code: &str, recoverable: bool) -> WorkspaceHistoryError {
    WorkspaceHistoryError::new(code, "workspace_history", recoverable)
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn backup_database_files(database_path: &Path) -> std::io::Result<Option<String>> {
    if !database_path.exists() {
        return Ok(None);
    }
    let stamp = Utc::now().format("%Y%m%dT%H%M%S%9fZ");
    let backup_name = format!(
        "workspace-history.recovery-{stamp}-{}.sqlite3",
        uuid::Uuid::new_v4()
    );
    let backup_path = database_path.with_file_name(&backup_name);
    fs::copy(database_path, &backup_path)?;
    set_private_file_permissions(&backup_path)?;
    for suffix in ["-wal", "-shm"] {
        let source = PathBuf::from(format!("{}{suffix}", database_path.display()));
        if source.exists() {
            let target = PathBuf::from(format!("{}{suffix}", backup_path.display()));
            fs::copy(source, &target)?;
            set_private_file_permissions(&target)?;
        }
    }
    Ok(Some(backup_name))
}

fn validate_readiness_backup(database_path: Option<&Path>, status: &HistoryStatus) -> bool {
    let Some(backup_name) = status.backup_name.as_deref() else {
        return status.mode != HistoryMode::RecoveryRequired;
    };
    if !backup_name.starts_with("workspace-history.recovery-")
        || !backup_name.ends_with(".sqlite3")
        || backup_name.len() > 160
        || Path::new(backup_name)
            .file_name()
            .and_then(|name| name.to_str())
            != Some(backup_name)
    {
        return false;
    }
    let Some(parent) = database_path.and_then(Path::parent) else {
        return false;
    };
    let backup_path = parent.join(backup_name);
    let Ok(metadata) = fs::symlink_metadata(backup_path) else {
        return false;
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() == 0 {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return false;
        }
    }
    true
}

#[cfg(unix)]
fn set_private_directory_permissions(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
}

#[cfg(not(unix))]
fn set_private_directory_permissions(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

#[cfg(unix)]
fn set_private_file_permissions(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
}

#[cfg(not(unix))]
fn set_private_file_permissions(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

fn set_private_database_permissions(database_path: &Path) -> std::io::Result<()> {
    set_private_file_permissions(database_path)?;
    for suffix in ["-wal", "-shm"] {
        let sidecar = PathBuf::from(format!("{}{suffix}", database_path.display()));
        if sidecar.exists() {
            set_private_file_permissions(&sidecar)?;
        }
    }
    Ok(())
}

#[cfg(unix)]
fn path_to_bytes(path: &Path) -> Vec<u8> {
    use std::os::unix::ffi::OsStrExt;
    path.as_os_str().as_bytes().to_vec()
}

#[cfg(not(unix))]
fn path_to_bytes(path: &Path) -> Vec<u8> {
    path.to_string_lossy().as_bytes().to_vec()
}

#[cfg(unix)]
fn path_from_bytes(bytes: Vec<u8>) -> PathBuf {
    use std::os::unix::ffi::OsStringExt;
    std::ffi::OsString::from_vec(bytes).into()
}

#[cfg(not(unix))]
fn path_from_bytes(bytes: Vec<u8>) -> PathBuf {
    String::from_utf8_lossy(&bytes).into_owned().into()
}

#[cfg(test)]
mod tests {
    use std::thread;

    use crate::codex::supervisor::CodexSupervisor;
    use crate::codex::workspace::WorkspaceService;
    use crate::workspace_history::editable_context::capture_project_reference_manifest;

    use super::*;

    fn codex_turn_payload(status: &str, source_sequence: u64) -> Value {
        json!({
            "semanticVersion": 1,
            "generation": 1,
            "sourceSequence": source_sequence,
            "threadHandle": "thread-safe",
            "turnHandle": "turn-safe",
            "status": status,
        })
    }

    fn codex_message_payload(item_handle: &str, text: &str, source_sequence: u64) -> Value {
        json!({
            "semanticVersion": 1,
            "generation": 1,
            "sourceSequence": source_sequence,
            "itemHandle": item_handle,
            "text": text,
        })
    }

    fn temp_directory(label: &str) -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("coding-wife-{label}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).expect("temp directory");
        path
    }

    fn git_repository() -> PathBuf {
        let root = temp_directory("history-repo");
        let status = std::process::Command::new("/usr/bin/git")
            .args(["init", "-q", "-b", "main"])
            .arg(&root)
            .status()
            .expect("git init");
        assert!(status.success());
        root
    }

    fn git_status(root: &Path) -> Vec<u8> {
        let output = std::process::Command::new("/usr/bin/git")
            .arg("-C")
            .arg(root)
            .args(["status", "--porcelain=v1", "--untracked-files=all"])
            .output()
            .expect("git status");
        assert!(output.status.success());
        output.stdout
    }

    fn replace_git_directory(root: &Path) {
        fs::rename(root.join(".git"), root.join(".git-preserved"))
            .expect("preserve original git directory");
        let status = std::process::Command::new("/usr/bin/git")
            .args(["init", "-q", "-b", "main"])
            .arg(root)
            .status()
            .expect("replace git directory");
        assert!(status.success());
    }

    fn reference_validation(root: &Path) -> ProjectReferenceValidation {
        let root = fs::canonicalize(root).expect("canonical reference root");
        let metadata = fs::metadata(&root).expect("reference root metadata");
        #[cfg(unix)]
        let (device, inode) = {
            use std::os::unix::fs::MetadataExt;
            (metadata.dev(), metadata.ino())
        };
        #[cfg(not(unix))]
        let (device, inode) = (metadata.len(), 0);
        ProjectReferenceValidation::new(root, device, inode)
    }

    async fn candidate(root: &Path) -> ValidatedWorkspaceCandidate {
        let record = AppPrivateWorkspaceRecord {
            workspace_id: format!("workspace-{}", uuid::Uuid::new_v4()),
            alias: "Fixture repository".to_owned(),
            canonical_root: root.to_path_buf(),
        };
        WorkspaceService::production(CodexSupervisor::new())
            .validate_private_candidate(&record)
            .await
            .expect("validated candidate")
    }

    fn git_observation_payload(workspace_id: &str) -> Value {
        let fingerprint = format!("sha256:{}", "c".repeat(64));
        json!({
            "schemaVersion": 1,
            "observationId": "observation-fixture",
            "workspaceId": workspace_id,
            "workspaceGeneration": 1,
            "reason": "work_unit_started",
            "workUnitId": "work-unit-fixture",
            "sourceEventId": null,
            "supportState": "ready",
            "headSha": "a".repeat(40),
            "headReference": "refs/heads/main",
            "branch": "main",
            "detached": false,
            "indexFingerprint": fingerprint,
            "statusFingerprint": format!("sha256:{}", "d".repeat(64)),
            "repositoryFingerprint": format!("sha256:{}", "e".repeat(64)),
            "preExisting": [],
            "blockedReasons": [],
            "capturedAt": "2026-07-18T00:00:01.000Z",
            "historySequence": null
        })
    }

    fn commit_skill_audit_payload() -> Value {
        json!({
            "schemaVersion": 1,
            "skillId": "coding-wife-commit-work",
            "skillVersion": "1.0.0",
            "contentDigest": format!("sha256:{}", "f".repeat(64)),
            "pathAuthority": "app_bundle",
            "injectionMode": "skill_input",
            "workspaceGeneration": 1,
            "workUnitId": "work-unit-fixture",
            "clientRequestId": "request-fixture",
            "injectedAt": "2026-07-18T00:00:00.000Z"
        })
    }

    fn git_commit_evidence_payload(workspace_id: &str) -> Value {
        json!({
            "schemaVersion": 1,
            "commitEvidenceId": "commit-evidence-fixture",
            "workspaceId": workspace_id,
            "producer": "main_codex",
            "identity": {
                "commitSha": "a".repeat(40),
                "subject": "feat: add fixture",
                "body": "- verify the bounded history shape",
                "authorName": "Fixture Author",
                "authorEmail": "fixture@example.invalid",
                "authoredAt": "2026-07-18T00:00:02.000Z",
                "committedAt": "2026-07-18T00:00:02.000Z",
                "parents": ["b".repeat(40)]
            },
            "workUnitId": "work-unit-fixture",
            "objective": "Persist bounded commit evidence",
            "acceptance": ["The exact evidence can be replayed"],
            "beforeObservationId": "observation-fixture",
            "afterObservationId": "observation-terminal-fixture",
            "sourceEventId": "source-fixture",
            "gates": [
                {"gate": "scope", "outcome": "pass", "reasonCodes": [], "evidenceIds": []},
                {"gate": "ownership", "outcome": "pass", "reasonCodes": [], "evidenceIds": []},
                {"gate": "verification", "outcome": "pass", "reasonCodes": [], "evidenceIds": ["verification-fixture"]},
                {"gate": "risk", "outcome": "pass", "reasonCodes": [], "evidenceIds": []}
            ],
            "files": [{
                "fileEvidenceId": "file-fixture",
                "relativePath": "src/main.rs",
                "changeKind": "modified",
                "additions": 4,
                "deletions": 1,
                "binary": false
            }],
            "diffSummary": {
                "filesChanged": 1,
                "additions": 4,
                "deletions": 1,
                "binaryFiles": 0
            },
            "verification": [{
                "evidenceId": "verification-fixture",
                "sourceEventId": "source-fixture",
                "check": "cargo test",
                "result": "passed",
                "durationMs": 1200,
                "summary": "All focused tests passed"
            }],
            "decisions": [],
            "failedAttempts": [],
            "risks": [],
            "commitSkillInjection": commit_skill_audit_payload(),
            "observedAt": "2026-07-18T00:00:03.000Z",
            "historySequence": null
        })
    }

    fn git_work_unit_payload(workspace_id: &str) -> Value {
        json!({
            "schemaVersion": 1,
            "workspaceId": workspace_id,
            "workspaceGeneration": 1,
            "workUnitId": "work-unit-fixture",
            "sourceEventId": "source-fixture",
            "terminalState": "completed",
            "beforeObservationId": "observation-fixture",
            "afterObservationId": "observation-terminal-fixture",
            "newCommitEvidenceIds": ["commit-evidence-fixture"],
            "commitSkillInjection": commit_skill_audit_payload(),
            "reportedCommitBlockReason": null,
            "observedAt": "2026-07-18T00:00:04.000Z",
            "historySequence": null
        })
    }

    #[tokio::test]
    async fn migration_registration_and_restore_are_idempotent() {
        let data = temp_directory("history-data");
        let root = git_repository();
        let store = WorkspaceHistoryStore::open(&data).expect("open store");
        let first_candidate = candidate(&root).await;
        let first = store
            .register_candidate(&first_candidate)
            .expect("first registration");
        let second_candidate = candidate(&root).await;
        let second = store
            .register_candidate(&second_candidate)
            .expect("duplicate registration");

        assert!(!first.duplicate);
        assert!(second.duplicate);
        assert_eq!(first.workspace.workspace_id, second.workspace.workspace_id);
        assert_eq!(store.private_workspace_records().expect("records").len(), 1);
        store
            .select_workspace(&first.workspace.workspace_id)
            .expect("select registered workspace");
        assert_eq!(
            store.snapshot(None).expect("snapshot").active_workspace_id,
            Some(first.workspace.workspace_id)
        );

        drop(store);
        let reopened = WorkspaceHistoryStore::open(&data).expect("reopen store");
        assert_eq!(
            reopened.private_workspace_records().expect("records").len(),
            1
        );
        let editable = reopened
            .load_editable_context(
                &reopened.private_workspace_records().expect("records")[0].workspace_id,
            )
            .expect("migrated editable context");
        assert_eq!(editable.project.version, 1);
        assert_eq!(editable.project.content_hash, DEFAULT_PROJECT_HASH);
        assert_eq!(editable.character.context, CharacterContext::default());
        let _ = fs::remove_dir_all(data);
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn unregister_hides_registration_without_deleting_workspace_history() {
        let data = temp_directory("history-unregister");
        let root = git_repository();
        let store = WorkspaceHistoryStore::open(&data).expect("open store");
        let registration = store
            .register_candidate(&candidate(&root).await)
            .expect("registration");
        let workspace_id = registration.workspace.workspace_id;
        let sibling = store
            .create_session_workspace(
                &workspace_id,
                "Sibling session",
                "Preserve this goal",
                "request-unregister-sibling",
            )
            .expect("sibling session");
        store
            .save_draft(&workspace_id, "Preserved draft", ReasoningEffort::Max, 0)
            .expect("draft");

        let hidden = store
            .unregister_project(&workspace_id)
            .expect("unregister project");
        assert!(hidden.workspaces.is_empty());
        assert_eq!(hidden.active_workspace_id, None);
        assert_eq!(
            store
                .load_editable_context(&workspace_id)
                .expect("preserved editable context")
                .workspace_id,
            workspace_id
        );
        assert!(!store
            .timeline(&sibling.workspace.workspace_id, None, 200, None)
            .expect("preserved timeline")
            .items
            .is_empty());

        let restored = store
            .register_candidate(&candidate(&root).await)
            .expect("re-register project");
        assert!(restored.duplicate);
        let state = store.snapshot(None).expect("restored state");
        assert_eq!(state.workspaces.len(), 2);
        assert_eq!(
            store
                .select_workspace(&workspace_id)
                .expect("select restored workspace")
                .draft
                .expect("preserved draft")
                .text,
            "Preserved draft"
        );

        let _ = fs::remove_dir_all(data);
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn registered_same_path_replacement_is_rejected_without_relinking_history() {
        let data = temp_directory("history-registered-replacement");
        let root = git_repository();
        fs::write(root.join("README.md"), "preserve source\n").expect("source fixture");
        let store = WorkspaceHistoryStore::open(&data).expect("open store");
        let registration = store
            .register_candidate(&candidate(&root).await)
            .expect("registration");
        let workspace_id = registration.workspace.workspace_id.clone();
        let project_id = registration.workspace.project_id.clone();
        store
            .save_draft(&workspace_id, "Preserved draft", ReasoningEffort::Max, 0)
            .expect("draft");
        let history_before = store
            .timeline(&workspace_id, None, 200, None)
            .expect("history")
            .items;

        replace_git_directory(&root);
        let source_before = fs::read(root.join("README.md")).expect("source before");
        let head_before = fs::read(root.join(".git/HEAD")).expect("HEAD before");
        let status_before = git_status(&root);
        let error = store
            .register_candidate(&candidate(&root).await)
            .expect_err("replacement must not reuse a registered project");

        assert_eq!(error.code, "WORKSPACE-PROJECT-IDENTITY-CHANGED");
        let snapshot = store
            .select_workspace(&workspace_id)
            .expect("original workspace remains registered");
        assert_eq!(snapshot.workspaces[0].project_id, project_id);
        assert_eq!(snapshot.draft.expect("draft").text, "Preserved draft");
        assert_eq!(
            store
                .timeline(&workspace_id, None, 200, None)
                .expect("history after")
                .items,
            history_before
        );
        assert_eq!(
            fs::read(root.join("README.md")).expect("source after"),
            source_before
        );
        assert_eq!(
            fs::read(root.join(".git/HEAD")).expect("HEAD after"),
            head_before
        );
        assert_eq!(git_status(&root), status_before);

        let _ = fs::remove_dir_all(data);
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn replacement_after_unregister_gets_a_fresh_project_history_partition() {
        let data = temp_directory("history-unregistered-replacement");
        let root = git_repository();
        fs::write(root.join("README.md"), "preserve source\n").expect("source fixture");
        let store = WorkspaceHistoryStore::open(&data).expect("open store");
        let original = store
            .register_candidate(&candidate(&root).await)
            .expect("registration");
        let old_workspace_id = original.workspace.workspace_id.clone();
        let old_project_id = original.workspace.project_id.clone();
        store
            .save_draft(
                &old_workspace_id,
                "Old history draft",
                ReasoningEffort::Max,
                0,
            )
            .expect("draft");
        let old_history = store
            .timeline(&old_workspace_id, None, 200, None)
            .expect("old history")
            .items;
        store
            .unregister_project(&old_workspace_id)
            .expect("unregister");

        replace_git_directory(&root);
        let source_before = fs::read(root.join("README.md")).expect("source before");
        let head_before = fs::read(root.join(".git/HEAD")).expect("HEAD before");
        let status_before = git_status(&root);
        let replacement = store
            .register_candidate(&candidate(&root).await)
            .expect("register replacement as new project");

        assert!(!replacement.duplicate);
        assert_ne!(replacement.workspace.project_id, old_project_id);
        assert_ne!(replacement.workspace.workspace_id, old_workspace_id);
        assert_eq!(
            store
                .select_workspace(&replacement.workspace.workspace_id)
                .expect("select replacement")
                .draft
                .expect("replacement draft")
                .text,
            ""
        );
        assert_eq!(
            store
                .load_editable_context(&old_workspace_id)
                .expect("old context remains app-private")
                .workspace_id,
            old_workspace_id
        );
        assert_eq!(
            store
                .timeline(&old_workspace_id, None, 200, None)
                .expect("old history remains app-private")
                .items,
            old_history
        );
        assert_eq!(
            fs::read(root.join("README.md")).expect("source after"),
            source_before
        );
        assert_eq!(
            fs::read(root.join(".git/HEAD")).expect("HEAD after"),
            head_before
        );
        assert_eq!(git_status(&root), status_before);

        let _ = fs::remove_dir_all(data);
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn repair_requires_saved_identity_and_allows_a_same_repository_move() {
        let data = temp_directory("history-repair-identity");
        let root = git_repository();
        fs::write(root.join("README.md"), "preserve source\n").expect("source fixture");
        let store = WorkspaceHistoryStore::open(&data).expect("open store");
        let registration = store
            .register_candidate(&candidate(&root).await)
            .expect("registration");
        let workspace_id = registration.workspace.workspace_id;
        let saved = store
            .private_project_identity(&workspace_id)
            .expect("saved identity");
        let different = git_repository();
        let mismatch = candidate(&different).await;
        let history_before = store
            .timeline(&workspace_id, None, 200, None)
            .expect("history")
            .items;

        let mismatch_error = store
            .repair_project(&workspace_id, &saved, &mismatch)
            .expect_err("different repository must not repair linkage");
        assert_eq!(mismatch_error.code, "WORKSPACE-REPAIR-IDENTITY-CHANGED");
        assert_eq!(
            store
                .private_workspace_record(&workspace_id)
                .expect("unchanged linkage")
                .canonical_root,
            fs::canonicalize(&root).expect("canonical original")
        );
        assert_eq!(
            store
                .timeline(&workspace_id, None, 200, None)
                .expect("unchanged history")
                .items,
            history_before
        );

        let moved = root.with_file_name(format!(
            "coding-wife-history-repo-moved-{}",
            uuid::Uuid::new_v4()
        ));
        fs::rename(&root, &moved).expect("move repository");
        let source_before = fs::read(moved.join("README.md")).expect("source before");
        let head_before = fs::read(moved.join(".git/HEAD")).expect("HEAD before");
        let status_before = git_status(&moved);
        let moved_candidate = candidate(&moved).await;
        let repaired = store
            .repair_project(&workspace_id, &saved, &moved_candidate)
            .expect("same repository move repairs linkage");

        assert_eq!(repaired.workspaces[0].workspace_id, workspace_id);
        assert_eq!(
            store
                .private_workspace_record(&workspace_id)
                .expect("moved linkage")
                .canonical_root,
            fs::canonicalize(&moved).expect("canonical moved")
        );
        assert_eq!(
            fs::read(moved.join("README.md")).expect("source after"),
            source_before
        );
        assert_eq!(
            fs::read(moved.join(".git/HEAD")).expect("HEAD after"),
            head_before
        );
        assert_eq!(git_status(&moved), status_before);

        let _ = fs::remove_dir_all(data);
        let _ = fs::remove_dir_all(moved);
        let _ = fs::remove_dir_all(different);
    }

    #[tokio::test]
    async fn preflight_reports_a_branch_changed_outside_the_app() {
        let data = temp_directory("history-stale-branch");
        let root = git_repository();
        let store = WorkspaceHistoryStore::open(&data).expect("open store");
        let workspace_id = store
            .register_candidate(&candidate(&root).await)
            .expect("registration")
            .workspace
            .workspace_id;
        let status = std::process::Command::new("/usr/bin/git")
            .args([
                "-C",
                root.to_str().expect("root"),
                "switch",
                "-c",
                "outside-app",
            ])
            .status()
            .expect("git switch");
        assert!(status.success());
        let changed = candidate(&root).await;

        assert_eq!(
            store
                .update_preflight(&workspace_id, Ok(&changed.git))
                .expect("preflight"),
            WorkspaceHealth::StaleBranch
        );
        assert_eq!(
            store
                .snapshot(Some(&workspace_id))
                .expect("snapshot")
                .workspaces[0]
                .health,
            WorkspaceHealth::StaleBranch
        );
        assert_eq!(
            store
                .accept_preflight(&workspace_id, &changed.git)
                .expect("acknowledge observed branch"),
            WorkspaceHealth::Ready
        );
        let accepted = store
            .snapshot(Some(&workspace_id))
            .expect("accepted branch");
        assert_eq!(accepted.workspaces[0].branch, "outside-app");
        assert_eq!(accepted.workspaces[0].health, WorkspaceHealth::Ready);

        let _ = fs::remove_dir_all(data);
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn preflight_reports_a_head_change_on_the_same_branch_without_mutating_git() {
        let data = temp_directory("history-stale-head");
        let root = git_repository();
        let store = WorkspaceHistoryStore::open(&data).expect("open store");
        let workspace_id = store
            .register_candidate(&candidate(&root).await)
            .expect("registration")
            .workspace
            .workspace_id;
        fs::write(root.join("README.md"), "external commit\n").expect("source fixture");
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
        let changed = candidate(&root).await;
        let head_before = fs::read(root.join(".git/HEAD")).expect("HEAD before observation");
        let status_before = git_status(&root);

        assert_eq!(
            store
                .update_preflight(&workspace_id, Ok(&changed.git))
                .expect("head preflight"),
            WorkspaceHealth::StaleBranch
        );
        let stale = store.snapshot(Some(&workspace_id)).expect("stale snapshot");
        assert_eq!(stale.workspaces[0].head, "unborn");
        assert_eq!(stale.workspaces[0].health, WorkspaceHealth::StaleBranch);
        assert_eq!(
            store
                .accept_preflight(&workspace_id, &changed.git)
                .expect("accept observed HEAD"),
            WorkspaceHealth::Ready
        );
        assert_eq!(
            store
                .snapshot(Some(&workspace_id))
                .expect("ready snapshot")
                .workspaces[0]
                .head,
            changed.git.head
        );
        assert_eq!(
            fs::read(root.join(".git/HEAD")).expect("HEAD after observation"),
            head_before
        );
        assert_eq!(git_status(&root), status_before);

        let _ = fs::remove_dir_all(data);
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn summaries_and_anchors_restart_for_twenty_workspaces_without_cross_contamination() {
        let data = temp_directory("history-resume-state");
        let root = git_repository();
        let store = WorkspaceHistoryStore::open(&data).expect("open store");
        let first = store
            .register_candidate(&candidate(&root).await)
            .expect("registration")
            .workspace;
        let mut workspace_ids = vec![first.workspace_id.clone()];
        for index in 1..20 {
            workspace_ids.push(
                store
                    .create_session_workspace(
                        &first.workspace_id,
                        &format!("Workspace {index}"),
                        "",
                        &format!("request-resume-{index}"),
                    )
                    .expect("create workspace")
                    .workspace
                    .workspace_id,
            );
        }
        for (index, workspace_id) in workspace_ids.iter().enumerate() {
            let event_id = format!("event-summary-{index}");
            let summary = format!("Summary for workspace {index}");
            let result = store
                .append_event(&NormalizedDomainEvent {
                    schema_version: DOMAIN_EVENT_SCHEMA_VERSION,
                    event_id: event_id.clone(),
                    workspace_id: workspace_id.clone(),
                    session_id: None,
                    producer: "code".to_owned(),
                    kind: "code.message.completed".to_owned(),
                    occurred_at: format!("2026-07-18T00:{index:02}:00.000Z"),
                    payload: json!({
                        "semanticVersion": 1,
                        "generation": 1,
                        "sourceSequence": index as u64 + 1,
                        "itemHandle": format!("item-{index}"),
                        "text": summary,
                    }),
                })
                .expect("append summary");
            let anchor = store
                .save_timeline_anchor(workspace_id, &event_id, result.sequence, index as i64 - 10)
                .expect("save anchor");
            assert_eq!(anchor.workspace_id, *workspace_id);
            assert_eq!(anchor.revision, 1);
            assert!(!anchor.was_clamped);
        }
        drop(store);

        let reopened = WorkspaceHistoryStore::open(&data).expect("reopen store");
        for (index, workspace_id) in workspace_ids.iter().enumerate() {
            let snapshot = reopened
                .snapshot(Some(workspace_id))
                .expect("workspace resume snapshot");
            let resume = snapshot.resume_state.expect("resume state");
            assert_eq!(resume.workspace_id, *workspace_id);
            let summary = resume.last_summary.expect("last summary");
            assert_eq!(summary.workspace_id, *workspace_id);
            assert_eq!(summary.event_id, format!("event-summary-{index}"));
            assert_eq!(summary.text, format!("Summary for workspace {index}"));
            let anchor = resume.timeline_anchor.expect("timeline anchor");
            assert_eq!(anchor.workspace_id, *workspace_id);
            assert_eq!(anchor.event_id, format!("event-summary-{index}"));
            assert_eq!(anchor.offset, index as i64 - 10);
            assert!(!anchor.was_clamped);
            assert!(snapshot
                .timeline
                .items
                .iter()
                .all(|event| event.workspace_id == *workspace_id));
        }

        let clamped_workspace = &workspace_ids[0];
        {
            let inner = reopened.lock();
            inner
                .connection
                .execute(
                    "DELETE FROM domain_events WHERE workspace_id = ?1 AND event_id = ?2",
                    params![clamped_workspace, "event-summary-0"],
                )
                .expect("simulate retention");
        }
        let clamped = reopened
            .snapshot(Some(clamped_workspace))
            .expect("clamped snapshot")
            .resume_state
            .expect("resume state")
            .timeline_anchor
            .expect("clamped anchor");
        assert!(clamped.was_clamped);
        assert_eq!(clamped.sequence, 1);
        assert_ne!(clamped.event_id, "event-summary-0");
        assert_eq!(
            reopened
                .snapshot(Some(&workspace_ids[1]))
                .expect("unaffected workspace")
                .resume_state
                .expect("unaffected resume")
                .timeline_anchor
                .expect("unaffected anchor")
                .event_id,
            "event-summary-1"
        );

        let _ = fs::remove_dir_all(data);
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn restart_keeps_an_anchor_outside_the_latest_page_for_bounded_pagination() {
        let data = temp_directory("history-anchor-pagination");
        let root = git_repository();
        let store = WorkspaceHistoryStore::open(&data).expect("open store");
        let workspace_id = store
            .register_candidate(&candidate(&root).await)
            .expect("registration")
            .workspace
            .workspace_id;
        let mut anchor_sequence = 0;
        for index in 0..225 {
            let event_id = format!("event-page-{index}");
            let appended = store
                .append_event(&NormalizedDomainEvent {
                    schema_version: DOMAIN_EVENT_SCHEMA_VERSION,
                    event_id: event_id.clone(),
                    workspace_id: workspace_id.clone(),
                    session_id: None,
                    producer: "code".to_owned(),
                    kind: "code.message.completed".to_owned(),
                    occurred_at: "2026-07-18T00:00:00.000Z".to_owned(),
                    payload: json!({
                        "semanticVersion": 1,
                        "generation": 1,
                        "sourceSequence": index + 1,
                        "itemHandle": format!("item-page-{index}"),
                        "text": format!("Page summary {index}"),
                    }),
                })
                .expect("append paged event");
            if index == 0 {
                anchor_sequence = appended.sequence;
                store
                    .save_timeline_anchor(&workspace_id, &event_id, appended.sequence, 17)
                    .expect("save old anchor");
            }
        }

        let snapshot = store.snapshot(Some(&workspace_id)).expect("snapshot");
        assert_eq!(snapshot.timeline.items.len(), MAX_TIMELINE_PAGE as usize);
        assert!(!snapshot
            .timeline
            .items
            .iter()
            .any(|event| event.event_id == "event-page-0"));
        let cursor = snapshot
            .timeline
            .next_before_sequence
            .expect("older page cursor");
        let anchor = snapshot
            .resume_state
            .expect("resume state")
            .timeline_anchor
            .expect("timeline anchor");
        assert_eq!(anchor.event_id, "event-page-0");
        assert_eq!(anchor.sequence, anchor_sequence);
        assert!(!anchor.was_clamped);

        let older = store
            .timeline(&workspace_id, Some(cursor), MAX_TIMELINE_PAGE, None)
            .expect("older page");
        assert!(older
            .items
            .iter()
            .any(|event| event.event_id == "event-page-0"));
        assert!(older
            .items
            .iter()
            .all(|event| event.workspace_id == workspace_id));

        let _ = fs::remove_dir_all(data);
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn legacy_reference_paths_are_canonicalized_but_require_resave() {
        let data = temp_directory("legacy-reference-migration");
        let root = git_repository();
        fs::create_dir_all(root.join("docs")).expect("docs directory");
        fs::write(root.join("docs/guide.md"), "guide").expect("guide");
        let store = WorkspaceHistoryStore::open(&data).expect("open store");
        let workspace_id = store
            .register_candidate(&candidate(&root).await)
            .expect("registration")
            .workspace
            .workspace_id;
        let legacy = ProjectContext {
            technical_references: vec!["./docs//guide.md".to_owned()],
            ..ProjectContext::default()
        };
        let legacy_json = serde_json::to_string(&legacy).expect("legacy json");
        let legacy_hash = content_hash(&legacy_json);
        {
            let inner = store.lock();
            inner
                .connection
                .execute(
                    "UPDATE workspace_contexts
                     SET project_json = ?1, project_hash = ?2,
                         project_reference_manifest_json = NULL
                     WHERE workspace_id = ?3",
                    params![legacy_json, legacy_hash, workspace_id],
                )
                .expect("legacy record");
        }
        drop(store);

        let reopened = WorkspaceHistoryStore::open(&data).expect("migrated store");
        let restored = reopened
            .load_editable_context(&workspace_id)
            .expect("canonical legacy context");
        assert_eq!(
            restored.project.context.technical_references,
            ["docs/guide.md"]
        );
        let validation = reference_validation(&root);
        assert_eq!(
            reopened
                .turn_context_snapshot(&workspace_id, &validation)
                .expect_err("unverified legacy identity blocked")
                .code,
            "WORKSPACE-PROJECT-CONTEXT-REFERENCE-CHANGED"
        );
        let _ = fs::remove_dir_all(data);
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn editable_context_is_versioned_atomic_restart_safe_and_workspace_scoped() {
        let data = temp_directory("editable-context");
        let root = git_repository();
        let store = WorkspaceHistoryStore::open(&data).expect("open store");
        let first = store
            .register_candidate(&candidate(&root).await)
            .expect("registration")
            .workspace;
        let second = store
            .create_session_workspace(
                &first.workspace_id,
                "Second context",
                "",
                "request-editable-context-second",
            )
            .expect("second workspace")
            .workspace;

        let project = ProjectContext {
            goal: "Ship the context slice".to_owned(),
            constraints: "Do not mutate another workspace".to_owned(),
            definition_of_done: vec!["Restart restores the same version".to_owned()],
            technical_references: vec!["docs/requirements/workspace-sessions.md".to_owned()],
            user_notes: "Apply on the next turn".to_owned(),
        };
        fs::create_dir_all(root.join("docs/requirements")).expect("reference directory");
        fs::write(
            root.join("docs/requirements/workspace-sessions.md"),
            "reference",
        )
        .expect("reference file");
        let reference_validation = reference_validation(&root);
        let reference_manifest =
            capture_project_reference_manifest(&project, &reference_validation)
                .expect("reference manifest");
        let saved = store
            .save_project_context(
                &first.workspace_id,
                1,
                project.clone(),
                Some(reference_manifest),
            )
            .expect("save project context");
        assert_eq!(saved.version, 2);
        assert_eq!(saved.context, project);
        assert_eq!(
            store
                .save_project_context(&first.workspace_id, 1, ProjectContext::default(), None,)
                .expect_err("stale save rejected")
                .code,
            "WORKSPACE-PROJECT-CONTEXT-CONFLICT"
        );
        assert_eq!(
            store
                .load_editable_context(&second.workspace_id)
                .expect("isolated second context")
                .project
                .context,
            ProjectContext::default()
        );

        let policy = CharacterContext {
            behavior: "permission: always allow".to_owned(),
            ..CharacterContext::default()
        };
        assert_eq!(
            store
                .save_character_context(&first.workspace_id, 1, policy)
                .expect_err("policy key rejected")
                .code,
            "WORKSPACE-CHARACTER-CONTEXT-POLICY"
        );
        let character = CharacterContext {
            display_name: "Hiyori".to_owned(),
            behavior: "Stay quiet while tools are running.".to_owned(),
            ..CharacterContext::default()
        };
        let character_saved = store
            .save_character_context(&first.workspace_id, 1, character.clone())
            .expect("save character context");
        assert_eq!(character_saved.version, 2);
        let snapshot = store
            .turn_context_snapshot(&first.workspace_id, &reference_validation)
            .expect("immutable turn snapshot");
        assert_eq!(snapshot.project_version, 2);
        assert_eq!(snapshot.character_version, 2);
        assert_eq!(snapshot.project, project);
        assert_eq!(snapshot.character, character);
        validate_turn_snapshot(&snapshot).expect("snapshot integrity");

        drop(store);
        let reopened = WorkspaceHistoryStore::open(&data).expect("reopen store");
        let restored = reopened
            .load_editable_context(&first.workspace_id)
            .expect("restore context");
        assert_eq!(restored.project.version, 2);
        assert_eq!(restored.project.content_hash, snapshot.project_hash);
        assert_eq!(restored.character.version, 2);
        assert_eq!(restored.character.content_hash, snapshot.character_hash);
        reopened
            .turn_context_snapshot(&first.workspace_id, &reference_validation)
            .expect("restored private reference identity");

        let _ = fs::remove_dir_all(data);
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn concurrent_expected_version_writes_have_one_winner() {
        let data = temp_directory("editable-context-conflict");
        let root = git_repository();
        let store = WorkspaceHistoryStore::open(&data).expect("open store");
        let workspace = store
            .register_candidate(&candidate(&root).await)
            .expect("registration")
            .workspace;
        let workspace_id = workspace.workspace_id;
        let first_store = store.clone();
        let first_workspace = workspace_id.clone();
        let first = thread::spawn(move || {
            first_store.save_project_context(
                &first_workspace,
                1,
                ProjectContext {
                    goal: "first".to_owned(),
                    ..ProjectContext::default()
                },
                None,
            )
        });
        let second_store = store.clone();
        let second_workspace = workspace_id.clone();
        let second = thread::spawn(move || {
            second_store.save_project_context(
                &second_workspace,
                1,
                ProjectContext {
                    goal: "second".to_owned(),
                    ..ProjectContext::default()
                },
                None,
            )
        });
        let outcomes = [
            first.join().expect("first join"),
            second.join().expect("second join"),
        ];
        assert_eq!(outcomes.iter().filter(|outcome| outcome.is_ok()).count(), 1);
        assert_eq!(
            outcomes
                .iter()
                .filter_map(|outcome| outcome.as_ref().err())
                .next()
                .expect("one conflict")
                .code,
            "WORKSPACE-PROJECT-CONTEXT-CONFLICT"
        );
        assert_eq!(
            store
                .load_editable_context(&workspace_id)
                .expect("winner persisted")
                .project
                .version,
            2
        );

        let _ = fs::remove_dir_all(data);
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn restart_marks_only_unfinished_turns_interrupted_once() {
        let data = temp_directory("unfinished-turn-recovery");
        let root = git_repository();
        let store = WorkspaceHistoryStore::open(&data).expect("open store");
        let workspace = store
            .register_candidate(&candidate(&root).await)
            .expect("registration")
            .workspace;
        let session_id = store
            .timeline(&workspace.workspace_id, None, 10, None)
            .expect("initial timeline")
            .items
            .first()
            .and_then(|event| event.session_id.clone())
            .expect("workspace session");
        store
            .save_draft(
                &workspace.workspace_id,
                "preserved draft",
                ReasoningEffort::Max,
                0,
            )
            .expect("save draft");
        store
            .append_event(&NormalizedDomainEvent {
                schema_version: DOMAIN_EVENT_SCHEMA_VERSION,
                event_id: "event-unfinished-turn".to_owned(),
                workspace_id: workspace.workspace_id.clone(),
                session_id: Some(session_id),
                producer: "code".to_owned(),
                kind: "code.session.status.changed".to_owned(),
                occurred_at: "2026-07-18T00:00:01.000Z".to_owned(),
                payload: codex_turn_payload("running", 4),
            })
            .expect("append running turn");
        drop(store);

        let reopened = WorkspaceHistoryStore::open(&data).expect("reopen store");
        assert_eq!(
            reopened
                .force_shutdown_now()
                .expect("force shutdown recovers and checkpoints"),
            1
        );
        assert_eq!(
            reopened
                .force_shutdown_now()
                .expect("idempotent force shutdown"),
            0
        );
        assert_eq!(
            reopened
                .issue_delete_challenge(&workspace.workspace_id)
                .expect_err("shutdown admission gate rejects late writes")
                .code,
            "HIST-SHUTTING-DOWN"
        );
        let snapshot = reopened
            .snapshot(Some(&workspace.workspace_id))
            .expect("recovered snapshot");
        assert_eq!(
            snapshot.draft.as_ref().map(|draft| draft.text.as_str()),
            Some("preserved draft")
        );
        let terminal = snapshot
            .timeline
            .items
            .iter()
            .rev()
            .find(|event| event.kind == "code.session.status.changed")
            .expect("terminal recovery event");
        assert_eq!(
            terminal.payload.get("status").and_then(Value::as_str),
            Some("interrupted")
        );
        assert_eq!(
            terminal
                .payload
                .get("sourceSequence")
                .and_then(Value::as_u64),
            Some(5)
        );
        let _ = fs::remove_dir_all(data);
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn drafts_context_and_events_remain_workspace_scoped_and_redacted() {
        let data = temp_directory("history-scope");
        let root = git_repository();
        let store = WorkspaceHistoryStore::open(&data).expect("open store");
        let registered = store
            .register_candidate(&candidate(&root).await)
            .expect("registration");
        let second = store
            .create_session_workspace(
                &registered.workspace.workspace_id,
                "Second session",
                "",
                "request-second",
            )
            .expect("second workspace");
        let draft = store
            .save_draft(
                &registered.workspace.workspace_id,
                "first draft",
                ReasoningEffort::Max,
                0,
            )
            .expect("save draft");
        assert_eq!(draft.text, "first draft");
        assert_eq!(
            store
                .snapshot(Some(&second.workspace.workspace_id))
                .expect("second snapshot")
                .draft
                .unwrap()
                .text,
            ""
        );

        let secret = "Bearer hidden-token /\u{0055}sers/private/repository/file.rs";
        let context = store
            .save_context_snapshot(
                &registered.workspace.workspace_id,
                ContextSource::GitDiff,
                "Current diff",
                secret,
            )
            .expect("redacted context");
        assert!(context.byte_count > 0);
        for entry in fs::read_dir(&data).expect("history directory") {
            let path = entry.expect("history file").path();
            if !path.is_file() {
                continue;
            }
            let bytes = fs::read(path).expect("history bytes");
            let text = String::from_utf8_lossy(&bytes);
            assert!(!text.contains("hidden-token"));
            assert!(!text.contains("/\u{0055}sers/private"));
        }

        let event = NormalizedDomainEvent {
            schema_version: 1,
            event_id: "event-idempotent".to_owned(),
            workspace_id: registered.workspace.workspace_id.clone(),
            session_id: None,
            producer: "code".to_owned(),
            kind: "code.session.status.changed".to_owned(),
            occurred_at: now(),
            payload: codex_turn_payload("running", 1),
        };
        let inserted = store.append_event(&event).expect("append event");
        let duplicate = store.append_event(&event).expect("duplicate event");
        assert!(inserted.inserted);
        assert!(!duplicate.inserted);
        assert_eq!(inserted.sequence, duplicate.sequence);

        let _ = fs::remove_dir_all(data);
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn event_replay_requires_an_exact_match_and_sessions_cannot_cross_workspaces() {
        let data = temp_directory("history-event-replay");
        let root = git_repository();
        let store = WorkspaceHistoryStore::open(&data).expect("open store");
        let first = store
            .register_candidate(&candidate(&root).await)
            .expect("registration")
            .workspace;
        let second = store
            .create_session_workspace(
                &first.workspace_id,
                "Second session",
                "",
                "request-event-replay",
            )
            .expect("second workspace")
            .workspace;
        let first_session_id = {
            let inner = store.lock();
            inner
                .connection
                .query_row(
                    "SELECT id FROM sessions WHERE workspace_id = ?1 ORDER BY created_at ASC LIMIT 1",
                    params![first.workspace_id],
                    |row| row.get::<_, String>(0),
                )
                .expect("first session")
        };
        let event = NormalizedDomainEvent {
            schema_version: DOMAIN_EVENT_SCHEMA_VERSION,
            event_id: "event-strict-replay".to_owned(),
            workspace_id: first.workspace_id.clone(),
            session_id: Some(first_session_id.clone()),
            producer: "code".to_owned(),
            kind: "code.session.status.changed".to_owned(),
            occurred_at: "2026-07-18T00:00:00.000Z".to_owned(),
            payload: codex_turn_payload("running", 1),
        };
        assert!(store.append_event(&event).expect("first append").inserted);
        assert!(!store.append_event(&event).expect("exact replay").inserted);

        let conflicting_events = [
            NormalizedDomainEvent {
                payload: codex_turn_payload("completed", 1),
                ..event.clone()
            },
            NormalizedDomainEvent {
                occurred_at: "2026-07-18T00:00:01.000Z".to_owned(),
                ..event.clone()
            },
            NormalizedDomainEvent {
                schema_version: DOMAIN_EVENT_SCHEMA_VERSION + 1,
                ..event.clone()
            },
            NormalizedDomainEvent {
                session_id: None,
                ..event.clone()
            },
            NormalizedDomainEvent {
                workspace_id: second.workspace_id.clone(),
                ..event.clone()
            },
            NormalizedDomainEvent {
                producer: "hist".to_owned(),
                kind: "hist.writer.status.changed".to_owned(),
                payload: json!({ "status": "ready" }),
                ..event.clone()
            },
        ];
        for conflict in conflicting_events {
            assert_eq!(
                store.append_event(&conflict).unwrap_err().code,
                "HIST-EVENT-IDEMPOTENCY-CONFLICT"
            );
        }

        let cross_workspace_event = NormalizedDomainEvent {
            event_id: "event-cross-workspace-session".to_owned(),
            workspace_id: second.workspace_id,
            session_id: Some(first_session_id),
            ..event
        };
        assert_eq!(
            store.append_event(&cross_workspace_event).unwrap_err().code,
            "HIST-EVENT-SESSION-WORKSPACE"
        );

        let _ = fs::remove_dir_all(data);
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn rich_codex_events_use_an_exact_bounded_allowlist_and_are_redacted() {
        let data = temp_directory("history-codex-events");
        let root = git_repository();
        let store = WorkspaceHistoryStore::open(&data).expect("open store");
        let workspace = store
            .register_candidate(&candidate(&root).await)
            .expect("registration")
            .workspace;
        let events = [
            (
                "code.thread.status.changed",
                json!({"semanticVersion": 1, "generation": 1, "sourceSequence": 1, "threadHandle": "thread-safe", "status": "active"}),
            ),
            (
                "code.session.status.changed",
                json!({"semanticVersion": 1, "generation": 1, "sourceSequence": 2, "threadHandle": "thread-safe", "turnHandle": "turn-safe", "status": "running"}),
            ),
            (
                "code.user.instruction.accepted",
                json!({"semanticVersion": 1, "generation": 1, "sourceSequence": 3, "text": "Inspect the project.\n\tKeep notes 😀", "effort": "low", "attachmentCount": 1}),
            ),
            (
                "code.item.status.changed",
                json!({"semanticVersion": 1, "generation": 1, "sourceSequence": 4, "itemHandle": "item-safe", "itemType": "commandExecution", "status": "running"}),
            ),
            (
                "code.message.completed",
                json!({"semanticVersion": 1, "generation": 1, "sourceSequence": 5, "itemHandle": "item-message", "text": "Done\nVerified 😀"}),
            ),
            (
                "code.plan.updated",
                json!({"semanticVersion": 1, "generation": 1, "sourceSequence": 6, "stepCount": 3}),
            ),
            (
                "code.diff.updated",
                json!({"semanticVersion": 1, "generation": 1, "sourceSequence": 7, "byteCount": 42, "detailRef": "detail-diff"}),
            ),
            (
                "code.tool.output",
                json!({"semanticVersion": 1, "generation": 1, "sourceSequence": 8, "itemHandle": "item-tool", "excerpt": "checks passed\n\t32 total 😀"}),
            ),
            (
                "code.file_change.updated",
                json!({"semanticVersion": 1, "generation": 1, "sourceSequence": 9, "itemHandle": "item-file", "pathAlias": "project/src/main.rs", "changeKind": "update"}),
            ),
            (
                "code.decision.requested",
                json!({"semanticVersion": 1, "generation": 1, "sourceSequence": 10, "request": {
                    "pendingId": "pending-decision",
                    "kind": "user_input",
                    "responseKind": "fallback_decision",
                    "operation": "decision_fallback",
                    "targetAlias": "active_turn",
                    "reason": "Choose the safe next step.",
                    "questions": [{
                        "id": "decision",
                        "header": "Decision",
                        "question": "Continue?\nReview the evidence.",
                        "options": [
                            {"id": "continue", "label": "Continue", "description": "Apply the bounded change."},
                            {"id": "stop", "label": "Stop", "description": "Keep the current state."}
                        ]
                    }],
                    "allowedDecisions": [],
                    "decisionContext": {
                        "schemaVersion": 1,
                        "category": "user_decision",
                        "targetKind": "active_turn",
                        "targetAlias": "active_turn",
                        "effect": "continue_turn",
                        "scope": "turn",
                        "risk": "medium",
                        "reversibility": "unknown",
                        "recommendation": "continue",
                        "evidence": ["The next step is bounded and reviewable."],
                        "uncertainty": "limited_context"
                    }
                }}),
            ),
            (
                "code.approval.requested",
                json!({"semanticVersion": 1, "generation": 1, "sourceSequence": 11, "request": {
                    "pendingId": "pending-approval",
                    "kind": "command_approval",
                    "responseKind": "native_server_request",
                    "operation": "item/commandExecution/requestApproval",
                    "targetAlias": "project_command",
                    "reason": null,
                    "questions": [],
                    "allowedDecisions": ["approve_once", "reject", "stop"],
                    "decisionContext": {
                        "schemaVersion": 1,
                        "category": "command_execution",
                        "targetKind": "workspace",
                        "targetAlias": "project_command",
                        "effect": "execute_command",
                        "scope": "command",
                        "risk": "medium",
                        "reversibility": "reversible",
                        "recommendation": "approve_once",
                        "evidence": ["workspace_command"],
                        "uncertainty": "none"
                    }
                }}),
            ),
            (
                "code.pending.resolved",
                json!({"semanticVersion": 1, "generation": 1, "sourceSequence": 12, "pendingId": "pending-approval", "status": "accepted"}),
            ),
            (
                "code.session.diagnostic",
                json!({"semanticVersion": 1, "generation": 1, "sourceSequence": 13, "code": "CODEX-WARNING", "willRetry": true, "detailRef": "detail-warning"}),
            ),
            (
                "code.model.violation",
                json!({"semanticVersion": 1, "generation": 1, "sourceSequence": 14, "fromModel": "unexpected", "toModel": "gpt-5.6-sol"}),
            ),
            (
                "code.protocol.unsupported",
                json!({"semanticVersion": 1, "generation": 1, "sourceSequence": 15, "methodHash": "method-deadbeef", "byteCount": 24, "detailRef": "detail-protocol"}),
            ),
        ];

        for (index, (kind, payload)) in events.into_iter().enumerate() {
            store
                .append_event(&NormalizedDomainEvent {
                    schema_version: DOMAIN_EVENT_SCHEMA_VERSION,
                    event_id: format!("event-codex-{index}"),
                    workspace_id: workspace.workspace_id.clone(),
                    session_id: None,
                    producer: "code".to_owned(),
                    kind: kind.to_owned(),
                    occurred_at: format!("2026-07-18T00:00:{index:02}.000Z"),
                    payload,
                })
                .expect("allowed Codex event");
        }

        let timeline = store
            .timeline(&workspace.workspace_id, None, 200, None)
            .expect("timeline");
        let encoded = serde_json::to_string(&timeline).expect("timeline JSON");
        assert!(!encoded.contains("/\u{0055}sers/private"));
        assert!(encoded.contains("code.approval.requested"));

        let rejected = NormalizedDomainEvent {
            schema_version: DOMAIN_EVENT_SCHEMA_VERSION,
            event_id: "event-codex-invalid".to_owned(),
            workspace_id: workspace.workspace_id.clone(),
            session_id: None,
            producer: "code".to_owned(),
            kind: "code.tool.output".to_owned(),
            occurred_at: "2026-07-18T00:01:00.000Z".to_owned(),
            payload: json!({"semanticVersion": 1, "generation": 1, "sourceSequence": 16, "itemHandle": "item-tool", "excerpt": "ok", "rawStderr": "forbidden"}),
        };
        assert_eq!(
            store.append_event(&rejected).unwrap_err().code,
            "HIST-EVENT-PAYLOAD"
        );

        for (index, excerpt) in [
            "contains\rreturn",
            "contains\u{0007}bell",
            "/\u{0055}sers/private/project/file.rs",
            "Bearer hidden-token",
        ]
        .into_iter()
        .enumerate()
        {
            let invalid_public_text = NormalizedDomainEvent {
                schema_version: DOMAIN_EVENT_SCHEMA_VERSION,
                event_id: format!("event-codex-private-{index}"),
                workspace_id: workspace.workspace_id.clone(),
                session_id: None,
                producer: "code".to_owned(),
                kind: "code.tool.output".to_owned(),
                occurred_at: format!("2026-07-18T00:02:{index:02}.000Z"),
                payload: json!({
                    "semanticVersion": 1,
                    "generation": 1,
                    "sourceSequence": 20 + index,
                    "itemHandle": "item-tool",
                    "excerpt": excerpt,
                }),
            };
            assert_eq!(
                store.append_event(&invalid_public_text).unwrap_err().code,
                "HIST-EVENT-PAYLOAD"
            );
        }

        let unknown_semantic_version = NormalizedDomainEvent {
            schema_version: DOMAIN_EVENT_SCHEMA_VERSION,
            event_id: "event-codex-future-semantic".to_owned(),
            workspace_id: workspace.workspace_id.clone(),
            session_id: None,
            producer: "code".to_owned(),
            kind: "code.plan.updated".to_owned(),
            occurred_at: "2026-07-18T00:03:00.000Z".to_owned(),
            payload: json!({
                "semanticVersion": 2,
                "generation": 1,
                "sourceSequence": 30,
                "stepCount": 1,
            }),
        };
        assert_eq!(
            store
                .append_event(&unknown_semantic_version)
                .unwrap_err()
                .code,
            "HIST-EVENT-PAYLOAD"
        );

        let _ = fs::remove_dir_all(data);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn codex_public_text_counts_unicode_scalars_and_allows_only_normalized_multiline_controls() {
        assert!(public_multiline("first line\n\tsecond 😀", 20, false));
        assert!(public_multiline(&"😀".repeat(4), 4, false));
        assert!(!public_multiline(&"😀".repeat(5), 4, false));
        assert!(!public_multiline("line\r\n", 20, false));
        assert!(!public_single_line("line\n", 20, false));
    }

    #[tokio::test]
    async fn git_history_events_require_exact_versioned_owned_payloads() {
        let data = temp_directory("history-git-events");
        let root = git_repository();
        let store = WorkspaceHistoryStore::open(&data).expect("open store");
        let workspace = store
            .register_candidate(&candidate(&root).await)
            .expect("registration")
            .workspace;
        let observation_payload = git_observation_payload(&workspace.workspace_id);
        let evidence_payload = git_commit_evidence_payload(&workspace.workspace_id);
        let work_unit_payload = git_work_unit_payload(&workspace.workspace_id);
        let parsed_evidence =
            serde_json::from_value::<CommitEvidenceDetail>(evidence_payload.clone())
                .expect("typed commit evidence fixture");
        assert!(validate_git_commit_evidence(
            &parsed_evidence,
            &workspace.workspace_id
        ));
        let observation = NormalizedDomainEvent {
            schema_version: DOMAIN_EVENT_SCHEMA_VERSION,
            event_id: "git-observation-fixture".to_owned(),
            workspace_id: workspace.workspace_id.clone(),
            session_id: None,
            producer: "git".to_owned(),
            kind: "git.observation.recorded".to_owned(),
            occurred_at: "2026-07-18T00:00:01.000Z".to_owned(),
            payload: observation_payload.clone(),
        };
        let evidence = NormalizedDomainEvent {
            schema_version: DOMAIN_EVENT_SCHEMA_VERSION,
            event_id: "git-evidence-fixture".to_owned(),
            workspace_id: workspace.workspace_id.clone(),
            session_id: None,
            producer: "git".to_owned(),
            kind: "git.commit_evidence.recorded".to_owned(),
            occurred_at: "2026-07-18T00:00:03.000Z".to_owned(),
            payload: evidence_payload.clone(),
        };
        let work_unit = NormalizedDomainEvent {
            schema_version: DOMAIN_EVENT_SCHEMA_VERSION,
            event_id: "git-work-unit-fixture".to_owned(),
            workspace_id: workspace.workspace_id.clone(),
            session_id: None,
            producer: "git".to_owned(),
            kind: "git.work_unit.observed".to_owned(),
            occurred_at: "2026-07-18T00:00:04.000Z".to_owned(),
            payload: work_unit_payload,
        };

        assert!(
            store
                .append_event(&observation)
                .expect("observation event")
                .inserted
        );
        assert!(
            store
                .append_event(&evidence)
                .expect("commit evidence")
                .inserted
        );
        assert!(store.append_event(&work_unit).expect("work unit").inserted);
        assert!(
            !store
                .append_event(&evidence)
                .expect("exact evidence replay")
                .inserted
        );

        let extra_field = NormalizedDomainEvent {
            event_id: "git-observation-extra-field".to_owned(),
            payload: {
                let mut payload = observation_payload;
                payload
                    .as_object_mut()
                    .expect("observation object")
                    .insert("rawCommand".to_owned(), json!("git commit"));
                payload
            },
            ..observation.clone()
        };
        assert_eq!(
            store.append_event(&extra_field).unwrap_err().code,
            "HIST-EVENT-PAYLOAD"
        );

        let wrong_workspace = NormalizedDomainEvent {
            event_id: "git-evidence-wrong-workspace".to_owned(),
            payload: {
                let mut payload = evidence_payload.clone();
                payload
                    .as_object_mut()
                    .expect("evidence object")
                    .insert("workspaceId".to_owned(), json!("workspace-other"));
                payload
            },
            ..evidence.clone()
        };
        assert_eq!(
            store.append_event(&wrong_workspace).unwrap_err().code,
            "HIST-EVENT-PAYLOAD"
        );

        let invalid_skill = NormalizedDomainEvent {
            event_id: "git-evidence-invalid-skill".to_owned(),
            payload: {
                let mut payload = evidence_payload;
                payload["commitSkillInjection"]["skillId"] = json!("untrusted-skill");
                payload
            },
            ..evidence
        };
        assert_eq!(
            store.append_event(&invalid_skill).unwrap_err().code,
            "HIST-EVENT-PAYLOAD"
        );

        let timeline = store
            .timeline(&workspace.workspace_id, None, 200, None)
            .expect("timeline");
        assert!(timeline
            .items
            .iter()
            .any(|event| event.kind == "git.observation.recorded"));
        assert!(timeline
            .items
            .iter()
            .any(|event| event.kind == "git.commit_evidence.recorded"));
        assert!(timeline
            .items
            .iter()
            .any(|event| event.kind == "git.work_unit.observed"));

        let _ = fs::remove_dir_all(data);
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn bounded_context_retains_only_the_latest_ten_snapshots() {
        let data = temp_directory("history-context-bound");
        let root = git_repository();
        let store = WorkspaceHistoryStore::open(&data).expect("open store");
        let workspace = store
            .register_candidate(&candidate(&root).await)
            .expect("registration")
            .workspace;
        for index in 0..12 {
            store
                .save_context_snapshot(
                    &workspace.workspace_id,
                    ContextSource::Files,
                    &format!("Snapshot {index}"),
                    &format!("content {index}"),
                )
                .expect("context");
        }
        assert_eq!(
            store
                .snapshot(Some(&workspace.workspace_id))
                .expect("snapshot")
                .context_snapshots
                .len(),
            10
        );
        let _ = fs::remove_dir_all(data);
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn concurrent_event_writes_have_unique_monotonic_sequences() {
        let data = temp_directory("history-concurrent");
        let root = git_repository();
        let store = WorkspaceHistoryStore::open(&data).expect("open store");
        let workspace_id = store
            .register_candidate(&candidate(&root).await)
            .expect("registration")
            .workspace
            .workspace_id;
        let mut threads = Vec::new();
        for index in 0..32 {
            let store = store.clone();
            let workspace_id = workspace_id.clone();
            threads.push(thread::spawn(move || {
                store.append_event(&NormalizedDomainEvent {
                    schema_version: 1,
                    event_id: format!("event-concurrent-{index}"),
                    workspace_id,
                    session_id: None,
                    producer: "code".to_owned(),
                    kind: "code.session.status.changed".to_owned(),
                    occurred_at: now(),
                    payload: codex_turn_payload("running", index + 1),
                })
            }));
        }
        for handle in threads {
            handle.join().expect("writer thread").expect("event write");
        }
        let page = store
            .timeline(&workspace_id, None, 200, None)
            .expect("timeline");
        let sequences = page
            .items
            .iter()
            .map(|event| event.sequence)
            .collect::<Vec<_>>();
        assert!(sequences.windows(2).all(|window| window[0] < window[1]));
        assert_eq!(
            sequences
                .iter()
                .copied()
                .collect::<std::collections::HashSet<_>>()
                .len(),
            sequences.len()
        );
        let _ = fs::remove_dir_all(data);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn corrupt_database_is_backed_up_and_never_reinitialized_in_place() {
        let data = temp_directory("history-corrupt");
        let database = data.join(DATABASE_FILE_NAME);
        fs::write(&database, b"not a sqlite database; preserve me").expect("corrupt fixture");
        let store = WorkspaceHistoryStore::open(&data).expect("recovery store");
        let status = store.status();
        assert_eq!(status.mode, HistoryMode::RecoveryRequired);
        assert_eq!(
            fs::read(&database).expect("original database"),
            b"not a sqlite database; preserve me"
        );
        assert!(status
            .backup_name
            .is_some_and(|name| data.join(name).exists()));
        assert_eq!(
            store
                .save_draft("workspace-missing", "draft", ReasoningEffort::Fast, 0)
                .unwrap_err()
                .code,
            "HIST-READ-ONLY"
        );
        let _ = fs::remove_dir_all(data);
    }

    #[test]
    fn migration_failure_rolls_back_the_transaction() {
        let connection = Connection::open_in_memory().expect("memory database");
        configure_connection(&connection).expect("configure");
        let result = apply_migrations(
            &connection,
            &[(
                1,
                "CREATE TABLE durable(id INTEGER PRIMARY KEY); INSERT INTO missing VALUES (1);",
            )],
        );
        assert!(result.is_err());
        let exists = connection
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'durable'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .expect("schema query");
        assert_eq!(exists, 0);
    }

    #[test]
    fn legacy_versions_migrate_resume_state_and_registration_columns() {
        let connection = Connection::open_in_memory().expect("memory database");
        configure_connection(&connection).expect("configure");
        apply_migrations(&connection, &[(1, MIGRATION_1), (2, MIGRATION_2)])
            .expect("version two schema");
        assert_eq!(
            connection
                .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                .expect("version two"),
            2
        );

        apply_migrations(
            &connection,
            &[(1, MIGRATION_1), (2, MIGRATION_2), (3, MIGRATION_3)],
        )
        .expect("version three schema");
        assert_eq!(
            connection
                .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                .expect("version three"),
            3
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM pragma_table_info('workspace_contexts')
                     WHERE name = 'project_reference_manifest_json'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .expect("manifest column"),
            1
        );

        apply_migrations(
            &connection,
            &[
                (1, MIGRATION_1),
                (2, MIGRATION_2),
                (3, MIGRATION_3),
                (4, MIGRATION_4),
            ],
        )
        .expect("version four schema");
        assert_eq!(
            connection
                .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                .expect("version four"),
            4
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM pragma_table_info('projects')
                     WHERE name = 'registered'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .expect("registered column"),
            1
        );

        apply_migrations(
            &connection,
            &[
                (1, MIGRATION_1),
                (2, MIGRATION_2),
                (3, MIGRATION_3),
                (4, MIGRATION_4),
                (5, MIGRATION_5),
            ],
        )
        .expect("version five schema");
        assert_eq!(
            connection
                .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                .expect("version five"),
            5
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM pragma_table_info('workspace_resume_states')
                     WHERE name IN ('last_summary_event_id', 'timeline_anchor_event_id',
                                    'timeline_anchor_sequence', 'timeline_anchor_offset')",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .expect("resume state columns"),
            4
        );
    }

    #[test]
    fn real_v4_fixture_backfills_twenty_safe_summaries_idempotently() {
        let data = temp_directory("history-v4-summary-backfill");
        let database = data.join(DATABASE_FILE_NAME);
        let expected = {
            let connection = Connection::open(&database).expect("open v4 fixture");
            configure_connection(&connection).expect("configure v4 fixture");
            apply_migrations(
                &connection,
                &[
                    (1, MIGRATION_1),
                    (2, MIGRATION_2),
                    (3, MIGRATION_3),
                    (4, MIGRATION_4),
                ],
            )
            .expect("create real v4 schema");
            let created_at = "2026-07-18T00:00:00.000Z";
            connection
                .execute(
                    "INSERT INTO projects (
                       id, canonical_root, alias, project_identity, root_device, root_inode,
                       git_device, git_inode, branch, head, detached, health,
                       created_at, updated_at, registered
                     ) VALUES (?1, ?2, ?3, ?4, 1, 2, 3, 4, 'main', ?5, 0, 'ready', ?6, ?6, 1)",
                    params![
                        "project-v4-summary",
                        b"/legacy/coding-wife".as_slice(),
                        "legacy-coding-wife",
                        "legacy-project-identity",
                        "0123456789abcdef0123456789abcdef01234567",
                        created_at,
                    ],
                )
                .expect("insert legacy project");
            let mut expected = Vec::new();
            for index in 0..20 {
                let workspace_id = format!("workspace-v4-{index}");
                let session_id = format!("session-v4-{index}");
                let base_event_id = format!("event-v4-{index}-base");
                let base_summary = format!("Legacy summary for workspace {index}");
                let latest_summary = if index == 2 {
                    format!("Latest legacy summary for workspace {index}")
                } else {
                    base_summary.clone()
                };
                let occurred_at = format!("2026-07-18T00:{index:02}:01.000Z");
                connection
                    .execute(
                        "INSERT INTO workspaces (
                           id, project_id, name, goal, lifecycle, attention, health,
                           created_at, updated_at, last_selected_at
                         ) VALUES (?1, 'project-v4-summary', ?2, '', 'backlog', NULL,
                                   'ready', ?3, ?3, NULL)",
                        params![
                            workspace_id,
                            format!("Legacy workspace {index}"),
                            created_at
                        ],
                    )
                    .expect("insert legacy workspace");
                connection
                    .execute(
                        "INSERT INTO sessions (
                           id, workspace_id, client_request_id, status, last_summary,
                           created_at, updated_at
                         ) VALUES (?1, ?2, NULL, 'idle', ?3, ?4, ?4)",
                        params![session_id, workspace_id, latest_summary, created_at],
                    )
                    .expect("insert legacy session summary");
                connection
                    .execute(
                        "INSERT INTO workspace_preferences (
                           workspace_id, draft_text, effort, draft_revision, updated_at
                         ) VALUES (?1, '', 'fast', 0, ?2)",
                        params![workspace_id, created_at],
                    )
                    .expect("insert legacy preferences");
                connection
                    .execute(
                        "INSERT INTO domain_events (
                           event_id, workspace_id, session_id, sequence, producer, kind,
                           occurred_at, payload_json, schema_version, created_at
                         ) VALUES (?1, ?2, ?3, 1, 'code', 'code.message.completed',
                                   ?4, ?5, 1, ?4)",
                        params![
                            base_event_id,
                            workspace_id,
                            session_id,
                            occurred_at,
                            codex_message_payload(
                                &format!("item-v4-{index}-base"),
                                &base_summary,
                                1,
                            )
                            .to_string(),
                        ],
                    )
                    .expect("insert valid legacy message");

                let (event_id, summary, sequence) = match index {
                    0 => {
                        connection
                            .execute(
                                "INSERT INTO domain_events (
                                   event_id, workspace_id, session_id, sequence, producer, kind,
                                   occurred_at, payload_json, schema_version, created_at
                                 ) VALUES (?1, ?2, ?3, 2, 'code', 'code.message.completed',
                                           ?4, 'not-json', 1, ?4)",
                                params![
                                    "event-v4-0-corrupt",
                                    workspace_id,
                                    session_id,
                                    "2026-07-18T00:00:02.000Z",
                                ],
                            )
                            .expect("insert corrupt newest message");
                        (base_event_id, base_summary, 1)
                    }
                    1 => {
                        let duplicate_event_id = "event-v4-1-duplicate".to_owned();
                        connection
                            .execute(
                                "INSERT INTO domain_events (
                                   event_id, workspace_id, session_id, sequence, producer, kind,
                                   occurred_at, payload_json, schema_version, created_at
                                 ) VALUES (?1, ?2, ?3, 2, 'code', 'code.message.completed',
                                           ?4, ?5, 1, ?4)",
                                params![
                                    duplicate_event_id,
                                    workspace_id,
                                    session_id,
                                    "2026-07-18T00:01:02.000Z",
                                    codex_message_payload("item-v4-1-duplicate", &base_summary, 2,)
                                        .to_string(),
                                ],
                            )
                            .expect("insert duplicate safe message");
                        (duplicate_event_id, base_summary, 2)
                    }
                    2 => {
                        let latest_event_id = "event-v4-2-latest".to_owned();
                        connection
                            .execute(
                                "INSERT INTO domain_events (
                                   event_id, workspace_id, session_id, sequence, producer, kind,
                                   occurred_at, payload_json, schema_version, created_at
                                 ) VALUES (?1, ?2, ?3, 2, 'code', 'code.message.completed',
                                           ?4, ?5, 1, ?4)",
                                params![
                                    latest_event_id,
                                    workspace_id,
                                    session_id,
                                    "2026-07-18T00:02:02.000Z",
                                    codex_message_payload("item-v4-2-latest", &latest_summary, 2,)
                                        .to_string(),
                                ],
                            )
                            .expect("insert latest safe message");
                        (latest_event_id, latest_summary, 2)
                    }
                    3 => {
                        connection
                            .execute(
                                "INSERT INTO domain_events (
                                   event_id, workspace_id, session_id, sequence, producer, kind,
                                   occurred_at, payload_json, schema_version, created_at
                                 ) VALUES (?1, ?2, ?3, 2, 'code', 'code.message.completed',
                                           ?4, ?5, 1, ?4)",
                                params![
                                    "event-v4-3-private",
                                    workspace_id,
                                    session_id,
                                    "2026-07-18T00:03:02.000Z",
                                    codex_message_payload(
                                        "item-v4-3-private",
                                        "chain-of-thought must never migrate",
                                        2,
                                    )
                                    .to_string(),
                                ],
                            )
                            .expect("insert non-public newest message");
                        (base_event_id, base_summary, 1)
                    }
                    _ => (base_event_id, base_summary, 1),
                };
                expected.push((workspace_id, event_id, summary, sequence));
            }
            assert_eq!(
                connection
                    .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                    .expect("v4 fixture version"),
                4
            );
            expected
        };

        let store = WorkspaceHistoryStore::open(&data).expect("migrate v4 fixture");
        assert_eq!(store.status().mode, HistoryMode::Ready);
        for (workspace_id, event_id, summary_text, sequence) in &expected {
            let snapshot = store
                .snapshot(Some(workspace_id))
                .expect("snapshot migrated workspace");
            let resume = snapshot.resume_state.expect("backfilled resume state");
            let summary = resume.last_summary.expect("backfilled summary");
            assert_eq!(summary.workspace_id, *workspace_id);
            assert_eq!(summary.event_id, *event_id);
            assert_eq!(summary.sequence, *sequence);
            assert_eq!(summary.text, *summary_text);
            assert!(resume.timeline_anchor.is_none());
        }
        drop(store);

        let rows_after_migration = {
            let connection = Connection::open(&database).expect("inspect migrated database");
            assert_eq!(
                connection
                    .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                    .expect("migrated version"),
                5
            );
            let mut statement = connection
                .prepare(
                    "SELECT workspace_id, last_summary_event_id, last_summary_sequence,
                            last_summary_text, timeline_anchor_revision
                     FROM workspace_resume_states ORDER BY workspace_id ASC",
                )
                .expect("prepare migrated summaries");
            statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, i64>(4)?,
                    ))
                })
                .expect("query migrated summaries")
                .collect::<rusqlite::Result<Vec<_>>>()
                .expect("decode migrated summaries")
        };
        assert_eq!(rows_after_migration.len(), 20);
        assert!(rows_after_migration
            .iter()
            .all(|(_, _, _, _, revision)| *revision == 0));

        drop(WorkspaceHistoryStore::open(&data).expect("idempotent reopen"));
        let rows_after_reopen = {
            let connection = Connection::open(&database).expect("inspect reopened database");
            let mut statement = connection
                .prepare(
                    "SELECT workspace_id, last_summary_event_id, last_summary_sequence,
                            last_summary_text, timeline_anchor_revision
                     FROM workspace_resume_states ORDER BY workspace_id ASC",
                )
                .expect("prepare reopened summaries");
            statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, i64>(4)?,
                    ))
                })
                .expect("query reopened summaries")
                .collect::<rusqlite::Result<Vec<_>>>()
                .expect("decode reopened summaries")
        };
        assert_eq!(rows_after_reopen, rows_after_migration);
        let _ = fs::remove_dir_all(data);
    }

    #[test]
    fn on_disk_migration_failure_preserves_and_reopens_the_original_database() {
        let data = temp_directory("history-migration-file");
        let database = data.join(DATABASE_FILE_NAME);
        {
            let connection = Connection::open(&database).expect("fixture database");
            connection
                .execute_batch(
                    "CREATE TABLE durable_marker(value TEXT NOT NULL);
                     INSERT INTO durable_marker(value) VALUES ('preserve-me');
                     PRAGMA user_version = 0;",
                )
                .expect("N-1 fixture");
        }

        let failure = open_configured_connection_with_migrations(
            &database,
            true,
            &[(
                1,
                "CREATE TABLE partial_change(id INTEGER PRIMARY KEY);
                 INSERT INTO missing_table VALUES (1);",
            )],
        )
        .expect_err("migration must fail");
        assert_eq!(failure.code, "HIST-MIGRATION-FAILED");

        let reopened = Connection::open(&database).expect("reopen original database");
        assert_eq!(
            reopened
                .query_row("SELECT value FROM durable_marker", [], |row| {
                    row.get::<_, String>(0)
                })
                .expect("durable marker"),
            "preserve-me"
        );
        assert_eq!(
            reopened
                .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                .expect("schema version"),
            0
        );
        drop(reopened);

        let migrated = WorkspaceHistoryStore::open(&data).expect("migrate preserved database");
        assert_eq!(migrated.status().mode, HistoryMode::Ready);
        drop(migrated);
        let reopened_after_success = Connection::open(&database).expect("reopen migrated database");
        assert_eq!(
            reopened_after_success
                .query_row("SELECT value FROM durable_marker", [], |row| {
                    row.get::<_, String>(0)
                })
                .expect("durable marker after success"),
            "preserve-me"
        );
        let _ = fs::remove_dir_all(data);
    }

    #[test]
    fn recovery_backups_are_unique_and_private() {
        let data = temp_directory("history-backup-unique");
        let database = data.join(DATABASE_FILE_NAME);
        fs::write(&database, b"preserved bytes").expect("database fixture");
        let first = backup_database_files(&database)
            .expect("first backup")
            .expect("first backup name");
        let second = backup_database_files(&database)
            .expect("second backup")
            .expect("second backup name");
        assert_ne!(first, second);
        assert_eq!(
            fs::read(data.join(&first)).expect("first bytes"),
            b"preserved bytes"
        );
        assert_eq!(
            fs::read(data.join(&second)).expect("second bytes"),
            b"preserved bytes"
        );

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            for backup in [first, second] {
                let mode = fs::metadata(data.join(backup))
                    .expect("backup metadata")
                    .permissions()
                    .mode();
                assert_eq!(mode & 0o077, 0);
            }
        }
        let _ = fs::remove_dir_all(data);
    }

    #[test]
    fn private_permission_helpers_fail_closed() {
        let data = temp_directory("history-permission-failure");
        let missing = data.join("missing");
        assert!(set_private_directory_permissions(&missing).is_err());
        assert!(set_private_file_permissions(&missing).is_err());

        let store = WorkspaceHistoryStore::open(&data).expect("private store");
        drop(store);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            let directory_mode = fs::metadata(&data)
                .expect("directory metadata")
                .permissions()
                .mode();
            assert_eq!(directory_mode & 0o077, 0);
            for entry in fs::read_dir(&data).expect("history files") {
                let path = entry.expect("history entry").path();
                if path.is_file() {
                    let mode = fs::metadata(path)
                        .expect("history file metadata")
                        .permissions()
                        .mode();
                    assert_eq!(mode & 0o077, 0);
                }
            }
        }
        let _ = fs::remove_dir_all(data);
    }

    #[test]
    fn readiness_probe_fails_closed_for_writer_writability_and_migration_faults() {
        let data = temp_directory("history-readiness-faults");
        let store = WorkspaceHistoryStore::open(&data).expect("history store");
        let ready = store.readiness_probe();
        assert!(ready.integrity_ok);
        assert!(ready.writable);
        assert!(ready.writer_ready);
        assert!(ready.migration_current);
        assert!(ready.backup_valid);

        {
            let inner = store.lock();
            inner
                .connection
                .execute_batch("PRAGMA query_only = ON")
                .expect("inject read-only connection");
        }
        let read_only = store.readiness_probe();
        assert!(!read_only.writable);
        assert!(!read_only.writer_ready);
        {
            let inner = store.lock();
            inner
                .connection
                .execute_batch("PRAGMA query_only = OFF; DROP TABLE schema_migrations")
                .expect("inject migration fault");
        }
        let migration_fault = store.readiness_probe();
        assert!(!migration_fault.migration_current);
        assert!(!migration_fault.writable);

        store.accepting_writes.store(false, Ordering::Release);
        assert!(!store.readiness_probe().writer_ready);
        let _ = fs::remove_dir_all(data);
    }

    #[test]
    fn readiness_backup_validation_never_accepts_missing_or_public_files() {
        let data = temp_directory("history-readiness-backup");
        let database = data.join(DATABASE_FILE_NAME);
        fs::write(&database, b"database").expect("database fixture");
        let backup_name = "workspace-history.recovery-fixture.sqlite3";
        let status = HistoryStatus {
            schema_version: WORKSPACE_HISTORY_SCHEMA_VERSION,
            mode: HistoryMode::RecoveryRequired,
            error_code: Some("HIST-INTEGRITY".to_owned()),
            backup_name: Some(backup_name.to_owned()),
        };
        assert!(!validate_readiness_backup(Some(&database), &status));
        let backup = data.join(backup_name);
        fs::write(&backup, b"backup").expect("backup fixture");
        #[cfg(unix)]
        fs::set_permissions(&backup, std::os::unix::fs::PermissionsExt::from_mode(0o644))
            .expect("public backup mode");
        assert!(!validate_readiness_backup(Some(&database), &status));
        set_private_file_permissions(&backup).expect("private backup mode");
        assert!(validate_readiness_backup(Some(&database), &status));
        let _ = fs::remove_dir_all(data);
    }
}
