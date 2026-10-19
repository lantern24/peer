use crate::{hash, repository};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
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
    attributes: BTreeMap<PathBuf, AttributeStamp>,
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

#[derive(Debug, PartialEq, Eq)]
struct AttributeStamp {
    // Include every traversed symlink and its destination so a retarget cannot
    // leave a clean baseline subscribed only to the old destination.
    paths: Vec<PathBuf>,
    content: Option<[u8; 32]>,
}

fn resolve_attribute_path(
    path: &Path,
    paths: &mut Vec<PathBuf>,
    links: usize,
) -> Result<PathBuf, String> {
    if links > 40 {
        return Err(format!(
            "Too many attribute file symlinks: {}",
            path.display()
        ));
    }
    let mut resolved = PathBuf::new();
    let mut components = path.components();
    while let Some(component) = components.next() {
        match component {
            Component::CurDir => continue,
            Component::ParentDir => {
                resolved.pop();
                continue;
            }
            _ => resolved.push(component.as_os_str()),
        }
        match fs::symlink_metadata(&resolved) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                paths.push(canonical_attribute_parent(&resolved)?);
                let target = fs::read_link(&resolved)
                    .map_err(|error| format!("Cannot read attribute symlink: {error}"))?;
                resolved.pop();
                let target = resolved.join(target).join(components.as_path());
                return resolve_attribute_path(&target, paths, links + 1);
            }
            Ok(_) => {}
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
                ) => {}
            Err(error) => {
                return Err(format!(
                    "Cannot locate attributes {}: {error}",
                    resolved.display()
                ));
            }
        }
    }
    canonical_attribute_parent(&resolved)
}

fn canonical_attribute_parent(path: &Path) -> Result<PathBuf, String> {
    // Canonicalize the existing prefix even for missing files/directories,
    // retaining the native watcher's extended-length path spelling on Windows.
    for parent in path.ancestors().skip(1) {
        match fs::canonicalize(parent) {
            Ok(parent_path) => {
                let suffix = path
                    .strip_prefix(parent)
                    .map_err(|error| format!("Cannot normalize attribute path: {error}"))?;
                return Ok(parent_path.join(suffix));
            }
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
                ) => {}
            Err(error) => return Err(format!("Cannot locate attribute directory: {error}")),
        }
    }
    Ok(path.to_path_buf())
}

fn attribute_stamp(path: &Path) -> Result<AttributeStamp, String> {
    let mut paths = vec![canonical_attribute_parent(path)?];
    let resolved = resolve_attribute_path(path, &mut paths, 0)?;
    paths.push(resolved);
    paths.sort();
    paths.dedup();
    // Let the OS resolve the original spelling for reads: a missing component
    // followed by `..` must not accidentally read a different existing file.
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
            ) =>
        {
            return Ok(AttributeStamp {
                paths,
                content: None,
            });
        }
        Err(error) => {
            return Err(format!(
                "Cannot inspect attributes {}: {error}",
                path.display()
            ));
        }
    };
    // Never open pipes/devices or silently advertise unreadable inputs as clean.
    if !metadata.is_file() {
        return Err(format!(
            "Attributes path is not a regular file: {}",
            path.display()
        ));
    }
    let mut file = fs::File::open(path)
        .map_err(|error| format!("Cannot open attributes {}: {error}", path.display()))?;
    let mut digest = Sha256::new();
    let mut buffer = [0; 16 * 1024];
    loop {
        let count = match file.read(&mut buffer) {
            Ok(count) => count,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => {
                return Err(format!(
                    "Cannot read attributes {}: {error}",
                    path.display()
                ));
            }
        };
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(AttributeStamp {
        paths,
        content: Some(digest.finalize().into()),
    })
}

