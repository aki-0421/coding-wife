//! Coordinator for read-only Git observation and commit evidence.

use std::collections::{BTreeMap, BTreeSet};
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;

use sha2::{Digest, Sha256};
use tokio::sync::Mutex;

use crate::codex::workspace::WorkspaceService;
use crate::workspace_history::WorkspaceHistoryService;

use super::error::{git_error, GitReviewError};
use super::evidence::{
    build_commit_evidence, build_explanation_evidence, commit_sha_from_evidence_id,
    list_commit_identities, new_commit_shas, parse_cursor, read_commit_diff, read_commit_identity,
    summarize,
};
use super::git_layout::GitRepositoryLayout;
use super::history::{GitReviewHistory, WorkspaceHistoryGitReviewStore};
use super::repository::{
    capture_observation, observation_id, validate_opaque_id, validate_workspace_id,
};
use super::runner::{GitRunner, GitRunnerError};
use super::trusted::{
    TrustedCommitCandidate, TrustedCommitCandidateInput, TrustedCommitProof, TrustedVerifiedCommit,
};
use super::types::{
    valid_git_text, CommitDiffFile, CommitEvidenceDetail, CommitEvidenceDetailRequest,
    CommitEvidenceFilter, CommitEvidencePage, CommitEvidenceV1, CommitProducer, GitObservation,
    GitObservationReason, ListCommitEvidenceRequest, ObserveGitRepositoryRequest,
    ObserveTerminalWorkUnitRequest, PrepareCommitExplanationEvidenceRequest, ReadCommitDiffRequest,
    SkillInjectionMode, SkillPathAuthority, TerminalWorkUnitObservationResult,
    WorkUnitGitObservation, GIT_REVIEW_SCHEMA_VERSION, MAX_EVIDENCE_ITEMS,
    MAX_GIT_ACCEPTANCE_CHARS, MAX_GIT_ATTEMPT_APPROACH_CHARS, MAX_GIT_ATTEMPT_LEARNING_CHARS,
    MAX_GIT_ATTEMPT_OUTCOME_CHARS, MAX_GIT_BLOCK_REASON_CHARS, MAX_GIT_DECISION_ANSWER_CHARS,
    MAX_GIT_DECISION_RATIONALE_CHARS, MAX_GIT_DECISION_SUMMARY_CHARS, MAX_GIT_OBJECTIVE_CHARS,
    MAX_GIT_RISK_CATEGORY_CHARS, MAX_GIT_RISK_MITIGATION_CHARS, MAX_GIT_RISK_SUMMARY_CHARS,
    MAX_GIT_VERIFICATION_CHECK_CHARS, MAX_GIT_VERIFICATION_SUMMARY_CHARS,
};

const OPERATION_OBSERVE: &str = "observe_git_repository";
const OPERATION_TERMINAL: &str = "observe_terminal_work_unit";
const OPERATION_READ: &str = "read_git_commit_evidence";
const OPERATION_TRUSTED: &str = "observe_trusted_commit";
const MAX_LIST_LIMIT: u32 = 50;
const MAX_FILTER_SCAN_COMMITS: usize = 1_000;
const FILTER_SCAN_BATCH: usize = 50;

type ResolverFuture<'a> =
    Pin<Box<dyn Future<Output = Result<PathBuf, GitReviewError>> + Send + 'a>>;

pub(crate) trait GitWorkspaceResolver: Send + Sync {
    fn resolve<'a>(&'a self, workspace_id: &'a str) -> ResolverFuture<'a>;
}

#[derive(Clone)]
struct RegisteredWorkspaceResolver {
    workspace: WorkspaceService,
}

impl GitWorkspaceResolver for RegisteredWorkspaceResolver {
    fn resolve<'a>(&'a self, workspace_id: &'a str) -> ResolverFuture<'a> {
        Box::pin(async move {
            validate_workspace_id(workspace_id)?;
            self.workspace
                .trusted_identity(workspace_id)
                .await
                .map(|identity| identity.canonical_root)
                .ok_or_else(|| git_error("GIT-WORKSPACE-NOT-TRUSTED", OPERATION_OBSERVE, false))
        })
    }
}

#[derive(Clone)]
struct CachedResponse<T> {
    digest: String,
    response: T,
}

#[derive(Clone)]
struct TerminalProcessingResult {
    response: TerminalWorkUnitObservationResult,
    verified_commits: Vec<TrustedVerifiedCommit>,
}

type RequestKey = (String, String);
type SharedObservationStore = Arc<Mutex<BTreeMap<RequestKey, GitObservation>>>;
type SharedRequestCache<T> = Arc<Mutex<BTreeMap<RequestKey, CachedResponse<T>>>>;

pub(crate) struct TrustedTerminalWorkUnitObservationResult {
    pub response: TerminalWorkUnitObservationResult,
    pub verified_commits: Vec<TrustedVerifiedCommit>,
}

#[derive(Clone)]
pub struct GitReviewService {
    runner: GitRunner,
    resolver: Arc<dyn GitWorkspaceResolver>,
    history: Arc<dyn GitReviewHistory>,
    observations: SharedObservationStore,
    observation_requests: SharedRequestCache<GitObservation>,
    terminal_requests: SharedRequestCache<TerminalProcessingResult>,
    terminal_lock: Arc<Mutex<()>>,
}

impl GitReviewService {
    pub fn production(
        workspace: WorkspaceService,
        history: WorkspaceHistoryService,
    ) -> Result<Self, GitReviewError> {
        let runner = GitRunner::production().map_err(service_runner_error)?;
        Ok(Self::with_dependencies(
            runner,
            Arc::new(RegisteredWorkspaceResolver { workspace }),
            Arc::new(WorkspaceHistoryGitReviewStore::new(history)),
        ))
    }

