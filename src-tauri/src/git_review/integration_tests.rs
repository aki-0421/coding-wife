use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::process::Command;
use std::sync::Arc;

use super::history::MemoryGitReviewHistory;
use super::runner::GitRunner;
use super::service::{GitReviewService, GitWorkspaceResolver};
use super::types::{
    CommitEvidenceDetailRequest, CommitEvidenceFilter, CommitSkillInjectionAudit,
    GitObservationReason, KnownRisk, ListCommitEvidenceRequest, ObserveGitRepositoryRequest,
    ObserveTerminalWorkUnitRequest, PrepareCommitExplanationEvidenceRequest, ReadCommitDiffRequest,
    RiskLevel, SkillInjectionMode, SkillPathAuthority, VerificationEvidence, VerificationResult,
    WorkUnitTerminalState, GIT_REVIEW_SCHEMA_VERSION,
};
use super::GitReviewError;

#[derive(Clone)]
struct FixedResolver {
    root: PathBuf,
}

impl GitWorkspaceResolver for FixedResolver {
    fn resolve<'a>(
        &'a self,
        _workspace_id: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<PathBuf, GitReviewError>> + Send + 'a>> {
        Box::pin(async move { Ok(self.root.clone()) })
    }
}

#[tokio::test]
async fn terminal_observation_detects_main_commit_without_mutating_git_state() {
    let fixture = RepositoryFixture::new("observer-terminal");
    let history = Arc::new(MemoryGitReviewHistory::new());
    let service = service(&fixture.root, history.clone());
    let before = service
        .observe_repository(start_request("observe-start"))
        .await
        .expect("before observation");

    std::fs::write(fixture.root.join("feature.txt"), "read-only evidence\n")
        .expect("write feature");
    fixture.git(&["add", "feature.txt"]);
    fixture.git(&[
        "commit",
        "-m",
        "feat: add read-only evidence",
        "-m",
        "- record the observer intent",
    ]);
    let head_before_read = fixture.git_text(&["rev-parse", "HEAD"]);
    let status_before_read = fixture.git_text(&["status", "--porcelain=v2"]);

    let terminal = service
        .observe_terminal_work_unit(terminal_request(&before.observation_id))
        .await
        .expect("terminal observation");
    assert_eq!(terminal.new_commits.len(), 1);
    assert_eq!(terminal.new_commits[0].commit_sha, head_before_read);
    assert_eq!(history.commit_count(), 1);

    let page = service
        .list_commit_evidence(ListCommitEvidenceRequest {
            schema_version: GIT_REVIEW_SCHEMA_VERSION,
            workspace_id: "workspace-fixture".to_owned(),
            workspace_generation: 1,
            cursor: None,
            limit: 20,
            filter: CommitEvidenceFilter::All,
            work_unit_id: None,
        })
        .await
        .expect("commit list");
    let selected = page
        .items
        .iter()
        .find(|item| item.commit_sha == head_before_read)
        .expect("new commit");
    let detail = service
        .read_commit_evidence(CommitEvidenceDetailRequest {
            schema_version: GIT_REVIEW_SCHEMA_VERSION,
            workspace_id: "workspace-fixture".to_owned(),
            workspace_generation: 1,
            commit_evidence_id: selected.commit_evidence_id.clone(),
        })
        .await
        .expect("commit detail");
    assert_eq!(detail.work_unit_id.as_deref(), Some("work-unit-fixture"));
    assert_eq!(detail.files.len(), 1);
    let diff = service
        .read_commit_diff(ReadCommitDiffRequest {
            schema_version: GIT_REVIEW_SCHEMA_VERSION,
            workspace_id: "workspace-fixture".to_owned(),
            workspace_generation: 1,
            commit_evidence_id: detail.commit_evidence_id.clone(),
            file_evidence_id: detail.files[0].file_evidence_id.clone(),
        })
        .await
        .expect("file diff");
    assert!(diff.content.contains("read-only evidence"));

    assert_eq!(fixture.git_text(&["rev-parse", "HEAD"]), head_before_read);
    assert_eq!(
        fixture.git_text(&["status", "--porcelain=v2"]),
        status_before_read
    );
}

#[tokio::test]
async fn exact_terminal_replay_survives_service_restart_without_duplicate_evidence() {
    let fixture = RepositoryFixture::new("observer-replay");
    let history = Arc::new(MemoryGitReviewHistory::new());
    let first = service(&fixture.root, history.clone());
    let before = first
        .observe_repository(start_request("observe-replay"))
        .await
        .expect("before observation");
    std::fs::write(fixture.root.join("replay.txt"), "same commit\n").expect("write replay");
    fixture.git(&["add", "replay.txt"]);
    fixture.git(&["commit", "-m", "fix: make replay exact"]);
    let request = terminal_request(&before.observation_id);
    let expected = first
        .observe_terminal_work_unit(request.clone())
        .await
        .expect("first terminal");

    let restarted = service(&fixture.root, history.clone());
    let replay = restarted
        .observe_terminal_work_unit(request)
        .await
        .expect("replayed terminal");
    assert_eq!(replay.new_commits, expected.new_commits);
    assert_eq!(history.commit_count(), 1);
}

