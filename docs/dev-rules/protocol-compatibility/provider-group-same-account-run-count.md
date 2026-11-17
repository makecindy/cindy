# 供应商组：同账号电脑上的运行数(2026-10-10)

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

产品规则见 [`provider-groups.md`](../../product-rules/provider-groups.md) §5「本机与同账号电脑」。组所在电脑要显示组里每台
这个供应商实际在跑几个任务，含那台自己用的、不经组的与替分享的人跑的。

- **同账号电脑读的 `maker:provider:list` 新增可选 `runningTurns`**(非负整数，0–4096，`PROVIDER_RUNNING_TURNS_FIELD`，
  `packages/device-link/src/providerGroup.ts`)：被控端在 `decorateProviderListWithGroups` 里给每个允许被远程调用的供应商
  填上这台电脑上用它正在运行一轮的任务数(没在跑的为 0；结果里原有的值一律先去掉；读不到时整个目录都不带)。
  计数(`provider-group/localLoad.ts`)= Agent 在本机运行的本机任务(按任务记录的来源，没记来源的按本机实际会用的来源；
  Agent 在另一台电脑、分享来的电脑或 SSH 主机上的不算) + 远程 Agent 服务在本机运行的任务(`turnRunningProviders`，
  转给组内另一台的不算)。只给同账号电脑：`scrubSharedProvider` 去掉这个字段，受邀者与手机转交的分享目录都不带。
- 组所在电脑读本机的数直接现算，读同账号电脑的从目录取(`readProviderRunningTurns`，只认合理整数)；分享来的电脑仍只认
  `guestRunning`，不认 `runningTurns`。
- 兼容：旧电脑与手机不认识就忽略；旧被控端不带，新组所在电脑照旧只算经本组的。`decorateProviderList` 改为可异步，
  只在本机内部接线，不影响 wire 形状。
- 不改 relay、服务器与数据库，不新增 channel。实现：`remote-agent/host/runHost.ts`(`turnRunningProviders`)、
  `provider-group/localLoad.ts`、`provider-group/remoteHandler.ts`、`provider-group/directory.ts`(`localRunning`)、
  `maker-ipc/register.ts`(接线)；回归见 `provider-group/__tests__/localLoad.test.ts`、`remoteHandler.test.ts`、
  `directory.test.ts`、`remote-agent/__tests__/guestHost.test.ts`、`device-link/__tests__/providerShareDispatch.test.ts`、
  `packages/device-link/src/__tests__/providerShare.test.ts`。
