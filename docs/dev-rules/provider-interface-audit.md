# 供应商接口核查与导入规则

核查日期：2026-09-13。范围：当前客户端 52 个连接预设（包括地区/套餐分开的入口）。

## 结论与证据边界

这是官方文档与本地代码核查，不是 52 家账号的付费请求验收。未做云端生成请求。
“有接口”与“某账号、某模型、某版本可成功调用”分别记录；未取得完整资料不等于不支持。

模型列表没有跨供应商统一的 `api_language` 字段。OpenRouter 的 `architecture`/`supported_parameters`
描述模态和参数，不是三种 HTTP 接口的完整清单；Vercel 的语言模型类型也不表示只支持一种协议。
OpenCode 官方逐模型 endpoint 表可确定协议；它与 Pi 固定版本资料冲突时，以同渠道精确 ID 的官方声明为准。
本次没有通过认证接口核实每个供应商 `/models` 的全部字段，因此不能声称都不返回协议信息。

## 公开模型列表接口实读

仅 GET 元数据，不发送生成请求，不使用 API key。2026-09-13 快照：

| 接口 | 模型数量 | 是否返回 HTTP API 语言 |
| --- | --- | --- |
| OpenRouter `/api/v1/models` | 445 | 未返回。architecture 是输入输出模态、tokenizer 等；supported_parameters 是参数名。 |
| Vercel `/v1/models` | 376 | 未返回上述四种语言。supported_specifications 的实值是 v2/v3/v4，不能当成 HTTP 协议。 |
| OpenCode Zen `/zen/v1/models` | 70 | 未返回。只有 id/object/created/owned_by。 |
| OpenCode Go `/zen/go/v1/models` | 37 | 未返回。只有 id/object/created/owned_by。 |

OpenCode 官方文档表本次取得 Zen 69 条、Go 28 条声明，与实时模型数量不同；
未在文档表中的模型继续依赖同渠道 Pi 资料或明确配置，不能伪称所有实时模型都有官方协议声明。

## 维护规则

- 模型原生协议、渠道提供的接口、Harness 请求协议分开记录。固定协议的 Claude Code / Codex
  与模型原生协议不一致时，即使转换发生在供应商侧，仍显示兼容、默认关闭；不能因为渠道
  同时提供 Messages / Responses 就将 Gemini 标成三种原生。Pi 使用现有 adapter 直接请求
  渠道声明的 API，默认原生可用；不因此给 OpenRouter / Hermes 虚构 Google 端点。
- 自定义渠道与 Gateway 共用 Cindy 的原生声明。服务器缺项时用本地声明补齐；明确修正、
  未知和退役优先。原生声明不携带其他渠道的价格、窗口、账号权限或请求地址。
- Pi 导入的 API 只说明 Pi 当前选用的 adapter，不代表供应商全部能力。
- `providerInterfaceRoutes.ts` 维护已确认的渠道入口；原有产品/区域的不同地址保持独立。
- `provider-interface-models.json` 保存 OpenCode 官方精确模型 ID、endpoint、来源和核查日期。
  它只修正统一模型表的执行协议与地址；不借其他供应商的型号参数，不自动开通未导入模型。
- 新增 Pi 目录条目、API 发现条目和旧导入投影共用入口规则；用户自定义 host/path 与显式非 Chat 协议不覆盖。
- Claude Code 优先 Messages、Codex 优先 Responses、Pi 保留可直接调用的 adapter。
  不匹配才由现有本地转换器提供兼容，兼容默认关闭；保留用户开关。
- 底层 Bedrock/Vertex/Mistral SDK、认证和路由不作为新增 UI 语言；模型管理保持四种公开语言。
- 供应商升级文档/接口时应更新此记录和精确契约测试。Pi catalog 同步不会覆盖官方逐模型纠正层。

## 全部预设

“保留”不代表本次完成云端验收；“待核实”不得转换成“不支持”。

