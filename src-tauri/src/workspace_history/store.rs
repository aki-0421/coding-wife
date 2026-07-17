use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, SystemTime};

use chrono::{SecondsFormat, Utc};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, Transaction};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::codex::redaction::redact_text;
use crate::codex::workspace::{
    AppPrivateWorkspaceRecord, GitRepositoryIdentity, ValidatedWorkspaceCandidate,
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
const MAX_CONTEXT_BYTES: usize = 1024 * 1024;
const MAX_TIMELINE_PAGE: u32 = 200;
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

#[derive(Clone)]
pub struct WorkspaceHistoryStore {
    inner: Arc<Mutex<StoreInner>>,
    delete_challenges: Arc<Mutex<HashMap<String, DeleteChallengeRecord>>>,
}

impl WorkspaceHistoryStore {
    pub fn open(app_data_directory: impl AsRef<Path>) -> Result<Self, WorkspaceHistoryError> {
        let directory = app_data_directory.as_ref();
        fs::create_dir_all(directory).map_err(|_| history_error("HIST-DIRECTORY", true))?;
        set_private_directory_permissions(directory);
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
            set_active_workspace(&transaction, &existing_id)?;
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
                 ) VALUES (?1, ?2, ?3, '', 'backlog', NULL, 'ready', ?4, ?4, ?4)",
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
        set_active_workspace(&transaction, &workspace_id)?;
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

    pub fn create_session_workspace(
        &self,
        from_workspace_id: &str,
        name: &str,
        goal: &str,
        client_request_id: &str,
    ) -> Result<WorkspaceSummary, WorkspaceHistoryError> {
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
            return workspace_by_id(&transaction, &existing_workspace_id);
        }

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
                 ) VALUES (?1, ?2, ?3, ?4, 'backlog', NULL, 'ready', ?5, ?5, ?5)",
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
        set_active_workspace(&transaction, &workspace_id)?;
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
        transaction
            .commit()
            .map_err(|_| history_error("HIST-TRANSACTION-COMMIT", true))?;
        Ok(workspace)
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
    ) -> Result<(), WorkspaceHistoryError> {
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
        match result {
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
                transaction
                    .execute(
                        "UPDATE projects SET project_identity = ?1, root_device = ?2, root_inode = ?3,
                           git_device = ?4, git_inode = ?5, branch = ?6, head = ?7, detached = ?8,
                           health = ?9, updated_at = ?10 WHERE id = ?11",
                        params![
                            git.project_identity,
                            git.root_device as i64,
                            git.root_inode as i64,
                            git.git_device as i64,
                            git.git_inode as i64,
                            git.branch,
                            git.head,
                            i64::from(git.detached),
                            health.as_str(),
                            now,
                            project_id,
                        ],
                    )
                    .map_err(|_| history_error("HIST-PROJECT-UPDATE", true))?;
                transaction
                    .execute(
                        "UPDATE workspaces SET health = ?1, updated_at = ?2 WHERE project_id = ?3",
                        params![health.as_str(), now, project_id],
                    )
                    .map_err(|_| history_error("HIST-WORKSPACE-UPDATE", true))?;
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
            }
        }
        transaction
            .commit()
            .map_err(|_| history_error("HIST-TRANSACTION-COMMIT", true))
    }

    pub fn issue_delete_challenge(
        &self,
        workspace_id: &str,
    ) -> Result<DeleteChallenge, WorkspaceHistoryError> {
        validate_workspace_id(workspace_id)?;
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
    let connection = Connection::open_with_flags(
        database_path,
        OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_CREATE
            | OpenFlags::SQLITE_OPEN_FULL_MUTEX,
    )
    .map_err(|_| OpenFailure {
        code: "HIST-DATABASE-OPEN".to_owned(),
    })?;
    set_private_file_permissions(database_path);
    configure_connection(&connection).map_err(|_| OpenFailure {
        code: "HIST-DATABASE-CONFIGURE".to_owned(),
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
    apply_migrations(&connection, &[(1, MIGRATION_1)]).map_err(|_| OpenFailure {
        code: "HIST-MIGRATION-FAILED".to_owned(),
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

fn append_event_in_transaction(
    transaction: &Transaction<'_>,
    event: &NormalizedDomainEvent,
    workspace_root: Option<&Path>,
) -> Result<AppendEventResult, WorkspaceHistoryError> {
    validate_domain_event(event)?;
    if let Some(sequence) = transaction
        .query_row(
            "SELECT sequence FROM domain_events WHERE event_id = ?1",
            params![event.event_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|_| history_error("HIST-EVENT-LOOKUP", true))?
    {
        return Ok(AppendEventResult {
            sequence: sequence as u64,
            inserted: false,
        });
    }
    let sanitized = sanitize_json(&event.payload, workspace_root, 0)?;
    validate_event_shape(&event.producer, &event.kind, &sanitized)?;
    let payload_json =
        serde_json::to_string(&sanitized).map_err(|_| history_error("HIST-EVENT-ENCODE", false))?;
    if payload_json.len() > MAX_EVENT_BYTES {
        return Err(history_error("HIST-EVENT-TOO-LARGE", false));
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
    if event.schema_version != DOMAIN_EVENT_SCHEMA_VERSION {
        return Err(history_error("HIST-EVENT-SCHEMA", false));
    }
    validate_opaque_id(&event.event_id, "HIST-EVENT-ID")?;
    validate_workspace_id(&event.workspace_id)?;
    if let Some(session_id) = &event.session_id {
        validate_opaque_id(session_id, "HIST-SESSION-ID")?;
    }
    validate_timestamp(&event.occurred_at)
}

fn validate_event_shape(
    producer: &str,
    kind: &str,
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
    match (producer, kind) {
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
        ("code", "code.session.status.changed") => {
            if !exact(&["status"], &[])
                || !matches!(
                    object.get("status").and_then(Value::as_str),
                    Some("idle" | "running" | "waiting" | "interrupted" | "failed" | "completed")
                )
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
            {
                return Err(history_error("HIST-EVENT-PAYLOAD", false));
            }
        }
        ("git", "git.checkpoint.status.changed") => {
            if !exact(&["status"], &["checkpointId"])
                || !matches!(
                    object.get("status").and_then(Value::as_str),
                    Some("pending" | "blocked" | "review_ready" | "failed")
                )
            {
                return Err(history_error("HIST-EVENT-PAYLOAD", false));
            }
        }
        _ => return Err(history_error("HIST-EVENT-KIND", false)),
    }
    Ok(())
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
            if values.len() > 256 {
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
    let stamp = Utc::now().format("%Y%m%dT%H%M%SZ");
    let backup_name = format!("workspace-history.recovery-{stamp}.sqlite3");
    let backup_path = database_path.with_file_name(&backup_name);
    fs::copy(database_path, &backup_path)?;
    set_private_file_permissions(&backup_path);
    for suffix in ["-wal", "-shm"] {
        let source = PathBuf::from(format!("{}{suffix}", database_path.display()));
        if source.exists() {
            let target = PathBuf::from(format!("{}{suffix}", backup_path.display()));
            fs::copy(source, &target)?;
            set_private_file_permissions(&target);
        }
    }
    Ok(Some(backup_name))
}

#[cfg(unix)]
fn set_private_directory_permissions(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o700));
}

#[cfg(not(unix))]
fn set_private_directory_permissions(_path: &Path) {}

#[cfg(unix)]
fn set_private_file_permissions(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn set_private_file_permissions(_path: &Path) {}

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
                .snapshot(Some(&second.workspace_id))
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
        let database = fs::read(data.join(DATABASE_FILE_NAME)).expect("database bytes");
        let database_text = String::from_utf8_lossy(&database);
        assert!(!database_text.contains("hidden-token"));
        assert!(!database_text.contains("/Users/private"));

        let event = NormalizedDomainEvent {
            schema_version: 1,
            event_id: "event-idempotent".to_owned(),
            workspace_id: registered.workspace.workspace_id.clone(),
            session_id: None,
            producer: "code".to_owned(),
            kind: "code.session.status.changed".to_owned(),
            occurred_at: now(),
            payload: json!({ "status": "running" }),
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
                    payload: json!({ "status": "running" }),
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
}
