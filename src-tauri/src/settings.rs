use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    #[serde(default = "default_theme")]
    pub theme: String,
    #[serde(default = "default_mode")]
    pub default_mode: String,
    #[serde(default = "default_host")]
    pub default_image_host: String,
    #[serde(default = "default_font")]
    pub font_size: f64,
    #[serde(default = "default_line_height")]
    pub line_height: f64,
    #[serde(default = "default_line_width")]
    pub line_width: String,
    #[serde(default = "default_true")]
    pub auto_pair_brackets: bool,
    #[serde(default = "default_true")]
    pub expand_markdown_on_caret: bool,
    #[serde(default = "default_true")]
    pub strip_paste_formatting: bool,
    #[serde(default)]
    pub auto_space_cjk: bool,
    #[serde(default = "default_snapshot_minutes")]
    pub auto_snapshot_minutes: i32,
    #[serde(default = "default_true")]
    pub follow_system_accent: bool,
    #[serde(default = "default_true")]
    pub paste_upload_images: bool,
    #[serde(default = "default_true")]
    pub keep_local_on_upload_failure: bool,
    #[serde(default)]
    pub recent_files: Vec<String>,
    #[serde(default)]
    pub image_host_configs: HashMap<String, HashMap<String, String>>,
    #[serde(default = "default_ui_scale")]
    pub ui_scale: f64,
    /// OpenAI-compatible API base, e.g. https://api.deepseek.com/v1
    #[serde(default = "default_ai_base")]
    pub ai_base_url: String,
    #[serde(default = "default_ai_model")]
    pub ai_model: String,
}

fn default_ui_scale() -> f64 {
    1.0
}
fn default_ai_base() -> String {
    "https://api.deepseek.com/v1".into()
}
fn default_ai_model() -> String {
    "deepseek-chat".into()
}

fn default_theme() -> String {
    "system".into()
}
fn default_mode() -> String {
    "rich".into()
}
fn default_host() -> String {
    "local".into()
}
fn default_font() -> f64 {
    15.0
}
fn default_line_height() -> f64 {
    1.9
}
fn default_line_width() -> String {
    "standard".into()
}
fn default_true() -> bool {
    true
}
fn default_snapshot_minutes() -> i32 {
    30
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            theme: default_theme(),
            default_mode: default_mode(),
            default_image_host: default_host(),
            font_size: default_font(),
            line_height: default_line_height(),
            line_width: default_line_width(),
            auto_pair_brackets: true,
            expand_markdown_on_caret: true,
            strip_paste_formatting: true,
            auto_space_cjk: false,
            auto_snapshot_minutes: 30,
            follow_system_accent: true,
            paste_upload_images: true,
            keep_local_on_upload_failure: true,
            recent_files: vec![],
            image_host_configs: HashMap::new(),
            ui_scale: 1.0,
            ai_base_url: default_ai_base(),
            ai_model: default_ai_model(),
        }
    }
}

pub fn app_data_dir() -> PathBuf {
    let base = dirs::data_local_dir().unwrap_or_else(|| PathBuf::from("."));
    let dir = base.join("MahoDown");
    let _ = fs::create_dir_all(&dir);
    dir
}

pub fn settings_path() -> PathBuf {
    app_data_dir().join("settings.json")
}

pub fn secrets_dir() -> PathBuf {
    let dir = app_data_dir().join("secrets");
    let _ = fs::create_dir_all(&dir);
    dir
}

pub fn snapshots_dir() -> PathBuf {
    let dir = app_data_dir().join("Snapshots");
    let _ = fs::create_dir_all(&dir);
    dir
}

pub fn load_settings() -> AppSettings {
    let path = settings_path();
    match fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
        Err(_) => AppSettings::default(),
    }
}

pub fn save_settings(settings: &AppSettings) -> Result<(), String> {
    let path = settings_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    fs::write(path, text).map_err(|e| e.to_string())
}

pub fn settings_to_json(settings: &AppSettings) -> Value {
    serde_json::to_value(settings).unwrap_or(json!({}))
}

