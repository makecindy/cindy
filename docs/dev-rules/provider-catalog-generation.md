# 通用供应商模型目录

本次目标：复用 Pi 上游的数据生成方案和兼容知识，生成 Cindy 格式的供应商模型记录；
设置页与各引擎共用解析结果，移除逐引擎逐模型的大编辑表单。

## 数据与维护

- Cindy Registry 保留公共型号、显式渠道修正、展示与用户默认规则。
- 上游 Pi 生成结果作为输入；导入时转换为 Cindy 的名称、上下文、最大输出、输入类型、
  推理、渠道报价与协议字段。Pi 专属请求兼容字段放在执行适配数据中。
- 供应商 API 发现更新按连接保存，准确 ID 合并，不模糊匹配；无声明与明确 false 分开。
- 渠道资料只借给地址和协议相符的连接，不能跨代理地址继承报价或协议承诺。
- 生成过程输出可重现的数据文件与来源，校验完成才替换；离线继续使用最后有效目录。
- 保留模型原始 ID、账号、Key、开关、用户覆盖；刷新不把默认值固化成用户设置。

## 接入与界面

- 常见供应商由预设维护地址、鉴权与协议，用户提供凭证后发现并配置模型。
- 连接编辑只负责连接本身；模型设置使用已有标准模型详情。
- 导入后的引擎默认与详情协议判定一致：原生开启、兼容关闭。列表开启模型时开启全部原生引擎，不能只开推荐引擎；用户显式开关优先，恢复默认才清除覆盖。
- 任意兼容端点继续可接入，保留必要的协议与高级连接参数，不保留平行模型编辑器。
- Desktop 与 Mobile/远程消费者读取相同标准目录，不各自判断能力。

## 验收

1. OpenRouter 全名单导入：已知与未知 ID、文字与图片、工具支持、推理限制、价格及输出长度。
2. 多协议供应商、相同模型跨供应商、改写地址、不完整/异常资料、离线失败。
3. 老连接不重建、不丢凭证或用户覆盖；刷新模型资料可见且传入各引擎。
4. 新连接和旧连接均无需逐个编辑模型；旧编辑入口及无消费者代码清除。
5. 接口验收只发公共资料 GET，不发生成请求。Desktop DEV 仅在用户明确授权后启动。

## 更新命令

客户端只存 `packages/model-providers/catalog/provider-models.json`；Pi 原始字段由 adapter
按需还原。`providers.json` 的连接预设与推荐名单继续单独维护，不被导入脚本重写。

- 在线刷新已知供应商：`pnpm sync:pi-model-catalog`。公开 Pi 端点可能拒绝请求；失败时不替换目录。
- 导入 Pi 生成器的完整导出：`pnpm sync:pi-model-catalog --input /path/to/providers.json --source-version <version>`。
  输入是 provider ID 到完整 Pi 模型数组的映射；新供应商自动进入标准表，缺少已有供应商则报错，避免误删。
- 从 Cindy 已固定版本的 Pi 二进制读取生成数据：
  `pnpm sync:pi-model-catalog --pi-bundle /path/to/pi --source-version 0.85.1 --generated-at 2026-09-12T00:00:00Z`。
  仅解析生成的字面量数据，不执行二进制。旧版本已有的 Astra/xAI 修正由具名函数保留，新版本不套旧版本修正。
- OpenRouter 全量资料审计：`pnpm exec tsx tools/pi/audit-openrouter.mts`。
  只调用公开 `GET /api/v1/models`，不用 Key、不发推理请求；也可传本地响应 JSON 路径离线审计。

本次导入 Pi 0.85.1 共 39 个有模型的供应商、1,355 条记录（另有一个空 `.manifest` 元数据键，不计作供应商），包含同型号的不同渠道。
这不是可调用数量：账号准入、余额和实时供应状态仍由实际连接决定。
未更改 Server 正本，也未声称生产客户端已部署。用户已授权启动隔离 DEV 并反馈实测问题。

## 用户实测后的补充验收

最初审计把三引擎都构造成 Chat 路由，没有覆盖实际添加请求。OpenRouter 的公开模型接口
带 Bearer 与 `anthropic-version` 时返回 20 条重写 ID 的兼容视图；普通目录返回 445 条。
发现请求现按供应商目录协议构造，不能照搬生成请求头。审计脚本使用生产请求构造器、
无效测试凭证和三个真实预设路由逐一 GET，对比原始 ID，并验证保存后型号与能力。

