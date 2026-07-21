use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::process::Command;
use tokio::sync::mpsc;

use super::binary::{probe_schema, BinaryInfo, SchemaProbe};
use super::bundled_skill::{
    ResolvedBundledSkill, DIRECT_PRESENCE_SKILL_NAME, EXPLAIN_COMMIT_SKILL_NAME,
};
use super::process::{run_bounded_command, spawn_support_process, ProcessRuntime};
use super::protocol::{
    client_notification, commit_explanation_output_schema, initialize_params,
    parse_support_thread_policy_response, presence_direction_output_schema,
    presence_turn_start_params, server_error, support_thread_start_params,
    support_turn_start_params, InboundMessage, TurnContractError,
};
use super::rpc::{RpcRequestError, RuntimeSignal};
use super::support::{
    parse_explanation, parse_presence_direction, PresenceDirectorInputV1, PresenceElapsedBucket,
    PresenceLocale, PresenceSemanticState, PresenceTrigger, SupportModelRole, SupportRuntimeError,
    SUPPORT_PERMISSION_PROFILE, SUPPORT_SIGNAL_QUEUE_CAPACITY,
};
use super::support_private::{support_config, write_private_file, PrivateRunDirectory};
use super::support_probe::{canonical_json_hash, ProbeCaptureServer};
use super::types::{BinarySource, CapabilityState, CODEX_COMMIT_EXPLAINER_MODEL};
#[cfg(test)]
use super::types::{CODEX_MAIN_MODEL, CODEX_PRESENCE_DIRECTOR_MODEL};

pub(crate) const SUPPORTED_CLI_VERSION: &str = "0.144.5";
pub(crate) const SUPPORTED_ARM64_BINARY_SHA256: &str =
    "5e29ab10ca1171be158f7335dd6bd8ce1aaf9af1556939db36a5ee338be6f5f2";
pub(crate) const SUPPORTED_SCHEMA_FINGERPRINT: &str =
    "efea5c6649ccbae7e26af47874bca302e0803d6db80571d57cd55841890dddbc";
pub(crate) const SUPPORTED_EXPLAIN_SKILL_VERSION: &str = "1.1.0";
pub(crate) const SUPPORTED_EXPLAIN_SKILL_SHA256: &str =
    "a11cfddff346e37be4431add626535175931cd2212f76e088a7c3f9305d0207f";
pub(crate) const SUPPORTED_PRESENCE_SKILL_VERSION: &str = "1.0.0";
pub(crate) const SUPPORTED_PRESENCE_SKILL_SHA256: &str =
    "2b7468f2e12d15fbaf400199a806c0a65838b727474e3a9458d04a948ad99ac9";
const EXPECTED_EXPLANATION_OUTPUT_SCHEMA_HASH: &str =
    "c01cb830b87c827b22842342f0410657b259ccbd113e3db05bd988ff48e4f3c9";
const EXPECTED_PRESENCE_OUTPUT_SCHEMA_HASH: &str =
    "173ce05ff7f52f18bb9f76dc766c098b31369dceb6ca7052cba35b3ee62a44d9";
const SUPPORT_PROBE_TIMEOUT: Duration = Duration::from_secs(15);
const SUPPORT_PROTOCOL_PROBE_TIMEOUT: Duration = Duration::from_secs(30);

