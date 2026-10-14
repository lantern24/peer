use peer_core::{
    navigation::{default_servers, NavigationRequest, NavigationResult, Position},
    Comparison, Inspector, Snapshot,
};
use std::{fs, path::Path, process::Command, sync::Arc, time::Duration};

fn git(root: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .args(args)
        .current_dir(root)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().into()
}
fn fixture() -> (tempfile::TempDir, tempfile::TempDir, Inspector) {
    let repo = tempfile::tempdir().unwrap();
    let store = tempfile::tempdir().unwrap();
    git(repo.path(), &["init", "-b", "main"]);
    git(repo.path(), &["config", "user.name", "Test"]);
    git(
        repo.path(),
        &["config", "user.email", "test@example.invalid"],
    );
    fs::write(repo.path().join(".gitignore"), "node_modules/\n").unwrap();
    fs::write(
        repo.path().join("call.ts"),
        "asdf();\nkeep();\nexternal();\nhang();\ncrash();\n",
    )
    .unwrap();
    fs::write(
        repo.path().join("defs.ts"),
        "export function asdf() { return 'base'; }\n",
    )
    .unwrap();
    fs::write(repo.path().join("keep.ts"), "export const keep = 1;\n").unwrap();
    git(repo.path(), &["add", "."]);
    git(repo.path(), &["commit", "-m", "base"]);
    let app = Inspector::new(store.path()).unwrap();
    let mut preferences = app.store.read().unwrap().preferences;
    let mut server = default_servers().remove(1);
    server.executable = "node".into();
    server.args = vec![Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/support/fake-lsp.mjs")
        .to_str()
        .unwrap()
        .into()];
    server.env.insert("PEER_FAKE_FORM".into(), "links".into());
    server.env.insert(
        "PEER_FAKE_LOG".into(),
        store.path().join("servers.log").to_str().unwrap().into(),
    );
    preferences.language_servers = vec![server];
    app.save_preferences(preferences).unwrap();
    (repo, store, app)
}
fn request(
    snapshot: &Snapshot,
    side: &str,
    path: &str,
    line: u32,
    character: u32,
) -> NavigationRequest {
    NavigationRequest {
        request_id: uuid::Uuid::new_v4().to_string(),
        snapshot_id: snapshot.id.clone(),
        side: side.into(),
        path: Some(path.into()),
        document_id: None,
        position: Position { line, character },
        operation: "auto".into(),
    }
}
async fn source(app: &Inspector, result: &NavigationResult) -> String {
    assert_eq!(result.locations.len(), 1, "{result:?}");
    app.read_navigation_file(
        &result.snapshot_id,
        &result.side,
        &result.locations[0].document_id,
        true,
    )
    .await
    .unwrap()
    .content
    .unwrap()
}

#[tokio::test]
async fn navigation_tab_width_preserves_editorconfig_or_uses_the_preference() {
    let (repo, _store, app) = fixture();
    let content = "export function asdf() {\n\treturn 'base';\n}\n";
    fs::write(repo.path().join("defs.ts"), content).unwrap();
    fs::write(repo.path().join(".editorconfig"), "root=true\n").unwrap();
    git(repo.path(), &["add", "."]);
    git(repo.path(), &["commit", "-m", "tabbed definition"]);
    let mut preferences = app.store.read().unwrap().preferences;
    preferences.tab_width = 6;
    app.save_preferences(preferences).unwrap();

    for (config, expected) in [
        ("root=true\n", None),
        ("root=true\n[*.ts]\ntab_width=8\n", Some(8)),
        ("root=true\n[*.ts]\ntab_width=1\n", Some(1)),
    ] {
        fs::write(repo.path().join(".editorconfig"), config).unwrap();
        let snapshot = app
            .open_repository(repo.path().to_str().unwrap(), Some(Comparison::default()))
            .await
            .unwrap();
        for (side, expected) in [("old", None), ("new", expected)] {
            let result = app
                .navigate_symbol(request(&snapshot, side, "call.ts", 0, 1))
                .await
                .unwrap();
            let file = app
                .read_navigation_file(&snapshot.id, side, &result.locations[0].document_id, true)
                .await
                .unwrap();
            assert_eq!(file.content.as_deref(), Some(content));
            assert_eq!(file.tab_width, expected, "{side}: {config}");
        }
    }
}

