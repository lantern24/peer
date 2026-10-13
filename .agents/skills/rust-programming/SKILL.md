---
name: rust-programming
description: "Use this skill when writing, reviewing, debugging, or refactoring Rust in Peer, including peer-core, the Tauri command bridge, Git snapshots, persistent reviews, and language-server navigation."
---

# Rust programming in Peer

For `lantern24/peer`, make the smallest complete change that preserves read-only inspection and trustworthy feedback.
These are implementation guidelines, not claims that every rule is already enforced by tooling.
For mixed IPC changes, also use [TypeScript programming](../typescript-programming/SKILL.md).

## Start with the boundary

- Read the affected implementation, callers, and behavior tests before editing. Trace one request
  from `src/api.ts` through `src-tauri/src/lib.rs` to `crates/repo-core/src/service.rs`.
- Keep reusable behavior in `peer-core`; its manifest has no Tauri dependency. Keep the native
  bridge focused on commands, application state, menus, and OS integration.
- Use `crates/repo-core/src/repository.rs` for Git/source handling, `store.rs` for persistence,
  `navigation.rs` and `lsp.rs` for analysis, `theme.rs` for imported-theme validation, and
  `types.rs` for shared data. Resolve these module names under `crates/repo-core/src/`.
- Target Rust 2021 and the workspace's Rust 1.88 minimum. Check `Cargo.toml` and the affected
  package manifest before using newer APIs or changing features; do not silently raise the MSRV.
