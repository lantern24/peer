import {
  Children,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { defaultPreferences, type SidebarWidths } from "./types";
import {
  fitSidebars,
  minimumSourceWidth,
  sidebarLimits,
} from "./sidebar-layout";
import { matchesShortcut, shortcutLabel } from "./shortcuts";

type Side = keyof SidebarWidths;
type DividerProps = {
  side: Side;
  label: string;
  value: number;
  max: number;
  onResize: (width: number) => void;
  onCommit: (width: number) => void;
  onCancel: () => void;
};

function SidebarDivider(props: DividerProps) {
  const latest = useRef(props);
  latest.current = props;
  const element = useRef<HTMLDivElement>(null);
  const drag = useRef<{
    pointer?: number;
    x: number;
    width: number;
    current: number;
  } | null>(null);
  const [dragging, setDragging] = useState(false);
  const direction = props.side === "files" ? 1 : -1;
  const min = sidebarLimits[props.side].min;
  const constrain = (width: number) =>
    Math.round(Math.max(min, Math.min(latest.current.max, width)));
  const finish = (commit: boolean) => {
    const previous = drag.current;
    if (!previous) return;
    drag.current = null;
    document.body.classList.remove("sidebar-resizing");
    if (
      previous.pointer !== undefined &&
      element.current?.hasPointerCapture(previous.pointer)
    )
      element.current.releasePointerCapture(previous.pointer);
    setDragging(false);
    if (commit) latest.current.onCommit(previous.current);
    else latest.current.onCancel();
  };
  const cancel = useRef(() => finish(false));
  cancel.current = () => finish(false);
  const mouseMove = useRef((_x: number) => {});
  const mouseUp = useRef(() => {});
  mouseMove.current = (x) => {
    const current = drag.current;
    if (!current || current.pointer !== undefined) return;
    current.current = constrain(current.width + direction * (x - current.x));
    props.onResize(current.current);
  };
  mouseUp.current = () => {
    if (drag.current?.pointer === undefined) finish(true);
  };
  useEffect(() => {
    const blur = () => cancel.current();
    const move = (event: MouseEvent) => mouseMove.current(event.clientX);
    const up = () => mouseUp.current();
    window.addEventListener("blur", blur);
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("blur", blur);
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      if (drag.current) document.body.classList.remove("sidebar-resizing");
    };
  }, []);
  return (
    <div
      ref={element}
      className={`sidebar-divider ${dragging ? "dragging" : ""}`}
      style={
        props.side === "files" ? { left: props.value } : { right: props.value }
      }
      role="separator"
      aria-label={`Resize ${props.label} sidebar`}
      aria-orientation="vertical"
      aria-controls={props.side === "files" ? "file-sidebar" : "right-sidebar"}
      aria-valuemin={min}
      aria-valuemax={props.max}
      aria-valuenow={props.value}
      aria-valuetext={`${props.value} pixels`}
      tabIndex={0}
      title={`Drag or use ${shortcutLabel("resizeLeft")} / ${shortcutLabel("resizeRight")} to resize by 10 pixels, ${shortcutLabel("resizeLeftLarge")} / ${shortcutLabel("resizeRightLarge")} by 50 pixels. ${shortcutLabel("resizeMin")} / ${shortcutLabel("resizeMax")} for minimum / maximum. ${shortcutLabel("resizeCancel")} cancels dragging. Double-click to reset.`}
      onMouseDown={(event) => {
        // Some embedded hosts deliver only mouse events. Pointer-driven drags
        // already own the interaction and must not start a second drag here.
        if (event.button !== 0 || drag.current) return;
        event.preventDefault();
        event.currentTarget.focus({ preventScroll: true });
        drag.current = {
          x: event.clientX,
          width: props.value,
          current: props.value,
        };
        document.body.classList.add("sidebar-resizing");
        setDragging(true);
      }}
      onPointerDown={(event) => {
        if (event.button !== 0 || !event.isPrimary || drag.current) return;
        event.preventDefault();
        event.currentTarget.focus({ preventScroll: true });
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = {
          pointer: event.pointerId,
          x: event.clientX,
          width: props.value,
          current: props.value,
        };
        document.body.classList.add("sidebar-resizing");
        setDragging(true);
      }}
      onPointerMove={(event) => {
        const current = drag.current;
        if (!current || current.pointer !== event.pointerId) return;
        current.current = constrain(
          current.width + direction * (event.clientX - current.x),
        );
        props.onResize(current.current);
      }}
      onPointerUp={(event) => {
        if (drag.current?.pointer === event.pointerId) finish(true);
      }}
      onPointerCancel={() => finish(false)}
      onLostPointerCapture={() => finish(false)}
      onDoubleClick={() =>
        props.onCommit(constrain(defaultPreferences.sidebarWidths[props.side]))
      }
      onKeyDown={(event) => {
        if (matchesShortcut("resizeCancel", event) && drag.current) {
          event.preventDefault();
          finish(false);
          return;
        }
        if (drag.current) return;
        const width = matchesShortcut("resizeLeft", event)
          ? props.value - direction * 10
          : matchesShortcut("resizeRight", event)
            ? props.value + direction * 10
            : matchesShortcut("resizeLeftLarge", event)
              ? props.value - direction * 50
              : matchesShortcut("resizeRightLarge", event)
                ? props.value + direction * 50
                : matchesShortcut("resizeMin", event)
                  ? min
                  : matchesShortcut("resizeMax", event)
                    ? props.max
                    : null;
        if (width !== null) {
          event.preventDefault();
          props.onCommit(constrain(width));
        }
      }}
    />
  );
}