pub(super) async fn verify_release(
    binary: &BinaryInfo,
    schema: &SchemaProbe,
) -> Result<(), SupportRuntimeError> {
    binary
        .revalidate_metadata()
        .await
        .map_err(|_| SupportRuntimeError::UnsupportedRelease)?;
    let observed_schema = probe_schema(binary)
        .await
        .map_err(|_| SupportRuntimeError::Schema)?;
    let fixture = binary.source == BinarySource::TestFixture;
    if binary.cli_version != SUPPORTED_CLI_VERSION
        || (!fixture && binary.executable_sha256 != SUPPORTED_ARM64_BINARY_SHA256)
    {
        return Err(SupportRuntimeError::UnsupportedRelease);
    }
    if observed_schema.fingerprint != schema.fingerprint
        || observed_schema.capabilities != schema.capabilities
        || !observed_schema.generated_by_same_binary
        || !schema.generated_by_same_binary
        || schema.fingerprint.len() != 64
        || (!fixture && schema.fingerprint != SUPPORTED_SCHEMA_FINGERPRINT)
        || schema.capabilities.core_lifecycle != CapabilityState::Supported
        || schema.capabilities.ephemeral_thread != CapabilityState::Supported
    {
        return Err(SupportRuntimeError::Schema);
    }
    Ok(())
}

pub(super) async fn run_isolation_probe(
    binary: &BinaryInfo,
    support_skill: &ResolvedBundledSkill,
    model_role: SupportModelRole,
) -> Result<(), SupportRuntimeError> {
    if !support_skill_matches_role(support_skill, model_role) {
        return Err(SupportRuntimeError::Skill);
    }
    let run_directory = PrivateRunDirectory::create("probe")?;
    let support_skill = run_directory.snapshot_support_skill(support_skill)?;
    let repository_canary = run_directory.root.join("repository-canary.txt");
    let auth_canary = run_directory.codex_home.join("auth-canary.json");
    let execution_marker = run_directory.workspace.join("unexpected-execution");
    write_private_file(&repository_canary, b"REPOSITORY-CANARY-MUST-NOT-LEAK")?;
    write_private_file(&auth_canary, b"AUTH-CANARY-MUST-NOT-LEAK")?;
    let mut server = ProbeCaptureServer::start(
        &repository_canary,
        &auth_canary,
        &execution_marker,
        support_probe_output(model_role),
    )
    .map_err(|_| SupportRuntimeError::IsolationProbe)?;
    run_directory.write_config(&support_config(
        model_role.exact_model(),
        Some(&server.base_url()),
    ))?;

    let sandbox = sandbox_probe(binary, &run_directory, server.malicious_command()).await?;
    if sandbox.status.success()
        || contains_marker(&sandbox.stdout)
        || contains_marker(&sandbox.stderr)
        || execution_marker.exists()
        || server.tool_canary_requests() != 0
    {
        return Err(SupportRuntimeError::IsolationProbe);
    }

    let (signals, mut receiver) = mpsc::channel(SUPPORT_SIGNAL_QUEUE_CAPACITY);
    let runtime = Arc::new(
        spawn_support_process(
            binary,
            &run_directory.workspace,
            &run_directory.root,
            1,
            signals,
            run_directory.environment(binary.source == BinarySource::TestFixture),
        )
        .await
        .map_err(|_| SupportRuntimeError::IsolationProbe)?,
    );
    let protocol_probe = tokio::time::timeout(SUPPORT_PROTOCOL_PROBE_TIMEOUT, async {
        initialize_support_process(&runtime).await?;
        let thread = runtime
            .connection
            .request(
                "thread/start",
                support_thread_start_params(
                    &run_directory.workspace,
                    model_role.exact_model(),
                    Some("mock_provider"),
                ),
                Duration::from_secs(5),
            )
            .await
            .map_err(|_| SupportRuntimeError::IsolationProbe)?;
        let thread = parse_support_thread_policy_response(
            &thread,
            &run_directory.workspace,
            model_role.exact_model(),
            Some("mock_provider"),
        )
        .map_err(|_| SupportRuntimeError::IsolationProbe)?;
        let turn = runtime
            .connection
            .request(
                "turn/start",
                support_probe_turn_start_params(
                    &thread.thread_id,
                    &run_directory.workspace,
                    "support-release-probe",
                    &support_skill,
                    model_role,
                )
                .map_err(|_| SupportRuntimeError::Skill)?,
                SUPPORT_PROBE_TIMEOUT,
            )
            .await
            .map_err(|_| SupportRuntimeError::IsolationProbe)?;
        let turn_id = turn
            .pointer("/turn/id")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty() && value.len() <= 256)
            .map(str::to_owned)
            .ok_or(SupportRuntimeError::IsolationProbe)?;
        wait_for_probe_terminal(
            &runtime,
            &mut receiver,
            &thread.thread_id,
            &turn_id,
            model_role,
        )
        .await?;

        let policy_turn = runtime
            .connection
            .request(
                "turn/start",
                support_probe_turn_start_params(
                    &thread.thread_id,
                    &run_directory.workspace,
                    "support-release-policy-probe",
                    &support_skill,
                    model_role,
                )
                .map_err(|_| SupportRuntimeError::Skill)?,
                SUPPORT_PROBE_TIMEOUT,
            )
            .await
            .map_err(|_| SupportRuntimeError::IsolationProbe)?;
        let policy_turn_id = policy_turn
            .pointer("/turn/id")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty() && value.len() <= 256)
            .map(str::to_owned)
            .ok_or(SupportRuntimeError::IsolationProbe)?;
        wait_for_probe_policy_rejection(&runtime, &mut receiver, &thread.thread_id, &policy_turn_id)
            .await
    })
    .await
    .map_err(|_| SupportRuntimeError::IsolationProbe)
    .and_then(|result| result);
    runtime.shutdown().await;
    let process_exited = runtime.has_exited().await;
    if !process_exited {
        return Err(SupportRuntimeError::IsolationProbe);
    }
    protocol_probe?;

    let captured = server.captured_requests();
    server.stop();
    if binary.source == BinarySource::TestFixture {
        if execution_marker.exists() || server.tool_canary_requests() != 0 {
            return Err(SupportRuntimeError::IsolationProbe);
        }
        return run_directory.cleanup();
    }
    if captured.len() != 3
        || captured
            .iter()
            .any(|request| !production_request_envelope_is_exact(request, model_role))
    {
        return Err(SupportRuntimeError::IsolationProbe);
    }
    let captured_text =
        serde_json::to_string(&captured).map_err(|_| SupportRuntimeError::IsolationProbe)?;
    let unsupported = |call_id: &str| {
        captured.iter().skip(1).any(|request| {
            request
                .get("input")
                .and_then(Value::as_array)
                .is_some_and(|input| {
                    input.iter().any(|item| {
                        item.get("type").and_then(Value::as_str) == Some("function_call_output")
                            && item.get("call_id").and_then(Value::as_str) == Some(call_id)
                            && item
                                .get("output")
                                .and_then(Value::as_str)
                                .is_some_and(|output| output.contains("unsupported call"))
                    })
                })
        })
    };
    if !unsupported("malicious-shell-call")
        || captured_text.contains("REPOSITORY-CANARY-MUST-NOT-LEAK")
        || captured_text.contains("AUTH-CANARY-MUST-NOT-LEAK")
        || execution_marker.exists()
        || server.tool_canary_requests() != 0
    {
        return Err(SupportRuntimeError::IsolationProbe);
    }
    run_directory.cleanup()
}

