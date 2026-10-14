import { useLayoutEffect, useRef, useState } from "react";
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

export type Draft = {
  fileId: string;
  snapshotId: string;
  fingerprint: string;
  path: string;
  line?: number;
  side?: "old" | "new";
  body: string;
};
type Props = {
  queue: ReviewQueue;
  view: string;
  draft?: Draft;
  focusRequest: number;
  busy: boolean;
  onDraft: (draft?: Draft) => void;
  onSubmit: () => void;
  onCopy: () => void;
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
  onDraft,
  onSubmit,
  onCopy,
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
          disabled={!queue.comments.length}
        >
          <Copy size={14} />
          Copy comments
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
          disabled={!queue.comments.length}
        >
          <Trash2 size={14} />
        </button>
      </div>
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
              value={draft.body}
              onChange={(e) => onDraft({ ...draft, body: e.target.value })}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  onSubmit();
                }
              }}
            />
            <button
              className="primary-button"
              disabled={!draft.body.trim() || busy}
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
                  onChange={(e) => setBody(e.target.value)}
                />
                <div className="row">
                  <button className="small-button" disabled={!body.trim()}>
                    Save
                  </button>
                  <button
                    type="button"
                    className="text-button"
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
