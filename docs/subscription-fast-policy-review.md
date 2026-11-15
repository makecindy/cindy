# 订阅 Fast 控制：独立审查与修复记录

日期：2026-10-23。审查分支：`feat/subscription-fast-controls`；基线：`0a9987b416cd551a76402fc7da12c99f8639bc50`。

下文记录提交前的完整功能审查，包含当时新增、未跟踪的源码、测试和文档。审查阶段没有提交、推送、创建 PR、部署或重启正式版。用户随后授权 rebase、提交 PR 和自动跟进；提交前追加验证另见文末。

## 结论与边界

主审独立阅读代码，并通过真实 Orca 委托五个 DeepSeek V4 Pro 审核者。共确认并修复 10 项问题，最重要的是远程分配提示可绕过组限制，以及桥接鉴权等待期间可能漏发一条 Fast 请求。其余涉及协议载荷、失败恢复、同步确认、界面通知、长期存储和重试积压。

每项已确认缺陷均补了会在旧实现失败的回归条件，再修复代码。额外覆盖换号、损坏文件、写入中断和并发写入。审核者复核结果与验证范围见下文。没有把审核者提出的每个建议直接当作缺陷，也没有采用会丢失旧任务禁令的淘汰方案。

本次不声称完成 macOS、Claude 原生付费请求或不同物理电脑上的完整实测。之前两套已登录隔离 dev 的实测记录仍在[交接说明](subscription-fast-policy.md)；本轮追加修复通过自动化与原生 CLI loopback 测试，没有重新发送真实付费请求。

## 五个 Orca 委托

团队：`wfhr3zcmmrd365elc12n3jrt`。五个 Worker 均实际创建成功，模型为 `deepseek/deepseek-v4-pro`，供应商 `xd`，推理强度 high，Fast 关闭。审核者共享当前未提交代码，只读审查；由主审统一修改，避免同时写入。

| 审核者 | 侧面 | Worker ID |
| --- | --- | --- |
| `ds-exit` | Codex HTTP/WS、Claude/Pi、桥接鉴权、工具循环、重新启用 | `ox8tk2dms5f5etcsuf3sjt1l` |
| `ds-groups` | 组分发、身份隔离、修订与 ACK、离线/旧版、绑定与释放 | `gcjnx9l10ivk79ul6ssckxpr` |
| `ds-sharing` | 分享目录、启动加载、推送、缓存失败、代次隔离、自定义 API | `jl3l2ues9wfvoxl6hnpkuyld` |
| `ds-ui-scope` | UI 与管理权限、订阅识别、设置保存失败、目录通知 | `k4yjat0753n0t9bpbro5ngto` |
| `ds-tests` | 反向测试、异常路径、自动换机、测试真实性与资源边界 | `s4g0jnka5z67hfheorfeq13f` |

## 已修复发现

### R1 / P1：桥接鉴权等待期间可能漏出 Fast

- 位置：`apps/desktop/src/main/maker-host/anthropic-compat-proxy-host.ts` 的桥接 `prefs.fast`；消费端为 `packages/anthropic-responses-bridge/src/handler.ts`。
- 触发：Claude 引擎桥接 ChatGPT 订阅，先快照允许 Fast；`buildHeaders` 等待鉴权时关闭 Fast；之后用旧快照构造 `service_tier: priority`。
- 修复：`prefs.fast` 使用 getter，在桥接 handler 完成异步鉴权后读取实际宿主策略。保留用户本次请求的偏好，不改变 bridge package API 和依赖方向。
- 回归：新增 `subscriptionFastBridge.test.ts`，走真实路由变换和真实 Responses handler，捕获模拟 fetch。允许时必须确实出现 priority；鉴权期间禁止时必须没有 priority。旧代码该禁止用例失败，新代码通过。
- 复核：`ds-exit` 独立确认缺陷并复核 getter 修复。

### R2 / P1：客户端的分配提示可跳过组 Fast 限制

