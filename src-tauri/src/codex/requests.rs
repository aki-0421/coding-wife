use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::path::Path;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use thiserror::Error;

use super::protocol::{server_error, server_result, RpcId};
use super::redaction::redact_text;
use super::types::{
    ApprovalDecision, CapabilityState, CodexCapabilities, PendingKind, PendingOption,
    PendingQuestion, PendingRequestView, PendingResponse,
};

const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
const MAX_RESOLVED_REQUESTS: usize = 256;
pub const PENDING_REQUEST_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Clone, Debug)]
pub struct ActiveWireContext<'a> {
    pub thread_id: &'a str,
    pub turn_id: &'a str,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Error)]
pub enum RequestValidationError {
    #[error("the server request method is unsupported")]
    UnsupportedMethod,
    #[error("the server request params were invalid")]
    InvalidParams,
    #[error("the server request did not match the active turn")]
    Stale,
    #[error("the server request id was reused with different content")]
    DuplicateMismatch,
    #[error("the pending request response was stale or duplicated")]
    StaleResponse,
    #[error("the pending request response was invalid")]
    InvalidResponse,
}

#[derive(Clone, Debug)]
enum ResponseShape {
    Command,
    FileChange,
    Permissions {
        requested: Value,
    },
    UserInput {
        answers: BTreeMap<String, HashSet<String>>,
    },
}

#[derive(Clone, Debug)]
struct PendingRecord {
    rpc_id: RpcId,
    rpc_key: String,
    method: String,
    params_hash: String,
    thread_id: String,
    turn_id: String,
    created_at: Instant,
    view: PendingRequestView,
    response_shape: ResponseShape,
}

#[derive(Clone, Debug)]
struct ResolvedRecord {
    method: String,
    params_hash: String,
    response: Value,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RegisterOutcome {
    New(PendingRequestView),
    Existing(PendingRequestView),
    Replay(Value),
}

#[derive(Clone, Debug)]
pub struct Resolution {
    pub message: Value,
    pub interrupt: bool,
    pub thread_id: String,
    pub turn_id: String,
}

#[derive(Default)]
pub struct ServerRequestLedger {
    pending_by_id: HashMap<String, PendingRecord>,
    pending_by_rpc: HashMap<String, String>,
    resolved: HashMap<String, ResolvedRecord>,
    resolved_order: VecDeque<String>,
}

fn object(value: &Value) -> Result<&serde_json::Map<String, Value>, RequestValidationError> {
    value
        .as_object()
        .ok_or(RequestValidationError::InvalidParams)
}

fn exact_keys(
    object: &serde_json::Map<String, Value>,
    required: &[&str],
    optional: &[&str],
) -> bool {
    required.iter().all(|key| object.contains_key(*key))
        && object
            .keys()
            .all(|key| required.contains(&key.as_str()) || optional.contains(&key.as_str()))
}

fn non_empty_string<'a>(
    object: &'a serde_json::Map<String, Value>,
    key: &str,
) -> Result<&'a str, RequestValidationError> {
    object
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty() && value.len() <= 4_096)
        .ok_or(RequestValidationError::InvalidParams)
}

fn validate_context(
    params: &serde_json::Map<String, Value>,
    active: &ActiveWireContext<'_>,
) -> Result<(String, String, String), RequestValidationError> {
    let thread_id = non_empty_string(params, "threadId")?;
    let turn_id = non_empty_string(params, "turnId")?;
    let item_id = non_empty_string(params, "itemId")?;
    if thread_id != active.thread_id || turn_id != active.turn_id {
        return Err(RequestValidationError::Stale);
    }
    Ok((thread_id.to_owned(), turn_id.to_owned(), item_id.to_owned()))
}

fn validate_started_at(
    params: &serde_json::Map<String, Value>,
) -> Result<(), RequestValidationError> {
    let value = params
        .get("startedAtMs")
        .and_then(Value::as_i64)
        .ok_or(RequestValidationError::InvalidParams)?;
    if !(0..=MAX_SAFE_INTEGER).contains(&value) {
        return Err(RequestValidationError::InvalidParams);
    }
    Ok(())
}

fn params_hash(params: &Value) -> Result<String, RequestValidationError> {
    let bytes = serde_json::to_vec(params).map_err(|_| RequestValidationError::InvalidParams)?;
    Ok(hex::encode(Sha256::digest(bytes)))
}

