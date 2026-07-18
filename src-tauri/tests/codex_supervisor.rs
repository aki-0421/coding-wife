use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use coding_wife_lib::codex::attachment::{
    AttachmentService, AttachmentSource, AttachmentWorkspaceContext, ResolvedAttachmentSet,
};
use coding_wife_lib::codex::binary::{discover_binary, probe_schema, BinaryInfo};
use coding_wife_lib::codex::process::spawn_process;
use coding_wife_lib::codex::protocol::{client_notification, initialize_params};
use coding_wife_lib::codex::rpc::{RpcRequestError, RuntimeSignal};
use coding_wife_lib::codex::supervisor::CodexSupervisor;
use coding_wife_lib::codex::support::{
    CommitExplanationTrigger, SupportExplainRequest, SupportRuntime, SupportRuntimeError,
    SUPPORT_MAX_SESSION_CAPACITY,
};
use coding_wife_lib::codex::types::{
    BinarySource, CapabilityState, ChildState, CodexConnectRequest, CodexFallbackDecisionRequest,
    CodexHealth, CodexPendingResponseRequest, CodexReviewStartRequest, CodexThreadStartRequest,
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

async fn support_fixture_binary() -> BinaryInfo {
    let mut binary = discover_binary(Some(&fixture_binary()))
        .await
        .expect("fixture binary");
    binary.source = BinarySource::TestFixture;
    binary
}

fn test_supervisor() -> CodexSupervisor {
    CodexSupervisor::with_resource_directory(PathBuf::from(env!("CARGO_MANIFEST_DIR")))
}

fn temporary_directory(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "coding-wife-{label}-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ))
}

fn current_support_run_directories() -> Vec<PathBuf> {
    let process_marker = format!("-{}-", std::process::id());
    let mut directories = std::fs::read_dir(std::env::temp_dir())
        .expect("temporary directory")
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name();
            let name = name.to_str()?;
            (name.starts_with("coding-wife-support-") && name.contains(&process_marker))
                .then(|| entry.path())
        })
        .collect::<Vec<_>>();
    directories.sort();
    directories
}

fn last_recorded_pid(state: &str, prefix: &str) -> u32 {
    state
        .lines()
        .rev()
        .find_map(|line| {
            line.strip_prefix(prefix)?
                .split(':')
                .next()?
                .parse::<u32>()
                .ok()
        })
        .unwrap_or_else(|| panic!("missing {prefix:?} in state: {state}"))
}

fn fixture_process_group_exists(pid: u32) -> bool {
    let Ok(pid) = i32::try_from(pid) else {
        return false;
    };
    // SAFETY: signal zero only probes the process group identified by the fixture pid.
    unsafe { libc::kill(-pid, 0) == 0 }
}

struct FixtureProcessGroupGuard(u32);

impl Drop for FixtureProcessGroupGuard {
    fn drop(&mut self) {
        if let Ok(pid) = i32::try_from(self.0) {
            // SAFETY: the test fixture creates its own process group and the guard owns its pid.
            let _ = unsafe { libc::kill(-pid, libc::SIGKILL) };
        }
    }
}

async fn wait_for_fixture_process_group_exit(pid: u32) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    while fixture_process_group_exists(pid) && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(
        !fixture_process_group_exists(pid),
        "support process group {pid} survived terminal cleanup"
    );
}

struct FixtureEnvironment {
    workspace: PathBuf,
    state: PathBuf,
    app_data: PathBuf,
}

impl FixtureEnvironment {
    fn new(mode: &str) -> Self {
        let workspace = temporary_directory("workspace");
        std::fs::create_dir_all(&workspace).expect("workspace fixture directory");
        let git_init = std::process::Command::new("/usr/bin/git")
            .args(["init", "-q", "-b", "main"])
            .arg(&workspace)
            .status()
            .expect("initialize fixture repository");
        assert!(git_init.success(), "fixture repository must be valid Git");
        let state = temporary_directory("state");
        let app_data = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("repository root")
            .join(".context")
            .join(format!("test-app-data-{}", uuid::Uuid::new_v4()));
        std::env::set_var("CODING_WIFE_CODEX_FAKE_MODE", mode);
        std::env::set_var("CODING_WIFE_CODEX_FAKE_STATE", &state);
        Self {
            workspace,
            state,
            app_data,
        }
    }

    fn auth_source(&self) -> PathBuf {
        std::fs::create_dir_all(&self.app_data).expect("auth fixture directory");
        std::fs::set_permissions(&self.app_data, std::fs::Permissions::from_mode(0o700))
            .expect("auth fixture directory mode");
        let auth = self.app_data.join("auth.json");
        std::fs::write(&auth, br#"{"fixture":"support-auth"}"#).expect("auth fixture");
        std::fs::set_permissions(&auth, std::fs::Permissions::from_mode(0o600))
            .expect("auth fixture mode");
        auth
    }
}

struct SkillResourceFixture {
    root: PathBuf,
}

impl SkillResourceFixture {
    fn new() -> Self {
        let root = temporary_directory("skill-resources");
        let source = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/skills");
        for relative in [
            "manifest.json",
            "coding-wife-commit-work/SKILL.md",
            "coding-wife-commit-work/agents/openai.yaml",
            "coding-wife-explain-commit/SKILL.md",
            "coding-wife-explain-commit/agents/openai.yaml",
        ] {
            let destination = root.join("resources/skills").join(relative);
            std::fs::create_dir_all(destination.parent().expect("skill resource parent"))
                .expect("create skill resource parent");
            std::fs::copy(source.join(relative), destination).expect("copy skill resource");
        }
        Self { root }
    }

    fn skill_document(&self) -> PathBuf {
        self.root
            .join("resources/skills/coding-wife-commit-work/SKILL.md")
    }

    fn explain_skill_document(&self) -> PathBuf {
        self.root
            .join("resources/skills/coding-wife-explain-commit/SKILL.md")
    }

