use peer_core::{monitor::RepositoryBaseline, repository, Comparison, Inspector};
use std::{
    collections::BTreeMap,
    fs,
    path::Path,
    process::Command,
    sync::Arc,
    time::{Duration, SystemTime},
};

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
    String::from_utf8(output.stdout).unwrap().trim().to_owned()
}

fn fixture() -> tempfile::TempDir {
    let root = tempfile::tempdir().unwrap();
    git(root.path(), &["init", "-b", "main"]);
    git(root.path(), &["config", "user.name", "Monitor Test"]);
    git(
        root.path(),
        &["config", "user.email", "monitor@example.invalid"],
    );
    git(root.path(), &["config", "core.autocrlf", "false"]);
    fs::write(root.path().join("source.txt"), "original\n").unwrap();
    fs::write(root.path().join(".gitignore"), "output/\n*.generated\n").unwrap();
    fs::create_dir(root.path().join("output")).unwrap();
    fs::write(
        root.path().join("output/tracked.txt"),
        "tracked despite ignore\n",
    )
    .unwrap();
    git(root.path(), &["add", "."]);
    git(root.path(), &["add", "-f", "output/tracked.txt"]);
    git(root.path(), &["commit", "-m", "initial"]);
    root
}

async fn snapshot(root: &Path, comparison: Comparison) -> repository::RepositorySnapshot {
    repository::create_snapshot(root.to_str().unwrap(), comparison, None, &BTreeMap::new())
        .await
        .unwrap()
}

async fn baseline(root: &Path) -> Arc<RepositoryBaseline> {
    snapshot(root, Comparison::default())
        .await
        .repository_watch
        .unwrap()
        .unwrap()
}

fn add_submodule(root: &Path) {
    let source = fixture();
    git(
        root,
        &[
            "-c",
            "protocol.file.allow=always",
            "submodule",
            "add",
            source.path().to_str().unwrap(),
            "module",
        ],
    );
    git(root, &["commit", "-am", "add submodule"]);
    git(
        &root.join("module"),
        &["config", "user.name", "Monitor Test"],
    );
    git(
        &root.join("module"),
        &["config", "user.email", "monitor@example.invalid"],
    );
}

#[tokio::test]
async fn submodule_source_and_head_changes_refresh_comparison_without_probe_writes() {
    let root = fixture();
    add_submodule(root.path());
    let module = root.path().join("module");
    let data = tempfile::tempdir().unwrap();
    let inspector = Inspector::new(data.path()).unwrap();
    let initial = inspector
        .open_repository(root.path().to_str().unwrap(), Some(Comparison::default()))
        .await
        .unwrap();
    assert!(!initial.files.iter().any(|file| file.path == "module"));
    let clean = inspector
        .repository_watch_baseline(&initial.id)
        .await
        .unwrap()
        .unwrap();
    let stored = fs::read(data.path().join("state.json")).unwrap();
    let index = fs::read(root.path().join(".git/index")).unwrap();
    let module_index = fs::read(root.path().join(".git/modules/module/index")).unwrap();
    // Editing an existing file does not modify the gitlink directory metadata.
    let directory_modified = fs::metadata(&module).unwrap().modified().unwrap();
    fs::write(module.join("source.txt"), "modified inside submodule\n").unwrap();
    assert_eq!(
        directory_modified,
        fs::metadata(&module).unwrap().modified().unwrap()
    );
    assert!(clean.probe().await.unwrap());
    assert_eq!(stored, fs::read(data.path().join("state.json")).unwrap());
    assert_eq!(index, fs::read(root.path().join(".git/index")).unwrap());
    assert_eq!(
        module_index,
        fs::read(root.path().join(".git/modules/module/index")).unwrap()
    );
    let changed = snapshot(root.path(), Comparison::default()).await;
    let entry = changed
        .data
        .files
        .iter()
        .find(|file| file.path == "module")
        .unwrap();
    let content = repository::read_content(&changed, &entry.id, false, 4)
        .await
        .unwrap();
    assert!(content.metadata.contains("-dirty"));
    let dirty = changed.repository_watch.unwrap().unwrap();
    git(&module, &["restore", "source.txt"]);
    assert!(dirty.probe().await.unwrap());
    let restored = snapshot(root.path(), Comparison::default()).await;
    assert!(!restored.data.files.iter().any(|file| file.path == "module"));
    let restored_baseline = restored.repository_watch.unwrap().unwrap();
    let canonical = root.path().canonicalize().unwrap();
    for metadata in ["HEAD", "refs/heads/main", "index", "config"] {
        assert!(restored_baseline
            .relevant_event_path(&canonical.join(".git/modules/module").join(metadata)));
    }
    for noise in [
        "index.lock",
        "logs/HEAD",
        "objects/pack/noise",
        "FETCH_HEAD",
    ] {
        assert!(!restored_baseline
            .relevant_event_path(&canonical.join(".git/modules/module").join(noise)));
    }
    git(
        &module,
        &["commit", "--allow-empty", "-m", "new module HEAD"],
    );
    assert!(restored_baseline.probe().await.unwrap());
    let advanced = snapshot(root.path(), Comparison::default()).await;
    let entry = advanced
        .data
        .files
        .iter()
        .find(|file| file.path == "module")
        .unwrap();
    let content = repository::read_content(&advanced, &entry.id, false, 4)
        .await
        .unwrap();
    assert!(content
        .metadata
        .contains(&git(&module, &["rev-parse", "HEAD"])));
    let advanced_baseline = advanced.repository_watch.unwrap().unwrap();
    git(
        &module,
        &["commit", "--allow-empty", "-m", "another module HEAD"],
    );
    assert!(advanced_baseline.probe().await.unwrap());
}

