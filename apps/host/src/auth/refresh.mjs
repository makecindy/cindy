/**
 * Refresh the adopted Desktop login from the host process.
 *
 * Rotation semantics match the Desktop: the server may return a new refresh
 * token, and the record must be replaced atomically; the access token stays in
 * memory only. Callers must not run this while the Desktop holds the same
 * session — the host runtime lease exists for that reason.
 */

import { readSessionDeviceId, serializeHostSession } from './device-identity.mjs';
import { serializeAuthSessionRecord } from '@cindy/auth-client';

import { AUTH_SESSION_KEY } from '../../../desktop/src/main/authCredentialKeys.ts';
import { parseAuthSessionRecord } from '@cindy/auth-client';

/**
 * @typedef {object} RefreshResult
 * @property {string} sessionToken
 * @property {'cn' | 'global'} realm
 * @property {boolean} rotated
 */

/**
 * @param {{
 *   store: {read(key: string): string | null, write(key: string, value: string): void},
 *   refresh(refreshToken: string): Promise<{accessToken: string, refreshToken?: string}>,
 * }} deps
 * @returns {Promise<RefreshResult>}
 */
export async function refreshHostSession(deps) {
  const raw = deps.store.read(AUTH_SESSION_KEY);
  const record = parseAuthSessionRecord(raw);
  const deviceId = readSessionDeviceId(raw);
  if (!record) throw new Error('no stored Cindy session to refresh');
  const tokens = await deps.refresh(record.refreshToken);
  if (!tokens.accessToken) throw new Error('refresh response contained no access token');
  const rotated = Boolean(tokens.refreshToken && tokens.refreshToken !== record.refreshToken);
  if (rotated) {
    deps.store.write(
      AUTH_SESSION_KEY,
      deviceId ? serializeHostSession(record.realm, tokens.refreshToken, deviceId) : serializeAuthSessionRecord(record.realm, tokens.refreshToken),
    );
  }
  return { sessionToken: tokens.accessToken, realm: record.realm, rotated };
}
