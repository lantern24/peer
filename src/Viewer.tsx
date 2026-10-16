import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  CodeView,
  useWorkerPool,
  type CodeViewHandle,
  type CodeViewItem,
  type CodeViewReactOptions,
} from "@pierre/diffs/react";
import {
  ChevronDown,
  ChevronRight,
  FileCode2,
  MessageSquarePlus,
  Plus,
  LoaderCircle,
} from "lucide-react";
import type {
  Preferences,
  ReviewComment,
  ReviewQueue,
  Snapshot,
} from "./types";
import { decorateWhitespace, whitespaceCSS } from "./whitespace";
import { highlightSearchLine, searchCSS, type SourceMatch } from "./search";
import { rendererThemeId, type Theme } from "./themes";
import {
  HorizontalScrollbar,
  type HorizontalScrollbarHandle,
} from "./HorizontalScrollbar";

import type { LoadedFile } from "./loaded-file";
import { sourceLines } from "./loaded-file";
import {
  pointerCharacter,
  sharedLinePosition,
  textOffset,
  type SymbolPosition,
  type ViewportState,
  type SourceRange,
} from "./navigation";
export type { LoadedFile } from "./loaded-file";
import {
  diagnosticFile,
  recordDiagnostic,
  recordDiagnosticError,
  registerDiagnosticContext,
  type DiagnosticFields,
} from "./diagnostics";
export type ViewerHandle = {
  jump: (id: string, line?: number, side?: "old" | "new") => void;
  scrollTop: () => number;
  restore: (top: number) => void;
  capture: () => ViewportState;
  restoreState: (state: ViewportState, onRefreshRestored?: () => void) => void;
  sourcePosition: () => SymbolPosition | null;
  reveal: (id: string, range: SourceRange, side?: "old" | "new") => void;
};
type Props = {
  snapshot: Snapshot;
  selected: string | null;
  loaded: Record<string, LoadedFile>;
  errors: Record<string, string>;
  queue: ReviewQueue;
  preferences: Preferences;
  theme: Theme;
  onLoad: (id: string, force?: boolean) => void;
  onComment: (id: string, line?: number, side?: "old" | "new") => void;
  onReviewed: (id: string, checked: boolean) => void;
  onScroll: (top: number) => void;
  onActiveFileChange: (snapshotId: string, id: string) => void;
  onError: (error: string) => void;
  navigationOnly?: boolean;
  navigationSide?: "old" | "new";
  findQuery?: string;
  findMatch?: SourceMatch;
  onNavigate?: (
    position: SymbolPosition,
    operation: "auto" | "references",
  ) => void;
};

const viewerCSS = `
  :host { --diffs-font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', monospace;
    --diffs-bg-addition-override: var(--add-bg); --diffs-bg-deletion-override: var(--remove-bg);
    --diffs-bg-addition-emphasis-override: var(--add-word); --diffs-bg-deletion-emphasis-override: var(--remove-word);
    --diffs-fg-number-override: var(--muted); --diffs-bg-selection-override: var(--selection); }
  [data-diffs-header] { background: var(--surface); border-block: 1px solid var(--border); }
`;

