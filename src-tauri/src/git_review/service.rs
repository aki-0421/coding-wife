//! Git review operation coordinator and fail-closed gate policy.

use std::collections::{BTreeMap, BTreeSet};
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;

use sha2::{Digest, Sha256};
use tokio::sync::Mutex;

use crate::codex::workspace::WorkspaceService;
use crate::workspace_history::WorkspaceHistoryService;

use super::checkpoint::{
    prepare_checkpoint, promote_checkpoint_objects, update_checkpoint_reference,
    validate_commit_message,
};
use super::error::{git_error, GitReviewError};
use super::history::{
    GitReviewHistory, OperationJournalContext, OperationJournalEvent,
    WorkspaceHistoryGitReviewStore,
};
use super::ownership::{evaluate_ownership, OwnershipEvaluation};
use super::repository::{
    capture_baseline, inspect_repository, validate_opaque_id, validate_workspace_id,
    BaselineRecord, RepositorySnapshot,
};
use super::restore::{
    confirm_restore as execute_restore, preview_restore as build_restore_preview, RestoreIntent,
};
use super::review_pack::{
    build_review_pack, compare_checkpoints, contains_redactable_secret, read_file_diff,
};
use super::runner::{GitRunner, GitRunnerError};
use super::types::{
    CancelRestoreRequest, CheckpointEvaluation, CheckpointOperationState, CheckpointStatus,
    CompareCheckpointsRequest, CompareCheckpointsView, ConfirmRestoreRequest,
    EvaluateCheckpointRequest, FileDiffView, GateKind, GateOutcome, GateResult, GitBaseline,
    GitSupportState, InspectGitBaselineRequest, ListReviewPacksRequest, PreviewRestoreRequest,
    ReadFileDiffRequest, RestorePreview, RestoreResult, ReviewPack, ReviewPackDetailRequest,
    ReviewPackPage, RiskLevel, VerificationResult, GIT_REVIEW_SCHEMA_VERSION, MAX_CHANGED_FILES,
};

const OPERATION_INSPECT: &str = "inspect_git_baseline";
const OPERATION_CHECKPOINT: &str = "evaluate_and_checkpoint_work_unit";
const OPERATION_READ: &str = "read_git_review_evidence";
const MAX_FILE_EVENTS: usize = MAX_CHANGED_FILES * 8;
const MAX_EVIDENCE_ITEMS: usize = 100;

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
                .ok_or_else(|| git_error("GIT-WORKSPACE-NOT-TRUSTED", OPERATION_INSPECT, false))
        })
    }
}

#[derive(Clone)]
struct PendingHistory {
    pack: ReviewPack,
    ref_updated: OperationJournalEvent,
    history_complete: OperationJournalEvent,
    evaluation: CheckpointEvaluation,
}

#[derive(Clone)]
enum RequestOutcome {
    Complete(Box<CheckpointEvaluation>),
    PendingHistory(Box<PendingHistory>),
    Failed(GitReviewError),
}

#[derive(Clone)]
struct RequestRecord {
    request_digest: String,
    outcome: RequestOutcome,
}

