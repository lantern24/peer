import { browser, $, expect } from "@wdio/globals";
import type * as Tauri from "@tauri-apps/api";
import { resolve } from "node:path";
import type { Bootstrap, Preferences } from "../../src/types";
import { reloadApp } from "./app-fixture";

type TauriWindow = Window & { __TAURI__: typeof Tauri };
const dialog = 'dialog[aria-label="Keyboard shortcuts"]';
const settings = '[aria-label="Settings"]';

async function question(
  selector: string,
  options: KeyboardEventInit = {},
  alreadyPrevented = false,
) {
  return browser.execute(
    (selector, options, alreadyPrevented) => {
      const target = document.querySelector(selector);
      if (!target) throw new Error(`Missing shortcut target: ${selector}`);
      const event = new KeyboardEvent("keydown", {
        key: "?",
        code: "Slash",
        shiftKey: true,
        bubbles: true,
        composed: true,
        cancelable: true,
        ...options,
      });
      if (alreadyPrevented) event.preventDefault();
      target.dispatchEvent(event);
      return event.defaultPrevented;
    },
    selector,
    options,
    alreadyPrevented,
  );
}

async function windowSize(width: number, height: number) {
  await browser.execute(
    async (width, height) => {
      const api = (window as TauriWindow).__TAURI__.window;
      await api.getCurrentWindow().setSize(new api.LogicalSize(width, height));
      await api.getCurrentWindow().setFocus();
    },
    width,
    height,
  );
}

describe("Keyboard shortcut help in the native webview", () => {
  let preferences: Preferences;
  before(async () => {
    preferences = await browser.execute(async () => {
      const app = window as TauriWindow;
      return (await app.__TAURI__.core.invoke<Bootstrap>("bootstrap"))
        .preferences;
    });
  });
  beforeEach(async () => {
    await browser.releaseActions();
    await reloadApp({ ...preferences, sessions: {} });
    await windowSize(1440, 940);
  });
  after(async () => {
    await browser.releaseActions();
    await windowSize(1440, 940);
    await reloadApp(preferences);
  });

  it("opens without a repository, contains focus, and dismisses back to the invoking control", async () => {
    await reloadApp({
      ...preferences,
      lastRepository: null,
      sessions: {},
    });
    await browser.execute((selector) => {
      document.querySelector<HTMLButtonElement>(selector)?.focus();
    }, settings);
    await browser.keys(["Shift", "?"]);
    await browser.releaseActions();
    await expect($(dialog)).toBeDisplayed();
    await expect($(`${dialog} [aria-label="Close dialog"]`)).toBeFocused();
    await browser.keys("Tab");
    expect(
      await browser.execute(
        () =>
          document.activeElement?.closest(
            'dialog[aria-label="Keyboard shortcuts"]',
          ) !== null,
      ),
    ).toBe(true);
    await browser.saveScreenshot(
      resolve("test-results/keyboard-shortcuts.png"),
    );
    await browser.keys("Escape");
    await $(dialog).waitForExist({ reverse: true });
    await expect($(settings)).toBeFocused();

    await windowSize(950, 640);
    // A literal '?' also supports layouts where Shift+/ is not its key chord.
    expect(await question(settings, { shiftKey: false })).toBe(true);
    await $(dialog).waitForDisplayed();
    const bounds = await browser.execute((selector) => {
      const modal = document.querySelector<HTMLDialogElement>(selector);
      if (!modal) throw new Error("Shortcut dialog did not open");
      const rect = modal.getBoundingClientRect();
      modal.scrollTop = modal.scrollHeight;
      return {
        fits:
          rect.top >= 0 &&
          rect.bottom <= innerHeight &&
          rect.left >= 0 &&
          rect.right <= innerWidth,
        overflow: modal.scrollWidth > modal.clientWidth,
      };
    }, dialog);
    expect(bounds).toEqual({ fits: true, overflow: false });
    await expect($(`${dialog} section:last-child`)).toBeDisplayed();
    await browser.saveScreenshot(
      resolve("test-results/keyboard-shortcuts-small.png"),
    );
    await $(`${dialog} [aria-label="Close dialog"]`).click();
    await $(dialog).waitForExist({ reverse: true });
    await expect($(settings)).toBeFocused();
  });

  it("leaves typing, composition, modified keys, and existing dialogs untouched", async () => {
    await $('[data-repository="benchmark-repo"]').waitForExist();
    await $('[aria-label="Refresh repository"]').waitForEnabled();
    await $('.tree-file[title="src/module-000.ts"]').click();
    await $('[aria-label="Comment on file src/module-000.ts"]').click();
    const comment = '[aria-label="Comment text"]';
    await $(comment).setValue("Keep this question?");
    expect(await question(comment)).toBe(false);
    await expect($(comment)).toHaveValue("Keep this question?");
    expect(await question(".filter-input input")).toBe(false);
    expect(await question("select")).toBe(false);
    // Composed events must respect editable descendants inside shadow roots.
    expect(
      await browser.execute(() => {
        const host = document.createElement("div");
        document.body.append(host);
        const root = host.attachShadow({ mode: "open" });
        const editable = document.createElement("div");
        editable.contentEditable = "true";
        root.append(editable);
        const event = new KeyboardEvent("keydown", {
          key: "?",
          shiftKey: true,
          bubbles: true,
          composed: true,
          cancelable: true,
        });
        editable.dispatchEvent(event);
        host.remove();
        return event.defaultPrevented;
      }),
    ).toBe(false);
    for (const options of [
      { isComposing: true },
      { repeat: true },
      { ctrlKey: true },
      { metaKey: true },
      { altKey: true },
      { key: "/", shiftKey: false },
    ]) {
      expect(await question(settings, options)).toBe(false);
    }
    await question(settings, {}, true);
    await expect($(dialog)).not.toExist();

    await $(settings).click();
    expect(await question('[aria-label="Close dialog"]')).toBe(false);
    await expect($('dialog[aria-label="Settings"]')).toBeDisplayed();
    await expect($(dialog)).not.toExist();
    await $('[aria-label="Close dialog"]').click();
    expect(await question(settings)).toBe(true);
    await $(dialog).waitForDisplayed();
    await $(`${dialog} [aria-label="Close dialog"]`).click();
    await expect($(comment)).toHaveValue("Keep this question?");
  });
});
