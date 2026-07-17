use std::collections::{BTreeMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::{BufReader, Cursor, Read};
use std::path::{Component, Path, PathBuf};

use serde_json::Value;
use sha2::{Digest, Sha256};

#[cfg(any(not(unix), test))]
use std::fs::File;
#[cfg(unix)]
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};

use super::error::{character_error, CharacterResult};
use super::manifest::{
    is_safe_asset_id, CharacterAssetRole, CharacterCompatibility, CharacterDimensions,
    CharacterInventory, CharacterMotionCue, CharacterPackFile, CharacterPackManifest,
    CharacterProvenance, CharacterProvenanceKind, CHARACTER_SCHEMA_VERSION,
};

const MAX_FILES: usize = 128;
const MAX_TOTAL_BYTES: u64 = 100 * 1024 * 1024;
const MAX_FILE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_TEXTURE_DIMENSION: u32 = 8192;
const MAX_JSON_DEPTH: usize = 64;
const MAX_SCAN_DEPTH: usize = 32;
const MAX_MOC_VERSION: u32 = 6;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SourceFingerprint {
    pub device: u64,
    pub inode: u64,
    pub bytes: u64,
    pub sha256: String,
}

#[derive(Clone, Debug)]
pub struct SnapshotAsset {
    pub source_path: PathBuf,
    pub file: CharacterPackFile,
    pub fingerprint: SourceFingerprint,
    pub contents: Vec<u8>,
}

#[derive(Clone, Debug)]
pub struct ValidatedCharacterSnapshot {
    pub source_root: PathBuf,
    pub manifest: CharacterPackManifest,
    pub assets: Vec<SnapshotAsset>,
}

#[derive(Clone, Debug)]
struct AssetReference {
    asset_id: String,
    role: CharacterAssetRole,
    motion_group: Option<String>,
    motion_index: Option<usize>,
}

