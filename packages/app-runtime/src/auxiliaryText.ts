import type {AgentKind, Maker, Logger} from '@cindy/maker-core';
import type {UtilityTextRequestOptions} from '@cindy/model-providers/utilityTextRequest';
import type {UtilityTextResult} from '@cindy/model-providers/utilityTextResult';
import {agentSupportsOneShot} from '@cindy/model-providers/utility-model/oneShotSupport';
export interface AuxiliaryTitleRuntimeDeps {
 readModels():string[]|Promise<string[]>;
 readOwnerScope():string|Promise<string>;
 requestText(prompt:string,opts:UtilityTextRequestOptions):Promise<UtilityTextResult>;
}
export interface AuxiliaryTextHost extends AuxiliaryTitleRuntimeDeps {
 isAppSessionBoundaryPending():boolean;
 getEffectiveAuxiliaryModelChain():{source:string};
 getEffectiveAuxiliaryModelChainSnapshot():string;
 isAgentOneShotRouteDisabled(kind:AgentKind):Promise<boolean>;
 getMaker():Pick<Maker,'oneShot'>;
 logger:Logger;
}
export interface AuxiliaryTextRequest {
  agentKind: AgentKind;
  prompt: string;
  maxTokens: number;
  timeoutMs: number;
  responseInstructions: string;
  signal?: AbortSignal;
  /**
   * Automatic chains fall back to the owning session agent by default. A caller that is
   * latency-bound (the Market opening, with a user waiting) sets `false`: an agent one-shot
   * starts a whole agent process and cannot beat the auxiliary chain, it only spends the budget.
   */
  sessionAgentFallback?: boolean;
}
export type AuxiliaryTextResult =
  | { ok: true; text: string }
  | { ok: false; reason: string };

/**
 * One short, tool-less text generation shared by every host-written line (session titles, Market
 * openings): the auxiliary chain first, then — only in automatic mode and unless the caller opts
 * out with `sessionAgentFallback: false` — the owning session agent, so a signed-out user still gets
 * a result. Custom/env chains stay fail-closed.
 */
export function createAuxiliaryTextRequest(host:AuxiliaryTextHost) {
 const {isAppSessionBoundaryPending,getEffectiveAuxiliaryModelChain,getEffectiveAuxiliaryModelChainSnapshot,isAgentOneShotRouteDisabled,getMaker}=host;
 const log=host.logger;
 const DEFAULT_DEPS:AuxiliaryTitleRuntimeDeps=host;
async function requestAuxiliaryText(
  args: AuxiliaryTextRequest,
  deps: AuxiliaryTitleRuntimeDeps = DEFAULT_DEPS,
): Promise<AuxiliaryTextResult> {
  const ownerScope = await deps.readOwnerScope();
  const models = [...await deps.readModels()];
  const snapshot = JSON.stringify(models);
  const auxiliaryChain = getEffectiveAuxiliaryModelChain();
  const auxiliaryChainSnapshot = getEffectiveAuxiliaryModelChainSnapshot();
  const beforeDispatch = async () => {
    if (isAppSessionBoundaryPending()) return false;
    if ((await deps.readOwnerScope()) !== ownerScope) return false;
    if (getEffectiveAuxiliaryModelChainSnapshot() !== auxiliaryChainSnapshot) return false;
    const currentModels = JSON.stringify(await deps.readModels());
    return !isAppSessionBoundaryPending()
      && (await deps.readOwnerScope()) === ownerScope
      && getEffectiveAuxiliaryModelChainSnapshot() === auxiliaryChainSnapshot
      && currentModels === snapshot;
  };
  const beforeSessionAgentDispatch = async () =>
    !(await isAgentOneShotRouteDisabled(args.agentKind)) && await beforeDispatch();
  const result = await deps.requestText(args.prompt, {
    maxTokens: args.maxTokens,
    timeoutMs: args.timeoutMs,
    // Short budgets cannot afford provider-default thinking. Messages /
    // chat routes receive their native disable flag; Responses routes use the
    // lowest supported effort because that protocol has no off value.
    disableReasoning: true,
    reasoningEffort: 'minimal',
    responseInstructions: args.responseInstructions,
    signal: args.signal,
    // Settings may change while OAuth refresh/credential discovery awaits.
    beforeDispatch,
  });
  if (result.ok) return { ok: true, text: result.text };
  // A signed-out user still has the current session agent available. Only
  // the automatic chain may use that same-agent fallback; custom and env
  // chains are explicit routing decisions and must remain fail-closed.
  const canFallbackToSessionAgent = args.sessionAgentFallback !== false
    && auxiliaryChain.source === 'auto'
    && agentSupportsOneShot(args.agentKind)
    && await beforeSessionAgentDispatch();
  if (canFallbackToSessionAgent) {
    try {
      const fallbackText = await getMaker().oneShot(args.agentKind, args.prompt, {
        maxTokens: args.maxTokens,
        timeoutMs: args.timeoutMs,
        signal: args.signal,
        responseInstructions: args.responseInstructions,
        beforeDispatch: beforeSessionAgentDispatch,
      });
      if (fallbackText.trim()) return { ok: true, text: fallbackText };
    } catch (error) {
      log.warn('auxiliary text session agent fallback failed', {
        errorName: error instanceof Error ? error.name : typeof error,
        reason: (error as { reason?: unknown } | null)?.reason,
      });
    }
  }
  return { ok: false, reason: result.reason };
}

return requestAuxiliaryText;
}
