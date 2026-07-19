use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};
use thiserror::Error;

use super::attachment::ResolvedAttachment;
use super::bundled_skill::{ResolvedBundledSkill, COMMIT_SKILL_NAME, EXPLAIN_COMMIT_SKILL_NAME};
use super::types::{ReasoningPreset, ReviewTarget, TurnExecutionClass, CODEX_MODEL};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OutboundProfile {
    Stable,
    Experimental,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ThreadPolicyResponse {
    pub thread_id: String,
    pub response_cwd: PathBuf,
    pub thread_cwd: PathBuf,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SupportThreadPolicyResponse {
    pub thread_id: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Error)]
pub enum SupportThreadPolicyError {
    #[error("the support thread response was missing a required field")]
    MissingField,
    #[error("the support thread response did not preserve its isolated policy")]
    Policy,
    #[error("the support thread response contained an invalid path")]
    Path,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Error)]
pub enum ThreadPolicyError {
    #[error("the thread response was missing a required field")]
    MissingField,
    #[error("the thread response did not preserve the selected model")]
    Model,
    #[error("the thread response did not preserve on-request approval")]
    ApprovalPolicy,
    #[error("the thread response did not preserve workspace-write sandboxing")]
    Sandbox,
    #[error("the thread response unexpectedly created an ephemeral thread")]
    Ephemeral,
    #[error("the thread response contained an invalid path")]
    Path,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Error)]
pub enum TurnContractError {
    #[error("the turn skill did not match its execution class")]
    SkillClass,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub enum RpcId {
    Unsigned(u64),
    Signed(i64),
    String(String),
}

impl RpcId {
    pub fn from_value(value: &Value) -> Option<Self> {
        match value {
            Value::Number(number) => number
                .as_u64()
                .map(Self::Unsigned)
                .or_else(|| number.as_i64().map(Self::Signed)),
            Value::String(value) if !value.is_empty() && value.len() <= 256 => {
                Some(Self::String(value.clone()))
            }
            _ => None,
        }
    }

    pub fn to_value(&self) -> Value {
        match self {
            Self::Unsigned(value) => Value::from(*value),
            Self::Signed(value) => Value::from(*value),
            Self::String(value) => Value::String(value.clone()),
        }
    }

