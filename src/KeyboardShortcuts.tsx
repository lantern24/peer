import { Modal } from "./Modal";

export function KeyboardShortcuts({ onClose }: { onClose: () => void }) {
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
  const isWindows = /Win/.test(navigator.platform);
  const mod = isMac ? "⌘" : "Ctrl";
  const groups: { title: string; shortcuts: [string, string][] }[] = [
    {
      title: "Application",
      shortcuts: [
        ["? (Shift+/)", "Show keyboard shortcuts"],
        [`${mod}+O`, "Open repository"],
        [`${mod}+R`, "Refresh repository"],
        ["Ctrl+T", "Switch between Code and Changes"],
        [`${mod}+,`, "Open Settings"],
        ["Esc", "Close dialog, menu, or search"],
        ...(isMac ? ([["⌘+Q", "Quit Peer"]] satisfies [string, string][]) : []),
      ],
    },
    {
      title: "Files and search",
      shortcuts: [
        [`${mod}+P`, "Quick-open file"],
        [`${mod}+F`, "Find in file"],
        [`${mod}+G`, "Go to line"],
        ["Enter / Shift+Enter", "Next / previous match in Find"],
        ["Enter", "Jump from Go to line"],
      ],
    },
    {
      title: "Code navigation",
      shortcuts: [
        ["F12", "Go to definition; at a definition, find references"],
        ["Shift+F12", "Find references"],
        [`${mod}+click`, "Go to definition"],
        [isMac ? "⌘+[" : "Alt+←", "Go back"],
        [isMac ? "⌘+]" : "Alt+→", "Go forward"],
        ["Ctrl+-", "Go back (alternative)"],
        ["BrowserBack / BrowserForward", "Go back / forward"],
      ],
    },
    {
      title: "In quick-open",
      shortcuts: [
        ["↑ / Ctrl+P", "Previous file"],
        ["↓ / Ctrl+N", "Next file"],
        ["Enter", "Open highlighted file"],
      ],
    },
    {
      title: "Comments and text editing",
      shortcuts: [
        [`${mod}+Enter`, "Save comment from its editor"],
        [`${mod}+X / ${mod}+C / ${mod}+V`, "Cut / copy / paste text"],
        [`${mod}+A`, "Select all text"],
        ...(isMac || isWindows
          ? ([
              [`${mod}+Z`, "Undo text edit"],
              [isMac ? "⌘+Shift+Z" : "Ctrl+Y", "Redo text edit"],
            ] satisfies [string, string][])
          : []),
      ],
    },
    {
      title: "Focused sidebar divider",
      shortcuts: [
        ["← / →", "Resize sidebar by 10 px"],
        ["Shift+← / Shift+→", "Resize sidebar by 50 px"],
        ["Home / End", "Minimum / maximum width"],
        ["Esc", "Cancel an active resize drag"],
      ],
    },
    {
      title: "Repository menu, commits, and Settings",
      shortcuts: [
        ["↑ / ↓", "Open focused repository menu"],
        ["↓", "Open focused commit menu"],
        ["↑ / ↓", "Previous / next repository or commit"],
        ["← / →", "Repository row actions or Settings tabs"],
        ["Home / End", "First / last item or Settings tab"],
        ["Enter / Space", "Activate focused button"],
        ["Tab / Shift+Tab", "Focus next / previous control"],
      ],
    },
    {
      title: "Focused horizontal scrollbar",
      shortcuts: [
        ["← / →", "Scroll left / right"],
        ["PageUp / PageDown", "Scroll left / right by one page"],
        ["Home / End", "Scroll to start / end"],
      ],
    },
  ];

  return (
    <Modal
      title="Keyboard shortcuts"
      className="keyboard-shortcuts"
      onClose={onClose}
    >
      <p className="settings-help">
        Shortcuts for{" "}
        {isMac ? "macOS (⌘ is Command)" : isWindows ? "Windows" : "Linux"}.
        Contextual shortcuts apply when the named control is focused. Press ?
        outside text fields and dialogs to open this list.
      </p>
      <div className="shortcut-groups">
        {groups.map(({ title, shortcuts }) => (
          <section key={title} aria-label={title}>
            <h3>{title}</h3>
            <dl>
              {shortcuts.map(([keys, action]) => (
                <div className="shortcut-row" key={action}>
                  <dt>{action}</dt>
                  <dd>
                    <kbd>{keys}</kbd>
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Modal>
  );
}
