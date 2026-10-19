use crate::{hash, types::*};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Component, Path, PathBuf},
    time::UNIX_EPOCH,
};
use tokio::process::Command;

pub const MAX_BYTES: u64 = 1024 * 1024;
pub const MAX_LINES: u64 = 20_000;
const HARD_LIMIT: u64 = 64 * 1024 * 1024;
pub const STALE: &str =
    "Source changed since this snapshot. Refresh the repository before continuing.";

#[derive(Clone, Debug)]
pub enum Source {
    Empty,
    Working(String),
    Git(String),
}
#[derive(Clone, Debug)]
pub struct Record {
    pub entry: FileEntry,
    pub old: Source,
    pub new: Source,
    pub stamp: String,
    pub metadata: String,
}
#[derive(Clone, Debug)]
pub struct RepositorySnapshot {
    pub data: Snapshot,
    pub records: BTreeMap<String, Record>,
    pub signature: String,
    pub git: String,
    pub navigation: BTreeMap<String, crate::navigation::Inventory>,
    pub repository_watch:
        Result<Option<std::sync::Arc<crate::monitor::RepositoryBaseline>>, String>,
}

pub fn discover_git(override_path: Option<&str>) -> String {
    if let Some(path) = override_path.filter(|s| !s.trim().is_empty()) {
        return path.into();
    }
    for directory in std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()) {
        let candidate = directory.join(if cfg!(windows) { "git.exe" } else { "git" });
        if candidate.is_file() {
            return candidate.to_string_lossy().to_string();
        }
    }
    for path in [
        "/opt/homebrew/bin/git",
        "/usr/local/bin/git",
        "/usr/bin/git",
        "C:\\Program Files\\Git\\cmd\\git.exe",
    ] {
        if Path::new(path).is_file() {
            return path.into();
        }
    }
    "git".into()
}

pub async fn git(git: &str, root: &Path, args: &[&str]) -> Result<Vec<u8>, String> {
    let output = Command::new(git)
        .arg("--no-pager")
        .args(["-c", "core.quotepath=false", "-c", "color.ui=false"])
        .args(args)
        .current_dir(root)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .kill_on_drop(true)
        .output()
        .await
        .map_err(|e| {
            format!(
                "Cannot run Git ({git}): {e}. Install Git or select its executable in Settings."
            )
        })?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(output.stdout)
}
fn utf8(bytes: &[u8]) -> Result<String, String> {
    String::from_utf8(bytes.to_vec())
        .map_err(|_| "This repository contains a filename that is not valid UTF-8".into())
}
async fn text(g: &str, root: &Path, args: &[&str]) -> Result<String, String> {
    Ok(utf8(&git(g, root, args).await?)?
        .trim_end_matches(['\r', '\n'])
        .to_string())
}

