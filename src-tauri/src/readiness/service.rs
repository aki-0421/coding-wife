use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::time::Duration;

use chrono::{SecondsFormat, Utc};
use tokio::process::Command;
use tokio::sync::Mutex;

use crate::character::CharacterService;
use crate::codex::binary::{discover_binary, BinaryError};
use crate::codex::process::run_bounded_command;
use crate::codex::supervisor::CodexSupervisor;
use crate::codex::types::{CodexConnectRequest, CodexDiagnostic, CodexHealth, CODEX_MODEL};
use crate::codex::workspace::AppPrivateBinaryRecord;
use crate::git_review::runner::GitRunner;
use crate::preferences::AppPreferencesService;
use crate::workspace_history::service::{
    HistoryReadinessProbe, RepositoryReadinessProbe, RepositoryReadinessState,
};
use crate::workspace_history::types::{HistoryMode, WORKSPACE_HISTORY_SCHEMA_VERSION};
use crate::workspace_history::WorkspaceHistoryService;

use super::types::{
    CopySanitizedDiagnosticsRequestV1, NativeReadinessSnapshotV1, ReadinessCheckId,
    ReadinessCheckV1, ReadinessCommandError, ReadinessFactKey, ReadinessFactV1,
    ReadinessRecoveryAction, ReadinessSource, ReadinessStatus, SanitizedDiagnosticsSummaryV1,
    NATIVE_READINESS_SCHEMA_VERSION,
};

const CHECK_COUNT: usize = 6;

#[derive(Clone)]
pub struct NativeReadinessService {
    codex: CodexSupervisor,
    history: WorkspaceHistoryService,
    character: CharacterService,
    preferences: AppPreferencesService,
    latest: Arc<RwLock<Option<NativeReadinessSnapshotV1>>>,
    operation: Arc<Mutex<()>>,
}

impl NativeReadinessService {
    pub fn new(
        codex: CodexSupervisor,
        history: WorkspaceHistoryService,
        character: CharacterService,
        preferences: AppPreferencesService,
    ) -> Self {
        Self {
            codex,
            history,
            character,
            preferences,
            latest: Arc::new(RwLock::new(None)),
            operation: Arc::new(Mutex::new(())),
        }
    }

    pub async fn run(&self) -> NativeReadinessSnapshotV1 {
        let _operation = self.operation.lock().await;
        self.run_unlocked().await
    }

    pub async fn configure_codex_binary(
        &self,
        path: Option<String>,
    ) -> Result<NativeReadinessSnapshotV1, ReadinessCommandError> {
        let _operation = self.operation.lock().await;
        let record = match path {
            Some(path) => {
                let candidate = validate_configured_codex_path(&path)?;
                let binary = discover_binary(Some(&candidate))
                    .await
                    .map_err(configure_binary_error)?;
                let diagnostic = self
                    .codex
                    .setup_probe_with_verified_binary(binary.clone())
                    .await;
                if diagnostic.health != CodexHealth::Ready {
                    return Err(configure_setup_error(&diagnostic));
                }
                if binary.canonical_path.to_str().is_none() {
                    return Err(ReadinessCommandError::new(
                        "READINESS-CODEX-PATH-ENCODING",
                        "configure_codex_binary",
                        false,
                    ));
                }
                Some((
                    AppPrivateBinaryRecord {
                        canonical_path: binary.canonical_path,
                    },
                    diagnostic,
                ))
            }
            None => None,
        };
        self.history
            .save_private_binary_record(record.as_ref().map(|(record, _)| record))
            .map_err(|_| {
                ReadinessCommandError::new(
                    "READINESS-CODEX-PATH-SAVE-FAILED",
                    "configure_codex_binary",
                    true,
                )
            })?;
        self.codex
            .set_explicit_binary(
                record
                    .as_ref()
                    .map(|(record, _)| record.canonical_path.clone()),
            )
            .await;
        match record {
            Some((_, diagnostic)) => Ok(self.snapshot_with_codex(diagnostic, true).await),
            None => Ok(self.run_unlocked().await),
        }
    }

    async fn run_unlocked(&self) -> NativeReadinessSnapshotV1 {
        // Startup restoration registers the trusted workspace roots used by
        // the Codex setup probe. Do not publish a fallback-cwd failure that
        // would remain stale after those roots become available.
        self.history.wait_for_startup_restore().await;
        let active_workspace_id = self
            .history
            .list()
            .ok()
            .and_then(|snapshot| snapshot.active_workspace_id);
        let codex = async {
            match active_workspace_id {
                Some(workspace_id) => match self
                    .codex
                    .connect(CodexConnectRequest { workspace_id })
                    .await
                {
                    Ok(diagnostic) => diagnostic,
                    Err(_) => self.codex.diagnostic().await,
                },
                None => self.codex.setup_probe().await,
            }
        };
        let (os_version, codex, explicit_binary, repository, history) = tokio::join!(
            read_macos_version(),
            codex,
            self.codex.explicit_binary_configured(),
            self.history.repository_readiness(),
            self.history.history_readiness(),
        );
        self.store_snapshot(os_version, codex, explicit_binary, repository, history)
    }

