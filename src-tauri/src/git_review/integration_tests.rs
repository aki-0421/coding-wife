use std::collections::BTreeSet;
use std::fs;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::process::{Command, Output};
use std::sync::Arc;

use super::checkpoint::{
    prepare_checkpoint, promote_checkpoint_objects, update_checkpoint_reference,
};
use super::error::GitReviewError;
use super::history::MemoryGitReviewHistory;
use super::ownership::evaluate_ownership;
use super::repository::{capture_baseline, content_hash, inspect_repository, FileMaterial};
use super::runner::GitRunner;
use super::service::{GitReviewService, GitWorkspaceResolver};
use super::types::{
    CancelRestoreRequest, ChangeKind, CheckpointOperationState, CheckpointStatus,
    ConfirmRestoreRequest, EvaluateCheckpointRequest, GitBaseline, GitFileEvent,
    InspectGitBaselineRequest, OwnershipClass, PreviewRestoreRequest, RestoreKind,
    RestorePreviewStatus, VerificationEvidence, VerificationResult, GIT_REVIEW_SCHEMA_VERSION,
};
use crate::codex::supervisor::CodexSupervisor;
use crate::codex::workspace::{AppPrivateWorkspaceRecord, WorkspaceService};
use crate::workspace_history::{WorkspaceHistoryService, WorkspaceHistoryStore};

const WORKSPACE_ID: &str = "workspace-git-review-test";

struct DisposableRepository {
    root: PathBuf,
}

impl DisposableRepository {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "coding-wife-git-review-test-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        fs::create_dir(&root).expect("create disposable repository");
        let repository = Self { root };
        repository.git_ok(&["init", "-b", "main"]);
        repository.git_ok(&["config", "user.name", "Git Review Test"]);
        repository.git_ok(&["config", "user.email", "git-review@example.invalid"]);
        repository
    }

    fn path(&self) -> &Path {
        &self.root
    }

    fn write(&self, path: &str, content: &[u8]) {
        let path = self.root.join(path);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create parent directory");
        }
        fs::write(path, content).expect("write fixture");
    }

    fn read(&self, path: &str) -> Vec<u8> {
        fs::read(self.root.join(path)).expect("read fixture")
    }

    fn remove(&self, path: &str) {
        fs::remove_file(self.root.join(path)).expect("remove fixture");
    }

    fn commit_all(&self, message: &str) {
        self.git_ok(&["add", "--all"]);
        self.git_ok(&["commit", "-m", message]);
    }

    fn git(&self, args: &[&str]) -> Output {
        Command::new("/usr/bin/git")
            .arg("-c")
            .arg("core.hooksPath=/dev/null")
            .arg("-c")
            .arg("commit.gpgSign=false")
            .arg("-C")
            .arg(&self.root)
            .args(args)
            .env("LC_ALL", "C")
            .env("GIT_TERMINAL_PROMPT", "0")
            .output()
            .expect("run disposable git command")
    }

    fn git_ok(&self, args: &[&str]) -> Vec<u8> {
        let output = self.git(args);
        assert!(
            output.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        output.stdout
    }

    fn head(&self) -> String {
        String::from_utf8(self.git_ok(&["rev-parse", "HEAD"]))
            .expect("utf8 HEAD")
            .trim()
            .to_owned()
    }

    fn index_bytes(&self) -> Vec<u8> {
        self.git_ok(&["ls-files", "--stage", "-z"])
    }

    fn object_files(&self) -> BTreeSet<String> {
        let root = self.root.join(".git/objects");
        let mut values = BTreeSet::new();
        for directory in fs::read_dir(&root).expect("objects") {
            let directory = directory.expect("object directory");
            let directory_name = directory.file_name().to_string_lossy().into_owned();
            if directory_name.len() != 2 {
                continue;
            }
            for file in fs::read_dir(directory.path()).expect("object shard") {
                let file = file.expect("object file");
                if file.file_type().is_ok_and(|kind| kind.is_file()) {
                    values.insert(format!(
                        "{directory_name}{}",
                        file.file_name().to_string_lossy()
                    ));
                }
            }
        }
        values
    }
}

