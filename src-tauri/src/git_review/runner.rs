use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use sha2::{Digest, Sha256};
use tokio::process::Command;

use crate::codex::process::{run_bounded_command, BoundedCommandError, BoundedCommandOutput};
use crate::platform_fs::{MetadataExt, PermissionsExt};

use super::git_layout::{is_object_id, is_safe_head_reference, GitRepositoryLayout};

const GIT_TIMEOUT: Duration = Duration::from_secs(5);
const GIT_STDERR_LIMIT: usize = 16 * 1024;
const GIT_LARGE_STDOUT_LIMIT: usize = 52 * 1024 * 1024;
const MAX_GIT_BINARY_BYTES: u64 = 128 * 1024 * 1024;
const MAX_INDEX_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum GitRunnerError {
    BinaryUnavailable,
    BinaryIdentityChanged,
    Spawn,
    Timeout,
    OutputLimit,
    ProcessTree,
    Io,
}

#[derive(Clone, Debug)]
struct GitBinaryIdentity {
    canonical_path: PathBuf,
    device: u64,
    inode: u64,
    length: u64,
    digest: String,
}

impl GitBinaryIdentity {
    fn inspect(path: &Path) -> Result<Self, GitRunnerError> {
        let canonical_path =
            fs::canonicalize(path).map_err(|_| GitRunnerError::BinaryUnavailable)?;
        let metadata =
            fs::metadata(&canonical_path).map_err(|_| GitRunnerError::BinaryUnavailable)?;
        if !metadata.is_file() || metadata.len() > MAX_GIT_BINARY_BYTES {
            return Err(GitRunnerError::BinaryUnavailable);
        }
        let bytes = fs::read(&canonical_path).map_err(|_| GitRunnerError::BinaryUnavailable)?;
        let digest = hex::encode(Sha256::digest(bytes));
        Ok(Self {
            canonical_path,
            device: metadata.dev(),
            inode: metadata.ino(),
            length: metadata.len(),
            digest,
        })
    }

    fn revalidate(&self) -> Result<(), GitRunnerError> {
        let current = Self::inspect(&self.canonical_path)?;
        if current.device != self.device
            || current.inode != self.inode
            || current.length != self.length
            || current.digest != self.digest
        {
            return Err(GitRunnerError::BinaryIdentityChanged);
        }
        Ok(())
    }
}

#[derive(Debug)]
struct PrivateGitEnvironment {
    root: PathBuf,
    git_dir: PathBuf,
    home: PathBuf,
    hooks: PathBuf,
    index_file: PathBuf,
    object_directory: PathBuf,
    alternate_object_directories: OsString,
}

