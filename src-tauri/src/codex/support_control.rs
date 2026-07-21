//! Native commit-explanation policy persistence and bounded audit metadata.
//!
//! The required model policy is app-owned and has no user-facing settings boundary.
//! Prompts, responses, paths, credentials, and transcripts are deliberately absent.

#[cfg(unix)]
use std::ffi::CString;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
#[cfg(unix)]
use std::os::fd::{AsRawFd, FromRawFd};
#[cfg(windows)]
use std::os::windows::ffi::OsStringExt;
#[cfg(windows)]
use std::os::windows::io::AsRawHandle;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex};

use rusqlite::{Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};

use crate::platform_fs::{
    current_user_id, DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt, O_CLOEXEC,
    O_DIRECTORY, O_NOFOLLOW,
};

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

    fn normalize_required_policy(mut self) -> (Self, bool) {
        if self.global_enabled && self.commit_explainer_enabled {
            return (self, false);
        }
        self.global_enabled = true;
        self.commit_explainer_enabled = true;
        (self, true)
    }
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
    #[cfg(test)]
    path: PathBuf,
    root_directory: Arc<File>,
}

pub(crate) struct SupportSettingsStoreOpen {
    pub store: Option<SupportSettingsStore>,
    pub settings: SupportSettingsV1,
    pub recovery_code: Option<String>,
}

