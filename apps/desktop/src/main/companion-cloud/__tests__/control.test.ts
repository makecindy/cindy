import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DeviceLinkDeviceView } from '../../../shared/deviceLinkIpc.js';
import { createCompanionHomeRegistry } from '../homes.js';
import { readTranscriptPage } from '../room.js';
import { startCompanionCloud, type CompanionCloudHost, type CompanionCloudRuntime, type CompanionRuntimeActor } from '../runtime.js';
import { fakeApi, fakeLocal, memoryState, rejection, type ApiHandler } from './fakes.js';

const ROOM = '10000000-0000-4000-8000-000000000001';
const device = (deviceId: string, extra: Partial<DeviceLinkDeviceView> = {}): DeviceLinkDeviceView => ({
  deviceId, name: deviceId, platform: 'darwin', appVersion: '1', lastSeenAt: null, online: true, busy: false,
  remoteControlEnabled: true, controlEnabled: true, isSelf: false, ...extra,
});

// A complete profile snapshot as the home uploads it.
const MIA = { name: 'Mia', description: '', soul: '', systemPrompt: '', user: '' };

let runtime: CompanionCloudRuntime | undefined;
afterEach(() => { runtime?.dispose(); runtime = undefined; });

function setup(options: { home: string | null; handler?: ApiHandler; devices?: DeviceLinkDeviceView[]; profiles?: string[];
  installationId?: string; probe?: (deviceId: string) => Promise<boolean>; values?: Array<{ key: string; value: unknown }>;
  readValues?: () => Promise<Array<{ key: string; value: unknown }>>; syncProfile?: (botId: string) => Promise<void>;
  turnActive?: () => boolean; homeLink?: CompanionCloudHost['homeLink']; stopBotTurns?: CompanionCloudHost['stopBotTurns'];
  canonicalSession?: CompanionCloudHost['canonicalSession']; paused?: (botId: string) => boolean; savedState?: string }) {
  const actors: CompanionRuntimeActor[] = [{ id: 'actor-1', kind: 'bot', externalId: 'bot_mia', name: 'Mia', avatar: null, homeDeviceId: options.home }];
  const { api, calls } = fakeApi(options.handler ?? ((route, method) => {
    // The home has uploaded the profile snapshot a take-over builds from.
    if (route === '/preferences') return method === 'GET' ? [{ key: 'companion.profile.v1', value: MIA, revision: 1 }] : { revision: 1 };
    if (route === '/conversations') return { id: ROOM };
    if (route.includes('/messages?')) return [];
    if (route.endsWith('/import')) return {};
    if (method === 'PATCH') return {};
    throw new Error(`unexpected ${method} ${route}`);
  }));
  const local = fakeLocal();
  const { state, files } = memoryState(options.savedState);
  const refresh = vi.fn(async () => undefined);
  const publish = vi.fn();
  const onShadowChanged = vi.fn();
  const host: CompanionCloudHost = {
    homes: createCompanionHomeRegistry(), openState: () => state,
    readValues: options.readValues ?? (async () => options.values ?? [{ key: 'companion.profile.v1', value: { name: 'Mia' } }]),
    canonicalSession: options.canonicalSession ?? (async () => 'session-1'), rowsAfter: async () => [], latestRows: async () => [],
    deliverToCanonical: async () => ({ ok: true }),
    materializer: local.host, listDevices: async () => options.devices ?? [],
    ...(options.installationId ? { installationId: () => options.installationId! } : {}),
    ...(options.probe ? { probeCompanionCloud: options.probe } : {}),
    ...(options.turnActive ? { isBotBusy: async () => options.turnActive!() } : {}),
    ...(options.homeLink ? { homeLink: options.homeLink } : {}),
    ...(options.stopBotTurns ? { stopBotTurns: options.stopBotTurns } : {}),
  };
  runtime = startCompanionCloud({ api, host, endpoint: 'https://chat', humanActorId: 'human', selfDeviceId: 'desk', current: () => true,
    bots: () => actors.filter(a => a.homeDeviceId === 'desk' && !state.isDemoted(a.externalId)).map(a => ({ botId: a.externalId, actorId: a.id, name: a.name })),
    actors: () => actors, refresh, publish, onShadowChanged, ...(options.syncProfile ? { syncProfile: options.syncProfile } : {}),
    ...(options.paused ? { paused: options.paused } : {}) });
  return { runtime, actors, calls, local, state, files, refresh, publish, onShadowChanged };
}

describe('private report recovery', () => {
  it('retries a failed local import into the canonical chat without duplicating the report or marking read', async () => {
    const report = { id: 'report-1', seq: '1', authorId: 'actor-1', origin: 'bot', createdAt: '2026-10-29T06:00:00Z', content: [{ type: 'text', text: 'A pending confirmation' }] };
    const t = setup({ home: 'desk', handler: route => {
      if (route === '/conversations') return { id: ROOM };
      if (route.includes('/messages?')) return [report];
      throw new Error(`Unexpected report route: ${route}`);
    } });
    vi.mocked(t.local.host.insertHistory).mockRejectedValueOnce(new Error('LOCAL_BUSY'));
    await expect(t.runtime.receivePrivateReport('bot_mia')).rejects.toThrow('LOCAL_BUSY');
    expect(await t.runtime.receivePrivateReport('bot_mia')).toBe(true);
    expect(await t.runtime.receivePrivateReport('bot_mia')).toBe(true);
    expect(t.local.rows).toHaveLength(1);
    expect(t.local.host.insertHistory).toHaveBeenLastCalledWith('session-1', expect.objectContaining({ role: 'assistant', text: 'A pending confirmation' }), expect.anything());
    expect(t.calls.some(call => call.route.endsWith('/read'))).toBe(false);
    t.actors[0]!.homeDeviceId = 'laptop';
    expect(await t.runtime.receivePrivateReport('bot_mia')).toBe(false);
  });
});

