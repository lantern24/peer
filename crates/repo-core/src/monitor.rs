use crate::{hash, repository};
use std::{
    collections::BTreeMap,
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::Arc,
    time::SystemTime,
};

/// Source metadata only: retaining a watch never retains file bodies, navigation
/// inventories, review state, or the snapshot that supplied this baseline.
#[derive(Debug)]
pub struct RepositoryBaseline {
    root: PathBuf,
    git: String,
    git_dir: PathBuf,
    common_dir: PathBuf,
    watch_paths: Vec<PathBuf>,
    base_revision: Option<String>,
    state: GitState,
    files: BTreeMap<String, FileStamp>,
}

#[derive(Debug, PartialEq, Eq)]
struct GitState {
    index: String,
    revisions: String,
    head: String,
}

#[derive(Debug, PartialEq, Eq)]
struct FileStamp {
    len: u64,
    modified: Option<SystemTime>,
    created: Option<SystemTime>,
    readonly: bool,
    directory: bool,
    target: Option<PathBuf>,
    #[cfg(unix)]
    identity: (u64, u64, i64, i64, u32),
}

fn file_stamp(root: &Path, path: &str) -> Result<Option<FileStamp>, String> {
    let absolute = repository::safe_path(root, path)?;
    let metadata = match fs::symlink_metadata(&absolute) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Cannot inspect {path}: {error}")),
    };
    #[cfg(unix)]
    let identity = {
        use std::os::unix::fs::MetadataExt;
        (
            metadata.dev(),
            metadata.ino(),
            metadata.ctime(),
            metadata.ctime_nsec(),
            metadata.mode(),
        )
    };
    Ok(Some(FileStamp {
        len: metadata.len(),
        modified: metadata.modified().ok(),
        created: metadata.created().ok(),
        readonly: metadata.permissions().readonly(),
        directory: metadata.is_dir(),
        target: if metadata.file_type().is_symlink() {
            Some(
                fs::read_link(&absolute)
                    .map_err(|error| format!("Cannot inspect {path}: {error}"))?,
            )
        } else {
            None
        },
        #[cfg(unix)]
        identity,
    }))
}

// Cached paths remain included even if they also match an ignore rule. Git owns
// exclusion semantics, including nested .gitignore and info/global excludes.
async fn inventory(git: &str, root: &Path) -> Result<Vec<u8>, String> {
    repository::git(
        git,
        root,
        &[
            "ls-files",
            "-z",
            "--cached",
            "--others",
            "--exclude-standard",
        ],
    )
    .await
}

fn paths(bytes: &[u8]) -> impl Iterator<Item = Result<&str, String>> {
    bytes
        .split(|byte| *byte == 0)
        .filter(|path| !path.is_empty())
        .map(|path| {
            std::str::from_utf8(path)
                .map_err(|_| "This repository contains a filename that is not valid UTF-8".into())
        })
}

async fn git_hash(git: &str, root: &Path, args: &[&str]) -> Result<String, String> {
    let bytes = repository::git(git, root, args).await?;
    tokio::task::spawn_blocking(move || hash(&bytes))
        .await
        .map_err(|error| format!("Cannot inspect Git metadata: {error}"))
}

async fn git_state(
    git: &str,
    root: &Path,
    git_dir: &Path,
    base_revision: Option<&str>,
) -> Result<GitState, String> {
    // Logical index entries deliberately exclude Git's refreshable stat cache,
    // lock files, reflogs, object storage, and packed-ref representation changes.
    // No diff/status command or source-content hashing is needed for a probe.
    let index = git_hash(git, root, &["ls-files", "--stage", "-v", "-z"]).await?;
    // Resolve only revisions used by this comparison. Other worktrees' refs
    // and Git configuration may wake a probe but do not make this review stale.
    // --revs-only emits nothing for an unborn HEAD or a removed base ref.
    let revisions = match base_revision {
        Some(base) => {
            git_hash(
                git,
                root,
                &[
                    "rev-parse",
                    "--revs-only",
                    "--end-of-options",
                    "HEAD^{commit}",
                    base,
                ],
            )
            .await?
        }
        None => {
            git_hash(
                git,
                root,
                &[
                    "rev-parse",
                    "--revs-only",
                    "--end-of-options",
                    "HEAD^{commit}",
                ],
            )
            .await?
        }
    };
    // Preserve symbolic/unborn/detached branch identity as well as its commit.
    let head_path = git_dir.join("HEAD");
    let head = tokio::task::spawn_blocking(move || {
        let mut bytes = Vec::new();
        fs::File::open(head_path)
            .and_then(|file| file.take(65_537).read_to_end(&mut bytes))
            .map_err(|error| format!("Cannot inspect Git HEAD: {error}"))?;
        if bytes.len() > 65_536 {
            return Err("Git HEAD exceeds the inspection limit".to_owned());
        }
        Ok(hash(&bytes))
    })
    .await
    .map_err(|error| format!("Cannot inspect Git HEAD: {error}"))??;
    Ok(GitState {
        index,
        revisions,
        head,
    })
}

