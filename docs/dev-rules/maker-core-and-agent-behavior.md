# maker-core 与 Agent 行为可控性

> **状态**：权威开发规则（authoritative）
> **读取时机**：新增或修改 `packages/maker-core` 中的 Agent 编排、prompt 组装、
> tool／MCP 暴露、translator、event loop、model 映射、usage／token 计量，或任何会进入
> 模型 system 段的提示词之前

本文治理 Cindy 连接 Claude／Codex 等 Agent 的编排核心 `packages/maker-core`。它是所有
Agent 会话的事件流与 prompt 组装中枢，这里的改动会在用户无感知的情况下影响线上行为与
质量。进程边界与 IPC 另见
[`electron-security-and-process-boundaries.md`](electron-security-and-process-boundaries.md)，
Orca 多 Agent 协同另见 [`orca-team-architecture.md`](orca-team-architecture.md)。

## 启动失败与工作目录占用

Claude Code、Codex、Pi 共用 Maker 的启动失败清理契约：只有明确未启动进程或已确认
进程退出时，adapter 才返回 `AgentStartupStoppedError`；Maker 释放本次启动的目录租约，
并向调用方还原原始错误。准备环境失败也必须进入该契约，不能把尚未启动的任务永久
记为可能仍占用目录。鉴权失败保留原 `AgentNotAuthenticatedError` 类型。

本地 SDK 已接收启动调用、已观察到进程创建、或远端启动请求已发出后，普通异常不是
退出证明。Pi 在 transport 已创建而 RPC 包装器构造失败时，也必须关闭已取得的
transport；关闭未确认时复用原有隔离清理记录和 `AgentStartupCleanupPendingError`，
保留运行期文件与目录保护，重试确认退出后才释放。旧隔离进程的清理失败不能被新一轮
“尚未启动”的状态覆盖。此恢复只影响失败任务，不重置设备连接或其他任务，不自动重放消息。

回归见 `claude-code/__tests__/startup-cleanup.test.ts`、
`pi/__tests__/pi-startsession-cleanup.test.ts` 与 `maker.test.ts`。

## 工具循环与无响应的分工

工具持续返回但反复原地搜索时，复用
`agents/shared/loop-guard.ts` 的 `ToolLoopGuard`，不能靠缩短无事件超时处理。
Claude Code 在原有 per-sidechain 回调里检测所有模型；Pi / Codex 在 `Session` 中配对
当前产品轮次的 `tool_use` 与 `tool_result_full`，不重复统计结果摘要、后台事件或旧轮次。
三个引擎均关闭“参数各不相同、同类契约错误连续被拒三次即中断”的规则：同类错误
不能证明模型没有在修正调用，Pi / Codex 也尚无可靠模型响应批次标识。运行时沿用
`contractConsecutiveLimit: Number.POSITIVE_INFINITY` 关闭该计数阈值，不新增提醒或自动重试。
完全相同的工具名、参数、输出连续四次仍触发疑似复核，短窗口轮转检测也保持不变；不同参数
持续出现同类错误可能多重试几次，这是减少纠错误停的取舍。旧 `contract` 错误的展示
和历史兼容保持不变。
循环错误沿用 `tool_use_loop_detected` 和既有中断复核，Orca 消费普通终态链路；
该 reason 不进入 interrupted-turn 自动续跑白名单，避免熔断后立即重复原循环。

短窗口判据保持原样；较长的只读搜索轮转只在最近 128 次读/搜结果至多包含 32 种
完整调用指纹，且至少 90% 的结果属于重复至少 4 次的指纹时判定。参数与输出都参与
指纹，不修改实际工具结果；写入或命令结果打断该只读窗口，原生等待工具不计数。
成功的简单 `tail` / PowerShell `Get-Content -Tail` 日志轮询同样不计数
（只认字面 `.log` 路径，可串联多个日志读取）；
失败、混合执行、重定向或源文件读取不套用该例外。等待调用不清空普通调用的循环轨迹。
这仍是有界启发式，不是任意长度循环的证明，也不以没有文件改动作为失败依据。

Codex code mode 下脚本在后台运行，模型同时继续回应；app-server 只逐个上报脚本内部的工具调用，
不标注调用属于哪段脚本，用量通知与思考 item 也会落在同一段脚本的调用之间，后台脚本与模型采样
还会交叠，所以不能按“模型回应”分组，也不能凭全局最近一次结果推断调用归属。Codex 的 Guard 只用
同一调用（name+input 相同）自己的开始时间判断：距它上一次开始不足 2 秒
（`CODEX_BURST_REPEAT_GAP_MS`，两次模型回应之间必有数秒采样）是一阵突发重复，不推进完全相同、
窗口、轮转判据，不算参与判定（因此不会取消进行中的复核），只续接完全相同结果的 60 分钟上限；
写入或命令照常打断长只读窗口，其余调用走原有判据。模型逐次重复同一调用，每次间隔都有采样时间，
照常计数。判据在调用开始时（`onToolUse`）确定并存在该调用上，与其它调用、完成顺序、并发无关；突发结果也不消耗复核放行额度；每种调用最多记 256 种的开始时间。代价：脚本自身的
无界快速死循环只会被 60 分钟上限抓到；循环周期含多种调用且脚本每种间隔都小于 2 秒时，不被判为突发
（2026-10-18 脚本点保存后连续截快照等页面更新被误判）。Pi 与 Claude Code 不启用。

节奏与复核：一次普通调用若距上一次普通调用开始已有至少 30 秒（`sleep` 后再查 CI、
命令内自带等待或慢推理），或其结果距上一次普通结果到达已有至少 30 秒（模型一次发出
多条等待命令、工具再逐条排队执行，发出时刻挨在一起但每条都真等了），视为在等外部进度
的节奏轮询，不计入上述重复与窗口判据，只续接完全相同结果的连续段；同时发出又同时返回的
快速重复照常计数。上述判据命中只算“疑似”（`final: false`）：host 通过
`MakerDeps.toolLoopReviewer`（Pi / Codex）与 `AgentDeps.toolLoopReviewer`（Claude Code）
注入同一个辅助模型复核入口，由 `agents/shared/tool-loop-review.ts` 的 `ToolLoopMonitor`
在后台复核，Agent 不暂停。只有明确 stop 才中断；continue、失败、20 秒超时、无效回答
或未注入复核 → 接下来 20 次普通结果不再报疑似。每个 turn 最多复核 3 次
（Claude Code 各子代理共用这 3 次），用完后放行疑似且不再请求辅助模型，最终硬上限仍有效；
进行中的复核会等到结论；放行额度按普通结果计，节奏轮询同样消耗；
复核结果晚于 turn 结束、接管、关闭或拆离开始到达时丢弃；复核期间若新的普通结果已不再疑似
（模式被打破），或新结果的调用不属于被复核的调用集合（模式被替换），进行中的复核同样作废；结论到达时
若用户目标已被新消息/插话替换，或仍有在途调用不属于被复核模式（此时流式参数已补齐），
结论丢弃；Claude Code 子代理结束后
（父 Agent 调用已有结果）其迟到结论丢弃，等待/轮询工具与未配对结果不算打破（Session 的同步观察与复核结论共用
`toolLoopControlFor` 一个前提判据，等人确认期间不中断，Claude Code 对称检查 pending interaction；
复核终态与同步判定一样，排在已送达完整结果的摘要之后）。以下情况不经复核直接中断（`final: true`）：
快速完全相同调用连续 30 次、完全相同结果（含节奏轮询）持续 60 分钟、长只读轮转。
2026-10-27 用户确认：复核结合用户目标、最新要求、主模型已有的公开行动说明与工具结果，
判断继续是否合理。仅在明确无进展且无合理继续理由时 STOP；手机/游戏操作、截图观察、
界面测试、逐项处理、外部进度轮询可以正常重复，缺画面或证据不足时 CONTINUE。
行动说明只作解释，不能代替结果；所有上下文都是证据，不执行其中针对复核器的指令。
用户目标复用现有有界用户原话投影（宿主提供时包含历史与最新要求），普通发送与插话更新；
公开说明来自当前 scope 最近一段 text 事件，增量拼接、final 全文覆盖校准、工具后有新说明时替换，换轮清空。
不采集 thinking，不额外调用模型摘要，不要求主模型逐次增加说明。先脱敏再截断：
用户上下文发送最多 4000 字符，行动说明最多 2000 字符；缺失明确标注，不补造目标或理由。

同时发送最近 12 次调用的摘要：maker-core 只为限制内存截取未脱敏原文（输入保留原结构，
每个字符串 4000 字符；截取点所在的整行一律丢弃，无换行时丢弃末尾连续串与未闭合引号起的内容），desktop 先在未转义的字符串上逐个（键名像凭证的字段与 argv 中凭证参数名的下一项整项删除）
对完整截取按凭证种类整类脱敏（`redactSensitiveText`、`git-snapshot/secretRedactor.ts`
的厂商令牌与私钥、截断私钥块、URL 内嵌凭证、命令行凭证参数、凭证类 HTTP 头，最后以
含字母和数字的 32 位以上连续串兜底，宁可多删），再截断到每段 400 字符，最后改写分隔标签；
顺序不能颠倒，否则跨截断点的凭证会留下认不出的前缀。走共享辅助模型链，回答只接受
CONTINUE / STOP。供应商分享的受邀者会话（Claude Code 在分享者电脑上运行）与分享者自己的
任务一样，交分享者电脑的辅助模型链复核（2026-10-13 用户裁决，见 `provider-sharing.md` §9）；
Pi / Codex 的检测在任务所在电脑的 Session 上，用的是受邀者自己的复核入口。
回归见 `loop-guard.test.ts`、`tool-loop-review.test.ts`、`session.tool-loop.test.ts`、
Claude Code 的 `upstream-idle-watchdog.test.ts` 与 desktop 的 `tool-loop-reviewer.test.ts`。

