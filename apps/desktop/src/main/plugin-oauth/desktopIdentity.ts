import { safeStorage } from 'electron';
import { getCurrentUserId, getDeviceId, getActiveAuthRealm } from '../authManager.js';
import {
  getActiveAppSession,
  isAppSessionBoundaryPending,
  ownerScopedUserDataPath,
} from '../appSessionState.js';
import {
  OauthIdentityStore,
  oauthIdentityScopeKey,
  oauthSecureStorageAvailable,
  type OauthIdentityScope,
} from './identityStore.js';
import type { PluginOauthPeerIdentity } from '@cindy/device-link';

/** The normal authenticated Desktop owner, independent of distribution or instance configuration. */
export function currentOauthIdentityScope(): OauthIdentityScope | null {
  const session = getActiveAppSession();
  const membershipId = getCurrentUserId();
  if (
    isAppSessionBoundaryPending() ||
    session.mode !== 'cloud' ||
    !membershipId ||
    session.dataOwnerId !== membershipId
  )
    return null;
  return { realm: getActiveAuthRealm(), membershipId, deviceId: getDeviceId() };
}

const store = new OauthIdentityStore({
  filePath: (scope) =>
    ownerScopedUserDataPath('plugin-oauth', `${oauthIdentityScopeKey(scope)}.v1.enc`),
  available: () => {
    try {
      return oauthSecureStorageAvailable({
        platform: process.platform,
        available: safeStorage.isEncryptionAvailable(),
        backend: process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : undefined,
      });
    } catch {
      return false;
    }
  },
  encrypt: (value) => safeStorage.encryptString(value),
  decrypt: (value) => safeStorage.decryptString(value),
});

function scopedCheck(scope: OauthIdentityScope, assertCurrent: () => void): () => void {
  const expected = oauthIdentityScopeKey(scope);
  return () => {
    assertCurrent();
    const current = currentOauthIdentityScope();
    if (!current || oauthIdentityScopeKey(current) !== expected)
      throw new Error('OAUTH_IDENTITY_UNAVAILABLE');
  };
}

export function loadOauthSigningKey(scope: OauthIdentityScope, assertCurrent: () => void) {
  return store.load(scope, scopedCheck(scope, assertCurrent));
}

/** Called after signed proof of possession, before any browser/secret operation. */
export async function trustOauthPeer(
  identity: PluginOauthPeerIdentity,
  assertCurrent: () => void,
): Promise<void> {
  const scope = currentOauthIdentityScope();
  if (!scope || identity.realm !== scope.realm || identity.membershipId !== scope.membershipId)
    throw new Error('OAUTH_IDENTITY_UNAVAILABLE');
  await store.trustPeer(
    scope,
    identity.deviceId,
    identity.publicKey,
    scopedCheck(scope, assertCurrent),
  );
}
