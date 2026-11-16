/**
 * Adopt the login the Desktop already stored.
 *
 * Reads the same `AUTH_SESSION_KEY` safeStorage record the Electron main process
 * writes and parses it with the shared `@cindy/auth-client` schema. Only the
 * non-secret projection (authenticated / realm) leaves this module; the refresh
 * token stays internal so it can never reach logs, HTTP responses or screenshots.
 */

import { parseAuthSessionRecord } from '@cindy/auth-client';

import { AUTH_SESSION_KEY } from '../../../desktop/src/main/authCredentialKeys.ts';
import { createCredentialStore } from './store.mjs';

/**
 * @param {{read(key: string): string | null}} store
 * @returns {{authenticated: boolean, realm: 'cn' | 'global' | null}}
 */
export function projectAdoptedSession(store) {
  const record = parseAuthSessionRecord(store.read(AUTH_SESSION_KEY));
  return record
    ? { authenticated: true, realm: record.realm }
    : { authenticated: false, realm: null };
}

/**
 * @param {{userDataDir: string, keyringApplication?: string}} options
 * @returns {Promise<{authenticated: boolean, realm: 'cn' | 'global' | null}>}
 */
export async function readAdoptedSessionState(options) {
  return projectAdoptedSession(await createCredentialStore(options));
}