## 上下文已满时的引擎边界

Claude Code 在同一模型上达到设置页自动压缩阈值且尚未满窗时，由 host 注入 `/compact`；
Desktop 的压缩比例按供应商与模型统一（默认 90%），所有 Harness 共用，旧全局偏好不再生效。
Pi 在启动或恢复时将模型比例写成原生 `compaction.reserveTokens` / `modelOverrides`，由 Pi 按
`contextWindow - reserveTokens` 处理 threshold 压缩，并在 provider 报 context overflow 时按原生
`Agent.continue()` 语义压缩续接。Cindy 只消费 Pi 的 `compaction_start`／`compaction_end` 事件做
UI、usage 与 digest 投影，不再向 Pi 注入 host 自动 compact RPC。

### 任务级窗口预算（分母）

用户可以在单个任务上选择工作上下文窗口（tokens）：有效窗口 =
`min(任务预算 ?? 模型级上限, 模型级上限, 目录 contextWindowMax)`，由
`maker-host/model-context-settings.ts` 的 `resolveConfiguredContextWindow` 解析，经 start options
（`StartSessionOptions.contextWindowBudget`）下发给引擎：Claude Code 落到
`CLAUDE_CODE_MAX_CONTEXT_TOKENS`／`CLAUDE_CODE_AUTO_COMPACT_WINDOW`，Pi 落到工作窗口与
`compaction.reserveTokens` 的换算预算，Codex 落到 `model_context_window` 与 90% 压缩线。

它是**分母**，与设置页的自动压缩阈值百分比（**分子／触发点**）正交：改变预算只改变「这个任务
能用多大窗口」，不改变「在窗口的哪一点压缩」。任务预算不得越过目录声明的物理上限，也不得越过
用户在同一路由上设过的模型级上限（两者取更紧者）；未自定义的任务完全跟随原判定（老任务零行为
变化）。

渲染层档位表（`shared/sessionContextWindowBudget.ts` 的 `buildContextWindowBudgetOptions`）给的是
**模型默认档 + 占有效上限 25%/50%/100% 的比例档**（最多三档，超出时优先保留大比例）：比例档值按
`round(基准 × 百分比)` 精确换算、不贴 K 网格，低于 `MIN_PERCENT_TIER_TOKENS`（200K）或与默认档
重合的不出现；100% 档只在有效上限高于默认窗口时出现，保证「开满窗口」不丢。新增引擎或改档位规则时，
不要退回「写死 256K/512K/1M」的固定阶梯——1.048M/1.05M 这类窗口会让固定档出现「1M 与 1.0M 并列」
且档数涨到 4~5 档。

档位表的**权威边界**来自 main（本地 `maker:get-context-window-bounds`／远程 device-link 同名 channel，
被控端自己算）：查询必须携带**界面上正在显示的路由**（`{ agent, providerId, model }`）。同一引擎内换模型是
延迟切换（发送边界才落库），期间会话行还是旧模型 —— 不带路由会被按旧行回答，档位表与显示值一起停在旧模型上
（实测：262K 的模型切到 1M 的模型后仍显示 262K）。缓存键也必须含 `providerId`：同一模型跨来源的上限可能不同。

落库后由 main 应用：空闲任务立即关 handle、下一条消息冷重建；回合中登记 pending，回合结束后生效。
运行期真值仍以引擎上报为准（`sessions.context_window`／`context_window_runtime` 的快照口径不变，
任务预算不参与快照覆盖）。切模时目标窗口同样按任务预算在**目标路由**上重新收敛，避免旧模型的收敛值
被沿用。

任务预算存在 main 侧偏好文件（`session-context-budget-store.ts` → owner 隔离 userData 下的
`session-context-budget-prefs.json`，形如 `{ budgets: { "<sessionId>": tokens } }`，null／缺条目 = 跟随
模型默认），**不是会话列**：它不影响会话行读取、不参与任何副本同步、也不需要数据库迁移，因此同一条库
可以在不同版本的包之间自由切换。删除任务时清理条目；fork 时把条目复制给新任务（源未自定义则不动目标，
新任务继续跟随模型默认而不是快照一个当时的默认值）。远程任务同样由**被控端**读自己的偏好文件并在
`maker:get-context-window-bounds` 响应里回带（`budget` / `budgetCustomized`）。

Claude Code／Pi 本机占用 ≥ 100%，或 host／bridge 自动 compact 已确定性失败（空摘要、compact 路径上的
invalid-request 400）时，走
`host-controlled rollover + model-controlled bounded retrieval`：host 关闭旧原生窗口、写交接并
在下一次发送前 fresh bootstrap，不再继续 compact。Pi 原生 threshold／overflow compact 出现同类
确定性失败时也锁存 `needsRollover`；手动 compact 失败不锁存。Claude Code 普通用户轮次结束后的静默
`/compact` 与 rewind／cancellation 桥接 `/compact` 必须共用同一套失败分类：确定性失败锁存
`needsRollover`，瞬时失败 `onCompactCanceled` 等下一轮再压。Stop、graceful-stop 或
upstream idle watchdog 打断静默 `/compact` 时只清 fired，不得在本次 compact 收尾立刻再注入。
该锁存只活在当前 live
controller／进程内；重启后没有 live handle 时不凭估算换窗。Orca 空闲 live 直发必须先走与
`sendToSessionInternal` 相同的 `prepareUnhealthySession`，不能把消息打进应被关闭的旧窗口。切到更小窗口模型的 `danger`／`overflow`
预检在 Claude Code／Pi 仍按 `assessModelSwitchContext`，与同模型 compact 解耦。不要关闭 Claude Code SDK 或 Pi 原生
自动压缩。远端 Pi 同样依赖原生 auto-compaction；远端没有本地换窗，确定性失败不得伪装成已交接。
明确 `context-overflow` 且本轮没有助手输出或
工具副作用时，host 才会对失败的 user 消息做一次 wire-only replay；有副作用或分类不确定时必须
fail closed。compact 失败触发的换窗同样 fail closed，不得自动 replay 已有副作用的用户消息。
PI 的 `pi-prompt-timeout` 是唯一保留的 timeout 交接入口；Claude Code／Codex 的普通
timeout 不得触发自动换窗或 replay。Codex 当前没有与 Claude `AutoCompactController` 对等的 host
自动 `/compact` 注入路径；未来若增加，仍须遵守同一评估和交接边界。Codex 订阅远端压缩若因
`invalid_encrypted_content` 硬失败（`Error running remote compact task`），视为官方 compact
确定性失败，走同一套 host-controlled rollover；单独的 `invalid_encrypted_content`（HTTP 静默剥
推理密文范围）不得当成换窗。手动压缩入口不受此规则影响，
手动 compact 失败不得锁存换窗。

