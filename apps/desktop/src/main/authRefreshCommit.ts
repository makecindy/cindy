/**
 * The saved-account vault and the rule for committing a refreshed resource session into it, moved
 * out of authManager.ts (the vault types, writeResourceSessionToVault, and the vault step of
 * commitDesktopRefreshCredentials) so the Node Host's renewal commits by the same rule.
 *
 * Electron-free: the stored records this rule reads besides the vault (the v1 session record and
 * the legacy bare token) are ports. Each caller runs it inside its own transaction under the shared
 * account-vault lock (AUTH_ACCOUNT_VAULT_LOCK_FILE in the profile): the desktop's
 * transactAuthAccountVault, the Host's auth/refresh.mjs. Neither the lock nor the storage is in this
 * module.
 */
import {
  accountVaultKey,
  storedAccountMetadataFromMembership,
  type AuthRegion,
  type AuthTokenPair,
  type StoredAccountMetadata,
} from '@cindy/auth-client';
import { loggedOutAccountKeySet, restoreLoggedOutVaultAccount } from './authAccountLogoutPolicy';

// The aggregate vault stays readable by v1 clients for explicit-login
// compatibility. Per-membership logout tombstones live in a separate key that
// older clients never read or rewrite, so their Passport sync cannot resurrect
// an account explicitly logged out by a newer client.
export const AUTH_ACCOUNT_VAULT_VERSION = 2 as const;

/** The cross-process lock every saved-account read/modify/write takes, in the profile (userData). */
export const AUTH_ACCOUNT_VAULT_LOCK_FILE = '.cindy-auth-accounts-v1.lock';

export interface StoredResourceSession {
  realm: AuthRegion;
  refreshToken: string;
  metadata: StoredAccountMetadata;
  lastUsedAt: number;
}

export interface StoredPassportSession {
  realm: AuthRegion;
  passportId: string;
  accountRefreshToken: string;
  memberships: StoredAccountMetadata[];
}

export interface AuthAccountVault {
  version: typeof AUTH_ACCOUNT_VAULT_VERSION;
  activeAccountKey: string | null;
  resources: Record<string, StoredResourceSession>;
  passports: Record<string, StoredPassportSession>;
  /** Memberships explicitly logged out on this device stay hidden until a fresh login restores them. */
  loggedOutAccountKeys?: string[];
  /**
   * Durable signed-out owner marker. The vault is the crash-consistent owner
   * record, so this must win over a compatibility session left behind by an
   * interrupted logout until another account is explicitly activated.
   */
  signedOutAt?: number;
}

export type ActiveRefreshCredentialCommit = 'active' | 'inactive' | 'discarded';

export function writeResourceSessionToVault(
  vault: AuthAccountVault,
  pair: AuthTokenPair,
  realm: AuthRegion,
  passportId: string,
  options: {
    markActive?: boolean;
    lastUsedAt?: number;
    restoreLoggedOutAccount?: boolean;
  } = {},
): void {
  const key = accountVaultKey(realm, pair.membership.id);
  if (options.restoreLoggedOutAccount) restoreLoggedOutVaultAccount(vault, key);
  vault.resources[key] = {
    realm,
    refreshToken: pair.refreshToken,
    metadata: storedAccountMetadataFromMembership(pair.membership, passportId),
    lastUsedAt: options.lastUsedAt ?? Date.now(),
  };
  if (options.markActive !== false) {
    delete vault.signedOutAt;
    vault.activeAccountKey = key;
  }
}

/**
 * Commit a refreshed resource session (`pair`, from refreshing `requestedRefreshToken`) into the
 * vault read under the shared account-vault lock. 'active': this refresh still owns the active
 * session, so the caller writes the v1 session record too. 'inactive': only the account's saved
 * token was replaced. 'discarded': nothing was written.
 */
export function applyRefreshedCredentialsToVault(
  vault: AuthAccountVault,
  input: {
    pair: AuthTokenPair;
    realm: AuthRegion;
    requestedRefreshToken: string;
    allowUnclaimedVault?: boolean;
    /** The build's region: the legacy bare token has no realm and belongs to it. */
    buildRegion: AuthRegion;
    /** The v1 session record as stored now. */
    readStoredSession(): { realm: AuthRegion; refreshToken: string } | null;
    /** The legacy bare resource refresh token as stored now. */
    readLegacyResourceRefreshToken(): string | null;
  },
): ActiveRefreshCredentialCommit {
  const { pair, realm, requestedRefreshToken } = input;
  const key = accountVaultKey(realm, pair.membership.id);
  const latestSession = input.readStoredSession();
  const requestedTokenStillStored =
    (latestSession?.realm === realm && latestSession.refreshToken === requestedRefreshToken) ||
    (vault.activeAccountKey === key &&
      vault.resources[key]?.realm === realm &&
      vault.resources[key]?.refreshToken === requestedRefreshToken) ||
    (realm === input.buildRegion &&
      input.readLegacyResourceRefreshToken() === requestedRefreshToken);
  const canClaimUninitializedVault =
    input.allowUnclaimedVault === true &&
    vault.activeAccountKey === null &&
    typeof vault.signedOutAt !== 'number' &&
    Object.keys(vault.resources).length === 0 &&
    !loggedOutAccountKeySet(vault).has(key);
  const stillOwnsActiveSession =
    requestedTokenStillStored && (vault.activeAccountKey === key || canClaimUninitializedVault);
  const passportId = pair.membership.passportId;
  if (
    passportId &&
    (stillOwnsActiveSession || vault.resources[key]?.refreshToken === requestedRefreshToken)
  ) {
    // A passive stale refresh may still rotate account A's resource token
    // after the primary has committed account B. Preserve A for a future
    // explicit switch, but never let that late result reclaim activeAccountKey.
    writeResourceSessionToVault(vault, pair, realm, passportId, {
      markActive: stillOwnsActiveSession,
    });
  }
  if (stillOwnsActiveSession) return 'active';
  return vault.resources[key] ? 'inactive' : 'discarded';
}
