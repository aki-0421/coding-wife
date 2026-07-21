use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::platform_fs::{current_user_id, MetadataExt, OpenOptionsExt, PermissionsExt};

use super::error::{preferences_error, AppPreferencesResult};
use super::types::{
    AppLocale, AppPreferencesV2, LegacyAppPreferencesV0, LegacyAppPreferencesV1,
    APP_PREFERENCES_SCHEMA_VERSION, APP_PREFERENCES_V0_SCHEMA_VERSION,
    APP_PREFERENCES_V1_SCHEMA_VERSION,
};

const PREFERENCES_DIRECTORY: &str = "preferences";
const PREFERENCES_FILE: &str = "app-preferences-v1.json";
const MAX_PREFERENCES_BYTES: u64 = 32 * 1024;

pub(crate) const RECOVERY_MISSING: &str = "APP-PREFERENCES-MISSING";
pub(crate) const RECOVERY_CORRUPT: &str = "APP-PREFERENCES-CORRUPT";
pub(crate) const RECOVERY_UNKNOWN_VERSION: &str = "APP-PREFERENCES-UNKNOWN-VERSION";
pub(crate) const RECOVERY_UNSAFE_FILE: &str = "APP-PREFERENCES-UNSAFE-FILE";
pub(crate) const RECOVERY_MIGRATION_FAILED: &str = "APP-PREFERENCES-MIGRATION-FAILED";

#[derive(Clone, Debug)]
pub(crate) struct AppPreferencesStore {
    root: PathBuf,
    path: PathBuf,
}

#[derive(Clone, Debug)]
pub(crate) struct AppPreferencesStoreOpen {
    pub store: AppPreferencesStore,
    pub preferences: Option<AppPreferencesV2>,
    pub recovery_code: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum LoadIssue {
    Corrupt,
    UnknownVersion,
    UnsafeFile,
}

enum LoadedPreferences {
    Current(AppPreferencesV2),
    LegacyV1(LegacyAppPreferencesV1),
    LegacyV0(LegacyAppPreferencesV0),
}

impl AppPreferencesStore {
    pub fn open(
        app_data_directory: impl AsRef<Path>,
    ) -> AppPreferencesResult<AppPreferencesStoreOpen> {
        let root = app_data_directory.as_ref().join(PREFERENCES_DIRECTORY);
        ensure_private_directory(&root)?;
        let store = Self {
            path: root.join(PREFERENCES_FILE),
            root,
        };
        if !store.path.exists() {
            return Ok(AppPreferencesStoreOpen {
                store,
                preferences: None,
                recovery_code: Some(RECOVERY_MISSING.to_owned()),
            });
        }

        match store.load() {
            Ok(LoadedPreferences::Current(preferences)) => Ok(AppPreferencesStoreOpen {
                store,
                preferences: Some(preferences),
                recovery_code: None,
            }),
            Ok(LoadedPreferences::LegacyV1(legacy)) => {
                match store.migrate(legacy.version, legacy.locale) {
                    Ok(preferences) => Ok(AppPreferencesStoreOpen {
                        store,
                        preferences: Some(preferences),
                        recovery_code: None,
                    }),
                    Err(_) => Ok(AppPreferencesStoreOpen {
                        store,
                        preferences: None,
                        recovery_code: Some(RECOVERY_MIGRATION_FAILED.to_owned()),
                    }),
                }
            }
            Ok(LoadedPreferences::LegacyV0(legacy)) => {
                match store.migrate(legacy.version, legacy.locale) {
                    Ok(preferences) => Ok(AppPreferencesStoreOpen {
                        store,
                        preferences: Some(preferences),
                        recovery_code: None,
                    }),
                    Err(_) => Ok(AppPreferencesStoreOpen {
                        store,
                        preferences: None,
                        recovery_code: Some(RECOVERY_MIGRATION_FAILED.to_owned()),
                    }),
                }
            }
            Err(issue) => Ok(AppPreferencesStoreOpen {
                store,
                preferences: None,
                recovery_code: Some(
                    match issue {
                        LoadIssue::Corrupt => RECOVERY_CORRUPT,
                        LoadIssue::UnknownVersion => RECOVERY_UNKNOWN_VERSION,
                        LoadIssue::UnsafeFile => RECOVERY_UNSAFE_FILE,
                    }
                    .to_owned(),
                ),
            }),
        }
    }

