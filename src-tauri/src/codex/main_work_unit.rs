//! Private main-turn lifecycle boundary for Git commit correlation.
//!
//! Raw App Server command data is reduced to bounded, typed notifications here.
//! The values in this module are never serialized or emitted to the WebView.

use std::future::Future;
use std::pin::Pin;

use serde_json::Value;

use super::types::MainSkillInjectionAudit;

const MAX_RAW_HANDLE_BYTES: usize = 256;
const MAX_COMMAND_BYTES: usize = 32 * 1024;
const NODE_REPL_SERVER: &str = "node_repl";
const NODE_REPL_TOOL: &str = "js";
const NODE_REPL_COMMIT_PROOF_KEY: &str = "codingWifeGitCommitProof";

pub(crate) type MainWorkUnitFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub(crate) struct MainWorkUnitLease {
    token: String,
}

impl MainWorkUnitLease {
    pub(crate) fn new(token: String) -> Option<Self> {
        valid_opaque(&token).then_some(Self { token })
    }

    pub(crate) fn token(&self) -> &str {
        &self.token
    }
}

#[derive(Clone, Debug)]
pub(crate) struct MainWorkUnitStart {
    pub workspace_id: String,
    pub workspace_generation: u64,
    pub raw_thread_id: String,
    pub client_message_id: String,
    pub skill_injection: MainSkillInjectionAudit,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct MainCommandStarted {
    pub workspace_generation: u64,
    pub raw_thread_id: String,
    pub raw_turn_id: String,
    pub item_id: String,
    pub source: MainCommitSource,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct MainCommandCompleted {
    pub workspace_generation: u64,
    pub raw_thread_id: String,
    pub raw_turn_id: String,
    pub item_id: String,
    pub source: MainCommitSource,
    pub proof_intent: Option<MainCommitProofIntent>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum MainCommitSource {
    CommandExecution,
    NodeReplJs,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum MainCommitProofIntent {
    ObserveCurrentHead,
    Exact {
        before_head: String,
        commit_sha: String,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum MainWorkUnitTerminalState {
    Completed,
    Failed,
    Interrupted,
    Canceled,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct MainWorkUnitTerminal {
    pub workspace_generation: u64,
    pub raw_thread_id: String,
    pub raw_turn_id: String,
    pub state: MainWorkUnitTerminalState,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum MainCommandNotification {
    Started(MainCommandStarted),
    Completed(MainCommandCompleted),
}

pub(crate) trait MainWorkUnitRuntime: Send + Sync {
    fn begin<'a>(
        &'a self,
        start: MainWorkUnitStart,
    ) -> MainWorkUnitFuture<'a, Option<MainWorkUnitLease>>;

    fn command_started<'a>(
        &'a self,
        lease: MainWorkUnitLease,
        event: MainCommandStarted,
    ) -> MainWorkUnitFuture<'a, ()>;

    fn command_completed<'a>(
        &'a self,
        lease: MainWorkUnitLease,
        event: MainCommandCompleted,
    ) -> MainWorkUnitFuture<'a, ()>;

    fn terminal<'a>(
        &'a self,
        lease: MainWorkUnitLease,
        event: MainWorkUnitTerminal,
    ) -> MainWorkUnitFuture<'a, ()>;

    fn abandon<'a>(&'a self, lease: MainWorkUnitLease) -> MainWorkUnitFuture<'a, ()>;

    fn invalidate_generation<'a>(&'a self, generation: u64) -> MainWorkUnitFuture<'a, ()>;
}

pub(crate) fn parse_main_command_notification(
    method: &str,
    params: &Value,
    generation: u64,
    active_thread_id: &str,
    active_turn_id: &str,
) -> Option<MainCommandNotification> {
    if !matches!(method, "item/started" | "item/completed")
        || params.get("threadId").and_then(Value::as_str) != Some(active_thread_id)
        || params.get("turnId").and_then(Value::as_str) != Some(active_turn_id)
    {
        return None;
    }
    let item = params.get("item")?.as_object()?;
    let item_type = item.get("type").and_then(Value::as_str)?;
    let source = match item_type {
        "commandExecution" => MainCommitSource::CommandExecution,
        "mcpToolCall" => MainCommitSource::NodeReplJs,
        _ => return None,
    };
    let item_id = item
        .get("id")
        .and_then(Value::as_str)
        .filter(|value| valid_raw_handle(value))?
        .to_owned();
    let context = || {
        (
            generation,
            active_thread_id.to_owned(),
            active_turn_id.to_owned(),
            item_id.clone(),
        )
    };
    if method == "item/started" {
        match source {
            MainCommitSource::CommandExecution => {
                if item.get("source").and_then(Value::as_str) != Some("agent")
                    || item.get("status").and_then(Value::as_str) != Some("inProgress")
                {
                    return None;
                }
                item.get("command")
                    .and_then(Value::as_str)
                    .filter(|command| {
                        !command.is_empty()
                            && command.len() <= MAX_COMMAND_BYTES
                            && !command.contains('\0')
                            && is_git_commit_candidate(command)
                    })?;
            }
            MainCommitSource::NodeReplJs => {
                if !is_node_repl_js(item)
                    || item.get("status").and_then(Value::as_str) != Some("inProgress")
                    || item.get("result").is_some_and(|value| !value.is_null())
                    || item.get("error").is_some_and(|value| !value.is_null())
                {
                    return None;
                }
            }
        }
        let (workspace_generation, raw_thread_id, raw_turn_id, item_id) = context();
        return Some(MainCommandNotification::Started(MainCommandStarted {
            workspace_generation,
            raw_thread_id,
            raw_turn_id,
            item_id,
            source,
        }));
    }

    let proof_intent = match source {
        MainCommitSource::CommandExecution => (item.get("source").and_then(Value::as_str)
            == Some("agent")
            && item.get("status").and_then(Value::as_str) == Some("completed")
            && item.get("exitCode").and_then(Value::as_i64) == Some(0))
        .then_some(MainCommitProofIntent::ObserveCurrentHead),
        MainCommitSource::NodeReplJs => {
            if is_node_repl_js(item)
                && item.get("status").and_then(Value::as_str) == Some("completed")
                && item.get("error").is_none_or(Value::is_null)
            {
                node_repl_commit_proof(item)
            } else {
                None
            }
        }
    };
    let (workspace_generation, raw_thread_id, raw_turn_id, item_id) = context();
    Some(MainCommandNotification::Completed(MainCommandCompleted {
        workspace_generation,
        raw_thread_id,
        raw_turn_id,
        item_id,
        source,
        proof_intent,
    }))
}

fn is_node_repl_js(item: &serde_json::Map<String, Value>) -> bool {
    item.get("server").and_then(Value::as_str) == Some(NODE_REPL_SERVER)
        && item.get("tool").and_then(Value::as_str) == Some(NODE_REPL_TOOL)
}

fn node_repl_commit_proof(item: &serde_json::Map<String, Value>) -> Option<MainCommitProofIntent> {
    let result = item.get("result")?.as_object()?;
    result.get("content")?.as_array()?;
    let metadata = result.get("_meta")?.as_object()?;
    let marker = metadata.get(NODE_REPL_COMMIT_PROOF_KEY)?.as_object()?;
    if marker.len() != 4
        || marker.get("schemaVersion").and_then(Value::as_u64) != Some(1)
        || marker.get("operation").and_then(Value::as_str) != Some("git_commit")
    {
        return None;
    }
    let before_head = marker.get("beforeHead").and_then(Value::as_str)?;
    let commit_sha = marker.get("commitSha").and_then(Value::as_str)?;
    if !valid_git_head(before_head, true)
        || !valid_git_head(commit_sha, false)
        || before_head == commit_sha
    {
        return None;
    }
    Some(MainCommitProofIntent::Exact {
        before_head: before_head.to_owned(),
        commit_sha: commit_sha.to_owned(),
    })
}

fn valid_git_head(value: &str, allow_unborn: bool) -> bool {
    (allow_unborn && value == "unborn")
        || (matches!(value.len(), 40 | 64)
            && value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)))
}

