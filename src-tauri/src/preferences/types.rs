use serde::{Deserialize, Serialize};

pub const APP_PREFERENCES_SCHEMA_VERSION: u16 = 2;
pub const APP_PREFERENCES_V1_SCHEMA_VERSION: u16 = 1;
pub const APP_PREFERENCES_V0_SCHEMA_VERSION: u16 = 0;
pub const SAFE_DEFAULT_SNAPSHOT_ID: &str = "00000000-0000-0000-0000-000000000000";

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AppLocale {
    Ja,
    En,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LegacyReducedMotionPreference {
    System,
    On,
    Off,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LegacyCharacterVisibility {
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
pub struct AppPreferencesV2 {
    pub schema_version: u16,
    pub version: u64,
    pub snapshot_id: String,
    pub locale: AppLocale,
}

impl AppPreferencesV2 {
    pub(crate) fn safe_default(locale: AppLocale) -> Self {
        Self {
            schema_version: APP_PREFERENCES_SCHEMA_VERSION,
            version: 0,
            snapshot_id: SAFE_DEFAULT_SNAPSHOT_ID.to_owned(),
            locale,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct AppPreferencesGetRequestV2 {
    pub schema_version: u16,
    pub default_locale: AppLocale,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct AppPreferencesUpdateRequestV2 {
    pub schema_version: u16,
    pub expected_version: u64,
    pub locale: AppLocale,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct AppPreferencesSnapshotV2 {
    pub schema_version: u16,
    pub preferences: AppPreferencesV2,
    pub persistence: AppPreferencesPersistence,
    pub recovery_code: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct LegacyAppPreferencesV1 {
    pub schema_version: u16,
    pub version: u64,
    pub snapshot_id: String,
    pub locale: AppLocale,
    pub reduced_motion: LegacyReducedMotionPreference,
    pub character_visibility: LegacyCharacterVisibility,
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
