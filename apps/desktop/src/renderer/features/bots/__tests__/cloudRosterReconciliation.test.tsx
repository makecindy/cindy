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
