//! Check for newer releases on GitHub.
//!
//! Flow: GET /repos/{owner}/{repo}/releases/latest → compare tag with CARGO_PKG_VERSION.
//! Publish updates by creating a GitHub Release with tag `vX.Y.Z` and attaching
//! `MahoDown_*_x64-setup.exe` (NSIS) or the MSI.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use tauri::AppHandle;

/// GitHub repository in `owner/repo` form.
/// Change this when you create the public repo (e.g. `"alice/mahodown"`).
pub const GITHUB_REPO: &str = "AonagiYuna/MahoDown";

pub fn repo_web_url() -> String {
    format!("https://github.com/{GITHUB_REPO}")
}

pub fn releases_url() -> String {
    format!("https://github.com/{GITHUB_REPO}/releases")
}

fn repo_configured() -> bool {
    let r = GITHUB_REPO.trim();
    !r.is_empty()
        && !r.contains("YOUR_GITHUB")
        && r.contains('/')
        && !r.starts_with('/')
        && !r.ends_with('/')
}

/// Compare dotted semver-ish versions (ignores leading `v`, pre-release suffix after `-`).
pub fn version_lt(current: &str, latest: &str) -> bool {
    let parse = |s: &str| -> Vec<u64> {
        s.trim()
            .trim_start_matches('v')
            .trim_start_matches('V')
            .split('-')
            .next()
            .unwrap_or("")
            .split('.')
            .filter_map(|p| p.parse::<u64>().ok())
            .collect()
    };
    let a = parse(current);
    let b = parse(latest);
    let n = a.len().max(b.len());
    for i in 0..n {
        let x = a.get(i).copied().unwrap_or(0);
        let y = b.get(i).copied().unwrap_or(0);
        if x < y {
            return true;
        }
        if x > y {
            return false;
        }
    }
    false
}

struct LatestRelease {
    tag: String,
    name: String,
    notes: String,
    html_url: String,
}

fn http_client(current: &str, timeout_secs: u64) -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(timeout_secs))
        .redirect(reqwest::redirect::Policy::limited(8))
        .user_agent(format!(
            "MahoDown/{current} (+https://github.com/{GITHUB_REPO})"
        ))
        .build()
        .map_err(|e| e.to_string())
}

fn version_of_tag(tag: &str) -> &str {
    tag.trim().trim_start_matches('v').trim_start_matches('V')
}

fn setup_download_url(tag: &str, version: &str) -> String {
    let tagged = if tag.starts_with('v') || tag.starts_with('V') {
        tag.to_string()
    } else {
        format!("v{tag}")
    };
    format!("https://github.com/{GITHUB_REPO}/releases/download/{tagged}/MahoDown_{version}_x64-setup.exe")
}

fn first_atom_entry(xml: &str) -> Option<&str> {
    let start = xml.find("<entry>")?;
    let rel_end = xml[start..].find("</entry>")?;
    Some(&xml[start..start + rel_end])
}

fn tag_from_atom_entry(entry: &str) -> Option<String> {
    const KEY: &str = "/releases/tag/";
    if let Some(i) = entry.find(KEY) {
        let rest = &entry[i + KEY.len()..];
        let end = rest
            .find(|c: char| c == '"' || c == '\'' || c == '<' || c.is_whitespace())
            .unwrap_or(rest.len());
        let tag = rest[..end].trim();
        if !tag.is_empty() {
            return Some(tag.to_string());
        }
    }
    const ID: &str = "<id>";
    let i = entry.find(ID)?;
    let rest = &entry[i + ID.len()..];
    let end = rest.find("</id>").unwrap_or(rest.len());
    let id = rest[..end].trim();
    let tag = id.rsplit('/').next().unwrap_or("").trim();
    if tag.is_empty() {
        None
    } else {
        Some(tag.to_string())
    }
}

fn between<'a>(hay: &'a str, open: &str, close: &str) -> Option<&'a str> {
    let start = hay.find(open)? + open.len();
    let end = hay[start..].find(close)?;
    Some(hay[start..start + end].trim())
}

fn atom_text(raw: &str) -> String {
    let unescaped = raw
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#39;", "'");
    let mut out = String::new();
    let mut in_tag = false;
    for c in unescaped.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn parse_latest_from_atom(xml: &str) -> Result<LatestRelease, String> {
    let entry = first_atom_entry(xml).ok_or_else(|| "Releases 列表为空".to_string())?;
    let tag = tag_from_atom_entry(entry).ok_or_else(|| "无法解析版本号".to_string())?;
    let name = between(entry, "<title>", "</title>")
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| tag.clone());
    let notes = between(entry, "<content", "</content>")
        .and_then(|s| s.find('>').map(|i| atom_text(&s[i + 1..])))
        .unwrap_or_default();
    let html_url = format!("https://github.com/{GITHUB_REPO}/releases/tag/{tag}");
    Ok(LatestRelease {
        tag,
        name,
        notes,
        html_url,
    })
}

