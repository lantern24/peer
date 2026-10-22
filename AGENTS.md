# Peer contributor guide

Development, release, architecture, and validation guidance lives here. Keep [README.md](README.md) focused on the product overview, installation, and documentation links; document detailed usage, configuration, and troubleshooting in the [user manual](docs/USER_MANUAL.md).

Peer is built with Tauri 2, React, TypeScript, and an independent Rust core. Preserve its read-only behavior: the app never edits, stages, commits, fetches, or applies changes to viewed repositories.

## Run and build

Requirements: Node.js 22+, Rust 1.88+, Git, and [Tauri's platform prerequisites](https://v2.tauri.app/start/prerequisites/). Mac releases support Apple Silicon (arm64), with macOS 13 or later. Install Xcode Command Line Tools for macOS development. Linux releases target x86_64 and are built on Ubuntu 22.04 to avoid requiring a newer glibc baseline.

Automatic repository-change monitoring requires Git 2.42+ for attribute-path discovery. Unsupported Git versions report monitoring unavailable; manual refresh remains available.

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

Production Linux packages (on an x86_64 Linux host with Tauri's prerequisites installed):

```sh
rustup target add x86_64-unknown-linux-gnu
npm run bundle:linux
```

The `.deb` and AppImage are written under `target/x86_64-unknown-linux-gnu/release/bundle/deb` and `target/x86_64-unknown-linux-gnu/release/bundle/appimage`. The Debian package declares Git as a runtime dependency; AppImage users must install Git separately. The Linux packaging workflow installs the WebKitGTK 4.1 and other native build dependencies. AppImage packaging uses `APPIMAGE_EXTRACT_AND_RUN=1` so its tools do not require a FUSE mount.

The shared logo source is `assets/icon.svg`. After editing it, run `npm run icons` to regenerate the desktop icons; the header and welcome screen use the SVG directly.

## Releases

[Release Please](https://github.com/googleapis/release-please) runs on pushes to `main` and can also be dispatched manually on `main`. It maintains a release PR with version updates and a generated `CHANGELOG.md`. Merge that PR to create the GitHub release and its `vX.Y.Z` tag.

The initial release version is **v0.1.0**. `initial-version` applies only to that first release, so it does not pin later releases; `.release-please-manifest.json` records the released version. Use Conventional Commit messages (including squash-merge titles): `fix:` bumps the patch, `feat:` bumps the minor, and `!` or a `BREAKING CHANGE:` footer signals a breaking change. Before 1.0, breaking changes bump the minor rather than jumping to 1.0; after 1.0, they bump the major.

`release-please-config.json` keeps `package.json`, `package-lock.json`, `src-tauri/tauri.conf.json`, the Cargo workspace version, and the `peer`/`peer-core` entries in `Cargo.lock` synchronized. The app footer reads the package version rather than a separate hard-coded label. The Cargo lockfile selector uses `name.value` because Release Please's TOML parser wraps scalar values with source-location metadata; dependency versions are left untouched.

Repository setup:

- When using the built-in `GITHUB_TOKEN`, enable **Settings → Actions → General → Workflow permissions → Allow GitHub Actions to create and approve pull requests**. The workflow requests the write permissions it needs.
- For automatic CI on release PRs, add a `RELEASE_PLEASE_TOKEN` Actions secret containing a token with repository **Contents**, **Issues**, and **Pull requests** read/write permissions. Without it, the workflow uses `GITHUB_TOKEN`, whose generated PRs do not trigger other workflows. Run **Verify Peer** manually on the release PR branch before merging in that case.
- Apple signing and notarization secrets remain optional, as described above; without them, release bundles are ad-hoc signed but not notarized.

After creating a release, the release workflow directly calls both packaging workflows with its exact tag. This does not rely on tag/release events, which `GITHUB_TOKEN` cannot use to trigger another workflow:

- `.github/workflows/macos-release.yml` builds `Peer-macOS-arm64.app.zip`. Before uploading, it runs `codesign --verify --deep --strict` on both the built app and a fresh extraction of the ZIP; signature failures stop publication. The ZIP preserves the app bundle's executable permissions.
- `.github/workflows/linux-release.yml` builds `Peer-Linux-x86_64.deb` and `Peer-Linux-x86_64.AppImage` on Ubuntu 22.04. Before uploading, it checks the Debian package's architecture and metadata and extracts the AppImage to verify that it contains the executable.

Both workflows retain their packages as Actions artifacts and attach them to the same GitHub release. To retry packaging/uploading an existing release, dispatch **Package macOS (Apple Silicon)** or **Package Linux (x86_64)** with its `release-tag`; leave that input blank for an artifact-only build of the selected branch. Linux packaging needs no additional secrets. Downloaded AppImage artifacts may need `chmod +x` before execution.

## Architecture and storage

`crates/repo-core` implements Git discovery, comparisons, snapshot validation, read-only change probes, comment/review services, export, preferences, and theme validation. It has no dependency on Tauri. `src-tauri` exposes typed commands, active-repository monitoring, and native menus/dialogs/clipboard. `src/Viewer.tsx` adapts `@pierre/diffs` with virtualized file/line rendering, a diff worker, and a Shiki worker pool. Syntax grammars and themes are packaged locally.

The viewer uses one Shiki worker with the Oniguruma/WASM engine. File and diff highlighting share a 24 MiB estimated retained-data budget and a 12-result limit; refresh and view/repository switches clear cached results. Code source uses an 8 MiB / 8-file LRU, retaining the active file even if it exceeds the budget. Diff models retain full source lines for context expansion and stable scroll layout, without a second copy of the original source strings. The parser worker terminates after 15 seconds idle. These are cache budgets, not a cap on total WebView memory: active renderers, diff models, syntax grammars, and the JavaScript heap add overhead.

Peer retains the original `dev.repoinspector.app` application identifier and OS-specific application-data directory so existing RepoInspector settings, reviews, and imported themes remain available without migration. A versioned `state.json` contains preferences, queues, and normalized imported themes. Atomic file replacement, a process mutex, and an OS file lock serialize writes. Invalid saved data produces an error and is preserved. `PEER_DATA_DIR` may override the store location for testing; the legacy `REPO_INSPECTOR_DATA_DIR` override is also accepted, with `PEER_DATA_DIR` taking precedence.

Git runs asynchronously with argument arrays, NUL-delimited path metadata, disabled external diff/textconv, and optional locks disabled. The app never edits, stages, commits, fetches, or applies repository changes. It tries PATH and common installed Git locations; Settings accepts an explicit executable path.

Snapshot IDs and source fingerprints prevent feedback from attaching to a different version. Saved comments retain their original anchors, Git revisions, timestamps, and code context internally. Copying or saving feedback exports only the relative filename, line number when applicable, and comment text, plus old-side/outdated markers when needed. Renamed files use their current comparison path.

Repository monitoring compares Git-aware file metadata, content hashes of Git's info/global/system attribute files, submodule HEAD/dirty state, effective comparison-related configuration, and logical index/revision state against a baseline captured during snapshot creation; it does not reload displayed source or reconcile saved feedback. Native events share one pending rescan, with a 300 ms quiet period and a one-second maximum debounce window. An initial probe after watcher installation catches edits made before activation; focus/visibility checks and watcher overflow events request another probe. Snapshot/watch identities reject late events after switching repositories or refreshing.

External attribute files use non-recursive containing-directory watches, retaining initial ancestor coverage while following newly created parents. Atomic replacements, missing files, and symlink targets are tracked without adding recursive home or system directory watches. Attribute contents are streamed into hashes rather than retained in memory.

A timed-out probe reports monitoring unavailable but remains the single in-flight scan until its work completes. Focus checks coalesce behind it, including after repository switches, so a stalled filesystem cannot accumulate blocking scans. Manual refresh remains available.

A future MCP adapter can instantiate the Rust `Inspector` against the same store. MCP transport, browser distribution, repository-wide text search, image comparison, and editing are not included.

### Code navigation internals

User-facing server installation and configuration are documented in the [user manual](docs/USER_MANUAL.md#code-navigation).

Analysis starts only when requested. Peer copies the chosen version into an isolated temporary workspace with its project files and configuration. It checks working-file stamps before and after copying; source changes during preparation require Refresh. Once prepared, navigation uses that frozen source until refresh. Up to four language-server sessions are retained, with a five-minute idle timeout and at most 32 open documents per session. Temporary workspaces are removed when their navigation context is released or the app exits.

Rust navigation waits for rust-analyzer's [analysis-ready status](https://rust-analyzer.github.io/book/contributing/lsp-extensions.html#server-status), including its initial workspace load. If analysis changes while a definition or reference request is in flight, Peer waits for readiness and reissues that request within the original 30-second deadline. Cancellation remains available during this wait. Empty results from a ready server are returned normally; Peer does not blindly retry missing symbols. Servers without these status notifications retain their existing request behavior.

Definition and reference requests retry the LSP `ContentModified` response when background analysis is invalidated, using the same frozen source and the original 30-second request deadline. Other server errors still surface immediately. Cancellation and refresh stop the outstanding navigation, including any retry wait.

Installed JavaScript dependency trees are copied into the temporary workspace, with package links to repository files redirected to the selected snapshot. Their copy budget is 2 GiB; preparing a large installation can take time. Files over 64 MiB are excluded from analysis; large source previews retain the viewer's explicit-load behavior. Absolute imports that resolve back into live repository source are rejected instead of opening the wrong revision. Symbol navigation does not change repository files, Git's index, or review fingerprints.

### Mouse navigation

- **Shared handling on macOS, Windows, and Linux:** [src/useNavigation.ts](src/useNavigation.ts) handles standard mouse Back / Forward button events and `BrowserBack` / `BrowserForward` key events delivered to the WebView. Mouse buttons mapped to the [navigation shortcuts](docs/USER_MANUAL.md#code-navigation) use the existing keyboard navigation path.
- **Additional native handling on macOS:** [src-tauri/src/macos_navigation.rs](src-tauri/src/macos_navigation.rs) handles discrete AppKit horizontal swipe events (`NSEventTypeSwipe`), such as Logi Options+’s Back / Forward gesture assignments. This module and its AppKit dependencies compile only on macOS. Ordinary scrolling is unchanged.
- **Windows and Linux boundary:** there are no additional native mouse-driver command handlers for these platforms. A proprietary or OS-level command that does not reach the WebView as a supported mouse/key event will not trigger Peer’s view history.

Mouse side buttons, `BrowserBack` / `BrowserForward` keys, and native swipes do not navigate behind an open dialog or leave the Peer document at the ends of history. Browser navigation keys are also consumed without traversal while typing; keyboard shortcuts leave text fields and dialogs untouched.

**Verification limits:** desktop regressions run in the macOS WebView using synthesized mouse/key events and native AppKit discrete-swipe injection. Windows/Linux keyboard mappings are emulated in that WebView, not tested on those operating systems. Mouse navigation has not been verified on actual Windows/Linux runtimes or physical mouse/driver combinations; these checks do not establish universal hardware compatibility.

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

CI runs Rust core tests on macOS, Windows, and Linux, frontend tests/builds, and the macOS desktop suite. A dedicated Ubuntu job installs pinned Go/gopls, Node/TypeScript/typescript-language-server, Rust/rust-analyzer, and Python/Pyright toolchains and explicitly runs both real-server navigation tests; they remain opt-in for the ordinary local core suite. The pins live in `.github/workflows/ci.yml`. Release packaging covers macOS arm64 and Linux x86_64; Windows desktop releases and Linux desktop UI automation remain future work. A CI configuration is not evidence of a completed remote run.
