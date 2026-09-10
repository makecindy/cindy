import { app, net } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import type { Catalog } from '@cindy/model-providers';
import { getAccessToken } from '../authManager.js';
import { getClientEndpoint } from '../clientEndpointsService.js';
const instanceId = randomUUID();
/** Called only after source acceptance and successful synchronous model assembly. Best-effort, no auth side effects. */
export function reportCatalogConsumption(catalog: Catalog): void {
  if (!/^catalog-\d+$/.test(catalog.version) || catalog.modelRegistry?.schemaVersion !== 5) return;
  const token = getAccessToken();
  if (!token) return;
  const canonical = JSON.stringify(catalog.modelRegistry, (_key, value) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, value[key]]),
        )
      : value,
  );
  void net
    .fetch(`${getClientEndpoint('modelAccessApiBaseUrl')}/api/model-catalog/receipts`, {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        instanceId,
        version: catalog.version,
        registryDigest: createHash('sha256').update(canonical).digest('hex'),
        clientVersion: app.getVersion(),
        phase: 'resolved',
      }),
      signal: AbortSignal.timeout(5000),
    })
    .catch(() => undefined);
}
