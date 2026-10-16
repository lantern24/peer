import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { WorkerPoolContextProvider } from "@pierre/diffs/react";
import HighlightWorker from "@pierre/diffs/worker/worker.js?worker";
import { open, save, confirm } from "@tauri-apps/plugin-dialog";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { listen } from "@tauri-apps/api/event";
import {
  BookOpen,
  Check,
  Code2,
  FileDiff,
  FolderOpen,
  LoaderCircle,
  MessageSquare,
  RefreshCw,
  Search,
  Settings2,
  SplitSquareHorizontal,
  Text,
  X,
  ArrowRight,
  ArrowLeft,
} from "lucide-react";
import appIcon from "../assets/icon.svg";
import { version as appVersion } from "../package.json";
import { api } from "./api";
import {
  defaultComparison,
  defaultPreferences,
  type Comparison,
  type ImportedTheme,
  type Preferences,
  type ReviewComment,
  type ReviewQueue,
  type Snapshot,
} from "./types";
import { applyTheme, builtins, registerThemes, type Theme } from "./themes";
import { parseDiff } from "./parse-diff";
import { Viewer, type LoadedFile, type ViewerHandle } from "./Viewer";
import { FileTree } from "./FileTree";
import { ResizableWorkspace } from "./ResizableWorkspace";
import { Feedback, type Draft } from "./Feedback";
import { Settings, type SettingsTab } from "./Settings";
import { Modal } from "./Modal";
import { QuickOpen } from "./QuickOpen";
import { RepositorySwitcher } from "./RepositorySwitcher";
import { RepositoryLocation } from "./RepositoryLocation";
import { CommitHistory, commitDate } from "./CommitHistory";
import { textMatches, type SourceMatch } from "./search";
import { HighlightCacheBudget } from "./HighlightCacheBudget";
import { SourceCache } from "./memory";
import { retainFile, sourceLines } from "./loaded-file";
import { useNavigation } from "./useNavigation";
import { NavigationSource } from "./NavigationSource";
import { NavigationResults } from "./NavigationResults";
import type { ViewportState } from "./navigation";
import { refreshedViewport } from "./refresh";
import {
  diagnosticFile,
  recordDiagnostic,
  recordDiagnosticError,
  registerDiagnosticContext,
} from "./diagnostics";

const poolOptions = {
  workerFactory: () => {
    recordDiagnostic("highlight.worker.start");
    const worker = new HighlightWorker();
    worker.addEventListener("error", (event) =>
      recordDiagnosticError(
        "highlight.worker.error",
        event.error ?? event.message,
      ),
    );
    worker.addEventListener("messageerror", () =>
      recordDiagnostic("highlight.worker.messageerror"),
    );
    return worker;
  },
  poolSize: 1,
  totalASTLRUCacheSize: 12,
};
const highlighterOptions = {
  useTokenTransformer: true,
  theme: "inspector-github-light",
  preferredHighlighter: "shiki-wasm" as const,
  tokenizeMaxLineLength: 1500,
  maxLineDiffLength: 1500,
  lineDiffType: "word-alt" as const,
};
registerThemes(builtins);
const emptyQueue: ReviewQueue = { comments: [], reviewed: {} };