pub(crate) fn terminal_state(params: &Value) -> Option<MainWorkUnitTerminalState> {
    match params.pointer("/turn/status").and_then(Value::as_str)? {
        "completed" => Some(MainWorkUnitTerminalState::Completed),
        "failed" => Some(MainWorkUnitTerminalState::Failed),
        "interrupted" => Some(MainWorkUnitTerminalState::Interrupted),
        "canceled" | "cancelled" => Some(MainWorkUnitTerminalState::Canceled),
        _ => None,
    }
}

fn valid_raw_handle(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_RAW_HANDLE_BYTES
        && !value.contains('\0')
        && value.chars().all(|character| !character.is_control())
}

fn valid_opaque(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b':'))
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum ShellToken {
    Word(String),
    Separator,
}

fn is_git_commit_candidate(command: &str) -> bool {
    let Some(tokens) = shell_tokens(command) else {
        return false;
    };
    tokens
        .split(|token| *token == ShellToken::Separator)
        .any(segment_is_git_commit)
}

fn segment_is_git_commit(segment: &[ShellToken]) -> bool {
    let words = segment
        .iter()
        .filter_map(|token| match token {
            ShellToken::Word(value) => Some(value.as_str()),
            ShellToken::Separator => None,
        })
        .collect::<Vec<_>>();
    if words.is_empty() {
        return false;
    }
    let mut index = 0;
    while words.get(index).is_some_and(|word| shell_assignment(word)) {
        index += 1;
    }
    if words
        .get(index)
        .is_some_and(|word| executable_name(word) == "env")
    {
        index += 1;
        while let Some(word) = words.get(index) {
            if shell_assignment(word) || word.starts_with('-') {
                index += 1;
            } else {
                break;
            }
        }
    }
    if words
        .get(index)
        .is_some_and(|word| executable_name(word) == "command")
    {
        index += 1;
        while words.get(index).is_some_and(|word| word.starts_with('-')) {
            index += 1;
        }
    }
    if words
        .get(index)
        .is_none_or(|word| executable_name(word) != "git")
    {
        return false;
    }
    index += 1;
    while let Some(word) = words.get(index) {
        if *word == "commit" {
            return true;
        }
        if !word.starts_with('-') {
            return false;
        }
        let consumes_next = matches!(
            *word,
            "-C" | "-c" | "--git-dir" | "--work-tree" | "--namespace" | "--exec-path"
        );
        index += 1;
        if consumes_next {
            if words.get(index).is_none() {
                return false;
            }
            index += 1;
        }
    }
    false
}

