import type { api } from "./api";
import type { RepositoryWatchStatus } from "./types";

type WatchApi = Pick<
  typeof api,
  | "listenRepositoryWatch"
  | "startRepositoryWatch"
  | "stopRepositoryWatch"
  | "checkRepositoryWatch"
>;

export class RepositoryWatchController {
  private commands: Promise<void> = Promise.resolve();
  private stopActive: (() => void) | null = null;

  constructor(private readonly backend: WatchApi) {}

  private enqueue(command: () => Promise<void>): Promise<void> {
    const pending = this.commands.then(command);
    // A failed command must not strand subsequent teardown or setup.
    this.commands = pending.catch(() => {});
    return pending;
  }

  watch(snapshotId: string, onStatus: (status: RepositoryWatchStatus) => void) {
    this.stopActive?.();
    const watchId = crypto.randomUUID();
    let canceled = false;
    let started = false;
    let unlisten: (() => void) | undefined;
    let status: RepositoryWatchStatus = {
      snapshotId,
      watchId,
      changed: false,
      error: null,
    };
    const active = () => !canceled && this.stopActive === stop;
    const merge = (next: RepositoryWatchStatus) => {
      if (
        !active() ||
        next.snapshotId !== snapshotId ||
        next.watchId !== watchId
      )
        return;
      const changed = status.changed || next.changed;
      const error = status.error ?? next.error;
      if (changed === status.changed && error === status.error) return;
      status = { snapshotId, watchId, changed, error };
      onStatus(status);
    };
    const fail = (error: unknown) => {
      merge({
        snapshotId,
        watchId,
        changed: false,
        error: error instanceof Error ? error.message : String(error),
      });
    };
    const stop = () => {
      if (canceled) return;
      canceled = true;
      if (this.stopActive === stop) this.stopActive = null;
      unlisten?.();
      unlisten = undefined;
      // Queue even while start is unresolved. Matching watch IDs make this
      // teardown harmless if native setup failed or the view was superseded.
      void this.enqueue(async () => {
        if (started) await this.backend.stopRepositoryWatch(watchId);
      }).catch(() => {
        // This lifetime has no UI recipient; never route its error to a new view.
      });
    };
    this.stopActive = stop;

    const setup = async () => {
      // Registration is outside the command queue: an abandoned slow listener
      // must not block the next view. Only native start/stop need serialization.
      const registered = await this.backend.listenRepositoryWatch(merge);
      if (!active()) {
        registered();
        return;
      }
      unlisten = registered;
      await this.enqueue(async () => {
        if (!active()) return;
        started = true;
        merge(await this.backend.startRepositoryWatch(snapshotId, watchId));
      });
    };
    void setup().catch(fail);

    return {
      stop,
      check: () => {
        if (!active()) return;
        void this.enqueue(async () => {
          if (active() && started)
            await this.backend.checkRepositoryWatch(watchId);
        }).catch(fail);
      },
    };
  }
}
