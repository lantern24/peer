# Peer user manual

For installation and requirements, see the [README](../README.md#install-with-homebrew).

## Review workflow

### Open and manage repositories

Open a repository with the **+** button beside the repository name or ⌘/Ctrl O. Click the repository name to switch among the 12 most recently opened repositories; the dropdown shows their paths and marks the current one. Use arrow keys and Enter to choose, or Escape to close. The first opening shows Changes if any exist, otherwise Code. The app restores each repository's comparison, selected file, and scroll position, and keeps comment drafts while switching. Refresh with the toolbar or ⌘/Ctrl R after your agent edits files.

For a renamed or moved repository, use its **Update location** folder icon in the dropdown, enter or browse to the new repository root, then choose **Update location**. Peer validates and opens the new location, replaces the old name/path, and preserves the saved view, comments, and Reviewed state. Invalid locations or locations already saved for another repository leave the original entry unchanged. This is an explicit repair; Peer does not automatically locate moved repositories.

For a deleted or unwanted repository, use its **Remove from list** × button. Removing the active entry returns to the welcome screen; other open repositories are unaffected. Removal persists across restarts but never deletes repository files or saved review data. In the dropdown, Up/Down moves between repositories and Left/Right reaches each row's location and removal actions.

### Choose a comparison

- **Code:** existing tracked files plus non-ignored untracked files in the working directory.
- **All local changes:** HEAD against working files, combining staged and unstaged edits.
- **Staged:** HEAD against the index. **Unstaged:** index against working files.
- **Compare to branch:** the merge base of that branch and HEAD against working files. This includes committed branch changes and local edits. No automatic fetch.
- **Commit history:** click the branch name beside Code/Changes to browse commits, with older history loaded on demand. Select a commit to review its diff against its first parent (or the empty tree for the initial commit). Merge commits show what they introduced relative to their first parent. These diffs use committed files, independent of local edits, with separate review comments for each commit. Choose All local changes in the comparison selector to return to the working directory.

### Browse files and adjust the viewer

Filter filenames in the sidebar, use ⌘/Ctrl P for quick-open, ⌘/Ctrl F for in-file search, and ⌘/Ctrl G to jump to a line. Quick-open focuses the search field automatically; use ↑/↓ or Ctrl+P/Ctrl+N to highlight a result, then Enter to open it. Switch unified/split layouts or toggle whitespace markers in the viewer toolbar. Source tabs, spaces, CRLF, and trailing whitespace are retained. EditorConfig supplies tab width, falling back to the width in Settings.

Search highlights the matching text in filenames and source. In-file Find highlights every visible occurrence in the selected file; Enter/Shift+Enter or the arrow buttons move between matches, with a stronger highlight on the current occurrence. Matching is literal and case-insensitive, including repeated matches on the same line. Press Esc or click Close search to hide Find and remove the source highlights.

As you scroll Changes, the navigator highlights the file at the top of the diff viewport and keeps its row visible, expanding parent folders as needed. Keyboard focus and your filename filter are preserved.

Drag the inner edge of either sidebar to resize it. Widths are remembered across restarts, and narrower windows temporarily reduce them to keep the source visible. Focus a divider and use Left/Right arrows to resize (Shift moves faster), Home/End for its limits, or double-click to reset its width. Esc cancels an active drag. The right-side width also applies to navigation results; hiding Feedback preserves its width and draft.

Settings is organized into **Appearance**, **Viewer**, **Code navigation**, and **Git** tabs. Click a tab or use Left/Right arrows (Home/End jump to the first/last tab) while the tab row has focus. Each section scrolls independently, and switching tabs preserves unsaved language-server edits. Settings → Viewer → Code font size adjusts Code and Changes from 10–32 px and is saved across restarts. Drag the top title bar, including the app name, to move the window.

### Add comments and mark files reviewed

Use the gutter **+** to comment on a line, or a file header's comment button for a file comment. Comments can be edited, deleted individually, or cleared from the active queue. Changes files can be marked Reviewed. Feedback is stored per worktree and branch, with distinct Code and comparison queues.

Refresh marks comments outdated when their file fingerprint changes, and resets Reviewed for changed files. Original anchors and context remain intact, including feedback on files that disappear. Drafts survive theme and view switching during the session; only saved comments survive application restarts.

### Refresh after repository changes

Peer watches the active repository and shows a persistent **Repository changed on disk** notice in the status bar when files, staging, HEAD, or the selected comparison branch change. Detection never refreshes automatically: displayed source, the file list, drafts, Reviewed state, focus, and scroll remain untouched. Choose the notice's **Refresh** button, the toolbar, or ⌘/Ctrl R when ready. The notice clears only after a successful reload; failed refreshes keep it.

Monitoring includes tracked files (even those matching ignore rules), non-ignored untracked files, linked worktrees, and submodule HEAD/dirty state. Changes to Git's `info/attributes`, global attributes (configured or default), and system attributes are also detected. Changes to comparison-related Git settings trigger detection; unrelated identity settings, ignored generated output, and Git housekeeping do not. Immutable commit reviews are not monitored for working-directory changes. If monitoring becomes unavailable, the status bar says so and manual refresh remains available. Existing stale-source checks still prevent attaching new feedback to changed content.

The toolbar Refresh button and Refresh Repository menu command reload immediately. If files or Git's index change during that reload, Peer retries with a fresh snapshot (up to three attempts) before showing an error. Stale reads and review actions still offer a refresh without silently replacing the source being reviewed.

### Export feedback

**Copy comments** copies a concise JSON array from the active queue:

```json
[
  {
    "file": "src/example.ts",
    "line": 42,
    "comment": "Handle an empty result here."
  },
  { "file": "README.md", "comment": "Document the setup steps." }
]
```

File comments omit `line`. Line numbers are one-based; diff comments on the old side additionally include `"side": "old"`. Outdated comments are included with `"outdated": true`, retaining their original location.

**Delete comments after copying**, below the Copy comments button, is on by default. After a successful clipboard copy, the copied comments are deleted from the active queue; drafts and Reviewed state are kept. Turn it off to keep comments after copying. The toggle keeps its setting while switching views or hiding Feedback during the session. If clipboard access fails, comments are kept and a selectable JSON fallback is shown. Save JSON uses the same concise format without deleting comments.

Save or cancel an open comment edit before copying. Copy is also unavailable while a comment save is pending. During copying, comment changes are disabled until export, clipboard writing, and deletion finish; hiding and reopening Feedback does not bypass these guards. Clipboard failures release the controls without deleting comments.

