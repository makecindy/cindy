# Prime Agent 注册为第四种 harness —— 目标 / 约束 / 验收标准 / 执行方案

> 状态：方案已定，**待用户确认后执行**。
> 基线：`makecindy/cindy` @ `v0.1.120-beta`，分支 `feat/prime-agent-harness`，HEAD `b544df1`。
> 前置 PR：#7884（L1 协议适配，已 open / mergeable / DCO pass）。

---

## 一、目标

**一句话**：把 Prime Agent 接成 Cindy 的第四种 harness——用户能在 Cindy 的新建会话里选到它，建会话、发消息、收到回复、切模型与思考强度。

### 为什么这件事有独立价值

Cindy 已有三种 harness（claude-code / codex / pi）。Prime Agent 是 Prime Intellect 的开源 RLM
coding agent（Rust 构建），其 `--mode rpc` 协议与 pi 高度同构（JSONL/stdio、信封形状一致），
但有一个硬缺口：**Cindy 的 turn 状态机只认 `agent_settled`，Prime Agent 全仓只有 `agent_end`**。
L1（协议适配）已解决这个缺口；L2 要做的是**把这个已完成的适配器接到产品的其余部分**。

### 分层目标与完成定义

| 层 | 内容 | 完成的客观定义 | 状态 |
|---|---|---|---|
| **L1 协议适配** | Prime Agent 协议 → Cindy `AgentEvent` 的 adapter | 协议往返正确 + turn 能收口 + 真二进制实测 | ✅ #7884 |
| **L2 注册可用** | `prime-agent` 成为用户可选的引擎 | **用户在 GUI 里完成一次真实对话** | ⬜ 本方案 |
| **L3 分发可得** | 新装 Cindy 的用户不手动装就能拿到二进制 | 打包版自动下载 + sha256 校验通过 | ⬜ 部分在仓外（见 §2.5） |

L2 是本方案的范围。L3 单独排期，理由见约束 2.5。

---

## 二、约束

### 2.1 仓库规则（硬，我无权豁免）

| 规则 | 出处 | 对本次的具体约束 |
|---|---|---|
| 每个 commit 带 `Signed-off-by`，名字/邮箱与 author 逐字一致 | `AGENTS.md` / DCO App | `git commit -s`；PR 上 DCO check 是硬门禁 |
| Conventional Commits `type(scope): subject` | PR 模板 | scope 用 `maker-core` / `desktop` |
| PR-first，非默认分支 | `AGENTS.md` | 从 `feat/prime-agent-harness` 派生新分支 |
| 启动失败要区分「已确认退出」与「关闭未确认」 | `dev-rules/maker-core-and-agent-behavior.md` | L1 已实现；L2 不改这块 |
| translator / model 映射 / usage 计量的改动要**实测四项指标** | 同上 §3.4 | L2 触及 model 映射 → PR 正文必须写「影响哪几个指标 / 怎么测 / 实测结论」 |
| maker-core 零 Electron 依赖 | `maker-core/AGENTS.md` | 不 import electron |
| 不改 system prompt 未经 owner 确认 | 同上 §4 | L2 不碰 system prompt |
| i18n 五语齐全（en / zh-CN / zh-TW / ja / ko） | `apps/desktop/src/renderer/i18n/` | 新增文案要五语同步 |

### 2.2 任务书纪律（L1 阶段，已被用户授权解除登记点限制）

- L1 只新建 `packages/maker-core/src/agents/prime-agent/` 下的文件 + 测试 → **已遵守**
- L1 不改 `types/common.ts` / `localDb/schema.ts` / i18n / `preload.ts` / `maker-host/index.ts`
  → **L2 必须改**（`AgentKind` 是闭集 union，不动它就没有第 4 个值可注册）
- L1 不 commit / push / PR → 已逐项解除

### 2.3 产品决策（用户）

| 决策 | 推导出的技术后果（L2 同样成立） |
|---|---|
| 不需要权限审批 | 不注入 cindy-bridge、不实现 `extension_ui_request` |
| Prime Agent 自带 provider 与内联密钥，不接 Cindy 模型通道 | 不写 `writeModelsJson`；**Prime Agent 的模型不来自 Cindy 模型目录** |
| 由此无 MCP 工具面 | 不写 MCP 网关 |

### 2.4 环境约束

