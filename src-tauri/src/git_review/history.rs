//! Append-only persistence for read-only Git observations and commit evidence.

use std::future::Future;
use std::pin::Pin;

#[cfg(test)]
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};

use serde::Serialize;

use crate::workspace_history::types::{
    AppendDomainEventRequest, HistoryMode, WorkspaceTimelineRequest,
    WORKSPACE_HISTORY_SCHEMA_VERSION,
};
use crate::workspace_history::WorkspaceHistoryService;

use super::error::{git_error, GitReviewError};
use super::types::{CommitEvidenceDetail, GitObservation, WorkUnitGitObservation};

const OPERATION: &str = "persist_git_observation";
pub(crate) const OBSERVATION_KIND: &str = "git.observation.recorded";
pub(crate) const WORK_UNIT_KIND: &str = "git.work_unit.observed";
pub(crate) const COMMIT_EVIDENCE_KIND: &str = "git.commit_evidence.recorded";
const MAX_GIT_HISTORY_EVENT_BYTES: usize = 256 * 1024;
const MAX_GIT_HISTORY_LOOKUP: u32 = 1_000;

pub(crate) type HistoryFuture<'a, T> =
    Pin<Box<dyn Future<Output = Result<T, GitReviewError>> + Send + 'a>>;

pub(crate) trait GitReviewHistory: Send + Sync {
    fn append_observation<'a>(&'a self, observation: &'a GitObservation) -> HistoryFuture<'a, u64>;

    fn get_observation<'a>(
        &'a self,
        workspace_id: &'a str,
        observation_id: &'a str,
    ) -> HistoryFuture<'a, Option<GitObservation>>;

    fn append_work_unit<'a>(
        &'a self,
        observation: &'a WorkUnitGitObservation,
    ) -> HistoryFuture<'a, u64>;

    fn append_commit_evidence<'a>(
        &'a self,
        evidence: &'a CommitEvidenceDetail,
    ) -> HistoryFuture<'a, u64>;

    fn get_commit_evidence<'a>(
        &'a self,
        workspace_id: &'a str,
        commit_evidence_id: &'a str,
    ) -> HistoryFuture<'a, Option<CommitEvidenceDetail>>;

    fn list_commit_evidence<'a>(
        &'a self,
        workspace_id: &'a str,
        limit: u32,
    ) -> HistoryFuture<'a, Vec<CommitEvidenceDetail>>;
}

#[derive(Clone)]
pub(crate) struct WorkspaceHistoryGitReviewStore {
    service: WorkspaceHistoryService,
}

impl WorkspaceHistoryGitReviewStore {
    pub fn new(service: WorkspaceHistoryService) -> Self {
        Self { service }
    }

    async fn append<T: Serialize>(
        &self,
        event_id: String,
        workspace_id: String,
        kind: &'static str,
        occurred_at: String,
        payload: &T,
    ) -> Result<u64, GitReviewError> {
        if self.service.history_mode() != HistoryMode::Ready {
            return Err(git_error("GIT-HISTORY-NOT-WRITABLE", OPERATION, true));
        }
        let payload = serde_json::to_value(payload)
            .map_err(|_| git_error("GIT-HISTORY-ENCODE", OPERATION, false))?;
        let request = AppendDomainEventRequest {
            schema_version: WORKSPACE_HISTORY_SCHEMA_VERSION,
            event_id,
            workspace_id,
            session_id: None,
            producer: "git".to_owned(),
            kind: kind.to_owned(),
            occurred_at,
            payload,
        };
        let bytes = serde_json::to_vec(&request)
            .map_err(|_| git_error("GIT-HISTORY-ENCODE", OPERATION, false))?;
        if bytes.len() > MAX_GIT_HISTORY_EVENT_BYTES {
            return Err(git_error("GIT-HISTORY-EVENT-LIMIT", OPERATION, false));
        }
        self.service
            .append_domain_event(request)
            .await
            .map(|response| response.sequence)
            .map_err(|error| {
                GitReviewError::new(error.code, OPERATION, error.recoverable)
                    .with_detail_ref(error.detail_ref.unwrap_or_else(|| "history".to_owned()))
            })
    }