已有 Cindy 公共型号的原生协议在自定义连接中补缺；这不从渠道协议猜厂商协议。
BYOK 导入报价进入实际参考价发布链；用户价格覆盖仍最后应用。
添加页只对明确默认开启项标推荐，完整目录成功后清除下架的预设候选；刷新可纠正
经完整 OpenRouter 目录确认的发现结果错误前缀，保留手填 ID 与显式模型参数。

### OpenCode mixed-protocol regression

Zen/Go can return a model ID list without capabilities. Pi import enumerates all known APIs at
that exact endpoint, including Responses and Gemini models even when the connection defaults to
Chat. The standard catalog and native Pi launch both resolve the same exact endpoint + model ID.
For mixed-protocol endpoints the catalog supplies each model's API; explicit model API/route
still wins, and a single-protocol endpoint does not replace an explicitly different transport.
Derived API defaults stay out of `userModelConfig` so saving unrelated preferences does not freeze
them as user overrides. No manufacturer protocol is inferred from the execution API.

Regression coverage includes Go's add wizard, Zen Astra/Gemini/image variants, and every
unambiguous portable catalog record through the actual Pi launch descriptor. These tests make
no generation requests. The public Zen and Go metadata GETs returned HTTP 403 during this check;
authenticated online OpenCode and GUI acceptance remain unverified.

## 2026-09-13 通用渠道补齐与待验收状态

