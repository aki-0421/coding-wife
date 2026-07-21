//! Native-only composition between main Codex work units, trusted Git proof,
//! and the isolated commit explanation controller.

use std::collections::{BTreeSet, HashMap};
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use tokio::sync::Mutex;

use crate::codex::commit_explanation::CommitExplanationTrustedEnqueuer;
use crate::codex::main_work_unit::{
    MainCommandCompleted, MainCommandStarted, MainCommitProofIntent, MainCommitSource,
    MainWorkUnitFuture, MainWorkUnitLease, MainWorkUnitRuntime, MainWorkUnitStart,
    MainWorkUnitTerminal, MainWorkUnitTerminalState,
};

use super::service::GitReviewService;
use super::trusted::{TrustedCommitCandidate, TrustedCommitCandidateInput, TrustedCommitProof};
use super::types::{
    CommitEvidenceV1, CommitSkillInjectionAudit, GitObservationReason, ObserveGitRepositoryRequest,
    ObserveTerminalWorkUnitRequest, PrepareCommitExplanationEvidenceRequest, SkillInjectionMode,
    SkillPathAuthority, WorkUnitTerminalState, GIT_REVIEW_SCHEMA_VERSION,
};

type ExplanationSinkFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

pub(crate) trait VerifiedCommitExplanationSink: Send + Sync {
    fn locale_for_scope<'a>(
        &'a self,
        workspace_id: &'a str,
        workspace_generation: u64,
    ) -> ExplanationSinkFuture<'a, Option<String>>;

    fn enqueue_verified_commit<'a>(
        &'a self,
        workspace_id: String,
        workspace_generation: u64,
        commit_evidence_id: String,
        evidence: CommitEvidenceV1,
    ) -> ExplanationSinkFuture<'a, Result<(), ()>>;
}

impl VerifiedCommitExplanationSink for CommitExplanationTrustedEnqueuer {
    fn locale_for_scope<'a>(
        &'a self,
        workspace_id: &'a str,
        workspace_generation: u64,
    ) -> ExplanationSinkFuture<'a, Option<String>> {
        Box::pin(async move {
            self.locale_for_scope(workspace_id, workspace_generation)
                .await
        })
    }

    fn enqueue_verified_commit<'a>(
        &'a self,
        workspace_id: String,
        workspace_generation: u64,
        commit_evidence_id: String,
        evidence: CommitEvidenceV1,
    ) -> ExplanationSinkFuture<'a, Result<(), ()>> {
        Box::pin(async move {
            self.enqueue_verified_commit(
                workspace_id,
                workspace_generation,
                commit_evidence_id,
                evidence,
            )
            .await
            .map(|_| ())
            .map_err(|_| ())
        })
    }
}

struct WorkUnitContext {
    start: MainWorkUnitStart,
    work_unit_id: String,
    before_observation_id: String,
    injected_at: String,
    candidates: HashMap<String, PendingCommitCandidate>,
    proofs: Vec<TrustedCommitProof>,
}

struct PendingCommitCandidate {
    source: MainCommitSource,
    candidate: TrustedCommitCandidate,
}

#[derive(Default)]
struct RuntimeData {
    contexts: HashMap<String, WorkUnitContext>,
    invalidated_generations: BTreeSet<u64>,
}

pub(crate) struct GitReviewMainWorkUnitRuntime {
    git_review: GitReviewService,
    explanation: Arc<dyn VerifiedCommitExplanationSink>,
    data: Mutex<RuntimeData>,
}

impl GitReviewMainWorkUnitRuntime {
    pub(crate) fn production(
        git_review: GitReviewService,
        explanation: CommitExplanationTrustedEnqueuer,
    ) -> Self {
        Self::with_dependencies(git_review, Arc::new(explanation))
    }

    pub(crate) fn with_dependencies(
        git_review: GitReviewService,
        explanation: Arc<dyn VerifiedCommitExplanationSink>,
    ) -> Self {
        Self {
            git_review,
            explanation,
            data: Mutex::new(RuntimeData::default()),
        }
    }

