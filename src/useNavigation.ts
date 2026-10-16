import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { api } from "./api";
import type {
  Snapshot,
  NavigationFile,
  NavigationLocation,
  NavigationResult,
} from "./types";
import type { ViewerHandle, LoadedFile } from "./Viewer";
import { SourceCache } from "./memory";
import {
  isTyping,
  NavigationHistory,
  navigationError,
  type HistoryEntry,
  type NavigationPage,
  type SymbolPosition,
  type ViewportState,
} from "./navigation";
import {
  diagnosticFile,
  recordDiagnostic,
  recordDiagnosticError,
} from "./diagnostics";

export function useNavigation({
  snapshot,
  selected,
  viewer,
  loadFile,
  activateFile,
  navigationSide,
  setNavigationSide,
}: {
  navigationSide: "old" | "new";
  setNavigationSide: (side: "old" | "new") => void;
  snapshot: Snapshot | null;
  selected: string | null;
  viewer: RefObject<ViewerHandle | null>;
  loadFile: (id: string, force?: boolean) => Promise<LoadedFile>;
  activateFile: (id: string) => void;
}) {
  const [page, setPage] = useState<NavigationPage | null>(null);
  const [file, setFile] = useState<NavigationFile | null>(null);
  const [results, setResults] = useState<NavigationResult | null>(null);
  const [resultsVisible, setResultsVisible] = useState(false);
  const [status, setStatus] = useState<{
    code: string;
    message: string;
  } | null>(null);
  const [epoch, setEpoch] = useState(0);
  const [mountEpoch, setMountEpoch] = useState(0);
  const [historyLength, setHistoryLength] = useState(0);
  const history = useRef(new NavigationHistory());
  const cache = useRef(new SourceCache<NavigationFile>(8 * 1024 * 1024, 8));
  const pending = useRef<{
    state?: ViewportState;
    id?: string;
    line?: number;
    side?: "old" | "new";
    range?: NavigationPage["range"];
  } | null>(null);
  const request = useRef<string | null>(null);
  const generation = useRef(0);
  const current = useRef({
    snapshot,
    selected,
    page,
    results,
    resultsVisible,
    loadFile,
    activateFile,
    navigationSide,
  });
  current.current = {
    snapshot,
    selected,
    page,
    results,
    resultsVisible,
    loadFile,
    activateFile,
    navigationSide,
  };
  const cancel = useCallback(() => {
    generation.current++;
    if (request.current)
      void api.cancelNavigation(request.current).catch(() => {});
    request.current = null;
    setStatus(null);
  }, []);
  useEffect(() => {
    cancel();
    history.current.clear();
    cache.current.clear();
    setPage(null);
    setFile(null);
    setResults(null);
    setResultsVisible(false);
    setHistoryLength(0);
    pending.current = null;
  }, [snapshot?.id, cancel]);
  useEffect(
    () => () => {
      if (request.current)
        void api.cancelNavigation(request.current).catch(() => {});
    },
    [],
  );

  const capture = useCallback((): HistoryEntry => {
    const value = current.current;
    const target = diagnosticFile(value.snapshot, value.selected);
    recordDiagnostic("navigation.capture.start", target);
    try {
      const entry = {
        selected: value.selected,
        navigationSide: value.navigationSide,
        page: value.page,
        viewport: viewer.current?.capture() ?? null,
        results: value.results,
        resultsVisible: value.resultsVisible,
      };
      recordDiagnostic("navigation.capture.complete", {
        ...target,
        hasViewport: entry.viewport !== null,
        hasSelection: !!entry.viewport?.selection,
        sourcePage: entry.page !== null,
      });
      return entry;
    } catch (error) {
      recordDiagnosticError("navigation.capture.error", error, target);
      throw error;
    }
  }, [viewer]);
  const remember = useCallback((entry: HistoryEntry) => {
    history.current.push(entry);
    setHistoryLength(history.current.length);
  }, []);
  const read = useCallback(
    async (
      snapshotId: string,
      side: "old" | "new",
      id: string,
      force = false,
    ) => {
      const cached = cache.current.get(id);
      if (cached && (!cached.deferred || !force)) return cached;
      const value = await api.navigationFile(snapshotId, side, id, force);
      if (current.current.snapshot?.id === snapshotId)
        cache.current.set(id, value, new Set([id]));
      return value;
    },
    [],
  );
  const openLocation = useCallback(
    async (
      location: NavigationLocation,
      response: NavigationResult,
      origin: HistoryEntry = capture(),
    ) => {
      const active = current.current.snapshot;
      if (!active || active.id !== response.snapshotId) return;
      cancel();
      const attempt = generation.current;
      setStatus({ code: "preparing", message: "Opening source…" });
      try {
        const value = await read(active.id, response.side, location.documentId);
        if (
          attempt !== generation.current ||
          current.current.snapshot?.id !== active.id
        )
          return;
        remember(origin);
        setFile(value);
        setPage({
          documentId: location.documentId,
          side: response.side,
          range: location.range,
        });
        pending.current = {
          id: location.documentId,
          range: location.range,
          side: response.side,
        };
        setEpoch((value) => value + 1);
        setStatus(null);
      } catch (error) {
        if (attempt === generation.current) setStatus(navigationError(error));
      }
    },
    [capture, cancel, read, remember],
  );
  const navigate = useCallback(
    async (position: SymbolPosition, operation: "auto" | "references") => {
      const value = current.current;
      const snapshot = value.snapshot;
      if (!snapshot) return;
      const entry = snapshot.files.find((entry) => entry.id === position.id);
      if (!value.page && !entry) return;
      const origin = capture();
      cancel();
      const id = crypto.randomUUID();
      request.current = id;
      const attempt = generation.current;
      setStatus({
        code: "preparing",
        message: "Preparing source and finding symbol…",
      });
      try {
        const response = await api.navigate({
          requestId: id,
          snapshotId: snapshot.id,
          side: value.page?.side ?? position.side,
          path: value.page
            ? null
            : position.side === "old"
              ? (entry!.oldPath ?? entry!.path)
              : entry!.path,
          documentId: value.page?.documentId ?? null,
          position: position.position,
          operation,
        });
        if (
          attempt !== generation.current ||
          request.current !== id ||
          current.current.snapshot?.id !== snapshot.id
        )
          return;
        request.current = null;
        if (
          response.kind === "definitions" &&
          response.locations.length === 1
        ) {
          await openLocation(response.locations[0], response, origin);
        } else {
          setResults(response);
          setResultsVisible(true);
          setStatus(
            response.locations.length
              ? null
              : {
                  code: "noResults",
                  message: `No ${response.kind} found in this analysis workspace. Check that the project’s dependencies are available.`,
                },
          );
        }
      } catch (error) {
        if (attempt === generation.current) {
          request.current = null;
          const failure = navigationError(error);
          setStatus(failure.code === "cancelled" ? null : failure);
        }
      }
    },
    [capture, cancel, openLocation],
  );

  const review = useCallback(
    async (id: string, line?: number, side?: "old" | "new") => {
      const active = current.current.snapshot;
      if (!active) return;
      const target = { ...diagnosticFile(active, id), line, side };
      recordDiagnostic("navigation.request", target);
      const origin = capture();
      cancel();
      const attempt = generation.current;
      let stage = "load";
      try {
        recordDiagnostic("navigation.load.start", target);
        await current.current.loadFile(id);
        recordDiagnostic("navigation.load.complete", target);
        if (
          attempt !== generation.current ||
          current.current.snapshot?.id !== active.id
        ) {
          recordDiagnostic("navigation.superseded", target);
          return;
        }
        stage = "activate";
        remember(origin);
        setPage(null);
        setFile(null);
        if (origin.page) setMountEpoch((value) => value + 1);
        current.current.activateFile(id);
        pending.current = { id, line, side };
        setEpoch((value) => value + 1);
        recordDiagnostic("navigation.activated", target);
      } catch (error) {
        recordDiagnosticError(`navigation.${stage}.error`, error, target);
        if (attempt === generation.current) setStatus(navigationError(error));
      }
    },
    [capture, cancel, remember],
  );
  const jump = useCallback(
    (line: number, side?: "old" | "new") => {
      const value = current.current;
      if (!value.page) {
        if (value.selected) void review(value.selected, line, side);
        return;
      }
      remember(capture());
      cancel();
      viewer.current?.jump(value.page.documentId, line, value.page.side);
    },
    [capture, cancel, remember, review, viewer],
  );
  const back = useCallback(async () => {
    const entry = history.current.peek();
    const active = current.current.snapshot;
    if (!entry || !active) return;
    const target = diagnosticFile(active, entry.selected);
    recordDiagnostic("navigation.back.start", target);
    cancel();
    const attempt = generation.current;
    try {
      const source = entry.page
        ? await read(active.id, entry.page.side, entry.page.documentId)
        : null;
      if (!entry.page && entry.selected)
        await current.current.loadFile(entry.selected);
      if (
        attempt !== generation.current ||
        current.current.snapshot?.id !== active.id
      )
        return;
      history.current.pop();
      setHistoryLength(history.current.length);
      setMountEpoch((value) => value + 1);
      setPage(entry.page);
      setNavigationSide(entry.navigationSide);
      setFile(source);
      setResults(entry.results);
      setResultsVisible(entry.resultsVisible);
      if (entry.selected) current.current.activateFile(entry.selected);
      pending.current = entry.viewport ? { state: entry.viewport } : null;
      setEpoch((value) => value + 1);
      recordDiagnostic("navigation.back.complete", target);
    } catch (error) {
      recordDiagnosticError("navigation.back.error", error, target);
      if (attempt === generation.current) setStatus(navigationError(error));
    }
  }, [cancel, read, setNavigationSide]);
  const loadSource = useCallback(async () => {
    const value = current.current;
    if (!value.snapshot || !value.page) return;
    try {
      const source = await read(
        value.snapshot.id,
        value.page.side,
        value.page.documentId,
        true,
      );
      if (current.current.page === value.page) {
        setFile(source);
        pending.current = {
          id: value.page.documentId,
          range: value.page.range,
          side: value.page.side,
        };
        setEpoch((value) => value + 1);
      }
    } catch (error) {
      setStatus(navigationError(error));
    }
  }, [read]);
  useLayoutEffect(() => {
    const action = pending.current;
    if (!action || !viewer.current) return;
    pending.current = null;
    if (action.state) viewer.current.restoreState(action.state);
    else if (action.id && action.range)
      viewer.current.reveal(action.id, action.range, action.side);
    else if (action.id)
      viewer.current.jump(action.id, action.line, action.side);
  }, [epoch, file, page, selected, viewer]);
  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if (isTyping(event) || event.altKey || event.repeat) return;
      if (event.key === "F12" && !event.ctrlKey && !event.metaKey) {
        const position = viewer.current?.sourcePosition();
        if (position) {
          event.preventDefault();
          void navigate(position, event.shiftKey ? "references" : "auto");
        }
      } else if (
        event.ctrlKey &&
        !event.metaKey &&
        !event.shiftKey &&
        (event.key === "-" || event.code === "Minus")
      ) {
        event.preventDefault();
        void back();
      }
    };
    window.addEventListener("keydown", keys);
    return () => window.removeEventListener("keydown", keys);
  }, [navigate, back, viewer]);
  return {
    page,
    file,
    results,
    resultsVisible,
    setResultsVisible,
    status,
    mountEpoch,
    historyLength,
    cancel,
    back,
    navigate,
    review,
    jump,
    openLocation,
    loadSource,
  };
}
