use std::fmt::Write as _;
use std::sync::{Arc, RwLock};
use std::time::Duration;

use chrono::{SecondsFormat, Utc};
use tokio::process::Command;
use tokio::sync::Mutex;

use crate::character::CharacterService;
use crate::codex::process::run_bounded_command;
use crate::codex::supervisor::CodexSupervisor;
use crate::codex::types::{CodexDiagnostic, CodexHealth, CODEX_MODEL};
use crate::git_review::runner::GitRunner;
use crate::preferences::AppPreferencesService;
use crate::workspace_history::types::{
    HistoryMode, WorkspaceHealth, WorkspaceStateSnapshot, WORKSPACE_HISTORY_SCHEMA_VERSION,
};
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
        let checked_at = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        let history_snapshot = self.history.list();
        let codex = self.codex.diagnostic().await;
        let checks = vec![
            os_app_check(&checked_at, read_macos_version().await),
            codex_check(&checked_at, &codex),
            git_check(&checked_at, history_snapshot.as_ref().ok()),
            history_check(&checked_at, &self.history, history_snapshot.as_ref().ok()),
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
    let supported = std::env::consts::OS == "macos" && std::env::consts::ARCH == "aarch64";
    let mut facts = vec![
        fact(ReadinessFactKey::Platform, std::env::consts::OS),
        fact(ReadinessFactKey::Architecture, std::env::consts::ARCH),
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
    if !supported {
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
    if os_version.is_none() {
        return check(
            ReadinessCheckId::OsApp,
            ReadinessStatus::Degraded,
            checked_at,
            "READINESS-OS-VERSION-UNAVAILABLE",
            true,
            ReadinessRecoveryAction::Recheck,
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

fn codex_check(checked_at: &str, diagnostic: &CodexDiagnostic) -> ReadinessCheckV1 {
    let auth = if diagnostic.account_present {
        "authenticated"
    } else if diagnostic.requires_openai_auth || diagnostic.health == CodexHealth::AuthRequired {
        "required"
    } else {
        "unverified"
    };
    let schema = if matches!(
        diagnostic.health,
        CodexHealth::SchemaUnsupported | CodexHealth::ProtocolMismatch
    ) {
        "incompatible"
    } else if diagnostic.generated_by_same_binary && diagnostic.experimental_api_accepted {
        "compatible"
    } else {
        "unverified"
    };
    let facts = vec![
        fact(ReadinessFactKey::CodexModel, CODEX_MODEL),
        fact(ReadinessFactKey::CodexAuth, auth),
        fact(ReadinessFactKey::CodexSchema, schema),
    ];
    let (status, code, recoverable, action) = match diagnostic.health {
        CodexHealth::Ready
            if diagnostic.account_present
                && diagnostic.model_available
                && diagnostic.fast_available
                && diagnostic.max_available
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
            ReadinessStatus::NotConfigured,
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
            ReadinessStatus::Error,
            "READINESS-CODEX-SCHEMA-INCOMPATIBLE",
            true,
            ReadinessRecoveryAction::UpdateCodex,
        ),
        CodexHealth::BinaryUntrusted => (
            ReadinessStatus::Error,
            "READINESS-CODEX-BINARY-UNTRUSTED",
            true,
            ReadinessRecoveryAction::InstallCodex,
        ),
        CodexHealth::Initializing => (
            ReadinessStatus::Degraded,
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

fn active_workspace_health(snapshot: &WorkspaceStateSnapshot) -> Option<WorkspaceHealth> {
    let active = snapshot.active_workspace_id.as_deref()?;
    snapshot
        .workspaces
        .iter()
        .find(|workspace| workspace.workspace_id == active)
        .map(|workspace| workspace.health)
}

fn git_check(
    checked_at: &str,
    history_snapshot: Option<&WorkspaceStateSnapshot>,
) -> ReadinessCheckV1 {
    let binary_available = GitRunner::production().is_ok();
    let health = history_snapshot.and_then(active_workspace_health);
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
            health
                .map(WorkspaceHealth::as_str)
                .unwrap_or("not_selected"),
        ),
    ];
    let (status, code, recoverable, action) = if !binary_available {
        (
            ReadinessStatus::Error,
            "READINESS-GIT-BINARY-MISSING",
            false,
            ReadinessRecoveryAction::None,
        )
    } else {
        match health {
            Some(WorkspaceHealth::Ready) => (
                ReadinessStatus::Ready,
                "READINESS-GIT-READY",
                false,
                ReadinessRecoveryAction::None,
            ),
            Some(WorkspaceHealth::ReadOnly) => (
                ReadinessStatus::Degraded,
                "READINESS-GIT-READ-ONLY",
                true,
                ReadinessRecoveryAction::RepairWorkspace,
            ),
            Some(_) => (
                ReadinessStatus::Blocked,
                "READINESS-GIT-WORKSPACE-UNHEALTHY",
                true,
                ReadinessRecoveryAction::RepairWorkspace,
            ),
            None if history_snapshot.is_some() => (
                ReadinessStatus::NotConfigured,
                "READINESS-GIT-WORKSPACE-NOT-SELECTED",
                true,
                ReadinessRecoveryAction::SelectWorkspace,
            ),
            None => (
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

fn history_check(
    checked_at: &str,
    service: &WorkspaceHistoryService,
    snapshot: Option<&WorkspaceStateSnapshot>,
) -> ReadinessCheckV1 {
    let status = service.history_status();
    let facts = vec![
        fact(
            ReadinessFactKey::HistorySchema,
            WORKSPACE_HISTORY_SCHEMA_VERSION.to_string(),
        ),
        fact(
            ReadinessFactKey::HistoryMode,
            match status.mode {
                HistoryMode::Ready => "ready",
                HistoryMode::ReadOnly => "read_only",
                HistoryMode::RecoveryRequired => "recovery_required",
            },
        ),
    ];
    let (readiness, code, recoverable, action) = match (status.mode, snapshot.is_some()) {
        (HistoryMode::Ready, true) => (
            ReadinessStatus::Ready,
            "READINESS-HISTORY-READY",
            false,
            ReadinessRecoveryAction::None,
        ),
        (HistoryMode::Ready, false) => (
            ReadinessStatus::Error,
            "READINESS-HISTORY-QUERY-FAILED",
            true,
            ReadinessRecoveryAction::Recheck,
        ),
        (HistoryMode::ReadOnly, _) => (
            ReadinessStatus::Degraded,
            "READINESS-HISTORY-READ-ONLY",
            true,
            ReadinessRecoveryAction::RepairHistory,
        ),
        (HistoryMode::RecoveryRequired, _) => (
            ReadinessStatus::Error,
            "READINESS-HISTORY-RECOVERY-REQUIRED",
            true,
            ReadinessRecoveryAction::RepairHistory,
        ),
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
            ReadinessStatus::Error,
            "READINESS-LIVE2D-CORE-MISSING",
            false,
            ReadinessRecoveryAction::RestoreLive2d,
        )
    } else if !probe.builtin_resources_available {
        (
            ReadinessStatus::Error,
            "READINESS-LIVE2D-BUILTIN-MISSING",
            false,
            ReadinessRecoveryAction::RestoreLive2d,
        )
    } else if !probe.library_available {
        (
            ReadinessStatus::Degraded,
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
            ReadinessStatus::Degraded,
            "READINESS-PREFERENCES-NOT-SAVED",
            true,
            ReadinessRecoveryAction::SavePreferences,
        ),
        Some("APP-PREFERENCES-UNKNOWN-VERSION") => (
            ReadinessStatus::Error,
            "READINESS-PREFERENCES-SCHEMA-INCOMPATIBLE",
            true,
            ReadinessRecoveryAction::ResetPreferences,
        ),
        Some(_) if probe.store_available => (
            ReadinessStatus::Error,
            "READINESS-PREFERENCES-RECOVERY-REQUIRED",
            true,
            ReadinessRecoveryAction::ResetPreferences,
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
    use crate::codex::types::{ChildState, CodexCapabilities};

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
    fn codex_ready_requires_auth_model_efforts_and_compatible_schema() {
        let mut ready = diagnostic(CodexHealth::Ready);
        ready.account_present = true;
        ready.model_available = true;
        ready.fast_available = true;
        ready.max_available = true;
        ready.generated_by_same_binary = true;
        ready.experimental_api_accepted = true;
        assert_eq!(
            codex_check("2026-07-18T00:00:00.000Z", &ready).status,
            ReadinessStatus::Ready
        );

        ready.model_available = false;
        let failed_closed = codex_check("2026-07-18T00:00:00.000Z", &ready);
        assert_eq!(failed_closed.status, ReadinessStatus::Unavailable);
        assert_eq!(failed_closed.code, "READINESS-CODEX-DISCONNECTED");
    }

    #[test]
    fn codex_failure_modes_have_stable_safe_recovery_codes() {
        for (health, status, code, action) in [
            (
                CodexHealth::BinaryMissing,
                ReadinessStatus::NotConfigured,
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
                ReadinessStatus::Error,
                "READINESS-CODEX-SCHEMA-INCOMPATIBLE",
                ReadinessRecoveryAction::UpdateCodex,
            ),
        ] {
            let check = codex_check("2026-07-18T00:00:00.000Z", &diagnostic(health));
            assert_eq!(
                (check.status, check.code.as_str(), check.recovery_action),
                (status, code, action)
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
            )],
        };
        assert!(snapshot
            .checks
            .iter()
            .all(|check| check.checked_at == snapshot.checked_at));
        let value = serde_json::to_value(&snapshot).expect("serialize snapshot");
        assert_eq!(value["schemaVersion"], 1);
        assert_eq!(value["checks"][0]["id"], "codex");
        assert_eq!(value["checks"][0]["status"], "not_configured");
    }
}