    fn manifest(&self) -> PathBuf {
        self.root.join("resources/skills/manifest.json")
    }
}

impl Drop for SkillResourceFixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
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
        let _ = std::fs::remove_dir_all(&self.app_data);
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

fn support_evidence(locale: &str) -> coding_wife_lib::git_review::types::CommitEvidenceV1 {
    serde_json::from_value(serde_json::json!({
        "schemaVersion": 1,
        "commitId": "commit-opaque-fixture",
        "subject": "feat: add a bounded fixture",
        "body": "Record the verified support boundary.",
        "changes": [{
            "changeKind": "modified",
            "fileCount": 1,
            "additions": 2,
            "deletions": 1,
            "binaryFiles": 0
        }],
        "diffSummary": {
            "filesChanged": 1,
            "additions": 2,
            "deletions": 1,
            "binaryFiles": 0
        },
        "verification": [{
            "evidenceId": "verification-fixture",
            "sourceEventId": "event-fixture",
            "check": "cargo test",
            "result": "passed",
            "durationMs": 12,
            "summary": "The bounded fixture passed."
        }],
        "decisions": [],
        "risks": [],
        "locale": locale,
        "workspaceGeneration": 1,
        "selectionVersion": 1
    }))
    .expect("support evidence fixture")
}

fn support_request(
    request_id: &str,
    evidence: coding_wife_lib::git_review::types::CommitEvidenceV1,
) -> SupportExplainRequest {
    SupportExplainRequest {
        schema_version: 1,
        request_id: request_id.to_owned(),
        workspace_id: "workspace".to_owned(),
        full_commit_sha: "a".repeat(40),
        trigger: CommitExplanationTrigger::AutoVerifiedCommit,
        evidence,
    }
}

fn attachment_snapshot_root(fixture: &FixtureEnvironment) -> PathBuf {
    fixture.app_data.join("codex").join("attachment-snapshots")
}

fn assert_attachment_snapshots_empty(fixture: &FixtureEnvironment) {
    assert_eq!(
        std::fs::read_dir(attachment_snapshot_root(fixture))
            .expect("attachment snapshot root")
            .count(),
        0,
        "private attachment snapshots must be cleaned"
    );
}

struct PreparedAttachmentFixture {
    fixture: FixtureEnvironment,
    supervisor: CodexSupervisor,
    attachments: AttachmentService,
    context: AttachmentWorkspaceContext,
    workspace_id: String,
    thread_handle: String,
    handles: Vec<String>,
    resolved: ResolvedAttachmentSet,
    image: PathBuf,
    notes: PathBuf,
}

async fn prepare_attachment_fixture(
    mode: &str,
    image_bytes: &[u8],
    notes_bytes: &[u8],
) -> PreparedAttachmentFixture {
    let fixture = FixtureEnvironment::new(mode);
    let image = fixture.workspace.join("images/demo.png");
    std::fs::create_dir_all(image.parent().expect("image parent")).expect("image parent");
    std::fs::write(&image, image_bytes).expect("image fixture");
    let notes = fixture.workspace.join("nested/notes.txt");
    std::fs::create_dir_all(notes.parent().expect("notes parent")).expect("notes parent");
    std::fs::write(&notes, notes_bytes).expect("notes fixture");

    let supervisor = test_supervisor();
    supervisor.start_signal_loop();
    let workspace_service = WorkspaceService::new(
        supervisor.clone(),
        Arc::new(FixedPicker(fixture.workspace.clone())),
    );
    workspace_service
        .apply_private_binary(AppPrivateBinaryRecord {
            canonical_path: fixture_binary(),
        })
        .await
        .expect("private binary");
    let registration = workspace_service
        .pick_and_register()
        .await
        .expect("workspace registration");
    supervisor
        .connect(CodexConnectRequest {
            workspace_id: registration.workspace_id.clone(),
        })
        .await
        .expect("connect");
    let thread = supervisor
        .thread_start(CodexThreadStartRequest {
            workspace_id: registration.workspace_id.clone(),
        })
        .await
        .expect("thread");
    let identity = workspace_service
        .trusted_identity(&registration.workspace_id)
        .await
        .expect("trusted identity");
    let context = AttachmentWorkspaceContext {
        workspace_id: registration.workspace_id.clone(),
        generation: thread.generation,
        canonical_root: identity.canonical_root,
        root_device: identity.root_device,
        root_inode: identity.root_inode,
    };
    let attachments = AttachmentService::production(&fixture.app_data).expect("attachment service");
    let registered = attachments
        .register_paths(
            context.clone(),
            AttachmentSource::Drop,
            vec![
                std::fs::canonicalize(&image)
                    .expect("canonical image")
                    .to_string_lossy()
                    .into_owned(),
                std::fs::canonicalize(&notes)
                    .expect("canonical notes")
                    .to_string_lossy()
                    .into_owned(),
            ],
            vec![],
        )
        .await
        .expect("attachment registration");
    assert_eq!(registered.items.len(), 2, "{:?}", registered.rejections);
    let handles = registered
        .items
        .iter()
        .map(|item| item.handle.clone())
        .collect::<Vec<_>>();
    let resolved = attachments
        .resolve_for_turn(context.clone(), &handles)
        .await
        .expect("resolve attachments");

    PreparedAttachmentFixture {
        fixture,
        supervisor,
        attachments,
        context,
        workspace_id: registration.workspace_id,
        thread_handle: thread.thread_handle,
        handles,
        resolved,
        image,
        notes,
    }
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
    let supervisor = test_supervisor();
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
            attachment_handles: vec![],
        })
        .await
        .expect("turn start");
    let audit = supervisor
        .main_skill_injection_audit(&turn.turn_handle)
        .await
        .expect("main skill audit");
    let encoded_audit = serde_json::to_string(&audit).expect("serialize skill audit");
    assert_eq!(audit.name, "coding-wife-commit-work");
    assert_eq!(audit.version, "1.1.0");
    assert!(audit.content_digest.starts_with("sha256:"));
    assert!(!encoded_audit.contains("SKILL.md"));
    assert!(!encoded_audit.contains("resources"));
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
    assert_eq!(state.matches("commit_skill_exactly_once_ok").count(), 1);
    assert_eq!(state.matches("commit_skill_audit:").count(), 1);
    assert!(!state.contains("commit_skill_exactly_once_invalid"));
    assert!(!state.contains("SKILL.md"));
    assert!(state.contains("interrupt_received"));
    supervisor.shutdown().await;
}

