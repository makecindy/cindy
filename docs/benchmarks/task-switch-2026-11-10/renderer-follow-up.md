# 任务切换：第二批渲染通知优化

2026-11-10，在第一批修复之上继续测量。结论是减少了一部分切换后的渲染工作，
尚未消除长任务。代码未发布，不能把本报告当作正式版本的性能承诺。

## 原因与修改

任务标题、侧栏内容、侧栏开关和注册回调原先共用 `FeatureSidebarSlotContext`。
标题注册更新会通知只读取侧栏状态的组件，也会反过来通知只负责注册内容的组件。
实机采样中切换后的长任务包含侧栏与任务页重复渲染；生产 Provider/Hook 的最小回归
进一步验证：单次标题变更让注册组件执行两次，并额外唤醒侧栏。

本轮仅将 `feature-context.tsx` 拆为侧栏状态、标题内容和稳定注册回调三类 Context。
公开 Hook、状态来源、布局 DOM、同步注册时机均保留。离开页面时标题仍清空，
侧栏仍保留上一次内容及其内部状态。未修改输入法、光标、草稿存储或权限判定。

## 对比方式

- Windows，同一台机器、同一隔离 `--mock` Electron 开发实例、1280 × 800 浅色窗口。
  Node 24.14.1、Electron 42.11.12；沿用第一批的模拟任务及 30 个无订阅合成插件。
- 两版都保留第一批全部修复，只切换 `feature-context.tsx`。
  改前为该文件的 `70eb974da4d3792cc5feabc8bdc9ee1e1f06233d` 版本，改后为本轮工作区版本。
- `benchmark-task-switch-phases.cjs` 预热四个任务，每次运行切换 12 次、各跑三次。
  顺序为前1、后1、后2、前2、前3、后3。每版第一轮带 CPU profiler，另两轮关闭。
  测量期间未并行运行本任务的构建、单测、类型检查或 UI 检查。
- 切换计时从自动化点击开始，等目标路由、主内容区目标标题显示及两次动画帧；
  **包含自动化调度开销**，不等于操作系统输入延迟或全部异步资源加载完成。
  每次随后分别记录聚焦、输入固定文本、全选、清空和静置；不发送消息。
- 使用浏览器 Long Tasks API，阈值为 50 ms。所有有效长任务都落在上述切换区间。
  原诊断脚本只等 URL，因此把延后提交的页面工作误分到了“聚焦”；本报告已修正终点。
  **本轮切换耗时不可直接与第一批仅等待路由的 83.93 ms 合并比较。**
- 一次前3测量遭遇页面刷新、丢失采样记录，已作废并补跑；脚本增加文档代次检查，
  刷新期间的数据不写作有效结果。以下仅统计六次完整有效运行。

[逐轮原始数据](renderer-results.json)包括每一步耗时、长任务起止、测试顺序及是否开启采样。

| 指标 | 第一批修复后 | 本轮追加优化后 | 变化 |
| --- | ---: | ---: | ---: |
| 切换耗时中位数，36 次 | 290.88 ms | 284.88 ms | -2.1% |
| 切换耗时 P95 | 348.44 ms | 316.23 ms | -9.2% |
| 长任务累计耗时 | 3329 ms | 2973 ms | -10.7% |
| 单次长任务中位数 | 92 ms | 84 ms | -8.7% |
| 最长长任务 | 121 ms | 100 ms | -17.4% |
| 长任务数量 | 35 | 35 | 未减少 |

三组切换中位数的改后值均较改前低，但总体改善幅度小，尤其 2.1% 的中位数变化
不能排除机器调度噪声。长任务总量的下降与通知隔离的回归证据一致，不能据此声称卡顿已解决。
输入阶段包含人为设置的逐字间隔，耗时中位数为 690.66 → 698.44 ms，未显示输入加速；
两版聚焦、输入、全选、清空阶段均未观测到 ≥50 ms 长任务。

排除各自带 CPU profiler 的第一轮后，每版余下 24 次切换的中位数为 287.86 → 274.43 ms，
P95 为 348.44 → 305.85 ms，长任务累计耗时为 2191 → 1924 ms。方向一致，但样本仍然有限。

