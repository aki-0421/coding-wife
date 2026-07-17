use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use thiserror::Error;

use super::redaction::redact_text;
use super::types::{
    PendingKind, PendingOption, PendingQuestion, PendingRequestView, PendingResponseKind,
    ReasoningPreset,
};

pub const FALLBACK_DECISION_TIMEOUT: Duration = Duration::from_secs(300);

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

#[derive(Clone, Debug)]
pub struct FallbackDecisionContext {
    pub workspace_id: String,
    pub generation: u64,
    pub thread_id: String,
    pub source_turn_id: String,
    pub effort: ReasoningPreset,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum FallbackDecisionState {
    Pending,
    Claimed(u64),
}

#[derive(Clone, Debug)]
struct FallbackDecisionRecord {
    context: FallbackDecisionContext,
    view: PendingRequestView,
    fingerprint: String,
    created_at: Instant,
    source_turn_completed: bool,
}

#[derive(Clone, Debug)]
struct FallbackDecisionEntry {
    record: FallbackDecisionRecord,
    state: FallbackDecisionState,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FallbackDecisionClaim {
    pub decision_handle: String,
    pub option_id: String,
    pub workspace_id: String,
    pub generation: u64,
    pub thread_id: String,
    pub source_turn_id: String,
    pub effort: ReasoningPreset,
    token: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum FallbackRegisterOutcome {
    New(Box<PendingRequestView>),
    Existing,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Error)]
pub enum FallbackDecisionError {
    #[error("the fallback decision card was invalid")]
    Invalid,
    #[error("the fallback decision handle was stale")]
    Stale,
    #[error("the fallback decision belongs to another session")]
    SessionMismatch,
    #[error("the fallback decision option was invalid")]
    InvalidOption,
    #[error("the fallback decision source turn has not completed")]
    SourceTurnActive,
    #[error("the fallback decision is already being continued")]
    Claimed,
    #[error("the fallback decision expired")]
    Expired,
    #[error("the fallback decision handle was reused with different content")]
    DuplicateMismatch,
}

#[derive(Default)]
pub struct FallbackDecisionLedger {
    entries: HashMap<String, FallbackDecisionEntry>,
    next_claim_token: u64,
}

impl FallbackDecisionLedger {
    pub fn register(
        &mut self,
        mut view: PendingRequestView,
        context: FallbackDecisionContext,
        now: Instant,
    ) -> Result<FallbackRegisterOutcome, FallbackDecisionError> {
        validate_fallback_view(&view)?;
        let fingerprint = hex::encode(Sha256::digest(
            serde_json::to_vec(&view).map_err(|_| FallbackDecisionError::Invalid)?,
        ));
        let decision_handle = contextual_handle(
            "decision",
            &[
                &view.pending_id,
                &context.workspace_id,
                &context.generation.to_string(),
                &context.thread_id,
                &context.source_turn_id,
            ],
        );
        if let Some(existing) = self.entries.get(&decision_handle) {
            return if existing.record.fingerprint == fingerprint {
                Ok(FallbackRegisterOutcome::Existing)
            } else {
                Err(FallbackDecisionError::DuplicateMismatch)
            };
        }
        view.pending_id = decision_handle.clone();
        for question in &mut view.questions {
            for option in &mut question.options {
                option.id = contextual_handle("option", &[&decision_handle, &option.id]);
            }
        }
        self.entries.insert(
            decision_handle,
            FallbackDecisionEntry {
                record: FallbackDecisionRecord {
                    context,
                    view: view.clone(),
                    fingerprint,
                    created_at: now,
                    source_turn_completed: false,
                },
                state: FallbackDecisionState::Pending,
            },
        );
        Ok(FallbackRegisterOutcome::New(Box::new(view)))
    }

