// 下载器:引擎二进制(llama.cpp releases) + 模型 GGUF(ModelScope 优先/HF 兜底)。
// 跨端 post-process 收在一个函数(Windows 解压 / macOS 清隔离 / Linux 设执行位)。
// 进度经 emit 发 download-progress 事件;sha256 下载后计算。
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter};
use crate::error::{AppError, AppResult};

#[derive(Clone, Copy, PartialEq)]
pub enum ModelSize { B05, B15 }

impl ModelSize {
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
            http: reqwest::Client::builder().build().expect("reqwest"),
            models_dir,
            app,
            engine_tag: "b10276".into(),
        }
    }

    /// 平台 → llama.cpp CPU 产物资产名 + 解压后可执行名。
    fn engine_asset(&self) -> (&'static str, &'static str) {
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

    /// 下载并落地,返回最终可执行/模型文件路径。
    pub async fn download(&self, what: DownloadWhat) -> AppResult<PathBuf> {
        std::fs::create_dir_all(&self.models_dir)?;
        let (url, final_name) = match what {
            DownloadWhat::Engine => {
                let (asset, _exe) = self.engine_asset();
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
        self.stream_to_file(&url, &tmp, &final_name).await?;
        std::fs::rename(&tmp, &final_path)?;
        // 跨端 post-process:引擎解压后原压缩包会被删除,故最终落地路径另行计算
        self.post_process(what, &final_path)?;
        let landed = match what {
            DownloadWhat::Engine => self.engine_path(),
            DownloadWhat::Model(size) => self.model_path(size),
        };
        // sha256 计算存盘(对最终落地文件,而非已删除的压缩包)
        let sha = sha256_file(&landed)?;
        let _ = self.app.emit("download-progress", &serde_json::json!({
            "what": what_label(what), "status": "done", "sha256": sha,
        }));
        Ok(landed)
    }

    async fn stream_to_file(&self, url: &str, tmp: &Path, what: &str) -> AppResult<()> {
        use futures_util::StreamExt;
        use tokio::io::AsyncWriteExt;
        let resp = self.http.get(url).send().await.map_err(|e| AppError::Core(format!("download {what}: {e}")))?;
        let status = resp.status();
        if !status.is_success() {
            return Err(AppError::Core(format!("download {what}: HTTP {status}")));
        }
        let total = resp.content_length().unwrap_or(0);
        let mut file = tokio::fs::File::create(tmp).await?;
        let mut stream = resp.bytes_stream();
        let mut done = 0u64;
        let started = std::time::Instant::now();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| AppError::Core(format!("download {what}: {e}")))?;
            file.write_all(&chunk).await?;
            done += chunk.len() as u64;
            let secs = started.elapsed().as_secs().max(1);
            let _ = self.app.emit("download-progress", &serde_json::json!({
                "what": what, "status": "downloading",
                "bytes": done, "total": total, "rate": done / secs,
            }));
        }
        file.flush().await?;
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
                let (_asset, exe) = self.engine_asset();
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
                    std::fs::remove_file(path)?;
                    Ok(())
                }
                #[cfg(not(target_os = "windows"))]
                {
                    let file = std::fs::File::open(path)?;
                    let gz = flate2::read::GzDecoder::new(file);
                    let mut tar = tar::Archive::new(gz);
                    let target = self.models_dir.join(exe);
                    for entry in tar.entries().map_err(|e| AppError::Io(e.to_string()))? {
                        let mut entry = entry.map_err(|e| AppError::Io(e.to_string()))?;
                        if entry.path()?.to_string_lossy().ends_with(exe) {
                            entry.unpack(&target)?;
                        }
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
        let (_asset, exe) = self.engine_asset();
        self.models_dir.join(exe)
    }
    pub fn model_path(&self, size: ModelSize) -> PathBuf {
        self.models_dir.join(size.file_name())
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
