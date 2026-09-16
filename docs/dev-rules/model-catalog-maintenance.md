# 模型配置与下发：架构及维护入口

> 权威入口：先读本页，再按问题打开专题。Server 为独立仓库，文档不代表已部署。

## 数据流

```text
Server 数据库发布 → /api/model-catalog/catalog
    → 执行端加载与缓存 → 合并连接实报、用户覆盖 → 活动目录
    ├─ 选择器 / 管理页
    ├─ 聊天 → Claude Code / Codex / Pi
    └─ 媒体 → 对应媒体通道
```

聊天调用目标为「连接 ID + 上游模型 ID + Harness」。同品牌多账号共用资料，凭证、发现、用量和覆盖按连接隔离。
Mobile / device-link 使用执行端目录；本地安装状态来自执行机器。目录声明不等于账号准入或协议已实现。

### 配置包含什么

Server 正本已迁至 Model Access 自有数据库，通过 Platform「模型目录」保存草稿并发布。
添加供应商向导绑定打开时的账号代次；切换账号或区域后关闭旧向导，重新打开时再读取当前目录，旧选择和凭证不能转交给新账号。
服务端仅保留 `catalog/bootstrap/migration.deprecated.json`，由客户端和服务端固定 main 提交的实际有效配置生成，首次初始化后冻结。
客户端不携带 providers、Registry、渠道资料或接口清单的运行时 JSON；后续统一在 Platform WebUI 修改并发布。
升级读取同源旧缓存时，比较全部有效 scope 的 Registry `updatedAt`，使用最新完整快照；同一版本优先当前能力表示，不混合不同发布，不写回旧 scope。
逻辑结构如下；具体字段及修改位置见下表：

```text
Catalog (version)
├─ providers[]                 内置接入、授权、routing、各Harness models
├─ presets[].runtimes          新建连接的地址、协议和默认资料
├─ providerModelCatalog        按来源分组的模型资料、API 与 Pi 兼容参数
└─ modelRegistry (schemaVersion / updatedAt)
   ├─ baseModels[]             公共型号
   ├─ models[]                 接入条目：modelRef → baseModels；perAgent 与 routes 同级
   ├─ nativeApiRules[]         原生协议判定
   └─ localModels              候选包装 models[].variants[] + 推荐 featuredIds[]
```

### 哪些东西应该在哪里改

| 要改什么 | 写入位置 / 责任侧 | 不能顺带改变什么 |
| --- | --- | --- |
| 型号公共名称、说明、窗口、输出、思考能力 | Registry `baseModels[].defaults` | 价格、账号权限、地址和凭证不在公共继承内 |
| 接入条目状态、排序、默认开启标记 | Registry `models[]` 顶层 | 显示开关不等于成员资格；见下文默认可见性 |
| 某供应商的上游 ID、支持路由、普通默认 | `models[].routes[]` / `routes[].defaults` | 普通默认不能压过实报 |
| Claude Code / Codex / Pi 的工作默认 | 订阅 Pi 用 `providers[].models.pi`；Gateway 三个 Harness 用数据库 `models[].perAgent` | 普通默认不覆盖上游明确实报；Gateway Pi 参数仅在服务端保存并通过实时 `/models` 投影 |
| Pi 公共成员和 Pi 默认资料 | `providers[].models.pi`；公共资料仍按 Registry 合并 | 不从其他Harness名单复制出 Pi 路由 |
| 经核实的错误实报 | 匹配 route 的 `forceOverrides` + `overrideReason` | 不影响其他供应商，也不压过用户配置 |
| 厂商官方参考价及历史价区间 | `baseModels[].referencePriceGroups[].prices[]`（Registry V5） | 按市场分组，保留币种、标准/Fast、输入区间及生效日期 |
| 接入供应商参考报价 | `routes[].referencePrices[]`；`referencePriceGroup` 指向公共型号的官方价组 | Gateway 实价/折扣仍归其计费控制面，不混填缺失字段 |
| 内置接入或新增连接模板 | `providers[]` 或 `presets[].runtimes` | 不在公共目录保存真实账号密钥 |
| 订阅各 Harness 的新任务默认型号 | Server 数据库 `providers[].newSessionDefaults`，Platform 模型高级设置维护 | 不改变来源/Harness 优先顺序，不授予成员或账号权限，不覆盖用户选择 |
| 本地候选、包装、门槛、推荐 | `localModels.models` / `featuredIds` | 不自动安装、卸载、切换用户模型 |
| 某个用户的显式设置 | 本机 `model-catalog-overrides.json` 等既有偏好 | 不写回 Server；刷新保留，恢复默认删除 override |
| 新执行协议、SDK 参数、token 计量 | 本仓对应 host / harness / bridge | 加目录字段不会自动获得执行能力 |

