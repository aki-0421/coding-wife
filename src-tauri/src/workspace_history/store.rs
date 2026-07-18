use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, SystemTime};

use chrono::{SecondsFormat, Utc};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, Transaction};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::codex::redaction::redact_text;
use crate::codex::types::{ApprovalDecision, PendingKind, PendingRequestView, PendingResponseKind};
use crate::codex::workspace::{
    AppPrivateWorkspaceRecord, GitRepositoryIdentity, ValidatedWorkspaceCandidate,
};
use crate::git_review::repository::{
    is_object_id, validate_opaque_id as validate_git_opaque_id, validate_relative_path,
};
use crate::git_review::types::{
    CommitEvidenceDetail, CommitProducer, DecisionEvidence, FailedAttemptEvidence, GateKind,
    GateResult, GitObservation, GitSupportState, KnownRisk, SkillInjectionMode, SkillPathAuthority,
    VerificationEvidence, WorkUnitGitObservation, GIT_REVIEW_SCHEMA_VERSION, MAX_CHANGED_FILES,
    MAX_CHANGED_LINES, MAX_EVIDENCE_ITEMS,
};

use super::types::{
    AppendEventResult, ContextSnapshotView, ContextSource, HistoryMode, HistoryStatus,
    NormalizedDomainEvent, ReasoningEffort, TimelineEventView, TimelinePage, WorkspaceAttention,
    WorkspaceDraftView, WorkspaceHealth, WorkspaceHistoryError, WorkspaceLifecycle,
    WorkspaceStateSnapshot, WorkspaceSummary, DOMAIN_EVENT_SCHEMA_VERSION,
    WORKSPACE_HISTORY_SCHEMA_VERSION,
};

const DATABASE_FILE_NAME: &str = "workspace-history.sqlite3";
const CURRENT_DATABASE_VERSION: i64 = 1;
const MAX_EVENT_BYTES: usize = 256 * 1024;
const MAX_EVENT_ARRAY_ITEMS: usize = 512;
const MAX_CONTEXT_BYTES: usize = 1024 * 1024;
const MAX_TIMELINE_PAGE: u32 = 200;
const MAX_WORKSPACES: i64 = 200;
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

