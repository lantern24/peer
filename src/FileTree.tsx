import { useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  FileCode2,
  Folder,
  Search,
  Check,
  MessageSquare,
} from "lucide-react";
import type { FileEntry, ReviewQueue } from "./types";
import { SearchText, textMatches } from "./search";
import { shortcutLabel } from "./shortcuts";

type Props = {
  files: FileEntry[];
  selected: string | null;
  queue: ReviewQueue;
  onSelect: (id: string) => void;
  view: string;
};
export function FileTree({ files, selected, queue, onSelect, view }: Props) {
  const [filter, setFilter] = useState("");
  const [closed, setClosed] = useState(new Set<string>());
  const tree = useRef<HTMLElement>(null);
  const activeRow = useRef<HTMLButtonElement>(null);
  const selectedPath = files.find((file) => file.id === selected)?.path;
  useLayoutEffect(() => {
    if (!selectedPath) return;
    const parts = selectedPath.split("/");
    setClosed((current) => {
      const next = new Set(current);
      for (let i = 1; i < parts.length; i++)
        next.delete(parts.slice(0, i).join("/"));
      return next.size === current.size ? current : next;
    });
  }, [selectedPath]);
  const rows = useMemo(() => {
    const result: {
      key: string;
      name: string;
      depth: number;
      file?: FileEntry;
    }[] = [];
    const dirs = new Set<string>();
    for (const file of files) {
      if (filter && !textMatches(file.path, filter).length) continue;
      if (filter) {
        result.push({ key: file.id, name: file.path, depth: 0, file });
        continue;
      }
      const parts = file.path.split("/");
      let hidden = false;
      for (let i = 0; i < parts.length - 1; i++) {
        const key = parts.slice(0, i + 1).join("/");
        if (!dirs.has(key)) {
          dirs.add(key);
          result.push({ key, name: parts[i], depth: i });
        }
        if (closed.has(key)) {
          hidden = true;
          break;
        }
      }
      if (!hidden)
        result.push({
          key: file.id,
          name: parts.at(-1)!,
          depth: parts.length - 1,
          file,
        });
    }
    return result;
  }, [files, filter, closed]);
  useLayoutEffect(() => {
    const container = tree.current;
    const row = activeRow.current;
    if (!container || !row) return;
    const viewport = container.getBoundingClientRect();
    const bounds = row.getBoundingClientRect();
    // Scroll only this sidebar, and leave focus where the user put it.
    if (bounds.top < viewport.top)
      container.scrollTop -= viewport.top - bounds.top;
    else if (bounds.bottom > viewport.bottom)
      container.scrollTop += bounds.bottom - viewport.bottom;
  }, [selected, rows]);
  return (
    <aside id="file-sidebar" className="file-sidebar">
      <div className="sidebar-caption">
        <span>{view === "code" ? "REPOSITORY" : "CHANGED FILES"}</span>
        <span className="count">{files.length}</span>
      </div>
      <label className="filter-input">
        <Search size={14} />
        <input
          aria-label="Filter files"
          placeholder="Filter files…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <kbd>{shortcutLabel("quickOpen")}</kbd>
      </label>
      <nav ref={tree} className="file-tree" aria-label="Repository files">
        {rows.map((row) =>
          row.file ? (
            <button
              key={row.key}
              ref={selected === row.file.id ? activeRow : undefined}
              className={`tree-file ${selected === row.file.id ? "selected" : ""}`}
              aria-current={selected === row.file.id ? "true" : undefined}
              style={{ paddingLeft: 14 + row.depth * 14 }}
              title={row.file.path}
              onClick={() => onSelect(row.file!.id)}
            >
              <FileCode2 size={14} />
              <span>
                <SearchText text={row.name} query={filter} />
              </span>
              {queue.comments.some((c) => c.path === row.file!.path) && (
                <MessageSquare size={11} />
              )}
              {queue.reviewed[row.file.path] ? (
                <Check size={13} className="add" />
              ) : (
                <small
                  className={
                    ["added", "untracked"].includes(row.file.status)
                      ? "add"
                      : row.file.status === "deleted"
                        ? "remove"
                        : "status-letter"
                  }
                >
                  {
                    (
                      {
                        added: "A",
                        untracked: "U",
                        deleted: "D",
                        modified: "M",
                        renamed: "R",
                        conflict: "!",
                      } as Record<string, string>
                    )[row.file.status]
                  }
                </small>
              )}
            </button>
          ) : (
            <button
              key={`directory-${row.key}`}
              className="tree-folder"
              style={{ paddingLeft: 10 + row.depth * 14 }}
              onClick={() =>
                setClosed((current) => {
                  const next = new Set(current);
                  if (next.has(row.key)) next.delete(row.key);
                  else next.add(row.key);
                  return next;
                })
              }
              aria-expanded={!closed.has(row.key)}
            >
              {closed.has(row.key) ? (
                <ChevronRight size={12} />
              ) : (
                <ChevronDown size={12} />
              )}
              <Folder size={14} />
              <span>{row.name}</span>
            </button>
          ),
        )}
      </nav>
      <div className="sidebar-foot">
        <span className="status-dot" />
        Local repository<span>Read only</span>
      </div>
    </aside>
  );
}