    pub fn stable_key(&self) -> String {
        match self {
            Self::Unsigned(value) => format!("u:{value}"),
            Self::Signed(value) => format!("i:{value}"),
            Self::String(value) => format!("s:{value}"),
        }
    }
}

#[derive(Clone, Debug)]
pub struct RpcErrorObject {
    pub code: i64,
    pub category: &'static str,
}

#[derive(Clone, Debug)]
pub enum InboundMessage {
    Response {
        id: RpcId,
        result: Result<Value, RpcErrorObject>,
    },
    ServerRequest {
        id: RpcId,
        method: String,
        params: Value,
        byte_count: usize,
    },
    Notification {
        method: String,
        params: Value,
        byte_count: usize,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Error)]
pub enum ProtocolError {
    #[error("the app-server message shape was invalid")]
    InvalidMessage,
    #[error("the app-server response shape was invalid")]
    InvalidResponse,
    #[error("the app-server request id was invalid")]
    InvalidId,
    #[error("the app-server method was invalid")]
    InvalidMethod,
}

fn method_from(object: &Map<String, Value>) -> Result<Option<String>, ProtocolError> {
    match object.get("method") {
        Some(Value::String(method)) if !method.is_empty() && method.len() <= 256 => {
            Ok(Some(method.clone()))
        }
        Some(_) => Err(ProtocolError::InvalidMethod),
        None => Ok(None),
    }
}

fn classify_rpc_error(value: &Value) -> Result<RpcErrorObject, ProtocolError> {
    let object = value.as_object().ok_or(ProtocolError::InvalidResponse)?;
    let code = object
        .get("code")
        .and_then(Value::as_i64)
        .ok_or(ProtocolError::InvalidResponse)?;
    let message = object
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let category = if code == -32600 && message.contains("Not initialized") {
        "not_initialized"
    } else if code == -32600 && message.contains("Already initialized") {
        "already_initialized"
    } else if code == -32600 && message.contains("experimentalApi") {
        "experimental_rejected"
    } else if code == -32601 {
        "method_not_found"
    } else if code == -32602 {
        "invalid_params"
    } else if code == -32001 {
        "overloaded"
    } else {
        "server_error"
    };
    Ok(RpcErrorObject { code, category })
}

pub fn classify_message(value: Value, byte_count: usize) -> Result<InboundMessage, ProtocolError> {
    let object = value.as_object().ok_or(ProtocolError::InvalidMessage)?;
    if object.contains_key("jsonrpc") {
        return Err(ProtocolError::InvalidMessage);
    }
    let method = method_from(object)?;
    let id = match object.get("id") {
        Some(value) => Some(RpcId::from_value(value).ok_or(ProtocolError::InvalidId)?),
        None => None,
    };

    match (method, id) {
        (Some(method), Some(id)) => Ok(InboundMessage::ServerRequest {
            id,
            method,
            params: object.get("params").cloned().unwrap_or_else(|| json!({})),
            byte_count,
        }),
        (Some(method), None) => Ok(InboundMessage::Notification {
            method,
            params: object.get("params").cloned().unwrap_or_else(|| json!({})),
            byte_count,
        }),
        (None, Some(id)) => {
            let has_result = object.contains_key("result");
            let has_error = object.contains_key("error");
            if has_result == has_error {
                return Err(ProtocolError::InvalidResponse);
            }
            let result = if has_result {
                Ok(object.get("result").cloned().unwrap_or(Value::Null))
            } else {
                Err(classify_rpc_error(
                    object.get("error").ok_or(ProtocolError::InvalidResponse)?,
                )?)
            };
            Ok(InboundMessage::Response { id, result })
        }
        (None, None) => Err(ProtocolError::InvalidMessage),
    }
}

pub fn client_request(id: u64, method: &str, params: Value) -> Value {
    json!({"id": id, "method": method, "params": params})
}

pub fn client_notification(method: &str) -> Value {
    json!({"method": method})
}

pub fn server_result(id: &RpcId, result: Value) -> Value {
    json!({"id": id.to_value(), "result": result})
}

pub fn server_error(id: &RpcId, code: i64, message: &str) -> Value {
    json!({"id": id.to_value(), "error": {"code": code, "message": message}})
}

pub fn initialize_params(app_version: &str, experimental_api: bool) -> Value {
    json!({
        "clientInfo": {
            "name": "coding_wife",
            "title": "Coding Wife",
            "version": app_version,
        },
        "capabilities": {
            "experimentalApi": experimental_api,
            "requestAttestation": false,
            "mcpServerOpenaiFormElicitation": false,
        },
    })
}

pub fn account_read_params() -> Value {
    json!({"refreshToken": false})
}

pub fn config_read_params(cwd: Option<&Path>) -> Value {
    match cwd.and_then(Path::to_str) {
        Some(cwd) => json!({"cwd": cwd, "includeLayers": false}),
        None => json!({"includeLayers": false}),
    }
}

pub fn model_list_params(cursor: Option<&str>) -> Value {
    json!({"cursor": cursor, "includeHidden": true, "limit": 100})
}

pub fn thread_list_params(cwd: &Path, cursor: Option<&str>) -> Value {
    json!({
        "cwd": cwd.to_string_lossy(),
        "cursor": cursor,
        "limit": 100,
        "archived": false,
        "sortKey": "updated_at",
        "sortDirection": "desc",
    })
}

pub fn thread_start_params(cwd: &Path, profile: OutboundProfile) -> Value {
    let mut params = json!({
        "model": CODEX_MODEL,
        "cwd": cwd.to_string_lossy(),
        "approvalPolicy": "on-request",
        "sandbox": "workspace-write",
        "ephemeral": false,
    });
    if profile == OutboundProfile::Experimental {
        let object = params.as_object_mut().expect("thread params object");
        object.insert("allowProviderModelFallback".to_owned(), Value::Bool(false));
        object.insert(
            "runtimeWorkspaceRoots".to_owned(),
            json!([cwd.to_string_lossy()]),
        );
        object.insert("experimentalRawEvents".to_owned(), Value::Bool(false));
        object.insert("dynamicTools".to_owned(), json!([]));
        object.insert("environments".to_owned(), json!([]));
    }
    params
}

pub fn thread_resume_params(cwd: &Path, thread_id: &str, profile: OutboundProfile) -> Value {
    let mut params = json!({
        "threadId": thread_id,
        "model": CODEX_MODEL,
        "cwd": cwd.to_string_lossy(),
        "approvalPolicy": "on-request",
        "sandbox": "workspace-write",
        "excludeTurns": true,
    });
    if profile == OutboundProfile::Experimental {
        params
            .as_object_mut()
            .expect("thread params object")
            .insert(
                "runtimeWorkspaceRoots".to_owned(),
                json!([cwd.to_string_lossy()]),
            );
    }
    params
}

pub(crate) fn support_thread_start_params(
    cwd: &Path,
    model: &str,
    model_provider: Option<&str>,
) -> Value {
    let mut params = json!({
        "model": model,
        "cwd": cwd.to_string_lossy(),
        "approvalPolicy": "never",
        "permissions": "coding-wife-support-zero",
        "ephemeral": true,
        "historyMode": "legacy",
        "allowProviderModelFallback": false,
        "experimentalRawEvents": false,
        "runtimeWorkspaceRoots": [],
        "dynamicTools": [],
        "environments": [],
        "selectedCapabilityRoots": [],
    });
    if let Some(model_provider) = model_provider {
        params
            .as_object_mut()
            .expect("support thread params object")
            .insert(
                "modelProvider".to_owned(),
                Value::String(model_provider.to_owned()),
            );
    }
    params
}

pub(crate) fn parse_support_thread_policy_response(
    result: &Value,
    cwd: &Path,
    model: &str,
    model_provider: Option<&str>,
) -> Result<SupportThreadPolicyResponse, SupportThreadPolicyError> {
    let object = result
        .as_object()
        .ok_or(SupportThreadPolicyError::MissingField)?;
    if object.get("model").and_then(Value::as_str) != Some(model)
        || object.get("approvalPolicy").and_then(Value::as_str) != Some("never")
        || result
            .pointer("/activePermissionProfile/id")
            .and_then(Value::as_str)
            != Some("coding-wife-support-zero")
        || !result
            .pointer("/activePermissionProfile/extends")
            .is_some_and(Value::is_null)
        || result.pointer("/sandbox/type").and_then(Value::as_str) != Some("readOnly")
        || result
            .pointer("/sandbox/networkAccess")
            .and_then(Value::as_bool)
            != Some(false)
        || !object
            .get("runtimeWorkspaceRoots")
            .and_then(Value::as_array)
            .is_some_and(Vec::is_empty)
        || !object
            .get("instructionSources")
            .and_then(Value::as_array)
            .is_some_and(Vec::is_empty)
        || model_provider.is_some_and(|expected| {
            object.get("modelProvider").and_then(Value::as_str) != Some(expected)
        })
    {
        return Err(SupportThreadPolicyError::Policy);
    }
    let expected_cwd = std::fs::canonicalize(cwd).map_err(|_| SupportThreadPolicyError::Path)?;
    let response_cwd = object
        .get("cwd")
        .and_then(Value::as_str)
        .filter(|value| Path::new(value).is_absolute())
        .and_then(|value| std::fs::canonicalize(value).ok())
        .ok_or(SupportThreadPolicyError::Path)?;
    let thread = object
        .get("thread")
        .and_then(Value::as_object)
        .ok_or(SupportThreadPolicyError::MissingField)?;
    let thread_cwd = thread
        .get("cwd")
        .and_then(Value::as_str)
        .filter(|value| Path::new(value).is_absolute())
        .and_then(|value| std::fs::canonicalize(value).ok())
        .ok_or(SupportThreadPolicyError::Path)?;
    if response_cwd != expected_cwd
        || thread_cwd != expected_cwd
        || thread.get("ephemeral").and_then(Value::as_bool) != Some(true)
        || !thread.get("path").is_some_and(Value::is_null)
        || model_provider.is_some_and(|expected| {
            thread.get("modelProvider").and_then(Value::as_str) != Some(expected)
        })
    {
        return Err(SupportThreadPolicyError::Policy);
    }
    let thread_id = thread
        .get("id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && value.len() <= 256)
        .map(str::to_owned)
        .ok_or(SupportThreadPolicyError::MissingField)?;
    Ok(SupportThreadPolicyResponse { thread_id })
}

pub fn decision_output_schema() -> Value {
    json!({
        "oneOf": [
            {
                "type": "object",
                "additionalProperties": false,
                "required": ["schemaVersion", "kind", "message"],
                "properties": {
                    "schemaVersion": {"const": 1},
                    "kind": {"const": "result"},
                    "message": {"type": "string", "minLength": 1, "maxLength": 65536}
                }
            },
            {
                "type": "object",
                "additionalProperties": false,
                "required": [
                    "schemaVersion",
                    "kind",
                    "message",
                    "decisionId",
                    "question",
                    "options",
                    "context",
                    "allowFreeform"
                ],
                "properties": {
                    "schemaVersion": {"const": 1},
                    "kind": {"const": "decision_request"},
                    "message": {"type": "string", "minLength": 1, "maxLength": 4096},
                    "decisionId": {"type": "string", "minLength": 1, "maxLength": 128},
                    "question": {"type": "string", "minLength": 1, "maxLength": 4096},
                    "options": {
                        "type": "array",
                        "minItems": 2,
                        "maxItems": 3,
                        "uniqueItems": true,
                        "items": {
                            "type": "object",
                            "additionalProperties": false,
                            "required": ["id", "label", "description"],
                            "properties": {
                                "id": {"type": "string", "minLength": 1, "maxLength": 128},
                                "label": {"type": "string", "minLength": 1, "maxLength": 256},
                                "description": {"type": "string", "maxLength": 1024}
                            }
                        }
                    },
                    "context": {
                        "type": "object",
                        "additionalProperties": false,
                        "required": [
                            "schemaVersion",
                            "category",
                            "targetKind",
                            "targetAlias",
                            "effect",
                            "scope",
                            "risk",
                            "reversibility",
                            "recommendation",
                            "evidence",
                            "uncertainty"
                        ],
                        "properties": {
                            "schemaVersion": {"const": 1},
                            "category": {"const": "user_decision"},
                            "targetKind": {"const": "active_turn"},
                            "targetAlias": {"const": "active_turn"},
                            "effect": {"const": "continue_turn"},
                            "scope": {"const": "turn"},
                            "risk": {"enum": ["low", "medium", "high"]},
                            "reversibility": {
                                "enum": [
                                    "reversible",
                                    "partially_reversible",
                                    "not_reversible",
                                    "unknown"
                                ]
                            },
                            "recommendation": {
                                "oneOf": [
                                    {"type": "string", "minLength": 1, "maxLength": 128},
                                    {"type": "null"}
                                ]
                            },
                            "evidence": {
                                "type": "array",
                                "minItems": 1,
                                "maxItems": 8,
                                "uniqueItems": true,
                                "items": {"type": "string", "minLength": 1, "maxLength": 512}
                            },
                            "uncertainty": {
                                "enum": ["none", "limited_context", "unknown_effects"]
                            }
                        }
                    },
                    "allowFreeform": {"const": false}
                }
            }
        ]
    })
}

fn execution_skill_matches(
    execution_class: TurnExecutionClass,
    skill: &ResolvedBundledSkill,
) -> bool {
    let expected_skill = match execution_class {
        TurnExecutionClass::Main => COMMIT_SKILL_NAME,
        TurnExecutionClass::Support => EXPLAIN_COMMIT_SKILL_NAME,
    };
    skill.name == expected_skill
}

pub(crate) fn commit_explanation_output_schema(locale: &str) -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": [
            "schemaVersion",
            "locale",
            "summary",
            "changes",
            "reasons",
            "verification",
            "impact",
            "cautions",
            "howToReadNext",
            "narrationChunks"
        ],
        "properties": {
            "schemaVersion": {"type": "integer", "const": 1},
            "locale": {"type": "string", "const": locale},
            "summary": {"type": "string", "minLength": 1, "maxLength": 4096},
            "changes": bounded_string_array_schema(),
            "reasons": bounded_string_array_schema(),
            "verification": bounded_string_array_schema(),
            "impact": bounded_string_array_schema(),
            "cautions": bounded_string_array_schema(),
            "howToReadNext": bounded_string_array_schema(),
            "narrationChunks": {
                "type": "array",
                "minItems": 1,
                "maxItems": 32,
                "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["sequence", "section", "text"],
                    "properties": {
                        "sequence": {"type": "integer", "minimum": 1, "maximum": 32},
                        "section": {
                            "type": "string",
                            "enum": [
                                "summary",
                                "changes",
                                "reasons",
                                "verification",
                                "impact",
                                "cautions",
                                "howToReadNext"
                            ]
                        },
                        "text": {"type": "string", "minLength": 1, "maxLength": 240}
                    }
                }
            }
        }
    })
}