export function ResizableWorkspace({
  children,
  widths,
  onChange,
  rightLabel,
}: {
  children: ReactNode;
  widths: SidebarWidths;
  onChange: (widths: SidebarWidths) => void;
  rightLabel: string;
}) {
  const [left, main, right] = Children.toArray(children);
  const workspace = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState(window.innerWidth);
  const [draft, setDraft] = useState<SidebarWidths | null>(null);
  const actual = fitSidebars(draft ?? widths, available, !!right);
  useLayoutEffect(() => {
    const node = workspace.current!;
    const observer = new ResizeObserver(() => setAvailable(node.clientWidth));
    setAvailable(node.clientWidth);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const app = workspace.current?.closest<HTMLElement>(".app");
    app?.style.setProperty("--file-sidebar-width", `${actual.files}px`);
    return () => {
      app?.style.removeProperty("--file-sidebar-width");
    };
  }, [actual.files]);
  useEffect(() => setDraft(null), [!!right]);
  const resize = (side: Side, width: number, commit: boolean) => {
    const next = { ...actual, [side]: width };
    if (commit) {
      setDraft(null);
      onChange(next);
    } else setDraft(next);
  };
  const divider = (side: Side, label: string) => (
    <SidebarDivider
      side={side}
      label={label}
      value={actual[side]}
      max={Math.max(
        sidebarLimits[side].min,
        Math.min(
          sidebarLimits[side].max,
          available -
            minimumSourceWidth -
            (side === "files" ? (right ? actual.feedback : 0) : actual.files),
        ),
      )}
      onResize={(width) => resize(side, width, false)}
      onCommit={(width) => resize(side, width, true)}
      onCancel={() => setDraft(null)}
    />
  );
  return (
    <div
      ref={workspace}
      className={`workspace ${right ? "" : "feedback-hidden"}`}
      style={{
        gridTemplateColumns: `${actual.files}px minmax(0, 1fr)${right ? ` ${actual.feedback}px` : ""}`,
      }}
    >
      {left}
      {main}
      {right}
      {divider("files", "file navigation")}
      {right && divider("feedback", rightLabel)}
    </div>
  );
}
