# DeepSeek Harness（DSH）集成与验收

更新日期：2026-08-19
状态：实现已进入当前工作区；自动化验证与真实 API 验收分别记录，不以未实际发出的真实请求替代。

## 定位

DSH 是 Cindy 的 DeepSeek Harness agent。它沿用现有的 DeepSeek 供应商配置，并作为该供应商下的一个
`dsh` runtime 与 Claude Code、Codex、Pi 并列；不得再为 DSH 创建平行的内置 DeepSeek 供应商。它不是
其它 runtime 的别名，也不是一个可任意改写协议的通用 HTTP 表单。

一个 DSH 任务始终由“已选择的来源 + 已选择的模型”确定。即使多个来源使用相同模型 ID，也必须按已选择
的来源读取配置与密钥，不能仅凭模型 ID 跨来源猜测或回落。

### 所有权边界

| 层 | 负责 | 不负责 |
| --- | --- | --- |
| Renderer | 配置、来源/模型选择、状态呈现、输入限制 | 凭证裁决、启动进程、DSH 内部执行流程 |
| Desktop Main | 按所选来源解析路由与密钥，持有本地/远程 transport 和进程生命周期 | 按模型猜来源、改写 DSH 插件或内部工作流 |
| maker-core adapter | 生成最小启动交接、JSONL/RPC 翻译、关闭与失败清理 | Electron 打包进程选择、用户凭证持久化 |
| DSH runtime | 实际执行流程及其插件、技能、工具与子 Agent 编排 | Cindy 的设置 UI、供应商持久化与安全存储 |

Cindy 的长期职责是 DSH 的呈现与双向传输入口，DSH 自己拥有内部执行流程和插件配置。当前
`packages/maker-core/src/agents/dsh/composition.ts` 仍由 Cindy 生成一部分 Cordis boot graph，这是已知的
过渡偏差：后续只能收缩并迁回 DSH 所有的 package/契约，不能继续在 Cindy 侧扩展 DSH 内部流程。

## 自定义来源配置

在设置的自定义供应商编辑页选择 **DSH** runtime。该 runtime 必须使用 **API 密钥**鉴权，可配置的
非敏感字段为：

- Base URL；
- 每个模型的 ID、显示名称与上下文窗口；
- 每个模型的思考强度：`off`、`low`、`high` 或 `max`。

DSH 固定由 Harness 的 DeepSeek adapter 处理协议和会话配置，因此不暴露、也不得持久化下列通用 runtime
字段：请求路径、wire protocol、自定义 headers、models URL、模型自动拉取或每模型 route。

### 保存语义

Base URL、模型、上下文窗口与思考强度都是非敏感配置。它们可以在尚未填写 DSH 专用 API 密钥时保存，并且
重新打开编辑页后应仍然存在。旧版已经保存的 DeepSeek 预设会在读取时补上当前预设的 DSH runtime，下一次
普通保存再把它写回原来的供应商记录，不创建第二个来源。

这个顺序是故意的：用户可先建立或修正运行时配置，再在合适的时候补密钥。空密钥绝不能阻止非敏感配置保存。

### 兼容恢复边界

DSH 是随客户端发布的 Harness 能力，远端模型目录不负责单独开关它。目录合并时，如果同 ID 的 DeepSeek
预设尚未携带 `dsh` runtime，要从随包预设窄范围补回；即使远端快照的版本号已经是当前版本，也不能因此
把客户端已有的 DSH 页签遮掉。远端已经明确提供的 runtime 和模型字段仍然优先。

历史数据只做以下有限恢复，不把临时错误固化成公开别名：

- 已保存但缺少 DSH 的 DeepSeek 行，只能通过稳定的 Pi 目录标记 `piCatalogProviderId: deepseek` 识别，不能
  根据显示名或可变的数据库 ID 猜测；读取时投影 DSH，下一次普通保存再写回同一行。
- 曾被故障版本写入会话的 `deepseek`、`custom:deepseek` 或空来源 ID，只允许在恰好一个用户供应商能提供所选
  DSH 模型时恢复到该供应商；存在多个候选时必须失败并要求重新选择。
