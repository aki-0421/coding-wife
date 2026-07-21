use std::collections::BTreeMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::process::Command;
use std::sync::Arc;

use tokio::sync::Mutex;

use crate::codex::main_work_unit::{
    MainCommandCompleted, MainCommandStarted, MainCommitProofIntent, MainCommitSource,
    MainWorkUnitRuntime, MainWorkUnitStart, MainWorkUnitTerminal, MainWorkUnitTerminalState,
};
use crate::codex::presence::VerifiedCommitPresenceSink;
use crate::codex::types::MainSkillInjectionAudit;

use super::history::MemoryGitReviewHistory;
use super::main_work_unit_runtime::{GitReviewMainWorkUnitRuntime, VerifiedCommitExplanationSink};
use super::runner::GitRunner;
use super::service::{GitReviewService, GitWorkspaceResolver};
use super::trusted::TrustedCommitCandidateInput;
use super::types::{
    CommitEvidenceDetailRequest, CommitEvidenceFilter, CommitSkillInjectionAudit,
    GitObservationReason, KnownRisk, ListCommitEvidenceRequest, ObserveGitRepositoryRequest,
    ObserveTerminalWorkUnitRequest, PrepareCommitExplanationEvidenceRequest, ReadCommitDiffRequest,
    RiskLevel, SkillInjectionMode, SkillPathAuthority, VerificationEvidence, VerificationResult,
    WorkUnitTerminalState, GIT_REVIEW_SCHEMA_VERSION,
};
use super::GitReviewError;

#[derive(Default)]
struct RecordingExplanationSink {
    locale: Option<String>,
    evidence: Mutex<Vec<super::types::CommitEvidenceV1>>,
}

impl RecordingExplanationSink {
    fn active(locale: &str) -> Self {
        Self {
            locale: Some(locale.to_owned()),
            evidence: Mutex::new(Vec::new()),
        }
    }
}

impl VerifiedCommitExplanationSink for RecordingExplanationSink {
    fn locale_for_scope<'a>(
        &'a self,
        _workspace_id: &'a str,
        _workspace_generation: u64,
    ) -> Pin<Box<dyn Future<Output = Option<String>> + Send + 'a>> {
        Box::pin(async move { self.locale.clone() })
    }

    fn enqueue_verified_commit<'a>(
        &'a self,
        _workspace_id: String,
        _workspace_generation: u64,
        _commit_evidence_id: String,
        evidence: super::types::CommitEvidenceV1,
    ) -> Pin<Box<dyn Future<Output = Result<(), ()>> + Send + 'a>> {
        Box::pin(async move {
            self.evidence.lock().await.push(evidence);
            Ok(())
        })
    }
}

#[derive(Default)]
struct RecordingPresenceSink {
    verified: Mutex<Vec<(String, u64, String)>>,
}

