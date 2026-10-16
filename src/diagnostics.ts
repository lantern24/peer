import { api } from "./api";
import type { Snapshot } from "./types";

export type DiagnosticFields = Record<
  string,
  string | number | boolean | null | undefined
>;

const MAX_EVENTS = 300;
const MAX_BYTES = 256 * 1024;
const MAX_FIELD_LENGTH = 4096;
const encoder = new TextEncoder();
const bounded = (value: string, limit = MAX_FIELD_LENGTH) =>
  value.length > limit ? `${value.slice(0, limit)} [truncated]` : value;

function boundedFields(fields: DiagnosticFields): DiagnosticFields {
  return Object.fromEntries(
    Object.entries(fields)
      .slice(0, 32)
      .map(([key, value]) => [
        bounded(key, 80),
        typeof value === "string" ? bounded(value) : value,
      ]),
  );
}

// Store serialized values, never caller-owned objects or source/DOM references.
export class DiagnosticLog {
  private entries: { text: string; bytes: number }[] = [];
  private bytes = 0;
  private droppedEvents = 0;
  private sequence = 0;
  private readonly started = performance.now();

  constructor(
    private readonly maxEvents = MAX_EVENTS,
    private readonly maxBytes = MAX_BYTES,
  ) {}

  record(event: string, fields: DiagnosticFields = {}) {
    const text = JSON.stringify({
      sequence: ++this.sequence,
      time: new Date().toISOString(),
      elapsedMs: Math.round(performance.now() - this.started),
      event: bounded(event, 120),
      details: boundedFields(fields),
    });
    const bytes = encoder.encode(text).length + 1;
    if (bytes > this.maxBytes) {
      this.droppedEvents++;
      return;
    }
    while (
      this.entries.length >= this.maxEvents ||
      this.bytes + bytes > this.maxBytes
    ) {
      const oldest = this.entries.shift();
      if (!oldest) break;
      this.bytes -= oldest.bytes;
      this.droppedEvents++;
    }
    this.entries.push({ text, bytes });
    this.bytes += bytes;
  }

  snapshot() {
    return {
      droppedEvents: this.droppedEvents,
      events: this.entries.map((entry) => entry.text),
    };
  }

  clear() {
    this.entries = [];
    this.bytes = 0;
    this.droppedEvents = 0;
  }
}

const log = new DiagnosticLog();
const contexts = new Map<string, () => DiagnosticFields>();
const snapshots = new WeakMap<Snapshot, number>();
let nextSnapshot = 0;

export function diagnosticFile(snapshot: Snapshot | null, id: string | null) {
  if (!snapshot) return { snapshot: null, file: null, view: null };
  let number = snapshots.get(snapshot);
  if (number === undefined) {
    number = ++nextSnapshot;
    snapshots.set(snapshot, number);
  }
  const index =
    id === null ? -1 : snapshot.files.findIndex((file) => file.id === id);
  return {
    snapshot: number,
    file: index < 0 ? null : index + 1,
    view: snapshot.comparison.view,
  };
}

export function recordDiagnostic(event: string, fields?: DiagnosticFields) {
  log.record(event, fields);
}

function errorFields(error: unknown): DiagnosticFields {
  if (error instanceof Error)
    return { name: error.name, message: error.message, stack: error.stack };
  if (typeof error === "string") return { message: error };
  if (error !== null && typeof error === "object") {
    // Native command errors can be plain objects. Never stringify arbitrary
    // rejection payloads: they may contain files, settings, or review comments.
    return {
      message:
        "message" in error && typeof error.message === "string"
          ? error.message
          : "Non-Error rejection (payload omitted)",
      code:
        "code" in error && typeof error.code === "string"
          ? error.code
          : undefined,
      name:
        "name" in error && typeof error.name === "string"
          ? error.name
          : undefined,
      stack:
        "stack" in error && typeof error.stack === "string"
          ? error.stack
          : undefined,
    };
  }
  return { message: String(error) };
}

export function recordDiagnosticError(
  event: string,
  error: unknown,
  fields?: DiagnosticFields,
) {
  recordDiagnostic(event, { ...fields, ...errorFields(error) });
}