    pub(crate) fn with_dependencies(
        runner: GitRunner,
        resolver: Arc<dyn GitWorkspaceResolver>,
        history: Arc<dyn GitReviewHistory>,
    ) -> Self {
        Self {
            runner,
            resolver,
            history,
            observations: Arc::new(Mutex::new(BTreeMap::new())),
            observation_requests: Arc::new(Mutex::new(BTreeMap::new())),
            terminal_requests: Arc::new(Mutex::new(BTreeMap::new())),
            terminal_lock: Arc::new(Mutex::new(())),
        }
    }

    pub async fn observe_repository(
        &self,
        request: ObserveGitRepositoryRequest,
    ) -> Result<GitObservation, GitReviewError> {
        validate_observation_request(&request)?;
        let digest = request_digest(&request, OPERATION_OBSERVE)?;
        let key = (
            request.workspace_id.clone(),
            request.client_request_id.clone(),
        );
        if let Some(cached) = self.observation_requests.lock().await.get(&key).cloned() {
            if cached.digest == digest {
                return Ok(cached.response);
            }
            return Err(git_error(
                "GIT-REQUEST-IDEMPOTENCY-CONFLICT",
                OPERATION_OBSERVE,
                false,
            ));
        }
        let observation = self.capture_and_persist(&request).await?;
        self.observation_requests.lock().await.insert(
            key,
            CachedResponse {
                digest,
                response: observation.clone(),
            },
        );
        Ok(observation)
    }

    pub(crate) async fn begin_trusted_commit_candidate(
        &self,
        input: TrustedCommitCandidateInput,
    ) -> Result<TrustedCommitCandidate, GitReviewError> {
        validate_workspace_id(&input.workspace_id)?;
        validate_opaque_id(&input.work_unit_id, "GIT-WORK-UNIT-ID")?;
        if !input.valid() {
            return Err(git_error(
                "GIT-COMMIT-PROOF-CONTEXT",
                OPERATION_TRUSTED,
                false,
            ));
        }
        let root = self.resolver.resolve(&input.workspace_id).await?;
        let layout = GitRepositoryLayout::inspect(&root)
            .map_err(|_| git_error("GIT-REPOSITORY-READ", OPERATION_TRUSTED, true))?;
        Ok(TrustedCommitCandidate::from_layout(input, layout))
    }

    pub(crate) async fn complete_trusted_commit_candidate(
        &self,
        candidate: TrustedCommitCandidate,
        workspace_generation: u64,
        raw_thread_id: &str,
        raw_turn_id: &str,
        item_id: &str,
    ) -> Result<Option<TrustedCommitProof>, GitReviewError> {
        self.complete_trusted_commit_candidate_with_expected_heads(
            candidate,
            workspace_generation,
            raw_thread_id,
            raw_turn_id,
            item_id,
            None,
        )
        .await
    }

    pub(crate) async fn complete_trusted_commit_candidate_exact(
        &self,
        candidate: TrustedCommitCandidate,
        workspace_generation: u64,
        raw_thread_id: &str,
        raw_turn_id: &str,
        item_id: &str,
        expected_before_head: &str,
        expected_commit_sha: &str,
    ) -> Result<Option<TrustedCommitProof>, GitReviewError> {
        self.complete_trusted_commit_candidate_with_expected_heads(
            candidate,
            workspace_generation,
            raw_thread_id,
            raw_turn_id,
            item_id,
            Some((expected_before_head, expected_commit_sha)),
        )
        .await
    }

    async fn complete_trusted_commit_candidate_with_expected_heads(
        &self,
        candidate: TrustedCommitCandidate,
        workspace_generation: u64,
        raw_thread_id: &str,
        raw_turn_id: &str,
        item_id: &str,
        expected_heads: Option<(&str, &str)>,
    ) -> Result<Option<TrustedCommitProof>, GitReviewError> {
        if !candidate.matches_completion(workspace_generation, raw_thread_id, raw_turn_id, item_id)
        {
            return Err(git_error(
                "GIT-COMMIT-PROOF-CONTEXT",
                OPERATION_TRUSTED,
                false,
            ));
        }
        let root = self.resolver.resolve(candidate.workspace_id()).await?;
        let layout = GitRepositoryLayout::inspect(&root)
            .map_err(|_| git_error("GIT-REPOSITORY-READ", OPERATION_TRUSTED, true))?;
        if !candidate.same_repository(&layout) {
            return Err(git_error(
                "GIT-COMMIT-PROOF-REPOSITORY",
                OPERATION_TRUSTED,
                false,
            ));
        }
        if let Some((expected_before_head, expected_commit_sha)) = expected_heads {
            if candidate.before_sha() != expected_before_head {
                return Err(git_error(
                    "GIT-COMMIT-PROOF-BEFORE",
                    OPERATION_TRUSTED,
                    false,
                ));
            }
            if layout.head_sha != expected_commit_sha {
                return Err(git_error("GIT-COMMIT-PROOF-SHA", OPERATION_TRUSTED, false));
            }
        }
        if layout.head_sha == "unborn" || layout.head_sha == candidate.before_sha() {
            return Ok(None);
        }
        ensure_reachable(&self.runner, &root, &layout.head_sha).await?;
        if candidate.before_sha() != "unborn" {
            let range = new_commit_shas(
                &self.runner,
                &root,
                candidate.before_sha(),
                &layout.head_sha,
            )
            .await?;
            if !range.iter().any(|sha| sha == &layout.head_sha) {
                return Err(git_error(
                    "GIT-COMMIT-PROOF-RANGE",
                    OPERATION_TRUSTED,
                    false,
                ));
            }
        }
        Ok(Some(candidate.into_proof(layout.head_sha)))
    }