impl VerifiedCommitPresenceSink for RecordingPresenceSink {
    fn verified_commit<'a>(
        &'a self,
        workspace_id: String,
        workspace_generation: u64,
        source_event_id: String,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + 'a>> {
        Box::pin(async move {
            self.verified
                .lock()
                .await
                .push((workspace_id, workspace_generation, source_event_id));
        })
    }
}

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
    let candidate = service
        .begin_trusted_commit_candidate(candidate_input("item-terminal"))
        .await
        .expect("trusted candidate");
    fixture.git(&[
        "commit",
        "-m",
        "feat: add read-only evidence",
        "-m",
        "- record the observer intent",
    ]);
    let head_before_read = fixture.git_text(&["rev-parse", "HEAD"]);
    let status_before_read = fixture.git_text(&["status", "--porcelain=v2"]);
    let proof = service
        .complete_trusted_commit_candidate(
            candidate,
            1,
            "thread-fixture",
            "turn-fixture",
            "item-terminal",
        )
        .await
        .expect("trusted completion")
        .expect("changed HEAD proof");

    let terminal = service
        .observe_trusted_terminal_work_unit(terminal_request(&before.observation_id), vec![proof])
        .await
        .expect("terminal observation")
        .response;
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
async fn production_work_unit_runtime_enqueues_only_the_exact_verified_commit() {
    let fixture = RepositoryFixture::new("work-unit-runtime-auto");
    let history = Arc::new(MemoryGitReviewHistory::new());
    let service = service(&fixture.root, history.clone());
    let sink = Arc::new(RecordingExplanationSink::active("ja"));
    let presence = Arc::new(RecordingPresenceSink::default());
    let runtime = GitReviewMainWorkUnitRuntime::with_all_dependencies(
        service,
        sink.clone(),
        presence.clone(),
    );
    let lease = runtime
        .begin(runtime_start())
        .await
        .expect("work unit lease");

    std::fs::write(fixture.root.join("auto.txt"), "trusted auto explanation\n")
        .expect("write auto fixture");
    fixture.git(&["add", "auto.txt"]);
    runtime
        .command_started(
            lease.clone(),
            MainCommandStarted {
                workspace_generation: 1,
                raw_thread_id: "thread-fixture".to_owned(),
                raw_turn_id: "turn-fixture".to_owned(),
                item_id: "item-runtime-auto".to_owned(),
                source: MainCommitSource::CommandExecution,
            },
        )
        .await;
    fixture.git(&["commit", "-q", "-m", "feat: wire trusted explanation"]);
    let committed_sha = fixture.git_text(&["rev-parse", "HEAD"]);
    runtime
        .command_completed(
            lease.clone(),
            MainCommandCompleted {
                workspace_generation: 1,
                raw_thread_id: "thread-fixture".to_owned(),
                raw_turn_id: "turn-fixture".to_owned(),
                item_id: "item-runtime-auto".to_owned(),
                source: MainCommitSource::CommandExecution,
                proof_intent: Some(MainCommitProofIntent::ObserveCurrentHead),
            },
        )
        .await;
    runtime
        .terminal(
            lease.clone(),
            MainWorkUnitTerminal {
                workspace_generation: 1,
                raw_thread_id: "thread-fixture".to_owned(),
                raw_turn_id: "turn-fixture".to_owned(),
                state: MainWorkUnitTerminalState::Completed,
            },
        )
        .await;

    let evidence = sink.evidence.lock().await;
    assert_eq!(evidence.len(), 1);
    assert_eq!(evidence[0].commit_id, format!("commit-{committed_sha}"));
    assert_eq!(evidence[0].locale, "ja");
    assert_eq!(evidence[0].selection_version, 1);
    assert_eq!(history.commit_count(), 1);
    drop(evidence);
    let verified_presence = presence.verified.lock().await;
    assert_eq!(verified_presence.len(), 1);
    assert_eq!(verified_presence[0].0, "workspace-fixture");
    assert_eq!(verified_presence[0].1, 1);
    assert_eq!(verified_presence[0].2, format!("commit-{committed_sha}"));
    drop(verified_presence);

    runtime
        .terminal(
            lease,
            MainWorkUnitTerminal {
                workspace_generation: 1,
                raw_thread_id: "thread-fixture".to_owned(),
                raw_turn_id: "turn-fixture".to_owned(),
                state: MainWorkUnitTerminalState::Completed,
            },
        )
        .await;
    assert_eq!(sink.evidence.lock().await.len(), 1);
    assert_eq!(presence.verified.lock().await.len(), 1);

    let failed = runtime
        .begin(runtime_start())
        .await
        .expect("failed work unit lease");
    std::fs::write(fixture.root.join("failed.txt"), "commit before failure\n")
        .expect("write failed fixture");
    fixture.git(&["add", "failed.txt"]);
    runtime
        .command_started(
            failed.clone(),
            MainCommandStarted {
                workspace_generation: 1,
                raw_thread_id: "thread-fixture".to_owned(),
                raw_turn_id: "turn-failed".to_owned(),
                item_id: "item-runtime-failed".to_owned(),
                source: MainCommitSource::CommandExecution,
            },
        )
        .await;
    fixture.git(&["commit", "-q", "-m", "test: commit before failed terminal"]);
    runtime
        .command_completed(
            failed.clone(),
            MainCommandCompleted {
                workspace_generation: 1,
                raw_thread_id: "thread-fixture".to_owned(),
                raw_turn_id: "turn-failed".to_owned(),
                item_id: "item-runtime-failed".to_owned(),
                source: MainCommitSource::CommandExecution,
                proof_intent: Some(MainCommitProofIntent::ObserveCurrentHead),
            },
        )
        .await;
    runtime
        .terminal(
            failed,
            MainWorkUnitTerminal {
                workspace_generation: 1,
                raw_thread_id: "thread-fixture".to_owned(),
                raw_turn_id: "turn-failed".to_owned(),
                state: MainWorkUnitTerminalState::Failed,
            },
        )
        .await;
    assert_eq!(presence.verified.lock().await.len(), 1);
}

