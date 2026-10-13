import {
  forwardRef,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
} from "react";

export type HorizontalScrollbarHandle = {
  refresh: (preservePosition?: boolean) => void;
  sync: () => void;
  restore: (target: { id: string; left: number } | null) => void;
};

// A virtualized file's own scrollbar can be below the viewport. Keep a native
// scrollbar within reach and mirror only the active file's rendered columns.
export const HorizontalScrollbar = forwardRef<
  HorizontalScrollbarHandle,
  { getHost: () => HTMLElement | undefined; path?: string }
>(function HorizontalScrollbar({ getHost, path }, ref) {
  const bar = useRef<HTMLDivElement>(null);
  const getActiveHost = useRef(getHost);
  getActiveHost.current = getHost;
  const refresh = useRef((_preservePosition?: boolean) => {});
  const sync = useRef(() => {});
  const restore = useRef((_target: { id: string; left: number } | null) => {});
  const move = useRef((_left: number) => {});
  useImperativeHandle(
    ref,
    () => ({
      refresh: (preservePosition) => refresh.current(preservePosition),
      sync: () => sync.current(),
      restore: (target) => restore.current(target),
    }),
    [],
  );

  useLayoutEffect(() => {
    const element = bar.current!;
    const spacer = element.firstElementChild as HTMLElement;
    let host: HTMLElement | undefined;
    let hostIdentity: string | undefined;
    let columns: HTMLElement[] = [];
    let source: HTMLElement | undefined;
    let frame: number | undefined;
    let fallback: ReturnType<typeof setTimeout> | undefined;
    let mirroredLeft = 0;
    let preserveOnRender = false;
    let pendingRestore: { id: string; left: number } | null = null;
    const mirroredColumns = new WeakMap<HTMLElement, number>();
    const moveColumns = (left: number) => {
      for (const column of columns) {
        column.scrollLeft = left;
        mirroredColumns.set(column, column.scrollLeft);
      }
    };
    const schedule = () => {
      frame ??= requestAnimationFrame(measure);
      // WKWebView can suspend animation frames while a window is occluded.
      // Programmatic navigation must still expose and restore its scrollbar.
      fallback ??= setTimeout(measure, 100);
    };
    const codeScroll = (event: Event) => {
      const column = event.target;
      if (
        column instanceof HTMLElement &&
        mirroredColumns.get(column) === column.scrollLeft
      ) {
        // These columns already received the same command, clamped to their
        // own ranges. Do not let the renderer replay a shorter column's offset
        // onto the wider one or arbitrate this command as a code-side gesture.
        event.stopPropagation();
      }
      schedule();
    };
    const observer = new ResizeObserver(schedule);
    function measure(_timestamp?: number, preferSource = false) {
      if (frame !== undefined) cancelAnimationFrame(frame);
      if (fallback !== undefined) clearTimeout(fallback);
      frame = undefined;
      fallback = undefined;
      const nextHost = getActiveHost.current();
      const nextIdentity = nextHost?.dataset.navigationId;
      const sameHost = host === nextHost && hostIdentity === nextIdentity;
      // A resize/render frame can run before the native scrollbar's scroll
      // event. Apply that pending user movement instead of resetting the bar
      // from the old code position (or a replaced highlighting DOM node).
      const pendingLeft =
        !preferSource &&
        sameHost &&
        Math.abs(element.scrollLeft - mirroredLeft) > 1
          ? element.scrollLeft
          : undefined;
      const nextColumns = Array.from(
        nextHost?.shadowRoot?.querySelectorAll<HTMLElement>("[data-code]") ??
          [],
      );
      const replacedColumns =
        nextColumns.some((node, i) => node !== columns[i]) ||
        nextColumns.length !== columns.length;
      const retainedLeft =
        !preferSource && sameHost && (replacedColumns || preserveOnRender)
          ? mirroredLeft
          : undefined;
      preserveOnRender = false;
      if (!sameHost || replacedColumns) {
        host?.shadowRoot?.removeEventListener("scroll", codeScroll, true);
        observer.disconnect();
        observer.observe(element);
        host = nextHost;
        hostIdentity = nextIdentity;
        columns = nextColumns;
        host?.shadowRoot?.addEventListener("scroll", codeScroll, {
          capture: true,
          passive: true,
        });
        if (host) observer.observe(host);
        columns.forEach((node) => observer.observe(node));
      }
      // Measure the wider side so a shorter column cannot truncate the range.
      source = columns.reduce<HTMLElement | undefined>(
        (widest, node) =>
          !widest ||
          node.scrollWidth - node.clientWidth >
            widest.scrollWidth - widest.clientWidth
            ? node
            : widest,
        undefined,
      );
      const nextLeft = pendingLeft ?? retainedLeft;
      if (nextLeft !== undefined) moveColumns(nextLeft);
      const overflow = source ? source.scrollWidth - source.clientWidth : 0;
      // Source columns can still be placeholders when a refreshed viewport is
      // restored. Wait for the target's real overflow before consuming its offset.
      if (
        pendingRestore &&
        pendingRestore.id === nextIdentity &&
        source &&
        source.clientWidth > 0 &&
        (overflow > 0 || pendingRestore.left === 0)
      ) {
        moveColumns(pendingRestore.left);
        pendingRestore = null;
      }
      spacer.style.width = `${element.clientWidth + overflow}px`;
      element.style.visibility = overflow > 1 ? "visible" : "hidden";
      element.tabIndex = overflow > 1 ? 0 : -1;
      element.setAttribute("aria-hidden", String(overflow <= 1));
      element.scrollLeft = source?.scrollLeft ?? 0;
      mirroredLeft = element.scrollLeft;
    }
    const scroll = () => {
      // Ignore scroll events from our own mirror writes: they can arrive
      // after a newer gesture over the code and must not undo that gesture.
      if (source && Math.abs(element.scrollLeft - mirroredLeft) > 1) {
        moveColumns(element.scrollLeft);
        mirroredLeft = element.scrollLeft;
      }
    };
    move.current = (left) => {
      measure();
      element.scrollLeft = left;
      // Home must also synchronize code when the bar is already at zero and
      // therefore will not emit a scroll event of its own.
      moveColumns(element.scrollLeft);
      mirroredLeft = element.scrollLeft;
    };
    element.addEventListener("scroll", scroll, { passive: true });
    refresh.current = (preservePosition) => {
      // WKWebView can clamp scrollLeft while code children are rewritten even
      // when the column element itself survives. Preserve it across that render.
      preserveOnRender ||= preservePosition ?? false;
      schedule();
    };
    sync.current = () => measure(undefined, true);
    restore.current = (target) => {
      pendingRestore = target;
      if (target) schedule();
    };
    observer.observe(element);
    schedule();
    return () => {
      refresh.current = () => {};
      sync.current = () => {};
      restore.current = () => {};
      move.current = () => {};
      if (frame !== undefined) cancelAnimationFrame(frame);
      if (fallback !== undefined) clearTimeout(fallback);
      observer.disconnect();
      host?.shadowRoot?.removeEventListener("scroll", codeScroll, true);
      element.removeEventListener("scroll", scroll);
    };
  }, []);
  useLayoutEffect(() => refresh.current());

  return (
    <div
      ref={bar}
      className="viewer-horizontal-scrollbar"
      role="region"
      aria-label={`Scroll code horizontally${path ? `: ${path}` : ""}`}
      title="Scroll horizontally · Arrow keys, Home or End"
      onKeyDown={(event) => {
        const element = event.currentTarget;
        const positions: Record<string, number> = {
          ArrowLeft: element.scrollLeft - 40,
          ArrowRight: element.scrollLeft + 40,
          Home: 0,
          End: element.scrollWidth,
          PageUp: element.scrollLeft - element.clientWidth,
          PageDown: element.scrollLeft + element.clientWidth,
        };
        if (event.key in positions) {
          event.preventDefault();
          move.current(positions[event.key]);
        }
      }}
    >
      <div />
    </div>
  );
});
