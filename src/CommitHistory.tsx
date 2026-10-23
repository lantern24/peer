import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  GitBranch,
  GitCommitHorizontal,
  LoaderCircle,
} from "lucide-react";
import { api } from "./api";
import type { Commit, Snapshot } from "./types";
import { matchesShortcut } from "./shortcuts";

export function commitDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
}

export function CommitHistory({
  snapshot,
  disabled,
  onSelect,
}: {
  snapshot: Snapshot;
  disabled: boolean;
  onSelect: (commit: Commit) => void;
}) {
  const [open, setOpen] = useState(false);
  const [commits, setCommits] = useState<Commit[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const request = useRef(0);
  const id = useId();
  const branch = snapshot.repository.branch.startsWith("detached:")
    ? `Detached ${snapshot.repository.head?.slice(0, 7)}`
    : snapshot.repository.branch;

  const load = useCallback(
    async (offset: number) => {
      const current = ++request.current;
      setLoading(true);
      setError("");
      try {
        const page = await api.commits(snapshot.id, offset);
        if (request.current !== current) return;
        setCommits((previous) =>
          offset ? [...previous, ...page.commits] : page.commits,
        );
        setHasMore(page.hasMore);
      } catch (error) {
        if (request.current === current) setError(String(error));
      } finally {
        if (request.current === current) setLoading(false);
      }
    },
    [snapshot.id],
  );

  useEffect(() => {
    if (!open) return;
    setCommits([]);
    setHasMore(false);
    panel.current?.focus();
    void load(0);
    const outside = (event: MouseEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("click", outside);
    return () => {
      request.current++;
      document.removeEventListener("click", outside);
    };
  }, [open, load]);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  return (
    <div
      className="commit-history"
      ref={container}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (open && matchesShortcut("close", event)) {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          trigger.current?.focus();
        }
      }}
    >
      <button
        className="branch-label"
        ref={trigger}
        disabled={disabled}
        aria-label="Show branch commits"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        title={`View commits in ${branch}`}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (matchesShortcut("commitOpen", event)) {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <GitBranch size={14} />
        <span>{branch}</span>
        <ChevronDown size={12} />
      </button>
      {open && (
        <div
          className="commit-history-panel"
          id={id}
          role="dialog"
          aria-label="Commit history"
          tabIndex={-1}
          ref={panel}
          onKeyDown={(event) => {
            if (
              !matchesShortcut("menuNext", event) &&
              !matchesShortcut("menuPrevious", event) &&
              !matchesShortcut("menuFirst", event) &&
              !matchesShortcut("menuLast", event)
            )
              return;
            const items = Array.from(
              event.currentTarget.querySelectorAll<HTMLButtonElement>(
                "[data-commit-id]",
              ),
            );
            if (!items.length) return;
            const index = items.indexOf(
              document.activeElement as HTMLButtonElement,
            );
            const next = matchesShortcut("menuFirst", event)
              ? 0
              : matchesShortcut("menuLast", event)
                ? items.length - 1
                : matchesShortcut("menuNext", event)
                  ? (index + 1) % items.length
                  : index <= 0
                    ? items.length - 1
                    : index - 1;
            event.preventDefault();
            event.stopPropagation();
            items[next]?.focus();
          }}
        >
          <div className="commit-history-heading">
            <strong>Commits</strong>
            <span title={branch}>{branch}</span>
          </div>
          <div className="commit-history-list">
            {commits.map((commit) => (
              <button
                key={commit.id}
                className="commit-history-item"
                data-commit-id={commit.id}
                aria-current={
                  snapshot.commit?.id === commit.id ? "true" : undefined
                }
                aria-label={`View commit ${commit.shortId}: ${commit.subject}`}
                title={commit.subject}
                onClick={() => {
                  setOpen(false);
                  trigger.current?.focus();
                  onSelect(commit);
                }}
              >
                <GitCommitHorizontal size={16} />
                <span className="commit-history-text">
                  <strong>{commit.subject || "Untitled commit"}</strong>
                  <span>
                    <code>{commit.shortId}</code>
                    <span>{commit.author}</span>
                    <time dateTime={commit.committedAt}>
                      {commitDate(commit.committedAt)}
                    </time>
                  </span>
                </span>
                {snapshot.commit?.id === commit.id && (
                  <Check size={15} className="repository-current" />
                )}
              </button>
            ))}
            {!loading && !error && commits.length === 0 && (
              <p className="commit-history-state">
                This branch has no commits yet.
              </p>
            )}
            {loading && (
              <p className="commit-history-state" role="status">
                <LoaderCircle size={14} className="spin" />
                Loading commits…
              </p>
            )}
            {error && (
              <div className="commit-history-state" role="alert">
                <span>{error}</span>
                <button
                  className="small-button"
                  onClick={() => void load(commits.length)}
                >
                  Retry
                </button>
              </div>
            )}
            {!loading && !error && hasMore && (
              <button
                className="commit-history-more"
                onClick={() => void load(commits.length)}
              >
                Load older commits
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
