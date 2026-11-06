// Test value: R1/R2/R5/R6 of the approved secondary-window restart plan.
// Public Main storage entry, real isolated atomic files: prior chatPersistence tests cover only
// outbox/display snapshots, not min(seed)/max(ack), pagination, or failed read-position commits.
// Minimal failures: reverse two windows' acknowledgements; late earlier seed; one ENOSPC commit.
// Tier: unit (temporary local files, no database/network/process). Runtime recorded in task evidence.
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { botReadIdentityKey, effectiveBotReadAt, type BotReadIdentity, type BotReadStateChanged } from '../../../shared/botReadStateStorage.js';
import * as atomic from '../../utils/atomicWriteFile.js';
import { createBotReadStateStorage } from '../botReadStateStorage.js';

let root: string;
let owner: { dataOwnerId: string | null; generation: number };
let boundary: boolean;
let pushes: BotReadStateChanged[];
const bot: BotReadIdentity = { kind: 'bot', id: 'bot-a' };
const group: BotReadIdentity = { kind: 'group', id: 'room-a' };
const requestOwner = () => ({ dataOwnerId: owner.dataOwnerId!, generation: owner.generation });
const create = (publish = (event: BotReadStateChanged) => { pushes.push(event); }) => createBotReadStateStorage({
  currentOwner: () => owner, boundaryPending: () => boundary,
  ownerRoot: () => path.join(root, owner.dataOwnerId!, 'bot-read-state'), publish,
});
const filename = (identity: BotReadIdentity) => path.join(root, owner.dataOwnerId!, 'bot-read-state',
  `${createHash('sha256').update(botReadIdentityKey(identity)).digest('hex')}.json`);

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'cindy-bot-read-state-'));
  owner = { dataOwnerId: 'account-a', generation: 1 };
  boundary = false;
  pushes = [];
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

it('serializes reverse-order window acknowledgements without losing another identity or restart state', async () => {
  const storage = create();
  const scope = requestOwner();
  const [newer, older] = await Promise.all([
    storage.access({ action: 'merge', owner: scope, positions: [{ identity: bot, ackAt: 300 }] }),
    storage.access({ action: 'merge', owner: scope, positions: [{ identity: bot, ackAt: 200 }, { identity: group, ackAt: 400 }] }),
  ]);
  expect(newer.positions[0]?.ackAt).toBe(300);
  expect(older.positions.find(row => row.identity.kind === 'bot')?.ackAt).toBe(300);
  const restarted = await create().access({ action: 'snapshot', owner: scope });
  expect(restarted.positions).toEqual(expect.arrayContaining([
    { identity: bot, ackAt: 300 }, { identity: group, ackAt: 400 },
  ]));
  expect(restarted.instanceId).not.toBe(newer.instanceId);
  expect(pushes.map(event => event.revision)).toEqual([1, 2]);
});

it('takes the earliest automatic baseline without promoting it into an acknowledgement', async () => {
  const storage = create();
  const scope = requestOwner();
  await storage.access({ action: 'merge', owner: scope, positions: [{ identity: bot, initialAt: 200 }] });
  const earlier = await storage.access({ action: 'merge', owner: scope, positions: [{ identity: bot, initialAt: 100 }] });
  expect(earlier.positions[0]).toEqual({ identity: bot, initialAt: 100 });
  const confirmed = await storage.access({ action: 'merge', owner: scope, positions: [{ identity: bot, ackAt: 150 }] });
  expect(effectiveBotReadAt(confirmed.positions[0]!)).toBe(150);
  const late = await storage.access({ action: 'merge', owner: scope, positions: [{ identity: bot, initialAt: 50, ackAt: 120 }] });
  expect(late.positions[0]).toEqual({ identity: bot, initialAt: 50, ackAt: 150 });
  expect(effectiveBotReadAt(late.positions[0]!)).toBe(150);
});

it('imports a legacy lower bound idempotently and preserves separate local and device identities', async () => {
  const storage = create();
  const scope = requestOwner();
  const identities: BotReadIdentity[] = [bot, { kind: 'remote-bot', deviceId: 'device-a', botId: 'bot-a' },
    { kind: 'remote-bot', deviceId: 'device-b', botId: 'bot-a' }];
  const positions = identities.map(identity => ({ identity, legacyFloor: 250 }));
  const first = await storage.access({ action: 'merge', owner: scope, positions });
  const duplicate = await storage.access({ action: 'merge', owner: scope, positions });
  expect(duplicate.revision).toBe(first.revision);
  const ack = await storage.access({ action: 'merge', owner: scope, positions: [{ identity: bot, ackAt: 100, initialAt: 50 }] });
  expect(effectiveBotReadAt(ack.positions[0]!)).toBe(250);
  expect((await create().access({ action: 'snapshot', owner: scope })).positions).toHaveLength(3);
});