#[tokio::test]
async fn dedicated_support_runtime_proves_authority_and_injects_only_the_explain_skill() {
    let _guard = ENVIRONMENT_LOCK.lock().await;
    let fixture = FixtureEnvironment::new("default");
    let binary = support_fixture_binary().await;
    let schema = probe_schema(&binary).await.expect("fixture schema");
    let auth = fixture.auth_source();
    let runtime_result = SupportRuntime::construct(
        &binary,
        &schema,
        Path::new(env!("CARGO_MANIFEST_DIR")),
        Some(&auth),
    )
    .await;
    let runtime = match runtime_result {
        Ok(runtime) => runtime,
        Err(error) => panic!(
            "isolated support runtime: {error:?}; state={}",
            read_state(&fixture.state).await
        ),
    };

    assert_eq!(runtime.audit().capacity, SUPPORT_MAX_SESSION_CAPACITY);
    assert_eq!(runtime.audit().skill_name, "coding-wife-explain-commit");
    assert_eq!(runtime.audit().skill_version, "1.1.0");
    assert_eq!(
        runtime.audit().execution_class,
        coding_wife_lib::codex::types::TurnExecutionClass::Support
    );
    assert!(runtime.audit().malicious_canary_passed);
    let result = runtime
        .explain_commit(support_request("support-request-1", support_evidence("ja")))
        .await
        .expect("strict support result");
    assert_eq!(result.explanation.locale, "ja");
    assert_eq!(result.usage.total_tokens, 30);
    runtime.shutdown().await.expect("support cleanup");

    let state = read_state(&fixture.state).await;
    assert!(state.contains("support_sandbox_denied"));
    assert_eq!(state.matches("support_thread_contract_ok").count(), 2);
    assert_eq!(state.matches("support_skill_exactly_once_ok").count(), 3);
    assert_eq!(
        state
            .matches("support_probe_production_envelope_ok")
            .count(),
        1
    );
    assert_eq!(state.matches("support_auth_bridge_ok").count(), 1);
    assert_eq!(state.matches("support_probe_plan_policy_event").count(), 1);
    assert!(!state.contains("support_skill_exactly_once_invalid"));
    assert!(!state.contains("commit_skill_exactly_once_ok"));
    assert!(!state.contains("coding-wife-commit-work"));
}

#[tokio::test]
async fn support_uses_private_skill_snapshot_after_verified_source_mutation() {
    let _guard = ENVIRONMENT_LOCK.lock().await;
    let fixture = FixtureEnvironment::new("default");
    let resources = SkillResourceFixture::new();
    let binary = support_fixture_binary().await;
    let schema = probe_schema(&binary).await.expect("fixture schema");
    let auth = fixture.auth_source();
    let runtime = SupportRuntime::construct(&binary, &schema, &resources.root, Some(&auth))
        .await
        .expect("support runtime with private skill snapshot");

    std::fs::OpenOptions::new()
        .append(true)
        .open(resources.explain_skill_document())
        .and_then(|mut file| {
            use std::io::Write;
            file.write_all(b"\nsource mutated after construction\n")
        })
        .expect("mutate verified source after construction");

    let result = runtime
        .explain_commit(support_request(
            "support-private-snapshot",
            support_evidence("ja"),
        ))
        .await
        .expect("private snapshot remains immutable");
    assert_eq!(result.explanation.locale, "ja");
    runtime.shutdown().await.expect("support cleanup");

    let state = read_state(&fixture.state).await;
    assert_eq!(state.matches("support_skill_exactly_once_ok").count(), 3);
    assert!(!state.contains("support_skill_exactly_once_invalid"));
    let fake = std::fs::read_to_string(fixture_binary()).expect("fake app-server fixture");
    assert!(!fake.contains("def update_plan_tool"));
    assert!(!fake.contains("send_probe_wire_requests"));
}

#[tokio::test]
#[ignore = "requires the pinned local Codex release and a configured local account"]
async fn real_support_release_probe_uses_the_production_turn_envelope() {
    let _guard = ENVIRONMENT_LOCK.lock().await;
    let binary = discover_binary(Some(Path::new("/opt/homebrew/bin/codex")))
        .await
        .expect("installed Codex binary");
    let schema = probe_schema(&binary).await.expect("installed Codex schema");
    let repeated_schema = probe_schema(&binary)
        .await
        .expect("repeated installed Codex schema");
    assert_eq!(schema.fingerprint, repeated_schema.fingerprint);
    assert_eq!(schema.capabilities, repeated_schema.capabilities);
    assert!(schema.generated_by_same_binary);
    let before = current_support_run_directories();
    let runtime = SupportRuntime::construct(
        &binary,
        &schema,
        Path::new(env!("CARGO_MANIFEST_DIR")),
        None,
    )
    .await
    .expect("production-equivalent release probe");
    assert_eq!(runtime.audit().skill_name, "coding-wife-explain-commit");
    runtime.shutdown().await.expect("real probe cleanup");
    assert_eq!(current_support_run_directories(), before);
}

#[tokio::test]
async fn failed_support_release_probe_leaves_no_process_or_private_directory() {
    let _guard = ENVIRONMENT_LOCK.lock().await;
    let fixture = FixtureEnvironment::new("support_probe_policy_completed");
    let before = current_support_run_directories();
    let binary = support_fixture_binary().await;
    let schema = probe_schema(&binary).await.expect("fixture schema");

    let error = match SupportRuntime::construct(
        &binary,
        &schema,
        Path::new(env!("CARGO_MANIFEST_DIR")),
        None,
    )
    .await
    {
        Ok(runtime) => {
            runtime
                .shutdown()
                .await
                .expect("unexpected runtime cleanup");
            panic!("wrong policy terminal must fail the release probe");
        }
        Err(error) => error,
    };
    assert_eq!(error, SupportRuntimeError::IsolationProbe);
    assert_eq!(current_support_run_directories(), before);

    let state = read_state(&fixture.state).await;
    let process_id = state
        .lines()
        .find_map(|line| line.strip_prefix("support_process_started:"))
        .expect("support process start audit");
    assert!(state.contains(&format!("support_process_exited:{process_id}")));
    assert!(state.contains("support_probe_policy_wrong_terminal"));
    assert!(!state.contains("support_auth_bridge_ok"));
    assert!(!state.contains("commit_skill_exactly_once_ok"));
    let process_exists = std::process::Command::new("/bin/kill")
        .args(["-0", process_id])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .expect("probe process existence check")
        .success();
    assert!(!process_exists, "failed probe process survived cleanup");
}

