# 模型公共资料、供应商资料与用户覆盖

架构、文件结构与代码导航先读 [模型配置与下发](../dev-rules/model-catalog-maintenance.md)。
本文是资料优先级、身份和成员语义的正本；发布状态另行核验。

裁决日期：2026-09-08。模型资料按字段合并，最终采用以下优先级（低到高）：

1. `modelRegistry.baseModels[].defaults`：模型公共资料。
2. 供应商/运行时默认资料：匹配的预设模型默认（适用时）→ 接入条目顶层字段 → `routes[].defaults` → 条目 `perAgent`。每一步只覆盖明确填写的字段。
3. 供应商接口明确返回的资料。没返回的字段继续继承默认；不能把客户端合成值当成供应商事实。
4. 匹配路由的 `forceOverrides`：经核实必须纠正的字段，必须填写 `overrideReason`，可填写 `overrideVerifiedAt`（日期）。普通默认值不能暗中强制覆盖供应商。
5. 用户显式配置：自定义供应商表单中的字段，以及本机 `model-catalog-overrides.json`。文件中的公共型号补丁先应用，具体供应商／运行时补丁最后应用。

字段缺失表示继承；`false` 表示明确关闭；数组整体替换，`efforts: []` 表示无可调思考档；`defaultEffort: null` 表示无指定默认档。最终默认档必须适配实际支持的档位，不能凭默认值增加能力。

### 思考强度：模型默认，按需覆盖

标准档位和默认强度只在公共模型维护一套，三个 Harness 默认继承；只有经核实的来源或
Harness 差异才写稀疏覆盖，不为每个 Harness 复制完整默认配置。现有 route / perAgent、
账号实报和用户显式覆盖继续承载这些例外，不能由客户端型号判断自动补档。

`defaultEffort` 表达推荐意图，区别于 `efforts` 的可执行能力。因此它是上述实报优先级的
例外：已配置的模型默认（含明确的 route / perAgent 默认例外）优先于 Harness 实报的
推荐档，缺失才用实报推荐；force / 用户覆盖仍然优先。最后按实际档位适配，不支持时
取不高于意图的最高档，若全部更高则取最低档；不改写公共默认或用户已保存的偏好。

Pi 随包目录的思考档位是缺项兜底，不是账号实报；公共目录刷新必须能替换它。Pi 原生
`thinkingLevelMap` 负责参数转换，例如 `minimal → low` 不代表模型多一个原生档。
活动目录、跨端能力描述与运行配置使用同一份最终档位，投影阶段禁止额外补 `minimal`。
旧版显式用户偏好继续保留，恢复默认通过删除对应 override 跟随公共配置，不写默认快照。
Pi 明确声明的 `reasoningDefaultEffort` 属于 Harness 默认例外，高于公共默认和实报推荐，
低于 force / 用户覆盖；仍按最终可执行档位适配，不能增加能力。

### 其它字段与缺项

继承完成后，已声明路由的模型若仍缺少 efforts，最终可选条目使用 [] / null，不指定推理档位，不因缺项删除模型。该兜底不写回资料层，也不覆盖供应商实报。显式空数组仍表示无可调档；非空档位缺默认时仅从已声明档位按共同规则选默认，不能凭名称猜档位。

图像、视频、音频生成、语音合成、识别、实时音频和向量使用同一 V4 分层。
`mode`、`modalities` 与 `officialDocs` 同样可继承、实报和显式覆盖；模态数组整体替换，
显式空数组不补回。媒体资料不授予账号成员资格，也不能解锁尚未实现的请求协议。
详见 [V4 全类型规范](../model-registry-v4-media.md)。

## 推理能力缺失时的统一规则

裁决日期：2026-09-22；自定义供应商的新代际默认继承于 2026-09-24 按用户定稿修订，见下方专节。
**能力资料与客户端兼容默认分开保存，不把默认值冒充供应商实报。**
本节适用于 Claude Code、Codex、Pi 的模型目录、选择器和实际调用，不因入口或引擎不同另设通用档位。

1. **未知不等于不支持。** 资料层保留以下区别；最终可选条目的兜底值不作为能力事实写回资料层。

   | 原始声明 | 含义 | 继承后的行为 |
   | --- | --- | --- |
   | 缺少推理能力字段 | 能力未知，允许继续继承 | 仍未知则不指定强度，不主动发送关闭思考的参数 |
   | 明确 `efforts: []` 或用户配置 `reasoning: false` | 明确无可调档位 | 保留明确声明，不用低优先级资料补回档位 |
   | 非空 `efforts` | 已声明支持的档位 | 仅提供和发送该范围内的强度 |

