use std::path::Path;
use std::sync::OnceLock;

use regex::Regex;

const REDACTED: &str = "[redacted]";

fn bearer_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"(?i)\b(bearer|token|api[_ -]?key|password|secret)\s*[:=]?\s*[^\s,;]+")
            .expect("redaction regex is valid")
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
        Regex::new(r#"(?:^|[\s=:'"(])/(?:Users|home|private|tmp|var|opt)/[^\s,'")]+"#)
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
        .replace_all(&redacted, |captures: &regex::Captures<'_>| {
            format!("{}={REDACTED}", &captures[1].to_ascii_lowercase())
        })
        .into_owned();
    redacted = key_pattern().replace_all(&redacted, REDACTED).into_owned();
    redacted = absolute_path_pattern()
        .replace_all(&redacted, |captures: &regex::Captures<'_>| {
            let prefix = captures
                .get(0)
                .map(|capture| capture.as_str().chars().next().unwrap_or(' '))
                .unwrap_or(' ');
            if prefix == '/' {
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
        let value = "Bearer secret-token sk-1234567890abcdef /Users/alice/private/file.rs";
        let redacted = redact_text(value, None, 256);

        assert!(!redacted.contains("secret-token"));
        assert!(!redacted.contains("sk-123"));
        assert!(!redacted.contains("/Users/alice"));
        assert!(redacted.contains(REDACTED));
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