impl Drop for DisposableRepository {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[derive(Clone)]
struct FixedResolver {
    root: PathBuf,
}

impl GitWorkspaceResolver for FixedResolver {
    fn resolve<'a>(
        &'a self,
        workspace_id: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<PathBuf, GitReviewError>> + Send + 'a>> {
        Box::pin(async move {
            assert_eq!(workspace_id, WORKSPACE_ID);
            Ok(self.root.clone())
        })
    }
}

fn service(
    repository: &DisposableRepository,
) -> (GitReviewService, Arc<MemoryGitReviewHistory>, GitRunner) {
    let runner = GitRunner::production().expect("system git");
    let history = Arc::new(MemoryGitReviewHistory::default());
    let service = GitReviewService::with_dependencies(
        runner.clone(),
        Arc::new(FixedResolver {
            root: fs::canonicalize(repository.path()).expect("canonical repository"),
        }),
        history.clone(),
    );
    (service, history, runner)
}

async fn baseline(service: &GitReviewService) -> GitBaseline {
    service
        .inspect_baseline(InspectGitBaselineRequest {
            workspace_id: WORKSPACE_ID.to_owned(),
        })
        .await
        .expect("capture baseline")
}

fn file_event(
    baseline: &GitBaseline,
    id: &str,
    path: &str,
    operation: ChangeKind,
    before: Option<&[u8]>,
    after: Option<&[u8]>,
) -> GitFileEvent {
    GitFileEvent {
        event_id: id.to_owned(),
        relative_path: path.to_owned(),
        operation,
        before_hash: before.map(content_hash),
        after_hash: after.map(content_hash),
        observed_head_sha: baseline.head_sha.clone(),
        observed_index_fingerprint: baseline.index_fingerprint.clone(),
    }
}

fn request(
    baseline: &GitBaseline,
    current_fingerprint: &str,
    client_request_id: &str,
    events: Vec<GitFileEvent>,
) -> EvaluateCheckpointRequest {
    EvaluateCheckpointRequest {
        schema_version: GIT_REVIEW_SCHEMA_VERSION,
        client_request_id: client_request_id.to_owned(),
        workspace_id: WORKSPACE_ID.to_owned(),
        baseline_id: baseline.baseline_id.clone(),
        work_unit_id: format!("work-{client_request_id}"),
        objective: "Create a reviewable local checkpoint".to_owned(),
        acceptance: vec!["All owned changes are isolated and verified".to_owned()],
        file_events: events,
        verification: vec![VerificationEvidence {
            evidence_id: format!("verification-{client_request_id}"),
            check: "cargo test".to_owned(),
            result: VerificationResult::Passed,
            duration_ms: 10,
            summary: "The disposable repository checks passed".to_owned(),
            observed_repository_fingerprint: current_fingerprint.to_owned(),
        }],
        decisions: Vec::new(),
        failed_attempts: Vec::new(),
        risks: Vec::new(),
        risk_approval: None,
        commit_message: "feat(git): create isolated checkpoint\n\n- include only owned file changes\n- preserve the user index and worktree".to_owned(),
    }
}

