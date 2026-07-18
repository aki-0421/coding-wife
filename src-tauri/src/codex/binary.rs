use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fs::File;
use std::io::{BufReader, Read};
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use thiserror::Error;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;
use tokio::sync::mpsc;

use super::process::{process_group_exists, terminate_child_process_group};
use super::types::{BinarySource, CapabilityState, CodexCapabilities};

const PROBE_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_PROBE_OUTPUT_BYTES: usize = 1024 * 1024;
const MAX_SCHEMA_DEPTH: usize = 16;
const MAX_SCHEMA_FILES: usize = 2_048;
const MAX_SCHEMA_FILE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_SCHEMA_TOTAL_BYTES: u64 = 64 * 1024 * 1024;
const MAX_VERIFIED_BINARY_BYTES: u64 = 512 * 1024 * 1024;
const BINARY_HASH_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VerifiedBinaryIdentity {
    pub canonical_path: PathBuf,
    pub owner_uid: u32,
    pub device: u64,
    pub inode: u64,
    pub size: u64,
    pub modified_seconds: i64,
    pub modified_nanoseconds: i64,
    pub executable_sha256: String,
}

impl VerifiedBinaryIdentity {
    pub async fn revalidate(&self) -> Result<(), BinaryError> {
        let observed = inspect_trusted_identity(&self.canonical_path).await?;
        if observed == *self {
            Ok(())
        } else {
            Err(BinaryError::Untrusted)
        }
    }
}

#[derive(Clone, Debug)]
pub struct BinaryInfo {
    pub canonical_path: PathBuf,
    pub canonical_path_hash: String,
    pub executable_sha256: String,
    pub cli_version: String,
    pub source: BinarySource,
    pub identity: VerifiedBinaryIdentity,
}

impl BinaryInfo {
    pub async fn revalidate(&self) -> Result<(), BinaryError> {
        self.identity.revalidate().await
    }
}

#[derive(Clone, Debug)]
pub struct SchemaProbe {
    pub fingerprint: String,
    pub generated_by_same_binary: bool,
    pub capabilities: CodexCapabilities,
}

#[derive(Clone, Copy, Debug, Error)]
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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct FileIdentity {
    owner_uid: u32,
    device: u64,
    inode: u64,
    size: u64,
    modified_seconds: i64,
    modified_nanoseconds: i64,
}

impl FileIdentity {
    fn from_metadata(metadata: &std::fs::Metadata) -> Self {
        Self {
            owner_uid: metadata.uid(),
            device: metadata.dev(),
            inode: metadata.ino(),
            size: metadata.size(),
            modified_seconds: metadata.mtime(),
            modified_nanoseconds: metadata.mtime_nsec(),
        }
    }
}

unsafe extern "C" {
    fn getuid() -> u32;
}

fn current_uid() -> u32 {
    // SAFETY: getuid has no parameters, does not dereference memory, and always succeeds.
    unsafe { getuid() }
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

fn owner_is_trusted(owner_uid: u32, user_uid: u32) -> bool {
    owner_uid == 0 || owner_uid == user_uid
}

fn validate_parent_chain(canonical_path: &Path, user_uid: u32) -> Result<(), BinaryError> {
    let mut parent = canonical_path.parent();
    while let Some(directory) = parent {
        let metadata = std::fs::symlink_metadata(directory).map_err(|_| BinaryError::Io)?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(BinaryError::Untrusted);
        }
        let owner_uid = metadata.uid();
        let mode = metadata.permissions().mode();
        if !owner_is_trusted(owner_uid, user_uid)
            || mode & 0o002 != 0
            || (owner_uid != user_uid && mode & 0o020 != 0)
        {
            return Err(BinaryError::Untrusted);
        }
        parent = directory.parent();
    }
    Ok(())
}

async fn sha256_file(path: &Path) -> Result<String, BinaryError> {
    let metadata = tokio::fs::symlink_metadata(path)
        .await
        .map_err(|_| BinaryError::Io)?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_VERIFIED_BINARY_BYTES {
        return Err(BinaryError::Untrusted);
    }
    let expected = FileIdentity::from_metadata(&metadata);
    let mut options = tokio::fs::OpenOptions::new();
    options
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    let mut file = options.open(path).await.map_err(|_| BinaryError::Io)?;
    let opened = file.metadata().await.map_err(|_| BinaryError::Io)?;
    if !opened.is_file() || FileIdentity::from_metadata(&opened) != expected {
        return Err(BinaryError::Untrusted);
    }
    tokio::time::timeout(BINARY_HASH_TIMEOUT, async move {
        let mut hasher = Sha256::new();
        let mut total = 0_u64;
        let mut buffer = vec![0_u8; 1024 * 1024];
        loop {
            let count = file.read(&mut buffer).await.map_err(|_| BinaryError::Io)?;
            if count == 0 {
                break;
            }
            total = total.saturating_add(count as u64);
            if total > metadata.len() || total > MAX_VERIFIED_BINARY_BYTES {
                return Err(BinaryError::Untrusted);
            }
            hasher.update(&buffer[..count]);
            tokio::task::yield_now().await;
        }
        if total != metadata.len() {
            return Err(BinaryError::Untrusted);
        }
        let after = file.metadata().await.map_err(|_| BinaryError::Io)?;
        if FileIdentity::from_metadata(&after) != expected {
            return Err(BinaryError::Untrusted);
        }
        Ok(hex::encode(hasher.finalize()))
    })
    .await
    .map_err(|_| BinaryError::Timeout)?
}

