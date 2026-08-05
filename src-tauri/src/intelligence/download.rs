//! 下载器:引擎二进制(GitHub releases,锁定 tag b10276,CPU 产物)+
//! 模型 GGUF(ModelScope 优先,HuggingFace 兜底,见 `MODEL_URL_HF_FALLBACK`)。
//!
//! 落地 `app-data/models/`:流式下载到 `.part` 临时文件,按 256KB/200ms 节流
//! emit `download-progress {id, bytesDone, total, rate}`,完成后改名目标文件。
//! post-process 尽量实现:引擎 tar.gz 解出 llama-server + chmod +x + macOS
//! 去隔离属性;Windows zip 解压留 TODO(集成者补)。模型 sha256 校验从
//! `summary_state.json` 读期望值,无则跳过(该文件的写入方是集成者)。

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use tauri::Emitter;

use crate::error::{AppError, AppResult};

/// llama.cpp releases 锁定 tag(§7.1)。
pub const ENGINE_TAG: &str = "b10276";
const MODELS_DIR: &str = "models";
/// 进度事件节流阈值:每 256KB 或 200ms 发一次。
const PROGRESS_CHUNK_BYTES: u64 = 256 * 1024;
const PROGRESS_INTERVAL: Duration = Duration::from_millis(200);
/// ModelScope 的 HF 兜底 URL(备用,本期不用)。
const _MODEL_URL_HF_FALLBACK: &str = "https://huggingface.co/{repo}/resolve/main/{file}";

/// 平台引擎资产名(§7.1,纯函数,可单测)。
pub fn engine_asset_name() -> &'static str {
    engine_asset_name_impl()
}

#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
fn engine_asset_name_impl() -> &'static str {
    "llama-b10276-bin-win-cpu-x64.zip"
}
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn engine_asset_name_impl() -> &'static str {
    "llama-b10276-bin-macos-arm64.tar.gz"
}
#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
fn engine_asset_name_impl() -> &'static str {
    "llama-b10276-bin-macos-x64.tar.gz"
}
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
fn engine_asset_name_impl() -> &'static str {
    "llama-b10276-bin-ubuntu-x64.tar.gz"
}
#[cfg(all(target_os = "linux", target_arch = "aarch64"))]
fn engine_asset_name_impl() -> &'static str {
    "llama-b10276-bin-ubuntu-arm64.tar.gz"
}
#[cfg(not(any(
    all(target_os = "windows", target_arch = "x86_64"),
    all(target_os = "macos", target_arch = "aarch64"),
    all(target_os = "macos", target_arch = "x86_64"),
    all(target_os = "linux", target_arch = "x86_64"),
    all(target_os = "linux", target_arch = "aarch64")
)))]
fn engine_asset_name_impl() -> &'static str {
    // 未知平台兜底(仅保证编译;下载可能 404)
    "llama-b10276-bin-ubuntu-x64.tar.gz"
}

/// 模型档位 → GGUF 文件名(§7.1,纯函数,可单测)。未知档位按 0.5b。
pub fn model_asset_name(tier: &str) -> &'static str {
    match tier {
        "1.5b" => "Qwen2.5-1.5B-Instruct-Q4_K_M.gguf",
        _ => "Qwen2.5-0.5B-Instruct-Q4_K_M.gguf",
    }
}

/// 模型档位 → ModelScope 直链(纯函数,可单测)。
pub fn model_url(tier: &str) -> &'static str {
    match tier {
        "1.5b" => {
            "https://modelscope.cn/models/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/master/Qwen2.5-1.5B-Instruct-Q4_K_M.gguf"
        }
        _ => {
            "https://modelscope.cn/models/second-state/Qwen2.5-0.5B-Instruct-GGUF/resolve/master/Qwen2.5-0.5B-Instruct-Q4_K_M.gguf"
        }
    }
}

/// 引擎下载 URL(纯函数)。
pub fn engine_url() -> String {
    format!(
        "https://github.com/ggml-org/llama.cpp/releases/download/{ENGINE_TAG}/{}",
        engine_asset_name()
    )
}

