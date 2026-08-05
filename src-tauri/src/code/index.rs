//! 轻量文件索引:递归扫描 root 目录(忽略 .git/node_modules/target),缓存文件清单。
//! mtime 检测:比较 root 目录自身 mtime,变化即重扫(简单版,不递归浅层)。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::time::UNIX_EPOCH;

use crate::error::{AppError, AppResult};

// 本模块经 source::CodeSource 使用;Task 3/4 接入前在非 test build 中属死代码,逐项豁免。
#[allow(dead_code)]
const IGNORED_DIRS: [&str; 3] = [".git", "node_modules", "target"];
#[allow(dead_code)]
const MAX_SCAN_DEPTH: usize = 8;
#[allow(dead_code)]
const MAX_SCAN_ENTRIES: usize = 20_000;

/// 文件清单缓存条目:root 目录的 mtime + 已索引文件列表。
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct IndexEntry {
    pub mtime_secs: i64,
    pub files: Vec<IndexFile>,
}

/// 索引中的单个文件。
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct IndexFile {
    pub path: String,
    pub size: i64,
    pub mtime: i64,
}

/// 进程级索引缓存(root 绝对路径 → 条目)。
#[derive(Default)]
#[allow(dead_code)]
pub struct IndexCache {
    map: Arc<RwLock<HashMap<PathBuf, IndexEntry>>>,
}

impl Clone for IndexCache {
    fn clone(&self) -> Self {
        Self {
            map: Arc::clone(&self.map),
        }
    }
}

impl std::fmt::Debug for IndexCache {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "IndexCache {{ entries: {} }}", self.map.read().map(|m| m.len()).unwrap_or(0))
    }
}

#[allow(dead_code)]
impl IndexCache {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn get(&self, root: &Path) -> Option<IndexEntry> {
        self.map.read().ok()?.get(root).cloned()
    }

    pub fn insert(&self, root: &Path, entry: IndexEntry) {
        if let Ok(mut map) = self.map.write() {
            map.insert(root.to_path_buf(), entry);
        }
    }

    /// 索引是否过期:root 自身 mtime 与缓存不一致(或未缓存)即过期。
    pub fn is_stale(&self, root: &Path) -> bool {
        match self.get(root) {
            None => true,
            Some(entry) => dir_mtime_secs(root)
                .map(|m| m != entry.mtime_secs)
                .unwrap_or(true),
        }
    }

    /// 取缓存;过期或缺失则重扫并写回。
    pub async fn get_or_scan(&self, root: &Path) -> AppResult<Option<IndexEntry>> {
        if !self.is_stale(root) {
            return Ok(self.get(root));
        }
        let entry = scan(root).await?;
        self.insert(root, entry.clone());
        Ok(Some(entry))
    }
}

/// 递归扫描 root 目录构建索引(忽略 .git/node_modules/target 与符号链接;限深/限条目)。
#[allow(dead_code)]
pub async fn scan(root: &Path) -> AppResult<IndexEntry> {
    let mtime_secs = dir_mtime_secs(root).ok_or_else(|| AppError::Core("目录不存在或不可读".into()))?;
    let mut files = Vec::new();
    scan_dir(root, "", 0, &mut files).await?;
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(IndexEntry { mtime_secs, files })
}

#[allow(dead_code)]
async fn scan_dir(root: &Path, rel: &str, depth: usize, out: &mut Vec<IndexFile>) -> AppResult<()> {
    if depth >= MAX_SCAN_DEPTH || out.len() >= MAX_SCAN_ENTRIES {
        return Ok(());
    }
    let cur = if rel.is_empty() {
        root.to_path_buf()
    } else {
        root.join(rel)
    };
    let mut rd = match tokio::fs::read_dir(&cur).await {
        Ok(rd) => rd,
        Err(_) => return Ok(()),
    };
    while let Some(entry) = rd
        .next_entry()
        .await
        .map_err(|e| AppError::Io(e.to_string()))?
    {
        if out.len() >= MAX_SCAN_ENTRIES {
            break;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if IGNORED_DIRS.iter().any(|d| name == *d) {
            continue;
        }
        let ft = entry
            .file_type()
            .await
            .map_err(|e| AppError::Io(e.to_string()))?;
        let child_rel = if rel.is_empty() {
            name.clone()
        } else {
            format!("{rel}/{name}")
        };
        if ft.is_symlink() {
            // 符号链接跳过:防沙箱逃逸与循环。
            continue;
        }
        if ft.is_dir() {
            Box::pin(scan_dir(root, &child_rel, depth + 1, out)).await?;
        } else if ft.is_file() {
            let md = entry
                .metadata()
                .await
                .map_err(|e| AppError::Io(e.to_string()))?;
            out.push(IndexFile {
                path: child_rel,
                size: md.len() as i64,
                mtime: md
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_secs() as i64)
                    .unwrap_or(0),
            });
        }
    }
    Ok(())
}

