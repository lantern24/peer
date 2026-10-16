import { afterEach, expect, it, vi } from "vitest";
import {
  DiagnosticLog,
  clearDiagnostics,
  collectDiagnosticReport,
  diagnosticFile,
  recordDiagnosticError,
  registerDiagnosticContext,
} from "./diagnostics";
import { api } from "./api";
import type { Snapshot } from "./types";

const events = (log: DiagnosticLog) =>
  log
    .snapshot()
    .events.map(
      (text) =>
        JSON.parse(text) as { event: string; details: Record<string, string> },
    );

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("retains recent navigation evidence in order and reports discarded events", () => {
  const log = new DiagnosticLog(3, 4096);
  for (const event of ["old", "request", "read", "render"]) log.record(event);
  expect(events(log).map((entry) => entry.event)).toEqual([
    "request",
    "read",
    "render",
  ]);
  expect(log.snapshot().droppedEvents).toBe(1);
  log.clear();
  log.record("new session evidence");
  expect(events(log).map((entry) => entry.event)).toEqual([
    "new session evidence",
  ]);
  expect(log.snapshot().droppedEvents).toBe(0);
});

it("bounds retained UTF-8 bytes rather than string length", () => {
  vi.spyOn(performance, "now").mockReturnValue(0);
  const probe = new DiagnosticLog();
  probe.record("message", { message: "𐐀".repeat(20) });
  const entryBytes =
    new TextEncoder().encode(probe.snapshot().events[0]).length + 1;
  const log = new DiagnosticLog(20, entryBytes * 2 - 1);
  log.record("message", { message: "𐐀".repeat(20) });
  log.record("message", { message: "𐐀".repeat(20) });
  expect(events(log)).toHaveLength(1);
  expect(log.snapshot().droppedEvents).toBe(1);
  expect(
    new TextEncoder().encode(log.snapshot().events.join("\n") + "\n").length,
  ).toBeLessThanOrEqual(entryBytes * 2 - 1);
  log.record("message", { message: "𐐀".repeat(200) });
  expect(events(log)).toHaveLength(1);
  expect(log.snapshot().droppedEvents).toBe(2);
});

it("freezes event fields and truncates oversized error strings without breaking the report", () => {
  const log = new DiagnosticLog();
  const fields = { phase: "capture", stack: "x".repeat(100_000) };
  log.record("failure", fields);
  fields.phase = "mutated";
  const [entry] = events(log);
  expect(entry.details.phase).toBe("capture");
  expect(entry.details.stack).toContain("[truncated]");
  expect(entry.details.stack.length).toBeLessThan(4200);
});

it("identifies files without retaining repository paths, source, or raw IDs in events", () => {
  const snapshot: Snapshot = {
    id: "private snapshot id",
    repository: {
      id: "private repo id",
      root: "/private/repository",
      name: "Private",
      branch: "secret-branch",
      head: null,
    },
    comparison: {
      view: "code",
      mode: "all",
      baseRef: null,
      includeUntracked: true,
    },
    queueId: "private queue",
    baseCommit: null,
    files: ["private-first.ts", "private-second.ts"].map((path) => ({
      id: path,
      path,
      oldPath: null,
      status: "modified",
      kind: "text",
      additions: 1,
      deletions: 1,
      size: 20,
      deferred: false,
    })),
  };
  const first = diagnosticFile(snapshot, snapshot.files[0].id);
  const second = diagnosticFile(snapshot, snapshot.files[1].id);
  expect(first.snapshot).toBe(second.snapshot);
  expect(first.file).toBe(1);
  expect(second.file).toBe(2);
  expect(
    diagnosticFile({ ...snapshot }, snapshot.files[0].id).snapshot,
  ).not.toBe(first.snapshot);
  expect(JSON.stringify([first, second])).not.toContain("private");
  expect(diagnosticFile(snapshot, "unknown").file).toBeNull();
});

it("exports errors despite unavailable runtime/context data without copying rejection payloads", async () => {
  vi.stubGlobal("window", { getSelection: () => null });
  vi.stubGlobal("navigator", { userAgent: "test", platform: "test" });
  vi.stubGlobal("document", {
    hasFocus: () => false,
    visibilityState: "visible",
  });
  vi.stubGlobal("CSS", { supports: () => false });
  vi.spyOn(api, "diagnosticRuntime").mockRejectedValue(
    new Error("Runtime unavailable"),
  );
  clearDiagnostics();
  recordDiagnosticError("file.read.error", {
    code: "readFailed",
    message: "Cannot read file",
    payload: { contents: "PRIVATE_SOURCE", comments: "PRIVATE_COMMENT" },
  });
  const unregister = registerDiagnosticContext("failed-viewer", () => {
    throw new Error("Cannot measure viewer");
  });
  try {
    const report = await collectDiagnosticReport();
    expect(report).toContain("Runtime unavailable");
    expect(report).toContain("Cannot measure viewer");
    expect(report).toContain("Cannot read file");
    expect(report).toContain("readFailed");
    expect(report).not.toContain("PRIVATE_SOURCE");
    expect(report).not.toContain("PRIVATE_COMMENT");
  } finally {
    unregister();
    clearDiagnostics();
  }
});