#[derive(Clone, Debug)]
pub(crate) struct SupportAuditStore {
    root: PathBuf,
    #[cfg(test)]
    path: PathBuf,
    root_directory: Arc<File>,
    state: Arc<StdMutex<SupportAuditStoreState>>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct FileIdentity {
    device: u64,
    inode: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct PrivateEntryMetadata {
    identity: FileIdentity,
    mode: u32,
    uid: u32,
    size: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum AtomicPublishError {
    NamespaceUnsafe,
    Sync,
}

struct AtomicPublishRequest<'a> {
    root: &'a Path,
    directory: &'a File,
    source: &'a str,
    destination: &'a str,
    source_identity: FileIdentity,
    expected_destination_identity: Option<FileIdentity>,
    maximum_bytes: u64,
}

#[derive(Debug)]
struct SupportAuditStoreState {
    entry_identity: Option<FileIdentity>,
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
        let root_directory =
            Arc::new(ensure_private_directory(&root).map_err(map_audit_directory_error)?);
        let existing = entry_metadata_at(&root_directory, AUDIT_FILE)
            .map_err(|_| SUPPORT_AUDIT_UNAVAILABLE)?;
        if let Some(metadata) = existing.as_ref() {
            validate_private_regular_entry(metadata, MAX_AUDIT_DATABASE_BYTES)
                .map_err(|_| SUPPORT_AUDIT_UNSAFE)?;
        }
        let store = Self {
            root,
            #[cfg(test)]
            path: app_data_directory.join(SUPPORT_DIRECTORY).join(AUDIT_FILE),
            root_directory,
            state: Arc::new(StdMutex::new(SupportAuditStoreState {
                entry_identity: existing.map(|metadata| metadata.identity),
            })),
        };
        if existing.is_none() {
            let state = SupportDurableAuditV1::fresh(expected_policy_version.unwrap_or(0));
            store
                .save(&state, "support_audit_startup")
                .map_err(|error| {
                    if error.code == SUPPORT_AUDIT_UNSAFE {
                        SUPPORT_AUDIT_UNSAFE
                    } else {
                        SUPPORT_AUDIT_UNAVAILABLE
                    }
                })?;
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

    fn load(&self) -> Result<SupportDurableAuditV1, &'static str> {
        let state = self.state.lock().map_err(|_| SUPPORT_AUDIT_UNAVAILABLE)?;
        let expected = state.entry_identity.ok_or(SUPPORT_AUDIT_CORRUPT)?;
        verify_directory_identity(&self.root, &self.root_directory)
            .map_err(map_audit_directory_error)?;
        let file = open_verified_regular_at(
            &self.root_directory,
            AUDIT_FILE,
            expected,
            MAX_AUDIT_DATABASE_BYTES,
        )
        .map_err(|_| SUPPORT_AUDIT_UNSAFE)?;
        let connection =
            open_audit_connection_from_file(&file, true).map_err(|_| SUPPORT_AUDIT_CORRUPT)?;
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
        verify_directory_identity(&self.root, &self.root_directory)
            .map_err(map_audit_directory_error)?;
        verify_entry_identity_at(
            &self.root_directory,
            AUDIT_FILE,
            expected,
            MAX_AUDIT_DATABASE_BYTES,
        )
        .map_err(|_| SUPPORT_AUDIT_UNSAFE)?;
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
        self.replace_database_with_hook(&payload, operation, || {})
    }

    fn replace_database_with_hook<F>(
        &self,
        payload: &str,
        operation: &'static str,
        before_namespace_commit: F,
    ) -> SupportControlResult<()>
    where
        F: FnOnce(),
    {
        self.replace_database_with_hooks(payload, operation, before_namespace_commit, || {})
    }

    fn replace_database_with_hooks<F, G>(
        &self,
        payload: &str,
        operation: &'static str,
        before_namespace_commit: F,
        after_namespace_validation: G,
    ) -> SupportControlResult<()>
    where
        F: FnOnce(),
        G: FnOnce(),
    {
        let mut store_state = self.state.lock().map_err(|_| {
            SupportControlCommandError::new(SUPPORT_AUDIT_UNAVAILABLE, operation, true)
        })?;
        verify_directory_identity(&self.root, &self.root_directory)
            .map_err(|_| SupportControlCommandError::new(SUPPORT_AUDIT_UNSAFE, operation, false))?;
        verify_optional_entry_identity_at(
            &self.root_directory,
            AUDIT_FILE,
            store_state.entry_identity,
            MAX_AUDIT_DATABASE_BYTES,
        )
        .map_err(|_| SupportControlCommandError::new(SUPPORT_AUDIT_UNSAFE, operation, false))?;

        let temporary_name = format!(".audit-v1.{}.tmp", uuid::Uuid::new_v4());
        let temporary =
            open_private_temporary(&self.root_directory, &temporary_name).map_err(|_| {
                SupportControlCommandError::new("CODEX-SUPPORT-AUDIT-WRITE", operation, true)
            })?;
        let temporary_identity = match private_file_metadata(&temporary, MAX_AUDIT_DATABASE_BYTES) {
            Ok(metadata) => metadata.identity,
            Err(_) => {
                let _ = unlink_entry_at(&self.root_directory, &temporary_name);
                return Err(SupportControlCommandError::new(
                    SUPPORT_AUDIT_UNSAFE,
                    operation,
                    false,
                ));
            }
        };
        let result = (|| {
            let mut connection =
                open_audit_connection_from_file(&temporary, false).map_err(|_| {
                    SupportControlCommandError::new("CODEX-SUPPORT-AUDIT-WRITE", operation, true)
                })?;
            verify_directory_identity(&self.root, &self.root_directory).map_err(|_| {
                SupportControlCommandError::new(SUPPORT_AUDIT_UNSAFE, operation, false)
            })?;
            verify_optional_entry_identity_at(
                &self.root_directory,
                AUDIT_FILE,
                store_state.entry_identity,
                MAX_AUDIT_DATABASE_BYTES,
            )
            .map_err(|_| SupportControlCommandError::new(SUPPORT_AUDIT_UNSAFE, operation, false))?;
            verify_entry_identity_at(
                &self.root_directory,
                &temporary_name,
                temporary_identity,
                MAX_AUDIT_DATABASE_BYTES,
            )
            .map_err(|_| SupportControlCommandError::new(SUPPORT_AUDIT_UNSAFE, operation, false))?;
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|_| {
                    SupportControlCommandError::new("CODEX-SUPPORT-AUDIT-WRITE", operation, true)
                })?;
            transaction
                .execute_batch(
                    "CREATE TABLE support_audit_state (
                        id INTEGER PRIMARY KEY CHECK (id = 1),
                        payload_json TEXT NOT NULL CHECK (length(payload_json) <= 32768)
                    );
                    PRAGMA user_version = 1;",
                )
                .map_err(|_| {
                    SupportControlCommandError::new("CODEX-SUPPORT-AUDIT-WRITE", operation, true)
                })?;
            transaction
                .execute(
                    "INSERT INTO support_audit_state (id, payload_json) VALUES (1, ?1)",
                    [payload],
                )
                .map_err(|_| {
                    SupportControlCommandError::new("CODEX-SUPPORT-AUDIT-WRITE", operation, true)
                })?;
            transaction.commit().map_err(|_| {
                SupportControlCommandError::new("CODEX-SUPPORT-AUDIT-SYNC", operation, true)
            })?;
            drop(connection);
            temporary.sync_all().map_err(|_| {
                SupportControlCommandError::new("CODEX-SUPPORT-AUDIT-SYNC", operation, true)
            })?;

            before_namespace_commit();
            publish_private_entry_with_hook(
                AtomicPublishRequest {
                    root: &self.root,
                    directory: &self.root_directory,
                    source: &temporary_name,
                    destination: AUDIT_FILE,
                    source_identity: temporary_identity,
                    expected_destination_identity: store_state.entry_identity,
                    maximum_bytes: MAX_AUDIT_DATABASE_BYTES,
                },
                after_namespace_validation,
            )
            .map_err(|error| match error {
                AtomicPublishError::NamespaceUnsafe => {
                    SupportControlCommandError::new(SUPPORT_AUDIT_UNSAFE, operation, false)
                }
                AtomicPublishError::Sync => {
                    SupportControlCommandError::new("CODEX-SUPPORT-AUDIT-SYNC", operation, true)
                }
            })?;
            store_state.entry_identity = Some(temporary_identity);
            Ok(())
        })();
        if result.is_err() {
            let _ = unlink_entry_at(&self.root_directory, &temporary_name);
        }
        result
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
        let root_directory = Arc::new(ensure_private_directory(&root)?);
        let store = Self {
            #[cfg(test)]
            path: root.join(SETTINGS_FILE),
            root,
            root_directory,
        };
        let existing = entry_metadata_at(&store.root_directory, SETTINGS_FILE)
            .map_err(|_| SUPPORT_SETTINGS_UNAVAILABLE)?;
        if let Some(metadata) = existing.as_ref() {
            validate_private_regular_entry(metadata, MAX_SETTINGS_BYTES)?;
        } else {
            let settings = SupportSettingsV1::default();
            store
                .save(&settings, "support_settings_startup")
                .map_err(|error| {
                    if error.code == SUPPORT_SETTINGS_UNSAFE {
                        SUPPORT_SETTINGS_UNSAFE
                    } else {
                        SUPPORT_SETTINGS_UNAVAILABLE
                    }
                })?;
            return Ok(SupportSettingsStoreOpen {
                store: Some(store),
                settings,
                recovery_code: None,
            });
        }

        match store.load() {
            Ok(settings) => {
                let (settings, migrated) = settings.normalize_required_policy();
                if migrated {
                    store
                        .save(&settings, "support_settings_startup")
                        .map_err(|error| {
                            if error.code == SUPPORT_SETTINGS_UNSAFE {
                                SUPPORT_SETTINGS_UNSAFE
                            } else {
                                SUPPORT_SETTINGS_UNAVAILABLE
                            }
                        })?;
                }
                Ok(SupportSettingsStoreOpen {
                    store: Some(store),
                    settings,
                    recovery_code: None,
                })
            }
            Err(code @ SUPPORT_SETTINGS_UNSAFE) => Err(code),
            Err(code) => Ok(SupportSettingsStoreOpen {
                store: Some(store),
                settings: SupportSettingsV1::fail_closed(),
                recovery_code: Some(code.to_owned()),
            }),
        }
    }

