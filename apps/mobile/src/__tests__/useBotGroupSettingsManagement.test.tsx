// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  generation: 1, enabled: true, revoked: new Set<string>(), online: true, listOnline: true, syncing: false, listError: null as string | null,
  targets: [{ deviceId: 'mac', deviceName: 'Mac' }, { deviceId: 'pc', deviceName: 'PC' }],
  items: [] as any[], listeners: new Set<(id: string, payload: any) => void>(),
  invoke: vi.fn(), openLink: vi.fn(async () => {}), epoch: 1,
}));
vi.mock('react-native', () => ({ AppState: {} }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { language: 'en' } }) }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ accountGeneration: h.generation }) }));
vi.mock('@/device-link/revokedDevicesStore', () => ({ useRevokedDevices: () => h.revoked }));
vi.mock('@/device-link/DeviceLinkContext', () => ({ useDeviceLink: () => ({
  invoke: h.invoke, openLink: h.openLink, status: 'online', connectionEpoch: h.epoch,
  getPresenceAvailability: () => h.online,
  onRemoteResourceChanged: onChanged,
}) }));
function onChanged(listener: (id: string, payload: any) => void) { h.listeners.add(listener); return () => h.listeners.delete(listener); }
vi.mock('@/session/useTeammateRoster', () => ({ useTeammateRoster: () => ({ groupTargets: h.targets, loading: h.syncing, error: h.listError, refresh: vi.fn() }) }));
vi.mock('@/session/useRemoteResourceList', () => ({ useRemoteResourceList: () => ({
  items: h.items, syncing: h.syncing, isOnline: () => h.online && h.listOnline, error: h.listError, refresh: vi.fn(),
}) }));

import { useBotGroupSettingsManagement } from '@/session/useBotGroupSettingsManagement';

const host = { deviceId: 'mac', deviceName: 'Mac' };
const row = (id = 'g1', target = host) => ({ host: target, item: { ref: { collectionId: 'bot-groups', kind: 'bot-group', id }, revision: 'v1' } });
const resource = (role = 'owner', extra: Record<string, unknown> = {}) => ({
  ref: { collectionId: 'bot-groups', kind: 'bot-group', id: 'g1' }, revision: 'v1', display: { title: 'Group' }, links: [],
  blocks: [{ id: 'chat', primitive: 'bot-group-chat', fallbackMarkdown: '', data: {
    id: 'g1', name: 'Group', serverBacked: true, supportsSettingsManagement: true, revision: 4,
    members: [{ botId: 'bot', name: 'Bot', isOwned: true, role, status: 'active' }],
    messages: [], plans: [], round: { status: 'idle', speakers: [], canContinue: false }, ...extra,
  } }],
});
let root: Root | undefined;
let result: ReturnType<typeof useBotGroupSettingsManagement>;
function Probe() { result = useBotGroupSettingsManagement('g1', h.enabled); return null; }
async function render() { root ??= createRoot(document.createElement('div')); await act(async () => root!.render(createElement(Probe))); }
const reads = () => h.invoke.mock.calls.filter(call => call[1] === 'maker:remote-resources:get');
const writes = () => h.invoke.mock.calls.filter(call => call[1] === 'maker:remote-resources:invoke');
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
beforeEach(() => {
  vi.clearAllMocks(); h.enabled = true; h.generation = 1; h.epoch = 1; h.online = true; h.syncing = false; h.revoked = new Set(); h.listeners.clear();
  h.listOnline = true; h.listError = null;
  h.targets = [{ deviceId: 'mac', deviceName: 'Mac' }];
  h.items = [row()]; h.openLink.mockResolvedValue();
  h.invoke.mockImplementation(async (_id, channel) => channel === 'maker:remote-resources:get' ? resource() : { effects: [] });
});
afterEach(() => { act(() => root?.unmount()); root = undefined; });