/// Coordinates typed Git operations. All mutations share one lock so a second
/// request cannot observe or alter a partially promoted checkpoint.
#[derive(Clone)]
pub struct GitReviewService {
    runner: GitRunner,
    resolver: Arc<dyn GitWorkspaceResolver>,
    history: Arc<dyn GitReviewHistory>,
    baselines: Arc<Mutex<BTreeMap<String, BaselineRecord>>>,
    requests: Arc<Mutex<BTreeMap<(String, String), RequestRecord>>>,
    restore_tokens: Arc<Mutex<BTreeMap<String, RestoreIntent>>>,
    mutation_lock: Arc<Mutex<()>>,
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
            baselines: Arc::new(Mutex::new(BTreeMap::new())),
            requests: Arc::new(Mutex::new(BTreeMap::new())),
            restore_tokens: Arc::new(Mutex::new(BTreeMap::new())),
            mutation_lock: Arc::new(Mutex::new(())),
        }
    }

    pub async fn inspect_baseline(
        &self,
        request: InspectGitBaselineRequest,
    ) -> Result<GitBaseline, GitReviewError> {
        validate_workspace_id(&request.workspace_id)?;
        let root = self.resolver.resolve(&request.workspace_id).await?;
        let baseline = capture_baseline(&self.runner, &request.workspace_id, &root).await?;
        let public = baseline.public.clone();
        self.baselines
            .lock()
            .await
            .insert(public.baseline_id.clone(), baseline);
        Ok(public)
    }

    pub async fn evaluate_checkpoint(
        &self,
        request: EvaluateCheckpointRequest,
    ) -> Result<CheckpointEvaluation, GitReviewError> {
        let scope_reasons = validate_checkpoint_request(&request)?;
        let request_digest = request_digest(&request)?;
        let request_key = (
            request.workspace_id.clone(),
            request.client_request_id.clone(),
        );
        let _mutation_guard = self.mutation_lock.lock().await;

        if let Some(record) = self.requests.lock().await.get(&request_key).cloned() {
            if record.request_digest != request_digest {
                return Err(git_error(
                    "GIT-REQUEST-IDEMPOTENCY-CONFLICT",
                    OPERATION_CHECKPOINT,
                    false,
                ));
            }
            return match record.outcome {
                RequestOutcome::Complete(evaluation) => Ok(*evaluation),
                RequestOutcome::Failed(error) => Err(error),
                RequestOutcome::PendingHistory(pending) => {
                    self.complete_pending_history(request_key, request_digest, *pending)
                        .await
                }
            };
        }

        let root = self.resolver.resolve(&request.workspace_id).await?;
        let baseline = self
            .baselines
            .lock()
            .await
            .get(&request.baseline_id)
            .cloned()
            .ok_or_else(|| git_error("GIT-BASELINE-NOT-FOUND", OPERATION_CHECKPOINT, false))?;
        if baseline.public.workspace_id != request.workspace_id
            || baseline.repository.canonical_root != root
        {
            return Err(git_error(
                "GIT-BASELINE-WORKSPACE-MISMATCH",
                OPERATION_CHECKPOINT,
                false,
            ));
        }

        let current = inspect_repository(&self.runner, &root).await?;
        let ownership =
            evaluate_ownership(&self.runner, &baseline, &current, &request.file_events).await?;
        let gates = evaluate_gates(&request, &baseline, &current, &ownership, scope_reasons);
        if gates.iter().any(|gate| gate.outcome != GateOutcome::Pass) {
            let error_code = gates
                .iter()
                .find(|gate| gate.outcome != GateOutcome::Pass)
                .and_then(|gate| gate.reason_codes.first())
                .cloned();
            let evaluation = CheckpointEvaluation {
                schema_version: GIT_REVIEW_SCHEMA_VERSION,
                status: CheckpointStatus::Blocked,
                gates,
                manifest: ownership.manifest,
                checkpoint: None,
                review_pack: None,
                error_code,
            };
            self.remember_request(
                request_key,
                request_digest,
                RequestOutcome::Complete(Box::new(evaluation.clone())),
            )
            .await;
            return Ok(evaluation);
        }

        let operation_id = operation_id(&request, &request_digest);
        let target_reference = baseline
            .public
            .head_reference
            .clone()
            .unwrap_or_else(|| "HEAD".to_owned());
        let prepared_event = journal_event(
            &operation_id,
            &request,
            &baseline,
            CheckpointOperationState::Prepared,
            &target_reference,
        );
        if let Err(error) = self.history.append_operation(&prepared_event).await {
            self.remember_request(
                request_key,
                request_digest,
                RequestOutcome::Failed(error.clone()),
            )
            .await;
            return Err(error);
        }

        let prepared = match prepare_checkpoint(
            &self.runner,
            &baseline,
            &current,
            &ownership,
            &request.commit_message,
        )
        .await
        {
            Ok(prepared) => prepared,
            Err(error) => {
                self.record_failure(&prepared_event, &error).await;
                self.remember_request(
                    request_key,
                    request_digest,
                    RequestOutcome::Failed(error.clone()),
                )
                .await;
                return Err(error);
            }
        };
        debug_assert!(!prepared.object_ids().is_empty());
        let mut objects_ready = journal_event(
            &operation_id,
            &request,
            &baseline,
            CheckpointOperationState::ObjectsReady,
            &target_reference,
        );
        objects_ready.commit_sha = Some(prepared.identity().commit_sha.clone());
        if let Err(error) = self.history.append_operation(&objects_ready).await {
            self.record_failure(&prepared_event, &error).await;
            self.remember_request(
                request_key,
                request_digest,
                RequestOutcome::Failed(error.clone()),
            )
            .await;
            return Err(error);
        }

        let promoted = match promote_checkpoint_objects(&self.runner, prepared).await {
            Ok(promoted) => promoted,
            Err(error) => {
                self.record_failure(&prepared_event, &error).await;
                self.remember_request(
                    request_key,
                    request_digest,
                    RequestOutcome::Failed(error.clone()),
                )
                .await;
                return Err(error);
            }
        };
        debug_assert!(
            promoted.promoted_object_ids().len() <= promoted.identity().commit_sha.len() * 32
        );
        let pack = match build_review_pack(
            &self.runner,
            &baseline.repository,
            &request,
            gates.clone(),
            &ownership,
            promoted.identity(),
        )
        .await
        {
            Ok(pack) => pack,
            Err(error) => {
                self.record_failure(&prepared_event, &error).await;
                self.remember_request(
                    request_key,
                    request_digest,
                    RequestOutcome::Failed(error.clone()),
                )
                .await;
                return Err(error);
            }
        };

        let committed = match update_checkpoint_reference(&self.runner, promoted).await {
            Ok(committed) => committed,
            Err(error) => {
                self.record_failure(&prepared_event, &error).await;
                self.remember_request(
                    request_key,
                    request_digest,
                    RequestOutcome::Failed(error.clone()),
                )
                .await;
                return Err(error);
            }
        };
        debug_assert_eq!(
            committed.index_fingerprint_before,
            committed.index_fingerprint_after
        );
        debug_assert!(!committed.object_ids.is_empty());

        let mut ref_updated = journal_event(
            &operation_id,
            &request,
            &baseline,
            CheckpointOperationState::RefUpdated,
            &target_reference,
        );
        ref_updated.commit_sha = Some(committed.identity.commit_sha.clone());
        ref_updated.pack_digest = Some(pack.pack_digest.clone());
        let mut history_complete = ref_updated.clone();
        history_complete.state = CheckpointOperationState::HistoryComplete;
        let evaluation = CheckpointEvaluation {
            schema_version: GIT_REVIEW_SCHEMA_VERSION,
            status: CheckpointStatus::ReviewReady,
            gates,
            manifest: ownership.manifest,
            checkpoint: Some(committed.identity),
            review_pack: Some(pack.clone()),
            error_code: None,
        };
        let pending = PendingHistory {
            pack,
            ref_updated,
            history_complete,
            evaluation,
        };
        self.complete_pending_history(request_key, request_digest, pending)
            .await
    }

    pub async fn list_review_packs(
        &self,
        request: ListReviewPacksRequest,
    ) -> Result<ReviewPackPage, GitReviewError> {
        validate_workspace_id(&request.workspace_id)?;
        if request.limit == 0 || request.limit > 200 {
            return Err(git_error("GIT-PAGE-LIMIT", OPERATION_READ, false));
        }
        let _ = self.resolver.resolve(&request.workspace_id).await?;
        self.history
            .list_review_packs(
                &request.workspace_id,
                request.before_sequence,
                request.limit,
            )
            .await
    }

    pub async fn review_pack_detail(
        &self,
        request: ReviewPackDetailRequest,
    ) -> Result<ReviewPack, GitReviewError> {
        validate_workspace_id(&request.workspace_id)?;
        validate_opaque_id(&request.checkpoint_id, "GIT-CHECKPOINT-ID")?;
        let _ = self.resolver.resolve(&request.workspace_id).await?;
        self.history
            .get_review_pack(&request.workspace_id, &request.checkpoint_id)
            .await?
            .ok_or_else(|| git_error("GIT-REVIEW-PACK-NOT-FOUND", OPERATION_READ, false))
    }

    pub async fn read_file_diff(
        &self,
        request: ReadFileDiffRequest,
    ) -> Result<FileDiffView, GitReviewError> {
        validate_opaque_id(&request.file_id, "GIT-FILE-ID")?;
        let root = self.resolver.resolve(&request.workspace_id).await?;
        let pack = self
            .review_pack_detail(ReviewPackDetailRequest {
                workspace_id: request.workspace_id,
                checkpoint_id: request.checkpoint_id,
            })
            .await?;
        let repository = inspect_repository(&self.runner, &root).await?.identity;
        read_file_diff(&self.runner, &repository, &pack, &request.file_id).await
    }

    pub async fn compare_checkpoints(
        &self,
        request: CompareCheckpointsRequest,
    ) -> Result<CompareCheckpointsView, GitReviewError> {
        let root = self.resolver.resolve(&request.workspace_id).await?;
        let from = self
            .review_pack_detail(ReviewPackDetailRequest {
                workspace_id: request.workspace_id.clone(),
                checkpoint_id: request.from_checkpoint_id,
            })
            .await?;
        let to = self
            .review_pack_detail(ReviewPackDetailRequest {
                workspace_id: request.workspace_id,
                checkpoint_id: request.to_checkpoint_id,
            })
            .await?;
        let repository = inspect_repository(&self.runner, &root).await?.identity;
        compare_checkpoints(&self.runner, &repository, &from, &to).await
    }

    pub async fn preview_restore(
        &self,
        request: PreviewRestoreRequest,
    ) -> Result<RestorePreview, GitReviewError> {
        validate_workspace_id(&request.workspace_id)?;
        validate_opaque_id(&request.checkpoint_id, "GIT-CHECKPOINT-ID")?;
        let root = self.resolver.resolve(&request.workspace_id).await?;
        let pack = self
            .history
            .get_review_pack(&request.workspace_id, &request.checkpoint_id)
            .await?
            .ok_or_else(|| git_error("GIT-REVIEW-PACK-NOT-FOUND", OPERATION_READ, false))?;
        let repository = inspect_repository(&self.runner, &root).await?.identity;
        let (preview, intent) = build_restore_preview(
            &self.runner,
            &request.workspace_id,
            &repository,
            &pack,
            request.kind,
            request.recovery_branch.as_deref(),
        )
        .await?;
        if let Some(intent) = intent {
            self.restore_tokens
                .lock()
                .await
                .insert(intent.token.clone(), intent);
        }
        Ok(preview)
    }

    pub async fn confirm_restore(
        &self,
        request: ConfirmRestoreRequest,
    ) -> Result<RestoreResult, GitReviewError> {
        validate_workspace_id(&request.workspace_id)?;
        validate_opaque_id(&request.confirmation_token, "GIT-RESTORE-TOKEN")?;
        let _mutation_guard = self.mutation_lock.lock().await;
        let intent = self
            .restore_tokens
            .lock()
            .await
            .remove(&request.confirmation_token)
            .ok_or_else(|| git_error("GIT-RESTORE-TOKEN-INVALID", "confirm_git_restore", false))?;
        if intent.workspace_id != request.workspace_id || intent.token != request.confirmation_token
        {
            return Err(git_error(
                "GIT-RESTORE-TOKEN-WORKSPACE",
                "confirm_git_restore",
                false,
            ));
        }
        let root = self.resolver.resolve(&request.workspace_id).await?;
        let repository = inspect_repository(&self.runner, &root).await?.identity;
        execute_restore(&self.runner, &repository, intent).await
    }

    pub async fn cancel_restore(
        &self,
        request: CancelRestoreRequest,
    ) -> Result<(), GitReviewError> {
        validate_workspace_id(&request.workspace_id)?;
        validate_opaque_id(&request.confirmation_token, "GIT-RESTORE-TOKEN")?;
        let mut tokens = self.restore_tokens.lock().await;
        let belongs_to_workspace = tokens
            .get(&request.confirmation_token)
            .is_some_and(|intent| intent.workspace_id == request.workspace_id);
        if !belongs_to_workspace {
            return Err(git_error(
                "GIT-RESTORE-TOKEN-INVALID",
                "cancel_git_restore",
                false,
            ));
        }
        tokens.remove(&request.confirmation_token);
        Ok(())
    }

    async fn complete_pending_history(
        &self,
        request_key: (String, String),
        request_digest: String,
        pending: PendingHistory,
    ) -> Result<CheckpointEvaluation, GitReviewError> {
        let result = async {
            self.history.append_operation(&pending.ref_updated).await?;
            let sequence = self.history.append_review_pack(&pending.pack).await?;
            self.history
                .append_operation(&pending.history_complete)
                .await?;
            let mut evaluation = pending.evaluation.clone();
            if let Some(pack) = &mut evaluation.review_pack {
                pack.history_sequence = Some(sequence);
            }
            Ok::<_, GitReviewError>(evaluation)
        }
        .await;
        match result {
            Ok(evaluation) => {
                self.remember_request(
                    request_key,
                    request_digest,
                    RequestOutcome::Complete(Box::new(evaluation.clone())),
                )
                .await;
                Ok(evaluation)
            }
            Err(error) => {
                self.remember_request(
                    request_key,
                    request_digest,
                    RequestOutcome::PendingHistory(Box::new(pending)),
                )
                .await;
                Err(error)
            }
        }
    }

    async fn remember_request(
        &self,
        key: (String, String),
        request_digest: String,
        outcome: RequestOutcome,
    ) {
        self.requests.lock().await.insert(
            key,
            RequestRecord {
                request_digest,
                outcome,
            },
        );
    }

    async fn record_failure(&self, prepared: &OperationJournalEvent, error: &GitReviewError) {
        let mut failed = prepared.clone();
        failed.state = CheckpointOperationState::Failed;
        failed.error_code = Some(error.code.clone());
        let _ = self.history.append_operation(&failed).await;
    }
}

