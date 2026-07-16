use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::{DialogExt, FilePath};

use crate::ai;
use crate::export_html;
use crate::history;
use crate::images;
use crate::settings::{
    load_settings, merge_settings, remember_recent, save_settings, set_secret, settings_to_json,
};

pub struct AppState {
    pub current_file: Mutex<Option<String>>,
    pub is_dirty: Mutex<bool>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            current_file: Mutex::new(None),
            is_dirty: Mutex::new(false),
        }
    }
}

#[tauri::command]
pub async fn bridge_dispatch(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    command: String,
    payload: Value,
) -> Result<Value, String> {
    let state = Arc::clone(state.inner());
    let app2 = app.clone();
    tokio::task::spawn_blocking(move || dispatch_sync(&app2, &state, &command, payload))
        .await
        .map_err(|e| e.to_string())?
}

fn dispatch_sync(
    app: &AppHandle,
    state: &AppState,
    command: &str,
    payload: Value,
) -> Result<Value, String> {
    match command {
        "app:editorReady" => Ok(json!({ "isReady": true, "captionInsetPx": 0 })),
        "app:setDirtyState" => {
            let dirty = payload
                .get("isDirty")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            *state.is_dirty.lock().unwrap() = dirty;
            update_title(app, state);
            Ok(json!({ "ok": true }))
        }
        "app:getSettings" => {
            let s = load_settings();
            Ok(ai::merge_ai_into_settings_json(settings_to_json(&s), &s))
        }
        "app:updateSettings" => {
            let mut merged = merge_settings(load_settings(), &payload);
            // AI key via secret store
            if let Some(key) = payload.get("aiApiKey").and_then(|v| v.as_str()) {
                if !key.is_empty() && key != "********" {
                    set_secret("ai", "token", key)?;
                }
            }
            if let Some(v) = payload.get("aiBaseUrl").and_then(|x| x.as_str()) {
                merged.ai_base_url = v.trim().to_string();
            }
            if let Some(v) = payload.get("aiModel").and_then(|x| x.as_str()) {
                merged.ai_model = v.trim().to_string();
            }
            save_settings(&merged)?;
            Ok(ai::merge_ai_into_settings_json(settings_to_json(&merged), &merged))
        }
        "ai:complete" => {
            let action = payload
                .get("action")
                .and_then(|v| v.as_str())
                .unwrap_or("polish");
            let text = payload
                .get("text")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let context = payload
                .get("context")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let content = ai::complete(action, text, context)?;
            Ok(json!({ "content": content, "action": action }))
        }
        "ai:presets" => Ok(json!({ "presets": ai::presets() })),
        "app:getRecentFiles" => {
            let s = load_settings();
            let items: Vec<Value> = s
                .recent_files
                .iter()
                .filter(|p| Path::new(p).exists())
                .map(|p| {
                    let name = Path::new(p)
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or(p)
                        .to_string();
                    let mtime = fs::metadata(p)
                        .and_then(|m| m.modified())
                        .map(|t| {
                            let dt: chrono::DateTime<chrono::Utc> = t.into();
                            dt.to_rfc3339()
                        })
                        .unwrap_or_default();
                    json!({ "filePath": p, "fileName": name, "lastWriteTime": mtime })
                })
                .collect();
            Ok(json!({ "items": items }))
        }
        "app:setSecret" => {
            let host_id = payload
                .get("hostId")
                .and_then(|v| v.as_str())
                .ok_or("hostId required")?;
            let key = payload
                .get("key")
                .and_then(|v| v.as_str())
                .unwrap_or("secret");
            let value = payload
                .get("value")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            set_secret(host_id, key, value)?;
            Ok(json!({ "ok": true }))
        }
        "file:new" => {
            *state.current_file.lock().unwrap() = None;
            *state.is_dirty.lock().unwrap() = false;
            update_title(app, state);
            Ok(json!({
                "markdown": "# 未命名文档\n\n开始书写…\n",
                "filePath": null,
                "isDirty": false
            }))
        }
        "file:open" => open_file(app, state, payload.get("filePath").and_then(|v| v.as_str())),
        "file:save" => save_file(app, state, &payload, false),
        "file:saveAs" => save_file(app, state, &payload, true),
        "file:readAsset" => {
            let rel = payload
                .get("relativePath")
                .and_then(|v| v.as_str())
                .ok_or("relativePath required")?;
            let doc = state.current_file.lock().unwrap().clone();
            images::read_asset(doc.as_deref(), rel)
        }
        "temp:writeFile" => {
            let name = payload
                .get("originalFileName")
                .and_then(|v| v.as_str())
                .unwrap_or("image.png");
            let b64 = payload
                .get("base64")
                .and_then(|v| v.as_str())
                .ok_or("base64 required")?;
            Ok(json!(images::write_temp_file(name, b64)?))
        }
        "image:upload" => {
            let settings = load_settings();
            let source = payload
                .get("sourcePath")
                .and_then(|v| v.as_str())
                .ok_or("sourcePath required")?;
            let name = payload
                .get("originalFileName")
                .and_then(|v| v.as_str())
                .unwrap_or("image.png");
            let ct = payload
                .get("contentType")
                .and_then(|v| v.as_str())
                .unwrap_or("application/octet-stream");
            let doc = payload
                .get("documentPath")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .or_else(|| state.current_file.lock().unwrap().clone());
            let host = payload.get("hostId").and_then(|v| v.as_str());
            images::upload_image(&settings, source, name, ct, doc.as_deref(), host)
        }
        "provider:testConnection" => {
            let host = payload
                .get("hostId")
                .and_then(|v| v.as_str())
                .ok_or("hostId required")?;
            let (ok, message) = images::test_connection(&load_settings(), host)?;
            Ok(json!({ "ok": ok, "message": message }))
        }
        "history:list" => {
            let path = payload
                .get("filePath")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .or_else(|| state.current_file.lock().unwrap().clone());
            Ok(json!({ "items": history::list_snapshots(path.as_deref())? }))
        }
        "history:save" => {
            let md = payload
                .get("markdown")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let kind = payload
                .get("kind")
                .and_then(|v| v.as_str())
                .unwrap_or("manual");
            let path = payload
                .get("filePath")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .or_else(|| state.current_file.lock().unwrap().clone());
            let info = history::save_snapshot(path.as_deref(), md, kind)?;
            Ok(serde_json::to_value(info).unwrap_or(json!({})))
        }
        "history:load" => {
            let id = payload
                .get("id")
                .and_then(|v| v.as_str())
                .ok_or("id required")?;
            let path = state.current_file.lock().unwrap().clone();
            Ok(json!({ "markdown": history::load_snapshot(path.as_deref(), id)? }))
        }
        "export:file" => export_file(app, &payload),
        "print:document" => print_document(&payload),
        other => Err(format!("Unknown command: {other}")),
    }
}

