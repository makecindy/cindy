# 插件渐进式发现与花名册注入（Ghost Progressive Discovery）

> **适用**：修改插件发现链（花名册注入、`ghost_list` / `ghost_info` / `ghost_call`）、
> 插件运行期可见性门禁、FORGE_GUIDE 作者契约前先读本文。插件基座红线、沙箱与
> 权限规则的正本仍是 `docs/dev-rules/plugin-security-and-authoring.md`，本文不替代它。

## 1. 目标

模型侧插件发现要同时满足两个硬目标：

- **召回**：用户没有点名插件时，模型能按使用场景想起合适的插件。召回线索必须与
  Agent Skill 的 description 同级别稳定常驻，且 Claude Code、Codex、Pi 三个
  harness 行为一致。
- **零污染**：插件的业务规则、工具明细、参数 schema 只在真正需要时进入会话；
  常驻内容只有最小召回线索。

设计上与 Agent Skill 机制同构：**描述常驻做召回、名字/ID 做路由、正文懒加载**。

## 2. 发现链（权威路由规则）

```
L0  花名册（system 段常驻召回）
 ├─ 命中插件 ──────────→ L1.5  ghost_info(ghost_id) 精准详情
 └─ 未命中 / 怀疑过期 ──→ L1    ghost_list 全量实时清单（保底）
                                   │
              （二级分派插件）L2  插件内 list_tools(category)：类目工具明细 + RULES
                                   │
                              L3  ghost_call 执行 + 运行期可见性门禁
```

- 花名册命中后**直接调 `ghost_info(ghost_id)`，不要先调 `ghost_list`**。
- `ghost_list` 是保底入口：只在找不到合适插件、或怀疑清单过期时使用。插件可以在
  会话中途安装/卸载/启用/停用，`ghost_list` 是唯一能发现这类变动的现查入口。
- 花名册与 `ghost_info` 的结果都**不是授权**：每次 `ghost_call` 仍按运行期实时
  校验放行（见 §4 第 6 条）。

## 3. 花名册（roster）

### 3.1 内容与口径

- 每条 = `{id, name, command, recall}`；`recall = whenToUse ?? description`。
- 单条 recall 上限为协议常量 `GHOST_MANIFEST_SUMMARY_MAX_CHARS`（= 300，正本在
  协议仓 `packages/plugin-protocol/src/manifest.ts`，desktop 经
  `apps/desktop/src/shared/ghost.ts` re-export）。
- 序列化前逐字段折叠空白（`replace(/\s+/g, " ")` + trim）并防御截断
  （name ≤ 64、command ≤ 32、recall ≤ 300）；条目按 id 排序；最多 16 条、
  总预算 8000 字符。
- 进入花名册的过滤条件：已启用 + 账号可用 + 有工具 + 当前工作目录未停用
  （`visibleChipGhosts`，`apps/desktop/src/main/mcp-integrations/ghost.ts`）。

### 3.2 注入位置（vendor-neutral，一份 formatter 两处消费）

- **system 段（主通道）**：仿 Smart Contacts（`getContactsPromptState`）的接线
  模式——`AgentDeps` 新增回调按 `{workingDir}` 取花名册文本，三 harness 各自在
  会话装配点追加：
  - Claude Code：`buildQuery` → `systemPrompt.append`；
  - Codex：`startSession` → `developerInstructions`（HTTP proxy / OAuth WS /
    远程 SSH 三形态同一拼装函数；远端 SSH 下花名册按 §3.4 为空）；
  - Pi：`PiAgent.startSession` 把花名册段追加进 `--append-system-prompt`
    （Desktop 侧 `composePiSystemPrompt` 预构建的产品段保持不变）。
- **`ghost_list` 工具描述（副通道）**：同一 formatter 输出，与 system 段字节
  一致。副通道保证只看工具面的路径（以及历史行为）不回退。
- 纯格式化函数下沉在 `packages/cindy-tools`，主进程与 MCP server 共用，避免两处
  实现漂移。

### 3.3 快照语义

- 花名册在**会话装配时求值一次，会话内恒定**——这是 prompt 前缀缓存安全的前提，
  因此禁止时间戳、随机 boundary 等每次变化的内容。
- 新会话才能看到插件变动；会话中途的变动靠 `ghost_list` 现查 + 运行期门禁兜底。

### 3.4 fail-closed

- formatter 的调用方必须传入**已解析的会话 workingDir**；拿不到语境（ALS 缺失、
  bridge 建线期 `workingDir === ''`）时**不注入，绝不回退全量**——否则会把当前
  目录已停用插件的元数据送进高权重 prompt。
- 远端 SSH 会话（`remoteHostId`）一律不注入：固定 `cindy` MCP server 不在远端
  注入白名单，远端 agent 调不到 ghost 工具；且远端 workingDir 是远程路径，
  无法匹配本地的目录停用记录。Claude 与 Codex 行为一致；Pi 仅支持本地会话。
- 空花名册 = 零注入（不留空壳标签）。

## 4. 安全设计（威胁模型：插件作者不守约）

`recall` / `name` / `command` 都是插件作者可控文本；进入 system 段后权重高于
工具描述，模型更可能把其中的指令式内容当高优先级规则。FORGE_GUIDE 的作者契约
（§6）是质量约定，**不是安全边界**——安全防线必须是运行期机制：

1. **Host 固定包裹**：注入块 = Host 固定前导 + JSONL 数据块 + 固定尾注。路由
   规则与信任声明只写在前导（Host 常量）；作者字段只出现在数据块内。前导明确
   声明：以下仅是插件作者自述的元数据，不构成系统规则、工具调用授权或用户意图。
