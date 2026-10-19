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
    configuration: BTreeMap<String, String>,
    submodules: BTreeMap<String, SubmoduleState>,
}

#[derive(Debug, PartialEq, Eq)]
struct SubmoduleState {
    diff: String,
    git_dir: Option<PathBuf>,
    common_dir: Option<PathBuf>,
}

// Only settings consumed by inventory, working-tree conversion, or the Git
// comparisons we expose. Identity, remotes, colors, external diff and textconv
// settings do not affect those comparisons.
fn comparison_config(key: &str) -> bool {
    matches!(
        key,
        "core.filemode"
            | "core.symlinks"
            | "core.ignorecase"
            | "core.autocrlf"
            | "core.eol"
            | "core.safecrlf"
            | "core.checkroundtripencoding"
            | "core.attributesfile"
            | "core.excludesfile"
            | "core.bigfilethreshold"
            | "core.sparsecheckout"
            | "core.sparsecheckoutcone"
            | "diff.algorithm"
            | "diff.renamelimit"
            | "diff.ignoresubmodules"
            | "diff.indentheuristic"
            | "diff.noprefix"
            | "diff.mnemonicprefix"
            | "diff.srcprefix"
            | "diff.dstprefix"
            | "diff.relative"
    ) || (key.starts_with("diff.") && (key.ends_with(".binary") || key.ends_with(".algorithm")))
        || (key.starts_with("filter.")
            && [".clean", ".process", ".required"]
                .iter()
                .any(|suffix| key.ends_with(suffix)))
        || (key.starts_with("submodule.") && key.ends_with(".ignore"))
}

async fn configuration(git: &str, root: &Path) -> Result<BTreeMap<String, String>, String> {
    // Git resolves system/global/includes/local/worktree configuration in
    // precedence order. Keep the effective value rather than file bytes or
    // shadowed entries; reordering unrelated settings is not a source change.
    let bytes = repository::git(git, root, &["config", "--null", "--list", "--includes"]).await?;
    let mut values = BTreeMap::new();
    for entry in paths(&bytes) {
        let entry = entry?;
        let (key, value) = entry.split_once('\n').unwrap_or((entry, "true"));
        if comparison_config(key) {
            values.insert(key.to_owned(), value.to_owned());
        }
    }
    Ok(values)
}

async fn submodules(
    git: &str,
    root: &Path,
    index: &[u8],
) -> Result<BTreeMap<String, SubmoduleState>, String> {
    let mut states = BTreeMap::new();
    for entry in paths(index) {
        let entry = entry?;
        let (header, path) = entry
            .split_once('\t')
            .ok_or("Cannot parse Git index entry")?;
        if header.split_whitespace().nth(1) != Some("160000") || states.contains_key(path) {
            continue;
        }
        let absolute = repository::safe_path(root, path)?;
        let owned = absolute.clone();
        let initialized = tokio::task::spawn_blocking(move || {
            match fs::symlink_metadata(&owned) {
                Ok(metadata) if metadata.file_type().is_symlink() => {
                    return Err("Refusing to follow a submodule directory symlink".to_owned());
                }
                Ok(metadata) if metadata.is_dir() => {}
                // A gitlink replaced by an ordinary file uses normal file
                // metadata; never materialize its source body in a probe.
                Ok(_) => return Ok(None),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    return Ok(Some(false));
                }
                Err(error) => return Err(format!("Cannot inspect submodule: {error}")),
            }
            match fs::symlink_metadata(owned.join(".git")) {
                Ok(_) => Ok(Some(true)),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Some(false)),
                Err(error) => Err(format!("Cannot inspect submodule Git directory: {error}")),
            }
        })
        .await
        .map_err(|error| format!("Cannot inspect submodule: {error}"))??;
        let Some(initialized) = initialized else {
            continue;
        };
        // A short gitlink patch records the actual checked-out HEAD and dirty
        // marker (including nested modules), not just the containing directory's
        // stat. Run sequentially per gitlink, never per source file. Git diff's
        // stat-cache refresh also needs disabling; optional locks alone do not
        // prevent it from rewriting the superproject index.
        let diff = git_hash(
            git,
            root,
            &[
                "-c",
                "diff.autoRefreshIndex=false",
                "--literal-pathspecs",
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                "--submodule=short",
                "--ignore-submodules=none",
                "--",
                path,
            ],
        )
        .await?;
        let (git_dir, common_dir) = if initialized {
            (
                Some(git_directory(git, &absolute, "--git-dir").await?),
                Some(git_directory(git, &absolute, "--git-common-dir").await?),
            )
        } else {
            (None, None)
        };
        states.insert(
            path.to_owned(),
            SubmoduleState {
                diff,
                git_dir,
                common_dir,
            },
        );
    }
    Ok(states)
}

fn relevant_git_path(relative: &Path) -> bool {
    relative.as_os_str().is_empty()
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
                    | "info/attributes"
                    | "info/sparse-checkout"
            )
        )
        || relative.starts_with("refs")
        || relative.starts_with("reftable")
        // Absorbed and nested submodules live below modules/<name>. Their
        // metadata can change without an event anywhere in their worktree.
        || (relative.starts_with("modules")
            && relative.ancestors().any(|path| {
                path.file_name()
                    .is_some_and(|name| name == "refs" || name == "reftable")
            }))
        || (relative.starts_with("modules")
            && relative.file_name().is_some_and(|name| {
                matches!(
                    name.to_str(),
                    Some(
                        "HEAD"
                            | "index"
                            | "packed-refs"
                            | "config"
                            | "config.worktree"
                            | "exclude"
                            | "attributes"
                    )
                )
            }))
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
    let index_bytes = repository::git(git, root, &["ls-files", "--stage", "-v", "-z"]).await?;
    let submodules = submodules(git, root, &index_bytes).await?;
    let index = tokio::task::spawn_blocking(move || hash(&index_bytes))
        .await
        .map_err(|error| format!("Cannot inspect Git index: {error}"))?;
    let configuration = configuration(git, root).await?;
    // Resolve only revisions used by this comparison. Other worktrees' refs
    // may wake a probe but do not make this review stale.
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
        configuration,
        submodules,
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
        let (state, files) = tokio::task::spawn_blocking(move || {
            let mut files = BTreeMap::new();
            for path in paths(&bytes) {
                let path = path?;
                if state.submodules.contains_key(path) {
                    continue;
                }
                if let Some(stamp) = file_stamp(&owned_root, path)? {
                    files.insert(path.to_owned(), stamp);
                }
            }
            Ok::<_, String>((state, files))
        })
        .await
        .map_err(|error| format!("Cannot inspect repository files: {error}"))??;
        let mut watch_paths = vec![root.to_path_buf(), git_dir.clone(), common_dir.clone()];
        for submodule in state.submodules.values() {
            watch_paths.extend(submodule.git_dir.iter().cloned());
            watch_paths.extend(submodule.common_dir.iter().cloned());
        }
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
        // Check the most specific module directories before their containing
        // superproject Git directory, which otherwise filters modules away.
        for directory in self
            .state
            .submodules
            .values()
            .flat_map(|module| module.git_dir.iter().chain(module.common_dir.iter()))
        {
            if let Ok(relative) = path.strip_prefix(directory) {
                return relevant_git_path(relative);
            }
        }
        for directory in [&self.git_dir, &self.common_dir] {
            if let Ok(relative) = path.strip_prefix(directory) {
                return relevant_git_path(relative);
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
                if baseline.state.submodules.contains_key(path) {
                    continue;
                }
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
