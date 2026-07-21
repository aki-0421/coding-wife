use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use thiserror::Error;

use super::decision::{parse_completed_output, DecisionOutput};
use super::redaction::{redact_text, safe_detail_ref};
use super::types::{
    CodexEvent, CodexEventPayload, PendingRequestView, PendingResolutionStatus,
    CODEX_EVENT_SCHEMA_VERSION, CODEX_MODEL,
};

const MAX_EVENT_BYTES: usize = 256 * 1024;
const MAX_ASSISTANT_MESSAGE_BYTES: usize = 64 * 1024;
const MAX_TOOL_EXCERPT_BYTES: usize = 4 * 1024;
const MAX_TOOL_NAME_BYTES: usize = 128;
const MAX_TOOL_SUMMARY_BYTES: usize = 512;
const MAX_TOOL_DURATION_MS: u64 = 24 * 60 * 60 * 1_000;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Error)]
pub enum NormalizeError {
    #[error("the notification params were invalid")]
    InvalidParams,
    #[error("the normalized event exceeded its bound")]
    EventTooLarge,
}

#[derive(Clone, Debug, Default)]
pub struct NormalizeOutcome {
    pub events: Vec<CodexEvent>,
    pub unsupported_terminal: bool,
    pub model_violation: bool,
    pub decision_violation: bool,
    pub fallback_decision: Option<PendingRequestView>,
}

#[derive(Default)]
struct AliasMap {
    values: HashMap<String, String>,
}

impl AliasMap {
    fn get(&mut self, prefix: &str, raw: &str) -> String {
        self.values
            .entry(format!("{prefix}:{raw}"))
            .or_insert_with(|| format!("{prefix}-{}", uuid::Uuid::new_v4()))
            .clone()
    }
}

pub struct EventNormalizer {
    workspace_id: String,
    workspace_root: PathBuf,
    generation: u64,
    sequence: u64,
    detail_sequence: u64,
    aliases: AliasMap,
}

impl EventNormalizer {
    pub fn new(workspace_id: String, workspace_root: PathBuf, generation: u64) -> Self {
        Self {
            workspace_id,
            workspace_root,
            generation,
            sequence: 0,
            detail_sequence: 0,
            aliases: AliasMap::default(),
        }
    }

    pub fn thread_handle(&mut self, raw: &str) -> String {
        self.aliases.get("thread", raw)
    }

    pub fn turn_handle(&mut self, raw: &str) -> String {
        self.aliases.get("turn", raw)
    }

    pub fn item_handle(&mut self, raw: &str) -> String {
        self.aliases.get("item", raw)
    }

    fn detail_ref(&mut self, scope: &str) -> String {
        self.detail_sequence += 1;
        safe_detail_ref(scope, self.detail_sequence)
    }

    fn event(&mut self, payload: CodexEventPayload) -> Result<CodexEvent, NormalizeError> {
        self.sequence += 1;
        let event = CodexEvent {
            schema_version: CODEX_EVENT_SCHEMA_VERSION,
            event_id: format!("event-{}", uuid::Uuid::new_v4()),
            workspace_id: self.workspace_id.clone(),
            generation: self.generation,
            sequence: self.sequence,
            occurred_at: chrono::Utc::now().to_rfc3339(),
            payload,
        };
        if serde_json::to_vec(&event).map_or(usize::MAX, |bytes| bytes.len()) > MAX_EVENT_BYTES {
            return Err(NormalizeError::EventTooLarge);
        }
        Ok(event)
    }

    pub fn unsupported(
        &mut self,
        method: &str,
        byte_count: usize,
    ) -> Result<CodexEvent, NormalizeError> {
        let method_hash = hex::encode(Sha256::digest(method.as_bytes()));
        let detail_ref = self.detail_ref("protocol");
        self.event(CodexEventPayload::ProtocolUnsupported {
            method_hash: method_hash[..16].to_owned(),
            byte_count,
            detail_ref,
        })
    }

    pub fn pending_event(
        &mut self,
        request: PendingRequestView,
    ) -> Result<CodexEvent, NormalizeError> {
        self.event(CodexEventPayload::PendingRequest {
            request: Box::new(request),
        })
    }

    pub fn pending_resolved_event(
        &mut self,
        pending_id: String,
        status: PendingResolutionStatus,
    ) -> Result<CodexEvent, NormalizeError> {
        self.event(CodexEventPayload::PendingRequestResolved { pending_id, status })
    }

    pub fn diagnostic_event(
        &mut self,
        code: impl Into<String>,
        will_retry: bool,
    ) -> Result<CodexEvent, NormalizeError> {
        let detail_ref = self.detail_ref("diagnostic");
        self.event(CodexEventPayload::Diagnostic {
            code: code.into(),
            will_retry,
            detail_ref,
        })
    }

    pub fn connection_lost_event(
        &mut self,
        thread_id: &str,
        turn_id: &str,
    ) -> Result<CodexEvent, NormalizeError> {
        let thread_handle = self.thread_handle(thread_id);
        let turn_handle = self.turn_handle(turn_id);
        self.event(CodexEventPayload::TurnStatus {
            thread_handle,
            turn_handle,
            status: "interrupted".to_owned(),
        })
    }