fn validate_checkpoint_request(
    request: &EvaluateCheckpointRequest,
) -> Result<Vec<String>, GitReviewError> {
    if request.schema_version != GIT_REVIEW_SCHEMA_VERSION {
        return Err(git_error("GIT-SCHEMA-VERSION", OPERATION_CHECKPOINT, false));
    }
    validate_workspace_id(&request.workspace_id)?;
    for (value, code) in [
        (&request.client_request_id, "GIT-CLIENT-REQUEST-ID"),
        (&request.baseline_id, "GIT-BASELINE-ID"),
        (&request.work_unit_id, "GIT-WORK-UNIT-ID"),
    ] {
        validate_opaque_id(value, code)?;
    }
    if request.file_events.len() > MAX_FILE_EVENTS
        || request.verification.len() > MAX_EVIDENCE_ITEMS
        || request.decisions.len() > MAX_EVIDENCE_ITEMS
        || request.failed_attempts.len() > MAX_EVIDENCE_ITEMS
        || request.risks.len() > MAX_EVIDENCE_ITEMS
    {
        return Err(git_error("GIT-EVIDENCE-LIMIT", OPERATION_CHECKPOINT, false));
    }
    for (value, code) in request
        .file_events
        .iter()
        .map(|item| (&item.event_id, "GIT-EVENT-ID"))
        .chain(
            request
                .verification
                .iter()
                .map(|item| (&item.evidence_id, "GIT-EVIDENCE-ID")),
        )
        .chain(
            request
                .decisions
                .iter()
                .map(|item| (&item.decision_id, "GIT-DECISION-ID")),
        )
        .chain(
            request
                .failed_attempts
                .iter()
                .map(|item| (&item.attempt_id, "GIT-ATTEMPT-ID")),
        )
        .chain(
            request
                .risks
                .iter()
                .map(|item| (&item.risk_id, "GIT-RISK-ID")),
        )
    {
        validate_opaque_id(value, code)?;
    }
    if let Some(approval) = &request.risk_approval {
        validate_opaque_id(&approval.approval_id, "GIT-APPROVAL-ID")?;
        if approval.approved_categories.len() > 100
            || !bounded_text(&approval.approved_at, 128, false)
        {
            return Err(git_error("GIT-APPROVAL-SHAPE", OPERATION_CHECKPOINT, false));
        }
    }

    let mut reasons = Vec::new();
    if !bounded_text(&request.objective, 500, false) {
        reasons.push("GIT-SCOPE-OBJECTIVE".to_owned());
    }
    if request.acceptance.is_empty()
        || request.acceptance.len() > 20
        || request
            .acceptance
            .iter()
            .any(|item| !bounded_text(item, 500, false))
    {
        reasons.push("GIT-SCOPE-ACCEPTANCE".to_owned());
    }
    if request.file_events.is_empty() {
        reasons.push("GIT-SCOPE-NO-FILE-EVENTS".to_owned());
    }
    if validate_commit_message(&request.commit_message).is_err() {
        reasons.push("GIT-COMMIT-MESSAGE".to_owned());
    }
    if request_texts(request).any(|value| !bounded_text(value.0, value.1, value.2)) {
        reasons.push("GIT-EVIDENCE-SHAPE".to_owned());
    }
    Ok(reasons)
}

