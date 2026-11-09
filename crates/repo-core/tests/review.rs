use peer_core::{repository, theme, Comparison, Inspector, NewComment};
use std::{fs, path::Path, process::Command};

fn git(root: &Path, args: &[&str]) {
    let out = Command::new("git")
        .args(args)
        .current_dir(root)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}
fn fixture() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    git(dir.path(), &["init", "-b", "main"]);
    git(dir.path(), &["config", "user.name", "Test"]);
    git(
        dir.path(),
        &["config", "user.email", "test@example.invalid"],
    );
    git(dir.path(), &["config", "core.autocrlf", "false"]);
    fs::write(
        dir.path().join("hello.ts"),
        "const oldValue = 1;\n\tconsole.log(oldValue);\n",
    )
    .unwrap();
    fs::write(dir.path().join("keep.txt"), "unchanged\n").unwrap();
    fs::write(dir.path().join(".gitignore"), "ignored/\n").unwrap();
    git(dir.path(), &["add", "."]);
    git(dir.path(), &["commit", "-m", "initial"]);
    dir
}
fn mode(mode: &str) -> Comparison {
    Comparison {
        mode: mode.into(),
        ..Comparison::default()
    }
}
fn code() -> Comparison {
    Comparison {
        view: "code".into(),
        ..Comparison::default()
    }
}

#[tokio::test]
async fn relocating_repository_preserves_sessions_and_review_queues_after_restart() {
    let repo = fixture();
    let store = tempfile::tempdir().unwrap();
    let destination = tempfile::tempdir().unwrap();
    let app = Inspector::new(store.path()).unwrap();
    fs::write(repo.path().join("hello.ts"), "changed\n").unwrap();
    let mut originals = Vec::new();
    for comparison in [mode("all"), code()] {
        let snapshot = app
            .open_repository(repo.path().to_str().unwrap(), Some(comparison))
            .await
            .unwrap();
        let file = snapshot
            .files
            .iter()
            .find(|f| f.path == "hello.ts")
            .unwrap();
        let content = app.read_file(&snapshot.id, &file.id, false).await.unwrap();
        app.add_comment(NewComment {
            snapshot_id: snapshot.id.clone(),
            file_id: file.id.clone(),
            fingerprint: content.fingerprint.clone(),
            body: snapshot.comparison.view.clone(),
            side: None,
            line: None,
            end_line: None,
        })
        .await
        .unwrap();
        if snapshot.comparison.view == "changes" {
            app.set_reviewed(&snapshot.id, &file.id, &content.fingerprint, true)
                .await
                .unwrap();
        }
        originals.push(snapshot);
    }
    let previous = &originals[0].repository.root;
    let mut preferences = app.store.read().unwrap().preferences;
    preferences.sessions.insert(
        previous.clone(),
        peer_core::types::Session {
            comparison: code(),
            selected_path: Some("hello.ts".into()),
            scroll_top: 120.0,
            last_changes: Some(mode("all")),
        },
    );
    app.save_preferences(preferences).unwrap();
    let moved = destination.path().join("renamed");
    fs::rename(repo.path(), &moved).unwrap();
    let relocated = app
        .relocate_repository(previous, moved.to_str().unwrap())
        .await
        .unwrap();
    assert_eq!(relocated.repository.name, "renamed");
    assert_eq!(relocated.repository.id, originals[0].repository.id);
    assert_eq!(relocated.comparison.view, "code");
    let root = relocated.repository.root;
    let preferences = app.store.read().unwrap().preferences;
    assert_eq!(preferences.recent_repositories, vec![root.clone()]);
    assert_eq!(preferences.last_repository.as_deref(), Some(root.as_str()));
    assert!(!preferences.sessions.contains_key(previous));
    assert_eq!(
        preferences.sessions[&root].selected_path.as_deref(),
        Some("hello.ts")
    );
    assert_eq!(preferences.sessions[&root].scroll_top, 120.0);
    let restarted = Inspector::new(store.path()).unwrap();
    for original in originals {
        let snapshot = restarted
            .open_repository(&root, Some(original.comparison.clone()))
            .await
            .unwrap();
        assert_eq!(snapshot.queue_id, original.queue_id);
        let queue = restarted.queue(&snapshot.id).await.unwrap();
        assert_eq!(queue.comments[0].body, original.comparison.view);
        assert!(!queue.comments[0].outdated);
        if original.comparison.view == "changes" {
            assert!(queue.reviewed.contains_key("hello.ts"));
        }
    }
    fs::create_dir(repo.path()).unwrap();
    git(repo.path(), &["init", "-b", "main"]);
    fs::write(repo.path().join("hello.ts"), "changed\n").unwrap();
    let reused = restarted
        .open_repository(repo.path().to_str().unwrap(), Some(code()))
        .await
        .unwrap();
    assert_ne!(reused.repository.id, relocated.repository.id);
    assert!(restarted
        .queue(&reused.id)
        .await
        .unwrap()
        .comments
        .is_empty());
    let reopened = Inspector::new(store.path())
        .unwrap()
        .open_repository(repo.path().to_str().unwrap(), Some(code()))
        .await
        .unwrap();
    assert_eq!(reopened.repository.id, reused.repository.id);
}

