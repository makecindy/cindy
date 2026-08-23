/**
 * modelAccess.ts — 网关凭据自动下发(model-access-server)的 main / renderer 共享类型。
 *
 * 背景:个人用户与已接入企业登录后,由服务端的
 * model-access-server 自动下发 LLM 网关推理 endpoint + 用户专属 api key,
 * 取代手填 key;手填保留为灰度/故障兜底。服务端契约见服务端仓
 * docs/model-access-server.md。
 */

/** 凭据同步状态机(main 侧 credentialsSync 维护,经 push 通道广播给 renderer)。 */
export type ModelAccessSyncState =
  /** 未登录 / 尚未触发同步。 */
  | 'idle'
  /** 正在向 model-access-server 拉取凭据(含自动重试期间)。 */
  | 'syncing'
  /** 已成功下发并落盘(source='server')。 */
  | 'ok'
  /** 拉取失败(网络/服务端错误/落盘失败),本地既有 key 不受影响;可手动重试。 */
  | 'failed'
  /** 服务端未启用(503 MODEL_ACCESS_DISABLED,灰度关闭)——走手填兜底,不重试。 */
  | 'disabled'
  /** 企业未接入(403 ORG_NOT_SUPPORTED)——XD 网关不可用,不显示手填入口,不重试。 */
  | 'unsupported';

/** 当前生效的 XD 网关凭据来源:服务端下发 / 用户手填;null = 无标记(历史手填或未配置)。 */
export type ModelAccessCredentialSource = 'server' | 'manual';

export interface ModelAccessStatus {
  state: ModelAccessSyncState;
  /** state='failed' 时的错误码(ServerApiError code / 'SAFE_STORAGE_UNAVAILABLE')。 */
  errorCode?: string;
  /** 当前生效凭据的来源标记。 */
  source: ModelAccessCredentialSource | null;
  /** source='server' 时下发的推理 endpoint(展示用;消费一律走 main 侧 getter)。 */
  endpoint: string | null;
}

/** 当前登录身份在 AIGateway Credit Ledger 中的同一时点余额快照。 */
export interface ModelAccessBalance {
  planCredits: string;
  purchasedCredits: string;
  promotionalCredits: string;
  available: string;
  scale: 9;
  observedAt: string;
}

export interface ModelAccessCreditPoolUsage {
  remaining: string;
  used: string | null;
  total: string | null;
}

export type ModelAccessPromotionalGrantState = 'active' | 'depleted' | 'expired' | 'voided';

export interface ModelAccessPromotionalGrantUsage {
  grantId: string;
  displayName: string | null;
  originalAmount: string;
  usedAmount: string;
  remainingAmount: string;
  expiresAt: string;
  state: ModelAccessPromotionalGrantState;
}

/** Gateway 账本的当前额度、三类用量和逐笔赠送只读投影。 */
export interface ModelAccessCreditUsage {
  available: string;
  plan: ModelAccessCreditPoolUsage;
  purchased: ModelAccessCreditPoolUsage;
  promotional: ModelAccessCreditPoolUsage;
  promotionalGrants: ModelAccessPromotionalGrantUsage[];
  /** false 表示 Gateway 历史超过 Server 的安全分页上限，列表只含最近记录。 */
  promotionalGrantsComplete: boolean;
  /** 当前逐笔赠送与总余额来自同一次 Gateway 额度快照。 */
  promotionalGrantConsistency: 'OBSERVED';
  ledgerUpdatedAt: string | null;
  scale: 9;
  observedAt: string;
}

/** main → renderer 的状态推送通道。 */
export const MODEL_ACCESS_STATUS_CHANNEL = 'model-access:status-change';

/**
 * 服务端下发的网关聊天模型条目(model-access-server GET /models):
 * 上游 model-groups 的公开字段 + 服务端生成的旧客户端兼容字段。
 * 新字段优先转换为客户端 Catalog 能力；字段缺失时才回退兼容字段。
 */
/** 单个 runtime tab 上与基线不同的能力字段(服务端 perAgent 覆盖块,客户端按 agent 应用)。 */
export interface ModelAccessAgentOverride {
  contextWindow?: number;
  efforts?: string[];
  defaultEffort?: string | null;
  supportsFastMode?: boolean;
  defaultEnabled?: boolean;
  /** v3/v4 runtime transport; required by the contract for every listed Agent. */
  wireProtocol?: 'anthropic-messages' | 'openai-responses';
}

export interface ModelGroupTieredPricing {
  range: [number, number];
  inputCostPerToken?: number;
  outputCostPerToken?: number;
  cacheReadInputTokenCost?: number;
  cacheCreationInputTokenCost?: number;
}

/**
 * model-access-server 从 AIGateway /model-groups 白名单透传的价格字段。
 * 字段名和数值保持 Gateway 原样（per token）；Desktop 在构建 quote 时才转
 * per-million-token。Cindy AI Gateway 的缺省币种由运行区域决定：CN 为 CNY，
 * Global 为 USD。
 */
