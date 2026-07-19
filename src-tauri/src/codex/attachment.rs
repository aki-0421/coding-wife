use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::future::Future;
use std::io::{Read, Seek, SeekFrom, Write};
#[cfg(unix)]
use std::os::unix::ffi::OsStrExt;
#[cfg(unix)]
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
#[cfg(unix)]
use std::os::unix::io::{AsRawFd, FromRawFd};
use std::path::{Component, Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex, Weak};
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
const SNAPSHOT_DIRECTORY_NAME: &str = "attachment-snapshots";
const SNAPSHOT_BUFFER_BYTES: usize = 64 * 1024;

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

#[derive(Clone, Eq, PartialEq)]
pub(crate) enum ResolvedAttachment {
    LocalImage { path: String },
    Mention { name: String, path: String },
}

impl std::fmt::Debug for ResolvedAttachment {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::LocalImage { .. } => formatter
                .debug_struct("LocalImage")
                .field("path", &"<private-snapshot>")
                .finish(),
            Self::Mention { name, .. } => formatter
                .debug_struct("Mention")
                .field("name", name)
                .field("path", &"<private-snapshot>")
                .finish(),
        }
    }
}

pub struct ResolvedAttachmentSet {
    handles: Vec<String>,
    inputs: Vec<ResolvedAttachment>,
    snapshot_lease: Option<AttachmentSnapshotLease>,
}

impl ResolvedAttachmentSet {
    pub(crate) fn handles(&self) -> &[String] {
        &self.handles
    }

    pub(crate) fn into_parts(
        self,
    ) -> (
        Vec<String>,
        Vec<ResolvedAttachment>,
        Option<AttachmentSnapshotLease>,
    ) {
        (self.handles, self.inputs, self.snapshot_lease)
    }
}

impl std::fmt::Debug for ResolvedAttachmentSet {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ResolvedAttachmentSet")
            .field("handle_count", &self.handles.len())
            .field("input_count", &self.inputs.len())
            .field("snapshot", &"<private>")
            .finish()
    }
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

struct PreparedSnapshotSet {
    directory: PathBuf,
    inputs: Vec<ResolvedAttachment>,
}

struct UncommittedSnapshotDirectory {
    root: PathBuf,
    directory: PathBuf,
    committed: bool,
}

impl UncommittedSnapshotDirectory {
    fn commit(mut self) -> PathBuf {
        self.committed = true;
        self.directory.clone()
    }
}

impl Drop for UncommittedSnapshotDirectory {
    fn drop(&mut self) {
        if !self.committed {
            let _ = remove_snapshot_directory(&self.root, &self.directory);
        }
    }
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

struct SnapshotLeaseInner {
    root: PathBuf,
    directory: PathBuf,
    expires_at: SystemTime,
    cleaned: AtomicBool,
}

impl SnapshotLeaseInner {
    fn cleanup(&self) {
        if self.cleaned.swap(true, Ordering::AcqRel) {
            return;
        }
        let _ = remove_snapshot_directory(&self.root, &self.directory);
    }
}

impl Drop for SnapshotLeaseInner {
    fn drop(&mut self) {
        self.cleanup();
    }
}

#[derive(Clone)]
pub(crate) struct AttachmentSnapshotLease(Arc<SnapshotLeaseInner>);

impl std::fmt::Debug for AttachmentSnapshotLease {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("AttachmentSnapshotLease(<private>)")
    }
}

impl AttachmentSnapshotLease {
    pub(crate) fn cleanup(&self) {
        self.0.cleanup();
    }

    fn is_expired(&self, now: SystemTime) -> bool {
        self.0.expires_at < now
    }
}

#[cfg(test)]
pub(crate) fn attachment_snapshot_lease_for_test(
    root: PathBuf,
    directory: PathBuf,
) -> AttachmentSnapshotLease {
    AttachmentSnapshotLease(Arc::new(SnapshotLeaseInner {
        root,
        directory,
        expires_at: SystemTime::now() + ATTACHMENT_TTL,
        cleaned: AtomicBool::new(false),
    }))
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
    snapshot_root: Arc<PathBuf>,
    snapshot_leases: Arc<StdMutex<Vec<Weak<SnapshotLeaseInner>>>>,
}

impl AttachmentService {
    pub fn production(app_data_directory: impl AsRef<Path>) -> Result<Self, CodexCommandError> {
        Self::new(
            Arc::new(NativeAttachmentFilePicker),
            Arc::new(SystemAttachmentClock),
            app_data_directory,
        )
    }

