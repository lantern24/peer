import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Copy,
  Download,
  MessageSquare,
  Pencil,
  Trash2,
  X,
  ArrowUpRight,
  Send,
} from "lucide-react";
import type { ReviewComment, ReviewQueue } from "./types";
import { isTyping } from "./navigation";
import { matchesShortcut, shortcutLabel } from "./shortcuts";

export type Draft = {
  fileId: string;
  snapshotId: string;
  fingerprint: string;
  path: string;
  line?: number;
  side?: "old" | "new";
  body: string;
  error?: string;
};
type Props = {
  queue: ReviewQueue;
  view: string;
  draft?: Draft;
  focusRequest: number;
  busy: boolean;
  copying: boolean;
  refreshing: boolean;
  onDraft: (draft?: Draft) => void;
  onSubmit: () => void;
  onRefresh: () => void;
  onReviewDraft?: () => void;
  onCopy: () => void;
  deleteAfterCopy: boolean;
  onDeleteAfterCopyChange: (enabled: boolean) => void;
  onSave: () => void;
  onClear: () => void;
  onDelete: (id: string) => void;
  onEdit: (id: string, body: string) => Promise<void>;
  onJump: (comment: ReviewComment) => void;
  onClose: () => void;
};

export function Feedback({
  queue,
  view,
  draft,
  focusRequest,
  busy,
  copying,
  refreshing,
  onDraft,
  onSubmit,
  onRefresh,
  onReviewDraft,
  onCopy,
  deleteAfterCopy,
  onDeleteAfterCopyChange,
  onSave,
  onClear,
  onDelete,
  onEdit,
  onJump,
  onClose,
}: Props) {
  const [editing, setEditing] = useState<string | null>(null);
  const [body, setBody] = useState("");
  const composer = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    composer.current?.focus();
  }, [focusRequest]);
  const copyDisabled =
    !queue.comments.length || busy || copying || editing !== null;
  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if (
        copyDisabled ||
        event.defaultPrevented ||
        event.isComposing ||
        event.repeat ||
        !matchesShortcut("copyComments", event) ||
        isTyping(event) ||
        document.querySelector('[role="dialog"]')
      )
        return;
      event.preventDefault();
      onCopy();
    };
    window.addEventListener("keydown", keys);
    return () => window.removeEventListener("keydown", keys);
  }, [copyDisabled, onCopy]);
  return (
    <aside id="right-sidebar" className="feedback-panel">
      <div className="feedback-title">
        <h2>
          Feedback <span className="count">{queue.comments.length}</span>
        </h2>
        <button
          className="icon-button"
          onClick={onClose}
          aria-label="Close feedback"
        >
          <X size={16} />
        </button>
      </div>
      <div className="feedback-subtitle">
        {view === "code" ? "General code review" : "This comparison"}
        <span>Saved locally</span>
      </div>
      <div className="feedback-actions">
        <button
          className="primary-button"
          onClick={onCopy}
          disabled={copyDisabled}
          title={
            editing !== null
              ? "Save or cancel the edit before copying"
              : `Copy comments (${shortcutLabel("copyComments")})`
          }
        >
          <Copy size={14} />
          {copying ? "Copying…" : "Copy comments"}
        </button>
        <button
          className="icon-button bordered"
          title="Save JSON"
          aria-label="Save feedback as JSON"
          onClick={onSave}
          disabled={!queue.comments.length}
        >
          <Download size={15} />
        </button>
        <button
          className="icon-button bordered"
          title="Clear this queue"
          aria-label="Clear all comments"
          onClick={onClear}
          disabled={!queue.comments.length || busy || copying}
        >
          <Trash2 size={14} />
        </button>
      </div>
      <label className="feedback-copy-option">
        <input
          type="checkbox"
          checked={deleteAfterCopy}
          disabled={copying}
          onChange={(e) => onDeleteAfterCopyChange(e.target.checked)}
        />
        Delete comments after copying
      </label>
      <div className="feedback-list">
        {draft && (
          <form
            className="comment-composer"
            onSubmit={(e) => {
              e.preventDefault();
              onSubmit();
            }}
          >
            <div className="comment-path">
              <MessageSquare size={13} />
              <span title={draft.path}>{draft.path}</span>
              <button
                type="button"
                className="icon-button"
                aria-label="Discard draft"
                onClick={() => onDraft(undefined)}
              >
                <X size={13} />
              </button>
            </div>
            <div className="comment-location">
              {draft.line
                ? `${draft.side === "old" ? "Old " : ""}line ${draft.line}`
                : "File comment"}
            </div>
            <textarea
              ref={composer}
              aria-label="Comment text"
              placeholder="Suggest a change or ask a question…"
              aria-describedby={draft.error ? "draft-error" : undefined}
              value={draft.body}
              onChange={(e) => onDraft({ ...draft, body: e.target.value })}
              onKeyDown={(e) => {
                if (matchesShortcut("saveComment", e)) {
                  e.preventDefault();
                  onSubmit();
                }
              }}
            />
            {draft.error && (
              <div className="draft-error">
                <p id="draft-error" role="alert">
                  {draft.error}
                </p>
                <p>
                  Your text is kept. If the source changed, refresh and review
                  it, then use + on the intended line or Comment on file to
                  reuse this draft at that location.
                </p>
                <div className="row">
                  <button
                    type="button"
                    className="small-button"
                    disabled={busy || copying || refreshing}
                    onClick={onRefresh}
                  >
                    {refreshing ? "Refreshing…" : "Refresh"}
                  </button>
                  {onReviewDraft && (
                    <button
                      type="button"
                      className="small-button"
                      disabled={busy || copying || refreshing}
                      onClick={onReviewDraft}
                    >
                      Review file
                    </button>
                  )}
                </div>
              </div>
            )}
            <button
              className="primary-button"
              disabled={!draft.body.trim() || busy || copying || refreshing}
            >
              <Send size={13} />
              {busy ? "Saving…" : "Add comment"}
            </button>
          </form>
        )}
        {!queue.comments.length && !draft && (
          <div className="feedback-empty">
            <MessageSquare size={28} strokeWidth={1.3} />
            <h3>Leave a little context.</h3>
            <p>
              Use the + beside a line or comment on a file. Your feedback
              collects here, ready for your coding agent.
            </p>
            <span>Only this review’s comments appear here.</span>
          </div>
        )}
        {queue.comments.map((comment) => (
          <article
            className={`comment-card ${comment.outdated ? "outdated" : ""}`}
            key={comment.id}
          >
            <button
              className="comment-path"
              onClick={() => onJump(comment)}
              title={comment.path}
            >
              <span>{comment.path}</span>
              <ArrowUpRight size={13} />
            </button>
            <div className="comment-location">
              {comment.anchor.line
                ? `${comment.anchor.side === "old" ? "Old " : ""}line ${comment.anchor.line}`
                : "File comment"}
              {comment.outdated && (
                <span className="outdated-tag">Outdated</span>
              )}
            </div>
            {comment.anchor.lineText !== undefined && (
              <pre className="comment-context">{comment.anchor.lineText}</pre>
            )}
            {editing === comment.id ? (
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (busy || copying) return;
                  try {
                    await onEdit(comment.id, body);
                    setEditing(null);
                  } catch {
                    /* App displays the error; keep the edit open. */
                  }
                }}
              >
                <textarea
                  aria-label="Edit comment"
                  value={body}
                  disabled={busy || copying}
                  onChange={(e) => setBody(e.target.value)}
                />
                <div className="row">
                  <button
                    className="small-button"
                    disabled={!body.trim() || busy || copying}
                  >
                    {busy ? "Saving…" : "Save"}
                  </button>
                  <button
                    type="button"
                    className="text-button"
                    disabled={busy || copying}
                    onClick={() => setEditing(null)}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            ) : (
              <p>{comment.body}</p>
            )}
            <div className="comment-footer">
              <span className="avatar">Y</span>
              <span>You</span>
              <time dateTime={comment.createdAt}>
                {new Date(comment.createdAt).toLocaleDateString(undefined, {
                  month: "short",
                  day: "numeric",
                })}
              </time>
              <button
                className="icon-button"
                aria-label="Edit comment"
                disabled={busy || copying}
                onClick={() => {
                  setEditing(comment.id);
                  setBody(comment.body);
                }}
              >
                <Pencil size={12} />
              </button>
              <button
                className="icon-button"
                aria-label="Delete comment"
                disabled={busy || copying}
                onClick={() => onDelete(comment.id)}
              >
                <Trash2 size={12} />
              </button>
            </div>
          </article>
        ))}
      </div>
      <div className="feedback-note">
        Copy comments to share the file, line, and feedback with your coding
        agent.
      </div>
    </aside>
  );
}
