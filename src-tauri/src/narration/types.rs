use serde::{Deserialize, Serialize};

pub const NARRATION_SCHEMA_VERSION: u16 = 1;
pub const NARRATION_SETTINGS_SCHEMA_VERSION: u16 = 2;
pub const NARRATION_MAX_TEXT_SCALARS: usize = 240;
pub const NARRATION_MAX_QUEUE_DEPTH: usize = 3;
pub const OPENAI_TTS_MODEL: &str = "gpt-4o-mini-tts";
pub const OPENAI_DEFAULT_VOICE: &str = "marin";
pub const OPENAI_TTS_VOICES: &[&str] = &[
    "alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse",
    "marin", "cedar",
];

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NarrationLocale {
    Ja,
    En,
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

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum NarrationProvider {
    #[serde(rename = "openai")]
    OpenAi,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct NarrationSettingsV2 {
    pub schema_version: u16,
    pub version: u64,
    pub enabled: bool,
    pub muted: bool,
    pub provider: Option<NarrationProvider>,
    pub api_key_configured: bool,
    pub model: String,
    pub voice: String,
    pub speed: f64,
}

impl Default for NarrationSettingsV2 {
    fn default() -> Self {
        Self {
            schema_version: NARRATION_SETTINGS_SCHEMA_VERSION,
            version: 0,
            enabled: false,
            muted: false,
            provider: None,
            api_key_configured: false,
            model: OPENAI_TTS_MODEL.to_owned(),
            voice: OPENAI_DEFAULT_VOICE.to_owned(),
            speed: 1.0,
        }
    }
}

#[derive(Clone, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields, tag = "kind", rename_all = "snake_case")]
pub enum NarrationApiKeyActionV2 {
    Keep,
    Replace { value: String },
    Clear,
}

#[derive(Clone, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct NarrationSettingsUpdateV2 {
    pub schema_version: u16,
    pub expected_version: u64,
    pub enabled: bool,
    pub muted: bool,
    pub provider: Option<NarrationProvider>,
    pub api_key_action: NarrationApiKeyActionV2,
    pub model: String,
    pub voice: String,
    pub speed: f64,
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
    pub settings: NarrationSettingsV2,
    pub runtime: NarrationRuntimeSnapshotV1,
    pub load_warning_code: Option<String>,
}
