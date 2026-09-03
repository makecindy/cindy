import type { StoredInstall, StoredManifest } from './types.js';

/**
 * Registry records written by released clients predate catalogScope and all
 * point at the historical XD catalog. The added field is optional to older
 * clients, so persisting it is an append-only, downgrade-safe migration.
 */
export function migrateStoredManifest(manifest: StoredManifest): {
  manifest: StoredManifest;
  changed: boolean;
} {
  let changed = false;
  const installs: Record<string, StoredInstall> = {};
  const shouldBackfillCatalogScope = manifest.catalogScopeMigrated !== true;

  for (const [installPath, rawEntry] of Object.entries(manifest.installs ?? {})) {
    const entry = { ...rawEntry } as StoredInstall & { isMine?: unknown };
    if (typeof entry.authorId !== 'string') {
      entry.authorId = '';
      changed = true;
    }
    if ('isMine' in entry) {
      delete entry.isMine;
      changed = true;
    }
    if (shouldBackfillCatalogScope && !entry.catalogScope) {
      entry.catalogScope = 'team';
      changed = true;
    }
    installs[installPath] = entry;
  }

  if (shouldBackfillCatalogScope) changed = true;

  return changed
    ? { manifest: { ...manifest, catalogScopeMigrated: true, installs }, changed: true }
    : { manifest, changed: false };
}