- 位置：`apps/desktop/src/main/remote-agent/host/runHost.ts` 构造 `Run.groupProviderId`；`service.ts` 启动前绑定本机组策略。
- 触发：账号允许、组禁止；受邀者发送 `groupAssigned: true`，或通过 relay 到达；原先 `groupRouted=false`，本机组策略没有绑定，执行出口会认为允许 Fast。
- 修复：把本机策略绑定与选机判断分开。实际以 guest 身份在本机执行的请求，都从宿主解析出的供应商继承本机组约束，再与上游约束取交集；`groupAssigned` / `relay` 仍保留防转圈用途。
- 回归：`remote-agent/__tests__/groupRelay.test.ts` 分别覆盖已分配直连与 relay，旧实现两条都缺少 `groupProviderId`，修复后通过。原有组分配、转分享授权、负载与续接测试同时通过。
- 修复闭环：追加真实 runtime 交集测试又捕获了本次修复的恢复遗漏——组只有远程成员时，本机已绑定的策略没有收到后续解除。同步目标现始终包含仍存在的组的本机策略端点；删除组仍发送解除。测试验证上游允许＋本机禁止、解除本机禁止、上游再禁止三步均正确。这次返工没有计成新的原始发现，也没有略去失败记录。
- 范围澄清：组所在电脑自己的分享执行入口不能凭调用方提示绕过本机禁令；组内其他电脑单独使用自己的账号，不继承别台电脑的组设置。自定义 API 不进入原生订阅策略。
- 复核：`ds-groups` 独立确认绕过并逐项核对实际宿主任务 ID 和约束交集。

### R3 / P2：禁止 Fast 会改写 WebSocket 控制消息

- 位置：`packages/maker-core/src/agents/shared/fast-mode-policy.ts` 的 `standardSpeedRequest`。
- 触发：禁 Fast 时，无速度字段的 `session.update`、`conversation.item.create`、`response.cancel`、`ping` 也被塞入 `service_tier: default`，改变控制帧协议。
- 修复：带有字符串 `type` 且不是 `response.create` 的控制消息返回 null，由出口原样透传；HTTP 请求和 WS create 仍强制普通档。
- 回归：`subscriptionFastRequestPolicy.test.ts` 表驱动覆盖四种控制帧，旧代码全部失败，修复后通过。实际出口 null 分支保留原始字节。
- 限度：确认的是错误注入字段，不把“某上游一定因此拒绝控制帧”当作已经实测的事实。
- 复核：`ds-exit`、`ds-tests` 均复核通过。

### R4 / P2：目录刷新失败后可能失去自动重试资格

- 位置：`renderer/hooks/useDeviceProviders.ts`、`features/provider-share/providerShareStore.ts`。
- 触发：已识别订阅分享收到刷新通知，先软失效缓存，随后请求失败；原先仅凭权威缓存识别订阅，空缓存令后续推送和过期检查都跳过它。
- 修复：单独保存成功识别订阅分享时的时间戳。软失效保留识别，下一次推送/过期检查可以重试；断链或账号边界的硬失效清除。成功变成非订阅目录也清除，不扩展通用 API 刷新行为。
- 回归：缓存用例先复现失败；另外在分享 hook 中覆盖缓存为空后的下一次 push。三个 Renderer 文件共 89 项通过，`ds-sharing` 独立复跑并复核通过。

### R5 / P2：离线被误判成版本过旧

- 位置：`provider-group/fastPolicyRuntime.ts` 的 `send`。
- 触发：caps 返回 `{ok:false}`，原先统一抛 `REMOTE_AGENT_PEER_TOO_OLD`，造成错误升级提示，还可能把短暂掉线记成长期能力不足。
- 修复：调用失败归为 `REMOTE_AGENT_UNAVAILABLE`；只有成功响应缺少策略能力，才归为 `PEER_TOO_OLD`。
- 回归：离线返回与真实旧版分别断言错误类别，旧实现离线用例失败，修复后通过。
- 复核：`ds-groups` 提出，`ds-tests` 复核通过。

### R6 / P2：抛出的传输异常阻止自动换电脑

- 位置：同一 `send` 的远程调用，以及 `remoteHandler.ts` 的选机重试。
- 触发：链路调用直接 reject `LINK_NOT_OPEN` 等异常，而非返回 `{ok:false}`；原先错误没有归一化，自动换机只识别标准可重试错误，因此整次分配失败。
- 修复：两次远程调用统一包装。catch 中先核对 owner，再转 `REMOTE_AGENT_UNAVAILABLE`，避免把账号切换误认成链路故障。
- 回归：显式 reject 的链路异常与返回错误分别覆盖；选机回归验证排除失败成员并继续。没有放宽受限组需要 ACK 的条件。
- 复核：`ds-tests` 提出并复核通过。

### R7 / P2：设置已保存但同步失败会漏掉通知与绑定清理

