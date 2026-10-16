use serde::Serialize;
use std::path::Path;

const MAX_REPORT_BYTES: usize = 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeDiagnostics {
    app_version: String,
    os: &'static str,
    os_version: Option<String>,
    arch: &'static str,
    webview_version: Option<String>,
    errors: Vec<String>,
}

#[tauri::command]
pub(crate) async fn diagnostic_runtime(app: tauri::AppHandle) -> RuntimeDiagnostics {
    let mut report = RuntimeDiagnostics {
        app_version: app.package_info().version.to_string(),
        os: std::env::consts::OS,
        os_version: None,
        arch: std::env::consts::ARCH,
        webview_version: None,
        errors: Vec::new(),
    };
    match tauri::async_runtime::spawn_blocking(tauri::webview_version).await {
        Ok(Ok(version)) if !version.trim().is_empty() => report.webview_version = Some(version),
        Ok(Ok(_)) => report.errors.push("WebView version was empty".into()),
        Ok(Err(error)) => report
            .errors
            .push(format!("WebView version unavailable: {error}")),
        Err(error) => report
            .errors
            .push(format!("WebView version task failed: {error}")),
    }
    match os_version().await {
        Ok(version) => report.os_version = Some(version),
        Err(error) => report.errors.push(error),
    }
    report
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
async fn os_version() -> Result<String, String> {
    use std::process::Stdio;
    use std::time::Duration;
    use tokio::io::AsyncReadExt;

    #[cfg(target_os = "macos")]
    let (program, argument) = ("/usr/bin/sw_vers", "-productVersion");
    #[cfg(target_os = "linux")]
    let (program, argument) = ("/usr/bin/uname", "-r");

    let mut child = tokio::process::Command::new(program)
        .arg(argument)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| format!("OS version command {program} failed to start: {error}"))?;
    // Bound both output and elapsed time; retain the child so timeout cleanup reaps it.
    let result = tokio::time::timeout(Duration::from_secs(2), async {
        let stdout = child.stdout.take().ok_or("OS version stdout unavailable")?;
        let mut bytes = Vec::with_capacity(128);
        stdout
            .take(1025)
            .read_to_end(&mut bytes)
            .await
            .map_err(|error| format!("OS version output read failed: {error}"))?;
        if bytes.len() > 1024 {
            return Err("OS version output exceeded 1024 bytes".into());
        }
        let status = child
            .wait()
            .await
            .map_err(|error| format!("OS version command wait failed: {error}"))?;
        if !status.success() {
            return Err(format!("OS version command exited with {status}"));
        }
        let version = String::from_utf8(bytes)
            .map_err(|error| format!("OS version output was not UTF-8: {error}"))?;
        let version = version.trim();
        if version.is_empty() {
            return Err("OS version output was empty".into());
        }
        Ok(version.to_owned())
    })
    .await
    .unwrap_or_else(|_| Err("OS version command timed out after 2 seconds".into()));
    if let Err(error) = &result {
        // kill() also waits for the process, avoiding a zombie after timeout/read failure.
        if let Err(cleanup_error) = child.kill().await {
            return Err(format!(
                "{error}; OS version command cleanup failed: {cleanup_error}"
            ));
        }
    }
    result
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
async fn os_version() -> Result<String, String> {
    Err(format!(
        "OS version collection is unavailable on {}",
        std::env::consts::OS
    ))
}

#[tauri::command]
pub(crate) async fn save_diagnostic_report(path: String, text: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || write_report(Path::new(&path), &text))
        .await
        .map_err(|error| format!("Diagnostic report save task failed: {error}"))?
}

fn write_report(path: &Path, text: &str) -> Result<(), String> {
    if text.len() > MAX_REPORT_BYTES {
        return Err("Diagnostic report exceeds the 1 MiB UTF-8 byte limit".into());
    }
    std::fs::write(path, text).map_err(|error| {
        format!(
            "Unable to save diagnostic report to {}: {error}",
            path.display()
        )
    })
}

#[cfg(test)]
mod tests {
    use super::{write_report, MAX_REPORT_BYTES};

    #[test]
    fn writes_unicode_report_and_accepts_exact_byte_limit() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("report.txt");
        let text = "Peer diagnostics\n路径 café 𐐀\n";
        write_report(&path, text).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), text);
        let at_limit = "é".repeat(MAX_REPORT_BYTES / 2);
        write_report(&path, &at_limit).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), at_limit);
    }

    #[test]
    fn rejects_oversized_utf8_without_touching_destination() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("report.txt");
        std::fs::write(&path, "existing report").unwrap();
        let text = "é".repeat(MAX_REPORT_BYTES / 2 + 1);
        assert!(text.chars().count() < MAX_REPORT_BYTES);
        assert!(write_report(&path, &text).unwrap_err().contains("1 MiB"));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "existing report");
    }

    #[test]
    fn reports_invalid_destination_with_context() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("missing").join("report.txt");
        let error = write_report(&path, "report").unwrap_err();
        assert!(error.contains("Unable to save diagnostic report"));
        assert!(error.contains(&path.display().to_string()));
        assert!(!path.exists());
    }
}