#[tokio::test]
async fn production_work_unit_runtime_accepts_exact_node_repl_commit_metadata() {
    let fixture = RepositoryFixture::new("work-unit-runtime-node-repl");
    let history = Arc::new(MemoryGitReviewHistory::new());
    let service = service(&fixture.root, history.clone());
    let sink = Arc::new(RecordingExplanationSink::active("ja"));
    let runtime = GitReviewMainWorkUnitRuntime::with_dependencies(service, sink.clone());
    let lease = runtime
        .begin(runtime_start())
        .await
        .expect("work unit lease");
    let before_head = fixture.git_text(&["rev-parse", "HEAD"]);

    runtime
        .command_started(
            lease.clone(),
            MainCommandStarted {
                workspace_generation: 1,
                raw_thread_id: "thread-fixture".to_owned(),
                raw_turn_id: "turn-fixture".to_owned(),
                item_id: "item-node-repl".to_owned(),
                source: MainCommitSource::NodeReplJs,
            },
        )
        .await;
    std::fs::write(fixture.root.join("node-repl.txt"), "typed MCP proof\n")
        .expect("write node repl fixture");
    fixture.git(&["add", "node-repl.txt"]);
    fixture.git(&["commit", "-q", "-m", "feat: record node repl proof"]);
    let commit_sha = fixture.git_text(&["rev-parse", "HEAD"]);
    runtime
        .command_completed(
            lease.clone(),
            MainCommandCompleted {
                workspace_generation: 1,
                raw_thread_id: "thread-fixture".to_owned(),
                raw_turn_id: "turn-fixture".to_owned(),
                item_id: "item-node-repl".to_owned(),
                source: MainCommitSource::NodeReplJs,
                proof_intent: Some(MainCommitProofIntent::Exact {
                    before_head,
                    commit_sha: commit_sha.clone(),
                }),
            },
        )
        .await;
    runtime
        .terminal(
            lease,
            MainWorkUnitTerminal {
                workspace_generation: 1,
                raw_thread_id: "thread-fixture".to_owned(),
                raw_turn_id: "turn-fixture".to_owned(),
                state: MainWorkUnitTerminalState::Completed,
            },
        )
        .await;

    let evidence = sink.evidence.lock().await;
    assert_eq!(evidence.len(), 1);
    assert_eq!(evidence[0].commit_id, format!("commit-{commit_sha}"));
    assert_eq!(history.commit_count(), 1);
}

#[tokio::test]
async fn production_work_unit_runtime_rejects_missing_mismatched_and_cross_source_proofs() {
    for case in ["missing", "wrong_before", "wrong_sha", "cross_source"] {
        let fixture = RepositoryFixture::new(case);
        let history = Arc::new(MemoryGitReviewHistory::new());
        let service = service(&fixture.root, history.clone());
        let sink = Arc::new(RecordingExplanationSink::active("en"));
        let runtime = GitReviewMainWorkUnitRuntime::with_dependencies(service, sink.clone());
        let lease = runtime
            .begin(runtime_start())
            .await
            .expect("work unit lease");
        let before_head = fixture.git_text(&["rev-parse", "HEAD"]);
        runtime
            .command_started(
                lease.clone(),
                MainCommandStarted {
                    workspace_generation: 1,
                    raw_thread_id: "thread-fixture".to_owned(),
                    raw_turn_id: "turn-fixture".to_owned(),
                    item_id: format!("item-{case}"),
                    source: MainCommitSource::NodeReplJs,
                },
            )
            .await;
        std::fs::write(fixture.root.join("untrusted.txt"), format!("{case}\n"))
            .expect("write untrusted fixture");
        fixture.git(&["add", "untrusted.txt"]);
        fixture.git(&["commit", "-q", "-m", "chore: untrusted fixture"]);
        let commit_sha = fixture.git_text(&["rev-parse", "HEAD"]);
        let (source, proof_intent) = match case {
            "missing" => (MainCommitSource::NodeReplJs, None),
            "wrong_before" => (
                MainCommitSource::NodeReplJs,
                Some(MainCommitProofIntent::Exact {
                    before_head: "a".repeat(40),
                    commit_sha,
                }),
            ),
            "wrong_sha" => (
                MainCommitSource::NodeReplJs,
                Some(MainCommitProofIntent::Exact {
                    before_head,
                    commit_sha: "b".repeat(40),
                }),
            ),
            "cross_source" => (
                MainCommitSource::CommandExecution,
                Some(MainCommitProofIntent::ObserveCurrentHead),
            ),
            _ => unreachable!(),
        };
        runtime
            .command_completed(
                lease.clone(),
                MainCommandCompleted {
                    workspace_generation: 1,
                    raw_thread_id: "thread-fixture".to_owned(),
                    raw_turn_id: "turn-fixture".to_owned(),
                    item_id: format!("item-{case}"),
                    source,
                    proof_intent,
                },
            )
            .await;
        runtime
            .terminal(
                lease,
                MainWorkUnitTerminal {
                    workspace_generation: 1,
                    raw_thread_id: "thread-fixture".to_owned(),
                    raw_turn_id: "turn-fixture".to_owned(),
                    state: MainWorkUnitTerminalState::Completed,
                },
            )
            .await;

        assert!(sink.evidence.lock().await.is_empty(), "accepted {case}");
        assert_eq!(history.commit_count(), 0, "persisted {case}");
    }
}

