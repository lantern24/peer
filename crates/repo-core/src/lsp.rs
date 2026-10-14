//! A small read-only stdio LSP client. Source coordinates are always UTF-16.
use crate::navigation::{LanguageServer, NavigationError};
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::Path,
    process::Stdio,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Weak,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, Command},
    sync::{mpsc, oneshot, Mutex as AsyncMutex},
};

type Reply = Result<Value, NavigationError>;
#[derive(Clone, Copy, Default)]
struct AnalysisStatus {
    quiescent: Option<bool>,
    revision: u64,
}
struct Inner {
    sender: mpsc::UnboundedSender<Value>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Reply>>>,
    child: AsyncMutex<Child>,
    sequence: AtomicU64,
    failed: AtomicBool,
    stderr: Mutex<String>,
    analysis: tokio::sync::watch::Sender<AnalysisStatus>,
}
impl Drop for Inner {
    fn drop(&mut self) {
        let _ = self.child.get_mut().start_kill();
    }
}
#[derive(Clone)]
pub(crate) struct Client {
    inner: Arc<Inner>,
    require_analysis_status: bool,
    pub capabilities: Value,
}
struct Pending {
    inner: Weak<Inner>,
    id: u64,
}
impl Drop for Pending {
    fn drop(&mut self) {
        if let Some(inner) = self.inner.upgrade() {
            if inner.pending.lock().remove(&self.id).is_some() {
                let _ = inner.sender.send(
                    json!({"jsonrpc":"2.0", "method":"$/cancelRequest", "params":{"id":self.id}}),
                );
            }
        }
    }
}
pub(crate) fn uri(path: &Path) -> Result<String, NavigationError> {
    url::Url::from_file_path(path)
        .map(|url| url.to_string())
        .map_err(|_| NavigationError::new("missingSource", "Invalid source path"))
}
pub(crate) fn file_path(uri: &str) -> Result<std::path::PathBuf, NavigationError> {
    url::Url::parse(uri)
        .ok()
        .filter(|url| url.scheme() == "file")
        .and_then(|url| url.to_file_path().ok())
        .ok_or_else(|| {
            NavigationError::new(
                "missingSource",
                "The language server returned a non-local source document",
            )
        })
}
fn configuration(settings: &Value, section: Option<&str>) -> Value {
    let Some(section) = section.filter(|s| !s.is_empty()) else {
        return settings.clone();
    };
    if let Some(value) = settings.get(section) {
        return value.clone();
    }
    section
        .split('.')
        .try_fold(settings, |value, part| value.get(part))
        .cloned()
        .unwrap_or(Value::Null)
}

// Finder does not inherit the user's terminal PATH. Recover it once, only for
// language-server children; never mutate the multithreaded app's environment.
#[cfg(target_os = "macos")]
async fn login_shell_path() -> Option<&'static std::ffi::OsStr> {
    static PATH: tokio::sync::OnceCell<Option<std::ffi::OsString>> =
        tokio::sync::OnceCell::const_new();
    PATH.get_or_init(|| async {
        match read_login_shell_path().await {
            Ok(path) => Some(path),
            Err(error) => {
                eprintln!("Cannot read login-shell PATH: {error}; using inherited PATH");
                None
            }
        }
    })
    .await
    .as_deref()
}

