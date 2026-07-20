use std::fs;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};

use serde_json::json;

use super::store::{
    AppPreferencesStore, RECOVERY_CORRUPT, RECOVERY_MISSING, RECOVERY_UNKNOWN_VERSION,
};
use super::types::{
    AppLocale, AppPreferencesGetRequestV2, AppPreferencesUpdateRequestV2,
    APP_PREFERENCES_SCHEMA_VERSION,
};
use super::AppPreferencesService;

fn temporary_directory(label: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "coding-wife-preferences-{label}-{}",
        uuid::Uuid::new_v4()
    ));
    fs::create_dir_all(&path).expect("temporary app data directory");
    path
}

fn get_request(default_locale: AppLocale) -> AppPreferencesGetRequestV2 {
    AppPreferencesGetRequestV2 {
        schema_version: APP_PREFERENCES_SCHEMA_VERSION,
        default_locale,
    }
}

fn update_request(expected_version: u64, locale: AppLocale) -> AppPreferencesUpdateRequestV2 {
    AppPreferencesUpdateRequestV2 {
        schema_version: APP_PREFERENCES_SCHEMA_VERSION,
        expected_version,
        locale,
    }
}

fn write_private_json(path: &Path, value: serde_json::Value) {
    fs::create_dir_all(path.parent().expect("preferences parent")).expect("preferences directory");
    fs::write(
        path,
        serde_json::to_vec_pretty(&value).expect("fixture json"),
    )
    .expect("fixture write");
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).expect("fixture permissions");
}

#[test]
fn missing_defaults_are_safe_then_locale_update_survives_restart() {
    let app_data = temporary_directory("restart");
    let service = AppPreferencesService::production(&app_data);
    let initial = service.get(get_request(AppLocale::Ja)).expect("initial");
    assert_eq!(initial.schema_version, 2);
    assert_eq!(initial.recovery_code.as_deref(), Some(RECOVERY_MISSING));
    assert_eq!(initial.preferences.locale, AppLocale::Ja);
    assert_eq!(initial.preferences.version, 0);
    assert!(!app_data
        .join("preferences/app-preferences-v1.json")
        .exists());

    let saved = service
        .update(update_request(initial.preferences.version, AppLocale::En))
        .expect("save preferences");
    assert_eq!(saved.recovery_code, None);
    assert_eq!(saved.preferences.version, 1);

    let preferences_path = app_data.join("preferences/app-preferences-v1.json");
    let file_metadata = fs::symlink_metadata(&preferences_path).expect("preferences metadata");
    assert_eq!(file_metadata.uid(), effective_uid());
    assert_eq!(file_metadata.mode() & 0o777, 0o600);
    let directory_metadata =
        fs::symlink_metadata(app_data.join("preferences")).expect("directory metadata");
    assert_eq!(directory_metadata.mode() & 0o777, 0o700);
    assert!(fs::read_dir(app_data.join("preferences"))
        .expect("preferences entries")
        .all(|entry| !entry
            .expect("preference entry")
            .file_name()
            .to_string_lossy()
            .ends_with(".tmp")));

    let reopened = AppPreferencesService::production(&app_data)
        .get(get_request(AppLocale::Ja))
        .expect("reopened preferences");
    assert_eq!(reopened, saved);
    fs::remove_dir_all(app_data).expect("cleanup");
}

#[test]
fn v1_migration_keeps_locale_and_drops_retired_display_fields() {
    let app_data = temporary_directory("v1-migration");
    let path = app_data.join("preferences/app-preferences-v1.json");
    write_private_json(
        &path,
        json!({
            "schemaVersion": 1,
            "version": 7,
            "snapshotId": "123e4567-e89b-42d3-a456-426614174000",
            "locale": "ja",
            "reducedMotion": "on",
            "characterVisibility": "hidden"
        }),
    );

    let migrated = AppPreferencesService::production(&app_data)
        .get(get_request(AppLocale::En))
        .expect("migrated preferences");
    assert_eq!(migrated.schema_version, 2);
    assert_eq!(migrated.preferences.schema_version, 2);
    assert_eq!(migrated.preferences.version, 8);
    assert_eq!(migrated.preferences.locale, AppLocale::Ja);
    assert_eq!(migrated.recovery_code, None);

    let persisted: serde_json::Value =
        serde_json::from_slice(&fs::read(&path).expect("migrated file")).expect("migrated json");
    assert_eq!(persisted.get("schemaVersion"), Some(&json!(2)));
    assert!(persisted.get("reducedMotion").is_none());
    assert!(persisted.get("characterVisibility").is_none());
    fs::remove_dir_all(app_data).expect("cleanup");
}

