import type { FileDiffMetadata } from "@pierre/diffs";
import type { FileContent } from "./types";
import { recordDiagnostic, recordDiagnosticError } from "./diagnostics";

let worker: Worker | undefined;
let nextId = 0;
let idle: ReturnType<typeof setTimeout> | undefined;
const pending = new Map<
  number,
  { resolve: (diff: FileDiffMetadata) => void; reject: (error: Error) => void }
>();
export function parseDiff(content: FileContent): Promise<FileDiffMetadata> {
  clearTimeout(idle);
  if (!worker) {
    recordDiagnostic("diff.worker.start");
    worker = new Worker(new URL("./diff.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = ({ data }) => {
      const request = pending.get(data.requestId);
      if (!request) return;
      pending.delete(data.requestId);
      if (data.error) {
        recordDiagnosticError("diff.parse.error", data.error, {
          request: data.requestId,
        });
        request.reject(new Error(data.error));
      } else {
        recordDiagnostic("diff.parse.complete", { request: data.requestId });
        request.resolve(data.diff);
      }
      if (pending.size === 0) {
        // Parsing has no reusable grammar/cache. Release its heap after a burst
        // of navigation; the next parse recreates it on demand.
        idle = setTimeout(() => {
          if (pending.size === 0) {
            worker?.terminate();
            worker = undefined;
            recordDiagnostic("diff.worker.idle");
          }
        }, 15000);
      }
    };
    worker.onerror = (event) => {
      recordDiagnosticError("diff.worker.error", event.error ?? event.message, {
        pending: pending.size,
      });
      for (const request of pending.values())
        request.reject(new Error(event.message || "Diff worker failed"));
      pending.clear();
      worker?.terminate();
      worker = undefined;
    };
    worker.onmessageerror = () =>
      recordDiagnostic("diff.worker.messageerror", { pending: pending.size });
  }
  const requestId = nextId++;
  recordDiagnostic("diff.parse.start", { request: requestId });
  return new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject });
    worker!.postMessage({ requestId, content });
  });
}
