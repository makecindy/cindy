# 供应商分享：受邀者不看分享者的电脑名，组只给台数(2026-10-10)

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

产品规则见 [`provider-sharing.md`](../../product-rules/provider-sharing.md) §5.1、§6 与 [`provider-groups.md`](../../product-rules/provider-groups.md)
§8、§9.7、§10。受邀者只知道是谁分享的、分享的是哪个供应商；本节登记组台数，2026-10-12 增加的匿名状态见[「按需查看匿名组状态」](provider-sharing-anonymous-group-status.md)。

- **分享投影里的 `maker:provider:list` 新增可选 `groupSize`**(正整数，1–512)：分享者把这个供应商建了组、且仍「允许被远程调用」
  时，`projectProviderListForShare` 按本机组设置填上(目录里原有的值一律先去掉)。`scrubSharedProvider` 在分享者电脑、受邀者电脑
  与手机各过一遍，只留合理的整数(`readProviderShareGroupSize`，`packages/device-link/src/providerShareCatalog.ts`)。旧受邀者不认识
  就忽略；旧分享者不带，新受邀者当作没有组。
- **分享链接的 `deviceName` 填固定占位 `Cindy`**(`PROVIDER_SHARE_NEUTRAL_DEVICE_NAME`)：字段仍必填(服务端与旧版受邀者按必填非空
  字符串处理)，只是不再上传分享者的电脑名。被控电脑转给手机的 `maker:provider-share:received-catalogs` 里的 `deviceName` 同样填
  占位(服务端仍存着旧链接里的电脑名)。新版本界面一律不读这个字段；旧版受邀者会显示占位(新链接)或原来的电脑名(旧链接)。
- **同账号的组摘要(`group`)里 `kind: 'share'` 的组员不再带 `label`**：旧版本加入时存的快照是分享者的电脑名。新控制端按自己收到的
  分享(分享属于账号)显示分享者昵称；`provider-group:remote` 的 `view` 里这类组员的 `label` 改为分享者昵称，旧控制端照常显示它。
- 换 Agent 位置的分隔条：目标是分享(`share:<id>`)时不写 `toAgentDeviceName`，显示成「已改到另一台电脑上运行」；
  供应商组换电脑的活动记录里分享来的电脑写分享者昵称。
- 不改 relay、服务器与数据库。实现：`device-link/dispatch.ts`(`projectProviderListForShare`)、`provider-group/remoteHandler.ts`
  (`sharedProviderGroupSize`)、`provider-group/directory.ts`(`memberLabel`)、`device-link/providerShareRuntime.ts`；回归见
  `device-link/__tests__/providerShareDispatch.test.ts`、`provider-group/__tests__/remoteHandler.test.ts`、`directory.test.ts`、
  `packages/device-link/src/__tests__/providerShare.test.ts`。
