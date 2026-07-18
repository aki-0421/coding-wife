use tauri::{State, WebviewWindow};

use super::error::{CharacterCommandError, CharacterResult};
use super::service::{
    CharacterAssetRequest, CharacterCancelImportRequest, CharacterConfirmImportRequest,
    CharacterDeleteRequest, CharacterImportResponse, CharacterLibraryRequest,
    CharacterLibrarySnapshot, CharacterPreviewAttestationRequest,
    CharacterPreviewAttestationResponse, CharacterSelectRequest,
    CharacterSemanticMappingSaveRequest, CharacterService,
};

#[tauri::command]
pub async fn character_library_get(
    request: CharacterLibraryRequest,
    service: State<'_, CharacterService>,
) -> Result<CharacterLibrarySnapshot, CharacterCommandError> {
    public_operation(service.library(request).await, "character_library_get")
}

#[tauri::command]
pub async fn character_import_pick(
    request: CharacterLibraryRequest,
    service: State<'_, CharacterService>,
) -> Result<CharacterImportResponse, CharacterCommandError> {
    public_operation(service.pick_import(request).await, "character_import_pick")
}

#[tauri::command]
pub async fn character_read_asset(
    request: CharacterAssetRequest,
    window: WebviewWindow,
    service: State<'_, CharacterService>,
) -> Result<tauri::ipc::Response, CharacterCommandError> {
    let bytes = public_operation(
        service.read_asset(window.label(), request).await,
        "character_read_asset",
    )?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub async fn character_attest_preview(
    request: CharacterPreviewAttestationRequest,
    service: State<'_, CharacterService>,
) -> Result<CharacterPreviewAttestationResponse, CharacterCommandError> {
    public_operation(
        service.attest_preview(request).await,
        "character_attest_preview",
    )
}

#[tauri::command]
pub async fn character_confirm_import(
    request: CharacterConfirmImportRequest,
    service: State<'_, CharacterService>,
) -> Result<CharacterLibrarySnapshot, CharacterCommandError> {
    public_operation(
        service.confirm_import(request).await,
        "character_confirm_import",
    )
}

#[tauri::command]
pub async fn character_cancel_import(
    request: CharacterCancelImportRequest,
    service: State<'_, CharacterService>,
) -> Result<(), CharacterCommandError> {
    public_operation(
        service.cancel_import(request).await,
        "character_cancel_import",
    )
}

#[tauri::command]
pub async fn character_select_pack(
    request: CharacterSelectRequest,
    service: State<'_, CharacterService>,
) -> Result<CharacterLibrarySnapshot, CharacterCommandError> {
    public_operation(service.select_pack(request).await, "character_select_pack")
}

#[tauri::command]
pub async fn character_delete_pack(
    request: CharacterDeleteRequest,
    service: State<'_, CharacterService>,
) -> Result<CharacterLibrarySnapshot, CharacterCommandError> {
    public_operation(service.delete_pack(request).await, "character_delete_pack")
}

#[tauri::command]
pub async fn character_semantic_mapping_save(
    request: CharacterSemanticMappingSaveRequest,
    service: State<'_, CharacterService>,
) -> Result<CharacterLibrarySnapshot, CharacterCommandError> {
    public_operation(
        service.save_semantic_mapping(request).await,
        "character_semantic_mapping_save",
    )
}

fn public_operation<T>(result: CharacterResult<T>, operation: &'static str) -> CharacterResult<T> {
    result.map_err(|error| error.with_operation(operation))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::character::error::character_error;

    #[test]
    fn lower_layer_errors_are_remapped_to_the_public_command_boundary() {
        for (lower_operation, public) in [
            ("character_state", "character_library_get"),
            ("character_storage", "character_confirm_import"),
            ("character_manifest", "character_import_pick"),
            ("character_library", "character_select_pack"),
            ("character_asset", "character_read_asset"),
        ] {
            let result: CharacterResult<()> = Err(character_error(
                lower_operation,
                "CHARACTER-BOUNDARY-FIXTURE",
                true,
            ));
            let error = public_operation(result, public).expect_err("fixture error");
            assert_eq!(error.operation, public);
            assert_eq!(error.code, "CHARACTER-BOUNDARY-FIXTURE");
            assert!(error.recoverable);
        }
    }
}
