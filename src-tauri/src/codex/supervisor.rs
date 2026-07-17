use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex, RwLock};
use std::time::{Duration, Instant};

use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, Mutex};

use super::binary::{discover_binary, probe_schema, BinaryError, BinaryInfo, SchemaProbe};
use super::decision::{
    fallback_continuation_input, FallbackDecisionClaim, FallbackDecisionContext,
    FallbackDecisionError, FallbackDecisionLedger, FallbackRegisterOutcome,
};
use super::dynamic_tools::DynamicToolRegistry;
use super::normalizer::EventNormalizer;
use super::process::{spawn_process, ProcessError, ProcessRuntime};
use super::protocol::{
    account_read_params, client_notification, config_read_params, initialize_params,
    model_list_params, parse_thread_policy_response, review_start_params, server_error,
    server_result, thread_list_params, thread_resume_params, thread_start_params,
    turn_interrupt_params, turn_start_params, InboundMessage, OutboundProfile,
};
use super::requests::{
    ActiveWireContext, RegisterOutcome, RequestValidationError, ServerRequestLedger,
};
use super::rpc::{RpcConnection, RpcRequestError, RuntimeSignal};
use super::types::{
    AcceptedResponse, CapabilityState, ChildState, CodexCommandError, CodexConnectRequest,
    CodexDiagnostic, CodexEvent, CodexFallbackDecisionRequest, CodexHealth,
    CodexPendingResponseRequest, CodexReviewStartRequest, CodexThreadListRequest,
    CodexThreadResumeRequest, CodexThreadStartRequest, CodexTurnInterruptRequest,
    CodexTurnStartRequest, PendingResolutionStatus, ReasoningPreset, ReviewResponse,
    ThreadListResponse, ThreadResponse, ThreadSummary, TurnResponse,
};

pub const CODEX_EVENT_CHANNEL: &str = "coding-wife://codex-event";
pub const DOMAIN_EVENT_CHANNEL: &str = "coding-wife://domain-event";
const INITIALIZE_TIMEOUT: Duration = Duration::from_secs(5);
const INTERRUPT_ACK_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_MODEL_PAGES: usize = 20;
const MAX_RESTARTS: usize = 3;
const RESTART_WINDOW: Duration = Duration::from_secs(60);

#[derive(Clone, Debug)]
enum PendingTurnStartPurpose {
    User,
    Fallback(FallbackDecisionClaim),
}

#[derive(Clone, Debug)]
struct PendingTurnStart {
    token: u64,
    generation: u64,
    workspace_id: String,
    raw_thread_id: String,
    thread_handle: String,
    effort: ReasoningPreset,
    client_message_id: String,
    raw_turn_id: Option<String>,
    turn_handle: Option<String>,
    terminal: bool,
    purpose: PendingTurnStartPurpose,
}

#[derive(Default)]
struct SupervisorState {
    workspaces: HashMap<String, PathBuf>,
    explicit_binary: Option<PathBuf>,
    binary: Option<BinaryInfo>,
    schema: Option<SchemaProbe>,
    runtime: Option<Arc<ProcessRuntime>>,
    active_workspace: Option<String>,
    generation: u64,
    diagnostic: CodexDiagnostic,
    normalizer: Option<EventNormalizer>,
    thread_handles: HashMap<String, String>,
    turn_handles: HashMap<String, String>,
    active_thread_id: Option<String>,
    active_turn_id: Option<String>,
    active_turn_effort: Option<ReasoningPreset>,
    pending_turn_start: Option<PendingTurnStart>,
    next_turn_start_token: u64,
    requests: ServerRequestLedger,
    fallback_decisions: FallbackDecisionLedger,
    restart_times: VecDeque<Instant>,
}

struct SupervisorInner {
    state: Mutex<SupervisorState>,
    lifecycle: Mutex<()>,
    signals: mpsc::Sender<RuntimeSignal>,
    signal_receiver: StdMutex<Option<mpsc::Receiver<RuntimeSignal>>>,
    signal_loop_started: AtomicBool,
    app_handle: RwLock<Option<AppHandle>>,
    dynamic_tools: DynamicToolRegistry,
}

#[derive(Clone)]
pub struct CodexSupervisor {
    inner: Arc<SupervisorInner>,
}

struct PendingTurnStartGuard {
    supervisor: CodexSupervisor,
    generation: u64,
    token: u64,
    armed: bool,
}

impl PendingTurnStartGuard {
    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for PendingTurnStartGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let supervisor = self.supervisor.clone();
        let generation = self.generation;
        let token = self.token;
        tauri::async_runtime::spawn(async move {
            supervisor
                .rollback_pending_turn_start(generation, token, true)
                .await;
        });
    }
}

struct HandshakeResult {
    experimental_api_accepted: bool,
    account_present: bool,
    auth_kind: Option<String>,
    requires_openai_auth: bool,
    model_available: bool,
    fast_available: bool,
    max_available: bool,
    config_model_present: bool,
}

impl Default for CodexSupervisor {
    fn default() -> Self {
        Self::new()
    }
}

impl CodexSupervisor {
    pub fn new() -> Self {
        let (signals, receiver) = mpsc::channel(1024);
        Self {
            inner: Arc::new(SupervisorInner {
                state: Mutex::new(SupervisorState::default()),
                lifecycle: Mutex::new(()),
                signals,
                signal_receiver: StdMutex::new(Some(receiver)),
                signal_loop_started: AtomicBool::new(false),
                app_handle: RwLock::new(None),
                dynamic_tools: DynamicToolRegistry,
            }),
        }
    }

    pub fn attach_app_handle(&self, app_handle: AppHandle) {
        *self
            .inner
            .app_handle
            .write()
            .expect("app handle lock poisoned") = Some(app_handle);
    }

    pub fn start_signal_loop(&self) {
        if self.inner.signal_loop_started.swap(true, Ordering::AcqRel) {
            return;
        }
        let receiver = self
            .inner
            .signal_receiver
            .lock()
            .expect("signal receiver lock poisoned")
            .take();
        if let Some(receiver) = receiver {
            let supervisor = self.clone();
            tauri::async_runtime::spawn(async move {
                supervisor.run_signal_loop(receiver).await;
            });
        }
    }

    pub async fn register_workspace_root(
        &self,
        workspace_id: impl Into<String>,
        root: impl AsRef<Path>,
    ) -> Result<(), CodexCommandError> {
        let workspace_id = workspace_id.into();
        if workspace_id.trim().is_empty() || workspace_id.len() > 128 {
            return Err(command_error("CODEX-WORKSPACE-ID", "codex.register", false));
        }
        let root = tokio::fs::canonicalize(root)
            .await
            .map_err(|_| command_error("CODEX-WORKSPACE-MISSING", "codex.register", true))?;
        if !tokio::fs::metadata(&root)
            .await
            .is_ok_and(|metadata| metadata.is_dir())
        {
            return Err(command_error(
                "CODEX-WORKSPACE-INVALID",
                "codex.register",
                false,
            ));
        }
        self.inner
            .state
            .lock()
            .await
            .workspaces
            .insert(workspace_id, root);
        Ok(())
    }

    pub async fn unregister_workspace_root(
        &self,
        workspace_id: &str,
    ) -> Result<(), CodexCommandError> {
        let mut state = self.inner.state.lock().await;
        if state.active_workspace.as_deref() == Some(workspace_id)
            && (state.active_turn_id.is_some() || state.pending_turn_start.is_some())
        {
            return Err(command_error(
                "CODEX-WORKSPACE-ACTIVE",
                "codex.unregister",
                true,
            ));
        }
        state.workspaces.remove(workspace_id);
        if state.active_workspace.as_deref() == Some(workspace_id) {
            state.active_workspace = None;
        }
        Ok(())
    }

    pub async fn set_explicit_binary(&self, path: Option<PathBuf>) {
        self.inner.state.lock().await.explicit_binary = path;
    }

    pub async fn diagnostic(&self) -> CodexDiagnostic {
        self.inner.state.lock().await.diagnostic.clone()
    }

    pub async fn probe(&self) -> Result<CodexDiagnostic, CodexCommandError> {
        let _lifecycle = self.inner.lifecycle.lock().await;
        let (explicit, runtime) = {
            let mut state = self.inner.state.lock().await;
            let explicit = state.explicit_binary.clone();
            let runtime = state.runtime.take();
            clear_probe_evidence(&mut state, "codex.probe");
            (explicit, runtime)
        };
        if let Some(runtime) = runtime {
            runtime.shutdown().await;
        }
        let binary = match discover_binary(explicit.as_deref()).await {
            Ok(binary) => binary,
            Err(error) => {
                self.set_probe_failure(error, "codex.probe").await;
                return Err(binary_command_error(error, "codex.probe"));
            }
        };
        let schema = match probe_schema(&binary).await {
            Ok(schema) => schema,
            Err(error) => {
                self.set_probe_failure(error, "codex.probe").await;
                return Err(binary_command_error(error, "codex.probe"));
            }
        };
        let mut state = self.inner.state.lock().await;
        let diagnostic = diagnostic_from_probe(&binary, &schema);
        state.binary = Some(binary);
        state.schema = Some(schema);
        state.diagnostic = diagnostic.clone();
        Ok(diagnostic)
    }