#[cfg(unix)]
#[tokio::test]
async fn submodule_stat_refresh_does_not_rewrite_the_index() {
    let root = fixture();
    add_submodule(root.path());
    fs::File::open(root.path().join("module"))
        .unwrap()
        .set_times(fs::FileTimes::new().set_modified(SystemTime::now() + Duration::from_secs(2)))
        .unwrap();
    let index = fs::read(root.path().join(".git/index")).unwrap();
    let opened = snapshot(
        root.path(),
        Comparison {
            view: "code".into(),
            ..Comparison::default()
        },
    )
    .await;
    let baseline = opened.repository_watch.unwrap().unwrap();
    assert!(!baseline.probe().await.unwrap());
    assert_eq!(index, fs::read(root.path().join(".git/index")).unwrap());
}

#[tokio::test]
async fn submodule_ignored_output_and_housekeeping_remain_clean() {
    let root = fixture();
    add_submodule(root.path());
    let module = root.path().join("module");
    let clean = baseline(root.path()).await;
    fs::write(module.join("ignored.generated"), "ignored\n").unwrap();
    fs::create_dir(module.join("output/cache")).unwrap();
    fs::write(module.join("output/cache/artifact"), "ignored\n").unwrap();
    git(
        &module,
        &["config", "user.name", "Unrelated module identity"],
    );
    git(&module, &["pack-refs", "--all"]);
    fs::write(root.path().join(".git/modules/module/FETCH_HEAD"), "noise").unwrap();
    assert!(!clean.probe().await.unwrap());
    fs::write(module.join("untracked.txt"), "visible\n").unwrap();
    assert!(clean.probe().await.unwrap());
}

#[tokio::test]
async fn uninitialized_and_linked_worktree_submodules_remain_usable() {
    let root = fixture();
    add_submodule(root.path());
    let worktrees = tempfile::tempdir().unwrap();
    let linked = worktrees.path().join("linked");
    git(
        root.path(),
        &["worktree", "add", "-b", "linked", linked.to_str().unwrap()],
    );
    // A new worktree has the gitlink but no initialized submodule.
    let uninitialized = baseline(&linked).await;
    assert!(!uninitialized.probe().await.unwrap());
    // Reuse the original local clone as the URL; no network or surviving
    // temporary source fixture is required.
    git(
        &linked,
        &[
            "config",
            "submodule.module.url",
            root.path().join("module").to_str().unwrap(),
        ],
    );
    git(
        &linked,
        &[
            "-c",
            "protocol.file.allow=always",
            "submodule",
            "update",
            "--init",
        ],
    );
    assert!(uninitialized.probe().await.unwrap());
    let initialized = baseline(&linked).await;
    assert!(!initialized.probe().await.unwrap());
    let module_git = git(&linked.join("module"), &["rev-parse", "--absolute-git-dir"]);
    // Native events retain the canonical path supplied when installing a watch,
    // including the extended-length prefix on Windows.
    let module_git = fs::canonicalize(module_git).unwrap();
    assert!(initialized.relevant_event_path(&module_git.join("HEAD")));
    fs::write(linked.join("module/source.txt"), "linked module edit\n").unwrap();
    assert!(initialized.probe().await.unwrap());
    assert!(snapshot(&linked, Comparison::default())
        .await
        .data
        .files
        .iter()
        .any(|file| file.path == "module"));
    git(root.path(), &["submodule", "deinit", "-f", "module"]);
    let deinitialized = baseline(root.path()).await;
    assert!(!deinitialized.probe().await.unwrap());
}

