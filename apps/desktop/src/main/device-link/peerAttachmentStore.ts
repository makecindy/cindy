import { constants } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  createFileReadQueue,
  buildPeerAttachmentRef,
  parsePeerAttachmentRef,
  type PeerAttachment,
} from '@cindy/device-link';
import { ownerScopedUserDataPath } from '../appSessionState';
import { captureDataOwnerBroadcastScope, isDataOwnerBroadcastScopeCurrent } from './broadcast-tap';
import { getDeviceLinkInvokeContext } from './invoke-context';

// Durable inbox, not media ownership. Normalization ingests into the existing media/file stores.
// Keep completed uploads retryable across host restarts, like the OSS staging bucket.
const lifetime = 7 * 24 * 60 * 60_000;
const queue = createFileReadQueue();
type Entry = PeerAttachment & { peer: string; createdAt: number; complete: boolean };
const expired = (entry: Entry, cancelling = false) =>
  Date.now() - entry.createdAt > (entry.complete || cancelling ? lifetime : 60 * 60_000);
const validTicket = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
async function digest(file: string) {
  const hash = createHash('sha256');
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    for await (const bytes of handle.createReadStream()) hash.update(bytes);
  } finally {
    await handle.close().catch(() => {});
  }
  return hash.digest('hex');
}
export async function handlePeerAttachment(peer: string, r: Record<string, unknown>) {
  if (r.op !== 'begin' && !validTicket(r.ticket)) throw new Error('INVALID_PEER_ATTACHMENT');
  const root = ownerScopedUserDataPath('peer-attachment-inbox');
  const owner = captureDataOwnerBroadcastScope();
  const check = () => {
    if (!isDataOwnerBroadcastScopeCurrent(owner)) throw new Error('FILE_PEER_CANCELLED');
  };
  // Admission is serialized; ticket operations share only their own ticket's queue.
  return queue(`${root}:${r.op === 'begin' ? 'admission' : r.ticket}`, async () => {
    check();
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    if (r.op === 'begin') {
      const ticket = randomUUID();
      const parsed = parsePeerAttachmentRef(
        buildPeerAttachmentRef({ ...r, ticket } as unknown as PeerAttachment),
      );
      if (!parsed) throw new Error('INVALID_PEER_ATTACHMENT');
      let reserved = 0,
        count = 0;
      for (const name of await fs.readdir(root)) {
        if (!name.endsWith('.json') || !validTicket(name.slice(0, -5))) continue;
        // Reuse the ticket's operation queue; re-read after any in-flight write/finish.
        await queue(`${root}:${name.slice(0, -5)}`, async () => {
          check();
          let entry: Entry;
          try {
            entry = JSON.parse(await fs.readFile(path.join(root, name), 'utf8')) as Entry;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
            throw error;
          }
          if (expired(entry)) {
            await fs.rm(path.join(root, name.slice(0, -5)), { force: true });
            await fs.rm(path.join(root, name), { force: true });
          } else {
            reserved += entry.size;
            count++;
          }
        });
      }
      const space = await fs.statfs(root);
      if (
        count >= 128 ||
        reserved + parsed.size > 4 * 1024 ** 3 ||
        space.bavail * space.bsize < parsed.size * 2 + 256 * 1024 ** 2
      )
        throw new Error('FILE_PEER_STORAGE');
      check();
      await fs.writeFile(path.join(root, ticket), '', { flag: 'wx', mode: 0o600 });
      const entry: Entry = { ...parsed, peer, createdAt: Date.now(), complete: false };
      await fs.writeFile(path.join(root, `${ticket}.json`), JSON.stringify(entry), {
        flag: 'wx',
        mode: 0o600,
      });
      check();
      return { ticket };
    }
    if (!validTicket(r.ticket)) throw new Error('INVALID_PEER_ATTACHMENT');
    const file = path.join(root, r.ticket),
      manifest = file + '.json';
    const entry = JSON.parse(await fs.readFile(manifest, 'utf8')) as Entry;
    if (entry.peer !== peer || expired(entry, r.op === 'cancel'))
      throw new Error('FILE_PEER_DENIED');
    check();
    if (r.op === 'cancel') {
      await fs.rm(file, { force: true });
      await fs.rm(manifest, { force: true });
      return { ok: true };
    }
    if (r.op === 'write') {
      if (
        entry.complete ||
        !Number.isSafeInteger(r.offset) ||
        Number(r.offset) < 0 ||
        typeof r.data !== 'string' ||
        r.data.length > 1400000
      )
        throw new Error('FILE_PEER_BLOCK');
      const bytes = Buffer.from(r.data, 'base64');
      if (
        !bytes.length ||
        bytes.length > 1024 * 1024 ||
        bytes.toString('base64') !== r.data ||
        Number(r.offset) + bytes.length > entry.size
      )
        throw new Error('FILE_PEER_BLOCK');
      const handle = await fs.open(file, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
      try {
        if ((await handle.stat()).size !== r.offset) throw new Error('FILE_PEER_BLOCK');
        check();
        if (
          (await handle.write(bytes, 0, bytes.length, Number(r.offset))).bytesWritten !==
          bytes.length
        )
          throw new Error('FILE_PEER_BLOCK');
      } finally {
        await handle.close();
      }
      entry.createdAt = Date.now();
      await fs.writeFile(manifest + '.tmp', JSON.stringify(entry), { mode: 0o600 });
      await fs.rename(manifest + '.tmp', manifest);
      check();
      return { ok: true };
    }
    if (r.op === 'finish') {
      if ((await fs.stat(file)).size !== entry.size || (await digest(file)) !== entry.sha256)
        throw new Error('FILE_PEER_INTEGRITY');
      check();
      entry.complete = true;
      entry.createdAt = Date.now();
      await fs.writeFile(manifest + '.tmp', JSON.stringify(entry), { mode: 0o600 });
      await fs.rename(manifest + '.tmp', manifest);
      check();
      return { ok: true };
    }
    throw new Error('INVALID_PEER_ATTACHMENT');
  });
}

async function copyPeerAttachmentBytes(ref: PeerAttachment, destination: string) {
  const owner = captureDataOwnerBroadcastScope();
  const root = ownerScopedUserDataPath('peer-attachment-inbox');
  const file = path.join(root, ref.ticket);
  const peer = getDeviceLinkInvokeContext()?.controllerDeviceId;
  if (!peer || !validTicket(ref.ticket)) throw new Error('FILE_PEER_DENIED');
  const entry = JSON.parse(await fs.readFile(file + '.json', 'utf8')) as Entry;
  if (
    !entry.complete ||
    entry.peer !== peer ||
    entry.sha256 !== ref.sha256 ||
    entry.size !== ref.size ||
    expired(entry)
  )
    throw new Error('FILE_PEER_DENIED');
  if (!isDataOwnerBroadcastScopeCurrent(owner)) throw new Error('FILE_PEER_CANCELLED');
  await fs.copyFile(file, destination);
  const valid =
    (await fs.stat(destination)).size === ref.size && (await digest(destination)) === ref.sha256;
  if (!isDataOwnerBroadcastScopeCurrent(owner) || !valid) {
    await fs.rm(destination, { force: true });
    throw new Error('FILE_PEER_INTEGRITY');
  }
}

export async function copyPeerAttachment(ref: PeerAttachment, destination: string) {
  try {
    await copyPeerAttachmentBytes(ref, destination);
  } catch (error) {
    await fs.rm(destination, { force: true }).catch(() => {});
    // Filesystem errors include owner-private paths; never propagate them to remote UI.
    if (error instanceof Error && /^FILE_PEER_(DENIED|INTEGRITY|CANCELLED)$/.test(error.message))
      throw error;
    throw new Error('FILE_PEER_ATTACHMENT_UNAVAILABLE');
  }
}
