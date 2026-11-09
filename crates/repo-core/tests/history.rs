use peer_core::{repository, Comparison, Inspector, NewComment};
use std::{fs, path::Path, process::Command};

fn git(root: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .args(args)
        .current_dir(root)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim().into()
}
fn fixture() -> tempfile::TempDir {
    let repo = tempfile::tempdir().unwrap();
    git(repo.path(), &["init", "-b", "main"]);
    git(repo.path(), &["config", "user.name", "History Test"]);
    git(
        repo.path(),
        &["config", "user.email", "history@example.invalid"],
    );
    repo
}
fn commit(root: &Path, subject: &str) -> String {
    git(root, &["add", "."]);
    git(root, &["commit", "--allow-empty", "-m", subject]);
    git(root, &["rev-parse", "HEAD"])
}
fn comparison(id: &str) -> Comparison {
    Comparison {
        mode: "commit".into(),
        base_ref: Some(id.into()),
        ..Comparison::default()
    }
}

#[tokio::test]
async fn history_pages_are_pinned_to_the_branch_head_and_handle_unborn_and_detached_repos() {
    let repo = fixture();
    let data = tempfile::tempdir().unwrap();
    let app = Inspector::new(data.path()).unwrap();
    let unborn = app
        .open_repository(repo.path().to_str().unwrap(), None)
        .await
        .unwrap();
    assert!(app
        .commits(&unborn.id, 0, 50)
        .await
        .unwrap()
        .commits
        .is_empty());
    let root = commit(repo.path(), "Initial 日本語");
    let middle = commit(repo.path(), "Second");
    let tip = commit(repo.path(), "Third");
    let snapshot = app
        .open_repository(repo.path().to_str().unwrap(), None)
        .await
        .unwrap();
    let page = app.commits(&snapshot.id, 0, 2).await.unwrap();
    assert!(page.has_more);
    assert_eq!(
        page.commits.iter().map(|c| &c.id).collect::<Vec<_>>(),
        vec![&tip, &middle]
    );
    assert_eq!(page.commits[0].author, "History Test");
    assert_eq!(page.commits[0].parents, vec![middle]);
    commit(repo.path(), "New tip after the list opened");
    let older = app.commits(&snapshot.id, 2, 2).await.unwrap();
    assert!(!older.has_more);
    assert_eq!(older.commits[0].id, root);
    assert_eq!(older.commits[0].subject, "Initial 日本語");
    assert!(older.commits[0].parents.is_empty());
    git(repo.path(), &["checkout", "--detach", &tip]);
    let detached = app
        .open_repository(repo.path().to_str().unwrap(), None)
        .await
        .unwrap();
    assert!(detached.repository.branch.starts_with("detached:"));
    assert_eq!(
        app.commits(&detached.id, 0, 1).await.unwrap().commits[0].id,
        tip
    );
}

