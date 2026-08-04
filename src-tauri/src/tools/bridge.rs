use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex as StdMutex;

use tokio::sync::oneshot;

use crate::error::{AppError, AppResult};

/// 插件工具的前端往返桥:request 发出 {kind:"tool_request", id, name, args},
/// 等待前端回调 resolve(id, result) 返回结果;10s 超时。
pub struct ToolBridge {
    pending: StdMutex<HashMap<String, oneshot::Sender<String>>>,
    emit: Option<Arc<dyn Fn(serde_json::Value) + Send + Sync>>,
}

impl ToolBridge {
    pub fn new() -> Self {
        Self {
            pending: StdMutex::new(HashMap::new()),
            emit: None,
        }
    }

    pub fn with_emitter<F>(mut self, f: F) -> Self
    where
        F: Fn(serde_json::Value) + Send + Sync + 'static,
    {
        self.emit = Some(Arc::new(f));
        self
    }

    /// Emits {kind:"tool_request", id, name, args} then waits for the frontend
    /// to call resolve(id, result). 10s timeout → AppError::Core("工具调用超时").
    pub async fn request(&self, name: &str, args: serde_json::Value) -> AppResult<String> {
        let id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id.clone(), tx);
        if let Some(emit) = &self.emit {
            emit(serde_json::json!({
                "kind": "tool_request",
                "id": id,
                "name": name,
                "args": args,
            }));
        }
        match tokio::time::timeout(std::time::Duration::from_secs(10), rx).await {
            Ok(Ok(res)) => Ok(res),
            Ok(Err(_)) => Err(AppError::Core("工具调用已取消".into())),
            Err(_) => Err(AppError::Core("工具调用超时".into())),
        }
    }

    pub fn resolve(&self, id: &str, result: String) -> bool {
        match self.pending.lock().unwrap().remove(id) {
            Some(tx) => tx.send(result).is_ok(),
            None => false,
        }
    }
}

impl Default for ToolBridge {
    fn default() -> Self {
        Self::new()
    }
}
