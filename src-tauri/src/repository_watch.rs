use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use parking_lot::Mutex;
use peer_core::{monitor::RepositoryBaseline, RepositoryWatchStatus};
use std::{
    future::Future,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tauri::Emitter;
use tokio::{
    sync::{mpsc, oneshot, Mutex as AsyncMutex},
    task::JoinHandle,
    time::{sleep_until, Instant},
};

const DEBOUNCE: Duration = Duration::from_millis(300);
const MAX_DELAY: Duration = Duration::from_secs(1);
const PROBE_TIMEOUT: Duration = Duration::from_secs(30);
const PROBE_TIMEOUT_ERROR: &str = "Repository change detection timed out; refresh manually";

#[derive(Default)]
pub struct RepositoryWatch {
    active: Mutex<Option<ActiveWatch>>,
    probes: Arc<ProbeCoordinator>,
}

struct ActiveWatch {
    id: String,
    signals: Arc<Signals>,
    worker: JoinHandle<()>,
}

impl Drop for ActiveWatch {
    fn drop(&mut self) {
        self.signals.stopped.store(true, Ordering::Release);
        self.worker.abort();
    }
}

#[derive(Default)]
struct ProbeCoordinator {
    // The monitor, not its replaceable watch worker, owns this task. Dropping
    // an awaiting worker must not detach a still-running blocking filesystem scan.
    in_flight: AsyncMutex<Option<InFlightProbe>>,
}

struct InFlightProbe {
    owner: Arc<Signals>,
    worker: JoinHandle<Result<bool, String>>,
}

impl ProbeCoordinator {
    async fn run<F>(
        &self,
        owner: &Arc<Signals>,
        start: impl FnOnce() -> F,
    ) -> Option<Result<bool, String>>
    where
        F: Future<Output = Result<bool, String>> + Send + 'static,
    {
        let mut slot = self.in_flight.lock().await;
        if owner.stopped.load(Ordering::Acquire) {
            return None;
        }
        if let Some(previous) = slot.as_mut() {
            if !Arc::ptr_eq(&previous.owner, owner) {
                // A replaced watch's result belongs only to its old snapshot.
                // Drain its actual work before allowing the new baseline to run.
                let _ = (&mut previous.worker).await;
                *slot = None;
            }
        }
        if owner.stopped.load(Ordering::Acquire) {
            return None;
        }
        let pending = slot.get_or_insert_with(|| InFlightProbe {
            owner: Arc::clone(owner),
            worker: tokio::spawn(start()),
        });
        let result = (&mut pending.worker)
            .await
            .map_err(|error| format!("Cannot check repository changes: {error}"))
            .and_then(|result| result);
        *slot = None;
        if owner.stopped.load(Ordering::Acquire) {
            None
        } else {
            Some(result)
        }
    }
}

struct Signals {
    // A single pending full rescan subsumes every event, including overflow.
    // Never queue notify Events, path lists, or one task per filesystem event.
    sender: mpsc::Sender<()>,
    force: AtomicBool,
    stopped: AtomicBool,
    error: Mutex<Option<String>>,
}

impl Signals {
    fn wake(&self) {
        if !self.stopped.load(Ordering::Acquire) {
            let _ = self.sender.try_send(());
        }
    }

    fn event(&self, baseline: &RepositoryBaseline, event: notify::Result<Event>) {
        if self.stopped.load(Ordering::Acquire) {
            return;
        }
        match event {
            Ok(event) => {
                if !event.need_rescan()
                    && (matches!(event.kind, EventKind::Access(_))
                        || (!event.paths.is_empty()
                            && !event
                                .paths
                                .iter()
                                .any(|path| baseline.relevant_event_path(path))))
                {
                    return;
                }
            }
            Err(error) => {
                let mut slot = self.error.lock();
                if slot.is_none() {
                    *slot = Some(error.to_string().chars().take(2048).collect());
                }
            }
        }
        self.wake();
    }
}

// Some native backends join an OS thread while dropping. Keep both install and
// teardown off async/UI threads, including cancellation during installation.
struct BlockingWatcher(Option<RecommendedWatcher>);

impl Drop for BlockingWatcher {
    fn drop(&mut self) {
        if let Some(watcher) = self.0.take() {
            tokio::task::spawn_blocking(move || drop(watcher));
        }
    }
}

impl RepositoryWatch {
    pub async fn start(
        &self,
        app: tauri::AppHandle,
        snapshot_id: String,
        watch_id: String,
        baseline: Result<Option<Arc<RepositoryBaseline>>, String>,
    ) -> RepositoryWatchStatus {
        let status = RepositoryWatchStatus {
            snapshot_id,
            watch_id: watch_id.clone(),
            changed: false,
            error: None,
        };
        let (sender, receiver) = mpsc::channel(1);
        let signals = Arc::new(Signals {
            sender,
            force: AtomicBool::new(false),
            stopped: AtomicBool::new(false),
            error: Mutex::new(None),
        });
        let (initial_sender, initial_receiver) = oneshot::channel();
        {
            let mut active = self.active.lock();
            // Stop first, including late events from a superseded setup.
            active.take();
            if matches!(baseline, Ok(None)) {
                return status;
            }
            let worker = tokio::spawn(run_watch(
                app,
                status.clone(),
                baseline,
                Arc::clone(&signals),
                receiver,
                initial_sender,
                Arc::clone(&self.probes),
            ));
            *active = Some(ActiveWatch {
                id: watch_id,
                signals,
                worker,
            });
        }
        // A concurrent stop/replacement may abort setup; its status belongs to
        // the old ID and is harmless to the frontend's generation guard.
        initial_receiver.await.unwrap_or(status)
    }

    pub fn stop(&self, watch_id: &str) {
        let mut active = self.active.lock();
        if active.as_ref().is_some_and(|watch| watch.id == watch_id) {
            active.take();
        }
    }

    pub fn check(&self, watch_id: &str) {
        let active = self.active.lock();
        if let Some(watch) = active.as_ref().filter(|watch| watch.id == watch_id) {
            watch.signals.force.store(true, Ordering::Release);
            watch.signals.wake();
        }
    }

    pub fn shutdown(&self) {
        self.active.lock().take();
    }
}

async fn install(
    baseline: Arc<RepositoryBaseline>,
    signals: Arc<Signals>,
) -> Result<BlockingWatcher, String> {
    tokio::task::spawn_blocking(move || {
        let callback_baseline = Arc::clone(&baseline);
        let mut watcher = RecommendedWatcher::new(
            move |event| signals.event(&callback_baseline, event),
            Config::default().with_follow_symlinks(false),
        )
        .map_err(|error| format!("Cannot watch repository: {error}"))?;
        for path in baseline.watch_paths() {
            watcher
                .watch(path, RecursiveMode::Recursive)
                .map_err(|error| format!("Cannot watch {}: {error}", path.display()))?;
        }
        Ok(BlockingWatcher(Some(watcher)))
    })
    .await
    .map_err(|error| format!("Cannot start repository monitor: {error}"))?
}

async fn probe(
    work: impl Future<Output = Option<Result<bool, String>>>,
    on_timeout: impl FnOnce(),
) -> Option<Result<bool, String>> {
    tokio::pin!(work);
    match tokio::time::timeout(PROBE_TIMEOUT, &mut work).await {
        Ok(result) => result,
        Err(_) => {
            on_timeout();
            // Keep waiting after publishing unavailable status. Pending focus
            // checks remain coalesced in Signals and run once this scan finishes.
            work.await
        }
    }
}

fn merge(status: &mut RepositoryWatchStatus, result: Result<bool, String>) {
    match result {
        Ok(changed) => status.changed |= changed,
        Err(error) if status.error.is_none() => status.error = Some(error),
        Err(_) => {}
    }
}

async fn next_probe(receiver: &mut mpsc::Receiver<()>, signals: &Signals) -> Option<bool> {
    receiver.recv().await?;
    if signals.force.swap(false, Ordering::AcqRel) {
        return Some(true);
    }
    let maximum = Instant::now() + MAX_DELAY;
    let mut deadline = Instant::now() + DEBOUNCE;
    loop {
        tokio::select! {
            biased;
            _ = sleep_until(deadline.min(maximum)) => {
                return Some(signals.force.swap(false, Ordering::AcqRel));
            }
            signal = receiver.recv() => {
                signal?;
                if signals.force.swap(false, Ordering::AcqRel) {
                    return Some(true);
                }
                deadline = Instant::now() + DEBOUNCE;
            }
        }
    }
}

async fn run_watch(
    app: tauri::AppHandle,
    mut status: RepositoryWatchStatus,
    baseline: Result<Option<Arc<RepositoryBaseline>>, String>,
    signals: Arc<Signals>,
    mut receiver: mpsc::Receiver<()>,
    initial: oneshot::Sender<RepositoryWatchStatus>,
    probes: Arc<ProbeCoordinator>,
) {
    let mut initial = Some(initial);
    let baseline = match baseline {
        Ok(baseline) => baseline,
        Err(error) => {
            status.error = Some(error);
            None
        }
    };
    let _watcher = if let Some(baseline) = &baseline {
        match install(Arc::clone(baseline), Arc::clone(&signals)).await {
            Ok(watcher) => Some(watcher),
            Err(error) => {
                merge(&mut status, Err(error));
                None
            }
        }
    } else {
        None
    };
    // Watch first, then compare with the opening-time baseline: edits between
    // opening and activation, and during subscription, cannot disappear.
    if let Some(baseline) = &baseline {
        let result = probe(
            probes.run(&signals, || {
                let baseline = Arc::clone(baseline);
                async move { baseline.probe().await }
            }),
            || {
                merge(&mut status, Err(PROBE_TIMEOUT_ERROR.to_owned()));
                if !signals.stopped.load(Ordering::Acquire) {
                    let _ = app.emit("repository-changed", &status);
                }
                if let Some(initial) = initial.take() {
                    let _ = initial.send(status.clone());
                }
            },
        )
        .await;
        if let Some(result) = result {
            merge(&mut status, result);
        }
    }
    if !signals.stopped.load(Ordering::Acquire) {
        let _ = app.emit("repository-changed", &status);
    }
    if let Some(initial) = initial.take() {
        let _ = initial.send(status.clone());
    }
    while let Some(explicit) = next_probe(&mut receiver, &signals).await {
        let changed_before = status.changed;
        let had_error = status.error.is_some();
        {
            let error = signals.error.lock().take();
            if let Some(error) = error {
                merge(&mut status, Err(error));
            }
        }
        // A dirty latch needs no more automatic scans; explicit checks still
        // inspect the source and report errors (e.g. a moved/disconnected repo).
        if explicit || (!status.changed && status.error.is_none()) {
            if let Some(baseline) = &baseline {
                let result = probe(
                    probes.run(&signals, || {
                        let baseline = Arc::clone(baseline);
                        async move { baseline.probe().await }
                    }),
                    || {
                        merge(&mut status, Err(PROBE_TIMEOUT_ERROR.to_owned()));
                        if !signals.stopped.load(Ordering::Acquire) {
                            let _ = app.emit("repository-changed", &status);
                        }
                    },
                )
                .await;
                if let Some(result) = result {
                    merge(&mut status, result);
                }
            }
        }
        if !signals.stopped.load(Ordering::Acquire)
            && (explicit || changed_before != status.changed || had_error != status.error.is_some())
        {
            let _ = app.emit("repository-changed", &status);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn signals() -> (Arc<Signals>, mpsc::Receiver<()>) {
        let (sender, receiver) = mpsc::channel(1);
        (
            Arc::new(Signals {
                sender,
                force: AtomicBool::new(false),
                stopped: AtomicBool::new(false),
                error: Mutex::new(None),
            }),
            receiver,
        )
    }

    fn stalled_scan() -> (
        impl Future<Output = Result<bool, String>> + Send,
        oneshot::Receiver<()>,
        std::sync::mpsc::Sender<bool>,
    ) {
        let (started, started_receiver) = oneshot::channel();
        let (finish, finished) = std::sync::mpsc::channel();
        let work = async move {
            tokio::task::spawn_blocking(move || {
                let _ = started.send(());
                finished.recv().map_err(|error| error.to_string())
            })
            .await
            .unwrap()
        };
        (work, started_receiver, finish)
    }

    #[tokio::test(start_paused = true)]
    async fn stalled_scan_times_out_then_completes_and_runs_coalesced_checks() {
        use std::sync::atomic::AtomicUsize;

        let monitor = RepositoryWatch::default();
        let (signals, mut receiver) = signals();
        let (work, started, finish) = stalled_scan();
        let scans = Arc::new(AtomicUsize::new(0));
        let worker_scans = Arc::clone(&scans);
        let worker_signals = Arc::clone(&signals);
        let probes = Arc::clone(&monitor.probes);
        let (timed_out, timeout) = oneshot::channel();
        let (results, mut result_receiver) = mpsc::channel(2);
        let worker = tokio::spawn(async move {
            let result = probe(
                probes.run(&worker_signals, || {
                    worker_scans.fetch_add(1, Ordering::SeqCst);
                    work
                }),
                || {
                    let _ = timed_out.send(());
                },
            )
            .await;
            results.send(result).await.unwrap();
            while next_probe(&mut receiver, &worker_signals).await.is_some() {
                let result = probes
                    .run(&worker_signals, || {
                        worker_scans.fetch_add(1, Ordering::SeqCst);
                        async { Ok(false) }
                    })
                    .await;
                results.send(result).await.unwrap();
            }
        });
        *monitor.active.lock() = Some(ActiveWatch {
            id: "current".into(),
            signals,
            worker,
        });
        started.await.unwrap();
        tokio::time::advance(PROBE_TIMEOUT).await;
        timeout.await.unwrap();
        for _ in 0..10_000 {
            monitor.check("current");
        }
        tokio::time::advance(PROBE_TIMEOUT * 3).await;
        tokio::task::yield_now().await;
        assert_eq!(scans.load(Ordering::SeqCst), 1);
        assert!(result_receiver.try_recv().is_err());

        finish.send(true).unwrap();
        assert_eq!(result_receiver.recv().await, Some(Some(Ok(true))));
        assert_eq!(result_receiver.recv().await, Some(Some(Ok(false))));
        assert_eq!(scans.load(Ordering::SeqCst), 2);
        monitor.stop("current");
    }

    #[tokio::test(start_paused = true)]
    async fn canceled_and_replaced_watches_wait_for_stalled_scan_without_owning_its_result() {
        use std::sync::atomic::AtomicUsize;

        let monitor = RepositoryWatch::default();
        let (old_signals, _) = signals();
        let (work, started, finish) = stalled_scan();
        let probes = Arc::clone(&monitor.probes);
        let worker_signals = Arc::clone(&old_signals);
        let (old_result, old_receiver) = oneshot::channel();
        let worker = tokio::spawn(async move {
            let result = probes.run(&worker_signals, || work).await;
            let _ = old_result.send(result);
        });
        *monitor.active.lock() = Some(ActiveWatch {
            id: "old".into(),
            signals: old_signals,
            worker,
        });
        started.await.unwrap();
        // Cancellation before the original deadline must retain the scan too.
        monitor.stop("old");
        assert!(old_receiver.await.is_err());

        let scans = Arc::new(AtomicUsize::new(1));
        let mut current_result = None;
        for id in ["replacement", "current"] {
            let (signals, _) = signals();
            let worker_signals = Arc::clone(&signals);
            let probes = Arc::clone(&monitor.probes);
            let worker_scans = Arc::clone(&scans);
            let (timed_out, timeout) = oneshot::channel();
            let (result_sender, result_receiver) = oneshot::channel();
            let worker = tokio::spawn(async move {
                let result = probe(
                    probes.run(&worker_signals, || {
                        worker_scans.fetch_add(1, Ordering::SeqCst);
                        async { Ok(false) }
                    }),
                    || {
                        let _ = timed_out.send(());
                    },
                )
                .await;
                let _ = result_sender.send(result);
            });
            // Dropping the previous ActiveWatch aborts a waiter, not the scan.
            *monitor.active.lock() = Some(ActiveWatch {
                id: id.into(),
                signals,
                worker,
            });
            tokio::task::yield_now().await;
            tokio::time::advance(PROBE_TIMEOUT).await;
            timeout.await.unwrap();
            for _ in 0..100 {
                monitor.check(id);
            }
            assert_eq!(scans.load(Ordering::SeqCst), 1);
            current_result = Some(result_receiver);
        }
        finish.send(true).unwrap();
        // The old scan is dirty, but the current snapshot's own scan is clean.
        assert_eq!(current_result.unwrap().await.unwrap(), Some(Ok(false)));
        assert_eq!(scans.load(Ordering::SeqCst), 2);
        monitor.shutdown();
    }

    #[tokio::test(start_paused = true)]
    async fn canceled_probe_wait_resumes_same_task_and_rejects_stopped_owner() {
        let probes = Arc::new(ProbeCoordinator::default());
        let (owner, _) = signals();
        let (work, started, finish) = stalled_scan();
        let worker_owner = Arc::clone(&owner);
        let worker_probes = Arc::clone(&probes);
        let waiter = tokio::spawn(async move {
            tokio::time::timeout(PROBE_TIMEOUT, worker_probes.run(&worker_owner, || work)).await
        });
        started.await.unwrap();
        tokio::time::advance(PROBE_TIMEOUT).await;
        assert!(waiter.await.unwrap().is_err());
        finish.send(true).unwrap();
        assert_eq!(
            probes
                .run(&owner, || async { panic!("retained scan was replaced") })
                .await,
            Some(Ok(true))
        );

        let (work, started, finish) = stalled_scan();
        let worker_owner = Arc::clone(&owner);
        let worker_probes = Arc::clone(&probes);
        let waiter = tokio::spawn(async move { worker_probes.run(&worker_owner, || work).await });
        started.await.unwrap();
        owner.stopped.store(true, Ordering::Release);
        finish.send(true).unwrap();
        assert_eq!(waiter.await.unwrap(), None);
        assert_eq!(
            probes
                .run(&owner, || async { panic!("stopped owner started a scan") })
                .await,
            None
        );
        let (new_owner, _) = signals();
        assert_eq!(
            probes.run(&new_owner, || async { Ok(false) }).await,
            Some(Ok(false))
        );
    }

    #[tokio::test]
    async fn burst_is_bounded_and_explicit_checks_bypass_debounce() {
        let (signals, mut receiver) = signals();
        for _ in 0..10_000 {
            signals.wake();
        }
        assert_eq!(receiver.len(), 1);
        signals.force.store(true, Ordering::Release);
        assert_eq!(next_probe(&mut receiver, &signals).await, Some(true));
        assert!(receiver.try_recv().is_err());
        signals.stopped.store(true, Ordering::Release);
        signals.wake();
        assert!(receiver.try_recv().is_err());
    }

    #[tokio::test]
    async fn access_and_git_noise_are_ignored_but_overflow_and_errors_rescan() {
        use notify::event::{AccessKind, Flag};
        let root = tempfile::tempdir().unwrap();
        let output = std::process::Command::new("git")
            .args(["init", "-b", "main"])
            .current_dir(root.path())
            .output()
            .unwrap();
        assert!(output.status.success());
        let snapshot = peer_core::repository::create_snapshot(
            root.path().to_str().unwrap(),
            peer_core::Comparison::default(),
            None,
            &std::collections::BTreeMap::new(),
        )
        .await
        .unwrap();
        let baseline = snapshot.repository_watch.unwrap().unwrap();
        let (signals, mut receiver) = signals();
        let root = root.path().canonicalize().unwrap();
        signals.event(
            &baseline,
            Ok(Event::new(EventKind::Access(AccessKind::Read)).add_path(root.join("source.txt"))),
        );
        signals.event(
            &baseline,
            Ok(Event::new(EventKind::Any).add_path(root.join(".git/index.lock"))),
        );
        assert!(receiver.try_recv().is_err());
        signals.event(
            &baseline,
            Ok(Event::new(EventKind::Access(AccessKind::Read))
                .add_path(root.join(".git/index.lock"))
                .set_flag(Flag::Rescan)),
        );
        assert_eq!(receiver.try_recv(), Ok(()));
        signals.event(&baseline, Err(notify::Error::generic("watch unavailable")));
        signals.event(&baseline, Err(notify::Error::generic("later error")));
        assert_eq!(receiver.len(), 1);
        assert!(signals
            .error
            .lock()
            .as_deref()
            .unwrap()
            .contains("watch unavailable"));
    }

    #[tokio::test(start_paused = true)]
    async fn sustained_events_cannot_extend_the_maximum_debounce_delay() {
        let (signals, mut receiver) = signals();
        let worker_signals = Arc::clone(&signals);
        signals.wake();
        let task = tokio::spawn(async move { next_probe(&mut receiver, &worker_signals).await });
        tokio::task::yield_now().await;
        for _ in 0..9 {
            tokio::time::advance(Duration::from_millis(100)).await;
            signals.wake();
            tokio::task::yield_now().await;
            assert!(!task.is_finished());
        }
        tokio::time::advance(Duration::from_millis(100)).await;
        assert_eq!(task.await.unwrap(), Some(false));
    }

    #[tokio::test]
    async fn stale_watch_ids_cannot_check_or_stop_the_active_worker() {
        let monitor = RepositoryWatch::default();
        let (signals, mut receiver) = signals();
        let worker = tokio::spawn(std::future::pending());
        let abort = worker.abort_handle();
        *monitor.active.lock() = Some(ActiveWatch {
            id: "current".into(),
            signals: Arc::clone(&signals),
            worker,
        });
        monitor.check("previous");
        monitor.stop("previous");
        assert!(receiver.try_recv().is_err());
        assert!(monitor.active.lock().is_some());
        monitor.check("current");
        assert_eq!(next_probe(&mut receiver, &signals).await, Some(true));
        monitor.stop("current");
        assert!(monitor.active.lock().is_none());
        assert!(signals.stopped.load(Ordering::Acquire));
        tokio::task::yield_now().await;
        assert!(abort.is_finished());
    }

    #[test]
    fn status_latches_changed_and_first_error_independently() {
        let mut status = RepositoryWatchStatus {
            snapshot_id: "snapshot".into(),
            watch_id: "watch".into(),
            changed: false,
            error: None,
        };
        merge(&mut status, Ok(true));
        merge(&mut status, Ok(false));
        merge(&mut status, Err("repository disconnected".into()));
        merge(&mut status, Err("later error".into()));
        merge(&mut status, Ok(false));
        assert!(status.changed);
        assert_eq!(status.error.as_deref(), Some("repository disconnected"));
    }
}