/// 引擎/模型资产目录。
pub fn models_dir(data_dir: &Path) -> PathBuf {
    data_dir.join(MODELS_DIR)
}

/// summary_state.json 路径(引擎版本/模型 sha256/摘要缓存,§8.4)。
pub fn state_path(data_dir: &Path) -> PathBuf {
    models_dir(data_dir).join("summary_state.json")
}

/// 下载器:引擎 + 模型,进度事件经 AppHandle emit。
pub struct Downloader {
    data_dir: PathBuf,
    http: reqwest::Client,
}

impl Downloader {
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            data_dir,
            http: reqwest::Client::new(),
        }
    }

    /// 启动下载:`which` = 'engine' | 'model',`tier` = '0.5b' | '1.5b'。
    /// 已存在目标文件 → 直接返回(断点续传留迭代 2,TODO)。
    pub async fn start(
        &self,
        which: &str,
        tier: &str,
        handle: &tauri::AppHandle,
    ) -> AppResult<()> {
        let dir = models_dir(&self.data_dir);
        tokio::fs::create_dir_all(&dir).await?;
        let (url, target) = match which {
            "engine" => (engine_url(), dir.join(engine_asset_name())),
            "model" => (model_url(tier).to_string(), dir.join(model_asset_name(tier))),
            _ => {
                return Err(AppError::Core(format!(
                    "[engine_not_ready] 未知下载目标: {which}"
                )))
            }
        };
        if target.exists() {
            log::info!("intelligence download: {which} 已存在,跳过: {}", target.display());
            return Ok(());
        }
        // 流式下载到 .part,完成后改名
        let tmp = target.with_extension("part");
        self.download_with_progress(&url, &tmp, which, handle).await?;
        tokio::fs::rename(&tmp, &target).await.map_err(|e| {
            AppError::Io(format!("下载完成但改名失败 {}: {e}", target.display()))
        })?;
        if which == "engine" {
            self.post_process_engine(&target).await?;
        } else {
            // 模型:sha256 校验(summary_state.json 无期望值则跳过)
            self.verify_model_sha256(&target).await?;
        }
        Ok(())
    }

    /// 流式下载 + 节流进度事件。失败清理临时文件。
    async fn download_with_progress(
        &self,
        url: &str,
        dest: &Path,
        id: &str,
        handle: &tauri::AppHandle,
    ) -> AppResult<()> {
        use tokio::io::AsyncWriteExt;
        let resp = self
            .http
            .get(url)
            .send()
            .await
            .map_err(|e| AppError::Network(format!("下载请求失败 {url}: {e}")))?;
        let status = resp.status();
        if !status.is_success() {
            let _ = resp.text().await;
            return Err(AppError::Core(format!(
                "[api_network] 下载失败 HTTP {}: {url}",
                status.as_u16()
            )));
        }
        let total = resp.content_length().unwrap_or(0);
        let mut file = tokio::fs::File::create(dest).await?;
        let mut stream = resp;
        let mut done: u64 = 0;
        let mut prev_emitted: u64 = 0;
        let start = Instant::now();
        let mut last_emit = Instant::now();
        while let Some(chunk) = stream
            .chunk()
            .await
            .map_err(|e| AppError::Network(format!("下载中断: {e}")))?
        {
            file.write_all(&chunk).await?;
            done += chunk.len() as u64;
            if done - prev_emitted >= PROGRESS_CHUNK_BYTES || last_emit.elapsed() >= PROGRESS_INTERVAL
            {
                self.emit_progress(handle, id, done, total, start);
                prev_emitted = done;
                last_emit = Instant::now();
            }
        }
        file.flush().await?;
        // 收尾进度(保证前端拿到 100%)
        self.emit_progress(handle, id, done, total, start);
        Ok(())
    }

    fn emit_progress(
        &self,
        handle: &tauri::AppHandle,
        id: &str,
        done: u64,
        total: u64,
        start: Instant,
    ) {
        let elapsed = start.elapsed().as_secs_f64().max(0.001);
        let rate = done as f64 / elapsed; // bytes/s
        let _ = handle.emit(
            "download-progress",
            serde_json::json!({
                "id": id,
                "bytesDone": done,
                "total": total,
                "rate": rate,
            }),
        );
    }

    /// 引擎资产 post-process:解压归档 + 改名 llama-server + 权限/隔离。
    /// macOS/Linux 用系统 tar;Windows zip 解压留 TODO(集成者补)。
    async fn post_process_engine(&self, archive: &Path) -> AppResult<()> {
        let dir = models_dir(&self.data_dir);
        #[cfg(target_os = "windows")]
        {
            // TODO(集成者):用 zip crate(已在 Cargo.toml)解压 zip 内 llama-server.exe 到
            // models/llama-server.exe;本期仅下载归档文件
            log::warn!("intelligence download: Windows 引擎解压留待集成者实现");
            return Ok(());
        }
        #[cfg(not(target_os = "windows"))]
        {
            let staging = dir.join(".engine-stage");
            let _ = tokio::fs::remove_dir_all(&staging).await;
            tokio::fs::create_dir_all(&staging).await?;
            let archive_s = archive.to_string_lossy().to_string();
            let staging_s = staging.to_string_lossy().to_string();
            let out = tokio::process::Command::new("tar")
                .args(["-xzf", archive_s.as_str(), "-C", staging_s.as_str()])
                .output()
                .await
                .map_err(|e| {
                    AppError::Core(format!(
                        "[engine_not_ready] 解压引擎失败(需系统 tar): {e}"
                    ))
                })?;
            if !out.status.success() {
                let stderr: String =
                    String::from_utf8_lossy(&out.stderr).chars().take(200).collect();
                let _ = tokio::fs::remove_dir_all(&staging).await;
                return Err(AppError::Core(format!(
                    "[engine_not_ready] 解压引擎失败: {stderr}"
                )));
            }
            let found = find_file(&staging, "llama-server").ok_or_else(|| {
                AppError::Core("[engine_not_ready] 归档中未找到 llama-server".into())
            })?;
            let target = dir.join("llama-server");
            tokio::fs::copy(&found, &target).await?;
            set_executable(&target).await?;
            // macOS 网络下载带隔离属性,不清会触发 Gatekeeper(§7.2)
            #[cfg(target_os = "macos")]
            {
                let _ = tokio::process::Command::new("xattr")
                    .args(["-d", "com.apple.quarantine"])
                    .arg(&target)
                    .output()
                    .await;
            }
            let _ = tokio::fs::remove_dir_all(&staging).await;
            log::info!("intelligence download: 引擎就绪 {}", target.display());
            Ok(())
        }
    }

    /// 模型 sha256 校验:从 summary_state.json 读期望值,无 → 跳过(注释:
    /// state 文件由集成者写入,本期下载流程不生成)。
    async fn verify_model_sha256(&self, path: &Path) -> AppResult<()> {
        let raw = match tokio::fs::read_to_string(state_path(&self.data_dir)).await {
            Ok(r) => r,
            Err(_) => {
                log::warn!("intelligence download: 无 summary_state.json,跳过 sha256 校验");
                return Ok(());
            }
        };
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap_or(serde_json::Value::Null);
        let expected = v
            .get("model_sha256")
            .and_then(|x| x.as_str())
            .or_else(|| {
                v.get("model").and_then(|m| m.get("sha256")).and_then(|x| x.as_str())
            });
        let Some(expected) = expected else {
            log::warn!("intelligence download: summary_state.json 无 model_sha256,跳过校验");
            return Ok(());
        };
        let actual = sha256_hex(path).await?;
        if !actual.eq_ignore_ascii_case(expected) {
            return Err(AppError::Core(format!(
                "[engine_not_ready] 模型 sha256 不匹配: {actual} != {expected}"
            )));
        }
        log::info!("intelligence download: 模型 sha256 校验通过");
        Ok(())
    }
}

