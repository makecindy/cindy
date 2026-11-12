# #5406：真实 MessageStream 的正常 AX 路径复现

2026-10-03，源码基线 `d656b0fc1ec3e04548cd018654cbd6486f6cf839`。

本文记录修复前的组件复现；后续生产 CSS 改动及验证见 [修复报告](FIX-VALIDATION.md)。

## 已确认

当前源码中的 **MessageStream 及其真实消息子组件，可以在不调用 CDP、不启动 UIA 查询的条件下，
经正常页面帧更新触发与历史现场相同的 Blink 断言**。这已超出早先只复现相同 RVA 的合成 DOM 实验。
但仍不代表拿到了 #5406 的 0.1.96 原件，不能倒推该次原现场一定显示这个组件。

独立 Electron `41.10.3` / Chromium `146.0.7680.216`，Windows x64；
直接 import 未修改的 MessageStream、UserMessage、AssistantMessage、MarkdownRenderer 依赖图，
使用仓库 Tailwind 配置、globals.css、默认字号、内置 Cindy Light 主题及相同字体包。
截图与计算样式验证了真实消息布局：80 行、flex、14px gap、695px 高滚动容器、overflow-y:auto。

外壳只提供 MemoryRouter、ConfirmDialogProvider、Tooltip.Provider、英文翻译资源，
以及无特权的 `electronAPI.platform/logToMain` 测试值。没有真实 sessionId、账号、数据库或网络访问。
不是完整 Cindy 客户端黑盒验收；复现阶段没有修改生产代码或提出已修复结论。

## 实验矩阵

所有表内实验复用同一份完整字体、主题、样式的构建 `FHpmfo`，数据均为合成文本。
默认 80 条消息交替 user/assistant；每帧随机改 8 条文本，包含 Markdown 行内元素，周期改变滚动位置。
这是压力负载，**不是原现场的用户动作回放，也不等同于正常单条回复只追加 token**。

| 实验 | 条件 | 结果 | 末次采样文本更新 | 产物目录后缀 |
|---|---|---|---|---|
| A | seed5406，AX 开，containment 开，原生 UIA worker | 6,148ms，同签名 | 680 | FHpmfo |
| B | seed5407，AX 开，containment 开，**无 UIA / CDP 查询** | 16,202ms，同签名 | 2,560 | Q7FiAj |
| C | 与 B 同 seed/负载，仅取消 containment | 120,187ms，未崩溃 | 13,896 | H5wOJ0 |
| D | seed5407，只改助手回复，每帧 1 条，不滚动，无查询 | 60,175ms，未崩溃 | 3,340 | MIcc2x |
| E | seed5407，只改助手回复，每帧 8 条并滚动，无查询 | 6,831ms，同签名 | 632 | 6UuUhq |
| F | 与 E 同 seed/负载，仅取消 containment | 120,149ms，未崩溃 | 10,040 | 33haP5 |

更新计数为主进程最后一次采样值，不是 dump 中的准确崩溃瞬间计数。
A 的 UIA 计数尚未回传就已崩溃；不能声称它已完成了某次 UIA 文本查询。
B 未启动 UIA 进程、未 attach debugger，因而排除了“必须调用查询工具”这一条件。
C 将 `content-visibility` 改为 `visible`、`contain-intrinsic-size` 改为 `none`，没有改消息组件。
该受控对照支持消息行 containment 参与触发；有限时长未崩溃不等于生产修复验收。
E 表明无需修改用户消息，助手回复正文更新已足以触发；D 同时降低了更新量并停止滚动，
因此不能用 D 单独推断“滚动是必要条件”。E 的 dump 也已独立确认正常 AX 帧更新路径。
F 则对 E 做了单因素 containment 对照。两组对照 C/F 都完整运行 120 秒。

## 与现场完整栈的对照