    pub fn normalize(
        &mut self,
        method: &str,
        params: &Value,
        byte_count: usize,
    ) -> Result<NormalizeOutcome, NormalizeError> {
        let mut outcome = NormalizeOutcome::default();
        match method {
            "thread/started" | "thread/status/changed" => {
                let thread_id = string_at(params, &["thread", "id"])
                    .or_else(|| string_at(params, &["threadId"]))
                    .ok_or(NormalizeError::InvalidParams)?;
                let status = string_at(params, &["status"])
                    .or_else(|| string_at(params, &["thread", "status", "type"]))
                    .unwrap_or("active");
                let handle = self.thread_handle(thread_id);
                outcome
                    .events
                    .push(self.event(CodexEventPayload::ThreadStatus {
                        thread_handle: handle,
                        status: safe_enum(status, &["active", "idle", "systemError", "notLoaded"]),
                    })?);
            }
            "turn/started" | "turn/completed" => {
                let thread_id =
                    string_at(params, &["threadId"]).ok_or(NormalizeError::InvalidParams)?;
                let turn_id = string_at(params, &["turn", "id"])
                    .or_else(|| string_at(params, &["turnId"]))
                    .ok_or(NormalizeError::InvalidParams)?;
                let status = if method == "turn/started" {
                    "running"
                } else {
                    string_at(params, &["turn", "status"])
                        .or_else(|| string_at(params, &["status"]))
                        .unwrap_or("failed")
                };
                let thread_handle = self.thread_handle(thread_id);
                let turn_handle = self.turn_handle(turn_id);
                outcome
                    .events
                    .push(self.event(CodexEventPayload::TurnStatus {
                        thread_handle,
                        turn_handle,
                        status: safe_enum(
                            status,
                            &[
                                "running",
                                "completed",
                                "interrupted",
                                "failed",
                                "inProgress",
                            ],
                        ),
                    })?);
            }
            "item/started" | "item/completed" => {
                let item = params
                    .get("item")
                    .and_then(Value::as_object)
                    .ok_or(NormalizeError::InvalidParams)?;
                let item_id = item
                    .get("id")
                    .and_then(Value::as_str)
                    .ok_or(NormalizeError::InvalidParams)?;
                let item_type = item
                    .get("type")
                    .and_then(Value::as_str)
                    .ok_or(NormalizeError::InvalidParams)?;
                if item_type == "reasoning" {
                    return Ok(outcome);
                }
                let known = [
                    "agentMessage",
                    "commandExecution",
                    "fileChange",
                    "mcpToolCall",
                    "webSearch",
                    "plan",
                    "userMessage",
                    "enteredReviewMode",
                    "exitedReviewMode",
                    "contextCompaction",
                ];
                if !known.contains(&item_type) {
                    outcome.events.push(self.unsupported(method, byte_count)?);
                    return Ok(outcome);
                }
                let item_handle = self.item_handle(item_id);
                if method == "item/completed" && item_type == "agentMessage" {
                    let text = item
                        .get("text")
                        .and_then(Value::as_str)
                        .ok_or(NormalizeError::InvalidParams)?;
                    let commentary = match item.get("phase") {
                        None | Some(Value::Null) => false,
                        Some(Value::String(phase)) if phase == "commentary" => true,
                        Some(Value::String(phase)) if phase == "final_answer" => false,
                        _ => return Err(NormalizeError::InvalidParams),
                    };
                    if commentary {
                        if let Some(message) = commentary_message(text, &self.workspace_root) {
                            outcome.events.push(self.event(
                                CodexEventPayload::AgentMessageCompleted {
                                    item_handle,
                                    text: message,
                                },
                            )?);
                        }
                    } else {
                        match parse_completed_output(text, &self.workspace_root) {
                            Ok(DecisionOutput::Result { message }) => {
                                outcome.events.push(self.event(
                                    CodexEventPayload::AgentMessageCompleted {
                                        item_handle,
                                        text: message,
                                    },
                                )?);
                            }
                            Ok(DecisionOutput::Request { view }) => {
                                outcome.fallback_decision = Some(*view);
                            }
                            Err(_) => {
                                outcome.decision_violation = true;
                                outcome.events.push(
                                    self.diagnostic_event("CODEX-DECISION-OUTPUT-INVALID", false)?,
                                );
                            }
                        }
                    }
                } else if ["commandExecution", "mcpToolCall", "webSearch"].contains(&item_type) {
                    let metadata = tool_metadata(item_type, item, &self.workspace_root)?;
                    outcome.events.push(
                        self.event(CodexEventPayload::ToolStatus {
                            item_handle,
                            tool_kind: item_type.to_owned(),
                            provider_name: metadata.provider_name,
                            tool_name: metadata.tool_name,
                            summary: metadata.summary,
                            duration_ms: item
                                .get("durationMs")
                                .and_then(Value::as_u64)
                                .map(|duration| duration.min(MAX_TOOL_DURATION_MS)),
                            status: tool_status(item, method),
                        })?,
                    );
                } else {
                    outcome
                        .events
                        .push(self.event(CodexEventPayload::ItemStatus {
                            item_handle,
                            item_type: item_type.to_owned(),
                            status: if method == "item/started" {
                                "running".to_owned()
                            } else {
                                "completed".to_owned()
                            },
                        })?);
                }
            }
            "item/agentMessage/delta" => {
                // Structured-output deltas are JSON envelope fragments; publish only the
                // validated message from item/completed.
                let _item_id =
                    string_at(params, &["itemId"]).ok_or(NormalizeError::InvalidParams)?;
                let _delta = string_at(params, &["delta"]).ok_or(NormalizeError::InvalidParams)?;
            }
            "turn/plan/updated" => {
                let step_count = params
                    .get("plan")
                    .and_then(Value::as_array)
                    .map_or(0, Vec::len)
                    .min(1_000);
                outcome
                    .events
                    .push(self.event(CodexEventPayload::PlanUpdated { step_count })?);
            }
            "turn/diff/updated" => {
                let byte_count = params
                    .get("diff")
                    .and_then(Value::as_str)
                    .map_or(0, str::len)
                    .min(1024 * 1024);
                let detail_ref = self.detail_ref("diff");
                outcome
                    .events
                    .push(self.event(CodexEventPayload::DiffUpdated {
                        byte_count,
                        detail_ref,
                    })?);
            }
            "item/commandExecution/outputDelta" | "item/fileChange/outputDelta" => {
                let item_id =
                    string_at(params, &["itemId"]).ok_or(NormalizeError::InvalidParams)?;
                let delta = string_at(params, &["delta"]).ok_or(NormalizeError::InvalidParams)?;
                let item_handle = self.item_handle(item_id);
                outcome
                    .events
                    .push(self.event(CodexEventPayload::ToolOutput {
                        item_handle,
                        excerpt: redact_text(
                            delta,
                            Some(&self.workspace_root),
                            MAX_TOOL_EXCERPT_BYTES,
                        ),
                    })?);
            }
            "item/mcpToolCall/progress" => {
                let item_id =
                    string_at(params, &["itemId"]).ok_or(NormalizeError::InvalidParams)?;
                let message =
                    string_at(params, &["message"]).ok_or(NormalizeError::InvalidParams)?;
                let item_handle = self.item_handle(item_id);
                outcome
                    .events
                    .push(self.event(CodexEventPayload::ToolOutput {
                        item_handle,
                        excerpt: redact_text(
                            message,
                            Some(&self.workspace_root),
                            MAX_TOOL_EXCERPT_BYTES,
                        ),
                    })?);
            }
            "item/fileChange/patchUpdated" => {
                let item_id =
                    string_at(params, &["itemId"]).ok_or(NormalizeError::InvalidParams)?;
                let path = string_at(params, &["path"])
                    .or_else(|| string_at(params, &["filePath"]))
                    .unwrap_or("unknown");
                let change_kind = string_at(params, &["kind"])
                    .or_else(|| string_at(params, &["changeKind"]))
                    .unwrap_or("update");
                let item_handle = self.item_handle(item_id);
                outcome
                    .events
                    .push(self.event(CodexEventPayload::FileChange {
                        item_handle,
                        path_alias: alias_path(path, &self.workspace_root),
                        change_kind: safe_enum(change_kind, &["create", "update", "delete"]),
                    })?);
            }
            "error" | "warning" => {
                let will_retry = params
                    .get("willRetry")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let code = if method == "warning" {
                    "CODEX-WARNING"
                } else {
                    "CODEX-TURN-ERROR"
                };
                let detail_ref = self.detail_ref("diagnostic");
                outcome
                    .events
                    .push(self.event(CodexEventPayload::Diagnostic {
                        code: code.to_owned(),
                        will_retry,
                        detail_ref,
                    })?);
            }
            "model/rerouted" => {
                let from_model = string_at(params, &["fromModel"]).unwrap_or(CODEX_MODEL);
                let to_model =
                    string_at(params, &["toModel"]).ok_or(NormalizeError::InvalidParams)?;
                if to_model != CODEX_MODEL {
                    outcome.model_violation = true;
                }
                outcome
                    .events
                    .push(self.event(CodexEventPayload::ModelViolation {
                        from_model: redact_text(from_model, None, 128),
                        to_model: redact_text(to_model, None, 128),
                    })?);
            }
            "item/reasoning/summaryPartAdded"
            | "item/reasoning/summaryTextDelta"
            | "item/reasoning/textDelta" => {
                // Intentionally discard all raw reasoning payloads.
            }
            "mcpServer/startupStatus/updated"
            | "remoteControl/status/changed"
            | "account/rateLimits/updated"
            | "thread/tokenUsage/updated" => {
                // These auxiliary status notifications do not affect the
                // Coding Wife session, turn, model, or approval state.
            }
            "serverRequest/resolved" => {
                if !valid_server_request_resolved(params) {
                    return Err(NormalizeError::InvalidParams);
                }
                // The pending card is completed by the exact response command.
                // This notification contains no answer and is only lifecycle
                // confirmation from the current App Server.
            }
            _ => {
                outcome.events.push(self.unsupported(method, byte_count)?);
                outcome.unsupported_terminal = method.starts_with("turn/")
                    || method.starts_with("thread/")
                    || method == "model/rerouted";
            }
        }
        Ok(outcome)
    }