async fn inspect_trusted_identity(path: &Path) -> Result<VerifiedBinaryIdentity, BinaryError> {
    let canonical_path = tokio::fs::canonicalize(path)
        .await
        .map_err(|_| BinaryError::Missing)?;
    if path.is_absolute() && path == canonical_path {
        let source_metadata = tokio::fs::symlink_metadata(path)
            .await
            .map_err(|_| BinaryError::Io)?;
        if source_metadata.file_type().is_symlink() {
            return Err(BinaryError::Untrusted);
        }
    }

    let user_uid = current_uid();
    validate_parent_chain(&canonical_path, user_uid)?;
    let before_metadata = tokio::fs::symlink_metadata(&canonical_path)
        .await
        .map_err(|_| BinaryError::Io)?;
    let before = FileIdentity::from_metadata(&before_metadata);
    let mode = before_metadata.permissions().mode();
    if before_metadata.file_type().is_symlink()
        || !before_metadata.is_file()
        || mode & 0o111 == 0
        || mode & 0o022 != 0
        || !owner_is_trusted(before.owner_uid, user_uid)
    {
        return Err(BinaryError::Untrusted);
    }

    let executable_sha256 = sha256_file(&canonical_path).await?;
    let after_metadata = tokio::fs::symlink_metadata(&canonical_path)
        .await
        .map_err(|_| BinaryError::Io)?;
    let after = FileIdentity::from_metadata(&after_metadata);
    if before != after || after_metadata.file_type().is_symlink() || !after_metadata.is_file() {
        return Err(BinaryError::Untrusted);
    }

    Ok(VerifiedBinaryIdentity {
        canonical_path,
        owner_uid: after.owner_uid,
        device: after.device,
        inode: after.inode,
        size: after.size,
        modified_seconds: after.modified_seconds,
        modified_nanoseconds: after.modified_nanoseconds,
        executable_sha256,
    })
}

#[derive(Debug)]
struct BoundedOutput {
    stdout: Vec<u8>,
    #[allow(dead_code)]
    stderr: Vec<u8>,
}

#[derive(Clone, Copy, Debug)]
enum ProbeAbort {
    OutputLimit,
    SchemaLimit,
}

async fn capture_bounded<R>(
    mut reader: R,
    aborts: mpsc::Sender<ProbeAbort>,
) -> Result<Vec<u8>, BinaryError>
where
    R: AsyncRead + Unpin,
{
    let mut captured = Vec::with_capacity(16 * 1024);
    let mut buffer = [0_u8; 16 * 1024];
    loop {
        let count = reader
            .read(&mut buffer)
            .await
            .map_err(|_| BinaryError::Io)?;
        if count == 0 {
            return Ok(captured);
        }
        if captured.len().saturating_add(count) > MAX_PROBE_OUTPUT_BYTES {
            let _ = aborts.send(ProbeAbort::OutputLimit).await;
            return Err(BinaryError::ProbeFailed);
        }
        captured.extend_from_slice(&buffer[..count]);
    }
}

fn schema_tree_within_limits(root: &Path) -> Result<(), BinaryError> {
    let mut stack = vec![(root.to_path_buf(), 0_usize)];
    let mut files = 0_usize;
    let mut aggregate = 0_u64;
    while let Some((directory, depth)) = stack.pop() {
        if depth > MAX_SCHEMA_DEPTH {
            return Err(BinaryError::SchemaUnsupported);
        }
        let metadata = std::fs::symlink_metadata(&directory).map_err(|_| BinaryError::Io)?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(BinaryError::SchemaUnsupported);
        }
        for entry in std::fs::read_dir(&directory).map_err(|_| BinaryError::Io)? {
            let entry = entry.map_err(|_| BinaryError::Io)?;
            let path = entry.path();
            let metadata = std::fs::symlink_metadata(&path).map_err(|_| BinaryError::Io)?;
            if metadata.file_type().is_symlink() {
                return Err(BinaryError::SchemaUnsupported);
            }
            if metadata.is_dir() {
                stack.push((path, depth + 1));
                continue;
            }
            if !metadata.is_file() {
                return Err(BinaryError::SchemaUnsupported);
            }
            files = files.saturating_add(1);
            aggregate = aggregate.saturating_add(metadata.len());
            if files > MAX_SCHEMA_FILES
                || metadata.len() > MAX_SCHEMA_FILE_BYTES
                || aggregate > MAX_SCHEMA_TOTAL_BYTES
            {
                return Err(BinaryError::SchemaUnsupported);
            }
        }
    }
    Ok(())
}

async fn monitor_schema_tree(root: PathBuf, aborts: mpsc::Sender<ProbeAbort>) {
    let mut interval = tokio::time::interval(Duration::from_millis(25));
    loop {
        interval.tick().await;
        if schema_tree_within_limits(&root).is_err() {
            let _ = aborts.send(ProbeAbort::SchemaLimit).await;
            return;
        }
    }
}

