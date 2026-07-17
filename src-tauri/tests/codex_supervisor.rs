use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use coding_wife_lib::codex::binary::{discover_binary, probe_schema};
use coding_wife_lib::codex::process::spawn_process;
use coding_wife_lib::codex::protocol::{client_notification, initialize_params};
use coding_wife_lib::codex::rpc::{RpcRequestError, RuntimeSignal};
use coding_wife_lib::codex::supervisor::CodexSupervisor;
use coding_wife_lib::codex::types::{
    CapabilityState, ChildState, CodexConnectRequest, CodexFallbackDecisionRequest, CodexHealth,
    CodexPendingResponseRequest, CodexReviewStartRequest, CodexThreadStartRequest,
    CodexTurnInterruptRequest, CodexTurnStartRequest, PendingResponse, ReasoningPreset,
    ReviewTarget,
};
use coding_wife_lib::codex::workspace::{
    AppPrivateBinaryRecord, FolderPicker, PickerFuture, WorkspaceService,
};
use sha2::{Digest, Sha256};
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
        std::fs::create_dir_all(workspace.join(".git")).expect("workspace fixture directory");
        std::fs::write(workspace.join(".git/HEAD"), "ref: refs/heads/main\n")
            .expect("workspace git marker");
        let state = temporary_directory("state");
        std::env::set_var("CODING_WIFE_CODEX_FAKE_MODE", mode);
        std::env::set_var("CODING_WIFE_CODEX_FAKE_STATE", &state);
        Self { workspace, state }
    }
}

struct FixedPicker(PathBuf);

impl FolderPicker for FixedPicker {
    fn pick_folder(&self) -> PickerFuture<'_> {
        let path = self.0.clone();
        Box::pin(async move { Some(path) })
    }
}

fn pending_id(rpc_id: &str, params: &serde_json::Value) -> String {
    let params_hash = hex::encode(Sha256::digest(
        serde_json::to_vec(params).expect("serialize params"),
    ));
    let digest = Sha256::digest(format!("s:{rpc_id}:{params_hash}").as_bytes());
    format!("pending-{}", &hex::encode(digest)[..20])
}

fn contextual_handle(prefix: &str, components: &[&str]) -> String {
    let mut hasher = Sha256::new();
    for component in components {
        hasher.update((component.len() as u64).to_be_bytes());
        hasher.update(component.as_bytes());
    }
    format!("{prefix}-{}", &hex::encode(hasher.finalize())[..20])
}

