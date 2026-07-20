use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::error::{narration_error, NarrationCommandError, NarrationResult};
use super::types::{
    NarrationProvider, NarrationSettingsV2, NARRATION_SETTINGS_SCHEMA_VERSION, OPENAI_TTS_MODEL,
    OPENAI_TTS_VOICES,
};

const NARRATION_DIRECTORY: &str = "narration";
const SETTINGS_FILE: &str = "settings-v2.json";
const MAX_SETTINGS_BYTES: u64 = 32 * 1024;
const SPEED_STEP: f64 = 0.05;
const MAX_API_KEY_BYTES: usize = 512;

#[derive(Clone, Debug)]
pub(crate) struct NarrationSettingsStore {
    root: PathBuf,
    path: PathBuf,
}

#[derive(Clone)]
pub(crate) struct NarrationStoreOpen {
    pub store: NarrationSettingsStore,
    pub settings: NarrationSettingsV2,
    pub api_key: Option<String>,
    pub load_warning_code: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct StoredNarrationSettingsV2 {
    schema_version: u16,
    version: u64,
    enabled: bool,
    muted: bool,
    provider: Option<NarrationProvider>,
    api_key: Option<String>,
    model: String,
    voice: String,
    speed: f64,
}

impl StoredNarrationSettingsV2 {
    fn from_public(settings: &NarrationSettingsV2, api_key: Option<&str>) -> Self {
        Self {
            schema_version: settings.schema_version,
            version: settings.version,
            enabled: settings.enabled,
            muted: settings.muted,
            provider: settings.provider,
            api_key: api_key.map(str::to_owned),
            model: settings.model.clone(),
            voice: settings.voice.clone(),
            speed: settings.speed,
        }
    }

    fn into_public(self) -> (NarrationSettingsV2, Option<String>) {
        let api_key_configured = self.api_key.is_some();
        (
            NarrationSettingsV2 {
                schema_version: self.schema_version,
                version: self.version,
                enabled: self.enabled,
                muted: self.muted,
                provider: self.provider,
                api_key_configured,
                model: self.model,
                voice: self.voice,
                speed: self.speed,
            },
            self.api_key,
        )
    }
}

impl NarrationSettingsStore {
    pub fn open(app_data_directory: impl AsRef<Path>) -> NarrationResult<NarrationStoreOpen> {
        let root = app_data_directory.as_ref().join(NARRATION_DIRECTORY);
        ensure_private_directory(&root)?;
        let store = Self {
            path: root.join(SETTINGS_FILE),
            root,
        };
        if !store.path.exists() {
            let settings = NarrationSettingsV2::default();
            store.save(&settings, None)?;
            return Ok(NarrationStoreOpen {
                store,
                settings,
                api_key: None,
                load_warning_code: None,
            });
        }

        match store.load() {
            Ok((settings, api_key)) => Ok(NarrationStoreOpen {
                store,
                settings,
                api_key,
                load_warning_code: None,
            }),
            Err(error) => Ok(NarrationStoreOpen {
                store,
                settings: NarrationSettingsV2::default(),
                api_key: None,
                load_warning_code: Some(error.code),
            }),
        }
    }

    pub fn load(&self) -> NarrationResult<(NarrationSettingsV2, Option<String>)> {
        verify_settings_file(&self.path)?;
        let mut file = File::open(&self.path).map_err(|_| {
            narration_error("narration_get_settings", "NARRATION-SETTINGS-READ", true)
        })?;
        let size = file
            .metadata()
            .map_err(|_| {
                narration_error("narration_get_settings", "NARRATION-SETTINGS-READ", true)
            })?
            .len();
        if size > MAX_SETTINGS_BYTES {
            return Err(narration_error(
                "narration_get_settings",
                "NARRATION-SETTINGS-SIZE",
                false,
            ));
        }
        let mut bytes = Vec::with_capacity(usize::try_from(size).unwrap_or(0));
        file.read_to_end(&mut bytes).map_err(|_| {
            narration_error("narration_get_settings", "NARRATION-SETTINGS-READ", true)
        })?;
        let stored: StoredNarrationSettingsV2 = serde_json::from_slice(&bytes).map_err(|_| {
            narration_error(
                "narration_get_settings",
                "NARRATION-SETTINGS-INVALID",
                false,
            )
        })?;
        let (settings, api_key) = stored.into_public();
        validate_settings(&settings, api_key.as_deref(), "narration_get_settings")?;
        Ok((settings, api_key))
    }

