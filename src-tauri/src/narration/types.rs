use serde::{Deserialize, Serialize};

pub const NARRATION_SCHEMA_VERSION: u16 = 1;
pub const NARRATION_MAX_TEXT_SCALARS: usize = 240;
pub const NARRATION_MAX_QUEUE_DEPTH: usize = 3;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NarrationLocale {
    Ja,
    En,
}

impl NarrationLocale {
    pub(crate) fn accepts_locale(self, locale: &str) -> bool {
        match self {
            Self::Ja => locale == "ja_JP",
            Self::En => locale.starts_with("en_") && locale.len() == 5,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NarrationPriority {
    Low,
    Normal,
    High,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NarrationKind {
    Event,
    CommitExplanation,
    Test,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NarrationSemanticType {
    Progress,
    WaitingForUser,
    Error,
    CommitObserved,
    CommitExplanation,
    Disconnected,
    Test,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NarrationPlaybackState {
    Idle,
    Preparing,
    Playing,
    Unavailable,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NarrationDisposition {
    Queued,
    Disabled,
    Muted,
    DroppedDuplicate,
    DroppedQueueFull,
    DroppedSequence,
    Stale,
    Unavailable,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NarrationCancelReason {
    ExplicitCancel,
    Mute,
    WorkspaceSwitch,
    TurnStop,
    AppClose,
    Reset,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct NarrationVoiceSelectionV1 {
    pub ja: Option<String>,
    pub en: Option<String>,
}

impl NarrationVoiceSelectionV1 {
    pub(crate) fn for_locale(&self, locale: NarrationLocale) -> Option<&str> {
        match locale {
            NarrationLocale::Ja => self.ja.as_deref(),
            NarrationLocale::En => self.en.as_deref(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct NarrationSettingsV1 {
    pub schema_version: u16,
    pub version: u64,
    pub enabled: bool,
    pub muted: bool,
    pub voices: NarrationVoiceSelectionV1,
    pub rate: f64,
}

impl Default for NarrationSettingsV1 {
    fn default() -> Self {
        Self {
            schema_version: NARRATION_SCHEMA_VERSION,
            version: 0,
            enabled: false,
            muted: false,
            voices: NarrationVoiceSelectionV1::default(),
            rate: 1.0,
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct NarrationSettingsUpdateV1 {
    pub schema_version: u16,
    pub expected_version: u64,
    pub enabled: bool,
    pub muted: bool,
    pub voices: NarrationVoiceSelectionV1,
    pub rate: f64,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct NarrationMuteRequestV1 {
    pub schema_version: u16,
    pub expected_version: u64,
    pub muted: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct NarrationResetRequestV1 {
    pub schema_version: u16,
    pub expected_version: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct NarrationVoiceV1 {
    pub name: String,
    pub locale: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct NarrationVoiceListV1 {
    pub schema_version: u16,
    pub voices: Vec<NarrationVoiceV1>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct NarrationScopeRequestV1 {
    pub schema_version: u16,
    pub workspace_id: String,
    pub generation: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct NarrationSpeakRequestV1 {
    pub schema_version: u16,
    pub request_id: String,
    pub workspace_id: String,
    pub generation: u64,
    pub sequence: u64,
    pub locale: NarrationLocale,
    pub kind: NarrationKind,
    pub semantic_type: NarrationSemanticType,
    pub priority: NarrationPriority,
    pub text: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct NarrationCancelRequestV1 {
    pub schema_version: u16,
    pub reason: NarrationCancelReason,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct NarrationSpeakResponseV1 {
    pub schema_version: u16,
    pub disposition: NarrationDisposition,
    pub queue_depth: usize,
    pub code: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct NarrationRuntimeSnapshotV1 {
    pub schema_version: u16,
    pub playback_state: NarrationPlaybackState,
    pub active_request_id: Option<String>,
    pub queue_depth: usize,
    pub last_error_code: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct NarrationSettingsSnapshotV1 {
    pub schema_version: u16,
    pub settings: NarrationSettingsV1,
    pub runtime: NarrationRuntimeSnapshotV1,
    pub load_warning_code: Option<String>,
}