    pub async fn observe_terminal_work_unit(
        &self,
        request: ObserveTerminalWorkUnitRequest,
    ) -> Result<TerminalWorkUnitObservationResult, GitReviewError> {
        self.observe_terminal_work_unit_with_proofs(request, Vec::new())
            .await
            .map(|result| result.response)
    }

    pub(crate) async fn observe_trusted_terminal_work_unit(
        &self,
        request: ObserveTerminalWorkUnitRequest,
        proofs: Vec<TrustedCommitProof>,
    ) -> Result<TrustedTerminalWorkUnitObservationResult, GitReviewError> {
        let result = self
            .observe_terminal_work_unit_with_proofs(request, proofs)
            .await?;
        Ok(TrustedTerminalWorkUnitObservationResult {
            response: result.response,
            verified_commits: result.verified_commits,
        })
    }

    async fn observe_terminal_work_unit_with_proofs(
        &self,
        request: ObserveTerminalWorkUnitRequest,
        proofs: Vec<TrustedCommitProof>,
    ) -> Result<TerminalProcessingResult, GitReviewError> {
        validate_terminal_request(&request)?;
        let digest = terminal_request_digest(&request, &proofs)?;
        let key = (
            request.workspace_id.clone(),
            request.client_request_id.clone(),
        );
        let _guard = self.terminal_lock.lock().await;
        if let Some(cached) = self.terminal_requests.lock().await.get(&key).cloned() {
            if cached.digest == digest {
                return Ok(cached.response);
            }
            return Err(git_error(
                "GIT-REQUEST-IDEMPOTENCY-CONFLICT",
                OPERATION_TERMINAL,
                false,
            ));
        }
        let mut verified_shas = BTreeSet::new();
        let mut proof_nonces = BTreeSet::new();
        for proof in &proofs {
            if !proof.matches_terminal(
                &request.workspace_id,
                request.workspace_generation,
                &request.work_unit_id,
            ) || !proof_nonces.insert(proof.nonce().to_owned())
                || !verified_shas.insert(proof.expected_sha().to_owned())
            {
                return Err(git_error(
                    "GIT-COMMIT-PROOF-CONTEXT",
                    OPERATION_TERMINAL,
                    false,
                ));
            }
        }

        let before = self
            .load_observation(&request.workspace_id, &request.before_observation_id)
            .await?
            .ok_or_else(|| {
                git_error(
                    "GIT-BEFORE-OBSERVATION-NOT-FOUND",
                    OPERATION_TERMINAL,
                    false,
                )
            })?;
        if before.workspace_generation != request.workspace_generation
            || before.work_unit_id.as_deref() != Some(request.work_unit_id.as_str())
            || before.reason != GitObservationReason::WorkUnitStarted
        {
            return Err(git_error(
                "GIT-BEFORE-OBSERVATION-MISMATCH",
                OPERATION_TERMINAL,
                false,
            ));
        }

        let after_request = ObserveGitRepositoryRequest {
            schema_version: GIT_REVIEW_SCHEMA_VERSION,
            client_request_id: format!("terminal-{}", request.client_request_id),
            workspace_id: request.workspace_id.clone(),
            workspace_generation: request.workspace_generation,
            reason: GitObservationReason::WorkUnitTerminal,
            work_unit_id: Some(request.work_unit_id.clone()),
            source_event_id: Some(request.source_event_id.clone()),
        };
        let after = self.capture_and_persist(&after_request).await?;
        let root = self.resolver.resolve(&request.workspace_id).await?;
        let commit_shas = if after.head_sha == "unborn" {
            Vec::new()
        } else if before.head_sha == "unborn" {
            let mut identities = list_commit_identities(&self.runner, &root, 0, 101).await?;
            if identities.len() > 100 {
                return Err(git_error(
                    "GIT-COMMIT-RANGE-LIMIT",
                    OPERATION_TERMINAL,
                    false,
                ));
            }
            identities.reverse();
            identities
                .into_iter()
                .map(|identity| identity.commit_sha)
                .collect()
        } else {
            new_commit_shas(&self.runner, &root, &before.head_sha, &after.head_sha).await?
        };
        let observed_shas = commit_shas.iter().cloned().collect::<BTreeSet<_>>();
        if !verified_shas.is_subset(&observed_shas) {
            return Err(git_error(
                "GIT-COMMIT-PROOF-MISMATCH",
                OPERATION_TERMINAL,
                false,
            ));
        }

        let mut new_commits = Vec::with_capacity(commit_shas.len());
        let mut new_commit_evidence_ids = Vec::with_capacity(verified_shas.len());
        let mut verified_commits = Vec::with_capacity(verified_shas.len());
        for commit_sha in commit_shas {
            let evidence_id = super::evidence::commit_evidence_id(&commit_sha)?;
            let verified = verified_shas.contains(&commit_sha);
            let evidence = if verified {
                if let Some(existing) = self
                    .history
                    .get_commit_evidence(&request.workspace_id, &evidence_id)
                    .await?
                {
                    if existing.work_unit_id.as_deref() != Some(request.work_unit_id.as_str())
                        || existing.source_event_id.as_deref()
                            != Some(request.source_event_id.as_str())
                    {
                        return Err(git_error(
                            "GIT-COMMIT-EVIDENCE-CONFLICT",
                            OPERATION_TERMINAL,
                            false,
                        ));
                    }
                    existing
                } else {
                    let identity = read_commit_identity(&self.runner, &root, &commit_sha).await?;
                    let mut evidence = build_commit_evidence(
                        &self.runner,
                        &root,
                        &request.workspace_id,
                        identity,
                        Some((
                            &request,
                            &before.observation_id,
                            &after.observation_id,
                            &after.captured_at,
                        )),
                    )
                    .await?;
                    let sequence = self.history.append_commit_evidence(&evidence).await?;
                    evidence.history_sequence = Some(sequence);
                    evidence
                }
            } else {
                match self
                    .history
                    .get_commit_evidence(&request.workspace_id, &evidence_id)
                    .await?
                    .filter(|existing| {
                        existing.work_unit_id.as_deref() == Some(request.work_unit_id.as_str())
                            && existing.source_event_id.as_deref()
                                == Some(request.source_event_id.as_str())
                    }) {
                    Some(existing) => existing,
                    None => {
                        let identity =
                            read_commit_identity(&self.runner, &root, &commit_sha).await?;
                        build_commit_evidence(
                            &self.runner,
                            &root,
                            &request.workspace_id,
                            identity,
                            None,
                        )
                        .await?
                    }
                }
            };
            let correlated = evidence.producer == CommitProducer::MainCodex
                && evidence.work_unit_id.as_deref() == Some(request.work_unit_id.as_str())
                && evidence.source_event_id.as_deref() == Some(request.source_event_id.as_str());
            if correlated {
                new_commit_evidence_ids.push(evidence.commit_evidence_id.clone());
            }
            if verified {
                verified_commits.push(TrustedVerifiedCommit {
                    commit_evidence_id: evidence.commit_evidence_id.clone(),
                    commit_sha: commit_sha.clone(),
                });
            }
            new_commits.push(summarize(&evidence));
        }

        let mut work_unit = WorkUnitGitObservation {
            schema_version: GIT_REVIEW_SCHEMA_VERSION,
            workspace_id: request.workspace_id.clone(),
            workspace_generation: request.workspace_generation,
            work_unit_id: request.work_unit_id.clone(),
            source_event_id: request.source_event_id.clone(),
            terminal_state: request.terminal_state,
            before_observation_id: before.observation_id,
            after_observation_id: after.observation_id.clone(),
            new_commit_evidence_ids,
            commit_skill_injection: request.commit_skill_injection.clone(),
            reported_commit_block_reason: request.reported_commit_block_reason.clone(),
            observed_at: after.captured_at.clone(),
            history_sequence: None,
        };
        let sequence = self.history.append_work_unit(&work_unit).await?;
        work_unit.history_sequence = Some(sequence);
        let response = TerminalWorkUnitObservationResult {
            schema_version: GIT_REVIEW_SCHEMA_VERSION,
            observation: after,
            work_unit,
            new_commits,
        };
        let result = TerminalProcessingResult {
            response,
            verified_commits,
        };
        self.terminal_requests.lock().await.insert(
            key,
            CachedResponse {
                digest,
                response: result.clone(),
            },
        );
        Ok(result)
    }