fn request_texts(request: &EvaluateCheckpointRequest) -> impl Iterator<Item = (&str, usize, bool)> {
    request
        .verification
        .iter()
        .flat_map(|item| [(&*item.check, 512, false), (&*item.summary, 4_096, true)])
        .chain(request.decisions.iter().flat_map(|item| {
            [
                (&*item.summary, 2_048, false),
                (&*item.answer, 2_048, false),
                (&*item.rationale, 4_096, false),
            ]
        }))
        .chain(request.failed_attempts.iter().flat_map(|item| {
            [
                (&*item.approach, 2_048, false),
                (&*item.outcome, 1_024, false),
                (&*item.learning, 2_048, false),
            ]
        }))
        .chain(request.risks.iter().flat_map(|item| {
            [
                (&*item.category, 256, false),
                (&*item.summary, 2_048, false),
                (&*item.mitigation, 2_048, false),
            ]
        }))
}

fn bounded_text(value: &str, maximum: usize, allow_empty: bool) -> bool {
    (allow_empty || !value.trim().is_empty())
        && value.chars().count() <= maximum
        && !value.chars().any(|character| character == '\0')
}

fn evaluate_gates(
    request: &EvaluateCheckpointRequest,
    baseline: &BaselineRecord,
    current: &RepositorySnapshot,
    ownership: &OwnershipEvaluation,
    mut scope_reasons: Vec<String>,
) -> Vec<GateResult> {
    if baseline.public.support_state != GitSupportState::Ready {
        scope_reasons.extend(baseline.public.blocked_reasons.iter().cloned());
    }
    scope_reasons.extend(
        ownership
            .reason_codes
            .iter()
            .filter(|reason| reason.starts_with("GIT-LIMIT-"))
            .cloned(),
    );
    if checkpoint_texts(request)
        .any(|value| contains_redactable_secret(value, &current.identity.canonical_root))
    {
        scope_reasons.push("GIT-SECRET-DETECTED".to_owned());
    }
    scope_reasons.sort();
    scope_reasons.dedup();

    let mut verification_reasons = Vec::new();
    if request.verification.is_empty() {
        verification_reasons.push("GIT-VERIFICATION-MISSING".to_owned());
    }
    if request
        .verification
        .iter()
        .any(|item| item.result != VerificationResult::Passed)
    {
        verification_reasons.push("GIT-VERIFICATION-NOT-PASSED".to_owned());
    }
    if request
        .verification
        .iter()
        .any(|item| item.observed_repository_fingerprint != current.repository_fingerprint)
    {
        verification_reasons.push("GIT-VERIFICATION-STALE".to_owned());
    }

    let (risk_outcome, risk_reasons) = evaluate_risk_gate(request, current, ownership);
    vec![
        gate(
            GateKind::Scope,
            outcome_for_reasons(&scope_reasons),
            scope_reasons,
            current,
        ),
        gate(
            GateKind::Ownership,
            outcome_for_reasons(&ownership.reason_codes),
            ownership.reason_codes.clone(),
            current,
        ),
        gate(
            GateKind::Verification,
            outcome_for_reasons(&verification_reasons),
            verification_reasons,
            current,
        ),
        gate(GateKind::Risk, risk_outcome, risk_reasons, current),
    ]
}

