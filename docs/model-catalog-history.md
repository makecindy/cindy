# 模型目录历史取舍与迁移记录

> 参考记录，不是当前配置或部署状态。当前维护规则见 [模型配置与下发](dev-rules/model-catalog-maintenance.md)。
> 下列文字记录各批次当时的事实，不能相互当作后续状态的证明。引用时须带日期、来源和验证范围。

## 第三方预设与服务端对齐（2026-09-26）

依据各厂商官方文档（2026-09-26 核对）处理下线、别名与不存在的型号，并以线上服务端推荐清单为基础
与客户端对齐（连接设置沿用客户端的原生协议地址）：

- 百炼 Token Plan：`qwen3.8-max-preview` 已下线（旧 id 路由到 `qwen3.8-max`），改为 `qwen3.8-max`；
  按官方清单补 Qwen3.8-Flash、DeepSeek-V4.1-Flash、GLM-5.3；团队版删去 10-10 下架的 DeepSeek-V3.2。
  Coding Plan 改为官方推荐的 Qwen3.7-Plus、Qwen3.6-Plus、Kimi K2.5、GLM-5、MiniMax-M2.5，保留两个 Coder。
  窗口取官方最大输入，默认开思考的型号取思考模式最大输入（Qwen3.x 为 983,616）。
- GLM Coding Plan：官方只支持 `glm-5.3`、`glm-5.3-flash`，5.2/5.1 已路由到 5.3；Claude Code 用官方
  `[1m]` 写法，删去文档中不存在的 `glm-5.2[1m]`。
- DeepSeek：`deepseek-v4-flash` 为临时别名，改用官方推荐的 `deepseek-flash`（1,048,576，支持图片）。
- OpenCode Go：MiMo V2.5 于 2026-10-21 下线且无转发，改为 MiMo-V2.6-Pro / Flash，并补兼容层配置。
- OpenRouter：删去平台上不存在的 `qwen/qwen3.8-max`。
- Kimi Code：`api.kimi.com` 为国内地址、`api.kimi.ai` 为海外地址，均为官方地址，不改。
- Codex 桥接图片白名单补上官方确认支持图片的 Kimi（Moonshot / Kimi Code）与 Qwen 型号。
- 客户端 Registry revision 为 `2026-09-26T12:00:00.001Z`：服务端 `2026-09-26T12:00:00.000Z` 不含
  客户端独有、需先随客户端发布的 Grok 4.7 Fast（#5060），两份内容不同故使用不同 revision。

## 订阅默认只显示最新一代（2026-09-26）

客户端离线 Registry revision 更新为 `2026-09-26T12:00:00.000Z`。GPT 订阅默认只显示
GPT-6 Sol / Luna / Astra，GPT-5.6 Sol / Terra / Luna 标记 `defaultEnabled: false`；
Claude 订阅默认显示各系列最新版 Opus 5.5、Fable 5.1、Sonnet 5、Haiku 4.5、Mythos 5，
Opus 5、Fable 5、Opus 4.8 标记不默认显示。所有与订阅或其他供应商共用条目的 XD 路由
（Claude 9 个、DeepSeek V4 Pro/Flash、GPT-5.4 Nano，共 13 个）拆为独立 `xd/*` 条目，
沿用改动前的显示设置；对比 50 条 XD 路由的解析资料，拆分前后无差异。
用户已有显示开关不变。Server 正本需同步同一改动后才会下发。

## GPT-6 Sol / Luna 与 Claude Opus 5.5（2026-09-23）

客户端离线 Registry revision 更新为 `2026-09-23T00:00:00.003Z`，新增
`openai/gpt-6-sol`、`openai/gpt-6-luna`、`anthropic/claude-opus-5-5` 公共资料和官方接入路由。
保留既有型号、参考价历史及用户已选型号；不新增未经实报的 XD 路由。
沿用最新家族成员推荐规则，Claude Code 的 Opus 推荐项会从 5 自动更新为 5.5。