| 限制 | 绕法（已验证） |
|---|---|
| 全量 git pack 会 early EOF（`invalid index-pack output`） | `--filter=blob:none` 浅克隆 + 稀疏检出 |
| 稀疏检出下 `pnpm install` 会重写 `pnpm-workspace.yaml` 收窄工作区 | **不跑 pnpm install**，直接调 `node node_modules/typescript/bin/tsc` 等 |
| 你对上游只有 READ 权限、无 fork | 已建 `tao1213213/cindy` fork，PR 走 fork→upstream |
| 环境 `GITHUB_TOKEN` scope 不足（fork 403） | `unset GITHUB_TOKEN` 用 keyring 的 `gho_` 凭据 |
| `C:/开发/cindy工作区` 是知识库控制台（其 `CLAUDE.md` 明令「不要在本工作区里另建副本」） | 代码工作在 `C:/Users/78227/cindy-dev` |

### 2.5 L3 的仓外依赖（唯一无法单方面完成的部分）

- **开发期链路可纯代码完成**：Prime Intellect 有官方 R2（`pub-728493de92a943e2a9b2d17b4719f318.r2.dev`）
  与 GitHub Releases（`PrimeIntellect-ai/prime-agent`），产物是**整目录 tar.gz**（与 pi 同构）。
- **打包版需要 CDN 侧配合**：Cindy 打包版只认自己 CDN 的 `manifest-<platformKey>.json`，
  需要 ①上传 tar.gz ②加 `primeAgent` 段。**那条 manifest 写入流水线不在公开仓库里**
  （仓内只有「读取并合并 manifest」的消费者；`release-*.mjs` 在 tag 里不存在；
  `.github/workflows/` 无二进制发布 workflow）。
- **平台缺口**：Prime Agent 无 win32-arm64 构建（Rust 矩阵只有 `x86_64-pc-windows-msvc`）。
- 结论：**L3 不在本方案范围**。L2 假设二进制已就位（开发期手动装或走开发期链路）。

---

## 三、调研结论：L2 要改的全部点

调研发现「加一种 agent」在 Cindy **不是一个开关**，而是 6 个独立闭集 + 3 张运行时数据表的同步改动。
仓库用**穷尽映射**（`Record<…>`）把「漏改」从运行时 bug 提前到编译错误——这是本方案能可靠执行的关键。

### 3.1 类型闭集（6 个独立声明，必须同步）

| # | 位置 | 现状 | 备注 |
|---|---|---|---|
| T1 | `packages/maker-core/src/types/common.ts:8` | `export type AgentKind = 'claude-code' \| 'codex' \| 'pi';` | **权威源** |
| T2 | `packages/maker-core/src/types/events.ts:182` | `source?: 'claude-code' \| 'codex' \| 'pi';` | |
| T3 | `packages/maker-core/src/types/events.ts:108` | `AgentTaskUpdateEventData.provider` | Prime Agent 无子代理 → 实际不会出现，但类型要通 |
| T4 | `packages/maker-core/src/types/capabilities.ts:288` | `newSessionDefault?: (...)[]` | 手机端模型选项的区域门控 |
| T5 | `packages/maker-core/src/types/customizations.ts:29` | `engine: 'claude-code' \| 'codex' \| 'pi'` | |
| T6 | `packages/maker-core/src/agents/base-agent.ts:684` | `scanLocalCustomizations` 的 `engine` | |
| T7 | `packages/maker-shared/src/agentCapabilities.ts:13, 366-367` | 类型 + **运行时过滤器** | 见 §3.2 D1 |
| T8 | `packages/maker-shared/src/agentTask.ts:141, 336, 433, 488, 591` | 5 处 | 591 是 provider 兜底推断 |
| T9 | `packages/maker-shared/src/deviceLinkContract.ts:272, 282, 579` | 2 类型 + 1 **正则** | 见 §3.2 D2 |
| T10 | `packages/maker-shared/src/orcaTeam.ts:19` | `OrcaWorkerAgentKind` | 见 §3.2 D3 |
| T11 | `packages/maker-shared/src/scheduleTypes.ts:2` | `RemoteScheduleAgentKind` | |
| T12 | `packages/maker-shared/src/subagentWorkspace.ts:11` | `SubagentProvider` | Prime Agent 无子代理 |
| T13 | `packages/model-providers/src/types.ts:25` | **独立声明的 `AgentKind`**（注释：与 maker-core 对齐） | 4th 副本 |
| T14 | `packages/maker-scheduler/src/types.ts:2` | **独立声明的 `AgentKind`** | 5th 副本 |
| T15 | `apps/desktop/src/renderer/lib/ccAgent.types.ts:29` | `export type AgentKind = 'cc' \| 'codex' \| 'pi';` | **renderer 侧独立命名**（`cc` 非 `claude-code`） |
| T16 | `apps/desktop/src/shared/newMakerDefaultTuple.ts:15` | `type MakerVendor = 'cc' \| 'codex' \| 'pi' \| 'orca'` | 本地重复声明 |