    fn query(
        &self,
        workspace_id: &str,
        kind: &'static str,
        limit: u32,
    ) -> Result<Vec<(u64, serde_json::Value)>, GitReviewError> {
        let target = limit.clamp(1, MAX_GIT_HISTORY_LOOKUP) as usize;
        let mut before_sequence = None;
        let mut scanned = 0_u32;
        let mut values = Vec::new();

        while values.len() < target && scanned < MAX_GIT_HISTORY_LOOKUP {
            let page_limit = 200.min(MAX_GIT_HISTORY_LOOKUP - scanned);
            let page = self
                .service
                .timeline(WorkspaceTimelineRequest {
                    workspace_id: workspace_id.to_owned(),
                    before_sequence,
                    limit: page_limit,
                    search: Some(kind.to_owned()),
                })
                .map_err(|error| GitReviewError::new(error.code, OPERATION, error.recoverable))?;
            scanned = scanned.saturating_add(page.items.len() as u32);
            values.extend(
                page.items
                    .into_iter()
                    .filter(|event| event.producer == "git" && event.kind == kind)
                    .map(|event| (event.sequence, event.payload)),
            );
            let Some(next) = page.next_before_sequence else {
                break;
            };
            if before_sequence == Some(next) {
                return Err(git_error("GIT-HISTORY-CURSOR", OPERATION, false));
            }
            before_sequence = Some(next);
        }

        values.sort_by_key(|(sequence, _)| std::cmp::Reverse(*sequence));
        values.truncate(target);
        Ok(values)
    }
}

impl GitReviewHistory for WorkspaceHistoryGitReviewStore {
    fn append_observation<'a>(&'a self, observation: &'a GitObservation) -> HistoryFuture<'a, u64> {
        Box::pin(async move {
            self.append(
                format!("git-observation-{}", observation.observation_id),
                observation.workspace_id.clone(),
                OBSERVATION_KIND,
                observation.captured_at.clone(),
                observation,
            )
            .await
        })
    }

