// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getBundledEndpointManifest } from '@cindy/maker-shared/client-endpoints';

const h = vi.hoisted(() => ({
  auth: { user: { id: 'phone-owner' }, accountGeneration: 1, apiFetch: vi.fn(), getAccessToken: vi.fn() },
  storage: new Map<string, string>(),
  sockets: [] as any[],
}));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => h.auth }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: {
  getItem: async (key: string) => h.storage.get(key) ?? null,
  setItem: async (key: string, value: string) => { h.storage.set(key, value); },
} }));
vi.mock('react-native', () => ({ AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) } }));
vi.mock('expo-router', async () => { const { useEffect } = await import('react'); return { useFocusEffect: (fn: any) => useEffect(fn, [fn]) }; });

const bases = { cn: 'https://hotfix.cindy.com.cn/cindy', global: 'https://hotfix.cindy.app/cindy' };
const texts = Object.fromEntries(Object.entries(bases).map(([region, base]) => [region,
  process.env.CINDY_CHAT_PUBLIC_MANIFEST_DIR
    ? readFileSync(join(process.env.CINDY_CHAT_PUBLIC_MANIFEST_DIR, `${region}.json`), 'utf8')
    : getBundledEndpointManifest(region as 'cn' | 'global', `${base}/endpoint.json`)!,
])) as Record<'cn' | 'global', string>;
const roomId = '00000000-0000-4000-8000-000000000001';
const self = '00000000-0000-4000-8000-000000000002';
const room = { id: roomId, kind: 'group', state: 'joined', name: 'Fixture', archived: false,
  revision: 1, head: '1', created_at: '2026-10-09', updated_at: '2026-10-09', response_mode: 'all', speaking_mode: 'auto' };
let root: Root | undefined;
let roster: any;
let group: any;
let hooks: typeof import('@/chat/useChatServer');
function Probe() { roster = hooks.useChatServerRoster(true); group = hooks.useChatServerGroup(roomId, true); return null; }
async function render() { root ??= createRoot(document.createElement('div')); await act(async () => root!.render(createElement(Probe))); }
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); h.storage.clear(); h.sockets = [];
  vi.stubGlobal('__DEV__', false);
  vi.stubEnv('EXPO_PUBLIC_CINDY_AUTH_REGION', 'global');
  vi.stubEnv('EXPO_PUBLIC_ENDPOINT_MANIFEST_BASE_URL', bases.global);
  vi.stubEnv('EXPO_PUBLIC_ENDPOINT_MANIFEST_PEER_BASE_URL', bases.cn);
  h.auth.user = { id: 'phone-owner' }; h.auth.accountGeneration = 1;
  h.auth.getAccessToken.mockImplementation(async () => `fixture-token:${h.auth.user.id}`);
  h.auth.apiFetch.mockImplementation(async (path: string, options: any) => {
    options.assertCurrent();
    if (path === '/v1/me') return { actor: { id: self, kind: 'human' } };
    if (path.startsWith('/v1/conversations?')) return [room];
    if (path.endsWith('/snapshot')) return { room, members: [], messages: [], cursor: '1' };
    if ((path.endsWith('/executions') || path.includes('/execution-failures?'))) return [];
    if (path.includes('/messages?')) return [];
    if (path.includes('/changes?')) return { head: '1' };
    if (options.method === 'POST') return { id: self };
    throw new Error('Unexpected fixture request');
  });
  vi.stubGlobal('WebSocket', class {
    readyState = 1; onopen?: Function; onmessage?: Function; onclose?: Function; onerror?: Function;
    send = vi.fn(); close = vi.fn();
    constructor(public url: string) { h.sockets.push(this); }
  });
});
afterEach(() => { act(() => root?.unmount()); root = undefined; vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it.each(['cn', 'global'] as const)('release %s discovery feeds HTTP, WS and the phone owner identity', async region => {
  vi.stubEnv('EXPO_PUBLIC_CINDY_AUTH_REGION', region);
  vi.stubEnv('EXPO_PUBLIC_ENDPOINT_MANIFEST_BASE_URL', bases[region]);
  vi.stubEnv('EXPO_PUBLIC_ENDPOINT_MANIFEST_PEER_BASE_URL', bases[region === 'cn' ? 'global' : 'cn']);
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => texts[region] })));
  const startup = await import('@/config/clientEndpointStartup');
  const env = await import('@/config/env');
  expect(() => env.getMobileEndpointForRealm(region, 'chatApiBaseUrl')).toThrow();
  expect(await startup.runStartupEndpointResolve()).toEqual({ ok: true, source: 'cdn' });
  hooks = await import('@/chat/useChatServer'); await render();
  const endpoint = JSON.parse(texts[region]).chatApiBaseUrl;
  expect(roster.items).toHaveLength(1); expect(group.state.kind).toBe('ready');
  expect(h.auth.apiFetch.mock.calls.every(([, options]) => options.baseUrl === endpoint)).toBe(true);
  expect(h.sockets.length).toBeGreaterThan(0);
  const ws = new URL(endpoint); ws.protocol = 'wss:'; ws.pathname = '/v1/ws';
  expect(h.sockets.every(socket => socket.url === ws.href)).toBe(true);
  await act(async () => h.sockets.forEach(socket => socket.onopen({})));
  expect(h.sockets[0].send).toHaveBeenCalledWith(JSON.stringify({ type: 'auth', token: 'fixture-token:phone-owner' }));
  await act(async () => { await group.act('send', { text: 'fixture', clientId: 'fixture-operation', mentions: { all: false, botIds: [] } }); });
  const sent = h.auth.apiFetch.mock.calls.find(([path, options]) => path.endsWith('/messages') && options.method === 'POST')!;
  expect(sent[1].body).toEqual({ operationId: 'fixture-operation', content: [{ type: 'text', text: 'fixture' }], mentions: [] });
  const oldSockets = [...h.sockets];
  const other = region === 'cn' ? 'global' : 'cn';
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => texts[other] })));
  await env.loadMobileEndpointsForRealm(other); env.activateMobileSessionRealm(other);
  h.auth.user = { id: 'another-phone-owner' }; h.auth.accountGeneration++;
  h.auth.apiFetch.mockClear(); await render();
  expect(oldSockets.every(socket => socket.close.mock.calls.length > 0)).toBe(true);
  expect(h.auth.apiFetch.mock.calls.every(([, options]) => options.baseUrl === JSON.parse(texts[other]).chatApiBaseUrl)).toBe(true);
  await act(async () => h.sockets.filter(socket => !oldSockets.includes(socket)).forEach(socket => socket.onopen({})));
  expect(h.sockets.at(-1).send).toHaveBeenCalledWith(JSON.stringify({ type: 'auth', token: 'fixture-token:another-phone-owner' }));
});