fn fetch_latest_atom(client: &reqwest::blocking::Client) -> Result<LatestRelease, String> {
    let url = format!("https://github.com/{GITHUB_REPO}/releases.atom");
    let resp = client
        .get(&url)
        .header("Accept", "application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8")
        .send()
        .map_err(|e| format!("网络错误：{e}"))?;
    if !resp.status().is_success() {
        return Err(format!("GitHub Releases {} ", resp.status()));
    }
    let xml = resp.text().map_err(|e| format!("读取 Release 失败：{e}"))?;
    parse_latest_from_atom(&xml)
}

fn fetch_latest_api(client: &reqwest::blocking::Client) -> Result<LatestRelease, String> {
    let url = format!("https://api.github.com/repos/{GITHUB_REPO}/releases/latest");
    let resp = client
        .get(&url)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .map_err(|e| format!("网络错误：{e}"))?;
    let status = resp.status();
    if status.as_u16() == 404 {
        return Err("还没有 Release".into());
    }
    if !status.is_success() {
        let body = resp.text().unwrap_or_default();
        let snippet: String = body.chars().take(120).collect();
        return Err(format!("GitHub API {status}: {snippet}"));
    }
    let body: Value = resp.json().map_err(|e| format!("解析 Release 失败：{e}"))?;
    let tag = body
        .get("tag_name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if tag.is_empty() {
        return Err("latest release 没有 tag_name".into());
    }
    let name = body
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or(&tag)
        .to_string();
    let notes = body
        .get("body")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let html_url = body
        .get("html_url")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("https://github.com/{GITHUB_REPO}/releases/tag/{tag}"));
    Ok(LatestRelease {
        tag,
        name,
        notes,
        html_url,
    })
}

pub fn check_update() -> Result<Value, String> {
    let current = env!("CARGO_PKG_VERSION");
    if !repo_configured() {
        return Ok(json!({
            "ok": false,
            "configured": false,
            "currentVersion": current,
            "message": "尚未配置 GitHub 仓库。请在 src-tauri/src/update.rs 中设置 GITHUB_REPO（owner/repo），并推送 Release。",
            "repoUrl": null,
            "releasesUrl": null,
        }));
    }

    let client = match http_client(current, 15) {
        Ok(c) => c,
        Err(e) => {
            return Ok(json!({
                "ok": false,
                "configured": true,
                "currentVersion": current,
                "message": format!("无法发起网络请求：{e}"),
                "htmlUrl": releases_url(),
                "repoUrl": repo_web_url(),
                "releasesUrl": releases_url(),
                "downloadUrl": null,
            }));
        }
    };

    // Atom feed first: api.github.com is frequently 403 without a token.
    let latest = fetch_latest_atom(&client).or_else(|_| fetch_latest_api(&client));
    let info = match latest {
        Ok(info) => info,
        Err(e) => {
            return Ok(json!({
                "ok": false,
                "configured": true,
                "currentVersion": current,
                "updateAvailable": false,
                "message": format!("检查失败：{e}。可手动打开 Releases 页面。"),
                "htmlUrl": releases_url(),
                "repoUrl": repo_web_url(),
                "releasesUrl": releases_url(),
                "downloadUrl": null,
            }));
        }
    };

    let tag = info.tag.trim();
    let ver = version_of_tag(tag);
    let update_available = version_lt(current, ver);
    let message = if update_available {
        format!("发现新版本 v{ver}（当前 v{current}）")
    } else {
        format!("已是最新版本 v{current}")
    };

    Ok(json!({
        "ok": true,
        "configured": true,
        "currentVersion": current,
        "latestVersion": ver,
        "updateAvailable": update_available,
        "tagName": tag,
        "releaseName": info.name,
        "htmlUrl": info.html_url,
        "downloadUrl": setup_download_url(tag, ver),
        "notes": info.notes,
        "message": message,
        "repoUrl": repo_web_url(),
        "releasesUrl": releases_url(),
    }))
}

fn download_url_allowed(url: &str) -> bool {
    let u = url.to_ascii_lowercase();
    u.starts_with("https://")
        && (u.contains("github.com/") || u.contains("githubusercontent.com/"))
}

