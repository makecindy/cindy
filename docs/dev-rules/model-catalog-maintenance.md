# 模型目录：数据归属、更新与验收

> **状态**：权威开发规则（authoritative）
> **读取时机**：新增模型，更新窗口、价格、推理档位、默认值，或排查模型信息显示错误之前

新增模型的支持工作必须覆盖实际运行时的数据源。修改本仓内置 JSON、通过单元测试，
都不能单独证明用户拿到的模型配置已更新。本规则描述客户端与 Server 的职责边界，
不改变根 `AGENTS.md` 的跨仓修改边界。

## 1. 先找数据归属

| 内容                                                             | 应维护的位置                                                                                                               | 客户端职责                                                                                            |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 统一模型目录中的名称、窗口、最大输出、推理档位、参考价及默认标记 | `cindy-server` 的 `model-access-server/catalog/providers.json`；若部署配置了 `MODEL_CATALOG_URL`，还需核对那份远程完整快照 | 同步 `packages/model-providers/catalog/model-registry.json` 作为内置兜底，正确消费实际下发值          |
| Gateway 的实际可用性、路由能力与实价                             | Gateway／Server 对应控制面                                                                                                 | 保留实际路由与价格来源，不用 registry 参考价覆盖 Gateway 实价                                         |
| 请求协议、SDK 字段兼容、能力透传与 token 计量                    | 本仓对应 harness／bridge／host                                                                                             | 根据具体通道能力适配，测试最终请求与用量                                                              |
| 模型原生协议与兼容判定基准                                       | Cindy Registry V3 的 `nativeApi` / `nativeApiRules`，客户端内置补全                                                        | 与 Pi 执行配置、Gateway 路由提示分开维护；结合 Harness 请求协议和实际出站协议判定本地桥接与供应商兼容 |
| Pi 原生模型元数据                                                | Pi 上游与本仓 `tools/pi/sync-model-catalog.mjs`、`catalog/pi-model-catalog.json`                                           | 保留上游原生字段，区分公共 API 与订阅协议，遵守 `pi-harness.md`                                       |
| 旧任务的上下文占比                                               | 客户端历史读取与展示路径                                                                                                   | 正确区分历史快照、当前目录与运行数据；不能用显示特判掩盖源目录错误                                    |

同一模型在公共 API、订阅、Gateway，以及不同 Agent 下的能力可能不同。先列出实际
`provider + agent + model` 路由，再判断哪些字段共用、哪些需要 `perAgent` 或独立条目。
公共 API 总窗口、Codex 默认工作窗口、可选最大窗口、有效窗口和压缩阈值不是同一个值。
参考价也不等于订阅实际扣费；标准／Fast、缓存读／写、长输入分档需分别核实。

公共资料维护在 `baseModels[].defaults`；原接入条目以 `modelRef` 引用公共型号，
`routes[].defaults` 保存供应商默认差异，只有显式 `forceOverrides` 才能纠正供应商实报。
同一 ID/alias 必须唯一；公共模型不继承供应商价格、地址、凭证或成员资格。

## 2. 核对真实发布链路

客户端入口是 `packages/model-providers/src/source.ts` 的 `loadCatalog`，Desktop 由
`apps/desktop/src/main/maker-host/createDesktopProviderService.ts` 装载并刷新活动目录。
公共目录接口为当前配置的 `modelAccessApiBaseUrl` 下的 `/api/model-catalog/catalog`；
还可能存在本地覆盖、上一份有效缓存及旧 OSS 兼容来源。不要仅凭文件名或注释认定当前来源。

- Server 仓库文件是随制品发布的基线。改文件不等于部署完成；配置了远程覆盖源时，
  还必须检查远程源是否会覆盖该基线。Server 的实际行为以其当前代码、部署配置和接口为准。
- 客户端 registry 是带 `updatedAt` 的**完整快照**，不是字段级合并。
  `selectNewerModelRegistry` 会保留较新的有效版本；同 revision 异内容属于冲突。
  新客户端内置快照较新时可以暂时胜出，但不能据此省略 Server 更新：下一份较新的
  Server 快照若仍含错误数据，会再次覆盖回来。
- 发布新快照时，`updatedAt` 必须递增且内容不可变；与本次协同发布的客户端内置版本
  一并核对。价格的 `effectiveFrom`／`verifiedAt` 表达价格生效与核实日期，不能为了
  提升目录 revision 随意改成发布时间。
- 修模型数据时保留用户显式 override，不顺带更换默认模型或默认推理档位。

### 默认思考深度的归属