    async fn snapshot_with_codex(
        &self,
        codex: CodexDiagnostic,
        explicit_binary: bool,
    ) -> NativeReadinessSnapshotV1 {
        let (os_version, repository, history) = tokio::join!(
            read_macos_version(),
            self.history.repository_readiness(),
            self.history.history_readiness(),
        );
        self.store_snapshot(os_version, codex, explicit_binary, repository, history)
    }

    fn store_snapshot(
        &self,
        os_version: Option<String>,
        codex: CodexDiagnostic,
        explicit_binary: bool,
        repository: RepositoryReadinessProbe,
        history: HistoryReadinessProbe,
    ) -> NativeReadinessSnapshotV1 {
        let checked_at = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        let checks = vec![
            os_app_check(&checked_at, os_version),
            codex_check(&checked_at, &codex, explicit_binary),
            git_check(&checked_at, repository),
            history_check(&checked_at, history),
            live2d_check(&checked_at, &self.character),
            preferences_check(&checked_at, &self.preferences),
        ];
        debug_assert_eq!(checks.len(), CHECK_COUNT);
        let snapshot = NativeReadinessSnapshotV1 {
            schema_version: NATIVE_READINESS_SCHEMA_VERSION,
            snapshot_id: uuid::Uuid::new_v4().to_string(),
            checked_at,
            source: ReadinessSource::Native,
            checks,
        };
        if let Ok(mut latest) = self.latest.write() {
            *latest = Some(snapshot.clone());
        }
        snapshot
    }

    pub fn sanitized_summary(
        &self,
        request: CopySanitizedDiagnosticsRequestV1,
    ) -> Result<SanitizedDiagnosticsSummaryV1, ReadinessCommandError> {
        if request.schema_version != NATIVE_READINESS_SCHEMA_VERSION {
            return Err(ReadinessCommandError::new(
                "READINESS-SCHEMA-UNSUPPORTED",
                "copy_sanitized_diagnostics",
                false,
            ));
        }
        let latest = self.latest.read().map_err(|_| {
            ReadinessCommandError::new(
                "READINESS-SNAPSHOT-UNAVAILABLE",
                "copy_sanitized_diagnostics",
                true,
            )
        })?;
        let snapshot = latest.as_ref().filter(|snapshot| {
            snapshot.snapshot_id == request.snapshot_id
                && snapshot.schema_version == request.schema_version
        });
        let snapshot = snapshot.ok_or_else(|| {
            ReadinessCommandError::new(
                "READINESS-SNAPSHOT-STALE",
                "copy_sanitized_diagnostics",
                true,
            )
        })?;
        Ok(SanitizedDiagnosticsSummaryV1 {
            schema_version: NATIVE_READINESS_SCHEMA_VERSION,
            snapshot_id: snapshot.snapshot_id.clone(),
            summary: build_sanitized_summary(snapshot),
        })
    }
}

fn validate_configured_codex_path(value: &str) -> Result<PathBuf, ReadinessCommandError> {
    if value.is_empty()
        || value.len() > 4_096
        || value.trim() != value
        || value.chars().any(char::is_control)
    {
        return Err(ReadinessCommandError::new(
            "READINESS-CODEX-PATH-INVALID",
            "configure_codex_binary",
            false,
        ));
    }
    let path = Path::new(value);
    if !path.is_absolute() {
        return Err(ReadinessCommandError::new(
            "READINESS-CODEX-PATH-NOT-ABSOLUTE",
            "configure_codex_binary",
            false,
        ));
    }
    Ok(path.to_path_buf())
}

fn configure_binary_error(error: BinaryError) -> ReadinessCommandError {
    let (code, recoverable) = match error {
        BinaryError::Missing => ("READINESS-CODEX-PATH-MISSING", true),
        BinaryError::Untrusted => ("READINESS-CODEX-PATH-UNTRUSTED", false),
        BinaryError::Timeout => ("READINESS-CODEX-PATH-TIMEOUT", true),
        BinaryError::ProbeFailed => ("READINESS-CODEX-PATH-PROBE-FAILED", true),
        BinaryError::SchemaUnsupported => ("READINESS-CODEX-PATH-SCHEMA-UNSUPPORTED", true),
        BinaryError::Io => ("READINESS-CODEX-PATH-IO", true),
    };
    ReadinessCommandError::new(code, "configure_codex_binary", recoverable)
}