#[tokio::test]
async fn checkpoint_create_update_delete_is_reviewable_and_idempotent() {
    let repository = DisposableRepository::new();
    repository.write("app.txt", b"before\n");
    repository.write("obsolete.txt", b"remove me\n");
    repository.commit_all("fixture");
    let (service, history, runner) = service(&repository);
    let baseline = baseline(&service).await;
    let index_before = repository.index_bytes();

    repository.write("app.txt", b"after\n");
    repository.write("created.txt", b"created\n");
    repository.remove("obsolete.txt");
    let current = inspect_repository(&runner, repository.path())
        .await
        .expect("current repository");
    let request = request(
        &baseline,
        &current.repository_fingerprint,
        "request-main",
        vec![
            file_event(
                &baseline,
                "event-update",
                "app.txt",
                ChangeKind::Modified,
                Some(b"before\n"),
                Some(b"after\n"),
            ),
            file_event(
                &baseline,
                "event-create",
                "created.txt",
                ChangeKind::Added,
                None,
                Some(b"created\n"),
            ),
            file_event(
                &baseline,
                "event-delete",
                "obsolete.txt",
                ChangeKind::Deleted,
                Some(b"remove me\n"),
                None,
            ),
        ],
    );
    let evaluation = service
        .evaluate_checkpoint(request.clone())
        .await
        .expect("checkpoint");
    assert_eq!(evaluation.status, CheckpointStatus::ReviewReady);
    assert!(evaluation
        .gates
        .iter()
        .all(|gate| gate.outcome == super::types::GateOutcome::Pass));
    let checkpoint = evaluation.checkpoint.as_ref().expect("checkpoint identity");
    assert_eq!(repository.head(), checkpoint.commit_sha);
    assert_eq!(
        repository.git_ok(&["show", &format!("{}:app.txt", checkpoint.commit_sha)]),
        b"after\n"
    );
    assert_eq!(
        repository.git_ok(&["show", &format!("{}:created.txt", checkpoint.commit_sha)]),
        b"created\n"
    );
    assert!(!repository
        .git(&[
            "cat-file",
            "-e",
            &format!("{}:obsolete.txt", checkpoint.commit_sha)
        ])
        .status
        .success());
    assert_eq!(repository.index_bytes(), index_before);
    assert_eq!(repository.read("app.txt"), b"after\n");
    assert_eq!(history.operations().len(), 4);
    assert!(history
        .operations()
        .iter()
        .any(|event| { event.state == CheckpointOperationState::HistoryComplete }));

    let replay = service
        .evaluate_checkpoint(request.clone())
        .await
        .expect("exact replay");
    assert_eq!(replay, evaluation);
    let mut conflict = request;
    conflict.objective = "A different payload".to_owned();
    assert_eq!(
        service
            .evaluate_checkpoint(conflict)
            .await
            .expect_err("idempotency conflict")
            .code,
        "GIT-REQUEST-IDEMPOTENCY-CONFLICT"
    );
}

#[tokio::test]
async fn pre_existing_changes_are_visible_but_never_committed() {
    let repository = DisposableRepository::new();
    repository.write("app.txt", b"before\n");
    repository.write("user.txt", b"committed user value\n");
    repository.commit_all("fixture");
    repository.write("user.txt", b"private user value\n");
    repository.write("notes.txt", b"untracked private note\n");
    let (service, _, runner) = service(&repository);
    let baseline = baseline(&service).await;
    let index_before = repository.index_bytes();

    repository.write("app.txt", b"after\n");
    let current = inspect_repository(&runner, repository.path())
        .await
        .expect("current repository");
    let evaluation = service
        .evaluate_checkpoint(request(
            &baseline,
            &current.repository_fingerprint,
            "request-protected",
            vec![file_event(
                &baseline,
                "event-app",
                "app.txt",
                ChangeKind::Modified,
                Some(b"before\n"),
                Some(b"after\n"),
            )],
        ))
        .await
        .expect("protected checkpoint");
    assert_eq!(evaluation.status, CheckpointStatus::ReviewReady);
    assert!(evaluation
        .manifest
        .iter()
        .filter(|entry| matches!(entry.relative_path.as_str(), "user.txt" | "notes.txt"))
        .all(|entry| entry.ownership == OwnershipClass::PreExisting));
    let sha = &evaluation.checkpoint.expect("checkpoint").commit_sha;
    assert_eq!(
        repository.git_ok(&["show", &format!("{sha}:user.txt")]),
        b"committed user value\n"
    );
    assert!(!repository
        .git(&["cat-file", "-e", &format!("{sha}:notes.txt")])
        .status
        .success());
    assert_eq!(repository.read("user.txt"), b"private user value\n");
    assert_eq!(repository.read("notes.txt"), b"untracked private note\n");
    assert_eq!(repository.index_bytes(), index_before);
}