/// root 目录自身 mtime(秒)。不存在/不可读返回 None。
#[allow(dead_code)]
pub fn dir_mtime_secs(root: &Path) -> Option<i64> {
    let md = std::fs::metadata(root).ok()?;
    md.modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|d| d.as_secs() as i64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, SystemTime};

    fn make_root(tmp: &tempfile::TempDir, tag: &str) -> PathBuf {
        let root = tmp.path().join(tag);
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    fn bump_dir_mtime(root: &Path) {
        let f = std::fs::File::open(root).unwrap();
        let times = std::fs::FileTimes::new()
            .set_modified(SystemTime::now() + Duration::from_secs(5));
        f.set_times(times).unwrap();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_scan_collects_files_ignores_ignored_dirs_and_symlinks() {
        let tmp = tempfile::tempdir().unwrap();
        let root = make_root(&tmp, "scan");
        std::fs::create_dir_all(root.join("src/util")).unwrap();
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::create_dir_all(root.join("node_modules")).unwrap();
        std::fs::create_dir_all(root.join("target")).unwrap();
        std::fs::write(root.join("Cargo.toml"), "[package]").unwrap();
        std::fs::write(root.join("src/main.rs"), "fn main() {}").unwrap();
        std::fs::write(root.join("src/util/lib.rs"), "pub fn f() {}").unwrap();
        std::fs::write(root.join(".git/config"), "x").unwrap();
        std::fs::write(root.join("node_modules/pkg.js"), "x").unwrap();
        std::fs::write(root.join("target/out.bin"), "x").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink("/etc", root.join("esc")).unwrap();

        let entry = scan(&root).await.unwrap();
        let paths: Vec<&str> = entry.files.iter().map(|f| f.path.as_str()).collect();
        assert!(paths.contains(&"Cargo.toml"));
        assert!(paths.contains(&"src/main.rs"));
        assert!(paths.contains(&"src/util/lib.rs"));
        assert!(!paths.iter().any(|p| p.starts_with(".git")));
        assert!(!paths.iter().any(|p| p.starts_with("node_modules")));
        assert!(!paths.iter().any(|p| p.starts_with("target")));
        assert!(!paths.iter().any(|p| p.starts_with("esc")));
        assert_eq!(entry.files.len(), 3);
        assert_eq!(entry.files[0].path, "Cargo.toml");
        assert!(entry.files.iter().all(|f| f.size > 0));
        assert!(entry.mtime_secs > 0);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_scan_depth_limit() {
        let tmp = tempfile::tempdir().unwrap();
        let root = make_root(&tmp, "depth");
        // 构造超出 MAX_SCAN_DEPTH 的嵌套。
        let mut deep = root.clone();
        for i in 0..(MAX_SCAN_DEPTH + 2) {
            deep.push(format!("d{i}"));
        }
        std::fs::create_dir_all(&deep).unwrap();
        std::fs::write(deep.join("leaf.txt"), "x").unwrap();
        std::fs::write(root.join("top.txt"), "y").unwrap();

        let entry = scan(&root).await.unwrap();
        // 深层文件超出深度限制 → 不被收录。
        assert!(entry.files.iter().any(|f| f.path == "top.txt"));
        assert!(!entry.files.iter().any(|f| f.path.ends_with("leaf.txt")));
    }

    #[test]
    fn test_is_stale_cached_same_mtime_not_stale() {
        let tmp = tempfile::tempdir().unwrap();
        let root = make_root(&tmp, "stale1");
        std::fs::write(root.join("a.txt"), "x").unwrap();
        let cache = IndexCache::new();
        assert!(cache.is_stale(&root));
        let entry = dir_mtime_secs(&root)
            .map(|m| IndexEntry {
                mtime_secs: m,
                files: vec![],
            })
            .unwrap();
        cache.insert(&root, entry);
        assert!(!cache.is_stale(&root));
        assert!(cache.get(&root).is_some());
    }

    #[test]
    fn test_is_stale_reports_true_when_root_mtime_changes() {
        let tmp = tempfile::tempdir().unwrap();
        let root = make_root(&tmp, "stale2");
        std::fs::write(root.join("a.txt"), "x").unwrap();
        let cache = IndexCache::new();
        let entry = dir_mtime_secs(&root)
            .map(|m| IndexEntry {
                mtime_secs: m,
                files: vec![],
            })
            .unwrap();
        cache.insert(&root, entry);
        assert!(!cache.is_stale(&root));

        bump_dir_mtime(&root);
        assert!(cache.is_stale(&root));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_get_or_scan_caches_then_serves() {
        let tmp = tempfile::tempdir().unwrap();
        let root = make_root(&tmp, "getor");
        std::fs::write(root.join("a.txt"), "x").unwrap();
        let cache = IndexCache::new();
        let first = cache.get_or_scan(&root).await.unwrap().unwrap();
        assert_eq!(first.files.len(), 1);
        // 二次调用命中缓存(不重扫)。
        let second = cache.get_or_scan(&root).await.unwrap().unwrap();
        assert_eq!(second.files.len(), 1);
        // mtime 变化后重扫(写入可能落在同一秒,显式推进 root mtime)。
        std::fs::write(root.join("b.txt"), "y").unwrap();
        bump_dir_mtime(&root);
        let third = cache.get_or_scan(&root).await.unwrap().unwrap();
        assert_eq!(third.files.len(), 2);
    }
}
