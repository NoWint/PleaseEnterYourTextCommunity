# 3D 球状词云设计

日期:2026-08-06
状态:设计定稿
范围:把总结看板左侧 sd-canvas 的 2D 词云替换为 Canvas 2D 手写 3D 可拖拽球状词云。

## 1. 背景与动机

### 1.1 现状

- 看板左侧导航有 240px 宽玻璃侧栏,内含 `sd-canvas`(240×150 canvas)。
- 当前 `drawCloudAsync` 用 `drawWordCloud`(wordCloud.ts)做 2D 瀑布堆叠词云。
- 视觉突兀:平铺词 + 静态,与看板 Apple 风格(弹簧/玻璃)不协调。

### 1.2 目标

1. **3D 球状词云**:词分布在一个 3D 球面上,透视投影成 2D(近大远小 + 前亮后暗)。
2. **交互**:
   - 拖拽:指针拖动旋转球(§2 1:1 跟踪),松手带惯性缓停(§5 速度衔接)。
   - 自动慢转:无操作时球绕 Y 轴缓慢自转,拖拽打断。
   - 点击词条:高亮 + 显示词频(气泡提示 count/weight)。
3. **Apple 设计**:弹簧惯性(阻尼 ~0.85)、玻璃底、reduced-motion 降级。

### 1.3 非目标

- 不引入 Three.js 等依赖(Canvas 2D 手写,零新增依赖)。
- 不改词云词数据来源(computeTopWords 复用)。
- 不动词频模式弹窗(openWordAnalysisPopup 的 2D 词云保留;仅看板 sd-canvas 换 3D)。

## 2. 实现

### 2.1 数据

`computeTopWords(msgs, resolve, 14)` → `WordFreq[]`(word/count/weight),取 Top ~14 词。

### 2.2 3D 布局

- 球半径 R = min(w, h) * 0.42。
- 词点均匀分布在球面:Fibonacci 球(黄金角)避免极点堆积。
- 每个词:3D 坐标 (x,y,z),字号 ∝ sqrt(weight),颜色沿用 CLOUD_COLORS。

### 2.3 投影

- 旋转矩阵:绕 X(俯仰)/Y(偏航)旋转,叠加拖拽增量。
- 透视:z 越近越大(`scale = persp / (persp + z)`,persp ≈ R*2),z 越近越亮/不透明。
- 背面词(z < 0)半透明,前面词清晰。

### 2.4 交互

- **拖拽**:pointerdown 记录起点 → pointermove 计算 delta → 更新旋转角;`setPointerCapture` 保持 1:1(§2)。
- **惯性**:pointerup 记录最近几帧速度,动画循环按指数衰减(阻尼 0.9)继续旋转,直到低于阈值(§5/§6)。
- **自动慢转**:无交互时 Y 轴 +0.003 rad/帧;拖拽/惯性期间暂停。
- **点击**:命中检测(投影后与词 bbox 距离 < 半径)→ 高亮放大 + 显示词频 tooltip(词 + N 次)。

### 2.5 渲染循环

- `requestAnimationFrame` 持续重绘(§11 合成友好,只画 canvas 内部)。
- 每帧:清空 → 词按 z 排序(近的在上面)→ 逐个投影绘制(字号/alpha 随深度)。
- `will-change: transform` 提示浏览器。

### 2.6 reduced-motion

`prefers-reduced-motion: reduce` → 禁用自动慢转/惯性,只响应拖拽,静置球。

## 3. 结构

新组件 `src/components/cloudSphere.ts`:
- `mountCloudSphere(canvas, words: WordFreq[]): () => void`(返回销毁函数,清理监听 + rAF)。
- 内部:球点生成、旋转状态、投影、事件绑定、渲染循环。

summaryDashboard.ts 的 `drawCloudAsync` 改为调 `mountCloudSphere`。

## 4. 错误处理

- 分词失败 → 空球/静默(现有 try/catch)。
- 词 < 3 个 → 退化为静态平铺(球无意义)。
- 拖拽超界 → 正常旋转(无界,手感自由)。

## 5. 测试

- 词点数量 = 输入词数。
- 拖拽 delta → 旋转角增量正确。
- 惯性衰减收敛(角度不再变)。
- reduced-motion 下无自动旋转。
- 点击词 → 高亮 + tooltip 词频。

## 6. 兼容性

- 仅替换看板 sd-canvas 绘制;词频弹窗(openWordAnalysisPopup)的 2D 词云不动。
- 词数据源不变。