#[tokio::test]
async fn same_file_non_overlap_is_synthesized_and_overlap_is_blocked() {
    let repository = DisposableRepository::new();
    repository.write("shared.txt", b"one\ntwo\nthree\n");
    repository.commit_all("fixture");
    repository.write("shared.txt", b"user\ntwo\nthree\n");
    let runner = GitRunner::production().expect("runner");
    let baseline = capture_baseline(&runner, WORKSPACE_ID, repository.path())
        .await
        .expect("baseline");
    repository.write("shared.txt", b"user\ntwo\nai\n");
    let current = inspect_repository(&runner, repository.path())
        .await
        .expect("current");
    let event = file_event(
        &baseline.public,
        "event-non-overlap",
        "shared.txt",
        ChangeKind::Modified,
        Some(b"user\ntwo\nthree\n"),
        Some(b"user\ntwo\nai\n"),
    );
    let ownership = evaluate_ownership(&runner, &baseline, &current, &[event])
        .await
        .expect("ownership");
    assert!(ownership.reason_codes.is_empty());
    assert_eq!(
        ownership.owned_changes[0].material,
        FileMaterial::Regular(b"one\ntwo\nai\n".to_vec())
    );

    let overlap_repository = DisposableRepository::new();
    overlap_repository.write("shared.txt", b"one\ntwo\nthree\n");
    overlap_repository.commit_all("fixture");
    overlap_repository.write("shared.txt", b"one\nuser\nthree\n");
    let overlap_baseline = capture_baseline(&runner, WORKSPACE_ID, overlap_repository.path())
        .await
        .expect("overlap baseline");
    overlap_repository.write("shared.txt", b"one\nai\nthree\n");
    let overlap_current = inspect_repository(&runner, overlap_repository.path())
        .await
        .expect("overlap current");
    let overlap_event = file_event(
        &overlap_baseline.public,
        "event-overlap",
        "shared.txt",
        ChangeKind::Modified,
        Some(b"one\nuser\nthree\n"),
        Some(b"one\nai\nthree\n"),
    );
    let overlap = evaluate_ownership(
        &runner,
        &overlap_baseline,
        &overlap_current,
        &[overlap_event],
    )
    .await
    .expect("overlap classification");
    assert!(overlap
        .reason_codes
        .iter()
        .any(|reason| reason.starts_with("GIT-HUNK-OVERLAP")));
    assert!(overlap.owned_changes.is_empty());
}