    pub fn claim(
        &mut self,
        decision_handle: &str,
        option_id: &str,
        workspace_id: &str,
        generation: u64,
        now: Instant,
    ) -> Result<FallbackDecisionClaim, FallbackDecisionError> {
        let Some(entry) = self.entries.get(decision_handle) else {
            return Err(FallbackDecisionError::Stale);
        };
        if now.duration_since(entry.record.created_at) >= FALLBACK_DECISION_TIMEOUT {
            self.entries.remove(decision_handle);
            return Err(FallbackDecisionError::Expired);
        }
        if entry.record.context.workspace_id != workspace_id
            || entry.record.context.generation != generation
        {
            return Err(FallbackDecisionError::SessionMismatch);
        }
        if !entry.record.source_turn_completed {
            return Err(FallbackDecisionError::SourceTurnActive);
        }
        if !entry
            .record
            .view
            .questions
            .iter()
            .flat_map(|question| &question.options)
            .any(|option| option.id == option_id)
        {
            return Err(FallbackDecisionError::InvalidOption);
        }
        if !matches!(entry.state, FallbackDecisionState::Pending) {
            return Err(FallbackDecisionError::Claimed);
        }

        self.next_claim_token = self.next_claim_token.wrapping_add(1).max(1);
        let token = self.next_claim_token;
        let entry = self
            .entries
            .get_mut(decision_handle)
            .ok_or(FallbackDecisionError::Stale)?;
        entry.state = FallbackDecisionState::Claimed(token);
        Ok(FallbackDecisionClaim {
            decision_handle: decision_handle.to_owned(),
            option_id: option_id.to_owned(),
            workspace_id: entry.record.context.workspace_id.clone(),
            generation: entry.record.context.generation,
            thread_id: entry.record.context.thread_id.clone(),
            source_turn_id: entry.record.context.source_turn_id.clone(),
            effort: entry.record.context.effort,
            token,
        })
    }

    pub fn restore(&mut self, claim: &FallbackDecisionClaim) -> bool {
        let Some(entry) = self.entries.get_mut(&claim.decision_handle) else {
            return false;
        };
        if entry.state == FallbackDecisionState::Claimed(claim.token) {
            entry.state = FallbackDecisionState::Pending;
            true
        } else {
            false
        }
    }

    pub fn complete(&mut self, claim: &FallbackDecisionClaim) -> bool {
        if self
            .entries
            .get(&claim.decision_handle)
            .is_some_and(|entry| entry.state == FallbackDecisionState::Claimed(claim.token))
        {
            self.entries.remove(&claim.decision_handle);
            true
        } else {
            false
        }
    }

    pub fn mark_turn_terminal(
        &mut self,
        thread_id: &str,
        turn_id: &str,
        completed: bool,
    ) -> Vec<String> {
        let matching = self
            .entries
            .iter()
            .filter(|(_, entry)| {
                entry.record.context.thread_id == thread_id
                    && entry.record.context.source_turn_id == turn_id
            })
            .map(|(handle, _)| handle.clone())
            .collect::<Vec<_>>();
        if completed {
            for handle in &matching {
                if let Some(entry) = self.entries.get_mut(handle) {
                    entry.record.source_turn_completed = true;
                }
            }
            Vec::new()
        } else {
            for handle in &matching {
                self.entries.remove(handle);
            }
            matching
        }
    }

    pub fn expire(&mut self, now: Instant) -> Vec<String> {
        let expired = self
            .entries
            .iter()
            .filter(|(_, entry)| {
                matches!(entry.state, FallbackDecisionState::Pending)
                    && now.duration_since(entry.record.created_at) >= FALLBACK_DECISION_TIMEOUT
            })
            .map(|(handle, _)| handle.clone())
            .collect::<Vec<_>>();
        for handle in &expired {
            self.entries.remove(handle);
        }
        expired
    }

