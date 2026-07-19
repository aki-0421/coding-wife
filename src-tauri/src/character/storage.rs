use std::collections::{BTreeMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{ErrorKind, Read, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

use super::error::{character_error, CharacterResult};
use super::manifest::{
    is_opaque_pack_id, is_safe_asset_id, is_sha256, CharacterPackManifest, CharacterTrustedFrame,
    BUILTIN_HIYORI_PACK_ID, CHARACTER_SCHEMA_VERSION,
};
use super::validation::{verify_source_unchanged, ValidatedCharacterSnapshot};

const STATE_FILE_NAME: &str = "state.json";
const MANIFEST_FILE_NAME: &str = "pack.json";
pub const CHARACTER_STATE_SCHEMA_VERSION: u16 = 2;
const LEGACY_SELECTION_TIMESTAMP: &str = "1970-01-01T00:00:00.000Z";

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ProjectCharacterSelection {
    pub pack_id: String,
    pub selection_updated_at: String,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CharacterStateFile {
    pub schema_version: u16,
    pub project_selections: BTreeMap<String, ProjectCharacterSelection>,
    #[serde(default)]
    pub semantic_mappings: BTreeMap<String, serde_json::Value>,
}

impl CharacterStateFile {
    fn empty() -> Self {
        Self {
            schema_version: CHARACTER_STATE_SCHEMA_VERSION,
            project_selections: BTreeMap::new(),
            semantic_mappings: BTreeMap::new(),
        }
    }

    pub fn selected_for(&self, project_id: &str) -> &str {
        self.project_selections
            .get(project_id)
            .map(|selection| selection.pack_id.as_str())
            .unwrap_or(BUILTIN_HIYORI_PACK_ID)
    }

    pub fn select(&mut self, project_id: String, pack_id: String, updated_at: String) {
        self.project_selections.insert(
            project_id,
            ProjectCharacterSelection {
                pack_id,
                selection_updated_at: updated_at,
            },
        );
    }

    pub fn remove_project(&mut self, project_id: &str) -> bool {
        self.project_selections.remove(project_id).is_some()
    }

    fn replace_custom_packs(
        &mut self,
        replaced_pack_ids: &HashSet<String>,
        replacement_pack_id: &str,
        updated_at: &str,
    ) {
        for selection in self.project_selections.values_mut() {
            if replaced_pack_ids.contains(&selection.pack_id) {
                selection.pack_id = replacement_pack_id.to_owned();
                selection.selection_updated_at = updated_at.to_owned();
            }
        }
        self.semantic_mappings
            .retain(|pack_id, _| !replaced_pack_ids.contains(pack_id));
    }

    fn remove_custom_pack(&mut self, pack_id: &str, updated_at: &str) {
        for selection in self.project_selections.values_mut() {
            if selection.pack_id == pack_id {
                selection.pack_id = BUILTIN_HIYORI_PACK_ID.to_owned();
                selection.selection_updated_at = updated_at.to_owned();
            }
        }
        self.semantic_mappings.remove(pack_id);
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct LegacyCharacterStateFile {
    schema_version: u16,
    workspace_selections: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum LegacyCharacterSelection {
    PackId(String),
    Versioned {
        #[serde(rename = "packId")]
        pack_id: String,
        #[serde(rename = "selectionUpdatedAt")]
        selection_updated_at: String,
    },
}

type LegacySelectionCandidate = (
    chrono::DateTime<chrono::FixedOffset>,
    String,
    String,
    String,
);
type LegacyProjectCandidates = BTreeMap<String, Vec<LegacySelectionCandidate>>;

impl LegacyCharacterSelection {
    fn parts(self) -> (String, String) {
        match self {
            Self::PackId(pack_id) => (pack_id, LEGACY_SELECTION_TIMESTAMP.to_owned()),
            Self::Versioned {
                pack_id,
                selection_updated_at,
            } => (pack_id, selection_updated_at),
        }
    }
}

#[derive(Clone, Debug)]
pub struct StoredPack {
    pub manifest: CharacterPackManifest,
    pub manifest_hash: String,
    pub directory: PathBuf,
}

#[derive(Clone, Debug)]
pub struct CharacterStorage {
    root: PathBuf,
    quarantine: PathBuf,
    library: PathBuf,
    broken: PathBuf,
    state_path: PathBuf,
    workspace_history_path: PathBuf,
}

impl CharacterStorage {
    pub fn open(app_data_directory: impl AsRef<Path>) -> CharacterResult<Self> {
        let app_data_directory = app_data_directory.as_ref();
        let root = app_data_directory.join("characters");
        let quarantine = root.join("quarantine");
        let library = root.join("library");
        let broken = root.join("broken");
        for directory in [&root, &quarantine, &library, &broken] {
            fs::create_dir_all(directory).map_err(|_| {
                character_error("character_startup", "CHARACTER-STORAGE-CREATE", false)
            })?;
            set_private_directory(directory);
        }
        let storage = Self {
            state_path: root.join(STATE_FILE_NAME),
            root,
            quarantine,
            library,
            broken,
            workspace_history_path: app_data_directory.join("workspace-history.sqlite3"),
        };
        storage.cleanup_interrupted_quarantine()?;
        if !storage.state_path.exists() {
            storage.save_state(&CharacterStateFile::empty())?;
        }
        Ok(storage)
    }

    pub fn workspace_history_path(&self) -> &Path {
        &self.workspace_history_path
    }

    pub fn load_state(&self) -> CharacterResult<CharacterStateFile> {
        let bytes = fs::read(&self.state_path)
            .map_err(|_| character_error("character_library_get", "CHARACTER-STATE-READ", true))?;
        if bytes.len() > 1024 * 1024 {
            return Err(character_error(
                "character_library_get",
                "CHARACTER-STATE-SIZE",
                false,
            ));
        }
        let state: CharacterStateFile = serde_json::from_slice(&bytes).map_err(|_| {
            character_error("character_library_get", "CHARACTER-STATE-INVALID", false)
        })?;
        if state.schema_version != CHARACTER_STATE_SCHEMA_VERSION
            || state.project_selections.iter().any(|(project, selection)| {
                !is_project_id(project)
                    || !is_opaque_pack_id(&selection.pack_id)
                    || chrono::DateTime::parse_from_rfc3339(&selection.selection_updated_at)
                        .is_err()
            })
            || state
                .semantic_mappings
                .keys()
                .any(|pack_id| !is_opaque_pack_id(pack_id))
        {
            return Err(character_error(
                "character_library_get",
                "CHARACTER-STATE-INVALID",
                false,
            ));
        }
        Ok(state)
    }

    pub fn load_or_migrate_state<F>(
        &self,
        valid_pack_ids: &HashSet<String>,
        mut resolve_project: F,
    ) -> CharacterResult<CharacterStateFile>
    where
        F: FnMut(&str) -> CharacterResult<Option<String>>,
    {
        let bytes = fs::read(&self.state_path)
            .map_err(|_| character_error("character_library_get", "CHARACTER-STATE-READ", true))?;
        if bytes.len() > 1024 * 1024 {
            return Err(character_error(
                "character_library_get",
                "CHARACTER-STATE-SIZE",
                false,
            ));
        }
        let schema_version = serde_json::from_slice::<serde_json::Value>(&bytes)
            .ok()
            .and_then(|value| {
                value
                    .get("schemaVersion")
                    .and_then(serde_json::Value::as_u64)
            });
        if schema_version == Some(u64::from(CHARACTER_STATE_SCHEMA_VERSION)) {
            return self.load_state();
        }
        if schema_version != Some(u64::from(CHARACTER_SCHEMA_VERSION)) {
            return Err(character_error(
                "character_library_get",
                "CHARACTER-STATE-INVALID",
                false,
            ));
        }

        let legacy: LegacyCharacterStateFile = serde_json::from_slice(&bytes).map_err(|_| {
            character_error("character_library_get", "CHARACTER-STATE-INVALID", false)
        })?;
        if legacy.schema_version != CHARACTER_SCHEMA_VERSION {
            return Err(character_error(
                "character_library_get",
                "CHARACTER-STATE-INVALID",
                false,
            ));
        }

        let mut candidates = LegacyProjectCandidates::new();
        for (workspace_id, legacy_selection) in legacy.workspace_selections {
            if !is_workspace_id(&workspace_id) {
                continue;
            }
            let Some(project_id) = resolve_project(&workspace_id)? else {
                continue;
            };
            if !is_project_id(&project_id) {
                return Err(character_error(
                    "character_library_get",
                    "CHARACTER-PROJECT-ID",
                    false,
                ));
            }
            let project_candidates = candidates.entry(project_id).or_default();
            let Ok(legacy_selection) =
                serde_json::from_value::<LegacyCharacterSelection>(legacy_selection)
            else {
                continue;
            };
            let (pack_id, selection_updated_at) = legacy_selection.parts();
            let Ok(updated_at) = chrono::DateTime::parse_from_rfc3339(&selection_updated_at) else {
                continue;
            };
            if !is_opaque_pack_id(&pack_id) {
                continue;
            }
            project_candidates.push((updated_at, workspace_id, pack_id, selection_updated_at));
        }

        let mut migrated = CharacterStateFile::empty();
        for (project_id, mut selections) in candidates {
            selections
                .sort_by(|left, right| right.0.cmp(&left.0).then_with(|| left.1.cmp(&right.1)));
            let selected = selections
                .into_iter()
                .find(|(_, _, pack_id, _)| {
                    pack_id == BUILTIN_HIYORI_PACK_ID || valid_pack_ids.contains(pack_id)
                })
                .map(|(_, _, pack_id, updated_at)| (pack_id, updated_at))
                .unwrap_or_else(|| {
                    (
                        BUILTIN_HIYORI_PACK_ID.to_owned(),
                        LEGACY_SELECTION_TIMESTAMP.to_owned(),
                    )
                });
            migrated.select(project_id, selected.0, selected.1);
        }
        self.save_state(&migrated)?;
        Ok(migrated)
    }

    pub fn save_state(&self, state: &CharacterStateFile) -> CharacterResult<()> {
        let bytes = serde_json::to_vec_pretty(state)
            .map_err(|_| character_error("character_state", "CHARACTER-STATE-SERIALIZE", false))?;
        atomic_write(&self.root, &self.state_path, &bytes, "character_state")
    }

    pub fn prepare_quarantine(
        &self,
        token: &str,
        snapshot: &ValidatedCharacterSnapshot,
    ) -> CharacterResult<PathBuf> {
        if uuid::Uuid::parse_str(token).is_err() {
            return Err(character_error(
                "character_import_pick",
                "CHARACTER-PREVIEW-TOKEN",
                false,
            ));
        }
        verify_source_unchanged(snapshot)?;
        let destination = self.quarantine.join(format!("{token}.tmp"));
        fs::create_dir(&destination).map_err(|_| {
            character_error("character_import_pick", "CHARACTER-QUARANTINE-CREATE", true)
        })?;
        set_private_directory(&destination);

        let result = (|| {
            for asset in &snapshot.assets {
                let path = checked_asset_path(&destination, &asset.file.asset_id)?;
                if let Some(parent) = path.parent() {
                    fs::create_dir_all(parent).map_err(|_| {
                        character_error(
                            "character_import_pick",
                            "CHARACTER-QUARANTINE-CREATE",
                            true,
                        )
                    })?;
                    set_private_directory(parent);
                }
                let mut file = OpenOptions::new()
                    .create_new(true)
                    .write(true)
                    .open(&path)
                    .map_err(|_| {
                        character_error("character_import_pick", "CHARACTER-QUARANTINE-COPY", true)
                    })?;
                file.write_all(&asset.contents).map_err(|_| {
                    character_error("character_import_pick", "CHARACTER-QUARANTINE-COPY", true)
                })?;
                file.sync_all().map_err(|_| {
                    character_error("character_import_pick", "CHARACTER-QUARANTINE-SYNC", true)
                })?;
                verify_file(
                    &path,
                    asset.file.bytes,
                    &asset.file.sha256,
                    "character_import_pick",
                )?;
            }
            let manifest = snapshot.manifest.bytes()?;
            atomic_write(
                &destination,
                &destination.join(MANIFEST_FILE_NAME),
                &manifest,
                "character_import_pick",
            )?;
            sync_directory(&destination)?;
            Ok(())
        })();
        if let Err(error) = result {
            let _ = remove_tree(&destination);
            return Err(error);
        }
        Ok(destination)
    }

    pub fn publish(
        &self,
        quarantine_directory: &Path,
        manifest: &CharacterPackManifest,
    ) -> CharacterResult<StoredPack> {
        manifest.validate("character_confirm_import")?;
        if manifest.compatibility.expected_parameters.is_none()
            || manifest.compatibility.expected_parts.is_none()
            || manifest.compatibility.expected_drawables.is_none()
            || manifest.trusted_frame.is_none()
        {
            return Err(character_error(
                "character_confirm_import",
                "CHARACTER-PREVIEW-NOT-ATTESTED",
                false,
            ));
        }
        let manifest_bytes = manifest.bytes()?;
        let manifest_hash = manifest.sha256()?;
        atomic_write(
            quarantine_directory,
            &quarantine_directory.join(MANIFEST_FILE_NAME),
            &manifest_bytes,
            "character_confirm_import",
        )?;
        self.verify_manifest_assets(quarantine_directory, manifest, "character_confirm_import")?;
        sync_directory(quarantine_directory)?;

        let directory_name = custom_directory_name(&manifest.pack_id)?;
        let destination = self.library.join(directory_name);
        if destination.exists() {
            return Err(character_error(
                "character_confirm_import",
                "CHARACTER-PACK-ID-COLLISION",
                false,
            ));
        }
        mark_pack_read_only(quarantine_directory)?;
        fs::rename(quarantine_directory, &destination).map_err(|_| {
            character_error(
                "character_confirm_import",
                "CHARACTER-PUBLISH-ATOMIC-RENAME",
                true,
            )
        })?;
        sync_directory(&self.library)?;
        Ok(StoredPack {
            manifest: manifest.clone(),
            manifest_hash,
            directory: destination,
        })
    }

    pub fn persist_trusted_frame(
        &self,
        quarantine_directory: &Path,
        frame: &CharacterTrustedFrame,
        contents: &[u8],
    ) -> CharacterResult<()> {
        if !quarantine_directory.starts_with(&self.quarantine)
            || contents.len() as u64 != frame.bytes
            || hex::encode(Sha256::digest(contents)) != frame.sha256
        {
            return Err(character_error(
                "character_attest_preview",
                "CHARACTER-TRUSTED-FRAME-INTEGRITY",
                false,
            ));
        }
        let path = checked_asset_path(quarantine_directory, &frame.asset_id)?;
        let parent = path.parent().ok_or_else(|| {
            character_error(
                "character_attest_preview",
                "CHARACTER-TRUSTED-FRAME-WRITE",
                false,
            )
        })?;
        fs::create_dir_all(parent).map_err(|_| {
            character_error(
                "character_attest_preview",
                "CHARACTER-TRUSTED-FRAME-WRITE",
                true,
            )
        })?;
        set_private_directory(parent);
        atomic_write(parent, &path, contents, "character_attest_preview")?;
        verify_file(
            &path,
            frame.bytes,
            &frame.sha256,
            "character_attest_preview",
        )
    }

    pub fn publish_and_replace_custom(
        &self,
        quarantine_directory: &Path,
        manifest: &CharacterPackManifest,
        mut state: CharacterStateFile,
        project_id: &str,
        selection_updated_at: String,
        replaced_packs: &[StoredPack],
    ) -> CharacterResult<StoredPack> {
        let published = self.publish(quarantine_directory, manifest)?;
        let archived = match self.archive_packs(replaced_packs, "character_confirm_import") {
            Ok(archived) => archived,
            Err(error) => {
                self.rollback_publish(&published.directory, quarantine_directory)?;
                return Err(error);
            }
        };
        let replaced_pack_ids = replaced_packs
            .iter()
            .map(|pack| pack.manifest.pack_id.clone())
            .collect::<HashSet<_>>();
        state.replace_custom_packs(&replaced_pack_ids, &manifest.pack_id, &selection_updated_at);
        state.select(
            project_id.to_owned(),
            manifest.pack_id.clone(),
            selection_updated_at,
        );
        if let Err(error) = self.save_state(&state) {
            if self.load_state().ok().as_ref() == Some(&state) {
                self.discard_archived_packs(&archived);
                return Ok(published);
            }
            self.restore_archived_packs(&archived)?;
            self.rollback_publish(&published.directory, quarantine_directory)?;
            return Err(error);
        }
        self.discard_archived_packs(&archived);
        Ok(published)
    }

    pub fn delete_custom_and_fallback(
        &self,
        pack: &StoredPack,
        mut state: CharacterStateFile,
        selection_updated_at: String,
    ) -> CharacterResult<()> {
        let archived = self.archive_packs(std::slice::from_ref(pack), "character_delete_pack")?;
        state.remove_custom_pack(&pack.manifest.pack_id, &selection_updated_at);
        if let Err(error) = self.save_state(&state) {
            if self.load_state().ok().as_ref() == Some(&state) {
                self.discard_archived_packs(&archived);
                return Ok(());
            }
            self.restore_archived_packs(&archived)?;
            return Err(error);
        }
        self.discard_archived_packs(&archived);
        Ok(())
    }

    pub fn load_custom_packs(&self) -> CharacterResult<(Vec<StoredPack>, Vec<String>)> {
        let mut packs = Vec::new();
        let mut diagnostics = Vec::new();
        let entries = fs::read_dir(&self.library).map_err(|_| {
            character_error("character_library_get", "CHARACTER-LIBRARY-READ", true)
        })?;
        for entry in entries {
            let entry = entry.map_err(|_| {
                character_error("character_library_get", "CHARACTER-LIBRARY-READ", true)
            })?;
            let directory = entry.path();
            let metadata = fs::symlink_metadata(&directory).map_err(|_| {
                character_error("character_library_get", "CHARACTER-LIBRARY-READ", true)
            })?;
            if !metadata.is_dir() || metadata.file_type().is_symlink() {
                diagnostics.push("CHARACTER-PACK-QUARANTINED".to_owned());
                let _ = self.quarantine_broken(&directory);
                continue;
            }
            match self.load_pack_directory(&directory) {
                Ok(pack) => {
                    if self
                        .verify_trusted_frame(&directory, &pack.manifest, "character_library_get")
                        .is_err()
                    {
                        diagnostics.push("CHARACTER-TRUSTED-FRAME-UNAVAILABLE".to_owned());
                    }
                    packs.push(pack);
                }
                Err(_) => {
                    diagnostics.push("CHARACTER-PACK-QUARANTINED".to_owned());
                    let _ = self.quarantine_broken(&directory);
                }
            }
        }
        packs.sort_by(|left, right| left.manifest.imported_at.cmp(&right.manifest.imported_at));
        Ok((packs, diagnostics))
    }

    pub(crate) fn verify_library_readiness(&self) -> CharacterResult<()> {
        self.load_state()?;
        let entries = fs::read_dir(&self.library)
            .map_err(|_| character_error("character_readiness", "CHARACTER-LIBRARY-READ", true))?;
        for entry in entries {
            let entry = entry.map_err(|_| {
                character_error("character_readiness", "CHARACTER-LIBRARY-READ", true)
            })?;
            let directory = entry.path();
            let metadata = fs::symlink_metadata(&directory).map_err(|_| {
                character_error("character_readiness", "CHARACTER-LIBRARY-READ", true)
            })?;
            if !metadata.is_dir() || metadata.file_type().is_symlink() {
                return Err(character_error(
                    "character_readiness",
                    "CHARACTER-LIBRARY-INVALID",
                    true,
                ));
            }
            self.load_pack_directory(&directory)
                .map_err(|error| error.with_operation("character_readiness"))?;
        }
        Ok(())
    }

    pub fn load_pack(&self, pack_id: &str) -> CharacterResult<StoredPack> {
        let directory = self.library.join(custom_directory_name(pack_id)?);
        self.load_pack_directory(&directory)
    }

    pub fn read_published_asset(
        &self,
        pack_id: &str,
        manifest_hash: &str,
        asset_id: &str,
    ) -> CharacterResult<Vec<u8>> {
        if !is_sha256(manifest_hash) || !is_safe_asset_id(asset_id) {
            return Err(character_error(
                "character_read_asset",
                "CHARACTER-ASSET-REQUEST",
                false,
            ));
        }
        let pack = self.load_pack(pack_id)?;
        if pack.manifest_hash != manifest_hash {
            return Err(character_error(
                "character_read_asset",
                "CHARACTER-MANIFEST-HASH-MISMATCH",
                false,
            ));
        }
        self.read_manifest_asset(
            &pack.directory,
            &pack.manifest,
            asset_id,
            "character_read_asset",
        )
    }

    pub fn read_quarantine_asset(
        &self,
        directory: &Path,
        manifest: &CharacterPackManifest,
        manifest_hash: &str,
        asset_id: &str,
    ) -> CharacterResult<Vec<u8>> {
        if !is_sha256(manifest_hash) {
            return Err(character_error(
                "character_read_asset",
                "CHARACTER-MANIFEST-HASH-MISMATCH",
                false,
            ));
        }
        self.read_manifest_asset(directory, manifest, asset_id, "character_read_asset")
    }

    pub fn cancel_quarantine(&self, directory: &Path) -> CharacterResult<()> {
        if !directory.starts_with(&self.quarantine) {
            return Err(character_error(
                "character_cancel_import",
                "CHARACTER-PREVIEW-TOKEN",
                false,
            ));
        }
        remove_tree(directory)
    }

    fn load_pack_directory(&self, directory: &Path) -> CharacterResult<StoredPack> {
        let manifest_path = directory.join(MANIFEST_FILE_NAME);
        let bytes = fs::read(&manifest_path).map_err(|_| {
            character_error("character_library_get", "CHARACTER-MANIFEST-READ", true)
        })?;
        if bytes.len() > 1024 * 1024 {
            return Err(character_error(
                "character_library_get",
                "CHARACTER-MANIFEST-SIZE",
                false,
            ));
        }
        let manifest: CharacterPackManifest = serde_json::from_slice(&bytes).map_err(|_| {
            character_error("character_library_get", "CHARACTER-MANIFEST-INVALID", false)
        })?;
        manifest.validate("character_library_get")?;
        if custom_directory_name(&manifest.pack_id)? != directory.file_name().unwrap_or_default() {
            return Err(character_error(
                "character_library_get",
                "CHARACTER-PACK-DIRECTORY-MISMATCH",
                false,
            ));
        }
        self.verify_runtime_assets(directory, &manifest, "character_library_get")?;
        Ok(StoredPack {
            manifest_hash: manifest.sha256()?,
            manifest,
            directory: directory.to_path_buf(),
        })
    }

    fn verify_manifest_assets(
        &self,
        directory: &Path,
        manifest: &CharacterPackManifest,
        operation: &str,
    ) -> CharacterResult<()> {
        self.verify_runtime_assets(directory, manifest, operation)?;
        self.verify_trusted_frame(directory, manifest, operation)
    }

    fn verify_runtime_assets(
        &self,
        directory: &Path,
        manifest: &CharacterPackManifest,
        operation: &str,
    ) -> CharacterResult<()> {
        for asset in &manifest.files {
            let path = checked_asset_path(directory, &asset.asset_id)?;
            verify_file(&path, asset.bytes, &asset.sha256, operation)?;
        }
        Ok(())
    }

    fn verify_trusted_frame(
        &self,
        directory: &Path,
        manifest: &CharacterPackManifest,
        operation: &str,
    ) -> CharacterResult<()> {
        if let Some(frame) = &manifest.trusted_frame {
            let path = checked_asset_path(directory, &frame.asset_id)?;
            verify_file(&path, frame.bytes, &frame.sha256, operation)?;
        }
        Ok(())
    }

    fn read_manifest_asset(
        &self,
        directory: &Path,
        manifest: &CharacterPackManifest,
        asset_id: &str,
        operation: &str,
    ) -> CharacterResult<Vec<u8>> {
        let (expected_bytes, expected_sha256) = manifest_asset_integrity(manifest, asset_id)
            .ok_or_else(|| character_error(operation, "CHARACTER-ASSET-NOT-ALLOWLISTED", false))?;
        let path = checked_asset_path(directory, asset_id)?;
        let mut file = open_read_no_follow(&path, operation)?;
        let metadata = file
            .metadata()
            .map_err(|_| character_error(operation, "CHARACTER-ASSET-METADATA", true))?;
        if !metadata.is_file() || metadata.len() != expected_bytes {
            return Err(character_error(
                operation,
                "CHARACTER-ASSET-LENGTH-MISMATCH",
                false,
            ));
        }
        let mut contents = Vec::with_capacity(expected_bytes as usize);
        file.read_to_end(&mut contents)
            .map_err(|_| character_error(operation, "CHARACTER-ASSET-READ", true))?;
        if hex::encode(Sha256::digest(&contents)) != expected_sha256 {
            return Err(character_error(
                operation,
                "CHARACTER-ASSET-HASH-MISMATCH",
                false,
            ));
        }
        Ok(contents)
    }

    fn rollback_publish(
        &self,
        published_directory: &Path,
        quarantine_directory: &Path,
    ) -> CharacterResult<()> {
        fs::rename(published_directory, quarantine_directory).map_err(|_| {
            character_error(
                "character_confirm_import",
                "CHARACTER-PUBLISH-ROLLBACK",
                false,
            )
        })?;
        sync_directory(&self.library)?;
        sync_directory(&self.quarantine)
    }

    fn archive_packs(
        &self,
        packs: &[StoredPack],
        operation: &str,
    ) -> CharacterResult<Vec<(PathBuf, PathBuf)>> {
        let mut archived = Vec::with_capacity(packs.len());
        for pack in packs {
            if !pack.directory.starts_with(&self.library) || !pack.directory.exists() {
                self.restore_archived_packs(&archived)?;
                return Err(character_error(operation, "CHARACTER-PACK-NOT-FOUND", true));
            }
            let backup = self
                .quarantine
                .join(format!("replaced-{}.tmp", uuid::Uuid::new_v4()));
            if fs::rename(&pack.directory, &backup).is_err() {
                self.restore_archived_packs(&archived)?;
                return Err(character_error(
                    operation,
                    "CHARACTER-REPLACE-ATOMIC-RENAME",
                    true,
                ));
            }
            archived.push((pack.directory.clone(), backup));
        }
        if let Err(error) =
            sync_directory(&self.library).and_then(|_| sync_directory(&self.quarantine))
        {
            self.restore_archived_packs(&archived)?;
            return Err(error);
        }
        Ok(archived)
    }

    fn restore_archived_packs(&self, archived: &[(PathBuf, PathBuf)]) -> CharacterResult<()> {
        for (original, backup) in archived.iter().rev() {
            if fs::rename(backup, original).is_err() {
                return Err(character_error(
                    "character_storage",
                    "CHARACTER-PUBLISH-ROLLBACK",
                    false,
                ));
            }
        }
        sync_directory(&self.library)?;
        sync_directory(&self.quarantine)
    }

    fn discard_archived_packs(&self, archived: &[(PathBuf, PathBuf)]) {
        for (_, backup) in archived {
            let _ = remove_tree(backup);
        }
        let _ = sync_directory(&self.quarantine);
    }

    fn cleanup_interrupted_quarantine(&self) -> CharacterResult<()> {
        let entries = fs::read_dir(&self.quarantine)
            .map_err(|_| character_error("character_startup", "CHARACTER-QUARANTINE-READ", true))?;
        for entry in entries.flatten() {
            remove_tree(&entry.path())?;
        }
        Ok(())
    }

    fn quarantine_broken(&self, directory: &Path) -> CharacterResult<()> {
        let name = format!("broken-{}", uuid::Uuid::new_v4());
        let destination = self.broken.join(name);
        fs::rename(directory, destination).map_err(|_| {
            character_error("character_library_get", "CHARACTER-BROKEN-QUARANTINE", true)
        })
    }
}

fn manifest_asset_integrity<'a>(
    manifest: &'a CharacterPackManifest,
    asset_id: &str,
) -> Option<(u64, &'a str)> {
    if let Some(asset) = manifest.asset(asset_id) {
        return Some((asset.bytes, asset.sha256.as_str()));
    }
    manifest
        .trusted_frame
        .as_ref()
        .filter(|frame| frame.asset_id == asset_id)
        .map(|frame| (frame.bytes, frame.sha256.as_str()))
}

fn checked_asset_path(root: &Path, asset_id: &str) -> CharacterResult<PathBuf> {
    if !is_safe_asset_id(asset_id) {
        return Err(character_error(
            "character_asset",
            "CHARACTER-ASSET-REQUEST",
            false,
        ));
    }
    Ok(root.join(asset_id))
}

fn custom_directory_name(pack_id: &str) -> CharacterResult<&str> {
    pack_id
        .strip_prefix("custom:")
        .filter(|value| uuid::Uuid::parse_str(value).is_ok())
        .ok_or_else(|| character_error("character_library", "CHARACTER-PACK-ID", false))
}

fn is_workspace_id(workspace_id: &str) -> bool {
    !workspace_id.is_empty()
        && workspace_id.len() <= 160
        && workspace_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_:".contains(&byte))
}

fn is_project_id(project_id: &str) -> bool {
    !project_id.is_empty()
        && project_id.len() <= 160
        && project_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_".contains(&byte))
}

fn verify_file(path: &Path, bytes: u64, sha256: &str, operation: &str) -> CharacterResult<()> {
    let mut file = open_read_no_follow(path, operation)?;
    let metadata = file
        .metadata()
        .map_err(|_| character_error(operation, "CHARACTER-ASSET-METADATA", true))?;
    if !metadata.is_file() || metadata.len() != bytes {
        return Err(character_error(
            operation,
            "CHARACTER-ASSET-LENGTH-MISMATCH",
            false,
        ));
    }
    let mut digest = Sha256::new();
    std::io::copy(&mut file, &mut digest)
        .map_err(|_| character_error(operation, "CHARACTER-ASSET-READ", true))?;
    if hex::encode(digest.finalize()) != sha256 {
        return Err(character_error(
            operation,
            "CHARACTER-ASSET-HASH-MISMATCH",
            false,
        ));
    }
    Ok(())
}

fn open_read_no_follow(path: &Path, operation: &str) -> CharacterResult<File> {
    #[cfg(unix)]
    {
        OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(path)
            .map_err(|_| character_error(operation, "CHARACTER-ASSET-OPEN", true))
    }
    #[cfg(not(unix))]
    {
        File::open(path).map_err(|_| character_error(operation, "CHARACTER-ASSET-OPEN", true))
    }
}

fn atomic_write(
    directory: &Path,
    destination: &Path,
    bytes: &[u8],
    operation: &str,
) -> CharacterResult<()> {
    let temporary = directory.join(format!(".tmp-{}", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .map_err(|_| character_error(operation, "CHARACTER-ATOMIC-WRITE", true))?;
        file.write_all(bytes)
            .map_err(|_| character_error(operation, "CHARACTER-ATOMIC-WRITE", true))?;
        file.sync_all()
            .map_err(|_| character_error(operation, "CHARACTER-ATOMIC-SYNC", true))?;
        fs::rename(&temporary, destination)
            .map_err(|_| character_error(operation, "CHARACTER-ATOMIC-RENAME", true))?;
        sync_directory(directory)
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

fn sync_directory(directory: &Path) -> CharacterResult<()> {
    File::open(directory)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| character_error("character_storage", "CHARACTER-DIRECTORY-SYNC", true))
}

fn mark_pack_read_only(directory: &Path) -> CharacterResult<()> {
    for entry in walk(directory)? {
        let metadata = fs::symlink_metadata(&entry).map_err(|_| {
            character_error("character_storage", "CHARACTER-PUBLISH-PERMISSION", true)
        })?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(character_error(
                "character_storage",
                "CHARACTER-PUBLISH-CONTENTS",
                false,
            ));
        }
        #[cfg(unix)]
        fs::set_permissions(&entry, fs::Permissions::from_mode(0o400)).map_err(|_| {
            character_error("character_storage", "CHARACTER-PUBLISH-PERMISSION", true)
        })?;
    }
    Ok(())
}

fn walk(root: &Path) -> CharacterResult<Vec<PathBuf>> {
    let mut result = Vec::new();
    let mut pending = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(directory)
            .map_err(|_| character_error("character_storage", "CHARACTER-DIRECTORY-READ", true))?
        {
            let path = entry
                .map_err(|_| {
                    character_error("character_storage", "CHARACTER-DIRECTORY-READ", true)
                })?
                .path();
            let metadata = fs::symlink_metadata(&path).map_err(|_| {
                character_error("character_storage", "CHARACTER-DIRECTORY-READ", true)
            })?;
            if metadata.is_dir() && !metadata.file_type().is_symlink() {
                pending.push(path);
            } else {
                result.push(path);
            }
        }
    }
    Ok(result)
}

fn remove_tree(path: &Path) -> CharacterResult<()> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
        Err(_) => {
            return Err(character_error(
                "character_storage",
                "CHARACTER-REMOVE",
                true,
            ))
        }
    };
    if metadata.file_type().is_symlink() || metadata.is_file() {
        #[cfg(unix)]
        if metadata.is_file() {
            let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
        }
        return fs::remove_file(path)
            .map_err(|_| character_error("character_storage", "CHARACTER-REMOVE", true));
    }
    if !metadata.is_dir() {
        return Err(character_error(
            "character_storage",
            "CHARACTER-REMOVE",
            false,
        ));
    }
    #[cfg(unix)]
    for entry in walk(path)? {
        let _ = fs::set_permissions(&entry, fs::Permissions::from_mode(0o600));
    }
    fs::remove_dir_all(path)
        .map_err(|_| character_error("character_storage", "CHARACTER-REMOVE", true))
}

fn set_private_directory(path: &Path) {
    #[cfg(unix)]
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o700));
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let path = std::env::temp_dir()
                .join(format!("character-storage-test-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&path).expect("test directory");
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn state_never_accepts_path_like_workspace_or_pack_ids() {
        assert!(is_workspace_id("workspace-123"));
        assert!(!is_workspace_id("../workspace"));
        assert!(custom_directory_name(&format!("custom:{}", uuid::Uuid::new_v4())).is_ok());
        assert!(custom_directory_name("builtin:hiyori_pro").is_err());
    }

    #[test]
    fn legacy_workspace_selections_migrate_deterministically_by_project() {
        let app_data = TestDirectory::new();
        let storage = CharacterStorage::open(&app_data.0).expect("storage");
        let valid_first = format!("custom:{}", uuid::Uuid::new_v4());
        let valid_second = format!("custom:{}", uuid::Uuid::new_v4());
        let invalid_missing = format!("custom:{}", uuid::Uuid::new_v4());
        let legacy = serde_json::json!({
            "schemaVersion": 1,
            "workspaceSelections": {
                "workspace-shared-newer": {
                    "packId": invalid_missing,
                    "selectionUpdatedAt": "2026-07-18T03:00:00.000Z"
                },
                "workspace-shared-valid": {
                    "packId": valid_first,
                    "selectionUpdatedAt": "2026-07-18T02:00:00.000Z"
                },
                "workspace-tie-a": valid_second,
                "workspace-tie-z": valid_first
            }
        });
        fs::write(
            app_data.0.join("characters/state.json"),
            serde_json::to_vec_pretty(&legacy).expect("legacy bytes"),
        )
        .expect("legacy state");
        let valid = HashSet::from([valid_first.clone(), valid_second.clone()]);
        let migrated = storage
            .load_or_migrate_state(&valid, |workspace_id| {
                Ok(Some(if workspace_id.starts_with("workspace-shared") {
                    "project-shared".to_owned()
                } else {
                    "project-tie".to_owned()
                }))
            })
            .expect("deterministic migration");

        assert_eq!(migrated.selected_for("project-shared"), valid_first);
        assert_eq!(migrated.selected_for("project-tie"), valid_second);
        assert_eq!(migrated.schema_version, CHARACTER_STATE_SCHEMA_VERSION);
        let persisted = storage
            .load_or_migrate_state(&valid, |_| panic!("v2 must not resolve legacy workspaces"))
            .expect("restart state");
        assert_eq!(persisted, migrated);
        let state_text =
            fs::read_to_string(app_data.0.join("characters/state.json")).expect("persisted state");
        assert!(!state_text.contains("workspaceSelections"));
    }

    #[test]
    fn legacy_migration_salvages_mixed_candidates_and_falls_back_per_project() {
        let app_data = TestDirectory::new();
        let storage = CharacterStorage::open(&app_data.0).expect("storage");
        let valid_pack = format!("custom:{}", uuid::Uuid::new_v4());
        let missing_pack = format!("custom:{}", uuid::Uuid::new_v4());
        let legacy = serde_json::json!({
            "schemaVersion": 1,
            "workspaceSelections": {
                "../invalid-workspace": valid_pack,
                "workspace-a-invalid-time": {
                    "packId": valid_pack,
                    "selectionUpdatedAt": "not-a-timestamp"
                },
                "workspace-a-valid": {
                    "packId": valid_pack,
                    "selectionUpdatedAt": "2026-07-18T02:00:00.000Z"
                },
                "workspace-b-invalid-pack": {
                    "packId": "../unsafe-pack",
                    "selectionUpdatedAt": "2026-07-18T03:00:00.000Z"
                },
                "workspace-b-invalid-shape": {
                    "packId": valid_pack
                },
                "workspace-c-missing-pack": {
                    "packId": missing_pack,
                    "selectionUpdatedAt": "2026-07-18T04:00:00.000Z"
                },
                "workspace-d-invalid-value": 42,
                "workspace-unregistered": valid_pack
            }
        });
        fs::write(
            &storage.state_path,
            serde_json::to_vec_pretty(&legacy).expect("legacy bytes"),
        )
        .expect("legacy state");

        let migrated = storage
            .load_or_migrate_state(&HashSet::from([valid_pack.clone()]), |workspace_id| {
                assert!(is_workspace_id(workspace_id));
                Ok(match workspace_id {
                    value if value.starts_with("workspace-a-") => Some("project-a".to_owned()),
                    value if value.starts_with("workspace-b-") => Some("project-b".to_owned()),
                    "workspace-c-missing-pack" => Some("project-c".to_owned()),
                    "workspace-d-invalid-value" => Some("project-d".to_owned()),
                    "workspace-unregistered" => None,
                    _ => panic!("unexpected workspace {workspace_id}"),
                })
            })
            .expect("mixed migration");

        assert_eq!(migrated.selected_for("project-a"), valid_pack);
        for project_id in ["project-b", "project-c", "project-d"] {
            assert_eq!(
                migrated.selected_for(project_id),
                BUILTIN_HIYORI_PACK_ID,
                "{project_id} must receive the deterministic fallback"
            );
            assert_eq!(
                migrated.project_selections[project_id].selection_updated_at,
                LEGACY_SELECTION_TIMESTAMP
            );
        }
        assert_eq!(migrated.project_selections.len(), 4);
    }

    #[test]
    fn legacy_migration_keeps_schema_and_top_level_structure_failures_typed() {
        let app_data = TestDirectory::new();
        let storage = CharacterStorage::open(&app_data.0).expect("storage");
        let invalid_files = [
            serde_json::json!({"schemaVersion": 99, "workspaceSelections": {}}),
            serde_json::json!({"schemaVersion": 1}),
            serde_json::json!({"schemaVersion": 1, "workspaceSelections": []}),
            serde_json::json!({
                "schemaVersion": 1,
                "workspaceSelections": {},
                "unexpected": true
            }),
        ];

        for invalid in invalid_files {
            fs::write(
                &storage.state_path,
                serde_json::to_vec(&invalid).expect("invalid fixture"),
            )
            .expect("invalid state");
            let error = storage
                .load_or_migrate_state(&HashSet::new(), |_| {
                    panic!("structurally invalid state must not resolve workspaces")
                })
                .expect_err("top-level corruption remains a typed failure");
            assert_eq!(error.code, "CHARACTER-STATE-INVALID");
            assert_eq!(error.operation, "character_library_get");
            assert!(!error.recoverable);
        }
    }

    #[cfg(unix)]
    #[test]
    fn legacy_migration_atomic_write_failure_retries_idempotently() {
        let app_data = TestDirectory::new();
        let storage = CharacterStorage::open(&app_data.0).expect("storage");
        let valid_pack = format!("custom:{}", uuid::Uuid::new_v4());
        let legacy = serde_json::json!({
            "schemaVersion": 1,
            "workspaceSelections": {
                "workspace-retry": valid_pack
            }
        });
        fs::write(
            &storage.state_path,
            serde_json::to_vec_pretty(&legacy).expect("legacy bytes"),
        )
        .expect("legacy state");
        fs::set_permissions(&storage.root, fs::Permissions::from_mode(0o500))
            .expect("read-only character root");

        let first = storage.load_or_migrate_state(&HashSet::from([valid_pack.clone()]), |_| {
            Ok(Some("project-retry".to_owned()))
        });
        fs::set_permissions(&storage.root, fs::Permissions::from_mode(0o700))
            .expect("restore writable character root");
        let error = first.expect_err("migration write must fail atomically");
        assert_eq!(error.code, "CHARACTER-ATOMIC-WRITE");
        let preserved: serde_json::Value =
            serde_json::from_slice(&fs::read(&storage.state_path).expect("preserved legacy state"))
                .expect("preserved legacy json");
        assert_eq!(preserved["schemaVersion"], 1);

        let migrated = storage
            .load_or_migrate_state(&HashSet::from([valid_pack.clone()]), |_| {
                Ok(Some("project-retry".to_owned()))
            })
            .expect("retry migration");
        assert_eq!(migrated.selected_for("project-retry"), valid_pack);
        let reopened = storage
            .load_or_migrate_state(&HashSet::new(), |_| {
                panic!("completed migration must not resolve legacy workspaces")
            })
            .expect("idempotent restart");
        assert_eq!(reopened, migrated);
    }

    #[cfg(unix)]
    #[test]
    fn interrupted_quarantine_cleanup_never_follows_a_root_symlink() {
        use std::os::unix::fs::symlink;

        let app_data =
            std::env::temp_dir().join(format!("character-storage-app-{}", uuid::Uuid::new_v4()));
        let external = std::env::temp_dir().join(format!(
            "character-storage-external-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&external).expect("external directory");
        let sentinel = external.join("sentinel.txt");
        fs::write(&sentinel, b"must remain").expect("external sentinel");
        let storage = CharacterStorage::open(&app_data).expect("storage");
        let link = storage.quarantine.join("interrupted.tmp");
        symlink(&external, &link).expect("quarantine symlink");

        CharacterStorage::open(&app_data).expect("safe cleanup");
        assert!(!link.exists());
        assert_eq!(
            fs::read(&sentinel).expect("sentinel remains"),
            b"must remain"
        );

        let _ = fs::remove_dir_all(app_data);
        let _ = fs::remove_dir_all(external);
    }
}
