use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::future::Future;
use std::io::Read;
#[cfg(unix)]
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Component, Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;

use super::types::CodexCommandError;

pub const ATTACHMENT_SCHEMA_VERSION: u16 = 1;
pub const MAX_ATTACHMENT_COUNT: usize = 10;
pub const MAX_ATTACHMENT_BYTES: u64 = 25 * 1024 * 1024;
pub const MAX_ATTACHMENT_TOTAL_BYTES: u64 = 50 * 1024 * 1024;
pub const ATTACHMENT_TTL: Duration = Duration::from_secs(30 * 60);
const MAX_CANDIDATE_COUNT: usize = 64;
const MAX_PATH_BYTES: usize = 4_096;
const ATTACHMENT_OPERATION: &str = "codex.attachment";

pub type AttachmentPickerFuture<'a> = Pin<Box<dyn Future<Output = Vec<PathBuf>> + Send + 'a>>;

pub trait AttachmentFilePicker: Send + Sync {
    fn pick_files(&self) -> AttachmentPickerFuture<'_>;
}

pub struct NativeAttachmentFilePicker;

impl AttachmentFilePicker for NativeAttachmentFilePicker {
    fn pick_files(&self) -> AttachmentPickerFuture<'_> {
        Box::pin(async {
            rfd::AsyncFileDialog::new()
                .set_title("Select workspace attachments")
                .pick_files()
                .await
                .unwrap_or_default()
                .into_iter()
                .map(|handle| handle.path().to_path_buf())
                .collect()
        })
    }
}

pub trait AttachmentClock: Send + Sync {
    fn now(&self) -> SystemTime;
}

struct SystemAttachmentClock;