    fn load(&self) -> Result<SupportSettingsV1, &'static str> {
        verify_directory_identity(&self.root, &self.root_directory)?;
        let expected = entry_metadata_at(&self.root_directory, SETTINGS_FILE)
            .map_err(|_| SUPPORT_SETTINGS_UNAVAILABLE)?
            .ok_or(SUPPORT_SETTINGS_UNAVAILABLE)?;
        validate_private_regular_entry(&expected, MAX_SETTINGS_BYTES)?;
        let mut file = open_verified_regular_at(
            &self.root_directory,
            SETTINGS_FILE,
            expected.identity,
            MAX_SETTINGS_BYTES,
        )?;
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
        verify_directory_identity(&self.root, &self.root_directory)?;
        verify_entry_identity_at(
            &self.root_directory,
            SETTINGS_FILE,
            expected.identity,
            MAX_SETTINGS_BYTES,
        )?;
        Ok(settings)
    }

    pub(crate) fn save(
        &self,
        settings: &SupportSettingsV1,
        operation: &'static str,
    ) -> SupportControlResult<()> {
        validate_settings(settings)
            .map_err(|code| SupportControlCommandError::new(code, operation, false))?;
        verify_directory_identity(&self.root, &self.root_directory)
            .map_err(|code| SupportControlCommandError::new(code, operation, false))?;
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
        atomic_write(
            &self.root,
            &self.root_directory,
            SETTINGS_FILE,
            &bytes,
            operation,
        )
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

#[cfg(test)]
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

#[cfg(unix)]
fn open_audit_connection_from_file(file: &File, read_only: bool) -> rusqlite::Result<Connection> {
    let descriptor_path = format!("/dev/fd/{}", file.as_raw_fd());
    let access = if read_only {
        OpenFlags::SQLITE_OPEN_READ_ONLY
    } else {
        OpenFlags::SQLITE_OPEN_READ_WRITE
    };
    let connection =
        Connection::open_with_flags(descriptor_path, access | OpenFlags::SQLITE_OPEN_NO_MUTEX)?;
    connection.busy_timeout(std::time::Duration::from_secs(1))?;
    if read_only {
        connection.execute_batch(
            "PRAGMA query_only = ON;
             PRAGMA temp_store = MEMORY;
             PRAGMA trusted_schema = OFF;",
        )?;
    } else {
        // This connection targets a brand-new private inode. The complete database
        // is synced and atomically installed only after the transaction commits.
        connection.execute_batch(
            "PRAGMA journal_mode = OFF;
             PRAGMA synchronous = FULL;
             PRAGMA temp_store = MEMORY;
             PRAGMA trusted_schema = OFF;
             PRAGMA max_page_count = 1024;",
        )?;
    }
    Ok(connection)
}

#[cfg(windows)]
fn open_audit_connection_from_file(file: &File, read_only: bool) -> rusqlite::Result<Connection> {
    let path = windows_file_path(file).map_err(|_| rusqlite::Error::InvalidPath(PathBuf::new()))?;
    let access = if read_only {
        OpenFlags::SQLITE_OPEN_READ_ONLY
    } else {
        OpenFlags::SQLITE_OPEN_READ_WRITE
    };
    let connection = Connection::open_with_flags(path, access | OpenFlags::SQLITE_OPEN_NO_MUTEX)?;
    connection.busy_timeout(std::time::Duration::from_secs(1))?;
    if read_only {
        connection.execute_batch(
            "PRAGMA query_only = ON;
             PRAGMA temp_store = MEMORY;
             PRAGMA trusted_schema = OFF;",
        )?;
    } else {
        connection.execute_batch(
            "PRAGMA journal_mode = OFF;
             PRAGMA synchronous = FULL;
             PRAGMA temp_store = MEMORY;
             PRAGMA trusted_schema = OFF;
             PRAGMA max_page_count = 1024;",
        )?;
    }
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

fn ensure_private_directory(path: &Path) -> Result<File, &'static str> {
    let mut created = false;
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
            created = true;
            let metadata = fs::symlink_metadata(path).map_err(|_| SUPPORT_SETTINGS_UNAVAILABLE)?;
            validate_private_directory_metadata(&metadata, effective_uid())?;
        }
        Err(_) => return Err(SUPPORT_SETTINGS_UNAVAILABLE),
    }

    let mut options = OpenOptions::new();
    options
        .read(true)
        .custom_flags(O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    let directory = options.open(path).map_err(|_| SUPPORT_SETTINGS_UNSAFE)?;
    verify_directory_identity(path, &directory)?;
    if created {
        File::open(path.parent().unwrap_or(path))
            .and_then(|parent| parent.sync_all())
            .map_err(|_| SUPPORT_SETTINGS_UNAVAILABLE)?;
    }
    Ok(directory)
}

fn validate_private_directory_metadata(
    metadata: &fs::Metadata,
    expected_uid: u32,
) -> Result<(), &'static str> {
    if !metadata.file_type().is_dir()
        || metadata.uid() != expected_uid
        || metadata.mode() & 0o777 != 0o700
    {
        return Err(SUPPORT_SETTINGS_UNSAFE);
    }
    Ok(())
}

fn map_audit_directory_error(code: &'static str) -> &'static str {
    if code == SUPPORT_SETTINGS_UNSAFE {
        SUPPORT_AUDIT_UNSAFE
    } else {
        SUPPORT_AUDIT_UNAVAILABLE
    }
}

fn verify_directory_identity(path: &Path, directory: &File) -> Result<(), &'static str> {
    let path_metadata = fs::symlink_metadata(path).map_err(|_| SUPPORT_SETTINGS_UNSAFE)?;
    validate_private_directory_metadata(&path_metadata, effective_uid())?;
    let opened_metadata = directory
        .metadata()
        .map_err(|_| SUPPORT_SETTINGS_UNAVAILABLE)?;
    validate_private_directory_metadata(&opened_metadata, effective_uid())?;
    if file_identity(&path_metadata) != file_identity(&opened_metadata) {
        return Err(SUPPORT_SETTINGS_UNSAFE);
    }
    Ok(())
}

fn file_identity(metadata: &fs::Metadata) -> FileIdentity {
    FileIdentity {
        device: metadata.dev(),
        inode: metadata.ino(),
    }
}

fn private_file_metadata(
    file: &File,
    maximum_bytes: u64,
) -> Result<PrivateEntryMetadata, &'static str> {
    let metadata = file.metadata().map_err(|_| SUPPORT_SETTINGS_UNAVAILABLE)?;
    let entry = PrivateEntryMetadata {
        identity: file_identity(&metadata),
        mode: metadata.mode(),
        uid: metadata.uid(),
        size: metadata.len(),
    };
    validate_private_regular_entry(&entry, maximum_bytes)?;
    Ok(entry)
}

fn validate_private_regular_entry(
    metadata: &PrivateEntryMetadata,
    maximum_bytes: u64,
) -> Result<(), &'static str> {
    if metadata.mode & 0o170000 != 0o100000
        || metadata.uid != effective_uid()
        || metadata.mode & 0o777 != 0o600
        || metadata.size > maximum_bytes
    {
        return Err(SUPPORT_SETTINGS_UNSAFE);
    }
    Ok(())
}

