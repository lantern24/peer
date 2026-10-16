import { invoke } from "@tauri-apps/api/core";
import type {
  Bootstrap,
  Comparison,
  CommitPage,
  FileContent,
  ImportedTheme,
  NewComment,
  Preferences,
  ReviewComment,
  ReviewQueue,
  Snapshot,
  NavigationRequest,
  NavigationResult,
  NavigationFile,
  RuntimeDiagnostics,
} from "./types";

export const api = {
  navigate: (request: NavigationRequest) =>
    invoke<NavigationResult>("navigate_symbol", { request }),
  navigationFile: (
    snapshotId: string,
    side: "old" | "new",
    documentId: string,
    force = false,
  ) =>
    invoke<NavigationFile>("read_navigation_file", {
      snapshotId,
      side,
      documentId,
      force,
    }),
  cancelNavigation: (requestId: string) =>
    invoke<void>("cancel_navigation", { requestId }),
  bootstrap: () => invoke<Bootstrap>("bootstrap"),
  diagnosticRuntime: () => invoke<RuntimeDiagnostics>("diagnostic_runtime"),
  saveDiagnosticReport: (path: string, text: string) =>
    invoke<void>("save_diagnostic_report", { path, text }),
  savePreferences: (preferences: Preferences) =>
    invoke<void>("save_preferences", { preferences }),
  open: (path: string, comparison: Comparison | null) =>
    invoke<Snapshot>("open_repository", { path, comparison }),
  relocate: (previousPath: string, path: string) =>
    invoke<Snapshot>("relocate_repository", { previousPath, path }),
  read: (snapshotId: string, fileId: string, force = false) =>
    invoke<FileContent>("read_file", { snapshotId, fileId, force }),
  branches: (snapshotId: string) =>
    invoke<string[]>("list_branches", { snapshotId }),
  commits: (snapshotId: string, offset = 0, limit = 50) =>
    invoke<CommitPage>("list_commits", { snapshotId, offset, limit }),
  queue: (snapshotId: string) =>
    invoke<ReviewQueue>("get_queue", { snapshotId }),
  comment: (comment: NewComment) =>
    invoke<ReviewComment>("add_comment", { comment }),
  editComment: (queueId: string, id: string, body: string) =>
    invoke<void>("update_comment", { queueId, id, body }),
  deleteComments: (queueId: string, id: string | null = null) =>
    invoke<void>("delete_comments", { queueId, id }),
  reviewed: (
    snapshotId: string,
    fileId: string,
    fingerprint: string,
    reviewed: boolean,
  ) =>
    invoke<void>("set_reviewed", { snapshotId, fileId, fingerprint, reviewed }),
  export: (snapshotId: string) =>
    invoke<string>("export_queue", { snapshotId }),
  saveExport: (snapshotId: string, path: string) =>
    invoke<void>("save_export", { snapshotId, path }),
  importTheme: (path: string) =>
    invoke<ImportedTheme>("import_theme", { path }),
  removeTheme: (id: string) => invoke<void>("remove_theme", { id }),
};