#[tokio::test]
async fn every_comparison_resolves_its_own_complete_repository_version() {
    let (repo, store, app) = fixture();
    git(repo.path(), &["checkout", "-b", "topic"]);
    fs::write(
        repo.path().join("defs.ts"),
        "// head\nexport function asdf() { return 'head'; }\n",
    )
    .unwrap();
    git(repo.path(), &["add", "."]);
    git(repo.path(), &["commit", "-m", "head"]);
    fs::write(
        repo.path().join("defs.ts"),
        "// index\n\nexport function asdf() { return 'index'; }\n",
    )
    .unwrap();
    git(repo.path(), &["add", "."]);
    fs::write(
        repo.path().join("defs.ts"),
        "// working\n\n\nexport function asdf() { return 'working'; }\n",
    )
    .unwrap();
    let before = git(repo.path(), &["status", "--porcelain=v1"]);
    let index_before = fs::read(repo.path().join(".git/index")).unwrap();
    for (mode, old, new) in [
        ("all", "head", "working"),
        ("staged", "head", "index"),
        ("unstaged", "index", "working"),
        ("branch", "base", "working"),
    ] {
        let snapshot = app
            .open_repository(
                repo.path().to_str().unwrap(),
                Some(Comparison {
                    mode: mode.into(),
                    base_ref: if mode == "branch" {
                        Some("main".into())
                    } else {
                        None
                    },
                    ..Comparison::default()
                }),
            )
            .await
            .unwrap();
        assert!(!snapshot.files.iter().any(|file| file.path == "keep.ts"));
        for (side, expected) in [("old", old), ("new", new)] {
            let result = app
                .navigate_symbol(request(&snapshot, side, "call.ts", 0, 1))
                .await
                .unwrap();
            assert!(source(&app, &result)
                .await
                .contains(&format!("'{expected}'")));
            let definition = &result.locations[0];
            let mut again = request(&snapshot, side, "", 0, 0);
            again.path = None;
            again.document_id = Some(definition.document_id.clone());
            again.position = definition.range.start;
            let references = app.navigate_symbol(again).await.unwrap();
            assert_eq!(references.kind, "references");
            assert_eq!(references.locations[0].path, "call.ts");
            let unchanged = app
                .navigate_symbol(request(&snapshot, side, "call.ts", 1, 1))
                .await
                .unwrap();
            assert_eq!(unchanged.locations[0].path, "keep.ts");
        }
    }
    assert_eq!(before, git(repo.path(), &["status", "--porcelain=v1"]));
    assert_eq!(
        index_before,
        fs::read(repo.path().join(".git/index")).unwrap()
    );
    let roots = fs::read_to_string(store.path().join("servers.log")).unwrap();
    let paths: Vec<_> = roots.lines().collect();
    assert_ne!(paths[paths.len() - 1], paths[paths.len() - 2]);
}

#[tokio::test]
async fn source_is_frozen_and_working_inventory_drift_requires_refresh() {
    let (repo, store, app) = fixture();
    let comparison = Comparison {
        view: "code".into(),
        ..Comparison::default()
    };
    let snapshot = app
        .open_repository(repo.path().to_str().unwrap(), Some(comparison.clone()))
        .await
        .unwrap();
    assert!(
        !store.path().join("servers.log").exists(),
        "ordinary browsing must not start servers"
    );
    fs::write(repo.path().join("keep.ts"), "export const keep = 999;\n").unwrap();
    let error = app
        .navigate_symbol(request(&snapshot, "new", "call.ts", 0, 1))
        .await
        .unwrap_err();
    assert_eq!(error.code, "stale");
    let snapshot = app
        .open_repository(repo.path().to_str().unwrap(), Some(comparison))
        .await
        .unwrap();
    let result = app
        .navigate_symbol(request(&snapshot, "new", "call.ts", 0, 1))
        .await
        .unwrap();
    fs::write(
        repo.path().join("defs.ts"),
        "export const asdf = 'later';\n",
    )
    .unwrap();
    assert!(source(&app, &result).await.contains("'base'"));
    assert!(source(
        &app,
        &app.navigate_symbol(request(&snapshot, "new", "call.ts", 0, 1))
            .await
            .unwrap()
    )
    .await
    .contains("'base'"));
    assert!(app
        .read_navigation_file(&snapshot.id, "new", "/etc/passwd", true)
        .await
        .is_err());
}

#[tokio::test]
async fn cancellation_crash_capabilities_and_external_handles() {
    let (repo, store, app) = fixture();
    let dependency = store.path().join("dependency.ts");
    fs::write(&dependency, "external dependency\n").unwrap();
    let mut preferences = app.store.read().unwrap().preferences;
    preferences.language_servers[0].env.insert(
        "PEER_FAKE_EXTERNAL".into(),
        dependency.to_str().unwrap().into(),
    );
    app.save_preferences(preferences.clone()).unwrap();
    let snapshot = app
        .open_repository(
            repo.path().to_str().unwrap(),
            Some(Comparison {
                view: "code".into(),
                ..Comparison::default()
            }),
        )
        .await
        .unwrap();
    let external = app
        .navigate_symbol(request(&snapshot, "new", "call.ts", 2, 2))
        .await
        .unwrap();
    assert!(external.locations[0].external);
    assert_eq!(external.locations[0].label, "Installed dependency");
    fs::write(dependency, "changed installation\n").unwrap();
    assert_eq!(source(&app, &external).await, "external dependency\n");
    let pending = request(&snapshot, "new", "call.ts", 3, 1);
    let id = pending.request_id.clone();
    let app = Arc::new(app);
    let task_app = app.clone();
    let query = tokio::spawn(async move { task_app.navigate_symbol(pending).await });
    tokio::time::sleep(Duration::from_millis(100)).await;
    app.cancel_navigation(&id);
    assert_eq!(query.await.unwrap().unwrap_err().code, "cancelled");
    assert_eq!(
        app.navigate_symbol(request(&snapshot, "new", "call.ts", 4, 1))
            .await
            .unwrap_err()
            .code,
        "serverError"
    );
    assert_eq!(
        app.navigate_symbol(request(&snapshot, "new", "call.ts", 0, 1))
            .await
            .unwrap()
            .locations
            .len(),
        1
    );
    preferences.language_servers[0]
        .env
        .insert("PEER_FAKE_UNSUPPORTED".into(), "1".into());
    app.save_preferences(preferences).unwrap();
    assert_eq!(
        app.navigate_symbol(request(&snapshot, "new", "call.ts", 0, 1))
            .await
            .unwrap_err()
            .code,
        "unsupported"
    );
}

