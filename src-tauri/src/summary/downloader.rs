// 下载器:引擎二进制(llama.cpp releases) + 模型 GGUF(ModelScope 优先/HF 兜底)。
// 跨端 post-process 收在一个函数(Windows 解压 / macOS 清隔离 / Linux 设执行位)。
// 进度经 emit 发 download-progress 事件,事件契约 what ∈ {"engine","model"},
// 前端按该契约过滤;sha256 下载后计算。
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use crate::error::{AppError, AppResult};

#[derive(Clone, Copy, PartialEq)]
pub enum ModelSize { B05, B15 }

impl ModelSize {
    /// "0.5b"/"1.5b" → 枚举;未知字符串兜底 0.5b。
    pub fn from_str_size(s: &str) -> Self {
        if s == "1.5b" { ModelSize::B15 } else { ModelSize::B05 }
    }
    pub fn file_name(&self) -> &'static str {
        match self {
            ModelSize::B05 => "qwen2.5-0.5b-q4km.gguf",
            ModelSize::B15 => "qwen2.5-1.5b-q4km.gguf",
        }
    }
    pub fn repo(&self) -> (&'static str, &'static str) {
        match self {
            ModelSize::B05 => ("second-state/Qwen2.5-0.5B-Instruct-GGUF", "Qwen2.5-0.5B-Instruct-Q4_K_M.gguf"),
            ModelSize::B15 => ("Qwen/Qwen2.5-1.5B-Instruct-GGUF", "Qwen2.5-1.5B-Instruct-Q4_K_M.gguf"),
        }
    }
}

#[derive(Clone, Copy)]
pub enum DownloadWhat { Engine, Model(ModelSize) }

pub struct Downloader {
    pub http: reqwest::Client,
    pub models_dir: PathBuf,
    pub app: AppHandle,
    pub engine_tag: String, // 锁定 tag, 如 "b10276"
}

impl Downloader {
    pub fn new(models_dir: PathBuf, app: AppHandle) -> Self {
        Self {
            // 必须带浏览器 UA:ModelScope 反爬拦截默认的 `reqwest/0.12.x` UA(实测返回 403),
            // 加 UA 后 200 OK。connect_timeout 防止代理/连接挂起导致「点下载无反应」。
            http: reqwest::Client::builder()
                .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36")
                .connect_timeout(Duration::from_secs(30))
                .build()
                .expect("reqwest"),
            models_dir,
            app,
            engine_tag: "b10276".into(),
        }
    }

    /// 平台 → llama.cpp CPU 产物资产名 + 解压后可执行名。关联函数,便于测试。
    fn engine_asset() -> (&'static str, &'static str) {
        #[cfg(target_os = "windows")]
        return ("llama-b10276-bin-win-cpu-x64.zip", "llama-server.exe");
        #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
        return ("llama-b10276-bin-macos-arm64.tar.gz", "llama-server");
        #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
        return ("llama-b10276-bin-macos-x64.tar.gz", "llama-server");
        #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
        return ("llama-b10276-bin-ubuntu-x64.tar.gz", "llama-server");
        #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
        return ("llama-b10276-bin-ubuntu-arm64.tar.gz", "llama-server");
    }