pub fn snapshot_character_folder(
    selected_folder: &Path,
    pack_id: String,
    imported_at: String,
) -> CharacterResult<ValidatedCharacterSnapshot> {
    let operation = "character_import_pick";
    let selected_metadata = fs::symlink_metadata(selected_folder)
        .map_err(|_| character_error(operation, "CHARACTER-SOURCE-UNREADABLE", true))?;
    if selected_metadata.file_type().is_symlink() || !selected_metadata.is_dir() {
        return Err(character_error(
            operation,
            "CHARACTER-SOURCE-NOT-DIRECTORY",
            true,
        ));
    }
    let selected_root = fs::canonicalize(selected_folder)
        .map_err(|_| character_error(operation, "CHARACTER-SOURCE-UNREADABLE", true))?;
    let entries = discover_model_entries(&selected_root)?;
    let model_path = match entries.as_slice() {
        [entry] => entry.clone(),
        [] => {
            return Err(character_error(
                operation,
                "CHARACTER-MODEL3-NOT-FOUND",
                true,
            ))
        }
        _ => {
            return Err(character_error(
                operation,
                "CHARACTER-MODEL3-MULTIPLE",
                true,
            ))
        }
    };
    let source_root = model_path
        .parent()
        .ok_or_else(|| character_error(operation, "CHARACTER-SOURCE-UNREADABLE", true))?;
    let source_root = fs::canonicalize(source_root)
        .map_err(|_| character_error(operation, "CHARACTER-SOURCE-UNREADABLE", true))?;

    let model_name = model_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| character_error(operation, "CHARACTER-ASSET-NAME", false))?;
    let model_reference = AssetReference {
        asset_id: model_name.to_owned(),
        role: CharacterAssetRole::Model,
        motion_group: None,
        motion_index: None,
    };
    let model_asset = read_snapshot_asset(&source_root, &model_reference)?;
    let model_json = parse_json(&model_asset.contents, operation)?;
    let references = collect_model_references(&model_json, model_name, operation)?;

    if references.len() > MAX_FILES {
        return Err(character_error(
            operation,
            "CHARACTER-FILE-COUNT-LIMIT",
            true,
        ));
    }

    let mut assets = Vec::with_capacity(references.len());
    let mut total_bytes = 0_u64;
    let mut motion_groups: BTreeMap<String, Vec<CharacterMotionCue>> = BTreeMap::new();
    let mut texture_count = 0_u32;
    let mut motion_count = 0_u32;
    let mut expression_count = 0_u32;
    let mut moc_version = None;

    for reference in references {
        let mut asset = if reference.role == CharacterAssetRole::Model {
            model_asset.clone()
        } else {
            read_snapshot_asset(&source_root, &reference)?
        };
        validate_asset_contents(&mut asset, &mut moc_version, operation)?;
        total_bytes = total_bytes
            .checked_add(asset.file.bytes)
            .ok_or_else(|| character_error(operation, "CHARACTER-TOTAL-SIZE-LIMIT", true))?;
        if total_bytes > MAX_TOTAL_BYTES {
            return Err(character_error(
                operation,
                "CHARACTER-TOTAL-SIZE-LIMIT",
                true,
            ));
        }
        match reference.role {
            CharacterAssetRole::Texture => texture_count += 1,
            CharacterAssetRole::Motion => {
                motion_count += 1;
                let group = reference
                    .motion_group
                    .as_deref()
                    .ok_or_else(|| character_error(operation, "CHARACTER-MOTION-SCHEMA", false))?;
                let index = reference
                    .motion_index
                    .ok_or_else(|| character_error(operation, "CHARACTER-MOTION-SCHEMA", false))?;
                motion_groups
                    .entry(group.to_owned())
                    .or_default()
                    .push(CharacterMotionCue {
                        cue_id: format!("{group}[{index}]"),
                        asset_id: reference.asset_id,
                    });
            }
            CharacterAssetRole::Expression => expression_count += 1,
            _ => {}
        }
        assets.push(asset);
    }

    let model_schema_version = model_json
        .get("Version")
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .filter(|version| *version == 3)
        .ok_or_else(|| character_error(operation, "CHARACTER-MODEL3-VERSION", false))?;
    let display_name = model_path
        .file_name()
        .and_then(|value| value.to_str())
        .and_then(|value| value.strip_suffix(".model3.json"))
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("Imported Live2D model")
        .chars()
        .take(80)
        .collect::<String>();
    let files = assets
        .iter()
        .map(|asset| asset.file.clone())
        .collect::<Vec<_>>();
    let manifest = CharacterPackManifest {
        schema_version: CHARACTER_SCHEMA_VERSION,
        pack_id,
        display_name,
        bundled_version: "custom-import-v1".to_owned(),
        entrypoint: model_name.to_owned(),
        immutable: true,
        provenance: CharacterProvenance {
            source_kind: CharacterProvenanceKind::UserImported,
            source_label: "Local folder".to_owned(),
            imported_at: imported_at.clone(),
        },
        inventory: CharacterInventory {
            runtime_file_count: files.len() as u32,
            total_bytes,
            texture_count,
            motion_count,
            expression_count,
            motion_groups,
        },
        compatibility: CharacterCompatibility {
            model_schema_version,
            moc_version: moc_version
                .ok_or_else(|| character_error(operation, "CHARACTER-MOC-MISSING", false))?,
            expected_parameters: None,
            expected_parts: None,
            expected_drawables: None,
        },
        files,
        imported_at,
        thumbnail_sha256: None,
    };
    manifest.validate(operation)?;
    Ok(ValidatedCharacterSnapshot {
        source_root,
        manifest,
        assets,
    })
}

pub fn verify_source_unchanged(snapshot: &ValidatedCharacterSnapshot) -> CharacterResult<()> {
    for original in &snapshot.assets {
        let reference = AssetReference {
            asset_id: original.file.asset_id.clone(),
            role: original.file.role,
            motion_group: None,
            motion_index: None,
        };
        let current = read_snapshot_asset(&snapshot.source_root, &reference)?;
        if current.fingerprint != original.fingerprint {
            return Err(character_error(
                "character_import_pick",
                "CHARACTER-SOURCE-CHANGED",
                true,
            ));
        }
    }
    Ok(())
}