    pub fn domain_event(event: &CodexEvent) -> Option<Value> {
        let (kind, payload) = match &event.payload {
            CodexEventPayload::ThreadStatus {
                thread_handle,
                status,
            } => (
                "code.thread.status.changed",
                json!({"threadHandle": thread_handle, "status": status}),
            ),
            CodexEventPayload::TurnStatus {
                thread_handle,
                turn_handle,
                status,
            } => {
                let session_status = match status.as_str() {
                    "running" | "inProgress" => "running",
                    "completed" => "completed",
                    "interrupted" => "interrupted",
                    _ => "failed",
                };
                (
                    "code.session.status.changed",
                    json!({
                        "status": session_status,
                        "threadHandle": thread_handle,
                        "turnHandle": turn_handle,
                    }),
                )
            }
            CodexEventPayload::PendingRequest { request } => (
                "code.pending.requested",
                serde_json::to_value(request).ok()?,
            ),
            CodexEventPayload::PendingRequestResolved { pending_id, status } => (
                "code.pending.resolved",
                json!({"pendingId": pending_id, "status": status}),
            ),
            CodexEventPayload::Diagnostic {
                code,
                will_retry,
                detail_ref,
            } => (
                "code.session.diagnostic",
                json!({"code": code, "willRetry": will_retry, "detailRef": detail_ref}),
            ),
            CodexEventPayload::ModelViolation {
                from_model,
                to_model,
            } => (
                "code.model.violation",
                json!({"fromModel": from_model, "toModel": to_model}),
            ),
            CodexEventPayload::ProtocolUnsupported {
                method_hash,
                byte_count,
                detail_ref,
            } => (
                "code.protocol.unsupported",
                json!({
                    "methodHash": method_hash,
                    "byteCount": byte_count,
                    "detailRef": detail_ref,
                }),
            ),
            _ => return None,
        };
        Some(json!({
            "schemaVersion": 1,
            "eventId": event.event_id,
            "producer": "code",
            "kind": kind,
            "occurredAt": event.occurred_at,
            "workspaceId": event.workspace_id,
            "sequence": event.sequence,
            "payload": payload,
        }))
    }
}

