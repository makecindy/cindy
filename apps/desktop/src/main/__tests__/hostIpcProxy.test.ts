/*
 * 测试价值
 * - 生产入口与可观察结果：createHostIpcProxy().invoke 与 registerHostIpcProxies 注册的 IPC 处理函数；
 *   界面收到的结果或 `[CODE] message` 错误，以及代理实际向 Host 发了哪些请求、发了几次。
 * - Bug／规则依据：docs/host/headless-runtime-plan.md 第 1a 批代理设计——未协商的通道一律 UNSUPPORTED、
 *   账号变化不重试且只刷新一次、断线后合并重连、只读条目满足三条才重试一次、超时中止、
 *   发送方校验先于转发；协商失败不缓存（只缓存明确答复）；启动器钉住 instance 时不换绑（窗口其余部分
 *   仍对着原 instance）；Host 正在停止按断线处理。
 * - 现有覆盖缺口：新模块；hostDelegation.test.ts 只覆盖逐条手写的专用路由。
 * - 最小失败输入：旧 Host（无清单）、指纹不符、owner_scope_changed、host_instance_changed 后换账号、
 *   Host 不回包、外部页面发起调用、清单超时一次、钉住时 Host 换了实例、503 host_stopping。
 * - tier：unit（进程内假 Host 的 fetch，无网络）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ fromWebContents: vi.fn() }));
vi.mock('electron', () => ({ BrowserWindow: { fromWebContents: mocks.fromWebContents } }));

import {
  HOST_IPC_ENTRIES, HOST_IPC_MANIFEST_TIMEOUT_MS, findHostIpcEntry, hostIpcFingerprint, type HostIpcEntry,
} from '@cindy/maker-shared/host-ipc-registry';

import { createHostIpcProxy, registerHostIpcProxies, type HostIpcOwnerView } from '../host-ipc-proxy';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer';
import { markAppContentWindow } from '../windowFocusClassifier';

const ENTRY = findHostIpcEntry('maker:side-chat:list:v1')!;
const FINGERPRINT = hostIpcFingerprint(ENTRY);
type Reply = { status: number; body: unknown };
type Call = { headers: Record<string, string>; body: { args: unknown[]; owner: unknown }; signal: AbortSignal };

/** In-process Host: answers the four paths the proxy uses and records every call. */
function fakeHost() {
  const host = {
    instanceId: 'host-a',
    ready: true,
    route: true,
    offered: new Map([[ENTRY.channel, FINGERPRINT]]),
    auth: { dataOwnerId: 'owner-1', ownerGeneration: 1, canEnterApp: true } as HostIpcOwnerView,
    replies: [] as Array<(call: Call) => Reply | Promise<Reply>>,
    /** One-shot manifest behaviour; `undefined` answers normally. */
    manifestOnce: [] as Array<(signal: AbortSignal) => Reply | Promise<Reply>>,
    counts: { attachment: 0, manifest: 0, auth: 0 },
    ipc: [] as Call[],
  };
  const fetch = vi.fn(async (url: string, init: { headers: Record<string, string>; body: string; signal: AbortSignal }) => {
    const path = new URL(url).pathname;
    const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
    if (path === '/control/attachment') {
      host.counts.attachment++;
      return reply(200, { protocol: 1, instanceId: host.instanceId, ready: host.ready });
    }
    if (path === '/control/ipc-manifest') {
      host.counts.manifest++;
      const once = host.manifestOnce.shift();
      if (once) { const answer = await once(init.signal); return reply(answer.status, answer.body); }
      if (!host.route) return reply(404, { error: 'not_found' });
      if (init.headers['x-cindy-host-instance'] !== host.instanceId) return reply(409, { error: 'host_instance_changed' });
      return reply(200, { protocol: 1, instanceId: host.instanceId,
        entries: [...host.offered].map(([channel, fingerprint]) => ({ channel, fingerprint })) });
    }
    if (path === '/api/auth/state') { host.counts.auth++; return reply(200, host.auth); }
    const call = { headers: init.headers, body: JSON.parse(init.body), signal: init.signal };
    host.ipc.push(call);
    const next = host.replies.shift();
    const answer = next ? await next(call) : { status: 200, body: { ok: true, result: [{ id: 'child' }] } };
    return reply(answer.status, answer.body);
  });
  let view: HostIpcOwnerView = { ...host.auth };
  const applied: unknown[] = [];
  const logs: string[] = [];
  const proxy = (pinned: string | null = 'host-a') => createHostIpcProxy({
    baseUrl: 'http://127.0.0.1:1', token: 'tok', instanceId: pinned ?? undefined, fetch: fetch as unknown as typeof globalThis.fetch,
    readOwner: () => view,
    applyAuthState: (state) => { applied.push(state); view = state as HostIpcOwnerView; },
    log: (message) => { logs.push(message); },
  });
  return { host, fetch, proxy, applied, logs };
}