fn discover_model_entries(root: &Path) -> CharacterResult<Vec<PathBuf>> {
    let operation = "character_import_pick";
    let mut pending = vec![(root.to_path_buf(), 0_usize)];
    let mut entries = Vec::new();
    while let Some((directory, depth)) = pending.pop() {
        if depth > MAX_SCAN_DEPTH {
            return Err(character_error(
                operation,
                "CHARACTER-DIRECTORY-DEPTH-LIMIT",
                true,
            ));
        }
        let iterator = fs::read_dir(&directory)
            .map_err(|_| character_error(operation, "CHARACTER-SOURCE-UNREADABLE", true))?;
        for item in iterator {
            let item =
                item.map_err(|_| character_error(operation, "CHARACTER-SOURCE-UNREADABLE", true))?;
            let path = item.path();
            let metadata = fs::symlink_metadata(&path)
                .map_err(|_| character_error(operation, "CHARACTER-SOURCE-UNREADABLE", true))?;
            if metadata.file_type().is_symlink() {
                return Err(character_error(
                    operation,
                    "CHARACTER-SYMLINK-NOT-ALLOWED",
                    false,
                ));
            }
            if metadata.is_dir() {
                pending.push((path, depth + 1));
                continue;
            }
            if !metadata.is_file() {
                return Err(character_error(
                    operation,
                    "CHARACTER-NONREGULAR-ASSET",
                    false,
                ));
            }
            let name = item.file_name();
            let name = name.to_string_lossy();
            if name.starts_with('.') {
                #[cfg(unix)]
                if metadata.permissions().mode() & 0o111 != 0 {
                    return Err(character_error(
                        operation,
                        "CHARACTER-HIDDEN-EXECUTABLE",
                        false,
                    ));
                }
                continue;
            }
            if name.ends_with(".model3.json") {
                entries.push(path);
                if entries.len() > 1 {
                    return Ok(entries);
                }
            }
        }
    }
    entries.sort();
    Ok(entries)
}

fn collect_model_references(
    model: &Value,
    model_asset_id: &str,
    operation: &str,
) -> CharacterResult<Vec<AssetReference>> {
    let object = model
        .as_object()
        .ok_or_else(|| character_error(operation, "CHARACTER-MODEL3-SCHEMA", false))?;
    if object.get("Version").and_then(Value::as_u64) != Some(3) {
        return Err(character_error(
            operation,
            "CHARACTER-MODEL3-VERSION",
            false,
        ));
    }
    let references = object
        .get("FileReferences")
        .and_then(Value::as_object)
        .ok_or_else(|| character_error(operation, "CHARACTER-MODEL3-SCHEMA", false))?;
    let allowed_keys = [
        "Moc",
        "Textures",
        "Physics",
        "Pose",
        "DisplayInfo",
        "Expressions",
        "Motions",
        "UserData",
    ];
    if references
        .keys()
        .any(|key| !allowed_keys.contains(&key.as_str()))
    {
        return Err(character_error(
            operation,
            "CHARACTER-MODEL3-UNKNOWN-REFERENCE",
            false,
        ));
    }

    let mut result = vec![AssetReference {
        asset_id: model_asset_id.to_owned(),
        role: CharacterAssetRole::Model,
        motion_group: None,
        motion_index: None,
    }];
    push_string_reference(
        &mut result,
        references.get("Moc"),
        CharacterAssetRole::Moc,
        true,
        operation,
    )?;

    let textures = references
        .get("Textures")
        .and_then(Value::as_array)
        .filter(|textures| !textures.is_empty())
        .ok_or_else(|| character_error(operation, "CHARACTER-TEXTURE-MISSING", false))?;
    for texture in textures {
        result.push(reference_from_value(
            texture,
            CharacterAssetRole::Texture,
            operation,
        )?);
    }
    for (key, role) in [
        ("Physics", CharacterAssetRole::Physics),
        ("Pose", CharacterAssetRole::Pose),
        ("DisplayInfo", CharacterAssetRole::DisplayInfo),
        ("UserData", CharacterAssetRole::UserData),
    ] {
        push_string_reference(&mut result, references.get(key), role, false, operation)?;
    }

    if let Some(expressions) = references.get("Expressions") {
        for expression in expressions
            .as_array()
            .ok_or_else(|| character_error(operation, "CHARACTER-EXPRESSION-SCHEMA", false))?
        {
            let file = expression
                .as_object()
                .and_then(|item| item.get("File"))
                .ok_or_else(|| character_error(operation, "CHARACTER-EXPRESSION-SCHEMA", false))?;
            result.push(reference_from_value(
                file,
                CharacterAssetRole::Expression,
                operation,
            )?);
        }
    }

    if let Some(motions) = references.get("Motions") {
        let groups = motions
            .as_object()
            .ok_or_else(|| character_error(operation, "CHARACTER-MOTION-SCHEMA", false))?;
        for (group, cues) in groups {
            if group.trim().is_empty() || group.chars().count() > 80 {
                return Err(character_error(operation, "CHARACTER-MOTION-SCHEMA", false));
            }
            let cues = cues
                .as_array()
                .ok_or_else(|| character_error(operation, "CHARACTER-MOTION-SCHEMA", false))?;
            for (index, cue) in cues.iter().enumerate() {
                let file = cue
                    .as_object()
                    .and_then(|item| item.get("File"))
                    .ok_or_else(|| character_error(operation, "CHARACTER-MOTION-SCHEMA", false))?;
                let mut reference =
                    reference_from_value(file, CharacterAssetRole::Motion, operation)?;
                reference.motion_group = Some(group.clone());
                reference.motion_index = Some(index);
                result.push(reference);
            }
        }
    }

    let mut seen = HashSet::new();
    result.retain(|reference| seen.insert(reference.asset_id.clone()));
    Ok(result)
}

