import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RepositoryWatchController } from "./repository-watch";
import type { RepositoryWatchStatus } from "./types";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function deferred<T>() {
  let resolve: ((value: T) => void) | undefined;
  let reject: ((error: unknown) => void) | undefined;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  if (!resolve || !reject) throw new Error("Promise executor did not run");
  return { promise, resolve, reject };
}

function fixture() {
  const listeners: ((status: RepositoryWatchStatus) => void)[] = [];
  const unlisten = vi.fn();
  const backend = {
    listenRepositoryWatch: vi.fn(
      async (
        listener: (status: RepositoryWatchStatus) => void,
      ): Promise<() => void> => {
        listeners.push(listener);
        return unlisten;
      },
    ),
    startRepositoryWatch: vi.fn(
      async (
        snapshotId: string,
        watchId: string,
      ): Promise<RepositoryWatchStatus> => ({
        snapshotId,
        watchId,
        changed: false,
        error: null,
      }),
    ),
    stopRepositoryWatch: vi.fn(async (_watchId: string) => {}),
    checkRepositoryWatch: vi.fn(async (_watchId: string) => {}),
  };
  return {
    backend,
    listeners,
    unlisten,
    controller: new RepositoryWatchController(backend),
  };
}

it("abandons late listener setup without delaying or replacing a StrictMode reactivation", async () => {
  const { backend, controller, listeners, unlisten } = fixture();
  const registration = deferred<() => void>();
  const lateUnlisten = vi.fn();
  backend.listenRepositoryWatch.mockImplementationOnce((listener) => {
    listeners.push(listener);
    return registration.promise;
  });
  const abandoned = vi.fn();
  const first = controller.watch("snapshot-a", abandoned);
  first.stop();
  const publish = vi.fn();
  const second = controller.watch("snapshot-a", publish);
  await vi.runAllTimersAsync();
  expect(backend.startRepositoryWatch).toHaveBeenCalledOnce();
  const [snapshotId, watchId] = backend.startRepositoryWatch.mock.calls[0];

  registration.resolve(lateUnlisten);
  await vi.runAllTimersAsync();
  expect(lateUnlisten).toHaveBeenCalledOnce();
  expect(unlisten).not.toHaveBeenCalled();
  expect(backend.startRepositoryWatch).toHaveBeenCalledOnce();
  expect(backend.stopRepositoryWatch).not.toHaveBeenCalled();
  const event = { snapshotId, watchId, changed: true, error: null };
  listeners[0](event);
  listeners[1](event);
  expect(abandoned).not.toHaveBeenCalled();
  expect(publish).toHaveBeenCalledExactlyOnceWith(event);
  second.stop();
  await vi.runAllTimersAsync();
  expect(backend.stopRepositoryWatch).toHaveBeenCalledExactlyOnceWith(watchId);
});

it("serializes unresolved start, old stop, and the newest start", async () => {
  const { backend, controller, listeners } = fixture();
  const starting = deferred<RepositoryWatchStatus>();
  const stopping = deferred<void>();
  backend.startRepositoryWatch.mockReturnValueOnce(starting.promise);
  backend.stopRepositoryWatch.mockReturnValueOnce(stopping.promise);
  const abandoned = vi.fn();
  const first = controller.watch("snapshot-a", abandoned);
  await vi.runAllTimersAsync();
  const [oldSnapshot, oldWatch] = backend.startRepositoryWatch.mock.calls[0];
  first.stop();
  const publish = vi.fn();
  const second = controller.watch("snapshot-b", publish);
  await vi.runAllTimersAsync();
  expect(backend.startRepositoryWatch).toHaveBeenCalledOnce();
  expect(backend.stopRepositoryWatch).not.toHaveBeenCalled();

  starting.resolve({
    snapshotId: oldSnapshot,
    watchId: oldWatch,
    changed: true,
    error: "Old watch failed",
  });
  await vi.runAllTimersAsync();
  expect(abandoned).not.toHaveBeenCalled();
  expect(publish).not.toHaveBeenCalled();
  expect(backend.stopRepositoryWatch).toHaveBeenCalledExactlyOnceWith(oldWatch);
  expect(backend.startRepositoryWatch).toHaveBeenCalledOnce();

  stopping.resolve();
  await vi.runAllTimersAsync();
  expect(backend.startRepositoryWatch).toHaveBeenCalledTimes(2);
  const [snapshotId, watchId] = backend.startRepositoryWatch.mock.calls[1];
  expect(snapshotId).toBe("snapshot-b");
  expect(watchId).not.toBe(oldWatch);
  const event = { snapshotId, watchId, changed: true, error: null };
  listeners[1](event);
  expect(publish).toHaveBeenCalledExactlyOnceWith(event);
  first.stop();
  await vi.runAllTimersAsync();
  expect(backend.stopRepositoryWatch).toHaveBeenCalledOnce();
  second.stop();
  await vi.runAllTimersAsync();
  expect(backend.stopRepositoryWatch).toHaveBeenLastCalledWith(watchId);
});