#[cfg(unix)]
#[tokio::test]
async fn effective_filemode_config_alone_changes_refreshed_comparison() {
    use std::os::unix::fs::PermissionsExt;
    let root = fixture();
    let source = root.path().join("source.txt");
    git(root.path(), &["config", "core.filemode", "false"]);
    fs::set_permissions(&source, fs::Permissions::from_mode(0o755)).unwrap();
    // Complete fixture setup before capture: Git may otherwise refresh the
    // chmod's index stat cache during Changes discovery on fast filesystems.
    git(root.path(), &["update-index", "--refresh"]);
    let initial = snapshot(root.path(), Comparison::default()).await;
    assert!(!initial
        .data
        .files
        .iter()
        .any(|file| file.path == "source.txt"));
    let clean = initial.repository_watch.unwrap().unwrap();
    let index = fs::read(root.path().join(".git/index")).unwrap();
    let source_modified = fs::metadata(&source).unwrap().modified().unwrap();
    git(root.path(), &["config", "user.name", "Unrelated identity"]);
    git(
        root.path(),
        &["config", "remote.origin.url", "https://example.invalid/new"],
    );
    git(
        root.path(),
        &["config", "diff.external", "never-run-monitor-diff"],
    );
    git(
        root.path(),
        &["config", "diff.unused.textconv", "never-run-textconv"],
    );
    git(
        root.path(),
        &["config", "filter.unused.smudge", "never-run-smudge"],
    );
    assert!(!clean.probe().await.unwrap());
    git(root.path(), &["config", "core.filemode", "true"]);
    assert!(clean.probe().await.unwrap());
    assert_eq!(index, fs::read(root.path().join(".git/index")).unwrap());
    assert_eq!(
        source_modified,
        fs::metadata(&source).unwrap().modified().unwrap()
    );
    let refreshed = snapshot(root.path(), Comparison::default()).await;
    assert!(refreshed
        .data
        .files
        .iter()
        .any(|file| file.path == "source.txt"));
}

#[cfg(unix)]
#[tokio::test]
async fn included_and_worktree_configuration_respects_effective_precedence() {
    use std::os::unix::fs::PermissionsExt;
    let root = fixture();
    git(root.path(), &["config", "--unset", "core.filemode"]);
    let included = root.path().join(".git/comparison-config");
    fs::write(&included, "[core]\nfilemode = false\n").unwrap();
    git(
        root.path(),
        &["config", "include.path", included.to_str().unwrap()],
    );
    fs::set_permissions(
        root.path().join("source.txt"),
        fs::Permissions::from_mode(0o755),
    )
    .unwrap();
    git(root.path(), &["update-index", "--refresh"]);
    let inherited = baseline(root.path()).await;
    fs::write(&included, "[core]\nfilemode = true\n").unwrap();
    assert!(inherited.probe().await.unwrap());
    assert!(snapshot(root.path(), Comparison::default())
        .await
        .data
        .files
        .iter()
        .any(|file| file.path == "source.txt"));
    git(
        root.path(),
        &["config", "extensions.worktreeConfig", "true"],
    );
    git(
        root.path(),
        &["config", "--worktree", "core.filemode", "false"],
    );
    let overridden = baseline(root.path()).await;
    fs::write(
        &included,
        "[core]\nfilemode = false\n[user]\nname = Noise\n",
    )
    .unwrap();
    assert!(!overridden.probe().await.unwrap());
    git(
        root.path(),
        &["config", "--worktree", "core.filemode", "true"],
    );
    assert!(overridden.probe().await.unwrap());
    assert!(snapshot(root.path(), Comparison::default())
        .await
        .data
        .files
        .iter()
        .any(|file| file.path == "source.txt"));
}

