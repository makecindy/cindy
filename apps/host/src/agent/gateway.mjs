/**
 * Cindy gateway credentials for the host.
 *
 * Reads the same two artefacts the Desktop uses for its gateway-key lane: the
 * owner-scoped API key in `safe-storage` (Chromium OSCrypt, already implemented
 * here) and the server-issued endpoint record under the owner namespace. Nothing
 * is copied elsewhere and the key never leaves this module except as an env value
 * passed to the agent process.
 */

import fs from 'node:fs';

import { dataOwnerStorageKey } from '../../../desktop/src/main/dataOwnerPath.ts';
import { createCredentialStore } from '../credentials/store.mjs';
import { isValidCredentialsPayload } from '../../../desktop/src/main/model-access/credentialsSync.ts';
import { readAuthEndpoints } from '../auth/endpoints.mjs';

const GATEWAY_SECRET_STORAGE_KEY = 'api_key';

/** Provision through the same signed-in account endpoint as Desktop. The key
 * stays in this process; a fresh preview never copies another profile's vault.
 */
export async function fetchGatewayCredentials({ sessionToken, region, request = fetch }) {
  if (!sessionToken) return null;
  const base = readAuthEndpoints(region).modelAccessApiBaseUrl;
  if (!base) return null;
  const response = await request(`${base.replace(/\/+$/, '')}/api/model-access/credentials`, {
    headers: { authorization: `Bearer ${sessionToken}` },
    redirect: 'error', signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`HOST_MODEL_ACCESS_HTTP_${response.status}`);
  const payload = await response.json();
  if (!isValidCredentialsPayload(payload)) throw new Error('HOST_MODEL_ACCESS_INVALID_RESPONSE');
  return { credential: payload.apiKey, endpoint: payload.endpoint.replace(/\/+$/, '') };
}

/**
 * @param {{userDataDir: string, ownerId: string, keyringApplication?: string}} options
 * @returns {Promise<{apiKey: string, endpoint: string} | null>}
 */
export async function readGatewayCredentials(options) {
  const ownerKey = options.ownerKey ?? dataOwnerStorageKey(options.ownerId);
  const recordPath = `${options.userDataDir}/owners/${ownerKey}/model-access-credentials.json`;
  let endpoint = null;
  try {
    const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
    // A user-entered key without a server endpoint cannot reach the gateway.
    if (record?.source === 'server' && typeof record.endpoint === 'string' && record.endpoint) {
      endpoint = record.endpoint.replace(/\/+$/, '');
    }
  } catch {
    return null;
  }
  if (!endpoint) return null;

  const store = await createCredentialStore({
    userDataDir: options.userDataDir,
    keyringApplication: options.keyringApplication,
  });
  let credential = null;
  try {
    credential = store.read(`owner_${ownerKey}_${GATEWAY_SECRET_STORAGE_KEY}`);
  } catch {
    return null;
  }
  return credential ? { credential, endpoint } : null;
}
