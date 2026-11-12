# 远程切换其他电脑的连接方式（2026-11-12）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。
> 产品规则见 [agent-net.md「远程切换其他电脑的连接方式」](../../product-rules/agent-net.md)。

新增 invoke `device-link:agent-net-switch:v1`（`packages/device-link/src/agentNetSwitch.ts`），进远程调用白名单，
被控端 dispatch 拦截执行，只给同账号电脑：共享任务访客与供应商分享受邀者返回 `CHANNEL_NOT_ALLOWED`。
准入沿用远程控制的三道门（同账号、被控端打开「允许同账号设备控制本机」、发起端未被撤销）。

- **请求**：`{ action: 'status' }`（只读）、`{ action: 'set', enabled, switchId }`、`{ action: 'confirm', switchId }`。
  `switchId` 由发起端生成（8–64 位字母数字、`_`、`-`）。
- **status**：`{ version, enabled, onlyEncrypted, blocked, pending, encrypted?, disableBlocked? }`。`encrypted` 表示与请求电脑的实际链路，
  旧端可省略，不能从 `enabled` 推断。`blocked` 为 `NOT_SIGNED_IN` / `SECURE_STORAGE_UNAVAILABLE` /
  `RELAY_IDENTITY_MISSING` / `null`，只说明现在能不能打开。`onlyEncrypted: true` 则禁止远程关闭，须先在目标电脑解除。
  当前中转缺少 Agent-Net 身份时明确拒绝，
  本机中转的主人可沿原启用路径自动补身份。
  可选 `disableBlocked` 为 `ENCRYPTION_REQUIRED` / `V2_ONLY_RELAY` / `null`，后者反映没有 V1 凭证、只走 V2 的实际网络限制；
  它不受 Beta 开关影响，不能用 `enabled: false` 代表已切回 Device Link。旧状态缺此字段仍按原字段处理。
- **set**：先回答 `{ version, switchId, enabled, confirmWithinMs }`，再在 400ms 后走与本机开关相同的保存与重连路径。
  打开时 `confirmWithinMs` 返回实际剩余期限（含先回答后执行的 400ms，首次与重发回答一致）：启用后的 60 秒内没有收到同一发起端经 Agent-Net（端到端加密链路）发来的
  `confirm`，就自己退回原值。关闭与「本来就是这个状态」返回 `null`，不需要确认。另一个打开还在等确认时，
  再请求打开回 `[AGENT_NET_SWITCH_BUSY]`；请求关闭则同时取消那次打开。
- **confirm**：只认待确认的那一次（同 `switchId`、同发起端），且被控端此刻到发起端的连接必须是 Agent-Net；
  否则分别回 `[AGENT_NET_SWITCH_STALE]` / `[AGENT_NET_SWITCH_NOT_ON_AGENT_NET]`。发起端主动发确认（不等连接自己回来：
  它没在控制那台电脑时连接不会自己重建，确认请求本身会建起后台连接），期限内每秒最多一次；关闭后同样每秒最多问一次
  status，最长 30 秒。这些请求只在一次切换期间发生、点对点经中转转发，不经服务端业务接口。
  关闭只有读到开关已关闭、`encrypted: false` 且没有 pending 才算完成，超时为失败；本来已开启的目标也必须核实
  `encrypted: true` 才算切到 Agent-Net。旧端没提供实际链路时无法核实，不推断成功。
  确认回包丢失导致重试返回 `STALE` 时补读一次实际链路；期限结束后同样补读一次，只在读到原状态时报告已退回，
  无法核实则报告切换未完成。两条补读不增加持续轮询。
- **不远程改**「仅使用 Agent-Net」。目标开启该限制时，`set(enabled: false)` 在改动任何待确认记录、归因或计时器前
  返回 `[AGENT_NET_SWITCH_ENCRYPTION_REQUIRED]`；真正执行延迟关闭前再读一次，目标刚改为仅加密时也不降级。
  发起端单台显示原因，批量在两个方向都先探测并排除受限目标；探测后状态变化仍由目标强制拦截。
  本机修改该选择会取消未执行的远程切换（与本机修改总开关同样以人为准）。新错误码是追加项，旧发起端按失败处理，
  不改帧格式与版本；旧目标的 `onlyEncrypted` 字段继续照常解析。