- `deepseek` 与 `custom:deepseek` 仅是入站历史数据的修复条件，不能重新出现在供应商目录、模型选择器或新
  会话持久化结果中。

## 凭证边界

自定义来源的 DSH 密钥不写入 `custom_providers` 配置行。它由主进程的安全存储独立保存，逻辑键为：

```
provider_key_<provider-id>_dsh
```

DSH 专用密钥优先。为兼容 DSH runtime 出现前已经保存的原 DeepSeek 配置，如果专用槽为空，可以复用**同一
供应商内**另一个 runtime 的密钥，但前提是两个 runtime 规范化后的凭证端点完全一致。这个兼容读取不复制
密钥、不修改其它 runtime，也不会创建新的供应商。

兼容读取顺序为 DSH 专用槽、Codex、Pi、Claude Code。端点比较保留路径和 query 的差异，只忽略 fragment 与
末尾斜杠；因此 `https://api.deepseek.com` 可以互认，`https://api.deepseek.com/anthropic` 不能互认。

因此以下隔离是硬约束：

- DSH 只读取当前所选供应商自己的凭证；
- DSH 专用密钥存在时绝不被其它 runtime 覆盖；
- 供应商不同或端点不同，一律不得复用密钥；
- 不存在独立的内置 DeepSeek 密钥槽或平行 DeepSeek 来源。

故障测试构建曾写过的平行槽 `provider_key_deepseek` 没有进入正式发布，不得读取、复制或当作自动迁移来源；
保留的本机测试槽也不自动删除。需要继续使用该密钥时，由用户在原 DeepSeek 供应商的 DSH 页明确保存。若未来
有正式版本写入过类似槽，必须另做可审计、同来源的迁移，不能把本条当作兼容实现。

若发送时出现“DSH API key is not configured for the selected provider”，先确认当前选中的原 DeepSeek
供应商里至少有一个与 DSH 使用相同端点的已存密钥，或直接填写 DSH 专用密钥；不要跨供应商复制凭证。

## 选择与运行时行为

模型选择器按已连接供应商的 DSH runtime 投影可选模型。发起任务时，主进程把选定来源的 Base URL、
模型清单、上下文窗口和该模型的思考强度传给 DSH adapter；adapter 使用“专用槽优先、同来源同凭证端点
兼容回退”解析出的密钥启动 Harness。

相关实现入口：

- `apps/desktop/src/renderer/components/settings/CustomProviderDialog.tsx`：编辑、保存与无密钥保存语义；
- `apps/desktop/src/main/maker-host/custom-provider-store.ts`：`dsh` runtime 校验与持久化；
- `apps/desktop/src/main/maker-host/dsh-host.ts`：按选中来源解析 DSH vendor options 与密钥；
- `packages/model-providers/src/user-provider.ts`：把用户配置投影为 DSH catalog 来源；
- `packages/maker-core/src/agents/dsh/`：Harness 配置、JSON-RPC 桥接与事件翻译。

### 思考事件翻译契约

DSH SDK 的 reasoning block 必须按固定顺序投影为 Cindy thinking 事件：首个 `reasoning-delta` 先产生一次
`start`，紧接着为首个文本分片产生同 `blockId` 的 `delta`；之后每个文本分片继续产生 `delta`，对应
`block-end` 最后产生一次 `final`。翻译层不得重排或合并事件；同一个 SDK block index 在结束前必须一直映射
到同一个 `blockId`。

`final` 是完整载荷，不是只有阶段名称的结束标记。其 `data` 必须同时包含：

- `text: string`：优先使用 SDK `block-end` 给出的完整 reasoning 文本；终块未携带文本时，回退为此前所有
  delta 文本按到达顺序拼接。热路径应累计分片后一次拼接，避免随流长度产生平方级复制；
- `durationMs: number`：从首个 delta 的 `startedAt` 计算，必须是有限且非负的毫秒数。

跨版本运行时、IPC 和历史持久数据仍可能带来畸形载荷，因此消费侧同时保持以下防线：

