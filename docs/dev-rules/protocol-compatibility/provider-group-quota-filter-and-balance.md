# 供应商组：订阅配额筛选与用量均衡（2026-10-12，OpenAI 于 2026-10-20 接入）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

2026-10-21：同账号 `pick` 的 `{ kind: 'unavailable' }` 回包可选增加
`usageLimit: { resetAtMs: number | null }`，仅表示已验证的订阅额度耗尽；时刻为可分配成员中
最早的已知恢复时间（unix ms）。不发送账号信息、用量快照或成员名单。控制端保留已知／未知
重置语义，以 `REMOTE_AGENT_GROUP_USAGE_LIMIT` 错误接入现有输入投影与限额等待；
手机和桌面沿用 `usageLimitWait` 显示时间、取消等待。新组配旧控制端忽略可选字段，
新控制端配旧组保留原通用错误，不猜测限额或自动等待；旧查看端仍可显示通用错误和既有等待。
完整体验需要组所在电脑与任务所在电脑更新，查看端更新后有对应本地化文案。
不新增 channel、持久状态、权限或服务端改动。

产品规则见 [`provider-groups.md`](../../product-rules/provider-groups.md) §5。选电脑仍由组所在电脑完成：先排除额度耗尽的成员，
再按所选策略分配；Claude Code 与 OpenAI 订阅均可参与配额排序，旧策略 `usage` 沿用 `least`。

- **可选策略枚举扩展**：本地组配置与同账号组摘要的 `strategy` 增加 `usage`，原默认 `least` 不变。
  旧版桌面读取未知策略时归一化为 `least`，旧版手机不依赖这个字段；远程 `pick` 仍由组所在电脑执行，因此
  旧控制端连接新组所在电脑也能使用新策略。组所在电脑降级后按 `least` 分配，旧版再次保存组设置会写回 `least`。
  2026-10-15 起配额排序对所有策略生效（2026-10-21 起按「剩下的额度 ÷ 剩下的时间」，最急的先用），设置界面不再提供
  `usage`；枚举值与归一化保持不变，已存的 `usage` 照常读写，挑法与 `least` 相同。这只改组所在电脑本机的选择，
  沿用已有的用量快照字段，不新增字段、不改通道。
- **复用已有同账号通道**：向成员电脑调用 `maker:usage:claude-subscription`，参数 `[member.providerId]`；本机走同一
  订阅 reader。只信与请求一致的 `providerId` 回显；旧端未回显时仅允许默认 `anthropic`，具名账号按未知用量处理，
  避免旧端忽略参数后拿默认账号的额度代替。通道不可用、失败、超时或快照过期时按未知处理，分配照常进行。
  OpenAI 并行复用 `maker:usage:account` 的 `['codex', member.providerId]` 和 `maker:usage:codex-rate-limits`
  的 `[member.providerId]`；两个回包分别校验 `providerId`，无回显的旧端仅允许默认 `openai`。原生限额 RPC 的
  窗口按本次读取时刻记录新鲜度，账号用量回包保留各模型桶与 web 槽自己的时间戳；单路失败仍使用另一路的可信数据。
  不调用兑换重置卡接口，不把重置卡、账号标识或凭证放进内部目录的配额快照。本机和远端读取合并在途，短缓存 15 秒。
- **可选框架信息**：同账号 `view` 请求增加可选 `agentKind: 'codex' | 'pi' | 'claude-code'`，供 OpenAI 发送前检查
  选择原生模型桶或 web 槽；缺省仍按原生模型桶处理，旧组所在电脑忽略该字段。原有仅带模型的查询和回包形状不变。
- **隐私与状态**：完整额度快照只留在组所在电脑的内部目录中，不进供应商目录，不传给受邀者；分享来的成员不调用此通道。
  同账号不带 `model` 的 `view` 用已有 `cooling` / `coolingUntil` 表达总窗口耗尽，带 `model` 的发送前查询只在回显模型一致时
  临时表达该模型的额度状态，不能改变其他模型的可用性。账号切换时丢弃旧读取，不扩大 allowlist 或凭证访问。
- **成员状态可选 `quota`（2026-10-21 用户确认）**：`ProviderGroupView.members[]` 增加可选
  `quota: { usedPercent, resetAtMs: number | null, windowMs }`，只是选电脑排序用的那一个窗口（provider-groups.md §5），
  同账号电脑据此提议任务进行中换号（§6.2）；2026-10-22 起界面不再画进度条（§10），字段保留。不带 5 小时窗口、模型桶名、
  账号标识或重置卡。组所在电脑本机界面与同账号 `view` 回包都带；读不到配额的成员
  省略。`parseProviderGroupRemoteView` 只收有限数值（百分比收敛到 0–100，窗口 0–31 天，重置时刻为正数或 `null`），
  分享来的成员一律丢弃；受邀者的匿名状态是白名单投影，不带此字段。旧组所在电脑不回此字段，查看端按读不到配额处理、
  不提议换到这台；旧查看端忽略它。不新增 channel、请求参数或持久数据。
- 不新增 channel，不改 relay、服务器、数据库或持久冷却格式。实现：`provider-group/usage.ts`、`directory.ts`、`runtime.ts`、
  `router.ts`、`remoteClient.ts`、`remoteHandler.ts`、`service.ts`；额度判定与自动继续复用 `shared/accountUsageLimit.ts`。回归见
  `provider-group/__tests__/usage.test.ts`、`router.usage.test.ts`、`runtime.test.ts` 与 `scheduler.test.ts`。
- **成员状态可选 `fiveHourTight: true`（2026-10-21）**：只在带 `quota` 时出现，表示这台的 5 小时配额已用 85% 以上、离重置还有
  1 小时以上（provider-groups.md §5 第 0 条）。同账号电脑据此不把它当作任务进行中换号的目标。旧组所在电脑不回，查看端按不紧张处理
  （最坏是提议后组所在电脑按自己的排序选不中它，照常留在原处）；旧查看端忽略。`parseProviderGroupRemoteView` 只认 `true`。
- **成员状态可选 `usageLimit: { resetAtMs: number | null }`（2026-10-22）**：仅当可信快照确认该成员配额耗尽且状态为 `cooling` 时携带，
  供本机管理与同账号远程列表显示「配额已用完」、配额重置倒计时及警示圆点。时刻来自配额窗口，与可能更晚结束的其他冷却分开；未知为 `null`。
  `parseProviderGroupRemoteView` 只接收冷却中的非分享成员，时刻须为正安全整数或 `null`；不从普通冷却推断配额原因。
  旧组所在电脑不带该字段，查看端保留「冷却中」；旧查看端忽略该字段。受邀者匿名状态白名单不带此信息，分享来的成员不读取配额。
  不新增通道、请求参数、权限、持久状态或服务端变更，不改变分配与恢复策略。
