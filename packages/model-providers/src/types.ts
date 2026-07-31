/**
 * @cindy/model-providers — 类型定义。
 *
 * 形状对齐 models.dev（OpenCode 同源）：provider 为单位、每个 model 带
 * cost / limit / modalities / 能力 / release_date / status。在此之上加两处
 * **provider 级多 agent 扩展**（因为 xdt-maker 不直连模型、而是把请求透过 Claude
 * Code / Codex 二进制 + 本地代理路由，与 OpenCode 的直连 SDK `npm`/`api` 不同）：
 *   - provider 级 `agents`：这家供应商能用在哪些 agent runtime；直接决定它的
 *     模型出现在哪个 agent 的模型列表里。
 *   - provider 级 `routing`：按 runtime 的「路由描述符」——决定请求最终发去哪个
 *     上游、用哪种钥匙、model id 是否需要还原。这是给通用路由器（host 侧，见
 *     apps/desktop maker-host）消费的数据，替代过去硬编码的 decideXxxRoute。
 *
 * model 按 agent 分组挂在 `Provider.models[agent]` 下：目录是 per-agent 模型清单的
 * 唯一来源(SSoT)，host 从中派生 maker-core 的 capabilities.availableModels。
 *
 * 本包零运行时依赖：`AgentKind` / `Effort` 在此就地定义（与 maker-core 的同名
 * 联合保持一致），不 import maker-core，保证可作为独立能力复用。
 */

/** 承载模型的 agent runtime —— 与 maker-core AgentKind 对齐。 */
export type AgentKind = 'claude-code' | 'codex';

/** 推理强度档位 —— 与 maker-core Effort 对齐。 */
export type Effort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';

/** Provider runtime 上游实际接受的推理 wire protocol。 */
export type ProviderWireProtocol =
  | 'anthropic-messages'
  | 'openai-responses'
  | 'openai-chat';

/** Codex 通过本地 bridge 兼容的两种非原生 Responses wire protocol。 */
export type CodexCompatibilityWireProtocol = Extract<
  ProviderWireProtocol,
  'anthropic-messages' | 'openai-chat'
>;

/** 供应商来源：内置 vs 用户自定义（自定义本轮不实现，类型先留位）。 */
export type ProviderSource = 'builtin' | 'user';

/** 用户连接该供应商的鉴权方式（决定设置页的连接 UI）。
 *  - oauth   : 走 OAuth 登录（Claude.ai 订阅 / Codex 订阅）
 *  - apiKey  : 用户手填 API key
 *  - managed : 由平台托管 / 自动下发（XD 网关 key 登录后自动同步）
 *  - none    : 上游不要求客户端鉴权（本机 LiteLLM / Ollama 等受信代理）
 */
export type AuthMethod = 'oauth' | 'apiKey' | 'managed' | 'none';

/**
 * 模型额度的来源（展示 / 产品语义），与 `auth` 的连接协议刻意分开：
 * OAuth 不必然代表订阅，API key 也不应靠模型名或图标推断。
 */
export type ProviderAccess =
  | { kind: 'subscription'; product: string }
  | { kind: 'api' }
  | { kind: 'managed' };

/**
 * 通用路由器消费的「钥匙策略」——决定一笔请求到达上游时的鉴权头怎么处理。
 * 具体到某 runtime 的 header 落地（x-api-key vs Bearer、是否删 anthropic-beta、
 * 是否透传 chatgpt-account-id）由该 runtime 的代理实现，本字段只表达意图：
 *   - oauth-passthrough : 直连供应商自家上游，透传二进制已带的 OAuth bearer。
 *   - provider-oauth-header : 直连供应商自家上游，但用 host 保存的该供应商 OAuth token
 *     覆盖 Authorization；用于子进程 OAuth 不属于目标供应商的场景
 *     （如 Codex → xAI / Claude.ai subscription）。
 *   - api-key-header    : 直连供应商自家上游，用该供应商自己的 API key 覆盖鉴权头。
 *   - gateway-key       : 走 XD 共享网关，把鉴权头换成网关 key。
 *   - oauth-token       : 直连供应商自家上游，用 host 侧通用 OAuth Runner 持有的
 *                         access_token 覆盖鉴权头（`Authorization: Bearer`）。与
 *                         oauth-passthrough 的区别：token 不来自 agent 二进制自带凭证，
 *                         而来自目录 `auth.oauth` 描述符驱动的登录（见 OAuthProviderDescriptor）。
 *   - none              : 直连无需鉴权的受信上游；代理必须剥掉 agent 自带的鉴权与账号头，
 *                         防把 Claude.ai / ChatGPT 订阅凭证泄漏给本地或自托管服务。
 */