fn shell_assignment(word: &str) -> bool {
    let Some((name, _)) = word.split_once('=') else {
        return false;
    };
    !name.is_empty()
        && name.bytes().enumerate().all(|(index, byte)| {
            byte == b'_' || byte.is_ascii_alphabetic() || (index > 0 && byte.is_ascii_digit())
        })
}

fn executable_name(word: &str) -> &str {
    word.rsplit('/').next().unwrap_or(word)
}

fn shell_tokens(command: &str) -> Option<Vec<ShellToken>> {
    let mut tokens = Vec::new();
    let mut word = String::new();
    let mut chars = command.chars().peekable();
    let mut quote = None;
    while let Some(character) = chars.next() {
        match quote {
            Some('\'') => {
                if character == '\'' {
                    quote = None;
                } else {
                    word.push(character);
                }
            }
            Some('"') => match character {
                '"' => quote = None,
                '\\' => word.push(chars.next()?),
                _ => word.push(character),
            },
            Some(_) => return None,
            None => match character {
                '\'' | '"' => quote = Some(character),
                '\\' => word.push(chars.next()?),
                ' ' | '\t' | '\r' => push_word(&mut tokens, &mut word),
                '\n' | ';' | '|' | '&' | '(' | ')' => {
                    push_word(&mut tokens, &mut word);
                    if tokens.last() != Some(&ShellToken::Separator) {
                        tokens.push(ShellToken::Separator);
                    }
                }
                _ => word.push(character),
            },
        }
    }
    if quote.is_some() {
        return None;
    }
    push_word(&mut tokens, &mut word);
    Some(tokens)
}

