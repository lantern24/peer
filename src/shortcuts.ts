import registry from "./shortcuts.json";

export type ShortcutId = keyof typeof registry;
export type ShortcutPlatform = "mac" | "windows" | "linux";

type ShortcutEvent = Pick<
  KeyboardEvent,
  "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey"
> & { code?: string };

type Binding = {
  keys: string;
  code?: string;
  platforms?: readonly string[];
  optionalModifiers?: readonly string[];
  allowExtraModifiers?: boolean;
  // Some existing editor commands accept Control and Command on every platform.
  eitherMod?: boolean;
};
type Shortcut = {
  group: string;
  action: string;
  bindings: readonly Binding[];
  // Standard OS/WebView behavior, documented here rather than reimplemented.
  system?: boolean;
  menuLabel?: string;
};

const shortcuts: Record<ShortcutId, Shortcut> = registry;
const modifiers = ["Cmd", "Ctrl", "Alt", "Shift"] as const;
const keyLabels: Record<string, string> = {
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
  Escape: "Esc",
};

// Parse once; listeners compare the already-separated key and modifiers.
const bindings = Object.fromEntries(
  Object.entries(shortcuts).map(([id, shortcut]) => [
    id,
    shortcut.bindings.map((binding) => {
      const parts = binding.keys.split("+");
      const key = parts.pop() ?? "";
      return {
        ...binding,
        key: key === "Space" ? " " : key.toLowerCase(),
        label: keyLabels[key] ?? key,
        modifiers: parts,
      };
    }),
  ]),
);

export function shortcutPlatform(): ShortcutPlatform {
  const platform = navigator.platform;
  return /Mac|iPhone|iPad/.test(platform)
    ? "mac"
    : /Win/.test(platform)
      ? "windows"
      : "linux";
}

export function matchesShortcut(
  id: ShortcutId,
  event: ShortcutEvent,
  platform = shortcutPlatform(),
): boolean {
  return bindings[id].some((binding) => {
    if (binding.platforms && !binding.platforms.includes(platform))
      return false;
    if (
      event.key.toLowerCase() !== binding.key &&
      (!binding.code || event.code !== binding.code)
    )
      return false;
    const primary = platform === "mac" ? "Cmd" : "Ctrl";
    const hasMod = binding.modifiers.includes("CmdOrCtrl");
    if (hasMod && binding.eitherMod && !event.ctrlKey && !event.metaKey)
      return false;
    return modifiers.every((modifier) => {
      const pressed =
        modifier === "Cmd"
          ? event.metaKey
          : modifier === "Ctrl"
            ? event.ctrlKey
            : modifier === "Alt"
              ? event.altKey
              : event.shiftKey;
      if (
        hasMod &&
        binding.eitherMod &&
        (modifier === "Cmd" || modifier === "Ctrl")
      )
        return true;
      const required =
        binding.modifiers.includes(modifier) ||
        (hasMod && modifier === primary);
      return required
        ? pressed
        : binding.allowExtraModifiers ||
            binding.optionalModifiers?.includes(modifier) ||
            !pressed;
    });
  });
}

export function shortcutLabel(
  id: ShortcutId,
  platform = shortcutPlatform(),
): string {
  return bindings[id]
    .filter(
      (binding) => !binding.platforms || binding.platforms.includes(platform),
    )
    .map((binding) =>
      [
        ...binding.modifiers.map((modifier) =>
          modifier === "CmdOrCtrl"
            ? platform === "mac"
              ? "⌘"
              : "Ctrl"
            : modifier === "Cmd"
              ? "⌘"
              : modifier,
        ),
        binding.label,
      ].join("+"),
    )
    .join(" / ");
}

export function shortcutGroups(platform = shortcutPlatform()) {
  const groups = new Map<
    string,
    { id: string; action: string; keys: string }[]
  >();
  // The IDs originate in the registry; no separate list controls help inclusion.
  for (const id of Object.keys(registry) as ShortcutId[]) {
    const shortcut = shortcuts[id];
    const keys = shortcutLabel(id, platform);
    if (!keys) continue;
    let group = groups.get(shortcut.group);
    if (!group) {
      group = [];
      groups.set(shortcut.group, group);
    }
    group.push({ id, action: shortcut.action, keys });
  }
  return Array.from(groups, ([title, shortcuts]) => ({ title, shortcuts }));
}
