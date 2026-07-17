mod ai;
mod bridge;
mod export_html;
mod history;
mod images;
mod settings;

use std::sync::Arc;

use bridge::{bridge_dispatch, AppState};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // A .md opened via "open with" / file association arrives as a CLI arg.
    let launch_file = std::env::args().skip(1).find(|a| {
        let p = std::path::Path::new(a);
        p.is_file()
            && matches!(
                p.extension()
                    .and_then(|e| e.to_str())
                    .map(|e| e.to_ascii_lowercase())
                    .as_deref(),
                Some("md") | Some("markdown") | Some("txt")
            )
    });
    let state = Arc::new(AppState::default());
    if launch_file.is_some() {
        *state.launch_file.lock().unwrap() = launch_file;
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(state)
        .setup(|app| {
            // The window starts hidden (config) and the frontend shows it once
            // painted. Fallback: reveal it after 5s so a slow/broken frontend
            // can never leave the window invisible.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(5));
                if let Some(win) = handle.get_webview_window("main") {
                    let _ = win.show();
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![bridge_dispatch])
        .run(tauri::generate_context!())
        .expect("error while running MahoDown");
}
