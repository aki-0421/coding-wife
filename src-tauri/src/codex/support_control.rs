//! Native support policy persistence and the safe Settings/diagnostics contract.
//!
//! Only desired booleans and bounded audit metadata cross this boundary. Support
//! prompts, responses, paths, credentials, and transcripts are deliberately absent.

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex};

use rusqlite::{Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};

use super::support::SUPPORT_PERMISSION_PROFILE;
use super::types::CODEX_MODEL;

pub const SUPPORT_CONTROL_SCHEMA_VERSION: u16 = 1;
pub const SUPPORT_MAX_QUEUE_CAPACITY: usize = 10;
pub const SUPPORT_TOKEN_BUDGET: u64 = 16_000;
pub const SUPPORT_TASK_TIMEOUT_MS: u64 = 15_000;
pub(crate) const SUPPORT_MAX_SAFE_COUNTER: u64 = 9_007_199_254_740_991;

const SUPPORT_DIRECTORY: &str = "support";
const SETTINGS_FILE: &str = "settings-v1.json";
const AUDIT_FILE: &str = "audit-v1.sqlite3";
const MAX_SETTINGS_BYTES: u64 = 16 * 1024;
const MAX_AUDIT_PAYLOAD_BYTES: usize = 32 * 1024;
const MAX_AUDIT_DATABASE_BYTES: u64 = 4 * 1024 * 1024;
const AUDIT_SCHEMA_VERSION: u16 = 1;
const MAX_SAFE_SETTINGS_VERSION: u64 = 9_007_199_254_740_991;

pub(crate) const SUPPORT_SETTINGS_CORRUPT: &str = "CODEX-SUPPORT-SETTINGS-CORRUPT";
pub(crate) const SUPPORT_SETTINGS_UNKNOWN_VERSION: &str = "CODEX-SUPPORT-SETTINGS-UNKNOWN-VERSION";
pub(crate) const SUPPORT_SETTINGS_UNSAFE: &str = "CODEX-SUPPORT-SETTINGS-UNSAFE";
pub(crate) const SUPPORT_SETTINGS_UNAVAILABLE: &str = "CODEX-SUPPORT-SETTINGS-UNAVAILABLE";
pub(crate) const SUPPORT_AUDIT_CORRUPT: &str = "CODEX-SUPPORT-AUDIT-CORRUPT";
pub(crate) const SUPPORT_AUDIT_POLICY_MISMATCH: &str = "CODEX-SUPPORT-AUDIT-POLICY-MISMATCH";
pub(crate) const SUPPORT_AUDIT_UNSAFE: &str = "CODEX-SUPPORT-AUDIT-UNSAFE";
pub(crate) const SUPPORT_AUDIT_UNAVAILABLE: &str = "CODEX-SUPPORT-AUDIT-UNAVAILABLE";

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SupportSettingsV1 {
    pub schema_version: u16,
    pub version: u64,
    pub global_enabled: bool,
    pub commit_explainer_enabled: bool,
}

impl Default for SupportSettingsV1 {
    fn default() -> Self {
        Self {
            schema_version: SUPPORT_CONTROL_SCHEMA_VERSION,
            version: 1,
            // Preserve the existing verified-commit behavior on a fresh install.
            // The separate release gate still prevents any unapproved model use.
            global_enabled: true,
            commit_explainer_enabled: true,
        }
    }
}