结构例外：条目没有 `models[].defaults`；Registry agents / perAgent 只接受 Claude Code、Codex，
订阅 Pi 走 `providers[].models.pi`；Gateway 的数据库 `perAgent.pi` 会在公开 Registry 中剥离，按实时能力投影到 `/models`。用户补丁 perAgent.pi 另属合法 schema。媒体 route 使用 `agents: []`。
订阅 `newSessionDefaults` 按 Claude Code / Codex / Pi 保存模型 ID，消费端在实际模型装配后按 Harness 投影默认标记；独立于 Gateway 的 Registry 默认及区域规则。字段缺省或显式 `{}` 均不恢复旧写死型号；旧客户端忽略该 Provider 扩展字段。原生订阅的多个账号沿用同一供应商默认配置，账号 ID、凭证和用户覆盖保持独立。新任务与伙伴复用当前选择器，连接失败、缺失/隐藏/停用/退役模型和不可用 Harness 不被推荐，用户显式选择仍优先。
`contextWindowMax` 是客户端容量投影，不能填进 Registry；容量与工作预算见 [运行时细则](model-catalog-runtime.md)。

### 覆盖顺序

这里是**模型资料字段**的优先级，右边覆盖左边；成员、权限、实际计费、显示开关不套用此链：

```text
公共 defaults → 匹配的预设默认（适用时）→ 条目顶层默认
             → route.defaults → 条目 perAgent[Harness]
             → 供应商明确实报 → route.forceOverrides → 用户显式覆盖
```

缺字段继承，false 明确关闭，数组整体替换，null 按字段合同处理，不使用真假判断吞掉空值。
用户公共型号补丁先于用户具体连接/Harness补丁；默认思考档只适配实际支持能力。
详细字段及成员空值规则以 [模型资料优先级](../product-rules/model-metadata-precedence.md) 为唯一正本。

<a id="visibility"></a>
## 默认可见性

用户显式开关优先，否则跟随服务端发布的 `defaultEnabled`。客户端不再按模型代际、家族、
名称后缀或折扣筛选默认显示项；预览型号和长上下文变体也由服务端配置控制。
成员资格、实际协议能力与账号权限仍分别检查，不因显示开关而获得访问权限。
恢复默认仅移除用户 override。新用户与未自定义的旧用户随服务端配置变化，已自定义用户保留自己的开关。

<a id="release"></a>
## 更新、下发与验收

来源顺序：当前 Model Access API → 同源最后有效缓存（LKG）→ 空目录。新装离线没有内置目录。
Registry revision 只在服务端响应与已接受缓存之间比较；不从客户端常量补全已删除的模型、模板或本地推荐。
切换环境先清空活动目录再读取对应缓存，不能借用另一个环境的数据。用户已有连接、发现结果和覆盖仍按各自职责保存。

1. **确认目标**：记录两仓 commit、实际环境和当前 revision，核实供应商资料与真实通道返回值；代码实现、合并、部署分别确认。
2. **维护数据**：在 Platform 保存草稿、审阅差异并发布。首版数据库由唯一迁移文件自动初始化，无需手工补录；上线后不再同步 JSON 或重灌种子。
3. **验证兼容**：检查 parseCatalog / Registry 校验、旧客户端投影与新字段能力协商；同一 revision 不可变。服务端先部署，新客户端随后发布。
4. **核对下发**：新客户端请求 `registrySchemaVersion=5&catalogCapabilities=server-managed-catalog`，接收完整发布；原 main 的 V5 请求无需修改即可保留媒体资料，旧 V4 继续严格兼容投影。新字段不会发给不认识它们的旧解析器。URL、匿名访问和 ETag 机制不变。
5. **验收到运行时**：确认选择器、模型 ID/参数、原生 API、参考价及用户覆盖；覆盖离线缓存、首次离线、坏快照、回退版本和同 revision 冲突。发布不会覆盖用户凭证或显式偏好。

目录文件的版本更新、历史价格日期与账号可用性是不同概念；不根据 Gateway 的 wireProtocol 或 Pi API 猜测厂商原生协议。

## 通用供应商导入

