import { browser, $ } from "@wdio/globals";
import type { Preferences } from "../../src/types";

export async function reloadApp(preferences: Preferences | null = null) {
  await browser.execute((preferences) => {
    // The test build consumes this once, before mounting the replacement app.
    // Saving here would race the outgoing document's debounced autosave.
    if (preferences)
      sessionStorage.setItem(
        "peer:desktop-preferences",
        JSON.stringify(preferences),
      );
    // The marker belongs to this document, not the replacement app. Native
    // element queries avoid an async script callback racing WebKit's unload.
    document.documentElement.setAttribute("data-desktop-reloading", "");
  }, preferences);
  await browser.refresh();
  await $("html:not([data-desktop-reloading]) .app").waitForExist();
  await $('[aria-label="Switch repository"]').waitForEnabled();
}

export async function clickLineComment(
  line: number,
  type: "context" | "change-addition" | "change-deletion",
  path = "src/module-000.ts",
) {
  const selector = `[data-column-number="${line}"][data-line-type="${type}"]`;
  const headerSelector = `[data-file-path="${path}"]`;
  await browser.waitUntil(() =>
    browser.execute(
      (selector, headerSelector) =>
        !!document
          .querySelector(headerSelector)
          ?.closest("diffs-container")
          ?.shadowRoot?.querySelector(selector),
      selector,
      headerSelector,
    ),
  );
  // The embedded driver emits mouse events, not the pointer events used by
  // the renderer. Exercise hover and the full press/release path explicitly.
  await browser.execute(
    async (selector, headerSelector) => {
      const host = document
        .querySelector(headerSelector)
        ?.closest("diffs-container");
      const gutter = host?.shadowRoot?.querySelector(selector);
      if (!gutter) throw new Error("Comment line is not rendered");
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
        throw new Error("Line comment button is not visible");
      const rect = button.getBoundingClientRect();
      const row = gutter.getBoundingClientRect();
      const centerY = rect.top + rect.height / 2;
      if (centerY < row.top || centerY >= row.bottom)
        throw new Error("Line comment button is not on the hovered line");
      const pointer = {
        bubbles: true,
        composed: true,
        cancelable: true,
        pointerType: "mouse",
        pointerId: 1,
        button: 0,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
      };
      // A direct button dispatch bypasses overlays and disabled pointer input.
      // Resolve the real hit target through the renderer's shadow root first.
      let target = document.elementFromPoint(pointer.clientX, pointer.clientY);
      while (target?.shadowRoot) {
        const inner = target.shadowRoot.elementFromPoint(
          pointer.clientX,
          pointer.clientY,
        );
        if (!inner || inner === target) break;
        target = inner;
      }
      if (!target || !button.contains(target))
        throw new Error(
          `Comment button is not hit-testable: ${target?.outerHTML.slice(0, 500)}`,
        );
      const pressed = target.dispatchEvent(
        new PointerEvent("pointerdown", { ...pointer, buttons: 1 }),
      );
      if (pressed) {
        const mousePressed = target.dispatchEvent(
          new MouseEvent("mousedown", { ...pointer, buttons: 1 }),
        );
        // Dispatched events have no native default focus action.
        if (mousePressed) button.focus();
      }
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
      const released = button.getBoundingClientRect();
      if (
        pointer.clientX < released.left ||
        pointer.clientX >= released.right ||
        pointer.clientY < released.top ||
        pointer.clientY >= released.bottom
      )
        throw new Error("Line comment button moved before the click completed");
      target.dispatchEvent(new PointerEvent("pointerup", pointer));
      target.dispatchEvent(new MouseEvent("mouseup", pointer));
      target.dispatchEvent(new MouseEvent("click", pointer));
    },
    selector,
    headerSelector,
  );
}
