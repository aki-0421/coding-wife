use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, Instant};

use chrono::{SecondsFormat, Utc};
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;

use super::error::{character_error, CharacterResult};
use super::manifest::{
    is_sha256, is_valid_cue_id, CharacterPackManifest, BUILTIN_HIYORI_PACK_ID,
    CHARACTER_SCHEMA_VERSION,
};
use super::semantic_mapping::{
    SemanticAssignmentsV1, SemanticCueInventory, SemanticMappingStatus, SemanticMappingV1,
    MAX_MAPPING_VERSION, SEMANTIC_MAPPING_SCHEMA_VERSION,
};
use super::storage::{CharacterStateFile, CharacterStorage, StoredPack};
use super::validation::{snapshot_character_model, validate_trusted_frame_png};

const PREVIEW_TTL: Duration = Duration::from_secs(10 * 60);
const BUILTIN_MANIFEST_FILE: &str = "pack.json";
const MAX_JS_SAFE_INTEGER: u64 = (1_u64 << 53) - 1;
const LIVE2D_CORE_BYTES: &[u8] =
    include_bytes!("../../../public/vendor/live2d/core/live2dcubismcore.min.js");
const LIVE2D_CORE_SHA256: &str = "8741f739779b5d5210872bd3d7d99f0f1e56e6c87409e7d26d6bb4b80aa1ef47";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct CharacterReadinessProbe {
    pub schema_version: u16,
    pub core_available: bool,
    pub builtin_resources_available: bool,
    pub library_available: bool,
}

pub type CharacterPickerFuture<'a> = Pin<Box<dyn Future<Output = Option<PathBuf>> + Send + 'a>>;

pub trait CharacterModelPicker: Send + Sync {
    fn pick_model_file(&self) -> CharacterPickerFuture<'_>;
}

pub trait CharacterProjectResolver: Send + Sync {
    fn resolve_project(&self, workspace_id: &str) -> CharacterResult<Option<String>>;
    fn is_registered_project(&self, project_id: &str) -> CharacterResult<bool>;
}

struct WorkspaceIdentityProjectResolver;

impl CharacterProjectResolver for WorkspaceIdentityProjectResolver {
    fn resolve_project(&self, workspace_id: &str) -> CharacterResult<Option<String>> {
        Ok(Some(workspace_id.to_owned()))
    }

    fn is_registered_project(&self, project_id: &str) -> CharacterResult<bool> {
        Ok(valid_project_id(project_id))
    }
}

struct WorkspaceHistoryProjectResolver {
    database_path: PathBuf,
}

