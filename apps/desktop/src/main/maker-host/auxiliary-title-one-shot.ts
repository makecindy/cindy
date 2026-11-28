import { activeOwnerScopeKey } from '../appSessionState.js';
import { isAgentOneShotRouteDisabled } from './model-route-guard-live.js';
import { readAuxiliaryModelSettings } from '../utility-model/auxiliary-model-settings-store.js';
import {
  agentSupportsOneShot,
  requestUtilityText,
} from '../utility-model/oneShotCandidates.js';
import {
  getEffectiveAuxiliaryModelChain,
  getEffectiveAuxiliaryModelChainSnapshot,
} from '../utility-model/resolveAuxiliaryModelChain.js';
import { getMaker } from './index.js';
import type { TitleOneShotDeps, TitleOneShotResult } from './title-one-shot.js';
import {
  createAuxiliaryTitleOneShotCore,
  type AuxiliaryTextRequest,
  type AuxiliaryTextResult,
  type AuxiliaryTitleRuntimeDeps,
  type TitleRequest,
} from './auxiliaryTitleOneShotCore.js';

export type { AuxiliaryTextRequest, AuxiliaryTextResult };

const core = createAuxiliaryTitleOneShotCore({
  readModels: () => readAuxiliaryModelSettings().models,
  readOwnerScope: () => activeOwnerScopeKey(),
  getEffectiveAuxiliaryModelChain: () => getEffectiveAuxiliaryModelChain(),
  getEffectiveAuxiliaryModelChainSnapshot: () => getEffectiveAuxiliaryModelChainSnapshot(),
  agentSupportsOneShot: (agentKind) => agentSupportsOneShot(agentKind),
  isAgentOneShotRouteDisabled: (agentKind, model) => isAgentOneShotRouteDisabled(agentKind, model),
  getMaker: () => getMaker(),
  requestText: (prompt, opts) => requestUtilityText(getMaker(), prompt, opts),
});

export function requestAuxiliaryText(
  args: AuxiliaryTextRequest,
  deps?: Partial<AuxiliaryTitleRuntimeDeps>,
): Promise<AuxiliaryTextResult> {
  return core.requestAuxiliaryText(args, deps);
}

export async function generateTitleWithAuxiliaryModel(
  args: TitleRequest,
  _legacyDeps?: TitleOneShotDeps,
  runtimeDeps?: Partial<AuxiliaryTitleRuntimeDeps>,
): Promise<string | null> {
  return core.generateTitleWithAuxiliaryModel(args, runtimeDeps);
}

export async function generateTitleWithAuxiliaryModelResult(
  args: TitleRequest,
  _legacyDeps?: TitleOneShotDeps,
  runtimeDeps?: Partial<AuxiliaryTitleRuntimeDeps>,
): Promise<TitleOneShotResult> {
  return core.generateTitleWithAuxiliaryModelResult(args, runtimeDeps);
}