fn configure_setup_error(diagnostic: &CodexDiagnostic) -> ReadinessCommandError {
    let code = match diagnostic.error_code.as_deref() {
        Some("CODEX-BINARY-MISSING") => "READINESS-CODEX-PATH-MISSING",
        Some("CODEX-BINARY-UNTRUSTED" | "CODEX-BINARY-IDENTITY-CHANGED") => {
            "READINESS-CODEX-PATH-UNTRUSTED"
        }
        Some("CODEX-SETUP-TIMEOUT" | "CODEX-SETUP-INITIALIZE-TIMEOUT") => {
            "READINESS-CODEX-PATH-TIMEOUT"
        }
        Some("CODEX-SETUP-SPAWN-FAILED" | "CODEX-SETUP-CONNECTION-LOST") => {
            "READINESS-CODEX-PATH-APP-SERVER-FAILED"
        }
        Some("CODEX-SETUP-PROTOCOL-MISMATCH") => "READINESS-CODEX-PATH-APP-SERVER-INCOMPATIBLE",
        _ => "READINESS-CODEX-PATH-PROBE-FAILED",
    };
    ReadinessCommandError::new(code, "configure_codex_binary", diagnostic.recoverable)
}

fn fact(key: ReadinessFactKey, value: impl Into<String>) -> ReadinessFactV1 {
    ReadinessFactV1 {
        key,
        value: value.into(),
    }
}

fn check(
    id: ReadinessCheckId,
    status: ReadinessStatus,
    checked_at: &str,
    code: &'static str,
    recoverable: bool,
    recovery_action: ReadinessRecoveryAction,
    facts: Vec<ReadinessFactV1>,
) -> ReadinessCheckV1 {
    ReadinessCheckV1 {
        id,
        status,
        checked_at: checked_at.to_owned(),
        code: code.to_owned(),
        recoverable,
        recovery_action,
        facts,
    }
}

async fn read_macos_version() -> Option<String> {
    if std::env::consts::OS != "macos" {
        return None;
    }
    let mut command = Command::new("/usr/bin/sw_vers");
    command.arg("-productVersion").env_clear();
    let output = run_bounded_command(command, Duration::from_secs(2), 64, 64)
        .await
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let version = std::str::from_utf8(&output.stdout).ok()?.trim();
    let valid = !version.is_empty()
        && version.len() <= 24
        && version
            .split('.')
            .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()));
    valid.then(|| version.to_owned())
}

fn os_app_check(checked_at: &str, os_version: Option<String>) -> ReadinessCheckV1 {
    os_app_check_for(
        checked_at,
        std::env::consts::OS,
        std::env::consts::ARCH,
        os_version,
    )
}

fn os_app_check_for(
    checked_at: &str,
    platform: &str,
    architecture: &str,
    os_version: Option<String>,
) -> ReadinessCheckV1 {
    let mut facts = vec![
        fact(ReadinessFactKey::Platform, platform),
        fact(ReadinessFactKey::Architecture, architecture),
        fact(ReadinessFactKey::AppVersion, env!("CARGO_PKG_VERSION")),
        fact(
            ReadinessFactKey::BuildProfile,
            if cfg!(debug_assertions) {
                "debug"
            } else {
                "release"
            },
        ),
        fact(
            ReadinessFactKey::ReadinessSchema,
            NATIVE_READINESS_SCHEMA_VERSION.to_string(),
        ),
    ];
    facts.push(fact(
        ReadinessFactKey::OsVersion,
        os_version
            .clone()
            .unwrap_or_else(|| "unavailable".to_owned()),
    ));
    if platform != "macos" || architecture != "aarch64" {
        return check(
            ReadinessCheckId::OsApp,
            ReadinessStatus::Blocked,
            checked_at,
            "READINESS-OS-UNSUPPORTED",
            false,
            ReadinessRecoveryAction::None,
            facts,
        );
    }
    let Some(major) = os_version.as_deref().and_then(macos_major) else {
        return check(
            ReadinessCheckId::OsApp,
            ReadinessStatus::Unavailable,
            checked_at,
            "READINESS-OS-VERSION-UNAVAILABLE",
            true,
            ReadinessRecoveryAction::Recheck,
            facts,
        );
    };
    if major < 14 {
        return check(
            ReadinessCheckId::OsApp,
            ReadinessStatus::Blocked,
            checked_at,
            "READINESS-OS-VERSION-UNSUPPORTED",
            false,
            ReadinessRecoveryAction::None,
            facts,
        );
    }
    check(
        ReadinessCheckId::OsApp,
        ReadinessStatus::Ready,
        checked_at,
        "READINESS-OS-READY",
        false,
        ReadinessRecoveryAction::None,
        facts,
    )
}

fn macos_major(value: &str) -> Option<u64> {
    if value.is_empty()
        || value.len() > 24
        || !value
            .split('.')
            .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
    {
        return None;
    }
    value.split('.').next()?.parse().ok()
}