fn string_at<'a>(value: &'a Value, path: &[&str]) -> Option<&'a str> {
    let mut current = value;
    for key in path {
        current = current.get(*key)?;
    }
    current.as_str()
}

fn valid_server_request_resolved(params: &Value) -> bool {
    let Some(object) = params.as_object() else {
        return false;
    };
    if object.len() != 2 || !object.contains_key("requestId") || !object.contains_key("threadId") {
        return false;
    }
    let valid_request_id = match object.get("requestId") {
        Some(Value::String(value)) => !value.is_empty() && value.len() <= 256,
        Some(Value::Number(value)) => value.as_i64().is_some(),
        _ => false,
    };
    let valid_thread_id = object
        .get("threadId")
        .and_then(Value::as_str)
        .is_some_and(|value| !value.is_empty() && value.len() <= 256);
    valid_request_id && valid_thread_id
}

struct ToolMetadata {
    provider_name: Option<String>,
    tool_name: String,
    summary: Option<String>,
}

fn safe_multiline(value: &str, workspace_root: &Path, maximum: usize) -> Option<String> {
    let redaction_limit = maximum.saturating_sub('…'.len_utf8());
    let sanitized = redact_text(value, Some(workspace_root), redaction_limit)
        .chars()
        .map(|character| match character {
            '\n' | '\t' => character,
            '\r' => '\n',
            value if value.is_control() => ' ',
            value => value,
        })
        .collect::<String>();
    let sanitized = sanitized.trim();
    (!sanitized.is_empty()).then(|| sanitized.to_owned())
}

fn commentary_message(text: &str, workspace_root: &Path) -> Option<String> {
    match parse_completed_output(text, workspace_root) {
        Ok(DecisionOutput::Result { message }) => {
            safe_multiline(&message, workspace_root, MAX_ASSISTANT_MESSAGE_BYTES)
        }
        Ok(DecisionOutput::Request { .. }) => None,
        Err(_) if serde_json::from_str::<Value>(text).is_ok() => None,
        Err(_) => safe_multiline(text, workspace_root, MAX_ASSISTANT_MESSAGE_BYTES),
    }
}

fn safe_single_line(value: &str, workspace_root: &Path, maximum: usize) -> Option<String> {
    let redaction_limit = maximum.saturating_sub('…'.len_utf8());
    let sanitized = redact_text(value, Some(workspace_root), redaction_limit)
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    (!sanitized.is_empty()).then_some(sanitized)
}

