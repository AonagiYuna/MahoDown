use base64::Engine;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::collections::HashSet;

use crate::settings::{resolve_host_config, AppSettings};

static ISSUED_TEMP: Mutex<Option<HashSet<PathBuf>>> = Mutex::new(None);

fn issued() -> std::sync::MutexGuard<'static, Option<HashSet<PathBuf>>> {
    ISSUED_TEMP.lock().unwrap()
}

pub fn write_temp_file(original_file_name: &str, base64: &str) -> Result<String, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64.trim())
        .map_err(|_| "invalid base64".to_string())?;
    let ext = Path::new(original_file_name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("bin");
    let dir = std::env::temp_dir().join("MahoDown").join("upload");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let name = format!("{}.{}", uuid::Uuid::new_v4(), ext);
    let path = dir.join(name);
    fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    let mut guard = issued();
    guard.get_or_insert_with(HashSet::new).insert(path.clone());
    Ok(path.to_string_lossy().to_string())
}

fn claim_temp(path: &Path) -> bool {
    let mut guard = issued();
    if let Some(set) = guard.as_mut() {
        set.remove(path)
    } else {
        false
    }
}

pub fn upload_image(
    settings: &AppSettings,
    source_path: &str,
    original_file_name: &str,
    content_type: &str,
    document_path: Option<&str>,
    host_id: Option<&str>,
) -> Result<serde_json::Value, String> {
    let path = PathBuf::from(source_path);
    if !claim_temp(&path) {
        return Err("Image upload payload is invalid.".into());
    }
    let host = host_id
        .filter(|s| !s.is_empty())
        .unwrap_or(settings.default_image_host.as_str());
    let result = match host {
        "local" => upload_local(&path, original_file_name, document_path),
        "github" => upload_github(settings, &path, original_file_name, content_type),
        "smms" => upload_smms(settings, &path, original_file_name),
        "picgo" => upload_picgo(settings, &path),
        "custom" => upload_custom(settings, &path, original_file_name, content_type),
        "s3" => upload_s3(settings, &path, original_file_name, content_type),
        other => Err(format!("未知图床: {other}")),
    };
    let _ = fs::remove_file(&path);
    result
}

fn upload_local(
    source: &Path,
    original_file_name: &str,
    document_path: Option<&str>,
) -> Result<serde_json::Value, String> {
    let doc = document_path.ok_or("请先保存 Markdown 文件，再上传图片。")?;
    let doc_dir = Path::new(doc)
        .parent()
        .ok_or("无法解析文档目录")?;
    let img_dir = doc_dir.join("img");
    fs::create_dir_all(&img_dir).map_err(|e| e.to_string())?;
    let bytes = fs::read(source).map_err(|e| e.to_string())?;
    let hash = &hex::encode(Sha256::digest(&bytes))[..16];
    let ext = Path::new(original_file_name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("png");
    let file_name = format!("{hash}.{ext}");
    let dest = img_dir.join(&file_name);
    fs::write(&dest, &bytes).map_err(|e| e.to_string())?;
    let rel = format!("img/{file_name}");
    Ok(serde_json::json!({
        "objectPath": rel,
        "markdownUrl": rel,
        "contentType": mime_guess::from_path(&dest).first_or_octet_stream().essence_str(),
        "size": bytes.len()
    }))
}

fn upload_github(
    settings: &AppSettings,
    source: &Path,
    original_file_name: &str,
    content_type: &str,
) -> Result<serde_json::Value, String> {
    let cfg = resolve_host_config(settings, "github");
    let token = cfg.get("token").ok_or("请配置 GitHub Token")?;
    // Accept either owner+repo or single "owner/repo" field from UI.
    let (owner, repo) = parse_owner_repo(&cfg)?;
    let branch = cfg.get("branch").map(|s| s.as_str()).unwrap_or("main");
    let bytes = fs::read(source).map_err(|e| e.to_string())?;
    let hash = &hex::encode(Sha256::digest(&bytes))[..12];
    let ext = Path::new(original_file_name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("png");
    let filename = format!("{hash}.{ext}");
    let raw_template = cfg
        .get("pathTemplate")
        .or_else(|| cfg.get("path"))
        .map(|s| s.as_str())
        .unwrap_or("img/{year}-{month}/{filename}");
    let object_path = if raw_template.contains('{') {
        expand_path_template(raw_template, &filename)
    } else {
        format!(
            "{}/{}",
            raw_template.trim_matches('/'),
            filename
        )
    }
    .replace('\\', "/");
    let content_b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    let url = format!("https://api.github.com/repos/{owner}/{repo}/contents/{object_path}");
    let client = reqwest::blocking::Client::new();
    let body = serde_json::json!({
        "message": format!("upload {original_file_name}"),
        "content": content_b64,
        "branch": branch
    });
    let resp = client
        .put(&url)
        .header("Authorization", format!("Bearer {token}"))
        .header("User-Agent", "MahoDown")
        .header("Accept", "application/vnd.github+json")
        .json(&body)
        .send()
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("GitHub 上传失败: {}", resp.status()));
    }
    let cdn = format!("https://cdn.jsdelivr.net/gh/{owner}/{repo}@{branch}/{object_path}");
    Ok(serde_json::json!({
        "objectPath": object_path,
        "markdownUrl": cdn,
        "contentType": content_type,
        "size": bytes.len()
    }))
}

