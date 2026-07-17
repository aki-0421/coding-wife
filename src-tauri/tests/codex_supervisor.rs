use std::path::{Path, PathBuf};
use std::time::Duration;

use coding_wife_lib::codex::binary::{discover_binary, probe_schema};
use coding_wife_lib::codex::process::spawn_process;
use coding_wife_lib::codex::protocol::{client_notification, initialize_params};
use coding_wife_lib::codex::rpc::{RpcRequestError, RuntimeSignal};
use coding_wife_lib::codex::supervisor::CodexSupervisor;
use coding_wife_lib::codex::types::{
    CodexConnectRequest, CodexHealth, CodexThreadStartRequest, CodexTurnInterruptRequest,
    CodexTurnStartRequest, ReasoningPreset,
};
use tokio::sync::{mpsc, Mutex};

static ENVIRONMENT_LOCK: Mutex<()> = Mutex::const_new(());

fn fixture_binary() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake_codex_app_server.py")
}

fn temporary_directory(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "coding-wife-{label}-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ))
}

struct FixtureEnvironment {
    workspace: PathBuf,
    state: PathBuf,
}

impl FixtureEnvironment {
    fn new(mode: &str) -> Self {
        let workspace = temporary_directory("workspace");
        std::fs::create_dir_all(&workspace).expect("workspace fixture directory");
        let state = temporary_directory("state");
        std::env::set_var("CODING_WIFE_CODEX_FAKE_MODE", mode);
        std::env::set_var("CODING_WIFE_CODEX_FAKE_STATE", &state);
        Self { workspace, state }
    }
}

impl Drop for FixtureEnvironment {
    fn drop(&mut self) {
        std::env::remove_var("CODING_WIFE_CODEX_FAKE_MODE");
        std::env::remove_var("CODING_WIFE_CODEX_FAKE_STATE");
        let _ = std::fs::remove_dir_all(&self.workspace);
        let _ = std::fs::remove_file(&self.state);
    }
}

async fn direct_runtime(
    workspace: &Path,
) -> (
    std::sync::Arc<coding_wife_lib::codex::process::ProcessRuntime>,
    mpsc::Receiver<RuntimeSignal>,
) {
    let binary = discover_binary(Some(&fixture_binary()))
        .await
        .expect("fixture binary discovery");
    probe_schema(&binary).await.expect("fixture schema probe");
    let (signals, receiver) = mpsc::channel(64);
    let runtime = std::sync::Arc::new(
        spawn_process(&binary, workspace, 1, signals)
            .await
            .expect("fixture process"),
    );
    (runtime, receiver)
}

async fn initialize_direct(
    runtime: &coding_wife_lib::codex::process::ProcessRuntime,
) -> Result<(), RpcRequestError> {
    runtime
        .connection
        .request(
            "initialize",
            initialize_params("test", true),
            Duration::from_secs(1),
        )
        .await?;
    runtime
        .connection
        .send(client_notification("initialized"))?;
    Ok(())
}

async fn read_state(path: &Path) -> String {
    tokio::fs::read_to_string(path).await.unwrap_or_default()
}

async fn expect_protocol_violation(signals: &mut mpsc::Receiver<RuntimeSignal>) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(1);
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        let signal = tokio::time::timeout(remaining, signals.recv())
            .await
            .expect("protocol violation signal timeout")
            .expect("runtime signal channel closed");
        if matches!(signal, RuntimeSignal::ProtocolViolation { .. }) {
            return;
        }
    }
}