| 渠道 ID | 已确认或现有协议 | 处理及限制 | 证据 |
| --- | --- | --- | --- |
| openrouter | Chat / Responses / Messages | 多协议；修复 Pi 目录覆盖另外两种入口 | [官方资料](https://openrouter.ai/docs/api/reference/overview) |
| deepseek | Chat / Messages | 保留两种官方入口；未证明 Responses | [官方资料](https://api-docs.deepseek.com/guides/anthropic_api) |
| zhipu-glm-cn | Chat / Messages | 保留普通与 Coding Plan 独立入口；不从 Pi Chat 覆盖 Messages | [官方资料](https://docs.bigmodel.cn/cn/guide/develop/claude) |
| zhipu-glm-global | Chat / Messages | 保留普通与 Coding Plan 独立入口 | [官方资料](https://docs.z.ai/devpack/tool/claude) |
| moonshot-kimi-cn | 现有 Chat / Messages | 中文正文仅抓到 Chat；不把 Global Responses 自动借给中国大陆版 | [官方资料](https://platform.moonshot.cn/docs/guide/agent-support) |
| moonshot-kimi-global | Chat / Messages / Responses | 官方 Responses 已确认；现有 Codex 仍用 Chat，本轮未扩大到所有型号 | [官方资料](https://platform.moonshot.ai/docs/api/responses) |
| moonshot-kimi-code | 现有 Messages / Chat | 订阅与普通 API 不能混用；完整多协议矩阵待核实 | [官方资料](https://www.kimi.com/zh-cn/help/kimi-code/third-party-agents) |
| minimax-cn | 现有 Messages / Chat / Responses | Global Responses 官方已确认；中国大陆版保留现有声明，未由 Global 推断新接口 | [官方资料](https://platform.minimax.io/docs/api-reference/responses-create) |
| minimax-global | 现有 Messages / Chat / Responses | Global Responses 官方已确认；中国大陆版保留现有声明，未由 Global 推断新接口 | [官方资料](https://platform.minimax.io/docs/api-reference/responses-create) |
| aliyun-bailian-coding | Chat / Messages | Coding Plan 专用 key 和地址；不可与按量 key 混用 | [官方资料](https://help.aliyun.com/zh/model-studio/coding-plan) |
| aliyun-bailian-token-plan-cn | 现有 Chat / Messages | 保留产品独立入口；官方概览未完整说明协议矩阵，待专项核实 | [官方资料](https://help.aliyun.com/zh/model-studio/token-plan-personal-overview) |
| aliyun-bailian-token-plan-team-cn | 现有 Chat / Messages | 保留产品独立入口；官方概览未完整说明协议矩阵，待专项核实 | [官方资料](https://help.aliyun.com/zh/model-studio/token-plan-personal-overview) |
| google-gemini-api | Gemini / Chat | 官方提供 Gemini 及 OpenAI 兼容接口；现有预设用 Chat；本轮未切换 Pi 到 Gemini | [官方资料](https://ai.google.dev/gemini-api/docs/openai) |
| litellm | Chat / Responses / Messages | 修复默认地址的 Claude Messages；实际路由仍取决于用户部署 | [官方资料](https://docs.litellm.ai/docs/anthropic_unified) |
| lmstudio | Chat / Responses / Messages | 修复默认地址的 Codex Responses；自定义地址及旧版本不可推断 | [官方资料](https://lmstudio.ai/docs/developer/openai-compat) |
| llamacpp | Chat / Responses / Messages | 最新源码支持；存量本地服务版本未知，保留原配置，不批量改成新协议 | [官方资料](https://raw.githubusercontent.com/ggml-org/llama.cpp/master/tools/server/README.md) |
| vllm | Chat / Responses / Messages | 最新文档有相关路由；部署版本、模板与启动配置未知，保留原配置 | [官方资料](https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html) |
| longcat | Chat / Messages | Codex 原先隐含 Responses 错误，改为 Chat 兼容 | [官方资料](https://longcat.chat/platform/docs/zh/) |
| zhipu-coding-plan-cn | Chat / Messages | 保留普通与 Coding Plan 独立入口；不从 Pi Chat 覆盖 Messages | [官方资料](https://docs.bigmodel.cn/cn/guide/develop/claude) |
| zai-coding-plan-global | Chat / Messages | 保留普通与 Coding Plan 独立入口 | [官方资料](https://docs.z.ai/devpack/tool/claude) |
| xiaomi-mimo-api-cn | Chat / Messages | 官方按量和中国大陆 Token Plan 文档确认两种入口 | [官方资料](https://mimo.mi.com/docs/zh-CN/quick-start/summary/first-api-call) |
| xiaomi-mimo-token-plan-cn | Chat / Messages | 官方按量和中国大陆 Token Plan 文档确认两种入口 | [官方资料](https://mimo.mi.com/docs/zh-CN/quick-start/summary/first-api-call) |
| volcengine-agent-plan | 现有 Chat / Messages | 官方页面仅抓到导航；完整协议矩阵待核实 | [官方资料](https://docs.volcengine.com/docs/82379/2373738) |
| volcengine-coding-plan | Chat / Messages | Coding Plan 独立地址；保留 | [官方资料](https://www.volcengine.com/docs/82379/1925114) |
| tencentcloud-coding-plan | Chat / Messages | 官方明确尚无 Responses；Codex 使用本地兼容，不标原生 | [官方资料](https://cloud.tencent.com/document/product/1823/130098) |
| opencode-go | Chat / Responses / Messages，按模型区分 | 官方 28 个精确 ID/endpoint 声明；修正 Qwen / MiniMax Messages | [官方资料](https://opencode.ai/docs/go/) |
| vercel-ai-gateway | Chat / Responses / Messages | 多协议；保留各引擎入口，新增目录模型不得覆盖 | [官方资料](https://vercel.com/docs/ai-gateway/sdks-and-apis) |
| amazon-bedrock | Converse / InvokeModel 等内部传输 | 不是新增 UI 语言；依赖区域、模型和 IAM；不可一律映射成 Chat | [官方资料](https://docs.aws.amazon.com/bedrock/latest/userguide/conversation-inference.html) |
| amazon-bedrock-eu-central-1 | 同 Bedrock，区域独立 | 保留区域路由，不借用其他区域的模型可用性 | [官方资料](https://docs.aws.amazon.com/bedrock/latest/userguide/conversation-inference.html) |
| ant-ling | Pi 表 Chat；官方完整矩阵待核实 | 开放平台正文不足；不能声称只有 Chat | [官方资料](https://chat.ant-ling.com/open) |
| anthropic-api | Messages | 保留官方 Pi adapter；本轮未单独重验其他接口不存在 | [官方资料](https://docs.anthropic.com/en/api/messages) |
| azure-openai-responses | Responses / Chat 等部署接口 | 保留 Azure SDK、资源、部署与鉴权；不能只换 URL 视为普通 OpenAI | [官方资料](https://learn.microsoft.com/en-us/azure/ai-foundry/openai/reference?view=foundry-classic) |
| baseten | Chat / Messages | Messages 为 beta；修复 Claude Code 入口；须发送 Bearer（已有公共鉴权层） | [官方资料](https://docs.baseten.co/development/model-apis/overview) |
| cerebras | Pi 表 Chat；官方完整矩阵待核实 | 本轮文档抓取失败；不能声称只有 Chat | [官方资料](https://docs.cerebras.ai) |
| cloudflare-ai-gateway | 随所代理的供应商路由 | 官方有供应商透传路径；未证明每模型都提供全部语言 | [官方资料](https://developers.cloudflare.com/ai-gateway/usage/providers/) |
| cloudflare-workers-ai | Chat / 部分 Responses | 官方 Responses 示例 gpt-oss；不据此替所有模型开启 | [官方资料](https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/) |
| fireworks | Chat / Responses / Messages | 修复两种入口；仅官方 inference 地址，不套用独立部署地址 | [官方资料](https://docs.fireworks.ai/llms.txt) |
| github-copilot | 按模型、登录权限和专用 API | 官方模型页面不能证明接口矩阵；保留 Pi 专用登录/adapter，完整矩阵待核实 | [官方资料](https://docs.github.com/en/copilot/reference/ai-models/supported-models) |
| google-vertex | Gemini / 部分模型 Chat | 保留 Pi Vertex SDK；Chat 仅适用于文档列明模型/部署，不扩大到所有模型 | [官方资料](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/multimodal/call-gemini-using-openai-library) |
| groq | Chat / Responses | Responses 为 beta；修复 Codex 被压成 Chat | [官方资料](https://console.groq.com/docs/responses-api) |
| huggingface | Chat / Responses | Responses 为 beta；官方称所有 chat 模型应兼容；修复 Codex 路由 | [官方资料](https://huggingface.co/docs/inference-providers/guides/responses-api) |
| mistral | Chat / Conversations 内部接口 | Pi 当前用专用 Conversations adapter；不是第五种用户语言 | [官方资料](https://docs.mistral.ai/api/endpoint/chat) |
| nvidia | 已确认 Chat | 没有证明全模型其他协议；保留现有接口 | [官方资料](https://docs.api.nvidia.com/nim/reference/llm-apis) |
| openai-api | Pi 目录逐模型 Responses / Chat | 保留本地官方适配资料；本轮未单独重验所有 OpenAI 模型接口 | [官方资料](https://platform.openai.com/docs/api-reference) |
| opencode | 四种，按模型区分 | 官方 69 个精确 ID/endpoint 声明；不是每个模型四种都支持 | [官方资料](https://opencode.ai/docs/zen/) |
| qwen-token-plan | Pi 表声明的接口 | 国际版产品概览未证明完整协议矩阵；不借中国大陆版端点 | [官方资料](https://www.alibabacloud.com/help/en/model-studio/token-plan-overview) |
| qwen-token-plan-individual | Pi 表声明的接口 | 国际版产品概览未证明完整协议矩阵；不借中国大陆版端点 | [官方资料](https://www.alibabacloud.com/help/en/model-studio/token-plan-overview) |
| together | 已确认 Chat | 没有证明全模型其他协议；保留现有接口 | [官方资料](https://docs.together.ai/docs/openai-api-compatibility) |
| xai-api | Chat / Responses | Pi 表已有逐模型执行协议；保留 | [官方资料](https://docs.x.ai/docs/api-reference) |
| xiaomi-token-plan-ams | Pi 表声明的接口 | 海外区域完整接口矩阵待核实；不借中国大陆地址 | [官方资料](https://mimo.mi.com/docs/en/quick-start/summary/first-api-call) |
| xiaomi-token-plan-sgp | Pi 表声明的接口 | 海外区域完整接口矩阵待核实；不借中国大陆地址 | [官方资料](https://mimo.mi.com/docs/en/quick-start/summary/first-api-call) |
| nous | 已确认 Chat | 官方代理说明列 Chat 等端点；未证明 Responses / Messages，不因模型品牌推断 | [官方资料](https://hermes-agent.nousresearch.com/docs/user-guide/features/subscription-proxy) |

## 本地验证

2026-09-13 自查补充（子代理失败后由主会话执行）：

- 52 个预设逐模型检查 HTTP API 与执行路由是否一致，并检查所选模型的原生默认开、兼容默认关。
  发现 OpenCode Go `grok-4.5` 的 Responses 声明继承了 Chat 路由；已修正预设选择和存量配置投影。
  显式自定义请求路径保持不动，SDK 专用传输不伪装成 HTTP 协议。
- 四个公开模型接口再次读取成功：OpenRouter 445、Vercel 376、Zen 70、Go 37。
  经发现解析与标准目录投影，实报的上下文、最大输出和图片能力没有丢失。
- 遍历 Pi 当前公开供应商数据，发现打包表中的空 `.manifest` 被当作供应商刷新，接口返回 404。
  已从快照移除，并在 bundle 读取与旧快照刷新时排除该索引。
- Pi 当前 [OpenCode Go 目录](https://pi.dev/api/models/providers/opencode-go) 已包含
  `deepseek-v4.1-flash`，打包表缺失；按该渠道精确记录补入 Chat、图片、1,000,000 上下文、
  384,000 最大输出与 high/max 档位。记录来源日期；没有从同品牌其他供应商借用参数。
  同时修复旧 ID-only 导入不会继承新增逐模型接口的问题；用户显式 API、窗口、档位、开关保留。
- 模型配置测试 953 条通过；Desktop 导入、实际 Pi adapter、代理转发、授权界面测试 472 条通过，2 条既有跳过。
  实际 Pi 二进制的 Copilot / Cloudflare adapter 测试只请求本机模拟接口，不请求云端生成。
- Pi 公共目录与打包目录仍有新增/退役差异，不能以本次单个型号补齐宣称整份快照为最新。
  OpenCode 官方 endpoint 表与实时名单也仍不相等；未声明型号不能视为已取得官方协议证据。
- 这是代码、公开元数据与本地模拟请求验收，没有逐一登录 52 个渠道、没有付费生成请求。
  本轮未重启 DEV，不能将代码通过写成当前测试客户端已更新。

### 原生默认判定纠正（2026-09-13）

前述默认开关测试错误地将渠道出口 API 当成模型原生协议，不能作为原生默认正确的证据。
已移除自定义供应商的比较豁免，并补齐已验证目录型号的 Cindy 原生声明；导入、刷新、
管理页总开关和详细页使用同一结果。未知声明不再自动打开固定协议 Harness。

- OpenRouter / Vercel 的 Gemini、Claude、GPT，以及 OpenCode Zen / Go 的逐模型例子明确
  验证开关与实际出口；Hermes 新发现的 Gemini 保留 Chat 出口，只有 Pi 默认原生开启。
- 52 个预设的 4,147 个聊天引擎条目通过默认规则扫描，不等于 4,147 个不同模型，
  也不表示每个型号已有原生声明。未知条目仍可由 Pi 按真实 adapter 使用。
- 新旧导入、服务器 V1/V2/V3/V5 缺项刷新、明确协议修正、用户窗口/档位/开关保留都有回归。
- 本机 DEV 已保存的 OpenRouter、OpenCode Zen、Hermes Gemini 配置经只读回放，原生声明
  都为 Google，Claude Code / Codex 都为兼容，Pi 为原生。未选中的模型保持关闭，未改用户配置。
- 模型配置测试 987 条、Desktop 相关测试 464 条通过，2 条既有跳过；两个包类型检查通过。
  没有发送付费生成请求，不能据此宣称所有供应商账号的真实生成均已验证。
- 已重启同一 `dev2-provider-four-api` 隔离 DEV，启动器确认 ready、来源 worktree 匹配。
  从运行中的客户端只读取得三家供应商的实际目录，Gemini 原生声明/接口/上下文均与回放一致。
  OpenRouter Gemini 默认开关为 Claude Code 关、Codex 关、Pi 开；另两家原有未选中状态保留。
