import type { ContextRebuildArgs } from './client/tx/types.js';

export interface ContextRebuildPersistencePorts {
  now(): number;
  createId(): string;
  tx(name: 'context.rebuild', args: ContextRebuildArgs): Promise<unknown>;
}

export async function commitContextRebuildWithPorts(
  ports: ContextRebuildPersistencePorts,
  sessionId: string,
  handoff: string,
  meta: {
    reason:
      | 'context-overflow'
      | 'model-window-switch'
      | 'pi-prompt-timeout'
      | 'native-session-recovery'
      | 'idle-gap';
    sourceUserClientId: string | null;
    sourceAgentKind?: 'cc' | 'codex' | 'pi';
    sourceModel?: string | null;
    sourceProviderId?: string | null;
    expectedClearedAt?: number | null;
    expectedSdkSessionId?: string;
    replacementRoute?: ContextRebuildArgs['replacementRoute'];
  },
): Promise<{ updatedAt: number }> {
  const now = ports.now();
  await ports.tx('context.rebuild', {
    sessionId,
    markerId: ports.createId(),
    markerClientId: `context-rebuild:${ports.createId()}`,
    markerContent: JSON.stringify({
      handoff,
      consumed: false,
      reason: meta.reason,
      sourceUserClientId: meta.sourceUserClientId,
      ...(meta.replacementRoute || meta.expectedSdkSessionId
        ? { sourceSdkSessionId: meta.replacementRoute?.expectedSdkSessionId ?? meta.expectedSdkSessionId }
        : {}),
      ...(meta.sourceAgentKind ? { sourceAgentKind: meta.sourceAgentKind } : {}),
      ...(meta.sourceModel !== undefined ? { sourceModel: meta.sourceModel } : {}),
      ...(meta.sourceProviderId !== undefined ? { sourceProviderId: meta.sourceProviderId } : {}),
    }),
    markerCreatedAt: now,
    updatedAt: now,
    expectedClearedAt: meta.expectedClearedAt ?? null,
    ...(meta.replacementRoute ? { replacementRoute: meta.replacementRoute } : {}),
    ...(meta.expectedSdkSessionId !== undefined ? { expectedSdkSessionId: meta.expectedSdkSessionId } : {}),
  });
  return { updatedAt: now };
}
