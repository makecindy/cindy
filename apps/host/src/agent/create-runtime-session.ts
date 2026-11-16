/**
 * The Device Link create entry of a task with its runtime (the desktop's maker:create-session; main.ts
 * passes it to createHostDeviceLink). Moved verbatim out of main.ts so its steps run under test; it
 * adds the runtime start admission (register.ts bootstrapSession's admitLocalRoute) before the task row
 * is written.
 *
 * Ports: the server's task creation (main.ts serverDeps.createSession), the owner runtime's agent graph
 * (null until it is ready) and the runtime selection's start admission (runtime-selection.ts).
 */
import type { Maker } from '@cindy/maker-core';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../../../desktop/src/main/appSessionState.js';
import { ensureDialogueWorkspaceDir } from '../../../desktop/src/main/localDb/dialogueWorkspace.js';
import type { LocalRouteAdmissionOpts } from '../../../desktop/src/main/maker-ipc/localRouteAdmission.ts';
import { readHostCreateSessionOpts } from '../create-session-request.js';

export interface HostRuntimeSessionCreatePorts {
  serverDeps: { createSession(input: Record<string, unknown>): Promise<{ id: string }> };
  getAgentGraph(): { maker: Pick<Maker, 'createSession'> } | null;
  admitLocalRoute(opts: LocalRouteAdmissionOpts): Promise<void>;
}

export async function createHostRuntimeSession(ports: HostRuntimeSessionCreatePorts, input: unknown) {
  const { serverDeps, getAgentGraph, admitLocalRoute } = ports;
  const scope = activeOwnerScopeKey();
  const opts = readHostCreateSessionOpts(input, ensureDialogueWorkspaceDir);
  // These routes need separate execution services; never reinterpret a remote
  // task or Orca worker as an ordinary local task.
  if (opts.remoteHostId || opts.agentDeviceId || opts.orcaRole)
    throw new Error('[NOT_SUPPORTED] This execution route is not assembled in the Host yet');
  // As the desktop's create entry starts its runtime (register.ts bootstrapSession): the start admission
  // before the task row is written, so a refused start leaves no row and a rerouted provider is the
  // one the row is created with.
  await admitLocalRoute(opts);
  if (activeOwnerScopeKey() !== scope || isAppSessionBoundaryPending()) throw new Error('Host account changed');
  const row = await serverDeps.createSession({
    id: opts.id, agentKind: opts.agentKind, workingDir: opts.workingDir,
    workspaceKind: opts.workspaceKind, model: opts.model,
    permissionMode: opts.permissionMode, effort: opts.effort, providerId: opts.providerId,
    fastMode: opts.fastMode, planModeEnabled: opts.planMode,
    extraDirs: opts.extraDirs, writableDirs: opts.writableDirs,
  });
  const agentGraph = getAgentGraph();
  if (activeOwnerScopeKey() !== scope || isAppSessionBoundaryPending() || !agentGraph) throw new Error('Host account changed');
  const session = await agentGraph.maker.createSession({ ...opts, id: row.id });
  if (activeOwnerScopeKey() !== scope || isAppSessionBoundaryPending()) throw new Error('Host account changed');
  return { sessionId: session.id, agentKind: session.agentKind, workDir: session.workDir,
    capabilities: session.capabilities, usedProjectContext: false };
}
