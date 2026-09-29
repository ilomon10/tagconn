//! System tray: Open office, Start all, Stop all, Quit.

use crate::commands::do_open_office;
use crate::sidecar::SharedSidecar;
use serde_json::{json, Value};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager};

pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// Stops the services over RPC, then the sidecar, then exits. Runs off the UI thread.
pub fn quit(app: &AppHandle, sc: &SharedSidecar) {
    let (app, sc) = (app.clone(), sc.clone());
    std::thread::spawn(move || {
        sc.shutdown();
        app.exit(0);
    });
}

fn all_ids(sc: &SharedSidecar) -> Vec<&'static str> {
    let docker = sc.call_blocking("config.get", json!({})).ok().and_then(|c| c.get("runMode").and_then(Value::as_str).map(|m| m == "docker")).unwrap_or(false);
    if docker { vec!["docker", "runner"] } else { vec!["server", "runner"] }
}

pub fn build(app: &AppHandle, sc: &SharedSidecar) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open office", true, None::<&str>)?;
    let panel = MenuItem::with_id(app, "panel", "Show control panel", true, None::<&str>)?;
    let start = MenuItem::with_id(app, "start_all", "Start all", true, None::<&str>)?;
    let stop = MenuItem::with_id(app, "stop_all", "Stop all", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &panel, &PredefinedMenuItem::separator(app)?, &start, &stop, &PredefinedMenuItem::separator(app)?, &quit_item])?;

    let mut builder = TrayIconBuilder::with_id("main").tooltip("tagconn").menu(&menu);
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    let sc = sc.clone();
    builder
        .on_menu_event(move |app, event| {
            let (app, sc) = (app.clone(), sc.clone());
            match event.id.as_ref() {
                "open" => {
                    tauri::async_runtime::spawn(async move {
                        if let Err(e) = do_open_office(&app, &sc, false).await {
                            eprintln!("open office: {}", e.message);
                            // The main window shows the error banner (e.g. the server is stopped).
                            show_main(&app);
                            let _ = app.emit_to("main", "desktop://notice", json!({ "message": e.message, "hint": e.hint }));
                        }
                    });
                }
                "panel" => show_main(&app),
                "start_all" | "stop_all" => {
                    let start = event.id.as_ref() == "start_all";
                    let method = if start { "service.start" } else { "service.stop" };
                    std::thread::spawn(move || {
                        // Stop all stops every service regardless of run mode; start follows the mode.
                        let ids = if start { all_ids(&sc) } else { vec!["server", "runner", "docker"] };
                        for id in ids {
                            if let Err(e) = sc.call_blocking(method, json!({ "id": id })) {
                                eprintln!("{method} {id}: {}", e.message);
                            }
                        }
                    });
                }
                "quit" => quit(&app, &sc),
                _ => {}
            }
        })
        .build(app)?;
    Ok(())
}
