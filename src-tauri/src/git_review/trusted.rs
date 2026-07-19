//! Native-only commit candidate and proof values.
//!
//! These types are intentionally not serializable. Only the read-only Git
//! service can construct a proof, and the WebView cannot supply one.

use std::path::PathBuf;

use super::git_layout::GitRepositoryLayout;

const MAX_PRIVATE_CONTEXT_BYTES: usize = 256;

#[derive(Debug)]
pub(crate) struct TrustedCommitCandidateInput {
    pub workspace_id: String,
    pub workspace_generation: u64,
    pub work_unit_id: String,
    pub raw_thread_id: String,
    pub raw_turn_id: String,
    pub item_id: String,
}

impl TrustedCommitCandidateInput {
    pub(super) fn valid(&self) -> bool {
        self.workspace_generation > 0
            && valid_private_context(&self.raw_thread_id)
            && valid_private_context(&self.raw_turn_id)
            && valid_private_context(&self.item_id)
    }
}

#[derive(Debug)]
pub(crate) struct TrustedCommitCandidate {
    workspace_id: String,
    workspace_generation: u64,
    work_unit_id: String,
    raw_thread_id: String,
    raw_turn_id: String,
    item_id: String,
    nonce: String,
    canonical_root: PathBuf,
    canonical_git_dir: PathBuf,
    canonical_common_dir: PathBuf,
    object_directory: PathBuf,
    head_reference: Option<String>,
    before_sha: String,
}

impl TrustedCommitCandidate {
    pub(super) fn from_layout(
        input: TrustedCommitCandidateInput,
        layout: GitRepositoryLayout,
    ) -> Self {
        Self {
            workspace_id: input.workspace_id,
            workspace_generation: input.workspace_generation,
            work_unit_id: input.work_unit_id,
            raw_thread_id: input.raw_thread_id,
            raw_turn_id: input.raw_turn_id,
            item_id: input.item_id,
            nonce: format!("commit-proof-{}", uuid::Uuid::new_v4()),
            canonical_root: layout.canonical_root,
            canonical_git_dir: layout.canonical_git_dir,
            canonical_common_dir: layout.canonical_common_dir,
            object_directory: layout.object_directory,
            head_reference: layout.head_reference,
            before_sha: layout.head_sha,
        }
    }

    pub(super) fn matches_completion(
        &self,
        workspace_generation: u64,
        raw_thread_id: &str,
        raw_turn_id: &str,
        item_id: &str,
    ) -> bool {
        self.workspace_generation == workspace_generation
            && self.raw_thread_id == raw_thread_id
            && self.raw_turn_id == raw_turn_id
            && self.item_id == item_id
    }

    pub(super) fn same_repository(&self, layout: &GitRepositoryLayout) -> bool {
        self.canonical_root == layout.canonical_root
            && self.canonical_git_dir == layout.canonical_git_dir
            && self.canonical_common_dir == layout.canonical_common_dir
            && self.object_directory == layout.object_directory
            && self.head_reference == layout.head_reference
    }

    pub(super) fn workspace_id(&self) -> &str {
        &self.workspace_id
    }

    pub(super) fn before_sha(&self) -> &str {
        &self.before_sha
    }

    pub(super) fn into_proof(self, expected_sha: String) -> TrustedCommitProof {
        TrustedCommitProof {
            workspace_id: self.workspace_id,
            workspace_generation: self.workspace_generation,
            work_unit_id: self.work_unit_id,
            nonce: self.nonce,
            expected_sha,
        }
    }
}

#[derive(Debug)]
pub(crate) struct TrustedCommitProof {
    workspace_id: String,
    workspace_generation: u64,
    work_unit_id: String,
    nonce: String,
    expected_sha: String,
}

impl TrustedCommitProof {
    pub(super) fn matches_terminal(
        &self,
        workspace_id: &str,
        workspace_generation: u64,
        work_unit_id: &str,
    ) -> bool {
        self.workspace_id == workspace_id
            && self.workspace_generation == workspace_generation
            && self.work_unit_id == work_unit_id
    }

    pub(super) fn nonce(&self) -> &str {
        &self.nonce
    }

    pub(super) fn expected_sha(&self) -> &str {
        &self.expected_sha
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct TrustedVerifiedCommit {
    pub commit_evidence_id: String,
    pub commit_sha: String,
}

fn valid_private_context(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_PRIVATE_CONTEXT_BYTES
        && !value.contains('\0')
        && value.chars().all(|character| !character.is_control())
}
