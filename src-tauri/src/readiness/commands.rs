use tauri::State;

use super::service::NativeReadinessService;
use super::types::{
    CopySanitizedDiagnosticsRequestV1, NativeReadinessSnapshotV1, ReadinessCommandError,
    RunDiagnosticCheckRequestV1, SanitizedDiagnosticsSummaryV1, NATIVE_READINESS_SCHEMA_VERSION,
};

#[tauri::command]
pub async fn run_diagnostic_check(
    service: State<'_, NativeReadinessService>,
    request: RunDiagnosticCheckRequestV1,
) -> Result<NativeReadinessSnapshotV1, ReadinessCommandError> {
    if request.schema_version != NATIVE_READINESS_SCHEMA_VERSION {
        return Err(ReadinessCommandError::new(
            "READINESS-SCHEMA-UNSUPPORTED",
            "run_diagnostic_check",
            false,
        ));
    }
    Ok(service.run().await)
}

#[tauri::command]
pub fn copy_sanitized_diagnostics(
    service: State<'_, NativeReadinessService>,
    request: CopySanitizedDiagnosticsRequestV1,
) -> Result<SanitizedDiagnosticsSummaryV1, ReadinessCommandError> {
    service.sanitized_summary(request)
}