    pub async fn list_commit_evidence(
        &self,
        request: ListCommitEvidenceRequest,
    ) -> Result<CommitEvidencePage, GitReviewError> {
        validate_schema(request.schema_version, OPERATION_READ)?;
        validate_workspace_id(&request.workspace_id)?;
        if request.workspace_generation == 0 || request.limit == 0 || request.limit > MAX_LIST_LIMIT
        {
            return Err(git_error("GIT-COMMIT-LIST-INPUT", OPERATION_READ, false));
        }
        if request.filter == CommitEvidenceFilter::ThisWorkUnit && request.work_unit_id.is_none() {
            return Err(git_error("GIT-WORK-UNIT-ID", OPERATION_READ, false));
        }
        if let Some(work_unit_id) = &request.work_unit_id {
            validate_opaque_id(work_unit_id, "GIT-WORK-UNIT-ID")?;
        }
        let offset = parse_cursor(request.cursor.as_deref())?;
        let root = self.resolver.resolve(&request.workspace_id).await?;
        let layout = GitRepositoryLayout::inspect(&root)
            .map_err(|_| git_error("GIT-REPOSITORY-READ", OPERATION_READ, true))?;
        if layout.head_sha == "unborn" {
            return Ok(CommitEvidencePage {
                schema_version: GIT_REVIEW_SCHEMA_VERSION,
                items: Vec::new(),
                next_cursor: None,
            });
        }
        let requested = request.limit as usize;
        let correlated = self
            .history
            .list_commit_evidence(&request.workspace_id, MAX_FILTER_SCAN_COMMITS as u32)
            .await?
            .into_iter()
            .map(|evidence| (evidence.identity.commit_sha.clone(), evidence))
            .collect::<BTreeMap<_, _>>();
        let mut items = Vec::new();
        let mut scanned = 0_usize;
        let mut scan_offset = offset;
        let mut next_offset = None;

        'scan: while scanned < MAX_FILTER_SCAN_COMMITS {
            let batch_capacity = FILTER_SCAN_BATCH.min(MAX_FILTER_SCAN_COMMITS - scanned);
            let identities =
                list_commit_identities(&self.runner, &root, scan_offset, batch_capacity + 1)
                    .await?;
            let has_unprocessed_identity = identities.len() > batch_capacity;
            let process_count = identities.len().min(batch_capacity);
            if process_count == 0 {
                break;
            }

            for (index, identity) in identities.into_iter().take(process_count).enumerate() {
                let identity_offset = scan_offset + index;
                let detail = if let Some(evidence) = correlated.get(&identity.commit_sha) {
                    evidence.clone()
                } else if request.filter == CommitEvidenceFilter::ThisWorkUnit {
                    continue;
                } else {
                    build_commit_evidence(
                        &self.runner,
                        &root,
                        &request.workspace_id,
                        identity,
                        None,
                    )
                    .await?
                };
                let include = match request.filter {
                    CommitEvidenceFilter::All => true,
                    CommitEvidenceFilter::ThisWorkUnit => {
                        detail.work_unit_id.as_deref() == request.work_unit_id.as_deref()
                    }
                    CommitEvidenceFilter::NeedsAttention => detail
                        .gates
                        .iter()
                        .any(|gate| !matches!(gate.outcome, super::types::GateOutcome::Pass)),
                };
                if include {
                    if items.len() == requested {
                        next_offset = Some(identity_offset);
                        break 'scan;
                    }
                    items.push(summarize(&detail));
                }
            }

            scan_offset += process_count;
            scanned += process_count;
            if process_count < batch_capacity {
                break;
            }
            if scanned == MAX_FILTER_SCAN_COMMITS && has_unprocessed_identity {
                next_offset = Some(scan_offset);
            }
            if !has_unprocessed_identity {
                break;
            }
        }
        Ok(CommitEvidencePage {
            schema_version: GIT_REVIEW_SCHEMA_VERSION,
            items,
            next_cursor: next_offset.map(|offset| format!("offset-{offset}")),
        })
    }

    pub async fn read_commit_evidence(
        &self,
        request: CommitEvidenceDetailRequest,
    ) -> Result<CommitEvidenceDetail, GitReviewError> {
        validate_detail_request(&request)?;
        if let Some(evidence) = self
            .history
            .get_commit_evidence(&request.workspace_id, &request.commit_evidence_id)
            .await?
        {
            return Ok(evidence);
        }
        let root = self.resolver.resolve(&request.workspace_id).await?;
        let commit_sha = commit_sha_from_evidence_id(&request.commit_evidence_id)?;
        ensure_reachable(&self.runner, &root, &commit_sha).await?;
        let identity = read_commit_identity(&self.runner, &root, &commit_sha).await?;
        build_commit_evidence(&self.runner, &root, &request.workspace_id, identity, None).await
    }

    pub async fn read_commit_diff(
        &self,
        request: ReadCommitDiffRequest,
    ) -> Result<CommitDiffFile, GitReviewError> {
        validate_schema(request.schema_version, OPERATION_READ)?;
        validate_workspace_id(&request.workspace_id)?;
        if request.workspace_generation == 0 {
            return Err(git_error("GIT-WORKSPACE-GENERATION", OPERATION_READ, false));
        }
        validate_opaque_id(&request.file_evidence_id, "GIT-FILE-EVIDENCE-ID")?;
        let detail = self
            .read_commit_evidence(CommitEvidenceDetailRequest {
                schema_version: request.schema_version,
                workspace_id: request.workspace_id.clone(),
                workspace_generation: request.workspace_generation,
                commit_evidence_id: request.commit_evidence_id,
            })
            .await?;
        let root = self.resolver.resolve(&request.workspace_id).await?;
        read_commit_diff(&self.runner, &root, &detail, &request.file_evidence_id).await
    }

    pub async fn prepare_explanation_evidence(
        &self,
        request: PrepareCommitExplanationEvidenceRequest,
    ) -> Result<CommitEvidenceV1, GitReviewError> {
        validate_schema(request.schema_version, OPERATION_READ)?;
        validate_workspace_id(&request.workspace_id)?;
        if request.workspace_generation == 0 || request.selection_version == 0 {
            return Err(git_error("GIT-EXPLANATION-INPUT", OPERATION_READ, false));
        }
        if !matches!(request.locale.as_str(), "ja" | "en") {
            return Err(git_error("GIT-EXPLANATION-LOCALE", OPERATION_READ, false));
        }
        let detail = self
            .read_commit_evidence(CommitEvidenceDetailRequest {
                schema_version: request.schema_version,
                workspace_id: request.workspace_id.clone(),
                workspace_generation: request.workspace_generation,
                commit_evidence_id: request.commit_evidence_id,
            })
            .await?;
        let root = self.resolver.resolve(&request.workspace_id).await?;
        build_explanation_evidence(
            &detail,
            &root,
            &request.locale,
            request.workspace_generation,
            request.selection_version,
        )
    }

    async fn capture_and_persist(
        &self,
        request: &ObserveGitRepositoryRequest,
    ) -> Result<GitObservation, GitReviewError> {
        let id = observation_id(request);
        if let Some(observation) = self
            .observations
            .lock()
            .await
            .get(&(request.workspace_id.clone(), id.clone()))
            .cloned()
        {
            return Ok(observation);
        }
        if let Some(observation) = self
            .history
            .get_observation(&request.workspace_id, &id)
            .await?
        {
            self.observations
                .lock()
                .await
                .insert((request.workspace_id.clone(), id), observation.clone());
            return Ok(observation);
        }
        let root = self.resolver.resolve(&request.workspace_id).await?;
        let mut observation = capture_observation(&self.runner, request, &root).await?;
        let sequence = self.history.append_observation(&observation).await?;
        observation.history_sequence = Some(sequence);
        self.observations.lock().await.insert(
            (
                request.workspace_id.clone(),
                observation.observation_id.clone(),
            ),
            observation.clone(),
        );
        Ok(observation)
    }

    async fn load_observation(
        &self,
        workspace_id: &str,
        observation_id: &str,
    ) -> Result<Option<GitObservation>, GitReviewError> {
        validate_opaque_id(observation_id, "GIT-OBSERVATION-ID")?;
        if let Some(observation) = self
            .observations
            .lock()
            .await
            .get(&(workspace_id.to_owned(), observation_id.to_owned()))
            .cloned()
        {
            return Ok(Some(observation));
        }
        self.history
            .get_observation(workspace_id, observation_id)
            .await
    }
}

