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
7. **快照可复核(P0-B 非对称)。** 授权**判断**只在可信 Host 边界(Desktop 主
   进程)做出,并以 **Ed25519** 签名；扩展/runner 的 verifier 只凭**公钥**
   验签,公钥以 **env 字面量**(SPKI DER base64)注入 —— 没有 public-key.json
   文件可替换。私钥**永不以明文落盘**:只以 **safeStorage 密文**(version 2)
   存入现有路径,Agent 同 UID 读到的文件最多是密文;或在 safeStorage 不可用
   时只活在 Host 进程内存里。(旧版明文文件,存在即忽略 + 尝试删除。)
   签名 + 会话绑定 + 24 小时时效三重校验。0600/0644 文件模式不等于同用户
   进程隔离 —— 因此本方案从不把私钥写进任何 Agent 可读的文件系统路径。
8. **费用上限(诚实口径)。** 带 `maxCostUsd` 的 approval 累计记账(Host 结算
   钩子,实际 / BYOM 参考估算分开标注),派发前用同一 `approvalSpendKey`
   口径读 **结算累计 + 在途预留**,上限到达即拒(P1-7/P0-C)。
   **预留是并发原子裁决(P0-2)**:读账本 → 算剩余额度 → 预留 → 持久化全部在
   同一把 O_EXCL 锁临界区内完成；预留失败、账本不可读(含账本缺失首个付费
   任务时视作可建新账;账本已写入但内容损坏则拒)、锁超时、持久化失败一律
   拒绝付费任务启动 —— 绝不静默当账已清零。
   **P0-0 严格化(本轮)**:预留与结算仅在 `ENOENT` 时视为可建新账;
   `EACCES` / `ENOTDIR` / `EIO` / 损坏一律失败关闭 —— Host `readSpendFileForLock`
   与 Runner `policyReserve` 同口径;结算/释放不可读时跳过写入,不覆盖历史费用.
   ⚠️ 上限度量的是已结算费用 + 在途预留,**不是「对单次请求的硬天花板」**：
   运行中单请求的 token 消费无法实时拦截,文档与 PR 文案不作此宣称。
   记账文件本身是控制面:spend 路径名在 bash/model 工具的 spawn 边界剥离。
   残留:同 UID Agent 对账本文件的篡改是同一 UID 沙盒外的能力(见威胁模型)。

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
  逐字镜像了判定逻辑并验签(读 `CINDY_PI_SUBAGENT_POLICY_PUBLIC_KEY`
  env **字面量**= SPKI DER base64,只认 Ed25519 公钥;**绝不读文件系统**,
  旧文件路径 wiring 视为不可信直接返回 null);
  runner 同样内联一份，在 `launchTask` 里 spawn 前复核验签+原子预留。
  三方同语义由测试守住关键字符串 + 决策单测。
- **分级规则**(仅审计展示)：
  - `local` = 经验证的本地端点(loopback 或本机网卡地址)；私网 IP 不等于本机；
    provider id 不能靠字符串匹配猜本地(P0-2)。
  - `trusted-lan` = 用户显式登记的受信局域网端点三元组(provider+endpoint
    origin+模型精确匹配)；不是整段子网信任。`development` 可执行、
    `local-only` 仍拒 —— strict local-only 语义不变。缺省空表 = 永不信任 LAN。
  - `free` = provider 声明零价格(至少一项有限成本且四项全 0)；`:free` 后缀
    和 catalog 展示价**不**作依据(P0-1)；未知价格按 paid 处理。
  - `paid` = 其余。
- **快照装配**在 Desktop Host(`subagent-model-execution-policy-host.ts`)：
  allow-list = bot-model-chain 的 pi 路由 + 当前父路由(均写显式
  `sourceProviderId`，匹配时严格相等)(P1-5)；
  approvals 来自 Host 用户审批存储(`subagent-model-approvals-store.ts`，
  唯一写入口仅设置 UI 可达，Agent 不在 AgentDeps 上)；只下发未过期的。
- **本地模式**：默认 `development`(P1-D)；
  私人数据会话/项目强制 `local-only`，设置里的 mode 对其不生效(P1-6)。
- **pi/index.ts** 每次写运行时快照时调用 Host resolver 注入签名后的
  `executionPolicy`，并以 env **字面量**(公钥本身,非文件路径)形式把
  `CINDY_PI_SUBAGENT_POLICY_PUBLIC_KEY` 给扩展；私钥永不下发,费用账本路径
  名在 pi bash/model .spawn 边界处剥离(公钥字面量是公开值,不进剥离名单)。
  未注入/失败 → 快照里**不带**授权 → 扩展 fail-closed 拒绝新派发(已有会话的
  运行中任务不受影响)。

## Orca Worker

`create_worker` 可传 `agent/model/provider_id`，Host 侧 `deps.createWorker`
在路由解析后、建会话前调用同一套 `decideModelExecution`：
deny → 返回 `MODEL_EXECUTION_DENIED`，不建会话。**失败关闭**(P0-3)：
resolver 缺失、抛错、返回 null/undefined 都是 deny；只有显式
`{ allowed: true }` 才继续。Desktop 主进程已注入。

