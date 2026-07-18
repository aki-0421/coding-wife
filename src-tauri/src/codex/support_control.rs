//! Native support policy persistence and the safe Settings/diagnostics contract.
//!
//! Only desired booleans and bounded audit metadata cross this boundary. Support
//! prompts, responses, paths, credentials, and transcripts are deliberately absent.

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::support::SUPPORT_PERMISSION_PROFILE;
use super::types::CODEX_MODEL;

pub const SUPPORT_CONTROL_SCHEMA_VERSION: u16 = 1;
pub const SUPPORT_MAX_QUEUE_CAPACITY: usize = 10;
pub const SUPPORT_TOKEN_BUDGET: u64 = 16_000;
pub const SUPPORT_TASK_TIMEOUT_MS: u64 = 15_000;

const SUPPORT_DIRECTORY: &str = "support";
const SETTINGS_FILE: &str = "settings-v1.json";
const MAX_SETTINGS_BYTES: u64 = 16 * 1024;
const MAX_SAFE_SETTINGS_VERSION: u64 = 9_007_199_254_740_991;

pub(crate) const SUPPORT_SETTINGS_CORRUPT: &str = "CODEX-SUPPORT-SETTINGS-CORRUPT";
pub(crate) const SUPPORT_SETTINGS_UNKNOWN_VERSION: &str = "CODEX-SUPPORT-SETTINGS-UNKNOWN-VERSION";
pub(crate) const SUPPORT_SETTINGS_UNSAFE: &str = "CODEX-SUPPORT-SETTINGS-UNSAFE";
pub(crate) const SUPPORT_SETTINGS_UNAVAILABLE: &str = "CODEX-SUPPORT-SETTINGS-UNAVAILABLE";

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
    pub latest_outcome: Option<SupportLatestOutcomeV1>,
}

impl SupportAuditV1 {
    pub(crate) fn new(latest_outcome: Option<SupportLatestOutcomeV1>) -> Self {
        Self {
            role: "commit_explainer".to_owned(),
            model_family: CODEX_MODEL.to_owned(),
            reasoning_effort: "low".to_owned(),
            permission_profile: SUPPORT_PERMISSION_PROFILE.to_owned(),
            raw_transcript_persisted: false,
            task_timeout_ms: SUPPORT_TASK_TIMEOUT_MS,
            token_budget: SUPPORT_TOKEN_BUDGET,
            latest_outcome,
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

fn ensure_private_directory(path: &Path) -> Result<(), &'static str> {
    fs::create_dir_all(path).map_err(|_| SUPPORT_SETTINGS_UNAVAILABLE)?;
    let metadata = fs::symlink_metadata(path).map_err(|_| SUPPORT_SETTINGS_UNAVAILABLE)?;
    if !metadata.file_type().is_dir() || metadata.uid() != effective_uid() {
        return Err(SUPPORT_SETTINGS_UNSAFE);
    }
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .map_err(|_| SUPPORT_SETTINGS_UNAVAILABLE)?;
    sync_directory(path.parent().unwrap_or(path), "support_settings_startup")
        .map_err(|_| SUPPORT_SETTINGS_UNAVAILABLE)
}

fn verify_settings_file(path: &Path) -> Result<(), &'static str> {
    let metadata = fs::symlink_metadata(path).map_err(|_| SUPPORT_SETTINGS_UNAVAILABLE)?;
    if !metadata.file_type().is_file()
        || metadata.uid() != effective_uid()
        || metadata.mode() & 0o077 != 0
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
    use std::os::unix::fs::PermissionsExt;

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
}