fn fallback_handles() -> (String, String) {
    let raw_decision = format!(
        "decision-{}",
        &hex::encode(Sha256::digest(b"fixture-decision"))[..20]
    );
    let decision = contextual_handle(
        "decision",
        &[
            &raw_decision,
            "workspace",
            "1",
            "thread-fixture",
            "turn-fixture",
        ],
    );
    let raw_option = format!("option-{}", &hex::encode(Sha256::digest(b"continue"))[..20]);
    let option = contextual_handle("option", &[&decision, &raw_option]);
    (decision, option)
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
async fn native_picker_registers_private_paths_before_connect_and_thread_start() {
    let _guard = ENVIRONMENT_LOCK.lock().await;
    let fixture = FixtureEnvironment::new("default");
    let supervisor = CodexSupervisor::new();
    supervisor.start_signal_loop();
    let service = WorkspaceService::new(
        supervisor.clone(),
        Arc::new(FixedPicker(fixture.workspace.clone())),
    );
    service
        .apply_private_binary(AppPrivateBinaryRecord {
            canonical_path: fixture_binary(),
        })
        .await
        .expect("private binary");
    let registration = service
        .pick_and_register()
        .await
        .expect("pick and register");
    assert!(!serde_json::to_string(&registration)
        .expect("serialize registration")
        .contains(&fixture.workspace.to_string_lossy().to_string()));

    let diagnostic = supervisor
        .connect(CodexConnectRequest {
            workspace_id: registration.workspace_id.clone(),
        })
        .await
        .expect("connect registered workspace");
    assert_eq!(diagnostic.health, CodexHealth::Ready);
    supervisor
        .thread_start(CodexThreadStartRequest {
            workspace_id: registration.workspace_id,
        })
        .await
        .expect("thread start");
    supervisor.shutdown().await;
}

#[tokio::test]
async fn stable_initialize_fallback_omits_experimental_fields_and_blocks_review() {
    let _guard = ENVIRONMENT_LOCK.lock().await;
    let fixture = FixtureEnvironment::new("experimental_rejected");
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
        .expect("stable connect");
    assert!(!diagnostic.experimental_api_accepted);
    assert_eq!(
        diagnostic.capabilities.detached_review,
        CapabilityState::Unavailable
    );
    let thread = supervisor
        .thread_start(CodexThreadStartRequest {
            workspace_id: "workspace".to_owned(),
        })
        .await
        .expect("stable thread");
    let error = supervisor
        .review_start(CodexReviewStartRequest {
            workspace_id: "workspace".to_owned(),
            thread_handle: thread.thread_handle,
            target: ReviewTarget::UncommittedChanges,
        })
        .await
        .expect_err("review must be blocked before wire");
    assert_eq!(error.code, "CODEX-CAPABILITY-UNAVAILABLE");
    let state = read_state(&fixture.state).await;
    assert!(state.contains("experimental_initialize_rejected"));
    assert!(state.contains("stable_initialize_accepted"));
    assert!(state.contains("stable_thread_contract_ok"));
    assert!(!state.contains("stable_thread_contract_invalid"));
    supervisor.shutdown().await;
}

#[tokio::test]
async fn each_thread_policy_mismatch_stops_without_storing_a_handle() {
    let _guard = ENVIRONMENT_LOCK.lock().await;
    for mode in [
        "thread_policy_missing",
        "thread_policy_model",
        "thread_policy_cwd",
        "thread_policy_sandbox",
        "thread_policy_ephemeral",
    ] {
        let fixture = FixtureEnvironment::new(mode);
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
        let error = supervisor
            .thread_start(CodexThreadStartRequest {
                workspace_id: "workspace".to_owned(),
            })
            .await
            .expect_err("policy mismatch");
        assert_eq!(error.code, "CODEX-THREAD-POLICY-MISMATCH", "{mode}");
        let diagnostic = supervisor.diagnostic().await;
        assert_eq!(diagnostic.health, CodexHealth::ProtocolMismatch, "{mode}");
        assert_eq!(diagnostic.child_state, ChildState::Stopped, "{mode}");
        supervisor.shutdown().await;
        drop(fixture);
    }
}

#[tokio::test]
async fn native_rui_round_trips_one_strict_answer() {
    let _guard = ENVIRONMENT_LOCK.lock().await;
    let fixture = FixtureEnvironment::new("native_rui");
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
            client_user_message_id: "message-rui".to_owned(),
            text: "Request a choice.".to_owned(),
            effort: ReasoningPreset::Low,
        })
        .await
        .expect("turn");
    let params = serde_json::json!({
        "threadId": "thread-fixture",
        "turnId": "turn-fixture",
        "itemId": "item-rui",
        "questions": [{
            "id": "choice",
            "header": "Choice",
            "question": "Choose a safe option",
            "options": [
                {"label": "Continue", "description": "Continue safely"},
                {"label": "Stop", "description": "Stop this turn"}
            ]
        }]
    });
    let pending_id = pending_id("server-rui", &params);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    loop {
        match supervisor
            .respond_pending(CodexPendingResponseRequest {
                workspace_id: "workspace".to_owned(),
                pending_id: pending_id.clone(),
                response: PendingResponse::UserInput {
                    answers: std::collections::BTreeMap::from([(
                        "choice".to_owned(),
                        vec!["Continue".to_owned()],
                    )]),
                },
            })
            .await
        {
            Ok(_) => break,
            Err(error) if error.code == "CODEX-PENDING-INVALID" => {
                assert!(
                    tokio::time::Instant::now() < deadline,
                    "pending RUI missing"
                );
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            Err(error) => panic!("unexpected RUI error: {}", error.code),
        }
    }
    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    while !read_state(&fixture.state)
        .await
        .contains("native_rui_answered")
    {
        assert!(
            tokio::time::Instant::now() < deadline,
            "RUI response missing"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    supervisor.shutdown().await;
}

#[tokio::test]
async fn invalid_decision_output_interrupts_while_exact_fallback_does_not() {
    let _guard = ENVIRONMENT_LOCK.lock().await;
    for (mode, interrupted) in [("decision_fallback", false), ("decision_invalid", true)] {
        let fixture = FixtureEnvironment::new(mode);
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
                client_user_message_id: format!("message-{mode}"),
                text: "Produce a decision.".to_owned(),
                effort: ReasoningPreset::Max,
            })
            .await
            .expect("turn");
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert_eq!(
            read_state(&fixture.state)
                .await
                .contains("interrupt_received"),
            interrupted,
            "{mode}"
        );
        supervisor.shutdown().await;
        drop(fixture);
    }
}

