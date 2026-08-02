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
  isModelSelectableForNewRoute,
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
 * 该供应商在这个 agent 下排序第一的**默认可见的聊天**模型。
 *
 * 默认收起的模型不参与：它们在选择器里根本不显示，选中了等于让用户面对一个自己找不到的默认
 * 模型。整组都收起时退回纯排序第一 —— 有个能用的默认，好过让这个供应商整体落空。
 *
 * 新路由准入(isModelSelectableForNewRoute)是硬门槛,不参与"整组收起退回"的放宽:挑到的模型直接被
 * 当成会话默认模型使用,非聊天模型(图像/向量/TTS 等,issue #882 第 3 点)漏进来就是"草稿
 * 默认模型选中一个不能聊天的模型"。用 provider-aware 谓词而非裸 isChatEligible:用户自定义
 * 供应商显式配置的模型(未知 group)是合法聊天模型,id 撞上能力启发式(如 flux-image-x)
 * 不该被误杀(2026-07 review 第 25 轮)。
 */
function firstModelByOrder(provider: ProviderView, agent: AgentKind): CatalogModel | undefined {
  const userProvider = provider.source === 'user';
  const chatModels = (provider.models[agent] ?? []).filter((m) =>
    isModelSelectableForNewRoute(m, { userProvider }),
  );
  if (chatModels.length === 0) return undefined;
  const visible = chatModels.filter((m) => m.defaultEnabled !== false);
  const pool = visible.length > 0 ? visible : chatModels;
  // slice() 再 sort：sort 原地改数组，直接排会打乱传入的 ProviderView 的清单顺序。
  return pool
    .slice()
    .sort(
      (a, b) =>
        (a.sortOrder ?? Number.MAX_SAFE_INTEGER) - (b.sortOrder ?? Number.MAX_SAFE_INTEGER),
    )[0];
}

/** 校准挑中的 (模型, 来源)。`providerId` 是按订阅优先顺序命中的那家。 */
export interface PickedConnectedModel {
  model: string;
  /**
   * 挑中它的那家供应商。
   *
   * **必须一路带到来源解析**,不能只返回 model id:`nativeDefaultSourceId` 对
   * claude-code 无条件优先 XD 网关（registry.ts）。于是「校准按订阅优先挑了 anthropic 的
   * claude-opus-5」但只交出模型 id 时,下游解析又把它指回 XD —— 计费走网关,而不是用户
   * 已经付过钱的订阅额度,本模块承诺的「订阅优先」在最后一步被推翻（PR #1076 review）。
   */
  providerId: string;
}

/**
 * 在该 agent 的已连接来源里挑 (模型, 来源)：
 *   1. `preferredModelId` 本身可用**且默认可见** —— 默认值能用就绝不动它，避免首屏莫名换
 *      模型；来源仍按订阅优先顺序取「第一家提供它的」，让默认值也享受订阅优先；
 *   2. 否则按「订阅优先」的供应商序取第一家，返回它排序第一的默认可见模型
 *      （见 providersByPreference / firstModelByOrder）；
 *   3. 一个已连接来源都没有（或都没有模型）→ null，交给既有的「零来源」空态引导去连接供应商。
 *
 * 第 1 步为什么要卡「默认可见」：存量用户的草稿里持久化着**旧代码写死的**种子默认
 * （`gpt-5.4` / `gpt-5.5`），而这两个 id 在目录里都是 `defaultEnabled: false`。它们的
 * `modelChosenByVendor` 仍是 false —— 正是这套校准要迁移的那批草稿。只判「某个已连接来源
 * 提供它」会把它们原样留下，用户继续用一个在默认选择器里根本看不到的模型
 * （PR #1076 review 第三轮）。真正被用户选过的模型不受影响：那由 `chosenByUser` 在
 * `calibrateDraftModel` 里更早短路，压根走不到这里。
 *
 * 第 1 步同样卡聊天准入(issue #882 第 3 点):`preferredModelId` 在该来源的拷贝若是
 * 非聊天类型(mode/分类为图像等),不能因"id 存在且默认可见"就保留 —— 挑到的模型直接
 * 被当成会话默认模型使用。用 provider-aware 谓词,理由见 firstModelByOrder。
 */
export function pickConnectedModelForAgent(
  providers: readonly ProviderView[],
  agent: AgentKind,
  preferredModelId: string,
): PickedConnectedModel | null {
  const ranked = providersByPreference(providers, agent);
  if (ranked.length === 0) return null;
  for (const provider of ranked) {
    const preferred = (provider.models[agent] ?? []).find((m) => m.id === preferredModelId);
    if (
      preferred &&
      preferred.defaultEnabled !== false &&
      isModelSelectableForNewRoute(preferred, { userProvider: provider.source === 'user' })
    ) {
      return { model: preferredModelId, providerId: provider.id };
    }
  }
  for (const provider of ranked) {
    const first = firstModelByOrder(provider, agent);
    if (first) return { model: first.id, providerId: provider.id };
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

/** 校准结果：草稿应当展示 / 发送的模型，以及（若校准出了结论）它该走哪家来源。 */
export interface DraftModelCalibrationResult {
  /** 草稿应当展示 / 发送的模型 id（不可校准时原样返回，绝不为空）。 */
  model: string;
  /**
   * 建议来源。`null` = 本次没给出结论（用户已显式选过 / 清单还在加载 / 一个来源都没有），
   * 调用方应回落既有的来源解析。给出时调用方要把它喂给 `effectiveSourceIdForModel`，
   * 优先级排在**用户显式选的来源之后**（他选的必须赢），见 PickedConnectedModel.providerId。
   */
  providerId: string | null;
}

export function calibrateDraftModel({
  providers,
  agent,
  model,
  chosenByUser,
  providersLoading,
}: DraftModelCalibrationInput): DraftModelCalibrationResult {
  if (chosenByUser || providersLoading) return { model, providerId: null };
  const picked = pickConnectedModelForAgent(providers, agent, model);
  return picked ?? { model, providerId: null };
}
