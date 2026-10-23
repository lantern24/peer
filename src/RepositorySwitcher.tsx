import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  FolderOpen,
  FolderPen,
  Plus,
  X,
} from "lucide-react";
import { matchesShortcut, shortcutLabel } from "./shortcuts";

export function RepositorySwitcher({
  current,
  repositories,
  disabled,
  onSelect,
  onOpen,
  onRelocate,
  onRemove,
}: {
  current: { root: string; name: string } | null;
  repositories: string[];
  disabled: boolean;
  onSelect: (path: string) => void;
  onOpen: () => void;
  onRelocate: (path: string) => void;
  onRemove: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const items = useRef<(HTMLButtonElement | null)[]>([]);
  const initialFocus = useRef(0);
  const paths = useMemo(
    () => [...new Set([...(current ? [current.root] : []), ...repositories])],
    [current?.root, repositories],
  );

  useEffect(() => {
    if (!open) return;
    items.current[initialFocus.current]?.focus();
    const outside = (event: MouseEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("click", outside);
    return () => document.removeEventListener("click", outside);
  }, [open]);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  return (
    <div
      ref={container}
      className="repository-switcher"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (
          open &&
          (matchesShortcut("close", event) ||
            matchesShortcut("focusNext", event) ||
            matchesShortcut("focusPrevious", event))
        ) {
          if (matchesShortcut("close", event)) {
            event.preventDefault();
            event.stopPropagation();
          }
          setOpen(false);
          trigger.current?.focus();
        }
      }}
    >
      <button
        ref={trigger}
        className="repository-button"
        aria-label="Switch repository"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title={current?.root ?? "Switch repository"}
        disabled={disabled || !paths.length}
        onClick={() => {
          initialFocus.current = 0;
          setOpen((value) => !value);
        }}
        onKeyDown={(event) => {
          if (
            matchesShortcut("repositoryOpenFirst", event) ||
            matchesShortcut("repositoryOpenLast", event)
          ) {
            event.preventDefault();
            initialFocus.current = matchesShortcut("repositoryOpenLast", event)
              ? paths.length - 1
              : 0;
            setOpen(true);
          }
        }}
      >
        <FolderOpen size={17} />
        <span>{current?.name ?? "Repositories"}</span>
        <ChevronDown size={13} />
      </button>
      <button
        className="icon-button repository-add"
        aria-label="Open repository"
        title={`Open another repository (${shortcutLabel("openRepository")})`}
        disabled={disabled}
        onClick={() => {
          setOpen(false);
          onOpen();
        }}
      >
        <Plus size={16} />
      </button>
      {open && (
        <div
          id={menuId}
          className="repository-menu"
          role="menu"
          aria-label="Repositories"
        >
          <div className="repository-menu-label">Repositories</div>
          {paths.map((path, index) => (
            <div
              key={path}
              className="repository-menu-row"
              role="none"
              onKeyDown={(event) => {
                const buttons = Array.from(
                  event.currentTarget.querySelectorAll("button"),
                );
                const column = buttons.indexOf(
                  event.target as HTMLButtonElement,
                );
                let next: number;
                if (
                  matchesShortcut("rowNext", event) ||
                  matchesShortcut("rowPrevious", event)
                ) {
                  const direction = matchesShortcut("rowNext", event) ? 1 : -1;
                  buttons[
                    (column + direction + buttons.length) % buttons.length
                  ]?.focus();
                } else {
                  if (matchesShortcut("menuNext", event))
                    next = (index + 1) % paths.length;
                  else if (matchesShortcut("menuPrevious", event))
                    next = (index - 1 + paths.length) % paths.length;
                  else if (matchesShortcut("menuFirst", event)) next = 0;
                  else if (matchesShortcut("menuLast", event))
                    next = paths.length - 1;
                  else return;
                  items.current[next]?.focus();
                }
                event.preventDefault();
                event.stopPropagation();
              }}
            >
              <button
                className="repository-menu-select"
                ref={(node) => {
                  items.current[index] = node;
                }}
                role="menuitemradio"
                aria-checked={path === current?.root}
                tabIndex={-1}
                title={path}
                data-repository-path={path}
                onClick={() => {
                  setOpen(false);
                  trigger.current?.focus();
                  if (path !== current?.root) onSelect(path);
                }}
              >
                <FolderOpen size={16} />
                <span className="repository-menu-text">
                  <strong>
                    {path.split(/[\\/]/).filter(Boolean).at(-1) ?? path}
                  </strong>
                  <small>{path}</small>
                </span>
                {path === current?.root && (
                  <Check size={15} className="repository-current" />
                )}
              </button>
              <button
                className="repository-menu-action"
                role="menuitem"
                tabIndex={-1}
                aria-label={`Update location for ${path}`}
                title="Update location"
                onClick={() => {
                  setOpen(false);
                  trigger.current?.focus();
                  onRelocate(path);
                }}
              >
                <FolderPen size={15} />
              </button>
              <button
                className="repository-menu-action"
                role="menuitem"
                tabIndex={-1}
                aria-label={`Remove ${path} from list`}
                title="Remove from list (does not delete files)"
                onClick={() => {
                  setOpen(false);
                  trigger.current?.focus();
                  onRemove(path);
                }}
              >
                <X size={15} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