    async fn begin_work_unit(&self, start: MainWorkUnitStart) -> Option<MainWorkUnitLease> {
        let suffix = uuid::Uuid::new_v4();
        let lease = MainWorkUnitLease::new(format!("main-work-unit-{suffix}"))?;
        let work_unit_id = format!("work-unit-{suffix}");
        let before = self
            .git_review
            .observe_repository(ObserveGitRepositoryRequest {
                schema_version: GIT_REVIEW_SCHEMA_VERSION,
                client_request_id: format!("work-start-{suffix}"),
                workspace_id: start.workspace_id.clone(),
                workspace_generation: start.workspace_generation,
                reason: GitObservationReason::WorkUnitStarted,
                work_unit_id: Some(work_unit_id.clone()),
                source_event_id: None,
            })
            .await
            .ok()?;
        let mut data = self.data.lock().await;
        if data
            .invalidated_generations
            .contains(&start.workspace_generation)
        {
            return None;
        }
        data.contexts.insert(
            lease.token().to_owned(),
            WorkUnitContext {
                start,
                work_unit_id,
                before_observation_id: before.observation_id,
                injected_at: chrono::Utc::now().to_rfc3339(),
                candidates: HashMap::new(),
                proofs: Vec::new(),
            },
        );
        Some(lease)
    }

    async fn record_command_started(&self, lease: MainWorkUnitLease, event: MainCommandStarted) {
        let input = {
            let data = self.data.lock().await;
            let Some(context) = data.contexts.get(lease.token()) else {
                return;
            };
            if context.start.workspace_generation != event.workspace_generation
                || context.start.raw_thread_id != event.raw_thread_id
                || context.candidates.contains_key(&event.item_id)
            {
                return;
            }
            TrustedCommitCandidateInput {
                workspace_id: context.start.workspace_id.clone(),
                workspace_generation: context.start.workspace_generation,
                work_unit_id: context.work_unit_id.clone(),
                raw_thread_id: event.raw_thread_id.clone(),
                raw_turn_id: event.raw_turn_id.clone(),
                item_id: event.item_id.clone(),
            }
        };
        let Ok(candidate) = self.git_review.begin_trusted_commit_candidate(input).await else {
            return;
        };
        let mut data = self.data.lock().await;
        let Some(context) = data.contexts.get_mut(lease.token()) else {
            return;
        };
        if context.start.workspace_generation == event.workspace_generation
            && context.start.raw_thread_id == event.raw_thread_id
        {
            context
                .candidates
                .entry(event.item_id)
                .or_insert(PendingCommitCandidate {
                    source: event.source,
                    candidate,
                });
        }
    }

    async fn record_command_completed(
        &self,
        lease: MainWorkUnitLease,
        event: MainCommandCompleted,
    ) {
        let candidate = {
            let mut data = self.data.lock().await;
            let Some(context) = data.contexts.get_mut(lease.token()) else {
                return;
            };
            if context.start.workspace_generation != event.workspace_generation
                || context.start.raw_thread_id != event.raw_thread_id
            {
                return;
            }
            context.candidates.remove(&event.item_id)
        };
        let Some(candidate) = candidate.filter(|candidate| candidate.source == event.source) else {
            return;
        };
        let Some(intent) = event.proof_intent else {
            return;
        };
        let proof = match intent {
            MainCommitProofIntent::ObserveCurrentHead => {
                self.git_review
                    .complete_trusted_commit_candidate(
                        candidate.candidate,
                        event.workspace_generation,
                        &event.raw_thread_id,
                        &event.raw_turn_id,
                        &event.item_id,
                    )
                    .await
            }
            MainCommitProofIntent::Exact {
                before_head,
                commit_sha,
            } => {
                self.git_review
                    .complete_trusted_commit_candidate_exact(
                        candidate.candidate,
                        event.workspace_generation,
                        &event.raw_thread_id,
                        &event.raw_turn_id,
                        &event.item_id,
                        &before_head,
                        &commit_sha,
                    )
                    .await
            }
        };
        let Ok(Some(proof)) = proof else {
            return;
        };
        if let Some(context) = self.data.lock().await.contexts.get_mut(lease.token()) {
            context.proofs.push(proof);
        }
    }

