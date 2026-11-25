/**
 * The Device Link create entry of a task with its runtime (the desktop's maker:create-session; main.ts
 * passes it to createHostDeviceLink). Moved verbatim out of main.ts so its steps run under test; it
 * adds the runtime start admission (register.ts bootstrapSession's admitLocalRoute) before the task row
 * is written.
 *
 * Ports: the server's task creation (main.ts serverDeps.createSession), the owner runtime's agent graph
 * (null until it is ready), the send path's provider group refusal and the runtime selection's start
 * admission (runtime-selection.ts).
 */
import path from 'node:path';
import type { Maker } from '@cindy/maker-core';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../../../desktop/src/main/appSessionState.js';
import { ensureDialogueWorkspaceDir } from '../../../desktop/src/main/localDb/dialogueWorkspace.js';
import type { LocalRouteAdmissionOpts } from '../../../desktop/src/main/maker-ipc/localRouteAdmission.ts';
import { readHostCreateSessionOpts } from '../create-session-request.js';
import { throwIpcError } from '../../../desktop/src/main/utils/ipcValidate.js';
import { storedSessionOptions } from './input-queue.mjs';

const sameDir = (a?: string | null, b?: string | null) => (a ? path.resolve(a) : '') === (b ? path.resolve(b) : '');

/** The run parameters of a stored task row (the shape storedSessionOptions reads). */
export interface StoredTaskRow {
  status: string;
  workingDir: string | null;
  agentKind: string;
  model: string | null;
  effort: string | null;
  permissionMode: string | null;
  providerId: string | null;
  fastMode: boolean | 'ultrafast' | null;
  planModeEnabled: boolean | null;
  sdkSessionId: string | null;
}

export interface HostRuntimeSessionCreatePorts {
  serverDeps: { createSession(input: Record<string, unknown>): Promise<{ id: string }> };
  getAgentGraph(): { maker: Pick<Maker, 'createSession'> } | null;
  /** The send path's provider group refusal (send-preflight.ts createHostProviderExecutionCheck). */
  assertProviderExecutionSupported(id: string, providerId?: string | null): void;
  admitLocalRoute(opts: LocalRouteAdmissionOpts): Promise<void>;
  /** The stored task row of a caller-provided id, or null when no such row exists. */
  readStoredSession(id: string): Promise<StoredTaskRow | null>;
}

export function throwAgentBinaryNotReady(): never {
  throwIpcError('PRECONDITION_FAILED', 'binary_not_ready: No Agent engine is available on this computer. Install an engine and restart Cindy.');
}

export async function createHostRuntimeSession(ports: HostRuntimeSessionCreatePorts, input: unknown) {
  const { serverDeps, getAgentGraph, assertProviderExecutionSupported, admitLocalRoute, readStoredSession } = ports;
  if (!getAgentGraph()) throwAgentBinaryNotReady();
  const scope = activeOwnerScopeKey();
  const opts = readHostCreateSessionOpts(input, ensureDialogueWorkspaceDir);
  // These routes need separate execution services; never reinterpret a remote
  // task or Orca worker as an ordinary local task.
  if (opts.remoteHostId || opts.agentDeviceId || opts.orcaRole)
    throw new Error('[NOT_SUPPORTED] This execution route is not assembled in the Host yet');
  // As the send path (turn-executor.mjs readExecutionSession): a provider group task is refused before
  // its row or runtime exists; this entry did not refuse it before.
  assertProviderExecutionSupported(opts.id ?? '', opts.providerId);
  // As the desktop's create entry starts its runtime (register.ts bootstrapSession): the start admission
  // before the task row is written, so a refused start leaves no row and a rerouted provider is the
  // one the row is created with.
  await admitLocalRoute(opts);
  if (activeOwnerScopeKey() !== scope || isAppSessionBoundaryPending()) throw new Error('Host account changed');
  // A controller retries a create with the same id when the first reply was lost (the mobile
  // creation pipeline relies on this, as maker-core reuses a provided id). The row then already
  // exists: start its runtime again instead of failing the insert on sessions.id.
  const stored = opts.id ? await readStoredSession(opts.id) : null;
  if (stored && (stored.status !== 'active' || sameDir(stored.workingDir, opts.workingDir) === false)) {
    throwIpcError('PRECONDITION_FAILED', 'This task id already belongs to a different task');
  }
  if (activeOwnerScopeKey() !== scope || isAppSessionBoundaryPending()) throwIpcError('PRECONDITION_FAILED', 'Host account changed');
  const row = stored
    ? { id: opts.id as string }
    : await serverDeps.createSession({
      id: opts.id, agentKind: opts.agentKind, workingDir: opts.workingDir,
      workspaceKind: opts.workspaceKind, model: opts.model,
      permissionMode: opts.permissionMode, effort: opts.effort, providerId: opts.providerId,
      fastMode: opts.fastMode, planModeEnabled: opts.planMode,
      extraDirs: opts.extraDirs, writableDirs: opts.writableDirs,
    });
  const agentGraph = getAgentGraph();
  if (activeOwnerScopeKey() !== scope || isAppSessionBoundaryPending() || !agentGraph) throw new Error('Host account changed');
  // A retried id starts from its stored row, as send and restore do (input-queue.mjs storedSessionOptions):
  // without the stored sdkSessionId, a runtime released since then would start a new native
  // conversation and the task would lose its history.
  const startOpts = stored ? { ...opts, ...storedSessionOptions(stored), id: row.id } : { ...opts, id: row.id };
  const session = await agentGraph.maker.createSession(startOpts);
  if (activeOwnerScopeKey() !== scope || isAppSessionBoundaryPending()) throw new Error('Host account changed');
  return { sessionId: session.id, agentKind: session.agentKind, workDir: session.workDir,
    capabilities: session.capabilities, usedProjectContext: false };
}