fn support_probe_input(request_id: &str) -> String {
    serde_json::to_string(&json!({
        "schemaVersion": 1,
        "requestId": request_id,
        "trigger": "user_request",
        "evidence": {
            "schemaVersion": 1,
            "commitId": format!("commit-{}", "a".repeat(40)),
            "subject": "Verify the isolated support release envelope",
            "body": "",
            "changes": [],
            "diffSummary": {
                "filesChanged": 0,
                "additions": 0,
                "deletions": 0,
                "binaryFiles": 0
            },
            "verification": [],
            "decisions": [],
            "risks": [],
            "locale": "ja",
            "workspaceGeneration": 1,
            "selectionVersion": 1
        }
    }))
    .expect("support probe input is static JSON")
}

fn presence_probe_input() -> PresenceDirectorInputV1 {
    PresenceDirectorInputV1 {
        schema_version: 1,
        locale: PresenceLocale::Ja,
        trigger: PresenceTrigger::DecisionWait,
        semantic_state: PresenceSemanticState::Asking,
        retrying: false,
        elapsed_bucket: PresenceElapsedBucket::None,
    }
}

fn support_probe_turn_start_params(
    thread_id: &str,
    cwd: &std::path::Path,
    client_user_message_id: &str,
    support_skill: &ResolvedBundledSkill,
    model_role: SupportModelRole,
) -> Result<Value, TurnContractError> {
    match model_role {
        SupportModelRole::CommitExplainer => support_turn_start_params(
            thread_id,
            cwd,
            client_user_message_id,
            &support_probe_input(client_user_message_id),
            "ja",
            CODEX_COMMIT_EXPLAINER_MODEL,
            support_skill,
        ),
        SupportModelRole::PresenceDirector => {
            let input = serde_json::to_string(&presence_probe_input())
                .expect("presence support probe input is static JSON");
            presence_turn_start_params(
                thread_id,
                cwd,
                client_user_message_id,
                &input,
                "ja",
                support_skill,
            )
        }
    }
}

