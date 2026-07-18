//! Baseline/current/file-event ownership evaluation.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use super::error::{git_error, GitReviewError};
#[cfg(test)]
use super::repository::content_hash;
use super::repository::{
    file_id, head_material, read_worktree_material, same_repository_identity, validate_opaque_id,
    validate_relative_path, worktree_mode, BaselineRecord, FileMaterial, RepositorySnapshot,
};
use super::runner::{stdout_text, GitRunner, GitRunnerError};
use super::types::{
    ChangeKind, DiffSummary, GitFileEvent, ManifestEntry, OwnershipClass, MAX_CHANGED_BYTES,
    MAX_CHANGED_FILES, MAX_CHANGED_LINES,
};

const OPERATION: &str = "evaluate_git_ownership";

#[derive(Debug)]
pub(crate) struct PrivateMaterialDirectory {
    root: PathBuf,
    next_file: usize,
}

impl PrivateMaterialDirectory {
    pub fn new(label: &str) -> Result<Self, GitReviewError> {
        let root = std::env::temp_dir().join(format!(
            "coding-wife-{label}-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        fs::create_dir(&root).map_err(|_| git_error("GIT-TEMP-CREATE", OPERATION, true))?;
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700))
            .map_err(|_| git_error("GIT-TEMP-PERMISSION", OPERATION, false))?;
        Ok(Self { root, next_file: 0 })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn write(&mut self, bytes: &[u8]) -> Result<PathBuf, GitReviewError> {
        self.next_file = self.next_file.saturating_add(1);
        let path = self.root.join(format!("material-{}", self.next_file));
        fs::write(&path, bytes).map_err(|_| git_error("GIT-TEMP-WRITE", OPERATION, true))?;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600))
            .map_err(|_| git_error("GIT-TEMP-PERMISSION", OPERATION, false))?;
        Ok(path)
    }

    pub fn create_directory(&self, name: &str) -> Result<PathBuf, GitReviewError> {
        if name.is_empty()
            || !name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        {
            return Err(git_error("GIT-TEMP-NAME", OPERATION, false));
        }
        let path = self.root.join(name);
        fs::create_dir(&path).map_err(|_| git_error("GIT-TEMP-CREATE", OPERATION, true))?;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700))
            .map_err(|_| git_error("GIT-TEMP-PERMISSION", OPERATION, false))?;
        Ok(path)
    }
}

impl Drop for PrivateMaterialDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[derive(Clone, Debug)]
pub(crate) struct OwnedChange {
    pub relative_path: String,
    pub material: FileMaterial,
    pub mode: Option<String>,
}

#[derive(Clone, Debug)]
pub(crate) struct OwnershipEvaluation {
    pub manifest: Vec<ManifestEntry>,
    pub owned_changes: Vec<OwnedChange>,
    pub diff_summary: DiffSummary,
    pub reason_codes: Vec<String>,
}