#[tokio::test]
async fn navigation_recovers_from_analysis_invalidated_by_opening_documents() {
    let (repo, _store, app) = fixture();
    let mut preferences = app.store.read().unwrap().preferences;
    preferences.language_servers[0].env.insert(
        "PEER_FAKE_ERRORS".into(),
        serde_json::json!({"code": -32801, "count": 2}).to_string(),
    );
    app.save_preferences(preferences).unwrap();
    let snapshot = app
        .open_repository(repo.path().to_str().unwrap(), Some(Comparison::default()))
        .await
        .unwrap();
    let definition = app
        .navigate_symbol(request(&snapshot, "new", "call.ts", 0, 1))
        .await
        .unwrap();
    assert_eq!(definition.kind, "definitions");
    assert_eq!(definition.locations[0].path, "defs.ts");
    assert_eq!(
        source(&app, &definition).await,
        "export function asdf() { return 'base'; }\n"
    );

    let position = definition.locations[0].range.start;
    let references = app
        .navigate_symbol(request(
            &snapshot,
            "new",
            "defs.ts",
            position.line,
            position.character,
        ))
        .await
        .unwrap();
    assert_eq!(references.kind, "references");
    assert_eq!(references.locations.len(), 1);
    assert_eq!(references.locations[0].path, "call.ts");
    assert_eq!(
        references.locations[0].range.start,
        Position {
            line: 0,
            character: 0
        }
    );
}

#[tokio::test]
async fn utf16_renames_and_missing_servers() {
    let (repo, _store, app) = fixture();
    git(repo.path(), &["mv", "defs.ts", "renamed.ts"]);
    fs::write(repo.path().join("call.ts"), "'😀'; asdf();\r\n").unwrap();
    let snapshot = app
        .open_repository(repo.path().to_str().unwrap(), Some(Comparison::default()))
        .await
        .unwrap();
    let result = app
        .navigate_symbol(request(&snapshot, "new", "call.ts", 0, 7))
        .await
        .unwrap();
    assert_eq!(result.locations[0].path, "renamed.ts");
    let old = app
        .navigate_symbol(request(&snapshot, "old", "call.ts", 0, 1))
        .await
        .unwrap();
    assert_eq!(old.locations[0].path, "defs.ts");
    let mut preferences = app.store.read().unwrap().preferences;
    preferences.language_servers[0].executable = "peer-no-such-language-server".into();
    app.save_preferences(preferences).unwrap();
    assert_eq!(
        app.navigate_symbol(request(&snapshot, "old", "call.ts", 0, 1))
            .await
            .unwrap_err()
            .code,
        "missingServer"
    );
}

// Unix launchers exercise real exec/PATH lookup; Windows uses a different process model.
#[cfg(unix)]
#[tokio::test]
async fn configured_server_runtime_path_is_authoritative_under_finder_path() {
    use std::os::unix::{fs::symlink, fs::PermissionsExt};

    const CHILD_INSTALL: &str = "PEER_NAVIGATION_PATH_TEST_INSTALL";
    const FINDER_PATH: &str = "/usr/bin:/bin:/usr/sbin:/sbin";
    const RUNTIME: &str = "peer-navigation-test-runtime";

    let install = match std::env::var_os(CHILD_INSTALL) {
        Some(path) => std::path::PathBuf::from(path),
        None => {
            // Resolve the suite's Node prerequisite before isolating the child.
            let node = Command::new("node")
                .args(["-p", "process.execPath"])
                .output()
                .unwrap();
            assert!(
                node.status.success(),
                "{}",
                String::from_utf8_lossy(&node.stderr)
            );
            let node = String::from_utf8(node.stdout).unwrap();
            let temporary = tempfile::tempdir().unwrap();
            let install = temporary.path().join("language server installation");
            let runtime = install.join("runtime");
            fs::create_dir_all(&runtime).unwrap();
            symlink(node.trim(), runtime.join(RUNTIME)).unwrap();
            // Like a real server launcher, this must find its runtime through PATH.
            // Its basename deliberately collides with the inherited /usr/bin/env.
            let launcher = install.join("env");
            fs::write(&launcher, "#!/bin/sh\nexec \"$@\"\n").unwrap();
            fs::set_permissions(&launcher, fs::Permissions::from_mode(0o755)).unwrap();

            // Re-enter only this test with a pristine Finder-style environment.
            // Never change the parallel test runner's process-global environment.
            let output = Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "configured_server_runtime_path_is_authoritative_under_finder_path",
                    "--nocapture",
                ])
                .env_clear()
                .env("PATH", FINDER_PATH)
                .env("HOME", temporary.path())
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .env(CHILD_INSTALL, &install)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "isolated navigation test failed:\n{}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            return;
        }
    };

    assert_eq!(std::env::var("PATH").unwrap(), FINDER_PATH);
    let (repo, _store, app) = fixture();
    let mut preferences = app.store.read().unwrap().preferences;
    let server = &mut preferences.language_servers[0];
    server.executable = install.join("env").to_str().unwrap().into();
    server.args.insert(0, RUNTIME.into());
    server.env.insert(
        "PATH".into(),
        install.join("runtime").to_str().unwrap().into(),
    );
    app.save_preferences(preferences.clone()).unwrap();
    let snapshot = app
        .open_repository(repo.path().to_str().unwrap(), Some(Comparison::default()))
        .await
        .unwrap();
    let definition = app
        .navigate_symbol(request(&snapshot, "new", "call.ts", 0, 1))
        .await
        .unwrap();
    assert_eq!(definition.kind, "definitions");
    assert_eq!(definition.locations.len(), 1);
    assert_eq!(definition.locations[0].path, "defs.ts");
    assert_eq!(
        source(&app, &definition).await,
        "export function asdf() { return 'base'; }\n"
    );
    app.shutdown_navigation().await;

    // Neither the absolute launcher nor inherited system tools can supply the
    // private runtime without the configured PATH.
    preferences.language_servers[0].env.remove("PATH");
    app.save_preferences(preferences.clone()).unwrap();
    assert_eq!(
        app.navigate_symbol(request(&snapshot, "new", "call.ts", 0, 1))
            .await
            .unwrap_err()
            .code,
        "serverError"
    );
    app.shutdown_navigation().await;

    // An explicit PATH must also govern executable discovery. Falling back to
    // inherited /usr/bin/env would successfully launch the same runtime/fixture
    // with these arguments, hiding a missing configured server.
    preferences.language_servers[0].executable = "env".into();
    preferences.language_servers[0].env.insert(
        "PATH".into(),
        install.join("runtime").to_str().unwrap().into(),
    );
    app.save_preferences(preferences).unwrap();
    assert_eq!(
        app.navigate_symbol(request(&snapshot, "new", "call.ts", 0, 1))
            .await
            .unwrap_err()
            .code,
        "missingServer"
    );
    app.shutdown_navigation().await;
}