fn codex_check(
    checked_at: &str,
    diagnostic: &CodexDiagnostic,
    explicit_binary: bool,
) -> ReadinessCheckV1 {
    let setup_probe = diagnostic.operation == "codex.setup";
    let auth = if setup_probe {
        "unverified"
    } else if diagnostic.account_present {
        "authenticated"
    } else if diagnostic.requires_openai_auth || diagnostic.health == CodexHealth::AuthRequired {
        "required"
    } else {
        "unverified"
    };
    let binary = match diagnostic.health {
        CodexHealth::BinaryMissing => "missing",
        CodexHealth::BinaryUntrusted => "untrusted",
        _ if diagnostic.binary_hash_prefix.is_some() => "trusted",
        _ => "unavailable",
    };
    let schema = if setup_probe {
        "unverified"
    } else if matches!(
        diagnostic.health,
        CodexHealth::SchemaUnsupported | CodexHealth::ProtocolMismatch
    ) {
        "incompatible"
    } else if diagnostic.generated_by_same_binary {
        "compatible"
    } else {
        "unverified"
    };
    let facts = vec![
        fact(ReadinessFactKey::CodexBinary, binary),
        fact(
            ReadinessFactKey::CodexBinarySource,
            if explicit_binary {
                "explicit"
            } else {
                "automatic"
            },
        ),
        fact(ReadinessFactKey::CodexModel, CODEX_MODEL),
        fact(ReadinessFactKey::CodexAuth, auth),
        fact(ReadinessFactKey::CodexSchema, schema),
        fact(
            ReadinessFactKey::CodexEfforts,
            if setup_probe {
                "unverified"
            } else if !diagnostic.supported_reasoning_efforts.is_empty() {
                "available"
            } else {
                "unavailable"
            },
        ),
    ];
    let (status, code, recoverable, action) = match diagnostic.health {
        CodexHealth::Ready if setup_probe && binary == "trusted" => (
            ReadinessStatus::Ready,
            "READINESS-CODEX-READY",
            false,
            ReadinessRecoveryAction::None,
        ),
        CodexHealth::Ready
            if diagnostic.account_present
                && diagnostic.model_available
                && !diagnostic.supported_reasoning_efforts.is_empty()
                && schema == "compatible" =>
        {
            (
                ReadinessStatus::Ready,
                "READINESS-CODEX-READY",
                false,
                ReadinessRecoveryAction::None,
            )
        }
        CodexHealth::BinaryMissing => (
            ReadinessStatus::Unavailable,
            "READINESS-CODEX-BINARY-MISSING",
            true,
            ReadinessRecoveryAction::InstallCodex,
        ),
        CodexHealth::AuthRequired => (
            ReadinessStatus::Blocked,
            "READINESS-CODEX-AUTH-REQUIRED",
            true,
            ReadinessRecoveryAction::AuthenticateCodex,
        ),
        CodexHealth::ModelUnavailable => (
            ReadinessStatus::Blocked,
            "READINESS-CODEX-MODEL-UNAVAILABLE",
            true,
            ReadinessRecoveryAction::UpdateCodex,
        ),
        CodexHealth::EffortUnavailable => (
            ReadinessStatus::Blocked,
            "READINESS-CODEX-EFFORT-UNAVAILABLE",
            true,
            ReadinessRecoveryAction::UpdateCodex,
        ),
        CodexHealth::SchemaUnsupported | CodexHealth::ProtocolMismatch => (
            ReadinessStatus::Blocked,
            "READINESS-CODEX-SCHEMA-INCOMPATIBLE",
            true,
            ReadinessRecoveryAction::UpdateCodex,
        ),
        CodexHealth::BinaryUntrusted => (
            ReadinessStatus::Blocked,
            "READINESS-CODEX-BINARY-UNTRUSTED",
            true,
            ReadinessRecoveryAction::InstallCodex,
        ),
        CodexHealth::Initializing => (
            ReadinessStatus::Warning,
            "READINESS-CODEX-INITIALIZING",
            true,
            ReadinessRecoveryAction::Recheck,
        ),
        CodexHealth::Disconnected | CodexHealth::Ready => (
            ReadinessStatus::Unavailable,
            "READINESS-CODEX-DISCONNECTED",
            true,
            ReadinessRecoveryAction::Recheck,
        ),
    };
    check(
        ReadinessCheckId::Codex,
        status,
        checked_at,
        code,
        recoverable,
        action,
        facts,
    )
}

fn repository_state_wire(state: RepositoryReadinessState) -> &'static str {
    match state {
        RepositoryReadinessState::Ready => "ready",
        RepositoryReadinessState::NotSelected => "not_selected",
        RepositoryReadinessState::Missing => "missing",
        RepositoryReadinessState::Moved => "moved",
        RepositoryReadinessState::Changed => "changed",
        RepositoryReadinessState::Unreadable => "unreadable",
        RepositoryReadinessState::ReadOnly => "read_only",
        RepositoryReadinessState::StaleBranch => "stale_branch",
        RepositoryReadinessState::Unavailable => "unavailable",
    }
}

