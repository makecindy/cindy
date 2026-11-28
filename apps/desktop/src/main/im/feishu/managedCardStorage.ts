import { createHash } from 'node:crypto';
import type { IMHost } from '@cindy/im';
import { atomicWriteFileSync, readAtomicFileSync } from '../../utils/atomicWriteFile';
import { ownerScopedImUserDataPath } from '../ownerScopedStorage';
import { captureImAccountGeneration } from '../accountBoundary';

function fileFor(connectionKey: string): string {
  if (captureImAccountGeneration() === null) throw new Error('MANAGED_CARD_ACCOUNT_UNAVAILABLE');
  const key = createHash('sha256').update(connectionKey).digest('hex');
  return ownerScopedImUserDataPath('feishu-managed-cards', key + '.json');
}

/** Per data owner and connection. Metadata only; no rendered cards, form values or tokens. */
export const managedCardStorage: NonNullable<IMHost['managedCards']> = {
  read: (key) => readAtomicFileSync(fileFor(key)),
  write: (key, contents) => atomicWriteFileSync(fileFor(key), contents),
  // Invalidate atomically on unbind. Keep an empty file so an old backup cannot revive cards.
  clear: (key) => {
    if (captureImAccountGeneration() === null) return;
    atomicWriteFileSync(fileFor(key), 'null');
  },
};
