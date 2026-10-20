---
name: typescript-programming
description: "Use this skill when writing, reviewing, debugging, or refactoring TypeScript or React in Peer, including frontend state, Tauri IPC, viewer performance, workers, and desktop tests."
---

# TypeScript programming in Peer

For `lantern24/peer`, make the smallest complete behavioral change; optimize for readable code six months later.
These are working guidelines, not claims that every existing file already follows them.
Do not turn a focused fix into a style rewrite, dependency migration, or configuration overhaul.

## Locate the behavior and its boundary

- Trace the caller, state owner, asynchronous work, visible result, and nearest behavioral test before editing.
- Start with `src/App.tsx` for repository/session state, drafts, reads, and preferences;
  `src/Viewer.tsx` adapts the virtualized `@pierre/diffs` renderer, not a second application store.
- Read `src/api.ts` and `src/types.ts` for IPC, `src/useNavigation.ts` and `src/navigation.ts`
  for source navigation/history, and `src/refresh.ts` for viewport reconciliation.
- Reuse the local helpers and component boundaries. Extract only when it removes actual duplication
  or makes a concrete behavior independently testable; do not introduce speculative frameworks.
- Keep repository inspection read-only. Native command changes also require the
  [Rust programming skill](../rust-programming/SKILL.md).

## Keep types honest and simple

- Preserve `tsconfig.json`: strict TypeScript, ES2022, Bundler resolution, React JSX.
  Do not weaken strictness, expand global types, or change build configuration to hide an error.
- Prefer inferred locals and explicit public contracts. Use small literal/discriminated unions for
  genuinely distinct states; use generics only for a real relationship between inputs and outputs.
- Avoid new `any`, unchecked `as`, double assertions, non-null assertions, and suppression comments.
  Narrow nullable values through control flow; check indexed lookups when absence is possible.
  For an unavoidable DOM/library assertion, keep it local and explain the proven invariant.
- Treat genuinely external JSON, caught errors, and untyped integration messages as `unknown`;
  narrow at the boundary. `navigationError` in `src/navigation.ts` is a small error-boundary example.
  Do not revalidate already-owned typed state at every layer or add schema libraries without need.
- Match nearby import conventions: `import type` for type-only modules and inline `type` in mixed
  imports, as in `src/api.ts` and `src/ResizableWorkspace.tsx`. Avoid unrelated import churn.
- Keep browser/WebView code free of Node-only APIs. `scripts/*.mjs`, Vite/Vitest configuration,
  and the WebdriverIO runner execute in Node; `browser.execute` callbacks execute in the WebView
  and must receive serializable arguments rather than depend on runner-local closures.

## Preserve WebKit compatibility