describe('take over', () => {
  it('moves the home with compare-and-set, then builds the local companion', async () => {
    const t = setup({ home: 'laptop' });
    expect(await t.runtime.takeOver('bot_mia')).toEqual({ ok: true });
    expect(t.calls.find(call => call.method === 'PATCH')).toMatchObject({ route: '/actors/actor-1', data: { homeDeviceId: 'desk', expectedHomeDeviceId: 'laptop' } });
    expect(t.actors[0]!.homeDeviceId).toBe('desk');
    expect(t.local.host.createProfile).toHaveBeenCalledOnce();
    expect(t.publish).toHaveBeenCalled();
  });

  it('tells what depends on the hidden copies when this one is hidden and again when it is lifted', async () => {
    const t = setup({ home: 'laptop' });
    expect(await t.runtime.takeOver('bot_mia')).toEqual({ ok: true });
    // Hidden while it is built, visible once the take-over completes: each change is announced once.
    expect(t.state.isDemoted('bot_mia')).toBe(false);
    expect(t.onShadowChanged).toHaveBeenCalledTimes(2);
  });

  it('does not move the home while the cloud has no profile snapshot', async () => {
    const t = setup({ home: 'laptop', handler: (route, method) => {
      if (route === '/preferences' && method === 'GET') return [];
      return {};
    } });
    expect(await t.runtime.takeOver('bot_mia')).toEqual({ ok: false, code: 'FAILED' });
    expect(t.calls.some(call => call.method === 'PATCH')).toBe(false);
    expect(t.local.host.createProfile).not.toHaveBeenCalled();
  });

  it('does not move the home for an incomplete profile snapshot', async () => {
    const t = setup({ home: 'laptop', handler: (route, method) => {
      if (route === '/preferences' && method === 'GET') return [{ key: 'companion.profile.v1', value: { name: 'Mia' }, revision: 1 }];
      return {};
    } });
    expect(await t.runtime.takeOver('bot_mia')).toEqual({ ok: false, code: 'FAILED' });
    expect(t.calls.some(call => call.method === 'PATCH')).toBe(false);
  });

  it('returns the current home when another device won', async () => {
    const t = setup({ home: 'laptop', handler: (route, method) => {
      if (method === 'PATCH') throw rejection(409, 'HOME_DEVICE_CONFLICT', { homeDeviceId: 'tablet' });
      return route === '/preferences' ? [{ key: 'companion.profile.v1', value: MIA, revision: 1 }] : [];
    } });
    expect(await t.runtime.takeOver('bot_mia')).toEqual({ ok: false, code: 'HOME_CONFLICT', homeDeviceId: 'tablet' });
    expect(t.refresh).toHaveBeenCalled();
    expect(t.local.host.createProfile).not.toHaveBeenCalled();
  });

  it('reports an unreachable server as offline', async () => {
    const t = setup({ home: 'laptop', handler: () => { throw Object.assign(new Error('REQUEST_TIMEOUT')); } });
    expect(await t.runtime.takeOver('bot_mia')).toEqual({ ok: false, code: 'OFFLINE' });
  });

  it('still compares with the server when the cached home already says this computer', async () => {
    const t = setup({ home: 'desk' });
    expect(await t.runtime.takeOver('bot_mia')).toEqual({ ok: true });
    expect(t.calls.filter(call => call.method === 'PATCH').map(call => call.data)).toEqual([{ homeDeviceId: 'desk', expectedHomeDeviceId: 'desk' }]);
  });
});

describe('reconcile', () => {
  it('demotes a local copy whose home is another computer', () => {
    const t = setup({ home: 'laptop' });
    t.runtime.reconcile([{ id: 'bot_mia', status: 'active' }]);
    expect(t.state.isDemoted('bot_mia')).toBe(true);
    expect(t.local.host.createProfile).not.toHaveBeenCalled();
  });

  it('materializes a companion handed to this computer once, and not a companion deleted here', async () => {
    const t = setup({ home: 'desk' });
    t.local.setProfile({ status: 'active', displayName: 'Mia', description: '' });
    t.state.update('bot_mia', 'actor-1', entry => { entry.demoted = true; });
    t.runtime.reconcile([{ id: 'bot_mia', status: 'active' }]);
    t.runtime.reconcile([{ id: 'bot_mia', status: 'active' }]);
    await vi.waitFor(() => expect(t.state.isDemoted('bot_mia')).toBe(false));
    expect(t.local.host.updateProfile).toHaveBeenCalledOnce();
    t.runtime.dispose();

    const deleted = setup({ home: 'desk' });
    deleted.state.update('bot_mia', 'actor-1', entry => { entry.mirror = { sessionId: 's', createdAt: 1, id: 'x' }; });
    deleted.runtime.reconcile([]);
    await Promise.resolve();
    expect(deleted.local.host.createProfile).not.toHaveBeenCalled();
  });

  it('builds a companion this computer never had when it is handed here', async () => {
    const t = setup({ home: 'desk' });
    t.runtime.reconcile([]);
    await vi.waitFor(() => expect(t.local.host.createProfile).toHaveBeenCalledOnce());
  });
});