export type AuthStrategy =
  | 'oauth-passthrough'
  | 'provider-oauth-header'
  | 'api-key-header'
  | 'gateway-key'
  | 'oauth-token'
  | 'none';

/**
 * 授权（OAuth）供应商描述符 —— 让「接一家标准 OAuth 供应商」退化成目录数据。
 *
 * 承载标准 authorization-code + PKCE 或 OAuth 2.0 Device Authorization Grant 的同构参数；
 * 深度定制（spawn CLI 登录、auth.json reconcile、JWT claim 提头等）保持 host 侧 bespoke
 * 实现，不进描述符（规则 9：确定性逻辑写代码，描述符只承载真正同构的部分）。host 的
 * 通用 OAuth Runner（generic-oauth）消费本描述符完成授权、safeStorage 存储与单飞刷新；
 * 路由侧配合 `authStrategy: 'oauth-token'` 注入 Bearer。
 */
interface OAuthProviderDescriptorBase {
  /** token 交换端点（token_endpoint，form-encoded POST）。 */
  tokenUrl: string;
  /** OAuth client id（公共客户端，PKCE 保护，无 secret）。 */
  clientId: string;
  /** 请求的 scopes（空格分隔）。 */
  scopes: string;
  /**
   * 动态模型发现端点（可选）。登录成功后 host 带 Bearer GET 此 URL，响应按 OpenAI
   * `GET /models` 形状（`{data:[{id}]}` 或 `{models:[...]}`）解析，additions-only
   * merge 进 active-catalog（静态条目 first-wins，发现条目只增不改删）。
   */
  modelsDiscoveryUrl?: string;
}

export interface OAuthAuthorizationCodeDescriptor extends OAuthProviderDescriptorBase {
  /** 缺省保持历史目录兼容；等价于 `authorization-code`。 */
  flow?: 'authorization-code';
  /** 授权端点（authorization_endpoint）。 */
  authorizeUrl: string;
  /**
   * 回环回调端口。多数供应商注册的 redirect_uri 是固定端口
   * （`http://127.0.0.1:<port>/callback`）；缺省 = 随机高位端口（供应商允许通配端口时用）。
   */
  redirectPort?: number;
  /** 追加到授权 URL 的额外 query 参数（如厂商自定义的 plan / referrer）。 */
  extraAuthParams?: Record<string, string>;
  deviceAuthorizationUrl?: never;
  extraDeviceParams?: never;
}

export interface OAuthDeviceCodeDescriptor extends OAuthProviderDescriptorBase {
  flow: 'device-code';
  /** 申请 device_code / user_code 的端点（device_authorization_endpoint）。 */
  deviceAuthorizationUrl: string;
  /** 追加到设备授权 POST body 的厂商参数。 */
  extraDeviceParams?: Record<string, string>;
  authorizeUrl?: never;
  redirectPort?: never;
  extraAuthParams?: never;
}

export type OAuthProviderDescriptor =
  | OAuthAuthorizationCodeDescriptor
  | OAuthDeviceCodeDescriptor;

/**
 * 路由描述符（per provider × runtime）。喂给 host 侧通用路由器，决定请求的
 * 真实上游 + 鉴权 + model id 还原。加新供应商 = 加这份数据，不改路由器代码。
 */
