# Peer user manual

For installation and requirements, see the [README](../README.md#install-with-homebrew).

- [Review workflow](#review-workflow)
- [Code navigation](#code-navigation)
- [Themes](#themes)
- [Diagnostic reports](#diagnostic-reports)
- [Saved data and limits](#saved-data-and-limits)

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

## Code navigation

Click a symbol or select its text, then press **F12** to open its definition. **⌘-click** on macOS, **Ctrl-click** on other platforms, and the source context menu do the same. At a definition, F12 opens a references panel; **Shift-F12** or **Find References** requests references directly. Multiple definitions appear as selectable results.

Destinations open as complete, read-only source files, including files that are unchanged and absent from the diff list. In Changes, every repository jump retains the selected side: A uses HEAD (the index for Unstaged, or merge base for branch comparisons); B uses working files (the index for Staged). In split view, click the relevant column. In unified view, additions use B and deletions use A; the **Navigate shared lines** control chooses the version for unchanged lines, defaulting to B. The destination header identifies its version.

Use **⌘+[** / **⌘+]** on macOS or **Alt+←** / **Alt+→** on Windows and Linux to go Back / Forward, matching Chrome. The toolbar Back and Forward buttons do the same; **Ctrl+-** remains available for Back. Navigation restores the file, source selection, scroll position, and diff expansion state. These shortcuts leave text fields and open dialogs untouched.

Mouse **Back / Forward** controls use the same history. macOS also supports discrete swipe assignments such as Logi Options+’s Back / Forward gestures. Compatibility depends on the events your driver sends; not every mouse/driver combination is supported.

If a custom mapping does not work, configure it for Peer rather than your browser, or map the buttons to the keyboard shortcuts above. Fluid “Swipe between pages” gestures from trackpads or Magic Mouse remain ordinary scrolling, not history navigation.

History includes file selection, quick-open, search results, line jumps, comment jumps, and symbol jumps. Navigating somewhere new after going Back clears Forward history. History holds up to 100 entries for the current comparison and resets on refresh, comparison changes (including switching Code/Changes), or opening another repository. Source pages retain the original feedback queue and drafts; comments and Reviewed actions remain in the review view. Find and Go to Line operate on the displayed source page.

Configure servers in **Settings → Code navigation**. Go, TypeScript/JavaScript, Python, and Rust have presets. Servers and their toolchains must be installed locally; Peer does not install them or fetch dependencies. Suggested setup for the tested presets:

```sh
go install golang.org/x/tools/gopls@latest
npm install -g typescript-language-server typescript@5.9.3
npm install -g pyright
rustup component add rust-analyzer rust-src
```

The TypeScript preset uses a tsserver-based TypeScript installation (tested with 5.9.3). TypeScript 7's native compiler does not supply `tsserver.js`; use a compatible installation or configure another LSP server. `initializationOptions.tsserver.path` can select a particular `tsserver.js`. The preset disables the separate syntax server so cross-file definitions use semantic analysis from the first query.

The Python preset uses [Pyright](https://github.com/microsoft/pyright) (`pyright-langserver --stdio`, tested with 1.1.414) for `.py` and `.pyi` files. It supports definitions and references, recognizes `pyrightconfig.json`, `pyproject.toml`, `setup.py`, `setup.cfg`, `requirements.txt`, and `Pipfile` project roots, and enables automatic `src` import paths. Install Python locally as well. Configure the server executable and optional **Python interpreter** directly under **Settings → Code navigation → Python (Pyright)**, then save. Ignored virtual environments are not copied into snapshots; to resolve their installed packages, enter the absolute interpreter path, for example `/absolute/project/.venv/bin/python`. Leaving the interpreter empty uses Pyright's default Python environment. This field updates `settings.python.pythonPath` without replacing other advanced settings. Project configuration and relative source imports use the selected snapshot.

On macOS, Peer reads `PATH` from your interactive login shell (`$SHELL`, or `/bin/zsh` when unset) on the first language-server launch. Login and interactive startup are supported for zsh, bash, tcsh, and csh. This applies to every preset—Go, TypeScript/JavaScript, Python, and Rust—and custom servers, letting Finder-launched apps find servers and toolchains installed through rustup, Homebrew, or shell-managed installations. The result is cached until Peer exits and is applied only to language-server processes, not the app's global environment. Restart Peer after changing your shell's `PATH`. Shell discovery has a five-second timeout; if it fails, Peer logs the failure and uses its inherited `PATH`. Background startup jobs retaining stdout do not prevent Peer from using a complete PATH response. An explicit `env.PATH` in a server configuration takes precedence for both executable lookup and its child tools.

Use an absolute executable path if the packaged application cannot find your server on PATH. **Advanced / custom servers** edits the JSON array of server definitions: `id`, `name`, `enabled`, `languages` (extensions without dots mapped to LSP language IDs), `executable`, `args`, `rootMarkers`, `env`, `initializationOptions`, and `settings`. Only one enabled server may claim an extension. Arguments are passed directly without a shell. Root markers are checked in their configured order, from the source's directory up to the snapshot root. Save applies the configuration. Saved preferences without a server configuration receive the defaults automatically. For existing server lists, missing presets appear disabled in the tab: enable the desired preset and choose **Save navigation settings**, without resetting other servers. Existing configurations and disabled states are preserved; presets are not duplicated when a saved server already uses their ID or handles any of their extensions. **Restore presets** remains an explicit reset of the entire list, including customizations.

Analysis starts only when requested and uses an isolated copy of the selected source version. If source changes during preparation, Refresh and try again. Navigation may wait for the language server's initial analysis; you can cancel while waiting.

Locally installed dependencies are available to analysis. Returned dependency source is frozen for navigation and labelled **Installed dependency** or **Standard library**; it is not guaranteed to match a historical Git revision. Missing dependencies or toolchains can limit results. Rust build scripts and procedural macros are disabled by default, so generated symbols may be unavailable. Custom servers may need additional configuration for their language or build system.

Large JavaScript dependency installations can take time to prepare; their copy budget is 2 GiB. Files over 64 MiB are excluded from analysis. Navigation never changes your repository files or Git's index.

## Themes

Settings → Appearance includes System/Light/Dark modes, independent light/dark selections, searchable previews, and import/removal. GitHub Light/Dark, One Dark Pro, Dracula, and Catppuccin Latte/Mocha are bundled locally.

Import a self-contained VS Code `.json` or `.jsonc` theme. Validated definitions are copied into the application-data store, with IDs independent of display names. Grammar token colors and supported editor/diff/sidebar/panel/list/input/button/selection/focus colors apply across the app. Missing UI colors use light/dark defaults. Theme changes do not read Git or alter source fingerprints.

External `include` and token-color file references are rejected. Semantic tokens, icon themes, VSIX installation, and online theme installation are outside v1. Native menus and file dialogs follow the OS appearance. Theme attribution and license texts are retained in `licenses/` and bundled as resources.

## Diagnostic reports

If a file click leaves the viewer blank or another UI operation fails:

1. Reproduce the problem, then open **Settings → Diagnostics** without restarting Peer.
2. Click **Refresh report** and inspect the text preview.
3. Choose **Save report…** to export `peer-diagnostics.txt`, then share it manually with the issue report. Include the steps you took and whether you were using Code or Changes.

Reports contain the Peer version, OS version and architecture, native WebView version (the WebKit build on macOS), browser capabilities, current viewer/worker state, and timestamped navigation, file-read, parsing, rendering, and error events. The fatal-error screen also offers **Inspect and export diagnostic report**; export before choosing Reload Peer.

Diagnostics are recorded automatically in memory only, bounded to the latest 300 events and 256 KiB of event text. Restarting/reloading Peer clears them; **Clear recorded events** clears them without restarting. Nothing is uploaded or written to a report file until you choose to save. File identifiers use session-local numbers rather than names or paths, and source contents and review comments are not deliberately collected. **Error messages and stacks can contain paths or other sensitive text: inspect the preview before sharing, and redact the saved text file if necessary.**

## Saved data and limits

Preferences, saved reviews, and imported themes stay in Peer's application-data directory, separate from your repositories. Existing RepoInspector data remains available without migration. Uninstalling the app does not remove this data.

Files above 1 MiB or 20,000 lines require explicit loading. A 64 MiB inspection limit protects the viewer from very large files.

