import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { WebContents } from 'electron';
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
interface RendererOwner { live: boolean }
const rendererOwners = new WeakMap<WebContents, RendererOwner>();
const entryOwners = new Map<string, RendererOwner>();
let ownershipAccount: string | null = null;

/** Main-derived incarnation, never a renderer-supplied ID or a persisted lease. */
function rendererOwner(sender: WebContents): RendererOwner {
  const existing = rendererOwners.get(sender);
  if (existing) return existing;
  const owner = { live: true };
  const release = () => {
    owner.live = false;
    rendererOwners.delete(sender);
    for (const [key, held] of entryOwners) if (held === owner) entryOwners.delete(key);
    sender.removeListener('destroyed', release);
    sender.removeListener('render-process-gone', release);
    sender.removeListener('did-navigate', release);
  };
  rendererOwners.set(sender, owner);
  sender.once('destroyed', release);
  sender.once('render-process-gone', release);
  sender.once('did-navigate', release);
  return owner;
}

/** Serialized per-record writes preserve other windows' messages and fence account changes. */
export function accessBotGroupOutbox(input: unknown, sender?: WebContents): Promise<BotGroupOutboxStoredEntry[]> {
  const request = requestSchema.parse(input);
  const renderer = sender ? rendererOwner(sender) : undefined;
  const operation = async () => {
    const current = () => !isAppSessionBoundaryPending() && getActiveAppSession().dataOwnerId === request.owner.dataOwnerId
      && getActiveAppSession().generation === request.owner.generation;
    const check = () => { if (!current()) throw new Error('OUTBOX_OWNER_CHANGED'); };
    check();
    // A different login drops all previous renderer projections; same-account
    // generation repair must instead preserve the live windows' ownership.
    if (ownershipAccount !== request.owner.dataOwnerId) {
      entryOwners.clear();
      ownershipAccount = request.owner.dataOwnerId;
    }
    const root = ownerScopedUserDataPath('bot-group-outbox');
    const file = (groupId: string, clientId: string) => path.join(root, `${hash(JSON.stringify([groupId, clientId]))}.json`);
    const ownershipKey = (groupId: string, clientId: string) => JSON.stringify([request.owner.dataOwnerId, groupId, clientId]);
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
      return [...files].flatMap(name => {
        const value = read(path.join(root, name));
        if (!value) return [];
        const key = ownershipKey(value.input.groupId, value.input.clientId);
        const held = entryOwners.get(key);
        if (renderer && held?.live && held !== renderer) return [];
        if (renderer) entryOwners.set(key, renderer);
        return [value];
      }).sort((a, b) => a.createdAt - b.createdAt);
    }
    const identity = request.action === 'put' ? request.entry.input : request;
    const filename = file(identity.groupId, identity.clientId);
    const key = ownershipKey(identity.groupId, identity.clientId);
    const held = entryOwners.get(key);
    if (renderer && held?.live && held !== renderer) throw new Error('OUTBOX_ENTRY_OWNED');
    const refId = `outbox:${hash(JSON.stringify([identity.groupId, identity.clientId]))}`;
    const db = getDbClient().drizzle;
    if (request.action === 'remove') {
      // Tombstone before reference release; a .bak recovery must never resend it.
      mkdirSync(root, { recursive: true, mode: 0o700 });
      atomicWriteFileSync(filename, 'null');
      await ledger.removeRefs({ refKind: 'bot-group-attachment', refId }, db); check();
      rmSync(`${filename}.bak`, { force: true }); rmSync(filename, { force: true });
      entryOwners.delete(key);
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
      // An already accepted write finishes even if its renderer died while
      // awaiting media pinning; the resulting row is then immediately orphaned.
      if (renderer?.live) entryOwners.set(key, renderer);
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
