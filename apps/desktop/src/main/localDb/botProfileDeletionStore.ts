import { markDefaultBotOffered, withDefaultBotProvisioningLock } from '../maker-ipc/botDefaultProvisioning.js';
import { activeOwnerScopeKey, isAppSessionBoundaryPending, ownerScopedUserDataPath } from '../appSessionState.js';
import { getDbClient } from './client/current.js';

export async function commitBotProfileDeletion(input: {
  botId: string;
  sessionIds: string[];
  keepTaskHistory: boolean;
}): Promise<{ sessionIds: string[]; status: 'archived' | 'deleted' }> {
  const client = getDbClient();
  const owner = activeOwnerScopeKey();
  if (isAppSessionBoundaryPending()) throw new Error('Account is changing');
  const ownerRoot = ownerScopedUserDataPath();
  const assertOwner = () => {
    if (isAppSessionBoundaryPending() || activeOwnerScopeKey() !== owner || getDbClient() !== client)
      throw new Error('Account changed');
  };
  return withDefaultBotProvisioningLock(ownerRoot, assertOwner, async () => {
    await markDefaultBotOffered(ownerRoot);
    assertOwner();
    return client.tx('bots.deleteProfile', {
      botId: input.botId,
      sessionIds: [...new Set(input.sessionIds)],
      keepTaskHistory: input.keepTaskHistory,
      at: Date.now(),
    });
  });
}