fn checkpoint_texts(request: &EvaluateCheckpointRequest) -> impl Iterator<Item = &str> {
    std::iter::once(request.objective.as_str())
        .chain(request.acceptance.iter().map(String::as_str))
        .chain(std::iter::once(request.commit_message.as_str()))
        .chain(request_texts(request).map(|value| value.0))
}

fn evaluate_risk_gate(
    request: &EvaluateCheckpointRequest,
    current: &RepositorySnapshot,
    ownership: &OwnershipEvaluation,
) -> (GateOutcome, Vec<String>) {
    let mut categories = BTreeSet::new();
    for risk in &request.risks {
        if !risk.resolved || matches!(risk.level, RiskLevel::High | RiskLevel::Critical) {
            categories.insert(risk.category.to_ascii_lowercase());
        }
    }
    for change in &ownership.owned_changes {
        let path = change.relative_path.to_ascii_lowercase();
        for (needle, category) in [
            ("auth", "auth"),
            ("permission", "permission"),
            ("secret", "secret"),
            ("credential", "secret"),
            ("migration", "migration"),
            ("database", "data"),
            ("schema", "data"),
            (".github/workflows", "git-history"),
        ] {
            if path.contains(needle) {
                categories.insert(category.to_owned());
            }
        }
    }
    if categories.is_empty() {
        return (GateOutcome::Pass, Vec::new());
    }
    let approved = request.risk_approval.as_ref().is_some_and(|approval| {
        approval.observed_repository_fingerprint == current.repository_fingerprint
            && categories.iter().all(|category| {
                approval
                    .approved_categories
                    .iter()
                    .any(|approved| approved.eq_ignore_ascii_case(category))
            })
    });
    if approved {
        (GateOutcome::Pass, Vec::new())
    } else {
        (
            GateOutcome::NeedsReview,
            categories
                .into_iter()
                .map(|category| format!("GIT-RISK-APPROVAL-REQUIRED:{category}"))
                .collect(),
        )
    }
}