    async fn finish_work_unit(&self, lease: MainWorkUnitLease, event: MainWorkUnitTerminal) {
        let context = self.data.lock().await.contexts.remove(lease.token());
        let Some(context) = context else {
            return;
        };
        if context.start.workspace_generation != event.workspace_generation
            || context.start.raw_thread_id != event.raw_thread_id
        {
            return;
        }
        let source_event_id = format!("terminal-{}", lease.token());
        let result = self
            .git_review
            .observe_trusted_terminal_work_unit(
                ObserveTerminalWorkUnitRequest {
                    schema_version: GIT_REVIEW_SCHEMA_VERSION,
                    client_request_id: source_event_id.clone(),
                    workspace_id: context.start.workspace_id.clone(),
                    workspace_generation: context.start.workspace_generation,
                    before_observation_id: context.before_observation_id,
                    work_unit_id: context.work_unit_id.clone(),
                    source_event_id,
                    terminal_state: terminal_state(event.state),
                    objective: "Complete the active workspace request".to_owned(),
                    acceptance: Vec::new(),
                    verification: Vec::new(),
                    decisions: Vec::new(),
                    failed_attempts: Vec::new(),
                    risks: Vec::new(),
                    commit_skill_injection: CommitSkillInjectionAudit {
                        schema_version: GIT_REVIEW_SCHEMA_VERSION,
                        skill_id: context.start.skill_injection.name,
                        skill_version: context.start.skill_injection.version,
                        content_digest: context.start.skill_injection.content_digest,
                        path_authority: SkillPathAuthority::AppBundle,
                        injection_mode: SkillInjectionMode::SkillInput,
                        workspace_generation: context.start.workspace_generation,
                        work_unit_id: context.work_unit_id,
                        client_request_id: context.start.client_message_id,
                        injected_at: context.injected_at,
                    },
                    reported_commit_block_reason: None,
                },
                context.proofs,
            )
            .await;
        let Ok(result) = result else {
            return;
        };
        let _ = result.response;
        let Some(locale) = self
            .explanation
            .locale_for_scope(
                &context.start.workspace_id,
                context.start.workspace_generation,
            )
            .await
        else {
            return;
        };
        for verified in result.verified_commits {
            let evidence = self
                .git_review
                .prepare_explanation_evidence(PrepareCommitExplanationEvidenceRequest {
                    schema_version: GIT_REVIEW_SCHEMA_VERSION,
                    workspace_id: context.start.workspace_id.clone(),
                    workspace_generation: context.start.workspace_generation,
                    commit_evidence_id: verified.commit_evidence_id.clone(),
                    locale: locale.clone(),
                    selection_version: 1,
                })
                .await;
            let Ok(evidence) = evidence else {
                continue;
            };
            if evidence.commit_id != verified.commit_evidence_id {
                continue;
            }
            let _ = self
                .explanation
                .enqueue_verified_commit(
                    context.start.workspace_id.clone(),
                    context.start.workspace_generation,
                    verified.commit_evidence_id,
                    evidence,
                )
                .await;
        }
    }
}

impl MainWorkUnitRuntime for GitReviewMainWorkUnitRuntime {
    fn begin<'a>(
        &'a self,
        start: MainWorkUnitStart,
    ) -> MainWorkUnitFuture<'a, Option<MainWorkUnitLease>> {
        Box::pin(async move { self.begin_work_unit(start).await })
    }

    fn command_started<'a>(
        &'a self,
        lease: MainWorkUnitLease,
        event: MainCommandStarted,
    ) -> MainWorkUnitFuture<'a, ()> {
        Box::pin(async move { self.record_command_started(lease, event).await })
    }

    fn command_completed<'a>(
        &'a self,
        lease: MainWorkUnitLease,
        event: MainCommandCompleted,
    ) -> MainWorkUnitFuture<'a, ()> {
        Box::pin(async move { self.record_command_completed(lease, event).await })
    }

    fn terminal<'a>(
        &'a self,
        lease: MainWorkUnitLease,
        event: MainWorkUnitTerminal,
    ) -> MainWorkUnitFuture<'a, ()> {
        Box::pin(async move { self.finish_work_unit(lease, event).await })
    }

    fn abandon<'a>(&'a self, lease: MainWorkUnitLease) -> MainWorkUnitFuture<'a, ()> {
        Box::pin(async move {
            self.data.lock().await.contexts.remove(lease.token());
        })
    }

    fn invalidate_generation<'a>(&'a self, generation: u64) -> MainWorkUnitFuture<'a, ()> {
        Box::pin(async move {
            let mut data = self.data.lock().await;
            data.invalidated_generations.insert(generation);
            data.contexts
                .retain(|_, context| context.start.workspace_generation != generation);
        })
    }
}

fn terminal_state(state: MainWorkUnitTerminalState) -> WorkUnitTerminalState {
    match state {
        MainWorkUnitTerminalState::Completed => WorkUnitTerminalState::Completed,
        MainWorkUnitTerminalState::Failed => WorkUnitTerminalState::Failed,
        MainWorkUnitTerminalState::Interrupted => WorkUnitTerminalState::Interrupted,
        MainWorkUnitTerminalState::Canceled => WorkUnitTerminalState::Canceled,
    }
}
