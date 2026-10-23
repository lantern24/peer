use serde::Deserialize;

// Read only the native commands; the WebView consumes the rest of this registry.
// Each native menu item has one accelerator, borrowed from the embedded JSON.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct NativeShortcuts<'a> {
    #[serde(borrow)]
    pub open_repository: MenuShortcut<'a>,
    #[serde(borrow)]
    pub settings: MenuShortcut<'a>,
    #[serde(borrow)]
    pub refresh_repository: MenuShortcut<'a>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct MenuShortcut<'a> {
    pub menu_label: &'a str,
    #[serde(borrow)]
    pub bindings: [MenuBinding<'a>; 1],
}

#[derive(Deserialize)]
pub(super) struct MenuBinding<'a> {
    pub keys: &'a str,
}

pub(super) fn native_shortcuts() -> Result<NativeShortcuts<'static>, serde_json::Error> {
    serde_json::from_str(include_str!("../../src/shortcuts.json"))
}