#[tokio::test]
async fn submodule_ignore_configuration_changes_the_refreshed_file_list() {
    let root = fixture();
    add_submodule(root.path());
    fs::write(root.path().join("module/source.txt"), "dirty module\n").unwrap();
    git(root.path(), &["config", "submodule.module.ignore", "all"]);
    let initial = snapshot(root.path(), Comparison::default()).await;
    assert!(!initial.data.files.iter().any(|file| file.path == "module"));
    let ignored = initial.repository_watch.unwrap().unwrap();
    assert!(!ignored.probe().await.unwrap());
    git(root.path(), &["config", "submodule.module.ignore", "none"]);
    assert!(ignored.probe().await.unwrap());
    assert!(snapshot(root.path(), Comparison::default())
        .await
        .data
        .files
        .iter()
        .any(|file| file.path == "module"));
}

#[cfg(unix)]
#[tokio::test]
async fn clean_filter_configuration_changes_comparison_without_source_edits() {
    let root = fixture();
    git(root.path(), &["config", "diff.autoRefreshIndex", "false"]);
    fs::write(
        root.path().join(".gitattributes"),
        "source.txt filter=case\n",
    )
    .unwrap();
    git(root.path(), &["config", "filter.case.clean", "cat"]);
    git(root.path(), &["add", ".gitattributes"]);
    git(root.path(), &["commit", "-m", "add clean filter"]);
    // Keep Git's cached stat stale so each read-only comparison applies the
    // configured clean conversion, without editing source after the baseline.
    fs::File::options()
        .write(true)
        .open(root.path().join("source.txt"))
        .unwrap()
        .set_times(fs::FileTimes::new().set_modified(SystemTime::now() + Duration::from_secs(2)))
        .unwrap();
    let initial = snapshot(root.path(), Comparison::default()).await;
    let before = initial
        .data
        .files
        .iter()
        .find(|file| file.path == "source.txt")
        .unwrap();
    assert_eq!((before.additions, before.deletions), (0, 0));
    let clean = initial.repository_watch.unwrap().unwrap();
    let source = fs::read(root.path().join("source.txt")).unwrap();
    let index = fs::read(root.path().join(".git/index")).unwrap();
    git(root.path(), &["config", "filter.case.clean", "tr a-z A-Z"]);
    assert!(clean.probe().await.unwrap());
    assert_eq!(source, fs::read(root.path().join("source.txt")).unwrap());
    assert_eq!(index, fs::read(root.path().join(".git/index")).unwrap());
    let refreshed = snapshot(root.path(), Comparison::default()).await;
    let after = refreshed
        .data
        .files
        .iter()
        .find(|file| file.path == "source.txt")
        .unwrap();
    assert_eq!((after.additions, after.deletions), (1, 1));
}

#[cfg(unix)]
#[tokio::test]
async fn submodule_directory_symlinks_are_not_followed() {
    use std::os::unix::fs::symlink;
    let root = fixture();
    add_submodule(root.path());
    let clean = baseline(root.path()).await;
    let outside = fixture();
    let external_index = fs::read(outside.path().join(".git/index")).unwrap();
    fs::remove_dir_all(root.path().join("module")).unwrap();
    symlink(outside.path(), root.path().join("module")).unwrap();
    assert!(clean.probe().await.is_err());
    assert_eq!(
        external_index,
        fs::read(outside.path().join(".git/index")).unwrap()
    );
}

#[cfg(unix)]
#[tokio::test]
async fn initial_dirty_file_and_same_size_restored_mtime_edit_are_detected() {
    let root = fixture();
    let path = root.path().join("source.txt");
    fs::write(&path, "dirty one\n").unwrap();
    let modified = fs::metadata(&path).unwrap().modified().unwrap();
    let baseline = baseline(root.path()).await;
    assert!(!baseline.probe().await.unwrap());
    fs::write(&path, "dirty two\n").unwrap();
    fs::File::options()
        .write(true)
        .open(&path)
        .unwrap()
        .set_times(fs::FileTimes::new().set_modified(modified))
        .unwrap();
    assert!(baseline.probe().await.unwrap());
}