#[tokio::test]
async fn missing_or_tampered_explain_skill_blocks_support_before_wire() {
    let _guard = ENVIRONMENT_LOCK.lock().await;
    for case in [
        "missing",
        "skill_tampered",
        "manifest_tampered",
        "permissive",
    ] {
        let fixture = FixtureEnvironment::new("default");
        let resources = SkillResourceFixture::new();
        match case {
            "missing" => {
                std::fs::remove_file(resources.explain_skill_document())
                    .expect("remove explain skill fixture");
            }
            "skill_tampered" => {
                std::fs::OpenOptions::new()
                    .append(true)
                    .open(resources.explain_skill_document())
                    .and_then(|mut file| {
                        use std::io::Write;
                        file.write_all(b"\ntampered\n")
                    })
                    .expect("tamper explain skill fixture");
            }
            "manifest_tampered" => {
                let manifest =
                    std::fs::read_to_string(resources.manifest()).expect("read skill manifest");
                std::fs::write(
                    resources.manifest(),
                    manifest.replace("\"schemaVersion\": 1", "\"schemaVersion\": 2"),
                )
                .expect("tamper skill manifest");
            }
            "permissive" => {
                std::fs::set_permissions(
                    resources.explain_skill_document(),
                    std::fs::Permissions::from_mode(0o666),
                )
                .expect("make explain skill writable");
            }
            _ => unreachable!(),
        }

        let binary = support_fixture_binary().await;
        let schema = probe_schema(&binary).await.expect("fixture schema");
        let auth = fixture.auth_source();
        let error =
            match SupportRuntime::construct(&binary, &schema, &resources.root, Some(&auth)).await {
                Ok(runtime) => {
                    runtime
                        .shutdown()
                        .await
                        .expect("unexpected runtime cleanup");
                    panic!("{case} explain skill must not construct a support runtime");
                }
                Err(error) => error,
            };
        assert_eq!(error, SupportRuntimeError::Skill, "{case}");
        assert_eq!(error.code(), "CODEX-SUPPORT-SKILL-INVALID", "{case}");
        let state = read_state(&fixture.state).await;
        assert!(!state.contains("support_"), "{case}: {state}");
    }
}

#[tokio::test]
async fn unsafe_auth_sources_keep_support_capacity_at_zero() {
    let _guard = ENVIRONMENT_LOCK.lock().await;
    for case in ["permissive", "symlink"] {
        let fixture = FixtureEnvironment::new("default");
        let binary = support_fixture_binary().await;
        let schema = probe_schema(&binary).await.expect("fixture schema");
        let auth = fixture.auth_source();
        match case {
            "permissive" => {
                std::fs::set_permissions(&auth, std::fs::Permissions::from_mode(0o644))
                    .expect("make auth source permissive");
            }
            "symlink" => {
                let target = fixture.app_data.join("auth-target.json");
                std::fs::rename(&auth, &target).expect("move auth target");
                std::os::unix::fs::symlink(&target, &auth).expect("symlink auth source");
            }
            _ => unreachable!(),
        }

        let error = match SupportRuntime::construct(
            &binary,
            &schema,
            Path::new(env!("CARGO_MANIFEST_DIR")),
            Some(&auth),
        )
        .await
        {
            Ok(runtime) => {
                runtime
                    .shutdown()
                    .await
                    .expect("unexpected runtime cleanup");
                panic!("{case} auth source must not construct a support runtime");
            }
            Err(error) => error,
        };
        assert_eq!(error, SupportRuntimeError::AuthBridge, "{case}");
        assert_eq!(
            error.code(),
            "CODEX-SUPPORT-AUTH-BRIDGE-UNAVAILABLE",
            "{case}"
        );
        let state = read_state(&fixture.state).await;
        assert!(
            state.contains("support_probe_production_envelope_ok"),
            "{case}: {state}"
        );
        assert!(!state.contains("support_auth_bridge_ok"), "{case}: {state}");
    }
}

#[tokio::test]
async fn private_evidence_is_rejected_before_the_explanation_wire() {
    let _guard = ENVIRONMENT_LOCK.lock().await;
    for case in ["relative_path", "absolute_path", "secret"] {
        let fixture = FixtureEnvironment::new("default");
        let binary = support_fixture_binary().await;
        let schema = probe_schema(&binary).await.expect("fixture schema");
        let auth = fixture.auth_source();
        let runtime = SupportRuntime::construct(
            &binary,
            &schema,
            Path::new(env!("CARGO_MANIFEST_DIR")),
            Some(&auth),
        )
        .await
        .expect("isolated support runtime");
        let before = read_state(&fixture.state).await;
        let mut evidence = support_evidence("ja");
        match case {
            "relative_path" => evidence.subject = "src/private.rs".to_owned(),
            "absolute_path" => evidence.body = "/Users/example/private/repository".to_owned(),
            "secret" => {
                evidence.verification[0].summary =
                    "ghp_abcdefghijklmnopqrstuvwxyz1234567890abcd".to_owned();
            }
            _ => unreachable!(),
        }
        let error = runtime
            .explain_commit(support_request(&format!("support-{case}"), evidence))
            .await
            .expect_err("private evidence must be rejected");
        assert_eq!(error, SupportRuntimeError::EvidenceRedaction, "{case}");
        assert_eq!(error.code(), "CODEX-SUPPORT-EVIDENCE-REDACTION", "{case}");
        let after = read_state(&fixture.state).await;
        assert_eq!(
            before.matches("support_skill_exactly_once_ok").count(),
            after.matches("support_skill_exactly_once_ok").count(),
            "{case}: evidence reached turn/start"
        );
        assert_eq!(
            before.matches("turn_contract_ok").count(),
            after.matches("turn_contract_ok").count(),
            "{case}: evidence reached the wire"
        );
        runtime.shutdown().await.expect("support cleanup");
    }
}

#[tokio::test]
async fn invalid_support_input_does_not_consume_the_single_use_runtime() {
    let _guard = ENVIRONMENT_LOCK.lock().await;
    let fixture = FixtureEnvironment::new("default");
    let binary = support_fixture_binary().await;
    let schema = probe_schema(&binary).await.expect("fixture schema");
    let auth = fixture.auth_source();
    let runtime = SupportRuntime::construct(
        &binary,
        &schema,
        Path::new(env!("CARGO_MANIFEST_DIR")),
        Some(&auth),
    )
    .await
    .expect("isolated support runtime");
    let mut invalid = support_evidence("ja");
    invalid.subject = "src/private.rs".to_owned();

    assert_eq!(
        runtime
            .explain_commit(support_request("support-invalid-first", invalid))
            .await,
        Err(SupportRuntimeError::EvidenceRedaction)
    );
    let result = runtime
        .explain_commit(support_request(
            "support-valid-second",
            support_evidence("ja"),
        ))
        .await
        .expect("valid request may claim the single use");

    assert_eq!(result.explanation.locale, "ja");
    runtime
        .shutdown()
        .await
        .expect("idempotent support cleanup");
    let state = read_state(&fixture.state).await;
    assert_eq!(state.matches("support_skill_exactly_once_ok").count(), 3);
}

