//! The tauri commands the bundled control UI may call (see capabilities/main.json).

use crate::sidecar::{RpcErr, SharedSidecar, Sidecar};
use serde::Serialize;
use serde_json::{json, Value};
use std::net::TcpListener;
use std::path::{Component, Path};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State, Url, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::{Update, UpdaterExt};

#[derive(Default)]
pub struct PendingUpdate(Mutex<Option<Update>>);

fn internal(e: impl std::fmt::Display) -> RpcErr {
    RpcErr::new("internal", e.to_string(), None)
}

/// The office runs only on the loopback interface; never navigate a window or the browser elsewhere.
fn is_office_url(u: &Url) -> bool {
    u.scheme() == "http" && matches!(u.host_str(), Some("127.0.0.1") | Some("localhost"))
}

#[tauri::command]
pub async fn rpc(sc: State<'_, SharedSidecar>, method: String, params: Option<Value>) -> Result<Value, RpcErr> {
    let timeout = Sidecar::timeout_for(&method);
    sc.call(&method, params.unwrap_or_else(|| json!({})), timeout).await
}

#[derive(Serialize)]
pub struct SidecarStatus {
    down: bool,
    reason: Option<String>,
    logs: Vec<String>,
}

#[tauri::command]
pub fn sidecar_status(sc: State<'_, SharedSidecar>) -> SidecarStatus {
    let reason = sc.down_reason();
    SidecarStatus { down: reason.is_some(), reason, logs: sc.tail() }
}

#[tauri::command]
pub async fn sidecar_retry(sc: State<'_, SharedSidecar>) -> Result<(), RpcErr> {
    let sc = sc.inner().clone();
    tauri::async_runtime::spawn_blocking(move || sc.retry()).await.map_err(internal)?.map_err(|e| RpcErr::new("spawn_failed", e, None))
}

/// Opens the office paired: mints a code over RPC, then loads `<office>/#pair=<code>` in the office
/// window (or the default browser). An already open office window is just focused.
pub async fn do_open_office(app: &AppHandle, sc: &Sidecar, in_browser: bool) -> Result<(), RpcErr> {
    if !in_browser {
        if let Some(w) = app.get_webview_window("office") {
            let _ = w.show();
            let _ = w.set_focus();
            return Ok(());
        }
    }
    let pair = sc.call("pair.mint", json!({}), Sidecar::timeout_for("pair.mint")).await?;
    let base = pair.get("url").and_then(Value::as_str).ok_or_else(|| internal("pair.mint returned no url"))?;
    let code = pair.get("code").and_then(Value::as_str).ok_or_else(|| internal("pair.mint returned no code"))?;
    let full = if base.contains("#pair=") { base.to_string() } else { format!("{}/#pair={code}", base.trim_end_matches('/')) };
    let url = Url::parse(&full).map_err(|e| internal(format!("bad office url: {e}")))?;
    if !is_office_url(&url) {
        return Err(RpcErr::new("internal", format!("Refusing to open {}: the office must be on 127.0.0.1.", url.origin().ascii_serialization()), None));
    }
    if in_browser {
        return app.opener().open_url(url.as_str(), None::<&str>).map_err(internal);
    }
    WebviewWindowBuilder::new(app, "office", WebviewUrl::External(url))
        .title("tagconn office")
        .inner_size(1360.0, 860.0)
        .on_navigation(is_office_url)
        .build()
        .map_err(internal)?;
    Ok(())
}

#[tauri::command]
pub async fn open_office(app: AppHandle, sc: State<'_, SharedSidecar>, in_browser: bool) -> Result<(), RpcErr> {
    do_open_office(&app, &sc, in_browser).await
}

/// First free loopback port above `after` (for the "use next free port" fix).
#[tauri::command]
pub fn find_free_port(after: u16) -> Result<u16, RpcErr> {
    (after.saturating_add(1)..=after.saturating_add(200).min(65535))
        .find(|p| TcpListener::bind(("127.0.0.1", *p)).is_ok())
        .ok_or_else(|| RpcErr::new("port_in_use", "No free port found nearby.", Some("Close some applications and re-check.")))
}

/// Shows a file in the OS file manager (never opens/executes it). Limited to tagconn's own dirs and ~/.claude.
#[tauri::command]
pub async fn reveal_path(app: AppHandle, sc: State<'_, SharedSidecar>, path: String) -> Result<(), RpcErr> {
    let p = Path::new(&path);
    if !p.is_absolute() || p.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(RpcErr::new("invalid_request", "Not an absolute, normalised path.", None));
    }
    let info = sc.call("app.info", json!({}), Sidecar::timeout_for("app.info")).await?;
    let allowed = ["config", "state", "data", "claudeDir"].iter().filter_map(|k| info.pointer(&format!("/paths/{k}")).and_then(Value::as_str)).any(|root| p.starts_with(root));
    if !allowed {
        return Err(RpcErr::new("invalid_request", "That path is outside tagconn's folders.", None));
    }
    let target = if p.exists() { p.to_path_buf() } else { p.parent().map(Path::to_path_buf).ok_or_else(|| internal("no parent"))? };
    app.opener().reveal_item_in_dir(target).map_err(internal)
}

/// True once task G ships a real updater key and endpoint; until then the UI keeps the button disabled.
#[tauri::command]
pub fn updates_configured(app: AppHandle) -> bool {
    let Some(cfg) = app.config().plugins.0.get("updater") else { return false };
    let key = cfg.get("pubkey").and_then(Value::as_str).unwrap_or("");
    let endpoints = cfg.get("endpoints").and_then(Value::as_array).map(|a| !a.is_empty()).unwrap_or(false);
    !key.trim().is_empty() && endpoints
}

#[derive(Serialize)]
pub struct UpdateInfo {
    version: String,
    notes: Option<String>,
}

#[tauri::command]
pub async fn check_update(app: AppHandle, pending: State<'_, PendingUpdate>) -> Result<Option<UpdateInfo>, RpcErr> {
    if !updates_configured(app.clone()) {
        return Err(RpcErr::new("internal", "Updates are not configured in this build.", None));
    }
    let update = app.updater().map_err(internal)?.check().await.map_err(|e| RpcErr::new("internal", format!("Update check failed: {e}"), Some("Check your connection and try again.")))?;
    let info = update.as_ref().map(|u| UpdateInfo { version: u.version.clone(), notes: u.body.clone() });
    *pending.0.lock().unwrap() = update;
    Ok(info)
}

/// Downloads the update (signature verified by the updater), stops the services, installs and restarts.
/// A failure before the install keeps the current version running.
#[tauri::command]
pub async fn install_update(app: AppHandle, sc: State<'_, SharedSidecar>, pending: State<'_, PendingUpdate>) -> Result<(), RpcErr> {
    let update = pending.0.lock().unwrap().take().ok_or_else(|| RpcErr::new("invalid_request", "Check for updates first.", None))?;
    let bytes = update.download(|_, _| {}, || {}).await.map_err(|e| RpcErr::new("internal", format!("Download failed: {e}"), Some("The current version stays installed.")))?;
    let sidecar = sc.inner().clone();
    tauri::async_runtime::spawn_blocking(move || sidecar.shutdown()).await.map_err(internal)?;
    if let Err(e) = update.install(bytes) {
        let _ = sc.inner().clone().retry();
        return Err(RpcErr::new("internal", format!("Install failed: {e}"), Some("The current version stays installed.")));
    }
    app.restart();
}
