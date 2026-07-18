use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

use super::error::{narration_error, NarrationCommandError, NarrationResult};
use super::types::{NarrationSettingsV1, NARRATION_SCHEMA_VERSION};

const NARRATION_DIRECTORY: &str = "narration";
const SETTINGS_FILE: &str = "settings-v1.json";
const MAX_SETTINGS_BYTES: u64 = 32 * 1024;
const RATE_STEP: f64 = 0.05;

#[derive(Clone, Debug)]
pub(crate) struct NarrationSettingsStore {
    root: PathBuf,
    path: PathBuf,
}

#[derive(Clone, Debug)]
pub(crate) struct NarrationStoreOpen {
    pub store: NarrationSettingsStore,
    pub settings: NarrationSettingsV1,
    pub load_warning_code: Option<String>,
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
            let settings = NarrationSettingsV1::default();
            store.save(&settings)?;
            return Ok(NarrationStoreOpen {
                store,
                settings,
                load_warning_code: None,
            });
        }

        match store.load() {
            Ok(settings) => Ok(NarrationStoreOpen {
                store,
                settings,
                load_warning_code: None,
            }),
            Err(error) => Ok(NarrationStoreOpen {
                store,
                settings: NarrationSettingsV1::default(),
                load_warning_code: Some(error.code),
            }),
        }
    }

    pub fn load(&self) -> NarrationResult<NarrationSettingsV1> {
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
        let settings: NarrationSettingsV1 = serde_json::from_slice(&bytes).map_err(|_| {
            narration_error(
                "narration_get_settings",
                "NARRATION-SETTINGS-INVALID",
                false,
            )
        })?;
        validate_settings(&settings, "narration_get_settings")?;
        Ok(settings)
    }

    pub fn save(&self, settings: &NarrationSettingsV1) -> NarrationResult<()> {
        validate_settings(settings, "narration_update_settings")?;
        if self.path.exists() {
            verify_settings_file(&self.path)?;
        }
        let bytes = serde_json::to_vec_pretty(settings).map_err(|_| {
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
    settings: &NarrationSettingsV1,
    operation: &str,
) -> NarrationResult<()> {
    if settings.schema_version != NARRATION_SCHEMA_VERSION {
        return Err(narration_error(
            operation,
            "NARRATION-SCHEMA-VERSION",
            false,
        ));
    }
    validate_rate(settings.rate, operation)?;
    for voice in [settings.voices.ja.as_deref(), settings.voices.en.as_deref()]
        .into_iter()
        .flatten()
    {
        if !is_safe_voice_name(voice) {
            return Err(narration_error(operation, "NARRATION-VOICE-INVALID", false));
        }
    }
    if settings.enabled && settings.voices.ja.is_none() && settings.voices.en.is_none() {
        return Err(narration_error(
            operation,
            "NARRATION-VOICE-REQUIRED",
            false,
        ));
    }
    Ok(())
}

pub(crate) fn validate_rate(rate: f64, operation: &str) -> NarrationResult<()> {
    if !rate.is_finite() || !(0.75..=1.25).contains(&rate) {
        return Err(narration_error(operation, "NARRATION-RATE-INVALID", false));
    }
    let steps = ((rate - 0.75) / RATE_STEP).round();
    let normalized = 0.75 + steps * RATE_STEP;
    if (normalized - rate).abs() > 1e-9 {
        return Err(narration_error(operation, "NARRATION-RATE-STEP", false));
    }
    Ok(())
}

pub(crate) fn rate_to_words_per_minute(rate: f64) -> NarrationResult<u16> {
    validate_rate(rate, "narration_speak")?;
    let value = (180.0 * rate).round();
    u16::try_from(value as u64)
        .map_err(|_| narration_error("narration_speak", "NARRATION-RATE-INVALID", false))
}

fn is_safe_voice_name(voice: &str) -> bool {
    let scalar_count = voice.chars().count();
    (1..=128).contains(&scalar_count)
        && voice.trim() == voice
        && !voice.starts_with('-')
        && !voice.chars().any(char::is_control)
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
    let temporary = root.join(format!("settings-v1.{}.tmp", uuid::Uuid::new_v4()));
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