pub async fn commits(
    g: &str,
    root: &Path,
    head: &str,
    offset: u32,
    limit: u32,
) -> Result<CommitPage, String> {
    let limit = limit.clamp(1, 100) as usize;
    let bytes = git(
        g,
        root,
        &[
            "log",
            "--topo-order",
            "-z",
            "--no-show-signature",
            "--format=%H%x00%h%x00%s%x00%an%x00%cI%x00%P",
            &format!("--skip={offset}"),
            &format!("--max-count={}", limit + 1),
            head,
            "--",
        ],
    )
    .await?;
    let mut fields: Vec<_> = bytes.split(|b| *b == 0).collect();
    if fields.last() == Some(&&b""[..]) {
        fields.pop();
    }
    if fields.len() % 6 != 0 {
        return Err("Invalid Git commit record".into());
    }
    let mut commits = fields
        .chunks_exact(6)
        .map(|row| {
            Ok(Commit {
                id: utf8(row[0])?,
                short_id: utf8(row[1])?,
                subject: utf8(row[2])?,
                author: utf8(row[3])?,
                committed_at: utf8(row[4])?,
                parents: utf8(row[5])?
                    .split_whitespace()
                    .map(str::to_owned)
                    .collect(),
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let has_more = commits.len() > limit;
    commits.truncate(limit);
    Ok(CommitPage { commits, has_more })
}

pub fn safe_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let path = Path::new(relative);
    if path
        .components()
        .any(|c| !matches!(c, Component::Normal(_)))
        || relative.is_empty()
    {
        return Err("Invalid repository path".into());
    }
    let mut check = root.to_path_buf();
    let components: Vec<_> = path.components().collect();
    for part in &components[..components.len().saturating_sub(1)] {
        check.push(part.as_os_str());
        if fs::symlink_metadata(&check).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err("Refusing to follow a directory symlink".into());
        }
    }
    Ok(root.join(path))
}
pub fn stamp(root: &Path, path: &str) -> Result<String, String> {
    match fs::symlink_metadata(safe_path(root, path)?) {
        Ok(m) => {
            let time = m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|t| t.as_nanos())
                .unwrap_or(0);
            let target = if m.file_type().is_symlink() {
                fs::read_link(root.join(path))
                    .map_err(|e| e.to_string())?
                    .to_string_lossy()
                    .to_string()
            } else {
                String::new()
            };
            Ok(format!("{}:{time}:{}:{target}", m.len(), m.is_dir()))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok("missing".into()),
        Err(e) => Err(e.to_string()),
    }
}
pub async fn signature(g: &str, root: &Path) -> Result<String, String> {
    let head = text(g, root, &["rev-parse", "--verify", "HEAD"])
        .await
        .unwrap_or_default();
    let index = text(g, root, &["rev-parse", "--git-path", "index"]).await?;
    let path = Path::new(&index);
    let bytes = match fs::read(if path.is_absolute() {
        path.to_path_buf()
    } else {
        root.join(path)
    }) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => vec![],
        Err(e) => return Err(e.to_string()),
    };
    let branch = text(g, root, &["symbolic-ref", "--quiet", "HEAD"])
        .await
        .unwrap_or_default();
    Ok(hash(format!("{head}:{branch}:{}", hash(&bytes)).as_bytes()))
}

pub async fn create_snapshot(
    path: &str,
    mut comparison: Comparison,
    git_path: Option<&str>,
    repository_ids: &BTreeMap<String, String>,
) -> Result<RepositorySnapshot, String> {
    comparison.validate()?;
    if comparison.view == "code" {
        comparison = Comparison {
            view: "code".into(),
            ..Comparison::default()
        };
    }
    let g = discover_git(git_path);
    let location = fs::canonicalize(path).map_err(|e| format!("Cannot open repository: {e}"))?;
    let root_string = text(&g, &location, &["rev-parse", "--show-toplevel"])
        .await
        .map_err(|e| format!("Choose a Git working directory. {e}"))?;
    let root = fs::canonicalize(root_string).map_err(|e| e.to_string())?;
    // Capture before collecting any displayed inventory/content. A second probe
    // below rejects mixed-time snapshots, and activation reuses this baseline.
    // Monitoring failures are reported separately, never a reason to deny review.
    let mut repository_watch = if comparison.mode == "commit" {
        Ok(None)
    } else {
        crate::monitor::RepositoryBaseline::capture(
            &g,
            &root,
            if comparison.mode == "branch" {
                comparison.base_ref.as_deref()
            } else {
                None
            },
        )
        .await
        .map(Some)
    };
    let signature_before = signature(&g, &root).await?;
    let head = text(&g, &root, &["rev-parse", "--verify", "HEAD"])
        .await
        .ok();
    let branch = text(&g, &root, &["symbolic-ref", "--quiet", "--short", "HEAD"])
        .await
        .unwrap_or_else(|_| format!("detached:{}", head.as_deref().unwrap_or("unborn")));
    let root_string = root
        .to_str()
        .ok_or("Repository path is not UTF-8")?
        .to_string();
    let repository = Repository {
        id: repository_ids
            .get(&root_string)
            .cloned()
            .unwrap_or_else(|| {
                let id = hash(root_string.as_bytes());
                // A moved repository keeps its identity. Reusing its old
                // directory must not attach that repository's reviews.
                if repository_ids.values().any(|saved| saved == &id) {
                    uuid::Uuid::new_v4().to_string()
                } else {
                    id
                }
            }),
        name: root
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string(),
        root: root_string,
        branch,
        head: head.clone(),
    };
    let commit = if comparison.mode == "commit" {
        let reference = format!(
            "{}^{{commit}}",
            comparison.base_ref.as_deref().unwrap_or("")
        );
        let oid = text(
            &g,
            &root,
            &["rev-parse", "--verify", "--end-of-options", &reference],
        )
        .await?;
        let mut commit = commits(&g, &root, &oid, 0, 1)
            .await?
            .commits
            .into_iter()
            .next()
            .ok_or("Commit not found")?;
        // Git log hides parents at shallow boundaries. Read the actual header
        // so a truncated history never turns a normal commit into a root diff.
        let object = git(&g, &root, &["cat-file", "commit", &oid]).await?;
        commit.parents = object
            .split(|b| *b == b'\n')
            .take_while(|line| !line.is_empty())
            .filter_map(|line| line.strip_prefix(b"parent "))
            .map(utf8)
            .collect::<Result<_, _>>()?;
        comparison.base_ref = Some(commit.id.clone());
        comparison.include_untracked = false;
        Some(commit)
    } else {
        None
    };
    let mut base = if let Some(commit) = &commit {
        commit.parents.first().cloned()
    } else {
        head.clone()
    };
    if comparison.mode == "branch" {
        let reference = format!(
            "{}^{{commit}}",
            comparison.base_ref.as_deref().unwrap_or("")
        );
        let reference = text(
            &g,
            &root,
            &["rev-parse", "--verify", "--end-of-options", &reference],
        )
        .await?;
        base = Some(
            text(
                &g,
                &root,
                &[
                    "merge-base",
                    &reference,
                    head.as_deref()
                        .ok_or("Branch comparison requires an initial commit")?,
                ],
            )
            .await?,
        );
    }
    let inventory = if commit.is_some() {
        vec![]
    } else {
        git(
            &g,
            &root,
            &[
                "ls-files",
                "-z",
                "--cached",
                "--others",
                "--exclude-standard",
            ],
        )
        .await?
    };
    let tracked_bytes = if commit.is_some() {
        vec![]
    } else {
        git(&g, &root, &["ls-files", "-z", "--cached"]).await?
    };
    let tracked: BTreeSet<String> = tracked_bytes
        .split(|b| *b == 0)
        .filter(|b| !b.is_empty())
        .map(utf8)
        .collect::<Result<_, _>>()?;
    let unmerged = if commit.is_some() {
        vec![]
    } else {
        git(&g, &root, &["ls-files", "--unmerged", "-z"]).await?
    };
    let conflicts: BTreeSet<String> = unmerged
        .split(|b| *b == 0)
        .filter_map(|row| {
            row.iter()
                .position(|b| *b == b'\t')
                .map(|i| utf8(&row[i + 1..]))
        })
        .collect::<Result<_, _>>()?;
    let all: BTreeSet<String> = inventory
        .split(|b| *b == 0)
        .filter(|b| !b.is_empty())
        .map(utf8)
        .collect::<Result<_, _>>()?;
    let index_metadata = if let Some(commit) = &commit {
        parse_object_metadata(&git(&g, &root, &["ls-tree", "-r", "-z", &commit.id]).await?)?
    } else {
        parse_object_metadata(&git(&g, &root, &["ls-files", "--stage", "-z"]).await?)?
    };
    let base_metadata = if let Some(base) = &base {
        let tree = git(&g, &root, &["ls-tree", "-r", "-z", base]).await.map_err(|error| {
            if commit.is_some() {
                format!("Cannot read this commit's parent. Its history may be missing locally. {error}")
            } else { error }
        })?;
        parse_object_metadata(&tree)?
    } else {
        BTreeMap::new()
    };
    let mut changes: Vec<(String, Option<String>, String)> = vec![];
    let mut stats = BTreeMap::new();
    if comparison.view == "code" || (head.is_none() && comparison.mode == "all") {
        for path in &all {
            if fs::symlink_metadata(safe_path(&root, path)?).is_err() {
                continue;
            }
            if comparison.view != "code" && !comparison.include_untracked && !tracked.contains(path)
            {
                continue;
            }
            changes.push((
                path.clone(),
                None,
                if comparison.view == "code" {
                    if tracked.contains(path) {
                        "tracked"
                    } else {
                        "untracked"
                    }
                } else {
                    "added"
                }
                .into(),
            ));
        }
    } else {
        let mut args = vec!["diff", "--no-ext-diff", "--no-textconv", "--find-renames"];
        if commit.is_some() && base.is_none() {
            args = vec![
                "diff-tree",
                "--root",
                "--no-commit-id",
                "-r",
                "--no-ext-diff",
                "--no-textconv",
                "--find-renames",
            ];
        }
        if comparison.mode == "staged" {
            args.push("--cached");
        }
        if comparison.mode != "unstaged" {
            if let Some(base) = &base {
                args.push(base);
            }
        }
        if let Some(commit) = &commit {
            args.push(&commit.id);
        }
        let mut names_args = args.clone();
        names_args.extend(["--name-status", "-z", "--"]);
        let mut stats_args = args.clone();
        stats_args.extend(["--numstat", "-z", "--"]);
        let (names, numbers) =
            tokio::try_join!(git(&g, &root, &names_args), git(&g, &root, &stats_args))?;
        changes = parse_names(&names)?;
        stats = parse_stats(&numbers)?;
        if comparison.include_untracked && comparison.mode != "staged" && commit.is_none() {
            let existing: BTreeSet<String> = changes.iter().map(|c| c.0.clone()).collect();
            for path in all.difference(&tracked) {
                if !existing.contains(path) {
                    changes.push((path.clone(), None, "untracked".into()));
                }
            }
        }
    }
    let mut records = BTreeMap::new();
    for (path, old_path, status) in changes {
        let status = if conflicts.contains(&path) {
            "conflict".to_string()
        } else {
            status
        };
        let absolute = if commit.is_some() {
            root.join(&path)
        } else {
            safe_path(&root, &path)?
        };
        let metadata = if commit.is_some() {
            None
        } else {
            fs::symlink_metadata(&absolute).ok()
        };
        let previous_path = old_path.as_deref().unwrap_or(&path);
        let old_info = if comparison.mode == "unstaged" {
            index_metadata.get(previous_path)
        } else {
            base_metadata.get(previous_path)
        };
        let new_info = index_metadata.get(&path);
        let kind = if status == "conflict" {
            "conflict"
        } else if metadata.as_ref().is_some_and(|m| m.is_dir())
            || old_info.is_some_and(|i| i.starts_with("160000"))
            || new_info.is_some_and(|i| i.starts_with("160000"))
        {
            "submodule"
        } else if metadata
            .as_ref()
            .is_some_and(|m| m.file_type().is_symlink())
            || old_info.is_some_and(|i| i.starts_with("120000"))
            || new_info.is_some_and(|i| i.starts_with("120000"))
        {
            "symlink"
        } else {
            "text"
        };
        let size = metadata.as_ref().map(|m| m.len()).unwrap_or(0);
        let (mut additions, deletions, mut binary) = stats.get(&path).copied().unwrap_or_default();
        if comparison.view == "changes"
            && ["added", "untracked"].contains(&status.as_str())
            && !stats.contains_key(&path)
            && size <= MAX_BYTES
            && metadata.as_ref().is_some_and(|m| m.is_file())
        {
            if let Ok(bytes) = fs::read(&absolute) {
                binary = bytes.contains(&0) || std::str::from_utf8(&bytes).is_err();
                if !binary {
                    additions = bytes.iter().filter(|b| **b == b'\n').count() as u64
                        + u64::from(!bytes.is_empty() && bytes.last() != Some(&b'\n'));
                }
            }
        }
        let id = hash(path.as_bytes());
        let entry = FileEntry {
            id: id.clone(),
            path: path.clone(),
            old_path: old_path.clone(),
            status: status.clone(),
            kind: if binary && kind == "text" {
                "binary"
            } else {
                kind
            }
            .into(),
            additions,
            deletions,
            size,
            deferred: size > MAX_BYTES || additions + deletions > MAX_LINES,
        };
        let old_name = old_path.as_deref().unwrap_or(&path);
        let old = if comparison.view == "code"
            || ["added", "untracked", "conflict"].contains(&status.as_str())
        {
            Source::Empty
        } else if comparison.mode == "unstaged" {
            Source::Git(format!(":{old_name}"))
        } else {
            base.as_ref()
                .map(|b| Source::Git(format!("{b}:{old_name}")))
                .unwrap_or(Source::Empty)
        };
        let new = if status == "deleted" {
            Source::Empty
        } else if let Some(commit) = &commit {
            Source::Git(format!("{}:{path}", commit.id))
        } else if comparison.mode == "staged" && comparison.view != "code" && kind != "conflict" {
            Source::Git(format!(":{path}"))
        } else {
            Source::Working(path.clone())
        };
        let working_mode = new_info
            .and_then(|v| v.split_whitespace().next())
            .unwrap_or("100644");
        #[cfg(unix)]
        let working_mode = if let Some(m) = &metadata {
            use std::os::unix::fs::PermissionsExt;
            if m.file_type().is_symlink() {
                "120000"
            } else if m.is_dir() {
                "160000"
            } else if m.permissions().mode() & 0o111 != 0 {
                "100755"
            } else {
                "100644"
            }
        } else {
            working_mode
        };
        let new_mode = if status == "deleted" {
            "absent"
        } else if comparison.mode == "staged" || commit.is_some() {
            new_info
                .and_then(|v| v.split_whitespace().next())
                .unwrap_or("absent")
        } else {
            working_mode
        };
        let details = if kind == "submodule" {
            format!(
                "Baseline: {}\n{}: {}",
                old_info.map(String::as_str).unwrap_or("absent"),
                if commit.is_some() { "Commit" } else { "Index" },
                new_info.map(String::as_str).unwrap_or("absent")
            )
        } else if comparison.view == "code" {
            working_mode.to_string()
        } else {
            format!(
                "{} → {}",
                old_info
                    .and_then(|v| v.split_whitespace().next())
                    .unwrap_or("absent"),
                new_mode
            )
        };
        records.insert(
            id,
            Record {
                entry,
                old,
                new,
                stamp: if commit.is_some() {
                    String::new()
                } else {
                    stamp(&root, &path)?
                },
                metadata: details,
            },
        );
    }
    let navigation = crate::navigation::capture_inventories(
        &root,
        &comparison,
        &all,
        &base_metadata,
        &index_metadata,
    )?;
    if signature_before != signature(&g, &root).await? {
        return Err(STALE.into());
    }
    if let Ok(Some(baseline)) = &repository_watch {
        match baseline.probe().await {
            Ok(true) => return Err(STALE.into()),
            Ok(false) => {}
            Err(error) => repository_watch = Err(error),
        }
    }
    let mut files: Vec<_> = records.values().map(|r| r.entry.clone()).collect();
    files.sort_by(|a, b| a.path.cmp(&b.path));
    let queue_id = hash(
        format!(
            "{}:{}:{}",
            repository.id,
            repository.branch,
            serde_json::to_string(&comparison).unwrap()
        )
        .as_bytes(),
    );
    Ok(RepositorySnapshot {
        data: Snapshot {
            id: uuid::Uuid::new_v4().to_string(),
            repository,
            comparison,
            queue_id,
            base_commit: base,
            commit,
            files,
        },
        records,
        signature: signature_before,
        git: g,
        navigation,
        repository_watch,
    })
}

fn parse_object_metadata(bytes: &[u8]) -> Result<BTreeMap<String, String>, String> {
    let mut result = BTreeMap::new();
    for row in bytes.split(|b| *b == 0).filter(|r| !r.is_empty()) {
        let split = row
            .iter()
            .position(|b| *b == b'\t')
            .ok_or("Invalid Git object record")?;
        result.insert(utf8(&row[split + 1..])?, utf8(&row[..split])?);
    }
    Ok(result)
}

fn parse_names(bytes: &[u8]) -> Result<Vec<(String, Option<String>, String)>, String> {
    let mut fields = bytes.split(|b| *b == 0).filter(|b| !b.is_empty());
    let mut result = vec![];
    while let Some(status) = fields.next() {
        let first = utf8(fields.next().ok_or("Invalid Git filename record")?)?;
        let code = *status.first().ok_or("Missing Git status")?;
        let (path, previous) = if code == b'R' || code == b'C' {
            (
                utf8(fields.next().ok_or("Missing renamed path")?)?,
                Some(first),
            )
        } else {
            (first, None)
        };
        let status = match code {
            b'A' => "added",
            b'D' => "deleted",
            b'R' => "renamed",
            b'C' => "added",
            b'U' => "conflict",
            _ => "modified",
        };
        result.push((path, previous, status.into()));
    }
    Ok(result)
}
fn parse_stats(bytes: &[u8]) -> Result<BTreeMap<String, (u64, u64, bool)>, String> {
    let mut fields = bytes.split(|b| *b == 0).filter(|b| !b.is_empty());
    let mut result = BTreeMap::new();
    while let Some(field) = fields.next() {
        let mut cols = field.splitn(3, |b| *b == b'\t');
        let adds = utf8(cols.next().unwrap_or_default())?;
        let dels = utf8(cols.next().unwrap_or_default())?;
        let name = cols.next().unwrap_or_default();
        let path = if name.is_empty() {
            fields.next().ok_or("Invalid rename statistics")?;
            utf8(fields.next().ok_or("Missing rename destination")?)?
        } else {
            utf8(name)?
        };
        result.insert(
            path,
            (
                adds.parse().unwrap_or(0),
                dels.parse().unwrap_or(0),
                adds == "-",
            ),
        );
    }
    Ok(result)
}

async fn source_size(snapshot: &RepositorySnapshot, source: &Source) -> Result<u64, String> {
    match source {
        Source::Empty => Ok(0),
        Source::Working(path) => Ok(fs::symlink_metadata(safe_path(
            Path::new(&snapshot.data.repository.root),
            path,
        )?)
        .map_err(|_| STALE)?
        .len()),
        Source::Git(spec) => text(
            &snapshot.git,
            Path::new(&snapshot.data.repository.root),
            &["cat-file", "-s", spec],
        )
        .await?
        .parse()
        .map_err(|_| "Invalid Git object size".into()),
    }
}
async fn read_source(
    snapshot: &RepositorySnapshot,
    source: &Source,
) -> Result<Option<Vec<u8>>, String> {
    let root = Path::new(&snapshot.data.repository.root);
    match source {
        Source::Empty => Ok(None),
        Source::Git(spec) => Ok(Some(git(&snapshot.git, root, &["show", spec]).await?)),
        Source::Working(path) => {
            let absolute = safe_path(root, path)?;
            let m = fs::symlink_metadata(&absolute).map_err(|_| STALE)?;
            if m.file_type().is_symlink() {
                return Ok(Some(
                    fs::read_link(absolute)
                        .map_err(|e| e.to_string())?
                        .to_string_lossy()
                        .as_bytes()
                        .to_vec(),
                ));
            }
            Ok(Some(fs::read(absolute).map_err(|_| STALE)?))
        }
    }
}

async fn ensure_current(snapshot: &RepositorySnapshot, record: &Record) -> Result<(), String> {
    // Commit comparisons read immutable Git objects, so edits, staging and
    // branch switches cannot make their contents stale.
    if snapshot.data.commit.is_none() {
        let root = Path::new(&snapshot.data.repository.root);
        if snapshot.signature != signature(&snapshot.git, root).await?
            || record.stamp != stamp(root, &record.entry.path)?
        {
            return Err(STALE.into());
        }
    }
    Ok(())
}

pub async fn read_content(
    snapshot: &RepositorySnapshot,
    id: &str,
    force: bool,
    fallback_tab_width: u32,
) -> Result<FileContent, String> {
    let record = snapshot
        .records
        .get(id)
        .ok_or("File is not in this snapshot")?;
    let root = Path::new(&snapshot.data.repository.root);
    ensure_current(snapshot, record).await?;
    let mut content = FileContent {
        snapshot_id: snapshot.data.id.clone(),
        file_id: id.into(),
        path: record.entry.path.clone(),
        old_path: record.entry.old_path.clone(),
        status: record.entry.status.clone(),
        kind: record.entry.kind.clone(),
        old_content: None,
        new_content: None,
        fingerprint: String::new(),
        tab_width: editor_tab_width(root, &record.entry.path, fallback_tab_width),
        deferred: false,
        size: record.entry.size,
        metadata: record.metadata.clone(),
    };
    if ["submodule", "conflict"].contains(&content.kind.as_str()) {
        let extra = if content.kind == "conflict" {
            git(
                &snapshot.git,
                root,
                &["ls-files", "--unmerged", "-z", "--", &content.path],
            )
            .await?
        } else if snapshot.data.commit.is_some() {
            vec![]
        } else {
            let mut args = vec![
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                "--submodule=short",
            ];
            if snapshot.data.comparison.mode == "staged" {
                args.push("--cached");
            }
            if snapshot.data.comparison.mode != "unstaged" {
                if let Some(base) = &snapshot.data.base_commit {
                    args.push(base);
                }
            }
            args.extend(["--", &content.path]);
            git(&snapshot.git, root, &args).await.unwrap_or_default()
        };
        content.metadata.push_str(&format!(
            "\n{}",
            String::from_utf8_lossy(&extra).replace('\0', "\n")
        ));
        content.fingerprint =
            hash(format!("{}:{}:{}", content.kind, record.stamp, content.metadata).as_bytes());
        ensure_current(snapshot, record).await?;
        return Ok(content);
    }
    let (old_size, new_size) = tokio::try_join!(
        source_size(snapshot, &record.old),
        source_size(snapshot, &record.new)
    )?;
    content.size = old_size.max(new_size);
    if content.size > HARD_LIMIT {
        return Err(
            "This file exceeds the 64 MiB inspection limit. Open it in a specialized viewer."
                .into(),
        );
    }
    if (content.size > MAX_BYTES || record.entry.additions + record.entry.deletions > MAX_LINES)
        && !force
    {
        content.deferred = true;
        return Ok(content);
    }
    let (old, new) = tokio::try_join!(
        read_source(snapshot, &record.old),
        read_source(snapshot, &record.new)
    )?;
    ensure_current(snapshot, record).await?;
    content.fingerprint = if snapshot.data.comparison.view == "code" {
        hash(
            &serde_json::to_vec(&(
                content.path.as_str(),
                content.kind.as_str(),
                content.metadata.as_str(),
                &new,
            ))
            .unwrap(),
        )
    } else {
        hash(
            &serde_json::to_vec(&(
                content.path.as_str(),
                content.old_path.as_deref(),
                content.status.as_str(),
                content.metadata.as_str(),
                &old,
                &new,
            ))
            .unwrap(),
        )
    };
    let decode = |bytes: Option<Vec<u8>>| -> Result<Option<String>, ()> {
        bytes
            .map(|bytes| {
                if bytes.contains(&0) {
                    Err(())
                } else {
                    String::from_utf8(bytes).map_err(|_| ())
                }
            })
            .transpose()
    };
    match (decode(old), decode(new)) {
        (Ok(old), Ok(new)) => {
            content.old_content = old;
            content.new_content = new;
        }
        _ => {
            content.kind = "binary".into();
        }
    }
    let lines = content
        .old_content
        .as_deref()
        .unwrap_or("")
        .lines()
        .count()
        .max(content.new_content.as_deref().unwrap_or("").lines().count());
    if lines as u64 > MAX_LINES && !force {
        content.old_content = None;
        content.new_content = None;
        content.deferred = true;
    }
    Ok(content)
}

pub fn editor_tab_width(root: &Path, path: &str, fallback: u32) -> u32 {
    editorconfig_tab_width(root, path).unwrap_or(fallback.clamp(1, 16))
}

pub fn editorconfig_tab_width(root: &Path, path: &str) -> Option<u32> {
    let absolute = root.join(path);
    let mut configs = vec![];
    let mut directory = absolute.parent();
    while let Some(dir) = directory {
        if let Ok(text) = fs::read_to_string(dir.join(".editorconfig")) {
            let is_root = text
                .lines()
                .take_while(|l| !l.trim().starts_with('['))
                .any(|l| {
                    l.split_once('=').is_some_and(|(k, v)| {
                        k.trim() == "root" && v.trim().eq_ignore_ascii_case("true")
                    })
                });
            configs.push((dir.to_path_buf(), text));
            if is_root {
                break;
            }
        }
        directory = dir.parent();
    }
    let mut properties = BTreeMap::new();
    for (dir, text) in configs.into_iter().rev() {
        let relative = absolute
            .strip_prefix(dir)
            .unwrap_or(&absolute)
            .to_string_lossy()
            .replace('\\', "/");
        let mut matches = false;
        for line in text.lines().map(str::trim) {
            if line.starts_with('#') || line.starts_with(';') {
                continue;
            }
            if line.starts_with('[') && line.ends_with(']') {
                let pattern = &line[1..line.len() - 1];
                let pattern = if pattern.contains('/') {
                    pattern.trim_start_matches('/').to_string()
                } else {
                    format!("**/{pattern}")
                };
                matches = globset::GlobBuilder::new(&pattern)
                    .literal_separator(true)
                    .build()
                    .is_ok_and(|g| g.compile_matcher().is_match(&relative));
            } else if matches {
                if let Some((key, value)) = line.split_once('=') {
                    if value.trim() == "unset" {
                        properties.remove(key.trim());
                    } else {
                        properties.insert(key.trim().to_string(), value.trim().to_string());
                    }
                }
            }
        }
    }
    properties
        .get("tab_width")
        .or_else(|| properties.get("indent_size"))
        .and_then(|s| s.parse().ok())
        .filter(|n| (1..=16).contains(n))
}
