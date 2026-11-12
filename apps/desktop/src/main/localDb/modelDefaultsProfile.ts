import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BRAND_IDENTITY } from '@cindy/maker-shared/brand-identity';

import { readBoundedFileNoFollowSync } from '../utils/readBoundedFile.js';
import { readModelVisibilityAdoption } from './modelVisibilityAdoption.js';

/** The canonical local profile path, shared by its creator and the early preference IPC. */
export function ownerDatabasePath(userDataDir: string, ownerId: string): string {
  return path.join(userDataDir, `${BRAND_IDENTITY.dbFilePrefix}-${ownerId}.db`);
}

export type ModelDefaultsProfileOrigin = 'new' | 'existing' | 'pending' | 'adopted-local';

function markerPath(dbFilePath: string): string {
  return `${dbFilePath}.model-defaults-origin.v1.json`;
}

/** Missing model preferences cannot prove a fresh profile. Only its creator grants eligibility. */
export function readModelDefaultsProfileOrigin(dbFilePath: string): ModelDefaultsProfileOrigin {
  const adoption = readModelVisibilityAdoption(dbFilePath);
  if (adoption === 'adopted') return 'adopted-local';
  if (adoption === 'pending') return 'pending';
  try {
    const bytes = readBoundedFileNoFollowSync(markerPath(dbFilePath), 1_024);
    if (!bytes) return 'existing';
    const marker = JSON.parse(bytes.toString('utf-8'));
    return marker?.version === 1 && marker.origin === 'new' ? 'new' : 'existing';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return 'existing';
  }
  try {
    // A database, WAL or backup from any earlier version means an existing profile,
    // even when no model-specific preference key has ever been written.
    const filename = path.basename(dbFilePath);
    return fs.readdirSync(path.dirname(dbFilePath)).some((entry) => entry === filename
      || ['-wal', '-shm', '-journal', '.slimming-backup'].some((suffix) => entry === `${filename}${suffix}`)
      || entry.startsWith(`${filename}.bak.`) || entry.startsWith(`${filename}.corrupt`)) ? 'existing' : 'pending';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'pending' : 'existing';
  }
}

/**
 * Called under the DB startup writer lease, after legacy adoption and before creating the DB.
 * Persist before the first open so a crash before the catalog arrives retains new-profile status.
 * Never grant it to an already-existing/migrated DB, nor overwrite a damaged/unknown marker.
 */
export function prepareModelDefaultsProfile(dbFilePath: string): void {
  if (readModelDefaultsProfileOrigin(dbFilePath) !== 'pending') return;
  const target = markerPath(dbFilePath);
  const temporary = `${target}.init-${process.pid}-${randomUUID()}`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try {
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, origin: 'new' }),
      { encoding: 'utf-8', flag: 'wx', mode: 0o600, flush: true });
    try {
      fs.linkSync(temporary, target);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!['EXDEV', 'EPERM', 'EOPNOTSUPP', 'ENOTSUP', 'ENOSYS'].includes(code ?? '')) throw error;
      // The caller holds this database's exclusive startup writer lease across
      // classification, publication and DB creation. Recheck the destination
      // under that same lease, then atomically publish the fully flushed file.
      // Direct COPYFILE_EXCL into target could expose a partial JSON marker.
      if (fs.existsSync(target)) return;
      fs.renameSync(temporary, target);
    }
    let directory: number | undefined;
    try {
      directory = fs.openSync(path.dirname(target), 'r');
      fs.fsyncSync(directory);
    } catch (error) {
      if (process.platform !== 'win32') throw error;
    } finally {
      if (directory !== undefined) fs.closeSync(directory);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* Unpublished temporary files are not authority. */ }
  }
}