describe('transfer', () => {
  it('flushes uploads and the mirror before moving the home, then demotes locally', async () => {
    const t = setup({ home: 'desk', devices: [device('laptop')] });
    expect(await t.runtime.transfer('bot_mia', 'laptop')).toEqual({ ok: true });
    const order = t.calls.map(call => `${call.method} ${call.route}`);
    const patch = order.indexOf('PATCH /actors/actor-1');
    const conversation = order.lastIndexOf('POST /conversations');
    const upload = order.lastIndexOf('GET /preferences');
    expect(conversation).toBeGreaterThanOrEqual(0);
    // Values are synced last, so edits made while the backlog drains still reach the server.
    expect(upload).toBeGreaterThan(conversation);
    expect(upload).toBeLessThan(patch);
    expect(t.calls[patch]!.data).toEqual({ homeDeviceId: 'laptop', expectedHomeDeviceId: 'desk' });
    expect(t.state.isDemoted('bot_mia')).toBe(true);
    expect(t.actors[0]!.homeDeviceId).toBe('laptop');
  });

  it.each([
    ['unknown', []],
    ['offline', [device('laptop', { online: false })]],
    ['remote control off', [device('laptop', { remoteControlEnabled: false })]],
    ['a phone', [device('laptop', { platform: 'ios' })]],
  ])('rejects a target that is %s without touching the home', async (_name, devices) => {
    const t = setup({ home: 'desk', devices });
    expect(await t.runtime.transfer('bot_mia', 'laptop')).toEqual({ ok: false, code: 'TARGET_UNAVAILABLE' });
    expect(t.calls.some(call => call.method === 'PATCH')).toBe(false);
  });

  it('does not move the home when the flush cannot reach the server', async () => {
    const t = setup({ home: 'desk', devices: [device('laptop')], handler: (route, method) => {
      if (route === '/preferences' && method === 'GET') throw rejection(503, 'UNAVAILABLE');
      return {};
    } });
    expect(await t.runtime.transfer('bot_mia', 'laptop')).toEqual({ ok: false, code: 'OFFLINE' });
    expect(t.calls.some(call => call.method === 'PATCH')).toBe(false);
    expect(t.state.isDemoted('bot_mia')).toBe(false);
  });

  it('uploads again when the companion changed during the flush, and refuses while it keeps changing', async () => {
    // Changes once while the first pass uploads, then stays put: the move uses the newest value.
    let version = 0;
    const once = setup({ home: 'desk', devices: [device('laptop')], readValues: async () => {
      const current = [{ key: 'companion.profile.v1', value: { name: `Mia ${version}` } }];
      if (version < 1) version += 1;
      return current;
    } });
    expect(await once.runtime.transfer('bot_mia', 'laptop')).toEqual({ ok: true });
    const order = once.calls.map(call => `${call.method} ${call.route}`);
    expect(order.filter(entry => entry === 'POST /preferences')).toHaveLength(2);
    expect(order.lastIndexOf('POST /preferences')).toBeLessThan(order.indexOf('PATCH /actors/actor-1'));
    once.runtime.dispose();

    let tick = 0;
    const busy = setup({ home: 'desk', devices: [device('laptop')],
      readValues: async () => [{ key: 'companion.profile.v1', value: { name: `Mia ${tick++}` } }] });
    expect(await busy.runtime.transfer('bot_mia', 'laptop')).toEqual({ ok: false, code: 'FAILED' });
    expect(busy.calls.some(call => call.method === 'PATCH')).toBe(false);
  });

  it('waits for a background upload already in flight before flushing and moving the home', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>(resolve => { release = resolve; });
    let first = true;
    const t = setup({ home: 'desk', devices: [device('laptop')], readValues: async () => {
      if (first) { first = false; await held; }
      return [{ key: 'companion.profile.v1', value: MIA }];
    } });
    const background = t.runtime.syncNow();
    await new Promise(resolve => setTimeout(resolve, 0));
    const moved = t.runtime.transfer('bot_mia', 'laptop');
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(t.calls.some(call => call.method === 'PATCH')).toBe(false);
    release();
    await background;
    expect(await moved).toEqual({ ok: true });
    const order = t.calls.map(call => `${call.method} ${call.route}`);
    expect(order.lastIndexOf('GET /preferences')).toBeLessThan(order.indexOf('PATCH /actors/actor-1'));
  });

  it('publishes the actor name and avatar before moving the home, and stays put when that fails', async () => {
    const order: string[] = [];
    const t = setup({ home: 'desk', devices: [device('laptop')], syncProfile: async botId => { order.push(`profile:${botId}`); } });
    expect(await t.runtime.transfer('bot_mia', 'laptop')).toEqual({ ok: true });
    const patch = t.calls.findIndex(call => call.method === 'PATCH');
    expect(order).toEqual(['profile:bot_mia']);
    expect(patch).toBeGreaterThanOrEqual(0);
    t.runtime.dispose();

    const failing = setup({ home: 'desk', devices: [device('laptop')], syncProfile: async () => { throw new Error('AVATAR_UPLOAD_FAILED'); } });
    expect(await failing.runtime.transfer('bot_mia', 'laptop')).toEqual({ ok: false, code: 'FAILED' });
    expect(failing.calls.some(call => call.method === 'PATCH')).toBe(false);
    expect(failing.state.isDemoted('bot_mia')).toBe(false);
  });

  it('uploads an edit made while the name and avatar were being published, before moving the home', async () => {
    let values: Array<{ key: string; value: unknown }> = [{ key: 'companion.profile.v1', value: { name: 'Mia' } }];
    const t = setup({ home: 'desk', devices: [device('laptop')], readValues: async () => values,
      syncProfile: async () => { values = [...values, { key: 'companion.memory.v1:late.md', value: { content: 'saved meanwhile' } }]; } });
    expect(await t.runtime.transfer('bot_mia', 'laptop')).toEqual({ ok: true });
    const late = t.calls.findIndex(call => call.method === 'PUT' && String(call.route).includes('late.md')
      || (call.data as { key?: string } | undefined)?.key === 'companion.memory.v1:late.md');
    const patch = t.calls.findIndex(call => call.method === 'PATCH');
    expect(late).toBeGreaterThanOrEqual(0);
    expect(late).toBeLessThan(patch);
  });

  it('does not move the home while a turn is still running, checked before and after the flush', async () => {
    const busy = setup({ home: 'desk', devices: [device('laptop')], turnActive: () => true });
    expect(await busy.runtime.transfer('bot_mia', 'laptop')).toEqual({ ok: false, code: 'BUSY' });
    expect(busy.calls.some(call => call.method === 'PATCH')).toBe(false);
    busy.runtime.dispose();

    // A turn starts while the backlog is flushed.
    let checks = 0;
    const late = setup({ home: 'desk', devices: [device('laptop')], turnActive: () => ++checks > 1 });
    expect(await late.runtime.transfer('bot_mia', 'laptop')).toEqual({ ok: false, code: 'BUSY' });
    expect(late.calls.some(call => call.method === 'PATCH')).toBe(false);
    expect(late.state.isDemoted('bot_mia')).toBe(false);
  });

  it('does not move the home when a value is too large to upload', async () => {
    const t = setup({ home: 'desk', devices: [device('laptop')], values: [
      { key: 'companion.profile.v1', value: { name: 'Mia' } },
      { key: 'companion.skill.v1:huge', value: { slug: 'huge', content: 'x'.repeat(70 * 1024) } }] });
    expect(await t.runtime.transfer('bot_mia', 'laptop')).toEqual({ ok: false, code: 'FAILED' });
    expect(t.calls.some(call => call.method === 'PATCH')).toBe(false);
    expect(t.state.isDemoted('bot_mia')).toBe(false);
  });

  it('only transfers from the home computer', async () => {
    const t = setup({ home: 'laptop', devices: [device('tablet')] });
    expect(await t.runtime.transfer('bot_mia', 'tablet')).toMatchObject({ ok: false, code: 'FAILED', homeDeviceId: 'laptop' });
  });
});

