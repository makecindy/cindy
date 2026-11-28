// The owner-boundary projection roots, moved unchanged out of ownerNamespaceMigration.ts so the Node
// Host can load them (that file imports Electron). The desktop's account boundary (suspendAllGhosts)
// and `cindy-host login`'s owner transition revoke the Ghost Skill links of every root listed here.
import fsSync from 'node:fs';
import path from 'node:path';

import { isMissing } from './concurrentInstanceScan.js';

export function sharedLegacyGhostRootDirs(userDataDir: string): string[] {
  return [path.join(userDataDir, 'cindy-brain'), path.join(userDataDir, 'brain')];
}

const OWNER_STORAGE_KEY_RE = /^[a-f0-9]{20}$/;

/** All legacy/content and approval projection roots that must be revoked at an owner boundary. */
export function listLegacyOwnerProjectionRoots(userDataDir: string): string[] {
  const ownersRoot = path.join(userDataDir, 'owners');
  const roots = [
    ...sharedLegacyGhostRootDirs(userDataDir),
  ];
  let entries: fsSync.Dirent[];
  try {
    entries = fsSync.readdirSync(ownersRoot, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return roots;
    throw error;
  }
  for (const entry of entries) {
    if (!OWNER_STORAGE_KEY_RE.test(entry.name)) continue;
    const ownerRoot = path.join(ownersRoot, entry.name);
    let ownerStat: fsSync.Stats;
    try {
      // Dirent.d_type is not authoritative on network/special filesystems. A
      // missed owner directory would bypass the next account-boundary retry.
      ownerStat = fsSync.lstatSync(ownerRoot);
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    if (!ownerStat.isDirectory() || ownerStat.isSymbolicLink()) {
      throw new Error(`owner projection namespace is not a regular directory: ${ownerRoot}`);
    }
    roots.push(
      path.join(ownerRoot, 'brain'),
      path.join(ownerRoot, 'cindy-brain'),
      path.join(ownerRoot, 'ghost-install-state'),
    );
  }
  return roots;
}