function limiter(concurrency: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T,>(task: () => Promise<T>): Promise<T> => {
    if (active >= concurrency)
      await new Promise<void>((resolve) => waiting.push(resolve));
    active++;
    try {
      return await task();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}
const limit = limiter(3);

export default function App() {
  const [preferences, setPreferences] =
    useState<Preferences>(defaultPreferences);
  const [imported, setImported] = useState<ImportedTheme[]>([]);
  const [ready, setReady] = useState(false);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<Record<string, LoadedFile>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [queue, setQueue] = useState<ReviewQueue>(emptyQueue);
  const [branches, setBranches] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [settings, setSettings] = useState<SettingsTab | null>(null);
  const [feedback, setFeedback] = useState(true);
  const [deleteAfterCopy, setDeleteAfterCopy] = useState(true);
  const [drafts, setDrafts] = useState<Record<string, Draft | undefined>>({});
  const [commentFocusRequest, setCommentFocusRequest] = useState(0);
  const [quickOpen, setQuickOpen] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [repositoryToUpdate, setRepositoryToUpdate] = useState<string | null>(
    null,
  );
  const findFocus = useRef("Find in file");
  const [findText, setFindText] = useState("");
  const [matchIndex, setMatchIndex] = useState(0);
  const [lineInput, setLineInput] = useState("");
  const [exportText, setExportText] = useState<string | null>(null);
  const [navigationSide, setNavigationSide] = useState<"old" | "new">("new");
  const [systemDark, setSystemDark] = useState(
    matchMedia("(prefers-color-scheme: dark)").matches,
  );
  const viewer = useRef<ViewerHandle>(null);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const loadedRef = useRef(loaded);
  loadedRef.current = loaded;
  const codeCache = useRef(new SourceCache<LoadedFile>(8 * 1024 * 1024, 8));
  const preferencesRef = useRef(preferences);
  preferencesRef.current = preferences;
  const selectionRef = useRef(selected);
  selectionRef.current = selected;
  const requests = useRef(new Map<string, Promise<LoadedFile>>());
  const opening = useRef(0);
  const commentRequest = useRef(0);
  const prefWrites = useRef(Promise.resolve());
  const scrollTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const lastChanges = useRef<Comparison>(defaultComparison);
  const scrollToRestore = useRef<number | null>(null);
  const refreshToRestore = useRef<{
    snapshotId: string;
    state: ViewportState;
    started: boolean;
  } | null>(null);

  const reportError = useCallback((error: unknown) => {
    recordDiagnosticError("app.error", error);
    setError(error instanceof Error ? error.message : String(error));
  }, []);
  const notify = useCallback((text: string) => {
    setMessage(text);
  }, []);
  useEffect(() => {
    if (message) {
      const timer = setTimeout(() => setMessage(""), 3500);
      return () => clearTimeout(timer);
    }
  }, [message]);
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const listener = () => setSystemDark(media.matches);
    media.addEventListener("change", listener);
    return () => media.removeEventListener("change", listener);
  }, []);
  const themes = useMemo<Theme[]>(() => {
    const themes = [...builtins, ...imported];
    registerThemes(themes);
    return themes;
  }, [imported]);
  const dark =
    preferences.appearance.mode === "system"
      ? systemDark
      : preferences.appearance.mode === "dark";
  const theme =
    themes.find(
      (t) =>
        t.id ===
        (dark
          ? preferences.appearance.darkTheme
          : preferences.appearance.lightTheme),
    ) ?? builtins[dark ? 1 : 0];
  useEffect(() => applyTheme(theme), [theme]);

  const openRepository = useCallback(
    async (
      path: string,
      comparison: Comparison | null = null,
      previousPath?: string,
    ) => {
      const request = ++opening.current;
      recordDiagnostic("repository.open.request", {
        request,
        view: comparison?.view,
        mode: comparison?.mode,
        relocating: previousPath !== undefined,
      });
      const previous = snapshotRef.current;
      const oldPath = previous?.files.find(
        (f) => f.id === selectionRef.current,
      )?.path;
      const previousScroll = viewer.current?.scrollTop() ?? 0;
      const previousViewport = viewer.current?.capture();
      if (scrollTimer.current) clearTimeout(scrollTimer.current);
      // Capture the outgoing session before a fast switch can cancel the
      // debounced scroll save. The destination uses its own saved session.
      if (previous && previous.repository.root !== path) {
        const nextPreferences = {
          ...preferencesRef.current,
          sessions: {
            ...preferencesRef.current.sessions,
            [previous.repository.root]: {
              comparison: previous.comparison,
              lastChanges: lastChanges.current,
              selectedPath: oldPath ?? null,
              scrollTop: previousScroll,
            },
          },
        };
        preferencesRef.current = nextPreferences;
        setPreferences(nextPreferences);
      }
      setBusy(true);
      setError("");
      try {
        await prefWrites.current;
        await api.savePreferences(preferencesRef.current);
        recordDiagnostic("repository.open.start", { request });
        const next = previousPath
          ? await api.relocate(previousPath, path)
          : await api.open(path, comparison);
        recordDiagnostic("repository.open.complete", {
          request,
          ...diagnosticFile(next, null),
          files: next.files.length,
        });
        const [nextQueue, nextBranches] = await Promise.all([
          api.queue(next.id),
          api.branches(next.id),
        ]);
        if (request !== opening.current) return;
        snapshotRef.current = next;
        loadedRef.current = {};
        codeCache.current.clear();
        setLoaded({});
        setErrors({});
        setSnapshot(next);
        setQueue(nextQueue);
        setBranches(nextBranches);
        const stored =
          preferencesRef.current.sessions[previousPath ?? next.repository.root];
        const wantedPath =
          previous?.repository.root === (previousPath ?? next.repository.root)
            ? oldPath
            : stored?.selectedPath;
        const viewport =
          previous &&
          previousViewport &&
          previous.repository.root === (previousPath ?? next.repository.root) &&
          JSON.stringify(previous.comparison) ===
            JSON.stringify(next.comparison)
            ? refreshedViewport(previousViewport, previous.files, next.files)
            : null;
        const nextSelected =
          viewport?.anchor?.id ??
          next.files.find((f) => f.path === wantedPath)?.id ??
          next.files[0]?.id ??
          null;
        setSelected(nextSelected);
        selectionRef.current = nextSelected;
        refreshToRestore.current = viewport
          ? { snapshotId: next.id, state: viewport, started: false }
          : null;
        lastChanges.current =
          next.comparison.view === "changes"
            ? next.comparison
            : (stored?.lastChanges ?? defaultComparison);
        scrollToRestore.current = viewport
          ? null
          : previous?.queueId === next.queueId
            ? previousScroll
            : next.commit && previous?.commit?.id !== next.commit.id
              ? 0
              : stored?.comparison.view === next.comparison.view
                ? stored.scrollTop
                : 0;
        const nextPreferences = { ...preferencesRef.current };
        const sessions = { ...nextPreferences.sessions };
        if (previousPath && previousPath !== next.repository.root)
          delete sessions[previousPath];
        sessions[next.repository.root] = {
          comparison: next.comparison,
          lastChanges: lastChanges.current,
          selectedPath:
            next.files.find((f) => f.id === nextSelected)?.path ?? null,
          scrollTop: viewport?.top ?? scrollToRestore.current ?? 0,
        };
        nextPreferences.lastRepository = next.repository.root;
        nextPreferences.recentRepositories = [
          next.repository.root,
          ...nextPreferences.recentRepositories.filter(
            (v) => v !== next.repository.root && v !== previousPath,
          ),
        ].slice(0, 12);
        nextPreferences.sessions = sessions;
        preferencesRef.current = nextPreferences;
        setPreferences(nextPreferences);
      } catch (e) {
        recordDiagnosticError("repository.open.error", e, { request });
        if (previousPath) throw e;
        if (request === opening.current) reportError(e);
      } finally {
        if (request === opening.current) setBusy(false);
      }
    },
    [reportError],
  );

  useEffect(() => {
    let active = true;
    recordDiagnostic("bootstrap.start");
    api
      .bootstrap()
      .then((data) => {
        if (!active) return;
        recordDiagnostic("bootstrap.complete");
        preferencesRef.current = data.preferences;
        setPreferences(data.preferences);
        setImported(data.themes);
        setReady(true);
        if (data.preferences.lastRepository)
          void openRepository(data.preferences.lastRepository, null);
      })
      .catch((e) => {
        reportError(e);
        setReady(true);
      });
    return () => {
      active = false;
    };
  }, [openRepository, reportError]);
  useEffect(() => {
    if (!ready || busy) return;
    const timer = setTimeout(() => {
      prefWrites.current = prefWrites.current
        .then(() => api.savePreferences(preferences))
        .catch(reportError);
    }, 250);
    return () => clearTimeout(timer);
  }, [preferences, ready, busy, reportError]);

  const loadFile = useCallback(
    async (id: string, force = false): Promise<LoadedFile> => {
      const active = snapshotRef.current;
      if (!active) throw new Error("Open a repository first");
      const cached =
        active.comparison.view === "code"
          ? codeCache.current.get(id)
          : loadedRef.current[id];
      const target = diagnosticFile(active, id);
      if (cached && (!cached.content.deferred || !force)) {
        recordDiagnostic("file.cache.hit", target);
        return cached;
      }
      const entry = active.files.find((f) => f.id === id);
      if (!entry) throw new Error("File not found");
      const key = `${active.id}:${id}:${force}`;
      const pending = requests.current.get(key);
      if (pending) {
        recordDiagnostic("file.read.shared", target);
        return pending;
      }
      const work = limit(async () => {
        if (snapshotRef.current?.id !== active.id)
          throw new Error("Repository view changed");
        let stage = "read";
        try {
          recordDiagnostic("file.read.start", { ...target, force });
          const content = await api.read(active.id, id, force);
          recordDiagnostic("file.read.complete", {
            ...target,
            bytes: content.size,
            kind: content.kind,
            deferred: content.deferred,
          });
          const needsDiff =
            active.comparison.view === "changes" &&
            !content.deferred &&
            (content.oldContent !== null || content.newContent !== null);
          stage = "parse";
          if (needsDiff) recordDiagnostic("file.parse.start", target);
          const diff = needsDiff ? await parseDiff(content) : undefined;
          if (needsDiff) recordDiagnostic("file.parse.complete", target);
          stage = "retain";
          const value = retainFile(content, diff);
          if (snapshotRef.current?.id === active.id) {
            loadedRef.current =
              active.comparison.view === "code"
                ? codeCache.current.set(
                    id,
                    value,
                    new Set([selectionRef.current ?? id]),
                  )
                : { ...loadedRef.current, [id]: value };
            setLoaded(loadedRef.current);
            setErrors((previous) => {
              const next = { ...previous };
              delete next[id];
              return next;
            });
          }
          return value;
        } catch (e) {
          recordDiagnosticError(`file.${stage}.error`, e, target);
          if (snapshotRef.current?.id === active.id)
            setErrors((prev) => ({ ...prev, [id]: String(e) }));
          throw e;
        } finally {
          requests.current.delete(key);
        }
      });
      requests.current.set(key, work);
      return work;
    },
    [],
  );
  const requestFile = useCallback(
    (id: string, force = false) => {
      void loadFile(id, force).catch(() => {});
    },
    [loadFile],
  );
  const saveScroll = useCallback((top: number) => {
    if (scrollTimer.current) clearTimeout(scrollTimer.current);
    if (refreshToRestore.current || scrollToRestore.current !== null) return;
    const s = snapshotRef.current;
    scrollTimer.current = setTimeout(() => {
      if (!s || s.id !== snapshotRef.current?.id || refreshToRestore.current)
        return;
      setPreferences((p) => ({
        ...p,
        sessions: {
          ...p.sessions,
          [s.repository.root]: {
            comparison: s.comparison,
            lastChanges: lastChanges.current,
            selectedPath:
              s.files.find((f) => f.id === selectionRef.current)?.path ?? null,
            scrollTop: top,
          },
        },
      }));
    }, 600);
  }, []);
  useEffect(() => {
    if (snapshot && selected)
      requestFile(
        selected,
        refreshToRestore.current?.state.manuallyLoaded?.includes(selected),
      );
  }, [snapshot, selected, requestFile]);
  useEffect(() => {
    const pending = refreshToRestore.current;
    if (
      pending &&
      !pending.started &&
      pending.snapshotId === snapshot?.id &&
      selected &&
      (loaded[selected] || errors[selected]) &&
      viewer.current
    ) {
      pending.started = true;
      viewer.current.restoreState(pending.state, () => {
        if (refreshToRestore.current === pending) {
          refreshToRestore.current = null;
          saveScroll(viewer.current?.scrollTop() ?? 0);
        }
      });
      return;
    }
    if (selected && loaded[selected] && scrollToRestore.current !== null) {
      const top = scrollToRestore.current;
      scrollToRestore.current = null;
      queueMicrotask(() => viewer.current?.restore(top));
    }
  }, [loaded, errors, selected, snapshot, saveScroll]);
  const followVisibleFile = useCallback((snapshotId: string, id: string) => {
    // Restoration and explicit navigation own their scroll positions. Passive
    // selection updates must not call selectFile, which would scroll again.
    if (
      snapshotRef.current?.id !== snapshotId ||
      scrollToRestore.current !== null ||
      refreshToRestore.current !== null ||
      selectionRef.current === id
    )
      return;
    selectionRef.current = id;
    setSelected(id);
    setMatchIndex(0);
  }, []);
  const pickRepository = useCallback(async () => {
    try {
      const path = await open({
        directory: true,
        multiple: false,
        title: "Open a Git repository",
      });
      if (typeof path === "string") await openRepository(path);
    } catch (e) {
      reportError(e);
    }
  }, [openRepository, reportError]);
  const removeRepository = useCallback(
    async (path: string) => {
      setBusy(true);
      setError("");
      clearTimeout(scrollTimer.current);
      try {
        const next = {
          ...preferencesRef.current,
          recentRepositories: preferencesRef.current.recentRepositories.filter(
            (value) => value !== path,
          ),
          lastRepository:
            preferencesRef.current.lastRepository === path
              ? null
              : preferencesRef.current.lastRepository,
        };
        await prefWrites.current;
        await api.savePreferences(next);
        preferencesRef.current = next;
        setPreferences(next);
        if (snapshotRef.current?.repository.root === path) {
          ++opening.current;
          snapshotRef.current = null;
          loadedRef.current = {};
          selectionRef.current = null;
          codeCache.current.clear();
          scrollToRestore.current = null;
          refreshToRestore.current = null;
          setSnapshot(null);
          setSelected(null);
          setLoaded({});
          setErrors({});
          setQueue(emptyQueue);
          setBranches([]);
          setQuickOpen(false);
          setFindOpen(false);
        }
        notify("Repository removed from the list. Files were not changed.");
      } catch (e) {
        reportError(e);
      } finally {
        setBusy(false);
      }
    },
    [notify, reportError],
  );
  const refresh = useCallback(() => {
    const s = snapshotRef.current;
    if (s) void openRepository(s.repository.root, s.comparison);
  }, [openRepository]);
  const changeComparison = useCallback(
    (comparison: Comparison) => {
      const s = snapshotRef.current;
      if (s) void openRepository(s.repository.root, comparison);
    },
    [openRepository],
  );
  const activateFile = useCallback((id: string) => {
    scrollToRestore.current = null;
    refreshToRestore.current = null;
    const changedFile = selectionRef.current !== id;
    setSelected(id);
    selectionRef.current = id;
    if (changedFile) setMatchIndex(0);
    const s = snapshotRef.current;
    if (s)
      setPreferences((p) => ({
        ...p,
        sessions: {
          ...p.sessions,
          [s.repository.root]: {
            comparison: s.comparison,
            lastChanges: lastChanges.current,
            selectedPath: s.files.find((f) => f.id === id)?.path ?? null,
            scrollTop: 0,
          },
        },
      }));
  }, []);
  const navigation = useNavigation({
    snapshot,
    selected,
    viewer,
    loadFile,
    activateFile,
    navigationSide,
    setNavigationSide,
  });
  useEffect(
    () =>
      registerDiagnosticContext("app", () => ({
        ...diagnosticFile(snapshotRef.current, selectionRef.current),
        ready,
        busy,
        fileCount: snapshotRef.current?.files.length ?? 0,
        loadedFiles: Object.keys(loadedRef.current).length,
        pendingReads: requests.current.size,
        fileErrors: Object.keys(errors).length,
        sourcePage: navigation.page !== null,
        diffLayout: preferences.diffLayout,
        codeFontSize: preferences.codeFontSize,
        showWhitespace: preferences.showWhitespace,
      })),
    [
      ready,
      busy,
      errors,
      navigation.page,
      preferences.diffLayout,
      preferences.codeFontSize,
      preferences.showWhitespace,
    ],
  );
  const selectFile = navigation.review;
  const focusFind = useCallback(() => {
    document
      .querySelector<HTMLInputElement>(
        `input[aria-label="${findFocus.current}"]`,
      )
      ?.focus();
  }, []);
  const openFind = useCallback(
    (field: "Find in file" | "Go to line") => {
      findFocus.current = field;
      setFindOpen(true);
      // The field may already be mounted; otherwise the effect focuses it after commit.
      queueMicrotask(focusFind);
    },
    [focusFind],
  );
  useEffect(() => {
    if (findOpen) focusFind();
  }, [findOpen, focusFind]);

  useEffect(() => {
    const menu = listen<string>("app-menu", ({ payload }) => {
      if (payload === "open") void pickRepository();
      if (payload === "settings") setSettings("appearance");
      if (payload === "refresh") refresh();
    });
    const keys = (e: KeyboardEvent) => {
      if (e.defaultPrevented || document.querySelector("dialog[open]")) return;
      if (e.key === "Escape" && !e.isComposing) {
        setFindOpen(false);
        return;
      }
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key.toLowerCase() === "p") {
        e.preventDefault();
        setQuickOpen(true);
      }
      if (e.key.toLowerCase() === "f") {
        e.preventDefault();
        openFind("Find in file");
      }
      if (e.key.toLowerCase() === "g") {
        e.preventDefault();
        openFind("Go to line");
      }
    };
    window.addEventListener("keydown", keys);
    return () => {
      void menu.then((unlisten) => unlisten());
      window.removeEventListener("keydown", keys);
    };
  }, [pickRepository, refresh, openFind]);

  const reloadQueue = useCallback(async () => {
    const s = snapshotRef.current;
    if (!s) return;
    const next = await api.queue(s.id);
    if (snapshotRef.current?.id === s.id) setQueue(next);
  }, []);
  const beginComment = useCallback(
    async (id: string, line?: number, side?: "old" | "new") => {
      const s = snapshotRef.current;
      if (!s) return;
      setFeedback(true);
      const request = ++commentRequest.current;
      try {
        const { content } = await loadFile(id, true);
        if (
          snapshotRef.current?.id !== s.id ||
          request !== commentRequest.current
        )
          return;
        setDrafts((prev) => ({
          ...prev,
          [s.queueId]: {
            fileId: id,
            snapshotId: s.id,
            fingerprint: content.fingerprint,
            path: content.path,
            line,
            side,
            body: prev[s.queueId]?.body ?? "",
          },
        }));
        setCommentFocusRequest(request);
      } catch (e) {
        if (
          snapshotRef.current?.id === s.id &&
          request === commentRequest.current
        )
          reportError(e);
      }
    },
    [loadFile, reportError],
  );
  const submitComment = useCallback(async () => {
    const s = snapshotRef.current;
    if (!s) return;
    const draft = drafts[s.queueId];
    if (!draft?.body.trim()) return;
    ++commentRequest.current;
    setSaving(true);
    try {
      let source = { snapshotId: draft.snapshotId, fileId: draft.fileId };
      if (draft.snapshotId !== s.id) {
        const entry = s.files.find((file) => file.path === draft.path);
        if (!entry)
          throw new Error(
            "This file is no longer in the current view. Your draft has been kept.",
          );
        const { content } = await loadFile(entry.id, true);
        if (content.fingerprint !== draft.fingerprint)
          throw new Error(
            "The file changed since this draft was started. Your draft has been kept; review the file before starting a new comment.",
          );
        source = { snapshotId: s.id, fileId: entry.id };
      }
      await api.comment({
        ...draft,
        ...source,
        body: draft.body,
        line: draft.line ?? null,
        side: draft.side ?? null,
      });
      setDrafts((prev) =>
        prev[s.queueId] === draft ? { ...prev, [s.queueId]: undefined } : prev,
      );
      await reloadQueue();
      notify("Comment saved");
    } catch (e) {
      reportError(e);
    } finally {
      setSaving(false);
    }
  }, [drafts, loadFile, reloadQueue, notify, reportError]);
  const markReviewed = useCallback(
    async (id: string, checked: boolean) => {
      const s = snapshotRef.current;
      if (!s) return;
      try {
        const value = await loadFile(id, true);
        await api.reviewed(s.id, id, value.content.fingerprint, checked);
        await reloadQueue();
      } catch (e) {
        reportError(e);
      }
    },
    [loadFile, reloadQueue, reportError],
  );
  const jumpToComment = useCallback(
    (comment: ReviewComment) => {
      const file = snapshotRef.current?.files.find(
        (f) => f.path === comment.path,
      );
      if (!file || comment.outdated) {
        notify(
          "This comment retains its original location. Review its saved code context below.",
        );
        return;
      }
      void navigation.review(file.id, comment.anchor.line, comment.anchor.side);
    },
    [notify, navigation.review],
  );
  const copyFeedback = async () => {
    if (!snapshot) return;
    try {
      const json = await api.export(snapshot.id);
      try {
        await writeText(json);
      } catch {
        setExportText(json);
        return;
      }
      if (deleteAfterCopy) {
        // Keep comments added while the clipboard write was in flight.
        for (const comment of queue.comments)
          await api.deleteComments(snapshot.queueId, comment.id);
        await reloadQueue();
      }
      notify(
        deleteAfterCopy ? "Comments copied and deleted" : "Comments copied",
      );
    } catch (e) {
      reportError(e);
    }
  };
  const saveFeedback = async () => {
    if (!snapshot) return;
    try {
      const path = await save({
        defaultPath: `${snapshot.repository.name}-review.json`,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (path) {
        await api.saveExport(snapshot.id, path);
        notify("Feedback saved");
      }
    } catch (e) {
      reportError(e);
    }
  };
  const clearFeedback = async () => {
    if (!snapshot) return;
    try {
      if (
        await confirm(
          `Delete all ${queue.comments.length} comments in this review? Other review queues are kept.`,
          {
            title: "Clear feedback",
            kind: "warning",
            okLabel: "Clear comments",
          },
        )
      ) {
        await api.deleteComments(snapshot.queueId);
        await reloadQueue();
      }
    } catch (e) {
      reportError(e);
    }
  };
  const importTheme = async () => {
    try {
      const path = await open({
        title: "Import VS Code color theme",
        filters: [{ name: "Color theme", extensions: ["json", "jsonc"] }],
      });
      if (typeof path === "string") {
        const theme = await api.importTheme(path);
        setImported((current) => [
          ...current.filter((t) => t.id !== theme.id),
          theme,
        ]);
        setPreferences((p) => ({
          ...p,
          appearance: {
            ...p.appearance,
            mode: theme.kind,
            [theme.kind === "light" ? "lightTheme" : "darkTheme"]: theme.id,
          },
        }));
        notify(`Imported ${theme.name}`);
      }
    } catch (e) {
      reportError(e);
    }
  };
  const removeTheme = async (id: string) => {
    try {
      await api.removeTheme(id);
      setImported((current) => current.filter((t) => t.id !== id));
      setPreferences((p) => ({
        ...p,
        appearance: {
          ...p.appearance,
          lightTheme:
            p.appearance.lightTheme === id
              ? "github-light"
              : p.appearance.lightTheme,
          darkTheme:
            p.appearance.darkTheme === id
              ? "github-dark"
              : p.appearance.darkTheme,
        },
      }));
    } catch (e) {
      reportError(e);
    }
  };

  const selectedEntry = snapshot?.files.find((f) => f.id === selected);
  const selectedFile = selected ? loaded[selected] : undefined;
  const matches = useMemo(() => {
    if (navigation.file)
      return (navigation.file.content ?? "").split("\n").flatMap((line, i) =>
        textMatches(line, findText).map((match) => ({
          ...match,
          line: i + 1,
          side: navigation.file!.side,
        })),
      );
    if (!findText || !selectedFile) return [];
    const results: SourceMatch[] = [];
    for (const side of (snapshot?.comparison.view === "changes"
      ? ["new", "old"]
      : ["new"]) as ("old" | "new")[]) {
      sourceLines(selectedFile, side).forEach((line, i) => {
        for (const match of textMatches(line, findText))
          results.push({ ...match, line: i + 1, side });
      });
    }
    return results;
  }, [findText, selectedFile, snapshot?.comparison.view, navigation.file]);
  const jumpMatch = (index: number) => {
    if (!selected || !matches.length) return;
    const i =
      matchIndex < 0 && index < 0
        ? matches.length - 1
        : ((index % matches.length) + matches.length) % matches.length;
    setMatchIndex(i);
    const match = matches[i];
    navigation.jump(match.line, match.side);
  };
  const totalAdds =
    snapshot?.files.reduce((sum, file) => sum + file.additions, 0) ?? 0;
  const totalDeletes =
    snapshot?.files.reduce((sum, file) => sum + file.deletions, 0) ?? 0;

  return (
    <WorkerPoolContextProvider
      poolOptions={poolOptions}
      highlighterOptions={highlighterOptions}
    >
      <HighlightCacheBudget scope={snapshot?.id} />
      <div
        className="app"
        data-repository={snapshot?.repository.name ?? ""}
        data-loaded-files={Object.keys(loaded).length}
      >
        <header className="titlebar" data-tauri-drag-region>
          <div className="app-wordmark" data-tauri-drag-region>
            <img
              src={appIcon}
              alt=""
              width={20}
              height={20}
              draggable={false}
            />
            <span>Peer</span>
            <span className="preview-tag">LOCAL</span>
          </div>
          <div className="titlebar-actions">
            <button
              className="icon-button"
              title="Settings (⌘ ,)"
              aria-label="Settings"
              onClick={() => setSettings("appearance")}
            >
              <Settings2 size={16} />
            </button>
          </div>
        </header>
        <div className="toolbar">
          <RepositorySwitcher
            current={snapshot?.repository ?? null}
            repositories={preferences.recentRepositories}
            disabled={!ready || busy || saving}
            onSelect={(path) => void openRepository(path)}
            onOpen={() => void pickRepository()}
            onRelocate={setRepositoryToUpdate}
            onRemove={(path) => void removeRepository(path)}
          />
          {snapshot ? (
            <>
              <button
                className="icon-button"
                aria-label="Go back"
                title={`Go back (${navigation.backShortcut}; Ctrl+-)`}
                disabled={!navigation.historyLength}
                onClick={() => void navigation.back()}
              >
                <ArrowLeft size={16} />
              </button>
              <button
                className="icon-button"
                aria-label="Go forward"
                title={`Go forward (${navigation.forwardShortcut})`}
                disabled={!navigation.forwardLength}
                onClick={() => void navigation.forward()}
              >
                <ArrowRight size={16} />
              </button>
              <div className="view-switch">
                <button
                  className={
                    snapshot.comparison.view === "code" ? "active" : ""
                  }
                  onClick={() =>
                    changeComparison({ ...defaultComparison, view: "code" })
                  }
                >
                  <Code2 size={15} />
                  Code
                </button>
                <button
                  className={
                    snapshot.comparison.view === "changes" ? "active" : ""
                  }
                  onClick={() => changeComparison(lastChanges.current)}
                >
                  <FileDiff size={15} />
                  Changes
                </button>
              </div>
              <CommitHistory
                snapshot={snapshot}
                disabled={busy || saving}
                onSelect={(commit) =>
                  changeComparison({
                    view: "changes",
                    mode: "commit",
                    baseRef: commit.id,
                    includeUntracked: false,
                  })
                }
              />
              <div className="toolbar-spacer" />
              <button
                className="icon-button"
                title="Find in file (⌘ F)"
                aria-label="Find in file"
                onClick={() =>
                  findOpen ? setFindOpen(false) : openFind("Find in file")
                }
              >
                <Search size={16} />
              </button>
              <button
                className="icon-button"
                title="Refresh repository (⌘ R)"
                aria-label="Refresh repository"
                disabled={busy}
                onClick={refresh}
              >
                <RefreshCw size={16} className={busy ? "spin" : ""} />
              </button>
              <button
                className={`feedback-toggle ${feedback ? "active" : ""}`}
                onClick={() => {
                  navigation.setResultsVisible(false);
                  setFeedback((v) => (navigation.resultsVisible ? true : !v));
                }}
              >
                <MessageSquare size={14} />
                Feedback<span className="count">{queue.comments.length}</span>
              </button>
              {navigation.results && (
                <button
                  className="small-button"
                  onClick={() =>
                    navigation.setResultsVisible((value) => !value)
                  }
                >
                  References / Definitions
                </button>
              )}
            </>
          ) : (
            <span className="toolbar-hint">
              Read the code. Leave the context.
            </span>
          )}
        </div>
        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            {snapshot && <button onClick={refresh}>Refresh</button>}
            <button
              className="icon-button"
              aria-label="Dismiss error"
              onClick={() => setError("")}
            >
              <X size={14} />
            </button>
          </div>
        )}
        {!snapshot ? (
          <main className="welcome">
            <img
              className="welcome-mark"
              src={appIcon}
              alt=""
              width={76}
              height={76}
              draggable={false}
            />
            <span className="eyebrow">A CLEARER LOOK AT YOUR CODE</span>
            <h1>
              Understand the changes.
              <br />
              <span>Keep the conversation.</span>
            </h1>
            <p>
              Browse a repository, review its diffs, and leave precise
              <br />
              feedback for your coding agent. All on your machine.
            </p>
            <button
              className="primary-button welcome-open"
              onClick={pickRepository}
              disabled={!ready || busy}
            >
              {busy ? (
                <LoaderCircle size={17} className="spin" />
              ) : (
                <FolderOpen size={17} />
              )}
              Open repository<kbd>⌘ O</kbd>
            </button>
            {preferences.recentRepositories.length > 0 && (
              <div className="recent-repositories">
                <h3>RECENT REPOSITORIES</h3>
                {preferences.recentRepositories.slice(0, 5).map((path) => (
                  <button key={path} onClick={() => void openRepository(path)}>
                    <FolderOpen size={15} />
                    <span>
                      {path.split(/[\\/]/).at(-1)}
                      <small>{path}</small>
                    </span>
                    <ArrowRight size={14} />
                  </button>
                ))}
              </div>
            )}
            <div className="welcome-features">
              <span>
                <BookOpen size={14} />
                Read-only by design
              </span>
              <span>
                <MessageSquare size={14} />
                Feedback with context
              </span>
              <span>
                <Check size={14} />
                Works offline
              </span>
            </div>
          </main>
        ) : (
          <ResizableWorkspace
            widths={preferences.sidebarWidths}
            onChange={(sidebarWidths) =>
              setPreferences((current) => ({ ...current, sidebarWidths }))
            }
            rightLabel={
              navigation.resultsVisible ? "navigation results" : "feedback"
            }
          >
            <FileTree
              files={snapshot.files}
              selected={selected}
              queue={queue}
              view={snapshot.comparison.view}
              onSelect={selectFile}
            />
            <main className="main-pane">
              <div className="comparison-toolbar">
                {navigation.file ? (
                  <>
                    <span className="breadcrumb" title={navigation.file.path}>
                      <Code2 size={14} />
                      {navigation.file.path}
                    </span>
                    <div className="toolbar-spacer" />
                    <span className="navigation-version">
                      {navigation.file.label}
                    </span>
                  </>
                ) : snapshot.comparison.view === "changes" ? (
                  <>
                    <select
                      aria-label="Comparison mode"
                      value={snapshot.comparison.mode}
                      onChange={(e) => {
                        const mode = e.target.value as Comparison["mode"];
                        changeComparison({
                          ...snapshot.comparison,
                          mode,
                          includeUntracked: snapshot.commit
                            ? defaultComparison.includeUntracked
                            : snapshot.comparison.includeUntracked,
                          baseRef:
                            mode === "branch"
                              ? ((snapshot.comparison.mode === "branch"
                                  ? snapshot.comparison.baseRef
                                  : null) ??
                                (branches.includes("main")
                                  ? "main"
                                  : (branches[0] ?? null)))
                              : null,
                        });
                      }}
                    >
                      <option value="all">All local changes</option>
                      <option value="unstaged">Unstaged changes</option>
                      <option value="staged">Staged changes</option>
                      <option value="branch">Compare to branch</option>
                      {snapshot.commit && (
                        <option value="commit">
                          Commit {snapshot.commit.shortId}
                        </option>
                      )}
                    </select>
                    {snapshot.comparison.mode === "branch" && (
                      <select
                        aria-label="Base branch"
                        value={snapshot.comparison.baseRef ?? ""}
                        onChange={(e) =>
                          changeComparison({
                            ...snapshot.comparison,
                            baseRef: e.target.value,
                          })
                        }
                      >
                        {branches.map((branch) => (
                          <option key={branch}>{branch}</option>
                        ))}
                      </select>
                    )}
                    {snapshot.comparison.mode !== "staged" &&
                      snapshot.comparison.mode !== "commit" && (
                        <label className="untracked-toggle">
                          <input
                            type="checkbox"
                            checked={snapshot.comparison.includeUntracked}
                            onChange={(e) =>
                              changeComparison({
                                ...snapshot.comparison,
                                includeUntracked: e.target.checked,
                              })
                            }
                          />
                          Untracked
                        </label>
                      )}
                    <div className="toolbar-spacer" />
                    {preferences.diffLayout === "unified" && (
                      <select
                        aria-label="Navigation side for shared lines"
                        title="Version used by F12 on unchanged lines"
                        value={navigationSide}
                        onChange={(event) =>
                          setNavigationSide(event.target.value as "old" | "new")
                        }
                      >
                        <option value="new">Navigate shared lines: B</option>
                        <option value="old">Navigate shared lines: A</option>
                      </select>
                    )}
                    <span className="diff-summary">
                      <b className="add">+{totalAdds}</b>
                      <b className="remove">−{totalDeletes}</b>
                    </span>
                    <button
                      className="icon-button"
                      title={
                        preferences.diffLayout === "unified"
                          ? "Switch to split diff"
                          : "Switch to unified diff"
                      }
                      aria-label="Toggle diff layout"
                      onClick={() =>
                        setPreferences((p) => ({
                          ...p,
                          diffLayout:
                            p.diffLayout === "unified" ? "split" : "unified",
                        }))
                      }
                    >
                      <SplitSquareHorizontal size={16} />
                    </button>
                  </>
                ) : (
                  <>
                    <span className="breadcrumb">
                      <Code2 size={14} />
                      {selectedEntry?.path ?? "Repository"}
                    </span>
                    <div className="toolbar-spacer" />
                    <span className="muted">Working directory</span>
                  </>
                )}
                <button
                  className={`icon-button ${preferences.showWhitespace ? "active" : ""}`}
                  title="Toggle whitespace markers"
                  aria-label="Toggle whitespace markers"
                  aria-pressed={preferences.showWhitespace}
                  onClick={() =>
                    setPreferences((p) => ({
                      ...p,
                      showWhitespace: !p.showWhitespace,
                    }))
                  }
                >
                  <Text size={16} />
                </button>
              </div>
              {snapshot.commit && !navigation.file && (
                <div className="commit-summary">
                  <div>
                    <strong>
                      {snapshot.commit.subject || "Untitled commit"}
                    </strong>
                    <span>
                      {snapshot.commit.author} ·{" "}
                      {commitDate(snapshot.commit.committedAt)} ·{" "}
                      {snapshot.commit.parents.length > 1
                        ? "Compared with first parent"
                        : snapshot.commit.parents.length
                          ? "Changes introduced by this commit"
                          : "Initial commit"}
                    </span>
                  </div>
                  <code title={snapshot.commit.id}>
                    {snapshot.commit.shortId}
                  </code>
                </div>
              )}
              {navigation.status && (
                <div
                  className={`navigation-status ${navigation.status.code === "preparing" ? "" : "navigation-status-error"}`}
                  role="status"
                >
                  {navigation.status.code === "preparing" && (
                    <LoaderCircle size={14} className="spin" />
                  )}
                  <span>{navigation.status.message}</span>
                  {navigation.status.code === "missingServer" && (
                    <button
                      className="small-button"
                      onClick={() => setSettings("navigation")}
                    >
                      Settings
                    </button>
                  )}
                  {navigation.status.code === "stale" && (
                    <button className="small-button" onClick={refresh}>
                      Refresh
                    </button>
                  )}
                  <button
                    className="icon-button"
                    aria-label={
                      navigation.status.code === "preparing"
                        ? "Cancel navigation"
                        : "Dismiss navigation status"
                    }
                    onClick={navigation.cancel}
                  >
                    <X size={14} />
                  </button>
                </div>
              )}
              {findOpen && (
                <form
                  className="find-bar"
                  onSubmit={(e) => {
                    e.preventDefault();
                    jumpMatch(matchIndex + 1);
                  }}
                >
                  <Search size={14} />
                  <input
                    aria-label="Find in file"
                    placeholder="Find in selected file…"
                    value={findText}
                    onChange={(e) => {
                      setFindText(e.target.value);
                      setMatchIndex(-1);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                        e.preventDefault();
                        jumpMatch(matchIndex + (e.shiftKey ? -1 : 1));
                      }
                    }}
                  />
                  <span>
                    {matches.length
                      ? `${Math.min(Math.max(matchIndex + 1, 0), matches.length)} / ${matches.length}`
                      : "No matches"}
                  </span>
                  <button
                    type="button"
                    className="small-button"
                    aria-label="Previous match"
                    onClick={() => jumpMatch(matchIndex - 1)}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="small-button"
                    aria-label="Next match"
                    onClick={() => jumpMatch(matchIndex + 1)}
                  >
                    ↓
                  </button>
                  <input
                    className="line-input"
                    aria-label="Go to line"
                    placeholder="Line…"
                    value={lineInput}
                    onChange={(e) => setLineInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        if (
                          selected &&
                          Number.isInteger(Number(lineInput)) &&
                          Number(lineInput) > 0
                        )
                          navigation.jump(
                            Number(lineInput),
                            snapshot.comparison.view === "code"
                              ? "new"
                              : navigationSide,
                          );
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="icon-button"
                    aria-label="Close search"
                    onClick={() => setFindOpen(false)}
                  >
                    <X size={14} />
                  </button>
                </form>
              )}
              {navigation.file && navigation.file.snapshotId === snapshot.id ? (
                <NavigationSource
                  ref={viewer}
                  key={`source:${navigation.file.documentId}:${navigation.mountEpoch}`}
                  snapshot={snapshot}
                  file={navigation.file}
                  preferences={preferences}
                  theme={theme}
                  onLoad={navigation.loadSource}
                  onNavigate={navigation.navigate}
                  onError={reportError}
                  findQuery={findOpen ? findText : ""}
                  findMatch={findOpen ? matches[matchIndex] : undefined}
                />
              ) : snapshot.files.length ? (
                <Viewer
                  ref={viewer}
                  key={`${snapshot.id}:${navigation.mountEpoch}`}
                  snapshot={snapshot}
                  selected={selected}
                  loaded={loaded}
                  errors={errors}
                  queue={queue}
                  preferences={preferences}
                  theme={theme}
                  onLoad={requestFile}
                  onComment={beginComment}
                  onReviewed={markReviewed}
                  onScroll={saveScroll}
                  onActiveFileChange={followVisibleFile}
                  onError={reportError}
                  navigationSide={
                    snapshot.comparison.view === "code" ? "new" : navigationSide
                  }
                  onNavigate={navigation.navigate}
                  findQuery={findOpen ? findText : ""}
                  findMatch={findOpen ? matches[matchIndex] : undefined}
                />
              ) : (
                <div className="empty-state">
                  <Check size={35} strokeWidth={1.3} />
                  <h2>
                    {snapshot.comparison.view === "changes"
                      ? "All clear."
                      : "No files yet."}
                  </h2>
                  <p>
                    {snapshot.comparison.view === "changes"
                      ? "There are no changes in this comparison."
                      : "Tracked and non-ignored files will appear here."}
                  </p>
                  <button
                    className="small-button"
                    onClick={() =>
                      changeComparison({
                        ...defaultComparison,
                        view:
                          snapshot.comparison.view === "changes"
                            ? "code"
                            : "changes",
                      })
                    }
                  >
                    {snapshot.comparison.view === "changes"
                      ? "Browse code"
                      : "View changes"}
                  </button>
                </div>
              )}
              {busy && (
                <div className="refresh-overlay">
                  <LoaderCircle size={18} className="spin" />
                  Reading repository…
                </div>
              )}
            </main>
            {navigation.resultsVisible && navigation.results ? (
              <NavigationResults
                result={navigation.results}
                onSelect={(location) =>
                  void navigation.openLocation(location, navigation.results!)
                }
                onClose={() => navigation.setResultsVisible(false)}
                onFeedback={() => {
                  navigation.setResultsVisible(false);
                  setFeedback(true);
                }}
              />
            ) : (
              feedback && (
                <Feedback
                  key={snapshot.queueId}
                  queue={queue}
                  view={snapshot.comparison.view}
                  draft={drafts[snapshot.queueId]}
                  focusRequest={commentFocusRequest}
                  busy={saving}
                  onDraft={(draft) => {
                    if (!draft) ++commentRequest.current;
                    setDrafts((prev) => ({
                      ...prev,
                      [snapshot.queueId]: draft,
                    }));
                  }}
                  onSubmit={submitComment}
                  onCopy={copyFeedback}
                  deleteAfterCopy={deleteAfterCopy}
                  onDeleteAfterCopyChange={setDeleteAfterCopy}
                  onSave={saveFeedback}
                  onClear={clearFeedback}
                  onDelete={(id) => {
                    void api
                      .deleteComments(snapshot.queueId, id)
                      .then(reloadQueue)
                      .catch(reportError);
                  }}
                  onEdit={async (id, body) => {
                    try {
                      await api.editComment(snapshot.queueId, id, body);
                      await reloadQueue();
                    } catch (e) {
                      reportError(e);
                      throw e;
                    }
                  }}
                  onJump={jumpToComment}
                  onClose={() => setFeedback(false)}
                />
              )
            )}
          </ResizableWorkspace>
        )}
        <footer className="statusbar">
          <span>
            <span className="status-dot" />
            {busy ? "Refreshing…" : snapshot ? "Ready" : "Local workspace"}
          </span>
          {snapshot && (
            <>
              <span>{snapshot.files.length} files</span>
              {snapshot.comparison.view === "changes" && (
                <span>{Object.keys(queue.reviewed).length} reviewed</span>
              )}
            </>
          )}
          <div className="toolbar-spacer" />
          <span>{theme.name}</span>
          {selectedFile && (
            <span>Tab width: {selectedFile.content.tabWidth}</span>
          )}
          <span>Peer {appVersion}</span>
        </footer>
        {message && (
          <div className="toast" role="status">
            <Check size={14} />
            {message}
          </div>
        )}
        {repositoryToUpdate !== null && (
          <RepositoryLocation
            path={repositoryToUpdate}
            onSave={async (path) => {
              await openRepository(path, null, repositoryToUpdate);
              setRepositoryToUpdate(null);
            }}
            onClose={() => setRepositoryToUpdate(null)}
          />
        )}
        {settings && (
          <Settings
            initialTab={settings}
            preferences={preferences}
            themes={themes}
            onChange={setPreferences}
            onImport={importTheme}
            onRemove={removeTheme}
            onClose={() => setSettings(null)}
          />
        )}
        {quickOpen && (
          <QuickOpen
            files={snapshot?.files ?? []}
            onSelect={selectFile}
            onClose={() => setQuickOpen(false)}
          />
        )}
        {exportText !== null && (
          <Modal title="Feedback JSON" onClose={() => setExportText(null)}>
            <p className="settings-help">
              Clipboard access was unavailable. Select the JSON or save it to a
              file.
            </p>
            <textarea
              className="export-json"
              aria-label="Exported feedback JSON"
              value={exportText}
              readOnly
              onFocus={(e) => e.currentTarget.select()}
            />
            <button className="primary-button" onClick={saveFeedback}>
              Save JSON
            </button>
          </Modal>
        )}
      </div>
    </WorkerPoolContextProvider>
  );
}
