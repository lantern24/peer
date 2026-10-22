import { browser, $, $$, expect } from "@wdio/globals";
import {
  existsSync,
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
import { execFileSync } from "node:child_process";
import { defaultComparison } from "../../src/types";
import type { Preferences } from "../../src/types";
import type * as TauriCore from "@tauri-apps/api/core";
import type * as TauriWindow from "@tauri-apps/api/window";
import { reloadApp } from "./app-fixture";

// withGlobalTauri exposes these native APIs inside each executed webview callback.
type NativeWindow = Window & {
  __TAURI__: { core: typeof TauriCore; window: typeof TauriWindow };
  __TAURI_INTERNALS__: { convertFileSrc: typeof TauriCore.convertFileSrc };
  __openGate?: { waiting: boolean; release?: () => void; restore: () => void };
};

const workspace = realpathSync(
  mkdtempSync(join(tmpdir(), "peer-repositories-")),
);
let first: string;
let second: string;
let missing: string;
const trigger = '[aria-label="Switch repository"]';
const menu = '[role="menu"][aria-label="Repositories"]';
let originalPreferences: Preferences;

async function savedPreferences(): Promise<Preferences> {
  return browser.execute(async () => {
    const nativeWindow = window as unknown as NativeWindow;
    return (
      await nativeWindow.__TAURI__.core.invoke<{ preferences: Preferences }>(
        "bootstrap",
      )
    ).preferences;
  });
}

async function switchView(view: "Code" | "Changes") {
  await $('[aria-label="Refresh repository"]').waitForEnabled();
  await $(`button=${view}`).click();
  await browser.waitUntil(
    async () =>
      (await $(".view-switch button.active").getText()) === view &&
      (await $('[aria-label="Refresh repository"]').isEnabled()) &&
      !(await $(".refresh-overlay").isExisting()),
  );
}

async function submitForm(selector: string) {
  await $(`${selector} .primary-button`).waitForEnabled();
  // The embedded driver's synthetic click may omit a submit button's default
  // action after reload. Submit the actual form, retaining its React handler.
  await browser.execute((selector) => {
    const form = document.querySelector<HTMLFormElement>(selector)!;
    form.requestSubmit(
      form.querySelector<HTMLButtonElement>(".primary-button")!,
    );
  }, selector);
}

const reviewBody = "Review survives repository lifecycle changes";

async function seedReviewAndSession() {
  await switchView("Changes");
  await $('[aria-label="Comment on file first.ts"]').click();
  await $('[aria-label="Comment text"]').setValue(reviewBody);
  await submitForm(".comment-composer");
  await expect($(".comment-card")).toHaveText(
    expect.stringContaining(reviewBody),
  );
  await $('[data-file-path="first.ts"] .review-check input').click();
  await expect($(".statusbar")).toHaveText(
    expect.stringContaining("1 reviewed"),
  );
  await switchView("Code");
  await $('.tree-file[title="second.ts"]').click();
  await $('[data-file-path="second.ts"]').waitForExist();
  const top = await browser.execute(() => {
    const view = document.querySelector<HTMLElement>(".code-view")!;
    view.scrollTop = 900;
    view.dispatchEvent(new Event("scroll"));
    return view.scrollTop;
  });
  expect(top).toBeGreaterThan(0);
  await browser.waitUntil(async () => {
    const session = (await savedPreferences()).sessions[first];
    return (
      session?.comparison.view === "code" &&
      session.selectedPath === "second.ts" &&
      Math.abs(session.scrollTop - top) < 3
    );
  });
  return top;
}

async function expectSession(top: number) {
  await expect($(".view-switch button.active")).toHaveText("Code");
  await expect($('.tree-file[title="second.ts"]')).toHaveAttribute(
    "aria-current",
    "true",
  );
  await browser.waitUntil(
    async () =>
      Math.abs(
        (await browser.execute(
          () => document.querySelector(".code-view")!.scrollTop,
        )) - top,
      ) < 3,
  );
}

async function expectReview() {
  await switchView("Changes");
  await expect($(".comment-card")).toHaveText(
    expect.stringContaining(reviewBody),
  );
  await expect(
    $('[data-file-path="first.ts"] .review-check input'),
  ).toBeChecked();
  await expect($(".statusbar")).toHaveText(
    expect.stringContaining("1 reviewed"),
  );
}

async function updateLocation(path: string) {
  await $(trigger).click();
  await $(`[aria-label="Update location for ${path}"]`).click();
  await $("#repository-location").waitForEnabled();
}

async function removeFromList(path: string) {
  await $(trigger).click();
  await $(`[aria-label="Remove ${path} from list"]`).click();
  await browser.waitUntil(
    async () => !(await savedPreferences()).recentRepositories.includes(path),
  );
}

async function reopenRemoved(path: string) {
  // OS directory pickers are outside this driver's DOM. Bootstrap the chosen
  // path so the app reopens it through the real native command.
  await reloadApp({ ...(await savedPreferences()), lastRepository: path });
  await waitForRepository(path);
}

function expectRepositoryFiles(path: string) {
  expect(existsSync(join(path, ".git"))).toBe(true);
  expect(readFileSync(join(path, "first.ts"), "utf8")).toBe(
    "export const changed = true;\n",
  );
  expect(readFileSync(join(path, "second.ts"), "utf8")).toContain(
    "export const second159 = 159;",
  );
}

async function waitForRepository(path: string) {
  await expect($(trigger)).toHaveAttribute("title", path, { wait: 20000 });
  await $(trigger).waitForEnabled();
}
async function switchTo(path: string) {
  await $(trigger).click();
  await $(`[data-repository-path="${path}"]`).click();
  await waitForRepository(path);
}
async function menuKey(key: string) {
  await browser.execute((key) => {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, key);
}
describe("Repository switcher", () => {
  before(async () => {
    await $('[aria-label="Refresh repository"]').waitForEnabled();
    originalPreferences = await savedPreferences();
  });
  beforeEach(async () => {
    const scenario = mkdtempSync(join(workspace, "scenario-"));
    first = join(scenario, "first", "shared");
    second = join(scenario, "second", "shared");
    missing = join(scenario, "missing");
    for (const root of [first, second]) {
      mkdirSync(root, { recursive: true });
      const git = (...args: string[]) =>
        execFileSync("git", args, { cwd: root, stdio: "pipe" });
      git("init", "-b", "main");
      git("config", "user.name", "Test");
      git("config", "user.email", "test@example.invalid");
      for (const name of ["first", "second"])
        writeFileSync(
          join(root, `${name}.ts`),
          Array.from(
            { length: 160 },
            (_, i) => `export const ${name}${i} = ${i};\n`,
          ).join(""),
        );
      git("add", ".");
      git("commit", "-m", "base");
      writeFileSync(join(root, "first.ts"), "export const changed = true;\n");
    }
    await reloadApp({
      ...originalPreferences,
      lastRepository: first,
      recentRepositories: [first, second, missing],
      sessions: {
        [first]: {
          comparison: { ...defaultComparison, view: "code" },
          selectedPath: "first.ts",
          scrollTop: 0,
        },
      },
    });
    await waitForRepository(first);
    await browser.execute(async () => {
      const nativeWindow = window as unknown as NativeWindow;
      await nativeWindow.__TAURI__.window.getCurrentWindow().setFocus();
    });
  });
  after(async () => {
    await reloadApp(originalPreferences);
    if (originalPreferences.lastRepository)
      await waitForRepository(originalPreferences.lastRepository);
    else await $(".welcome-open").waitForEnabled();
    rmSync(workspace, { recursive: true, force: true });
  });

  it("distinguishes matching names and supports keyboard navigation and dismissal", async () => {
    await $(trigger).click();
    await expect($(`${menu} [aria-checked="true"]`)).toHaveAttribute(
      "data-repository-path",
      first,
    );
    expect(await $$(`${menu} strong`).map((item) => item.getText())).toEqual([
      "shared",
      "shared",
      "missing",
    ]);
    await expect($(`[data-repository-path="${second}"] small`)).toHaveText(
      second,
    );
    await expect($(`[data-repository-path="${first}"]`)).toBeFocused();
    await menuKey("ArrowDown");
    await expect($(`[data-repository-path="${second}"]`)).toBeFocused();
    await menuKey("End");
    await expect($(`[data-repository-path="${missing}"]`)).toBeFocused();
    await menuKey("Home");
    await expect($(`[data-repository-path="${first}"]`)).toBeFocused();
    await browser.saveScreenshot(
      resolve("test-results/repository-switcher.png"),
    );
    await menuKey("Escape");
    await expect($(menu)).not.toExist();
    await expect($(trigger)).toBeFocused();
    await $(trigger).click();
    await browser.keys("Tab");
    await expect($(menu)).not.toExist();
    await $(trigger).click();
    await $(".statusbar").click();
    await expect($(menu)).not.toExist();
  });

  it("ignores Ctrl+T while another repository is opening", async () => {
    writeFileSync(
      join(second, "first.ts"),
      "export const destination = true;\n",
    );
    await browser.execute(() => {
      const native = window as NativeWindow;
      const originalFetch = window.fetch;
      const url = native.__TAURI_INTERNALS__.convertFileSrc(
        "open_repository",
        "ipc",
      );
      const gate: NonNullable<NativeWindow["__openGate"]> = {
        waiting: false,
        restore: () => {
          window.fetch = originalFetch;
          gate.release?.();
          delete native.__openGate;
        },
      };
      native.__openGate = gate;
      // Hold the real request so the shortcut runs during the repository switch.
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
    try {
      await $(trigger).click();
      await $(`[data-repository-path="${second}"]`).click();
      await browser.waitUntil(() =>
        browser.execute(
          () => (window as NativeWindow).__openGate?.waiting === true,
        ),
      );
      await expect($(trigger)).toHaveAttribute("title", first);
      await expect($('[aria-label="Refresh repository"]')).not.toBeEnabled();
      await browser.execute(() => {
        window.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "t",
            ctrlKey: true,
            bubbles: true,
            cancelable: true,
          }),
        );
      });
    } finally {
      await browser.execute(() =>
        (window as NativeWindow).__openGate?.restore(),
      );
    }
    await waitForRepository(second);
    await expect($(".view-switch button.active")).toHaveText("Changes");
    await switchView("Code");
    await browser.waitUntil(() =>
      browser.execute(() =>
        Array.from(document.querySelectorAll("diffs-container")).some((host) =>
          host.shadowRoot
            ?.querySelector("[data-code]")
            ?.textContent?.includes("export const destination = true;"),
        ),
      ),
    );
    await browser.saveScreenshot(
      resolve("test-results/ctrl-t-repository-switch.png"),
    );
  });

  it("restores each repository's view, selected file, scroll and draft", async () => {
    await $('.tree-file[title="second.ts"]').click();
    await $('[data-file-path="second.ts"]').waitForExist();
    await $('[aria-label="Comment on file second.ts"]').click();
    await $('[aria-label="Comment text"]').setValue(
      "Draft retained across repositories",
    );
    const top = await browser.execute(() => {
      const view = document.querySelector<HTMLElement>(".code-view")!;
      view.scrollTop = 900;
      view.dispatchEvent(new Event("scroll"));
      return view.scrollTop;
    });
    expect(top).toBeGreaterThan(0);
    await switchTo(second);
    await expect($(".view-switch button.active")).toHaveText("Changes");
    await expect($(".comment-composer")).not.toExist();
    await switchTo(first);
    await expect($(".view-switch button.active")).toHaveText("Code");
    await expect($('.tree-file[title="second.ts"]')).toHaveAttribute(
      "aria-current",
      "true",
    );
    await browser.waitUntil(
      async () =>
        Math.abs(
          (await browser.execute(
            () => document.querySelector(".code-view")!.scrollTop,
          )) - top,
        ) < 3,
    );
    await expect($('[aria-label="Comment text"]')).toHaveValue(
      "Draft retained across repositories",
    );
    await submitForm(".comment-composer");
    await expect($(".comment-card")).toHaveText(
      expect.stringContaining("Draft retained across repositories"),
    );
    await expect($(".comment-composer")).not.toExist();
  });

  it("keeps the current repository when a saved path fails", async () => {
    await $(trigger).click();
    await $(`[data-repository-path="${missing}"]`).click();
    await $(".error-banner").waitForDisplayed();
    await waitForRepository(first);
    await $('[aria-label="Dismiss error"]').click();
    await expect($(".repository-add")).toBeEnabled();
  });

  it("remembers the chosen repository after reload", async () => {
    // This scenario owns its starting session; it must also pass with --grep.
    await $('.tree-file[title="second.ts"]').click();
    await $('[data-file-path="second.ts"]').waitForExist();
    await browser.waitUntil(
      async () =>
        (await savedPreferences()).sessions[first]?.selectedPath ===
        "second.ts",
    );
    await switchTo(second);
    await $(trigger).click();
    await expect($(`${menu} [aria-checked="true"]`)).toHaveAttribute(
      "data-repository-path",
      second,
    );
    await expect($(`[data-repository-path="${first}"]`)).toExist();
    await menuKey("Escape");
    await browser.waitUntil(async () => {
      const preferences = await savedPreferences();
      return (
        preferences.lastRepository === second &&
        preferences.recentRepositories.includes(second)
      );
    });
    await reloadApp();
    await waitForRepository(second);
    await switchTo(first);
    await expect($(".view-switch button.active")).toHaveText("Code");
    await expect($('.tree-file[title="second.ts"]')).toHaveAttribute(
      "aria-current",
      "true",
    );
  });

  it("updates a moved repository location without losing reviews or its session", async () => {
    const top = await seedReviewAndSession();
    const before = await savedPreferences();
    const moved = join(workspace, "renamed");
    renameSync(first, moved);

    await updateLocation(first);
    await $("#repository-location").setValue(missing);
    await submitForm(".repository-location");
    await expect($(".repository-location [role=alert]")).toBeDisplayed();
    await $("#repository-location").waitForEnabled();
    await expect($(trigger)).toHaveAttribute("title", first);
    const rejected = await savedPreferences();
    expect(rejected.lastRepository).toBe(first);
    expect(rejected.recentRepositories).toEqual(before.recentRepositories);
    expect(rejected.sessions[first]).toEqual(before.sessions[first]);

    await $("#repository-location").setValue(moved);
    await $('.repository-location-actions button[type="button"]').click();
    await expect($(".repository-location")).not.toExist();
    await expectSession(top);
    const cancelled = await savedPreferences();
    expect(cancelled.lastRepository).toBe(first);
    expect(cancelled.recentRepositories).toEqual(before.recentRepositories);
    expect(cancelled.sessions[first]).toEqual(before.sessions[first]);

    await updateLocation(first);
    await $("#repository-location").setValue(moved);
    await submitForm(".repository-location");
    await expect($(".repository-location")).not.toExist();
    await waitForRepository(moved);
    await expectSession(top);
    await browser.waitUntil(async () => {
      const preferences = await savedPreferences();
      return (
        preferences.lastRepository === moved &&
        !preferences.recentRepositories.includes(first) &&
        preferences.sessions[moved]?.selectedPath === "second.ts" &&
        Math.abs(preferences.sessions[moved].scrollTop - top) < 3
      );
    });
    await reloadApp();
    await waitForRepository(moved);
    await expectSession(top);
    await $(trigger).click();
    await expect($(`[data-repository-path="${first}"]`)).not.toExist();
    await expect($(`[data-repository-path="${moved}"] strong`)).toHaveText(
      "renamed",
    );
    await menuKey("Escape");
    await expectReview();
    expectRepositoryFiles(moved);
    expect(existsSync(first)).toBe(false);
    await browser.saveScreenshot(
      resolve("test-results/repository-repaired.png"),
    );
  });

  it("removes an inactive repository from the list but retains its files and reviews", async () => {
    const top = await seedReviewAndSession();
    await switchTo(second);
    await removeFromList(first);
    await waitForRepository(second);
    await expect($(".view-switch button.active")).toHaveText("Changes");
    await reloadApp();
    await waitForRepository(second);
    await $(trigger).click();
    await expect($(`[data-repository-path="${first}"]`)).not.toExist();
    await expect($(`${menu} [aria-checked="true"]`)).toHaveAttribute(
      "data-repository-path",
      second,
    );
    await menuKey("Escape");
    expectRepositoryFiles(first);
    await reopenRemoved(first);
    await expectSession(top);
    await expectReview();
  });

  it("removes the active repository and keeps the empty view after reload without deleting reviews", async () => {
    const top = await seedReviewAndSession();
    await removeFromList(first);
    await $(".welcome-open").waitForEnabled();
    await expect($(".code-view")).not.toExist();
    await expect($(".comment-card")).not.toExist();
    await expect($(".tree-file")).not.toExist();
    expect((await savedPreferences()).lastRepository).toBeNull();
    await reloadApp();
    await $(".welcome-open").waitForEnabled();
    await expect($(".code-view")).not.toExist();
    await expect($(".tree-file")).not.toExist();
    await $(trigger).click();
    await expect($(`[data-repository-path="${first}"]`)).not.toExist();
    await expect($(`[data-repository-path="${second}"]`)).toExist();
    await expect($(`${menu} [aria-checked="true"]`)).not.toExist();
    await menuKey("Escape");
    await browser.saveScreenshot(
      resolve("test-results/repository-removed.png"),
    );
    expectRepositoryFiles(first);
    await reopenRemoved(first);
    await expectSession(top);
    await expectReview();
  });
});
