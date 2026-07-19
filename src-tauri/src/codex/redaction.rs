use std::path::Path;
use std::sync::OnceLock;

use regex::Regex;

const REDACTED: &str = "[redacted]";

fn bearer_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r#"(?i)\bbearer\s+(?:"[^"\r\n]{1,4096}"|'[^'\r\n]{1,4096}'|[^\s,;]+)"#)
            .expect("bearer redaction regex is valid")
    })
}

fn credential_assignment_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(
            r#"(?ix)
            \b(
                authorization|api[ _-]?key|access[ _-]?token|refresh[ _-]?token|
                id[ _-]?token|token|password|passwd|secret|client[ _-]?secret|
                auth[ _-]?cookie|cookie|set-cookie|session[ _-]?id|sessionid
            )\b
            \s*[:=]\s*
            (?:"[^"\r\n]{0,4096}"|'[^'\r\n]{0,4096}'|[^\s,;]+)
            "#,
        )
        .expect("credential assignment redaction regex is valid")
    })
}

fn key_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"\b(?:sk|sess|rk|pk)-[A-Za-z0-9_-]{12,}\b")
            .expect("key redaction regex is valid")
    })
}

fn absolute_path_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r#"(?m)(^|[\s=:'"(,\[])(/[A-Za-z0-9_~.+@%{}$-][^\s,'")\]\[;]*)"#)
            .expect("path redaction regex is valid")
    })
}

fn truncate_utf8(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_owned();
    }

    let mut boundary = max_bytes;
    while !value.is_char_boundary(boundary) {
        boundary -= 1;
    }
    format!("{}…", &value[..boundary])
}

pub fn redact_text(value: &str, workspace_root: Option<&Path>, max_bytes: usize) -> String {
    let mut redacted = value.to_owned();

    if let Some(root) = workspace_root.and_then(Path::to_str) {
        if !root.is_empty() {
            redacted = redacted.replace(root, "<workspace>");
        }
    }

    if let Some(home) = std::env::var_os("HOME").and_then(|home| home.into_string().ok()) {
        if !home.is_empty() {
            redacted = redacted.replace(&home, "~");
        }
    }

    redacted = bearer_pattern()
        .replace_all(&redacted, format!("bearer={REDACTED}"))
        .into_owned();
    redacted = credential_assignment_pattern()
        .replace_all(&redacted, |captures: &regex::Captures<'_>| {
            format!("{}={REDACTED}", &captures[1].to_ascii_lowercase())
        })
        .into_owned();
    redacted = key_pattern().replace_all(&redacted, REDACTED).into_owned();
    redacted = absolute_path_pattern()
        .replace_all(&redacted, |captures: &regex::Captures<'_>| {
            let prefix = captures.get(1).map_or("", |capture| capture.as_str());
            if prefix.is_empty() {
                "<path>".to_owned()
            } else {
                format!("{prefix}<path>")
            }
        })
        .into_owned();

    truncate_utf8(&redacted, max_bytes)
}

pub fn safe_detail_ref(scope: &str, id: u64) -> String {
    format!("{scope}-{id:08x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secrets_and_private_paths_are_removed_before_truncation() {
        let value = "Bearer secret-token sk-1234567890abcdef /\u{0055}sers/alice/private/file.rs";
        let redacted = redact_text(value, None, 256);

        assert!(!redacted.contains("secret-token"));
        assert!(!redacted.contains("sk-123"));
        assert!(!redacted.contains("/\u{0055}sers/alice"));
        assert!(redacted.contains(REDACTED));
    }

    #[test]
    fn cookies_sessions_and_quoted_credentials_are_removed() {
        let value = concat!(
            "Cookie: theme=light; sessionid = \"secret value with spaces\"\n",
            "Auth Cookie : 'another private value' access token = top-secret\n",
            "Authorization: Bearer bearer-secret"
        );
        let redacted = redact_text(value, None, 1024);

        assert!(!redacted.contains("secret value"));
        assert!(!redacted.contains("another private"));
        assert!(!redacted.contains("top-secret"));
        assert!(!redacted.contains("bearer-secret"));
        assert!(redacted.matches(REDACTED).count() >= 4);
    }

    #[test]
    fn redaction_precedes_a_real_truncation_boundary() {
        let redacted = redact_text(
            "sessionid=credential-that-must-never-survive trailing diagnostic text",
            None,
            24,
        );

        assert!(!redacted.contains("credential-that"));
        assert!(redacted.contains(REDACTED));
        assert!(redacted.ends_with('…'));
    }

    #[test]
    fn general_absolute_paths_are_aliased_without_matching_urls_or_ratios() {
        let value = concat!(
            "/Volumes/External/project/file.rs ",
            "/Library/Application Support/tool/config.json ",
            "/Applications/Codex.app/Contents/MacOS/Codex ",
            "/etc/hosts https://example.com/v1 1/2"
        );
        let redacted = redact_text(value, None, 1024);

        assert!(!redacted.contains("/Volumes/External"));
        assert!(!redacted.contains("/Library/Application"));
        assert!(!redacted.contains("/Applications/Codex.app"));
        assert!(!redacted.contains("/etc/hosts"));
        assert!(redacted.contains("https://example.com/v1"));
        assert!(redacted.contains("1/2"));
    }

    #[test]
    fn credential_words_without_assignments_are_not_false_positives() {
        let value = "token count is 42; keep the password guidance and secret classification";
        assert_eq!(redact_text(value, None, 256), value);
    }

    #[test]
    fn workspace_root_is_replaced_with_an_alias() {
        let redacted = redact_text(
            "/repo/project/src/main.rs",
            Some(Path::new("/repo/project")),
            256,
        );

        assert_eq!(redacted, "<workspace>/src/main.rs");
    }

    #[test]
    fn truncation_keeps_utf8_valid() {
        assert_eq!(redact_text("日本語", None, 5), "日…");
    }
}
