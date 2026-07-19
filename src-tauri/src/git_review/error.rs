use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct GitReviewError {
    pub code: String,
    pub operation: String,
    pub recoverable: bool,
    pub user_message_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail_ref: Option<String>,
}

impl GitReviewError {
    pub fn new(code: impl Into<String>, operation: impl Into<String>, recoverable: bool) -> Self {
        Self {
            code: code.into(),
            operation: operation.into(),
            recoverable,
            user_message_key: "gitReview.error.generic".to_owned(),
            detail_ref: None,
        }
    }

    pub fn with_detail_ref(mut self, detail_ref: impl Into<String>) -> Self {
        self.detail_ref = Some(detail_ref.into());
        self
    }
}

pub(crate) fn git_error(
    code: &'static str,
    operation: &'static str,
    recoverable: bool,
) -> GitReviewError {
    GitReviewError::new(code, operation, recoverable)
}