    pub fn new(
        picker: Arc<dyn AttachmentFilePicker>,
        clock: Arc<dyn AttachmentClock>,
        app_data_directory: impl AsRef<Path>,
    ) -> Result<Self, CodexCommandError> {
        let snapshot_root =
            prepare_snapshot_root(app_data_directory.as_ref()).map_err(candidate_command_error)?;
        Ok(Self {
            picker,
            clock,
            records: Arc::new(Mutex::new(HashMap::new())),
            snapshot_root: Arc::new(snapshot_root),
            snapshot_leases: Arc::new(StdMutex::new(Vec::new())),
        })
    }

    fn cleanup_expired_snapshots(&self) {
        let now = self.clock.now();
        let mut leases = self
            .snapshot_leases
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        leases.retain(|weak| {
            let Some(inner) = weak.upgrade() else {
                return false;
            };
            let lease = AttachmentSnapshotLease(inner);
            if lease.is_expired(now) {
                lease.cleanup();
            }
            !lease.0.cleaned.load(Ordering::Acquire)
        });
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
        self.cleanup_expired_snapshots();
        validate_context_shape(&context)?;
        validate_handle_list(handles)?;
        if handles.is_empty() {
            return Ok(ResolvedAttachmentSet {
                handles: Vec::new(),
                inputs: Vec::new(),
                snapshot_lease: None,
            });
        }
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
        let snapshot_root = self.snapshot_root.as_ref().clone();
        let snapshot_expires_at = records
            .iter()
            .map(|record| record.expires_at)
            .min()
            .expect("non-empty attachment records");
        let prepared = tokio::task::spawn_blocking(move || {
            prepare_attachment_snapshots(&validation_context, &snapshot_root, &records)
        })
        .await
        .map_err(|_| attachment_error("CODEX-ATTACHMENT-VALIDATOR-FAILED", true))?
        .map_err(candidate_command_error)?;

        let lease_inner = Arc::new(SnapshotLeaseInner {
            root: self.snapshot_root.as_ref().clone(),
            directory: prepared.directory,
            expires_at: snapshot_expires_at,
            cleaned: AtomicBool::new(false),
        });
        self.snapshot_leases
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push(Arc::downgrade(&lease_inner));
        let lease = AttachmentSnapshotLease(lease_inner);
        schedule_snapshot_expiry(&lease, snapshot_expires_at, now);
        Ok(ResolvedAttachmentSet {
            handles: handles.to_vec(),
            inputs: prepared.inputs,
            snapshot_lease: Some(lease),
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
        self.cleanup_expired_snapshots();
        validate_context_shape(&context)?;
        validate_handle_list(&existing_handles)?;
        if candidates.len() > MAX_CANDIDATE_COUNT {
            return Err(attachment_error("CODEX-ATTACHMENT-CANDIDATE-LIMIT", true));
        }

        let validation_context = context.clone();
        let snapshots = tokio::task::spawn_blocking(move || {
            let root = OpenedSourceRoot::open(&validation_context)?;
            Ok::<_, CandidateError>(
                candidates
                    .into_iter()
                    .map(|candidate| snapshot_candidate(&root, &validation_context, &candidate))
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

struct OpenedSourceRoot {
    directory: File,
    canonical_root: PathBuf,
}

impl OpenedSourceRoot {
    fn open(context: &AttachmentWorkspaceContext) -> Result<Self, CandidateError> {
        #[cfg(unix)]
        let directory = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(&context.canonical_root)
            .map_err(|_| CandidateError::new("CODEX-ATTACHMENT-ROOT-MISSING", true))?;
        #[cfg(not(unix))]
        let directory = File::open(&context.canonical_root)
            .map_err(|_| CandidateError::new("CODEX-ATTACHMENT-ROOT-MISSING", true))?;
        let metadata = directory
            .metadata()
            .map_err(|_| CandidateError::new("CODEX-ATTACHMENT-ROOT-MISSING", true))?;
        if !metadata.is_dir() {
            return Err(CandidateError::new("CODEX-ATTACHMENT-ROOT-CHANGED", false));
        }
        let (device, inode) = metadata_identity(&metadata);
        if device != context.root_device || inode != context.root_inode {
            return Err(CandidateError::new("CODEX-ATTACHMENT-ROOT-CHANGED", false));
        }
        Ok(Self {
            directory,
            canonical_root: context.canonical_root.clone(),
        })
    }

    #[cfg(unix)]
    fn open_relative(&self, relative: &Path) -> Result<File, CandidateError> {
        let components = relative
            .components()
            .map(|component| match component {
                Component::Normal(value) => Ok(value),
                _ => Err(CandidateError::new("CODEX-ATTACHMENT-PATH-INVALID", false)),
            })
            .collect::<Result<Vec<_>, _>>()?;
        if components.is_empty() {
            return Err(CandidateError::new("CODEX-ATTACHMENT-PATH-INVALID", false));
        }
        let mut directory = self
            .directory
            .try_clone()
            .map_err(|_| CandidateError::new("CODEX-ATTACHMENT-ROOT-MISSING", true))?;
        for (index, component) in components.iter().enumerate() {
            let component = std::ffi::CString::new(component.as_bytes())
                .map_err(|_| CandidateError::new("CODEX-ATTACHMENT-PATH-INVALID", false))?;
            let is_leaf = index + 1 == components.len();
            let flags = libc::O_RDONLY
                | libc::O_NOFOLLOW
                | libc::O_CLOEXEC
                | if is_leaf { 0 } else { libc::O_DIRECTORY };
            let descriptor =
                unsafe { libc::openat(directory.as_raw_fd(), component.as_ptr(), flags) };
            if descriptor < 0 {
                return Err(openat_candidate_error(
                    &directory,
                    component.as_c_str(),
                    std::io::Error::last_os_error(),
                ));
            }
            let opened = unsafe { File::from_raw_fd(descriptor) };
            if is_leaf {
                return Ok(opened);
            }
            directory = opened;
        }
        Err(CandidateError::new("CODEX-ATTACHMENT-PATH-INVALID", false))
    }

    #[cfg(not(unix))]
    fn open_relative(&self, relative: &Path) -> Result<File, CandidateError> {
        let path = self.canonical_root.join(relative);
        let canonical = fs::canonicalize(&path)
            .map_err(|_| CandidateError::new("CODEX-ATTACHMENT-MISSING", true))?;
        if canonical != path || !canonical.starts_with(&self.canonical_root) {
            return Err(CandidateError::new("CODEX-ATTACHMENT-SYMLINK", false));
        }
        File::open(canonical).map_err(|_| CandidateError::new("CODEX-ATTACHMENT-UNREADABLE", true))
    }
}

#[cfg(unix)]
fn openat_candidate_error(
    directory: &File,
    component: &std::ffi::CStr,
    error: std::io::Error,
) -> CandidateError {
    let mut metadata = std::mem::MaybeUninit::<libc::stat>::uninit();
    let metadata_result = unsafe {
        libc::fstatat(
            directory.as_raw_fd(),
            component.as_ptr(),
            metadata.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    };
    if metadata_result == 0 {
        let metadata = unsafe { metadata.assume_init() };
        if metadata.st_mode & libc::S_IFMT == libc::S_IFLNK {
            return CandidateError::new("CODEX-ATTACHMENT-SYMLINK", false);
        }
    }
    match error.raw_os_error() {
        Some(libc::ENOENT) => CandidateError::new("CODEX-ATTACHMENT-MISSING", true),
        Some(libc::EACCES) | Some(libc::EPERM) => {
            CandidateError::new("CODEX-ATTACHMENT-UNREADABLE", true)
        }
        Some(libc::ELOOP) => CandidateError::new("CODEX-ATTACHMENT-SYMLINK", false),
        _ => CandidateError::new("CODEX-ATTACHMENT-UNREADABLE", true),
    }
}

fn candidate_relative_path(
    context: &AttachmentWorkspaceContext,
    candidate: &Path,
) -> Result<PathBuf, CandidateError> {
    if !candidate.is_absolute()
        || candidate.as_os_str().len() > MAX_PATH_BYTES
        || candidate.as_os_str().is_empty()
    {
        return Err(CandidateError::new("CODEX-ATTACHMENT-PATH-INVALID", false));
    }
    let relative = candidate
        .strip_prefix(&context.canonical_root)
        .map_err(|_| CandidateError::new("CODEX-ATTACHMENT-OUTSIDE-WORKSPACE", false))?;
    if relative.as_os_str().is_empty()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(CandidateError::new("CODEX-ATTACHMENT-PATH-INVALID", false));
    }
    Ok(relative.to_path_buf())
}

fn inspect_source(mut file: File) -> Result<(SourceFingerprint, AttachmentKind), CandidateError> {
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
    let mut hasher = Sha256::new();
    let mut prefix = Vec::with_capacity(12);
    let mut bytes = 0_u64;
    let mut buffer = [0_u8; SNAPSHOT_BUFFER_BYTES];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|_| CandidateError::new("CODEX-ATTACHMENT-READ", true))?;
        if read == 0 {
            break;
        }
        bytes = bytes
            .checked_add(read as u64)
            .ok_or_else(|| CandidateError::new("CODEX-ATTACHMENT-FILE-SIZE-LIMIT", true))?;
        if bytes > MAX_ATTACHMENT_BYTES {
            return Err(CandidateError::new(
                "CODEX-ATTACHMENT-FILE-SIZE-LIMIT",
                true,
            ));
        }
        let prefix_bytes = read.min(12_usize.saturating_sub(prefix.len()));
        prefix.extend_from_slice(&buffer[..prefix_bytes]);
        hasher.update(&buffer[..read]);
    }
    if bytes != before.len() {
        return Err(CandidateError::new("CODEX-ATTACHMENT-SOURCE-CHANGED", true));
    }
    let after = file
        .metadata()
        .map_err(|_| CandidateError::new("CODEX-ATTACHMENT-METADATA", true))?;
    validate_regular_file(&after)?;
    if metadata_source_identity(&before) != metadata_source_identity(&after) {
        return Err(CandidateError::new("CODEX-ATTACHMENT-SOURCE-CHANGED", true));
    }
    let mut fingerprint = metadata_source_identity(&after);
    fingerprint.sha256 = hex::encode(hasher.finalize());
    let kind = if is_supported_raster_image(&prefix) {
        AttachmentKind::Image
    } else {
        AttachmentKind::File
    };
    Ok((fingerprint, kind))
}

fn public_relative_path(relative: &Path) -> Result<String, CandidateError> {
    let relative = relative
        .to_str()
        .filter(|value| {
            !value.is_empty()
                && value.len() <= MAX_PATH_BYTES
                && !value.chars().any(char::is_control)
        })
        .ok_or_else(|| CandidateError::new("CODEX-ATTACHMENT-PATH-INVALID", false))?;
    Ok(relative.replace(std::path::MAIN_SEPARATOR, "/"))
}

fn validated_file_name(path: &Path) -> Result<String, CandidateError> {
    path.file_name()
        .and_then(|value| value.to_str())
        .filter(|value| {
            !value.is_empty() && value.len() <= 255 && !value.chars().any(char::is_control)
        })
        .map(str::to_owned)
        .ok_or_else(|| CandidateError::new("CODEX-ATTACHMENT-PATH-INVALID", false))
}

fn snapshot_candidate(
    root: &OpenedSourceRoot,
    context: &AttachmentWorkspaceContext,
    candidate: &Path,
) -> Result<CandidateSnapshot, CandidateError> {
    let relative = candidate_relative_path(context, candidate)?;
    let canonical_path = context.canonical_root.join(&relative);
    let name = validated_file_name(&canonical_path)?;
    let file = root.open_relative(&relative)?;
    let (fingerprint, kind) = inspect_source(file)?;
    let relative_path = public_relative_path(&relative)?;

    Ok(CandidateSnapshot {
        canonical_path,
        name,
        relative_path,
        bytes: fingerprint.bytes,
        kind,
        fingerprint,
    })
}

fn prepare_attachment_snapshots(
    context: &AttachmentWorkspaceContext,
    snapshot_root: &Path,
    records: &[AttachmentRecord],
) -> Result<PreparedSnapshotSet, CandidateError> {
    let source_root = OpenedSourceRoot::open(context)?;
    let directory = create_snapshot_directory(snapshot_root)?;
    let pending = UncommittedSnapshotDirectory {
        root: snapshot_root.to_path_buf(),
        directory: directory.clone(),
        committed: false,
    };
    let mut inputs = Vec::with_capacity(records.len());
    for (index, record) in records.iter().enumerate() {
        let relative = record
            .snapshot
            .canonical_path
            .strip_prefix(&source_root.canonical_root)
            .map_err(|_| CandidateError::new("CODEX-ATTACHMENT-SOURCE-CHANGED", true))?;
        if public_relative_path(relative)? != record.snapshot.relative_path
            || validated_file_name(&record.snapshot.canonical_path)? != record.snapshot.name
        {
            return Err(CandidateError::new("CODEX-ATTACHMENT-SOURCE-CHANGED", true));
        }
        let source = source_root.open_relative(relative)?;
        let destination = directory.join(format!("{index:02}.snapshot"));
        let (fingerprint, kind) = copy_source_to_snapshot(source, &destination)?;
        if fingerprint != record.snapshot.fingerprint || kind != record.snapshot.kind {
            return Err(CandidateError::new("CODEX-ATTACHMENT-SOURCE-CHANGED", true));
        }
        let path = destination
            .to_str()
            .ok_or_else(|| CandidateError::new("CODEX-ATTACHMENT-PATH-INVALID", false))?
            .to_owned();
        inputs.push(match record.snapshot.kind {
            AttachmentKind::Image => ResolvedAttachment::LocalImage { path },
            AttachmentKind::File => ResolvedAttachment::Mention {
                name: record.snapshot.name.clone(),
                path,
            },
        });
    }
    sync_directory(&directory)?;
    sync_directory(snapshot_root)?;
    Ok(PreparedSnapshotSet {
        directory: pending.commit(),
        inputs,
    })
}

fn copy_source_to_snapshot(
    mut source: File,
    destination: &Path,
) -> Result<(SourceFingerprint, AttachmentKind), CandidateError> {
    let source_before = source
        .metadata()
        .map_err(|_| CandidateError::new("CODEX-ATTACHMENT-METADATA", true))?;
    validate_regular_file(&source_before)?;
    if source_before.len() > MAX_ATTACHMENT_BYTES {
        return Err(CandidateError::new(
            "CODEX-ATTACHMENT-FILE-SIZE-LIMIT",
            true,
        ));
    }
    let mut options = OpenOptions::new();
    options.read(true).write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut snapshot = options
        .open(destination)
        .map_err(|_| CandidateError::new("CODEX-ATTACHMENT-SNAPSHOT-CREATE", true))?;
    #[cfg(unix)]
    snapshot
        .set_permissions(fs::Permissions::from_mode(0o600))
        .map_err(|_| CandidateError::new("CODEX-ATTACHMENT-SNAPSHOT-PERMISSIONS", true))?;

    let mut source_hasher = Sha256::new();
    let mut prefix = Vec::with_capacity(12);
    let mut bytes = 0_u64;
    let mut buffer = [0_u8; SNAPSHOT_BUFFER_BYTES];
    loop {
        let read = source
            .read(&mut buffer)
            .map_err(|_| CandidateError::new("CODEX-ATTACHMENT-READ", true))?;
        if read == 0 {
            break;
        }
        bytes = bytes
            .checked_add(read as u64)
            .ok_or_else(|| CandidateError::new("CODEX-ATTACHMENT-FILE-SIZE-LIMIT", true))?;
        if bytes > MAX_ATTACHMENT_BYTES {
            return Err(CandidateError::new(
                "CODEX-ATTACHMENT-FILE-SIZE-LIMIT",
                true,
            ));
        }
        let prefix_bytes = read.min(12_usize.saturating_sub(prefix.len()));
        prefix.extend_from_slice(&buffer[..prefix_bytes]);
        source_hasher.update(&buffer[..read]);
        snapshot
            .write_all(&buffer[..read])
            .map_err(|_| CandidateError::new("CODEX-ATTACHMENT-SNAPSHOT-WRITE", true))?;
    }
    snapshot
        .flush()
        .map_err(|_| CandidateError::new("CODEX-ATTACHMENT-SNAPSHOT-WRITE", true))?;
    snapshot
        .sync_all()
        .map_err(|_| CandidateError::new("CODEX-ATTACHMENT-SNAPSHOT-SYNC", true))?;

    let source_after = source
        .metadata()
        .map_err(|_| CandidateError::new("CODEX-ATTACHMENT-METADATA", true))?;
    validate_regular_file(&source_after)?;
    if bytes != source_before.len()
        || metadata_source_identity(&source_before) != metadata_source_identity(&source_after)
    {
        return Err(CandidateError::new("CODEX-ATTACHMENT-SOURCE-CHANGED", true));
    }
    let source_hash = hex::encode(source_hasher.finalize());
    let mut source_fingerprint = metadata_source_identity(&source_after);
    source_fingerprint.sha256.clone_from(&source_hash);

    let snapshot_before = snapshot
        .metadata()
        .map_err(|_| CandidateError::new("CODEX-ATTACHMENT-SNAPSHOT-METADATA", true))?;
    validate_private_snapshot(&snapshot_before, bytes)?;
    snapshot
        .seek(SeekFrom::Start(0))
        .map_err(|_| CandidateError::new("CODEX-ATTACHMENT-SNAPSHOT-READ", true))?;
    let mut snapshot_hasher = Sha256::new();
    let mut snapshot_bytes = 0_u64;
    loop {
        let read = snapshot
            .read(&mut buffer)
            .map_err(|_| CandidateError::new("CODEX-ATTACHMENT-SNAPSHOT-READ", true))?;
        if read == 0 {
            break;
        }
        snapshot_bytes = snapshot_bytes
            .checked_add(read as u64)
            .ok_or_else(|| CandidateError::new("CODEX-ATTACHMENT-SNAPSHOT-READ", true))?;
        snapshot_hasher.update(&buffer[..read]);
    }
    let snapshot_after = snapshot
        .metadata()
        .map_err(|_| CandidateError::new("CODEX-ATTACHMENT-SNAPSHOT-METADATA", true))?;
    validate_private_snapshot(&snapshot_after, bytes)?;
    if metadata_source_identity(&snapshot_before) != metadata_source_identity(&snapshot_after)
        || snapshot_bytes != bytes
        || hex::encode(snapshot_hasher.finalize()) != source_hash
    {
        return Err(CandidateError::new(
            "CODEX-ATTACHMENT-SNAPSHOT-CHANGED",
            true,
        ));
    }

    let kind = if is_supported_raster_image(&prefix) {
        AttachmentKind::Image
    } else {
        AttachmentKind::File
    };
    Ok((source_fingerprint, kind))
}

fn validate_private_snapshot(metadata: &fs::Metadata, bytes: u64) -> Result<(), CandidateError> {
    if !metadata.is_file() || metadata.len() != bytes {
        return Err(CandidateError::new(
            "CODEX-ATTACHMENT-SNAPSHOT-CHANGED",
            true,
        ));
    }
    #[cfg(unix)]
    if metadata.permissions().mode() & 0o777 != 0o600
        || metadata.nlink() != 1
        || metadata.uid() != unsafe { libc::geteuid() }
    {
        return Err(CandidateError::new(
            "CODEX-ATTACHMENT-SNAPSHOT-PERMISSIONS",
            true,
        ));
    }
    Ok(())
}

fn prepare_snapshot_root(app_data_directory: &Path) -> Result<PathBuf, CandidateError> {
    let codex_directory = app_data_directory.join("codex");
    fs::create_dir_all(&codex_directory)
        .map_err(|_| CandidateError::new("CODEX-ATTACHMENT-SNAPSHOT-ROOT", false))?;
    let codex_metadata = fs::symlink_metadata(&codex_directory)
        .map_err(|_| CandidateError::new("CODEX-ATTACHMENT-SNAPSHOT-ROOT", false))?;
    if codex_metadata.file_type().is_symlink() || !codex_metadata.is_dir() {
        return Err(CandidateError::new("CODEX-ATTACHMENT-SNAPSHOT-ROOT", false));
    }
    #[cfg(unix)]
    fs::set_permissions(&codex_directory, fs::Permissions::from_mode(0o700))
        .map_err(|_| CandidateError::new("CODEX-ATTACHMENT-SNAPSHOT-PERMISSIONS", false))?;
    let root = codex_directory.join(SNAPSHOT_DIRECTORY_NAME);
    if root.exists() {
        let metadata = fs::symlink_metadata(&root)
            .map_err(|_| CandidateError::new("CODEX-ATTACHMENT-SNAPSHOT-ROOT", false))?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(CandidateError::new("CODEX-ATTACHMENT-SNAPSHOT-ROOT", false));
        }
    } else {
        fs::create_dir(&root)
            .map_err(|_| CandidateError::new("CODEX-ATTACHMENT-SNAPSHOT-ROOT", false))?;
    }
    #[cfg(unix)]
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700))
        .map_err(|_| CandidateError::new("CODEX-ATTACHMENT-SNAPSHOT-PERMISSIONS", false))?;
    #[cfg(unix)]
    if fs::metadata(&root)
        .map_err(|_| CandidateError::new("CODEX-ATTACHMENT-SNAPSHOT-ROOT", false))?
        .uid()
        != unsafe { libc::geteuid() }
    {
        return Err(CandidateError::new(
            "CODEX-ATTACHMENT-SNAPSHOT-PERMISSIONS",
            false,
        ));
    }
    for entry in fs::read_dir(&root)
        .map_err(|_| CandidateError::new("CODEX-ATTACHMENT-SNAPSHOT-ROOT", false))?
    {
        let entry =
            entry.map_err(|_| CandidateError::new("CODEX-ATTACHMENT-SNAPSHOT-ROOT", false))?;
        remove_snapshot_entry(&entry.path())?;
    }
    sync_directory(&root)?;
    sync_directory(&codex_directory)?;
    Ok(root)
}

fn create_snapshot_directory(root: &Path) -> Result<PathBuf, CandidateError> {
    let metadata = fs::symlink_metadata(root)
        .map_err(|_| CandidateError::new("CODEX-ATTACHMENT-SNAPSHOT-ROOT", false))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(CandidateError::new("CODEX-ATTACHMENT-SNAPSHOT-ROOT", false));
    }
    #[cfg(unix)]
    if metadata.permissions().mode() & 0o777 != 0o700
        || metadata.uid() != unsafe { libc::geteuid() }
    {
        return Err(CandidateError::new(
            "CODEX-ATTACHMENT-SNAPSHOT-PERMISSIONS",
            false,
        ));
    }
    let directory = root.join(format!("lease-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&directory)
        .map_err(|_| CandidateError::new("CODEX-ATTACHMENT-SNAPSHOT-CREATE", true))?;
    #[cfg(unix)]
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))
        .map_err(|_| CandidateError::new("CODEX-ATTACHMENT-SNAPSHOT-PERMISSIONS", true))?;
    sync_directory(root)?;
    Ok(directory)
}

fn remove_snapshot_entry(path: &Path) -> Result<(), CandidateError> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|_| CandidateError::new("CODEX-ATTACHMENT-SNAPSHOT-CLEANUP", true))?;
    if metadata.is_dir() && !metadata.file_type().is_symlink() {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    }
    .map_err(|_| CandidateError::new("CODEX-ATTACHMENT-SNAPSHOT-CLEANUP", true))
}