fn print_document(_payload: &Value) -> Result<Value, String> {
    // Printing is handled in-app (iframe + system print dialog) for correct images/layout.
    Ok(json!({
        "ok": true,
        "note": "请使用前端应用内打印"
    }))
}

fn update_title(app: &AppHandle, state: &AppState) {
    let dirty = *state.is_dirty.lock().unwrap();
    let path = state.current_file.lock().unwrap().clone();
    let name = path
        .as_ref()
        .and_then(|p| Path::new(p).file_name())
        .and_then(|n| n.to_str())
        .unwrap_or("未命名.md");
    let title = if dirty {
        format!("MahoDown — {name} •")
    } else {
        format!("MahoDown — {name}")
    };
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.set_title(&title);
    }
}

fn open_file(app: &AppHandle, state: &AppState, explicit: Option<&str>) -> Result<Value, String> {
    let path = if let Some(p) = explicit {
        PathBuf::from(p)
    } else {
        match app
            .dialog()
            .file()
            .add_filter("Markdown", &["md", "markdown", "txt"])
            .blocking_pick_file()
        {
            Some(FilePath::Path(p)) => p,
            Some(_) => return Err("不支持的路径类型".into()),
            None => return Ok(json!({ "cancelled": true })),
        }
    };
    let markdown = fs::read_to_string(&path).map_err(|e| format!("打开失败: {e}"))?;
    let path_str = path.to_string_lossy().to_string();
    *state.current_file.lock().unwrap() = Some(path_str.clone());
    *state.is_dirty.lock().unwrap() = false;
    let mut settings = load_settings();
    remember_recent(&mut settings, &path_str);
    let _ = save_settings(&settings);
    update_title(app, state);
    Ok(json!({
        "markdown": ensure_nl(&markdown),
        "filePath": path_str,
        "isDirty": false
    }))
}