#[tokio::test]
async fn invalid_relocation_does_not_replace_saved_repositories_or_reviews() {
    let repo = fixture();
    let other = fixture();
    let store = tempfile::tempdir().unwrap();
    let app = Inspector::new(store.path()).unwrap();
    fs::write(repo.path().join("hello.ts"), "Keep this change\n").unwrap();
    let original = app
        .open_repository(repo.path().to_str().unwrap(), None)
        .await
        .unwrap();
    let file = original
        .files
        .iter()
        .find(|file| file.path == "hello.ts")
        .unwrap();
    let content = app.read_file(&original.id, &file.id, false).await.unwrap();
    let comment = app
        .add_comment(NewComment {
            snapshot_id: original.id.clone(),
            file_id: file.id.clone(),
            fingerprint: content.fingerprint.clone(),
            body: "Keep this feedback after a failed relocation".into(),
            side: Some("new".into()),
            line: Some(1),
            end_line: None,
        })
        .await
        .unwrap();
    app.set_reviewed(&original.id, &file.id, &content.fingerprint, true)
        .await
        .unwrap();
    let expected_queue = serde_json::to_value(app.queue(&original.id).await.unwrap()).unwrap();
    assert_eq!(expected_queue["comments"][0]["id"], comment.id);
    assert_eq!(expected_queue["reviewed"]["hello.ts"], content.fingerprint);
    let other = app
        .open_repository(other.path().to_str().unwrap(), None)
        .await
        .unwrap();
    let invalid = tempfile::tempdir().unwrap();
    let before = fs::read(store.path().join("state.json")).unwrap();
    for path in [
        invalid.path().join("missing"),
        invalid.path().to_path_buf(),
        other.repository.root.clone().into(),
    ] {
        assert!(app
            .relocate_repository(&original.repository.root, path.to_str().unwrap())
            .await
            .is_err());
        assert_eq!(fs::read(store.path().join("state.json")).unwrap(), before);
        assert_eq!(
            serde_json::to_value(app.queue(&original.id).await.unwrap()).unwrap(),
            expected_queue
        );
        assert_eq!(
            app.read_file(&original.id, &file.id, false)
                .await
                .unwrap()
                .new_content,
            content.new_content
        );
        assert!(app.queue(&other.id).await.unwrap().comments.is_empty());
    }
    drop(app);
    let restarted = Inspector::new(store.path()).unwrap();
    assert_eq!(fs::read(store.path().join("state.json")).unwrap(), before);
    let reopened = restarted
        .open_repository(&original.repository.root, Some(original.comparison.clone()))
        .await
        .unwrap();
    assert_eq!(reopened.repository.id, original.repository.id);
    assert_eq!(reopened.queue_id, original.queue_id);
    assert_eq!(
        serde_json::to_value(restarted.queue(&reopened.id).await.unwrap()).unwrap(),
        expected_queue
    );
}

