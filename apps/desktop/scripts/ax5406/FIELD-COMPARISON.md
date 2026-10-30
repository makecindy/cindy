# #5406：本机历史现场与合成复现的调用栈对照

分析日期：2026-10-03。现场对照阶段仅本地读取、符号化；未上传转储或发表评论。

同日后续：[真实组件实验](COMPONENT-REPRO.md) 已在当前 MessageStream 中触发正常 AX 序列化路径，
并完成取消 containment 的对照。下文仍保留历史转储自身的证据边界，不能用实验倒推原件窗口身份。

## 结论与材料身份

**确认了历史同签名现场的引擎触发链；尚未确认 #5406 的 0.1.96 原现场或具体 React 组件。**

从本机默认 `Cindy/Crashpad/reports` 找到两份相同异常码、RVA 和 PDB 身份的转储。
不能因日期早就排除同源故障，但也不能把它们当作 Issue 所说的两份原件：

| 材料 | 转储内时间（北京时间） | Cindy 版本 | Windows build | 故障 renderer PID |
|---|---|---|---|---|
| A：a641a046-d6f9-451b-bd21-64a3c612675a.dmp | 2026-08-25 15:11:59 | 0.1.60 | 26200 | 41424 |
| B：e8c15294-12d4-4d9b-af05-0ea831a17d58.dmp | 2026-09-08 20:33:39 | 0.1.75 | 26200 | 38212 |
| #5406 描述 | 本轮没有原件可独立核对 | 0.1.96 | 26100 | 未知 |

A/B 的模块版本与 Crashpad `_version` 相互印证；时间取自 dump header，不依赖文件修改时间。
两者都标记 `process_type=renderer`、`renderer_foreground=true`、Electron `41.10.3`。
`ax_mode` 原始字段是 `kNativeAPIs | kWebContents | kInlineTextBoxes | kExtendedPropert`；
字段尾部已截断，不能由此还原完整模式或判断是哪个程序开启 AX。

三项共同签名：`0x80000003` / `Cindy.exe+0xA332D17` /
`electron.exe.pdb D4DDA3CA101D876E4C4C44205044422E1`。
A/B 均在 `AXBlockFlowData::ComputeNeighborOnLine` 的 `ax_block_flow_iterator.cc:183`
命中 `INT3`，寄存器 `r14=1`，断言分支要求的类型是 `2`。

## 触发链差异

两份历史现场共用以下调用方到故障点的路径：

```text
RendererMain / RunLoop
cc::ProxyMain::BeginMainFrame
WebFrameWidgetImpl::DidBeginMainFrame
LocalFrameView::RunPostLifecycleSteps / RunAccessibilitySteps
AXObjectCacheImpl::SerializeAXUpdatesIfNeeded
SerializeUpdatesAndEvents / GetUpdatesAndEventsForSerialization
AXTreeSerializer::SerializeChanges / SerializeChangedNodes
AXObject::Serialize / SerializeInlineTextBox / SerializeLineAttributes
AXInlineTextBox::NeighboringOnLineWithAXBlockFlowIterator
AXBlockFlowIterator::NextOnLineAsIndex       [A]
AXBlockFlowIterator::PreviousOnLineAsIndex   [B]
AXBlockFlowData::ComputeNeighborOnLine → CHECK / INT3
```

合成用例则从 `DevToolsSession → InspectorAccessibilityAgent::getFullAXTree →
BuildProtocolAXNodeForAXObject → AXObject::Serialize` 进入共同末段，沿 Previous 分支崩溃。
因此现有用例证明了**同一引擎断言可稳定触发**，没有复现完整历史入口。
历史栈内没有 Inspector/CDP 帧，不能认定当时是 `getFullAXTree` 工具调用导致；
也不能仅凭栈排除此前工具或系统辅助功能曾开启 AX。

## 9 月 8 日日志时间线

本地 `main-2026-09-08.log` 与 B 的秒级时间、转储文件名、版本相互对应：

