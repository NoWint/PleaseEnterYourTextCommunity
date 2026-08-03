use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use tauri::{AppHandle, Emitter, State};

use crate::error::AppResult;
use crate::state::AppState;

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

pub struct TerminalSessions(pub Mutex<HashMap<String, TerminalSession>>);

impl Default for TerminalSessions {
    fn default() -> Self {
        Self(Mutex::new(HashMap::new()))
    }
}

pub struct TerminalSession {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Option<Box<dyn Child + Send + Sync>>>,
}

#[derive(Clone, serde::Serialize)]
pub struct TerminalOutput {
    pub session_id: String,
    pub data: String,
}

fn default_shell() -> String {
    #[cfg(target_os = "windows")]
    {
        "cmd.exe".into()
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into())
    }
}

/// 启动一个 PTY shell 会话,返回 session_id。
#[tauri::command]
pub fn open_terminal(
    app: AppHandle,
    state: State<'_, AppState>,
    workdir: Option<String>,
) -> AppResult<String> {
    let pty_system = native_pty_system();
    let mut cmd = CommandBuilder::new(default_shell());
    if let Some(dir) = workdir.filter(|d| !d.trim().is_empty()) {
        cmd.cwd(dir);
    }
    let pair = pty_system.openpty(PtySize {
        rows: 24,
        cols: 80,
        pixel_width: 0,
        pixel_height: 0,
    })?;
    let writer = pair.master.take_writer()?;
    let child = pair.slave.spawn_command(cmd)?;

    let session_id = NEXT_ID.fetch_add(1, Ordering::Relaxed).to_string();

    // 后台线程:读取 PTY 输出,按 UTF-8 边界切分后推送到前端。
    let app2 = app.clone();
    let sid = session_id.clone();
    let mut reader = pair.master.try_clone_reader()?;
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        let mut pending: Vec<u8> = Vec::new();
        loop {
            let n = match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => n,
                Err(_) => break,
            };
            pending.extend_from_slice(&buf[..n]);
            let mut consumed = 0;
            while consumed < pending.len() {
                let chunk = &pending[consumed..];
                let mut usable = chunk.len();
                for cut in 1..=3.min(chunk.len()) {
                    let cand = chunk.len() - cut;
                    if std::str::from_utf8(&chunk[..cand]).is_ok() {
                        usable = cand;
                        break;
                    }
                }
                if usable == 0 {
                    break;
                }
                let s = String::from_utf8_lossy(&chunk[..usable]).into_owned();
                let _ = app2.emit(
                    "terminal-output",
                    TerminalOutput {
                        session_id: sid.clone(),
                        data: s,
                    },
                );
                consumed += usable;
            }
            pending.drain(..consumed);
        }
        let _ = app2.emit(
            "terminal-output",
            TerminalOutput {
                session_id: sid,
                data: "\r\n[终端会话已结束]\r\n".into(),
            },
        );
    });

    state.terminals.0.lock().unwrap().insert(
        session_id.clone(),
        TerminalSession {
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            child: Mutex::new(Some(child)),
        },
    );
    Ok(session_id)
}

/// 向指定会话写入输入。
#[tauri::command]
pub fn write_terminal(state: State<'_, AppState>, session_id: String, input: String) -> AppResult<()> {
    let sessions = state.terminals.0.lock().unwrap();
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| crate::error::AppError::Core("终端会话不存在".into()))?;
    let mut writer = session.writer.lock().unwrap();
    writer.write_all(input.as_bytes())?;
    writer.flush()?;
    Ok(())
}

/// 同步终端尺寸。
#[tauri::command]
pub fn resize_terminal(
    state: State<'_, AppState>,
    session_id: String,
    cols: u32,
    rows: u32,
) -> AppResult<()> {
    let sessions = state.terminals.0.lock().unwrap();
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| crate::error::AppError::Core("终端会话不存在".into()))?;
    let master = session.master.lock().unwrap();
    master.resize(PtySize {
        rows: (rows.max(2)) as u16,
        cols: (cols.max(2)) as u16,
        pixel_width: 0,
        pixel_height: 0,
    })?;
    Ok(())
}

/// 结束指定会话。
#[tauri::command]
pub fn close_terminal(state: State<'_, AppState>, session_id: String) -> AppResult<()> {
    let mut sessions = state.terminals.0.lock().unwrap();
    if let Some(session) = sessions.get(&session_id) {
        if let Some(mut child) = session.child.lock().unwrap().take() {
            let _ = child.kill();
        }
    }
    sessions.remove(&session_id);
    Ok(())
}