Cindy 保底压缩是**一套**交接重建流程。装得进当前约束就不动；字节预算破了
（可剥的超大内联图）或 token 预算破了，都直接交接重建。Codex 索引历史归原生运行时
所有，不再先尝试改写历史／剥图。决定函数见 `cindyContextCompression.ts`。
字节预算目前只有 Codex 能测量。工具输出不另开一档：图片恢复的交接保留受长度限制、
带调用关联的文本结果摘要，省略图片数据；普通跨引擎交接也默认保留有界工具结果（调用方可显式关闭）。
长消息与结果保留首尾，超总预算时优先保留最近请求与结果、检索指引和结束标记；仍为 16,000 字符预算，不额外调用模型。
可剥图不足一半的混合大尾巴有意不救。打开会话不触发；只在终态错误或下次发送时
由 main 侧 claim。SSH 不承诺。不确定 fail closed。救援摘要不得依赖额外模型调用。
伙伴主对话、话题和 IM 专线与普通 Session 一样依赖原生压缩，不按空闲时长或 70%/90%
伙伴阈值提前重建，也不在正常压缩后重启实例。Claude Code／Pi 保留普通 Session 共用的
真实满窗保护；Codex 不按本地 token 占用提前重建，只在明确失败后检测历史并走恢复。
实际恢复复用持久交接、保留有界工具结果、按输入取消；后台原生工作未结束时不换窗。
伙伴权限依据仍为有效 Bot link 与 active Profile。
伙伴下一次发送也识别已记录、明确来自压缩的空摘要／invalid-request 错误；不扩大原生 latch
规则，不把普通空回复、网络、鉴权或额度错误当作压缩损坏。
Codex 图片历史重建后，普通用户任务和伙伴主对话可在同一任务内自动续接未完成工作。交接包含原请求
和本轮已有进展，新原生线程只接收隐藏的继续指令，不重放原用户请求或已完成的工具操作。
结果不明确时先核实当前状态，不盲目重试；旧原生执行句柄不能跨线程恢复。
每条用户输入最多自动恢复一次，沿用重建记录与输入身份去重；已有助手／工具消息只禁止
原请求 replay，不阻止本次图片恢复的 CONTINUE。普通 context overflow 的 replay 保护不变。
停止／清空或新输入接管会取消待续接的恢复；已有排队输入时不抢先续接。
取消覆盖重建、提交与发送边界。interrupt／unsubscribe 等待期间到达的
权威成功结果优先于 oversized 错误；事件队列关闭前统一结算，不能再触发自动续接。
续接沿用原输入的插件能力选择，不把隐藏续接提示或历史授权当作新选择。
外部分发者仍拥有自己的重试；IM 原生任务、仍绑定 IM 的任务及尚未结束的外部分发 turn
不进入 Desktop 图片历史自动恢复，不以缺失消息 origin 推定桌面授权。成功仅展示上下文整理分隔条，
恢复或续接失败才显示错误与手动继续指引。发送前恢复不额外续接，避免与用户新输入重复。
切模型预检的数学仍在 `assessModelSwitchContext`。本机普通任务的用户选模只登记待应用意图，
不改当前 route 或原生线程；用户反复改选时覆盖意图，以实际发送时的最终选择为准。
沿用跨引擎的 pending registry 与发送入口，不能在 turn 结束或定时巡检时自动消费选模意图。
设备互联控制本机任务同样适用；SSH 与 Orca 保留各自的运行时边界。
同引擎切到更小窗口时，main 在实际 send 持有的 session 锁内按目标窗口评估；
用户发送即同意为最终选择执行必要的上下文整理，不再弹出二次确认。
仅选择或反复切换模型不构成整理授权；同窗或扩窗不因此触发摘要重建。
Claude Code／Pi 的强制换窗线
统一固定为目标窗口 90%，与各 harness 的日常 auto-compaction 百分比解耦；Claude Code
与 Pi 的日常默认值也设为 90%，对齐 Codex 口径，但用户已有显式 override 继续生效。命中
`danger`／`overflow` 的本机会话先走同一套 `context_rebuild` bounded handoff，再落目标
route，不能 resume 旧原生窗口。
Codex 同引擎切模（包括自动任务、Orca、设备互联与 SSH）保留原生历史，由 Codex 自己判断并执行
压缩；本地同供应商冷恢复时可先用旧的大窗口模型压缩，再执行目标模型。跨供应商不假定目标凭证
能调用旧模型；旧模型预算不可用时，原生仍按目标预算在采样前压缩。SSH 的逐 thread 预算也保留
这条目标模型原生压缩路径，不能因无法使用旧模型而提前拒绝切模。不得仅因目标窗口较小、占用到
90%／100% 或伙伴账本新鲜而抢先生成 Cindy 交接。窗口预算与用户 override 保持不变；重载模型
目录或凭证执行句柄不等于重建历史。Cindy 只在明确的上下文超限、原生压缩失败或历史字节超限后
沿用既有兜底及副作用保护。跨引擎交接和显式重启仍按各自生命周期规则处理；伙伴不再执行空闲间隔刷新。
真实 CLI 的同供应商、跨供应商与逐 thread 预算回归见
`apps/desktop/src/main/maker-host/__tests__/codexContextSwitch.native.test.ts`；逐 thread 回归在本机
模拟服务运行，不代表完成了真实 SSH 端到端验收。
Codex 跨凭证优先保留同一个原生线程；仅当目标需要另一个 host、旧 host 仍持有原生 writer
时，关闭该任务的业务 handle 后使用不剥离历史的原生 fork，并等待一次性 fork host 退出，
再以任务 owner 与旧 SDK／路由版本为条件原子保存新 SDK thread 和目标路由。任务 ID 与
消息历史不变，无关任务与 host 不退出；旧 writer 已释放则不 fork。`ordinal` /
`history_base` 本身不能成为改写历史的理由。
本地恢复与分叉必须同时固定该线程的原生历史根
（`CODEX_HOME`，含 `sessions` / `archived_sessions`）和数据库根（`sqlite_home`）；
仅固定 SQLite 不足以恢复分页祖先，原生按不可变 rollout ID 在历史根内查找祖先。
本机外部 Codex 导入完成历史快照交接后、调用原生恢复前，必须将 paginated 历史的
`rollout-cindy-adopted-*` 名称恢复为原生规范文件名（#7436）。保留原名中的 thread ID
及可选的独立 rollout ID，不修改历史内容。存量错误路径在已记录的历史根和 SQLite 根内
修复：不覆盖地建立同 inode 的规范名称、条件更新 SQLite 指针，返回规范路径；修复阶段不写位置索引，
避免读取后替换覆盖另一进程的最新记录。旧索引仍能通过同 inode 别名恢复，由正常原生线程登记更新索引；
保留旧名称，使中断重试与已打开的 writer 不会丢失追加内容。遇到另一份规范文件或状态
已被其它操作切换时明确失败，不覆盖、不重新导入子历史，也不从聊天投影重建。
带 `history_base` 的分页历史恢复前必须补齐所引用的完整祖先链，按原生 rollout ID
（可能不同于 thread ID）查找，并保留原始字节、序号与归档位置。存量导入缺少祖先时，
仅从与已选子历史的原文件名、首条元数据完全匹配的外部 HOME 补齐；已有 SQLite 指针指向自定义目录时，
在交接指针前将来源根与子历史首条元数据原子保存到私有副本旁的 `.source.json`，中断重试仍使用该来源。
来源记录不覆盖，且不能绕过子历史匹配和祖先校验；无记录的旧导入仍走候选目录发现。来源不明确、
祖先缺失／越界／循环或已有副本的引用范围冲突时明确失败。已有子历史和祖先的后续
追加不被替换；已有祖先仍使用 Cindy 旧文件名时，通过同 inode 规范名称复用，不能另拷贝
导致父任务恢复冲突。整链先校验，再从最早祖先开始不覆盖发布，中断可重试。补齐后外部 HOME
不可用也能恢复。异步复制后重查 SQLite 指针和位置索引，不能覆盖并发归档或切换。
只读归档／导出查询不触发修复。Windows 扩展盘符与 UNC 路径在相对路径计算前统一表示。
实现见 `maker-host/codex-local-sessions.ts`、`codex-thread-locations.ts`；默认回归在
`main/__tests__/codexLocalSessions.test.ts`，真实恢复与下一轮发送在同目录的
`codexLocalSessions.native.test.ts`（显式指定 `CINDY_CODEX_TEST_BINARY`，隔离目录与本机模型服务）。
归档状态以 Cindy 的 `sessions.status` 为准。Codex 经原生 `thread/archive` /
`thread/unarchive` 同步历史位置与索引，成功后更新线程位置记录；禁止直接改原生 SQLite
或搬动 rollout，也不能为归档触发历史复制／重建。启动时补齐存量状态，忙碌任务、离线
SSH 或暂时失败按组退避重试；只有状态变化的组才调用原生接口，未变化的组每小时批量复核
一次（兜底 Cindy 外的原生操作）；本地归档用的 app-server 只做存储 RPC，不挂 MCP bridge；共享原生 ID 的活动任务优先，不关闭其他任务的进程。同步必须
持有任务路由锁并验证当前 owner，使用原历史根与数据库根。Claude Code 与 Pi 当前没有
原生归档接口，保持 Cindy 状态；历史扫描及重新导入不得覆盖 Cindy 的归档与归档任务的
项目目录、额外目录及可写目录范围。手机远控复用宿主同一状态写入路径。
普通已归档任务再次发送时，宿主在恢复运行时前先恢复 Cindy 状态，沿用任务路由锁和状态广播。
若 Codex 的后台投影尚未取消归档，只对该线程明确的原生已归档错误调用 `thread/unarchive`，
记录移动后的历史位置并重试一次恢复；不新建线程、不重放用户消息，其他错误照常失败。
已删除任务、伙伴托管任务及协同 Worker 不经普通发送自动恢复。
凭证、代理路由和模型目录仍按本轮选中账号准备，不能把历史根写回全局账号配置。
跨历史根的原生进程从启动参数要求 `cli_auth_credentials_store="ephemeral"`，清除继承的
原生身份环境变量；OAuth 通过独立的 external-auth adapter 在进程内安装目标账号 token，
网关与第三方 OAuth 继续使用既有代理认证。所有跨根进程在分发任务前检查生效的临时凭证
配置；每次重连重新认证，刷新必须匹配冻结的 owner、host 代次及账号，且不能复用刚被
拒绝的 token。owner 切换 pending 期间，即使 owner key 尚未提交变化，也必须在异步认证
读取前后拒绝提供 token。刷新有超时，失败走正常错误路径，不切回历史所属账号。
Codex 用量读取若收到原生 `account/rateLimits/read` 的明确 `401 token_expired`，
在同一个账号控制 host 上调用一次 `account/read { refreshToken: true }`，成功后仅重试
该只读 RPC 一次。其它错误、明确撤销与刷新失败直接返回；不清凭证、不重发模型 turn。

