/**
 * Provider projection for the web client.
 *
 * The host has exactly one usable route today: the Cindy gateway with the
 * account's key. Rather than inventing a catalog, this lists the gateway's own
 * chat models (fetched with that key) as one connected provider, so the existing
 * model selector can render and route a real request.
 */

const CACHE_MS = 5 * 60_000;
const GATEWAY_PROVIDER_ID = 'cindy-gateway';

let cached = null;

async function fetchChatModels(gateway) {
  const response = await fetch(`${gateway.endpoint}/v1/models`, {
    headers: { 'x-api-key': gateway.credential, authorization: `Bearer ${gateway.credential}` },
  });
  if (!response.ok) throw new Error(`gateway models ${response.status}`);
  const body = await response.json();
  return (body?.data ?? [])
    .filter((model) => model?.mode === 'chat' && typeof model.id === 'string')
    .map((model) => ({ id: model.id, name: model.id }));
}

/**
 * @param {{gateway: {endpoint: string, credential: string} | null}} options
 * @returns {Promise<{dataOwnerId: string|null, ownerGeneration: number, providers: any[], providerOrder: string[], error?: string}>}
 */
export async function listProviders(options) {
  if (!options.gateway) {
    return { dataOwnerId: null, ownerGeneration: 0, providers: [], providerOrder: [] };
  }
  const now = Date.now();
  if (!cached || now - cached.at > CACHE_MS) {
    try {
      cached = { at: now, models: await fetchChatModels(options.gateway) };
    } catch (error) {
      return {
        dataOwnerId: null, ownerGeneration: 0, providers: [], providerOrder: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  return {
    dataOwnerId: null,
    ownerGeneration: 0,
    providerOrder: [GATEWAY_PROVIDER_ID],
    providers: [{
      id: GATEWAY_PROVIDER_ID,
      name: 'Cindy Gateway',
      source: 'builtin',
      agents: ['claude-code'],
      auth: { method: 'api-key' },
      access: { kind: 'gateway' },
      models: { 'claude-code': cached.models },
      connected: true,
    }],
  };
}