### 3.2 运行时数据表与分支（必须显式处理，否则静默走错分支）

| # | 位置 | 形状 | 不改的后果 |
|---|---|---|---|
| **D1** | `packages/maker-shared/src/agentCapabilities.ts:365-368` | `newSessionDefault.filter(item => item === 'claude-code' \|\| item === 'codex' \|\| item === 'pi')` | **prime-agent 被静默丢弃**。既有测试 `agentCapabilities.test.ts:87` 断言 `['claude-code','codex','pi']`，要同步改 |
| **D2** | `packages/maker-shared/src/deviceLinkContract.ts:579` | `AGENT_NOT_AUTHENTICATED_RE = /…(claude-code\|codex\|pi) not authenticated: ?(.*)$/` | 手机端识别不出 prime-agent 的未鉴权提示 |
| **D3** | `packages/maker-shared/src/orcaTeam.ts:209` | `function agentKind(value) { return value === 'codex' \|\| value === 'pi' ? value : 'claude-code'; }` | **prime-agent 被当成 claude-code** |
| **D4** | `packages/maker-shared/src/orcaTeam.ts:29` | `DEFAULT_ORCA_WORKER_MODELS: Record<OrcaWorkerAgentKind, string>` | 加 T10 后**编译报错**（缺 key）→ 强制显式决定默认模型。有益护栏 |
| **D5** | `apps/desktop/src/renderer/lib/agentVendors.ts:18` | `SELECTABLE_VENDORS = ['cc','codex','pi'] as const satisfies readonly MakerVendor[]` | **唯一入口**。注释明写「新增引擎只改这一行」 |
| **D6** | `apps/desktop/src/renderer/components/new-chat/agentOptions.ts:31` | `VENDOR_PRESENTATION: Record<SelectableVendor, …>` | 加 D5 后**编译报错**（漏 label/Mark 会被抓到）。有益护栏 |
| **D7** | `apps/desktop/src/renderer/hooks/useAvailableAgents.ts:83-84` | device-link 路径 `raw.filter(v => v === 'claude-code' \|\| v === 'codex' \|\| v === 'pi')` | **手机端看不到 prime-agent**（静默丢弃） |
| **D8** | `apps/desktop/src/renderer/hooks/useAvailableAgents.ts:49` | `type RuntimeAgentKind = 'claude-code' \| 'codex' \| 'pi'` | 类型 |
| **D9** | `apps/desktop/src/renderer/hooks/useAvailableAgents.ts:52` | `toVendor(agent) { return agent === 'claude-code' ? 'cc' : agent; }` | prime-agent 自动同名 ✅ **无需改** |
| **D10** | `apps/desktop/src/main/agent-binaries/index.ts:182` | `export type AgentBinaryKind = 'claude-code' \| 'codex' \| 'pi'` | |
| **D11** | `apps/desktop/src/main/agent-binaries/index.ts:197` | `const CONFIG: Record<AgentBinaryKind, AgentBinaryConfig>` | 加 D10 后**编译报错** → 强制补 CONFIG 条目。有益护栏 |
| **D12** | `apps/desktop/src/main/agent-binaries/types.ts:14` | `VendorKey` | |
| **D13** | `apps/desktop/src/main/maker-host/index.ts:3211-3224` | `_registerPiAgent` 幂等注册函数 | **L2 的主接线点**，照抄 |
| **D14** | `apps/desktop/src/main/maker-host/pi-host.ts:1949-1957` | `buildPiAgent()`：binaryPath 缺失 → 返回 null（软失败） | Prime Agent 的对应物 |
| **D15** | `packages/maker-core/src/maker.ts:1550-1555` | `registerAgent(kind, agent)`：幂等，已存在则返回 false | 已满足，**无需改** |
| **D16** | `packages/maker-core/src/maker.ts:813` | `opts.agentKind === 'claude-code' \|\| opts.agentKind === 'pi'` → 提供 `onInvalidResumeSession` | prime-agent 落 else → **不提供**该回调。**这是正确的**：Prime Agent 的 resume 由它自己的 session 文件管，不是 Cindy 的 sdkSessionId CAS。但要显式确认并写进 PR 正文 |
| **D17** | `packages/maker-core/src/session.ts:2822` | `(this.agentKind === 'codex' \|\| this.agentKind === 'pi')` → `settleAsCurrentGeneration` 兜底 | **行为分叉，需显式加 prime-agent**。该机制（`lastResolvedInFlightSend`）与 agent kind 无关，是「in-flight 启动失败被记成 N+1」的通用兜底；pi/codex 只是「踩过这个坑的清单」。Prime Agent 的启动失败语义与 pi 一致（同样抛 `AgentStartupStoppedError`）→ 应加入 |
| **D18** | `packages/maker-core/src/session.ts:2380` | `this.agentKind === 'claude-code' ? null : new ToolLoopMonitor(...)` | 只有 Claude 特殊 → prime-agent 与 pi/codex 同路径 ✅ **安全，无需改** |
| **D19** | `packages/maker-core/src/session.ts:2912` | `this.agentKind === 'codex' && …` | codex 专属 ✅ **安全** |
| **D20** | `packages/maker-core/src/maker.ts:704, 781, 817, 884, 1070, 1138, 1143, 1627, 1629, 1643, 1645, 1666` | pi / codex 专属分支 | 逐个核，多数是「pi 专属功能」→ prime-agent 落 else 是对的 |

