# 模型目录历史取舍与迁移记录

> 参考记录，不是当前配置或部署状态。当前维护规则见 [模型配置与下发](dev-rules/model-catalog-maintenance.md)。
> 下列文字记录各批次当时的事实，不能相互当作后续状态的证明。引用时须带日期、来源和验证范围。

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
