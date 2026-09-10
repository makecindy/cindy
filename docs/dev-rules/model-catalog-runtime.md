# 模型运行时与展示细则

> 状态：权威开发规则。排查窗口、压缩、模型名称或展示行为时读取。
> 架构、数据归属与修改入口见 [模型配置与下发](model-catalog-maintenance.md)。
> 文中的版本号和日期限定对应引擎行为，升级引擎时需重新验证；不表示生产部署状态。

## Pi 原生目录与兼容代码

Pi 的 `thinkingLevelMap` 是稀疏映射：标准档位省略时仍支持，`null` 才表示不支持；
`xhigh`、`max` 则需要显式映射。目录导入、客户端目录和启动快照必须共用此解释，
不能把 `Object.keys(map)` 当成完整能力列表，导致默认档被错误替换成更高档。

删除临时兼容补项前，必须验证随包 Pi 已原生支持相同模型、协议及参数；
仅 Server 新增该模型不足以证明可以删除兼容代码。专项规则见 [Pi harness](pi-harness.md)。

## 上下文显示错误的排查顺序

先检查活动目录是否就写错了窗口，再检查当前路由的运行时上报与校正，最后检查旧任务
持久化快照及显示优先级。数据库里同一个大窗口数值，可能来自过去的上报，也可能来自
当前错误目录被当作 verified 写入；**仅凭旧任务或截图不能判断是哪一种**。

Codex 的圆环总窗口由绑定的 CLI 配置和原生模型元数据解析；运行期的
`modelContextWindow` 是预留空间后的可用容量，不能直接当作总窗口，也不能由 Cindy
模型目录覆盖。总窗口、可用容量和自动压缩阈值分开展示；读取失败显示未知，不猜 272K。
模型配置页的上下文上限统一写入该行所有引擎。未保存覆盖值时，Codex 也必须应用该供应商路由在设置页显示的默认窗口，不能只给自定义供应商注入窗口而漏掉 Gateway／订阅。Codex 使用每个任务独立的原生模型目录与
thread 配置，同时设置窗口和 90% 自动压缩预算，保留原生 5% 可用空间预留及原有压缩方式。
显式设置可以超过原生目录默认最大值；它改变 CLI 预算，不改变供应商实际能接受的长度。
已运行任务在当前轮结束后重建执行句柄、保留原生历史；恢复默认删除 override。
保存后的运行时刷新失败时，仅恢复本次修改的原账号 override（保留各引擎原值和缺席状态，
不覆盖之后的外部修改）；界面失败后重新读回实际持久值，不沿用旧快照。
空闲任务释放执行句柄后，提示可读取下一次启动将应用的 CLI 配置，但必须标记待应用；不能把它当运行期窗口计算旧用量百分比。尚无实际用量时显示未知，不显示 0%。
未知模型保留 Codex 原生 fallback 的提示词和工具元数据，不克隆 GPT 模板。
`codex-native-fallback-prompt.md` 原样来自 OpenAI Codex `rust-v0.153.0` 的
`codex-rs/models-manager/prompt.md`（Apache-2.0）；升级 CLI 时需同步其 fallback 元数据与
原生提示词清理规则，并以实际 CLI 验证窗口、压缩触发、历史恢复和提示词／工具不变。

修复显示时复用运行时已有的路由判定，保留数据来源边界。目录错误应回到 Server／发布
源修正；不要把某个模型的正确数字硬编码进圆环，也不要用取最小值一律压掉显式长窗口。

相关规则：[`configuration-and-overrides.md`](configuration-and-overrides.md)、
[`pi-harness.md`](pi-harness.md)、[`remote-and-mobile-adaptation.md`](remote-and-mobile-adaptation.md)。

### 默认型号与预览版的选择

