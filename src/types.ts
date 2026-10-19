export type RuntimeDiagnostics = {
  appVersion: string;
  os: string;
  osVersion: string | null;
  arch: string;
  webviewVersion: string | null;
  errors: string[];
};

export type View = "code" | "changes";
export type Comparison = {
  view: View;
  mode: "all" | "staged" | "unstaged" | "branch" | "commit";
  baseRef: string | null;
  includeUntracked: boolean;
};
export type Repository = {
  id: string;
  root: string;
  name: string;
  branch: string;
  head: string | null;
};
export type Commit = {
  id: string;
  shortId: string;
  subject: string;
  author: string;
  committedAt: string;
  parents: string[];
};
export type CommitPage = { commits: Commit[]; hasMore: boolean };
export type FileEntry = {
  id: string;
  path: string;
  oldPath: string | null;
  status: string;
  kind: string;
  additions: number;
  deletions: number;
  size: number;
  deferred: boolean;
};
export type Snapshot = {
  id: string;
  repository: Repository;
  comparison: Comparison;
  queueId: string;
  baseCommit: string | null;
  commit?: Commit;
  files: FileEntry[];
};
export type RepositoryWatchStatus = {
  snapshotId: string;
  watchId: string;
  changed: boolean;
  error: string | null;
};
export type FileContent = {
  snapshotId: string;
  fileId: string;
  path: string;
  oldPath: string | null;
  status: string;
  kind: string;
  oldContent: string | null;
  newContent: string | null;
  fingerprint: string;
  tabWidth: number;
  deferred: boolean;
  size: number;
  metadata: string;
};
export type Anchor = {
  snapshotId: string;
  fingerprint: string;
  baseCommit?: string;
  headCommit?: string;
  side?: "old" | "new";
  line?: number;
  lineText?: string;
  contextBefore: string[];
  contextAfter: string[];
};
export type ReviewComment = {
  id: string;
  queueId: string;
  path: string;
  oldPath?: string;
  sourceView: View;
  scope: "file" | "line";
  body: string;
  createdAt: string;
  updatedAt: string;
  anchor: Anchor;
  outdated: boolean;
};
export type ReviewQueue = {
  comments: ReviewComment[];
  reviewed: Record<string, string>;
};
export type NewComment = {
  snapshotId: string;
  fileId: string;
  fingerprint: string;
  body: string;
  side: "old" | "new" | null;
  line: number | null;
};
export type Appearance = {
  mode: "system" | "light" | "dark";
  lightTheme: string;
  darkTheme: string;
};
export type SidebarWidths = { files: number; feedback: number };
export type Preferences = {
  sidebarWidths: SidebarWidths;
  languageServers: LanguageServer[];
  appearance: Appearance;
  recentRepositories: string[];
  lastRepository: string | null;
  sessions: Record<
    string,
    {
      comparison: Comparison;
      selectedPath: string | null;
      scrollTop: number;
      lastChanges?: Comparison;
    }
  >;
  tabWidth: number;
  showWhitespace: boolean;
  codeFontSize: number;
  diffLayout: "unified" | "split";
  gitExecutable: string | null;
};
export type ImportedTheme = {
  id: string;
  name: string;
  kind: "light" | "dark";
  definition: import("@pierre/diffs").ThemeRegistration;
};
export type Bootstrap = { preferences: Preferences; themes: ImportedTheme[] };
export const defaultComparison: Comparison = {
  view: "changes",
  mode: "all",
  baseRef: null,
  includeUntracked: true,
};
export const defaultPreferences: Preferences = {
  sidebarWidths: { files: 244, feedback: 310 },
  languageServers: [
    {
      id: "go",
      name: "Go (gopls)",
      enabled: true,
      languages: { go: "go" },
      executable: "gopls",
      args: [],
      rootMarkers: ["go.work", "go.mod"],
      env: { GOPROXY: "off", GOTOOLCHAIN: "local", GOFLAGS: "-mod=readonly" },
      initializationOptions: {},
      settings: { gopls: { staticcheck: false } },
    },
    {
      id: "typescript",
      name: "TypeScript / JavaScript",
      enabled: true,
      languages: {
        ts: "typescript",
        tsx: "typescriptreact",
        mts: "typescript",
        cts: "typescript",
        js: "javascript",
        jsx: "javascriptreact",
        mjs: "javascript",
        cjs: "javascript",
      },
      executable: "typescript-language-server",
      args: ["--stdio"],
      rootMarkers: ["package.json", "tsconfig.json", "jsconfig.json"],
      env: {},
      initializationOptions: {
        disableAutomaticTypingAcquisition: true,
        tsserver: { useSyntaxServer: "never" },
      },
      settings: {},
    },
    {
      id: "python",
      name: "Python (Pyright)",
      enabled: true,
      languages: { py: "python", pyi: "python" },
      executable: "pyright-langserver",
      args: ["--stdio"],
      rootMarkers: [
        "pyrightconfig.json",
        "pyproject.toml",
        "setup.py",
        "setup.cfg",
        "requirements.txt",
        "Pipfile",
      ],
      env: {},
      initializationOptions: {},
      settings: { python: { analysis: { autoSearchPaths: true } } },
    },
    {
      id: "rust",
      name: "Rust (rust-analyzer)",
      enabled: true,
      languages: { rs: "rust" },
      executable: "rust-analyzer",
      args: [],
      rootMarkers: ["Cargo.toml", "rust-project.json"],
      env: { CARGO_NET_OFFLINE: "true" },
      initializationOptions: {
        cargo: { buildScripts: { enable: false } },
        procMacro: { enable: false },
        checkOnSave: false,
      },
      settings: {
        "rust-analyzer": {
          cargo: { buildScripts: { enable: false } },
          procMacro: { enable: false },
          checkOnSave: false,
        },
      },
    },
  ],
  appearance: {
    mode: "system",
    lightTheme: "github-light",
    darkTheme: "github-dark",
  },
  recentRepositories: [],
  lastRepository: null,
  sessions: {},
  tabWidth: 4,
  showWhitespace: false,
  codeFontSize: 12,
  diffLayout: "unified",
  gitExecutable: null,
};

export type LanguageServer = {
  id: string;
  name: string;
  enabled: boolean;
  languages: Record<string, string>;
  executable: string;
  args: string[];
  rootMarkers: string[];
  env: Record<string, string>;
  initializationOptions: unknown;
  settings: unknown;
};
export type NavigationRequest = {
  requestId: string;
  snapshotId: string;
  side: "old" | "new";
  path: string | null;
  documentId: string | null;
  position: import("./navigation").SourcePosition;
  operation: "auto" | "references";
};
export type NavigationLocation = {
  documentId: string;
  path: string;
  range: import("./navigation").SourceRange;
  preview: string;
  label: string;
  external: boolean;
};
export type NavigationResult = {
  requestId: string;
  snapshotId: string;
  side: "old" | "new";
  kind: "definitions" | "references";
  locations: NavigationLocation[];
};
export type NavigationFile = {
  tabWidth: number | null;
  snapshotId: string;
  side: "old" | "new";
  documentId: string;
  path: string;
  label: string;
  external: boolean;
  content: string | null;
  fingerprint: string;
  size: number;
  deferred: boolean;
  kind: string;
};