fn support_probe_output(model_role: SupportModelRole) -> String {
    let value = match model_role {
        SupportModelRole::CommitExplainer => json!({
            "schemaVersion": 1,
            "locale": "ja",
            "summary": "隔離された説明実行のリリース境界を確認しました。",
            "changes": ["本番と同一の出力契約を検証しました。"],
            "reasons": ["support runtime の権限を固定するためです。"],
            "verification": ["本番モデル、低 effort、完全な schema を確認しました。"],
            "impact": ["外部ツール権限は追加されません。"],
            "cautions": ["実リポジトリの内容は使用していません。"],
            "howToReadNext": ["検証済み evidence を確認してください。"],
            "narrationChunks": [{
                "sequence": 1,
                "section": "summary",
                "text": "隔離された説明実行のリリース境界を確認しました。"
            }]
        }),
        SupportModelRole::PresenceDirector => json!({
            "schemaVersion": 1,
            "locale": "ja",
            "utterance": "確認が必要なところで待っています。",
            "cue": "asking"
        }),
    };
    serde_json::to_string(&value).expect("static support probe output")
}

fn support_skill_matches_role(
    support_skill: &ResolvedBundledSkill,
    model_role: SupportModelRole,
) -> bool {
    let (name, version, sha256) = match model_role {
        SupportModelRole::CommitExplainer => (
            EXPLAIN_COMMIT_SKILL_NAME,
            SUPPORTED_EXPLAIN_SKILL_VERSION,
            SUPPORTED_EXPLAIN_SKILL_SHA256,
        ),
        SupportModelRole::PresenceDirector => (
            DIRECT_PRESENCE_SKILL_NAME,
            SUPPORTED_PRESENCE_SKILL_VERSION,
            SUPPORTED_PRESENCE_SKILL_SHA256,
        ),
    };
    support_skill.name == name
        && support_skill.version == version
        && support_skill.content_digest == format!("sha256:{sha256}")
}

fn captured_output_schema(request: &Value) -> Option<&Value> {
    request
        .pointer("/text/format/schema")
        .or_else(|| request.pointer("/response_format/json_schema/schema"))
        .or_else(|| request.pointer("/response_format/schema"))
}

