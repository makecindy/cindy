/**
 * Transfer a local Codex native writer before changing hosts.
 *
 * The caller selects the native fork route. The replacement thread id and the
 * complete target runtime route are then committed by one caller-provided CAS.
 */

import { resolveAgentCredentialMode } from '@cindy/maker-core';
import { and, eq, isNull } from 'drizzle-orm';
import type { DbClient } from '../localDb/client/DbClient.js';
import { sessions } from '../localDb/schema.js';

export type CodexThreadTransferSnapshot = Pick<typeof sessions.$inferSelect,
  'id' | 'sdkSessionId' | 'model' | 'providerId' | 'effort' | 'fastMode' | 'updatedAt'>;

export function codexThreadTransferSourcePredicate(source: CodexThreadTransferSnapshot) {
  return and(
    eq(sessions.id, source.id), eq(sessions.status, 'active'),
    eq(sessions.agentKind, 'codex'), isNull(sessions.remoteHostId),
    source.sdkSessionId === null ? isNull(sessions.sdkSessionId) : eq(sessions.sdkSessionId, source.sdkSessionId),
    source.model === null ? isNull(sessions.model) : eq(sessions.model, source.model),
    source.providerId === null ? isNull(sessions.providerId) : eq(sessions.providerId, source.providerId),
    eq(sessions.effort, source.effort), eq(sessions.fastMode, source.fastMode),
    eq(sessions.updatedAt, source.updatedAt),
  );
}

export async function commitCodexThreadTransfer(
  db: Pick<DbClient, 'drizzle'>,
  source: CodexThreadTransferSnapshot,
  target: Pick<typeof sessions.$inferSelect, 'sdkSessionId' | 'model' | 'providerId' | 'fastMode'> &
    { effort?: typeof sessions.$inferSelect.effort; contextWindow?: number },
): Promise<boolean> {
  const result = await db.drizzle.update(sessions).set({ ...target, updatedAt: Date.now() })
    .where(codexThreadTransferSourcePredicate(source)).run();
  return result.changes === 1;
}

export interface CodexProviderThreadRoute {
  model: string;
  providerId: string | null;
  effort: string | null;
  fastMode: boolean;
}

export interface CodexProviderThreadRelinkSource extends CodexProviderThreadRoute {
  sdkSessionId: string | null;
  workingDir: string | null;
}

export interface CodexProviderThreadRelinkDeps {
  readSource(sessionId: string): Promise<CodexProviderThreadRelinkSource | null>;
  needsFork?(threadId: string): Promise<boolean>;
  fork(input: {
    sourceSdkSessionId: string;
    sourceModel: string;
    sourceProviderId: string | null;
    workingDir?: string;
  }): Promise<{ newSdkSessionId: string; cleanup?: () => Promise<void> }>;
  commit(input: {
    sessionId: string;
    source: CodexProviderThreadRelinkSource & { sdkSessionId: string };
    newSdkSessionId: string;
    target: CodexProviderThreadRoute;
  }): Promise<boolean>;
}

export function isXdOpenAiCodexProviderTransition(
  sourceProviderId: string | null | undefined,
  targetProviderId: string | null | undefined,
): boolean {
  const source = sourceProviderId?.trim() || null;
  const target = targetProviderId?.trim() || null;
  return (source === 'xd' && target === 'openai') || (source === 'openai' && target === 'xd');
}

export type CodexProviderThreadRelinkDecision = 'relink' | 'not-applicable' | 'unresolved';

export function decideCodexProviderThreadRelink(
  source: Pick<CodexProviderThreadRoute, 'model' | 'providerId'>,
  target: Pick<CodexProviderThreadRoute, 'model' | 'providerId'>,
): CodexProviderThreadRelinkDecision {
  const sourceMode = resolveAgentCredentialMode({ agentKind: 'codex', ...source });
  const targetMode = resolveAgentCredentialMode({ agentKind: 'codex', ...target });
  const toProviderIdentity = (mode: typeof sourceMode): 'xd' | 'openai' | null => {
    if (mode === 'gateway-key') return 'xd';
    if (mode === 'oauth-bearer') return 'openai';
    return null;
  };
  const involvesXdOpenAiBoundary = [sourceMode, targetMode].some(
    (mode) => mode === 'gateway-key' || mode === 'oauth-bearer',
  );
  if (involvesXdOpenAiBoundary && (sourceMode === undefined || targetMode === undefined)) {
    return 'unresolved';
  }
  return isXdOpenAiCodexProviderTransition(
    toProviderIdentity(sourceMode),
    toProviderIdentity(targetMode),
  )
    ? 'relink'
    : 'not-applicable';
}

export async function relinkCodexProviderThread(
  deps: CodexProviderThreadRelinkDeps,
  input: { sessionId: string; target: CodexProviderThreadRoute },
): Promise<{ previousSdkSessionId: string; newSdkSessionId: string } | null> {
  const source = await deps.readSource(input.sessionId);
  if (!source?.sdkSessionId) return null;

  const sourceWithThread = { ...source, sdkSessionId: source.sdkSessionId };
  const forked = deps.needsFork && !await deps.needsFork(sourceWithThread.sdkSessionId)
    ? { newSdkSessionId: sourceWithThread.sdkSessionId }
    : await deps.fork({
    sourceSdkSessionId: sourceWithThread.sdkSessionId,
    sourceModel: sourceWithThread.model,
    sourceProviderId: sourceWithThread.providerId,
    ...(sourceWithThread.workingDir ? { workingDir: sourceWithThread.workingDir } : {}),
  });
  try {
    const committed = await deps.commit({
      sessionId: input.sessionId,
      source: sourceWithThread,
      newSdkSessionId: forked.newSdkSessionId,
      target: input.target,
    });
    if (!committed) {
      throw new Error(`Codex provider thread relink was superseded for session ${input.sessionId}`);
    }
  } catch (error) {
    await forked.cleanup?.().catch(() => undefined);
    throw error;
  }
  return {
    previousSdkSessionId: sourceWithThread.sdkSessionId,
    newSdkSessionId: forked.newSdkSessionId,
  };
}