#[tokio::test]
async fn invalid_support_output_and_plan_events_publish_no_result() {
    let _guard = ENVIRONMENT_LOCK.lock().await;
    for (mode, expected) in [
        ("support_invalid_output", SupportRuntimeError::Output),
        ("support_plan_call", SupportRuntimeError::Policy),
    ] {
        let fixture = FixtureEnvironment::new(mode);
        let binary = support_fixture_binary().await;
        let schema = probe_schema(&binary).await.expect("fixture schema");
        let auth = fixture.auth_source();
        let runtime = SupportRuntime::construct(
            &binary,
            &schema,
            Path::new(env!("CARGO_MANIFEST_DIR")),
            Some(&auth),
        )
        .await
        .expect("isolated support runtime");
        let error = runtime
            .explain_commit(support_request(mode, support_evidence("ja")))
            .await
            .expect_err("invalid support response must not publish a result");
        assert_eq!(error, expected, "{mode}");
        runtime.shutdown().await.expect("support cleanup");
        let state = read_state(&fixture.state).await;
        assert_eq!(state.matches("support_skill_exactly_once_ok").count(), 3);
        if mode == "support_plan_call" {
            assert!(state.contains("interrupt_received"), "{state}");
        }
    }
}

#[tokio::test]
async fn support_stream_budget_accepts_exact_frame_delta_and_reasoning_boundaries() {
    let _guard = ENVIRONMENT_LOCK.lock().await;
    for mode in [
        "support_frame_exact",
        "support_delta_exact",
        "support_reasoning_exact",
    ] {
        let fixture = FixtureEnvironment::new(mode);
        let binary = support_fixture_binary().await;
        let schema = probe_schema(&binary).await.expect("fixture schema");
        let auth = fixture.auth_source();
        let runtime = SupportRuntime::construct(
            &binary,
            &schema,
            Path::new(env!("CARGO_MANIFEST_DIR")),
            Some(&auth),
        )
        .await
        .expect("isolated support runtime");
        let result = runtime
            .explain_commit(support_request(mode, support_evidence("ja")))
            .await
            .unwrap_or_else(|error| panic!("{mode} exact boundary failed: {error:?}"));
        assert_eq!(result.explanation.locale, "ja", "{mode}");
        runtime.shutdown().await.expect("support cleanup");
    }
}

#[tokio::test]
async fn support_stream_budget_rejects_one_over_before_a_valid_terminal_can_publish() {
    let _guard = ENVIRONMENT_LOCK.lock().await;
    for (mode, expected) in [
        ("support_frame_over", SupportRuntimeError::Protocol),
        ("support_delta_over_then_valid", SupportRuntimeError::Output),
        ("support_reasoning_over", SupportRuntimeError::Output),
    ] {
        let fixture = FixtureEnvironment::new(mode);
        let binary = support_fixture_binary().await;
        let schema = probe_schema(&binary).await.expect("fixture schema");
        let auth = fixture.auth_source();
        let runtime = SupportRuntime::construct(
            &binary,
            &schema,
            Path::new(env!("CARGO_MANIFEST_DIR")),
            Some(&auth),
        )
        .await
        .expect("isolated support runtime");
        let error = runtime
            .explain_commit(support_request(mode, support_evidence("ja")))
            .await
            .expect_err("over-boundary stream must publish no result");
        assert_eq!(error, expected, "{mode}");
        runtime.shutdown().await.expect("support cleanup");
    }
}

#[tokio::test]
async fn malformed_support_turn_start_terminates_process_and_private_root_before_return() {
    let _guard = ENVIRONMENT_LOCK.lock().await;
    let before = current_support_run_directories();
    let fixture = FixtureEnvironment::new("support_missing_turn_id");
    let binary = support_fixture_binary().await;
    let schema = probe_schema(&binary).await.expect("fixture schema");
    let auth = fixture.auth_source();
    let runtime = SupportRuntime::construct(
        &binary,
        &schema,
        Path::new(env!("CARGO_MANIFEST_DIR")),
        Some(&auth),
    )
    .await
    .expect("isolated support runtime");
    let state = read_state(&fixture.state).await;
    let pid = last_recorded_pid(&state, "support_process_started:");
    let _process_guard = FixtureProcessGroupGuard(pid);

    let error = runtime
        .explain_commit(support_request(
            "support-missing-turn-id",
            support_evidence("ja"),
        ))
        .await
        .expect_err("missing turn id must be terminal");

    assert_eq!(error, SupportRuntimeError::Protocol);
    wait_for_fixture_process_group_exit(pid).await;
    assert_eq!(current_support_run_directories(), before);
    runtime
        .shutdown()
        .await
        .expect("idempotent support cleanup");
}