| 北京时间 | 事件 | 原日志行 |
|---|---|---|
| 20:33:39（dump header） | renderer 38212 触发上述断言 | dump |
| 20:33:39.911 | 主进程记录 `render-process-gone: reason=crashed exitCode=-2147483645`，开始 shutdown | 451889–451890 |
| 20:33:40.684 | `runQuitDisposers completed` | 452238 |
| 20:33:40.696 | `Object has been destroyed`，BrowserWindow 清理回调异常 | 452240–452255 |
| 20:33:47.960 | 重启诊断确认前进程 31852，版本 0.1.75，exitCode=1，reason=render-process-gone:crashed；并列出 B | 452267–452268 |

`Object has been destroyed` 是 renderer 已崩溃后清理阶段的次生异常，不是此 native 崩溃的起点。
8 月 25 日同期日志不在现有保留范围，未作同等关联验证。

## 具体组件能确认到哪里

- **已确认的原生组件**：Blink accessibility 的 `AXInlineTextBox` / `AXBlockFlowIterator`，
  在正常帧更新后序列化行内文本的相邻关系时触发引擎断言。
- **窗口范围有限推断**：B 进入了 0.1.75 lifecycle 的全局退出分支。
  对照 `v0.1.75-beta` 源码，当时已隔离 webview guest、右侧栏、插件面板等已注册窗口；
  日志没有 webContents ID、renderer PID 到窗口的映射，不能进一步坐实主窗口身份。
- **产品组件仍是候选**：`MessageStream` 的 `.msg-stream-items > *` 在 0.1.60、
  0.1.75 及当前源码中都有 `content-visibility: auto` 与 `contain-intrinsic-size: auto 240px`，
  与合成复现条件相符。但是 dump 没有提供可直接对应 DOM／React 的 crash annotation，
  本轮没有取得故障节点到该组件的映射，不能把候选写成根因。

仍需取得 #5406 两份 **0.1.96 原始转储及对应日志**，复核其版本、签名和入口是否一致。
若原件也没有组件身份，下一步需在隔离环境载入真实 MessageStream，补上节点／窗口映射，
并通过正常 AX 帧序列化路径触发后再做 containment 对照；仅新增日志或数次未崩溃都不构成修复证据。

## 栈展开方法及限制