### 3.3 保护机制（编译期护栏，方案依赖它们）

- `agentOptions.ts` 的 `Record<SelectableVendor, …>` → 加 D5 后漏补展示元数据**编译报错**
- `agentVendors.ts` 的 `SELECTABLE_VENDORS` → 新增引擎的唯一入口，localStorage 校验自动放行
  （`newMakerDraft.ts:296` 用 `isSelectableVendor()`，注释明写「新增引擎时这里零改动」）
- `agent-binaries/index.ts` 的 `Record<AgentBinaryKind, …>` → 漏补 CONFIG **编译报错**
- `orcaTeam.ts` 的 `Record<OrcaWorkerAgentKind, string>` → 漏补默认模型 **编译报错**

---

### 3.4 Prime Agent 自己的模型目录（实测，影响 UI 设计）

对真二进制发 `get_available_models`（`prime-agent-probe/catalog.mjs`）实测：

- **共 31 个模型**，形态 `{ id, name, api, provider, baseUrl, reasoning, thinkingLevelMap, input, cost, contextWindow, maxTokens, compat }`
- provider 分布：**`github-copilot` 29 个**（`claude-opus-5`、`gpt-5.6-sol`、`gemini-3.8-flash`、`grok-4.6`、`kimi-k3` 等全系列）
  + **`deepseek` 2 个**（`deepseek-v4-flash` / `deepseek-v4-pro`，ctx 1,000,000）
- **可用性取决于用户在 Prime Agent 侧的登录状态**（Copilot 登录 / DeepSeek 密钥），Cindy 不参与也不掌握这些凭证

**这决定了 L2 的模型面设计**（待决项 4）：

- Prime Agent 的模型**不在 Cindy 模型目录里**，也不该进 —— 它是 per-provider 的另一套目录
- L1 的 `handle.setModel()` 已经实现为「查 `get_available_models` → 反查 `(provider, modelId)` → 发 `set_model`」，
  这套机制**天然适配** Prime Agent 自己的目录
- 因此 L2 的 UI 只需：**引擎下拉加 Prime Agent**；模型下拉在选中 prime-agent 时改从
  `get_available_models` 取（而非 Cindy 的模型目录）
- 这需要在 renderer 侧新增一条「模型来源随引擎切换」的路径 → **工作量比 §4.5 预估的大**，是本方案的最大不确定项

## 四、执行方案

### 4.1 阶段划分与提交边界

| 阶段 | 内容 | 提交 |
|---|---|---|
| **S1** | 类型层：加 `'prime-agent'` 到全部闭集 + 删除 translator 的两个 cast | `feat(maker-core): add prime-agent to the agent kind unions` |
| **S2** | 运行时数据表与分支：D1–D12 + D17 | `fix(maker-core): route prime-agent through the runtime agent tables` |
| **S3** | host 接线：`prime-agent-host.ts` + 注册 + 广播 | `feat(desktop): wire the Prime Agent runtime into the maker host` |
| **S4** | UI：引擎下拉 + 图标 + i18n 五语 | `feat(desktop): expose Prime Agent in the agent selector` |
| **S5** | 文档与验证收尾 | 随上述提交或单独 `docs` 提交 |