同 owner 的 Ghost 投影修复会更新账号代次但保留 Maker 与活跃任务；凭证 reader 固定
owner 身份、认证 realm 和 CodexAgent 实例，每次读取单独捕获代次，不能将创建时的代次永久锁在
reader 上。跨修复的在途读取仍拒绝，修复完成后的新读取可正常刷新；真正切账号或
切到另一认证 realm（即使 membership ID 相同且 Maker 保留）时不能提供凭证；
Maker 被替换后旧 reader 必须失效，包括切走再切回同一 owner。回归见 Desktop
`codexAuthTokenReaderBoundary.test.ts`，可通过 `CINDY_CODEX_TEST_BINARY` 实跑原生 401 恢复。
该 adapter 依赖 Codex 实验性的 `chatgptAuthTokens` 协议，0.145.0 已支持该协议且通过
真实登录及 401 刷新契约验证，不能把 0.153.4 当作协议最低版本。更换原生运行时前必须
用目标二进制运行 `CINDY_CODEX_TEST_BINARY=<绝对路径> pnpm --filter @cindy/maker-core exec
vitest run src/agents/codex/app-server/external-auth.native.test.ts`，覆盖分页祖先、归档、
分叉、重连、实际请求身份和 401 刷新。测试只用临时历史、假凭证和本地 HTTP 服务。
管理员 requirements 可能覆盖 CLI 临时凭证设置：客户端可阻止后续任务，但启动后的
配置检查不能证明原生初始化阶段从未读取历史根中的认证；不得声称具备这一保证，
也不得自行复制上游策略加载器或改写用户认证文件规避策略。
原生线程的 `model_provider` 不能证明其 `agent_message` 密文的实际来源：
独立子 Agent 可以经代理使用其他供应商，而原生身份仍继承父线程。恢复到 GPT API 时，
不得仅凭父线程的订阅身份自动删除协作密文；普通提前闭流也不是解密失败的证据。
遇到 `stream closed before response.completed` 的终态错误时，两端可提供显式的
可读历史恢复入口，保留普通重试；复用 `fork-strip-encrypted`，保留原任务且不自动发消息。
Desktop 与 Mobile 恢复进行期间只禁用来源任务的重试，不阻塞其他任务；原任务出现新输入或重新运行后，
迟到的恢复结果不得自动跳转，旧操作完成时也不得释放其他任务或后续操作的等待状态。
Desktop 回包还须核对浏览器当前路由，覆盖地址已切换但 React 尚未渲染新任务的窗口。
旧格式包含加密 `agent_message` 时也走既有历史恢复标记，不由 legacy sanitizer 丢弃消息。
普通加密推理失败继续使用现有 HTTP 透明重试；只有上游明确
拒绝且请求里仅剩不可剥除的压缩块密文时，proxy 才标记
`CINDY_ENCRYPTED_COMPACTION_INCOMPATIBLE`，交给既有 compact 失败恢复流程。
裸 `invalid_encrypted_content`、网络错误和切换来源本身都不足以触发该恢复；保留同一用户消息
最多一次重放及已有产出／工具副作用禁止重放的边界。
跨来源恢复必须在共享、独立上下文和控制面代理中按同一 thread 身份查找并关闭连接，
关闭任务时也清理这些实例里的同 thread 保活状态；不能只查共享代理而漏掉实际承载连接。
分支优先使用已保存的原生 turn 锚点。Codex 0.153.4 起，旧消息或失败轮没有锚点时，
先用 `thread/turns/list(itemsView: notLoaded)` 查询终态边界，再 `thread/fork(lastTurnId)`，
不能对分页线程执行 rollback；0.156.0 起运行时已移除 `thread/rollback`，编辑重发与回退
一律走同一边界 fork。界面软删重试不代表原生 turn 消失，有复制事件时间时据此
定位，不按可见 user 行数猜边界；复制事件时间缺失、原生时间缺失或秒级精度无法确定顺序时明确失败，不截错
历史。回退目标是当前原生线程的第一轮时（目标之前没有属于该线程的 user 行：首条消息，或
`/clear`、上下文重建、切换引擎新开线程后的第一轮）没有可 fork 的边界，由宿主标记
`rewindsToNativeThreadStart`，Codex 按当前配置换一条空线程；归属沿用锚点的 agent_switch
链，切回停泊线程时更早的片段仍算当前线程，判定不出就明确失败，不能把「找不到边界」
当成第一轮。不可解析或没有 `fromSdkSessionId` 的 `agent_switch` 视为归属不定，同样
不得标记 `rewindsToNativeThreadStart`。最近的 `context_rebuild` 截断更早历史，不能让
重建前的 `agent_switch` 把归属设回当前线程。`targetCreatedAt <= sessions.clearedAt` 必须拒绝，
不能把 `/clear` 之前的目标当成当前线程第一轮。`INPUT_CLEAR_SESSION` 不进
`withSendToSessionLock`，因此判定时读到的 `clearedAt` 必须作为 `expectedClearedAt`
传入 `rewind.commit`，并在 SDK 换空线程之前再核一次；代次已变则整单失败，不得软删
`/clear` 之后的新消息。实现见 Desktop `maker-orchestration/rewind.ts` 与 maker-core
`agents/codex/index.ts` 的 `commitRewindFiles`，回归见 `rewind.test.ts`、`fork.test.ts`、
`rewindNativeBoundarySqlite.test.ts`、`tx.test.ts` 与 `index.test.ts`。
Claude 回退／编辑重发的目标之前没有可续接的 assistant（首条消息，或之前的轮次都在回复前被
停掉）时不报错：宿主传 `rewindsToNativeThreadStart` 只借原生检查点回滚文件（另一台电脑上的
Claude 用本机保存点），再关闭会话；`rewind.commit` 在同一事务里软删目标、清掉
`sdk_session_id` 并写入隐藏 `context_rebuild`（reason `message-rewind`），把目标之前仍保留的
可见历史作为交接，下次任意入口发送时注入全新原生会话，没有 user 历史时交接为空。
查询与 fork 使用同一隔离控制面 host，关闭其写入进程后才发布子线程身份。
HTTP 回退遇到缺失 `Content-Type` 的成功响应时，只允许从明文 SSE 前缀（可带注释心跳）
确认事件流并补齐响应头；显式非 SSE 类型、HTML／JSON、空响应与只有心跳的正文不能放行。
正在运行的 turn、SSH 远端缺少本地交接能力、或已有恢复动作在途时必须 fail closed，不能
先热切再发送。三个 harness 的同模型自动压缩所有权保持不变。token 破了只认：终态超限、
Claude Code／Pi 占用 ≥ 100%、官方 compact 确定性失败；Codex 单纯占用到线和普通 timeout 不算。

Codex 已选远端压缩的本地任务，在原生 `contextCompaction` 生命周期内收到终态失败时，
只有明确的 HTTP 400/404/405/422/500/501/502/503 拒绝或失败响应，才自动改用同一模型的
原生摘要压缩；包括远端压缩耗尽内部重试后的短时 429，使用同一账号
仅接替一次。明确的账号／任务额度耗尽、鉴权与已有密文硬失败交接分类保持原处理。
这不是换窗交接：native fork 保留完整历史，Cindy 业务任务不变，不改模型或全局压缩设置。
Codex 0.153 的 unsubscribe 会延迟卸载 30 分钟，不能靠立即 resume 假称 provider 已更新。
接替身份保存在原生任务的 modelProvider 中，重新打开继续沿用，无 UI 开关、无自动切回。
已有本轮模型/工具输出时以空输入续接，不重放用户请求；尚未进入生成的 pre-turn 失败才重投
冻结输入。本地摘要再失败即正常报错，不循环切换。尚未结算的原生 exec continuation 无法跨
线程迁移，不得重建后声称它仍可恢复。普通生成 502 与 stderr 文案不得触发此路径。

