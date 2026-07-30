/**
 * 草稿默认模型的可用性校准。
 *
 * 新建草稿的种子模型只是**目录排序给出的起点**（见 modelDefinitions getDefaultModelForVendor），
 * 与「这台机器上到底连了哪些来源」无关。全新用户的可连来源未必提供那个 id —— 于是首屏就落在
 * 一个没有任何已连接来源的模型上，Send 被禁用、只能弹「当前模型没有已连接的来源」，用户还没
 * 开始用就先撞墙。这里负责把默认落到**真正可用**的模型上。
 *
 * 这里只校准**用户从没显式选过**的默认值（`modelChosenByVendor` 区分「真选过」与
 * 「默认回填」）。用户自己选的模型一律不动：他选了什么就该看到什么，静默改写比撞墙更糟
 * ——那会让「我明明选了 Codex」变成无法自查的错觉。
 */

import {
  connectedProvidersForAgent,
  type AgentKind,
  type CatalogModel,
  type ProviderView,
} from '@cindy/model-providers';

/**
 * 挑选顺序（2026-07-30 产品定稿）：**可用的里面选第一个 —— 供应商优先订阅的，
 * 再取该供应商模型里排序第一个**。
 *
 * 分两级而不是把所有模型拍平排序，是因为「优先订阅」必须赢过「排序更靠前」：网关的折扣路由
 * （`codex/` 前缀）在目录里排得比官方原版靠前，拍平排序会让默认模型变成折扣路由 —— 那要网关
 * 已连接才可用、计费也走网关而非用户已经付过钱的订阅额度。多个订阅供应商时按目录序
 * （anthropic → openai → xai），于是 Claude 订阅在场时 cc tab 自然落到 Claude 系。
 */
function providersByPreference(
  providers: readonly ProviderView[],
  agent: AgentKind,
): ProviderView[] {
  const connected = connectedProvidersForAgent([...providers], agent);
  const subscription = connected.filter((p) => p.access?.kind === 'subscription');
  const rest = connected.filter((p) => p.access?.kind !== 'subscription');
  // 两组内部都保持目录序（connectedProvidersForAgent 的输出序），结果完全确定。
  return [...subscription, ...rest];
}

/**
 * 该供应商在这个 agent 下排序第一的**默认可见**模型。
 *
 * 默认收起的模型不参与：它们在选择器里根本不显示，选中了等于让用户面对一个自己找不到的默认
 * 模型。整组都收起时退回纯排序第一 —— 有个能用的默认，好过让这个供应商整体落空。
 */
function firstModelByOrder(provider: ProviderView, agent: AgentKind): CatalogModel | undefined {
  const models = provider.models[agent] ?? [];
  if (models.length === 0) return undefined;
  const visible = models.filter((m) => m.defaultEnabled !== false);
  const pool = visible.length > 0 ? visible : models;
  // slice() 再 sort：sort 原地改数组，直接排会打乱传入的 ProviderView 的清单顺序。
  return pool
    .slice()
    .sort(
      (a, b) =>
        (a.sortOrder ?? Number.MAX_SAFE_INTEGER) - (b.sortOrder ?? Number.MAX_SAFE_INTEGER),
    )[0];
}

/**
 * 在该 agent 的已连接来源里挑一个模型 id：
 *   1. `preferredModelId` 本身可用 —— 默认值能用就绝不动它，避免首屏莫名换模型；
 *   2. 否则按「订阅优先」的供应商序取第一家，返回它排序第一的默认可见模型
 *      （见 providersByPreference / firstModelByOrder）；
 *   3. 一个已连接来源都没有（或都没有模型）→ null，交给既有的「零来源」空态引导去连接供应商。
 */
export function pickConnectedModelForAgent(
  providers: readonly ProviderView[],
  agent: AgentKind,
  preferredModelId: string,
): string | null {
  const ranked = providersByPreference(providers, agent);
  if (ranked.length === 0) return null;
  for (const provider of ranked) {
    if ((provider.models[agent] ?? []).some((m) => m.id === preferredModelId)) {
      return preferredModelId;
    }
  }
  for (const provider of ranked) {
    const first = firstModelByOrder(provider, agent);
    if (first) return first.id;
  }
  return null;
}

export interface DraftModelCalibrationInput {
  /**
   * 候选来源。调用方必须**预先过滤好**：既剔除不可路由的来源（SSH 下仅本地可桥接的
   * Codex 供应商），也剔除各来源里不该被选中的模型条目（用户隐藏 / 默认收起、SSH 下的
   * 订阅直连）。过滤放在候选上而不是这里，是因为同一份候选还要喂给来源解析
   * （`effectiveSourceIdForModel`）——只在挑模型时过滤，会让来源解析仍看见被剔除的条目，
   * 从而选中一个用户已经排除掉该模型的来源。
   */
  providers: readonly ProviderView[];
  agent: AgentKind;
  /** 草稿当前的模型（种子默认或用户选择）。 */
  model: string;
  /** 用户是否在选择器里显式选过该 vendor 的模型。 */
  chosenByUser: boolean;
  /** 供应商清单是否仍在加载：加载期不校准，避免首帧把默认模型闪成别的。 */
  providersLoading: boolean;
}

/** 返回草稿应当展示 / 发送的模型 id（不可校准时原样返回，绝不返回空）。 */
export function calibrateDraftModel({
  providers,
  agent,
  model,
  chosenByUser,
  providersLoading,
}: DraftModelCalibrationInput): string {
  if (chosenByUser || providersLoading) return model;
  return pickConnectedModelForAgent(providers, agent, model) ?? model;
}