    pub async fn connect(
        &self,
        request: CodexConnectRequest,
    ) -> Result<CodexDiagnostic, CodexCommandError> {
        self.connect_internal(request.workspace_id, true).await
    }

    async fn connect_internal(
        &self,
        workspace_id: String,
        reset_restart_budget: bool,
    ) -> Result<CodexDiagnostic, CodexCommandError> {
        let _lifecycle = self.inner.lifecycle.lock().await;
        let (workspace_root, explicit, previous_runtime) = {
            let mut state = self.inner.state.lock().await;
            let workspace_root = state
                .workspaces
                .get(&workspace_id)
                .cloned()
                .ok_or_else(|| {
                    command_error("CODEX-WORKSPACE-NOT-REGISTERED", "codex.connect", false)
                })?;
            if reset_restart_budget {
                state.restart_times.clear();
            }
            clear_probe_evidence(&mut state, "codex.connect");
            (
                workspace_root,
                state.explicit_binary.clone(),
                state.runtime.take(),
            )
        };
        if let Some(runtime) = previous_runtime {
            runtime.shutdown().await;
        }

        let binary = match discover_binary(explicit.as_deref()).await {
            Ok(binary) => binary,
            Err(error) => {
                self.set_probe_failure(error, "codex.binary").await;
                return Err(binary_command_error(error, "codex.connect"));
            }
        };
        let schema = match probe_schema(&binary).await {
            Ok(schema) => schema,
            Err(error) => {
                self.set_probe_failure(error, "codex.schema").await;
                return Err(binary_command_error(error, "codex.connect"));
            }
        };

        let mut experimental = true;
        let mut last_error = None;
        for attempt in 0..2 {
            let (runtime, generation) = self
                .spawn_and_install(
                    &workspace_id,
                    &workspace_root,
                    binary.clone(),
                    schema.clone(),
                )
                .await?;
            match handshake(&runtime.connection, &workspace_root, experimental).await {
                Ok(handshake) => {
                    let diagnostic = self
                        .apply_handshake(&binary, &schema, handshake, experimental)
                        .await;
                    return Ok(diagnostic);
                }
                Err(error) => {
                    let experimental_rejected = matches!(
                        error,
                        RpcRequestError::Server {
                            category: "experimental_rejected",
                            ..
                        }
                    );
                    let retry_timeout = attempt == 0 && matches!(error, RpcRequestError::Timeout);
                    runtime.shutdown().await;
                    {
                        let mut state = self.inner.state.lock().await;
                        if state.generation == generation {
                            state.runtime = None;
                        }
                    }
                    if experimental_rejected {
                        experimental = false;
                    } else if !retry_timeout {
                        last_error = Some(error);
                        break;
                    }
                    last_error = Some(error);
                }
            }
        }

        let error = last_error.unwrap_or(RpcRequestError::Protocol);
        self.set_connection_failure(&error).await;
        Err(rpc_command_error(error, "codex.connect"))
    }

    async fn spawn_and_install(
        &self,
        workspace_id: &str,
        workspace_root: &Path,
        binary: BinaryInfo,
        schema: SchemaProbe,
    ) -> Result<(Arc<ProcessRuntime>, u64), CodexCommandError> {
        let generation = {
            let mut state = self.inner.state.lock().await;
            state.generation += 1;
            state.diagnostic.child_state = ChildState::Spawning;
            state.generation
        };
        let runtime = match spawn_process(
            &binary,
            workspace_root,
            generation,
            self.inner.signals.clone(),
        )
        .await
        {
            Ok(runtime) => Arc::new(runtime),
            Err(ProcessError::IdentityChanged) => {
                let mut state = self.inner.state.lock().await;
                clear_probe_evidence(&mut state, "codex.connect");
                state.diagnostic.health = CodexHealth::BinaryUntrusted;
                state.diagnostic.child_state = ChildState::Stopped;
                state.diagnostic.error_code = Some("CODEX-BINARY-IDENTITY-CHANGED".to_owned());
                return Err(command_error(
                    "CODEX-BINARY-IDENTITY-CHANGED",
                    "codex.connect",
                    false,
                ));
            }
            Err(ProcessError::Spawn | ProcessError::MissingStdio) => {
                return Err(command_error("CODEX-SPAWN-FAILED", "codex.connect", true));
            }
        };
        let mut state = self.inner.state.lock().await;
        state.binary = Some(binary);
        state.schema = Some(schema);
        state.runtime = Some(runtime.clone());
        state.active_workspace = Some(workspace_id.to_owned());
        state.normalizer = Some(EventNormalizer::new(
            workspace_id.to_owned(),
            workspace_root.to_path_buf(),
            generation,
        ));
        state.thread_handles.clear();
        state.turn_handles.clear();
        state.active_thread_id = None;
        state.active_turn_id = None;
        state.active_turn_effort = None;
        state.pending_turn_start = None;
        state.requests.clear_pending();
        state.fallback_decisions.clear();
        state.diagnostic.child_state = ChildState::Initializing;
        Ok((runtime, generation))
    }

    async fn apply_handshake(
        &self,
        binary: &BinaryInfo,
        schema: &SchemaProbe,
        handshake: HandshakeResult,
        experimental_requested: bool,
    ) -> CodexDiagnostic {
        let mut capabilities = schema.capabilities.clone();
        if !handshake.experimental_api_accepted {
            capabilities.native_request_user_input = CapabilityState::Unavailable;
            capabilities.dynamic_tools = CapabilityState::Unavailable;
            capabilities.permissions_approval = CapabilityState::Unavailable;
            capabilities.detached_review = CapabilityState::Unavailable;
            capabilities.ephemeral_thread = CapabilityState::Unavailable;
        }
        // This remains a deterministic local fallback until an explicit deny-all
        // built-in-tool and null-cwd contract is proven.
        capabilities.support_isolation = CapabilityState::Unavailable;
        let health = if handshake.requires_openai_auth && !handshake.account_present {
            CodexHealth::AuthRequired
        } else if !handshake.model_available {
            CodexHealth::ModelUnavailable
        } else if !handshake.fast_available || !handshake.max_available {
            CodexHealth::EffortUnavailable
        } else {
            CodexHealth::Ready
        };
        let now = chrono::Utc::now().to_rfc3339();
        let diagnostic = CodexDiagnostic {
            adapter_version: super::types::CODEX_ADAPTER_VERSION,
            health,
            checked_at: now.clone(),
            operation: "codex.initialize".to_owned(),
            recoverable: health != CodexHealth::Ready,
            cli_version: Some(binary.cli_version.clone()),
            binary_source: Some(binary.source),
            binary_hash_prefix: Some(binary.executable_sha256[..16].to_owned()),
            schema_fingerprint_prefix: Some(schema.fingerprint[..16].to_owned()),
            generated_by_same_binary: schema.generated_by_same_binary,
            experimental_api_requested: experimental_requested,
            experimental_api_accepted: handshake.experimental_api_accepted,
            account_present: handshake.account_present,
            auth_kind: handshake.auth_kind,
            requires_openai_auth: handshake.requires_openai_auth,
            model_available: handshake.model_available,
            fast_available: handshake.fast_available,
            max_available: handshake.max_available,
            config_model_present: handshake.config_model_present,
            child_state: ChildState::Ready,
            last_successful_handshake_at: Some(now),
            capabilities,
            error_code: match health {
                CodexHealth::AuthRequired => Some("CODEX-AUTH-REQUIRED".to_owned()),
                CodexHealth::ModelUnavailable => Some("CODEX-SOL-UNAVAILABLE".to_owned()),
                CodexHealth::EffortUnavailable => Some("CODEX-EFFORT-UNAVAILABLE".to_owned()),
                _ => None,
            },
            detail_ref: None,
        };
        self.inner.state.lock().await.diagnostic = diagnostic.clone();
        diagnostic
    }

    async fn set_probe_failure(&self, error: BinaryError, operation: &str) {
        let runtime = {
            let mut state = self.inner.state.lock().await;
            let runtime = state.runtime.take();
            clear_probe_evidence(&mut state, operation);
            state.diagnostic.health = match error {
                BinaryError::Missing => CodexHealth::BinaryMissing,
                BinaryError::Untrusted => CodexHealth::BinaryUntrusted,
                BinaryError::SchemaUnsupported => CodexHealth::SchemaUnsupported,
                _ => CodexHealth::Disconnected,
            };
            state.diagnostic.child_state = ChildState::Stopped;
            state.diagnostic.error_code = Some(
                match error {
                    BinaryError::Missing => "CODEX-BINARY-MISSING",
                    BinaryError::Untrusted => "CODEX-BINARY-UNTRUSTED",
                    BinaryError::SchemaUnsupported => "CODEX-SCHEMA-UNSUPPORTED",
                    BinaryError::Timeout => "CODEX-PROBE-TIMEOUT",
                    BinaryError::ProbeFailed | BinaryError::Io => "CODEX-PROBE-FAILED",
                }
                .to_owned(),
            );
            runtime
        };
        if let Some(runtime) = runtime {
            runtime.shutdown().await;
        }
    }

