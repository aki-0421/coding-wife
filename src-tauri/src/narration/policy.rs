use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use regex::Regex;

use super::types::{
    NarrationPriority, NarrationScopeRequestV1, NarrationSemanticType, NarrationSpeakRequestV1,
    NARRATION_MAX_TEXT_SCALARS, NARRATION_SCHEMA_VERSION,
};

const DEDUPE_WINDOW: Duration = Duration::from_secs(30);
const MINIMUM_START_INTERVAL: Duration = Duration::from_secs(8);
const START_WINDOW: Duration = Duration::from_secs(60);
const MAX_STARTS_PER_WINDOW: usize = 6;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ValidatedNarration {
    pub text: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum PolicyRejection {
    InvalidSchema,
    InvalidIdentifier,
    UnsafeText,
    Stale,
    Sequence,
    Duplicate,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct SequenceKey {
    workspace_id: String,
    generation: u64,
    request_id: String,
}

#[derive(Clone, Debug)]
struct DedupeEntry {
    semantic_type: NarrationSemanticType,
    normalized_text: String,
    observed_at: Instant,
}

#[derive(Debug, Default)]
pub(crate) struct NarrationPolicy {
    scope: Option<NarrationScopeRequestV1>,
    sequences: HashMap<SequenceKey, u64>,
    canceled_requests: HashSet<SequenceKey>,
    dedupe: VecDeque<DedupeEntry>,
    starts: VecDeque<Instant>,
}

impl NarrationPolicy {
    pub fn set_scope(&mut self, scope: NarrationScopeRequestV1) -> bool {
        let changed = self.scope.as_ref() != Some(&scope);
        if changed {
            self.scope = Some(scope);
            self.sequences.clear();
            self.canceled_requests.clear();
            self.dedupe.clear();
        }
        changed
    }

    pub fn validate_and_record(
        &mut self,
        request: &NarrationSpeakRequestV1,
        now: Instant,
    ) -> Result<ValidatedNarration, PolicyRejection> {
        if request.schema_version != NARRATION_SCHEMA_VERSION {
            return Err(PolicyRejection::InvalidSchema);
        }
        if !is_opaque_identifier(&request.request_id)
            || !is_opaque_identifier(&request.workspace_id)
        {
            return Err(PolicyRejection::InvalidIdentifier);
        }
        let scope = self.scope.as_ref().ok_or(PolicyRejection::Stale)?;
        if scope.schema_version != NARRATION_SCHEMA_VERSION
            || scope.workspace_id != request.workspace_id
            || scope.generation != request.generation
        {
            return Err(PolicyRejection::Stale);
        }
        validate_redacted_text(&request.text)?;

        let sequence_key = SequenceKey {
            workspace_id: request.workspace_id.clone(),
            generation: request.generation,
            request_id: request.request_id.clone(),
        };
        if self.canceled_requests.contains(&sequence_key) {
            return Err(PolicyRejection::Stale);
        }
        match self.sequences.get(&sequence_key) {
            Some(previous) if request.sequence == previous.saturating_add(1) => {}
            None if request.sequence == 0 => {}
            _ => return Err(PolicyRejection::Sequence),
        }

        while self
            .dedupe
            .front()
            .is_some_and(|entry| now.saturating_duration_since(entry.observed_at) >= DEDUPE_WINDOW)
        {
            self.dedupe.pop_front();
        }
        let normalized_text = normalize_text(&request.text);
        if self.dedupe.iter().any(|entry| {
            entry.semantic_type == request.semantic_type && entry.normalized_text == normalized_text
        }) {
            return Err(PolicyRejection::Duplicate);
        }

        self.sequences.insert(sequence_key, request.sequence);
        self.dedupe.push_back(DedupeEntry {
            semantic_type: request.semantic_type,
            normalized_text,
            observed_at: now,
        });
        Ok(ValidatedNarration {
            text: request.text.clone(),
        })
    }

    pub fn delay_before_start(&mut self, priority: NarrationPriority, now: Instant) -> Duration {
        while self
            .starts
            .front()
            .is_some_and(|started| now.saturating_duration_since(*started) >= START_WINDOW)
        {
            self.starts.pop_front();
        }
        if priority == NarrationPriority::High {
            return Duration::ZERO;
        }
        let interval_delay = self.starts.back().map_or(Duration::ZERO, |started| {
            MINIMUM_START_INTERVAL.saturating_sub(now.saturating_duration_since(*started))
        });
        let window_delay = if self.starts.len() >= MAX_STARTS_PER_WINDOW {
            self.starts.front().map_or(Duration::ZERO, |started| {
                START_WINDOW.saturating_sub(now.saturating_duration_since(*started))
            })
        } else {
            Duration::ZERO
        };
        interval_delay.max(window_delay)
    }

    pub fn record_start(&mut self, now: Instant) {
        self.starts.push_back(now);
    }

    pub fn cancel_request(&mut self, workspace_id: &str, generation: u64, request_id: &str) {
        self.canceled_requests.insert(SequenceKey {
            workspace_id: workspace_id.to_owned(),
            generation,
            request_id: request_id.to_owned(),
        });
    }
}

fn validate_redacted_text(text: &str) -> Result<(), PolicyRejection> {
    let scalar_count = text.chars().count();
    if !(1..=NARRATION_MAX_TEXT_SCALARS).contains(&scalar_count)
        || text.trim() != text
        || text.chars().any(|character| {
            character == '\0' || (character.is_control() && character != '\n' && character != '\t')
        })
        || secret_pattern().is_match(text)
        || private_path_pattern().is_match(text)
    {
        return Err(PolicyRejection::UnsafeText);
    }
    Ok(())
}

fn secret_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(
            r"(?i)(?:sk-[a-z0-9_-]{8,}|(?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*\S+)",
        )
        .expect("narration secret pattern")
    })
}