#[tokio::test]
async fn commit_diff_and_feedback_use_frozen_parent_and_commit_contents() {
    let repo = fixture();
    let data = tempfile::tempdir().unwrap();
    let app = Inspector::new(data.path()).unwrap();
    fs::write(repo.path().join("value.ts"), "export const value = 1;\n").unwrap();
    let initial = commit(repo.path(), "Initial");
    fs::write(repo.path().join("value.ts"), "export const value = 2;\n").unwrap();
    let selected = commit(repo.path(), "Change value");
    fs::write(repo.path().join("value.ts"), "export const value = 3;\n").unwrap();
    let head = commit(repo.path(), "Later value");
    fs::write(repo.path().join("untracked.txt"), "local only\n").unwrap();
    let snapshot = app
        .open_repository(repo.path().to_str().unwrap(), Some(comparison(&selected)))
        .await
        .unwrap();
    assert_eq!(snapshot.repository.head.as_deref(), Some(head.as_str()));
    assert_eq!(snapshot.base_commit.as_deref(), Some(initial.as_str()));
    assert_eq!(snapshot.commit.as_ref().unwrap().id, selected);
    assert!(!snapshot.comparison.include_untracked);
    assert_eq!(snapshot.files.len(), 1);
    fs::write(repo.path().join("value.ts"), "local edit after opening\n").unwrap();
    git(repo.path(), &["add", "."]);
    let content = app
        .read_file(&snapshot.id, &snapshot.files[0].id, false)
        .await
        .unwrap();
    assert_eq!(
        content.old_content.as_deref(),
        Some("export const value = 1;\n")
    );
    assert_eq!(
        content.new_content.as_deref(),
        Some("export const value = 2;\n")
    );
    let comment = app
        .add_comment(NewComment {
            snapshot_id: snapshot.id.clone(),
            file_id: snapshot.files[0].id.clone(),
            fingerprint: content.fingerprint,
            body: "Review the historical value".into(),
            side: Some("new".into()),
            line: Some(1),
            end_line: None,
        })
        .await
        .unwrap();
    assert_eq!(
        comment.anchor.head_commit.as_deref(),
        Some(selected.as_str())
    );
    assert_eq!(
        comment.anchor.base_commit.as_deref(),
        Some(initial.as_str())
    );
    let initial_snapshot = app
        .open_repository(repo.path().to_str().unwrap(), Some(comparison(&initial)))
        .await
        .unwrap();
    assert_ne!(initial_snapshot.queue_id, snapshot.queue_id);
    assert!(initial_snapshot.base_commit.is_none());
    let added = app
        .read_file(&initial_snapshot.id, &initial_snapshot.files[0].id, false)
        .await
        .unwrap();
    assert!(added.old_content.is_none());
    assert_eq!(
        added.new_content.as_deref(),
        Some("export const value = 1;\n")
    );
    let restored = app
        .open_repository(repo.path().to_str().unwrap(), Some(comparison(&selected)))
        .await
        .unwrap();
    assert!(!app.queue(&restored.id).await.unwrap().comments[0].outdated);
    let inventory = repository::create_snapshot(
        repo.path().to_str().unwrap(),
        comparison(&selected),
        None,
        &Default::default(),
    )
    .await
    .unwrap();
    for side in ["old", "new"] {
        let file = &inventory.navigation[side]["value.ts"];
        assert!(file.blob.is_some());
        assert!(file.stamp.is_none());
    }
    assert_ne!(
        inventory.navigation["old"]["value.ts"].blob,
        inventory.navigation["new"]["value.ts"].blob
    );
    let local = app
        .open_repository(repo.path().to_str().unwrap(), Some(Comparison::default()))
        .await
        .unwrap();
    assert_ne!(local.queue_id, restored.queue_id);
    assert!(local.files.iter().any(|file| file.path == "untracked.txt"));
}

#[tokio::test]
async fn merges_compare_to_first_parent_and_empty_commits_stay_empty() {
    let repo = fixture();
    let data = tempfile::tempdir().unwrap();
    let app = Inspector::new(data.path()).unwrap();
    commit(repo.path(), "Initial");
    git(repo.path(), &["checkout", "-b", "feature"]);
    fs::write(repo.path().join("feature.txt"), "feature\n").unwrap();
    let feature = commit(repo.path(), "Feature");
    git(repo.path(), &["checkout", "main"]);
    fs::write(repo.path().join("main.txt"), "main\n").unwrap();
    let parent = commit(repo.path(), "Main advances");
    git(
        repo.path(),
        &["merge", "--no-ff", "feature", "-m", "Merge feature"],
    );
    let merged = git(repo.path(), &["rev-parse", "HEAD"]);
    let snapshot = app
        .open_repository(repo.path().to_str().unwrap(), Some(comparison(&merged)))
        .await
        .unwrap();
    assert_eq!(
        snapshot.commit.as_ref().unwrap().parents,
        vec![parent.clone(), feature.clone()]
    );
    assert_eq!(snapshot.base_commit, Some(parent));
    assert_eq!(snapshot.files.len(), 1);
    assert_eq!(snapshot.files[0].path, "feature.txt");
    assert!(app
        .commits(&snapshot.id, 0, 50)
        .await
        .unwrap()
        .commits
        .iter()
        .any(|c| c.id == feature));
    let empty = commit(repo.path(), "No content changes");
    let snapshot = app
        .open_repository(repo.path().to_str().unwrap(), Some(comparison(&empty)))
        .await
        .unwrap();
    assert!(snapshot.files.is_empty());
    assert_eq!(snapshot.comparison.mode, "commit");
    assert!(app
        .open_repository(repo.path().to_str().unwrap(), Some(comparison("--all")))
        .await
        .is_err());
}

