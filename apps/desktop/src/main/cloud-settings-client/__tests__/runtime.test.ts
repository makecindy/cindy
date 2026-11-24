import { EventEmitter } from 'node:events';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { fixture } from './fixture';
import { CLOUD_LOGIN_WINDOW } from '../../../shared/cloudLoginWindow';
import { CLOUD_CLIENT_CHANNELS, type CloudClientOpen } from '../../../shared/cloudSettingsClient';

const mock = vi.hoisted(() => ({
  handle: vi.fn(),
  quit: vi.fn(),
  fetch: vi.fn<typeof fetch>(),
  pending: false,
  owner: 'member-a',
  mode: 'cloud',
  generation: 1,
  member: 'member-a',
  authenticated: true,
  token: 'invalid-test-token',
  realm: 'cn',
  device: 'controller-a',
  baseUrl: 'https://cis.example.test',
  authChanged: undefined as (() => void) | undefined,
  off: vi.fn(),
}));
vi.mock('electron', () => ({
  app: { once: mock.quit },
  ipcMain: { handle: mock.handle },
  net: { fetch: mock.fetch },
}));
vi.mock('../../authManager', () => ({
  peekCommittedAuthIdentity: () => ({ isAuthenticated: mock.authenticated, userId: mock.member }),
  getAccessToken: () => mock.token,
  getActiveAuthRealm: () => mock.realm,
  getDeviceId: () => mock.device,
  onAuthStateChange: (callback: () => void) => {
    mock.authChanged = callback;
    return mock.off;
  },
}));
vi.mock('../../appSessionState', () => ({
  isAppSessionBoundaryPending: () => mock.pending,
  peekCommittedAppSession: () => ({
    mode: mock.mode,
    dataOwnerId: mock.owner,
    generation: mock.generation,
  }),
}));
vi.mock('../../clientEndpointsService', () => ({ getClientEndpointForRealm: () => mock.baseUrl }));
vi.mock('../../security/trustedAppRenderer', () => ({
  assertTrustedAppRendererEvent: (event: { trusted: boolean }) => {
    if (!event.trusted) throw Error('PERMISSION_DENIED');
  },
}));
import { registerCloudSettingsClientIpc } from '../runtime';