impl PrivateGitEnvironment {
    fn new(root: &Path) -> Result<Self, GitRunnerError> {
        let layout = GitRepositoryLayout::inspect(root).map_err(|_| GitRunnerError::Io)?;
        let private_root = std::env::temp_dir().join(format!(
            "coding-wife-git-shadow-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        create_private_directory(&private_root)?;
        let git_dir = private_root.join("git");
        let home = private_root.join("home");
        let hooks = private_root.join("hooks");
        create_private_directory(&git_dir)?;
        create_private_directory(&home)?;
        create_private_directory(&hooks)?;

        write_private_file(
            &git_dir.join("config"),
            b"[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tfilemode = true\n\tfsmonitor = false\n\thooksPath = /dev/null\n\tattributesFile = /dev/null\n[gc]\n\tauto = 0\n",
        )?;
        let head_value = layout
            .head_reference
            .as_ref()
            .map(|reference| format!("ref: {reference}\n"))
            .unwrap_or_else(|| format!("{}\n", layout.head_sha));
        write_private_file(&git_dir.join("HEAD"), head_value.as_bytes())?;
        if let Some(reference) = &layout.head_reference {
            if !is_safe_head_reference(reference) {
                return Err(GitRunnerError::Io);
            }
            if layout.head_sha != "unborn" {
                let reference_path = git_dir.join(reference);
                create_private_ancestors(&git_dir, &reference_path)?;
                write_private_file(&reference_path, format!("{}\n", layout.head_sha).as_bytes())?;
            }
        }

        let index_file = private_root.join("index");
        match fs::symlink_metadata(&layout.index_file) {
            Ok(metadata)
                if metadata.is_file()
                    && !metadata.file_type().is_symlink()
                    && metadata.len() <= MAX_INDEX_BYTES =>
            {
                fs::copy(&layout.index_file, &index_file).map_err(|_| GitRunnerError::Io)?;
                fs::set_permissions(&index_file, fs::Permissions::from_mode(0o600))
                    .map_err(|_| GitRunnerError::Io)?;
            }
            Ok(_) => return Err(GitRunnerError::Io),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(GitRunnerError::Io),
        }
        let object_directory = git_dir.join("objects");
        create_private_directory(&object_directory)?;
        let alternate_object_directories = layout.object_directory.as_os_str().to_owned();

        Ok(Self {
            root: private_root,
            git_dir,
            home,
            hooks,
            index_file,
            object_directory,
            alternate_object_directories,
        })
    }
}

impl Drop for PrivateGitEnvironment {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[derive(Clone, Debug)]
pub(crate) struct GitRunner {
    binary: GitBinaryIdentity,
}

impl GitRunner {
    pub fn production() -> Result<Self, GitRunnerError> {
        #[cfg(unix)]
        let binary = GitBinaryIdentity::inspect(Path::new("/usr/bin/git"))?;
        #[cfg(windows)]
        let binary = std::env::var_os("PATH")
            .into_iter()
            .flat_map(|path| std::env::split_paths(&path).collect::<Vec<_>>())
            .map(|directory| directory.join("git.exe"))
            .find_map(|candidate| GitBinaryIdentity::inspect(&candidate).ok())
            .ok_or(GitRunnerError::BinaryUnavailable)?;
        Ok(Self { binary })
    }

    async fn run(
        &self,
        root: &Path,
        arguments: impl IntoIterator<Item = OsString>,
        timeout: Duration,
        stdout_limit: usize,
    ) -> Result<BoundedCommandOutput, GitRunnerError> {
        self.binary.revalidate()?;
        let environment = PrivateGitEnvironment::new(root)?;
        let mut command = Command::new(&self.binary.canonical_path);
        configure_command(&mut command, root, &environment);
        command
            .args(arguments)
            .env_clear()
            .env("LC_ALL", "C")
            .env("LANG", "C")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_SYSTEM", "/dev/null")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_ATTR_NOSYSTEM", "1")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_OPTIONAL_LOCKS", "0")
            .env("GIT_PAGER", "cat")
            .env("PAGER", "cat")
            .env("HOME", &environment.home)
            .env("XDG_CONFIG_HOME", &environment.home)
            .env("GIT_DIR", &environment.git_dir)
            .env("GIT_WORK_TREE", root)
            .env("GIT_INDEX_FILE", &environment.index_file)
            .env("GIT_OBJECT_DIRECTORY", &environment.object_directory)
            .env(
                "GIT_ALTERNATE_OBJECT_DIRECTORIES",
                &environment.alternate_object_directories,
            );
        let output = run_bounded_command(command, timeout, stdout_limit, GIT_STDERR_LIMIT)
            .await
            .map_err(map_bounded_error)?;
        self.binary.revalidate()?;
        Ok(output)
    }

    async fn read(
        &self,
        root: &Path,
        args: &[&str],
        stdout_limit: usize,
    ) -> Result<BoundedCommandOutput, GitRunnerError> {
        self.run(
            root,
            args.iter().map(OsString::from),
            GIT_TIMEOUT,
            stdout_limit,
        )
        .await
    }

    pub async fn status_porcelain(
        &self,
        root: &Path,
    ) -> Result<BoundedCommandOutput, GitRunnerError> {
        self.read(
            root,
            &[
                "status",
                "--porcelain=v2",
                "-z",
                "--untracked-files=all",
                "--ignore-submodules=none",
            ],
            GIT_LARGE_STDOUT_LIMIT,
        )
        .await
    }

    pub async fn index_entries(&self, root: &Path) -> Result<BoundedCommandOutput, GitRunnerError> {
        self.read(
            root,
            &["ls-files", "--stage", "-v", "-z"],
            GIT_LARGE_STDOUT_LIMIT,
        )
        .await
    }

    pub async fn is_ancestor(
        &self,
        root: &Path,
        ancestor: &str,
        descendant: &str,
    ) -> Result<BoundedCommandOutput, GitRunnerError> {
        let args = vec![
            OsString::from("merge-base"),
            OsString::from("--is-ancestor"),
            OsString::from(ancestor),
            OsString::from(descendant),
        ];
        self.run(root, args, GIT_TIMEOUT, 128).await
    }

    pub async fn log_commits(
        &self,
        root: &Path,
        skip: usize,
        limit: usize,
    ) -> Result<BoundedCommandOutput, GitRunnerError> {
        let args = vec![
            OsString::from("log"),
            OsString::from("--topo-order"),
            OsString::from("--date=iso-strict"),
            OsString::from("--format=format:%H%x00%P%x00%an%x00%ae%x00%aI%x00%cI%x00%B%x00"),
            OsString::from(format!("--skip={skip}")),
            OsString::from(format!("-n{limit}")),
            OsString::from("HEAD"),
            OsString::from("--"),
        ];
        self.run(root, args, GIT_TIMEOUT, GIT_LARGE_STDOUT_LIMIT)
            .await
    }

    pub async fn show_commit(
        &self,
        root: &Path,
        commit: &str,
    ) -> Result<BoundedCommandOutput, GitRunnerError> {
        if !is_object_id(commit) {
            return Err(GitRunnerError::Io);
        }
        let args = vec![
            OsString::from("show"),
            OsString::from("-s"),
            OsString::from("--date=iso-strict"),
            OsString::from("--format=format:%H%x00%P%x00%an%x00%ae%x00%aI%x00%cI%x00%B%x00"),
            OsString::from(commit),
            OsString::from("--"),
        ];
        self.run(root, args, GIT_TIMEOUT, GIT_LARGE_STDOUT_LIMIT)
            .await
    }

    pub async fn rev_list_range(
        &self,
        root: &Path,
        before: &str,
        after: &str,
        limit: usize,
    ) -> Result<BoundedCommandOutput, GitRunnerError> {
        if !is_object_id(before) || !is_object_id(after) {
            return Err(GitRunnerError::Io);
        }
        let args = vec![
            OsString::from("rev-list"),
            OsString::from("--reverse"),
            OsString::from("--topo-order"),
            OsString::from(format!("--max-count={limit}")),
            OsString::from(after),
            OsString::from(format!("^{before}")),
            OsString::from("--"),
        ];
        self.run(root, args, GIT_TIMEOUT, GIT_LARGE_STDOUT_LIMIT)
            .await
    }

    pub async fn root_diff_name_status(
        &self,
        root: &Path,
        commit: &str,
    ) -> Result<BoundedCommandOutput, GitRunnerError> {
        if !is_object_id(commit) {
            return Err(GitRunnerError::Io);
        }
        let args = vec![
            OsString::from("show"),
            OsString::from("--format="),
            OsString::from("--no-ext-diff"),
            OsString::from("--no-textconv"),
            OsString::from("--name-status"),
            OsString::from("--no-renames"),
            OsString::from("-z"),
            OsString::from(commit),
            OsString::from("--"),
        ];
        self.run(root, args, GIT_TIMEOUT, GIT_LARGE_STDOUT_LIMIT)
            .await
    }

    pub async fn root_diff_numstat(
        &self,
        root: &Path,
        commit: &str,
    ) -> Result<BoundedCommandOutput, GitRunnerError> {
        if !is_object_id(commit) {
            return Err(GitRunnerError::Io);
        }
        let args = vec![
            OsString::from("show"),
            OsString::from("--format="),
            OsString::from("--no-ext-diff"),
            OsString::from("--no-textconv"),
            OsString::from("--numstat"),
            OsString::from("--no-renames"),
            OsString::from("-z"),
            OsString::from(commit),
            OsString::from("--"),
        ];
        self.run(root, args, GIT_TIMEOUT, GIT_LARGE_STDOUT_LIMIT)
            .await
    }

    pub async fn root_diff_file(
        &self,
        root: &Path,
        commit: &str,
        relative_path: &str,
        stdout_limit: usize,
    ) -> Result<BoundedCommandOutput, GitRunnerError> {
        if !is_object_id(commit) {
            return Err(GitRunnerError::Io);
        }
        let args = vec![
            OsString::from("show"),
            OsString::from("--format="),
            OsString::from("--no-ext-diff"),
            OsString::from("--no-textconv"),
            OsString::from("--no-color"),
            OsString::from("--unified=3"),
            OsString::from(commit),
            OsString::from("--"),
            OsString::from(relative_path),
        ];
        self.run(root, args, GIT_TIMEOUT, stdout_limit).await
    }

    pub async fn diff_name_status(
        &self,
        root: &Path,
        from: &str,
        to: &str,
    ) -> Result<BoundedCommandOutput, GitRunnerError> {
        let args = vec![
            OsString::from("diff"),
            OsString::from("--no-ext-diff"),
            OsString::from("--no-textconv"),
            OsString::from("--name-status"),
            OsString::from("--no-renames"),
            OsString::from("-z"),
            OsString::from(from),
            OsString::from(to),
            OsString::from("--"),
        ];
        self.run(root, args, GIT_TIMEOUT, GIT_LARGE_STDOUT_LIMIT)
            .await
    }

    pub async fn diff_numstat(
        &self,
        root: &Path,
        from: &str,
        to: &str,
    ) -> Result<BoundedCommandOutput, GitRunnerError> {
        let args = vec![
            OsString::from("diff"),
            OsString::from("--no-ext-diff"),
            OsString::from("--no-textconv"),
            OsString::from("--numstat"),
            OsString::from("--no-renames"),
            OsString::from("-z"),
            OsString::from(from),
            OsString::from(to),
            OsString::from("--"),
        ];
        self.run(root, args, GIT_TIMEOUT, GIT_LARGE_STDOUT_LIMIT)
            .await
    }

    pub async fn diff_file(
        &self,
        root: &Path,
        from: &str,
        to: &str,
        relative_path: &str,
        stdout_limit: usize,
    ) -> Result<BoundedCommandOutput, GitRunnerError> {
        let args = vec![
            OsString::from("diff"),
            OsString::from("--no-ext-diff"),
            OsString::from("--no-textconv"),
            OsString::from("--no-color"),
            OsString::from("--unified=3"),
            OsString::from(from),
            OsString::from(to),
            OsString::from("--"),
            OsString::from(relative_path),
        ];
        self.run(root, args, GIT_TIMEOUT, stdout_limit).await
    }
}

fn configure_command(command: &mut Command, root: &Path, environment: &PrivateGitEnvironment) {
    let mut hooks_path = OsString::from("core.hooksPath=");
    hooks_path.push(environment.hooks.as_os_str());
    command
        .arg("--literal-pathspecs")
        .arg("--git-dir")
        .arg(&environment.git_dir)
        .arg("--work-tree")
        .arg(root)
        .arg("-c")
        .arg("color.ui=false")
        .arg("-c")
        .arg("core.pager=cat")
        .arg("-c")
        .arg(hooks_path)
        .arg("-c")
        .arg("core.fsmonitor=false")
        .arg("-c")
        .arg("core.untrackedCache=false")
        .arg("-c")
        .arg("core.preloadIndex=false")
        .arg("-c")
        .arg("core.attributesFile=/dev/null")
        .arg("-c")
        .arg("diff.external=")
        .arg("-c")
        .arg("credential.helper=")
        .arg("-c")
        .arg("protocol.allow=never")
        .arg("-c")
        .arg("protocol.file.allow=never")
        .arg("-c")
        .arg("submodule.recurse=false")
        .arg("-c")
        .arg("commit.gpgSign=false")
        .arg("-C")
        .arg(root);
}

fn create_private_directory(path: &Path) -> Result<(), GitRunnerError> {
    fs::create_dir(path).map_err(|_| GitRunnerError::Io)?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|_| GitRunnerError::Io)
}

fn create_private_ancestors(root: &Path, path: &Path) -> Result<(), GitRunnerError> {
    let parent = path.parent().ok_or(GitRunnerError::Io)?;
    fs::create_dir_all(parent).map_err(|_| GitRunnerError::Io)?;
    let mut current = root.to_path_buf();
    let relative = parent.strip_prefix(root).map_err(|_| GitRunnerError::Io)?;
    for component in relative.components() {
        current.push(component);
        fs::set_permissions(&current, fs::Permissions::from_mode(0o700))
            .map_err(|_| GitRunnerError::Io)?;
    }
    Ok(())
}

fn write_private_file(path: &Path, bytes: &[u8]) -> Result<(), GitRunnerError> {
    fs::write(path, bytes).map_err(|_| GitRunnerError::Io)?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(|_| GitRunnerError::Io)
}

fn map_bounded_error(error: BoundedCommandError) -> GitRunnerError {
    match error {
        BoundedCommandError::Spawn | BoundedCommandError::MissingStdio => GitRunnerError::Spawn,
        BoundedCommandError::Timeout => GitRunnerError::Timeout,
        BoundedCommandError::StdoutLimit | BoundedCommandError::StderrLimit => {
            GitRunnerError::OutputLimit
        }
        BoundedCommandError::ProcessTree => GitRunnerError::ProcessTree,
        BoundedCommandError::Read => GitRunnerError::Io,
    }
}
