use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use regex::Regex;
use url::{Host, Url};

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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ScopeRejection {
    Rollback,
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
    scope_generation_high_water: HashMap<String, u64>,
    sequences: HashMap<SequenceKey, u64>,
    canceled_requests: HashSet<SequenceKey>,
    dedupe: VecDeque<DedupeEntry>,
    starts: VecDeque<Instant>,
}

impl NarrationPolicy {
    pub fn set_scope(&mut self, scope: NarrationScopeRequestV1) -> Result<bool, ScopeRejection> {
        if self
            .scope_generation_high_water
            .get(&scope.workspace_id)
            .is_some_and(|generation| scope.generation < *generation)
        {
            return Err(ScopeRejection::Rollback);
        }
        self.scope_generation_high_water
            .insert(scope.workspace_id.clone(), scope.generation);
        let changed = self.scope.as_ref() != Some(&scope);
        if changed {
            self.scope = Some(scope);
            self.sequences.clear();
            self.canceled_requests.clear();
            self.dedupe.clear();
        }
        Ok(changed)
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
    let characters = text
        .chars()
        .take(NARRATION_MAX_TEXT_SCALARS + 1)
        .collect::<Vec<_>>();
    let scalar_count = characters.len();
    if !(1..=NARRATION_MAX_TEXT_SCALARS).contains(&scalar_count)
        || text.trim() != text
        || characters.iter().any(|character| {
            *character == '\0'
                || (character.is_control() && *character != '\n' && *character != '\t')
        })
        || secret_pattern().is_match(text)
        || contains_private_absolute_path(&characters)
    {
        return Err(PolicyRejection::UnsafeText);
    }
    Ok(())
}

fn secret_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(
            r#"(?i)(?:sk-[a-z0-9_-]{8,}|\bbearer\s+[a-z0-9._~+/-]{12,}=*|\b(?:gh[pousr]_[a-z0-9]{16,}|github_pat_[a-z0-9_]{16,})|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bxox[baprs]-[a-z0-9-]{10,}|-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----|(?:^|[^a-z0-9])(?:[a-z0-9]+[_-])*(?:api[_-]?key|access[_-]?token|auth[_-]?token|token|password|passwd|secret|client[_-]?secret|aws[_-]?secret[_-]?access[_-]?key|aws[_-]?session[_-]?token|cookie|session(?:[_-]?id)?)\s*[:=]\s*["']?\S+)"#,
        )
        .expect("narration secret pattern")
    })
}

fn unicode_whitespace_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r"^\p{White_Space}$").expect("Unicode whitespace pattern"))
}

fn unicode_path_boundary_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"^(?:\p{White_Space}|\p{P}|\p{S})$").expect("Unicode path boundary pattern")
    })
}

fn matches_character(pattern: &Regex, character: char) -> bool {
    let mut buffer = [0_u8; 4];
    pattern.is_match(character.encode_utf8(&mut buffer))
}

fn is_unicode_whitespace(character: char) -> bool {
    matches_character(unicode_whitespace_pattern(), character)
}

fn is_unicode_path_boundary(character: char) -> bool {
    matches_character(unicode_path_boundary_pattern(), character)
}

fn matches_ascii_case_insensitive(characters: &[char], start: usize, expected: &str) -> bool {
    expected.chars().enumerate().all(|(offset, expected)| {
        characters
            .get(start + offset)
            .is_some_and(|actual| actual.eq_ignore_ascii_case(&expected))
    })
}

fn public_url_scheme_length(characters: &[char], start: usize) -> Option<usize> {
    if matches_ascii_case_insensitive(characters, start, "https://") {
        Some(8)
    } else if matches_ascii_case_insensitive(characters, start, "http://") {
        Some(7)
    } else {
        None
    }
}

fn matching_url_quote_terminator(previous: Option<char>) -> Option<char> {
    match previous {
        Some(character @ ('"' | '\'' | '`')) => Some(character),
        Some('“') => Some('”'),
        Some('‘') => Some('’'),
        Some('«') => Some('»'),
        Some('「') => Some('」'),
        Some('『') => Some('』'),
        _ => None,
    }
}

