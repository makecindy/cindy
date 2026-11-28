import fs from 'node:fs/promises';
import path from 'node:path';

import { isMissing } from '../../../desktop/src/main/concurrentInstanceScan.js';
import { classifyGhostDirEntry } from '../../../desktop/src/main/cindy-brain/ghostContentTree.js';
import { GhostInstallReceiptStore } from '../../../desktop/src/main/cindy-brain/ghostInstallReceipt.js';
import { readInstalledGhostManifestSnapshotAsync } from '../../../desktop/src/main/installedGhostManifest.js';
import { listLegacyOwnerProjectionRoots } from '../../../desktop/src/main/ownerProjectionRoots.js';
import { GHOST_MANIFEST_FILE, GHOST_MANIFEST_MAX_BYTES, isValidGhostId, type InstalledGhost } from '../../../desktop/src/shared/ghost.js';
import { installedGhostPhysicalRelId, installedGhostStoragePart } from '../../../desktop/src/shared/pluginIdentity.js';

export interface LegacyPluginApprovals {
  count: number;
  installIds: string[];
}

export function summarizeLegacyPluginApprovals(installed: readonly InstalledGhost[]): LegacyPluginApprovals {
  const installIds = installed
    .filter(ghost => ghost.approval.state === 'legacy-unapproved' && isValidGhostId(installedGhostPhysicalRelId(ghost)))
    .map(installedGhostStoragePart).sort();
  return { count: installIds.length, installIds };
}

async function entryKind(file: string) {
  try {
    return await classifyGhostDirEntry(file);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function directoryExists(dir: string): Promise<boolean> {
  const kind = await entryKind(dir);
  if (kind !== null && kind !== 'directory') throw new Error(`Not a regular profile directory: ${path.basename(dir)}`);
  return kind === 'directory';
}

/** Offline migration gate. Inspect every owner plus the two unclaimed content roots.
 * The desktop's one-time backfill applies to bare install directories, not `_ns` entries.
 * Read receipt facts without constructing GhostManager, whose listing can repair its index.
 */
async function checkLegacyPluginMigration(profile: string) {
  if (!path.isAbsolute(profile)) throw new Error('Pass the absolute path of the desktop profile');
  const root = await fs.realpath(profile);
  if (!await directoryExists(root)) throw new Error('Desktop profile not found');
  await directoryExists(path.join(root, 'owners'));

  const installIds: string[] = [];
  const contentRoots = listLegacyOwnerProjectionRoots(root).filter(dir => path.basename(dir) !== 'ghost-install-state');
  for (const dir of contentRoots) {
    if (!await directoryExists(dir)) continue;
    const stateRoot = path.join(path.dirname(dir), 'ghost-install-state');
    await directoryExists(stateRoot);
    const receipts = new GhostInstallReceiptStore(() => stateRoot);
    for (const id of await fs.readdir(dir)) {
      if (!isValidGhostId(id)) continue;
      const install = path.join(dir, id);
      const kind = await entryKind(install);
      if (kind === 'file') continue;
      if (kind !== 'directory') throw new Error(`Cannot verify plugin directory: ${id}`);
      if (await entryKind(path.join(install, GHOST_MANIFEST_FILE)) === null) continue;
      const receipt = await receipts.readAsync(id);
      if (receipt.state === 'approved') continue;
      if (receipt.state === 'invalid') throw new Error(`Cannot verify plugin approval receipt: ${id}`);
      const manifest = await readInstalledGhostManifestSnapshotAsync(install, GHOST_MANIFEST_MAX_BYTES);
      if (!manifest.ok || manifest.snapshot.manifest.id !== id) throw new Error(`Cannot verify installed plugin: ${id}`);
      installIds.push(path.relative(root, install).split(path.sep).join('/'));
    }
  }

  return { allowed: installIds.length === 0, count: installIds.length, installIds: installIds.sort() };
}

export async function runLegacyPluginMigrationPreflight(args: readonly string[], output: Pick<Console, 'log' | 'error'> = console): Promise<number> {
  if (args.length !== 1) throw new Error('Usage: cindy-host migration-preflight <profile-directory>');
  const report = await checkLegacyPluginMigration(args[0]);
  output.log(JSON.stringify(report));
  if (report.allowed) return 0;
  output.error('Open this profile in Cindy Desktop v0.1.48 or later, then close Desktop and rerun the preflight.');
  return 1;
}