fn pending_id(rpc_id: &RpcId, params_hash: &str) -> String {
    let digest = Sha256::digest(format!("{}:{params_hash}", rpc_id.stable_key()).as_bytes());
    format!("pending-{}", &hex::encode(digest)[..20])
}

fn sanitized_reason(
    params: &serde_json::Map<String, Value>,
    workspace_root: &Path,
) -> Option<String> {
    params
        .get("reason")
        .and_then(Value::as_str)
        .filter(|reason| !reason.trim().is_empty())
        .map(|reason| redact_text(reason, Some(workspace_root), 512))
}

fn allowed_approval_decisions(
    params: &serde_json::Map<String, Value>,
) -> Result<Vec<ApprovalDecision>, RequestValidationError> {
    let Some(value) = params.get("availableDecisions") else {
        return Ok(vec![
            ApprovalDecision::ApproveOnce,
            ApprovalDecision::Reject,
            ApprovalDecision::Stop,
        ]);
    };
    if value.is_null() {
        return Ok(vec![
            ApprovalDecision::ApproveOnce,
            ApprovalDecision::Reject,
            ApprovalDecision::Stop,
        ]);
    }
    let entries = value
        .as_array()
        .ok_or(RequestValidationError::InvalidParams)?;
    let mut decisions = Vec::new();
    for entry in entries {
        match entry.as_str() {
            Some("accept") if !decisions.contains(&ApprovalDecision::ApproveOnce) => {
                decisions.push(ApprovalDecision::ApproveOnce)
            }
            Some("decline") if !decisions.contains(&ApprovalDecision::Reject) => {
                decisions.push(ApprovalDecision::Reject)
            }
            Some("cancel") if !decisions.contains(&ApprovalDecision::Stop) => {
                decisions.push(ApprovalDecision::Stop)
            }
            Some("acceptForSession") => {}
            _ => return Err(RequestValidationError::InvalidParams),
        }
    }
    if decisions.is_empty() {
        return Err(RequestValidationError::InvalidParams);
    }
    Ok(decisions)
}

fn approval_record(
    rpc_id: RpcId,
    method: &str,
    params: &Value,
    active: &ActiveWireContext<'_>,
    workspace_root: &Path,
) -> Result<PendingRecord, RequestValidationError> {
    let object = object(params)?;
    let (required, optional, kind, operation, response_shape) = match method {
        "item/commandExecution/requestApproval" => (
            &["threadId", "turnId", "itemId", "startedAtMs"][..],
            &[
                "additionalPermissions",
                "approvalId",
                "availableDecisions",
                "command",
                "commandActions",
                "cwd",
                "environmentId",
                "networkApprovalContext",
                "proposedExecpolicyAmendment",
                "proposedNetworkPolicyAmendments",
                "reason",
            ][..],
            PendingKind::CommandApproval,
            "command_execution",
            ResponseShape::Command,
        ),
        "item/fileChange/requestApproval" => (
            &["threadId", "turnId", "itemId", "startedAtMs"][..],
            &["grantRoot", "reason"][..],
            PendingKind::FileChangeApproval,
            "file_change",
            ResponseShape::FileChange,
        ),
        "item/permissions/requestApproval" => (
            &[
                "threadId",
                "turnId",
                "itemId",
                "startedAtMs",
                "cwd",
                "permissions",
            ][..],
            &["environmentId", "reason"][..],
            PendingKind::PermissionsApproval,
            "permissions",
            ResponseShape::Permissions {
                requested: object
                    .get("permissions")
                    .filter(|value| value.is_object())
                    .cloned()
                    .ok_or(RequestValidationError::InvalidParams)?,
            },
        ),
        _ => return Err(RequestValidationError::UnsupportedMethod),
    };
    if !exact_keys(object, required, optional) {
        return Err(RequestValidationError::InvalidParams);
    }
    validate_started_at(object)?;
    let (thread_id, turn_id, _) = validate_context(object, active)?;
    let hash = params_hash(params)?;
    let id = pending_id(&rpc_id, &hash);
    let decisions = allowed_approval_decisions(object)?;
    let view = PendingRequestView {
        pending_id: id,
        kind,
        operation: operation.to_owned(),
        target_alias: "workspace".to_owned(),
        reason: sanitized_reason(object, workspace_root),
        questions: Vec::new(),
        allowed_decisions: decisions,
    };
    Ok(PendingRecord {
        rpc_key: rpc_id.stable_key(),
        rpc_id,
        method: method.to_owned(),
        params_hash: hash,
        thread_id,
        turn_id,
        created_at: Instant::now(),
        view,
        response_shape,
    })
}

