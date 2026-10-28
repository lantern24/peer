import { browser, $, $$, expect } from "@wdio/globals";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { reloadApp } from "./app-fixture";

const root = realpathSync(mkdtempSync(join(tmpdir(), "peer-history-ui-")));
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: root, stdio: "pipe" }).toString().trim();
const trigger = '[aria-label="Show branch commits"]';
const panel = '[role="dialog"][aria-label="Commit history"]';
let originalPreferences: any;
let initial: string;
let selected: string;
let latest: string;
async function key(key: string) {
  await browser.execute(
    (key) =>
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
      ),
    key,
  );
}
async function selectCommit(id: string) {
  await $(trigger).click();
  await $(".commit-history-item").waitForExist();
  if (!(await $(`[data-commit-id="${id}"]`).isExisting())) {
    await $("button=Load older commits").click();
  }
  await $(`[data-commit-id="${id}"]`).click();
  await browser.waitUntil(
    async () =>
      (await $(".commit-summary > code").getAttribute("title")) === id &&
      (await $(trigger).isEnabled()),
  );
}
async function source() {
  return browser.execute(() =>
    Array.from(document.querySelectorAll("diffs-container"))
      .flatMap((host) =>
        Array.from(
          host.shadowRoot?.querySelectorAll("[data-code]") ?? [],
          (column) => column.textContent ?? "",
        ),
      )
      .join("\n"),
  );
}

describe("Branch commit history", () => {
  before(async () => {
    git("init", "-b", "main");
    git("config", "user.name", "History Test");
    git("config", "user.email", "history@example.invalid");
    writeFileSync(join(root, "value.ts"), "export const value = 1;\n");
    git("add", ".");
    git("commit", "-m", "Initial value");
    initial = git("rev-parse", "HEAD");
    writeFileSync(join(root, "value.ts"), "export const value = 2;\n");
    git("commit", "-am", "Change the value");
    selected = git("rev-parse", "HEAD");
    writeFileSync(join(root, "value.ts"), "export const value = 3;\n");
    git("commit", "-am", "Later value");
    for (let i = 0; i < 49; i++)
      git("commit", "--allow-empty", "-m", `History marker ${i}`);
    latest = git("rev-parse", "HEAD");
    writeFileSync(join(root, "value.ts"), "export const localOnly = 999;\n");
    originalPreferences = await browser.execute(
      async () =>
        (await (window as any).__TAURI__.core.invoke("bootstrap")).preferences,
    );
  });
  beforeEach(async () => {
    await browser.execute(async () =>
      (window as any).__TAURI__.window.getCurrentWindow().setFocus(),
    );
    await reloadApp({
      ...originalPreferences,
      diffLayout: "split",
      lastRepository: root,
      sessions: {},
      recentRepositories: [root],
    });
    await browser.waitUntil(
      async () =>
        (await $('[aria-label="Switch repository"]').getAttribute("title")) ===
          root && (await $(trigger).isEnabled()),
    );
    await browser.waitUntil(async () =>
      (await source()).includes("localOnly = 999"),
    );
  });
  after(async () => {
    await reloadApp(originalPreferences);
  });

  it("opens a paginated branch history with keyboard navigation and dismissal", async () => {
    await $(trigger).click();
    await $(".commit-history-item").waitForExist();
    await expect($$(".commit-history-item")).toBeElementsArrayOfSize(50);
    await expect($(".commit-history-item")).toHaveText(
      expect.stringContaining("History marker 48"),
    );
    await key("ArrowDown");
    await expect($(`[data-commit-id="${latest}"]`)).toBeFocused();
    await key("End");
    await expect($$(".commit-history-item")[49]).toBeFocused();
    await key("Escape");
    await expect($(panel)).not.toExist();
    await expect($(trigger)).toBeFocused();
    await $(trigger).click();
    await $("button=Load older commits").click();
    await expect($$(".commit-history-item")).toBeElementsArrayOfSize(52);
    await expect($(`[data-commit-id="${initial}"]`)).toHaveText(
      expect.stringContaining("Initial value"),
    );
    await browser.saveScreenshot(resolve("test-results/commit-history.png"));
    await $(".statusbar").click();
    await expect($(panel)).not.toExist();
  });

  it("renders the selected commit's actual diff and isolates its review comments", async () => {
    await selectCommit(selected);
    await expect($(".view-switch button.active")).toHaveText("Changes");
    await expect($('[aria-label="Comparison mode"]')).toHaveValue("commit");
    await expect($(".commit-summary")).toHaveText(
      expect.stringContaining("Change the value"),
    );
    await expect($(".untracked-toggle")).not.toExist();
    await browser.waitUntil(
      async () =>
        (await source()).includes("value = 1") &&
        (await source()).includes("value = 2"),
    );
    expect(await source()).not.toContain("localOnly");
    expect(await source()).not.toContain("value = 3");
    await $('[aria-label="Comment on file value.ts"]').click();
    await $('[aria-label="Comment text"]').setValue("Review only this commit");
    await $("button=Add comment").click();
    await expect($(".comment-card")).toHaveText(
      expect.stringContaining("Review only this commit"),
    );
    await browser.saveScreenshot(resolve("test-results/commit-diff.png"));
    await selectCommit(initial);
    await expect($(".commit-summary")).toHaveText(
      expect.stringContaining("Initial commit"),
    );
    await expect($(".comment-card")).not.toExist();
    await selectCommit(selected);
    await expect($(".comment-card")).toHaveText(
      expect.stringContaining("Review only this commit"),
    );
    await $(trigger).click();
    await $("button=Load older commits").click();
    await expect($(`[data-commit-id="${selected}"]`)).toHaveAttribute(
      "aria-current",
      "true",
    );
    await key("Escape");
  });

  it("restores a selected commit after reload and returns to local changes", async () => {
    await selectCommit(selected);
    await browser.waitUntil(async () =>
      browser.execute(async (selected) => {
        const { preferences } = await (window as any).__TAURI__.core.invoke(
          "bootstrap",
        );
        return (
          preferences.sessions[preferences.lastRepository]?.comparison
            .baseRef === selected
        );
      }, selected),
    );
    await reloadApp();
    await browser.waitUntil(
      async () =>
        (await $(".commit-summary > code").getAttribute("title")) ===
          selected && (await $(trigger).isEnabled()),
    );
    await selectCommit(latest);
    await expect($(".statusbar")).toHaveText(
      expect.stringContaining("0 files"),
    );
    await expect($(".commit-summary")).toHaveText(
      expect.stringContaining("History marker 48"),
    );
    // The embedded WebKit driver does not operate native select popups.
    await browser.execute(() => {
      const select = document.querySelector<HTMLSelectElement>(
        '[aria-label="Comparison mode"]',
      )!;
      select.value = "all";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await expect($(".commit-summary")).not.toExist();
    await browser.waitUntil(async () =>
      (await source()).includes("localOnly = 999"),
    );
    await expect($(".comment-card")).not.toExist();
    expect(git("rev-parse", "HEAD")).toBe(latest);
    expect(git("symbolic-ref", "--short", "HEAD")).toBe("main");
  });
});