- OpenRouter、OpenCode（Zen / Go）、Vercel、LiteLLM、LM Studio、llama.cpp、vLLM 共用标准模型解析与保存。
- Vercel 读取 `max_tokens`、输入模态、`reasoning_options` 的明确 effort 取值及语言模型的 USD/token 价格；非语言模型保留类型，不把图片单价当 token 价格。单位依据官方 [模型发现文档](https://vercel.com/docs/ai-gateway/models-and-providers)。
- LiteLLM 的 `model_name` 保留为调用 ID，`model_info` 可补窗口、输出上限、视觉与工具能力；LM Studio 的 `key` / capabilities 结构可被解析。普通 OpenAI 兼容端点的 ID 列表也保持可用。
- 刷新仅返回 ID 时，保留此前发现的资料；明确 false 仍覆盖旧资料，用户字段仍最后覆盖。连接编辑与列表刷新均保留缺失字段。
- 不按模型名模糊猜测厂商协议，也不把任意代理价格解释为美元。仅有 ID 且标准表无记录时，未知字段仍未知；这些事实不能靠静态代码补造。

验证：公共 GET 的 OpenRouter 445 条、Vercel 375 条（其中语言模型 252 条）在三引擎投影中核对输入能力、窗口、输出与可解析价格。OpenCode 的匿名接口仍返回 403；本地服务没有本次真实实例验收，测试覆盖其响应结构，不等同于已访问用户的服务。没有生成调用。

已备份并更新本任务隔离档案中的 OpenRouter 发现资料，纠正 20 个兼容视图错误 ID；三个 runtime 均覆盖现有 445 条模型，另保留 1 条历史配置，避免删除用户已有记录。测试版已重启至当前工作区代码；窗口工具仍无法取得该窗口的 AX 内容，最终界面由用户验收。


## 供应商入口与三引擎执行（2026-09-13）

客户端共 52 个连接预设，每个均提供 Claude Code、Codex、Pi runtime；另保留既有原生账号入口。
Pi 0.85.1 的全部 39 个有模型供应商均有对应入口；OpenAI Codex 复用 ChatGPT 原生登录，
OpenAI / Anthropic / xAI API 与订阅入口分开，另加 Nous Research（Hermes 云模型）。
完整目录新增模型默认不勾选；既有维护过的推荐保留。

### 地址、模型与参数

- Azure 资源名、Vertex location、Cloudflare account/gateway 使用可编辑的声明模板；
  绑定后同一连接的三个 runtime、发现地址与模型独立地址同步替换，不按模型名猜地址。
- Bedrock 不同区域分开预设，避免把别区模型错误地借给当前 endpoint。
- 账号模板绑定后仍按 preset ID + 精确模型 ID/API 查标准资料；普通改写地址不继承原渠道承诺。
- 模型详情可逐引擎选八种原生 API；同处调整默认思考档位和工作上下文，上游窗口与最大输出另行展示。
  发现结果声明的档位会进入请求，不因离线表较旧而把 `max` 降到 `high`。
  未声明的厂商参考协议不再显示成配置缺失；新部署名继承已绑定单协议连接的 API，
  不借用别的型号的窗口或能力。
- 模型参数遵循公共目录、精确渠道资料、发现结果、用户覆盖的已有分层；接口仅返回 ID 时保留旧资料。
- Server 下发旧预设时，客户端补足 Claude runtime；Server 明确的成员和默认仍有效。
  此次未修改 Server，未部署正式客户端。

### 请求执行

- Pi 直接写入原生 provider，保留独立连接 ID、凭证和每模型 API。
  注册薄适配层恢复 Pi 内建供应商身份，使 Copilot / Cloudflare 等鉴权与思考兼容规则仍生效。
- Codex / Claude Code 复用已有 Responses / Messages 翻译层；已知原生 API 的实际序列化交给
  固定版本 `@earendil-works/pi-ai@0.85.1`，不再分别维护八套上游请求语言。
- 原生响应的工具/思考签名随会话历史保留，并限定连接、API、地址与模型；关闭思考不删除
  工具调用继续执行必需的原生状态。无前缀模型 ID 的 Claude 历史也能回放。
- Codex 的 Anthropic 大上下文 beta、会话请求头及供应商错误回报保留。
- Google / Vertex / Bedrock 使用 Pi 的原生 SDK 网络栈；其余支持注入 fetch 的适配器走 Cindy
  outboundFetch。不能把后者的系统代理覆盖宣称为全部原生 SDK 均已验证。

### 已验证与实际边界

- OpenRouter 公共 GET：445 模型，三个真实预设构造的发现请求均返回完整 ID，1,335 份配置
  核对上下文、最大输出、图片与报价；静态表缺失的模型使用动态资料，不做模糊匹配。
- 全部生成预设在三引擎核对实际 API、窗口、输出和图片能力。
- 真实 Pi 二进制接本地模拟接口：Copilot、Cloudflare 鉴权与独立连接身份通过。
- 原生 SDK 接本地接口：多种供应商思考格式、输出上限、Gemini 两轮工具签名通过。
- Nous / Vercel 公共模型列表已读取并投影三引擎；OpenCode 匿名 GET 返回 403，使用录制结构
  做回归，未声称已用真实 OpenCode 账号完成生成。
- 云入口本次提供 API key/token 连接。Nous / Copilot 的额外设备登录与自动续期，以及
  AWS IAM profile / Vertex ADC 专门表单不属于这批 API key 入口的已实现能力。
- 没有付费推理，没有真实云账号生成验收。原生 Pi 模型输入以文字与内联图片为基线；
  上游额外文件/音频格式不能据目录声明就称三引擎生成均已实测。

### 本地验证记录

根目录单元测试分层已运行；发现的 Desktop 大上下文请求头与 Pi 测试片段转译问题修复后，
Desktop、maker-core 单元层重新通过。后续变更的模型目录 917 条、模型详情 34 条及
新部署/原生请求定向回归通过；Desktop、共享模型包和共享桥接的类型检查完成。
Pi pin、许可证声明与设计清单检查通过，第三方声明已随新增 SDK 和 Pi 版本重新生成。

额外运行未分层 `desktop test` 带入数据库/Git 集成，出现 66 个失败，涉及缺失
`list_preview` 测试列及工作树恢复等；未宣称全部集成测试通过，也未为过关修改这些用例。
隔离 Desktop 启动可达到 ready；窗口工具返回 COMPUTER_DRIVER_ERROR，未完成 Light/Dark
实机截图验收。该限制不等于界面已经验收通过。


## 注册、密钥获取与 OAuth 入口（2026-09-13）

添加页面移除只读的三引擎端点和桥接说明；获取入口放在密钥输入前。官方已公布的密钥页优先，不能确认直达页时进入官方账号后台。本机服务保留设置帮助，不要求注册云账号。

下表覆盖 52 个连接预设，由 `providerSetupLink` 维护，覆盖测试防止新增渠道漏入口。`apiKey` 包括密钥页和有独立密钥的订阅管理页；`account` 是账号后台；`setup` 是本机服务帮助。公开文档核对不等于完成登录后的页面实测。

| 渠道 | 入口类型 | 官方入口 | 新增 OAuth |
| --- | --- | --- | --- |
| openrouter | apiKey | https://openrouter.ai/settings/keys | 有 |
| deepseek | apiKey | https://platform.deepseek.com/api_keys | — |
| zhipu-glm-cn | apiKey | https://bigmodel.cn/usercenter/proj-mgmt/apikeys | — |
| zhipu-glm-global | apiKey | https://z.ai/manage-apikey/apikey-list | — |
| moonshot-kimi-cn | apiKey | https://platform.moonshot.cn/console/api-keys | — |
| moonshot-kimi-global | apiKey | https://platform.kimi.ai/console/api-keys | — |
| moonshot-kimi-code | account | https://www.kimi.com/code/console | 有 |
| minimax-cn | apiKey | https://platform.minimaxi.com/user-center/basic-information/interface-key | 有 |
| minimax-global | apiKey | https://platform.minimax.io/user-center/basic-information/interface-key | 有 |
| aliyun-bailian-coding | apiKey | https://bailian.console.aliyun.com/cn-beijing/?tab=plan#/efm/subscription/coding-plan | — |
| aliyun-bailian-token-plan-cn | apiKey | https://bailian.console.aliyun.com/cn-beijing?tab=plan#/efm/subscription/token-plan/personal | — |
| aliyun-bailian-token-plan-team-cn | apiKey | https://bailian.console.aliyun.com/cn-beijing?tab=plan#/efm/subscription/token-plan/enterprise | — |
| google-gemini-api | apiKey | https://aistudio.google.com/apikey | — |
| litellm | setup | https://docs.litellm.ai/docs/proxy/quick_start | — |
| lmstudio | setup | https://lmstudio.ai/docs/app/api | — |
| llamacpp | setup | https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md | — |
| vllm | setup | https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html | — |
| longcat | apiKey | https://longcat.chat/platform/api_keys | — |
| zhipu-coding-plan-cn | apiKey | https://bigmodel.cn/usercenter/proj-mgmt/apikeys | — |
| zai-coding-plan-global | apiKey | https://z.ai/manage-apikey/apikey-list | — |
| xiaomi-mimo-api-cn | account | https://platform.xiaomimimo.com/ | — |
| xiaomi-mimo-token-plan-cn | apiKey | https://platform.xiaomimimo.com/token-plan | — |
| volcengine-agent-plan | account | https://console.volcengine.com/ark/ | — |
| volcengine-coding-plan | account | https://console.volcengine.com/ark/ | — |
| tencentcloud-coding-plan | account | https://console.cloud.tencent.com/ | — |
| opencode-go | account | https://opencode.ai/auth | — |
| vercel-ai-gateway | apiKey | https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai-gateway%2Fapi-keys&title=AI+Gateway+API+Keys | — |
| amazon-bedrock | account | https://console.aws.amazon.com/bedrock/ | — |
| amazon-bedrock-eu-central-1 | account | https://console.aws.amazon.com/bedrock/ | — |
| ant-ling | account | https://chat.ant-ling.com/open | — |
| anthropic-api | apiKey | https://console.anthropic.com/settings/keys | — |
| azure-openai-responses | account | https://ai.azure.com/ | — |
| baseten | apiKey | https://app.baseten.co/settings/api_keys | — |
| cerebras | account | https://cloud.cerebras.ai/ | — |
| cloudflare-ai-gateway | account | https://dash.cloudflare.com/ | — |
| cloudflare-workers-ai | apiKey | https://dash.cloudflare.com/profile/api-tokens | — |
| fireworks | apiKey | https://app.fireworks.ai/settings/users/api-keys | — |
| github-copilot | account | https://github.com/settings/copilot | 有 |
| google-vertex | account | https://console.cloud.google.com/vertex-ai | — |
| groq | apiKey | https://console.groq.com/keys | — |
| huggingface | apiKey | https://huggingface.co/settings/tokens | — |
| mistral | apiKey | https://console.mistral.ai/api-keys | — |
| nvidia | account | https://build.nvidia.com/ | — |
| openai-api | apiKey | https://platform.openai.com/api-keys | — |
| opencode | account | https://opencode.ai/auth | — |
| qwen-token-plan | account | https://modelstudio.console.alibabacloud.com/ | — |
| qwen-token-plan-individual | account | https://modelstudio.console.alibabacloud.com/ | — |
| together | apiKey | https://api.together.ai/settings/projects/~current/api-keys | — |
| xai-api | apiKey | https://console.x.ai/team/default/api-keys | — |
| xiaomi-token-plan-ams | apiKey | https://platform.xiaomimimo.com/token-plan | — |
| xiaomi-token-plan-sgp | apiKey | https://platform.xiaomimimo.com/token-plan | — |
| nous | account | https://portal.nousresearch.com/ | 有 |

OAuth 复用既有 Main 凭证存储、取消与刷新机制；新渠道登录后进入同一个模型选择页。密钥和令牌不回传 Renderer；未完成添加时删除本次临时创建的连接，已保存连接不受影响。已有 Claude、ChatGPT、xAI 原生账号入口保留。

协议来源：Pi 0.85.1 的 `auth/oauth/openrouter`、`github-copilot`、`kimi-coding`；[OpenRouter PKCE](https://openrouter.ai/docs/use-cases/oauth-pkce)；[Nous Hermes 公开鉴权常量](https://github.com/NousResearch/hermes-agent/blob/main/hermes_cli/auth_constants.py)及同目录 `auth_nous.py`、`auth_minimax.py`、`auth_device_flow.py`。MiniMax OAuth 使用订阅的 Messages 端点，API Key 连接保留自身端点。Copilot 刷新先交换推理令牌，并按官方令牌内的个人/企业账户域名路由。

较难定位入口的依据：[Vercel](https://vercel.com/docs/ai-gateway/authentication)、[阿里云 Coding Plan](https://help.aliyun.com/zh/model-studio/coding-plan)、[个人 Token Plan](https://help.aliyun.com/zh/model-studio/token-plan-personal-overview)、[团队 Token Plan](https://help.aliyun.com/zh/model-studio/token-plan-team-overview)、[Ling 控制台](https://developer.ant-ling.com/en/docs/models/price)、[Moonshot](https://platform.moonshot.ai/docs/overview.en-US)、[MiniMax](https://platform.minimax.io/docs/faq/about-apis)、[Together](https://docs.together.ai/docs/quickstart)。

本轮验证使用模拟授权服务与本机回环回调，未登录用户的真实供应商账号，未发任何付费生成请求。静态渠道列表没有推荐项的，不假造推荐或默认全选。本轮代码尚未在正在运行的 DEV 加载，不能把自动测试通过当成界面已部署。


## Hermes / OpenCode 导入验收修复（2026-09-13）

- 完成添加保存完整目录；勾选项按引擎原生能力默认开启，未勾选项保留为关闭。进入管理页前等待本地目录快照刷新，避免先显示旧快照。
- 相同地址、发现 URL 和接口协议的一次目录请求失败时，可复用同一连接另一引擎的成功结果；独立端点不会互借模型。Hermes 回归覆盖 Claude 读取失败但其余读取成功，保存后三引擎都在、只开启选中项的 Pi。
- OpenCode Zen/Go 的旧 Pi Messages 覆盖由标准目录的精确 ID/API/地址纠正。其它供应商维护的专用端点保持原配置，不把同厂商其它产品的接口强加过来。
- Pi 的已支持 API 都是直接使用；BYOK 的兼容判定只表示本地引擎需要转换，不拿厂商原生 API 与渠道 API 的差异判断。Codex 原生 Responses、Claude Code 原生 Messages；其它 API 的兼容入口默认关闭，用户显式覆盖保留。
- 已绑定供应商预设的模型详情只展示自动确定的协议，移除不受约束的八项下拉；手工自定义连接保留高级编辑。
- 验证为界面组件、保存后标准 Provider 投影、Pi 原生路由与 Claude/通用转换器的自动测试，不等于真实账号付费请求验证。当前运行的 Electron 仍来自旧 unified-provider-catalog 工作区，本轮未启动或切换 DEV。

## 四类请求语言与公共兼容层集成（2026-09-13）

测试工作区集成 `opencodex-compatibility` 的 `3aed76f0c`（用户的公共兼容层 PR），复用其供应商修正与现有桥接入口，不另建兼容服务。`model-compat/protocol` 是纯类型与选择逻辑入口，模型目录只依赖该轻量入口，不把上游补丁实现打包进 Renderer。

已声明的同模型、同来源且鉴权头一致的多个接口，可优先选当前 Harness 原生语言；独立来源与自定义请求路径不自动互借。切换时沿用目标接口的上下文资料。Pi 保持其已选原生 SDK 接口，不套 Codex 工具转换。

用户侧四类为 Messages、Responses、Chat Completions、Google Gemini；Azure Responses 与 Vertex 归对应请求语言。Bedrock Converse 与 Mistral Conversations 没有被伪装成这四类，它们仍是内部 SDK 路径，在管理器只显示支持状态，不增加语言选项。协议选项由 UI 回归核对恰好四项。

验证：兼容包 204、目录 934、三个桥接/代理包合计 788 项通过；Desktop 定向 400 项通过，另有既有跳过。受影响包类型检查通过。没有真实账号付费生成请求。本机许可证全量再生成缺 Cargo，已按两侧版本合并 Pi 0.85.1 与 OpenCodex MIT 声明并核对 SPDX 引用，无 dangling references。

新隔离测试版 `dev2-provider-four-api` 已取得 `DESKTOP_DEV_VERDICT=ready`，工作区为 `cindy-provider-native-defaults`。旧测试工作区保留；新档案需重新登录、导入渠道，真实账号首次导入由用户继续验收。没有推送、发布或合并原 PR。
