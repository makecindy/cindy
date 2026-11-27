import fs from 'node:fs';
import path from 'node:path';

import { atomicWriteFileSync } from '../utils/atomicWriteFile.js';
import { readBoundedFileNoFollowSync } from '../utils/readBoundedFile.js';

const SUFFIX = '.model-visibility-adoption.v1.json';

function identity(file: string): string {
  const stat = fs.statSync(file, { bigint: true });
  return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
}

/**
 * Bind the local preference handoff to the actual published file, not the first-account
 * reservation. Before a hard link, the snapshot already has the final file identity.
 * The exclusive-copy path records its target after flushing, before marking it published.
 */
export function recordModelVisibilityAdoption(target: string, snapshot = target, providerKeyBatch?: string): void {
  const marker = `${target}${SUFFIX}`;
  atomicWriteFileSync(marker, JSON.stringify({ version: 1, identity: identity(snapshot), providerKeyBatch }));
  const fd = fs.openSync(marker, 'r+');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  let directory: number | undefined;
  try {
    directory = fs.openSync(path.dirname(marker), 'r');
    fs.fsyncSync(directory);
  } catch (error) {
    if (process.platform !== 'win32') throw error;
  } finally {
    if (directory !== undefined) fs.closeSync(directory);
  }
}

export function readModelVisibilityAdoption(target: string): 'adopted' | 'absent' | 'pending' {
  try {
    const bytes = readBoundedFileNoFollowSync(`${target}${SUFFIX}`, 1_024);
    if (!bytes) return 'pending';
    const marker = JSON.parse(bytes.toString('utf8'));
    if (marker?.version !== 1 || typeof marker.identity !== 'string') return 'pending';
    // A lost no-replace race or replaced cloud DB must never inherit local preferences.
    return marker.identity === identity(target) ? 'adopted' : 'absent';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return 'pending';
    // Read-only: do not race the writer's Windows atomic backup exchange.
    return fs.existsSync(`${target}${SUFFIX}.bak`) ? 'pending' : 'absent';
  }
}

// A losing hard-link race, replaced target, or older receipt grants no key access.
export function readPublishedProviderKeyBatch(target: string): string | null {
  try {
    const bytes = readBoundedFileNoFollowSync(target + SUFFIX, 1024);
    const marker = bytes && JSON.parse(bytes.toString('utf8'));
    if (marker?.version === 1 && typeof marker.providerKeyBatch === 'string' &&
        /^[0-9a-f-]{36}$/.test(marker.providerKeyBatch) && marker.identity === identity(target)) {
      return marker.providerKeyBatch;
    }
  } catch { /* Unreadable receipts cannot grant authority. */ }
  return null;
}