export interface RoutingDescriptor {
  /**
   * 上游 wire protocol。缺省按 agent 保持历史语义：Claude Code = anthropic-messages，
   * Codex = openai-responses。Codex 的 openai-chat / anthropic-messages 会分别进入
   * 对应的本地 Responses bridge。
   */
  wireProtocol?: ProviderWireProtocol;
  /** 真实上游 base URL（direct 时是供应商自家；gateway 时是 XD 网关 base）。 */
  upstream: string;
  /**
   * 推理请求的精确相对路径（可选，必须以单个 `/` 开头）。
   *
   * 缺省时沿用 agent 发来的标准路径（Claude `/v1/messages`、Codex `/responses`）；
   * 提供后只覆盖带 model 的推理请求，GET `/models` 等控制面请求不受影响。
   * `openai-chat` 本地桥也消费同一字段，替代缺省 `/chat/completions`。
   */
  requestPath?: string;
  /** 鉴权策略（见 AuthStrategy）。 */
  authStrategy: AuthStrategy;
  /**
   * 配置保留用于展示/修复，但运行时不得向该上游路由。用于把升级前不再满足安全边界的
   * 历史配置留在设置页，同时让所有路由解析 fail closed。
   */
  disabled?: boolean;
  /** 转发上游前还原 model id（如剥掉 `codex/` 前缀）。缺省 = 原样。 */
  modelIdRewrite?: { stripPrefix: string };
  /** 转发上游前需删除的请求头（如 gateway 路由删 `anthropic-beta`）。 */
  headerDelete?: string[];
  /** 额外固定请求头覆盖（少数特例用；多数由 authStrategy 隐含）。 */
  headerOverride?: Record<string, string>;
  /** 可选 quirk 适配钩子名（对齐 OpenCode custom loader，承接无法纯数据表达的特例）。 */
  adapter?: string;
  /**
   * 自定义供应商的「列模型」端点回带（可选）。路由器**不消费**本字段——它只是把
   * `CustomProviderRuntimeConfig.modelsUrl` 带进 Provider/ProviderView，让编辑表单
   * （providerViewToConfig 从 routing 重建配置）不丢这个持久化字段。
   */
  modelsUrl?: string;
  /**
   * 该路由能服务的 wire model id 命名空间前缀白名单（每项形如 `xai/`，必须以 `/` 结尾）。
   *
   * 声明后，per-session 路由只捕获命中前缀的请求；未命中的请求（典型：agent CLI 内部
   * 用 claude-* 小模型发起的辅助调用，如权限 auto 模式的安全分类器）返回 null，由调用方
   * 回落 spawn 默认路由（网关 / Anthropic 直连），而不是被误送到无法服务它的上游。
   *
   * 缺省 = 不限（universal）：网关、Anthropic 直连、自定义供应商等「上游本身能服务任意
   * 模型」的路由不声明本字段，行为与历史版本字节级一致。
   *
   * 硬约束（catalog.test.ts 契约测试强制）：凡供应商在某 agent 下的模型清单**整体**活在
   * `<ns>/` 命名空间（桥接型订阅直连，如 xai/ / chatgpt/），该 agent 的路由必须声明本字段，
   * 且前缀集合覆盖全部声明的模型 id —— 新增这类供应商时忘声明会被测试直接拦下。
   */
  modelPrefixes?: string[];
}

