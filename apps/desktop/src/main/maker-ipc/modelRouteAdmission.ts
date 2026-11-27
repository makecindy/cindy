/**
 * The admission check of a model route a task is changed to (register.ts assertModelRouteUsable):
 * an SSH Codex task checks the remote host's model list; any other task takes the route verdict
 * (disabled, retired or payment-required routes are refused; an exclusive provider is rerouted).
 * Moved verbatim out of register.ts so the Node Host runs the same check.
 *
 * Ports: the SSH provider list (maker-host/index.ts loads Electron) and the route verdict, which the
 * desktop binds to model-route-guard-live.ts and the Host to verdictForModelRouteWithProviders with
 * its own provider listing.
 */
import type { AgentKind } from '@cindy/maker-core';
import { describeModelRouteRejection, type ModelRouteVerdict } from '../maker-host/model-route-guard.js';
import { assertSshCodexModel, readSshCodexModelList } from '../remote-ssh/codex-model-list.js';
import { throwIpcError } from '../utils/ipcValidate.js';

export interface ModelRouteAdmissionPorts {
  listSshCodexProviders: typeof import('../maker-host/index.js').listSshCodexProviders;
  verdictForModelRoute: (agent: AgentKind, model: string, providerId: string | null) => Promise<ModelRouteVerdict>;
}

/** register.ts assertModelRouteUsable, with its ports first. */
export async function assertModelRouteUsableWith(
  ports: ModelRouteAdmissionPorts,

  agent: AgentKind,
  model: string,
  providerId: string | null,
  remoteHostId?: string | null,
  unavailableCode?: 'MODEL_SELECTION_UNAVAILABLE',
): Promise<string | undefined> {
  const { listSshCodexProviders, verdictForModelRoute } = ports;
  if (agent === 'codex' && remoteHostId) {
    assertSshCodexModel(await readSshCodexModelList({ id: remoteHostId }, listSshCodexProviders), model, providerId);
    return undefined;
  }
  const verdict = await verdictForModelRoute(agent, model, providerId);
  if (verdict.kind === 'reject') {
    throwIpcError(
      verdict.reason === 'payment-required' ? 'INVALID_PARAMS' : unavailableCode ?? 'INVALID_PARAMS',
      describeModelRouteRejection(verdict.reason, model, providerId),
    );
  }
  return verdict.kind === 'reroute' ? verdict.providerId : undefined;
}
