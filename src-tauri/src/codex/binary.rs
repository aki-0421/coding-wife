use std::ffi::OsString;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use sha2::{Digest, Sha256};
use thiserror::Error;
use tokio::io::AsyncReadExt;
use tokio::process::Command;

use super::types::{BinarySource, CapabilityState, CodexCapabilities};

const PROBE_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_PROBE_OUTPUT_BYTES: usize = 1024 * 1024;

#[derive(Clone, Debug)]
pub struct BinaryInfo {
    pub canonical_path: PathBuf,
    pub canonical_path_hash: String,
    pub executable_sha256: String,
    pub cli_version: String,
    pub source: BinarySource,
}

#[derive(Clone, Debug)]
pub struct SchemaProbe {
    pub fingerprint: String,
    pub generated_by_same_binary: bool,
    pub capabilities: CodexCapabilities,
}

#[derive(Debug, Error)]
pub enum BinaryError {
    #[error("no Codex executable was found")]
    Missing,
    #[error("the selected Codex executable was not trusted")]
    Untrusted,
    #[error("the Codex probe timed out")]
    Timeout,
    #[error("the Codex probe failed")]
    ProbeFailed,
    #[error("the Codex schema was unsupported")]
    SchemaUnsupported,
    #[error("an I/O error occurred while probing Codex")]
    Io,
}

fn candidate_paths(explicit_path: Option<&Path>) -> Vec<(PathBuf, BinarySource)> {
    if let Some(path) = explicit_path {
        return vec![(path.to_path_buf(), BinarySource::Explicit)];
    }

    let mut candidates = Vec::new();
    if let Some(path) = std::env::var_os("PATH") {
        for directory in std::env::split_paths(&path) {
            candidates.push((directory.join("codex"), BinarySource::Path));
        }
    }

    candidates.push((
        PathBuf::from("/opt/homebrew/bin/codex"),
        BinarySource::KnownInstall,
    ));
    candidates.push((
        PathBuf::from("/usr/local/bin/codex"),
        BinarySource::KnownInstall,
    ));
    if let Some(home) = std::env::var_os("HOME") {
        candidates.push((
            PathBuf::from(home).join("Library/Application Support/com.conductor.app/bin/codex"),
            BinarySource::KnownInstall,
        ));
    }

    candidates
}

async fn sha256_file(path: &Path) -> Result<String, BinaryError> {
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|_| BinaryError::Io)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer).await.map_err(|_| BinaryError::Io)?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(hex::encode(hasher.finalize()))
}

async fn run_bounded(path: &Path, args: &[OsString]) -> Result<std::process::Output, BinaryError> {
    let mut command = Command::new(path);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let output = tokio::time::timeout(PROBE_TIMEOUT, command.output())
        .await
        .map_err(|_| BinaryError::Timeout)?
        .map_err(|_| BinaryError::ProbeFailed)?;
    if !output.status.success()
        || output.stdout.len() > MAX_PROBE_OUTPUT_BYTES
        || output.stderr.len() > MAX_PROBE_OUTPUT_BYTES
    {
        return Err(BinaryError::ProbeFailed);
    }
    Ok(output)
}

pub async fn discover_binary(explicit_path: Option<&Path>) -> Result<BinaryInfo, BinaryError> {
    let explicit = explicit_path.is_some();
    for (candidate, source) in candidate_paths(explicit_path) {
        let canonical_path = match tokio::fs::canonicalize(&candidate).await {
            Ok(path) => path,
            Err(_) if explicit => return Err(BinaryError::Missing),
            Err(_) => continue,
        };
        let metadata = tokio::fs::metadata(&canonical_path)
            .await
            .map_err(|_| BinaryError::Io)?;
        let mode = metadata.permissions().mode();
        if !metadata.is_file() || mode & 0o111 == 0 || mode & 0o022 != 0 {
            if explicit {
                return Err(BinaryError::Untrusted);
            }
            continue;
        }

        let output = run_bounded(&canonical_path, &[OsString::from("--version")]).await?;
        let version_output =
            String::from_utf8(output.stdout).map_err(|_| BinaryError::ProbeFailed)?;
        let cli_version = version_output
            .trim()
            .strip_prefix("codex-cli ")
            .ok_or(BinaryError::ProbeFailed)?
            .to_owned();
        let executable_sha256 = sha256_file(&canonical_path).await?;
        let canonical_path_hash =
            hex::encode(Sha256::digest(canonical_path.to_string_lossy().as_bytes()));

        return Ok(BinaryInfo {
            canonical_path,
            canonical_path_hash,
            executable_sha256,
            cli_version,
            source,
        });
    }

    Err(BinaryError::Missing)
}