#[cfg(target_os = "macos")]
#[tokio::test]
async fn login_shell_path_launches_servers_and_their_toolchains_from_finder() {
    use std::os::unix::{fs::symlink, fs::PermissionsExt};

    const CHILD_HOME: &str = "PEER_NAVIGATION_SHELL_TEST_HOME";
    const FINDER_PATH: &str = "/usr/bin:/bin:/usr/sbin:/sbin";
    let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/support/fake-lsp.mjs");
    let mut servers = default_servers();
    let mut custom = servers
        .iter()
        .find(|server| server.id == "typescript")
        .unwrap()
        .clone();
    custom.id = "custom".into();
    custom.name = "Custom server".into();
    custom.executable = "peer-navigation-shell-server".into();
    custom.languages = [("peer".into(), "plaintext".into())].into();
    custom.args.clear();
    servers.push(custom);
    for server in &mut servers {
        server
            .env
            .insert("PEER_FAKE_SCRIPT".into(), script.to_str().unwrap().into());
    }
    let home = match std::env::var_os(CHILD_HOME) {
        Some(path) => std::path::PathBuf::from(path),
        None => {
            let node = Command::new("node")
                .args(["-p", "process.execPath"])
                .output()
                .unwrap();
            assert!(node.status.success());
            let node = String::from_utf8(node.stdout).unwrap();
            let temporary = tempfile::tempdir().unwrap();
            let home = temporary.path();
            fs::create_dir(home.join("server bin")).unwrap();
            fs::create_dir(home.join("runtime bin")).unwrap();
            symlink(
                node.trim(),
                home.join("runtime bin/peer-navigation-shell-runtime"),
            )
            .unwrap();
            symlink(node.trim(), home.join("runtime bin/node")).unwrap();
            for server in &servers {
                let launcher = home.join("server bin").join(&server.executable);
                // npm-installed servers use env's shebang lookup for Node.
                // Native servers/shims must also pass PATH to their toolchains.
                let body = if matches!(server.id.as_str(), "typescript" | "python") {
                    format!(
                        "#!/usr/bin/env node\nimport {};\n",
                        serde_json::to_string(url::Url::from_file_path(&script).unwrap().as_str())
                            .unwrap()
                    )
                } else {
                    "#!/bin/sh\nexec peer-navigation-shell-runtime \"$PEER_FAKE_SCRIPT\" \"$@\"\n"
                        .into()
                };
                fs::write(&launcher, body).unwrap();
                fs::set_permissions(&launcher, fs::Permissions::from_mode(0o755)).unwrap();
            }
            // Both login and interactive startup files contribute to the PATH.
            // Startup banners and spaces in directories must not corrupt it.
            fs::write(
                home.join(".zprofile"),
                "printf 'login banner\\n'\nexport PATH=\"$HOME/server bin:$PATH\"\n",
            )
            .unwrap();
            fs::write(
                home.join(".zshrc"),
                "printf 'interactive banner\\n'\nexport PATH=\"$HOME/runtime bin:$PATH\"\n",
            )
            .unwrap();
            let output = Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "login_shell_path_launches_servers_and_their_toolchains_from_finder",
                    "--nocapture",
                ])
                .env_clear()
                .env("PATH", FINDER_PATH)
                .env("HOME", home)
                .env("ZDOTDIR", home)
                .env("SHELL", "/bin/zsh")
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .env(CHILD_HOME, home)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "isolated navigation test failed:\n{}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            return;
        }
    };
    assert_eq!(std::env::var("PATH").unwrap(), FINDER_PATH);
    let (repo, _store, app) = fixture();
    // Keep every preset enabled to exercise extension-based dispatch, not just
    // a renamed TypeScript server. These are protocol fixtures, not analyzers.
    for server in &servers {
        for extension in server.languages.keys() {
            let symbol = format!("answer_{extension}");
            let (caller, definition) = match server.id.as_str() {
                "go" => (
                    format!("package main\nfunc caller() {{ {symbol}() }}\n"),
                    format!("package main\nfunc {symbol}() int {{ return 42 }}\n"),
                ),
                "rust" => (
                    format!("mod defs_{extension};\npub fn caller() -> i32 {{ defs_{extension}::{symbol}() }}\n"),
                    format!("pub fn {symbol}() -> i32 {{ 42 }}\n"),
                ),
                "python" => (
                    format!("from defs_{extension} import {symbol}\n{symbol}()\n"),
                    format!("def {symbol}():\n    return 42\n"),
                ),
                _ => (
                    format!("import {{ {symbol} }} from './defs_{extension}';\n{symbol}();\n"),
                    format!("export function {symbol}() {{ return 42; }}\n"),
                ),
            };
            fs::write(
                repo.path().join(format!("call_{extension}.{extension}")),
                caller,
            )
            .unwrap();
            fs::write(
                repo.path().join(format!("defs_{extension}.{extension}")),
                definition,
            )
            .unwrap();
        }
    }
    let mut preferences = app.store.read().unwrap().preferences;
    preferences.language_servers = servers.clone();
    app.save_preferences(preferences.clone()).unwrap();
    let snapshot = app
        .open_repository(repo.path().to_str().unwrap(), Some(Comparison::default()))
        .await
        .unwrap();
    let configured_path = std::env::join_paths([home.join("server bin"), home.join("runtime bin")])
        .unwrap()
        .into_string()
        .unwrap();
    for (index, server) in servers.iter().enumerate() {
        let absolute = home
            .join("server bin")
            .join(&server.executable)
            .into_os_string()
            .into_string()
            .unwrap();
        for (mode, executable, path) in [
            ("shell PATH", server.executable.as_str(), None),
            ("absolute executable", absolute.as_str(), None),
            (
                "configured PATH",
                server.executable.as_str(),
                Some(&configured_path),
            ),
        ] {
            let configured = &mut preferences.language_servers[index];
            configured.executable = executable.into();
            configured.env.remove("PATH");
            if let Some(path) = path {
                configured.env.insert("PATH".into(), path.clone());
            }
            app.save_preferences(preferences.clone()).unwrap();
            for extension in server.languages.keys() {
                let caller = format!("call_{extension}.{extension}");
                let target = format!("defs_{extension}.{extension}");
                let text = fs::read_to_string(repo.path().join(&caller)).unwrap();
                let character = text
                    .lines()
                    .nth(1)
                    .unwrap()
                    .find(&format!("answer_{extension}"))
                    .unwrap() as u32;
                let definition = app
                    .navigate_symbol(request(&snapshot, "new", &caller, 1, character))
                    .await
                    .unwrap_or_else(|error| panic!("{} .{extension} {mode}: {error:?}", server.id));
                assert_eq!(definition.kind, "definitions");
                assert_eq!(definition.locations[0].path, target);
                assert_eq!(
                    source(&app, &definition).await,
                    fs::read_to_string(repo.path().join(&target)).unwrap()
                );
                let position = definition.locations[0].range.start;
                let references = app
                    .navigate_symbol(request(
                        &snapshot,
                        "new",
                        &target,
                        position.line,
                        position.character,
                    ))
                    .await
                    .unwrap();
                assert_eq!(references.kind, "references");
                assert!(
                    references
                        .locations
                        .iter()
                        .any(|location| location.path == caller
                            && location.range.start == Position { line: 1, character }),
                    "{} .{extension} {mode}: {references:?}",
                    server.id
                );
            }
            app.shutdown_navigation().await;
        }
        let extension = server.languages.keys().next().unwrap();
        let caller = format!("call_{extension}.{extension}");
        // Neither cached shell PATH nor inherited tools may bypass an explicit
        // override: missing executable and missing child runtime are distinct.
        for (executable, path, error) in [
            (
                server.executable.as_str(),
                home.join("runtime bin"),
                "missingServer",
            ),
            (absolute.as_str(), home.join("server bin"), "serverError"),
        ] {
            let configured = &mut preferences.language_servers[index];
            configured.executable = executable.into();
            configured
                .env
                .insert("PATH".into(), path.to_str().unwrap().into());
            app.save_preferences(preferences.clone()).unwrap();
            assert_eq!(
                app.navigate_symbol(request(&snapshot, "new", &caller, 1, 1))
                    .await
                    .unwrap_err()
                    .code,
                error,
                "{}",
                server.id
            );
            app.shutdown_navigation().await;
        }
        println!("{}: all extensions resolved definitions/references; PATH and runtime failures respected", server.id);
    }
    assert_eq!(std::env::var("PATH").unwrap(), FINDER_PATH);
    app.shutdown_navigation().await;
}