#[tokio::test]
async fn atomic_save_with_preserved_size_and_mtime_is_detected() {
    let root = fixture();
    let path = root.path().join("source.txt");
    let modified = fs::metadata(&path).unwrap().modified().unwrap();
    let baseline = baseline(root.path()).await;
    let replacement = root.path().join("save.tmp");
    fs::write(&replacement, "replaced\n").unwrap();
    fs::File::options()
        .write(true)
        .open(&replacement)
        .unwrap()
        .set_times(fs::FileTimes::new().set_modified(modified))
        .unwrap();
    fs::rename(replacement, path).unwrap();
    assert!(baseline.probe().await.unwrap());
}

#[tokio::test]
async fn additions_deletions_and_renames_include_files_absent_from_diff() {
    let root = fixture();
    let original = baseline(root.path()).await;
    fs::write(root.path().join("new.txt"), "new\n").unwrap();
    assert!(original.probe().await.unwrap());
    let added = baseline(root.path()).await;
    fs::rename(root.path().join("new.txt"), root.path().join("renamed.txt")).unwrap();
    assert!(added.probe().await.unwrap());
    let renamed = baseline(root.path()).await;
    fs::remove_file(root.path().join("source.txt")).unwrap();
    assert!(renamed.probe().await.unwrap());
    let deleted = baseline(root.path()).await;
    assert!(!deleted.probe().await.unwrap());
    fs::write(root.path().join("source.txt"), "original\n").unwrap();
    assert!(deleted.probe().await.unwrap());
}

#[tokio::test]
async fn ignored_output_is_clean_but_tracked_ignored_paths_are_not() {
    let root = fixture();
    let baseline = baseline(root.path()).await;
    fs::write(root.path().join("output/cache.bin"), "cache\n").unwrap();
    fs::write(root.path().join("ignored.generated"), "generated\n").unwrap();
    fs::create_dir(root.path().join("output/deep")).unwrap();
    fs::write(root.path().join("output/deep/cache"), "cache\n").unwrap();
    assert!(!baseline.probe().await.unwrap());
    fs::write(root.path().join("output/tracked.txt"), "changed\n").unwrap();
    assert!(baseline.probe().await.unwrap());
}

#[tokio::test]
async fn git_exclude_changes_expose_previously_ignored_files() {
    let root = fixture();
    fs::write(root.path().join(".git/info/exclude"), "local-only\n").unwrap();
    fs::write(root.path().join("local-only"), "hidden\n").unwrap();
    let baseline = baseline(root.path()).await;
    assert!(!baseline.probe().await.unwrap());
    fs::write(root.path().join(".git/info/exclude"), "").unwrap();
    assert!(baseline.probe().await.unwrap());
}

#[tokio::test]
async fn staging_and_branch_target_changes_are_semantic_changes() {
    let root = fixture();
    fs::write(root.path().join("source.txt"), "working change\n").unwrap();
    let dirty = baseline(root.path()).await;
    git(root.path(), &["add", "source.txt"]);
    assert!(dirty.probe().await.unwrap());
    git(root.path(), &["commit", "-m", "second"]);
    git(root.path(), &["branch", "target", "HEAD~1"]);
    let compared = snapshot(
        root.path(),
        Comparison {
            mode: "branch".into(),
            base_ref: Some("target".into()),
            ..Comparison::default()
        },
    )
    .await
    .repository_watch
    .unwrap()
    .unwrap();
    git(root.path(), &["branch", "unrelated"]);
    git(root.path(), &["tag", "unrelated-tag"]);
    git(
        root.path(),
        &["config", "user.name", "Unrelated identity change"],
    );
    assert!(!compared.probe().await.unwrap());
    let head = git(root.path(), &["rev-parse", "HEAD"]);
    git(root.path(), &["update-ref", "refs/heads/target", &head]);
    assert!(compared.probe().await.unwrap());
    let before_deletion = snapshot(
        root.path(),
        Comparison {
            mode: "branch".into(),
            base_ref: Some("target".into()),
            ..Comparison::default()
        },
    )
    .await
    .repository_watch
    .unwrap()
    .unwrap();
    git(root.path(), &["branch", "-D", "target"]);
    assert!(before_deletion.probe().await.unwrap());
}