export function registerDiagnosticContext(
  name: string,
  collect: () => DiagnosticFields,
) {
  contexts.set(name, collect);
  return () => {
    if (contexts.get(name) === collect) contexts.delete(name);
  };
}

export function clearDiagnostics() {
  log.clear();
  recordDiagnostic("diagnostics.cleared");
}

let uninstall: (() => void) | undefined;
export function installDiagnostics() {
  if (uninstall) return uninstall;
  const error = (event: ErrorEvent) => {
    recordDiagnosticError("window.error", event.error ?? event.message, {
      source: event.filename,
      line: event.lineno,
      column: event.colno,
    });
  };
  const rejection = (event: PromiseRejectionEvent) =>
    recordDiagnosticError("window.unhandledrejection", event.reason);
  const csp = (event: SecurityPolicyViolationEvent) =>
    recordDiagnostic("security.policyViolation", {
      directive: event.effectiveDirective,
      blockedURI: event.blockedURI,
      source: event.sourceFile,
      line: event.lineNumber,
      disposition: event.disposition,
    });
  const visibility = () =>
    recordDiagnostic("window.visibility", { state: document.visibilityState });
  const original = console.error;
  const consoleError = (...args: unknown[]) => {
    recordDiagnosticError(
      "console.error",
      args.find((value) => value instanceof Error) ??
        args.find((value) => typeof value === "string") ??
        "Non-text console error (payload omitted)",
    );
    original.apply(console, args);
  };
  window.addEventListener("error", error);
  window.addEventListener("unhandledrejection", rejection);
  document.addEventListener("securitypolicyviolation", csp);
  document.addEventListener("visibilitychange", visibility);
  console.error = consoleError;
  recordDiagnostic("app.started");
  uninstall = () => {
    window.removeEventListener("error", error);
    window.removeEventListener("unhandledrejection", rejection);
    document.removeEventListener("securitypolicyviolation", csp);
    document.removeEventListener("visibilitychange", visibility);
    if (console.error === consoleError) console.error = original;
    uninstall = undefined;
  };
  return uninstall;
}

export async function collectDiagnosticReport(): Promise<string> {
  let runtime;
  try {
    runtime = await api.diagnosticRuntime();
  } catch (error) {
    runtime = { unavailable: boundedFields(errorFields(error)) };
    recordDiagnosticError("diagnostics.runtime.error", error);
  }
  const browser = {
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio,
    visibility: document.visibilityState,
    focused: document.hasFocus(),
    secureContext: window.isSecureContext,
    composedRanges:
      typeof window.getSelection()?.getComposedRanges === "function",
    constructedStylesheets:
      typeof CSSStyleSheet !== "undefined" &&
      typeof CSSStyleSheet.prototype.replaceSync === "function",
    cssNesting: CSS.supports("selector(&)"),
    cssLightDark: CSS.supports("color", "light-dark(white, black)"),
    webAssembly: typeof WebAssembly !== "undefined",
  };
  const current: Record<string, DiagnosticFields> = {};
  for (const [name, collect] of contexts) {
    try {
      current[name] = boundedFields(collect());
    } catch (error) {
      current[name] = boundedFields(errorFields(error));
    }
  }
  const snapshot = log.snapshot();
  return [
    "Peer diagnostic report — format 1",
    `Generated: ${new Date().toISOString()}`,
    "Memory-only diagnostics; nothing is uploaded automatically.",
    "Source contents and review comments are not deliberately collected. File identifiers are session-local numbers.",
    "Error messages/stacks may contain paths or other sensitive text. Review before sharing.",
    `Retention: latest ${MAX_EVENTS} events, at most ${MAX_BYTES} UTF-8 bytes; ${snapshot.droppedEvents} events dropped.`,
    "",
    "Runtime",
    JSON.stringify(runtime, null, 2),
    "",
    "WebView capabilities",
    JSON.stringify(browser, null, 2),
    "",
    "Current state",
    JSON.stringify(current, null, 2),
    "",
    "Events (one JSON object per line)",
    ...snapshot.events,
    "",
  ].join("\n");
}