async fn run_bounded(
    identity: &VerifiedBinaryIdentity,
    args: &[OsString],
    schema_root: Option<&Path>,
) -> Result<BoundedOutput, BinaryError> {
    identity.revalidate().await?;
    let mut command = Command::new(&identity.canonical_path);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    command.as_std_mut().process_group(0);

    let mut child = command.spawn().map_err(|_| BinaryError::ProbeFailed)?;
    let pid = child.id().ok_or(BinaryError::ProbeFailed)?;
    let deadline = tokio::time::Instant::now() + PROBE_TIMEOUT;
    let stdout = child.stdout.take().ok_or(BinaryError::ProbeFailed)?;
    let stderr = child.stderr.take().ok_or(BinaryError::ProbeFailed)?;
    let (abort_tx, mut abort_rx) = mpsc::channel(3);
    let mut stdout_task = tokio::spawn(capture_bounded(stdout, abort_tx.clone()));
    let mut stderr_task = tokio::spawn(capture_bounded(stderr, abort_tx.clone()));
    let schema_monitor = schema_root
        .map(|root| tokio::spawn(monitor_schema_tree(root.to_path_buf(), abort_tx.clone())));

    if let Err(error) = identity.revalidate().await {
        terminate_child_process_group(&mut child, pid, Duration::from_millis(200)).await;
        stdout_task.abort();
        stderr_task.abort();
        if let Some(monitor) = schema_monitor {
            monitor.abort();
        }
        return Err(error);
    }

    let outcome = tokio::select! {
        status = child.wait() => status.map_err(|_| BinaryError::ProbeFailed).map(Some),
        abort = abort_rx.recv() => {
            Ok(match abort {
                Some(ProbeAbort::OutputLimit) => None,
                Some(ProbeAbort::SchemaLimit) | None => {
                    if let Some(monitor) = schema_monitor.as_ref() {
                        monitor.abort();
                    }
                    terminate_child_process_group(&mut child, pid, Duration::from_millis(200)).await;
                    stdout_task.abort();
                    stderr_task.abort();
                    return Err(BinaryError::SchemaUnsupported);
                }
            })
        }
        _ = tokio::time::sleep_until(deadline) => Err(BinaryError::Timeout),
    };

    let status = match outcome {
        Ok(Some(status)) => status,
        Ok(None) => {
            terminate_child_process_group(&mut child, pid, Duration::from_millis(200)).await;
            stdout_task.abort();
            stderr_task.abort();
            if let Some(monitor) = schema_monitor {
                monitor.abort();
            }
            return Err(BinaryError::ProbeFailed);
        }
        Err(error) => {
            terminate_child_process_group(&mut child, pid, Duration::from_millis(200)).await;
            stdout_task.abort();
            stderr_task.abort();
            if let Some(monitor) = schema_monitor {
                monitor.abort();
            }
            return Err(error);
        }
    };
    let captures = tokio::select! {
        captures = async {
            let stdout = (&mut stdout_task).await.map_err(|_| BinaryError::ProbeFailed)??;
            let stderr = (&mut stderr_task).await.map_err(|_| BinaryError::ProbeFailed)??;
            Ok::<_, BinaryError>((stdout, stderr))
        } => captures,
        abort = abort_rx.recv() => Err(match abort {
            Some(ProbeAbort::SchemaLimit) => BinaryError::SchemaUnsupported,
            Some(ProbeAbort::OutputLimit) | None => BinaryError::ProbeFailed,
        }),
        _ = tokio::time::sleep_until(deadline) => Err(BinaryError::Timeout),
    };
    let (stdout, stderr) = match captures {
        Ok(captures) => captures,
        Err(error) => {
            if let Some(monitor) = schema_monitor {
                monitor.abort();
            }
            terminate_child_process_group(&mut child, pid, Duration::from_millis(200)).await;
            stdout_task.abort();
            stderr_task.abort();
            return Err(error);
        }
    };
    if let Some(monitor) = schema_monitor {
        monitor.abort();
    }
    if process_group_exists(pid) {
        terminate_child_process_group(&mut child, pid, Duration::from_millis(200)).await;
        return Err(BinaryError::ProbeFailed);
    }
    identity.revalidate().await?;
    if !status.success() {
        return Err(BinaryError::ProbeFailed);
    }
    Ok(BoundedOutput { stdout, stderr })
}

pub async fn discover_binary(explicit_path: Option<&Path>) -> Result<BinaryInfo, BinaryError> {
    let explicit = explicit_path.is_some();
    for (candidate, source) in candidate_paths(explicit_path) {
        let identity = match inspect_trusted_identity(&candidate).await {
            Ok(identity) => identity,
            Err(BinaryError::Missing) if explicit => return Err(BinaryError::Missing),
            Err(BinaryError::Untrusted) if explicit => return Err(BinaryError::Untrusted),
            Err(_) if explicit => return Err(BinaryError::Io),
            Err(_) => continue,
        };
        let output = run_bounded(&identity, &[OsString::from("--version")], None).await?;
        let version_output =
            String::from_utf8(output.stdout).map_err(|_| BinaryError::ProbeFailed)?;
        let cli_version = version_output
            .trim()
            .strip_prefix("codex-cli ")
            .ok_or(BinaryError::ProbeFailed)?
            .to_owned();
        identity.revalidate().await?;
        let canonical_path_hash = hex::encode(Sha256::digest(
            identity.canonical_path.to_string_lossy().as_bytes(),
        ));

        return Ok(BinaryInfo {
            canonical_path: identity.canonical_path.clone(),
            canonical_path_hash,
            executable_sha256: identity.executable_sha256.clone(),
            cli_version,
            source,
            identity,
        });
    }

    Err(BinaryError::Missing)
}

struct CountingReader<R> {
    inner: R,
    bytes_read: u64,
}

impl<R: Read> Read for CountingReader<R> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        let count = self.inner.read(buffer)?;
        self.bytes_read = self.bytes_read.saturating_add(count as u64);
        Ok(count)
    }
}

#[derive(Debug)]
struct SchemaSet {
    fingerprint: String,
    documents: BTreeMap<String, Value>,
}

fn write_canonical_json(value: &Value, output: &mut Vec<u8>) -> Result<(), BinaryError> {
    match value {
        Value::Null => output.extend_from_slice(b"null"),
        Value::Bool(value) => output.extend_from_slice(if *value { b"true" } else { b"false" }),
        Value::Number(value) => output.extend_from_slice(value.to_string().as_bytes()),
        Value::String(value) => {
            serde_json::to_writer(output, value).map_err(|_| BinaryError::SchemaUnsupported)?;
        }
        Value::Array(values) => {
            output.push(b'[');
            for (index, value) in values.iter().enumerate() {
                if index > 0 {
                    output.push(b',');
                }
                write_canonical_json(value, output)?;
            }
            output.push(b']');
        }
        Value::Object(values) => {
            output.push(b'{');
            let mut entries = values.iter().collect::<Vec<_>>();
            entries.sort_unstable_by(|(left, _), (right, _)| left.cmp(right));
            for (index, (key, value)) in entries.into_iter().enumerate() {
                if index > 0 {
                    output.push(b',');
                }
                serde_json::to_writer(&mut *output, key)
                    .map_err(|_| BinaryError::SchemaUnsupported)?;
                output.push(b':');
                write_canonical_json(value, output)?;
            }
            output.push(b'}');
        }
    }
    Ok(())
}

