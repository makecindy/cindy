import { activeOwnerScopeKey, getActiveAppSession, isAppSessionBoundaryPending } from '../../appSessionState.js';
import { getGhostManager, getGhostSetupAssessment, isGhostAvailableForActiveSession } from '../../cindy-brain/index.js';
import { canUseGithubHostCredentials } from '../../cindy-brain/GhostManager.js';
import { isGhostDisabledForWorkdir } from '../../cindy-brain/ghostWorkdirPrefs.js';
import { installedGhostStoragePart } from '../../../shared/pluginIdentity.js';
import { getSessionFsSnapshot } from '../../localDb/ipc/sessions.js';
import { getSharedGhCliTokenSource } from '../../git-context/ghCliTokenSource.js';
import { githubConnection } from '../../git-context/githubConnection.js';
import { outboundFetch } from '../../maker-host/outbound-fetch.js';
import { readGhostSecret } from '../../secrets/providerSecretStore.js';
import { createGithubAuthRecovery } from './githubRecovery.js';

/** Reuse the official plugin's gh-cli -> same-instance PAT credential precedence. */
export const resolveGithubAuthRecovery = createGithubAuthRecovery({
  ownerKey: () => {
    const owner = getActiveAppSession();
    return owner.mode !== 'signed-out' && owner.dataOwnerId && !isAppSessionBoundaryPending()
      ? activeOwnerScopeKey() : null;
  },
  sessionContext: getSessionFsSnapshot,
  listGhosts: () => getGhostManager().list(),
  isAvailableForActiveSession: isGhostAvailableForActiveSession,
  isDisabledForWorkdir: isGhostDisabledForWorkdir,
  isTrusted: canUseGithubHostCredentials,
  setupReady: (instanceId) => getGhostSetupAssessment(instanceId).state === 'ready',
  connected: async (ghost, isCurrent) => {
    const secrets = ghost.manifest.network?.secrets?.filter((secret) =>
      secret.source === 'gh-cli' && secret.inject.hosts?.includes('api.github.com')) ?? [];
    // Unknown/custom credential contracts are left to the plugin itself.
    if (secrets.length !== 1 || !isCurrent()) return false;
    const instanceId = installedGhostStoragePart(ghost);
    const result = await githubConnection({
      readGh: async () => isCurrent() ? getSharedGhCliTokenSource().readToken() : null,
      readFallback: () => isCurrent() ? readGhostSecret(instanceId, secrets[0].key) : null,
      fetch: (input, init) => {
        if (!isCurrent()) throw new Error('Authentication recovery context changed');
        return outboundFetch(input, init);
      },
    });
    return result.status === 'connected' && isCurrent();
  },
});