fn normalized_argument_key(key: &str) -> String {
    key.chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(|character| character.to_lowercase())
        .collect::<String>()
}

fn credential_argument_key(key: &str) -> bool {
    let normalized = normalized_argument_key(key);
    [
        "authorization",
        "apikey",
        "accesstoken",
        "refreshtoken",
        "idtoken",
        "token",
        "password",
        "passwd",
        "secret",
        "clientsecret",
        "privatekey",
        "authcookie",
        "cookie",
        "setcookie",
        "sessionid",
    ]
    .iter()
    .any(|sensitive| normalized == *sensitive || normalized.ends_with(sensitive))
}

fn source_body_argument_key(key: &str) -> bool {
    matches!(
        normalized_argument_key(key).as_str(),
        "code" | "script" | "expression" | "source" | "sourcecode"
    )
}

fn target_argument_key(key: &str) -> bool {
    matches!(
        normalized_argument_key(key).as_str(),
        "title" | "query" | "refid" | "url" | "path" | "name" | "file" | "filename" | "target"
    )
}

fn argument_summary_priority(key: &str) -> u8 {
    if target_argument_key(key) {
        0
    } else if credential_argument_key(key) || source_body_argument_key(key) {
        2
    } else {
        1
    }
}

fn summarize_source_body(value: &Value, workspace_root: &Path) -> String {
    match value {
        Value::String(text) => format!("<{} chars>", text.chars().count()),
        value => summarize_argument_value(value, workspace_root),
    }
}

fn summarize_argument_value(value: &Value, workspace_root: &Path) -> String {
    match value {
        Value::String(text) => {
            safe_single_line(text, workspace_root, 160).unwrap_or_else(|| "[empty]".to_owned())
        }
        Value::Number(number) => number.to_string(),
        Value::Bool(boolean) => boolean.to_string(),
        Value::Null => "null".to_owned(),
        Value::Array(items) => format!("[{}]", items.len()),
        Value::Object(fields) => format!("{{{}}}", fields.len()),
    }
}

fn summarize_arguments(arguments: &Value, workspace_root: &Path) -> Option<String> {
    let summary = match arguments {
        Value::Object(fields) => {
            let mut fields = fields.iter().collect::<Vec<_>>();
            fields.sort_by_key(|(key, _)| argument_summary_priority(key));
            fields
                .into_iter()
                .take(4)
                .filter_map(|(key, value)| {
                    let safe_key = safe_single_line(key, workspace_root, 64)?;
                    let safe_value = if credential_argument_key(key) {
                        "[redacted]".to_owned()
                    } else if source_body_argument_key(key) {
                        summarize_source_body(value, workspace_root)
                    } else {
                        summarize_argument_value(value, workspace_root)
                    };
                    Some(format!("{safe_key}={safe_value}"))
                })
                .collect::<Vec<_>>()
                .join(" · ")
        }
        value => summarize_argument_value(value, workspace_root),
    };
    safe_single_line(&summary, workspace_root, MAX_TOOL_SUMMARY_BYTES)
}

fn tool_metadata(
    item_type: &str,
    item: &serde_json::Map<String, Value>,
    workspace_root: &Path,
) -> Result<ToolMetadata, NormalizeError> {
    match item_type {
        "mcpToolCall" => {
            let provider_name = item
                .get("server")
                .and_then(Value::as_str)
                .and_then(|value| safe_single_line(value, workspace_root, MAX_TOOL_NAME_BYTES))
                .ok_or(NormalizeError::InvalidParams)?;
            let tool_name = item
                .get("tool")
                .and_then(Value::as_str)
                .and_then(|value| safe_single_line(value, workspace_root, MAX_TOOL_NAME_BYTES))
                .ok_or(NormalizeError::InvalidParams)?;
            let arguments = item.get("arguments").ok_or(NormalizeError::InvalidParams)?;
            Ok(ToolMetadata {
                provider_name: Some(provider_name),
                tool_name,
                summary: summarize_arguments(arguments, workspace_root),
            })
        }
        "commandExecution" => {
            let tool_name = item
                .get("commandActions")
                .and_then(Value::as_array)
                .and_then(|actions| actions.first())
                .and_then(|action| action.get("type"))
                .and_then(Value::as_str)
                .and_then(|value| safe_single_line(value, workspace_root, MAX_TOOL_NAME_BYTES))
                .unwrap_or_else(|| "shell".to_owned());
            Ok(ToolMetadata {
                provider_name: None,
                tool_name,
                summary: item
                    .get("command")
                    .and_then(Value::as_str)
                    .and_then(|value| {
                        safe_single_line(value, workspace_root, MAX_TOOL_SUMMARY_BYTES)
                    }),
            })
        }
        "webSearch" => {
            let action = item.get("action").and_then(Value::as_object);
            let tool_name = action
                .and_then(|value| value.get("type"))
                .and_then(Value::as_str)
                .and_then(|value| safe_single_line(value, workspace_root, MAX_TOOL_NAME_BYTES))
                .unwrap_or_else(|| "search".to_owned());
            let summary = item
                .get("query")
                .and_then(Value::as_str)
                .or_else(|| {
                    action.and_then(|value| {
                        ["query", "url", "pattern"]
                            .iter()
                            .find_map(|key| value.get(*key).and_then(Value::as_str))
                    })
                })
                .and_then(|value| safe_single_line(value, workspace_root, MAX_TOOL_SUMMARY_BYTES));
            Ok(ToolMetadata {
                provider_name: None,
                tool_name,
                summary,
            })
        }
        _ => Err(NormalizeError::InvalidParams),
    }
}