- Renderer 收到缺少 `final.text` 的事件时，保留已经流式累积的 thinking 内容，不得用 `undefined` 覆盖；
- 没有任何 `start` / `delta` 的空 final 退化为空占位，不生成 thinking 卡片；
- 最近工作活动投影和完整展开视图遇到非字符串 `content` 时跳过该行，不得让单条坏数据中断整条消息流。

消费侧容错不放宽生产侧契约：新版本 DSH translator 仍必须发出完整的 `text` 与 `durationMs`，使 Main 的持久化
与 Renderer 的最终状态一致。若再次出现 `projectThinkingMessage` 读取 `.trim()` 的异常，应先检查 translator
发出的 `final` 载荷，再检查 Renderer 是否错误覆盖了已收到的 delta；不要通过隐藏整个工作过程来规避。

回归覆盖分别位于 `packages/maker-core/src/agents/dsh/translator.test.ts`、
`apps/desktop/src/renderer/__tests__/emptyThinkingPlaceholder.test.ts`、
`workActivityProjection.test.ts` 与 `workGroupBlockLivePreview.test.tsx`，需要同时覆盖正常完整终块、终块缺文本、
Renderer 保留流式文本以及折叠/展开两条畸形历史数据路径。

### 持久状态与跨端投影

`dsh` 必须作为正式 `agentKind` 贯穿任务记录、输入队列快照、Agent 切换意图、新任务草稿、来源和模型选择；
应用重启后不能回退成 Claude Code，也不能丢掉所选来源。`runtimeConnected.dsh` 是追加式的展示事实，让同一
供应商的其它 runtime 保持可用时仍能准确表示 DSH 是否有密钥；旧 peer 可以退回供应商级 `connected` 展示，
但最终发送始终由 Main 重新解析并校验，不能信任 Renderer 或远端控制端自报的连接态。

## 本地进程边界与初始化排障

正式 Electron 包会禁用 RunAsNode，`process.execPath` 指向的是 `electron.exe`，不是可随意执行脚本的 Node。
如果直接把它当 Node 去启动 DSH bridge，结果通常是再次拉起 Cindy/Electron，而不是建立 JSONL RPC；调用方
最终只会看到 `dsh RPC timeout after 30000ms: initialize`。

Desktop 本地路径因此必须由主进程提供 transport：使用 `utilityProcess.fork` 启动专用 ESM worker，由 worker
安装虚拟 stdin 后加载随包 DSH 入口。主进程只通过 JSONL 和受限环境变量与它通信；不得重新引入
`ELECTRON_RUN_AS_NODE`，也不得让 maker-core 猜测 Electron 的打包进程边界。启动任一步骤失败时，先关闭
transport，再清理临时配置，避免留下孤儿进程。

worker 的 `ready` 只证明 parentPort 和虚拟 stdin 已就绪；RPC `initialize` 成功才证明 DSH bridge/Harness
真正可用。stdout 是 JSON-RPC 专用通道，诊断只能走脱敏后的 stderr，不能把密钥、完整环境变量或协议 stdout
写入日志。

常见报错按边界排查：

- `DSH API key is not configured for the selected provider`：尚未进入子进程初始化，检查当前来源的 DSH 专用
  密钥或同来源、同凭证端点的兼容密钥。
- `dsh RPC timeout ... initialize`：检查 Desktop 是否实际使用 `utilityProcess` transport、worker 是否被打包、
  ready 握手和 JSONL stdout 是否连通；这时尚不能归因于上游 API，也不要用“重新建一个 DeepSeek 供应商”
  规避。
- `DSH utility process did not become ready`：检查 worker 入口、parentPort 与 Forge 打包产物。
- `DSH runtime failed to load` 或进程提前退出：检查 ESM/ASAR 依赖闭包和随包 DSH 入口。
- `DSH provider selection is ambiguous`：会话仍带故障版本的来源 ID，且当前有多个合格 DeepSeek 来源；让用户
  重新选择原供应商，不能静默猜一个。
