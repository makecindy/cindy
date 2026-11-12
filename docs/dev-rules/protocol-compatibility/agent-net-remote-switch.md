# 远程切换其他电脑的连接方式（2026-11-12）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。
> 产品规则见 [agent-net.md「远程切换其他电脑的连接方式」](../../product-rules/agent-net.md)。

新增 invoke `device-link:agent-net-switch:v1`（`packages/device-link/src/agentNetSwitch.ts`），进远程调用白名单，
被控端 dispatch 拦截执行，只给同账号电脑：共享任务访客与供应商分享受邀者返回 `CHANNEL_NOT_ALLOWED`。
准入沿用远程控制的三道门（同账号、被控端打开「允许同账号设备控制本机」、发起端未被撤销）。

- **请求**：`{ action: 'status' }`（只读）、`{ action: 'set', enabled, switchId }`、`{ action: 'confirm', switchId }`。
  `switchId` 由发起端生成（8–64 位字母数字、`_`、`-`）。
- **status**：`{ version, enabled, onlyEncrypted, blocked, pending, encrypted? }`。`encrypted` 表示与请求电脑的实际链路，
  旧端可省略，不能从 `enabled` 推断。`blocked` 为 `NOT_SIGNED_IN` / `SECURE_STORAGE_UNAVAILABLE` /
  `RELAY_IDENTITY_MISSING` / `null`，只说明现在能不能打开；关闭总是可以。当前中转缺少 Agent-Net 身份时明确拒绝，
  本机中转的主人可沿原启用路径自动补身份。
- **set**：先回答 `{ version, switchId, enabled, confirmWithinMs }`，再在 400ms 后走与本机开关相同的保存与重连路径。
  打开时 `confirmWithinMs` 为 60 秒：被控端在此期限内没有收到同一发起端经 Agent-Net（端到端加密链路）发来的
  `confirm`，就自己退回原值。关闭与「本来就是这个状态」返回 `null`，不需要确认。另一个打开还在等确认时，
  再请求打开回 `[AGENT_NET_SWITCH_BUSY]`；请求关闭则同时取消那次打开。
- **confirm**：只认待确认的那一次（同 `switchId`、同发起端），且被控端此刻到发起端的连接必须是 Agent-Net；
  否则分别回 `[AGENT_NET_SWITCH_STALE]` / `[AGENT_NET_SWITCH_NOT_ON_AGENT_NET]`。发起端主动发确认（不等连接自己回来：
  它没在控制那台电脑时连接不会自己重建，确认请求本身会建起后台连接），期限内每秒最多一次；关闭后同样每秒最多问一次
  status，最长 30 秒。这些请求只在一次切换期间发生、点对点经中转转发，不经服务端业务接口。
  关闭只有读到开关已关闭才算完成，超时为失败；本来已开启的目标也必须核实 `encrypted: true` 才算切到 Agent-Net。
  确认回包丢失导致重试返回 `STALE` 时补读一次实际链路；期限结束后同样补读一次，只在读到原状态时报告已退回，
  无法核实则报告切换未完成。两条补读不增加持续轮询。
- **不远程改**「仅使用 Agent-Net」。
- **持久化**：被控端把待确认记录与「由谁打开」写进 `device-link-settings.json` 的 `agentNetPendingSwitch` /
  `agentNetChangedBy`（只在发生过时出现，旧文件形状不变）。启动时记录它的进程已不在就直接退回；
  恢复原开关完成后才清除待确认记录，中途退出仍可继续恢复。本机的人改开关会清掉两条记录，并使打开、关闭两个方向
  尚未执行的远程操作失效；远程写操作和本机清理在同一队列串行执行。
- **错误码**：都在 `IPC_ERROR` 的 message 里以 `[AGENT_NET_SWITCH_*]` 携带；`agentNetSwitchErrorCode()` 解析。

**旧端与混用**：旧被控端没有这个通道，返回 `CHANNEL_NOT_ALLOWED`，发起端显示「需要更新 Cindy」，不靠版本号判断。
旧发起端看不到入口，行为不变。手机不接受远程控制，不出现切换按钮；手机作为发起端暂未接入。

**中转（含自建）**：没有新帧、能力位或 relay 行为，官方与自建中转都按普通 invoke 转发，`packages/device-link-relay`
无需修改。验证：`pnpm --filter @cindy/device-link-relay run interop`（真实自建中转的加入、签名通信、白名单内 invoke
与重连）2026-11-12 通过；被控端的确认与退回规则由 `apps/desktop/src/main/device-link/__tests__/agentNetRemoteSwitch.test.ts` 覆盖。
