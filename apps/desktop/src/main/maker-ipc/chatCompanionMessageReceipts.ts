/** Durable send barriers contain hashes and receipts, never private message text. */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ownerScopedUserDataPath } from '../appSessionState.js';
import { atomicWriteFileSync, readAtomicFileSync } from '../utils/atomicWriteFile.js';

const record = z.object({
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  messageId: z.string().min(1).max(160).optional(),
  rejected: z.literal(true).optional(),
}).strict();
export type CompanionSendReceipt = z.infer<typeof record>;
export interface CompanionReceiptStore {
  read(key: string): CompanionSendReceipt | null;
  reserve(key: string, fingerprint: string): boolean;
  confirm(key: string, receipt: CompanionSendReceipt): void;
}
export const companionMessageHash = (value: string) => createHash('sha256').update(value).digest('hex');

export function companionMessageReceipts(endpoint: string, ownerActorId: string, current: () => boolean): CompanionReceiptStore {
  return companionMessageReceiptFiles(ownerScopedUserDataPath('chat-companion-message-receipts',
    companionMessageHash(JSON.stringify([endpoint, ownerActorId]))), current);
}

/** Exclusive reservation survives process death; an incomplete file blocks, never means absent. */
export function companionMessageReceiptFiles(root: string, current: () => boolean): CompanionReceiptStore {
  const file = (key: string) => path.join(root, `${z.string().regex(/^[a-f0-9]{64}$/).parse(key)}.json`);
  const check = () => { if (!current()) throw new Error('OWNER_CHANGED'); };
  return {
    read(key) {
      check();
      const value = readAtomicFileSync(file(key));
      return value === null ? null : record.parse(JSON.parse(value));
    },
    reserve(key, fingerprint) {
      check();
      mkdirSync(root, { recursive: true, mode: 0o700 });
      try {
        writeFileSync(file(key), JSON.stringify(record.parse({ fingerprint })), { flag: 'wx', mode: 0o600 });
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
        throw error;
      }
    },
    confirm(key, receipt) {
      check();
      atomicWriteFileSync(file(key), JSON.stringify(record.parse(receipt)));
    },
  };
}
