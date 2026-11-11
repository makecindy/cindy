# Cindy AI 企业周期配额

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

云端组织账号优先通过 Model Access `GET /api/model-access/quota` 查询本人周期配额，
不再假定推理入口暴露 LiteLLM 管理 API。返回 spend/maxBudget/budgetResetAt/currency；
沿用现有 account-usage IPC 和账号作用域缓存，所以设置卡片与任务用量提示使用相同来源。
服务端尚未提供接口（404），或明确返回 501/MODEL_ACCESS_QUOTA_NOT_SUPPORTED（Nova），
才使用原有网关查询。鉴权失败、上游故障或响应无效均显示不可用，不回退或借用其他身份数据。
`dailyLimitEnabled` 只有严格等于 `true` 才表示企业开启日额度；`false`、`null`、缺失或
非法值均视为未开启。企业快照明确带出布尔值，未开启时 `todaySpend` 按 `null` 处理，
隐藏日额度、软限额口径和今日明细不可用警告，月额度不受影响。旧服务端缺少开关字段时
也按未开启处理。开启时，`todaySpend` 为有限且 ≥ 0 的数字表示 UTC 当天消费；缺失、
`null` 或非法值按 `null` 处理，只显示今日明细不可用提示，不影响其余额度字段。
快照新增可选 `dailyLimitEnabled?: boolean`，沿既有 IPC 和 device-link 原样传递；非企业
旧网关路径不设置此字段，保留原有日额度及不可用提示行为。旧控制端忽略新增字段，
需更新控制端才能隐藏未开启时的警告。未设周期上限时不伪造有限配额的原有行为保持不变。
本地手填网关和个人计费路径保持原协议。无新环境变量或数据库变更。

管理员取消周期上限后，主进程明确清空当前 owner 的配额缓存，并通过现有
`usage:claude-account-changed` 广播 null；renderer 同步清除当前 owner 的快照与热缓存。
已有未知载荷消费者会忽略 null，其余有限配额快照字段不变；网络失败仍保留既有缓存策略。

配额读取 IPC 返回 null 仅表示当前无可用快照，不清除 renderer 已缓存的同账号额度；只有权威 clear 读取结果或显式 clear push 才清除缓存。

`maker:usage:account('claude-code', 'cindy-quota-state-v1')` 为可选读取能力：有限额度保持原快照，权威不限额返回 `{ quotaState: 'unlimited' }`，暂无当前账号快照返回 null。无该能力参数的旧消费者仍只收到快照/null；旧主机忽略该参数，新消费者对其 null 保留旧缓存。本地重新挂载和远程读取均查询该状态，避免错过 clear 推送；仅权威 clear 可淘汰同账号缓存。

企业凭据迁移：`/quota` 查询不依赖本地推理凭据；仅在当前进程、当前账号已成功同步服务端凭据，且实际 endpoint 与本次同步一致时，允许 404/明确 501 后的旧直连回退。持久化凭据不能作为本轮同步成功的证明。网关 endpoint 或身份代次变化时，失效当前账号额度并丢弃旧代次在途结果；失效结果通过既有 null push 通知，可选状态读取返回 `{ quotaState: 'invalidated' }`，与 unavailable null 区分。新本地/远程消费者将 invalidated 和 unlimited 都作为权威清缓存；未携带能力参数的旧消费者保持 snapshot/null 返回。此处不变更凭据存储、推理回退或额度计算口径。

额度身份隔离使用主进程 `ownerGeneration` 与 `dataOwnerId`，覆盖同 membership 跨认证 realm 切换及同账号修复；凭据状态与额度快照使用同一身份键。
远程 transport-timeout 出站退避重连成功、或普通同账号 peer 入站 link-accept 成功后，Main 通过本地 `device-link:peer-link-reopened` 推送 `{ deviceId }`，preload 暴露可选 `onPeerLinkReopened`，仅目标设备触发排队补读。被取消的重连代次不发通知。该事件不进入 relay wire、不增加远端 IPC allowlist，也不改变 Mobile/旧消费者的请求协议。