impl AttachmentClock for SystemAttachmentClock {
    fn now(&self) -> SystemTime {
        SystemTime::now()
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AttachmentSource {
    Picker,
    Drop,
    Paste,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AttachmentKind {
    Image,
    File,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct AttachmentSelectionRequest {
    pub workspace_id: String,
    pub existing_handles: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct AttachmentPathRegistrationRequest {
    pub workspace_id: String,
    pub source: AttachmentSource,
    pub paths: Vec<String>,
    pub existing_handles: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct AttachmentView {
    pub schema_version: u16,
    pub handle: String,
    pub name: String,
    pub relative_path: String,
    pub size_bytes: u64,
    pub kind: AttachmentKind,
    pub source: AttachmentSource,
    pub expires_at: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct AttachmentRejection {
    pub candidate_index: usize,
    pub code: String,
    pub recoverable: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct AttachmentRegistrationResponse {
    pub items: Vec<AttachmentView>,
    pub rejections: Vec<AttachmentRejection>,
}

#[derive(Clone, Debug)]
pub struct AttachmentWorkspaceContext {
    pub workspace_id: String,
    pub generation: u64,
    pub canonical_root: PathBuf,
    pub root_device: u64,
    pub root_inode: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ResolvedAttachment {
    LocalImage { path: String },
    Mention { name: String, path: String },
}

#[derive(Clone, Debug)]
pub struct ResolvedAttachmentSet {
    pub handles: Vec<String>,
    pub inputs: Vec<ResolvedAttachment>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct SourceFingerprint {
    device: u64,
    inode: u64,
    bytes: u64,
    modified_seconds: i64,
    modified_nanoseconds: i64,
    sha256: String,
}

#[derive(Clone, Debug)]
struct CandidateSnapshot {
    canonical_path: PathBuf,
    name: String,
    relative_path: String,
    bytes: u64,
    kind: AttachmentKind,
    fingerprint: SourceFingerprint,
}

#[derive(Clone, Debug)]
struct AttachmentRecord {
    handle: String,
    workspace_id: String,
    generation: u64,
    root_device: u64,
    root_inode: u64,
    source: AttachmentSource,
    expires_at: SystemTime,
    snapshot: CandidateSnapshot,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct CandidateError {
    code: &'static str,
    recoverable: bool,
}

impl CandidateError {
    const fn new(code: &'static str, recoverable: bool) -> Self {
        Self { code, recoverable }
    }
}

#[derive(Clone)]
pub struct AttachmentService {
    picker: Arc<dyn AttachmentFilePicker>,
    clock: Arc<dyn AttachmentClock>,
    records: Arc<Mutex<HashMap<String, AttachmentRecord>>>,
}

impl AttachmentService {
    pub fn production() -> Self {
        Self::new(
            Arc::new(NativeAttachmentFilePicker),
            Arc::new(SystemAttachmentClock),
        )
    }

    pub fn new(picker: Arc<dyn AttachmentFilePicker>, clock: Arc<dyn AttachmentClock>) -> Self {
        Self {
            picker,
            clock,
            records: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn pick_and_register(
        &self,
        context: AttachmentWorkspaceContext,
        existing_handles: Vec<String>,
    ) -> Result<AttachmentRegistrationResponse, CodexCommandError> {
        let candidates = self.picker.pick_files().await;
        self.register_candidates(
            context,
            AttachmentSource::Picker,
            candidates,
            existing_handles,
        )
        .await
    }

    pub async fn register_paths(
        &self,
        context: AttachmentWorkspaceContext,
        source: AttachmentSource,
        paths: Vec<String>,
        existing_handles: Vec<String>,
    ) -> Result<AttachmentRegistrationResponse, CodexCommandError> {
        if source == AttachmentSource::Picker {
            return Err(attachment_error("CODEX-ATTACHMENT-SOURCE-INVALID", false));
        }
        let paths = paths.into_iter().map(PathBuf::from).collect();
        self.register_candidates(context, source, paths, existing_handles)
            .await
    }

    pub async fn resolve_for_turn(
        &self,
        context: AttachmentWorkspaceContext,
        handles: &[String],
    ) -> Result<ResolvedAttachmentSet, CodexCommandError> {
        validate_context_shape(&context)?;
        validate_handle_list(handles)?;
        let now = self.clock.now();
        let records = {
            let records = self.records.lock().await;
            let mut selected = Vec::with_capacity(handles.len());
            let mut seen = HashSet::new();
            let mut total = 0_u64;
            for handle in handles {
                if !seen.insert(handle) {
                    return Err(attachment_error("CODEX-ATTACHMENT-HANDLE-DUPLICATE", false));
                }
                let record = records
                    .get(handle)
                    .ok_or_else(|| attachment_error("CODEX-ATTACHMENT-HANDLE-INVALID", true))?;
                if record.expires_at < now {
                    return Err(attachment_error("CODEX-ATTACHMENT-HANDLE-EXPIRED", true));
                }
                if !record_matches_context(record, &context) {
                    return Err(attachment_error("CODEX-ATTACHMENT-HANDLE-STALE", true));
                }
                total = total
                    .checked_add(record.snapshot.bytes)
                    .ok_or_else(|| attachment_error("CODEX-ATTACHMENT-TOTAL-LIMIT", true))?;
                if total > MAX_ATTACHMENT_TOTAL_BYTES {
                    return Err(attachment_error("CODEX-ATTACHMENT-TOTAL-LIMIT", true));
                }
                selected.push(record.clone());
            }
            selected
        };

        let validation_context = context.clone();
        let validated = tokio::task::spawn_blocking(move || {
            validate_root_identity(&validation_context)?;
            records
                .into_iter()
                .map(|record| {
                    let snapshot =
                        snapshot_candidate(&validation_context, &record.snapshot.canonical_path)?;
                    if snapshot.fingerprint != record.snapshot.fingerprint
                        || snapshot.canonical_path != record.snapshot.canonical_path
                        || snapshot.kind != record.snapshot.kind
                        || snapshot.relative_path != record.snapshot.relative_path
                        || snapshot.name != record.snapshot.name
                    {
                        return Err(CandidateError::new("CODEX-ATTACHMENT-SOURCE-CHANGED", true));
                    }
                    Ok(record)
                })
                .collect::<Result<Vec<_>, CandidateError>>()
        })
        .await
        .map_err(|_| attachment_error("CODEX-ATTACHMENT-VALIDATOR-FAILED", true))?
        .map_err(candidate_command_error)?;

        let inputs = validated
            .iter()
            .map(|record| {
                let path = record
                    .snapshot
                    .canonical_path
                    .to_str()
                    .ok_or_else(|| attachment_error("CODEX-ATTACHMENT-PATH-INVALID", false))?
                    .to_owned();
                Ok(match record.snapshot.kind {
                    AttachmentKind::Image => ResolvedAttachment::LocalImage { path },
                    AttachmentKind::File => ResolvedAttachment::Mention {
                        name: record.snapshot.name.clone(),
                        path,
                    },
                })
            })
            .collect::<Result<Vec<_>, CodexCommandError>>()?;
        Ok(ResolvedAttachmentSet {
            handles: handles.to_vec(),
            inputs,
        })
    }

    pub async fn consume(&self, context: &AttachmentWorkspaceContext, handles: &[String]) {
        let mut records = self.records.lock().await;
        for handle in handles {
            if records
                .get(handle)
                .is_some_and(|record| record_matches_context(record, context))
            {
                records.remove(handle);
            }
        }
    }

    async fn register_candidates(
        &self,
        context: AttachmentWorkspaceContext,
        source: AttachmentSource,
        candidates: Vec<PathBuf>,
        existing_handles: Vec<String>,
    ) -> Result<AttachmentRegistrationResponse, CodexCommandError> {
        validate_context_shape(&context)?;
        validate_handle_list(&existing_handles)?;
        if candidates.len() > MAX_CANDIDATE_COUNT {
            return Err(attachment_error("CODEX-ATTACHMENT-CANDIDATE-LIMIT", true));
        }

        let validation_context = context.clone();
        let snapshots = tokio::task::spawn_blocking(move || {
            validate_root_identity(&validation_context)?;
            Ok::<_, CandidateError>(
                candidates
                    .into_iter()
                    .map(|candidate| snapshot_candidate(&validation_context, &candidate))
                    .collect::<Vec<_>>(),
            )
        })
        .await
        .map_err(|_| attachment_error("CODEX-ATTACHMENT-VALIDATOR-FAILED", true))?
        .map_err(candidate_command_error)?;

        let now = self.clock.now();
        let expires_at = now
            .checked_add(ATTACHMENT_TTL)
            .ok_or_else(|| attachment_error("CODEX-ATTACHMENT-CLOCK", false))?;
        let mut records = self.records.lock().await;
        records.retain(|_, record| record.expires_at >= now);

        let existing = existing_handles
            .iter()
            .filter_map(|handle| records.get(handle))
            .filter(|record| record_matches_context(record, &context))
            .collect::<Vec<_>>();
        let mut count = existing.len();
        let mut total = existing
            .iter()
            .map(|record| record.snapshot.bytes)
            .sum::<u64>();
        let mut paths = existing
            .iter()
            .map(|record| record.snapshot.canonical_path.clone())
            .collect::<HashSet<_>>();
        let mut items = Vec::new();
        let mut rejections = Vec::new();

        for (candidate_index, snapshot) in snapshots.into_iter().enumerate() {
            let snapshot = match snapshot {
                Ok(snapshot) => snapshot,
                Err(error) => {
                    rejections.push(rejection(candidate_index, error));
                    continue;
                }
            };
            if paths.contains(&snapshot.canonical_path) {
                rejections.push(rejection(
                    candidate_index,
                    CandidateError::new("CODEX-ATTACHMENT-DUPLICATE", true),
                ));
                continue;
            }
            if count >= MAX_ATTACHMENT_COUNT {
                rejections.push(rejection(
                    candidate_index,
                    CandidateError::new("CODEX-ATTACHMENT-COUNT-LIMIT", true),
                ));
                continue;
            }
            let Some(next_total) = total.checked_add(snapshot.bytes) else {
                rejections.push(rejection(
                    candidate_index,
                    CandidateError::new("CODEX-ATTACHMENT-TOTAL-LIMIT", true),
                ));
                continue;
            };
            if next_total > MAX_ATTACHMENT_TOTAL_BYTES {
                rejections.push(rejection(
                    candidate_index,
                    CandidateError::new("CODEX-ATTACHMENT-TOTAL-LIMIT", true),
                ));
                continue;
            }

            let handle = format!("attachment-{}", uuid::Uuid::new_v4());
            let record = AttachmentRecord {
                handle: handle.clone(),
                workspace_id: context.workspace_id.clone(),
                generation: context.generation,
                root_device: context.root_device,
                root_inode: context.root_inode,
                source,
                expires_at,
                snapshot,
            };
            count += 1;
            total = next_total;
            paths.insert(record.snapshot.canonical_path.clone());
            items.push(view(&record));
            records.insert(handle, record);
        }

        Ok(AttachmentRegistrationResponse { items, rejections })
    }
}

fn validate_context_shape(context: &AttachmentWorkspaceContext) -> Result<(), CodexCommandError> {
    if context.workspace_id.is_empty()
        || context.workspace_id.len() > 128
        || context.workspace_id.contains('\0')
        || context.generation == 0
        || !context.canonical_root.is_absolute()
    {
        return Err(attachment_error("CODEX-ATTACHMENT-CONTEXT-INVALID", false));
    }
    Ok(())
}

fn validate_handle_list(handles: &[String]) -> Result<(), CodexCommandError> {
    let mut seen = HashSet::new();
    if handles.len() > MAX_ATTACHMENT_COUNT
        || handles.iter().any(|handle| {
            let Some(value) = handle.strip_prefix("attachment-") else {
                return true;
            };
            handle.len() != 47
                || uuid::Uuid::parse_str(value).is_err()
                || !seen.insert(handle.as_str())
        })
    {
        return Err(attachment_error("CODEX-ATTACHMENT-HANDLES-INVALID", false));
    }
    Ok(())
}

fn record_matches_context(record: &AttachmentRecord, context: &AttachmentWorkspaceContext) -> bool {
    record.workspace_id == context.workspace_id
        && record.generation == context.generation
        && record.root_device == context.root_device
        && record.root_inode == context.root_inode
}

fn validate_root_identity(context: &AttachmentWorkspaceContext) -> Result<(), CandidateError> {
    let metadata = fs::symlink_metadata(&context.canonical_root)
        .map_err(|_| CandidateError::new("CODEX-ATTACHMENT-ROOT-MISSING", true))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(CandidateError::new("CODEX-ATTACHMENT-ROOT-CHANGED", false));
    }
    let (device, inode) = metadata_identity(&metadata);
    if device != context.root_device || inode != context.root_inode {
        return Err(CandidateError::new("CODEX-ATTACHMENT-ROOT-CHANGED", false));
    }
    Ok(())
}

fn snapshot_candidate(
    context: &AttachmentWorkspaceContext,
    candidate: &Path,
) -> Result<CandidateSnapshot, CandidateError> {
    if !candidate.is_absolute()
        || candidate.as_os_str().len() > MAX_PATH_BYTES
        || candidate.as_os_str().is_empty()
    {
        return Err(CandidateError::new("CODEX-ATTACHMENT-PATH-INVALID", false));
    }
    validate_root_identity(context)?;
    reject_original_symlink_components(&context.canonical_root, candidate)?;
    let canonical_path = fs::canonicalize(candidate)
        .map_err(|_| CandidateError::new("CODEX-ATTACHMENT-MISSING", true))?;
    if !canonical_path.starts_with(&context.canonical_root)
        || canonical_path == context.canonical_root
        || canonical_path.to_str().is_none()
    {
        return Err(CandidateError::new(
            "CODEX-ATTACHMENT-OUTSIDE-WORKSPACE",
            false,
        ));
    }
    let relative = canonical_path
        .strip_prefix(&context.canonical_root)
        .map_err(|_| CandidateError::new("CODEX-ATTACHMENT-OUTSIDE-WORKSPACE", false))?;
    if relative
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(CandidateError::new("CODEX-ATTACHMENT-PATH-INVALID", false));
    }
    reject_canonical_symlink_components(&context.canonical_root, relative)?;

    let mut file = open_read_no_follow(&canonical_path)?;
    let before = file
        .metadata()
        .map_err(|_| CandidateError::new("CODEX-ATTACHMENT-METADATA", true))?;
    validate_regular_file(&before)?;
    if before.len() > MAX_ATTACHMENT_BYTES {
        return Err(CandidateError::new(
            "CODEX-ATTACHMENT-FILE-SIZE-LIMIT",
            true,
        ));
    }

    let capacity = usize::try_from(before.len())
        .map_err(|_| CandidateError::new("CODEX-ATTACHMENT-FILE-SIZE-LIMIT", true))?;
    let mut contents = Vec::with_capacity(capacity);
    file.by_ref()
        .take(MAX_ATTACHMENT_BYTES + 1)
        .read_to_end(&mut contents)
        .map_err(|_| CandidateError::new("CODEX-ATTACHMENT-READ", true))?;
    if contents.len() as u64 != before.len() {
        return Err(CandidateError::new("CODEX-ATTACHMENT-SOURCE-CHANGED", true));
    }
    let after = file
        .metadata()
        .map_err(|_| CandidateError::new("CODEX-ATTACHMENT-METADATA", true))?;
    if metadata_source_identity(&before) != metadata_source_identity(&after) {
        return Err(CandidateError::new("CODEX-ATTACHMENT-SOURCE-CHANGED", true));
    }
    if fs::canonicalize(candidate).ok().as_ref() != Some(&canonical_path) {
        return Err(CandidateError::new("CODEX-ATTACHMENT-SOURCE-CHANGED", true));
    }
    validate_root_identity(context)?;

    let relative_path = relative.to_str().filter(|value| {
        !value.is_empty() && value.len() <= MAX_PATH_BYTES && !value.chars().any(char::is_control)
    });
    let relative_path = relative_path
        .ok_or_else(|| CandidateError::new("CODEX-ATTACHMENT-PATH-INVALID", false))?
        .replace(std::path::MAIN_SEPARATOR, "/");
    let name = canonical_path
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| {
            !value.is_empty() && value.len() <= 255 && !value.chars().any(char::is_control)
        })
        .ok_or_else(|| CandidateError::new("CODEX-ATTACHMENT-PATH-INVALID", false))?
        .to_owned();
    let mut fingerprint = metadata_source_identity(&after);
    fingerprint.sha256 = hex::encode(Sha256::digest(&contents));
    let kind = if is_supported_raster_image(&contents) {
        AttachmentKind::Image
    } else {
        AttachmentKind::File
    };

    Ok(CandidateSnapshot {
        canonical_path,
        name,
        relative_path,
        bytes: after.len(),
        kind,
        fingerprint,
    })
}

fn reject_original_symlink_components(root: &Path, candidate: &Path) -> Result<(), CandidateError> {
    let relative = candidate
        .strip_prefix(root)
        .map_err(|_| CandidateError::new("CODEX-ATTACHMENT-OUTSIDE-WORKSPACE", false))?;
    let mut current = root.to_path_buf();
    for component in relative.components() {
        let Component::Normal(component) = component else {
            return Err(CandidateError::new("CODEX-ATTACHMENT-PATH-INVALID", false));
        };
        current.push(component);
        let metadata = fs::symlink_metadata(&current)
            .map_err(|_| CandidateError::new("CODEX-ATTACHMENT-MISSING", true))?;
        if metadata.file_type().is_symlink() {
            return Err(CandidateError::new("CODEX-ATTACHMENT-SYMLINK", false));
        }
    }
    Ok(())
}

fn reject_canonical_symlink_components(root: &Path, relative: &Path) -> Result<(), CandidateError> {
    let mut current = root.to_path_buf();
    for component in relative.components() {
        let Component::Normal(component) = component else {
            return Err(CandidateError::new("CODEX-ATTACHMENT-PATH-INVALID", false));
        };
        current.push(component);
        let metadata = fs::symlink_metadata(&current)
            .map_err(|_| CandidateError::new("CODEX-ATTACHMENT-MISSING", true))?;
        if metadata.file_type().is_symlink() {
            return Err(CandidateError::new("CODEX-ATTACHMENT-SYMLINK", false));
        }
    }
    Ok(())
}

fn open_read_no_follow(path: &Path) -> Result<File, CandidateError> {
    #[cfg(unix)]
    {
        OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(path)
            .map_err(|_| CandidateError::new("CODEX-ATTACHMENT-UNREADABLE", true))
    }
    #[cfg(not(unix))]
    {
        File::open(path).map_err(|_| CandidateError::new("CODEX-ATTACHMENT-UNREADABLE", true))
    }
}

fn validate_regular_file(metadata: &fs::Metadata) -> Result<(), CandidateError> {
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(CandidateError::new("CODEX-ATTACHMENT-NONREGULAR", false));
    }
    #[cfg(unix)]
    {
        let mode = metadata.permissions().mode();
        if mode & 0o444 == 0 {
            return Err(CandidateError::new("CODEX-ATTACHMENT-UNREADABLE", true));
        }
        if mode & 0o111 != 0 {
            return Err(CandidateError::new("CODEX-ATTACHMENT-EXECUTABLE", false));
        }
        if metadata.nlink() != 1 {
            return Err(CandidateError::new("CODEX-ATTACHMENT-HARDLINK", false));
        }
    }
    #[cfg(not(unix))]
    if metadata.permissions().readonly() {
        return Err(CandidateError::new("CODEX-ATTACHMENT-UNREADABLE", true));
    }
    Ok(())
}

fn metadata_identity(metadata: &fs::Metadata) -> (u64, u64) {
    #[cfg(unix)]
    {
        (metadata.dev(), metadata.ino())
    }
    #[cfg(not(unix))]
    {
        let modified = metadata
            .modified()
            .ok()
            .and_then(|value| value.duration_since(SystemTime::UNIX_EPOCH).ok())
            .map_or(0, |duration| duration.as_nanos() as u64);
        (metadata.len(), modified)
    }
}

fn metadata_source_identity(metadata: &fs::Metadata) -> SourceFingerprint {
    let (device, inode) = metadata_identity(metadata);
    #[cfg(unix)]
    let (modified_seconds, modified_nanoseconds) = (metadata.mtime(), metadata.mtime_nsec());
    #[cfg(not(unix))]
    let (modified_seconds, modified_nanoseconds) = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map_or((0, 0), |duration| {
            (duration.as_secs() as i64, duration.subsec_nanos() as i64)
        });
    SourceFingerprint {
        device,
        inode,
        bytes: metadata.len(),
        modified_seconds,
        modified_nanoseconds,
        sha256: String::new(),
    }
}

fn is_supported_raster_image(contents: &[u8]) -> bool {
    contents.starts_with(b"\x89PNG\r\n\x1a\n")
        || contents.starts_with(b"\xff\xd8\xff")
        || contents.starts_with(b"GIF87a")
        || contents.starts_with(b"GIF89a")
        || (contents.len() >= 12 && &contents[..4] == b"RIFF" && &contents[8..12] == b"WEBP")
}

fn view(record: &AttachmentRecord) -> AttachmentView {
    AttachmentView {
        schema_version: ATTACHMENT_SCHEMA_VERSION,
        handle: record.handle.clone(),
        name: record.snapshot.name.clone(),
        relative_path: record.snapshot.relative_path.clone(),
        size_bytes: record.snapshot.bytes,
        kind: record.snapshot.kind,
        source: record.source,
        expires_at: chrono::DateTime::<chrono::Utc>::from(record.expires_at).to_rfc3339(),
    }
}

fn rejection(candidate_index: usize, error: CandidateError) -> AttachmentRejection {
    AttachmentRejection {
        candidate_index,
        code: error.code.to_owned(),
        recoverable: error.recoverable,
    }
}

fn candidate_command_error(error: CandidateError) -> CodexCommandError {
    attachment_error(error.code, error.recoverable)
}

fn attachment_error(code: &str, recoverable: bool) -> CodexCommandError {
    CodexCommandError::new(code, ATTACHMENT_OPERATION, recoverable)
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;
    use std::fs;
    #[cfg(unix)]
    use std::os::unix::fs::{symlink, PermissionsExt};
    use std::sync::{Arc, Mutex as StdMutex};
    use std::time::{Duration, SystemTime};

    use serde_json::Value;

    use super::*;

    const CONTRACT_FIXTURE: &str =
        include_str!("../../../src/test/fixtures/codex-attachments.v1.json");

    struct FixedPicker(Vec<PathBuf>);

    impl AttachmentFilePicker for FixedPicker {
        fn pick_files(&self) -> AttachmentPickerFuture<'_> {
            let paths = self.0.clone();
            Box::pin(async move { paths })
        }
    }

    struct TestClock(StdMutex<SystemTime>);

    impl TestClock {
        fn new() -> Self {
            Self(StdMutex::new(
                SystemTime::UNIX_EPOCH + Duration::from_secs(1_800_000_000),
            ))
        }

        fn advance(&self, duration: Duration) {
            let mut now = self.0.lock().expect("clock lock");
            *now = now.checked_add(duration).expect("test clock range");
        }
    }

    impl AttachmentClock for TestClock {
        fn now(&self) -> SystemTime {
            *self.0.lock().expect("clock lock")
        }
    }

    struct TestRoot(PathBuf);

    impl TestRoot {
        fn new() -> Self {
            let path = std::env::temp_dir()
                .join(format!("coding-wife-attachments-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&path).expect("attachment root");
            Self(fs::canonicalize(path).expect("canonical root"))
        }

        fn file(&self, relative: &str, contents: &[u8]) -> PathBuf {
            let path = self.0.join(relative);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).expect("attachment parent");
            }
            fs::write(&path, contents).expect("attachment fixture");
            path
        }

        fn sparse_file(&self, relative: &str, bytes: u64) -> PathBuf {
            let path = self.file(relative, &[]);
            File::options()
                .write(true)
                .open(&path)
                .expect("sparse fixture")
                .set_len(bytes)
                .expect("sparse fixture length");
            path
        }

        fn context(&self) -> AttachmentWorkspaceContext {
            let metadata = fs::symlink_metadata(&self.0).expect("root metadata");
            let (root_device, root_inode) = metadata_identity(&metadata);
            AttachmentWorkspaceContext {
                workspace_id: "workspace-attachment-fixture".to_owned(),
                generation: 7,
                canonical_root: self.0.clone(),
                root_device,
                root_inode,
            }
        }
    }

    impl Drop for TestRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn service(picker: Vec<PathBuf>, clock: Arc<TestClock>) -> AttachmentService {
        AttachmentService::new(Arc::new(FixedPicker(picker)), clock)
    }

    #[test]
    fn public_attachment_fixture_round_trips_without_private_paths() {
        let fixture: Value = serde_json::from_str(CONTRACT_FIXTURE).expect("attachment fixture");
        let expected = fixture.get("registration").expect("registration fixture");
        let response: AttachmentRegistrationResponse =
            serde_json::from_value(expected.clone()).expect("deserialize fixture");

        assert_eq!(
            serde_json::to_value(response).expect("serialize fixture"),
            *expected
        );
        assert!(!expected.to_string().contains("/Users/"));
    }

    #[tokio::test]
    async fn picker_drop_and_paste_share_validation_and_map_safe_inputs() {
        let root = TestRoot::new();
        let png = root.file("images/demo.png", b"\x89PNG\r\n\x1a\nfixture");
        let text = root.file("notes.txt", b"bounded notes");
        let webp = root.file("images/demo.webp", b"RIFF\x04\x00\x00\x00WEBPdata");
        let executable = root.file("run.sh", b"#!/bin/sh\nexit 0\n");
        #[cfg(unix)]
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700))
            .expect("executable mode");
        let clock = Arc::new(TestClock::new());
        let service = service(vec![png, executable], clock);
        let context = root.context();

        let picked = service
            .pick_and_register(context.clone(), vec![])
            .await
            .expect("picker response");
        assert_eq!(picked.items.len(), 1);
        assert_eq!(picked.items[0].kind, AttachmentKind::Image);
        assert_eq!(picked.items[0].source, AttachmentSource::Picker);
        assert_eq!(picked.rejections[0].code, "CODEX-ATTACHMENT-EXECUTABLE");

        let dropped = service
            .register_paths(
                context.clone(),
                AttachmentSource::Drop,
                vec![text.to_string_lossy().into_owned()],
                vec![picked.items[0].handle.clone()],
            )
            .await
            .expect("drop response");
        let pasted = service
            .register_paths(
                context.clone(),
                AttachmentSource::Paste,
                vec![webp.to_string_lossy().into_owned()],
                vec![
                    picked.items[0].handle.clone(),
                    dropped.items[0].handle.clone(),
                ],
            )
            .await
            .expect("paste response");

        assert_eq!(dropped.items[0].kind, AttachmentKind::File);
        assert_eq!(dropped.items[0].source, AttachmentSource::Drop);
        assert_eq!(pasted.items[0].kind, AttachmentKind::Image);
        assert_eq!(pasted.items[0].source, AttachmentSource::Paste);
        let public = serde_json::to_string(&[&picked, &dropped, &pasted])
            .expect("public response serialization");
        assert!(!public.contains(&root.0.to_string_lossy().to_string()));

        let handles = vec![
            picked.items[0].handle.clone(),
            dropped.items[0].handle.clone(),
            pasted.items[0].handle.clone(),
        ];
        let resolved = service
            .resolve_for_turn(context, &handles)
            .await
            .expect("resolve attachments");
        assert!(matches!(
            &resolved.inputs[0],
            ResolvedAttachment::LocalImage { path } if path.ends_with("images/demo.png")
        ));
        assert!(matches!(
            &resolved.inputs[1],
            ResolvedAttachment::Mention { name, path }
                if name == "notes.txt" && path.ends_with("notes.txt")
        ));
        assert!(matches!(
            &resolved.inputs[2],
            ResolvedAttachment::LocalImage { path } if path.ends_with("images/demo.webp")
        ));
    }

    #[tokio::test]
    async fn rejects_each_unsafe_candidate_without_dropping_the_valid_file() {
        let root = TestRoot::new();
        let valid = root.file("valid.txt", b"valid");
        let directory = root.0.join("directory");
        fs::create_dir(&directory).expect("directory fixture");
        let executable = root.file("executable", b"exec");
        let unreadable = root.file("unreadable", b"private");
        let oversized = root.sparse_file("oversized.bin", MAX_ATTACHMENT_BYTES + 1);
        let outside =
            std::env::temp_dir().join(format!("coding-wife-outside-{}", uuid::Uuid::new_v4()));
        fs::write(&outside, b"outside").expect("outside fixture");
        #[cfg(unix)]
        {
            fs::set_permissions(&executable, fs::Permissions::from_mode(0o700))
                .expect("executable mode");
            fs::set_permissions(&unreadable, fs::Permissions::from_mode(0o000))
                .expect("unreadable mode");
        }
        #[cfg(unix)]
        let symlink_path = {
            let path = root.0.join("symlink.txt");
            symlink(&valid, &path).expect("symlink fixture");
            path
        };

        let mut candidates = vec![
            directory,
            executable,
            unreadable.clone(),
            oversized,
            outside.clone(),
        ];
        #[cfg(unix)]
        candidates.push(symlink_path);
        candidates.push(valid);
        let clock = Arc::new(TestClock::new());
        let service = service(vec![], clock);
        let response = service
            .register_paths(
                root.context(),
                AttachmentSource::Drop,
                candidates
                    .into_iter()
                    .map(|path| path.to_string_lossy().into_owned())
                    .collect(),
                vec![],
            )
            .await
            .expect("partial registration");

        assert_eq!(response.items.len(), 1);
        assert_eq!(response.items[0].relative_path, "valid.txt");
        let codes = response
            .rejections
            .iter()
            .map(|rejection| rejection.code.as_str())
            .collect::<HashSet<_>>();
        assert!(codes.contains("CODEX-ATTACHMENT-NONREGULAR"));
        assert!(codes.contains("CODEX-ATTACHMENT-EXECUTABLE"));
        assert!(codes.contains("CODEX-ATTACHMENT-UNREADABLE"));
        assert!(codes.contains("CODEX-ATTACHMENT-FILE-SIZE-LIMIT"));
        assert!(codes.contains("CODEX-ATTACHMENT-OUTSIDE-WORKSPACE"));
        #[cfg(unix)]
        assert!(codes.contains("CODEX-ATTACHMENT-SYMLINK"));

        #[cfg(unix)]
        fs::set_permissions(&unreadable, fs::Permissions::from_mode(0o600))
            .expect("restore unreadable fixture");
        let _ = fs::remove_file(outside);
    }

    #[tokio::test]
    async fn enforces_exact_count_file_and_total_boundaries() {
        let root = TestRoot::new();
        let count_files = (0..11)
            .map(|index| root.file(&format!("count-{index}.txt"), b"x"))
            .map(|path| path.to_string_lossy().into_owned())
            .collect();
        let clock = Arc::new(TestClock::new());
        let count_service = service(vec![], clock.clone());
        let count = count_service
            .register_paths(root.context(), AttachmentSource::Drop, count_files, vec![])
            .await
            .expect("count boundary");
        assert_eq!(count.items.len(), MAX_ATTACHMENT_COUNT);
        assert_eq!(count.rejections.len(), 1);
        assert_eq!(count.rejections[0].code, "CODEX-ATTACHMENT-COUNT-LIMIT");

        let exact_a = root.sparse_file("exact-a.bin", MAX_ATTACHMENT_BYTES);
        let exact_b = root.sparse_file("exact-b.bin", MAX_ATTACHMENT_BYTES);
        let extra = root.file("extra.bin", b"x");
        let total_service = service(vec![], clock);
        let total = total_service
            .register_paths(
                root.context(),
                AttachmentSource::Paste,
                [exact_a, exact_b, extra]
                    .into_iter()
                    .map(|path| path.to_string_lossy().into_owned())
                    .collect(),
                vec![],
            )
            .await
            .expect("total boundary");
        assert_eq!(total.items.len(), 2);
        assert_eq!(
            total.items.iter().map(|item| item.size_bytes).sum::<u64>(),
            MAX_ATTACHMENT_TOTAL_BYTES
        );
        assert_eq!(total.rejections.len(), 1);
        assert_eq!(total.rejections[0].code, "CODEX-ATTACHMENT-TOTAL-LIMIT");
    }

    #[tokio::test]
    async fn expiry_generation_workspace_root_and_hash_are_revalidated() {
        let root = TestRoot::new();
        let source = root.file("source.txt", b"first");
        let clock = Arc::new(TestClock::new());
        let service = service(vec![], clock.clone());
        let context = root.context();
        let registered = service
            .register_paths(
                context.clone(),
                AttachmentSource::Drop,
                vec![source.to_string_lossy().into_owned()],
                vec![],
            )
            .await
            .expect("register source");
        let handle = registered.items[0].handle.clone();

        for stale in [
            AttachmentWorkspaceContext {
                generation: context.generation + 1,
                ..context.clone()
            },
            AttachmentWorkspaceContext {
                workspace_id: "workspace-other".to_owned(),
                ..context.clone()
            },
            AttachmentWorkspaceContext {
                root_inode: context.root_inode.wrapping_add(1),
                ..context.clone()
            },
        ] {
            let error = service
                .resolve_for_turn(stale, std::slice::from_ref(&handle))
                .await
                .expect_err("stale handle");
            assert!(matches!(
                error.code.as_str(),
                "CODEX-ATTACHMENT-HANDLE-STALE" | "CODEX-ATTACHMENT-ROOT-CHANGED"
            ));
        }

        fs::write(&source, b"other").expect("mutate same-sized source");
        let changed = service
            .resolve_for_turn(context.clone(), std::slice::from_ref(&handle))
            .await
            .expect_err("source hash changed");
        assert_eq!(changed.code, "CODEX-ATTACHMENT-SOURCE-CHANGED");

        fs::write(&source, b"first").expect("restore source");
        let refreshed = service
            .register_paths(
                context.clone(),
                AttachmentSource::Paste,
                vec![source.to_string_lossy().into_owned()],
                vec![],
            )
            .await
            .expect("refresh source");
        let refreshed_handle = refreshed.items[0].handle.clone();
        clock.advance(ATTACHMENT_TTL + Duration::from_secs(1));
        let expired = service
            .resolve_for_turn(context, std::slice::from_ref(&refreshed_handle))
            .await
            .expect_err("expired handle");
        assert_eq!(expired.code, "CODEX-ATTACHMENT-HANDLE-EXPIRED");
    }

    #[tokio::test]
    async fn consume_invalidates_only_after_an_explicit_acceptance_boundary() {
        let root = TestRoot::new();
        let source = root.file("source.txt", b"source");
        let clock = Arc::new(TestClock::new());
        let service = service(vec![], clock);
        let context = root.context();
        let registered = service
            .register_paths(
                context.clone(),
                AttachmentSource::Drop,
                vec![source.to_string_lossy().into_owned()],
                vec![],
            )
            .await
            .expect("register source");
        let handles = vec![registered.items[0].handle.clone()];

        let resolved = service
            .resolve_for_turn(context.clone(), &handles)
            .await
            .expect("pre-send validation");
        assert_eq!(resolved.handles, handles);
        service.consume(&context, &resolved.handles).await;
        let error = service
            .resolve_for_turn(context, &handles)
            .await
            .expect_err("consumed handle");
        assert_eq!(error.code, "CODEX-ATTACHMENT-HANDLE-INVALID");
    }
}
