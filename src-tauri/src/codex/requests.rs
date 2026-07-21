use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::path::Path;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use thiserror::Error;

use super::protocol::{server_error, server_result, RpcId};
use super::types::{
    ApprovalDecision, CapabilityState, CodexCapabilities, DecisionContext, PendingKind,
    PendingOption, PendingQuestion, PendingRequestView, PendingResponse, PendingResponseKind,
    PendingUserInputAnswer,
};

const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
const MAX_OTHER_ANSWER_SCALARS: usize = 2_000;
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
        answers: BTreeMap<String, UserInputAnswerSpec>,
    },
}

#[derive(Clone, Debug)]
struct UserInputAnswerSpec {
    option_labels: HashMap<String, String>,
    allows_other: bool,
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

fn user_input_option_id(params_hash: &str, question_id: &str, index: usize) -> String {
    let mut digest = Sha256::new();
    for component in [params_hash.as_bytes(), question_id.as_bytes()] {
        digest.update((component.len() as u64).to_be_bytes());
        digest.update(component);
    }
    digest.update((index as u64).to_be_bytes());
    format!("option-{}", &hex::encode(digest.finalize())[..20])
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
    let decision_context = approval_decision_context(method, object, workspace_root, &decisions);
    let view = PendingRequestView {
        pending_id: id,
        kind,
        response_kind: PendingResponseKind::NativeServerRequest,
        operation: operation.to_owned(),
        target_alias: approval_target_alias(method, object, workspace_root),
        // Raw reasons can repeat a command, absolute cwd, or secret. The safe
        // evidence projection below is the approval explanation boundary.
        reason: None,
        questions: Vec::new(),
        allowed_decisions: decisions,
        decision_context,
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
        &[
            "threadId",
            "turnId",
            "itemId",
            "questions",
            "autoResolutionMs",
        ],
        &[],
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
    let hash = params_hash(params)?;
    let mut question_ids = HashSet::new();
    let mut answer_options = BTreeMap::new();
    let mut views = Vec::new();
    for question in questions {
        let question = object(question)?;
        if !exact_keys(
            question,
            &["id", "header", "question", "isOther", "isSecret", "options"],
            &[],
        ) || question.get("isSecret").and_then(Value::as_bool) != Some(false)
            || question.get("isOther").and_then(Value::as_bool) != Some(true)
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
        let mut option_labels = HashMap::new();
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
            let option_id = user_input_option_id(&hash, &id, index);
            option_labels.insert(option_id.clone(), label.clone());
            option_views.push(PendingOption {
                id: option_id,
                label,
                description: non_empty_string(option, "description")?.to_owned(),
            });
        }
        answer_options.insert(
            id.clone(),
            UserInputAnswerSpec {
                option_labels,
                allows_other: true,
            },
        );
        views.push(PendingQuestion {
            id,
            header,
            question: prompt,
            options: option_views,
        });
    }

    let id = pending_id(&rpc_id, &hash);
    let view = PendingRequestView {
        pending_id: id,
        kind: PendingKind::UserInput,
        response_kind: PendingResponseKind::NativeServerRequest,
        operation: "request_user_input".to_owned(),
        target_alias: "active_turn".to_owned(),
        reason: None,
        questions: views,
        allowed_decisions: Vec::new(),
        decision_context: DecisionContext {
            schema_version: 1,
            category: "user_decision".to_owned(),
            target_kind: "active_turn".to_owned(),
            target_alias: "active_turn".to_owned(),
            effect: "continue_turn".to_owned(),
            scope: "turn".to_owned(),
            risk: "medium".to_owned(),
            reversibility: "unknown".to_owned(),
            recommendation: None,
            evidence: vec!["user_input_requested".to_owned()],
            uncertainty: "limited_context".to_owned(),
        },
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
        let (message, interrupt) = {
            let record = self
                .pending_by_id
                .get(pending_id)
                .ok_or(RequestValidationError::StaleResponse)?;
            build_resolution(record, response)?
        };

        let record = self
            .pending_by_id
            .remove(pending_id)
            .ok_or(RequestValidationError::StaleResponse)?;
        self.pending_by_rpc.remove(&record.rpc_key);

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

fn build_resolution(
    record: &PendingRecord,
    response: &PendingResponse,
) -> Result<(Value, bool), RequestValidationError> {
    match (&record.response_shape, response) {
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
            Ok((
                server_result(&record.rpc_id, json!({"decision": decision})),
                decision == "cancel",
            ))
        }
        (ResponseShape::Permissions { requested }, PendingResponse::Approval { decision }) => {
            if !record.view.allowed_decisions.contains(decision) {
                return Err(RequestValidationError::InvalidResponse);
            }
            Ok(match decision {
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
            })
        }
        (
            ResponseShape::UserInput { answers: expected },
            PendingResponse::UserInput { answers },
        ) => {
            if expected.len() != answers.len() {
                return Err(RequestValidationError::InvalidResponse);
            }
            let mut wire_answers = BTreeMap::new();
            for (question_id, spec) in expected {
                let answer = answers
                    .get(question_id)
                    .ok_or(RequestValidationError::InvalidResponse)?;
                let wire_value = match answer {
                    PendingUserInputAnswer::Option { option_id } => spec
                        .option_labels
                        .get(option_id)
                        .cloned()
                        .ok_or(RequestValidationError::InvalidResponse)?,
                    PendingUserInputAnswer::Other { text }
                        if spec.allows_other && valid_other_answer(text) =>
                    {
                        text.clone()
                    }
                    PendingUserInputAnswer::Other { .. } => {
                        return Err(RequestValidationError::InvalidResponse)
                    }
                };
                wire_answers.insert(question_id.clone(), json!({"answers": [wire_value]}));
            }
            Ok((
                server_result(&record.rpc_id, json!({"answers": wire_answers})),
                false,
            ))
        }
        _ => Err(RequestValidationError::InvalidResponse),
    }
}

fn valid_other_answer(value: &str) -> bool {
    value == value.trim() && (1..=MAX_OTHER_ANSWER_SCALARS).contains(&value.chars().count())
}

fn approval_decision_context(
    method: &str,
    params: &serde_json::Map<String, Value>,
    workspace_root: &Path,
    allowed_decisions: &[ApprovalDecision],
) -> DecisionContext {
    let target_alias = approval_target_alias(method, params, workspace_root);
    let (
        category,
        target_kind,
        effect,
        scope,
        risk,
        reversibility,
        preferred_recommendation,
        mut evidence,
    ) = match method {
        "item/commandExecution/requestApproval" => {
            let network = params
                .get("networkApprovalContext")
                .is_some_and(|value| !value.is_null());
            let additional = params
                .get("additionalPermissions")
                .is_some_and(|value| !value.is_null());
            let known_read_only = params
                .get("commandActions")
                .and_then(Value::as_array)
                .is_some_and(|actions| {
                    !actions.is_empty()
                        && actions.iter().all(|action| {
                            action
                                .get("type")
                                .and_then(Value::as_str)
                                .is_some_and(|kind| ["read", "listFiles", "search"].contains(&kind))
                        })
                });
            if network || additional || !known_read_only {
                (
                    "command_execution",
                    if network { "network_host" } else { "workspace" },
                    "execute_command",
                    "command",
                    "high",
                    "unknown",
                    ApprovalDecision::Reject,
                    vec!["untrusted_command".to_owned()],
                )
            } else {
                (
                    "command_execution",
                    "workspace_path",
                    "execute_command",
                    "command",
                    "low",
                    "reversible",
                    ApprovalDecision::ApproveOnce,
                    vec!["read_only_action".to_owned()],
                )
            }
        }
        "item/fileChange/requestApproval" => (
            "file_change",
            "workspace_path",
            "apply_file_change",
            "turn",
            "medium",
            "partially_reversible",
            ApprovalDecision::Reject,
            vec!["repository_mutation".to_owned()],
        ),
        _ => (
            "permissions",
            "workspace",
            "grant_permissions",
            "turn",
            "high",
            "not_reversible",
            ApprovalDecision::Reject,
            permission_evidence(params.get("permissions")),
        ),
    };
    evidence.sort();
    evidence.dedup();
    let recommendation = if allowed_decisions.contains(&preferred_recommendation) {
        preferred_recommendation
    } else if allowed_decisions.contains(&ApprovalDecision::Reject) {
        ApprovalDecision::Reject
    } else if allowed_decisions.contains(&ApprovalDecision::Stop) {
        ApprovalDecision::Stop
    } else {
        allowed_decisions[0]
    };
    DecisionContext {
        schema_version: 1,
        category: category.to_owned(),
        target_kind: target_kind.to_owned(),
        target_alias,
        effect: effect.to_owned(),
        scope: scope.to_owned(),
        risk: risk.to_owned(),
        reversibility: reversibility.to_owned(),
        recommendation: Some(approval_decision_name(recommendation).to_owned()),
        evidence,
        uncertainty: "none".to_owned(),
    }
}

fn approval_decision_name(decision: ApprovalDecision) -> &'static str {
    match decision {
        ApprovalDecision::ApproveOnce => "approve_once",
        ApprovalDecision::Reject => "reject",
        ApprovalDecision::Stop => "stop",
    }
}

fn approval_target_alias(
    method: &str,
    params: &serde_json::Map<String, Value>,
    workspace_root: &Path,
) -> String {
    if method == "item/commandExecution/requestApproval" {
        if let Some(host) = params
            .get("networkApprovalContext")
            .and_then(Value::as_object)
            .and_then(|context| context.get("host"))
            .and_then(Value::as_str)
        {
            let digest = hex::encode(Sha256::digest(host.as_bytes()));
            return format!("host-{}", &digest[..12]);
        }
        if let Some(path) = params
            .get("commandActions")
            .and_then(Value::as_array)
            .and_then(|actions| actions.iter().find_map(|action| action.get("path")))
            .and_then(Value::as_str)
        {
            return path_alias(path, workspace_root);
        }
    }
    if method == "item/fileChange/requestApproval" {
        if let Some(path) = params.get("grantRoot").and_then(Value::as_str) {
            return path_alias(path, workspace_root);
        }
    }
    "workspace".to_owned()
}

fn path_alias(raw: &str, workspace_root: &Path) -> String {
    let path = Path::new(raw);
    if let Ok(relative) = path.strip_prefix(workspace_root) {
        if !relative
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
        {
            let display = relative.to_string_lossy();
            return if display.is_empty() {
                "workspace".to_owned()
            } else {
                format!("workspace/{display}")
            };
        }
    }
    "external_path".to_owned()
}

fn permission_evidence(value: Option<&Value>) -> Vec<String> {
    let Some(object) = value.and_then(Value::as_object) else {
        return vec!["permission_profile".to_owned()];
    };
    let mut evidence = Vec::new();
    if object
        .get("fileSystem")
        .is_some_and(|value| !value.is_null())
    {
        evidence.push("filesystem_permission".to_owned());
    }
    if object.get("network").is_some_and(|value| !value.is_null()) {
        evidence.push("network_permission".to_owned());
    }
    if evidence.is_empty() {
        evidence.push("permission_profile".to_owned());
    }
    evidence
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

    fn current_user_input_params() -> Value {
        json!({
            "threadId": "thread-1",
            "turnId": "turn-1",
            "itemId": "item-1",
            "questions": [{
                "id": "q1",
                "header": "Choice",
                "question": "Choose one",
                "isOther": true,
                "isSecret": false,
                "options": [
                    {"label": "A", "description": "First"},
                    {"label": "B", "description": "Second"}
                ]
            }],
            "autoResolutionMs": null
        })
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
            "cwd": "/\u{0055}sers/alice/project"
        });
        let outcome = ledger
            .register(
                RpcId::Unsigned(7),
                "item/commandExecution/requestApproval",
                &params,
                &active(),
                Path::new("/\u{0055}sers/alice/project"),
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
    fn user_input_rejects_secret_non_other_and_unknown_fields() {
        let capabilities = CodexCapabilities {
            native_request_user_input: CapabilityState::Supported,
            ..CodexCapabilities::default()
        };
        let mut secret = current_user_input_params();
        secret["questions"][0]["isSecret"] = Value::Bool(true);
        let mut non_other = current_user_input_params();
        non_other["questions"][0]["isOther"] = Value::Bool(false);
        let mut unknown = current_user_input_params();
        unknown["questions"][0]["futureField"] = Value::Bool(true);

        for (index, invalid) in [secret, non_other, unknown].iter().enumerate() {
            let mut ledger = ServerRequestLedger::default();
            assert_eq!(
                ledger.register(
                    RpcId::Unsigned(index as u64 + 1),
                    "item/tool/requestUserInput",
                    invalid,
                    &active(),
                    Path::new("/workspace"),
                    &capabilities,
                ),
                Err(RequestValidationError::InvalidParams)
            );
        }
    }

    #[test]
    fn invalid_response_does_not_consume_the_pending_approval() {
        let mut ledger = ServerRequestLedger::default();
        let params = json!({
            "threadId": "thread-1",
            "turnId": "turn-1",
            "itemId": "item-1",
            "startedAtMs": 1,
            "reason": "write"
        });
        let RegisterOutcome::New(view) = ledger
            .register(
                RpcId::Unsigned(11),
                "item/fileChange/requestApproval",
                &params,
                &active(),
                Path::new("/workspace"),
                &CodexCapabilities::default(),
            )
            .expect("register")
        else {
            panic!("new request expected");
        };

        assert!(matches!(
            ledger.resolve(
                &view.pending_id,
                &PendingResponse::UserInput {
                    answers: BTreeMap::new(),
                },
            ),
            Err(RequestValidationError::InvalidResponse)
        ));
        assert!(ledger
            .resolve(
                &view.pending_id,
                &PendingResponse::Approval {
                    decision: ApprovalDecision::Reject,
                },
            )
            .is_ok());
    }

    #[test]
    fn current_user_input_translates_opaque_option_id_to_exact_label() {
        let mut ledger = ServerRequestLedger::default();
        let capabilities = CodexCapabilities {
            native_request_user_input: CapabilityState::Supported,
            ..CodexCapabilities::default()
        };
        let mut params = current_user_input_params();
        params["questions"][0]["options"][0]["label"] = json!(" Continue exactly ");
        let RegisterOutcome::New(view) = ledger
            .register(
                RpcId::Unsigned(12),
                "item/tool/requestUserInput",
                &params,
                &active(),
                Path::new("/workspace"),
                &capabilities,
            )
            .expect("register")
        else {
            panic!("new request expected");
        };
        let option_id = view.questions[0].options[0].id.clone();
        assert!(option_id.starts_with("option-"));
        assert_ne!(option_id, " Continue exactly ");

        let resolution = ledger
            .resolve(
                &view.pending_id,
                &PendingResponse::UserInput {
                    answers: BTreeMap::from([(
                        "q1".to_owned(),
                        PendingUserInputAnswer::Option { option_id },
                    )]),
                },
            )
            .expect("known option ID");
        assert_eq!(
            resolution.message["result"]["answers"]["q1"]["answers"][0],
            " Continue exactly "
        );
    }

    #[test]
    fn current_user_input_accepts_only_explicit_bounded_other_answers() {
        let mut ledger = ServerRequestLedger::default();
        let capabilities = CodexCapabilities {
            native_request_user_input: CapabilityState::Supported,
            ..CodexCapabilities::default()
        };
        let params = current_user_input_params();
        let RegisterOutcome::New(view) = ledger
            .register(
                RpcId::Unsigned(12),
                "item/tool/requestUserInput",
                &params,
                &active(),
                Path::new("/workspace"),
                &capabilities,
            )
            .expect("register")
        else {
            panic!("new request expected");
        };

        for invalid_value in ["".to_owned(), " padded ".to_owned(), "x".repeat(2_001)] {
            let invalid = BTreeMap::from([(
                "q1".to_owned(),
                PendingUserInputAnswer::Other {
                    text: invalid_value,
                },
            )]);
            assert!(matches!(
                ledger.resolve(
                    &view.pending_id,
                    &PendingResponse::UserInput { answers: invalid },
                ),
                Err(RequestValidationError::InvalidResponse)
            ));
        }
        let other = BTreeMap::from([(
            "q1".to_owned(),
            PendingUserInputAnswer::Other {
                text: "Another safe path".to_owned(),
            },
        )]);
        let resolution = ledger
            .resolve(
                &view.pending_id,
                &PendingResponse::UserInput { answers: other },
            )
            .expect("bounded Other answer");
        assert_eq!(
            resolution.message["result"]["answers"]["q1"]["answers"][0],
            "Another safe path"
        );
    }

    #[test]
    fn current_user_input_rejects_unknown_option_id_without_consuming_request() {
        let mut ledger = ServerRequestLedger::default();
        let capabilities = CodexCapabilities {
            native_request_user_input: CapabilityState::Supported,
            ..CodexCapabilities::default()
        };
        let RegisterOutcome::New(view) = ledger
            .register(
                RpcId::Unsigned(14),
                "item/tool/requestUserInput",
                &current_user_input_params(),
                &active(),
                Path::new("/workspace"),
                &capabilities,
            )
            .expect("register")
        else {
            panic!("new request expected");
        };
        let unknown = BTreeMap::from([(
            "q1".to_owned(),
            PendingUserInputAnswer::Option {
                option_id: "option-unknown".to_owned(),
            },
        )]);
        assert!(matches!(
            ledger.resolve(
                &view.pending_id,
                &PendingResponse::UserInput { answers: unknown },
            ),
            Err(RequestValidationError::InvalidResponse)
        ));

        let known_option_id = view.questions[0].options[1].id.clone();
        assert!(ledger
            .resolve(
                &view.pending_id,
                &PendingResponse::UserInput {
                    answers: BTreeMap::from([(
                        "q1".to_owned(),
                        PendingUserInputAnswer::Option {
                            option_id: known_option_id,
                        },
                    )]),
                },
            )
            .is_ok());
    }

    #[test]
    fn current_user_input_rejects_option_ids_swapped_between_questions() {
        let mut ledger = ServerRequestLedger::default();
        let capabilities = CodexCapabilities {
            native_request_user_input: CapabilityState::Supported,
            ..CodexCapabilities::default()
        };
        let mut params = current_user_input_params();
        params["questions"]
            .as_array_mut()
            .expect("questions")
            .push(json!({
                "id": "q2",
                "header": "Scope",
                "question": "Choose a scope",
                "isOther": true,
                "isSecret": false,
                "options": [
                    {"label": "Current file", "description": "Change one file"},
                    {"label": "Workspace", "description": "Change the workspace"}
                ]
            }));
        let RegisterOutcome::New(view) = ledger
            .register(
                RpcId::Unsigned(15),
                "item/tool/requestUserInput",
                &params,
                &active(),
                Path::new("/workspace"),
                &capabilities,
            )
            .expect("register")
        else {
            panic!("new request expected");
        };
        let first_id = view.questions[0].options[0].id.clone();
        let second_id = view.questions[1].options[0].id.clone();
        assert_ne!(first_id, second_id);

        let swapped = BTreeMap::from([
            (
                "q1".to_owned(),
                PendingUserInputAnswer::Option {
                    option_id: second_id,
                },
            ),
            (
                "q2".to_owned(),
                PendingUserInputAnswer::Option {
                    option_id: first_id,
                },
            ),
        ]);
        assert!(matches!(
            ledger.resolve(
                &view.pending_id,
                &PendingResponse::UserInput { answers: swapped },
            ),
            Err(RequestValidationError::InvalidResponse)
        ));
    }

    #[test]
    fn approval_view_projects_only_safe_structured_metadata() {
        let mut ledger = ServerRequestLedger::default();
        let params = json!({
            "threadId": "thread-1",
            "turnId": "turn-1",
            "itemId": "item-1",
            "startedAtMs": 1,
            "command": "curl -H 'Authorization: Bearer secret-value' https://private.example",
            "cwd": "/\u{0055}sers/alice/project",
            "environmentId": "environment-private",
            "reason": "run curl -H Authorization secret-value",
            "networkApprovalContext": {"host": "private.example"}
        });
        let RegisterOutcome::New(view) = ledger
            .register(
                RpcId::Unsigned(13),
                "item/commandExecution/requestApproval",
                &params,
                &active(),
                Path::new("/\u{0055}sers/alice/project"),
                &CodexCapabilities::default(),
            )
            .expect("register")
        else {
            panic!("new request expected");
        };
        let encoded = serde_json::to_string(&view).expect("serialize");

        assert!(view.target_alias.starts_with("host-"));
        assert_eq!(view.decision_context.risk, "high");
        for private in [
            "curl",
            "Authorization",
            "secret-value",
            "private.example",
            "/\u{0055}sers/alice/project",
            "environment-private",
        ] {
            assert!(!encoded.contains(private), "leaked {private}");
        }
    }
}
