import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { atomicWriteFileSync, readAtomicFileSync } from '../../utils/atomicWriteFile';
import { ownerScopedImUserDataPath } from '../ownerScopedStorage';

interface DirectDelivery {
  text: string;
  createdAt: number;
  requestId: string;
}

export function directDeliveryDirectory(connection: string): string {
  if (!/^[a-f0-9]{12}$/.test(connection)) throw new Error('Invalid iMessage connection');
  return ownerScopedImUserDataPath('imessage', 'direct-deliveries', connection);
}

export function clearDirectDeliveries(directory: string): void {
  fs.rmSync(directory, { recursive: true, force: true });
}

/** One latest explicitly addressed document per account, companion, server and DM. */
export function directDeliveryFile(bot: string, connection: string, origin: string, chat: string): string {
  const key = createHash('sha256').update(JSON.stringify([bot, connection, origin, chat])).digest('hex');
  return path.join(directDeliveryDirectory(connection), key + '.json');
}

export function readDirectDelivery(file: string): DirectDelivery | null {
  const content = readAtomicFileSync(file);
  if (content === null) return null;
  const record = JSON.parse(content);
  if (typeof record?.text !== 'string' || !Number.isSafeInteger(record.createdAt) ||
      typeof record.requestId !== 'string' || !/^[0-9a-f-]{36}$/.test(record.requestId)) {
    throw new Error('Invalid direct delivery');
  }
  return record;
}

export function prepareDirectDelivery(file: string, text: string): DirectDelivery {
  const latest = readDirectDelivery(file);
  if (latest?.text === text) return latest;
  const record = { text, createdAt: Date.now(), requestId: randomUUID() };
  atomicWriteFileSync(file, JSON.stringify(record));
  return record;
}
