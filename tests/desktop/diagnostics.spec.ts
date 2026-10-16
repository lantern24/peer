import { browser, $, expect } from "@wdio/globals";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import type { Preferences } from "../../src/types";
import { reloadApp } from "./app-fixture";

type DriverWindow = Window & {
  __TAURI__: { core: { invoke<T>(command: string): Promise<T> } };
  __TAURI_INTERNALS__: {
    convertFileSrc(path: string, protocol: string): string;
  };
};

const root = mkdtempSync(join(tmpdir(), "peer-diagnostics-"));
const sourcePayload = "PRIVATE_SOURCE_DIAGNOSTIC_SENTINEL";
const commentPayload = "PRIVATE_REVIEW_DIAGNOSTIC_SENTINEL";
let originalPreferences: Preferences;
let scenarioPreferences: Preferences;
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: root, stdio: "pipe" });

async function sourceContains(text: string) {
  await browser.waitUntil(() =>
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

async function switchView(view: "Code" | "Changes") {
  await $('[aria-label="Refresh repository"]').waitForEnabled();
  await $(`button=${view}`).click();
  await browser.waitUntil(() =>
    browser.execute((view) => {
      const refresh = document.querySelector<HTMLButtonElement>(
        '[aria-label="Refresh repository"]',
      );
      return (
        document
          .querySelector(".view-switch button.active")
          ?.textContent?.trim() === view &&
        !!refresh &&
        !refresh.disabled &&
        !document.querySelector(".refresh-overlay")
      );
    }, view),
  );
}

async function openDiagnostics() {
  await $('[aria-label="Settings"]').click();
  await $("button=Diagnostics").click();
  await expect($('.diagnostic-report [role="status"]')).toHaveText(
    "Preview ready.",
  );
}

async function preview() {
  return $(".diagnostic-report textarea").getValue();
}

async function chooseSavePath(path: string | null) {
  await browser.execute((path) => {
    // Tauri's invoke property is immutable. Supply only the native picker's
    // response at the IPC transport; report writes still reach the backend.
    const driver = window as DriverWindow;
    const saveUrl = driver.__TAURI_INTERNALS__.convertFileSrc(
      "plugin:dialog|save",
      "ipc",
    );
    const original = window.fetch;
    window.fetch = (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === saveUrl) {
        window.fetch = original;
        return Promise.resolve(
          new Response(JSON.stringify(path), {
            headers: {
              "Content-Type": "application/json",
              "Tauri-Response": "ok",
            },
          }),
        );
      }
      return original(input, init);
    };
  }, path);
}

describe("User-exportable diagnostics", () => {
  before(async () => {
    git("init", "-b", "main");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.invalid");
    writeFileSync(
      join(root, "first.ts"),
      `export const value = '${sourcePayload}';\n`,
    );
    writeFileSync(join(root, "second.ts"), "export const second = 1;\n");
    git("add", ".");
    git("commit", "-m", "base");
    writeFileSync(
      join(root, "first.ts"),
      `export const value = '${sourcePayload}_changed';\n`,
    );
    originalPreferences = await browser.execute(async () => {
      const driver = window as DriverWindow;
      return (
        await driver.__TAURI__.core.invoke<{ preferences: Preferences }>(
          "bootstrap",
        )
      ).preferences;
    });
    scenarioPreferences = {
      ...originalPreferences,
      lastRepository: root,
      sessions: {},
    };
  });

  beforeEach(async () => {
    writeFileSync(join(root, "second.ts"), "export const second = 1;\n");
    await reloadApp(scenarioPreferences);
    await switchView("Changes");
    await $('.tree-file[title="first.ts"]').click();
    await sourceContains(sourcePayload);
  });

  after(async () => {
    await reloadApp(originalPreferences);
    rmSync(root, { recursive: true, force: true });
  });

  it("previews private-safe navigation evidence and writes exactly that preview", async () => {
    await $('[aria-label="Comment on file first.ts"]').click();
    await $('[aria-label="Comment text"]').setValue(commentPayload);
    await browser.execute(() => {
      const form = document.querySelector<HTMLFormElement>(".comment-composer");
      if (!form) throw new Error("Comment composer missing");
      form.requestSubmit();
    });
    await expect($(".comment-card")).toHaveText(
      expect.stringContaining(commentPayload),
    );
    await switchView("Code");
    await $('.tree-file[title="first.ts"]').click();
    await sourceContains(sourcePayload);
    await openDiagnostics();
    const text = await preview();
    expect(text).not.toContain(sourcePayload);
    expect(text).not.toContain(commentPayload);
    expect(text).toContain("file.read.complete");
    expect(text).toContain("navigation.load.complete");
    const output = join(root, "diagnostics.txt");
    await chooseSavePath(output);
    await $("button=Save report…").click();
    await expect($('.diagnostic-report [role="status"]')).toHaveText(
      "Diagnostic report saved.",
    );
    expect(readFileSync(output, "utf8")).toBe(text);
    expect(await preview()).toBe(text);
  });

  it("preserves the preview on cancellation and a real write failure", async () => {
    await openDiagnostics();
    const text = await preview();
    await chooseSavePath(null);
    await $("button=Save report…").click();
    await expect($('.diagnostic-report [role="status"]')).toHaveText(
      "Save cancelled. Preview unchanged.",
    );
    expect(await preview()).toBe(text);
    // A directory is not a report file: exercise the native write error.
    await chooseSavePath(root);
    await $("button=Save report…").click();
    await expect($('.diagnostic-report [role="alert"]')).toHaveText(
      expect.stringContaining("Could not save report:"),
    );
    await expect($('.diagnostic-report [role="status"]')).not.toHaveText(
      "Diagnostic report saved.",
    );
    expect(await preview()).toBe(text);
    await expect($("button=Save report…")).toBeEnabled();
  });

  it("retains a native failed file read in a refreshable report", async () => {
    await switchView("Code");
    await $('.tree-file[title="second.ts"]').waitForExist();
    rmSync(join(root, "second.ts"));
    await $('.tree-file[title="second.ts"]').click();
    await $(".navigation-status").waitForDisplayed();
    await openDiagnostics();
    expect(await preview()).toContain("file.read.error");
    expect(await preview()).toContain("navigation.load.error");
    await $("button=Clear recorded events").click();
    await expect($('.diagnostic-report [role="status"]')).toHaveText(
      "Recorded events cleared. Preview refreshed.",
    );
    expect(await preview()).not.toContain("file.read.error");
  });
});