Registry V4 按字段采用「公共默认 → 供应商/运行时默认 → 供应商实报 → 明确 forceOverrides → 用户覆盖」。
`perAgent` 可声明运行时默认；上游明示的默认优先，缺项才继承。`null` 与空档位保留明确语义；
实际不支持的默认档按共享规则适配，不增加能力。旧 V1–V3 继续保留历史消费语义。
完整契约、JSON 示例和用户文件见 [模型资料优先级](../product-rules/model-metadata-precedence.md)。
用户显式保存的选择和正在运行的任务不随目录刷新被覆盖。

Pi 的 `thinkingLevelMap` 是稀疏映射：标准档位省略时仍支持，`null` 才表示不支持；
`xhigh`、`max` 则需要显式映射。目录导入、客户端目录和启动快照必须共用此解释，
不能把 `Object.keys(map)` 当成完整能力列表，导致默认档被错误替换成更高档。

## 3. 新模型或配置更新的工作顺序

1. **核实通道事实**：查官方模型文档、定价和所用 harness 的实际发现结果；记录来源与
   核实时间，列出 API／订阅／Gateway 的差异。不要只从模型名猜协议或能力。
2. **检查线上现状**：读取目标部署的公共目录，摘录模型条目与 registry revision；同时
   检查客户端活动目录来源、实际路由和 override。检查多个部署时分别记录结果。
3. **分别修改责任侧**：Server 维护发布目录，客户端同步兜底及必要协议／计量适配。
   数据已能解决的问题不新增客户端硬编码；客户端协议缺口也不能靠改目录假装解决。
   需要跨仓配套时，在交付说明中列出对应变更与发布依赖。
4. **做有区分力的回归**：覆盖不同路由窗口、标准与 Fast 价格、缓存与长输入分档，
   以及上游原生元数据优先。涉及显示时覆盖旧任务重新打开、目录刷新、新一轮上报、
   显式长窗口、缺失／歧义来源与 Pi 运行时窗口。
5. **按运行结果验收**：确认部署后公共接口已返回目标条目，客户端实际接受目标 revision，
   再验证选择模型、请求参数和新旧任务显示。只跑本地 fixture、只成功启动登录页、或
   只通过 CI 时，明确记录尚未完成的运行验收，不宣称线上支持已闭环。

### 同步内置兜底时的具体操作

先完成 Server 的目录修正，再把其 `modelRegistry` 整体同步到
`packages/model-providers/catalog/model-registry.json`，保留相同的 `updatedAt` 和内容。
在客户端仓执行以下命令，参数指向已经审阅的 Server worktree 快照：

```sh
node --input-type=module - /path/to/cindy-server/model-access-server/catalog/providers.json <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
const { modelRegistry } = JSON.parse(readFileSync(process.argv[2], 'utf8'));
if (!modelRegistry?.updatedAt || !Array.isArray(modelRegistry.models)) {
  throw new Error('Server snapshot has no modelRegistry');
}
writeFileSync('packages/model-providers/catalog/model-registry.json',
  JSON.stringify(modelRegistry, null, 2) + '\n');
JS
```

原生协议是这条整表同步流程中的独立补全项：兼容 V1/V2 服务端文件，以及尚未填写
`nativeApi` 的 V3 文件。活动目录接受服务端快照后，缺失的原生协议由客户端内置声明补全；
服务端明确声明的协议、`null`（待核实）及 retired 则优先。补全不改窗口、价格、档位或成员资格，
也不从 Gateway 的 `wireProtocol` 或 Pi 的 `piApi` 反推原生协议。

历史 V1–V3 迁移时，先保存并恢复经核实的 `nativeApi` / `nativeApiRules`，
按 route 身份对齐；当时以 V3 格式生成新的递增 revision。此时两份 Registry 不再逐字相等，
应分别核对业务参数与协议补全差异，不能沿用同 revision 却修改内容。服务端以后可在原文件
补写这些字段，无需再维护第二份配置文件。

不要把 Server 的整份 `providers.json` 覆盖到客户端：其中 providers、presets 与 Pi
运行时配置各有消费契约。同步后核对两份 registry 的解析结果完全相等，并检查原有
直连 route 和历史价区间是否丢失。默认模型选择器及用户显式设置不随同步迁移；若离线
兜底中的默认档与当前 Server 已发布值不同，应在交付说明中逐项披露对齐结果。