Pi 渠道资料由 Server 发布的 `providerModelCatalog` 下发，供各 Harness 和设置页补缺；
不再从客户端文件或升级 Pi 时自动生成配置。目录的 Pi API 是该渠道的执行协议，不冒充 Registry 的厂商原生协议。
维护命令、覆盖顺序和验收见 [通用供应商目录](provider-catalog-generation.md)。
渠道多协议与逐模型接口证据见 [供应商接口核查](provider-interface-audit.md)。

## 按问题继续阅读

| 按需阅读 | 入口 |
| --- | --- |
| 资料、账号、覆盖、空名单 | [模型资料优先级](../product-rules/model-metadata-precedence.md) |
| 窗口、压缩、价格与展示 | [运行时与展示细则](model-catalog-runtime.md) |
| 本地包装、内存、推荐证据与更新 | [本地模型筛选](../product-rules/local-model-selection.md) |
| 图片/视频/音频/向量字段与发布兼容 | [V4 全类型规范](../model-registry-v4-media.md) |
| 供应商界面、账号状态、用量呈现 | [供应商设置](../product-rules/provider-settings.md) |
| 历史型号与同步记录 | [历史记录](../model-catalog-history.md)；不可当作当前状态 |
| 字段写法及可执行校验 | [五个示例](../examples/model-catalog.md) |
| 修改代码与定位测试 | [代码导航](model-catalog-runtime.md#从需求找到代码) |

## 厂商参考价（Registry V5）

公共型号的 `referencePriceGroups` 使用市场标识（当前为 `global` / `cn`），不是供应商 ID。
每组 `prices` 沿用原价格结构与官方证据：币种、每百万 tokens 单价、缓存读/写及 1h 写入、
标准/Fast 等变体、输入区间 `[minInputTokens, maxInputTokens)`、生效日期区间。
缺字段保持未知，明确的 0 才表示零单价；缓存存储每小时费用不能写成缓存写入单价。

`resolveBaseModelReferencePrice` 按公共 ID/唯一 alias 读取，不依赖供应商名单。
多市场/币种必须明确选择到唯一有效价格；无匹配或有歧义返回未知。
路由用 `referencePriceGroup` 明确选择所属公共型号的价格组；供应商自己的 `referencePrices`
优先于该组，整组替换，不逐字段补齐。订阅价值估算指定 `officialOnly`，仅取厂商参考价，
用户显式价格覆盖仍优先，账号归属不变。XD 计费继续只读 Gateway 实报。

新客户端请求 `registrySchemaVersion=5&catalogCapabilities=server-managed-catalog`。服务端向 V1–V4 展开官方参考价到原路由字段，
剥离新增组与引用字段；V4 保留公共资料、本地域及原覆盖语义。各版本响应有独立 ETag。
旧服务端仍可返回旧目录，新客户端保留旧格式读取；应先部署服务端再发布客户端。
升级后离线可读取原 V5、V4 媒体版及旧 V4 的缓存，只向当前请求对应的缓存写入；
同一发布在不同 schema/能力下的投影允许内容不同，升级时可接受当前响应；旧缓存的
更高 revision 仍优先。同一请求地址的同 revision 异内容继续按非法重发处理。
实现及回归见 [source.ts](../../packages/model-providers/src/source.ts) 与
[source-registry.test.ts](../../packages/model-providers/src/__tests__/source-registry.test.ts)。
本次只迁移已有、已核实的价格，不补猜测价格，不改变 XD 的缺价处理。

### 官方 API 接入预设

订阅入口的「改用 API Key 接入」与预设列表均读取服务端的对应 `*-api` 模板。
模型成员、推荐选择、URL、协议和参数不在 Renderer 写死；首次迁移数据纳入原 main
供应商向导的官方 API 配置。初始化前目录请求未完成时不展示该模板入口，模型发现等待
相同目录请求完成。账号切换前启动的请求不会向调用方返回旧目录。

独立订阅账号按 `providerCatalogId()` 归入 OpenAI → Anthropic → xAI 的既有品牌顺序，
同品牌保留本机账号在前，其他订阅随后；可用 Gateway 推荐仍最优先。排序不合并账号，
返回的连接 ID 始终属于实际选中的账号，具体默认型号仍只读取服务端声明。

服务端下发的端点尾部斜杠采用线性扫描裁剪；报价投影写入供应商 ID / 模型 ID 时只写自有属性，特殊键也按普通数据处理，不经过原型链。用户价格覆盖沿用同一写入方式，JSON 序列化与覆盖优先级不变。