fn validate_observation_request(
    request: &ObserveGitRepositoryRequest,
) -> Result<(), GitReviewError> {
    validate_schema(request.schema_version, OPERATION_OBSERVE)?;
    validate_workspace_id(&request.workspace_id)?;
    validate_opaque_id(&request.client_request_id, "GIT-CLIENT-REQUEST-ID")?;
    if request.workspace_generation == 0 {
        return Err(git_error(
            "GIT-WORKSPACE-GENERATION",
            OPERATION_OBSERVE,
            false,
        ));
    }
    match request.reason {
        GitObservationReason::WorkUnitStarted | GitObservationReason::WorkUnitTerminal => {
            let work_unit_id = request
                .work_unit_id
                .as_deref()
                .ok_or_else(|| git_error("GIT-WORK-UNIT-ID", OPERATION_OBSERVE, false))?;
            validate_opaque_id(work_unit_id, "GIT-WORK-UNIT-ID")?;
        }
        GitObservationReason::ActiveView | GitObservationReason::ManualRefresh => {
            if request.work_unit_id.is_some() || request.source_event_id.is_some() {
                return Err(git_error(
                    "GIT-OBSERVATION-CONTEXT",
                    OPERATION_OBSERVE,
                    false,
                ));
            }
        }
    }
    if let Some(source_event_id) = &request.source_event_id {
        validate_opaque_id(source_event_id, "GIT-SOURCE-EVENT-ID")?;
    }
    Ok(())
}

