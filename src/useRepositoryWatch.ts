import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { RepositoryWatchController } from "./repository-watch";
import type { RepositoryWatchStatus, Snapshot } from "./types";

// Native owns one watch. Keep its command queue across effect reactivation and
// actual App remounts, not just across rerenders of a single hook instance.
const repositoryWatch = new RepositoryWatchController(api);

export function useRepositoryWatch(snapshot: Snapshot | null) {
  const snapshotId = snapshot && !snapshot.commit ? snapshot.id : null;
  const currentSnapshot = useRef(snapshotId);
  currentSnapshot.current = snapshotId;
  const [notice, setNotice] = useState<RepositoryWatchStatus | null>(null);

  useEffect(() => {
    if (!snapshotId) return;
    let canceled = false;
    const watch = repositoryWatch.watch(snapshotId, (status) => {
      if (canceled || currentSnapshot.current !== snapshotId) return;
      setNotice((previous) => {
        if (canceled || currentSnapshot.current !== snapshotId) return previous;
        // Even a same-snapshot effect reactivation cannot dismiss a notice.
        // The controller has already checked the active watch ID and latched
        // initial responses/events, including events arriving before start ends.
        return previous?.snapshotId === snapshotId
          ? {
              ...status,
              changed: previous.changed || status.changed,
              error: previous.error ?? status.error,
            }
          : status;
      });
    });
    const focus = () => watch.check();
    const visibility = () => {
      if (document.visibilityState === "visible") watch.check();
    };
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      canceled = true;
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", visibility);
      watch.stop();
    };
  }, [snapshotId]);

  // Loading and failed refreshes retain the same snapshot and watch. Hide the
  // previous notice only when the displayed snapshot actually changes.
  return notice?.snapshotId === snapshotId ? notice : null;
}
