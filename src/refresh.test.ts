import { describe, expect, it } from "vitest";
import { refreshedViewport } from "./refresh";
import type { ViewportState } from "./navigation";
import type { FileEntry } from "./types";

const file = (path: string, oldPath: string | null = null): FileEntry => ({
  id: path,
  path,
  oldPath,
  status: "modified",
  kind: "text",
  additions: 1,
  deletions: 1,
  size: 100,
  deferred: false,
});
const state: ViewportState = {
  top: 5000,
  anchor: {
    id: "b",
    offset: 250,
    line: { number: 20, side: "old", offset: 40, text: "target" },
  },
  fingerprints: { b: "before" },
  manuallyLoaded: ["b"],
  collapsed: ["a"],
  expanded: { b: [{ hunk: 0, direction: "up" }] },
  symbol: { id: "b", side: "old", position: { line: 19, character: 3 } },
  selection: {
    id: "b",
    side: "old",
    range: {
      start: { line: 19, character: 3 },
      end: { line: 20, character: 7 },
    },
  },
  selectedLine: { id: "b", line: 20, side: "old" },
};
const previous = [file("a"), file("b"), file("c")];
describe("refresh viewport", () => {
  it("follows a renamed file and remaps its side, selection, and display state", () => {
    const result = refreshedViewport(state, previous, [
      file("added"),
      file("renamed", "b"),
      file("c"),
    ])!;
    expect(result.anchor).toEqual({ ...state.anchor, id: "renamed" });
    expect(result.expanded).toEqual({ renamed: state.expanded.b });
    expect(result.fingerprints).toEqual({ renamed: "before" });
    expect(result.manuallyLoaded).toEqual(["renamed"]);
    expect(result.selectedLine).toEqual({
      ...state.selectedLine,
      id: "renamed",
    });
    expect(result.symbol).toEqual({
      id: "renamed",
      side: "old",
      position: { line: 19, character: 3 },
    });
    expect(result.selection).toEqual({
      id: "renamed",
      side: "old",
      range: {
        start: { line: 19, character: 3 },
        end: { line: 20, character: 7 },
      },
    });
    expect(result.collapsed).toEqual([]);
  });
  it("falls forward, then backward, when the viewed diff disappears", () => {
    expect(
      refreshedViewport(state, previous, [file("a"), file("c")])?.anchor,
    ).toEqual({ id: "c", offset: 0 });
    const result = refreshedViewport(state, previous, [file("a")])!;
    expect(result.anchor).toEqual({ id: "a", offset: 0 });
    expect(result.selectedLine).toBeNull();
    expect(result.symbol).toBeNull();
    expect(result.selection).toBeNull();
    expect(result.expanded).toEqual({});
    expect(refreshedViewport(state, previous, [])).toBeNull();
  });
  it("does not reuse an external source page as a review anchor", () => {
    expect(
      refreshedViewport(
        { ...state, anchor: { id: "external-document", offset: 20 } },
        previous,
        previous,
      ),
    ).toBeNull();
  });
});