- Peer uses the system WKWebView on macOS; a newer development machine or Chromium preview
  does not establish support on older Macs. Read `vite.config.ts` (`safari16`) and
  `src-tauri/tauri.conf.json` (minimum macOS `13.0`) before choosing web APIs. Keep that baseline;
  do not raise it as a shortcut for a fix. See [Tauri's WebView versions](https://v2.tauri.app/reference/webview-versions/).
- Prefer APIs available at the supported baseline. Use a newer DOM, JavaScript, CSS, or worker
  feature only with verified support or a tested fallback that preserves the core workflow.
  TypeScript DOM declarations and Vite's syntax target do not polyfill runtime APIs.
- Detect capabilities at the call site instead of branching on user-agent or OS versions.
  Method existence alone does not prove that its argument signature or behavior is compatible.
  Keep compatibility adapters small, catch only the expected compatibility failure, and retain
  an absent-API fallback; optional selection/history capture must not prevent opening a file.
- Preserve `Viewer.sourceSelection` handling for modern
  `getComposedRanges({ shadowRoots })`, older WebKit's `getComposedRanges(...shadowRoots)`,
  and the absent-method `getRangeAt` fallback. Passing an options object to the legacy method
  throws before navigation can load the next file, making the UI appear frozen.
  The [WebKit report](https://bugs.webkit.org/show_bug.cgi?id=265632) documents the legacy signature.
- Retain the selection compatibility regressions in `tests/desktop/navigation.spec.ts`.
  For affected API paths, exercise current behavior and emulate legacy signatures or missing
  capabilities in the native WebView; restore globals by reloading between cases. Assert file
  selection, rendered content, Back, and navigation without a selection. Require restored text
  selection when the API exposes shadow-DOM endpoints; otherwise keep file navigation usable.
  Run on an affected/oldest supported runtime when available; describe emulation as emulation,
  since success on the latest macOS CI runner does not prove the entire older WebKit baseline.

## Change IPC as one contract

- Keep calls in `src/api.ts`; do not scatter raw `invoke` calls across new UI components.
- Update command names and argument keys with `src-tauri/src/lib.rs`; compare response/request
  types with `crates/repo-core/src/types.rs` and `crates/repo-core/src/navigation.rs`.
- Preserve Serde camelCase names, null versus omitted optional fields, literal values, and units.
  Check actual serialization attributes: Rust `Option<T>` alone does not imply a TS optional key.
- Remember `invoke<T>` is a compile-time promise, not runtime validation. Fix producer/consumer
  mismatches together, including fixtures and callers; do not cast an incompatible response away.
- Preserve snapshot IDs, request IDs, source fingerprints, and old/new sides throughout the flow;
  they prevent navigation and feedback from silently targeting another revision.

## Own state and asynchronous lifetimes

- Keep each value in one authoritative owner. Derive cheap display values during render rather
  than copy them into state with an effect; use effects for external synchronization and cleanup.
- Keep render and memo calculations free of hidden I/O, subscriptions, timers, persistence, or
  state-changing callbacks. Use event handlers for user actions and effects for owned resources.
- Update React objects, arrays, Maps, and Sets immutably. Use functional updates when the next
  value depends on prior state; reserve refs for handles, request identity, and non-rendering data.
- Preserve drafts, selected file/side/line, scroll anchors, and navigation history across intended
  refreshes. Read queue-keyed drafts in `src/App.tsx` and rename/removal mapping in `src/refresh.ts`;
  do not remount the workspace or clear all state merely to force a redraw.
- Guard asynchronous success, failure, and final loading-state updates against superseded work.
  Follow the opening counter/snapshot checks in `src/App.tsx` and generation/request checks in
  `src/useNavigation.ts`; recheck after each await before committing state or restoring focus.
- Cancel work when supported, but retain stale-completion guards: cancellation can race completion.
  Scope deduplicated reads by snapshot, file, and force mode; release pending entries on failure too.
- Pair listeners, observers, timers, animation frames, and subscriptions with teardown. Account for
  asynchronous Tauri `listen` registration resolving after cleanup, as in `src/App.tsx`.
- Keep hook dependencies truthful; use the existing latest-value ref pattern only when its lifetime
  is understood. Ensure setup/cleanup survives remounts without duplicate listeners or stale work.

## Preserve responsiveness without speculative optimization

- Measure a visible workload before adding memoization, caches, or batching. Stable viewer item
  identity matters in `src/Viewer.tsx`; selection changes should not rebuild unrelated diff models.
- Preserve file/line virtualization and deferred large-file loading. Do not fetch every source,
  render every line, or move full diff parsing into render to simplify a local change.
- Keep `src/parse-diff.ts` and `src/diff.worker.ts` request correlation and failure settlement intact.
  The parser currently releases its worker after 15 seconds idle, never during outstanding reads.
- Reuse `src/memory.ts` budgets: bound entries and estimated bytes, pin active sources deliberately,
  and release old snapshot/cache references. A pinned oversized source can exceed the cache budget.
- Preserve `retainFile` in `src/loaded-file.ts`: parsed diff models already retain source lines;
  do not also retain original multi-megabyte strings just for convenience.
- Distinguish estimated retained-data budgets from total WebView memory. Use native measurements
  for performance claims; unit cache tests do not establish process memory or frame-time bounds.

## Keep controls accessible and content inert

- Use semantic buttons, inputs, dialogs, and labels; make icon-only actions discoverable by name.
  Follow `src/RepositorySwitcher.tsx` for menu keyboard/focus behavior, `src/Modal.tsx` for native
  dialog lifecycle, and `src/ResizableWorkspace.tsx` for keyboard-operable labeled separators.
- Preserve Escape/cancel, arrow-key behavior, visible focus, and focus return after closing overlays.
  Do not let global shortcuts consume typing or open-dialog input; inspect `isTyping` in `src/navigation.ts`.
- Render repository paths, source text, and review bodies as text, as `src/Feedback.tsx` does.
  Never inject untrusted code/reviews through `innerHTML` or `dangerouslySetInnerHTML`; do not turn
  displayed paths or review links into executable commands or unvalidated external navigation.

## Test the consumer behavior, then report evidence

- Update affected contract tests and retain a bug regression when practical. Add new deterministic
  Vitest cases for uncertain edges or explicit requirements, not forwarding or copied defaults.
  Follow `src/refresh.test.ts`
  for rename/removal and selection behavior, `src/memory.test.ts` for eviction/pinning, and
  `src/parse-diff.test.ts` for out-of-order completions, worker failure, and idle cleanup.
- Use controllable promises/fake timers for races; restore timers, globals, and module state.
  Assert user-relevant results and retained invariants, not private implementation snapshots.
- `vitest.config.ts` uses Node and includes `src/**/*.test.ts` and `tests/desktop/*.test.ts`.
  These tests do not replace React/WebView, native IPC, layout, keyboard, or focus smoke coverage.
- Exercise the relevant native scenario in `tests/desktop/{review,sidebars,navigation,repositories,history}.spec.ts`
  for UI changes; update coverage for changed contracts or uncertain edges. Use disposable fixtures,
  isolate preferences/drafts, and wait for observable state instead of sleeps; assert expected
  source is visible, not merely that a click resolved.
- Select checks for the actual change; these examples are commands to run, not recorded results:

```sh
npm test -- src/refresh.test.ts src/parse-diff.test.ts
npm test
npm run build
# Check only files actually changed; replace this example list.
npm exec --no -- prettier --check src/refresh.ts src/refresh.test.ts
# Native smoke: build the feature-gated test app, then select the relevant scenario.
npm run build:test-app
npm run test:desktop -- --spec tests/desktop/sidebars.spec.ts
```

- `npm run build` runs `tsc -b && vite build`, but the TS project includes only `src` and
  `vite.config.ts`, not desktop runner/spec files or all configuration/scripts. Vitest execution
  is not full typechecking of those files; exercise their actual runtime and report this scope.
- Native tests require Rust/Tauri platform prerequisites and an active unlocked desktop; consult
  `AGENTS.md` and `tests/desktop/wdio.conf.ts`. Use `npm run desktop` for manual real-app smoke;
  Vite-only preview cannot prove native IPC behavior. For IPC/core changes also run `npm run test:core`.
- Do not use broad `npm run format` for a focused patch or invent `lint`/`lint:fix` scripts.
  Do not install new lint, schema, or state-management dependencies to satisfy these guidelines.
- Update existing docs when user-visible behavior, contracts, setup, or measured limits change.
  Report exact checks and outcomes actually observed, native/manual coverage, and any blocked
  prerequisite; never present configured CI, an unrun command, or mocked IPC as verified behavior.
