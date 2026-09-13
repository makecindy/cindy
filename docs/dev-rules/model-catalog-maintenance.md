# 模型配置与下发：架构及维护入口

> 权威入口：先读本页，再按问题打开专题。Server 为独立仓库，文档不代表已部署。

## 数据流

```text
Server 随包 / 远程目录 → /api/model-catalog/catalog
    → 执行端加载与缓存 → 合并连接实报、用户覆盖 → 活动目录
    ├─ 选择器 / 管理页
    ├─ 聊天 → Claude Code / Codex / Pi
    └─ 媒体 → 对应媒体通道
```

聊天调用目标为「连接 ID + 上游模型 ID + 引擎」。同品牌多账号共用资料，凭证、发现、用量和覆盖按连接隔离。
Mobile / device-link 使用执行端目录；本地安装状态来自执行机器。目录声明不等于账号准入或协议已实现。

### 配置包含什么

Server 正本是 `model-access-server/catalog/providers.json`。客户端离线文件分别是
[`catalog/providers.json`](../../packages/model-providers/catalog/providers.json)（providers / presets）和
[`catalog/model-registry.json`](../../packages/model-providers/catalog/model-registry.json)（Registry）。
逻辑结构如下；具体字段及修改位置见下表：

```text
Catalog (version)
├─ providers[]                 内置接入、授权、routing、各引擎 models
├─ presets[].runtimes          新建连接的地址、协议和默认资料
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
| Claude Code / Codex 的工作默认 | `models[].perAgent`，引擎必须被该条目 route 声明 | 不把工作预算当供应商承诺容量 |
| Pi 公共成员和 Pi 默认资料 | `providers[].models.pi`；公共资料仍按 Registry 合并 | 不从其他引擎名单复制出 Pi 路由 |
| 经核实的错误实报 | 匹配 route 的 `forceOverrides` + `overrideReason` | 不影响其他供应商，也不压过用户配置 |
| 厂商官方参考价及历史价区间 | `baseModels[].referencePriceGroups[].prices[]`（Registry V5） | 按市场分组，保留币种、标准/Fast、输入区间及生效日期 |
| 接入供应商参考报价 | `routes[].referencePrices[]`；`referencePriceGroup` 指向公共型号的官方价组 | Gateway 实价/折扣仍归其计费控制面，不混填缺失字段 |
| 内置接入或新增连接模板 | `providers[]` 或 `presets[].runtimes` | 不在公共目录保存真实账号密钥 |
| 本地候选、包装、门槛、推荐 | `localModels.models` / `featuredIds` | 不自动安装、卸载、切换用户模型 |
| 某个用户的显式设置 | 本机 `model-catalog-overrides.json` 等既有偏好 | 不写回 Server；刷新保留，恢复默认删除 override |
| 新执行协议、SDK 参数、token 计量 | 本仓对应 host / harness / bridge | 加目录字段不会自动获得执行能力 |

结构例外：条目没有 `models[].defaults`；Registry agents / perAgent 只接受 Claude Code、Codex，
Pi 走 `providers[].models.pi`（用户补丁 perAgent.pi 另属合法 schema）。媒体 route 使用 `agents: []`。
`contextWindowMax` 是客户端容量投影，不能填进 Registry；容量与工作预算见 [运行时细则](model-catalog-runtime.md)。

### 覆盖顺序

这里是**模型资料字段**的优先级，右边覆盖左边；成员、权限、实际计费、显示开关不套用此链：

```text
公共 defaults → 匹配的预设默认（适用时）→ 条目顶层默认
             → route.defaults → 条目 perAgent[引擎]
             → 供应商明确实报 → route.forceOverrides → 用户显式覆盖