pub(crate) async fn evaluate_ownership(
    runner: &GitRunner,
    baseline: &BaselineRecord,
    current: &RepositorySnapshot,
    events: &[GitFileEvent],
) -> Result<OwnershipEvaluation, GitReviewError> {
    let mut reasons = Vec::new();
    if !same_repository_identity(&baseline.repository, &current.identity) {
        reasons.push("GIT-REPOSITORY-IDENTITY-CHANGED".to_owned());
    }
    if current.identity.head_sha != baseline.public.head_sha
        || current.identity.head_reference != baseline.public.head_reference
    {
        reasons.push("GIT-HEAD-STALE".to_owned());
    }
    if current.index_fingerprint != baseline.public.index_fingerprint {
        reasons.push("GIT-INDEX-STALE".to_owned());
    }
    reasons.extend(current.blocked_reasons.iter().cloned());

    if events.is_empty() {
        reasons.push("GIT-OWNERSHIP-NO-EVENTS".to_owned());
    }
    if events.len() > MAX_CHANGED_FILES.saturating_mul(8) {
        reasons.push("GIT-OWNERSHIP-EVENT-LIMIT".to_owned());
    }
    let mut event_ids = BTreeSet::new();
    let mut by_path: BTreeMap<String, Vec<&GitFileEvent>> = BTreeMap::new();
    for event in events {
        validate_opaque_id(&event.event_id, "GIT-EVENT-ID")?;
        validate_relative_path(&event.relative_path)?;
        validate_optional_content_hash(event.before_hash.as_deref())?;
        validate_optional_content_hash(event.after_hash.as_deref())?;
        if !event_ids.insert(event.event_id.clone()) {
            reasons.push("GIT-EVENT-ID-DUPLICATE".to_owned());
        }
        by_path
            .entry(event.relative_path.clone())
            .or_default()
            .push(event);
    }
    if by_path.len() > MAX_CHANGED_FILES {
        reasons.push("GIT-LIMIT-FILES".to_owned());
    }

    let mut manifest = Vec::new();
    let mut owned_changes = Vec::new();
    let mut summary = DiffSummary {
        files_changed: 0,
        additions: 0,
        deletions: 0,
        binary_files: 0,
        total_bytes: 0,
    };
    let mut materials = PrivateMaterialDirectory::new("ownership")?;

    let mut all_paths = BTreeSet::new();
    all_paths.extend(baseline.pre_existing.keys().cloned());
    all_paths.extend(current.changes.keys().cloned());
    all_paths.extend(by_path.keys().cloned());
    if all_paths.len() > MAX_CHANGED_FILES {
        reasons.push("GIT-LIMIT-FILES".to_owned());
    }

    for path in all_paths.into_iter().take(MAX_CHANGED_FILES + 1) {
        let event_chain = by_path.get(&path);
        if event_chain.is_none() {
            let baseline_entry = baseline.pre_existing.get(&path);
            let current_material =
                read_worktree_material(&current.identity.canonical_root, &path).await?;
            let current_mode = worktree_mode(&current.identity.canonical_root, &path).await?;
            if baseline_entry.is_some_and(|entry| {
                entry.material.content_hash() == current_material.content_hash()
                    && entry.mode == current_mode
            }) {
                let entry = baseline_entry.expect("checked baseline entry");
                let (head, head_mode) = head_material(runner, &baseline.repository, &path).await?;
                manifest.push(ManifestEntry {
                    file_id: file_id(&path),
                    relative_path: path,
                    change_kind: infer_change_kind(
                        &head,
                        &entry.material,
                        head_mode.as_deref(),
                        entry.mode.as_deref(),
                    ),
                    ownership: OwnershipClass::PreExisting,
                    before_hash: head.content_hash(),
                    after_hash: entry.material.content_hash(),
                    additions: 0,
                    deletions: 0,
                    reason_code: Some("GIT-PREEXISTING-PROTECTED".to_owned()),
                });
            } else {
                let baseline_material = baseline_entry
                    .map(|entry| entry.material.clone())
                    .unwrap_or(FileMaterial::Missing);
                let baseline_mode = baseline_entry.and_then(|entry| entry.mode.as_deref());
                reasons.push(format!("GIT-EXTERNAL-CHANGE:{}", file_id(&path)));
                manifest.push(ManifestEntry {
                    file_id: file_id(&path),
                    relative_path: path,
                    change_kind: infer_change_kind(
                        &baseline_material,
                        &current_material,
                        baseline_mode,
                        current_mode.as_deref(),
                    ),
                    ownership: OwnershipClass::External,
                    before_hash: baseline_entry.and_then(|entry| entry.material.content_hash()),
                    after_hash: current_material.content_hash(),
                    additions: 0,
                    deletions: 0,
                    reason_code: Some("GIT-EXTERNAL-CHANGE".to_owned()),
                });
            }
            continue;
        }

        let chain = event_chain.expect("checked event chain");
        let (head, head_mode) = head_material(runner, &baseline.repository, &path).await?;
        let baseline_material = baseline
            .pre_existing
            .get(&path)
            .map(|entry| entry.material.clone())
            .unwrap_or_else(|| head.clone());
        let baseline_mode = baseline
            .pre_existing
            .get(&path)
            .and_then(|entry| entry.mode.clone())
            .or_else(|| head_mode.clone());
        let current_material =
            read_worktree_material(&current.identity.canonical_root, &path).await?;
        let current_mode = worktree_mode(&current.identity.canonical_root, &path).await?;

        let mut path_reasons = validate_event_chain(
            chain,
            &baseline_material,
            &current_material,
            &baseline.public.head_sha,
            &baseline.public.index_fingerprint,
        );
        if baseline_material.is_symlink()
            || current_material.is_symlink()
            || head.is_symlink()
            || matches!(baseline_mode.as_deref(), Some("120000" | "160000"))
            || matches!(current_mode.as_deref(), Some("120000" | "160000"))
        {
            path_reasons.push("GIT-FILE-TYPE-UNSUPPORTED".to_owned());
        }
        if baseline.pre_existing.contains_key(&path) && matches!(head, FileMaterial::Missing) {
            path_reasons.push("GIT-PREEXISTING-UNTRACKED".to_owned());
        }

        let (synthesized, synthesized_mode, overlap) = if path_reasons.is_empty() {
            synthesize_owned_change(
                runner,
                &current.identity.canonical_root,
                &mut materials,
                MaterialVersion {
                    material: &head,
                    mode: head_mode.as_deref(),
                },
                MaterialVersion {
                    material: &baseline_material,
                    mode: baseline_mode.as_deref(),
                },
                MaterialVersion {
                    material: &current_material,
                    mode: current_mode.as_deref(),
                },
            )
            .await?
        } else {
            (current_material.clone(), current_mode.clone(), false)
        };
        if overlap {
            path_reasons.push("GIT-HUNK-OVERLAP".to_owned());
        }
        if synthesized.bytes().is_some_and(is_lfs_pointer)
            || current_material.bytes().is_some_and(is_lfs_pointer)
        {
            path_reasons.push("GIT-LFS-POINTER-UNSUPPORTED".to_owned());
        }

        let (additions, deletions, binary) = diff_counts(
            runner,
            &current.identity.canonical_root,
            &mut materials,
            &baseline_material,
            &current_material,
        )
        .await?;
        summary.files_changed = summary.files_changed.saturating_add(1);
        summary.additions = summary.additions.saturating_add(additions);
        summary.deletions = summary.deletions.saturating_add(deletions);
        summary.total_bytes = summary.total_bytes.saturating_add(synthesized.byte_count());
        if binary {
            summary.binary_files = summary.binary_files.saturating_add(1);
        }

        let change_kind = infer_change_kind(
            &head,
            &synthesized,
            head_mode.as_deref(),
            synthesized_mode.as_deref(),
        );
        let ownership = if path_reasons
            .iter()
            .any(|reason| reason == "GIT-HUNK-OVERLAP")
        {
            OwnershipClass::Overlap
        } else if path_reasons.is_empty() {
            OwnershipClass::Owned
        } else {
            OwnershipClass::Unowned
        };
        let manifest_entry = ManifestEntry {
            file_id: file_id(&path),
            relative_path: path.clone(),
            change_kind,
            ownership,
            before_hash: head.content_hash(),
            after_hash: synthesized.content_hash(),
            additions,
            deletions,
            reason_code: path_reasons.first().cloned().or_else(|| {
                baseline
                    .pre_existing
                    .contains_key(&path)
                    .then(|| "GIT-PREEXISTING-NONOVERLAP-PROTECTED".to_owned())
            }),
        };
        if path_reasons.is_empty() {
            owned_changes.push(OwnedChange {
                relative_path: path,
                material: synthesized,
                mode: synthesized_mode,
            });
        } else {
            reasons.extend(
                path_reasons
                    .into_iter()
                    .map(|reason| format!("{reason}:{}", file_id(&path))),
            );
        }
        manifest.push(manifest_entry);
    }

    if summary.total_bytes > MAX_CHANGED_BYTES {
        reasons.push("GIT-LIMIT-BYTES".to_owned());
    }
    if summary.additions.saturating_add(summary.deletions) > MAX_CHANGED_LINES {
        reasons.push("GIT-LIMIT-LINES".to_owned());
    }
    if owned_changes.is_empty() {
        reasons.push("GIT-OWNERSHIP-EMPTY".to_owned());
    }
    manifest.sort_by(|left, right| {
        left.relative_path
            .cmp(&right.relative_path)
            .then_with(|| ownership_order(left.ownership).cmp(&ownership_order(right.ownership)))
    });
    reasons.sort();
    reasons.dedup();
    Ok(OwnershipEvaluation {
        manifest,
        owned_changes,
        diff_summary: summary,
        reason_codes: reasons,
    })
}