// Window creation fails: the IPC cases must never reach a usable login window.
const createWindow = vi.fn<() => never>(() => { throw Error('fixture login window unavailable'); });
let f: ReturnType<typeof fixture>;
let sender: EventEmitter & { id: number; isDestroyed(): boolean };
let event: { sender: typeof sender; trusted: boolean };
// Main registers the bridge once per process; the tests drive the handlers it registered.
const handlers = new Map<string, (event: unknown, raw: unknown) => unknown>();
let quit: () => void;
beforeAll(() => {
  registerCloudSettingsClientIpc({
    isOpenSender: (candidate) => candidate === sender,
    title: () => 'Cloud login',
    createWindow,
  });
  for (const [name, fn] of mock.handle.mock.calls) handlers.set(name, fn);
  quit = mock.quit.mock.calls.find(([name]) => name === 'before-quit')![1];
});
function handler(channel: string) {
  return handlers.get(channel)!;
}
function call(key: 'open', payload: unknown): Promise<CloudClientOpen>;
function call(
  key: Exclude<keyof typeof CLOUD_CLIENT_CHANNELS, 'open'>,
  payload: unknown,
): Promise<unknown>;
function call(key: keyof typeof CLOUD_CLIENT_CHANNELS, payload: unknown): Promise<unknown> {
  return Promise.resolve().then(() => handler(CLOUD_CLIENT_CHANNELS[key])(event, payload));
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  Object.assign(mock, {
    pending: false,
    owner: 'member-a',
    mode: 'cloud',
    generation: 1,
    member: 'member-a',
    authenticated: true,
    token: 'invalid-test-token',
    realm: 'cn',
    device: 'controller-a',
    baseUrl: 'https://cis.example.test',
  });
  // The restored account is announced like any auth change, so the bridge binds to it afresh.
  mock.authChanged!();
  f = fixture();
  sender = Object.assign(new EventEmitter(), { id: 1, isDestroyed: () => false });
  event = { sender, trusted: true };
  mock.fetch.mockImplementation(async (url, init) => {
    const output = await f.request(
      f.identity(),
      new URL(String(url)).pathname,
      init!.method!,
      init!.body ? JSON.parse(String(init!.body)) : undefined,
      init!.signal!,
      () => {},
    );
    return output === undefined ? new Response(null, { status: 204 }) : Response.json(output);
  });
});
afterEach(() => {
  // Quitting ends every cloud settings session and the login window.
  quit();
  f.stop();
  vi.useRealTimers();
});
// An admitted account that only chats locally gets no hidden login window; the first instance
// that needs a sign-in creates it.
it('creates the login window only when an instance first needs a sign-in', async () => {
  mock.fetch.mockResolvedValueOnce(Response.json({ schemaVersion: 1, allowed: true }));
  await expect(call('instanceAccess', {})).resolves.toMatchObject({ allowed: true });
  expect(createWindow).not.toHaveBeenCalled();
  const target = { instanceId: 'instance-a', deviceId: 'cloud-a', customLabel: null, nameSequence: 1,
    status: { instanceId: 'instance-a', deviceId: 'cloud-a', desiredState: 'stopped', runtimeState: 'missing',
      image: 'registry.example.test/cloud:0.1.113', readiness: { ready: false }, updateAvailable: false,
      latestReleaseTag: null, upgrade: { state: 'idle' }, loginRequired: true } };
  mock.fetch.mockResolvedValueOnce(Response.json({ instances: [target] }));
  // Fixture window creation deliberately fails, after the window was asked for once.
  await expect(handler(CLOUD_LOGIN_WINDOW.open)(event, { deviceId: 'cloud-a' })).rejects.toThrow('CLOUD_SETTINGS_UNAVAILABLE');
  expect(createWindow).toHaveBeenCalledTimes(1);
});
// Ordinary clients: the access check of a region without a cloud instance service says so, so
// the renderer stops asking; it still refuses an untrusted sender first and never reaches CIS.
it('reports the access check of a client without a cloud instance service as unsupported', async () => {
  mock.baseUrl = '';
  await expect(call('instanceAccess', {})).rejects.toThrow('[CLOUD_SETTINGS_UNSUPPORTED]');
  event.trusted = false;
  await expect(call('instanceAccess', {})).rejects.toThrow('PERMISSION_DENIED');
  expect(mock.fetch).not.toHaveBeenCalled();
});
it('registers the closed bridge once and rejects untrusted IPC before network access', async () => {
  registerCloudSettingsClientIpc();
  expect(mock.handle).not.toHaveBeenCalled();
  expect(handlers.size).toBe(Object.keys(CLOUD_CLIENT_CHANNELS).length + 9);
  event.trusted = false;
  await expect(call('instanceAccess', {})).rejects.toThrow('PERMISSION_DENIED');
  await expect(call('open', { deviceId: 'cloud-a' })).rejects.toThrow('PERMISSION_DENIED');
  await expect(
    call('instanceUpgrade', {
      deviceId: 'cloud-a',
      requestId: '33333333-3333-4333-8333-333333333333',
    }),
  ).rejects.toThrow('PERMISSION_DENIED');
  expect(mock.fetch).not.toHaveBeenCalled();
});
it.each(['signed-out', 'local', 'mismatch', 'boundary'])(
  'refuses a %s committed identity without reading any cloud settings',
  async (condition) => {
    if (condition === 'boundary') mock.pending = true;
    else if (condition === 'mismatch') mock.member = 'other-member';
    else mock.mode = condition;
    await expect(call('open', { deviceId: 'cloud-a' })).rejects.toThrow('SCOPE_CHANGED');
    await expect(call('instanceAccess', {})).rejects.toThrow('SCOPE_CHANGED');
    expect(mock.fetch).not.toHaveBeenCalled();
  },
);
// A signed-out client must never reach CIS, whichever entry point the renderer calls.
// Valid payloads, so each call is refused for the missing identity, not by validation.
it('makes no CIS request from any entry point while signed out', async () => {
  Object.assign(mock, { mode: 'signed-out', authenticated: false, token: '' });
  mock.authChanged!();
  const deviceId = 'cloud-a';
  const entries: Array<[keyof typeof CLOUD_CLIENT_CHANNELS, unknown]> = [
    ['instanceAccess', {}],
    ['instanceList', {}],
    ['instanceCapacity', {}],
    ['instanceClaim', {}],
    ['instanceInitialize', { deviceId }],
    ['instanceLoginStart', { deviceId }],
    ['instanceRead', { deviceId }],
    ['instancePower', { deviceId, action: 'wake' }],
    ['instanceUpgrade', { deviceId, requestId: '00000000-0000-4000-8000-000000000000' }],
    ['instancePolicy', { deviceId, change: { policyMode: 'inherit', revision: 'a'.repeat(64), defaultsRevision: 0, autoUpdate: true } }],
    ['open', { deviceId }],
  ];
  for (const [key, payload] of entries) {
    const error = await Promise.resolve()
      .then(() => handler(CLOUD_CLIENT_CHANNELS[key])(event, payload))
      .then(() => null, (reason: unknown) => reason);
    expect(error, key).toBeInstanceOf(Error);
    expect(String(error), key).not.toContain('INVALID_PARAMS');
  }
  expect(mock.fetch).not.toHaveBeenCalled();
});
it.each(['realm', 'owner', 'generation', 'device', 'endpoint'])(
  'invalidates a handle on %s changes',
  async (condition) => {
    const { handle } = await call('open', { deviceId: 'cloud-a' });
    if (condition === 'realm') mock.realm = 'global';
    else if (condition === 'owner') {
      mock.owner = 'member-b';
      mock.member = 'member-b';
    } else if (condition === 'generation') mock.generation++;
    else if (condition === 'device') mock.device = 'controller-b';
    else mock.baseUrl = 'https://other.example.test';
    mock.authChanged!();
    const count = mock.fetch.mock.calls.length;
    await expect(call('read', { handle, domains: ['memory'] })).rejects.toThrow('SCOPE_CHANGED');
    expect(mock.fetch).toHaveBeenCalledTimes(count);
  },
);
it('same-owner token renewal keeps the handle and uses the new token', async () => {
  const { handle } = await call('open', { deviceId: 'cloud-a' });
  mock.token = 'rotated-test-token';
  mock.authChanged!();
  await call('read', { handle, domains: ['memory'] });
  expect(mock.fetch.mock.calls.at(-1)![1]!.headers).toMatchObject({
    Authorization: 'Bearer rotated-test-token',
  });
});
it('renews only an open cloud settings handle and stops after closing it', async () => {
  const { handle } = await call('open', { deviceId: 'cloud-a' });
  await vi.advanceTimersByTimeAsync(30_000);
  expect(mock.fetch.mock.calls.at(-1)![0]).toMatch(/\/heartbeat$/);
  expect(mock.fetch.mock.calls.at(-1)![1]!.credentials).toBe('omit');
  await call('close', { handle });
  const count = mock.fetch.mock.calls.length;
  await vi.advanceTimersByTimeAsync(120_000);
  expect(mock.fetch).toHaveBeenCalledTimes(count);
});
it.each([401, 403, 409])(
  'discards a session after heartbeat HTTP %s without resubmitting any setting',
  async (status) => {
    const { handle } = await call('open', { deviceId: 'cloud-a' });
    mock.fetch.mockResolvedValueOnce(new Response(null, { status }));
    await vi.advanceTimersByTimeAsync(30_000);
    const count = mock.fetch.mock.calls.length;
    await expect(call('read', { handle, domains: ['memory'] })).rejects.toThrow('SCOPE_CHANGED');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(mock.fetch).toHaveBeenCalledTimes(count);
    expect(f.history).toEqual([]);
  },
);
it('a temporary heartbeat outage allows recovery but never retries a configuration write', async () => {
  const { handle } = await call('open', { deviceId: 'cloud-a' });
  mock.fetch.mockRejectedValueOnce(Error('fixture network outage'));
  await vi.advanceTimersByTimeAsync(30_000);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(mock.fetch.mock.calls.filter(([url]) => String(url).endsWith('/heartbeat'))).toHaveLength(
    2,
  );
  await expect(call('read', { handle, domains: ['memory'] })).resolves.toBeDefined();
  expect(
    f.history.every((command) => command.kind === 'read' || command.kind === 'readBatch'),
  ).toBe(true);
});
it.each(['destroyed', 'render-process-gone', 'navigation'])(
  'invalidates handles after renderer %s',
  async (type) => {
    const { handle } = await call('open', { deviceId: 'cloud-a' });
    if (type === 'navigation')
      sender.emit('did-start-navigation', {}, 'https://other.example.test', false, true);
    else sender.emit(type);
    const count = mock.fetch.mock.calls.length;
    await expect(call('read', { handle, domains: ['memory'] })).rejects.toThrow('SCOPE_CHANGED');
    expect(mock.fetch).toHaveBeenCalledTimes(count);
  },
);