export interface ModelGroupPricing {
  costDiscount?: number;
  inputCostPerToken?: number;
  outputCostPerToken?: number;
  inputCostPerTokenPriority?: number;
  outputCostPerTokenPriority?: number;
  cacheReadInputTokenCost?: number;
  cacheReadInputTokenCostPriority?: number;
  cacheCreationInputTokenCost?: number;
  inputCostPerTokenAbove200kTokens?: number;
  outputCostPerTokenAbove200kTokens?: number;
  cacheReadInputTokenCostAbove200kTokens?: number;
  inputCostPerTokenAbove200kTokensPriority?: number;
  outputCostPerTokenAbove200kTokensPriority?: number;
  cacheReadInputTokenCostAbove200kTokensPriority?: number;
  inputCostPerTokenAbove272kTokens?: number;
  outputCostPerTokenAbove272kTokens?: number;
  cacheReadInputTokenCostAbove272kTokens?: number;
  inputCostPerTokenAbove272kTokensPriority?: number;
  outputCostPerTokenAbove272kTokensPriority?: number;
  cacheReadInputTokenCostAbove272kTokensPriority?: number;
  inputCostPerCharacter?: number;
  outputCostPerCharacter?: number;
  inputCostPerSecond?: number;
  outputCostPerSecond?: number;
  inputCostPerAudioToken?: number;
  outputCostPerAudioToken?: number;
  inputCostPerAudioPerSecond?: number;
  outputCostPerAudioPerSecond?: number;
  inputCostPerImage?: number;
  outputCostPerImage?: number;
  inputCostPerImageToken?: number;
  outputCostPerImageToken?: number;
  cacheReadInputImageTokenCost?: number;
  inputCostPerVideoPerSecond?: number;
  outputCostPerVideoPerSecond?: number;
  tieredPricing?: ModelGroupTieredPricing[];
}

/**
 * Model Access Server 下发的模型条目。
 *
 * 同一含义只有一个字段:Gateway 的能力字段(contextLength / maxInputTokens /
 * supportedEndpoints / reasoning / supportsServiceTier / architecture)由服务端一次
 * 归一化成这里的 contextWindow / agents / efforts + defaultEffort / supportsFastMode /
 * modalities,上游原名字段不下发、客户端也不再二次转换(见 model-access/index.ts 的
 * applyGatewayModels)。旧版服务端只给归一化字段,语义相同,故无需兼容分支。
 *
 * 其中 contextLength 与 maxInputTokens 在 Gateway 侧本就同值(文档:contextLength
 * currently mirrors maxInputTokens),统一由 contextWindow 表达。
 */
export interface ModelAccessGatewayModel extends ModelGroupPricing {
  id: string;
  /**
   * Gateway 原生 mode(issue #882:权威分类字段,字段值不改名)。原样透传,可能
   * 缺省(旧缓存 / 服务端尚未覆盖到的模型)——**不代表**本条目已被服务端判定
   * 为聊天模型,是否可进 Agent availableModels 仍由客户端 isChatEligible 判定
   * (mode==='chat' 才算;缺省时回退 classification.ts 的 id 正则兜底),见
   * @cindy/model-providers classifyModel / isChatEligible。
   */
  mode?: string;
  /**
   * Gateway 原生价格币种,是该账号计价与记账的权威来源;旧版服务端未下发时才按
   * 运行区域回退。它不保证等于构建区域 —— 结算币种由服务端按账号所属租户下发,
   * 消费方一律以本字段(或其派生的 currentLedgerCurrency)为准,不按区域推断。
   */
  currency?: 'USD' | 'CNY';
  /** 进哪些 runtime tab；Desktop 固定使用 v3，本字段由服务端明确下发。 */
  agents?: ('claude-code' | 'codex' | 'pi')[];
  name?: string;
  group?: string;
  description?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  /** 输入 / 输出模态(服务端由 Gateway architecture 归一化而来)。 */
  modalities?: { input: string[]; output: string[] };
  efforts?: string[];
  defaultEffort?: string | null;
  sortOrder?: number;
  /** Fast(加速档)支持；缺省表示服务端未声明，客户端不物化能力。 */
  supportsFastMode?: boolean;
  /** 是否默认出现在模型选择器;缺省按 true(默认可见)。 */
  defaultEnabled?: boolean;
  /**
   * 该模型是哪些 agent 的**新对话默认种子**（源自协议 ListModels v2 的 newSessionDefault，
   * 服务端权威、按区域下发)。与 sortOrder / defaultEnabled 独立;客户端据它选新对话默认。
   * 缺省 = 不作为任何 agent 的默认。
   */
  newSessionDefault?: ('claude-code' | 'codex' | 'pi')[];
  /**
   * 展示图标 id(AI Gateway 侧登记,见 @cindy/model-providers CatalogModel.icon /
   * resolveModelIconKind);缺省或未知值客户端回落来源供应商标。
   */
  icon?: string;
  /** per-tab 能力覆盖(基线字段之上按 agent 应用)。 */
  perAgent?: Partial<Record<'claude-code' | 'codex' | 'pi', ModelAccessAgentOverride>>;
}

/**
 * Consumer-side Bean for `GET /api/model-access/models`.
 *
 * The client intentionally owns this tolerant view: legacy responses may omit
 * fields that the current server always emits, while unknown schema versions
 * remain a runtime-parser concern.
 */
export interface ModelAccessModelsResponse {
  schemaVersion: 1 | 2 | 3 | 4;
  models: ModelAccessGatewayModel[];
}
