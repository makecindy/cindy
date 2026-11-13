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
  const raw = JSON.stringify(request.action === 'remove' ? null : request.value);
  if (!raw || Buffer.byteLength(raw) > MAX_BYTES) throw new Error('CACHE_TOO_LARGE');
  mkdirSync(root, { recursive: true, mode: 0o700 }); atomicWriteFileSync(file, raw);
  rmSync(`${file}.bak`, { force: true });
  if (request.action === 'remove') rmSync(file, { force: true });
  return null;
}
