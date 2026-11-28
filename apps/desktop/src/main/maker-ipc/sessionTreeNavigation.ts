import { createId } from '@paralleldrive/cuid2';
import type { NavigateSessionTreeResult } from '@cindy/maker-core';
import { getCurrentDbClientSnapshot, type CurrentDbClientSnapshot } from '../localDb/client/current';
import { recomputePrRefsForSession } from '../git-context/prRefsStore';
import { throwIpcError } from '../utils/ipcValidate';

/** Bind native navigation, persistence and publication to the initiating account generation. */
export function assertSessionTreeOwner(
  owner: CurrentDbClientSnapshot | null,
): asserts owner is CurrentDbClientSnapshot {
  if (!owner) throwIpcError('PRECONDITION_FAILED', 'DbClient not ready');
  if (getCurrentDbClientSnapshot() !== owner) {
    throwIpcError('PERMISSION_DENIED', 'Session tree account changed');
  }
}

/** Caller holds the existing send lock until native history and its derived PRs settle. */
export async function navigateAndRehydrateSessionTree(
  sessionId: string,
  owner: CurrentDbClientSnapshot,
  navigate: () => Promise<NavigateSessionTreeResult>,
) {
  assertSessionTreeOwner(owner);
  const result = await navigate();
  assertSessionTreeOwner(owner);
  const now = Date.now();
  if (result.cancelled) return { result, hiddenClientIds: [] as string[], now };
  const { hiddenClientIds } = await owner.client.tx('session.treeRehydrate', {
    sessionId,
    now,
    contextTokens: result.contextTokens,
    contextWindow: result.contextWindow,
    messages: result.messages.map((message) => ({
      id: createId(),
      clientId: message.clientId,
      role: message.role,
      content: JSON.stringify(message.content),
      toolUseId: message.toolUseId ?? null,
      agentMeta: message.agentMeta ? JSON.stringify(message.agentMeta) : null,
      agentKind: 'pi',
      createdAt: message.createdAt,
    })),
  });
  assertSessionTreeOwner(owner);
  await recomputePrRefsForSession(sessionId, {
    dbClient: owner.client,
    isCurrent: () => getCurrentDbClientSnapshot() === owner,
  });
  assertSessionTreeOwner(owner);
  return { result, hiddenClientIds, now };
}