fn collect_schema_files(root: &Path) -> Result<Vec<PathBuf>, BinaryError> {
    schema_tree_within_limits(root)?;
    let canonical_root = std::fs::canonicalize(root).map_err(|_| BinaryError::Io)?;
    let mut stack = vec![(root.to_path_buf(), 0_usize)];
    let mut files = Vec::new();
    while let Some((directory, depth)) = stack.pop() {
        if depth > MAX_SCHEMA_DEPTH {
            return Err(BinaryError::SchemaUnsupported);
        }
        for entry in std::fs::read_dir(&directory).map_err(|_| BinaryError::Io)? {
            let entry = entry.map_err(|_| BinaryError::Io)?;
            let path = entry.path();
            let metadata = std::fs::symlink_metadata(&path).map_err(|_| BinaryError::Io)?;
            if metadata.file_type().is_symlink() {
                return Err(BinaryError::SchemaUnsupported);
            }
            if metadata.is_dir() {
                stack.push((path, depth + 1));
            } else if metadata.is_file() {
                if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
                    return Err(BinaryError::SchemaUnsupported);
                }
                let canonical = std::fs::canonicalize(&path).map_err(|_| BinaryError::Io)?;
                if !canonical.starts_with(&canonical_root) {
                    return Err(BinaryError::SchemaUnsupported);
                }
                files.push(path);
            } else {
                return Err(BinaryError::SchemaUnsupported);
            }
        }
    }
    files.sort();
    if files.is_empty() {
        return Err(BinaryError::SchemaUnsupported);
    }
    Ok(files)
}

fn load_schema_set(root: &Path) -> Result<SchemaSet, BinaryError> {
    let files = collect_schema_files(root)?;
    let mut hasher = Sha256::new();
    let mut documents = BTreeMap::new();
    for path in files {
        let relative = path.strip_prefix(root).map_err(|_| BinaryError::Io)?;
        let relative = relative
            .to_str()
            .ok_or(BinaryError::SchemaUnsupported)?
            .replace(std::path::MAIN_SEPARATOR, "/");
        let before_metadata = std::fs::symlink_metadata(&path).map_err(|_| BinaryError::Io)?;
        let before = FileIdentity::from_metadata(&before_metadata);
        if before_metadata.file_type().is_symlink()
            || !before_metadata.is_file()
            || before.size > MAX_SCHEMA_FILE_BYTES
        {
            return Err(BinaryError::SchemaUnsupported);
        }

        let file = File::open(&path).map_err(|_| BinaryError::Io)?;
        let opened = file.metadata().map_err(|_| BinaryError::Io)?;
        if FileIdentity::from_metadata(&opened) != before {
            return Err(BinaryError::SchemaUnsupported);
        }
        let mut reader = CountingReader {
            inner: BufReader::new(file).take(MAX_SCHEMA_FILE_BYTES + 1),
            bytes_read: 0,
        };
        let mut deserializer = serde_json::Deserializer::from_reader(&mut reader);
        let value =
            Value::deserialize(&mut deserializer).map_err(|_| BinaryError::SchemaUnsupported)?;
        deserializer
            .end()
            .map_err(|_| BinaryError::SchemaUnsupported)?;
        if reader.bytes_read != before.size || reader.bytes_read > MAX_SCHEMA_FILE_BYTES {
            return Err(BinaryError::SchemaUnsupported);
        }
        let after = std::fs::symlink_metadata(&path).map_err(|_| BinaryError::Io)?;
        if FileIdentity::from_metadata(&after) != before
            || after.file_type().is_symlink()
            || !after.is_file()
        {
            return Err(BinaryError::SchemaUnsupported);
        }
        let mut canonical = Vec::with_capacity(before.size as usize);
        write_canonical_json(&value, &mut canonical)?;
        hasher.update(relative.as_bytes());
        hasher.update([0]);
        hasher.update(canonical);
        hasher.update([0]);
        if documents.insert(relative, value).is_some() {
            return Err(BinaryError::SchemaUnsupported);
        }
    }
    Ok(SchemaSet {
        fingerprint: hex::encode(hasher.finalize()),
        documents,
    })
}

fn string_array(value: Option<&Value>) -> Option<Vec<&str>> {
    value?
        .as_array()?
        .iter()
        .map(Value::as_str)
        .collect::<Option<Vec<_>>>()
}

fn required_is(value: &Value, expected: &[&str]) -> bool {
    let mut required = match string_array(value.get("required")) {
        Some(required) => required,
        None => return expected.is_empty(),
    };
    let mut expected = expected.to_vec();
    required.sort_unstable();
    expected.sort_unstable();
    required == expected
}

fn required_contains(value: &Value, expected: &[&str]) -> bool {
    string_array(value.get("required")).is_some_and(|required| {
        expected
            .iter()
            .all(|field| required.iter().any(|candidate| candidate == field))
    })
}

fn has_properties(value: &Value, expected: &[&str]) -> bool {
    value
        .get("properties")
        .and_then(Value::as_object)
        .is_some_and(|properties| expected.iter().all(|field| properties.contains_key(*field)))
}

fn object_shape(value: Option<&Value>, title: &str, required: &[&str], fields: &[&str]) -> bool {
    value.is_some_and(|value| {
        value.get("title").and_then(Value::as_str) == Some(title)
            && value.get("type").and_then(Value::as_str) == Some("object")
            && required_contains(value, required)
            && has_properties(value, fields)
    })
}