fn push_string_reference(
    result: &mut Vec<AssetReference>,
    value: Option<&Value>,
    role: CharacterAssetRole,
    required: bool,
    operation: &str,
) -> CharacterResult<()> {
    match value {
        Some(value) => result.push(reference_from_value(value, role, operation)?),
        None if required => return Err(character_error(operation, "CHARACTER-MOC-MISSING", false)),
        None => {}
    }
    Ok(())
}

fn reference_from_value(
    value: &Value,
    role: CharacterAssetRole,
    operation: &str,
) -> CharacterResult<AssetReference> {
    let asset_id = value
        .as_str()
        .filter(|value| is_safe_asset_id(value))
        .filter(|value| value.ends_with(role.expected_suffix()))
        .ok_or_else(|| character_error(operation, "CHARACTER-ASSET-REFERENCE", false))?;
    Ok(AssetReference {
        asset_id: asset_id.to_owned(),
        role,
        motion_group: None,
        motion_index: None,
    })
}

fn read_snapshot_asset(root: &Path, reference: &AssetReference) -> CharacterResult<SnapshotAsset> {
    let operation = "character_import_pick";
    if !is_safe_asset_id(&reference.asset_id)
        || !reference
            .asset_id
            .ends_with(reference.role.expected_suffix())
    {
        return Err(character_error(
            operation,
            "CHARACTER-ASSET-REFERENCE",
            false,
        ));
    }
    let relative = Path::new(&reference.asset_id);
    if relative
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(character_error(
            operation,
            "CHARACTER-ASSET-TRAVERSAL",
            false,
        ));
    }
    ensure_no_symlink_components(root, relative)?;
    let path = root.join(relative);
    let canonical = fs::canonicalize(&path)
        .map_err(|_| character_error(operation, "CHARACTER-ASSET-MISSING", true))?;
    if !canonical.starts_with(root) {
        return Err(character_error(
            operation,
            "CHARACTER-ASSET-ESCAPED-ROOT",
            false,
        ));
    }
    #[cfg(unix)]
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(&path)
        .map_err(|_| character_error(operation, "CHARACTER-ASSET-OPEN", true))?;
    #[cfg(not(unix))]
    let mut file =
        File::open(&path).map_err(|_| character_error(operation, "CHARACTER-ASSET-OPEN", true))?;
    let metadata = file
        .metadata()
        .map_err(|_| character_error(operation, "CHARACTER-ASSET-METADATA", true))?;
    if !metadata.is_file() {
        return Err(character_error(
            operation,
            "CHARACTER-NONREGULAR-ASSET",
            false,
        ));
    }
    #[cfg(unix)]
    if metadata.nlink() != 1 {
        return Err(character_error(
            operation,
            "CHARACTER-HARDLINK-NOT-ALLOWED",
            false,
        ));
    }
    #[cfg(unix)]
    if metadata.permissions().mode() & 0o111 != 0 {
        return Err(character_error(
            operation,
            "CHARACTER-EXECUTABLE-NOT-ALLOWED",
            false,
        ));
    }
    if metadata.len() == 0 || metadata.len() > MAX_FILE_BYTES {
        return Err(character_error(
            operation,
            "CHARACTER-FILE-SIZE-LIMIT",
            true,
        ));
    }
    let mut contents = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut contents)
        .map_err(|_| character_error(operation, "CHARACTER-ASSET-READ", true))?;
    if contents.len() as u64 != metadata.len() {
        return Err(character_error(operation, "CHARACTER-SOURCE-CHANGED", true));
    }
    let sha256 = hex::encode(Sha256::digest(&contents));
    #[cfg(unix)]
    let fingerprint = SourceFingerprint {
        device: metadata.dev(),
        inode: metadata.ino(),
        bytes: metadata.len(),
        sha256: sha256.clone(),
    };
    #[cfg(not(unix))]
    let fingerprint = SourceFingerprint {
        device: 0,
        inode: 0,
        bytes: metadata.len(),
        sha256: sha256.clone(),
    };
    let file = CharacterPackFile {
        asset_id: reference.asset_id.clone(),
        role: reference.role,
        bytes: metadata.len(),
        sha256,
        dimensions: None,
    };
    Ok(SnapshotAsset {
        source_path: path,
        file,
        fingerprint,
        contents,
    })
}

