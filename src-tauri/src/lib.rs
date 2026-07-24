mod ai;
mod bridge;
mod export_html;
mod history;
mod images;
mod settings;
mod update;

use std::fs;
use std::path::Path;
use std::sync::Arc;

use bridge::{bridge_dispatch, AppState};
use tauri::Manager;

fn find_launch_file() -> Option<String> {
    std::env::args().skip(1).find(|a| {
        let p = Path::new(a);
        p.is_file()
            && matches!(
                p.extension()
                    .and_then(|e| e.to_str())
                    .map(|e| e.to_ascii_lowercase())
                    .as_deref(),
                Some("md") | Some("markdown") | Some("txt")
            )
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Pre-read association target before the event loop so the first IPC can
    // return document bytes without a second disk round-trip.
    let launch_file = find_launch_file();
    let launch_markdown = launch_file
        .as_ref()
        .and_then(|p| fs::read_to_string(p).ok());
    let open_on_launch = launch_file.is_some();

    let state = Arc::new(AppState::default());
    if let Some(path) = launch_file {
        *state.launch_file.lock().unwrap() = Some(path);
        *state.launch_markdown.lock().unwrap() = launch_markdown;
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(state)
        .setup(move |app| {
            if let Some(win) = app.get_webview_window("main") {
                // File-association launches should open at editor size immediately
                // (avoids welcome→editor resize flash after JS boots).
                if open_on_launch {
                    use tauri::{LogicalSize, Size};
                    let _ = win.set_size(Size::Logical(LogicalSize::new(1180.0, 760.0)));
                    let _ = win.set_min_size(Some(Size::Logical(LogicalSize::new(800.0, 520.0))));
                    let _ = win.center();
                }
                // Config may already be visible; show+focus is cheap and kills races.
                let _ = win.show();
                let _ = win.set_focus();
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![bridge_dispatch])
        .run(tauri::generate_context!())
        .expect("error while running MahoDown");
}