fn exact_union_variant(
    document: Option<&Value>,
    method: &str,
    params_ref: &str,
    notification: bool,
) -> bool {
    let Some(variants) = document
        .and_then(|document| document.get("oneOf"))
        .and_then(Value::as_array)
    else {
        return false;
    };
    let matches = variants
        .iter()
        .filter(|variant| {
            variant
                .pointer("/properties/method/enum")
                .and_then(Value::as_array)
                .is_some_and(|values| {
                    values.len() == 1 && values.first().and_then(Value::as_str) == Some(method)
                })
        })
        .collect::<Vec<_>>();
    if matches.len() != 1 {
        return false;
    }
    let variant = matches[0];
    let expected_required = if notification {
        &["method", "params"][..]
    } else {
        &["id", "method", "params"][..]
    };
    variant.get("type").and_then(Value::as_str) == Some("object")
        && required_is(variant, expected_required)
        && variant
            .pointer("/properties/method/type")
            .and_then(Value::as_str)
            == Some("string")
        && variant
            .pointer("/properties/params/$ref")
            .and_then(Value::as_str)
            == Some(params_ref)
}

fn supports_explicit_skill_input(document: Option<&Value>) -> bool {
    let Some(document) = document else {
        return false;
    };
    if !object_shape(
        Some(document),
        "TurnStartParams",
        &["input", "threadId"],
        &["input", "threadId"],
    ) || document
        .pointer("/properties/input/items/$ref")
        .and_then(Value::as_str)
        != Some("#/definitions/UserInput")
    {
        return false;
    }
    let Some(variants) = document
        .pointer("/definitions/UserInput/oneOf")
        .and_then(Value::as_array)
    else {
        return false;
    };
    let matches = variants
        .iter()
        .filter(|variant| {
            variant.get("title").and_then(Value::as_str) == Some("SkillUserInput")
                && variant
                    .pointer("/properties/type/enum")
                    .and_then(Value::as_array)
                    .is_some_and(|values| {
                        values.len() == 1 && values.first().and_then(Value::as_str) == Some("skill")
                    })
        })
        .collect::<Vec<_>>();
    if matches.len() != 1 {
        return false;
    }
    let skill = matches[0];
    skill.get("type").and_then(Value::as_str) == Some("object")
        && required_is(skill, &["name", "path", "type"])
        && has_properties(skill, &["name", "path", "type"])
        && skill
            .pointer("/properties/name/type")
            .and_then(Value::as_str)
            == Some("string")
        && skill
            .pointer("/properties/path/type")
            .and_then(Value::as_str)
            == Some("string")
        && skill
            .pointer("/properties/type/type")
            .and_then(Value::as_str)
            == Some("string")
}