fn is_url_wrapper_terminator(character: char) -> bool {
    matches!(
        character,
        '"' | '`' | '<' | '>' | '）' | '】' | '〉' | '》' | '」' | '』' | '”' | '’' | '»'
    )
}

fn public_url_candidate_end(characters: &[char], start: usize) -> usize {
    let quote_terminator =
        matching_url_quote_terminator(start.checked_sub(1).map(|index| characters[index]));
    let mut parentheses = 0_usize;
    let mut brackets = 0_usize;
    let mut braces = 0_usize;
    let mut cursor = start;
    while let Some(character) = characters.get(cursor).copied() {
        if is_unicode_whitespace(character) {
            return cursor;
        }
        if cursor > start
            && (quote_terminator == Some(character) || is_url_wrapper_terminator(character))
        {
            return cursor;
        }
        match character {
            '(' => parentheses += 1,
            ')' if parentheses == 0 => return cursor,
            ')' => parentheses -= 1,
            '[' => brackets += 1,
            ']' if brackets == 0 => return cursor,
            ']' => brackets -= 1,
            '{' => braces += 1,
            '}' if braces == 0 => return cursor,
            '}' => braces -= 1,
            _ => {}
        }
        cursor += 1;
    }
    characters.len()
}

fn raw_url_authority(candidate: &str, scheme_length: usize) -> &str {
    let authority = &candidate[scheme_length..];
    let authority_end = authority
        .find(|character| matches!(character, '/' | '?' | '#'))
        .unwrap_or(authority.len());
    &authority[..authority_end]
}

fn is_valid_dns_domain(domain: &str) -> bool {
    let domain = domain.strip_suffix('.').unwrap_or(domain);
    !domain.is_empty()
        && domain.len() <= 253
        && domain.split('.').all(|label| {
            (1..=63).contains(&label.len())
                && label
                    .as_bytes()
                    .first()
                    .is_some_and(u8::is_ascii_alphanumeric)
                && label
                    .as_bytes()
                    .last()
                    .is_some_and(u8::is_ascii_alphanumeric)
                && label
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        })
}

fn is_valid_public_host(parsed: &Url) -> bool {
    match parsed.host() {
        Some(Host::Domain(domain)) => is_valid_dns_domain(domain),
        Some(Host::Ipv4(_) | Host::Ipv6(_)) => true,
        None => false,
    }
}

fn is_public_url_candidate(candidate: &str, scheme_length: usize) -> bool {
    let Ok(parsed) = Url::parse(candidate) else {
        return false;
    };
    let raw_authority = raw_url_authority(candidate, scheme_length);
    matches!(parsed.scheme(), "http" | "https")
        && !raw_authority.is_empty()
        && !raw_authority.contains('@')
        && is_valid_public_host(&parsed)
        && parsed.username().is_empty()
        && parsed.password().is_none_or(str::is_empty)
}

fn public_url_candidate_span(characters: &[char], start: usize) -> Option<(usize, bool)> {
    if start != 0
        && !characters
            .get(start.wrapping_sub(1))
            .is_some_and(|character| is_unicode_path_boundary(*character))
    {
        return None;
    }

    let scheme_length = public_url_scheme_length(characters, start)?;
    let end = public_url_candidate_end(characters, start);
    let candidate = characters[start..end].iter().collect::<String>();
    Some((end, is_public_url_candidate(&candidate, scheme_length)))
}

fn find_public_url_mask(characters: &[char]) -> Vec<bool> {
    let mut mask = vec![false; characters.len()];
    let mut cursor = 0;
    while cursor < characters.len() {
        let Some((end, safe)) = public_url_candidate_span(characters, cursor) else {
            cursor += 1;
            continue;
        };
        if safe {
            mask[cursor..end].fill(true);
        }
        cursor = end;
    }
    mask
}