impl CharacterProjectResolver for WorkspaceHistoryProjectResolver {
    fn resolve_project(&self, workspace_id: &str) -> CharacterResult<Option<String>> {
        let connection = Connection::open_with_flags(
            &self.database_path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|_| character_error("character_library_get", "CHARACTER-PROJECT-LOOKUP", true))?;
        connection
            .query_row(
                "SELECT w.project_id FROM workspaces w
                 JOIN projects p ON p.id = w.project_id
                 WHERE w.id = ?1 AND p.registered = 1",
                [workspace_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|_| character_error("character_library_get", "CHARACTER-PROJECT-LOOKUP", true))
    }

    fn is_registered_project(&self, project_id: &str) -> CharacterResult<bool> {
        let connection = Connection::open_with_flags(
            &self.database_path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|_| character_error("character_library_get", "CHARACTER-PROJECT-LOOKUP", true))?;
        connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM projects WHERE id = ?1 AND registered = 1)",
                [project_id],
                |row| row.get::<_, i64>(0),
            )
            .map(|registered| registered != 0)
            .map_err(|_| character_error("character_library_get", "CHARACTER-PROJECT-LOOKUP", true))
    }
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
    pub selected_project_count: u32,
    pub deletable: bool,
    pub manifest: Option<CharacterPackManifest>,
    pub thumbnail_sha256: Option<String>,
    pub cue_inventory: SemanticCueInventory,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CharacterLibrarySnapshot {
    pub schema_version: u16,
    pub workspace_id: String,
    pub project_id: String,
    pub selected_pack_id: String,
    pub fallback_applied: bool,
    pub diagnostics: Vec<String>,
    pub packs: Vec<CharacterPackView>,
    pub semantic_mapping: SemanticMappingV1,
    pub semantic_mapping_status: SemanticMappingStatus,
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

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CharacterSemanticMappingSaveRequest {
    pub workspace_id: String,
    pub pack_id: String,
    pub manifest_hash: String,
    pub expected_mapping_version: u64,
    pub assignments: SemanticAssignmentsV1,
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
    project_resolver: Arc<dyn CharacterProjectResolver>,
    pending: Arc<Mutex<HashMap<String, PendingImport>>>,
    operations: Arc<Mutex<()>>,
}

#[derive(Clone)]
pub(crate) struct CharacterProjectSelectionRollback {
    state: CharacterStateFile,
}

impl CharacterService {
    pub fn production(storage: CharacterStorage, builtin_directory: PathBuf) -> Self {
        Self::production_with_operations(storage, builtin_directory, Arc::new(Mutex::new(())))
    }

    pub(crate) fn production_with_operations(
        storage: CharacterStorage,
        builtin_directory: PathBuf,
        operations: Arc<Mutex<()>>,
    ) -> Self {
        let project_resolver = Arc::new(WorkspaceHistoryProjectResolver {
            database_path: storage.workspace_history_path().to_path_buf(),
        });
        Self::new_with_project_resolver_and_operations(
            storage,
            builtin_directory,
            Arc::new(NativeCharacterModelPicker),
            project_resolver,
            operations,
        )
    }

    pub fn new(
        storage: CharacterStorage,
        builtin_directory: PathBuf,
        picker: Arc<dyn CharacterModelPicker>,
    ) -> Self {
        Self::new_with_project_resolver(
            storage,
            builtin_directory,
            picker,
            Arc::new(WorkspaceIdentityProjectResolver),
        )
    }

    pub fn new_with_project_resolver(
        storage: CharacterStorage,
        builtin_directory: PathBuf,
        picker: Arc<dyn CharacterModelPicker>,
        project_resolver: Arc<dyn CharacterProjectResolver>,
    ) -> Self {
        Self::new_with_project_resolver_and_operations(
            storage,
            builtin_directory,
            picker,
            project_resolver,
            Arc::new(Mutex::new(())),
        )
    }

    pub(crate) fn new_with_project_resolver_and_operations(
        storage: CharacterStorage,
        builtin_directory: PathBuf,
        picker: Arc<dyn CharacterModelPicker>,
        project_resolver: Arc<dyn CharacterProjectResolver>,
        operations: Arc<Mutex<()>>,
    ) -> Self {
        Self {
            storage,
            builtin_directory,
            picker,
            project_resolver,
            pending: Arc::new(Mutex::new(HashMap::new())),
            operations,
        }
    }

    fn resolve_project_id(&self, workspace_id: &str) -> CharacterResult<String> {
        self.project_resolver
            .resolve_project(workspace_id)?
            .filter(|project_id| valid_project_id(project_id))
            .ok_or_else(|| {
                character_error("character_library_get", "CHARACTER-PROJECT-NOT-FOUND", true)
            })
    }

    fn load_project_state(
        &self,
        custom_packs: &[StoredPack],
    ) -> CharacterResult<CharacterStateFile> {
        let valid_pack_ids = custom_packs
            .iter()
            .map(|pack| pack.manifest.pack_id.clone())
            .collect::<HashSet<_>>();
        let mut state = self
            .storage
            .load_or_migrate_state(&valid_pack_ids, |workspace_id| {
                self.project_resolver.resolve_project(workspace_id)
            })?;
        let projects = state.project_selections.keys().cloned().collect::<Vec<_>>();
        let mut changed = false;
        for project_id in projects {
            if !self.project_resolver.is_registered_project(&project_id)? {
                changed |= state.remove_project(&project_id);
            }
        }
        if changed {
            self.storage.save_state(&state)?;
        }
        Ok(state)
    }

    pub(crate) fn prepare_project_id_unregistration(
        &self,
        project_id: &str,
    ) -> CharacterResult<Option<CharacterProjectSelectionRollback>> {
        if !valid_project_id(project_id) {
            return Err(character_error(
                "character_library_unregister_project",
                "CHARACTER-PROJECT-NOT-FOUND",
                true,
            ));
        }
        let (custom_packs, _) = self.storage.load_custom_packs()?;
        let state = self.load_project_state(&custom_packs)?;
        let mut updated = state.clone();
        if !updated.remove_project(project_id) {
            return Ok(None);
        }
        self.storage.save_state(&updated)?;
        Ok(Some(CharacterProjectSelectionRollback { state }))
    }

    pub(crate) fn rollback_project_unregistration(
        &self,
        rollback: CharacterProjectSelectionRollback,
    ) -> CharacterResult<()> {
        self.storage.save_state(&rollback.state)
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

    pub(crate) fn readiness(&self) -> CharacterReadinessProbe {
        CharacterReadinessProbe {
            schema_version: CHARACTER_SCHEMA_VERSION,
            core_available: live2d_core_available(),
            builtin_resources_available: self.verify_builtin_resources().is_ok(),
            library_available: self.storage.verify_library_readiness().is_ok(),
        }
    }

    fn verify_builtin_resources(&self) -> CharacterResult<()> {
        let manifest_bytes = std::fs::read(self.builtin_directory.join(BUILTIN_MANIFEST_FILE))
            .map_err(|_| {
                character_error("character_readiness", "CHARACTER-BUILTIN-MANIFEST", false)
            })?;
        if manifest_bytes.len() > 1024 * 1024 {
            return Err(character_error(
                "character_readiness",
                "CHARACTER-BUILTIN-MANIFEST",
                false,
            ));
        }
        let value: serde_json::Value = serde_json::from_slice(&manifest_bytes).map_err(|_| {
            character_error("character_readiness", "CHARACTER-BUILTIN-MANIFEST", false)
        })?;
        if value
            .get("schemaVersion")
            .and_then(serde_json::Value::as_u64)
            != Some(u64::from(CHARACTER_SCHEMA_VERSION))
            || value.get("packId").and_then(serde_json::Value::as_str)
                != Some(BUILTIN_HIYORI_PACK_ID)
        {
            return Err(character_error(
                "character_readiness",
                "CHARACTER-BUILTIN-SCHEMA",
                false,
            ));
        }
        let files = value
            .get("files")
            .and_then(serde_json::Value::as_array)
            .filter(|files| !files.is_empty())
            .ok_or_else(|| {
                character_error("character_readiness", "CHARACTER-BUILTIN-MANIFEST", false)
            })?;
        for asset in files {
            let asset_id = asset
                .get("assetId")
                .and_then(serde_json::Value::as_str)
                .filter(|asset_id| {
                    !asset_id.is_empty()
                        && std::path::Path::new(asset_id)
                            .components()
                            .all(|component| matches!(component, std::path::Component::Normal(_)))
                })
                .ok_or_else(|| {
                    character_error("character_readiness", "CHARACTER-BUILTIN-ASSET", false)
                })?;
            let expected_bytes = asset
                .get("bytes")
                .and_then(serde_json::Value::as_u64)
                .ok_or_else(|| {
                    character_error("character_readiness", "CHARACTER-BUILTIN-ASSET", false)
                })?;
            let expected_hash = asset
                .get("sha256")
                .and_then(serde_json::Value::as_str)
                .filter(|hash| is_sha256(hash))
                .ok_or_else(|| {
                    character_error("character_readiness", "CHARACTER-BUILTIN-ASSET", false)
                })?;
            let contents = std::fs::read(self.builtin_directory.join(asset_id)).map_err(|_| {
                character_error("character_readiness", "CHARACTER-BUILTIN-ASSET", false)
            })?;
            if contents.len() as u64 != expected_bytes
                || hex::encode(Sha256::digest(&contents)) != expected_hash
            {
                return Err(character_error(
                    "character_readiness",
                    "CHARACTER-BUILTIN-ASSET",
                    false,
                ));
            }
        }
        Ok(())
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
        let project_id = self.resolve_project_id(&request.workspace_id)?;
        let (custom_packs, _) = self.storage.load_custom_packs()?;
        let state = self.load_project_state(&custom_packs)?;
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
        self.storage.publish_and_replace_custom(
            &session.directory,
            &session.manifest,
            state,
            &project_id,
            current_timestamp(),
            &custom_packs,
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
        let project_id = self.resolve_project_id(&request.workspace_id)?;
        let (custom_packs, _) = self.storage.load_custom_packs()?;
        if request.pack_id != BUILTIN_HIYORI_PACK_ID {
            let pack = custom_packs
                .iter()
                .find(|pack| pack.manifest.pack_id == request.pack_id)
                .ok_or_else(|| {
                    character_error("character_select_pack", "CHARACTER-PACK-NOT-FOUND", true)
                })?;
            if pack.manifest.compatibility.expected_drawables.is_none() {
                return Err(character_error(
                    "character_select_pack",
                    "CHARACTER-PREVIEW-NOT-ATTESTED",
                    false,
                ));
            }
        }
        let mut state = self.load_project_state(&custom_packs)?;
        state.select(project_id, request.pack_id, current_timestamp());
        self.storage.save_state(&state)?;
        self.snapshot(&request.workspace_id)
    }

    pub async fn save_semantic_mapping(
        &self,
        request: CharacterSemanticMappingSaveRequest,
    ) -> CharacterResult<CharacterLibrarySnapshot> {
        validate_workspace_id(&request.workspace_id, "character_semantic_mapping_save")?;
        if request.expected_mapping_version > MAX_MAPPING_VERSION.saturating_sub(1) {
            return Err(character_error(
                "character_semantic_mapping_save",
                "CHARACTER-MAPPING-VERSION",
                false,
            ));
        }
        let _operation = self.operations.lock().await;
        let project_id = self.resolve_project_id(&request.workspace_id)?;
        let (custom_packs, _) = self.storage.load_custom_packs()?;
        let mut state = self.load_project_state(&custom_packs)?;
        if state.selected_for(&project_id) != request.pack_id {
            return Err(character_error(
                "character_semantic_mapping_save",
                "CHARACTER-MAPPING-STALE-PACK",
                true,
            ));
        }
        let pack = if request.pack_id == BUILTIN_HIYORI_PACK_ID {
            self.builtin_pack_view(&state)?
        } else {
            custom_packs
                .iter()
                .find(|pack| pack.manifest.pack_id == request.pack_id)
                .map(|pack| custom_pack_view(pack, &state))
                .ok_or_else(|| {
                    character_error(
                        "character_semantic_mapping_save",
                        "CHARACTER-PACK-NOT-FOUND",
                        true,
                    )
                })?
        };
        if pack.manifest_hash != request.manifest_hash {
            return Err(character_error(
                "character_semantic_mapping_save",
                "CHARACTER-MANIFEST-HASH-MISMATCH",
                false,
            ));
        }
        let current_version = state
            .semantic_mappings
            .get(&request.pack_id)
            .and_then(|value| serde_json::from_value::<SemanticMappingV1>(value.clone()).ok())
            .filter(|mapping| {
                mapping.pack_id == pack.pack_id
                    && mapping.manifest_hash == pack.manifest_hash
                    && mapping.valid_for(&pack.cue_inventory)
            })
            .map(|mapping| mapping.mapping_version)
            .unwrap_or(0);
        if current_version != request.expected_mapping_version {
            return Err(character_error(
                "character_semantic_mapping_save",
                "CHARACTER-MAPPING-CONFLICT",
                true,
            ));
        }
        let mapping = SemanticMappingV1 {
            schema_version: SEMANTIC_MAPPING_SCHEMA_VERSION,
            pack_id: request.pack_id.clone(),
            manifest_hash: request.manifest_hash,
            mapping_version: current_version + 1,
            assignments: request.assignments,
        };
        if !mapping.valid_for(&pack.cue_inventory) {
            return Err(character_error(
                "character_semantic_mapping_save",
                "CHARACTER-MAPPING-CUE",
                false,
            ));
        }
        let value = serde_json::to_value(mapping).map_err(|_| {
            character_error(
                "character_semantic_mapping_save",
                "CHARACTER-MAPPING-SERIALIZE",
                false,
            )
        })?;
        state.semantic_mappings.insert(request.pack_id, value);
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
        self.resolve_project_id(&request.workspace_id)?;
        let (custom_packs, _) = self.storage.load_custom_packs()?;
        let pack = custom_packs
            .iter()
            .find(|pack| pack.manifest.pack_id == request.pack_id)
            .ok_or_else(|| {
                character_error("character_delete_pack", "CHARACTER-PACK-NOT-FOUND", true)
            })?;
        let state = self.load_project_state(&custom_packs)?;
        self.storage
            .delete_custom_and_fallback(pack, state, current_timestamp())?;
        self.snapshot(&request.workspace_id)
    }

    fn snapshot(&self, workspace_id: &str) -> CharacterResult<CharacterLibrarySnapshot> {
        let project_id = self.resolve_project_id(workspace_id)?;
        let (custom_packs, mut diagnostics) = self.storage.load_custom_packs()?;
        let valid_ids = custom_packs
            .iter()
            .map(|pack| pack.manifest.pack_id.as_str())
            .collect::<Vec<_>>();
        let mut state = self.load_project_state(&custom_packs)?;
        let requested = state.selected_for(&project_id).to_owned();
        let fallback_applied = requested != BUILTIN_HIYORI_PACK_ID
            && !valid_ids.iter().any(|candidate| *candidate == requested);
        let selected_pack_id = if fallback_applied {
            diagnostics.push("CHARACTER-SELECTION-FALLBACK".to_owned());
            state.select(
                project_id.clone(),
                BUILTIN_HIYORI_PACK_ID.to_owned(),
                current_timestamp(),
            );
            self.storage.save_state(&state)?;
            BUILTIN_HIYORI_PACK_ID.to_owned()
        } else {
            if !state.project_selections.contains_key(&project_id) {
                state.select(project_id.clone(), requested.clone(), current_timestamp());
                self.storage.save_state(&state)?;
            }
            requested
        };
        let mut packs = vec![self.builtin_pack_view(&state)?];
        packs.extend(
            custom_packs
                .iter()
                .map(|pack| custom_pack_view(pack, &state)),
        );
        let selected_pack = packs
            .iter()
            .find(|pack| pack.pack_id == selected_pack_id)
            .ok_or_else(|| {
                character_error(
                    "character_library_get",
                    "CHARACTER-SELECTION-FALLBACK",
                    true,
                )
            })?;
        let (semantic_mapping, semantic_mapping_status) =
            semantic_mapping_view(&state, selected_pack);
        Ok(CharacterLibrarySnapshot {
            schema_version: CHARACTER_SCHEMA_VERSION,
            workspace_id: workspace_id.to_owned(),
            project_id,
            selected_pack_id,
            fallback_applied,
            diagnostics,
            packs,
            semantic_mapping,
            semantic_mapping_status,
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
        let cue_inventory = builtin_cue_inventory(&value);
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
            selected_project_count: state
                .project_selections
                .values()
                .filter(|selection| selection.pack_id == BUILTIN_HIYORI_PACK_ID)
                .count() as u32,
            deletable: false,
            manifest: None,
            thumbnail_sha256: None,
            cue_inventory,
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

fn live2d_core_available() -> bool {
    hex::encode(Sha256::digest(LIVE2D_CORE_BYTES)) == LIVE2D_CORE_SHA256
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
        selected_project_count: state
            .project_selections
            .values()
            .filter(|selection| selection.pack_id == pack.manifest.pack_id)
            .count() as u32,
        deletable: true,
        manifest: Some(pack.manifest.clone()),
        thumbnail_sha256: pack
            .manifest
            .trusted_frame
            .as_ref()
            .map(|frame| frame.sha256.clone()),
        cue_inventory: SemanticCueInventory {
            motions: pack
                .manifest
                .inventory
                .motion_groups
                .values()
                .flatten()
                .map(|cue| cue.cue_id.clone())
                .collect(),
            expressions: pack
                .manifest
                .inventory
                .expression_cues
                .iter()
                .map(|cue| cue.cue_id.clone())
                .collect(),
        },
    }
}

fn semantic_mapping_view(
    state: &CharacterStateFile,
    pack: &CharacterPackView,
) -> (SemanticMappingV1, SemanticMappingStatus) {
    let fallback = || SemanticMappingV1::neutral(pack.pack_id.clone(), pack.manifest_hash.clone());
    let Some(value) = state.semantic_mappings.get(&pack.pack_id) else {
        return (fallback(), SemanticMappingStatus::Default);
    };
    let Ok(mapping) = serde_json::from_value::<SemanticMappingV1>(value.clone()) else {
        return (fallback(), SemanticMappingStatus::Invalid);
    };
    if mapping.pack_id != pack.pack_id
        || mapping.manifest_hash != pack.manifest_hash
        || !mapping.valid_for(&pack.cue_inventory)
    {
        return (fallback(), SemanticMappingStatus::Invalid);
    }
    (mapping, SemanticMappingStatus::Saved)
}

fn builtin_cue_inventory(value: &serde_json::Value) -> SemanticCueInventory {
    let inventory = value
        .get("inventory")
        .and_then(serde_json::Value::as_object);
    let motions = inventory
        .and_then(|inventory| inventory.get("motionGroups"))
        .and_then(serde_json::Value::as_object)
        .into_iter()
        .flat_map(|groups| groups.values())
        .filter_map(serde_json::Value::as_array)
        .flatten()
        .filter_map(|cue| cue.get("cueId").and_then(serde_json::Value::as_str))
        .filter(|cue_id| is_valid_cue_id(cue_id))
        .map(str::to_owned)
        .collect();
    let expressions = inventory
        .and_then(|inventory| inventory.get("expressionCues"))
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|cue| cue.get("cueId").and_then(serde_json::Value::as_str))
        .filter(|cue_id| is_valid_cue_id(cue_id))
        .map(str::to_owned)
        .collect();
    SemanticCueInventory {
        motions,
        expressions,
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

fn valid_project_id(project_id: &str) -> bool {
    !project_id.is_empty()
        && project_id.len() <= 160
        && project_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_".contains(&byte))
}

fn current_timestamp() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
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
    use std::collections::BTreeMap;
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

    #[derive(Clone)]
    struct FixedProjectResolver(BTreeMap<String, String>);

    impl CharacterProjectResolver for FixedProjectResolver {
        fn resolve_project(&self, workspace_id: &str) -> CharacterResult<Option<String>> {
            Ok(self.0.get(workspace_id).cloned())
        }

        fn is_registered_project(&self, project_id: &str) -> CharacterResult<bool> {
            Ok(self.0.values().any(|candidate| candidate == project_id))
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

    fn write_invalid_motion_source(root: &Path) -> PathBuf {
        let mut motions = serde_json::Map::new();
        motions.insert(
            "https://example.test/Tap".to_owned(),
            serde_json::json!([{ "File": "tap.motion3.json" }]),
        );
        fs::write(
            root.join("test.model3.json"),
            serde_json::to_vec(&serde_json::json!({
                "Version": 3,
                "FileReferences": {
                    "Moc": "test.moc3",
                    "Textures": ["texture.png"],
                    "Motions": Value::Object(motions),
                },
            }))
            .expect("invalid motion model json"),
        )
        .expect("invalid motion model");
        fs::write(root.join("test.moc3"), b"MOC3\x03\x00\x00\x00payload").expect("moc");
        fs::write(root.join("tap.motion3.json"), b"{}").expect("motion");
        let mut png = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut png, 1, 1);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder.write_header().expect("png header");
            writer.write_image_data(&[255, 0, 0, 255]).expect("png");
        }
        fs::write(root.join("texture.png"), png).expect("texture");
        root.join("test.model3.json")
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
    fn workspace_history_resolver_prunes_unregistered_project_selections() {
        let app_data = TestDirectory::new();
        let storage = CharacterStorage::open(app_data.path()).expect("character storage");
        let connection = Connection::open(storage.workspace_history_path()).expect("history db");
        connection
            .execute_batch(
                "CREATE TABLE projects (id TEXT PRIMARY KEY, registered INTEGER NOT NULL);
                 CREATE TABLE workspaces (id TEXT PRIMARY KEY, project_id TEXT NOT NULL);
                 INSERT INTO projects (id, registered) VALUES
                   ('project-active', 1), ('project-inactive', 0);
                 INSERT INTO workspaces (id, project_id) VALUES
                   ('workspace-active', 'project-active'),
                   ('workspace-inactive', 'project-inactive');",
            )
            .expect("resolver fixture");
        let custom_pack_id = format!("custom:{}", uuid::Uuid::new_v4());
        let mut state = storage.load_state().expect("initial state");
        state.select(
            "project-active".to_owned(),
            custom_pack_id.clone(),
            current_timestamp(),
        );
        state.select(
            "project-inactive".to_owned(),
            custom_pack_id.clone(),
            current_timestamp(),
        );
        storage.save_state(&state).expect("selected state");
        let mut manifest = snapshot_character_model(
            &reviewed_hiyori_source(),
            custom_pack_id.clone(),
            current_timestamp(),
        )
        .expect("custom manifest")
        .manifest;
        manifest.compatibility.expected_drawables = Some(134);
        let pack = StoredPack {
            manifest,
            manifest_hash: "a".repeat(64),
            directory: app_data.path().join("unused-pack"),
        };
        let service = CharacterService::production(
            storage.clone(),
            resolve_builtin_directory(Path::new("/missing")),
        );

        assert_eq!(
            service
                .resolve_project_id("workspace-active")
                .expect("active project"),
            "project-active"
        );
        assert_eq!(
            service
                .resolve_project_id("workspace-inactive")
                .expect_err("inactive project must not resolve")
                .code,
            "CHARACTER-PROJECT-NOT-FOUND"
        );
        let active_state = service
            .load_project_state(std::slice::from_ref(&pack))
            .expect("pruned active state");
        assert_eq!(active_state.project_selections.len(), 1);
        assert!(active_state
            .project_selections
            .contains_key("project-active"));
        let active_view = custom_pack_view(&pack, &active_state);
        assert_eq!(active_view.selected_project_count, 1);
        assert!(active_view.deletable);

        connection
            .execute(
                "UPDATE projects SET registered = 0 WHERE id = 'project-active'",
                [],
            )
            .expect("unregister active project");
        let restarted = CharacterService::production(
            storage.clone(),
            resolve_builtin_directory(Path::new("/missing")),
        );
        let restarted_state = restarted
            .load_project_state(std::slice::from_ref(&pack))
            .expect("restart prunes orphan selection");
        assert!(restarted_state.project_selections.is_empty());
        let inactive_view = custom_pack_view(&pack, &restarted_state);
        assert_eq!(inactive_view.selected_project_count, 0);
        assert!(inactive_view.deletable);
        assert!(storage
            .load_state()
            .expect("persisted pruned state")
            .project_selections
            .is_empty());
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
        assert_fixture_contract::<CharacterSemanticMappingSaveRequest>(
            &fixture,
            "semanticMappingSaveRequest",
        );
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
        let workspace_id = "workspace-e2e".to_owned();
        let sibling_workspace_id = "workspace-e2e-sibling".to_owned();
        let project_resolver: Arc<dyn CharacterProjectResolver> =
            Arc::new(FixedProjectResolver(BTreeMap::from([
                (workspace_id.clone(), "project-e2e".to_owned()),
                (sibling_workspace_id.clone(), "project-e2e".to_owned()),
            ])));
        let service = CharacterService::new_with_project_resolver(
            storage.clone(),
            resolve_builtin_directory(Path::new("/missing")),
            Arc::new(FixedPicker(Some(reviewed_hiyori_source()))),
            project_resolver.clone(),
        );

        let initial = service
            .library(CharacterLibraryRequest {
                workspace_id: workspace_id.clone(),
            })
            .await
            .expect("initial library");
        assert_eq!(initial.selected_pack_id, BUILTIN_HIYORI_PACK_ID);
        assert_eq!(initial.project_id, "project-e2e");
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
        let sibling = service
            .library(CharacterLibraryRequest {
                workspace_id: sibling_workspace_id.clone(),
            })
            .await
            .expect("shared project selection");
        assert_eq!(sibling.project_id, published.project_id);
        assert_eq!(sibling.selected_pack_id, preview.pack_id);
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

        let restarted = CharacterService::new_with_project_resolver(
            storage,
            resolve_builtin_directory(Path::new("/missing")),
            Arc::new(FixedPicker(None)),
            project_resolver,
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
        let deleted = restarted
            .delete_pack(CharacterDeleteRequest {
                workspace_id: workspace_id.clone(),
                pack_id: preview.pack_id,
            })
            .await
            .expect("delete active custom slot");
        assert_eq!(deleted.packs.len(), 1);
        assert_eq!(deleted.selected_pack_id, BUILTIN_HIYORI_PACK_ID);
        assert_eq!(
            restarted
                .library(CharacterLibraryRequest {
                    workspace_id: sibling_workspace_id,
                })
                .await
                .expect("shared bundled fallback")
                .selected_pack_id,
            BUILTIN_HIYORI_PACK_ID
        );
        assert!(!published_directory.exists());
    }

    #[tokio::test]
    async fn replacing_custom_slot_migrates_every_project_and_removes_the_old_pack() {
        let app_data = TestDirectory::new();
        let storage = CharacterStorage::open(app_data.path()).expect("character storage");
        let workspace_a = "workspace-slot-a".to_owned();
        let workspace_b = "workspace-slot-b".to_owned();
        let resolver: Arc<dyn CharacterProjectResolver> =
            Arc::new(FixedProjectResolver(BTreeMap::from([
                (workspace_a.clone(), "project-slot-a".to_owned()),
                (workspace_b.clone(), "project-slot-b".to_owned()),
            ])));
        let service = CharacterService::new_with_project_resolver(
            storage,
            resolve_builtin_directory(Path::new("/missing")),
            Arc::new(FixedPicker(Some(reviewed_hiyori_source()))),
            resolver,
        );
        for workspace_id in [&workspace_a, &workspace_b] {
            service
                .library(CharacterLibraryRequest {
                    workspace_id: (*workspace_id).clone(),
                })
                .await
                .expect("initialize project selection");
        }

        let first = service
            .pick_import(CharacterLibraryRequest {
                workspace_id: workspace_a.clone(),
            })
            .await
            .expect("first import")
            .preview
            .expect("first preview");
        let first_renderer_nonce = uuid::Uuid::new_v4().to_string();
        service
            .attest_preview(attestation(&first, &first_renderer_nonce))
            .await
            .expect("first attestation");
        service
            .confirm_import(CharacterConfirmImportRequest {
                workspace_id: workspace_a.clone(),
                preview_token: first.preview_token.clone(),
                preview_nonce: first.preview_nonce.clone(),
                renderer_nonce: first_renderer_nonce,
                generation: first.generation,
                manifest_hash: first.manifest_hash.clone(),
                display_name: "First custom".to_owned(),
            })
            .await
            .expect("first publish");
        service
            .select_pack(CharacterSelectRequest {
                workspace_id: workspace_b.clone(),
                pack_id: first.pack_id.clone(),
            })
            .await
            .expect("second project selects first custom");

        let second = service
            .pick_import(CharacterLibraryRequest {
                workspace_id: workspace_a.clone(),
            })
            .await
            .expect("replacement import")
            .preview
            .expect("replacement preview");
        assert_ne!(first.pack_id, second.pack_id);
        let second_renderer_nonce = uuid::Uuid::new_v4().to_string();
        service
            .attest_preview(attestation(&second, &second_renderer_nonce))
            .await
            .expect("replacement attestation");
        let replaced = service
            .confirm_import(CharacterConfirmImportRequest {
                workspace_id: workspace_a.clone(),
                preview_token: second.preview_token.clone(),
                preview_nonce: second.preview_nonce.clone(),
                renderer_nonce: second_renderer_nonce,
                generation: second.generation,
                manifest_hash: second.manifest_hash.clone(),
                display_name: "Replacement custom".to_owned(),
            })
            .await
            .expect("atomic slot replacement");

        assert_eq!(replaced.packs.len(), 2);
        assert_eq!(replaced.selected_pack_id, second.pack_id);
        assert!(replaced
            .packs
            .iter()
            .all(|pack| pack.pack_id != first.pack_id));
        let replacement = replaced
            .packs
            .iter()
            .find(|pack| pack.kind == CharacterPackKind::Custom)
            .expect("one custom slot");
        assert_eq!(replacement.pack_id, second.pack_id);
        assert_eq!(replacement.selected_project_count, 2);
        assert!(replacement.deletable);
        assert_eq!(
            service
                .library(CharacterLibraryRequest {
                    workspace_id: workspace_b,
                })
                .await
                .expect("migrated second project")
                .selected_pack_id,
            second.pack_id
        );
        assert_eq!(
            fs::read_dir(app_data.path().join("characters/library"))
                .expect("single custom directory")
                .count(),
            1
        );
        assert!(!app_data
            .path()
            .join("characters/library")
            .join(first.pack_id.strip_prefix("custom:").expect("custom id"))
            .exists());
    }

    #[tokio::test]
    async fn semantic_mapping_persists_verified_cues_and_invalid_data_falls_back_whole() {
        use super::super::semantic_mapping::SemanticCueSelection;

        let app_data = TestDirectory::new();
        let storage = CharacterStorage::open(app_data.path()).expect("character storage");
        let service = CharacterService::new(
            storage.clone(),
            resolve_builtin_directory(Path::new("/missing")),
            Arc::new(FixedPicker(None)),
        );
        let workspace_id = "workspace-mapping".to_owned();
        let initial = service
            .library(CharacterLibraryRequest {
                workspace_id: workspace_id.clone(),
            })
            .await
            .expect("initial mapping");
        assert_eq!(
            initial.semantic_mapping_status,
            SemanticMappingStatus::Default
        );
        assert_eq!(initial.semantic_mapping.mapping_version, 0);
        assert_eq!(initial.packs[0].expression_count, 0);
        let assignments = SemanticAssignmentsV1 {
            neutral: SemanticCueSelection::Motion {
                cue_id: "Idle[0]".to_owned(),
            },
            thinking: SemanticCueSelection::Motion {
                cue_id: "Flick[0]".to_owned(),
            },
            working: SemanticCueSelection::Motion {
                cue_id: "FlickDown[0]".to_owned(),
            },
            asking: SemanticCueSelection::Motion {
                cue_id: "Tap[0]".to_owned(),
            },
            success: SemanticCueSelection::Motion {
                cue_id: "FlickUp[0]".to_owned(),
            },
            warning: SemanticCueSelection::Motion {
                cue_id: "Flick@Body[0]".to_owned(),
            },
            error: SemanticCueSelection::Motion {
                cue_id: "Tap@Body[0]".to_owned(),
            },
        };
        let saved = service
            .save_semantic_mapping(CharacterSemanticMappingSaveRequest {
                workspace_id: workspace_id.clone(),
                pack_id: initial.selected_pack_id,
                manifest_hash: initial.packs[0].manifest_hash.clone(),
                expected_mapping_version: 0,
                assignments: assignments.clone(),
            })
            .await
            .expect("saved mapping");
        assert_eq!(saved.semantic_mapping_status, SemanticMappingStatus::Saved);
        assert_eq!(saved.semantic_mapping.mapping_version, 1);
        assert_eq!(saved.semantic_mapping.assignments, assignments);
        let mut invalid_assignments = assignments.clone();
        invalid_assignments.error = SemanticCueSelection::Motion {
            cue_id: "Arbitrary[0]".to_owned(),
        };
        assert_eq!(
            service
                .save_semantic_mapping(CharacterSemanticMappingSaveRequest {
                    workspace_id: workspace_id.clone(),
                    pack_id: saved.selected_pack_id.clone(),
                    manifest_hash: saved.semantic_mapping.manifest_hash.clone(),
                    expected_mapping_version: 1,
                    assignments: invalid_assignments,
                })
                .await
                .expect_err("inventory-external cue")
                .code,
            "CHARACTER-MAPPING-CUE"
        );

        let restarted = CharacterService::new(
            storage.clone(),
            resolve_builtin_directory(Path::new("/missing")),
            Arc::new(FixedPicker(None)),
        );
        assert_eq!(
            restarted
                .library(CharacterLibraryRequest {
                    workspace_id: workspace_id.clone(),
                })
                .await
                .expect("restart mapping")
                .semantic_mapping,
            saved.semantic_mapping
        );

        let mut state = storage.load_state().expect("mapping state");
        state.semantic_mappings.insert(
            BUILTIN_HIYORI_PACK_ID.to_owned(),
            serde_json::json!({
                "schemaVersion": 99,
                "packId": BUILTIN_HIYORI_PACK_ID,
                "manifestHash": saved.semantic_mapping.manifest_hash,
                "mappingVersion": 2,
                "assignments": {}
            }),
        );
        storage.save_state(&state).expect("invalid mapping fixture");
        let invalid = restarted
            .library(CharacterLibraryRequest { workspace_id })
            .await
            .expect("invalid mapping recovery");
        assert_eq!(
            invalid.semantic_mapping_status,
            SemanticMappingStatus::Invalid
        );
        assert_eq!(invalid.semantic_mapping.mapping_version, 0);
        assert_eq!(
            invalid.semantic_mapping.assignments,
            SemanticAssignmentsV1::neutral()
        );
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

    #[tokio::test]
    async fn invalid_picker_cue_leaves_no_preview_session_or_quarantine() {
        let app_data = TestDirectory::new();
        let source = TestDirectory::new();
        let selected = write_invalid_motion_source(source.path());
        let service = CharacterService::new(
            CharacterStorage::open(app_data.path()).expect("character storage"),
            resolve_builtin_directory(Path::new("/missing")),
            Arc::new(FixedPicker(Some(selected))),
        );

        let error = service
            .pick_import(CharacterLibraryRequest {
                workspace_id: "workspace-invalid-cue".to_owned(),
            })
            .await
            .expect_err("invalid cue must fail before preview");

        assert_eq!(error.code, "CHARACTER-MOTION-SCHEMA");
        assert!(service.pending.lock().await.is_empty());
        assert_eq!(
            fs::read_dir(app_data.path().join("characters/quarantine"))
                .expect("quarantine directory")
                .count(),
            0
        );
        let library = service
            .library(CharacterLibraryRequest {
                workspace_id: "workspace-invalid-cue".to_owned(),
            })
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
            assert_eq!(custom.selected_project_count, 1);
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
