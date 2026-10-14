# Peer

A local, read-only repository viewer and review workspace. Built with Tauri 2, React, TypeScript, and an independent Rust core. Git is required on the user's machine; Node.js and Rust are development dependencies only.

Licensed under [Apache-2.0](LICENSE). Bundled dependencies and themes retain their [third-party notices](THIRD_PARTY_NOTICES.md).

## Install with Homebrew

Requirements: [Homebrew](https://brew.sh/), an Apple Silicon Mac (arm64), and macOS 13 or later. Intel Macs are not supported by the current release bundle. Node.js and Rust are only needed for development, not installation.

```sh
brew update
brew install --cask lantern24/tap/peer
```

The fully qualified cask name adds the [Lantern24 tap](https://github.com/lantern24/homebrew-tap) automatically; a separate `brew tap` command is not needed. Homebrew downloads the published release ZIP, verifies its SHA-256 checksum, installs `Peer.app` into `/Applications` by default, and installs Git as a runtime dependency.

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

## Run and build

Requirements: Node.js 22+, Rust 1.88+, Git, and [Tauri's platform prerequisites](https://v2.tauri.app/start/prerequisites/). Mac releases support Apple Silicon (arm64), with macOS 13 or later. Install Xcode Command Line Tools for macOS development.

```sh
npm ci
npm run desktop
```

Production Apple Silicon app (without the test driver):

```sh
rustup target add aarch64-apple-darwin
npm run bundle
# Optional disk image:
npm run bundle:dmg
```

The app is written to `target/aarch64-apple-darwin/release/bundle/macos/Peer.app`. The optional disk image is written to `target/aarch64-apple-darwin/release/bundle/dmg`. The executable is named `peer`. Both bundle commands default to ad-hoc signing (`bundle.macOS.signingIdentity: "-"`), which seals the complete app without Apple credentials. This provides signature integrity, not an Apple-verified publisher or notarization; macOS may still require explicit approval to open the app. For Developer ID signing and notarization, configure Tauri's `APPLE_SIGNING_IDENTITY`, certificate/password, and Apple notarization credentials. The environment signing identity overrides the ad-hoc default. `.github/workflows/macos-release.yml` reads these values from GitHub Actions secrets.

The shared logo source is `assets/icon.svg`. After editing it, run `npm run icons` to regenerate the desktop icons; the header and welcome screen use the SVG directly.

## Releases

[Release Please](https://github.com/googleapis/release-please) runs on pushes to `main` and can also be dispatched manually on `main`. It maintains a release PR with version updates and a generated `CHANGELOG.md`. Merge that PR to create the GitHub release and its `vX.Y.Z` tag.

The first release is **v0.1.0**. `.release-please-manifest.json` starts empty because no version has been released yet; Release Please fills it when preparing the first release PR. `initial-version` applies only to that first release, so it does not pin later releases. Use Conventional Commit messages (including squash-merge titles): `fix:` bumps the patch, `feat:` bumps the minor, and `!` or a `BREAKING CHANGE:` footer signals a breaking change. Before 1.0, breaking changes bump the minor rather than jumping to 1.0; after 1.0, they bump the major.

`release-please-config.json` keeps `package.json`, `package-lock.json`, `src-tauri/tauri.conf.json`, the Cargo workspace version, and the `peer`/`peer-core` entries in `Cargo.lock` synchronized. The app footer reads the package version rather than a separate hard-coded label. The Cargo lockfile selector uses `name.value` because Release Please's TOML parser wraps scalar values with source-location metadata; dependency versions are left untouched.

Repository setup:

- When using the built-in `GITHUB_TOKEN`, enable **Settings → Actions → General → Workflow permissions → Allow GitHub Actions to create and approve pull requests**. The workflow requests the write permissions it needs.
- For automatic CI on release PRs, add a `RELEASE_PLEASE_TOKEN` Actions secret containing a token with repository **Contents**, **Issues**, and **Pull requests** read/write permissions. Without it, the workflow uses `GITHUB_TOKEN`, whose generated PRs do not trigger other workflows. Run **Verify Peer** manually on the release PR branch before merging in that case.
- Apple signing and notarization secrets remain optional, as described above; without them, release bundles are ad-hoc signed but not notarized.

After creating a release, the release workflow directly calls `.github/workflows/macos-release.yml` to build its exact tag and attach `Peer-macOS-arm64.app.zip`. This does not rely on tag/release events, which `GITHUB_TOKEN` cannot use to trigger another workflow. Before uploading, the workflow runs `codesign --verify --deep --strict` on both the built app and a fresh extraction of the ZIP; signature failures stop publication. The ZIP preserves the app bundle's executable permissions and is also retained as an Actions artifact. To retry packaging/uploading an existing release, dispatch **Package macOS (Apple Silicon)** with its `release-tag`; leave that input blank for an artifact-only build of the selected branch.

## Review workflow

Open a repository with the **+** button beside the repository name or ⌘/Ctrl O. Click the repository name to switch among the 12 most recently opened repositories; the dropdown shows their paths and marks the current one. Use arrow keys and Enter to choose, or Escape to close. The first opening shows Changes if any exist, otherwise Code. The app restores each repository's comparison, selected file, and scroll position, and keeps comment drafts while switching. Refresh with the toolbar or ⌘/Ctrl R after your agent edits files.

For a renamed or moved repository, use its **Update location** folder icon in the dropdown, enter or browse to the new repository root, then choose **Update location**. Peer validates and opens the new location, replaces the old name/path, and preserves the saved view, comments, and Reviewed state. Invalid locations or locations already saved for another repository leave the original entry unchanged. This is an explicit repair, not automatic filesystem tracking.

For a deleted or unwanted repository, use its **Remove from list** × button. Removing the active entry returns to the welcome screen; other open repositories are unaffected. Removal persists across restarts but never deletes repository files or saved review data. In the dropdown, Up/Down moves between repositories and Left/Right reaches each row's location and removal actions.

- **Code:** existing tracked files plus non-ignored untracked files in the working directory.
- **All local changes:** HEAD against working files, combining staged and unstaged edits.
- **Staged:** HEAD against the index. **Unstaged:** index against working files.
- **Compare to branch:** the merge base of that branch and HEAD against working files. This includes committed branch changes and local edits. No automatic fetch.
- **Commit history:** click the branch name beside Code/Changes to browse commits, with older history loaded on demand. Select a commit to review its diff against its first parent (or the empty tree for the initial commit). Merge commits show what they introduced relative to their first parent. These diffs use committed files, independent of local edits, with separate review comments for each commit. Choose All local changes in the comparison selector to return to the working directory.

Filter filenames in the sidebar, use ⌘/Ctrl P for quick-open, ⌘/Ctrl F for in-file search, and ⌘/Ctrl G to jump to a line. Quick-open focuses the search field automatically; use ↑/↓ or Ctrl+P/Ctrl+N to highlight a result, then Enter to open it. Switch unified/split layouts or toggle whitespace markers in the viewer toolbar. Source tabs, spaces, CRLF, and trailing whitespace are retained. EditorConfig supplies tab width, falling back to the width in Settings.

Search highlights the matching text in filenames and source. In-file Find highlights every visible occurrence in the selected file; Enter/Shift+Enter or the arrow buttons move between matches, with a stronger highlight on the current occurrence. Matching is literal and case-insensitive, including repeated matches on the same line. Press Esc or click Close search to hide Find and remove the source highlights.

As you scroll Changes, the navigator highlights the file at the top of the diff viewport and keeps its row visible, expanding parent folders as needed. Keyboard focus and your filename filter are preserved.

Drag the inner edge of either sidebar to resize it. Widths are remembered across restarts, and narrower windows temporarily reduce them to keep the source visible. Focus a divider and use Left/Right arrows to resize (Shift moves faster), Home/End for its limits, or double-click to reset its width. Esc cancels an active drag. The right-side width also applies to navigation results; hiding Feedback preserves its width and draft.

Settings is organized into **Appearance**, **Viewer**, **Code navigation**, and **Git** tabs. Click a tab or use Left/Right arrows (Home/End jump to the first/last tab) while the tab row has focus. Each section scrolls independently, and switching tabs preserves unsaved language-server edits. Settings → Viewer → Code font size adjusts Code and Changes from 10–32 px and is saved across restarts. Drag the top title bar, including the app name, to move the window.

Use the gutter **+** to comment on a line, or a file header's comment button for a file comment. Comments can be edited, deleted individually, or cleared from the active queue. Changes files can be marked Reviewed. Feedback is stored per worktree and branch, with distinct Code and comparison queues.

Refresh marks comments outdated when their file fingerprint changes, and resets Reviewed for changed files. Original anchors and context remain intact, including feedback on files that disappear. Drafts survive theme and view switching during the session; only saved comments survive application restarts.

The toolbar Refresh button and Refresh Repository menu command reload immediately. If files or Git's index change during that reload, Peer retries with a fresh snapshot (up to three attempts) before showing an error. Stale reads and review actions still offer a refresh without silently replacing the source being reviewed.

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

File comments omit `line`. Line numbers are one-based; diff comments on the old side additionally include `"side": "old"`. Outdated comments are included with `"outdated": true`, retaining their original location. Copying does not clear feedback. Save JSON and the selectable clipboard fallback use the same concise format.

## Code navigation

Click a symbol or select its text, then press **F12** to open its definition. **⌘-click** on macOS, **Ctrl-click** on other platforms, and the source context menu do the same. At a definition, F12 opens a references panel; **Shift-F12** or **Find References** requests references directly. Multiple definitions appear as selectable results.

Destinations open as complete, read-only source files, including files that are unchanged and absent from the diff list. In Changes, every repository jump retains the selected side: A uses HEAD (the index for Unstaged, or merge base for branch comparisons); B uses working files (the index for Staged). In split view, click the relevant column. In unified view, additions use B and deletions use A; the **Navigate shared lines** control chooses the version for unchanged lines, defaulting to B. The destination header identifies its version.

**Ctrl+-** or the toolbar Back button restores the previous file, source selection, scroll position, and diff expansion state. History includes file selection, quick-open, search results, line jumps, comment jumps, and symbol jumps. It holds up to 100 entries for the current comparison and resets on refresh, comparison changes, or opening another repository. Source pages retain the original feedback queue and drafts; comments and Reviewed actions remain in the review view. Find and Go to Line operate on the displayed source page.

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

Analysis starts only when requested. Peer copies the chosen version into an isolated temporary workspace with its project files and configuration. It checks working-file stamps before and after copying; source changes during preparation require Refresh. Once prepared, navigation uses that frozen source until refresh. Up to four language-server sessions are retained, with a five-minute idle timeout and at most 32 open documents per session. Temporary workspaces are removed when their navigation context is released or the app exits.

Rust navigation waits for rust-analyzer's [analysis-ready status](https://rust-analyzer.github.io/book/contributing/lsp-extensions.html#server-status), including its initial workspace load. If analysis changes while a definition or reference request is in flight, Peer waits for readiness and reissues that request within the original 30-second deadline. Cancellation remains available during this wait. Empty results from a ready server are returned normally; Peer does not blindly retry missing symbols. Servers without these status notifications retain their existing request behavior.

Definition and reference requests retry the LSP `ContentModified` response when background analysis is invalidated, using the same frozen source and the original 30-second request deadline. Other server errors still surface immediately. Cancellation and refresh stop the outstanding navigation, including any retry wait.

Locally installed dependencies are available to analysis. Returned dependency source is frozen for navigation and labelled **Installed dependency** or **Standard library**; it is not guaranteed to match a historical Git revision. Missing dependencies or toolchains can limit results. Rust build scripts and procedural macros are disabled by default, so generated symbols may be unavailable. Custom servers may need additional configuration for their language or build system.

Installed JavaScript dependency trees are copied into the temporary workspace, with package links to repository files redirected to the selected snapshot. Their copy budget is 2 GiB; preparing a large installation can take time. Files over 64 MiB are excluded from analysis; large source previews retain the viewer's explicit-load behavior. Absolute imports that resolve back into live repository source are rejected instead of opening the wrong revision. Symbol navigation does not change repository files, Git's index, or review fingerprints.

## Themes

Settings → Appearance includes System/Light/Dark modes, independent light/dark selections, searchable previews, and import/removal. GitHub Light/Dark, One Dark Pro, Dracula, and Catppuccin Latte/Mocha are bundled locally.

Import a self-contained VS Code `.json` or `.jsonc` theme. Validated definitions are copied into the application-data store, with IDs independent of display names. Grammar token colors and supported editor/diff/sidebar/panel/list/input/button/selection/focus colors apply across the app. Missing UI colors use light/dark defaults. Theme changes do not read Git or alter source fingerprints.

External `include` and token-color file references are rejected. Semantic tokens, icon themes, VSIX installation, and online theme installation are outside v1. Native menus and file dialogs follow the OS appearance. Theme attribution and license texts are retained in `licenses/` and bundled as resources.

## Architecture and storage

`crates/repo-core` implements Git discovery, comparisons, snapshot validation, comment/review services, export, preferences, and theme validation. It has no dependency on Tauri. `src-tauri` exposes typed commands and native menus/dialogs/clipboard. `src/Viewer.tsx` adapts `@pierre/diffs` with virtualized file/line rendering, a diff worker, and a Shiki worker pool. Syntax grammars and themes are packaged locally.

The viewer uses one Shiki worker with the Oniguruma/WASM engine. File and diff highlighting share a 24 MiB estimated retained-data budget and a 12-result limit; refresh and view/repository switches clear cached results. Code source uses an 8 MiB / 8-file LRU, retaining the active file even if it exceeds the budget. Diff models retain full source lines for context expansion and stable scroll layout, without a second copy of the original source strings. The parser worker terminates after 15 seconds idle. These are cache budgets, not a cap on total WebView memory: active renderers, diff models, syntax grammars, and the JavaScript heap add overhead.

Peer retains the original `dev.repoinspector.app` application identifier and OS-specific application-data directory so existing RepoInspector settings, reviews, and imported themes remain available without migration. A versioned `state.json` contains preferences, queues, and normalized imported themes. Atomic file replacement, a process mutex, and an OS file lock serialize writes. Invalid saved data produces an error and is preserved. `PEER_DATA_DIR` may override the store location for testing; the legacy `REPO_INSPECTOR_DATA_DIR` override is also accepted, with `PEER_DATA_DIR` taking precedence.

Git runs asynchronously with argument arrays, NUL-delimited path metadata, disabled external diff/textconv, and optional locks disabled. The app never edits, stages, commits, fetches, or applies repository changes. It tries PATH and common installed Git locations; Settings accepts an explicit executable path.

Snapshot IDs and source fingerprints prevent feedback from attaching to a different version. Saved comments retain their original anchors, Git revisions, timestamps, and code context internally. Copying or saving feedback exports only the relative filename, line number when applicable, and comment text, plus old-side/outdated markers when needed. Renamed files use their current comparison path.

A future MCP adapter can instantiate the Rust `Inspector` against the same store. MCP transport, browser distribution, filesystem watching, Git history browsing, repository-wide text search, image comparison, and editing are not included.

## Validation

See [the validation record](docs/VALIDATION.md) for native test results, benchmark measurements, and release boundaries.

```sh
npm test
cargo test -p peer-core --locked
# Optional real-server smoke tests, after installing their server presets:
cargo test -p peer-core --test navigation real_language_servers -- --ignored
cargo test -p peer-core --test navigation real_python_server -- --ignored
npm run build:test-app
npm run test:desktop
# Run a single native scenario with its own prerequisites:
npm run test:desktop -- --spec tests/desktop/repositories.spec.ts --mochaOpts.grep "updates a moved repository"
# macOS memory workload (isolated app; includes compressed WebKit memory)
PEER_MEMORY_TEST=1 npm run test:desktop
```

Desktop tests launch the actual app through WebdriverIO's embedded Tauri driver. They create temporary Git repositories and an isolated data store; each scenario resets its preferences/session and supplies its own review state so it can run independently. Test plugins and the frontend bridge are feature/environment gated and excluded from normal packages. Logs, screenshots, and performance measurements go into `test-results/`.

The benchmark uses 100 changed TypeScript files and 10,000 changed lines. Warm navigation measures from the file click until that file is active and its expected source is visible in the viewport, followed by paint; missing targets or navigation that never arrives fail even in report mode. Targets: warm navigation below 100 ms and p95 scrolling frame intervals below 33 ms. Results include the reference CPU/OS. Files above 1 MiB or 20,000 lines require explicit loading; highlighting is bounded on long lines. A 64 MiB inspection limit protects the viewer from very large payloads.

Local desktop runs enforce those timing targets by default and require an active, unlocked desktop. GitHub-hosted CI sets `PEER_PERFORMANCE_MODE=report`: it still measures performance, records whether the targets were exceeded in `performance.json`, and adds the measurements to the job summary. Functional failures still fail CI. Use `PEER_PERFORMANCE_MODE=enforce` on a controlled benchmark machine to enforce the same targets; `report` also permits functional checks when the host suspends animation frames, explicitly recording performance as unmeasured. Timing targets are not adjusted to make a slower run pass.

On macOS, run the desktop CI job locally with `act` using its native host executor:

```sh
caffeinate -d -i -u -t 1200 act push \
  -W .github/workflows/ci.yml -j mac-desktop \
  -P macos-latest=-self-hosted --no-cache-server \
  --artifact-server-path /tmp/peer-act-artifacts \
  --artifact-server-addr 127.0.0.1
```

Keep the desktop unlocked and avoid mouse/keyboard input throughout the run. `caffeinate` prevents idle sleep but cannot unlock an already locked session. This runs the workflow on your Mac, not in a GitHub VM or Docker container; its setup actions install/select host Rust and Node toolchains. Omit `--bind`: the native executor needs checkout to copy the working tree into its workspace. The local artifact server retains `desktop-test-results` under the specified directory.

CI runs Rust core tests on macOS, Windows, and Linux, frontend tests/builds, and the macOS desktop suite. A dedicated Ubuntu job installs pinned Go/gopls, Node/TypeScript/typescript-language-server, Rust/rust-analyzer, and Python/Pyright toolchains and explicitly runs both real-server navigation tests; they remain opt-in for the ordinary local core suite. The pins live in `.github/workflows/ci.yml`. Windows/Linux desktop releases remain future work; a CI configuration is not evidence of a completed remote run.
