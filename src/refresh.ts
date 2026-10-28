import type { ViewportState } from "./navigation";
import type { FileEntry } from "./types";

/** Reconcile a viewport with a fresh inventory; pixel offsets across files are unstable. */
export function refreshedViewport(
  state: ViewportState,
  previous: FileEntry[],
  next: FileEntry[],
): ViewportState | null {
  const ids = new Map<string, string>();
  const paths = new Map(next.map((file) => [file.path, file]));
  const renamed = new Map(
    next.filter((file) => file.oldPath).map((file) => [file.oldPath, file]),
  );
  for (const file of previous) {
    const match = paths.get(file.path) ?? renamed.get(file.path);
    if (match) ids.set(file.id, match.id);
  }
  const origin = previous.findIndex((file) => file.id === state.anchor?.id);
  // A full-source navigation page is not part of the review inventory.
  if (origin < 0) return null;
  const id = ids.get(state.anchor!.id);
  const fallback =
    previous.slice(origin + 1).find((file) => ids.has(file.id)) ??
    previous
      .slice(0, origin)
      .reverse()
      .find((file) => ids.has(file.id));
  const target = id ?? (fallback && ids.get(fallback.id)) ?? next[0]?.id;
  if (!target) return null;
  const remap = <T>(values: Record<string, T>): Record<string, T> =>
    Object.fromEntries(
      Object.entries(values).flatMap(([id, value]) =>
        ids.has(id) ? [[ids.get(id)!, value]] : [],
      ),
    );
  const location = <T extends { id: string }>(value: T | null): T | null =>
    value && ids.has(value.id) ? { ...value, id: ids.get(value.id)! } : null;
  return {
    ...state,
    anchor: id ? { ...state.anchor!, id } : { id: target, offset: 0 },
    collapsed: state.collapsed.flatMap((id) =>
      ids.has(id) ? [ids.get(id)!] : [],
    ),
    expanded: remap(state.expanded),
    fingerprints: remap(state.fingerprints ?? {}),
    manuallyLoaded: (state.manuallyLoaded ?? []).flatMap((id) =>
      ids.has(id) ? [ids.get(id)!] : [],
    ),
    symbol: location(state.symbol),
    selection: location(state.selection),
    selectedLine: location(state.selectedLine),
  };
}