- `initialize` 成功后才出现的 HTTP 错误：再检查 Base URL、密钥权限、网络与上游服务状态。

对应实现入口为 `apps/desktop/src/main/maker-host/dsh-local-transport.ts`、
`dshRuntimeWorkerProcess.ts` 和 `packages/maker-core/src/agents/dsh/transport.ts`。

## 输入限制

DSH 目前是 **text-only**：文本输入受支持，图片和文件输入不受支持。无论上游地址或模型名称如何，调用链都
不得把图片、文件或其内容序列化并发送给 DeepSeek / DSH。

变更此限制需要同时修改 capabilities、输入校验、附件路由和测试；仅放开 UI 不是有效实现。

## 验收流程

自动化验证与真实密钥验证应分开记录。提交前至少运行：

```powershell
pnpm test:unit:related
pnpm --filter desktop run --if-present typecheck
pnpm --filter @cindy/maker-core run --if-present typecheck
pnpm --filter @cindy/model-providers run --if-present typecheck
pnpm check:i18n-glossary
```

验证要分层记录，不能用较低层的通过代替较高层：

| 层级 | 入口与证明范围 | 不证明 |
| --- | --- | --- |
| 配置/来源/凭证单测 | `custom-provider-store.test.ts`、`dsh-host.test.ts`、model-providers 测试；证明 round-trip、来源隔离、兼容回退与目录投影 | 子进程和正式包 |
| maker-core 协议集成 | `dshHarness.integration.test.ts`；普通 Node 中运行真实 DSH JS 和 fake HTTP，证明 boot/JSONL/文本流 | Electron Fuses、ASAR、`utilityProcess`、真实 API |
| Desktop transport | `dsh-local-transport`/worker 的定向测试；证明 ready、虚拟 stdin、env 白名单、失败关闭 | 正式打包依赖闭包 |
| 正式包 smoke | 打包后的 Electron 启动一轮 DSH；证明 worker 入包、RunAsNode 仍关闭、无 `electron.exe packaged-bin.js` 孤儿 | 用户密钥权限和上游可用性 |
| SSH smoke | 远程 Node transport 启动并关闭 DSH | 本地 Electron transport |
| 真实 API 人工验收 | 用户密钥、实际上游和 text-only 完整往返 | 其它账号、地区或网络环境 |

当前 Node 集成测试不能覆盖 Electron worker 的 Fuses/ASAR/虚拟 stdin/失败清理；若正式包 smoke 未执行，交付
记录必须明确写“未验证”，不能写成已覆盖。

使用真实 API 密钥进行测试时，按以下步骤验收，且只发送纯文本：

1. 新建或编辑一个自定义供应商，在 DSH 页填写 Base URL、模型、上下文窗口和思考强度，先不填写密钥并保存。
2. 关闭再打开编辑页，确认上述非敏感字段仍存在。
3. 在同一来源的 DSH 页保存该来源自己的 API 密钥，确认该来源变为已连接。
4. 新建任务，选择 DSH、该来源和其中一个模型，发送一条短的纯文本消息并确认收到流式回复。
5. 尝试附图或文件时应被拒绝；不得为了测试而把附件送往 DSH。

真实 API 成功与否取决于用户自己的密钥、权限、网络和上游服务状态，不能由 fake-stream 集成测试代替。

## 维护清单

- 改动 DSH 配置、密钥路径、来源选择或 session 持久化时，重跑上面的门禁和对应定向测试；
- 改动 DSH system prompt、Harness 配置或事件翻译前，先遵守 `docs/dev-rules/maker-core-and-agent-behavior.md`
  与 `docs/dev-rules/pi-harness.md` 中适用的 agent/harness 规则；
- 密钥只允许在设置编辑会话中短暂进入受控 Renderer 表单；不得进入 `custom_providers`、provider registry、
  device-link、日志、仓库或任务 transport payload，启动 DSH 时必须由 Main 重新解析；
- 新增任何用户可见文案时，按 `i18n/GLOSSARY.md` 和五个 locale 的同步要求处理。