// The auxiliary window has its own capability surface: even a trusted main
// renderer must not submit/poll another window's login or bypass input validation.
it('rejects cross-window login actions and invalid open parameters before network access', async () => {
  const invoke = (channel: string, raw: unknown) => handler(channel)(event, raw);
  await expect(invoke(CLOUD_LOGIN_WINDOW.open, { deviceId: 'cloud-a', owner: 'forged' })).rejects.toThrow('INVALID_PARAMS');
  await expect(invoke(CLOUD_LOGIN_WINDOW.start, { generation: 1 })).rejects.toThrow('SCOPE_CHANGED');
  await expect(invoke(CLOUD_LOGIN_WINDOW.state, {})).rejects.toThrow('SCOPE_CHANGED');
  event.trusted = false;
  await expect(invoke(CLOUD_LOGIN_WINDOW.open, { deviceId: 'cloud-a' })).rejects.toThrow('PERMISSION_DENIED');
  expect(mock.fetch).not.toHaveBeenCalled();
});

it('checks the owned login-required target without requesting maintenance or waking it', async () => {
  const target = { instanceId: 'instance-a', deviceId: 'cloud-a', customLabel: null, nameSequence: 1,
    status: { instanceId: 'instance-a', deviceId: 'cloud-a', desiredState: 'stopped', runtimeState: 'missing',
      image: 'registry.example.test/cloud:0.1.113', readiness: { ready: false }, updateAvailable: false,
      latestReleaseTag: null, upgrade: { state: 'idle' }, loginRequired: false } };
  mock.fetch.mockResolvedValueOnce(Response.json({ instances: [target] }));
  const open = handler(CLOUD_LOGIN_WINDOW.open);
  await expect(open(event, { deviceId: 'cloud-a' })).rejects.toThrow('CONFLICT');
  mock.fetch.mockResolvedValueOnce(Response.json({ instances: [{ ...target, status: { ...target.status, loginRequired: true } }] }));
  // Fixture window creation deliberately fails. Reaching that stage proves an
  // uninitialized instance doesn't need a maintenance runtime to open login.
  await expect(open(event, { deviceId: 'cloud-a' })).rejects.toThrow('CLOUD_SETTINGS_UNAVAILABLE');
  expect(mock.fetch).toHaveBeenCalledTimes(2);
  expect(mock.fetch.mock.calls.every(([url, init]) => String(url).endsWith('/manage/instances') && init?.method === 'GET')).toBe(true);
});
