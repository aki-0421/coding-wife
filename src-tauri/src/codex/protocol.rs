use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};
use thiserror::Error;

use super::attachment::ResolvedAttachment;
use super::types::{ReasoningPreset, ReviewTarget, CODEX_MODEL};

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
                    "allowFreeform": {"const": false}
                }
            }
        ]
    })
}

pub(crate) fn turn_start_params(
    thread_id: &str,
    client_user_message_id: &str,
    text: &str,
    effort: ReasoningPreset,
    attachments: &[ResolvedAttachment],
) -> Value {
    let mut input = Vec::with_capacity(attachments.len() + 1);
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
    json!({
        "threadId": thread_id,
        "clientUserMessageId": client_user_message_id,
        "input": input,
        "model": CODEX_MODEL,
        "effort": effort.as_wire(),
        "outputSchema": decision_output_schema(),
    })
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
        let fast = turn_start_params("thread", "message", "hello", ReasoningPreset::Low, &[]);
        let max = turn_start_params("thread", "message", "hello", ReasoningPreset::Max, &[]);

        assert_eq!(fast["model"], CODEX_MODEL);
        assert_eq!(fast["effort"], "low");
        assert_eq!(max["effort"], "max");
        assert!(fast.get("serviceTier").is_none());
        assert!(fast.get("collaborationMode").is_none());
        assert!(fast.get("multiAgentMode").is_none());
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
        );

        assert_eq!(
            params["input"],
            json!([
                {"type": "localImage", "path": "/app-private/attachment-snapshots/lease/00.snapshot"},
                {"type": "mention", "name": "notes.txt", "path": "/app-private/attachment-snapshots/lease/01.snapshot"}
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
