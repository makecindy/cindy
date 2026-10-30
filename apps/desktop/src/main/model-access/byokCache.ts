import { createHash } from 'node:crypto';
import {
  parseByokProvidersResponse,
  parseByokCredentialsResponse,
  type ByokProvidersResponse,
} from '@cindy/model-providers';
import type { ByokOwner, ByokConnection } from './byokSync.js';

export interface ByokCache {
  load(owner: ByokOwner): { catalog: ByokProvidersResponse; connections: ByokConnection[] } | null;
  save(
    owner: ByokOwner,
    catalog: ByokProvidersResponse,
    connections: readonly ByokConnection[],
  ): void;
}
/** One encrypted snapshot binds the identity, directory, endpoint and keys atomically. */
export function createByokCache(
  io: { read(key: string): string | null; write(key: string, value: string): boolean },
  now = Date.now,
): ByokCache {
  const key = (owner: ByokOwner) =>
    `byok_cache_${createHash('sha256')
      .update(JSON.stringify([owner.cacheScope, owner.organizationId]))
      .digest('hex')}`;
  return {
    load(owner) {
      if (!owner.cacheScope) return null;
      try {
        const raw = io.read(key(owner));
        if (!raw) return null;
        const saved = JSON.parse(raw);
        if (
          saved.scope !== owner.cacheScope ||
          saved.organizationId !== owner.organizationId ||
          !Number.isFinite(saved.savedAt) ||
          now() - saved.savedAt > 86400000 ||
          saved.savedAt > now()
        )
          return null;
        const catalog = parseByokProvidersResponse(saved.catalog);
        const credentials = parseByokCredentialsResponse(saved.credentials);
        if (
          !catalog.ok ||
          !credentials.ok ||
          catalog.value.organizationId !== owner.organizationId ||
          credentials.value.organizationId !== owner.organizationId
        )
          return null;
        const connections = catalog.value.providers.flatMap((provider) => {
          const credential = credentials.value.credentials.find(
            (item) =>
              item.providerId === provider.id &&
              item.connectionRevision === provider.connectionRevision,
          );
          return credential?.status === 'ready' ? [{ provider, credential }] : [];
        });
        return { catalog: catalog.value, connections };
      } catch {
        return null;
      }
    },
    save(owner, catalog, connections) {
      if (!owner.cacheScope) return;
      try {
        io.write(
          key(owner),
          JSON.stringify({
            scope: owner.cacheScope,
            organizationId: owner.organizationId,
            savedAt: now(),
            catalog,
            credentials: {
              schemaVersion: 1,
              organizationId: owner.organizationId,
              credentials: connections.map((entry) => entry.credential),
            },
          }),
        );
      } catch {
        /* Network synchronization remains authoritative when local encryption is unavailable. */
      }
    },
  };
}