const rejection = (code: string): Reply => ({ status: 409, body: { ok: false, error: { code, message: code } } });

describe('host IPC proxy', () => {
  it('forwards with the instance, contract and owner stamp, and restores typed Host errors', async () => {
    const { host, proxy } = fakeHost();
    const unpinned = proxy(null);
    await expect(unpinned.invoke(ENTRY, ['parent'])).resolves.toEqual([{ id: 'child' }]);
    // Without a launcher pin the instance is learned before anything is forwarded.
    expect(host.counts.attachment).toBe(1);
    expect(host.ipc[0]!.headers).toMatchObject({ authorization: 'Bearer tok', 'x-cindy-host-instance': 'host-a',
      'x-cindy-ipc-contract': FINGERPRINT });
    expect(host.ipc[0]!.body).toEqual({ args: ['parent'], owner: { dataOwnerId: 'owner-1', ownerGeneration: 1 } });

    host.replies.push(() => ({ status: 404, body: { ok: false, error: { code: 'NOT_FOUND', message: 'Source task is unavailable' } } }));
    await expect(unpinned.invoke(ENTRY, ['parent'])).rejects.toMatchObject({
      code: 'NOT_FOUND', message: '[NOT_FOUND] Source task is unavailable' });
    expect(host.counts.manifest).toBe(1);
  });

  it.each([
    ['an older Host without the route', (h: ReturnType<typeof fakeHost>['host']) => { h.route = false; }],
    ['a Host that does not offer the channel', (h: ReturnType<typeof fakeHost>['host']) => { h.offered.clear(); }],
    ['a Host with another contract', (h: ReturnType<typeof fakeHost>['host']) => { h.offered.set(ENTRY.channel, 'other'); }],
  ])('answers UNSUPPORTED_CAPABILITY for %s without calling the channel', async (_label, setup) => {
    const { host, proxy } = fakeHost();
    setup(host);
    const client = proxy();
    await expect(client.invoke(ENTRY, ['parent'])).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    await expect(client.invoke(ENTRY, ['parent'])).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    expect(host.ipc).toHaveLength(0);
    // Negotiated once per instance; a reconnect renegotiates.
    expect(host.counts.manifest).toBe(1);
    client.invalidate();
    await expect(client.invoke(ENTRY, ['parent'])).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    expect(host.counts.manifest).toBe(2);
  });

  it('stops forwarding a channel the Host reports as a contract mismatch', async () => {
    const { host, proxy } = fakeHost();
    const client = proxy();
    host.replies.push(() => rejection('contract_mismatch'));
    await expect(client.invoke(ENTRY, ['parent'])).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    await expect(client.invoke(ENTRY, ['parent'])).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    expect(host.ipc).toHaveLength(1);
  });

  it('an account change fails each call without retry and refreshes the auth state once for all of them', async () => {
    const { host, proxy, applied } = fakeHost();
    const client = proxy();
    host.auth = { dataOwnerId: 'owner-2', ownerGeneration: 2, canEnterApp: true };
    host.replies.push(...Array.from({ length: 3 }, () => () => rejection('owner_scope_changed')));
    const results = await Promise.allSettled([1, 2, 3].map(() => client.invoke(ENTRY, ['parent'])));
    expect(results.map((r) => r.status === 'rejected' && (r.reason as { code?: string }).code))
      .toEqual(['OWNER_CHANGED', 'OWNER_CHANGED', 'OWNER_CHANGED']);
    await vi.waitFor(() => expect(applied).toHaveLength(1));
    expect(host.counts.auth).toBe(1);
    expect(host.ipc).toHaveLength(3);
    // The next call carries the account the windows now show.
    await client.invoke(ENTRY, ['parent']);
    expect(host.ipc[3]!.body.owner).toEqual({ dataOwnerId: 'owner-2', ownerGeneration: 2 });
  });

  type Host = ReturnType<typeof fakeHost>['host'];
  it.each<[string, 'pinned' | 'unpinned', 'instance' | 'connection', (h: Host) => void, string | null, number]>([
    // [scenario, launcher pin, first failure, Host state after it, expected error (null = success), forwarded calls]
    // Only an unpinned proxy follows a replaced Host.
    ['same account on a new instance', 'unpinned', 'instance', (h) => { h.instanceId = 'host-b'; h.auth = { ...h.auth, ownerGeneration: 7 }; }, null, 2],
    ['a Host that is not ready', 'unpinned', 'instance', (h) => { h.instanceId = 'host-b'; h.ready = false; }, 'CONNECTION_FAILED', 1],
    ['another account', 'unpinned', 'instance', (h) => { h.instanceId = 'host-b'; h.auth = { ...h.auth, dataOwnerId: 'owner-2' }; }, 'OWNER_CHANGED', 1],
    ['a contract that is gone', 'unpinned', 'instance', (h) => { h.instanceId = 'host-b'; h.offered.clear(); }, 'UNSUPPORTED_CAPABILITY', 1],
    // Pinned: a replaced Host is a lost connection, even for the same account.
    ['same account on a new instance while pinned', 'pinned', 'instance', (h) => { h.instanceId = 'host-b'; }, 'CONNECTION_FAILED', 1],
    // Same process: generations are comparable, so a newer one is an account boundary.
    ['the same instance with a newer generation', 'pinned', 'connection', (h) => { h.auth = { ...h.auth, ownerGeneration: 2 }; }, 'OWNER_CHANGED', 1],
    ['the same instance after a dropped connection', 'pinned', 'connection', () => undefined, null, 2],
  ])('after a lost Host, retries a read once only for %s', async (_label, pin, failure, change, expected, forwarded) => {
    const { host, proxy } = fakeHost();
    const client = proxy(pin === 'pinned' ? 'host-a' : null);
    host.replies.push(() => {
      change(host);
      if (failure === 'connection') throw new TypeError('fetch failed');
      return { status: 409, body: { error: 'host_instance_changed' } };
    });
    const outcome = client.invoke(ENTRY, ['parent']);
    if (expected) await expect(outcome).rejects.toMatchObject({ code: expected });
    else await expect(outcome).resolves.toEqual([{ id: 'child' }]);
    expect(host.ipc).toHaveLength(forwarded);
  });

  it('a pinned proxy never moves to a replaced Host instance', async () => {
    const { host, proxy, logs } = fakeHost();
    const client = proxy('host-a');
    host.instanceId = 'host-b';
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(client.invoke(ENTRY, ['parent'])).rejects.toMatchObject({ code: 'CONNECTION_FAILED' });
    }
    // Negotiation is refused for host-a and the attachment's host-b is not adopted.
    expect(host.counts.attachment).toBe(2);
    expect(host.ipc).toHaveLength(0);
    expect(logs.filter((line) => line.includes('pinned instance'))).toHaveLength(2);
    // The window's other channels recover once the pinned instance answers again.
    host.instanceId = 'host-a';
    await expect(client.invoke(ENTRY, ['parent'])).resolves.toEqual([{ id: 'child' }]);
    expect(host.ipc.every((call) => call.headers['x-cindy-host-instance'] === 'host-a')).toBe(true);
  });

  it('does not keep a failed negotiation: a timeout fails one call and the next call negotiates again', async () => {
    vi.useFakeTimers();
    try {
      const { host, proxy } = fakeHost();
      const client = proxy();
      host.manifestOnce.push((signal) => new Promise<Reply>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      }));
      const first = expect(client.invoke(ENTRY, ['parent'])).rejects.toMatchObject({ code: 'CONNECTION_TIMEOUT' });
      await vi.advanceTimersByTimeAsync(HOST_IPC_MANIFEST_TIMEOUT_MS);
      await first;
      expect(host.ipc).toHaveLength(0);
      // Host answers again; no invalidate() (the event stream never dropped).
      await expect(client.invoke(ENTRY, ['parent'])).resolves.toEqual([{ id: 'child' }]);
      expect(host.counts.manifest).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each<[string, Reply | 'drop', string | null]>([
    // [manifest answer, expected error for this call (null = re-attached and retried)]
    ['a dropped connection', 'drop', null],
    ['a stopping Host', { status: 503, body: { error: 'host_stopping' } }, null],
    ['an unexpected status', { status: 500, body: { error: 'internal' } }, 'CONNECTION_FAILED'],
    ['a malformed manifest', { status: 200, body: { protocol: 1, instanceId: 'host-a' } }, 'CONNECTION_FAILED'],
  ])('a negotiation that fails with %s is not cached', async (_label, answer, expected) => {
    const { host, proxy } = fakeHost();
    const client = proxy();
    host.manifestOnce.push(() => {
      if (answer === 'drop') throw new TypeError('fetch failed');
      return answer;
    });
    const outcome = client.invoke(ENTRY, ['parent']);
    if (expected) await expect(outcome).rejects.toMatchObject({ code: expected });
    else await expect(outcome).resolves.toEqual([{ id: 'child' }]);
    await expect(client.invoke(ENTRY, ['parent'])).resolves.toEqual([{ id: 'child' }]);
    // Failed once, asked again on the next attempt; then kept.
    expect(host.counts.manifest).toBe(2);
    // Only a lost connection re-attaches (pinned: same instance, so the read is retried).
    expect(host.counts.attachment).toBe(expected ? 0 : 1);
  });

  it('a Host that stops during a call is a lost connection, not an internal error', async () => {
    const { host, proxy } = fakeHost();
    const client = proxy();
    host.replies.push(() => { host.ready = false; return { status: 503, body: { error: 'host_stopping' } }; });
    await expect(client.invoke(ENTRY, ['parent'])).rejects.toMatchObject({ code: 'CONNECTION_FAILED' });
    expect(host.counts.attachment).toBe(1);
  });

  it('shares one re-attachment and one negotiation among concurrent calls, and retries after a lost connection', async () => {
    const { host, fetch, proxy } = fakeHost();
    // Unpinned: the proxy may follow the replaced Host.
    const client = proxy(null);
    await client.invoke(ENTRY, ['parent']);
    expect(host.counts).toEqual({ attachment: 1, manifest: 1, auth: 0 });
    host.replies.push(...Array.from({ length: 3 }, () => () => {
      host.instanceId = 'host-b';
      return { status: 409, body: { error: 'host_instance_changed' } };
    }));
    await expect(Promise.all([1, 2, 3].map(() => client.invoke(ENTRY, ['parent'])))).resolves.toHaveLength(3);
    expect(host.counts).toEqual({ attachment: 2, manifest: 2, auth: 1 });
    expect(host.ipc).toHaveLength(7);

    // A dropped connection (fetch throws) re-attaches to the same instance and retries once.
    fetch.mockImplementationOnce(async () => { throw new TypeError('fetch failed'); });
    await expect(client.invoke(ENTRY, ['parent'])).resolves.toEqual([{ id: 'child' }]);
    expect(host.counts.attachment).toBe(3);
  });

  it('aborts a call after the entry timeout (embedded IPC has none)', async () => {
    const { host, proxy } = fakeHost();
    let signal: AbortSignal | undefined;
    host.replies.push((call) => new Promise<Reply>((_resolve, reject) => {
      signal = call.signal;
      call.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    const quick: HostIpcEntry = { ...ENTRY, timeoutMs: 20 };
    await expect(proxy().invoke(quick, ['parent'])).rejects.toMatchObject({ code: 'CONNECTION_TIMEOUT' });
    expect(signal?.aborted).toBe(true);
    expect(host.ipc).toHaveLength(1);
  });
});

describe('client-mode registration', () => {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const ipcMain = {
    removeHandler: (channel: string) => handlers.delete(channel),
    handle: (channel: string, listener: (event: never, ...args: unknown[]) => unknown) => { handlers.set(channel, listener as never); },
  };
  function event(kind: 'trusted' | 'external' | 'child') {
    const frame = { url: kind === 'external' ? 'https://untrusted.example/' : 'http://localhost:5173/', parent: null };
    const win = { isDestroyed: () => false };
    markAppContentWindow(win as never);
    mocks.fromWebContents.mockReturnValue(win);
    return { sender: { mainFrame: frame }, senderFrame: kind === 'child' ? { ...frame, parent: frame } : frame };
  }
  beforeEach(() => {
    vi.stubGlobal('MAIN_WINDOW_VITE_DEV_SERVER_URL', 'http://localhost:5173/');
    vi.stubGlobal('MAIN_WINDOW_VITE_NAME', 'main_window');
    handlers.clear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('admits the sender with the embedded check before any Host request', async () => {
    const { host, proxy } = fakeHost();
    expect(registerHostIpcProxies({ ipcMain, proxy: proxy(), admit: { 'trusted-app-renderer': assertTrustedAppRendererEvent } }))
      .toEqual(HOST_IPC_ENTRIES.map((entry) => entry.channel));
    const handler = handlers.get(ENTRY.channel)!;
    for (const kind of ['external', 'child'] as const) {
      await expect(Promise.resolve().then(() => handler(event(kind), 'parent'))).rejects.toThrow('[PERMISSION_DENIED]');
    }
    expect(host.ipc).toHaveLength(0);
    await expect(handler(event('trusted'), 'parent')).resolves.toEqual([{ id: 'child' }]);
    expect(host.ipc[0]!.body.args).toEqual(['parent']);
  });

  it('refuses to register an entry whose sender check is not provided', () => {
    const { proxy } = fakeHost();
    expect(() => registerHostIpcProxies({ ipcMain, proxy: proxy(), admit: {} as never })).toThrow(/No sender admission/);
    expect(handlers.size).toBe(0);
  });
});
