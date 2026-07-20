use tauri::State;

use super::{
    NarrationCancelRequestV1, NarrationCommandError, NarrationMuteRequestV1,
    NarrationResetRequestV1, NarrationRuntimeSnapshotV1, NarrationScopeRequestV1, NarrationService,
    NarrationSettingsSnapshotV1, NarrationSettingsUpdateV2, NarrationSpeakRequestV1,
    NarrationSpeakResponseV1, NarrationVoiceListV1,
};

#[tauri::command]
pub fn narration_get_settings(
    service: State<'_, NarrationService>,
) -> Result<NarrationSettingsSnapshotV1, NarrationCommandError> {
    public_operation(service.snapshot(), "narration_get_settings")
}

#[tauri::command]
pub fn narration_get_runtime(
    service: State<'_, NarrationService>,
) -> Result<NarrationRuntimeSnapshotV1, NarrationCommandError> {
    public_operation(service.runtime_snapshot(), "narration_get_runtime")
}

#[tauri::command]
pub async fn narration_list_voices(
    service: State<'_, NarrationService>,
) -> Result<NarrationVoiceListV1, NarrationCommandError> {
    public_operation(service.list_voices().await, "narration_list_voices")
}

#[tauri::command]
pub async fn narration_update_settings(
    request: NarrationSettingsUpdateV2,
    service: State<'_, NarrationService>,
) -> Result<NarrationSettingsSnapshotV1, NarrationCommandError> {
    public_operation(
        service.update_settings(request).await,
        "narration_update_settings",
    )
}

#[tauri::command]
pub async fn narration_set_muted(
    request: NarrationMuteRequestV1,
    service: State<'_, NarrationService>,
) -> Result<NarrationSettingsSnapshotV1, NarrationCommandError> {
    public_operation(service.set_muted(request).await, "narration_set_muted")
}

#[tauri::command]
pub async fn narration_reset_settings(
    request: NarrationResetRequestV1,
    service: State<'_, NarrationService>,
) -> Result<NarrationSettingsSnapshotV1, NarrationCommandError> {
    public_operation(
        service.reset_settings(request).await,
        "narration_reset_settings",
    )
}

#[tauri::command]
pub async fn narration_set_scope(
    request: NarrationScopeRequestV1,
    service: State<'_, NarrationService>,
) -> Result<(), NarrationCommandError> {
    public_operation(service.set_scope(request).await, "narration_set_scope")
}

#[tauri::command]
pub async fn narration_speak(
    request: NarrationSpeakRequestV1,
    service: State<'_, NarrationService>,
) -> Result<NarrationSpeakResponseV1, NarrationCommandError> {
    public_operation(service.speak(request).await, "narration_speak")
}

#[tauri::command]
pub async fn narration_cancel(
    request: NarrationCancelRequestV1,
    service: State<'_, NarrationService>,
) -> Result<(), NarrationCommandError> {
    public_operation(service.cancel(request).await, "narration_cancel")
}

fn public_operation<T>(
    result: Result<T, NarrationCommandError>,
    operation: &'static str,
) -> Result<T, NarrationCommandError> {
    result.map_err(|error| error.with_operation(operation))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::narration::error::narration_error;

    #[test]
    fn lower_layer_errors_are_remapped_to_the_public_command_boundary() {
        for public in [
            "narration_get_settings",
            "narration_list_voices",
            "narration_update_settings",
            "narration_set_muted",
            "narration_reset_settings",
            "narration_set_scope",
            "narration_speak",
            "narration_cancel",
        ] {
            let result: Result<(), NarrationCommandError> = Err(narration_error(
                "narration_internal",
                "NARRATION-BOUNDARY-FIXTURE",
                true,
            ));
            let error = public_operation(result, public).expect_err("fixture error");
            assert_eq!(error.operation, public);
            assert_eq!(error.code, "NARRATION-BOUNDARY-FIXTURE");
            assert!(error.recoverable);
        }
    }
}
