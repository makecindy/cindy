import { createHash } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { getActiveAppSession, isAppSessionBoundaryPending, ownerScopedUserDataPath } from '../appSessionState.js';
import { getClientEndpoint } from '../clientEndpointsService.js';
import { atomicWriteFileSync, readAtomicFileSync } from '../utils/atomicWriteFile.js';
import { throwIpcError } from '../utils/ipcValidate.js';

const schema = z.intersection(z.object({ owner: z.object({ dataOwnerId: z.string().min(1), generation: z.number().int() }),
  key: z.string().max(250).refine(key => key === 'groups' || key === 'cloud-homes' || key.startsWith('companion:')) }),
  z.discriminatedUnion('action', [z.object({ action: z.literal('read') }),
    z.object({ action: z.literal('write'), value: z.unknown() }), z.object({ action: z.literal('remove') })]));
const MAX_BYTES = 8 * 1024 * 1024;
// All renderer windows share one Main. Seed through the existing read before writing;
// merging this bounded slot adds no synchronous disk read to a write/IPC hot path.
let cloudHomes: { scope: string; retiredBotIds: string[]; revision: number; value: Record<string, unknown> | null } | null = null;
let cloudHomesRevision = 0;
const stringIds = (value: unknown): string[] => Array.isArray(value)
  ? value.filter((id): id is string => typeof id === 'string') : [];
/** Bounded, owner/endpoint-scoped snapshots behind the trusted local renderer boundary. */
export function accessChatDisplayCache(input: unknown): unknown {
  const request = schema.parse(input);
  const active = getActiveAppSession();
  if (isAppSessionBoundaryPending() || active.dataOwnerId !== request.owner.dataOwnerId || active.generation !== request.owner.generation)
    throw new Error('OWNER_CHANGED');
  const digest = createHash('sha256').update(JSON.stringify([getClientEndpoint('chatApiBaseUrl'), request.key])).digest('hex');
  const root = ownerScopedUserDataPath('chat-display');
  const file = path.join(root, `${digest}.json`);
  const scope = JSON.stringify([file, request.owner.generation]);
  if (request.action === 'read') {
    const raw = readAtomicFileSync(file);
    const value = raw && Buffer.byteLength(raw) <= MAX_BYTES ? JSON.parse(raw) : null;
    if (request.key !== 'cloud-homes') return value;
    const retiredBotIds = stringIds(value?.retiredBotIds);
    if (cloudHomes?.scope !== scope || JSON.stringify(cloudHomes.retiredBotIds) !== JSON.stringify(retiredBotIds)) {
      cloudHomes = { scope, retiredBotIds, revision: ++cloudHomesRevision, value: null };
    }
    cloudHomes.value = value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    return { ...cloudHomes.value, retirementRevision: cloudHomes.revision };
  }
  let value = request.action === 'remove' ? null : request.value;
  let retiredBotIds: string[] | null = null;
  let hasNewRetirements = false;
  if (request.action === 'write' && request.key === 'cloud-homes') {
    // Failed/missing hydration must never erase deletions we have not loaded.
    if (cloudHomes?.scope !== scope) throwIpcError('PRECONDITION_FAILED', 'Cloud display cache must be loaded before writing');
    if (!value || typeof value !== 'object' || Array.isArray(value)) throwIpcError('INVALID_PARAMS', 'Cloud display cache must be an object');
    const { revivedBotIds, newlyRetiredBotIds, retirementRevision, ...incoming } = value as Record<string, unknown>;
    // The full retired list is window history. Only this accept's new removals may
    // add tombstones: an old window must not undo another window's revival.
    const newlyRetired = stringIds(newlyRetiredBotIds);
    if (newlyRetired.length && retirementRevision !== cloudHomes.revision)
      throwIpcError('PRECONDITION_FAILED', 'Cloud display cache changed before this deletion; reload and confirm the roster');
    hasNewRetirements = newlyRetired.length > 0;
    const retired = new Set([...cloudHomes.retiredBotIds, ...newlyRetired]);
    const active = new Set(Array.isArray(incoming.actors) ? incoming.actors.flatMap(actor =>
      actor && typeof actor.externalId === 'string' ? [actor.externalId] : []) : []);
    // Presence alone may come from a stale renderer. Only a renderer that observed
    // retirement then a fresh active actor can explicitly revive that identity.
    if (retirementRevision === cloudHomes.revision) {
      for (const id of stringIds(revivedBotIds)) if (active.has(id) && !newlyRetired.includes(id)) retired.delete(id);
    }
    retiredBotIds = [...retired];
    // A stale historical snapshot may have an empty/older roster, but it may
    // also contain new actors accepted before the last write receipt arrived.
    const current = retirementRevision === cloudHomes.revision || cloudHomes.value === null;
    if (current) value = { ...incoming, retiredBotIds };
    else {
      const actors = new Map<string, unknown>();
      for (const source of [incoming, cloudHomes.value!]) {
        for (const actor of Array.isArray(source.actors) ? source.actors : []) {
          if (actor && typeof actor.externalId === 'string' && !retired.has(actor.externalId)) actors.set(actor.externalId, actor);
        }
      }
      value = { ...cloudHomes.value, actors: [...actors.values()], retiredBotIds };
    }
  }
  const raw = JSON.stringify(value);
  if (!raw || Buffer.byteLength(raw) > MAX_BYTES) throw new Error('CACHE_TOO_LARGE');
  mkdirSync(root, { recursive: true, mode: 0o700 }); atomicWriteFileSync(file, raw);
  if (retiredBotIds) {
    const unchanged = !hasNewRetirements && cloudHomes?.scope === scope && JSON.stringify(cloudHomes.retiredBotIds) === JSON.stringify(retiredBotIds);
    cloudHomes = { scope, retiredBotIds, revision: unchanged ? cloudHomes!.revision : ++cloudHomesRevision, value: value as Record<string, unknown> };
  }
  if (request.key === 'cloud-homes' && request.action === 'remove') cloudHomes = null;
  rmSync(`${file}.bak`, { force: true });
  if (request.action === 'remove') rmSync(file, { force: true });
  return retiredBotIds ? { retiredBotIds, retirementRevision: cloudHomes!.revision } : null;
}