- 位置：`provider-group/ipc.ts` 的 save/delete 分支。
- 触发：写盘成功后，原生引擎 busy 导致同步抛错；后续 prune/changed 被跳过，界面仍显示旧值，分享目录缺少推送；删除组也会留下旧任务分配绑定。
- 修复：同步置于 try，已提交状态的清理与发布置于 finally；先核对 owner，再清理、再核对、再发布。同步错误仍向上传递，本地未应用的策略继续 pending，不能谎报 ACK。
- 回归：save/delete 的 native busy 两条先红后绿；另补同步期间换 owner 的两条回归，确保不清理或通知新账号。
- 复核：`ds-ui-scope` 确认并复核，实际复跑相关三文件 106 项；新增 owner 边界后 IPC 文件 59 项通过。

### R8 / P2：已确认解除的旧成员持续留在同步目标

- 位置：`provider-group/fastPolicyStore.ts` 的 `acknowledge`。
- 触发：成员移除并已经收到解除后，目标仍永久保留；后续开关提高修订号时重新联系旧成员，若其离线就再次出现无意义 pending。
- 修复：当前修订的解除已确认、且不属于当前成员时删除该发送目标。尚未确认的离线解除继续保留，不能擅自丢掉解除意图。
- 回归：先移除并确认，再让旧成员离线、切换组设置，断言不再联系它且没有虚假 pending。旧实现失败，修复后通过。
- 复核：`ds-groups` 提出并复核。

### R9 / P2：历史绑定到 10,000 个后拒绝新受限任务

- 位置：`provider-group/fastPolicyStore.ts` 的持久绑定。
- 触发：绑定只有新增没有回收，第 10,001 个任务抛错，禁止 Fast 的组无法继续创建任务。
- 修复：新绑定按宿主任务 ID 的 SHA-256 前两位存入 256 个分片，继续兼容主文件旧绑定，移除任务数硬门槛。复用已有跨进程原子写、owner 作用域和损坏保护。先持久绑定，再提交来源策略，二者成功后才 ACK；缺失来源默认禁止。
- 回收：仅在 `service.ts` 的受邀者历史永久清退全部成功后删除对应 legacy/shard 绑定，保留来源修订号墓碑。普通 close/idle 不清理，旧任务仍可安全续聊。
- 回归：预置 10,000 个旧绑定后增加新任务，旧实现抛错；修复后新旧任务均保留禁令。额外覆盖中断后未知来源禁止、重试恢复、损坏文件保留、跨实例同分片并发写、永久清退不影响其他任务、旧修订不解禁。
- 限度：每片仍有 4 MiB 资源保护；不是无限容量承诺。同账号任务的永久删除尚未接入同款回收，记录保守保留而不冒险解除禁令，后续可补安全回收入口。
- 复核：`ds-groups` 复核写入顺序、清退入口、失败方向与修订墓碑，无新增阻断项。

### R10 / P2：慢同步期间重复轮询会累积完整重试

- 位置：`provider-group/fastPolicyRuntime.ts` 的在途同步合并和 5 秒轮询。
- 触发：一次离线 caps 调用持续超过轮询间隔；原先每次重入都在当前 Promise 后追加一次完整同步，慢链路下重试队列持续增长。另有旧修订已 ACK、配置已变但尚未发出的短窗口，pending 原先可能错误为 false。
- 修复：后台轮询跳过正在同步的组；并发调用共用在途结果，仅当最新 allow/members 与已准备的状态不同才追加同步，保留 owner guard。pending 同时检查当前配置与准备中的状态。
- 回归：阻塞一个离线端点时同时追加五次同步，旧实现发送六次 caps，新实现只一次；配置未发出时必须 pending；在途禁止变为允许时仍发送两代设置，不能因去重吞掉新设置。
- 主审先用两条失败回归复现，再修复；`ds-tests` 独立复核通过，并实跑 runtime + IPC 共 70 项，无新增阻断项。

## 不采纳或撤回的建议

1. **普通关闭时清除 suppressedBySession**：独立审核者复核后撤回。该状态跨原生进程关闭保留，防止解除限制后续聊自动恢复旧 Fast 偏好；普通 close 清理会破坏“需显式重新开启”语义。
2. **LRU 淘汰组禁令绑定**：未采用。旧任务仍可续聊，淘汰记录会丢失执行约束。
3. **嵌套 A→B→C 丢失上游限制**：现有 relay payload 同时携带防环标记，执行端不会继续按自己的组再次转发，该假设路径不可达。实际可达的客户端标记绕过已按 R2 修复。
4. **尚未确认的离线解除直接删除**：未采用。必须保留意图直到执行端收到更高修订并确认。

