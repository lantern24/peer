import { browser, $, expect } from "@wdio/globals";
import type * as Tauri from "@tauri-apps/api";
import type { Bootstrap, Preferences } from "../../src/types";
type TauriWindow = Window & { __TAURI__: typeof Tauri };
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { reloadApp } from "./app-fixture";

const left = '[role="separator"][aria-label="Resize file navigation sidebar"]';
const right = '[role="separator"][aria-label="Resize feedback sidebar"]';
const geometry = () =>
  browser.execute(() => ({
    files: document.querySelector(".file-sidebar")!.getBoundingClientRect()
      .width,
    feedback:
      document.querySelector(".feedback-panel")?.getBoundingClientRect()
        .width ?? 0,
    source: document.querySelector(".main-pane")!.getBoundingClientRect().width,
    total: document.querySelector(".workspace")!.getBoundingClientRect().width,
    overflow: document.documentElement.scrollWidth > innerWidth,
  }));
const resizeWindow = (width: number) =>
  browser.execute(async (width) => {
    const api = (window as any).__TAURI__.window;
    await api.getCurrentWindow().setSize(new api.LogicalSize(width, 940));
  }, width);
async function drag(selector: string, delta: number, release = true) {
  const point = await browser.execute((selector) => {
    const rect = document.querySelector(selector)!.getBoundingClientRect();
    return {
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
    };
  }, selector);
  await browser.performActions([
    {
      type: "pointer",
      id: "resize-mouse",
      parameters: { pointerType: "mouse" },
      actions: [
        { type: "pointerMove", duration: 0, origin: "viewport", ...point },
        { type: "pointerDown", button: 0 },
        {
          type: "pointerMove",
          duration: 350,
          origin: "viewport",
          x: point.x + delta,
          y: point.y,
        },
        ...(release ? [{ type: "pointerUp", button: 0 }] : []),
      ],
    },
  ]);
  if (release) await browser.releaseActions();
}
const saved = () =>
  JSON.parse(
    readFileSync(join(process.env.PEER_DATA_DIR!, "state.json"), "utf8"),
  ).preferences.sidebarWidths;