fn gate(
    kind: GateKind,
    outcome: GateOutcome,
    reason_codes: Vec<String>,
    current: &RepositorySnapshot,
) -> GateResult {
    GateResult {
        gate: kind,
        outcome,
        reason_codes,
        observed_repository_fingerprint: current.repository_fingerprint.clone(),
    }
}

fn outcome_for_reasons(reasons: &[String]) -> GateOutcome {
    if reasons.is_empty() {
        GateOutcome::Pass
    } else {
        GateOutcome::Fail
    }
}

fn journal_event(
    operation_id: &str,
    request: &EvaluateCheckpointRequest,
    baseline: &BaselineRecord,
    state: CheckpointOperationState,
    target_reference: &str,
) -> OperationJournalEvent {
    OperationJournalEvent::now(
        OperationJournalContext {
            operation_id,
            client_request_id: &request.client_request_id,
            workspace_id: &request.workspace_id,
            work_unit_id: &request.work_unit_id,
            baseline_id: &request.baseline_id,
            expected_head_sha: &baseline.public.head_sha,
            target_reference,
        },
        state,
    )
}

fn operation_id(request: &EvaluateCheckpointRequest, digest: &str) -> String {
    format!(
        "operation-{}-{}",
        request.work_unit_id,
        digest
            .trim_start_matches("sha256:")
            .chars()
            .take(16)
            .collect::<String>()
    )
}

