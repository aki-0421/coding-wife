use std::ffi::{OsStr, OsString};
use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::time::Duration;

use sha2::{Digest, Sha256};
use tokio::process::Command;

use crate::codex::process::{run_bounded_command, BoundedCommandError, BoundedCommandOutput};

const GIT_TIMEOUT: Duration = Duration::from_secs(5);
const GIT_MUTATION_TIMEOUT: Duration = Duration::from_secs(10);
const GIT_STDERR_LIMIT: usize = 16 * 1024;
const GIT_DEFAULT_STDOUT_LIMIT: usize = 2 * 1024 * 1024;
const GIT_LARGE_STDOUT_LIMIT: usize = 52 * 1024 * 1024;
const MAX_GIT_BINARY_BYTES: u64 = 128 * 1024 * 1024;

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

#[derive(Clone, Debug, Default)]
pub(crate) struct GitExecutionContext {
    pub index_file: Option<PathBuf>,
    pub object_directory: Option<PathBuf>,
    pub alternate_object_directories: Option<OsString>,
}

#[derive(Clone, Debug)]
pub(crate) struct GitRunner {
    binary: GitBinaryIdentity,
}

impl GitRunner {
    pub fn production() -> Result<Self, GitRunnerError> {
        Ok(Self {
            binary: GitBinaryIdentity::inspect(Path::new("/usr/bin/git"))?,
        })
    }