fn validate_event_chain(
    chain: &[&GitFileEvent],
    baseline: &FileMaterial,
    current: &FileMaterial,
    expected_head: &str,
    expected_index: &str,
) -> Vec<String> {
    let mut reasons = Vec::new();
    let mut expected = baseline.content_hash();
    for event in chain {
        if event.observed_head_sha != expected_head {
            reasons.push("GIT-EVENT-HEAD-STALE".to_owned());
        }
        if event.observed_index_fingerprint != expected_index {
            reasons.push("GIT-EVENT-INDEX-STALE".to_owned());
        }
        if event.before_hash != expected {
            reasons.push("GIT-EVENT-CHAIN".to_owned());
        }
        match event.operation {
            ChangeKind::Added if event.before_hash.is_some() || event.after_hash.is_none() => {
                reasons.push("GIT-EVENT-OPERATION".to_owned());
            }
            ChangeKind::Deleted if event.before_hash.is_none() || event.after_hash.is_some() => {
                reasons.push("GIT-EVENT-OPERATION".to_owned());
            }
            ChangeKind::Modified | ChangeKind::TypeChanged
                if event.before_hash.is_none() || event.after_hash.is_none() =>
            {
                reasons.push("GIT-EVENT-OPERATION".to_owned());
            }
            _ => {}
        }
        expected = event.after_hash.clone();
    }
    if expected != current.content_hash() {
        reasons.push("GIT-EVENT-CURRENT-MISMATCH".to_owned());
    }
    reasons.sort();
    reasons.dedup();
    reasons
}

