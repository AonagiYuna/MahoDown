mod ai;
mod bridge;
mod export_html;
mod history;
mod images;
mod settings;

use std::sync::Arc;

use bridge::{bridge_dispatch, AppState};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(Arc::new(AppState::default()))
        .invoke_handler(tauri::generate_handler![bridge_dispatch])
        .run(tauri::generate_context!())
        .expect("error while running MahoDown");
}