#[tokio::test]
async fn ignored_interrupt_forces_grandchild_group_exit_before_canceled_result() {
    let _guard = ENVIRONMENT_LOCK.lock().await;
    let before = current_support_run_directories();
    let fixture = FixtureEnvironment::new("support_ignore_interrupt_grandchild");
    let binary = support_fixture_binary().await;
    let schema = probe_schema(&binary).await.expect("fixture schema");
    let auth = fixture.auth_source();
    let runtime = Arc::new(
        SupportRuntime::construct(
            &binary,
            &schema,
            Path::new(env!("CARGO_MANIFEST_DIR")),
            Some(&auth),
        )
        .await
        .expect("isolated support runtime"),
    );
    let task_runtime = runtime.clone();
    let explanation = tokio::spawn(async move {
        task_runtime
            .explain_commit(support_request(
                "support-ignore-interrupt",
                support_evidence("ja"),
            ))
            .await
    });
    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    let pid = loop {
        let state = read_state(&fixture.state).await;
        if state.contains("support_grandchild_started:")
            && state.matches("support_skill_exactly_once_ok").count() == 3
        {
            break last_recorded_pid(&state, "support_process_started:");
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "support grandchild did not start: {state}"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    };
    let _process_guard = FixtureProcessGroupGuard(pid);
    let canceled_at = tokio::time::Instant::now();

    assert!(runtime.cancel().await.expect("forced support cancellation"));
    let error = explanation
        .await
        .expect("support explanation join")
        .expect_err("canceled support turn must publish no result");

    assert_eq!(error, SupportRuntimeError::Canceled);
    assert!(canceled_at.elapsed() < Duration::from_secs(5));
    wait_for_fixture_process_group_exit(pid).await;
    assert_eq!(current_support_run_directories(), before);
    let runtime = Arc::try_unwrap(runtime).unwrap_or_else(|_| panic!("unexpected runtime owner"));
    runtime
        .shutdown()
        .await
        .expect("idempotent support cleanup");
}

#[tokio::test]
async fn support_timeout_terminates_process_and_private_root_before_return() {
    let _guard = ENVIRONMENT_LOCK.lock().await;
    let before = current_support_run_directories();
    let fixture = FixtureEnvironment::new("support_timeout");
    let binary = support_fixture_binary().await;
    let schema = probe_schema(&binary).await.expect("fixture schema");
    let auth = fixture.auth_source();
    let runtime = SupportRuntime::construct(
        &binary,
        &schema,
        Path::new(env!("CARGO_MANIFEST_DIR")),
        Some(&auth),
    )
    .await
    .expect("isolated support runtime");
    let state = read_state(&fixture.state).await;
    let pid = last_recorded_pid(&state, "support_process_started:");
    let _process_guard = FixtureProcessGroupGuard(pid);

    let error = runtime
        .explain_commit(support_request("support-timeout", support_evidence("ja")))
        .await
        .expect_err("timed out support turn must publish no result");

    assert_eq!(error, SupportRuntimeError::Timeout);
    wait_for_fixture_process_group_exit(pid).await;
    assert_eq!(current_support_run_directories(), before);
    runtime
        .shutdown()
        .await
        .expect("idempotent support cleanup");
}

#[tokio::test]
async fn dropping_support_runtime_kills_grandchild_and_removes_private_root() {
    let _guard = ENVIRONMENT_LOCK.lock().await;
    let before = current_support_run_directories();
    let fixture = FixtureEnvironment::new("support_drop_grandchild");
    let binary = support_fixture_binary().await;
    let schema = probe_schema(&binary).await.expect("fixture schema");
    let auth = fixture.auth_source();
    let runtime = SupportRuntime::construct(
        &binary,
        &schema,
        Path::new(env!("CARGO_MANIFEST_DIR")),
        Some(&auth),
    )
    .await
    .expect("isolated support runtime");
    let state = read_state(&fixture.state).await;
    let pid = last_recorded_pid(&state, "support_process_started:");
    let _process_guard = FixtureProcessGroupGuard(pid);
    assert!(fixture_process_group_exists(pid));

    drop(runtime);

    wait_for_fixture_process_group_exit(pid).await;
    assert_eq!(current_support_run_directories(), before);
}

#[tokio::test]
async fn support_cancellation_interrupts_the_turn_and_discards_output() {
    let _guard = ENVIRONMENT_LOCK.lock().await;
    let fixture = FixtureEnvironment::new("support_slow");
    let binary = support_fixture_binary().await;
    let schema = probe_schema(&binary).await.expect("fixture schema");
    let auth = fixture.auth_source();
    let runtime = Arc::new(
        SupportRuntime::construct(
            &binary,
            &schema,
            Path::new(env!("CARGO_MANIFEST_DIR")),
            Some(&auth),
        )
        .await
        .expect("isolated support runtime"),
    );
    let task_runtime = runtime.clone();
    let explanation = tokio::spawn(async move {
        task_runtime
            .explain_commit(support_request("support-cancel", support_evidence("ja")))
            .await
    });

    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    loop {
        let state = read_state(&fixture.state).await;
        if state.matches("support_skill_exactly_once_ok").count() == 3 {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "support turn did not start: {state}"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(runtime.cancel().await.expect("cancel support turn"));
    let error = explanation
        .await
        .expect("support explanation join")
        .expect_err("canceled support turn must publish no result");
    assert_eq!(error, SupportRuntimeError::Canceled);

    let runtime = match Arc::try_unwrap(runtime) {
        Ok(runtime) => runtime,
        Err(_) => panic!("support runtime still has an unexpected owner"),
    };
    runtime.shutdown().await.expect("support cleanup");
    let state = read_state(&fixture.state).await;
    assert!(state.contains("interrupt_received"), "{state}");
}

#[tokio::test]
async fn missing_or_tampered_main_skill_blocks_turn_before_wire() {
    let _guard = ENVIRONMENT_LOCK.lock().await;
    for case in ["missing", "skill_tampered", "manifest_tampered"] {
        let fixture = FixtureEnvironment::new("default");
        let resources = SkillResourceFixture::new();
        match case {
            "missing" => {
                std::fs::remove_file(resources.skill_document()).expect("remove skill fixture");
            }
            "skill_tampered" => {
                std::fs::OpenOptions::new()
                    .append(true)
                    .open(resources.skill_document())
                    .and_then(|mut file| {
                        use std::io::Write;
                        file.write_all(b"\ntampered\n")
                    })
                    .expect("tamper skill fixture");
            }
            "manifest_tampered" => {
                let manifest =
                    std::fs::read_to_string(resources.manifest()).expect("read manifest fixture");
                std::fs::write(
                    resources.manifest(),
                    manifest.replace("\"schemaVersion\": 1", "\"schemaVersion\": 2"),
                )
                .expect("tamper manifest fixture");
            }
            _ => unreachable!(),
        }

        let supervisor = CodexSupervisor::with_resource_directory(resources.root.clone());
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
            .expect("connect fixture");
        let thread = supervisor
            .thread_start(CodexThreadStartRequest {
                workspace_id: "workspace".to_owned(),
            })
            .await
            .expect("thread start");
        let error = supervisor
            .turn_start(CodexTurnStartRequest {
                workspace_id: "workspace".to_owned(),
                thread_handle: thread.thread_handle,
                client_user_message_id: format!("message-{case}"),
                text: "Do not send this turn.".to_owned(),
                effort: ReasoningPreset::Low,
                attachment_handles: vec![],
            })
            .await
            .expect_err("invalid skill must block the turn");
        let expected = if case == "missing" {
            "CODEX-COMMIT-SKILL-MISSING"
        } else {
            "CODEX-COMMIT-SKILL-TAMPERED"
        };
        assert_eq!(error.code, expected, "{case}");
        let encoded_error = serde_json::to_string(&error).expect("serialize safe skill error");
        assert!(!encoded_error.contains("SKILL.md"), "{case}");
        assert!(!encoded_error.contains(&resources.root.to_string_lossy().to_string()));
        let state = read_state(&fixture.state).await;
        assert!(!state.contains("turn_contract_"), "{case}");
        assert!(!state.contains("commit_skill_"), "{case}");
        supervisor.shutdown().await;
        drop(resources);
        drop(fixture);
    }
}

#[tokio::test]
async fn native_picker_registers_private_paths_before_connect_and_thread_start() {
    let _guard = ENVIRONMENT_LOCK.lock().await;
    let fixture = FixtureEnvironment::new("default");
    let supervisor = test_supervisor();
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
async fn validated_opaque_attachments_reach_the_fake_server_as_local_image_and_mention() {
    let _guard = ENVIRONMENT_LOCK.lock().await;
    let fixture = FixtureEnvironment::new("attachments");
    let image = fixture.workspace.join("images/demo.png");
    std::fs::create_dir_all(image.parent().expect("image parent")).expect("image parent");
    std::fs::write(&image, b"\x89PNG\r\n\x1a\nfixture").expect("image fixture");
    let notes = fixture.workspace.join("notes.txt");
    std::fs::write(&notes, b"bounded notes").expect("notes fixture");

    let supervisor = test_supervisor();
    supervisor.start_signal_loop();
    let workspace_service = WorkspaceService::new(
        supervisor.clone(),
        Arc::new(FixedPicker(fixture.workspace.clone())),
    );
    workspace_service
        .apply_private_binary(AppPrivateBinaryRecord {
            canonical_path: fixture_binary(),
        })
        .await
        .expect("private binary");
    let registration = workspace_service
        .pick_and_register()
        .await
        .expect("workspace registration");
    supervisor
        .connect(CodexConnectRequest {
            workspace_id: registration.workspace_id.clone(),
        })
        .await
        .expect("connect");
    let thread = supervisor
        .thread_start(CodexThreadStartRequest {
            workspace_id: registration.workspace_id.clone(),
        })
        .await
        .expect("thread");
    let identity = workspace_service
        .trusted_identity(&registration.workspace_id)
        .await
        .expect("trusted identity");
    let context = AttachmentWorkspaceContext {
        workspace_id: registration.workspace_id.clone(),
        generation: thread.generation,
        canonical_root: identity.canonical_root,
        root_device: identity.root_device,
        root_inode: identity.root_inode,
    };
    let attachments = AttachmentService::production(&fixture.app_data).expect("attachment service");
    let registered = attachments
        .register_paths(
            context.clone(),
            AttachmentSource::Drop,
            vec![
                std::fs::canonicalize(&image)
                    .expect("canonical image")
                    .to_string_lossy()
                    .into_owned(),
                std::fs::canonicalize(&notes)
                    .expect("canonical notes")
                    .to_string_lossy()
                    .into_owned(),
            ],
            vec![],
        )
        .await
        .expect("attachment registration");
    assert_eq!(registered.items.len(), 2);
    assert!(!serde_json::to_string(&registered)
        .expect("public attachment response")
        .contains(&fixture.workspace.to_string_lossy().to_string()));
    let handles = registered
        .items
        .iter()
        .map(|item| item.handle.clone())
        .collect::<Vec<_>>();
    let resolved = attachments
        .resolve_for_turn(context.clone(), &handles)
        .await
        .expect("resolve attachments");
    let turn = supervisor
        .turn_start_resolved(
            CodexTurnStartRequest {
                workspace_id: registration.workspace_id.clone(),
                thread_handle: thread.thread_handle.clone(),
                client_user_message_id: "message-attachments".to_owned(),
                text: String::new(),
                effort: ReasoningPreset::Low,
                attachment_handles: handles.clone(),
            },
            resolved,
            context.generation,
        )
        .await
        .expect("attachment turn");
    assert_attachment_snapshots_empty(&fixture);
    attachments.consume(&context, &handles).await;
    supervisor
        .turn_interrupt(CodexTurnInterruptRequest {
            workspace_id: registration.workspace_id,
            thread_handle: thread.thread_handle,
            turn_handle: turn.turn_handle,
        })
        .await
        .expect("attachment turn interrupt");
    assert_attachment_snapshots_empty(&fixture);

    let state = read_state(&fixture.state).await;
    assert!(state.contains("attachment_exact_bytes_ok"));
    assert!(!state.contains("attachment_exact_bytes_invalid"));
    assert!(!state.contains(&fixture.workspace.to_string_lossy().to_string()));
    assert!(!state.contains(&fixture.app_data.to_string_lossy().to_string()));
    supervisor.shutdown().await;
}

#[tokio::test]
async fn snapshot_bytes_survive_leaf_and_ancestor_namespace_replacement() {
    let _guard = ENVIRONMENT_LOCK.lock().await;
    let PreparedAttachmentFixture {
        fixture,
        supervisor,
        attachments,
        context,
        workspace_id,
        thread_handle,
        handles,
        resolved,
        image,
        notes,
    } = prepare_attachment_fixture(
        "attachments_race",
        b"\x89PNG\r\n\x1a\nvalidated-image",
        b"validated-notes",
    )
    .await;

    let validated_image = image.with_extension("validated");
    std::fs::rename(&image, &validated_image).expect("replace image leaf namespace");
    std::fs::write(&image, b"\x89PNG\r\n\x1a\nunvalidated-image").expect("replacement image");
    let notes_parent = notes.parent().expect("notes parent").to_path_buf();
    let validated_parent = notes_parent.with_extension("validated");
    std::fs::rename(&notes_parent, &validated_parent).expect("replace notes ancestor namespace");
    std::fs::create_dir(&notes_parent).expect("replacement notes ancestor");
    std::fs::write(notes_parent.join("notes.txt"), b"unvalidated-notes")
        .expect("replacement notes");

    supervisor
        .turn_start_resolved(
            CodexTurnStartRequest {
                workspace_id,
                thread_handle,
                client_user_message_id: "message-attachment-race".to_owned(),
                text: String::new(),
                effort: ReasoningPreset::Low,
                attachment_handles: handles.clone(),
            },
            resolved,
            context.generation,
        )
        .await
        .expect("snapshot-backed attachment turn");
    attachments.consume(&context, &handles).await;
    assert_attachment_snapshots_empty(&fixture);
    let state = read_state(&fixture.state).await;
    assert!(state.contains("attachment_exact_bytes_ok"));
    assert!(!state.contains("attachment_exact_bytes_invalid"));
    assert!(!state.contains("unvalidated"));
    assert!(!state.contains(&fixture.workspace.to_string_lossy().to_string()));
    assert!(!state.contains(&fixture.app_data.to_string_lossy().to_string()));
    supervisor.shutdown().await;
}

#[tokio::test]
async fn snapshot_cleanup_covers_rejection_terminal_before_response_and_child_crash() {
    let _guard = ENVIRONMENT_LOCK.lock().await;
    for mode in [
        "attachments_rejected",
        "attachments_terminal_first",
        "attachments_crash",
    ] {
        let PreparedAttachmentFixture {
            fixture,
            supervisor,
            attachments,
            context,
            workspace_id,
            thread_handle,
            handles,
            resolved,
            ..
        } = prepare_attachment_fixture(mode, b"\x89PNG\r\n\x1a\nfixture", b"bounded notes").await;
        let result = supervisor
            .turn_start_resolved(
                CodexTurnStartRequest {
                    workspace_id,
                    thread_handle,
                    client_user_message_id: format!("message-{mode}"),
                    text: String::new(),
                    effort: ReasoningPreset::Low,
                    attachment_handles: handles.clone(),
                },
                resolved,
                context.generation,
            )
            .await;
        assert_attachment_snapshots_empty(&fixture);
        let state = read_state(&fixture.state).await;
        assert!(state.contains("attachment_exact_bytes_ok"), "{mode}");
        assert!(!state.contains("attachment_exact_bytes_invalid"), "{mode}");
        assert!(!state.contains(&fixture.workspace.to_string_lossy().to_string()));
        assert!(!state.contains(&fixture.app_data.to_string_lossy().to_string()));

        if mode == "attachments_terminal_first" {
            result.expect("terminal-first turn was accepted");
            assert!(state.contains("attachment_terminal_cleanup_ok"));
            assert!(!state.contains("attachment_terminal_cleanup_invalid"));
            attachments.consume(&context, &handles).await;
            let consumed = attachments
                .resolve_for_turn(context.clone(), &handles)
                .await
                .expect_err("accepted turn consumes handles");
            assert_eq!(consumed.code, "CODEX-ATTACHMENT-HANDLE-INVALID");
        } else {
            result.expect_err("rejection or crash must fail turn start");
            let retry = attachments
                .resolve_for_turn(context.clone(), &handles)
                .await
                .expect("failed turn keeps handles reusable");
            drop(retry);
            assert_attachment_snapshots_empty(&fixture);
        }
        supervisor.shutdown().await;
    }
}

#[tokio::test]
async fn stable_initialize_fallback_omits_experimental_fields_and_blocks_review() {
    let _guard = ENVIRONMENT_LOCK.lock().await;
    let fixture = FixtureEnvironment::new("experimental_rejected");
    let supervisor = test_supervisor();
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
        let supervisor = test_supervisor();
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
    let supervisor = test_supervisor();
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
            attachment_handles: vec![],
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
        let supervisor = test_supervisor();
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
                attachment_handles: vec![],
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
    let supervisor = test_supervisor();
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
            attachment_handles: vec![],
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
    assert_eq!(state.matches("commit_skill_exactly_once_ok").count(), 2);
    assert_eq!(state.matches("commit_skill_audit:").count(), 2);
    assert!(!state.contains("commit_skill_exactly_once_invalid"));
    assert!(!state.contains("decision_continuation_invalid"));
    supervisor.shutdown().await;
}

#[tokio::test]
async fn notification_first_turn_start_preserves_fallback_display_and_answer() {
    let _guard = ENVIRONMENT_LOCK.lock().await;
    let fixture = FixtureEnvironment::new("decision_notification_first");
    let supervisor = test_supervisor();
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
    let response = supervisor
        .turn_start(CodexTurnStartRequest {
            workspace_id: "workspace".to_owned(),
            thread_handle: thread.thread_handle,
            client_user_message_id: "message-notification-first".to_owned(),
            text: "Produce a decision.".to_owned(),
            effort: ReasoningPreset::Max,
            attachment_handles: vec![],
        })
        .await
        .expect("notification-first turn");
    assert!(!response.turn_handle.is_empty());
    let state = read_state(&fixture.state).await;
    assert!(state.contains("decision_notifications_before_response"));
    assert!(!state.contains("interrupt_received"));

    let (decision_handle, option_id) = fallback_handles();
    let continuation = supervisor
        .answer_fallback_decision(CodexFallbackDecisionRequest {
            workspace_id: "workspace".to_owned(),
            decision_handle,
            option_id,
        })
        .await
        .expect("answer notification-first decision");
    assert!(!continuation.turn_handle.is_empty());
    let state = read_state(&fixture.state).await;
    assert_eq!(state.matches("decision_continuation_ok").count(), 1);
    assert!(!state.contains("decision_continuation_invalid"));
    assert!(!state.contains("interrupt_received"));
    supervisor.shutdown().await;
}

#[tokio::test]
async fn failed_fallback_continuation_is_terminal_and_never_replayed() {
    let _guard = ENVIRONMENT_LOCK.lock().await;
    let fixture = FixtureEnvironment::new("decision_continuation_crash");
    let supervisor = test_supervisor();
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
            attachment_handles: vec![],
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
    let supervisor = test_supervisor();
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
    let supervisor = test_supervisor();
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
    let supervisor = test_supervisor();
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
            attachment_handles: vec![],
        })
        .await
        .expect("turn");

    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    loop {
        let state = read_state(&fixture.state).await;
        if state.contains("unknown_request_rejected") && state.contains("interrupt_received") {
            assert_eq!(state.matches("commit_skill_exactly_once_ok").count(), 1);
            assert!(!state.contains("commit_skill_exactly_once_invalid"));
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
    let supervisor = test_supervisor();
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
    let thread = supervisor
        .thread_start(CodexThreadStartRequest {
            workspace_id: "workspace".to_owned(),
        })
        .await
        .expect("thread after restart");
    let turn = supervisor
        .turn_start(CodexTurnStartRequest {
            workspace_id: "workspace".to_owned(),
            thread_handle: thread.thread_handle,
            client_user_message_id: "message-after-restart".to_owned(),
            text: "Verify skill injection after restart.".to_owned(),
            effort: ReasoningPreset::Low,
            attachment_handles: vec![],
        })
        .await
        .expect("turn after restart");
    let audit = supervisor
        .main_skill_injection_audit(&turn.turn_handle)
        .await
        .expect("skill audit after restart");
    assert_eq!(audit.name, "coding-wife-commit-work");
    let state = read_state(&fixture.state).await;
    assert_eq!(state.matches("commit_skill_exactly_once_ok").count(), 1);
    assert!(!state.contains("commit_skill_exactly_once_invalid"));
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
    let supervisor = test_supervisor();
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
