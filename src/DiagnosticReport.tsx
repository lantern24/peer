import { useEffect, useId, useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { api } from "./api";
import { clearDiagnostics, collectDiagnosticReport } from "./diagnostics";

export function DiagnosticReport() {
  const id = useId();
  const request = useRef(0);
  const [report, setReport] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

  async function refresh(cleared = false) {
    const current = ++request.current;
    setBusy(true);
    setError("");
    setStatus("Collecting diagnostic report…");
    try {
      const text = await collectDiagnosticReport();
      if (current !== request.current) return;
      setReport(text);
      setStatus(
        cleared
          ? "Recorded events cleared. Preview refreshed."
          : "Preview ready.",
      );
    } catch (cause) {
      if (current !== request.current) return;
      setStatus("");
      setError(`Could not collect report: ${String(cause)}`);
    } finally {
      if (current === request.current) setBusy(false);
    }
  }

  useEffect(() => {
    void refresh();
    return () => {
      request.current++;
    };
  }, []);

  async function exportReport() {
    const current = ++request.current;
    const text = report;
    setBusy(true);
    setError("");
    setStatus("Choosing where to save…");
    try {
      const path = await save({
        title: "Save diagnostic report",
        defaultPath: "peer-diagnostics.txt",
        filters: [{ name: "Plain text", extensions: ["txt"] }],
      });
      if (current !== request.current) return;
      if (path === null) {
        setStatus("Save cancelled. Preview unchanged.");
        return;
      }
      setStatus("Saving report…");
      await api.saveDiagnosticReport(path, text);
      if (current !== request.current) return;
      setStatus("Diagnostic report saved.");
    } catch (cause) {
      if (current !== request.current) return;
      setStatus("");
      setError(`Could not save report: ${String(cause)}`);
    } finally {
      if (current === request.current) setBusy(false);
    }
  }

  return (
    <div className="diagnostic-report" aria-busy={busy}>
      <h3>Diagnostics</h3>
      <p id={`${id}-privacy`}>
        Reproduce the problem, then refresh and export this report. Recent
        events are kept only in memory, bounded to 300 entries and 256 KiB;
        restarting Peer clears them. Nothing is uploaded or saved until you
        choose Save report. Reports include runtime versions, current viewer
        state, and recent errors. Files use session-local numbered IDs, not
        names or paths. Source contents and review comments are not deliberately
        collected. Error messages and stacks may contain paths or other
        sensitive text: review the preview before sharing it.
      </p>
      <label htmlFor={`${id}-preview`}>Diagnostic report preview</label>
      <textarea
        id={`${id}-preview`}
        aria-describedby={`${id}-privacy`}
        value={report}
        readOnly
        spellCheck={false}
        rows={14}
      />
      <div className="diagnostic-actions">
        <button
          type="button"
          className="small-button"
          disabled={busy}
          onClick={() => void refresh()}
        >
          Refresh report
        </button>
        <button
          type="button"
          className="small-button"
          disabled={busy || !report}
          onClick={() => void exportReport()}
        >
          Save report…
        </button>
        <button
          type="button"
          className="small-button"
          disabled={busy}
          onClick={() => {
            clearDiagnostics();
            void refresh(true);
          }}
        >
          Clear recorded events
        </button>
      </div>
      <p role="status">{status}</p>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