fn git_check(checked_at: &str, probe: RepositoryReadinessProbe) -> ReadinessCheckV1 {
    let binary_available = GitRunner::production().is_ok();
    let facts = vec![
        fact(
            ReadinessFactKey::GitExecutable,
            if binary_available {
                "available"
            } else {
                "missing"
            },
        ),
        fact(
            ReadinessFactKey::RepositoryHealth,
            repository_state_wire(probe.state),
        ),
        fact(
            ReadinessFactKey::RepositoryIdentity,
            if probe.identity_matches {
                "matching"
            } else {
                "unverified"
            },
        ),
        fact(
            ReadinessFactKey::RepositoryHead,
            if probe.head_matches {
                "current"
            } else {
                "stale"
            },
        ),
        fact(
            ReadinessFactKey::RepositoryBranch,
            if probe.branch_matches {
                "current"
            } else {
                "stale"
            },
        ),
    ];
    let (status, code, recoverable, action) = if !binary_available {
        (
            ReadinessStatus::Unavailable,
            "READINESS-GIT-BINARY-MISSING",
            false,
            ReadinessRecoveryAction::None,
        )
    } else {
        match probe.state {
            RepositoryReadinessState::Ready => (
                ReadinessStatus::Ready,
                "READINESS-GIT-READY",
                false,
                ReadinessRecoveryAction::None,
            ),
            RepositoryReadinessState::NotSelected => (
                ReadinessStatus::Warning,
                "READINESS-GIT-WORKSPACE-NOT-SELECTED",
                true,
                ReadinessRecoveryAction::SelectWorkspace,
            ),
            RepositoryReadinessState::ReadOnly => (
                ReadinessStatus::Blocked,
                "READINESS-GIT-READ-ONLY",
                true,
                ReadinessRecoveryAction::RepairWorkspace,
            ),
            RepositoryReadinessState::Missing => (
                ReadinessStatus::Blocked,
                "READINESS-GIT-REPOSITORY-MISSING",
                true,
                ReadinessRecoveryAction::RepairWorkspace,
            ),
            RepositoryReadinessState::Moved => (
                ReadinessStatus::Blocked,
                "READINESS-GIT-REPOSITORY-MOVED",
                true,
                ReadinessRecoveryAction::RepairWorkspace,
            ),
            RepositoryReadinessState::Changed => (
                ReadinessStatus::Blocked,
                "READINESS-GIT-IDENTITY-CHANGED",
                true,
                ReadinessRecoveryAction::RepairWorkspace,
            ),
            RepositoryReadinessState::Unreadable => (
                ReadinessStatus::Blocked,
                "READINESS-GIT-REPOSITORY-UNREADABLE",
                true,
                ReadinessRecoveryAction::RepairWorkspace,
            ),
            RepositoryReadinessState::StaleBranch => (
                ReadinessStatus::Blocked,
                "READINESS-GIT-STALE-BRANCH",
                true,
                ReadinessRecoveryAction::RepairWorkspace,
            ),
            RepositoryReadinessState::Unavailable => (
                ReadinessStatus::Unavailable,
                "READINESS-GIT-REPOSITORY-UNAVAILABLE",
                true,
                ReadinessRecoveryAction::Recheck,
            ),
        }
    };
    check(
        ReadinessCheckId::Git,
        status,
        checked_at,
        code,
        recoverable,
        action,
        facts,
    )
}

fn history_check(checked_at: &str, probe: HistoryReadinessProbe) -> ReadinessCheckV1 {
    let facts = vec![
        fact(
            ReadinessFactKey::HistorySchema,
            WORKSPACE_HISTORY_SCHEMA_VERSION.to_string(),
        ),
        fact(
            ReadinessFactKey::HistoryMode,
            match probe.mode {
                HistoryMode::Ready => "ready",
                HistoryMode::ReadOnly => "read_only",
                HistoryMode::RecoveryRequired => "recovery_required",
            },
        ),
        fact(
            ReadinessFactKey::HistoryIntegrity,
            if !probe.available {
                "unavailable"
            } else if probe.integrity_ok {
                "verified"
            } else {
                "failed"
            },
        ),
        fact(
            ReadinessFactKey::HistoryWritability,
            if probe.writable {
                "writable"
            } else {
                "unavailable"
            },
        ),
        fact(
            ReadinessFactKey::HistoryWriter,
            if probe.writer_ready {
                "ready"
            } else {
                "stopped"
            },
        ),
        fact(
            ReadinessFactKey::HistoryMigration,
            if !probe.available {
                "unavailable"
            } else if probe.migration_current {
                "current"
            } else {
                "incomplete"
            },
        ),
        fact(
            ReadinessFactKey::HistoryBackup,
            if probe.backup_valid {
                "verified"
            } else {
                "unavailable"
            },
        ),
    ];
    let (readiness, code, recoverable, action) = if !probe.available {
        (
            ReadinessStatus::Unavailable,
            "READINESS-HISTORY-CHECK-UNAVAILABLE",
            true,
            ReadinessRecoveryAction::Recheck,
        )
    } else if probe.mode == HistoryMode::RecoveryRequired {
        (
            ReadinessStatus::Blocked,
            "READINESS-HISTORY-RECOVERY-REQUIRED",
            true,
            ReadinessRecoveryAction::RepairHistory,
        )
    } else if probe.mode == HistoryMode::ReadOnly {
        (
            ReadinessStatus::Warning,
            "READINESS-HISTORY-READ-ONLY",
            true,
            ReadinessRecoveryAction::RepairHistory,
        )
    } else if !probe.integrity_ok {
        (
            ReadinessStatus::Blocked,
            "READINESS-HISTORY-INTEGRITY-FAILED",
            true,
            ReadinessRecoveryAction::RepairHistory,
        )
    } else if !probe.migration_current {
        (
            ReadinessStatus::Blocked,
            "READINESS-HISTORY-MIGRATION-INCOMPLETE",
            true,
            ReadinessRecoveryAction::RepairHistory,
        )
    } else if !probe.backup_valid {
        (
            ReadinessStatus::Blocked,
            "READINESS-HISTORY-BACKUP-INVALID",
            true,
            ReadinessRecoveryAction::RepairHistory,
        )
    } else if !probe.writable || !probe.writer_ready {
        (
            ReadinessStatus::Blocked,
            "READINESS-HISTORY-WRITER-UNAVAILABLE",
            true,
            ReadinessRecoveryAction::RepairHistory,
        )
    } else {
        (
            ReadinessStatus::Ready,
            "READINESS-HISTORY-READY",
            false,
            ReadinessRecoveryAction::None,
        )
    };
    check(
        ReadinessCheckId::History,
        readiness,
        checked_at,
        code,
        recoverable,
        action,
        facts,
    )
}