#[test]
fn v0_migration_keeps_locale_and_drops_retired_display_fields() {
    let app_data = temporary_directory("v0-migration");
    let path = app_data.join("preferences/app-preferences-v1.json");
    write_private_json(
        &path,
        json!({
            "schemaVersion": 0,
            "version": 4,
            "locale": "ja",
            "reducedMotion": true,
            "characterHidden": true
        }),
    );

    let migrated = AppPreferencesService::production(&app_data)
        .get(get_request(AppLocale::En))
        .expect("migrated preferences");
    assert_eq!(migrated.preferences.version, 5);
    assert_eq!(migrated.preferences.locale, AppLocale::Ja);
    assert_eq!(migrated.recovery_code, None);

    let persisted: serde_json::Value =
        serde_json::from_slice(&fs::read(&path).expect("migrated file")).expect("migrated json");
    assert_eq!(persisted.get("schemaVersion"), Some(&json!(2)));
    assert!(persisted.get("reducedMotion").is_none());
    assert!(persisted.get("characterHidden").is_none());
    fs::remove_dir_all(app_data).expect("cleanup");
}

#[test]
fn corrupt_and_unknown_records_fail_closed_without_exposing_values() {
    for (label, fixture, recovery) in [
        ("corrupt", json!({"schemaVersion": 2}), RECOVERY_CORRUPT),
        (
            "unknown",
            json!({
                "schemaVersion": 99,
                "secret": "opaque-private-value"
            }),
            RECOVERY_UNKNOWN_VERSION,
        ),
    ] {
        let app_data = temporary_directory(label);
        write_private_json(
            &app_data.join("preferences/app-preferences-v1.json"),
            fixture,
        );
        let service = AppPreferencesService::production(&app_data);
        let snapshot = service
            .get(get_request(AppLocale::En))
            .expect("safe snapshot");
        assert_eq!(snapshot.recovery_code.as_deref(), Some(recovery));
        assert_eq!(snapshot.preferences.version, 0);
        assert_eq!(snapshot.preferences.locale, AppLocale::En);
        let serialized = serde_json::to_string(&snapshot).expect("safe snapshot json");
        assert!(!serialized.contains("opaque-private-value"));

        let repaired = service
            .update(update_request(
                snapshot.preferences.version,
                snapshot.preferences.locale,
            ))
            .expect("repair with current locale");
        assert_eq!(repaired.recovery_code, None);
        assert_eq!(repaired.preferences.version, 1);
        assert_eq!(
            AppPreferencesService::production(&app_data)
                .get(get_request(AppLocale::Ja))
                .expect("restart after repair"),
            repaired
        );
        fs::remove_dir_all(app_data).expect("cleanup");
    }
}

#[test]
fn stale_expected_version_is_rejected_without_mutation() {
    let app_data = temporary_directory("conflict");
    let service = AppPreferencesService::production(&app_data);
    service
        .update(update_request(0, AppLocale::Ja))
        .expect("first update");

    let error = service
        .update(update_request(0, AppLocale::En))
        .expect_err("stale update");
    assert_eq!(error.code, "APP-PREFERENCES-CONFLICT");
    let current = service.get(get_request(AppLocale::En)).expect("current");
    assert_eq!(current.preferences.locale, AppLocale::Ja);
    assert_eq!(current.preferences.version, 1);
    fs::remove_dir_all(app_data).expect("cleanup");
}

#[test]
fn store_path_remains_the_deployed_global_preferences_path() {
    let app_data = temporary_directory("global-path");
    let opened = AppPreferencesStore::open(&app_data).expect("open store");
    assert_eq!(
        opened.store.path(),
        app_data.join("preferences/app-preferences-v1.json")
    );
    fs::remove_dir_all(app_data).expect("cleanup");
}

fn effective_uid() -> u32 {
    // SAFETY: geteuid has no arguments and returns the current process identity.
    unsafe { libc::geteuid() }
}