#[tokio::test]
async fn index_stat_refresh_and_git_housekeeping_do_not_mark_changed() {
    let root = fixture();
    fs::File::options()
        .write(true)
        .open(root.path().join("source.txt"))
        .unwrap()
        .set_times(fs::FileTimes::new().set_modified(SystemTime::now() + Duration::from_secs(2)))
        .unwrap();
    // Keep the intentionally stale index stat cache until the explicit refresh
    // below; Changes discovery itself runs git diff, which may refresh it.
    let baseline = snapshot(
        root.path(),
        Comparison {
            view: "code".into(),
            ..Comparison::default()
        },
    )
    .await
    .repository_watch
    .unwrap()
    .unwrap();
    let index = fs::read(root.path().join(".git/index")).unwrap();
    git(root.path(), &["update-index", "--refresh"]);
    assert_ne!(index, fs::read(root.path().join(".git/index")).unwrap());
    git(root.path(), &["pack-refs", "--all"]);
    fs::write(root.path().join(".git/index.lock"), "lock noise").unwrap();
    fs::write(root.path().join(".git/FETCH_HEAD"), "fetch bookkeeping").unwrap();
    assert!(!baseline.probe().await.unwrap());
    assert!(
        !baseline.relevant_event_path(&root.path().canonicalize().unwrap().join(".git/index.lock"))
    );
    assert!(!baseline.relevant_event_path(
        &root
            .path()
            .canonicalize()
            .unwrap()
            .join(".git/objects/pack/noise")
    ));
}

#[tokio::test]
async fn detached_and_unborn_head_identity_changes_are_detected() {
    let root = fixture();
    let original = git(root.path(), &["rev-parse", "HEAD"]);
    git(root.path(), &["commit", "--allow-empty", "-m", "second"]);
    let tip = git(root.path(), &["rev-parse", "HEAD"]);
    git(root.path(), &["checkout", "--detach", &original]);
    let detached = baseline(root.path()).await;
    git(root.path(), &["checkout", "--detach", &tip]);
    assert!(detached.probe().await.unwrap());
    let unborn = tempfile::tempdir().unwrap();
    git(unborn.path(), &["init", "-b", "before"]);
    let initial = baseline(unborn.path()).await;
    git(unborn.path(), &["symbolic-ref", "HEAD", "refs/heads/after"]);
    assert!(initial.probe().await.unwrap());
}

#[tokio::test]
async fn linked_worktree_uses_its_own_index_and_shared_refs() {
    let root = fixture();
    let worktrees = tempfile::tempdir().unwrap();
    let linked = worktrees.path().join("linked");
    git(
        root.path(),
        &["worktree", "add", "-b", "linked", linked.to_str().unwrap()],
    );
    let linked_root = linked.canonicalize().unwrap();
    let common = root.path().canonicalize().unwrap().join(".git");
    let baseline = baseline(&linked).await;
    assert!(baseline.watch_paths().contains(&linked_root));
    assert!(baseline.watch_paths().contains(&common));
    fs::write(root.path().join("source.txt"), "other worktree\n").unwrap();
    git(root.path(), &["add", "source.txt"]);
    assert!(!baseline.probe().await.unwrap());
    git(root.path(), &["commit", "-m", "unrelated worktree commit"]);
    assert!(!baseline.probe().await.unwrap());
    fs::write(linked.join("source.txt"), "linked change\n").unwrap();
    git(&linked, &["add", "source.txt"]);
    assert!(baseline.probe().await.unwrap());
}

#[tokio::test]
async fn baseline_survives_activation_delay_without_mutating_store_or_replacing_snapshot() {
    let root = fixture();
    let data = tempfile::tempdir().unwrap();
    let inspector = Inspector::new(data.path()).unwrap();
    let snapshot = inspector
        .open_repository(root.path().to_str().unwrap(), Some(Comparison::default()))
        .await
        .unwrap();
    let stored = fs::read(data.path().join("state.json")).unwrap();
    let index = fs::read(root.path().join(".git/index")).unwrap();
    fs::write(root.path().join("arrived-before-activation.txt"), "new\n").unwrap();
    let baseline = inspector
        .repository_watch_baseline(&snapshot.id)
        .await
        .unwrap()
        .unwrap();
    assert!(baseline.probe().await.unwrap());
    assert_eq!(stored, fs::read(data.path().join("state.json")).unwrap());
    assert_eq!(index, fs::read(root.path().join(".git/index")).unwrap());
    assert!(inspector
        .repository_watch_baseline(&snapshot.id)
        .await
        .unwrap()
        .is_some());
    let refreshed = inspector
        .open_repository(root.path().to_str().unwrap(), Some(Comparison::default()))
        .await
        .unwrap();
    assert_ne!(snapshot.id, refreshed.id);
    assert!(inspector
        .repository_watch_baseline(&snapshot.id)
        .await
        .is_err());
    assert!(baseline.probe().await.unwrap());
}

