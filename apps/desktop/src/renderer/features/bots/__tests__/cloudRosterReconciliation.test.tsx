// @vitest-environment jsdom
// #9760: unit tier, real cloud store + remote sync + projection. The existing suites
// mock one another; this fixture exercises their shared lifecycle without native accounts.
// Minimal failure: an authoritative empty roster arrives while a deleted bot's host is offline.
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CompanionCloudSnapshot } from '../../../../shared/companionCloud';
const h = vi.hoisted(() => ({ owner: { dataOwnerId: 'roster-owner', generation: 1 }, cacheRoot: '', devices: [
  { deviceId: 'laptop', name: 'Laptop', online: false, isSelf: false, controlEnabled: true, remoteControlEnabled: true },
] }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ dataOwnerId: h.owner.dataOwnerId, isAuthenticated: true }) }));
vi.mock('@/contexts/dataOwnerGeneration', () => ({ getDataOwnerGeneration: () => h.owner,
  isDataOwnerGenerationCurrent: (owner: unknown) => owner === h.owner, isDataOwnerPushCurrent: () => true }));
vi.mock('@/features/device-link/useDeviceLinkDeviceList', () => ({ useDeviceLinkDeviceList: () => h.devices }));
vi.mock('@/features/bots/botReadState', () => ({ acknowledgeRemoteBotRead: vi.fn(), getBotReadStateSyncStatus: () => ({ phase: 'ready', corruptSources: [] }),
  getRemoteBotReadAt: () => 0, seedRemoteBotReadState: vi.fn(), subscribeBotReadState: () => () => undefined }));
vi.mock('../../../../main/appSessionState', () => ({ getActiveAppSession: () => h.owner,
  isAppSessionBoundaryPending: () => false, ownerScopedUserDataPath: (...parts: string[]) => path.join(h.cacheRoot, ...parts) }));
vi.mock('../../../../main/clientEndpointsService', () => ({ getClientEndpoint: () => 'https://chat.example.test' }));
import { useRemoteBotSync, useRemoteBots, readRemoteBots } from '../useRemoteBots';
import { resetCompanionCloudStoreForTests, useCompanionCloud, refreshCompanionCloudSettled } from '../companionCloudStore';
import { cloudRemoteBots } from '../companionCloudPresentation';
import { companionHomes, companionSnapshot } from '../../../../main/companion-cloud/homes';
import { accessChatDisplayCache } from '../../../../main/maker-ipc/chatDisplayCache';
const row = { id: 'mia', deviceId: 'laptop', deviceName: 'Laptop', name: 'Mia', avatar: '', avatarColor: 'violet',
  description: '', preview: '', activityAt: 0, sessionId: null, online: false, connectionKnown: true };
const old: CompanionCloudSnapshot = { enabled: true, selfDeviceId: 'desk', humanActorId: 'human', demotedBotIds: [],
  actors: [{ id: 'actor-mia', externalId: 'mia', name: 'Mia', avatar: null, homeDeviceId: 'laptop' }] };
let saved: unknown;
let fresh: CompanionCloudSnapshot;
let writes: number;
function view() { useRemoteBotSync(); const cloud = useCompanionCloud(); return cloudRemoteBots(cloud, useRemoteBots()); }
beforeEach(() => {
  h.owner = { dataOwnerId: `roster-${h.owner.generation}`, generation: h.owner.generation + 1 };
  localStorage.clear(); saved = old; fresh = { ...old, actors: [] }; writes = 0;
  window.electronAPI = { maker: { getCompanionCloudState: async () => fresh, onCompanionCloudChanged: () => () => undefined,
    listCindyCopies: async () => [], chatDisplayCache: async (request: { action: string; key: string; value?: unknown }) => {
      if (request.key !== 'cloud-homes') return null;
      if (request.action === 'read') return saved;
      if (request.action === 'write') { saved = request.value; writes += 1; }
      return null;
    } }, deviceLink: { getState: async () => ({ linkStatus: 'offline' }), onStatusChanged: () => () => undefined,
      onRemotePush: () => () => undefined, invoke: vi.fn() } } as never;
  resetCompanionCloudStoreForTests();
});
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); companionHomes.reset();
  if (h.cacheRoot) { rmSync(h.cacheRoot, { recursive: true, force: true }); h.cacheRoot = ''; } });
