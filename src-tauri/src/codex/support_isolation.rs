use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use tokio::process::Command;
use tokio::sync::mpsc;

use super::binary::{probe_schema, BinaryInfo, SchemaProbe};
use super::bundled_skill::ResolvedBundledSkill;
use super::process::{run_bounded_command, spawn_support_process, ProcessRuntime};
use super::protocol::{
    client_notification, initialize_params, parse_support_thread_policy_response, server_error,
    support_probe_turn_start_params, support_thread_start_params, InboundMessage,
};
use super::rpc::{RpcRequestError, RuntimeSignal};
use super::support::{SupportRuntimeError, SUPPORT_PERMISSION_PROFILE};
use super::support_private::{support_config, write_private_file, PrivateRunDirectory};
use super::support_probe::{
    canonical_tool_hash, expected_support_tools, ProbeCaptureServer, EXPECTED_SUPPORT_TOOL_HASH,
};
use super::types::{BinarySource, CapabilityState};

const SUPPORTED_CLI_VERSION: &str = "0.144.5";
const SUPPORTED_ARM64_BINARY_SHA256: &str =
    "5e29ab10ca1171be158f7335dd6bd8ce1aaf9af1556939db36a5ee338be6f5f2";
const SUPPORT_PROBE_TIMEOUT: Duration = Duration::from_secs(15);

pub(super) async fn verify_release(
    binary: &BinaryInfo,
    schema: &SchemaProbe,
) -> Result<(), SupportRuntimeError> {
    binary
        .revalidate()
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
) -> Result<(), SupportRuntimeError> {
    let run_directory = PrivateRunDirectory::create("probe")?;
    let repository_canary = run_directory.root.join("repository-canary.txt");
    let auth_canary = run_directory.codex_home.join("auth-canary.json");
    let execution_marker = run_directory.workspace.join("unexpected-execution");
    write_private_file(&repository_canary, b"REPOSITORY-CANARY-MUST-NOT-LEAK")?;
    write_private_file(&auth_canary, b"AUTH-CANARY-MUST-NOT-LEAK")?;
    let mut server = ProbeCaptureServer::start(&repository_canary, &auth_canary, &execution_marker)
        .map_err(|_| SupportRuntimeError::IsolationProbe)?;
    run_directory.write_config(&support_config(Some(&server.base_url())))?;

    let sandbox = sandbox_probe(binary, &run_directory, server.malicious_command()).await?;
    if sandbox.status.success()
        || contains_marker(&sandbox.stdout)
        || contains_marker(&sandbox.stderr)
        || execution_marker.exists()
        || server.tool_canary_requests() != 0
    {
        return Err(SupportRuntimeError::IsolationProbe);
    }

    let (signals, mut receiver) = mpsc::channel(256);
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
    let protocol_probe = async {
        initialize_support_process(&runtime).await?;
        let thread = runtime
            .connection
            .request(
                "thread/start",
                support_thread_start_params(
                    &run_directory.workspace,
                    "mock-model",
                    Some("mock_provider"),
                ),
                Duration::from_secs(5),
            )
            .await
            .map_err(|_| SupportRuntimeError::IsolationProbe)?;
        let thread = parse_support_thread_policy_response(
            &thread,
            &run_directory.workspace,
            "mock-model",
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
                    support_skill,
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
        wait_for_probe_terminal(&runtime, &mut receiver, &thread.thread_id, &turn_id).await
    }
    .await;
    runtime.shutdown().await;
    protocol_probe?;

    let captured = server.captured_requests();
    server.stop();
    let first = captured
        .first()
        .ok_or(SupportRuntimeError::IsolationProbe)?;
    let tools = first
        .get("tools")
        .ok_or(SupportRuntimeError::IsolationProbe)?;
    if tools != &expected_support_tools()
        || canonical_tool_hash(tools).map_err(|_| SupportRuntimeError::IsolationProbe)?
            != EXPECTED_SUPPORT_TOOL_HASH
        || first.get("parallel_tool_calls").and_then(Value::as_bool) != Some(false)
        || first.get("model").and_then(Value::as_str) != Some("mock-model")
        || captured.len() < 2
    {
        return Err(SupportRuntimeError::IsolationProbe);
    }
    let captured_text =
        serde_json::to_string(&captured).map_err(|_| SupportRuntimeError::IsolationProbe)?;
    let unsupported = captured.iter().skip(1).any(|request| {
        request
            .get("input")
            .and_then(Value::as_array)
            .is_some_and(|input| {
                input.iter().any(|item| {
                    item.get("type").and_then(Value::as_str) == Some("function_call_output")
                        && item.get("call_id").and_then(Value::as_str)
                            == Some("malicious-shell-call")
                        && item
                            .get("output")
                            .and_then(Value::as_str)
                            .is_some_and(|output| output.contains("unsupported call"))
                })
            })
    });
    if !unsupported
        || captured_text.contains("REPOSITORY-CANARY-MUST-NOT-LEAK")
        || captured_text.contains("AUTH-CANARY-MUST-NOT-LEAK")
        || execution_marker.exists()
        || server.tool_canary_requests() != 0
    {
        return Err(SupportRuntimeError::IsolationProbe);
    }
    run_directory.cleanup()
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
                    if method == "turn/completed" {
                        if !matches_context(&params, thread_id, turn_id)
                            || params.pointer("/turn/status").and_then(Value::as_str)
                                != Some("completed")
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
