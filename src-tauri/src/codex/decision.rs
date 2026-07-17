use std::collections::HashSet;
use std::path::Path;

use serde::Deserialize;
use sha2::{Digest, Sha256};
use thiserror::Error;

use super::redaction::redact_text;
use super::types::{PendingKind, PendingOption, PendingQuestion, PendingRequestView};

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DecisionOutput {
    Result { message: String },
    Request { view: Box<PendingRequestView> },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Error)]
pub enum DecisionOutputError {
    #[error("the completed assistant output was not exact decision JSON")]
    Invalid,
}

#[derive(Deserialize)]
#[serde(tag = "kind", deny_unknown_fields)]
enum WireDecisionOutput {
    #[serde(rename = "result")]
    Result {
        #[serde(rename = "schemaVersion")]
        schema_version: u16,
        message: String,
    },
    #[serde(rename = "decision_request")]
    DecisionRequest {
        #[serde(rename = "schemaVersion")]
        schema_version: u16,
        message: String,
        #[serde(rename = "decisionId")]
        decision_id: String,
        question: String,
        options: Vec<WireOption>,
        #[serde(rename = "allowFreeform")]
        allow_freeform: bool,
    },
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WireOption {
    id: String,
    label: String,
    description: String,
}

pub fn parse_completed_output(
    text: &str,
    workspace_root: &Path,
) -> Result<DecisionOutput, DecisionOutputError> {
    if text.len() > 128 * 1024 {
        return Err(DecisionOutputError::Invalid);
    }
    let output: WireDecisionOutput =
        serde_json::from_str(text).map_err(|_| DecisionOutputError::Invalid)?;
    match output {
        WireDecisionOutput::Result {
            schema_version,
            message,
        } => {
            if schema_version != 1 || !bounded(&message, 1, 65_536) {
                return Err(DecisionOutputError::Invalid);
            }
            Ok(DecisionOutput::Result {
                message: redact_text(&message, Some(workspace_root), 65_536),
            })
        }
        WireDecisionOutput::DecisionRequest {
            schema_version,
            message,
            decision_id,
            question,
            options,
            allow_freeform,
        } => {
            if schema_version != 1
                || allow_freeform
                || !bounded(&message, 1, 4_096)
                || !bounded(&decision_id, 1, 128)
                || !bounded(&question, 1, 4_096)
                || !(2..=3).contains(&options.len())
            {
                return Err(DecisionOutputError::Invalid);
            }
            let mut ids = HashSet::new();
            let mut labels = HashSet::new();
            let mut views = Vec::with_capacity(options.len());
            for option in options {
                if !bounded(&option.id, 1, 128)
                    || !bounded(&option.label, 1, 256)
                    || option.description.chars().count() > 1_024
                    || !ids.insert(option.id.clone())
                    || !labels.insert(option.label.clone())
                {
                    return Err(DecisionOutputError::Invalid);
                }
                views.push(PendingOption {
                    id: opaque_id("option", &option.id),
                    label: redact_text(&option.label, Some(workspace_root), 256),
                    description: redact_text(&option.description, Some(workspace_root), 1_024),
                });
            }
            Ok(DecisionOutput::Request {
                view: Box::new(PendingRequestView {
                    pending_id: opaque_id("decision", &decision_id),
                    kind: PendingKind::UserInput,
                    operation: "decision_fallback".to_owned(),
                    target_alias: "active_turn".to_owned(),
                    reason: Some(redact_text(&message, Some(workspace_root), 4_096)),
                    questions: vec![PendingQuestion {
                        id: "decision".to_owned(),
                        header: "Decision".to_owned(),
                        question: redact_text(&question, Some(workspace_root), 4_096),
                        options: views,
                    }],
                    allowed_decisions: Vec::new(),
                    approval_context: None,
                }),
            })
        }
    }
}

fn bounded(value: &str, minimum: usize, maximum: usize) -> bool {
    let count = value.chars().count();
    (minimum..=maximum).contains(&count) && !value.contains('\0')
}

fn opaque_id(prefix: &str, raw: &str) -> String {
    let digest = hex::encode(Sha256::digest(raw.as_bytes()));
    format!("{prefix}-{}", &digest[..20])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_result_and_decision_are_accepted() {
        let result = parse_completed_output(
            r#"{"schemaVersion":1,"kind":"result","message":"Done"}"#,
            Path::new("/workspace"),
        )
        .expect("result");
        assert_eq!(
            result,
            DecisionOutput::Result {
                message: "Done".to_owned()
            }
        );

        let decision = parse_completed_output(
            r#"{"schemaVersion":1,"kind":"decision_request","message":"Choose","decisionId":"d1","question":"Continue?","options":[{"id":"yes","label":"Yes","description":"Continue"},{"id":"no","label":"No","description":"Stop"}],"allowFreeform":false}"#,
            Path::new("/workspace"),
        )
        .expect("decision");
        let DecisionOutput::Request { view } = decision else {
            panic!("request")
        };
        assert_eq!(view.questions.len(), 1);
        assert_eq!(view.questions[0].options.len(), 2);
    }

    #[test]
    fn free_text_approval_substitute_and_duplicate_options_are_rejected() {
        for invalid in [
            "free text",
            r#"{"schemaVersion":1,"kind":"approval","message":"approve"}"#,
            r#"{"schemaVersion":1,"kind":"decision_request","message":"Choose","decisionId":"d1","question":"Continue?","options":[{"id":"same","label":"A","description":"A"},{"id":"same","label":"B","description":"B"}],"allowFreeform":false}"#,
            r#"{"schemaVersion":1,"kind":"decision_request","message":"Choose","decisionId":"d1","question":"Continue?","options":[{"id":"a","label":"A","description":"A"},{"id":"b","label":"B","description":"B"}],"allowFreeform":true}"#,
        ] {
            assert_eq!(
                parse_completed_output(invalid, Path::new("/workspace")),
                Err(DecisionOutputError::Invalid)
            );
        }
    }
}
