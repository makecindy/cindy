/**
 * 改伙伴用哪个模型时，能力里要一起改的那几项。伙伴自己的「模型」页与「模型供应商 → 智能路由」页里的伙伴一栏
 * 都用这里，两处存下的形状一样(2026-11-26：伙伴的模型设置也放进智能路由页，不另写一套)。
 */
import type { BotModelRoute } from '../../../shared/botModelChain';
import type { BotCapabilities } from './botStore';

/** 选成这个模型(伙伴只用一个模型，2026-11-26 起不再有备用)；是空的时不改。 */
export function capabilitiesWithModelChain(current: BotCapabilities, modelChain: BotModelRoute[]): BotCapabilities | null {
  const primary = modelChain[0];
  if (!primary) return null;
  return {
    ...current,
    ...primary,
    ...((current.agentDeviceId != null || primary.agentDeviceId != null)
      ? { agentDeviceId: primary.agentDeviceId ?? null } : {}),
    modelChain,
    modelChainOverride: modelChain,
    modelOverride: {
      model: primary.model,
      providerId: primary.providerId,
      effort: primary.effort,
      fastMode: primary.fastMode,
    },
  };
}

/** 恢复跟随默认：用此刻的默认链，之后默认变了跟着变。 */
export function capabilitiesFollowingDefault(current: BotCapabilities, defaultChain: BotModelRoute[]): BotCapabilities {
  const primary = defaultChain[0];
  return {
    ...current,
    ...(primary ?? { model: '', providerId: null, effort: '', fastMode: false }),
    ...((current.agentDeviceId != null || primary?.agentDeviceId != null)
      ? { agentDeviceId: primary?.agentDeviceId ?? null } : {}),
    modelOverride: null,
    modelChain: defaultChain,
    modelChainOverride: null,
  };
}

/** 这位伙伴跟随默认模型(没有单独设置)。智能路由页的伙伴一栏与伙伴页都按这一个判断。 */
export function followsDefaultModel(capabilities: Pick<BotCapabilities, 'modelChainOverride'>): boolean {
  return capabilities.modelChainOverride === null;
}

/** 现在显示的链：跟随默认时是默认链。 */
export function displayedModelChain(capabilities: BotCapabilities, defaultChain: BotModelRoute[]): BotModelRoute[] {
  return capabilities.modelChainOverride === null ? defaultChain : capabilities.modelChain;
}
