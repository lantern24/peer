import { browser, $, expect } from "@wdio/globals";
import type { invoke } from "@tauri-apps/api/core";
import type { Preferences } from "../../src/types";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { reloadApp } from "./app-fixture";

let originalPreferences: any;
let scenarioPreferences: Preferences;
const root = mkdtempSync(join(tmpdir(), "peer-navigation-ui-"));
const oldDefinition =
  "// Old definition\nexport function asdf() {\n\treturn 'version A';\n}\n";
const newDefinition =
  "// New definition\n\nexport function asdf() {\n\treturn 'version B';\n}\n";
const tail = Array.from({ length: 160 }, (_, i) =>
  i === 76
    ? `\tconst emoji = '😀'; asdf(); // ${"wide ".repeat(100)}\n`
    : `// Context line ${i}\n`,
).join("");
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: root, stdio: "pipe" });
async function key(key: string, ctrlKey = false, shiftKey = false) {
  await browser.execute(
    (key, ctrlKey, shiftKey) =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key,
          code: key === "-" ? "Minus" : key,
          ctrlKey,
          shiftKey,
          bubbles: true,
          cancelable: true,
        }),
      ),
    key,
    ctrlKey,
    shiftKey,
  );
}
async function historyKey(
  direction: "back" | "forward",
  options: KeyboardEventInit = {},
  selector?: string,
) {
  return browser.execute(
    (direction, options, selector) => {
      const mac = /Mac|iPhone|iPad/.test(navigator.platform);
      const back = direction === "back";
      const event = new KeyboardEvent("keydown", {
        key: mac ? (back ? "[" : "]") : back ? "ArrowLeft" : "ArrowRight",
        metaKey: mac,
        altKey: !mac,
        bubbles: true,
        composed: true,
        cancelable: true,
        ...options,
      });
      const target = selector ? document.querySelector(selector) : window;
      if (!target) throw new Error(`Missing keyboard target: ${selector}`);
      target.dispatchEvent(event);
      return event.defaultPrevented;
    },
    direction,
    options,
    selector,
  );
}
async function mouseButton(button: number, selector?: string) {
  return browser.execute(
    async (button, selector) => {
      const target = selector
        ? document.querySelector(selector)
        : document
            .querySelector("diffs-container")
            ?.shadowRoot?.querySelector("[data-code]");
      if (!target) throw new Error("Missing mouse target");
      const prevented: boolean[] = [];
      for (const type of ["mousedown", "mouseup", "auxclick"]) {
        const event = new MouseEvent(type, {
          button,
          buttons: type === "mousedown" ? [1, 4, 2, 8, 16][button] : 0,
          bubbles: true,
          composed: true,
          cancelable: true,
        });
        // Navigation can remount the viewer after mouseup.
        (target.isConnected ? target : document.body).dispatchEvent(event);
        prevented.push(event.defaultPrevented);
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
      }
      return prevented;
    },
    button,
    selector,
  );
}
async function symbol(
  name: string,
  side: "old" | "new" = "new",
  modifier = false,
  contextMenu = false,
) {
  await browser.waitUntil(async () =>
    browser.execute(
      (name, side) => {
        for (const host of document.querySelectorAll("diffs-container")) {
          for (const line of host.shadowRoot?.querySelectorAll<HTMLElement>(
            "[data-line][data-line-type]",
          ) ?? []) {
            if (!line.textContent?.includes(name)) continue;
            const old = !!line.closest(
              '[data-line-type="change-deletion"], [data-deletions]',
            );
            if (old === (side === "old")) return true;
          }
        }
        return false;
      },
      name,
      side,
    ),
  );
  await browser.execute(
    (name, side, modifier, contextMenu) => {
      for (const host of document.querySelectorAll("diffs-container")) {
        for (const line of host.shadowRoot?.querySelectorAll<HTMLElement>(
          "[data-line][data-line-type]",
        ) ?? []) {
          const at = line.textContent?.indexOf(name) ?? -1;
          const old = !!line.closest(
            '[data-line-type="change-deletion"], [data-deletions]',
          );
          if (at < 0 || old !== (side === "old")) continue;
          const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
          let offset = 0;
          while (walker.nextNode()) {
            const node = walker.currentNode as Text;
            if (at < offset + node.length) {
              const range = document.createRange();
              range.setStart(node, at - offset);
              range.setEnd(node, at - offset + 1);
              const box = range.getBoundingClientRect();
              window.getSelection()?.removeAllRanges();
              node.parentElement!.dispatchEvent(
                new MouseEvent(contextMenu ? "contextmenu" : "click", {
                  bubbles: true,
                  composed: true,
                  cancelable: true,
                  clientX: box.left + 2,
                  clientY: box.top + box.height / 2,
                  metaKey: modifier,
                }),
              );
              return;
            }
            offset += node.length;
          }
        }
      }
    },
    name,
    side,
    modifier,
    contextMenu,
  );
}
async function sourceContains(text: string) {
  await browser.waitUntil(async () =>
    browser.execute(
      (text) =>
        Array.from(document.querySelectorAll("diffs-container")).some((host) =>
          host.shadowRoot
            ?.querySelector("[data-code]")
            ?.textContent?.includes(text),
        ),
      text,
    ),
  );
}

async function clickInPlace(selector: string) {
  // Centering a virtualized header can change the active file or evict it.
  await $(selector).waitForEnabled();
  await browser.execute(
    (selector) => document.querySelector<HTMLElement>(selector)!.click(),
    selector,
  );
}

async function switchView(view: "Code" | "Changes") {
  // The outgoing document remains visible while the new snapshot opens.
  await $('[aria-label="Refresh repository"]').waitForEnabled();
  const button = await $(`button=${view}`);
  if (!(await button.getAttribute("class"))?.split(" ").includes("active"))
    await button.click();
  await browser.waitUntil(
    () =>
      browser.execute((view) => {
        const active = document.querySelector(".view-switch button.active");
        const refresh = document.querySelector<HTMLButtonElement>(
          '[aria-label="Refresh repository"]',
        );
        return (
          active?.textContent?.trim() === view &&
          refresh &&
          !refresh.disabled &&
          !document.querySelector(".refresh-overlay")
        );
      }, view),
    { timeoutMsg: `${view} snapshot did not finish opening` },
  );
}

