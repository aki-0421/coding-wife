use std::path::Path;
use std::sync::{Arc, Mutex};

use super::error::{preferences_error, AppPreferencesResult};
use super::store::AppPreferencesStore;
use super::types::{
    AppLocale, AppPreferencesGetRequestV2, AppPreferencesPersistence, AppPreferencesSnapshotV2,
    AppPreferencesUpdateRequestV2, AppPreferencesV2, APP_PREFERENCES_SCHEMA_VERSION,
};

const RECOVERY_UNAVAILABLE: &str = "APP-PREFERENCES-UNAVAILABLE";

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct AppPreferencesReadiness {
    pub schema_version: u16,
    pub recovery_code: Option<String>,
    pub store_available: bool,
}

#[derive(Debug)]
struct AppPreferencesState {
    store: Option<AppPreferencesStore>,
    preferences: Option<AppPreferencesV2>,
    recovery_code: Option<String>,
}

#[derive(Clone, Debug)]
pub struct AppPreferencesService {
    state: Arc<Mutex<AppPreferencesState>>,
}

impl AppPreferencesService {
    pub fn production(app_data_directory: impl AsRef<Path>) -> Self {
        let state = match AppPreferencesStore::open(app_data_directory) {
            Ok(opened) => AppPreferencesState {
                store: Some(opened.store),
                preferences: opened.preferences,
                recovery_code: opened.recovery_code,
            },
            Err(_) => AppPreferencesState {
                store: None,
                preferences: None,
                recovery_code: Some(RECOVERY_UNAVAILABLE.to_owned()),
            },
        };
        Self {
            state: Arc::new(Mutex::new(state)),
        }
    }

    pub fn get(
        &self,
        request: AppPreferencesGetRequestV2,
    ) -> AppPreferencesResult<AppPreferencesSnapshotV2> {
        validate_schema(request.schema_version, "app_preferences_get")?;
        let state = self
            .state
            .lock()
            .map_err(|_| preferences_error("app_preferences_get", "APP-PREFERENCES-STATE", true))?;
        Ok(snapshot(&state, request.default_locale))
    }

    pub fn update(
        &self,
        request: AppPreferencesUpdateRequestV2,
    ) -> AppPreferencesResult<AppPreferencesSnapshotV2> {
        validate_schema(request.schema_version, "app_preferences_update")?;
        let mut state = self.state.lock().map_err(|_| {
            preferences_error("app_preferences_update", "APP-PREFERENCES-STATE", true)
        })?;
        require_expected_version(&state, request.expected_version, "app_preferences_update")?;
        let next = AppPreferencesV2 {
            schema_version: APP_PREFERENCES_SCHEMA_VERSION,
            version: next_version(request.expected_version, "app_preferences_update")?,
            snapshot_id: uuid::Uuid::new_v4().to_string(),
            locale: request.locale,
        };
        persist(&mut state, &next, "app_preferences_update")?;
        Ok(snapshot(&state, request.locale))
    }

    pub(crate) fn readiness(&self) -> AppPreferencesReadiness {
        match self.state.lock() {
            Ok(state) => AppPreferencesReadiness {
                schema_version: APP_PREFERENCES_SCHEMA_VERSION,
                recovery_code: state.recovery_code.clone(),
                store_available: state.store.is_some(),
            },
            Err(_) => AppPreferencesReadiness {
                schema_version: APP_PREFERENCES_SCHEMA_VERSION,
                recovery_code: Some(RECOVERY_UNAVAILABLE.to_owned()),
                store_available: false,
            },
        }
    }
}

fn snapshot(state: &AppPreferencesState, default_locale: AppLocale) -> AppPreferencesSnapshotV2 {
    AppPreferencesSnapshotV2 {
        schema_version: APP_PREFERENCES_SCHEMA_VERSION,
        preferences: state
            .preferences
            .clone()
            .unwrap_or_else(|| AppPreferencesV2::safe_default(default_locale)),
        persistence: AppPreferencesPersistence::Native,
        recovery_code: state.recovery_code.clone(),
    }
}

fn persist(
    state: &mut AppPreferencesState,
    next: &AppPreferencesV2,
    operation: &'static str,
) -> AppPreferencesResult<()> {
    let store = state
        .store
        .as_ref()
        .ok_or_else(|| preferences_error(operation, "APP-PREFERENCES-UNAVAILABLE", true))?;
    store.save(next, operation)?;
    state.preferences = Some(next.clone());
    state.recovery_code = None;
    Ok(())
}

fn require_expected_version(
    state: &AppPreferencesState,
    expected_version: u64,
    operation: &'static str,
) -> AppPreferencesResult<()> {
    let current_version = state
        .preferences
        .as_ref()
        .map_or(0, |preferences| preferences.version);
    if current_version != expected_version {
        return Err(preferences_error(
            operation,
            "APP-PREFERENCES-CONFLICT",
            true,
        ));
    }
    Ok(())
}

fn next_version(current: u64, operation: &'static str) -> AppPreferencesResult<u64> {
    current
        .checked_add(1)
        .ok_or_else(|| preferences_error(operation, "APP-PREFERENCES-VERSION", false))
}

fn validate_schema(schema_version: u16, operation: &'static str) -> AppPreferencesResult<()> {
    if schema_version != APP_PREFERENCES_SCHEMA_VERSION {
        return Err(preferences_error(
            operation,
            "APP-PREFERENCES-SCHEMA-VERSION",
            false,
        ));
    }
    Ok(())
}
