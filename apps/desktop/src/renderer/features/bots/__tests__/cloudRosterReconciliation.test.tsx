// @vitest-environment jsdom
// #9760: unit tier, real cloud store + remote sync + projection. The existing suites
// mock one another; this fixture exercises their shared lifecycle without native accounts.
// Minimal failure: an authoritative empty roster arrives while a deleted bot's host is offline.
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CompanionCloudSnapshot } from '../../../../shared/companionCloud';
const h = vi.hoisted(() => ({ owner: { dataOwnerId: 'roster-owner', generation: 1 }, devices: [
  { deviceId: 'laptop', name: 'Laptop', online: false, isSelf: false, controlEnabled: true, remoteControlEnabled: true },
] }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ dataOwnerId: h.owner.dataOwnerId, isAuthenticated: true }) }));
vi.mock('@/contexts/dataOwnerGeneration', () => ({ getDataOwnerGeneration: () => h.owner,
  isDataOwnerGenerationCurrent: (owner: unknown) => owner === h.owner, isDataOwnerPushCurrent: () => true }));
vi.mock('@/features/device-link/useDeviceLinkDeviceList', () => ({ useDeviceLinkDeviceList: () => h.devices }));
vi.mock('@/features/bots/botReadState', () => ({ acknowledgeRemoteBotRead: vi.fn(), getBotReadStateSyncStatus: () => ({ phase: 'ready', corruptSources: [] }),
  getRemoteBotReadAt: () => 0, seedRemoteBotReadState: vi.fn(), subscribeBotReadState: () => () => undefined }));
import { useRemoteBotSync, useRemoteBots, readRemoteBots } from '../useRemoteBots';
import { resetCompanionCloudStoreForTests, useCompanionCloud, refreshCompanionCloudSettled } from '../companionCloudStore';
import { cloudRemoteBots } from '../companionCloudPresentation';
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
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });
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
// Production refresh/push must wait for successful hydration; a failed deletion write
// must resend its unacknowledged delta on the next update, not resurrect the offline row.
it.each(['refresh', 'push'])('recovers a failed startup read before accepting a later %s', async source => {
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
  expect(cloud).not.toHaveBeenCalled();
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
  expect(cache.mock.calls.filter(([r]) => r.action === 'write')).toHaveLength(1);
  await act(async () => refreshCompanionCloudSettled());
  expect(saved).toMatchObject({ actors: [], newlyRetiredBotIds: ['mia'], retirementRevision: 2 });
  expect(cache.mock.calls.filter(([r]) => r.action === 'write')).toHaveLength(2);
  await act(async () => finish({ retiredBotIds: ['mia'], retirementRevision: 3 }));
  await act(async () => refreshCompanionCloudSettled());
  expect(saved).toMatchObject({ newlyRetiredBotIds: [] });
  await act(async () => finish({ retiredBotIds: ['mia'], retirementRevision: 3 }));
});

// A receipt can contain a deletion from another window. A revival already queued
// against the old fence must not gain permission from that newer receipt.
it('does not rebase a queued revival onto a newly learned retirement revision', async () => {
  let finish!: (value: unknown) => void;
  const cache = vi.fn((request: { action: string; key: string; value?: unknown }) => {
    if (request.key !== 'cloud-homes') return Promise.resolve(null);
    if (request.action === 'read') return Promise.resolve({ ...old, actors: [], retiredBotIds: ['mia'], retirementRevision: 1 });
    saved = request.value;
    return new Promise(resolve => { finish = resolve; });
  });
  window.electronAPI.maker.chatDisplayCache = cache as never;
  await act(async () => refreshCompanionCloudSettled());
  const first = finish;
  fresh = old;
  await act(async () => refreshCompanionCloudSettled());
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
