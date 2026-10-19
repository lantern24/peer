import { browser, $, expect } from "@wdio/globals";
import type * as Tauri from "@tauri-apps/api";
import type { Preferences, RepositoryWatchStatus } from "../../src/types";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { reloadApp } from "./app-fixture";

type NativeWindow = Window & {
  __TAURI__: typeof Tauri;
  __TAURI_INTERNALS__: { convertFileSrc: typeof Tauri.core.convertFileSrc };
  __watchGate?: { waiting: boolean; release?: () => void; restore: () => void };
};

const notice = "[data-repository-watch]";
const refreshButton = '[aria-label="Refresh repository"]';
const changedRefresh = '[aria-label="Refresh changed repository"]';
const file = "review.txt";
let original: Preferences;
let workspace: string;
let repo: string;

function git(root: string, ...args: string[]) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}
function source(label: string) {
  return Array.from(
    { length: 160 },
    (_, i) => `${i % 2 ? label : "Context"} line ${i + 1}\n`,
  ).join("");
}
function createRepository(root: string) {
  mkdirSync(root, { recursive: true });
  git(root, "init", "-b", "main");
  git(root, "config", "user.name", "Peer Watch Test");
  git(root, "config", "user.email", "watch@example.invalid");
  writeFileSync(join(root, file), source("Before"));
  writeFileSync(join(root, "unchanged.txt"), "Unchanged source\n");
  writeFileSync(join(root, ".gitignore"), "build/\nignored-tracked.txt\n");
  writeFileSync(
    join(root, "ignored-tracked.txt"),
    "Tracked despite ignore rule\n",
  );
  git(root, "add", ".");
  git(root, "add", "--force", "ignored-tracked.txt");
  git(root, "commit", "-m", "Baseline");
  writeFileSync(join(root, file), source("Current"));
}
async function openRepository(root: string, recent = [root]) {
  await reloadApp({
    ...original,
    lastRepository: root,
    recentRepositories: recent,
    sessions: {},
    diffLayout: "unified",
  });
  await expect($('[aria-label="Switch repository"]')).toHaveAttribute(
    "title",
    root,
  );
  await $(refreshButton).waitForEnabled();
}
async function clickInPlace(selector: string) {
  await $(selector).waitForEnabled();
  await browser.execute((selector) => {
    const element = document.querySelector<HTMLElement>(selector);
    if (!element) throw new Error(`Missing control: ${selector}`);
    element.click();
  }, selector);
}
async function renderedSource() {
  return browser.execute((file) => {
    const host = document
      .querySelector(`[data-file-path="${file}"]`)
      ?.closest("diffs-container");
    return host?.shadowRoot?.querySelector("[data-code]")?.textContent ?? "";
  }, file);
}
async function readySource(label: string) {
  await $(`.tree-file[title="${file}"]`).click();
  await browser.waitUntil(async () => (await renderedSource()).includes(label));
}
async function refresh() {
  await clickInPlace(refreshButton);
  await $(refreshButton).waitForEnabled();
  await $(".refresh-overlay").waitForExist({ reverse: true });
}
async function focusProbe(): Promise<RepositoryWatchStatus> {
  // Await a real native probe acknowledgement, rather than sleeping and assuming
  // absence of a notice proves ignored changes were processed.
  const result = await browser.execute(async () => {
    const native = window as unknown as NativeWindow;
    // The embedded driver reserves a top-level `error` key for script failure.
    return new Promise<{ status: RepositoryWatchStatus }>((resolve, reject) => {
      let unlisten: (() => void) | undefined;
      const timer = setTimeout(() => {
        unlisten?.();
        reject(new Error("Focus probe did not emit a repository status"));
      }, 15000);
      void native.__TAURI__.event
        .listen<RepositoryWatchStatus>("repository-changed", ({ payload }) => {
          clearTimeout(timer);
          unlisten?.();
          resolve({ status: payload });
        })
        .then((stop) => {
          unlisten = stop;
          window.dispatchEvent(new Event("focus"));
        }, reject);
    });
  });
  return result.status;
}
async function submitComment(body: string) {
  await clickInPlace(`[aria-label="Comment on file ${file}"]`);
  await $('[aria-label="Comment text"]').setValue(body);
  await browser.execute(() => {
    const form = document.querySelector<HTMLFormElement>(".comment-composer");
    const submit = form?.querySelector<HTMLButtonElement>(".primary-button");
    if (!form || !submit) throw new Error("Comment form is unavailable");
    form.requestSubmit(submit);
  });
  await expect($(".comment-card p")).toHaveText(body);
}