it('reads the exact room and sends settings only to its verified host with a revision', async () => {
  h.targets.push({ deviceId: 'pc', deviceName: 'PC' });
  h.invoke.mockImplementation(async (id, channel) => channel === 'maker:remote-resources:get'
    ? resource('owner', id === 'pc' ? { id: 'other' } : {}) : { effects: [] });
  await render();
  expect(reads()).toHaveLength(2);
  expect(result.selected?.host.deviceId).toBe('mac');
  expect(result.reason).toBeNull();
  await act(async () => { await result.act('update', { name: 'New name' }); });
  expect(writes()[0]?.slice(0, 2)).toEqual(['mac', 'maker:remote-resources:invoke']);
  expect(writes()[0]?.[2][0]).toMatchObject({ actionId: 'update', resourceRef: { id: 'g1' }, input: { name: 'New name', expectedRevision: 4 } });
});

it('probes the exact room even when it is absent from a truncated group list', async () => {
  h.targets = [host];
  h.items = Array.from({ length: 200 }, (_, index) => row(`other-${index}`));
  await render();
  expect(reads()).toHaveLength(1);
  expect(reads()[0]?.[2][0].ref.id).toBe('g1');
  expect(result.selected?.host.deviceId).toBe('mac');
});

it('blocks consecutive edits until the successful write is read back with its new revision', async () => {
  await render();
  let revision = 4; let finishRead!: (value: unknown) => void;
  h.invoke.mockImplementation(async (_id, channel, args) => {
    if (channel === 'maker:remote-resources:get') return new Promise(resolve => { finishRead = resolve; });
    if (args[0].input.expectedRevision !== revision) throw new Error('PRECONDITION_FAILED');
    revision += 1;
    return { effects: [] };
  });
  await act(async () => {
    await result.act('update', { name: 'Renamed' });
    // Also exercise the interval before React commits the refreshed controls.
    await expect(result.act('update', { organizerBotId: 'bot' })).rejects.toThrow('PERMISSION_DENIED');
  });
  expect(writes()).toHaveLength(1); expect(result.selected).toBeUndefined(); expect(result.loading).toBe(true);
  await act(async () => { finishRead(resource('owner', { name: 'Renamed', revision })); });
  expect(result.selected?.group.revision).toBe(5);
  await act(async () => { await result.act('update', { organizerBotId: 'bot' }); });
  expect(writes()[1]?.[2][0].input.expectedRevision).toBe(5);
});

it('does not restore the pre-write revision from an already pending background read', async () => {
  await render(); const finishes: ((value: unknown) => void)[] = [];
  h.invoke.mockImplementation(async (_id, channel) => channel === 'maker:remote-resources:get'
    ? new Promise(resolve => { finishes.push(resolve); }) : { effects: [] });
  await act(async () => { result.refresh(); });
  await act(async () => { await result.act('update', { name: 'Renamed' }); });
  await act(async () => { finishes.shift()!(resource()); });
  expect(result.selected).toBeUndefined(); expect(finishes).toHaveLength(1);
  await expect(result.act('add-member', { botId: 'other' })).rejects.toThrow('PERMISSION_DENIED');
  await act(async () => { finishes.shift()!(resource('owner', { revision: 5, name: 'Renamed' })); });
  expect(result.selected?.group.revision).toBe(5); expect(writes()).toHaveLength(1);
});

it('keeps a confirmed save successful but disables further edits if readback fails', async () => {
  await render();
  h.invoke.mockImplementation(async (_id, channel) => {
    if (channel === 'maker:remote-resources:get') throw new Error('Read failed');
    return { effects: [] };
  });
  await act(async () => { await expect(result.act('update', { name: 'Renamed' })).resolves.toEqual({ effects: [] }); });
  expect(result.selected).toBeUndefined(); expect(result.reason).toBe('unavailable');
  await expect(result.act('add-member', { botId: 'other' })).rejects.toThrow('PERMISSION_DENIED');
  h.invoke.mockResolvedValue(resource('owner', { revision: 5 }));
  await act(async () => { result.refresh(); });
  expect(result.selected?.group.revision).toBe(5); expect(writes()).toHaveLength(1);
});

it.each(['member', 'guest'])('keeps %s read-only even on an online matching computer', async role => {
  h.invoke.mockResolvedValue(resource(role)); await render();
  expect(result.selected).toBeUndefined(); expect(result.reason).toBe('permission');
  await expect(result.act('update', { name: 'Denied' })).rejects.toThrow('PERMISSION_DENIED'); expect(writes()).toHaveLength(0);
});