fn request_digest(request: &EvaluateCheckpointRequest) -> Result<String, GitReviewError> {
    let bytes = serde_json::to_vec(request)
        .map_err(|_| git_error("GIT-REQUEST-ENCODE", OPERATION_CHECKPOINT, false))?;
    Ok(format!("sha256:{}", hex::encode(Sha256::digest(bytes))))
}

fn service_runner_error(error: GitRunnerError) -> GitReviewError {
    let (code, recoverable) = match error {
        GitRunnerError::BinaryUnavailable | GitRunnerError::Spawn => {
            ("GIT-BINARY-UNAVAILABLE", true)
        }
        GitRunnerError::BinaryIdentityChanged => ("GIT-BINARY-IDENTITY-CHANGED", false),
        GitRunnerError::Timeout => ("GIT-PROCESS-TIMEOUT", true),
        GitRunnerError::OutputLimit => ("GIT-PROCESS-OUTPUT-LIMIT", false),
        GitRunnerError::ProcessTree => ("GIT-PROCESS-TREE", false),
        GitRunnerError::Io => ("GIT-PROCESS-IO", true),
    };
    git_error(code, OPERATION_INSPECT, recoverable)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounded_text_does_not_accept_missing_required_evidence() {
        assert!(bounded_text("test passed", 20, false));
        assert!(!bounded_text("", 20, false));
        assert!(!bounded_text("too long", 3, false));
    }
}