describe("Resizable sidebars in the native webview", () => {
  let originalPreferences: Preferences;
  before(async () => {
    originalPreferences = await browser.execute(async () => {
      // The desktop driver launches Tauri with its global API enabled.
      const appWindow = window as unknown as TauriWindow;
      return (await appWindow.__TAURI__.core.invoke<Bootstrap>("bootstrap"))
        .preferences;
    });
  });
  beforeEach(async () => {
    await browser.releaseActions();
    await resizeWindow(1440);
    await reloadApp({
      ...originalPreferences,
      sessions: {},
      // Non-default saved widths exercise restore/clamping in either scenario.
      sidebarWidths: { files: 320, feedback: 400 },
    });
    await browser.execute(async () => {
      // Focus the new document, not the page that was replaced by reload.
      const appWindow = window as unknown as TauriWindow;
      await appWindow.__TAURI__.window.getCurrentWindow().setFocus();
    });
    await $('[data-repository="benchmark-repo"]').waitForExist();
    await $('[aria-label="Refresh repository"]').waitForEnabled();
    await $('.tree-file[title="src/module-000.ts"]').click();
    await $('[data-file-path="src/module-000.ts"]').waitForExist();
    await expect($('.tree-file[title="src/module-000.ts"]')).toHaveAttribute(
      "aria-current",
      "true",
    );
    await browser.waitUntil(() =>
      browser.execute(
        () =>
          document
            .querySelector('[data-file-path="src/module-000.ts"]')
            ?.closest("diffs-container")
            ?.shadowRoot?.querySelector("[data-code]")
            ?.textContent?.includes("item0_0") ?? false,
      ),
    );
    await $(right).waitForExist();
    await browser.waitUntil(
      async () =>
        (await geometry()).files === 320 && (await geometry()).feedback === 400,
    );
  });
  after(async () => {
    await browser.releaseActions();
    await resizeWindow(1440);
    await reloadApp(originalPreferences);
  });

  it("drags both sidebars, preserves feedback drafts, and remembers widths after reload", async () => {
    const before = await geometry();
    // The embedded driver's element click centers the target by scrolling.
    // Open the draft through its real handler without moving the diff viewport.
    await browser.execute(() =>
      document
        .querySelector<HTMLButtonElement>(
          '[aria-label="Comment on file src/module-000.ts"]',
        )!
        .click(),
    );
    await $('[aria-label="Comment text"]').setValue(
      "Keep this draft while resizing",
    );
    await drag(left, 110);
    await browser.waitUntil(
      async () => (await geometry()).files === before.files + 110,
    );
    await drag(right, -90);
    await browser.waitUntil(
      async () => (await geometry()).feedback === before.feedback + 90,
    );
    const resized = await geometry();
    expect(resized.source).toBeGreaterThanOrEqual(360);
    expect(resized.overflow).toBe(false);
    await expect($('[aria-label="Comment text"]')).toHaveValue(
      "Keep this draft while resizing",
    );
    await expect($('.tree-file[title="src/module-000.ts"]')).toHaveAttribute(
      "aria-current",
      "true",
    );
    await $(".feedback-toggle").click();
    await $(right).waitForExist({ reverse: true });
    expect((await geometry()).source).toBeGreaterThan(resized.source);
    await $(".feedback-toggle").click();
    await $(right).waitForExist();
    expect((await geometry()).feedback).toBe(resized.feedback);
    await expect($('[aria-label="Comment text"]')).toHaveValue(
      "Keep this draft while resizing",
    );
    await $('[aria-label="Discard draft"]').click();
    await browser.waitUntil(
      async () =>
        saved().files === resized.files &&
        saved().feedback === resized.feedback,
    );
    await reloadApp();
    await $(left).waitForExist();
    await browser.waitUntil(async () => {
      const after = await geometry();
      return (
        after.files === resized.files && after.feedback === resized.feedback
      );
    });
    await browser.waitUntil(async () =>
      browser.execute(() =>
        document
          .querySelector('[data-file-path="src/module-000.ts"]')
          ?.closest("diffs-container")
          ?.shadowRoot?.querySelector("[data-code]")
          ?.textContent?.includes("item0_"),
      ),
    );
    await browser.saveScreenshot(
      resolve("test-results/resizable-sidebars.png"),
    );
  });

  it("supports keyboard resizing, cancellation, reset, and smaller windows without losing saved widths", async () => {
    const preferred = saved();
    await resizeWindow(950);
    await browser.waitUntil(async () => (await geometry()).total === 950);
    const narrow = await geometry();
    expect(narrow.source).toBeGreaterThanOrEqual(360);
    expect(narrow.files).toBeGreaterThanOrEqual(180);
    expect(narrow.feedback).toBeGreaterThanOrEqual(260);
    expect(narrow.overflow).toBe(false);
    expect(saved()).toEqual(preferred);
    await browser.saveScreenshot(
      resolve("test-results/resizable-sidebars-narrow.png"),
    );
    await resizeWindow(1440);
    await browser.waitUntil(
      async () =>
        (await geometry()).files === preferred.files &&
        (await geometry()).feedback === preferred.feedback,
    );
    await $(left).click();
    await browser.keys("ArrowRight");
    expect((await geometry()).files).toBe(preferred.files + 10);
    await $(right).click();
    await browser.keys("ArrowLeft");
    expect((await geometry()).feedback).toBe(preferred.feedback + 10);
    const beforeCancel = await geometry();
    await drag(left, 60, false);
    await browser.waitUntil(
      async () => (await geometry()).files > beforeCancel.files,
    );
    await browser.keys("Escape");
    await browser.releaseActions();
    expect((await geometry()).files).toBe(beforeCancel.files);
    expect(
      await browser.execute(() =>
        document.body.classList.contains("sidebar-resizing"),
      ),
    ).toBe(false);
    await drag(right, -1000);
    const limited = await geometry();
    expect(limited.source).toBeGreaterThanOrEqual(360);
    expect(limited.feedback).toBeLessThanOrEqual(640);
    // The embedded actions driver emits clicks but does not synthesize dblclick.
    for (const selector of [left, right]) {
      await browser.execute((selector) => {
        document
          .querySelector(selector)!
          .dispatchEvent(
            new MouseEvent("dblclick", { bubbles: true, detail: 2 }),
          );
      }, selector);
    }
    await browser.waitUntil(
      async () =>
        (await geometry()).files === 244 && (await geometry()).feedback === 310,
    );
    await browser.waitUntil(
      async () => saved().files === 244 && saved().feedback === 310,
    );
  });
});
