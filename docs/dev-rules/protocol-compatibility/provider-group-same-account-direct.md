# 供应商组：同账号直连(P2a)

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

中继断线连续性：Desktop 只对已经认证、可靠握手完成且健康的同账号直连数据通道启用
最长 30 分钟的信令失联保留，组内请求、结果与订阅推送继续使用原可靠 stream / seq。
不新增 wire 字段、能力位、离线握手或服务端授权；逐请求权限与显式断开、撤权、停止和
到期清理不变。重复离线通知或流量不续期；两端都需更新，旧端与 Mobile 仍可能关闭通道。
供应商分享既有短期许可不因此延长。本机 relay 恢复后若直连随后故障，可使用已恢复的 relay；
对端仍明确离线时不能误判其可达。故障半径和验证入口见
[`remote-and-mobile-adaptation.md`](../remote-and-mobile-adaptation.md)「直连优先、中继兜底」。

跨区组员恢复（2026-10-26）：控制端 Main 仅在同账号 `provider-group:remote` 的有效 `view` / `pick`
回包或 `manage-group` 组视图引用分享时，恢复本机缺失的区域标记并通过既有 `/provider-shares/x/session` 核验成员关系。
不新增 wire 字段、channel 或权限，兼容旧组所在电脑；手机仍由任务所在电脑执行。旧控制端保留原行为。
本机已加载的分享直接使用；尚在恢复或请求失败时不按已移除处理。Renderer 收藏和任意分享 ID 不能触发
跨区激活。凭证只留内存、区域标记格式不变，降级后已恢复的分享沿原连接路径继续使用。
回归：`device-link/__tests__/providerShareCrossRegion.test.ts`、`provider-group/__tests__/ipc.test.ts`。

产品规则见 [`provider-groups.md`](../../product-rules/provider-groups.md) §4、§5、§6.1、§10。组所在电脑 O 把某个供应商建成组后，
同账号另一台电脑 C 上选了 O 的这个供应商的新任务：C 问 O 该用哪台，再自己直接连到选中的组内电脑运行。

- **新 invoke channel `provider-group:remote`**(`packages/device-link/src/providerGroup.ts`，进同账号 allowlist)，被控端
  `dispatch.ts` 拦截执行，不落 ipcMain handler；供应商分享受邀者(不在 `PROVIDER_SHARE_CHANNELS`)与共享任务访客一律
  `CHANNEL_NOT_ALLOWED`。请求 `{ action, ... }`，结构与校验在 `apps/desktop/src/shared/providerGroup.ts`(两端同一份)：
  - `pick { sessionId, providerId, agentKind, model, exclude[] }` → `{ kind: 'member', member: { key, kind, agentDeviceId, providerId }, label }`
    / `{ kind: 'unavailable' }` / `{ kind: 'none' }`(没有组或供应商没开放远程调用)。组员坐标是 O 视角(`local` = O 自己)，C 换算成
    本机位置；选中即给那台记 30s 临时占用；
  - `cool { providerId, memberKey, cause: 'usage-limit' | 'auth' | 'overload', resetAt? }` → O 短暂冷却那台，未带模型的旧报告最多信 2 分钟；
    连不上不报，只由 C 自己避开(组内状态以 O 为准，C 那边的问题不记进组里，2026-10-11)。`exclude` 非空(C 这一轮试过
    不行再来问)时 O 不用短时缓存、现读组内电脑的最新状态再选，请求格式不变；
  - `cool-model { providerId, memberKey, cause: 'usage-limit', model, resetAt? }`（2026-10-17）→ O 只冷却对应模型，
    `resetAt` 最多信 8 天，无时刻则 30 分钟；Claude 家族别名共用一个范围。新 C 连接旧 O 收到
    `unknown provider group action` 时，只回退一次 `cool`，重置时刻压到未来最多 2 分钟；其他失败不回退。
    旧 C 连接新 O 的无模型报告只保留短冷却。完整模型隔离需 C/O 更新；手机仍由被控电脑执行，无新 channel 或服务端改动。
    本地 `provider-group-cooling.json` 的成员值从旧数字扩为范围到时刻的对象（空键是全账号）；新版加载旧数字最多保留
    2 分钟，降级旧版忽略对象并依据配额/实际报错重新判断，不影响任务与组配置。回归见 `router.state.test.ts`、
    `coolingStore.test.ts`、`remoteHandler.test.ts` 与 `remote-agent/__tests__/groupRelay.test.ts`。
  - `leases { seq, entries: [{ sessionId, providerId, memberKey }] }` → 整体替换 C 正在运行的经组任务，`seq` 只增(C 按时间生成，
    重启后仍增大)，乱序旧包丢弃，150s 不刷新作废；只用于分摊负载；
  - `view { providerId, model? }` → 组设置与组员状态(`ProviderGroupView`)；省略 `model` 时只按组级状态返回，
    发送前检查带上当前模型时，组所在电脑按该模型重新计算额度。带 `model` 的回包回显同一个 `model`，调用方只在回显一致时
    使用模型级状态；旧组所在电脑忽略这个可选字段、没有回显时只沿用离线、不可用和组级冷却等不依赖模型的状态，
    对可用或满载状态按模型额度未知处理，不会把旧端的组级可用状态误当成模型级状态。
  - `session-group { sessionId }`(只读，2026-10-11)→ `{ group: { groupDeviceId, providerId } | null }`：发给**任务所在的电脑**
    (不论它有没有组)，回答这个任务此刻归哪个组，坐标是那台视角(`groupDeviceId` 为 null = 那台自己建的组)。手机与桌面远程控制
    的模型列表据此把归组的任务显示在组那一项下、在组那一项里选模型时留在此刻运行的那台(provider-groups.md §10)。不读写分配器、
    负载与绑定。旧版本回 `CHANNEL_NOT_ALLOWED`(没有这个通道)或 `[INVALID_PARAMS] unknown provider group action`(有通道没有这个
    动作)，控制端一律按没归组处理，即与改动前相同。
  - `rebalance-suggestion { sessionId }` / `rebalance-decision { sessionId, memberKey, remember: boolean }`(2026-10-21，任务进行中
    换号，provider-groups.md §6.2)：同样发给**任务所在的电脑**，见[「供应商组任务进行中换号」](provider-group-mid-task-account-switch.md)。
  旧 O 回 `CHANNEL_NOT_ALLOWED`：`pick` 按 `none` 处理，任务照旧直接在 O 上运行。
