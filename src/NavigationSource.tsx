import { forwardRef, useMemo } from "react";
import { Viewer, type ViewerHandle, type LoadedFile } from "./Viewer";
import type {
  NavigationFile,
  Preferences,
  ReviewQueue,
  Snapshot,
} from "./types";
import type { Theme } from "./themes";
import type { SymbolPosition } from "./navigation";
import type { SourceMatch } from "./search";

export const NavigationSource = forwardRef<
  ViewerHandle,
  {
    snapshot: Snapshot;
    file: NavigationFile;
    queue: ReviewQueue;
    onComment: (id: string, line?: number, side?: "old" | "new") => void;
    preferences: Preferences;
    theme: Theme;
    onLoad: () => void;
    onNavigate: (
      position: SymbolPosition,
      operation: "auto" | "references",
    ) => void;
    onError: (message: string) => void;
    findQuery?: string;
    findMatch?: SourceMatch;
  }
>(function NavigationSource(
  {
    snapshot,
    file,
    queue,
    onComment,
    preferences,
    theme,
    onLoad,
    onNavigate,
    onError,
    findQuery,
    findMatch,
  },
  ref,
) {
  const reviewEntry = !file.external
    ? snapshot.files.find(
        (entry) =>
          (file.side === "old" ? (entry.oldPath ?? entry.path) : entry.path) ===
          file.path,
      )
    : undefined;
  const sourceQueue = useMemo<ReviewQueue>(
    () => ({
      reviewed: {},
      // Reconciliation validates this queue against the active snapshot.
      // Adapt only the rendered annotations; saved review anchors stay intact.
      comments: reviewEntry
        ? queue.comments
            .filter(
              (comment) =>
                comment.path === reviewEntry.path &&
                !comment.outdated &&
                (comment.scope === "file" ||
                  snapshot.comparison.view === "code" ||
                  comment.anchor.side === file.side),
            )
            .map((comment) => ({
              ...comment,
              path: file.path,
              anchor: { ...comment.anchor, fingerprint: file.fingerprint },
            }))
        : [],
    }),
    [queue.comments, reviewEntry, snapshot.comparison.view, file],
  );
  const sourceSnapshot = useMemo<Snapshot>(
    () => ({
      ...snapshot,
      comparison: { ...snapshot.comparison, view: "code" },
      files: [
        {
          id: file.documentId,
          path: file.path,
          oldPath: null,
          status: "source",
          kind: file.kind,
          additions: 0,
          deletions: 0,
          size: file.size,
          deferred: file.deferred,
        },
      ],
    }),
    [snapshot, file],
  );
  const loaded = useMemo<Record<string, LoadedFile>>(
    () => ({
      [file.documentId]: {
        content: {
          snapshotId: file.snapshotId,
          fileId: file.documentId,
          path: file.path,
          oldPath: null,
          status: "source",
          kind: file.kind,
          oldContent: null,
          newContent: file.content,
          fingerprint: file.fingerprint,
          tabWidth: file.tabWidth ?? preferences.tabWidth,
          deferred: file.deferred,
          size: file.size,
          metadata: file.label,
        },
      },
    }),
    [file, preferences.tabWidth],
  );
  return (
    <Viewer
      ref={ref}
      snapshot={sourceSnapshot}
      selected={file.documentId}
      loaded={loaded}
      errors={{}}
      queue={sourceQueue}
      preferences={preferences}
      theme={theme}
      onLoad={(_id, force) => {
        if (force) onLoad();
      }}
      onComment={(_id, line) => {
        if (reviewEntry)
          onComment(
            reviewEntry.id,
            line,
            line !== undefined && snapshot.comparison.view === "changes"
              ? file.side
              : undefined,
          );
      }}
      onReviewed={() => {}}
      onScroll={() => {}}
      onActiveFileChange={() => {}}
      onError={onError}
      navigationOnly={!reviewEntry}
      navigationSide={file.side}
      onNavigate={onNavigate}
      findQuery={findQuery}
      findMatch={findMatch}
    />
  );
});
