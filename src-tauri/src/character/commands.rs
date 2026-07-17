use tauri::{State, WebviewWindow};

use super::error::CharacterCommandError;
use super::service::{
    CharacterAssetRequest, CharacterCancelImportRequest, CharacterConfirmImportRequest,
    CharacterDeleteRequest, CharacterImportResponse, CharacterLibraryRequest,
    CharacterLibrarySnapshot, CharacterPreviewAttestationRequest,
    CharacterPreviewAttestationResponse, CharacterSelectRequest, CharacterService,
};

#[tauri::command]
pub async fn character_library_get(
    request: CharacterLibraryRequest,
    service: State<'_, CharacterService>,
) -> Result<CharacterLibrarySnapshot, CharacterCommandError> {
    service.library(request).await
}

#[tauri::command]
pub async fn character_import_pick(
    request: CharacterLibraryRequest,
    service: State<'_, CharacterService>,
) -> Result<CharacterImportResponse, CharacterCommandError> {
    service.pick_import(request).await
}

#[tauri::command]
pub async fn character_read_asset(
    request: CharacterAssetRequest,
    window: WebviewWindow,
    service: State<'_, CharacterService>,
) -> Result<tauri::ipc::Response, CharacterCommandError> {
    let bytes = service.read_asset(window.label(), request).await?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub async fn character_attest_preview(
    request: CharacterPreviewAttestationRequest,
    service: State<'_, CharacterService>,
) -> Result<CharacterPreviewAttestationResponse, CharacterCommandError> {
    service.attest_preview(request).await
}

#[tauri::command]
pub async fn character_confirm_import(
    request: CharacterConfirmImportRequest,
    service: State<'_, CharacterService>,
) -> Result<CharacterLibrarySnapshot, CharacterCommandError> {
    service.confirm_import(request).await
}

#[tauri::command]
pub async fn character_cancel_import(
    request: CharacterCancelImportRequest,
    service: State<'_, CharacterService>,
) -> Result<(), CharacterCommandError> {
    service.cancel_import(request).await
}

#[tauri::command]
pub async fn character_select_pack(
    request: CharacterSelectRequest,
    service: State<'_, CharacterService>,
) -> Result<CharacterLibrarySnapshot, CharacterCommandError> {
    service.select_pack(request).await
}

#[tauri::command]
pub async fn character_delete_pack(
    request: CharacterDeleteRequest,
    service: State<'_, CharacterService>,
) -> Result<CharacterLibrarySnapshot, CharacterCommandError> {
    service.delete_pack(request).await
}