## 威胁模型(P0-B)

| 攻击者能力 | 对本方案的影响 |
|---|---|
| Agent 可改写 runtime 快照 / runner config | 签名断裂 → fail-closed |
| Agent 可读 signing-key 文件 | 只拿到 **safeStorage 密文**(Keychain 主密钥不对 Agent 进程开放)；或在 safeStorage 不可用时根本没有文件 |
| Agent 替换公钥 | **不存在公钥文件** —— 公钥只活在 env 字面量里；改 env 顶多让 verifier 换一把验签键,自签快照依旧验不过(回归测试覆盖 self-signed 负向) |
| Agent 可直接调 provider API(自有 Key) | 策略管的是 Cindy Host 的执行面;Agent 自持 Key 的场外调用由 API 返回面治理,**不在本策略内** |
| Agent 进程崩溃留下过期预留 | 预留 TTL 10min 自清(Host/Runner:读清 + 锁内回收) |
| Agent 直接篡改费用账本 | 路径名在 spawn 边界剥离;同 UID 对文件本身的写是沙盒外能力 —— 账本被篡改为 0 只会在 TTL 清除后重扣(真实回执结算会持续累加 actual),不构成持续免费执行通道 |

**残留声明(诚实)**:同 UID 恶意 Agent 对其他文件的篡改(例如在 session 中途重写
已生成的 `runner.cjs` / 扩展源)超出本进程架构的隔离能力 —— Host 在每次
session 启动时重新生成扩展,第二道闸在已加载的扩展模块内,跨 session 重启
即恢复。完整 UID 隔离需要独立 UID 的常驻 Helper + 受控 IPC,对于 sandboxed
桌面 App 属于过度设计,未在本 PR 实现;完整恶意-Agent 隔离声明**未**达。

**设计说明(为什么不是 IPC/Proxy 实时问答)**:pi 扩展在子进程内运行,与
Host 之间没有可同步调用的执行面 —— 授权判断必须在**会话级**(setModel/
writeSubagentRuntimeFile)预先作出。本方案把判断点做在可信边界、把结果做成
不可伪造的密码学凭据(Ed25519 签名快照 + 24h 时效),效果等价于「每次
派发都问一次可信 Host」:判断永远由可信边界做出,不可被 Agent 伪造、重放或
篡改。Agent 即使拿到凭据,也只能做已授权的事。

## Claude / Codex 通道(本轮 Phase A 已收敛)

- **Claude Code Task/Agent(逐调用 PreToolUse)**:可用性分类仍在,
  上面叠加 Host 执行授权(签名快照 + `decideModelExecution`)。检查点在
  真实工具调用的 `tool_input.model` 与最终生效模型(平台强制模型优先,
  见 `effectiveClaudeSubagentModel`),不是仅创建参数。固定模型(归一化后
  等于父模型)保留;跨模型必须命中 allow-list 或有效 approval,否则硬拒;
  alias 跨模型按精确匹配拒(允许名单是全名,alias 不靠猜 generation)。
  网关按模型名路由时,同模型在另一来源 allow-list 可执行则不跨越名单。
  可用性 `unknown` 保留 hook 既有「unknown=可路由」语义,policy 只加 deny。
- **Codex `spawn_agent`**:无逐调用 Host 闸门可可靠执行跨模型授权,
  本轮默认关闭动态跨模型 —— `features.multi_agent_v2.expose_spawn_agent_model_overrides: false`,
  子 thread 固定继承父模型(固定执行保留)。如需跨模型协作请走 Pi/Orca
  或 Claude 的 Host 授权通道。动态跨模型不是用别名/换 provider 绕过:
  flag 关即关,不读取 Agent 参数。
- **残留**:Claude `subagent_type` frontmatter 声明的模型不在
  `tool_input.model` 内,host 扫描仅决定 env 默认值;绕过面见
  MIGRATION_PLAN 的 BLOCKED 项,本轮不作严格隔离宣称。
- Pi/Orca 两道闸保持 Host 权威;Codex 远端会话固定继承同样适用。

## 审计与隐私

- `subagent_runs` 新增 `model_provider_id` / `authorization_decision` /
  `approval_id`,贯穿 runner status → 进度帧 → 大库 normalize → DB。
- 拒绝审计 `policy-denials.jsonl`(runRoot 下,0600,256KB 上限):
  只记时间、父会话、provider、model、裁决、原因;**不记** API Key、提示词、用户内容。
- 每次执行的 usageSegments 本就带 model/provider，已有；tier 追加为展示；
  费用以 `daily_model_usage` 为准；approval 的 `maxCostUsd` 以派发时累计
  记账 `subagent-model-spend.json` 为执行依据(币种非 USD 的行不记账,
  避免汇率猜测;BYOM 行用参考定价估算并标注估计口径)。
  上限是「已结算累计 + 在途预留」口径,不是单请求硬天花板(运行中单请求 token
  消费无法实时拦截)。