A/B 都保留独立 dump，异常码 `0x80000003`、RVA `0xA332D17`、
PDB `D4DDA3CA101D876E4C4C44205044422E1` 三项完全一致。
DbgEng 展开并用相同 PDB 身份的官方 Breakpad 符号解析，A/B 各有 35 个物理帧，
包括 33 个 Electron 帧和两个系统帧；没有优化内联帧或 JS 栈恢复。

```text
RendererMain / RunLoop
cc::ProxyMain::BeginMainFrame
WebFrameWidgetImpl::DidBeginMainFrame
LocalFrameView::RunPostLifecycleSteps
LocalFrameView::RunAccessibilitySteps
AXObjectCacheImpl::SerializeAXUpdatesIfNeeded
SerializeUpdatesAndEvents / GetUpdatesAndEventsForSerialization
AXTreeSerializer::SerializeChanges / SerializeChangedNodes
AXObject::Serialize / SerializeInlineTextBox / SerializeLineAttributes
AXInlineTextBox::NeighboringOnLineWithAXBlockFlowIterator
AXBlockFlowIterator::NextOnLineAsIndex
AXBlockFlowData::ComputeNeighborOnLine [ax_block_flow_iterator.cc:183]
```

与 [历史现场](FIELD-COMPARISON.md) A 的关键路径和 Next 分支相同。
差异包括更深一层 SerializeChangedNodes 递归及栈底系统帧数量；不宣称逐地址完全相同。
两份组件复现都没有 InspectorAccessibilityAgent / getFullAXTree 帧。

**定位层次**：引擎故障在 Blink 的 AX 行内文本邻接计算；已证实可触发它的产品组件范围是
MessageStream 的消息行子树及其 `.msg-stream-items > *` containment 规则。
尚未从 native dump 反解具体 DOM 节点，因此不能指定某一个 Markdown span 或用户消息节点为唯一故障点。

## 复核命令及限制

```powershell
node apps/desktop/scripts/ax5406/run.mjs --scenario=component --seconds=60 --query=none --rows=80 --batch=8 --seed=5407
# 上一条会打印 AX5406_ARTIFACTS。后续将 <build-root> 换成该目录，复用相同构建：
node apps/desktop/scripts/ax5406/run.mjs --scenario=component --component-build=<build-root> --seconds=120 --query=none --rows=80 --batch=8 --seed=5407 --containment=off
```

构建、profile、截图和 dump 都在独立系统临时目录。原始生产 dump 不复制进仓库。
首次构建记录 renderer 源文件 SHA-256；每轮记录参数、脚本 SHA、实际布局、错误、更新数与签名。
采样包含计算样式、scrollHeight 等布局读取，且会保存一张组件截图；这些是实验的一部分，
尚未证明全部诊断读取都不是必要条件。

早期挂载失败（缺 Provider / Router）和缺 Tailwind 类的运行均排除在矩阵外。
中间完整 Tailwind、但尚未补齐主题／字体启动的实验也曾同签名崩溃，仅保留为辅助材料。
上述实验不验证账号链路、模型流式传输、深色模式视觉效果或完整客户端恢复行为。

本机实验根目录：`C:/Users/User/AppData/Local/Temp/cindy-ax5406-<表中后缀>/`。
其中 `report.json` 为每轮原始计数及签名，`component.png` 是真实组件截图；
A/B/E 另有 `stack.txt` 和 `symbolized-stack.json` 保存完整已展开栈。
`component-sources.json` 中 MessageStream、AssistantMessage、UserMessage、MarkdownRenderer、
globals.css 的 SHA-256 已与复现时源码逐一对上，未使用这些组件的替身；后续修复会改变 CSS。

验证：真实 renderer 构建通过；签名解析器正反例测试通过；脚本语法检查通过；
`pnpm --filter desktop run --if-present typecheck` 通过。矩阵 A–F 均没有记录 JS／renderer 错误，
各轮独立 profile 已自动清理，本次 Electron／UIA 测试进程已全部退出；诊断产物有意保留。
