/**
 * Provider projection for the web client.
 *
 * Combines user custom providers (from SQLite custom_providers table)
 * with the Cindy gateway chat models when gateway credentials are present.
 */

import { asc } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { buildUserProvider } from '../../../../packages/model-providers/src/index.js';
import { getDbClient } from '../../../desktop/src/main/localDb/client/current.js';
import { customProviders } from '../../../desktop/src/main/localDb/schema.js';

const CACHE_MS = 5 * 60_000;
const GATEWAY_PROVIDER_ID = 'xd';

async function fetchChatModels(gateway) {
  const response = await fetch(`${gateway.endpoint}/v1/models`, {
    headers: { 'x-api-key': gateway.credential, authorization: `Bearer ${gateway.credential}` },
  });
  if (!response.ok) throw new Error(`gateway models ${response.status}`);
  const body = await response.json();
  return (body?.data ?? [])
    .filter((model) => model?.mode === 'chat' && typeof model.id === 'string')
    .map((model) => ({ id: model.id, name: model.id, efforts: [], defaultEffort: null, contextWindow: 0 }));
}

async function fetchCustomProviders() {
  const dbClient = getDbClient();
  if (!dbClient) return [];
  try {
    const rows = await dbClient.drizzle
      .select()
      .from(customProviders)
      .orderBy(asc(customProviders.sortOrder));
    const result = [];
    for (const row of rows) {
      try {
        const runtimes = typeof row.runtimes === 'string' ? JSON.parse(row.runtimes) : row.runtimes;
        const provider = buildUserProvider({
          id: row.id,
          name: row.name,
          runtimes: runtimes ?? {},
          ...(row.auth ? { auth: JSON.parse(row.auth) } : {}),
        });
        result.push({
          ...provider,
          connected: true,
        });
      } catch (err) {
        console.warn('[providers] failed to parse custom provider:', row.id, err);
      }
    }
    return result;
  } catch (err) {
    console.warn('[providers] failed to query custom_providers:', err);
    return [];
  }
}

/**
 * @param {{gateway: {endpoint: string, credential: string} | null, ownerId?: string | null}} options
 * @returns {Promise<{dataOwnerId: string|null, ownerGeneration: number, providers: any[], providerOrder: string[], error?: string}>}
 */
export function createProviderCatalog({ readCustom = fetchCustomProviders, fetchModels = fetchChatModels } = {}) {
let cached = null;
return async function listProviders(options) {
  const owner = options.ownerId ? { dataOwnerId: options.ownerId, ownerGeneration: 1 } : { dataOwnerId: null, ownerGeneration: 0 };
  const custom = await readCustom();
  const providers = [...custom];
  const providerOrder = custom.map((p) => p.id);

  if (options.gateway) {
    const now = Date.now();
    const key = createHash('sha256').update(JSON.stringify([options.ownerId, options.gateway.endpoint, options.gateway.credential])).digest('hex');
    // Keep this request's snapshot local: another owner's request may complete
    // during fetch. Neither an error nor completion order may select its cache.
    let current = cached?.key === key ? cached : null;
    if (!current || now - current.at > CACHE_MS) {
      try {
        current = { key, at: now, models: await fetchModels(options.gateway) };
        cached = current;
      } catch (error) {
        console.warn('[providers] failed to fetch gateway chat models:', error instanceof Error ? error.message : String(error));
      }
    }
    if (current?.models) {
      providers.push({
        id: GATEWAY_PROVIDER_ID,
        name: 'Cindy Gateway',
        source: 'builtin',
        agents: ['claude-code', 'codex'],
        auth: { method: 'managed' },
        access: { kind: 'managed' },
        routing: {
          'claude-code': { upstream: options.gateway.endpoint, authStrategy: 'gateway-key' },
          codex: { upstream: `${options.gateway.endpoint.replace(/\/v1\/?$/, '')}/v1`, authStrategy: 'gateway-key', supportsResponsesCustomTools: false },
        },
        models: { 'claude-code': current.models, codex: current.models },
        connected: true,
      });
      providerOrder.push(GATEWAY_PROVIDER_ID);
    }
  }

  return {
    ...owner,
    providerOrder,
    providers,
  };
};
}

export const listProviders = createProviderCatalog();
