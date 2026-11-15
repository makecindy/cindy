import { createSessionStderrOptions } from '../../../desktop/src/main/maker-ipc/sessionRequest.ts';
import { readSessionExtraDirsFromDb, readSessionWritableDirsFromDb } from '../../../desktop/src/main/maker-host/session-storage.js';
import { contextRecoveryKind, type ContextRecoveryKind } from './context-recovery.ts';
import { createHostContextRecoveryRollover, type HostRecoveryPorts } from './context-recovery-assembly.ts';
import type { createHostAgentGraph } from './runtime.ts';

type AgentGraph = Pick<ReturnType<typeof createHostAgentGraph>, 'maker' | 'contextRecovery'>;

/**
 * The input queue's context recovery (createInputQueue's isContextRecoveryOpen and
 * createContextRecoveryRollover), as main.ts wires it: a kind opens only when it is in `openKinds`,
 * after its real-engine test (release table); a closed kind takes the normal error path, unclaimed.
 * The Codex history and Pi ports reach the rollover only once their kind is open.
 */
export function createHostContextRecoveryWiring(deps: {
  openKinds: ReadonlySet<ContextRecoveryKind>;
  /** The current agent graph; null before the runtime is ready. */
  getGraph(): AgentGraph | null;
  persistMessage: HostRecoveryPorts['persistMessage'];
  publish: HostRecoveryPorts['publish'];
  pendingHandoff: HostRecoveryPorts['pendingHandoff'];
  log: HostRecoveryPorts['log'] & { warn(message: string): void };
}) {
  const { openKinds } = deps;
  const graph = () => {
    const current = deps.getGraph();
    if (!current) throw new Error('agent runtime is not ready');
    return current;
  };
  const codexHistory = () => {
    const history = deps.getGraph()?.contextRecovery.codexHistory;
    if (!history) throw new Error('Codex runtime is not ready');
    return history;
  };
  return {
    isContextRecoveryOpen: (data: unknown) => {
      const kind = contextRecoveryKind(data);
      return kind !== null && openKinds.has(kind);
    },
    createContextRecoveryRollover: (runtime: Parameters<typeof createHostContextRecoveryRollover>[1]) => createHostContextRecoveryRollover({
      getMaker: () => graph().maker,
      persistMessage: (...args) => deps.persistMessage(...args),
      publish: event => deps.publish(event),
      buildCreateOptsWithStderr: createSessionStderrOptions(deps.log),
      readSessionExtraDirsFromDb,
      readSessionWritableDirsFromDb,
      resolveVerifiedWindow: (agentKind, modelId, providerId) =>
        deps.getGraph()?.contextRecovery.resolveVerifiedWindow(agentKind, modelId, providerId) ?? null,
      ...(openKinds.has('oversized-history') ? { codexHistory: {
        readCodexThreadStorageReadOnly: (threadId: string) => codexHistory().readCodexThreadStorageReadOnly(threadId),
        classifyCodexHistoryOversized: (threadId: string, located?: { rolloutPath?: string }) =>
          codexHistory().classifyCodexHistoryOversized(threadId, located),
      } } : {}),
      ...(openKinds.has('unsupported-request-option') ? { piCompat: {
        read: (providerId: string, modelId: string, routeKey?: string) =>
          deps.getGraph()?.contextRecovery.piCompat.read(providerId, modelId, routeKey),
        record: async (providerId: string, modelId: string, compat: Record<string, unknown>, routeKey?: string) =>
          (await deps.getGraph()?.contextRecovery.piCompat.record(providerId, modelId, compat, routeKey)) ?? false,
      } } : {}),
      pendingHandoff: deps.pendingHandoff,
      log: deps.log,
    }, runtime),
  };
}