fn save_file(
    app: &AppHandle,
    state: &AppState,
    payload: &Value,
    force_as: bool,
) -> Result<Value, String> {
    let markdown = payload
        .get("markdown")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let mut path = state.current_file.lock().unwrap().clone();
    if force_as || path.is_none() {
        let suggested = path
            .as_ref()
            .and_then(|p| Path::new(p).file_name())
            .and_then(|n| n.to_str())
            .unwrap_or("未命名.md");
        match app
            .dialog()
            .file()
            .add_filter("Markdown", &["md"])
            .set_file_name(suggested)
            .blocking_save_file()
        {
            Some(FilePath::Path(p)) => {
                let p = if p.extension().is_none() {
                    p.with_extension("md")
                } else {
                    p
                };
                path = Some(p.to_string_lossy().to_string());
            }
            Some(_) => return Err("不支持的路径类型".into()),
            None => return Ok(json!({ "cancelled": true })),
        }
    }
    let path_str = path.ok_or("无保存路径")?;
    let content = ensure_nl(markdown);
    fs::write(&path_str, content.as_bytes()).map_err(|e| format!("保存失败: {e}"))?;
    *state.current_file.lock().unwrap() = Some(path_str.clone());
    *state.is_dirty.lock().unwrap() = false;
    let mut settings = load_settings();
    remember_recent(&mut settings, &path_str);
    let _ = save_settings(&settings);
    let _ = history::save_snapshot(Some(&path_str), &content, "manual-save");
    update_title(app, state);
    Ok(json!({
        "filePath": path_str,
        "markdown": content,
        "isDirty": false,
        "saved": true
    }))
}

fn export_file(app: &AppHandle, payload: &Value) -> Result<Value, String> {
    let format = payload
        .get("format")
        .and_then(|v| v.as_str())
        .unwrap_or("html")
        .to_lowercase();
    let markdown = payload
        .get("markdown")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let title = payload
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("导出");
    let dark = payload
        .get("dark")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let (filter_name, exts, default_ext) = match format.as_str() {
        "html" => ("HTML", vec!["html"], "html"),
        "pdf" => ("PDF", vec!["pdf"], "pdf"),
        "word" => ("Word", vec!["docx"], "docx"),
        "png" => ("PNG", vec!["png"], "png"),
        _ => return Err("不支持的导出格式。".into()),
    };

    let path = match app
        .dialog()
        .file()
        .add_filter(filter_name, &exts)
        .set_file_name(&format!("{title}.{default_ext}"))
        .blocking_save_file()
    {
        Some(FilePath::Path(p)) => p,
        Some(_) => return Err("不支持的路径类型".into()),
        None => return Ok(json!({ "cancelled": true })),
    };

    match format.as_str() {
        "html" => export_html::export_html(&path, title, markdown, dark)?,
        "word" => write_simple_docx(&path, title, markdown)?,
        "pdf" | "png" => {
            // Save print-ready HTML next to chosen path (user can open later).
            // Prefer in-app Ctrl+P for actual print / Save as PDF.
            let html_path = if path.extension().and_then(|e| e.to_str()) == Some("html") {
                path.clone()
            } else {
                path.with_extension("html")
            };
            export_html::export_html(&html_path, title, markdown, dark)?;
            return Ok(json!({
                "filePath": html_path.to_string_lossy(),
                "format": "html",
                "note": if format == "pdf" {
                    "已保存打印用 HTML。建议用 Ctrl+P，打印机选「Microsoft Print to PDF」"
                } else {
                    "已保存预览 HTML。截图或 Ctrl+P 导出图片更稳妥"
                }
            }));
        }
        _ => {}
    }

    Ok(json!({ "filePath": path.to_string_lossy(), "format": format }))
}

