/**
 * Owner-scoped path derivation shared by the Desktop main process and cindy-host.
 *
 * `dataOwnerStorageKey` is the on-disk identity of an account's private state;
 * changing it silently orphans every owner-scoped file, so both processes must
 * derive it from this module. No Electron imports.
 */

import crypto from 'node:crypto';
import path from 'node:path';

export function dataOwnerStorageKey(ownerId: string): string {
  return crypto.createHash('sha256').update(ownerId).digest('hex').slice(0, 20);
}

/** `<userData>/owners/<key>/<parts...>` for an explicit owner (no ambient session). */
export function ownerScopedPath(userDataDir: string, ownerId: string, ...parts: string[]): string {
  return path.join(userDataDir, 'owners', dataOwnerStorageKey(ownerId), ...parts);
}