2. **不提供通用档位套餐。** 缺少资料时不得补 `low / medium / high / xhigh / max`，
   也不得统一指定 `medium` 或 `high`。兼容 OpenAI 等接口协议只证明请求格式可用，
   不证明模型支持该协议的全部可选参数或档位。
3. **按字段继承并保留来源。** 沿用本文的公共资料 → 接入默认 → 接口实报 → 有依据的强制修正
   → 用户显式配置顺序。缺字段继续继承；明确的 `false`、空数组和 `null` 保留各自语义，
   不被低优先级资料补回。客户端回退值不得冒充供应商实报或用户配置。
4. **默认值不能创造能力。** 非空默认档必须属于有效支持列表；列表已知而默认字段缺失时，
   只按共享默认选择规则从已声明档位中选取。`defaultEffort: null` 保持不指定默认档。
   列表仍未知时最终使用 `efforts: []`、`defaultEffort: null`，请求省略推理强度参数。
5. **展示与请求遵守同一有效能力。** 普通任务、子 Agent、自动任务和辅助调用均按实际目标的
   连接、模型与引擎校验档位。旧任务保存的选择不是能力声明，不能凭旧 `max` 绕过当前校验；
   选择器占位值、父任务档位和 GPT 模板也不能补回未经确认的能力。支持列表为空时不发送强度，
   非空时沿用共享协调规则处理不再受支持的选择；不借此覆盖已保存的用户偏好。
6. **新资料自动生效，用户设置不被覆盖。** 除下述自定义供应商代际继承外，新型号先按未知能力处理；目录或接口补齐资料后，
   沿用现有刷新和继承链恢复已声明能力。不得按型号前缀或名称相似度猜测能力；精确型号、明确
   alias 和既有协议 ID 归一仍按本文身份规则处理。临时回退不落成用户 override，刷新不覆盖
   用户显式设置，也不因缺少推理资料删除模型。

回归验证必须覆盖：缺资料时的三个引擎、无目录与旧版/当前目录、明确空值、接口实报与用户覆盖、
后续资料补齐、旧任务档位的出站参数，以及子 Agent 已有条目/新增模板两条路径。
当前回归入口：
[自定义模型资料继承](../../packages/model-providers/src/__tests__/user-provider.test.ts)、
[原生适配器出站参数](../../apps/desktop/src/main/maker-host/__tests__/piProviderTransport.test.ts)、
[Responses 转发与供应商隔离](../../apps/desktop/src/main/maker-host/__tests__/codexProxyHost.test.ts)、
[Codex 子 Agent 目录](../../apps/desktop/src/main/maker-host/__tests__/codex-smart-subagent-routing.test.ts)。
这些测试各自证明对应路径，不以目录或 UI 测试通过代替实际请求参数验证。

### 自定义供应商的新代际兼容默认（2026-09-24）

用户明确要求新代模型无需逐次更新客户端，导入时自动继承前代配置，并否决额外的“未验证”提示。
因此，自定义供应商（含 Sub2API）允许按同系列、同变体的数字代际继承较旧型号的缺失配置，
不要求上游另行声明代际关系。这是上述第 2、4、6 条在该路径的明确例外，不是供应商能力事实。

- 按数字版本选择较近前代，同代际优先同连接配置；连接候选须保持端点、路径和协议一致。
  Sol / Luna、不同私有命名空间、型号尺寸和日期后缀不得混用，不按任意名称相似度匹配。
- 可继承窗口、输出上限、模态、推理档位及默认值、Fast/工具能力和同协议参数映射。
  型号自身资料、明确实报（含 `false`、空数组、`null`）和用户覆盖仍优先。
- 继承结果参与选择器和实际请求适配，但不写成实报或用户 override；不继承身份、价格、地址、
  凭证、请求头、开关或成员资格，也不新增上游尚未返回的模型，不凭继承创造新传输协议。