Codex 的 120 秒 reconnect watchdog 只是 fallback 收口，不是根因诊断。stderr 仍只作诊断日志，
不得用 `remote compaction v2` 文案驱动恢复动作，也不得根据图片历史大小把重连超时
改写为历史故障（包括读取已保存消息时）。收到当前 turn 的原生 `contextCompaction`
开始事件后，取消短重连计时，压缩期间交给既有 upstream-idle 长超时保护；完成后恢复
普通重连规则。重连中断结算前的成功完成优先，不得提前发错误触发重建。
收到 Codex 的 `warning`「Falling back from WebSockets to HTTPS transport」后同样清除重连
计时：HTTPS 要先上传完整历史才有事件，交给 Codex 自身 HTTP 超时与 upstream-idle 兜底。
ChatGPT 订阅 WebSocket 单条消息上限约 16 MiB（超限回 1009），codex-proxy 在出站消息超过
15 MiB 时按 #5103 的附件外置把最旧的内联附件转为本地文件；这是按实际出站字节判定，不是
按历史体积推断断连原因。
普通 timeout、纯文本大历史和网络失败
不得进入这套压缩，也不得进入自动续跑死循环。`status` / `account_usage` 是传输层或用量
心跳，不得刷新 Session 零事件看门狗或 Codex upstream-idle 计时。`text` / `thinking`
只有包含实质文字才刷新；仅空白、Unicode 格式字符或控制字符不算进展，原事件仍无损传递。
这两类超时与
`codex_reconnect_stalled` 同类，进入 interrupted-turn 自动续跑；自动续跑对这三类
**只发 CONTINUE 指令，绝不克隆原始用户 prompt**（turn 已被 accept，克隆会重放已执行的
工具副作用）。Claude rewind / cancellation bridge 的 `/compact` 位于真实用户输入之前，
Claude idle 超时使用 `bridge_upstream_response_idle_timeout`；共享 Session stall 同步查询
handle 的只读 `isPreparingUserTurn()`，使用 `bridge_turn_no_event_timeout`。两者不进入
该自动续跑白名单；查询复用 Claude 唯一的 `bridgeStateActive()`，包含 compact result 后
到下一 SDK 消息前的间隙，不新增桥接状态。保持既有
清队列、保留重建目标与人工重试行为，不能对尚未执行的用户输入发送 CONTINUE。
引用内容解析等异步准备仍属于未派发态；完成后复核 active 身份，再在真正调用 send 前
标记 sendStarted，迟到的准备结果不得发送或修改已经交给 replacement 的项。
自动 CONTINUE 保留原请求的 Plan 与权限选项；超时恢复不等于 ExitPlanMode 批准，
不得强制 planMode=false。若原计划已批准后执行失败，缺少可靠的审批周期记录时仍保守
保留原 Plan 选项，可能重新进入计划模式；不为避免重入新增审批状态。人工 Retry 沿用
既有合成 UI 动作策略，本自动恢复修复不调整该策略。
退避窗口内 provider / Session 因 stall abort 复核、terminal-error drain
或 interrupt ACK 失败而 `unexpected` close 时，必须用实例 + attemptToken 精确保留交棒，
不得 teardown 已批准的自动续跑——包括 timer 已 fire、CONTINUE 已因 SESSION_RUNNING
回队、CONTINUE 已进入 drain 但尚未 vendor dispatch、以及 CONTINUE 已 sendStarted 但
send outcome 尚未返回的窗口。尚未 sendStarted 的未派发项必须重新入队再唤醒 replacement；
send 已开始则等真实 outcome——vendor 已 accept 必须 commit、禁止二次 CONTINUE；
`TurnDispatchUnconfirmedError`（adapter 已发出请求但无法确定 provider 是否 accept）
不得自动再发 CONTINUE，按可能已 accept 提交本次 attempt，并结算 AutoResumeBookkeeping
（pendingOutcome=failed、丢弃 suppressed、rollback guard）；不得走会补落旧错误、恢复
recovery 或再入队的 undispatched finalize。确认失败且 attemptToken 仍匹配才重新入队。
显式关闭 / 停止已清 token 后，sendStarted 且已落库的隐藏 CONTINUE 必须丢弃，不得落成
可重试 recovery。unexpected close 的 preserve 只认三类 CONTINUE-only reason
（stall / idle / reconnect-stall）；generic clone-原文 retry fail-closed 不交棒。
连续 replacement `unexpected` close 时 WeakMap lease 可能已随旧实例消失，必须按同一
attemptToken 把 lease 绑到新 Session，或在 coordinator / guard / book 仍一致且队里 /
live schedule 仍活着时继续 preserve。预算内不能 discard 或只留人工 recovery，也不能清掉
sessionRunningRetry 就停。每次因 replacement 关闭而重新入队都计入同一份三次派发预算，
包括尚在 pendingQueue、已取出但尚未发送、以及发送确认失败的窗口；一次 close 不能对
刚放回队列的 active 项重复计数。等待发送结果本身不重复计数，耗尽后恢复原错误并停止交棒。
用户显式关闭 / 停止仍取消。连续失败上限与人工介入周期硬上限止损，额度耗尽才把 Continue 交还用户。


> **适用范围与增量原则**：Agent 能力归属（下节 1）与代码优先确定性（下节 2）按增量
> 适用——约束新增和正在修改的代码，不要求为统一形式专项重构存量。但**核心指标不变量
> （下节 3）与 system prompt 改动门禁（下节 4）对所有触及相关路径的改动都生效，不分
> 新旧代码，也不因“只是小改”豁免**。

## 事实来源

| 内容 | 权威来源 |
|---|---|
| Claude system prompt 拼接与 model 路由 | `packages/maker-core/src/agents/claude-code/index.ts` |
| Codex 侧对应实现 | `packages/maker-core/src/agents/codex/`（对应 index／translator） |
| vendor 事件到 `AgentEvent` 的映射 | `packages/maker-core/src/agents/*/translator.ts` |
| 缓存率／token 计量 | `packages/maker-core/src/agents/shared/usage-tracker.ts` |
| Agent 抽象与共用逻辑 | `packages/maker-core` 的 `BaseAgent` 及子类 |

文档与实现冲突时以代码为准，但必须在同一改动内同步修正本文。

## 1. Agent 能力归属 maker-core

- Claude／Codex 等 Agent 的具体逻辑放在 `packages/maker-core`，不在 Main 或 Renderer 里
  重新实现 Agent Loop。Main 通过 maker 调用和访问 Agent 能力与信息。
- 共用逻辑尽量下沉到 `BaseAgent` 抽象方法，子类只实现各自差异部分，避免多 Agent 实现
  各写一套编排。
- 这与产品原则一致：Cindy 负责**连接**而非重造智能，连接层应忠实传递底层能力、工具、
  事件、上下文和结果，不在中间造成无意损失（见
  [`../product-rules/core-product-principles.md`](../product-rules/core-product-principles.md)）。

### 代输入：任务 shell 环境与工具说明（2026-10-13）

- `runtimeConfig.taskShellEnv({ sessionId })` 给本任务 Agent 运行的命令注入代输入 askpass
  （`SUDO_ASKPASS` / `SSH_ASKPASS` / `GIT_ASKPASS` 等，只含本机一次性路由，不含秘密）。三个 Harness
  只对**本账号的本机任务**调用：SSH 远程、Review、设备托管访客任务一律不注入。Claude Code 与 Pi 写进
  Agent 进程 env；Codex 的 app-server 共享，按线程经 `shell_environment_policy.set.<名>` 设置。
  返回值必须按 sessionId 确定，重启进程得到字节相同的 env（否则破坏缓存与重建一致性）。
- `request_input_handoff`（`packages/lizi-mcps/src/xdt-helper/input_handoff.ts`）的使用时机只写在工具
  说明里，**不改 system prompt**；子 Agent（`mcpCallerKind === 'descendant'`）与远程工作区任务直接拒绝。
  何时该发起靠工具返回提示（如 `cindy_computer` 拒绝直接操作保密输入框），不靠提示词。
- 续接是隐藏的 `[Input handoff ended]` 合成消息，只有事实；产品规则见
  [`../product-rules/input-handoff.md`](../product-rules/input-handoff.md)。

## 2. 优先用代码保证确定性，而非依赖 prompt

能用代码保证的行为都写在代码里，让结果可预测、可测试、可调试；prompt 只承担真正需要
语言理解／生成的那部分。

- 判断、分支、校验、状态机、数据结构转换、流程编排、权限控制、错误处理、重试与兜底
  一律用代码实现，不甩给 prompt“自己判断”。
- 打算用 prompt 解决某个问题前先自问：这件事用代码能不能做？能就用代码。
- 把本应由代码保证的确定性逻辑（格式校验、字段抽取、流程跳转、是否调用某个工具等）
  交给模型自由发挥，会引入不可复现的行为漂移，属于本规则明确禁止的做法。
- 下游 harness 自带的能力与 Cindy 重叠、或结果只在厂商自家界面可见（如 Claude Code 的
  `SendUserFile`／`Artifact`、claude.ai 连接器、Codex 的 `visualize` 插件）时，不靠 prompt
  劝模型别用，而是在 host 能力路由表
  （`apps/desktop/src/main/maker-host/capability-routing.ts`）加一条 `disabled` 路由，由各
  harness 适配层从模型可见面移除：Claude 用 SDK `disallowedTools`、flag settings 的
  `deniedMcpServers` 与 `skillOverrides`，Codex 用线程级 `plugins`／`mcp_servers`／
  `skills.config`。各 harness 适配层用同一个判断函数决定能否执行某条路由并生成参数，
  `findUnenforcedCapabilityRoutes`（`packages/maker-core/src/agents/capability-route-support.ts`）
  直接复用这些判断；路由表里有执行不了的规则（来源类型不对、缺必填字段、Pi 等没有适配的
  harness）会被测试拦下，不会静默失效。Claude 的 `skillOverrides` 与 `deniedMcpServers` 都只按名字
  匹配，分不清来源，同名的用户／项目 Skill 或 MCP 会被一起关掉；路由表只写 harness 专属名字（如
  `artifact-*`、带命名空间的插件 Skill、`claude.ai ` 前缀的账号连接器），`design` 这类通用名不关。
- Cindy 的目标模式由 `goal-host` 统一管理续跑、预算与暂停／恢复。Codex 创建和恢复线程时
  使用会话级 `features.goals=false`，避免模型另建原生目标，形成绕过宿主调度与来源标记的
  第二套循环；不写用户的全局 Codex 配置。不能仅把无来源事件改判为目标事件，否则用户
  插话和停止边界仍会失真。实现与回归见 `agents/codex/index.ts`、`index.test.ts`；
  `goal-ownership.native.test.ts` 用隔离的原生运行时验证旧目标恢复后不再自行续跑。
