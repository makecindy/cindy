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
 * AIGateway /model-groups 的 mode=chat 投影(存在性 + token 上限权威)+
 * 服务端内置常量表富化(agents/展示元数据)。XD 供应商模型列表的权威来源。
 * 客户端字段优先级:本条目 > 产品目录同 id 条目 > 合成默认
 * (active-catalog setXdGatewayModels)。
 */
/** 单个 runtime tab 上与基线不同的能力字段(服务端 perAgent 覆盖块,客户端按 agent 应用)。 */
export interface ModelAccessAgentOverride {
  contextWindow?: number;
  efforts?: string[];
  defaultEffort?: string | null;
  supportsFastMode?: boolean;
  defaultEnabled?: boolean;
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
 * per-million-token。币种以条目声明的 currency 为准，未声明按 Gateway 原生
 * USD——绝不按构建区域改标或折算。
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

export interface ModelAccessGatewayModel extends ModelGroupPricing {
  id: string;
  /**
   * 本条目价格字段的计费币种声明(透传 Gateway)。缺省表示 Gateway 原生口径
   * USD;客户端不得按构建区域改标或折算——单位永远跟随下发数据。
   * 注意:本地记账账本是单币种的,只有**每个**条目都显式声明同一非 USD 币种
   * 时目录才整体切换;与目录币种冲突的声明条目不出报价(费用退回 SDK 实报
   * USD 兜底),见 modelPriceQuote.resolveGatewayCatalogCurrency。
   */
  currency?: 'USD' | 'CNY';
  /** 进哪些 runtime tab;缺省 = 仅 claude-code(网关 /v1/messages 翻译覆盖面最广)。 */
  agents?: ('claude-code' | 'codex')[];
  name?: string;
  group?: string;
  description?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  efforts?: string[];
  defaultEffort?: string | null;
  sortOrder?: number;
  /** Fast(加速档)支持;缺省按 true 处理(开了没效果无害,但不能没有)。 */
  supportsFastMode?: boolean;
  /** 是否默认出现在模型选择器;缺省按 true(默认可见)。 */
  defaultEnabled?: boolean;
  /**
   * 展示图标 id(AI Gateway 侧登记,见 @cindy/model-providers CatalogModel.icon /
   * resolveModelIconKind);缺省或未知值客户端回落来源供应商标。
   */
  icon?: string;
  /** per-tab 能力覆盖(基线字段之上按 agent 应用)。 */
  perAgent?: Partial<Record<'claude-code' | 'codex', ModelAccessAgentOverride>>;
}
