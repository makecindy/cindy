/**
 * 草稿默认模型的可用性校准。
 *
 * 新建草稿的种子模型只是**目录排序给出的起点**（见 modelDefinitions getDefaultModelForVendor），
 * 与「这台机器上到底连了哪些来源」无关。全新用户的可连来源未必提供那个 id —— 于是首屏就落在
 * 一个没有任何已连接来源的模型上，Send 被禁用、只能弹「当前模型没有已连接的来源」，用户还没
 * 开始用就先撞墙。这里负责把默认落到**真正可用**的模型上。
 *
 * 这里只校准**用户从没显式选过模型**的默认值（`modelChosenByVendor` 区分「真选过」与
 * 「默认回填」）。已有来源偏好时，校准候选收窄到该来源，保证模型与来源成对变化；用户自己
 * 选过模型则一律不动。静默改写比撞墙更糟——那会让「我明明选了 Anthropic」变成无法自查。
 */

import {
  connectedProvidersForAgent,
  effectiveSourceIdForModel,
  isCindyDistributedProvider,
  isCustomRoutedProvider,
  isModelSelectableForNewRoute,
  nativeDefaultSourceId,
  type AgentKind,
  type CatalogModel,
  type ProviderView,
} from '@cindy/model-providers';
import { resolveNewMakerDefaultTuple } from './newMakerDefaultTuple.js';

type ModelEnabledPredicate = Parameters<typeof resolveNewMakerDefaultTuple>[0]['isModelEnabled'];

/** Keep startup, send-time calibration and headless defaults on one factory policy. */
function factoryModelForAgent(
  providers: readonly ProviderView[],
  agent: AgentKind,
  isModelEnabled?: ModelEnabledPredicate,
): PickedConnectedModel | null {
  const tuple = resolveNewMakerDefaultTuple({
    providers, providersLoading: false, availableAgentsLoaded: true, isModelEnabled,
    availableAgents: new Set([agent === 'claude-code' ? 'cc' : agent]),
  });
  return tuple ? { model: tuple.model, providerId: tuple.providerId } : null;
}

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
      (a, b) => (a.sortOrder ?? Number.MAX_SAFE_INTEGER) - (b.sortOrder ?? Number.MAX_SAFE_INTEGER),
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
 * 在当前已连接来源中挑真正可新建路由的第一项。
 *
 * 「第一项」沿用新对话既有口径：供应商先按订阅优先，再取该供应商目录排序第一的
 * 默认可见聊天模型。这里不处理 preferred / newSessionDefault；调用方明确要求纯 fallback
 * 时用它，避免服务端 marker 把“第一项”改写成另一项。
 */
export function pickFirstConnectedModelForAgent(
  providers: readonly ProviderView[],
  agent: AgentKind,
): PickedConnectedModel | null {
  for (const provider of providersByPreference(providers, agent)) {
    const first = firstModelByOrder(provider, agent);
    if (first) return { model: first.id, providerId: provider.id };
  }
  return null;
}

/** 按正常来源优先级找出区域 / 目录明确标记的新对话默认模型。 */
function markedDefaultModelIdForAgent(
  providers: readonly ProviderView[],
  agent: AgentKind,
): string | null {
  for (const provider of providersByPreference(providers, agent)) {
    const userProvider = provider.source === 'user';
    const flagged = (provider.models[agent] ?? [])
      .filter(
        (model) =>
          model.defaultEnabled !== false &&
          (model.newSessionDefault?.includes(agent) ?? false) &&
          isModelSelectableForNewRoute(model, { userProvider }),
      )
      .slice()
      .sort(
        (a, b) =>
          (a.sortOrder ?? Number.POSITIVE_INFINITY) - (b.sortOrder ?? Number.POSITIVE_INFINITY),
      )[0];
    if (flagged) return flagged.id;
  }
  return null;
}

