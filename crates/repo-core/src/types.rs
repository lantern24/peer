use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Comparison {
    pub view: String,
    pub mode: String,
    pub base_ref: Option<String>,
    pub include_untracked: bool,
}
impl Default for Comparison {
    fn default() -> Self {
        Self {
            view: "changes".into(),
            mode: "all".into(),
            base_ref: None,
            include_untracked: true,
        }
    }
}
impl Comparison {
    pub fn validate(&self) -> Result<(), String> {
        if !["code", "changes"].contains(&self.view.as_str())
            || !["all", "staged", "unstaged", "branch", "commit"].contains(&self.mode.as_str())
        {
            return Err("Unknown comparison".into());
        }
        if ["branch", "commit"].contains(&self.mode.as_str())
            && self.view == "changes"
            && self.base_ref.as_deref().unwrap_or("").is_empty()
        {
            return Err("Select a branch or commit to compare".into());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Repository {
    pub id: String,
    pub root: String,
    pub name: String,
    pub branch: String,
    pub head: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    pub id: String,
    pub short_id: String,
    pub subject: String,
    pub author: String,
    pub committed_at: String,
    pub parents: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitPage {
    pub commits: Vec<Commit>,
    pub has_more: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub id: String,
    pub path: String,
    pub old_path: Option<String>,
    pub status: String,
    pub kind: String,
    pub additions: u64,
    pub deletions: u64,
    pub size: u64,
    pub deferred: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub id: String,
    pub repository: Repository,
    pub comparison: Comparison,
    pub queue_id: String,
    pub base_commit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commit: Option<Commit>,
    pub files: Vec<FileEntry>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryWatchStatus {
    pub snapshot_id: String,
    pub watch_id: String,
    pub changed: bool,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    pub snapshot_id: String,
    pub file_id: String,
    pub path: String,
    pub old_path: Option<String>,
    pub status: String,
    pub kind: String,
    pub old_content: Option<String>,
    pub new_content: Option<String>,
    pub fingerprint: String,
    pub tab_width: u32,
    pub deferred: bool,
    pub size: u64,
    pub metadata: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Anchor {
    pub snapshot_id: String,
    pub fingerprint: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_commit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub head_commit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub side: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line_text: Option<String>,
    pub context_before: Vec<String>,
    pub context_after: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Comment {
    pub id: String,
    pub queue_id: String,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    pub source_view: String,
    pub scope: String,
    pub body: String,
    pub created_at: String,
    pub updated_at: String,
    pub anchor: Anchor,
    pub outdated: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ReviewQueue {
    pub comments: Vec<Comment>,
    pub reviewed: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewComment {
    pub snapshot_id: String,
    pub file_id: String,
    pub fingerprint: String,
    pub body: String,
    pub side: Option<String>,
    pub line: Option<u32>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Appearance {
    pub mode: String,
    pub light_theme: String,
    pub dark_theme: String,
}
impl Default for Appearance {
    fn default() -> Self {
        Self {
            mode: "system".into(),
            light_theme: "github-light".into(),
            dark_theme: "github-dark".into(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub comparison: Comparison,
    pub selected_path: Option<String>,
    #[serde(default)]
    pub scroll_top: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_changes: Option<Comparison>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SidebarWidths {
    pub files: u32,
    pub feedback: u32,
}
impl Default for SidebarWidths {
    fn default() -> Self {
        Self {
            files: 244,
            feedback: 310,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Preferences {
    pub sidebar_widths: SidebarWidths,
    pub appearance: Appearance,
    pub recent_repositories: Vec<String>,
    pub last_repository: Option<String>,
    pub sessions: BTreeMap<String, Session>,
    pub tab_width: u32,
    pub show_whitespace: bool,
    pub code_font_size: u32,
    pub diff_layout: String,
    pub git_executable: Option<String>,
    pub language_servers: Vec<crate::navigation::LanguageServer>,
}
impl Default for Preferences {
    fn default() -> Self {
        Self {
            sidebar_widths: SidebarWidths::default(),
            appearance: Appearance::default(),
            recent_repositories: vec![],
            last_repository: None,
            sessions: BTreeMap::new(),
            tab_width: 4,
            show_whitespace: false,
            code_font_size: 12,
            diff_layout: "unified".into(),
            git_executable: None,
            language_servers: crate::navigation::default_servers(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedTheme {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub definition: serde_json::Value,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppData {
    pub schema_version: u32,
    pub preferences: Preferences,
    pub queues: BTreeMap<String, ReviewQueue>,
    pub repository_ids: BTreeMap<String, String>,
    pub themes: Vec<ImportedTheme>,
}
impl Default for AppData {
    fn default() -> Self {
        Self {
            schema_version: 1,
            preferences: Preferences::default(),
            queues: BTreeMap::new(),
            repository_ids: BTreeMap::new(),
            themes: vec![],
        }
    }
}