#[tokio::test]
async fn temporary_objects_have_no_side_effect_until_promotion_and_orphans_are_reportable() {
    let repository = DisposableRepository::new();
    repository.write("app.txt", b"before\n");
    repository.commit_all("fixture");
    let runner = GitRunner::production().expect("runner");
    let baseline = capture_baseline(&runner, WORKSPACE_ID, repository.path())
        .await
        .expect("baseline");
    let head_before = repository.head();
    let index_before = repository.index_bytes();
    let objects_before = repository.object_files();
    repository.write("app.txt", b"after\n");
    let current = inspect_repository(&runner, repository.path())
        .await
        .expect("current");
    let event = file_event(
        &baseline.public,
        "event-object-boundary",
        "app.txt",
        ChangeKind::Modified,
        Some(b"before\n"),
        Some(b"after\n"),
    );
    let ownership = evaluate_ownership(&runner, &baseline, &current, &[event])
        .await
        .expect("ownership");
    let message = "feat(git): test object boundary\n\n- prepare objects outside the repository\n- promote objects before compare and swap";

    let prepared = prepare_checkpoint(&runner, &baseline, &current, &ownership, message)
        .await
        .expect("prepare");
    let prepared_sha = prepared.identity().commit_sha.clone();
    assert_eq!(repository.object_files(), objects_before);
    assert!(!repository
        .git(&["cat-file", "-e", &format!("{prepared_sha}^{{commit}}")])
        .status
        .success());
    drop(prepared);
    assert_eq!(repository.object_files(), objects_before);
    assert_eq!(repository.head(), head_before);
    assert_eq!(repository.index_bytes(), index_before);

    let prepared = prepare_checkpoint(&runner, &baseline, &current, &ownership, message)
        .await
        .expect("prepare for promotion");
    let promoted = promote_checkpoint_objects(&runner, prepared)
        .await
        .expect("promote");
    let orphan_sha = promoted.identity().commit_sha.clone();
    assert!(!promoted.promoted_object_ids().is_empty());
    assert_eq!(repository.head(), head_before);
    assert_eq!(repository.index_bytes(), index_before);
    assert_eq!(repository.read("app.txt"), b"after\n");
    assert!(repository
        .git(&["cat-file", "-e", &format!("{orphan_sha}^{{commit}}")])
        .status
        .success());
    drop(promoted);
    let unreachable =
        String::from_utf8_lossy(&repository.git_ok(&["fsck", "--unreachable", "--no-reflogs"]))
            .into_owned();
    assert!(unreachable.contains(&format!("unreachable commit {orphan_sha}")));

    let prepared = prepare_checkpoint(&runner, &baseline, &current, &ownership, message)
        .await
        .expect("prepare after orphan");
    let promoted = promote_checkpoint_objects(&runner, prepared)
        .await
        .expect("promote after orphan");
    let committed = update_checkpoint_reference(&runner, promoted)
        .await
        .expect("CAS ref");
    assert_eq!(repository.head(), committed.identity.commit_sha);
    assert_eq!(repository.index_bytes(), index_before);
    assert_eq!(
        committed.index_fingerprint_before,
        committed.index_fingerprint_after
    );
}