fn structural_capabilities(documents: &BTreeMap<String, Value>) -> Option<CodexCapabilities> {
    let document = |name: &str| documents.get(name);
    let client = document("ClientRequest.json");
    let server_request = document("ServerRequest.json");
    let server_notification = document("ServerNotification.json");

    let client_methods = [
        ("thread/list", "#/definitions/ThreadListParams"),
        ("thread/start", "#/definitions/ThreadStartParams"),
        ("thread/resume", "#/definitions/ThreadResumeParams"),
        ("turn/start", "#/definitions/TurnStartParams"),
        ("turn/interrupt", "#/definitions/TurnInterruptParams"),
        ("review/start", "#/definitions/ReviewStartParams"),
        ("account/read", "#/definitions/GetAccountParams"),
        ("config/read", "#/definitions/ConfigReadParams"),
        ("model/list", "#/definitions/ModelListParams"),
    ];
    let notification_methods = [
        ("error", "#/definitions/ErrorNotification"),
        ("turn/started", "#/definitions/TurnStartedNotification"),
        ("turn/completed", "#/definitions/TurnCompletedNotification"),
        ("item/started", "#/definitions/ItemStartedNotification"),
        ("item/completed", "#/definitions/ItemCompletedNotification"),
        (
            "item/agentMessage/delta",
            "#/definitions/AgentMessageDeltaNotification",
        ),
        ("model/rerouted", "#/definitions/ModelReroutedNotification"),
    ];
    let core_unions = client_methods
        .iter()
        .all(|(method, reference)| exact_union_variant(client, method, reference, false))
        && notification_methods.iter().all(|(method, reference)| {
            exact_union_variant(server_notification, method, reference, true)
        });
    let core_responses = object_shape(
        document("v2/ThreadListResponse.json"),
        "ThreadListResponse",
        &["data"],
        &["data"],
    ) && object_shape(
        document("v2/ThreadStartResponse.json"),
        "ThreadStartResponse",
        &[
            "approvalPolicy",
            "approvalsReviewer",
            "cwd",
            "model",
            "modelProvider",
            "sandbox",
            "thread",
        ],
        &[
            "approvalPolicy",
            "approvalsReviewer",
            "cwd",
            "model",
            "modelProvider",
            "sandbox",
            "thread",
        ],
    ) && object_shape(
        document("v2/ThreadResumeResponse.json"),
        "ThreadResumeResponse",
        &[
            "approvalPolicy",
            "approvalsReviewer",
            "cwd",
            "model",
            "modelProvider",
            "sandbox",
            "thread",
        ],
        &[
            "approvalPolicy",
            "approvalsReviewer",
            "cwd",
            "model",
            "modelProvider",
            "sandbox",
            "thread",
        ],
    ) && object_shape(
        document("v2/TurnStartResponse.json"),
        "TurnStartResponse",
        &["turn"],
        &["turn"],
    ) && object_shape(
        document("v2/GetAccountResponse.json"),
        "GetAccountResponse",
        &["requiresOpenaiAuth"],
        &["account", "requiresOpenaiAuth"],
    ) && object_shape(
        document("v2/ConfigReadResponse.json"),
        "ConfigReadResponse",
        &["config", "origins"],
        &["config", "origins"],
    );
    if !core_unions
        || !core_responses
        || !supports_explicit_skill_input(document("v2/TurnStartParams.json"))
    {
        return None;
    }

    let model_discovery = object_shape(
        document("v2/ModelListResponse.json"),
        "ModelListResponse",
        &["data"],
        &["data"],
    );
    let request_user_input = exact_union_variant(
        server_request,
        "item/tool/requestUserInput",
        "#/definitions/ToolRequestUserInputParams",
        false,
    ) && object_shape(
        document("ToolRequestUserInputParams.json"),
        "ToolRequestUserInputParams",
        &["itemId", "questions", "threadId", "turnId"],
        &["itemId", "questions", "threadId", "turnId"],
    ) && object_shape(
        document("ToolRequestUserInputResponse.json"),
        "ToolRequestUserInputResponse",
        &["answers"],
        &["answers"],
    );
    let dynamic_tools = exact_union_variant(
        server_request,
        "item/tool/call",
        "#/definitions/DynamicToolCallParams",
        false,
    ) && object_shape(
        document("DynamicToolCallParams.json"),
        "DynamicToolCallParams",
        &["arguments", "callId", "threadId", "tool", "turnId"],
        &["arguments", "callId", "threadId", "tool", "turnId"],
    ) && object_shape(
        document("DynamicToolCallResponse.json"),
        "DynamicToolCallResponse",
        &["contentItems", "success"],
        &["contentItems", "success"],
    ) && document("v2/ThreadStartParams.json")
        .and_then(|value| value.pointer("/properties/dynamicTools/items/$ref"))
        .and_then(Value::as_str)
        == Some("#/definitions/DynamicToolSpec");
    let permissions_approval = exact_union_variant(
        server_request,
        "item/permissions/requestApproval",
        "#/definitions/PermissionsRequestApprovalParams",
        false,
    ) && object_shape(
        document("PermissionsRequestApprovalParams.json"),
        "PermissionsRequestApprovalParams",
        &[
            "cwd",
            "itemId",
            "permissions",
            "startedAtMs",
            "threadId",
            "turnId",
        ],
        &[
            "cwd",
            "itemId",
            "permissions",
            "startedAtMs",
            "threadId",
            "turnId",
        ],
    ) && object_shape(
        document("PermissionsRequestApprovalResponse.json"),
        "PermissionsRequestApprovalResponse",
        &["permissions"],
        &["permissions"],
    );
    let detached_review = exact_union_variant(
        client,
        "review/start",
        "#/definitions/ReviewStartParams",
        false,
    ) && object_shape(
        document("v2/ReviewStartParams.json"),
        "ReviewStartParams",
        &["target", "threadId"],
        &["delivery", "target", "threadId"],
    ) && document("v2/ReviewStartParams.json")
        .and_then(|value| value.pointer("/properties/delivery/anyOf/0/$ref"))
        .and_then(Value::as_str)
        == Some("#/definitions/ReviewDelivery")
        && document("v2/ReviewStartParams.json")
            .and_then(|value| value.pointer("/definitions/ReviewDelivery/enum"))
            .and_then(Value::as_array)
            .is_some_and(|variants| {
                variants.len() == 2
                    && variants
                        .iter()
                        .any(|value| value.as_str() == Some("inline"))
                    && variants
                        .iter()
                        .any(|value| value.as_str() == Some("detached"))
            })
        && object_shape(
            document("v2/ReviewStartResponse.json"),
            "ReviewStartResponse",
            &["reviewThreadId", "turn"],
            &["reviewThreadId", "turn"],
        );
    let ephemeral_thread = document("v2/ThreadStartParams.json")
        .and_then(|value| value.pointer("/properties/ephemeral/type"))
        .and_then(Value::as_array)
        .is_some_and(|types| {
            types.len() == 2
                && types.iter().any(|value| value.as_str() == Some("boolean"))
                && types.iter().any(|value| value.as_str() == Some("null"))
        })
        && document("v2/ThreadStartResponse.json")
            .and_then(|value| value.pointer("/definitions/Thread"))
            .is_some_and(|thread| {
                required_contains(thread, &["ephemeral"]) && has_properties(thread, &["ephemeral"])
            });

    let state = |supported| {
        if supported {
            CapabilityState::Supported
        } else {
            CapabilityState::Unverified
        }
    };
    Some(CodexCapabilities {
        core_lifecycle: CapabilityState::Supported,
        model_discovery: state(model_discovery),
        native_request_user_input: state(request_user_input),
        dynamic_tools: state(dynamic_tools),
        permissions_approval: state(permissions_approval),
        detached_review: state(detached_review),
        ephemeral_thread: state(ephemeral_thread),
        support_isolation: CapabilityState::Unavailable,
    })
}

struct SchemaTempDir {
    path: PathBuf,
}

