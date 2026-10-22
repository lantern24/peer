import { resolve } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { createFixture } from "../../scripts/desktop-fixture.mjs";

// Each invocation uses a disposable repository and app-data directory.
if (!process.env.PEER_DATA_DIR) {
  const fixture = createFixture({
    linesPerFile: process.env.PEER_MEMORY_TEST ? 1000 : 100,
  });
  process.env.PEER_DATA_DIR = fixture.data;
  process.env.PEER_TEST_REPO = fixture.repo;
  process.env.PEER_DRIVER_PORT = String(15000 + (process.pid % 20000));
  mkdirSync("test-results", { recursive: true });
  writeFileSync("test-results/fixture.json", JSON.stringify(fixture, null, 2));
}
export const config = {
  runner: "local",
  specs: [
    ...(process.env.PEER_MEMORY_TEST
      ? ["./memory.spec.ts"]
      : [
          "./review.spec.ts",
          "./sidebars.spec.ts",
          "./shortcuts.spec.ts",
          "./navigation.spec.ts",
          "./repositories.spec.ts",
          "./history.spec.ts",
          "./diagnostics.spec.ts",
          "./repository-watch.spec.ts",
        ]),
  ],
  maxInstances: 1,
  capabilities: [{ browserName: "tauri" }],
  services: [
    [
      "@wdio/tauri-service",
      {
        appBinaryPath: resolve(process.env.APP_BINARY ?? "target/debug/peer"),
        embeddedPort: Number(process.env.PEER_DRIVER_PORT),
        driverProvider: "embedded",
        captureFrontendLogs: true,
        captureBackendLogs: true,
        startTimeout: 60000,
      },
    ],
  ],
  logLevel: "warn",
  outputDir: "test-results/wdio",
  framework: "mocha",
  reporters: ["spec"],
  waitforTimeout: 20000,
  connectionRetryTimeout: 60000,
  connectionRetryCount: 1,
  mochaOpts: {
    timeout: process.env.PEER_MEMORY_TEST ? 600000 : 90000,
  },
  afterTest: async (test, _context, { passed }) => {
    if (!passed) {
      const failureName = `failure-${test.title.replace(/[^a-z0-9]+/gi, "-")}`;
      await browser.saveScreenshot(resolve("test-results/failure.png"));
      await browser.saveScreenshot(resolve(`test-results/${failureName}.png`));
      writeFileSync(
        `test-results/${failureName}-dom.json`,
        JSON.stringify(
          await browser.execute(() =>
            Array.from(document.querySelectorAll("diffs-container"))
              .slice(0, 2)
              .map((e) => ({
                html: e.shadowRoot?.innerHTML.slice(0, 20000),
                attrs: e.outerHTML.slice(0, 500),
                source: e.shadowRoot
                  ?.querySelector("[data-code]")
                  ?.textContent?.slice(0, 2000),
                path: e
                  .querySelector("[data-file-path]")
                  ?.getAttribute("data-file-path"),
                inlineComments: Array.from(
                  e.querySelectorAll(".inline-comment"),
                  (node) => node.textContent,
                ),
              })),
          ),
          null,
          2,
        ),
      );
      writeFileSync(
        `test-results/${failureName}-state.json`,
        JSON.stringify(
          await browser.execute(() => ({
            scrolls: Array.from(
              document.querySelectorAll(".code-view, .code-view > div"),
            ).map((e) => ({
              tag: e.tagName,
              style: e.getAttribute("style"),
              height: e.clientHeight,
              scrollHeight: e.scrollHeight,
              top: e.scrollTop,
            })),
            loaded: document
              .querySelector(".app")
              ?.getAttribute("data-loaded-files"),
            selected: document
              .querySelector(".tree-file.selected")
              ?.getAttribute("title"),
            view: document.querySelector(".view-switch button.active")
              ?.textContent,
            refreshing: document.querySelector<HTMLButtonElement>(
              '[aria-label="Refresh repository"]',
            )?.disabled,
            feedback: Array.from(
              document.querySelectorAll(".comment-card"),
              (node) => node.textContent,
            ),
            draft: document.querySelector<HTMLTextAreaElement>(
              ".comment-composer textarea",
            )?.value,
            error: document.querySelector(".error-banner")?.textContent,
            navigationStatus:
              document.querySelector(".navigation-status")?.textContent,
          })),
          null,
          2,
        ),
      );
    }
  },
};
