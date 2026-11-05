import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { getActiveAppSession, isAppSessionBoundaryPending, ownerScopedUserDataPath } from '../appSessionState.js';
import { getDbClient } from '../localDb/client/current.js';
import { parseBlobUrl } from '../cindy-media/blobStore.js';
import * as ledger from '../cindy-media/ledger.js';
import { atomicWriteFileSync, readAtomicFileSync } from '../utils/atomicWriteFile.js';
import type { BotGroupOutboxStoredEntry } from '../../shared/botGroupOutboxStorage.js';

const identifier = z.string().min(1).max(200);
const entrySchema = z.object({ input: z.object({ groupId: identifier, clientId: identifier, text: z.string().max(8000),
  mentions: z.object({ all: z.boolean(), allBots: z.boolean().optional(), botIds: z.array(z.string()) }) }).passthrough(),
  createdAt: z.number().finite(), status: z.enum(['sending', 'sent', 'failed']),
  draft: z.string(), signature: z.string(), attachmentScope: z.string(), after: z.number().finite(),
  tracked: z.array(z.unknown()), attachments: z.array(z.unknown()),
  files: z.array(z.object({ url: z.string().optional(), annotationSourceUrl: z.string().optional() }).passthrough()).max(32),
  prepared: z.array(z.object({ url: z.string().optional(), annotationSourceUrl: z.string().optional() }).passthrough()).max(32).optional(),
}).passthrough();
const requestSchema = z.intersection(z.object({ owner: z.object({ dataOwnerId: identifier, generation: z.number().int() }) }),
  z.discriminatedUnion('action', [z.object({ action: z.literal('list') }), z.object({ action: z.literal('put'), entry: entrySchema }),
    z.object({ action: z.literal('remove'), groupId: identifier, clientId: identifier })]));
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
let chain = Promise.resolve<unknown>(undefined);

/** Serialized per-record writes preserve other windows' messages and fence account changes. */
export function accessBotGroupOutbox(input: unknown): Promise<BotGroupOutboxStoredEntry[]> {
  const request = requestSchema.parse(input);
  const operation = async () => {
    const current = () => !isAppSessionBoundaryPending() && getActiveAppSession().dataOwnerId === request.owner.dataOwnerId
      && getActiveAppSession().generation === request.owner.generation;
    const check = () => { if (!current()) throw new Error('OUTBOX_OWNER_CHANGED'); };
    check();
    const root = ownerScopedUserDataPath('bot-group-outbox');
    const file = (groupId: string, clientId: string) => path.join(root, `${hash(JSON.stringify([groupId, clientId]))}.json`);
    const read = (filename: string) => {
      const raw = readAtomicFileSync(filename);
      if (!raw) return null;
      if (Buffer.byteLength(raw) > 8 * 1024 * 1024) throw new Error('OUTBOX_TOO_LARGE');
      const parsed = JSON.parse(raw);
      return parsed === null ? null : entrySchema.parse(parsed);
    };
    if (request.action === 'list') {
      let names: string[];
      try { names = readdirSync(root); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
      const files = new Set(names.filter(name => /^[a-f0-9]{64}\.json(?:\.bak)?$/.test(name)).map(name => name.replace(/\.bak$/, '')));
      return [...files].flatMap(name => { const value = read(path.join(root, name)); return value ? [value] : []; }).sort((a, b) => a.createdAt - b.createdAt);
    }
    const identity = request.action === 'put' ? request.entry.input : request;
    const filename = file(identity.groupId, identity.clientId);
    const refId = `outbox:${hash(JSON.stringify([identity.groupId, identity.clientId]))}`;
    const db = getDbClient().drizzle;
    if (request.action === 'remove') {
      // Tombstone before reference release; a .bak recovery must never resend it.
      mkdirSync(root, { recursive: true, mode: 0o700 });
      atomicWriteFileSync(filename, 'null');
      await ledger.removeRefs({ refKind: 'bot-group-attachment', refId }, db); check();
      rmSync(`${filename}.bak`, { force: true }); rmSync(filename, { force: true });
      return [];
    }
    const raw = JSON.stringify(request.entry);
    if (Buffer.byteLength(raw) > 8 * 1024 * 1024) throw new Error('OUTBOX_TOO_LARGE');
    const added: string[] = [];
    try {
      const urls = [...request.entry.files, ...(request.entry.prepared ?? [])].flatMap(item => [item.url, item.annotationSourceUrl]);
      for (const url of new Set(urls)) {
        const blob = url && parseBlobUrl(url);
        if (!blob) continue;
        check();
        if (!await ledger.hasRef({ hash: blob.hash, refKind: 'bot-group-attachment', refId }, db)) {
          await ledger.pinBlob(blob.hash, db); check();
          added.push(await ledger.addRef({ hash: blob.hash, refKind: 'bot-group-attachment', refId, originKind: 'user' }, db));
        }
      }
      check(); mkdirSync(root, { recursive: true, mode: 0o700 }); atomicWriteFileSync(filename, raw);
    } catch (error) {
      await Promise.all(added.map(id => ledger.removeRefById(id, db).catch(() => undefined)));
      throw error;
    }
    return [];
  };
  const pending = chain.then(operation);
  chain = pending.catch(() => undefined);
  return pending;
}
