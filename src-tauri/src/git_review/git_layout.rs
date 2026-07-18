//! Direct, non-executing inspection of validated Git metadata.

use std::fs;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Component, Path, PathBuf};

const MAX_CONTROL_FILE_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum GitLayoutError {
    Invalid,
    Io,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct GitRepositoryLayout {
    pub canonical_root: PathBuf,
    pub canonical_git_dir: PathBuf,
    pub canonical_common_dir: PathBuf,
    pub object_directory: PathBuf,
    pub index_file: PathBuf,
    pub head_sha: String,
    pub head_reference: Option<String>,
}

impl GitRepositoryLayout {
    pub fn inspect(root: &Path) -> Result<Self, GitLayoutError> {
        let canonical_root = fs::canonicalize(root).map_err(|_| GitLayoutError::Io)?;
        let marker = canonical_root.join(".git");
        let marker_metadata = fs::symlink_metadata(&marker).map_err(|_| GitLayoutError::Io)?;
        if marker_metadata.file_type().is_symlink() {
            return Err(GitLayoutError::Invalid);
        }
        let canonical_git_dir = if marker_metadata.is_dir() {
            fs::canonicalize(&marker).map_err(|_| GitLayoutError::Io)?
        } else if marker_metadata.is_file() {
            validate_private_file(&marker, MAX_CONTROL_FILE_BYTES)?;
            let value = read_bounded_text(&marker, 4_096)?;
            let git_dir = value
                .strip_prefix("gitdir:")
                .map(str::trim)
                .filter(|value| !value.is_empty() && !value.contains('\0'))
                .ok_or(GitLayoutError::Invalid)?;
            let git_dir = Path::new(git_dir);
            fs::canonicalize(if git_dir.is_absolute() {
                git_dir.to_path_buf()
            } else {
                canonical_root.join(git_dir)
            })
            .map_err(|_| GitLayoutError::Io)?
        } else {
            return Err(GitLayoutError::Invalid);
        };
        validate_private_directory(&canonical_git_dir)?;

        let common_marker = canonical_git_dir.join("commondir");
        let canonical_common_dir = match fs::symlink_metadata(&common_marker) {
            Ok(metadata) => {
                if !metadata.is_file() || metadata.file_type().is_symlink() {
                    return Err(GitLayoutError::Invalid);
                }
                validate_private_file(&common_marker, 4_096)?;
                let value = read_bounded_text(&common_marker, 4_096)?;
                let value = value.trim();
                if value.is_empty() || value.contains('\0') {
                    return Err(GitLayoutError::Invalid);
                }
                let path = Path::new(value);
                fs::canonicalize(if path.is_absolute() {
                    path.to_path_buf()
                } else {
                    canonical_git_dir.join(path)
                })
                .map_err(|_| GitLayoutError::Io)?
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => canonical_git_dir.clone(),
            Err(_) => return Err(GitLayoutError::Io),
        };
        validate_private_directory(&canonical_common_dir)?;
        if canonical_common_dir != canonical_git_dir
            && !canonical_git_dir.starts_with(&canonical_common_dir)
        {
            return Err(GitLayoutError::Invalid);
        }

        let object_directory = canonical_common_dir.join("objects");
        validate_private_directory(&object_directory)?;
        let index_file = canonical_git_dir.join("index");
        let head_file = canonical_git_dir.join("HEAD");
        validate_private_file(&head_file, 4_096)?;
        let head_value = read_bounded_text(&head_file, 4_096)?;
        let head_value = head_value.trim();
        let (head_sha, head_reference) = if let Some(reference) = head_value.strip_prefix("ref: ") {
            if !is_safe_head_reference(reference) {
                return Err(GitLayoutError::Invalid);
            }
            (
                read_reference(&canonical_git_dir, &canonical_common_dir, reference)?
                    .unwrap_or_else(|| "unborn".to_owned()),
                Some(reference.to_owned()),
            )
        } else if is_object_id(head_value) {
            (head_value.to_owned(), None)
        } else {
            return Err(GitLayoutError::Invalid);
        };

        Ok(Self {
            canonical_root,
            canonical_git_dir,
            canonical_common_dir,
            object_directory,
            index_file,
            head_sha,
            head_reference,
        })
    }

    pub fn reference_value(&self, reference: &str) -> Result<Option<String>, GitLayoutError> {
        if reference == "HEAD" {
            return Ok((self.head_sha != "unborn").then(|| self.head_sha.clone()));
        }
        if !is_safe_head_reference(reference) {
            return Err(GitLayoutError::Invalid);
        }
        read_reference(
            &self.canonical_git_dir,
            &self.canonical_common_dir,
            reference,
        )
    }
}

pub(crate) fn is_object_id(value: &str) -> bool {
    matches!(value.len(), 40 | 64) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

pub(crate) fn is_safe_head_reference(value: &str) -> bool {
    value.starts_with("refs/heads/")
        && value.len() <= 251
        && !value.contains("..")
        && !value.contains("@{")
        && !value.ends_with('.')
        && !value.ends_with('/')
        && !value
            .chars()
            .any(|character| character.is_control() || " ~^:?*[\\".contains(character))
        && value.split('/').all(|component| {
            !component.is_empty() && component != "." && !component.ends_with(".lock")
        })
}

fn read_reference(
    git_dir: &Path,
    common_dir: &Path,
    reference: &str,
) -> Result<Option<String>, GitLayoutError> {
    for base in [git_dir, common_dir] {
        let path = safe_metadata_path(base, reference)?;
        match fs::symlink_metadata(&path) {
            Ok(_) => {
                validate_private_file(&path, 4_096)?;
                let value = read_bounded_text(&path, 4_096)?;
                let value = value.trim();
                if !is_object_id(value) {
                    return Err(GitLayoutError::Invalid);
                }
                return Ok(Some(value.to_owned()));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(GitLayoutError::Io),
        }
    }
    let packed_refs = common_dir.join("packed-refs");
    match fs::symlink_metadata(&packed_refs) {
        Ok(_) => {
            validate_private_file(&packed_refs, MAX_CONTROL_FILE_BYTES)?;
            let contents = read_bounded_text(&packed_refs, MAX_CONTROL_FILE_BYTES)?;
            for line in contents.lines() {
                if line.is_empty() || line.starts_with(['#', '^']) {
                    continue;
                }
                let Some((object_id, name)) = line.split_once(' ') else {
                    return Err(GitLayoutError::Invalid);
                };
                if name == reference {
                    if !is_object_id(object_id) {
                        return Err(GitLayoutError::Invalid);
                    }
                    return Ok(Some(object_id.to_owned()));
                }
            }
            Ok(None)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(GitLayoutError::Io),
    }
}

fn safe_metadata_path(base: &Path, relative: &str) -> Result<PathBuf, GitLayoutError> {
    let final_path = base.join(relative);
    let mut path = base.to_path_buf();
    for component in Path::new(relative).components() {
        let Component::Normal(component) = component else {
            return Err(GitLayoutError::Invalid);
        };
        path.push(component);
        if path != final_path {
            match fs::symlink_metadata(&path) {
                Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
                    return Err(GitLayoutError::Invalid)
                }
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
                Err(_) => return Err(GitLayoutError::Io),
            }
        }
    }
    Ok(path)
}

fn validate_private_directory(path: &Path) -> Result<(), GitLayoutError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| GitLayoutError::Io)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(GitLayoutError::Invalid);
    }
    validate_owner_mode(&metadata)
}

fn validate_private_file(path: &Path, max_bytes: u64) -> Result<(), GitLayoutError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| GitLayoutError::Io)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > max_bytes {
        return Err(GitLayoutError::Invalid);
    }
    validate_owner_mode(&metadata)
}

fn validate_owner_mode(metadata: &fs::Metadata) -> Result<(), GitLayoutError> {
    let uid = unsafe { libc::geteuid() };
    if !matches!(metadata.uid(), owner if owner == uid || owner == 0)
        || metadata.permissions().mode() & 0o022 != 0
    {
        return Err(GitLayoutError::Invalid);
    }
    Ok(())
}

fn read_bounded_text(path: &Path, max_bytes: u64) -> Result<String, GitLayoutError> {
    let bytes = fs::read(path).map_err(|_| GitLayoutError::Io)?;
    if bytes.len() as u64 > max_bytes || bytes.contains(&0) {
        return Err(GitLayoutError::Invalid);
    }
    String::from_utf8(bytes).map_err(|_| GitLayoutError::Invalid)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unsafe_head_references_are_rejected() {
        for value in ["refs/tags/v1", "refs/heads/../main", "refs/heads/a.lock"] {
            assert!(!is_safe_head_reference(value), "{value}");
        }
        assert!(is_safe_head_reference("refs/heads/feature/review"));
    }
}