    async fn run(
        &self,
        root: &Path,
        arguments: impl IntoIterator<Item = OsString>,
        context: &GitExecutionContext,
        timeout: Duration,
        stdout_limit: usize,
    ) -> Result<BoundedCommandOutput, GitRunnerError> {
        self.binary.revalidate()?;
        let mut command = Command::new(&self.binary.canonical_path);
        command
            .arg("--literal-pathspecs")
            .arg("-c")
            .arg("color.ui=false")
            .arg("-c")
            .arg("core.pager=cat")
            .arg("-c")
            .arg("core.hooksPath=/dev/null")
            .arg("-c")
            .arg("commit.gpgSign=false")
            .arg("-C")
            .arg(root)
            .args(arguments)
            .env_clear()
            .env("LC_ALL", "C")
            .env("LANG", "C")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_OPTIONAL_LOCKS", "0")
            .env("GIT_PAGER", "cat")
            .env("PAGER", "cat");
        if let Some(home) = std::env::var_os("HOME") {
            command.env("HOME", home);
        }
        if let Some(index_file) = &context.index_file {
            command.env("GIT_INDEX_FILE", index_file);
        }
        if let Some(object_directory) = &context.object_directory {
            command.env("GIT_OBJECT_DIRECTORY", object_directory);
        }
        if let Some(alternates) = &context.alternate_object_directories {
            command.env("GIT_ALTERNATE_OBJECT_DIRECTORIES", alternates);
        }
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
            &GitExecutionContext::default(),
            GIT_TIMEOUT,
            stdout_limit,
        )
        .await
    }

    pub async fn rev_parse_head(
        &self,
        root: &Path,
    ) -> Result<BoundedCommandOutput, GitRunnerError> {
        self.read(root, &["rev-parse", "--verify", "HEAD"], 256)
            .await
    }

    pub async fn rev_parse_tree(
        &self,
        root: &Path,
        commit: &str,
    ) -> Result<BoundedCommandOutput, GitRunnerError> {
        let treeish = format!("{commit}^{{tree}}");
        let args = vec![
            OsString::from("rev-parse"),
            OsString::from("--verify"),
            OsString::from(treeish),
        ];
        self.run(
            root,
            args,
            &GitExecutionContext::default(),
            GIT_TIMEOUT,
            256,
        )
        .await
    }

    pub async fn symbolic_head(&self, root: &Path) -> Result<BoundedCommandOutput, GitRunnerError> {
        self.read(root, &["symbolic-ref", "-q", "HEAD"], 512).await
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
        self.read(root, &["ls-files", "--stage", "-z"], GIT_LARGE_STDOUT_LIMIT)
            .await
    }

    pub async fn show_superproject(
        &self,
        root: &Path,
    ) -> Result<BoundedCommandOutput, GitRunnerError> {
        self.read(
            root,
            &["rev-parse", "--show-superproject-working-tree"],
            4096,
        )
        .await
    }

    pub async fn git_common_dir(
        &self,
        root: &Path,
    ) -> Result<BoundedCommandOutput, GitRunnerError> {
        self.read(root, &["rev-parse", "--git-common-dir"], 4096)
            .await
    }

    pub async fn git_path(
        &self,
        root: &Path,
        name: &'static str,
    ) -> Result<BoundedCommandOutput, GitRunnerError> {
        debug_assert!(matches!(
            name,
            "index"
                | "MERGE_HEAD"
                | "CHERRY_PICK_HEAD"
                | "REVERT_HEAD"
                | "BISECT_LOG"
                | "rebase-merge"
                | "rebase-apply"
        ));
        self.read(root, &["rev-parse", "--git-path", name], 4096)
            .await
    }

    pub async fn config_get(
        &self,
        root: &Path,
        key: &'static str,
    ) -> Result<BoundedCommandOutput, GitRunnerError> {
        debug_assert!(matches!(
            key,
            "user.name" | "user.email" | "core.sparseCheckout" | "core.hooksPath"
        ));
        self.read(root, &["config", "--get", key], 4096).await
    }

    pub async fn ls_tree_entry(
        &self,
        root: &Path,
        commit: &str,
        relative_path: &str,
    ) -> Result<BoundedCommandOutput, GitRunnerError> {
        let args = vec![
            OsString::from("ls-tree"),
            OsString::from("-z"),
            OsString::from(commit),
            OsString::from("--"),
            OsString::from(relative_path),
        ];
        self.run(
            root,
            args,
            &GitExecutionContext::default(),
            GIT_TIMEOUT,
            16 * 1024,
        )
        .await
    }

    pub async fn cat_blob(
        &self,
        root: &Path,
        object_id: &str,
    ) -> Result<BoundedCommandOutput, GitRunnerError> {
        let args = vec![
            OsString::from("cat-file"),
            OsString::from("blob"),
            OsString::from(object_id),
        ];
        self.run(
            root,
            args,
            &GitExecutionContext::default(),
            GIT_TIMEOUT,
            GIT_LARGE_STDOUT_LIMIT,
        )
        .await
    }

    pub async fn cat_object_type(
        &self,
        root: &Path,
        object_id: &str,
    ) -> Result<BoundedCommandOutput, GitRunnerError> {
        let args = vec![
            OsString::from("cat-file"),
            OsString::from("-t"),
            OsString::from(object_id),
        ];
        self.run(
            root,
            args,
            &GitExecutionContext::default(),
            GIT_TIMEOUT,
            128,
        )
        .await
    }

    pub async fn rev_list_parent(
        &self,
        root: &Path,
        commit: &str,
    ) -> Result<BoundedCommandOutput, GitRunnerError> {
        let args = vec![
            OsString::from("rev-list"),
            OsString::from("--parents"),
            OsString::from("-n"),
            OsString::from("1"),
            OsString::from(commit),
        ];
        self.run(
            root,
            args,
            &GitExecutionContext::default(),
            GIT_TIMEOUT,
            512,
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
        self.run(
            root,
            args,
            &GitExecutionContext::default(),
            GIT_TIMEOUT,
            128,
        )
        .await
    }

    pub async fn diff_no_index_numstat(
        &self,
        root: &Path,
        before: &Path,
        after: &Path,
    ) -> Result<BoundedCommandOutput, GitRunnerError> {
        let args = vec![
            OsString::from("diff"),
            OsString::from("--no-index"),
            OsString::from("--no-ext-diff"),
            OsString::from("--no-textconv"),
            OsString::from("--numstat"),
            OsString::from("--"),
            before.as_os_str().to_owned(),
            after.as_os_str().to_owned(),
        ];
        self.run(
            root,
            args,
            &GitExecutionContext::default(),
            GIT_TIMEOUT,
            4096,
        )
        .await
    }

    pub async fn merge_file(
        &self,
        root: &Path,
        ours: &Path,
        base: &Path,
        theirs: &Path,
    ) -> Result<BoundedCommandOutput, GitRunnerError> {
        let args = vec![
            OsString::from("merge-file"),
            OsString::from("-p"),
            OsString::from("--diff3"),
            ours.as_os_str().to_owned(),
            base.as_os_str().to_owned(),
            theirs.as_os_str().to_owned(),
        ];
        self.run(
            root,
            args,
            &GitExecutionContext::default(),
            GIT_TIMEOUT,
            GIT_LARGE_STDOUT_LIMIT,
        )
        .await
    }

    pub async fn read_tree(
        &self,
        root: &Path,
        treeish: &str,
        context: &GitExecutionContext,
    ) -> Result<BoundedCommandOutput, GitRunnerError> {
        let args = vec![OsString::from("read-tree"), OsString::from(treeish)];
        self.run(
            root,
            args,
            context,
            GIT_MUTATION_TIMEOUT,
            GIT_DEFAULT_STDOUT_LIMIT,
        )
        .await
    }

    pub async fn read_tree_merge(
        &self,
        root: &Path,
        base: &str,
        ours: &str,
        theirs: &str,
        context: &GitExecutionContext,
    ) -> Result<BoundedCommandOutput, GitRunnerError> {
        let args = vec![
            OsString::from("read-tree"),
            OsString::from("-m"),
            OsString::from(base),
            OsString::from(ours),
            OsString::from(theirs),
        ];
        self.run(
            root,
            args,
            context,
            GIT_MUTATION_TIMEOUT,
            GIT_DEFAULT_STDOUT_LIMIT,
        )
        .await
    }

    pub async fn hash_object_file(
        &self,
        root: &Path,
        path: &Path,
        context: &GitExecutionContext,
    ) -> Result<BoundedCommandOutput, GitRunnerError> {
        let args = vec![
            OsString::from("hash-object"),
            OsString::from("--no-filters"),
            OsString::from("-w"),
            OsString::from("--"),
            path.as_os_str().to_owned(),
        ];
        self.run(root, args, context, GIT_MUTATION_TIMEOUT, 256)
            .await
    }

    pub async fn update_index_cacheinfo(
        &self,
        root: &Path,
        mode: &str,
        object_id: &str,
        relative_path: &str,
        context: &GitExecutionContext,
    ) -> Result<BoundedCommandOutput, GitRunnerError> {
        let args = vec![
            OsString::from("update-index"),
            OsString::from("--add"),
            OsString::from("--cacheinfo"),
            OsString::from(mode),
            OsString::from(object_id),
            OsString::from(relative_path),
        ];
        self.run(
            root,
            args,
            context,
            GIT_MUTATION_TIMEOUT,
            GIT_DEFAULT_STDOUT_LIMIT,
        )
        .await
    }

    pub async fn update_index_remove(
        &self,
        root: &Path,
        relative_path: &str,
        context: &GitExecutionContext,
    ) -> Result<BoundedCommandOutput, GitRunnerError> {
        let args = vec![
            OsString::from("update-index"),
            OsString::from("--force-remove"),
            OsString::from("--"),
            OsString::from(relative_path),
        ];
        self.run(
            root,
            args,
            context,
            GIT_MUTATION_TIMEOUT,
            GIT_DEFAULT_STDOUT_LIMIT,
        )
        .await
    }

    pub async fn write_tree(
        &self,
        root: &Path,
        context: &GitExecutionContext,
    ) -> Result<BoundedCommandOutput, GitRunnerError> {
        self.run(
            root,
            [OsString::from("write-tree")],
            context,
            GIT_MUTATION_TIMEOUT,
            256,
        )
        .await
    }

    pub async fn commit_tree(
        &self,
        root: &Path,
        tree: &str,
        parent: &str,
        message_file: &Path,
        author: &GitAuthor,
        context: &GitExecutionContext,
    ) -> Result<BoundedCommandOutput, GitRunnerError> {
        self.binary.revalidate()?;
        let mut command = Command::new(&self.binary.canonical_path);
        command
            .arg("--literal-pathspecs")
            .arg("-c")
            .arg("color.ui=false")
            .arg("-c")
            .arg("core.hooksPath=/dev/null")
            .arg("-c")
            .arg("commit.gpgSign=false")
            .arg("-C")
            .arg(root)
            .arg("commit-tree")
            .arg(tree)
            .arg("-p")
            .arg(parent)
            .arg("-F")
            .arg(message_file)
            .env_clear()
            .env("LC_ALL", "C")
            .env("LANG", "C")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_OPTIONAL_LOCKS", "0")
            .env("GIT_AUTHOR_NAME", &author.name)
            .env("GIT_AUTHOR_EMAIL", &author.email)
            .env("GIT_COMMITTER_NAME", &author.name)
            .env("GIT_COMMITTER_EMAIL", &author.email);
        if let Some(index_file) = &context.index_file {
            command.env("GIT_INDEX_FILE", index_file);
        }
        if let Some(object_directory) = &context.object_directory {
            command.env("GIT_OBJECT_DIRECTORY", object_directory);
        }
        if let Some(alternates) = &context.alternate_object_directories {
            command.env("GIT_ALTERNATE_OBJECT_DIRECTORIES", alternates);
        }
        let output = run_bounded_command(command, GIT_MUTATION_TIMEOUT, 256, GIT_STDERR_LIMIT)
            .await
            .map_err(map_bounded_error)?;
        self.binary.revalidate()?;
        Ok(output)
    }

    pub async fn update_ref(
        &self,
        root: &Path,
        reference: &str,
        new_value: &str,
        old_value: &str,
    ) -> Result<BoundedCommandOutput, GitRunnerError> {
        let args = vec![
            OsString::from("update-ref"),
            OsString::from("--no-deref"),
            OsString::from(reference),
            OsString::from(new_value),
            OsString::from(old_value),
        ];
        self.run(
            root,
            args,
            &GitExecutionContext::default(),
            GIT_MUTATION_TIMEOUT,
            4096,
        )
        .await
    }

    pub async fn check_ref_format_branch(
        &self,
        root: &Path,
        branch: &str,
    ) -> Result<BoundedCommandOutput, GitRunnerError> {
        let args = vec![
            OsString::from("check-ref-format"),
            OsString::from("--branch"),
            OsString::from(branch),
        ];
        self.run(
            root,
            args,
            &GitExecutionContext::default(),
            GIT_TIMEOUT,
            4096,
        )
        .await
    }

    pub async fn ref_exists(
        &self,
        root: &Path,
        reference: &str,
    ) -> Result<BoundedCommandOutput, GitRunnerError> {
        let args = vec![
            OsString::from("show-ref"),
            OsString::from("--verify"),
            OsString::from("--quiet"),
            OsString::from(reference),
        ];
        self.run(
            root,
            args,
            &GitExecutionContext::default(),
            GIT_TIMEOUT,
            128,
        )
        .await
    }

    pub async fn revert_commit(
        &self,
        root: &Path,
        commit: &str,
    ) -> Result<BoundedCommandOutput, GitRunnerError> {
        let args = vec![
            OsString::from("revert"),
            OsString::from("--no-edit"),
            OsString::from("--no-gpg-sign"),
            OsString::from(commit),
        ];
        self.run(
            root,
            args,
            &GitExecutionContext::default(),
            GIT_MUTATION_TIMEOUT,
            GIT_DEFAULT_STDOUT_LIMIT,
        )
        .await
    }

    pub async fn abort_revert(&self, root: &Path) -> Result<BoundedCommandOutput, GitRunnerError> {
        self.run(
            root,
            [OsString::from("revert"), OsString::from("--abort")],
            &GitExecutionContext::default(),
            GIT_MUTATION_TIMEOUT,
            GIT_DEFAULT_STDOUT_LIMIT,
        )
        .await
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
        self.run(
            root,
            args,
            &GitExecutionContext::default(),
            GIT_TIMEOUT,
            GIT_LARGE_STDOUT_LIMIT,
        )
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
        self.run(
            root,
            args,
            &GitExecutionContext::default(),
            GIT_TIMEOUT,
            GIT_LARGE_STDOUT_LIMIT,
        )
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
        self.run(
            root,
            args,
            &GitExecutionContext::default(),
            GIT_TIMEOUT,
            stdout_limit,
        )
        .await
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct GitAuthor {
    pub name: String,
    pub email: String,
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

pub(crate) fn stdout_text(output: &BoundedCommandOutput) -> Result<String, GitRunnerError> {
    String::from_utf8(output.stdout.clone()).map_err(|_| GitRunnerError::Io)
}

pub(crate) fn trimmed_stdout(output: &BoundedCommandOutput) -> Result<String, GitRunnerError> {
    Ok(stdout_text(output)?.trim().to_owned())
}

pub(crate) fn os_path_list(paths: &[PathBuf]) -> OsString {
    let mut value = OsString::new();
    for (index, path) in paths.iter().enumerate() {
        if index > 0 {
            value.push(OsStr::new(":"));
        }
        value.push(path.as_os_str());
    }
    value
}