    async fn set_connection_failure(&self, error: &RpcRequestError) {
        let mut state = self.inner.state.lock().await;
        state.diagnostic.health = if matches!(error, RpcRequestError::Protocol) {
            CodexHealth::ProtocolMismatch
        } else {
            CodexHealth::Disconnected
        };
        state.diagnostic.child_state = ChildState::Stopped;
        state.diagnostic.checked_at = chrono::Utc::now().to_rfc3339();
        state.diagnostic.error_code = Some(rpc_error_code(error).to_owned());
    }

    async fn ready_context(
        &self,
        workspace_id: &str,
    ) -> Result<(RpcConnection, PathBuf, u64), CodexCommandError> {
        let state = self.inner.state.lock().await;
        if state.active_workspace.as_deref() != Some(workspace_id) {
            return Err(command_error(
                "CODEX-WORKSPACE-STALE",
                "codex.session",
                false,
            ));
        }
        if state.diagnostic.health != CodexHealth::Ready {
            return Err(command_error("CODEX-NOT-READY", "codex.session", true));
        }
        let runtime = state
            .runtime
            .as_ref()
            .ok_or_else(|| command_error("CODEX-DISCONNECTED", "codex.session", true))?;
        let root = state
            .workspaces
            .get(workspace_id)
            .cloned()
            .ok_or_else(|| command_error("CODEX-WORKSPACE-MISSING", "codex.session", false))?;
        Ok((runtime.connection.clone(), root, state.generation))
    }

    async fn outbound_profile(
        &self,
        generation: u64,
        operation: &str,
    ) -> Result<OutboundProfile, CodexCommandError> {
        let state = self.inner.state.lock().await;
        ensure_generation(&state, generation, operation)?;
        Ok(if state.diagnostic.experimental_api_accepted {
            OutboundProfile::Experimental
        } else {
            OutboundProfile::Stable
        })
    }

    pub async fn thread_list(
        &self,
        request: CodexThreadListRequest,
    ) -> Result<ThreadListResponse, CodexCommandError> {
        let (connection, root, generation) = self.ready_context(&request.workspace_id).await?;
        let result = connection
            .request_default(
                "thread/list",
                thread_list_params(&root, request.cursor.as_deref()),
            )
            .await
            .map_err(|error| rpc_command_error(error, "thread/list"))?;
        let data = result
            .get("data")
            .and_then(Value::as_array)
            .ok_or_else(|| command_error("CODEX-RESPONSE-SHAPE", "thread/list", false))?;
        let mut state = self.inner.state.lock().await;
        ensure_generation(&state, generation, "thread/list")?;
        let mut summaries = Vec::with_capacity(data.len().min(100));
        for thread in data.iter().take(100) {
            let raw_id = thread
                .get("id")
                .and_then(Value::as_str)
                .ok_or_else(|| command_error("CODEX-RESPONSE-SHAPE", "thread/list", false))?;
            let handle = state
                .normalizer
                .as_mut()
                .ok_or_else(|| command_error("CODEX-NORMALIZER-MISSING", "thread/list", false))?
                .thread_handle(raw_id);
            state
                .thread_handles
                .insert(handle.clone(), raw_id.to_owned());
            let status = thread
                .get("status")
                .and_then(|status| status.as_str().or_else(|| status.get("type")?.as_str()))
                .unwrap_or("unknown")
                .to_owned();
            let title = thread
                .get("name")
                .or_else(|| thread.get("preview"))
                .and_then(Value::as_str)
                .map(|title| super::redaction::redact_text(title, Some(&root), 256));
            let updated_at = thread
                .get("updatedAt")
                .and_then(Value::as_str)
                .map(str::to_owned);
            summaries.push(ThreadSummary {
                thread_handle: handle,
                status,
                title,
                updated_at,
            });
        }
        Ok(ThreadListResponse {
            data: summaries,
            next_cursor: result
                .get("nextCursor")
                .and_then(Value::as_str)
                .map(str::to_owned),
        })
    }

    pub async fn thread_start(
        &self,
        request: CodexThreadStartRequest,
    ) -> Result<ThreadResponse, CodexCommandError> {
        let (connection, root, generation) = self.ready_context(&request.workspace_id).await?;
        let profile = self.outbound_profile(generation, "thread/start").await?;
        let result = connection
            .request_default("thread/start", thread_start_params(&root, profile))
            .await
            .map_err(|error| rpc_command_error(error, "thread/start"))?;
        self.accept_thread_response(result, &root, generation, "thread/start")
            .await
    }

    pub async fn thread_resume(
        &self,
        request: CodexThreadResumeRequest,
    ) -> Result<ThreadResponse, CodexCommandError> {
        let (connection, root, generation) = self.ready_context(&request.workspace_id).await?;
        let profile = self.outbound_profile(generation, "thread/resume").await?;
        let raw_thread = {
            let state = self.inner.state.lock().await;
            state
                .thread_handles
                .get(&request.thread_handle)
                .cloned()
                .ok_or_else(|| command_error("CODEX-THREAD-STALE", "thread/resume", false))?
        };
        let result = connection
            .request_default(
                "thread/resume",
                thread_resume_params(&root, &raw_thread, profile),
            )
            .await
            .map_err(|error| rpc_command_error(error, "thread/resume"))?;
        self.accept_thread_response(result, &root, generation, "thread/resume")
            .await
    }

    async fn accept_thread_response(
        &self,
        result: Value,
        root: &Path,
        generation: u64,
        operation: &str,
    ) -> Result<ThreadResponse, CodexCommandError> {
        let policy = match parse_thread_policy_response(&result) {
            Ok(policy) => policy,
            Err(_) => {
                return Err(self
                    .stop_for_thread_policy_violation(generation, operation)
                    .await)
            }
        };
        let (canonical_response, canonical_thread) = match (
            tokio::fs::canonicalize(&policy.response_cwd).await,
            tokio::fs::canonicalize(&policy.thread_cwd).await,
        ) {
            (Ok(response), Ok(thread)) => (response, thread),
            _ => {
                return Err(self
                    .stop_for_thread_policy_violation(generation, operation)
                    .await)
            }
        };
        if canonical_response != root || canonical_thread != root {
            return Err(self
                .stop_for_thread_policy_violation(generation, operation)
                .await);
        }
        let raw_thread = policy.thread_id;
        let mut state = self.inner.state.lock().await;
        ensure_generation(&state, generation, operation)?;
        let handle = state
            .normalizer
            .as_mut()
            .ok_or_else(|| command_error("CODEX-NORMALIZER-MISSING", operation, false))?
            .thread_handle(&raw_thread);
        state
            .thread_handles
            .insert(handle.clone(), raw_thread.clone());
        state.active_thread_id = Some(raw_thread);
        Ok(ThreadResponse {
            thread_handle: handle,
            model: super::types::CODEX_MODEL.to_owned(),
            generation,
        })
    }

    async fn stop_for_thread_policy_violation(
        &self,
        generation: u64,
        operation: &str,
    ) -> CodexCommandError {
        let runtime = {
            let mut state = self.inner.state.lock().await;
            if state.generation != generation {
                return command_error("CODEX-GENERATION-STALE", operation, false);
            }
            state.diagnostic.health = CodexHealth::ProtocolMismatch;
            state.diagnostic.child_state = ChildState::Stopping;
            state.diagnostic.error_code = Some("CODEX-THREAD-POLICY-MISMATCH".to_owned());
            state.active_thread_id = None;
            state.active_turn_id = None;
            state.active_turn_effort = None;
            state.pending_turn_start = None;
            state.thread_handles.clear();
            state.turn_handles.clear();
            state.requests.clear_pending();
            state.runtime.take()
        };
        if let Some(runtime) = runtime {
            runtime.shutdown().await;
        }
        let mut state = self.inner.state.lock().await;
        if state.generation == generation {
            state.diagnostic.child_state = ChildState::Stopped;
        }
        command_error("CODEX-THREAD-POLICY-MISMATCH", operation, false)
    }

