//! Check for newer releases on GitHub.
//!
//! Flow: GET /repos/{owner}/{repo}/releases/latest → compare tag with CARGO_PKG_VERSION.
//! Publish updates by creating a GitHub Release with tag `vX.Y.Z` and attaching
//! `MahoDown_*_x64-setup.exe` (NSIS) or the MSI.

use serde_json::{json, Value};

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

    let url = format!("https://api.github.com/repos/{GITHUB_REPO}/releases/latest");
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(12))
        .user_agent(format!("MahoDown/{current} (+https://github.com/{GITHUB_REPO})"))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .get(&url)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .map_err(|e| format!("网络错误：{e}"))?;

    let status = resp.status();
    if status.as_u16() == 404 {
        return Ok(json!({
            "ok": true,
            "configured": true,
            "currentVersion": current,
            "updateAvailable": false,
            "latestVersion": current,
            "message": format!("仓库已连接，但还没有 Release。当前 v{current}"),
            "htmlUrl": releases_url(),
            "repoUrl": repo_web_url(),
            "releasesUrl": releases_url(),
            "notes": "",
            "downloadUrl": null,
        }));
    }
    if !status.is_success() {
        let body = resp.text().unwrap_or_default();
        let snippet: String = body.chars().take(180).collect();
        return Err(format!("GitHub API {status}: {snippet}"));
    }

    let body: Value = resp.json().map_err(|e| format!("解析 Release 失败：{e}"))?;
    let tag = body
        .get("tag_name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    if tag.is_empty() {
        return Err("latest release 没有 tag_name".into());
    }
    let latest = tag.trim_start_matches('v').trim_start_matches('V');
    let html_url = body
        .get("html_url")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let notes = body
        .get("body")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let name = body
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or(tag)
        .to_string();

    // Prefer Windows installer assets when present.
    let download_url = body
        .get("assets")
        .and_then(|a| a.as_array())
        .and_then(|assets| {
            let pick = |pred: &dyn Fn(&str) -> bool| {
                assets.iter().find_map(|a| {
                    let n = a.get("name").and_then(|x| x.as_str()).unwrap_or("");
                    let u = a
                        .get("browser_download_url")
                        .and_then(|x| x.as_str())
                        .unwrap_or("");
                    if pred(n) && !u.is_empty() {
                        Some(u.to_string())
                    } else {
                        None
                    }
                })
            };
            pick(&|n| n.to_ascii_lowercase().contains("setup") && n.ends_with(".exe"))
                .or_else(|| pick(&|n| n.ends_with(".msi")))
                .or_else(|| pick(&|n| n.ends_with(".exe")))
        });

    let update_available = version_lt(current, latest);
    let message = if update_available {
        format!("发现新版本 v{latest}（当前 v{current}）")
    } else {
        format!("已是最新版本 v{current}")
    };

    Ok(json!({
        "ok": true,
        "configured": true,
        "currentVersion": current,
        "latestVersion": latest,
        "updateAvailable": update_available,
        "tagName": tag,
        "releaseName": name,
        "htmlUrl": if html_url.is_empty() { releases_url() } else { html_url },
        "downloadUrl": download_url,
        "notes": notes,
        "message": message,
        "repoUrl": repo_web_url(),
        "releasesUrl": releases_url(),
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
    use super::version_lt;

    #[test]
    fn compares_versions() {
        assert!(version_lt("0.1.5", "0.1.6"));
        assert!(version_lt("0.1.6", "v0.2.0"));
        assert!(!version_lt("0.2.0", "0.1.9"));
        assert!(!version_lt("1.0.0", "1.0.0"));
        assert!(version_lt("1.0.0", "1.0.1-beta"));
    }
}