/// 在目录树中递归找指定文件名(解压产物定位,深度不限)。
fn find_file(dir: &Path, name: &str) -> Option<PathBuf> {
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        if let Ok(entries) = std::fs::read_dir(&d) {
            for e in entries.flatten() {
                let p = e.path();
                if p.file_name().is_some_and(|f| f == name) {
                    return Some(p);
                }
                if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    stack.push(p);
                }
            }
        }
    }
    None
}

async fn set_executable(path: &Path) -> AppResult<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = tokio::fs::metadata(path).await?.permissions();
        perms.set_mode(0o755);
        tokio::fs::set_permissions(path, perms).await?;
    }
    Ok(())
}

/// 计算文件 sha256(hex 小写);流式 1MB 分块,不整文件读入内存。
async fn sha256_hex(path: &Path) -> AppResult<String> {
    use tokio::io::AsyncReadExt;
    let mut file = tokio::fs::File::open(path).await?;
    let mut ctx = Sha256Ctx::new();
    let mut buf = vec![0u8; 1024 * 1024];
    loop {
        let n = file.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        ctx.update(&buf[..n]);
    }
    Ok(hex_of(&ctx.finish()))
}

/// 纯 Rust SHA-256(无外部依赖;`sha2` crate 不在依赖清单,文件边界禁止加依赖)。
struct Sha256Ctx {
    h: [u32; 8],
    buf: Vec<u8>,
    bit_len: u64,
}