fn validate_terminal_request(
    request: &ObserveTerminalWorkUnitRequest,
) -> Result<(), GitReviewError> {
    validate_schema(request.schema_version, OPERATION_TERMINAL)?;
    validate_workspace_id(&request.workspace_id)?;
    for (value, code) in [
        (&request.client_request_id, "GIT-CLIENT-REQUEST-ID"),
        (&request.before_observation_id, "GIT-OBSERVATION-ID"),
        (&request.work_unit_id, "GIT-WORK-UNIT-ID"),
        (&request.source_event_id, "GIT-SOURCE-EVENT-ID"),
    ] {
        validate_opaque_id(value, code)?;
    }
    if request.workspace_generation == 0
        || request.acceptance.len() > 20
        || request.verification.len() > MAX_EVIDENCE_ITEMS
        || request.decisions.len() > MAX_EVIDENCE_ITEMS
        || request.failed_attempts.len() > MAX_EVIDENCE_ITEMS
        || request.risks.len() > MAX_EVIDENCE_ITEMS
    {
        return Err(git_error("GIT-TERMINAL-INPUT", OPERATION_TERMINAL, false));
    }
    if !valid_git_text(&request.objective, MAX_GIT_OBJECTIVE_CHARS, false)
        || !request
            .acceptance
            .iter()
            .all(|value| valid_git_text(value, MAX_GIT_ACCEPTANCE_CHARS, false))
        || !request.verification.iter().all(valid_terminal_verification)
        || !request.decisions.iter().all(valid_terminal_decision)
        || !request.failed_attempts.iter().all(valid_terminal_attempt)
        || !request.risks.iter().all(valid_terminal_risk)
        || !request
            .reported_commit_block_reason
            .as_deref()
            .is_none_or(|value| valid_git_text(value, MAX_GIT_BLOCK_REASON_CHARS, false))
    {
        return Err(git_error("GIT-EVIDENCE-TEXT", OPERATION_TERMINAL, false));
    }
    let skill = &request.commit_skill_injection;
    if skill.schema_version != GIT_REVIEW_SCHEMA_VERSION
        || skill.skill_id != "coding-wife-commit-work"
        || skill.workspace_generation != request.workspace_generation
        || skill.work_unit_id != request.work_unit_id
        || skill.skill_version.is_empty()
        || skill.skill_version.len() > 64
        || !valid_sha256(&skill.content_digest)
        || skill.path_authority != SkillPathAuthority::AppBundle
        || skill.injection_mode != SkillInjectionMode::SkillInput
        || chrono::DateTime::parse_from_rfc3339(&skill.injected_at).is_err()
    {
        return Err(git_error(
            "GIT-COMMIT-SKILL-AUDIT",
            OPERATION_TERMINAL,
            false,
        ));
    }
    validate_opaque_id(&skill.client_request_id, "GIT-SKILL-CLIENT-REQUEST-ID")?;
    Ok(())
}

fn validate_detail_request(request: &CommitEvidenceDetailRequest) -> Result<(), GitReviewError> {
    validate_schema(request.schema_version, OPERATION_READ)?;
    validate_workspace_id(&request.workspace_id)?;
    if request.workspace_generation == 0 {
        return Err(git_error("GIT-WORKSPACE-GENERATION", OPERATION_READ, false));
    }
    commit_sha_from_evidence_id(&request.commit_evidence_id).map(|_| ())
}

fn validate_schema(schema_version: u16, operation: &'static str) -> Result<(), GitReviewError> {
    if schema_version == GIT_REVIEW_SCHEMA_VERSION {
        Ok(())
    } else {
        Err(git_error("GIT-SCHEMA-VERSION", operation, false))
    }
}

fn valid_terminal_verification(value: &super::types::VerificationEvidence) -> bool {
    validate_opaque_id(&value.evidence_id, "GIT-EVIDENCE-ID").is_ok()
        && validate_opaque_id(&value.source_event_id, "GIT-SOURCE-EVENT-ID").is_ok()
        && valid_git_text(&value.check, MAX_GIT_VERIFICATION_CHECK_CHARS, false)
        && value.duration_ms <= 24 * 60 * 60 * 1_000
        && valid_git_text(&value.summary, MAX_GIT_VERIFICATION_SUMMARY_CHARS, true)
}

fn valid_terminal_decision(value: &super::types::DecisionEvidence) -> bool {
    validate_opaque_id(&value.decision_id, "GIT-DECISION-ID").is_ok()
        && validate_opaque_id(&value.source_event_id, "GIT-SOURCE-EVENT-ID").is_ok()
        && valid_git_text(&value.summary, MAX_GIT_DECISION_SUMMARY_CHARS, false)
        && valid_git_text(&value.answer, MAX_GIT_DECISION_ANSWER_CHARS, false)
        && valid_git_text(&value.rationale, MAX_GIT_DECISION_RATIONALE_CHARS, true)
}