it('old cached discovery without chat reports configuration failure and retries the trusted source', async () => {
  vi.useFakeTimers();
  const sourceUrl = `${bases.global}/endpoint.json`;
  const old = JSON.parse(texts.global); delete old.chatApiBaseUrl;
  h.storage.set(`cindy.mobile.endpoint-manifest.v1.global.${encodeURIComponent(sourceUrl)}`, JSON.stringify({
    savedAt: '2026-10-09T00:00:00Z', sourceUrl, manifestText: JSON.stringify(old),
  }));
  const fetch = vi.fn().mockRejectedValue(new TypeError('offline')); vi.stubGlobal('fetch', fetch);
  const startup = await import('@/config/clientEndpointStartup');
  expect(await startup.runStartupEndpointResolve()).toEqual({ ok: true, source: 'cache' });
  hooks = await import('@/chat/useChatServer'); await render();
  expect(roster.error).toBe('CHAT_ENDPOINT_UNAVAILABLE');
  expect(group.state).toEqual({ kind: 'error', message: 'CHAT_ENDPOINT_UNAVAILABLE' });
  expect(h.auth.apiFetch).not.toHaveBeenCalled(); expect(h.sockets).toHaveLength(0);
  fetch.mockResolvedValue({ ok: true, text: async () => texts.global });
  await act(async () => { await roster.refresh(); group.reload(); });
  expect(roster.error).toBeNull(); expect(group.state.kind).toBe('ready');
  await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
  expect(h.sockets.length).toBeGreaterThan(0);
});

it('invalid discovered chat URL blocks startup; a corrected trusted manifest recovers', async () => {
  const manifest = JSON.parse(texts.global); manifest.chatApiBaseUrl = 'http://chat.example.invalid';
  const fetch = vi.fn(async () => ({ ok: true, text: async () => JSON.stringify(manifest) }));
  vi.stubGlobal('fetch', fetch);
  const startup = await import('@/config/clientEndpointStartup');
  expect(await startup.runStartupEndpointResolve()).toMatchObject({ ok: false });
  expect(h.auth.apiFetch).not.toHaveBeenCalled();
  manifest.chatApiBaseUrl = JSON.parse(texts.global).chatApiBaseUrl;
  expect(await startup.runStartupEndpointResolve()).toEqual({ ok: true, source: 'cdn' });
});