fn upload_smms(settings: &AppSettings, source: &Path, original_file_name: &str) -> Result<serde_json::Value, String> {
    let cfg = resolve_host_config(settings, "smms");
    let token = cfg.get("token").ok_or("请配置 SM.MS Token")?;
    let bytes = fs::read(source).map_err(|e| e.to_string())?;
    let client = reqwest::blocking::Client::new();
    let part = reqwest::blocking::multipart::Part::bytes(bytes.clone())
        .file_name(original_file_name.to_string())
        .mime_str("application/octet-stream")
        .map_err(|e| e.to_string())?;
    let form = reqwest::blocking::multipart::Form::new().part("smfile", part);
    let resp = client
        .post("https://sm.ms/api/v2/upload")
        .header("Authorization", token)
        .multipart(form)
        .send()
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    let json: serde_json::Value = resp.json().map_err(|e| e.to_string())?;
    if !status.is_success() && json.get("success") != Some(&serde_json::Value::Bool(true)) {
        let msg = json
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("SM.MS 上传失败");
        return Err(msg.into());
    }
    let url = json
        .pointer("/data/url")
        .and_then(|u| u.as_str())
        .or_else(|| json.pointer("/images").and_then(|u| u.as_str()))
        .ok_or("SM.MS 未返回 URL")?;
    Ok(serde_json::json!({
        "objectPath": url,
        "markdownUrl": url,
        "contentType": "image/*",
        "size": bytes.len()
    }))
}

fn upload_picgo(settings: &AppSettings, source: &Path) -> Result<serde_json::Value, String> {
    let cfg = resolve_host_config(settings, "picgo");
    let endpoint = cfg
        .get("endpoint")
        .map(|s| s.as_str())
        .unwrap_or("http://127.0.0.1:36677/upload");
    let client = reqwest::blocking::Client::new();
    let body = serde_json::json!({ "list": [source.to_string_lossy()] });
    let resp = client
        .post(endpoint)
        .json(&body)
        .send()
        .map_err(|e| format!("PicGo 连接失败: {e}"))?;
    let json: serde_json::Value = resp.json().map_err(|e| e.to_string())?;
    let url = json
        .pointer("/result/0")
        .and_then(|u| u.as_str())
        .or_else(|| json.pointer("/success").and_then(|_| json.pointer("/result/0")).and_then(|u| u.as_str()))
        .ok_or("PicGo 未返回 URL")?;
    Ok(serde_json::json!({
        "objectPath": url,
        "markdownUrl": url,
        "contentType": "image/*",
        "size": fs::metadata(source).map(|m| m.len()).unwrap_or(0)
    }))
}