#[tokio::test]
#[ignore = "requires gopls, typescript-language-server and rust-analyzer with their toolchains"]
async fn real_language_servers_resolve_scopes_imports_methods_and_references() {
    for language in ["go", "typescript", "javascript", "rust"] {
        let (repo, _store, app) = fixture();
        let (file, definition, source, marker, method_marker, shadow_marker) = match language {
            "go" => {
                fs::write(
                    repo.path().join("go.mod"),
                    "module example.com/navigation\n\ngo 1.22\n",
                )
                .unwrap();
                fs::write(repo.path().join("defs.go"), "package navigation\nfunc asdf() int { return 1 }\ntype Thing struct{}\nfunc (Thing) method() int { return asdf() }\n").unwrap();
                ("call.go", "defs.go", "package navigation\nfunc use() { y := asdf(); _ = y;\n{ y := 2; _ = y; }; var t Thing; _ = t.method() }\n", "asdf()", "method()", "y := 2; _ = y;")
            }
            "typescript" => {
                fs::write(
                    repo.path().join("tsconfig.json"),
                    "{\"compilerOptions\":{\"strict\":true},\"include\":[\"*.ts\"]}",
                )
                .unwrap();
                fs::write(repo.path().join("defs.ts"), "export function asdf() { return 1; }\nexport class Thing { method() { return asdf(); } }\n").unwrap();
                ("call.ts", "defs.ts", "import { asdf, Thing } from './defs';\nconst y = asdf();\nfunction use() { const y = 2; return y; }\nnew Thing().method();\n", "= asdf()", "method()", "return y;")
            }
            "javascript" => {
                // Do not let TypeScript module resolution prefer the fixture's defs.ts.
                fs::remove_file(repo.path().join("defs.ts")).unwrap();
                fs::write(
                    repo.path().join("jsconfig.json"),
                    "{\"compilerOptions\":{\"checkJs\":true},\"include\":[\"*.js\"]}",
                )
                .unwrap();
                fs::write(repo.path().join("defs.js"), "export function asdf() { return 1; }\nexport class Thing { method() { return asdf(); } }\n").unwrap();
                ("call.js", "defs.js", "import { asdf, Thing } from './defs';\nconst y = asdf();\nfunction use() { const y = 2; return y; }\nnew Thing().method();\n", "= asdf()", "method()", "return y;")
            }
            _ => {
                fs::write(repo.path().join("Cargo.toml"), "[package]\nname=\"nav_smoke\"\nversion=\"0.1.0\"\nedition=\"2021\"\n[lib]\npath=\"lib.rs\"\n").unwrap();
                fs::write(repo.path().join("defs.rs"), "pub fn asdf() -> i32 { 1 }\npub struct Thing;\nimpl Thing { pub fn method(&self) -> i32 { asdf() } }\n").unwrap();
                ("lib.rs", "defs.rs", "mod defs;\nuse defs::{asdf, Thing};\nfn use_it() { let y = asdf(); let _ = y;\n{ let y = 2; let _ = y; } let t = Thing; t.method(); }\n", "= asdf()", "method()", "let y = 2; let _ = y;")
            }
        };
        fs::write(repo.path().join(file), source).unwrap();
        let server_language = if language == "javascript" {
            "typescript"
        } else {
            language
        };
        let mut preferences = app.store.read().unwrap().preferences;
        let mut server = default_servers()
            .into_iter()
            .find(|server| server.id == server_language)
            .unwrap();
        if let Ok(executable) =
            std::env::var(format!("PEER_{}_SERVER", server_language.to_uppercase()))
        {
            server.executable = executable;
        }
        if language == "typescript" {
            if let Ok(directory) = std::env::var("PEER_LSP_LOG_DIR") {
                server.initialization_options["tsserver"]["logDirectory"] =
                    serde_json::json!(directory);
                server.initialization_options["tsserver"]["logVerbosity"] =
                    serde_json::json!("verbose");
            }
        }
        preferences.language_servers = vec![server];
        app.save_preferences(preferences).unwrap();
        let snapshot = app
            .open_repository(
                repo.path().to_str().unwrap(),
                Some(Comparison {
                    view: "code".into(),
                    ..Comparison::default()
                }),
            )
            .await
            .unwrap();
        let position = |marker: &str, symbol: &str| -> Position {
            let (line, text) = source
                .lines()
                .enumerate()
                .find(|(_, line)| line.contains(marker))
                .unwrap();
            let start = text.find(marker).unwrap() + marker.rfind(symbol).unwrap();
            Position {
                line: line as u32,
                character: text[..start].encode_utf16().count() as u32,
            }
        };
        let call = position(marker, "asdf");
        let result = if language == "rust" {
            // One user request must await readiness; a test-side polling loop
            // previously hid rust-analyzer's empty responses during startup.
            app.navigate_symbol(request(&snapshot, "new", file, call.line, call.character))
                .await
                .unwrap()
        } else {
            let mut result = None;
            let mut last_error = String::new();
            for _ in 0..50 {
                match app
                    .navigate_symbol(request(&snapshot, "new", file, call.line, call.character))
                    .await
                {
                    Ok(value) if !value.locations.is_empty() => {
                        result = Some(value);
                        break;
                    }
                    Ok(_) => {}
                    Err(error) if error.code == "serverError" => {
                        last_error = error.message;
                    }
                    Err(error) => panic!("{language}: {error:?}"),
                }
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
            result
                .unwrap_or_else(|| panic!("{language}: no definition after indexing: {last_error}"))
        };
        assert_eq!(
            result.locations[0].path, definition,
            "{language}: {result:?}"
        );
        let mut reference_request = request(&snapshot, "new", definition, 0, 0);
        reference_request.position = result.locations[0].range.start;
        let references = app.navigate_symbol(reference_request).await.unwrap();
        assert_eq!(references.kind, "references", "{language}");
        assert!(
            references
                .locations
                .iter()
                .any(|location| location.path == file),
            "{language}: {references:?}"
        );
        let method = position(method_marker, "method");
        let result = app
            .navigate_symbol(request(
                &snapshot,
                "new",
                file,
                method.line,
                method.character,
            ))
            .await
            .unwrap();
        assert_eq!(result.locations[0].path, definition, "{language}: method");
        let shadow = position(shadow_marker, "y");
        let result = app
            .navigate_symbol(request(
                &snapshot,
                "new",
                file,
                shadow.line,
                shadow.character,
            ))
            .await
            .unwrap();
        assert_eq!(result.locations[0].path, file, "{language}: local variable");
        assert_eq!(
            result.locations[0].range.start.line, shadow.line,
            "{language}: shadowed declaration"
        );
        if language == "rust" {
            for restart in 0..3 {
                app.shutdown_navigation().await;
                let result = app
                    .navigate_symbol(request(&snapshot, "new", file, call.line, call.character))
                    .await
                    .unwrap();
                assert_eq!(
                    result.locations.len(),
                    1,
                    "Rust restart {restart}: {result:?}"
                );
                assert_eq!(result.locations[0].path, definition);
            }
        }
        app.shutdown_navigation().await;
    }
}

#[tokio::test]
#[ignore = "requires pyright-langserver and Python"]
async fn real_python_server_resolves_snapshot_imports_stubs_methods_and_references() {
    let (repo, _store, app) = fixture();
    let project = repo.path().join("python");
    fs::create_dir_all(project.join("src")).unwrap();
    fs::write(project.join("pyproject.toml"), "[tool.pyright]\n").unwrap();
    let caller = "from defs import answer, answer as alias, Thing\nouter = 0\nvalue = answer() + alias()\ndef local():\n    outer = 2; return outer\nThing().method()\n";
    let old = "def answer():\n    return 'old'\n\nclass Thing:\n    def method(self):\n        return answer()\n";
    let new = old.replace("'old'", "'new'");
    fs::write(project.join("src/call.py"), caller).unwrap();
    fs::write(project.join("src/defs.py"), old).unwrap();
    fs::write(
        project.join("src/contract.pyi"),
        "from defs import Thing\n\ndef build() -> Thing: ...\n",
    )
    .unwrap();
    git(repo.path(), &["add", "."]);
    git(repo.path(), &["commit", "-m", "Python navigation"]);
    fs::write(project.join("src/defs.py"), &new).unwrap();
    let mut preferences = app.store.read().unwrap().preferences;
    let mut server = default_servers()
        .into_iter()
        .find(|server| server.id == "python")
        .unwrap();
    if let Ok(executable) = std::env::var("PEER_PYTHON_SERVER") {
        server.executable = executable;
    }
    preferences.language_servers = vec![server];
    app.save_preferences(preferences).unwrap();
    let snapshot = app
        .open_repository(repo.path().to_str().unwrap(), Some(Comparison::default()))
        .await
        .unwrap();
    for (side, expected) in [("old", old), ("new", new.as_str())] {
        let definition = app
            .navigate_symbol(request(&snapshot, side, "python/src/call.py", 2, 20))
            .await
            .unwrap();
        assert_eq!(definition.kind, "definitions");
        assert_eq!(definition.locations[0].path, "python/src/defs.py");
        assert_eq!(definition.locations[0].range.start.line, 0);
        assert_eq!(source(&app, &definition).await, expected);

        let mut reference_request = request(&snapshot, side, "python/src/defs.py", 0, 0);
        reference_request.position = definition.locations[0].range.start;
        let references = app.navigate_symbol(reference_request).await.unwrap();
        assert_eq!(references.kind, "references");
        assert!(
            references.locations.iter().any(|location| {
                location.path == "python/src/call.py"
                    && location.range.start.line == 2
                    && location.range.start.character == 8
            }),
            "{side}: {references:?}"
        );
    }
    let method = app
        .navigate_symbol(request(&snapshot, "new", "python/src/call.py", 5, 9))
        .await
        .unwrap();
    assert_eq!(method.locations[0].path, "python/src/defs.py");
    assert_eq!(method.locations[0].range.start.line, 4);
    let shadow = app
        .navigate_symbol(request(&snapshot, "new", "python/src/call.py", 4, 23))
        .await
        .unwrap();
    assert_eq!(shadow.locations[0].path, "python/src/call.py");
    assert_eq!(shadow.locations[0].range.start.line, 4);
    assert_eq!(shadow.locations[0].range.start.character, 4);
    let stub = app
        .navigate_symbol(request(&snapshot, "new", "python/src/contract.pyi", 2, 16))
        .await
        .unwrap();
    assert_eq!(stub.locations[0].path, "python/src/defs.py");
    assert_eq!(stub.locations[0].range.start.line, 3);
}

#[cfg(unix)]
#[tokio::test]
async fn package_links_use_snapshot_source_and_refresh_releases_workspaces() {
    let (repo, store, app) = fixture();
    fs::create_dir_all(repo.path().join("packages/lib")).unwrap();
    fs::write(
        repo.path().join("packages/lib/source.ts"),
        "export const version = 'old';\n",
    )
    .unwrap();
    fs::write(repo.path().join("package.json"), "{}").unwrap();
    git(repo.path(), &["add", "."]);
    git(repo.path(), &["commit", "-m", "package"]);
    fs::write(
        repo.path().join("packages/lib/source.ts"),
        "export const version = 'working';\n",
    )
    .unwrap();
    fs::create_dir_all(repo.path().join("node_modules/dependency")).unwrap();
    fs::write(
        repo.path().join("node_modules/dependency/index.d.ts"),
        "export const installed: number;\n",
    )
    .unwrap();
    std::os::unix::fs::symlink(
        repo.path().join("packages/lib"),
        repo.path().join("node_modules/local"),
    )
    .unwrap();
    let snapshot = app
        .open_repository(repo.path().to_str().unwrap(), Some(Comparison::default()))
        .await
        .unwrap();
    app.navigate_symbol(request(&snapshot, "old", "call.ts", 0, 1))
        .await
        .unwrap();
    let log = fs::read_to_string(store.path().join("servers.log")).unwrap();
    let root = Path::new(log.lines().last().unwrap());
    assert_eq!(
        fs::read_to_string(root.join("node_modules/local/source.ts")).unwrap(),
        "export const version = 'old';\n"
    );
    assert_eq!(
        fs::read_to_string(root.join("node_modules/dependency/index.d.ts")).unwrap(),
        "export const installed: number;\n"
    );
    assert!(fs::canonicalize(root.join("node_modules/local"))
        .unwrap()
        .starts_with(root));
    let mut preferences = app.store.read().unwrap().preferences;
    preferences.language_servers[0].env.insert(
        "PEER_FAKE_EXTERNAL".into(),
        root.join("node_modules/local/source.ts")
            .to_string_lossy()
            .into_owned(),
    );
    app.save_preferences(preferences.clone()).unwrap();
    let aliased = app
        .navigate_symbol(request(&snapshot, "old", "call.ts", 2, 1))
        .await
        .unwrap();
    assert!(!aliased.locations[0].external);
    assert_eq!(aliased.locations[0].path, "packages/lib/source.ts");
    assert!(aliased.locations[0].label.starts_with("A ·"));
    assert!(source(&app, &aliased).await.contains("'old'"));
    preferences.language_servers[0].env.insert(
        "PEER_FAKE_EXTERNAL".into(),
        repo.path()
            .join("node_modules/local/source.ts")
            .to_string_lossy()
            .into_owned(),
    );
    app.save_preferences(preferences).unwrap();
    assert_eq!(
        app.navigate_symbol(request(&snapshot, "old", "call.ts", 2, 1))
            .await
            .unwrap_err()
            .code,
        "missingSource"
    );
    app.open_repository(repo.path().to_str().unwrap(), Some(Comparison::default()))
        .await
        .unwrap();
    assert!(
        !root.exists(),
        "refresh must release the old temporary source workspace"
    );
    assert_eq!(
        fs::read_to_string(repo.path().join("packages/lib/source.ts")).unwrap(),
        "export const version = 'working';\n"
    );
}

#[tokio::test]
async fn large_and_binary_dependency_previews_and_missing_results_are_explicit() {
    let (repo, store, app) = fixture();
    let dependency = store.path().join("dependency.ts");
    fs::write(&dependency, "x".repeat(1024 * 1024 + 1)).unwrap();
    let mut preferences = app.store.read().unwrap().preferences;
    preferences.language_servers[0].env.insert(
        "PEER_FAKE_EXTERNAL".into(),
        dependency.to_str().unwrap().into(),
    );
    app.save_preferences(preferences).unwrap();
    let snapshot = app
        .open_repository(repo.path().to_str().unwrap(), Some(Comparison::default()))
        .await
        .unwrap();
    let result = app
        .navigate_symbol(request(&snapshot, "old", "call.ts", 2, 1))
        .await
        .unwrap();
    let id = &result.locations[0].document_id;
    assert!(
        app.read_navigation_file(&snapshot.id, "old", id, false)
            .await
            .unwrap()
            .deferred
    );
    assert_eq!(
        app.read_navigation_file(&snapshot.id, "old", id, true)
            .await
            .unwrap()
            .content
            .unwrap()
            .len(),
        1024 * 1024 + 1
    );
    fs::write(dependency, [0, 1, 2]).unwrap();
    let snapshot = app
        .open_repository(repo.path().to_str().unwrap(), Some(Comparison::default()))
        .await
        .unwrap();
    let result = app
        .navigate_symbol(request(&snapshot, "old", "call.ts", 2, 1))
        .await
        .unwrap();
    assert_eq!(
        app.read_navigation_file(&snapshot.id, "old", &result.locations[0].document_id, true)
            .await
            .unwrap()
            .kind,
        "binary"
    );
    let result = app
        .navigate_symbol(request(&snapshot, "old", "call.ts", 0, 6))
        .await
        .unwrap();
    assert!(result.locations.is_empty());
}

#[tokio::test]
async fn source_inventory_includes_hidden_untracked_files_and_pins_deleted_files() {
    let (repo, _store, app) = fixture();
    fs::write(repo.path().join("fresh.ts"), "export function fresh() {}\n").unwrap();
    fs::write(repo.path().join("call.ts"), "asdf();\nkeep();\nfresh();\n").unwrap();
    fs::remove_file(repo.path().join("keep.ts")).unwrap();
    let snapshot = app
        .open_repository(
            repo.path().to_str().unwrap(),
            Some(Comparison {
                include_untracked: false,
                ..Default::default()
            }),
        )
        .await
        .unwrap();
    assert!(!snapshot.files.iter().any(|file| file.path == "fresh.ts"));
    let result = app
        .navigate_symbol(request(&snapshot, "new", "call.ts", 2, 1))
        .await
        .unwrap();
    assert_eq!(result.locations[0].path, "fresh.ts");
    let deleted = app
        .navigate_symbol(request(&snapshot, "old", "call.ts", 1, 1))
        .await
        .unwrap();
    assert!(source(&app, &deleted).await.contains("export const keep"));
    let missing = app
        .navigate_symbol(request(&snapshot, "new", "call.ts", 1, 1))
        .await
        .unwrap();
    assert!(missing.locations.is_empty());
    app.open_repository(
        repo.path().to_str().unwrap(),
        Some(Comparison {
            mode: "staged".into(),
            ..Default::default()
        }),
    )
    .await
    .unwrap();
    assert_eq!(
        app.navigate_symbol(request(&snapshot, "old", "call.ts", 1, 1))
            .await
            .unwrap_err()
            .code,
        "stale"
    );
    assert_eq!(
        app.read_navigation_file(&snapshot.id, "old", &deleted.locations[0].document_id, true)
            .await
            .unwrap_err()
            .code,
        "stale"
    );
}
