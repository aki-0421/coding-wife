use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CharacterCommandError {
    pub code: String,
    pub operation: String,
    pub recoverable: bool,
    pub user_message_key: String,
    pub detail_ref: String,
}

impl CharacterCommandError {
    pub fn new(code: impl Into<String>, operation: impl Into<String>, recoverable: bool) -> Self {
        Self {
            code: code.into(),
            operation: operation.into(),
            recoverable,
            user_message_key: "character.error.generic".to_owned(),
            detail_ref: "character-library-v1".to_owned(),
        }
    }

    pub fn with_operation(mut self, operation: &'static str) -> Self {
        self.operation = operation.to_owned();
        self
    }
}

impl std::fmt::Display for CharacterCommandError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.code)
    }
}

impl std::error::Error for CharacterCommandError {}

pub type CharacterResult<T> = Result<T, CharacterCommandError>;

pub fn character_error(
    operation: &str,
    code: &'static str,
    recoverable: bool,
) -> CharacterCommandError {
    CharacterCommandError::new(code, operation, recoverable)
}