fn upload_custom(
    settings: &AppSettings,
    source: &Path,
    original_file_name: &str,
    content_type: &str,
) -> Result<serde_json::Value, String> {
    let cfg = resolve_host_config(settings, "custom");
    let url = cfg.get("url").ok_or("请配置自定义上传 URL")?;
    let field = cfg.get("fileField").map(|s| s.as_str()).unwrap_or("file");
    let json_path = cfg.get("jsonPath").map(|s| s.as_str()).unwrap_or("url");
    let bytes = fs::read(source).map_err(|e| e.to_string())?;
    let client = reqwest::blocking::Client::new();
    let part = reqwest::blocking::multipart::Part::bytes(bytes.clone())
        .file_name(original_file_name.to_string())
        .mime_str(content_type)
        .unwrap_or_else(|_| {
            reqwest::blocking::multipart::Part::bytes(bytes.clone())
                .file_name(original_file_name.to_string())
        });
    let form = reqwest::blocking::multipart::Form::new().part(field.to_string(), part);
    let mut req = client.post(url).multipart(form);
    if let Some(token) = cfg.get("token") {
        if !token.is_empty() {
            req = req.header("Authorization", format!("Bearer {token}"));
        }
    }
    let resp = req.send().map_err(|e| e.to_string())?;
    let body: serde_json::Value = resp.json().map_err(|e| e.to_string())?;
    let markdown_url = extract_json_path(&body, json_path)
        .ok_or_else(|| format!("自定义 API 未在路径 {json_path} 找到 URL"))?;
    Ok(serde_json::json!({
        "objectPath": markdown_url,
        "markdownUrl": markdown_url,
        "contentType": content_type,
        "size": bytes.len()
    }))
}

fn extract_json_path(value: &serde_json::Value, path: &str) -> Option<String> {
    let mut cur = value;
    for part in path.split('.').filter(|p| !p.is_empty()) {
        cur = cur.get(part)?;
    }
    cur.as_str().map(|s| s.to_string())
}

fn parse_owner_repo(cfg: &std::collections::HashMap<String, String>) -> Result<(String, String), String> {
    if let Some(repo_field) = cfg.get("repo") {
        if let Some((o, r)) = repo_field.split_once('/') {
            if !o.is_empty() && !r.is_empty() {
                return Ok((o.to_string(), r.to_string()));
            }
        }
        if let Some(owner) = cfg.get("owner") {
            if !owner.is_empty() && !repo_field.is_empty() {
                return Ok((owner.clone(), repo_field.clone()));
            }
        }
    }
    let owner = cfg.get("owner").cloned().ok_or("请配置 GitHub 仓库 owner/repo")?;
    let repo = cfg.get("repo").cloned().ok_or("请配置 GitHub 仓库 owner/repo")?;
    Ok((owner, repo))
}

fn expand_path_template(template: &str, filename: &str) -> String {
    let now = chrono::Local::now();
    template
        .replace("{year}", &now.format("%Y").to_string())
        .replace("{month}", &now.format("%m").to_string())
        .replace("{day}", &now.format("%d").to_string())
        .replace("{filename}", filename)
        .replace("{hash}", filename)
}