#[tokio::test]
async fn fragmented_process_completes_handshake_turn_and_interrupt_contract() {
    let _guard = ENVIRONMENT_LOCK.lock().await;
    let fixture = FixtureEnvironment::new("fragmented");
    let supervisor = CodexSupervisor::new();
    supervisor.start_signal_loop();
    supervisor
        .register_workspace_root("workspace", &fixture.workspace)
        .await
        .expect("register workspace");
    supervisor.set_explicit_binary(Some(fixture_binary())).await;

    let diagnostic = supervisor
        .connect(CodexConnectRequest {
            workspace_id: "workspace".to_owned(),
        })
        .await
        .expect("connect fixture");
    assert_eq!(diagnostic.health, CodexHealth::Ready);
    assert!(diagnostic.experimental_api_accepted);
    assert_eq!(
        diagnostic.capabilities.support_isolation,
        coding_wife_lib::codex::types::CapabilityState::Unavailable
    );

    let thread = supervisor
        .thread_start(CodexThreadStartRequest {
            workspace_id: "workspace".to_owned(),
        })
        .await
        .expect("thread start");
    let turn = supervisor
        .turn_start(CodexTurnStartRequest {
            workspace_id: "workspace".to_owned(),
            thread_handle: thread.thread_handle.clone(),
            client_user_message_id: "message-1".to_owned(),
            text: "Inspect the fixture.".to_owned(),
            effort: ReasoningPreset::Low,
        })
        .await
        .expect("turn start");
    supervisor
        .turn_interrupt(CodexTurnInterruptRequest {
            workspace_id: "workspace".to_owned(),
            thread_handle: thread.thread_handle,
            turn_handle: turn.turn_handle,
        })
        .await
        .expect("interrupt ack");
    tokio::time::sleep(Duration::from_millis(100)).await;
    let state = read_state(&fixture.state).await;
    assert!(state.contains("turn_contract_ok"));
    assert!(state.contains("interrupt_received"));
    supervisor.shutdown().await;
}

#[tokio::test]
async fn request_correlation_handles_out_of_order_and_timeout_without_replay() {
    let _guard = ENVIRONMENT_LOCK.lock().await;
    let fixture = FixtureEnvironment::new("out_of_order");
    let (runtime, _signals) = direct_runtime(&fixture.workspace).await;
    initialize_direct(&runtime).await.expect("initialize");

    let first =
        runtime
            .connection
            .request("fixture/one", serde_json::json!({}), Duration::from_secs(1));
    let second =
        runtime
            .connection
            .request("fixture/two", serde_json::json!({}), Duration::from_secs(1));
    let (first, second) = tokio::join!(first, second);
    assert_eq!(first.expect("first")["method"], "fixture/one");
    assert_eq!(second.expect("second")["method"], "fixture/two");

    let timeout = runtime
        .connection
        .request(
            "fixture/timeout",
            serde_json::json!({}),
            Duration::from_millis(50),
        )
        .await;
    assert!(matches!(timeout, Err(RpcRequestError::Timeout)));
    runtime.shutdown().await;
}

#[tokio::test]
async fn malformed_and_duplicate_frames_are_protocol_violations() {
    let _guard = ENVIRONMENT_LOCK.lock().await;

    let malformed = FixtureEnvironment::new("malformed");
    let (runtime, mut signals) = direct_runtime(&malformed.workspace).await;
    let initialize = runtime
        .connection
        .request(
            "initialize",
            initialize_params("test", true),
            Duration::from_secs(1),
        )
        .await;
    assert!(
        initialize.is_ok() || matches!(initialize, Err(RpcRequestError::ConnectionLost)),
        "a malformed frame may share the same read as the valid response"
    );
    expect_protocol_violation(&mut signals).await;
    runtime.shutdown().await;
    drop(malformed);

    let duplicate = FixtureEnvironment::new("default");
    let (runtime, mut signals) = direct_runtime(&duplicate.workspace).await;
    initialize_direct(&runtime).await.expect("initialize");
    runtime
        .connection
        .request(
            "fixture/duplicate",
            serde_json::json!({}),
            Duration::from_secs(1),
        )
        .await
        .expect("first duplicate response");
    expect_protocol_violation(&mut signals).await;
    runtime.shutdown().await;
}