// #9760 upgrade: old clients have already saved an empty cloud roster, so only
// the real Main projection's disabled identity can distinguish Mia from a device-only bot.
it('cleans an already-deleted offline row when upgrading from an empty cloud cache', async () => {
  saved = { ...old, actors: [] };
  fresh = companionSnapshot({ enabled: true, selfDeviceId: 'desk', humanActorId: 'human', actors: [
    { id: 'actor-mia', kind: 'bot', externalId: 'mia', name: 'Mia', disabled: true },
  ] });
  localStorage.setItem(`cindy.remoteBots.v1.${h.owner.dataOwnerId}`, JSON.stringify([row, { ...row, id: 'ordinary' }]));
  const probe = renderHook(view);
  await waitFor(() => expect(writes).toBeGreaterThan(0));
  expect(probe.result.current.map(bot => bot.id)).toEqual(['ordinary']);
  expect(readRemoteBots().map(bot => bot.id)).toEqual(['ordinary']);
  expect(saved).toMatchObject({ retiredBotIds: ['mia'] });
});

// A corrupt display cache must not disable the working live registry. It may
// postpone cache-dependent writes, but both pull and push still update the view.
it('keeps refresh and pushes live while the display cache is unreadable', async () => {
  let push!: (next: CompanionCloudSnapshot) => void;
  const cache = vi.fn(async (_request: { action: string }) => { throw new SyntaxError('invalid JSON'); });
  window.electronAPI.maker.chatDisplayCache = cache as never;
  window.electronAPI.maker.onCompanionCloudChanged = ((fn: typeof push) => { push = fn; return () => undefined; }) as never;
  fresh = old;
  const cloud = vi.spyOn(window.electronAPI.maker, 'getCompanionCloudState');
  const probe = renderHook(() => useCompanionCloud());
  await waitFor(() => expect(probe.result.current.actors.map(actor => actor.externalId)).toEqual(['mia']));
  await act(async () => refreshCompanionCloudSettled());
  expect(cloud).toHaveBeenCalledTimes(2);
  act(() => push({ ...old, actors: [{ ...old.actors[0]!, externalId: 'bo' }] }));
  await waitFor(() => expect(probe.result.current.actors.map(actor => actor.externalId)).toEqual(['bo']));
  expect(cache.mock.calls.every(args => (args[0] as { action: string }).action === 'read')).toBe(true);
});

// Controlled real write ordering: Main commits the first snapshot before its
// acknowledgement arrives. Later live decisions must be reconfirmed, not lost.
it.each(['revive', 'delete-bo'])('reconciles a late deletion receipt with the latest roster (%s)', async change => {
  const bo = { ...old.actors[0]!, id: 'actor-bo', externalId: 'bo', name: 'Bo' };
  const initial = { ...old, actors: [...old.actors, bo] };
  let finish!: () => void;
  let attempts = 0;
  h.cacheRoot = mkdtempSync(path.join(tmpdir(), 'cindy-9760-roster-'));
  const request = { owner: h.owner, key: 'cloud-homes' };
  const seed = accessChatDisplayCache({ ...request, action: 'read' }) as { retirementRevision: number };
  accessChatDisplayCache({ ...request, action: 'write', value: { ...initial, ...seed } });
  fresh = { ...old, actors: [bo] };
  const cloud = vi.spyOn(window.electronAPI.maker, 'getCompanionCloudState');
  window.electronAPI.maker.chatDisplayCache = (async (request: { action: string; key: string; value?: unknown }) => {
    if (request.key !== 'cloud-homes') return null;
    if (request.action === 'read') return accessChatDisplayCache(request);
    if (request.action !== 'write') return null;
    const receipt = accessChatDisplayCache(request);
    saved = accessChatDisplayCache({ ...request, action: 'read' });
    if (++attempts === 1) return new Promise(resolve => { finish = () => resolve(receipt); });
    return receipt;
  }) as never;
  localStorage.setItem(`cindy.remoteBots.v1.${h.owner.dataOwnerId}`, JSON.stringify([row, { ...row, id: 'bo' }]));
  const probe = renderHook(view);
  await waitFor(() => expect(attempts).toBe(1));
  fresh = change === 'revive' ? initial : { ...old, actors: [] };
  await act(async () => refreshCompanionCloudSettled());
  await act(async () => finish());
  await waitFor(() => expect(saved).toMatchObject({ retiredBotIds: change === 'revive' ? [] : ['mia', 'bo'] }));
  expect(cloud.mock.calls.length).toBeGreaterThanOrEqual(3);
  expect(probe.result.current.map(bot => bot.id).sort()).toEqual(change === 'revive' ? ['bo', 'mia'] : []);
  probe.unmount();
  resetCompanionCloudStoreForTests();
  cloud.mockRejectedValue(new Error('offline after restart'));
  const restarted = renderHook(view);
  await waitFor(() => expect(restarted.result.current.map(bot => bot.id).sort()).toEqual(change === 'revive' ? ['bo', 'mia'] : []));
});
it('removes a deleted offline identity from visible rows, non-hook routing and durable roster', async () => {
  localStorage.setItem(`cindy.remoteBots.v1.${h.owner.dataOwnerId}`, JSON.stringify([row, { ...row, id: 'ordinary' }]));
  const probe = renderHook(view);
  await waitFor(() => expect(writes).toBeGreaterThan(0));
  await waitFor(() => expect(probe.result.current.map(bot => bot.id)).toEqual(['ordinary']));
  expect(readRemoteBots().map(bot => bot.id)).toEqual(['ordinary']);
  expect(JSON.parse(localStorage.getItem(`cindy.remoteBots.v1.${h.owner.dataOwnerId}`)!).map((bot: { id: string }) => bot.id)).toEqual(['ordinary']);
});
it('loads persisted deletion after a mirror restart even with a stale actor in the saved roster', async () => {
  saved = { ...old, retiredBotIds: ['mia'] };
  localStorage.setItem(`cindy.remoteBots.v1.${h.owner.dataOwnerId}`, JSON.stringify([row]));
  const probe = renderHook(view);
  await waitFor(() => expect(writes).toBeGreaterThan(0));
  expect(probe.result.current).toEqual([]);
  expect(saved).toMatchObject({ retiredBotIds: ['mia'] });
});
it('restores a genuinely active cloud identity and clears retirement only for the current owner', async () => {
  saved = { ...old, actors: [], retiredBotIds: ['mia'] };
  const probe = renderHook(view);
  await waitFor(() => expect(writes).toBeGreaterThan(0));
  expect(probe.result.current).toEqual([]);
  fresh = old;
  await act(async () => refreshCompanionCloudSettled());
  expect(probe.result.current.map(bot => bot.id)).toEqual(['mia']);
  expect(saved).toMatchObject({ retiredBotIds: [], revivedBotIds: ['mia'] });
  h.owner = { dataOwnerId: 'other', generation: h.owner.generation + 1 };
  fresh = { ...old, actors: [] }; saved = null;
  probe.rerender();
  await act(async () => refreshCompanionCloudSettled());
  expect(probe.result.current).toEqual([]);
});

