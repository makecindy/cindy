import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createProviderShareUsageStore, providerShareUsageRangeStart } from '../providerShareUsageStore';

const sample = (model: string, input: number, output: number, turns = 1) => ({
  model, turns, inputTokens: input, outputTokens: output, cacheReadTokens: 0, cacheCreateTokens: 0, sdkCostUsd: 0,
});

const directRoute = (now: number) => ({
  ownerScope: 'global:owner-1', ownerDeviceId: 'owner-pc', shareId: 'share-1', memberId: 'guest-1',
  guestDeviceId: 'guest-pc', sessionId: 'task-1', executorDeviceId: 'member-pc-1',
  executorProviderId: 'local-openai', agentKind: 'codex', providerId: 'openai',
  memberKey: 'device:member-1', model: 'gpt',
  generation: '11111111-1111-4111-8111-111111111111', expiresAt: now + 30 * 60_000,
});

describe('provider share usage store', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-share-usage-'));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // Unit, real ledger entry: personal ratios must isolate identity/provider/date and exclude cache.
  // Existing range tests do not cover midnight recovery or a failed ledger becoming a false 0%.
  it('reconstructs only one member/provider over seven local dates and advances at midnight', async () => {
    let now = new Date(2026, 9, 22, 10).getTime();
    const file = path.join(dir, 'usage.json');
    const store = createProviderShareUsageStore(file, { now: () => now });
    const write = (share: string, member: string, provider: string, model: string, tokens: number) =>
      store.record(share, member, { kind: 'codex', providerId: provider, memberKey: 'local', samples: [{ ...sample(model, tokens, 0), cacheReadTokens: 99999 }] });
    write('s', 'alice', 'p', 'new-model', 60);
    write('s', 'bob', 'p', 'new-model', 900);
    write('s', 'alice', 'another-provider', 'new-model', 900);
    write('another-share', 'alice', 'p', 'new-model', 900);
    now = new Date(2026, 9, 28, 10).getTime();
    write('s', 'alice', 'p', 'other-model', 40);
    const current = store.memberTokenSnapshot(new Set(['s']), 'p', 'alice');
    expect(current).toMatchObject({ available: true, windowStart: '2026-10-22', windowEnd: '2026-10-28',
      models: [{ model: 'new-model', tokens: 60 }, { model: 'other-model', tokens: 40 }] });
    now = current.nextWindowAt;
    expect(store.memberTokenSnapshot(new Set(['s']), 'p', 'alice')).toMatchObject({ windowStart: '2026-10-23', models: [{ model: 'other-model', tokens: 40 }] });
    await store.flush();
    expect(createProviderShareUsageStore(file, { now: () => now }).memberTokenSnapshot(new Set(['s']), 'p', 'alice').models).toEqual([{ model: 'other-model', tokens: 40 }]);
  });
  it('marks corrupt usage unavailable across subsequent writes and reloads', async () => {
    const file = path.join(dir, 'usage.json');
    fs.writeFileSync(file, '{broken');
    const store = createProviderShareUsageStore(file);
    expect(store.memberTokenSnapshot(new Set(['s']), 'p', 'alice').available).toBe(false);
    expect(() => store.record('s', 'alice', { kind: 'codex', providerId: 'p', memberKey: 'local', samples: [sample('model', 1, 0)] })).toThrow('ledger');
    await expect(store.flush()).rejects.toThrow('ledger');
    expect(fs.readFileSync(file, 'utf8')).toBe('{broken');
    expect(createProviderShareUsageStore(file).memberTokenSnapshot(new Set(['s']), 'p', 'alice').available).toBe(false);
  });

  // Unit: production snapshot/flush/reload must stop pausing once missing data leaves the window.
  // Regression #7666/r4398894972: the prior corrupt-file case only checked fail-closed, not recovery.
  // Minimal input: one corruption marker, a complete new row, restart next day, then advance seven dates.
  it.each(['corrupt-json', 'legacy-marker', 'dated-invalid-row'] as const)(
    'recovers after incomplete data leaves seven local dates, including reloads (%s)', async (damage) => {
      let now = new Date(2026, 9, 22, 12).getTime();
      const file = path.join(dir, 'usage.json');
      fs.writeFileSync(file, damage === 'corrupt-json' ? '{broken' : JSON.stringify({ version: 1,
        rows: damage === 'dated-invalid-row' ? [{ day: '2026-10-21', inputTokens: -1 }] : [],
        ...(damage === 'legacy-marker' ? { incomplete: true } : {}),
      }));
      let store = createProviderShareUsageStore(file, { now: () => now });
      const snapshot = () => store.memberTokenSnapshot(new Set(['s']), 'p', 'alice');
      expect(snapshot().available).toBe(false);
      if (damage === 'corrupt-json') {
        // A damaged whole ledger may contain cleanup fences: only a repaired
        // valid image can recover; usage rollover cannot erase security state.
        await expect(store.flush()).rejects.toThrow('ledger');
        expect(fs.readFileSync(file, 'utf8')).toBe('{broken');
        fs.writeFileSync(file, JSON.stringify({ version: 1, rows: [], incompleteThroughDay: '2026-10-22' }));
      }
      await store.flush();
      now = new Date(2026, 9, 23, 12).getTime();
      store = createProviderShareUsageStore(file, { now: () => now });
      expect(snapshot().available).toBe(false);
      store.record('s', 'alice', { kind: 'codex', providerId: 'p', memberKey: 'local', samples: [sample('model', 10, 5)] });
      await store.flush();
      now = new Date(2026, 9, damage === 'dated-invalid-row' ? 28 : 29, 12).getTime();
      store = createProviderShareUsageStore(file, { now: () => now });
      expect(snapshot()).toMatchObject({ available: true, models: [{ model: 'model', tokens: 15 }] });
    },
  );
  // Unit tier / security review #2+#3: production load/reconcile/commit/flush.
  // A single failed read previously cached emptiness, erased old M cleanup and
  // admitted a reapproved member. Existing corrupt-file coverage expected that
  // unsafe reset; these faults must preserve disk and allow the SAME store to retry.
  it.each(['EACCES', 'EIO', 'EBUSY'])('keeps unread %s safety state closed and retries after recovery', async (code) => {
    const file = path.join(dir, 'unread-ledger.json');
    const route = { ...directRoute(Date.now()), memberJoinedAt: 'g1' };
    const snapshot = (joinedAt: string) => [{ shareId: route.shareId, members: [{ memberId: route.memberId, joinedAt }] }];
    const initial = createProviderShareUsageStore(file);
    await initial.reconcileMemberGenerations(route.ownerScope, route.ownerDeviceId, snapshot('g1'));
    await initial.registerDirectReceiptRoute(route);
    await initial.commitDirectReceiptRoute(route);
    const originalRead = fs.readFileSync.bind(fs);
    const saved = originalRead(file, 'utf8');
    let unreadable = true;
    const read = vi.spyOn(fs, 'readFileSync').mockImplementation((...args: Parameters<typeof fs.readFileSync>) => {
      if (unreadable && String(args[0]) === file) throw Object.assign(new Error('fixture read failure'), { code });
      return originalRead(...args);
    });
    const restarted = createProviderShareUsageStore(file);
    const renewed = { ...route, memberJoinedAt: 'g2', generation: '22222222-2222-4222-8222-222222222222' };
    expect(() => restarted.listPendingDirectCleanup(route.ownerScope)).toThrow('ledger');
    expect(() => restarted.memberGenerationReady(route, 'g2')).toThrow('ledger');
    expect(() => restarted.findDirectTaskLocation(route)).toThrow('ledger');
    await expect(restarted.reconcileMemberGenerations(route.ownerScope, route.ownerDeviceId, snapshot('g2'))).rejects.toThrow('ledger');
    await expect(restarted.registerDirectReceiptRoute(renewed)).rejects.toThrow('ledger');
    await expect(restarted.commitDirectReceiptRoute(renewed)).rejects.toThrow('ledger');
    expect(() => restarted.record(route.shareId, route.memberId,
      { kind: 'codex', providerId: 'openai', memberKey: 'local', samples: [sample('gpt', 1, 1)] })).toThrow('ledger');
    await expect(restarted.flush()).rejects.toThrow('ledger');
    expect(originalRead(file, 'utf8')).toBe(saved);
    unreadable = false;
    await restarted.reconcileMemberGenerations(route.ownerScope, route.ownerDeviceId, snapshot('g2'));
    expect(restarted.memberGenerationReady(route, 'g2')).toBe(false);
    expect(restarted.findDirectTaskLocation(route)).toBeNull();
    const target = restarted.listPendingDirectCleanup(route.ownerScope)[0]!;
    expect(target.executorDeviceId).toBe(route.executorDeviceId);
    await expect(restarted.registerDirectReceiptRoute(renewed)).rejects.toThrow('cleanup is pending');
    await restarted.acknowledgeMemberCleanup(restarted.listPendingMemberCleanup(route.ownerScope, route.ownerDeviceId)[0]!);
    await restarted.acknowledgeDirectCleanup(target);
    await restarted.registerDirectReceiptRoute(renewed);
    await restarted.commitDirectReceiptRoute(renewed);
    read.mockRestore();
  });

  it.each(['memberGenerations', 'directReceiptRoutes', 'directCleanupTargets', 'directTaskLocations', 'recentUsageIds'])
    ('rejects malformed %s without publishing partial state or overwriting disk', async (field) => {
      const file = path.join(dir, 'invalid-safety.json');
      const route = { ...directRoute(Date.now()), memberJoinedAt: 'g1' };
      const initial = createProviderShareUsageStore(file);
      const snapshot = (joinedAt: string) => [{ shareId: route.shareId, members: [{ memberId: route.memberId, joinedAt }] }];
      await initial.reconcileMemberGenerations(route.ownerScope, route.ownerDeviceId, snapshot('g1'));
      await initial.registerDirectReceiptRoute(route);
      await initial.commitDirectReceiptRoute(route);
      const valid = JSON.parse(fs.readFileSync(file, 'utf8'));
      const restarted = createProviderShareUsageStore(file);
      for (const invalid of [null, {}, [...valid[field], null], [...valid[field], ...valid[field], { invalid: true }]]) {
        const body = JSON.stringify({ ...valid, [field]: invalid });
        fs.writeFileSync(file, body);
        expect(() => restarted.memberGenerationReady(route, 'g2')).toThrow('ledger');
        await expect(restarted.reconcileMemberGenerations(route.ownerScope, route.ownerDeviceId, snapshot('g2'))).rejects.toThrow('ledger');
        await expect(restarted.flush()).rejects.toThrow('ledger');
        expect(fs.readFileSync(file, 'utf8')).toBe(body);
      }
      fs.writeFileSync(file, JSON.stringify(valid));
      await restarted.reconcileMemberGenerations(route.ownerScope, route.ownerDeviceId, snapshot('g2'));
      expect(restarted.memberGenerationReady(route, 'g2')).toBe(false);
      expect(restarted.listPendingDirectCleanup(route.ownerScope)).toHaveLength(1);
    });

  it('rejects contradictory duplicate cleanup fences instead of keeping the last entry', async () => {
    const file = path.join(dir, 'duplicate-safety.json');
    const route = directRoute(Date.now());
    const target = { ...route, cleanupEpoch: 1, pendingId: '33333333-3333-4333-8333-333333333333' };
    const body = JSON.stringify({ version: 1, rows: [], directCleanupTargets: [target, { ...target, pendingId: undefined }] });
    fs.writeFileSync(file, body);
    const store = createProviderShareUsageStore(file);
    expect(() => store.listPendingDirectCleanup(route.ownerScope)).toThrow('Duplicate');
    await expect(store.registerDirectReceiptRoute(route)).rejects.toThrow('Duplicate');
    expect(fs.readFileSync(file, 'utf8')).toBe(body);
  });

  it('preserves oversized cleanup/receipt arrays and migrates every old executor before enforcing admission limits', async () => {
    const file = path.join(dir, 'oversized-safety.json');
    const now = Date.now();
    const route = directRoute(now);
    const pendingId = '33333333-3333-4333-8333-333333333333';
    const routes = Array.from({ length: 20_001 }, (_, index) => ({ ...route, sessionId: `task-${index}`,
      executorDeviceId: `M-${index}`, committedAt: now, expiresAt: now - 60 * 60_000 }));
    const targets = Array.from({ length: 20_001 }, (_, index) => ({ ...route, executorDeviceId: `N-${index}`,
      cleanupEpoch: 1, ...(index === 0 ? { pendingId } : {}) }));
    fs.writeFileSync(file, JSON.stringify({ version: 1, rows: [], directReceiptRoutes: routes, directCleanupTargets: targets }));
    const store = createProviderShareUsageStore(file, { now: () => now });
    expect(store.listPendingDirectCleanup(route.ownerScope)[0]).toMatchObject({ executorDeviceId: 'N-0', pendingId });
    expect(store.findDirectTaskLocation({ ...route, sessionId: 'task-0' })?.executorDeviceId).toBe('M-0');
    await store.flush();
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(saved.directCleanupTargets).toHaveLength(40_002);
    expect(saved.directTaskLocations).toHaveLength(20_001);
    expect(saved.directCleanupTargets[0]).toMatchObject({ executorDeviceId: 'N-0', pendingId });
    await expect(store.registerDirectReceiptRoute({ ...route, sessionId: 'new-task' })).rejects.toThrow('ledger is full');
  });

  // Unit tier, production durable ledger: active g1 -> O restart -> active g2
  // with the same memberId is absent from the original receipt/cleanup coverage.
  it('fences a reapproved member across restart until local and every executor cleanup ACK', async () => {
    const file = path.join(dir, 'membership.json');
    const now = Date.now();
    const route = { ...directRoute(now), memberJoinedAt: 'server-g1' };
    const snapshot = (joinedAt: string) => [{ shareId: route.shareId, members: [{ memberId: route.memberId, joinedAt }] }];
    let store = createProviderShareUsageStore(file, { now: () => now });
    await store.reconcileMemberGenerations(route.ownerScope, route.ownerDeviceId, snapshot('server-g1'));
    await store.registerDirectReceiptRoute(route);
    await store.commitDirectReceiptRoute(route);
    // Pause/resume has the same joinedAt and must preserve task affinity.
    expect(await store.reconcileMemberGenerations(route.ownerScope, route.ownerDeviceId, snapshot('server-g1'))).toEqual([]);
    expect(store.findDirectTaskLocation(route)?.executorDeviceId).toBe('member-pc-1');
    store = createProviderShareUsageStore(file, { now: () => now });
    const [pending] = await store.reconcileMemberGenerations(route.ownerScope, route.ownerDeviceId, snapshot('server-g2'));
    expect(store.findDirectTaskLocation(route)).toBeNull();
    expect(store.listActiveDirectReceiptRoutes(route.ownerScope)).toEqual([]);
    const renewed = { ...route, memberJoinedAt: 'server-g2', generation: '22222222-2222-4222-8222-222222222222' };
    await expect(store.registerDirectReceiptRoute(renewed)).rejects.toThrow('cleanup is pending');
    await expect(store.commitDirectReceiptRoute(route)).rejects.toThrow();
    await store.acknowledgeMemberCleanup(pending!);
    expect(store.memberGenerationReady(route, 'server-g2')).toBe(false);
    await expect(store.registerDirectReceiptRoute(renewed)).rejects.toThrow('cleanup is pending');
    const target = store.listPendingDirectCleanup(route.ownerScope)[0]!;
    expect(target).toMatchObject({ executorDeviceId: route.executorDeviceId, pendingId: expect.any(String) });
    await store.acknowledgeDirectCleanup(target);
    expect(store.memberGenerationReady(route, 'server-g2')).toBe(true);
    expect(store.memberGenerationReady(route, 'server-g1')).toBe(false);
    expect(store.findDirectTaskLocation(route)).toBeNull();
    await store.registerDirectReceiptRoute(renewed);
    await store.commitDirectReceiptRoute(renewed);
    expect(store.findDirectTaskLocation(route)?.memberJoinedAt).toBe('server-g2');
    const [g3] = await store.reconcileMemberGenerations(route.ownerScope, route.ownerDeviceId, snapshot('server-g3'));
    await store.acknowledgeMemberCleanup(pending!);
    expect(store.listPendingMemberCleanup(route.ownerScope, route.ownerDeviceId)).toEqual([g3]);
    expect(createProviderShareUsageStore(file).findDirectTaskLocation(route)).toBeNull();
  });

  it('persists relay-only removal, cleanup scopes and owner isolation with fail-closed atomic writes', async () => {
    const file = path.join(dir, 'relay-membership.json');
    let store = createProviderShareUsageStore(file);
    const snapshot = [{ shareId: 's', members: [{ memberId: 'm', joinedAt: 'g1' }] }];
    const member = { ownerScope: 'a', ownerDeviceId: 'O', shareId: 's', memberId: 'm' };
    await store.reconcileMemberGenerations('a', 'O', snapshot);
    await store.reconcileMemberGenerations('b', 'O', snapshot);
    const rename = vi.spyOn(fsp, 'rename').mockRejectedValueOnce(new Error('disk denied'));
    await expect(store.reconcileMemberGenerations('a', 'O', [])).rejects.toThrow('disk denied');
    expect(store.memberGenerationReady(member, 'g1')).toBe(false);
    await store.reconcileMemberGenerations('a', 'O', []);
    expect(store.memberGenerationReady({ ...member, ownerScope: 'b' }, 'g1')).toBe(true);
    const [removed] = store.listPendingMemberCleanup('a', 'O');
    await store.rememberMemberCleanupScopes(removed!, [{ controller: 'old-peer', relay: 'old-relay' }]);
    store = createProviderShareUsageStore(file);
    expect(store.listPendingMemberCleanup('a', 'O')[0]?.cleanupScopes).toEqual([{ controller: 'old-peer', relay: 'old-relay' }]);
    // Even a reappearance with an equal joinedAt cannot undo an observed removal.
    const [rejoined] = await store.reconcileMemberGenerations('a', 'O', snapshot);
    await store.acknowledgeMemberCleanup(removed!);
    expect(store.memberGenerationReady(member, 'g1')).toBe(false);
    rename.mockRejectedValueOnce(new Error('ack denied'));
    await expect(store.acknowledgeMemberCleanup(rejoined!)).rejects.toThrow('ack denied');
    expect(store.memberGenerationReady(member, 'g1')).toBe(false);
    await store.acknowledgeMemberCleanup(rejoined!);
    expect(createProviderShareUsageStore(file).memberGenerationReady(member, 'g1')).toBe(true);
  });

  // Production ledger commit/find/cleanup entries, unit tier. The previous receipt-only tests
  // could not protect native-session affinity: one committed task lost M after its 30m lease.
  // These inputs also cover durable failure, migration, capacity and the six identity boundaries;
  // none grants execution permission. Fake time avoids real lease waits.
  it('keeps a committed task location beyond lease/grace expiry and fences stale relay or renewal updates', async () => {
    const file = path.join(dir, 'locations.json');
    let now = new Date(2026, 9, 27, 12).getTime();
    const route = directRoute(now);
    const store = createProviderShareUsageStore(file, { now: () => now });
    await store.registerDirectReceiptRoute(route);
    expect(store.findDirectTaskLocation(route)).toBeNull();
    await store.commitDirectReceiptRoute(route);
    now += 31 * 60_000;
    expect(store.listActiveDirectReceiptRoutes(route.ownerScope)).toEqual([]);
    const restarted = createProviderShareUsageStore(file, { now: () => now });
    expect(restarted.getDirectTaskLocation(route.ownerScope, route.ownerDeviceId, route.shareId,
      route.memberId, route.guestDeviceId, route.sessionId))
      .toMatchObject({ executorDeviceId: 'member-pc-1', executorProviderId: 'local-openai', agentKind: 'codex' });
    const afterGrace = now + 90 * 24 * 60 * 60_000;
    const longAfterExpiry = createProviderShareUsageStore(file, { now: () => afterGrace });
    expect(longAfterExpiry.listActiveDirectReceiptRoutes(route.ownerScope)).toEqual([]);
    expect(longAfterExpiry.findDirectTaskLocation(route)?.executorDeviceId).toBe('member-pc-1');
    const renewed = { ...route, model: 'gpt-new', expiresAt: now + 30 * 60_000,
      generation: '22222222-2222-4222-8222-222222222222' };
    await store.registerDirectReceiptRoute(renewed);
    expect(store.findDirectTaskLocation(route)?.model).toBe('gpt');
    await store.commitDirectReceiptRoute(renewed);
    await store.markDirectReceiptRouteRevoked(route);
    expect(await store.markDirectTaskRelayed(route, route.generation)).toBe(false);
    const location = store.findDirectTaskLocation(route)!;
    expect(location).toMatchObject({ model: 'gpt-new', generation: renewed.generation });
    expect(location).not.toHaveProperty('expiresAt');
    location.executorDeviceId = 'mutated-copy';
    expect(store.findDirectTaskLocation(route)?.executorDeviceId).toBe('member-pc-1');
    expect(await store.markDirectTaskRelayed(renewed, renewed.generation)).toBe(true);
    // A retried old commit must not restore a task that has explicitly moved to relay.
    await store.commitDirectReceiptRoute(renewed);
    expect(createProviderShareUsageStore(file, { now: () => now }).findDirectTaskLocation(route)).toBeNull();
  });

  it('does not publish provisional or failed commits, and atomically restores the previous model location', async () => {
    const file = path.join(dir, 'atomic-location.json');
    const now = new Date(2026, 9, 27, 12).getTime();
    const route = directRoute(now);
    const store = createProviderShareUsageStore(file, { now: () => now });
    // Registration never trusts caller-supplied committedAt.
    await store.registerDirectReceiptRoute({ ...route, committedAt: now });
    expect(store.findDirectTaskLocation(route)).toBeNull();
    expect(createProviderShareUsageStore(file, { now: () => now }).findDirectTaskLocation(route)).toBeNull();
    const rename = vi.spyOn(fsp, 'rename').mockImplementationOnce(async () => {
      expect(store.findDirectTaskLocation(route)).toBeNull();
      expect(store.listActiveDirectReceiptRoutes(route.ownerScope)[0]?.committedAt).toBeUndefined();
      throw new Error('disk denied');
    });
    await expect(store.commitDirectReceiptRoute(route)).rejects.toThrow('disk denied');
    expect(store.findDirectTaskLocation(route)).toBeNull();
    expect(store.listActiveDirectReceiptRoutes(route.ownerScope)[0]?.committedAt).toBeUndefined();
    expect(createProviderShareUsageStore(file, { now: () => now }).findDirectTaskLocation(route)).toBeNull();
    await store.commitDirectReceiptRoute(route);
    const renewed = { ...route, model: 'gpt-new', generation: '22222222-2222-4222-8222-222222222222' };
    await store.registerDirectReceiptRoute(renewed);
    rename.mockRejectedValueOnce(new Error('replacement denied'));
    // Another queued write must never serialize the failed commit's tentative location.
    const failed = expect(store.commitDirectReceiptRoute(renewed)).rejects.toThrow('replacement denied');
    const revoked = store.markDirectReceiptRouteRevoked(route);
    await Promise.all([failed, revoked]);
    expect(store.findDirectTaskLocation(route)).toMatchObject({ generation: route.generation, model: 'gpt' });
    expect(createProviderShareUsageStore(file, { now: () => now }).findDirectTaskLocation(route))
      .toMatchObject({ generation: route.generation, model: 'gpt' });
    expect(store.listActiveDirectReceiptRoutes(route.ownerScope)[0]?.committedAt).toBeUndefined();
  });

  it('clears member locations with durable cleanup and cannot recommit a deleted assignment', async () => {
    const file = path.join(dir, 'deleted-location.json');
    const now = new Date(2026, 9, 27, 12).getTime();
    const route = directRoute(now);
    const store = createProviderShareUsageStore(file, { now: () => now });
    const otherTask = { ...route, sessionId: 'task-2', executorDeviceId: 'member-pc-2' };
    const otherMember = { ...route, memberId: 'guest-2' };
    for (const entry of [route, otherTask, otherMember]) {
      await store.registerDirectReceiptRoute(entry);
      await store.commitDirectReceiptRoute(entry);
    }
    vi.spyOn(fsp, 'rename').mockRejectedValueOnce(new Error('cleanup denied'));
    const match = (target: { memberId: string }) => target.memberId === route.memberId;
    await expect(store.enqueueDirectCleanup(route.ownerScope, match)).rejects.toThrow('cleanup denied');
    expect(store.findDirectTaskLocation(route)).toBeNull();
    const pending = store.listPendingDirectCleanup(route.ownerScope);
    expect(pending).toHaveLength(2);
    // Failed replacement left the complete old image on disk, never half of the deletion.
    const oldImage = createProviderShareUsageStore(file, { now: () => now });
    expect(oldImage.findDirectTaskLocation(route)).not.toBeNull();
    expect(oldImage.listPendingDirectCleanup(route.ownerScope)).toEqual([]);
    await expect(store.commitDirectReceiptRoute(route)).rejects.toThrow('cannot be committed');
    await store.enqueueDirectCleanup(route.ownerScope, match);
    expect(store.listPendingDirectCleanup(route.ownerScope)).toEqual(pending);
    const restarted = createProviderShareUsageStore(file, { now: () => now });
    expect(restarted.findDirectTaskLocation(route)).toBeNull();
    expect(restarted.findDirectTaskLocation(otherTask)).toBeNull();
    expect(restarted.findDirectTaskLocation(otherMember)).not.toBeNull();
    await restarted.acknowledgeDirectCleanup(pending[0]!);
    await expect(restarted.commitDirectReceiptRoute(route)).rejects.toThrow('cannot be committed');
    await restarted.enqueueDirectCleanup(route.ownerScope, (target) => target.shareId === route.shareId);
    expect(createProviderShareUsageStore(file, { now: () => now }).findDirectTaskLocation(otherMember)).toBeNull();
  });

  it('migrates the latest committed legacy location even after grace without reviving cleaned or provisional tasks', async () => {
    const file = path.join(dir, 'legacy-location.json');
    let now = new Date(2026, 9, 27, 12).getTime();
    const route = directRoute(now);
    const newer = { ...route, committedAt: now + 1, model: 'gpt-new', executorDeviceId: 'member-pc-2',
      generation: '22222222-2222-4222-8222-222222222222' };
    const deleted = { ...route, sessionId: 'deleted', memberId: 'deleted-member', committedAt: now };
    const cleaned = { ...route, sessionId: 'cleaned', memberId: 'cleaned-member', committedAt: now };
    const revoked = { ...route, sessionId: 'revoked', committedAt: now, revokedAt: now };
    fs.writeFileSync(file, JSON.stringify({ version: 1, rows: [], directReceiptRoutes: [
      newer, { ...route, committedAt: now }, { ...route, sessionId: 'provisional' }, deleted, cleaned, revoked,
    ], directCleanupTargets: [
      { ...deleted, cleanupEpoch: 1, pendingId: route.generation }, { ...cleaned, cleanupEpoch: 1, cleaned: true },
    ] }));
    now += 90 * 24 * 60 * 60_000;
    const store = createProviderShareUsageStore(file, { now: () => now });
    expect(store.findDirectTaskLocation(route)).toMatchObject({ model: 'gpt-new', executorDeviceId: 'member-pc-2' });
    expect(store.findDirectTaskLocation({ ...route, sessionId: 'provisional' })).toBeNull();
    expect(store.findDirectTaskLocation(deleted)).toBeNull();
    expect(store.findDirectTaskLocation(cleaned)).toBeNull();
    expect(store.findDirectTaskLocation(revoked)).toBeNull();
    expect(store.listActiveDirectReceiptRoutes(route.ownerScope)).toEqual([]);
    await store.flush();
    expect(createProviderShareUsageStore(file, { now: () => now }).findDirectTaskLocation(route))
      .toMatchObject({ executorDeviceId: 'member-pc-2' });
    await store.enqueueDirectCleanup(route.ownerScope, (target) => target.memberId === route.memberId);
    expect(store.listPendingDirectCleanup(route.ownerScope).map((target) => target.executorDeviceId))
      .toEqual(expect.arrayContaining(['member-pc-1', 'member-pc-2']));
    expect(createProviderShareUsageStore(file, { now: () => now }).findDirectTaskLocation(route)).toBeNull();
  });

  it('requires all owner/share/member/guest/session identity fields for location lookup and removal', async () => {
    const file = path.join(dir, 'scoped-location.json');
    const now = new Date(2026, 9, 27, 12).getTime();
    const route = directRoute(now);
    const store = createProviderShareUsageStore(file, { now: () => now });
    await store.registerDirectReceiptRoute(route);
    await store.commitDirectReceiptRoute(route);
    for (const field of ['ownerScope', 'ownerDeviceId', 'shareId', 'memberId', 'guestDeviceId', 'sessionId'] as const) {
      const foreign = { ...route, [field]: `other-${route[field]}` };
      expect(store.getDirectTaskLocation(foreign.ownerScope, foreign.ownerDeviceId, foreign.shareId,
        foreign.memberId, foreign.guestDeviceId, foreign.sessionId)).toBeNull();
      expect(await store.clearDirectTaskLocation(foreign, route.generation)).toBe(false);
    }
    expect(store.findDirectTaskLocation(route)).not.toBeNull();
    vi.spyOn(fsp, 'rename').mockRejectedValueOnce(new Error('clear denied'));
    await expect(store.clearDirectTaskLocation(route, route.generation)).rejects.toThrow('clear denied');
    expect(store.findDirectTaskLocation(route)).not.toBeNull();
    expect(createProviderShareUsageStore(file, { now: () => now }).findDirectTaskLocation(route)).not.toBeNull();
    expect(await store.clearDirectTaskLocation(route, route.generation)).toBe(true);
    expect(createProviderShareUsageStore(file, { now: () => now }).findDirectTaskLocation(route)).toBeNull();
  });

  it('rejects new locations at capacity without evicting old tasks and still permits renewal', async () => {
    const file = path.join(dir, 'full-location.json');
    const now = new Date(2026, 9, 27, 12).getTime();
    const route = directRoute(now);
    const overflow = { ...route, sessionId: 'overflow' };
    fs.writeFileSync(file, JSON.stringify({ version: 1, rows: [],
      directTaskLocations: Array.from({ length: 20_000 }, (_, index) => ({ ...route, sessionId: `task-${index}`, committedAt: now })),
      directReceiptRoutes: [overflow], directCleanupTargets: [{ ...route, cleanupEpoch: 1 }],
    }));
    const store = createProviderShareUsageStore(file, { now: () => now });
    await expect(store.registerDirectReceiptRoute({ ...overflow, sessionId: 'new' })).rejects.toThrow('location ledger is full');
    await expect(store.commitDirectReceiptRoute(overflow)).rejects.toThrow('location ledger is full');
    expect(store.findDirectTaskLocation(overflow)).toBeNull();
    expect(store.listActiveDirectReceiptRoutes(route.ownerScope)[0]?.committedAt).toBeUndefined();
    const renewed = { ...route, sessionId: 'task-0', model: 'gpt-new',
      generation: '22222222-2222-4222-8222-222222222222' };
    await store.registerDirectReceiptRoute(renewed);
    await store.commitDirectReceiptRoute(renewed);
    const restarted = createProviderShareUsageStore(file, { now: () => now });
    expect(restarted.findDirectTaskLocation(renewed)).toMatchObject({ model: 'gpt-new' });
    expect(restarted.findDirectTaskLocation({ ...route, sessionId: 'task-19999' })).not.toBeNull();
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).directTaskLocations).toHaveLength(20_000);
  });

  it('aggregates per member and model, filters by range and only returns requested shares', async () => {
    let now = new Date(2026, 9, 7, 12).getTime();
    const file = path.join(dir, 'usage.json');
    const store = createProviderShareUsageStore(file, { now: () => now });
    store.record('share-1', 'm1', { kind: 'claude-code', providerId: 'anthropic', memberKey: 'local', samples: [sample('opus', 10, 5)] });
    now = new Date(2026, 8, 20, 12).getTime();
    store.record('share-1', 'm1', { kind: 'claude-code', providerId: 'anthropic', memberKey: 'local', samples: [sample('opus', 100, 50)] });
    store.record('share-2', 'm9', { kind: 'codex', providerId: 'openai', memberKey: 'local', samples: [sample('gpt', 1, 1)] });
    now = new Date(2026, 9, 7, 13).getTime();

    const month = store.query(new Set(['share-1']), 'month');
    expect(month).toHaveLength(1);
    expect(month[0]).toMatchObject({ shareId: 'share-1', memberId: 'm1' });
    expect(month[0].models).toEqual([{ kind: 'claude-code', providerId: 'anthropic', memberKey: 'local', model: 'opus', turns: 1, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreateTokens: 0, sdkCostUsd: 0 }]);
    expect(month[0].lastUsedAt).toBe(new Date(2026, 9, 7, 12).getTime());
    expect(store.query(new Set(['share-1']), 'all')[0].models[0]).toMatchObject({ turns: 2, inputTokens: 110, outputTokens: 55 });

    await store.flush();
    const reloaded = createProviderShareUsageStore(file, { now: () => now });
    expect(reloaded.query(new Set(['share-1', 'share-2']), 'all')).toHaveLength(2);
  });

  it('records a retried executor usage receipt only once, including after a host restart', async () => {
    const file = path.join(dir, 'usage.json');
    const now = new Date(2026, 9, 27, 12).getTime();
    const input = { kind: 'codex', providerId: 'openai', memberKey: 'device:member-1', samples: [sample('gpt', 7, 3)] };
    const id = '12345678-1234-1234-1234-123456789abc';
    const store = createProviderShareUsageStore(file, { now: () => now });
    expect(store.recordOnce(id, 'share', 'guest', input)).toBe(true);
    expect(store.recordOnce(id, 'share', 'guest', input)).toBe(false);
    await store.flush();
    const reloaded = createProviderShareUsageStore(file, { now: () => now });
    expect(reloaded.recordOnce(id, 'share', 'guest', input)).toBe(false);
    expect(reloaded.query(new Set(['share']), 'all')[0]?.models[0]).toMatchObject({ turns: 1, inputTokens: 7 });
  });

  it('keeps every retry ID for the executor retry window even when the ledger reaches capacity', () => {
    const file = path.join(dir, 'usage.json');
    let now = new Date(2026, 9, 27, 12).getTime();
    const store = createProviderShareUsageStore(file, { now: () => now });
    const input = { kind: 'codex', providerId: 'openai', memberKey: 'device:member-1',
      samples: [sample('gpt', 1, 0)] };
    const id = (index: number) => `12345678-1234-4234-8234-${index.toString(16).padStart(12, '0')}`;
    for (let index = 0; index < 20_000; index++) expect(store.recordOnce(id(index), 'share', 'guest', input)).toBe(true);
    expect(store.recordOnce(id(0), 'share', 'guest', input)).toBe(false);
    expect(() => store.recordOnce(id(20_000), 'share', 'guest', input)).toThrow('REMOTE_AGENT_BUSY');
    expect(store.query(new Set(['share']), 'all')[0]?.models[0]?.turns).toBe(20_000);
    now += 33 * 60_000;
    expect(store.recordOnce(id(20_000), 'share', 'guest', input)).toBe(true);
  });

  // Regression: O may restart, switch M, or let a lease expire while M retries a completed turn's receipt.
  // This exercises the production ledger entry, its durable acknowledgement, and authenticated M binding (unit tier).
  it('accepts historical direct receipts after restart or route switch, but only from their assigned executor', async () => {
    const file = path.join(dir, 'usage.json');
    let now = new Date(2026, 9, 27, 12).getTime();
    const route = {
      ownerScope: 'global:owner-1', ownerDeviceId: 'owner-pc', shareId: 'share-1', memberId: 'guest-1',
      guestDeviceId: 'guest-pc', sessionId: 'task-1', executorDeviceId: 'member-pc-1',
      executorProviderId: 'local-openai', agentKind: 'codex', providerId: 'openai',
      memberKey: 'device:member-1', model: 'gpt',
      generation: '11111111-1111-4111-8111-111111111111', expiresAt: now + 30 * 60_000,
    };
    const first = createProviderShareUsageStore(file, { now: () => now });
    await first.registerDirectReceiptRoute(route);
    const receipt = { shareId: route.shareId, memberId: route.memberId, guestDeviceId: route.guestDeviceId,
      sessionId: route.sessionId, generation: route.generation, agentKind: 'codex',
      usageId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      samples: [sample('gpt', 7, 3)] };
    await expect(first.recordDirectReceipt('global:owner-1', 'owner-pc', 'member-pc-1', receipt)).rejects.toThrow();
    await first.commitDirectReceiptRoute(route);
    const restarted = createProviderShareUsageStore(file, { now: () => now });
    expect(restarted.listActiveDirectReceiptRoutes('global:owner-2')).toEqual([]);
    expect(restarted.listActiveDirectReceiptRoutes('global:owner-1')).toMatchObject([
      { executorDeviceId: 'member-pc-1', executorProviderId: 'local-openai', generation: route.generation },
    ]);
    await expect(restarted.recordDirectReceipt('global:owner-1', 'owner-pc', 'other-pc', receipt)).rejects.toThrow();
    await expect(restarted.recordDirectReceipt('global:owner-2', 'owner-pc', 'member-pc-1', receipt)).rejects.toThrow();
    await expect(restarted.recordDirectReceipt('global:owner-1', 'other-owner', 'member-pc-1', receipt)).rejects.toThrow();
    const secondRoute = { ...route, executorDeviceId: 'member-pc-2', memberKey: 'device:member-2',
      generation: '22222222-2222-4222-8222-222222222222' };
    const renewedRoute = { ...route, memberKey: 'device:member-renewed',
      generation: '33333333-3333-4333-8333-333333333333' };
    await restarted.registerDirectReceiptRoute(secondRoute);
    await restarted.commitDirectReceiptRoute(secondRoute);
    await restarted.registerDirectReceiptRoute(renewedRoute);
    await restarted.commitDirectReceiptRoute(renewedRoute);
    await restarted.markDirectReceiptRouteRevoked(route);
    expect(restarted.listActiveDirectReceiptRoutes('global:owner-1').map((entry) => entry.generation))
      .toEqual(['22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333']);
    expect(createProviderShareUsageStore(file, { now: () => now })
      .listActiveDirectReceiptRoutes('global:owner-1').map((entry) => entry.generation))
      .toEqual(['22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333']);
    await expect(restarted.registerDirectReceiptRoute(route)).rejects.toThrow('revoked');
    now = route.expiresAt + 60_000;
    expect(restarted.listActiveDirectReceiptRoutes('global:owner-1')).toEqual([]);
    expect(await restarted.recordDirectReceipt('global:owner-1', 'owner-pc', 'member-pc-1', receipt)).toBe(true);
    const latest = { ...receipt, generation: '22222222-2222-4222-8222-222222222222',
      usageId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', samples: [sample('gpt', 5, 2)] };
    expect(await restarted.recordDirectReceipt('global:owner-1', 'owner-pc', 'member-pc-2', latest)).toBe(true);
    await expect(restarted.recordDirectReceipt('global:owner-1', 'owner-pc', 'member-pc-2',
      { ...latest, generation: route.generation })).rejects.toThrow();
    const renewed = { ...receipt, generation: '33333333-3333-4333-8333-333333333333',
      usageId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', samples: [sample('gpt', 2, 1)] };
    expect(await restarted.recordDirectReceipt('global:owner-1', 'owner-pc', 'member-pc-1', renewed)).toBe(true);
    const afterAck = createProviderShareUsageStore(file, { now: () => now });
    expect(await afterAck.recordDirectReceipt('global:owner-1', 'owner-pc', 'member-pc-1', receipt)).toBe(false);
    expect(afterAck.query(new Set(['share-1']), 'all')[0]?.models.map((row) => [row.memberKey, row.inputTokens]))
      .toEqual(expect.arrayContaining([['device:member-1', 7], ['device:member-2', 5], ['device:member-renewed', 2]]));
    now = route.expiresAt + 31 * 60_000;
    await expect(afterAck.recordDirectReceipt('global:owner-1', 'owner-pc', 'member-pc-1',
      { ...receipt, usageId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' })).rejects.toThrow();
  });

  // A member can leave long after the 30-minute direct lease and receipt grace
  // expire. O must still know every M that may hold this G's guest-home (unit tier).
  it('retains direct cleanup destinations until M acknowledges deletion, scoped to the owner', async () => {
    const file = path.join(dir, 'cleanup.json');
    let now = new Date(2026, 9, 27, 12).getTime();
    const route = {
      ownerScope: 'global:owner-a', ownerDeviceId: 'owner-pc', shareId: 'share-a', memberId: 'member-a',
      guestDeviceId: 'guest-pc', sessionId: 'task-1', executorDeviceId: 'executor-a',
      executorProviderId: 'openai', agentKind: 'codex', providerId: 'openai', memberKey: 'member-key',
      model: 'gpt', generation: '11111111-1111-4111-8111-111111111111', expiresAt: now + 30 * 60_000,
    };
    const store = createProviderShareUsageStore(file, { now: () => now });
    expect(await store.registerDirectReceiptRoute(route)).toBe(1);
    expect(await store.registerDirectReceiptRoute({ ...route, sessionId: 'task-2', executorDeviceId: 'executor-b' })).toBe(1);
    await store.registerDirectReceiptRoute({ ...route, memberId: 'member-b', guestDeviceId: 'other-guest', sessionId: 'task-3' });
    now += 3 * 24 * 60 * 60_000;
    await store.flush();
    const restarted = createProviderShareUsageStore(file, { now: () => now });
    await restarted.enqueueDirectCleanup('global:owner-a', (target) => target.memberId === 'member-a');
    expect(restarted.listPendingDirectCleanup('global:owner-b')).toEqual([]);
    const pending = restarted.listPendingDirectCleanup('global:owner-a');
    expect(pending.map((target) => target.executorDeviceId)).toEqual(['executor-a', 'executor-b']);
    expect(restarted.pendingDirectCleanupFor('global:owner-a', {
      shareId: 'share-a', memberId: 'member-a', guestDeviceId: 'guest-pc', executorDeviceId: 'executor-b',
    })).toEqual(pending[1]);
    await restarted.acknowledgeDirectCleanup(pending[0]!);
    const afterAck = createProviderShareUsageStore(file, { now: () => now });
    expect(afterAck.listPendingDirectCleanup('global:owner-a').map((target) => target.executorDeviceId))
      .toEqual(['executor-b']);
    // A rejoin on M must first settle its old deletion, then advance the fence.
    const renewed = { ...route, sessionId: 'task-4', executorDeviceId: 'executor-b',
      generation: '22222222-2222-4222-8222-222222222222', expiresAt: now + 30 * 60_000 };
    await expect(afterAck.registerDirectReceiptRoute(renewed)).rejects.toThrow('cleanup is still pending');
    await afterAck.acknowledgeDirectCleanup(pending[1]!);
    expect(await afterAck.registerDirectReceiptRoute(renewed)).toBe(2);
    await afterAck.acknowledgeDirectCleanup(pending[1]!); // stale ACK cannot clear a new grant
    expect(afterAck.listPendingDirectCleanup('global:owner-a')).toEqual([]);
    await afterAck.enqueueDirectCleanup('global:owner-a', (target) => target.memberId === 'member-a');
    expect(afterAck.listPendingDirectCleanup('global:owner-a')).toMatchObject([{
      executorDeviceId: 'executor-b', cleanupEpoch: 2,
    }]);
    expect(afterAck.listPendingDirectCleanup('global:owner-a')[0]?.pendingId).not.toBe(pending[1]?.pendingId);
  });

  it('splits each row by computer in the group without changing the row key, so older versions keep the totals', async () => {
    const now = new Date(2026, 9, 11, 12).getTime();
    const file = path.join(dir, 'usage.json');
    // 加组内电脑之前记的一行：合计 3 轮，没有区分电脑。
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      rows: [{
        day: '2026-10-11', shareId: 's', memberId: 'm', kind: 'claude-code', providerId: 'anthropic', model: 'opus',
        turns: 3, inputTokens: 30, outputTokens: 3, cacheReadTokens: 0, cacheCreateTokens: 0, sdkCostUsd: 0.3, lastAt: 1,
      }],
    }));
    const store = createProviderShareUsageStore(file, { now: () => now });
    store.record('s', 'm', { kind: 'claude-code', providerId: 'anthropic', memberKey: 'local', samples: [sample('opus', 10, 1)] });
    store.record('s', 'm', { kind: 'claude-code', providerId: 'anthropic', memberKey: 'device:studio:a2', samples: [sample('opus', 20, 2)] });
    const models = store.query(new Set(['s']), 'all')[0]!.models;
    expect(models.map((model) => [model.memberKey, model.turns, model.inputTokens])).toEqual(
      expect.arrayContaining([['local', 1, 10], ['device:studio:a2', 1, 20], [null, 3, 30]]),
    );
    expect(models).toHaveLength(3);

    // 文件里仍是同一行(旧版本的键)，合计包含全部；各台的分布在 byMember 里。
    await store.flush();
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as { rows: Array<Record<string, unknown>> };
    expect(saved.rows).toHaveLength(1);
    expect(saved.rows[0]).toMatchObject({ turns: 5, inputTokens: 60, byMember: { local: { turns: 1 }, 'device:studio:a2': { turns: 1 } } });

    // 降级期间旧版本只加了合计：多出来的算没区分电脑，不会让某台超过合计。
    saved.rows[0]!.turns = 7;
    saved.rows[0]!.inputTokens = 80;
    fs.writeFileSync(file, JSON.stringify(saved));
    const after = createProviderShareUsageStore(file, { now: () => now }).query(new Set(['s']), 'all')[0]!.models;
    expect(after.find((model) => model.memberKey === null)).toMatchObject({ turns: 5, inputTokens: 50 });
  });

  // 「用量」块按天筛选(provider-groups.md §7)：每天按组内电脑拆开，拆法与 query 相同。
  it('lists daily usage per member split by computer, newest day first and only for requested shares', () => {
    let now = new Date(2026, 9, 10, 12).getTime();
    const file = path.join(dir, 'usage.json');
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      rows: [{
        day: '2026-10-09', shareId: 's', memberId: 'm', kind: 'claude-code', providerId: 'anthropic', model: 'opus',
        turns: 3, inputTokens: 30, outputTokens: 3, cacheReadTokens: 0, cacheCreateTokens: 0, sdkCostUsd: 0, lastAt: 1,
      }],
    }));
    const store = createProviderShareUsageStore(file, { now: () => now });
    store.record('s', 'm', { kind: 'claude-code', providerId: 'anthropic', memberKey: 'local', samples: [sample('opus', 10, 1)] });
    store.record('s', 'm', { kind: 'claude-code', providerId: 'anthropic', memberKey: 'device:studio:a2', samples: [sample('opus', 20, 2)] });
    now = new Date(2026, 9, 11, 12).getTime();
    store.record('s', 'm', { kind: 'claude-code', providerId: 'anthropic', memberKey: 'local', samples: [sample('opus', 5, 5)] });
    store.record('other', 'x', { kind: 'codex', providerId: 'openai', memberKey: 'local', samples: [sample('gpt', 1, 1)] });

    const history = store.history(new Set(['s']));
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ shareId: 's', memberId: 'm', lastUsedAt: now });
    expect(history[0]!.days.map((row) => [row.day, row.memberKey, row.inputTokens])).toEqual([
      ['2026-10-11', 'local', 5],
      ['2026-10-10', 'local', 10],
      ['2026-10-10', 'device:studio:a2', 20],
      // 加组内电脑之前记的：没有区分电脑。
      ['2026-10-09', null, 30],
    ]);
  });

  it('bounds daily expansion before splitting every stored computer distribution', () => {
    let now = new Date(2026, 9, 12, 12).getTime();
    const file = path.join(dir, 'bounded-history.json');
    const store = createProviderShareUsageStore(file, { now: () => now });
    store.record('s', 'm', { kind: 'claude-code', providerId: 'anthropic', memberKey: 'device:new', samples: [sample('new', 1, 1)] });
    now = new Date(2026, 9, 11, 12).getTime();
    store.record('s', 'm', { kind: 'claude-code', providerId: 'anthropic', memberKey: 'device:old', samples: [sample('old', 1, 1)] });
    const history = store.history(new Set(['s']), { maxRows: 1 });
    expect(history[0]).toMatchObject({ shareId: 's', memberId: 'm', lastUsedAt: new Date(2026, 9, 12, 12).getTime() });
    expect(history[0]?.days).toHaveLength(1);
    expect(history[0]?.days[0]).toMatchObject({ day: '2026-10-12', model: 'new', memberKey: 'device:new' });
  });

  it('applies the split-row budget across members after excluding removed members', () => {
    let now = new Date(2026, 9, 10, 12).getTime();
    const store = createProviderShareUsageStore(path.join(dir, 'split-history.json'), { now: () => now });
    const record = (memberId: string, memberKey: string) => store.record('s', memberId, {
      kind: 'claude-code', providerId: 'anthropic', memberKey, samples: [sample('opus', 1, 1)],
    });
    record('m', 'device:old');
    now = new Date(2026, 9, 11, 12).getTime();
    for (let index = 0; index < 512; index++) record('m', `device:d${index}`);
    now = new Date(2026, 9, 12, 12).getTime();
    record('removed', 'local');
    const history = store.history(new Set(['s']), {
      maxRows: 3, memberKeys: new Set([JSON.stringify(['s', 'm'])]),
    });
    expect(history).toHaveLength(1);
    expect(history[0]?.days).toHaveLength(3);
    expect(history[0]?.days.every((row) => row.day === '2026-10-11')).toBe(true);
    expect(history[0]?.days.map((row) => row.memberKey)).toEqual(['device:d0', 'device:d1', 'device:d2']);
    expect(history[0]?.lastUsedAt).toBe(new Date(2026, 9, 11, 12).getTime());
  });

  it('keeps existing computer distributions and all counters after exceeding the per-row capacity and restarting', async () => {
    const now = new Date(2026, 9, 11, 12).getTime();
    const file = path.join(dir, 'usage.json');
    const store = createProviderShareUsageStore(file, { now: () => now });
    const usage = (memberKey: string, turns = 1) => ({
      kind: 'claude-code', providerId: 'anthropic', memberKey, samples: [{
        ...sample('opus', turns * 10, turns * 5, turns),
        cacheReadTokens: turns * 2, cacheCreateTokens: turns * 3, sdkCostUsd: turns * 0.01,
      }],
    });
    for (let i = 0; i < 512; i++) store.record('s', 'm', usage(`device:d${i}:anthropic`));
    store.record('s', 'm', usage('device:overflow:anthropic', 2));
    // 满容量后已有键仍能更新，不能因为新键溢出而丢掉已记的电脑。
    store.record('s', 'm', usage('device:d0:anthropic', 3));
    const before = store.query(new Set(['s']), 'all');
    expect(before[0]!.models).toHaveLength(513);
    expect(before[0]!.models.find((model) => model.memberKey === 'device:d0:anthropic')).toMatchObject({ turns: 4 });
    expect(before[0]!.models.find((model) => model.memberKey === null)).toMatchObject({ turns: 2, inputTokens: 20 });
    await store.flush();
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as { rows: Array<{ byMember: Record<string, unknown>; turns: number }> };
    expect(Object.keys(saved.rows[0]!.byMember)).toHaveLength(512);
    expect(saved.rows[0]!.byMember).not.toHaveProperty('device:overflow:anthropic');
    expect(saved.rows[0]!.turns).toBe(517);
    const reloaded = createProviderShareUsageStore(file, { now: () => now });
    expect(reloaded.query(new Set(['s']), 'all')).toEqual(before);
    const models = before[0]!.models;
    for (const [field, total] of [
      ['turns', 517], ['inputTokens', 5170], ['outputTokens', 2585],
      ['cacheReadTokens', 1034], ['cacheCreateTokens', 1551], ['sdkCostUsd', 5.17],
    ] as const) {
      expect(models.reduce((sum, model) => sum + model[field], 0)).toBeCloseTo(total);
    }
    reloaded.record('s', 'm', usage('device:overflow:anthropic'));
    reloaded.record('s', 'm', usage('device:d511:anthropic'));
    const after = reloaded.query(new Set(['s']), 'all');
    expect(after[0]!.models.find((model) => model.memberKey === null)).toMatchObject({ turns: 3 });
    expect(after[0]!.models.find((model) => model.memberKey === 'device:d511:anthropic')).toMatchObject({ turns: 2 });
    await reloaded.flush();
    expect(createProviderShareUsageStore(file, { now: () => now }).query(new Set(['s']), 'all')).toEqual(after);
  });

  it('recovers the stored distributions from an older oversized byMember row without losing its total', async () => {
    const now = new Date(2026, 9, 11, 12).getTime();
    const file = path.join(dir, 'usage.json');
    const counters = { turns: 1, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreateTokens: 0, sdkCostUsd: 0 };
    fs.writeFileSync(file, JSON.stringify({ version: 1, rows: [{
      day: '2026-10-11', shareId: 's', memberId: 'm', kind: 'claude-code', providerId: 'anthropic', model: 'opus',
      ...counters, turns: 513, inputTokens: 5130, outputTokens: 2565, lastAt: now,
      byMember: Object.fromEntries(Array.from({ length: 513 }, (_, i) => [`device:d${i}:anthropic`, counters])),
    }] }));
    const store = createProviderShareUsageStore(file, { now: () => now });
    const models = store.query(new Set(['s']), 'all')[0]!.models;
    expect(models.filter((model) => model.memberKey !== null)).toHaveLength(512);
    expect(models.find((model) => model.memberKey === null)).toMatchObject({ turns: 1, inputTokens: 10, outputTokens: 5 });
    store.record('s', 'm', { kind: 'claude-code', providerId: 'anthropic', memberKey: 'device:d0:anthropic', samples: [sample('opus', 20, 10, 2)] });
    const after = store.query(new Set(['s']), 'all');
    expect(after[0]!.models.find((model) => model.memberKey === 'device:d0:anthropic')).toMatchObject({ turns: 3 });
    await store.flush();
    expect(createProviderShareUsageStore(file, { now: () => now }).query(new Set(['s']), 'all')).toEqual(after);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as { rows: Array<{ byMember: Record<string, unknown>; turns: number }> };
    expect(Object.keys(saved.rows[0]!.byMember)).toHaveLength(512);
    expect(saved.rows[0]!.turns).toBe(515);
  });

  it('rejects corrupt files, retries the same store, and still drops malformed accounting rows', async () => {
    const file = path.join(dir, 'usage.json');
    const store = createProviderShareUsageStore(file);
    for (const invalid of ['{not json', 'null', '{"version":2,"rows":[]}', '{"version":1,"rows":null}']) {
      fs.writeFileSync(file, invalid);
      expect(() => store.query(new Set(['s']), 'all')).toThrow('ledger');
      await expect(store.flush()).rejects.toThrow('ledger');
      expect(fs.readFileSync(file, 'utf8')).toBe(invalid);
    }
    fs.writeFileSync(file, JSON.stringify({ version: 1, rows: [{ day: '2026-10-01', shareId: 's', memberId: 'm', kind: 'pi', providerId: null, model: 'x', turns: -1 }] }));
    expect(store.query(new Set(['s']), 'all')).toEqual([]);
    await store.flush();
  });

  it('computes range starts in local days', () => {
    const now = new Date(2026, 9, 7, 9).getTime();
    expect(providerShareUsageRangeStart('all', now)).toBeNull();
    expect(providerShareUsageRangeStart('month', now)).toBe('2026-10-01');
    expect(providerShareUsageRangeStart('7d', now)).toBe('2026-10-01');
  });
});
