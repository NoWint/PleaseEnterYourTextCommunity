//! 项目理解与代码分析:本地沙箱(local) + 数据源抽象(source) + 轻量文件索引(index)。
//! D2 代码分析地基;source 的 CodeSource 由 Task 3 工具 / Task 4 命令接入使用。

pub mod index;
pub mod local;
pub mod source;

pub use source::CodeEntry;
pub use source::CodeSource;

use std::sync::{Arc, OnceLock};

use index::IndexCache;

/// 进程级索引缓存单例(spec §3.3):跨 bot / CodeSource 实例共享,
/// 避免每个 execute 新建 CodeSource 时重复全量扫描本地仓库。
pub fn global_index_cache() -> Arc<IndexCache> {
    static CACHE: OnceLock<Arc<IndexCache>> = OnceLock::new();
    CACHE.get_or_init(|| Arc::new(IndexCache::new())).clone()
}
