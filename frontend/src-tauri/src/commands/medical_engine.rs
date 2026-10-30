use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use rand::distr::Alphanumeric;
use rand::RngExt;
use tauri::Manager;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

use crate::utils::{add_log, app_data_dir};

static MEDICAL_ENGINE_PROCESS: Mutex<Option<CommandChild>> = Mutex::new(None);
static MEDICAL_ENGINE_RUNTIME: Mutex<Option<MedicalEngineRuntime>> = Mutex::new(None);
const MACOS_OFFLINE_SANDBOX_PROFILE: &str = "(version 1)(allow default)(deny network-outbound)";

#[derive(Clone, Debug)]
pub struct MedicalEngineRuntime {
    pub url: String,
    pub shared_secret: String,
}

fn platform_dir() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

fn executable_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "medical-redact-engine.exe"
    } else {
        "medical-redact-engine"
    }
}

fn bundled_engine_path(resource_dir: &Path) -> PathBuf {
    resource_dir
        .join("medical-engine")
        .join(platform_dir())
        .join(executable_name())
}

fn bundled_model_manifest(resource_dir: &Path) -> PathBuf {
    resource_dir.join("models").join("model-manifest.json")
}

fn reserve_loopback_port() -> Result<u16, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|error| format!("Failed to reserve medical Engine port: {error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| format!("Failed to inspect medical Engine port: {error}"))?
        .port();
    drop(listener);
    Ok(port)
}

fn generate_shared_secret() -> String {
    rand::rng()
        .sample_iter(Alphanumeric)
        .take(64)
        .map(char::from)
        .collect()
}

fn offline_engine_sandbox_enabled() -> bool {
    cfg!(target_os = "macos")
        && std::env::var("MEDICAL_REDACT_ENGINE_BLOCK_EXTERNAL_NETWORK")
            .map(|value| matches!(value.to_ascii_lowercase().as_str(), "1" | "true" | "yes"))
            .unwrap_or(false)
}

async fn wait_until_ready(url: &str) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(1))
        .build()
        .map_err(|error| format!("Failed to build medical Engine health client: {error}"))?;

    for _ in 0..480 {
        if let Ok(response) = client.get(format!("{url}/health")).send().await {
            if response.status().is_success() {
                return Ok(());
            }
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }

    Err("Bundled medical Engine did not become ready".to_string())
}

fn monitor_engine(mut rx: tauri::async_runtime::Receiver<CommandEvent>) {
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(output) => {
                    let line = String::from_utf8_lossy(&output);
                    let line = line.trim_end();
                    if !line.is_empty() {
                        add_log(format!("🧠 Medical Engine: {line}"));
                    }
                }
                CommandEvent::Stderr(output) => {
                    let line = String::from_utf8_lossy(&output);
                    let line = line.trim_end();
                    if !line.is_empty() {
                        add_log(format!("🧠 Medical Engine stderr: {line}"));
                    }
                }
                CommandEvent::Error(error) => {
                    add_log(format!("❌ Medical Engine process error: {error}"));
                }
                CommandEvent::Terminated(payload) => {
                    add_log(format!(
                        "🧠 Medical Engine terminated with code: {:?}",
                        payload.code
                    ));
                    MEDICAL_ENGINE_PROCESS.lock().unwrap().take();
                    MEDICAL_ENGINE_RUNTIME.lock().unwrap().take();
                }
                _ => {}
            }
        }
    });
}

pub async fn start_medical_engine(
    app: tauri::AppHandle,
) -> Result<Option<MedicalEngineRuntime>, String> {
    if let Some(runtime) = MEDICAL_ENGINE_RUNTIME.lock().unwrap().clone() {
        return Ok(Some(runtime));
    }

    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| format!("Failed to resolve Tauri resource directory: {error}"))?;
    let executable = bundled_engine_path(&resource_dir);
    if !executable.is_file() {
        add_log(format!(
            "ℹ️ Bundled medical Engine is not staged at {}; continuing without packaged Engine",
            executable.display()
        ));
        return Ok(None);
    }

    let model_manifest = bundled_model_manifest(&resource_dir);
    if !model_manifest.is_file() {
        return Err(format!(
            "Bundled medical Engine exists but model manifest is missing: {}",
            model_manifest.display()
        ));
    }

    let work_dir = app_data_dir().join("medical-engine");
    std::fs::create_dir_all(&work_dir)
        .map_err(|error| format!("Failed to create medical Engine work directory: {error}"))?;

    let port = reserve_loopback_port()?;
    let shared_secret = generate_shared_secret();
    let runtime = MedicalEngineRuntime {
        url: format!("http://127.0.0.1:{port}"),
        shared_secret,
    };

    let engine_args = vec![
        "--host".to_string(),
        "127.0.0.1".to_string(),
        "--port".to_string(),
        port.to_string(),
        "--model-manifest".to_string(),
        model_manifest.to_string_lossy().into_owned(),
        "--parent-pid".to_string(),
        std::process::id().to_string(),
    ];
    let command = if offline_engine_sandbox_enabled() {
        let mut sandbox_args = vec![
            "-p".to_string(),
            MACOS_OFFLINE_SANDBOX_PROFILE.to_string(),
            executable.to_string_lossy().into_owned(),
        ];
        sandbox_args.extend(engine_args);
        add_log("🔒 Medical Engine outbound network disabled by macOS sandbox".to_string());
        app.shell()
            .command("/usr/bin/sandbox-exec")
            .args(sandbox_args)
    } else {
        app.shell().command(&executable).args(engine_args)
    };

    let (rx, child) = command
        .current_dir(&work_dir)
        .env("STIRLING_ENGINE_SHARED_SECRET", &runtime.shared_secret)
        .env("STIRLING_ENGINE_REQUIRE_AUTH", "true")
        .spawn()
        .map_err(|error| format!("Failed to spawn bundled medical Engine: {error}"))?;

    let pid = child.pid();
    *MEDICAL_ENGINE_PROCESS.lock().unwrap() = Some(child);
    *MEDICAL_ENGINE_RUNTIME.lock().unwrap() = Some(runtime.clone());
    monitor_engine(rx);

    add_log(format!(
        "🧠 Starting bundled medical Engine on {} (PID: {})",
        runtime.url, pid
    ));

    if let Err(error) = wait_until_ready(&runtime.url).await {
        add_log(format!("❌ {error}"));
        cleanup_medical_engine();
        return Err(error);
    }

    add_log("✅ Bundled medical Engine is ready".to_string());
    Ok(Some(runtime))
}

pub fn cleanup_medical_engine() {
    MEDICAL_ENGINE_RUNTIME.lock().unwrap().take();
    let child = MEDICAL_ENGINE_PROCESS.lock().unwrap().take();
    if let Some(child) = child {
        let pid = child.pid();
        add_log(format!("Stopping bundled medical Engine (PID: {pid})"));
        let _ = child.kill();
    }
}

#[cfg(test)]
mod tests {
    use super::{generate_shared_secret, reserve_loopback_port};

    #[test]
    fn shared_secret_is_process_scoped_and_non_empty() {
        let first = generate_shared_secret();
        let second = generate_shared_secret();

        assert_eq!(first.len(), 64);
        assert_eq!(second.len(), 64);
        assert_ne!(first, second);
    }

    #[test]
    fn loopback_port_reservation_returns_ephemeral_port() {
        let port = reserve_loopback_port().expect("reserve port");
        assert_ne!(port, 0);
    }
}
