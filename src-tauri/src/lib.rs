mod diagnostics;
#[cfg(target_os = "macos")]
mod macos_navigation;
mod repository_watch;

use peer_core::navigation::{NavigationError, NavigationFile, NavigationRequest, NavigationResult};
use peer_core::{types::*, Inspector};
use tauri::{Emitter, Manager, State};

#[tauri::command]
async fn navigate_symbol(
    core: State<'_, Inspector>,
    request: NavigationRequest,
) -> Result<NavigationResult, NavigationError> {
    core.navigate_symbol(request).await
}
#[tauri::command]
async fn read_navigation_file(
    core: State<'_, Inspector>,
    snapshot_id: String,
    side: String,
    document_id: String,
    force: bool,
) -> Result<NavigationFile, NavigationError> {
    core.read_navigation_file(&snapshot_id, &side, &document_id, force)
        .await
}
#[tauri::command]
fn cancel_navigation(core: State<'_, Inspector>, request_id: String) {
    core.cancel_navigation(&request_id);
}

#[tauri::command]
async fn bootstrap(core: State<'_, Inspector>) -> Result<serde_json::Value, String> {
    let data = core.store.read()?;
    Ok(serde_json::json!({ "preferences": data.preferences, "themes": data.themes }))
}
#[tauri::command]
async fn save_preferences(
    core: State<'_, Inspector>,
    preferences: Preferences,
) -> Result<(), String> {
    core.save_preferences(preferences)
}
#[tauri::command]
async fn open_repository(
    core: State<'_, Inspector>,
    path: String,
    comparison: Option<Comparison>,
) -> Result<Snapshot, String> {
    core.open_repository(&path, comparison).await
}
#[tauri::command]
async fn start_repository_watch(
    app: tauri::AppHandle,
    core: State<'_, Inspector>,
    monitor: State<'_, repository_watch::RepositoryWatch>,
    snapshot_id: String,
    watch_id: String,
) -> Result<RepositoryWatchStatus, String> {
    let baseline = core.repository_watch_baseline(&snapshot_id).await;
    Ok(monitor.start(app, snapshot_id, watch_id, baseline).await)
}
#[tauri::command]
fn stop_repository_watch(monitor: State<'_, repository_watch::RepositoryWatch>, watch_id: String) {
    monitor.stop(&watch_id)
}
#[tauri::command]
fn check_repository_watch(monitor: State<'_, repository_watch::RepositoryWatch>, watch_id: String) {
    monitor.check(&watch_id)
}
#[tauri::command]
async fn relocate_repository(
    core: State<'_, Inspector>,
    previous_path: String,
    path: String,
) -> Result<Snapshot, String> {
    core.relocate_repository(&previous_path, &path).await
}
#[tauri::command]
async fn read_file(
    core: State<'_, Inspector>,
    snapshot_id: String,
    file_id: String,
    force: bool,
) -> Result<FileContent, String> {
    core.read_file(&snapshot_id, &file_id, force).await
}
#[tauri::command]
async fn list_branches(
    core: State<'_, Inspector>,
    snapshot_id: String,
) -> Result<Vec<String>, String> {
    core.branches(&snapshot_id).await
}
#[tauri::command]
async fn list_commits(
    core: State<'_, Inspector>,
    snapshot_id: String,
    offset: u32,
    limit: u32,
) -> Result<CommitPage, String> {
    core.commits(&snapshot_id, offset, limit).await
}
#[tauri::command]
async fn get_queue(core: State<'_, Inspector>, snapshot_id: String) -> Result<ReviewQueue, String> {
    core.queue(&snapshot_id).await
}
#[tauri::command]
async fn add_comment(core: State<'_, Inspector>, comment: NewComment) -> Result<Comment, String> {
    core.add_comment(comment).await
}
#[tauri::command]
async fn update_comment(
    core: State<'_, Inspector>,
    queue_id: String,
    id: String,
    body: String,
) -> Result<(), String> {
    core.update_comment(&queue_id, &id, &body)
}
#[tauri::command]
async fn delete_comments(
    core: State<'_, Inspector>,
    queue_id: String,
    id: Option<String>,
) -> Result<(), String> {
    core.delete_comments(&queue_id, id.as_deref())
}
#[tauri::command]
async fn set_reviewed(
    core: State<'_, Inspector>,
    snapshot_id: String,
    file_id: String,
    fingerprint: String,
    reviewed: bool,
) -> Result<(), String> {
    core.set_reviewed(&snapshot_id, &file_id, &fingerprint, reviewed)
        .await
}
#[tauri::command]
async fn export_queue(core: State<'_, Inspector>, snapshot_id: String) -> Result<String, String> {
    core.export(&snapshot_id).await
}
#[tauri::command]
async fn save_export(
    core: State<'_, Inspector>,
    snapshot_id: String,
    path: String,
) -> Result<(), String> {
    let text = core.export(&snapshot_id).await?;
    std::fs::write(path, text).map_err(|e| e.to_string())
}
#[tauri::command]
async fn import_theme(core: State<'_, Inspector>, path: String) -> Result<ImportedTheme, String> {
    core.import_theme(&path)
}
#[tauri::command]
async fn remove_theme(core: State<'_, Inspector>, id: String) -> Result<(), String> {
    core.remove_theme(&id)
}

pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(feature = "desktop-tests")]
    let builder = builder
        .plugin(tauri_plugin_wdio::init())
        .plugin(tauri_plugin_wdio_webdriver::init());
    #[cfg(target_os = "macos")]
    let mut navigation_monitor = None;
    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            let directory = std::env::var_os("PEER_DATA_DIR")
                .or_else(|| std::env::var_os("REPO_INSPECTOR_DATA_DIR"))
                .map(std::path::PathBuf::from)
                .unwrap_or(app.path().app_data_dir()?);
            app.manage(Inspector::new(directory)?);
            app.manage(repository_watch::RepositoryWatch::default());
            use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
            let open =
                MenuItem::with_id(app, "open", "Open Repository…", true, Some("CmdOrCtrl+O"))?;
            let settings =
                MenuItem::with_id(app, "settings", "Settings…", true, Some("CmdOrCtrl+,"))?;
            let refresh = MenuItem::with_id(
                app,
                "refresh",
                "Refresh Repository",
                true,
                Some("CmdOrCtrl+R"),
            )?;
            let about = PredefinedMenuItem::about(app, None, None)?;
            let separator = PredefinedMenuItem::separator(app)?;
            let quit = PredefinedMenuItem::quit(app, None)?;
            let app_menu =
                Submenu::with_items(app, "Peer", true, &[&about, &settings, &separator, &quit])?;
            let file_menu = Submenu::with_items(app, "File", true, &[&open, &refresh])?;
            let edit_menu = Submenu::with_items(
                app,
                "Edit",
                true,
                &[
                    &PredefinedMenuItem::undo(app, None)?,
                    &PredefinedMenuItem::redo(app, None)?,
                    &PredefinedMenuItem::cut(app, None)?,
                    &PredefinedMenuItem::copy(app, None)?,
                    &PredefinedMenuItem::paste(app, None)?,
                    &PredefinedMenuItem::select_all(app, None)?,
                ],
            )?;
            app.set_menu(Menu::with_items(app, &[&app_menu, &file_menu, &edit_menu])?)?;
            app.on_menu_event(|app, event| {
                let _ = app.emit("app-menu", event.id().as_ref());
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            bootstrap,
            diagnostics::diagnostic_runtime,
            diagnostics::save_diagnostic_report,
            navigate_symbol,
            read_navigation_file,
            cancel_navigation,
            save_preferences,
            open_repository,
            start_repository_watch,
            stop_repository_watch,
            check_repository_watch,
            relocate_repository,
            read_file,
            list_branches,
            list_commits,
            get_queue,
            add_comment,
            update_comment,
            delete_comments,
            set_reviewed,
            export_queue,
            save_export,
            import_theme,
            #[cfg(all(target_os = "macos", feature = "desktop-tests"))]
            macos_navigation::test_swipe,
            remove_theme
        ])
        .build(tauri::generate_context!())
        .expect("Unable to start Peer")
        .run(move |app, event| {
            #[cfg(target_os = "macos")]
            if matches!(event, tauri::RunEvent::Ready) {
                match macos_navigation::Monitor::install(app) {
                    Ok(monitor) => navigation_monitor = Some(monitor),
                    Err(error) => eprintln!("Unable to enable native history gestures: {error}"),
                }
            }
            if matches!(event, tauri::RunEvent::Exit) {
                #[cfg(target_os = "macos")]
                drop(navigation_monitor.take());
                app.state::<repository_watch::RepositoryWatch>().shutdown();
                tauri::async_runtime::block_on(app.state::<Inspector>().shutdown_navigation());
            }
        });
}