#[derive(Clone, Copy)]
struct MaterialVersion<'a> {
    material: &'a FileMaterial,
    mode: Option<&'a str>,
}

async fn synthesize_owned_change(
    runner: &GitRunner,
    root: &Path,
    materials: &mut PrivateMaterialDirectory,
    head: MaterialVersion<'_>,
    baseline: MaterialVersion<'_>,
    current: MaterialVersion<'_>,
) -> Result<(FileMaterial, Option<String>, bool), GitReviewError> {
    if baseline.material.content_hash() == head.material.content_hash()
        && baseline.mode == head.mode
    {
        return Ok((
            current.material.clone(),
            current.mode.map(str::to_owned),
            false,
        ));
    }
    match (head.material, baseline.material, current.material) {
        (
            FileMaterial::Regular(head_bytes),
            FileMaterial::Regular(base_bytes),
            FileMaterial::Regular(theirs_bytes),
        ) => {
            if is_binary(head_bytes) || is_binary(base_bytes) || is_binary(theirs_bytes) {
                return Ok((
                    current.material.clone(),
                    current.mode.map(str::to_owned),
                    true,
                ));
            }
            let ours_path = materials.write(head_bytes)?;
            let base_path = materials.write(base_bytes)?;
            let theirs_path = materials.write(theirs_bytes)?;
            let output = runner
                .merge_file(root, &ours_path, &base_path, &theirs_path)
                .await
                .map_err(runner_error)?;
            if output.status.success() {
                let mode = if baseline.mode == current.mode {
                    head.mode.map(str::to_owned)
                } else if baseline.mode == head.mode {
                    current.mode.map(str::to_owned)
                } else {
                    return Ok((FileMaterial::Regular(output.stdout), None, true));
                };
                Ok((FileMaterial::Regular(output.stdout), mode, false))
            } else if output.status.code() == Some(1) {
                Ok((
                    current.material.clone(),
                    current.mode.map(str::to_owned),
                    true,
                ))
            } else {
                Err(git_error("GIT-MERGE-FILE", OPERATION, true))
            }
        }
        _ => Ok((
            current.material.clone(),
            current.mode.map(str::to_owned),
            true,
        )),
    }
}

