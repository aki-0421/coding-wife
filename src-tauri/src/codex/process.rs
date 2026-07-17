use std::collections::VecDeque;
use std::ffi::{OsStr, OsString};
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use thiserror::Error;
use tokio::io::AsyncReadExt;
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, Mutex};

use super::binary::BinaryInfo;
use super::redaction::redact_text;
use super::rpc::{RpcConnection, RuntimeSignal};

const STDERR_RING_BYTES: usize = 64 * 1024;
const GRACEFUL_STDIN_WAIT: Duration = Duration::from_secs(2);
const TOTAL_SHUTDOWN_WAIT: Duration = Duration::from_secs(5);

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
    child: Arc<Mutex<Child>>,
    stderr_ring: Arc<Mutex<VecDeque<String>>>,
    expected_shutdown: Arc<AtomicBool>,
    pid: u32,
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
    binary
        .revalidate()
        .await
        .map_err(|_| ProcessError::IdentityChanged)?;
    let mut command = Command::new(&binary.canonical_path);
    command
        .arg("app-server")
        .arg("--listen")
        .arg("stdio://")
        .current_dir(workspace_root)
        .env_clear()
        .envs(allowed_environment())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    command.as_std_mut().process_group(0);

    let mut child = command.spawn().map_err(|_| ProcessError::Spawn)?;
    let pid = child.id().ok_or(ProcessError::Spawn)?;
    if binary.revalidate().await.is_err() {
        terminate_child_process_group(&mut child, pid, Duration::from_millis(200)).await;
        return Err(ProcessError::IdentityChanged);
    }
    let stdin = child.stdin.take().ok_or(ProcessError::MissingStdio)?;
    let stdout = child.stdout.take().ok_or(ProcessError::MissingStdio)?;
    let stderr = child.stderr.take().ok_or(ProcessError::MissingStdio)?;
    let connection = RpcConnection::start(generation, stdin, stdout, signals);
    let stderr_ring = Arc::new(Mutex::new(VecDeque::new()));
    tokio::spawn(read_stderr(
        stderr,
        stderr_ring.clone(),
        workspace_root.to_path_buf(),
    ));

    Ok(ProcessRuntime {
        connection,
        child: Arc::new(Mutex::new(child)),
        stderr_ring,
        expected_shutdown: Arc::new(AtomicBool::new(false)),
        pid,
    })
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
    pub async fn shutdown(&self) {
        self.expected_shutdown.store(true, Ordering::Release);
        self.connection.close();
        let started = tokio::time::Instant::now();

        while started.elapsed() < GRACEFUL_STDIN_WAIT {
            if process_tree_exited(&self.child, self.pid)
                .await
                .unwrap_or(false)
            {
                self.connection.fail_pending().await;
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }

        let _ = signal_process_group(self.pid, SIGTERM);
        while started.elapsed() < TOTAL_SHUTDOWN_WAIT {
            if process_tree_exited(&self.child, self.pid)
                .await
                .unwrap_or(false)
            {
                self.connection.fail_pending().await;
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }

        let _ = signal_process_group(self.pid, SIGKILL);
        let _ = self.child.lock().await.kill().await;
        self.connection.fail_pending().await;
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

pub(super) fn process_group_exists(pid: u32) -> bool {
    signal_process_group(pid, 0).is_ok()
}

pub(super) async fn terminate_child_process_group(
    child: &mut Child,
    pid: u32,
    term_grace: Duration,
) {
    let _ = signal_process_group(pid, SIGTERM);
    let deadline = tokio::time::Instant::now() + term_grace;
    loop {
        let _ = child.try_wait();
        if !process_group_exists(pid) {
            return;
        }
        if tokio::time::Instant::now() >= deadline {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let _ = signal_process_group(pid, SIGKILL);
    if !matches!(child.try_wait(), Ok(Some(_))) {
        let _ = child.kill().await;
    }
    let _ = tokio::time::timeout(Duration::from_millis(500), child.wait()).await;
    let kill_deadline = tokio::time::Instant::now() + Duration::from_millis(500);
    while process_group_exists(pid) && tokio::time::Instant::now() < kill_deadline {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::time::Instant;

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

    #[tokio::test]
    async fn direct_group_shutdown_kills_a_grandchild_holding_stdio() {
        let state = temporary_state_file();
        let mut command = Command::new(process_tree_fixture());
        command
            .env("CODING_WIFE_PROCESS_TREE_STATE", &state)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        command.as_std_mut().process_group(0);
        let mut child = command.spawn().expect("spawn process-tree fixture");
        let pid = child.id().expect("fixture pid");
        let ready_deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        while !state.exists() {
            assert!(
                tokio::time::Instant::now() < ready_deadline,
                "grandchild fixture did not become ready"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }

        let started = Instant::now();
        terminate_child_process_group(&mut child, pid, Duration::from_millis(100)).await;
        assert!(started.elapsed() < TOTAL_SHUTDOWN_WAIT);
        let gone_deadline = tokio::time::Instant::now() + Duration::from_secs(1);
        while process_group_exists(pid) && tokio::time::Instant::now() < gone_deadline {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(!process_group_exists(pid), "process group survived SIGKILL");
        let _ = std::fs::remove_file(state);
    }

    #[tokio::test]
    async fn exited_parent_does_not_hide_a_grandchild_holding_stdio() {
        let state = temporary_state_file();
        let mut command = Command::new(process_tree_fixture());
        command
            .env("CODING_WIFE_PROCESS_TREE_STATE", &state)
            .env("CODING_WIFE_PROCESS_TREE_PARENT_EXIT", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        command.as_std_mut().process_group(0);
        let mut child = command.spawn().expect("spawn process-tree fixture");
        let pid = child.id().expect("fixture pid");
        let ready_deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        while !state.exists() {
            assert!(
                tokio::time::Instant::now() < ready_deadline,
                "grandchild fixture did not become ready"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        child.wait().await.expect("parent exits");
        assert!(process_group_exists(pid), "grandchild fixture is alive");

        terminate_child_process_group(&mut child, pid, Duration::from_millis(100)).await;
        assert!(
            !process_group_exists(pid),
            "grandchild process group survived"
        );
        let _ = std::fs::remove_file(state);
    }
}