## 本轮验证

以下四个批次没有重叠，合计 **48 个测试文件、2515 项通过**。这不是整仓全测计数，也没有累加此前交接记录或审核者重复运行的用例。

| 批次 | 文件 | 通过 |
| --- | ---: | ---: |
| provider-group 全目录、组中转与 host 生命周期、策略和桥接回归 | 34 | 793 |
| Codex、Claude 设置/重建、Fast 策略、Maker 远程分支 | 5 | 1129 |
| Codex/Claude/Pi 出口、分享管理、Renderer 缓存/刷新 | 8 | 592 |
| 原生 Codex 0.159.2 + loopback 上游 | 1 | 1 |

原生测试只用临时 HOME/CODEX_HOME、合成授权与本地模拟上游。正向对照先确认 priority，然后验证工具循环中禁止、解除后仍普通、旧 Ultrafast 请求被钳制、用户显式再启用后恢复 priority。没有发送真实付费请求。

第一次原生复测误选仓库中的旧 `apps/codex-bin` 0.145.0，正向 priority 断言失败；没有弱化断言，改用当前包实际使用的 `apps/codex-package-bin` 0.159.2 后通过。旧二进制不记为通过。

- Desktop 完整类型检查：通过；最后一次在源码冻结后启动，2026-10-23 12:32（+08:00）确认退出码 0。
- 本轮新增核心源文件及缓存/分享路径 ESLint：通过。
- `pnpm check:test-hygiene`：通过，364 个文件在基线内，没有放宽基线。
- `git diff --check`：通过。
- 最终 34 文件批次的机器报告：工作区忽略目录 `artifacts/fast-review/final-desktop-groups.json`。
- Orca 原始审核回复保存在忽略目录 `artifacts/fast-review/orca-reports.json`，最后一项复核另存 `orca-final-r10.json`；五个 Worker 最终均为 done。

主要复现命令：

```powershell
pnpm --filter desktop exec vitest run src/main/provider-group/__tests__ src/main/maker-host/__tests__/subscription-fast-policy.test.ts src/main/maker-host/__tests__/subscriptionFastBridge.test.ts src/main/maker-host/__tests__/subscriptionFastRequestPolicy.test.ts src/main/remote-agent/__tests__/groupRelay.test.ts src/main/remote-agent/__tests__/hostLifecycle.test.ts --maxWorkers=2
pnpm --filter @cindy/maker-core exec vitest run src/agents/shared/__tests__/fast-mode-policy.test.ts src/agents/codex/index.test.ts src/agents/claude-code/__tests__/flag-settings.test.ts src/agents/claude-code/__tests__/rewind-runtime-settings.test.ts src/maker.agentDevice.test.ts --maxWorkers=2
$env:CINDY_TEST_CODEX_BINARY=(Resolve-Path apps/codex-package-bin/win32-x64/bin/codex.exe).Path
pnpm --filter desktop exec vitest run src/main/maker-host/__tests__/subscriptionFastPolicy.native.test.ts --maxWorkers=1
pnpm --filter desktop run typecheck
```

## 未验证与既有问题

- macOS、Claude 原生订阅真实请求、不同物理电脑执行：本轮未实测。没有把 mock、Windows 或 loopback 当成这些场景的证据。
- Core 独立 `pnpm --filter @cindy/maker-core run build` 仍失败于既有的 `packages/lizi-mcps/src/browser/recipe-loader.ts:180,190`：`TS2339 ImportMeta.glob`。该文件不在本次 diff 中；不把独立 Core 构建写为通过，也不为本功能跨范围修改其环境类型。
- 之前 Windows Claude hosted e2e 清理曾遇到基线可复现的 `EBUSY`；本轮未重复运行该已知故障套件，未弱化其断言。
- 两套 dev 的启动包装此前返回 `STARTUP_TIMEOUT`，实际 UI 随后加载并完成测试；启动门禁仍不记为通过。
- 两套 dev 的上一轮真实分享测试使用的是追加审查前的源码快照；本轮修复没有重新复制并重跑双实例付费流程，不能把旧截图作为最终补丁的实机证据。

正式版 PID `37892` 的启动时间复核仍为 `2026-10-22 15:53:45 +08:00`，保持持续运行。本次修改停留在开发分支的工作区。