    pub async fn turn_start(
        &self,
        request: CodexTurnStartRequest,
    ) -> Result<TurnResponse, CodexCommandError> {
        if request.text.contains('\0')
            || request.text.chars().count() > 32_000
            || request.text.trim().is_empty()
            || request.client_user_message_id.trim().is_empty()
            || request.client_user_message_id.len() > 128
        {
            return Err(command_error("CODEX-TURN-INVALID", "turn/start", false));
        }
        let (connection, _root, generation) = self.ready_context(&request.workspace_id).await?;
        let (raw_thread, token) = {
            let mut state = self.inner.state.lock().await;
            ensure_generation(&state, generation, "turn/start")?;
            if state.active_turn_id.is_some() || state.pending_turn_start.is_some() {
                return Err(command_error("CODEX-TURN-ACTIVE", "turn/start", false));
            }
            let raw_thread = state
                .thread_handles
                .get(&request.thread_handle)
                .cloned()
                .ok_or_else(|| command_error("CODEX-THREAD-STALE", "turn/start", false))?;
            let token = next_turn_start_token(&mut state);
            state.pending_turn_start = Some(PendingTurnStart {
                token,
                generation,
                workspace_id: request.workspace_id.clone(),
                raw_thread_id: raw_thread.clone(),
                thread_handle: request.thread_handle.clone(),
                effort: request.effort,
                client_message_id: request.client_user_message_id.clone(),
                raw_turn_id: None,
                turn_handle: None,
                terminal: false,
                purpose: PendingTurnStartPurpose::User,
            });
            (raw_thread, token)
        };
        let mut guard = PendingTurnStartGuard {
            supervisor: self.clone(),
            generation,
            token,
            armed: true,
        };
        let result = match connection
            .request_default(
                "turn/start",
                turn_start_params(
                    &raw_thread,
                    &request.client_user_message_id,
                    &request.text,
                    request.effort,
                ),
            )
            .await
        {
            Ok(result) => result,
            Err(error) => {
                self.rollback_pending_turn_start(generation, token, true)
                    .await;
                guard.disarm();
                return Err(rpc_command_error(error, "turn/start"));
            }
        };
        let Some(raw_turn) = result
            .pointer("/turn/id")
            .and_then(Value::as_str)
            .filter(|turn| !turn.is_empty() && turn.len() <= 256)
            .map(str::to_owned)
        else {
            self.rollback_pending_turn_start(generation, token, true)
                .await;
            guard.disarm();
            return Err(command_error("CODEX-RESPONSE-SHAPE", "turn/start", false));
        };
        let turn_handle = {
            let mut state = self.inner.state.lock().await;
            match confirm_pending_turn_start(
                &mut state,
                generation,
                token,
                &raw_thread,
                &raw_turn,
                "turn/start",
            ) {
                Ok((_, turn_handle)) => {
                    if !matches!(
                        state
                            .pending_turn_start
                            .as_ref()
                            .map(|pending| &pending.purpose),
                        Some(PendingTurnStartPurpose::User)
                    ) {
                        drop(state);
                        self.rollback_pending_turn_start(generation, token, true)
                            .await;
                        guard.disarm();
                        return Err(command_error(
                            "CODEX-TURN-START-MISMATCH",
                            "turn/start",
                            false,
                        ));
                    }
                    state.pending_turn_start = None;
                    turn_handle
                }
                Err(error) => {
                    drop(state);
                    self.rollback_pending_turn_start(generation, token, true)
                        .await;
                    guard.disarm();
                    return Err(error);
                }
            }
        };
        guard.disarm();
        Ok(TurnResponse {
            thread_handle: request.thread_handle,
            turn_handle,
        })
    }

    pub async fn turn_interrupt(
        &self,
        request: CodexTurnInterruptRequest,
    ) -> Result<AcceptedResponse, CodexCommandError> {
        let (connection, _root, generation) = self.ready_context(&request.workspace_id).await?;
        let (raw_thread, raw_turn, pending_token) = {
            let state = self.inner.state.lock().await;
            let thread = state
                .thread_handles
                .get(&request.thread_handle)
                .cloned()
                .ok_or_else(|| command_error("CODEX-THREAD-STALE", "turn/interrupt", false))?;
            let turn = state
                .turn_handles
                .get(&request.turn_handle)
                .cloned()
                .ok_or_else(|| command_error("CODEX-TURN-STALE", "turn/interrupt", false))?;
            let pending_token = state
                .pending_turn_start
                .as_ref()
                .filter(|pending| {
                    pending.raw_thread_id == thread && pending.raw_turn_id.as_deref() == Some(&turn)
                })
                .map(|pending| pending.token);
            (thread, turn, pending_token)
        };
        connection
            .request(
                "turn/interrupt",
                turn_interrupt_params(&raw_thread, &raw_turn),
                INTERRUPT_ACK_TIMEOUT,
            )
            .await
            .map_err(|error| rpc_command_error(error, "turn/interrupt"))?;
        if let Some(token) = pending_token {
            self.rollback_pending_turn_start(generation, token, false)
                .await;
        }
        // Acceptance is not terminal; turn/completed remains authoritative.
        Ok(AcceptedResponse { accepted: true })
    }

    pub async fn review_start(
        &self,
        request: CodexReviewStartRequest,
    ) -> Result<ReviewResponse, CodexCommandError> {
        validate_review_target(&request)?;
        let (connection, _root, generation) = self.ready_context(&request.workspace_id).await?;
        let (raw_thread, profile) = {
            let state = self.inner.state.lock().await;
            ensure_generation(&state, generation, "review/start")?;
            if state.diagnostic.capabilities.detached_review != CapabilityState::Supported
                || !state.diagnostic.experimental_api_accepted
            {
                return Err(command_error(
                    "CODEX-CAPABILITY-UNAVAILABLE",
                    "review/start",
                    false,
                ));
            }
            let thread = state
                .thread_handles
                .get(&request.thread_handle)
                .cloned()
                .ok_or_else(|| command_error("CODEX-THREAD-STALE", "review/start", false))?;
            (thread, OutboundProfile::Experimental)
        };
        let params = review_start_params(&raw_thread, &request.target, profile)
            .ok_or_else(|| command_error("CODEX-CAPABILITY-UNAVAILABLE", "review/start", false))?;
        let result = connection
            .request_default("review/start", params)
            .await
            .map_err(|error| rpc_command_error(error, "review/start"))?;
        let review_thread = result
            .get("reviewThreadId")
            .and_then(Value::as_str)
            .ok_or_else(|| command_error("CODEX-RESPONSE-SHAPE", "review/start", false))?;
        let raw_turn = result
            .pointer("/turn/id")
            .and_then(Value::as_str)
            .ok_or_else(|| command_error("CODEX-RESPONSE-SHAPE", "review/start", false))?;
        let mut state = self.inner.state.lock().await;
        ensure_generation(&state, generation, "review/start")?;
        let normalizer = state
            .normalizer
            .as_mut()
            .ok_or_else(|| command_error("CODEX-NORMALIZER-MISSING", "review/start", false))?;
        let review_handle = normalizer.thread_handle(review_thread);
        let turn_handle = normalizer.turn_handle(raw_turn);
        state
            .thread_handles
            .insert(review_handle.clone(), review_thread.to_owned());
        state
            .turn_handles
            .insert(turn_handle.clone(), raw_turn.to_owned());
        Ok(ReviewResponse {
            review_thread_handle: review_handle,
            turn_handle,
        })
    }

    pub async fn respond_pending(
        &self,
        request: CodexPendingResponseRequest,
    ) -> Result<AcceptedResponse, CodexCommandError> {
        let (connection, _root, _generation) = self.ready_context(&request.workspace_id).await?;
        let resolution = {
            let mut state = self.inner.state.lock().await;
            state
                .requests
                .resolve(&request.pending_id, &request.response)
                .map_err(|_| command_error("CODEX-PENDING-INVALID", "codex.respond", false))?
        };
        connection
            .send(resolution.message)
            .map_err(|error| rpc_command_error(error, "codex.respond"))?;
        if resolution.interrupt {
            let _ = connection
                .request(
                    "turn/interrupt",
                    turn_interrupt_params(&resolution.thread_id, &resolution.turn_id),
                    INTERRUPT_ACK_TIMEOUT,
                )
                .await;
        }
        Ok(AcceptedResponse { accepted: true })
    }