it.each([{ supportsSettingsManagement: false }, { revision: undefined }, { archived: true }, { members: [{ botId: 'foreign', name: 'Foreign', role: 'owner', isOwned: false }] }])('does not grant management for an unsupported or unauthorized projection: %j', async extra => {
  h.invoke.mockResolvedValue(resource('owner', extra)); await render(); expect(result.selected).toBeUndefined();
});

it('never uses offline or revoked cached rows as authority', async () => {
  h.online = false; await render(); expect(reads()).toHaveLength(0); expect(result.selected).toBeUndefined();
  h.online = true; h.revoked = new Set(['mac']); await render(); expect(reads()).toHaveLength(0);
});

it('allows choosing among multiple independently verified computers', async () => {
  h.targets.push({ deviceId: 'pc', deviceName: 'PC' });
  h.items = [row(), row('g1', h.targets[1])]; await render(); expect(result.managers).toHaveLength(2);
  await act(async () => { result.select('pc'); });
  await act(async () => { await result.act('add-member', { botId: 'local-pc-bot' }); });
  expect(writes()[0]?.[0]).toBe('pc');
});

it('does not send a write if the account changes while opening its link', async () => {
  await render(); let finish!: () => void;
  h.openLink.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  let pending!: Promise<unknown>; await act(async () => { pending = result.act('update', { name: 'Late' }); });
  h.generation = 2; h.enabled = false; await render(); finish();
  await expect(pending).rejects.toThrow('PERMISSION_DENIED'); expect(writes()).toHaveLength(0);
});

it('ignores a late read after closing settings', async () => {
  let finish!: (value: unknown) => void;
  h.invoke.mockImplementation(() => new Promise(resolve => { finish = resolve; })); await render();
  h.enabled = false; await render(); await act(async () => { finish(resource()); });
  expect(result.selected).toBeUndefined(); expect(writes()).toHaveLength(0);
});

it('preserves the revision of a name draft when sending it', async () => {
  await render(); await act(async () => { await result.act('update', { name: 'Draft', expectedRevision: 2 }); });
  expect(writes()[0]?.[2][0].input.expectedRevision).toBe(2);
});

it('disables a previously verified computer when presence goes offline', async () => {
  await render(); expect(result.selected).toBeDefined();
  h.online = false; await render(); expect(result.selected).toBeUndefined();
  await expect(result.act('update')).rejects.toThrow('PERMISSION_DENIED');
});

it('keeps the selected device name through reconnecting without retaining write authority', async () => {
  h.targets.push({ deviceId: 'pc', deviceName: 'PC' });
  h.items = [row(), row('g1', h.targets[1])]; await render();
  await act(async () => { result.select('pc'); });
  h.online = false; h.items = []; await render();
  expect(result.displayHost?.deviceName).toBe('PC');
  expect(result.selected).toBeUndefined();
  await expect(result.act('update')).rejects.toThrow('PERMISSION_DENIED');
  h.enabled = false; await render(); h.enabled = true; h.syncing = true; await render();
  expect(result.loading).toBe(true);
  expect(result.displayHost?.deviceName).toBe('PC');
  h.generation = 2; await render();
  expect(result.displayHost).toBeUndefined();
});

it('does not reuse the previous authorization while a reopened sheet is being verified', async () => {
  await render(); h.enabled = false; await render();
  let finish!: (value: unknown) => void;
  h.invoke.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  h.enabled = true; await render();
  expect(result.loading).toBe(true); expect(result.selected).toBeUndefined();
  await act(async () => { finish(resource('member')); });
  expect(result.selected).toBeUndefined(); expect(result.reason).toBe('permission');
});

it('rejects a receipt from an earlier opening of the same sheet', async () => {
  await render(); let finish!: (value: unknown) => void;
  h.invoke.mockImplementation(async (_id, channel) => channel === 'maker:remote-resources:invoke'
    ? new Promise(resolve => { finish = resolve; }) : resource());
  let pending!: Promise<unknown>;
  await act(async () => { pending = result.act('update', { name: 'Late' }); });
  h.enabled = false; await render(); h.enabled = true; await render();
  await act(async () => { finish({ effects: [] }); await expect(pending).rejects.toThrow('PERMISSION_DENIED'); });
});

