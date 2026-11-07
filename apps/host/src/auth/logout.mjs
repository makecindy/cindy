/**
 * Host logout: revoke server-side and clear the shared local records.
 *
 * Same meaning as the Desktop action — one device identity, one account — so a
 * host logout also ends the Desktop session. Local records are still cleared if
 * the server call fails, because a rotated/invalid token is not a reason to keep
 * a dead session on disk.
 */

import { parseAuthSessionRecord, accountVaultKey } from '@cindy/auth-client';
import { removeLoggedOutVaultAccount } from '../../../desktop/src/main/authAccountLogoutPolicy.js';

import {
  AUTH_SESSION_KEY,
  AUTH_ACCOUNT_VAULT_KEY,
  AUTH_ACCOUNT_LOGOUT_TOMBSTONES_KEY,
  LEGACY_ACCOUNT_REFRESH_TOKEN_KEY,
  LEGACY_REFRESH_TOKEN_KEY,
  LEGACY_RESOURCE_REFRESH_TOKEN_KEY,
} from '../../../desktop/src/main/authCredentialKeys.ts';

/**
 * @param {{
 *   store: {read(key: string): string | null, write(key: string, value: string): void, remove(key: string): void},
 *   refresh(refreshToken: string): Promise<{accessToken: string, refreshToken?: string}>,
 *   logout(accessToken: string): Promise<void>,
 * }} deps
 * @returns {Promise<{signedOut: true, serverRevoked: boolean, detail?: string}>}
 */
export async function logoutHostSession(deps) {
  const record = parseAuthSessionRecord(deps.store.read(AUTH_SESSION_KEY));
  // Persist the same tombstone Desktop observes before removing compatibility
  // records. Otherwise opening Desktop restores the supposedly signed-out user.
  if (deps.ownerId && record) {
    const key = accountVaultKey(record.realm, deps.ownerId);
    const raw = deps.store.read(AUTH_ACCOUNT_VAULT_KEY);
    const vault = raw ? JSON.parse(raw) : { version: 1, activeAccountKey: null, resources: {}, passports: {} };
    if (![1, 2].includes(vault.version) || !vault.resources || !vault.passports) throw new Error('Saved accounts are unavailable');
    const tombstoneRaw = deps.store.read(AUTH_ACCOUNT_LOGOUT_TOMBSTONES_KEY);
    const tombstones = tombstoneRaw ? JSON.parse(tombstoneRaw) : { version: 1, accountKeys: [] };
    if (tombstones.version !== 1 || !Array.isArray(tombstones.accountKeys)) throw new Error('Saved account logout state is unavailable');
    vault.loggedOutAccountKeys = [...new Set([...(vault.loggedOutAccountKeys ?? []), ...tombstones.accountKeys])];
    removeLoggedOutVaultAccount(vault, { accountKey: key, realm: record.realm,
      passportId: deps.passportId || vault.resources[key]?.metadata?.passportId || '',
    });
    vault.signedOutAt = Date.now();
    deps.store.write(AUTH_ACCOUNT_LOGOUT_TOMBSTONES_KEY, JSON.stringify({ version: 1, accountKeys: vault.loggedOutAccountKeys }));
    deps.store.write(AUTH_ACCOUNT_VAULT_KEY, JSON.stringify({ ...vault, version: 1 }));
  }
  let serverRevoked = false;
  let detail;

  if (record) {
    try {
      const tokens = await deps.refresh(record.refreshToken);
      if (tokens.accessToken) {
        await deps.logout(tokens.accessToken);
        serverRevoked = true;
      } else {
        detail = 'refresh returned no access token';
      }
    } catch (error) {
      detail = error instanceof Error ? error.message : String(error);
    }
  } else {
    detail = 'no stored session';
  }

  deps.store.remove(AUTH_SESSION_KEY);
  for (const key of [LEGACY_RESOURCE_REFRESH_TOKEN_KEY, LEGACY_ACCOUNT_REFRESH_TOKEN_KEY, LEGACY_REFRESH_TOKEN_KEY]) {
    deps.store.remove(key);
  }
  return { signedOut: true, serverRevoked, ...(detail ? { detail } : {}) };
}