#[cfg(unix)]
fn entry_metadata_at(
    directory: &File,
    name: &str,
) -> std::io::Result<Option<PrivateEntryMetadata>> {
    let name =
        CString::new(name).map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    let mut metadata = std::mem::MaybeUninit::<libc::stat>::uninit();
    // SAFETY: directory is an open directory descriptor, name is NUL-terminated,
    // and metadata points to writable storage for one libc::stat value.
    let result = unsafe {
        libc::fstatat(
            directory.as_raw_fd(),
            name.as_ptr(),
            metadata.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    };
    if result != 0 {
        let error = std::io::Error::last_os_error();
        if error.kind() == std::io::ErrorKind::NotFound {
            return Ok(None);
        }
        return Err(error);
    }
    // SAFETY: fstatat succeeded and initialized metadata.
    let metadata = unsafe { metadata.assume_init() };
    Ok(Some(PrivateEntryMetadata {
        identity: FileIdentity {
            device: metadata.st_dev as u64,
            inode: metadata.st_ino,
        },
        mode: metadata.st_mode as u32,
        uid: metadata.st_uid,
        size: u64::try_from(metadata.st_size).unwrap_or(u64::MAX),
    }))
}

#[cfg(windows)]
fn entry_metadata_at(
    directory: &File,
    name: &str,
) -> std::io::Result<Option<PrivateEntryMetadata>> {
    let path = windows_entry_path(directory, name)?;
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    Ok(Some(PrivateEntryMetadata {
        identity: file_identity(&metadata),
        mode: metadata.mode(),
        uid: metadata.uid(),
        size: metadata.len(),
    }))
}

#[cfg(unix)]
fn open_verified_regular_at(
    directory: &File,
    name: &str,
    expected_identity: FileIdentity,
    maximum_bytes: u64,
) -> Result<File, &'static str> {
    let name = CString::new(name).map_err(|_| SUPPORT_SETTINGS_UNSAFE)?;
    // SAFETY: directory and name are valid; the returned descriptor is checked
    // before ownership is transferred to File.
    let descriptor = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if descriptor < 0 {
        return Err(SUPPORT_SETTINGS_UNSAFE);
    }
    // SAFETY: openat returned a new owned descriptor.
    let file = unsafe { File::from_raw_fd(descriptor) };
    let opened = private_file_metadata(&file, maximum_bytes)?;
    if opened.identity != expected_identity {
        return Err(SUPPORT_SETTINGS_UNSAFE);
    }
    verify_entry_identity_at(
        directory,
        name.to_str().map_err(|_| SUPPORT_SETTINGS_UNSAFE)?,
        expected_identity,
        maximum_bytes,
    )?;
    Ok(file)
}

#[cfg(windows)]
fn open_verified_regular_at(
    directory: &File,
    name: &str,
    expected_identity: FileIdentity,
    maximum_bytes: u64,
) -> Result<File, &'static str> {
    let path = windows_entry_path(directory, name).map_err(|_| SUPPORT_SETTINGS_UNSAFE)?;
    let source = fs::symlink_metadata(&path).map_err(|_| SUPPORT_SETTINGS_UNSAFE)?;
    if source.file_type().is_symlink() {
        return Err(SUPPORT_SETTINGS_UNSAFE);
    }
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(O_NOFOLLOW | O_CLOEXEC)
        .open(path)
        .map_err(|_| SUPPORT_SETTINGS_UNSAFE)?;
    let opened = private_file_metadata(&file, maximum_bytes)?;
    if opened.identity != expected_identity {
        return Err(SUPPORT_SETTINGS_UNSAFE);
    }
    verify_entry_identity_at(directory, name, expected_identity, maximum_bytes)?;
    Ok(file)
}

fn verify_entry_identity_at(
    directory: &File,
    name: &str,
    expected_identity: FileIdentity,
    maximum_bytes: u64,
) -> Result<(), &'static str> {
    let metadata = entry_metadata_at(directory, name)
        .map_err(|_| SUPPORT_SETTINGS_UNSAFE)?
        .ok_or(SUPPORT_SETTINGS_UNSAFE)?;
    validate_private_regular_entry(&metadata, maximum_bytes)?;
    if metadata.identity != expected_identity {
        return Err(SUPPORT_SETTINGS_UNSAFE);
    }
    Ok(())
}

fn verify_optional_entry_identity_at(
    directory: &File,
    name: &str,
    expected_identity: Option<FileIdentity>,
    maximum_bytes: u64,
) -> Result<(), &'static str> {
    match (
        entry_metadata_at(directory, name).map_err(|_| SUPPORT_SETTINGS_UNSAFE)?,
        expected_identity,
    ) {
        (None, None) => Ok(()),
        (Some(metadata), Some(expected)) => {
            validate_private_regular_entry(&metadata, maximum_bytes)?;
            if metadata.identity == expected {
                Ok(())
            } else {
                Err(SUPPORT_SETTINGS_UNSAFE)
            }
        }
        _ => Err(SUPPORT_SETTINGS_UNSAFE),
    }
}

#[cfg(unix)]
fn open_private_temporary(directory: &File, name: &str) -> std::io::Result<File> {
    let entry_name = name;
    let name = CString::new(entry_name)
        .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    // SAFETY: directory and name are valid. O_EXCL and O_NOFOLLOW ensure this
    // creates a new regular entry inside the pinned private directory.
    let descriptor = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDWR | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0o600,
        )
    };
    if descriptor < 0 {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: openat returned a new owned descriptor.
    let file = unsafe { File::from_raw_fd(descriptor) };
    if let Err(error) = file.set_permissions(fs::Permissions::from_mode(0o600)) {
        drop(file);
        let _ = unlink_entry_at(directory, entry_name);
        return Err(error);
    }
    Ok(file)
}

#[cfg(windows)]
fn open_private_temporary(directory: &File, name: &str) -> std::io::Result<File> {
    let path = windows_entry_path(directory, name)?;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(O_NOFOLLOW | O_CLOEXEC)
        .open(path)?;
    file.set_permissions(fs::Permissions::from_mode(0o600))?;
    Ok(file)
}