每个阶段一个 commit，可独立 revert。**PR 结构**：一个 PR，5 个 commit（比 #7884 更适合一次性 review，
因为 L2 的每一步都依赖上一步的类型改动，拆成多个 PR 会让中间态无法编译）。

### 4.2 S1 —— 类型层

**改这些**（全部是加一个字面量 + 类型）：

```
packages/maker-core/src/types/common.ts:8              AgentKind += 'prime-agent'
packages/maker-core/src/types/events.ts:108,182       provider / source += 'prime-agent'
packages/maker-core/src/types/capabilities.ts:288     newSessionDefault += 'prime-agent'
packages/maker-core/src/types/customizations.ts:29     engine += 'prime-agent'
packages/maker-core/src/agents/base-agent.ts:684      engine += 'prime-agent'
packages/maker-shared/src/agentCapabilities.ts:13,366  两处
packages/maker-shared/src/agentTask.ts:141,336,433,488,591   五处
packages/maker-shared/src/deviceLinkContract.ts:272,282  两处
packages/maker-shared/src/orcaTeam.ts:19               OrcaWorkerAgentKind += 'prime-agent'
packages/maker-shared/src/scheduleTypes.ts:2           RemoteScheduleAgentKind += 'prime-agent'
packages/maker-shared/src/subagentWorkspace.ts:11      SubagentProvider += 'prime-agent'
packages/model-providers/src/types.ts:25              AgentKind += 'prime-agent'
packages/maker-scheduler/src/types.ts:2               AgentKind += 'prime-agent'
apps/desktop/src/renderer/lib/ccAgent.types.ts:29     AgentKind += 'prime-agent'
apps/desktop/src/shared/newMakerDefaultTuple.ts:15,18 MakerVendor
```

**同时删掉**（这两个 cast 存在的唯一理由就是 union 没开）：

```
packages/maker-core/src/agents/prime-agent/translator.ts
  - export const PRIME_AGENT_SOURCE = 'prime-agent' as AgentEvent['source'];
  - export const PRIME_AGENT_KIND = 'prime-agent' as AgentKind;
  → 改为直接用 'prime-agent' 字面量（此时类型已接受）
```

**注意**：`PRIME_AGENT_SOURCE` / `PRIME_AGENT_KIND` 被 `index.ts` 与 4 个测试文件引用。
删除前先确认所有引用点都能直接用字面量。

**连带要改的既有测试**：
`packages/maker-shared/src/__tests__/agentCapabilities.test.ts:23,87` —— 断言
`newSessionDefault` 过滤后等于 `['claude-code','codex','pi']`，加了 prime-agent 后要同步。

**完成判据**：`tsc --noEmit`（整包）**相对基线零新增错误**；且因为 D4/D6/D11 是穷尽
`Record`，**编译错误会在这一步主动暴露 D4（orca 默认模型）和 D11（binary CONFIG）**——
这是预期的，用 S2/S4 补齐即可。

### 4.3 S2 —— 运行时数据表与分支

| 改点 | 改法 | 理由 |
|---|---|---|
| **D1** `agentCapabilities.ts:365-368` | filter 的判定加入 `item === 'prime-agent'` | 否则手机端区域门控会静默丢弃 |
| **D2** `deviceLinkContract.ts:579` | 正则加入 `prime-agent` | 手机端未鉴权提示识别 |
| **D3** `orcaTeam.ts:209` | `agentKind()` 解析器加入 prime-agent 分支 | 否则被当成 claude-code |
| **D4** `orcaTeam.ts:29` | `DEFAULT_ORCA_WORKER_MODELS` 补 `prime-agent` 条目 | 编译强制。**取值已定**：`'prime-agent': 'deepseek/deepseek-v4-flash'`（实测目录里存在，见 §3.4）→ **待决项 1 解决** |
| **D17** `session.ts:2822` | `(codex \|\| pi)` → 改为包含 prime-agent | Prime Agent 启动失败语义与 pi 一致，应享受同款 in-flight 兜底 |
| **D16** `maker.ts:813` | **不改**，但 PR 正文要写明 | Prime Agent 的 resume 由自身 session 文件管，不需要 Cindy 的 sdkSessionId CAS |
| **D8** `useAvailableAgents.ts:49` | `RuntimeAgentKind` 加 `'prime-agent'` | 类型 |
| **D7** `useAvailableAgents.ts:83-84` | device-link filter 加入 prime-agent | 否则手机端看不到 |
| **D10/D11/D12** | `agent-binaries/types.ts` + `index.ts` | 加 kind 与 CONFIG 条目（见 §4.4） |
| **D20** | 逐个核 `maker.ts` 的 pi/codex 专属分支 | 多数 prime-agent 落 else 是对的，但要写进 PR 正文的说明表 |

