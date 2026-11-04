/**
 * Host logout: revoke server-side and clear the shared local records.
 *
 * Same meaning as the Desktop action — one device identity, one account — so a
 * host logout also ends the Desktop session. Local records are still cleared if
 * the server call fails, because a rotated/invalid token is not a reason to keep
 * a dead session on disk.
 */

import { parseAuthSessionRecord } from '@cindy/auth-client';

import {
  AUTH_SESSION_KEY,
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