#[derive(Debug)]
struct StoreInner {
    connection: Connection,
    status: HistoryStatus,
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
pub struct PersistedSessionWorkspace {
    pub workspace: WorkspaceSummary,
    pub private_record: AppPrivateWorkspaceRecord,
    pub created: bool,
}

#[derive(Clone)]
pub struct WorkspaceHistoryStore {
    inner: Arc<Mutex<StoreInner>>,
    delete_challenges: Arc<Mutex<HashMap<String, DeleteChallengeRecord>>>,
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
            Ok((connection, status)) => Ok(Self::from_connection(connection, status)),
            Err(failure) => {
                let backup_name = backup_database_files(&database_path).ok().flatten();
                let connection = Connection::open_in_memory()
                    .map_err(|_| history_error("HIST-RECOVERY-OPEN", false))?;
                configure_connection(&connection)
                    .map_err(|_| history_error("HIST-RECOVERY-CONFIGURE", false))?;
                apply_migrations(&connection, &[(1, MIGRATION_1)])
                    .map_err(|_| history_error("HIST-RECOVERY-SCHEMA", false))?;
                Ok(Self::from_connection(
                    connection,
                    HistoryStatus {
                        schema_version: WORKSPACE_HISTORY_SCHEMA_VERSION,
                        mode: HistoryMode::RecoveryRequired,
                        error_code: Some(failure.code),
                        backup_name,
                    },
                ))
            }
        }
    }

    fn from_connection(connection: Connection, status: HistoryStatus) -> Self {
        Self {
            inner: Arc::new(Mutex::new(StoreInner { connection, status })),
            delete_challenges: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn status(&self) -> HistoryStatus {
        self.lock().status.clone()
    }

    pub fn database_file_name(&self) -> &'static str {
        DATABASE_FILE_NAME
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

        if let Some(existing_id) = transaction
            .query_row(
                "SELECT w.id FROM projects p JOIN workspaces w ON w.project_id = p.id \
                 WHERE p.canonical_root = ?1 ORDER BY w.created_at ASC LIMIT 1",
                params![root_bytes],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|_| history_error("HIST-WORKSPACE-LOOKUP", true))?
        {
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
        drop(inner);
        let timeline = active_workspace_id
            .as_deref()
            .map(|id| self.timeline(id, None, 200, None))
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
        })
    }

    pub fn update_preflight(
        &self,
        workspace_id: &str,
        result: Result<&GitRepositoryIdentity, WorkspaceHealth>,
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
                let prior_identity = transaction
                    .query_row(
                        "SELECT project_identity FROM projects WHERE id = ?1",
                        params![project_id],
                        |row| row.get::<_, String>(0),
                    )
                    .map_err(|_| history_error("HIST-PROJECT-LOOKUP", true))?;
                let health = if prior_identity == git.project_identity {
                    WorkspaceHealth::Ready
                } else {
                    WorkspaceHealth::Changed
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
        if self.status().mode == HistoryMode::Ready {
            Ok(())
        } else {
            Err(WorkspaceHistoryError::new(
                "HIST-READ-ONLY",
                operation,
                true,
            ))
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
    open_configured_connection_with_migrations(database_path, existed, &[(1, MIGRATION_1)])
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
        transaction.execute(
            "INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?1, ?2)",
            params![version, now()],
        )?;
        transaction.execute_batch(&format!("PRAGMA user_version = {version};"))?;
        transaction.commit()?;
    }
    Ok(())
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
    Ok(AppendEventResult {
        sequence: sequence as u64,
        inserted: true,
    })
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
            .is_none_or(|value| valid_git_text(value, 2048, false))
        && validate_timestamp(&observation.observed_at).is_ok()
        && observation.history_sequence.is_none()
}

fn validate_git_commit_evidence(evidence: &CommitEvidenceDetail, workspace_id: &str) -> bool {
    if evidence.schema_version != GIT_REVIEW_SCHEMA_VERSION
        || evidence.workspace_id != workspace_id
        || !valid_git_id(&evidence.commit_evidence_id)
        || !valid_git_id(&evidence.workspace_id)
        || !is_object_id(&evidence.identity.commit_sha)
        || !valid_git_text(&evidence.identity.subject, 1024, false)
        || !valid_git_text(&evidence.identity.body, 16 * 1024, true)
        || !valid_git_text(&evidence.identity.author_name, 256, false)
        || !valid_git_text(&evidence.identity.author_email, 512, false)
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
            .is_none_or(|value| valid_git_text(value, 500, false))
        || evidence.acceptance.len() > 20
        || !evidence
            .acceptance
            .iter()
            .all(|item| valid_git_text(item, 1024, false))
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
        && valid_git_text(&evidence.check, 512, false)
        && evidence.duration_ms <= 24 * 60 * 60 * 1_000
        && valid_git_text(&evidence.summary, 4096, true)
}

fn validate_git_decision(decision: &DecisionEvidence) -> bool {
    valid_git_id(&decision.decision_id)
        && valid_git_id(&decision.source_event_id)
        && valid_git_text(&decision.summary, 2048, false)
        && valid_git_text(&decision.answer, 2048, false)
        && valid_git_text(&decision.rationale, 4096, true)
}

fn validate_git_failed_attempt(attempt: &FailedAttemptEvidence) -> bool {
    valid_git_id(&attempt.attempt_id)
        && valid_git_id(&attempt.source_event_id)
        && valid_git_text(&attempt.approach, 2048, false)
        && valid_git_text(&attempt.outcome, 1024, false)
        && valid_git_text(&attempt.learning, 2048, true)
}

fn validate_git_risk(risk: &KnownRisk) -> bool {
    valid_git_id(&risk.risk_id)
        && valid_git_id(&risk.source_event_id)
        && valid_git_text(&risk.category, 256, false)
        && valid_git_text(&risk.summary, 2048, false)
        && valid_git_text(&risk.mitigation, 2048, true)
}

fn valid_git_id(value: &str) -> bool {
    validate_git_opaque_id(value, "GIT-HISTORY-ID").is_ok()
}

fn valid_git_text(value: &str, maximum: usize, allow_empty: bool) -> bool {
    (allow_empty || !value.trim().is_empty())
        && value.chars().count() <= maximum
        && value
            .chars()
            .all(|character| !character.is_control() || matches!(character, '\n' | '\r' | '\t'))
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
            &format!("{WORKSPACE_SELECT} WHERE w.id = ?1"),
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
            "{WORKSPACE_SELECT} ORDER BY CASE w.lifecycle
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

fn private_workspace_by_id(
    connection: &Connection,
    workspace_id: &str,
) -> Result<AppPrivateWorkspaceRecord, WorkspaceHistoryError> {
    connection
        .query_row(
            "SELECT w.id, p.alias, p.canonical_root
             FROM workspaces w JOIN projects p ON p.id = w.project_id WHERE w.id = ?1",
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

        let secret = "Bearer hidden-token /Users/private/repository/file.rs";
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
            assert!(!text.contains("/Users/private"));
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
        assert!(!encoded.contains("/Users/private"));
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
            "/Users/private/project/file.rs",
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
}