#[cfg(unix)]
fn interrupt_next_snapshot(repo: &Path, app: &Inspector, command: &str, action: &str) {
    use std::os::unix::fs::PermissionsExt;

    let wrapper = repo.join(".git/refresh-git");
    let real_git = repository::discover_git(None);
    let quoted_git = format!("'{}'", real_git.replace('\'', "'\\''"));
    fs::write(
        &wrapper,
        format!(
            "#!/bin/sh\ncase \" $* \" in\n*' {command} '*)\n  if [ -f .git/refresh-pending ]; then\n    rm .git/refresh-pending\n    {action}\n  fi\n  ;;\nesac\nexec {quoted_git} \"$@\"\n"
        ),
    )
    .unwrap();
    fs::set_permissions(&wrapper, fs::Permissions::from_mode(0o755)).unwrap();
    fs::write(repo.join(".git/refresh-pending"), "").unwrap();
    let mut preferences = app.store.read().unwrap().preferences;
    preferences.git_executable = Some(wrapper.to_str().unwrap().into());
    app.save_preferences(preferences).unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn refresh_retries_a_snapshot_interrupted_by_an_index_update() {
    let repo = fixture();
    let store = tempfile::tempdir().unwrap();
    let app = Inspector::new(store.path()).unwrap();
    let old = app
        .open_repository(repo.path().to_str().unwrap(), Some(code()))
        .await
        .unwrap();
    interrupt_next_snapshot(
        repo.path(),
        &app,
        "ls-files --stage -z",
        "printf 'arrived during refresh\\n' > added.txt\n    git add added.txt",
    );
    let refreshed = app
        .open_repository(repo.path().to_str().unwrap(), Some(code()))
        .await
        .expect("one refresh should retry after the index changes during discovery");
    assert_ne!(refreshed.id, old.id);
    let added = refreshed
        .files
        .iter()
        .find(|f| f.path == "added.txt")
        .unwrap();
    let content = app
        .read_file(&refreshed.id, &added.id, false)
        .await
        .unwrap();
    assert_eq!(
        content.new_content.as_deref(),
        Some("arrived during refresh\n")
    );
}

#[cfg(unix)]
#[tokio::test]
async fn refresh_retries_when_a_reviewed_file_changes_during_reconciliation() {
    let repo = fixture();
    let store = tempfile::tempdir().unwrap();
    let app = Inspector::new(store.path()).unwrap();
    fs::write(repo.path().join("hello.ts"), "before refresh\n").unwrap();
    let old = app
        .open_repository(repo.path().to_str().unwrap(), Some(mode("all")))
        .await
        .unwrap();
    let file = old.files.iter().find(|f| f.path == "hello.ts").unwrap();
    let content = app.read_file(&old.id, &file.id, false).await.unwrap();
    app.add_comment(NewComment {
        snapshot_id: old.id.clone(),
        file_id: file.id.clone(),
        fingerprint: content.fingerprint.clone(),
        body: "Keep this feedback".into(),
        side: Some("new".into()),
        line: Some(1),
        end_line: None,
    })
    .await
    .unwrap();
    app.set_reviewed(&old.id, &file.id, &content.fingerprint, true)
        .await
        .unwrap();
    interrupt_next_snapshot(
        repo.path(),
        &app,
        "cat-file -s",
        "printf 'updated during refresh\\n' > hello.ts",
    );
    let refreshed = app
        .open_repository(repo.path().to_str().unwrap(), Some(mode("all")))
        .await
        .expect("one refresh should retry after a reviewed file changes while being read");
    let content = app.read_file(&refreshed.id, &file.id, false).await.unwrap();
    assert_eq!(
        content.new_content.as_deref(),
        Some("updated during refresh\n")
    );
    let queue = app.queue(&refreshed.id).await.unwrap();
    assert_eq!(queue.comments.len(), 1);
    assert!(queue.comments[0].outdated);
    assert!(queue.reviewed.is_empty());
    // Reading an old view still reports staleness; only an explicit reload retries.
    assert!(app.read_file(&old.id, &file.id, false).await.is_err());
}

#[cfg(unix)]
#[tokio::test]
async fn refresh_retries_are_bounded_without_discarding_feedback() {
    let repo = fixture();
    let store = tempfile::tempdir().unwrap();
    let app = Inspector::new(store.path()).unwrap();
    fs::write(repo.path().join("hello.ts"), "before refresh\n").unwrap();
    let old = app
        .open_repository(repo.path().to_str().unwrap(), Some(mode("all")))
        .await
        .unwrap();
    let file = old.files.iter().find(|f| f.path == "hello.ts").unwrap();
    let content = app.read_file(&old.id, &file.id, false).await.unwrap();
    app.set_reviewed(&old.id, &file.id, &content.fingerprint, true)
        .await
        .unwrap();
    interrupt_next_snapshot(
        repo.path(),
        &app,
        "cat-file -s",
        "printf 'still changing\\n' >> hello.ts\n    printf x >> .git/refresh-attempts\n    touch .git/refresh-pending",
    );
    assert_eq!(
        app.open_repository(repo.path().to_str().unwrap(), Some(mode("all")))
            .await
            .unwrap_err(),
        repository::STALE
    );
    assert_eq!(
        fs::read_to_string(repo.path().join(".git/refresh-attempts")).unwrap(),
        "xxx"
    );
    // A failed refresh leaves the previous snapshot and queue available.
    let queue = app.queue(&old.id).await.unwrap();
    assert_eq!(queue.reviewed.get("hello.ts"), Some(&content.fingerprint));
}

#[tokio::test]
async fn staged_unstaged_and_combined_are_distinct() {
    let repo = fixture();
    let store = tempfile::tempdir().unwrap();
    let app = Inspector::new(store.path()).unwrap();
    fs::write(repo.path().join("hello.ts"), "staged\n").unwrap();
    git(repo.path(), &["add", "hello.ts"]);
    fs::write(repo.path().join("hello.ts"), "working\n").unwrap();
    fs::write(repo.path().join("new.ts"), "new\n").unwrap();
    for (selection, old, new, untracked) in [
        ("all", "const oldValue", "working", true),
        ("staged", "const oldValue", "staged", false),
        ("unstaged", "staged", "working", true),
    ] {
        let s = app
            .open_repository(repo.path().to_str().unwrap(), Some(mode(selection)))
            .await
            .unwrap();
        assert_eq!(s.files.iter().any(|f| f.path == "new.ts"), untracked);
        let f = s.files.iter().find(|f| f.path == "hello.ts").unwrap();
        let content = app.read_file(&s.id, &f.id, false).await.unwrap();
        assert!(content.old_content.unwrap().starts_with(old));
        assert!(content.new_content.unwrap().starts_with(new));
    }
}

#[tokio::test]
async fn comments_are_anchored_isolated_persistent_and_outdated() {
    let repo = fixture();
    let store = tempfile::tempdir().unwrap();
    let app = Inspector::new(store.path()).unwrap();
    fs::write(repo.path().join("hello.ts"), "newValue\r\n\tkept\r\n").unwrap();
    let s = app
        .open_repository(repo.path().to_str().unwrap(), Some(mode("all")))
        .await
        .unwrap();
    let f = s.files.iter().find(|f| f.path == "hello.ts").unwrap();
    let content = app.read_file(&s.id, &f.id, false).await.unwrap();
    let comment = app
        .add_comment(NewComment {
            snapshot_id: s.id.clone(),
            file_id: f.id.clone(),
            fingerprint: content.fingerprint.clone(),
            body: "Why remove this?".into(),
            side: Some("old".into()),
            line: Some(1),
            end_line: None,
        })
        .await
        .unwrap();
    assert_eq!(
        comment.anchor.line_text.as_deref(),
        Some("const oldValue = 1;")
    );
    app.set_reviewed(&s.id, &f.id, &content.fingerprint, true)
        .await
        .unwrap();
    let cs = app
        .open_repository(repo.path().to_str().unwrap(), Some(code()))
        .await
        .unwrap();
    assert!(app.queue(&cs.id).await.unwrap().comments.is_empty());
    assert!(app
        .add_comment(NewComment {
            snapshot_id: s.id.clone(),
            file_id: f.id.clone(),
            fingerprint: content.fingerprint.clone(),
            body: "bad".into(),
            side: Some("new".into()),
            line: Some(0),
            end_line: None,
        })
        .await
        .is_err());
    fs::write(repo.path().join("hello.ts"), "changed again\n").unwrap();
    assert!(app.read_file(&s.id, &f.id, false).await.is_err());
    let s2 = app
        .open_repository(repo.path().to_str().unwrap(), Some(mode("all")))
        .await
        .unwrap();
    let queue = app.queue(&s2.id).await.unwrap();
    assert!(queue.comments[0].outdated);
    assert!(queue.reviewed.is_empty());
    let exported: serde_json::Value =
        serde_json::from_str(&app.export(&s2.id).await.unwrap()).unwrap();
    assert_eq!(
        exported,
        serde_json::json!([{
            "file": "hello.ts", "line": 1, "side": "old",
            "comment": "Why remove this?", "outdated": true
        }])
    );
    let fresh_app = Inspector::new(store.path()).unwrap();
    let restored = fresh_app
        .open_repository(repo.path().to_str().unwrap(), Some(mode("all")))
        .await
        .unwrap();
    assert_eq!(
        fresh_app.queue(&restored.id).await.unwrap().comments.len(),
        1
    );
    fresh_app.delete_comments(&restored.queue_id, None).unwrap();
    assert!(fresh_app
        .queue(&restored.id)
        .await
        .unwrap()
        .comments
        .is_empty());
}

#[tokio::test]
async fn concise_exports_keep_locations_and_queue_contents_without_internal_metadata() {
    let repo = fixture();
    let store = tempfile::tempdir().unwrap();
    let app = Inspector::new(store.path()).unwrap();
    git(repo.path(), &["mv", "hello.ts", "renamed.ts"]);
    let body = "Explain \"this\" value.\nCould it be a constant?";

    for comparison in [code(), mode("all")] {
        let changes = comparison.view == "changes";
        let snapshot = app
            .open_repository(repo.path().to_str().unwrap(), Some(comparison))
            .await
            .unwrap();
        assert_eq!(app.export(&snapshot.id).await.unwrap(), "[]");
        let file = snapshot
            .files
            .iter()
            .find(|file| file.path == "renamed.ts")
            .unwrap();
        let content = app.read_file(&snapshot.id, &file.id, false).await.unwrap();
        app.add_comment(NewComment {
            snapshot_id: snapshot.id.clone(),
            file_id: file.id.clone(),
            fingerprint: content.fingerprint.clone(),
            body: body.into(),
            line: Some(2),
            end_line: None,
            side: changes.then(|| "new".into()),
        })
        .await
        .unwrap();
        app.add_comment(NewComment {
            snapshot_id: snapshot.id.clone(),
            file_id: file.id.clone(),
            fingerprint: content.fingerprint.clone(),
            body: "Clarify this file's purpose.".into(),
            line: None,
            end_line: None,
            side: None,
        })
        .await
        .unwrap();
        let expected = serde_json::json!([
            {"file": "renamed.ts", "line": 2, "comment": body},
            {"file": "renamed.ts", "comment": "Clarify this file's purpose."}
        ]);
        let exported: serde_json::Value =
            serde_json::from_str(&app.export(&snapshot.id).await.unwrap()).unwrap();
        assert_eq!(exported, expected);
        if changes {
            app.add_comment(NewComment {
                snapshot_id: snapshot.id.clone(),
                file_id: file.id.clone(),
                fingerprint: content.fingerprint.clone(),
                body: "Explain the original line.".into(),
                line: Some(1),
                end_line: None,
                side: Some("old".into()),
            })
            .await
            .unwrap();
            let exported: serde_json::Value =
                serde_json::from_str(&app.export(&snapshot.id).await.unwrap()).unwrap();
            assert_eq!(
                exported[2],
                serde_json::json!({
                    "file": "renamed.ts", "line": 1, "side": "old", "comment": "Explain the original line."
                })
            );
        }
        // Exporting is a projection: persistence keeps the full original anchor.
        let retained = app.queue(&snapshot.id).await.unwrap();
        assert_eq!(retained.comments[0].anchor.line, Some(2));
        assert_eq!(retained.comments[0].anchor.fingerprint, content.fingerprint);
        assert!(retained.comments[0].anchor.line_text.is_some());
        assert!(!retained.comments[0].id.is_empty());
    }
}

#[tokio::test]
async fn range_comments_preserve_source_context_locations_and_legacy_comments_after_reload() {
    let old_text =
        "before\r\nold α\r\nold β\r\nold γ\r\nafter one\r\nafter two\r\nafter three\r\nlast\r\n";
    let new_text =
        "before\r\nnew α\r\nnew β\r\nnew γ\r\nafter one\r\nafter two\r\nafter three\r\nlast";
    for (comparison, side, selected) in [
        (mode("all"), Some("old"), "old α\r\nold β\r\nold γ\r"),
        (mode("all"), Some("new"), "new α\r\nnew β\r\nnew γ\r"),
        (code(), None, "new α\r\nnew β\r\nnew γ\r"),
    ] {
        let repo = fixture();
        let store = tempfile::tempdir().unwrap();
        fs::write(repo.path().join("hello.ts"), old_text).unwrap();
        git(repo.path(), &["add", "hello.ts"]);
        git(repo.path(), &["commit", "-m", "range source"]);
        fs::write(repo.path().join("hello.ts"), new_text).unwrap();
        let index_before = fs::read(repo.path().join(".git/index")).unwrap();
        let app = Inspector::new(store.path()).unwrap();
        let snapshot = app
            .open_repository(repo.path().to_str().unwrap(), Some(comparison.clone()))
            .await
            .unwrap();
        let file = snapshot
            .files
            .iter()
            .find(|f| f.path == "hello.ts")
            .unwrap();
        let content = app.read_file(&snapshot.id, &file.id, false).await.unwrap();
        let input = NewComment {
            snapshot_id: snapshot.id.clone(),
            file_id: file.id.clone(),
            fingerprint: content.fingerprint,
            body: "Review these lines".into(),
            side: side.map(str::to_owned),
            line: Some(2),
            end_line: Some(4),
        };
        let range = app.add_comment(input.clone()).await.unwrap();
        assert_eq!(range.scope, "line");
        assert_eq!(range.anchor.line_text.as_deref(), Some(selected));
        assert_eq!(range.anchor.context_before, ["before\r"]);
        assert_eq!(
            range.anchor.context_after,
            ["after one\r", "after two\r", "after three\r"]
        );
        let full = app
            .add_comment(NewComment {
                line: Some(1),
                end_line: Some(8),
                body: "Whole source".into(),
                ..input.clone()
            })
            .await
            .unwrap();
        assert!(full.anchor.context_before.is_empty());
        assert!(full.anchor.context_after.is_empty());
        assert_eq!(
            full.anchor.line_text.as_deref(),
            Some(if side == Some("old") {
                old_text.strip_suffix('\n').unwrap()
            } else {
                new_text
            })
        );
        let single = app
            .add_comment(NewComment {
                end_line: Some(2),
                body: "One line".into(),
                ..input
            })
            .await
            .unwrap();
        assert_eq!(single.anchor.end_line, None);
        assert_eq!(single.anchor.line, Some(2));
        let original_anchor = serde_json::to_value(&range.anchor).unwrap();
        assert_eq!(original_anchor["endLine"], 4);
        // This on-disk single-line anchor has the same shape as pre-range state.
        let stored: serde_json::Value =
            serde_json::from_slice(&fs::read(store.path().join("state.json")).unwrap()).unwrap();
        assert!(
            stored["queues"][&snapshot.queue_id]["comments"][2]["anchor"]
                .get("endLine")
                .is_none()
        );
        drop(app);

        let app = Inspector::new(store.path()).unwrap();
        let restored = app
            .open_repository(repo.path().to_str().unwrap(), Some(comparison.clone()))
            .await
            .unwrap();
        let queue = app.queue(&restored.id).await.unwrap();
        assert_eq!(
            serde_json::to_value(&queue.comments[0].anchor).unwrap(),
            original_anchor
        );
        assert!(!queue.comments[0].outdated);
        assert_eq!(queue.comments[2].anchor.end_line, None);
        let exported: serde_json::Value =
            serde_json::from_str(&app.export(&restored.id).await.unwrap()).unwrap();
        let mut expected = serde_json::json!({
            "file": "hello.ts", "line": 2, "endLine": 4, "comment": "Review these lines"
        });
        if side == Some("old") {
            expected["side"] = "old".into();
        }
        assert_eq!(exported[0], expected);
        assert!(exported[2].get("endLine").is_none());
        assert_eq!(
            fs::read(repo.path().join(".git/index")).unwrap(),
            index_before
        );
        assert_eq!(
            fs::read_to_string(repo.path().join("hello.ts")).unwrap(),
            new_text
        );

        fs::write(repo.path().join("hello.ts"), "changed after review\n").unwrap();
        let state_before = fs::read(store.path().join("state.json")).unwrap();
        let restored_file = restored
            .files
            .iter()
            .find(|f| f.path == "hello.ts")
            .unwrap();
        assert!(app
            .add_comment(NewComment {
                snapshot_id: restored.id.clone(),
                file_id: restored_file.id.clone(),
                fingerprint: range.anchor.fingerprint.clone(),
                body: "Do not attach this to changed source".into(),
                side: side.map(str::to_owned),
                line: Some(2),
                end_line: Some(4),
            })
            .await
            .is_err());
        assert_eq!(
            fs::read(store.path().join("state.json")).unwrap(),
            state_before
        );
        drop(app);
        let app = Inspector::new(store.path()).unwrap();
        let refreshed = app
            .open_repository(repo.path().to_str().unwrap(), Some(comparison))
            .await
            .unwrap();
        let queue = app.queue(&refreshed.id).await.unwrap();
        assert!(queue.comments[0].outdated);
        assert_eq!(
            serde_json::to_value(&queue.comments[0].anchor).unwrap(),
            original_anchor
        );
        expected["outdated"] = true.into();
        let exported: serde_json::Value =
            serde_json::from_str(&app.export(&refreshed.id).await.unwrap()).unwrap();
        assert_eq!(exported[0], expected);
    }
}

#[tokio::test]
async fn range_comments_reject_invalid_endpoints_sides_and_stale_sources_without_saving() {
    let repo = fixture();
    let store = tempfile::tempdir().unwrap();
    let app = Inspector::new(store.path()).unwrap();
    fs::write(repo.path().join("hello.ts"), "first\nsecond\nthird\n").unwrap();
    for comparison in [mode("all"), code()] {
        let changes = comparison.view == "changes";
        let snapshot = app
            .open_repository(repo.path().to_str().unwrap(), Some(comparison))
            .await
            .unwrap();
        let file = snapshot
            .files
            .iter()
            .find(|f| f.path == "hello.ts")
            .unwrap();
        let content = app.read_file(&snapshot.id, &file.id, false).await.unwrap();
        let input = NewComment {
            snapshot_id: snapshot.id.clone(),
            file_id: file.id.clone(),
            fingerprint: content.fingerprint,
            body: "Invalid range".into(),
            side: changes.then(|| "new".into()),
            line: Some(1),
            end_line: Some(2),
        };
        let state_before = fs::read(store.path().join("state.json")).unwrap();
        for (line, end_line) in [
            (None, Some(2)),
            (None, Some(0)),
            (Some(0), Some(2)),
            (Some(1), Some(0)),
            (Some(3), Some(2)),
            (Some(1), Some(4)),
            (Some(4), Some(4)),
            (Some(1), Some(u32::MAX)),
        ] {
            assert!(app
                .add_comment(NewComment {
                    line,
                    end_line,
                    ..input.clone()
                })
                .await
                .is_err());
        }
        assert!(app
            .add_comment(NewComment {
                side: if changes { None } else { Some("new".into()) },
                ..input.clone()
            })
            .await
            .is_err());
        if changes {
            // The new side has three lines, but the old side has only two.
            assert!(app
                .add_comment(NewComment {
                    side: Some("old".into()),
                    end_line: Some(3),
                    ..input.clone()
                })
                .await
                .is_err());
        }
        assert!(app
            .add_comment(NewComment {
                fingerprint: "stale fingerprint".into(),
                ..input
            })
            .await
            .is_err());
        assert!(app.queue(&snapshot.id).await.unwrap().comments.is_empty());
        assert_eq!(
            fs::read(store.path().join("state.json")).unwrap(),
            state_before
        );
    }
}

#[tokio::test]
async fn branch_comparison_uses_merge_base_and_local_edits() {
    let repo = fixture();
    let store = tempfile::tempdir().unwrap();
    let app = Inspector::new(store.path()).unwrap();
    git(repo.path(), &["checkout", "-b", "feature"]);
    fs::write(repo.path().join("feature.txt"), "committed\n").unwrap();
    git(repo.path(), &["add", "."]);
    git(repo.path(), &["commit", "-m", "feature"]);
    git(repo.path(), &["checkout", "main"]);
    fs::write(repo.path().join("main-only.txt"), "main\n").unwrap();
    git(repo.path(), &["add", "."]);
    git(repo.path(), &["commit", "-m", "main advances"]);
    git(repo.path(), &["checkout", "feature"]);
    fs::write(repo.path().join("feature.txt"), "local\n").unwrap();
    let s = app
        .open_repository(
            repo.path().to_str().unwrap(),
            Some(Comparison {
                base_ref: Some("main".into()),
                ..mode("branch")
            }),
        )
        .await
        .unwrap();
    assert_eq!(s.files.len(), 1);
    assert_eq!(s.files[0].path, "feature.txt");
    assert_eq!(
        app.read_file(&s.id, &s.files[0].id, false)
            .await
            .unwrap()
            .new_content
            .as_deref(),
        Some("local\n")
    );
}

#[tokio::test]
async fn code_inventory_renames_binary_and_unborn_repository() {
    let repo = fixture();
    let store = tempfile::tempdir().unwrap();
    let app = Inspector::new(store.path()).unwrap();
    fs::create_dir(repo.path().join("ignored")).unwrap();
    fs::write(repo.path().join("ignored/hidden"), "hidden").unwrap();
    git(repo.path(), &["mv", "hello.ts", "renamed 日本語.ts"]);
    fs::write(repo.path().join("binary.dat"), [0u8, 255, 1]).unwrap();
    let s = app
        .open_repository(repo.path().to_str().unwrap(), Some(mode("all")))
        .await
        .unwrap();
    let renamed = s.files.iter().find(|f| f.status == "renamed").unwrap();
    assert_eq!(renamed.old_path.as_deref(), Some("hello.ts"));
    let binary = s.files.iter().find(|f| f.path == "binary.dat").unwrap();
    assert_eq!(
        app.read_file(&s.id, &binary.id, false).await.unwrap().kind,
        "binary"
    );
    let cs = app
        .open_repository(repo.path().to_str().unwrap(), Some(code()))
        .await
        .unwrap();
    assert!(cs.files.iter().any(|f| f.path == "keep.txt"));
    assert!(!cs.files.iter().any(|f| f.path.starts_with("ignored/")));
    let unborn = tempfile::tempdir().unwrap();
    git(unborn.path(), &["init", "-b", "main"]);
    fs::write(unborn.path().join("first.txt"), "initial\n").unwrap();
    git(unborn.path(), &["add", "."]);
    fs::write(unborn.path().join("first.txt"), "edited\n").unwrap();
    let s = app
        .open_repository(unborn.path().to_str().unwrap(), Some(mode("all")))
        .await
        .unwrap();
    let content = app.read_file(&s.id, &s.files[0].id, false).await.unwrap();
    assert!(content.old_content.is_none());
    assert_eq!(content.new_content.as_deref(), Some("edited\n"));
}

#[test]
fn editorconfig_and_theme_normalization() {
    let repo = tempfile::tempdir().unwrap();
    fs::create_dir(repo.path().join("src")).unwrap();
    fs::write(
        repo.path().join(".editorconfig"),
        "root=true\n[*]\nindent_size=2\n[*.ts]\ntab_width=8\n",
    )
    .unwrap();
    fs::write(
        repo.path().join("src/.editorconfig"),
        "[*.ts]\ntab_width=3\n",
    )
    .unwrap();
    assert_eq!(repository::editor_tab_width(repo.path(), "src/a.ts", 4), 3);
    assert_eq!(repository::editor_tab_width(repo.path(), "a.ts", 4), 8);
    assert_eq!(repository::editor_tab_width(repo.path(), "a.txt", 4), 2);
    let json = "{ // theme\n \"name\": \"My theme\", \"type\": \"dark\", \"colors\": {\"editor.background\": \"#111111\",}, \"tokenColors\": [] }";
    let a = theme::import_theme(json, "fallback").unwrap();
    let b = theme::import_theme(&json.replace("#111111", "#222222"), "fallback").unwrap();
    assert_eq!(a.name, b.name);
    assert_ne!(a.id, b.id);
    assert_eq!(a.definition["name"], a.id);
    assert!(theme::import_theme("{\"include\":\"../theme.json\"}", "bad").is_err());
    assert!(theme::import_theme("{\"tokenColors\":\"other.tmTheme\"}", "bad").is_err());
    assert!(theme::import_theme(
        "{\"colors\": {\"editor.background\": \"url(evil)\"}}",
        "bad"
    )
    .is_err());
    assert!(theme::import_theme("[]", "bad").is_err());
}

#[cfg(unix)]
#[tokio::test]
async fn symlinks_and_unusual_names_remain_data() {
    let repo = fixture();
    let store = tempfile::tempdir().unwrap();
    let app = Inspector::new(store.path()).unwrap();
    std::os::unix::fs::symlink("/etc/passwd", repo.path().join("external")).unwrap();
    let weird = "spaces \"and\"\tnewline\n.txt";
    fs::write(
        repo.path().join(weird),
        "unchanged whitespace\t \nlast line",
    )
    .unwrap();
    git(repo.path(), &["add", "--", weird]);
    let s = app
        .open_repository(repo.path().to_str().unwrap(), Some(mode("all")))
        .await
        .unwrap();
    assert!(s.files.iter().any(|f| f.path == weird));
    let symlink = s.files.iter().find(|f| f.path == "external").unwrap();
    let data = app.read_file(&s.id, &symlink.id, false).await.unwrap();
    assert_eq!(data.kind, "symlink");
    assert_eq!(data.new_content.as_deref(), Some("/etc/passwd"));
    assert!(repository::safe_path(repo.path(), "../secret").is_err());
}

#[tokio::test]
async fn removed_file_comments_remain_exportable_without_line_coordinates() {
    let repo = fixture();
    let store = tempfile::tempdir().unwrap();
    let app = Inspector::new(store.path()).unwrap();
    let s = app
        .open_repository(repo.path().to_str().unwrap(), Some(code()))
        .await
        .unwrap();
    let file = s.files.iter().find(|f| f.path == "keep.txt").unwrap();
    let content = app.read_file(&s.id, &file.id, false).await.unwrap();
    app.add_comment(NewComment {
        snapshot_id: s.id,
        file_id: file.id.clone(),
        fingerprint: content.fingerprint,
        body: "Explain this file".into(),
        side: None,
        line: None,
        end_line: None,
    })
    .await
    .unwrap();
    fs::remove_file(repo.path().join("keep.txt")).unwrap();
    let s = app
        .open_repository(repo.path().to_str().unwrap(), Some(code()))
        .await
        .unwrap();
    let value: serde_json::Value = serde_json::from_str(&app.export(&s.id).await.unwrap()).unwrap();
    assert_eq!(
        value,
        serde_json::json!([{
            "file": "keep.txt", "comment": "Explain this file", "outdated": true
        }])
    );
}

#[tokio::test]
async fn conflicts_and_large_files_have_safe_summaries() {
    let repo = fixture();
    let store = tempfile::tempdir().unwrap();
    let app = Inspector::new(store.path()).unwrap();
    git(repo.path(), &["checkout", "-b", "other"]);
    fs::write(repo.path().join("hello.ts"), "other\n").unwrap();
    git(repo.path(), &["commit", "-am", "other"]);
    git(repo.path(), &["checkout", "main"]);
    fs::write(repo.path().join("hello.ts"), "main\n").unwrap();
    git(repo.path(), &["commit", "-am", "main"]);
    let merge = Command::new("git")
        .args(["merge", "other"])
        .current_dir(repo.path())
        .output()
        .unwrap();
    assert!(!merge.status.success());
    fs::write(repo.path().join("huge.txt"), "line\n".repeat(20_001)).unwrap();
    let s = app
        .open_repository(repo.path().to_str().unwrap(), Some(mode("all")))
        .await
        .unwrap();
    let file = s.files.iter().find(|f| f.path == "hello.ts").unwrap();
    let c = app.read_file(&s.id, &file.id, false).await.unwrap();
    assert_eq!(c.kind, "conflict");
    app.add_comment(NewComment {
        snapshot_id: s.id.clone(),
        file_id: file.id.clone(),
        fingerprint: c.fingerprint,
        body: "Resolve both implementations".into(),
        side: None,
        line: None,
        end_line: None,
    })
    .await
    .unwrap();
    let large = s.files.iter().find(|f| f.path == "huge.txt").unwrap();
    assert!(
        app.read_file(&s.id, &large.id, false)
            .await
            .unwrap()
            .deferred
    );
    assert!(
        !app.read_file(&s.id, &large.id, true)
            .await
            .unwrap()
            .deferred
    );
}

#[tokio::test]
async fn branch_and_worktree_queue_identity_isolated() {
    let repo = fixture();
    let store = tempfile::tempdir().unwrap();
    let app = Inspector::new(store.path()).unwrap();
    let main = app
        .open_repository(repo.path().to_str().unwrap(), Some(code()))
        .await
        .unwrap();
    git(repo.path(), &["checkout", "-b", "other"]);
    let other = app
        .open_repository(repo.path().to_str().unwrap(), Some(code()))
        .await
        .unwrap();
    assert_ne!(main.queue_id, other.queue_id);
    let worktree = tempfile::tempdir().unwrap();
    let path = worktree.path().join("checkout");
    git(
        repo.path(),
        &["worktree", "add", path.to_str().unwrap(), "main"],
    );
    let linked = app
        .open_repository(path.to_str().unwrap(), Some(code()))
        .await
        .unwrap();
    assert_ne!(main.queue_id, linked.queue_id);
    assert_eq!(main.repository.branch, linked.repository.branch);
}

#[test]
fn imported_themes_survive_removal_of_source_and_restart() {
    let store = tempfile::tempdir().unwrap();
    let source = tempfile::tempdir().unwrap();
    let path = source.path().join("theme.jsonc");
    fs::write(
        &path,
        "{\"name\":\"Local\",\"colors\":{\"editor.background\":\"#fff\"},\"tokenColors\":[]}",
    )
    .unwrap();
    let app = Inspector::new(store.path()).unwrap();
    let theme = app.import_theme(path.to_str().unwrap()).unwrap();
    let mut prefs = app.store.read().unwrap().preferences;
    prefs.appearance.light_theme = theme.id.clone();
    app.save_preferences(prefs).unwrap();
    fs::remove_file(path).unwrap();
    drop(app);
    let restored = Inspector::new(store.path()).unwrap();
    assert_eq!(restored.store.read().unwrap().themes[0].id, theme.id);
    restored.remove_theme(&theme.id).unwrap();
    assert_eq!(
        restored
            .store
            .read()
            .unwrap()
            .preferences
            .appearance
            .light_theme,
        "github-light"
    );
}

#[test]
fn sidebar_widths_default_for_existing_stores_and_persist() {
    let mut legacy: serde_json::Value =
        serde_json::from_str(include_str!("../../../tests/contracts/preferences.json")).unwrap();
    legacy.as_object_mut().unwrap().remove("sidebarWidths");
    let store = tempfile::tempdir().unwrap();
    fs::write(
        store.path().join("state.json"),
        serde_json::to_vec(&serde_json::json!({
            "schemaVersion": 1, "preferences": legacy, "queues": {}, "themes": []
        }))
        .unwrap(),
    )
    .unwrap();
    let app = Inspector::new(store.path()).unwrap();
    let mut prefs = app.store.read().unwrap().preferences;
    assert_eq!(prefs.sidebar_widths.files, 244);
    assert_eq!(prefs.sidebar_widths.feedback, 310);
    prefs.sidebar_widths.files = 380;
    prefs.sidebar_widths.feedback = 420;
    app.save_preferences(prefs.clone()).unwrap();
    for (files, feedback) in [(0, 420), (601, 420), (380, 259), (380, u32::MAX)] {
        let mut invalid = prefs.clone();
        invalid.sidebar_widths.files = files;
        invalid.sidebar_widths.feedback = feedback;
        assert!(app.save_preferences(invalid).is_err());
    }
    drop(app);
    let restored = Inspector::new(store.path()).unwrap();
    let widths = restored.store.read().unwrap().preferences.sidebar_widths;
    assert_eq!((widths.files, widths.feedback), (380, 420));
    let partial: peer_core::Preferences = serde_json::from_value(serde_json::json!({
        "sidebarWidths": { "files": 360 }
    }))
    .unwrap();
    assert_eq!(partial.sidebar_widths.feedback, 310);
}

#[test]
fn font_size_defaults_for_existing_stores_and_persists() {
    let mut legacy: serde_json::Value =
        serde_json::from_str(include_str!("../../../tests/contracts/preferences.json")).unwrap();
    legacy.as_object_mut().unwrap().remove("codeFontSize");
    let store = tempfile::tempdir().unwrap();
    fs::write(
        store.path().join("state.json"),
        serde_json::to_vec(&serde_json::json!({
            "schemaVersion": 1, "preferences": legacy, "queues": {}, "themes": []
        }))
        .unwrap(),
    )
    .unwrap();
    let app = Inspector::new(store.path()).unwrap();
    let mut prefs = app.store.read().unwrap().preferences;
    assert_eq!(prefs.code_font_size, 12);
    prefs.code_font_size = 18;
    app.save_preferences(prefs.clone()).unwrap();
    for invalid in [0, 9, 33, u32::MAX] {
        prefs.code_font_size = invalid;
        assert!(app.save_preferences(prefs.clone()).is_err());
    }
    drop(app);
    let restored = Inspector::new(store.path()).unwrap();
    assert_eq!(
        restored.store.read().unwrap().preferences.code_font_size,
        18
    );
}

#[tokio::test]
async fn code_feedback_does_not_expire_when_identical_content_is_staged() {
    let repo = fixture();
    let store = tempfile::tempdir().unwrap();
    let app = Inspector::new(store.path()).unwrap();
    fs::write(repo.path().join("new.ts"), "const value = 1;\n").unwrap();
    let s = app
        .open_repository(repo.path().to_str().unwrap(), Some(code()))
        .await
        .unwrap();
    let f = s.files.iter().find(|f| f.path == "new.ts").unwrap();
    let c = app.read_file(&s.id, &f.id, false).await.unwrap();
    app.add_comment(NewComment {
        snapshot_id: s.id.clone(),
        file_id: f.id.clone(),
        fingerprint: c.fingerprint,
        body: "Question".into(),
        side: None,
        line: Some(1),
        end_line: None,
    })
    .await
    .unwrap();
    git(repo.path(), &["add", "new.ts"]);
    git(repo.path(), &["commit", "-m", "add file"]);
    let next = app
        .open_repository(repo.path().to_str().unwrap(), Some(code()))
        .await
        .unwrap();
    assert!(!app.queue(&next.id).await.unwrap().comments[0].outdated);
}

#[tokio::test]
async fn submodule_updates_and_deletions_have_file_comment_summaries() {
    let repo = fixture();
    let child = fixture();
    let store = tempfile::tempdir().unwrap();
    let app = Inspector::new(store.path()).unwrap();
    git(
        repo.path(),
        &[
            "-c",
            "protocol.file.allow=always",
            "submodule",
            "add",
            child.path().to_str().unwrap(),
            "module",
        ],
    );
    git(repo.path(), &["commit", "-am", "add submodule"]);
    let module = repo.path().join("module");
    git(&module, &["config", "user.name", "Test"]);
    git(&module, &["config", "user.email", "test@example.invalid"]);
    fs::write(module.join("keep.txt"), "updated\n").unwrap();
    git(&module, &["commit", "-am", "update"]);
    git(repo.path(), &["add", "module"]);
    let s = app
        .open_repository(repo.path().to_str().unwrap(), Some(mode("staged")))
        .await
        .unwrap();
    let f = s.files.iter().find(|f| f.path == "module").unwrap();
    let c = app.read_file(&s.id, &f.id, false).await.unwrap();
    assert_eq!(c.kind, "submodule");
    assert!(c.metadata.contains("Subproject commit"));
    app.add_comment(NewComment {
        snapshot_id: s.id,
        file_id: f.id.clone(),
        fingerprint: c.fingerprint,
        body: "Why update the submodule?".into(),
        side: None,
        line: None,
        end_line: None,
    })
    .await
    .unwrap();
    git(repo.path(), &["rm", "-f", "module"]);
    let next = app
        .open_repository(repo.path().to_str().unwrap(), Some(mode("all")))
        .await
        .unwrap();
    let f = next.files.iter().find(|f| f.path == "module").unwrap();
    assert_eq!(
        app.read_file(&next.id, &f.id, false).await.unwrap().kind,
        "submodule"
    );
}