impl Sha256Ctx {
    fn new() -> Self {
        Self {
            h: [
                0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
                0x1f83d9ab, 0x5be0cd19,
            ],
            buf: Vec::with_capacity(64),
            bit_len: 0,
        }
    }

    fn update(&mut self, mut data: &[u8]) {
        self.bit_len = self.bit_len.wrapping_add((data.len() as u64) * 8);
        if !self.buf.is_empty() {
            let need = 64 - self.buf.len();
            let take = need.min(data.len());
            self.buf.extend_from_slice(&data[..take]);
            data = &data[take..];
            if self.buf.len() == 64 {
                let chunk = std::mem::take(&mut self.buf);
                self.compress(&chunk);
            }
        }
        while data.len() >= 64 {
            let (chunk, rest) = data.split_at(64);
            self.compress(chunk);
            data = rest;
        }
        self.buf.extend_from_slice(data);
    }

    fn finish(mut self) -> [u8; 32] {
        let mut msg = std::mem::take(&mut self.buf);
        msg.push(0x80);
        while msg.len() % 64 != 56 {
            msg.push(0);
        }
        msg.extend_from_slice(&self.bit_len.to_be_bytes());
        for chunk in msg.chunks(64) {
            self.compress(chunk);
        }
        let mut out = [0u8; 32];
        for (i, hv) in self.h.iter().enumerate() {
            out[i * 4..i * 4 + 4].copy_from_slice(&hv.to_be_bytes());
        }
        out
    }

    fn compress(&mut self, chunk: &[u8]) {
        const K: [u32; 64] = [
            0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
            0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
            0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
            0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
            0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
            0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
            0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
            0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
            0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
            0xc67178f2,
        ];
        let mut w = [0u32; 64];
        for i in 0..16 {
            let s = &chunk[i * 4..i * 4 + 4];
            w[i] = u32::from_be_bytes([s[0], s[1], s[2], s[3]]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }
        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh] = self.h;
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let t1 = hh
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let t2 = s0.wrapping_add(maj);
            hh = g;
            g = f;
            f = e;
            e = d.wrapping_add(t1);
            d = c;
            c = b;
            b = a;
            a = t1.wrapping_add(t2);
        }
        self.h[0] = self.h[0].wrapping_add(a);
        self.h[1] = self.h[1].wrapping_add(b);
        self.h[2] = self.h[2].wrapping_add(c);
        self.h[3] = self.h[3].wrapping_add(d);
        self.h[4] = self.h[4].wrapping_add(e);
        self.h[5] = self.h[5].wrapping_add(f);
        self.h[6] = self.h[6].wrapping_add(g);
        self.h[7] = self.h[7].wrapping_add(hh);
    }
}