- **产品 turn 未结算不得结束。** provider `turn/completed` 可以立刻给 SDK turn 落墓碑并
  结算 usage；只有原子挂在该终态边界上的显式 continuation claim 才能挡住产品结束。
  Codex 同步提问／计划审阅尚待用户确认时同样保留产品边界：底层可继续独立工作并结束
  SDK turn，但不能触发完成通知、队列收口或协作任务完成。人工等待使用独立 claim，
  复用 `turnContinuationId`，不能塞进 yield claim 造成回答续跑等待自身。计划审阅必须
  在发布边界前登记；回答／批准后沿原意图续跑，取消／Stop 单次结束且不重复结算 usage。
  起跑回执之前到达的终态先缓冲再核对归属；失败只能走失败终态，不能先以取消回调
  触发定时任务的成功收口。回归见 `agents/codex/index.test.ts` 的 pending confirmation
  与 human continuation 用例，以及 Desktop `sessionEventPipeline.test.ts`。
  Codex 异步提问使用 `agentMessage.delivery=async` 与结构化 `questions` 接入同一提问
  流程，不把回退正文当成最终回答。未回答的异步问题不保留产品边界，原轮次结束时撤销
  原生请求；未操作的卡片自动收起、不代选答案，也不提供历史回答入口。原生请求的迟到
  回答不得续跑；已编辑草稿的显式补充发送见下文。结束前已提交的回答优先通过 `turn/steer`
  送入原轮次；发送与结束竞态导致原轮次明确拒绝接收时复用人工续跑，发送结果不确定时
  提示错误且不自动重发。Stop、失败、关闭及被替换问题的迟到回答不得续跑。
  协议与前缀稳定性实测见 `agents/codex/async-user-input.native.test.ts`，
  卡片、回传、去重及取消回归见 `agents/codex/index.test.ts`。
  Claude Code／Pi 通过 `cindy_helper.ask_user_question_async` 复用现有卡片；工具立即返回
  pending 回执。Codex 只保留原生入口，MCP 按请求时的 harness 隐藏并拒绝这条工具；
  `Session` 也按实际引擎拒绝 Codex 调用共享入口，防止陈旧上下文创建第二套待回答状态。
  Claude Code／Pi 的 `Session` 共用 `agents/shared/async-user-questions.ts` 管理问题寿命，
  不登记阻塞交互或人工续跑。回答只走原执行的 steer，结束／Stop／关闭／替换后作废，
  发送失败不重投新 turn。Claude 会把已排队的答案合并为下一 SDK 段：仅在答案已被接收
  时复用现有 continuation claim 保留产品边界，避免提前完成或重复完成；未回答不建 claim。
  Claude 前台已结束、仍等待后台任务的 continuation 也接受用户插话，送入原 SDK 输入队列；
  已接收的补充归当前等待段，不能额外制造一个后继 claim，后台任务停止也不能丢弃补充。
  插话被拒绝不等于产品结束，宿主必须复核实际运行态后才能合成结束边界。
  回归见 `abort-stops-background-tasks.test.ts`、`background-steer.native.test.ts` 与 Desktop
  `agent-input-coordinator.test.ts`；原生测试使用真实 CLI 和本地模型端点，不消耗订阅额度。
  Pi 在原生 RPC 排队后再核对执行代次与取消信号，防止答案串到
  下一次执行。Claude 的本机 hook 与远端 root-only guard 禁止原生子代理直接提问；工具
  入口只接受宿主标明 `mcpCallerKind=root` 且 `mcpCallerAttested=true` 的请求，身份未知、
  缺失或未证实均拒绝；不提供通用 call_tool 别名，避免绕过该判据。
  SSH、手机沿用既有 MCP／交互传输通道。
  回归见 `session.async-user-questions.test.ts`、MCP `asyncUserQuestionTool.test.ts`；
  两种真实 harness 配本地假模型的投递与稳定前缀实测见
  `agents/shared/async-user-questions.native.test.ts`。
  宿主的同步与异步问题共用卡片时，同步问题优先：已有同步问题等待时不再显示异步卡片，
  同步问题后到时收起未回答的异步卡片，避免遮住阻塞执行的问题。三个 harness 均只保留
  最新一张待回答的异步卡片：显示新卡片前先将旧卡片标为被替换，旧答案即使在原轮次
  结束前到达也不得投递或清除新卡片。Codex 的同步工具结果
  仅在同步协议别名间按内容去重；异步只按 item id 去重事件，不共用 pending／submitted
  答案缓存，同轮同文案的新 item 也必须重新询问。答案被接收后，卡片不再属于待回答
  集合；即使投递尚未完成时遇到结束／Stop／替换，也只能取消投递，不能把已回答卡片
  再标成过期。异步问题被跳过、取消或没有对应问题的非空答案时，只结算卡片，不更新
  审查意图、不投递占位答案、不建立 continuation；同批问题至少一个有效答案仍可投递。
  Codex 复用规范化答案与 `hasSubmittedUserInput` 判据，同步提问的 Skip 行为保持不变。
  交错回归见上述 Session 与 Codex 测试。
  原生与共享异步请求均携带 `InteractionRequest.delivery=async`；Session 不把它们计入
  阻塞交互或生命周期等待，未回答也不能暂停工具循环检测／零事件看门狗。字段缺省仍按
  同步等待处理；Codex 本机／SSH 共用同一 adapter，手机卡片仍走既有宿主交互通道。
  回归见 `session.tool-loop.test.ts`、`session.turn-stall.test.ts`。
  **已开始回答的异步卡片保护（桌面、手机及远控共用）。** 用户输入文字（含中文组词）
  或手动选择选项时锁存本端草稿；仅聚焦、展开输入框及默认预选不算。停顿、失焦、
  删空、切任务、原轮次结束及新请求到来均不撤销保护，新请求排在当前输入后面。
  原生请求照常撤销，不延长 provider turn；草稿只保存在本端内存，不增加历史回答、
  跨设备草稿同步或重启恢复。提交、主动关闭、任务清空／删除或账号切换才释放草稿；
  原问题被其他端确认回答时也收敛。
  提交先尝试原生回答；拒绝／回执丢失时读取原问题的宿主消息行，已回答则不重复发送，
  只有确认 cancelled 才把原问题与答案作为普通用户补充，复用 steer／输入队列和
  来源标记。结果未知时保留草稿；同一原问题的同文补充使用相同 clientId，修改正文后
  使用新 ID。Stop 不自动续跑，用户点击「发送并继续」才恢复暂停队列；关闭或空答案
  不触发补充执行。UI 草稿不属于宿主 pending interaction，不影响工具循环检测或调度。
  回归见 Desktop `askUserDoneRace.test.ts`、`askUserQuestionIdentity.test.tsx`，
  Mobile `InteractionPanelReceipt.test.tsx` 及 shared `interaction.test.ts`。
  Codex `functions.exec` yield 没有协议级 execution handle（cell / wait 活在
  `codex-rs` daemon），近期检测只能是 adapter 内、用真实 rollout fixture 锁死的启发式，
  用来铸造有界 claim，再由宿主确定性开续段让模型 wait 同一 cell。
  `commandExecution` 带数字 `exitCode` 时，结构化退出结果优先于正文：即使 stdout
  完整复刻 running 状态头，也不得铸造 claim；不能仅凭 `status: completed` 排除
  没有退出码的旧版 yield 包装。实现与回归见 `agents/codex/yielded-exec-cell.ts`
  及其测试（均位于 `packages/maker-core/src/`）。无 `id`／`call_id`
  的 item 只认 `itemCompleted` 快照：`itemUpdated` 不得入账，不得给匿名条目发明身份。
  无 yield marker 的 nameless 完成不得清匿名桶；匿名 `wait` 若按 `cell_id` 结算了其中一个
  cell，只从匿名桶拿掉该 cell，不得清空仍在跑的其它匿名 cell。同 turn 或续段里
  后续 `wait` 输出 `Script completed` / `Script terminated` 后视为该 cell 已结算，不得
  再铸 claim，也不得报 lost-handle。Plan Mode 审批只在执行段结算后跑：存在 awaiting
  yield claim 时不得把空计划当循环结束，也不得在 SDK `turn/completed` 上提前挂审批；
  origin 已产出的计划挂在 claim 上，续段结算后再审。禁止把 `last_agent_message == null` 或开场白当结算
  判据；空续段或重试耗尽只证明未取回结果，统一报 `yield-continuation-incomplete`，
  不得推断 cell 丢失或由跨 turn 导致。用户错误不带 cell 编号，原因和编号保留在诊断日志。
  真实 `not found` 也可能来自重复等待已消费的 cell，不等同于底层命令丢失；
  已结算 cell 不因后续重复等待失败而重新入账。不得 replay 原请求或重跑已执行命令。
  续段 claim 一旦挡住产品结束，所有非重试终态错误路径（不限
  transport）都必须同步结算它，不能只推 Done 而让 `isTurnRunning()` 仍为 true。
  续段 `turn/start` 已被服务端接受后若本地取消，必须先凭响应里的 turn id 落墓碑并
  best-effort interrupt，再抛/返回取消；`wait` 仍输出 running marker 视为 cell
  存活证据，重试预算内继续等，不得当空续段报 lost-handle。
  claim 只归属于铸造它的 origin turn 及其续段 turn；迟到的外族终态（含成功
  `completed`）不得结算、取消、lost-handle 当前 claim，不得发出未认领的
  产品 `done`，也不得结算当前续段的 generation／usage。同一产品 turn 上的
  ask_user／plan 内部续段必须等 yield 空闲后再 `turn/start`，不得并发；Stop／
  close 取消 yield 时，排队中的内部续段必须退出而不是被当成正常空闲继续发送。
  只有 cell 真正结算的成功空闲才能唤醒排队续段；lost-handle、重试耗尽、
  续段 `turn/start` 失败等产品失败必须以 cancelled 释放 waiter，并闩住后续
  `waitForYieldContinuationIdle()`，同时收掉未完成的 ask_user／plan 卡，不得在用户
  已看到失败后再开 ask_user／plan turn。续段启动失败的产品终态只由续段层
  发送一次（`yield-continuation-start-failed`），`handle.send` 不得再发一组
  通用终态。continuation 的 `turn/start` 已被服务端接受、但 RPC 仍 pending 时若
  本地 Stop，墓碑会吞掉随后的 `interrupted`，必须补一条未认领 cancelled `done`，
  避免 Session 仍握着 `currentTurnAttemptToken`。RPC 已返回后由 provider
  `interrupted` 发唯一产品 Done，abort 不得再合成一条。
  续段必须继承铸造 claim 时的 origin 上下文：`turnPermissionPolicy`、
  capability selection 与 auto-review intent。不得把无人值守只读边界重置成普通
  Auto，也不得用固定 wait 提示覆盖原请求的能力选择或审查意图。
  Claude wake continuation 与 Codex yield continuation 先分账，不抽公共模块。
