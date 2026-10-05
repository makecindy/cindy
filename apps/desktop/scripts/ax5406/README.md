# Issue #5406：Windows 无障碍文本崩溃复现

这是独立 Electron 引擎实验，**不会启动 Cindy 应用或访问正式 profile**。仅载入合成文本，
无账号、模型、真实消息、插件、网络页面或 OS 输入注入。它不属于默认单测，也不修改应用
的无障碍设置、Electron pin 或崩溃退出策略。

## 已确认的证据（2026-10-03）

- [流式输出专项验证](STREAM-VALIDATION.md)：已对齐绘制时序并与修改前 HEAD 对照，
  短暂离底读数是绘制前中间态；最终实际绘制检查通过，保留原始失败证据。
- 搜索、回底及逐帧直接跳转的继续定位与最新修正见 [导航验证](NAVIGATION-VALIDATION.md)。
  [增强滚动测试](SCROLL-VALIDATION.md) 保留较早阶段的失败证据，不代表当前最终结果。
- 最新方案为视口挂载 + 普通布局，画面、交互及性能结果见 [视口挂载验收](VIEWPORT-VALIDATION.md)。
- 当前源码已停用消息行跳过布局，修复后实跑与性能代价见 [修复验证报告](FIX-VALIDATION.md)。
  下文的原版阳性结果对应修复前源码；新构建默认不再应当复现。
- **新增：真实 MessageStream 已经复现正常 AX 帧更新路径**，无 UIA / CDP 查询也能触发。
  同 seed 取消消息行 containment 后运行 120 秒未崩溃；完整栈与历史现场关键链路一致。
  详见 [组件复现报告](COMPONENT-REPRO.md)。以下最小 DOM 实验是此前的证据，不能混用入口。
- 本机 Windows 11 x64，Electron **41.10.3** / Chromium **146.0.7680.216**。
- 12 个带 `content-visibility: auto` 的段落，每帧改一个段落内 `span.textContent`，
  同时通过 CDP 请求完整 AX 树，能产生与 #5406 摘要完全相同的签名。
- 不需要 React、Markdown 重写、滚动、折叠、自动化输入或 Cindy 任务。
  模拟器保留了每两帧一次 `getBoundingClientRect()`；尚未证明该读取是否必要。
- 三个 seed（5406、5407、5408）分别于 **944、550、638 ms** 崩溃，均有独立 dump。
- `--containment=off` 保持其他条件，120 秒 / 7,190 次文本更新 / 2,538 次 CDP 查询，未崩溃。
- `--ax=off`，120 秒 / 7,192 次文本更新，未崩溃（关闭 AX 时也不发送 AX 查询）。
- `--query=none` 保留无障碍开启，120 秒 / 7,190 次文本更新，未崩溃。
- 最终脚本再次运行最小用例，971 ms 命中同签名；profile 清理路径已实跑。
- 原生 Windows UIA 的另外一轮 30 秒实验完成 2,154 次文本/行范围查询，未崩溃；
  动态节点上有 13 次模式不可用错误。该路径不能冒充已复现。

匹配规则同时检查以下三项；只有断点异常不算命中：

```text
ExceptionCode: 0x80000003
Module RVA:    0xA332D17
PDB GUID/age:  D4DDA3CA101D876E4C4C44205044422E1
```

### 原生调用栈

复现 dump 用 Windows SDK 的 DbgEng 进行 x64 栈展开，再用 Electron 官方
`electron-v41.10.3-win32-x64-symbols.zip` 中 **相同 PDB 身份**的 Breakpad FUNC/行号记录
解析地址。没有把未加载私有符号时出现的 `sqlite3_dbdata_init+巨大偏移` 当成真实函数。
31 个 Electron 原生帧均解析到函数及源文件/行号，栈底还有两个 Windows 系统帧。
优化内联帧没有额外展开；这不是完整内存转储，也不是原现场转储。

主要路径（调用方 → 故障点）：

```text
RendererMain / RunLoop / Mojo / DevToolsSession
Accessibility::DomainDispatcherImpl::getFullAXTree
InspectorAccessibilityAgent::getFullAXTree
AddChildren / BuildProtocolAXNodeForAXObject
BuildProtocolAXNodeForUnignoredAXObject
AXObject::Serialize
AXObject::SerializeInlineTextBox
AXObject::SerializeLineAttributes
AXInlineTextBox::NeighboringOnLineWithAXBlockFlowIterator
AXBlockFlowIterator::PreviousOnLineAsIndex
AXBlockFlowData::ComputeNeighborOnLine
  ax_block_flow_iterator.cc:183, 函数 RVA 0xA332B30 + 0x1E7
```

故障寄存器 `r14=1`，对应普通文本类型；分支要求类型为 `2`（生成文本），失败后执行
`INT3`。这与 Issue 的断言描述一致。

### 结论边界