- **发起端限制**：本机命令转发前也检查自身能否回到 Device Link；不能时不发送 `set(false)`，回
  `[AGENT_NET_SWITCH_CONTROLLER_ENCRYPTION_REQUIRED]` 或 `[AGENT_NET_SWITCH_V2_ONLY_RELAY]`。本机 IPC 的成功探测回复追加
  可选 `controllerBlock`（同 `disableBlocked` 枚举）给界面解释；该字段不发往目标。目标也拒绝 V2-only 网络的远程关闭。
- **持久化**：被控端把待确认记录与「由谁打开」写进 `device-link-settings.json` 的 `agentNetPendingSwitch` /
  `agentNetChangedBy`（只在发生过时出现，旧文件形状不变）。启动时记录它的进程已不在就直接退回；
  恢复原开关完成后才清除待确认记录，中途退出仍可继续恢复。本机的人改开关会清掉两条记录，并使打开、关闭两个方向
  尚未执行的远程操作失效；远程写操作和本机清理在同一队列串行执行。
  待确认的打开被远程关闭取消时，记录先加可选 `restoring: true`，拒绝旧打开的迟到确认，并保留到实际关闭成功；
  关闭失败仍按原期限恢复。尚未执行的旧回调由进程内代次取消，不靠提前删除恢复记录。旧记录缺少此字段时仍按等待确认处理。
  自动恢复开始也先持久化 `restoring`，不再接受迟到确认。暂时的应用或存储错误会按 1s / 3s / 10s 额外重试，
  成功即停；仍失败则保留记录，不持续轮询，重启或显式关闭可再次恢复。本机操作仍取消重试，替换的记录不被旧恢复清掉。
  确认也检查实际截止时刻；确认记录写入成功后才取消恢复计时，临时存储失败不能取消兜底。
  取消打开的远程关闭先保留/重挂原期限，避免归因落盘失败导致关闭回调尚未建立就失去恢复。
  本机修改与取消在同一队列：先清归因使其它实例尚未执行的回调失效，再保存本机选择并重连；成功后才清 pending 和计时。
  本机保存/重连失败会保留并重挂恢复，取消清理失败也向调用方传播，不能提前宣告接管成功。
  若本机请求已经中止正在执行的恢复重试，但取消也失败，则为仍在的记录重挂期限，不能让两条错误路径合起来撤掉兜底。
  开关和恢复记录按电脑保存；请求、本机取消与延迟执行捕获发起时的账号代次，队列或落盘期间换账号后拒绝继续，
  不借用新账号启用或重连。自动退回仍是这台电脑的恢复责任，不把设备偏好改成账号私有数据。
  设置写入复用锁内 updater，在实际拿到写锁后核验捕获的代次，等待队列/锁时失效的请求不会先删除 pending 再报错。
  自动恢复每次写入捕获当时的代次，失败可继续有界重试；不将设备恢复永久绑定到原账号。
  初次 pending 已有效提交后先挂恢复期限，再核验后续处理的代次，避免提交成功后报错留下无计时记录。
  共用同一 profile 的另一实例本机操作也会清掉共享归因；延迟回调在执行前核对归因的来源、时刻和方向仍匹配，
  已被本机清除或替换的远程操作不再执行（包括没有 pending 的普通关闭）。
- **错误码**：都在 `IPC_ERROR` 的 message 里以 `[AGENT_NET_SWITCH_*]` 携带；`agentNetSwitchErrorCode()` 解析。

**旧端与混用**：旧被控端没有这个通道，返回 `CHANNEL_NOT_ALLOWED`，发起端显示「需要更新 Cindy」，不靠版本号判断。
旧发起端看不到入口，行为不变。手机不接受远程控制，不出现切换按钮；手机作为发起端暂未接入。

**中转（含自建）**：没有新帧、能力位或 relay 行为，官方与自建中转都按普通 invoke 转发，`packages/device-link-relay`
无需修改。验证：`pnpm --filter @cindy/device-link-relay run interop`（真实自建中转的加入、签名通信、白名单内 invoke
与重连）2026-11-12 通过；被控端的确认与退回规则由 `apps/desktop/src/main/device-link/__tests__/agentNetRemoteSwitch.test.ts` 覆盖。
