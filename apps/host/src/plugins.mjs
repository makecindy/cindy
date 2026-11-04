/**
 * Installed plugin projection for the host.
 *
 * Reads the canonical owner namespace only. This machine still holds legacy
 * raw-owner-id namespaces that the Desktop migrates under an exclusive claim;
 * rather than guessing which root is authoritative, the host reports their
 * presence and leaves migration to the Desktop path that owns that decision.
 */

import fs from 'node:fs';
import path from 'node:path';

import { dataOwnerStorageKey, ownerScopedPath } from '../../desktop/src/main/dataOwnerPath.ts';

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * @param {string} userDataDir
 * @param {string} ownerId
 * @returns {{plugins: Array<{instanceKey: string, id: string, name: string | null, version: string | null, namespace: string | null, source: string | null, active: boolean}>, namespace: 'canonical', legacyNamespacePresent: boolean}}
 */
export function listInstalledPlugins(userDataDir, ownerId) {
  const ownerKey = dataOwnerStorageKey(ownerId);
  const stateFile = ownerScopedPath(userDataDir, ownerId, 'ghost-install-state', 'plugin-instances.v2.json');
  const state = readJson(stateFile);
  const instances = state && typeof state.instances === 'object' && state.instances !== null
    ? Object.values(state.instances)
    : [];

  const plugins = instances.map((instance) => {
    const manifest = readJson(ownerScopedPath(userDataDir, ownerId, instance.contentRelId ?? '', 'ghost.json'));
    return {
      instanceKey: String(instance.instanceKey ?? ''),
      id: String(instance.ghostId ?? instance.pluginId ?? ''),
      name: typeof manifest?.name === 'string' ? manifest.name : null,
      version: typeof manifest?.version === 'string' ? manifest.version : null,
      namespace: instance.namespace ?? null,
      source: instance.source ?? null,
      active: instance.active === true,
    };
  }).filter((plugin) => plugin.instanceKey !== '' && plugin.id !== '');

  return {
    plugins,
    namespace: 'canonical',
    legacyNamespacePresent: hasLegacyNamespace(userDataDir, ownerKey),
  };
}

/** Legacy owners/<raw-id> directories are evidence, not a read target. */
function hasLegacyNamespace(userDataDir, canonicalKey) {
  try {
    return fs.readdirSync(path.join(userDataDir, 'owners'), { withFileTypes: true })
      .some((entry) => entry.isDirectory() && entry.name !== canonicalKey);
  } catch {
    return false;
  }
}
