use serde::Serialize;

const IPC_SCHEMA_VERSION: u16 = 1;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum RuntimeKind {
    Tauri,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum FoundationState {
    Ready,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum IntegrationReadiness {
    NotConfigured,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct HealthCheckResponse {
    schema_version: u16,
    runtime: RuntimeKind,
    foundation_state: FoundationState,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
struct IntegrationMetadata {
    codex: IntegrationReadiness,
    git: IntegrationReadiness,
    live2d: IntegrationReadiness,
    history: IntegrationReadiness,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeMetadata {
    schema_version: u16,
    runtime: RuntimeKind,
    app_version: &'static str,
    platform: &'static str,
    architecture: &'static str,
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

#[tauri::command]
fn get_runtime_metadata() -> RuntimeMetadata {
    RuntimeMetadata {
        schema_version: IPC_SCHEMA_VERSION,
        runtime: RuntimeKind::Tauri,
        app_version: env!("CARGO_PKG_VERSION"),
        platform: std::env::consts::OS,
        architecture: std::env::consts::ARCH,
        integrations: IntegrationMetadata {
            codex: IntegrationReadiness::NotConfigured,
            git: IntegrationReadiness::NotConfigured,
            live2d: IntegrationReadiness::NotConfigured,
            history: IntegrationReadiness::NotConfigured,
        },
    }
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
}
