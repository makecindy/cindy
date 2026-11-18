# 发送前恢复设备链路（`needsLinkRecovery`，2026-11-17）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

控制端（Desktop 与 Mobile）向一台曾协商可靠传输、当前发送链路未就绪的设备发起新的 invoke 或订阅前，
先经该设备既有的 `link-open` 单飞建链恢复链路，再发送请求。判据是共享客户端的
`DeviceLinkClient.needsLinkRecovery(deviceId)`：该设备曾协商可靠传输且发送阶段不是 ready（例如本机
中继连接以 1006 / 1012 关闭后重连）。从未建链、只走 legacy，或已显式关闭（关闭时撤掉可靠层）的设备
返回 false，继续原路径。

- **Mobile**：invoke 与订阅发送前复用 `sendOpenLinkOnce` 的按设备单飞缓存，不复用故障前已结算的
  accept。用户断开按每台设备的断开代次判断（只在 `closeLink` 时加一，与 Desktop 的
  `openLinkCloseEpochs` 同义），不看建链缓存条目：presence、对端重置、直连路径结束都会删缓存条目，
  中继重连后 presence 又通常先于 link-accept 到达，按条目判断会误丢已经就绪的请求。恢复握手在真正
  调用 `openLink` 前（`openLink` 会清除用户关闭标记）和 accept 之后各复核一次：客户端已换账号以
  `NOT_CONNECTED` 结束；断开代次变化或 `isOutboundExplicitlyClosed` 以 `LINK_NOT_OPEN` 结束，不发
  `link-open`、请求不写出。订阅在恢复期间有 topic 被释放时按原有语义返回 false，由确认流程重算
  仍缺的 topic 继续订阅。被 `refreshSettled` 替换掉的已结算建链只算刷新：仍在等它的历史读取可以
  完成；真正的失效（presence、对端重置等）删除条目，照旧作废。
- **Desktop**：`remoteInvokeLive` 经 `linkRecovery.ts` 的 `ensureInvokeLinkReady`，`remoteSubscribe`
  在发送前按同一判据重开。订阅等待期间用户断开时直接以 `LINK_NOT_OPEN` 失败，不再复验控制权限；
  复验失败会再次拆链，而这条链路已经被用户关掉。

**Wire 影响**：无。发送前只多走一次已有的 `link-open` / `link-accept` 握手，不新增 relay kind、顶层
字段、channel、能力位或校验；被控端看到的是一次普通的重新建链，新旧被控端都已支持。建链成功不算
业务恢复，熔断与响应性判定不变。控制端与被控端可以任意版本组合，无发布顺序要求。

**自建中转**：中继按既有 kind / dst 透明转发 `link-open` 与业务帧，`packages/device-link-relay` 无需
修改，已部署的中转无需升级，`RELAY_VERSION` 不变。验证：`pnpm --filter @cindy/device-link-relay test`、
`pnpm --filter @cindy/device-link-relay run interop`（真实自建中转上的加入、签名通信、自动重连与 SDK
版本矩阵）以及 `pnpm test:device-link`（真实 loopback WebSocket 上的重连、半开探测与另一控制端隔离）
均通过。

**故障半径三问**：

1. 故障层级：单个 peer 的可靠链路发送阶段未就绪，证据是共享客户端对这台设备的 `needsLinkRecovery`，
   通常由本机中继连接断开重连引起；单次超时、背压或其它设备的状态都不触发。
2. 动作层级：只对这一台设备发一次单飞 `link-open`，同一设备的并发请求共用这次握手；不重启共享
   中继连接、不复位其它 peer、不重放已写出的写操作。等待中失效的请求直接结束，不再发起新的恢复。
3. 多 peer 用例：`packages/device-link/src/__tests__/client.test.ts`「host-triggered recovery of previously
   reliable links」用内存中继让手机与另一台健康控制端共享同一被控端，手机经 1006 / 1012 断线后恢复：
   健康控制端的请求照常完成、链路保持就绪，被控端与健康控制端都不新建 socket，手机断线前已写出的写
   操作只执行一次。Mobile `historyViewProvider.test.tsx`「Provider pre-send link recovery」经真实
   Provider 验证 invoke 与订阅发送前先重开这台设备、另一台电脑的请求不建链、共享连接不重启；用户
   断开后请求不写出，等中继上线期间断开也不重新建链；presence 夹在 link-open 与 link-accept 之间、或在
   等中继上线时到达，请求照常发出；恢复期间释放部分 topic，其余 topic 照常订阅；刷新替换已结算建链时，
   在等它的历史读取照常完成。Desktop `remoteInvokeSendGuard.test.ts` 覆盖发送前恢复、取消、断开、禁用与
   仅列表订阅。

实现见 `apps/mobile/src/device-link/DeviceLinkContext.tsx`（`recoverLinkBeforeSend`）、
`apps/desktop/src/main/device-link/index.ts`（`remoteInvokeLive`、`remoteSubscribe`）与
`packages/device-link/src/client.ts`（`needsLinkRecovery`）。
