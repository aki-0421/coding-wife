use std::collections::{BTreeMap, HashSet};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::error::{character_error, CharacterResult};

pub const CHARACTER_SCHEMA_VERSION: u16 = 1;
pub const BUILTIN_HIYORI_PACK_ID: &str = "builtin:hiyori_pro";
pub const CHARACTER_TRUSTED_FRAME_ASSET_ID: &str = "__coding-wife/trusted-frame.png";
pub const MAX_TRUSTED_FRAME_BYTES: u64 = 2 * 1024 * 1024;
pub const MAX_TRUSTED_FRAME_DIMENSION: u32 = 2048;
const MAX_TOTAL_BYTES: u64 = 100 * 1024 * 1024;
const MAX_TEXTURE_DIMENSION: u32 = 8192;
const MAX_MODEL_ITEMS: u32 = 1_000_000;

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CharacterAssetRole {
    Model,
    Moc,
    Texture,
    Motion,
    Expression,
    Physics,
    Pose,
    DisplayInfo,
    UserData,
}

impl CharacterAssetRole {
    pub fn expected_suffix(self) -> &'static str {
        match self {
            Self::Model => ".model3.json",
            Self::Moc => ".moc3",
            Self::Texture => ".png",
            Self::Motion => ".motion3.json",
            Self::Expression => ".exp3.json",
            Self::Physics => ".physics3.json",
            Self::Pose => ".pose3.json",
            Self::DisplayInfo => ".cdi3.json",
            Self::UserData => ".userdata3.json",
        }
    }

    pub fn mime(self) -> &'static str {
        match self {
            Self::Moc => "application/octet-stream",
            Self::Texture => "image/png",
            Self::Model
            | Self::Motion
            | Self::Expression
            | Self::Physics
            | Self::Pose
            | Self::DisplayInfo
            | Self::UserData => "application/json",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CharacterDimensions {
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CharacterPackFile {
    pub asset_id: String,
    pub role: CharacterAssetRole,
    pub bytes: u64,
    pub sha256: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dimensions: Option<CharacterDimensions>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CharacterTrustedFrame {
    pub asset_id: String,
    pub bytes: u64,
    pub sha256: String,
    pub dimensions: CharacterDimensions,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CharacterMotionCue {
    pub cue_id: String,
    pub asset_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CharacterInventory {
    pub runtime_file_count: u32,
    pub total_bytes: u64,
    pub texture_count: u32,
    pub motion_count: u32,
    pub expression_count: u32,
    pub motion_groups: BTreeMap<String, Vec<CharacterMotionCue>>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CharacterCompatibility {
    pub model_schema_version: u32,
    pub moc_version: u32,
    pub expected_parameters: Option<u32>,
    pub expected_parts: Option<u32>,
    pub expected_drawables: Option<u32>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CharacterProvenanceKind {
    UserImported,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CharacterProvenance {
    pub source_kind: CharacterProvenanceKind,
    pub source_label: String,
    pub imported_at: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CharacterPackManifest {
    pub schema_version: u16,
    pub pack_id: String,
    pub display_name: String,
    pub bundled_version: String,
    pub entrypoint: String,
    pub immutable: bool,
    pub provenance: CharacterProvenance,
    pub inventory: CharacterInventory,
    pub compatibility: CharacterCompatibility,
    pub files: Vec<CharacterPackFile>,
    pub imported_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trusted_frame: Option<CharacterTrustedFrame>,
}

impl CharacterPackManifest {
    pub fn bytes(&self) -> CharacterResult<Vec<u8>> {
        serde_json::to_vec_pretty(self).map_err(|_| {
            character_error("character_manifest", "CHARACTER-MANIFEST-SERIALIZE", false)
        })
    }

    pub fn sha256(&self) -> CharacterResult<String> {
        Ok(hex::encode(Sha256::digest(self.bytes()?)))
    }

    pub fn validate(&self, operation: &str) -> CharacterResult<()> {
        if self.schema_version != CHARACTER_SCHEMA_VERSION
            || !self.immutable
            || self
                .pack_id
                .strip_prefix("custom:")
                .is_none_or(|id| uuid::Uuid::parse_str(id).is_err())
            || !(1..=80).contains(&self.display_name.trim().chars().count())
            || self.bundled_version != "custom-import-v1"
            || !is_safe_asset_id(&self.entrypoint)
            || self.files.is_empty()
            || self.files.len() > 128
            || self.inventory.runtime_file_count as usize != self.files.len()
            || self.inventory.total_bytes != self.files.iter().map(|asset| asset.bytes).sum::<u64>()
            || self.inventory.total_bytes > MAX_TOTAL_BYTES
            || self.provenance.source_label != "Local folder"
            || self.provenance.imported_at != self.imported_at
            || chrono::DateTime::parse_from_rfc3339(&self.imported_at).is_err()
            || self.trusted_frame.as_ref().is_some_and(|frame| {
                frame.asset_id != CHARACTER_TRUSTED_FRAME_ASSET_ID
                    || frame.bytes == 0
                    || frame.bytes > MAX_TRUSTED_FRAME_BYTES
                    || !is_sha256(&frame.sha256)
                    || frame.dimensions.width == 0
                    || frame.dimensions.height == 0
                    || frame.dimensions.width > MAX_TRUSTED_FRAME_DIMENSION
                    || frame.dimensions.height > MAX_TRUSTED_FRAME_DIMENSION
                    || self.asset(&frame.asset_id).is_some()
            })
            || self.compatibility.model_schema_version != 3
            || !(1..=6).contains(&self.compatibility.moc_version)
            || !valid_expected_inventory(&self.compatibility)
        {
            return Err(character_error(
                operation,
                "CHARACTER-MANIFEST-INVALID",
                false,
            ));
        }

        let mut asset_ids = HashSet::new();
        let mut models = 0;
        let mut mocs = 0;
        let mut textures = 0;
        let mut motions = 0;
        let mut expressions = 0;
        for asset in &self.files {
            if !asset_ids.insert(asset.asset_id.as_str())
                || !is_safe_asset_id(&asset.asset_id)
                || !asset.asset_id.ends_with(asset.role.expected_suffix())
                || asset.bytes == 0
                || asset.bytes > 32 * 1024 * 1024
                || !is_sha256(&asset.sha256)
                || (asset.role == CharacterAssetRole::Texture) != asset.dimensions.is_some()
                || asset.dimensions.as_ref().is_some_and(|dimensions| {
                    dimensions.width == 0
                        || dimensions.height == 0
                        || dimensions.width > MAX_TEXTURE_DIMENSION
                        || dimensions.height > MAX_TEXTURE_DIMENSION
                })
            {
                return Err(character_error(
                    operation,
                    "CHARACTER-MANIFEST-ASSET-INVALID",
                    false,
                ));
            }
            match asset.role {
                CharacterAssetRole::Model => models += 1,
                CharacterAssetRole::Moc => mocs += 1,
                CharacterAssetRole::Texture => textures += 1,
                CharacterAssetRole::Motion => motions += 1,
                CharacterAssetRole::Expression => expressions += 1,
                _ => {}
            }
        }
        if models != 1
            || mocs != 1
            || textures == 0
            || self
                .files
                .iter()
                .find(|asset| asset.asset_id == self.entrypoint)
                .map(|asset| asset.role)
                != Some(CharacterAssetRole::Model)
            || textures != self.inventory.texture_count
            || motions != self.inventory.motion_count
            || expressions != self.inventory.expression_count
            || !valid_motion_inventory(self)
        {
            return Err(character_error(
                operation,
                "CHARACTER-MANIFEST-INVENTORY-MISMATCH",
                false,
            ));
        }
        Ok(())
    }

    pub fn asset(&self, asset_id: &str) -> Option<&CharacterPackFile> {
        self.files.iter().find(|asset| asset.asset_id == asset_id)
    }
}

fn valid_expected_inventory(compatibility: &CharacterCompatibility) -> bool {
    match (
        compatibility.expected_parameters,
        compatibility.expected_parts,
        compatibility.expected_drawables,
    ) {
        (None, None, None) => true,
        (Some(parameters), Some(parts), Some(drawables)) => {
            (1..=MAX_MODEL_ITEMS).contains(&parameters)
                && (1..=MAX_MODEL_ITEMS).contains(&parts)
                && (1..=MAX_MODEL_ITEMS).contains(&drawables)
        }
        _ => false,
    }
}

fn valid_motion_inventory(manifest: &CharacterPackManifest) -> bool {
    let motion_assets = manifest
        .files
        .iter()
        .filter(|asset| asset.role == CharacterAssetRole::Motion)
        .map(|asset| asset.asset_id.as_str())
        .collect::<HashSet<_>>();
    let mut cues = HashSet::new();
    for (group, group_cues) in &manifest.inventory.motion_groups {
        if group.trim().is_empty() || group.chars().count() > 80 {
            return false;
        }
        for (index, cue) in group_cues.iter().enumerate() {
            if cue.cue_id != format!("{group}[{index}]")
                || !motion_assets.contains(cue.asset_id.as_str())
                || !cues.insert(cue.asset_id.as_str())
            {
                return false;
            }
        }
    }
    cues.len() == motion_assets.len()
}

pub fn is_safe_asset_id(asset_id: &str) -> bool {
    if asset_id.is_empty()
        || asset_id.starts_with('/')
        || asset_id.contains('\\')
        || asset_id.contains('\0')
        || asset_id.contains('%')
        || asset_id.contains(':')
    {
        return false;
    }
    asset_id
        .split('/')
        .all(|component| !component.is_empty() && component != "." && component != "..")
}

pub fn is_opaque_pack_id(pack_id: &str) -> bool {
    if pack_id == BUILTIN_HIYORI_PACK_ID {
        return true;
    }
    pack_id
        .strip_prefix("custom:")
        .is_some_and(|id| uuid::Uuid::parse_str(id).is_ok())
}

pub fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn asset_ids_reject_paths_and_encoded_aliases() {
        for unsafe_id in [
            "",
            "/absolute.png",
            "../escape.png",
            "a/../b.png",
            "a//b.png",
            "a\\b.png",
            "https:asset.png",
            "%2e%2e/escape.png",
            "a\0b.png",
        ] {
            assert!(!is_safe_asset_id(unsafe_id), "{unsafe_id}");
        }
        assert!(is_safe_asset_id("runtime/model.model3.json"));
    }
}