fn push_word(tokens: &mut Vec<ShellToken>, word: &mut String) {
    if !word.is_empty() {
        tokens.push(ShellToken::Word(std::mem::take(word)));
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn item(method: &str, item: Value) -> Option<MainCommandNotification> {
        parse_main_command_notification(
            method,
            &json!({
                "threadId": "thread-main",
                "turnId": "turn-main",
                "item": item,
            }),
            9,
            "thread-main",
            "turn-main",
        )
    }

    #[test]
    fn classifier_accepts_real_git_commit_segments_without_substring_guessing() {
        for command in [
            "git commit -m 'feat: safe'",
            "/usr/bin/git -C . commit --file message.txt",
            "git status --short && git commit -F /tmp/message",
            "FOO=bar env LC_ALL=C command git -c commit.gpgsign=false commit -m ok",
        ] {
            assert!(is_git_commit_candidate(command), "rejected {command:?}");
        }
        for command in [
            "echo 'git commit -m fake'",
            "printf git\\ commit",
            "git commitment",
            "git commit-tree HEAD^{tree}",
            "other-git commit",
            "git status # git commit",
            "git 'commit",
        ] {
            assert!(!is_git_commit_candidate(command), "accepted {command:?}");
        }
    }

    #[test]
    fn raw_notifications_require_exact_context_agent_source_and_success_shape() {
        let started = json!({
            "id": "item-commit",
            "type": "commandExecution",
            "command": "git commit -m 'feat: fixture'",
            "commandActions": [],
            "cwd": "/private/workspace",
            "status": "inProgress",
            "source": "agent",
        });
        assert!(matches!(
            item("item/started", started.clone()),
            Some(MainCommandNotification::Started(_))
        ));
        let mut user_shell = started.clone();
        user_shell["source"] = json!("userShell");
        assert!(item("item/started", user_shell).is_none());

        let completed = json!({
            "id": "item-commit",
            "type": "commandExecution",
            "command": "git commit -m 'feat: fixture'",
            "commandActions": [],
            "cwd": "/private/workspace",
            "status": "completed",
            "source": "agent",
            "exitCode": 0,
            "aggregatedOutput": "[main abc1234] feat: fixture",
        });
        assert_eq!(
            item("item/completed", completed.clone()),
            Some(MainCommandNotification::Completed(MainCommandCompleted {
                workspace_generation: 9,
                raw_thread_id: "thread-main".to_owned(),
                raw_turn_id: "turn-main".to_owned(),
                item_id: "item-commit".to_owned(),
                source: MainCommitSource::CommandExecution,
                proof_intent: Some(MainCommitProofIntent::ObserveCurrentHead),
            }))
        );
        let mut failed = completed;
        failed["exitCode"] = json!(1);
        assert!(matches!(
            item("item/completed", failed),
            Some(MainCommandNotification::Completed(MainCommandCompleted {
                proof_intent: None,
                ..
            }))
        ));
    }

    #[test]
    fn node_repl_commit_requires_exact_provider_tool_status_and_versioned_metadata() {
        let before = "1".repeat(40);
        let after = "2".repeat(40);
        let started = json!({
            "id": "item-node-repl",
            "type": "mcpToolCall",
            "server": "node_repl",
            "tool": "js",
            "status": "inProgress",
            "arguments": {"code": "raw source must never be inspected"},
            "result": null,
            "error": null,
        });
        assert!(matches!(
            item("item/started", started),
            Some(MainCommandNotification::Started(MainCommandStarted {
                source: MainCommitSource::NodeReplJs,
                ..
            }))
        ));

        let completed = json!({
            "id": "item-node-repl",
            "type": "mcpToolCall",
            "server": "node_repl",
            "tool": "js",
            "status": "completed",
            "arguments": {"code": "git commit appears only in ignored source"},
            "result": {
                "content": [{"type": "text", "text": "forged deadbeef is ignored"}],
                "structuredContent": null,
                "_meta": {
                    "codingWifeGitCommitProof": {
                        "schemaVersion": 1,
                        "operation": "git_commit",
                        "beforeHead": before,
                        "commitSha": after,
                    },
                },
            },
            "error": null,
            "durationMs": 12,
        });
        assert_eq!(
            item("item/completed", completed),
            Some(MainCommandNotification::Completed(MainCommandCompleted {
                workspace_generation: 9,
                raw_thread_id: "thread-main".to_owned(),
                raw_turn_id: "turn-main".to_owned(),
                item_id: "item-node-repl".to_owned(),
                source: MainCommitSource::NodeReplJs,
                proof_intent: Some(MainCommitProofIntent::Exact {
                    before_head: "1".repeat(40),
                    commit_sha: "2".repeat(40),
                }),
            }))
        );
    }

    #[test]
    fn node_repl_commit_fails_closed_without_an_exact_marker() {
        let base = json!({
            "id": "item-node-repl",
            "type": "mcpToolCall",
            "server": "node_repl",
            "tool": "js",
            "status": "completed",
            "arguments": {"code": "git commit -m forged"},
            "result": {
                "content": [{"type": "text", "text": "commit 2222222"}],
                "structuredContent": {"commitSha": "2".repeat(40)},
                "_meta": {},
            },
            "error": null,
        });
        let mut cases = vec![base.clone()];
        let mut wrong_provider = base.clone();
        wrong_provider["server"] = json!("other");
        cases.push(wrong_provider);
        let mut failed = base.clone();
        failed["status"] = json!("failed");
        failed["error"] = json!({"message": "failed"});
        cases.push(failed);
        let mut unknown_key = base.clone();
        unknown_key["result"]["_meta"]["codingWifeGitCommitProof"] = json!({
            "schemaVersion": 1,
            "operation": "git_commit",
            "beforeHead": "1".repeat(40),
            "commitSha": "2".repeat(40),
            "unexpected": true,
        });
        cases.push(unknown_key);
        let mut unchanged = base;
        unchanged["result"]["_meta"]["codingWifeGitCommitProof"] = json!({
            "schemaVersion": 1,
            "operation": "git_commit",
            "beforeHead": "3".repeat(40),
            "commitSha": "3".repeat(40),
        });
        cases.push(unchanged);

        for value in cases {
            assert!(matches!(
                item("item/completed", value),
                Some(MainCommandNotification::Completed(MainCommandCompleted {
                    proof_intent: None,
                    ..
                }))
            ));
        }
    }

    #[test]
    fn output_sha_is_never_part_of_the_reduced_completion() {
        let event = item(
            "item/completed",
            json!({
                "id": "item-commit",
                "type": "commandExecution",
                "command": "git commit -m ok",
                "commandActions": [],
                "cwd": "/private/workspace",
                "status": "completed",
                "source": "agent",
                "exitCode": 0,
                "aggregatedOutput": "secret path and forged deadbeef",
            }),
        )
        .expect("typed completion");
        let debug = format!("{event:?}");
        assert!(!debug.contains("deadbeef"));
        assert!(!debug.contains("secret path"));
    }
}