pub fn merge_settings(mut current: AppSettings, patch: &Value) -> AppSettings {
    if let Some(obj) = patch.as_object() {
        apply_string(obj, "theme", &mut current.theme);
        if let Some(v) = obj.get("defaultMode").and_then(|x| x.as_str()) {
            if matches!(v, "src" | "split" | "rich") {
                current.default_mode = v.to_string();
            }
        }
        apply_string(obj, "defaultImageHost", &mut current.default_image_host);
        apply_f64(obj, "fontSize", &mut current.font_size);
        apply_f64(obj, "lineHeight", &mut current.line_height);
        apply_string(obj, "lineWidth", &mut current.line_width);
        apply_bool(obj, "autoPairBrackets", &mut current.auto_pair_brackets);
        apply_bool(obj, "expandMarkdownOnCaret", &mut current.expand_markdown_on_caret);
        apply_bool(obj, "stripPasteFormatting", &mut current.strip_paste_formatting);
        apply_bool(obj, "autoSpaceCjk", &mut current.auto_space_cjk);
        if let Some(v) = obj.get("autoSnapshotMinutes").and_then(|x| x.as_i64()) {
            current.auto_snapshot_minutes = v as i32;
        }
        apply_bool(obj, "followSystemAccent", &mut current.follow_system_accent);
        apply_bool(obj, "pasteUploadImages", &mut current.paste_upload_images);
        apply_bool(obj, "keepLocalOnUploadFailure", &mut current.keep_local_on_upload_failure);
        apply_f64(obj, "uiScale", &mut current.ui_scale);
        apply_string(obj, "aiBaseUrl", &mut current.ai_base_url);
        apply_string(obj, "aiModel", &mut current.ai_model);
        if let Some(hosts) = obj.get("imageHostConfigs") {
            if let Ok(map) = serde_json::from_value::<HashMap<String, HashMap<String, String>>>(hosts.clone())
            {
                current.image_host_configs = map;
            }
        }
        if let Some(recent) = obj.get("recentFiles") {
            if let Ok(list) = serde_json::from_value::<Vec<String>>(recent.clone()) {
                // empty array from frontend means "don't clobber" in old app; keep existing if empty patch intent
                if !list.is_empty() {
                    current.recent_files = list;
                }
            }
        }
    }
    current
}

fn apply_string(obj: &Map<String, Value>, key: &str, target: &mut String) {
    if let Some(v) = obj.get(key).and_then(|x| x.as_str()) {
        *target = v.to_string();
    }
}

fn apply_bool(obj: &Map<String, Value>, key: &str, target: &mut bool) {
    if let Some(v) = obj.get(key).and_then(|x| x.as_bool()) {
        *target = v;
    }
}

fn apply_f64(obj: &Map<String, Value>, key: &str, target: &mut f64) {
    if let Some(v) = obj.get(key).and_then(|x| x.as_f64()) {
        *target = v;
    }
}

pub fn remember_recent(settings: &mut AppSettings, path: &str) {
    settings.recent_files.retain(|p| !p.eq_ignore_ascii_case(path));
    settings.recent_files.insert(0, path.to_string());
    settings.recent_files.truncate(20);
}

pub fn set_secret(host_id: &str, key: &str, value: &str) -> Result<(), String> {
    if value.is_empty() || value == "********" {
        return Ok(());
    }
    let name = format!("{host_id}_{key}");
    let path = secrets_dir().join(name);
    // Simple obfuscation (not DPAPI); good enough for local beta. Upgrade later.
    let encoded = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, value.as_bytes());
    fs::write(path, encoded).map_err(|e| e.to_string())
}

pub fn get_secret(host_id: &str, key: &str) -> Option<String> {
    let name = format!("{host_id}_{key}");
    let path = secrets_dir().join(name);
    let bytes = fs::read(path).ok()?;
    let text = String::from_utf8(bytes).ok()?;
    let decoded = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, text.trim()).ok()?;
    String::from_utf8(decoded).ok()
}

pub fn resolve_host_config(settings: &AppSettings, host_id: &str) -> HashMap<String, String> {
    let mut map = settings
        .image_host_configs
        .get(host_id)
        .cloned()
        .unwrap_or_default();
    for key in ["token", "secretKey", "accessKey", "secret"] {
        if map.get(key).map(|s| s.as_str()) == Some("********") {
            map.remove(key);
        }
    }
    if let Some(secret) = get_secret(host_id, "secret") {
        match host_id {
            "github" | "smms" | "custom" => {
                map.insert("token".into(), secret);
            }
            "s3" => {
                map.insert("secretKey".into(), secret);
            }
            _ => {}
        }
    }
    if host_id == "s3" {
        if let Some(ak) = get_secret("s3", "accessKey") {
            map.insert("accessKey".into(), ak);
        }
    }
    map
}