fn private_path_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"(?:^|\s)/(?:Users|home|private|tmp|var|Volumes)/\S+")
            .expect("narration path pattern")
    })
}

fn normalize_text(text: &str) -> String {
    text.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn is_opaque_identifier(value: &str) -> bool {
    (1..=128).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b':'))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::narration::types::{NarrationKind, NarrationLocale};

    fn request(text: &str, sequence: u64) -> NarrationSpeakRequestV1 {
        NarrationSpeakRequestV1 {
            schema_version: NARRATION_SCHEMA_VERSION,
            request_id: "request-1".to_owned(),
            workspace_id: "workspace-1".to_owned(),
            generation: 7,
            sequence,
            locale: NarrationLocale::Ja,
            kind: NarrationKind::CommitExplanation,
            semantic_type: NarrationSemanticType::CommitExplanation,
            priority: NarrationPriority::Normal,
            text: text.to_owned(),
        }
    }

    fn policy() -> NarrationPolicy {
        let mut policy = NarrationPolicy::default();
        policy.set_scope(NarrationScopeRequestV1 {
            schema_version: NARRATION_SCHEMA_VERSION,
            workspace_id: "workspace-1".to_owned(),
            generation: 7,
        });
        policy
    }

    #[test]
    fn accepts_exact_sequences_and_rejects_duplicates_and_gaps() {
        let now = Instant::now();
        let mut policy = policy();
        assert!(policy
            .validate_and_record(&request("最初の説明です", 0), now)
            .is_ok());
        assert_eq!(
            policy.validate_and_record(&request("最初の説明です", 1), now),
            Err(PolicyRejection::Duplicate)
        );
        assert_eq!(
            policy.validate_and_record(&request("三番目の説明です", 2), now),
            Err(PolicyRejection::Sequence)
        );
        assert!(policy
            .validate_and_record(&request("次の説明です", 1), now)
            .is_ok());
    }

    #[test]
    fn rejects_secret_path_and_stale_scope_text() {
        let now = Instant::now();
        for text in [
            "api_key=unsafe-value",
            "Open /Users/example/private.txt",
            "sk-1234567890abcdef",
        ] {
            assert_eq!(
                policy().validate_and_record(&request(text, 0), now),
                Err(PolicyRejection::UnsafeText)
            );
        }
        let mut stale = request("安全な説明です", 0);
        stale.generation = 8;
        assert_eq!(
            policy().validate_and_record(&stale, now),
            Err(PolicyRejection::Stale)
        );
    }

    #[test]
    fn delays_normal_bursts_but_never_delays_high_priority() {
        let now = Instant::now();
        let mut policy = policy();
        policy.record_start(now);
        assert_eq!(
            policy.delay_before_start(NarrationPriority::Normal, now),
            MINIMUM_START_INTERVAL
        );
        assert_eq!(
            policy.delay_before_start(NarrationPriority::High, now),
            Duration::ZERO
        );
    }
}
