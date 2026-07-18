//! Fail-closed validation for the only Git payload allowed into isolated support.

use std::sync::OnceLock;

use regex::Regex;
use serde::Serialize;
use serde_json::Value;

use super::error::{git_error, GitReviewError};
use super::types::{CommitEvidenceV1, MAX_COMMIT_EVIDENCE_PAYLOAD_BYTES};

const OPERATION: &str = "prepare_commit_explanation_evidence";

fn absolute_path_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(
            r#"(?i)(?:^|[\s=:'"(,\[<{])(?:/(?:[a-z0-9_~.+@%{}$-]+)){2,}|(?:^|[\s=:'"(,\[<{])[a-z]:\\(?:[^\\\s]+\\)+[^\\\s]+"#,
        )
        .expect("absolute path scanner regex")
    })
}

fn tokenized_path_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(
            r#"(?i)(?:<workspace>|<path>|\[redacted\])|(?:~|\$home|\$\{home\}|%userprofile%)[\\/]"#,
        )
        .expect("tokenized path scanner regex")
    })
}

fn relative_path_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(
            r#"(?i)(?:^|[\s=:'"(,\[<{])(?:(?:\.\.?)[\\/][^\s,'")\]>}]+|(?:src(?:-tauri)?|docs|tests?|packages?|apps?|scripts?|public|assets?|config|crates?|\.github|node_modules|target)[\\/][^\s,'")\]>}]+|(?:[a-z0-9_.@+-]+[\\/])+(?:[a-z0-9_.@+-]+\.[a-z0-9]{1,16}))"#,
        )
        .expect("relative path scanner regex")
    })
}

fn credential_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(
            r#"(?ix)
            \bbearer\s+[a-z0-9._~+/=-]{6,}
            |\b(?:authorization|api[ _-]?key|access[ _-]?(?:key|token)|refresh[ _-]?token|id[ _-]?token|token|password|passwd|secret|client[ _-]?secret|private[ _-]?key|auth[ _-]?cookie|cookie|set-cookie|session[ _-]?id|sessionid)\b\s*[:=]\s*[^\s,;]{3,}
            |\b(?:gh[pousr]_[a-z0-9]{8,}|github_pat_[a-z0-9_]{8,})\b
            |\b(?:akia|asia)[a-z0-9]{16}\b
            |\bxox[baprs]-[a-z0-9-]{10,}\b
            |\b(?:sk|sess|rk|pk)-[a-z0-9_-]{12,}\b
            |-----begin(?:\x20[a-z0-9]+)*\x20private\x20key-----
            "#,
        )
        .expect("credential scanner regex")
    })
}

pub(crate) fn contains_private_public_string(value: &str) -> bool {
    absolute_path_pattern().is_match(value)
        || tokenized_path_pattern().is_match(value)
        || relative_path_pattern().is_match(value)
        || credential_pattern().is_match(value)
        || value.to_ascii_lowercase().contains("chain-of-thought")
}

pub(crate) fn contains_private_public_material(value: &Value) -> bool {
    match value {
        Value::String(value) => contains_private_public_string(value),
        Value::Array(values) => values.iter().any(contains_private_public_material),
        Value::Object(values) => values.values().any(contains_private_public_material),
        Value::Null | Value::Bool(_) | Value::Number(_) => false,
    }
}

fn validate_serialized_public_payload<T: Serialize>(value: &T) -> Result<(), GitReviewError> {
    let value = serde_json::to_value(value)
        .map_err(|_| git_error("GIT-EXPLANATION-EVIDENCE-ENCODE", OPERATION, false))?;
    let bytes = serde_json::to_vec(&value)
        .map_err(|_| git_error("GIT-EXPLANATION-EVIDENCE-ENCODE", OPERATION, false))?;
    if bytes.len() > MAX_COMMIT_EVIDENCE_PAYLOAD_BYTES {
        return Err(git_error(
            "GIT-EXPLANATION-EVIDENCE-LIMIT",
            OPERATION,
            false,
        ));
    }
    if contains_private_public_material(&value) {
        return Err(git_error(
            "GIT-EXPLANATION-PRIVATE-MATERIAL",
            OPERATION,
            false,
        ));
    }
    Ok(())
}

pub(crate) fn validate_commit_evidence_payload(
    evidence: &CommitEvidenceV1,
) -> Result<(), GitReviewError> {
    validate_serialized_public_payload(evidence)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn rejects_paths_tokens_and_credentials_at_any_string_depth() {
        for private in [
            "src/private.ts",
            "./src/private.ts",
            "../private/config.json",
            "/\u{0055}sers/alice/repository/private.ts",
            "C:\\\u{0055}sers\\alice\\private.ts",
            "<workspace>/src/private.ts",
            "~/private/config.json",
            "Bearer abcdefghijklmnop",
            "token=credential-value",
            "ghp_abcdefghijklmnopqrstuvwxyz123456",
            "github_pat_abcdefghijklmnopqrstuvwxyz",
            "AKIAABCDEFGHIJKLMNOP",
            "xoxb-1234567890-abcdefghijkl",
            "-----BEGIN PRIVATE KEY-----",
        ] {
            let value = json!({"outer": ["safe", {"nested": private}]});
            let Err(error) = validate_serialized_public_payload(&value) else {
                panic!("accepted {private:?}");
            };
            assert_eq!(
                error.code, "GIT-EXPLANATION-PRIVATE-MATERIAL",
                "accepted {private:?}"
            );
        }
    }

    #[test]
    fn accepts_only_the_exact_64_kib_serialized_boundary() {
        let base = serde_json::to_vec(&json!({"value": ""}))
            .expect("base payload")
            .len();
        let exact = json!({
            "value": "x".repeat(MAX_COMMIT_EVIDENCE_PAYLOAD_BYTES - base)
        });
        assert_eq!(
            serde_json::to_vec(&exact).expect("exact payload").len(),
            MAX_COMMIT_EVIDENCE_PAYLOAD_BYTES
        );
        validate_serialized_public_payload(&exact).expect("exact boundary");

        let over = json!({
            "value": "x".repeat(MAX_COMMIT_EVIDENCE_PAYLOAD_BYTES - base + 1)
        });
        assert_eq!(
            validate_serialized_public_payload(&over)
                .expect_err("over boundary")
                .code,
            "GIT-EXPLANATION-EVIDENCE-LIMIT"
        );
    }

    #[test]
    fn ordinary_explanation_text_remains_public() {
        validate_serialized_public_payload(&json!({
            "subject": "feat(git): add read-only evidence",
            "checks": ["pnpm test", "cargo test git_review"],
            "summary": "The observer keeps the repository unchanged."
        }))
        .expect("ordinary public evidence");
    }
}