## 提交 PR 前追加验证（2026-10-23）

已同步 fork，并将完整功能补丁 rebase 到检查时最新的上游 `70b32d757868f24df988c41e9fc31c0a2a3b4fbe`。第一轮冲突只涉及 caps 解码和协议文档：保留上游 `idleReclaimMinutes` 校验及伙伴关联项目说明，同时加入 Fast 能力与协议说明。第二轮吸收权限热切换等后续 PR，无冲突；`range-diff` 确认相对上游的功能补丁未改变。未覆盖或回退上游其他 PR。

用户确认兼容性要求：首次升级或登录默认允许 Fast，是否分享不改变默认值。已有 Fast / Ultrafast 偏好保留；只有明确关闭账号或组开关才限制。现有持久 store 回归覆盖缺省允许及其他账号未被误伤，真实 Codex loopback 正向对照确认允许状态仍发出 `priority`。

以下为最后一次 rebase 后的独立批次，共 **55 个文件、3114 项通过**，未累加历史批次和单文件重复计时：

| 批次 | 文件 | 通过 |
| --- | ---: | ---: |
| Desktop 策略、完整组目录、分享管理与缓存、Codex/Claude/Pi 出口 | 42 | 1390 |
| Core Fast、Codex、Claude 设置与权限、Pi 权限、Maker 运行时 | 9 | 1667 |
| 原生 Codex 0.159.2 loopback 与共享组配置 | 2 | 33 |
| device-link 协议与供应商身份 | 2 | 24 |

- Desktop 全量 `typecheck` 退出码 0；device-link 与 model-providers 的实际 `build`（`tsc --noEmit`）通过。
- Core 独立 build 仍只有未改动的 `recipe-loader.ts:205,227` 两处 `TS2339 ImportMeta.glob`，上游改动导致旧记录行号移动；没有把该项记成通过。
- `check:test-hygiene` 通过（363 个文件在原基线内），未放宽基线；i18n key、术语表和开发文档合同检查通过。新增策略及缓存/分享关键路径 ESLint 通过。
- 订阅开关 UI 最终矩阵 **40/40** 通过：明暗主题、五种语言、允许/禁止/待确认/320px 窄屏；截图为真实组件与模拟数据，用户已确认可发布到 fork。最终证据目录 `artifacts/ui-check/subscription-fast-VbITJI/`。
- 受影响页面双主题默认场景 **54/54** 通过，已查看总览；`ProvidersSection.tsx` 被工具列为 `UNCOVERED`，不将该设置页入口记为本轮截图覆盖。复用的订阅开关组件另有上述矩阵。
- 首次 Electron 全矩阵扫描未产出图片，终止的仅是该扫描进程树；改用 Chromium 完成以上检查，没有重启正在供给的 Cindy。
- 24 个改动测试文件分别运行通过，独立计时在 `artifacts/fast-rebase/standalone-timings.json`。桥接回归保留真实路由和 handler，直接加载实际速度钳制函数，减少无关 Agent 初始化；优化后单文件 8.15 秒、测试体 66 毫秒，尚高于 5 秒目标，如实登记。

机器报告与日志在忽略目录 `artifacts/fast-rebase/`。macOS、Claude 原生真实付费请求和不同物理机仍未补测；之前隔离 dev 的真实分享记录不代替最终 rebase 后的实机证据。

## PR #6894 首次自动跟进（2026-10-23）

以下为提交 PR 后的增量复核，不计入提交前十项发现。没有新增 Orca 委托，也没有重启正式版或发送真实付费请求。

### R11 / P1：解除限制后，运行中的 Claude 无法显式恢复 Fast

- GitHub 原线程：`discussion_r4356434669`。独立确认 `SET_FAST_MODE` 仅在仍被禁止时才调用 Claude 的运行句柄；恢复允许后只保存偏好，原生 Fast 状态和请求抑制没有解除。
- 修复：真实本机 OAuth 订阅上的 Claude 显式开关始终经过运行句柄和已有策略包装器；仅放宽账号/组限制仍不自动启用。自定义 API 仍走原来的偏好保存路径，没有增加原生控制请求。
- 回归：在既有 `sessionRuntimeControlWiring.test.ts` 复用编译后的生产 IPC 闭包并连接真实 `withFastModePolicy`，执行「禁止 → 允许 → 手动开启」；Anthropic 和 OpenAI 订阅均在旧实现失败、修复后通过，自定义 API 对照保持原样。现有策略/原生设置测试单独覆盖抑制回调与 flag 更新，这个入口用例补齐此前无法发现的 IPC 提前返回。