// #11303 failure recovery, unit tier: existing happy-path fixtures never rejected IPC.
// Live refresh/push survives a read failure. Only the cache-dependent deletion
// inference and write wait for hydration; recovery must still clean the old row.
it.each(['refresh', 'push'])('recovers cache persistence after a failed startup read and later %s', async source => {
  let reads = 0;
  let push!: (next: CompanionCloudSnapshot) => void;
  const cache = vi.fn(async (request: { action: string; key: string; value?: unknown }) => {
    if (request.key !== 'cloud-homes') return null;
    if (request.action === 'read') {
      if (++reads === 1) throw new Error('temporarily unreadable');
      return { ...old, retirementRevision: 1 };
    }
    saved = request.value;
    return { retiredBotIds: ['mia'], retirementRevision: 2 };
  });
  window.electronAPI.maker.chatDisplayCache = cache as never;
  window.electronAPI.maker.onCompanionCloudChanged = ((fn: typeof push) => { push = fn; return () => undefined; }) as never;
  const cloud = vi.spyOn(window.electronAPI.maker, 'getCompanionCloudState');
  await act(async () => refreshCompanionCloudSettled());
  expect(cloud).toHaveBeenCalledTimes(1);
  expect(cache.mock.calls.filter(([r]) => r.action === 'write')).toHaveLength(0);
  const probe = renderHook(() => useCompanionCloud());
  if (source === 'push') act(() => push(fresh));
  await waitFor(() => expect(saved).toMatchObject({ actors: [], newlyRetiredBotIds: ['mia'] }));
  expect(reads).toBe(2);
  expect(cloudRemoteBots(probe.result.current, [row])).toEqual([]);
});

it('retains a failed deletion delta until the next successful cache receipt', async () => {
  let attempts = 0;
  const cache = vi.fn(async (request: { action: string; key: string; value?: unknown }) => {
    if (request.key !== 'cloud-homes') return null;
    if (request.action === 'read') return { ...old, retirementRevision: 1 };
    if (++attempts === 1) throw new Error('temporarily unwritable');
    saved = request.value;
    return { retiredBotIds: ['mia'], retirementRevision: 2 };
  });
  window.electronAPI.maker.chatDisplayCache = cache as never;
  await act(async () => refreshCompanionCloudSettled());
  expect(attempts).toBe(1);
  await act(async () => refreshCompanionCloudSettled());
  expect(saved).toMatchObject({ actors: [], newlyRetiredBotIds: ['mia'] });
  await act(async () => refreshCompanionCloudSettled());
  expect(saved).toMatchObject({ retiredBotIds: ['mia'], newlyRetiredBotIds: [] });
});