fn production_request_envelope_is_exact(request: &Value, model_role: SupportModelRole) -> bool {
    let output_schema = captured_output_schema(request);
    let (expected_schema, expected_schema_hash) = match model_role {
        SupportModelRole::CommitExplainer => (
            commit_explanation_output_schema("ja"),
            EXPECTED_EXPLANATION_OUTPUT_SCHEMA_HASH,
        ),
        SupportModelRole::PresenceDirector => (
            presence_direction_output_schema("ja"),
            EXPECTED_PRESENCE_OUTPUT_SCHEMA_HASH,
        ),
    };
    request.get("tools").is_none()
        && request.get("tool_choice").and_then(Value::as_str) == Some("auto")
        && request.get("parallel_tool_calls").and_then(Value::as_bool) == Some(false)
        && request.get("model").and_then(Value::as_str) == Some(model_role.exact_model())
        && request.pointer("/reasoning/effort").and_then(Value::as_str) == Some("low")
        && output_schema == Some(&expected_schema)
        && output_schema
            .and_then(|schema| canonical_json_hash(schema).ok())
            .as_deref()
            == Some(expected_schema_hash)
}

async fn sandbox_probe(
    binary: &BinaryInfo,
    run_directory: &PrivateRunDirectory,
    command_text: &str,
) -> Result<super::process::BoundedCommandOutput, SupportRuntimeError> {
    let mut command = Command::new(&binary.canonical_path);
    command
        .arg("sandbox")
        .arg("-P")
        .arg(SUPPORT_PERMISSION_PROFILE)
        .arg("-C")
        .arg(&run_directory.workspace)
        .arg("/bin/sh")
        .arg("-c")
        .arg(command_text)
        .current_dir(&run_directory.workspace)
        .env_clear()
        .envs(run_directory.environment(binary.source == BinarySource::TestFixture));
    run_bounded_command(command, Duration::from_secs(10), 64 * 1024, 64 * 1024)
        .await
        .map_err(|_| SupportRuntimeError::IsolationProbe)
}

pub(super) async fn initialize_support_process(
    runtime: &ProcessRuntime,
) -> Result<(), SupportRuntimeError> {
    runtime
        .connection
        .request(
            "initialize",
            initialize_params(env!("CARGO_PKG_VERSION"), true),
            Duration::from_secs(5),
        )
        .await
        .map_err(map_rpc_error)?;
    runtime
        .connection
        .send(client_notification("initialized"))
        .map_err(map_rpc_error)
}

async fn wait_for_probe_terminal(
    runtime: &ProcessRuntime,
    receiver: &mut mpsc::Receiver<RuntimeSignal>,
    thread_id: &str,
    turn_id: &str,
    model_role: SupportModelRole,
) -> Result<(), SupportRuntimeError> {
    let deadline = tokio::time::Instant::now() + SUPPORT_PROBE_TIMEOUT;
    let mut valid_explanation = false;
    loop {
        let signal = tokio::time::timeout_at(deadline, receiver.recv())
            .await
            .map_err(|_| SupportRuntimeError::IsolationProbe)?
            .ok_or(SupportRuntimeError::IsolationProbe)?;
        match signal {
            RuntimeSignal::ProtocolViolation { .. } | RuntimeSignal::Disconnected { .. } => {
                return Err(SupportRuntimeError::IsolationProbe)
            }
            RuntimeSignal::Inbound { message, .. } => match message {
                InboundMessage::ServerRequest { id, .. } => {
                    let _ = runtime.connection.send(server_error(
                        &id,
                        -32601,
                        "Support probe rejects server requests",
                    ));
                    return Err(SupportRuntimeError::IsolationProbe);
                }
                InboundMessage::Notification { method, params, .. } => {
                    if method == "item/completed"
                        && params.pointer("/item/type").and_then(Value::as_str)
                            == Some("agentMessage")
                    {
                        if !matches_context(&params, thread_id, turn_id) {
                            return Err(SupportRuntimeError::IsolationProbe);
                        }
                        let text = params
                            .pointer("/item/text")
                            .and_then(Value::as_str)
                            .ok_or(SupportRuntimeError::IsolationProbe)?;
                        let valid_output = match model_role {
                            SupportModelRole::CommitExplainer => {
                                parse_explanation(text, "ja").is_ok()
                            }
                            SupportModelRole::PresenceDirector => {
                                parse_presence_direction(text, &presence_probe_input()).is_ok()
                            }
                        };
                        if valid_explanation || !valid_output {
                            return Err(SupportRuntimeError::IsolationProbe);
                        }
                        valid_explanation = true;
                    }
                    if method == "turn/completed" {
                        if !matches_context(&params, thread_id, turn_id)
                            || params.pointer("/turn/status").and_then(Value::as_str)
                                != Some("completed")
                            || !valid_explanation
                        {
                            return Err(SupportRuntimeError::IsolationProbe);
                        }
                        return Ok(());
                    }
                    if method == "turn/plan/updated" || method.contains("request") {
                        return Err(SupportRuntimeError::IsolationProbe);
                    }
                }
                InboundMessage::Response { .. } => return Err(SupportRuntimeError::IsolationProbe),
            },
        }
    }
}