fn tool_status(item: &serde_json::Map<String, Value>, method: &str) -> String {
    match item.get("status").and_then(Value::as_str) {
        Some("inProgress") | Some("running") => "running".to_owned(),
        Some("completed") => "completed".to_owned(),
        Some("failed") => "failed".to_owned(),
        _ if method == "item/started" => "running".to_owned(),
        _ => "completed".to_owned(),
    }
}

fn safe_enum(value: &str, allowed: &[&str]) -> String {
    if allowed.contains(&value) {
        value.to_owned()
    } else {
        "unknown".to_owned()
    }
}

fn alias_path(raw: &str, workspace_root: &Path) -> String {
    let path = Path::new(raw);
    if let Ok(relative) = path.strip_prefix(workspace_root) {
        return format!("<workspace>/{}", relative.to_string_lossy());
    }
    path.file_name()
        .and_then(|name| name.to_str())
        .map(|name| format!("<external>/{name}"))
        .unwrap_or_else(|| "<path>".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drops_reasoning_and_redacts_message_paths_and_secrets() {
        let mut normalizer = EventNormalizer::new(
            "workspace-1".to_owned(),
            PathBuf::from("/\u{0055}sers/alice/project"),
            1,
        );
        let reasoning = normalizer
            .normalize(
                "item/reasoning/textDelta",
                &json!({"delta": "private thought"}),
                20,
            )
            .expect("reasoning");
        assert!(reasoning.events.is_empty());

        let message = normalizer
            .normalize(
                "item/completed",
                &json!({"item": {
                    "id": "raw-item-id",
                    "type": "agentMessage",
                    "text": concat!(
                        r#"{"schemaVersion":1,"response":{"kind":"result","message":"Bearer abc /"#,
                        "Users/alice/project/src/main.rs",
                        r#"","decisionId":null,"question":null,"options":null,"context":null,"allowFreeform":null}}"#
                    )
                }}),
                100,
            )
            .expect("message");
        let encoded = serde_json::to_string(&message.events).expect("serialize");
        assert!(!encoded.contains("raw-item-id"));
        assert!(!encoded.contains("Bearer abc"));
        assert!(!encoded.contains("/\u{0055}sers/alice"));
        assert!(!message.decision_violation);
    }

    #[test]
    fn invalid_completed_output_is_not_rendered_and_requires_interrupt() {
        let mut normalizer =
            EventNormalizer::new("workspace-1".to_owned(), PathBuf::from("/workspace"), 1);
        let outcome = normalizer
            .normalize(
                "item/completed",
                &json!({"item": {
                    "id": "raw-item-id",
                    "type": "agentMessage",
                    "phase": "final_answer",
                    "text": "Approve this request"
                }}),
                100,
            )
            .expect("normalize");
        let encoded = serde_json::to_string(&outcome.events).expect("serialize");

        assert!(outcome.decision_violation);
        assert!(encoded.contains("CODEX-DECISION-OUTPUT-INVALID"));
        assert!(!encoded.contains("Approve this request"));
    }

    #[test]
    fn completed_commentary_is_rendered_without_interrupting_the_turn() {
        let mut normalizer = EventNormalizer::new(
            "workspace-1".to_owned(),
            PathBuf::from("/\u{0055}sers/alice/project"),
            1,
        );
        let plain = normalizer
            .normalize(
                "item/completed",
                &json!({"item": {
                    "id": "commentary-plain",
                    "type": "agentMessage",
                    "phase": "commentary",
                    "text": "依存関係ファイルを確認します。 Bearer private-token /\u{0055}sers/alice/project/package.json"
                }}),
                200,
            )
            .expect("plain commentary");
        let plain_encoded = serde_json::to_string(&plain.events).expect("plain JSON");
        assert!(!plain.decision_violation);
        assert!(plain_encoded.contains("依存関係ファイルを確認します。"));
        assert!(!plain_encoded.contains("private-token"));
        assert!(!plain_encoded.contains("/\u{0055}sers/alice"));

        let structured = normalizer
            .normalize(
                "item/completed",
                &json!({"item": {
                    "id": "commentary-structured",
                    "type": "agentMessage",
                    "phase": "commentary",
                    "text": r#"{"schemaVersion":1,"response":{"kind":"result","message":"READMEと設定を確認します。","decisionId":null,"question":null,"options":null,"context":null,"allowFreeform":true}}"#
                }}),
                300,
            )
            .expect("structured commentary");
        let structured_encoded =
            serde_json::to_string(&structured.events).expect("structured JSON");
        assert!(!structured.decision_violation);
        assert!(structured_encoded.contains("READMEと設定を確認します。"));
        assert!(!structured_encoded.contains("allowFreeform"));
    }

    #[test]
    fn structured_output_deltas_are_not_rendered_and_result_boolean_is_accepted() {
        let mut normalizer =
            EventNormalizer::new("workspace-1".to_owned(), PathBuf::from("/workspace"), 1);
        let delta = normalizer
            .normalize(
                "item/agentMessage/delta",
                &json!({
                    "itemId": "raw-item-id",
                    "delta": r#"{"schemaVersion":1,"response":{"allowFreeform":true,"kind":"result""#
                }),
                100,
            )
            .expect("delta");
        assert!(delta.events.is_empty());

        let completed = normalizer
            .normalize(
                "item/completed",
                &json!({"item": {
                    "id": "raw-item-id",
                    "type": "agentMessage",
                    "text": r#"{"schemaVersion":1,"response":{"kind":"result","message":"リポジトリを確認します。","decisionId":null,"question":null,"options":null,"context":null,"allowFreeform":true}}"#
                }}),
                200,
            )
            .expect("completed");
        assert!(!completed.decision_violation);
        assert_eq!(completed.events.len(), 1);
        let encoded = serde_json::to_string(&completed.events).expect("serialize");
        assert!(encoded.contains("リポジトリを確認します。"));
        assert!(!encoded.contains("allowFreeform"));
    }

    #[test]
    fn replayed_completed_agent_message_keeps_the_same_opaque_item_handle() {
        let mut normalizer =
            EventNormalizer::new("workspace-1".to_owned(), PathBuf::from("/workspace"), 1);
        let params = json!({"item": {
            "id": "raw-replayed-item",
            "type": "agentMessage",
            "phase": "commentary",
            "text": "完了したメッセージです。"
        }});
        let first = normalizer
            .normalize("item/completed", &params, 100)
            .expect("first completion");
        let replay = normalizer
            .normalize("item/completed", &params, 100)
            .expect("replayed completion");

        let [first] = first.events.as_slice() else {
            panic!("first completion must emit exactly one event");
        };
        let [replay] = replay.events.as_slice() else {
            panic!("replayed completion must emit exactly one event");
        };
        let CodexEventPayload::AgentMessageCompleted {
            item_handle: first_handle,
            ..
        } = &first.payload
        else {
            panic!("first event must be a completed agent message");
        };
        let CodexEventPayload::AgentMessageCompleted {
            item_handle: replay_handle,
            ..
        } = &replay.payload
        else {
            panic!("replayed event must be a completed agent message");
        };
        assert_eq!(first_handle, replay_handle);
        assert_ne!(first.event_id, replay.event_id);
    }

    #[test]
    fn turn_completed_is_the_terminal_domain_authority() {
        let mut normalizer =
            EventNormalizer::new("workspace-1".to_owned(), PathBuf::from("/workspace"), 1);
        let outcome = normalizer
            .normalize(
                "turn/completed",
                &json!({
                    "threadId": "thread-raw",
                    "turn": {"id": "turn-raw", "status": "interrupted"}
                }),
                100,
            )
            .expect("turn");
        let domain = EventNormalizer::domain_event(&outcome.events[0]).expect("domain");
        assert_eq!(domain["payload"]["status"], "interrupted");
    }

    #[test]
    fn unknown_terminal_method_is_quarantined_without_raw_payload() {
        let mut normalizer =
            EventNormalizer::new("workspace-1".to_owned(), PathBuf::from("/workspace"), 1);
        let outcome = normalizer
            .normalize("turn/futureTerminal", &json!({"secret": "value"}), 42)
            .expect("unknown");
        assert!(outcome.unsupported_terminal);
        let encoded = serde_json::to_string(&outcome.events).expect("serialize");
        assert!(!encoded.contains("value"));
    }

    #[test]
    fn known_auxiliary_status_notifications_are_ignored() {
        let mut normalizer =
            EventNormalizer::new("workspace-1".to_owned(), PathBuf::from("/workspace"), 1);
        for method in [
            "mcpServer/startupStatus/updated",
            "remoteControl/status/changed",
            "account/rateLimits/updated",
            "thread/tokenUsage/updated",
        ] {
            let outcome = normalizer
                .normalize(method, &json!({"private": "status"}), 42)
                .expect("known auxiliary notification");
            assert!(outcome.events.is_empty());
            assert!(!outcome.unsupported_terminal);
        }
    }

    #[test]
    fn current_server_request_resolved_is_consumed_but_invalid_shapes_fail_closed() {
        let mut normalizer =
            EventNormalizer::new("workspace-1".to_owned(), PathBuf::from("/workspace"), 1);
        for request_id in [json!("server-rui"), json!(7)] {
            let outcome = normalizer
                .normalize(
                    "serverRequest/resolved",
                    &json!({"requestId": request_id, "threadId": "thread-1"}),
                    110,
                )
                .expect("current resolved notification");
            assert!(outcome.events.is_empty());
            assert!(!outcome.unsupported_terminal);
        }

        for invalid in [
            json!({"requestId": "server-rui"}),
            json!({"requestId": null, "threadId": "thread-1"}),
            json!({"requestId": "server-rui", "threadId": "thread-1", "future": true}),
        ] {
            assert!(matches!(
                normalizer.normalize("serverRequest/resolved", &invalid, 110),
                Err(NormalizeError::InvalidParams)
            ));
        }
    }

    #[test]
    fn mcp_tool_status_exposes_safe_identity_without_raw_arguments_or_results() {
        let workspace_root = PathBuf::from("/\u{0055}sers/alice/project");
        let mut normalizer =
            EventNormalizer::new("workspace-1".to_owned(), workspace_root.clone(), 1);
        let started = normalizer
            .normalize(
                "item/started",
                &json!({"item": {
                    "id": "raw-mcp-item",
                    "type": "mcpToolCall",
                    "server": "browser",
                    "tool": "open",
                    "arguments": {
                        "authorization": "Bearer private-token",
                        "nested": {"private": "value"},
                        "path": workspace_root.join("src/main.rs").to_string_lossy(),
                        "ref_id": "page-safe"
                    },
                    "status": "inProgress",
                    "result": {"content": "private result"}
                }}),
                400,
            )
            .expect("MCP start");
        let encoded = serde_json::to_string(&started.events).expect("serialize");

        assert!(encoded.contains("\"kind\":\"tool_status\""));
        assert!(encoded.contains("\"toolKind\":\"mcpToolCall\""));
        assert!(encoded.contains("\"providerName\":\"browser\""));
        assert!(encoded.contains("\"toolName\":\"open\""));
        assert!(encoded.contains("authorization=[redacted]"));
        assert!(encoded.contains("nested={1}"));
        assert!(encoded.contains("path=<workspace>/src/main.rs"));
        assert!(encoded.contains("ref_id=page-safe"));
        assert!(!encoded.contains("raw-mcp-item"));
        assert!(!encoded.contains("private-token"));
        assert!(!encoded.contains("private result"));
        assert!(!encoded.contains("/\u{0055}sers/alice"));

        let completed = normalizer
            .normalize(
                "item/completed",
                &json!({"item": {
                    "id": "raw-mcp-item",
                    "type": "mcpToolCall",
                    "server": "browser",
                    "tool": "open",
                    "arguments": {"ref_id": "page-safe"},
                    "durationMs": 240,
                    "status": "failed"
                }}),
                200,
            )
            .expect("MCP completion");
        let completed = serde_json::to_value(&completed.events[0]).expect("completion JSON");
        assert_eq!(completed["payload"]["status"], "failed");
        assert_eq!(completed["payload"]["durationMs"], 240);
    }

    #[test]
    fn mcp_tool_summary_prioritizes_title_and_does_not_inline_source_code() {
        let mut normalizer =
            EventNormalizer::new("workspace-1".to_owned(), PathBuf::from("/workspace"), 1);
        let outcome = normalizer
            .normalize(
                "item/started",
                &json!({"item": {
                    "id": "raw-mcp-item",
                    "type": "mcpToolCall",
                    "server": "node-repl",
                    "tool": "run",
                    "arguments": {
                        "code": "var fs = await import('node:fs/promises'); nodeRepl.write('private source');",
                        "title": "依存関係ファイルを確認"
                    },
                    "status": "inProgress"
                }}),
                300,
            )
            .expect("MCP code summary");
        let summary = serde_json::to_value(&outcome.events[0]).expect("event JSON");
        let summary = summary["payload"]["summary"]
            .as_str()
            .expect("tool summary");

        assert!(summary.starts_with("title=依存関係ファイルを確認"));
        assert!(summary.contains("code=<"));
        assert!(summary.contains(" chars>"));
        assert!(!summary.contains("node:fs"));
        assert!(!summary.contains("private source"));
    }

    #[test]
    fn mcp_progress_is_redacted_and_missing_tool_identity_fails_closed() {
        let mut normalizer = EventNormalizer::new(
            "workspace-1".to_owned(),
            PathBuf::from("/\u{0055}sers/alice/project"),
            1,
        );
        let progress = normalizer
            .normalize(
                "item/mcpToolCall/progress",
                &json!({
                    "itemId": "raw-mcp-item",
                    "message": "Authorization: Bearer private-token /\u{0055}sers/alice/project/src/main.rs"
                }),
                120,
            )
            .expect("MCP progress");
        let encoded = serde_json::to_string(&progress.events).expect("serialize");
        assert!(encoded.contains("\"kind\":\"tool_output\""));
        assert!(!encoded.contains("private-token"));
        assert!(!encoded.contains("/\u{0055}sers/alice"));

        let missing_identity = normalizer.normalize(
            "item/started",
            &json!({"item": {
                "id": "raw-mcp-item",
                "type": "mcpToolCall",
                "arguments": {},
                "status": "inProgress"
            }}),
            100,
        );
        assert_eq!(missing_identity.unwrap_err(), NormalizeError::InvalidParams);
    }
}
