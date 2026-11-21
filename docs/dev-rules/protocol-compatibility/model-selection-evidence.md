# 模型选型依据

`CatalogModel.membershipSource` 是 OpenAI 订阅 Pi 候选的可选运行时字段，按供应商连接
计算。值为 `account-catalog`、`public-catalog` 或 `user-configured`；语义见
[模型资料与成员规则](../../product-rules/model-metadata-precedence.md)。它不是授权状态，
不进入公共 `ModelMetadata`、成员准入或凭证配置，也不覆盖 API-key／自定义连接。

- `maker:provider:list` 沿现有 `ProviderView.models` 携带字段；读取端
  `parseDeviceProviderViews` 保留模型的增量字段，分享投影仍按现有规则去敏。
- 本机与远程的 `orcaProviderRoutingContext` 将字段放入每个来源的 `modelDetails`。
  `list_available_models` 仅投影已知值为 `providers[].membership_source`；
  `schedule_list_models` 沿现有返回结构携带 `providers[].modelDetails.membershipSource`。
  同名模型的不同来源各自保留依据，不能合并成模型全局结论。
- 旧订阅账号并入另一连接形成混合目录时，清掉不能归属于目标连接的依据；仅保留
  目标自身的显式 `user-configured`，不把导入账号的依据当成目标账号的实时权限。
  独立账号池尚无自己的目录时，清掉镜像自内置连接的标记；取得针对该池的目录后
  可保留账号／公共依据，但复制的内置 addition 不标为目标自身的用户配置。
  云端备用分享目录的既有元数据白名单不携带此字段，降级为未知。供应商组若携带
  基础目录的依据，只描述该目录来源，不证明所有成员或最终执行账号的准入。
- 新工具遇到旧 Host 缺字段或未知值时按未知处理，不推导支持／不支持。
  旧工具继续原响应格式与选型行为；新 Host 不要求旧端使用该字段。
- 复用原目录读取，无新请求、重试、持久化、channel、能力位或 relay 帧。
  官方与自建中转均传输原业务 payload，无需服务端发布或升级窗口。
- 回归入口：`openAiAccountCatalogParity.test.ts`、
  `subscriptionPoolCatalog.test.ts`、`orcaProviderRoutingSnapshotWiring.test.ts`、
  `listAvailableModelsTool.test.ts`。
  这些验证目录与工具数据契约，不代替真实账号请求或承诺模型每次调用成功。