fn collect_schema_files(root: &Path) -> Result<Vec<PathBuf>, BinaryError> {
    fn visit(directory: &Path, files: &mut Vec<PathBuf>) -> Result<(), BinaryError> {
        for entry in std::fs::read_dir(directory).map_err(|_| BinaryError::Io)? {
            let entry = entry.map_err(|_| BinaryError::Io)?;
            let path = entry.path();
            if path.is_dir() {
                visit(&path, files)?;
            } else if path.is_file() {
                files.push(path);
            }
        }
        Ok(())
    }

    let mut files = Vec::new();
    visit(root, &mut files)?;
    files.sort();
    Ok(files)
}

fn fingerprint_schema(root: &Path) -> Result<(String, Vec<u8>), BinaryError> {
    let files = collect_schema_files(root)?;
    if files.is_empty() {
        return Err(BinaryError::SchemaUnsupported);
    }

    let mut hasher = Sha256::new();
    let mut searchable = Vec::new();
    for file in files {
        let relative = file.strip_prefix(root).map_err(|_| BinaryError::Io)?;
        let bytes = std::fs::read(&file).map_err(|_| BinaryError::Io)?;
        hasher.update(relative.to_string_lossy().as_bytes());
        hasher.update([0]);
        hasher.update(&bytes);
        hasher.update([0]);
        if searchable.len() < 64 * 1024 * 1024 {
            searchable.extend_from_slice(&bytes);
            searchable.push(b'\n');
        }
    }
    Ok((hex::encode(hasher.finalize()), searchable))
}

fn contains_all(haystack: &str, needles: &[&str]) -> bool {
    needles.iter().all(|needle| haystack.contains(needle))
}

pub async fn probe_schema(binary: &BinaryInfo) -> Result<SchemaProbe, BinaryError> {
    let output_dir = std::env::temp_dir().join(format!(
        "coding-wife-codex-schema-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    tokio::fs::create_dir_all(&output_dir)
        .await
        .map_err(|_| BinaryError::Io)?;

    let args = [
        OsString::from("app-server"),
        OsString::from("generate-json-schema"),
        OsString::from("--experimental"),
        OsString::from("--out"),
        output_dir.clone().into_os_string(),
    ];
    let result = run_bounded(&binary.canonical_path, &args).await;
    if let Err(error) = result {
        let _ = tokio::fs::remove_dir_all(&output_dir).await;
        return Err(error);
    }

    let root = output_dir.clone();
    let fingerprint_result = tokio::task::spawn_blocking(move || fingerprint_schema(&root))
        .await
        .map_err(|_| BinaryError::Io)?;
    let _ = tokio::fs::remove_dir_all(&output_dir).await;
    let (fingerprint, searchable) = fingerprint_result?;
    let schema_text = String::from_utf8(searchable).map_err(|_| BinaryError::SchemaUnsupported)?;

    let core = contains_all(
        &schema_text,
        &[
            "thread/list",
            "thread/start",
            "thread/resume",
            "turn/start",
            "turn/interrupt",
            "review/start",
            "account/read",
            "config/read",
            "model/list",
        ],
    );
    if !core {
        return Err(BinaryError::SchemaUnsupported);
    }

    let state = |supported| {
        if supported {
            CapabilityState::Supported
        } else {
            CapabilityState::Unavailable
        }
    };
    let capabilities = CodexCapabilities {
        core_lifecycle: CapabilityState::Supported,
        model_discovery: state(schema_text.contains("model/list")),
        native_request_user_input: state(
            schema_text.contains("item/tool/requestUserInput")
                && schema_text.contains("ToolRequestUserInput"),
        ),
        dynamic_tools: state(
            schema_text.contains("item/tool/call") && schema_text.contains("dynamicTools"),
        ),
        permissions_approval: state(schema_text.contains("item/permissions/requestApproval")),
        detached_review: state(
            schema_text.contains("review/start") && schema_text.contains("detached"),
        ),
        ephemeral_thread: state(schema_text.contains("ephemeral")),
        support_isolation: CapabilityState::Unavailable,
    };

    Ok(SchemaProbe {
        fingerprint,
        generated_by_same_binary: true,
        capabilities,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_path_is_the_only_candidate() {
        let candidates = candidate_paths(Some(Path::new("/fixture/codex")));
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].0, Path::new("/fixture/codex"));
        assert_eq!(candidates[0].1, BinarySource::Explicit);
    }

    #[test]
    fn schema_capability_search_is_exact() {
        assert!(contains_all(
            "thread/start model/list",
            &["thread/start", "model/list"]
        ));
        assert!(!contains_all(
            "thread/start model/listing",
            &["model/list\""]
        ));
    }
}
