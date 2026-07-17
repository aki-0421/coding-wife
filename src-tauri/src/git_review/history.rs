//! Append-only review pack persistence boundary.

use std::future::Future;
use std::pin::Pin;
#[cfg(test)]
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::workspace_history::types::{
    AppendDomainEventRequest, WorkspaceTimelineRequest, WORKSPACE_HISTORY_SCHEMA_VERSION,
};
use crate::workspace_history::WorkspaceHistoryService;

use super::error::{git_error, GitReviewError};
use super::types::{
    CheckpointOperationState, ReviewPack, ReviewPackPage, ReviewPackSummary,
    GIT_REVIEW_SCHEMA_VERSION,
};

const OPERATION: &str = "persist_git_review_pack";
const REVIEW_PACK_KIND: &str = "git.review_pack.recorded";
const OPERATION_KIND: &str = "git.checkpoint.operation.changed";

pub(crate) type HistoryFuture<'a, T> =
    Pin<Box<dyn Future<Output = Result<T, GitReviewError>> + Send + 'a>>;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct OperationJournalEvent {
    pub schema_version: u16,
    pub operation_id: String,
    pub client_request_id: String,
    pub workspace_id: String,
    pub work_unit_id: String,
    pub baseline_id: String,
    pub state: CheckpointOperationState,
    pub expected_head_sha: String,
    pub target_reference: String,
    pub commit_sha: Option<String>,
    pub pack_digest: Option<String>,
    pub error_code: Option<String>,
    pub observed_at: String,
}

impl OperationJournalEvent {
    pub fn now(context: OperationJournalContext<'_>, state: CheckpointOperationState) -> Self {
        Self {
            schema_version: GIT_REVIEW_SCHEMA_VERSION,
            operation_id: context.operation_id.to_owned(),
            client_request_id: context.client_request_id.to_owned(),
            workspace_id: context.workspace_id.to_owned(),
            work_unit_id: context.work_unit_id.to_owned(),
            baseline_id: context.baseline_id.to_owned(),
            state,
            expected_head_sha: context.expected_head_sha.to_owned(),
            target_reference: context.target_reference.to_owned(),
            commit_sha: None,
            pack_digest: None,
            error_code: None,
            observed_at: Utc::now().to_rfc3339(),
        }
    }
}

pub(crate) struct OperationJournalContext<'a> {
    pub operation_id: &'a str,
    pub client_request_id: &'a str,
    pub workspace_id: &'a str,
    pub work_unit_id: &'a str,
    pub baseline_id: &'a str,
    pub expected_head_sha: &'a str,
    pub target_reference: &'a str,
}

pub(crate) trait GitReviewHistory: Send + Sync {
    fn append_operation<'a>(&'a self, event: &'a OperationJournalEvent) -> HistoryFuture<'a, u64>;

    fn append_review_pack<'a>(&'a self, pack: &'a ReviewPack) -> HistoryFuture<'a, u64>;

    fn get_review_pack<'a>(
        &'a self,
        workspace_id: &'a str,
        checkpoint_id: &'a str,
    ) -> HistoryFuture<'a, Option<ReviewPack>>;

    fn list_review_packs<'a>(
        &'a self,
        workspace_id: &'a str,
        before_sequence: Option<u64>,
        limit: u32,
    ) -> HistoryFuture<'a, ReviewPackPage>;
}

#[derive(Clone)]
pub(crate) struct WorkspaceHistoryGitReviewStore {
    service: WorkspaceHistoryService,
}

impl WorkspaceHistoryGitReviewStore {
    pub fn new(service: WorkspaceHistoryService) -> Self {
        Self { service }
    }

    async fn append_payload(
        &self,
        event_id: String,
        workspace_id: String,
        kind: &'static str,
        payload: Value,
    ) -> Result<u64, GitReviewError> {
        self.service
            .append_domain_event(AppendDomainEventRequest {
                schema_version: WORKSPACE_HISTORY_SCHEMA_VERSION,
                event_id,
                workspace_id,
                session_id: None,
                producer: "git".to_owned(),
                kind: kind.to_owned(),
                occurred_at: Utc::now().to_rfc3339(),
                payload,
            })
            .await
            .map(|response| response.sequence)
            .map_err(|error| {
                GitReviewError::new(error.code, OPERATION, error.recoverable)
                    .with_detail_ref(error.detail_ref.unwrap_or_else(|| "history".to_owned()))
            })
    }