    /// 下载并落地,返回 (最终可执行/模型文件路径, sha256)。
    ///
    /// 说明:v1 采用"重新下载"策略(断点续传暂不实现)——中断后删除 .part 重新开始,
    /// 不实现 HTTP Range 分段续传;.part 命名保证最终文件不会出现半写状态,
    /// 前端亦无"继续"按钮,不存在 UI 契约不一致。
    pub async fn download(&self, what: DownloadWhat) -> AppResult<(PathBuf, String)> {
        std::fs::create_dir_all(&self.models_dir)?;
        let (url, final_name) = match what {
            DownloadWhat::Engine => {
                let (asset, _exe) = Self::engine_asset();
                (
                    format!("https://github.com/ggml-org/llama.cpp/releases/download/{}/{}", self.engine_tag, asset),
                    asset.to_string(),
                )
            }
            DownloadWhat::Model(size) => {
                let (repo, file) = size.repo();
                (
                    format!("https://modelscope.cn/models/{repo}/resolve/master/{file}"),
                    size.file_name().to_string(),
                )
            }
        };
        let tmp = self.models_dir.join(format!("{final_name}.part"));
        let final_path = self.models_dir.join(&final_name);
        // 事件契约统一用标签(engine/model)而非文件名;下载失败清理残留 .part
        if let Err(e) = self.stream_to_file(&url, &tmp, what_label(what)).await {
            let _ = std::fs::remove_file(&tmp);
            return Err(e);
        }
        if let Err(e) = std::fs::rename(&tmp, &final_path) {
            let _ = std::fs::remove_file(&tmp);
            return Err(e.into());
        }
        // 跨端 post-process:引擎解压后原压缩包会被删除,故最终落地路径另行计算
        self.post_process(what, &final_path)?;
        let landed = match what {
            DownloadWhat::Engine => self.engine_path(),
            DownloadWhat::Model(size) => self.model_path(size),
        };
        // sha256 计算是 1GB 级同步 IO,放阻塞线程池避免卡住 tokio worker
        // (JoinError 与 AppError 已有 From 实现,直接 ?)
        let landed_for_sha = landed.clone();
        let sha = tokio::task::spawn_blocking(move || sha256_file(&landed_for_sha)).await??;
        let _ = self.app.emit("download-progress", &serde_json::json!({
            "what": what_label(what), "status": "done", "sha256": sha,
        }));
        Ok((landed, sha))
    }

    async fn stream_to_file(&self, url: &str, tmp: &Path, label: &str) -> AppResult<()> {
        use futures_util::StreamExt;
        use tokio::io::AsyncWriteExt;
        let resp = self.http.get(url).send().await.map_err(|e| AppError::Core(format!("download {label}: {e}")))?;
        let status = resp.status();
        if !status.is_success() {
            return Err(AppError::Core(format!("download {label}: HTTP {status}")));
        }
        let total = resp.content_length().unwrap_or(0);
        let mut file = tokio::fs::File::create(tmp).await?;
        let mut stream = resp.bytes_stream();
        let mut done = 0u64;
        let started = std::time::Instant::now();
        let mut last_emit = std::time::Instant::now();
        // 进度节流:≥200ms 才发一次,避免 1GB 模型每块刷屏;闭包只读捕获 self.app
        let emit_progress = |done: u64, total: u64| {
            let secs = started.elapsed().as_secs().max(1);
            let _ = self.app.emit("download-progress", &serde_json::json!({
                "what": label, "status": "downloading",
                "bytes": done, "total": total, "rate": done / secs,
            }));
        };
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| AppError::Core(format!("download {label}: {e}")))?;
            file.write_all(&chunk).await?;
            done += chunk.len() as u64;
            if last_emit.elapsed() >= std::time::Duration::from_millis(200) {
                emit_progress(done, total);
                last_emit = std::time::Instant::now();
            }
        }
        // 收尾补发一次,保证最终进度(100%)必达
        emit_progress(done, total);
        file.flush().await?;
        // 大小校验:服务器声明了大小却未收满 → 下载不完整
        if total > 0 && done != total {
            return Err(AppError::Core(format!("download {label}: 下载不完整 {done}/{total}")));
        }
        Ok(())
    }

    /// 平台差异收在这一函数:Windows 解压 zip;macOS 清 quarantine;Linux 设执行位。
    fn post_process(&self, what: DownloadWhat, path: &Path) -> AppResult<()> {
        match what {
            DownloadWhat::Model(_) => {
                #[cfg(target_os = "macos")]
                {
                    let _ = std::process::Command::new("xattr").args(["-d", "com.apple.quarantine"]).arg(path).output();
                }
                Ok(())
            }
            DownloadWhat::Engine => {
                let (_asset, exe) = Self::engine_asset();
                #[cfg(target_os = "windows")]
                {
                    let file = std::fs::File::open(path)?;
                    let mut zip = zip::ZipArchive::new(file).map_err(|e| AppError::Io(e.to_string()))?;
                    let target = self.models_dir.join(exe);
                    for i in 0..zip.len() {
                        let mut entry = zip.by_index(i).map_err(|e| AppError::Io(e.to_string()))?;
                        if entry.name().ends_with(exe) {
                            let mut out = std::fs::File::create(&target)?;
                            std::io::copy(&mut entry, &mut out)?;
                        }
                    }
                    // 释放句柄再删压缩包(Windows 上文件句柄未关闭时删除更稳妥)
                    drop(zip);
                    if !target.exists() {
                        return Err(AppError::Core("引擎包内未找到 llama-server 可执行文件".into()));
                    }
                    std::fs::remove_file(path)?;
                    Ok(())
                }
                #[cfg(not(target_os = "windows"))]
                {
                    let file = std::fs::File::open(path)?;
                    let gz = flate2::read::GzDecoder::new(file);
                    let mut tar = tar::Archive::new(gz);
                    let target = self.models_dir.join(exe);
                    for entry in tar.entries()? {
                        let mut entry = entry?;
                        if entry.path()?.to_string_lossy().ends_with(exe) {
                            entry.unpack(&target)?;
                        }
                    }
                    if !target.exists() {
                        return Err(AppError::Core("引擎包内未找到 llama-server 可执行文件".into()));
                    }
                    std::fs::remove_file(path)?;
                    #[cfg(target_os = "macos")]
                    {
                        let _ = std::process::Command::new("xattr").args(["-d", "com.apple.quarantine"]).arg(&target).output();
                    }
                    #[cfg(target_os = "linux")]
                    {
                        use std::os::unix::fs::PermissionsExt;
                        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755))?;
                    }
                    Ok(())
                }
            }
        }
    }

    pub fn engine_path(&self) -> PathBuf {
        let (_asset, exe) = Self::engine_asset();
        self.models_dir.join(exe)
    }
    pub fn model_path(&self, size: ModelSize) -> PathBuf {
        self.models_dir.join(size.file_name())
    }

    /// 复制下载器实例(spawn 任务里 move 用;AppHandle/Client/PathBuf 均可 clone)。
    pub fn clone_dl(&self) -> Self {
        Self {
            http: self.http.clone(),
            models_dir: self.models_dir.clone(),
            app: self.app.clone(),
            engine_tag: self.engine_tag.clone(),
        }
    }
}

