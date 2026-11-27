import type { AgentKind } from '@cindy/maker-core';
import { isXdGatewaySilentSwitchTarget, type XdGatewayModelInfo } from '../maker-host/active-catalog.js';
import { throwIpcError } from '../utils/ipcValidate.js';

export async function resolveSilentGatewaySwitchTarget(
  model: XdGatewayModelInfo | undefined,
  current: AgentKind,
  available: readonly AgentKind[],
  canUse: (agent: AgentKind) => Promise<boolean>,
): Promise<AgentKind | undefined> {
  const target = model?.agents?.[0];
  if (!model || !target || target === current || !available.includes(target) ||
      !isXdGatewaySilentSwitchTarget(model, target)) return;
  if (await canUse(target)) return target;
}

/** Session columns the silent switch reads before deciding whether a task is eligible. */
export interface SilentGatewaySwitchSessionRow {
  providerId?: string | null;
  model?: string | null;
  status?: string | null;
  agentKind?: string | null;
  remoteHostId?: string | null;
  agentDeviceId?: string | null;
  orcaRole?: string | null;
  orcaRemoteLead?: unknown;
  source?: string | null;
}

/** Main-process services the send-time silent switch depends on; injected so the decision is testable. */
export interface SilentGatewaySwitchDeps {
  /** Identity of the signed-in local database; an owner change during the handoff cancels the switch. */
  getOwner: () => object | null | undefined;
  isRemoteInvoke: () => boolean;
  hasPendingAgentSwitch: (sessionId: string) => boolean;
  isTurnRunning: (sessionId: string) => boolean;
  hasPendingInteraction: (sessionId: string) => boolean;
  getCatalog: () => { authoritative: boolean; models: readonly XdGatewayModelInfo[] };
  getSessionRow: (sessionId: string) => Promise<SilentGatewaySwitchSessionRow | null | undefined>;
  /** Built-in engine for a stored agent kind; undefined for plugin engines, which are never switched. */
  toBuiltinAgent: (agentKind: string) => AgentKind | undefined;
  listAvailableAgents: () => readonly AgentKind[];
  canUseRoute: (agent: AgentKind, modelId: string) => Promise<boolean>;
  switchAgent: (params: {
    sessionId: string;
    targetAgentKind: AgentKind;
    model: string;
    effort: string | null | undefined;
    signal?: AbortSignal;
    assertSelectionCurrent: () => void;
  }) => Promise<{ switched: boolean; deferred?: boolean }>;
  log: { warn: (message: string, meta?: Record<string, unknown>) => void };
}

/**
 * Send-time silent engine switch for Cindy AI catalog entries marked `silentSwitch`.
 *
 * Every send re-checks the latest authoritative catalog; nothing is remembered per task. A send
 * that cannot decide (catalog not authoritative, task busy) or whose switch fails leaves the task
 * as it is, so the next send checks again. A failed switch is logged and the send continues on
 * the current engine, like the cross-engine pending switch does. Idle tasks are never switched
 * in the background: the catalog only takes effect when the task is next sent to.
 */
export function createSilentGatewaySwitchForSend(deps: SilentGatewaySwitchDeps) {
  return async (sessionId: string, signal?: AbortSignal): Promise<void> => {
    const owner = deps.getOwner();
    if (!owner || signal?.aborted || deps.isRemoteInvoke()) return;
    // Most accounts never see the flag; they must not pay for a session read on every send.
    const catalog = deps.getCatalog();
    if (!catalog.authoritative || !catalog.models.some(model => model.silentSwitch === true)) return;
    if (deps.hasPendingAgentSwitch(sessionId) || deps.isTurnRunning(sessionId) || deps.hasPendingInteraction(sessionId)) {
      return;
    }
    const row = await deps.getSessionRow(sessionId);
    if (row?.providerId !== 'xd' || !row.model || row.status !== 'active' ||
        row.remoteHostId || row.agentDeviceId || row.orcaRole || row.orcaRemoteLead ||
        (row.source && row.source !== 'desktop' && row.source !== 'mobile')) {
      return;
    }
    const current = row.agentKind ? deps.toBuiltinAgent(row.agentKind) : undefined;
    if (!current) return;
    const modelId = row.model;
    const model = catalog.models.find(entry => entry.id === modelId);
    const target = await resolveSilentGatewaySwitchTarget(model, current, deps.listAvailableAgents(), agent =>
      deps.canUseRoute(agent, modelId),
    );
    if (target) {
      const assertCurrent = () => {
        signal?.throwIfAborted();
        if (owner !== deps.getOwner() || deps.hasPendingAgentSwitch(sessionId) ||
            deps.isTurnRunning(sessionId) || deps.hasPendingInteraction(sessionId)) {
          throwIpcError('PRECONDITION_FAILED', 'Task changed before agent switch');
        }
      };
      // Every successful sync rewrites the list (copied arrays, twice per sync) and an in-flight
      // refresh briefly drops `authoritative`, so only the entry itself decides: the switch
      // proceeds while the latest list still offers this model as a silent target for `target`.
      const directiveIsCurrent = () => {
        const latest = deps.getCatalog().models.find(entry => entry.id === modelId);
        return latest?.agents?.[0] === target && isXdGatewaySilentSwitchTarget(latest, target);
      };
      try {
        if (!directiveIsCurrent()) throwIpcError('PRECONDITION_FAILED', 'Model directory changed before agent switch');
        const result = await deps.switchAgent({
          sessionId,
          targetAgentKind: target,
          model: modelId,
          effort: model?.perAgent?.[target]?.defaultEffort ?? model?.defaultEffort,
          signal,
          assertSelectionCurrent: () => {
            assertCurrent();
            if (!directiveIsCurrent()) throwIpcError('PRECONDITION_FAILED', 'Model directory changed before agent switch');
          },
        });
        if (!result.switched || result.deferred) throwIpcError('PRECONDITION_FAILED', 'Agent switch could not be applied');
      } catch (err) {
        if (signal?.aborted) throw err;
        deps.log.warn('agent-switch: silent gateway switch failed; sending on the current engine', {
          sessionId,
          targetAgentKind: target,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  };
}
