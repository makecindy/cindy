import { createHash } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { getActiveAppSession, isAppSessionBoundaryPending, ownerScopedUserDataPath } from '../appSessionState.js';
import { getClientEndpoint } from '../clientEndpointsService.js';
import { atomicWriteFileSync, readAtomicFileSync } from '../utils/atomicWriteFile.js';

const schema = z.intersection(z.object({ owner: z.object({ dataOwnerId: z.string().min(1), generation: z.number().int() }),
  key: z.string().max(250).refine(key => key === 'groups' || key === 'cloud-homes' || key.startsWith('companion:')) }),
  z.discriminatedUnion('action', [z.object({ action: z.literal('read') }),
    z.object({ action: z.literal('write'), value: z.unknown() }), z.object({ action: z.literal('remove') })]));
const MAX_BYTES = 8 * 1024 * 1024;
/** Bounded, owner/endpoint-scoped snapshots behind the trusted local renderer boundary. */
export function accessChatDisplayCache(input: unknown): unknown {
  const request = schema.parse(input);
  const active = getActiveAppSession();
  if (isAppSessionBoundaryPending() || active.dataOwnerId !== request.owner.dataOwnerId || active.generation !== request.owner.generation)
    throw new Error('OWNER_CHANGED');
  const digest = createHash('sha256').update(JSON.stringify([getClientEndpoint('chatApiBaseUrl'), request.key])).digest('hex');
  const root = ownerScopedUserDataPath('chat-display');
  const file = path.join(root, `${digest}.json`);
  if (request.action === 'read') {
    const raw = readAtomicFileSync(file);
    return raw && Buffer.byteLength(raw) <= MAX_BYTES ? JSON.parse(raw) : null;
  }
  let value = request.action === 'remove' ? null : request.value;
  if (request.action === 'write' && request.key === 'cloud-homes' && value && typeof value === 'object'
    && !Array.isArray(value)) {
    // Multiple renderer windows share this snapshot. Preserve tombstones written by a
    // newer window when an older window writes its stale full roster later.
    const cachedRaw = readAtomicFileSync(file);
    if (cachedRaw && Buffer.byteLength(cachedRaw) <= MAX_BYTES) {
      try {
        const cached = JSON.parse(cachedRaw) as { retiredBotIds?: unknown } | null;
        const incoming = value as { actors?: unknown; retiredBotIds?: unknown };
        const activeIds = new Set(Array.isArray(incoming.actors)
          ? incoming.actors.flatMap(actor => actor && typeof actor === 'object' && typeof (actor as { externalId?: unknown }).externalId === 'string'
            ? [(actor as { externalId: string }).externalId] : [])
          : []);
        const retired = new Set<string>([
          ...(cached && Array.isArray(cached.retiredBotIds) ? cached.retiredBotIds.filter((id): id is string => typeof id === 'string') : []),
          ...(Array.isArray(incoming.retiredBotIds) ? incoming.retiredBotIds.filter((id): id is string => typeof id === 'string') : []),
        ]);
        for (const id of activeIds) retired.delete(id);
        value = { ...incoming, retiredBotIds: [...retired] };
      } catch {
        // An invalid or partially written old cache must not block the current snapshot.
      }
    }
  }
  const raw = JSON.stringify(value);
  if (!raw || Buffer.byteLength(raw) > MAX_BYTES) throw new Error('CACHE_TOO_LARGE');
  mkdirSync(root, { recursive: true, mode: 0o700 }); atomicWriteFileSync(file, raw);
  rmSync(`${file}.bak`, { force: true });
  if (request.action === 'remove') rmSync(file, { force: true });
  return null;
}
