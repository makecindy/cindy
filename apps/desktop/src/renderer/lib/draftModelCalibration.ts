/**
 * 草稿默认模型的可用性校准。
 *
 * 新建草稿的种子模型是**写死的产品默认**（cc → Opus、codex → GPT），与「这台机器上
 * 到底连了哪些来源」完全无关。全新用户的可连来源未必提供那个 id —— 于是首屏就落在一个
 * 没有任何已连接来源的模型上，Send 被禁用、只能弹「当前模型没有已连接的来源」，用户还
 * 没开始用就先撞墙。
 *
 * 这里只校准**用户从没显式选过**的默认值（`modelChosenByVendor` 区分「真选过」与
 * 「默认回填」）。用户自己选的模型一律不动：他选了什么就该看到什么，静默改写比撞墙更糟
 * ——那会让「我明明选了 Codex」变成无法自查的错觉。
 */

import {
  connectedProvidersForAgent,
  type AgentKind,
  type ProviderView,
} from '@cindy/model-providers';

/**
 * 在该 agent 的已连接来源里挑一个模型 id：
 *   1. 首选 `preferredModelId`（默认值本身可用就不要动它，避免首屏莫名换模型）；
 *   2. 否则取已连接来源提供的第一个模型（provider 顺序 = 目录顺序，确定性）；
 *   3. 一个已连接来源都没有 → null，交给既有的「零来源」空态引导去连接供应商。
 */
export function pickConnectedModelForAgent(
  providers: readonly ProviderView[],
  agent: AgentKind,
  preferredModelId: string,
): string | null {
  const connected = connectedProvidersForAgent([...providers], agent);
  if (connected.length === 0) return null;
  for (const provider of connected) {
    if ((provider.models[agent] ?? []).some((m) => m.id === preferredModelId)) {
      return preferredModelId;
    }
  }
  for (const provider of connected) {
    const first = (provider.models[agent] ?? [])[0];
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