2026-09-05 对齐发现的典型差异包括：OpenAI 订阅与 XD 路由窗口混用、Sonnet 5 已取消
的涨价仍留在旧兜底、Opus Fast 缓存价缺项、Grok 长输入分档过时，以及 DeepSeek
直连参考价 route 缺失。此类修正先落 Server，再同步兜底，不能再维护两份独立数字。
既有 GPT-5.x 公共 API 长输入参考价仍用于历史／显式长窗口估值，不表示订阅默认窗口
应扩大；Astra 的长输入参考价已于 2026-09-07 核实并补齐；此前未核实的长输入历史价格仍返回未知。

Pi 的原生目录和请求兼容仍留在客户端。删除临时补项前，必须验证随包 Pi 已原生支持
相同模型、协议及参数；仅 Server 新增了该模型，不足以证明可以删除兼容代码。

### 原生协议覆盖验收

2026-09-05 核对[火山方舟流式输出官方示例](https://www.volcengine.com/docs/82379/2123275)：
`doubao-seed-2-1-pro-260628` 可直接调用 `/api/v3/chat/completions`。
Cindy 的 Seed 2.1 Pro 默认协议基准补为 `openai-completions`；这表示默认协议选择，
不表示官方只支持这一种协议（同页也有 Responses 示例）。Gateway 出站仍按实际通道比较。
Server 当前 V2 目录可继续在原文件维护价格与窗口，本地 V3 只补协议；后续完整快照遗漏
协议时仍由客户端兜底，显式 null/retired 保持优先。

协议覆盖检查应遍历全部维护条目的每条 route，并核对实际活动目录中的订阅 wire 别名，
不能只数 JSON 内字段填写率。未知第三方型号保留未知，不能按供应商的兼容 API 反推模型原生协议。

### 默认陈列与完整模型目录

默认开启采用客户端的精简陈列策略：Claude 保留 Fable、Opus、Sonnet、Haiku 四个系列的最新可用款；GPT 保留 Astra/主力、Sol、Terra、Luna 四个系列，Spark、旧代小型变体与特殊长窗口手动开启。其余厂商通常一款；同代同款渠道优先较大折扣，旧版本、实验/预览与显式长窗口变体留在管理页手动开启。
从当前账号实际目录选取，不维护固定型号白名单；新一代主力模型可自动替换默认旧代。
Gateway 先投影原生/兼容引擎与可用性，再选默认型号，不能选中无可用引擎的优惠渠道。
订阅来源按各 Harness 的真实模型 ID 分别投影，用户自建供应商不套这套筛选。

此策略只调整 `defaultEnabled`，不删除型号、不改价格/窗口/协议/请求路由，也不写用户
偏好。用户显式开关永远优先；恢复默认移除偏好后才重新跟随当前目录。服务端下发新型号
与参数的更新流程不变，详情与手动选择仍能使用完整目录。

## 4. 上下文显示错误的排查顺序

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

本轮全目录核对与源侧待办见 [2026-09-07 核对记录](../model-catalog-audit-2026-09-07.md)。


### 型号标准与 Gateway 控制（2026-09-07 用户裁决）

Gateway 下发不是所有模型事实的唯一依据。先对照官方规格、当前原生目录和实际通道，
维护经核实的 Registry。思考档位有两层：Registry 的基础档位描述型号标准；Gateway 的
`efforts` / `perAgent.efforts` 决定该通道当前可以选择的档位。Desktop 投影的 `displayEfforts`
只供展示两者并集，Gateway 目录未声明可用的档位置灰，不进入运行时能力或可发送参数。空数组关闭全部档位，
未知型号不猜档位；服务端放开后正常刷新即可恢复可选。不把订阅 Codex 的 ultra 推给公共 API。
该展示字段不加入 Server Registry schema。实际价格、缓存报价、折扣继续取实时通道，
官方参考价只用于相应参考价入口，不覆盖实价。

Astra / Sol / Terra / Luna 的官方容量为 1,050,000；本地 Registry 分开写模型容量和
Codex / Claude 的 272,000 工作默认，账号原生明确的最大值继续优先。独立 Pi 目录仍按
原生来源，不借公共 API 扩大订阅能力。用户可显式调整工作预算，预算不代表通道承诺。
GPT `[1m]` 是旧窗口预设，退出 Desktop 管理和新选择清单；完整运行目录及历史价保留兼容，
不改收藏、历史模型 ID 或用户已保存的窗口。自定义供应商、Claude / GLM 的真实变体不受影响。

本轮用户明确要求独立核对并整理本地配置，因此客户端先递增整表 revision；Server 同步待办
仍需完成，不能声称线上已经更新。后续 Server revision 应携带这些已核实字段，防止回退。

置灰只能证明当前目录未声明可用，不等于已实测后端拒绝。模型管理页未启用分区始终展开，旧折叠偏好不再隐藏这些型号。