/**
 * 在该 agent 的已连接来源里挑 (模型, 来源)：
 *   0. 同一 Harness 的可用出厂组合优先；没有时才取目录/服务端**显式标记**为新对话默认（`newSessionDefault`）、且可用且默认可见的模型
 *      优先 —— 未显式选过模型的用户应跟随它，即便种子恰好是另一个可用模型（种子是
 *      capabilities 未到位时算的冷启动值，不反映标记）。按订阅优先取第一家提供它的来源，
 *      同一来源多个被标记时按 sortOrder 决胜。每个 Agent 只接受自己的标记，不跨 Agent
 *      借用默认策略。**没有任何模型被标记时这步为空转，行为回到 1/2**（非破坏性）。
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
  isModelEnabled?: ModelEnabledPredicate,
): PickedConnectedModel | null {
  const ranked = providersByPreference(providers, agent);
  if (ranked.length === 0) return null;
  const factory = factoryModelForAgent(ranked, agent, isModelEnabled);
  if (factory) return factory;
  // 无可用出厂组合时，保留目录/服务端显式标记的回退；每个 Agent 只认自己的标记。
  const flaggedModelId = markedDefaultModelIdForAgent(ranked, agent);
  if (flaggedModelId !== null) {
    // 标记只存在于区域门控后的 XD 条目；来源选择仍必须独立遵守 ranked 的订阅优先。
    // 同 ID 的订阅副本不会重复携带标记，但只要它可选且默认可见，就应先消耗用户已付费额度。
    for (const provider of ranked) {
      const matching = (provider.models[agent] ?? []).find(
        (m) =>
          m.id === flaggedModelId &&
          m.defaultEnabled !== false &&
          isModelSelectableForNewRoute(m, { userProvider: provider.source === 'user' }),
      );
      if (matching) return { model: flaggedModelId, providerId: provider.id };
    }
  }
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
  return pickFirstConnectedModelForAgent(ranked, agent);
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
  /** 当前来源偏好；仍是有效连接来源时把自动模型候选限制在它内部，避免校准后静默丢来源。 */
  preferredProviderId?: string | null;
  /** 供应商清单是否仍在加载：加载期不校准，避免首帧把默认模型闪成别的。 */
  providersLoading: boolean;
  /** Use the startup model switches for factory recommendations; hidden fallback remains available. */
  isModelEnabled?: ModelEnabledPredicate;
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
  preferredProviderId,
  providersLoading,
  isModelEnabled,
}: DraftModelCalibrationInput): DraftModelCalibrationResult {
  if (chosenByUser || providersLoading) return { model, providerId: null };
  const connectedPreferred = preferredProviderId
    ? connectedProvidersForAgent([...providers], agent).find(
        (provider) => provider.id === preferredProviderId,
      )
    : undefined;
  if (connectedPreferred) {
    // Cindy AI 与企业号池由服务端统一编排：默认 Auto 可能落在其中任一家，也可能被挪走。
    // 用户没选过模型时，上次自动落点不能把出厂默认钉在原来那一家。
    const factoryScope = isCindyDistributedProvider(connectedPreferred)
      ? connectedProvidersForAgent([...providers], agent).filter(isCindyDistributedProvider)
      : [connectedPreferred];
    const factory = factoryModelForAgent(factoryScope, agent, isModelEnabled);
    if (factory) return factory;
    // marker 只需由策略来源声明一次（当前为 XD），用户选定的来源若也提供同一 ID，仍应由
    // 该来源承接；不能因它自己的目录副本没重复 marker 就退回旧模型或偷偷改走 XD。
    const markedModelId = markedDefaultModelIdForAgent(providers, agent);
    const matchingMarkedModel = markedModelId
      ? (connectedPreferred.models[agent] ?? []).find(
          (candidate) =>
            candidate.id === markedModelId &&
            candidate.defaultEnabled !== false &&
            isModelSelectableForNewRoute(candidate, {
              userProvider: connectedPreferred.source === 'user',
            }),
        )
      : undefined;
    if (matchingMarkedModel) {
      return { model: matchingMarkedModel.id, providerId: connectedPreferred.id };
    }
  }
  const candidates = connectedPreferred ? [connectedPreferred] : providers;
  const picked = pickConnectedModelForAgent(candidates, agent, model, isModelEnabled);
  return picked ?? { model, providerId: null };
}

/** 新建任务里某个 Harness 当前的模型选择（renderer 草稿，或 main 侧的草稿镜像）。 */
export interface NewTaskDraftSelection {
  model?: string;
  providerId?: string | null;
  /** 用户是否在选择器里显式选过；未知（旧 renderer 未推）按没选过处理。 */
  chosenByUser?: boolean;
}

/**
 * 不由用户当场选模型的入口（定时任务、/learn、IM 新建任务、协同 Worker 兜底等）的默认
 * (模型, 来源)：与新建任务同一口径，不另写一个固定型号。
 *   1. 用户在新建任务里显式选过、且仍有已连接来源可用的模型 → 用它；
 *   2. 否则按新建任务「没选过模型」的校准口径挑（可用出厂组合 → 区域标记 → 草稿种子 → 订阅优先的第一项）；
 *   3. 一个可用来源都没有 → null，由调用方明确失败，不编造一个看似可用的模型。
 * `requiredProviderId` 给定时只在该来源内挑（任务显式指定了来源）。
 */
