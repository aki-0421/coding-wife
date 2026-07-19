use std::collections::VecDeque;
use std::ffi::{OsStr, OsString};
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use thiserror::Error;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, Mutex};

use super::binary::BinaryInfo;
use super::redaction::redact_text;
use super::rpc::{RpcConnection, RpcReadLimits, RuntimeSignal};
use super::types::TurnExecutionClass;

const STDERR_RING_BYTES: usize = 64 * 1024;
const GRACEFUL_STDIN_WAIT: Duration = Duration::from_secs(2);
const PROCESS_GROUP_KILL_WAIT: Duration = Duration::from_millis(500);
const PROCESS_GROUP_POLL_INTERVAL: Duration = Duration::from_millis(10);
#[cfg(test)]
const TOTAL_SHUTDOWN_WAIT: Duration = Duration::from_secs(2);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum BoundedCommandError {
    Spawn,
    MissingStdio,
    Read,
    StdoutLimit,
    StderrLimit,
    Timeout,
    ProcessTree,
}

#[derive(Debug)]
pub(crate) struct BoundedCommandOutput {
    pub status: std::process::ExitStatus,
    pub stdout: Vec<u8>,
    #[allow(dead_code)]
    pub stderr: Vec<u8>,
}

/// Makes process-group cleanup cancellation-safe while an async constructor or
/// bounded command still owns a newly spawned child. Tokio's `kill_on_drop`
/// covers only the direct child; this guard also removes descendants.
pub(crate) struct ProcessGroupDropGuard {
    pid: u32,
    armed: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[must_use = "cleanup convergence decides whether fallback process-group ownership remains armed"]
enum ProcessGroupCleanupOutcome {
    Converged,
    Unconverged,
}

impl ProcessGroupDropGuard {
    pub(crate) fn new(pid: u32) -> Self {
        Self { pid, armed: true }
    }

    pub(crate) fn disarm(&mut self) {
        self.armed = false;
    }

    pub(crate) async fn terminate_child(&mut self, child: &mut Child, term_grace: Duration) {
        let outcome = terminate_child_process_group(child, self.pid, term_grace).await;
        self.apply_cleanup_outcome(outcome);
    }

    fn apply_cleanup_outcome(&mut self, outcome: ProcessGroupCleanupOutcome) {
        if outcome == ProcessGroupCleanupOutcome::Converged {
            self.disarm();
        }
    }

    fn cleanup_on_drop_with<Exists, Cleanup>(&self, mut exists: Exists, mut cleanup: Cleanup)
    where
        Exists: FnMut(u32) -> bool,
        Cleanup: FnMut(u32),
    {
        if self.armed && exists(self.pid) {
            cleanup(self.pid);
        }
    }
}

impl Drop for ProcessGroupDropGuard {
    fn drop(&mut self) {
        self.cleanup_on_drop_with(process_group_exists, |pid| {
            let _ = force_kill_process_group_until_gone(pid, PROCESS_GROUP_KILL_WAIT);
        });
    }
}

fn force_kill_process_group_until_gone(pid: u32, kill_wait: Duration) -> bool {
    force_kill_process_group_until_gone_with(
        pid,
        kill_wait,
        |pid| signal_process_group(pid, SIGKILL),
        process_group_exists,
        std::thread::sleep,
    )
}

fn force_kill_process_group_until_gone_with<Signal, Exists, Pause>(
    pid: u32,
    kill_wait: Duration,
    mut signal: Signal,
    mut exists: Exists,
    mut pause: Pause,
) -> bool
where
    Signal: FnMut(u32) -> Result<(), ()>,
    Exists: FnMut(u32) -> bool,
    Pause: FnMut(Duration),
{
    let deadline = Instant::now() + kill_wait;
    loop {
        if !exists(pid) {
            return true;
        }
        let _ = signal(pid);
        if !exists(pid) {
            return true;
        }
        let now = Instant::now();
        if now >= deadline {
            return false;
        }
        pause(PROCESS_GROUP_POLL_INTERVAL.min(deadline.saturating_duration_since(now)));
    }
}

#[derive(Clone, Copy, Debug)]
enum CaptureStream {
    Stdout,
    Stderr,
}

async fn capture_limited<R>(
    mut reader: R,
    limit: usize,
    stream: CaptureStream,
    aborts: mpsc::Sender<BoundedCommandError>,
) -> Result<Vec<u8>, BoundedCommandError>
where
    R: AsyncRead + Unpin,
{
    let mut captured = Vec::with_capacity(limit.min(16 * 1024));
    let mut buffer = [0_u8; 16 * 1024];
    loop {
        let count = reader
            .read(&mut buffer)
            .await
            .map_err(|_| BoundedCommandError::Read)?;
        if count == 0 {
            return Ok(captured);
        }
        if captured.len().saturating_add(count) > limit {
            let error = match stream {
                CaptureStream::Stdout => BoundedCommandError::StdoutLimit,
                CaptureStream::Stderr => BoundedCommandError::StderrLimit,
            };
            let _ = aborts.send(error).await;
            return Err(error);
        }
        captured.extend_from_slice(&buffer[..count]);
    }
}

pub(crate) async fn run_bounded_command(
    mut command: Command,
    timeout: Duration,
    stdout_limit: usize,
    stderr_limit: usize,
) -> Result<BoundedCommandOutput, BoundedCommandError> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    command.as_std_mut().process_group(0);

