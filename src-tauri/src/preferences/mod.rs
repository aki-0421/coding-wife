pub mod commands;

mod error;
mod service;
mod store;
mod types;

pub use error::AppPreferencesCommandError;
pub use service::AppPreferencesService;
pub use types::{
    AppPreferencesGetRequestV1, AppPreferencesResetRequestV1, AppPreferencesSnapshotV1,
    AppPreferencesUpdateRequestV1,
};

#[cfg(test)]
mod integration_tests;
