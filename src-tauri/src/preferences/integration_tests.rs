use std::fs;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};

use serde_json::json;

use super::store::{
    AppPreferencesStore, RECOVERY_CORRUPT, RECOVERY_MISSING, RECOVERY_UNKNOWN_VERSION,
};
use super::types::{
    AppLocale, AppPreferencesGetRequestV1, AppPreferencesResetRequestV1,
    AppPreferencesUpdateRequestV1, CharacterVisibility, ReducedMotionPreference,
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

fn get_request(default_locale: AppLocale) -> AppPreferencesGetRequestV1 {
    AppPreferencesGetRequestV1 {
        schema_version: APP_PREFERENCES_SCHEMA_VERSION,
        default_locale,
    }
}

fn update_request(
    expected_version: u64,
    locale: AppLocale,
    reduced_motion: ReducedMotionPreference,
    character_visibility: CharacterVisibility,
) -> AppPreferencesUpdateRequestV1 {
    AppPreferencesUpdateRequestV1 {
        schema_version: APP_PREFERENCES_SCHEMA_VERSION,
        expected_version,
        locale,
        reduced_motion,
        character_visibility,
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
fn missing_defaults_are_safe_then_update_survives_restart_atomically() {
    let app_data = temporary_directory("restart");
    let service = AppPreferencesService::production(&app_data);
    let initial = service.get(get_request(AppLocale::Ja)).expect("initial");
    assert_eq!(initial.recovery_code.as_deref(), Some(RECOVERY_MISSING));
    assert_eq!(initial.preferences.locale, AppLocale::Ja);
    assert_eq!(initial.preferences.version, 0);
    assert!(!app_data
        .join("preferences/app-preferences-v1.json")
        .exists());

    let saved = service
        .update(update_request(
            initial.preferences.version,
            AppLocale::En,
            ReducedMotionPreference::On,
            CharacterVisibility::Hidden,
        ))
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

    fs::remove_dir_all(app_data).expect("remove fixture");
}

#[test]
fn known_legacy_record_migrates_once_and_restart_uses_exact_v1_snapshot() {
    let app_data = temporary_directory("migration");
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
    assert_eq!(migrated.recovery_code, None);
    assert_eq!(migrated.preferences.version, 5);
    assert_eq!(migrated.preferences.locale, AppLocale::Ja);
    assert_eq!(
        migrated.preferences.reduced_motion,
        ReducedMotionPreference::On
    );
    assert_eq!(
        migrated.preferences.character_visibility,
        CharacterVisibility::Hidden
    );
    let persisted: serde_json::Value =
        serde_json::from_slice(&fs::read(&path).expect("migrated bytes")).expect("migrated json");
    assert_eq!(persisted["schemaVersion"], 1);
    assert_eq!(
        AppPreferencesService::production(&app_data)
            .get(get_request(AppLocale::En))
            .expect("restart after migration"),
        migrated
    );

    fs::remove_dir_all(app_data).expect("remove fixture");
}

#[test]
fn corrupt_and_unknown_versions_fail_closed_without_exposing_raw_values() {
    for (label, bytes, expected_code) in [
        (
            "corrupt",
            br#"{"locale":"stolen"}"#.as_slice(),
            RECOVERY_CORRUPT,
        ),
        (
            "unknown",
            br#"{"schemaVersion":99,"locale":"stolen"}"#.as_slice(),
            RECOVERY_UNKNOWN_VERSION,
        ),
    ] {
        let app_data = temporary_directory(label);
        let path = app_data.join("preferences/app-preferences-v1.json");
        fs::create_dir_all(path.parent().expect("preferences parent"))
            .expect("preferences directory");
        fs::write(&path, bytes).expect("fixture write");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).expect("fixture permissions");
        let snapshot = AppPreferencesService::production(&app_data)
            .get(get_request(AppLocale::Ja))
            .expect("safe recovery snapshot");
        assert_eq!(snapshot.recovery_code.as_deref(), Some(expected_code));
        assert_eq!(snapshot.preferences.locale, AppLocale::Ja);
        assert_eq!(snapshot.preferences.version, 0);
        let serialized = serde_json::to_string(&snapshot).expect("safe snapshot json");
        assert!(!serialized.contains("stolen"));

        let recovered = AppPreferencesService::production(&app_data)
            .reset(AppPreferencesResetRequestV1 {
                schema_version: APP_PREFERENCES_SCHEMA_VERSION,
                expected_version: snapshot.preferences.version,
                default_locale: AppLocale::Ja,
            })
            .expect("reset recovery snapshot");
        assert_eq!(recovered.recovery_code, None);
        assert_eq!(recovered.preferences.version, 1);
        assert_eq!(
            AppPreferencesService::production(&app_data)
                .get(get_request(AppLocale::En))
                .expect("restart after recovery reset"),
            recovered
        );
        fs::remove_dir_all(app_data).expect("remove fixture");
    }
}

#[test]
fn reset_changes_only_the_global_preference_record_across_workspace_sentinels() {
    let app_data = temporary_directory("reset-scope");
    let workspace_one = app_data.join("workspace-history/workspace-one.db");
    let workspace_two = app_data.join("workspace-history/workspace-two.db");
    let context = app_data.join("context/project.json");
    let model = app_data.join("characters/library/pack.json");
    let git = app_data.join("git/review-state.json");
    let narration = app_data.join("narration/settings-v1.json");
    for (path, contents) in [
        (&workspace_one, b"workspace-one".as_slice()),
        (&workspace_two, b"workspace-two".as_slice()),
        (&context, b"context".as_slice()),
        (&model, b"model".as_slice()),
        (&git, b"git".as_slice()),
        (&narration, b"narration".as_slice()),
    ] {
        fs::create_dir_all(path.parent().expect("sentinel parent")).expect("sentinel directory");
        fs::write(path, contents).expect("sentinel write");
    }

    let service = AppPreferencesService::production(&app_data);
    let saved = service
        .update(update_request(
            0,
            AppLocale::En,
            ReducedMotionPreference::Off,
            CharacterVisibility::Hidden,
        ))
        .expect("save non-default preferences");
    let reset = service
        .reset(AppPreferencesResetRequestV1 {
            schema_version: APP_PREFERENCES_SCHEMA_VERSION,
            expected_version: saved.preferences.version,
            default_locale: AppLocale::Ja,
        })
        .expect("reset preferences");
    assert_eq!(reset.preferences.locale, AppLocale::Ja);
    assert_eq!(
        reset.preferences.reduced_motion,
        ReducedMotionPreference::System
    );
    assert_eq!(
        reset.preferences.character_visibility,
        CharacterVisibility::Visible
    );
    assert_eq!(
        fs::read(workspace_one).expect("workspace one"),
        b"workspace-one"
    );
    assert_eq!(
        fs::read(workspace_two).expect("workspace two"),
        b"workspace-two"
    );
    assert_eq!(fs::read(context).expect("context"), b"context");
    assert_eq!(fs::read(model).expect("model"), b"model");
    assert_eq!(fs::read(git).expect("git"), b"git");
    assert_eq!(fs::read(narration).expect("narration"), b"narration");

    fs::remove_dir_all(app_data).expect("remove fixture");
}

#[test]
fn stale_expected_version_cannot_replace_the_current_snapshot() {
    let app_data = temporary_directory("conflict");
    let service = AppPreferencesService::production(&app_data);
    let saved = service
        .update(update_request(
            0,
            AppLocale::Ja,
            ReducedMotionPreference::System,
            CharacterVisibility::Visible,
        ))
        .expect("first save");
    let error = service
        .update(update_request(
            0,
            AppLocale::En,
            ReducedMotionPreference::On,
            CharacterVisibility::Hidden,
        ))
        .expect_err("stale update must fail");
    assert_eq!(error.code, "APP-PREFERENCES-CONFLICT");
    assert_eq!(
        service
            .get(get_request(AppLocale::En))
            .expect("current snapshot"),
        saved
    );
    fs::remove_dir_all(app_data).expect("remove fixture");
}

#[test]
fn store_path_remains_outside_workspace_scoped_directories() {
    let app_data = temporary_directory("global-path");
    let opened = AppPreferencesStore::open(&app_data).expect("open store");
    assert_eq!(
        opened.store.path(),
        app_data.join("preferences/app-preferences-v1.json")
    );
    fs::remove_dir_all(app_data).expect("remove fixture");
}

fn effective_uid() -> u32 {
    // SAFETY: geteuid has no arguments and returns the current process identity.
    unsafe { libc::geteuid() }
}
