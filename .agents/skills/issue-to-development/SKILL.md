---
name: issue-to-development
description: "Fetch a lantern24/peer GitHub issue, create an issue-numbered development branch, and implement and verify the change. Use when asked to pick up or start work on an issue."
---

# Issue → Development (Peer)

Use when: the user asks to pick up or start work on a `lantern24/peer` issue (for example, "work on issue 745" or "start issue #745").

## Summary

Fetch the issue title, body, and comments; create an issue-numbered branch from `main`; implement and verify the change; and commit through the local [`commit`](../commit/SKILL.md) skill. Do not create a pull request automatically.

## Repository context

- Repository: `lantern24/peer`.
- `src/`: React and TypeScript frontend, built with Vite; frontend tests use Vitest.
- `crates/repo-core/`: independent Rust core (`peer-core`) for Git, snapshots, reviews, preferences, themes, and code navigation.
- `src-tauri/`: Tauri 2 desktop application, native integrations, and command bridge.
- `tests/desktop/`: WebdriverIO tests that launch the actual Tauri application.
- Peer is a local, read-only repository viewer. Preserve its invariant that the application never edits, stages, commits, fetches, or applies changes to viewed repositories. This does not prohibit Git operations on Peer's own development checkout.
- Consult `AGENTS.md`, `docs/VALIDATION.md`, `package.json`, and `.github/workflows/ci.yml` for current setup and verification requirements. Development requires Node.js 22+, Rust 1.88+, Git, and the platform's Tauri prerequisites.

## Commands (examples)

Fetch the issue, including discussion:

```bash
gh issue view --repo lantern24/peer {issue_number} --json number,title,body,comments,url,state
```

Inspect the checkout before switching branches:

```bash
git status --short
git branch --show-current
```

Switch to and update `main` only after handling the branch and worktree safeguards below:

```bash
git checkout main && git pull --ff-only
```

Create the issue branch, replacing the type and number with actual values:

```bash
git checkout -b fix-issue-{issue_number}
```

## Workflow

1. Extract the issue number from the request or issue URL. Ask which `lantern24/peer` issue to work on only when it cannot be determined from context. If asked to choose an issue, list open issues with `gh issue list --repo lantern24/peer` and identify a suitable candidate before starting.
2. Fetch the issue title, body, and all comments. Summarize the intended behavior and acceptance criteria. A request to implement the issue is authorization to proceed; ask only about unresolved requirements or materially different designs.
3. Inspect the current branch and worktree. Preserve unrelated changes; never automatically stash, discard, or reset them. If switching branches would move unrelated work, ask how the user wants it handled.
4. If not on `main`, ask before switching away from the current branch. Once it is safe and agreed, switch to `main` and pull with `--ff-only`. If already on `main` and the worktree is clean, pull with `--ff-only`. Do not force through a divergent branch or a failed pull.
5. Create and switch to `<type>-issue-{issue_number}`, selecting the type from the actual change. Create the branch without another confirmation. If the name exists, append a short unique suffix such as `-1` or `-2`; never overwrite an existing branch. If the user explicitly requests resuming an existing issue branch, use that branch instead of creating another.
6. Read the affected code and existing conventions before editing. Reproduce a bug before fixing it when practical; treat user-provided failure evidence as established. Implement the complete issue without unrelated refactors.
7. Run the applicable checks below and exercise the changed behavior. Fix failures caused by the change; report unrelated failures or unavailable prerequisites precisely. Do not represent partial or unverified work as complete.
8. Update existing user-facing documentation or the validation record when behavior or verified results change. Do not claim tests or platforms that were not exercised.
9. When ready to save progress, use the local `commit` skill rather than inventing a separate commit convention. For example, `fix(issue-745): Preserve selected file on refresh`, with a `Refs: #745` footer or `Fixes #745` when the change resolves the issue. Stage only the intended changes.
10. Stop after committing and report the change, verification, and any limitations. Creating a PR is a separate action; use `gh pr create --repo lantern24/peer` only when requested. No separate `create-pr` skill is installed in this repository.

## Testing and verification

Run commands from the repository root. Choose checks by the affected surface; there is no `npm run lint` or `lint:fix` script.

```bash
# Frontend tests and TypeScript/production build
npm test
npm run build

# Rust core tests
cargo test -p peer-core --locked

# Tauri bridge/native compilation, with platform prerequisites installed
cargo check --manifest-path src-tauri/Cargo.toml --locked

# Rust formatting check when Rust files change
cargo fmt --all -- --check

# Native desktop integration, after installing development dependencies
npm run build:test-app
npm run test:desktop
```

- For a focused frontend test, use `npm test -- src/refresh.test.ts` or the relevant existing test path.
- For a focused native scenario, use `npm run test:desktop -- --spec tests/desktop/repositories.spec.ts --mochaOpts.grep "updates a moved repository"`, replacing the path and scenario with the affected one.
- UI changes require observing the actual affected surface. Launch with `npm run desktop`; native desktop tests require an active, unlocked desktop. Browser-only checks cannot establish native menu, dialog, clipboard, or Tauri behavior.
- Code-navigation changes may require the opt-in real-language-server tests documented in `AGENTS.md` and `.github/workflows/ci.yml`; install their server prerequisites from `README.md` before running them.
- Do not run repository-wide write-formatting commands on unrelated files. Keep formatting limited to the files being changed.

## Decision points and edge cases

- This skill is scoped to `lantern24/peer`. If the requested issue belongs to another repository, clarify the intended checkout before editing; a cross-repository link inside an issue does not itself change the target repository.
- If `gh` is missing, report that it must be installed. If authentication or permissions fail, report the actual error and request the missing access (`gh auth login` when unauthenticated).
- If tests or runtime prerequisites are unavailable, finish the reachable work and state exactly what remains unverified. Do not silently skip checks, commit partial work as complete, or push/create a PR automatically.

## Example user prompts

- "Start work on issue 745"
- "Please fetch lantern24/peer#745 and create an issue branch"
- "Pick an open Peer issue and implement it"