describe('moving a companion that is still working', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('waits for the turn to finish when asked, then moves it', async () => {
    vi.useFakeTimers();
    let busy = true;
    const t = setup({ home: 'desk', devices: [device('laptop')], turnActive: () => busy });
    const moved = t.runtime.transfer('bot_mia', 'laptop', { whenBusy: 'wait' });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(t.calls.some(call => call.method === 'PATCH')).toBe(false);
    busy = false;
    await vi.advanceTimersByTimeAsync(2_000);
    vi.useRealTimers();
    expect(await moved).toEqual({ ok: true });
    expect(t.actors[0]!.homeDeviceId).toBe('laptop');
  });

  it('gives up as busy when the turn does not finish in time', async () => {
    vi.useFakeTimers();
    const t = setup({ home: 'desk', devices: [device('laptop')], turnActive: () => true });
    const moved = t.runtime.transfer('bot_mia', 'laptop', { whenBusy: 'wait' });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(await moved).toEqual({ ok: false, code: 'BUSY' });
    expect(t.calls.some(call => call.method === 'PATCH')).toBe(false);
  });

  it('stops the turn first when asked', async () => {
    vi.useFakeTimers();
    let busy = true;
    const stopBotTurns = vi.fn(async () => { busy = false; });
    const t = setup({ home: 'desk', devices: [device('laptop')], turnActive: () => busy, stopBotTurns });
    const moved = t.runtime.transfer('bot_mia', 'laptop', { whenBusy: 'stop' });
    await vi.advanceTimersByTimeAsync(2_000);
    vi.useRealTimers();
    expect(await moved).toEqual({ ok: true });
    expect(stopBotTurns).toHaveBeenCalledWith('bot_mia');
  });

  it('still refuses by default', async () => {
    const t = setup({ home: 'desk', devices: [device('laptop')], turnActive: () => true });
    expect(await t.runtime.transfer('bot_mia', 'laptop')).toEqual({ ok: false, code: 'BUSY' });
  });

  it('passes the choice to the home when asked from another computer', async () => {
    const handOver = vi.fn(async () => ({ ok: true as const }));
    const t = setup({ home: 'laptop', devices: [device('laptop')], homeLink: {
      version: async () => 2, targets: async () => [{ deviceId: 'tablet', name: 'Tablet', online: true }], handOver } });
    expect(await t.runtime.switchHome('bot_mia', 'tablet', { whenBusy: 'stop' })).toEqual({ ok: true });
    expect(handOver).toHaveBeenCalledWith('laptop', 'bot_mia', 'tablet', { whenBusy: 'stop' });
  });
});

describe('switch home from any computer', () => {
  const link = (version: number, targets = [{ deviceId: 'desk', name: '', online: true }, { deviceId: 'tablet', name: 'Tablet', online: true }]) => ({
    version: vi.fn(async () => version),
    targets: vi.fn(async () => targets),
    handOver: vi.fn(async (): Promise<{ ok: true } | { ok: false; code: 'BUSY' }> => ({ ok: true })),
  });

  it('says why this computer is not offered when it has not allowed same-account control', async () => {
    const t = setup({ home: 'laptop', devices: [device('laptop'), device('desk', { isSelf: true, name: 'Desk', remoteControlEnabled: false })], homeLink: link(2, [{ deviceId: 'tablet', name: 'Tablet', online: true }]) });
    expect(await t.runtime.homeChoices('bot_mia')).toMatchObject({ mode: 'remote', thisComputer: 'REMOTE_CONTROL_OFF',
      targets: [{ deviceId: 'tablet', name: 'Tablet', online: true, isSelf: false }] });
  });

  it('hands over from here when this computer is the home', async () => {
    const t = setup({ home: 'desk', devices: [device('laptop')] });
    expect(await t.runtime.homeChoices('bot_mia')).toEqual({ homeDeviceId: 'desk', homeName: '', mode: 'local', targets: [{ deviceId: 'laptop', name: 'laptop', online: true }] });
    expect(await t.runtime.switchHome('bot_mia', 'laptop')).toEqual({ ok: true });
    expect(t.state.isDemoted('bot_mia')).toBe(true);
  });

  it('asks the online home to hand the companion over, and re-reads homes when it moved here', async () => {
    const homeLink = link(2);
    const t = setup({ home: 'laptop', devices: [device('laptop'), device('desk', { isSelf: true, name: 'Desk' })], homeLink });
    expect(await t.runtime.homeChoices('bot_mia')).toEqual({ homeDeviceId: 'laptop', homeName: 'laptop', mode: 'remote', targets: [
      { deviceId: 'desk', name: 'Desk', online: true, isSelf: true },
      { deviceId: 'tablet', name: 'Tablet', online: true, isSelf: false },
    ] });
    expect(await t.runtime.switchHome('bot_mia', 'desk')).toEqual({ ok: true });
    expect(homeLink.handOver).toHaveBeenCalledWith('laptop', 'bot_mia', 'desk', undefined);
    expect(t.refresh).toHaveBeenCalled();
    // The home itself moves it: this computer never writes the home directly.
    expect(t.calls.some(call => call.method === 'PATCH')).toBe(false);
  });

  it('passes the home\'s refusal through unchanged', async () => {
    const homeLink = link(2);
    homeLink.handOver.mockResolvedValue({ ok: false, code: 'BUSY' });
    const t = setup({ home: 'laptop', devices: [device('laptop')], homeLink });
    expect(await t.runtime.switchHome('bot_mia', 'tablet')).toEqual({ ok: false, code: 'BUSY' });
  });

  it('refuses a computer the home did not offer', async () => {
    const homeLink = link(2);
    const t = setup({ home: 'laptop', devices: [device('laptop')], homeLink });
    expect(await t.runtime.switchHome('bot_mia', 'phone')).toEqual({ ok: false, code: 'TARGET_UNAVAILABLE' });
    expect(homeLink.handOver).not.toHaveBeenCalled();
  });

  it('only offers this computer when the home cannot be reached, and takes it over', async () => {
    const homeLink = link(0);
    const t = setup({ home: 'laptop', devices: [device('laptop'), device('desk', { isSelf: true, name: 'Desk' })], homeLink });
    expect(await t.runtime.homeChoices('bot_mia')).toEqual({ homeDeviceId: 'laptop', homeName: 'laptop', mode: 'takeOver',
      targets: [{ deviceId: 'desk', name: 'Desk', online: true, isSelf: true }] });
    const offline = setup({ home: 'laptop', devices: [device('laptop', { online: false })], homeLink });
    expect((await offline.runtime.homeChoices('bot_mia')).mode).toBe('takeOver');
    expect(await offline.runtime.switchHome('bot_mia', 'desk')).toEqual({ ok: true });
    expect(offline.calls.find(call => call.method === 'PATCH')).toMatchObject({ data: { homeDeviceId: 'desk', expectedHomeDeviceId: 'laptop' } });
    expect(homeLink.handOver).not.toHaveBeenCalled();
  });

  it('does not offer a move when the home runs an older Cindy', async () => {
    const homeLink = link(1);
    const t = setup({ home: 'laptop', devices: [device('laptop')], homeLink });
    expect(await t.runtime.homeChoices('bot_mia')).toEqual({ homeDeviceId: 'laptop', homeName: 'laptop', mode: 'unavailable', reason: 'HOME_OUTDATED', targets: [] });
    expect(await t.runtime.switchHome('bot_mia', 'desk')).toEqual({ ok: false, code: 'HOME_OUTDATED' });
    expect(homeLink.targets).not.toHaveBeenCalled();
  });

  it('re-reads homes when the hand-over answer is lost', async () => {
    const homeLink = link(2);
    homeLink.handOver.mockRejectedValue(new Error('[INVOKE_TIMEOUT] no answer'));
    const t = setup({ home: 'laptop', devices: [device('laptop')], homeLink });
    expect((await t.runtime.switchHome('bot_mia', 'tablet')).ok).toBe(false);
    expect(t.refresh).toHaveBeenCalled();
  });
});

