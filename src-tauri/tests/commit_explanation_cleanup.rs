#![cfg(debug_assertions)]

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::Duration;

use coding_wife_lib::codex::binary::{discover_binary, probe_schema, BinaryInfo};
use coding_wife_lib::codex::support::{SupportRuntime, SupportRuntimeError};
use coding_wife_lib::codex::types::BinarySource;

fn shell_quote(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', "'\"'\"'"))
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

fn process_group_exists(pid: u32) -> bool {
    let Ok(pid) = i32::try_from(pid) else {
        return false;
    };
    // SAFETY: signal zero only probes the isolated fixture process group.
    unsafe { libc::kill(-pid, 0) == 0 }
}

fn last_recorded_pid(state: &str, prefix: &str) -> u32 {
    state
        .lines()
        .rev()
        .find_map(|line| line.strip_prefix(prefix)?.parse::<u32>().ok())
        .unwrap_or_else(|| panic!("missing {prefix:?} in state: {state}"))
}

async fn read_ready_state(path: &Path) -> String {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    loop {
        let state = tokio::fs::read_to_string(path).await.unwrap_or_default();
        if state.matches("support_process_started:").count() >= 2
            && state
                .matches("support_wrapper_resistant_grandchild:")
                .count()
                >= 2
        {
            return state;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "support construction fixture did not become ready: {state}"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

async fn wait_for_process_group_exit(pid: u32) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    while process_group_exists(pid) && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(
        !process_group_exists(pid),
        "support process group {pid} survived forced cleanup"
    );
}

struct ProcessGroupGuard(u32);

impl Drop for ProcessGroupGuard {
    fn drop(&mut self) {
        if let Ok(pid) = i32::try_from(self.0) {
            // SAFETY: the guard owns the isolated fixture process group.
            let _ = unsafe { libc::kill(-pid, libc::SIGKILL) };
        }
    }
}

struct SupportFixture {
    root: PathBuf,
    binary: PathBuf,
    state: PathBuf,
    auth: PathBuf,
}

impl SupportFixture {
    fn new() -> Self {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("repository root")
            .join(".context")
            .join(format!(
                "support-cleanup-fixture-{}-{}",
                std::process::id(),
                uuid::Uuid::new_v4()
            ));
        std::fs::create_dir_all(&root).expect("fixture root");
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700))
            .expect("fixture root mode");
        let state = root.join("state.log");
        let auth = root.join("auth.json");
        std::fs::write(&auth, br#"{"fixture":"support-auth"}"#).expect("fixture auth");
        std::fs::set_permissions(&auth, std::fs::Permissions::from_mode(0o600))
            .expect("fixture auth mode");
        let source = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/fake_codex_app_server.py");
        let binary = root.join("codex");
        let script = format!(
            "#!/bin/sh\n\
             export CODING_WIFE_CODEX_FAKE_MODE=default\n\
             export CODING_WIFE_CODEX_FAKE_STATE={}\n\
             if [ \"${{1:-}}\" = \"app-server\" ] && [ \"${{2:-}}\" != \"generate-json-schema\" ]; then\n\
               /usr/bin/python3 -c 'import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(120)' </dev/null >/dev/null 2>/dev/null &\n\
               printf 'support_wrapper_resistant_grandchild:%s\n' \"$!\" >> {}\n\
             fi\n\
             exec {} \"$@\"\n",
            shell_quote(&state),
            shell_quote(&state),
            shell_quote(&source),
        );
        std::fs::write(&binary, script).expect("fixture wrapper");
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700))
            .expect("fixture wrapper mode");
        Self {
            root,
            binary,
            state,
            auth,
        }
    }

    async fn binary(&self) -> BinaryInfo {
        let mut binary = discover_binary(Some(&self.binary))
            .await
            .expect("fixture binary");
        binary.source = BinarySource::TestFixture;
        binary
    }
}

impl Drop for SupportFixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[tokio::test]
async fn failed_initialization_retains_cleanup_until_force_confirms_process_absence() {
    let before = current_support_run_directories();
    let fixture = SupportFixture::new();
    let binary = fixture.binary().await;
    let schema = probe_schema(&binary).await.expect("fixture schema");

    let error = match SupportRuntime::construct_with_test_faults(
        &binary,
        &schema,
        Path::new(env!("CARGO_MANIFEST_DIR")),
        Some(&fixture.auth),
        true,
        true,
    )
    .await
    {
        Ok(runtime) => {
            runtime
                .shutdown()
                .await
                .expect("unexpected runtime cleanup");
            panic!("injected initialization failure must fail construction");
        }
        Err(error) => error,
    };
    assert_eq!(error.reason(), SupportRuntimeError::Protocol);
    assert!(!error.cleanup_converged());
    let state = read_ready_state(&fixture.state).await;
    let pid = last_recorded_pid(&state, "support_process_started:");
    let _process_guard = ProcessGroupGuard(pid);
    assert!(process_group_exists(pid));

    assert!(error.force_shutdown_now().await);
    wait_for_process_group_exit(pid).await;
    assert!(error.cleanup_converged());
    assert!(error.force_shutdown_now().await);
    assert_eq!(current_support_run_directories(), before);
    assert!(!state.contains("/Users/"));
    assert!(!state.contains("token="));
}