fn ensure_no_symlink_components(root: &Path, relative: &Path) -> CharacterResult<()> {
    let mut current = root.to_path_buf();
    for component in relative.components() {
        let Component::Normal(component) = component else {
            return Err(character_error(
                "character_import_pick",
                "CHARACTER-ASSET-TRAVERSAL",
                false,
            ));
        };
        current.push(component);
        let metadata = fs::symlink_metadata(&current).map_err(|_| {
            character_error("character_import_pick", "CHARACTER-ASSET-MISSING", true)
        })?;
        if metadata.file_type().is_symlink() {
            return Err(character_error(
                "character_import_pick",
                "CHARACTER-SYMLINK-NOT-ALLOWED",
                false,
            ));
        }
    }
    Ok(())
}

fn validate_asset_contents(
    asset: &mut SnapshotAsset,
    moc_version: &mut Option<u32>,
    operation: &str,
) -> CharacterResult<()> {
    match asset.file.role {
        CharacterAssetRole::Moc => {
            if asset.contents.len() < 8 || asset.contents.get(0..4) != Some(b"MOC3") {
                return Err(character_error(operation, "CHARACTER-MOC-HEADER", false));
            }
            let version = u32::from_le_bytes([
                asset.contents[4],
                asset.contents[5],
                asset.contents[6],
                asset.contents[7],
            ]);
            if version == 0 || version > MAX_MOC_VERSION {
                return Err(character_error(
                    operation,
                    "CHARACTER-MOC-UNSUPPORTED",
                    false,
                ));
            }
            *moc_version = Some(version);
        }
        CharacterAssetRole::Texture => {
            let dimensions = validate_png(&asset.contents, operation)?;
            asset.file.dimensions = Some(dimensions);
        }
        CharacterAssetRole::Model
        | CharacterAssetRole::Motion
        | CharacterAssetRole::Expression
        | CharacterAssetRole::Physics
        | CharacterAssetRole::Pose
        | CharacterAssetRole::DisplayInfo
        | CharacterAssetRole::UserData => {
            let value = parse_json(&asset.contents, operation)?;
            if !value.is_object() {
                return Err(character_error(operation, "CHARACTER-JSON-SCHEMA", false));
            }
        }
    }
    Ok(())
}