#[cfg(test)]
fn sha256(data: &[u8]) -> [u8; 32] {
    let mut ctx = Sha256Ctx::new();
    ctx.update(data);
    ctx.finish()
}

fn hex_of(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_engine_asset_name_platform() {
        let name = engine_asset_name();
        assert!(!name.is_empty());
        assert!(name.contains(ENGINE_TAG), "{name}");
        #[cfg(target_os = "macos")]
        assert!(name.starts_with("llama-b10276-bin-macos-"), "{name}");
        #[cfg(target_os = "linux")]
        assert!(name.starts_with("llama-b10276-bin-ubuntu-"), "{name}");
        #[cfg(target_os = "windows")]
        assert!(name.ends_with(".zip"), "{name}");
    }

    #[test]
    fn test_model_asset_name() {
        assert_eq!(model_asset_name("0.5b"), "Qwen2.5-0.5B-Instruct-Q4_K_M.gguf");
        assert_eq!(model_asset_name("1.5b"), "Qwen2.5-1.5B-Instruct-Q4_K_M.gguf");
        assert_eq!(model_asset_name("nope"), "Qwen2.5-0.5B-Instruct-Q4_K_M.gguf");
    }

    #[test]
    fn test_model_url() {
        assert!(model_url("0.5b").starts_with("https://modelscope.cn/models/second-state/"));
        assert!(model_url("0.5b").ends_with("Qwen2.5-0.5B-Instruct-Q4_K_M.gguf"));
        assert!(model_url("1.5b").contains("Qwen/Qwen2.5-1.5B-Instruct-GGUF"));
        assert!(model_url("1.5b").ends_with("Qwen2.5-1.5B-Instruct-Q4_K_M.gguf"));
    }

    #[test]
    fn test_engine_url() {
        let url = engine_url();
        assert!(url.starts_with("https://github.com/ggml-org/llama.cpp/releases/download/"));
        assert!(url.contains(ENGINE_TAG));
    }

    #[test]
    fn test_path_helpers() {
        assert_eq!(models_dir(Path::new("/d")), PathBuf::from("/d/models"));
        assert_eq!(
            state_path(Path::new("/d")),
            PathBuf::from("/d/models/summary_state.json")
        );
    }

    #[test]
    fn test_sha256_known_vectors() {
        assert_eq!(
            hex_of(&sha256(b"abc")),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            hex_of(&sha256(b"")),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            hex_of(&sha256(b"hello world")),
            "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
        );
        // 长度跨 64 字节块边界
        assert_eq!(
            hex_of(&sha256(&b"a".repeat(100))),
            "2816597888e4a0d3a36b82b83316ab32680eb8f00f8cd3b904d681246d285a0e"
        );
    }

    #[test]
    fn test_sha256_chunked_matches_oneshot() {
        let data: Vec<u8> = (0..1000).map(|i| (i % 251) as u8).collect();
        let mut ctx = Sha256Ctx::new();
        for chunk in data.chunks(7) {
            ctx.update(chunk);
        }
        assert_eq!(ctx.finish(), sha256(&data));
        // 空输入分块
        let ctx = Sha256Ctx::new();
        assert_eq!(ctx.finish(), sha256(b""));
    }

    #[tokio::test]
    async fn test_sha256_hex_file() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("f.bin");
        tokio::fs::write(&p, b"abc").await.unwrap();
        assert_eq!(
            sha256_hex(&p).await.unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn test_find_file_recursive() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("a/b")).unwrap();
        std::fs::write(tmp.path().join("a/b/llama-server"), "x").unwrap();
        assert_eq!(
            find_file(tmp.path(), "llama-server").unwrap(),
            tmp.path().join("a/b/llama-server")
        );
        assert!(find_file(tmp.path(), "missing").is_none());
    }

    #[test]
    fn test_downloader_holds_data_dir() {
        // start() 需要 AppHandle(事件 emit),此处只验证构造与目录派生
        let d = Downloader::new(PathBuf::from("/d"));
        assert_eq!(d.data_dir, PathBuf::from("/d"));
        assert_eq!(models_dir(&d.data_dir), PathBuf::from("/d/models"));
    }
}