    fn query_pack_events(
        &self,
        workspace_id: &str,
        before_sequence: Option<u64>,
        limit: u32,
        search: Option<String>,
    ) -> Result<Vec<(u64, ReviewPack)>, GitReviewError> {
        let page = self
            .service
            .timeline(WorkspaceTimelineRequest {
                workspace_id: workspace_id.to_owned(),
                before_sequence,
                limit: limit.clamp(1, 200),
                search: Some(search.unwrap_or_else(|| REVIEW_PACK_KIND.to_owned())),
            })
            .map_err(|error| GitReviewError::new(error.code, OPERATION, error.recoverable))?;
        let mut packs = Vec::new();
        for event in page.items {
            if event.producer != "git" || event.kind != REVIEW_PACK_KIND {
                continue;
            }
            let mut pack = serde_json::from_value::<ReviewPack>(event.payload)
                .map_err(|_| git_error("GIT-HISTORY-PACK-DECODE", OPERATION, false))?;
            pack.history_sequence = Some(event.sequence);
            packs.push((event.sequence, pack));
        }
        Ok(packs)
    }
}

impl GitReviewHistory for WorkspaceHistoryGitReviewStore {
    fn append_operation<'a>(&'a self, event: &'a OperationJournalEvent) -> HistoryFuture<'a, u64> {
        Box::pin(async move {
            let payload = serde_json::to_value(event)
                .map_err(|_| git_error("GIT-HISTORY-ENCODE", OPERATION, false))?;
            self.append_payload(
                format!("git-operation-{}-{:?}", event.operation_id, event.state).to_lowercase(),
                event.workspace_id.clone(),
                OPERATION_KIND,
                payload,
            )
            .await
        })
    }

    fn append_review_pack<'a>(&'a self, pack: &'a ReviewPack) -> HistoryFuture<'a, u64> {
        Box::pin(async move {
            let payload = serde_json::to_value(pack)
                .map_err(|_| git_error("GIT-HISTORY-ENCODE", OPERATION, false))?;
            self.append_payload(
                format!("git-pack-{}", pack.checkpoint.checkpoint_id),
                pack.workspace_id.clone(),
                REVIEW_PACK_KIND,
                payload,
            )
            .await
        })
    }

    fn get_review_pack<'a>(
        &'a self,
        workspace_id: &'a str,
        checkpoint_id: &'a str,
    ) -> HistoryFuture<'a, Option<ReviewPack>> {
        Box::pin(async move {
            let packs =
                self.query_pack_events(workspace_id, None, 200, Some(checkpoint_id.to_owned()))?;
            Ok(packs
                .into_iter()
                .map(|(_, pack)| pack)
                .find(|pack| pack.checkpoint.checkpoint_id == checkpoint_id))
        })
    }

    fn list_review_packs<'a>(
        &'a self,
        workspace_id: &'a str,
        before_sequence: Option<u64>,
        limit: u32,
    ) -> HistoryFuture<'a, ReviewPackPage> {
        Box::pin(async move {
            let limit = limit.clamp(1, 200);
            let mut packs = self.query_pack_events(
                workspace_id,
                before_sequence,
                limit.saturating_add(1),
                None,
            )?;
            packs.sort_by_key(|(sequence, _)| *sequence);
            packs.reverse();
            let has_more = packs.len() > limit as usize;
            packs.truncate(limit as usize);
            let next_before_sequence = has_more.then(|| packs.last().map(|item| item.0)).flatten();
            let items = packs
                .into_iter()
                .map(|(sequence, pack)| summary(sequence, &pack))
                .collect();
            Ok(ReviewPackPage {
                schema_version: GIT_REVIEW_SCHEMA_VERSION,
                items,
                next_before_sequence,
            })
        })
    }
}

#[cfg(test)]
#[derive(Clone, Default)]
pub(crate) struct MemoryGitReviewHistory {
    state: Arc<Mutex<MemoryState>>,
}

#[cfg(test)]
#[derive(Default)]
struct MemoryState {
    sequence: u64,
    operations: BTreeMap<String, (u64, OperationJournalEvent)>,
    packs: BTreeMap<String, (u64, ReviewPack)>,
}

#[cfg(test)]
impl MemoryGitReviewHistory {
    pub fn operations(&self) -> Vec<OperationJournalEvent> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .operations
            .values()
            .map(|(_, event)| event.clone())
            .collect()
    }
}

#[cfg(test)]
impl GitReviewHistory for MemoryGitReviewHistory {
    fn append_operation<'a>(&'a self, event: &'a OperationJournalEvent) -> HistoryFuture<'a, u64> {
        Box::pin(async move {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let key = format!("{}:{:?}", event.operation_id, event.state);
            if let Some((sequence, existing)) = state.operations.get(&key) {
                if existing == event {
                    return Ok(*sequence);
                }
                return Err(git_error("GIT-HISTORY-IDEMPOTENCY", OPERATION, false));
            }
            state.sequence = state.sequence.saturating_add(1);
            let sequence = state.sequence;
            state.operations.insert(key, (sequence, event.clone()));
            Ok(sequence)
        })
    }