### 4.4 S3 —— host 接线

**新建** `apps/desktop/src/main/maker-host/prime-agent-host.ts`（照 `pi-host.ts:1949` 的形状，
但**大幅简化**——Prime Agent 不需要 models.json 注入、不需要 native provider 解析）：

```ts
export function resolvePrimeAgentBinaryPath(): string | null {
  return getReadyBinaryPath('prime-agent') ?? null;
}

export function buildPrimeAgent(opts: BuildPrimeAgentOpts): PrimeAgent | null {
  const binaryPath = resolvePrimeAgentBinaryPath();
  if (!binaryPath) {
    log.warn('prime-agent binary unavailable after managed prepare; prime-agent agent disabled for this launch');
    return null;   // ← 软失败：agent 不注册 → UI 隐藏入口（照 pi 的先例）
  }
  return new PrimeAgent({
    auth: desktopPrimeAgentAuthAdapter,   // 最小 AuthAdapter 桩：Prime Agent 自带凭证
    runtimeConfig: buildDesktopPrimeAgentRuntimeConfig(),
    logger: opts.logger,
    get binaryPath() { return resolvePrimeAgentBinaryPath() ?? binaryPath; },
  });
}
```

**`AgentDeps` 只有 4 个必填字段**（`base-agent.ts:695-703`：`auth` / `runtimeConfig` /
`binaryPath` / `logger`），其余全可选 —— 比 pi 的 deps 简单得多。

**在 `maker-host/index.ts` 加**（照 `:3211-3224`）：

```ts
_registerPrimeAgent = () => {
  if (!_maker || _maker.listAvailableAgents().includes('prime-agent')) return false;
  const next = buildPrimeAgentForDesktop();
  if (!next) return false;
  const registered = _maker.registerAgent('prime-agent', next);
  if (!registered) {
    void next.dispose().catch(/* … */);
    return false;
  }
  return true;
};
```

并导出 `registerPrimeAgentIfAvailable()`（照 `:3352`），注册成功后广播
`MAKER_PUSH.AGENTS_CHANGED` → renderer 的 `useAvailableAgents` 重新拉取 → UI 出现。

**`agent-binaries/index.ts` 的 CONFIG 条目**（D11）：

```ts
'prime-agent': {
  vendorKey: 'prime-agent',           // ← 需在 VendorKey 加
  manifestField: 'primeAgent',
  installSubdir: 'prime-agent',
  binaryName: process.platform === 'win32' ? 'prime-agent.exe' : 'prime-agent',
  devBinDir: 'prime-agent-bin',
  vendorTag: 'prime-agent',
  artifactKind: 'tar-gz-dir',          // 整目录分发（与 pi 同构）
  optionalAsset: true,                 // manifest 缺字段不阻塞启动（与 pi 同）
  preserveLocalVersion: true,
},
```

**注意**：`artifactKind: 'tar-gz-dir'` 意味着打包版需要 CDN manifest 有 `primeAgent` 段——
**本方案范围内该段不存在**，所以打包版用户拿不到二进制（符合 §2.5 的分阶段约定）。
开发期靠 `apps/prime-agent-bin/<platform>/` 手工放置或后续 L3 的开发期链路。

**`bootstrap-electron.ts` 的 `check-environment`**：Prime Agent 按 **软失败**处理
（照 pi：`broadcastFailure: false`，不进 splash 失败态）。

### 4.5 S4 —— UI

| 改点 | 改法 |
|---|---|
| **D5** `lib/agentVendors.ts:18` | `SELECTABLE_VENDORS = ['cc','codex','pi','prime-agent'] as const satisfies readonly MakerVendor[]` |
| **D6** `components/new-chat/agentOptions.ts:31` | `VENDOR_PRESENTATION` 补 `prime-agent: { label: 'Prime Agent', Mark: PrimeAgentMark }` |
| 新建 | `components/icons/PrimeAgentMark.tsx`（照 `PiMark.tsx` 的简单 SVG 形状，`currentColor` 描边） |
| i18n | 若引擎名是产品名（不进 i18n，参照 `cc`/`codex`/`pi` 的 `label` 直写），则**无需 i18n**；若选择器有描述文案，则五语同步 |
| 模型下拉 | 按待决项 6 选 (a) 或 (c)：选中 prime-agent 时隐藏 / 改来源 |

