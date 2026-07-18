use std::ffi::{OsStr, OsString};
use std::fs;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::time::Duration;

use sha2::{Digest, Sha256};
use tokio::process::Command;

use crate::codex::process::{run_bounded_command, BoundedCommandError, BoundedCommandOutput};

use super::git_layout::{is_safe_head_reference, GitRepositoryLayout};

const GIT_TIMEOUT: Duration = Duration::from_secs(5);
const GIT_MUTATION_TIMEOUT: Duration = Duration::from_secs(10);
const GIT_STDERR_LIMIT: usize = 16 * 1024;
const GIT_DEFAULT_STDOUT_LIMIT: usize = 2 * 1024 * 1024;
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

#[derive(Clone, Debug, Default)]
pub(crate) struct GitExecutionContext {
    pub index_file: Option<PathBuf>,
    pub object_directory: Option<PathBuf>,
    pub alternate_object_directories: Option<OsString>,
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
    real_git_dir: PathBuf,
}

impl PrivateGitEnvironment {
    fn new(root: &Path, context: &GitExecutionContext) -> Result<Self, GitRunnerError> {
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

        let index_file = if let Some(index_file) = &context.index_file {
            index_file.clone()
        } else {
            let shadow_index = private_root.join("index");
            match fs::symlink_metadata(&layout.index_file) {
                Ok(metadata)
                    if metadata.is_file()
                        && !metadata.file_type().is_symlink()
                        && metadata.len() <= MAX_INDEX_BYTES =>
                {
                    fs::copy(&layout.index_file, &shadow_index).map_err(|_| GitRunnerError::Io)?;
                    fs::set_permissions(&shadow_index, fs::Permissions::from_mode(0o600))
                        .map_err(|_| GitRunnerError::Io)?;
                }
                Ok(_) => return Err(GitRunnerError::Io),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Err(GitRunnerError::Io),
            }
            shadow_index
        };
        let object_directory = if let Some(object_directory) = &context.object_directory {
            object_directory.clone()
        } else {
            let directory = git_dir.join("objects");
            create_private_directory(&directory)?;
            directory
        };
        let mut alternates = context
            .alternate_object_directories
            .clone()
            .unwrap_or_default();
        if !alternates.is_empty() {
            alternates.push(OsStr::new(":"));
        }
        alternates.push(layout.object_directory.as_os_str());

        Ok(Self {
            root: private_root,
            git_dir,
            home,
            hooks,
            index_file,
            object_directory,
            alternate_object_directories: alternates,
            real_git_dir: layout.canonical_git_dir,
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
        let environment = PrivateGitEnvironment::new(root, context)?;
        let mut command = Command::new(&self.binary.canonical_path);
        configure_command(&mut command, root, &environment, false);
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
        self.read(
            root,
            &["ls-files", "--stage", "-v", "-z"],
            GIT_LARGE_STDOUT_LIMIT,
        )
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
        let environment = PrivateGitEnvironment::new(root, context)?;
        let mut command = Command::new(&self.binary.canonical_path);
        configure_command(&mut command, root, &environment, false);
        command
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
            .env("GIT_CONFIG_SYSTEM", "/dev/null")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_ATTR_NOSYSTEM", "1")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_OPTIONAL_LOCKS", "0")
            .env("HOME", &environment.home)
            .env("XDG_CONFIG_HOME", &environment.home)
            .env("GIT_DIR", &environment.git_dir)
            .env("GIT_WORK_TREE", root)
            .env("GIT_INDEX_FILE", &environment.index_file)
            .env("GIT_OBJECT_DIRECTORY", &environment.object_directory)
            .env(
                "GIT_ALTERNATE_OBJECT_DIRECTORIES",
                &environment.alternate_object_directories,
            )
            .env("GIT_AUTHOR_NAME", &author.name)
            .env("GIT_AUTHOR_EMAIL", &author.email)
            .env("GIT_COMMITTER_NAME", &author.name)
            .env("GIT_COMMITTER_EMAIL", &author.email);
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
        if reference != "HEAD" && !is_safe_head_reference(reference) {
            return Err(GitRunnerError::Io);
        }
        if !super::git_layout::is_object_id(new_value)
            || !super::git_layout::is_object_id(old_value)
        {
            return Err(GitRunnerError::Io);
        }
        self.binary.revalidate()?;
        let environment = PrivateGitEnvironment::new(root, &GitExecutionContext::default())?;
        let mut command = Command::new(&self.binary.canonical_path);
        configure_command(&mut command, root, &environment, true);
        command
            .arg("update-ref")
            .arg("--no-deref")
            .arg(reference)
            .arg(new_value)
            .arg(old_value)
            .env_clear()
            .env("LC_ALL", "C")
            .env("LANG", "C")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_SYSTEM", "/dev/null")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_ATTR_NOSYSTEM", "1")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_OPTIONAL_LOCKS", "0")
            .env("HOME", &environment.home)
            .env("XDG_CONFIG_HOME", &environment.home)
            .env("GIT_DIR", &environment.real_git_dir)
            .env("GIT_WORK_TREE", root)
            .env("GIT_INDEX_FILE", &environment.index_file);
        let output = run_bounded_command(command, GIT_MUTATION_TIMEOUT, 4096, GIT_STDERR_LIMIT)
            .await
            .map_err(map_bounded_error)?;
        self.binary.revalidate()?;
        Ok(output)
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

fn configure_command(
    command: &mut Command,
    root: &Path,
    environment: &PrivateGitEnvironment,
    real_git_dir: bool,
) {
    let git_dir = if real_git_dir {
        &environment.real_git_dir
    } else {
        &environment.git_dir
    };
    let mut hooks_path = OsString::from("core.hooksPath=");
    hooks_path.push(environment.hooks.as_os_str());
    command
        .arg("--literal-pathspecs")
        .arg("--git-dir")
        .arg(git_dir)
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
