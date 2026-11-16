# 设备离线投影与显式控制关闭（2026-11-04）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

本仓自建中转的 `DeviceLinkRelayHub.presenceOf()` / `disconnectDevice()` 与 REST `deviceView()`
（`packages/device-link-relay/src/hub.ts`）在目标路由离线时都会把 `remoteControlEnabled` 投影为
`false`。这是信令/目录的离线投影，不是目标用户关闭远控：只有**当前 online** 快照里的
`remoteControlEnabled: false` 可作为新的控制关闭证据；`online: false` 附带的 false 不得撤销此前
明确拒绝、不得解除已保留直连上的权限闸，也不得让界面把离线改画成已重新允许。明确关闭、撤权或
停止仍按各自合同立即结束对应保留；只有新的有效 **online + enabled** 授权证据才能恢复。
本仓只能读证自建中转生产者；官方服务端是否已部署同形投影不由本仓实现证明，不能据本仓代码宣称官方端已上线。

回归入口：`packages/device-link/src/__tests__/client.test.ts`、`deviceLinkControllerPresenceDirectory.test.ts`、
Mobile `historyViewProvider.test.tsx` 的 offline mask / explicit-off 用例。