这是开发构建，采样含大量 React 开发态检查。尚未测量安装包、大量历史消息或原上传日志
的完整负载，也未在 macOS 实测。本改动使用跨平台 React 状态机制，无系统分支。

复测命令（先通过仓库启动器打开隔离模拟实例，禁止连接正式 profile）：

```powershell
node apps/desktop/scripts/benchmark-task-switch-phases.cjs <label> <output-directory> <cdp-port> [profile]
```

## 功能验证

- 6 个相关文件、311 项测试通过，覆盖新通知隔离回归、标题清理、侧栏状态保留，
  以及实际侧栏、标题栏、伙伴私聊/群聊和插件主视图。新测试在旧实现上两项失败，修改后全部通过。
  新文件单独运行 1.37 s（包括 pnpm 为 2.71 s）。群聊测试输出非阻断的 React `act` 警告。
- Desktop TypeScript 检查与测试卫生检查通过。
- Windows 原生窗口点击切到模拟任务，以 `SendInput` 写入 `native draft retained`，
  切至另一任务后返回；新 UIA 快照及原生截图确认原任务标题与草稿保留，未发送消息。
  该操作验证不能替代原生输入延迟的压力对比。

### 扩大界面检查的限制

`pnpm ui:check --changed --theme all` 因共享 Context 被 126 个页面入口加载而扩大到大量无关场景。
运行 2254.65 s 后，为调查重复失败而主动停止：已执行 1222 个变体，其中 1121 个通过、100 个失败，
另 1 个执行中被本次停止操作中断；其余计划场景没有完成。**这一轮整体失败，不能计作 UI 全量通过。**
失败涉及群聊、模型选择器、邮件/PR iframe、供应商配置等场景；详细原始回执保留在本地
`artifacts/ui-check/changed-ckgfHB/summary.json`。群聊默认场景的浅色和深色截图已目检。

从上述 12 类页面各选一个失败用例，另补供应商向导断言失败用例，共 13 个浅色场景，
用相同场景分别渲染 HEAD 与当前实现。构建回执确认两边实际加载的差异只有
`feature-context.tsx`，没有混入第一批修复。结果如下：

| 代表用例 | 修改前/后对照结果 |
| --- | --- |
| `group-chat/body-answer`、`im-default-model/default` | 两边同样缺少 AuthProvider |
| `model-protocol-paths/default` | 两边同样缺少宿主模拟 API `getModelPriceOverride` |
| `provider-detection/cloudflare-gateway-scheme`、`provider-template-catalog/address-sub2api-0` | 两边同样在点击禁用的完成按钮时超时；场景没有勾选模型 |
| `provider-template-catalog/wizard-moonshot-kimi-global` | 两边同样失败：`missing selected model codex` |
| `provider-share-sources/subscription-pool` | 两边同样未找到预期的 5 小时用量项 |
| `group-jump-bottom/thread-process`、`model-selector-performance/stress` | 两边重跑均通过；此前的几何/动效失败没有复现 |
| `mail-reading/default`、`plugin-install-mail/participant-avatars`、`pr-popover/default`、`pr-task-archive/default` | 两边重跑均通过；此前的 iframe 脚本阻止报错没有复现 |

即 7 个代表用例的新旧实现同样失败，6 个两边均通过，没有观察到只在改后发生的失败。
另外对 `group-chat/long-thread` 进行浅色/深色前后对照，两种模式在两边均通过，
此前的历史滚动位置断言失败没有复现。
这不能代表原先 100 个失败全部完成归因；未逐个重放的用例仍未验证，也没有修改或弱化它们的断言。
[结构化验收数据](renderer-ui-validation.json)保留选取范围、各用例结果与运行时清理回执。
上述单个用例可用以下命令复核：

```powershell
pnpm ui:check --page <page> --case <case> --theme light --compare 70eb974da4d3792cc5feabc8bdc9ee1e1f06233d
```

性能测试所启动的完整隔离客户端、原生窗口操作会话，以及这一轮 UI 检查运行时均已关闭；
UI 检查回执确认 `runtimeClosed: true`、`scratchRemoved: true`。测试未操作正式版任务或发送消息。