    fn append_review_pack<'a>(&'a self, pack: &'a ReviewPack) -> HistoryFuture<'a, u64> {
        Box::pin(async move {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let key = pack.checkpoint.checkpoint_id.clone();
            if let Some((sequence, existing)) = state.packs.get(&key) {
                if existing.pack_digest == pack.pack_digest {
                    return Ok(*sequence);
                }
                return Err(git_error("GIT-HISTORY-IDEMPOTENCY", OPERATION, false));
            }
            state.sequence = state.sequence.saturating_add(1);
            let sequence = state.sequence;
            state.packs.insert(key, (sequence, pack.clone()));
            Ok(sequence)
        })
    }

    fn get_review_pack<'a>(
        &'a self,
        workspace_id: &'a str,
        checkpoint_id: &'a str,
    ) -> HistoryFuture<'a, Option<ReviewPack>> {
        Box::pin(async move {
            let state = self
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            Ok(state.packs.get(checkpoint_id).and_then(|(sequence, pack)| {
                (pack.workspace_id == workspace_id).then(|| {
                    let mut pack = pack.clone();
                    pack.history_sequence = Some(*sequence);
                    pack
                })
            }))
        })
    }

    fn list_review_packs<'a>(
        &'a self,
        workspace_id: &'a str,
        before_sequence: Option<u64>,
        limit: u32,
    ) -> HistoryFuture<'a, ReviewPackPage> {
        Box::pin(async move {
            let state = self
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let limit = limit.clamp(1, 200) as usize;
            let mut packs = state
                .packs
                .values()
                .filter(|(sequence, pack)| {
                    pack.workspace_id == workspace_id
                        && before_sequence.is_none_or(|before| *sequence < before)
                })
                .map(|(sequence, pack)| (*sequence, pack.clone()))
                .collect::<Vec<_>>();
            packs.sort_by_key(|(sequence, _)| *sequence);
            packs.reverse();
            let has_more = packs.len() > limit;
            packs.truncate(limit);
            let next_before_sequence = has_more.then(|| packs.last().map(|item| item.0)).flatten();
            let items = packs
                .into_iter()
                .map(|(sequence, pack)| summary(sequence, &pack))
                .collect();
            Ok(ReviewPackPage {
                schema_version: GIT_REVIEW_SCHEMA_VERSION,
                items,
                next_before_sequence,
            })
        })
    }
}

fn summary(sequence: u64, pack: &ReviewPack) -> ReviewPackSummary {
    ReviewPackSummary {
        checkpoint_id: pack.checkpoint.checkpoint_id.clone(),
        commit_sha: pack.checkpoint.commit_sha.clone(),
        work_unit_id: pack.work_unit_id.clone(),
        objective: pack.objective.clone(),
        operation_state: pack.operation_state,
        files_changed: pack.diff_summary.files_changed,
        verification_failures: pack
            .verification
            .iter()
            .filter(|evidence| evidence.result != super::types::VerificationResult::Passed)
            .count() as u64,
        unresolved_risks: pack.risks.iter().filter(|risk| !risk.resolved).count() as u64,
        created_at: pack.checkpoint.created_at.clone(),
        history_sequence: sequence,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git_review::types::{CheckpointIdentity, DiffSummary};

    fn pack() -> ReviewPack {
        ReviewPack {
            schema_version: GIT_REVIEW_SCHEMA_VERSION,
            checkpoint: CheckpointIdentity {
                checkpoint_id: "checkpoint-1".to_owned(),
                commit_sha: "a".repeat(40),
                parent_sha: "b".repeat(40),
                target_reference: "refs/heads/main".to_owned(),
                message: "feat: test\n\n- test".to_owned(),
                author_name: "Fixture".to_owned(),
                author_email: "fixture@example.invalid".to_owned(),
                created_at: "2026-07-18T00:00:00Z".to_owned(),
            },
            workspace_id: "workspace-1".to_owned(),
            work_unit_id: "work-1".to_owned(),
            objective: "objective".to_owned(),
            acceptance: vec!["accepted".to_owned()],
            gates: Vec::new(),
            manifest: Vec::new(),
            diff_summary: DiffSummary {
                files_changed: 1,
                additions: 1,
                deletions: 0,
                binary_files: 0,
                total_bytes: 1,
            },
            verification: Vec::new(),
            decisions: Vec::new(),
            failed_attempts: Vec::new(),
            risks: Vec::new(),
            restore_guidance: vec!["Create a revert commit.".to_owned()],
            operation_state: CheckpointOperationState::HistoryComplete,
            pack_digest: "sha256:fixture".to_owned(),
            history_sequence: None,
        }
    }

    #[tokio::test]
    async fn memory_history_accepts_exact_pack_replay_and_rejects_conflict() {
        let history = MemoryGitReviewHistory::default();
        let first = history.append_review_pack(&pack()).await.expect("append");
        let replay = history.append_review_pack(&pack()).await.expect("replay");
        assert_eq!(first, replay);
        let mut conflict = pack();
        conflict.pack_digest = "sha256:other".to_owned();
        assert_eq!(
            history
                .append_review_pack(&conflict)
                .await
                .expect_err("conflict")
                .code,
            "GIT-HISTORY-IDEMPOTENCY"
        );
    }
}