describe('transcript', () => {
  it('maps authors to roles and pages oldest-first', async () => {
    const page = Array.from({ length: 100 }, (_, i) => ({ id: `m${i}`, seq: String(200 - i), authorId: i % 2 ? 'actor-1' : 'human',
      createdAt: new Date(1_700_000_000_000 - i * 1000).toISOString(), content: [{ type: 'text', text: `t${i}` }] }));
    page[1] = { ...page[1]!, content: [{ type: 'media', caption: 'a.png' } as never] };
    const { api } = fakeApi(() => page);
    const result = await readTranscriptPage(api, ROOM, 'actor-1');
    expect(result.nextBefore).toBe('101');
    expect(result.messages.at(-1)).toMatchObject({ id: 'm0', seq: '200', role: 'user', text: 't0' });
    expect(result.messages.at(-2)).toMatchObject({ id: 'm1', role: 'assistant', text: '[附件: a.png]' });
  });
});

describe('retire', () => {
  // An explicit local deletion must survive an unavailable actor registry. Persist the
  // known actor identity; a later registry must still prove home + installation ownership.
  it('persists retirement without an actor registry and completes it after restart', async () => {
    const t = setup({ home: 'desk' });
    t.state.update('bot_mia', 'actor-1', entry => { entry.roomId = ROOM; });
    t.actors.length = 0;
    await t.runtime.retire('bot_mia');
    const savedState = t.files.get('state.json');
    expect(JSON.parse(savedState!).bots.bot_mia.retirePending).toBe(true);
    expect(t.calls.some(call => call.method === 'PATCH')).toBe(false);
    t.runtime.dispose();

    const restarted = setup({ home: 'desk', savedState });
    restarted.runtime.reconcile([]);
    await vi.waitFor(() => expect(restarted.actors[0]!.disabled).toBe(true));
    expect(restarted.state.bot('bot_mia')?.retirePending).toBeUndefined();
    expect(restarted.local.host.createProfile).not.toHaveBeenCalled();
  });

  it.each(['laptop', 'replacement', 'disabled'])('does not apply a deferred deletion to %s', async target => {
    const t = setup({ home: 'desk' });
    t.state.update('bot_mia', 'actor-1', entry => { entry.retirePending = true; });
    if (target === 'laptop') t.actors[0]!.homeDeviceId = 'laptop';
    else if (target === 'replacement') t.actors[0]!.id = 'actor-replacement';
    else t.actors[0]!.disabled = true;
    // Keep a local row to avoid exercising automatic materialization in this retirement test.
    t.runtime.reconcile([{ id: 'bot_mia', status: 'active' }]);
    await Promise.resolve();
    expect(t.calls.some(call => call.method === 'PATCH' && (call.data as { disabled?: boolean }).disabled)).toBe(false);
    expect(t.actors[0]!.disabled === true).toBe(target === 'disabled');
    expect(t.state.bot('bot_mia')?.retirePending).toBeUndefined();
  });

  it('does not queue an unknown or demoted companion when the registry is unavailable', async () => {
    const t = setup({ home: 'desk' });
    t.state.update('bot_mia', 'actor-1', entry => { entry.demoted = true; });
    t.actors.length = 0;
    await t.runtime.retire('bot_mia');
    await t.runtime.retire('unknown');
    expect(t.state.bot('bot_mia')?.retirePending).toBeUndefined();
    expect(t.state.bot('unknown')).toBeNull();
    expect(t.calls.some(call => call.method === 'PATCH')).toBe(false);
  });

  it('disables the cloud companion when it is deleted on its main computer', async () => {
    const t = setup({ home: 'desk' });
    await t.runtime.retire('bot_mia');
    expect(t.calls.filter(call => call.method === 'PATCH')).toEqual([expect.objectContaining({ route: '/actors/actor-1',
      data: { disabled: true, homeDeviceId: 'desk', expectedHomeDeviceId: 'desk' } })]);
    expect(t.actors[0]!.disabled).toBe(true);
    // A retired companion is never revived or demoted again.
    t.runtime.reconcile([]);
    await Promise.resolve();
    expect(t.local.host.createProfile).not.toHaveBeenCalled();
  });

  it('does not retire the companion when another computer took it over in the meantime', async () => {
    const t = setup({ home: 'desk', handler: (_route, method) => {
      if (method === 'PATCH') throw rejection(409, 'HOME_DEVICE_CONFLICT', { homeDeviceId: 'laptop' });
      return [];
    } });
    await t.runtime.retire('bot_mia');
    expect(t.actors[0]!.disabled).toBeFalsy();
    expect(t.actors[0]!.homeDeviceId).toBe('laptop');
    expect(t.state.bot('bot_mia')?.retirePending).toBeUndefined();
    expect(t.refresh).toHaveBeenCalled();
  });

  it('hides a copy here once the companion was deleted on its main computer', () => {
    const t = setup({ home: 'laptop' });
    t.actors[0]!.disabled = true;
    t.runtime.reconcile([{ id: 'bot_mia', status: 'active' }]);
    expect(t.runtime.isShadowed('bot_mia')).toBe(true);
    expect(t.local.host.createProfile).not.toHaveBeenCalled();
  });

  it.each([
    ['a demoted local copy', 'desk', true],
    ['a copy whose home is elsewhere', 'laptop', false],
  ])('leaves the cloud companion alone when deleting %s', async (_name, home, demoted) => {
    const t = setup({ home });
    if (demoted) t.state.update('bot_mia', 'actor-1', entry => { entry.demoted = true; });
    await t.runtime.retire('bot_mia');
    expect(t.calls.some(call => call.method === 'PATCH')).toBe(false);
  });
});