fn live2d_check(checked_at: &str, service: &CharacterService) -> ReadinessCheckV1 {
    let probe = service.readiness();
    let facts = vec![
        fact(
            ReadinessFactKey::Live2dCore,
            if probe.core_available {
                "available"
            } else {
                "missing"
            },
        ),
        fact(
            ReadinessFactKey::BuiltinResources,
            if probe.builtin_resources_available {
                "verified"
            } else {
                "missing"
            },
        ),
        fact(
            ReadinessFactKey::CharacterLibrary,
            if probe.library_available {
                "available"
            } else {
                "unavailable"
            },
        ),
        fact(
            ReadinessFactKey::CharacterSchema,
            probe.schema_version.to_string(),
        ),
    ];
    let (status, code, recoverable, action) = if !probe.core_available {
        (
            ReadinessStatus::Blocked,
            "READINESS-LIVE2D-CORE-MISSING",
            false,
            ReadinessRecoveryAction::RestoreLive2d,
        )
    } else if !probe.builtin_resources_available {
        (
            ReadinessStatus::Blocked,
            "READINESS-LIVE2D-BUILTIN-MISSING",
            false,
            ReadinessRecoveryAction::RestoreLive2d,
        )
    } else if !probe.library_available {
        (
            ReadinessStatus::Warning,
            "READINESS-LIVE2D-LIBRARY-UNAVAILABLE",
            true,
            ReadinessRecoveryAction::Recheck,
        )
    } else {
        (
            ReadinessStatus::Ready,
            "READINESS-LIVE2D-READY",
            false,
            ReadinessRecoveryAction::None,
        )
    };
    check(
        ReadinessCheckId::Live2d,
        status,
        checked_at,
        code,
        recoverable,
        action,
        facts,
    )
}

fn preferences_check(checked_at: &str, service: &AppPreferencesService) -> ReadinessCheckV1 {
    let probe = service.readiness();
    let facts = vec![fact(
        ReadinessFactKey::PreferencesSchema,
        probe.schema_version.to_string(),
    )];
    let (status, code, recoverable, action) = match probe.recovery_code.as_deref() {
        None if probe.store_available => (
            ReadinessStatus::Ready,
            "READINESS-PREFERENCES-READY",
            false,
            ReadinessRecoveryAction::None,
        ),
        Some("APP-PREFERENCES-MISSING") if probe.store_available => (
            ReadinessStatus::Warning,
            "READINESS-PREFERENCES-NOT-SAVED",
            true,
            ReadinessRecoveryAction::SavePreferences,
        ),
        Some("APP-PREFERENCES-UNKNOWN-VERSION") => (
            ReadinessStatus::Blocked,
            "READINESS-PREFERENCES-SCHEMA-INCOMPATIBLE",
            true,
            ReadinessRecoveryAction::SavePreferences,
        ),
        Some(_) if probe.store_available => (
            ReadinessStatus::Blocked,
            "READINESS-PREFERENCES-RECOVERY-REQUIRED",
            true,
            ReadinessRecoveryAction::SavePreferences,
        ),
        _ => (
            ReadinessStatus::Unavailable,
            "READINESS-PREFERENCES-UNAVAILABLE",
            true,
            ReadinessRecoveryAction::Recheck,
        ),
    };
    check(
        ReadinessCheckId::Preferences,
        status,
        checked_at,
        code,
        recoverable,
        action,
        facts,
    )
}

