use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct AppPreferencesCommandError {
    pub code: String,
    pub operation: String,
    pub recoverable: bool,
    pub user_message_key: String,
    pub detail_ref: String,
}

impl AppPreferencesCommandError {
    pub(crate) fn new(
        code: impl Into<String>,
        operation: impl Into<String>,
        recoverable: bool,
    ) -> Self {
        Self {
            code: code.into(),
            operation: operation.into(),
            recoverable,
            user_message_key: "preferences.error.generic".to_owned(),
            detail_ref: "app-preferences-v2".to_owned(),
        }
    }

    pub(crate) fn with_operation(mut self, operation: &'static str) -> Self {
        self.operation = operation.to_owned();
        self
    }
}

impl std::fmt::Display for AppPreferencesCommandError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.code)
    }
}

impl std::error::Error for AppPreferencesCommandError {}

pub(crate) type AppPreferencesResult<T> = Result<T, AppPreferencesCommandError>;

pub(crate) fn preferences_error(
    operation: &str,
    code: &'static str,
    recoverable: bool,
) -> AppPreferencesCommandError {
    AppPreferencesCommandError::new(code, operation, recoverable)
}