#[tokio::test]
async fn restore_requires_preview_and_supports_revert_recovery_cancel_and_replay() {
    let repository = DisposableRepository::new();
    repository.write("app.txt", b"before\n");
    repository.commit_all("fixture");
    let (service, _, runner) = service(&repository);
    let baseline = baseline(&service).await;
    repository.write("app.txt", b"after\n");
    let current = inspect_repository(&runner, repository.path())
        .await
        .expect("current");
    let evaluation = service
        .evaluate_checkpoint(request(
            &baseline,
            &current.repository_fingerprint,
            "request-restore",
            vec![file_event(
                &baseline,
                "event-restore",
                "app.txt",
                ChangeKind::Modified,
                Some(b"before\n"),
                Some(b"after\n"),
            )],
        ))
        .await
        .expect("checkpoint");
    let checkpoint = evaluation.checkpoint.expect("checkpoint");

    let recovery = service
        .preview_restore(PreviewRestoreRequest {
            workspace_id: WORKSPACE_ID.to_owned(),
            checkpoint_id: checkpoint.checkpoint_id.clone(),
            kind: RestoreKind::RecoveryBranch,
            recovery_branch: None,
        })
        .await
        .expect("recovery preview");
    assert_eq!(recovery.status, RestorePreviewStatus::Ready);
    let head_before_recovery = repository.head();
    let recovery_result = service
        .confirm_restore(ConfirmRestoreRequest {
            workspace_id: WORKSPACE_ID.to_owned(),
            confirmation_token: recovery.confirmation_token.expect("token"),
        })
        .await
        .expect("create recovery branch");
    assert_eq!(repository.head(), head_before_recovery);
    let recovery_ref = recovery_result.created_reference.expect("recovery ref");
    assert_eq!(
        String::from_utf8(repository.git_ok(&["rev-parse", &recovery_ref]))
            .expect("recovery SHA")
            .trim(),
        checkpoint.commit_sha
    );

    repository.git_ok(&["reset", "--mixed", "HEAD"]);
    assert!(repository.git_ok(&["status", "--porcelain"]).is_empty());
    let revert = service
        .preview_restore(PreviewRestoreRequest {
            workspace_id: WORKSPACE_ID.to_owned(),
            checkpoint_id: checkpoint.checkpoint_id.clone(),
            kind: RestoreKind::RevertCommit,
            recovery_branch: None,
        })
        .await
        .expect("revert preview");
    assert_eq!(revert.status, RestorePreviewStatus::Ready);
    let token = revert.confirmation_token.expect("revert token");
    let reverted = service
        .confirm_restore(ConfirmRestoreRequest {
            workspace_id: WORKSPACE_ID.to_owned(),
            confirmation_token: token.clone(),
        })
        .await
        .expect("revert");
    assert!(reverted.created_commit_sha.is_some());
    assert_eq!(repository.read("app.txt"), b"before\n");
    assert!(repository.git_ok(&["status", "--porcelain"]).is_empty());
    assert_eq!(
        service
            .confirm_restore(ConfirmRestoreRequest {
                workspace_id: WORKSPACE_ID.to_owned(),
                confirmation_token: token,
            })
            .await
            .expect_err("one-shot replay")
            .code,
        "GIT-RESTORE-TOKEN-INVALID"
    );

    let canceled = service
        .preview_restore(PreviewRestoreRequest {
            workspace_id: WORKSPACE_ID.to_owned(),
            checkpoint_id: checkpoint.checkpoint_id,
            kind: RestoreKind::RecoveryBranch,
            recovery_branch: Some("recovery/canceled".to_owned()),
        })
        .await
        .expect("cancel preview");
    let canceled_token = canceled.confirmation_token.expect("cancel token");
    let head_before_cancel = repository.head();
    let index_before_cancel = repository.index_bytes();
    service
        .cancel_restore(CancelRestoreRequest {
            workspace_id: WORKSPACE_ID.to_owned(),
            confirmation_token: canceled_token,
        })
        .await
        .expect("cancel");
    assert_eq!(repository.head(), head_before_cancel);
    assert_eq!(repository.index_bytes(), index_before_cancel);
    assert!(!repository
        .git(&[
            "show-ref",
            "--verify",
            "--quiet",
            "refs/heads/recovery/canceled"
        ])
        .status
        .success());
}

#[tokio::test]
async fn production_service_follows_the_trusted_workspace_lifecycle() {
    let repository = DisposableRepository::new();
    repository.write("app.txt", b"fixture\n");
    repository.commit_all("fixture");
    let data = std::env::temp_dir().join(format!(
        "coding-wife-git-review-history-{}",
        uuid::Uuid::new_v4()
    ));
    let workspace = WorkspaceService::production(CodexSupervisor::new());
    let candidate = workspace
        .validate_private_candidate(&AppPrivateWorkspaceRecord {
            workspace_id: WORKSPACE_ID.to_owned(),
            alias: "Git review fixture".to_owned(),
            canonical_root: repository.path().to_path_buf(),
        })
        .await
        .expect("validated workspace");
    let store = WorkspaceHistoryStore::open(&data).expect("history store");
    store
        .register_candidate(&candidate)
        .expect("persist workspace");
    workspace
        .activate_candidate(candidate)
        .await
        .expect("activate workspace");
    let history = WorkspaceHistoryService::new(store, workspace.clone());
    let service = GitReviewService::production(workspace.clone(), history)
        .expect("production Git review service");

    let inspected = baseline(&service).await;
    assert_eq!(inspected.workspace_id, WORKSPACE_ID);
    workspace
        .deactivate_workspace(WORKSPACE_ID)
        .await
        .expect("deactivate workspace");
    assert_eq!(
        service
            .inspect_baseline(InspectGitBaselineRequest {
                workspace_id: WORKSPACE_ID.to_owned(),
            })
            .await
            .expect_err("deactivated workspace must be rejected")
            .code,
        "GIT-WORKSPACE-NOT-TRUSTED"
    );
    let _ = fs::remove_dir_all(data);
}