fn write_simple_docx(path: &Path, title: &str, markdown: &str) -> Result<(), String> {
    use std::io::Write;
    let file = fs::File::create(path).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipWriter::new(file);
    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    zip.start_file("[Content_Types].xml", opts)
        .map_err(|e| e.to_string())?;
    zip.write_all(
        br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>"#,
    )
    .map_err(|e| e.to_string())?;

    zip.start_file("_rels/.rels", opts)
        .map_err(|e| e.to_string())?;
    zip.write_all(
        br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>"#,
    )
    .map_err(|e| e.to_string())?;

    zip.start_file("word/_rels/document.xml.rels", opts)
        .map_err(|e| e.to_string())?;
    zip.write_all(
        br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>"#,
    )
    .map_err(|e| e.to_string())?;

    zip.start_file("word/styles.xml", opts)
        .map_err(|e| e.to_string())?;
    zip.write_all(
        br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style>
</w:styles>"#,
    )
    .map_err(|e| e.to_string())?;

    let mut body = String::new();
    body.push_str(&para_styled(title, "Heading1"));
    let mut in_code = false;
    let mut code = String::new();
    for line in markdown.replace("\r\n", "\n").lines() {
        if line.starts_with("```") {
            if in_code {
                body.push_str(&para_styled(&code, "Normal"));
                code.clear();
                in_code = false;
            } else {
                in_code = true;
            }
            continue;
        }
        if in_code {
            code.push_str(line);
            code.push('\n');
            continue;
        }
        if line.trim().is_empty() {
            continue;
        }
        if let Some(rest) = line.strip_prefix("### ") {
            body.push_str(&para_styled(rest, "Heading3"));
        } else if let Some(rest) = line.strip_prefix("## ") {
            body.push_str(&para_styled(rest, "Heading2"));
        } else if let Some(rest) = line.strip_prefix("# ") {
            body.push_str(&para_styled(rest, "Heading1"));
        } else if let Some(rest) = line.strip_prefix("- ").or_else(|| line.strip_prefix("* ")) {
            body.push_str(&para_styled(&format!("• {rest}"), "Normal"));
        } else {
            body.push_str(&para_styled(line, "Normal"));
        }
    }
    let document = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>{body}<w:sectPr/></w:body>
</w:document>"#
    );
    zip.start_file("word/document.xml", opts)
        .map_err(|e| e.to_string())?;
    zip.write_all(document.as_bytes())
        .map_err(|e| e.to_string())?;
    zip.finish().map_err(|e| e.to_string())?;
    Ok(())
}

fn para_styled(text: &str, style: &str) -> String {
    format!(
        r#"<w:p><w:pPr><w:pStyle w:val="{style}"/></w:pPr><w:r><w:t xml:space="preserve">{}</w:t></w:r></w:p>"#,
        xml_esc(text)
    )
}

fn xml_esc(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn ensure_nl(s: &str) -> String {
    let n = s.replace("\r\n", "\n").replace('\r', "\n");
    if n.ends_with('\n') {
        n
    } else {
        format!("{n}\n")
    }
}
