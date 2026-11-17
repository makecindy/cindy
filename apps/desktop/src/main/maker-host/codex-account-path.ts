import { createHash } from 'node:crypto';
import path from 'node:path';

/** Stable pre-pool layout. Shared by the native account adapter and upgrade metadata. */
export function legacyCodexAccountHome(userDataDir: string, ownerId: string | null, providerId: string): string {
  if (!/^[a-z0-9_-]{1,40}$/.test(providerId)) throw new Error('Invalid Codex provider id');
  if (!ownerId) throw new Error('An active owner is required');
  const owner = createHash('sha256').update(ownerId).digest('hex');
  return path.join(userDataDir, 'codex-accounts', owner, providerId);
}