#[tokio::test]
async fn historical_renames_deletions_and_binary_files_ignore_the_working_tree() {
    let repo = fixture();
    let data = tempfile::tempdir().unwrap();
    let app = Inspector::new(data.path()).unwrap();
    fs::write(repo.path().join("old name.txt"), "one\ntwo\nthree\nfour\n").unwrap();
    fs::write(repo.path().join("removed.txt"), "removed\n").unwrap();
    commit(repo.path(), "Initial files");
    let renamed = "new 日本語 name.txt";
    git(repo.path(), &["mv", "old name.txt", renamed]);
    git(repo.path(), &["rm", "removed.txt"]);
    fs::write(repo.path().join("binary.dat"), [0, 255, 1]).unwrap();
    let id = commit(repo.path(), "Rename and delete");
    fs::remove_file(repo.path().join(renamed)).unwrap();
    fs::create_dir(repo.path().join(renamed)).unwrap();
    let snapshot = app
        .open_repository(repo.path().to_str().unwrap(), Some(comparison(&id)))
        .await
        .unwrap();
    let file = snapshot.files.iter().find(|f| f.path == renamed).unwrap();
    assert_eq!(file.old_path.as_deref(), Some("old name.txt"));
    assert_eq!(file.kind, "text");
    let content = app.read_file(&snapshot.id, &file.id, false).await.unwrap();
    assert_eq!(content.old_content, content.new_content);
    let deleted = snapshot
        .files
        .iter()
        .find(|f| f.path == "removed.txt")
        .unwrap();
    let content = app
        .read_file(&snapshot.id, &deleted.id, false)
        .await
        .unwrap();
    assert_eq!(content.old_content.as_deref(), Some("removed\n"));
    assert!(content.new_content.is_none());
    let binary = snapshot
        .files
        .iter()
        .find(|f| f.path == "binary.dat")
        .unwrap();
    assert_eq!(
        app.read_file(&snapshot.id, &binary.id, false)
            .await
            .unwrap()
            .kind,
        "binary"
    );
}

#[tokio::test]
async fn shallow_history_does_not_turn_a_normal_commit_into_an_initial_commit() {
    let repo = fixture();
    fs::write(repo.path().join("value.txt"), "before\n").unwrap();
    commit(repo.path(), "Initial");
    fs::write(repo.path().join("value.txt"), "after\n").unwrap();
    let tip = commit(repo.path(), "Change");
    let destination = tempfile::tempdir().unwrap();
    let clone = destination.path().join("shallow");
    let url = url::Url::from_directory_path(repo.path()).unwrap();
    git(
        destination.path(),
        &[
            "clone",
            "--depth",
            "1",
            url.as_str(),
            clone.to_str().unwrap(),
        ],
    );
    let data = tempfile::tempdir().unwrap();
    let app = Inspector::new(data.path()).unwrap();
    let snapshot = app
        .open_repository(clone.to_str().unwrap(), None)
        .await
        .unwrap();
    assert_eq!(
        app.commits(&snapshot.id, 0, 50)
            .await
            .unwrap()
            .commits
            .len(),
        1
    );
    let error = app
        .open_repository(clone.to_str().unwrap(), Some(comparison(&tip)))
        .await
        .unwrap_err();
    assert!(error.contains("history may be missing locally"), "{error}");
}