it('checks the sheet identity again when a queued write actually leaves the transport', async () => {
  await render(); let send!: () => void; let sent = false;
  h.invoke.mockImplementation(async (_id, channel, _args, opts) => channel === 'maker:remote-resources:invoke'
    ? new Promise((resolve, reject) => { send = () => { try { opts?.preSend?.(); sent = true; resolve({ effects: [] }); } catch (error) { reject(error); } }; }) : resource());
  let pending!: Promise<unknown>;
  await act(async () => { pending = result.act('update', { name: 'Queued' }); });
  h.enabled = false; await render(); h.enabled = true; await render();
  await act(async () => { send(); await expect(pending).rejects.toThrow('PERMISSION_DENIED'); });
  expect(sent).toBe(false);
  expect(writes()[0]?.[3]?.preSend).toBeTypeOf('function');
});

it.each(['reading', 'refreshed'])('keeps a queued write authorized through a content refresh (%s)', async phase => {
  await render(); let send!: () => void; let finishRead!: (value: unknown) => void;
  h.invoke.mockImplementation(async (_id, channel, _args, opts) => channel === 'maker:remote-resources:invoke'
    ? new Promise((resolve, reject) => { send = () => { try { opts?.preSend?.(); resolve({ effects: [] }); } catch (error) { reject(error); } }; })
    : new Promise(resolve => { finishRead = resolve; }));
  let pending!: Promise<unknown>;
  await act(async () => { pending = result.act('update', { name: 'Queued' }); });
  h.syncing = true; await render();
  if (phase === 'refreshed') {
    h.items = [{ ...row(), item: { ...row().item, revision: 'v2' } }];
    h.syncing = false; await render();
    await act(async () => { result.refresh(); });
    await act(async () => { finishRead(resource()); });
  }
  await act(async () => { send(); await expect(pending).resolves.toEqual({ effects: [] }); });
  expect(writes()[0]?.[2][0].input.expectedRevision).toBe(4);
});

it.each(['permission', 'revoked', 'host removed', 'room removed', 'offline', 'epoch'])('rejects a queued write after authorization changes: %s', async change => {
  await render(); let send!: () => void;
  h.invoke.mockImplementation(async (_id, channel, _args, opts) => channel === 'maker:remote-resources:invoke'
    ? new Promise((resolve, reject) => { send = () => { try { opts?.preSend?.(); resolve({ effects: [] }); } catch (error) { reject(error); } }; })
    : change === 'room removed' ? null : resource(change === 'permission' ? 'member' : 'owner'));
  let pending!: Promise<unknown>;
  await act(async () => { pending = result.act('update', { name: 'Denied' }); });
  if (change === 'permission') await act(async () => { result.refresh(); });
  if (change === 'revoked') h.revoked = new Set(['mac']);
  if (change === 'host removed') h.targets = h.targets.filter(target => target.deviceId !== 'mac');
  if (change === 'room removed') await act(async () => { result.refresh(); });
  if (change === 'offline') h.online = false;
  if (change === 'epoch') h.epoch += 1;
  await render();
  await act(async () => { send(); await expect(pending).rejects.toThrow('PERMISSION_DENIED'); });
});

it('coalesces refreshes while an earlier detail read is still in flight', async () => {
  const finishes: ((value: unknown) => void)[] = [];
  h.invoke.mockImplementation(() => new Promise(resolve => { finishes.push(resolve); }));
  await render(); expect(reads()).toHaveLength(1);
  h.syncing = true; await render(); h.syncing = false; await render();
  await act(async () => { result.refresh(); result.refresh(); });
  expect(reads()).toHaveLength(1);
  await act(async () => { finishes.shift()!(resource()); });
  expect(reads()).toHaveLength(2);
  await act(async () => { finishes.shift()!(resource()); });
  expect(result.selected).toBeDefined(); expect(result.loading).toBe(false);
});

it('distinguishes a failed online roster read from a disconnected computer', async () => {
  h.listError = 'Read failed'; h.invoke.mockRejectedValue(new Error('Read failed')); await render();
  expect(result.reason).toBe('unavailable'); expect(result.selected).toBeUndefined();
  h.online = false; await render(); expect(result.reason).toBe('noHost');
});