    pub fn clear(&mut self) {
        self.entries.clear();
    }
}

pub fn fallback_continuation_input(decision_handle: &str, option_id: &str) -> String {
    json!({
        "schemaVersion": 1,
        "kind": "decision_result",
        "decisionHandle": decision_handle,
        "optionId": option_id,
    })
    .to_string()
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
                    response_kind: PendingResponseKind::FallbackDecision,
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

fn contextual_handle(prefix: &str, components: &[&str]) -> String {
    let mut hasher = Sha256::new();
    for component in components {
        hasher.update((component.len() as u64).to_be_bytes());
        hasher.update(component.as_bytes());
    }
    let digest = hex::encode(hasher.finalize());
    format!("{prefix}-{}", &digest[..20])
}

fn validate_fallback_view(view: &PendingRequestView) -> Result<(), FallbackDecisionError> {
    let valid = view.kind == PendingKind::UserInput
        && view.response_kind == PendingResponseKind::FallbackDecision
        && view.questions.len() == 1
        && view.allowed_decisions.is_empty()
        && view.approval_context.is_none()
        && view.questions[0].options.len() >= 2
        && view.questions[0].options.len() <= 3;
    if valid {
        Ok(())
    } else {
        Err(FallbackDecisionError::Invalid)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decision_view() -> PendingRequestView {
        let decision = parse_completed_output(
            r#"{"schemaVersion":1,"kind":"decision_request","message":"Choose","decisionId":"d1","question":"Continue?","options":[{"id":"yes","label":"Yes","description":"Continue"},{"id":"no","label":"No","description":"Stop"}],"allowFreeform":false}"#,
            Path::new("/workspace"),
        )
        .expect("decision");
        let DecisionOutput::Request { view } = decision else {
            panic!("request")
        };
        *view
    }

    fn context() -> FallbackDecisionContext {
        FallbackDecisionContext {
            workspace_id: "workspace-1".to_owned(),
            generation: 7,
            thread_id: "thread-1".to_owned(),
            source_turn_id: "turn-1".to_owned(),
            effort: ReasoningPreset::Max,
        }
    }

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

    #[test]
    fn fallback_claim_validates_before_single_claim_and_can_restore() {
        let now = Instant::now();
        let mut ledger = FallbackDecisionLedger::default();
        let FallbackRegisterOutcome::New(view) = ledger
            .register(decision_view(), context(), now)
            .expect("register")
        else {
            panic!("new")
        };
        let option = view.questions[0].options[0].id.clone();
        assert_eq!(
            ledger.claim(
                &view.pending_id,
                &option,
                "workspace-1",
                7,
                now + Duration::from_secs(1),
            ),
            Err(FallbackDecisionError::SourceTurnActive)
        );
        assert!(ledger
            .mark_turn_terminal("thread-1", "turn-1", true)
            .is_empty());
        assert_eq!(
            ledger.claim(
                &view.pending_id,
                "option-invalid",
                "workspace-1",
                7,
                now + Duration::from_secs(2),
            ),
            Err(FallbackDecisionError::InvalidOption)
        );
        let claim = ledger
            .claim(
                &view.pending_id,
                &option,
                "workspace-1",
                7,
                now + Duration::from_secs(3),
            )
            .expect("claim");
        assert_eq!(
            ledger.claim(
                &view.pending_id,
                &option,
                "workspace-1",
                7,
                now + Duration::from_secs(4),
            ),
            Err(FallbackDecisionError::Claimed)
        );
        assert!(ledger.restore(&claim));
        let retry = ledger
            .claim(
                &view.pending_id,
                &option,
                "workspace-1",
                7,
                now + Duration::from_secs(5),
            )
            .expect("retry claim");
        assert!(ledger.complete(&retry));
        assert_eq!(
            ledger.claim(
                &view.pending_id,
                &option,
                "workspace-1",
                7,
                now + Duration::from_secs(6),
            ),
            Err(FallbackDecisionError::Stale)
        );
    }

    #[test]
    fn fallback_pending_expires_without_a_continuation() {
        let now = Instant::now();
        let mut ledger = FallbackDecisionLedger::default();
        let FallbackRegisterOutcome::New(view) = ledger
            .register(decision_view(), context(), now)
            .expect("register")
        else {
            panic!("new")
        };
        assert_eq!(
            ledger.expire(now + FALLBACK_DECISION_TIMEOUT),
            vec![view.pending_id.clone()]
        );
        assert_eq!(
            ledger.claim(
                &view.pending_id,
                &view.questions[0].options[0].id,
                "workspace-1",
                7,
                now + FALLBACK_DECISION_TIMEOUT,
            ),
            Err(FallbackDecisionError::Stale)
        );
    }
}
