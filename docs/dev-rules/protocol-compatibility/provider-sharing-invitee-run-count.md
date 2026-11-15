# 供应商分享：受邀者自己的运行数(2026-10-10)

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

产品规则见 [`provider-groups.md`](../../product-rules/provider-groups.md) §5「分享来的电脑」与
[`provider-sharing.md`](../../product-rules/provider-sharing.md) §7.4。受邀者把分享加进自己的供应商组时，组页面要显示这台在跑几个，
包括本账号不经组直接用的任务。

- **分享投影里的 `maker:provider:list` 新增可选 `guestRunning`**(非负整数，0–4096)：分享者电脑按调用方(同一分享、同一成员，
  不分设备)统计此刻正在运行一轮的远程 Agent 任务，在 `projectProviderListForShare` 里填上(目录里原有的值一律先去掉)。
  任务转给了组内电脑的按那台报来的状态算。只计调用方自己的任务，不含分享者本人(同账号控制端)与其他受邀者。
  `scrubSharedProvider` 在分享者电脑、受邀者电脑与手机各过一遍，只留合理的整数(`readProviderShareGuestRunning`，
  `packages/device-link/src/providerShareCatalog.ts`)。同账号目录不带这个字段。
- 兼容：旧受邀者与手机不认识就忽略；旧分享者不带，新受邀者按经本组的计数显示(与之前一致)。被控端的远程 Agent 服务
  没接上 `turnRunningControllers` 时同样不带。
- 不改 relay、服务器与数据库，不新增 channel。实现：`remote-agent/host/runHost.ts`(`turnRunningControllers`)、
  `device-link/dispatch.ts`(`providerShareGuestRunning`)、`provider-group/directory.ts`(`reportedRunning`)、
  `provider-group/router.ts`(`memberRunning`)；回归见 `device-link/__tests__/providerShareDispatch.test.ts`、
  `remote-agent/__tests__/guestHost.test.ts`、`provider-group/__tests__/directory.test.ts`、`router.test.ts`、
  `packages/device-link/src/__tests__/providerShare.test.ts`。
