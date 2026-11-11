import { browser, $, expect } from "@wdio/globals";
import type * as Tauri from "@tauri-apps/api";
import type { Bootstrap, Preferences, ReviewQueue } from "../../src/types";
type TauriWindow = Window & {
  __TAURI__: typeof Tauri;
  __TAURI_INTERNALS__: {
    convertFileSrc: typeof Tauri.core.convertFileSrc;
  };
};
type FeedbackRequestWindow = TauriWindow & {
  __feedbackRequest?: {
    command: string | null;
    release?: () => void;
    restore: () => void;
  };
};
type BenchmarkWindow = Window & {
  __benchmark: {
    frames: number[];
    navigation: number[];
    done: boolean;
    error: string;
  };
};
import {
  writeFileSync,
  appendFileSync,
  readFileSync,
  chmodSync,
  existsSync,
  unlinkSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, join } from "node:path";
import { cpus, platform, release } from "node:os";
import {
  assessPerformance,
  enforcePerformance,
  performanceMode,
} from "./performance";
import { clickLineComment, reloadApp } from "./app-fixture";

async function focusApp() {
  await browser.execute(async () => {
    // The native test configuration exposes this API and permits window focus.
    const appWindow = window as unknown as TauriWindow;
    await appWindow.__TAURI__.window.getCurrentWindow().setFocus();
  });
}

async function click(selector: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      await $(selector).waitForEnabled();
      await $(selector).click();
      return;
    } catch (error) {
      if (attempt >= 2 || !String(error).includes("no longer attached"))
        throw error;
    }
  }
}

async function clickInPlace(selector: string) {
  // The embedded driver's click centers the element, which can change the
  // active file or evict a short file's header from the virtualized viewport.
  await $(selector).waitForEnabled();
  await browser.execute(
    (selector) => document.querySelector<HTMLElement>(selector)!.click(),
    selector,
  );
}

