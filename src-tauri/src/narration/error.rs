use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct NarrationCommandError {
    pub code: String,
    pub operation: String,
    pub recoverable: bool,
    pub user_message_key: String,
    pub detail_ref: String,
}

impl NarrationCommandError {
    pub fn new(code: impl Into<String>, operation: impl Into<String>, recoverable: bool) -> Self {
        Self {
            code: code.into(),
            operation: operation.into(),
            recoverable,
            user_message_key: "narration.error.generic".to_owned(),
            detail_ref: "narration-v1".to_owned(),
        }
    }

    pub fn with_operation(mut self, operation: &'static str) -> Self {
        self.operation = operation.to_owned();
        self
    }
}

impl std::fmt::Display for NarrationCommandError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.code)
    }
}

impl std::error::Error for NarrationCommandError {}

pub type NarrationResult<T> = Result<T, NarrationCommandError>;

pub(crate) fn narration_error(
    operation: &str,
    code: &'static str,
    recoverable: bool,
) -> NarrationCommandError {
    NarrationCommandError::new(code, operation, recoverable)
}