    pub fn save(
        &self,
        settings: &NarrationSettingsV2,
        api_key: Option<&str>,
    ) -> NarrationResult<()> {
        validate_settings(settings, api_key, "narration_update_settings")?;
        if self.path.exists() {
            verify_settings_file(&self.path)?;
        }
        let stored = StoredNarrationSettingsV2::from_public(settings, api_key);
        let bytes = serde_json::to_vec_pretty(&stored).map_err(|_| {
            narration_error(
                "narration_update_settings",
                "NARRATION-SETTINGS-SERIALIZE",
                false,
            )
        })?;
        if bytes.len() > usize::try_from(MAX_SETTINGS_BYTES).unwrap_or(usize::MAX) {
            return Err(narration_error(
                "narration_update_settings",
                "NARRATION-SETTINGS-SIZE",
                false,
            ));
        }
        atomic_write(&self.root, &self.path, &bytes)
    }
}

pub(crate) fn validate_settings(
    settings: &NarrationSettingsV2,
    api_key: Option<&str>,
    operation: &str,
) -> NarrationResult<()> {
    if settings.schema_version != NARRATION_SETTINGS_SCHEMA_VERSION {
        return Err(narration_error(
            operation,
            "NARRATION-SCHEMA-VERSION",
            false,
        ));
    }
    if settings.api_key_configured != api_key.is_some() {
        return Err(narration_error(operation, "NARRATION-API-KEY-STATE", false));
    }
    if let Some(value) = api_key {
        validate_api_key(value, operation)?;
    }
    if settings.model != OPENAI_TTS_MODEL {
        return Err(narration_error(operation, "NARRATION-MODEL-INVALID", false));
    }
    if !OPENAI_TTS_VOICES.contains(&settings.voice.as_str()) {
        return Err(narration_error(operation, "NARRATION-VOICE-INVALID", false));
    }
    validate_speed(settings.speed, operation)?;
    if settings.provider.is_some() && api_key.is_none() {
        return Err(narration_error(
            operation,
            "NARRATION-PROVIDER-UNAVAILABLE",
            false,
        ));
    }
    if settings.enabled
        && (settings.provider != Some(NarrationProvider::OpenAi) || api_key.is_none())
    {
        return Err(narration_error(
            operation,
            "NARRATION-API-KEY-REQUIRED",
            false,
        ));
    }
    Ok(())
}

pub(crate) fn validate_api_key(value: &str, operation: &str) -> NarrationResult<()> {
    if value.is_empty()
        || value.len() > MAX_API_KEY_BYTES
        || value.trim() != value
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err(narration_error(
            operation,
            "NARRATION-API-KEY-INVALID",
            false,
        ));
    }
    Ok(())
}

pub(crate) fn validate_speed(speed: f64, operation: &str) -> NarrationResult<()> {
    if !speed.is_finite() || !(0.75..=1.25).contains(&speed) {
        return Err(narration_error(operation, "NARRATION-SPEED-INVALID", false));
    }
    let steps = ((speed - 0.75) / SPEED_STEP).round();
    let normalized = 0.75 + steps * SPEED_STEP;
    if (normalized - speed).abs() > 1e-9 {
        return Err(narration_error(operation, "NARRATION-SPEED-STEP", false));
    }
    Ok(())
}

fn ensure_private_directory(path: &Path) -> NarrationResult<()> {
    fs::create_dir_all(path)
        .map_err(|_| narration_error("narration_startup", "NARRATION-SETTINGS-DIRECTORY", false))?;
    let metadata = fs::symlink_metadata(path)
        .map_err(|_| narration_error("narration_startup", "NARRATION-SETTINGS-DIRECTORY", false))?;
    if !metadata.file_type().is_dir() || metadata.uid() != effective_uid() {
        return Err(narration_error(
            "narration_startup",
            "NARRATION-SETTINGS-OWNERSHIP",
            false,
        ));
    }
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|_| {
        narration_error("narration_startup", "NARRATION-SETTINGS-PERMISSIONS", false)
    })?;
    sync_directory(path.parent().unwrap_or(path))
}

fn verify_settings_file(path: &Path) -> NarrationResult<()> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|_| narration_error("narration_get_settings", "NARRATION-SETTINGS-READ", true))?;
    if !metadata.file_type().is_file()
        || metadata.uid() != effective_uid()
        || metadata.mode() & 0o077 != 0
    {
        return Err(narration_error(
            "narration_get_settings",
            "NARRATION-SETTINGS-OWNERSHIP",
            false,
        ));
    }
    Ok(())
}

fn atomic_write(root: &Path, path: &Path, bytes: &[u8]) -> NarrationResult<()> {
    let temporary = root.join(format!("settings-v2.{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.create_new(true).write(true).mode(0o600);
        let mut file = options.open(&temporary).map_err(|_| {
            narration_error(
                "narration_update_settings",
                "NARRATION-SETTINGS-WRITE",
                true,
            )
        })?;
        file.set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|_| {
                narration_error(
                    "narration_update_settings",
                    "NARRATION-SETTINGS-PERMISSIONS",
                    false,
                )
            })?;
        file.write_all(bytes).map_err(|_| {
            narration_error(
                "narration_update_settings",
                "NARRATION-SETTINGS-WRITE",
                true,
            )
        })?;
        file.sync_all().map_err(|_| {
            narration_error("narration_update_settings", "NARRATION-SETTINGS-SYNC", true)
        })?;
        fs::rename(&temporary, path).map_err(|_| {
            narration_error(
                "narration_update_settings",
                "NARRATION-SETTINGS-RENAME",
                true,
            )
        })?;
        sync_directory(root)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn sync_directory(path: &Path) -> NarrationResult<()> {
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| narration_error("narration_update_settings", "NARRATION-SETTINGS-SYNC", true))
}

pub(crate) fn remap_settings_error(
    error: NarrationCommandError,
    operation: &'static str,
) -> NarrationCommandError {
    error.with_operation(operation)
}

fn effective_uid() -> u32 {
    // SAFETY: geteuid has no arguments and returns the current process identity.
    unsafe { libc::geteuid() }
}