fn contains_private_absolute_path(characters: &[char]) -> bool {
    let public_url_mask = find_public_url_mask(characters);
    characters.iter().enumerate().any(|(index, character)| {
        if *character != '/' || public_url_mask[index] {
            return false;
        }
        let Some(next) = characters.get(index + 1) else {
            return false;
        };
        if is_unicode_whitespace(*next) {
            return false;
        }
        index == 0 || is_unicode_path_boundary(characters[index - 1])
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
    use serde::Deserialize;

    #[derive(Debug, Deserialize)]
    #[serde(deny_unknown_fields, rename_all = "camelCase")]
    struct RedactionFixture {
        schema_version: u16,
        safe: Vec<RedactionCase>,
        private: Vec<RedactionCase>,
    }

    #[derive(Debug, Deserialize)]
    #[serde(deny_unknown_fields)]
    struct RedactionCase {
        name: String,
        text: String,
    }

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
        policy
            .set_scope(NarrationScopeRequestV1 {
                schema_version: NARRATION_SCHEMA_VERSION,
                workspace_id: "workspace-1".to_owned(),
                generation: 7,
            })
            .expect("initial scope");
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
    fn preserves_the_highest_generation_when_scope_rolls_back() {
        let now = Instant::now();
        let mut policy = policy();
        policy
            .set_scope(NarrationScopeRequestV1 {
                schema_version: NARRATION_SCHEMA_VERSION,
                workspace_id: "workspace-1".to_owned(),
                generation: 8,
            })
            .expect("advance scope");
        assert_eq!(
            policy.set_scope(NarrationScopeRequestV1 {
                schema_version: NARRATION_SCHEMA_VERSION,
                workspace_id: "workspace-1".to_owned(),
                generation: 7,
            }),
            Err(ScopeRejection::Rollback)
        );
        let mut current = request("現在の世代です", 0);
        current.generation = 8;

        assert!(policy.validate_and_record(&current, now).is_ok());
    }

    #[test]
    fn matches_shared_redaction_parity_fixture() {
        let fixture: RedactionFixture = serde_json::from_str(include_str!(
            "../../../src/test/fixtures/narration-redaction.v1.json"
        ))
        .expect("narration redaction fixture");
        assert_eq!(fixture.schema_version, NARRATION_SCHEMA_VERSION);
        for case in fixture.safe {
            assert!(
                validate_redacted_text(&case.text).is_ok(),
                "safe fixture rejected: {}",
                case.name
            );
        }
        for case in fixture.private {
            assert_eq!(
                validate_redacted_text(&case.text),
                Err(PolicyRejection::UnsafeText),
                "private fixture accepted: {}",
                case.name
            );
        }
    }

    #[test]
    fn keeps_redaction_scanning_inside_the_scalar_size_boundary() {
        let safe_at_limit = "a".repeat(NARRATION_MAX_TEXT_SCALARS);
        let multibyte_at_limit = "🦀".repeat(NARRATION_MAX_TEXT_SCALARS);
        let private_at_limit = format!("{} /x", "a".repeat(NARRATION_MAX_TEXT_SCALARS - 3));
        let over_limit = "a".repeat(NARRATION_MAX_TEXT_SCALARS + 1);
        let far_over_limit = "a".repeat(NARRATION_MAX_TEXT_SCALARS * 1_000);

        assert_eq!(safe_at_limit.chars().count(), NARRATION_MAX_TEXT_SCALARS);
        assert_eq!(
            multibyte_at_limit.chars().count(),
            NARRATION_MAX_TEXT_SCALARS
        );
        assert_eq!(private_at_limit.chars().count(), NARRATION_MAX_TEXT_SCALARS);
        for text in [safe_at_limit, multibyte_at_limit] {
            assert_eq!(validate_redacted_text(&text), Ok(()));
        }
        for text in [private_at_limit, over_limit, far_over_limit] {
            assert_eq!(
                validate_redacted_text(&text),
                Err(PolicyRejection::UnsafeText)
            );
        }
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