    fn get_observation<'a>(
        &'a self,
        workspace_id: &'a str,
        observation_id: &'a str,
    ) -> HistoryFuture<'a, Option<GitObservation>> {
        Box::pin(async move {
            for (sequence, payload) in self.query(workspace_id, OBSERVATION_KIND, 200)? {
                let mut observation = serde_json::from_value::<GitObservation>(payload)
                    .map_err(|_| git_error("GIT-HISTORY-OBSERVATION-DECODE", OPERATION, false))?;
                if observation.observation_id == observation_id {
                    observation.history_sequence = Some(sequence);
                    return Ok(Some(observation));
                }
            }
            Ok(None)
        })
    }

    fn append_work_unit<'a>(
        &'a self,
        observation: &'a WorkUnitGitObservation,
    ) -> HistoryFuture<'a, u64> {
        Box::pin(async move {
            self.append(
                format!(
                    "git-work-unit-{}-{}",
                    observation.work_unit_id, observation.source_event_id
                ),
                observation.workspace_id.clone(),
                WORK_UNIT_KIND,
                observation.observed_at.clone(),
                observation,
            )
            .await
        })
    }

    fn append_commit_evidence<'a>(
        &'a self,
        evidence: &'a CommitEvidenceDetail,
    ) -> HistoryFuture<'a, u64> {
        Box::pin(async move {
            self.append(
                format!("git-evidence-{}", evidence.commit_evidence_id),
                evidence.workspace_id.clone(),
                COMMIT_EVIDENCE_KIND,
                evidence.observed_at.clone(),
                evidence,
            )
            .await
        })
    }

    fn get_commit_evidence<'a>(
        &'a self,
        workspace_id: &'a str,
        commit_evidence_id: &'a str,
    ) -> HistoryFuture<'a, Option<CommitEvidenceDetail>> {
        Box::pin(async move {
            for (sequence, payload) in
                self.query(workspace_id, COMMIT_EVIDENCE_KIND, MAX_GIT_HISTORY_LOOKUP)?
            {
                let mut evidence = serde_json::from_value::<CommitEvidenceDetail>(payload)
                    .map_err(|_| git_error("GIT-HISTORY-EVIDENCE-DECODE", OPERATION, false))?;
                if evidence.commit_evidence_id == commit_evidence_id {
                    evidence.history_sequence = Some(sequence);
                    return Ok(Some(evidence));
                }
            }
            Ok(None)
        })
    }

    fn list_commit_evidence<'a>(
        &'a self,
        workspace_id: &'a str,
        limit: u32,
    ) -> HistoryFuture<'a, Vec<CommitEvidenceDetail>> {
        Box::pin(async move {
            self.query(workspace_id, COMMIT_EVIDENCE_KIND, limit)?
                .into_iter()
                .map(|(sequence, payload)| {
                    let mut evidence = serde_json::from_value::<CommitEvidenceDetail>(payload)
                        .map_err(|_| git_error("GIT-HISTORY-EVIDENCE-DECODE", OPERATION, false))?;
                    evidence.history_sequence = Some(sequence);
                    Ok(evidence)
                })
                .collect()
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
    observations: BTreeMap<(String, String), (u64, GitObservation)>,
    work_units: BTreeMap<(String, String), (u64, WorkUnitGitObservation)>,
    evidence: BTreeMap<(String, String), (u64, CommitEvidenceDetail)>,
}

#[cfg(test)]
impl MemoryGitReviewHistory {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn commit_count(&self) -> usize {
        self.state.lock().expect("history state").evidence.len()
    }
}

#[cfg(test)]
impl GitReviewHistory for MemoryGitReviewHistory {
    fn append_observation<'a>(&'a self, observation: &'a GitObservation) -> HistoryFuture<'a, u64> {
        Box::pin(async move {
            let mut state = self.state.lock().expect("history state");
            let key = (
                observation.workspace_id.clone(),
                observation.observation_id.clone(),
            );
            if let Some((sequence, existing)) = state.observations.get(&key) {
                return if existing == observation {
                    Ok(*sequence)
                } else {
                    Err(git_error("GIT-HISTORY-EVENT-CONFLICT", OPERATION, false))
                };
            }
            state.sequence += 1;
            let sequence = state.sequence;
            state
                .observations
                .insert(key, (sequence, observation.clone()));
            Ok(sequence)
        })
    }

    fn get_observation<'a>(
        &'a self,
        workspace_id: &'a str,
        observation_id: &'a str,
    ) -> HistoryFuture<'a, Option<GitObservation>> {
        Box::pin(async move {
            Ok(self
                .state
                .lock()
                .expect("history state")
                .observations
                .get(&(workspace_id.to_owned(), observation_id.to_owned()))
                .map(|(sequence, observation)| {
                    let mut observation = observation.clone();
                    observation.history_sequence = Some(*sequence);
                    observation
                }))
        })
    }

    fn append_work_unit<'a>(
        &'a self,
        observation: &'a WorkUnitGitObservation,
    ) -> HistoryFuture<'a, u64> {
        Box::pin(async move {
            let mut state = self.state.lock().expect("history state");
            let key = (
                observation.workspace_id.clone(),
                observation.source_event_id.clone(),
            );
            if let Some((sequence, existing)) = state.work_units.get(&key) {
                return if existing == observation {
                    Ok(*sequence)
                } else {
                    Err(git_error("GIT-HISTORY-EVENT-CONFLICT", OPERATION, false))
                };
            }
            state.sequence += 1;
            let sequence = state.sequence;
            state
                .work_units
                .insert(key, (sequence, observation.clone()));
            Ok(sequence)
        })
    }

    fn append_commit_evidence<'a>(
        &'a self,
        evidence: &'a CommitEvidenceDetail,
    ) -> HistoryFuture<'a, u64> {
        Box::pin(async move {
            let mut state = self.state.lock().expect("history state");
            let key = (
                evidence.workspace_id.clone(),
                evidence.commit_evidence_id.clone(),
            );
            if let Some((sequence, existing)) = state.evidence.get(&key) {
                return if existing == evidence {
                    Ok(*sequence)
                } else {
                    Err(git_error("GIT-HISTORY-EVENT-CONFLICT", OPERATION, false))
                };
            }
            state.sequence += 1;
            let sequence = state.sequence;
            state.evidence.insert(key, (sequence, evidence.clone()));
            Ok(sequence)
        })
    }

    fn get_commit_evidence<'a>(
        &'a self,
        workspace_id: &'a str,
        commit_evidence_id: &'a str,
    ) -> HistoryFuture<'a, Option<CommitEvidenceDetail>> {
        Box::pin(async move {
            Ok(self
                .state
                .lock()
                .expect("history state")
                .evidence
                .get(&(workspace_id.to_owned(), commit_evidence_id.to_owned()))
                .map(|(sequence, evidence)| {
                    let mut evidence = evidence.clone();
                    evidence.history_sequence = Some(*sequence);
                    evidence
                }))
        })
    }

    fn list_commit_evidence<'a>(
        &'a self,
        workspace_id: &'a str,
        limit: u32,
    ) -> HistoryFuture<'a, Vec<CommitEvidenceDetail>> {
        Box::pin(async move {
            let mut values = self
                .state
                .lock()
                .expect("history state")
                .evidence
                .iter()
                .filter(|((workspace, _), _)| workspace == workspace_id)
                .map(|(_, (sequence, evidence))| {
                    let mut evidence = evidence.clone();
                    evidence.history_sequence = Some(*sequence);
                    evidence
                })
                .collect::<Vec<_>>();
            values.sort_by_key(|evidence| std::cmp::Reverse(evidence.history_sequence));
            values.truncate(limit as usize);
            Ok(values)
        })
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::process::Command;

    use crate::codex::supervisor::CodexSupervisor;
    use crate::codex::workspace::WorkspaceService;
    use crate::workspace_history::store::WorkspaceHistoryStore;

    use super::*;
    use crate::git_review::types::{
        CommitIdentity, CommitProducer, DiffSummary, GateKind, GateOutcome, GateResult,
        GIT_REVIEW_SCHEMA_VERSION,
    };

    fn temp_directory(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "coding-wife-git-history-{label}-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&path).expect("temporary directory");
        path
    }

    fn git_repository() -> PathBuf {
        let root = temp_directory("repository");
        let status = Command::new("/usr/bin/git")
            .args(["init", "-q", "-b", "main"])
            .arg(&root)
            .status()
            .expect("git init");
        assert!(status.success());
        root
    }

    fn external_evidence(workspace_id: &str, index: usize) -> CommitEvidenceDetail {
        let sha = format!("{:040x}", index + 1);
        CommitEvidenceDetail {
            schema_version: GIT_REVIEW_SCHEMA_VERSION,
            commit_evidence_id: format!("commit-{sha}"),
            workspace_id: workspace_id.to_owned(),
            producer: CommitProducer::ExternalUncorrelated,
            identity: CommitIdentity {
                commit_sha: sha,
                subject: format!("chore: history fixture {index}"),
                body: String::new(),
                author_name: "Fixture".to_owned(),
                author_email: "fixture@example.invalid".to_owned(),
                authored_at: "2026-07-18T00:00:00Z".to_owned(),
                committed_at: "2026-07-18T00:00:00Z".to_owned(),
                parents: Vec::new(),
            },
            work_unit_id: None,
            objective: None,
            acceptance: Vec::new(),
            before_observation_id: None,
            after_observation_id: None,
            source_event_id: None,
            gates: [
                GateKind::Scope,
                GateKind::Ownership,
                GateKind::Verification,
                GateKind::Risk,
            ]
            .into_iter()
            .map(|gate| GateResult {
                gate,
                outcome: GateOutcome::Unknown,
                reason_codes: vec!["not_correlated".to_owned()],
                evidence_ids: Vec::new(),
            })
            .collect(),
            files: Vec::new(),
            diff_summary: DiffSummary {
                files_changed: 0,
                additions: 0,
                deletions: 0,
                binary_files: 0,
            },
            verification: Vec::new(),
            decisions: Vec::new(),
            failed_attempts: Vec::new(),
            risks: Vec::new(),
            commit_skill_injection: None,
            observed_at: "2026-07-18T00:00:00Z".to_owned(),
            history_sequence: None,
        }
    }

    async fn register_workspace(store: &WorkspaceHistoryStore, root: &Path) -> String {
        let workspace = WorkspaceService::production(CodexSupervisor::new());
        let candidate = workspace
            .validate_workspace_root(
                root.to_path_buf(),
                format!("workspace-{}", uuid::Uuid::new_v4()),
                "Git history fixture".to_owned(),
            )
            .await
            .expect("validated workspace");
        store
            .register_candidate(&candidate)
            .expect("registered workspace")
            .workspace
            .workspace_id
    }

    #[tokio::test]
    async fn exact_commit_lookup_traverses_one_thousand_history_events() {
        let data = temp_directory("data");
        let root = git_repository();
        let store = WorkspaceHistoryStore::open(&data).expect("history store");
        let workspace_id = register_workspace(&store, &root).await;
        let service = WorkspaceHistoryService::new(
            store,
            WorkspaceService::production(CodexSupervisor::new()),
        );
        let history = WorkspaceHistoryGitReviewStore::new(service);
        let oldest = external_evidence(&workspace_id, 0);

        for index in 0..1_000 {
            history
                .append_commit_evidence(&external_evidence(&workspace_id, index))
                .await
                .expect("append commit evidence");
        }

        let found = history
            .get_commit_evidence(&workspace_id, &oldest.commit_evidence_id)
            .await
            .expect("history lookup")
            .expect("oldest evidence");
        assert_eq!(found.identity.commit_sha, oldest.identity.commit_sha);

        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(data);
    }
}