fn parse_json(contents: &[u8], operation: &str) -> CharacterResult<Value> {
    let value: Value = serde_json::from_slice(contents)
        .map_err(|_| character_error(operation, "CHARACTER-JSON-INVALID", false))?;
    if json_depth(&value) > MAX_JSON_DEPTH {
        return Err(character_error(
            operation,
            "CHARACTER-JSON-DEPTH-LIMIT",
            false,
        ));
    }
    Ok(value)
}

fn json_depth(value: &Value) -> usize {
    let mut max_depth = 1;
    let mut pending = vec![(value, 1_usize)];
    while let Some((value, depth)) = pending.pop() {
        max_depth = max_depth.max(depth);
        if depth > MAX_JSON_DEPTH {
            return depth;
        }
        match value {
            Value::Array(items) => pending.extend(items.iter().map(|item| (item, depth + 1))),
            Value::Object(items) => pending.extend(items.values().map(|item| (item, depth + 1))),
            _ => {}
        }
    }
    max_depth
}

fn validate_png(contents: &[u8], operation: &str) -> CharacterResult<CharacterDimensions> {
    let limits = png::Limits {
        bytes: 64 * 1024 * 1024,
    };
    let decoder = png::Decoder::new_with_limits(BufReader::new(Cursor::new(contents)), limits);
    let mut reader = decoder
        .read_info()
        .map_err(|_| character_error(operation, "CHARACTER-PNG-DECODE", false))?;
    let (width, height) = reader.info().size();
    if width == 0
        || height == 0
        || width > MAX_TEXTURE_DIMENSION
        || height > MAX_TEXTURE_DIMENSION
        || reader.info().animation_control.is_some()
    {
        return Err(character_error(
            operation,
            "CHARACTER-TEXTURE-DIMENSIONS",
            false,
        ));
    }
    while reader
        .next_row()
        .map_err(|_| character_error(operation, "CHARACTER-PNG-DECODE", false))?
        .is_some()
    {}
    reader
        .finish()
        .map_err(|_| character_error(operation, "CHARACTER-PNG-DECODE", false))?;
    Ok(CharacterDimensions { width, height })
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use super::*;

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("character-test-{}", uuid::Uuid::new_v4()));
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

    fn write_minimal_model(root: &Path, moc_reference: &str) {
        fs::write(
            root.join("test.model3.json"),
            format!(
                r#"{{"Version":3,"FileReferences":{{"Moc":"{moc_reference}","Textures":["texture.png"]}}}}"#
            ),
        )
        .expect("model");
        let mut moc = File::create(root.join("test.moc3")).expect("moc");
        moc.write_all(b"MOC3\x03\x00\x00\x00payload")
            .expect("moc bytes");
        let mut png = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut png, 1, 1);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder.write_header().expect("png header");
            writer.write_image_data(&[255, 0, 0, 255]).expect("png");
        }
        fs::write(root.join("texture.png"), png).expect("texture");
    }

    #[test]
    fn valid_folder_creates_opaque_manifest_without_source_path() {
        let directory = TestDirectory::new();
        write_minimal_model(directory.path(), "test.moc3");
        let snapshot = snapshot_character_folder(
            directory.path(),
            format!("custom:{}", uuid::Uuid::new_v4()),
            "2026-07-18T00:00:00Z".to_owned(),
        )
        .expect("valid snapshot");
        let public = serde_json::to_string(&snapshot.manifest).expect("manifest json");
        assert_eq!(snapshot.assets.len(), 3);
        assert!(!public.contains(directory.path().to_string_lossy().as_ref()));
        assert!(snapshot.manifest.validate("test").is_ok());
    }

    #[test]
    fn traversal_is_rejected_before_open() {
        let directory = TestDirectory::new();
        write_minimal_model(directory.path(), "../outside.moc3");
        let error = snapshot_character_folder(
            directory.path(),
            format!("custom:{}", uuid::Uuid::new_v4()),
            "2026-07-18T00:00:00Z".to_owned(),
        )
        .expect_err("traversal must fail");
        assert_eq!(error.code, "CHARACTER-ASSET-REFERENCE");
    }

    #[test]
    fn multiple_entrypoints_are_rejected() {
        let directory = TestDirectory::new();
        write_minimal_model(directory.path(), "test.moc3");
        fs::copy(
            directory.path().join("test.model3.json"),
            directory.path().join("other.model3.json"),
        )
        .expect("second model");
        let error = snapshot_character_folder(
            directory.path(),
            format!("custom:{}", uuid::Uuid::new_v4()),
            "2026-07-18T00:00:00Z".to_owned(),
        )
        .expect_err("multiple entries must fail");
        assert_eq!(error.code, "CHARACTER-MODEL3-MULTIPLE");
    }

    #[cfg(unix)]
    #[test]
    fn symlink_and_hardlink_assets_are_rejected() {
        use std::os::unix::fs::symlink;

        let directory = TestDirectory::new();
        write_minimal_model(directory.path(), "linked.moc3");
        symlink(
            directory.path().join("test.moc3"),
            directory.path().join("linked.moc3"),
        )
        .expect("symlink");
        let error = snapshot_character_folder(
            directory.path(),
            format!("custom:{}", uuid::Uuid::new_v4()),
            "2026-07-18T00:00:00Z".to_owned(),
        )
        .expect_err("symlink must fail");
        assert_eq!(error.code, "CHARACTER-SYMLINK-NOT-ALLOWED");

        fs::remove_file(directory.path().join("linked.moc3")).expect("remove symlink");
        fs::hard_link(
            directory.path().join("test.moc3"),
            directory.path().join("linked.moc3"),
        )
        .expect("hardlink");
        let error = snapshot_character_folder(
            directory.path(),
            format!("custom:{}", uuid::Uuid::new_v4()),
            "2026-07-18T00:00:00Z".to_owned(),
        )
        .expect_err("hardlink must fail");
        assert_eq!(error.code, "CHARACTER-HARDLINK-NOT-ALLOWED");
    }

    #[test]
    fn malformed_png_and_unsupported_moc_are_rejected() {
        let directory = TestDirectory::new();
        write_minimal_model(directory.path(), "test.moc3");
        fs::write(directory.path().join("texture.png"), b"not png").expect("bad png");
        let error = snapshot_character_folder(
            directory.path(),
            format!("custom:{}", uuid::Uuid::new_v4()),
            "2026-07-18T00:00:00Z".to_owned(),
        )
        .expect_err("png must fail");
        assert_eq!(error.code, "CHARACTER-PNG-DECODE");

        write_minimal_model(directory.path(), "test.moc3");
        fs::write(directory.path().join("test.moc3"), b"MOC3\x07\0\0\0payload")
            .expect("unsupported moc");
        let error = snapshot_character_folder(
            directory.path(),
            format!("custom:{}", uuid::Uuid::new_v4()),
            "2026-07-18T00:00:00Z".to_owned(),
        )
        .expect_err("moc must fail");
        assert_eq!(error.code, "CHARACTER-MOC-UNSUPPORTED");
    }

    #[test]
    fn copied_hiyori_runtime_passes_the_complete_source_gate() {
        let source = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tmp/hiyori_pro/runtime");
        let snapshot = snapshot_character_folder(
            &source,
            format!("custom:{}", uuid::Uuid::new_v4()),
            "2026-07-18T00:00:00Z".to_owned(),
        )
        .expect("reviewed Hiyori copy");
        assert_eq!(snapshot.assets.len(), 17);
        assert_eq!(snapshot.manifest.inventory.texture_count, 2);
        assert_eq!(snapshot.manifest.inventory.motion_count, 10);
        assert_eq!(snapshot.manifest.inventory.expression_count, 0);
        assert_eq!(snapshot.manifest.compatibility.moc_version, 3);
        assert!(verify_source_unchanged(&snapshot).is_ok());
    }

    #[test]
    fn source_hash_change_is_detected_before_copy() {
        let directory = TestDirectory::new();
        write_minimal_model(directory.path(), "test.moc3");
        let snapshot = snapshot_character_folder(
            directory.path(),
            format!("custom:{}", uuid::Uuid::new_v4()),
            "2026-07-18T00:00:00Z".to_owned(),
        )
        .expect("snapshot");
        fs::write(
            directory.path().join("test.moc3"),
            b"MOC3\x03\x00\x00\x00replace",
        )
        .expect("source replacement");
        let error = verify_source_unchanged(&snapshot).expect_err("hash race must fail");
        assert_eq!(error.code, "CHARACTER-SOURCE-CHANGED");
    }

    #[test]
    fn resource_and_json_limits_fail_before_publish() {
        let directory = TestDirectory::new();
        write_minimal_model(directory.path(), "test.moc3");

        let mut deep = String::new();
        for _ in 0..65 {
            deep.push('[');
        }
        deep.push('0');
        for _ in 0..65 {
            deep.push(']');
        }
        fs::write(
            directory.path().join("test.model3.json"),
            format!(
                r#"{{"Version":3,"Deep":{deep},"FileReferences":{{"Moc":"test.moc3","Textures":["texture.png"]}}}}"#
            ),
        )
        .expect("deep model");
        let error = snapshot_character_folder(
            directory.path(),
            format!("custom:{}", uuid::Uuid::new_v4()),
            "2026-07-18T00:00:00Z".to_owned(),
        )
        .expect_err("deep json must fail");
        assert_eq!(error.code, "CHARACTER-JSON-DEPTH-LIMIT");

        write_minimal_model(directory.path(), "test.moc3");
        let oversized = File::create(directory.path().join("test.moc3")).expect("oversized moc");
        oversized
            .set_len(MAX_FILE_BYTES + 1)
            .expect("sparse oversized moc");
        let error = snapshot_character_folder(
            directory.path(),
            format!("custom:{}", uuid::Uuid::new_v4()),
            "2026-07-18T00:00:00Z".to_owned(),
        )
        .expect_err("oversized asset must fail");
        assert_eq!(error.code, "CHARACTER-FILE-SIZE-LIMIT");
    }

    #[test]
    fn over_dimension_texture_is_rejected_without_full_frame_allocation() {
        let directory = TestDirectory::new();
        write_minimal_model(directory.path(), "test.moc3");
        let mut png = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut png, MAX_TEXTURE_DIMENSION + 1, 1);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder.write_header().expect("png header");
            writer
                .write_image_data(&vec![0; (MAX_TEXTURE_DIMENSION as usize + 1) * 4])
                .expect("png data");
        }
        fs::write(directory.path().join("texture.png"), png).expect("large texture");
        let error = snapshot_character_folder(
            directory.path(),
            format!("custom:{}", uuid::Uuid::new_v4()),
            "2026-07-18T00:00:00Z".to_owned(),
        )
        .expect_err("dimension must fail");
        assert_eq!(error.code, "CHARACTER-TEXTURE-DIMENSIONS");
    }

    #[test]
    fn unknown_and_remote_asset_references_are_rejected() {
        for reference in [
            "plugin.js",
            "https://example.test/model.moc3",
            "data:model.moc3",
        ] {
            let directory = TestDirectory::new();
            write_minimal_model(directory.path(), reference);
            let error = snapshot_character_folder(
                directory.path(),
                format!("custom:{}", uuid::Uuid::new_v4()),
                "2026-07-18T00:00:00Z".to_owned(),
            )
            .expect_err("unsafe reference must fail");
            assert_eq!(error.code, "CHARACTER-ASSET-REFERENCE");
        }
    }
}