    let mut child = command.spawn().map_err(|_| BoundedCommandError::Spawn)?;
    let pid = child.id().ok_or(BoundedCommandError::Spawn)?;
    let mut process_group_guard = ProcessGroupDropGuard::new(pid);
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            process_group_guard
                .terminate_child(&mut child, Duration::from_millis(200))
                .await;
            return Err(BoundedCommandError::MissingStdio);
        }
    };
    let stderr = match child.stderr.take() {
        Some(stderr) => stderr,
        None => {
            process_group_guard
                .terminate_child(&mut child, Duration::from_millis(200))
                .await;
            return Err(BoundedCommandError::MissingStdio);
        }
    };
    let (abort_tx, mut abort_rx) = mpsc::channel(2);
    let abort_guard = abort_tx.clone();
    let mut stdout_task = tokio::spawn(capture_limited(
        stdout,
        stdout_limit,
        CaptureStream::Stdout,
        abort_tx.clone(),
    ));
    let mut stderr_task = tokio::spawn(capture_limited(
        stderr,
        stderr_limit,
        CaptureStream::Stderr,
        abort_tx,
    ));
    let deadline = tokio::time::Instant::now() + timeout;

    let status = tokio::select! {
        status = child.wait() => status.map_err(|_| BoundedCommandError::Read),
        abort = abort_rx.recv() => Err(abort.unwrap_or(BoundedCommandError::Read)),
        _ = tokio::time::sleep_until(deadline) => Err(BoundedCommandError::Timeout),
    };
    let status = match status {
        Ok(status) => status,
        Err(error) => {
            process_group_guard
                .terminate_child(&mut child, Duration::from_millis(200))
                .await;
            stdout_task.abort();
            stderr_task.abort();
            return Err(error);
        }
    };

    let captures = tokio::select! {
        captures = async {
            let stdout = (&mut stdout_task)
                .await
                .map_err(|_| BoundedCommandError::Read)??;
            let stderr = (&mut stderr_task)
                .await
                .map_err(|_| BoundedCommandError::Read)??;
            Ok::<_, BoundedCommandError>((stdout, stderr))
        } => captures,
        abort = abort_rx.recv() => Err(abort.unwrap_or(BoundedCommandError::Read)),
        _ = tokio::time::sleep_until(deadline) => Err(BoundedCommandError::Timeout),
    };
    let (stdout, stderr) = match captures {
        Ok(captures) => captures,
        Err(error) => {
            process_group_guard
                .terminate_child(&mut child, Duration::from_millis(200))
                .await;
            stdout_task.abort();
            stderr_task.abort();
            return Err(error);
        }
    };
    drop(abort_guard);
    if process_group_exists(pid) {
        process_group_guard
            .terminate_child(&mut child, Duration::from_millis(200))
            .await;
        return Err(BoundedCommandError::ProcessTree);
    }
    process_group_guard.disarm();
    Ok(BoundedCommandOutput {
        status,
        stdout,
        stderr,
    })
}

#[derive(Debug, Error)]
pub enum ProcessError {
    #[error("the Codex app-server process could not be spawned")]
    Spawn,
    #[error("the verified Codex executable changed before startup completed")]
    IdentityChanged,
    #[error("the Codex app-server process did not expose required stdio")]
    MissingStdio,
}

