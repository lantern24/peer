use crate::{
    repository::{self, RepositorySnapshot},
    store::Store,
    theme,
    types::*,
};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio::sync::RwLock;

pub struct Inspector {
    pub store: Store,
    snapshots: RwLock<BTreeMap<String, Arc<RepositorySnapshot>>>,
    navigation: crate::navigation::NavigationService,
}
impl Inspector {
    pub fn new(directory: impl Into<PathBuf>) -> Result<Self, String> {
        Ok(Self {
            store: Store::new(directory)?,
            snapshots: RwLock::new(BTreeMap::new()),
            navigation: Default::default(),
        })
    }
    async fn snapshot(&self, id: &str) -> Result<Arc<RepositorySnapshot>, String> {
        self.snapshots
            .read()
            .await
            .get(id)
            .cloned()
            .ok_or("Snapshot expired. Refresh the repository.".into())
    }
    /// Clone only the lightweight baseline, not the review/navigation snapshot.
    pub async fn repository_watch_baseline(
        &self,
        id: &str,
    ) -> Result<Option<Arc<crate::monitor::RepositoryBaseline>>, String> {
        self.snapshot(id).await?.repository_watch.clone()
    }
    /// Retire child processes and temporary analysis sources before application exit.
    pub async fn shutdown_navigation(&self) {
        self.navigation.invalidate().await;
    }
    pub fn save_preferences(&self, preferences: Preferences) -> Result<(), String> {
        crate::navigation::validate_servers(&preferences.language_servers)?;
        if !(180..=600).contains(&preferences.sidebar_widths.files)
            || !(260..=640).contains(&preferences.sidebar_widths.feedback)
        {
            return Err("Invalid sidebar widths".into());
        }
        if !(1..=16).contains(&preferences.tab_width)
            || !(10..=32).contains(&preferences.code_font_size)
            || !["light", "dark", "system"].contains(&preferences.appearance.mode.as_str())
            || !["split", "unified"].contains(&preferences.diff_layout.as_str())
        {
            return Err("Invalid appearance preferences".into());
        }
        self.store.update(|data| {
            data.preferences = preferences;
            Ok(())
        })
    }
    pub async fn open_repository(
        &self,
        path: &str,
        comparison: Option<Comparison>,
    ) -> Result<Snapshot, String> {
        self.load_repository(path, comparison, None).await
    }
    pub async fn relocate_repository(
        &self,
        previous_path: &str,
        path: &str,
    ) -> Result<Snapshot, String> {
        self.load_repository(path, None, Some(previous_path)).await
    }
    async fn load_repository(
        &self,
        path: &str,
        comparison: Option<Comparison>,
        previous_path: Option<&str>,
    ) -> Result<Snapshot, String> {
        // A requested reload already authorizes a fresh snapshot. If an editor
        // or Git changes the source during discovery/reconciliation, start over
        // instead of asking the user to click Refresh a second time. Ordinary
        // reads and feedback mutations keep rejecting stale snapshots.
        for attempt in 0..3 {
            match self
                .open_repository_once(path, comparison.clone(), previous_path)
                .await
            {
                Err(error) if error == repository::STALE && attempt < 2 => continue,
                result => return result,
            }
        }
        unreachable!()
    }
    async fn open_repository_once(
        &self,
        path: &str,
        comparison: Option<Comparison>,
        previous_path: Option<&str>,
    ) -> Result<Snapshot, String> {
        let data = self.store.read()?;
        let preferences = data.preferences;
        let mut repository_ids = data.repository_ids;
        let relocation = if let Some(previous) = previous_path {
            if !preferences
                .recent_repositories
                .iter()
                .any(|p| p == previous)
                && preferences.last_repository.as_deref() != Some(previous)
            {
                return Err("Repository is no longer in the list".into());
            }
            let root = std::fs::canonicalize(path)
                .map_err(|e| format!("Cannot open repository: {e}"))?
                .to_str()
                .ok_or("Repository path is not UTF-8")?
                .to_owned();
            if root != previous
                && (preferences.recent_repositories.contains(&root)
                    || preferences.sessions.contains_key(&root)
                    || repository_ids.contains_key(&root))
            {
                return Err("That location already belongs to a saved repository".into());
            }
            let id = repository_ids
                .get(previous)
                .cloned()
                .unwrap_or_else(|| crate::hash(previous.as_bytes()));
            repository_ids.insert(root.clone(), id);
            Some(root)
        } else {
            None
        };
        let session = preferences.sessions.get(previous_path.unwrap_or(path));
        let requested = comparison
            .clone()
            .or_else(|| session.map(|s| s.comparison.clone()))
            .unwrap_or_default();
        let mut snapshot = repository::create_snapshot(
            path,
            requested,
            preferences.git_executable.as_deref(),
            &repository_ids,
        )
        .await?;
        if relocation
            .as_ref()
            .is_some_and(|root| root != &snapshot.data.repository.root)
        {
            return Err("Choose the repository's root folder, not a subfolder".into());
        }
        if comparison.is_none()
            && session.is_none()
            && !preferences
                .sessions
                .contains_key(&snapshot.data.repository.root)
            && snapshot.data.files.is_empty()
        {
            snapshot = repository::create_snapshot(
                path,
                Comparison {
                    view: "code".into(),
                    ..Comparison::default()
                },
                preferences.git_executable.as_deref(),
                &repository_ids,
            )
            .await?;
        }
        // Reconcile before committing a location change so failed validation
        // leaves the saved path and its identity untouched.
        self.reconcile(&snapshot).await?;
        let result = snapshot.data.clone();
        self.store.update(|data| {
            if let Some(previous) = previous_path {
                let root = &result.repository.root;
                if previous != root {
                    data.preferences
                        .recent_repositories
                        .retain(|p| p != previous);
                    if let Some(session) = data.preferences.sessions.remove(previous) {
                        data.preferences.sessions.insert(root.clone(), session);
                    }
                    data.repository_ids.remove(previous);
                }
            }
            let root = &result.repository.root;
            data.repository_ids
                .insert(root.clone(), result.repository.id.clone());
            data.preferences.recent_repositories.retain(|p| p != root);
            data.preferences.recent_repositories.insert(0, root.clone());
            data.preferences.recent_repositories.truncate(12);
            data.preferences.last_repository = Some(root.clone());
            data.queues.entry(result.queue_id.clone()).or_default();
            Ok(())
        })?;
        let mut snapshots = self.snapshots.write().await;
        // Keep only the active snapshot per queue; no unbounded source retention.
        snapshots.retain(|_, s| s.data.queue_id != result.queue_id);
        if snapshots.len() >= 16 {
            snapshots.clear();
        }
        snapshots.insert(result.id.clone(), Arc::new(snapshot));
        drop(snapshots);
        self.navigation.activate(&result.id).await;
        Ok(result)
    }
    async fn reconcile(&self, snapshot: &RepositorySnapshot) -> Result<(), String> {
        let data = self.store.read()?;
        let queue = data
            .queues
            .get(&snapshot.data.queue_id)
            .cloned()
            .unwrap_or_default();
        let paths: BTreeSet<_> = queue
            .comments
            .iter()
            .filter(|c| !c.outdated)
            .map(|c| c.path.clone())
            .chain(queue.reviewed.keys().cloned())
            .collect();
        let mut fingerprints = BTreeMap::new();
        for path in paths {
            if let Some(entry) = snapshot.data.files.iter().find(|f| f.path == path) {
                match repository::read_content(
                    snapshot,
                    &entry.id,
                    true,
                    data.preferences.tab_width,
                )
                .await
                {
                    Ok(content) => {
                        fingerprints.insert(path, content.fingerprint);
                    }
                    Err(error) if error == repository::STALE => return Err(error),
                    Err(_) => {}
                }
            }
        }
        self.store.update(|data| {
            let queue = data
                .queues
                .entry(snapshot.data.queue_id.clone())
                .or_default();
            for comment in &mut queue.comments {
                if fingerprints.get(&comment.path) != Some(&comment.anchor.fingerprint) {
                    comment.outdated = true;
                }
            }
            queue
                .reviewed
                .retain(|path, fingerprint| fingerprints.get(path) == Some(fingerprint));
            Ok(())
        })
    }
    pub async fn read_file(
        &self,
        snapshot_id: &str,
        file_id: &str,
        force: bool,
    ) -> Result<FileContent, String> {
        let snapshot = self.snapshot(snapshot_id).await?;
        repository::read_content(
            &snapshot,
            file_id,
            force,
            self.store.read()?.preferences.tab_width,
        )
        .await
    }
    pub async fn navigate_symbol(
        &self,
        request: crate::navigation::NavigationRequest,
    ) -> Result<crate::navigation::NavigationResult, crate::navigation::NavigationError> {
        let snapshot = self.snapshot(&request.snapshot_id).await?;
        let servers = self.store.read()?.preferences.language_servers;
        self.navigation.query(snapshot, &servers, request).await
    }
    pub async fn read_navigation_file(
        &self,
        snapshot_id: &str,
        side: &str,
        document_id: &str,
        force: bool,
    ) -> Result<crate::navigation::NavigationFile, crate::navigation::NavigationError> {
        let snapshot = self.snapshot(snapshot_id).await?;
        self.navigation
            .read(snapshot, side, document_id, force)
            .await
    }
    pub fn cancel_navigation(&self, request_id: &str) {
        self.navigation.cancel(request_id);
    }
    pub async fn branches(&self, snapshot_id: &str) -> Result<Vec<String>, String> {
        let snapshot = self.snapshot(snapshot_id).await?;
        let bytes = repository::git(
            &snapshot.git,
            Path::new(&snapshot.data.repository.root),
            &[
                "for-each-ref",
                "--format=%(refname:short)",
                "refs/heads",
                "refs/remotes",
            ],
        )
        .await?;
        Ok(String::from_utf8_lossy(&bytes)
            .lines()
            .filter(|s| !s.ends_with("/HEAD"))
            .map(str::to_string)
            .collect())
    }
    pub async fn commits(
        &self,
        snapshot_id: &str,
        offset: u32,
        limit: u32,
    ) -> Result<CommitPage, String> {
        let snapshot = self.snapshot(snapshot_id).await?;
        match &snapshot.data.repository.head {
            Some(head) => {
                repository::commits(
                    &snapshot.git,
                    Path::new(&snapshot.data.repository.root),
                    head,
                    offset,
                    limit,
                )
                .await
            }
            None => Ok(CommitPage {
                commits: vec![],
                has_more: false,
            }),
        }
    }
    pub async fn queue(&self, snapshot_id: &str) -> Result<ReviewQueue, String> {
        let snapshot = self.snapshot(snapshot_id).await?;
        Ok(self
            .store
            .read()?
            .queues
            .get(&snapshot.data.queue_id)
            .cloned()
            .unwrap_or_default())
    }
    pub async fn add_comment(&self, input: NewComment) -> Result<Comment, String> {
        if input.body.trim().is_empty() {
            return Err("Write a comment first".into());
        }
        let snapshot = self.snapshot(&input.snapshot_id).await?;
        let content = self
            .read_file(&input.snapshot_id, &input.file_id, true)
            .await?;
        if input.fingerprint != content.fingerprint {
            return Err(repository::STALE.into());
        }
        let mut anchor = Anchor {
            snapshot_id: input.snapshot_id,
            fingerprint: content.fingerprint,
            base_commit: snapshot.data.base_commit.clone(),
            head_commit: snapshot
                .data
                .commit
                .as_ref()
                .map(|c| c.id.clone())
                .or_else(|| snapshot.data.repository.head.clone()),
            side: None,
            line: None,
            line_text: None,
            context_before: vec![],
            context_after: vec![],
        };
        if let Some(line) = input.line {
            if content.kind == "binary"
                || ["submodule", "conflict"].contains(&content.kind.as_str())
            {
                return Err("Only file comments are supported for this file".into());
            }
            let text = if snapshot.data.comparison.view == "code" {
                if input.side.is_some() {
                    return Err("Code comments do not have a diff side".into());
                }
                content.new_content.as_deref()
            } else {
                match input.side.as_deref() {
                    Some("old") => content.old_content.as_deref(),
                    Some("new") => content.new_content.as_deref(),
                    _ => return Err("Choose the old or new side of the diff".into()),
                }
            }
            .ok_or("That side of the file does not exist")?;
            // split_inclusive retains CRLF in snippets while excluding the final empty phantom line.
            let lines: Vec<_> = text
                .split_inclusive('\n')
                .map(|s| s.strip_suffix('\n').unwrap_or(s))
                .collect();
            if line == 0 || line as usize > lines.len() {
                return Err("Line is outside the file".into());
            }
            let index = line as usize - 1;
            anchor.side = input.side;
            anchor.line = Some(line);
            anchor.line_text = Some(lines[index].into());
            anchor.context_before = lines[index.saturating_sub(3)..index]
                .iter()
                .map(|s| s.to_string())
                .collect();
            anchor.context_after = lines[index + 1..(index + 4).min(lines.len())]
                .iter()
                .map(|s| s.to_string())
                .collect();
        } else if input.side.is_some() {
            return Err("File comments do not have a diff side".into());
        }
        let now = chrono::Utc::now().to_rfc3339();
        let comment = Comment {
            id: uuid::Uuid::new_v4().to_string(),
            queue_id: snapshot.data.queue_id.clone(),
            path: content.path,
            old_path: content.old_path,
            source_view: snapshot.data.comparison.view.clone(),
            scope: if anchor.line.is_some() {
                "line"
            } else {
                "file"
            }
            .into(),
            body: input.body.trim().into(),
            created_at: now.clone(),
            updated_at: now,
            anchor,
            outdated: false,
        };
        self.store.update(|data| {
            data.queues
                .entry(comment.queue_id.clone())
                .or_default()
                .comments
                .push(comment.clone());
            Ok(())
        })?;
        Ok(comment)
    }
    pub fn update_comment(&self, queue_id: &str, id: &str, body: &str) -> Result<(), String> {
        if body.trim().is_empty() {
            return Err("Comment cannot be empty".into());
        }
        self.store.update(|data| {
            let comment = data
                .queues
                .get_mut(queue_id)
                .and_then(|q| q.comments.iter_mut().find(|c| c.id == id))
                .ok_or("Comment no longer exists")?;
            comment.body = body.trim().into();
            comment.updated_at = chrono::Utc::now().to_rfc3339();
            Ok(())
        })
    }
    pub fn delete_comments(&self, queue_id: &str, id: Option<&str>) -> Result<(), String> {
        self.store.update(|data| {
            if let Some(queue) = data.queues.get_mut(queue_id) {
                queue.comments.retain(|c| id.is_some_and(|id| c.id != id));
            }
            Ok(())
        })
    }
    pub async fn set_reviewed(
        &self,
        snapshot_id: &str,
        file_id: &str,
        fingerprint: &str,
        reviewed: bool,
    ) -> Result<(), String> {
        let snapshot = self.snapshot(snapshot_id).await?;
        if snapshot.data.comparison.view != "changes" {
            return Err("Reviewed applies only to Changes".into());
        }
        let content = self.read_file(snapshot_id, file_id, true).await?;
        if content.fingerprint != fingerprint {
            return Err(repository::STALE.into());
        }
        self.store.update(|data| {
            let queue = data
                .queues
                .entry(snapshot.data.queue_id.clone())
                .or_default();
            if reviewed {
                queue.reviewed.insert(content.path, fingerprint.into());
            } else {
                queue.reviewed.remove(&content.path);
            }
            Ok(())
        })
    }
    pub async fn export(&self, snapshot_id: &str) -> Result<String, String> {
        #[derive(serde::Serialize)]
        struct Feedback<'a> {
            file: &'a str,
            #[serde(skip_serializing_if = "Option::is_none")]
            line: Option<u32>,
            #[serde(skip_serializing_if = "Option::is_none")]
            side: Option<&'a str>,
            comment: &'a str,
            #[serde(skip_serializing_if = "Option::is_none")]
            outdated: Option<bool>,
        }