it('clears a failed retirement after authoritative hydrate sees the identity active', async () => {
  let reads = 0;
  let writes = 0;
  let latest: unknown;
  const cache = vi.fn(async (request: { action: string; key: string; value?: unknown }) => {
    if (request.key !== 'cloud-homes') return null;
    if (request.action === 'read') {
      reads += 1;
      return reads === 1 ? { ...old, retirementRevision: 1 } : { ...old, retiredBotIds: [], retirementRevision: 3 };
    }
    if (request.action === 'write') {
      writes += 1;
      if (writes === 1) throw new Error('stale fence');
      latest = request.value;
      return { retiredBotIds: [], retirementRevision: 4 };
    }
    return null;
  });
  window.electronAPI.maker.chatDisplayCache = cache as never;
  window.electronAPI.maker.getCompanionCloudState = vi.fn()
    .mockResolvedValueOnce(fresh)
    .mockResolvedValue(old);
  const probe = renderHook(view);
  await waitFor(() => expect(writes).toBe(1));
  await act(async () => refreshCompanionCloudSettled());
  await waitFor(() => expect(writes).toBe(2));
  expect(latest).toMatchObject({ retiredBotIds: [], newlyRetiredBotIds: [] });
  expect(probe.result.current.map(bot => bot.id)).toEqual(['mia']);
  probe.unmount();
});

// A slow write is not a failure: keep one latest queued snapshot, and do not
// acknowledge a newer removal with the older write's receipt.
it('coalesces updates behind a slow receipt while preserving a newer deletion', async () => {
  let revision = 1;
  let finish!: (value: unknown) => void;
  const cache = vi.fn((request: { action: string; key: string; value?: unknown }) => {
    if (request.key !== 'cloud-homes') return Promise.resolve(null);
    if (request.action === 'read') return Promise.resolve({ ...old, retirementRevision: revision });
    saved = request.value;
    return new Promise(resolve => { finish = resolve; });
  });
  window.electronAPI.maker.chatDisplayCache = cache as never;
  await act(async () => refreshCompanionCloudSettled());
  const first = finish;
  fresh = old;
  await act(async () => refreshCompanionCloudSettled());
  fresh = { ...old, actors: [] };
  await act(async () => refreshCompanionCloudSettled());
  expect(cache.mock.calls.filter(([r]) => r.action === 'write')).toHaveLength(1);
  revision = 2;
  await act(async () => first({ retiredBotIds: ['mia'], retirementRevision: 2 }));
  // No external update is needed to reconfirm and save the queued deletion.
  await waitFor(() => expect(saved).toMatchObject({ actors: [], newlyRetiredBotIds: ['mia'], retirementRevision: 2 }));
  expect(cache.mock.calls.filter(([r]) => r.action === 'write')).toHaveLength(2);
  await act(async () => finish({ retiredBotIds: ['mia'], retirementRevision: 3 }));
  await act(async () => refreshCompanionCloudSettled());
  expect(saved).toMatchObject({ newlyRetiredBotIds: [] });
  await act(async () => finish({ retiredBotIds: ['mia'], retirementRevision: 3 }));
});

// A receipt can contain a deletion from another window. A revival already queued
// against the old fence must not gain permission from that newer receipt.
it('does not rebase a queued revival onto a newly learned retirement revision', async () => {
  let revision = 1;
  let finish!: (value: unknown) => void;
  const cache = vi.fn((request: { action: string; key: string; value?: unknown }) => {
    if (request.key !== 'cloud-homes') return Promise.resolve(null);
    if (request.action === 'read') return Promise.resolve({ ...old, actors: [], retiredBotIds: ['mia'], retirementRevision: revision });
    saved = request.value;
    return new Promise(resolve => { finish = resolve; });
  });
  window.electronAPI.maker.chatDisplayCache = cache as never;
  await act(async () => refreshCompanionCloudSettled());
  const first = finish;
  fresh = old;
  await act(async () => refreshCompanionCloudSettled());
  // Another window's deletion is also in the latest authoritative roster.
  // The recovery read must observe it rather than replaying the older revival.
  fresh = { ...old, actors: [] };
  revision = 2;
  await act(async () => first({ retiredBotIds: ['mia'], retirementRevision: 2 }));
  expect(saved).toMatchObject({ revivedBotIds: [], retirementRevision: 2 });
  await act(async () => finish({ retiredBotIds: ['mia'], retirementRevision: 2 }));
});