pub struct ProcessRuntime {
    pub connection: RpcConnection,
    execution_class: TurnExecutionClass,
    child: Arc<Mutex<Child>>,
    stderr_ring: Arc<Mutex<VecDeque<String>>>,
    expected_shutdown: Arc<AtomicBool>,
    shutdown_complete: AtomicBool,
    shutdown_lock: Mutex<()>,
    pid: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ProcessShutdownError {
    ProcessTree,
}

fn is_allowed_environment(name: &OsStr) -> bool {
    let name = name.to_string_lossy();
    matches!(
        name.as_ref(),
        "PATH"
            | "HOME"
            | "SHELL"
            | "LANG"
            | "TMPDIR"
            | "TEMP"
            | "TMP"
            | "CODEX_HOME"
            | "CODEX_SQLITE_HOME"
            | "CODEX_ACCESS_TOKEN"
            | "HTTP_PROXY"
            | "HTTPS_PROXY"
            | "ALL_PROXY"
            | "NO_PROXY"
            | "SSL_CERT_FILE"
            | "SSL_CERT_DIR"
            | "NODE_EXTRA_CA_CERTS"
            | "CODING_WIFE_CODEX_FAKE_MODE"
            | "CODING_WIFE_CODEX_FAKE_STATE"
    ) || name.starts_with("LC_")
        || name.ends_with("_PROXY")
}

fn allowed_environment() -> Vec<(OsString, OsString)> {
    std::env::vars_os()
        .filter(|(name, _)| is_allowed_environment(name))
        .collect()
}

pub async fn spawn_process(
    binary: &BinaryInfo,
    workspace_root: &Path,
    generation: u64,
    signals: mpsc::Sender<RuntimeSignal>,
) -> Result<ProcessRuntime, ProcessError> {
    spawn_process_with_environment(
        binary,
        workspace_root,
        workspace_root,
        generation,
        signals,
        TurnExecutionClass::Main,
        false,
        allowed_environment(),
    )
    .await
}

pub(crate) async fn spawn_support_process(
    binary: &BinaryInfo,
    workspace_root: &Path,
    redaction_root: &Path,
    generation: u64,
    signals: mpsc::Sender<RuntimeSignal>,
    environment: Vec<(OsString, OsString)>,
) -> Result<ProcessRuntime, ProcessError> {
    spawn_process_with_environment(
        binary,
        workspace_root,
        redaction_root,
        generation,
        signals,
        TurnExecutionClass::Support,
        true,
        environment,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn spawn_process_with_environment(
    binary: &BinaryInfo,
    workspace_root: &Path,
    redaction_root: &Path,
    generation: u64,
    signals: mpsc::Sender<RuntimeSignal>,
    execution_class: TurnExecutionClass,
    strict_config: bool,
    environment: Vec<(OsString, OsString)>,
) -> Result<ProcessRuntime, ProcessError> {
    binary
        .revalidate()
        .await
        .map_err(|_| ProcessError::IdentityChanged)?;
    let mut command = Command::new(&binary.canonical_path);
    command.arg("app-server").arg("--listen").arg("stdio://");
    if strict_config {
        command.arg("--strict-config");
    }
    command
        .current_dir(workspace_root)
        .env_clear()
        .envs(environment)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    command.as_std_mut().process_group(0);

    let mut child = command.spawn().map_err(|_| ProcessError::Spawn)?;
    let pid = child.id().ok_or(ProcessError::Spawn)?;
    let mut process_group_guard = ProcessGroupDropGuard::new(pid);
    if binary.revalidate().await.is_err() {
        process_group_guard
            .terminate_child(&mut child, Duration::from_millis(200))
            .await;
        return Err(ProcessError::IdentityChanged);
    }
    let stdin = child.stdin.take().ok_or(ProcessError::MissingStdio)?;
    let stdout = child.stdout.take().ok_or(ProcessError::MissingStdio)?;
    let stderr = child.stderr.take().ok_or(ProcessError::MissingStdio)?;
    let connection = match execution_class {
        TurnExecutionClass::Main => RpcConnection::start(generation, stdin, stdout, signals),
        TurnExecutionClass::Support => RpcConnection::start_with_read_limits(
            generation,
            stdin,
            stdout,
            signals,
            RpcReadLimits::SUPPORT,
        ),
    };
    let stderr_ring = Arc::new(Mutex::new(VecDeque::new()));
    tokio::spawn(read_stderr(
        stderr,
        stderr_ring.clone(),
        redaction_root.to_path_buf(),
    ));

    let runtime = ProcessRuntime {
        connection,
        execution_class,
        child: Arc::new(Mutex::new(child)),
        stderr_ring,
        expected_shutdown: Arc::new(AtomicBool::new(false)),
        shutdown_complete: AtomicBool::new(false),
        shutdown_lock: Mutex::new(()),
        pid,
    };
    process_group_guard.disarm();
    Ok(runtime)
}

async fn read_stderr(
    mut stderr: tokio::process::ChildStderr,
    ring: Arc<Mutex<VecDeque<String>>>,
    workspace_root: std::path::PathBuf,
) {
    let mut buffer = vec![0_u8; 4096];
    loop {
        let count = match stderr.read(&mut buffer).await {
            Ok(0) | Err(_) => break,
            Ok(count) => count,
        };
        let text = String::from_utf8_lossy(&buffer[..count]);
        let text = redact_text(&text, Some(&workspace_root), 4096);
        let mut ring = ring.lock().await;
        ring.push_back(text);
        let mut bytes = ring.iter().map(String::len).sum::<usize>();
        while bytes > STDERR_RING_BYTES {
            if let Some(removed) = ring.pop_front() {
                bytes = bytes.saturating_sub(removed.len());
            } else {
                break;
            }
        }
    }
}

impl ProcessRuntime {
    pub fn execution_class(&self) -> TurnExecutionClass {
        self.execution_class
    }

    pub async fn shutdown(&self) {
        let _ = self.shutdown_checked().await;
    }

    pub(crate) async fn shutdown_checked(&self) -> Result<(), ProcessShutdownError> {
        self.stop_process_tree(true).await
    }

    pub(crate) async fn terminate_checked(&self) -> Result<(), ProcessShutdownError> {
        self.stop_process_tree(false).await
    }

    async fn stop_process_tree(&self, graceful: bool) -> Result<(), ProcessShutdownError> {
        let _shutdown = self.shutdown_lock.lock().await;
        if self.shutdown_complete.load(Ordering::Acquire) {
            return Ok(());
        }
        self.expected_shutdown.store(true, Ordering::Release);
        self.connection.close();

        if graceful {
            let deadline = tokio::time::Instant::now() + GRACEFUL_STDIN_WAIT;
            while tokio::time::Instant::now() < deadline {
                if process_tree_exited(&self.child, self.pid)
                    .await
                    .unwrap_or(false)
                {
                    self.connection.fail_pending().await;
                    self.shutdown_complete.store(true, Ordering::Release);
                    return Ok(());
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }

        let cleanup = {
            let mut child = self.child.lock().await;
            terminate_child_process_group(&mut child, self.pid, Duration::from_millis(200)).await
        };
        self.connection.fail_pending().await;
        if cleanup == ProcessGroupCleanupOutcome::Unconverged {
            return Err(ProcessShutdownError::ProcessTree);
        }
        self.shutdown_complete.store(true, Ordering::Release);
        Ok(())
    }

    pub(crate) fn force_shutdown_now(&self) {
        if self.shutdown_complete.load(Ordering::Acquire) {
            return;
        }
        self.expected_shutdown.store(true, Ordering::Release);
        self.connection.close();
        if let Ok(mut child) = self.child.try_lock() {
            if child.try_wait().ok().flatten().is_some() && !process_group_exists(self.pid) {
                self.shutdown_complete.store(true, Ordering::Release);
                return;
            }
            let _ = child.start_kill();
        }
        let _ = signal_process_group(self.pid, SIGKILL);
    }

    pub(crate) async fn force_shutdown_and_wait(&self, timeout: Duration) -> bool {
        self.force_shutdown_now();
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            if self.has_exited().await {
                self.connection.fail_pending().await;
                self.shutdown_complete.store(true, Ordering::Release);
                return true;
            }
            if tokio::time::Instant::now() >= deadline {
                return false;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    pub async fn has_exited(&self) -> bool {
        process_tree_exited(&self.child, self.pid)
            .await
            .unwrap_or(false)
    }

    pub fn expected_shutdown(&self) -> bool {
        self.expected_shutdown.load(Ordering::Acquire)
    }

    pub async fn redacted_stderr_size(&self) -> usize {
        self.stderr_ring.lock().await.iter().map(String::len).sum()
    }
}

impl Drop for ProcessRuntime {
    fn drop(&mut self) {
        self.force_shutdown_now();
    }
}

async fn process_tree_exited(child: &Arc<Mutex<Child>>, pid: u32) -> Result<bool, std::io::Error> {
    let child_exited = child.lock().await.try_wait()?.is_some();
    Ok(child_exited && !process_group_exists(pid))
}

const SIGTERM: i32 = 15;
const SIGKILL: i32 = 9;

unsafe extern "C" {
    fn kill(pid: i32, signal: i32) -> i32;
}

fn signal_process_group(pid: u32, signal: i32) -> Result<(), ()> {
    let pid = i32::try_from(pid).map_err(|_| ())?;
    // SAFETY: a negative pid targets the process group. No pointers cross the FFI boundary.
    let result = unsafe { kill(-pid, signal) };
    if result == 0 {
        Ok(())
    } else {
        Err(())
    }
}

pub(crate) fn process_group_exists(pid: u32) -> bool {
    signal_process_group(pid, 0).is_ok()
}

async fn terminate_child_process_group(
    child: &mut Child,
    pid: u32,
    term_grace: Duration,
) -> ProcessGroupCleanupOutcome {
    let _ = signal_process_group(pid, SIGTERM);
    let deadline = tokio::time::Instant::now() + term_grace;
    loop {
        let child_exited = matches!(child.try_wait(), Ok(Some(_)));
        if child_exited && !process_group_exists(pid) {
            return ProcessGroupCleanupOutcome::Converged;
        }
        if tokio::time::Instant::now() >= deadline {
            break;
        }
        tokio::time::sleep(PROCESS_GROUP_POLL_INTERVAL).await;
    }
    let _ = child.start_kill();
    let kill_deadline = tokio::time::Instant::now() + PROCESS_GROUP_KILL_WAIT;
    loop {
        let child_exited = matches!(child.try_wait(), Ok(Some(_)));
        let group_exists = process_group_exists(pid);
        if child_exited && !group_exists {
            return ProcessGroupCleanupOutcome::Converged;
        }
        if group_exists {
            let _ = signal_process_group(pid, SIGKILL);
        }
        let now = tokio::time::Instant::now();
        if now >= kill_deadline {
            return ProcessGroupCleanupOutcome::Unconverged;
        }
        tokio::time::sleep(PROCESS_GROUP_POLL_INTERVAL.min(kill_deadline - now)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::path::{Path, PathBuf};

    use tokio::task::AbortHandle;

    const FIXTURE_READY_WAIT: Duration = Duration::from_secs(2);
    const FIXTURE_EXIT_WAIT: Duration = Duration::from_secs(2);
    const FIXTURE_FALLBACK_TERM_WAIT: Duration = Duration::from_millis(100);

    #[test]
    fn environment_is_an_explicit_allowlist() {
        assert!(is_allowed_environment(OsStr::new("PATH")));
        assert!(is_allowed_environment(OsStr::new("HTTPS_PROXY")));
        assert!(!is_allowed_environment(OsStr::new("RANDOM_SECRET")));
        assert!(!is_allowed_environment(OsStr::new("BASH_ENV")));
    }

    fn process_tree_fixture() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/codex_process_tree_fixture.py")
    }

    fn temporary_state_file() -> PathBuf {
        std::env::temp_dir().join(format!(
            "coding-wife-process-tree-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ))
    }

    #[derive(Clone)]
    struct ProcessTreeFixturePaths {
        grandchild: PathBuf,
        parent: PathBuf,
        ready: PathBuf,
    }

    impl ProcessTreeFixturePaths {
        fn new() -> Self {
            Self {
                grandchild: temporary_state_file(),
                parent: temporary_state_file(),
                ready: temporary_state_file(),
            }
        }

        fn configure(&self, command: &mut Command) {
            command
                .env("CODING_WIFE_PROCESS_TREE_STATE", &self.grandchild)
                .env("CODING_WIFE_PROCESS_TREE_PARENT_STATE", &self.parent)
                .env("CODING_WIFE_PROCESS_TREE_READY_STATE", &self.ready);
        }

        fn all(&self) -> [&Path; 3] {
            [&self.grandchild, &self.parent, &self.ready]
        }
    }

    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    struct ProcessTreeFixtureIdentity {
        parent_pid: u32,
        process_group_id: u32,
        grandchild_pid: u32,
    }

    fn parse_positive_pid(value: &str) -> Option<u32> {
        value.trim().parse::<u32>().ok().filter(|pid| *pid > 0)
    }

    fn parse_ready_identity(value: &str) -> Option<ProcessTreeFixtureIdentity> {
        let mut fields = value.trim().split(':');
        let parent_pid = parse_positive_pid(fields.next()?)?;
        let process_group_id = parse_positive_pid(fields.next()?)?;
        let grandchild_pid = parse_positive_pid(fields.next()?)?;
        if fields.next().is_some() || process_group_id != parent_pid {
            return None;
        }
        Some(ProcessTreeFixtureIdentity {
            parent_pid,
            process_group_id,
            grandchild_pid,
        })
    }

    fn read_fixture_identity(
        paths: &ProcessTreeFixturePaths,
    ) -> Option<ProcessTreeFixtureIdentity> {
        let identity = parse_ready_identity(&std::fs::read_to_string(&paths.ready).ok()?)?;
        let parent_pid = parse_positive_pid(&std::fs::read_to_string(&paths.parent).ok()?)?;
        let grandchild_pid = parse_positive_pid(&std::fs::read_to_string(&paths.grandchild).ok()?)?;
        if identity.parent_pid != parent_pid || identity.grandchild_pid != grandchild_pid {
            return None;
        }
        Some(identity)
    }

    async fn wait_for_fixture_ready(paths: &ProcessTreeFixturePaths) -> ProcessTreeFixtureIdentity {
        let deadline = tokio::time::Instant::now() + FIXTURE_READY_WAIT;
        loop {
            if let Some(identity) = read_fixture_identity(paths) {
                return identity;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "process-tree fixture did not atomically publish a valid ready identity"
            );
            tokio::time::sleep(PROCESS_GROUP_POLL_INTERVAL).await;
        }
    }

    fn signal_process(pid: u32, signal: i32) -> Result<(), ()> {
        let pid = i32::try_from(pid).map_err(|_| ())?;
        // SAFETY: the fixture guard owns this positive process identifier.
        let result = unsafe { kill(pid, signal) };
        if result == 0 {
            Ok(())
        } else {
            Err(())
        }
    }

    fn process_exists(pid: u32) -> bool {
        signal_process(pid, 0).is_ok()
    }

    fn fixture_identity_exists(identity: ProcessTreeFixtureIdentity) -> bool {
        process_group_exists(identity.process_group_id)
            || process_exists(identity.parent_pid)
            || process_exists(identity.grandchild_pid)
    }

    async fn wait_for_fixture_exit(identity: ProcessTreeFixtureIdentity) -> bool {
        let deadline = tokio::time::Instant::now() + FIXTURE_EXIT_WAIT;
        while fixture_identity_exists(identity) && tokio::time::Instant::now() < deadline {
            tokio::time::sleep(PROCESS_GROUP_POLL_INTERVAL).await;
        }
        !fixture_identity_exists(identity)
    }

    fn pending_state_path(path: &Path) -> PathBuf {
        let mut name = path
            .file_name()
            .expect("fixture state file name")
            .to_os_string();
        name.push(".pending");
        path.with_file_name(name)
    }

    fn read_published_or_pending_state(path: &Path) -> Option<String> {
        std::fs::read_to_string(path)
            .ok()
            .or_else(|| std::fs::read_to_string(pending_state_path(path)).ok())
    }

    struct ProcessTreeFixtureGuard {
        paths: ProcessTreeFixturePaths,
        task_abort: Option<AbortHandle>,
        identity: Option<ProcessTreeFixtureIdentity>,
        known_parent_pid: Option<u32>,
        process_cleanup_armed: bool,
    }

    impl ProcessTreeFixtureGuard {
        fn new(paths: ProcessTreeFixturePaths) -> Self {
            Self {
                paths,
                task_abort: None,
                identity: None,
                known_parent_pid: None,
                process_cleanup_armed: true,
            }
        }

        fn remember_parent_pid(&mut self, pid: u32) {
            self.known_parent_pid = Some(pid);
        }

        fn remember_identity(&mut self, identity: ProcessTreeFixtureIdentity) {
            self.known_parent_pid = Some(identity.parent_pid);
            self.identity = Some(identity);
        }

        fn set_task_abort(&mut self, task_abort: AbortHandle) {
            self.task_abort = Some(task_abort);
        }

        fn clear_task_abort(&mut self) {
            self.task_abort = None;
        }

        fn disarm_process_cleanup(&mut self) {
            self.process_cleanup_armed = false;
        }

        fn recovery_targets(&self) -> (Option<u32>, Vec<u32>) {
            let identity = self
                .identity
                .or_else(|| read_fixture_identity(&self.paths))
                .or_else(|| {
                    read_published_or_pending_state(&self.paths.ready)
                        .as_deref()
                        .and_then(parse_ready_identity)
                });
            let process_group_id = identity
                .map(|identity| identity.process_group_id)
                .or(self.known_parent_pid)
                .or_else(|| {
                    read_published_or_pending_state(&self.paths.parent)
                        .as_deref()
                        .and_then(parse_positive_pid)
                });
            let mut processes = Vec::new();
            for pid in [
                identity.map(|identity| identity.parent_pid),
                identity.map(|identity| identity.grandchild_pid),
                self.known_parent_pid,
                read_published_or_pending_state(&self.paths.grandchild)
                    .as_deref()
                    .and_then(parse_positive_pid),
            ]
            .into_iter()
            .flatten()
            {
                if !processes.contains(&pid) {
                    processes.push(pid);
                }
            }
            (process_group_id, processes)
        }

        fn remove_state_files(&self) {
            for path in self.paths.all() {
                let _ = std::fs::remove_file(path);
                let _ = std::fs::remove_file(pending_state_path(path));
            }
        }
    }

    fn fixture_targets_exist(process_group_id: Option<u32>, processes: &[u32]) -> bool {
        process_group_id.is_some_and(process_group_exists)
            || processes.iter().copied().any(process_exists)
    }

    fn signal_fixture_targets(process_group_id: Option<u32>, processes: &[u32], signal: i32) {
        if let Some(process_group_id) = process_group_id {
            let _ = signal_process_group(process_group_id, signal);
        }
        for pid in processes {
            let _ = signal_process(*pid, signal);
        }
    }

    fn emergency_cleanup_fixture(process_group_id: Option<u32>, processes: &[u32]) {
        signal_fixture_targets(process_group_id, processes, SIGTERM);
        let term_deadline = Instant::now() + FIXTURE_FALLBACK_TERM_WAIT;
        while fixture_targets_exist(process_group_id, processes) && Instant::now() < term_deadline {
            std::thread::sleep(PROCESS_GROUP_POLL_INTERVAL);
        }
        let kill_deadline = Instant::now() + PROCESS_GROUP_KILL_WAIT;
        while fixture_targets_exist(process_group_id, processes) && Instant::now() < kill_deadline {
            signal_fixture_targets(process_group_id, processes, SIGKILL);
            std::thread::sleep(PROCESS_GROUP_POLL_INTERVAL);
        }
        if fixture_targets_exist(process_group_id, processes) {
            signal_fixture_targets(process_group_id, processes, SIGKILL);
        }
    }

    impl Drop for ProcessTreeFixtureGuard {
        fn drop(&mut self) {
            if let Some(task_abort) = self.task_abort.take() {
                task_abort.abort();
            }
            if self.process_cleanup_armed {
                let (process_group_id, processes) = self.recovery_targets();
                emergency_cleanup_fixture(process_group_id, &processes);
            }
            self.remove_state_files();
        }
    }

    fn fixture_command(paths: &ProcessTreeFixturePaths) -> Command {
        let mut command = Command::new(process_tree_fixture());
        paths.configure(&mut command);
        command
    }

    #[test]
    fn forced_group_cleanup_retries_when_the_first_kill_misses_a_late_descendant() {
        let surviving_members = Cell::new(2_u8);
        let signal_count = Cell::new(0_u8);
        let converged = force_kill_process_group_until_gone_with(
            41,
            Duration::from_millis(50),
            |_| {
                signal_count.set(signal_count.get() + 1);
                surviving_members.set(surviving_members.get().saturating_sub(1));
                Ok(())
            },
            |_| surviving_members.get() > 0,
            |_| {},
        );
        assert!(converged, "a later KILL must remove the late descendant");
        assert_eq!(signal_count.get(), 2, "cleanup must retry the group KILL");
    }

    #[test]
    fn forced_group_cleanup_reports_a_group_that_misses_the_kill_deadline() {
        let signal_count = Cell::new(0_u8);
        let converged = force_kill_process_group_until_gone_with(
            42,
            Duration::ZERO,
            |_| {
                signal_count.set(signal_count.get() + 1);
                Ok(())
            },
            |_| true,
            |_| {},
        );
        assert!(!converged, "an unconverged group must remain a failure");
        assert_eq!(signal_count.get(), 1);
    }

    #[test]
    fn converged_cleanup_disarms_before_the_numeric_process_group_is_reused() {
        let unrelated_signal_count = Cell::new(0_u8);
        let mut guard = ProcessGroupDropGuard::new(43);
        guard.apply_cleanup_outcome(ProcessGroupCleanupOutcome::Converged);

        guard.cleanup_on_drop_with(
            |pid| {
                assert_eq!(pid, 43);
                true
            },
            |_| unrelated_signal_count.set(unrelated_signal_count.get() + 1),
        );

        assert_eq!(
            unrelated_signal_count.get(),
            0,
            "a reused process-group identifier must not receive fallback cleanup"
        );
    }

    #[test]
    fn unconverged_cleanup_keeps_the_drop_fallback_armed() {
        let fallback_signal_count = Cell::new(0_u8);
        let mut guard = ProcessGroupDropGuard::new(44);
        guard.apply_cleanup_outcome(ProcessGroupCleanupOutcome::Unconverged);

        guard.cleanup_on_drop_with(
            |_| true,
            |_| fallback_signal_count.set(fallback_signal_count.get() + 1),
        );

        assert_eq!(fallback_signal_count.get(), 1);
        guard.disarm();
    }

    #[tokio::test]
    async fn direct_group_shutdown_kills_a_grandchild_holding_stdio() {
        let paths = ProcessTreeFixturePaths::new();
        let mut fixture_guard = ProcessTreeFixtureGuard::new(paths.clone());
        let mut command = fixture_command(&paths);
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        command.as_std_mut().process_group(0);
        let mut child = command.spawn().expect("spawn process-tree fixture");
        let pid = child.id().expect("fixture pid");
        let mut process_group_guard = ProcessGroupDropGuard::new(pid);
        fixture_guard.remember_parent_pid(pid);
        let identity = wait_for_fixture_ready(&paths).await;
        fixture_guard.remember_identity(identity);
        assert_eq!(identity.parent_pid, pid);

        let started = Instant::now();
        process_group_guard
            .terminate_child(&mut child, Duration::from_millis(100))
            .await;
        assert!(started.elapsed() < TOTAL_SHUTDOWN_WAIT);
        assert!(
            wait_for_fixture_exit(identity).await,
            "process tree survived direct shutdown"
        );
        let unrelated_signal_count = Cell::new(0_u8);
        process_group_guard.cleanup_on_drop_with(
            |_| true,
            |_| unrelated_signal_count.set(unrelated_signal_count.get() + 1),
        );
        assert_eq!(
            unrelated_signal_count.get(),
            0,
            "converged cleanup must disarm before the numeric group is reused"
        );
        fixture_guard.disarm_process_cleanup();
    }

    #[tokio::test]
    async fn exited_parent_does_not_hide_a_grandchild_holding_stdio() {
        let paths = ProcessTreeFixturePaths::new();
        let mut fixture_guard = ProcessTreeFixtureGuard::new(paths.clone());
        let mut command = fixture_command(&paths);
        command
            .env("CODING_WIFE_PROCESS_TREE_PARENT_EXIT", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        command.as_std_mut().process_group(0);
        let mut child = command.spawn().expect("spawn process-tree fixture");
        let pid = child.id().expect("fixture pid");
        fixture_guard.remember_parent_pid(pid);
        let identity = wait_for_fixture_ready(&paths).await;
        fixture_guard.remember_identity(identity);
        assert_eq!(identity.parent_pid, pid);
        child.wait().await.expect("parent exits");
        assert!(process_group_exists(pid), "grandchild fixture is alive");

        assert_eq!(
            terminate_child_process_group(&mut child, pid, Duration::from_millis(100)).await,
            ProcessGroupCleanupOutcome::Converged,
            "grandchild process group did not converge after SIGKILL",
        );
        assert!(
            wait_for_fixture_exit(identity).await,
            "grandchild process tree survived"
        );
        fixture_guard.disarm_process_cleanup();
    }

    #[tokio::test]
    async fn bounded_command_stops_oversized_stdout_and_stderr() {
        let mut stdout_command = Command::new("/usr/bin/python3");
        stdout_command.args([
            "-c",
            "import sys,time; sys.stdout.write('x' * 65536); sys.stdout.flush(); time.sleep(30)",
        ]);
        assert_eq!(
            run_bounded_command(stdout_command, Duration::from_secs(2), 1024, 4096)
                .await
                .expect_err("stdout limit"),
            BoundedCommandError::StdoutLimit
        );

        let mut stderr_command = Command::new("/usr/bin/python3");
        stderr_command.args([
            "-c",
            "import sys,time; sys.stderr.write('x' * 65536); sys.stderr.flush(); time.sleep(30)",
        ]);
        assert_eq!(
            run_bounded_command(stderr_command, Duration::from_secs(2), 4096, 1024)
                .await
                .expect_err("stderr limit"),
            BoundedCommandError::StderrLimit
        );
    }

    #[tokio::test]
    async fn bounded_command_times_out_and_removes_the_process_tree() {
        let paths = ProcessTreeFixturePaths::new();
        let mut fixture_guard = ProcessTreeFixtureGuard::new(paths.clone());
        let command = fixture_command(&paths);
        let started = Instant::now();
        let task = tokio::spawn(run_bounded_command(
            command,
            Duration::from_millis(500),
            4096,
            4096,
        ));
        fixture_guard.set_task_abort(task.abort_handle());
        let identity = wait_for_fixture_ready(&paths).await;
        fixture_guard.remember_identity(identity);
        let result = task.await.expect("bounded command task");
        fixture_guard.clear_task_abort();
        assert_eq!(
            result.expect_err("fixture must time out"),
            BoundedCommandError::Timeout
        );
        assert!(started.elapsed() < Duration::from_secs(3));
        assert!(
            wait_for_fixture_exit(identity).await,
            "timed-out process tree survived"
        );
        fixture_guard.disarm_process_cleanup();
    }

    #[tokio::test]
    async fn canceled_bounded_command_removes_the_process_tree() {
        let paths = ProcessTreeFixturePaths::new();
        let mut fixture_guard = ProcessTreeFixtureGuard::new(paths.clone());
        let command = fixture_command(&paths);
        let task = tokio::spawn(run_bounded_command(
            command,
            Duration::from_secs(30),
            4096,
            4096,
        ));
        fixture_guard.set_task_abort(task.abort_handle());
        let identity = wait_for_fixture_ready(&paths).await;
        fixture_guard.remember_identity(identity);

        task.abort();
        assert!(task.await.expect_err("task canceled").is_cancelled());
        fixture_guard.clear_task_abort();
        assert!(
            wait_for_fixture_exit(identity).await,
            "canceled process tree survived",
        );
        fixture_guard.disarm_process_cleanup();
    }

    #[tokio::test]
    async fn fixture_guard_removes_processes_and_state_when_the_test_path_unwinds() {
        let paths = ProcessTreeFixturePaths::new();
        let mut command = fixture_command(&paths);
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        command.as_std_mut().process_group(0);
        let mut child = command.spawn().expect("spawn process-tree fixture");
        let pid = child.id().expect("fixture pid");
        let mut fixture_guard = ProcessTreeFixtureGuard::new(paths.clone());
        fixture_guard.remember_parent_pid(pid);
        let identity = wait_for_fixture_ready(&paths).await;
        fixture_guard.remember_identity(identity);

        drop(fixture_guard);
        child.wait().await.expect("reap fixture parent");
        assert!(
            wait_for_fixture_exit(identity).await,
            "fallback guard left a fixture process alive"
        );
        for path in paths.all() {
            assert!(!path.exists(), "fallback guard left a fixture state file");
            assert!(
                !pending_state_path(path).exists(),
                "fallback guard left an atomic pending file"
            );
        }
    }
}