fn user_input_record(
    rpc_id: RpcId,
    params: &Value,
    active: &ActiveWireContext<'_>,
    capabilities: &CodexCapabilities,
) -> Result<PendingRecord, RequestValidationError> {
    if capabilities.native_request_user_input != CapabilityState::Supported {
        return Err(RequestValidationError::UnsupportedMethod);
    }
    let params_object = object(params)?;
    if !exact_keys(
        params_object,
        &["threadId", "turnId", "itemId", "questions"],
        &["autoResolutionMs"],
    ) {
        return Err(RequestValidationError::InvalidParams);
    }
    let (thread_id, turn_id, _) = validate_context(params_object, active)?;
    if let Some(auto_resolution) = params_object.get("autoResolutionMs") {
        if !(auto_resolution.is_null()
            || auto_resolution
                .as_u64()
                .is_some_and(|value| value <= MAX_SAFE_INTEGER as u64))
        {
            return Err(RequestValidationError::InvalidParams);
        }
    }
    let questions = params_object
        .get("questions")
        .and_then(Value::as_array)
        .filter(|questions| (1..=3).contains(&questions.len()))
        .ok_or(RequestValidationError::InvalidParams)?;
    let mut question_ids = HashSet::new();
    let mut answer_options = BTreeMap::new();
    let mut views = Vec::new();
    for question in questions {
        let question = object(question)?;
        if !exact_keys(
            question,
            &["id", "header", "question"],
            &["isOther", "isSecret", "options"],
        ) || question.get("isSecret").and_then(Value::as_bool) == Some(true)
            || question.get("isOther").and_then(Value::as_bool) == Some(true)
        {
            return Err(RequestValidationError::InvalidParams);
        }
        let id = non_empty_string(question, "id")?.to_owned();
        if !question_ids.insert(id.clone()) {
            return Err(RequestValidationError::InvalidParams);
        }
        let header = non_empty_string(question, "header")?.to_owned();
        let prompt = non_empty_string(question, "question")?.to_owned();
        let options = question
            .get("options")
            .and_then(Value::as_array)
            .filter(|options| (2..=3).contains(&options.len()))
            .ok_or(RequestValidationError::InvalidParams)?;
        let mut labels = HashSet::new();
        let mut option_views = Vec::new();
        for (index, option) in options.iter().enumerate() {
            let option = object(option)?;
            if !exact_keys(option, &["label", "description"], &[]) {
                return Err(RequestValidationError::InvalidParams);
            }
            let label = non_empty_string(option, "label")?.to_owned();
            if !labels.insert(label.clone()) {
                return Err(RequestValidationError::InvalidParams);
            }
            option_views.push(PendingOption {
                id: format!("option-{index}"),
                label,
                description: non_empty_string(option, "description")?.to_owned(),
            });
        }
        answer_options.insert(id.clone(), labels);
        views.push(PendingQuestion {
            id,
            header,
            question: prompt,
            options: option_views,
        });
    }

    let hash = params_hash(params)?;
    let id = pending_id(&rpc_id, &hash);
    let view = PendingRequestView {
        pending_id: id,
        kind: PendingKind::UserInput,
        operation: "request_user_input".to_owned(),
        target_alias: "active_turn".to_owned(),
        reason: None,
        questions: views,
        allowed_decisions: Vec::new(),
    };
    Ok(PendingRecord {
        rpc_key: rpc_id.stable_key(),
        rpc_id,
        method: "item/tool/requestUserInput".to_owned(),
        params_hash: hash,
        thread_id,
        turn_id,
        created_at: Instant::now(),
        view,
        response_shape: ResponseShape::UserInput {
            answers: answer_options,
        },
    })
}