async function switchView(view: "Code" | "Changes") {
  // The previous document stays visible while a new snapshot opens. A Code
  // breadcrumb alone can therefore still belong to the outgoing snapshot.
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

async function addFileComment(body: string) {
  await clickInPlace('[aria-label="Comment on file src/module-000.ts"]');
  await $('[aria-label="Comment text"]').setValue(body);
  await browser.execute(() => {
    const form = document.querySelector<HTMLFormElement>(".comment-composer")!;
    form.requestSubmit(
      form.querySelector<HTMLButtonElement>(".primary-button")!,
    );
  });
  await browser.waitUntil(() =>
    browser.execute(
      (body) =>
        Array.from(document.querySelectorAll(".comment-card p")).some(
          (node) => node.textContent === body,
        ),
      body,
    ),
  );
}

type RangeLineType = "context" | "change-addition" | "change-deletion";

async function clickRangeEndpoint(
  line: number,
  type: RangeLineType,
  path = "src/module-000.ts",
  modified = true,
) {
  const selector = `[data-column-number="${line}"][data-line-type="${type}"]`;
  await browser.waitUntil(() =>
    browser.execute(
      (path, selector) =>
        !!document
          .querySelector(`[data-file-path="${path}"]`)
          ?.closest("diffs-container")
          ?.shadowRoot?.querySelector(selector),
      path,
      selector,
    ),
  );
  await browser.execute(
    async (path, selector, modified) => {
      const root = document
        .querySelector(`[data-file-path="${path}"]`)
        ?.closest("diffs-container")?.shadowRoot;
      const gutter = root?.querySelector(selector);
      if (!gutter) throw new Error("Range endpoint is not rendered");
      const rect = gutter.getBoundingClientRect();
      const mac = /Mac|iPhone|iPad/.test(navigator.platform);
      const pointer = {
        bubbles: true,
        composed: true,
        cancelable: true,
        pointerType: "mouse",
        pointerId: 1,
        button: 0,
        metaKey: modified && mac,
        ctrlKey: modified && !mac,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
      };
      const hitTarget = () => {
        let target = document.elementFromPoint(
          pointer.clientX,
          pointer.clientY,
        );
        while (target?.shadowRoot) {
          const inner = target.shadowRoot.elementFromPoint(
            pointer.clientX,
            pointer.clientY,
          );
          if (!inner || inner === target) break;
          target = inner;
        }
        if (!target || !root?.querySelector(selector)?.contains(target))
          throw new Error("Range endpoint gutter is not hit-testable");
        return target;
      };
      let target = hitTarget();
      target.dispatchEvent(new PointerEvent("pointermove", pointer));
      const pressed = target.dispatchEvent(
        new PointerEvent("pointerdown", { ...pointer, buttons: 1 }),
      );
      if (pressed)
        target.dispatchEvent(
          new MouseEvent("mousedown", { ...pointer, buttons: 1 }),
        );
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
      // Highlighting can replace the gutter during the frame. Native mouse
      // release/click events hit the current DOM, not the detached pressed node.
      target = hitTarget();
      target.dispatchEvent(new PointerEvent("pointerup", pointer));
      target.dispatchEvent(new MouseEvent("mouseup", pointer));
      target.dispatchEvent(new MouseEvent("click", pointer));
    },
    path,
    selector,
    modified,
  );
}

async function expectRangeHighlight(type: RangeLineType) {
  await browser.waitUntil(() =>
    browser.execute((type) => {
      const root = document
        .querySelector('[data-file-path="src/module-000.ts"]')
        ?.closest("diffs-container")?.shadowRoot;
      return [2, 3, 4].every((line) =>
        root?.querySelector(
          `[data-code] [data-line="${line}"][data-selected-line]${
            line === 3 ? "" : `[data-line-type="${type}"]`
          }`,
        ),
      );
    }, type),
  );
}

describe("Peer in the native webview", () => {
  let originalPreferences: Preferences;
  const originalFiles = new Map<string, string>();
  before(async () => {
    await $('[data-repository="benchmark-repo"]').waitForExist();
    await $('[aria-label="Refresh repository"]').waitForEnabled();
    originalPreferences = await browser.execute(async () => {
      // The desktop driver launches Tauri with its global API enabled.
      const appWindow = window as unknown as TauriWindow;
      return (await appWindow.__TAURI__.core.invoke<Bootstrap>("bootstrap"))
        .preferences;
    });
    for (const path of ["src/module-000.ts", "notes.txt"])
      originalFiles.set(
        path,
        readFileSync(join(process.env.PEER_TEST_REPO!, path), "utf8"),
      );
  });
  beforeEach(async () => {
    const { queues } = JSON.parse(
      readFileSync(join(process.env.PEER_DATA_DIR!, "state.json"), "utf8"),
    );
    await browser.execute(async (queueIds) => {
      // The desktop driver launches Tauri with its global API enabled.
      const appWindow = window as unknown as TauriWindow;
      for (const queueId of queueIds)
        await appWindow.__TAURI__.core.invoke("delete_comments", {
          queueId,
          id: null,
        });
    }, Object.keys(queues));
    await reloadApp({
      ...originalPreferences,
      sessions: {},
      showWhitespace: false,
      diffLayout: "unified",
      codeFontSize: 12,
    });
    await focusApp();
    await switchView("Changes");
    await click('.tree-file[title="src/module-000.ts"]');
    await browser.waitUntil(() =>
      browser.execute(
        () =>
          document
            .querySelector('[data-file-path="src/module-000.ts"]')
            ?.closest("diffs-container")
            ?.shadowRoot?.querySelector("[data-code]")
            ?.textContent?.includes("item0_0") === true,
      ),
    );
    const reviewed = '[data-file-path="src/module-000.ts"] .review-check input';
    if (await $(reviewed).isSelected()) await clickInPlace(reviewed);
    await browser.waitUntil(() =>
      browser.execute(
        (selector) =>
          document.querySelector<HTMLInputElement>(selector)?.checked === false,
        reviewed,
      ),
    );
  });
  afterEach(async () => {
    const repo = process.env.PEER_TEST_REPO!;
    // The interrupted-refresh fixture stages this otherwise untracked file.
    // Remove only that fixture's index entry and files, never reset the repository.
    if (existsSync(join(repo, "refresh-target.txt")))
      execFileSync(
        "git",
        ["update-index", "--force-remove", "--", "refresh-target.txt"],
        { cwd: repo },
      );
    for (const path of [
      "refresh-target.txt",
      "refresh-added.txt",
      "refresh-removed.txt",
      ".git/refresh-git",
      ".git/refresh-pending",
    ]) {
      if (existsSync(join(repo, path))) unlinkSync(join(repo, path));
    }
    for (const [path, source] of originalFiles) {
      const absolute = join(process.env.PEER_TEST_REPO!, path);
      if (readFileSync(absolute, "utf8") !== source)
        writeFileSync(absolute, source);
    }
    const errors = await browser.execute(() =>
      [
        document.querySelector(".fatal")?.textContent,
        ...Array.from(document.querySelectorAll("diffs-container")).map(
          (host) =>
            host.shadowRoot?.querySelector("[data-error-wrapper]")?.textContent,
        ),
      ].filter(Boolean),
    );
    expect(errors).toEqual([]);
  });
  after(async () => {
    await reloadApp(originalPreferences);
  });
  it("opens a real 100-file Git comparison and highlights offline", async () => {
    await $('[data-repository="benchmark-repo"]').waitForExist();
    await browser.waitUntil(
      async () => Number(await $(".app").getAttribute("data-loaded-files")) > 0,
    );
    await expect($(".statusbar")).toHaveText(
      expect.stringContaining("100 files"),
    );
    writeFileSync(
      "test-results/dom.json",
      JSON.stringify(
        await browser.execute(() =>
          Array.from(document.querySelectorAll("diffs-container"))
            .slice(0, 2)
            .map((e) => ({
              html: e.shadowRoot?.innerHTML.slice(-10000),
              style: e.getAttribute("style"),
            })),
        ),
        null,
        2,
      ),
    );
    await browser.waitUntil(async () =>
      browser.execute(() =>
        Array.from(document.querySelectorAll("diffs-container")).some(
          (e) => !!e.shadowRoot?.querySelector("[data-code] span"),
        ),
      ),
    );
    await browser.saveScreenshot(resolve("test-results/changes.png"));
  });

  async function holdFeedbackRequests(commands: string[]) {
    await browser.execute((commands) => {
      const appWindow = window as unknown as FeedbackRequestWindow;
      const urls = new Map(
        commands.map((command) => [
          appWindow.__TAURI_INTERNALS__.convertFileSrc(command, "ipc"),
          command,
        ]),
      );
      const original = window.fetch;
      const pending: NonNullable<FeedbackRequestWindow["__feedbackRequest"]> = {
        command: null,
        restore: () => {
          window.fetch = original;
          pending.release?.();
          delete appWindow.__feedbackRequest;
        },
      };
      appWindow.__feedbackRequest = pending;
      // Delay transport only; each released request still reaches native IPC.
      window.fetch = (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        const command = urls.get(url);
        if (!command) return original(input, init);
        urls.delete(url);
        pending.command = command;
        return new Promise<Response>((resolve) => {
          pending.release = () => {
            pending.command = null;
            pending.release = undefined;
            resolve(original(input, init));
          };
        });
      };
    }, commands);
  }

  async function waitForFeedbackRequest(command: string) {
    await browser.waitUntil(() =>
      browser.execute(
        (command) =>
          (window as unknown as FeedbackRequestWindow).__feedbackRequest
            ?.command === command,
        command,
      ),
    );
  }

  async function releaseFeedbackRequest() {
    await browser.execute(() =>
      (
        window as unknown as FeedbackRequestWindow
      ).__feedbackRequest?.release?.(),
    );
  }

  async function restoreFeedbackRequests() {
    await browser.execute(() =>
      (window as unknown as FeedbackRequestWindow).__feedbackRequest?.restore(),
    );
  }

  it("blocks copying during an open edit and an in-flight comment save", async () => {
    await addFileComment("Original feedback");
    await click('.comment-card button[aria-label="Edit comment"]');
    await $('textarea[aria-label="Edit comment"]').setValue("Revised feedback");
    await expect($("button=Copy comments")).toBeDisabled();
    await holdFeedbackRequests(["update_comment", "get_queue"]);
    try {
      await browser.execute(() => {
        document
          .querySelector<HTMLFormElement>(".comment-card form")
          ?.requestSubmit();
      });
      await waitForFeedbackRequest("update_comment");
      await expect($("button=Copy comments")).toBeDisabled();
      await expect($("button=Cancel")).toBeDisabled();
      await click('[aria-label="Close feedback"]');
      await click(".feedback-toggle");
      await expect($("button=Copy comments")).toBeDisabled();
      await expect(
        $('.comment-card button[aria-label="Edit comment"]'),
      ).toBeDisabled();
      await releaseFeedbackRequest();
      await waitForFeedbackRequest("get_queue");
      await expect($("button=Copy comments")).toBeDisabled();
      await releaseFeedbackRequest();
      await expect($(".comment-card p")).toHaveText("Revised feedback");
      await click("button=Copy comments");
      await expect($(".comment-card")).not.toExist();
      const copied = await browser.execute(() =>
        (window as unknown as TauriWindow).__TAURI__.core.invoke<string>(
          "plugin:clipboard-manager|read_text",
        ),
      );
      expect(JSON.parse(copied)).toEqual([
        { file: "src/module-000.ts", comment: "Revised feedback" },
      ]);
    } finally {
      await restoreFeedbackRequests();
    }
  });

  it("blocks comment edits throughout export, clipboard writing, and cleanup", async () => {
    await addFileComment("Copy this exact feedback");
    const commands = [
      "export_queue",
      "plugin:clipboard-manager|write_text",
      "delete_comments",
    ];
    await holdFeedbackRequests(commands);
    try {
      await click("button=Copy comments");
      for (const command of commands) {
        await waitForFeedbackRequest(command);
        await expect($(".feedback-actions .primary-button")).toBeDisabled();
        await expect(
          $('.comment-card button[aria-label="Edit comment"]'),
        ).toBeDisabled();
        await click('[aria-label="Close feedback"]');
        await click(".feedback-toggle");
        await expect($(".feedback-actions .primary-button")).toBeDisabled();
        await expect(
          $('.comment-card button[aria-label="Edit comment"]'),
        ).toBeDisabled();
        await expect($(".comment-card p")).toHaveText(
          "Copy this exact feedback",
        );
        if (command === "plugin:clipboard-manager|write_text")
          await browser.saveScreenshot(
            resolve("test-results/copy-edit-guard.png"),
          );
        await releaseFeedbackRequest();
      }
      await expect($(".comment-card")).not.toExist();
      const copied = await browser.execute(() =>
        (window as unknown as TauriWindow).__TAURI__.core.invoke<string>(
          "plugin:clipboard-manager|read_text",
        ),
      );
      expect(JSON.parse(copied)).toEqual([
        { file: "src/module-000.ts", comment: "Copy this exact feedback" },
      ]);
      await addFileComment("Editing is available after copying");
      await click('.comment-card button[aria-label="Edit comment"]');
      await expect($('textarea[aria-label="Edit comment"]')).toHaveValue(
        "Editing is available after copying",
      );
    } finally {
      await restoreFeedbackRequests();
    }
  });

  it("saves feedback, keeps a draft through theme changes, and copies concise feedback", async () => {
    await addFileComment("Please explain the value change.");
    await click('[aria-label="Comment on file src/module-000.ts"]');
    await $('[aria-label="Comment text"]').setValue(
      "Draft survives theme switching",
    );
    await click('[aria-label="Settings"]');
    await click("button*=Dracula");
    await click('[aria-label="Close dialog"]');
    await browser.waitUntil(async () =>
      browser.execute(() =>
        Array.from(document.querySelectorAll("diffs-container")).some(
          (e) =>
            e.shadowRoot?.querySelector("pre") &&
            getComputedStyle(e.shadowRoot.querySelector("pre")!)
              .backgroundColor === "rgb(40, 42, 54)",
        ),
      ),
    );
    await expect($('[aria-label="Comment text"]')).toHaveValue(
      "Draft survives theme switching",
    );
    await expect($(".feedback-copy-option input")).toBeSelected();
    await click(".feedback-copy-option input");
    await click('[aria-label="Close feedback"]');
    await click(".feedback-toggle");
    await expect($(".feedback-copy-option input")).not.toBeSelected();
    await click("button=Copy comments");
    await expect($(".toast")).toHaveText(expect.stringContaining("copied"));
    const copied = await browser.execute(async () =>
      (window as any).__TAURI__.core.invoke(
        "plugin:clipboard-manager|read_text",
      ),
    );
    expect(JSON.parse(copied)).toEqual([
      {
        file: "src/module-000.ts",
        comment: "Please explain the value change.",
      },
    ]);
    await expect($(".comment-card p")).toHaveText(
      "Please explain the value change.",
    );
    await browser.saveScreenshot(resolve("test-results/dark-feedback.png"));
    await click(".feedback-copy-option input");
    await click("button=Copy comments");
    await expect($(".comment-card")).not.toExist();
    await expect($(".feedback-title .count")).toHaveText("0");
    await expect($('[aria-label="Comment text"]')).toHaveValue(
      "Draft survives theme switching",
    );
    const saved: { queues: Record<string, ReviewQueue> } = JSON.parse(
      readFileSync(join(process.env.PEER_DATA_DIR!, "state.json"), "utf8"),
    );
    expect(
      Object.values(saved.queues).flatMap((queue) => queue.comments),
    ).toEqual([]);
  });

  it("keeps comments when copying falls back after clipboard failure", async () => {
    await addFileComment("Keep this comment if copying fails.");
    await expect($(".feedback-copy-option input")).toBeSelected();
    await browser.execute(() => {
      const appWindow = window as unknown as TauriWindow;
      const clipboardUrl = appWindow.__TAURI_INTERNALS__.convertFileSrc(
        "plugin:clipboard-manager|write_text",
        "ipc",
      );
      const original = window.fetch;
      window.fetch = (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url === clipboardUrl) {
          window.fetch = original;
          return Promise.resolve(
            new Response(JSON.stringify("Clipboard unavailable"), {
              headers: {
                "Content-Type": "application/json",
                "Tauri-Response": "error",
              },
            }),
          );
        }
        return original(input, init);
      };
    });
    await click("button=Copy comments");
    const fallback = $('[aria-label="Exported feedback JSON"]');
    await fallback.waitForExist();
    expect(JSON.parse(await fallback.getValue())).toEqual([
      {
        file: "src/module-000.ts",
        comment: "Keep this comment if copying fails.",
      },
    ]);
    await click('[aria-label="Close dialog"]');
    await expect($(".comment-card p")).toHaveText(
      "Keep this comment if copying fails.",
    );
    await expect($("button=Copy comments")).toBeEnabled();
    await expect(
      $('.comment-card button[aria-label="Edit comment"]'),
    ).toBeEnabled();
    const saved: { queues: Record<string, ReviewQueue> } = JSON.parse(
      readFileSync(join(process.env.PEER_DATA_DIR!, "state.json"), "utf8"),
    );
    expect(
      Object.values(saved.queues).flatMap((queue) =>
        queue.comments.map((comment) => comment.body),
      ),
    ).toEqual(["Keep this comment if copying fails."]);
  });

  it("preserves whitespace text while showing markers and switches layouts", async () => {
    const before = await browser.execute(() =>
      Array.from(document.querySelectorAll("diffs-container")).map(
        (e) =>
          e.shadowRoot?.querySelector("[data-line][data-line-type]")
            ?.textContent,
      ),
    );
    await click('[aria-label="Toggle whitespace markers"]');
    const after = await browser.execute(() =>
      Array.from(document.querySelectorAll("diffs-container")).map(
        (e) =>
          e.shadowRoot?.querySelector("[data-line][data-line-type]")
            ?.textContent,
      ),
    );
    expect(after).toEqual(before);
    expect(before.some((text) => text?.includes("\t"))).toBe(true);
    expect(
      await browser.execute(() =>
        Array.from(document.querySelectorAll("diffs-container")).some(
          (e) => !!e.shadowRoot?.querySelector("[data-inspector-whitespace]"),
        ),
      ),
    ).toBe(true);
    await click('[aria-label="Toggle diff layout"]');
    await click('[aria-label="Toggle diff layout"]');
  });

  it("wraps long source lines to each pane and reflows on window and sidebar resize", async () => {
    const path = "src/module-000.ts";
    const source = originalFiles.get(path)!;
    const firstLine = `export const item0_0 = {\tvalue: 0, label: "${"longToken".repeat(16)}" };  `;
    writeFileSync(
      join(process.env.PEER_TEST_REPO!, path),
      firstLine + "\n" + source.slice(source.indexOf("\n") + 1),
    );
    await click('[aria-label="Refresh repository"]');
    await $('[aria-label="Refresh repository"]').waitForEnabled();
    const resize = (width: number) =>
      browser.execute(async (width) => {
        const api = (window as unknown as TauriWindow).__TAURI__.window;
        await api.getCurrentWindow().setSize(new api.LogicalSize(width, 940));
      }, width);
    const readLines = () =>
      browser.execute((path) => {
        const root = document
          .querySelector(`[data-file-path="${path}"]`)
          ?.closest("diffs-container")?.shadowRoot;
        return Array.from(
          root?.querySelectorAll<HTMLElement>(
            '[data-code] [data-line="1"][data-line-type]',
          ) ?? [],
        ).map((line) => {
          const code = line.closest<HTMLElement>("[data-code]")!;
          const column = line.getBoundingClientRect();
          const viewport = document
            .querySelector(".code-view")!
            .getBoundingClientRect();
          // Preserved spaces can hang past a pre-wrap cell. Check visible glyphs.
          const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
          const range = document.createRange();
          const rects: DOMRect[] = [];
          while (walker.nextNode()) {
            const text = walker.currentNode as Text;
            for (const match of text.data.matchAll(/\S+/g)) {
              range.setStart(text, match.index);
              range.setEnd(text, match.index + match[0].length);
              for (const rect of range.getClientRects()) {
                // WebKit also reports zero-width caret boxes at wrap boundaries.
                if (rect.width > 0 && rect.height > 0) rects.push(rect);
              }
            }
          }
          return {
            text: line.textContent,
            width: column.width,
            height: line.getBoundingClientRect().height,
            lineHeight: parseFloat(getComputedStyle(line).lineHeight),
            fits:
              column.left >= viewport.left - 1 &&
              column.right <= viewport.right + 1 &&
              rects.every(
                (rect) =>
                  rect.left >= column.left - 1 &&
                  rect.right <= column.right + 1,
              ),
            overflow: code.scrollWidth - code.clientWidth,
            nextTop: code
              .querySelector('[data-line="2"][data-line-type]')
              ?.getBoundingClientRect().top,
          };
        });
      }, path);
    try {
      for (const mode of ["unified", "split", "code"]) {
        if (mode === "split") await click('[aria-label="Toggle diff layout"]');
        if (mode === "code") await switchView("Code");
        await click(`.tree-file[title="${path}"]`);
        await resize(950);
        await browser.waitUntil(async () =>
          (await readLines()).some((line) => line.text === firstLine),
        );
        const narrow = await readLines();
        expect(narrow.map((line) => line.text)).toEqual(
          mode === "code" ? [firstLine] : [source.split("\n")[0], firstLine],
        );
        for (const line of narrow) {
          expect(line.fits).toBe(true);
          expect(line.overflow).toBeLessThanOrEqual(1);
          expect(line.height).toBeGreaterThan(line.lineHeight);
        }
        if (mode === "split")
          expect(
            Math.abs(narrow[0].nextTop! - narrow[1].nextTop!),
          ).toBeLessThanOrEqual(1);

        await resize(1440);
        await browser.waitUntil(async () => {
          const wider = await readLines();
          return (
            wider.length === narrow.length &&
            wider.at(-1)!.height < narrow.at(-1)!.height
          );
        });
        const wide = await readLines();
        expect(wide.map((line) => line.text)).toEqual(
          narrow.map((line) => line.text),
        );

        // Change the pane width without changing the window.
        const divider = '[aria-label="Resize file navigation sidebar"]';
        await browser.execute((selector) => {
          const divider = document.querySelector<HTMLElement>(selector)!;
          divider.focus();
          divider.dispatchEvent(
            new KeyboardEvent("keydown", {
              key: "End",
              bubbles: true,
              cancelable: true,
            }),
          );
        }, divider);
        await browser.waitUntil(
          async () => (await readLines()).at(-1)!.width < wide.at(-1)!.width,
        );
        const sidebar = await readLines();
        expect(sidebar.at(-1)!.height).toBeGreaterThan(wide.at(-1)!.height);
        expect(sidebar.every((line) => line.fits && line.overflow <= 1)).toBe(
          true,
        );
        await browser.execute((selector) => {
          document.querySelector(selector)!.dispatchEvent(
            new MouseEvent("dblclick", {
              bubbles: true,
            }),
          );
        }, divider);

        // Selecting wrapped visual rows must still copy the original source.
        const selected = await browser.execute((path) => {
          const lines = document
            .querySelector(`[data-file-path="${path}"]`)!
            .closest("diffs-container")!
            .shadowRoot!.querySelectorAll(
              '[data-code] [data-line="1"][data-line-type]',
            );
          const walker = document.createTreeWalker(
            lines[lines.length - 1],
            NodeFilter.SHOW_TEXT,
          );
          const nodes: Text[] = [];
          while (walker.nextNode()) nodes.push(walker.currentNode as Text);
          const selection = window.getSelection()!;
          selection.removeAllRanges();
          selection.setBaseAndExtent(
            nodes[0],
            0,
            nodes[nodes.length - 1],
            nodes[nodes.length - 1].length,
          );
          return selection.toString();
        }, path);
        expect(selected).toBe(firstLine);
        await clickLineComment(
          1,
          mode === "code" ? "context" : "change-addition",
        );
        const comment = `Wrapped line in ${mode}`;
        await $('[aria-label="Comment text"]').setValue(comment);
        await click("button=Add comment");
        await expect($(".comment-card p")).toHaveText(comment);
        await browser.saveScreenshot(resolve(`test-results/wrap-${mode}.png`));
        await click("button=Copy comments");
        await expect($(".comment-card")).not.toExist();
        const copied = await browser.execute(() =>
          (window as unknown as TauriWindow).__TAURI__.core.invoke<string>(
            "plugin:clipboard-manager|read_text",
          ),
        );
        expect(JSON.parse(copied)).toEqual([{ file: path, line: 1, comment }]);
      }
    } finally {
      await resize(1440);
    }
  });

  it("selects the existing query whenever Find is invoked", async () => {
    const input = 'input[aria-label="Find in file"]';
    await click('button[aria-label="Find in file"]');
    for (const invocation of [
      "open shortcut",
      "closed shortcut",
      "closed toolbar",
    ]) {
      await $(input).setValue("item0_0");
      if (invocation !== "open shortcut")
        await click('[aria-label="Close search"]');
      if (invocation === "closed toolbar")
        await click('button[aria-label="Find in file"]');
      else
        await browser.keys([
          process.platform === "darwin" ? "Meta" : "Control",
          "f",
        ]);
      await expect($(input)).toBeFocused();
      expect(
        await browser.execute(() => {
          const field = document.querySelector<HTMLInputElement>(
            'input[aria-label="Find in file"]',
          );
          return [field?.selectionStart, field?.selectionEnd];
        }),
      ).toEqual([0, "item0_0".length]);
      // The embedded driver's printable keys append regardless of selection.
      // Use WebKit's editing command to exercise replacement of the selection.
      await browser.execute(() =>
        document.execCommand("insertText", false, "item0_1"),
      );
      await expect($(input)).toHaveValue("item0_1");
    }
    await browser.saveScreenshot(resolve("test-results/find-invocation.png"));
  });

  it("reveals search matches on wrapped continuations taller than the viewport", async () => {
    writeFileSync(
      join(process.env.PEER_TEST_REPO!, "notes.txt"),
      `prefix ${"content ".repeat(500)}needle\nAfter the long line\n`,
    );
    await browser.execute(async () => {
      const api = (window as unknown as TauriWindow).__TAURI__.window;
      await api.getCurrentWindow().setSize(new api.LogicalSize(950, 940));
    });
    try {
      for (const view of ["Code", "Changes"] as const) {
        await switchView(view);
        await click('[aria-label="Refresh repository"]');
        await $('[aria-label="Refresh repository"]').waitForEnabled();
        await click('.tree-file[title="notes.txt"]');
        await click('button[aria-label="Find in file"]');
        await $('input[aria-label="Find in file"]').setValue("needle");
        // A file click can return before its source and search results load.
        await expect($(".find-bar")).toHaveText(expect.stringContaining("/ 1"));
        await $('input[aria-label="Find in file"]').click();
        await expect($('input[aria-label="Find in file"]')).toBeFocused();
        await browser.keys("Enter");
        await expect($(".find-bar")).toHaveText(
          expect.stringContaining("1 / 1"),
        );
        await browser.waitUntil(() =>
          browser.execute(() => {
            const line = document
              .querySelector('[data-file-path="notes.txt"]')
              ?.closest("diffs-container")
              ?.shadowRoot?.querySelector(
                '[data-line="1"][data-line-type]:not([data-line-type="change-deletion"])',
              );
            return (
              !!line &&
              line.getBoundingClientRect().height >
                document.querySelector(".code-view")!.clientHeight
            );
          }),
        );
        await browser.waitUntil(() =>
          browser.execute(() => {
            const host = document
              .querySelector('[data-file-path="notes.txt"]')
              ?.closest("diffs-container");
            const match = host?.shadowRoot?.querySelector(
              ".search-match-active",
            );
            if (!match) return false;
            const bounds = match.getBoundingClientRect();
            const viewport = document
              .querySelector(".code-view")!
              .getBoundingClientRect();
            const header = host
              ?.querySelector(".file-heading")
              ?.getBoundingClientRect();
            return (
              match.textContent === "needle" &&
              bounds.top >= (header?.bottom ?? viewport.top) &&
              bounds.bottom <= viewport.bottom &&
              bounds.left >= viewport.left &&
              bounds.right <= viewport.right
            );
          }),
        );
        await browser.saveScreenshot(
          resolve(`test-results/wrap-search-${view}.png`),
        );
        await click('[aria-label="Close search"]');
      }
    } finally {
      await browser.execute(async () => {
        const api = (window as unknown as TauriWindow).__TAURI__.window;
        await api.getCurrentWindow().setSize(new api.LogicalSize(1440, 940));
      });
    }
  });

  it("resizes code and diffs immediately, preserving drafts and saved preferences", async () => {
    const readState = () =>
      JSON.parse(
        readFileSync(join(process.env.PEER_DATA_DIR!, "state.json"), "utf8"),
      );
    await addFileComment("Keep this saved feedback while resizing");
    const queuesBefore = readState().queues;
    const chooseFont = (size: number) =>
      browser.execute((value) => {
        // The embedded driver's option clicks don't emit a select change event.
        const select =
          document.querySelector<HTMLSelectElement>("#code-font-size")!;
        select.value = String(value);
        select.dispatchEvent(new Event("change", { bubbles: true }));
      }, size);
    const waitForFont = async (size: number, height: number) => {
      await browser.waitUntil(async () =>
        browser.execute(
          (font, lineHeight) => {
            const lines = Array.from(
              document.querySelectorAll("diffs-container"),
            ).flatMap((node) =>
              Array.from(
                node.shadowRoot?.querySelectorAll(
                  "[data-line][data-line-type]",
                ) ?? [],
              ),
            );
            return (
              lines.length > 0 &&
              lines.every((line) => {
                const style = getComputedStyle(line);
                return (
                  style.fontSize === `${font}px` &&
                  style.lineHeight === `${lineHeight}px`
                );
              })
            );
          },
          size,
          height,
        ),
      );
    };
    await click('[aria-label="Comment on file src/module-000.ts"]');
    await $('[aria-label="Comment text"]').setValue(
      "Keep this draft while resizing",
    );
    await click('[aria-label="Settings"]');
    await click("button=Viewer");
    await chooseFont(16);
    await click('[aria-label="Close dialog"]');
    await waitForFont(16, 29);
    await expect($('[aria-label="Comment text"]')).toHaveValue(
      "Keep this draft while resizing",
    );
    await click('[aria-label="Discard draft"]');
    await browser.waitUntil(
      async () => readState().preferences.codeFontSize === 16,
    );
    expect(readState().queues).toEqual(queuesBefore);
    await switchView("Code");
    await waitForFont(16, 29);
    await reloadApp();
    await $('[data-repository="benchmark-repo"]').waitForExist();
    await waitForFont(16, 29);
    await switchView("Changes");
    await waitForFont(16, 29);
    await click('[aria-label="Settings"]');
    await click("button=Viewer");
    await expect($("#code-font-size")).toHaveValue("16");
    await chooseFont(12);
    await click('[aria-label="Close dialog"]');
    await waitForFont(12, 22);
  });

  it("groups settings into keyboard-accessible tabs and preserves drafts between sections", async () => {
    await $('[data-repository="benchmark-repo"]').waitForExist();
    await click('[aria-label="Settings"]');
    const active = () => $('[role="tab"][aria-selected="true"]');
    // The embedded driver's key map omits Home and End; dispatch those DOM keys directly.
    const endpointKey = (key: "Home" | "End") =>
      browser.execute((value) => {
        document.activeElement?.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: value,
            bubbles: true,
            cancelable: true,
          }),
        );
      }, key);
    await expect(active()).toHaveText("Appearance");
    await expect(active()).toBeFocused();
    await browser.keys("ArrowRight");
    await expect(active()).toHaveText("Viewer");
    await expect($("#code-font-size")).toBeDisplayed();
    await expect($('[aria-label="Search themes"]')).not.toBeDisplayed();
    await browser.keys("ArrowRight");
    await expect(active()).toHaveText("Code navigation");
    await $('[aria-label="Go (gopls) executable"]').setValue(
      "/tmp/unsaved-gopls",
    );
    await click("button=Advanced / custom servers");
    const draft = await $(
      '[aria-label="Language server configuration"]',
    ).getValue();
    await click("button=Git");
    await expect($('[aria-label="Git executable path"]')).toBeDisplayed();
    await expect(
      $('[aria-label="Language server configuration"]'),
    ).not.toBeDisplayed();
    await browser.keys("ArrowLeft");
    await expect(active()).toHaveText("Code navigation");
    await expect($('[aria-label="Language server configuration"]')).toHaveValue(
      draft,
    );
    await endpointKey("Home");
    await expect(active()).toHaveText("Appearance");
    await $('[aria-label="Search themes"]').setValue("Dracula");
    await click("button=Viewer");
    await endpointKey("End");
    const lastTab = $('[role="tablist"] [role="tab"]:last-child');
    await expect(lastTab).toHaveAttribute("aria-selected", "true");
    await expect(lastTab).toBeFocused();
    await browser.keys("ArrowRight");
    await expect(active()).toHaveText("Appearance");
    await expect($('[aria-label="Search themes"]')).toHaveValue("Dracula");
    await $('[aria-label="Search themes"]').setValue("");
    const layout = await browser.execute(() => {
      const dialog =
        document.querySelector<HTMLDialogElement>(".settings-modal")!;
      const tabs = dialog.querySelector<HTMLElement>('[role="tablist"]')!;
      const panel = dialog.querySelector<HTMLElement>(
        '[role="tabpanel"]:not([hidden])',
      )!;
      const top = tabs.getBoundingClientRect().top;
      panel.scrollTop = panel.scrollHeight;
      return {
        top,
        after: tabs.getBoundingClientRect().top,
        outerScroll: dialog.scrollTop,
        panelScroll: panel.scrollTop,
        tabStops: dialog.querySelectorAll('[role="tab"][tabindex="0"]').length,
        visiblePanels: dialog.querySelectorAll(
          '[role="tabpanel"]:not([hidden])',
        ).length,
      };
    });
    expect(layout.after).toBe(layout.top);
    expect(layout.outerScroll).toBe(0);
    expect(layout.panelScroll).toBeGreaterThan(0);
    expect(layout.tabStops).toBe(1);
    expect(layout.visiblePanels).toBe(1);
    await browser.execute(() => {
      document.querySelector<HTMLElement>(
        '[role="tabpanel"]:not([hidden])',
      )!.scrollTop = 0;
    });
    await browser.saveScreenshot(resolve("test-results/settings-tabs.png"));
    await browser.keys("Escape");
    await $(".settings-modal").waitForExist({ reverse: true });
    await click('[aria-label="Settings"]');
    await click("button=Code navigation");
    await expect($('[aria-label="Go (gopls) executable"]')).not.toHaveValue(
      "/tmp/unsaved-gopls",
    );
    await click('[aria-label="Close dialog"]');
  });

  for (const view of ["Code", "unified", "split"] as const) {
    for (const side of view === "Code"
      ? (["new"] as const)
      : (["old", "new"] as const)) {
      it(`persists and exports an inclusive reversed range in ${view} ${side}`, async () => {
        if (view === "Code") await switchView("Code");
        if (view === "split") await click('[aria-label="Toggle diff layout"]');
        const type: RangeLineType =
          view === "Code"
            ? "context"
            : side === "old"
              ? "change-deletion"
              : "change-addition";
        const path = "src/module-000.ts";
        const body = `Inclusive range ${view} ${side}`;
        const location = `${side === "old" ? "Old " : ""}lines 2–4`;
        const source =
          side === "old"
            ? execFileSync("git", ["show", `HEAD:${path}`], {
                cwd: process.env.PEER_TEST_REPO,
                encoding: "utf8",
              })
            : originalFiles.get(path);
        if (source === undefined) throw new Error("Missing range fixture");
        const lines = source.split("\n");
        const rangeText = lines.slice(1, 4).join("\n");
        await clickRangeEndpoint(4, type);
        await clickRangeEndpoint(2, type);
        await expectRangeHighlight(type);
        await clickLineComment(4, type);
        await expect($(".comment-composer .comment-location")).toHaveText(
          location,
        );
        await expect($('[aria-label="Comment text"]')).toBeFocused();
        await browser.keys(body);
        await click('[aria-label="Refresh repository"]');
        await $('[aria-label="Refresh repository"]').waitForEnabled();
        await expect($('[aria-label="Comment text"]')).toHaveValue(body);
        await expect($(".comment-composer .comment-location")).toHaveText(
          location,
        );
        await click("button=Add comment");
        await expect($(".comment-card .comment-location")).toHaveText(location);
        expect(
          await browser.execute(
            () =>
              document.querySelector(".comment-card .comment-context")
                ?.textContent,
          ),
        ).toBe(rangeText);
        const saved: { queues: Record<string, ReviewQueue> } = JSON.parse(
          readFileSync(join(process.env.PEER_DATA_DIR!, "state.json"), "utf8"),
        );
        const comment = Object.values(saved.queues)
          .flatMap((queue) => queue.comments)
          .find((comment) => comment.body === body);
        expect(comment?.scope).toBe("line");
        expect(comment?.anchor.line).toBe(2);
        expect(comment?.anchor.endLine).toBe(4);
        expect(comment?.anchor.side).toBe(view === "Code" ? undefined : side);
        expect(comment?.anchor.lineText).toBe(rangeText);
        expect(comment?.anchor.contextBefore?.at(-1)).toBe(lines[0]);
        expect(comment?.anchor.contextAfter?.[0]).toBe(lines[4]);
        await reloadApp();
        await $('[aria-label="Refresh repository"]').waitForEnabled();
        await expect($(".comment-card .comment-location")).toHaveText(location);
        await click('.tree-file[title="src/module-001.ts"]');
        await click(".comment-card .comment-path");
        await expectRangeHighlight(type);
        await browser.saveScreenshot(
          resolve(`test-results/range-${view}-${side}.png`),
        );
        if (await $(".feedback-copy-option input").isSelected())
          await click(".feedback-copy-option input");
        await click("button=Copy comments");
        await expect($(".toast")).toHaveText(expect.stringContaining("copied"));
        const copied = await browser.execute(() =>
          (window as unknown as TauriWindow).__TAURI__.core.invoke<string>(
            "plugin:clipboard-manager|read_text",
          ),
        );
        expect(JSON.parse(copied)).toEqual([
          {
            file: path,
            line: 2,
            endLine: 4,
            ...(side === "old" ? { side: "old" } : {}),
            comment: body,
          },
        ]);
      });

      it(`uses the selected source lines for feedback in ${view} ${side}`, async () => {
        if (view === "Code") await switchView("Code");
        if (view === "split") await click('[aria-label="Toggle diff layout"]');
        const type: RangeLineType =
          view === "Code"
            ? "context"
            : side === "old"
              ? "change-deletion"
              : "change-addition";
        const path = "src/module-000.ts";
        const location = `${side === "old" ? "Old " : ""}lines 2–4`;
        // Snapshot readiness precedes asynchronous source loading and rendering.
        await browser.waitUntil(
          () =>
            browser.execute(
              (path, type, exclusiveEnd) => {
                const host = document
                  .querySelector(`[data-file-path="${path}"]`)
                  ?.closest("diffs-container");
                const root = host?.shadowRoot;
                const first = root?.querySelector(
                  `[data-code] [data-line="2"][data-line-type="${type}"]`,
                );
                const last = root?.querySelector(
                  `[data-code] [data-line="${exclusiveEnd ? 5 : 4}"][data-line-type="${type}"]`,
                );
                const gutter = root?.querySelector(
                  `[data-column-number="4"][data-line-type="${type}"]`,
                );
                if (!first || !last || !gutter) return false;
                gutter.dispatchEvent(
                  new PointerEvent("pointermove", {
                    bubbles: true,
                    composed: true,
                    pointerType: "mouse",
                    pointerId: 1,
                  }),
                );
                const button = host?.querySelector<HTMLButtonElement>(
                  '[aria-label="Comment on line"]',
                );
                if (!button || !button.getBoundingClientRect().height)
                  return false;
                const firstWalker = document.createTreeWalker(
                  first,
                  NodeFilter.SHOW_TEXT,
                );
                const lastWalker = document.createTreeWalker(
                  last,
                  NodeFilter.SHOW_TEXT,
                );
                const start = firstWalker.nextNode();
                let end = lastWalker.nextNode();
                if (!exclusiveEnd) {
                  let next: Node | null;
                  while ((next = lastWalker.nextNode())) end = next;
                }
                if (!start || !end)
                  throw new Error("Source selection has no text endpoints");
                const selection = window.getSelection();
                if (!selection)
                  throw new Error("Source selection is unavailable");
                // Reverse selection, including a next-line column-zero boundary.
                selection.setBaseAndExtent(
                  end,
                  exclusiveEnd ? 0 : (end.textContent?.length ?? 0),
                  start,
                  0,
                );
                // WebKit's document-level isCollapsed can be true for a shadow
                // selection; verify the selected source text instead.
                const firstText = first.textContent?.trim();
                if (!firstText || !selection.toString().includes(firstText))
                  throw new Error(
                    "Source selection did not include its first line",
                  );
                // Activate before a late highlight render can replace the
                // selected text nodes between separate WebDriver commands.
                button.click();
                return true;
              },
              path,
              type,
              view === "Code",
            ),
          { timeoutMsg: "Selected source lines did not finish rendering" },
        );
        await expect($(".comment-composer .comment-location")).toHaveText(
          location,
        );
        await expect($('[aria-label="Comment text"]')).toBeFocused();
        await browser.keys(`Selected source ${view} ${side}`);
        await click("button=Add comment");
        await expect($(".comment-card .comment-location")).toHaveText(location);
        const source =
          side === "old"
            ? execFileSync("git", ["show", `HEAD:${path}`], {
                cwd: process.env.PEER_TEST_REPO,
                encoding: "utf8",
              })
            : originalFiles.get(path);
        if (source === undefined) throw new Error("Missing source fixture");
        expect(
          await browser.execute(
            () =>
              document.querySelector(".comment-card .comment-context")
                ?.textContent,
          ),
        ).toBe(source.split("\n").slice(1, 4).join("\n"));
        await browser.saveScreenshot(
          resolve(`test-results/selected-source-${view}-${side}.png`),
        );
        await clickLineComment(6, type);
        await expect($(".comment-composer .comment-location")).toHaveText(
          `${side === "old" ? "Old " : ""}line 6`,
        );
      });
    }

    it(`keeps range drafts while retargeting across lines, sides, and files in ${view}`, async () => {
      if (view === "Code") await switchView("Code");
      if (view === "split") await click('[aria-label="Toggle diff layout"]');
      const type = view === "Code" ? "context" : "change-addition";
      await clickRangeEndpoint(2, type);
      await clickRangeEndpoint(4, type);
      await clickLineComment(4, type);
      await browser.keys("Retain range draft");
      // A plain line-number click replaces the range with a single line.
      await clickRangeEndpoint(6, type, "src/module-000.ts", false);
      await clickLineComment(6, type);
      await expect($(".comment-composer .comment-location")).toHaveText(
        "line 6",
      );
      await expect($('[aria-label="Comment text"]')).toHaveValue(
        "Retain range draft",
      );
      await clickRangeEndpoint(8, type);
      if (view !== "Code") {
        // The second endpoint on the other side must start a new selection.
        await clickRangeEndpoint(2, "change-deletion");
        await clickLineComment(2, "change-deletion");
        await expect($(".comment-composer .comment-location")).toHaveText(
          "Old line 2",
        );
      }
      await click('.tree-file[title="src/module-001.ts"]');
      await expect($(".comment-composer .comment-path")).toHaveText(
        "src/module-000.ts",
      );
      await clickRangeEndpoint(4, type, "src/module-001.ts");
      await clickLineComment(4, type, "src/module-001.ts");
      await expect($(".comment-composer .comment-location")).toHaveText(
        "line 4",
      );
      await expect($(".comment-composer .comment-path")).toHaveText(
        "src/module-001.ts",
      );
      await expect($('[aria-label="Comment text"]')).toHaveValue(
        "Retain range draft",
      );
      await click("button=Add comment");
      await expect($(".comment-card .comment-location")).toHaveText("line 4");
      const saved: { queues: Record<string, ReviewQueue> } = JSON.parse(
        readFileSync(join(process.env.PEER_DATA_DIR!, "state.json"), "utf8"),
      );
      const comment = Object.values(saved.queues)
        .flatMap((queue) => queue.comments)
        .find((comment) => comment.body === "Retain range draft");
      expect(comment?.path).toBe("src/module-001.ts");
      expect(comment?.anchor.line).toBe(4);
      expect(comment?.anchor.endLine).toBeUndefined();
      await click("button=Copy comments");
      await expect($(".toast")).toHaveText(expect.stringContaining("copied"));
      const copied = await browser.execute(() =>
        (window as unknown as TauriWindow).__TAURI__.core.invoke<string>(
          "plugin:clipboard-manager|read_text",
        ),
      );
      expect(JSON.parse(copied)).toEqual([
        {
          file: "src/module-001.ts",
          line: 4,
          comment: "Retain range draft",
        },
      ]);
    });
  }

  it("selects a range with Ctrl on an emulated non-Mac platform", async () => {
    // This emulates modifier routing, not a native Linux/Windows WebView.
    // beforeEach reloads the document and restores navigator.platform.
    await browser.execute(() => {
      Object.defineProperty(navigator, "platform", {
        configurable: true,
        value: "Linux x86_64",
      });
    });
    await switchView("Code");
    await clickRangeEndpoint(2, "context");
    await clickRangeEndpoint(4, "context");
    await clickLineComment(4, "context");
    await expect($(".comment-composer .comment-location")).toHaveText(
      "lines 2–4",
    );
    await expectRangeHighlight("context");
  });

  for (const view of ["Code", "unified", "split"] as const) {
    it(`focuses the comment editor after one click, including the same line, in ${view}`, async () => {
      if (view === "Code") await switchView("Code");
      if (view === "split") await click('[aria-label="Toggle diff layout"]');
      const type = view === "Code" ? "context" : "change-addition";
      await click('[aria-label="Close feedback"]');
      await clickLineComment(2, type);
      await expect($('[aria-label="Comment text"]')).toBeFocused();
      // Send keys to the active element: setValue would focus the textarea
      // itself and conceal a failed handoff from the gutter button.
      await browser.keys("First");
      await expect($('[aria-label="Comment text"]')).toHaveValue("First");
      await clickLineComment(2, type);
      await expect($('[aria-label="Comment text"]')).toBeFocused();
      await browser.keys(" same");
      await expect($('[aria-label="Comment text"]')).toHaveValue("First same");
      await clickLineComment(4, type);
      await expect($('[aria-label="Comment text"]')).toBeFocused();
      await browser.keys(" moved");
      await expect($('[aria-label="Comment text"]')).toHaveValue(
        "First same moved",
      );
      await expect($(".comment-composer .comment-location")).toHaveText(
        "line 4",
      );
      await click('[aria-label="Close feedback"]');
      await clickLineComment(4, type);
      await expect($('[aria-label="Comment text"]')).toBeFocused();
      await browser.keys(" reopened");
      await expect($('[aria-label="Comment text"]')).toHaveValue(
        "First same moved reopened",
      );
      await browser.saveScreenshot(
        resolve(`test-results/comment-single-click-${view}.png`),
      );
    });

    it(`opens and retargets line comments from + in ${view} while keeping draft text`, async () => {
      if (view === "Code") await switchView("Code");
      if (view === "split") await click('[aria-label="Toggle diff layout"]');
      for (const type of view === "Code"
        ? (["context"] as const)
        : (["change-deletion", "change-addition"] as const)) {
        await click('.tree-file[title="src/module-000.ts"]');
        await click('[aria-label="Close feedback"]');
        await clickLineComment(2, type);
        await expect($('[aria-label="Comment text"]')).toBeFocused();
        await expect($(".comment-composer .comment-location")).toHaveText(
          type === "change-deletion" ? "Old line 2" : "line 2",
        );
        await expect($(".comment-composer .comment-path")).toHaveText(
          "src/module-000.ts",
        );
        await clickLineComment(4, type);
        await expect($(".comment-composer .comment-location")).toHaveText(
          type === "change-deletion" ? "Old line 4" : "line 4",
        );
        const body = `Keep this ${view} ${type} draft`;
        await expect($('[aria-label="Comment text"]')).toBeFocused();
        await browser.keys(body);
        const targetType =
          type === "context"
            ? "context"
            : type === "change-deletion"
              ? "change-addition"
              : "change-deletion";
        await clickLineComment(6, targetType);
        await expect($('[aria-label="Comment text"]')).toBeFocused();
        await expect($('[aria-label="Comment text"]')).toHaveValue(body);
        await expect($(".comment-composer .comment-location")).toHaveText(
          targetType === "change-deletion" ? "Old line 6" : "line 6",
        );
        // Browsing does not move the draft; only an explicit comment action does.
        await click('.tree-file[title="src/module-001.ts"]');
        await expect($(".comment-composer .comment-path")).toHaveText(
          "src/module-000.ts",
        );
        await clickLineComment(8, targetType, "src/module-001.ts");
        await expect($('[aria-label="Comment text"]')).toBeFocused();
        await expect($('[aria-label="Comment text"]')).toHaveValue(body);
        await expect($(".comment-composer .comment-path")).toHaveText(
          "src/module-001.ts",
        );
        await expect($(".comment-composer .comment-location")).toHaveText(
          targetType === "change-deletion" ? "Old line 8" : "line 8",
        );
        await browser.saveScreenshot(
          resolve(`test-results/line-comment-${view}-${type}.png`),
        );
        await browser.execute(() => {
          const form =
            document.querySelector<HTMLFormElement>(".comment-composer");
          if (!form) throw new Error("Comment editor is not open");
          form.requestSubmit();
        });
        await $(".comment-composer").waitForExist({ reverse: true });
        const saved: { queues: Record<string, ReviewQueue> } = JSON.parse(
          readFileSync(join(process.env.PEER_DATA_DIR!, "state.json"), "utf8"),
        );
        const comment = Object.values(saved.queues)
          .flatMap((queue) => queue.comments)
          .find((comment) => comment.body === body);
        expect(comment?.path).toBe("src/module-001.ts");
        expect(comment?.anchor.line).toBe(8);
        expect(comment?.anchor.side).toBe(
          targetType === "context"
            ? undefined
            : targetType === "change-deletion"
              ? "old"
              : "new",
        );
        expect(comment?.anchor.lineText).toContain("item1_7");
      }
    });
  }

  it("retargets between file and line comments without losing draft text", async () => {
    await clickInPlace('[aria-label="Comment on file src/module-000.ts"]');
    await expect($('[aria-label="Comment text"]')).toBeFocused();
    await browser.keys("Move this review");
    await browser.execute(() => {
      const button = document.querySelector<HTMLButtonElement>(
        '[aria-label="Comment on file src/module-000.ts"]',
      );
      if (!button) throw new Error("File comment button is not rendered");
      button.focus();
      button.click();
    });
    await expect($('[aria-label="Comment text"]')).toBeFocused();
    await browser.keys(" context");
    await clickLineComment(2, "change-deletion");
    await expect($(".comment-composer .comment-location")).toHaveText(
      "Old line 2",
    );
    await expect($('[aria-label="Comment text"]')).toHaveValue(
      "Move this review context",
    );
    await click('.tree-file[title="src/module-001.ts"]');
    await clickInPlace('[aria-label="Comment on file src/module-001.ts"]');
    await expect($(".comment-composer .comment-path")).toHaveText(
      "src/module-001.ts",
    );
    await expect($(".comment-composer .comment-location")).toHaveText(
      "File comment",
    );
    await expect($('[aria-label="Comment text"]')).toHaveValue(
      "Move this review context",
    );
    await expect($('[aria-label="Comment text"]')).toBeFocused();
    await browser.execute(() => {
      const form = document.querySelector<HTMLFormElement>(".comment-composer");
      if (!form) throw new Error("Comment editor is not open");
      form.requestSubmit();
    });
    await $(".comment-composer").waitForExist({ reverse: true });
    const saved: { queues: Record<string, ReviewQueue> } = JSON.parse(
      readFileSync(join(process.env.PEER_DATA_DIR!, "state.json"), "utf8"),
    );
    const comment = Object.values(saved.queues)
      .flatMap((queue) => queue.comments)
      .find((comment) => comment.body === "Move this review context");
    expect(comment?.path).toBe("src/module-001.ts");
    expect(comment?.scope).toBe("file");
    expect(comment?.anchor.line).toBeUndefined();
    expect(comment?.anchor.side).toBeUndefined();
  });

  it("jumps beyond the viewport and saves a one-based line anchor and Reviewed state", async () => {
    await addFileComment("Please explain the value change.");
    await click('button[aria-label="Find in file"]');
    await $('input[aria-label="Go to line"]').setValue("80");
    await browser.keys("Enter");
    await expect($('[aria-label="Comment text"]')).not.toExist();
    await expect($('[aria-label="Comment on selected line"]')).not.toExist();
    await clickLineComment(80, "change-addition");
    await $('[aria-label="Comment text"]').setValue("Can we name this value?");
    await $("button=Add comment").waitForEnabled();
    // Exercise native form submission; the embedded driver's synthetic click
    // does not reliably perform a submit button's default action after reload.
    await browser.execute(() => {
      const form =
        document.querySelector<HTMLFormElement>(".comment-composer")!;
      form.requestSubmit(
        form.querySelector<HTMLButtonElement>(".primary-button")!,
      );
    });
    await expect($(".feedback-title .count")).toHaveText("2");
    await click('.tree-file[title="src/module-000.ts"]');
    await click('[data-file-path="src/module-000.ts"] .review-check input');
    await browser.waitUntil(async () =>
      (await $(".statusbar").getText()).includes("1 reviewed"),
    );
    const saved: { queues: Record<string, ReviewQueue> } = JSON.parse(
      readFileSync(join(process.env.PEER_DATA_DIR!, "state.json"), "utf8"),
    );
    const queue = Object.values(saved.queues).find((q) =>
      q.comments.some((comment) => comment.body === "Can we name this value?"),
    );
    expect(queue).toBeDefined();
    const lineComment = queue!.comments.find(
      (comment) => comment.body === "Can we name this value?",
    );
    const fileComment = queue!.comments.find(
      (comment) => comment.body === "Please explain the value change.",
    );
    expect(lineComment?.anchor.line).toBe(80);
    expect(lineComment?.anchor.side).toBe("new");
    expect(lineComment?.anchor.lineText).toContain("item0_79");
    expect(fileComment).toBeDefined();
    expect(fileComment?.anchor.line).toBeUndefined();
    expect(Object.keys(queue!.reviewed)).toEqual(["src/module-000.ts"]);
    await click("button=Copy comments");
    await expect($(".toast")).toHaveText(expect.stringContaining("copied"));
    const copied = await browser.execute(async () =>
      (window as any).__TAURI__.core.invoke(
        "plugin:clipboard-manager|read_text",
      ),
    );
    const exported = JSON.parse(copied);
    expect(exported).toHaveLength(2);
    expect(exported).toEqual(
      expect.arrayContaining([
        {
          file: "src/module-000.ts",
          comment: "Please explain the value change.",
        },
        {
          file: "src/module-000.ts",
          line: 80,
          comment: "Can we name this value?",
        },
      ]),
    );
    await expect($(".comment-card")).not.toExist();
    await expect($(".feedback-title .count")).toHaveText("0");
    await expect($(".statusbar")).toHaveText(
      expect.stringContaining("1 reviewed"),
    );
    await click('[aria-label="Close search"]');
    await clickInPlace(
      '[data-file-path="src/module-000.ts"] .review-check input',
    );
    await expect($(".statusbar")).toHaveText(
      expect.stringContaining("0 reviewed"),
    );
  });

  for (const view of ["Code", "Changes"] as const) {
    it(`recovers a stale ${view} line draft without silently moving its anchor`, async () => {
      await switchView(view);
      const type = view === "Code" ? "context" : "change-addition";
      await clickLineComment(2, type);
      const body = `Keep this stale ${view} draft`;
      await $('[aria-label="Comment text"]').setValue(body);
      const path = join(process.env.PEER_TEST_REPO!, "src/module-000.ts");
      writeFileSync(
        path,
        `// inserted before the draft\n${readFileSync(path, "utf8")}`,
      );

      await click(".comment-composer .primary-button");
      await expect($(".draft-error [role=alert]")).toBeDisplayed();
      await expect($('[aria-label="Comment text"]')).toHaveValue(body);
      await expect($(".comment-card")).not.toExist();
      await $(".draft-error").$("button=Refresh").click();
      await $('[aria-label="Refresh repository"]').waitForEnabled();
      await browser.waitUntil(() =>
        browser.execute(() =>
          document
            .querySelector('[data-file-path="src/module-000.ts"]')
            ?.closest("diffs-container")
            ?.shadowRoot?.textContent?.includes("inserted before the draft"),
        ),
      );

      // Refresh is not consent to attach the old line number to different code.
      await click(".comment-composer .primary-button");
      await expect($(".comment-composer .primary-button")).toBeEnabled();
      await expect($(".draft-error [role=alert]")).toBeDisplayed();
      await expect($(".comment-composer .comment-location")).toHaveText(
        "line 2",
      );
      await expect($('[aria-label="Comment text"]')).toHaveValue(body);
      await expect($(".comment-card")).not.toExist();
      await browser.saveScreenshot(
        resolve(`test-results/stale-draft-${view}.png`),
      );

      await click('.tree-file[title="src/module-001.ts"]');
      await click("button=Review file");
      await expect($('.tree-file[title="src/module-000.ts"]')).toHaveAttribute(
        "aria-current",
        "true",
      );
      await clickLineComment(3, type);
      await expect($('[aria-label="Comment text"]')).toBeFocused();
      await expect($('[aria-label="Comment text"]')).toHaveValue(body);
      await expect($(".draft-error")).not.toExist();
      await click(".comment-composer .primary-button");
      await $(".comment-composer").waitForExist({ reverse: true });
      await expect($(".comment-card p")).toHaveText(body);
      const saved: { queues: Record<string, ReviewQueue> } = JSON.parse(
        readFileSync(join(process.env.PEER_DATA_DIR!, "state.json"), "utf8"),
      );
      const comments = Object.values(saved.queues).flatMap(
        (queue) => queue.comments,
      );
      expect(comments).toHaveLength(1);
      expect(comments[0].path).toBe("src/module-000.ts");
      expect(comments[0].anchor.line).toBe(3);
      expect(comments[0].anchor.side).toBe(view === "Code" ? undefined : "new");
      expect(comments[0].anchor.lineText).toContain("item0_1");
    });
  }

  it("saves an unchanged draft after refreshing unrelated source changes", async () => {
    await clickLineComment(2, "change-addition");
    const body = "Keep the unchanged anchor";
    await $('[aria-label="Comment text"]').setValue(body);
    appendFileSync(
      join(process.env.PEER_TEST_REPO!, "notes.txt"),
      "\nchanged elsewhere\n",
    );
    await click('[aria-label="Refresh repository"]');
    await $('[aria-label="Refresh repository"]').waitForEnabled();
    await click(".comment-composer .primary-button");
    await $(".comment-composer").waitForExist({ reverse: true });
    await expect($(".comment-card p")).toHaveText(body);
    const saved: { queues: Record<string, ReviewQueue> } = JSON.parse(
      readFileSync(join(process.env.PEER_DATA_DIR!, "state.json"), "utf8"),
    );
    const comment = Object.values(saved.queues).flatMap(
      (queue) => queue.comments,
    )[0];
    expect(comment.path).toBe("src/module-000.ts");
    expect(comment.anchor.line).toBe(2);
    expect(comment.anchor.side).toBe("new");
    expect(comment.anchor.lineText).toContain("item0_1");
  });

  it("keeps a removed file draft recoverable at an explicitly selected file", async () => {
    const path = join(process.env.PEER_TEST_REPO!, "refresh-removed.txt");
    writeFileSync(path, "temporary review source\n");
    await click('[aria-label="Refresh repository"]');
    await $('[aria-label="Refresh repository"]').waitForEnabled();
    await click('.tree-file[title="refresh-removed.txt"]');
    await clickInPlace('[aria-label="Comment on file refresh-removed.txt"]');
    const body = "Keep feedback for the removed file";
    await $('[aria-label="Comment text"]').setValue(body);
    unlinkSync(path);
    await click('[aria-label="Refresh repository"]');
    await $('[aria-label="Refresh repository"]').waitForEnabled();
    await click(".comment-composer .primary-button");
    await expect($(".draft-error [role=alert]")).toBeDisplayed();
    await expect($("button=Review file")).not.toExist();
    await expect($('[aria-label="Comment text"]')).toHaveValue(body);
    await expect($(".comment-card")).not.toExist();
    await click('.tree-file[title="src/module-000.ts"]');
    await clickInPlace('[aria-label="Comment on file src/module-000.ts"]');
    await expect($('[aria-label="Comment text"]')).toHaveValue(body);
    await expect($(".draft-error")).not.toExist();
    await click(".comment-composer .primary-button");
    await $(".comment-composer").waitForExist({ reverse: true });
    await expect($(".comment-card p")).toHaveText(body);
    const saved: { queues: Record<string, ReviewQueue> } = JSON.parse(
      readFileSync(join(process.env.PEER_DATA_DIR!, "state.json"), "utf8"),
    );
    const comment = Object.values(saved.queues).flatMap(
      (queue) => queue.comments,
    )[0];
    expect(comment.path).toBe("src/module-000.ts");
    expect(comment.scope).toBe("file");
    expect(comment.anchor.line).toBeUndefined();
  });

  it("marks saved feedback outdated after refresh and keeps separate Code feedback", async () => {
    await addFileComment("Feedback saved before refresh");
    appendFileSync(
      join(process.env.PEER_TEST_REPO!, "src/module-000.ts"),
      "\n// changed after review\n",
    );
    await click('[aria-label="Refresh repository"]');
    await $(".outdated-tag").waitForExist();
    await switchView("Code");
    await $(".breadcrumb").waitForExist();
    await expect($(".feedback-panel")).toHaveText(
      expect.stringContaining("General code review"),
    );
    await expect($(".comment-card")).not.toExist();
    await switchView("Changes");
    await $(".outdated-tag").waitForExist();
  });

  it("follows diff scrolling in the file navigator without moving focus or jumping back", async () => {
    await click('.tree-file[title="src/module-040.ts"]');
    await $('[data-file-path="src/module-040.ts"]').waitForExist();
    await expect($('.tree-file[title="src/module-040.ts"]')).toHaveAttribute(
      "aria-current",
      "true",
    );
    await browser.waitUntil(async () =>
      browser.execute(
        () =>
          document
            .querySelector('[data-file-path="src/module-040.ts"]')
            ?.closest("diffs-container")
            ?.shadowRoot?.querySelector("[data-code]")
            ?.textContent?.includes("item40_") === true,
      ),
    );
    // Re-selecting the current file must not leave a jump queued for later.
    await click('.tree-file[title="src/module-040.ts"]');
    await click(".tree-folder");
    await expect($(".tree-folder")).toHaveAttribute("aria-expanded", "false");
    await click('[aria-label="Filter files"]');

    const scrollToFile = async (path: string, direction: number) => {
      // Scroll the actual diff container, without clicking a navigation item.
      // Wait for adjacent source to load, then scroll until its sticky header
      // reaches the viewport. A pinned header is not the file's logical start.
      await browser.waitUntil(
        async () =>
          browser.execute(
            (path, direction) => {
              const scroll = document.querySelector<HTMLElement>(".code-view")!;
              const header = Array.from(
                document.querySelectorAll<HTMLElement>("[data-file-path]"),
              ).find((node) => node.dataset.filePath === path);
              if (header) {
                const host = header.closest("diffs-container");
                const index = Number(path.match(/module-(\d+)\.ts$/)?.[1]);
                if (
                  !host?.shadowRoot
                    ?.querySelector("[data-code]")
                    ?.textContent?.includes(`item${index}_`)
                )
                  return false;
                const bounds = header.getBoundingClientRect();
                const top = scroll.getBoundingClientRect().top;
                if (bounds.top <= top + 1 && bounds.bottom > top + 1)
                  return true;
              }
              scroll.scrollTop += direction * 500;
              return false;
            },
            path,
            direction,
          ),
        { timeout: 10000, interval: 100 },
      );
      await expect($(`.tree-file[title="${path}"]`)).toHaveAttribute(
        "aria-current",
        "true",
      );
      await browser.waitUntil(async () =>
        browser.execute(() => {
          const tree = document
            .querySelector(".file-tree")!
            .getBoundingClientRect();
          const active = document
            .querySelector('.tree-file[aria-current="true"]')!
            .getBoundingClientRect();
          return active.top >= tree.top - 1 && active.bottom <= tree.bottom + 1;
        }),
      );
      expect(
        await browser.execute(() =>
          document.activeElement?.getAttribute("aria-label"),
        ),
      ).toBe("Filter files");
    };

    await scrollToFile("src/module-041.ts", 1);
    await expect($(".tree-folder")).toHaveAttribute("aria-expanded", "true");
    await browser.waitUntil(async () => {
      const state = JSON.parse(
        readFileSync(join(process.env.PEER_DATA_DIR!, "state.json"), "utf8"),
      );
      return (
        state.preferences.sessions[state.preferences.lastRepository]
          ?.selectedPath === "src/module-041.ts"
      );
    });
    await scrollToFile("src/module-040.ts", -1);
    // Sidebar clicks still navigate, and the passive selection does not undo it.
    await click('.tree-file[title="src/module-010.ts"]');
    await expect($('.tree-file[title="src/module-010.ts"]')).toHaveAttribute(
      "aria-current",
      "true",
    );
    await $('[data-file-path="src/module-010.ts"]').waitForExist();
  });

  it("measures warm navigation and scrolling in WKWebView", async function () {
    const mode = performanceMode(process.env.PEER_PERFORMANCE_MODE);
    // Keep focused benchmark runs comparable with the full desktop suite.
    await click('[aria-label="Settings"]');
    await click("button*=Dracula");
    await click('[aria-label="Close dialog"]');
    if (
      !(
        await $('[aria-label="Toggle whitespace markers"]').getAttribute(
          "class",
        )
      )
        ?.split(" ")
        .includes("active")
    )
      await click('[aria-label="Toggle whitespace markers"]');
    await click('.tree-file[title="src/module-010.ts"]');
    await $('[data-file-path="src/module-010.ts"]').waitForExist();
    await browser.waitUntil(() =>
      browser.execute(
        () =>
          document
            .querySelector('[data-file-path="src/module-010.ts"]')
            ?.closest("diffs-container")
            ?.shadowRoot?.querySelector("[data-code]")
            ?.textContent?.includes("item10_0") === true,
      ),
    );
    await browser.execute(() => {
      const state = {
        frames: [] as number[],
        navigation: [] as number[],
        done: false,
        error: "",
      };
      Object.assign(window, { __benchmark: state });
      const scroll = document.querySelector(".code-view") as HTMLElement;
      let previous = performance.now(),
        frame = 0,
        nav = 0;
      function navigate() {
        const index = nav % 2 ? 10 : 11;
        const path = `src/module-${String(index).padStart(3, "0")}.ts`;
        const target = document.querySelector<HTMLButtonElement>(
          `.tree-file[title="${path}"]`,
        );
        if (
          !target ||
          target.disabled ||
          target.getAttribute("aria-current") === "true"
        ) {
          state.error = `Navigation target is missing, disabled, or already active: ${path}`;
          state.done = true;
          return;
        }
        const start = performance.now();
        target.click();
        function arrived() {
          const header = document.querySelector<HTMLElement>(
            `[data-file-path="${path}"]`,
          );
          const host = header?.closest("diffs-container");
          const viewport = scroll.getBoundingClientRect();
          const headerBottom =
            header?.getBoundingClientRect().bottom ?? viewport.top;
          return (
            document
              .querySelector(`.tree-file[title="${path}"]`)
              ?.getAttribute("aria-current") === "true" &&
            Array.from(
              host?.shadowRoot?.querySelectorAll<HTMLElement>(
                "[data-line][data-line-type]",
              ) ?? [],
            ).some((line) => {
              const bounds = line.getBoundingClientRect();
              return (
                line.textContent?.includes(`item${index}_0`) &&
                bounds.top >= Math.max(viewport.top, headerBottom) &&
                bounds.bottom <= viewport.bottom &&
                bounds.right > viewport.left &&
                bounds.left < viewport.right
              );
            })
          );
        }
        function waitForSource() {
          if (performance.now() - start > 5000) {
            state.error = `Navigation never displayed the requested source: ${path}`;
            state.done = true;
            return;
          }
          if (!arrived()) {
            requestAnimationFrame(waitForSource);
            return;
          }
          // An active tree item or cached offscreen source is not arrival.
          // Allow the visible source to paint before recording the sample.
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              if (!arrived()) {
                waitForSource();
                return;
              }
              state.navigation.push(performance.now() - start);
              if (++nav < 100) navigate();
              else state.done = true;
            }),
          );
        }
        requestAnimationFrame(waitForSource);
      }
      function tick(time: number) {
        state.frames.push(time - previous);
        previous = time;
        scroll.scrollTop += frame < 60 ? 35 : -35;
        if (++frame < 120) requestAnimationFrame(tick);
        else navigate();
      }
      requestAnimationFrame(tick);
    });
    try {
      await browser.waitUntil(
        () =>
          browser.execute(() => (window as any).__benchmark.frames.length > 2),
        { timeout: 5000, interval: 100 },
      );
    } catch {
      writeFileSync(
        "test-results/performance.json",
        JSON.stringify(
          {
            status: "unmeasured",
            mode,
            reason:
              "WKWebView animation frames are suspended by the host; rerun in an active desktop session.",
            reference: {
              cpu: cpus()[0].model,
              platform: platform(),
              release: release(),
            },
          },
          null,
          2,
        ),
      );
      if (process.env.GITHUB_STEP_SUMMARY)
        appendFileSync(
          process.env.GITHUB_STEP_SUMMARY,
          "\n### Desktop performance\n\nUnmeasured: WKWebView animation frames were suspended. See performance.json.\n",
        );
      if (mode === "enforce")
        throw new Error(
          "Cannot enforce performance budgets: WKWebView animation frames are suspended. Rerun in an active desktop session.",
        );
      this.skip();
    }
    await browser.waitUntil(
      () =>
        browser.execute(() => {
          // Installed by the benchmark setup in this scenario.
          const benchmarkWindow = window as unknown as BenchmarkWindow;
          return benchmarkWindow.__benchmark.done;
        }),
      { timeout: 30000 },
    );
    const metrics = await browser.execute(() => {
      // Installed by the benchmark setup in this scenario.
      const benchmarkWindow = window as unknown as BenchmarkWindow;
      const state = benchmarkWindow.__benchmark;
      if (state.error) throw new Error(state.error);
      if (state.navigation.length !== 100 || state.frames.length !== 120)
        throw new Error(
          "Benchmark ended without all navigation and scrolling samples",
        );
      const frames = state.frames
        .slice(2)
        .sort((a: number, b: number) => a - b);
      const nav = state.navigation
        .slice(2)
        .sort((a: number, b: number) => a - b);
      return {
        scrollP95Ms: frames[Math.floor(frames.length * 0.95)],
        warmNavigationP95Ms: nav[Math.floor(nav.length * 0.95)],
        frames,
        navigation: nav,
      };
    });
    const assessment = assessPerformance(metrics, mode);
    writeFileSync(
      "test-results/performance.json",
      JSON.stringify(
        {
          ...metrics,
          ...assessment,
          reference: {
            cpu: cpus()[0].model,
            platform: platform(),
            release: release(),
          },
          workload: { files: 100, changedLines: 10000 },
        },
        null,
        2,
      ),
    );
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `\n### Desktop performance (${mode})\n\n` +
          `| Metric | Measured p95 | Target |\n| --- | ---: | ---: |\n` +
          `| Scrolling | ${metrics.scrollP95Ms} ms | < 33 ms |\n` +
          `| Warm navigation | ${metrics.warmNavigationP95Ms} ms | < 100 ms |\n\n` +
          `Result: **${assessment.status}**. Full samples and machine details are in performance.json.\n`,
      );
    if (assessment.violations.length)
      console.warn(`Performance ${mode}: ${assessment.violations.join("; ")}`);
    enforcePerformance(assessment);
  });
  it("keeps plain-text layouts consistent through collapse, feedback, and theme updates", async () => {
    await switchView("Code");
    await $(".breadcrumb").waitForExist();
    await click('.tree-file[title="notes.txt"]');
    const readViewer = () =>
      browser.execute(() => {
        const root = document
          .querySelector('[data-file-path="notes.txt"]')
          ?.closest("diffs-container")?.shadowRoot;
        return {
          error: root?.querySelector("[data-error-wrapper]")?.textContent ?? "",
          text: root?.querySelector("[data-code]")?.textContent ?? "",
        };
      });
    await browser.waitUntil(async () =>
      (await readViewer()).text.includes("Plain text line 1"),
    );
    await click('[aria-label="Collapse notes.txt"]');
    expect((await readViewer()).error).toBe("");
    await click('[aria-label="Expand notes.txt"]');
    await browser.waitUntil(async () =>
      (await readViewer()).text.includes("Plain text line 1"),
    );
    expect((await readViewer()).error).toBe("");
    await click('[aria-label="Comment on file notes.txt"]');
    await $('[aria-label="Comment text"]').setValue(
      "Please clarify this plain-text document.",
    );
    await browser.execute(() => {
      const form =
        document.querySelector<HTMLFormElement>(".comment-composer")!;
      form.requestSubmit(
        form.querySelector<HTMLButtonElement>(".primary-button")!,
      );
    });
    await $(".comment-card").waitForExist();
    expect((await readViewer()).error).toBe("");
    for (const theme of ["Dracula", "GitHub Light"]) {
      await click('[aria-label="Settings"]');
      await click(`button*=${theme}`);
      await click('[aria-label="Close dialog"]');
      await browser.waitUntil(async () =>
        (await readViewer()).text.includes("Plain text line 1"),
      );
      expect((await readViewer()).error).toBe("");
    }
    writeFileSync(
      join(process.env.PEER_TEST_REPO!, "notes.txt"),
      "Updated plain text after refresh\n",
    );
    await click('[aria-label="Refresh repository"]');
    await browser.waitUntil(async () =>
      (await readViewer()).text.includes("Updated plain text after refresh"),
    );
    expect((await readViewer()).error).toBe("");
    await $(".outdated-tag").waitForExist();
    await switchView("Changes");
  });

  // Native dragging changes OS window state; run it after scroll measurements.

  it("reloads evicted Code files without losing feedback or an open draft", async () => {
    await switchView("Code");
    await $(".breadcrumb").waitForExist();
    await click('.tree-file[title="src/module-000.ts"]');
    await click('[aria-label="Comment on file src/module-000.ts"]');
    await $('[aria-label="Comment text"]').setValue(
      "Draft survives source eviction",
    );
    for (let i = 1; i <= 20; i++) {
      const path = `src/module-${String(i).padStart(3, "0")}.ts`;
      await click(`.tree-file[title="${path}"]`);
      await browser.waitUntil(async () =>
        browser.execute(
          (path, i) => {
            const host = document
              .querySelector(`[data-file-path="${path}"]`)
              ?.closest("diffs-container");
            return host?.shadowRoot
              ?.querySelector("[data-code]")
              ?.textContent?.includes(`item${i}_0`);
          },
          path,
          i,
        ),
      );
    }
    expect(
      Number(await $(".app").getAttribute("data-loaded-files")),
    ).toBeLessThanOrEqual(8);
    await expect($('[aria-label="Comment text"]')).toHaveValue(
      "Draft survives source eviction",
    );
    await browser.execute(() => {
      const button = Array.from(
        document.querySelectorAll<HTMLButtonElement>("button"),
      ).find((b) => b.textContent === "Add comment")!;
      button.form!.requestSubmit(button);
    });
    await browser.waitUntil(
      () =>
        browser.execute(
          () =>
            !document.querySelector(".comment-composer") &&
            Array.from(
              document.querySelectorAll(".feedback-panel .comment-card p"),
            ).some(
              (node) => node.textContent === "Draft survives source eviction",
            ),
        ),
      {
        timeoutMsg: "Saved eviction comment never appeared as a feedback card",
      },
    );
    await expect($(".error-banner")).not.toExist();
    await click('.tree-file[title="src/module-000.ts"]');
    await browser.waitUntil(
      () =>
        browser.execute(() => {
          const host = document
            .querySelector('[data-file-path="src/module-000.ts"]')
            ?.closest("diffs-container");
          return host?.shadowRoot
            ?.querySelector("[data-code]")
            ?.textContent?.includes("item0_0");
        }),
      {
        timeoutMsg:
          "Evicted module-000 source did not render at its first line",
      },
    );
    await browser.waitUntil(
      () =>
        browser.execute(() => {
          const host = document
            .querySelector('[data-file-path="src/module-000.ts"]')
            ?.closest("diffs-container");
          return Array.from(
            host?.querySelectorAll(".inline-comment p") ?? [],
          ).some(
            (node) => node.textContent === "Draft survives source eviction",
          );
        }),
      {
        timeoutMsg:
          "Reloaded source is visible, but its saved inline comment is missing",
      },
    );
  });

  it("keeps refresh anchored to the visible diff through snapshot expiry and layout changes", async () => {
    const repo = process.env.PEER_TEST_REPO!;
    const target = "refresh-anchor-b.txt";
    const preceding = "refresh-anchor-a.txt";
    const collapsed = "refresh-anchor-0.txt";
    const source = Array.from(
      { length: 180 },
      (_, i) => `anchor line ${i}: ${"wide content ".repeat(30)}\n`,
    ).join("");
    const ready = async (path: string, text: string) => {
      await expect($(`.tree-file[title="${path}"]`)).toHaveAttribute(
        "aria-current",
        "true",
      );
      await browser.waitUntil(async () =>
        browser.execute(
          (path, text) =>
            document
              .querySelector(`[data-file-path="${path}"]`)
              ?.closest("diffs-container")
              ?.shadowRoot?.querySelector("[data-code]")
              ?.textContent?.includes(text) ?? false,
          path,
          text,
        ),
      );
    };
    const viewport = () =>
      browser.execute((path) => {
        const host = document
          .querySelector(`[data-file-path="${path}"]`)
          ?.closest("diffs-container");
        const bounds = document
          .querySelector(".code-view")!
          .getBoundingClientRect();
        const header = host
          ?.querySelector(".file-heading")
          ?.getBoundingClientRect();
        const line = Array.from(
          host?.shadowRoot?.querySelectorAll<HTMLElement>(
            "[data-line][data-line-type]",
          ) ?? [],
        ).find(
          (line) =>
            line.getBoundingClientRect().top >=
              (header?.bottom ?? bounds.top) &&
            line.getBoundingClientRect().bottom < bounds.bottom,
        );
        return {
          text: line?.textContent,
          offset: line ? line.getBoundingClientRect().top - bounds.top : null,
        };
      }, target);
    try {
      writeFileSync(join(repo, target), source);
      writeFileSync(join(repo, preceding), "Before\n".repeat(80));
      writeFileSync(join(repo, collapsed), "Keep collapsed\n".repeat(80));
      if (await $(".breadcrumb").isExisting()) await switchView("Changes");
      await click('[aria-label="Refresh repository"]');
      await $('[aria-label="Refresh repository"]').waitForEnabled();
      await click(`.tree-file[title="${collapsed}"]`);
      await ready(collapsed, "Keep collapsed");
      await clickInPlace(`[aria-label="Collapse ${collapsed}"]`);
      await expect($(`[aria-label="Expand ${collapsed}"]`)).toExist();

      for (let iteration = 0; iteration < 2; iteration++) {
        if (iteration) await click('[aria-label="Toggle diff layout"]');
        await click(`.tree-file[title="${preceding}"]`);
        await ready(preceding, iteration ? "After" : "Before");
        await click(`.tree-file[title="${target}"]`);
        await ready(target, "anchor line");
        if (!(await $('input[aria-label="Go to line"]').isExisting()))
          await click('button[aria-label="Find in file"]');
        await $('input[aria-label="Go to line"]').setValue("100");
        await browser.keys("Enter");
        await browser.waitUntil(() =>
          browser.execute(
            (path) =>
              !!document
                .querySelector(`[data-file-path="${path}"]`)
                ?.closest("diffs-container")
                ?.shadowRoot?.querySelector(
                  '[data-line="100"][data-selected-line]',
                ),
            target,
          ),
        );
        await browser.keys("Escape");
        await browser.execute(() => {
          document.querySelector<HTMLElement>(".code-view")!.scrollTop += 137;
        });
        let before = await viewport();
        expect(before.text).toContain("anchor line");
        writeFileSync(
          join(repo, target),
          "Inserted above\n".repeat((iteration + 1) * 3) + source,
        );
        writeFileSync(
          join(repo, preceding),
          "After\n".repeat((iteration + 1) * 400),
        );
        await clickInPlace(`[data-file-path="${target}"] .review-check input`);
        await expect($(".error-banner")).toHaveText(
          expect.stringContaining("Source changed since this snapshot"),
        );
        // The error banner changes viewport height; capture the location the
        // user actually sees immediately before pressing Refresh.
        before = await viewport();
        await browser.saveScreenshot(
          resolve("test-results/refresh-anchor-before.png"),
        );
        await click('[aria-label="Refresh repository"]');
        await browser.waitUntil(
          async () =>
            (await $(`[data-file-path="${target}"] .add`).getText()) ===
            `+${180 + (iteration + 1) * 3}`,
        );
        await ready(target, "anchor line");
        try {
          await browser.waitUntil(async () => {
            const after = await viewport();
            return (
              after.text === before.text &&
              Math.abs(after.offset! - before.offset!) <= 2
            );
          });
        } catch (error) {
          writeFileSync(
            "test-results/refresh-anchor-state.json",
            JSON.stringify({ before, after: await viewport() }, null, 2),
          );
          await browser.saveScreenshot(
            resolve("test-results/refresh-anchor-after.png"),
          );
          throw error;
        }
        const after = await viewport();
        writeFileSync(
          "test-results/refresh-anchor-state.json",
          JSON.stringify({ before, after }, null, 2),
        );
        expect(Math.abs(after.offset! - before.offset!)).toBeLessThanOrEqual(2);
        await expect($(`.tree-file[title="${target}"]`)).toHaveAttribute(
          "aria-current",
          "true",
        );
        await expect($(".error-banner")).not.toExist();
      }
      await browser.saveScreenshot(resolve("test-results/refresh-anchor.png"));
      await focusApp();
      await browser.waitUntil(
        () => browser.execute(() => document.visibilityState === "visible"),
        {
          timeoutMsg:
            "Unlock the desktop so the native viewer can render scrolling",
        },
      );
      // The embedded driver's synthetic wheel does not scroll by default.
      // Deliver user input to cancel pending restoration, then move the actual
      // scroller without selecting (and therefore expanding) the collapsed file.
      await browser.execute(() => {
        const scroll = document.querySelector<HTMLElement>(".code-view")!;
        scroll.dispatchEvent(
          new WheelEvent("wheel", { deltaY: -100000, bubbles: true }),
        );
        scroll.scrollTop = 0;
      });
      await $(`[data-file-path="${collapsed}"]`).waitForExist();
      await expect($(`[aria-label="Expand ${collapsed}"]`)).toExist();
      // If the viewed diff disappears, select the next surviving file.
      await click(`.tree-file[title="${target}"]`);
      await ready(target, "anchor line");
      unlinkSync(join(repo, target));
      await click('[aria-label="Refresh repository"]');
      await expect($(`.tree-file[title="${target}"]`)).not.toExist();
      await expect($('.tree-file[title="src/module-000.ts"]')).toHaveAttribute(
        "aria-current",
        "true",
      );
      await click('.tree-file[title="src/module-010.ts"]');
      await ready("src/module-010.ts", "item10_");
    } finally {
      for (const path of [target, preceding, collapsed])
        if (existsSync(join(repo, path))) unlinkSync(join(repo, path));
      await click('[aria-label="Refresh repository"]');
      await $('[aria-label="Refresh repository"]').waitForEnabled();
    }
  });

  it("refreshes Code and Changes in one click, including an interrupted snapshot", async () => {
    const repo = process.env.PEER_TEST_REPO!;
    const path = join(repo, "refresh-target.txt");
    const removed = join(repo, "refresh-removed.txt");
    const readSource = () =>
      browser.execute(
        () =>
          document
            .querySelector('[data-file-path="refresh-target.txt"]')
            ?.closest("diffs-container")
            ?.shadowRoot?.querySelector("[data-code]")?.textContent,
      );
    if (!(await $(".breadcrumb").isExisting())) await switchView("Code");
    await $(".breadcrumb").waitForExist();
    await $('[aria-label="Refresh repository"]').waitForEnabled();
    writeFileSync(path, "Before refresh\n");
    writeFileSync(removed, "Remove me\n");
    await click('[aria-label="Refresh repository"]');
    await $('.tree-file[title="refresh-target.txt"]').waitForExist();
    await click('.tree-file[title="refresh-target.txt"]');
    await browser.waitUntil(async () =>
      (await readSource())?.includes("Before refresh"),
    );
    await expect($('.tree-file[title="refresh-target.txt"]')).toHaveAttribute(
      "aria-current",
      "true",
    );
    await expect($(".breadcrumb")).toHaveText(
      expect.stringContaining("refresh-target.txt"),
    );

    writeFileSync(path, "Updated Code content\n");
    unlinkSync(removed);
    writeFileSync(join(repo, "refresh-added.txt"), "Added after opening\n");
    await click('[aria-label="Refresh repository"]');
    await browser.waitUntil(async () =>
      (await readSource())?.includes("Updated Code content"),
    );
    await expect($('.tree-file[title="refresh-removed.txt"]')).not.toExist();
    await expect($('.tree-file[title="refresh-added.txt"]')).toExist();
    await expect($(".error-banner")).not.toExist();

    await switchView("Changes");
    await $(".breadcrumb").waitForExist({ reverse: true });
    await click('.tree-file[title="refresh-target.txt"]');
    await browser.waitUntil(async () =>
      (await readSource())?.includes("Updated Code content"),
    );
    const reviewed =
      '[data-file-path="refresh-target.txt"] .review-check input';
    await clickInPlace(reviewed);
    await browser.waitUntil(() =>
      browser.execute(
        (selector) =>
          document.querySelector<HTMLInputElement>(selector)?.checked === true,
        reviewed,
      ),
    );
    writeFileSync(path, "Changed before requesting refresh\n");
    await clickInPlace(reviewed);
    // A stale review action still offers a refresh without silently changing its source.
    await expect($(".error-banner")).toHaveText(
      expect.stringContaining("Source changed since this snapshot"),
    );

    const wrapper = join(repo, ".git/refresh-git");
    const pending = join(repo, ".git/refresh-pending");
    const git = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const quotedGit = `'${git.replaceAll("'", "'\\''")}'`;
    writeFileSync(
      wrapper,
      `#!/bin/sh
case " $* " in
*' ls-files --stage -z '*)
  if [ -f .git/refresh-pending ]; then
    rm .git/refresh-pending
    printf 'Changed during requested refresh\\n' > refresh-target.txt
    ${quotedGit} add refresh-target.txt
  fi
  ;;
esac
exec ${quotedGit} "$@"
`,
    );
    chmodSync(wrapper, 0o755);
    writeFileSync(pending, "");
    await click('[aria-label="Settings"]');
    await click("button=Git");
    await $('[aria-label="Git executable path"]').setValue(wrapper);
    await click('[aria-label="Close dialog"]');
    try {
      // Exactly one toolbar click must recover from both the old warning and
      // another repository change occurring inside the new snapshot read.
      await click('[aria-label="Refresh repository"]');
      await browser.waitUntil(async () =>
        (await readSource())?.includes("Changed during requested refresh"),
      );
      expect(existsSync(pending)).toBe(false);
      await expect($(".error-banner")).not.toExist();
      await browser.waitUntil(() =>
        browser.execute(
          (selector) =>
            document.querySelector<HTMLInputElement>(selector)?.checked ===
            false,
          reviewed,
        ),
      );
    } finally {
      await click('[aria-label="Settings"]');
      await click("button=Git");
      await $('[aria-label="Git executable path"]').setValue("");
      await click('[aria-label="Close dialog"]');
    }
  });

  it("accepts native dragging from the title bar and app name, excluding buttons", async () => {
    // Exercise Tauri's real drag handler and IPC permissions. Synthetic WebDriver
    // events cannot verify physical movement by the OS window manager.
    const dragHandled = await browser.execute(async () => {
      const handled: boolean[] = [];
      for (const selector of [
        ".titlebar",
        ".app-wordmark span",
        '[aria-label="Settings"]',
      ]) {
        const box = document.querySelector(selector)!.getBoundingClientRect();
        const x =
          selector === ".titlebar" ? box.left + 180 : box.left + box.width / 2;
        const y = box.top + box.height / 2;
        const target = document.elementFromPoint(x, y)!;
        for (const type of ["mousedown", "mouseup"]) {
          const event = new MouseEvent(type, {
            bubbles: true,
            composed: true,
            cancelable: true,
            button: 0,
            detail: 1,
            clientX: x,
            clientY: y,
          });
          target.dispatchEvent(event);
          if (type === "mousedown") handled.push(event.defaultPrevented);
        }
      }
      // Exercise the actual command, so a missing capability rejects the test.
      await (window as any).__TAURI__.window.getCurrentWindow().startDragging();
      return handled;
    });
    expect(dragHandled).toEqual([true, true, false]);
    await click('[aria-label="Settings"]');
    await $(".settings-modal").waitForExist();
    await click('[aria-label="Close dialog"]');
  });
});
