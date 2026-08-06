pub mod ask;
pub mod onboard;
pub mod pipeline;
pub mod store;

use std::sync::Arc;

use crate::db::Db;

pub use pipeline::{HistoryFn, LlmFn};

/// 知识库模块装配:store 数据访问 + pipeline 总结入库 + ask 问答 + onboard 新人引导。
/// llm 由集成者注入真实实现(调智能运行时),四个组件共享同一注入。
pub struct Knowledge {
    pub store: store::KnowledgeStore,
    pub pipeline: pipeline::SummarizePipeline,
    pub ask: ask::AskEngine,
    pub onboard: onboard::OnboardService,
}

impl Knowledge {
    pub fn new(db: Arc<Db>, llm: LlmFn) -> Self {
        Self {
            store: store::KnowledgeStore::new(db.clone()),
            pipeline: pipeline::SummarizePipeline::new(db.clone(), llm.clone()),
            ask: ask::AskEngine::new(db.clone(), llm.clone()),
            onboard: onboard::OnboardService::new(db, llm),
        }
    }
}