describe("Repository change notifications", () => {
  before(async () => {
    await $(refreshButton).waitForEnabled();
    original = await browser.execute(async () => {
      const native = window as unknown as NativeWindow;
      return (
        await native.__TAURI__.core.invoke<{ preferences: Preferences }>(
          "bootstrap",
        )
      ).preferences;
    });
  });
  beforeEach(async () => {
    workspace = realpathSync(mkdtempSync(join(tmpdir(), "peer-watch-")));
    repo = join(workspace, "review-repo");
    createRepository(repo);
    await openRepository(repo);
    await readySource("Current line");
    expect((await focusProbe()).changed).toBe(false);
  });
  afterEach(async () => {
    await browser.execute(() =>
      (window as unknown as NativeWindow).__watchGate?.restore(),
    );
    await reloadApp(original);
    rmSync(workspace, { recursive: true, force: true });
  });

  it("notifies about atomic saves without changing an active review or draft", async () => {
    await submitComment("Saved against the original review");
    const reviewed = `[data-file-path="${file}"] .review-check input`;
    await clickInPlace(reviewed);
    await expect($(reviewed)).toBeSelected();
    await clickInPlace(`[aria-label="Comment on file ${file}"]`);
    await $('[aria-label="Comment text"]').setValue(
      "Unfinished review stays here",
    );
    await browser.execute(async () => {
      const native = window as unknown as NativeWindow;
      await native.__TAURI__.window.getCurrentWindow().setFocus();
      const view = document.querySelector<HTMLElement>(".code-view");
      const draft = document.querySelector<HTMLTextAreaElement>(
        '[aria-label="Comment text"]',
      );
      if (!view || !draft) throw new Error("Review surface is not ready");
      view.scrollTop = 250;
      view.dispatchEvent(new Event("scroll"));
      draft.focus({ preventScroll: true });
    });
    const before = await browser.execute(() => {
      const view = document.querySelector<HTMLElement>(".code-view");
      return {
        top: view?.scrollTop,
        height: view?.clientHeight,
        selected: document
          .querySelector('.tree-file[aria-current="true"]')
          ?.getAttribute("title"),
      };
    });
    const queuesBefore = JSON.parse(
      readFileSync(join(process.env.PEER_DATA_DIR!, "state.json"), "utf8"),
    ).queues;
    const originalIndex = readFileSync(join(repo, ".git", "index"));
    for (let i = 0; i < 6; i++) {
      writeFileSync(join(repo, ".review-save"), source(`External ${i}`));
      renameSync(join(repo, ".review-save"), join(repo, file));
    }
    await $(notice).waitForExist();
    await expect($(notice)).toHaveText(
      expect.stringContaining("Repository changed on disk"),
    );
    await expect($('[aria-label="Comment text"]')).toHaveValue(
      "Unfinished review stays here",
    );
    await expect($('[aria-label="Comment text"]')).toBeFocused();
    expect(await renderedSource()).toContain("Current line");
    expect(await renderedSource()).not.toContain("External");
    await expect($(".statusbar")).toHaveText(
      expect.stringContaining("1 reviewed"),
    );
    await expect($(".outdated-tag")).not.toExist();
    const after = await browser.execute(() => {
      const view = document.querySelector<HTMLElement>(".code-view");
      return {
        top: view?.scrollTop,
        height: view?.clientHeight,
        selected: document
          .querySelector('.tree-file[aria-current="true"]')
          ?.getAttribute("title"),
      };
    });
    expect(after).toEqual(before);
    expect(
      JSON.parse(
        readFileSync(join(process.env.PEER_DATA_DIR!, "state.json"), "utf8"),
      ).queues,
    ).toEqual(queuesBefore);
    expect(readFileSync(join(repo, ".git", "index"))).toEqual(originalIndex);
    await browser.saveScreenshot(
      resolve("test-results/repository-change-notice.png"),
    );
    await clickInPlace(changedRefresh);
    await $(refreshButton).waitForEnabled();
    await browser.waitUntil(async () =>
      (await renderedSource()).includes("External 5"),
    );
    await $(".outdated-tag").waitForExist();
    await expect($(".statusbar")).toHaveText(
      expect.stringContaining("0 reviewed"),
    );
    await expect($('[aria-label="Comment text"]')).toHaveValue(
      "Unfinished review stays here",
    );
    expect((await focusProbe()).changed).toBe(false);
    await expect($(notice)).not.toExist();
  });

  it("ignores generated output but detects tracked ignored files and new inventory", async () => {
    mkdirSync(join(repo, "build"));
    writeFileSync(join(repo, "build", "output.js"), "generated output\n");
    expect((await focusProbe()).changed).toBe(false);
    await expect($(notice)).not.toExist();
    appendFileSync(
      join(repo, "ignored-tracked.txt"),
      "External tracked change\n",
    );
    await $(notice).waitForExist();
    await refresh();
    expect((await focusProbe()).changed).toBe(false);
    writeFileSync(join(repo, "added.txt"), "Added after opening\n");
    await $(notice).waitForExist();
    await expect($('.tree-file[title="added.txt"]')).not.toExist();
    await refresh();
    await $('.tree-file[title="added.txt"]').waitForExist();
    renameSync(join(repo, "added.txt"), join(repo, "renamed.txt"));
    await $(notice).waitForExist();
    await refresh();
    await $('.tree-file[title="renamed.txt"]').waitForExist();
    await expect($('.tree-file[title="added.txt"]')).not.toExist();
    rmSync(join(repo, "renamed.txt"));
    await $(notice).waitForExist();
    await refresh();
    await expect($('.tree-file[title="renamed.txt"]')).not.toExist();
  });

  it("detects staging and linked-worktree changes without watching inactive repositories", async () => {
    git(repo, "add", file);
    await $(notice).waitForExist();
    await refresh();
    expect((await focusProbe()).changed).toBe(false);
    const linked = join(workspace, "linked-review");
    git(repo, "worktree", "add", "-b", "linked", linked);
    writeFileSync(join(linked, file), source("Linked current"));
    await openRepository(linked, [linked, repo]);
    await readySource("Linked current");
    expect((await focusProbe()).changed).toBe(false);
    appendFileSync(join(repo, file), "Inactive repository change\n");
    expect((await focusProbe()).changed).toBe(false);
    await expect($(notice)).not.toExist();
    writeFileSync(join(linked, file), source("Linked external"));
    await $(notice).waitForExist();
    expect(await renderedSource()).toContain("Linked current");
    await refresh();
    await browser.waitUntil(async () =>
      (await renderedSource()).includes("Linked external"),
    );
    git(linked, "add", file);
    await $(notice).waitForExist();
  });

  it("keeps immutable commit reviews unchanged and resumes monitoring in Code", async () => {
    const commit = git(repo, "rev-parse", "HEAD");
    await $('[aria-label="Show branch commits"]').click();
    await $(`[data-commit-id="${commit}"]`).click();
    await expect($(".commit-summary > code")).toHaveAttribute("title", commit);
    await $(refreshButton).waitForEnabled();
    await readySource("Before line");
    writeFileSync(join(repo, file), source("Live working changes"));
    git(repo, "add", file);
    await submitComment("Comment still belongs to the immutable commit");
    expect(await renderedSource()).toContain("Before line");
    expect(await renderedSource()).not.toContain("Live working changes");
    await expect($(notice)).not.toExist();
    await $("button=Code").click();
    await $(refreshButton).waitForEnabled();
    await readySource("Live working changes");
    expect((await focusProbe()).changed).toBe(false);
    writeFileSync(join(repo, file), source("Changed again in Code"));
    await $(notice).waitForExist();
    expect(await renderedSource()).toContain("Live working changes");
    await refresh();
    await browser.waitUntil(async () =>
      (await renderedSource()).includes("Changed again in Code"),
    );
  });

  it("detects edits between refresh completion and watcher activation", async () => {
    writeFileSync(join(repo, file), source("Before explicit refresh"));
    await $(notice).waitForExist();
    await browser.execute(() => {
      const native = window as unknown as NativeWindow;
      const originalFetch = window.fetch;
      const url = native.__TAURI_INTERNALS__.convertFileSrc(
        "start_repository_watch",
        "ipc",
      );
      const gate = {
        waiting: false,
        release: undefined as (() => void) | undefined,
        restore: () => {
          window.fetch = originalFetch;
          gate.release?.();
          delete native.__watchGate;
        },
      };
      native.__watchGate = gate;
      // Delay transport only; the released request reaches the real watcher.
      window.fetch = (input, init) => {
        const target = input instanceof Request ? input.url : String(input);
        if (target !== url || gate.waiting) return originalFetch(input, init);
        gate.waiting = true;
        return new Promise<Response>((resolve) => {
          gate.release = () => {
            window.fetch = originalFetch;
            gate.release = undefined;
            resolve(originalFetch(input, init));
          };
        });
      };
    });
    await refresh();
    await browser.waitUntil(() =>
      browser.execute(
        () => (window as unknown as NativeWindow).__watchGate?.waiting === true,
      ),
    );
    await browser.waitUntil(async () =>
      (await renderedSource()).includes("Before explicit refresh"),
    );
    writeFileSync(join(repo, file), source("Changed before watcher attached"));
    await browser.execute(() =>
      (window as unknown as NativeWindow).__watchGate?.release?.(),
    );
    await $(notice).waitForExist();
    expect(await renderedSource()).toContain("Before explicit refresh");
    await refresh();
    await browser.waitUntil(async () =>
      (await renderedSource()).includes("Changed before watcher attached"),
    );
    expect((await focusProbe()).changed).toBe(false);
    await expect($(notice)).not.toExist();
  });

  it("keeps the notice after failed refresh and reports unavailable monitoring", async () => {
    appendFileSync(join(repo, file), "External change\n");
    await $(notice).waitForExist();
    const metadata = join(workspace, "saved-git-directory");
    renameSync(join(repo, ".git"), metadata);
    try {
      const status = await focusProbe();
      expect(status.error).not.toBeNull();
      await expect($(notice)).toHaveText(
        expect.stringContaining("Automatic change detection unavailable"),
      );
      await refresh();
      await $(".error-banner").waitForExist();
      await expect($(notice)).toExist();
      expect(await renderedSource()).toContain("Current line");
    } finally {
      renameSync(metadata, join(repo, ".git"));
    }
    await refresh();
    expect((await focusProbe()).changed).toBe(false);
    await expect($(notice)).not.toExist();
  });
});