describe('review fixes', () => {
  it('confirms the home with a self-to-self compare-and-set before un-demoting', async () => {
    const t = setup({ home: 'desk' });
    t.local.setProfile({ status: 'active', displayName: 'Mia', description: '' });
    t.state.update('bot_mia', 'actor-1', entry => { entry.demoted = true; });
    t.runtime.reconcile([{ id: 'bot_mia', status: 'active' }]);
    await vi.waitFor(() => expect(t.state.isDemoted('bot_mia')).toBe(false));
    const patch = t.calls.find(call => call.method === 'PATCH');
    expect(patch).toMatchObject({ route: '/actors/actor-1', data: { homeDeviceId: 'desk', expectedHomeDeviceId: 'desk' } });
    expect(t.calls.indexOf(patch!)).toBeLessThan(t.calls.findIndex(call => call.route === '/preferences' && call.method === 'GET'));
  });

  it('does not resurrect a demoted copy when the cached home is stale', async () => {
    const t = setup({ home: 'desk', handler: (route, method) => {
      if (method === 'PATCH') throw rejection(409, 'HOME_DEVICE_CONFLICT', { homeDeviceId: 'laptop' });
      return [];
    } });
    t.local.setProfile({ status: 'active', displayName: 'Mia', description: '' });
    t.state.update('bot_mia', 'actor-1', entry => { entry.demoted = true; });
    t.runtime.reconcile([{ id: 'bot_mia', status: 'active' }]);
    await vi.waitFor(() => expect(t.refresh).toHaveBeenCalled());
    expect(t.state.isDemoted('bot_mia')).toBe(true);
    expect(t.local.host.updateProfile).not.toHaveBeenCalled();
  });

  it('rejects a hand-over target whose Cindy cannot take a companion over', async () => {
    const t = setup({ home: 'desk', devices: [device('laptop')], probe: async () => false });
    expect(await t.runtime.transfer('bot_mia', 'laptop')).toEqual({ ok: false, code: 'TARGET_UNAVAILABLE' });
    expect(await t.runtime.transferTargets()).toEqual([]);
    expect(t.calls.some(call => call.method === 'PATCH')).toBe(false);
  });

  it('drops a pending retirement once another computer took the companion over', async () => {
    let fail = true;
    const t = setup({ home: 'desk', handler: (_route, method, data) => {
      if (method === 'PATCH' && (data as { disabled?: boolean }).disabled && fail) throw rejection(503, 'UNAVAILABLE');
      return {};
    } });
    await expect(t.runtime.retire('bot_mia')).rejects.toThrow('UNAVAILABLE');
    fail = false;
    t.actors[0]!.homeDeviceId = 'laptop';
    t.runtime.reconcile([]);
    expect(t.state.bot('bot_mia')?.retirePending).toBeUndefined();
    // Handed back later: the companion is not retired by the stale deletion.
    t.actors[0]!.homeDeviceId = 'desk';
    t.runtime.reconcile([]);
    await new Promise(resolve => setTimeout(resolve, 20));
    // Only the first, failed attempt ever asked to disable it.
    expect(t.calls.filter(call => call.method === 'PATCH' && (call.data as { disabled?: boolean }).disabled)).toHaveLength(1);
    expect(t.actors[0]!.disabled).toBeFalsy();
  });

  it('keeps retrying to retire a companion deleted on its home until it succeeds', async () => {
    let fail = true;
    const t = setup({ home: 'desk', handler: (_route, method, data) => {
      if (method === 'PATCH' && (data as { disabled?: boolean }).disabled && fail) throw rejection(503, 'UNAVAILABLE');
      return {};
    } });
    await expect(t.runtime.retire('bot_mia')).rejects.toThrow('UNAVAILABLE');
    expect(t.state.bot('bot_mia')?.retirePending).toBe(true);
    fail = false;
    t.runtime.reconcile([]);
    await vi.waitFor(() => expect(t.state.bot('bot_mia')?.retirePending).toBeUndefined());
    expect(t.actors[0]!.disabled).toBe(true);
    expect(t.local.host.createProfile).not.toHaveBeenCalled();
  });
});