- **`maker:provider:list` 新增可选字段 `group`**：只对同账号调用方、只加在建了组且「允许被远程调用」的供应商上：
  `{ strategy, autoSwitch, members: [{ key, kind, agentDeviceId, providerId, label?, paused }] }`(并发上限与权重不外发)。
  组摘要列着组内电脑，受邀者与共享任务访客拿不到：分享投影里去掉，`scrubSharedProvider` 再兜一层(分享者电脑、受邀者电脑与
  手机各过一遍)。旧控制端与手机不认识就忽略；新控制端据此在模型列表与设置页收起组员(只看在线电脑的目录)，新手机在模型列表
  里同样收起(2026-10-11)。O 改组后经
  `maker:provider:changed` 推送让同账号电脑重读目录。
- **远程 Agent open 载荷新增可选 `groupAssigned: true`**(`remote-agent/wire.ts`)：任务由供应商组分配到这台(本机的组或另一台的组)，
  这台直接运行、不再进入它自己的组(防转圈)。旧被控端解码时丢弃(它本来没有组)。
- **本地数据**：C 上经另一台电脑的组分配的任务绑定存 `provider-group-remote-bindings.json`(按账号，与本机组的
  `provider-group-bindings.json` 分开，降级后旧版本读不到它，不会误认成本机的同名组)。因组内电脑被移出或组被删除而
  解除过绑定的任务按组记在 `provider-group-released.json`(按账号，2026-10-10)，老任务纳入组时据此跳过(provider-groups.md
  §6、§9.4)；旧版本不读也不改写它，降级再升级后记录仍在。本机删组或移出组员时，解除记录改为与绑定删除一起
  原子写入 `provider-group-bindings.json` 的可选 `released` 字段，避免账号切换或中断造成半完成；读方合并两处记录，
  显式重新分配给同一个组时清除该组记录。旧文件缺字段视为空，旧版本写绑定仍保留未知根字段；旧版本运行期间不识别
  这些新增的内联记录，升级后解除记录优先于旧版恢复的同组绑定。损坏绑定文件保留并拒绝覆写。组所在电脑的冷却按账号存 `provider-group-cooling.json`
  (`{ cooling: { [providerId]: { [memberKey]: until } } }`，只存未到期的，2026-10-11)，重启后照样避开；旧版本不读它。
  不改数据库与服务端。
- 实现：`apps/desktop/src/main/provider-group/`(`remoteHandler.ts`、`remoteClient.ts`、`externalLoad.ts`、`leaseReporter.ts`、
  `service.ts` 的组来源)；回归见同目录 `__tests__/remoteGroup.test.ts`、`remoteHandler.test.ts`、`leaseReporter.test.ts`，
  `device-link/__tests__/providerShareDispatch.test.ts`(受邀者拒绝与不泄露组摘要)。
