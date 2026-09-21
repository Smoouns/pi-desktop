use serde::Serialize;
use std::fs::File;
use std::io::{BufRead, BufReader, ErrorKind};
use std::path::Path;

#[derive(Debug, Serialize, PartialEq)]
#[serde(tag = "status", rename_all = "snake_case")]
pub(crate) enum SessionFileStatus {
    Missing,
    Valid { session_id: String },
}

/// Inspect only the header. Opening a missing/empty path in Pi creates a new
/// identity under that old filename, so Desktop must not use it as a resume.
pub(crate) fn inspect_session_file(path: &Path) -> Result<SessionFileStatus, String> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(SessionFileStatus::Missing),
        Err(error) => return Err(format!("无法读取会话文件：{error}")),
    };
    for line in BufReader::new(file).lines() {
        let line = line.map_err(|error| format!("无法读取会话文件：{error}"))?;
        let line = line.trim().trim_start_matches('\u{feff}');
        if line.is_empty() {
            continue;
        }
        let header: serde_json::Value = serde_json::from_str(line)
            .map_err(|_| "会话文件头损坏，已停止恢复以保护历史记录".to_string())?;
        if header.get("type").and_then(|v| v.as_str()) != Some("session") {
            return Err("会话文件缺少有效的 session 文件头，已停止恢复".to_string());
        }
        let id = header.get("id").and_then(|v| v.as_str()).filter(|id| !id.trim().is_empty())
            .ok_or_else(|| "会话文件缺少有效 ID，已停止恢复".to_string())?;
        // Filename is a location, not identity. Keep readable legacy files
        // whose names differ from the authoritative header untouched.
        return Ok(SessionFileStatus::Valid { session_id: id.to_string() });
    }
    Err("会话文件为空，已停止恢复以保护历史记录".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT: AtomicUsize = AtomicUsize::new(0);

    #[test]
    fn missing_invalid_and_legacy_headers_are_non_mutating() {
        let root = std::env::temp_dir().join(format!("pi-session-header-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("old-id.jsonl");
        assert_eq!(inspect_session_file(&path).unwrap(), SessionFileStatus::Missing);
        assert!(!path.exists());
        for invalid in ["", "not-json", "{\"type\":\"message\",\"id\":\"x\"}", "{\"type\":\"session\",\"id\":\" \"}"] {
            fs::write(&path, invalid).unwrap();
            assert!(inspect_session_file(&path).is_err());
            assert_eq!(fs::read_to_string(&path).unwrap(), invalid);
        }
        let history = "{\"type\":\"session\",\"id\":\"header-id\",\"cwd\":\"synthetic\"}\n{\"type\":\"message\"}\n";
        fs::write(&path, history).unwrap();
        assert_eq!(inspect_session_file(&path).unwrap(), SessionFileStatus::Valid { session_id: "header-id".to_string() });
        assert_eq!(fs::read_to_string(&path).unwrap(), history);
        fs::remove_file(&path).unwrap();
        fs::remove_dir(&root).unwrap();
    }
}