已经有可重复触发同一引擎断言的合成用例。另外已独立展开本机两份历史现场 dump，
分别属于 **0.1.60（2026-08-25）** 和 **0.1.75（2026-09-08）**，均命中相同签名。
两份历史栈都经正常帧生命周期中的 AX 增量序列化到达断言，**没有 CDP 调用帧**；
前者求下一行内节点，后者求上一行内节点。详见 [现场对照报告](FIELD-COMPARISON.md)。
这些不是 Issue 所述的 0.1.96 原件，不能代替其独立复核，也未确认具体 DOM／React 组件。
本实验经 CDP `getFullAXTree` 触发，不能据此认定历史现场或 Issue 原现场也调用了该工具。
最小 DOM 用例没有载入 Cindy 组件；新增 `--scenario=component` 直接构建当前真实 MessageStream。
关闭 containment 的结果只是受控对照，不等于生产修复已验收。

验证：签名解析器单测通过（精确匹配、错误码/RVA/GUID/age反例、损坏数据）；脚本语法检查
通过；`pnpm --filter desktop run --if-present typecheck` 通过。仅 Windows 实跑，
未对 macOS 做结论。没有改生产代码、提交、推送或发表 Issue 评论。

## 运行

先按仓库环境文档在当前 worktree 安装依赖。使用 Windows x64；不使用安装版 Cindy.exe。
默认解析当前 checkout 的 `electron` 包（不会主动下载或升级引擎）。

```powershell
node apps/desktop/scripts/ax5406/run.mjs --seconds=15 --scenario=minimal --scroll=off --rows=12 --batch=1
node apps/desktop/scripts/ax5406/matrix.mjs
pnpm --filter desktop exec vitest run scripts/ax5406/inspect-dump.test.mjs
```

每轮会打开一个不抢焦点的实验窗口，结束/崩溃后自动关闭。独立 OS 临时目录打印为
`AX5406_ARTIFACTS=...`，保存 `config.json`、`report.json`、`electron.log`、`dumps/`；
新运行记录 fixture SHA-256。生成的 profile 退出后删除，诊断证据有意保留供复核。
外层有时长 +40 秒 watchdog，只结束本次创建的进程树。

退出码：`0` = 本轮完成且未崩溃；`10` = dump 三项签名全匹配；`2` = 其他崩溃、超时、
负载/查询未验证等。`0` **不表示已修复**，矩阵会原样记录每一组结果。

常用选项：

| 选项 | 默认 | 含义 |
|---|---|---|
| `--scenario` | `stream` | `minimal`、`stream`、`detach`、`visibility`、`inline`、`mixed`、`component` |
| `--seconds` | `120` | 5–600 秒 |
| `--seed` | `5406` | 非零 uint32，固定 PRNG 操作序列（帧/CDP调度仍异步） |
| `--rows` / `--batch` | `80` / `8` | 段落数量 / 每帧修改数量 |
| `--containment` | `on` | `off` 强制可见布局，不使用 intrinsic 占位 |
| `--ax` | `on` | `off` 禁用本次实验 renderer 的无障碍，也不执行 AX 查询 |
| `--query` | `cdp` | `native`、`both`、`none`；native 仅查本次 HWND 并校验其 PID |
| `--scroll` | `on` | 是否改变容器滚动位置；最小用例使用 `off` |
| `--rewrite` | `on` | stream 是否重写 inline HTML；minimal 无此操作 |
| `--component-build` | 无 | component 模式复用已有 AX5406 产物根目录中的同一份构建 |
| `--target` | `all` | component 文本更新目标：all / assistant / user / tail；不是生产开关 |

## 转储与符号复核

```powershell
node apps/desktop/scripts/ax5406/inspect-dump.mjs <dump.dmp>
```

此工具只读异常/模块/PDB元数据，**不会**展开栈或输出任意内存字符串。
测试防止把不同异常码、相邻 RVA、不同 PDB GUID/age 误判为命中。

有 WinDbg/CDB 时使用 `.ecxr; kv 100; lmv a @rip`。也可在 VS x64 Native Tools shell
中编译这里的离线 DbgEng 前端，将 exe/obj 放在仓库外临时目录：

```text
cl /EHsc <repo>\apps\desktop\scripts\ax5406\stack-windows.cpp /link dbgeng.lib
stack-windows.exe <dump.dmp> <本地符号目录>
```

保存它的 stdout 为 `stack.txt`，从官方 release 下载匹配的 symbols 包后运行：

```text
node apps/desktop/scripts/ax5406/symbolize-stack.mjs <dump.dmp> <stack.txt> <electron.exe.sym>
```

脚本检查 `MODULE` 的 PDB 身份，丢弃 DbgEng 的 Electron export 猜测，按真实异常 PC
和展开后的返回地址查函数/行号。原始 dump、符号包及用户日志不放进 Git，也不上传。
若需调试局部变量或展开优化内联帧，另取官方完整 PDB；本轮未下载 3.76 GB 的完整 PDB。