async fn wait_for_probe_policy_rejection(
    runtime: &ProcessRuntime,
    receiver: &mut mpsc::Receiver<RuntimeSignal>,
    thread_id: &str,
    turn_id: &str,
) -> Result<(), SupportRuntimeError> {
    let deadline = tokio::time::Instant::now() + SUPPORT_PROBE_TIMEOUT;
    loop {
        let signal = tokio::time::timeout_at(deadline, receiver.recv())
            .await
            .map_err(|_| SupportRuntimeError::IsolationProbe)?
            .ok_or(SupportRuntimeError::IsolationProbe)?;
        match signal {
            RuntimeSignal::ProtocolViolation { .. } | RuntimeSignal::Disconnected { .. } => {
                return Err(SupportRuntimeError::IsolationProbe)
            }
            RuntimeSignal::Inbound { message, .. } => match message {
                InboundMessage::ServerRequest { id, .. } => {
                    let _ = runtime.connection.send(server_error(
                        &id,
                        -32601,
                        "Support probe rejects server requests",
                    ));
                    return Err(SupportRuntimeError::IsolationProbe);
                }
                InboundMessage::Notification { method, params, .. } => {
                    if method == "turn/plan/updated" {
                        return matches_context(&params, thread_id, turn_id)
                            .then_some(())
                            .ok_or(SupportRuntimeError::IsolationProbe);
                    }
                    if method == "turn/completed" || method.contains("request") {
                        return Err(SupportRuntimeError::IsolationProbe);
                    }
                }
                InboundMessage::Response { .. } => return Err(SupportRuntimeError::IsolationProbe),
            },
        }
    }
}

fn matches_context(params: &Value, thread_id: &str, turn_id: &str) -> bool {
    params.get("threadId").and_then(Value::as_str) == Some(thread_id)
        && (params.get("turnId").and_then(Value::as_str) == Some(turn_id)
            || params.pointer("/turn/id").and_then(Value::as_str) == Some(turn_id))
}

fn contains_marker(bytes: &[u8]) -> bool {
    let text = String::from_utf8_lossy(bytes);
    text.contains("REPOSITORY-CANARY-MUST-NOT-LEAK") || text.contains("AUTH-CANARY-MUST-NOT-LEAK")
}

