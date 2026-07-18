use tauri::State;

use super::{
    AppPreferencesCommandError, AppPreferencesGetRequestV1, AppPreferencesResetRequestV1,
    AppPreferencesService, AppPreferencesSnapshotV1, AppPreferencesUpdateRequestV1,
};

#[tauri::command]
pub fn app_preferences_get(
    request: AppPreferencesGetRequestV1,
    service: State<'_, AppPreferencesService>,
) -> Result<AppPreferencesSnapshotV1, AppPreferencesCommandError> {
    public_operation(service.get(request), "app_preferences_get")
}

#[tauri::command]
pub fn app_preferences_update(
    request: AppPreferencesUpdateRequestV1,
    service: State<'_, AppPreferencesService>,
) -> Result<AppPreferencesSnapshotV1, AppPreferencesCommandError> {
    public_operation(service.update(request), "app_preferences_update")
}

#[tauri::command]
pub fn app_preferences_reset(
    request: AppPreferencesResetRequestV1,
    service: State<'_, AppPreferencesService>,
) -> Result<AppPreferencesSnapshotV1, AppPreferencesCommandError> {
    public_operation(service.reset(request), "app_preferences_reset")
}

fn public_operation<T>(
    result: Result<T, AppPreferencesCommandError>,
    operation: &'static str,
) -> Result<T, AppPreferencesCommandError> {
    result.map_err(|error| error.with_operation(operation))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::preferences::error::preferences_error;

    #[test]
    fn lower_layer_errors_are_remapped_to_the_public_command_boundary() {
        for operation in [
            "app_preferences_get",
            "app_preferences_update",
            "app_preferences_reset",
        ] {
            let result: Result<(), AppPreferencesCommandError> = Err(preferences_error(
                "preferences_internal",
                "APP-PREFERENCES-BOUNDARY-FIXTURE",
                true,
            ));
            let error = public_operation(result, operation).expect_err("fixture error");
            assert_eq!(error.operation, operation);
            assert_eq!(error.code, "APP-PREFERENCES-BOUNDARY-FIXTURE");
            assert!(error.recoverable);
        }
    }
}