    pub async fn answer_fallback_decision(
        &self,
        request: CodexFallbackDecisionRequest,
    ) -> Result<TurnResponse, CodexCommandError> {
        let (connection, _root, generation) = self.ready_context(&request.workspace_id).await?;
        let client_message_id = format!("decision-continuation-{}", uuid::Uuid::new_v4());
        let (claim, token) = {
            let mut state = self.inner.state.lock().await;
            ensure_generation(&state, generation, "codex.decision.answer")?;
            if state.active_turn_id.is_some() || state.pending_turn_start.is_some() {
                return Err(command_error(
                    "CODEX-TURN-ACTIVE",
                    "codex.decision.answer",
                    true,
                ));
            }
            let claim = state
                .fallback_decisions
                .claim(
                    &request.decision_handle,
                    &request.option_id,
                    &request.workspace_id,
                    generation,
                    Instant::now(),
                )
                .map_err(fallback_command_error)?;
            let Some(thread_handle) = state
                .thread_handles
                .iter()
                .find_map(|(handle, raw)| (raw == &claim.thread_id).then(|| handle.clone()))
            else {
                state.fallback_decisions.restore(&claim);
                return Err(command_error(
                    "CODEX-THREAD-STALE",
                    "codex.decision.answer",
                    false,
                ));
            };
            let token = next_turn_start_token(&mut state);
            state.pending_turn_start = Some(PendingTurnStart {
                token,
                generation,
                workspace_id: request.workspace_id.clone(),
                raw_thread_id: claim.thread_id.clone(),
                thread_handle,
                effort: claim.effort,
                client_message_id: client_message_id.clone(),
                raw_turn_id: None,
                turn_handle: None,
                terminal: false,
                purpose: PendingTurnStartPurpose::Fallback(claim.clone()),
            });
            (claim, token)
        };
        let mut guard = PendingTurnStartGuard {
            supervisor: self.clone(),
            generation,
            token,
            armed: true,
        };
        let input = fallback_continuation_input(&claim.decision_handle, &claim.option_id);
        let result = match connection
            .request_default(
                "turn/start",
                turn_start_params(&claim.thread_id, &client_message_id, &input, claim.effort),
            )
            .await
        {
            Ok(result) => result,
            Err(error) => {
                self.rollback_pending_turn_start(generation, token, true)
                    .await;
                guard.disarm();
                return Err(rpc_command_error(error, "codex.decision.answer"));
            }
        };
        let Some(raw_turn) = result
            .pointer("/turn/id")
            .and_then(Value::as_str)
            .filter(|turn| !turn.is_empty() && turn.len() <= 256)
            .map(str::to_owned)
        else {
            self.rollback_pending_turn_start(generation, token, true)
                .await;
            guard.disarm();
            return Err(command_error(
                "CODEX-RESPONSE-SHAPE",
                "codex.decision.answer",
                false,
            ));
        };

        let (response, event) = {
            let mut state = self.inner.state.lock().await;
            let (thread_handle, turn_handle) = match confirm_pending_turn_start(
                &mut state,
                generation,
                token,
                &claim.thread_id,
                &raw_turn,
                "codex.decision.answer",
            ) {
                Ok(confirmation) => confirmation,
                Err(error) => {
                    drop(state);
                    self.rollback_pending_turn_start(generation, token, true)
                        .await;
                    guard.disarm();
                    return Err(error);
                }
            };
            let claim_matches = matches!(
                state
                    .pending_turn_start
                    .as_ref()
                    .map(|pending| &pending.purpose),
                Some(PendingTurnStartPurpose::Fallback(pending_claim)) if pending_claim == &claim
            );
            if !claim_matches {
                drop(state);
                self.rollback_pending_turn_start(generation, token, true)
                    .await;
                guard.disarm();
                return Err(command_error(
                    "CODEX-TURN-START-MISMATCH",
                    "codex.decision.answer",
                    false,
                ));
            }
            if !state.fallback_decisions.complete(&claim) {
                drop(state);
                self.rollback_pending_turn_start(generation, token, true)
                    .await;
                guard.disarm();
                return Err(command_error(
                    "CODEX-DECISION-STALE",
                    "codex.decision.answer",
                    false,
                ));
            }
            state.pending_turn_start = None;
            let event = state.normalizer.as_mut().and_then(|normalizer| {
                normalizer
                    .pending_resolved_event(
                        claim.decision_handle.clone(),
                        PendingResolutionStatus::Accepted,
                    )
                    .ok()
            });
            (
                TurnResponse {
                    thread_handle,
                    turn_handle,
                },
                event,
            )
        };
        guard.disarm();
        if let Some(event) = event {
            self.emit_event(&event);
        }
        Ok(response)
    }

    async fn rollback_pending_turn_start(
        &self,
        generation: u64,
        token: u64,
        interrupt_committed: bool,
    ) {
        let (connection, interrupt, event) = {
            let mut state = self.inner.state.lock().await;
            if state.generation != generation
                || state
                    .pending_turn_start
                    .as_ref()
                    .is_none_or(|pending| pending.token != token)
            {
                return;
            }
            let pending = state
                .pending_turn_start
                .take()
                .expect("checked pending start");
            let committed = pending.raw_turn_id.as_ref().and_then(|turn_id| {
                (state.active_thread_id.as_deref() == Some(&pending.raw_thread_id)
                    && state.active_turn_id.as_deref() == Some(turn_id))
                .then(|| (pending.raw_thread_id.clone(), turn_id.clone()))
            });
            if committed.is_some() {
                state.active_turn_id = None;
                state.active_turn_effort = None;
                state.requests.clear_pending();
            }
            let event = match pending.purpose {
                PendingTurnStartPurpose::Fallback(claim) => {
                    state.fallback_decisions.complete(&claim);
                    state.normalizer.as_mut().and_then(|normalizer| {
                        normalizer
                            .pending_resolved_event(
                                claim.decision_handle,
                                PendingResolutionStatus::Failed,
                            )
                            .ok()
                    })
                }
                PendingTurnStartPurpose::User => None,
            };
            let connection = state
                .runtime
                .as_ref()
                .map(|runtime| runtime.connection.clone());
            (
                connection,
                interrupt_committed.then_some(committed).flatten(),
                event,
            )
        };
        if let Some(event) = event {
            self.emit_event(&event);
        }
        if let (Some(connection), Some((thread_id, turn_id))) = (connection, interrupt) {
            let _ = connection
                .request(
                    "turn/interrupt",
                    turn_interrupt_params(&thread_id, &turn_id),
                    INTERRUPT_ACK_TIMEOUT,
                )
                .await;
        }
    }

    pub async fn shutdown(&self) {
        let _lifecycle = self.inner.lifecycle.lock().await;
        let runtime = {
            let mut state = self.inner.state.lock().await;
            state.diagnostic.child_state = ChildState::Stopping;
            state.requests.clear_pending();
            state.fallback_decisions.clear();
            state.active_turn_id = None;
            state.active_turn_effort = None;
            state.pending_turn_start = None;
            state.runtime.take()
        };
        if let Some(runtime) = runtime {
            runtime.shutdown().await;
        }
        let mut state = self.inner.state.lock().await;
        state.diagnostic.child_state = ChildState::Stopped;
        state.diagnostic.health = CodexHealth::Disconnected;
    }

    async fn run_signal_loop(&self, mut receiver: mpsc::Receiver<RuntimeSignal>) {
        let mut expiry = tokio::time::interval(Duration::from_secs(1));
        loop {
            tokio::select! {
                signal = receiver.recv() => {
                    let Some(signal) = signal else { break };
                    match signal {
                        RuntimeSignal::Inbound { generation, message } => {
                            self.handle_inbound(generation, message).await;
                        }
                        RuntimeSignal::ProtocolViolation { generation, category: _ } => {
                            self.handle_protocol_violation(generation).await;
                        }
                        RuntimeSignal::Disconnected { generation, category: _ } => {
                            self.handle_disconnect(generation).await;
                        }
                    }
                }
                _ = expiry.tick() => {
                    self.expire_pending().await;
                }
            }
        }
    }

    async fn handle_inbound(&self, generation: u64, message: InboundMessage) {
        match message {
            InboundMessage::ServerRequest {
                id,
                method,
                params,
                byte_count,
            } => {
                self.handle_server_request(generation, id, method, params, byte_count)
                    .await;
            }
            InboundMessage::Notification {
                method,
                params,
                byte_count,
            } => {
                self.handle_notification(generation, method, params, byte_count)
                    .await;
            }
            InboundMessage::Response { .. } => {}
        }
    }

    async fn handle_server_request(
        &self,
        generation: u64,
        id: super::protocol::RpcId,
        method: String,
        params: Value,
        byte_count: usize,
    ) {
        let mut outgoing = None;
        let mut interrupt = None;
        let mut events = Vec::new();
        {
            let mut state = self.inner.state.lock().await;
            if state.generation != generation {
                return;
            }
            let Some(runtime) = state.runtime.as_ref() else {
                return;
            };
            let connection = runtime.connection.clone();
            let workspace_id = state.active_workspace.clone().unwrap_or_default();
            let root = state.workspaces.get(&workspace_id).cloned();
            let active_thread = state.active_thread_id.clone();
            let active_turn = state.active_turn_id.clone();
            let capabilities = state.diagnostic.capabilities.clone();

            if method == "item/tool/call" {
                let matches_active = params.get("threadId").and_then(Value::as_str)
                    == active_thread.as_deref()
                    && params.get("turnId").and_then(Value::as_str) == active_turn.as_deref();
                if matches_active && capabilities.dynamic_tools == CapabilityState::Supported {
                    outgoing = Some(server_result(
                        &id,
                        self.inner.dynamic_tools.reject_unregistered(&params),
                    ));
                } else {
                    outgoing = Some(server_error(&id, -32602, "Invalid params"));
                    interrupt = active_thread.zip(active_turn);
                }
                drop(state);
                if let Some(message) = outgoing {
                    let _ = connection.send(message);
                }
                if let Some((thread, turn)) = interrupt {
                    let _ = connection
                        .request(
                            "turn/interrupt",
                            turn_interrupt_params(&thread, &turn),
                            INTERRUPT_ACK_TIMEOUT,
                        )
                        .await;
                }
                return;
            }

            let Some(root) = root else {
                outgoing = Some(server_error(&id, -32602, "Invalid params"));
                drop(state);
                let _ = connection.send(outgoing.expect("set"));
                return;
            };
            let (Some(thread_id), Some(turn_id)) = (active_thread, active_turn) else {
                outgoing = Some(server_error(&id, -32602, "Invalid params"));
                drop(state);
                let _ = connection.send(outgoing.expect("set"));
                return;
            };
            let active = ActiveWireContext {
                thread_id: &thread_id,
                turn_id: &turn_id,
            };
            match state.requests.register(
                id.clone(),
                &method,
                &params,
                &active,
                &root,
                &capabilities,
            ) {
                Ok(RegisterOutcome::New(view)) => {
                    if let Some(normalizer) = state.normalizer.as_mut() {
                        if let Ok(event) = normalizer.pending_event(view) {
                            events.push(event);
                        }
                    }
                }
                Ok(RegisterOutcome::Existing(_)) => {}
                Ok(RegisterOutcome::Replay(response)) => outgoing = Some(response),
                Err(error) => {
                    outgoing = Some(server_error(
                        &id,
                        if error == RequestValidationError::UnsupportedMethod {
                            -32601
                        } else {
                            -32602
                        },
                        if error == RequestValidationError::UnsupportedMethod {
                            "Method not found"
                        } else {
                            "Invalid params"
                        },
                    ));
                    interrupt = Some((thread_id.clone(), turn_id.clone()));
                    if let Some(normalizer) = state.normalizer.as_mut() {
                        if let Ok(event) = normalizer.unsupported(&method, byte_count) {
                            events.push(event);
                        }
                    }
                }
            }
            drop(state);
            if let Some(message) = outgoing {
                let _ = connection.send(message);
            }
            for event in events {
                self.emit_event(&event);
            }
            if let Some((thread, turn)) = interrupt {
                let _ = connection
                    .request(
                        "turn/interrupt",
                        turn_interrupt_params(&thread, &turn),
                        INTERRUPT_ACK_TIMEOUT,
                    )
                    .await;
            }
        }
    }