impl ServerRequestLedger {
    pub fn register(
        &mut self,
        rpc_id: RpcId,
        method: &str,
        params: &Value,
        active: &ActiveWireContext<'_>,
        workspace_root: &Path,
        capabilities: &CodexCapabilities,
    ) -> Result<RegisterOutcome, RequestValidationError> {
        let hash = params_hash(params)?;
        let rpc_key = rpc_id.stable_key();
        if let Some(resolved) = self.resolved.get(&rpc_key) {
            if resolved.method == method && resolved.params_hash == hash {
                return Ok(RegisterOutcome::Replay(resolved.response.clone()));
            }
            return Err(RequestValidationError::DuplicateMismatch);
        }
        if let Some(pending_id) = self.pending_by_rpc.get(&rpc_key) {
            let record = self
                .pending_by_id
                .get(pending_id)
                .ok_or(RequestValidationError::DuplicateMismatch)?;
            if record.method == method && record.params_hash == hash {
                return Ok(RegisterOutcome::Existing(record.view.clone()));
            }
            return Err(RequestValidationError::DuplicateMismatch);
        }

        let record = if method == "item/tool/requestUserInput" {
            user_input_record(rpc_id, params, active, capabilities)?
        } else {
            approval_record(rpc_id, method, params, active, workspace_root)?
        };
        let view = record.view.clone();
        self.pending_by_rpc
            .insert(record.rpc_key.clone(), view.pending_id.clone());
        self.pending_by_id.insert(view.pending_id.clone(), record);
        Ok(RegisterOutcome::New(view))
    }

    pub fn resolve(
        &mut self,
        pending_id: &str,
        response: &PendingResponse,
    ) -> Result<Resolution, RequestValidationError> {
        let record = self
            .pending_by_id
            .remove(pending_id)
            .ok_or(RequestValidationError::StaleResponse)?;
        self.pending_by_rpc.remove(&record.rpc_key);

        let (message, interrupt) = match (&record.response_shape, response) {
            (
                ResponseShape::Command | ResponseShape::FileChange,
                PendingResponse::Approval { decision },
            ) => {
                if !record.view.allowed_decisions.contains(decision) {
                    return Err(RequestValidationError::InvalidResponse);
                }
                let decision = match decision {
                    ApprovalDecision::ApproveOnce => "accept",
                    ApprovalDecision::Reject => "decline",
                    ApprovalDecision::Stop => "cancel",
                };
                (
                    server_result(&record.rpc_id, json!({"decision": decision})),
                    decision == "cancel",
                )
            }
            (ResponseShape::Permissions { requested }, PendingResponse::Approval { decision }) => {
                if !record.view.allowed_decisions.contains(decision) {
                    return Err(RequestValidationError::InvalidResponse);
                }
                match decision {
                    ApprovalDecision::ApproveOnce => (
                        server_result(
                            &record.rpc_id,
                            json!({"permissions": requested, "scope": "turn"}),
                        ),
                        false,
                    ),
                    ApprovalDecision::Reject => (
                        server_result(&record.rpc_id, json!({"permissions": {}, "scope": "turn"})),
                        false,
                    ),
                    ApprovalDecision::Stop => (
                        server_error(&record.rpc_id, -32000, "Request canceled by user"),
                        true,
                    ),
                }
            }
            (
                ResponseShape::UserInput { answers: expected },
                PendingResponse::UserInput { answers },
            ) => {
                if expected.len() != answers.len() {
                    return Err(RequestValidationError::InvalidResponse);
                }
                for (question_id, allowed) in expected {
                    let selected = answers
                        .get(question_id)
                        .filter(|selected| selected.len() == 1)
                        .ok_or(RequestValidationError::InvalidResponse)?;
                    if !allowed.contains(&selected[0]) {
                        return Err(RequestValidationError::InvalidResponse);
                    }
                }
                let answers = answers
                    .iter()
                    .map(|(id, values)| (id.clone(), json!({"answers": values})))
                    .collect::<serde_json::Map<_, _>>();
                (
                    server_result(&record.rpc_id, json!({"answers": answers})),
                    false,
                )
            }
            _ => return Err(RequestValidationError::InvalidResponse),
        };

        self.record_resolution(&record, message.clone());
        Ok(Resolution {
            message,
            interrupt,
            thread_id: record.thread_id,
            turn_id: record.turn_id,
        })
    }

    pub fn expire(&mut self, now: Instant) -> Vec<(Value, String, String)> {
        let expired_ids = self
            .pending_by_id
            .iter()
            .filter(|(_, record)| now.duration_since(record.created_at) >= PENDING_REQUEST_TIMEOUT)
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        let mut expired = Vec::new();
        for id in expired_ids {
            if let Some(record) = self.pending_by_id.remove(&id) {
                self.pending_by_rpc.remove(&record.rpc_key);
                let response = server_error(&record.rpc_id, -32000, "Request timed out");
                self.record_resolution(&record, response.clone());
                expired.push((response, record.thread_id, record.turn_id));
            }
        }
        expired
    }

