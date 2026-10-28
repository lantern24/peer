import type { NavigationResult } from "./types";

export type SourcePosition = { line: number; character: number };
export type SourceRange = { start: SourcePosition; end: SourcePosition };
export type SymbolPosition = {
  id: string;
  side: "old" | "new";
  position: SourcePosition;
};
export type ViewportState = {
  top: number;
  anchor?: {
    id: string;
    offset: number;
    line?: {
      number: number;
      side: "old" | "new";
      // Visual offset below the sticky file header, including wrapped continuations.
      offset: number;
      text: string;
    };
  };
  fingerprints?: Record<string, string>;
  manuallyLoaded?: string[];
  collapsed: string[];
  expanded: Record<
    string,
    { hunk: number; direction: "up" | "down" | "both"; count?: number }[]
  >;
  symbol: SymbolPosition | null;
  selection: { id: string; side: "old" | "new"; range: SourceRange } | null;
  selectedLine: { id: string; line: number; side?: "old" | "new" } | null;
};
export type NavigationPage = {
  documentId: string;
  side: "old" | "new";
  range: SourceRange;
};
export type HistoryEntry = {
  navigationSide: "old" | "new";
  selected: string | null;
  page: NavigationPage | null;
  viewport: ViewportState | null;
  results: NavigationResult | null;
  resultsVisible: boolean;
};

export class NavigationHistory {
  private entries: HistoryEntry[] = [];
  get length() {
    return this.entries.length;
  }
  push(entry: HistoryEntry) {
    const previous = this.entries.at(-1);
    if (previous && JSON.stringify(previous) === JSON.stringify(entry)) return;
    this.entries.push(entry);
    if (this.entries.length > 100) this.entries.shift();
  }
  pop() {
    return this.entries.pop();
  }
  peek() {
    return this.entries.at(-1);
  }
  clear() {
    this.entries = [];
  }
}

export function navigationError(error: unknown): {
  code: string;
  message: string;
} {
  if (error && typeof error === "object" && "message" in error)
    return {
      code: "code" in error ? String(error.code) : "error",
      message: String(error.message),
    };
  return { code: "error", message: String(error) };
}

export function isTyping(event: KeyboardEvent) {
  return (
    !!document.querySelector("dialog[open]") ||
    event
      .composedPath()
      .some(
        (node) =>
          node instanceof HTMLElement &&
          (node.matches("input, textarea, select") || node.isContentEditable),
      )
  );
}

/** Count source characters, never rendered pixels or tab columns. */
export function textOffset(
  line: HTMLElement,
  node: Node,
  offset: number,
): number | null {
  if (!line.contains(node)) return null;
  const range = document.createRange();
  range.selectNodeContents(line);
  try {
    range.setEnd(node, offset);
  } catch {
    return null;
  }
  return range.toString().length;
}

export function pointerCharacter(
  event: MouseEvent,
  line: HTMLElement,
  fallback = 0,
): number {
  const doc = document as Document & {
    caretPositionFromPoint?: (
      x: number,
      y: number,
      options?: { shadowRoots: ShadowRoot[] },
    ) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const root = line.getRootNode();
  const caret = doc.caretPositionFromPoint?.(event.clientX, event.clientY, {
    shadowRoots: root instanceof ShadowRoot ? [root] : [],
  });
  if (caret) {
    const result = textOffset(line, caret.offsetNode, caret.offset);
    if (result !== null) return result;
  }
  const range = doc.caretRangeFromPoint?.(event.clientX, event.clientY);
  if (range) {
    const result = textOffset(line, range.startContainer, range.startOffset);
    if (result !== null) return result;
  }
  // Older WebKit may not expose shadow-root caret APIs. Use text-node ranges
  // for precise hit testing, including multi-character Shiki tokens and tabs.
  const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
  let before = 0;
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    for (let i = 0; i < node.length; i++) {
      const character = document.createRange();
      character.setStart(node, i);
      character.setEnd(node, i + 1);
      const box = character.getBoundingClientRect();
      if (
        event.clientX >= box.left &&
        event.clientX < box.right &&
        event.clientY >= box.top &&
        event.clientY <= box.bottom
      )
        return before + i;
    }
    before += node.length;
  }
  return fallback;
}

export function sharedLinePosition(
  line: HTMLElement,
  side: "old" | "new",
  fallbackLine: number,
): number {
  // Unified context is rendered from B; data-alt-line is its A coordinate.
  // data-line-index contains virtualizer indices, not source coordinates.
  const value = side === "old" ? line.dataset.altLine : line.dataset.line;
  if (value !== undefined && Number(value) > 0) return Number(value) - 1;
  return fallbackLine - 1;
}