以下描述既有默认陈列策略；默认开启的产品合同与实现差异见
[架构入口的默认可见性说明](model-catalog-maintenance.md#visibility)。

Cindy AI 每个厂商只选少量常用型号；同代优先具有实时图片输入能力的型号，然后比较版本变体和折扣。
DS4 Flash Vision Exp 与 HY4 Preview 是已确认的 Gateway 推荐例外；只有 XD 的实时 chat 路线
声明相应输入/输出能力时参与默认选择。不能只靠共享 Registry、模型名称或 Pi 内置数据将
直连供应商／自定义 API 的同名预览版默认打开。缺能力、需付费、无可用默认 Harness 时回退其它候选。
其它尚未确认的 exp/preview 和特殊长窗口型号仍由用户手动开启。显式用户偏好优先，目录更新不覆盖。

设置中的模型信息保留本地化简介、ID、厂商及必要生命周期提示；正常 active 与目录默认启用不展示，
alpha/deprecated/retired 必须翻译。供应商原始英文描述不直接作为本地化设置文案展示。

2026-09-05 Chris 确认这六款 Gateway 常用模型默认采用中档：GLM 5.3 Flash、Kimi K3、
Doubao Seed 2.1 Pro、Qwen3.8 Max、DS4 Flash Vision Exp、HY4 Preview。只设置模型默认意图，
真实可调档位仍取实时路由；不支持中档时适配，不合成能力。用户显式深度与收藏配置保留。
Kimi 的 XD 默认与公共直连路由分开维护。发布时将这份递增 revision 的 Registry 同步到
Server 目录；不改 Gateway 的价格、成员、上下文与可用性。

### 模型名称本地化

中文界面使用经核实的官方中文厂商／系列名；版本号与变体后缀保留原样。
例如 Qwen → 千问、Doubao → 豆包、HY/Hunyuan → 混元；GLM、Kimi、GPT、Claude、Gemini
保留其通用型号名，厂商另显示智谱、月之暗面等。未知品牌、未知型号与自定义名称不硬译。
英文及其它未登记译名的界面保持目录原名。名称在 Renderer 展示时翻译，管理页、选择器和
配置浮层复用同一个函数；搜索同时匹配原名、模型 ID、中文名及厂商，不把译名写回目录、
请求、收藏或用户偏好。远程新型号保留原始版本后缀，未登记系列直接显示上游原名。

2026-09-05 核实来源：[千问](https://www.aliyun.com/product/tongyi)、
[腾讯混元](https://hunyuan.tencent.com/)、[智谱](https://www.zhipuai.cn/zh)、
[月之暗面](https://www.moonshot.cn/)、[深度求索](https://www.deepseek.com/)、
[字节跳动 Seed](https://seed.bytedance.com/zh/seed2)、[豆包](https://www.doubao.com/)。不根据这些页面改变运行协议或能力。

### 模型简介本地化

Desktop 模型选择器（含收藏）、旧入口的配置浮层及设置详情统一使用
`renderer/lib/modelDescriptions.ts` 解析本地简介，文案放在五语 `common.json` 的
`modelDescriptions`。只写简短用途，不从文案推导能力、协议、价格、窗口或默认档位。
同系列不同接入路径复用用途说明；特殊长上下文版本保留单独的费用提醒。
媒体用途优先尊重明确的类型字段，不能因厂商分组是 GPT 就介绍成编程模型。

本地简介属于显示文案，不覆盖 Registry、Pi 或 Gateway 的原始 description，也不新增
wire 字段或修改远程目录优先级。Server 仍可按原 schema/revision 下发模型和参数。
已知系列的新版本沿用系列简介；未知系列照常列出且可以搜索、选择，只省略未收录的简介，
不能用上游未翻译文本兜底、隐藏整个模型或阻断目录更新。不得按显示名称匹配简介，避免
用户重命名改变匹配；使用稳定的模型 ID。添加系列时补齐五语资源，覆盖测试遍历本地
Registry 的全部模型及其 routes，防止只翻译当前默认启用的几款。

### GPT 日常窗口与 Codex Chat Completions（2026-09-06 用户裁决）

- 内置 OpenAI 订阅与 XD 的 GPT 路由采用至多 272,000 tokens 的日常默认窗口，
  覆盖普通、`codex/`、`openai/`、`chatgpt/` 别名及各引擎。较小模型不扩容。
  `contextWindowMax` 保留供应商容量；这是客户端工作默认策略，不修改服务端能力声明。
- 显式上下文 override 仍优先，可设置 1M；恢复默认删除 override 后采用 272K。
  自定义供应商与非 GPT 模型不套用此默认策略。
- Codex CLI 0.153.0 已移除原生 Chat Completions。Cindy 的既有转换路径仍可使用，
  但按 2026-09-07 用户更正，界面恢复「兼容模式」、默认关闭，允许用户手动开启。
  不新增「支持」协议分类；用户显式开关保持优先。GPT 窗口默认与自动压缩修复不回退。

### 三引擎上下文预算（2026-09-09）

- 以下字段指客户端 `CatalogModel`：`contextWindow` 是工作默认值，`contextWindowMax` 保留上游最大支持值；后者不能写入 Registry。
  单模型上下文设置另存用户预算；恢复默认删除预算，重新读取当前工作默认值。
  Claude Code、Codex、Pi 的创建、恢复、切换和历史整理都必须使用同一路由预算。
- 修改预算或目录工作默认值后，空闲任务释放运行句柄、下次发送恢复原历史；正在回复的
  任务等当前轮结束再应用。不得覆盖已排队的模型／来源选择，也不得因刷新失败报告已生效。
- Claude Code 2.1.259 的已知模型不会靠 `CLAUDE_CODE_MAX_CONTEXT_TOKENS` 改变压缩窗口，
  必须同时配置 `CLAUDE_CODE_AUTO_COMPACT_WINDOW`。该原生窗口最低 100K；更小的预算通过
  `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` 等比例降低触发阈值。`/context` 的原生窗口／阈值展示
  不包含这项百分比调整，不能据此断言小预算无效，需验证真实 `compact_boundary`。
- 预算控制自动整理的触发时机，不代表每个请求（系统提示、工具定义、最新消息和输出）
  都能严格压到该 token 数以内。原生引擎的最少历史组数和保留空间仍适用。
- Pi 继承原生目录时通过 `modelOverrides.contextWindow` 应用工作窗口，保留原生协议、
  OAuth 和兼容参数；生成的压缩预留空间必须使用同一工作窗口。
- 原生回归进入显式 integration tier，使用隔离目录与本地假上游，不能依赖开发者凭证。

### 本地模型目录

本地模型筛选与更新遵循 [`local-model-selection.md`](../product-rules/local-model-selection.md)。
Server 维护 Registry V4 的 `localModels`，本仓 `model-registry.json` 仅作离线副本；
不得重新增加独立的硬编码推荐名单。更新时协调完整 Registry revision 和服务端覆盖源，
保持旧客户端的版本投影与显式空推荐语义。


### 原生缓存与简略列表的字段完整性（2026-09-07）

Codex 的 `context_window` 是工作默认，`max_context_window` 是原生最大窗口，不能互相代替。
原生明确的最大值要经过 Registry 合并和 Claude 订阅桥继续保留；Pi 与 Gateway 保持独立来源。
`input_modalities` 明确的图片 / 纯文本能力同样需要导入；`service_tiers: []` 表示明确无 Fast，
与字段缺失不同，旧 Registry 不能将账号明确没有的速度档重新开启。本地显式 override 的优先级不变。

`model/list` 是简略刷新：它负责当前成员、排序、思考和速度档位，不含窗口 / 图片元数据时，
只对存续型号保留同账号已知的这类字段。完整 cache 刷新与账号清空不得沿用旧字段；
下架型号不能因为补元数据而被重新加入。无原生数据时仍依赖 Registry，不能把读取失败推断成 872K 或 1M。

2026-09-07 的全目录核对与源侧待办见 [2026-09-07 核对记录](../model-catalog-audit-2026-09-07.md)。


### 型号标准与 Gateway 控制（2026-09-07 用户裁决）

Gateway 下发不是所有模型事实的唯一依据。先对照官方规格、当前原生目录和实际通道，
维护经核实的 Registry。思考档位有两层：Registry 的基础档位描述型号标准；Gateway 的
`efforts` / `perAgent.efforts` 决定该通道当前可以选择的档位。Desktop 投影的 `displayEfforts`
只供展示两者并集，Gateway 目录未声明可用的档位置灰，不进入运行时能力或可发送参数。空数组关闭全部档位，
未知型号不猜档位；服务端放开后正常刷新即可恢复可选。不把订阅 Codex 的 ultra 推给公共 API。
该展示字段不加入 Server Registry schema。实际价格、缓存报价、折扣继续取实时通道，
官方参考价只用于相应参考价入口，不覆盖实价。

Astra / Sol / Terra / Luna 的官方容量为 1,050,000；本地 Registry 分开写模型容量和
Codex / Claude 的 272,000 工作默认，账号原生明确的最大值继续优先。Pi 按显式订阅路由声明，
不借公共 API 扩大订阅能力。用户可显式调整工作预算，预算不代表通道承诺。
GPT `[1m]` 是旧窗口预设，退出 Desktop 管理和新选择清单；完整运行目录及历史价保留兼容，
不改收藏、历史模型 ID 或用户已保存的窗口。自定义供应商、Claude / GLM 的真实变体不受影响。

对应批次的源侧同步记录见 [历史记录](../model-catalog-history.md)；今天的发布状态必须重新核对目标环境。

置灰只能证明当前目录未声明可用，不等于已实测后端拒绝。模型管理页未启用分区始终展开，旧折叠偏好不再隐藏这些型号。

## 从需求找到代码

| 阶段 | 代码入口与函数 | 相关验证位置 |
| --- | --- | --- |
| 完整 Catalog / Registry 校验 | [catalog.ts](../../packages/model-providers/src/catalog.ts) `parseCatalog`；[modelAccessValidator.ts](../../packages/model-providers/src/modelAccessValidator.ts) `parseModelRegistry` | [catalog.test.ts](../../packages/model-providers/src/__tests__/catalog.test.ts)、[modelAccessValidator.test.ts](../../packages/model-providers/src/__tests__/modelAccessValidator.test.ts) |
| 数据源、缓存、内置回退 | [source.ts](../../packages/model-providers/src/source.ts) `loadCatalogWithSource` / `selectNewerModelRegistry`；[modelRegistry.ts](../../packages/model-providers/src/modelRegistry.ts) `decideModelRegistrySnapshot` | [source-registry.test.ts](../../packages/model-providers/src/__tests__/source-registry.test.ts)、[modelRegistry.test.ts](../../packages/model-providers/src/__tests__/modelRegistry.test.ts) |
| 资料继承与预设 | [modelMetadataLayers.ts](../../packages/model-providers/src/modelMetadataLayers.ts) `resolveModelMetadata`；[user-provider.ts](../../packages/model-providers/src/user-provider.ts) `buildUserProvider` | [modelMetadataLayers.test.ts](../../packages/model-providers/src/__tests__/modelMetadataLayers.test.ts)、[user-provider.test.ts](../../packages/model-providers/src/__tests__/user-provider.test.ts) |
| Desktop 活动目录与刷新 | [createDesktopProviderService.ts](../../apps/desktop/src/main/maker-host/createDesktopProviderService.ts)；[active-catalog.ts](../../apps/desktop/src/main/maker-host/active-catalog.ts) | [host 测试](../../apps/desktop/src/main/maker-host/__tests__) |
| 用户覆盖 | [localCatalogOverrides.ts](../../apps/desktop/src/main/maker-host/model-plane/localCatalogOverrides.ts)；[model-catalog-override-store.ts](../../apps/desktop/src/main/maker-host/model-catalog-override-store.ts) | host 的 modelPlane / override 测试 |
| 多账号与公共目录身份 | [provider-identity.ts](../../packages/model-providers/src/provider-identity.ts) `providerCatalogId`；[subscription-account-models.ts](../../apps/desktop/src/main/maker-host/subscription-account-models.ts) `refreshSubscriptionAccountModels`；凭证适配见同目录 codex-account-auth / subscription-account-auth | [目录共用与账号隔离测试](../../apps/desktop/src/main/maker-host/__tests__/openAiAccountCatalogParity.test.ts)、[订阅凭证测试](../../apps/desktop/src/main/maker-host/__tests__/subscription-account-auth.test.ts) |
| 媒体列表投影 | [providerMediaModels.ts](../../packages/model-providers/src/providerMediaModels.ts) `projectProviderMediaModels` | [providerMediaModels.test.ts](../../packages/model-providers/src/__tests__/providerMediaModels.test.ts) |
| 本地候选与推荐 | [localModelCatalog.ts](../../packages/model-providers/src/localModelCatalog.ts)；[localModelRuntime.ts](../../apps/desktop/src/shared/localModelRuntime.ts) `recommendForHost` | [localModelRuntime.test.ts](../../apps/desktop/src/shared/__tests__/localModelRuntime.test.ts) |
| 模型路由进入执行配置 | [runtime-configs.ts](../../apps/desktop/src/main/maker-host/runtime-configs.ts)、[model-plane](../../apps/desktop/src/main/maker-host/model-plane)、[pi-host.ts](../../apps/desktop/src/main/maker-host/pi-host.ts) | host 及 [maker-core 测试入口](../../packages/maker-core/src/agents) |

Server 对应入口为 `model-access-server/src/routes/modelCatalog.ts`、`services/catalogSource.ts` 与本仓独立维护的 contracts。
先确认 Server 分支是否具备目标能力；不要把本仓解析器直接视为 Server 已部署的实现。
两仓边界遵守 [协议兼容规则](protocol-compatibility.md)。
