use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, Instant};

use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;

use super::error::{character_error, CharacterResult};
use super::manifest::{
    is_sha256, CharacterPackManifest, BUILTIN_HIYORI_PACK_ID, CHARACTER_SCHEMA_VERSION,
};
use super::storage::{CharacterStateFile, CharacterStorage, StoredPack};
use super::validation::{snapshot_character_model, validate_trusted_frame_png};

const PREVIEW_TTL: Duration = Duration::from_secs(10 * 60);
const BUILTIN_MANIFEST_FILE: &str = "pack.json";
const MAX_JS_SAFE_INTEGER: u64 = (1_u64 << 53) - 1;

pub type CharacterPickerFuture<'a> = Pin<Box<dyn Future<Output = Option<PathBuf>> + Send + 'a>>;

pub trait CharacterModelPicker: Send + Sync {
    fn pick_model_file(&self) -> CharacterPickerFuture<'_>;
}

pub struct NativeCharacterModelPicker;

impl CharacterModelPicker for NativeCharacterModelPicker {
    fn pick_model_file(&self) -> CharacterPickerFuture<'_> {
        Box::pin(async {
            rfd::AsyncFileDialog::new()
                .set_title("Select one Live2D .model3.json file")
                .add_filter("Live2D model", &["json"])
                .pick_file()
                .await
                .map(|handle| handle.path().to_path_buf())
        })
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CharacterPackKind {
    Builtin,
    Custom,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CharacterPackView {
    pub schema_version: u16,
    pub pack_id: String,
    pub display_name: String,
    pub kind: CharacterPackKind,
    pub manifest_hash: String,
    pub provenance_label: String,
    pub imported_at: Option<String>,
    pub runtime_file_count: u32,
    pub total_bytes: u64,
    pub texture_count: u32,
    pub motion_count: u32,
    pub expression_count: u32,
    pub selected_workspace_count: u32,
    pub deletable: bool,
    pub manifest: Option<CharacterPackManifest>,
    pub thumbnail_sha256: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CharacterLibrarySnapshot {
    pub schema_version: u16,
    pub workspace_id: String,
    pub selected_pack_id: String,
    pub fallback_applied: bool,
    pub diagnostics: Vec<String>,
    pub packs: Vec<CharacterPackView>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CharacterImportOutcome {
    Selected,
    Canceled,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CharacterPreviewSession {
    pub schema_version: u16,
    pub preview_token: String,
    pub preview_nonce: String,
    pub generation: u64,
    pub pack_id: String,
    pub manifest_hash: String,
    pub expires_at: String,
    pub manifest: CharacterPackManifest,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CharacterImportResponse {
    pub schema_version: u16,
    pub outcome: CharacterImportOutcome,
    pub preview: Option<CharacterPreviewSession>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CharacterLibraryRequest {
    pub workspace_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CharacterAssetRequest {
    pub pack_id: String,
    pub asset_id: String,
    pub manifest_hash: String,
    pub expected_mime: String,
    pub preview_token: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CharacterPreviewAttestationRequest {
    pub preview_token: String,
    pub preview_nonce: String,
    pub renderer_nonce: String,
    pub generation: u64,
    pub manifest_hash: String,
    pub frame_count: u64,
    pub non_transparent_samples: u64,
    pub signature: String,
    pub texture_decode_count: u32,
    pub state_cue_observed: bool,
    pub webgl_error: u32,
    pub parameter_count: u32,
    pub part_count: u32,
    pub drawable_count: u32,
    pub thumbnail_sha256: String,
    pub thumbnail_png: Vec<u8>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CharacterPreviewAttestationResponse {
    pub schema_version: u16,
    pub attested: bool,
    pub renderer_nonce: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CharacterConfirmImportRequest {
    pub workspace_id: String,
    pub preview_token: String,
    pub preview_nonce: String,
    pub renderer_nonce: String,
    pub generation: u64,
    pub manifest_hash: String,
    pub display_name: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CharacterCancelImportRequest {
    pub preview_token: String,
    pub preview_nonce: String,
    pub generation: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CharacterSelectRequest {
    pub workspace_id: String,
    pub pack_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CharacterDeleteRequest {
    pub workspace_id: String,
    pub pack_id: String,
}

#[derive(Clone, Debug)]
struct PendingImport {
    preview_token: String,
    preview_nonce: String,
    renderer_nonce: Option<String>,
    generation: u64,
    manifest_hash: String,
    directory: PathBuf,
    manifest: CharacterPackManifest,
    expires: Instant,
    attestation: Option<CharacterPreviewAttestationRequest>,
}

#[derive(Clone)]
pub struct CharacterService {
    storage: CharacterStorage,
    builtin_directory: PathBuf,
    picker: Arc<dyn CharacterModelPicker>,
    pending: Arc<Mutex<HashMap<String, PendingImport>>>,
    operations: Arc<Mutex<()>>,
}

impl CharacterService {
    pub fn production(storage: CharacterStorage, builtin_directory: PathBuf) -> Self {
        Self::new(
            storage,
            builtin_directory,
            Arc::new(NativeCharacterModelPicker),
        )
    }

    pub fn new(
        storage: CharacterStorage,
        builtin_directory: PathBuf,
        picker: Arc<dyn CharacterModelPicker>,
    ) -> Self {
        Self {
            storage,
            builtin_directory,
            picker,
            pending: Arc::new(Mutex::new(HashMap::new())),
            operations: Arc::new(Mutex::new(())),
        }
    }

    pub async fn library(
        &self,
        request: CharacterLibraryRequest,
    ) -> CharacterResult<CharacterLibrarySnapshot> {
        validate_workspace_id(&request.workspace_id, "character_library_get")?;
        let _operation = self.operations.lock().await;
        self.cleanup_expired().await;
        self.snapshot(&request.workspace_id)
    }

    pub async fn pick_import(
        &self,
        request: CharacterLibraryRequest,
    ) -> CharacterResult<CharacterImportResponse> {
        validate_workspace_id(&request.workspace_id, "character_import_pick")?;
        let _operation = self.operations.lock().await;
        self.cleanup_expired().await;
        let Some(selected) = self.picker.pick_model_file().await else {
            return Ok(CharacterImportResponse {
                schema_version: CHARACTER_SCHEMA_VERSION,
                outcome: CharacterImportOutcome::Canceled,
                preview: None,
            });
        };
        let pack_id = format!("custom:{}", uuid::Uuid::new_v4());
        let token = uuid::Uuid::new_v4().to_string();
        let preview_nonce = uuid::Uuid::new_v4().to_string();
        let generation = random_generation();
        let imported_at = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        let snapshot = snapshot_character_model(&selected, pack_id.clone(), imported_at)?;
        let manifest_hash = snapshot.manifest.sha256()?;
        let directory = self.storage.prepare_quarantine(&token, &snapshot)?;
        let expires_at = (Utc::now() + chrono::Duration::from_std(PREVIEW_TTL).unwrap_or_default())
            .to_rfc3339_opts(SecondsFormat::Millis, true);
        let pending = PendingImport {
            preview_token: token.clone(),
            preview_nonce: preview_nonce.clone(),
            renderer_nonce: None,
            generation,
            manifest_hash: manifest_hash.clone(),
            directory,
            manifest: snapshot.manifest.clone(),
            expires: Instant::now() + PREVIEW_TTL,
            attestation: None,
        };
        self.pending.lock().await.insert(token.clone(), pending);
        Ok(CharacterImportResponse {
            schema_version: CHARACTER_SCHEMA_VERSION,
            outcome: CharacterImportOutcome::Selected,
            preview: Some(CharacterPreviewSession {
                schema_version: CHARACTER_SCHEMA_VERSION,
                preview_token: token,
                preview_nonce,
                generation,
                pack_id,
                manifest_hash,
                expires_at,
                manifest: snapshot.manifest,
            }),
        })
    }

    pub async fn read_asset(
        &self,
        window_label: &str,
        request: CharacterAssetRequest,
    ) -> CharacterResult<Vec<u8>> {
        if window_label != "main"
            || !is_sha256(&request.manifest_hash)
            || request.asset_id.len() > 512
        {
            return Err(character_error(
                "character_read_asset",
                "CHARACTER-ASSET-REQUEST",
                false,
            ));
        }
        if let Some(token) = &request.preview_token {
            let pending = self.pending.lock().await;
            let session = pending.get(token).ok_or_else(|| {
                character_error("character_read_asset", "CHARACTER-PREVIEW-EXPIRED", true)
            })?;
            validate_pending_asset(session, &request)?;
            let expected_mime = expected_manifest_asset_mime(&session.manifest, &request.asset_id)
                .ok_or_else(|| {
                    character_error(
                        "character_read_asset",
                        "CHARACTER-ASSET-NOT-ALLOWLISTED",
                        false,
                    )
                })?;
            if request.expected_mime != expected_mime {
                return Err(character_error(
                    "character_read_asset",
                    "CHARACTER-ASSET-MIME-MISMATCH",
                    false,
                ));
            }
            return self.storage.read_quarantine_asset(
                &session.directory,
                &session.manifest,
                &request.manifest_hash,
                &request.asset_id,
            );
        }
        if request.pack_id == BUILTIN_HIYORI_PACK_ID {
            return self.read_builtin_asset(&request);
        }
        let pack = self.storage.load_pack(&request.pack_id)?;
        let expected_mime = expected_manifest_asset_mime(&pack.manifest, &request.asset_id)
            .ok_or_else(|| {
                character_error(
                    "character_read_asset",
                    "CHARACTER-ASSET-NOT-ALLOWLISTED",
                    false,
                )
            })?;
        if request.expected_mime != expected_mime {
            return Err(character_error(
                "character_read_asset",
                "CHARACTER-ASSET-MIME-MISMATCH",
                false,
            ));
        }
        self.storage.read_published_asset(
            &request.pack_id,
            &request.manifest_hash,
            &request.asset_id,
        )
    }

    pub async fn attest_preview(
        &self,
        request: CharacterPreviewAttestationRequest,
    ) -> CharacterResult<CharacterPreviewAttestationResponse> {
        let _operation = self.operations.lock().await;
        self.cleanup_expired().await;
        if uuid::Uuid::parse_str(&request.renderer_nonce).is_err()
            || request.frame_count == 0
            || request.non_transparent_samples == 0
            || request.signature.len() != 8
            || !request
                .signature
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
            || !request.state_cue_observed
            || request.webgl_error != 0
            || request.parameter_count == 0
            || request.part_count == 0
            || request.drawable_count == 0
            || !is_sha256(&request.thumbnail_sha256)
        {
            return Err(character_error(
                "character_attest_preview",
                "CHARACTER-PREVIEW-ATTESTATION-INVALID",
                false,
            ));
        }
        let trusted_frame =
            validate_trusted_frame_png(&request.thumbnail_png, &request.thumbnail_sha256)?;
        let mut pending = self.pending.lock().await;
        let session = pending.get_mut(&request.preview_token).ok_or_else(|| {
            character_error(
                "character_attest_preview",
                "CHARACTER-PREVIEW-EXPIRED",
                true,
            )
        })?;
        validate_pending_identity(
            session,
            &request.preview_nonce,
            request.generation,
            &request.manifest_hash,
            "character_attest_preview",
        )?;
        if let Some(attestation) = &session.attestation {
            if attestation == &request {
                return Ok(CharacterPreviewAttestationResponse {
                    schema_version: CHARACTER_SCHEMA_VERSION,
                    attested: true,
                    renderer_nonce: request.renderer_nonce,
                });
            }
            return Err(character_error(
                "character_attest_preview",
                "CHARACTER-PREVIEW-ATTESTATION-REPLAY",
                false,
            ));
        }
        if request.texture_decode_count != session.manifest.inventory.texture_count
            || session.manifest.asset(&trusted_frame.asset_id).is_some()
        {
            return Err(character_error(
                "character_attest_preview",
                "CHARACTER-PREVIEW-ATTESTATION-INVALID",
                false,
            ));
        }
        self.storage.persist_trusted_frame(
            &session.directory,
            &trusted_frame,
            &request.thumbnail_png,
        )?;
        session.manifest.compatibility.expected_parameters = Some(request.parameter_count);
        session.manifest.compatibility.expected_parts = Some(request.part_count);
        session.manifest.compatibility.expected_drawables = Some(request.drawable_count);
        session.manifest.trusted_frame = Some(trusted_frame);
        session.renderer_nonce = Some(request.renderer_nonce.clone());
        session.attestation = Some(request.clone());
        Ok(CharacterPreviewAttestationResponse {
            schema_version: CHARACTER_SCHEMA_VERSION,
            attested: true,
            renderer_nonce: request.renderer_nonce,
        })
    }

    pub async fn confirm_import(
        &self,
        request: CharacterConfirmImportRequest,
    ) -> CharacterResult<CharacterLibrarySnapshot> {
        validate_workspace_id(&request.workspace_id, "character_confirm_import")?;
        if !(1..=80).contains(&request.display_name.trim().chars().count()) {
            return Err(character_error(
                "character_confirm_import",
                "CHARACTER-DISPLAY-NAME",
                true,
            ));
        }
        let _operation = self.operations.lock().await;
        self.cleanup_expired().await;
        let mut pending = self.pending.lock().await;
        let session = pending.get_mut(&request.preview_token).ok_or_else(|| {
            character_error(
                "character_confirm_import",
                "CHARACTER-PREVIEW-EXPIRED",
                true,
            )
        })?;
        validate_pending_identity(
            session,
            &request.preview_nonce,
            request.generation,
            &request.manifest_hash,
            "character_confirm_import",
        )?;
        if session.attestation.is_none()
            || session.renderer_nonce.as_deref() != Some(&request.renderer_nonce)
        {
            return Err(character_error(
                "character_confirm_import",
                "CHARACTER-PREVIEW-NOT-ATTESTED",
                false,
            ));
        }
        session.manifest.display_name = request.display_name.trim().to_owned();
        self.storage.publish_and_select(
            &session.directory,
            &session.manifest,
            &request.workspace_id,
        )?;
        pending.remove(&request.preview_token);
        drop(pending);
        self.snapshot(&request.workspace_id)
    }

    pub async fn cancel_import(
        &self,
        request: CharacterCancelImportRequest,
    ) -> CharacterResult<()> {
        let _operation = self.operations.lock().await;
        let mut pending = self.pending.lock().await;
        let session = pending.get(&request.preview_token).ok_or_else(|| {
            character_error("character_cancel_import", "CHARACTER-PREVIEW-EXPIRED", true)
        })?;
        if session.preview_nonce != request.preview_nonce
            || session.generation != request.generation
        {
            return Err(character_error(
                "character_cancel_import",
                "CHARACTER-PREVIEW-IDENTITY",
                false,
            ));
        }
        let directory = session.directory.clone();
        self.storage.cancel_quarantine(&directory)?;
        pending.remove(&request.preview_token);
        Ok(())
    }

    pub async fn select_pack(
        &self,
        request: CharacterSelectRequest,
    ) -> CharacterResult<CharacterLibrarySnapshot> {
        validate_workspace_id(&request.workspace_id, "character_select_pack")?;
        let _operation = self.operations.lock().await;
        if request.pack_id != BUILTIN_HIYORI_PACK_ID {
            let pack = self.storage.load_pack(&request.pack_id)?;
            if pack.manifest.compatibility.expected_drawables.is_none() {
                return Err(character_error(
                    "character_select_pack",
                    "CHARACTER-PREVIEW-NOT-ATTESTED",
                    false,
                ));
            }
        }
        let mut state = self.storage.load_state()?;
        state
            .workspace_selections
            .insert(request.workspace_id.clone(), request.pack_id);
        self.storage.save_state(&state)?;
        self.snapshot(&request.workspace_id)
    }

    pub async fn delete_pack(
        &self,
        request: CharacterDeleteRequest,
    ) -> CharacterResult<CharacterLibrarySnapshot> {
        validate_workspace_id(&request.workspace_id, "character_delete_pack")?;
        if request.pack_id == BUILTIN_HIYORI_PACK_ID {
            return Err(character_error(
                "character_delete_pack",
                "CHARACTER-BUILTIN-DELETE-DENIED",
                false,
            ));
        }
        let _operation = self.operations.lock().await;
        let state = self.storage.load_state()?;
        if state
            .workspace_selections
            .values()
            .any(|selected| selected == &request.pack_id)
        {
            return Err(character_error(
                "character_delete_pack",
                "CHARACTER-ACTIVE-DELETE-DENIED",
                true,
            ));
        }
        self.storage.delete_pack(&request.pack_id)?;
        self.snapshot(&request.workspace_id)
    }

    fn snapshot(&self, workspace_id: &str) -> CharacterResult<CharacterLibrarySnapshot> {
        let (custom_packs, mut diagnostics) = self.storage.load_custom_packs()?;
        let valid_ids = custom_packs
            .iter()
            .map(|pack| pack.manifest.pack_id.as_str())
            .collect::<Vec<_>>();
        let mut state = self.storage.load_state()?;
        let requested = state.selected_for(workspace_id).to_owned();
        let fallback_applied = requested != BUILTIN_HIYORI_PACK_ID
            && !valid_ids.iter().any(|candidate| *candidate == requested);
        let selected_pack_id = if fallback_applied {
            diagnostics.push("CHARACTER-SELECTION-FALLBACK".to_owned());
            state.workspace_selections.remove(workspace_id);
            self.storage.save_state(&state)?;
            BUILTIN_HIYORI_PACK_ID.to_owned()
        } else {
            requested
        };
        let mut packs = vec![self.builtin_pack_view(&state)?];
        packs.extend(
            custom_packs
                .iter()
                .map(|pack| custom_pack_view(pack, &state)),
        );
        Ok(CharacterLibrarySnapshot {
            schema_version: CHARACTER_SCHEMA_VERSION,
            workspace_id: workspace_id.to_owned(),
            selected_pack_id,
            fallback_applied,
            diagnostics,
            packs,
        })
    }

    fn builtin_pack_view(&self, state: &CharacterStateFile) -> CharacterResult<CharacterPackView> {
        let manifest_bytes = std::fs::read(self.builtin_directory.join(BUILTIN_MANIFEST_FILE))
            .map_err(|_| {
                character_error("character_library_get", "CHARACTER-BUILTIN-MANIFEST", false)
            })?;
        let value: serde_json::Value = serde_json::from_slice(&manifest_bytes).map_err(|_| {
            character_error("character_library_get", "CHARACTER-BUILTIN-MANIFEST", false)
        })?;
        let get_u64 = |key: &str| {
            value
                .get("inventory")
                .and_then(|inventory| inventory.get(key))
                .and_then(serde_json::Value::as_u64)
                .unwrap_or_default()
        };
        Ok(CharacterPackView {
            schema_version: CHARACTER_SCHEMA_VERSION,
            pack_id: BUILTIN_HIYORI_PACK_ID.to_owned(),
            display_name: value
                .get("displayName")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("Hiyori")
                .to_owned(),
            kind: CharacterPackKind::Builtin,
            manifest_hash: hex::encode(Sha256::digest(&manifest_bytes)),
            provenance_label: "かにビーム / Live2D".to_owned(),
            imported_at: None,
            runtime_file_count: get_u64("runtimeFileCount") as u32,
            total_bytes: get_u64("totalBytes"),
            texture_count: get_u64("textureCount") as u32,
            motion_count: get_u64("motionCount") as u32,
            expression_count: get_u64("expressionCount") as u32,
            selected_workspace_count: state
                .workspace_selections
                .values()
                .filter(|pack| pack.as_str() == BUILTIN_HIYORI_PACK_ID)
                .count() as u32,
            deletable: false,
            manifest: None,
            thumbnail_sha256: None,
        })
    }

    fn read_builtin_asset(&self, request: &CharacterAssetRequest) -> CharacterResult<Vec<u8>> {
        let manifest_bytes = std::fs::read(self.builtin_directory.join(BUILTIN_MANIFEST_FILE))
            .map_err(|_| {
                character_error("character_read_asset", "CHARACTER-BUILTIN-MANIFEST", false)
            })?;
        if hex::encode(Sha256::digest(&manifest_bytes)) != request.manifest_hash {
            return Err(character_error(
                "character_read_asset",
                "CHARACTER-MANIFEST-HASH-MISMATCH",
                false,
            ));
        }
        let value: serde_json::Value = serde_json::from_slice(&manifest_bytes).map_err(|_| {
            character_error("character_read_asset", "CHARACTER-BUILTIN-MANIFEST", false)
        })?;
        let files = value
            .get("files")
            .and_then(serde_json::Value::as_array)
            .ok_or_else(|| {
                character_error("character_read_asset", "CHARACTER-BUILTIN-MANIFEST", false)
            })?;
        let asset = files
            .iter()
            .find(|asset| {
                asset.get("assetId").and_then(serde_json::Value::as_str) == Some(&request.asset_id)
            })
            .ok_or_else(|| {
                character_error(
                    "character_read_asset",
                    "CHARACTER-ASSET-NOT-ALLOWLISTED",
                    false,
                )
            })?;
        let role = asset
            .get("role")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        let mime = match role {
            "moc" => "application/octet-stream",
            "texture" => "image/png",
            "model" | "motion" | "physics" | "pose" | "display_info" => "application/json",
            _ => "",
        };
        if mime.is_empty() || request.expected_mime != mime {
            return Err(character_error(
                "character_read_asset",
                "CHARACTER-ASSET-MIME-MISMATCH",
                false,
            ));
        }
        let expected_bytes = asset
            .get("bytes")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or_default();
        let expected_hash = asset
            .get("sha256")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        let path = self.builtin_directory.join(&request.asset_id);
        let contents = std::fs::read(path)
            .map_err(|_| character_error("character_read_asset", "CHARACTER-ASSET-READ", true))?;
        if contents.len() as u64 != expected_bytes
            || hex::encode(Sha256::digest(&contents)) != expected_hash
        {
            return Err(character_error(
                "character_read_asset",
                "CHARACTER-ASSET-HASH-MISMATCH",
                false,
            ));
        }
        Ok(contents)
    }

    async fn cleanup_expired(&self) {
        let mut pending = self.pending.lock().await;
        let expired = pending
            .iter()
            .filter(|(_, session)| Instant::now() >= session.expires)
            .map(|(token, session)| (token.clone(), session.directory.clone()))
            .collect::<Vec<_>>();
        for (token, directory) in expired {
            let _ = self.storage.cancel_quarantine(&directory);
            pending.remove(&token);
        }
    }
}

fn custom_pack_view(pack: &StoredPack, state: &CharacterStateFile) -> CharacterPackView {
    CharacterPackView {
        schema_version: CHARACTER_SCHEMA_VERSION,
        pack_id: pack.manifest.pack_id.clone(),
        display_name: pack.manifest.display_name.clone(),
        kind: CharacterPackKind::Custom,
        manifest_hash: pack.manifest_hash.clone(),
        provenance_label: pack.manifest.provenance.source_label.clone(),
        imported_at: Some(pack.manifest.imported_at.clone()),
        runtime_file_count: pack.manifest.inventory.runtime_file_count,
        total_bytes: pack.manifest.inventory.total_bytes,
        texture_count: pack.manifest.inventory.texture_count,
        motion_count: pack.manifest.inventory.motion_count,
        expression_count: pack.manifest.inventory.expression_count,
        selected_workspace_count: state
            .workspace_selections
            .values()
            .filter(|selected| *selected == &pack.manifest.pack_id)
            .count() as u32,
        deletable: !state
            .workspace_selections
            .values()
            .any(|selected| selected == &pack.manifest.pack_id),
        manifest: Some(pack.manifest.clone()),
        thumbnail_sha256: pack
            .manifest
            .trusted_frame
            .as_ref()
            .map(|frame| frame.sha256.clone()),
    }
}

fn expected_manifest_asset_mime<'a>(
    manifest: &'a CharacterPackManifest,
    asset_id: &str,
) -> Option<&'a str> {
    if let Some(asset) = manifest.asset(asset_id) {
        return Some(asset.role.mime());
    }
    manifest
        .trusted_frame
        .as_ref()
        .filter(|frame| frame.asset_id == asset_id)
        .map(|_| "image/png")
}

fn validate_pending_asset(
    session: &PendingImport,
    request: &CharacterAssetRequest,
) -> CharacterResult<()> {
    if session.preview_token != request.preview_token.as_deref().unwrap_or_default()
        || session.manifest.pack_id != request.pack_id
        || session.manifest_hash != request.manifest_hash
        || Instant::now() >= session.expires
    {
        return Err(character_error(
            "character_read_asset",
            "CHARACTER-PREVIEW-IDENTITY",
            false,
        ));
    }
    Ok(())
}

fn validate_pending_identity(
    session: &PendingImport,
    preview_nonce: &str,
    generation: u64,
    manifest_hash: &str,
    operation: &str,
) -> CharacterResult<()> {
    if session.preview_nonce != preview_nonce
        || session.generation != generation
        || session.manifest_hash != manifest_hash
        || Instant::now() >= session.expires
    {
        return Err(character_error(
            operation,
            "CHARACTER-PREVIEW-IDENTITY",
            false,
        ));
    }
    Ok(())
}

fn validate_workspace_id(workspace_id: &str, operation: &str) -> CharacterResult<()> {
    if workspace_id.is_empty()
        || workspace_id.len() > 160
        || !workspace_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_:".contains(&byte))
    {
        return Err(character_error(operation, "CHARACTER-WORKSPACE-ID", false));
    }
    Ok(())
}

fn random_generation() -> u64 {
    let bytes = *uuid::Uuid::new_v4().as_bytes();
    (u64::from_be_bytes(bytes[0..8].try_into().unwrap_or([0; 8])) & MAX_JS_SAFE_INTEGER).max(1)
}

pub fn resolve_builtin_directory(resource_directory: &Path) -> PathBuf {
    let candidates = [
        resource_directory.join("characters/builtin-hiyori"),
        resource_directory.join("resources/characters/builtin-hiyori"),
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/characters/builtin-hiyori"),
    ];
    candidates
        .into_iter()
        .find(|candidate| candidate.join(BUILTIN_MANIFEST_FILE).is_file())
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/characters/builtin-hiyori")
        })
}

#[cfg(test)]
mod tests {
    use std::fs;

    use serde::de::DeserializeOwned;
    use serde_json::Value;

    use super::*;

    const CONTRACT_FIXTURE: &str =
        include_str!("../../../src/test/fixtures/character-library.v1.json");

    #[derive(Clone)]
    struct FixedPicker(Option<PathBuf>);

    impl CharacterModelPicker for FixedPicker {
        fn pick_model_file(&self) -> CharacterPickerFuture<'_> {
            let selected = self.0.clone();
            Box::pin(async move { selected })
        }
    }

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("character-service-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&path).expect("test directory");
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn reviewed_hiyori_source() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources/characters/builtin-hiyori/runtime")
            .join("hiyori_pro_t11.model3.json")
    }

    fn asset_request(
        preview: &CharacterPreviewSession,
        asset_id: String,
        expected_mime: &str,
    ) -> CharacterAssetRequest {
        CharacterAssetRequest {
            pack_id: preview.pack_id.clone(),
            asset_id,
            manifest_hash: preview.manifest_hash.clone(),
            expected_mime: expected_mime.to_owned(),
            preview_token: Some(preview.preview_token.clone()),
        }
    }

    fn attestation(
        preview: &CharacterPreviewSession,
        renderer_nonce: &str,
    ) -> CharacterPreviewAttestationRequest {
        let thumbnail_png = trusted_frame_png();
        CharacterPreviewAttestationRequest {
            preview_token: preview.preview_token.clone(),
            preview_nonce: preview.preview_nonce.clone(),
            renderer_nonce: renderer_nonce.to_owned(),
            generation: preview.generation,
            manifest_hash: preview.manifest_hash.clone(),
            frame_count: 1,
            non_transparent_samples: 16,
            signature: "deadbeef".to_owned(),
            texture_decode_count: preview.manifest.inventory.texture_count,
            state_cue_observed: true,
            webgl_error: 0,
            parameter_count: 70,
            part_count: 24,
            drawable_count: 134,
            thumbnail_sha256: hex::encode(Sha256::digest(&thumbnail_png)),
            thumbnail_png,
        }
    }

    fn trusted_frame_png() -> Vec<u8> {
        let mut bytes = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut bytes, 1, 1);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder.write_header().expect("thumbnail header");
            writer
                .write_image_data(&[255, 128, 64, 255])
                .expect("thumbnail pixels");
        }
        bytes
    }

    fn assert_fixture_contract<T>(fixture: &Value, key: &str)
    where
        T: DeserializeOwned + Serialize,
    {
        let expected = fixture.get(key).unwrap_or_else(|| panic!("missing {key}"));
        let typed: T = serde_json::from_value(expected.clone())
            .unwrap_or_else(|error| panic!("deserialize {key}: {error}"));
        assert_eq!(
            serde_json::to_value(typed).unwrap_or_else(|error| panic!("serialize {key}: {error}")),
            *expected
        );
    }

    #[test]
    fn random_preview_generation_is_nonzero() {
        for _ in 0..1_000 {
            assert!((1..=MAX_JS_SAFE_INTEGER).contains(&random_generation()));
        }
    }

    #[test]
    fn builtin_directory_resolves_source_tree_for_tests() {
        let resolved = resolve_builtin_directory(Path::new("/missing"));
        assert!(resolved.join(BUILTIN_MANIFEST_FILE).is_file());
    }

    #[test]
    fn shared_typescript_fixture_round_trips_every_native_contract() {
        let fixture: Value = serde_json::from_str(CONTRACT_FIXTURE).expect("contract fixture");
        assert_eq!(
            fixture.get("schemaVersion").and_then(Value::as_u64),
            Some(u64::from(CHARACTER_SCHEMA_VERSION))
        );
        assert_eq!(
            fixture.get("generationBoundary").and_then(Value::as_u64),
            Some(MAX_JS_SAFE_INTEGER)
        );
        assert_eq!(
            fixture.get("generationOverflow").and_then(Value::as_u64),
            Some(MAX_JS_SAFE_INTEGER + 1)
        );
        assert_fixture_contract::<CharacterLibraryRequest>(&fixture, "libraryRequest");
        assert_fixture_contract::<CharacterAssetRequest>(&fixture, "assetRequest");
        assert_fixture_contract::<CharacterPreviewAttestationRequest>(
            &fixture,
            "attestationRequest",
        );
        assert_fixture_contract::<CharacterPreviewAttestationResponse>(
            &fixture,
            "attestationResponse",
        );
        assert_fixture_contract::<CharacterConfirmImportRequest>(&fixture, "confirmRequest");
        assert_fixture_contract::<CharacterCancelImportRequest>(&fixture, "cancelRequest");
        assert_fixture_contract::<CharacterSelectRequest>(&fixture, "selectRequest");
        assert_fixture_contract::<CharacterDeleteRequest>(&fixture, "deleteRequest");
        assert_fixture_contract::<CharacterImportResponse>(&fixture, "importResponse");
        assert_fixture_contract::<CharacterImportResponse>(&fixture, "canceledImportResponse");
        assert_fixture_contract::<CharacterLibrarySnapshot>(&fixture, "librarySnapshot");
        assert_fixture_contract::<super::super::error::CharacterCommandError>(&fixture, "error");
        let preview: CharacterImportResponse =
            serde_json::from_value(fixture["importResponse"].clone()).expect("preview fixture");
        preview
            .preview
            .expect("selected fixture")
            .manifest
            .validate("fixture")
            .expect("semantically valid manifest fixture");
    }

    #[tokio::test]
    async fn import_attestation_publish_restart_and_delete_are_bound_end_to_end() {
        let app_data = TestDirectory::new();
        let storage = CharacterStorage::open(app_data.path()).expect("character storage");
        let service = CharacterService::new(
            storage.clone(),
            resolve_builtin_directory(Path::new("/missing")),
            Arc::new(FixedPicker(Some(reviewed_hiyori_source()))),
        );
        let workspace_id = "workspace-e2e".to_owned();

        let initial = service
            .library(CharacterLibraryRequest {
                workspace_id: workspace_id.clone(),
            })
            .await
            .expect("initial library");
        assert_eq!(initial.selected_pack_id, BUILTIN_HIYORI_PACK_ID);
        assert_eq!(initial.packs.len(), 1);

        let response = service
            .pick_import(CharacterLibraryRequest {
                workspace_id: workspace_id.clone(),
            })
            .await
            .expect("import pick");
        assert_eq!(response.outcome, CharacterImportOutcome::Selected);
        let preview = response.preview.expect("preview session");
        assert_eq!(preview.manifest.inventory.runtime_file_count, 17);
        assert_eq!(
            fs::read_dir(app_data.path().join("characters/quarantine"))
                .expect("quarantine directory")
                .count(),
            1
        );

        let moc = preview
            .manifest
            .files
            .iter()
            .find(|asset| asset.role == super::super::manifest::CharacterAssetRole::Moc)
            .expect("moc asset");
        let request = asset_request(&preview, moc.asset_id.clone(), moc.role.mime());
        let bytes = service
            .read_asset("main", request.clone())
            .await
            .expect("quarantined moc bytes");
        assert_eq!(bytes.len() as u64, moc.bytes);
        assert_eq!(&bytes[..4], b"MOC3");

        let asset_path = app_data
            .path()
            .join("characters/quarantine")
            .join(format!("{}.tmp", preview.preview_token))
            .join(&moc.asset_id);
        let mut tampered = bytes.clone();
        let last = tampered.last_mut().expect("moc contents");
        *last ^= 0xff;
        fs::write(&asset_path, &tampered).expect("tamper quarantined bytes");
        assert_eq!(
            service
                .read_asset("main", request.clone())
                .await
                .expect_err("asset hash gate")
                .code,
            "CHARACTER-ASSET-HASH-MISMATCH"
        );
        fs::write(&asset_path, &bytes).expect("restore quarantined bytes");

        let mut invalid = request.clone();
        invalid.asset_id = "not-allowlisted.moc3".to_owned();
        assert_eq!(
            service
                .read_asset("main", invalid)
                .await
                .expect_err("allowlist gate")
                .code,
            "CHARACTER-ASSET-NOT-ALLOWLISTED"
        );
        let mut invalid = request.clone();
        invalid.manifest_hash = "0".repeat(64);
        assert_eq!(
            service
                .read_asset("main", invalid)
                .await
                .expect_err("manifest binding")
                .code,
            "CHARACTER-PREVIEW-IDENTITY"
        );
        let mut invalid = request.clone();
        invalid.expected_mime = "application/json".to_owned();
        assert_eq!(
            service
                .read_asset("main", invalid)
                .await
                .expect_err("mime gate")
                .code,
            "CHARACTER-ASSET-MIME-MISMATCH"
        );
        assert_eq!(
            service
                .read_asset("preview-window", request)
                .await
                .expect_err("window capability gate")
                .code,
            "CHARACTER-ASSET-REQUEST"
        );

        let renderer_nonce = uuid::Uuid::new_v4().to_string();
        let attestation = attestation(&preview, &renderer_nonce);
        let mut wrong_generation = attestation.clone();
        wrong_generation.generation = wrong_generation.generation.wrapping_add(1);
        assert_eq!(
            service
                .attest_preview(wrong_generation)
                .await
                .expect_err("generation binding")
                .code,
            "CHARACTER-PREVIEW-IDENTITY"
        );
        let accepted = service
            .attest_preview(attestation.clone())
            .await
            .expect("first-frame attestation");
        assert!(accepted.attested);
        assert_eq!(accepted.renderer_nonce, renderer_nonce);
        let retry = service
            .attest_preview(attestation.clone())
            .await
            .expect("identical attestation retry");
        assert_eq!(retry, accepted);
        let mut different_attestation = attestation;
        different_attestation.signature = "cafebabe".to_owned();
        assert_eq!(
            service
                .attest_preview(different_attestation)
                .await
                .expect_err("different attestation replay")
                .code,
            "CHARACTER-PREVIEW-ATTESTATION-REPLAY"
        );

        let published = service
            .confirm_import(CharacterConfirmImportRequest {
                workspace_id: workspace_id.clone(),
                preview_token: preview.preview_token.clone(),
                preview_nonce: preview.preview_nonce.clone(),
                renderer_nonce: renderer_nonce.clone(),
                generation: preview.generation,
                manifest_hash: preview.manifest_hash.clone(),
                display_name: "Verified Hiyori".to_owned(),
            })
            .await
            .expect("atomic publish");
        assert_eq!(published.selected_pack_id, preview.pack_id);
        assert_eq!(published.packs.len(), 2);
        let custom = published
            .packs
            .iter()
            .find(|pack| pack.pack_id == preview.pack_id)
            .expect("published pack");
        assert_eq!(custom.display_name, "Verified Hiyori");
        assert_eq!(
            custom
                .manifest
                .as_ref()
                .expect("custom manifest")
                .compatibility
                .expected_drawables,
            Some(134)
        );
        assert_eq!(
            fs::read_dir(app_data.path().join("characters/quarantine"))
                .expect("quarantine directory")
                .count(),
            0
        );
        assert_eq!(
            service
                .confirm_import(CharacterConfirmImportRequest {
                    workspace_id: workspace_id.clone(),
                    preview_token: preview.preview_token.clone(),
                    preview_nonce: preview.preview_nonce.clone(),
                    renderer_nonce,
                    generation: preview.generation,
                    manifest_hash: preview.manifest_hash.clone(),
                    display_name: "Replay".to_owned(),
                })
                .await
                .expect_err("confirm replay")
                .code,
            "CHARACTER-PREVIEW-EXPIRED"
        );

        let restarted = CharacterService::new(
            storage,
            resolve_builtin_directory(Path::new("/missing")),
            Arc::new(FixedPicker(None)),
        );
        let persisted = restarted
            .library(CharacterLibraryRequest {
                workspace_id: workspace_id.clone(),
            })
            .await
            .expect("restart library");
        assert_eq!(persisted.selected_pack_id, preview.pack_id);
        let persisted_custom = persisted
            .packs
            .iter()
            .find(|pack| pack.pack_id == preview.pack_id)
            .expect("persisted pack");
        let trusted_frame = persisted_custom
            .manifest
            .as_ref()
            .and_then(|manifest| manifest.trusted_frame.as_ref())
            .expect("persisted trusted frame");
        let trusted_frame_request = CharacterAssetRequest {
            pack_id: preview.pack_id.clone(),
            asset_id: trusted_frame.asset_id.clone(),
            manifest_hash: persisted_custom.manifest_hash.clone(),
            expected_mime: "image/png".to_owned(),
            preview_token: None,
        };
        let trusted_frame_bytes = restarted
            .read_asset("main", trusted_frame_request.clone())
            .await
            .expect("opaque trusted frame read");
        assert_eq!(
            hex::encode(Sha256::digest(&trusted_frame_bytes)),
            trusted_frame.sha256
        );
        let published_directory = app_data
            .path()
            .join("characters/library")
            .join(preview.pack_id.strip_prefix("custom:").expect("custom id"));
        let trusted_frame_path = published_directory.join(&trusted_frame.asset_id);
        assert!(trusted_frame_path.is_file());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            fs::set_permissions(&trusted_frame_path, fs::Permissions::from_mode(0o600))
                .expect("allow trusted frame failure injection");
        }
        let mut tampered_frame = trusted_frame_bytes.clone();
        let last = tampered_frame.last_mut().expect("trusted frame bytes");
        *last ^= 0xff;
        fs::write(&trusted_frame_path, &tampered_frame).expect("tamper trusted frame");
        assert_eq!(
            restarted
                .read_asset("main", trusted_frame_request.clone())
                .await
                .expect_err("tampered trusted frame must fail closed")
                .code,
            "CHARACTER-ASSET-HASH-MISMATCH"
        );
        fs::write(&trusted_frame_path, &trusted_frame_bytes).expect("restore trusted frame");
        fs::remove_file(&trusted_frame_path).expect("remove trusted frame");
        assert_eq!(
            restarted
                .read_asset("main", trusted_frame_request)
                .await
                .expect_err("missing trusted frame must fail closed")
                .code,
            "CHARACTER-ASSET-OPEN"
        );
        fs::write(&trusted_frame_path, &trusted_frame_bytes).expect("restore missing frame");
        let published_request = CharacterAssetRequest {
            pack_id: preview.pack_id.clone(),
            asset_id: moc.asset_id.clone(),
            manifest_hash: persisted_custom.manifest_hash.clone(),
            expected_mime: moc.role.mime().to_owned(),
            preview_token: None,
        };
        assert_eq!(
            restarted
                .read_asset("main", published_request)
                .await
                .expect("published binary asset")
                .len() as u64,
            moc.bytes
        );
        assert_eq!(
            restarted
                .delete_pack(CharacterDeleteRequest {
                    workspace_id: workspace_id.clone(),
                    pack_id: preview.pack_id.clone(),
                })
                .await
                .expect_err("active pack deletion")
                .code,
            "CHARACTER-ACTIVE-DELETE-DENIED"
        );

        restarted
            .select_pack(CharacterSelectRequest {
                workspace_id: workspace_id.clone(),
                pack_id: BUILTIN_HIYORI_PACK_ID.to_owned(),
            })
            .await
            .expect("select builtin");
        let deleted = restarted
            .delete_pack(CharacterDeleteRequest {
                workspace_id,
                pack_id: preview.pack_id,
            })
            .await
            .expect("delete inactive pack");
        assert_eq!(deleted.packs.len(), 1);
        assert_eq!(deleted.selected_pack_id, BUILTIN_HIYORI_PACK_ID);
        assert!(!published_directory.exists());
    }

    #[tokio::test]
    async fn trusted_frame_attestation_rejects_untrusted_png_bytes() {
        let app_data = TestDirectory::new();
        let service = CharacterService::new(
            CharacterStorage::open(app_data.path()).expect("character storage"),
            resolve_builtin_directory(Path::new("/missing")),
            Arc::new(FixedPicker(Some(reviewed_hiyori_source()))),
        );
        let preview = service
            .pick_import(CharacterLibraryRequest {
                workspace_id: "workspace-frame-validation".to_owned(),
            })
            .await
            .expect("import pick")
            .preview
            .expect("preview session");
        let renderer_nonce = uuid::Uuid::new_v4().to_string();

        let mut oversized = attestation(&preview, &renderer_nonce);
        oversized.thumbnail_png =
            vec![0; super::super::manifest::MAX_TRUSTED_FRAME_BYTES as usize + 1];
        oversized.thumbnail_sha256 = hex::encode(Sha256::digest(&oversized.thumbnail_png));
        assert_eq!(
            service
                .attest_preview(oversized)
                .await
                .expect_err("oversized frame")
                .code,
            "CHARACTER-TRUSTED-FRAME-INTEGRITY"
        );

        let mut mismatched = attestation(&preview, &renderer_nonce);
        mismatched.thumbnail_sha256 = "0".repeat(64);
        assert_eq!(
            service
                .attest_preview(mismatched)
                .await
                .expect_err("mismatched frame hash")
                .code,
            "CHARACTER-TRUSTED-FRAME-INTEGRITY"
        );

        let mut malformed = attestation(&preview, &renderer_nonce);
        malformed.thumbnail_png = b"not a png".to_vec();
        malformed.thumbnail_sha256 = hex::encode(Sha256::digest(&malformed.thumbnail_png));
        assert_eq!(
            service
                .attest_preview(malformed)
                .await
                .expect_err("malformed frame")
                .code,
            "CHARACTER-PNG-DECODE"
        );
    }

    #[tokio::test]
    async fn picker_cancel_and_preview_cancel_leave_no_library_mutation() {
        let app_data = TestDirectory::new();
        let storage = CharacterStorage::open(app_data.path()).expect("character storage");
        let workspace_id = "workspace-cancel".to_owned();
        let canceled_picker = CharacterService::new(
            storage.clone(),
            resolve_builtin_directory(Path::new("/missing")),
            Arc::new(FixedPicker(None)),
        );
        let canceled = canceled_picker
            .pick_import(CharacterLibraryRequest {
                workspace_id: workspace_id.clone(),
            })
            .await
            .expect("picker cancellation");
        assert_eq!(canceled.outcome, CharacterImportOutcome::Canceled);
        assert!(canceled.preview.is_none());

        let selected_picker = CharacterService::new(
            storage,
            resolve_builtin_directory(Path::new("/missing")),
            Arc::new(FixedPicker(Some(reviewed_hiyori_source()))),
        );
        let preview = selected_picker
            .pick_import(CharacterLibraryRequest {
                workspace_id: workspace_id.clone(),
            })
            .await
            .expect("selected folder")
            .preview
            .expect("preview session");
        selected_picker
            .cancel_import(CharacterCancelImportRequest {
                preview_token: preview.preview_token,
                preview_nonce: preview.preview_nonce,
                generation: preview.generation,
            })
            .await
            .expect("preview cancellation");
        assert_eq!(
            fs::read_dir(app_data.path().join("characters/quarantine"))
                .expect("quarantine directory")
                .count(),
            0
        );
        let library = selected_picker
            .library(CharacterLibraryRequest { workspace_id })
            .await
            .expect("unchanged library");
        assert_eq!(library.packs.len(), 1);
        assert_eq!(library.selected_pack_id, BUILTIN_HIYORI_PACK_ID);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn unavailable_trusted_frame_keeps_pack_attestation_selection_and_runtime_assets() {
        use std::os::unix::fs::PermissionsExt;

        for remove_frame in [false, true] {
            let app_data = TestDirectory::new();
            let storage = CharacterStorage::open(app_data.path()).expect("character storage");
            let workspace_id = format!(
                "workspace-frame-{}",
                if remove_frame { "missing" } else { "tampered" }
            );
            let service = CharacterService::new(
                storage.clone(),
                resolve_builtin_directory(Path::new("/missing")),
                Arc::new(FixedPicker(Some(reviewed_hiyori_source()))),
            );
            let preview = service
                .pick_import(CharacterLibraryRequest {
                    workspace_id: workspace_id.clone(),
                })
                .await
                .expect("import pick")
                .preview
                .expect("preview session");
            let renderer_nonce = uuid::Uuid::new_v4().to_string();
            service
                .attest_preview(attestation(&preview, &renderer_nonce))
                .await
                .expect("attestation");
            service
                .confirm_import(CharacterConfirmImportRequest {
                    workspace_id: workspace_id.clone(),
                    preview_token: preview.preview_token,
                    preview_nonce: preview.preview_nonce,
                    renderer_nonce,
                    generation: preview.generation,
                    manifest_hash: preview.manifest_hash,
                    display_name: "Frame unavailable after restart".to_owned(),
                })
                .await
                .expect("publish");
            service
                .select_pack(CharacterSelectRequest {
                    workspace_id: workspace_id.clone(),
                    pack_id: preview.pack_id.clone(),
                })
                .await
                .expect("active custom selection");

            let pack_directory = app_data
                .path()
                .join("characters/library")
                .join(preview.pack_id.strip_prefix("custom:").expect("custom id"));
            let trusted_frame_path =
                pack_directory.join(super::super::manifest::CHARACTER_TRUSTED_FRAME_ASSET_ID);
            if remove_frame {
                fs::remove_file(&trusted_frame_path).expect("remove published trusted frame");
            } else {
                fs::set_permissions(&trusted_frame_path, fs::Permissions::from_mode(0o600))
                    .expect("allow test corruption");
                let mut bytes = fs::read(&trusted_frame_path).expect("published trusted frame");
                let last = bytes.last_mut().expect("trusted frame contents");
                *last ^= 0xff;
                fs::write(&trusted_frame_path, bytes).expect("corrupt published trusted frame");
            }

            let restarted = CharacterService::new(
                storage,
                resolve_builtin_directory(Path::new("/missing")),
                Arc::new(FixedPicker(None)),
            );
            let retained = restarted
                .library(CharacterLibraryRequest {
                    workspace_id: workspace_id.clone(),
                })
                .await
                .expect("retained library");
            assert!(!retained.fallback_applied);
            assert_eq!(retained.selected_pack_id, preview.pack_id);
            assert_eq!(retained.packs.len(), 2);
            assert!(retained
                .diagnostics
                .iter()
                .any(|code| code == "CHARACTER-TRUSTED-FRAME-UNAVAILABLE"));
            assert!(!retained
                .diagnostics
                .iter()
                .any(|code| code == "CHARACTER-PACK-QUARANTINED"));
            assert_eq!(
                fs::read_dir(app_data.path().join("characters/broken"))
                    .expect("broken quarantine")
                    .count(),
                0
            );

            let custom = retained
                .packs
                .iter()
                .find(|pack| pack.pack_id == preview.pack_id)
                .expect("retained custom metadata");
            let manifest = custom.manifest.as_ref().expect("custom manifest");
            let trusted_frame = manifest.trusted_frame.as_ref().expect("attested frame");
            assert_eq!(
                custom.thumbnail_sha256.as_deref(),
                Some(trusted_frame.sha256.as_str())
            );
            assert_eq!(custom.selected_workspace_count, 1);
            let frame_error = restarted
                .read_asset(
                    "main",
                    CharacterAssetRequest {
                        pack_id: custom.pack_id.clone(),
                        asset_id: trusted_frame.asset_id.clone(),
                        manifest_hash: custom.manifest_hash.clone(),
                        expected_mime: "image/png".to_owned(),
                        preview_token: None,
                    },
                )
                .await
                .expect_err("unavailable frame must fail closed");
            assert_eq!(
                frame_error.code,
                if remove_frame {
                    "CHARACTER-ASSET-OPEN"
                } else {
                    "CHARACTER-ASSET-HASH-MISMATCH"
                }
            );

            let entrypoint = manifest
                .asset(&manifest.entrypoint)
                .expect("runtime entrypoint");
            let runtime_bytes = restarted
                .read_asset(
                    "main",
                    CharacterAssetRequest {
                        pack_id: custom.pack_id.clone(),
                        asset_id: entrypoint.asset_id.clone(),
                        manifest_hash: custom.manifest_hash.clone(),
                        expected_mime: entrypoint.role.mime().to_owned(),
                        preview_token: None,
                    },
                )
                .await
                .expect("runtime asset remains readable");
            assert_eq!(runtime_bytes.len() as u64, entrypoint.bytes);

            let persisted = restarted
                .library(CharacterLibraryRequest { workspace_id })
                .await
                .expect("persisted selection");
            assert!(!persisted.fallback_applied);
            assert_eq!(persisted.selected_pack_id, preview.pack_id);
        }
    }
}