#[tokio::test]
async fn fallback_decision_validates_then_starts_exactly_one_structured_continuation() {
    let _guard = ENVIRONMENT_LOCK.lock().await;
    let fixture = FixtureEnvironment::new("decision_fallback");
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
            client_user_message_id: "message-decision".to_owned(),
            text: "Produce a decision.".to_owned(),
            effort: ReasoningPreset::Max,
        })
        .await
        .expect("turn");
    tokio::time::sleep(Duration::from_millis(100)).await;
    let (decision_handle, option_id) = fallback_handles();
    let invalid = supervisor
        .answer_fallback_decision(CodexFallbackDecisionRequest {
            workspace_id: "workspace".to_owned(),
            decision_handle: decision_handle.clone(),
            option_id: "option-invalid".to_owned(),
        })
        .await
        .expect_err("invalid option");
    assert_eq!(invalid.code, "CODEX-DECISION-OPTION-INVALID");

    let request = CodexFallbackDecisionRequest {
        workspace_id: "workspace".to_owned(),
        decision_handle,
        option_id,
    };
    let (first, second) = tokio::join!(
        supervisor.answer_fallback_decision(request.clone()),
        supervisor.answer_fallback_decision(request),
    );
    assert_eq!(usize::from(first.is_ok()) + usize::from(second.is_ok()), 1);
    let state = read_state(&fixture.state).await;
    assert_eq!(state.matches("decision_continuation_ok").count(), 1);
    assert!(!state.contains("decision_continuation_invalid"));
    supervisor.shutdown().await;
}

#[tokio::test]
async fn failed_fallback_continuation_is_terminal_and_never_replayed() {
    let _guard = ENVIRONMENT_LOCK.lock().await;
    let fixture = FixtureEnvironment::new("decision_continuation_crash");
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
            client_user_message_id: "message-crash-decision".to_owned(),
            text: "Produce a decision.".to_owned(),
            effort: ReasoningPreset::Low,
        })
        .await
        .expect("turn");
    tokio::time::sleep(Duration::from_millis(100)).await;
    let (decision_handle, option_id) = fallback_handles();
    let request = CodexFallbackDecisionRequest {
        workspace_id: "workspace".to_owned(),
        decision_handle,
        option_id,
    };
    supervisor
        .answer_fallback_decision(request.clone())
        .await
        .expect_err("continuation process exits before accepting the turn");
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(
        read_state(&fixture.state)
            .await
            .matches("decision_continuation_ok")
            .count(),
        1
    );
    supervisor
        .answer_fallback_decision(request)
        .await
        .expect_err("failed decision claim is terminal");
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(
        read_state(&fixture.state)
            .await
            .matches("decision_continuation_ok")
            .count(),
        1
    );
    supervisor.shutdown().await;
}

#[tokio::test]
async fn failed_reprobe_clears_previous_identity_evidence_and_recovers_fresh() {
    let _guard = ENVIRONMENT_LOCK.lock().await;
    let fixture = FixtureEnvironment::new("default");
    let supervisor = CodexSupervisor::new();
    supervisor.start_signal_loop();
    supervisor
        .register_workspace_root("workspace", &fixture.workspace)
        .await
        .expect("register workspace");
    supervisor.set_explicit_binary(Some(fixture_binary())).await;
    let ready = supervisor
        .connect(CodexConnectRequest {
            workspace_id: "workspace".to_owned(),
        })
        .await
        .expect("ready");
    assert!(ready.binary_hash_prefix.is_some());

    std::env::set_var("CODING_WIFE_CODEX_FAKE_MODE", "schema_malformed");
    supervisor
        .connect(CodexConnectRequest {
            workspace_id: "workspace".to_owned(),
        })
        .await
        .expect_err("schema failure");
    let failed = supervisor.diagnostic().await;
    assert_eq!(failed.health, CodexHealth::SchemaUnsupported);
    assert!(failed.cli_version.is_none());
    assert!(failed.binary_hash_prefix.is_none());
    assert!(failed.schema_fingerprint_prefix.is_none());
    assert!(!failed.generated_by_same_binary);

    std::env::set_var("CODING_WIFE_CODEX_FAKE_MODE", "default");
    let recovered = supervisor
        .connect(CodexConnectRequest {
            workspace_id: "workspace".to_owned(),
        })
        .await
        .expect("fresh recovery");
    assert_eq!(recovered.health, CodexHealth::Ready);
    assert!(recovered.binary_hash_prefix.is_some());
    supervisor.shutdown().await;
}

#[tokio::test]
async fn protocol_violations_use_the_bounded_restart_budget_without_turn_replay() {
    let _guard = ENVIRONMENT_LOCK.lock().await;
    let fixture = FixtureEnvironment::new("protocol_after_ready");
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
        .expect("initial connect");

    let deadline = tokio::time::Instant::now() + Duration::from_secs(8);
    loop {
        let state = read_state(&fixture.state).await;
        let violations = state.matches("protocol_violation_emitted").count();
        let diagnostic = supervisor.diagnostic().await;
        if violations >= 4
            && diagnostic.health == CodexHealth::ProtocolMismatch
            && diagnostic.child_state == ChildState::Stopped
        {
            assert!(!state.contains("turn_contract_ok"));
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "protocol restart budget did not stop: {violations:?} {diagnostic:?}"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
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