#[cfg(target_os = "macos")]
async fn read_login_shell_path() -> std::io::Result<std::ffi::OsString> {
    use std::{ffi::OsString, io, os::unix::ffi::OsStringExt};

    const LIMIT: u64 = 64 * 1024;
    let shell = std::env::var_os("SHELL")
        .filter(|shell| !shell.is_empty())
        .unwrap_or_else(|| "/bin/zsh".into());
    let mut child = Command::new(shell)
        .args(["-ilc", "printf '\\0PEER_PATH\\0%s\\0' \"$PATH\""])
        // Do not run shell startup files in the repository being inspected.
        .current_dir(std::env::var_os("HOME").unwrap_or_else(|| "/".into()))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()?;
    let result = tokio::time::timeout(Duration::from_secs(5), async {
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| io::Error::other("Missing shell stdout"))?;
        let mut bytes = Vec::new();
        stdout.take(LIMIT + 1).read_to_end(&mut bytes).await?;
        if bytes.len() as u64 > LIMIT {
            return Err(io::Error::other("Shell startup output exceeded 64 KiB"));
        }
        let status = child.wait().await?;
        if !status.success() {
            return Err(io::Error::other(format!(
                "Login shell exited with {status}"
            )));
        }
        // NUL framing excludes startup banners without trimming valid path bytes.
        let mut fields = bytes.split(|byte| *byte == 0);
        let path = fields
            .find(|field| *field == b"PEER_PATH")
            .and_then(|_| fields.next())
            .filter(|path| !path.is_empty())
            .ok_or_else(|| io::Error::other("Login shell did not return PATH"))?;
        Ok(OsString::from_vec(path.to_vec()))
    })
    .await
    .unwrap_or_else(|_| {
        Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "Login-shell PATH discovery timed out",
        ))
    });
    if result.is_err() {
        // kill() also reaps the shell on timeout or excessive startup output.
        let _ = child.kill().await;
    }
    result
}