export function resolveNewTaskDefaultRoute(args: {
  providers: readonly ProviderView[];
  agent: AgentKind;
  draft?: NewTaskDraftSelection | null;
  requiredProviderId?: string | null;
}): PickedConnectedModel | null {
  const { agent, draft } = args;
  const required = args.requiredProviderId?.trim() || null;
  const connected = connectedProvidersForAgent([...args.providers], agent);
  const scoped = required ? connected.filter((provider) => provider.id === required) : connected;
  if (scoped.length === 0) return null;
  const draftModel = draft?.model?.trim() ?? '';
  if (draftModel && draft?.chosenByUser) {
    const providerId = effectiveSourceIdForModel(
      scoped,
      required ?? draft.providerId ?? null,
      draftModel,
      agent,
    );
    if (providerId) return { model: draftModel, providerId };
  }
  // 与新建任务一致：没有任何模型 / 来源偏好时，清单发现失败的来源不拿来做自动默认
  // （全部失败时才退回）；有偏好时不过滤，暂时的发现失败不能把用户记着的来源换掉。
  const healthy =
    required || draft?.providerId || draft?.chosenByUser
      ? scoped
      : scoped.filter((provider) => !provider.modelDiscoveryFailure);
  const candidates = healthy.length > 0 ? healthy : scoped;
  const calibrate = (preferredProviderId: string | null) =>
    calibrateDraftModel({
      providers: candidates,
      agent,
      model: draftModel,
      chosenByUser: false,
      preferredProviderId,
      providersLoading: false,
    });
  let calibrated = calibrate(required ?? draft?.providerId ?? null);
  // 草稿记着的来源已经挑不出模型时，换别的来源，而不是让入口整体落空。
  if (!calibrated.providerId && !required && draft?.providerId) calibrated = calibrate(null);
  return calibrated.providerId
    ? { model: calibrated.model, providerId: calibrated.providerId }
    : null;
}

export interface DraftSessionProviderResolutionInput {
  /** main 进程用于默认路由的完整本机来源目录。 */
  providers: readonly ProviderView[];
  agent: AgentKind;
  model: string;
  /** 用户在草稿里显式选择的来源。 */
  explicitProviderId: string | null | undefined;
  /** renderer 已按当前模型与校准结果解析出的生效来源。 */
  effectiveProviderId: string | null;
}

/**
 * 决定新建会话是否必须把 renderer 的生效来源显式带给 main。
 *
 * 只有在省略 providerId 后 main 会解析到同一个来源时才允许返回 null；否则必须把来源
 * 固化在会话上，避免 UI 所见与首条请求的实际路由分叉。
 */
export function resolveDraftSessionProviderId({
  providers,
  agent,
  model,
  explicitProviderId,
  effectiveProviderId,
}: DraftSessionProviderResolutionInput): string | null {
  if (explicitProviderId) {
    // 显式来源原样提交；唯一例外是服务端把 Auto 挪到了另一家 Cindy 来源，此时来源解析
    // 已改指新来源，提交旧来源只会让首条请求落到不再提供该模型的连接上。
    const explicitProvider = providers.find((provider) => provider.id === explicitProviderId);
    const effectiveProvider = providers.find((provider) => provider.id === effectiveProviderId);
    return effectiveProvider &&
      effectiveProvider.id !== explicitProviderId &&
      isCindyDistributedProvider(explicitProvider) &&
      isCindyDistributedProvider(effectiveProvider)
      ? effectiveProvider.id
      : explicitProviderId;
  }
  if (!effectiveProviderId) return null;
  // 预设通过「添加供应商」落地后同样属于 user provider。即使它是当前模型唯一的
  // 已连接来源，也不能省略 providerId：main / maker-core 的 null 语义是沿用各 harness
  // 的原生认证 fallback（Claude → Cindy gateway / Claude OAuth），不会反查目录里唯一的
  // BYOM 来源。省略后 UI 虽显示该来源，首轮 auth gate 却会去读 gateway key，最终报
  // `not authenticated: no_key`。用户来源必须始终显式钉住，保证其代理路由与密钥生效。
  const effectiveProvider = providers.find((provider) => provider.id === effectiveProviderId);
  if (isCustomRoutedProvider(effectiveProvider)) return effectiveProviderId;
  const modelDefaultProviderId = effectiveSourceIdForModel([...providers], null, model, agent);
  // main 收到 providerId=null 后按 agent 的原生来源选择启动链路，而不是只在“提供当前
  // 模型”的来源里重算。典型分叉：XD 与 Anthropic 都已连接，只有 Anthropic 目录含
  // claude-opus-5。modelDefault 是 anthropic，但 agentDefault 仍是 xd；若只比较前者
  // 就会错误地省略 providerId，main 随后拿 gateway key 启动 XD 路由(issue #1196)。
  const agentDefaultProviderId = nativeDefaultSourceId(
    // main 的 spawn 默认不读取用户的 suspended 开关；这里必须保留 suspended 来源，
    // 否则 UI 停用 XD 后会把 agentDefault 错算成 Anthropic，再次把必需的来源省略掉。
    connectedProvidersForAgent([...providers], agent, { includeSuspended: true }),
    agent,
  );
  return modelDefaultProviderId === effectiveProviderId &&
    agentDefaultProviderId === effectiveProviderId
    ? null
    : effectiveProviderId;
}
