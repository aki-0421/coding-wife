use serde::{Deserialize, Serialize};

pub const APP_PREFERENCES_SCHEMA_VERSION: u16 = 1;
pub const APP_PREFERENCES_LEGACY_SCHEMA_VERSION: u16 = 0;
pub const SAFE_DEFAULT_SNAPSHOT_ID: &str = "00000000-0000-0000-0000-000000000000";

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AppLocale {
    Ja,
    En,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReducedMotionPreference {
    System,
    On,
    Off,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CharacterVisibility {
    Visible,
    Hidden,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AppPreferencesPersistence {
    Native,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct AppPreferencesV1 {
    pub schema_version: u16,
    pub version: u64,
    pub snapshot_id: String,
    pub locale: AppLocale,
    pub reduced_motion: ReducedMotionPreference,
    pub character_visibility: CharacterVisibility,
}

impl AppPreferencesV1 {
    pub(crate) fn safe_default(locale: AppLocale) -> Self {
        Self {
            schema_version: APP_PREFERENCES_SCHEMA_VERSION,
            version: 0,
            snapshot_id: SAFE_DEFAULT_SNAPSHOT_ID.to_owned(),
            locale,
            reduced_motion: ReducedMotionPreference::System,
            character_visibility: CharacterVisibility::Visible,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct AppPreferencesGetRequestV1 {
    pub schema_version: u16,
    pub default_locale: AppLocale,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct AppPreferencesUpdateRequestV1 {
    pub schema_version: u16,
    pub expected_version: u64,
    pub locale: AppLocale,
    pub reduced_motion: ReducedMotionPreference,
    pub character_visibility: CharacterVisibility,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct AppPreferencesResetRequestV1 {
    pub schema_version: u16,
    pub expected_version: u64,
    pub default_locale: AppLocale,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct AppPreferencesSnapshotV1 {
    pub schema_version: u16,
    pub preferences: AppPreferencesV1,
    pub persistence: AppPreferencesPersistence,
    pub recovery_code: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct LegacyAppPreferencesV0 {
    pub schema_version: u16,
    pub version: u64,
    pub locale: AppLocale,
    pub reduced_motion: bool,
    pub character_hidden: bool,
}
