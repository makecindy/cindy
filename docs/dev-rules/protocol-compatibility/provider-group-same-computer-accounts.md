# 供应商组：同一台电脑的几个账号按电脑聚合（2026-10-15）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

产品规则见 [`provider-groups.md`](../../product-rules/provider-groups.md) §10。组成员的键与分配不变，只给展示与计数补两项可选字段：

- 组设置成员新增可选 `providerName`(加入时那台电脑上这个供应商的显示名快照，保存时以候选目录为准)；同账号目录里的组摘要
  (`maker:provider:list` 的 `group.members[]`)与 `provider-group:remote` 的 `view` 成员状态也带可选 `providerName`
  (状态优先用那台电脑当前的供应商名)。按显示名校验(去空白、≤128、无控制字符)，不合格就丢弃。
- 分享来的组员新增可选 `hostDeviceId`(分享者那台电脑的设备 id，本账号收到的分享里本来就有)：加入时取自候选目录，
  保存时渲染端给的值以目录为准、渲染端漏带时沿用已存的；旧组由 `removedShares.ts` 的 `recordShareHosts` 在对账已收到的
  分享时补记(只补名单里有的，没变化不写)。随组摘要发给同账号电脑(含手机)，不显示、不用于连接；只接受设备 id 格式，
  其余组员类型上的这一项丢弃。物理电脑键：分享来的有它时按它，没有时按分享各算一台。
- 旧端忽略这两个字段(旧版本读写组设置会丢掉它们，升级后由对账与下次保存补回)；新端读到旧组所在电脑的回包没有
  `providerName` 时用组设置里的快照，都没有时界面写「账号 N」。不新增 channel，不改 relay、服务器或数据库。
  组摘要本来就不发给受邀者，受邀者的匿名状态也不带这两项。
- **给受邀者的 `groupSize` 与匿名状态改为按物理电脑**：`sharedProviderGroupSize` 用 `providerGroupDeviceCount`，
  `readSharedGroupStatus` 把同一台电脑的几个账号合成一项(`sharedGroupComputerStates`，取最能接任务的状态)，两者项数一致，
  仍满足 `readProviderShareGroupStatus` 的「状态数 = 台数」校验；新旧受邀者都按原格式读，只是项数变少。
- 实现：`shared/providerGroup.ts`、`provider-group/router.ts`、`ipc.ts`、`directory.ts`、`removedShares.ts`、
  `reshareRuntime.ts`、`sharedStatus.ts`、`remoteHandler.ts`，界面聚合在
  `renderer/features/provider-group/providerGroupPresentation.ts`，手机计数在 `apps/mobile/src/session/remoteProviderGroups.ts`；
  回归见 `shared/__tests__/providerGroup.test.ts`、`provider-group/__tests__/` 下 `ipc`、`directory`、`removedShares`、
  `sharedStatus`、`remoteHandler` 测试与界面、手机同名测试。
