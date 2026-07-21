pub mod commands;

mod error;
mod service;
mod store;
mod types;

pub use error::AppPreferencesCommandError;
pub use service::AppPreferencesService;
pub use types::{
    AppPreferencesGetRequestV2, AppPreferencesSnapshotV2, AppPreferencesUpdateRequestV2,
};

#[cfg(all(test, unix))]
mod integration_tests;