#[tokio::test]
async fn immutable_commit_comparisons_have_no_monitor_baseline() {
    let root = fixture();
    let snapshot = snapshot(
        root.path(),
        Comparison {
            mode: "commit".into(),
            base_ref: Some("HEAD".into()),
            ..Comparison::default()
        },
    )
    .await;
    assert!(snapshot.repository_watch.unwrap().is_none());
}

#[tokio::test]
async fn missing_git_directory_is_an_error_not_a_clean_probe() {
    let root = fixture();
    let baseline = baseline(root.path()).await;
    fs::rename(root.path().join(".git"), root.path().join("git-away")).unwrap();
    assert!(baseline.probe().await.is_err());
}

#[cfg(unix)]
#[tokio::test]
async fn executable_modes_and_symlink_replacements_are_detected_without_following_directories() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    let root = fixture();
    let before_mode = baseline(root.path()).await;
    fs::set_permissions(
        root.path().join("source.txt"),
        fs::Permissions::from_mode(0o755),
    )
    .unwrap();
    assert!(before_mode.probe().await.unwrap());
    symlink("source.txt", root.path().join("link.txt")).unwrap();
    let before_target = baseline(root.path()).await;
    fs::remove_file(root.path().join("link.txt")).unwrap();
    symlink(".gitignore", root.path().join("link.txt")).unwrap();
    assert!(before_target.probe().await.unwrap());
    let external = tempfile::tempdir().unwrap();
    fs::create_dir(root.path().join("nested")).unwrap();
    fs::write(root.path().join("nested/source.txt"), "inside\n").unwrap();
    git(root.path(), &["add", "nested/source.txt"]);
    fs::write(root.path().join(".git/info/exclude"), "nested\n").unwrap();
    let contained = baseline(root.path()).await;
    fs::remove_dir_all(root.path().join("nested")).unwrap();
    fs::write(external.path().join("source.txt"), "outside\n").unwrap();
    symlink(external.path(), root.path().join("nested")).unwrap();
    assert!(contained.probe().await.is_err());
    assert_eq!(
        fs::read_to_string(external.path().join("source.txt")).unwrap(),
        "outside\n"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn snapshot_rejects_source_and_inventory_changes_during_initial_capture() {
    use std::os::unix::fs::PermissionsExt;
    let root = fixture();
    let wrapper = root.path().join(".git/monitor-git");
    let real_git = repository::discover_git(None);
    let quoted_git = format!("'{}'", real_git.replace('\'', "'\\''"));
    fs::write(&wrapper, format!(
        "#!/bin/sh\ncase \" $* \" in\n*' ls-files --stage -z '*)\n  if [ -f .git/monitor-pending ]; then\n    rm .git/monitor-pending\n    printf 'changed during opening\\n' > source.txt\n    printf 'new during opening\\n' > new.txt\n  fi\n  ;;\nesac\nexec {quoted_git} \"$@\"\n"
    )).unwrap();
    fs::set_permissions(&wrapper, fs::Permissions::from_mode(0o755)).unwrap();
    fs::write(root.path().join(".git/monitor-pending"), "").unwrap();
    let result = repository::create_snapshot(
        root.path().to_str().unwrap(),
        Comparison::default(),
        wrapper.to_str(),
        &BTreeMap::new(),
    )
    .await;
    assert_eq!(result.unwrap_err(), repository::STALE);
    let retried = snapshot(root.path(), Comparison::default()).await;
    assert!(retried.data.files.iter().any(|file| file.path == "new.txt"));
    assert!(!retried
        .repository_watch
        .unwrap()
        .unwrap()
        .probe()
        .await
        .unwrap());
}
