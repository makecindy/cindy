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
  const legacyManifest = manifest as StoredManifest & { catalogScopeMigrated?: unknown };
  let changed = 'catalogScopeMigrated' in legacyManifest;
  const baseManifest = { ...legacyManifest };
  delete baseManifest.catalogScopeMigrated;
  const installs: Record<string, StoredInstall> = {};

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
    if (entry.catalogScopeMigrated !== true) {
      if (!entry.catalogScope) entry.catalogScope = 'team';
      entry.catalogScopeMigrated = true;
      changed = true;
    }
    installs[installPath] = entry;
  }

  return changed
    ? { manifest: { ...baseManifest, installs }, changed: true }
    : { manifest, changed: false };
}
