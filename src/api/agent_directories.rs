use super::schema::DirectoryListParams;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

pub(super) fn normalize(path: &str) -> Result<PathBuf, String> {
    let home = crate::integration::home_dir().map_err(|e| e.to_string())?;
    let path = if path == "~" {
        home
    } else if let Some(rest) = path.strip_prefix("~/") {
        home.join(rest)
    } else {
        PathBuf::from(path)
    };
    if !path.is_absolute() {
        return Err("working directory must be an absolute path".into());
    }
    let path = path
        .canonicalize()
        .map_err(|e| format!("directory unavailable: {e}"))?;
    if !path.is_dir() {
        return Err("path is not a directory".into());
    }
    Ok(path)
}

pub(super) fn same_directory(left: &str, right: &Path) -> bool {
    Path::new(left)
        .canonicalize()
        .is_ok_and(|path| path == right)
}

pub(super) fn list(params: &DirectoryListParams) -> Result<Value, String> {
    let home = crate::integration::home_dir().map_err(|e| e.to_string())?;
    let path = normalize(params.path.as_deref().unwrap_or(&home.to_string_lossy()))?;
    let mut directories = Vec::new();
    for entry in std::fs::read_dir(&path).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.path().is_dir() {
            directories.push(json!({"name":entry.file_name().to_string_lossy(),"path":entry.path().to_string_lossy()}));
        }
    }
    directories.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    Ok(
        json!({"type":"directory_list","path":path.to_string_lossy(),"parent":path.parent().map(|p|p.to_string_lossy()),"directories":directories}),
    )
}
