//! GitHub 访问层:纯函数端点(api) + DTO/解析(types) + HTTP 客户端(client)。
//! 工具与界面命令都复用此模块作为 GitHub 数据源。

pub mod api;
pub mod client;
pub mod types;

pub use api::*;
pub use client::*;
pub use types::*;