#[tokio::test]
async fn explanation_evidence_removes_paths_and_raw_diff_content() {
    let fixture = RepositoryFixture::new("observer-explanation");
    let history = Arc::new(MemoryGitReviewHistory::new());
    let service = service(&fixture.root, history);
    let page = service
        .list_commit_evidence(ListCommitEvidenceRequest {
            schema_version: 1,
            workspace_id: "workspace-fixture".to_owned(),
            workspace_generation: 1,
            cursor: None,
            limit: 10,
            filter: CommitEvidenceFilter::All,
            work_unit_id: None,
        })
        .await
        .expect("list");
    let evidence = service
        .prepare_explanation_evidence(PrepareCommitExplanationEvidenceRequest {
            schema_version: 1,
            workspace_id: "workspace-fixture".to_owned(),
            workspace_generation: 1,
            commit_evidence_id: page.items[0].commit_evidence_id.clone(),
            locale: "ja".to_owned(),
            selection_version: 1,
        })
        .await
        .expect("explanation evidence");
    let encoded = serde_json::to_string(&evidence).expect("encode evidence");
    assert!(!encoded.contains("README.md"));
    assert!(!encoded.contains("diff --git"));
    assert_eq!(evidence.locale, "ja");
}

#[test]
fn native_git_runner_and_commands_expose_no_repository_mutation_surface() {
    let runner = include_str!("runner.rs");
    let commands = include_str!("commands.rs")
        .split("#[cfg(test)]")
        .next()
        .expect("production commands");
    for forbidden in [
        "commit-tree",
        "update-ref",
        "write-tree",
        "read-tree",
        "update-index",
        "hash-object",
        "preview_git_restore",
        "confirm_git_restore",
        "evaluate_and_checkpoint_work_unit",
    ] {
        assert!(!runner.contains(forbidden), "runner exposed {forbidden}");
        assert!(!commands.contains(forbidden), "command exposed {forbidden}");
    }
}

fn service(root: &Path, history: Arc<MemoryGitReviewHistory>) -> GitReviewService {
    GitReviewService::with_dependencies(
        GitRunner::production().expect("system Git"),
        Arc::new(FixedResolver {
            root: root.to_path_buf(),
        }),
        history,
    )
}

fn start_request(client_request_id: &str) -> ObserveGitRepositoryRequest {
    ObserveGitRepositoryRequest {
        schema_version: GIT_REVIEW_SCHEMA_VERSION,
        client_request_id: client_request_id.to_owned(),
        workspace_id: "workspace-fixture".to_owned(),
        workspace_generation: 1,
        reason: GitObservationReason::WorkUnitStarted,
        work_unit_id: Some("work-unit-fixture".to_owned()),
        source_event_id: None,
    }
}

fn terminal_request(before_observation_id: &str) -> ObserveTerminalWorkUnitRequest {
    ObserveTerminalWorkUnitRequest {
        schema_version: GIT_REVIEW_SCHEMA_VERSION,
        client_request_id: "terminal-fixture".to_owned(),
        workspace_id: "workspace-fixture".to_owned(),
        workspace_generation: 1,
        before_observation_id: before_observation_id.to_owned(),
        work_unit_id: "work-unit-fixture".to_owned(),
        source_event_id: "terminal-event-fixture".to_owned(),
        terminal_state: WorkUnitTerminalState::Completed,
        objective: "Create reviewable commit evidence".to_owned(),
        acceptance: vec!["The observer never changes Git state".to_owned()],
        verification: vec![VerificationEvidence {
            evidence_id: "verification-fixture".to_owned(),
            source_event_id: "verification-event-fixture".to_owned(),
            check: "cargo test git_review".to_owned(),
            result: VerificationResult::Passed,
            duration_ms: 120,
            summary: "Focused observer tests passed".to_owned(),
        }],
        decisions: Vec::new(),
        failed_attempts: Vec::new(),
        risks: vec![KnownRisk {
            risk_id: "risk-fixture".to_owned(),
            source_event_id: "risk-event-fixture".to_owned(),
            category: "repository integrity".to_owned(),
            level: RiskLevel::Low,
            summary: "Only fixed read commands are available".to_owned(),
            mitigation: "Mutation methods are absent".to_owned(),
            resolved: true,
        }],
        commit_skill_injection: CommitSkillInjectionAudit {
            schema_version: GIT_REVIEW_SCHEMA_VERSION,
            skill_id: "coding-wife-commit-work".to_owned(),
            skill_version: "1.0.0".to_owned(),
            content_digest: "a".repeat(64),
            path_authority: SkillPathAuthority::AppBundle,
            injection_mode: SkillInjectionMode::SkillInput,
            workspace_generation: 1,
            work_unit_id: "work-unit-fixture".to_owned(),
            client_request_id: "turn-fixture".to_owned(),
            injected_at: "2026-07-18T00:00:00Z".to_owned(),
        },
        reported_commit_block_reason: None,
    }
}

struct RepositoryFixture {
    root: PathBuf,
}

impl RepositoryFixture {
    fn new(label: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "coding-wife-git-{label}-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).expect("fixture directory");
        let fixture = Self { root };
        fixture.git(&["init", "-q"]);
        fixture.git(&["config", "user.name", "Sol"]);
        fixture.git(&["config", "user.email", "sol@example.test"]);
        std::fs::write(fixture.root.join("README.md"), "fixture\n").expect("fixture file");
        fixture.git(&["add", "README.md"]);
        fixture.git(&["commit", "-q", "-m", "chore: initialize fixture"]);
        fixture
    }

    fn git(&self, args: &[&str]) {
        let output = Command::new("/usr/bin/git")
            .args(args)
            .current_dir(&self.root)
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("HOME", &self.root)
            .env("LC_ALL", "C")
            .output()
            .expect("run Git fixture command");
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn git_text(&self, args: &[&str]) -> String {
        let output = Command::new("/usr/bin/git")
            .args(args)
            .current_dir(&self.root)
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("HOME", &self.root)
            .env("LC_ALL", "C")
            .output()
            .expect("run Git fixture command");
        assert!(output.status.success(), "git {args:?}");
        String::from_utf8(output.stdout)
            .expect("Git UTF-8")
            .trim()
            .to_owned()
    }
}

impl Drop for RepositoryFixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