/** 模型计费（$/1M tokens）。可选——OSS 目录可后补，缺值 UI 不展示价格。 */
export interface ModelCost {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/**
 * 单个模型条目 —— **目录是 per-agent 模型清单的唯一来源(SSoT)**。
 *
 * 模型按 agent 分组挂在 `Provider.models[agent]` 下(见 Provider.models)。host 从本目录
 * 派生 maker-core 的 `capabilities.availableModels`(per-agent),不再有写死的 CLAUDE_MODELS /
 * CODEX_MODELS。因此本结构承载该模型在**该 agent 下**的全部权威元数据。
 *
 * 注：同一 id 在不同 agent 下元数据可不同 —— 典型 gpt-5.5(cc=1M / codex=272k 上下文)。
 * per-agent 拆分正是为了表达这种分歧:各 agent 列表里各写各的值。同一 agent 内、同一 id
 * 跨 provider(如 gpt-5.5 同时由 openai 与 xd 提供)则必须元数据一致(见 catalog.ts 校验)。
 */
export interface CatalogModel {
  /** 与 maker-core 现有 model id 一致（如 'claude-opus-4-8' / 'gpt-5.5' / 'codex/gpt-5.5'）。 */
  id: string;
  /** 展示名（= maker-core ModelDescriptor.displayName）。 */
  name: string;
  description?: string;
  family?: string;
  /**
   * 厂商分组 id —— 决定模型在选择器右栏的分组归属（替代渲染层按 id 前缀硬猜）。
   * 当前取值与渲染层 ModelCategory 对齐：'anthropic' | 'gpt' | 'gpt-budget' | 'google' | 'china'。
   * 缺省时渲染层回退到 id 前缀归类（categorize）。新增未知分组需在渲染层补 i18n 标签。
   */
  group?: string;
  /**
   * Gateway 原生模型能力类型(issue #882:'chat' / 'embedding' / 'image_generation' /
   * 'audio_speech' / ... ,字段值不改名,原样透传)。是否为聊天模型、进哪个
   * ModelMode 展示分类均以此为权威;缺省时回退 id 正则兜底
   * (`classification.ts` classifyModel)。只有 XD 网关来源目前会填充,静态
   * 内置目录留空。
   */
  mode?: string;
  /**
   * 展示排序权重（升序）。渲染层按它对模型排序、并据每个分组的最小 sortOrder 决定分组先后。
   * 缺省排到末尾。仅影响选择器展示顺序，不影响 host 派生的 availableModels 数组序（后者保序）。
   */
  sortOrder?: number;
  /** 上下文窗口（tokens）。该 agent 下的权威值(host 派生进 ModelDescriptor.contextWindow)。 */
  contextWindow: number;
  /**
   * `contextWindow` 是否为**显式声明**的真实上限,而非派生时补的兜底值。
   *
   * 目录条目的窗口可能来自产品目录写定 / 上游明示 / 用户填写(都算显式),也可能是
   * 上游不给元数据时补的常量(codex `model/list` 一律 272K、自定义 provider 未填时的
   * 200K、Anthropic 未知模型启发式)。两者数值上无法区分,但只有前者能用来收敛
   * 运行期上报的窗口 —— 拿兜底值当上限会把真实窗口压小。
   *
   * 缺省(undefined)一律按未核实处理。
   *
   * **这份 provenance 只活在 host 侧的目录里,刻意不进跨端 `ModelDescriptor`**
   * (host 的 `toDescriptor` 不透传它)。原因:`availableModels` 是跨 provider union +
   * 首见去重的扁平表,同一 model id 由多个 provider 提供时归属已丢,按 id 回查会命中
   * 另一条路由的元数据 —— 拿错路由的上限去收敛比不收敛更糟。收敛统一走
   * maker-core 的 `AgentDeps.resolveVerifiedContextWindow`,由 host 按
   * (providerId, modelId) 解析。
   */
  contextWindowVerified?: boolean;
  maxOutput?: number;
  /** 支持的 effort 档；空数组 = 不支持切换（如 Haiku / 部分 provider-managed 模型）。 */
  efforts: Effort[];
  /**
   * Model-specific effort 显示名覆盖（= maker-core ModelDescriptor.effortDisplayNames）。
   * 缺省时回退统一档名词表(桌面 i18n `effortLevels.*` / 手机 MOBILE_EFFORT_LABELS)→
   * agent 级 effortLevels。当前 catalog 无覆盖项(2026-07 档名统一后清空),机制保留。
  */
  effortDisplayNames?: Partial<Record<Effort, string>>;
  /** 默认 effort；null = 不支持。 */
  defaultEffort: Effort | null;
  /**
   * 该模型在**该 (provider, agent) 下**是否支持 Fast Mode —— Fast 能力的**唯一真相**。
   *
   * 因为模型按 (provider, agent) 嵌套（见 Provider.models），本字段天然 per-provider：
   * **同一 model id 在不同 provider 下取值可以不同**，用来表达「这个来源能不能真正交付 fast」。
   * 典型：opus 走官方 Anthropic 直连可 fast ⇒ 该条目 `true`；某网关会剥掉承载 fast 的请求字段
   * （cc 的 `anthropic-beta` 头 / codex 的 `serviceTier`）⇒ 那个 provider 下的同名条目应配 `false`。
   * 故意**不纳入** catalog.ts 的跨供应商一致性校验（`modelSignature`），正是为放行这种分叉。
   *
   * **是否真的显示开关还要叠上 agent 运行时粗粒度 gate**：
   * 实际可用 = `model.supportsFastMode && agent.capabilities.hasFastMode`。UI 取实际可用性时
   * 必须按「当前生效来源」现查本字段（见 registry.ts `sessionModelSupportsFastMode`），
   * 不能读跨 provider 拍平去重后的列表（那只保留首个 provider 的值，会错）。
   */
  supportsFastMode?: boolean;
  /**
   * 该模型在 Codex 下使用的模型级兼容 bridge 协议。
   *
   * 通常 wire protocol 由 Provider.routing.codex 决定；只有同一 Provider 内不同模型
   * 需要走不同 Codex wire 时才写本字段。典型是 XD：服务端原生声明 Codex 的模型走
   * Responses，只声明 Claude Code 的模型投影进 Codex 后走 Anthropic Messages bridge。
   *
   * 这是按 agent 嵌套的目录元数据，不代表模型能力；缺省时回落 Provider 级路由。
   */
  codexCompatibilityWireProtocol?: CodexCompatibilityWireProtocol;
  /**
   * 展示图标 id —— 模型行 / composer 药丸上显示什么图标,**以 AI Gateway / 目录设定为准**
   * (XD 模型经 model-access-server GET /models 下发,其它供应商可由 OSS 目录配置)。
   * 已知取值见 sections.ts `resolveModelIconKind`('claude' | 'codex' | 'cindy' 及别名);
   * 缺省或未知值 ⇒ 客户端回落该行来源供应商标(ProviderMark),桌面与手机同一套规则。
   * 故意**不纳入** `modelSignature` 跨供应商一致性校验:同一 model id 在不同供应商下
   * 允许配不同图标(与 supportsFastMode / defaultEnabled 同理)。
   */
  icon?: string;
  cost?: ModelCost;
  modalities?: { input: string[]; output: string[] };
  capabilities?: {
    reasoning?: boolean;
    toolCall?: boolean;
    attachment?: boolean;
    temperature?: boolean;
  };
  releaseDate?: string;
  status?: 'active' | 'alpha' | 'deprecated';
  /**
   * 该模型在「设置 → 模型供应商」展开列表里**默认是否开启显示**（缺省 ⇒ true，即默认开）。
   *
   * 这是**系统默认值**，不是用户选择：用户在设置页的开关是本地 override（见 renderer 的
   * modelVisibilityPrefs），未被用户显式 override 的模型跟随本字段。语义天然 per-agent ——
   * 模型已按 agent 嵌套在 `Provider.models[agent]` 下，同名模型(如 gpt-5.5 在 cc / codex)
   * 各写各的默认。设为 false = 该模型默认不出现在模型选择器,用户可在设置页手动打开。
   *
   * 故意**不纳入** catalog.ts 的 `modelSignature` 跨供应商一致性校验：同一 model id 在不同
   * 供应商下可有不同默认(如某来源默认隐藏长尾模型),与「运行时元数据必须一致」是两回事。
   * 新增模型缺省 = 默认开,符合「未自定义用户随版本吃到新默认」(CLAUDE.md 规则 20)。
   */
  defaultEnabled?: boolean;
  /**
   * **视图层字段**:该 (供应商, 模型) 已被用户「停用」(准入关,与 `defaultEnabled` 的
   * 「显示」轴正交)。由 `buildRegistry` 按 host 注入的 ModelDisableOverrides 填充,
   * 目录数据本身**不携带**本字段,也不参与 `modelSignature` 一致性校验。
   *
   * 语义:停用 = 不可被任何新路由选中(选择器 / worker 创建 / MCP 点名 / IM 兜底),
   * 由 modelList.ts 的标准派生统一过滤;已在运行的会话不受影响(keepSelected 豁免)。
   * 与「隐藏」(defaultEnabled/visibility override,仅陈列过滤、点名与兜底仍可用)不同。
   */
  disabled?: boolean;
}

/** 供应商定义。 */
export interface Provider {
  /** 'anthropic' | 'openai' | 'xd' | 未来自定义 id。 */
  id: string;
  /** 展示名。 */
  name: string;
  /** 内置 vs 用户自定义。 */
  source: ProviderSource;
  /** ★这家能用在哪些 agent；决定它出现在哪个 agent 的来源列表里 + 路由按哪个 agent 取。 */
  agents: AgentKind[];
  /**
   * 用户连接方式（连接 UI 用）。`method: 'oauth'` 且带 `oauth` 描述符 = 走 host 通用
   * OAuth Runner（generic-oauth）；不带描述符的 oauth 供应商 = host bespoke 鉴权
   * （anthropic / openai / xai 现状）。
   */
  auth: { method: AuthMethod; oauth?: OAuthProviderDescriptor };
  /** 用户使用该供应商时的额度来源；旧目录可缺省，由 source 从 bundled 同 id 条目补齐。 */
  access?: ProviderAccess;
  /**
   * 该供应商用于「起会话标题」一次性轻任务的最经济模型 id（须存在于本供应商任一 agent 的
   * `models` 里）。host 侧标题 oneShot（见 apps/desktop title-one-shot）按本字段选模型、取该
   * 模型在目录里的最低 effort 档、走单次 HTTP 请求生成标题。缺省 = 该供应商不参与智能起名
   * （调用方回落到「消息前 N 字」启发式）。
   */
  titleModel?: string;
  /** ★路由描述符，按 agent 索引（供应商可同时供多个 agent）。 */
  routing: Partial<Record<AgentKind, RoutingDescriptor>>;
  /**
   * ★该供应商提供的模型清单，**按 agent 分组**（同 id 在不同 agent 下元数据可不同，
   * 如 gpt-5.5 cc=1M / codex=272k）。`agents` 里声明的每个 agent 都应有对应数组（见 catalog.ts 校验）。
   */
  models: Partial<Record<AgentKind, CatalogModel[]>>;
  /**
   * 该供应商提供的**图像生成/编辑模型**清单(不挂 agent——图像模型不经
   * agent runtime,由主机图像通道直调)。与聊天模型同一目录同一热更机制:
   * 消费方为意识 cindy 槽(白名单 + 详情页下拉)。
   * 可选字段,additions-only,老版本 App 忽略之。
   * `disabled` 是视图层字段(与 CatalogModel.disabled 同语义):buildRegistry 按用户
   * 停用 override 烘焙,设置页据此渲染专属媒体条目的停用状态;目录数据本身不携带。
   */
  imageModels?: { id: string; name: string; disabled?: boolean }[];
  /**
   * 图像能力的默认选型(与 imageModels 配套;值必须是 imageModels 里的 id):
   * - standard:未指定任何偏好时的默认模型(意识 cindy 槽"默认"档的真身);
   * - draft / best:档位意图的翻译表(缺省回落 standard)。
   * 默认选型是主机资产:改这里(OSS 热更)即可整体切换所有"跟随默认"的
   * 消费方,代码零模型字面量。
   */
  imageDefaults?: { standard: string; draft?: string; best?: string };
  /**
   * 该供应商提供的**视频生成/编辑模型**清单(与 imageModels 同地位:
   * 不挂 agent,由主机视频通道直调,id 即 video provider 层的 alias)。
   * 消费方为意识 cindy 槽(白名单 + 详情页下拉)。可选,additions-only。
   * `disabled` 同 imageModels:视图层停用标志,buildRegistry 烘焙。
   */
  videoModels?: { id: string; name: string; disabled?: boolean }[];
  /**
   * 视频能力的默认选型(与 videoModels 配套;值必须是 videoModels 里的 id;
   * 语义同 imageDefaults:standard 必填,draft/best 缺省回落 standard)。
   */
  videoDefaults?: { standard: string; draft?: string; best?: string };
}

/**
 * 供应商预设 / 用户自定义 runtime 的模型配置。
 *
 * contextWindow 缺省时由 `buildUserProvider` 使用保守默认；预设可显式携带厂商文档确认的值，
 * 并随用户配置持久化，避免已知长上下文模型被错误降级。
 */
export interface ProviderRuntimeModelConfig {
  id: string;
  name: string;
  contextWindow?: number;
  /** 模型未被用户显式开关时的可见性；缺省保持历史行为（默认可见）。 */
  defaultEnabled?: boolean;
}

/**
 * 供应商预设的单 runtime 预填数据（「从模板创建自定义供应商」用）。
 * 形状对齐 `CustomProviderRuntimeConfig`：选中预设 = 把这段数据灌进创建表单，用户只补 API key。
 */
export interface ProviderPresetRuntime {
  /** 上游 wire protocol；缺省由 runtime agent 推导（Codex=Responses，Claude=Messages）。 */
  wireProtocol?: ProviderWireProtocol;
  /** 该 runtime 的兼容端点 base URL（cc=Anthropic 兼容 / codex=OpenAI Responses 兼容）。 */
  baseUrl: string;
  /** 非标准推理端点的相对路径；缺省由 wire protocol 推导。 */
  requestPath?: string;
  /** 推荐模型清单（预填进表单，用户可增删改）。 */
  models: ProviderRuntimeModelConfig[];
  /** 可选预填请求头。 */
  headers?: Record<string, string>;
  /**
   * 可选的「列模型」端点（表单「获取模型列表」用；缺省由 baseUrl 推导 `…/v1/models`）。
   * 用于推理 baseUrl 与列模型端点不同源的厂商——如 Moonshot 的 cc baseUrl 是
   * `…/anthropic`，但列模型接口只在 `https://api.moonshot.cn/v1/models`（同一 key 可用）。
   */
  modelsUrl?: string;
  /**
   * 允许添加向导编辑预填 base URL。仅用于本机 / 自托管网关类预设；普通官方渠道保持只读，
   * 防用户无意改坏已核验端点。
   */
  baseUrlEditable?: boolean;
}

/**
 * 供应商预设 —— 降低自定义供应商接入摩擦的**纯 UI 模板数据**（不参与路由 / 不是 Provider）。
 *
 * 与 `Provider` 的区别：预设只在「创建自定义供应商」对话框里消费，选中即快照进用户自己的
 * `CustomProviderConfig`，之后与预设脱钩（预设更新不回写已创建的供应商，override 语义）。
 * 数据随目录走 OSS 热更：各家 baseUrl / 模型 id 变化只需推数据，无需发版。
 */
export interface ProviderPreset {
  /** 预设 id（小写 slug，仅用于 UI 去重 / 埋点，不占用 provider id 命名空间）。 */
  id: string;
  /** 展示名（如 "OpenRouter" / "DeepSeek"）。 */
  name: string;
  /**
   * 国际化展示名（可选）：`name` 为中文的国内厂商预设（如「智谱 GLM（中国大陆）」）
   * 在非中文 UI 用它展示，缺省回落 `name`。展示选择见 `presetDisplayName`。
   */
  nameEn?: string;
  /** 官方接入文档链接（表单里展示可点）。 */
  docsUrl?: string;
  /**
   * 区域提示（可选）：'cn' = 中国大陆端点，'global' = 国际端点。
   *
   * **只影响呈现排序，不是过滤开关**：UI 按应用语言智能排序（zh-CN 用户 cn 靠前，
   * 其它语言 global 靠前，见 `sortPresetsForLocale`），两边始终都可见可选——用户永远
   * 不需要回答「你在哪个地区」，可达性由「测试连接」实测裁决。缺省 = 区域中立
   * （单端点全球服务的厂商，如 OpenRouter / DeepSeek），排序时居中。
   */
  regionHint?: 'cn' | 'global';
  /**
   * 预设的鉴权形态。缺省 = API key；`none` 用于明确不要求客户端凭证的本机 / 自托管代理。
   * 创建后会快照进 CustomProviderConfig，不随预设后续更新。
   */
  authMethod?: 'apiKey' | 'none';
  /** per-runtime 预填数据（至少一个）。 */
  runtimes: Partial<Record<AgentKind, ProviderPresetRuntime>>;
}

/** 完整目录（OSS / 本地 / 内置 三处都是这个形状）。 */
export interface Catalog {
  /** 目录版本号（语义随意，仅用于诊断 / 缓存比对）。 */
  version: string;
  providers: Provider[];
  /**
   * 自定义供应商创建模板（可选）。容错语义：解析时逐条校验、坏条目丢弃（见 catalog.ts
   * `sanitizePresets`），绝不因预设数据错误导致整份远端目录回退 bundled。
   */
  presets?: ProviderPreset[];
  /**
   * model-access-server 的网关模型元数据远程覆盖表（`{ version: 1, models: {...} }`
   * 信封，schema 归服务端所有故此处不建型）。消费方：
   *   - 服务端热加载（XD 网关模型元数据权威）；
   *   - 客户端 **anthropic 动态发现的元数据基线**（active-catalog 合并时用
   *     name/group/sortOrder/description/defaultEnabled 覆盖发现条目；动态通道未下发
   *     capability 时，efforts/defaultEffort 作为能力基线；上游显式能力始终优先；
   *     version !== 1 整段忽略）；
   *   - dev 模式下本地覆盖服务端下发的 XD 模型元数据以便自测
   *     （apps/desktop model-access devMetaOverlay，packaged 不走该覆盖）。
   */
  cindyModelMeta?: unknown;
}

/**
 * 用户自定义供应商在**单个 runtime（agent）下**的配置（不含密钥）。
 *
 * 一个 baseURL 通常只说一种协议：Claude Code↔Anthropic / Codex↔OpenAI。某厂商若同时提供
 * 两种端点，则两个 runtime 各有独立的 baseURL / 模型 / headers（见 CustomProviderConfig.runtimes）。
 */
export interface CustomProviderRuntimeConfig {
  /** 上游 wire protocol；缺省由 runtime agent 推导（Codex=Responses，Claude=Messages）。 */
  wireProtocol?: ProviderWireProtocol;
  /** 该 runtime 的兼容上游 base URL（cc=Anthropic 端点 / codex=OpenAI 端点）。 */
  baseUrl: string;
  /** 非标准推理端点的相对路径；缺省由 wire protocol 推导。 */
  requestPath?: string;
  /** 用户模型；contextWindow 可由预设带入，缺省时由 `buildUserProvider` 补保守默认。 */
  models: ProviderRuntimeModelConfig[];
  /** 可选自定义请求头（非密钥鉴权头可放这里；API key 走 safeStorage，不放这里）。 */
  headers?: Record<string, string>;
  /**
   * 可选的「列模型」端点（「获取模型列表」按钮用；缺省由 baseUrl 推导 `…/v1/models`）。
   * 从预设创建时随 `ProviderPresetRuntime.modelsUrl` 快照进来并持久化，编辑态仍可再拉。
   */
  modelsUrl?: string;
}

/**
 * 用户自定义供应商的**持久化配置**（不含密钥）。
 *
 * 由 host 持久化（desktop: localDb `custom_providers` 表，按账号隔离），加载时经
 * `buildUserProvider`（见 user-provider.ts）展开成标准 `Provider`，与内置厂商同形状、
 * 进同一 active-catalog，供下游（路由 / 选择器 / listProviders）**统一消费**。
 *
 * **per-runtime 独立配置**：`runtimes` 按 agent 索引，每个 runtime 各有独立的 baseUrl /
 * 模型 / headers；用户在表单 Tab 里只配需要的那个，也可两个都配（该来源同时供两端）。至少一个。
 *
 * API key **不在本结构里**：按 runtime 单独存 safeStorage（`provider_key_<id>_<agent>`，机制同
 * 内置 XD 网关 key），host 路由 resolve 时按 (id, agent) 读出注入鉴权头，绝不进 catalog /
 * 绝不回传 renderer 明文。
 */
export interface CustomProviderConfig {
  /** 供应商 id，小写 slug（/^[a-z0-9_-]+$/），同账号内唯一，不撞内置 `anthropic|openai|xd`。 */
  id: string;
  /** 展示名。 */
  name: string;
  /**
   * 鉴权形态（可选，缺省 = API key，向后兼容历史配置）。
   * `method: 'oauth'` 时必须带完整 `oauth` 描述符——该供应商走 host 通用 OAuth Runner
   * 登录（凭证存 safeStorage `provider_oauth_<id>`），路由用 `oauth-token` 策略注入
   * Bearer；此形态下不再使用 per-runtime API key。
   */
  auth?:
    | { method: 'apiKey'; oauth?: never }
    | { method: 'oauth'; oauth: OAuthProviderDescriptor }
    | { method: 'none'; oauth?: never };
  /** per-runtime 独立配置（键为 agent，只含已配置的 runtime；至少一个）。 */
  runtimes: Partial<Record<AgentKind, CustomProviderRuntimeConfig>>;
}