impl SchemaTempDir {
    async fn create() -> Result<Self, BinaryError> {
        let path = std::env::temp_dir().join(format!(
            "coding-wife-codex-schema-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        tokio::fs::create_dir(&path)
            .await
            .map_err(|_| BinaryError::Io)?;
        Ok(Self { path })
    }
}

impl Drop for SchemaTempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

pub async fn probe_schema(binary: &BinaryInfo) -> Result<SchemaProbe, BinaryError> {
    binary.revalidate().await?;
    let output_dir = SchemaTempDir::create().await?;
    let args = [
        OsString::from("app-server"),
        OsString::from("generate-json-schema"),
        OsString::from("--experimental"),
        OsString::from("--out"),
        output_dir.path.clone().into_os_string(),
    ];
    run_bounded(&binary.identity, &args, Some(&output_dir.path)).await?;
    binary.revalidate().await?;

    let root = output_dir.path.clone();
    let schema = tokio::task::spawn_blocking(move || load_schema_set(&root))
        .await
        .map_err(|_| BinaryError::Io)??;
    binary.revalidate().await?;
    let capabilities =
        structural_capabilities(&schema.documents).ok_or(BinaryError::SchemaUnsupported)?;

    Ok(SchemaProbe {
        fingerprint: schema.fingerprint,
        generated_by_same_binary: true,
        capabilities,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    fn temporary_directory(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "coding-wife-binary-{label}-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ))
    }

    fn fixture_documents() -> BTreeMap<String, Value> {
        serde_json::from_str(include_str!(
            "../../tests/fixtures/codex_schema_subset_v0_144_5.json"
        ))
        .expect("valid actual-schema subset fixture")
    }

    fn schema_fingerprint(label: &str, document: &str) -> String {
        let directory = temporary_directory(label);
        std::fs::create_dir(&directory).expect("schema fixture directory");
        std::fs::write(directory.join("schema.json"), document).expect("schema fixture document");
        let fingerprint = load_schema_set(&directory)
            .expect("supported schema fixture")
            .fingerprint;
        std::fs::remove_dir_all(directory).expect("schema fixture cleanup");
        fingerprint
    }

    #[test]
    fn explicit_path_is_the_only_candidate() {
        let candidates = candidate_paths(Some(Path::new("/fixture/codex")));
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].0, Path::new("/fixture/codex"));
        assert_eq!(candidates[0].1, BinarySource::Explicit);
    }

    #[test]
    fn owners_are_limited_to_root_or_the_current_user() {
        let uid = current_uid();
        assert!(owner_is_trusted(0, uid));
        assert!(owner_is_trusted(uid, uid));
        assert!(!owner_is_trusted(uid.saturating_add(1), uid));
    }

    #[tokio::test]
    async fn replacement_invalidates_the_verified_identity() {
        let directory = temporary_directory("replace");
        std::fs::create_dir(&directory).expect("fixture directory");
        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700))
            .expect("fixture permissions");
        let binary = directory.join("codex");
        std::fs::write(&binary, b"#!/bin/sh\nprintf 'codex-cli 0.144.5\\n'\n")
            .expect("fixture binary");
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700))
            .expect("fixture executable");
        let identity = inspect_trusted_identity(&binary)
            .await
            .expect("trusted initial identity");

        let replacement = directory.join("replacement");
        std::fs::write(&replacement, b"#!/bin/sh\nprintf 'codex-cli replaced\\n'\n")
            .expect("replacement binary");
        std::fs::set_permissions(&replacement, std::fs::Permissions::from_mode(0o700))
            .expect("replacement executable");
        std::fs::rename(&replacement, &binary).expect("atomic replacement");

        assert!(matches!(
            identity.revalidate().await,
            Err(BinaryError::Untrusted)
        ));
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn world_writable_parent_is_rejected() {
        let directory = temporary_directory("parent-policy");
        std::fs::create_dir(&directory).expect("fixture directory");
        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o707))
            .expect("world-writable fixture permissions");
        let binary = directory.join("codex");
        std::fs::write(&binary, b"#!/bin/sh\nexit 0\n").expect("fixture binary");
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700))
            .expect("fixture executable");
        assert!(matches!(
            inspect_trusted_identity(&binary).await,
            Err(BinaryError::Untrusted)
        ));
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn executable_hash_is_exact_and_rejects_unbounded_files_before_reading() {
        let directory = temporary_directory("bounded-hash");
        std::fs::create_dir(&directory).expect("hash fixture directory");

        let valid = directory.join("valid");
        std::fs::write(&valid, b"abc").expect("valid hash fixture");
        assert_eq!(
            sha256_file(&valid).await.expect("bounded hash"),
            hex::encode(Sha256::digest(b"abc"))
        );

        let empty = directory.join("empty");
        std::fs::write(&empty, b"").expect("empty hash fixture");
        assert!(matches!(
            sha256_file(&empty).await,
            Err(BinaryError::Untrusted)
        ));

        let oversized = directory.join("oversized");
        let file = File::create(&oversized).expect("oversized hash fixture");
        file.set_len(MAX_VERIFIED_BINARY_BYTES + 1)
            .expect("sparse oversized hash fixture");
        let started = std::time::Instant::now();
        assert!(matches!(
            sha256_file(&oversized).await,
            Err(BinaryError::Untrusted)
        ));
        assert!(started.elapsed() < Duration::from_secs(1));

        std::fs::remove_dir_all(directory).expect("hash fixture cleanup");
    }

    #[tokio::test]
    async fn oversized_probe_output_is_stopped_at_the_stream_limit() {
        let identity = inspect_trusted_identity(Path::new("/bin/sh"))
            .await
            .expect("system shell is trusted");
        for script in [
            "while :; do printf '0123456789abcdef'; done",
            "while :; do printf '0123456789abcdef' >&2; done",
        ] {
            let result = run_bounded(
                &identity,
                &[OsString::from("-c"), OsString::from(script)],
                None,
            )
            .await;
            assert!(matches!(result, Err(BinaryError::ProbeFailed)));
        }
    }

    #[test]
    fn schema_tree_rejects_huge_many_and_symlinked_files() {
        let huge = temporary_directory("huge-schema");
        std::fs::create_dir(&huge).expect("huge fixture directory");
        let file = File::create(huge.join("huge.json")).expect("huge fixture file");
        file.set_len(MAX_SCHEMA_FILE_BYTES + 1)
            .expect("sparse huge fixture");
        assert!(matches!(
            load_schema_set(&huge),
            Err(BinaryError::SchemaUnsupported)
        ));
        let _ = std::fs::remove_dir_all(&huge);

        let many = temporary_directory("many-schema");
        std::fs::create_dir(&many).expect("many fixture directory");
        for index in 0..=MAX_SCHEMA_FILES {
            std::fs::write(many.join(format!("{index}.json")), b"{}").expect("many fixture file");
        }
        assert!(matches!(
            load_schema_set(&many),
            Err(BinaryError::SchemaUnsupported)
        ));
        let _ = std::fs::remove_dir_all(&many);

        let linked = temporary_directory("symlink-schema");
        std::fs::create_dir(&linked).expect("symlink fixture directory");
        let outside = temporary_directory("outside-schema");
        std::fs::write(&outside, b"{}").expect("outside fixture file");
        symlink(&outside, linked.join("escape.json")).expect("fixture symlink");
        assert!(matches!(
            load_schema_set(&linked),
            Err(BinaryError::SchemaUnsupported)
        ));
        let _ = std::fs::remove_dir_all(&linked);
        let _ = std::fs::remove_file(&outside);

        let linked = temporary_directory("directory-symlink-schema");
        std::fs::create_dir(&linked).expect("directory symlink fixture root");
        let outside = temporary_directory("outside-schema-directory");
        std::fs::create_dir(&outside).expect("outside fixture directory");
        std::fs::write(outside.join("schema.json"), b"{}").expect("outside schema file");
        symlink(&outside, linked.join("escape")).expect("fixture directory symlink");
        assert!(matches!(
            load_schema_set(&linked),
            Err(BinaryError::SchemaUnsupported)
        ));
        let _ = std::fs::remove_dir_all(&linked);
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[test]
    fn schema_fingerprint_canonicalizes_only_recursive_object_key_order() {
        let original = schema_fingerprint(
            "canonical-original",
            r#"{"z":{"b":2,"a":1},"required":["b","a"],"value":true}"#,
        );
        let reordered_objects = schema_fingerprint(
            "canonical-reordered",
            r#"{"value":true,"required":["b","a"],"z":{"a":1,"b":2}}"#,
        );
        let reordered_array = schema_fingerprint(
            "canonical-array",
            r#"{"z":{"b":2,"a":1},"required":["a","b"],"value":true}"#,
        );
        let changed_value_type = schema_fingerprint(
            "canonical-type",
            r#"{"z":{"b":2,"a":1},"required":["b","a"],"value":"true"}"#,
        );

        assert_eq!(original, reordered_objects);
        assert_ne!(original, reordered_array);
        assert_ne!(original, changed_value_type);
    }

    #[test]
    fn actual_schema_subset_proves_supported_capabilities() {
        let capabilities = structural_capabilities(&fixture_documents())
            .expect("actual generated-schema subset is structurally supported");
        assert_eq!(capabilities.core_lifecycle, CapabilityState::Supported);
        assert_eq!(
            capabilities.native_request_user_input,
            CapabilityState::Supported
        );
        assert_eq!(capabilities.dynamic_tools, CapabilityState::Supported);
        assert_eq!(
            capabilities.permissions_approval,
            CapabilityState::Supported
        );
        assert_eq!(capabilities.detached_review, CapabilityState::Supported);
        assert_eq!(capabilities.ephemeral_thread, CapabilityState::Supported);
    }

    #[test]
    fn comments_other_definitions_and_ambiguous_methods_do_not_prove_capability() {
        let mut documents = fixture_documents();
        let request = documents
            .get_mut("ServerRequest.json")
            .expect("server request fixture");
        let variants = request
            .get_mut("oneOf")
            .and_then(Value::as_array_mut)
            .expect("request variants");
        let request_user_input = variants
            .iter()
            .position(|variant| {
                variant
                    .pointer("/properties/method/enum/0")
                    .and_then(Value::as_str)
                    == Some("item/tool/requestUserInput")
            })
            .expect("RUI variant");
        variants.remove(request_user_input);
        request["description"] =
            Value::String("item/tool/requestUserInput ToolRequestUserInputParams".to_owned());
        request["definitions"] = serde_json::json!({
            "Unrelated": {"const": "item/tool/requestUserInput"}
        });
        let capabilities = structural_capabilities(&documents).expect("core remains valid");
        assert_eq!(
            capabilities.native_request_user_input,
            CapabilityState::Unverified
        );

        let mut documents = fixture_documents();
        let request = documents
            .get_mut("ServerRequest.json")
            .expect("server request fixture");
        let variants = request
            .get_mut("oneOf")
            .and_then(Value::as_array_mut)
            .expect("request variants");
        let duplicate = variants
            .iter()
            .find(|variant| {
                variant
                    .pointer("/properties/method/enum/0")
                    .and_then(Value::as_str)
                    == Some("item/tool/call")
            })
            .expect("dynamic tool variant")
            .clone();
        variants.push(duplicate);
        let capabilities = structural_capabilities(&documents).expect("core remains valid");
        assert_eq!(capabilities.dynamic_tools, CapabilityState::Unverified);
    }

    #[test]
    fn mutated_core_params_or_response_required_fields_are_rejected() {
        let mut documents = fixture_documents();
        let client = documents
            .get_mut("ClientRequest.json")
            .expect("client request fixture");
        let variant = client
            .get_mut("oneOf")
            .and_then(Value::as_array_mut)
            .and_then(|variants| {
                variants.iter_mut().find(|variant| {
                    variant
                        .pointer("/properties/method/enum/0")
                        .and_then(Value::as_str)
                        == Some("thread/start")
                })
            })
            .expect("thread/start variant");
        variant["properties"]["params"]["$ref"] =
            Value::String("#/definitions/Unrelated".to_owned());
        assert!(structural_capabilities(&documents).is_none());

        let mut documents = fixture_documents();
        documents
            .get_mut("v2/ThreadStartResponse.json")
            .expect("thread start response")["required"] = serde_json::json!(["thread"]);
        assert!(structural_capabilities(&documents).is_none());

        let mut documents = fixture_documents();
        let variants = documents
            .get_mut("v2/TurnStartParams.json")
            .and_then(|document| document.pointer_mut("/definitions/UserInput/oneOf"))
            .and_then(Value::as_array_mut)
            .expect("user input variants");
        variants.retain(|variant| {
            variant.get("title").and_then(Value::as_str) != Some("SkillUserInput")
        });
        assert!(structural_capabilities(&documents).is_none());
    }

    #[test]
    fn schema_temp_directory_is_removed_on_drop() {
        let path = temporary_directory("cleanup");
        std::fs::create_dir(&path).expect("cleanup fixture directory");
        {
            let temporary = SchemaTempDir { path: path.clone() };
            std::fs::write(temporary.path.join("schema.json"), b"{}")
                .expect("cleanup fixture file");
        }
        assert!(!path.exists());
    }
}
