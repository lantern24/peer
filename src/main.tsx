import React from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import App from "./App";
import { DiagnosticReport } from "./DiagnosticReport";
import { installDiagnostics, recordDiagnosticError } from "./diagnostics";
import "./styles.css";

const uninstallDiagnostics = installDiagnostics();
if (import.meta.hot) import.meta.hot.dispose(uninstallDiagnostics);

if (import.meta.env.VITE_DESKTOP_TEST === "1") {
  // A static import would install the test driver in production builds too.
  await import("@wdio/tauri-plugin");
  // Apply fixture resets only after the outgoing app and its autosave timers
  // are gone, before the replacement app reads preferences or starts saving.
  const preferences = sessionStorage.getItem("peer:desktop-preferences");
  if (preferences !== null) {
    sessionStorage.removeItem("peer:desktop-preferences");
    await invoke("save_preferences", { preferences: JSON.parse(preferences) });
  }
}

class ErrorBoundary extends React.Component<
  React.PropsWithChildren,
  { error: string | null }
> {
  state = { error: null as string | null };
  static getDerivedStateFromError(error: Error) {
    return { error: error.message };
  }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    recordDiagnosticError("react.fatal", error, {
      componentStack: info.componentStack ?? null,
    });
  }
  render() {
    return this.state.error ? (
      <main className="fatal">
        <h1>Something interrupted the viewer</h1>
        <p>{this.state.error}</p>
        <button onClick={() => location.reload()}>Reload Peer</button>
        <p>Saved feedback is kept on disk.</p>
        <details>
          <summary>Inspect and export diagnostic report</summary>
          <DiagnosticReport />
        </details>
      </main>
    ) : (
      this.props.children
    );
  }
}
createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