describe("Version-aware navigation", () => {
  before(async () => {
    git("init", "-b", "main");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.invalid");
    writeFileSync(join(root, "call.ts"), "asdf(); // A\nkeep();\n" + tail);
    writeFileSync(join(root, "defs.ts"), oldDefinition);
    writeFileSync(
      join(root, "keep.ts"),
      "export function keep() {\n\treturn 1;\n}\n",
    );
    writeFileSync(
      join(root, ".editorconfig"),
      "root=true\n[keep.ts]\ntab_width=8\n",
    );
    git("add", ".");
    git("commit", "-m", "base");
    writeFileSync(join(root, "call.ts"), "asdf(); // B\n\nkeep();\n" + tail);
    writeFileSync(join(root, "defs.ts"), newDefinition);
    originalPreferences = await browser.execute(
      async () =>
        (await (window as any).__TAURI__.core.invoke("bootstrap")).preferences,
    );
    scenarioPreferences = {
      ...originalPreferences,
      lastRepository: root,
      sessions: {},
      languageServers: [
        {
          id: "test",
          name: "Protocol fixture",
          enabled: true,
          languages: { ts: "typescript" },
          executable: process.execPath,
          args: [resolve("crates/repo-core/tests/support/fake-lsp.mjs")],
          rootMarkers: [],
          env: { PEER_FAKE_FORM: "links" },
          initializationOptions: {},
          settings: {},
        },
      ],
      diffLayout: "unified",
      tabWidth: 4,
      showWhitespace: false,
      codeFontSize: 12,
    };
  });
  beforeEach(async () => {
    await browser.execute(async () => {
      await (window as any).__TAURI__.window.getCurrentWindow().setFocus();
    });
    await reloadApp(scenarioPreferences);
    await switchView("Changes");
    await $('.tree-file[title="call.ts"]').click();
    await expect($('.tree-file[title="call.ts"]')).toHaveAttribute(
      "aria-current",
      "true",
    );
    await sourceContains("asdf(); // B");
  });
  after(async () => {
    await reloadApp(originalPreferences);
  });

  it("toggles Code and Changes with Ctrl+T without interrupting input", async () => {
    await browser.execute(() => {
      const select = document.querySelector<HTMLSelectElement>(
        '[aria-label="Comparison mode"]',
      );
      if (!select) throw new Error("Missing comparison selector");
      select.value = "unstaged";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await expect($('[aria-label="Comparison mode"]')).toHaveValue("unstaged");
    await $('[aria-label="Refresh repository"]').waitForEnabled();

    const toggle = (options: KeyboardEventInit = {}, selector?: string) =>
      browser.execute(
        (options, selector) => {
          const target = selector ? document.querySelector(selector) : window;
          if (!target) throw new Error(`Missing shortcut target: ${selector}`);
          const event = new KeyboardEvent("keydown", {
            key: "t",
            code: "KeyT",
            ctrlKey: true,
            bubbles: true,
            composed: true,
            cancelable: true,
            ...options,
          });
          target.dispatchEvent(event);
          return event.defaultPrevented;
        },
        options,
        selector,
      );
    const expectView = async (view: "Code" | "Changes") => {
      await browser.waitUntil(() =>
        browser.execute(
          (view) =>
            document
              .querySelector(".view-switch button.active")
              ?.textContent?.trim() === view,
          view,
        ),
      );
      await $('[aria-label="Refresh repository"]').waitForEnabled();
      await expect($('.tree-file[title="call.ts"]')).toHaveAttribute(
        "aria-current",
        "true",
      );
      await sourceContains("asdf(); // B");
    };

    expect(await toggle()).toBe(true);
    await expectView("Code");
    await expect($('.tree-file[title="keep.ts"]')).toExist();
    await browser.saveScreenshot(resolve("test-results/ctrl-t-code.png"));
    expect(await toggle()).toBe(true);
    await expectView("Changes");
    await expect($('[aria-label="Comparison mode"]')).toHaveValue("unstaged");
    await expect($('.tree-file[title="keep.ts"]')).not.toExist();

    for (const options of [
      { ctrlKey: false },
      { ctrlKey: false, metaKey: true },
      { metaKey: true },
      { shiftKey: true },
      { altKey: true },
      { repeat: true },
      { isComposing: true },
    ])
      expect(await toggle(options)).toBe(false);
    await expectView("Changes");

    await $('[aria-label="Find in file"]').click();
    await $('input[aria-label="Find in file"]').waitForDisplayed();
    expect(await toggle({}, 'input[aria-label="Find in file"]')).toBe(false);
    await expectView("Changes");
    await $('[aria-label="Close search"]').click();
    await key("p", true);
    await $('[aria-label="Quick open file"]').waitForDisplayed();
    expect(await toggle()).toBe(false);
    await expectView("Changes");
    await browser.keys("Escape");
    await $('[aria-label="Quick open file"]').waitForExist({ reverse: true });
    await browser.saveScreenshot(resolve("test-results/ctrl-t-changes.png"));
  });

  it("renders definition tabs at the preferred width and respects EditorConfig", async () => {
    const tabColumns = () =>
      browser.execute(() => {
        for (const host of document.querySelectorAll("diffs-container")) {
          for (const line of host.shadowRoot?.querySelectorAll<HTMLElement>(
            "[data-line][data-line-type]",
          ) ?? []) {
            if (!line.textContent?.startsWith("\treturn")) continue;
            const walker = document.createTreeWalker(
              line,
              NodeFilter.SHOW_TEXT,
            );
            while (walker.nextNode()) {
              const node = walker.currentNode as Text;
              const tab = node.data.indexOf("\t");
              if (tab < 0) continue;
              const range = document.createRange();
              range.setStart(node, tab);
              range.setEnd(node, tab + 1);
              const tabWidth = range.getBoundingClientRect().width;
              // A single glyph's Range is rounded by WebKit. Measure many
              // spaces in a separate span to retain subpixel precision.
              const spaces = document.createElement("span");
              spaces.textContent = " ".repeat(100);
              spaces.style.cssText =
                "position: absolute; white-space: pre; visibility: hidden";
              line.append(spaces);
              const spaceWidth = spaces.getBoundingClientRect().width / 100;
              spaces.remove();
              return tabWidth / spaceWidth;
            }
          }
        }
        return 0;
      });
    const setTabWidth = async (width: number) => {
      await $('[aria-label="Settings"]').click();
      await $("button=Viewer").click();
      await browser.execute((width) => {
        const input = document.querySelector<HTMLInputElement>("#tab-width")!;
        Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        )!.set!.call(input, String(width));
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }, width);
      await expect($("#tab-width")).toHaveValue(String(width));
      await $('[aria-label="Close dialog"]').click();
    };
    for (const side of ["old", "new"] as const) {
      await symbol("asdf", side);
      await key("F12");
      await sourceContains(side === "old" ? "version A" : "version B");
      expect(await tabColumns()).toBeCloseTo(4, 1);
      await setTabWidth(6);
      await browser.waitUntil(
        async () => Math.abs((await tabColumns()) - 6) < 0.1,
      );
      await setTabWidth(4);
      await browser.waitUntil(
        async () => Math.abs((await tabColumns()) - 4) < 0.1,
      );
      await key("-", true);
      await $('[aria-label="Comparison mode"]').waitForExist();
    }
    await symbol("keep");
    await key("F12");
    await sourceContains("export function keep");
    expect(await tabColumns()).toBeCloseTo(8, 1);
    await setTabWidth(6);
    expect(await tabColumns()).toBeCloseTo(8, 1);
    await setTabWidth(4);
    await key("-", true);
    await $('[aria-label="Comparison mode"]').waitForExist();
  });

  it("uses A and B independently, finds references at definitions, and restores the diff with Back", async () => {
    await $('[aria-label="Comment on file call.ts"]').click();
    await $('[aria-label="Comment text"]').setValue(
      "Draft survives semantic navigation",
    );
    await symbol("asdf", "old");
    await key("F12");
    await $(".navigation-version").waitForExist();
    await expect($(".navigation-version")).toHaveText(
      expect.stringContaining("A ·"),
    );
    await sourceContains("version A");
    // F12 again at the destination identifier must find references, not loop.
    await key("F12");
    await $('[aria-label="References"]').waitForExist();
    await expect($(".navigation-result-list")).toHaveText(
      expect.stringContaining("call.ts"),
    );
    const rightWidth = () =>
      browser.execute(
        () =>
          document.querySelector("#right-sidebar")!.getBoundingClientRect()
            .width,
      );
    const beforeResize = await rightWidth();
    await $('[aria-label="Resize navigation results sidebar"]').click();
    await browser.keys("ArrowLeft");
    expect(await rightWidth()).toBe(beforeResize + 10);
    await $(".navigation-result").click();
    await sourceContains("asdf(); // A");
    await key("-", true);
    await sourceContains("version A");
    await historyKey("forward");
    await sourceContains("asdf(); // A");
    await historyKey("back");
    await sourceContains("version A");
    await $('[aria-label="References"]').waitForExist();
    await key("-", true);
    await $('[aria-label="Comparison mode"]').waitForExist();
    await expect($('[aria-label="Comment text"]')).toHaveValue(
      "Draft survives semantic navigation",
    );
    expect(await rightWidth()).toBe(beforeResize + 10);
    await $('[aria-label="Resize feedback sidebar"]').click();
    await browser.keys("ArrowRight");
    await $('[aria-label="Discard draft"]').click();
    await symbol("asdf", "new", true);
    await sourceContains("version B");
    await expect($(".navigation-version")).toHaveText("B · Working files");
    await $('[aria-label="Go back"]').click();
    await $('[aria-label="Comparison mode"]').waitForExist();
  });

  it("resolves shared lines using the selected side, including unchanged destination files", async () => {
    await symbol("keep");
    await key("F12");
    await sourceContains("export function keep");
    await expect($(".navigation-version")).toHaveText("B · Working files");
    await key("-", true);
    await browser.execute((side) => {
      const select = document.querySelector<HTMLSelectElement>(
        '[aria-label="Navigation side for shared lines"]',
      )!;
      select.value = side;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }, "old");
    await symbol("keep");
    await key("F12");
    await sourceContains("export function keep");
    await expect($(".navigation-version")).toHaveText(
      expect.stringContaining("A ·"),
    );
    await key("-", true);
    await browser.execute((side) => {
      const select = document.querySelector<HTMLSelectElement>(
        '[aria-label="Navigation side for shared lines"]',
      )!;
      select.value = side;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }, "new");
  });

  it("navigates both split columns and keeps text-input shortcuts untouched", async () => {
    await $('[aria-label="Toggle diff layout"]').click();
    await symbol("asdf", "old");
    await key("F12");
    await sourceContains("version A");
    await key("-", true);
    await symbol("asdf", "new");
    await key("F12");
    await sourceContains("version B");
    await $('[aria-label="Find in file"]').click();
    const before = await $(".navigation-version").getText();
    await browser.execute(() => {
      const input = document.querySelector<HTMLInputElement>(
        '[aria-label="Find in file"]',
      )!;
      input.focus();
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "-",
          ctrlKey: true,
          bubbles: true,
          composed: true,
        }),
      );
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "F12",
          bubbles: true,
          composed: true,
        }),
      );
    });
    await expect($(".navigation-version")).toHaveText(before);
    await $('[aria-label="Close search"]').click();
    await key("-", true);
    await $('[aria-label="Toggle diff layout"]').click();
  });

  it("restores expanded context, Unicode selection and both scroll axes after a symbol jump", async () => {
    await $('[aria-label="Toggle whitespace markers"]').click();
    await $('button[aria-label="Find in file"]').click();
    await $('input[aria-label="Go to line"]').setValue("80");
    await browser.keys("Enter");
    await $('[aria-label="Close search"]').click();
    const readViewport = () =>
      browser.execute(() => {
        const host = document
          .querySelector('[data-file-path="call.ts"]')!
          .closest("diffs-container")!;
        const code =
          host.shadowRoot!.querySelector<HTMLElement>("[data-code]")!;
        return {
          top: document.querySelector(".code-view")!.scrollTop,
          left: code.scrollLeft,
          selection: window.getSelection()?.toString(),
        };
      });
    await browser.waitUntil(async () =>
      browser.execute(() => {
        const host = document
          .querySelector('[data-file-path="call.ts"]')
          ?.closest("diffs-container");
        return (
          document.querySelector(".code-view")!.scrollTop > 300 &&
          !!host?.shadowRoot?.querySelector('[data-line="80"][data-line-type]')
        );
      }),
    );
    await $(".viewer-horizontal-scrollbar").waitForDisplayed();
    await browser.waitUntil(() =>
      browser.execute(() => {
        const bar = document.querySelector(".viewer-horizontal-scrollbar")!;
        return bar.scrollWidth - bar.clientWidth >= 60;
      }),
    );
    await browser.execute(() => {
      document.querySelector<HTMLElement>(
        ".viewer-horizontal-scrollbar",
      )!.scrollLeft = 60;
    });
    await browser.waitUntil(async () => (await readViewport()).left === 60);
    await browser.execute(() => {
      const host = document
        .querySelector('[data-file-path="call.ts"]')!
        .closest("diffs-container")!;
      const line = host.shadowRoot!.querySelector<HTMLElement>(
        '[data-line="80"][data-line-type]',
      )!;
      const token = Array.from(
        line.querySelectorAll<HTMLElement>("[data-char]"),
      ).find((token) => token.textContent === "asdf")!;
      const range = document.createRange();
      range.setStart(token.firstChild!, 0);
      range.setEnd(token.firstChild!, 4);
      window
        .getSelection()!
        .setBaseAndExtent(
          range.startContainer,
          range.startOffset,
          range.endContainer,
          range.endOffset,
        );
    });
    const before = await readViewport();
    expect(before.top).toBeGreaterThan(300);
    expect(before.left).toBeGreaterThan(0);
    expect(before.selection).toBe("asdf");
    await key("F12");
    await sourceContains("version B");
    await key("-", true);
    await $('[aria-label="Comparison mode"]').waitForExist();
    try {
      await browser.waitUntil(async () => {
        const after = await readViewport();
        return (
          Math.abs(after.top - before.top) < 3 &&
          after.left === before.left &&
          after.selection === "asdf"
        );
      });
    } catch {
      throw new Error(
        `Back viewport mismatch: ${JSON.stringify({ before, after: await readViewport() })}`,
      );
    }
    // The previous explicit navigation was Go to Line; a second Back restores the top.
    await key("-", true);
    await browser.waitUntil(async () => (await readViewport()).top < 300);
    await $('[aria-label="Toggle whitespace markers"]').click();
  });

  it("preserves expanded unchanged context and both scroll axes when refreshing", async () => {
    await $('.tree-file[title="call.ts"]').click();
    await $('button[aria-label="Find in file"]').click();
    await $('input[aria-label="Go to line"]').setValue("80");
    await browser.keys("Enter");
    await $('[aria-label="Close search"]').click();
    const viewport = () =>
      browser.execute(() => {
        const host = document
          .querySelector('[data-file-path="call.ts"]')
          ?.closest("diffs-container");
        return {
          top: document.querySelector(".code-view")!.scrollTop,
          left: host?.shadowRoot?.querySelector("[data-code]")?.scrollLeft,
          expanded: !!host?.shadowRoot?.querySelector(
            '[data-line="80"][data-line-type]',
          ),
        };
      });
    await browser.waitUntil(async () => {
      const current = await viewport();
      return current.expanded && current.top > 300;
    });
    await $(".viewer-horizontal-scrollbar").waitForDisplayed();
    await browser.waitUntil(() =>
      browser.execute(() => {
        const bar = document.querySelector(".viewer-horizontal-scrollbar")!;
        return bar.scrollWidth - bar.clientWidth >= 60;
      }),
    );
    await browser.execute(() => {
      document.querySelector<HTMLElement>(
        ".viewer-horizontal-scrollbar",
      )!.scrollLeft = 60;
    });
    await browser.waitUntil(async () => (await viewport()).left === 60);
    const before = await viewport();
    expect(before.top).toBeGreaterThan(300);
    await $('[aria-label="Refresh repository"]').click();
    await $('[aria-label="Refresh repository"]').waitForEnabled();
    await expect($('[aria-label="Go back"]')).not.toBeEnabled();
    await browser.waitUntil(async () => {
      const after = await viewport();
      return (
        after.expanded &&
        after.left === before.left &&
        Math.abs(after.top - before.top) < 3
      );
    });
    await $('.tree-file[title="call.ts"]').click();
  });

  it("supports context-menu navigation and leaves repository contents unchanged", async () => {
    await symbol("asdf", "new", false, true);
    await $('[role="menuitem"]').click();
    await sourceContains("version B");
    expect(readFileSync(join(root, "defs.ts"), "utf8")).toBe(newDefinition);
    await key("-", true);
    await $('[aria-label="Refresh repository"]').click();
    await $('[aria-label="Refresh repository"]').waitForEnabled();
    await browser.waitUntil(
      async () => !(await $('[aria-label="Go back"]').isEnabled()),
    );
  });

  for (const platform of ["MacIntel", "Win32", "Linux x86_64"]) {
    it(`traverses and branches file history with browser shortcuts on ${platform}`, async () => {
      // Emulate shortcut selection only; the native WebView still runs on the host OS.
      // beforeEach reloads the document to restore navigator.platform.
      await browser.execute((platform) => {
        Object.defineProperty(navigator, "platform", {
          configurable: true,
          value: platform,
        });
      }, platform);
      await switchView("Code");
      const selectedFile = async (path: string, text: string) => {
        await expect($(`.tree-file[title="${path}"]`)).toHaveAttribute(
          "aria-current",
          "true",
        );
        await sourceContains(text);
      };
      await $('.tree-file[title="call.ts"]').click();
      await selectedFile("call.ts", "asdf(); // B");
      await $('[aria-label="Refresh repository"]').click();
      await $('[aria-label="Refresh repository"]').waitForEnabled();
      await expect($('[aria-label="Go back"]')).not.toBeEnabled();
      await expect($('[aria-label="Go forward"]')).not.toBeEnabled();
      expect(await historyKey("back")).toBe(true);
      expect(await historyKey("forward")).toBe(true);
      await selectedFile("call.ts", "asdf(); // B");

      await $('.tree-file[title="defs.ts"]').click();
      await selectedFile("defs.ts", "version B");
      await $('.tree-file[title="keep.ts"]').click();
      await selectedFile("keep.ts", "export function keep");
      expect(await historyKey("back")).toBe(true);
      await selectedFile("defs.ts", "version B");
      expect(await historyKey("back")).toBe(true);
      await selectedFile("call.ts", "asdf(); // B");
      await expect($('[aria-label="Go back"]')).not.toBeEnabled();
      expect(await historyKey("forward")).toBe(true);
      await selectedFile("defs.ts", "version B");

      // Both directions are available, but typing, dialogs and unrelated chords win.
      await $('button[aria-label="Find in file"]').click();
      for (const direction of ["back", "forward"] as const) {
        expect(
          await historyKey(direction, {}, 'input[aria-label="Find in file"]'),
        ).toBe(false);
        for (const options of [
          { shiftKey: true },
          { ctrlKey: true },
          { repeat: true },
          { isComposing: true },
          platform === "MacIntel" ? { altKey: true } : { metaKey: true },
        ]) {
          expect(await historyKey(direction, options)).toBe(false);
        }
      }
      await selectedFile("defs.ts", "version B");
      await $('[aria-label="Close search"]').click();
      await key("p", true);
      await $('[aria-label="Quick open file"]').waitForDisplayed();
      expect(await historyKey("back")).toBe(false);
      expect(await historyKey("forward")).toBe(false);
      await browser.keys("Escape");
      await $('[aria-label="Quick open file"]').waitForExist({ reverse: true });
      await selectedFile("defs.ts", "version B");

      expect(await historyKey("forward")).toBe(true);
      await selectedFile("keep.ts", "export function keep");
      await expect($('[aria-label="Go forward"]')).not.toBeEnabled();
      expect(await historyKey("forward")).toBe(true);
      await selectedFile("keep.ts", "export function keep");
      await historyKey("back");
      await selectedFile("defs.ts", "version B");
      await $('.tree-file[title="call.ts"]').click();
      await selectedFile("call.ts", "asdf(); // B");
      await expect($('[aria-label="Go forward"]')).not.toBeEnabled();
      await historyKey("forward");
      await selectedFile("call.ts", "asdf(); // B");

      await $('[aria-label="Go back"]').click();
      await selectedFile("defs.ts", "version B");
      await $('[aria-label="Go forward"]').click();
      await selectedFile("call.ts", "asdf(); // B");
      await historyKey("back");
      await selectedFile("defs.ts", "version B");
      await expect($('[aria-label="Go forward"]')).toBeEnabled();
      await $('[aria-label="Refresh repository"]').click();
      await $('[aria-label="Refresh repository"]').waitForEnabled();
      await expect($('[aria-label="Go back"]')).not.toBeEnabled();
      await expect($('[aria-label="Go forward"]')).not.toBeEnabled();
      await historyKey("forward");
      await selectedFile("defs.ts", "version B");
    });
  }

  it("traverses view history once per mouse side-button click", async () => {
    await switchView("Code");
    const selectedFile = async (path: string, text: string) => {
      await expect($(`.tree-file[title="${path}"]`)).toHaveAttribute(
        "aria-current",
        "true",
      );
      await sourceContains(text);
    };
    await $('.tree-file[title="call.ts"]').click();
    await selectedFile("call.ts", "asdf(); // B");
    await $('[aria-label="Refresh repository"]').click();
    await $('[aria-label="Refresh repository"]').waitForEnabled();
    for (const button of [3, 4])
      expect(await mouseButton(button)).toEqual([true, true, true]);
    await selectedFile("call.ts", "asdf(); // B");
    await expect($('[aria-label="Go back"]')).not.toBeEnabled();
    await expect($('[aria-label="Go forward"]')).not.toBeEnabled();

    await $('.tree-file[title="defs.ts"]').click();
    await selectedFile("defs.ts", "version B");
    await clickInPlace('[aria-label="Collapse defs.ts"]');
    await $('.tree-file[title="keep.ts"]').click();
    await selectedFile("keep.ts", "export function keep");
    expect(await mouseButton(3)).toEqual([true, true, true]);
    await expect($('.tree-file[title="defs.ts"]')).toHaveAttribute(
      "aria-current",
      "true",
    );
    await expect($('[aria-label="Expand defs.ts"]')).toExist();
    // Both history directions are available; ordinary buttons and dialogs win.
    for (const button of [0, 1, 2])
      expect(await mouseButton(button, ".code-view")).toEqual([
        false,
        false,
        false,
      ]);
    await key("p", true);
    await $('[aria-label="Quick open file"]').waitForDisplayed();
    for (const button of [3, 4])
      expect(await mouseButton(button, "dialog[open]")).toEqual([
        true,
        true,
        true,
      ]);
    await expect($('.tree-file[title="defs.ts"]')).toHaveAttribute(
      "aria-current",
      "true",
    );
    await browser.keys("Escape");
    await $('[aria-label="Quick open file"]').waitForExist({ reverse: true });
    await mouseButton(3, ".code-view");
    await selectedFile("call.ts", "asdf(); // B");
    await expect($('[aria-label="Go back"]')).not.toBeEnabled();
    await mouseButton(4);
    await expect($('.tree-file[title="defs.ts"]')).toHaveAttribute(
      "aria-current",
      "true",
    );
    await expect($('[aria-label="Expand defs.ts"]')).toExist();
    await clickInPlace('[aria-label="Expand defs.ts"]');
    await sourceContains("version B");
    await browser.saveScreenshot(
      resolve("test-results/navigation-mouse-forward.png"),
    );
    await mouseButton(4);
    await selectedFile("keep.ts", "export function keep");
    await expect($('[aria-label="Go forward"]')).not.toBeEnabled();
    await mouseButton(3);
    await selectedFile("defs.ts", "version B");
    await $('.tree-file[title="call.ts"]').click();
    await selectedFile("call.ts", "asdf(); // B");
    await expect($('[aria-label="Go forward"]')).not.toBeEnabled();
    await mouseButton(4);
    await selectedFile("call.ts", "asdf(); // B");
  });

  it("navigates with native macOS mouse-driver swipe gestures", async function () {
    if (process.platform !== "darwin") this.skip();
    type TestWindow = Window & {
      __TAURI__: {
        core: { invoke: typeof invoke };
      };
    };
    const swipe = (deltaX: 1 | -1, windowless = false) =>
      browser.execute(
        async (deltaX, windowless) => {
          // tauri.test.conf.json enables this bridge; the command exists only in
          // desktop-test builds and dispatches through NSApplication, not JS emit.
          const testWindow = window as TestWindow;
          await testWindow.__TAURI__.core.invoke("test_swipe", {
            back: deltaX === 1,
            windowless,
          });
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          );
        },
        deltaX,
        windowless,
      );
    const selectedFile = async (path: string, text: string) => {
      await expect($(`.tree-file[title="${path}"]`)).toHaveAttribute(
        "aria-current",
        "true",
      );
      await sourceContains(text);
    };
    await switchView("Code");
    await $('.tree-file[title="call.ts"]').click();
    await selectedFile("call.ts", "asdf(); // B");
    await $('[aria-label="Refresh repository"]').click();
    await $('[aria-label="Refresh repository"]').waitForEnabled();
    await swipe(1);
    await swipe(-1);
    await selectedFile("call.ts", "asdf(); // B");
    await expect($('[aria-label="Go back"]')).not.toBeEnabled();
    await expect($('[aria-label="Go forward"]')).not.toBeEnabled();

    await $('.tree-file[title="defs.ts"]').click();
    await selectedFile("defs.ts", "version B");
    await clickInPlace('[aria-label="Collapse defs.ts"]');
    await $('.tree-file[title="keep.ts"]').click();
    await selectedFile("keep.ts", "export function keep");
    await swipe(1);
    await expect($('.tree-file[title="defs.ts"]')).toHaveAttribute(
      "aria-current",
      "true",
    );
    await expect($('[aria-label="Expand defs.ts"]')).toExist();
    // Driver-created NSEvents may omit the window; route the app gesture to Peer.
    await swipe(1, true);
    await selectedFile("call.ts", "asdf(); // B");
    await expect($('[aria-label="Go back"]')).not.toBeEnabled();
    await swipe(-1, true);
    await expect($('.tree-file[title="defs.ts"]')).toHaveAttribute(
      "aria-current",
      "true",
    );
    await expect($('[aria-label="Expand defs.ts"]')).toExist();
    await key("p", true);
    await $('[aria-label="Quick open file"]').waitForDisplayed();
    await swipe(1);
    await swipe(-1);
    await expect($('.tree-file[title="defs.ts"]')).toHaveAttribute(
      "aria-current",
      "true",
    );
    await expect($('[aria-label="Expand defs.ts"]')).toExist();
    await browser.keys("Escape");
    await $('[aria-label="Quick open file"]').waitForExist({ reverse: true });
    await swipe(-1);
    await selectedFile("keep.ts", "export function keep");
    await expect($('[aria-label="Go forward"]')).not.toBeEnabled();
    await browser.saveScreenshot(
      resolve("test-results/navigation-native-swipe-forward.png"),
    );
    await $('[aria-label="Refresh repository"]').click();
    await $('[aria-label="Refresh repository"]').waitForEnabled();
    await swipe(1);
    await selectedFile("keep.ts", "export function keep");
    await expect($('[aria-label="Go back"]')).not.toBeEnabled();
  });

  it("accepts mouse drivers mapped to browser navigation keys without leaving Peer", async () => {
    const browserKey = (
      direction: "back" | "forward",
      options: KeyboardEventInit = {},
      selector?: string,
      alreadyCancelled = false,
    ) =>
      browser.execute(
        async (direction, options, selector, alreadyCancelled) => {
          const event = new KeyboardEvent("keydown", {
            key: direction === "back" ? "BrowserBack" : "BrowserForward",
            bubbles: true,
            composed: true,
            cancelable: true,
            ...options,
          });
          const target = selector ? document.querySelector(selector) : window;
          if (!target) throw new Error(`Missing keyboard target: ${selector}`);
          if (alreadyCancelled) event.preventDefault();
          target.dispatchEvent(event);
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          );
          return event.defaultPrevented;
        },
        direction,
        options,
        selector,
        alreadyCancelled,
      );
    const selectedFile = async (path: string, text: string) => {
      await expect($(`.tree-file[title="${path}"]`)).toHaveAttribute(
        "aria-current",
        "true",
      );
      await sourceContains(text);
    };
    const staysPut = async (
      options: KeyboardEventInit = {},
      selector?: string,
      alreadyCancelled = false,
    ) => {
      for (const direction of ["back", "forward"] as const) {
        expect(
          await browserKey(direction, options, selector, alreadyCancelled),
        ).toBe(true);
        await selectedFile("defs.ts", "version B");
        await expect($('[aria-label="Go back"]')).toBeEnabled();
        await expect($('[aria-label="Go forward"]')).toBeEnabled();
      }
    };
    await switchView("Code");
    await $('.tree-file[title="call.ts"]').click();
    await selectedFile("call.ts", "asdf(); // B");
    await $('[aria-label="Refresh repository"]').click();
    await $('[aria-label="Refresh repository"]').waitForEnabled();
    await $('.tree-file[title="defs.ts"]').click();
    await selectedFile("defs.ts", "version B");
    await $('.tree-file[title="keep.ts"]').click();
    await selectedFile("keep.ts", "export function keep");
    expect(await browserKey("back")).toBe(true);
    await selectedFile("defs.ts", "version B");

    // Every blocked event is cancelled without changing either history direction.
    await $('button[aria-label="Find in file"]').click();
    await staysPut({}, 'input[aria-label="Find in file"]');
    await $('[aria-label="Close search"]').click();
    await browser.execute(() => {
      const editable = document.createElement("div");
      editable.id = "browser-key-editable";
      editable.contentEditable = "true";
      editable.textContent = "Editable keyboard target";
      document.body.append(editable);
      editable.focus();
    });
    try {
      await staysPut({}, "#browser-key-editable");
    } finally {
      await browser.execute(() =>
        document.querySelector("#browser-key-editable")?.remove(),
      );
    }
    await key("p", true);
    await $('[aria-label="Quick open file"]').waitForDisplayed();
    await staysPut();
    await browser.keys("Escape");
    await $('[aria-label="Quick open file"]').waitForExist({ reverse: true });
    for (const options of [
      { repeat: true },
      { isComposing: true },
      { altKey: true },
      { ctrlKey: true },
      { metaKey: true },
      { shiftKey: true },
    ]) {
      await staysPut(options);
    }
    await staysPut({}, undefined, true);

    // Traversal still reaches the original entries and boundaries, not new history.
    expect(await browserKey("back")).toBe(true);
    await selectedFile("call.ts", "asdf(); // B");
    await expect($('[aria-label="Go back"]')).not.toBeEnabled();
    expect(await browserKey("back")).toBe(true);
    await selectedFile("call.ts", "asdf(); // B");
    expect(await browserKey("forward")).toBe(true);
    await selectedFile("defs.ts", "version B");
    expect(await browserKey("forward")).toBe(true);
    await selectedFile("keep.ts", "export function keep");
    await expect($('[aria-label="Go forward"]')).not.toBeEnabled();
    expect(await browserKey("forward")).toBe(true);
    await selectedFile("keep.ts", "export function keep");
  });

  it("uses native history keys and restores the forward viewport", async () => {
    await switchView("Code");
    await $('.tree-file[title="call.ts"]').click();
    await sourceContains("asdf(); // B");
    await $('.tree-file[title="defs.ts"]').click();
    await sourceContains("version B");
    await clickInPlace('[aria-label="Collapse defs.ts"]');
    await expect($('[aria-label="Expand defs.ts"]')).toExist();
    const mac = process.platform === "darwin";
    await browser.keys(mac ? ["Meta", "["] : ["Alt", "ArrowLeft"]);
    await expect($('.tree-file[title="call.ts"]')).toHaveAttribute(
      "aria-current",
      "true",
    );
    await sourceContains("asdf(); // B");
    await browser.keys(mac ? ["Meta", "]"] : ["Alt", "ArrowRight"]);
    await expect($('.tree-file[title="defs.ts"]')).toHaveAttribute(
      "aria-current",
      "true",
    );
    await expect($('[aria-label="Expand defs.ts"]')).toExist();
    await clickInPlace('[aria-label="Expand defs.ts"]');
    await sourceContains("version B");
    await browser.saveScreenshot(
      resolve("test-results/navigation-keyboard-forward.png"),
    );
  });
  for (const selectionApi of ["legacy", "unavailable"] as const) {
    it(`switches Code files and restores history with ${selectionApi} WebKit selection APIs`, async () => {
      await switchView("Code");
      await $('.tree-file[title="call.ts"]').click();
      await sourceContains("asdf(); // B");
      await browser.execute((selectionApi) => {
        const original = Selection.prototype.getComposedRanges;
        if (selectionApi === "unavailable") {
          Object.defineProperty(Selection.prototype, "getComposedRanges", {
            configurable: true,
            value: undefined,
          });
        } else {
          // Older WebKit accepts individual ShadowRoots, not an options object.
          // Keep the actual native selection behavior behind that older signature.
          Object.defineProperty(Selection.prototype, "getComposedRanges", {
            configurable: true,
            value: function (this: Selection, ...roots: unknown[]) {
              const shadowRoots = roots.map((root) => {
                if (!(root instanceof ShadowRoot))
                  throw new TypeError("Expected a ShadowRoot");
                return root;
              });
              try {
                return original.call(this, { shadowRoots });
              } catch (error) {
                if (!(error instanceof TypeError)) throw error;
                // Also run on a host whose native implementation is already legacy.
                return Reflect.apply(original, this, shadowRoots);
              }
            },
          });
        }
        const host = document.querySelector("diffs-container");
        const line = host?.shadowRoot?.querySelector(
          "[data-line][data-line-type]",
        );
        if (!line) throw new Error("Source line not rendered");
        const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
        const text = walker.nextNode();
        if (!text) throw new Error("Source text not rendered");
        window.getSelection()?.setBaseAndExtent(text, 0, text, 4);
      }, selectionApi);
      // This used to reject while capturing history, before selecting or reading defs.ts.
      await $('.tree-file[title="defs.ts"]').click();
      await expect($('.tree-file[title="defs.ts"]')).toHaveAttribute(
        "aria-current",
        "true",
      );
      await sourceContains("version B");
      await key("-", true);
      await expect($('.tree-file[title="call.ts"]')).toHaveAttribute(
        "aria-current",
        "true",
      );
      await sourceContains("asdf(); // B");
      // Without composed ranges, the native Range may hide shadow-DOM endpoints.
      // File/history navigation must still work; legacy composed ranges retain selection.
      if (selectionApi === "legacy") {
        await browser.waitUntil(() =>
          browser.execute(() => window.getSelection()?.toString() === "asdf"),
        );
      }
      await browser.execute(() => window.getSelection()?.removeAllRanges());
      await $('.tree-file[title="defs.ts"]').click();
      await expect($('.tree-file[title="defs.ts"]')).toHaveAttribute(
        "aria-current",
        "true",
      );
      await sourceContains("version B");
      // The next beforeEach reloads the WebView and restores Selection.prototype.
    });
  }

  it("records Code file and quick-open choices and restores collapsed state", async () => {
    // A shared-line preference must never select historical source in Code.
    await browser.execute(() => {
      const select = document.querySelector<HTMLSelectElement>(
        '[aria-label="Navigation side for shared lines"]',
      )!;
      select.value = "old";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await switchView("Code");
    await $(".breadcrumb").waitForExist();
    await $('.tree-file[title="call.ts"]').click();
    await expect($('.tree-file[title="call.ts"]')).toHaveAttribute(
      "aria-current",
      "true",
    );
    await sourceContains("asdf(); // B");
    await clickInPlace('[aria-label="Collapse call.ts"]');
    await expect($('[aria-label="Expand call.ts"]')).toExist();
    await $('.tree-file[title="defs.ts"]').click();
    await expect($('.tree-file[title="defs.ts"]')).toHaveAttribute(
      "aria-current",
      "true",
    );
    await sourceContains("version B");
    await key("-", true);
    await $('[aria-label="Expand call.ts"]').waitForExist();
    await browser.saveScreenshot(
      resolve("test-results/navigation-back-collapsed.png"),
    );
    await clickInPlace('[aria-label="Expand call.ts"]');
    await browser.execute(() =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "p",
          metaKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    const input = $('[aria-label="Quick open file"]');
    await expect(input).toBeFocused();
    await input.setValue(".ts");
    await expect($(".quick-results mark")).toHaveText(".ts");
    const active = () => $('.quick-results [aria-selected="true"]');
    await expect(active()).toHaveText("call.ts");
    await browser.keys("ArrowDown");
    await expect(active()).toHaveText("defs.ts");
    await browser.keys(["Control", "n"]);
    await expect(active()).toHaveText("keep.ts");
    await browser.keys(["Control", "p"]);
    await expect(active()).toHaveText("defs.ts");
    await expect(input).toHaveValue(".ts");
    await browser.keys("ArrowUp");
    await expect(active()).toHaveText("call.ts");
    await browser.keys("ArrowUp");
    await expect(active()).toHaveText("keep.ts");
    await expect(input).toBeFocused();
    await input.setValue("no-matching-file");
    await browser.keys("Enter");
    await expect($(".quick-empty")).toHaveText("No matching files");
    await expect(input).toBeFocused();
    await input.setValue("keep.ts");
    await expect(active()).toHaveText("keep.ts");
    await key("F12");
    await key("-", true);
    await $('[aria-label="Quick open file"]').waitForDisplayed();
    await browser.keys("Enter");
    await $('[aria-label="Quick open file"]').waitForExist({ reverse: true });
    await expect($('.tree-file[title="keep.ts"]')).toHaveAttribute(
      "aria-current",
      "true",
    );
    await sourceContains("export function keep");
    await key("-", true);
    await $('[data-file-path="call.ts"]').waitForExist();
    await expect($('.tree-file[title="call.ts"]')).toHaveAttribute(
      "aria-current",
      "true",
    );
    await sourceContains("asdf(); // B");
  });

  it("searches the displayed full source and returns through search and symbol jumps", async () => {
    await switchView("Code");
    await $('.tree-file[title="call.ts"]').click();
    await sourceContains("asdf(); // B");
    await symbol("asdf");
    await key("F12");
    await sourceContains("version B");
    await expect($(".navigation-version")).toHaveText("Working files");
    await $('button[aria-label="Find in file"]').click();
    await $('input[aria-label="Find in file"]').setValue("version B");
    const searchMarks = () =>
      browser.execute(() =>
        Array.from(document.querySelectorAll("diffs-container")).flatMap(
          (host) =>
            Array.from(
              host.shadowRoot?.querySelectorAll<HTMLElement>(
                "mark.search-match",
              ) ?? [],
            ).map((mark) => ({
              text: mark.textContent,
              active: mark.classList.contains("search-match-active"),
              background: getComputedStyle(mark).backgroundColor,
            })),
        ),
      );
    await browser.waitUntil(
      async () =>
        (await searchMarks()).map((mark) => mark.text).join("") === "version B",
    );
    expect(
      (await searchMarks()).every(
        (mark) => mark.background === "rgb(255, 229, 138)",
      ),
    ).toBe(true);
    await browser.execute(() =>
      document.querySelector<HTMLFormElement>(".find-bar")!.requestSubmit(),
    );
    await expect($(".find-bar")).toHaveText(expect.stringContaining("1 / 1"));
    await browser.waitUntil(async () =>
      (await searchMarks()).every((mark) => mark.active),
    );
    await browser.keys("Escape");
    await $(".find-bar").waitForExist({ reverse: true });
    await browser.waitUntil(async () => (await searchMarks()).length === 0);
    await key("-", true);
    await $(".navigation-version").waitForExist();
    await sourceContains("version B");
    await key("-", true);
    await $(".breadcrumb").waitForExist();
    await sourceContains("asdf(); // B");
    await $('[aria-label="Settings"]').click();
    await $("button=Code navigation").click();
    await $(".navigation-settings").waitForDisplayed();
    await key("F12");
    await key("-", true);
    await $("dialog[open]").waitForExist();
    await $('[aria-label="Close dialog"]').click();
  });

  it("highlights literal source matches through diff layouts, expanded context, and whitespace", async () => {
    await switchView("Changes");
    await $('[data-file-path="call.ts"]').waitForExist();
    await $('.tree-file[title="call.ts"]').click();
    await expect($('.tree-file[title="call.ts"]')).toHaveAttribute(
      "aria-current",
      "true",
    );
    await $('button[aria-label="Find in file"]').click();
    const input = $('input[aria-label="Find in file"]');
    const marks = () =>
      browser.execute(() =>
        Array.from(document.querySelectorAll("diffs-container")).flatMap(
          (host) =>
            Array.from(
              host.shadowRoot?.querySelectorAll<HTMLElement>(
                "mark.search-match",
              ) ?? [],
            ).map((mark) => ({
              text: mark.textContent,
              active: mark.classList.contains("search-match-active"),
              line: mark.closest<HTMLElement>("[data-line][data-line-type]")
                ?.dataset.line,
            })),
        ),
      );
    await input.setValue("ASDF();");
    await browser.waitUntil(async () =>
      (await marks())
        .map((mark) => mark.text)
        .join("")
        .includes("asdf();"),
    );
    await expect($(".find-bar")).toHaveText(expect.stringContaining("0 / 4"));
    await browser.keys("Enter");
    await expect($(".find-bar")).toHaveText(expect.stringContaining("1 / 4"));
    await browser.waitUntil(
      async () =>
        (await marks())
          .filter((mark) => mark.active)
          .map((mark) => mark.text)
          .join("") === "asdf();",
    );
    await $('[aria-label="Toggle diff layout"]').click();
    await browser.waitUntil(
      async () =>
        (await marks())
          .filter((mark) => mark.active)
          .map((mark) => mark.text)
          .join("") === "asdf();",
    );
    await $('[aria-label="Toggle whitespace markers"]').click();
    await input.setValue("\tconst emoji = '😀'; asdf()");
    await browser.keys("Enter");
    await browser.waitUntil(
      async () =>
        (await marks())
          .filter((mark) => mark.active)
          .map((mark) => mark.text)
          .join("") === "\tconst emoji = '😀'; asdf()",
    );
    await input.setValue("wide");
    await browser.keys("Enter");
    const first = await browser.execute(() =>
      Array.from(document.querySelectorAll("diffs-container")).flatMap((host) =>
        Array.from(
          host.shadowRoot?.querySelectorAll<HTMLElement>(
            ".search-match-active",
          ) ?? [],
        ).map((mark) => mark.dataset.searchStart),
      ),
    );
    await browser.keys("Enter");
    await browser.waitUntil(
      async () =>
        JSON.stringify(
          await browser.execute(() =>
            Array.from(document.querySelectorAll("diffs-container")).flatMap(
              (host) =>
                Array.from(
                  host.shadowRoot?.querySelectorAll<HTMLElement>(
                    ".search-match-active",
                  ) ?? [],
                ).map((mark) => mark.dataset.searchStart),
            ),
          ),
        ) !== JSON.stringify(first),
    );
    await input.setValue("no-such-source-text");
    await expect($(".find-bar")).toHaveText(
      expect.stringContaining("No matches"),
    );
    await browser.waitUntil(async () => (await marks()).length === 0);
    await browser.keys("Escape");
    await $(".find-bar").waitForExist({ reverse: true });
    await $('[aria-label="Filter files"]').setValue("CALL");
    await expect($(".tree-file mark")).toHaveText("call");
    await $('[aria-label="Filter files"]').setValue("");
  });
});