fn download_installer(
    client: &reqwest::blocking::Client,
    url: &str,
    version: &str,
) -> Result<PathBuf, String> {
    if !download_url_allowed(url) {
        return Err("下载地址不合法".into());
    }
    let resp = client
        .get(url)
        .send()
        .map_err(|e| format!("下载失败：{e}"))?;
    if !resp.status().is_success() {
        return Err(format!("下载失败 HTTP {}", resp.status()));
    }
    let bytes = resp.bytes().map_err(|e| format!("读取安装包失败：{e}"))?;
    if bytes.len() < 80_000 {
        return Err("安装包过小，可能下载不完整".into());
    }
    if bytes.len() < 2 || bytes[0] != b'M' || bytes[1] != b'Z' {
        return Err("下载的不是 Windows 安装程序".into());
    }
    let path = std::env::temp_dir().join(format!("MahoDown_{version}_x64-setup.exe"));
    fs::write(&path, &bytes).map_err(|e| format!("无法保存安装包：{e}"))?;
    Ok(path)
}

fn launch_installer(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new(path)
            .spawn()
            .map_err(|e| format!("无法启动安装程序：{e}"))?;
        return Ok(());
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = path;
        Err("当前平台请从 Releases 手动安装".into())
    }
}

/// Re-fetch latest, compare versions, download installer, launch it, then quit.
pub fn apply_update(app: &AppHandle) -> Result<Value, String> {
    let current = env!("CARGO_PKG_VERSION");
    if !repo_configured() {
        return Err("尚未配置 GitHub 仓库".into());
    }
    let client = http_client(current, 180)?;
    let info = fetch_latest_atom(&client).or_else(|_| fetch_latest_api(&client))?;
    let tag = info.tag.trim();
    let latest = version_of_tag(tag);
    if !version_lt(current, latest) {
        return Ok(json!({
            "ok": false,
            "skipped": true,
            "currentVersion": current,
            "latestVersion": latest,
            "message": format!("当前已是最新版本 v{current}（最新 v{latest}）"),
        }));
    }

    let url = setup_download_url(tag, latest);
    let path = download_installer(&client, &url, latest)?;
    launch_installer(&path)?;
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(700));
        app.exit(0);
    });
    Ok(json!({
        "ok": true,
        "installing": true,
        "currentVersion": current,
        "latestVersion": latest,
        "message": format!("正在安装 v{latest}，应用即将退出"),
    }))
}

pub fn open_external(url: &str) -> Result<(), String> {
    let url = url.trim();
    if url.is_empty() {
        return Err("URL 为空".into());
    }
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("只允许打开 http(s) 链接".into());
    }

    #[cfg(target_os = "windows")]
    {
        // empty title arg required so `start` treats the next token as URL
        std::process::Command::new("cmd")
            .args(["/C", "start", "", url])
            .spawn()
            .map_err(|e| format!("无法打开浏览器：{e}"))?;
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(url)
            .spawn()
            .map_err(|e| format!("无法打开浏览器：{e}"))?;
        return Ok(());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(url)
            .spawn()
            .map_err(|e| format!("无法打开浏览器：{e}"))?;
        return Ok(());
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", unix)))]
    {
        let _ = url;
        Err("当前平台不支持打开外部链接".into())
    }
}

#[cfg(test)]
mod tests {
    use super::{parse_latest_from_atom, version_lt};

    #[test]
    fn compares_versions() {
        assert!(version_lt("0.1.5", "0.1.6"));
        assert!(version_lt("0.1.6", "v0.2.0"));
        assert!(!version_lt("0.2.0", "0.1.9"));
        assert!(!version_lt("1.0.0", "1.0.0"));
        assert!(version_lt("1.0.0", "1.0.1-beta"));
        assert!(version_lt("0.1.9", "0.1.10"));
        assert!(!version_lt("0.1.10", "0.1.9"));
        assert!(!version_lt("0.1.10", "0.1.10"));
        assert!(version_lt("v0.1.8", "0.1.9"));
    }

    #[test]
    fn parses_atom_latest_tag() {
        let xml = r#"<?xml version="1.0"?>
<feed>
  <entry>
    <id>tag:github.com,2008:Repository/1/v0.1.8</id>
    <link rel="alternate" href="https://github.com/AonagiYuna/MahoDown/releases/tag/v0.1.8"/>
    <title>MahoDown 0.1.8</title>
    <content type="html">&lt;p&gt;fix window flash&lt;/p&gt;</content>
  </entry>
</feed>"#;
        let latest = parse_latest_from_atom(xml).expect("parse");
        assert_eq!(latest.tag, "v0.1.8");
        assert_eq!(latest.name, "MahoDown 0.1.8");
        assert!(latest.notes.contains("fix window flash"));
    }
}
