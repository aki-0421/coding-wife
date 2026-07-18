use std::collections::BTreeSet;
use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::Deserialize;
use sha2::{Digest, Sha256};
use thiserror::Error;

use super::types::MainSkillInjectionAudit;

pub const COMMIT_SKILL_NAME: &str = "coding-wife-commit-work";
pub const EXPLAIN_COMMIT_SKILL_NAME: &str = "coding-wife-explain-commit";
const EXPECTED_MANIFEST_SHA256: &str =
    "23c21f06951ce9086d8522034ca5a2067b2e22e9b699b85f25621a1b122b364e";
const MAX_MANIFEST_BYTES: u64 = 128 * 1024;
const MAX_SKILL_FILE_BYTES: u64 = 128 * 1024;
const MAX_SKILLS: usize = 16;
const MAX_FILES_PER_SKILL: usize = 32;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResolvedBundledSkill {
    pub name: String,
    pub version: String,
    pub content_digest: String,
    pub path: PathBuf,
}

impl ResolvedBundledSkill {
    pub fn audit(&self) -> MainSkillInjectionAudit {
        MainSkillInjectionAudit {
            name: self.name.clone(),
            version: self.version.clone(),
            content_digest: self.content_digest.clone(),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Error)]
pub enum BundledSkillError {
    #[error("the bundled skill resource is missing")]
    Missing,
    #[error("the bundled skill resource failed its digest check")]
    Tampered,
    #[error("the bundled skill manifest is invalid")]
    Invalid,
}

impl BundledSkillError {
    pub fn code(self) -> &'static str {
        match self {
            Self::Missing => "CODEX-COMMIT-SKILL-MISSING",
            Self::Tampered => "CODEX-COMMIT-SKILL-TAMPERED",
            Self::Invalid => "CODEX-COMMIT-SKILL-INVALID",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct SkillManifest {
    schema_version: u16,
    authority: String,
    skills: Vec<SkillManifestEntry>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct SkillManifestEntry {
    name: String,
    version: String,
    entrypoint: String,
    content_digest: String,
    implicit_invocation: bool,
    files: Vec<SkillManifestFile>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SkillManifestFile {
    path: String,
    sha256: String,
}

pub fn resolve_bundled_skill(
    resource_directory: &Path,
    expected_name: &str,
) -> Result<ResolvedBundledSkill, BundledSkillError> {
    if !matches!(expected_name, COMMIT_SKILL_NAME | EXPLAIN_COMMIT_SKILL_NAME) {
        return Err(BundledSkillError::Invalid);
    }
    let resource_root =
        fs::canonicalize(resource_directory).map_err(|_| BundledSkillError::Missing)?;
    let skills_root = locate_skills_root(resource_directory, &resource_root)?;
    let manifest_path = skills_root.join("manifest.json");
    let manifest_bytes = read_regular_bounded(&manifest_path, MAX_MANIFEST_BYTES)?;
    if sha256(&manifest_bytes) != EXPECTED_MANIFEST_SHA256 {
        return Err(BundledSkillError::Tampered);
    }
    let manifest: SkillManifest =
        serde_json::from_slice(&manifest_bytes).map_err(|_| BundledSkillError::Invalid)?;
    if manifest.schema_version != 1
        || manifest.authority != "app_bundle"
        || manifest.skills.is_empty()
        || manifest.skills.len() > MAX_SKILLS
    {
        return Err(BundledSkillError::Invalid);
    }
    let matching = manifest
        .skills
        .iter()
        .filter(|entry| entry.name == expected_name)
        .collect::<Vec<_>>();
    if matching.len() != 1 {
        return Err(BundledSkillError::Invalid);
    }
    validate_entry(&skills_root, matching[0])
}

fn locate_skills_root(
    resource_directory: &Path,
    canonical_resource_root: &Path,
) -> Result<PathBuf, BundledSkillError> {
    let candidates = [
        resource_directory.join("skills"),
        resource_directory.join("resources/skills"),
    ];
    let existing = candidates
        .iter()
        .filter(|candidate| fs::symlink_metadata(candidate).is_ok_and(|metadata| metadata.is_dir()))
        .collect::<Vec<_>>();
    if existing.len() != 1 {
        return Err(if existing.is_empty() {
            BundledSkillError::Missing
        } else {
            BundledSkillError::Invalid
        });
    }
    let candidate = existing[0];
    if fs::symlink_metadata(candidate)
        .map_err(|_| BundledSkillError::Missing)?
        .file_type()
        .is_symlink()
    {
        return Err(BundledSkillError::Invalid);
    }
    let canonical = fs::canonicalize(candidate).map_err(|_| BundledSkillError::Missing)?;
    if !canonical.starts_with(canonical_resource_root) {
        return Err(BundledSkillError::Invalid);
    }
    Ok(canonical)
}

fn validate_entry(
    skills_root: &Path,
    entry: &SkillManifestEntry,
) -> Result<ResolvedBundledSkill, BundledSkillError> {
    if !valid_skill_name(&entry.name)
        || !valid_version(&entry.version)
        || entry.implicit_invocation
        || entry.entrypoint != format!("{}/SKILL.md", entry.name)
        || entry.files.len() != 2
        || !valid_content_digest(&entry.content_digest)
    {
        return Err(BundledSkillError::Invalid);
    }

    let expected_files = BTreeSet::from([
        format!("{}/SKILL.md", entry.name),
        format!("{}/agents/openai.yaml", entry.name),
    ]);
    let mut declared_files = BTreeSet::new();
    let mut entrypoint_bytes = None;
    for file in &entry.files {
        if !valid_sha256(&file.sha256)
            || !expected_files.contains(&file.path)
            || !declared_files.insert(file.path.clone())
        {
            return Err(BundledSkillError::Invalid);
        }
        let relative = safe_relative(&file.path)?;
        let path = skills_root.join(&relative);
        ensure_no_symlink_components(skills_root, &relative)?;
        let bytes = read_regular_bounded(&path, MAX_SKILL_FILE_BYTES)?;
        if sha256(&bytes) != file.sha256 {
            return Err(BundledSkillError::Tampered);
        }
        if file.path == entry.entrypoint {
            entrypoint_bytes = Some(bytes);
        }
    }
    if declared_files != expected_files {
        return Err(BundledSkillError::Invalid);
    }
    let actual_files = collect_regular_files(&skills_root.join(&entry.name), &entry.name)?;
    if actual_files != expected_files {
        return Err(BundledSkillError::Invalid);
    }

    let entrypoint_bytes = entrypoint_bytes.ok_or(BundledSkillError::Invalid)?;
    let digest = sha256(&entrypoint_bytes);
    if entry.content_digest != format!("sha256:{digest}") {
        return Err(BundledSkillError::Tampered);
    }
    validate_skill_document(&entrypoint_bytes, &entry.name)?;
    let openai_bytes = read_regular_bounded(
        &skills_root.join(&entry.name).join("agents/openai.yaml"),
        MAX_SKILL_FILE_BYTES,
    )?;
    validate_openai_yaml(&openai_bytes, &entry.name)?;

    let path = fs::canonicalize(skills_root.join(&entry.entrypoint))
        .map_err(|_| BundledSkillError::Missing)?;
    if !path.starts_with(skills_root) || path.to_str().is_none() {
        return Err(BundledSkillError::Invalid);
    }
    Ok(ResolvedBundledSkill {
        name: entry.name.clone(),
        version: entry.version.clone(),
        content_digest: entry.content_digest.clone(),
        path,
    })
}

fn collect_regular_files(
    directory: &Path,
    prefix: &str,
) -> Result<BTreeSet<String>, BundledSkillError> {
    let metadata = fs::symlink_metadata(directory).map_err(|_| BundledSkillError::Missing)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(BundledSkillError::Invalid);
    }
    let mut pending = vec![(directory.to_path_buf(), prefix.to_owned())];
    let mut files = BTreeSet::new();
    while let Some((current, current_prefix)) = pending.pop() {
        for result in fs::read_dir(&current).map_err(|_| BundledSkillError::Missing)? {
            let entry = result.map_err(|_| BundledSkillError::Missing)?;
            let metadata = entry.metadata().map_err(|_| BundledSkillError::Missing)?;
            let file_type = entry.file_type().map_err(|_| BundledSkillError::Missing)?;
            if file_type.is_symlink() {
                return Err(BundledSkillError::Invalid);
            }
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| BundledSkillError::Invalid)?;
            let relative = format!("{current_prefix}/{name}");
            if metadata.is_dir() {
                pending.push((entry.path(), relative));
            } else if metadata.is_file() {
                files.insert(relative);
                if files.len() > MAX_FILES_PER_SKILL {
                    return Err(BundledSkillError::Invalid);
                }
            } else {
                return Err(BundledSkillError::Invalid);
            }
        }
    }
    Ok(files)
}

fn ensure_no_symlink_components(root: &Path, relative: &Path) -> Result<(), BundledSkillError> {
    let mut current = root.to_path_buf();
    for component in relative.components() {
        let Component::Normal(component) = component else {
            return Err(BundledSkillError::Invalid);
        };
        current.push(component);
        let metadata = fs::symlink_metadata(&current).map_err(|_| BundledSkillError::Missing)?;
        if metadata.file_type().is_symlink() {
            return Err(BundledSkillError::Invalid);
        }
    }
    Ok(())
}

fn read_regular_bounded(path: &Path, limit: u64) -> Result<Vec<u8>, BundledSkillError> {
    let before = fs::symlink_metadata(path).map_err(|_| BundledSkillError::Missing)?;
    if before.file_type().is_symlink() || !before.is_file() || before.len() > limit {
        return Err(BundledSkillError::Invalid);
    }
    let bytes = fs::read(path).map_err(|_| BundledSkillError::Missing)?;
    let after = fs::symlink_metadata(path).map_err(|_| BundledSkillError::Missing)?;
    if !after.is_file() || after.file_type().is_symlink() || after.len() != before.len() {
        return Err(BundledSkillError::Tampered);
    }
    if bytes.len() as u64 != before.len() {
        return Err(BundledSkillError::Tampered);
    }
    Ok(bytes)
}

fn safe_relative(value: &str) -> Result<PathBuf, BundledSkillError> {
    let path = Path::new(value);
    if path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(BundledSkillError::Invalid);
    }
    Ok(path.to_path_buf())
}

fn validate_skill_document(bytes: &[u8], expected_name: &str) -> Result<(), BundledSkillError> {
    let document = std::str::from_utf8(bytes).map_err(|_| BundledSkillError::Invalid)?;
    let frontmatter = document
        .strip_prefix("---\n")
        .and_then(|document| document.split_once("\n---\n"))
        .map(|(frontmatter, _)| frontmatter)
        .ok_or(BundledSkillError::Invalid)?;
    let mut keys = frontmatter
        .lines()
        .filter_map(|line| line.split_once(':').map(|(key, _)| key))
        .collect::<Vec<_>>();
    keys.sort_unstable();
    if keys != ["description", "name"]
        || !frontmatter
            .lines()
            .any(|line| line == format!("name: {expected_name}"))
        || document.contains("TODO")
    {
        return Err(BundledSkillError::Invalid);
    }
    Ok(())
}

fn validate_openai_yaml(bytes: &[u8], expected_name: &str) -> Result<(), BundledSkillError> {
    let document = std::str::from_utf8(bytes).map_err(|_| BundledSkillError::Invalid)?;
    if !document.contains(&format!("{}{}", '$', expected_name))
        || !document
            .lines()
            .any(|line| line.trim() == "allow_implicit_invocation: false")
        || document
            .lines()
            .any(|line| line.trim() == "allow_implicit_invocation: true")
    {
        return Err(BundledSkillError::Invalid);
    }
    Ok(())
}

fn valid_skill_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

fn valid_version(value: &str) -> bool {
    let parts = value.split('.').collect::<Vec<_>>();
    parts.len() == 3
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
}

fn valid_content_digest(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(valid_sha256)
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn sha256(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_the_committed_main_skill_without_exposing_its_path_in_the_audit() {
        let resource_directory = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let skill = resolve_bundled_skill(&resource_directory, COMMIT_SKILL_NAME)
            .expect("resolve committed skill");
        let audit = serde_json::to_value(skill.audit()).expect("serialize audit");

        assert_eq!(skill.name, COMMIT_SKILL_NAME);
        assert_eq!(skill.version, "1.0.0");
        assert!(skill.path.is_absolute());
        assert_eq!(audit.as_object().expect("audit object").len(), 3);
        assert!(audit.get("name").is_some());
        assert!(audit.get("version").is_some());
        assert!(audit.get("contentDigest").is_some());
        assert!(!audit.to_string().contains("SKILL.md"));
        assert!(!audit.to_string().contains("resources"));
    }

    #[test]
    fn resolves_exactly_the_two_execution_class_skills() {
        let resource_directory = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let main = resolve_bundled_skill(&resource_directory, COMMIT_SKILL_NAME)
            .expect("resolve main skill");
        let support = resolve_bundled_skill(&resource_directory, EXPLAIN_COMMIT_SKILL_NAME)
            .expect("resolve support skill");

        assert_eq!(main.name, COMMIT_SKILL_NAME);
        assert_eq!(support.name, EXPLAIN_COMMIT_SKILL_NAME);
        assert_ne!(main.path, support.path);
        assert!(matches!(
            resolve_bundled_skill(&resource_directory, "unknown-skill"),
            Err(BundledSkillError::Invalid)
        ));
    }
}