    fn load(&self) -> Result<LoadedPreferences, LoadIssue> {
        verify_preferences_file(&self.path).map_err(|_| LoadIssue::UnsafeFile)?;
        let mut file = File::open(&self.path).map_err(|_| LoadIssue::UnsafeFile)?;
        let size = file.metadata().map_err(|_| LoadIssue::UnsafeFile)?.len();
        if size == 0 || size > MAX_PREFERENCES_BYTES {
            return Err(LoadIssue::Corrupt);
        }
        let mut bytes = Vec::with_capacity(usize::try_from(size).unwrap_or(0));
        file.read_to_end(&mut bytes)
            .map_err(|_| LoadIssue::UnsafeFile)?;
        let value: Value = serde_json::from_slice(&bytes).map_err(|_| LoadIssue::Corrupt)?;
        let schema_version = value
            .get("schemaVersion")
            .and_then(Value::as_u64)
            .ok_or(LoadIssue::Corrupt)?;
        match schema_version {
            version if version == u64::from(APP_PREFERENCES_SCHEMA_VERSION) => {
                let preferences: AppPreferencesV2 =
                    serde_json::from_value(value).map_err(|_| LoadIssue::Corrupt)?;
                validate_preferences(&preferences).map_err(|_| LoadIssue::Corrupt)?;
                Ok(LoadedPreferences::Current(preferences))
            }
            version if version == u64::from(APP_PREFERENCES_V1_SCHEMA_VERSION) => {
                let preferences: LegacyAppPreferencesV1 =
                    serde_json::from_value(value).map_err(|_| LoadIssue::Corrupt)?;
                if preferences.schema_version != APP_PREFERENCES_V1_SCHEMA_VERSION {
                    return Err(LoadIssue::Corrupt);
                }
                let snapshot = uuid::Uuid::parse_str(&preferences.snapshot_id)
                    .map_err(|_| LoadIssue::Corrupt)?;
                if snapshot.is_nil() {
                    return Err(LoadIssue::Corrupt);
                }
                Ok(LoadedPreferences::LegacyV1(preferences))
            }
            version if version == u64::from(APP_PREFERENCES_V0_SCHEMA_VERSION) => {
                let preferences: LegacyAppPreferencesV0 =
                    serde_json::from_value(value).map_err(|_| LoadIssue::Corrupt)?;
                if preferences.schema_version != APP_PREFERENCES_V0_SCHEMA_VERSION {
                    return Err(LoadIssue::Corrupt);
                }
                Ok(LoadedPreferences::LegacyV0(preferences))
            }
            _ => Err(LoadIssue::UnknownVersion),
        }
    }

    fn migrate(
        &self,
        legacy_version: u64,
        locale: AppLocale,
    ) -> AppPreferencesResult<AppPreferencesV2> {
        let version = legacy_version.checked_add(1).ok_or_else(|| {
            preferences_error("app_preferences_migrate", "APP-PREFERENCES-VERSION", false)
        })?;
        let preferences = AppPreferencesV2 {
            schema_version: APP_PREFERENCES_SCHEMA_VERSION,
            version,
            snapshot_id: uuid::Uuid::new_v4().to_string(),
            locale,
        };
        self.save(&preferences, "app_preferences_migrate")?;
        Ok(preferences)
    }