**注意**：现有 `label` 直写品牌名（`'Claude'` / `'Codex'` / `'Pi'`），**不译**。
Prime Agent 是产品名，同样直写 → **可能完全不需要动 i18n**。落地时确认选择器是否还有其他文案。

### 4.6 S5 —— 验证与收尾

**测试**（照 L1 的做法，每个测试文件在 `prime-agent/__tests__/` 或就近）：

1. `translator.test.ts` — 不动（协议层）
2. 新增 `prime-agent-host.test.ts` — `buildPrimeAgent()` 在 binaryPath 缺失时返回 null；
   有 binary 时能构造；`registerAgent` 幂等（重复注册返回 false）
3. 新增或扩展 `agentVendors.test.ts`（若有）— `SELECTABLE_VENDORS` 含 prime-agent，
   `isSelectableVendor('prime-agent')` 为 true，`agentOptionOf('prime-agent')` 有 label + Mark
4. 新增 `useAvailableAgents` 过滤测试 — device-link 路径的 filter 不丢 prime-agent
5. 扩展 `agentCapabilities.test.ts` — `newSessionDefault` 过滤保留 prime-agent
6. **端到端手工验证**（L2 的核心验收）：GUI 里新建会话 → 选 Prime Agent → 发一句话 →
   收到回复 → 切模型 → 切思考强度 → 中止一轮

**静态检查**：
```
node node_modules/typescript/bin/tsc --noEmit -p packages/maker-core/tsconfig.json   # 整包，与新基线对比
node node_modules/eslint/bin/eslint.js src/agents/prime-agent/ packages/...           # 相关包
node node_modules/vitest/vitest.mjs run src/agents/prime-agent                          # L1 回归
```
desktop 包的检查需要该包的 node_modules（可能需单独装配）。

**PR 正文**（照 `.github/PULL_REQUEST_TEMPLATE.md`）：
- 明确写「不包含二进制打包分发（需 CDN manifest，仓外流水线）」
- §3.4 四项指标的实测结论
- 「范围」里逐条列出「不包含」：不改 models.json 注入、不加权限桥、不加 MCP 网关、
  不改 Cindy 模型目录（Prime Agent 模型不来自 Cindy 目录）

### 4.7 执行顺序（依赖关系）

```
S1 类型层  ──┬─→ 编译暴露 D4/D11（穷尽 Record）──┐
             └─→ 删除 translator 的两个 cast       │
                                                      ↓
S2 运行时表与分支（D1/D2/D3/D7/D8/D17 + D4/D11 的值）
                                                      ↓
S3 host 接线（prime-agent-host.ts + 注册 + 广播 + CONFIG 条目）
                                                      ↓
S4 UI（D5/D6 + 图标 + 可能的 i18n）
                                                      ↓
S5 验证（静态检查 + 单测 + 端到端手工）
                                                      ↓
commit（-s）+ push 到 fork + 开 PR（base = makecindy/cindy:main）
```

---

## 五、验收标准

### L2（可判定）

| # | 标准 | 判定方法 |
|---|---|---|
| 1 | 全部类型闭集含 `'prime-agent'` | 逐个核对 §3.1 的 T1–T16 |
| 2 | 全部运行时数据表与分支显式处理 | 逐个核对 §3.2 的 D1–D20 |
| 3 | `translator.ts` 的两个 cast 已删 | grep 无残留 |
| 4 | `agents/index.ts` 导出 `PrimeAgent` | `export { PrimeAgent } from './prime-agent/index.js'` |
| 5 | host 构造并注册 prime-agent | `_registerPrimeAgent` 存在且被调用 |
| 6 | 二进制缺失 → 软失败（agent 不注册、UI 隐藏入口） | 手工验证：不放二进制 → 选择器无 Prime Agent → 放上 → 出现 |
| 7 | UI 选择器出现 Prime Agent 且有图标 | 手工验证 |
| 8 | **端到端真实对话** | GUI 新建会话 → 选 Prime Agent → 发消息 → 收到回复 |
| 9 | 切模型 / 切思考强度生效 | 手工验证（`handle.model` 是 getter，L1 已修） |
| 10 | 现有三个 harness 不回归 | 整包 typecheck 与新基线一致 + 现有测试不回归 |
| 11 | L1 的 80 个测试仍全绿 | `vitest run src/agents/prime-agent` |
| 12 | DCO 签名 + PR 正文按模板 | PR 上 DCO check pass |

### 「好」的附加标准