/// S3-compatible PUT (AWS S3 / OSS / COS style endpoints).
fn upload_s3(
    settings: &AppSettings,
    source: &Path,
    original_file_name: &str,
    content_type: &str,
) -> Result<serde_json::Value, String> {
    let cfg = resolve_host_config(settings, "s3");
    let endpoint = cfg
        .get("endpoint")
        .map(|s| s.trim_end_matches('/').to_string())
        .filter(|s| !s.is_empty())
        .ok_or("请配置 Endpoint")?;
    let bucket = cfg.get("bucket").ok_or("请配置 Bucket")?;
    let region = cfg.get("region").map(|s| s.as_str()).unwrap_or("us-east-1");
    let access = cfg.get("accessKey").ok_or("请配置 AccessKey")?;
    let secret = cfg.get("secretKey").ok_or("请配置 SecretKey")?;
    let prefix = cfg.get("prefix").map(|s| s.as_str()).unwrap_or("img");
    let bytes = fs::read(source).map_err(|e| e.to_string())?;
    let hash = &hex::encode(Sha256::digest(&bytes))[..12];
    let ext = Path::new(original_file_name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("png");
    let key = format!(
        "{}/{}",
        prefix.trim_matches('/'),
        format!("{hash}.{ext}")
    )
    .replace('\\', "/");

    // Virtual-host style: https://bucket.endpoint/key  OR path style https://endpoint/bucket/key
    let (host, url) = if endpoint.contains("://") {
        let without = endpoint.split("://").nth(1).unwrap_or(&endpoint);
        if without.starts_with(&format!("{bucket}.")) {
            (without.to_string(), format!("{endpoint}/{key}"))
        } else {
            // path-style
            let host = without.split('/').next().unwrap_or(without).to_string();
            (host, format!("{endpoint}/{bucket}/{key}"))
        }
    } else {
        return Err("Endpoint 需包含 https://".into());
    };

    let payload_hash = hex::encode(Sha256::digest(&bytes));
    let amz_date = chrono::Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
    let date_stamp = &amz_date[..8];
    let canonical_uri = {
        let path = url.split("://").nth(1).and_then(|s| s.find('/').map(|i| &s[i..])).unwrap_or("/");
        path.to_string()
    };
    let canonical_headers = format!(
        "host:{host}\nx-amz-content-sha256:{payload_hash}\nx-amz-date:{amz_date}\n"
    );
    let signed_headers = "host;x-amz-content-sha256;x-amz-date";
    let canonical_request = format!(
        "PUT\n{canonical_uri}\n\n{canonical_headers}\n{signed_headers}\n{payload_hash}"
    );
    let canonical_request_hash = hex::encode(Sha256::digest(canonical_request.as_bytes()));
    let credential_scope = format!("{date_stamp}/{region}/s3/aws4_request");
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{amz_date}\n{credential_scope}\n{canonical_request_hash}"
    );
    let signing_key = aws_signing_key(secret, date_stamp, region, "s3");
    let signature = hex::encode(hmac_sha256(&signing_key, string_to_sign.as_bytes()));
    let authorization = format!(
        "AWS4-HMAC-SHA256 Credential={access}/{credential_scope}, SignedHeaders={signed_headers}, Signature={signature}"
    );

    let client = reqwest::blocking::Client::new();
    let resp = client
        .put(&url)
        .header("Host", &host)
        .header("x-amz-date", &amz_date)
        .header("x-amz-content-sha256", &payload_hash)
        .header("Authorization", authorization)
        .header("Content-Type", content_type)
        .body(bytes.clone())
        .send()
        .map_err(|e| format!("S3 上传失败: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().unwrap_or_default();
        return Err(format!("S3 上传失败 {status}: {body}"));
    }

    let public = cfg
        .get("publicBaseUrl")
        .map(|s| s.trim_end_matches('/').to_string())
        .filter(|s| !s.is_empty())
        .map(|base| format!("{base}/{key}"))
        .unwrap_or_else(|| url.clone());

    Ok(serde_json::json!({
        "objectPath": key,
        "markdownUrl": public,
        "contentType": content_type,
        "size": bytes.len()
    }))
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> Vec<u8> {
    use hmac::{Hmac, Mac};
    use sha2::Sha256;
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("HMAC key");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

fn aws_signing_key(secret: &str, date: &str, region: &str, service: &str) -> Vec<u8> {
    let k_date = hmac_sha256(format!("AWS4{secret}").as_bytes(), date.as_bytes());
    let k_region = hmac_sha256(&k_date, region.as_bytes());
    let k_service = hmac_sha256(&k_region, service.as_bytes());
    hmac_sha256(&k_service, b"aws4_request")
}

pub fn test_connection(settings: &AppSettings, host_id: &str) -> Result<(bool, String), String> {
    match host_id {
        "local" => Ok((true, "本地图床可用".into())),
        "github" => {
            let cfg = resolve_host_config(settings, "github");
            let token = cfg.get("token").ok_or("缺少 Token")?;
            let client = reqwest::blocking::Client::new();
            let resp = client
                .get("https://api.github.com/user")
                .header("Authorization", format!("Bearer {token}"))
                .header("User-Agent", "MahoDown")
                .send()
                .map_err(|e| e.to_string())?;
            if resp.status().is_success() {
                Ok((true, "GitHub 连接成功".into()))
            } else {
                Ok((false, format!("GitHub 返回 {}", resp.status())))
            }
        }
        "smms" => {
            let cfg = resolve_host_config(settings, "smms");
            let token = cfg.get("token").ok_or("缺少 Token")?;
            let client = reqwest::blocking::Client::new();
            let resp = client
                .get("https://sm.ms/api/v2/profile")
                .header("Authorization", token)
                .send()
                .map_err(|e| e.to_string())?;
            if resp.status().is_success() {
                Ok((true, "SM.MS 连接成功".into()))
            } else {
                Ok((false, format!("SM.MS 返回 {}", resp.status())))
            }
        }
        "picgo" => {
            let cfg = resolve_host_config(settings, "picgo");
            let endpoint = cfg
                .get("endpoint")
                .map(|s| s.as_str())
                .unwrap_or("http://127.0.0.1:36677/upload");
            let client = reqwest::blocking::Client::new();
            match client.get(endpoint.replace("/upload", "/")).send() {
                Ok(_) => Ok((true, "PicGo 端点可达".into())),
                Err(e) => Ok((false, format!("PicGo 不可达: {e}"))),
            }
        }
        "custom" => {
            let cfg = resolve_host_config(settings, "custom");
            if cfg.get("url").map(|s| !s.is_empty()).unwrap_or(false) {
                Ok((true, "配置已填写".into()))
            } else {
                Ok((false, "请填写 URL".into()))
            }
        }
        "s3" => {
            let cfg = resolve_host_config(settings, "s3");
            let ok = cfg.get("endpoint").map(|s| !s.is_empty()).unwrap_or(false)
                && cfg.get("bucket").map(|s| !s.is_empty()).unwrap_or(false)
                && cfg.get("accessKey").map(|s| !s.is_empty()).unwrap_or(false)
                && cfg.get("secretKey").map(|s| !s.is_empty()).unwrap_or(false);
            if ok {
                Ok((true, "S3 配置已填写（上传时校验）".into()))
            } else {
                Ok((false, "请填写 Endpoint / Bucket / 密钥".into()))
            }
        }
        _ => Ok((false, "未知图床".into())),
    }
}

pub fn read_asset(document_path: Option<&str>, relative_path: &str) -> Result<serde_json::Value, String> {
    let doc = document_path.ok_or("请先打开或保存文档")?;
    let base = Path::new(doc).parent().ok_or("无效文档路径")?;
    let rel = relative_path.trim_start_matches("./").replace('\\', "/");
    let full = base.join(&rel);
    let full = full
        .canonicalize()
        .map_err(|_| "读取图片失败。".to_string())?;
    let base_c = base.canonicalize().map_err(|e| e.to_string())?;
    if !full.starts_with(&base_c) {
        return Err("非法路径".into());
    }
    let bytes = fs::read(&full).map_err(|_| "读取图片失败。".to_string())?;
    let mime = mime_guess::from_path(&full)
        .first_or_octet_stream()
        .essence_str()
        .to_string();
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(serde_json::json!({
        "dataUrl": format!("data:{mime};base64,{b64}"),
        "relativePath": rel
    }))
}
