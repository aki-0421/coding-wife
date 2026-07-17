use serde::{Deserialize, Serialize};

/// The current app-server contract cannot prove a tool-free, cwd-free support root.
/// Keep capacity at zero until that isolation is both available and release-audited.
pub const SUPPORT_SESSION_CAPACITY: usize = 0;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SupportFallbackRole {
    Presence,
    Narration,
    DecisionExplainer,
    CheckpointReviewer,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SupportFallback {
    pub schema_version: u16,
    pub role: SupportFallbackRole,
    pub source_event_id: String,
    pub generation: u64,
    pub summary_key: String,
    pub status: String,
    pub reason_code: String,
    pub active_sessions: usize,
    pub queued_sessions: usize,
}

pub fn support_sessions_can_start() -> bool {
    false
}

pub fn deterministic_fallback(
    role: SupportFallbackRole,
    source_event_id: impl Into<String>,
    generation: u64,
) -> SupportFallback {
    let summary_key = match role {
        SupportFallbackRole::Presence => "support.fallback.presence",
        SupportFallbackRole::Narration => "support.fallback.narration",
        SupportFallbackRole::DecisionExplainer => "support.fallback.decision",
        SupportFallbackRole::CheckpointReviewer => "support.fallback.checkpoint",
    };
    SupportFallback {
        schema_version: 1,
        role,
        source_event_id: source_event_id.into(),
        generation,
        summary_key: summary_key.to_owned(),
        status: "fallback".to_owned(),
        reason_code: "support_isolation_unavailable".to_owned(),
        active_sessions: 0,
        queued_sessions: 0,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        deterministic_fallback, support_sessions_can_start, SupportFallbackRole,
        SUPPORT_SESSION_CAPACITY,
    };

    #[test]
    fn unavailable_isolation_never_starts_a_support_session() {
        assert_eq!(SUPPORT_SESSION_CAPACITY, 0);
        assert!(!support_sessions_can_start());
    }

    #[test]
    fn fallback_is_deterministic_and_contains_no_generated_content() {
        let first = deterministic_fallback(SupportFallbackRole::DecisionExplainer, "event-1", 7);
        let second = deterministic_fallback(SupportFallbackRole::DecisionExplainer, "event-1", 7);
        assert_eq!(first, second);
        assert_eq!(first.summary_key, "support.fallback.decision");
        assert_eq!(first.active_sessions, 0);
        assert_eq!(first.queued_sessions, 0);
        assert_eq!(first.reason_code, "support_isolation_unavailable");
    }
}