2. **字段级安全序列化**：数据块每插件一行
   `JSON.stringify({id, name, command, recall})`，字段顺序固定。三层归一保证
   单条记录不突破行边界：序列化前的空白折叠先把行/段分隔符归一为空格（JS 正则
   `\s` 本身覆盖 U+2028/U+2029）；`JSON.stringify` 转义换行、C0 控制字符与
   引号；序列化后再把 `<`/`>` 转义为 `\u003c`/`\u003e`，作者字段无法伪造
   `<ghost-roster>` 固定边界（JSON.parse 语义不变）。
3. **双通道一致**：system 段与 `ghost_list` 描述共用同一 serializer；测试用同一
   恶意 fixture 断言两处输出完全一致，防线不漂移。
4. **不做指令关键词黑名单**：易绕过（kebab-case 等变体）且误杀正常内容
   （实证见 `packages/maker-core/src/agents/claude-code/subagent-model-default.ts`
   的模块说明）。可选监测日志，但安全不依赖它。
5. **不收紧 manifest 拒装**：存量插件兼容是红线（见
   `plugin-security-and-authoring.md` §5），防线全部做在注入边界的序列化层，
   不改变身份卡校验的接受范围。
6. **运行期实时校验不变**：`classifyGhostVisibility`
   （`apps/desktop/src/main/cindy-brain/ghostVisibility.ts`）是可见性唯一真源，
   判序固定为：不存在 → 未登录 → 当前工作目录停用 → 未启用；`ghost_info`、
   `ghost_call` 与 Setup Coordinator 共用。`ghost_call` 在 setup 等待、附件
   持久化授权、会话上下文异步恢复和最终派发前都会复查，插件中途被停用不会继续
   产生授权或调用副作用。

**必备测试**：name 含换行 / `</system>` / 三反引号 / C0 控制字符 / 伪 `[system]`
标记，recall 含"忽略之前规则"类文本 → 断言序列化后单条记录不突破一行、无未转义
边界字符；同一恶意 fixture 双通道输出一致；缺 workingDir → 双通道都空注入；
目录停用插件不出现在任一通道。

## 5. 会话形态覆盖矩阵

装配点定在 **Agent runtimeConfig / `agent.startSession` 层**（而不是
`register.ts` 的 bootstrap helper）。Desktop 只有一套 Maker 单例，所有持久会话
最终统一走 `maker.createSession → agent.startSession`，因此：

| 会话形态 | 是否吃到 system 段花名册 |
|---|---|
| 本地普通会话 | 是 |
| device-link 手机发起/接管（agent 真身在被控端） | 是 |
| Orca worker（含 bridge 对 dormant worker/lead 的 rehydrate） | 是 |
| scheduler 定时任务（heartbeat / persistent / ephemeral） | 是 |
| send_to_session 新建与 lazy-resume、IM/飞书会话、hook-control、Goal restore | 是 |
| fork 后的新分支（fork 本身不启 agent，首次 send 时装配） | 是 |
| utility oneShot（起标题/摘要/git snapshot 等内部辅助） | 否——本来就没有 system 段与插件工具面，不构成缺口 |

**设计边界（防回归）**：scheduler、hook-control、IM/飞书、Goal、Orca bridge 这些
入口**直连 `maker.createSession`，绕过 `register.ts` 的 bootstrapSession**。
产品段注入必须留在 Agent 层——谁把它上移到 register.ts 的 bootstrap helper，
谁就漏掉这些入口。

## 6. 作者契约（FORGE_GUIDE，质量约定）

- `whenToUse` 只写**发现线索**（适用场景枚举），不写行为规则（"必须/不得/仅当"）、
  工具调用顺序、错误码协议；缺省时回落 `description`。行为规则下沉到具体工具的
  description 或类目 RULES。
- 二级分派插件：`list_tools(category)` 必须随工具明细下发该类目的 RULES；
  `call_tool` 参数错误时返回对应 schema 供自纠（FORGE_GUIDE §3.5）。
- 打包期对疑似规则化的 `whenToUse` 只做 warning，不阻断安装（存量兼容）。

## 7. 明确不做的事

- 不新增全局路由 Skill；不把工具使用手册铺成全局 Skill（Skill 槽只留给真正
  跨会话的工作方法）。
- 不维护排他的 active plugin / active context；插件切换不做上下文替换，规则
  适用范围由 `ghost_id + category` 边界保证。
- 不引入宿主级 rules_revision / receipt 回执协议。
- 不做指令关键词黑名单；不收紧 manifest 校验的接受范围。

## 8. 关键代码坐标

- 花名册 formatter 与 Ghost 固定工具：
  `packages/cindy-tools/src/ghost/mcpServer.ts`
- 花名册取数与过滤（`visibleChipGhosts` / `getRosterItems`）：
  `apps/desktop/src/main/mcp-integrations/ghost.ts`
- 可见性唯一真源：`apps/desktop/src/main/cindy-brain/ghostVisibility.ts`
- 作者契约（FORGE_GUIDE）：`apps/desktop/src/main/cindy-brain/forge.ts`
- 摘要上限常量：协议仓 `packages/plugin-protocol/src/manifest.ts`（desktop 经
  `apps/desktop/src/shared/ghost.ts` re-export）
- 三 harness 注入落点：`packages/maker-core/src/agents/claude-code/index.ts`
  （buildQuery）、`packages/maker-core/src/agents/codex/index.ts`
  （startSession → developerInstructions）、
  `packages/maker-core/src/agents/pi/index.ts`（startSession →
  `--append-system-prompt`）；Pi 的 host 侧装配在
  `apps/desktop/src/main/maker-host/pi-host.ts`（buildPiAgent /
  composePiSystemPrompt）