#[tokio::test]
async fn production_work_unit_runtime_drops_no_change_failure_and_invalidated_generation() {
    let fixture = RepositoryFixture::new("work-unit-runtime-negative");
    let history = Arc::new(MemoryGitReviewHistory::new());
    let service = service(&fixture.root, history.clone());
    let sink = Arc::new(RecordingExplanationSink::active("en"));
    let runtime = GitReviewMainWorkUnitRuntime::with_dependencies(service, sink.clone());
    let unchanged = runtime
        .begin(runtime_start())
        .await
        .expect("unchanged lease");
    runtime
        .command_started(
            unchanged.clone(),
            MainCommandStarted {
                workspace_generation: 1,
                raw_thread_id: "thread-fixture".to_owned(),
                raw_turn_id: "turn-unchanged".to_owned(),
                item_id: "item-unchanged".to_owned(),
                source: MainCommitSource::CommandExecution,
            },
        )
        .await;
    runtime
        .command_completed(
            unchanged.clone(),
            MainCommandCompleted {
                workspace_generation: 1,
                raw_thread_id: "thread-fixture".to_owned(),
                raw_turn_id: "turn-unchanged".to_owned(),
                item_id: "item-unchanged".to_owned(),
                source: MainCommitSource::CommandExecution,
                proof_intent: Some(MainCommitProofIntent::ObserveCurrentHead),
            },
        )
        .await;
    runtime
        .terminal(
            unchanged,
            MainWorkUnitTerminal {
                workspace_generation: 1,
                raw_thread_id: "thread-fixture".to_owned(),
                raw_turn_id: "turn-unchanged".to_owned(),
                state: MainWorkUnitTerminalState::Completed,
            },
        )
        .await;

    let invalidated = runtime
        .begin(runtime_start())
        .await
        .expect("invalidated lease");
    runtime.invalidate_generation(1).await;
    runtime
        .command_completed(
            invalidated.clone(),
            MainCommandCompleted {
                workspace_generation: 1,
                raw_thread_id: "thread-fixture".to_owned(),
                raw_turn_id: "turn-invalidated".to_owned(),
                item_id: "item-invalidated".to_owned(),
                source: MainCommitSource::CommandExecution,
                proof_intent: None,
            },
        )
        .await;
    runtime
        .terminal(
            invalidated,
            MainWorkUnitTerminal {
                workspace_generation: 1,
                raw_thread_id: "thread-fixture".to_owned(),
                raw_turn_id: "turn-invalidated".to_owned(),
                state: MainWorkUnitTerminalState::Failed,
            },
        )
        .await;
    assert!(sink.evidence.lock().await.is_empty());
    assert_eq!(history.commit_count(), 0);
}

#[tokio::test]
async fn public_terminal_without_native_proof_never_claims_main_codex_producer() {
    let fixture = RepositoryFixture::new("observer-unproven");
    let history = Arc::new(MemoryGitReviewHistory::new());
    let service = service(&fixture.root, history.clone());
    let before = service
        .observe_repository(start_request("observe-unproven"))
        .await
        .expect("before observation");
    std::fs::write(fixture.root.join("unproven.txt"), "external\n")
        .expect("write external fixture");
    fixture.git(&["add", "unproven.txt"]);
    fixture.git(&["commit", "-q", "-m", "chore: external commit"]);

    let terminal = service
        .observe_terminal_work_unit(terminal_request(&before.observation_id))
        .await
        .expect("public terminal");

    assert_eq!(terminal.new_commits.len(), 1);
    assert_eq!(
        terminal.new_commits[0].producer,
        super::types::CommitProducer::ExternalUncorrelated
    );
    assert!(terminal.work_unit.new_commit_evidence_ids.is_empty());
    assert_eq!(history.commit_count(), 0);
}