- **Provider 自己开的轮次要显式交给宿主。** 本代产品轮次已收口、没有预留中的 `Session.send`
  时出现的主代理新输出（Claude Code 后台任务完成后 CLI 自行注入 `<task-notification>` 开的
  新一轮）沿用上一代 generation、没有 `turnOrigin`，也不经过 `beforeProviderStart`。`Session`
  在该轮首个事件分发给监听者之前同步调用 `SessionTurnLifecycleObserver.onProviderInitiatedTurn`，
  每轮一次，终态后清除；子代理事件、后台事件、claim 挡住的续跑段不触发。同一产品轮次接受过
  插话时，收口后第一个无发送的轮次归插话（分不出插话是否已被原轮次吸收，宁可漏报）。桌面用它把这类轮次回传到 IM（`maker-ipc/channelTurnSignal.ts`）；
  回调必须同步决定，异步查询会从轮次中途开始观察；桌面侧与普通回传一样只在 IM 账号仍有效、渠道已连接时标记。
  该轮沿用的 generation 已记过上一轮的 `done`，唤醒轮自己的终止 error 不按「done 之后的迟到 error」过滤，
  照常按失败收口（唤醒输出之前到达的迟到 error 仍过滤）。回归见 `session.origin.test.ts`。

### Desktop Auto 审核的模型回退

2026-10-24 用户确认的分工：模型订阅自带自动审核时优先用它（Claude 订阅用 Claude 原生 Auto，
ChatGPT 订阅用 Codex Guardian），Cindy 审核只在原生不可用、故障或必须由 Cindy 判断时保底，
同一次调用不审两次；安全上接受适当放宽换取效率。

Auto 优先效率，定位是防止严重后果，不是第二次任务规划或逐步骤索要授权。
Cindy 审核向 Codex／Claude 原生审核看齐：先判动作本身的风险（low／medium／high／critical），
低、中风险直接放行（只受明确限制、访客身份与无关的不可信指令约束），低风险只回
`{"verdict":"allow"}` 以缩短耗时；只有高风险才看授权，未授权但与任务相关才 `ask`，
越界或有更安全做法则 `block`；critical 一律 `block`。没有任何用户原话也没有委派时只放行读取。
相关、有限、可恢复的操作以及同任务截图/文档交付、临时输出路径按完成任务所需步骤判断；
重点拦重大不可逆损失、凭据泄露、私密数据外发、大额资金、生产破坏与长期安全削弱。
明确禁止、撤权、访客身份、只读授权和委派范围仍严格生效。审阅器只看到用户原话，看不到
Agent 的计划与结果：报问题或要求改动即覆盖排查、修改、探针、构建、测试、版本／验证记录和清理
本任务创建之物等未被点名的步骤，「无法确认这一步在范围内」不构成 ask 或 block 的理由；审阅器
不判断代码或记录内容的真伪（2026-10-24 真实误判案例见 eval 脚本 `real-*`）。
模型给出的 `reason` 面向用户：用用户消息的语言写一两句白话、不出现字段名；`ask` 时 harness 用
`annotatePermissionRequestForAutoReview` 把它写进确认请求 `metadata.autoReviewReason`，桌面、手机、
IM 与官方 Hook 确认卡统一显示为「自动审批需要你决定：…」，故障降级仍只显示固定文案。共用规则在
`agents/shared/continuation-policy.ts`，真实模型配对比较入口为 `scripts/eval-auto-approval.mts`
的 `--baseline-bundle`（隔离打包的旧审核器）；只审核合成操作，不执行副作用。

原生审批已接管的本地工具调用不叠加 Cindy 模型复审，以 Handle 的实时
`getAutoReviewOwner()` 为准；Codex Guardian 故障切换后恢复 Cindy 负责。
路径解析暴露不同目标时，由 Cindy 审核 canonical 路径；只有 canonical 路径、
无法核对原始参数的 Host 回调不享受免复审。
Claude 订阅的本地会话即使挂了 Host MCP 也保持原生 Auto：原生会跳过 `canUseTool`，由
`nativeAutoPolicyHook`（PreToolUse，排在其他守卫之后）只把 Cindy 必须判断的调用交回
`canUseTool`——可信 MCP（由 Host 快捷放行、不调用模型，但插件委派任务仍先复核实时委派范围）、逐次确认的 MCP 与 IM 轮次（原生看不到发起者身份，
此时 `getAutoReviewOwner()` 返回 `cindy`）一律返回 `ask`，其余只由原生 classifier 判断。
远程 SSH 与设备托管会话无法在本机执行该 hook，挂 MCP 时仍回落 Cindy；额外目录授权仍回落 Cindy。
插件委派任务与 Codex 现状一致交给原生审核，不再额外套用 Cindy 的委派范围。
Codex 的 IM 轮次继续由 Cindy 审核（策略轮次需要 Host 观察每次执行）。
原生明确拒绝不触发第二次模型判断。独立 Host 操作继续使用自身审批入口。

Browser 的 `action=recipe` 调用复用现有逐次会话审批，不继承整个第一方 server 的静默放行；
Full Access、Auto、Ask 的含义保持不变。不以配方自报的 read/write 分类免审，用户覆盖层
也可能改变其实际动作。渐进参数（含 JSON 字符串）、直接工具调用及省略工具名共用
`maker-host/mcp-tool-approval-policy.ts`，发现和普通浏览器操作沿用原策略；
不新增配方确认 token 或独立授权状态。回归见 `mcpToolApprovalPolicy.test.ts`。

由 Cindy 负责的 Auto 审核先按固定顺序尝试 `cindy/auto-review`、内置 OpenAI 订阅的
`codex-auto-review`（Codex 原生审核模型，ChatGPT 账号可调用但不是可选目录模型，候选标
`catalogExempt`；原 `gpt-5.4-nano` 已不支持 ChatGPT 账号）、`gpt-6-luna`。只有这些候选全部不可用、请求失败或输出无效时，才使用
系统设置中用户明确自定义的辅助模型链，按已选顺序尝试最多 3 个模型；自动辅助链和
环境变量辅助链不参与。任一候选返回有效的 `allow`、`block` 或 `ask` 后立即结束，
不能为了争取放行而继续换模型。全部失败继续交回人工确认。

自定义兜底复用辅助模型的精确目录路由、停用状态和凭证处理，以无工具的 HTTP 文本请求
执行，不创建开发 Agent 或调用 CLI `oneShot`；Claude 订阅仍不可供 Cindy 直连借用。
宿主规则走供应商原生 system／instructions 字段，审核上下文仅放在证据段，并复用同一
严格判定解析器。设置说明须披露发往所选供应商的上下文范围：用户原话、引用内容、
委派任务、此前被阻止的操作、发起者身份与权限、待审操作参数、工作区及可写／参考
路径和操作系统；不能只列用户原话与操作参数，漏掉其余上下文。
384 token 的短输出预算复用辅助模型的「最少思考」策略；Messages／Chat 先试关闭思考，
Responses 没有关闭值，从模型目录声明的最低档开始（没有档位时用 `low`），不发送其
不支持的思考关闭值；被参数类错误拒绝时按目录档位逐级调整，详见
`apps/desktop/src/main/utility-model/utilityReasoningPlan.ts`。

审核开始时绑定账号、自定义链及所选供应商路由与停用状态快照，并复用现有供应商变更代次校验，
覆盖地址／鉴权配置、密钥修改和同 ID 删除重建。订阅请求同时绑定 OpenAI 原生授权凭证或
xAI 登录代次，派发前与响应完成后均复查，订阅退出或换号后不得采纳旧判定。
账号切换、配置变化、取消后不得继续派发旧请求或采纳迟到结果。
每个候选最多 12 秒（含凭证发现），内置阶段预算 40 秒，
自定义阶段另有最多 40 秒，共用取消信号。宿主守卫为 81 秒，必须小于 Core 的 delegate 硬上限。
恢复辅助模型默认设置会移除自定义兜底，不扩展自动链，也不改写已有配置。

### Auto 模式的同范围自动跟进

用户授权完成一项工作时，可以通过定时任务在原目标与操作范围内继续跟进；延后执行、
周期运行和向本人报告必要进展本身不构成新的授权请求。跟进必须保留用户限制、完成和
取消条件；不得借调度扩大目标、收件人或部署／合并等未授权操作。工具元数据发现属于
只读辅助步骤。流程细节继续由 Skill 决定，Core 不内置特定仓库的发布流程。