```

缺字段继承，false 明确关闭，数组整体替换，null 按字段合同处理，不使用真假判断吞掉空值。
用户公共型号补丁先于用户具体连接/引擎补丁；默认思考档只适配实际支持能力。
详细字段及成员空值规则以 [模型资料优先级](../product-rules/model-metadata-precedence.md) 为唯一正本。

<a id="visibility"></a>
## 默认可见性：产品合同与实现差异

[产品合同](configuration-and-overrides.md#模型可见性)：用户开关优先，否则跟随目录 defaultEnabled。
但 `active-catalog.ts` 的 `selectDefaultModels` 仍可能将订阅/Gateway 的 true 筛成 false；不删除成员或写用户偏好。
这是待收敛的行为差异，不是合同豁免。排查须同时检查上游值、活动目录值和用户 override；本文不改变行为。

<a id="release"></a>
## 更新、下发与验收

来源回退：开发本地文件 → 公共 API / 对应最后有效缓存（LKG）→ 旧 OSS / 对应缓存 → 内置目录。
Registry 另按 updatedAt 选择整份有效版本，较新内置快照也可能胜出；这与逐字段覆盖不同。
localModels 整域缺失才用随包本地域，显式空不兜底。

1. **确认目标**：记下 Server/客户端 commit、部署环境、实际目录源、当前 schema/revision、要改的 provider/model/引擎；核实官方资料与该通道实报。本文不是线上状态台账。
2. **修改责任侧**：在授权范围内先维护 Server 正本，再协调客户端离线 Registry。遇到尚未上线的协议配套，分别记录工作分支、已合并和已部署状态，不混成“已支持”。
3. **整表同步**：将审阅后的 Server `modelRegistry` 整体同步到客户端 `catalog/model-registry.json`，保持同 updatedAt、同内容。不要复制 Server 整份 providers.json，也不能只复制 localModels 造成悬空引用。新 revision 必须递增且不可变；价格 effectiveFrom / verifiedAt 保留其真实日期。
4. **先验证兼容再发布**：完整结构过 parseModelRegistry / parseCatalog；确认旧客户端投影。尤其先读 [媒体扩展发布前置条件](../model-registry-v4-media.md#发布前置条件)：同为 V4 并不证明认识新增媒体字段。LKG/内置回退不能代替兼容方案。
5. **核对真实下发**：检查可选 MODEL_CATALOG_URL 是否覆盖随包基线；部署后读取 `/api/model-catalog/catalog`，核对目标与旧版响应、ETag 和有效 revision。仅改文件、合并 PR、通过 CI 不算下发完成。
   同步回归须核对原有直连 route 与历史参考价区间未丢失；覆盖标准/Fast、缓存读写、长输入分档。
   离线默认档与已发布 Server 有差异时逐项披露。原生协议校验须遍历全部 route 和活动目录中的
   订阅 wire 别名，不能仅统计字段填写率；不能从供应商兼容 API 反推未知型号的原生协议。
6. **验收到运行时**：确认客户端实际接受目标快照，保留用户覆盖；检查选择器、发出的上游 ID/参数及新旧任务。覆盖离线、坏快照、同 revision 冲突与回退版本；刷新不改用户显式型号/档位，工作预算更新按 [运行时细则](model-catalog-runtime.md) 在安全时机应用。

兼容补全只能补缺项：旧快照缺失 nativeApi 可由内置补全；明确协议、null、retired 优先。
它不改窗口、价格、成员资格，也不从 Gateway wireProtocol 或 Pi piApi 猜原生协议。
旧格式迁移中若两份 Registry 有差异，必须使用不同 revision 并记录原因，不能伪造同版本一致。

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

新客户端请求 `registrySchemaVersion=5`。服务端向 V1–V4 展开官方参考价到原路由字段，
剥离新增组与引用字段；V4 保留公共资料、本地域及原覆盖语义。各版本响应有独立 ETag。
旧服务端仍可返回旧目录，新客户端保留旧格式读取；应先部署服务端再发布客户端。
本次只迁移已有、已核实的价格，不补猜测价格，不改变 XD 的缺价处理。