impl Client {
    pub async fn start(config: &LanguageServer, root: &Path) -> Result<Self, NavigationError> {
        let mut command = Command::new(&config.executable);
        #[cfg(target_os = "macos")]
        if !config.env.contains_key("PATH") {
            if let Some(path) = login_shell_path().await {
                command.env("PATH", path);
            }
        }
        command
            .args(&config.args)
            .envs(&config.env)
            .current_dir(root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = command.spawn().map_err(|error| NavigationError::new("missingServer", format!(
            "Cannot start {} ({}): {error}. Install its language server and toolchain, or configure its executable in Settings → Code navigation.", config.name, config.executable)))?;
        let mut stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();
        let (sender, mut messages) = mpsc::unbounded_channel::<Value>();
        let inner = Arc::new(Inner {
            sender,
            pending: Mutex::new(HashMap::new()),
            child: AsyncMutex::new(child),
            sequence: AtomicU64::new(1),
            failed: AtomicBool::new(false),
            stderr: Mutex::new(String::new()),
            analysis: tokio::sync::watch::channel(AnalysisStatus::default()).0,
        });
        tokio::spawn(async move {
            while let Some(message) = messages.recv().await {
                let bytes = serde_json::to_vec(&message).unwrap();
                if stdin
                    .write_all(format!("Content-Length: {}\r\n\r\n", bytes.len()).as_bytes())
                    .await
                    .is_err()
                    || stdin.write_all(&bytes).await.is_err()
                    || stdin.flush().await.is_err()
                {
                    break;
                }
            }
        });
        let weak = Arc::downgrade(&inner);
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr);
            let mut buffer = [0u8; 4096];
            while let Ok(count) = reader.read(&mut buffer).await {
                if count == 0 {
                    break;
                }
                let Some(inner) = weak.upgrade() else { break };
                let mut text = inner.stderr.lock();
                text.push_str(&String::from_utf8_lossy(&buffer[..count]));
                if text.len() > 8192 {
                    *text = text
                        .chars()
                        .rev()
                        .take(4096)
                        .collect::<String>()
                        .chars()
                        .rev()
                        .collect();
                }
            }
        });
        let weak = Arc::downgrade(&inner);
        let settings = config.settings.clone();
        let root_uri = uri(root)?;
        let workspace_uri = root_uri.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout);
            let failure = loop {
                let mut length = None;
                let mut header = String::new();
                let mut broken = false;
                let mut header_bytes = 0;
                loop {
                    header.clear();
                    match (&mut reader).take(8193).read_line(&mut header).await {
                        Ok(0) | Err(_) => {
                            broken = true;
                            break;
                        }
                        _ => {}
                    }
                    if header == "\r\n" || header == "\n" {
                        break;
                    }
                    header_bytes += header.len();
                    if header_bytes > 8192 {
                        broken = true;
                        break;
                    }
                    if let Some((name, value)) = header.split_once(':') {
                        if name.eq_ignore_ascii_case("content-length") {
                            length = value.trim().parse::<usize>().ok();
                        }
                    }
                }
                if broken {
                    break "Language server exited. Check its toolchain and project dependencies, then retry.";
                }
                let Some(length) = length.filter(|length| *length <= 64 * 1024 * 1024) else {
                    break "Invalid language-server message size";
                };
                let mut bytes = vec![0; length];
                if reader.read_exact(&mut bytes).await.is_err() {
                    break "Language server disconnected";
                }
                let Ok(message) = serde_json::from_slice::<Value>(&bytes) else {
                    break "Invalid language-server JSON";
                };
                let Some(inner) = weak.upgrade() else { return };
                if let Some(method) = message.get("method").and_then(Value::as_str) {
                    if let Some(id) = message.get("id") {
                        let params = &message["params"];
                        let result = match method {
                            "workspace/configuration" => Some(Value::Array(
                                params["items"]
                                    .as_array()
                                    .into_iter()
                                    .flatten()
                                    .map(|item| configuration(&settings, item["section"].as_str()))
                                    .collect(),
                            )),
                            "workspace/workspaceFolders" => {
                                Some(json!([{"uri":workspace_uri,"name":"Peer snapshot"}]))
                            }
                            "window/workDoneProgress/create"
                            | "client/registerCapability"
                            | "client/unregisterCapability"
                            | "window/showMessageRequest" => Some(Value::Null),
                            "workspace/applyEdit" => {
                                Some(json!({"applied":false,"failureReason":"Peer is read-only"}))
                            }
                            _ => None,
                        };
                        let reply = match result {
                            Some(result) => json!({"jsonrpc":"2.0", "id":id, "result":result}),
                            None => {
                                json!({"jsonrpc":"2.0", "id":id,"error":{"code":-32601,"message":"Method not supported"}})
                            }
                        };
                        let _ = inner.sender.send(reply);
                    } else if method == "experimental/serverStatus" {
                        if let Some(quiescent) = message["params"]["quiescent"].as_bool() {
                            inner.analysis.send_modify(|status| {
                                if status.quiescent != Some(quiescent) {
                                    status.quiescent = Some(quiescent);
                                    status.revision += 1;
                                }
                            });
                        }
                    }
                } else if let Some(id) = message["id"].as_u64() {
                    if let Some(sender) = inner.pending.lock().remove(&id) {
                        // Keep the protocol error code until the request decides
                        // whether a frozen-source navigation query can be retried.
                        let _ = sender.send(Ok(message));
                    }
                }
            };
            if let Some(inner) = weak.upgrade() {
                inner.failed.store(true, Ordering::SeqCst);
                inner.analysis.send_modify(|_| {});
                let _ = inner.child.lock().await.start_kill();
                let detail = inner.stderr.lock().clone();
                for (_, sender) in inner.pending.lock().drain() {
                    let _ = sender.send(Err(NavigationError::new(
                        "serverError",
                        format!("{failure}\n{detail}").trim(),
                    )));
                }
            }
        });
        let mut client = Self {
            inner,
            require_analysis_status: false,
            capabilities: Value::Null,
        };
        let result = client.request("initialize", json!({
            "processId":std::process::id(),"clientInfo":{"name":"Peer","version":env!("CARGO_PKG_VERSION")},
            "rootUri":root_uri,"workspaceFolders":[{"uri":root_uri,"name":"Peer snapshot"}],
            "initializationOptions":config.initialization_options,
            "capabilities":{"general":{"positionEncodings":["utf-16"]},
                "workspace":{"configuration":true,"workspaceFolders":true,"applyEdit":false},
                "window":{"workDoneProgress":true},
                "experimental":{"serverStatusNotification":true},
                "textDocument":{"definition":{"linkSupport":true},"references":{},"synchronization":{"didSave":false}}}
        }), Duration::from_secs(60)).await?;
        client.capabilities = result["capabilities"].clone();
        // rust-analyzer can answer with an empty result before its first status
        // notification. Detect the server, not a preset ID or executable path.
        client.require_analysis_status =
            result["serverInfo"]["name"].as_str() == Some("rust-analyzer");
        if client.capabilities["positionEncoding"]
            .as_str()
            .is_some_and(|encoding| encoding != "utf-16")
        {
            return Err(NavigationError::new(
                "unsupported",
                "Language server did not negotiate UTF-16 positions",
            ));
        }
        client.notify("initialized", json!({}))?;
        client.notify(
            "workspace/didChangeConfiguration",
            json!({"settings":config.settings}),
        )?;
        Ok(client)
    }
    pub fn notify(&self, method: &str, params: Value) -> Result<(), NavigationError> {
        self.inner
            .sender
            .send(json!({"jsonrpc":"2.0","method":method,"params":params}))
            .map_err(|_| NavigationError::new("serverError", "Language server disconnected"))
    }
    pub async fn request(&self, method: &str, params: Value, timeout: Duration) -> Reply {
        let navigation_request = matches!(
            method,
            "textDocument/definition" | "textDocument/references"
        );
        let mut message = json!({"jsonrpc":"2.0","method":method,"params":params});
        let mut analysis = navigation_request.then(|| self.inner.analysis.subscribe());
        tokio::time::timeout(timeout, async {
            loop {
                let revision = if let Some(analysis) = &mut analysis {
                    analysis
                        .wait_for(|status| {
                            self.inner.failed.load(Ordering::SeqCst)
                                || status.quiescent.unwrap_or(!self.require_analysis_status)
                        })
                        .await
                        .map_err(|_| {
                            NavigationError::new("serverError", "Language server disconnected")
                        })?
                        .revision
                } else {
                    0
                };
                if !self.alive() {
                    return Err(NavigationError::new(
                        "serverError",
                        "Language server exited; retry to restart it",
                    ));
                }
                let id = self.inner.sequence.fetch_add(1, Ordering::Relaxed);
                let (sender, receiver) = oneshot::channel();
                self.inner.pending.lock().insert(id, sender);
                let _pending = Pending {
                    inner: Arc::downgrade(&self.inner),
                    id,
                };
                message["id"] = json!(id);
                self.inner
                    .sender
                    .send(if navigation_request {
                        message.clone()
                    } else {
                        message.take()
                    })
                    .map_err(|_| {
                        NavigationError::new("serverError", "Language server disconnected")
                    })?;
                let mut response = receiver.await.map_err(|_| {
                    NavigationError::new("serverError", "Language server disconnected")
                })??;
                if let Some(error) = response.get("error") {
                    // Opening a document or background indexing can invalidate
                    // analysis even though Peer's snapshot source is unchanged.
                    // Retry only LSP ContentModified, within the original deadline.
                    if navigation_request && error["code"].as_i64() == Some(-32801) {
                        tokio::time::sleep(Duration::from_millis(100)).await;
                        continue;
                    }
                    return Err(NavigationError::new(
                        "serverError",
                        error["message"].as_str().unwrap_or("Language-server error"),
                    ));
                }
                if navigation_request && self.inner.analysis.borrow().revision != revision {
                    // Indexing changed while this query was in flight. Even if
                    // the server is ready again, this response may be incomplete.
                    continue;
                }
                return Ok(response
                    .get_mut("result")
                    .map(Value::take)
                    .unwrap_or(Value::Null));
            }
        })
        .await
        .map_err(|_| {
            NavigationError::new(
                "timeout",
                "Language server timed out. Check project dependencies or retry after indexing.",
            )
        })?
    }
    pub fn alive(&self) -> bool {
        !self.inner.failed.load(Ordering::SeqCst)
            && self
                .inner
                .child
                .try_lock()
                .map_or(true, |mut child| child.try_wait().ok().flatten().is_none())
    }
    pub async fn shutdown(&self) {
        let _ = self
            .request("shutdown", Value::Null, Duration::from_secs(1))
            .await;
        let _ = self.notify("exit", Value::Null);
        let mut child = self.inner.child.lock().await;
        let _ = child.start_kill();
        // Windows cannot remove the workspace while it is the server's current
        // directory. Keep ownership and wait for exit before releasing it.
        let _ = child.wait().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (tempfile::TempDir, LanguageServer, String) {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("call.ts");
        std::fs::write(&path, "hang();\nconst value = 1;\nvalue;\n").unwrap();
        let mut server = crate::navigation::default_servers().remove(1);
        server.executable = "node".into();
        server.args = vec![Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/support/fake-lsp.mjs")
            .to_str()
            .unwrap()
            .into()];
        let uri = uri(&path).unwrap();
        (root, server, uri)
    }

    #[tokio::test]
    async fn navigation_waits_for_initial_analysis_status() {
        let (root, mut server, uri) = fixture();
        server
            .env
            .insert("PEER_FAKE_ANALYSIS".into(), "startup".into());
        let client = Client::start(&server, root.path()).await.unwrap();
        let query = client.request(
            "textDocument/definition",
            json!({"textDocument":{"uri":uri},"position":{"line":2,"character":1}}),
            Duration::from_secs(2),
        );
        tokio::pin!(query);
        // The barrier replies after any prematurely issued query. No sleep or
        // timing threshold is needed to expose an empty result during startup.
        tokio::select! {
            biased;
            result = &mut query => panic!("Query finished before analysis was ready: {result:?}"),
            result = client.request("fixture/barrier", Value::Null, Duration::from_secs(2)) => {
                result.unwrap();
            }
        }
        client.notify("fixture/analysisReady", Value::Null).unwrap();
        let result = query.await.unwrap();
        assert_eq!(result[0]["range"]["start"]["line"], 1);
        client.shutdown().await;
    }

    #[tokio::test]
    async fn navigation_reissues_results_invalidated_by_analysis_transitions() {
        let (root, mut server, uri) = fixture();
        server
            .env
            .insert("PEER_FAKE_ANALYSIS".into(), "inflight".into());
        let client = Client::start(&server, root.path()).await.unwrap();
        for (method, expected_line) in [
            ("textDocument/definition", 1),
            ("textDocument/references", 2),
        ] {
            let result = client
                .request(
                    method,
                    json!({"textDocument":{"uri":uri},"position":{"line":2,"character":1}}),
                    Duration::from_secs(2),
                )
                .await
                .unwrap();
            assert_eq!(
                result[0]["range"]["start"]["line"], expected_line,
                "{method}"
            );
        }
        // A ready server's genuinely empty response must not enter a retry loop.
        let empty = client
            .request(
                "textDocument/definition",
                json!({"textDocument":{"uri":uri},"position":{"line":1,"character":12}}),
                Duration::from_secs(2),
            )
            .await
            .unwrap();
        assert_eq!(empty, json!([]));
        client.shutdown().await;
    }

    #[tokio::test]
    async fn cancelling_an_analysis_wait_does_not_poison_later_navigation() {
        let (root, mut server, uri) = fixture();
        server
            .env
            .insert("PEER_FAKE_ANALYSIS".into(), "busy".into());
        let client = Client::start(&server, root.path()).await.unwrap();
        let params = json!({"textDocument":{"uri":uri},"position":{"line":2,"character":1}});
        let task_client = client.clone();
        let task_params = params.clone();
        let mut query = tokio::spawn(async move {
            task_client
                .request(
                    "textDocument/definition",
                    task_params,
                    Duration::from_secs(5),
                )
                .await
        });
        tokio::select! {
            biased;
            result = &mut query => panic!("Query finished while analysis was busy: {result:?}"),
            result = client.request("fixture/barrier", Value::Null, Duration::from_secs(2)) => {
                result.unwrap();
            }
        }
        query.abort();
        assert!(query.await.unwrap_err().is_cancelled());
        client.notify("fixture/analysisReady", Value::Null).unwrap();
        let result = client
            .request("textDocument/definition", params, Duration::from_secs(2))
            .await
            .unwrap();
        assert_eq!(result[0]["range"]["start"]["line"], 1);
        client.shutdown().await;
    }

    #[tokio::test]
    async fn analysis_waits_respect_deadlines_and_server_exit() {
        let (root, mut server, uri) = fixture();
        server
            .env
            .insert("PEER_FAKE_ANALYSIS".into(), "busy".into());
        let client = Client::start(&server, root.path()).await.unwrap();
        let params = json!({"textDocument":{"uri":uri},"position":{"line":2,"character":1}});
        let error = tokio::time::timeout(
            Duration::from_secs(2),
            client.request(
                "textDocument/definition",
                params.clone(),
                Duration::from_millis(50),
            ),
        )
        .await
        .expect("Waiting for analysis exceeded the request deadline")
        .unwrap_err();
        assert_eq!(error.code, "timeout");
        let query = client.request("textDocument/definition", params, Duration::from_secs(5));
        tokio::pin!(query);
        tokio::select! {
            biased;
            result = &mut query => panic!("Query finished while analysis was busy: {result:?}"),
            result = client.request("fixture/barrier", Value::Null, Duration::from_secs(2)) => {
                result.unwrap();
            }
        }
        client.notify("fixture/crash", Value::Null).unwrap();
        let error = tokio::time::timeout(Duration::from_secs(2), query)
            .await
            .expect("Server exit did not wake the analysis wait")
            .unwrap_err();
        assert_eq!(error.code, "serverError");
        client.shutdown().await;
    }

    #[tokio::test]
    async fn other_server_errors_are_not_retried() {
        for code in [-32603, -32800, -32802] {
            let (root, mut server, uri) = fixture();
            server.env.insert(
                "PEER_FAKE_ERRORS".into(),
                json!({"code": code, "count": 1}).to_string(),
            );
            let client = Client::start(&server, root.path()).await.unwrap();
            for method in ["textDocument/definition", "textDocument/references"] {
                let error = client
                    .request(
                        method,
                        json!({"textDocument":{"uri":uri},"position":{"line":2,"character":1}}),
                        Duration::from_secs(2),
                    )
                    .await
                    .unwrap_err();
                assert_eq!(error.code, "serverError", "{method}: {code}");
                assert_eq!(error.message, "content modified");
            }
            client.shutdown().await;
        }
    }

    #[tokio::test]
    async fn content_modified_retries_share_the_original_deadline() {
        let (root, mut server, uri) = fixture();
        server.env.insert(
            "PEER_FAKE_ERRORS".into(),
            json!({"code": -32801, "count": 1000}).to_string(),
        );
        let client = Client::start(&server, root.path()).await.unwrap();
        let error = tokio::time::timeout(
            Duration::from_secs(2),
            client.request(
                "textDocument/definition",
                json!({"textDocument":{"uri":uri},"position":{"line":2,"character":1}}),
                Duration::from_millis(250),
            ),
        )
        .await
        .expect("ContentModified retries extended the request deadline")
        .unwrap_err();
        assert_eq!(error.code, "timeout");
        client.shutdown().await;
    }

    #[tokio::test]
    async fn a_timed_out_request_does_not_poison_the_connection() {
        let (root, mut server, uri) = fixture();
        server.settings = json!({"fixture":{"enabled":true,"nested":{"value":42}}});
        server.env.insert(
            "PEER_FAKE_EXPECT_CONFIG".into(),
            json!([server.settings["fixture"]]).to_string(),
        );
        let client = Client::start(&server, root.path()).await.unwrap();
        let error = client
            .request(
                "textDocument/definition",
                json!({"textDocument":{"uri":uri},"position":{"line":0,"character":1}}),
                Duration::from_millis(50),
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, "timeout");
        let result = client
            .request(
                "textDocument/definition",
                json!({"textDocument":{"uri":uri},"position":{"line":2,"character":1}}),
                Duration::from_secs(2),
            )
            .await
            .unwrap();
        assert_eq!(result[0]["range"]["start"]["line"], 1);
        client.shutdown().await;
        assert!(
            client
                .inner
                .child
                .lock()
                .await
                .try_wait()
                .unwrap()
                .is_some(),
            "shutdown returned before the language-server process exited"
        );
        assert!(!client.alive());
        root.close().unwrap();
    }
}