fn remove_snapshot_directory(root: &Path, directory: &Path) -> Result<(), CandidateError> {
    if directory.parent() != Some(root) || directory.file_name().is_none() {
        return Err(CandidateError::new(
            "CODEX-ATTACHMENT-SNAPSHOT-CLEANUP",
            false,
        ));
    }
    if directory.exists() {
        remove_snapshot_entry(directory)?;
        sync_directory(root)?;
    }
    Ok(())
}

fn sync_directory(path: &Path) -> Result<(), CandidateError> {
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| CandidateError::new("CODEX-ATTACHMENT-SNAPSHOT-SYNC", true))
}

fn schedule_snapshot_expiry(
    lease: &AttachmentSnapshotLease,
    expires_at: SystemTime,
    now: SystemTime,
) {
    let delay = expires_at.duration_since(now).unwrap_or_default();
    let lease = Arc::downgrade(&lease.0);
    tokio::spawn(async move {
        tokio::time::sleep(delay).await;
        if let Some(lease) = lease.upgrade() {
            lease.cleanup();
        }
    });
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

    struct TestRoot {
        workspace: PathBuf,
        app_data: PathBuf,
    }

    impl TestRoot {
        fn new() -> Self {
            let path = std::env::temp_dir()
                .join(format!("coding-wife-attachments-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&path).expect("attachment root");
            let app_data = std::env::temp_dir().join(format!(
                "coding-wife-attachment-private-{}",
                uuid::Uuid::new_v4()
            ));
            Self {
                workspace: fs::canonicalize(path).expect("canonical root"),
                app_data,
            }
        }

        fn file(&self, relative: &str, contents: &[u8]) -> PathBuf {
            let path = self.workspace.join(relative);
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
            let metadata = fs::symlink_metadata(&self.workspace).expect("root metadata");
            let (root_device, root_inode) = metadata_identity(&metadata);
            AttachmentWorkspaceContext {
                workspace_id: "workspace-attachment-fixture".to_owned(),
                generation: 7,
                canonical_root: self.workspace.clone(),
                root_device,
                root_inode,
            }
        }
    }

    impl Drop for TestRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.workspace);
            let _ = fs::remove_dir_all(&self.app_data);
        }
    }

    fn service(root: &TestRoot, picker: Vec<PathBuf>, clock: Arc<TestClock>) -> AttachmentService {
        AttachmentService::new(Arc::new(FixedPicker(picker)), clock, &root.app_data)
            .expect("attachment service")
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
        let service = service(&root, vec![png, executable], clock);
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
        assert!(!public.contains(&root.workspace.to_string_lossy().to_string()));
        assert!(!public.contains(&root.app_data.to_string_lossy().to_string()));

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
            ResolvedAttachment::LocalImage { path }
                if Path::new(path).starts_with(service.snapshot_root.as_ref())
                    && !path.ends_with("images/demo.png")
        ));
        assert!(matches!(
            &resolved.inputs[1],
            ResolvedAttachment::Mention { name, path }
                if name == "notes.txt"
                    && Path::new(path).starts_with(service.snapshot_root.as_ref())
                    && !path.ends_with("notes.txt")
        ));
        assert!(matches!(
            &resolved.inputs[2],
            ResolvedAttachment::LocalImage { path }
                if Path::new(path).starts_with(service.snapshot_root.as_ref())
                    && !path.ends_with("images/demo.webp")
        ));
    }

    #[tokio::test]
    async fn rejects_each_unsafe_candidate_without_dropping_the_valid_file() {
        let root = TestRoot::new();
        let valid = root.file("valid.txt", b"valid");
        let directory = root.workspace.join("directory");
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
            let path = root.workspace.join("symlink.txt");
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
        let service = service(&root, vec![], clock);
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
        let count_service = service(&root, vec![], clock.clone());
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
        let total_service = service(&root, vec![], clock);
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
        let service = service(&root, vec![], clock.clone());
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
    async fn private_snapshot_is_exact_owner_only_and_removed_on_expiry() {
        let root = TestRoot::new();
        let contents = b"validated attachment bytes";
        let source = root.file("nested/source.txt", contents);
        let clock = Arc::new(TestClock::new());
        let service = service(&root, vec![], clock.clone());
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
            .resolve_for_turn(context, &handles)
            .await
            .expect("resolve private snapshot");
        let ResolvedAttachment::Mention { path, .. } = &resolved.inputs[0] else {
            panic!("text attachment must be a mention")
        };
        let snapshot = PathBuf::from(path);
        let staging = snapshot.parent().expect("snapshot staging directory");
        assert_eq!(fs::read(&snapshot).expect("snapshot bytes"), contents);
        assert!(!snapshot.starts_with(&root.workspace));
        assert!(!format!("{resolved:?}").contains(path));
        assert!(!format!("{:?}", resolved.inputs[0]).contains(path));
        #[cfg(unix)]
        {
            assert_eq!(
                fs::metadata(service.snapshot_root.as_ref())
                    .expect("snapshot root metadata")
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
            assert_eq!(
                fs::metadata(staging)
                    .expect("staging metadata")
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
            assert_eq!(
                fs::metadata(&snapshot)
                    .expect("snapshot metadata")
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }

        fs::write(&source, b"replacement bytes").expect("replace source after snapshot");
        assert_eq!(
            fs::read(&snapshot).expect("stable snapshot bytes"),
            contents
        );
        clock.advance(ATTACHMENT_TTL + Duration::from_secs(1));
        service.cleanup_expired_snapshots();
        assert!(!snapshot.exists());
        assert!(!staging.exists());
    }

    #[tokio::test]
    async fn failed_snapshot_set_removes_every_partial_private_copy() {
        let root = TestRoot::new();
        let first = root.file("first.txt", b"first");
        let second = root.file("second.txt", b"second");
        let clock = Arc::new(TestClock::new());
        let service = service(&root, vec![], clock);
        let context = root.context();
        let registered = service
            .register_paths(
                context.clone(),
                AttachmentSource::Drop,
                vec![
                    first.to_string_lossy().into_owned(),
                    second.to_string_lossy().into_owned(),
                ],
                vec![],
            )
            .await
            .expect("register sources");
        fs::write(&second, b"changed").expect("change second source");
        let error = service
            .resolve_for_turn(
                context,
                &registered
                    .items
                    .iter()
                    .map(|item| item.handle.clone())
                    .collect::<Vec<_>>(),
            )
            .await
            .expect_err("changed source must reject the entire snapshot set");
        assert_eq!(error.code, "CODEX-ATTACHMENT-SOURCE-CHANGED");
        assert_eq!(
            fs::read_dir(service.snapshot_root.as_ref())
                .expect("snapshot root")
                .count(),
            0
        );
    }

    #[test]
    fn startup_cleanup_removes_stale_entries_without_following_symlinks() {
        let root = TestRoot::new();
        let snapshot_root = root.app_data.join("codex").join(SNAPSHOT_DIRECTORY_NAME);
        let stale = snapshot_root.join("lease-stale");
        fs::create_dir_all(&stale).expect("stale staging directory");
        fs::write(stale.join("00.snapshot"), b"stale").expect("stale snapshot");
        #[cfg(unix)]
        let external = {
            let external = std::env::temp_dir().join(format!(
                "coding-wife-attachment-external-{}",
                uuid::Uuid::new_v4()
            ));
            fs::create_dir(&external).expect("external directory");
            fs::write(external.join("keep"), b"keep").expect("external file");
            symlink(&external, snapshot_root.join("lease-link")).expect("stale symlink");
            external
        };

        let service = service(&root, vec![], Arc::new(TestClock::new()));
        assert_eq!(
            fs::read_dir(service.snapshot_root.as_ref())
                .expect("clean snapshot root")
                .count(),
            0
        );
        #[cfg(unix)]
        {
            assert_eq!(
                fs::read(external.join("keep")).expect("external bytes"),
                b"keep"
            );
            let _ = fs::remove_dir_all(external);
        }
    }

    #[tokio::test]
    async fn consume_invalidates_only_after_an_explicit_acceptance_boundary() {
        let root = TestRoot::new();
        let source = root.file("source.txt", b"source");
        let clock = Arc::new(TestClock::new());
        let service = service(&root, vec![], clock);
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