fn build_sanitized_summary(snapshot: &NativeReadinessSnapshotV1) -> String {
    let mut summary = String::new();
    let _ = writeln!(summary, "Coding Wife diagnostics v1");
    let _ = writeln!(summary, "snapshot={}", snapshot.snapshot_id);
    let _ = writeln!(summary, "checkedAt={}", snapshot.checked_at);
    let _ = writeln!(summary, "source=native");
    for check in &snapshot.checks {
        let _ = writeln!(
            summary,
            "{} {} {}",
            check.id.as_wire(),
            check.status.as_wire(),
            check.code
        );
        for fact in &check.facts {
            let _ = writeln!(
                summary,
                "{}.{}={}",
                check.id.as_wire(),
                fact.key.as_wire(),
                fact.value
            );
        }
    }
    summary
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codex::types::{ChildState, CodexCapabilities, ReasoningPreset};

    fn diagnostic(health: CodexHealth) -> CodexDiagnostic {
        CodexDiagnostic {
            health,
            checked_at: "2026-07-18T00:00:00.000Z".to_owned(),
            operation: "test".to_owned(),
            child_state: ChildState::Stopped,
            capabilities: CodexCapabilities::default(),
            ..CodexDiagnostic::default()
        }
    }

    #[test]
    fn workspace_codex_ready_requires_auth_model_efforts_and_compatible_schema() {
        let mut ready = diagnostic(CodexHealth::Ready);
        ready.account_present = true;
        ready.model_available = true;
        ready.fast_service_tier = Some("priority".to_owned());
        ready.supported_reasoning_efforts = vec![ReasoningPreset::Low, ReasoningPreset::Max];
        ready.generated_by_same_binary = true;
        ready.experimental_api_accepted = true;
        assert_eq!(
            codex_check("2026-07-18T00:00:00.000Z", &ready, false).status,
            ReadinessStatus::Ready
        );
        assert!(codex_check("2026-07-18T00:00:00.000Z", &ready, true)
            .facts
            .iter()
            .any(|fact| {
                fact.key == ReadinessFactKey::CodexBinarySource && fact.value == "explicit"
            }));

        ready.model_available = false;
        let failed_closed = codex_check("2026-07-18T00:00:00.000Z", &ready, false);
        assert_eq!(failed_closed.status, ReadinessStatus::Unavailable);
        assert_eq!(failed_closed.code, "READINESS-CODEX-DISCONNECTED");
    }

    #[test]
    fn setup_codex_ready_only_requires_a_trusted_initialized_binary() {
        let mut ready = diagnostic(CodexHealth::Ready);
        ready.operation = "codex.setup".to_owned();
        ready.binary_hash_prefix = Some("0123456789abcdef".to_owned());

        let check = codex_check("2026-07-18T00:00:00.000Z", &ready, true);

        assert_eq!(check.status, ReadinessStatus::Ready);
        assert_eq!(check.code, "READINESS-CODEX-READY");
        for key in [
            ReadinessFactKey::CodexAuth,
            ReadinessFactKey::CodexSchema,
            ReadinessFactKey::CodexEfforts,
        ] {
            assert!(check
                .facts
                .iter()
                .any(|fact| fact.key == key && fact.value == "unverified"));
        }
    }

    #[test]
    fn codex_failure_modes_have_stable_safe_recovery_codes() {
        for (health, status, code, action) in [
            (
                CodexHealth::BinaryMissing,
                ReadinessStatus::Unavailable,
                "READINESS-CODEX-BINARY-MISSING",
                ReadinessRecoveryAction::InstallCodex,
            ),
            (
                CodexHealth::AuthRequired,
                ReadinessStatus::Blocked,
                "READINESS-CODEX-AUTH-REQUIRED",
                ReadinessRecoveryAction::AuthenticateCodex,
            ),
            (
                CodexHealth::SchemaUnsupported,
                ReadinessStatus::Blocked,
                "READINESS-CODEX-SCHEMA-INCOMPATIBLE",
                ReadinessRecoveryAction::UpdateCodex,
            ),
        ] {
            let check = codex_check("2026-07-18T00:00:00.000Z", &diagnostic(health), false);
            assert_eq!(
                (check.status, check.code.as_str(), check.recovery_action),
                (status, code, action)
            );
        }
    }

    #[test]
    fn configured_codex_path_requires_a_bounded_absolute_value() {
        assert_eq!(
            validate_configured_codex_path("/opt/coding-wife-fixture/bin/codex")
                .expect("absolute path"),
            PathBuf::from("/opt/coding-wife-fixture/bin/codex")
        );
        for value in ["codex", " /usr/local/bin/codex", "/tmp/codex\n"] {
            assert!(validate_configured_codex_path(value).is_err(), "{value:?}");
        }
    }

    #[test]
    fn repository_recheck_states_have_distinct_safe_codes() {
        let checked_at = "2026-07-18T00:00:00.000Z";
        for (state, status, code) in [
            (
                RepositoryReadinessState::Missing,
                ReadinessStatus::Blocked,
                "READINESS-GIT-REPOSITORY-MISSING",
            ),
            (
                RepositoryReadinessState::Moved,
                ReadinessStatus::Blocked,
                "READINESS-GIT-REPOSITORY-MOVED",
            ),
            (
                RepositoryReadinessState::Changed,
                ReadinessStatus::Blocked,
                "READINESS-GIT-IDENTITY-CHANGED",
            ),
            (
                RepositoryReadinessState::Unreadable,
                ReadinessStatus::Blocked,
                "READINESS-GIT-REPOSITORY-UNREADABLE",
            ),
            (
                RepositoryReadinessState::ReadOnly,
                ReadinessStatus::Blocked,
                "READINESS-GIT-READ-ONLY",
            ),
            (
                RepositoryReadinessState::StaleBranch,
                ReadinessStatus::Blocked,
                "READINESS-GIT-STALE-BRANCH",
            ),
        ] {
            let check = git_check(
                checked_at,
                RepositoryReadinessProbe {
                    state,
                    identity_matches: false,
                    head_matches: false,
                    branch_matches: false,
                },
            );
            assert_eq!((check.status, check.code.as_str()), (status, code));
        }
    }

    #[test]
    fn history_recheck_failures_identify_the_failed_invariant() {
        let checked_at = "2026-07-18T00:00:00.000Z";
        let ready = HistoryReadinessProbe {
            available: true,
            mode: HistoryMode::Ready,
            integrity_ok: true,
            writable: true,
            writer_ready: true,
            migration_current: true,
            backup_valid: true,
        };
        assert_eq!(
            history_check(checked_at, ready).status,
            ReadinessStatus::Ready
        );
        for (probe, code) in [
            (
                HistoryReadinessProbe {
                    integrity_ok: false,
                    ..ready
                },
                "READINESS-HISTORY-INTEGRITY-FAILED",
            ),
            (
                HistoryReadinessProbe {
                    migration_current: false,
                    ..ready
                },
                "READINESS-HISTORY-MIGRATION-INCOMPLETE",
            ),
            (
                HistoryReadinessProbe {
                    backup_valid: false,
                    ..ready
                },
                "READINESS-HISTORY-BACKUP-INVALID",
            ),
            (
                HistoryReadinessProbe {
                    writer_ready: false,
                    ..ready
                },
                "READINESS-HISTORY-WRITER-UNAVAILABLE",
            ),
        ] {
            let check = history_check(checked_at, probe);
            assert_eq!(check.status, ReadinessStatus::Blocked);
            assert_eq!(check.code, code);
        }
    }

    #[test]
    fn macos_support_uses_numeric_major_and_fails_closed() {
        let checked_at = "2026-07-18T00:00:00.000Z";
        for version in ["14", "14.0", "15.5"] {
            assert_eq!(
                os_app_check_for(checked_at, "macos", "aarch64", Some(version.to_owned()),).status,
                ReadinessStatus::Ready,
            );
        }
        assert_eq!(
            os_app_check_for(checked_at, "macos", "aarch64", Some("13.6".to_owned()),).status,
            ReadinessStatus::Blocked,
        );
        for version in [None, Some("14.beta".to_owned()), Some("".to_owned())] {
            assert_eq!(
                os_app_check_for(checked_at, "macos", "aarch64", version).status,
                ReadinessStatus::Unavailable,
            );
        }
    }

    #[test]
    fn copied_summary_contains_only_snapshot_codes_and_allowlisted_facts() {
        let snapshot = NativeReadinessSnapshotV1 {
            schema_version: NATIVE_READINESS_SCHEMA_VERSION,
            snapshot_id: "00000000-0000-4000-8000-000000000011".to_owned(),
            checked_at: "2026-07-18T00:00:00.000Z".to_owned(),
            source: ReadinessSource::Native,
            checks: vec![os_app_check(
                "2026-07-18T00:00:00.000Z",
                Some("15.5".to_owned()),
            )],
        };
        let summary = build_sanitized_summary(&snapshot);
        assert!(summary.contains("READINESS-OS-"));
        for private in ["/Users/", "token=", "stderr", "repository="] {
            assert!(!summary.contains(private));
        }
    }

    #[test]
    fn serialized_snapshot_uses_one_timestamp_and_exact_contract_keys() {
        let checked_at = "2026-07-18T00:00:00.000Z";
        let snapshot = NativeReadinessSnapshotV1 {
            schema_version: NATIVE_READINESS_SCHEMA_VERSION,
            snapshot_id: "00000000-0000-4000-8000-000000000011".to_owned(),
            checked_at: checked_at.to_owned(),
            source: ReadinessSource::Native,
            checks: vec![codex_check(
                checked_at,
                &diagnostic(CodexHealth::BinaryMissing),
                false,
            )],
        };
        assert!(snapshot
            .checks
            .iter()
            .all(|check| check.checked_at == snapshot.checked_at));
        let value = serde_json::to_value(&snapshot).expect("serialize snapshot");
        assert_eq!(value["schemaVersion"], 1);
        assert_eq!(value["checks"][0]["id"], "codex");
        assert_eq!(value["checks"][0]["status"], "unavailable");
    }
}
