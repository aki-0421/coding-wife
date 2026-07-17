pub mod codex;

use serde::{Deserialize, Serialize};

use codex::commands::{
    codex_connect, codex_get_diagnostic, codex_pick_workspace, codex_probe, codex_respond_pending,
    codex_review_start, codex_thread_list, codex_thread_resume, codex_thread_start,
    codex_turn_interrupt, codex_turn_start,
};
use codex::supervisor::CodexSupervisor;
use codex::workspace::WorkspaceService;

const IPC_SCHEMA_VERSION: u16 = 1;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum RuntimeKind {
    Tauri,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum FoundationState {
    Ready,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum IntegrationReadiness {
    NotConfigured,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct HealthCheckResponse {
    schema_version: u16,
    runtime: RuntimeKind,
    foundation_state: FoundationState,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
struct IntegrationMetadata {
    codex: IntegrationReadiness,
    git: IntegrationReadiness,
    live2d: IntegrationReadiness,
    history: IntegrationReadiness,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RuntimeMetadata {
    schema_version: u16,
    runtime: RuntimeKind,
    app_version: String,
    platform: String,
    architecture: String,
    integrations: IntegrationMetadata,
}

#[tauri::command]
fn health_check() -> HealthCheckResponse {
    HealthCheckResponse {
        schema_version: IPC_SCHEMA_VERSION,
        runtime: RuntimeKind::Tauri,
        foundation_state: FoundationState::Ready,
    }
}

fn runtime_metadata(
    app_version: impl Into<String>,
    platform: impl Into<String>,
    architecture: impl Into<String>,
) -> RuntimeMetadata {
    RuntimeMetadata {
        schema_version: IPC_SCHEMA_VERSION,
        runtime: RuntimeKind::Tauri,
        app_version: app_version.into(),
        platform: platform.into(),
        architecture: architecture.into(),
        integrations: IntegrationMetadata {
            codex: IntegrationReadiness::NotConfigured,
            git: IntegrationReadiness::NotConfigured,
            live2d: IntegrationReadiness::NotConfigured,
            history: IntegrationReadiness::NotConfigured,
        },
    }
}

#[tauri::command]
fn get_runtime_metadata() -> RuntimeMetadata {
    runtime_metadata(
        env!("CARGO_PKG_VERSION"),
        std::env::consts::OS,
        std::env::consts::ARCH,
    )
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let supervisor = CodexSupervisor::new();
    let setup_supervisor = supervisor.clone();
    let shutdown_supervisor = supervisor.clone();
    let workspace_service = WorkspaceService::production(supervisor.clone());
    let app = tauri::Builder::default()
        .manage(supervisor)
        .manage(workspace_service)
        .setup(move |app| {
            setup_supervisor.attach_app_handle(app.handle().clone());
            setup_supervisor.start_signal_loop();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            health_check,
            get_runtime_metadata,
            codex_pick_workspace,
            codex_get_diagnostic,
            codex_probe,
            codex_connect,
            codex_thread_list,
            codex_thread_start,
            codex_thread_resume,
            codex_turn_start,
            codex_turn_interrupt,
            codex_review_start,
            codex_respond_pending,
        ])
        .build(tauri::generate_context!())
        .expect("failed to build the Coding Wife application");

    app.run(move |_app_handle, event| {
        if matches!(event, tauri::RunEvent::ExitRequested { .. }) {
            tauri::async_runtime::block_on(shutdown_supervisor.shutdown());
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    const RUNTIME_CONTRACT_FIXTURE: &str =
        include_str!("../../src/test/fixtures/runtime-foundation.v1.json");

    fn contract_fixture() -> Value {
        serde_json::from_str(RUNTIME_CONTRACT_FIXTURE)
            .expect("runtime contract fixture must deserialize")
    }

    fn fixture_response<'a>(fixture: &'a Value, key: &str) -> &'a Value {
        fixture
            .get(key)
            .unwrap_or_else(|| panic!("fixture response {key} must exist"))
    }

    fn serialized_response(response: impl Serialize) -> Value {
        serde_json::to_value(response).expect("command response must serialize")
    }

    #[test]
    fn health_reports_only_the_foundation_state() {
        let response = health_check();

        assert_eq!(response.schema_version, IPC_SCHEMA_VERSION);
        assert_eq!(response.runtime, RuntimeKind::Tauri);
        assert_eq!(response.foundation_state, FoundationState::Ready);
    }

    #[test]
    fn integrations_are_not_reported_as_configured() {
        let metadata = get_runtime_metadata();

        assert_eq!(
            metadata.integrations.codex,
            IntegrationReadiness::NotConfigured
        );
        assert_eq!(
            metadata.integrations.git,
            IntegrationReadiness::NotConfigured
        );
        assert_eq!(
            metadata.integrations.live2d,
            IntegrationReadiness::NotConfigured
        );
        assert_eq!(
            metadata.integrations.history,
            IntegrationReadiness::NotConfigured
        );
    }

    #[test]
    fn serialized_responses_match_the_cross_language_fixture() {
        let fixture = contract_fixture();

        assert_eq!(
            fixture.get("schemaVersion").and_then(Value::as_u64),
            Some(u64::from(IPC_SCHEMA_VERSION))
        );
        assert_eq!(
            serialized_response(health_check()),
            *fixture_response(&fixture, "healthCheck")
        );
        assert_eq!(
            serialized_response(get_runtime_metadata()),
            *fixture_response(&fixture, "runtimeMetadata")
        );
    }

    #[test]
    fn exact_fixture_comparison_rejects_unknown_and_missing_fields() {
        let fixture = contract_fixture();
        let actual_metadata = serialized_response(get_runtime_metadata());
        let mut fixture_with_unknown = fixture_response(&fixture, "runtimeMetadata").clone();
        fixture_with_unknown
            .as_object_mut()
            .expect("fixture metadata must be an object")
            .insert("unexpectedField".to_owned(), Value::Bool(true));

        let mut actual_with_missing_field = actual_metadata.clone();
        actual_with_missing_field
            .as_object_mut()
            .expect("serialized metadata must be an object")
            .remove("schemaVersion");

        assert_ne!(actual_metadata, fixture_with_unknown);
        assert_ne!(
            actual_with_missing_field,
            *fixture_response(&fixture, "runtimeMetadata")
        );
        assert!(serde_json::from_value::<RuntimeMetadata>(fixture_with_unknown).is_err());
    }
}
