mod commands;
mod sidecar;
mod tray;

use sidecar::{SharedSidecar, Sidecar};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{Manager, RunEvent, WindowEvent};
use tauri_plugin_autostart::MacosLauncher;

pub fn run() {
    let has_tray = Arc::new(AtomicBool::new(false));
    let tray_flag = has_tray.clone();
    let close_flag = has_tray.clone();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| tray::show_main(app)))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--autostart"])))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(commands::PendingUpdate::default())
        .invoke_handler(tauri::generate_handler![
            commands::rpc,
            commands::sidecar_status,
            commands::sidecar_retry,
            commands::open_office,
            commands::find_free_port,
            commands::reveal_path,
            commands::updates_configured,
            commands::check_update,
            commands::install_update,
            commands::set_autostart,
        ])
        .setup(move |app| {
            let sc = Sidecar::new(app.handle().clone());
            app.manage(sc.clone());
            // A failed spawn is not fatal: the UI shows the blocking panel with the reason and Retry.
            if let Err(e) = sc.spawn() {
                eprintln!("sidecar: {e}");
                sc.retry().ok();
            }
            match tray::build(app.handle(), &sc) {
                Ok(()) => tray_flag.store(true, Ordering::Relaxed),
                Err(e) => eprintln!("tray unavailable: {e}"),
            }
            // Started by the OS at login: stay in the tray.
            if tray_flag.load(Ordering::Relaxed) && std::env::args().any(|a| a == "--autostart") {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
            }
            Ok(())
        })
        .on_window_event(move |window, event| {
            // Closing the control panel keeps the services (and the tray) alive; without a tray it quits.
            if window.label() == "main" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    if close_flag.load(Ordering::Relaxed) {
                        api.prevent_close();
                        let _ = window.hide();
                    } else {
                        api.prevent_close();
                        let sc: SharedSidecar = window.state::<SharedSidecar>().inner().clone();
                        tray::quit(window.app_handle(), &sc);
                    }
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tagconn desktop");

    app.run(move |app, event| match event {
        // Last window closed (e.g. the office) while the tray keeps running: stay alive.
        RunEvent::ExitRequested { api, code: None, .. } if has_tray.load(Ordering::Relaxed) => api.prevent_exit(),
        RunEvent::Exit => {
            if let Some(sc) = app.try_state::<SharedSidecar>() {
                sc.kill();
            }
        }
        _ => {}
    });
}