async fn diff_counts(
    runner: &GitRunner,
    root: &Path,
    materials: &mut PrivateMaterialDirectory,
    before: &FileMaterial,
    after: &FileMaterial,
) -> Result<(u64, u64, bool), GitReviewError> {
    let before_bytes = before.bytes().unwrap_or_default();
    let after_bytes = after.bytes().unwrap_or_default();
    let before_path = materials.write(before_bytes)?;
    let after_path = materials.write(after_bytes)?;
    let output = runner
        .diff_no_index_numstat(root, &before_path, &after_path)
        .await
        .map_err(runner_error)?;
    if !output.status.success() && output.status.code() != Some(1) {
        return Err(git_error("GIT-DIFF-COUNT", OPERATION, true));
    }
    if output.stdout.is_empty() {
        return Ok((0, 0, false));
    }
    let text = stdout_text(&output).map_err(runner_error)?;
    let line = text.lines().next().unwrap_or_default();
    let mut fields = line.split('\t');
    let additions = fields.next().unwrap_or_default();
    let deletions = fields.next().unwrap_or_default();
    if additions == "-" || deletions == "-" {
        return Ok((0, 0, true));
    }
    let additions = additions
        .parse::<u64>()
        .map_err(|_| git_error("GIT-DIFF-COUNT", OPERATION, false))?;
    let deletions = deletions
        .parse::<u64>()
        .map_err(|_| git_error("GIT-DIFF-COUNT", OPERATION, false))?;
    Ok((additions, deletions, false))
}

fn infer_change_kind(
    before: &FileMaterial,
    after: &FileMaterial,
    before_mode: Option<&str>,
    after_mode: Option<&str>,
) -> ChangeKind {
    match (before, after) {
        (FileMaterial::Missing, FileMaterial::Regular(_)) => ChangeKind::Added,
        (FileMaterial::Regular(_), FileMaterial::Missing) => ChangeKind::Deleted,
        _ if before_mode != after_mode => ChangeKind::TypeChanged,
        _ => ChangeKind::Modified,
    }
}

fn validate_optional_content_hash(value: Option<&str>) -> Result<(), GitReviewError> {
    if value.is_some_and(|value| {
        value.len() != 71
            || !value.starts_with("sha256:")
            || !value[7..].bytes().all(|byte| byte.is_ascii_hexdigit())
    }) {
        return Err(git_error("GIT-CONTENT-HASH", OPERATION, false));
    }
    Ok(())
}

fn is_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8192).any(|byte| *byte == 0)
}

fn is_lfs_pointer(bytes: &[u8]) -> bool {
    bytes.starts_with(b"version https://git-lfs.github.com/spec/v1\n")
}

fn ownership_order(value: OwnershipClass) -> u8 {
    match value {
        OwnershipClass::Owned => 0,
        OwnershipClass::PreExisting => 1,
        OwnershipClass::External => 2,
        OwnershipClass::Overlap => 3,
        OwnershipClass::Unowned => 4,
    }
}

fn runner_error(error: GitRunnerError) -> GitReviewError {
    match error {
        GitRunnerError::BinaryUnavailable | GitRunnerError::Spawn => {
            git_error("GIT-BINARY-UNAVAILABLE", OPERATION, true)
        }
        GitRunnerError::BinaryIdentityChanged => {
            git_error("GIT-BINARY-IDENTITY-CHANGED", OPERATION, false)
        }
        GitRunnerError::Timeout => git_error("GIT-PROCESS-TIMEOUT", OPERATION, true),
        GitRunnerError::OutputLimit => git_error("GIT-PROCESS-OUTPUT-LIMIT", OPERATION, false),
        GitRunnerError::ProcessTree => git_error("GIT-PROCESS-TREE", OPERATION, false),
        GitRunnerError::Io => git_error("GIT-PROCESS-IO", OPERATION, true),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_event_chain_rejects_unexplained_current_content() {
        let baseline = FileMaterial::Regular(b"before\n".to_vec());
        let current = FileMaterial::Regular(b"external\n".to_vec());
        let event = GitFileEvent {
            event_id: "event-1".to_owned(),
            relative_path: "src/main.rs".to_owned(),
            operation: ChangeKind::Modified,
            before_hash: baseline.content_hash(),
            after_hash: Some(content_hash(b"owned\n")),
            observed_head_sha: "a".repeat(40),
            observed_index_fingerprint: "sha256:index".to_owned(),
        };
        let reasons = validate_event_chain(
            &[&event],
            &baseline,
            &current,
            &"a".repeat(40),
            "sha256:index",
        );
        assert!(reasons.contains(&"GIT-EVENT-CURRENT-MISMATCH".to_owned()));
    }

    #[test]
    fn lfs_pointer_is_detected_without_reading_external_content() {
        assert!(is_lfs_pointer(
            b"version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 1\n"
        ));
    }
}
