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
const MAX_DELTA_BYTES: usize = 8 * 1024;
const MAX_TOOL_EXCERPT_BYTES: usize = 4 * 1024;

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
                    let text = item.get("text").and_then(Value::as_str).unwrap_or_default();
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
                let item_id =
                    string_at(params, &["itemId"]).ok_or(NormalizeError::InvalidParams)?;
                let delta = string_at(params, &["delta"]).ok_or(NormalizeError::InvalidParams)?;
                let item_handle = self.item_handle(item_id);
                outcome
                    .events
                    .push(self.event(CodexEventPayload::AgentMessageDelta {
                        item_handle,
                        delta: redact_text(delta, Some(&self.workspace_root), MAX_DELTA_BYTES),
                    })?);
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
            PathBuf::from("/Users/alice/project"),
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
                    "text": r#"{"schemaVersion":1,"kind":"result","message":"Bearer abc /Users/alice/project/src/main.rs"}"#
                }}),
                100,
            )
            .expect("message");
        let encoded = serde_json::to_string(&message.events).expect("serialize");
        assert!(!encoded.contains("raw-item-id"));
        assert!(!encoded.contains("Bearer abc"));
        assert!(!encoded.contains("/Users/alice"));
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
}