describe('installation guard', () => {
  const guarded = (owner: string | { installationId: string; deviceId: string } | null) => {
    const record = typeof owner === 'string' ? { installationId: owner } : owner;
    const prefs = new Map<string, { value: unknown; revision: number }>([['companion.profile.v1', { value: { ...MIA, name: 'Mia (cloud)' }, revision: 1 }],
      ...(record ? [['companion.install.v1', { value: record, revision: 1 }] as const] : [])]);
    return setup({ home: 'desk', installationId: 'install-a', handler: (route, method, data) => {
      if (route === '/preferences' && method === 'GET') return [...prefs].map(([key, row]) => ({ key, ...row }));
      if (route === '/preferences') {
        const body = data as { key: string; value: unknown; expectedRevision: number };
        const current = prefs.get(body.key)?.revision ?? 0;
        if (current !== body.expectedRevision) throw rejection(409, 'REVISION_CONFLICT', { revision: current });
        prefs.set(body.key, { value: body.value, revision: current + 1 });
        return { revision: current + 1 };
      }
      if (route === '/conversations') return { id: ROOM };
      if (route.includes('/messages?')) return [];
      return {};
    } });
  };

  it('shadows a companion another installation on this device runs', async () => {
    const t = guarded({ installationId: 'install-b', deviceId: 'desk' });
    t.runtime.reconcile([{ id: 'bot_mia', status: 'active' }]);
    // Not confirmed while the claim is still being read: execution polling stays off.
    expect(t.runtime.installConfirmed('bot_mia')).toBe(false);
    await vi.waitFor(() => expect(t.runtime.isShadowed('bot_mia')).toBe(true));
    expect(t.runtime.installConfirmed('bot_mia')).toBe(false);
    expect(t.runtime.shadowIds()).toEqual(['bot_mia']);
    await t.runtime.syncNow();
    expect(t.calls.some(call => call.method === 'POST' && call.route === '/preferences' && (call.data as { key: string }).key !== 'companion.install.v1')).toBe(false);
    // Taking over from this installation overwrites the claim.
    expect(await t.runtime.takeOver('bot_mia')).toEqual({ ok: true });
    expect(t.runtime.isShadowed('bot_mia')).toBe(false);
    expect(t.calls.some(call => call.method === 'POST' && (call.data as { key?: string; value?: unknown }).key === 'companion.install.v1'
      && (call.data as { value: { installationId: string } }).value.installationId === 'install-a')).toBe(true);
  });

  it('deletes only the local copy when the installation check shows another Cindy here runs it', async () => {
    const t = guarded({ installationId: 'install-b', deviceId: 'desk' });
    // Deleted before the check finished: confirm first, never disable the other installation's companion.
    await t.runtime.retire('bot_mia');
    expect(t.calls.some(call => call.method === 'PATCH')).toBe(false);
    expect(t.state.bot('bot_mia')?.retirePending).toBeUndefined();

    const mine = guarded(null);
    await mine.runtime.retire('bot_mia');
    expect(mine.calls.filter(call => call.method === 'PATCH')).toEqual([expect.objectContaining({ data: expect.objectContaining({ disabled: true }) })]);
  });

  it('claims a companion just handed here before retiring it, and leaves it to the installation that won', async () => {
    const handed = guarded({ installationId: 'install-x', deviceId: 'laptop' });
    await handed.runtime.retire('bot_mia');
    const order = handed.calls.map(call => call.method === 'POST' ? `POST ${(call.data as { key?: string }).key}` : `${call.method} ${call.route}`);
    expect(order.indexOf('POST companion.install.v1')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('POST companion.install.v1')).toBeLessThan(order.indexOf('PATCH /actors/actor-1'));

    // The other Cindy on this computer claimed it first: deleting here never disables it.
    const lost = setup({ home: 'desk', installationId: 'install-a', handler: (route, method) => {
      if (route === '/preferences' && method === 'GET') return [{ key: 'companion.profile.v1', value: MIA, revision: 1 },
        { key: 'companion.install.v1', value: { installationId: 'install-x', deviceId: 'laptop' }, revision: 1 }];
      if (route === '/preferences') throw rejection(409, 'REVISION_CONFLICT', { revision: 2 });
      return {};
    } });
    await lost.runtime.retire('bot_mia');
    expect(lost.calls.some(call => call.method === 'PATCH')).toBe(false);
    expect(lost.state.bot('bot_mia')?.retirePending).toBeUndefined();
  });

  it('hides the copy before this installation claims it during a take-over', async () => {
    let demotedAtClaim: boolean | undefined;
    let state: { isDemoted: (botId: string) => boolean } | undefined;
    const t = setup({ home: 'laptop', installationId: 'install-a', handler: (route, method, data) => {
      if (route === '/preferences' && method === 'GET') return [{ key: 'companion.profile.v1', value: MIA, revision: 1 },
        { key: 'companion.install.v1', value: { installationId: 'install-b', deviceId: 'desk' }, revision: 1 }];
      if (route === '/preferences' && (data as { key?: string }).key === 'companion.install.v1') demotedAtClaim = state?.isDemoted('bot_mia');
      if (route === '/preferences') return { revision: 2 };
      if (route === '/conversations') return { id: ROOM };
      if (route.includes('/messages?')) return [];
      return {};
    } });
    state = t.state;
    expect(await t.runtime.takeOver('bot_mia')).toEqual({ ok: true });
    expect(demotedAtClaim).toBe(true);
    expect(t.state.isDemoted('bot_mia')).toBe(false);
  });

  it('claims an unclaimed companion for this installation and then syncs it', async () => {
    const t = guarded(null);
    t.runtime.reconcile([{ id: 'bot_mia', status: 'active' }]);
    await vi.waitFor(() => expect(t.calls.some(call => call.method === 'POST' && (call.data as { key?: string }).key === 'companion.install.v1')).toBe(true));
    await vi.waitFor(() => expect(t.runtime.installConfirmed('bot_mia')).toBe(true));
    expect(t.runtime.isShadowed('bot_mia')).toBe(false);
    await t.runtime.syncNow();
    expect(t.calls.some(call => call.method === 'POST' && (call.data as { key?: string }).key === 'companion.profile.v1')).toBe(true);
  });

  it('never takes a companion handed back to this computer from the other installation here automatically', async () => {
    const t = guarded({ installationId: 'install-b', deviceId: 'desk' });
    t.local.setProfile({ status: 'active', displayName: 'Mia', description: '' });
    t.state.update('bot_mia', 'actor-1', entry => { entry.demoted = true; });
    t.runtime.reconcile([{ id: 'bot_mia', status: 'active' }]);
    await vi.waitFor(() => expect(t.calls.some(call => call.method === 'PATCH')).toBe(true));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(t.calls.some(call => call.method === 'POST' && (call.data as { key?: string }).key === 'companion.install.v1')).toBe(false);
    expect(t.local.host.updateProfile).not.toHaveBeenCalled();
    expect(t.state.isDemoted('bot_mia')).toBe(true);
    // The user's explicit take-over still moves it to this installation.
    expect(await t.runtime.takeOver('bot_mia')).toEqual({ ok: true });
  });

  it('hides a copy handed here before confirming the home with the server', async () => {
    let demotedAtPatch: boolean | undefined;
    let state: { isDemoted: (botId: string) => boolean } | undefined;
    const t = setup({ home: 'desk', handler: (route, method) => {
      if (method === 'PATCH') { demotedAtPatch = state?.isDemoted('bot_mia'); return {}; }
      if (route === '/preferences') return method === 'GET' ? [{ key: 'companion.profile.v1', value: MIA, revision: 1 }] : { revision: 1 };
      if (route === '/conversations') return { id: ROOM };
      if (route.includes('/messages?')) return [];
      return {};
    } });
    state = t.state;
    t.runtime.reconcile([]);
    await vi.waitFor(() => expect(t.local.host.createProfile).toHaveBeenCalledOnce());
    expect(demotedAtPatch).toBe(true);
    await vi.waitFor(() => expect(t.state.isDemoted('bot_mia')).toBe(false));
  });

  it('takes over an existing, never-synced copy handed here before this computer saw the move', async () => {
    // Another computer's installation ran it; this device's own copy was never demoted.
    const t = guarded({ installationId: 'install-x', deviceId: 'laptop' });
    t.local.setProfile({ status: 'active', displayName: 'Mia', description: '' });
    t.runtime.reconcile([{ id: 'bot_mia', status: 'active' }]);
    await vi.waitFor(() => expect(t.runtime.installConfirmed('bot_mia')).toBe(true));
    await vi.waitFor(() => expect(t.local.host.updateProfile).toHaveBeenCalledOnce());
    expect(t.calls.find(call => call.method === 'PATCH')?.data).toEqual({ homeDeviceId: 'desk', expectedHomeDeviceId: 'desk' });
    expect(t.calls.some(call => call.method === 'POST' && (call.data as { key?: string; value?: unknown }).key === 'companion.install.v1'
      && JSON.stringify((call.data as { value: unknown }).value) === JSON.stringify({ installationId: 'install-a', deviceId: 'desk' }))).toBe(true);
    await vi.waitFor(() => expect(t.state.isDemoted('bot_mia')).toBe(false));
    expect(t.runtime.isShadowed('bot_mia')).toBe(false);
  });
});

