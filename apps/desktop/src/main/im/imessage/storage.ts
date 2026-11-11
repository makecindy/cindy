import fs from 'node:fs';
import path from 'node:path';
import type { BlueBubblesState, BlueBubblesStateStorage, BlueBubblesReceiptUpdate } from '@cindy/im';
import { applyBlueBubblesReceiptUpdate } from '@cindy/im';
import { atomicWriteFileSync, readAtomicFileSync } from '../../utils/atomicWriteFile';
import { ownerScopedImUserDataPath } from '../ownerScopedStorage';

/** Metadata journal: one durable small record per change, periodic atomic checkpoints. */
export function blueBubblesStateStorage(connectionId: string): BlueBubblesStateStorage {
  if (!/^[a-f0-9]{12}$/.test(connectionId)) throw new Error('Invalid iMessage connection');
  // Capture the owner now; late completion after logout must never write to the new owner.
  const file = ownerScopedImUserDataPath('imessage', `${connectionId}.json`);
  const journal = `${file}.journal`;
  let state: BlueBubblesState | null = null;
  let entries = 0;
  let appendBlocked = false;
  const checkpoint = () => {
    if (!state) return;
    atomicWriteFileSync(file, JSON.stringify(state));
    // Windows FlushFileBuffers requires a writable handle; r+ preserves the checkpoint bytes.
    const fd = fs.openSync(file, 'r+');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    // Flush the checkpoint name before replacing the journal (directory fsync is POSIX-only).
    if (process.platform !== 'win32') {
      const directory = fs.openSync(path.dirname(file), 'r');
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    }
    // Replaying the old journal after a crash here is safe: updates are assignments, not increments.
    atomicWriteFileSync(journal, '');
    entries = 0;
    appendBlocked = false;
  };
  return {
    read: () => {
      entries = 0;
      const content = readAtomicFileSync(file);
      state = content === null ? null : JSON.parse(content) as BlueBubblesState;
      const pending = readAtomicFileSync(journal) ?? '';
      if (!state && pending) throw new Error('BLUEBUBBLES_RECEIPT_CHECKPOINT_MISSING');
      if (state) {
        const end = pending.lastIndexOf('\n');
        for (const line of pending.slice(0, end + 1).split('\n').filter(Boolean)) {
          applyBlueBubblesReceiptUpdate(state, JSON.parse(line) as BlueBubblesReceiptUpdate);
          entries += 1;
        }
        // A partial last record was never acknowledged; preserve all earlier durable records.
        if (appendBlocked || end + 1 !== pending.length) checkpoint();
      }
      return state && structuredClone(state);
    },
    write: next => { state = structuredClone(next); checkpoint(); },
    update: update => {
      if (!state) throw new Error('BLUEBUBBLES_RECEIPTS_NOT_LOADED');
      if (appendBlocked) throw new Error('BLUEBUBBLES_RECEIPT_JOURNAL_NEEDS_REPAIR');
      const fd = fs.openSync(journal, 'a', 0o600);
      try {
        const length = fs.fstatSync(fd).size;
        try {
          fs.writeFileSync(fd, `${JSON.stringify(update)}\n`);
          fs.fsyncSync(fd);
        } catch (error) {
          // A failed write can leave bytes behind. Never join the next record
          // onto that unacknowledged prefix; flush the rollback before reuse.
          try {
            // Windows append handles lack FILE_WRITE_DATA for truncation.
            const rollback = fs.openSync(journal, 'r+');
            try {
              fs.ftruncateSync(rollback, length);
              fs.fsyncSync(rollback);
            } finally { fs.closeSync(rollback); }
          } catch {
            // Explicit reload/checkpoint must repair the journal before reuse.
            appendBlocked = true;
          }
          throw error;
        }
      } finally { fs.closeSync(fd); }
      applyBlueBubblesReceiptUpdate(state, update);
      entries += 1;
      if (entries >= 1000) checkpoint();
    },
  };
}