#[tokio::test]
async fn trusted_terminal_correlates_only_the_exact_proof_sha() {
    let fixture = RepositoryFixture::new("observer-exact-proof");
    let history = Arc::new(MemoryGitReviewHistory::new());
    let service = service(&fixture.root, history.clone());
    let before = service
        .observe_repository(start_request("observe-exact-proof"))
        .await
        .expect("before observation");

    std::fs::write(fixture.root.join("main.txt"), "main\n").expect("write main fixture");
    fixture.git(&["add", "main.txt"]);
    let candidate = service
        .begin_trusted_commit_candidate(candidate_input("item-exact"))
        .await
        .expect("trusted candidate");
    fixture.git(&["commit", "-q", "-m", "feat: main exact commit"]);
    let main_sha = fixture.git_text(&["rev-parse", "HEAD"]);
    let proof = service
        .complete_trusted_commit_candidate(
            candidate,
            1,
            "thread-fixture",
            "turn-fixture",
            "item-exact",
        )
        .await
        .expect("trusted completion")
        .expect("changed HEAD proof");

    std::fs::write(fixture.root.join("external.txt"), "external\n")
        .expect("write external fixture");
    fixture.git(&["add", "external.txt"]);
    fixture.git(&["commit", "-q", "-m", "chore: unrelated external commit"]);
    let external_sha = fixture.git_text(&["rev-parse", "HEAD"]);

    let terminal = service
        .observe_trusted_terminal_work_unit(terminal_request(&before.observation_id), vec![proof])
        .await
        .expect("trusted terminal");

    assert_eq!(terminal.verified_commits.len(), 1);
    assert_eq!(terminal.verified_commits[0].commit_sha, main_sha);
    let producers = terminal
        .response
        .new_commits
        .iter()
        .map(|commit| (commit.commit_sha.as_str(), commit.producer))
        .collect::<BTreeMap<_, _>>();
    assert_eq!(
        producers.get(main_sha.as_str()),
        Some(&super::types::CommitProducer::MainCodex)
    );
    assert_eq!(
        producers.get(external_sha.as_str()),
        Some(&super::types::CommitProducer::ExternalUncorrelated)
    );
    assert_eq!(history.commit_count(), 1);
}

#[tokio::test]
async fn unchanged_head_and_wrong_completion_context_produce_no_proof() {
    let fixture = RepositoryFixture::new("observer-proof-negative");
    let service = service(&fixture.root, Arc::new(MemoryGitReviewHistory::new()));
    let unchanged = service
        .begin_trusted_commit_candidate(candidate_input("item-unchanged"))
        .await
        .expect("unchanged candidate");
    assert!(service
        .complete_trusted_commit_candidate(
            unchanged,
            1,
            "thread-fixture",
            "turn-fixture",
            "item-unchanged",
        )
        .await
        .expect("unchanged completion")
        .is_none());

    let wrong = service
        .begin_trusted_commit_candidate(candidate_input("item-wrong"))
        .await
        .expect("wrong-context candidate");
    let error = service
        .complete_trusted_commit_candidate(wrong, 1, "thread-fixture", "turn-other", "item-wrong")
        .await
        .expect_err("wrong context must fail closed");
    assert_eq!(error.code, "GIT-COMMIT-PROOF-CONTEXT");
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
    let candidate = first
        .begin_trusted_commit_candidate(candidate_input("item-replay"))
        .await
        .expect("trusted candidate");
    fixture.git(&["commit", "-m", "fix: make replay exact"]);
    let proof = first
        .complete_trusted_commit_candidate(
            candidate,
            1,
            "thread-fixture",
            "turn-fixture",
            "item-replay",
        )
        .await
        .expect("trusted completion")
        .expect("changed HEAD proof");
    let request = terminal_request(&before.observation_id);
    let expected = first
        .observe_trusted_terminal_work_unit(request.clone(), vec![proof])
        .await
        .expect("first terminal")
        .response;

    let restarted = service(&fixture.root, history.clone());
    let replay = restarted
        .observe_terminal_work_unit(request)
        .await
        .expect("replayed terminal");
    assert_eq!(replay.new_commits, expected.new_commits);
    assert_eq!(history.commit_count(), 1);
}

