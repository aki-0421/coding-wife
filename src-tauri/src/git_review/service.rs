//! Coordinator for read-only Git observation and commit evidence.

use std::collections::BTreeMap;
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
use super::types::{
    CommitDiffFile, CommitEvidenceDetail, CommitEvidenceDetailRequest, CommitEvidenceFilter,
    CommitEvidencePage, CommitEvidenceV1, GitObservation, GitObservationReason,
    ListCommitEvidenceRequest, ObserveGitRepositoryRequest, ObserveTerminalWorkUnitRequest,
    PrepareCommitExplanationEvidenceRequest, ReadCommitDiffRequest, SkillInjectionMode,
    SkillPathAuthority, TerminalWorkUnitObservationResult, WorkUnitGitObservation,
    GIT_REVIEW_SCHEMA_VERSION, MAX_EVIDENCE_ITEMS,
};

const OPERATION_OBSERVE: &str = "observe_git_repository";
const OPERATION_TERMINAL: &str = "observe_terminal_work_unit";
const OPERATION_READ: &str = "read_git_commit_evidence";
const MAX_TEXT: usize = 8 * 1024;
const MAX_LIST_LIMIT: u32 = 50;

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
pub struct GitReviewService {
    runner: GitRunner,
    resolver: Arc<dyn GitWorkspaceResolver>,
    history: Arc<dyn GitReviewHistory>,
    observations: Arc<Mutex<BTreeMap<(String, String), GitObservation>>>,
    observation_requests: Arc<Mutex<BTreeMap<(String, String), CachedResponse<GitObservation>>>>,
    terminal_requests:
        Arc<Mutex<BTreeMap<(String, String), CachedResponse<TerminalWorkUnitObservationResult>>>>,
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

    pub async fn observe_terminal_work_unit(
        &self,
        request: ObserveTerminalWorkUnitRequest,
    ) -> Result<TerminalWorkUnitObservationResult, GitReviewError> {
        validate_terminal_request(&request)?;
        let digest = request_digest(&request, OPERATION_TERMINAL)?;
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

        let mut new_commits = Vec::with_capacity(commit_shas.len());
        let mut new_commit_evidence_ids = Vec::with_capacity(commit_shas.len());
        for commit_sha in commit_shas {
            let evidence_id = super::evidence::commit_evidence_id(&commit_sha)?;
            let evidence = if let Some(existing) = self
                .history
                .get_commit_evidence(&request.workspace_id, &evidence_id)
                .await?
            {
                if existing.work_unit_id.as_deref() != Some(request.work_unit_id.as_str())
                    || existing.source_event_id.as_deref() != Some(request.source_event_id.as_str())
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
            };
            new_commit_evidence_ids.push(evidence.commit_evidence_id.clone());
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
        self.terminal_requests.lock().await.insert(
            key,
            CachedResponse {
                digest,
                response: response.clone(),
            },
        );
        Ok(response)
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
        let identities = list_commit_identities(&self.runner, &root, offset, requested + 1).await?;
        let has_more = identities.len() > requested;
        let correlated = self
            .history
            .list_commit_evidence(&request.workspace_id, 200)
            .await?
            .into_iter()
            .map(|evidence| (evidence.identity.commit_sha.clone(), evidence))
            .collect::<BTreeMap<_, _>>();
        let mut items = Vec::new();
        for identity in identities.into_iter().take(requested) {
            let detail = if let Some(evidence) = correlated.get(&identity.commit_sha) {
                evidence.clone()
            } else {
                build_commit_evidence(&self.runner, &root, &request.workspace_id, identity, None)
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
                items.push(summarize(&detail));
            }
        }
        Ok(CommitEvidencePage {
            schema_version: GIT_REVIEW_SCHEMA_VERSION,
            items,
            next_cursor: has_more.then(|| format!("offset-{}", offset + requested)),
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
        || request.objective.trim().is_empty()
        || request.objective.len() > MAX_TEXT
        || request.acceptance.len() > 20
        || request.verification.len() > MAX_EVIDENCE_ITEMS
        || request.decisions.len() > MAX_EVIDENCE_ITEMS
        || request.failed_attempts.len() > MAX_EVIDENCE_ITEMS
        || request.risks.len() > MAX_EVIDENCE_ITEMS
    {
        return Err(git_error("GIT-TERMINAL-INPUT", OPERATION_TERMINAL, false));
    }
    for value in request_texts(request) {
        if value.contains('\0') || value.len() > MAX_TEXT {
            return Err(git_error("GIT-EVIDENCE-TEXT", OPERATION_TERMINAL, false));
        }
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

fn request_texts(request: &ObserveTerminalWorkUnitRequest) -> impl Iterator<Item = &str> {
    std::iter::once(request.objective.as_str())
        .chain(request.acceptance.iter().map(String::as_str))
        .chain(request.verification.iter().flat_map(|item| {
            [
                item.evidence_id.as_str(),
                item.source_event_id.as_str(),
                item.check.as_str(),
                item.summary.as_str(),
            ]
        }))
        .chain(request.decisions.iter().flat_map(|item| {
            [
                item.decision_id.as_str(),
                item.source_event_id.as_str(),
                item.summary.as_str(),
                item.answer.as_str(),
                item.rationale.as_str(),
            ]
        }))
        .chain(request.failed_attempts.iter().flat_map(|item| {
            [
                item.attempt_id.as_str(),
                item.source_event_id.as_str(),
                item.approach.as_str(),
                item.outcome.as_str(),
                item.learning.as_str(),
            ]
        }))
        .chain(request.risks.iter().flat_map(|item| {
            [
                item.risk_id.as_str(),
                item.source_event_id.as_str(),
                item.category.as_str(),
                item.summary.as_str(),
                item.mitigation.as_str(),
            ]
        }))
        .chain(
            request
                .reported_commit_block_reason
                .iter()
                .map(String::as_str),
        )
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