pub(super) fn map_rpc_error(error: RpcRequestError) -> SupportRuntimeError {
    match error {
        RpcRequestError::Timeout => SupportRuntimeError::Timeout,
        RpcRequestError::ConnectionLost
        | RpcRequestError::Protocol
        | RpcRequestError::Server { .. } => SupportRuntimeError::Protocol,
        RpcRequestError::Overloaded => SupportRuntimeError::Busy,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn exact_request(model_role: SupportModelRole) -> Value {
        let schema = match model_role {
            SupportModelRole::CommitExplainer => commit_explanation_output_schema("ja"),
            SupportModelRole::PresenceDirector => presence_direction_output_schema("ja"),
        };
        json!({
            "model": model_role.exact_model(),
            "parallel_tool_calls": false,
            "reasoning": {"effort": "low"},
            "tool_choice": "auto",
            "text": {"format": {"schema": schema}}
        })
    }

    #[test]
    fn production_envelope_requires_exact_low_reasoning_effort() {
        let request = exact_request(SupportModelRole::CommitExplainer);
        assert!(production_request_envelope_is_exact(
            &request,
            SupportModelRole::CommitExplainer
        ));

        let mut missing = request.clone();
        missing
            .as_object_mut()
            .expect("request object")
            .remove("reasoning");
        assert!(!production_request_envelope_is_exact(
            &missing,
            SupportModelRole::CommitExplainer
        ));

        for effort in [
            Value::Null,
            json!("medium"),
            json!("high"),
            json!("xhigh"),
            json!("unexpected"),
        ] {
            let mut changed = request.clone();
            changed["reasoning"]["effort"] = effort;
            assert!(!production_request_envelope_is_exact(
                &changed,
                SupportModelRole::CommitExplainer
            ));
        }

        for reasoning in [json!("low"), json!([{"effort": "low"}]), json!({})] {
            let mut changed = request.clone();
            changed["reasoning"] = reasoning;
            assert!(!production_request_envelope_is_exact(
                &changed,
                SupportModelRole::CommitExplainer
            ));
        }
    }

    #[test]
    fn production_envelope_requires_the_tools_field_to_be_absent() {
        let request = exact_request(SupportModelRole::CommitExplainer);
        assert!(production_request_envelope_is_exact(
            &request,
            SupportModelRole::CommitExplainer
        ));

        let mut empty_tools = request.clone();
        empty_tools["tools"] = json!([]);
        assert!(!production_request_envelope_is_exact(
            &empty_tools,
            SupportModelRole::CommitExplainer
        ));

        let mut added_tool = request.clone();
        added_tool["tools"] = json!([{"type": "function", "name": "update_plan"}]);
        assert!(!production_request_envelope_is_exact(
            &added_tool,
            SupportModelRole::CommitExplainer
        ));

        let mut changed_choice = request.clone();
        changed_choice["tool_choice"] = json!("none");
        assert!(!production_request_envelope_is_exact(
            &changed_choice,
            SupportModelRole::CommitExplainer
        ));

        let mut changed_parallel = request;
        changed_parallel["parallel_tool_calls"] = json!(true);
        assert!(!production_request_envelope_is_exact(
            &changed_parallel,
            SupportModelRole::CommitExplainer
        ));
    }

    #[test]
    fn production_commit_explainer_envelope_rejects_cross_role_models() {
        let request = exact_request(SupportModelRole::CommitExplainer);
        assert!(production_request_envelope_is_exact(
            &request,
            SupportModelRole::CommitExplainer
        ));

        for model in [CODEX_MAIN_MODEL, CODEX_PRESENCE_DIRECTOR_MODEL] {
            let mut changed = request.clone();
            changed["model"] = json!(model);
            assert!(
                !production_request_envelope_is_exact(&changed, SupportModelRole::CommitExplainer),
                "accepted cross-role model {model}"
            );
        }
    }

    #[test]
    fn production_presence_envelope_requires_luna_and_its_exact_schema() {
        let request = exact_request(SupportModelRole::PresenceDirector);
        assert!(production_request_envelope_is_exact(
            &request,
            SupportModelRole::PresenceDirector
        ));
        assert!(!production_request_envelope_is_exact(
            &request,
            SupportModelRole::CommitExplainer
        ));

        for model in [CODEX_MAIN_MODEL, CODEX_COMMIT_EXPLAINER_MODEL] {
            let mut changed = request.clone();
            changed["model"] = json!(model);
            assert!(
                !production_request_envelope_is_exact(&changed, SupportModelRole::PresenceDirector),
                "accepted cross-role model {model}"
            );
        }

        let mut explanation_schema = request;
        explanation_schema["text"]["format"]["schema"] = commit_explanation_output_schema("ja");
        assert!(!production_request_envelope_is_exact(
            &explanation_schema,
            SupportModelRole::PresenceDirector
        ));
    }
}