async fn attribute_path(
    git: &str,
    root: &Path,
    arguments: &[&str],
) -> Result<Option<PathBuf>, String> {
    // Exit 1 with no output means an unset config key or a supported but
    // disabled variable, notably GIT_ATTR_NOSYSTEM.
    let output = tokio::process::Command::new(git)
        .arg("--no-pager")
        .args(arguments)
        .current_dir(root)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .kill_on_drop(true)
        .output()
        .await
        .map_err(|error| format!("Cannot discover Git attributes: {error}"))?;
    if output.status.code() == Some(1) && output.stdout.is_empty() && output.stderr.is_empty() {
        return Ok(None);
    }
    if !output.status.success() {
        return Err(format!(
            "Cannot discover Git attributes via {} (requires Git 2.42 or newer): {}",
            arguments.join(" "),
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    attribute_output_path(root, &output.stdout)
}

fn attribute_output_path(root: &Path, bytes: &[u8]) -> Result<Option<PathBuf>, String> {
    let path = std::str::from_utf8(bytes).map_err(|_| "Git attribute path is not UTF-8")?;
    // Remove only Git's output terminator; newlines may be part of a filename.
    let path = path.strip_suffix('\n').unwrap_or(path);
    #[cfg(windows)]
    let path = path.strip_suffix('\r').unwrap_or(path);
    if path.is_empty() {
        return Ok(None);
    }
    Ok(Some(root.join(path)))
}

async fn attribute_files(git: &str, root: &Path) -> Result<Vec<PathBuf>, String> {
    let bytes = repository::git(git, root, &["rev-parse", "--git-path", "info/attributes"]).await?;
    let info =
        attribute_output_path(root, &bytes)?.ok_or("Git returned no info/attributes path")?;
    let mut files = vec![info];
    // Preserve the source spelling: rev-parse's absolute path mode follows
    // symlinks, while `git var` removes `..` even after a missing component.
    // Git config's path type expands `~` without changing that access path.
    let global = match attribute_path(
        git,
        root,
        &["config", "--path", "--get", "core.attributesFile"],
    )
    .await?
    {
        Some(path) => Some(path),
        None => attribute_path(git, root, &["var", "GIT_ATTR_GLOBAL"]).await?,
    };
    // Git owns installation prefixes, XDG/HOME defaults and NOSYSTEM semantics.
    files.extend(global);
    files.extend(attribute_path(git, root, &["var", "GIT_ATTR_SYSTEM"]).await?);
    files.sort();
    files.dedup();
    Ok(files)
}

impl RepositoryBaseline {
    pub(crate) async fn capture(
        git: &str,
        root: &Path,
        base_ref: Option<&str>,
    ) -> Result<Arc<Self>, String> {
        let git_dir = git_directory(git, root, "--git-dir").await?;
        let common_dir = git_directory(git, root, "--git-common-dir").await?;
        let attribute_files = attribute_files(git, root).await?;
        let base_revision = base_ref.map(|reference| format!("{reference}^{{commit}}"));
        let state = git_state(git, root, &git_dir, base_revision.as_deref()).await?;
        let bytes = inventory(git, root).await?;
        let owned_root = root.to_path_buf();
        let (state, files, attributes) = tokio::task::spawn_blocking(move || {
            let attributes = attribute_files
                .into_iter()
                .map(|path| attribute_stamp(&path).map(|stamp| (path, stamp)))
                .collect::<Result<BTreeMap<_, _>, _>>()?;
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
            Ok::<_, String>((state, files, attributes))
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
            attributes,
            base_revision,
            state,
            files,
        }))
    }

    pub fn watch_paths(&self) -> &[PathBuf] {
        &self.watch_paths
    }

    /// Attribute files and symlink targets, including absent paths. Watch their
    /// containing directories non-recursively, following ancestor creation hints.
    pub fn attribute_paths(&self) -> impl Iterator<Item = &Path> {
        self.attributes
            .values()
            .flat_map(|stamp| stamp.paths.iter().map(PathBuf::as_path))
    }

    /// Filter Git housekeeping and read/access feedback before waking a probe.
    /// Other paths are only hints; the Git-aware inventory is authoritative.
    pub fn relevant_event_path(&self, path: &Path) -> bool {
        if self
            .attribute_paths()
            .any(|attribute| attribute.starts_with(path))
        {
            return true;
        }
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
        let baseline = Arc::clone(self);
        if tokio::task::spawn_blocking(move || {
            for (path, stamp) in &baseline.attributes {
                if attribute_stamp(path)? != *stamp {
                    return Ok::<_, String>(true);
                }
            }
            Ok(false)
        })
        .await
        .map_err(|error| format!("Cannot inspect attribute files: {error}"))??
        {
            return Ok(true);
        }
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