    fn record_resolution(&mut self, record: &PendingRecord, response: Value) {
        self.resolved.insert(
            record.rpc_key.clone(),
            ResolvedRecord {
                method: record.method.clone(),
                params_hash: record.params_hash.clone(),
                response,
            },
        );
        self.resolved_order.push_back(record.rpc_key.clone());
        while self.resolved_order.len() > MAX_RESOLVED_REQUESTS {
            if let Some(key) = self.resolved_order.pop_front() {
                self.resolved.remove(&key);
            }
        }
    }

    pub fn clear_pending(&mut self) {
        self.pending_by_id.clear();
        self.pending_by_rpc.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::super::types::CodexCapabilities;
    use super::*;

    fn active<'a>() -> ActiveWireContext<'a> {
        ActiveWireContext {
            thread_id: "thread-1",
            turn_id: "turn-1",
        }
    }

    #[test]
    fn allows_only_the_three_current_approval_methods() {
        let mut ledger = ServerRequestLedger::default();
        let params = json!({
            "threadId": "thread-1",
            "turnId": "turn-1",
            "itemId": "item-1",
            "startedAtMs": 1,
            "command": "rm -rf secret",
            "cwd": "/Users/alice/project"
        });
        let outcome = ledger
            .register(
                RpcId::Unsigned(7),
                "item/commandExecution/requestApproval",
                &params,
                &active(),
                Path::new("/Users/alice/project"),
                &CodexCapabilities::default(),
            )
            .expect("known approval");
        let RegisterOutcome::New(view) = outcome else {
            panic!("new request expected")
        };
        assert_eq!(view.operation, "command_execution");
        assert!(!serde_json::to_string(&view)
            .expect("serialize")
            .contains("rm -rf"));

        assert_eq!(
            ledger.register(
                RpcId::Unsigned(8),
                "applyPatchApproval",
                &params,
                &active(),
                Path::new("/workspace"),
                &CodexCapabilities::default(),
            ),
            Err(RequestValidationError::UnsupportedMethod)
        );
    }

    #[test]
    fn duplicate_request_reuses_pending_and_resolved_response() {
        let mut ledger = ServerRequestLedger::default();
        let params = json!({
            "threadId": "thread-1",
            "turnId": "turn-1",
            "itemId": "item-1",
            "startedAtMs": 1,
            "reason": "write"
        });
        let first = ledger
            .register(
                RpcId::String("server-1".to_owned()),
                "item/fileChange/requestApproval",
                &params,
                &active(),
                Path::new("/workspace"),
                &CodexCapabilities::default(),
            )
            .expect("first");
        let RegisterOutcome::New(view) = first else {
            panic!("new")
        };
        assert!(matches!(
            ledger
                .register(
                    RpcId::String("server-1".to_owned()),
                    "item/fileChange/requestApproval",
                    &params,
                    &active(),
                    Path::new("/workspace"),
                    &CodexCapabilities::default(),
                )
                .expect("duplicate"),
            RegisterOutcome::Existing(_)
        ));
        ledger
            .resolve(
                &view.pending_id,
                &PendingResponse::Approval {
                    decision: ApprovalDecision::Reject,
                },
            )
            .expect("resolve");
        assert!(matches!(
            ledger
                .register(
                    RpcId::String("server-1".to_owned()),
                    "item/fileChange/requestApproval",
                    &params,
                    &active(),
                    Path::new("/workspace"),
                    &CodexCapabilities::default(),
                )
                .expect("replay"),
            RegisterOutcome::Replay(_)
        ));
    }

    #[test]
    fn user_input_rejects_secret_freeform_and_out_of_schema_answers() {
        let mut ledger = ServerRequestLedger::default();
        let capabilities = CodexCapabilities {
            native_request_user_input: CapabilityState::Supported,
            ..CodexCapabilities::default()
        };
        let invalid = json!({
            "threadId": "thread-1",
            "turnId": "turn-1",
            "itemId": "item-1",
            "questions": [{
                "id": "q1",
                "header": "Secret",
                "question": "Enter it",
                "isSecret": true,
                "options": [{"label": "A", "description": "A"}, {"label": "B", "description": "B"}]
            }]
        });
        assert_eq!(
            ledger.register(
                RpcId::Unsigned(1),
                "item/tool/requestUserInput",
                &invalid,
                &active(),
                Path::new("/workspace"),
                &capabilities,
            ),
            Err(RequestValidationError::InvalidParams)
        );
    }
}