describe('merging copies of Cindy', () => {
  function mergeSetup(options: { sourceHome: string; flush?: ReturnType<typeof vi.fn>; turnActive?: () => boolean;
    canonicalSession?: CompanionCloudHost['canonicalSession']; paused?: (botId: string) => boolean }) {
    const order: string[] = [];
    const flush = options.flush ?? vi.fn(async () => { order.push('flush'); return { ok: true as const }; });
    const homeLink = { version: vi.fn(async () => 2), targets: vi.fn(async () => []), handOver: vi.fn(async () => ({ ok: true as const })), flush };
    const t = setup({ home: 'desk', homeLink, ...(options.turnActive ? { turnActive: options.turnActive } : {}),
      ...(options.canonicalSession ? { canonicalSession: options.canonicalSession } : {}),
      ...(options.paused ? { paused: options.paused } : {}), handler: (route, method) => {
      if (route === '/preferences') return method === 'GET' ? [{ key: 'companion.profile.v1', value: { ...MIA, templateId: 'cindy' }, revision: 1 }] : { revision: 1 };
      if (route === '/conversations') return { id: ROOM };
      if (route.includes('/messages?')) return [];
      if (route.endsWith('/import')) return {};
      if (method === 'PATCH') { order.push(`patch ${route}`); return {}; }
      throw new Error(`unexpected ${method} ${route}`);
    } });
    t.actors.splice(0, t.actors.length,
      { id: 'actor-keep', kind: 'bot', externalId: 'cindy-default', name: 'Cindy', avatar: null, homeDeviceId: 'desk' },
      { id: 'actor-from', kind: 'bot', externalId: 'bot_lap', name: 'Cindy', avatar: null, homeDeviceId: options.sourceHome });
    return { ...t, order, flush };
  }

  it('has the other copy\'s computer send what it has not sent yet before reading it, and retires it last', async () => {
    const t = mergeSetup({ sourceHome: 'laptop' });
    expect(await t.runtime.mergeCindy('cindy-default', ['bot_lap'])).toMatchObject({ ok: true, merged: 1 });
    expect(t.flush).toHaveBeenCalledWith('laptop', 'bot_lap');
    // Once before reading it, once more right before retiring it.
    expect(t.order).toEqual(['flush', 'flush', 'patch /actors/actor-from']);
  });

  it('does not merge while the other copy is still replying, and leaves it active', async () => {
    const flush = vi.fn(async () => ({ ok: false as const, code: 'BUSY' }));
    const t = mergeSetup({ sourceHome: 'laptop', flush });
    expect(await t.runtime.mergeCindy('cindy-default', ['bot_lap'])).toEqual({ ok: false, code: 'BUSY' });
    expect(t.order).toEqual([]);
  });

  it('sends a copy homed here itself, and waits while it is busy', async () => {
    let busy = true;
    const t = mergeSetup({ sourceHome: 'desk', turnActive: () => busy });
    expect(await t.runtime.mergeCindy('cindy-default', ['bot_lap'])).toEqual({ ok: false, code: 'BUSY' });
    busy = false;
    expect(await t.runtime.mergeCindy('cindy-default', ['bot_lap'])).toMatchObject({ ok: true, merged: 1 });
    expect(t.flush).not.toHaveBeenCalled();
  });

  it('leaves the copies active when the kept Cindy has no task here to take the conversation', async () => {
    const t = mergeSetup({ sourceHome: 'laptop', canonicalSession: async () => null });
    expect(await t.runtime.mergeCindy('cindy-default', ['bot_lap'])).toMatchObject({ ok: false });
    expect(t.order).toEqual(['flush']);
  });

  it('re-checks every copy right before retiring it, and stops when one got busy meanwhile', async () => {
    let calls = 0;
    const flush = vi.fn(async () => (++calls === 1 ? { ok: true as const } : { ok: false as const, code: 'BUSY' }));
    const t = mergeSetup({ sourceHome: 'laptop', flush });
    expect(await t.runtime.mergeCindy('cindy-default', ['bot_lap'])).toEqual({ ok: false, code: 'BUSY' });
    expect(flush).toHaveBeenCalledTimes(2);
    expect(t.order.filter(step => step.startsWith('patch'))).toEqual([]);
  });

  it('does not count a copy as sent when a turn started during its flush', async () => {
    let checks = 0;
    // Idle when asked first, busy once the flush is done.
    const t = mergeSetup({ sourceHome: 'desk', turnActive: () => ++checks > 1 });
    expect(await t.runtime.flushHere('bot_lap')).toEqual({ ok: false, code: 'BUSY' });
  });

  it('stops the merge when a copy\'s main task cannot be told, instead of counting its history as sent', async () => {
    const t = mergeSetup({ sourceHome: 'desk', canonicalSession: async (botId) => {
      if (botId === 'bot_lap') throw new Error('COMPANION_TASK_CONFLICT');
      return 'session-1';
    } });
    expect(await t.runtime.mergeCindy('cindy-default', ['bot_lap'])).toMatchObject({ ok: false });
    expect(t.order.filter(step => step.startsWith('patch'))).toEqual([]);
  });

  it('asks to resume a paused copy, kept or merged, instead of failing part way', async () => {
    const source = mergeSetup({ sourceHome: 'desk', paused: (botId) => botId === 'bot_lap' });
    expect(await source.runtime.mergeCindy('cindy-default', ['bot_lap'])).toEqual({ ok: false, code: 'PAUSED' });
    runtime?.dispose();
    const kept = mergeSetup({ sourceHome: 'laptop', paused: (botId) => botId === 'cindy-default' });
    expect(await kept.runtime.mergeCindy('cindy-default', ['bot_lap'])).toEqual({ ok: false, code: 'PAUSED' });
    expect(kept.flush).not.toHaveBeenCalled();
  });

  it('answers a flush request only as the copy\'s home', async () => {
    const t = mergeSetup({ sourceHome: 'laptop' });
    expect(await t.runtime.flushHere('bot_lap')).toEqual({ ok: false, code: 'HOME_CONFLICT' });
    expect(await t.runtime.flushHere('cindy-default')).toEqual({ ok: true });
  });
});

// Filtering still needs Cindy's identity after all cloud copies have already been merged.
it('lists a single remaining Cindy by profile identity, without running a merge', async () => {
  const t = setup({ home: 'laptop', handler: (route, method) => {
    if (route === '/preferences' && method === 'GET') return [{ key: 'companion.profile.v1', value: { ...MIA, templateId: 'cindy' }, revision: 1 }];
    throw new Error(`unexpected ${method} ${route}`);
  } });
  expect(await t.runtime.cindyCopies()).toEqual([{ botId: 'bot_mia', name: 'Mia', homeDeviceId: 'laptop' }]);
  expect(t.calls.every(call => call.method === 'GET')).toBe(true);
});
