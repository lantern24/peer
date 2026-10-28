import { describe, expect, it } from "vitest";
import {
  NavigationHistory,
  navigationError,
  type HistoryEntry,
} from "./navigation";

const entry = (selected: string): HistoryEntry => ({
  selected,
  navigationSide: "new",
  page: null,
  viewport: {
    top: 42,
    collapsed: ["other"],
    expanded: {},
    symbol: { id: selected, side: "old", position: { line: 5, character: 4 } },
    selection: null,
    selectedLine: null,
  },
  results: null,
  resultsVisible: false,
});
describe("navigation history", () => {
  it("restores versioned source, viewport and results without retaining source payloads", () => {
    const history = new NavigationHistory();
    const origin = entry("call.ts");
    const definition = {
      ...entry("call.ts"),
      page: {
        documentId: "def-A",
        side: "old" as const,
        range: {
          start: { line: 8, character: 4 },
          end: { line: 8, character: 8 },
        },
      },
    };
    history.push(origin);
    history.push(definition);
    expect(history.pop()).toEqual(definition);
    expect(history.pop()).toEqual(origin);
    expect(history.length).toBe(0);
  });
  it("deduplicates consecutive entries and bounds retained history", () => {
    const history = new NavigationHistory();
    for (let i = 0; i < 105; i++) {
      history.push(entry(String(i)));
      history.push(entry(String(i)));
    }
    expect(history.length).toBe(100);
    for (let i = 104; i >= 5; i--)
      expect(history.pop()?.selected).toBe(String(i));
    history.push(entry("a"));
    history.clear();
    expect(history.peek()).toBeUndefined();
  });
  it("preserves structured command errors", () => {
    expect(navigationError({ code: "stale", message: "Refresh" })).toEqual({
      code: "stale",
      message: "Refresh",
    });
    expect(navigationError("Oops").message).toBe("Oops");
  });
});
