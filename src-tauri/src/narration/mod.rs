pub mod commands;

mod binary;
mod error;
mod policy;
mod process;
mod service;
mod settings;
mod types;

pub use error::NarrationCommandError;
pub use service::NarrationService;
pub use types::{
    NarrationCancelRequestV1, NarrationMuteRequestV1, NarrationResetRequestV1,
    NarrationRuntimeSnapshotV1, NarrationScopeRequestV1, NarrationSettingsSnapshotV1,
    NarrationSettingsUpdateV2, NarrationSpeakRequestV1, NarrationSpeakResponseV1,
    NarrationVoiceListV1,
};

#[cfg(test)]
mod integration_tests;
