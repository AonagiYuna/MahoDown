use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};

use crate::settings::snapshots_dir;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotInfo {
    pub id: String,
    pub target_file_path: Option<String>,
    pub created_at: DateTime<Utc>,
    pub word_count: i32,
    pub kind: String,
}

fn doc_folder(target: Option<&str>) -> PathBuf {
    let key = target.unwrap_or("untitled");
    let hash = hex::encode(Sha256::digest(key.as_bytes()));
    snapshots_dir().join(&hash[..16])
}

fn count_words(markdown: &str) -> i32 {
    let cjk = markdown
        .chars()
        .filter(|c| ('\u{4e00}'..='\u{9fff}').contains(c))
        .count() as i32;
    let latin = markdown
        .chars()
        .map(|c| if ('\u{4e00}'..='\u{9fff}').contains(&c) { ' ' } else { c })
        .collect::<String>()
        .split_whitespace()
        .count() as i32;
    cjk + latin
}

pub fn save_snapshot(
    target_file_path: Option<&str>,
    markdown: &str,
    kind: &str,
) -> Result<SnapshotInfo, String> {
    let folder = doc_folder(target_file_path);
    fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    let id = format!(
        "{}-{}",
        Utc::now().format("%Y%m%d%H%M%S"),
        &uuid::Uuid::new_v4().to_string().replace('-', "")[..8]
    );
    let dir = folder.join(&id);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let info = SnapshotInfo {
        id: id.clone(),
        target_file_path: target_file_path.map(|s| s.to_string()),
        created_at: Utc::now(),
        word_count: count_words(markdown),
        kind: kind.to_string(),
    };

    fs::write(dir.join("content.md"), markdown).map_err(|e| e.to_string())?;
    let meta = serde_json::to_string_pretty(&info).map_err(|e| e.to_string())?;
    fs::write(dir.join("meta.json"), meta).map_err(|e| e.to_string())?;
    trim_old(&folder, 40)?;
    Ok(info)
}

pub fn list_snapshots(target_file_path: Option<&str>) -> Result<Vec<SnapshotInfo>, String> {
    let folder = doc_folder(target_file_path);
    if !folder.exists() {
        return Ok(vec![]);
    }
    let mut list = vec![];
    for entry in fs::read_dir(&folder).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let meta_path = entry.path().join("meta.json");
        if !meta_path.exists() {
            continue;
        }
        if let Ok(text) = fs::read_to_string(meta_path) {
            if let Ok(info) = serde_json::from_str::<SnapshotInfo>(&text) {
                list.push(info);
            }
        }
    }
    list.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(list)
}

pub fn load_snapshot(target_file_path: Option<&str>, snapshot_id: &str) -> Result<String, String> {
    let path = doc_folder(target_file_path).join(snapshot_id).join("content.md");
    fs::read_to_string(path).map_err(|_| "快照不存在".into())
}

fn trim_old(folder: &Path, keep: usize) -> Result<(), String> {
    let mut dirs: Vec<_> = fs::read_dir(folder)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .collect();
    dirs.sort_by_key(|d| {
        std::cmp::Reverse(
            d.metadata()
                .and_then(|m| m.modified().or_else(|_| m.created()))
                .ok(),
        )
    });
    for dir in dirs.into_iter().skip(keep) {
        let _ = fs::remove_dir_all(dir.path());
    }
    Ok(())
}