#[tokio::test]
async fn unknown_server_request_is_rejected_and_turn_is_interrupted() {
    let _guard = ENVIRONMENT_LOCK.lock().await;
    let fixture = FixtureEnvironment::new("unknown_request");
    let supervisor = CodexSupervisor::new();
    supervisor.start_signal_loop();
    supervisor
        .register_workspace_root("workspace", &fixture.workspace)
        .await
        .expect("register workspace");
    supervisor.set_explicit_binary(Some(fixture_binary())).await;
    supervisor
        .connect(CodexConnectRequest {
            workspace_id: "workspace".to_owned(),
        })
        .await
        .expect("connect");
    let thread = supervisor
        .thread_start(CodexThreadStartRequest {
            workspace_id: "workspace".to_owned(),
        })
        .await
        .expect("thread");
    supervisor
        .turn_start(CodexTurnStartRequest {
            workspace_id: "workspace".to_owned(),
            thread_handle: thread.thread_handle,
            client_user_message_id: "message-unknown".to_owned(),
            text: "Trigger the request.".to_owned(),
            effort: ReasoningPreset::Max,
        })
        .await
        .expect("turn");

    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    loop {
        let state = read_state(&fixture.state).await;
        if state.contains("unknown_request_rejected") && state.contains("interrupt_received") {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "fail-closed response not observed"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    supervisor.shutdown().await;
}

#[tokio::test]
async fn crash_after_ready_restarts_once_without_replaying_a_turn() {
    let _guard = ENVIRONMENT_LOCK.lock().await;
    let fixture = FixtureEnvironment::new("crash_after_ready");
    tokio::fs::write(&fixture.state, "0")
        .await
        .expect("initialize crash counter");
    let supervisor = CodexSupervisor::new();
    supervisor.start_signal_loop();
    supervisor
        .register_workspace_root("workspace", &fixture.workspace)
        .await
        .expect("register workspace");
    supervisor.set_explicit_binary(Some(fixture_binary())).await;
    assert_eq!(
        supervisor
            .connect(CodexConnectRequest {
                workspace_id: "workspace".to_owned(),
            })
            .await
            .expect("initial connect")
            .health,
        CodexHealth::Ready
    );

    let deadline = tokio::time::Instant::now() + Duration::from_secs(4);
    loop {
        let count = read_state(&fixture.state)
            .await
            .trim()
            .parse::<u32>()
            .unwrap_or(0);
        let health = supervisor.diagnostic().await.health;
        if count >= 2 && health == CodexHealth::Ready {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "restart did not recover"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    supervisor.shutdown().await;
}

#[tokio::test]
#[ignore = "read-only smoke test for the locally installed Codex CLI"]
async fn live_installed_codex_completes_read_only_handshake() {
    let _guard = ENVIRONMENT_LOCK.lock().await;
    assert_eq!(
        std::env::var("CODEX_LIVE_SMOKE").as_deref(),
        Ok("1"),
        "set CODEX_LIVE_SMOKE=1 to acknowledge the local read-only probe"
    );
    let workspace = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("repository root")
        .to_path_buf();
    let supervisor = CodexSupervisor::new();
    supervisor.start_signal_loop();
    supervisor
        .register_workspace_root("live-smoke", workspace)
        .await
        .expect("register live workspace");

    let diagnostic = supervisor
        .connect(CodexConnectRequest {
            workspace_id: "live-smoke".to_owned(),
        })
        .await
        .expect("initialize/account/config/model read-only handshake");
    assert!(diagnostic.generated_by_same_binary);
    assert!(diagnostic.cli_version.is_some());
    assert!(diagnostic.last_successful_handshake_at.is_some());
    assert!(matches!(
        diagnostic.health,
        CodexHealth::Ready
            | CodexHealth::AuthRequired
            | CodexHealth::ModelUnavailable
            | CodexHealth::EffortUnavailable
    ));
    supervisor.shutdown().await;
}