实现与回归边界见[运行时细则](../dev-rules/model-catalog-runtime.md#自定义供应商的新代际默认继承)
和[代际继承测试](../../packages/model-providers/src/__tests__/modelGeneration.test.ts)。

## 字段归属与默认值

| 位置 | 允许表达的内容 | 易混淆的边界 |
| --- | --- | --- |
| `baseModels[].defaults` | 跨来源公共资料，字段见 `ModelMetadata` | 不包含价格、defaultEnabled、地址、凭证或成员资格 |
| `models[]` 顶层 | 条目名称、状态、排序、defaultEnabled、窗口等默认资料 | 不存在 `models[].defaults` |
| `models[].routes[].defaults` / `forceOverrides` | `ModelMetadata` 中的资料字段 | 强制修正有原因；参考价另放 referencePrices |
| `models[].perAgent` | 当前 Registry 的 Claude Code / Codex 默认差异 | 与 routes 同级；解析器不接受 Pi，且引擎必须在至少一条 route 中 |
| `providers[].models.pi` | Pi 的显式成员和默认资料 | Pi 的目录成员不通过 Registry agents / perAgent 新增 |
| 用户 `patches[…].perAgent` | 本机具体连接/引擎的用户覆盖，允许 Pi | 不是 Server Registry perAgent 的 schema |
| 客户端 `CatalogModel.contextWindowMax` | 从供应商/Registry资料保留的容量投影 | 不能填进 Registry defaults；运行时可用预算和压缩阈值另算 |

允许字段以 [ModelMetadata](../../packages/model-providers/src/modelMetadataLayers.ts) 和
[实际解析器](../../packages/model-providers/src/modelAccessValidator.ts) 为准，类型声明不能替代校验。
可运行示例见 [配置示例](../examples/model-catalog.md)。

## 数据结构

### 多连接的身份与隔离

同一种供应商可以有多个账号或 API 连接。沿用 `providerId` 标识连接实例，
`model` 标识该连接下的上游模型，`agentKind` 标识执行 Harness；调用目标由三者
共同确定。供应商与模型的显示名可以重复，也可以改名，不用于路由、凭证查找或持久化关联。
不新增模型接入 ID，不要求模型 ID 在所有连接间全局唯一。

OpenAI 本机 Codex 登录与独立授权账号共享 OpenAI 公共目录及桥接规则；
`providerCatalogId` 仅用于公共定义查找。凭证、发现快照、限额、具体连接的价格及窗口覆盖、
收藏与可见性继续使用连接实例 ID。三个 Harness 的公共模型资料与接入声明由服务器目录维护；
客户端原生目录只补旧快照缺失字段及运行时兼容细节，不能作为第二份公共模型白名单。
对使用 Registry 补存在性或 additions-only 的发现路径，未返回某个模型不等于禁止。不能把此结论推广到权威成员快照；按下面的来源表判定。

现有协议保留两种兼容表示：Codex/Claude Code 的 Registry 根与桥接声明，及
`providers[].models.pi` 的逐 Harness 声明。旧 Registry 的 agents 枚举不能直接加入 Pi；
顶层 Codex/Claude Code 空数组仍由 Registry 实体化，不能解释成关闭。
Pi 显式列表提供公共成员（包括空数组与退役条目）；缺字段才使用随包兜底。订阅账号
发现的新型号同样进入 Pi，沿已有订阅传输执行，不要求先登记到 Pi SDK。显式空 Pi 列表
仍关闭该公共入口，退役条目不由发现复活。Codex／Claude SDK 的发现只补 Pi 缺少的型号，
不覆盖已有 Pi 型号的原生能力；SuperGrok 账号实报能力供三个 Harness 共用，按连接隔离。
服务器声明的新模型不要求先出现在 Pi SDK 名单中；有明确原生协议
即可构造 models.json。OpenAI 订阅仍使用专用 Codex Responses 认证传输。

旧顶层 Pi 条目的静态资料是旧格式兜底，不能标为账号 discovery；
Registry 的公共定义／显式条目／路由／perAgent 继续覆盖旧默认，账号实报与用户覆盖另行优先。
已解析的名称、窗口、输出上限、档位、输入能力和价格必须进入实际运行配置。
原生同协议的 compat、header、sampling 仅补实现细节；换协议不复用旧 serializer 的参数。
用户自定义连接及 Pi 原生扩展继续保留，不由公共目录撤下其模型。
缺少某 Harness 路由时界面说明“尚未配置”，不声称上游明确不支持；没有真实路由不生成
可发送候选。未连接、未安装及付费状态继续使用各自现有状态。

任务、定时任务和辅助调用保存完整调用目标；明确选中的默认供应商也保存其连接 ID。
旧数据中未指定连接的记录继续解析默认来源。显式连接断开、删除或不再提供模型时，
来源解析返回不可用，不能把另一个账号显示为当前账号；用户已开启的运行失败自动切换
仍按原设置执行。运行中任务保留停用／退役模型的实际来源展示。

Pi 已识别的 OpenAI 订阅连接之间可复用同一运行时：每个账号必须有独立原生路由，
主代理与子代理在原生切换确认后同步身份。回合中切换延迟到回合结束；启动快照没有
目标路由时保留原来源、历史与待发消息，不静默改用其他账号。其他凭证形态仍按原保护处理。

已有同 Harness、同模型共享的思考档位／Fast 偏好仍保留，恢复时按目标连接实际能力校正；
这些操作偏好不承载账号身份。新增供应商登录适配时应复用上述连接机制，登录协议、
限额接口及 Harness 执行能力仍需分别适配。

公共字段范围是名称、说明、分组、上下文、最大输出、思考档位、默认档、Fast 与图片输入能力。Fast 通常是供应商能力，应放在路由默认值中。价格、余额、账号可用性、模型成员、协议、地址和凭证不通过公共模型继承。Registry V5 将厂商参考价独立放在公共型号的 `referencePriceGroups`，不进入 defaults 字段继承。供应商可单独提供路由报价；订阅按厂商参考价估算，用户显式价格覆盖仍优先，实价仍来自计费控制面。

`modelRef` 只引用明确的公共型号；aliases 必须在整表唯一。新供应商没有专属条目时，仅在精确公共 ID 或明确 alias 匹配后继承公共资料。不剥任意前缀、不用模糊名称猜型号，也不继承另一供应商的强制修正。订阅桥接已有的 ID 归一规则继续适用。

保留现有 entry、provider、上游 model ID 和 `[1m]` 变体。一个模型可以同时有本地包装与云端接入，共用 `modelRef`；本地量化标签、包装体积、运行内存、平台限制、推荐证据仍留在 `localModels`。不同权重或不同版本不能仅因名字相似而共用型号。

## 模型成员、空列表与失败

这张表讨论“型号是否在名单内”，不改变前面的资料字段优先级。成功空数组、字段缺失和读取失败是三种状态。

| 来源/字段 | 缺失或尚无有效发现 | 明确空数组或未返回型号 |
| --- | --- | --- |
| OpenAI / Anthropic 订阅的 Registry 根与发现补全 | 按对应静态/Registry 路径保留存在性，连接态另判 | 发现未返回不单独构成否定；不能用顶层 Codex/Claude 空数组禁用 Registry 实体化条目 |
| 通用 OAuth additions-only、自定义连接刷新 | 保留已有配置 | 只新增/更新，不因本次未返回而删除已有成员 |
| xAI 订阅账号权威发现 | null 表示尚无成功账号快照，走既有静态兼容路径 | 成功空数组也是账号成员快照；不能套 additions-only 规则。Pi 同时使用该账号发现及公共声明 |
| `providers[].models.pi` | 字段缺失才使用随包声明 | 显式 [] 不回填；非空声明允许账号发现补新型号，退役项不复活 |
| 内置非 Gateway 的媒体数组 | 字段缺失、允许 Registry 派生时才由媒体 routes 补成员 | 显式 [] 不由 Registry 或发现结果复活；非空列表不由 Registry 增补成员，后续账号发现按下一行处理 |
| 已接入的图片/视频账号发现 | 没有发现快照时用静态/远端声明 | 成功快照限定该发现路径的成员，不能绕过目录显式禁用；不推广为全部音频或自定义刷新规则 |
| Gateway 实时 `/models` | 未取得权威响应时保留未知/回退证据标记，不凭缺席下结论 | 成功清单拥有实时成员、可用性和实价；Registry 不增加 Gateway 成员 |
| `modelRegistry.localModels` | 整个本地域缺失时用随包本地域 | 显式空 models 撤下候选；空 featuredIds 撤下推荐；不删除本机已安装模型 |

发现失败不能伪装成成功空列表。缓存保留、清空与账号切换由各发现适配器控制，不能统一用一个空数组处理。
实现入口：[活动目录](../../apps/desktop/src/main/maker-host/active-catalog.ts)、
[媒体投影](../../packages/model-providers/src/providerMediaModels.ts)、
[自定义发现合并](../../packages/model-providers/src/modelMetadataLayers.ts)。

## 用户文件与恢复默认

文件位于当前账号的用户数据目录，沿用已有 `model-catalog-overrides.json`，不上传到服务器。以下示例只保存用户修改的字段：

```json
{
  "version": 1,
  "baseModels": { "maker/model": { "name": "我的显示名" } },
  "patches": {
    "supplier:model": {
      "base": { "contextWindow": 32000, "supportsImageInput": false },
      "perAgent": { "pi": { "defaultEffort": null } }
    }
  },
  "localModels": {
    "featuredIds": [],
    "patches": { "qwen38-27b": { "name": "我的本地模型" } }
  }
}
```

`baseModels` 是按公共 ID 的稀疏补丁；`patches` 支持已有订阅、Cindy AI、自定义供应商模型及 Pi。补丁不能凭空增加账号可用模型，尚未出现的条目静置。`additions` 适用于已实现传输的订阅连接，包括 Pi；显式 `agents: ["pi"]` 只新增 Pi 型号，未指定 agents 时完整公共配置也用于 Pi。旧的仅根引擎字段完整的配置仍按原方式加载。新增沿连接原有协议和凭证执行，不开放 Gateway 伪造，也不改用户自定义供应商的配置方式。退役条目仍需完整合法 addition 才能复活。

键中的供应商段使用 `encodeURIComponent` 编码，模型段保持原文。例如旧自定义 xAI 的运行时 ID 是 `custom:xai`，对应键为 `custom%3Axai:grok-model`；`xai:grok-model` 仍指内置 xAI，`custom:xai:grok-model` 仍指供应商 `custom` 的模型 `xai:grok-model`，三者不混用。

`localModels` 支持 `patches`、完整 `additions`、`removedIds`、`featuredIds`；空推荐数组明确不推荐任何模型。名称和包装仍需通过本地域校验，不能下发命令、路径或下载 URL。删除补丁或对应字段就是恢复继承，远端刷新不会写回或删除这些用户字段。

自定义供应商的接口结果单独保存在 `discoveredMetadata`；表单只持久化用户显式设置。旧数据缺少来源标记时保守保留旧名称和窗口，不猜测用户意图。刷新供应商信息会更新发现快照，不把发现值转成用户 override。
从预设新建时只保存 `catalogPresetId` 引用；模型默认资料读取当前目录，接口结果仍单独记录。
预设地址与协议仍按创建时配置保存。继续继承需要 catalogPresetId 命中，runtime 地址（忽略尾斜杠）、
补默认后的协议、requestPath 及型号 ID 匹配，型号自己的 route 地址/协议/path 也一致。
用户换端点或路由后停止继承该预设默认，但仍可按精确公共型号继承公共资料。
预设刷新不重写用户连接地址、协议或显式配置；继承条件由 `buildUserProvider` 判定。
旧连接已有的显式快照不自动转为继承。官方 API 入口没有同名服务端预设时，仍通过精确型号匹配读取公共资料；不把入口中的提示值保存成用户覆盖。

## 发布、兼容与验证

发布遵循 [维护入口](../dev-rules/model-catalog-maintenance.md#release)，同为 V4 仍须满足 [媒体扩展发布前置条件](../model-registry-v4-media.md#发布前置条件)。

Server `catalog/providers.json` 是数据正本；客户端 `catalog/model-registry.json` 是同 revision、同内容的离线副本。`baseModels`、模型引用和本地域必须随整个 Registry 一起校验、发布和同步，禁止只复制子域造成悬空引用。坏快照、网络失败、回退 revision 和同 revision 冲突沿用上一份合法快照。

复用当前目录接口与 Registry V4 协商，不增加请求或数据库表。旧 V1/V2/V3 客户端收到展开后的旧字段；不同资料的多条路由在兼容响应中拆成独立条目，保留上游 ID，额外条目使用派生目录 ID。旧协议不支持的公共引用、覆盖指令与图片字段被移除，空默认以缺省表达。

供应商总容量与客户端工作预算分开：既有 GPT 272K 工作预算继续保留；这里的 `contextWindowMax` 指客户端 CatalogModel 投影，不是 Server 字段。Registry 资料中的 contextWindow 与合法 perAgent 工作默认分别维护；用户显式窗口覆盖仍优先。协议和实际执行能力门禁继续由运行时负责，元数据不能解锁未实现协议或伪造可售性。

验收至少覆盖缺字段继承、供应商优先、force 修正、用户最高、显式 false/null/空数组、未知供应商公共识别、刷新与保存、旧版解析、离线与坏快照回退。模型推荐标准另见 [本地模型筛选](local-model-selection.md)，仍只按能力、速度和实际运行内存筛选。
