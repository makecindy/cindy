# 供应商分享：按需查看匿名组状态(2026-10-12)

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

产品规则见 [`provider-groups.md`](../../product-rules/provider-groups.md) §8、§9.7、§10。

- 受邀者读现有 `maker:provider:list` 时可在 `args[0]` 加 `includeSharedGroupStatus: true`。只在分享详情使用；
  普通目录读取不探测组员，避免组之间相互读取目录时递归。供应商始终取实际分享授权，不信任请求中指定的供应商。
- 新分享者在这一条供应商上附加可选 `groupStatus`：长度与 `groupSize` 一致的状态数组，只允许
  `available / busy / cooling / offline / paused / unavailable / needs-update / unknown`。序号由界面按数组位置生成，
  不传组员名称、标识、来源、任务数或用量；不扩展 `provider-group:remote` 的受邀者权限。
- 由实际受邀者分配器读取组状态并按同一能力条件检查能否接分享任务，状态与能力读取各有 3 秒等待上限；
  超时／失败为未知，不改变分配与冷却。读取期间组设置或账号变化丢弃快照，分享撤销后不返回在途结果。
  `scrubSharedProvider` 在各跳按白名单重建数组；不合法的单项替换为 `unknown`，长度不符则不带字段。
- 匿名能力探测按当前账号运行期共用最多 4 个物理在途槽，同电脑跨刷新复用查询；等待超时不释放仍在途的槽，
  未发出的排队查询 3 秒后取消。已结算的能力结果短存 15 秒，迟到结果可供下一次详情读取使用；不缓存组状态，
  不跨账号复用或继续发出旧账号的排队查询，不改变底层 device-link 超时、重连或 wire 格式。
- 兼容：旧分享者忽略查询选项，新受邀者显示未提供状态；旧受邀者不发选项、行为不变。手机沿用目录清洗但
  本期不增加状态入口。无组的供应商不带状态，不改服务器、relay、数据库或既有 channel 白名单。
- 实现：`provider-group/sharedStatus.ts`、`guestRelay.ts`、`device-link/dispatch.ts`、
  `packages/device-link/src/providerShareCatalog.ts`；回归：`sharedStatus.test.ts`、`providerShareDispatch.test.ts`、
  `providerShare.test.ts`、`SharedProviderGroupStatus.test.tsx`。