fn bounded_string_array_schema() -> Value {
    json!({
        "type": "array",
        "minItems": 1,
        "maxItems": 16,
        "items": {"type": "string", "minLength": 1, "maxLength": 2048}
    })
}

pub(crate) fn support_turn_start_params(
    thread_id: &str,
    cwd: &Path,
    client_user_message_id: &str,
    input_text: &str,
    locale: &str,
    model: &str,
    support_skill: &ResolvedBundledSkill,
) -> Result<Value, TurnContractError> {
    if !execution_skill_matches(TurnExecutionClass::Support, support_skill) {
        return Err(TurnContractError::SkillClass);
    }
    Ok(json!({
        "threadId": thread_id,
        "clientUserMessageId": client_user_message_id,
        "input": [
            {"type": "text", "text": input_text, "text_elements": []},
            {"type": "skill", "name": support_skill.name, "path": support_skill.path}
        ],
        "model": model,
        "effort": "low",
        "cwd": cwd.to_string_lossy(),
        "approvalPolicy": "never",
        "permissions": "coding-wife-support-zero",
        "environments": [],
        "runtimeWorkspaceRoots": [],
        "outputSchema": commit_explanation_output_schema(locale),
    }))
}

pub(crate) fn turn_start_params(
    thread_id: &str,
    client_user_message_id: &str,
    text: &str,
    effort: ReasoningPreset,
    attachments: &[ResolvedAttachment],
    commit_skill: &ResolvedBundledSkill,
    execution_class: TurnExecutionClass,
) -> Result<Value, TurnContractError> {
    if !execution_skill_matches(execution_class, commit_skill)
        || (execution_class == TurnExecutionClass::Support && !attachments.is_empty())
    {
        return Err(TurnContractError::SkillClass);
    }
    let mut input = Vec::with_capacity(attachments.len() + 2);
    if !text.trim().is_empty() {
        input.push(json!({"type": "text", "text": text, "text_elements": []}));
    }
    input.extend(attachments.iter().map(|attachment| match attachment {
        ResolvedAttachment::LocalImage { path } => {
            json!({"type": "localImage", "path": path})
        }
        ResolvedAttachment::Mention { name, path } => {
            json!({"type": "mention", "name": name, "path": path})
        }
    }));
    input.push(json!({
        "type": "skill",
        "name": commit_skill.name,
        "path": commit_skill.path,
    }));
    Ok(json!({
        "threadId": thread_id,
        "clientUserMessageId": client_user_message_id,
        "input": input,
        "model": CODEX_MODEL,
        "effort": effort.as_wire(),
        "outputSchema": decision_output_schema(),
    }))
}

