import { isProviderShareAgentDeviceId } from '../../shared/providerShare.js';
import type { commitContextRebuild } from '../localDb/ipc/messages.js';
import type { sessions } from '../localDb/schema.js';
import { buildHandoff, type HandoffSourceMessage } from './agentHandoff.js';
import type { MakerSessionCreateOpts } from './sessionRequest.js';

type RecoveryRow = Pick<typeof sessions.$inferSelect,
  'sdkSessionId' | 'status' | 'agentKind' | 'agentDeviceId' | 'providerId' | 'model' | 'clearedAt'>;

export interface SharedSessionResumeRecoveryDeps {
  assertCurrent(): void;
  readGeneration(sessionId: string): number;
  getSessionRow(sessionId: string): Promise<RecoveryRow | undefined>;
  listMessages(sessionId: string): Promise<HandoffSourceMessage[]>;
  resolveHandoffWindow?(sessionId: string, route: {
    agentKind: MakerSessionCreateOpts['agentKind'];
    agentDeviceId: string;
    model: string;
    providerId: string | null;
    workingBudget?: number | null;
  }): Promise<number | null>;
  commit: typeof commitContextRebuild;
  setPending(sessionId: string, handoff: string, generation: number): void;
  publish(sessionId: string): void;
}

/** Only the host's pre-SDK ownership rejection proves that no native turn ran.
 * Do not match the Pi adapter's similar message or generic REMOTE_AGENT_INVALID.
 * The durable handoff and SDK reset commit together before opening a fresh run.
 */
export async function withSharedSessionResumeRecovery<T>(
  options: MakerSessionCreateOpts,
  start: () => Promise<T>,
  deps: SharedSessionResumeRecoveryDeps,
): Promise<T> {
  const sessionId = options.id;
  const resumeId = options.resumeSessionId;
  const generation = sessionId ? deps.readGeneration(sessionId) : undefined;
  try {
    return await start();
  } catch (error) {
    if (!sessionId || !resumeId || !isProviderShareAgentDeviceId(options.agentDeviceId) || options.remoteHostId ||
      !(error instanceof Error) ||
      error.message !== '[REMOTE_AGENT_INVALID] this conversation cannot be resumed on this computer') throw error;
    const assertCurrent = () => {
      deps.assertCurrent();
      if (deps.readGeneration(sessionId) !== generation) throw new Error('Session history changed during resume recovery');
    };
    assertCurrent();
    const row = await deps.getSessionRow(sessionId);
    assertCurrent();
    const kind = options.agentKind === 'claude-code' ? 'cc' : options.agentKind;
    if (!row || row.status === 'deleted' || row.sdkSessionId !== resumeId || row.agentKind !== kind ||
      row.agentDeviceId !== options.agentDeviceId || row.providerId !== (options.providerId ?? null) ||
      row.model !== options.model || !row.model) throw error;
    const history = await deps.listMessages(sessionId);
    const targetContextWindow = await deps.resolveHandoffWindow?.(sessionId, {
      agentKind: options.agentKind, agentDeviceId: options.agentDeviceId!, model: row.model,
      providerId: row.providerId, workingBudget: options.contextWindowBudget,
    });
    assertCurrent();
    const { handoff, handoffCoverage } = buildHandoff(history, {
      targetContextWindow,
      fromLabel: options.agentKind, toLabel: options.agentKind, sessionId, reason: 'native-session-recovery',
    });
    await deps.commit(sessionId, handoff, {
      reason: 'native-session-recovery', handoffCoverage, sourceUserClientId: null,
      sourceAgentKind: kind, sourceModel: row.model, sourceProviderId: row.providerId,
      expectedClearedAt: row.clearedAt,
      expectedSdkSessionId: resumeId,
    });
    assertCurrent();
    deps.setPending(sessionId, handoff, generation!);
    options.resumeSessionId = undefined;
    const vendorOptions = { ...options.vendorOptions };
    for (const key of ['resumeSessionAt', 'forkSession', 'threadId', 'tailTurnsToDrop', '_cindyRequireNativeResume']) {
      delete vendorOptions[key];
    }
    options.vendorOptions = vendorOptions;
    deps.publish(sessionId);
    assertCurrent();
    // Outside the catch: a fresh-start failure is returned, never retried here.
  }
  return start();
}
