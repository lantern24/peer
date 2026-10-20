# Peer

A local, read-only repository viewer and review workspace. Browse code and diffs, leave review comments, and copy feedback for your coding agent. Peer never edits, stages, commits, fetches, or applies changes to your repositories.

https://github.com/user-attachments/assets/d1520c86-ff5a-4d7e-8fa6-cd24cf1b46d9

Licensed under [Apache-2.0](LICENSE). Bundled dependencies and themes retain their [third-party notices](THIRD_PARTY_NOTICES.md).

## Install with Homebrew

Requirements: [Homebrew](https://brew.sh/), an Apple Silicon Mac (arm64), and macOS 13 or later. Intel Macs are not supported by the current release bundle. Git is required; Homebrew installs it automatically. Node.js and Rust are not needed to run Peer, though optional code-navigation servers require their own toolchains.

```sh
brew update
brew install --cask lantern24/tap/peer
```

The fully qualified cask name adds the [Lantern24 tap](https://github.com/lantern24/homebrew-tap) automatically; a separate `brew tap` command is not needed. Homebrew downloads the published release ZIP, verifies its SHA-256 checksum, installs `Peer.app` into `/Applications` by default, and installs Git as a runtime dependency.

Automatic repository-change monitoring requires Git 2.42+; manual refresh remains available with older versions. If Peer cannot find Git, set its executable path in Settings → Git.

### First launch on macOS

Current releases are ad-hoc signed, not Developer ID signed or notarized by Apple. A valid signature protects bundle integrity but does not make Gatekeeper trust the app; Homebrew installation does not remove this distinction.

1. Open **Peer** from Applications or Spotlight.
2. If macOS blocks the launch because the developer cannot be verified, and you trust the download, open **System Settings → Privacy & Security** and scroll to **Security**.
3. Choose **Open Anyway** for Peer, if available, and confirm **Open** in the next dialog.

See [Apple's instructions for opening an app from an unidentified developer](https://support.apple.com/en-us/102445). Managed Macs may prohibit this exception. Do not disable Gatekeeper globally or bypass a malware warning.

### Upgrade

```sh
brew update
brew upgrade --cask lantern24/tap/peer
```

Quit Peer before upgrading, then reopen it afterward.

If you installed v0.1.0 and macOS reports the app as damaged, upgrade to v0.1.1 or later: v0.1.0 had an invalid bundle signature. The integrity fix does not add notarization. If a newer version still reports damage, [report the problem](https://github.com/lantern24/peer/issues) rather than treating it as an ordinary unidentified-developer warning.

### Uninstall

```sh
brew uninstall --cask lantern24/tap/peer
```

This removes the app bundle; saved review data and preferences are retained.

## User manual

See the [user manual](docs/USER_MANUAL.md) for opening repositories, choosing comparisons, browsing changes, adding review comments, refreshing, and exporting feedback.

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

Development and contributor guidance is in [AGENTS.md](AGENTS.md).