    async fn handle_notification(
        &self,
        generation: u64,
        method: String,
        params: Value,
        byte_count: usize,
    ) {
        let mut events = Vec::new();
        let mut interrupt = None;
        let mut protocol_violation = false;
        let mut terminal_rollback = None;
        let connection;
        {
            let mut state = self.inner.state.lock().await;
            if state.generation != generation {
                return;
            }
            let Some(runtime) = state.runtime.as_ref() else {
                return;
            };
            connection = runtime.connection.clone();

            if method == "turn/started" {
                let thread_id = params.get("threadId").and_then(Value::as_str);
                let turn_id = params.pointer("/turn/id").and_then(Value::as_str);
                protocol_violation = match thread_id.zip(turn_id) {
                    Some((thread_id, turn_id)) => {
                        if let Some(token) = state
                            .pending_turn_start
                            .as_ref()
                            .map(|pending| pending.token)
                        {
                            confirm_pending_turn_start(
                                &mut state,
                                generation,
                                token,
                                thread_id,
                                turn_id,
                                "turn/started",
                            )
                            .is_err()
                        } else {
                            state.active_thread_id.as_deref() != Some(thread_id)
                                || state.active_turn_id.as_deref() != Some(turn_id)
                        }
                    }
                    None => true,
                };
            }

            let normalized = (!protocol_violation).then(|| {
                state
                    .normalizer
                    .as_mut()
                    .map(|normalizer| normalizer.normalize(&method, &params, byte_count))
            });
            match normalized {
                Some(Some(Ok(mut outcome))) => {
                    if let Some(view) = outcome.fallback_decision.take() {
                        let context = params
                            .get("threadId")
                            .and_then(Value::as_str)
                            .zip(params.get("turnId").and_then(Value::as_str))
                            .zip(state.active_workspace.as_deref())
                            .zip(state.active_turn_effort)
                            .filter(|(((thread_id, turn_id), _), _)| {
                                state.active_thread_id.as_deref() == Some(*thread_id)
                                    && state.active_turn_id.as_deref() == Some(*turn_id)
                            })
                            .map(|(((thread_id, turn_id), workspace_id), effort)| {
                                FallbackDecisionContext {
                                    workspace_id: workspace_id.to_owned(),
                                    generation,
                                    thread_id: thread_id.to_owned(),
                                    source_turn_id: turn_id.to_owned(),
                                    effort,
                                }
                            });
                        match context.and_then(|context| {
                            state
                                .fallback_decisions
                                .register(view, context, Instant::now())
                                .ok()
                        }) {
                            Some(FallbackRegisterOutcome::New(view)) => {
                                if let Some(normalizer) = state.normalizer.as_mut() {
                                    if let Ok(event) = normalizer.pending_event(*view) {
                                        outcome.events.push(event);
                                    }
                                }
                            }
                            Some(FallbackRegisterOutcome::Existing) => {}
                            None => {
                                outcome.decision_violation = true;
                                if let Some(normalizer) = state.normalizer.as_mut() {
                                    if let Ok(event) = normalizer.diagnostic_event(
                                        "CODEX-DECISION-REGISTRATION-INVALID",
                                        false,
                                    ) {
                                        outcome.events.push(event);
                                    }
                                }
                            }
                        }
                    }
                    events = outcome.events;
                    if outcome.model_violation
                        || outcome.unsupported_terminal
                        || outcome.decision_violation
                    {
                        interrupt = state
                            .active_thread_id
                            .clone()
                            .zip(state.active_turn_id.clone());
                    }
                }
                Some(Some(Err(_))) => {
                    if let Some(normalizer) = state.normalizer.as_mut() {
                        if let Ok(event) = normalizer.unsupported(&method, byte_count) {
                            events.push(event);
                        }
                    }
                    interrupt = state
                        .active_thread_id
                        .clone()
                        .zip(state.active_turn_id.clone());
                }
                Some(None) | None => {}
            }

            if !protocol_violation && method == "turn/completed" {
                let thread_id = params.get("threadId").and_then(Value::as_str);
                let turn_id = params.pointer("/turn/id").and_then(Value::as_str);
                let completed =
                    params.pointer("/turn/status").and_then(Value::as_str) == Some("completed");
                if let Some((thread_id, turn_id)) = thread_id.zip(turn_id) {
                    let failed = state
                        .fallback_decisions
                        .mark_turn_terminal(thread_id, turn_id, completed);
                    for pending_id in failed {
                        if let Some(normalizer) = state.normalizer.as_mut() {
                            if let Ok(event) = normalizer
                                .pending_resolved_event(pending_id, PendingResolutionStatus::Failed)
                            {
                                events.push(event);
                            }
                        }
                    }
                    if let Some(pending) = state.pending_turn_start.as_mut().filter(|pending| {
                        pending.raw_thread_id == thread_id
                            && pending.raw_turn_id.as_deref() == Some(turn_id)
                    }) {
                        if completed {
                            pending.terminal = true;
                        } else {
                            terminal_rollback = Some(pending.token);
                        }
                    }
                    let matches_active = state.active_thread_id.as_deref() == Some(thread_id)
                        && state.active_turn_id.as_deref() == Some(turn_id);
                    if matches_active {
                        state.active_turn_id = None;
                        state.active_turn_effort = None;
                        state.requests.clear_pending();
                    }
                }
            }
        }
        if protocol_violation {
            self.handle_protocol_violation(generation).await;
            return;
        }
        if let Some(token) = terminal_rollback {
            self.rollback_pending_turn_start(generation, token, false)
                .await;
        }
        for event in events {
            self.emit_event(&event);
        }
        if let Some((thread, turn)) = interrupt {
            let _ = connection
                .request(
                    "turn/interrupt",
                    turn_interrupt_params(&thread, &turn),
                    INTERRUPT_ACK_TIMEOUT,
                )
                .await;
        }
    }

    async fn handle_protocol_violation(&self, generation: u64) {
        let mut events = Vec::new();
        let (runtime, workspace, restart_attempt) = {
            let mut state = self.inner.state.lock().await;
            if state.generation != generation {
                return;
            }
            if state.runtime.is_none() {
                return;
            }
            state.diagnostic.health = CodexHealth::ProtocolMismatch;
            state.diagnostic.error_code = Some("CODEX-PROTOCOL-MISMATCH".to_owned());
            state.requests.clear_pending();
            state.fallback_decisions.clear();
            state.active_turn_id = None;
            state.active_turn_effort = None;
            state.pending_turn_start = None;
            let restart_attempt = reserve_restart(&mut state);
            state.diagnostic.child_state = if restart_attempt.is_some() {
                ChildState::Restarting
            } else {
                ChildState::Stopped
            };
            state.diagnostic.recoverable = restart_attempt.is_some();
            if let Some(normalizer) = state.normalizer.as_mut() {
                if let Ok(event) = normalizer
                    .diagnostic_event("CODEX-PROTOCOL-MISMATCH", restart_attempt.is_some())
                {
                    events.push(event);
                }
            }
            (
                state.runtime.take(),
                state.active_workspace.clone(),
                restart_attempt,
            )
        };
        for event in events {
            self.emit_event(&event);
        }
        if let Some(runtime) = runtime {
            runtime.shutdown().await;
        }
        if let (Some(workspace), Some(attempt)) = (workspace, restart_attempt) {
            self.schedule_restart(generation, workspace, attempt);
        }
    }