宿主审批从 owning session 已保存的用户原话恢复范围。直发与排队均通过 Session 的
`resolveAutoReviewUserIntent` 在 accepted 回调和视觉准备结束后、vendor dispatch 前读取，
覆盖上游旧快照；读取后仍检查本轮取消，保留后续叫停与限制。
自动执行消息使用受保护的 `autoReviewUserText.kind=scheduled-continuation` 标记，
不作为新授权，也不占用授权历史的行数预算；普通 `origin` 可被展示层修改，不能作为
信任依据。没有可信记录的旧消息仍会中断授权恢复，不按旧心跳 prompt 补造用户同意。
既有的清空、回退、附件歧义和完整消息预算继续生效。
用户原话按时间平铺为历史与唯一当前消息，不把历史包装成一律持续有效的限制。局部练习
的限制不延伸到新任务；同任务限制、撤权与明确长期限制仍须保留。预算不足时整体省略
旧历史并标记缺失，不能只留下旧授权、丢掉后续限制。宿主实际拒绝的动作可作为下一条
同一身份用户补充的指代线索；动作参数与助手解释都不是用户授权。相关行为回归见
`agents/shared/auto-review-decision.test.ts` 与 `scripts/eval-auto-approval.mts`。
IM 与官方 Hook 消息另带「用户本条明确指向的内容」：被回复／引用的那条消息与本条附件数。
它由宿主从渠道 adapter 实际交给模型的回复投影（`prepareAgentTurnText` 返回的 `replyContext`，
过滤后的占位也照用；模型没看到的回复审阅器也不看），或 Hook dispatcher 在展示截短前从原始 `source.threadContext`
取出的回复目标（优先按 `replyToMessageId`，排除当前请求）盖章，随 Main 的
`MAIN_OWNED_SEND_CONTEXT.autoReviewReferences` 进入 `appendAutoReviewUserIntent`，只挂在当前消息上
（下一条消息即丢弃），经 `projectAutoReviewUserReferences` 独立限长，不占用户原话预算；wire 同名字段一律不收。
审阅器把它放在 `<review_input>` 之后的独立 `<referenced_content>` 低信任块中，只用于判断指代与只读查询的
依据，不构成授权；没有引用时审阅 prompt 逐字不变。群背景消息不算用户指向的内容。审阅器暂不接收图片本体，
只写明张数。回归见 `auto-review-decision.test.ts`、`autoPermissionReviewer.test.ts` 与三个 harness 的 wiring 测试。
绑定原任务的心跳必须保留其权限与计划模式，包括冷启动恢复与撞忙排队；队列接受边界
复用既有权限与计划模式稳定快照核验；任一模式切换中或运行时与落盘值不一致时顺延，
不按旧模式派发。不得把原任务的 Auto／Ask
落盘改为完全访问。无法恢复权限时不能套用独立调度的完全访问默认值。

Cindy reviewer 与 Codex native reviewer 使用同一份范围语义，但接入不同。Codex 的主
Agent developer 指令不会进入原生审批摘要，因此通过线程级 `auto_review.policy` 内联
Markdown 接入；在创建或恢复线程时预装，不依赖初始权限模式，后续切到 Auto 即可使用。
不修改用户配置文件，不改 sandbox／审批者，不覆盖用户或项目自定义策略，
管理员策略仍由原生优先处理。当前覆盖已验证的 Codex 0.145.0、0.153.4、0.156.0 与 0.159.2（后三者默认租户策略一致），完整保留其默认租户
策略；未知版本保留原生策略，不能拿旧版本策略覆盖新默认。原生行为验证见
`agents/codex/native-auto-review-policy.native.test.ts`（`packages/maker-core/src/` 下），
需显式指定 `CINDY_CODEX_TEST_BINARY`；它使用假模型与假 MCP 验证配置传递和默认策略
完整性，不代表真实模型判定已通过。Cindy 审批模型案例见 `scripts/eval-auto-approval.mts`。

## 3. 守住四项核心数据指标

`maker-core` 的每一行改动都可能拖垮线上指标，而这类回退**不会被 typecheck／lint／单测
发现**，只能靠改动者在 review 前主动评估并实测。落在 prompt 组装、tool／MCP 暴露、
translator、event loop、model 映射、usage 计量这些路径上的改动，必须守住以下四项：

### 3.1 缓存率（Anthropic prompt cache）

命中依赖**请求前缀逐字节稳定**。system prompt 由多段按固定顺序拼接（SDK preset →
`MAKER_SYSTEM_PROMPT_APPEND` → makerMemoryRules → contactsRules（智能通讯录两态段，
与同一次 build 的 MCP 注册同点求值、单次 build 内恒定；remote 会话缺省）→ host `runtimeConfig.systemPrompt` →
per-workdir MEMORY.md index 快照 → per-call userPrompt，见 `claude-code/index.ts`）。禁止：

- 往稳定前缀里塞每轮都变的内容（时间戳、随机文案、易变计数器）；随机／易变内容只能
  进 per-call userPrompt 段。
- 调整各段拼接顺序。
- 在会话中途增删或重排 tool 定义、MCP server 注册。
- 破坏 MEMORY.md「会话启动时快照、rewind 不刷新」的语义。

### 3.2 性能／返回速度

event loop（`AsyncQueue`）与 translator 是**每事件／每 token 都过一遍的热路径**。禁止在
热路径塞同步阻塞调用（同步 IO、大对象深拷贝、灾难性正则回溯、每事件大量临时对象），
禁止在 `handle.send` 路径加额外网络往返或串行 await；保持“先入队、消费端 async 流式吐”
的非阻塞模型。耗时操作走缓存 + 超时 + fallback，不让单次慢操作卡住整个 turn。

### 3.3 返回内容准确性

- translator 必须把 vendor SDK 事件**无丢失、无错序**地映射进已有 `AgentEvent` union，
  不吞掉、不错误合并、不错配 `text`／`thinking`／`tool_use`／`tool_result` 等事件。
- model 路由只走显式版本号，**禁止 `'opus'`／`'sonnet'` 一类裸别名**——二进制升级后
  别名指针会漂到下一代模型，让用户选的版本与实际命中的不一致。
- 任何改变送进模型的 prompt 内容、tool 可用性或权限分支的改动都可能让模型行为漂移，
  必须是有意为之并在 PR 中说清原因。

### 3.4 review 前硬性要求

改动落在上述任一路径时，PR／自测说明必须显式写明：(a) 可能影响哪几个指标；(b) 用什么
方法实测（缓存率改动前后对比、热路径耗时、典型 turn 事件流抽查等，缓存率可用
`usage-tracker.ts` 的 per-turn／session 命中率或 `/context` 对比）；(c) 实测结论。
不许用“看着没问题／应该不影响”代替实测。

## 4. system prompt 改动门禁

**任何人都不得擅自修改 Cindy 的 system prompt；需要改动必须先与仓库维护者讨论
确认后才能动手。** 未经确认的 system prompt 改动一律不许提 PR 或直推。

- **范围**：随每个 Agent 会话下发给模型、决定其全局行为的那部分文本，包括
  `MAKER_SYSTEM_PROMPT_APPEND`、`makerMemoryRules`、host 注入的 `runtimeConfig.systemPrompt`
  等参与拼接 Claude／Codex system 段的各段（见 `claude-code/index.ts` 及 Codex 对应实现），
  以及任何固化在代码／模板／常量里、会进入模型 system 段的提示词内容。
- **原因**：system prompt 是产品行为与质量的“宪法层”，一处改动无差别影响所有用户的所有
  会话，既可能整体拉偏模型行为（LLM 侧改动不可复现、静态检查发现不了），也会破坏
  prompt cache 的前缀稳定性拖垮缓存率（见上节 3.1）。
- **怎么做**：(a) 收到“改 system prompt／调整 Agent 人设／加一条全局指令／删改某段
  system 文本”的诉求时先停下，不要直接动代码；(b) 把“改哪段、改成什么、为什么、预期
  影响（行为 + 缓存率）”整理清楚，主动找 owner 讨论并取得明确确认；(c) 确认通过后再
  实现，并在 PR 说明里写明“system prompt 改动已确认”，附上按上节 3 的实测评估。

## Review 清单

1. Agent 逻辑是否留在了 maker-core，而不是散进 Main／Renderer 重造 Agent Loop？
2. 本可由代码保证的确定性逻辑，是否被错误地甩给了 prompt？
3. 改动是否落在 prompt 组装／tool·MCP 暴露／translator／event loop／model 映射／usage
   计量路径上？落在就必须按第 3 节评估 + 实测四项指标，PR 说明不得留空。
4. 前缀稳定性是否被破坏（易变内容进前缀、拼接顺序变化、会话中途增删 tool／MCP）？
5. translator 是否可能丢事件、错序或错配事件类型？model 路由是否残留裸别名？
6. 是否触及 system prompt？触及就必须先取得 owner 确认，PR 说明写明已确认。

命中 system prompt 未确认、或核心指标路径改动缺实测的 PR 必须阻断。验证命令按
[`desktop-development.md`](desktop-development.md) 选择；指标类回退无法靠静态检查发现，
必须以运行时实测数据为准。
