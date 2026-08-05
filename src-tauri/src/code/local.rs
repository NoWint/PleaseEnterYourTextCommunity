//! 本地代码沙箱:安全路径解析 + 目录遍历 + 文件读取 + 文件查找。
//! Repo 模式限制访问仓库目录内;Any 模式放宽 root 边界但仍拒绝绝对路径/`..`/`~`/空。

use std::path::{Path, PathBuf};

use crate::error::{AppError, AppResult};

/// 单目录列出的最大条目数。
pub const MAX_LIST_ENTRIES: usize = 200;
/// find_files 递归最大深度。
pub const MAX_FIND_DEPTH: usize = 3;
/// find_files 返回结果上限。
pub const MAX_FIND_RESULTS: usize = 20;
/// 文件读取上限(64KB),超限截断 + 提示。
pub const MAX_READ: usize = 64 * 1024;

/// 沙箱模式:"repo" 默认,限 root 目录内;"any" 允许 root 外相对路径。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SandboxMode {
    Repo,
    Any,
}

impl SandboxMode {
    /// "any"(忽略大小写)→ Any;其余(缺省/其他)→ Repo。
    pub fn parse(s: Option<&str>) -> SandboxMode {
        match s {
            Some(v) if v.eq_ignore_ascii_case("any") => SandboxMode::Any,
            _ => SandboxMode::Repo,
        }
    }
}

/// 沙箱路径解析:rel 为相对路径,拼接 root 后校验。
/// Repo 模式限 root 内(canonicalize 后校验前缀,防符号链接逃逸);
/// Any 模式不做 root 边界校验(允许 root 外相对),但仍拒绝绝对路径 / `..` / `~` / 空。
pub fn resolve_safe(root: &Path, rel: &str, mode: SandboxMode) -> AppResult<PathBuf> {
    if rel.is_empty() {
        return Err(AppError::Core("路径为空".into()));
    }
    if rel.starts_with('/') || rel.starts_with('\\') {
        return Err(AppError::Core("路径越界".into()));
    }
    let b = rel.as_bytes();
    if b.len() >= 2 && b[1] == b':' && b[0].is_ascii_alphabetic() {
        return Err(AppError::Core("路径越界".into()));
    }
    let mut parts: Vec<&str> = Vec::new();
    for p in rel.split(['/', '\\']) {
        match p {
            "" | "." => {}
            ".." | "~" => return Err(AppError::Core("路径越界".into())),
            _ => parts.push(p),
        }
    }
    if parts.is_empty() {
        return Err(AppError::Core("路径为空".into()));
    }
    let mut candidate = root.to_path_buf();
    for p in parts {
        candidate.push(p);
    }
    match mode {
        SandboxMode::Repo => {
            if candidate.exists() {
                let canon = candidate
                    .canonicalize()
                    .map_err(|_| AppError::Core("路径越界".into()))?;
                let canon_root = root
                    .canonicalize()
                    .map_err(|_| AppError::Core("路径越界".into()))?;
                if !canon.starts_with(&canon_root) {
                    return Err(AppError::Core("路径越界".into()));
                }
                return Ok(canon);
            }
            // 不存在:校验最深存在的祖先仍在 root 内(防父目录符号链接逃逸)。
            let mut anc = candidate.as_path();
            let mut existing: Option<PathBuf> = None;
            while !anc.exists() {
                match anc.parent() {
                    Some(p) => anc = p,
                    None => break,
                }
            }
            if anc.exists() {
                existing = Some(anc.to_path_buf());
            }
            if let Some(ex) = existing {
                if let (Ok(canon_ex), Ok(canon_root)) = (ex.canonicalize(), root.canonicalize()) {
                    if !canon_ex.starts_with(&canon_root) {
                        return Err(AppError::Core("路径越界".into()));
                    }
                }
            }
            Ok(candidate)
        }
        SandboxMode::Any => {
            if candidate.exists() {
                candidate
                    .canonicalize()
                    .map_err(|_| AppError::Core("路径越界".into()))
            } else {
                Ok(candidate)
            }
        }
    }
}

/// 单层目录项。
#[derive(Debug, Clone, PartialEq)]
pub struct LocalEntry {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
    pub size: i64,
}

