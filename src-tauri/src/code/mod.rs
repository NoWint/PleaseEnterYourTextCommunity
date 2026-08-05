//! 项目理解与代码分析:本地沙箱(local) + 数据源抽象(source)。
//! D2 代码分析地基;GitHub 数据源分支由 Task 2 补全。
//! 本模块由 Task 2/3 接入命令/工具层,在此之前按地基保留(dead_code 属预期)。

#![allow(dead_code)]

pub mod local;
pub mod source;
// 供 Task 2/3 接入使用;当前 crate 内暂无调用方(unused_imports 属预期)。
#[allow(unused_imports)]
pub use source::CodeSource;
#[allow(unused_imports)]
pub use source::CodeEntry;