pub fn turn_interrupt_params(thread_id: &str, turn_id: &str) -> Value {
    json!({"threadId": thread_id, "turnId": turn_id})
}

pub fn review_start_params(
    thread_id: &str,
    target: &ReviewTarget,
    profile: OutboundProfile,
) -> Option<Value> {
    if profile != OutboundProfile::Experimental {
        return None;
    }
    let target = serde_json::to_value(target).expect("review target serialization cannot fail");
    Some(json!({"threadId": thread_id, "target": target, "delivery": "detached"}))
}

pub fn parse_thread_policy_response(
    result: &Value,
) -> Result<ThreadPolicyResponse, ThreadPolicyError> {
    let object = result.as_object().ok_or(ThreadPolicyError::MissingField)?;
    if object.get("model").and_then(Value::as_str) != Some(CODEX_MODEL) {
        return Err(ThreadPolicyError::Model);
    }
    if object.get("approvalPolicy").and_then(Value::as_str) != Some("on-request") {
        return Err(ThreadPolicyError::ApprovalPolicy);
    }
    if object
        .get("sandbox")
        .and_then(Value::as_object)
        .and_then(|sandbox| sandbox.get("type"))
        .and_then(Value::as_str)
        != Some("workspaceWrite")
    {
        return Err(ThreadPolicyError::Sandbox);
    }
    let response_cwd = object
        .get("cwd")
        .and_then(Value::as_str)
        .filter(|value| Path::new(value).is_absolute())
        .map(PathBuf::from)
        .ok_or(ThreadPolicyError::Path)?;
    let thread = object
        .get("thread")
        .and_then(Value::as_object)
        .ok_or(ThreadPolicyError::MissingField)?;
    let thread_id = thread
        .get("id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && value.len() <= 256)
        .map(str::to_owned)
        .ok_or(ThreadPolicyError::MissingField)?;
    let thread_cwd = thread
        .get("cwd")
        .and_then(Value::as_str)
        .filter(|value| Path::new(value).is_absolute())
        .map(PathBuf::from)
        .ok_or(ThreadPolicyError::Path)?;
    if thread.get("ephemeral").and_then(Value::as_bool) != Some(false) {
        return Err(ThreadPolicyError::Ephemeral);
    }
    Ok(ThreadPolicyResponse {
        thread_id,
        response_cwd,
        thread_cwd,
    })
}

pub fn validate_model_page(result: &Value) -> (bool, bool, bool, Option<String>) {
    let mut model_available = false;
    let mut fast_available = false;
    let mut max_available = false;
    if let Some(models) = result.get("data").and_then(Value::as_array) {
        for model in models {
            let exact = model.get("id").and_then(Value::as_str) == Some(CODEX_MODEL)
                || model.get("model").and_then(Value::as_str) == Some(CODEX_MODEL);
            if !exact {
                continue;
            }
            model_available = true;
            if let Some(efforts) = model
                .get("supportedReasoningEfforts")
                .and_then(Value::as_array)
            {
                for effort in efforts {
                    match effort.get("reasoningEffort").and_then(Value::as_str) {
                        Some("low") => fast_available = true,
                        Some("max") => max_available = true,
                        _ => {}
                    }
                }
            }
        }
    }
    let next_cursor = result
        .get("nextCursor")
        .and_then(Value::as_str)
        .map(str::to_owned);
    (model_available, fast_available, max_available, next_cursor)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn commit_skill() -> ResolvedBundledSkill {
        ResolvedBundledSkill {
            name: "coding-wife-commit-work".to_owned(),
            version: "1.0.0".to_owned(),
            content_digest: format!("sha256:{}", "a".repeat(64)),
            path: PathBuf::from("/app-bundle/resources/skills/coding-wife-commit-work/SKILL.md"),
            verified_entrypoint: std::sync::Arc::from([]),
        }
    }

    fn explain_skill() -> ResolvedBundledSkill {
        ResolvedBundledSkill {
            name: "coding-wife-explain-commit".to_owned(),
            version: "1.0.0".to_owned(),
            content_digest: format!("sha256:{}", "b".repeat(64)),
            path: PathBuf::from("/app-bundle/resources/skills/coding-wife-explain-commit/SKILL.md"),
            verified_entrypoint: std::sync::Arc::from([]),
        }
    }

    #[test]
    fn classifies_out_of_order_responses_by_id() {
        let second = classify_message(json!({"id": 2, "result": {"ok": true}}), 20)
            .expect("second response");
        let first =
            classify_message(json!({"id": 1, "result": {"ok": true}}), 20).expect("first response");

        assert!(matches!(
            second,
            InboundMessage::Response {
                id: RpcId::Unsigned(2),
                ..
            }
        ));
        assert!(matches!(
            first,
            InboundMessage::Response {
                id: RpcId::Unsigned(1),
                ..
            }
        ));
    }

    #[test]
    fn rejects_ambiguous_response_and_jsonrpc_header() {
        assert!(matches!(
            classify_message(json!({"id": 1, "result": {}, "error": {}}), 1),
            Err(ProtocolError::InvalidResponse)
        ));
        assert!(matches!(
            classify_message(json!({"jsonrpc": "2.0", "id": 1, "result": {}}), 1),
            Err(ProtocolError::InvalidMessage)
        ));
    }

    #[test]
    fn turn_always_sets_exact_model_effort_and_omits_service_tier() {
        let skill = commit_skill();
        let fast = turn_start_params(
            "thread",
            "message",
            "hello",
            ReasoningPreset::Low,
            &[],
            &skill,
            TurnExecutionClass::Main,
        )
        .expect("main turn contract");
        let max = turn_start_params(
            "thread",
            "message",
            "hello",
            ReasoningPreset::Max,
            &[],
            &skill,
            TurnExecutionClass::Main,
        )
        .expect("main turn contract");

        assert_eq!(fast["model"], CODEX_MODEL);
        assert_eq!(fast["effort"], "low");
        assert_eq!(max["effort"], "max");
        assert!(fast.get("serviceTier").is_none());
        assert!(fast.get("collaborationMode").is_none());
        assert!(fast.get("multiAgentMode").is_none());
        let skills = fast["input"]
            .as_array()
            .expect("input")
            .iter()
            .filter(|item| item["type"] == "skill")
            .collect::<Vec<_>>();
        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0]["name"], "coding-wife-commit-work");
    }

    #[test]
    fn main_and_support_turns_reject_each_others_skill() {
        assert_eq!(
            turn_start_params(
                "thread",
                "message",
                "hello",
                ReasoningPreset::Low,
                &[],
                &explain_skill(),
                TurnExecutionClass::Main,
            ),
            Err(TurnContractError::SkillClass)
        );
        assert_eq!(
            support_turn_start_params(
                "thread",
                Path::new("/private/support"),
                "message",
                "{}",
                "ja",
                CODEX_MODEL,
                &commit_skill(),
            ),
            Err(TurnContractError::SkillClass)
        );
    }

    #[test]
    fn support_turn_injects_exactly_one_explain_skill_and_no_commit_skill() {
        let params = support_turn_start_params(
            "thread",
            Path::new("/private/support"),
            "message",
            "{}",
            "ja",
            CODEX_MODEL,
            &explain_skill(),
        )
        .expect("support turn contract");
        let input = params["input"].as_array().expect("support input");
        let skills = input
            .iter()
            .filter(|item| item["type"] == "skill")
            .collect::<Vec<_>>();

        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0]["name"], EXPLAIN_COMMIT_SKILL_NAME);
        assert!(input.iter().all(|item| item["name"] != COMMIT_SKILL_NAME));
        assert_eq!(params["approvalPolicy"], "never");
        assert_eq!(params["permissions"], "coding-wife-support-zero");
        assert_eq!(params["environments"], json!([]));
        assert_eq!(params["runtimeWorkspaceRoots"], json!([]));
    }

    #[test]
    fn commit_explanation_schema_keeps_every_documented_bound() {
        let schema = commit_explanation_output_schema("ja");
        assert_eq!(schema["properties"]["summary"]["minLength"], 1);
        assert_eq!(schema["properties"]["summary"]["maxLength"], 4096);
        for name in [
            "changes",
            "reasons",
            "verification",
            "impact",
            "cautions",
            "howToReadNext",
        ] {
            let array = &schema["properties"][name];
            assert_eq!(array["minItems"], 1, "{name}");
            assert_eq!(array["maxItems"], 16, "{name}");
            assert_eq!(array["items"]["minLength"], 1, "{name}");
            assert_eq!(array["items"]["maxLength"], 2048, "{name}");
        }
        let chunks = &schema["properties"]["narrationChunks"];
        assert_eq!(chunks["minItems"], 1);
        assert_eq!(chunks["maxItems"], 32);
        assert_eq!(chunks["items"]["properties"]["sequence"]["minimum"], 1);
        assert_eq!(chunks["items"]["properties"]["sequence"]["maximum"], 32);
        assert_eq!(chunks["items"]["properties"]["text"]["minLength"], 1);
        assert_eq!(chunks["items"]["properties"]["text"]["maxLength"], 240);
    }

    #[test]
    fn turn_projects_validated_images_and_files_without_an_empty_text_item() {
        let attachments = [
            ResolvedAttachment::LocalImage {
                path: "/app-private/attachment-snapshots/lease/00.snapshot".to_owned(),
            },
            ResolvedAttachment::Mention {
                name: "notes.txt".to_owned(),
                path: "/app-private/attachment-snapshots/lease/01.snapshot".to_owned(),
            },
        ];
        let params = turn_start_params(
            "thread",
            "message",
            "  ",
            ReasoningPreset::Low,
            &attachments,
            &commit_skill(),
            TurnExecutionClass::Main,
        )
        .expect("main turn contract");

        assert_eq!(
            params["input"],
            json!([
                {"type": "localImage", "path": "/app-private/attachment-snapshots/lease/00.snapshot"},
                {"type": "mention", "name": "notes.txt", "path": "/app-private/attachment-snapshots/lease/01.snapshot"},
                {"type": "skill", "name": "coding-wife-commit-work", "path": "/app-bundle/resources/skills/coding-wife-commit-work/SKILL.md"}
            ])
        );
    }

    #[test]
    fn thread_disables_provider_fallback_and_raw_events() {
        let params = thread_start_params(Path::new("/workspace"), OutboundProfile::Experimental);

        assert_eq!(params["model"], CODEX_MODEL);
        assert_eq!(params["allowProviderModelFallback"], false);
        assert_eq!(params["experimentalRawEvents"], false);
        assert!(params.get("serviceTier").is_none());
    }

    #[test]
    fn stable_profile_omits_every_experimental_thread_field() {
        let params = thread_start_params(Path::new("/workspace"), OutboundProfile::Stable);
        for field in [
            "allowProviderModelFallback",
            "runtimeWorkspaceRoots",
            "experimentalRawEvents",
            "dynamicTools",
            "environments",
        ] {
            assert!(params.get(field).is_none(), "unexpected {field}");
        }
        assert!(review_start_params(
            "thread",
            &ReviewTarget::UncommittedChanges,
            OutboundProfile::Stable
        )
        .is_none());
    }

    #[test]
    fn thread_response_requires_the_complete_safety_policy() {
        let response = json!({
            "thread": {"id": "thread", "cwd": "/workspace", "ephemeral": false},
            "model": CODEX_MODEL,
            "cwd": "/workspace",
            "approvalPolicy": "on-request",
            "sandbox": {"type": "workspaceWrite"}
        });
        assert!(parse_thread_policy_response(&response).is_ok());
        for pointer in ["model", "cwd", "approvalPolicy", "sandbox", "thread"] {
            let mut mutated = response.clone();
            mutated.as_object_mut().expect("object").remove(pointer);
            assert!(parse_thread_policy_response(&mutated).is_err(), "{pointer}");
        }
        let mut ephemeral = response;
        ephemeral["thread"]["ephemeral"] = Value::Bool(true);
        assert_eq!(
            parse_thread_policy_response(&ephemeral),
            Err(ThreadPolicyError::Ephemeral)
        );
    }

    #[test]
    fn support_thread_response_requires_every_isolation_claim() {
        let cwd = std::fs::canonicalize(env!("CARGO_MANIFEST_DIR")).expect("fixture cwd");
        let cwd_text = cwd.to_string_lossy().to_string();
        let response = json!({
            "thread": {
                "id": "support-thread",
                "cwd": cwd_text,
                "path": null,
                "ephemeral": true,
                "modelProvider": "openai"
            },
            "model": CODEX_MODEL,
            "modelProvider": "openai",
            "cwd": cwd_text,
            "runtimeWorkspaceRoots": [],
            "instructionSources": [],
            "approvalPolicy": "never",
            "sandbox": {"type": "readOnly", "networkAccess": false},
            "activePermissionProfile": {
                "id": "coding-wife-support-zero",
                "extends": null
            }
        });
        assert_eq!(
            parse_support_thread_policy_response(&response, &cwd, CODEX_MODEL, Some("openai")),
            Ok(SupportThreadPolicyResponse {
                thread_id: "support-thread".to_owned()
            })
        );

        for pointer in [
            "/model",
            "/modelProvider",
            "/approvalPolicy",
            "/activePermissionProfile/id",
            "/activePermissionProfile/extends",
            "/sandbox/type",
            "/sandbox/networkAccess",
            "/runtimeWorkspaceRoots",
            "/instructionSources",
            "/cwd",
            "/thread/cwd",
            "/thread/path",
            "/thread/ephemeral",
            "/thread/modelProvider",
            "/thread/id",
        ] {
            let mut mutated = response.clone();
            *mutated
                .pointer_mut(pointer)
                .expect("support response field") = match pointer {
                "/activePermissionProfile/extends" | "/thread/path" => json!("unexpected"),
                "/sandbox/networkAccess" => json!(true),
                "/thread/ephemeral" => json!(false),
                "/runtimeWorkspaceRoots" | "/instructionSources" => json!(["unexpected"]),
                "/cwd" | "/thread/cwd" => json!("relative/path"),
                "/thread/id" => json!(""),
                _ => json!("unexpected"),
            };
            assert!(
                parse_support_thread_policy_response(&mutated, &cwd, CODEX_MODEL, Some("openai"))
                    .is_err(),
                "{pointer}"
            );
        }
    }

    #[test]
    fn model_gate_requires_exact_sol_low_and_max() {
        let page = json!({
            "data": [{
                "id": CODEX_MODEL,
                "model": CODEX_MODEL,
                "supportedReasoningEfforts": [
                    {"reasoningEffort": "low"},
                    {"reasoningEffort": "max"}
                ]
            }],
            "nextCursor": null
        });
        assert_eq!(validate_model_page(&page), (true, true, true, None));
    }
}