it("latches early dirty events and errors against clean initial responses and later events", async () => {
  const { backend, controller, listeners } = fixture();
  const starting = deferred<RepositoryWatchStatus>();
  backend.startRepositoryWatch.mockReturnValueOnce(starting.promise);
  const publish = vi.fn();
  const watch = controller.watch("snapshot-a", publish);
  await vi.runAllTimersAsync();
  const [snapshotId, watchId] = backend.startRepositoryWatch.mock.calls[0];
  const clean = { snapshotId, watchId, changed: false, error: null };
  listeners[0]({ ...clean, changed: true });
  listeners[0](clean);
  starting.resolve(clean);
  await vi.runAllTimersAsync();
  expect(publish).toHaveBeenCalledExactlyOnceWith({ ...clean, changed: true });

  listeners[0]({ ...clean, error: "Watch unavailable" });
  listeners[0]({ ...clean, error: "Later error" });
  listeners[0](clean);
  expect(publish).toHaveBeenCalledTimes(2);
  expect(publish).toHaveBeenLastCalledWith({
    ...clean,
    changed: true,
    error: "Watch unavailable",
  });
  watch.stop();
  await vi.runAllTimersAsync();
});

it("rejects wrong snapshot IDs and old watch IDs even for the same snapshot", async () => {
  const { backend, controller, listeners } = fixture();
  const abandoned = vi.fn();
  const first = controller.watch("snapshot-a", abandoned);
  await vi.runAllTimersAsync();
  const [, oldWatch] = backend.startRepositoryWatch.mock.calls[0];
  first.stop();
  const publish = vi.fn();
  const second = controller.watch("snapshot-a", publish);
  await vi.runAllTimersAsync();
  const [snapshotId, watchId] = backend.startRepositoryWatch.mock.calls[1];
  expect(watchId).not.toBe(oldWatch);
  const event = { snapshotId, watchId, changed: true, error: null };
  listeners[0](event);
  listeners[1]({ ...event, watchId: oldWatch });
  listeners[1]({ ...event, snapshotId: "snapshot-b" });
  expect(abandoned).not.toHaveBeenCalled();
  expect(publish).not.toHaveBeenCalled();
  listeners[1](event);
  expect(publish).toHaveBeenCalledExactlyOnceWith(event);
  second.stop();
  await vi.runAllTimersAsync();
});

it("reports setup failures non-blockingly and keeps the command chain usable", async () => {
  const { backend, controller } = fixture();
  backend.listenRepositoryWatch.mockRejectedValueOnce(new Error("No events"));
  const unavailable = vi.fn();
  const first = controller.watch("snapshot-a", unavailable);
  await vi.runAllTimersAsync();
  expect(unavailable).toHaveBeenCalledWith(
    expect.objectContaining({ snapshotId: "snapshot-a", error: "No events" }),
  );
  expect(backend.startRepositoryWatch).not.toHaveBeenCalled();
  first.stop();

  backend.startRepositoryWatch.mockRejectedValueOnce(new Error("No watcher"));
  const failedStart = vi.fn();
  const second = controller.watch("snapshot-b", failedStart);
  await vi.runAllTimersAsync();
  expect(failedStart).toHaveBeenCalledWith(
    expect.objectContaining({ snapshotId: "snapshot-b", error: "No watcher" }),
  );
  backend.stopRepositoryWatch.mockRejectedValueOnce(new Error("Stop failed"));
  second.stop();
  const publish = vi.fn();
  const third = controller.watch("snapshot-c", publish);
  await vi.runAllTimersAsync();
  expect(backend.startRepositoryWatch).toHaveBeenLastCalledWith(
    "snapshot-c",
    expect.any(String),
  );
  expect(publish).not.toHaveBeenCalled();
  third.stop();
  await vi.runAllTimersAsync();
});

it("checks only the active started watch and ignores superseded check failures", async () => {
  const { backend, controller, listeners } = fixture();
  const starting = deferred<RepositoryWatchStatus>();
  const checking = deferred<void>();
  backend.startRepositoryWatch.mockReturnValueOnce(starting.promise);
  backend.checkRepositoryWatch.mockReturnValueOnce(checking.promise);
  const abandoned = vi.fn();
  const first = controller.watch("snapshot-a", abandoned);
  await vi.runAllTimersAsync();
  const [snapshotId, watchId] = backend.startRepositoryWatch.mock.calls[0];
  first.check();
  await vi.runAllTimersAsync();
  expect(backend.checkRepositoryWatch).not.toHaveBeenCalled();
  starting.resolve({ snapshotId, watchId, changed: false, error: null });
  await vi.runAllTimersAsync();
  expect(backend.checkRepositoryWatch).toHaveBeenCalledExactlyOnceWith(watchId);

  first.stop();
  first.check();
  const publish = vi.fn();
  const second = controller.watch("snapshot-b", publish);
  checking.reject(new Error("Old probe failed"));
  await vi.runAllTimersAsync();
  expect(abandoned).not.toHaveBeenCalled();
  expect(publish).not.toHaveBeenCalled();
  expect(backend.checkRepositoryWatch).toHaveBeenCalledOnce();
  const [nextSnapshot, nextWatch] = backend.startRepositoryWatch.mock.calls[1];
  listeners[1]({
    snapshotId: nextSnapshot,
    watchId: nextWatch,
    changed: true,
    error: null,
  });
  backend.checkRepositoryWatch.mockRejectedValueOnce(new Error("Probe failed"));
  second.check();
  await vi.runAllTimersAsync();
  expect(publish).toHaveBeenLastCalledWith({
    snapshotId: nextSnapshot,
    watchId: nextWatch,
    changed: true,
    error: "Probe failed",
  });
  second.stop();
  await vi.runAllTimersAsync();
});