使用 Windows DbgEng 从 `.ecxr` 展开 x64 原生物理帧，再以 Electron 官方
[v41.10.3 符号包](https://github.com/electron/electron/releases/download/v41.10.3/electron-v41.10.3-win32-x64-symbols.zip)
的相同 PDB 身份 Breakpad FUNC/行号表解析。调用者用返回地址减一查源行。
A/B 各解析 32 个 Cindy/Electron 物理帧，末尾为未加载 Windows 私有符号的 `KERNEL32+0x2ccb7`。
未展开优化内联帧、未恢复 JavaScript 栈或 DOM 堆对象。DbgEng 的 export 猜测名称均不采信。
原输出存在映像 checksum、系统 DLL timestamp 及扩展 DLL 不可用警告；未以这些猜测定位函数，
源码归属依据单独校验的 PDB 身份和 RVA。此报告不把有限 minidump 称作完整内存快照。

Crashpad 元数据布局依据官方 [minidump_extensions.h](https://github.com/chromium/crashpad/blob/main/minidump/minidump_extensions.h)。
只提取版本、进程、AX 模式等允许字段，未输出任意内存字符串或用户内容。

原始 dump 留在原位置；本地符号化 JSON、DbgEng 输出及 SHA-256 在仓库外诊断目录保留。
下表中的长模板名缩写为 `<...>`，完整函数签名保留在本地 JSON。

## 全部已展开物理帧对照

顺序为故障点 → 调用方；RVA 为异常 PC 或原始返回地址，非调用指令起点。

| 帧 | A 函数 | A RVA | B 函数（相同记 =） | B RVA |
|---|---|---|---|---|
| 0 | blink::AXBlockFlowData::ComputeNeighborOnLine | 0xa332d17 | = | 0xa332d17 |
| 1 | blink::AXBlockFlowIterator::NextOnLineAsIndex | 0xa333561 | blink::AXBlockFlowIterator::PreviousOnLineAsIndex | 0xa333591 |
| 2 | blink::AXInlineTextBox::NeighboringOnLineWithAXBlockFlowIterator | 0xa33067e | = | 0xa3306a6 |
| 3 | blink::AXObject::SerializeLineAttributes | 0xa302cf9 | = | 0xa302d62 |
| 4 | blink::AXObject::SerializeInlineTextBox | 0xa2ff841 | = | 0xa2ff841 |
| 5 | blink::AXObject::Serialize | 0xa2fe5a4 | = | 0xa2fe5a4 |
| 6 | ui::AXTreeSerializer<...>::SerializeChangedNodes | 0x3adf174 | = | 0x3adf174 |
| 7 | ui::AXTreeSerializer<...>::SerializeChangedNodes | 0x3ade47a | = | 0x3ade47a |
| 8 | ui::AXTreeSerializer<...>::SerializeChangedNodes | 0x3ade47a | = | 0x3ade47a |
| 9 | ui::AXTreeSerializer<...>::SerializeChanges | 0xa2ef632 | = | 0xa2ef632 |
| 10 | blink::AXObjectCacheImpl::GetUpdatesAndEventsForSerialization | 0xa2ebbda | = | 0xa2ebbda |
| 11 | blink::AXObjectCacheImpl::SerializeUpdatesAndEvents | 0xa2eaa73 | = | 0xa2eaa73 |
| 12 | blink::AXObjectCacheImpl::SerializeAXUpdatesIfNeeded | 0xa2ea651 | = | 0xa2ea651 |
| 13 | blink::LocalFrameView::ForAllNonThrottledLocalFrameViews | 0x53c863d | = | 0x53c863d |
| 14 | blink::LocalFrameView::RunAccessibilitySteps | 0x363de6b | = | 0x363de6b |
| 15 | blink::LocalFrameView::RunPostLifecycleSteps | 0x363dbb6 | = | 0x363dbb6 |
| 16 | blink::WebFrameWidgetImpl::DidBeginMainFrame | 0x361143c | = | 0x361143c |
| 17 | cc::LayerTreeHost::DidBeginMainFrame | 0x2ea3483 | = | 0x2ea3483 |
| 18 | cc::ProxyMain::BeginMainFrame | 0x2e9cc97 | = | 0x2e9c244 |
| 19 | base::internal::Invoker<...>::RunOnce | 0xa34d11 | = | 0xa34d11 |
| 20 | base::TaskAnnotator::RunTaskImpl | 0x4f6149d | = | 0x4f6149d |
| 21 | base::sequence_manager::internal::ThreadControllerWithMessagePumpImpl::DoWork | 0x4f5c01d | = | 0x4f5c01d |
| 22 | base::MessagePumpDefault::Run | 0x4f7bb6a | = | 0x4f7bb6a |
| 23 | base::sequence_manager::internal::ThreadControllerWithMessagePumpImpl::Run | 0x23e4935 | = | 0x23e4935 |
| 24 | base::RunLoop::Run | 0x23fb4bc | = | 0x23fb4bc |
| 25 | content::RendererMain | 0x3297446 | = | 0x3297446 |
| 26 | content::RunOtherNamedProcessTypeMain | 0x95bafa | = | 0x95bafa |
| 27 | content::ContentMainRunnerImpl::Run | 0x95c811 | = | 0x95c811 |
| 28 | content::RunContentProcess | 0x95aefd | = | 0x95aefd |
| 29 | content::ContentMain | 0x95b153 | = | 0x95b153 |
| 30 | wWinMain | 0x20a360 | = | 0x20a360 |
| 31 | __scrt_common_main_seh | 0x5618fe2 | = | 0x5618fe2 |
| 32 | KERNEL32+0x2ccb7 | 系统模块 | = | 系统模块 |