impl SupportSettingsV1 {
    pub(crate) fn fail_closed() -> Self {
        Self {
            schema_version: SUPPORT_CONTROL_SCHEMA_VERSION,
            version: 0,
            global_enabled: false,
            commit_explainer_enabled: false,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SupportPersistence {
    Native,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SupportReadinessStatus {
    Approved,
    Blocked,
    Unavailable,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SupportReleaseReadinessV1 {
    pub status: SupportReadinessStatus,
    pub approved_cli_version: String,
    pub approved_binary_hash_prefix: String,
    pub approved_schema_fingerprint_prefix: String,
    pub observed_cli_version: Option<String>,
    pub observed_binary_hash_prefix: Option<String>,
    pub observed_schema_fingerprint_prefix: Option<String>,
    pub skill_name: String,
    pub skill_version: Option<String>,
    pub skill_digest_prefix: Option<String>,
    pub reason_code: Option<String>,
    pub checked_at: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SupportEffectiveState {
    Enabled,
    UserDisabled,
    RoleDisabled,
    ReleaseBlocked,
    SettingsRecovery,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SupportUsageCountersV1 {
    pub attempted_tasks: u64,
    pub started_tasks: u64,
    pub succeeded_tasks: u64,
    pub failed_tasks: u64,
    pub canceled_tasks: u64,
    pub unavailable_tasks: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub total_tokens: u64,
    pub total_latency_ms: u64,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SupportOutcomeStatus {
    Generated,
    Failed,
    Canceled,
    Unavailable,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SupportLatestOutcomeV1 {
    pub status: SupportOutcomeStatus,
    pub trigger: String,
    pub completed_at: String,
    pub latency_ms: Option<u64>,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub total_tokens: u64,
    pub error_code: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SupportCapacityV1 {
    pub maximum_active: usize,
    pub maximum_queued: usize,
    pub active: usize,
    pub queued: usize,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SupportAuditV1 {
    pub role: String,
    pub model_family: String,
    pub reasoning_effort: String,
    pub permission_profile: String,
    pub raw_transcript_persisted: bool,
    pub task_timeout_ms: u64,
    pub token_budget: u64,
    pub fallback_tasks: u64,
    pub latest_outcome: Option<SupportLatestOutcomeV1>,
}

impl SupportAuditV1 {
    pub(crate) fn new(latest_outcome: Option<SupportLatestOutcomeV1>, fallback_tasks: u64) -> Self {
        Self {
            role: "commit_explainer".to_owned(),
            model_family: CODEX_MODEL.to_owned(),
            reasoning_effort: "low".to_owned(),
            permission_profile: SUPPORT_PERMISSION_PROFILE.to_owned(),
            raw_transcript_persisted: false,
            task_timeout_ms: SUPPORT_TASK_TIMEOUT_MS,
            token_budget: SUPPORT_TOKEN_BUDGET,
            fallback_tasks,
            latest_outcome,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct SupportDurableAuditV1 {
    pub schema_version: u16,
    pub policy_version: u64,
    pub usage: SupportUsageCountersV1,
    pub fallback_tasks: u64,
    pub latest_outcome: Option<SupportLatestOutcomeV1>,
    pub last_error_code: Option<String>,
    pub raw_transcript_persisted: bool,
    pub updated_at: String,
}

impl SupportDurableAuditV1 {
    pub(crate) fn fresh(policy_version: u64) -> Self {
        Self {
            schema_version: AUDIT_SCHEMA_VERSION,
            policy_version,
            usage: SupportUsageCountersV1::default(),
            fallback_tasks: 0,
            latest_outcome: None,
            last_error_code: None,
            raw_transcript_persisted: false,
            updated_at: chrono::Utc::now().to_rfc3339(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SupportControlSnapshotV1 {
    pub schema_version: u16,
    pub settings: SupportSettingsV1,
    pub persistence: SupportPersistence,
    pub recovery_code: Option<String>,
    pub readiness: SupportReleaseReadinessV1,
    pub effective_state: SupportEffectiveState,
    pub effective_enabled: bool,
    pub fallback_reason_code: Option<String>,
    pub capacity: SupportCapacityV1,
    pub usage: SupportUsageCountersV1,
    pub audit: SupportAuditV1,
    pub last_error_code: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SupportSettingsGetRequestV1 {
    pub schema_version: u16,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SupportSettingsUpdateRequestV1 {
    pub schema_version: u16,
    pub expected_version: u64,
    pub global_enabled: bool,
    pub commit_explainer_enabled: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SupportControlCommandError {
    pub code: String,
    pub operation: String,
    pub recoverable: bool,
    pub user_message_key: String,
}

impl SupportControlCommandError {
    pub(crate) fn new(
        code: impl Into<String>,
        operation: impl Into<String>,
        recoverable: bool,
    ) -> Self {
        Self {
            code: code.into(),
            operation: operation.into(),
            recoverable,
            user_message_key: "support.error.generic".to_owned(),
        }
    }
}

impl std::fmt::Display for SupportControlCommandError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.code)
    }
}

impl std::error::Error for SupportControlCommandError {}

pub(crate) type SupportControlResult<T> = Result<T, SupportControlCommandError>;

#[derive(Clone, Debug)]
pub(crate) struct SupportSettingsStore {
    root: PathBuf,
    path: PathBuf,
}

pub(crate) struct SupportSettingsStoreOpen {
    pub store: Option<SupportSettingsStore>,
    pub settings: SupportSettingsV1,
    pub recovery_code: Option<String>,
}

#[derive(Clone, Debug)]
pub(crate) struct SupportAuditStore {
    path: PathBuf,
    gate: Arc<StdMutex<()>>,
}

pub(crate) struct SupportAuditStoreOpen {
    pub store: Option<SupportAuditStore>,
    pub state: SupportDurableAuditV1,
    pub recovery_code: Option<String>,
}

impl SupportAuditStore {
    pub(crate) fn open(
        app_data_directory: impl AsRef<Path>,
        expected_policy_version: Option<u64>,
    ) -> SupportAuditStoreOpen {
        match Self::open_inner(app_data_directory.as_ref(), expected_policy_version) {
            Ok(opened) => opened,
            Err(code) => SupportAuditStoreOpen {
                store: None,
                state: SupportDurableAuditV1::fresh(expected_policy_version.unwrap_or(0)),
                recovery_code: Some(code.to_owned()),
            },
        }
    }

    fn open_inner(
        app_data_directory: &Path,
        expected_policy_version: Option<u64>,
    ) -> Result<SupportAuditStoreOpen, &'static str> {
        let root = app_data_directory.join(SUPPORT_DIRECTORY);
        ensure_private_directory(&root)?;
        let path = root.join(AUDIT_FILE);
        let fresh = match fs::symlink_metadata(&path) {
            Ok(metadata) => {
                verify_private_regular_file_metadata(&metadata, MAX_AUDIT_DATABASE_BYTES)
                    .map_err(|_| SUPPORT_AUDIT_UNSAFE)?;
                false
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let mut options = OpenOptions::new();
                options.create_new(true).write(true).mode(0o600);
                options
                    .open(&path)
                    .and_then(|file| file.sync_all())
                    .map_err(|_| SUPPORT_AUDIT_UNAVAILABLE)?;
                true
            }
            Err(_) => return Err(SUPPORT_AUDIT_UNAVAILABLE),
        };
        let store = Self {
            path,
            gate: Arc::new(StdMutex::new(())),
        };
        if fresh {
            let state = SupportDurableAuditV1::fresh(expected_policy_version.unwrap_or(0));
            store.initialize(&state)?;
            return Ok(SupportAuditStoreOpen {
                store: Some(store),
                state,
                recovery_code: None,
            });
        }
        let state = store.load()?;
        if expected_policy_version.is_some_and(|version| state.policy_version != version) {
            return Ok(SupportAuditStoreOpen {
                store: Some(store),
                state,
                recovery_code: Some(SUPPORT_AUDIT_POLICY_MISMATCH.to_owned()),
            });
        }
        Ok(SupportAuditStoreOpen {
            store: Some(store),
            state,
            recovery_code: None,
        })
    }

    fn initialize(&self, state: &SupportDurableAuditV1) -> Result<(), &'static str> {
        let connection =
            open_audit_connection(&self.path).map_err(|_| SUPPORT_AUDIT_UNAVAILABLE)?;
        connection
            .execute_batch(
                "CREATE TABLE support_audit_state (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    payload_json TEXT NOT NULL CHECK (length(payload_json) <= 32768)
                );
                PRAGMA user_version = 1;",
            )
            .map_err(|_| SUPPORT_AUDIT_UNAVAILABLE)?;
        drop(connection);
        self.save(state, "support_audit_startup")
            .map_err(|_| SUPPORT_AUDIT_UNAVAILABLE)
    }

    fn load(&self) -> Result<SupportDurableAuditV1, &'static str> {
        let _guard = self.gate.lock().map_err(|_| SUPPORT_AUDIT_UNAVAILABLE)?;
        let connection = open_audit_connection(&self.path).map_err(|_| SUPPORT_AUDIT_CORRUPT)?;
        let integrity: String = connection
            .query_row("PRAGMA quick_check(1)", [], |row| row.get(0))
            .map_err(|_| SUPPORT_AUDIT_CORRUPT)?;
        if integrity != "ok" {
            return Err(SUPPORT_AUDIT_CORRUPT);
        }
        let version: u16 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(|_| SUPPORT_AUDIT_CORRUPT)?;
        if version != AUDIT_SCHEMA_VERSION {
            return Err(SUPPORT_AUDIT_CORRUPT);
        }
        let table_count: u64 = connection
            .query_row(
                "SELECT count(*) FROM sqlite_schema WHERE type = 'table'",
                [],
                |row| row.get(0),
            )
            .map_err(|_| SUPPORT_AUDIT_CORRUPT)?;
        if table_count != 1 {
            return Err(SUPPORT_AUDIT_CORRUPT);
        }
        let payload = connection
            .query_row(
                "SELECT payload_json FROM support_audit_state WHERE id = 1",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|_| SUPPORT_AUDIT_CORRUPT)?
            .ok_or(SUPPORT_AUDIT_CORRUPT)?;
        let row_count: u64 = connection
            .query_row("SELECT count(*) FROM support_audit_state", [], |row| {
                row.get(0)
            })
            .map_err(|_| SUPPORT_AUDIT_CORRUPT)?;
        if row_count != 1 || payload.len() > MAX_AUDIT_PAYLOAD_BYTES {
            return Err(SUPPORT_AUDIT_CORRUPT);
        }
        let state: SupportDurableAuditV1 =
            serde_json::from_str(&payload).map_err(|_| SUPPORT_AUDIT_CORRUPT)?;
        validate_durable_audit(&state).map_err(|_| SUPPORT_AUDIT_CORRUPT)?;
        Ok(state)
    }

    pub(crate) fn save(
        &self,
        state: &SupportDurableAuditV1,
        operation: &'static str,
    ) -> SupportControlResult<()> {
        validate_durable_audit(state)
            .map_err(|code| SupportControlCommandError::new(code, operation, false))?;
        let payload = serde_json::to_string(state).map_err(|_| {
            SupportControlCommandError::new("CODEX-SUPPORT-AUDIT-SERIALIZE", operation, false)
        })?;
        if payload.len() > MAX_AUDIT_PAYLOAD_BYTES {
            return Err(SupportControlCommandError::new(
                "CODEX-SUPPORT-AUDIT-SIZE",
                operation,
                false,
            ));
        }
        let _guard = self.gate.lock().map_err(|_| {
            SupportControlCommandError::new(SUPPORT_AUDIT_UNAVAILABLE, operation, true)
        })?;
        let mut connection = open_audit_connection(&self.path).map_err(|_| {
            SupportControlCommandError::new(SUPPORT_AUDIT_UNAVAILABLE, operation, true)
        })?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| {
                SupportControlCommandError::new("CODEX-SUPPORT-AUDIT-WRITE", operation, true)
            })?;
        transaction
            .execute(
                "INSERT INTO support_audit_state (id, payload_json) VALUES (1, ?1)
                 ON CONFLICT(id) DO UPDATE SET payload_json = excluded.payload_json",
                [payload],
            )
            .map_err(|_| {
                SupportControlCommandError::new("CODEX-SUPPORT-AUDIT-WRITE", operation, true)
            })?;
        transaction.commit().map_err(|_| {
            SupportControlCommandError::new("CODEX-SUPPORT-AUDIT-SYNC", operation, true)
        })?;
        let metadata = fs::symlink_metadata(&self.path).map_err(|_| {
            SupportControlCommandError::new(SUPPORT_AUDIT_UNAVAILABLE, operation, true)
        })?;
        verify_private_regular_file_metadata(&metadata, MAX_AUDIT_DATABASE_BYTES)
            .map_err(|_| SupportControlCommandError::new(SUPPORT_AUDIT_UNSAFE, operation, false))?;
        Ok(())
    }
}

impl SupportSettingsStore {
    pub(crate) fn open(app_data_directory: impl AsRef<Path>) -> SupportSettingsStoreOpen {
        match Self::open_inner(app_data_directory.as_ref()) {
            Ok(opened) => opened,
            Err(code) => SupportSettingsStoreOpen {
                store: None,
                settings: SupportSettingsV1::fail_closed(),
                recovery_code: Some(code.to_owned()),
            },
        }
    }

    fn open_inner(app_data_directory: &Path) -> Result<SupportSettingsStoreOpen, &'static str> {
        let root = app_data_directory.join(SUPPORT_DIRECTORY);
        ensure_private_directory(&root)?;
        let store = Self {
            path: root.join(SETTINGS_FILE),
            root,
        };
        if !store.path.exists() {
            let settings = SupportSettingsV1::default();
            store
                .save(&settings, "support_settings_startup")
                .map_err(|_| SUPPORT_SETTINGS_UNAVAILABLE)?;
            return Ok(SupportSettingsStoreOpen {
                store: Some(store),
                settings,
                recovery_code: None,
            });
        }

        match store.load() {
            Ok(settings) => Ok(SupportSettingsStoreOpen {
                store: Some(store),
                settings,
                recovery_code: None,
            }),
            Err(code @ SUPPORT_SETTINGS_UNSAFE) => Err(code),
            Err(code) => Ok(SupportSettingsStoreOpen {
                store: Some(store),
                settings: SupportSettingsV1::fail_closed(),
                recovery_code: Some(code.to_owned()),
            }),
        }
    }

    fn load(&self) -> Result<SupportSettingsV1, &'static str> {
        verify_settings_file(&self.path)?;
        let mut file = File::open(&self.path).map_err(|_| SUPPORT_SETTINGS_UNAVAILABLE)?;
        let size = file
            .metadata()
            .map_err(|_| SUPPORT_SETTINGS_UNAVAILABLE)?
            .len();
        if size == 0 || size > MAX_SETTINGS_BYTES {
            return Err(SUPPORT_SETTINGS_CORRUPT);
        }
        let mut bytes = Vec::with_capacity(usize::try_from(size).unwrap_or(0));
        file.read_to_end(&mut bytes)
            .map_err(|_| SUPPORT_SETTINGS_UNAVAILABLE)?;
        let value: serde_json::Value =
            serde_json::from_slice(&bytes).map_err(|_| SUPPORT_SETTINGS_CORRUPT)?;
        if value
            .get("schemaVersion")
            .and_then(serde_json::Value::as_u64)
            != Some(u64::from(SUPPORT_CONTROL_SCHEMA_VERSION))
        {
            return Err(SUPPORT_SETTINGS_UNKNOWN_VERSION);
        }
        let settings: SupportSettingsV1 =
            serde_json::from_value(value).map_err(|_| SUPPORT_SETTINGS_CORRUPT)?;
        validate_settings(&settings).map_err(|_| SUPPORT_SETTINGS_CORRUPT)?;
        Ok(settings)
    }

    pub(crate) fn save(
        &self,
        settings: &SupportSettingsV1,
        operation: &'static str,
    ) -> SupportControlResult<()> {
        validate_settings(settings)
            .map_err(|code| SupportControlCommandError::new(code, operation, false))?;
        if self.path.exists() {
            verify_settings_file(&self.path)
                .map_err(|code| SupportControlCommandError::new(code, operation, false))?;
        }
        let bytes = serde_json::to_vec_pretty(settings).map_err(|_| {
            SupportControlCommandError::new("CODEX-SUPPORT-SETTINGS-SERIALIZE", operation, false)
        })?;
        if bytes.len() > usize::try_from(MAX_SETTINGS_BYTES).unwrap_or(usize::MAX) {
            return Err(SupportControlCommandError::new(
                "CODEX-SUPPORT-SETTINGS-SIZE",
                operation,
                false,
            ));
        }
        atomic_write(&self.root, &self.path, &bytes, operation)
    }
}

fn validate_settings(settings: &SupportSettingsV1) -> Result<(), &'static str> {
    if settings.schema_version != SUPPORT_CONTROL_SCHEMA_VERSION
        || settings.version == 0
        || settings.version > MAX_SAFE_SETTINGS_VERSION
    {
        return Err("CODEX-SUPPORT-SETTINGS-SCHEMA");
    }
    Ok(())
}

fn open_audit_connection(path: &Path) -> rusqlite::Result<Connection> {
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    connection.busy_timeout(std::time::Duration::from_secs(1))?;
    connection.execute_batch(
        "PRAGMA journal_mode = DELETE;
         PRAGMA synchronous = FULL;
         PRAGMA temp_store = MEMORY;
         PRAGMA trusted_schema = OFF;
         PRAGMA max_page_count = 1024;",
    )?;
    Ok(connection)
}

fn validate_durable_audit(state: &SupportDurableAuditV1) -> Result<(), &'static str> {
    if state.schema_version != AUDIT_SCHEMA_VERSION
        || state.policy_version > MAX_SAFE_SETTINGS_VERSION
        || state.fallback_tasks > SUPPORT_MAX_SAFE_COUNTER
        || state.raw_transcript_persisted
        || state.updated_at.len() > 64
        || chrono::DateTime::parse_from_rfc3339(&state.updated_at).is_err()
    {
        return Err(SUPPORT_AUDIT_CORRUPT);
    }
    let usage = &state.usage;
    let counters = [
        usage.attempted_tasks,
        usage.started_tasks,
        usage.succeeded_tasks,
        usage.failed_tasks,
        usage.canceled_tasks,
        usage.unavailable_tasks,
        usage.input_tokens,
        usage.output_tokens,
        usage.total_tokens,
        usage.total_latency_ms,
    ];
    if counters
        .into_iter()
        .any(|value| value > SUPPORT_MAX_SAFE_COUNTER)
        || usage.total_tokens != usage.input_tokens.saturating_add(usage.output_tokens)
        || state.fallback_tasks > usage.unavailable_tasks
        || state
            .last_error_code
            .as_deref()
            .is_some_and(|code| !valid_safe_code(code))
    {
        return Err(SUPPORT_AUDIT_CORRUPT);
    }
    if let Some(outcome) = state.latest_outcome.as_ref() {
        if outcome.completed_at.len() > 64
            || chrono::DateTime::parse_from_rfc3339(&outcome.completed_at).is_err()
            || outcome
                .latency_ms
                .is_some_and(|value| value > SUPPORT_MAX_SAFE_COUNTER)
            || outcome.input_tokens > SUPPORT_MAX_SAFE_COUNTER
            || outcome.output_tokens > SUPPORT_MAX_SAFE_COUNTER
            || outcome.total_tokens > SUPPORT_MAX_SAFE_COUNTER
            || outcome.total_tokens != outcome.input_tokens.saturating_add(outcome.output_tokens)
            || !matches!(
                outcome.trigger.as_str(),
                "auto_verified_commit" | "user_request" | "user_retry"
            )
            || outcome
                .error_code
                .as_deref()
                .is_some_and(|code| !valid_safe_code(code))
            || (outcome.status == SupportOutcomeStatus::Generated && outcome.error_code.is_some())
            || (outcome.status != SupportOutcomeStatus::Generated && outcome.error_code.is_none())
        {
            return Err(SUPPORT_AUDIT_CORRUPT);
        }
    }
    Ok(())
}

fn valid_safe_code(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.starts_with("CODEX-SUPPORT-")
        && value
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'-')
}

fn ensure_private_directory(path: &Path) -> Result<(), &'static str> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => validate_private_directory_metadata(&metadata, effective_uid())?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).map_err(|_| SUPPORT_SETTINGS_UNAVAILABLE)?;
            }
            let mut builder = fs::DirBuilder::new();
            builder.mode(0o700);
            builder
                .create(path)
                .map_err(|_| SUPPORT_SETTINGS_UNAVAILABLE)?;
            let metadata = fs::symlink_metadata(path).map_err(|_| SUPPORT_SETTINGS_UNAVAILABLE)?;
            validate_private_directory_metadata(&metadata, effective_uid())?;
            fs::set_permissions(path, fs::Permissions::from_mode(0o700))
                .map_err(|_| SUPPORT_SETTINGS_UNAVAILABLE)?;
        }
        Err(_) => return Err(SUPPORT_SETTINGS_UNAVAILABLE),
    }
    sync_directory(path.parent().unwrap_or(path), "support_settings_startup")
        .map_err(|_| SUPPORT_SETTINGS_UNAVAILABLE)
}

fn validate_private_directory_metadata(
    metadata: &fs::Metadata,
    expected_uid: u32,
) -> Result<(), &'static str> {
    if !metadata.file_type().is_dir()
        || metadata.uid() != expected_uid
        || metadata.mode() & 0o077 != 0
    {
        return Err(SUPPORT_SETTINGS_UNSAFE);
    }
    Ok(())
}

fn verify_settings_file(path: &Path) -> Result<(), &'static str> {
    let metadata = fs::symlink_metadata(path).map_err(|_| SUPPORT_SETTINGS_UNAVAILABLE)?;
    verify_private_regular_file_metadata(&metadata, MAX_SETTINGS_BYTES)
}

fn verify_private_regular_file_metadata(
    metadata: &fs::Metadata,
    maximum_bytes: u64,
) -> Result<(), &'static str> {
    if !metadata.file_type().is_file()
        || metadata.uid() != effective_uid()
        || metadata.mode() & 0o077 != 0
        || metadata.len() > maximum_bytes
    {
        return Err(SUPPORT_SETTINGS_UNSAFE);
    }
    Ok(())
}

fn atomic_write(
    root: &Path,
    path: &Path,
    bytes: &[u8],
    operation: &'static str,
) -> SupportControlResult<()> {
    let temporary = root.join(format!(".settings-v1.{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.create_new(true).write(true).mode(0o600);
        let mut file = options.open(&temporary).map_err(|_| {
            SupportControlCommandError::new("CODEX-SUPPORT-SETTINGS-WRITE", operation, true)
        })?;
        file.set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|_| {
                SupportControlCommandError::new(
                    "CODEX-SUPPORT-SETTINGS-PERMISSIONS",
                    operation,
                    false,
                )
            })?;
        file.write_all(bytes).map_err(|_| {
            SupportControlCommandError::new("CODEX-SUPPORT-SETTINGS-WRITE", operation, true)
        })?;
        file.sync_all().map_err(|_| {
            SupportControlCommandError::new("CODEX-SUPPORT-SETTINGS-SYNC", operation, true)
        })?;
        fs::rename(&temporary, path).map_err(|_| {
            SupportControlCommandError::new("CODEX-SUPPORT-SETTINGS-RENAME", operation, true)
        })?;
        sync_directory(root, operation)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn sync_directory(path: &Path, operation: &'static str) -> SupportControlResult<()> {
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| {
            SupportControlCommandError::new("CODEX-SUPPORT-SETTINGS-SYNC", operation, true)
        })
}

fn effective_uid() -> u32 {
    // SAFETY: geteuid has no arguments and returns the current process identity.
    unsafe { libc::geteuid() }
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::symlink;
    use std::os::unix::fs::PermissionsExt;
    use std::thread;

    use super::*;

    fn temporary_directory(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!("coding-wife-{label}-{}", uuid::Uuid::new_v4()))
    }

    #[test]
    fn fresh_settings_preserve_existing_desired_behavior_and_restart() {
        let root = temporary_directory("support-settings-restart");
        let opened = SupportSettingsStore::open(&root);
        assert_eq!(opened.settings, SupportSettingsV1::default());
        let store = opened.store.expect("store");
        let changed = SupportSettingsV1 {
            schema_version: SUPPORT_CONTROL_SCHEMA_VERSION,
            version: 2,
            global_enabled: false,
            commit_explainer_enabled: true,
        };
        store.save(&changed, "test").expect("save");
        let restarted = SupportSettingsStore::open(&root);
        assert_eq!(restarted.settings, changed);
        assert_eq!(
            fs::metadata(root.join(SUPPORT_DIRECTORY))
                .expect("directory")
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(root.join(SUPPORT_DIRECTORY).join(SETTINGS_FILE))
                .expect("settings")
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn corrupt_or_unknown_settings_fail_closed_without_unknown_roles() {
        let root = temporary_directory("support-settings-corrupt");
        let opened = SupportSettingsStore::open(&root);
        let path = opened.store.expect("store").path;
        fs::write(
            &path,
            br#"{"schemaVersion":1,"version":2,"globalEnabled":true,"commitExplainerEnabled":true,"presenceEnabled":true}"#,
        )
        .expect("write malformed role");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).expect("permissions");
        let corrupted = SupportSettingsStore::open(&root);
        assert_eq!(corrupted.settings, SupportSettingsV1::fail_closed());
        assert_eq!(
            corrupted.recovery_code.as_deref(),
            Some(SUPPORT_SETTINGS_CORRUPT)
        );
        fs::write(
            &path,
            br#"{"schemaVersion":2,"version":2,"globalEnabled":true,"commitExplainerEnabled":true}"#,
        )
        .expect("write unknown");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).expect("permissions");
        let unknown = SupportSettingsStore::open(&root);
        assert_eq!(unknown.settings, SupportSettingsV1::fail_closed());
        assert_eq!(
            unknown.recovery_code.as_deref(),
            Some(SUPPORT_SETTINGS_UNKNOWN_VERSION)
        );
        fs::write(
            &path,
            br#"{"schemaVersion":1,"version":0,"globalEnabled":true,"commitExplainerEnabled":true}"#,
        )
        .expect("write unsafe version");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).expect("permissions");
        let unsafe_version = SupportSettingsStore::open(&root);
        assert_eq!(unsafe_version.settings, SupportSettingsV1::fail_closed());
        assert_eq!(
            unsafe_version.recovery_code.as_deref(),
            Some(SUPPORT_SETTINGS_CORRUPT)
        );
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn existing_unsafe_directory_is_never_repaired_before_fail_closed() {
        let root = temporary_directory("support-settings-unsafe-directory");
        let support = root.join(SUPPORT_DIRECTORY);
        fs::create_dir_all(&support).expect("create unsafe fixture");
        fs::set_permissions(&support, fs::Permissions::from_mode(0o777))
            .expect("unsafe permissions");
        let opened = SupportSettingsStore::open(&root);
        assert!(opened.store.is_none());
        assert_eq!(opened.settings, SupportSettingsV1::fail_closed());
        assert_eq!(
            opened.recovery_code.as_deref(),
            Some(SUPPORT_SETTINGS_UNSAFE)
        );
        assert_eq!(
            fs::symlink_metadata(&support)
                .expect("unsafe directory remains")
                .permissions()
                .mode()
                & 0o777,
            0o777
        );
        assert!(!support.join(SETTINGS_FILE).exists());
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn symlink_and_owner_mismatch_fixtures_fail_closed() {
        let root = temporary_directory("support-settings-symlink");
        let target = root.join("target");
        fs::create_dir_all(&target).expect("target");
        fs::set_permissions(&target, fs::Permissions::from_mode(0o700)).expect("target mode");
        symlink(&target, root.join(SUPPORT_DIRECTORY)).expect("support symlink");
        let opened = SupportSettingsStore::open(&root);
        assert!(opened.store.is_none());
        assert_eq!(opened.settings, SupportSettingsV1::fail_closed());
        assert_eq!(
            opened.recovery_code.as_deref(),
            Some(SUPPORT_SETTINGS_UNSAFE)
        );

        let metadata = fs::symlink_metadata(&target).expect("target metadata");
        assert_eq!(
            validate_private_directory_metadata(&metadata, effective_uid().wrapping_add(1)),
            Err(SUPPORT_SETTINGS_UNSAFE)
        );
        fs::remove_file(root.join(SUPPORT_DIRECTORY)).expect("remove symlink");
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn existing_safe_private_directory_without_file_gets_fresh_defaults() {
        let root = temporary_directory("support-settings-safe-directory");
        let support = root.join(SUPPORT_DIRECTORY);
        fs::create_dir_all(&support).expect("create safe fixture");
        fs::set_permissions(&support, fs::Permissions::from_mode(0o700)).expect("safe mode");
        let opened = SupportSettingsStore::open(&root);
        assert_eq!(opened.settings, SupportSettingsV1::default());
        assert!(opened.recovery_code.is_none());
        assert!(support.join(SETTINGS_FILE).is_file());
        fs::remove_dir_all(root).expect("cleanup");
    }

    fn populated_audit(policy_version: u64, attempted_tasks: u64) -> SupportDurableAuditV1 {
        SupportDurableAuditV1 {
            schema_version: AUDIT_SCHEMA_VERSION,
            policy_version,
            usage: SupportUsageCountersV1 {
                attempted_tasks,
                started_tasks: attempted_tasks,
                succeeded_tasks: attempted_tasks,
                input_tokens: attempted_tasks.saturating_mul(3),
                output_tokens: attempted_tasks.saturating_mul(2),
                total_tokens: attempted_tasks.saturating_mul(5),
                total_latency_ms: attempted_tasks.saturating_mul(10),
                ..SupportUsageCountersV1::default()
            },
            fallback_tasks: 0,
            latest_outcome: Some(SupportLatestOutcomeV1 {
                status: SupportOutcomeStatus::Generated,
                trigger: "user_request".to_owned(),
                completed_at: chrono::Utc::now().to_rfc3339(),
                latency_ms: Some(10),
                input_tokens: 3,
                output_tokens: 2,
                total_tokens: 5,
                error_code: None,
            }),
            last_error_code: None,
            raw_transcript_persisted: false,
            updated_at: chrono::Utc::now().to_rfc3339(),
        }
    }

    #[test]
    fn durable_audit_restores_one_private_bounded_snapshot_without_sensitive_content() {
        let root = temporary_directory("support-audit-restart");
        let opened = SupportAuditStore::open(&root, Some(7));
        assert!(opened.recovery_code.is_none());
        let store = opened.store.expect("audit store");
        let state = populated_audit(7, 4);
        store.save(&state, "test").expect("save audit");

        let restarted = SupportAuditStore::open(&root, Some(7));
        assert_eq!(restarted.state, state);
        assert!(restarted.recovery_code.is_none());
        let path = root.join(SUPPORT_DIRECTORY).join(AUDIT_FILE);
        assert_eq!(
            fs::metadata(&path)
                .expect("audit metadata")
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        assert!(fs::metadata(&path).expect("audit size").len() <= MAX_AUDIT_DATABASE_BYTES);
        let connection = open_audit_connection(&path).expect("open audit");
        let (rows, payload): (u64, String) = connection
            .query_row(
                "SELECT count(*), payload_json FROM support_audit_state WHERE id = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("single retained row");
        assert_eq!(rows, 1);
        for forbidden in [
            "prompt",
            "transcript",
            "credential",
            "accessToken",
            "/Users/",
            "workspacePath",
        ] {
            assert!(!payload.contains(forbidden), "payload leaked {forbidden}");
        }
        assert!(payload.contains("\"rawTranscriptPersisted\":false"));
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn durable_audit_corruption_schema_and_policy_mismatch_fail_closed() {
        let corrupt_root = temporary_directory("support-audit-corrupt");
        let corrupt_path = SupportAuditStore::open(&corrupt_root, Some(1))
            .store
            .expect("store")
            .path;
        fs::write(&corrupt_path, b"not-a-sqlite-database").expect("corrupt audit");
        fs::set_permissions(&corrupt_path, fs::Permissions::from_mode(0o600)).expect("audit mode");
        let corrupted = SupportAuditStore::open(&corrupt_root, Some(1));
        assert!(corrupted.store.is_none());
        assert_eq!(
            corrupted.recovery_code.as_deref(),
            Some(SUPPORT_AUDIT_CORRUPT)
        );

        let schema_root = temporary_directory("support-audit-schema");
        let schema_path = SupportAuditStore::open(&schema_root, Some(1))
            .store
            .expect("store")
            .path;
        open_audit_connection(&schema_path)
            .expect("schema connection")
            .execute_batch("PRAGMA user_version = 2;")
            .expect("unknown schema");
        let unknown = SupportAuditStore::open(&schema_root, Some(1));
        assert!(unknown.store.is_none());
        assert_eq!(
            unknown.recovery_code.as_deref(),
            Some(SUPPORT_AUDIT_CORRUPT)
        );

        let policy_root = temporary_directory("support-audit-policy");
        let policy = SupportAuditStore::open(&policy_root, Some(1));
        let store = policy.store.expect("policy store");
        store
            .save(&populated_audit(1, 1), "test")
            .expect("policy audit");
        let settings = SupportSettingsStore::open(&policy_root);
        let settings_store = settings.store.expect("settings store");
        let settings_v2 = SupportSettingsV1 {
            version: 2,
            ..settings.settings
        };
        settings_store
            .save(&settings_v2, "test")
            .expect("new policy version");
        let mismatch = SupportAuditStore::open(&policy_root, Some(settings_v2.version));
        assert!(mismatch.store.is_some());
        assert_eq!(
            mismatch.recovery_code.as_deref(),
            Some(SUPPORT_AUDIT_POLICY_MISMATCH)
        );

        fs::remove_dir_all(corrupt_root).expect("corrupt cleanup");
        fs::remove_dir_all(schema_root).expect("schema cleanup");
        fs::remove_dir_all(policy_root).expect("policy cleanup");
    }

    #[test]
    fn durable_audit_rejects_unsafe_files_and_invalid_bounds_without_overwrite() {
        let root = temporary_directory("support-audit-unsafe");
        let opened = SupportAuditStore::open(&root, Some(1));
        let store = opened.store.expect("store");
        let previous = populated_audit(1, 2);
        store.save(&previous, "test").expect("baseline");

        let mut invalid = previous.clone();
        invalid.usage.attempted_tasks = SUPPORT_MAX_SAFE_COUNTER + 1;
        assert_eq!(
            store.save(&invalid, "test").expect_err("bounded").code,
            SUPPORT_AUDIT_CORRUPT
        );
        assert_eq!(SupportAuditStore::open(&root, Some(1)).state, previous);

        fs::set_permissions(&store.path, fs::Permissions::from_mode(0o666))
            .expect("unsafe audit mode");
        let unsafe_open = SupportAuditStore::open(&root, Some(1));
        assert!(unsafe_open.store.is_none());
        assert_eq!(
            unsafe_open.recovery_code.as_deref(),
            Some(SUPPORT_AUDIT_UNSAFE)
        );
        assert_eq!(
            fs::metadata(&store.path)
                .expect("unsafe mode retained")
                .permissions()
                .mode()
                & 0o777,
            0o666
        );
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn concurrent_audit_writes_remain_atomic_and_single_row() {
        let root = temporary_directory("support-audit-concurrent");
        let store = SupportAuditStore::open(&root, Some(3))
            .store
            .expect("store");
        let handles = (1..=8)
            .map(|attempted| {
                let store = store.clone();
                thread::spawn(move || {
                    store
                        .save(&populated_audit(3, attempted), "test")
                        .expect("concurrent save");
                })
            })
            .collect::<Vec<_>>();
        for handle in handles {
            handle.join().expect("writer thread");
        }
        let restarted = SupportAuditStore::open(&root, Some(3));
        assert!(restarted.recovery_code.is_none());
        assert!((1..=8).contains(&restarted.state.usage.attempted_tasks));
        let connection = open_audit_connection(&store.path).expect("open audit");
        let row_count: u64 = connection
            .query_row("SELECT count(*) FROM support_audit_state", [], |row| {
                row.get(0)
            })
            .expect("row count");
        let integrity: String = connection
            .query_row("PRAGMA quick_check(1)", [], |row| row.get(0))
            .expect("integrity");
        assert_eq!(row_count, 1);
        assert_eq!(integrity, "ok");
        fs::remove_dir_all(root).expect("cleanup");
    }
}
