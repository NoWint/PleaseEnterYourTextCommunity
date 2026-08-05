//! 项目理解与代码分析:本地沙箱(local) + 数据源抽象(source) + 轻量文件索引(index)。
//! D2 代码分析地基;source 的 CodeSource 由 Task 3 工具 / Task 4 命令接入使用。

pub mod index;
pub mod local;
pub mod source;
// 供 Task 3/4 接入使用;当前 crate 内暂无外部调用方(unused_imports 属预期)。
#[allow(unused_imports)]
pub use source::CodeSource;
#[allow(unused_imports)]
pub use source::CodeEntry;
