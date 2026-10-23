import { Modal } from "./Modal";
import { shortcutGroups, shortcutPlatform } from "./shortcuts";

export function KeyboardShortcuts({ onClose }: { onClose: () => void }) {
  const platform = shortcutPlatform();
  const groups = shortcutGroups(platform);

  return (
    <Modal
      title="Keyboard shortcuts"
      className="keyboard-shortcuts"
      onClose={onClose}
    >
      <p className="settings-help">
        Shortcuts for{" "}
        {platform === "mac"
          ? "macOS (⌘ is Command)"
          : platform === "windows"
            ? "Windows"
            : "Linux"}
        . Contextual shortcuts apply when the named control is focused.
      </p>
      <div className="shortcut-groups">
        {groups.map(({ title, shortcuts }) => (
          <section key={title} aria-label={title}>
            <h3>{title}</h3>
            <dl>
              {shortcuts.map(({ id, keys, action }) => (
                <div className="shortcut-row" key={id}>
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