### R12 / P2：目录先刷新时，原生保存失败提示被吞掉

- GitHub 原线程：`discussion_r4356434675`。独立确认同一供应商 `allowFast` 变化会递增保存代次，使后到的原生更新失败提示被当成陈旧请求。
- 修复：供应商/电脑身份生命周期与目录值刷新分开。相同身份的新目录只刷新开关值，继续显示该次保存失败；换供应商、换电脑、换号和卸载仍丢弃旧响应。
- 回归：在已有 `ProviderShareManagePage.test.tsx` 使用真实 `SubscriptionFastSetting` 和管理 IPC 适配器；延迟保存，先更新 props 再拒绝，旧实现没有提示、修复后有提示；四类失效边界继续通过。复用原页面夹具，没有拆分小测试文件或复制组件实现。

### CI 失败分诊与测试夹具适配

- 初始 `client-ci` run `39905324909` 的 verify job `120255848292`：生产 Fast 闭包新增策略依赖后，归档设置夹具缺少 `readSessionRuntimeProfiles` 等绑定，九项报 `ReferenceError`。补齐该夹具的缺省允许订阅依赖，原有归档/删除/持久化失败断言保留。
- Linux 分片 job `120255848377`：hook bridge 偏好用例开始读取真实宿主策略，旧 Electron mock 无 `app`，创建任务返回错误。明确注入缺省允许策略以隔离宿主配置，不读取账号文件；仍通过真实 runner、路由变换检查 effort/Fast，禁止场景继续由独立真实策略与 bridge handler 回归验证。失败断言增加原错误信息以便诊断。
- Linux 分片 job `120255848463`：收藏同步的无目录夹具缺少 `isSubscriptionShareCatalogStale` 导出，补齐「无已缓存订阅目录」的返回值；没有更改收藏同步源码或断言。
- 上述失败均在本地重现后修复，属于本 PR 新依赖与既有夹具的适配遗漏；没有按 flaky 处理、空提交、弱化断言或因 main 普通前进而 rebase。

### 本轮增量验证

- 10 个不同文件共 384 项通过：IPC/页面 119，策略与 runtime axis 33，Core 包装器/Claude flag 14，hook/收藏/持久策略 218。重复计时不重复计数；IPC 单文件 79 项、3.68 秒。
- `register.ts` 全文件 ESLint 仍有 15 个既有 unused 错误，hook 测试仍有六个既有 unused 参数错误；分别对照上游基线 `70b32d7` 的完整消息集合，新增错误均为零。不把全文件 lint 写成通过，也不跨范围删除别人的代码。
- UI 完整 `--changed --theme all --engine chromium` 矩阵为 376/382 通过（665.8 秒），Fast 的八个明暗主题场景全部通过，已查看总览及开关实图。六个失败均在 `plugin-install-mail` 的多视图/编辑/刷新场景，报 `ResizeObserver loop completed with undelivered notifications`。随后 `--compare 70b32d7` 在上游基线也复现同类失败；没有据此修改插件或掩盖整批失败。`ProvidersSection.tsx` 仍为 UNCOVERED。没有再次发布新截图，PR 保留已获用户授权的原有模拟图。
- 独立单文件耗时：IPC 3.68 秒、收藏同步 3.85 秒、管理页面 30.60 秒、hook runner 15.94 秒。后两项复用已有大入口夹具：页面同时加载真实页面、账号/成员/用量组件，hook 加载真实 runner、路由和 Core 事件判定；没有逐项 resetModules、增加真实等待或拆分机械小文件。测试体分别为 17.51 秒、1.49 秒，重收集成本与 Windows 并行类型/UI 扫描负载均保留记录，不将其宣称满足五秒目标。
- 最后代码的 Desktop 全量 `typecheck` 退出码 0；过程中诊断断言的 nullable message 类型错误已修复后重跑，未记失败批次为通过。最终 `check:test-hygiene` 通过（363 个文件在原基线内），开发文档合同 10 项通过；除上述两处已有 lint 基线外，其余四个改动源码/测试文件的定向 ESLint 通过。
- 历史 3114 项结果保持属于提交前快照，不能代替这次新增代码的验证。原 Core 独立 build、macOS/真实 Claude 付费/跨物理机限制继续保留，不由本轮模拟测试替代。