/// 列出目录项(单层;prefix 为相对路径,空 = 根)。
pub async fn list_tree(root: &Path, prefix: &str, mode: SandboxMode) -> AppResult<Vec<LocalEntry>> {
    let dir = if prefix.is_empty() {
        root.to_path_buf()
    } else {
        resolve_safe(root, prefix, mode)?
    };
    if !dir.is_dir() {
        return Err(AppError::Core(format!("不是目录: {prefix}")));
    }
    let mut rd = tokio::fs::read_dir(&dir)
        .await
        .map_err(|e| AppError::Io(e.to_string()))?;
    let mut out = Vec::new();
    while let Some(entry) = rd
        .next_entry()
        .await
        .map_err(|e| AppError::Io(e.to_string()))?
    {
        if out.len() >= MAX_LIST_ENTRIES {
            break;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let ft = entry
            .file_type()
            .await
            .map_err(|e| AppError::Io(e.to_string()))?;
        let is_dir = ft.is_dir();
        let size = if is_dir {
            0
        } else {
            entry
                .metadata()
                .await
                .map(|m| m.len() as i64)
                .unwrap_or(0)
        };
        let path = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}/{name}")
        };
        out.push(LocalEntry {
            path,
            name,
            is_dir,
            size,
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// 读文件(≤64KB;超限截断 + 提示;二进制 NUL 字节 → "二进制文件")。
pub async fn read_file(root: &Path, rel: &str, mode: SandboxMode) -> AppResult<String> {
    let path = resolve_safe(root, rel, mode)?;
    if !path.is_file() {
        return Err(AppError::Core(format!("不是文件: {rel}")));
    }
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|e| AppError::Io(e.to_string()))?;
    if bytes.contains(&0) {
        return Ok("二进制文件".into());
    }
    if bytes.len() > MAX_READ {
        let head = String::from_utf8_lossy(&bytes[..MAX_READ]);
        Ok(format!(
            "{head}\n\n(文件超 {}KB,已截断;完整 {} 字节)",
            MAX_READ / 1024,
            bytes.len()
        ))
    } else {
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    }
}

/// 按文件名包含匹配(忽略大小写),递归;忽略 .git/node_modules/target;限 20。
pub async fn find_files(root: &Path, name: &str, mode: SandboxMode) -> AppResult<Vec<LocalEntry>> {
    let needle = name.to_lowercase();
    let mut out = Vec::new();
    walk(root, &needle, mode, "", 0, &mut out).await?;
    Ok(out)
}

async fn walk(
    root: &Path,
    needle: &str,
    mode: SandboxMode,
    rel: &str,
    depth: usize,
    out: &mut Vec<LocalEntry>,
) -> AppResult<()> {
    if depth >= MAX_FIND_DEPTH || out.len() >= MAX_FIND_RESULTS {
        return Ok(());
    }
    let cur = if rel.is_empty() {
        root.to_path_buf()
    } else {
        resolve_safe(root, rel, mode)?
    };
    let mut rd = match tokio::fs::read_dir(&cur).await {
        Ok(rd) => rd,
        Err(_) => return Ok(()),
    };
    let mut entries = Vec::new();
    while let Some(entry) = rd
        .next_entry()
        .await
        .map_err(|e| AppError::Io(e.to_string()))?
    {
        entries.push(entry);
    }
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        if out.len() >= MAX_FIND_RESULTS {
            break;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if matches!(name.as_str(), ".git" | "node_modules" | "target") {
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
        if ft.is_dir() {
            // 目录:校验沙箱内后递归(符号链接逃逸在 Repo 模式下被拒)。
            if resolve_safe(root, &child_rel, mode).is_ok() {
                Box::pin(walk(root, needle, mode, &child_rel, depth + 1, out)).await?;
            }
        } else if name.to_lowercase().contains(needle) {
            let size = entry
                .metadata()
                .await
                .map(|m| m.len() as i64)
                .unwrap_or(0);
            out.push(LocalEntry {
                path: child_rel,
                name,
                is_dir: false,
                size,
            });
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sandbox_mode_parse() {
        assert_eq!(SandboxMode::parse(None), SandboxMode::Repo);
        assert_eq!(SandboxMode::parse(Some("repo")), SandboxMode::Repo);
        assert_eq!(SandboxMode::parse(Some("any")), SandboxMode::Any);
        assert_eq!(SandboxMode::parse(Some("ANY")), SandboxMode::Any);
        assert_eq!(SandboxMode::parse(Some("other")), SandboxMode::Repo);
    }

    #[test]
    fn test_resolve_safe_rejects_bad_paths() {
        let root = Path::new("/tmp/sandbox-root");
        assert!(resolve_safe(root, "", SandboxMode::Repo).is_err());
        assert!(resolve_safe(root, "../etc", SandboxMode::Repo).is_err());
        assert!(resolve_safe(root, "a/../../b", SandboxMode::Repo).is_err());
        assert!(resolve_safe(root, "/etc/passwd", SandboxMode::Repo).is_err());
        assert!(resolve_safe(root, "~/x", SandboxMode::Repo).is_err());
        assert!(resolve_safe(root, "C:\\windows", SandboxMode::Any).is_err());
    }

    #[test]
    fn test_resolve_safe_repo_legal_and_out_of_root() {
        let tmp = tempfile::tempdir().unwrap();
        let base = tmp.path();
        let root = base.join("root");
        let outside = base.join("outside");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(root.join("a.txt"), "hi").unwrap();
        std::fs::write(outside.join("secret.txt"), "secret").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, root.join("escape")).unwrap();

        // 合法相对通过
        let resolved = resolve_safe(&root, "a.txt", SandboxMode::Repo).unwrap();
        assert!(resolved.is_file());

        // 不存在的路径:最深祖先在 root 内 → 通过
        let resolved = resolve_safe(&root, "sub/deep/file.rs", SandboxMode::Repo).unwrap();
        assert!(resolved.starts_with(&root));

        // Repo 越界拒绝:符号链接逃逸出 root
        #[cfg(unix)]
        assert!(resolve_safe(&root, "escape/secret.txt", SandboxMode::Repo).is_err());

        // Any 允许 root 外相对(经符号链接)
        #[cfg(unix)]
        {
            let resolved = resolve_safe(&root, "escape/secret.txt", SandboxMode::Any).unwrap();
            assert!(resolved.is_file());
            assert_eq!(
                std::fs::read_to_string(&resolved).unwrap(),
                "secret"
            );
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_list_tree() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("repo");
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::create_dir_all(root.join("docs")).unwrap();
        std::fs::write(root.join("Cargo.toml"), "[package]").unwrap();
        std::fs::write(root.join("src/main.rs"), "fn main() {}").unwrap();

        let entries = list_tree(&root, "", SandboxMode::Repo).await.unwrap();
        assert_eq!(entries.len(), 3);
        assert!(entries.iter().any(|e| e.name == "Cargo.toml" && !e.is_dir));
        assert!(entries.iter().any(|e| e.name == "src" && e.is_dir));
        assert!(entries.iter().any(|e| e.name == "docs" && e.is_dir));

        let src = list_tree(&root, "src", SandboxMode::Repo).await.unwrap();
        assert_eq!(src.len(), 1);
        assert_eq!(src[0].name, "main.rs");
        assert!(src[0].path.ends_with("src/main.rs"));

        // 不存在/非目录报错
        assert!(list_tree(&root, "nope", SandboxMode::Repo).await.is_err());
        assert!(list_tree(&root, "Cargo.toml", SandboxMode::Repo).await.is_err());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_read_file_normal_truncate_binary() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("repo");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("hello.rs"), "fn main() {}\n").unwrap();
        std::fs::write(root.join("big.txt"), "x".repeat(70 * 1024)).unwrap();
        std::fs::write(root.join("bin.dat"), b"\x00\x01\x02raw").unwrap();

        let normal = read_file(&root, "hello.rs", SandboxMode::Repo).await.unwrap();
        assert_eq!(normal, "fn main() {}\n");

        let big = read_file(&root, "big.txt", SandboxMode::Repo).await.unwrap();
        assert!(big.contains("已截断"));
        assert!(big.contains("71680"));

        let binary = read_file(&root, "bin.dat", SandboxMode::Repo).await.unwrap();
        assert_eq!(binary, "二进制文件");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_find_files() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("repo");
        std::fs::create_dir_all(root.join("src/util")).unwrap();
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::create_dir_all(root.join("node_modules")).unwrap();
        std::fs::create_dir_all(root.join("target")).unwrap();
        std::fs::write(root.join("src/util/README.md"), "x").unwrap();
        std::fs::write(root.join("src/util/read_me.rs"), "x").unwrap();
        std::fs::write(root.join("src/other.rs"), "x").unwrap();
        std::fs::write(root.join(".git/config"), "x").unwrap();
        std::fs::write(root.join("node_modules/readme.txt"), "x").unwrap();
        std::fs::write(root.join("target/read_me_out.txt"), "x").unwrap();

        let found = find_files(&root, "read", SandboxMode::Repo).await.unwrap();
        // 忽略大小写匹配 read_me/README;忽略 .git/node_modules/target
        assert!(found.iter().any(|e| e.name == "README.md"));
        assert!(found.iter().any(|e| e.name == "read_me.rs"));
        assert!(!found.iter().any(|e| e.path.starts_with(".git")));
        assert!(!found.iter().any(|e| e.path.starts_with("node_modules")));
        assert!(!found.iter().any(|e| e.path.starts_with("target")));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_find_files_limit_20() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("repo");
        std::fs::create_dir_all(&root).unwrap();
        for i in 0..30 {
            std::fs::write(root.join(format!("item_{i}.txt")), "x").unwrap();
        }
        let found = find_files(&root, "item", SandboxMode::Repo).await.unwrap();
        assert!(found.len() <= 20);
        assert_eq!(found.len(), 20);
    }
}