    async fn handle_disconnect(&self, generation: u64) {
        let mut events = Vec::new();
        let (workspace, restart_attempt) = {
            let mut state = self.inner.state.lock().await;
            if state.generation != generation {
                return;
            }
            if state.runtime.is_none() {
                return;
            }
            if state
                .runtime
                .as_ref()
                .is_some_and(|runtime| runtime.expected_shutdown())
            {
                return;
            }
            state.runtime = None;
            state.diagnostic.health = CodexHealth::Disconnected;
            state.diagnostic.child_state = ChildState::Restarting;
            state.diagnostic.error_code = Some("CODEX-CONNECTION-LOST".to_owned());
            state.requests.clear_pending();
            state.fallback_decisions.clear();
            let active = state
                .active_thread_id
                .clone()
                .zip(state.active_turn_id.clone());
            if let Some(normalizer) = state.normalizer.as_mut() {
                if let Some((thread, turn)) = &active {
                    if let Ok(event) = normalizer.connection_lost_event(thread, turn) {
                        events.push(event);
                    }
                }
                if let Ok(event) = normalizer.diagnostic_event("CODEX-CONNECTION-LOST", true) {
                    events.push(event);
                }
            }
            state.active_turn_id = None;
            state.active_turn_effort = None;
            state.pending_turn_start = None;
            let restart_attempt = reserve_restart(&mut state);
            (
                state.active_workspace.clone(),
                if restart_attempt.is_some() {
                    restart_attempt
                } else {
                    state.diagnostic.child_state = ChildState::Stopped;
                    state.diagnostic.recoverable = true;
                    None
                },
            )
        };
        for event in events {
            self.emit_event(&event);
        }
        if let (Some(workspace), Some(attempt)) = (workspace, restart_attempt) {
            self.schedule_restart(generation, workspace, attempt);
        }
    }

    fn schedule_restart(&self, generation: u64, workspace: String, attempt: usize) {
        let supervisor = self.clone();
        let delay = Duration::from_millis(
            250_u64.saturating_mul(1_u64 << (attempt.saturating_sub(1) as u32)) + generation % 97,
        );
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(delay).await;
            let should_restart = {
                let state = supervisor.inner.state.lock().await;
                state.generation == generation
                    && state.runtime.is_none()
                    && state.active_workspace.as_deref() == Some(&workspace)
            };
            if should_restart {
                let _ = supervisor.connect_internal(workspace, false).await;
            }
        });
    }

    async fn expire_pending(&self) {
        let (connection, expired, events) = {
            let mut state = self.inner.state.lock().await;
            let Some(runtime) = state.runtime.as_ref() else {
                return;
            };
            let connection = runtime.connection.clone();
            let now = Instant::now();
            let expired = state.requests.expire(now);
            let fallback_expired = state.fallback_decisions.expire(now);
            let mut events = Vec::new();
            for pending_id in fallback_expired {
                if let Some(normalizer) = state.normalizer.as_mut() {
                    if let Ok(event) = normalizer
                        .pending_resolved_event(pending_id, PendingResolutionStatus::Expired)
                    {
                        events.push(event);
                    }
                }
            }
            (connection, expired, events)
        };
        for event in events {
            self.emit_event(&event);
        }
        for (message, thread, turn) in expired {
            let _ = connection.send(message);
            let _ = connection
                .request(
                    "turn/interrupt",
                    turn_interrupt_params(&thread, &turn),
                    INTERRUPT_ACK_TIMEOUT,
                )
                .await;
        }
    }

    fn emit_event(&self, event: &CodexEvent) {
        let app = self
            .inner
            .app_handle
            .read()
            .expect("app handle lock poisoned")
            .clone();
        if let Some(app) = app {
            let _ = app.emit(CODEX_EVENT_CHANNEL, event);
            if let Some(domain) = EventNormalizer::domain_event(event) {
                let _ = app.emit(DOMAIN_EVENT_CHANNEL, domain);
            }
        }
    }
}

async fn handshake(
    connection: &RpcConnection,
    workspace_root: &Path,
    experimental: bool,
) -> Result<HandshakeResult, RpcRequestError> {
    let initialized = connection
        .request(
            "initialize",
            initialize_params(env!("CARGO_PKG_VERSION"), experimental),
            INITIALIZE_TIMEOUT,
        )
        .await?;
    if initialized
        .get("userAgent")
        .and_then(Value::as_str)
        .is_none_or(str::is_empty)
        || initialized
            .get("platformFamily")
            .and_then(Value::as_str)
            .is_none_or(str::is_empty)
        || initialized
            .get("platformOs")
            .and_then(Value::as_str)
            .is_none_or(str::is_empty)
        || !initialized
            .get("codexHome")
            .and_then(Value::as_str)
            .is_some_and(|value| Path::new(value).is_absolute())
    {
        return Err(RpcRequestError::Protocol);
    }
    connection.send(client_notification("initialized"))?;

    let account = connection
        .request_default("account/read", account_read_params())
        .await?;
    let account_present = account.get("account").is_some_and(|value| !value.is_null());
    let auth_kind = account
        .pointer("/account/type")
        .and_then(Value::as_str)
        .filter(|kind| ["apiKey", "chatgpt", "amazonBedrock"].contains(kind))
        .map(str::to_owned);
    let requires_openai_auth = account
        .get("requiresOpenaiAuth")
        .and_then(Value::as_bool)
        .ok_or(RpcRequestError::Protocol)?;

    let config = connection
        .request_default("config/read", config_read_params(Some(workspace_root)))
        .await?;
    if !config.get("config").is_some_and(Value::is_object)
        || !config.get("origins").is_some_and(Value::is_object)
    {
        return Err(RpcRequestError::Protocol);
    }
    let config_model_present = config
        .pointer("/config/model")
        .is_some_and(|value| !value.is_null());

    let mut cursor = None;
    let mut seen_cursors = std::collections::HashSet::new();
    let mut model_available = false;
    let mut fast_available = false;
    let mut max_available = false;
    for _ in 0..MAX_MODEL_PAGES {
        let page = connection
            .request_default("model/list", model_list_params(cursor.as_deref()))
            .await?;
        let (model, fast, max, next) = super::protocol::validate_model_page(&page);
        model_available |= model;
        fast_available |= fast;
        max_available |= max;
        match next {
            Some(next) if seen_cursors.insert(next.clone()) => cursor = Some(next),
            Some(_) => return Err(RpcRequestError::Protocol),
            None => break,
        }
    }

    Ok(HandshakeResult {
        experimental_api_accepted: experimental,
        account_present,
        auth_kind,
        requires_openai_auth,
        model_available,
        fast_available,
        max_available,
        config_model_present,
    })
}

fn diagnostic_from_probe(binary: &BinaryInfo, schema: &SchemaProbe) -> CodexDiagnostic {
    CodexDiagnostic {
        adapter_version: super::types::CODEX_ADAPTER_VERSION,
        health: CodexHealth::Initializing,
        checked_at: chrono::Utc::now().to_rfc3339(),
        operation: "codex.probe".to_owned(),
        recoverable: true,
        cli_version: Some(binary.cli_version.clone()),
        binary_source: Some(binary.source),
        binary_hash_prefix: Some(binary.executable_sha256[..16].to_owned()),
        schema_fingerprint_prefix: Some(schema.fingerprint[..16].to_owned()),
        generated_by_same_binary: schema.generated_by_same_binary,
        experimental_api_requested: true,
        experimental_api_accepted: false,
        account_present: false,
        auth_kind: None,
        requires_openai_auth: false,
        model_available: false,
        fast_available: false,
        max_available: false,
        config_model_present: false,
        child_state: ChildState::Stopped,
        last_successful_handshake_at: None,
        capabilities: schema.capabilities.clone(),
        error_code: None,
        detail_ref: None,
    }
}

fn validate_review_target(request: &CodexReviewStartRequest) -> Result<(), CodexCommandError> {
    let valid = match &request.target {
        super::types::ReviewTarget::UncommittedChanges => true,
        super::types::ReviewTarget::BaseBranch { branch } => {
            !branch.trim().is_empty() && branch.len() <= 256 && !branch.contains('\0')
        }
        super::types::ReviewTarget::Commit { sha, title } => {
            (7..=64).contains(&sha.len())
                && sha.chars().all(|character| character.is_ascii_hexdigit())
                && title.as_ref().is_none_or(|title| title.len() <= 256)
        }
        super::types::ReviewTarget::Custom { instructions } => {
            !instructions.trim().is_empty()
                && instructions.chars().count() <= 8_000
                && !instructions.contains('\0')
        }
    };
    if valid {
        Ok(())
    } else {
        Err(command_error("CODEX-REVIEW-INVALID", "review/start", false))
    }
}

fn ensure_generation(
    state: &SupervisorState,
    generation: u64,
    operation: &str,
) -> Result<(), CodexCommandError> {
    if state.generation == generation {
        Ok(())
    } else {
        Err(command_error("CODEX-GENERATION-STALE", operation, false))
    }
}

fn next_turn_start_token(state: &mut SupervisorState) -> u64 {
    state.next_turn_start_token = state.next_turn_start_token.wrapping_add(1).max(1);
    state.next_turn_start_token
}