it('publishes only after saving and does not rewrite an unchanged position', async () => {
  const events: BotReadStateChanged[] = [];
  const storage = create(event => {
    expect(JSON.parse(readFileSync(filename(bot), 'utf8')).position.ackAt).toBe(300);
    events.push(event);
  });
  const write = vi.spyOn(atomic, 'atomicWriteFileSync');
  const scope = requestOwner();
  const input = { action: 'merge', owner: scope, positions: [{ identity: bot, ackAt: 300 }] };
  const first = await storage.access(input);
  expect((await storage.access(input)).revision).toBe(first.revision);
  expect(write).toHaveBeenCalledTimes(1);
  expect(events).toEqual([{ owner: scope, instanceId: first.instanceId, revision: 1 }]);
});

it('leaves the previous committed file, revision and event intact after disk failure, then recovers', async () => {
  const storage = create();
  const scope = requestOwner();
  await storage.access({ action: 'merge', owner: scope, positions: [{ identity: bot, ackAt: 200 }] });
  const write = vi.spyOn(atomic, 'atomicWriteFileSync').mockImplementationOnce(() => {
    throw Object.assign(new Error('private path must not cross IPC'), { code: 'ENOSPC' });
  });
  await expect(storage.access({ action: 'merge', owner: scope, positions: [{ identity: bot, ackAt: 300 }] }))
    .rejects.toThrow('[INTERNAL] BOT_READ_STATE_WRITE_FAILED');
  expect(JSON.parse(readFileSync(filename(bot), 'utf8')).position.ackAt).toBe(200);
  expect(pushes).toHaveLength(1);
  const unchanged = await storage.access({ action: 'snapshot', owner: scope });
  expect(unchanged.revision).toBe(1);
  expect(unchanged.positions[0]?.ackAt).toBe(200);
  write.mockRestore();
  expect((await storage.access({ action: 'merge', owner: scope, positions: [{ identity: bot, ackAt: 300 }] })).revision).toBe(2);
});

it('preserves completed batches when a later identity fails and allows an idempotent retry', async () => {
  const storage = create();
  const scope = requestOwner();
  const original = atomic.atomicWriteFileSync;
  vi.spyOn(atomic, 'atomicWriteFileSync').mockImplementation((file, content) => {
    if (file === filename(group)) throw new Error('write failed');
    return original(file, content);
  });
  const positions = [{ identity: bot, ackAt: 300 }, { identity: group, ackAt: 400 }];
  await expect(storage.access({ action: 'merge', owner: scope, positions })).rejects.toThrow('BOT_READ_STATE_WRITE_FAILED');
  expect(pushes).toHaveLength(1);
  vi.restoreAllMocks();
  const restored = await storage.access({ action: 'merge', owner: scope, positions });
  expect(restored.revision).toBe(2);
  expect(restored.positions).toEqual(positions);
});

it('does not reinterpret corrupt files or a mismatched identity as an empty read position', async () => {
  const storage = create();
  const scope = requestOwner();
  await storage.access({ action: 'merge', owner: scope, positions: [{ identity: bot, ackAt: 300 }] });
  for (const content of ['{broken', JSON.stringify({ schemaVersion: 1, position: { identity: group, ackAt: 300 } })]) {
    writeFileSync(filename(bot), content);
    const restarted = create();
    await expect(restarted.access({ action: 'snapshot', owner: scope })).rejects.toThrow('BOT_READ_STATE_READ_FAILED');
    await expect(restarted.access({ action: 'merge', owner: scope, positions: [{ identity: bot, initialAt: 500 }] }))
      .rejects.toThrow('BOT_READ_STATE_READ_FAILED');
    expect(readFileSync(filename(bot), 'utf8')).toBe(content);
  }
});

it('recovers an atomic backup rather than seeding over the only saved acknowledgement', async () => {
  const scope = requestOwner();
  await create().access({ action: 'merge', owner: scope, positions: [{ identity: bot, ackAt: 300 }] });
  renameSync(filename(bot), `${filename(bot)}.bak`);
  const restored = await create().access({ action: 'merge', owner: scope, positions: [{ identity: bot, initialAt: 500 }] });
  expect(effectiveBotReadAt(restored.positions[0]!)).toBe(300);
  expect(JSON.parse(readFileSync(filename(bot), 'utf8')).position.ackAt).toBe(300);
});