    pub fn save(
        &self,
        preferences: &AppPreferencesV2,
        operation: &'static str,
    ) -> AppPreferencesResult<()> {
        validate_preferences(preferences).map_err(|error| error.with_operation(operation))?;
        if self.path.exists() {
            verify_preferences_file(&self.path).map_err(|error| error.with_operation(operation))?;
        }
        let bytes = serde_json::to_vec_pretty(preferences)
            .map_err(|_| preferences_error(operation, "APP-PREFERENCES-SERIALIZE", false))?;
        if bytes.len() > usize::try_from(MAX_PREFERENCES_BYTES).unwrap_or(usize::MAX) {
            return Err(preferences_error(operation, "APP-PREFERENCES-SIZE", false));
        }
        atomic_write(&self.root, &self.path, &bytes, operation)
    }

    #[cfg(test)]
    pub(crate) fn path(&self) -> &Path {
        &self.path
    }
}

pub(crate) fn validate_preferences(preferences: &AppPreferencesV2) -> AppPreferencesResult<()> {
    if preferences.schema_version != APP_PREFERENCES_SCHEMA_VERSION {
        return Err(preferences_error(
            "app_preferences_validate",
            "APP-PREFERENCES-SCHEMA-VERSION",
            false,
        ));
    }
    let snapshot = uuid::Uuid::parse_str(&preferences.snapshot_id).map_err(|_| {
        preferences_error(
            "app_preferences_validate",
            "APP-PREFERENCES-SNAPSHOT-ID",
            false,
        )
    })?;
    if snapshot.is_nil() {
        return Err(preferences_error(
            "app_preferences_validate",
            "APP-PREFERENCES-SNAPSHOT-ID",
            false,
        ));
    }
    Ok(())
}

fn ensure_private_directory(path: &Path) -> AppPreferencesResult<()> {
    fs::create_dir_all(path).map_err(|_| {
        preferences_error(
            "app_preferences_startup",
            "APP-PREFERENCES-DIRECTORY",
            false,
        )
    })?;
    let metadata = fs::symlink_metadata(path).map_err(|_| {
        preferences_error(
            "app_preferences_startup",
            "APP-PREFERENCES-DIRECTORY",
            false,
        )
    })?;
    if !metadata.file_type().is_dir() || metadata.uid() != effective_uid() {
        return Err(preferences_error(
            "app_preferences_startup",
            "APP-PREFERENCES-OWNERSHIP",
            false,
        ));
    }
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|_| {
        preferences_error(
            "app_preferences_startup",
            "APP-PREFERENCES-PERMISSIONS",
            false,
        )
    })?;
    sync_directory(path.parent().unwrap_or(path), "app_preferences_startup")
}

fn verify_preferences_file(path: &Path) -> AppPreferencesResult<()> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|_| preferences_error("app_preferences_get", "APP-PREFERENCES-READ", true))?;
    if !metadata.file_type().is_file()
        || metadata.uid() != effective_uid()
        || metadata.mode() & 0o077 != 0
    {
        return Err(preferences_error(
            "app_preferences_get",
            "APP-PREFERENCES-UNSAFE-FILE",
            false,
        ));
    }
    Ok(())
}

fn atomic_write(
    root: &Path,
    path: &Path,
    bytes: &[u8],
    operation: &'static str,
) -> AppPreferencesResult<()> {
    let temporary = root.join(format!(".app-preferences-v2.{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.create_new(true).write(true).mode(0o600);
        let mut file = options
            .open(&temporary)
            .map_err(|_| preferences_error(operation, "APP-PREFERENCES-WRITE", true))?;
        file.set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|_| preferences_error(operation, "APP-PREFERENCES-PERMISSIONS", false))?;
        file.write_all(bytes)
            .map_err(|_| preferences_error(operation, "APP-PREFERENCES-WRITE", true))?;
        file.sync_all()
            .map_err(|_| preferences_error(operation, "APP-PREFERENCES-SYNC", true))?;
        fs::rename(&temporary, path)
            .map_err(|_| preferences_error(operation, "APP-PREFERENCES-RENAME", true))?;
        sync_directory(root, operation)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn sync_directory(path: &Path, operation: &'static str) -> AppPreferencesResult<()> {
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| preferences_error(operation, "APP-PREFERENCES-SYNC", true))
}

fn effective_uid() -> u32 {
    current_user_id()
}
