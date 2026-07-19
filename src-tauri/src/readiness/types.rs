use serde::{Deserialize, Serialize};

pub const NATIVE_READINESS_SCHEMA_VERSION: u16 = 1;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReadinessSource {
    Native,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReadinessCheckId {
    OsApp,
    Codex,
    Git,
    History,
    Live2d,
    Preferences,
}

impl ReadinessCheckId {
    pub(crate) fn as_wire(self) -> &'static str {
        match self {
            Self::OsApp => "os_app",
            Self::Codex => "codex",
            Self::Git => "git",
            Self::History => "history",
            Self::Live2d => "live2d",
            Self::Preferences => "preferences",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReadinessStatus {
    Ready,
    Warning,
    Blocked,
    Unavailable,
}

impl ReadinessStatus {
    pub(crate) fn as_wire(self) -> &'static str {
        match self {
            Self::Ready => "ready",
            Self::Warning => "warning",
            Self::Blocked => "blocked",
            Self::Unavailable => "unavailable",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReadinessRecoveryAction {
    None,
    Recheck,
    InstallCodex,
    AuthenticateCodex,
    UpdateCodex,
    SelectWorkspace,
    RepairWorkspace,
    RepairHistory,
    RestoreLive2d,
    SavePreferences,
    ResetPreferences,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReadinessFactKey {
    Platform,
    Architecture,
    OsVersion,
    AppVersion,
    BuildProfile,
    ReadinessSchema,
    CodexBinary,
    CodexModel,
    CodexAuth,
    CodexSchema,
    CodexEfforts,
    GitExecutable,
    RepositoryHealth,
    RepositoryIdentity,
    RepositoryHead,
    RepositoryBranch,
    HistorySchema,
    HistoryMode,
    HistoryIntegrity,
    HistoryWritability,
    HistoryWriter,
    HistoryMigration,
    HistoryBackup,
    Live2dCore,
    BuiltinResources,
    CharacterLibrary,
    CharacterSchema,
    PreferencesSchema,
}

impl ReadinessFactKey {
    pub(crate) fn as_wire(self) -> &'static str {
        match self {
            Self::Platform => "platform",
            Self::Architecture => "architecture",
            Self::OsVersion => "os_version",
            Self::AppVersion => "app_version",
            Self::BuildProfile => "build_profile",
            Self::ReadinessSchema => "readiness_schema",
            Self::CodexBinary => "codex_binary",
            Self::CodexModel => "codex_model",
            Self::CodexAuth => "codex_auth",
            Self::CodexSchema => "codex_schema",
            Self::CodexEfforts => "codex_efforts",
            Self::GitExecutable => "git_executable",
            Self::RepositoryHealth => "repository_health",
            Self::RepositoryIdentity => "repository_identity",
            Self::RepositoryHead => "repository_head",
            Self::RepositoryBranch => "repository_branch",
            Self::HistorySchema => "history_schema",
            Self::HistoryMode => "history_mode",
            Self::HistoryIntegrity => "history_integrity",
            Self::HistoryWritability => "history_writability",
            Self::HistoryWriter => "history_writer",
            Self::HistoryMigration => "history_migration",
            Self::HistoryBackup => "history_backup",
            Self::Live2dCore => "live2d_core",
            Self::BuiltinResources => "builtin_resources",
            Self::CharacterLibrary => "character_library",
            Self::CharacterSchema => "character_schema",
            Self::PreferencesSchema => "preferences_schema",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ReadinessFactV1 {
    pub key: ReadinessFactKey,
    pub value: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ReadinessCheckV1 {
    pub id: ReadinessCheckId,
    pub status: ReadinessStatus,
    pub checked_at: String,
    pub code: String,
    pub recoverable: bool,
    pub recovery_action: ReadinessRecoveryAction,
    pub facts: Vec<ReadinessFactV1>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct NativeReadinessSnapshotV1 {
    pub schema_version: u16,
    pub snapshot_id: String,
    pub checked_at: String,
    pub source: ReadinessSource,
    pub checks: Vec<ReadinessCheckV1>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RunDiagnosticCheckRequestV1 {
    pub schema_version: u16,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CopySanitizedDiagnosticsRequestV1 {
    pub schema_version: u16,
    pub snapshot_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SanitizedDiagnosticsSummaryV1 {
    pub schema_version: u16,
    pub snapshot_id: String,
    pub summary: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ReadinessCommandError {
    pub code: String,
    pub operation: String,
    pub recoverable: bool,
    pub user_message_key: String,
    pub detail_ref: String,
}

impl ReadinessCommandError {
    pub(crate) fn new(code: &'static str, operation: &'static str, recoverable: bool) -> Self {
        Self {
            code: code.to_owned(),
            operation: operation.to_owned(),
            recoverable,
            user_message_key: "readiness.error.generic".to_owned(),
            detail_ref: "native-readiness-v1".to_owned(),
        }
    }
}