async fn git_directory(git: &str, root: &Path, argument: &str) -> Result<PathBuf, String> {
    let bytes = repository::git(
        git,
        root,
        &["rev-parse", "--path-format=absolute", argument],
    )
    .await?;
    let path = std::str::from_utf8(&bytes)
        .map_err(|_| "Git directory path is not UTF-8")?
        .trim_end_matches(['\r', '\n']);
    let path = PathBuf::from(path);
    tokio::task::spawn_blocking(move || {
        fs::canonicalize(path).map_err(|error| format!("Cannot locate Git directory: {error}"))
    })
    .await
    .map_err(|error| format!("Cannot inspect Git directory: {error}"))?
}

impl RepositoryBaseline {
    pub(crate) async fn capture(
        git: &str,
        root: &Path,
        base_ref: Option<&str>,
    ) -> Result<Arc<Self>, String> {
        let git_dir = git_directory(git, root, "--git-dir").await?;
        let common_dir = git_directory(git, root, "--git-common-dir").await?;
        let base_revision = base_ref.map(|reference| format!("{reference}^{{commit}}"));
        let state = git_state(git, root, &git_dir, base_revision.as_deref()).await?;
        let bytes = inventory(git, root).await?;
        let owned_root = root.to_path_buf();
        let files = tokio::task::spawn_blocking(move || {
            let mut files = BTreeMap::new();
            for path in paths(&bytes) {
                let path = path?;
                if let Some(stamp) = file_stamp(&owned_root, path)? {
                    files.insert(path.to_owned(), stamp);
                }
            }
            Ok::<_, String>(files)
        })
        .await
        .map_err(|error| format!("Cannot inspect repository files: {error}"))??;
        let mut watch_paths = vec![root.to_path_buf(), git_dir.clone(), common_dir.clone()];
        watch_paths.sort();
        watch_paths.dedup();
        let mut parents: Vec<PathBuf> = Vec::new();
        for path in watch_paths {
            if !parents.iter().any(|parent| path.starts_with(parent)) {
                parents.push(path);
            }
        }
        Ok(Arc::new(Self {
            root: root.to_path_buf(),
            git: git.to_owned(),
            git_dir,
            common_dir,
            watch_paths: parents,
            base_revision,
            state,
            files,
        }))
    }

    pub fn watch_paths(&self) -> &[PathBuf] {
        &self.watch_paths
    }

    /// Filter Git housekeeping and read/access feedback before waking a probe.
    /// Other paths are only hints; the Git-aware inventory is authoritative.
    pub fn relevant_event_path(&self, path: &Path) -> bool {
        for directory in [&self.git_dir, &self.common_dir] {
            if let Ok(relative) = path.strip_prefix(directory) {
                return relative.as_os_str().is_empty()
                    || matches!(
                        relative.to_str(),
                        Some(
                            "HEAD"
                                | "index"
                                | "packed-refs"
                                | "config"
                                | "config.worktree"
                                | "shallow"
                                | "commondir"
                                | "gitdir"
                                | "info/exclude"
                                | "info/sparse-checkout"
                        )
                    )
                    || relative.starts_with("refs")
                    || relative.starts_with("reftable");
            }
        }
        path.starts_with(&self.root)
    }

    /// Compare against the baseline captured while opening, never a fresh
    /// snapshot. Metadata catches further edits to files already dirty at open,
    /// while inventory detects additions, deletions, renames, and ignore changes.
    pub async fn probe(self: &Arc<Self>) -> Result<bool, String> {
        if git_state(
            &self.git,
            &self.root,
            &self.git_dir,
            self.base_revision.as_deref(),
        )
        .await?
            != self.state
        {
            return Ok(true);
        }
        let bytes = inventory(&self.git, &self.root).await?;
        let baseline = Arc::clone(self);
        tokio::task::spawn_blocking(move || {
            let mut present = 0;
            let mut previous = None;
            // Untracked and cached paths do not overlap; repeated unmerged
            // stages are adjacent. No second path collection is necessary.
            for path in paths(&bytes) {
                let path = path?;
                if previous == Some(path) {
                    continue;
                }
                previous = Some(path);
                let stamp = file_stamp(&baseline.root, path)?;
                if stamp.as_ref() != baseline.files.get(path) {
                    return Ok(true);
                }
                present += usize::from(stamp.is_some());
            }
            Ok(present != baseline.files.len())
        })
        .await
        .map_err(|error| format!("Cannot inspect repository files: {error}"))?
    }
}