fn confirm_pending_turn_start(
    state: &mut SupervisorState,
    generation: u64,
    token: u64,
    raw_thread_id: &str,
    raw_turn_id: &str,
    operation: &str,
) -> Result<(String, String), CodexCommandError> {
    ensure_generation(state, generation, operation)?;
    if raw_thread_id.is_empty()
        || raw_thread_id.len() > 256
        || raw_turn_id.is_empty()
        || raw_turn_id.len() > 256
    {
        return Err(command_error("CODEX-TURN-START-MISMATCH", operation, false));
    }
    let pending = state
        .pending_turn_start
        .as_ref()
        .filter(|pending| pending.token == token)
        .ok_or_else(|| command_error("CODEX-TURN-START-STALE", operation, false))?
        .clone();
    if pending.generation != generation
        || pending.workspace_id != state.active_workspace.as_deref().unwrap_or_default()
        || pending.raw_thread_id != raw_thread_id
        || pending.client_message_id.is_empty()
        || pending
            .raw_turn_id
            .as_deref()
            .is_some_and(|committed| committed != raw_turn_id)
    {
        return Err(command_error("CODEX-TURN-START-MISMATCH", operation, false));
    }
    let turn_handle = match pending.turn_handle {
        Some(handle) => handle,
        None => state
            .normalizer
            .as_mut()
            .ok_or_else(|| command_error("CODEX-NORMALIZER-MISSING", operation, false))?
            .turn_handle(raw_turn_id),
    };
    state
        .turn_handles
        .insert(turn_handle.clone(), raw_turn_id.to_owned());
    let pending = state
        .pending_turn_start
        .as_mut()
        .filter(|pending| pending.token == token)
        .ok_or_else(|| command_error("CODEX-TURN-START-STALE", operation, false))?;
    pending.raw_turn_id = Some(raw_turn_id.to_owned());
    pending.turn_handle = Some(turn_handle.clone());
    if !pending.terminal {
        state.active_thread_id = Some(raw_thread_id.to_owned());
        state.active_turn_id = Some(raw_turn_id.to_owned());
        state.active_turn_effort = Some(pending.effort);
    }
    Ok((pending.thread_handle.clone(), turn_handle))
}

fn clear_probe_evidence(state: &mut SupervisorState, operation: &str) {
    state.binary = None;
    state.schema = None;
    state.normalizer = None;
    state.thread_handles.clear();
    state.turn_handles.clear();
    state.active_thread_id = None;
    state.active_turn_id = None;
    state.active_turn_effort = None;
    state.pending_turn_start = None;
    state.requests.clear_pending();
    state.fallback_decisions.clear();
    state.diagnostic = CodexDiagnostic {
        health: CodexHealth::Initializing,
        operation: operation.to_owned(),
        checked_at: chrono::Utc::now().to_rfc3339(),
        child_state: ChildState::Probing,
        recoverable: true,
        ..CodexDiagnostic::default()
    };
}

fn reserve_restart(state: &mut SupervisorState) -> Option<usize> {
    let now = Instant::now();
    while state
        .restart_times
        .front()
        .is_some_and(|time| now.duration_since(*time) > RESTART_WINDOW)
    {
        state.restart_times.pop_front();
    }
    state.restart_times.push_back(now);
    (state.restart_times.len() <= MAX_RESTARTS).then_some(state.restart_times.len())
}

fn command_error(code: &str, operation: &str, recoverable: bool) -> CodexCommandError {
    CodexCommandError::new(code, operation, recoverable)
}

fn binary_command_error(error: BinaryError, operation: &str) -> CodexCommandError {
    let (code, recoverable) = match error {
        BinaryError::Missing => ("CODEX-BINARY-MISSING", true),
        BinaryError::Untrusted => ("CODEX-BINARY-UNTRUSTED", false),
        BinaryError::Timeout => ("CODEX-PROBE-TIMEOUT", true),
        BinaryError::ProbeFailed | BinaryError::Io => ("CODEX-PROBE-FAILED", true),
        BinaryError::SchemaUnsupported => ("CODEX-SCHEMA-UNSUPPORTED", false),
    };
    command_error(code, operation, recoverable)
}

fn rpc_error_code(error: &RpcRequestError) -> &'static str {
    match error {
        RpcRequestError::Overloaded => "CODEX-OVERLOADED",
        RpcRequestError::Timeout => "CODEX-REQUEST-TIMEOUT",
        RpcRequestError::ConnectionLost => "CODEX-CONNECTION-LOST",
        RpcRequestError::Server {
            category: "experimental_rejected",
            ..
        } => "CODEX-EXPERIMENTAL-REJECTED",
        RpcRequestError::Server {
            category: "not_initialized" | "already_initialized",
            ..
        }
        | RpcRequestError::Protocol => "CODEX-PROTOCOL-MISMATCH",
        RpcRequestError::Server { .. } => "CODEX-SERVER-ERROR",
    }
}

fn rpc_command_error(error: RpcRequestError, operation: &str) -> CodexCommandError {
    let recoverable = !matches!(error, RpcRequestError::Protocol);
    command_error(rpc_error_code(&error), operation, recoverable)
}

fn fallback_command_error(error: FallbackDecisionError) -> CodexCommandError {
    let (code, recoverable) = match error {
        FallbackDecisionError::SourceTurnActive => ("CODEX-DECISION-TURN-ACTIVE", true),
        FallbackDecisionError::Claimed => ("CODEX-DECISION-IN-PROGRESS", true),
        FallbackDecisionError::Expired => ("CODEX-DECISION-EXPIRED", false),
        FallbackDecisionError::InvalidOption | FallbackDecisionError::Invalid => {
            ("CODEX-DECISION-OPTION-INVALID", false)
        }
        FallbackDecisionError::SessionMismatch
        | FallbackDecisionError::Stale
        | FallbackDecisionError::DuplicateMismatch => ("CODEX-DECISION-STALE", false),
    };
    command_error(code, "codex.decision.answer", recoverable)
}

#[cfg(test)]
mod tests {
    use super::super::types::{ReasoningPreset, ReviewTarget};
    use super::*;

    #[test]
    fn custom_review_is_bounded_and_model_is_not_a_user_input() {
        let request = CodexReviewStartRequest {
            workspace_id: "workspace".to_owned(),
            thread_handle: "thread".to_owned(),
            target: ReviewTarget::Custom {
                instructions: "Review the evidence.".to_owned(),
            },
        };
        assert!(validate_review_target(&request).is_ok());

        let turn = CodexTurnStartRequest {
            workspace_id: "workspace".to_owned(),
            thread_handle: "thread".to_owned(),
            client_user_message_id: "message".to_owned(),
            text: "Implement it".to_owned(),
            effort: ReasoningPreset::Low,
        };
        assert_eq!(turn.effort.as_wire(), "low");
    }

    #[test]
    fn pending_turn_start_confirmation_is_order_independent_and_fail_closed() {
        let mut state = SupervisorState {
            active_workspace: Some("workspace".to_owned()),
            generation: 7,
            normalizer: Some(EventNormalizer::new(
                "workspace".to_owned(),
                PathBuf::from("/workspace"),
                7,
            )),
            pending_turn_start: Some(PendingTurnStart {
                token: 11,
                generation: 7,
                workspace_id: "workspace".to_owned(),
                raw_thread_id: "thread-raw".to_owned(),
                thread_handle: "thread-handle".to_owned(),
                effort: ReasoningPreset::Max,
                client_message_id: "message-1".to_owned(),
                raw_turn_id: None,
                turn_handle: None,
                terminal: false,
                purpose: PendingTurnStartPurpose::User,
            }),
            ..SupervisorState::default()
        };

        let first =
            confirm_pending_turn_start(&mut state, 7, 11, "thread-raw", "turn-raw", "turn/started")
                .expect("notification commits reservation");
        let second =
            confirm_pending_turn_start(&mut state, 7, 11, "thread-raw", "turn-raw", "turn/start")
                .expect("response confirms the same reservation");
        assert_eq!(first, second);
        assert_eq!(state.active_turn_id.as_deref(), Some("turn-raw"));
        assert_eq!(state.active_turn_effort, Some(ReasoningPreset::Max));

        assert_eq!(
            confirm_pending_turn_start(
                &mut state,
                7,
                11,
                "thread-raw",
                "turn-other",
                "turn/start",
            )
            .expect_err("wrong turn must fail closed")
            .code,
            "CODEX-TURN-START-MISMATCH"
        );
        assert_eq!(
            confirm_pending_turn_start(&mut state, 8, 11, "thread-raw", "turn-raw", "turn/start",)
                .expect_err("stale generation must fail closed")
                .code,
            "CODEX-GENERATION-STALE"
        );

        state.active_turn_id = None;
        state.active_turn_effort = None;
        state.pending_turn_start.as_mut().expect("pending").terminal = true;
        confirm_pending_turn_start(&mut state, 7, 11, "thread-raw", "turn-raw", "turn/start")
            .expect("late response remains idempotent");
        assert!(state.active_turn_id.is_none());
        assert!(state.active_turn_effort.is_none());
    }
}
