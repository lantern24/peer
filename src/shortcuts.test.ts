import { expect, it } from "vitest";
import { matchesShortcut } from "./shortcuts";

function key(key: string, options: Partial<KeyboardEvent> = {}) {
  return {
    key,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...options,
  };
}

it("distinguishes literal question marks from slash and modified commands", () => {
  for (const shiftKey of [false, true]) {
    expect(
      matchesShortcut("showShortcuts", key("?", { shiftKey }), "mac"),
    ).toBe(true);
    expect(
      matchesShortcut("showShortcuts", key("/", { shiftKey }), "mac"),
    ).toBe(false);
  }
  for (const modifier of ["ctrlKey", "metaKey", "altKey"]) {
    expect(
      matchesShortcut("showShortcuts", key("?", { [modifier]: true }), "mac"),
    ).toBe(false);
  }
});

it("keeps platform history bindings and physical-key aliases separate", () => {
  expect(
    matchesShortcut(
      "navigateBack",
      key("å", { code: "BracketLeft", metaKey: true }),
      "mac",
    ),
  ).toBe(true);
  expect(
    matchesShortcut(
      "navigateBack",
      key("å", { code: "BracketLeft", metaKey: true, shiftKey: true }),
      "mac",
    ),
  ).toBe(false);
  for (const platform of ["windows", "linux"] as const) {
    expect(
      matchesShortcut("navigateBack", key("[", { metaKey: true }), platform),
    ).toBe(false);
    expect(
      matchesShortcut(
        "navigateBack",
        key("ArrowLeft", { altKey: true }),
        platform,
      ),
    ).toBe(true);
  }
  expect(
    matchesShortcut(
      "navigateBackAlternative",
      key("ß", { code: "Minus", ctrlKey: true }),
      "mac",
    ),
  ).toBe(true);
  expect(
    matchesShortcut(
      "navigateBackAlternative",
      key("-", { ctrlKey: true, altKey: true }),
      "mac",
    ),
  ).toBe(false);
});

it("does not confuse reference navigation or large resizing with their unshifted actions", () => {
  const references = key("F12", { shiftKey: true });
  expect(matchesShortcut("navigateDefinition", references, "mac")).toBe(false);
  expect(matchesShortcut("navigateReferences", references, "mac")).toBe(true);
  const resize = key("ArrowLeft", { shiftKey: true });
  expect(matchesShortcut("resizeLeft", resize, "mac")).toBe(false);
  expect(matchesShortcut("resizeLeftLarge", resize, "mac")).toBe(true);
});

it("requires a primary modifier even when an editor command permits extra modifiers", () => {
  for (const platform of ["mac", "windows", "linux"] as const) {
    expect(
      matchesShortcut(
        "quickOpen",
        key("P", { ctrlKey: true, shiftKey: true }),
        platform,
      ),
    ).toBe(true);
    expect(
      matchesShortcut("quickOpen", key("p", { metaKey: true }), platform),
    ).toBe(true);
    expect(
      matchesShortcut("quickOpen", key("p", { shiftKey: true }), platform),
    ).toBe(false);
    expect(
      matchesShortcut(
        "navigateClick",
        key("click", { ctrlKey: true }),
        platform,
      ),
    ).toBe(platform !== "mac");
  }
});

it("allows Control-arrow quick-open navigation without accepting shifted or Command chords", () => {
  expect(
    matchesShortcut("quickPrevious", key("ArrowUp", { ctrlKey: true }), "mac"),
  ).toBe(true);
  expect(
    matchesShortcut("quickPrevious", key("P", { ctrlKey: true }), "mac"),
  ).toBe(true);
  expect(
    matchesShortcut("quickPrevious", key("p", { metaKey: true }), "mac"),
  ).toBe(false);
  expect(
    matchesShortcut("quickPrevious", key("ArrowUp", { shiftKey: true }), "mac"),
  ).toBe(false);
  expect(
    matchesShortcut("quickAccept", key("Enter", { ctrlKey: true }), "mac"),
  ).toBe(false);
});