it('rejects a queued old-account command and fences same-owner generation changes and pending boundaries', async () => {
  const storage = create();
  const scope = requestOwner();
  const queued = storage.access({ action: 'merge', owner: scope, positions: [{ identity: bot, ackAt: 300 }] });
  owner = { dataOwnerId: 'account-b', generation: 2 };
  await expect(queued).rejects.toThrow('BOT_READ_OWNER_CHANGED');
  expect((await storage.access({ action: 'snapshot', owner: requestOwner() })).positions).toEqual([]);
  owner = { dataOwnerId: 'account-a', generation: 3 };
  await expect(storage.access({ action: 'snapshot', owner: scope })).rejects.toThrow('BOT_READ_OWNER_CHANGED');
  boundary = true;
  await expect(storage.access({ action: 'snapshot', owner: requestOwner() })).rejects.toThrow('BOT_READ_OWNER_CHANGED');
  boundary = false;
  expect(pushes).toEqual([]);
});

it('keeps a successful commit successful when event delivery fails', async () => {
  const storage = create(() => { throw new Error('window disappeared'); });
  const scope = requestOwner();
  await expect(storage.access({ action: 'merge', owner: scope, positions: [{ identity: bot, ackAt: 300 }] }))
    .resolves.toMatchObject({ revision: 1, positions: [{ identity: bot, ackAt: 300 }] });
  expect((await create().access({ action: 'snapshot', owner: scope })).positions[0]?.ackAt).toBe(300);
});

it('paginates all remote identities beyond 200 within the byte budget and invalidates stale cursors', async () => {
  const scope = requestOwner();
  const writer = create();
  // Multi-byte IDs make the transmission budget observable, not just a row-count assertion.
  const positions = Array.from({ length: 512 }, (_, i) => ({
    identity: { kind: 'remote-bot' as const, deviceId: `${'设'.repeat(185)}-${i % 3}`, botId: `${'伴'.repeat(185)}-${i}` }, ackAt: i,
  }));
  for (let i = 0; i < positions.length; i += 128) {
    await writer.access({ action: 'merge', owner: scope, positions: positions.slice(i, i + 128) });
  }
  const reader = create();
  const reads = vi.spyOn(atomic, 'readAtomicFileSync');
  const first = await reader.access({ action: 'snapshot', owner: scope });
  expect(first.nextCursor).toBeDefined();
  let page = first;
  const all = [...page.positions];
  while (page.nextCursor) {
    expect(Buffer.byteLength(JSON.stringify(page), 'utf8')).toBeLessThanOrEqual(256 * 1024);
    page = await reader.access({ action: 'snapshot', owner: scope, cursor: page.nextCursor });
    all.push(...page.positions);
  }
  expect(new Set(all.map(row => botReadIdentityKey(row.identity))).size).toBe(512);
  expect(reads).toHaveBeenCalledTimes(512);
  await reader.access({ action: 'snapshot', owner: scope });
  expect(reads).toHaveBeenCalledTimes(512);
  expect(readdirSync(path.dirname(filename(bot)))).toHaveLength(512);
  await reader.access({ action: 'merge', owner: scope, positions: [{ identity: bot, ackAt: 100 }] });
  await expect(reader.access({ action: 'snapshot', owner: scope, cursor: first.nextCursor })).rejects.toThrow('BOT_READ_SNAPSHOT_STALE');
  await expect(create().access({ action: 'snapshot', owner: scope, cursor: first.nextCursor })).rejects.toThrow('BOT_READ_SNAPSHOT_STALE');
});

it.each([
  { identity: bot, ackAt: -1 },
  { identity: bot, ackAt: Number.POSITIVE_INFINITY },
  { identity: bot, ackAt: 1.5 },
  { identity: bot },
  { identity: { kind: 'remote-bot', botId: 'bot' }, ackAt: 1 },
  { identity: { kind: 'bot', id: '../other', path: '/private' }, ackAt: 1 },
])('rejects malformed facts without creating files: %j', async position => {
  await expect(create().access({ action: 'merge', owner: requestOwner(), positions: [position] })).rejects.toThrow('INVALID_BOT_READ_STATE_REQUEST');
  expect(readdirSync(root)).toEqual([]);
});