1. **无行为分叉** — D16/D17 这类「显式列出两个」的分支逐个想过，不是靠 grep
2. **失败路径诚实** — PR 正文写明「打包版用户仍拿不到二进制，需 CDN manifest」
3. **指标有实测数字** — §3.4 四项
4. **不假装能交付** — L3 的仓外依赖写进 PR 的「未执行的验证」

---

## 六、待决事项（开工前需拍板）

| # | 事项 | 我的建议 |
|---|---|---|
| 1 | **D4 的 Orca worker 默认模型** | ✅ **已解决**：实测目录里有 `deepseek/deepseek-v4-flash`（ctx 1M、reasoning），用它作默认值 |
| 2 | **D11 的 `vendorKey`**：`createBinaryProvisioner` 接受的内部 key 需要新加一个 | 加 `'prime-agent'` 到 `VendorKey`；但**打包版没有 manifest 段**，prod 路径实际不可用 —— 开发期靠 `apps/prime-agent-bin/` |
| 3 | **auth adapter**：Prime Agent 自带凭证，Cindy 不参与认证 | 做一个最小 `AuthAdapter` 桩，`getState()` 恒返回 `{ authenticated: true }`（凭证在 Prime Agent 侧），`triggerLogin`/`logout` 抛「不支持」 |
| 4 | **Prime Agent 的模型是否进 Cindy 模型目录** | **不进**（实测见 §3.4）。但这引出一个更大的问题：**模型下拉的来源要随引擎切换** —— 选中 prime-agent 时模型列表必须来自 `get_available_models` 而不是 Cindy 目录。这是 L2 工作量的大头，**需要单独设计**（见下） |
| 5 | PR 结构 | **一个 PR / 5 个 commit**（L2 的步骤互相依赖，拆 PR 会让中间态编译不过） |
| 6 | **待决项 4 的子问题：模型下拉怎么切来源？** | 三个选项：(a) 选中 prime-agent 时**隐藏模型下拉**，用 Prime Agent 自己的默认模型（最简，但用户失去切模能力）；(b) 新增一条「per-engine 模型来源」路径，prime-agent 走 `get_available_models`（最完整，工作量最大）；(c) 先按 (a) 落地，把 (b) 留到第三个 PR。**我推荐 (c)** —— 先让功能可用且可验证，(b) 作为独立的 UI 改造 |

### 待决项 4 的补充说明（重要）

`§3.4` 的实测改变了这项的性质：它不是「要不要把 Prime Agent 的模型塞进 Cindy 目录」，
而是「**模型下拉的来源要随所选引擎切换**」。

Cindy 现有的模型下拉读的是 **Cindy 模型目录**（`getDesktopSelectableCatalog()` →
`capabilities.availableModels`），而 Prime Agent 的 31 个模型在它自己的目录里。
两条目录的 provider 命名空间不同（`deepseek` / `github-copilot` vs Cindy 的
`xd` / `openai` / `anthropic` / `xai`），**不能合并**——合并会出现同名不同源、凭证归属混乱、
Cindy 侧无法定价等问题。

所以 L2 的 UI 有两条路：

- **(a) 简化**：选中 prime-agent 时不显示模型下拉，由 Prime Agent 自己决定用哪个模型
  （它的 `get_state.data.model` 就会报当前模型）。用户失去手动切模能力，但**功能完整可用**。
- **(b) 完整**：新增「模型来源随引擎切换」的机制。选中 prime-agent 时，
  模型列表改从 `get_available_models` 拉，经 `handle.setModel()` 下发。
  这要求 renderer 侧有一个新的 IPC 通道（`maker:prime-agent-models` 之类），
  因为 renderer 不能直接访问 Prime Agent 进程。

我推荐**先 (a) 后 (b)**：(a) 让 L2 的端到端验收能真正跑通（能建会话、能发消息、能收到回复），
(b) 作为独立的 UI 改造另开一个 PR。这样 L2 的边界清晰、可验收。

---

## 七、当前状态

```
b544df1 fix(maker-core): address Prime Agent adapter review findings   ← 已推 fork
7ad8281 feat(maker-core): add Prime Agent harness adapter (RPC slice)  ← 已推 fork
b0c217c Merge pull request #7714 from makecindy/cindy/quirky-bohr        ← 上游基点
```

- PR #7884：open / mergeable / DCO pass / 9 files / 4810 additions / Greptile pending
- 工作区干净，`cindy-dev` 与 `fork` 同步（`b544df1`）
- L1 完成；**L2 方案已定，待 §6 五项拍板后开工**