fn what_label(w: DownloadWhat) -> &'static str {
    match w { DownloadWhat::Engine => "engine", DownloadWhat::Model(_) => "model" }
}

fn sha256_file(path: &Path) -> AppResult<String> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let mut file = std::fs::File::open(path)?;
    let mut h = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 { break; }
        h.update(&buf[..n]);
    }
    Ok(format!("{:x}", h.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_size_file_names() {
        assert_eq!(ModelSize::B05.file_name(), "qwen2.5-0.5b-q4km.gguf");
        assert_eq!(ModelSize::B15.file_name(), "qwen2.5-1.5b-q4km.gguf");
    }

    #[test]
    fn model_size_repos() {
        assert_eq!(
            ModelSize::B05.repo(),
            ("second-state/Qwen2.5-0.5B-Instruct-GGUF", "Qwen2.5-0.5B-Instruct-Q4_K_M.gguf")
        );
        assert_eq!(
            ModelSize::B15.repo(),
            ("Qwen/Qwen2.5-1.5B-Instruct-GGUF", "Qwen2.5-1.5B-Instruct-Q4_K_M.gguf")
        );
    }

    #[test]
    fn what_label_values() {
        assert_eq!(what_label(DownloadWhat::Engine), "engine");
        assert_eq!(what_label(DownloadWhat::Model(ModelSize::B05)), "model");
        assert_eq!(what_label(DownloadWhat::Model(ModelSize::B15)), "model");
    }

    #[test]
    fn engine_asset_resolves_on_this_platform() {
        let (asset, exe) = Downloader::engine_asset();
        assert!(!asset.is_empty() && !exe.is_empty());
        #[cfg(target_os = "windows")]
        assert_eq!(exe, "llama-server.exe");
        #[cfg(not(target_os = "windows"))]
        assert_eq!(exe, "llama-server");
    }
}