- For Tauri/WebView or macOS integration changes, preserve the minimum macOS version in
  `src-tauri/tauri.conf.json` and follow the
  [WebKit compatibility guidance](../typescript-programming/SKILL.md#preserve-webkit-compatibility).
  A newer Rust SDK or successful native build does not upgrade the user's system WKWebView;
  web API changes need supported signatures, fallbacks, and native behavioral regressions.
- Prefer existing helpers and concrete functions over new frameworks, type-state layers, or
  dependencies. Do not turn a scoped fix into a repository-wide style or error-system migration.

## Ownership, types, and errors

- Accept borrowed `&str`, `&Path`, and slices for inspection; move owned results when ownership
  transfers. Use `as_deref()` and iterator borrowing instead of allocating temporary strings.
- Avoid cloning file bodies, collecting intermediate vectors, or serializing data twice merely
  to satisfy an API. Retain ownership when required for a task, persisted value, or wire result.
- Follow `Inspector::snapshot`: clone an `Arc<RepositorySnapshot>` to release the map guard,
  not the full snapshot. Do not remove useful shared ownership just to eliminate `.clone()`.
- Prefer `Option`, `Result`, and exhaustive enums for internal states when they clarify a real
  invariant. Preserve validated wire strings such as comparison modes unless migrating every consumer.
- Match existing errors: ordinary services return `Result<T, String>`; navigation uses the
  serializable `NavigationError { code, message }`. Preserve meaningful codes and recovery advice.
- Add context at the failing I/O or protocol boundary; propagate with `?`. Do not hide corruption,
  stale source, or failed persistence behind default success values or blanket error suppression.
- Return errors for malformed paths, JSON, process output, sizes, and coordinates; do not add
  `unwrap`, `expect`, unchecked indexing, or panics on external input. Document true internal invariants.
- Use safe Rust. Introduce `unsafe` only for a specific necessary operation with documented
  safety proof and targeted coverage, never as an unmeasured performance shortcut.

## Preserve the wire and stored-data contracts

- Keep Serde camelCase names, enum/string values, defaults, and omitted-versus-null option fields
  aligned with `src/types.ts`, `src/api.ts`, and the registered commands in `src-tauri/src/lib.rs`.
- Treat a Rust type change as a consumer change: update frontend handling and relevant contract
  fixtures together. TypeScript annotations alone do not validate a native response at runtime.
- Keep UTF-16 navigation positions distinct from UTF-8 byte offsets and one-based review lines;
  preserve CRLF, Unicode, side selection, and absent-side behavior when computing anchors.
- For persistence changes, inspect `AppData` and existing preference/default tests in
  `crates/repo-core/tests/review.rs`; preserve existing data or implement an explicit migration.

## Git, paths, snapshots, and feedback

- Never edit, stage, commit, fetch, checkout, or apply changes to a repository being inspected.
  Keep application data and navigation workspaces outside it; test fixture setup is separate.
- Invoke Git and language servers with argument arrays, not shell interpolation. Preserve Git's
  disabled optional locks/prompts, NUL-delimited path parsing, and disabled external diff/textconv.
  Keep option/path separators and revision validation appropriate to the particular Git command.
- Reuse `repository::safe_path` for repository-relative access; preserve rejection of traversal
  and directory symlinks. Do not treat lexical joining as proof of canonical containment.
- Preserve the distinction between source symlinks, snapshot source, and installed dependencies.
  Reject navigation back into the wrong live repository revision; use validated document handles.
- Keep before/after source checks, snapshot IDs, fingerprints, and pinned commit identities.
  A refresh race must not silently combine revisions, discard feedback, or attach it to new content.
- Validate a comment/review against current content before writing. Preserve original anchors,
  outdated markers, queue identity, and reviewed-fingerprint invalidation in `service.rs`.
- Retain explicit deferred loading above 1 MiB or 20,000 lines and the 64 MiB inspection limit;
  `force` bypasses deferral, not safety. Preserve binary/conflict/submodule summaries.
- Keep imported themes self-contained: preserve the 2 MiB input limit and rejection of external
  includes/token-color files in `crates/repo-core/src/theme.rs`.

## Async work, processes, and persistence

- Use asynchronous process I/O for child work. For new substantial blocking filesystem or CPU
  work on an async path, use a scoped blocking task or another justified boundary; `async fn`
  alone does not make synchronous work nonblocking. Do not scatter detached tasks over the problem.
- Keep synchronous guards out of `.await`; minimize async lock scope. Extract owned/`Arc` handles
  before slow work when safe, while preserving atomic request-registration/invalidation ordering.
- Preserve cancellation, deadlines, late-response rejection, failed-session retirement, and
  shutdown on refresh/exit. Kill and reap children before releasing their temporary workspace;
  a drop-time kill request is not evidence that the process has exited.
- Retain navigation's four-session cap, five-minute idle retirement, 32 open documents per session,
  and 2 GiB dependency-copy budget. Preserve bounded LSP headers/bodies/stderr and request timeouts.
  Bound any new queues, output accumulation, or subprocess fan-out; current Git output collection
  and the LSP outbound channel are not universal resource bounds.
- Keep LSP `workspace/applyEdit` rejected. Do not enable repository-mutating analysis behavior,
  build scripts, or procedural macros as an incidental navigation fix.
- Route mutations through `Store::update`: process mutex, OS file lock, reload under lock,
  successful mutation/serialization, same-directory temporary file, file sync, atomic replacement.
  Keep transaction closures short and synchronous; never read-modify-write outside this boundary.
- Preserve malformed or unsupported-version `state.json` and return its error. Only a missing
  store starts from defaults; a failed action must not overwrite the previous state.

## Test the consumer-visible behavior

- Update affected contract tests and retain a bug regression when practical. Add new tests for
  uncertain edges or explicit requirements, not forwarding, private structure, or copied defaults.
- Use the nearest focused suite: `crates/repo-core/tests/review.rs` for feedback/storage,
  `crates/repo-core/tests/history.rs` for frozen commits, and
  `crates/repo-core/tests/navigation.rs` for source selection and process lifecycle.
- Use fresh temporary repositories and separate stores with local Git identity, not the user's
  checkout, global Git config, or real app data. Keep tests independent of ordering and shared env.
- Use `crates/repo-core/tests/support/fake-lsp.mjs` for deterministic framing, cancellation,
  late replies, missing capabilities, and crashes; it is not proof of real semantic resolution.
- Cover the changed success path plus its relevant failure/race boundary: stale fingerprints,
  side/revision selection, malformed input, persistence preservation, or child cleanup. Assert
  observable results and unchanged source/index where relevant, not merely internal call counts.

## Verify proportionately and report evidence

Run from the repository root after implementation; choose checks for the changed surface.
Require Rust/Cargo, Git, and Node (the fake LSP uses Node); use the installed rustfmt/Clippy
components for those checks. Native checks also require npm dependencies and host Tauri SDKs.

```sh
cargo test -p peer-core --locked --test review          # or --test history / --test navigation
cargo test -p peer-core --locked                      # broader core regression coverage
cargo fmt --all -- --check
cargo clippy -p peer-core --all-targets --locked
npm run build                                        # frontend assets for native compilation
cargo check -p peer --locked                          # Tauri bridge and native dependencies
```

Clippy is recommended here, not an existing CI gate or a new `-D warnings` baseline policy.
Do not use `npm run format` for a scoped Rust fix: it rewrites frontend and root files too.
For native-path changes, compilation is insufficient: run `npm run desktop` with an isolated
`PEER_DATA_DIR`, or `npm run build:test-app` then `npm run test:desktop` on a supported active,
unlocked desktop. Exercise the affected command through the actual app, including its failure
case; verify refresh/restart persistence or process shutdown when relevant.
Optional semantic smoke: `cargo test -p peer-core --locked --test navigation real_language_servers -- --ignored`
requires gopls, typescript-language-server, rust-analyzer, and their toolchains. Python changes
can use the `real_python_server` filter with Python/Pyright. Consult `.github/workflows/ci.yml`
for pinned setups; do not substitute fake-server success or install global tools without approval.
Update existing docs only when behavior, setup, limits, or contracts change. Report commands
actually run, their outcomes, runtime scenarios exercised, and skipped checks with prerequisites;
never describe an unrun check or a configured CI job as observed success.
