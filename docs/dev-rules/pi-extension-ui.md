# Pi 扩展 UI 兼容与安装

2026-09-11：Chris 确认，不兼容的展示能力在 Cindy 中间层统一过滤，兼容信息只放在设置中；
扩展安装沿用 Pi CLI 体验，显式操作直接执行，不追加扩展专属确认。

## 能力真源

按 Pi v0.84.4 的 [RPC 实现](https://github.com/earendil-works/pi/blob/v0.84.4/packages/coding-agent/src/modes/rpc/rpc-mode.ts)
及随包 `docs/rpc.md`、`docs/extensions.md` 核对。代码正本为
`packages/maker-core/src/agents/pi/extension-ui-capabilities.ts`；Desktop 静态兼容分析与
Pi 运行时分发共用它。更新 Pi 后按整张表核对，不为单一扩展添加例外。

| 能力 | Cindy 行为 |
| --- | --- |
| `select` / `confirm` / `input` / `editor` | 保留现有选择卡适配和响应；带有限 `timeout` 的请求取消并回传，避免扩展等待，不输出兼容警告 |
| `notify` | 保留扩展实际通知、命令结果和错误输出 |
| `setStatus` / `setWidget` / `setTitle` | RPC 单向展示请求，Cindy 静默忽略，不回传、不写聊天正文 |
| `setEditorText` / `pasteToEditor` | 上游发出 `set_editor_text`，Cindy 静默忽略，不改写输入框 |
| `setWorkingMessage` / `setWorkingVisible` / `setWorkingIndicator` / `setHiddenThinkingLabel` | Pi RPC 已不执行；保留原生行为 |
| `setFooter` / `setHeader` / `setToolsExpanded` / `setEditorComponent` / `addAutocompleteProvider` | Pi RPC 已不执行；保留原生行为 |
| `getEditorText` / `getToolsExpanded` / `getEditorComponent` | Pi RPC 分别返回空字符串、`false`、`undefined` |
| `custom` / `onTerminalInput` | Pi RPC 分别返回 `undefined`、空取消函数，不提供终端组件或按键 |
| `getAllThemes` / `getTheme` / `setTheme` | Pi RPC 分别返回空列表、`undefined`、失败结果；不伪造成功 |
| `theme` | Pi RPC 提供真实 theme 对象，读取和文字格式化可用，不应判成主题切换不兼容 |
| `registerShortcut` / `registerMessageRenderer` / `registerMarkdownTransformer` / `registerEntryRenderer` | 保留原生注册，Cindy 不承接终端快捷键和自定义渲染 |
| `registerFlag` | 保留注册及默认值，Cindy 固定启动参数没有扩展 flag 配置入口 |

Cindy 不修改第三方扩展源码、不将 `ctx.hasUI` 改成 false、不替换 Pi 原生空值或失败结果，
不因兼容分析停用整个扩展。未知 UI 请求同样不进入聊天正文；私有权限、包管理、子代理
控制请求仍先经现有处理链，不能被 UI 过滤吞掉。工具执行、命令、事件及消息能力继续交给 Pi。

设置页仍展示按源码发现的 API 限制。显式数字 `timeout` 的对话框列入交互限制；静态扫描
不能保证发现动态生成的参数或调用，不将“没有发现”视为完整兼容证明。

## 安装与授权

- 设置页点击安装或输入完整 `pi install <source>` 即授权，直接进入已有 Host 安装服务。
- 安装后默认启用；不因 TUI 限制、分析未知或分析失败再弹确认或要求批准扩展。
- Agent 自主工具调用沿用通用 Ask / Auto / Full Access；通过后没有第二层 Pi 包审批。
- Pi 原生命令失败正常反馈，Cindy 分析失败不能改判安装失败。用户已有停用偏好按现有
  安装／更新语义保留，不借 UI 过滤改动数据或原生资源发现。

现有入口与边界见 [`pi-managed-commands.md`](pi-managed-commands.md) 和
[`pi-harness.md`](pi-harness.md) §3.1。兼容提醒不得再作为 `text` 事件写回模型对话；
设置的兼容详情与扩展自己主动调用 `notify` 是不同来源，后者不能按文案删掉。