依据 [OpenAI 发布记录](https://developers.openai.com/api/docs/changelog)、
[Sol 规格](https://developers.openai.com/api/docs/models/gpt-6-sol)、
[Luna 规格](https://developers.openai.com/api/docs/models/gpt-6-luna)、
[Opus 5.5 规格](https://platform.claude.com/docs/en/models/opus-5-5/overview)，
三个型号均于 2026-09-22 发布，支持文本/图片输入、文本输出和 128K 最大输出。
GPT 容量为 1,050,000，Claude 为 1,000,000；GPT 的 Claude Code / Codex 工作默认仍为 272,000。
三者均登记 low / medium / high / xhigh / max，默认 medium；GPT 官方另支持 none，
但现有 Registry effort 枚举不能表达，本批不扩展协议，也不把 none 错映为 minimal。
GPT 原生接口采用 Responses，避免 Chat Completions 在非 none 档位下不支持工具调用的限制。
Opus 5.5 的 adaptive thinking 始终开启，不能发送 disabled；Responses→Anthropic 桥沿用
已有 always-on 处理，显式关闭降到 low，并保留 xhigh 参数；真实引擎调用仍需验证。

参考价依据 [OpenAI 定价](https://developers.openai.com/api/docs/pricing)与
[Claude 定价](https://platform.claude.com/docs/en/about-claude/pricing)，核验日 2026-09-23，
生效日 2026-09-22。每百万 tokens 标准输入/输出：Sol $2/$10，Luna $0.10/$0.50，
Opus 5.5 $4/$20；包含缓存读写、Claude 1h 写入、标准/Fast 价格及 GPT 的 272K 分档。
Claude Fast 参考价不等于订阅账号具备 Fast 权限，本批不强制开启该能力。

配套 Server PR 同步三个型号的完整公共资料/路由/参考价，并补 Pi 显式成员。
后续收口将此前仅在客户端的 13 个公共型号、8 个媒体接入条目及 Cyber 能力补项并入
Server 正本，两端完整 Registry 内容与 revision `2026-09-23T00:00:00.003Z` 一致。
客户端目录请求新增 `registryMedia=1`（见 [媒体发布前置条件](model-registry-v4-media.md#发布前置条件)）。
服务端仅向明确支持媒体扩展的 V4/V5 请求返回完整正本；无标识或未知标识保持更新前的
固定兼容快照及其 revision，避免不完整的新版本整表覆盖旧客户端内置媒体资料。
旧兼容快照不继续加型号、抬 revision；后续维护只更新完整正本，再同步客户端离线副本。
旧模型与价格均保留；两端修改与生产部署须分别核验。
尚未发布或验证账号调用。
核对 Global 公共接口 `/api/model-catalog/catalog?registrySchemaVersion=5` 时，线上 revision 为
`2026-09-22T00:00:00.000Z`，三个新公共型号均缺失。合并部署后还需验证实际下发；
Pi 成员沿服务端显式列表/账号发现，不复制订阅名单到公共 API。客户端离线 Pi 快照仍由
固定版本上游生成，本次没有伪造上游生成数据；新型号可由服务端目录或账号发现补入。

## 小米 MiMo V2.6 系列（2026-09-22，同日第一批）

客户端 `catalog/providers.json` 两个 MiMo 预设（`xiaomi-mimo-api-cn` / `xiaomi-mimo-token-plan-cn`）
的推荐模型清单从 V2.5 系列替换为 `mimo-v2.6-pro` / `mimo-v2.6-flash`（api 预设的 Pi 另含
`mimo-v2.6-pro-ultraspeed`）；Pro / Flash 均声明 Pi 图片输入。V2.5 系列官方公告于
2026-10-21 10:00（北京时间）下线，从推荐清单移除；未删除用户已有连接、开关或历史模型 ID，
下线前仍可经列模型发现手动添加。

依据 [官方模型列表](https://mimo.mi.com/docs/zh-CN/quick-start/summary/model)与
[API 定价](https://mimo.mi.com/docs/zh-CN/price/pay-as-you-go)（核验日 2026-09-22）：
Pro / Flash 为原生全模态（文本、图像、视频、音频输入）+ 深度思考，上下文 1M、最大输出 128K；
UltraSpeed 为定制服务，同窗口/输出。按量定价与前代持平：每百万 tokens 输入/输出
Flash ¥1/¥2、Pro ¥3/¥6、UltraSpeed ¥30/¥60；缓存命中另价（Pro ¥0.025、Flash ¥0.02），
缓存写入限时免费；预设模型不携带价格字段，实价继续走实报与参考价发布链。

本批（同日第一批）仅改客户端预设推荐名单（`providers.json` 的 `presets[].runtimes`，手
维护，不被 `pnpm sync:pi-model-catalog` 重写）。当时 Registry 尚无 MiMo 公共条目；同日
第二批已补 Registry 公共条目（客户端 revision `2026-09-22T00:00:00.002Z`，见下条），
勿以本句判断当前同步状态。未改 Server 正本；Pi 上游目录（pi.dev）核验日仍为 V2.5
系列，`provider-models.json` 待上游更新后再同步。OpenCode 渠道的 MiMo 逐模型证据与
`upstream-profiles.json` 的 opencode-go 档位映射本次未动（无 V2.6 实证）。

## 小米 MiMo V2.6 能力配置补齐（2026-09-22，同日第二批）

修复会话反馈的两个配置问题：Cindy 套用通用推理档位、把 `reasoning_effort: "max"` 发给
MiMo 2.6 Pro 被 400 拒绝；Pi 的 `mimo-v2.6-pro` 被标成仅文本输入、带图消息被本地拦下。

- 能力依据：官方「深度思考」文档（`thinking.type: enabled|disabled`，开/关开关、默认开，
  参数走 `extra_body`）+ 2026-09-22 客户端对照实测（同账号同接口同短消息：
  `reasoning_effort: "high"` → 200、`"max"` → 400、省略 → 200）。MiMo 的深度思考不是
  OpenAI `reasoning_effort` 档位模型。
- `model-registry.json`（客户端 revision `2026-09-22T00:00:00.002Z`，Server 正本待同步）：
  新增 `xiaomi/mimo-v2.6-pro` / `xiaomi/mimo-v2.6-flash` / `xiaomi/mimo-v2.6-pro-ultraspeed`
  公共条目与接入条目（nativeApi `openai-completions`，routes 覆盖 `xiaomi-mimo-api-cn` /
  `xiaomi-mimo-token-plan-cn` 两个 CN 预设，UltraSpeed 仅 API 按量渠道）。公共资料如实声明
  `efforts: []` + `defaultEffort: null`（深度思考只有开/关、无档位；缺资料不发伪档位，
  让供应商默认行为决定）；Pro/Flash 按官方全模态声明 `supportsImageInput: true`，
  UltraSpeed 能力未公开保持未知；窗口 1M、最大输出 128K。
- Registry 公共资料按 model id/alias 合并进所有连接（含存量自定义连接，用户显式配置仍
  优先）：存量连接上这两个问题无需用户改配置即修复；若用户手动覆盖过档位或图像能力，
  需自行清除覆盖才会回到公共资料。
- 参考价只记已核实的官方按量付费标准价：中国大陆（CNY）Pro ¥3/¥6（缓存命中 ¥0.025）、
  Flash ¥1/¥2（缓存命中 ¥0.02）、UltraSpeed ¥30/¥60（缓存命中 ¥0.25）；海外（USD）
  Pro $0.435/$0.87（命中 $0.0036）、Flash $0.14/$0.28（命中 $0.0028）、
  UltraSpeed $4.35/$8.7（命中 $0.036）。两组均出自官方计费页「按量付费」实时推理表
  （同页国内/海外两表，单位分别为元/美元每百万 tokens），2026-09-22 核验。缓存写入限时
  免费未记；批量推理（半价）等其它计费项未收录，与国内组口径保持一致。
- 在线生效性核验（2026-09-22，#4865 review 跟进）：Server 正本 `catalog/providers.json`
  当前 12 个预设无任何 `xiaomi-mimo-*`（两处 Server 仓只读核验、全文零命中）；
  `mergeWithBundled` 对无同 ID 远端的 bundled 预设原样采用，故 V2.6 推荐名单在线
  同样生效，不是只有离线兜底。Registry 整份快照按 revision（`updatedAt` instant）
  比较，Server 当前 `2026-09-22T00:00:00.000Z` 低于客户端 `.002Z`，随包 Registry
  （含 MiMo 公共条目）胜出，两个修复在线生效。Server 同步待办的实义是防将来反遮：
  一旦 Server 上线同 ID 预设或更高 revision 快照即远端优先，需把本批内容并入
  Server 正本。生产部署态未直连核验，以 Server 正本仓为源。
- 预设模型行（pi）保留 `supportsImageInput: true`（新连接快照；cc/codex 行不攃能力
  字段，由 Registry 公共投影供片）；不把推理档位写进预设模型，
  免得旧快照盖住 Registry 后续修订。V2.5 推荐清单下架事项见前一条记录。

## Grok 4.7 / Pi（2026-09-22）

新增 `xai/grok-4.7` 公共资料、Claude Code / Codex 路由及独立 Pi 成员 `grok-4.7`。
三个引擎均提供 low / medium / high / xhigh，默认 high；旧型号、用户覆盖和既有任务不迁移。
Pi 沿用 Responses 与现有模型装配，不升级二进制。通用供应商生成器补缺该型号，后续上游
已有同 ID 时保留上游定义，显式合法默认档在转换中保留。

依据 [官方模型说明](https://docs.x.ai/developers/grok-4-7)（核验日 2026-09-22）：
500K 上下文、文字与图片输入，无独立文本输出限制，公共 Registry 不声明 maxOutputTokens。
Pi 需要有限 maxTokens，因此以共享
窗口 500K 为上限，实际请求仍按输入占用裁剪；不是额外承诺 500K 输入加 500K 输出。
[参考价格](https://docs.x.ai/developers/pricing)按 200K 输入分档，USD/MTok 的输入/缓存读/输出
分别为 2/0.5/6 和 4/1/12；Pi 的严格大于阈值写成 199999，对齐 Registry 的 >=200000。
Fast 未进入公共 API 目录。Pi 成员的 cost.tiers 随目录下发，Desktop 装配时完整保留分档。

Server 本次 revision 为 `2026-09-22T00:00:00.000Z`，客户端为同日 `.001Z`：延续既有
快照差异，客户端此前多出 13 个公共型号、8 个接入条目，另有一处公共思考能力补项。
本次只同步 Grok 4.7 的完整公共定义与接入条目，保留两侧既有数据，不伪造整表同版本一致。
其余差异尚未整表归并；本次修改不能宣称已完成所有模型目录的统一。

本地验证包括 Pi 0.85.1 真二进制接模拟 Responses 服务：图片、工具调用、四档参数、恢复
历史后的加密推理状态和稳定缓存键。Server 的 V1–V5 投影分别验证路由、默认档和价格。
这些是本地验收，不代表真实 SuperGrok 账号准入、付费生成或生产部署。

## 价格与缓存写入计量核对（2026-09-11）

本轮遍历 Registry 及 Pi 目录的价格来源，同时读取 Global / CN 的匿名网关模型目录。
服务端正本与客户端同步修改 32 个型号的 44 条 route，参考价记录从 69 条增加至 116 条。
新增记录从 `2026-09-11` 开始采用，表示本目录首次核实并采用该参考快照，
不宣称厂商当天调价，不倒填未知历史；已知历史区间保留。媒体扩展仍遵守本页下节的
不同快照 revision 约束。配置和测试结果不表示生产已部署。

| 已修复项                                                   | 依据与边界                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GPT-5.4 Pro / 5.5 Pro、Cyber、Fable 5.1 缺参考价           | [5.4 Pro](https://developers.openai.com/api/docs/models/gpt-5.4-pro)、[5.5 Pro](https://developers.openai.com/api/docs/models/gpt-5.5-pro)、[Cyber](https://developers.openai.com/api/docs/models/gpt-5.6-cyber)、[Claude 定价](https://platform.claude.com/docs/en/about-claude/pricing)。Pro 5.5 无缓存读折扣，按普通输入价；不猜写价。                        |
| Sol / Terra / Luna 缺 Fast 及其长输入档                    | [OpenAI Fast 表](https://developers.openai.com/api/docs/pricing)；覆盖 Sol 旧 1M 路由。标准价和 Fast 分开，保留旧价格。                                                                                                                                                                                                                                          |
| MiniMax M2 / M2.1 / M2.5 / M2.7 及 highspeed 的 API 参考价 | [中国区](https://platform.minimaxi.com/docs/guides/pricing-paygo)与[国际区](https://platform.minimax.io/docs/guides/pricing-paygo)分别采用 CNY / USD，不用汇率推导，也不将 API 价当成 Coding Plan 扣款。                                                                                                                                                         |
| Kimi K3 / K2.7 Code / Highspeed 国内国际、K2.6 官方参考    | 官方动态表经浏览器实际读取：[国际 K3](https://platform.kimi.ai/docs/pricing/chat-k3)、[中国 K3](https://platform.kimi.com/docs/pricing/chat-k3)、[国际 Code](https://platform.kimi.ai/docs/pricing/chat-k27-code)、[中国 Code](https://platform.kimi.com/docs/pricing/chat-k27-code)、[K2.6](https://platform.kimi.ai/docs/pricing/chat-k26)。不改 Coding Plan。 |
| GLM 5.1 / 5.2 / 5.3 / 5.3 Flash、Qwen3.8 Flash 中国区参考  | [Z.AI USD](https://docs.z.ai/guides/overview/pricing)、[阿里云北京 CNY](https://help.aliyun.com/zh/model-studio/model-pricing)。GLM 中国区和 Qwen 国际部署价格不互相套用。                                                                                                                                                                                       |
| Gemini 3.5 Flash、3.5/3.1 Flash-Lite 缺文本参考价          | [Google 定价](https://ai.google.dev/gemini-api/docs/pricing)。3.1 Lite 音频单价不同；3.6/3.7 的 token·小时存储费原误放入 `cacheWrite1hPerMtok`，已移除，不能按一次写缓存计费。                                                                                                                                                                                   |
| DeepSeek V4 Flash 的旧别名价已变                           | [当前官方定价](https://api-docs.deepseek.com/quick_start/pricing/)确认旧别名由 V4.1 Flash 服务，采用峰值参考价 input 0.30 / output 1.20 / read 0.006 USD/MTok。原峰值价保存为截止本次核验日的历史区间。                                                                                                                                                          |

xAI 当前文本价的短／长输入边界与[官方表](https://docs.x.ai/developers/pricing)一致；
现有 OpenAI 标准价、Astra Fast、Claude 已有标准与 Fast 价保持。不能把 OpenAI 页面先出现的
Batch / Flex 半价表误当 Standard。Pi 固定 xAI cost 与短档相符，其余依赖原生目录的
缺字段不等于免费，不写静态零值。

Codex 原生 `inputTokens` 包含读缓存和写缓存子集，实时解析已正确拆桶；丢失发生在
`done` 汇总。现在增加可选 `cacheCreationTokens`，贯通消息明细、模型日账本、今日总量
与费用映射；旧事件缺字段按零兼容。四个桶都与请求分段一致才允许计价；第二次仅补费用的
写账保持全零 token，避免重复累计。请求与 system prompt 不变；验证使用真实处理函数的
模拟事件重放，未用付费模型调用或生产账单作验收。

### 仍需证据或更细合同的价格

- XD 实价来自 Gateway `/models`，Registry 的官方参考价不能回填。Global 当次 30 个模型中
  有 12 条具备缓存读价但缺写价（Luna / Sol / Terra、Gemini 3.5–3.8 Flash、Muse Spark 1.3、
  Kimi K3、Grok 4.5 / 4.6、GPT Image 2）；CN 当次 20 个模型中为 Kimi K3，未列 Luna。
  “有读无写”仅是待核对集合，不证明这些模型都应单独收写入费。
  Server 已保留标准 `cacheCreationInputTokenCost` 及 tier 同名字段；需拿到上游价表正本或
  原始 `/model-groups` 响应，才能区分上游缺价与未支持的字段形式。
- Cyber 型号页说明长输入倍数，但[总价表](https://developers.openai.com/api/docs/pricing)长档为 `-`。
  暂只提供不超过 272,000 输入的短档，超出范围不计参考金额，不把短价延长或当免费。
- MiniMax M3 的 512k、Qwen3.6/3.7 的 K 分档，尚未找到足以确认精确整数边界的官方说明。
  不用上下文容量推断计费单位。Qwen 国际部署地区、GLM 中国区当前收费也尚未确认。
  GPT-5.5 Auto、Muse、HY、Seed 等 XD-only 型号仍取通道实报，不凭相似型号补官方价。
- DeepSeek 参考价按峰值口径；当前日历日期合同不能表达每周峰谷时段或官方预告
  9 月 14 日北京时间 12:00 的 Pro 别名切换，发布时需再次核对，不能当精确账单。
- 缓存一小时写入与按小时存储不同；Qwen 显式／隐式缓存、媒体按张／秒／字符收费、
  工具调用等不能塞进通用 token 写价。缺乏用量维度或报价时继续保留未知，不能写零。

## 公共思考档位核对（2026-09-11）

遍历 94 个公共型号，区分分级思考、仅思考开关／预算、媒体以及资料未知。
本批次同步补全服务端正本和客户端离线 Registry 的 9 个公共条目；生产下发仍需单独验收，
不能把配置同步或测试通过视为已上线。

服务端保留已发布的 Registry 形状，客户端媒体扩展依照
[媒体目录发布前提](model-registry-v4-media.md)继续仅存在于离线副本，未随本次同步下发。
两份完整快照因此采用不同 revision；本批次公共档位和 GLM 路由默认一致。

| 公共型号                                 | 档位                              | Cindy 默认 | 官方依据                                                                                                                                                   |
| ---------------------------------------- | --------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GPT-5.6 Sol、Luna                        | low / medium / high / xhigh / max | medium     | [Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol)、[Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna)                       |
| GPT-5.4 Pro、5.5 Pro                     | medium / high / xhigh             | medium     | [5.4 Pro](https://developers.openai.com/api/docs/models/gpt-5.4-pro)、[5.5 Pro](https://developers.openai.com/api/docs/models/gpt-5.5-pro)；原先误填空数组 |
| Gemini 3.1 Flash-Lite                    | minimal / low / medium / high     | medium     | [Google 型号对应表](https://ai.google.dev/gemini-api/docs/gemini-3?hl=zh-CN)；该旧版指南仍明确列出此型号                                                   |
| GLM-5.3-Flash（z-ai 与 xd 两条公共定义） | low / high / max                  | high       | [发布者模型卡](https://huggingface.co/zai-org/GLM-5.3-Flash#note)；现有 Coding Plan Pi 预设也已采用这三档                                                  |
| Qwen3.8 Flash                            | low / medium / xhigh              | medium     | [官方 API](https://www.alibabacloud.com/help/en/model-studio/qwen-api-via-openai-chat-completions)；原先误填空数组                                         |
| Qwen3.8 Flash-Next                       | low / medium / xhigh              | medium     | [发布者模型卡](https://huggingface.co/Qwen/Qwen3.8-Flash-Next#api-usage)；本地包装是否提供相应参数仍由运行时决定                                           |

默认值沿用 Cindy 的 medium 优先策略；没有 medium 时选 high，不能将官方默认
minimal / max / xhigh 自动变成 Cindy 默认。GLM 的公共默认采用合法的 high，原先 XD 的
medium 意图移到 XD route.defaults，保留既有中档裁决；该路由同时保留两区域
[实时网关](https://model-access.cindy.app/api/model-access/models?schemaVersion=5)已明确支持的
low / medium / high / max，实际能力仍以实报为准，不把兼容 medium 上提为公共档位。
此次不扩展 schema 中尚未表达的 none／no_think。

公共档位不取 route／perAgent 的并集：保留 Sol 旧 1M 路由的四档、Codex 特有 ultra，
以及 Seed／GLM 的引擎差异；不将其上提为公共能力。已配置的兼容映射档位不在本轮删除。
思考档位这一步不调整模型成员、窗口、价格、协议、本地推荐或用户覆盖；随后授权的价格审计见上节。

两区域公开目录核对时 revision 为 `2026-09-08T07:58:08.918Z`，客户端基线为
`2026-09-10T06:40:00.000Z`。Global 公开网关的 Luna 实报只有 medium / high / xhigh；
公共资料补齐后应显示 low / max，但仍不可选。回归覆盖 Astra / Sol / Terra / Luna 的
三种 wire ID、三个引擎，以及网关显式空数组与未知型号，确保公共展示不解锁通道。

保留缺项或显式空值的理由：

- Anthropic 现有分级与[官方表](https://platform.claude.com/docs/en/build-with-claude/effort)一致；
  Sonnet / Haiku 4.5 不支持 effort，空数组保留。
- xAI 现有档位核对[reasoning 文档](https://docs.x.ai/developers/model-capabilities/text/reasoning)；
  普通 Grok 4.20 的旧别名与 multi-agent 档位语义不能互相推导，未获精确证据不增删。
- MiniMax M3 / M2 系列、Qwen3.6 Plus API、Qwen3.5 / 3.6 本地模型、Gemma 和 Nemotron
  当前证据仅支持思考模式／预算开关，不能编造分级档位。
- GPT-5.5 Auto、GPT-5.6 Cyber、Muse Spark 1.2、DeepSeek V4 Flash Vision Exp 和 Hy4 preview
  尚无本轮可确认、适用于现有 schema 的完整公共档位。网关实报不替代公共型号证据；
  DeepSeek 搜索摘要与实际打开的当前 API 型号列表不一致，因此未据摘要补实验型号。

## 本地模型复核（2026-09-24）

本轮从 7 个逻辑模型扩展到 8 个，新增 Laguna S 2.1 编程候选和 Flash-Next 的跨平台
Q4 包装，复核 AA v4.3.2 与全部 17 个下载标签。正式推荐仍保留 Qwen3.8 27B，
未将其他运行时实测冒充 Ollama 本机证据。完整来源、取舍、门槛和发布边界见
[2026-09-24 调研记录](local-model-audit-2026-09-24.md)。

## 本地模型配置与证据快照（2026-09-05）

本轮由 9 个内置条目收敛到 7 个逻辑模型。正式推荐保留 Qwen3.8 27B；其他
6 个只是待比较候选。5 个选择位置中，低内存中档和速度档各保留两名候选等待比较。
“保留推荐”是当前证据下的产品选择，不表示已完成所有量化与硬件组合的 Pareto 证明。

| 位置     | 模型                                         | 当前处理              | 仍需补齐的证据                                            |
| -------- | -------------------------------------------- | --------------------- | --------------------------------------------------------- |
| 更低内存 | Qwen3.5 4B                                   | 候选                  | 同条件能力、速度、峰值内存                                |
| 低内存   | Qwen3.5 9B / Gemma 4 12B                     | 两名候选，未决出胜者  | 同硬件、同量化条件的三维比较                              |
| 能力     | Qwen3.8 27B                                  | 保留能力推荐          | 本地量化对能力的影响、长上下文峰值；不宣称所有 Mac 上最优 |
| 速度     | Qwen3.6 35B A3B / Nemotron 3.5 Lightning 30B | 两名候选，未决出胜者  | 同一台 Mac 上的完整比较                                   |
| 大内存   | Qwen3.8 Flash-Next                           | 仅 Apple Silicon 候选 | Ollama 对应标签的加载/运行峰值及能力损失                  |

移出内置目录：GPT-OSS 20B、Gemma 4 E2B/E4B/26B/31B、Ornith 1.5 35B、
GLM-4.7-Flash。本轮未证明它们相对上述候选有独立的三维优势，不为这些条目另设推荐位；
这不等于已经用完整同机实验证明它们都被支配。Laguna XS 2.1、Muse Glimmer 30B
也不因新品或厂商宣传进入目录。

### 证据快照

- [Artificial Analysis Qwen3.8 27B xhigh](https://artificialanalysis.ai/models/qwen3-8-27b)：
  Intelligence Index **v4.2 = 42**，是保留能力推荐的独立依据。该配置是 xhigh，
  不是本地 MLX/MXFP8 已复现的成绩。
- [Qwen3.8 Flash-Next](https://artificialanalysis.ai/models/qwen3-8-flash-next) 的 v4.2
  **46**、[Qwen3.6 35B A3B](https://artificialanalysis.ai/models/qwen3-6-35b-a3b) 的
  **26**在本轮查询中标为 estimated；仅用于候选判断，不据此宣称已实测击败 27B。
- [M4 Air 32GB 对比原始项目](https://github.com/jordanilchev/local-qwen)：Ollama 0.32.14，
  关闭思考、短输入、最多 200 输出 tokens；Qwen3.6 Q4_K_M 为 29.9 tokens/s，
  Qwen3.8 27B NVFP4 为 17.2 tokens/s。量化不同且未提供完整内存峰值，
  只能支持速度候选资格。
- [Nemotron 长上下文测试](https://omarshabab.com/local-llm-256k-leaderboard/) 使用
  M3 Ultra 512GB 和 MLX；不能与上述 M4 Air 数字直接排出快慢。
- [Flash-Next 4-bit 测试](https://huggingface.co/rapid-mlx/Qwen3.8-Flash-Next-4bit)
  使用 M3 Ultra 256GB、Rapid，报告加载峰值约 148.1GB；不能推断 Ollama 在 128GB
  上适合日用。本目录的 192GB 是保守候选提示，尚未由对应 Ollama 标签验证。

### 包装与内存提示

标签和下载字节于 2026-09-05 从 Ollama 官方 registry 的 manifest 核对，下载大小
为 `layers[].size` 之和。目录中各 `variants[].sizeBytes` 按具体包装分别记录，不能混用。
标签可变；后续更新应重新读取 manifest 并记录摘要。大小仅用于下载提示。

| 模型                   | 通用标签                     | Apple Silicon 标签                      | 内存提示 GB   |
| ---------------------- | ---------------------------- | --------------------------------------- | ------------- |
| Qwen3.5 4B             | `qwen3.5:4b-q4_K_M`          | `qwen3.5:4b-mlx`                        | 8             |
| Qwen3.5 9B             | `qwen3.5:9b-q4_K_M`          | `qwen3.5:9b-mlx`                        | 16            |
| Gemma 4 12B            | `gemma4:12b-it-q4_K_M`       | `gemma4:12b-mlx`                        | 16            |
| Qwen3.8 27B            | `qwen3.8:27b`                | `qwen3.8:27b-mlx` / `qwen3.8:27b-mxfp8` | 32 / MXFP8 64 |
| Qwen3.6 35B A3B        | `qwen3.6:35b-a3b-q4_K_M`     | `qwen3.6:35b-mlx`                       | 32            |
| Nemotron 3.5 Lightning | `nemotron-3.5-lightning:30b` | `nemotron-3.5-lightning:30b-mlx`        | 48            |
| Qwen3.8 Flash-Next     | 未纳入通用包装               | `qwen3.8-flash-next:125b-mlx`           | 192           |

查询入口为 `https://registry.ollama.ai/v2/library/<模型家族>/manifests/<标签>`。
以上内存提示全部是当前配置的估算门槛，不是测得的最低运行内存，不保证任意上下文可用。
Qwen27 的 32GB MLX、64GB MXFP8 选择沿用现有行为，不把更大包装描述成已经证实更优。
非 Apple 主机的普通 RAM 也不等于 GPU 显存；内存适配不是 GPU 性能认证。

## 2026-09-05 至 09-07：协议与价格迁移

历史 V1–V3 迁移时，先保存并恢复经核实的 `nativeApi` / `nativeApiRules`，
按 route 身份对齐；当时以 V3 格式生成新的递增 revision。此时两份 Registry 不再逐字相等，
应分别核对业务参数与协议补全差异，不能沿用同 revision 却修改内容。服务端以后可在原文件
补写这些字段，无需再维护第二份配置文件。

2026-09-05 对齐发现的典型差异包括：OpenAI 订阅与 XD 路由窗口混用、Sonnet 5 已取消
的涨价仍留在旧兜底、Opus Fast 缓存价缺项、Grok 长输入分档过时，以及 DeepSeek
直连参考价 route 缺失。此类修正先落 Server，再同步兜底，不能再维护两份独立数字。
既有 GPT-5.x 公共 API 长输入参考价仍用于历史／显式长窗口估值，不表示订阅默认窗口
应扩大；Astra 的长输入参考价已于 2026-09-07 核实并补齐；此前未核实的长输入历史价格仍返回未知。

2026-09-05 核对[火山方舟流式输出官方示例](https://www.volcengine.com/docs/82379/2123275)：
`doubao-seed-2-1-pro-260628` 可直接调用 `/api/v3/chat/completions`。
Cindy 的 Seed 2.1 Pro 默认协议基准补为 `openai-completions`；这表示默认协议选择，
不表示官方只支持这一种协议（同页也有 Responses 示例）。Gateway 出站仍按实际通道比较。
当时 Server V2 目录可继续在原文件维护价格与窗口，当时本地 V3 只补协议；后续完整快照遗漏
协议时仍由客户端兜底，显式 null/retired 保持优先。

## 2026-09-07 至 09-08：不同批次的同步记录

- 09-07 目录核对曾记录：客户端先递增 Registry，Server 同步待完成。详见 [该次核对](model-catalog-audit-2026-09-07.md)。
- 09-08 本地目录配套工作曾记录：客户端已有型号、协议资料和 medium 默认策略同步到 Server 工作分支，两份随包 Registry 一致。该记录仅证明当时工作快照一致，不证明 PR 合并或环境部署。
- 两条记录不能推导今天的状态。后续核验应记录客户端 commit、Server commit、Registry updatedAt、环境和接口响应；缺少证据的项写未验证。
