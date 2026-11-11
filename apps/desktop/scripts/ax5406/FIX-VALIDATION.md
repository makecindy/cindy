# #5406 修复与验证

> 本文记录第一阶段“全部挂载、停用 auto”的方案。当前实现及验收以
> [视口挂载验收](VIEWPORT-VALIDATION.md) 为准，下面的 236ms 不代表当前方案。

2026-10-03，基线 `d656b0fc1ec3e04548cd018654cbd6486f6cf839`。

## 改动

`globals.css` 的 `.msg-stream-items > *` 改为 `content-visibility: visible` 和
`contain-intrinsic-size: none`。MessageStream 所有已挂载的消息行都参与真实布局，
移除已经实验证明参与 Blink AX 崩溃的跳过布局条件。

没有关闭无障碍、修改 Electron 版本或改变崩溃退出策略。默认尾窗首帧最多挂载 80 个条目，
锚点恢复另有首帧预算，滚动时按需扩窗；滚动锚点、尺寸缓存、分享与菜单的布局保护保留。
改动无颜色／主题分支，对 Light/Dark 同样生效。Windows 的组件验收使用 Light，
未做完整客户端、Dark 或 macOS 实机验收。

历史定位：消息行 `content-visibility: auto` 来自 `902fe3cb6`
（2026-08-09，`perf(chat): 视口外消息条目跳过布局绘制(content-visibility)`）。
这说明优化的引入点，不把它单独当作 #5406 原现场引入版本的证明。

## 原因链验证

复用 [真实组件复现](COMPONENT-REPRO.md) 的同一入口、seed5407、80 条合成消息、
每帧随机更新 8 条助手回复并滚动，AX 开启，不启用 UIA／CDP 查询：

| 版本 | 实际行样式 | 运行结果 | 末次采样更新数 | 产物后缀 |
|---|---|---|---|---|
| 原版冻结构建 FHpmfo | auto | 52,042ms 再次命中三项签名 | 6,816 | h28Noq |
| 当前修复源码构建 | visible | 120,332ms 正常结束，无 dump、无 JS 错误 | 10,008 | BwfjZy |
| 当前修复构建，seed5406，全部消息更新，UIA + CDP | visible | 121,028ms 正常结束，无 dump、无 JS 错误 | 12,176 | q0hXxU |

最后一轮额外覆盖原生 UIA 与 CDP：109 次完整 AX 树查询、最多观察到 10,197 个
InlineTextBox、368 次原生文本范围查询，查询错误为 0。两轮修复实验累计 22,184 次文本更新。

修复构建未使用 `--containment=off` 的实验注入覆盖；配置保持默认 `on`，
实际 `visible` 来自生产 CSS，源码 SHA-256 与构建记录相符。
旧版阳性对照确认故障依然可触发，避免把环境变化当作修复；崩溃时间受调度影响，
不要求同 seed 每次在同一毫秒出现。此轮旧版运行期间还有类型检查，耗时不用于性能比较。

旧版/新版两种构建均保留真实 MessageStream、AssistantMessage、UserMessage 和 MarkdownRenderer。
完整 native 栈证据和实验限制见组件报告。120 秒有界压力验证不等于所有负载下永不崩溃。

## 自动检查

- Desktop 类型检查通过：`pnpm --filter desktop run --if-present typecheck`。
- 定向单测 49 项通过，1 项既有 focused-only 50k 压测默认不运行：
  `shareSelectionContainment`、`messageViewportCompensation`、`messageItemHeightCacheIntegration`、
  `messageStreamRenderWindowIntegration`。
- CSS 契约测试将旧的“保留 auto 优化”要求更新为新修复契约，并检查所有更具体的消息行选择器
  都不得恢复跳过布局；原有分享状态及嵌套 Bot 消息保护断言保留。
- dump 三项签名解析器正反例测试、脚本语法检查及 `git diff --check` 通过。

## 性能测量方法

`benchmark-component.mjs` 交替运行冻结旧版／修复版，各三轮：200 条合成消息，
实际挂载尾窗 80 条；每帧更新末条回复，不手动滚动；每轮 15 秒，AX 在两边均关闭，
以免旧版在基准测试中崩溃。类型检查和单测已结束，六轮顺序运行。

记录页面 `first-contentful-paint` 与 React 提交次数。前者包含独立 fixture 的模块、
字体加载及首次挂载，**不是生产应用内的任务切换延迟**；后者只是该负载的更新吞吐，
不能代替完整输入延迟或卡顿分位数。关闭跳过布局会增加已挂载的视口外内容布局工作量，
有限窗口保留不等于零性能代价。

| 指标 | 旧版三轮 | 修复后三轮 | 中位数变化 |
|---|---|---|---|
| fixture 首次内容绘制（ms） | 768 / 776 / 740 | 1004 / 1016 / 996 | 768 → 1004，增加 236ms |
| 15 秒内 React 提交数 | 798 / 798 / 798 | 783 / 786 / 785 | 798 → 785，减少约 1.6% |
| 实际挂载行数 | 80 / 80 / 80 | 80 / 80 / 80 | 有限窗口仍有效 |

这项止崩修复有明确的首帧代价，不能写成“性能无影响”。本轮优先移除已证实的崩溃条件；
后续若需要恢复首帧收益，应通过渲染窗口预算或经引擎修复验证的方案实现，不能直接恢复 auto。
基准原始结果保存在系统临时目录 `cindy-ax5406-benchmark-ftjE7H/results.json`，
各轮 profile 已清理，截图和计数有意保留。

本次 Electron / UIA 实验进程全部退出。生产改动尚未提交、推送或发布；
当前正在运行的已安装客户端不会因 worktree 源码修改自动获得此修复。