#[tokio::test]
async fn filtered_page_scans_past_fifty_non_matching_commits() {
    let fixture = RepositoryFixture::new("observer-filter-page");
    let initial_sha = fixture.git_text(&["rev-parse", "HEAD"]);
    let history = Arc::new(MemoryGitReviewHistory::new());
    let service = service(&fixture.root, history);
    let before = service
        .observe_repository(start_request("observe-filter-page"))
        .await
        .expect("before observation");

    let mut proofs = Vec::new();
    for index in 0..50 {
        std::fs::write(
            fixture.root.join("series.txt"),
            format!("verified change {index}\n"),
        )
        .expect("write filtered fixture");
        fixture.git(&["add", "series.txt"]);
        let item_id = format!("item-filter-{index}");
        let candidate = service
            .begin_trusted_commit_candidate(candidate_input(&item_id))
            .await
            .expect("trusted candidate");
        fixture.git(&[
            "commit",
            "-q",
            "-m",
            &format!("feat: verified filtered commit {index}"),
        ]);
        proofs.push(
            service
                .complete_trusted_commit_candidate(
                    candidate,
                    1,
                    "thread-fixture",
                    "turn-fixture",
                    &item_id,
                )
                .await
                .expect("trusted completion")
                .expect("changed HEAD proof"),
        );
    }
    service
        .observe_trusted_terminal_work_unit(terminal_request(&before.observation_id), proofs)
        .await
        .expect("terminal observation");

    let page = service
        .list_commit_evidence(ListCommitEvidenceRequest {
            schema_version: GIT_REVIEW_SCHEMA_VERSION,
            workspace_id: "workspace-fixture".to_owned(),
            workspace_generation: 1,
            cursor: None,
            limit: 50,
            filter: CommitEvidenceFilter::NeedsAttention,
            work_unit_id: None,
        })
        .await
        .expect("filtered page");

    assert_eq!(page.items.len(), 1);
    assert_eq!(page.items[0].commit_sha, initial_sha);
    assert_eq!(page.next_cursor, None);
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

#[tokio::test]
async fn explanation_evidence_fails_closed_for_paths_and_credentials() {
    let fixture = RepositoryFixture::new("observer-private-explanation");
    std::fs::write(fixture.root.join("private.txt"), "private fixture\n")
        .expect("write private fixture");
    fixture.git(&["add", "private.txt"]);
    fixture.git(&[
        "commit",
        "-q",
        "-m",
        "fix src/private.ts with ghp_abcdefghijklmnopqrstuvwxyz123456",
    ]);
    let service = service(&fixture.root, Arc::new(MemoryGitReviewHistory::new()));
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
    let error = service
        .prepare_explanation_evidence(PrepareCommitExplanationEvidenceRequest {
            schema_version: 1,
            workspace_id: "workspace-fixture".to_owned(),
            workspace_generation: 1,
            commit_evidence_id: page.items[0].commit_evidence_id.clone(),
            locale: "en".to_owned(),
            selection_version: 1,
        })
        .await
        .expect_err("private evidence must fail closed");

    assert_eq!(error.code, "GIT-EXPLANATION-PRIVATE-MATERIAL");
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

fn runtime_start() -> MainWorkUnitStart {
    MainWorkUnitStart {
        workspace_id: "workspace-fixture".to_owned(),
        workspace_generation: 1,
        raw_thread_id: "thread-fixture".to_owned(),
        client_message_id: "message-fixture".to_owned(),
        skill_injection: MainSkillInjectionAudit {
            name: "coding-wife-commit-work".to_owned(),
            version: "1.0.0".to_owned(),
            content_digest: format!("sha256:{}", "a".repeat(64)),
        },
    }
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

fn candidate_input(item_id: &str) -> TrustedCommitCandidateInput {
    TrustedCommitCandidateInput {
        workspace_id: "workspace-fixture".to_owned(),
        workspace_generation: 1,
        work_unit_id: "work-unit-fixture".to_owned(),
        raw_thread_id: "thread-fixture".to_owned(),
        raw_turn_id: "turn-fixture".to_owned(),
        item_id: item_id.to_owned(),
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
