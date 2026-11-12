# Orca 系统兜底回报合批（auto-bridge batch）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

既有队列 / 消息 `origin.kind='orca'` 增量追加可选 `autoBridge?: true` 与 `autoBridgeBatchCount?: number`，
正文仍用 `{orcaSource:'worker',content}` 信封，批次头为 `[Auto-bridged batch: N worker reports]`。
只有任务所属 Desktop 的系统兜底入口盖章；`INPUT_ENQUEUE` / `INPUT_STEER` 的 wire 自报同名字段一律剥掉。
合批只发生在 Lead 输入协调器 drain 前的连续同配置队首，不新增 channel、allowlist、relay 帧或能力位；官方与自建中转
沿用通用 invoke / push 转发，无需同步修改中转内核。旧控制端忽略新增字段，仍能看到完整批次正文；新控制端连接旧宿主时
没有批次字段，按单条 Worker 回报显示。无数据库 migration；旧快照缺字段按单条处理，恢复后的连续批次可再次扁平合批。

- 模型侧正文保留批次头与每段 `[From Orca Worker <role> (worker_id: …)]` 路由标识；可见 / 持久化正文剥掉批次头与
  `worker_id`，保留 role 行、状态与完整报告，数量由标题表达。
- 批次 origin 保留首条 `senderSessionId` 供团队延续授权（`readOrcaTeam`），`senderLabel` 置空、`displayText` 为可见正文；
  访客投影走同一脱敏入口，不泄漏 `worker_id` 与首个 Worker 归属。
- 上限均衡档：单批 ≤8 条、含批次头 / 分隔符的最终正文 ≤32000 字符；队首必发不截断，余量下一轮；条数按真实报告数累计，
  retry / 快照恢复不绕过。

回归见 Desktop `orcaInterAgentDispatcher.test.ts`、`orcaAutoBridgeBatch.contract.test.ts`、`messageAutomationOrigin.test.ts`、
`pendingQueueRowPresentation.test.ts`、`messageLinkActions.test.tsx` 与 Mobile `orcaCollab.test.ts`、`pendingSendItems.test.ts`。