// A rejected old deletion needs both a new cache fence and a fresh cloud answer.
// Merely replaying the old intent at the returned version would hide a revival.
it.each([true, false])('reconfirms a rejected deletion against a fresh roster (active=%s)', async active => {
  let reads = 0;
  let attempts = 0;
  const cache = vi.fn(async (request: { action: string; key: string; value?: unknown }) => {
    if (request.key !== 'cloud-homes') return null;
    if (request.action === 'read') return { ...old, retirementRevision: ++reads };
    if (++attempts === 1) throw new Error('PRECONDITION_FAILED: newer identity decision');
    saved = request.value;
    return { retiredBotIds: active ? [] : ['mia'], retirementRevision: 3 };
  });
  window.electronAPI.maker.chatDisplayCache = cache as never;
  await act(async () => refreshCompanionCloudSettled());
  expect(attempts).toBe(1);
  expect(reads).toBe(1);
  fresh = active ? old : { ...old, actors: [] };
  await act(async () => refreshCompanionCloudSettled());
  expect(reads).toBe(2);
  expect(saved).toMatchObject({ actors: fresh.actors, newlyRetiredBotIds: active ? [] : ['mia'], retirementRevision: 2 });
});

// #11303 / discussion_r4643468709: unit tier, real registry + cache + renderer.
// Earlier late-ACK tests commit the first deletion before revival and let one
// renderer observe both. A hydrating window instead coalesces those pushes,
// while a second window can close with its earlier deletion still in transit.
// Minimal failure: same disk fence, delete -> register -> delayed old write.
it.each(['before registration', 'before live write', 'after live write'])(
  'keeps a coalesced re-registration durable with deletion committed %s', async order => {
    h.cacheRoot = mkdtempSync(path.join(tmpdir(), 'cindy-9760-precommit-'));
    const request = { owner: h.owner, key: 'cloud-homes' };
    companionHomes.update(old);
    const seed = accessChatDisplayCache({ ...request, action: 'read' }) as { retirementRevision: number };
    accessChatDisplayCache({ ...request, action: 'write', value: { ...old, ...seed } });
    let finishRead!: () => void;
    let push!: (next: CompanionCloudSnapshot) => void;
    let reads = 0;
    let liveWrites = 0;
    window.electronAPI.maker.getCompanionCloudState = async () => companionHomes.snapshot();
    window.electronAPI.maker.onCompanionCloudChanged = ((fn: typeof push) => { push = fn; return () => undefined; }) as never;
    window.electronAPI.maker.chatDisplayCache = (async (input: { action: string }) => {
      if (input.action === 'read' && ++reads === 1) {
        const cached = accessChatDisplayCache(input);
        return new Promise(resolve => { finishRead = () => resolve(cached); });
      }
      const result = accessChatDisplayCache(input);
      if (input.action === 'write') liveWrites += 1;
      return result;
    }) as never;
    const probe = renderHook(() => useCompanionCloud());
    await waitFor(() => expect(reads).toBe(1));
    const deleted = { ...old, actors: [], disabledBotIds: ['mia'] };
    const delayedDeletion = () => accessChatDisplayCache({ ...request, action: 'write',
      value: { ...deleted, newlyRetiredBotIds: ['mia'], retirementRevision: seed.retirementRevision } });
    act(() => { companionHomes.update(deleted); push(deleted); });
    if (order === 'before registration') delayedDeletion();
    act(() => { companionHomes.update(old); push(old); });
    // Re-registration is now Main's current source decision. A closed window's
    // earlier deletion must be rejected even if the disk fence has not changed.
    if (order === 'before live write') expect(delayedDeletion).toThrow('PRECONDITION_FAILED');
    await act(async () => finishRead());
    await waitFor(() => expect(liveWrites).toBe(1));
    if (order === 'after live write') expect(delayedDeletion).toThrow('PRECONDITION_FAILED');
    expect(accessChatDisplayCache({ ...request, action: 'read' })).toMatchObject({ actors: old.actors, retiredBotIds: [] });
    expect(probe.result.current.actors).toEqual(old.actors);
    probe.unmount();
    resetCompanionCloudStoreForTests();
    window.electronAPI.maker.getCompanionCloudState = async () => { throw new Error('offline after restart'); };
    const restarted = renderHook(() => useCompanionCloud());
    await waitFor(() => expect(restarted.result.current.actors).toEqual(old.actors));
  });