#[cfg(unix)]
fn rename_entry_at(directory: &File, source: &str, destination: &str) -> std::io::Result<()> {
    let source =
        CString::new(source).map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    let destination = CString::new(destination)
        .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    // SAFETY: both names are valid and relative to the same open directory.
    if unsafe {
        libc::renameat(
            directory.as_raw_fd(),
            source.as_ptr(),
            directory.as_raw_fd(),
            destination.as_ptr(),
        )
    } == 0
    {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(windows)]
fn rename_entry_at(directory: &File, source: &str, destination: &str) -> std::io::Result<()> {
    fs::rename(
        windows_entry_path(directory, source)?,
        windows_entry_path(directory, destination)?,
    )
}

#[cfg(unix)]
fn link_entry_at(directory: &File, source: &str, destination: &str) -> std::io::Result<()> {
    let source =
        CString::new(source).map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    let destination = CString::new(destination)
        .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    // SAFETY: both names are valid and relative to the same pinned directory.
    // No AT_SYMLINK_FOLLOW flag is used, so the source entry is never followed.
    if unsafe {
        libc::linkat(
            directory.as_raw_fd(),
            source.as_ptr(),
            directory.as_raw_fd(),
            destination.as_ptr(),
            0,
        )
    } == 0
    {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(windows)]
fn link_entry_at(directory: &File, source: &str, destination: &str) -> std::io::Result<()> {
    fs::hard_link(
        windows_entry_path(directory, source)?,
        windows_entry_path(directory, destination)?,
    )
}

#[cfg(target_os = "macos")]
fn atomic_exchange_entries_at(
    directory: &File,
    source: &str,
    destination: &str,
) -> std::io::Result<()> {
    let source =
        CString::new(source).map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    let destination = CString::new(destination)
        .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    // SAFETY: renameatx_np atomically swaps two entries in the pinned directory.
    if unsafe {
        libc::renameatx_np(
            directory.as_raw_fd(),
            source.as_ptr(),
            directory.as_raw_fd(),
            destination.as_ptr(),
            libc::RENAME_SWAP,
        )
    } == 0
    {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(target_os = "linux")]
fn atomic_exchange_entries_at(
    directory: &File,
    source: &str,
    destination: &str,
) -> std::io::Result<()> {
    let source =
        CString::new(source).map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    let destination = CString::new(destination)
        .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    // SAFETY: renameat2 atomically exchanges two entries in the pinned directory.
    if unsafe {
        libc::renameat2(
            directory.as_raw_fd(),
            source.as_ptr(),
            directory.as_raw_fd(),
            destination.as_ptr(),
            libc::RENAME_EXCHANGE,
        )
    } == 0
    {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn atomic_exchange_entries_at(
    _directory: &File,
    _source: &str,
    _destination: &str,
) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "atomic namespace exchange is unavailable",
    ))
}

#[cfg(target_os = "macos")]
fn atomic_rename_exclusive_at(
    directory: &File,
    source: &str,
    destination: &str,
) -> std::io::Result<()> {
    let source =
        CString::new(source).map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    let destination = CString::new(destination)
        .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    // SAFETY: RENAME_EXCL publishes source only while destination is absent.
    if unsafe {
        libc::renameatx_np(
            directory.as_raw_fd(),
            source.as_ptr(),
            directory.as_raw_fd(),
            destination.as_ptr(),
            libc::RENAME_EXCL,
        )
    } == 0
    {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(target_os = "linux")]
fn atomic_rename_exclusive_at(
    directory: &File,
    source: &str,
    destination: &str,
) -> std::io::Result<()> {
    let source =
        CString::new(source).map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    let destination = CString::new(destination)
        .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    // SAFETY: RENAME_NOREPLACE publishes source only while destination is absent.
    if unsafe {
        libc::renameat2(
            directory.as_raw_fd(),
            source.as_ptr(),
            directory.as_raw_fd(),
            destination.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    } == 0
    {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn atomic_rename_exclusive_at(
    _directory: &File,
    _source: &str,
    _destination: &str,
) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "exclusive atomic rename is unavailable",
    ))
}

fn restore_canonical_from_backup(
    root: &Path,
    directory: &File,
    backup: &str,
    destination: &str,
    expected_identity: FileIdentity,
    maximum_bytes: u64,
) -> bool {
    if verify_entry_identity_at(directory, backup, expected_identity, maximum_bytes).is_err() {
        return false;
    }
    // A normal rename is used only for rollback from a verified private hard-link;
    // it is never a publication fallback when atomic exchange is unavailable.
    if rename_entry_at(directory, backup, destination).is_err()
        || directory.sync_all().is_err()
        || verify_directory_identity(root, directory).is_err()
        || verify_entry_identity_at(directory, destination, expected_identity, maximum_bytes)
            .is_err()
    {
        return false;
    }
    true
}

fn publish_private_entry_with_hook<F>(
    request: AtomicPublishRequest<'_>,
    after_namespace_validation: F,
) -> Result<(), AtomicPublishError>
where
    F: FnOnce(),
{
    let AtomicPublishRequest {
        root,
        directory,
        source,
        destination,
        source_identity,
        expected_destination_identity,
        maximum_bytes,
    } = request;
    verify_directory_identity(root, directory).map_err(|_| AtomicPublishError::NamespaceUnsafe)?;
    verify_entry_identity_at(directory, source, source_identity, maximum_bytes)
        .map_err(|_| AtomicPublishError::NamespaceUnsafe)?;
    verify_optional_entry_identity_at(
        directory,
        destination,
        expected_destination_identity,
        maximum_bytes,
    )
    .map_err(|_| AtomicPublishError::NamespaceUnsafe)?;

    let Some(expected_destination_identity) = expected_destination_identity else {
        after_namespace_validation();
        atomic_rename_exclusive_at(directory, source, destination)
            .map_err(|_| AtomicPublishError::NamespaceUnsafe)?;
        if verify_directory_identity(root, directory).is_err()
            || verify_entry_identity_at(directory, destination, source_identity, maximum_bytes)
                .is_err()
        {
            // Restore the original absent state only when the canonical entry is
            // still the inode this operation published. Never remove a swapped entry.
            if verify_entry_identity_at(directory, destination, source_identity, maximum_bytes)
                .is_ok()
            {
                let _ = unlink_entry_at(directory, destination);
                let _ = directory.sync_all();
            }
            return Err(AtomicPublishError::NamespaceUnsafe);
        }
        directory.sync_all().map_err(|_| AtomicPublishError::Sync)?;
        return Ok(());
    };

    let backup = format!(".{destination}.{}.rollback", uuid::Uuid::new_v4());
    if link_entry_at(directory, destination, &backup).is_err()
        || verify_entry_identity_at(
            directory,
            &backup,
            expected_destination_identity,
            maximum_bytes,
        )
        .is_err()
        || verify_entry_identity_at(
            directory,
            destination,
            expected_destination_identity,
            maximum_bytes,
        )
        .is_err()
        || verify_entry_identity_at(directory, source, source_identity, maximum_bytes).is_err()
    {
        let _ = unlink_entry_at(directory, &backup);
        return Err(AtomicPublishError::NamespaceUnsafe);
    }
    if directory.sync_all().is_err() {
        let _ = unlink_entry_at(directory, &backup);
        return Err(AtomicPublishError::Sync);
    }

    // Tests place a deterministic namespace swap here. In production there is
    // deliberately no user-space validation between this point and the exchange.
    after_namespace_validation();
    if atomic_exchange_entries_at(directory, source, destination).is_err() {
        let _ = restore_canonical_from_backup(
            root,
            directory,
            &backup,
            destination,
            expected_destination_identity,
            maximum_bytes,
        );
        return Err(AtomicPublishError::NamespaceUnsafe);
    }

    let exchange_matches = verify_directory_identity(root, directory).is_ok()
        && verify_entry_identity_at(directory, destination, source_identity, maximum_bytes).is_ok()
        && verify_entry_identity_at(
            directory,
            source,
            expected_destination_identity,
            maximum_bytes,
        )
        .is_ok()
        && verify_entry_identity_at(
            directory,
            &backup,
            expected_destination_identity,
            maximum_bytes,
        )
        .is_ok();
    if !exchange_matches {
        let _ = restore_canonical_from_backup(
            root,
            directory,
            &backup,
            destination,
            expected_destination_identity,
            maximum_bytes,
        );
        return Err(AtomicPublishError::NamespaceUnsafe);
    }

    if unlink_entry_at(directory, source).is_err() || unlink_entry_at(directory, &backup).is_err() {
        let _ = restore_canonical_from_backup(
            root,
            directory,
            &backup,
            destination,
            expected_destination_identity,
            maximum_bytes,
        );
        return Err(AtomicPublishError::NamespaceUnsafe);
    }
    directory.sync_all().map_err(|_| AtomicPublishError::Sync)?;
    verify_directory_identity(root, directory).map_err(|_| AtomicPublishError::NamespaceUnsafe)?;
    verify_entry_identity_at(directory, destination, source_identity, maximum_bytes)
        .map_err(|_| AtomicPublishError::NamespaceUnsafe)
}

#[cfg(unix)]
fn unlink_entry_at(directory: &File, name: &str) -> std::io::Result<()> {
    let name =
        CString::new(name).map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    // SAFETY: name is valid and unlinkat removes the directory entry itself.
    if unsafe { libc::unlinkat(directory.as_raw_fd(), name.as_ptr(), 0) } == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(windows)]
fn unlink_entry_at(directory: &File, name: &str) -> std::io::Result<()> {
    fs::remove_file(windows_entry_path(directory, name)?)
}

#[cfg(windows)]
fn windows_entry_path(directory: &File, name: &str) -> std::io::Result<PathBuf> {
    let mut components = Path::new(name).components();
    let is_single_normal = matches!(components.next(), Some(std::path::Component::Normal(_)))
        && components.next().is_none();
    if !is_single_normal {
        return Err(std::io::Error::from(std::io::ErrorKind::InvalidInput));
    }
    Ok(windows_file_path(directory)?.join(name))
}

#[cfg(windows)]
fn windows_file_path(file: &File) -> std::io::Result<PathBuf> {
    type Handle = *mut std::ffi::c_void;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetFinalPathNameByHandleW(
            file: Handle,
            path: *mut u16,
            path_length: u32,
            flags: u32,
        ) -> u32;
    }

    let mut path = vec![0_u16; 32_768];
    // SAFETY: the handle is borrowed from a live File and the output buffer is writable.
    let length = unsafe {
        GetFinalPathNameByHandleW(
            file.as_raw_handle().cast(),
            path.as_mut_ptr(),
            u32::try_from(path.len()).unwrap_or(u32::MAX),
            0,
        )
    };
    if length == 0 || usize::try_from(length).unwrap_or(usize::MAX) >= path.len() {
        return Err(std::io::Error::last_os_error());
    }
    path.truncate(usize::try_from(length).map_err(|_| std::io::ErrorKind::InvalidData)?);
    Ok(PathBuf::from(std::ffi::OsString::from_wide(&path)))
}

fn atomic_write(
    root: &Path,
    root_directory: &File,
    name: &str,
    bytes: &[u8],
    operation: &'static str,
) -> SupportControlResult<()> {
    atomic_write_with_hook(root, root_directory, name, bytes, operation, || {})
}

fn atomic_write_with_hook<F>(
    root: &Path,
    root_directory: &File,
    name: &str,
    bytes: &[u8],
    operation: &'static str,
    before_namespace_commit: F,
) -> SupportControlResult<()>
where
    F: FnOnce(),
{
    atomic_write_with_hooks(
        root,
        root_directory,
        name,
        bytes,
        operation,
        before_namespace_commit,
        || {},
    )
}

fn atomic_write_with_hooks<F, G>(
    root: &Path,
    root_directory: &File,
    name: &str,
    bytes: &[u8],
    operation: &'static str,
    before_namespace_commit: F,
    after_namespace_validation: G,
) -> SupportControlResult<()>
where
    F: FnOnce(),
    G: FnOnce(),
{
    verify_directory_identity(root, root_directory)
        .map_err(|_| SupportControlCommandError::new(SUPPORT_SETTINGS_UNSAFE, operation, false))?;
    let existing = entry_metadata_at(root_directory, name).map_err(|_| {
        SupportControlCommandError::new(SUPPORT_SETTINGS_UNAVAILABLE, operation, true)
    })?;
    if let Some(metadata) = existing.as_ref() {
        validate_private_regular_entry(metadata, MAX_SETTINGS_BYTES).map_err(|_| {
            SupportControlCommandError::new(SUPPORT_SETTINGS_UNSAFE, operation, false)
        })?;
    }
    let expected_identity = existing.map(|metadata| metadata.identity);
    let temporary_name = format!(".settings-v1.{}.tmp", uuid::Uuid::new_v4());
    let mut temporary = open_private_temporary(root_directory, &temporary_name).map_err(|_| {
        SupportControlCommandError::new("CODEX-SUPPORT-SETTINGS-WRITE", operation, true)
    })?;
    let temporary_identity = match private_file_metadata(&temporary, MAX_SETTINGS_BYTES) {
        Ok(metadata) => metadata.identity,
        Err(_) => {
            let _ = unlink_entry_at(root_directory, &temporary_name);
            return Err(SupportControlCommandError::new(
                SUPPORT_SETTINGS_UNSAFE,
                operation,
                false,
            ));
        }
    };
    let result = (|| {
        temporary.write_all(bytes).map_err(|_| {
            SupportControlCommandError::new("CODEX-SUPPORT-SETTINGS-WRITE", operation, true)
        })?;
        temporary.sync_all().map_err(|_| {
            SupportControlCommandError::new("CODEX-SUPPORT-SETTINGS-SYNC", operation, true)
        })?;
        before_namespace_commit();
        publish_private_entry_with_hook(
            AtomicPublishRequest {
                root,
                directory: root_directory,
                source: &temporary_name,
                destination: name,
                source_identity: temporary_identity,
                expected_destination_identity: expected_identity,
                maximum_bytes: MAX_SETTINGS_BYTES,
            },
            after_namespace_validation,
        )
        .map_err(|error| match error {
            AtomicPublishError::NamespaceUnsafe => {
                SupportControlCommandError::new(SUPPORT_SETTINGS_UNSAFE, operation, false)
            }
            AtomicPublishError::Sync => {
                SupportControlCommandError::new("CODEX-SUPPORT-SETTINGS-SYNC", operation, true)
            }
        })
    })();
    if result.is_err() {
        let _ = unlink_entry_at(root_directory, &temporary_name);
    }
    result
}

fn effective_uid() -> u32 {
    current_user_id()
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
    fn legacy_disabled_settings_migrate_once_to_required_policy() {
        let root = temporary_directory("support-settings-restart");
        let opened = SupportSettingsStore::open(&root);
        assert_eq!(opened.settings, SupportSettingsV1::default());
        let store = opened.store.expect("store");
        let legacy = SupportSettingsV1 {
            schema_version: SUPPORT_CONTROL_SCHEMA_VERSION,
            version: 2,
            global_enabled: false,
            commit_explainer_enabled: false,
        };
        store.save(&legacy, "test").expect("save legacy settings");
        assert!(SupportAuditStore::open(&root, Some(legacy.version))
            .recovery_code
            .is_none());
        let restarted = SupportSettingsStore::open(&root);
        assert_eq!(
            restarted.settings,
            SupportSettingsV1 {
                version: 2,
                ..SupportSettingsV1::default()
            }
        );
        assert!(
            SupportAuditStore::open(&root, Some(restarted.settings.version))
                .recovery_code
                .is_none()
        );
        let stable = SupportSettingsStore::open(&root);
        assert_eq!(stable.settings, restarted.settings);
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

    #[test]
    fn unsafe_settings_entries_fail_closed_without_repair_or_following_links() {
        for (label, fixture) in [
            ("dangling", "dangling"),
            ("directory", "directory"),
            ("public-mode", "public-mode"),
        ] {
            let root = temporary_directory(&format!("support-settings-{label}"));
            let support = root.join(SUPPORT_DIRECTORY);
            fs::create_dir_all(&support).expect("support fixture");
            fs::set_permissions(&support, fs::Permissions::from_mode(0o700)).expect("support mode");
            let path = support.join(SETTINGS_FILE);
            match fixture {
                "dangling" => {
                    symlink(root.join("missing-target"), &path).expect("dangling symlink")
                }
                "directory" => fs::create_dir(&path).expect("directory entry"),
                "public-mode" => {
                    fs::write(&path, b"sentinel").expect("public file");
                    fs::set_permissions(&path, fs::Permissions::from_mode(0o644))
                        .expect("public mode");
                }
                _ => unreachable!(),
            }

            let opened = SupportSettingsStore::open(&root);
            assert!(opened.store.is_none(), "fixture {fixture}");
            assert_eq!(
                opened.recovery_code.as_deref(),
                Some(SUPPORT_SETTINGS_UNSAFE),
                "fixture {fixture}"
            );
            let metadata = fs::symlink_metadata(&path).expect("entry remains");
            match fixture {
                "dangling" => assert!(metadata.file_type().is_symlink()),
                "directory" => assert!(metadata.is_dir()),
                "public-mode" => {
                    assert_eq!(metadata.permissions().mode() & 0o777, 0o644);
                    assert_eq!(fs::read(&path).expect("sentinel"), b"sentinel");
                }
                _ => unreachable!(),
            }
            fs::remove_dir_all(root).expect("cleanup");
        }

        let owner_mismatch = PrivateEntryMetadata {
            identity: FileIdentity {
                device: 1,
                inode: 1,
            },
            mode: libc::S_IFREG as u32 | 0o600,
            uid: effective_uid().wrapping_add(1),
            size: 1,
        };
        assert_eq!(
            validate_private_regular_entry(&owner_mismatch, MAX_SETTINGS_BYTES),
            Err(SUPPORT_SETTINGS_UNSAFE)
        );
    }

    #[test]
    fn settings_namespace_swap_is_rejected_without_writing_public_target() {
        let root = temporary_directory("support-settings-swap");
        let store = SupportSettingsStore::open(&root).store.expect("store");
        let original = fs::read(&store.path).expect("original settings");
        let backup = store.root.join("settings-backup.json");
        let public_target = root.join("public-target.txt");
        fs::write(&public_target, b"public-sentinel").expect("public target");
        fs::set_permissions(&public_target, fs::Permissions::from_mode(0o600))
            .expect("public target mode");
        let next = SupportSettingsV1 {
            version: 2,
            global_enabled: false,
            ..SupportSettingsV1::default()
        };
        let bytes = serde_json::to_vec_pretty(&next).expect("settings payload");

        let error = atomic_write_with_hook(
            &store.root,
            &store.root_directory,
            SETTINGS_FILE,
            &bytes,
            "test",
            || {
                fs::rename(&store.path, &backup).expect("pin original entry");
                symlink(&public_target, &store.path).expect("swap target to symlink");
            },
        )
        .expect_err("namespace swap must fail");
        assert_eq!(error.code, SUPPORT_SETTINGS_UNSAFE);
        assert_eq!(
            fs::read(&public_target).expect("public sentinel"),
            b"public-sentinel"
        );
        assert!(fs::symlink_metadata(&store.path)
            .expect("swapped entry")
            .file_type()
            .is_symlink());
        fs::remove_file(&store.path).expect("remove swapped link");
        fs::rename(&backup, &store.path).expect("restore original");
        assert_eq!(fs::read(&store.path).expect("restored settings"), original);
        assert!(fs::read_dir(&store.root)
            .expect("support entries")
            .all(|entry| !entry
                .expect("entry")
                .file_name()
                .to_string_lossy()
                .ends_with(".tmp")));
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn settings_swap_after_final_validation_rolls_back_original_inode() {
        let root = temporary_directory("support-settings-post-validation-swap");
        let store = SupportSettingsStore::open(&root).store.expect("store");
        let original = fs::read(&store.path).expect("original settings");
        let original_identity =
            file_identity(&fs::symlink_metadata(&store.path).expect("original settings metadata"));
        let attacker_backup = store.root.join("attacker-settings-backup.json");
        let public_target = root.join("public-settings-target.txt");
        fs::write(&public_target, b"public-settings-sentinel").expect("public target");
        let next = SupportSettingsV1 {
            version: 2,
            global_enabled: false,
            ..SupportSettingsV1::default()
        };
        let bytes = serde_json::to_vec_pretty(&next).expect("settings payload");

        let error = atomic_write_with_hooks(
            &store.root,
            &store.root_directory,
            SETTINGS_FILE,
            &bytes,
            "test",
            || {},
            || {
                fs::rename(&store.path, &attacker_backup).expect("move validated canonical");
                symlink(&public_target, &store.path).expect("insert post-validation symlink");
            },
        )
        .expect_err("post-validation swap must fail closed");

        assert_eq!(error.code, SUPPORT_SETTINGS_UNSAFE);
        let canonical = fs::symlink_metadata(&store.path).expect("rolled-back canonical");
        assert!(canonical.is_file());
        assert_eq!(file_identity(&canonical), original_identity);
        assert_eq!(fs::read(&store.path).expect("rolled-back bytes"), original);
        assert_eq!(
            fs::read(&public_target).expect("public sentinel"),
            b"public-settings-sentinel"
        );
        assert!(fs::read_dir(&store.root)
            .expect("support entries")
            .all(|entry| {
                let name = entry.expect("entry").file_name();
                let name = name.to_string_lossy();
                !name.ends_with(".tmp") && !name.ends_with(".rollback")
            }));
        fs::remove_file(attacker_backup).expect("remove attacker backup");
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

        fs::set_permissions(&store.path, fs::Permissions::from_mode(0o644))
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
            0o644
        );
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn audit_parent_and_entry_symlinks_fail_closed_without_following_targets() {
        let unsafe_parent_root = temporary_directory("support-audit-unsafe-parent");
        let unsafe_support = unsafe_parent_root.join(SUPPORT_DIRECTORY);
        fs::create_dir_all(&unsafe_support).expect("unsafe parent");
        fs::set_permissions(&unsafe_support, fs::Permissions::from_mode(0o755))
            .expect("unsafe parent mode");
        let unsafe_parent = SupportAuditStore::open(&unsafe_parent_root, Some(1));
        assert!(unsafe_parent.store.is_none());
        assert_eq!(
            unsafe_parent.recovery_code.as_deref(),
            Some(SUPPORT_AUDIT_UNSAFE)
        );

        let root = temporary_directory("support-audit-symlink-entry");
        let store = SupportAuditStore::open(&root, Some(1))
            .store
            .expect("store");
        let backup = store.root.join("audit-backup.sqlite3");
        let public_target = root.join("public-audit-target.txt");
        fs::write(&public_target, b"public-audit-sentinel").expect("public target");
        fs::rename(&store.path, &backup).expect("backup audit");
        symlink(&public_target, &store.path).expect("audit symlink");

        let opened = SupportAuditStore::open(&root, Some(1));
        assert!(opened.store.is_none());
        assert_eq!(opened.recovery_code.as_deref(), Some(SUPPORT_AUDIT_UNSAFE));
        assert_eq!(
            fs::read(&public_target).expect("public sentinel"),
            b"public-audit-sentinel"
        );
        fs::remove_file(&store.path).expect("remove symlink");
        fs::rename(&backup, &store.path).expect("restore audit");
        fs::remove_dir_all(unsafe_parent_root).expect("unsafe parent cleanup");
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn audit_namespace_swap_is_rejected_without_writing_public_target() {
        let root = temporary_directory("support-audit-swap");
        let store = SupportAuditStore::open(&root, Some(1))
            .store
            .expect("store");
        let next = populated_audit(1, 3);
        let payload = serde_json::to_string(&next).expect("audit payload");
        let backup = store.root.join("audit-swap-backup.sqlite3");
        let public_target = root.join("public-audit-target.txt");
        fs::write(&public_target, b"public-audit-sentinel").expect("public target");

        let error = store
            .replace_database_with_hook(&payload, "test", || {
                fs::rename(&store.path, &backup).expect("pin original entry");
                symlink(&public_target, &store.path).expect("swap audit target");
            })
            .expect_err("namespace swap must fail");
        assert_eq!(error.code, SUPPORT_AUDIT_UNSAFE);
        assert_eq!(
            fs::read(&public_target).expect("public sentinel"),
            b"public-audit-sentinel"
        );
        fs::remove_file(&store.path).expect("remove swapped link");
        fs::rename(&backup, &store.path).expect("restore original");
        assert!(fs::read_dir(&store.root)
            .expect("support entries")
            .all(|entry| !entry
                .expect("entry")
                .file_name()
                .to_string_lossy()
                .ends_with(".tmp")));
        assert!(SupportAuditStore::open(&root, Some(1))
            .recovery_code
            .is_none());
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn audit_swap_after_final_validation_rolls_back_original_inode() {
        let root = temporary_directory("support-audit-post-validation-swap");
        let opened = SupportAuditStore::open(&root, Some(1));
        let original_state = opened.state.clone();
        let store = opened.store.expect("store");
        let original = fs::read(&store.path).expect("original audit database");
        let original_identity =
            file_identity(&fs::symlink_metadata(&store.path).expect("original audit metadata"));
        let attacker_backup = store.root.join("attacker-audit-backup.sqlite3");
        let public_target = root.join("public-audit-target.txt");
        fs::write(&public_target, b"public-audit-sentinel").expect("public target");
        let payload = serde_json::to_string(&populated_audit(1, 7)).expect("next audit payload");

        let error = store
            .replace_database_with_hooks(
                &payload,
                "test",
                || {},
                || {
                    fs::rename(&store.path, &attacker_backup).expect("move validated canonical");
                    symlink(&public_target, &store.path).expect("insert post-validation symlink");
                },
            )
            .expect_err("post-validation swap must fail closed");

        assert_eq!(error.code, SUPPORT_AUDIT_UNSAFE);
        let canonical = fs::symlink_metadata(&store.path).expect("rolled-back canonical");
        assert!(canonical.is_file());
        assert_eq!(file_identity(&canonical), original_identity);
        assert_eq!(
            fs::read(&store.path).expect("rolled-back database"),
            original
        );
        assert_eq!(
            fs::read(&public_target).expect("public sentinel"),
            b"public-audit-sentinel"
        );
        assert!(fs::read_dir(&store.root)
            .expect("support entries")
            .all(|entry| {
                let name = entry.expect("entry").file_name();
                let name = name.to_string_lossy();
                !name.ends_with(".tmp") && !name.ends_with(".rollback")
            }));
        let reopened = SupportAuditStore::open(&root, Some(1));
        assert!(reopened.recovery_code.is_none());
        assert_eq!(reopened.state, original_state);
        fs::remove_file(attacker_backup).expect("remove attacker backup");
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
