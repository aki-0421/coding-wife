use serde::{Deserialize, Serialize};

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
#[serde(rename_all = "camelCase")]
struct HealthCheckResponse {
    schema_version: u16,
    runtime: RuntimeKind,
    foundation_state: FoundationState,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
struct IntegrationMetadata {
    codex: IntegrationReadiness,
    git: IntegrationReadiness,
    live2d: IntegrationReadiness,
    history: IntegrationReadiness,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
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
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![health_check, get_runtime_metadata])
        .run(tauri::generate_context!())
        .expect("failed to run the Coding Wife application");
}

#[cfg(test)]
mod tests {
    use super::*;

    const RUNTIME_CONTRACT_FIXTURE: &str =
        include_str!("../../src/test/fixtures/runtime-foundation.v1.json");

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct RuntimeContractFixture {
        schema_version: u16,
        health_check: HealthCheckResponse,
        runtime_metadata: RuntimeMetadata,
    }

    fn contract_fixture() -> RuntimeContractFixture {
        serde_json::from_str(RUNTIME_CONTRACT_FIXTURE)
            .expect("runtime contract fixture must deserialize")
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
        let fixture_metadata = runtime_metadata(
            fixture.runtime_metadata.app_version.clone(),
            fixture.runtime_metadata.platform.clone(),
            fixture.runtime_metadata.architecture.clone(),
        );

        assert_eq!(fixture.schema_version, IPC_SCHEMA_VERSION);
        assert_eq!(
            serde_json::to_string(&health_check()).expect("health must serialize"),
            serde_json::to_string(&fixture.health_check).expect("fixture health must serialize")
        );
        assert_eq!(
            serde_json::to_string(&fixture_metadata).expect("metadata must serialize"),
            serde_json::to_string(&fixture.runtime_metadata)
                .expect("fixture metadata must serialize")
        );
    }
}
