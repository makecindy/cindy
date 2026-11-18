# 重连后保持已读任务折叠（`history-relink-folded-v1`，2026-11-11）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

控制端在 link-open / subscribe 的 `capabilities` 里声明 `history-relink-folded-v1`（Desktop 与 Mobile
都声明）：控制端在每条新链路（重连）后重读仍在显示的任务的最新历史页。
被控端因此把上一条链路上已读、且没展开的任务保持折叠，直到新链路上读完：离线积压里不留历史详情，
重连后到重读完成前只发工具开始边界和照常的变更通知，与链路没断时相同。新链路上读页失败、改用
`messages:list` 读 raw 行、新链路不再声明该能力、取消订阅或撤销设备时都立即恢复全量推。从没读过页的
任务、用户展开的组照旧全量推。

未声明的控制端行为不变，旧被控端忽略该声明。不新增 channel、relay 类型、权限或数据库 schema；
payload 对中继不透明，自建中转无需改动。实现见 `apps/desktop/src/main/device-link/subscriptions.ts`
（`foldedAcrossLink`）与 `dispatch.ts`，回归见 `dispatchSendSafety.test.ts`（history detail interest）。