export const Viewer = forwardRef<ViewerHandle, Props>(
  function Viewer(props, outerRef) {
    const {
      snapshot,
      selected,
      loaded,
      errors,
      queue,
      preferences,
      theme,
      onLoad,
      onComment,
      onReviewed,
      onScroll,
      onError,
    } = props;
    const viewer = useRef<CodeViewHandle<ReviewComment, undefined>>(null);
    const horizontalScrollbar = useRef<HorizontalScrollbarHandle>(null);
    const scroll = useRef(0);
    const surface = useRef<HTMLDivElement>(null);
    const symbol = useRef<SymbolPosition | null>(null);
    const targetRange = useRef<{
      id: string;
      range: SourceRange;
      side: "old" | "new";
    } | null>(null);
    const expansions = useRef<ViewportState["expanded"]>({});
    const instrumented = useRef(new WeakSet<object>());
    const expansionRestored = useRef(new WeakSet<object>());
    const replaying = useRef(false);
    const restoring = useRef<ViewportState | null>(null);
    const refreshRestored = useRef<(() => void) | undefined>(undefined);
    const [contextMenu, setContextMenu] = useState<{
      x: number;
      y: number;
      position: SymbolPosition;
    } | null>(null);
    const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
    const [highlighterVersion, setHighlighterVersion] = useState(0);
    const [selectedLine, setSelectedLine] = useState<{
      id: string;
      line: number;
      side?: "old" | "new";
    } | null>(null);
    const pool = useWorkerPool();
    const refs = useRef(props);
    refs.current = props;
    const entries = useMemo(
      () => new Map(snapshot.files.map((file) => [file.id, file])),
      [snapshot],
    );
    const itemCache = useRef(
      new Map<string, { key: string; item: CodeViewItem<ReviewComment> }>(),
    );
    const pendingJump = useRef<{
      id: string;
      line?: number;
      side?: "old" | "new";
    } | null>(null);
    const pendingFindScroll = useRef<SourceMatch | null>(null);
    const searchedNodes = useRef(new WeakSet<HTMLElement>());
    const lastDiagnosticRender = useRef<{
      snapshotId: string;
      id: string;
      version: number | undefined;
    } | null>(null);
    const diagnosticState = useCallback((): DiagnosticFields => {
      const current = refs.current;
      const instance = viewer.current?.getInstance();
      const container = instance?.getContainerElement();
      const viewport = container?.getBoundingClientRect();
      const rendered = instance?.getRenderedItems() ?? [];
      const host = rendered.find(
        (item) => item.id === current.selected,
      )?.element;
      const lines = host?.shadowRoot?.querySelectorAll<HTMLElement>(
        "[data-line][data-line-type]",
      );
      let sampledLines = 0;
      let visibleLines = 0;
      let firstLine: DiagnosticFields = {};
      if (lines && viewport) {
        for (const line of lines) {
          if (sampledLines >= 100) break;
          const range = document.createRange();
          range.selectNodeContents(line);
          const rect = range.getBoundingClientRect();
          const style = getComputedStyle(line);
          if (sampledLines++ === 0)
            firstLine = {
              firstLineWidth: rect.width,
              firstLineHeight: rect.height,
              firstLineDisplay: style.display,
              firstLineVisibility: style.visibility,
              firstLineOpacity: style.opacity,
              firstLineColor: style.color,
            };
          if (
            rect.width > 0 &&
            rect.height > 0 &&
            rect.bottom > viewport.top &&
            rect.top < viewport.bottom &&
            rect.right > viewport.left &&
            rect.left < viewport.right &&
            style.visibility === "visible" &&
            style.opacity !== "0" &&
            style.display !== "none"
          )
            visibleLines++;
        }
      }
      return {
        ...diagnosticFile(current.snapshot, current.selected),
        rendererPresent: !!instance,
        renderedItems: rendered.length,
        selectedMounted: !!host,
        shadowRoot: !!host?.shadowRoot,
        sourceLines: lines?.length ?? 0,
        sampledLines,
        visibleLines,
        loaded: !!(current.selected && current.loaded[current.selected]),
        collapsed: !!(current.selected && collapsed.has(current.selected)),
        viewportWidth: viewport?.width,
        viewportHeight: viewport?.height,
        scrollTop: instance?.getScrollTop(),
        ...firstLine,
        ...pool?.getStats(),
      };
    }, [pool, collapsed]);
    useEffect(
      () => registerDiagnosticContext("viewer", diagnosticState),
      [diagnosticState],
    );
    const selectedContent = selected ? loaded[selected]?.content : undefined;
    useEffect(() => {
      // One delayed sample per selected-file transition; never measure each
      // scroll/render frame. Report export also samples the current state.
      const timer = setTimeout(() => {
        try {
          recordDiagnostic("viewer.probe", diagnosticState());
        } catch (error) {
          recordDiagnosticError("viewer.probe.error", error);
        }
      }, 1000);
      return () => clearTimeout(timer);
    }, [snapshot, selected, selectedContent, diagnosticState]);

    const positionAt = useCallback(
      (
        line: HTMLElement,
        id: string,
        event?: MouseEvent,
        fallback = 0,
        explicitSide?: "old" | "new",
      ): SymbolPosition => {
        const current = refs.current;
        const diff = current.snapshot.comparison.view === "changes";
        const type = line.dataset.lineType;
        const column = line.closest("[data-code]");
        const unifiedContext =
          diff &&
          current.preferences.diffLayout === "unified" &&
          (type === "context" || type === "context-expanded");
        const side = !diff
          ? (current.navigationSide ?? "new")
          : unifiedContext
            ? (current.navigationSide ?? "new")
            : (explicitSide ??
              (type === "change-deletion" ||
              column?.hasAttribute("data-deletions")
                ? "old"
                : "new"));
        const lineNumber = Number(line.dataset.line ?? 1);
        return {
          id,
          side,
          position: {
            line: unifiedContext
              ? sharedLinePosition(line, side, lineNumber)
              : lineNumber - 1,
            character: event
              ? pointerCharacter(event, line, fallback)
              : fallback,
          },
        };
      },
      [],
    );
    const highlightTarget = useCallback(() => {
      const target = targetRange.current;
      if (!target) return;
      const item = viewer.current
        ?.getInstance()
        ?.getRenderedItems()
        .find((item) => item.id === target.id);
      const lines = Array.from(
        item?.element.shadowRoot?.querySelectorAll<HTMLElement>(
          "[data-line][data-line-type]",
        ) ?? [],
      );
      const endpoint = (
        point: SourceRange["start"],
      ): [Node, number] | undefined => {
        const line = lines.find((line) => {
          const position = positionAt(line, target.id);
          return (
            position.position.line === point.line &&
            position.side === target.side
          );
        });
        if (!line) return;
        const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
        let offset = 0;
        while (walker.nextNode()) {
          const node = walker.currentNode as Text;
          if (point.character <= offset + node.length)
            return [node, point.character - offset];
          offset += node.length;
        }
      };
      const start = endpoint(target.range.start);
      const end = endpoint(target.range.end);
      if (start && end) {
        const selection = window.getSelection();
        if (
          selection?.anchorNode === start[0] &&
          selection.anchorOffset === start[1] &&
          selection.focusNode === end[0] &&
          selection.focusOffset === end[1]
        )
          return;
        selection?.setBaseAndExtent(...start, ...end);
      }
    }, [positionAt]);

    const sourceSelection = useCallback((): ViewportState["selection"] => {
      // Selection APIs differ between WKWebView versions. Read actual source
      // text endpoints, including selections crossing syntax/whitespace spans.
      const selection = window.getSelection();
      const roots = Array.from(
        surface.current?.querySelectorAll("diffs-container") ?? [],
      ).flatMap((host) => (host.shadowRoot ? [host.shadowRoot] : []));
      for (const root of roots) {
        const local =
          (
            root as ShadowRoot & { getSelection?: () => Selection | null }
          ).getSelection?.() ?? selection;
        let composed: StaticRange[] | undefined;
        if (local?.getComposedRanges) {
          try {
            composed = local.getComposedRanges({ shadowRoots: roots });
          } catch (error) {
            if (!(error instanceof TypeError)) throw error;
            recordDiagnostic(
              "selection.legacy",
              diagnosticFile(refs.current.snapshot, refs.current.selected),
            );
            // Older WebKit accepts individual ShadowRoots and rejects the
            // options object. Preserve its selection when capturing history.
            const legacy = local as Selection & {
              getComposedRanges: (
                ...shadowRoots: ShadowRoot[]
              ) => StaticRange[];
            };
            composed = legacy.getComposedRanges(...roots);
          }
        }
        const range =
          composed?.[0] ?? (local?.rangeCount ? local.getRangeAt(0) : null);
        if (!range) continue;
        const endpoint = (node: Node, offset: number) => {
          const element = node instanceof Element ? node : node.parentElement;
          const line = element?.closest<HTMLElement>(
            "[data-line][data-line-type]",
          );
          if (!line || line.getRootNode() !== root) return null;
          const id = (root.host as HTMLElement).dataset.navigationId;
          const character = textOffset(line, node, offset);
          return id && character !== null
            ? positionAt(line, id, undefined, character)
            : null;
        };
        const start = endpoint(range.startContainer, range.startOffset);
        const end = endpoint(range.endContainer, range.endOffset);
        if (start && end && start.side === end.side)
          return {
            id: start.id,
            side: start.side,
            range: { start: start.position, end: end.position },
          };
      }
      return null;
    }, [positionAt]);
    const sourcePosition = useCallback((): SymbolPosition | null => {
      const selection = sourceSelection();
      return selection
        ? {
            id: selection.id,
            side: selection.side,
            position: selection.range.start,
          }
        : symbol.current;
    }, [sourceSelection]);

    const highlightSearch = useCallback(
      (node: HTMLElement, id: string) => {
        const current = refs.current;
        const content = current.loaded[id]?.content;
        const query =
          id === current.selected &&
          content &&
          !content.deferred &&
          !["binary", "conflict", "submodule"].includes(content.kind)
            ? (current.findQuery ?? "")
            : "";
        if (!query && !searchedNodes.current.has(node)) return;
        if (query) searchedNodes.current.add(node);
        else searchedNodes.current.delete(node);
        for (const line of node.shadowRoot?.querySelectorAll<HTMLElement>(
          "[data-code] [data-line][data-line-type]",
        ) ?? []) {
          const match = query ? current.findMatch : undefined;
          const position = positionAt(line, id);
          const shared =
            current.snapshot.comparison.view === "changes" &&
            current.preferences.diffLayout === "unified" &&
            ["context", "context-expanded"].includes(
              line.dataset.lineType ?? "",
            );
          const active =
            match &&
            (shared
              ? sharedLinePosition(
                  line,
                  match.side,
                  Number(line.dataset.line),
                ) ===
                match.line - 1
              : position.side === match.side &&
                position.position.line === match.line - 1)
              ? match
              : undefined;
          highlightSearchLine(line, query, active);
          if (active && pendingFindScroll.current === active) {
            const mark = line.querySelector<HTMLElement>(
              ".search-match-active",
            );
            const column = line.closest<HTMLElement>("[data-code]");
            if (mark && column) {
              const bounds = mark.getBoundingClientRect();
              const viewport = column.getBoundingClientRect();
              if (bounds.left < viewport.left)
                column.scrollLeft += bounds.left - viewport.left - 16;
              else if (bounds.right > viewport.right)
                column.scrollLeft += bounds.right - viewport.right + 16;
              pendingFindScroll.current = null;
              horizontalScrollbar.current?.sync();
            }
          }
        }
      },
      [positionAt],
    );

    useEffect(() => {
      pendingFindScroll.current = props.findMatch ?? null;
      for (const item of viewer.current?.getInstance()?.getRenderedItems() ??
        [])
        highlightSearch(item.element, item.id);
    }, [props.findQuery, props.findMatch, selected, highlightSearch]);

    useEffect(() => {
      if (!contextMenu) return;
      const close = () => setContextMenu(null);
      const keys = (event: KeyboardEvent) => {
        if (event.key === "Escape") close();
      };
      window.addEventListener("click", close);
      window.addEventListener("keydown", keys);
      return () => {
        window.removeEventListener("click", close);
        window.removeEventListener("keydown", keys);
      };
    }, [contextMenu]);

    useEffect(() => {
      let active = true;
      pool
        ?.setRenderOptions({
          useTokenTransformer: true,
          theme: rendererThemeId(theme),
          tokenizeMaxLineLength: 1500,
          maxLineDiffLength: 1500,
          lineDiffType: "word-alt",
        })
        .then(() => {
          if (active) setHighlighterVersion((v) => v + 1);
        })
        .catch((error) => {
          if (active) onError(String(error));
          recordDiagnosticError("highlight.options.error", error);
        });
      return () => {
        active = false;
      };
    }, [pool, theme, onError]);

    const navigate = useCallback(
      (id: string, line?: number, side?: "old" | "new") => {
        const handle = viewer.current;
        recordDiagnostic("viewer.jump", {
          ...diagnosticFile(refs.current.snapshot, id),
          line,
          side,
          handlePresent: !!handle,
        });
        if (!handle) return;
        handle.scrollTo({
          type: "item",
          id,
          align: "start",
          behavior: "instant",
        });
        const instance = handle.getInstance();
        // Commit programmatic navigation even when the OS suspends animation frames.
        instance?.render(true);
        if (line !== undefined) {
          symbol.current = {
            id,
            side: side ?? "new",
            position: { line: line - 1, character: 0 },
          };
          const rendered = instance
            ?.getRenderedItems()
            .find((entry) => entry.item.id === id);
          if (rendered?.type === "diff") {
            // Search and comment jumps must also reach lines inside collapsed context.
            for (let i = 0; i <= rendered.item.fileDiff.hunks.length; i++)
              rendered.instance.expandHunk(i, "both", Number.MAX_SAFE_INTEGER);
            instance?.render(true);
          }
          handle.scrollTo({
            type: "line",
            id,
            lineNumber: line,
            side: side === "old" ? "deletions" : "additions",
            align: "center",
            behavior: "instant",
          });
          handle.setSelectedLines({
            id,
            range: {
              start: line,
              end: line,
              ...(refs.current.snapshot.comparison.view === "changes"
                ? {
                    side:
                      side === "old"
                        ? ("deletions" as const)
                        : ("additions" as const),
                  }
                : {}),
            },
          });
          setSelectedLine({ id, line, side });
          instance?.render(true);
        }
      },
      [],
    );
    const jump = useCallback(
      (id: string, line?: number, side?: "old" | "new") => {
        targetRange.current = null;
        restoring.current = null;
        horizontalScrollbar.current?.restore(null);
        setCollapsed((current) => {
          if (!current.has(id)) return current;
          const next = new Set(current);
          next.delete(id);
          return next;
        });
        const content = refs.current.loaded[id]?.content;
        const needsRetry =
          !content ||
          content.deferred ||
          collapsed.has(id) ||
          viewer.current?.getInstance()?.getTopForItem(id) === undefined;
        pendingJump.current = needsRetry ? { id, line, side } : null;
        navigate(id, line, side);
        refs.current.onLoad(id);
      },
      [navigate, collapsed],
    );
    const restoreScroll = useCallback((top: number) => {
      const handle = viewer.current;
      const instance = handle?.getInstance();
      if (!handle || !instance) return;
      handle.scrollTo({ type: "position", position: top, behavior: "instant" });
      instance.render(true);
      // CodeView's position target aligns below its sticky header. History
      // stores the exact logical offset, so correct that alignment natively
      // after the virtualizer has established the appropriate scroll page.
      const container = instance.getContainerElement();
      if (container && Math.abs(instance.getScrollTop() - top) > 0.5) {
        container.scrollTop += top - instance.getScrollTop();
        container.dispatchEvent(new Event("scroll"));
        instance.render(true);
      }
    }, []);
    useImperativeHandle(
      outerRef,
      () => ({
        jump,
        sourcePosition,
        reveal: (id, range, side) => {
          jump(id, range.start.line + 1, side);
          symbol.current = { id, side: side ?? "new", position: range.start };
          targetRange.current = { id, range, side: side ?? "new" };
          queueMicrotask(highlightTarget);
        },
        capture: () => {
          const instance = viewer.current?.getInstance();
          const top = instance?.getScrollTop() ?? scroll.current;
          const rendered = instance?.getRenderedItems() ?? [];
          const active =
            rendered
              .filter(
                (item) =>
                  (instance?.getTopForItem(item.id) ?? Infinity) <= top + 1,
              )
              .at(-1) ??
            rendered.find((item) => item.id === refs.current.selected);
          let anchor: ViewportState["anchor"];
          if (active && instance) {
            const fileTop = instance.getTopForItem(active.id) ?? 0;
            anchor = { id: active.id, offset: top - fileTop };
            const file = refs.current.loaded[active.id];
            if (
              file &&
              !file.content.deferred &&
              !collapsed.has(active.id) &&
              top > fileTop
            ) {
              const header =
                active.element
                  .querySelector(".file-heading")
                  ?.getBoundingClientRect().height ?? 0;
              const line = active.instance.getNumericScrollAnchor(
                top - fileTop + header,
              );
              if (line) {
                const side =
                  "side" in line && line.side === "deletions" ? "old" : "new";
                anchor.line = {
                  number: line.lineNumber,
                  side,
                  offset: fileTop + line.top - top,
                  text: sourceLines(file, side)[line.lineNumber - 1] ?? "",
                };
              }
            }
          }
          const horizontal: Record<string, number[]> = {};
          for (const item of rendered) {
            horizontal[item.id] = Array.from(
              item.element.shadowRoot?.querySelectorAll<HTMLElement>(
                "[data-code]",
              ) ?? [],
            ).map((node) => node.scrollLeft);
          }
          return {
            top,
            anchor,
            fingerprints: Object.fromEntries(
              Object.entries(refs.current.loaded)
                .filter(([, file]) => !file.content.deferred)
                .map(([id, file]) => [id, file.content.fingerprint]),
            ),
            manuallyLoaded: refs.current.snapshot.files
              .filter(
                (entry) =>
                  entry.deferred &&
                  refs.current.loaded[entry.id] &&
                  !refs.current.loaded[entry.id].content.deferred,
              )
              .map((entry) => entry.id),
            horizontal,
            collapsed: [...collapsed],
            expanded: structuredClone(expansions.current),
            symbol: sourcePosition(),
            selectedLine,
            selection: sourceSelection(),
          };
        },
        restoreState: (state, onRefreshRestored) => {
          restoring.current = state;
          refreshRestored.current = onRefreshRestored;
          expansionRestored.current = new WeakSet();
          // Hunk indices only remain meaningful for unchanged source. Validate
          // fingerprints as fresh files arrive before replaying their expansion.
          expansions.current = onRefreshRestored
            ? {}
            : structuredClone(state.expanded);
          symbol.current = state.symbol;
          targetRange.current = state.selection;
          setCollapsed(new Set(state.collapsed));
          setSelectedLine(state.selectedLine);
        },
        scrollTop: () => scroll.current,
        restore: restoreScroll,
      }),
      [
        jump,
        collapsed,
        selectedLine,
        sourcePosition,
        sourceSelection,
        highlightTarget,
        restoreScroll,
      ],
    );

    // Changes always contains the same file list. Moving the active highlight
    // must not rebuild its item array or ask the virtualizer to reconcile it.
    const codeSelection = snapshot.comparison.view === "code" ? selected : null;
    const items = useMemo(() => {
      const files =
        snapshot.comparison.view === "code"
          ? snapshot.files.filter((f) => f.id === codeSelection)
          : snapshot.files;
      const validIds = new Set(files.map((f) => f.id));
      for (const id of itemCache.current.keys())
        if (!validIds.has(id)) itemCache.current.delete(id);
      return files.map((entry): CodeViewItem<ReviewComment> => {
        const value = loaded[entry.id];
        const comments = queue.comments.filter(
          (c) =>
            c.path === entry.path &&
            !c.outdated &&
            c.anchor.fingerprint === value?.content.fingerprint,
        );
        const isCollapsed = collapsed.has(entry.id);
        const key = JSON.stringify([
          snapshot.id,
          highlighterVersion,
          value?.content.fingerprint,
          value?.content.deferred,
          value?.content.tabWidth,
          errors[entry.id],
          comments.map((c) => [c.id, c.updatedAt]),
          isCollapsed,
        ]);
        const cached = itemCache.current.get(entry.id);
        if (cached?.key === key) return cached.item;
        const version = (cached?.item.version ?? 0) + 1;
        let item: CodeViewItem<ReviewComment>;
        if (value?.diff && snapshot.comparison.view === "changes") {
          item = {
            id: entry.id,
            type: "diff",
            fileDiff: value.diff,
            version,
            collapsed: isCollapsed,
            annotations: comments.map((c) => ({
              lineNumber: c.anchor.line ?? 0,
              side: c.anchor.side === "old" ? "deletions" : "additions",
              metadata: c,
            })),
          };
        } else {
          const content = value?.content;
          let contents = content?.newContent ?? content?.oldContent ?? "";
          const summary =
            !content ||
            content.deferred ||
            ["binary", "conflict", "submodule"].includes(content.kind);
          if (summary)
            contents =
              errors[entry.id] ??
              (entry.deferred || content?.deferred
                ? "Large file — load its contents to inspect."
                : content?.kind === "binary"
                  ? "Binary file — source preview is unavailable."
                  : content?.kind === "conflict"
                    ? "Unresolved merge conflict — resolve it in your editor, then refresh."
                    : content?.kind === "submodule"
                      ? "Submodule change — inspect this repository separately."
                      : "Loading file…");
          if (summary && content && !content.deferred)
            contents += `\n${content.size.toLocaleString()} bytes · ${content.status}\n${content.metadata}`;
          // The renderer prepares layout and renders against the same file
          // object. Feedback, collapse and theme changes must only replace the
          // surrounding item, not unchanged source. Summary messages also need
          // distinct keys, even before a content fingerprint is available.
          const cacheKey = JSON.stringify([
            "file",
            entry.path,
            content?.fingerprint || snapshot.id,
            summary ? contents : null,
          ]);
          const previousFile =
            cached?.item.type === "file" ? cached.item.file : undefined;
          item = {
            id: entry.id,
            type: "file",
            file:
              previousFile?.cacheKey === cacheKey
                ? previousFile
                : {
                    name: entry.path,
                    contents,
                    ...(summary ? { lang: "text" as const } : {}),
                    cacheKey,
                  },
            version,
            collapsed: isCollapsed,
            annotations: comments.map((c) => ({
              lineNumber: c.anchor.line ?? 0,
              metadata: c,
            })),
          };
        }
        itemCache.current.set(entry.id, { key, item });
        return item;
      });
    }, [
      snapshot,
      codeSelection,
      loaded,
      errors,
      queue.comments,
      collapsed,
      highlighterVersion,
    ]);

    useEffect(() => {
      const target = pendingJump.current;
      if (target && loaded[target.id] && !loaded[target.id].content.deferred) {
        navigate(target.id, target.line, target.side);
        pendingJump.current = null;
      }
    }, [items, loaded, navigate, selected]);

    useEffect(() => {
      const state = restoring.current;
      const handle = viewer.current;
      if (!state || !handle) return;
      const refreshing = !!refreshRestored.current;
      const anchor = refreshing ? state.anchor : undefined;
      if (anchor && !loaded[anchor.id] && !errors[anchor.id]) {
        refs.current.onLoad(
          anchor.id,
          state.manuallyLoaded?.includes(anchor.id),
        );
        return;
      }
      // Instantiate expanded files before restoring their logical scroll offset.
      for (const id of Object.keys(state.expanded)) {
        if (errors[id]) continue;
        if (!loaded[id]) {
          refs.current.onLoad(id, state.manuallyLoaded?.includes(id));
          return;
        }
        if (
          loaded[id].content.deferred ||
          (refreshing &&
            loaded[id].content.fingerprint !== state.fingerprints?.[id])
        )
          continue;
        expansions.current[id] = structuredClone(state.expanded[id]);
        handle.scrollTo({ type: "item", id, behavior: "instant" });
        handle.getInstance()?.render(true);
        const context = handle
          .getInstance()
          ?.getRenderedItems()
          .find((item) => item.id === id);
        if (
          context?.type === "diff" &&
          !expansionRestored.current.has(context.instance)
        ) {
          replaying.current = true;
          for (const action of state.expanded[id])
            context.instance.expandHunk(
              action.hunk,
              action.direction,
              action.count,
            );
          replaying.current = false;
          expansionRestored.current.add(context.instance);
          handle.getInstance()?.render(true);
        }
      }
      if (anchor) {
        handle.scrollTo({ type: "item", id: anchor.id, behavior: "instant" });
        const instance = handle.getInstance();
        instance?.render(true);
        const context = instance
          ?.getRenderedItems()
          .find((item) => item.id === anchor.id);
        const file = loaded[anchor.id];
        let offset = !file || file.content.deferred ? 0 : anchor.offset;
        if (
          anchor.line &&
          context &&
          file &&
          !file.content.deferred &&
          !collapsed.has(anchor.id)
        ) {
          const saved = anchor.line;
          const lines = sourceLines(file, saved.side);
          let number = Math.max(1, Math.min(saved.number, lines.length));
          // Keep the same source line when edits have inserted lines above it.
          if (lines[number - 1] !== saved.text && saved.text.trim()) {
            let distance = Infinity;
            lines.forEach((text, index) => {
              if (
                text === saved.text &&
                Math.abs(index + 1 - saved.number) < distance
              ) {
                number = index + 1;
                distance = Math.abs(number - saved.number);
              }
            });
          }
          if (
            context.type === "diff" &&
            file.content.fingerprint !== state.fingerprints?.[anchor.id]
          ) {
            for (
              let hunk = 0;
              hunk <= context.item.fileDiff.hunks.length;
              hunk++
            )
              context.instance.expandHunk(
                hunk,
                "both",
                Number.MAX_SAFE_INTEGER,
              );
            instance?.render(true);
          }
          const position = context.instance.getLinePosition(
            number,
            saved.side === "old" ? "deletions" : "additions",
          );
          if (position) offset = position.top - saved.offset;
        }
        const height = context?.instance.getVirtualizedHeight();
        offset = Math.max(
          0,
          Math.min(offset, height === undefined ? offset : height - 1),
        );
        restoreScroll((instance?.getTopForItem(anchor.id) ?? 0) + offset);
      } else restoreScroll(state.top);
      if (state.selectedLine)
        handle.setSelectedLines({
          id: state.selectedLine.id,
          range: {
            start: state.selectedLine.line,
            end: state.selectedLine.line,
            ...(snapshot.comparison.view === "changes"
              ? {
                  side:
                    state.selectedLine.side === "old"
                      ? ("deletions" as const)
                      : ("additions" as const),
                }
              : {}),
          },
        });
      highlightTarget();
      for (const item of handle.getInstance()?.getRenderedItems() ?? []) {
        Array.from(
          item.element.shadowRoot?.querySelectorAll<HTMLElement>(
            "[data-code]",
          ) ?? [],
        ).forEach((node, i) => {
          node.scrollLeft = state.horizontal[item.id]?.[i] ?? 0;
        });
      }
      horizontalScrollbar.current?.sync();
      const horizontalId = state.anchor?.id ?? refs.current.selected;
      if (horizontalId)
        horizontalScrollbar.current?.restore({
          id: horizontalId,
          left: Math.max(0, ...(state.horizontal[horizontalId] ?? [])),
        });
      symbol.current = state.symbol;
      restoring.current = null;
      const complete = refreshRestored.current;
      refreshRestored.current = undefined;
      complete?.();
    }, [
      items,
      loaded,
      errors,
      collapsed,
      snapshot.comparison.view,
      highlightTarget,
      restoreScroll,
    ]);

    const options = useMemo<CodeViewReactOptions<ReviewComment, undefined>>(
      () => ({
        diffStyle: preferences.diffLayout,
        theme: rendererThemeId(theme),
        themeType: theme.kind,
        preferredHighlighter: "shiki-wasm",
        useTokenTransformer: true,
        diffIndicators: "classic",
        overflow: "scroll",
        enableGutterUtility: !props.navigationOnly,
        enableLineSelection: true,
        // File navigation scrolls the viewer; its visible controls must stay clickable.
        pointerEventsOnScroll: true,
        stickyHeaders: true,
        lineHoverHighlight: "both",
        expansionLineCount: 30,
        hunkSeparators: "line-info",
        onTokenClick(token, event, context) {
          targetRange.current = null;
          const line = token.tokenElement.closest<HTMLElement>(
            "[data-line][data-line-type]",
          );
          if (!line) return;
          const target = positionAt(
            line,
            context.item.id,
            event,
            token.lineCharStart,
            "side" in token && token.side === "deletions" ? "old" : "new",
          );
          symbol.current = target;
          if (
            /Mac|iPhone|iPad/.test(navigator.platform)
              ? event.metaKey
              : event.ctrlKey
          ) {
            event.preventDefault();
            refs.current.onNavigate?.(target, "auto");
          }
        },
        onLineClick(line, context) {
          targetRange.current = null;
          if (!line.numberColumn) {
            const target = positionAt(
              line.lineElement,
              context.item.id,
              line.event,
            );
            symbol.current = target;
            if (
              !line.event.defaultPrevented &&
              (/Mac|iPhone|iPad/.test(navigator.platform)
                ? line.event.metaKey
                : line.event.ctrlKey)
            ) {
              line.event.preventDefault();
              refs.current.onNavigate?.(target, "auto");
            }
          }
        },
        itemMetrics: {
          lineHeight: Math.round((preferences.codeFontSize * 22) / 12),
        },
        layout: { paddingTop: 0, paddingBottom: 40, gap: 18 },
        unsafeCSS:
          viewerCSS +
          searchCSS +
          `:host { --diffs-font-size: ${preferences.codeFontSize}px; --diffs-line-height: ${Math.round((preferences.codeFontSize * 22) / 12)}px; }` +
          (preferences.showWhitespace ? whitespaceCSS : ""),
        onPostRender(node, _instance, phase, context) {
          horizontalScrollbar.current?.refresh(
            phase !== "unmount" && context.item.id === refs.current.selected,
          );
          if (phase === "unmount") return;
          const props = refs.current;
          const id = context.item.id;
          node.dataset.navigationId = id;
          const last = lastDiagnosticRender.current;
          if (
            id === props.selected &&
            (last?.snapshotId !== props.snapshot.id ||
              last.id !== id ||
              last.version !== context.item.version)
          ) {
            lastDiagnosticRender.current = {
              snapshotId: props.snapshot.id,
              id,
              version: context.item.version,
            };
            recordDiagnostic("viewer.rendered", {
              ...diagnosticFile(props.snapshot, id),
              type: context.type,
              phase,
              loaded: !!props.loaded[id],
              collapsed: context.item.collapsed ?? false,
            });
          }
          if (targetRange.current?.id === id) queueMicrotask(highlightTarget);
          if (
            context.type === "diff" &&
            !instrumented.current.has(context.instance)
          ) {
            instrumented.current.add(context.instance);
            const expand = context.instance.expandHunk;
            context.instance.expandHunk = (hunk, direction, count) => {
              if (!replaying.current) {
                const actions = (expansions.current[id] ??= []);
                const existing = actions.find(
                  (action) =>
                    action.hunk === hunk && action.direction === direction,
                );
                const amount = Math.min(count ?? 30, Number.MAX_SAFE_INTEGER);
                if (existing)
                  existing.count = Math.min(
                    (existing.count ?? 30) + amount,
                    Number.MAX_SAFE_INTEGER,
                  );
                else actions.push({ hunk, direction, count: amount });
              }
              expand(hunk, direction, count);
            };
            const recorded = expansions.current[id];
            if (recorded?.length) {
              replaying.current = true;
              for (const action of recorded)
                expand(action.hunk, action.direction, action.count);
              replaying.current = false;
              expansionRestored.current.add(context.instance);
            }
          }
          const content = props.loaded[id]?.content;
          node.style.setProperty(
            "--diffs-tab-size",
            String(content?.tabWidth ?? props.preferences.tabWidth),
          );
          if (props.preferences.showWhitespace)
            decorateWhitespace(node.shadowRoot ?? node);
          highlightSearch(node, id);
          for (const button of (
            node.shadowRoot ?? node
          ).querySelectorAll<HTMLElement>("[data-expand-button]")) {
            button.tabIndex = 0;
            button.setAttribute(
              "aria-label",
              button.hasAttribute("data-expand-all-button")
                ? "Expand all context"
                : button.hasAttribute("data-expand-up")
                  ? "Show preceding lines"
                  : "Show following lines",
            );
            if (!button.dataset.inspectorKeyboard) {
              button.dataset.inspectorKeyboard = "true";
              button.addEventListener("keydown", (event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  event.stopPropagation();
                  button.click();
                }
              });
            }
          }
          if (!content && !props.errors[id])
            queueMicrotask(() => props.onLoad(id));
        },
      }),
      [
        preferences.diffLayout,
        preferences.showWhitespace,
        preferences.codeFontSize,
        theme,
        props.navigationOnly,
        positionAt,
        highlightTarget,
        highlightSearch,
      ],
    );

    const renderHeader = useCallback(
      (item: CodeViewItem<ReviewComment>) => {
        const entry = entries.get(item.id)!;
        const data = loaded[item.id]?.content;
        const large = data?.deferred || (!data && entry.deferred);
        const reviewed =
          !!data?.fingerprint &&
          queue.reviewed[entry.path] === data.fingerprint;
        return (
          <div className="file-heading" data-file-path={entry.path}>
            <button
              className="icon-button"
              aria-label={`${collapsed.has(item.id) ? "Expand" : "Collapse"} ${entry.path}`}
              onClick={() =>
                setCollapsed((current) => {
                  const next = new Set(current);
                  if (next.has(item.id)) next.delete(item.id);
                  else next.add(item.id);
                  return next;
                })
              }
            >
              {collapsed.has(item.id) ? (
                <ChevronRight size={15} />
              ) : (
                <ChevronDown size={15} />
              )}
            </button>
            <FileCode2 size={15} className="muted" />
            <span className="file-heading-name" title={entry.path}>
              {entry.oldPath && (
                <span className="muted">{entry.oldPath} → </span>
              )}
              {entry.path}
            </span>
            {entry.additions > 0 && (
              <span className="add">+{entry.additions}</span>
            )}
            {entry.deletions > 0 && (
              <span className="remove">−{entry.deletions}</span>
            )}
            {!data && !large && !errors[item.id] && (
              <LoaderCircle size={13} className="spin muted" />
            )}
            {large && (
              <button
                className="small-button"
                onClick={() => onLoad(item.id, true)}
              >
                Load {snapshot.comparison.view === "code" ? "file" : "diff"}
              </button>
            )}
            {errors[item.id] && (
              <button
                className="small-button"
                onClick={() => onLoad(item.id, true)}
              >
                Retry
              </button>
            )}
            {!props.navigationOnly && (
              <button
                className="icon-button"
                aria-label={`Comment on file ${entry.path}`}
                title="Comment on file"
                onClick={() => onComment(item.id)}
              >
                <MessageSquarePlus size={15} />
              </button>
            )}
            {snapshot.comparison.view === "changes" && (
              <label
                className={`review-check ${reviewed ? "is-reviewed" : ""}`}
              >
                <input
                  type="checkbox"
                  checked={reviewed}
                  onChange={(e) => onReviewed(item.id, e.target.checked)}
                />
                Reviewed
              </label>
            )}
          </div>
        );
      },
      [
        entries,
        loaded,
        queue.reviewed,
        collapsed,
        errors,
        onComment,
        onReviewed,
        onLoad,
        snapshot.comparison.view,
        props.navigationOnly,
      ],
    );

    return (
      <div
        ref={surface}
        className="viewer-surface"
        onContextMenu={(event) => {
          const path = event.nativeEvent.composedPath();
          const line = path.find(
            (node): node is HTMLElement =>
              node instanceof HTMLElement &&
              node.matches("[data-line][data-line-type]"),
          );
          const host = path.find(
            (node): node is HTMLElement =>
              node instanceof HTMLElement && !!node.dataset.navigationId,
          );
          if (!line || !host) return;
          event.preventDefault();
          const position = positionAt(
            line,
            host.dataset.navigationId!,
            event.nativeEvent,
          );
          symbol.current = position;
          setContextMenu({
            x: Math.min(event.clientX, window.innerWidth - 220),
            y: Math.min(event.clientY, window.innerHeight - 90),
            position,
          });
        }}
      >
        <CodeView<ReviewComment>
          ref={viewer}
          className="code-view"
          items={items}
          options={options}
          onSelectedLinesChange={(selection) =>
            setSelectedLine(
              selection
                ? {
                    id: selection.id,
                    line: selection.range.start,
                    side: selection.range.side === "deletions" ? "old" : "new",
                  }
                : null,
            )
          }
          onScroll={(top, instance) => {
            scroll.current = top;
            const current = refs.current;
            if (current.snapshot.comparison.view === "changes") {
              // Use the virtualizer's logical offsets, not overscanned DOM nodes.
              // Only a file boundary changes React state; scrolling within a file
              // stays independent of the navigator and never initiates a jump.
              const files = current.snapshot.files;
              let low = 0;
              let high = files.length - 1;
              let active: string | undefined;
              while (low <= high) {
                const middle = (low + high) >>> 1;
                const fileTop = instance.getTopForItem(files[middle].id);
                if (fileTop === undefined) break;
                if (fileTop <= top + 1) {
                  active = files[middle].id;
                  low = middle + 1;
                } else high = middle - 1;
              }
              if (active && active !== current.selected) {
                // Moving on cancels an unfinished jump to a still-loading file.
                if (pendingJump.current?.id !== active)
                  pendingJump.current = null;
                current.onActiveFileChange(current.snapshot.id, active);
              }
            }
            onScroll(top);
            horizontalScrollbar.current?.refresh();
          }}
          renderCustomHeader={renderHeader}
          renderGutterUtility={(getHoveredLine, item) => (
            <button
              className="gutter-comment"
              aria-label="Comment on line"
              onPointerDownCapture={(event) => {
                // Keep the renderer's line-selection gesture from moving the
                // slotted + button before its click can open the composer.
                event.stopPropagation();
              }}
              onClick={() => {
                const hovered = getHoveredLine();
                if (
                  !hovered ||
                  !loaded[item.id] ||
                  loaded[item.id].content.deferred
                )
                  return;
                onComment(
                  item.id,
                  hovered.lineNumber,
                  snapshot.comparison.view === "changes"
                    ? "side" in hovered && hovered.side === "deletions"
                      ? "old"
                      : "new"
                    : undefined,
                );
              }}
            >
              <Plus size={13} />
            </button>
          )}
          renderAnnotation={(annotation) => (
            <div className="inline-comment">
              <div className="inline-comment-label">
                <span className="avatar">Y</span>
                <strong>You</strong>
                <span className="muted">
                  {annotation.metadata.scope === "file"
                    ? "File comment"
                    : `Line ${annotation.metadata.anchor.line}`}
                </span>
              </div>
              <p>{annotation.metadata.body}</p>
            </div>
          )}
          renderCodeViewFooter={() => (
            <div className="viewer-footer">
              {snapshot.comparison.view === "changes"
                ? `${snapshot.files.length} changed files · `
                : ""}
              {props.navigationOnly
                ? "Read-only source · Ctrl+- to go back"
                : "Read-only source · Your feedback is saved locally"}
            </div>
          )}
        />
        <HorizontalScrollbar
          ref={horizontalScrollbar}
          path={selected ? entries.get(selected)?.path : undefined}
          getHost={() =>
            viewer.current
              ?.getInstance()
              ?.getRenderedItems()
              .find((item) => item.id === refs.current.selected)?.element
          }
        />
        {contextMenu && (
          <div
            className="navigation-context-menu"
            role="menu"
            style={{ left: contextMenu.x, top: contextMenu.y }}
          >
            <button
              role="menuitem"
              onClick={() =>
                refs.current.onNavigate?.(contextMenu.position, "auto")
              }
            >
              Go to Definition <kbd>F12</kbd>
            </button>
            <button
              role="menuitem"
              onClick={() =>
                refs.current.onNavigate?.(contextMenu.position, "references")
              }
            >
              Find References
            </button>
          </div>
        )}
      </div>
    );
  },
);