fn valid_terminal_attempt(value: &super::types::FailedAttemptEvidence) -> bool {
    validate_opaque_id(&value.attempt_id, "GIT-ATTEMPT-ID").is_ok()
        && validate_opaque_id(&value.source_event_id, "GIT-SOURCE-EVENT-ID").is_ok()
        && valid_git_text(&value.approach, MAX_GIT_ATTEMPT_APPROACH_CHARS, false)
        && valid_git_text(&value.outcome, MAX_GIT_ATTEMPT_OUTCOME_CHARS, false)
        && valid_git_text(&value.learning, MAX_GIT_ATTEMPT_LEARNING_CHARS, true)
}

fn valid_terminal_risk(value: &super::types::KnownRisk) -> bool {
    validate_opaque_id(&value.risk_id, "GIT-RISK-ID").is_ok()
        && validate_opaque_id(&value.source_event_id, "GIT-SOURCE-EVENT-ID").is_ok()
        && valid_git_text(&value.category, MAX_GIT_RISK_CATEGORY_CHARS, false)
        && valid_git_text(&value.summary, MAX_GIT_RISK_SUMMARY_CHARS, false)
        && valid_git_text(&value.mitigation, MAX_GIT_RISK_MITIGATION_CHARS, true)
}

fn valid_sha256(value: &str) -> bool {
    let value = value.strip_prefix("sha256:").unwrap_or(value);
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn request_digest<T: serde::Serialize>(
    request: &T,
    operation: &'static str,
) -> Result<String, GitReviewError> {
    let bytes = serde_json::to_vec(request)
        .map_err(|_| git_error("GIT-REQUEST-ENCODE", operation, false))?;
    Ok(format!("sha256:{}", hex::encode(Sha256::digest(bytes))))
}

fn terminal_request_digest(
    request: &ObserveTerminalWorkUnitRequest,
    proofs: &[TrustedCommitProof],
) -> Result<String, GitReviewError> {
    let mut proof_material = proofs
        .iter()
        .map(|proof| format!("{}:{}", proof.nonce(), proof.expected_sha()))
        .collect::<Vec<_>>();
    proof_material.sort();
    request_digest(&(request, proof_material), OPERATION_TERMINAL)
}

async fn ensure_reachable(
    runner: &GitRunner,
    root: &std::path::Path,
    commit_sha: &str,
) -> Result<(), GitReviewError> {
    let layout = GitRepositoryLayout::inspect(root)
        .map_err(|_| git_error("GIT-REPOSITORY-READ", OPERATION_READ, true))?;
    if layout.head_sha == "unborn" {
        return Err(git_error("GIT-COMMIT-NOT-FOUND", OPERATION_READ, false));
    }
    if layout.head_sha == commit_sha {
        return Ok(());
    }
    let output = runner
        .is_ancestor(root, commit_sha, &layout.head_sha)
        .await
        .map_err(service_runner_error)?;
    if output.status.success() {
        Ok(())
    } else {
        Err(git_error("GIT-COMMIT-NOT-REACHABLE", OPERATION_READ, false))
    }
}

fn service_runner_error(error: GitRunnerError) -> GitReviewError {
    let (code, recoverable) = match error {
        GitRunnerError::BinaryUnavailable => ("GIT-BINARY-UNAVAILABLE", true),
        GitRunnerError::BinaryIdentityChanged => ("GIT-BINARY-IDENTITY", false),
        GitRunnerError::Spawn => ("GIT-PROCESS-SPAWN", true),
        GitRunnerError::Timeout => ("GIT-PROCESS-TIMEOUT", true),
        GitRunnerError::OutputLimit => ("GIT-PROCESS-OUTPUT-LIMIT", false),
        GitRunnerError::ProcessTree => ("GIT-PROCESS-TREE", false),
        GitRunnerError::Io => ("GIT-PROCESS-IO", true),
    };
    git_error(code, OPERATION_READ, recoverable)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn terminal_request_fixture() -> ObserveTerminalWorkUnitRequest {
        ObserveTerminalWorkUnitRequest {
            schema_version: GIT_REVIEW_SCHEMA_VERSION,
            client_request_id: "terminal-one".to_owned(),
            workspace_id: "workspace-one".to_owned(),
            workspace_generation: 1,
            before_observation_id: "observation-one".to_owned(),
            work_unit_id: "work-unit-one".to_owned(),
            source_event_id: "event-one".to_owned(),
            terminal_state: super::super::types::WorkUnitTerminalState::Completed,
            objective: "Observe commits".to_owned(),
            acceptance: vec!["Evidence is read only".to_owned()],
            verification: vec![super::super::types::VerificationEvidence {
                evidence_id: "verification-one".to_owned(),
                source_event_id: "verification-event-one".to_owned(),
                check: "cargo test git_review".to_owned(),
                result: super::super::types::VerificationResult::Passed,
                duration_ms: 1,
                summary: String::new(),
            }],
            decisions: vec![super::super::types::DecisionEvidence {
                decision_id: "decision-one".to_owned(),
                source_event_id: "decision-event-one".to_owned(),
                summary: "Keep reads isolated".to_owned(),
                answer: "Use the shadow repository".to_owned(),
                rationale: String::new(),
                reversible: true,
            }],
            failed_attempts: vec![super::super::types::FailedAttemptEvidence {
                attempt_id: "attempt-one".to_owned(),
                source_event_id: "attempt-event-one".to_owned(),
                approach: "Read the repository directly".to_owned(),
                outcome: "Rejected".to_owned(),
                learning: String::new(),
            }],
            risks: vec![super::super::types::KnownRisk {
                risk_id: "risk-one".to_owned(),
                source_event_id: "risk-event-one".to_owned(),
                category: "repository integrity".to_owned(),
                level: super::super::types::RiskLevel::Low,
                summary: "Reads must remain isolated".to_owned(),
                mitigation: String::new(),
                resolved: true,
            }],
            commit_skill_injection: super::super::types::CommitSkillInjectionAudit {
                schema_version: GIT_REVIEW_SCHEMA_VERSION,
                skill_id: "coding-wife-commit-work".to_owned(),
                skill_version: "1.0.0".to_owned(),
                content_digest: "a".repeat(64),
                path_authority: SkillPathAuthority::AppBundle,
                injection_mode: SkillInjectionMode::SkillInput,
                workspace_generation: 1,
                work_unit_id: "work-unit-one".to_owned(),
                client_request_id: "turn-one".to_owned(),
                injected_at: "2026-07-18T00:00:00Z".to_owned(),
            },
            reported_commit_block_reason: Some("No commit was produced".to_owned()),
        }
    }

    fn assert_terminal_text_boundary(
        maximum: usize,
        set: impl Fn(&mut ObserveTerminalWorkUnitRequest, String),
    ) {
        let mut exact = terminal_request_fixture();
        set(&mut exact, "x".repeat(maximum));
        validate_terminal_request(&exact).expect("exact shared history boundary");

        let mut over = terminal_request_fixture();
        set(&mut over, "x".repeat(maximum + 1));
        assert_eq!(
            validate_terminal_request(&over)
                .expect_err("over shared history boundary")
                .code,
            "GIT-EVIDENCE-TEXT"
        );
    }

    #[test]
    fn terminal_text_bounds_match_the_persisted_git_schema() {
        assert_terminal_text_boundary(MAX_GIT_OBJECTIVE_CHARS, |request, value| {
            request.objective = value
        });
        assert_terminal_text_boundary(MAX_GIT_ACCEPTANCE_CHARS, |request, value| {
            request.acceptance[0] = value
        });
        assert_terminal_text_boundary(MAX_GIT_VERIFICATION_CHECK_CHARS, |request, value| {
            request.verification[0].check = value
        });
        assert_terminal_text_boundary(MAX_GIT_VERIFICATION_SUMMARY_CHARS, |request, value| {
            request.verification[0].summary = value
        });
        assert_terminal_text_boundary(MAX_GIT_DECISION_SUMMARY_CHARS, |request, value| {
            request.decisions[0].summary = value
        });
        assert_terminal_text_boundary(MAX_GIT_DECISION_ANSWER_CHARS, |request, value| {
            request.decisions[0].answer = value
        });
        assert_terminal_text_boundary(MAX_GIT_DECISION_RATIONALE_CHARS, |request, value| {
            request.decisions[0].rationale = value
        });
        assert_terminal_text_boundary(MAX_GIT_ATTEMPT_APPROACH_CHARS, |request, value| {
            request.failed_attempts[0].approach = value
        });
        assert_terminal_text_boundary(MAX_GIT_ATTEMPT_OUTCOME_CHARS, |request, value| {
            request.failed_attempts[0].outcome = value
        });
        assert_terminal_text_boundary(MAX_GIT_ATTEMPT_LEARNING_CHARS, |request, value| {
            request.failed_attempts[0].learning = value
        });
        assert_terminal_text_boundary(MAX_GIT_RISK_CATEGORY_CHARS, |request, value| {
            request.risks[0].category = value
        });
        assert_terminal_text_boundary(MAX_GIT_RISK_SUMMARY_CHARS, |request, value| {
            request.risks[0].summary = value
        });
        assert_terminal_text_boundary(MAX_GIT_RISK_MITIGATION_CHARS, |request, value| {
            request.risks[0].mitigation = value
        });
        assert_terminal_text_boundary(MAX_GIT_BLOCK_REASON_CHARS, |request, value| {
            request.reported_commit_block_reason = Some(value)
        });
    }

    #[test]
    fn terminal_skill_audit_rejects_the_wrong_bundled_skill() {
        let value = serde_json::json!({
            "schemaVersion": 1,
            "clientRequestId": "terminal-one",
            "workspaceId": "workspace-one",
            "workspaceGeneration": 1,
            "beforeObservationId": "observation-one",
            "workUnitId": "work-unit-one",
            "sourceEventId": "event-one",
            "terminalState": "completed",
            "objective": "Observe commits",
            "acceptance": ["Evidence is read only"],
            "verification": [],
            "decisions": [],
            "failedAttempts": [],
            "risks": [],
            "commitSkillInjection": {
                "schemaVersion": 1,
                "skillId": "wrong-skill",
                "skillVersion": "1.0.0",
                "contentDigest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "pathAuthority": "app_bundle",
                "injectionMode": "skill_input",
                "workspaceGeneration": 1,
                "workUnitId": "work-unit-one",
                "clientRequestId": "turn-one",
                "injectedAt": "2026-07-18T00:00:00Z"
            },
            "reportedCommitBlockReason": null
        });
        let request =
            serde_json::from_value::<ObserveTerminalWorkUnitRequest>(value).expect("typed request");
        assert_eq!(
            validate_terminal_request(&request)
                .expect_err("wrong skill")
                .code,
            "GIT-COMMIT-SKILL-AUDIT"
        );
    }

    #[test]
    fn read_requests_reject_raw_paths_and_git_arguments() {
        let request = serde_json::json!({
            "schemaVersion": 1,
            "workspaceId": "workspace-one",
            "workspaceGeneration": 1,
            "commitEvidenceId": format!("commit-{}", "a".repeat(40)),
            "repositoryPath": "/private/repository",
            "gitArgs": ["update-ref", "refs/heads/main"]
        });
        assert!(serde_json::from_value::<CommitEvidenceDetailRequest>(request).is_err());
    }
}
