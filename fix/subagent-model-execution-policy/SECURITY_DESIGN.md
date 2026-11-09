# SECURITY_DESIGN — 子代理模型执行授权(失败关闭)

> 目标:Agent **可以建议**用哪个模型,但永远不能**自己拿到**新的模型执行权限。
> 强制在执行层(子任务创建前 + 真实模型请求前),不靠系统提示词或 UI 警告。

## 原则

1. **可用 ≠ 授权。** `list_available_models` 列出的模型只是"存在"；
   能不能执行，只看 Host 为当前会话签发的 `ModelExecutionPolicySnapshot`。
2. **默认拒绝。** 快照缺失/非法/空 provider/model → 拒绝派发；绝不退回
   pi 默认解析(那是 2026-11-07 事故的绕过路径之一)。
3. **免费 ≠ 授权。** free 路由在 `local-only` 模式下同样被拒；
   tier(local/free/paid)只用于审计展示，不构成任何放行信号。
4. **笼统表述无效。** 用户说的"用其他模型协作"之类的话不会生成 approval；
   决策面只有 allow-list 和**用户在 Host 设置入口显式写入**的 approvals。
5. **Agent 无自批权。** approval 必须 `grantedBy: 'user'`，带 scope(session|project)、
   有效期和(可选)费用上限；模型自称的批准、改写 hint、alias、跨设备同名
   provider 都不作数。
6. **费用敏感默认收紧。** paid 路由只有在 `approved-paid` 模式或存在未过期
   approval 时才可执行；development 下 allow-list 命中也不够，必须叠加
   Host approval(P1-4)。
7. **快照可复核。** Host 对快照 HMAC-SHA256 签名(密钥文件 0600，按 owner 隔离)；
   扩展 / runner 验签、会话绑定、24 小时时效，篡改即失效(P1-8)。
8. **费用上限是真的。** 带 `maxCostUsd` 的 approval 累计记账(Host 结算钩子)，
   派发前用同一 `approvalSpendKey` 口径读累计并执行上限(P1-7)；BYOM 行
   用参考定价估算并单独标记为估计口径。

## 架构(四道闸)

```
Host 快照                扩展第一道              Runner 第二道           审计落库
─────────────────       ──────────────────      ──────────────────     ─────────────────
Host 按会话生成           resolveTaskModelRoutes  launchTask 内复核     status.json provider/
ModelExecutionPolicy     逐任务 authorize         deny → 不 spawn         authorizationDecision/
Snapshot(allow-list +    拒绝 → report(failed)    任务直接 failed          approvalId
approvals,version=1)     + policy-denials.jsonl                            ↓
                         (拒绝审计:谁/路由/裁决)   ↑                     localDb subagent_runs
                         config.json 内嵌快照 ──── 读 config.executionPolicy  新增三列
                                                            (config 被改也拦)
```

- **Host 侧唯一事实源** `packages/maker-core/src/agents/pi/model-execution-policy.ts`：
  纯函数 `decideModelExecution(snapshot, requested, now, spendUsdByApproval?)` +
  fail-closed 的 `parseModelExecutionPolicy`(任一 route/approval 非法即整页拒)；
  `decision.allowed === true` 之外的一切状态都是 deny。
- **扩展不能 import Host 模块**(字符串模板注入)，`cindy-subagent-source.ts` 里
  逐字镜像了判定逻辑并验签(读 `CINDY_PI_SUBAGENT_POLICY_KEY_FILE`)；
  runner 同样内联一份，在 `launchTask` 里 spawn 前复核验签。
  三方同语义由测试守住关键字符串 + 决策单测。
- **分级规则**(仅审计展示)：
  - `local` = 经验证的本地端点(loopback 或本机网卡地址)；私网 IP 不等于本机；
    provider id 不能靠字符串匹配猜本地(P0-2)。
  - `free` = provider 声明零价格(至少一项有限成本且四项全 0)；`:free` 后缀
    和 catalog 展示价**不**作依据(P0-1)；未知价格按 paid 处理。
  - `paid` = 其余。
- **快照装配**在 Desktop Host(`subagent-model-execution-policy-host.ts`)：
  allow-list = bot-model-chain 的 pi 路由 + 当前父路由(均写显式
  `sourceProviderId`，匹配时严格相等)(P1-5)；
  approvals 来自 Host 用户审批存储(`subagent-model-approvals-store.ts`，
  唯一写入口仅设置 UI 可达，Agent 不在 AgentDeps 上)；只下发未过期的。
- **本地模式**：默认 `approved-paid`(见 `subagent-model-execution-settings-store.ts`)；
  私人数据会话/项目强制 `local-only`，设置里的 mode 对其不生效(P1-6)。
- **pi/index.ts** 每次写运行时快照时调用 Host resolver 注入签名后的
  `executionPolicy`，并以文件路径 env 形式把密钥文件 / 费用账本路径给扩展
  (两者名均在 pi bash/model .spawn 边界处剥离)；未注入/失败 → 快照里**不带**
  授权 → 扩展 fail-closed 拒绝新派发(已有会话的运行中任务不受影响)。

## Orca Worker

`create_worker` 可传 `agent/model/provider_id`，Host 侧 `deps.createWorker`
在路由解析后、建会话前调用同一套 `decideModelExecution`：
deny → 返回 `MODEL_EXECUTION_DENIED`，不建会话。**失败关闭**(P0-3)：
resolver 缺失、抛错、返回 null/undefined 都是 deny；只有显式
`{ allowed: true }` 才继续。Desktop 主进程已注入。

## 残留路径(未覆盖,见 MIGRATION_PLAN.md)

- Claude Code 原生 subagent(`resolveClaudeSubagentModelAccess`):
  现状是可用性策略(xd 网关 paid tombstone 会 deny,未知不硬阻断)。
- Codex `spawn_agent`、Claude Task/Agent 工具:native 通道,本次未动。

## 审计与隐私

- `subagent_runs` 新增 `model_provider_id` / `authorization_decision` /
  `approval_id`,贯穿 runner status → 进度帧 → 大库 normalize → DB。
- 拒绝审计 `policy-denials.jsonl`(runRoot 下,0600,256KB 上限):
  只记时间、父会话、provider、model、裁决、原因;**不记** API Key、提示词、用户内容。
- 每次执行的 usageSegments 本就带 model/provider，已有；tier 追加为展示；
  费用以 `daily_model_usage` 为准；approval 的 `maxCostUsd` 以派发时累计
  记账 `subagent-model-spend.json` 为执行依据(币种非 USD 的行不记账，
  避免汇率猜测；BYOM 行用参考定价估算并标注估计口径)。