        // Keep rich anchors in storage; share only the location and feedback.
        let queue = self.queue(snapshot_id).await?;
        let feedback: Vec<_> = queue
            .comments
            .iter()
            .map(|comment| {
                let line = comment.anchor.line.filter(|_| comment.scope == "line");
                Feedback {
                    file: &comment.path,
                    line,
                    side: comment
                        .anchor
                        .side
                        .as_deref()
                        .filter(|side| line.is_some() && *side == "old"),
                    comment: &comment.body,
                    outdated: comment.outdated.then_some(true),
                }
            })
            .collect();
        serde_json::to_string_pretty(&feedback).map_err(|e| e.to_string())
    }
    pub fn import_theme(&self, path: &str) -> Result<ImportedTheme, String> {
        let path = Path::new(path);
        if !path
            .extension()
            .and_then(|s| s.to_str())
            .is_some_and(|s| ["json", "jsonc"].contains(&s))
        {
            return Err("Choose a .json or .jsonc theme file".into());
        }
        if std::fs::metadata(path).map_err(|e| e.to_string())?.len() > 2 * 1024 * 1024 {
            return Err("Theme files must be smaller than 2 MiB".into());
        }
        let text = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
        let imported = theme::import_theme(
            &text,
            path.file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("Imported theme"),
        )?;
        self.store.update(|data| {
            if let Some(existing) = data.themes.iter().find(|t| t.id == imported.id) {
                return Ok(existing.clone());
            }
            data.themes.push(imported.clone());
            Ok(imported)
        })
    }
    pub fn remove_theme(&self, id: &str) -> Result<(), String> {
        self.store.update(|data| {
            data.themes.retain(|t| t.id != id);
            if data.preferences.appearance.light_theme == id {
                data.preferences.appearance.light_theme = "github-light".into();
            }
            if data.preferences.appearance.dark_theme == id {
                data.preferences.appearance.dark_theme = "github-dark".into();
            }
            Ok(())
        })
    }
}
