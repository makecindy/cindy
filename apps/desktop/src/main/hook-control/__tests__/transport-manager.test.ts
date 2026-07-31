/**
 * transport + manager 集成测试(provider 独立连接 + JWT 形态): 对真实 ws server
 * (WebSocketServer, 端口 0)跑完整行为 —— 登录 token 鉴权头、hello 自报
 * 别名、welcome 后状态 connected、ping 自动回 pong、dispatch 的 stub ack、
 * 未登录不发起连接、setEnabled(false) 停线。依赖全部注入, 不需要 Electron。
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { Duplex } from 'node:stream';

import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  HOOK_FEATURE_LIFECYCLE_ANNOUNCEMENT,
  HOOK_FEATURE_MULTI_TEAM,
  HOOK_FEATURE_PROVIDER_BIND,
  HOOK_FEATURE_PROVIDER_PREFS,
  HOOK_FEATURE_PROVIDER_TELEGRAM,
  HOOK_FEATURE_SESSION_PICKER,
  HOOK_FEATURE_SLACK_TOOLS,
  makeBindState,
  makeBindUpdate,
  makePing,
  makePrefsState,
  makeProviderBindState,
  makeProviderBindUpdate,
  makeProviderPrefsState,
  makeQueryRequest,
  makeTaskDispatch,
  makeToolResponse,
  makeWelcome,
  parseHookMessage,
  serializeHookMessage,
  type HookMessage,
  type ProviderBindStatusPayload,
} from '@cindy/slack-hook-protocol';

import {
  createHookControlManager,
  hookNotConnectedIpcMessage,
  HookNotConnectedError,
  HookPrefsTimeoutError,
  providerForExternalKey,
  providerForTaskDispatch,
  type HookControlManagerDeps,
} from '../manager';
import {
  computeBackoffDelayMs,
  createHookTransport,
  type HookTransportOpts,
} from '../transport';
import type { SlackHookStore, SlackHookConfigState } from '../store';

const noopLog = { info: () => {}, warn: () => {} };

/** 内存版单配置 store。 */
function memoryStore(initial: Partial<SlackHookConfigState> & { url: string }): SlackHookStore {
  let state: SlackHookConfigState = {
    enabled: initial.enabled ?? true,
    telegramEnabled: initial.telegramEnabled ?? false,
    xEnabled: initial.xEnabled ?? false,
    urlOverride: initial.url,
    workspaces: initial.workspaces ?? {},
    bindingsCache: initial.bindingsCache ?? [],
    lifecycleAnnouncementOverride: initial.lifecycleAnnouncementOverride ?? null,
    telegramBindingCache: initial.telegramBindingCache ?? null,
    xBindingCache: initial.xBindingCache ?? null,
  };
  return {
    get: () => ({
      ...state,
      workspaces: { ...state.workspaces },
      bindingsCache: state.bindingsCache.map((e) => ({ ...e })),
      telegramBindingCache: state.telegramBindingCache ? { ...state.telegramBindingCache } : null,
      xBindingCache: state.xBindingCache ? { ...state.xBindingCache } : null,
    }),
    effectiveUrl: () => state.urlOverride ?? 'wss://unused.example',
    setEnabled(enabled) {
      state = { ...state, enabled };
      return state;
    },
    setProviderEnabled(provider, enabled) {
      state =
        provider === 'slack'
          ? { ...state, enabled }
          : provider === 'x'
            ? { ...state, xEnabled: enabled }
            : { ...state, telegramEnabled: enabled };
      return state;
    },
    anyProviderEnabled() {
      return state.enabled || state.telegramEnabled || state.xEnabled;
    },
    setWorkspaces(workspaces) {
      state = { ...state, workspaces };
      return state;
    },
    setBindingsCache(entries) {
      state = { ...state, bindingsCache: entries.map((e) => ({ ...e })) };
      return state;
    },
    setLifecycleAnnouncementOverride(enabled) {
      state = { ...state, lifecycleAnnouncementOverride: enabled };
      return state;
    },
    setProviderBindingCache(provider, entry) {
      state =
        provider === 'x'
          ? { ...state, xBindingCache: entry ? { ...entry } : null }
          : { ...state, telegramBindingCache: entry ? { ...entry } : null };
      return state;
    },
  };
}

function makeManager(
  store: SlackHookStore,
  overrides: Partial<HookControlManagerDeps> = {},
): ReturnType<typeof createHookControlManager> {
  return createHookControlManager({
    store,
    createTransport: createHookTransport,
    getTelegramUrl: () => store.effectiveUrl(),
    // X lane 默认不配端点(未部署形态), 相关用例用 overrides 显式注入。
    getXUrl: () => '',
    getAuthToken: async () => 'jwt-token-1',
    refreshAuthToken: async () => false,
    deviceInfo: () => ({ deviceId: 'dev-1', deviceName: 'TestBox' }),
    agents: ['claude-code', 'codex'],
    notifyStatus: () => {},
    autoBindDeferMs: 5,
    log: noopLog,
    ...overrides,
  });
}

/** server 侧帧收集器: 逐帧 parse, 按需等待某类型消息。 */
function collectFrames(sock: ServerSocket) {
  const frames: HookMessage[] = [];
  const waiters: Array<{ type: string; resolve: (m: HookMessage) => void }> = [];
  sock.on('message', (data) => {
    const parsed = parseHookMessage(data.toString());
    if (!parsed.ok) throw new Error(`server got bad frame: ${parsed.error}`);
    frames.push(parsed.message);
    const idx = waiters.findIndex((w) => w.type === parsed.message.type);
    if (idx >= 0) waiters.splice(idx, 1)[0].resolve(parsed.message);
  });
  return {
    frames,
    waitFor(type: HookMessage['type']): Promise<HookMessage> {
      const hit = frames.find((f) => f.type === type);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve) => waiters.push({ type, resolve }));
    },
  };
}

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.reverse()) fn();
  cleanups = [];
});

describe('hook-control runtime capability gate', () => {
  it('keeps an enabled cloud preference disconnected when the capability is unavailable', () => {
    const createTransport = vi.fn(() => {
      throw new Error('transport must not start');
    }) as unknown as HookControlManagerDeps['createTransport'];
    const manager = makeManager(
      memoryStore({
        url: 'wss://hook.example',
        enabled: true,
        telegramEnabled: true,
      }),
      { isAvailable: () => false, createTransport },
    );

    manager.sync();

    expect(createTransport).not.toHaveBeenCalled();
    manager.dispose();
  });

  it('cold-start activation connects an enabled Hook after the owner DB becomes ready', () => {
    const dispose = vi.fn();
    const createTransport = vi.fn((_opts: HookTransportOpts) => ({
      send: () => true,
      dispose,
    }));
    const manager = makeManager(
      memoryStore({
        url: 'wss://hook.example',
        enabled: true,
      }),
      {
        accountInitiallyActive: false,
        isAvailable: () => true,
        createTransport,
      },
    );

    manager.sync();
    expect(createTransport).not.toHaveBeenCalled();

    manager.activateAccount();
    expect(createTransport).toHaveBeenCalledOnce();
    expect(manager.snapshot().status).toBe('connecting');

    manager.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('leaving local mode reconnects only after a cloud account lifecycle activates', async () => {
    let available = false;
    const createTransport = vi.fn((_opts: HookTransportOpts) => ({
      send: () => true,
      dispose: () => {},
    }));
    const manager = makeManager(
      memoryStore({
        url: 'wss://hook.example',
        enabled: true,
      }),
      {
        accountInitiallyActive: false,
        isAvailable: () => available,
        createTransport,
      },
    );

    manager.activateAccount();
    expect(createTransport).not.toHaveBeenCalled();

    await manager.deactivateAccount();
    available = true;
    manager.activateAccount();
    expect(createTransport).toHaveBeenCalledOnce();

    manager.dispose();
  });

  it('late dispatch during owner shutdown receives a structured disabled ack', async () => {
    const transportOpts: HookTransportOpts[] = [];
    const createTransport = vi.fn((opts: HookTransportOpts) => {
      transportOpts.push(opts);
      return {
        send: () => true,
        dispose: () => {},
      };
    });
    const manager = makeManager(
      memoryStore({
        url: 'wss://hook.example',
        enabled: true,
      }),
      { createTransport },
    );
    manager.sync();
    await manager.deactivateAccount();

    const staleOnMessage = transportOpts[0]?.onMessage;
    if (!staleOnMessage) throw new Error('transport callback was not captured');
    const sent: HookMessage[] = [];
    staleOnMessage(
      makeTaskDispatch({
        requestId: 'late-owner-dispatch',
        externalKey: 'slack:C1:1.1',
        workspace: 'chat',
        prompt: 'must not cross the owner boundary',
      }),
      (message) => {
        sent.push(message);
        return true;
      },
    );

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: 'task.ack',
      payload: {
        requestId: 'late-owner-dispatch',
        result: 'rejected',
        reason: 'disabled',
      },
    });

    manager.dispose();
  });
});

async function startServer(): Promise<{ wss: WebSocketServer; url: string }> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(wss, 'listening');
  const addr = wss.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  cleanups.push(() => wss.close());
  return { wss, url: `ws://127.0.0.1:${addr.port}` };
}

async function startUpgradeServer(
  onUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => void,
): Promise<{ url: string }> {
  const server = createServer((_req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(404).end();
  });
  server.on('upgrade', onUpgrade);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  cleanups.push(() => server.close());
  return { url: `ws://127.0.0.1:${addr.port}` };
}

function transportOpts(url: string, overrides: Partial<HookTransportOpts> = {}): HookTransportOpts {
  return {
    url,
    getAuthToken: async () => 'jwt-token-1',
    refreshAuthToken: async () => false,
    buildHello: () => ({
      deviceId: 'dev-1',
      deviceName: 'TestBox',
      workspaces: ['chat'],
      agents: ['codex'],
    }),
    onMessage: () => {},
    onStatus: () => {},
    timing: { backoffBaseMs: 10, backoffMaxMs: 20, standbyRetryMs: 200 },
    log: noopLog,
    ...overrides,
  };
}

describe('hook-control transport handshake recovery', () => {
  it('upgrade 401 只刷新一次凭证，并立即用新 token 重连', async () => {
    let upgrades = 0;
    const authHeaders: Array<string | undefined> = [];
    const wss = new WebSocketServer({ noServer: true });
    cleanups.push(() => wss.close());
    const { url } = await startUpgradeServer((req, socket, head) => {
      upgrades += 1;
      authHeaders.push(req.headers.authorization);
      if (upgrades === 1) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    });
    let token = 'stale-token';
    let refreshes = 0;
    const statuses: string[] = [];
    const transport = createHookTransport(
      transportOpts(url, {
        getAuthToken: async () => token,
        refreshAuthToken: async () => {
          refreshes += 1;
          token = 'fresh-token';
          return true;
        },
        onStatus: (status) => statuses.push(status),
      }),
    );
    cleanups.push(() => transport.dispose());

    const [sock] = (await once(wss, 'connection')) as [ServerSocket];
    sock.send(serializeHookMessage(makeWelcome({ serverName: 'mock', features: [] })));
    await expect.poll(() => statuses.at(-1), { timeout: 3000 }).toBe('connected');
    expect(refreshes).toBe(1);
    expect(authHeaders).toEqual(['Bearer stale-token', 'Bearer fresh-token']);
  });

  it('服务端 close 4000 进入 standby，且仅按低频周期探测接管', async () => {
    const { wss, url } = await startServer();
    let connections = 0;
    wss.on('connection', (sock) => {
      connections += 1;
      sock.on('message', () => sock.close(4000, 'device already connected'));
    });
    const statuses: string[] = [];
    const transport = createHookTransport(
      transportOpts(url, { onStatus: (status) => statuses.push(status) }),
    );
    cleanups.push(() => transport.dispose());

    await expect.poll(() => statuses.at(-1), { timeout: 3000 }).toBe('standby');
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(connections).toBe(1);
    await expect.poll(() => connections, { timeout: 3000 }).toBe(2);
    await expect
      .poll(() => statuses.filter((status) => status === 'standby').length, { timeout: 3000 })
      .toBe(2);
    expect(statuses.at(-1)).toBe('standby');
  });

  it('upgrade 503 保持 error 并按退避重连，不误判 standby', async () => {
    let upgrades = 0;
    const { url } = await startUpgradeServer((_req, socket) => {
      upgrades += 1;
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      socket.destroy();
    });
    const statuses: string[] = [];
    const transport = createHookTransport(
      transportOpts(url, { onStatus: (status) => statuses.push(status) }),
    );
    cleanups.push(() => transport.dispose());

    await expect.poll(() => upgrades, { timeout: 3000 }).toBeGreaterThanOrEqual(2);
    expect(statuses).toContain('error');
    expect(statuses).not.toContain('standby');
  });
});

describe('hook-control transport backoff jitter', () => {
  const BASE = 1000;
  const MAX = 30_000;

  it('抖动落在退避值的 [0.7, 1.0] 区间内', () => {
    // random 的两个极端决定区间端点；中点用于确认是线性插值而非跳变。
    expect(computeBackoffDelayMs(0, BASE, MAX, () => 0)).toBe(700);
    expect(computeBackoffDelayMs(0, BASE, MAX, () => 0.5)).toBe(850);
    // random() 取不到 1，但末尾 Math.round 会把逼近满值的比例舍入上去，
    // 所以上端是闭的：延迟可以恰好等于退避值（这也是 maxMs 仍不被越过的边界）。
    expect(computeBackoffDelayMs(0, BASE, MAX, () => 0.999999)).toBe(BASE);
  });

  it('指数增长仍然成立，且 maxMs 是真实上限（抖动只向下）', () => {
    // 高位 attempt 会让指数项远超 MAX，封顶后再抖动，绝不越过 MAX。
    for (const attempt of [0, 1, 2, 3, 4, 5, 10, 30]) {
      for (const r of [0, 0.25, 0.5, 0.75, 0.999999]) {
        const delay = computeBackoffDelayMs(attempt, BASE, MAX, () => r);
        expect(delay).toBeLessThanOrEqual(MAX);
        expect(delay).toBeGreaterThan(0);
      }
    }
    // 同一 random 下，未封顶区间应严格递增（抖动不掩盖退避本身）。
    const at = (n: number) => computeBackoffDelayMs(n, BASE, MAX, () => 0.5);
    expect(at(1)).toBeGreaterThan(at(0));
    expect(at(2)).toBeGreaterThan(at(1));
    // 封顶后不再增长。
    expect(computeBackoffDelayMs(30, BASE, MAX, () => 0.5)).toBe(
      computeBackoffDelayMs(10, BASE, MAX, () => 0.5),
    );
  });

  it('同一 attempt 的不同随机源给出不同延迟（真正打散齐步重连）', () => {
    const spread = new Set(
      [0, 0.2, 0.4, 0.6, 0.8].map((r) => computeBackoffDelayMs(5, BASE, MAX, () => r)),
    );
    expect(spread.size).toBeGreaterThan(1);
  });

  it('生产缺省不注入 random 时也能建连（Math.random 兜底）', async () => {
    const { wss, url } = await startServer();
    const statuses: string[] = [];
    const transport = createHookTransport({
      ...transportOpts(url, { onStatus: (status) => statuses.push(status) }),
      random: undefined,
    });
    cleanups.push(() => transport.dispose());

    const [sock] = (await once(wss, 'connection')) as [ServerSocket];
    sock.send(serializeHookMessage(makeWelcome({ serverName: 'mock', features: [] })));
    await expect.poll(() => statuses.at(-1), { timeout: 3000 }).toBe('connected');
  });
});

const WORKSPACES = { xdmaker: 'E:\\AIWork\\Lizi', blog: 'D:\\repos\\blog' };

describe('provider dispatch boundary', () => {
  it('keeps source-less legacy traffic on Slack and requires Telegram source/key agreement', () => {
    expect(providerForTaskDispatch({ externalKey: 'T1:C1:1.1' })).toBe('slack');
    expect(providerForTaskDispatch({ externalKey: 'dm:U1:g2' })).toBe('slack');
    expect(providerForTaskDispatch({ externalKey: 'dm:T1:U1:g2' })).toBe('slack');
    expect(
      providerForTaskDispatch({
        externalKey: 'dm:U1:g2',
        source: { im: 'telegram' },
      }),
    ).toBeNull();
    expect(
      providerForTaskDispatch({
        externalKey: 'telegram:dm:bot-1:user-1:g0',
        source: { im: 'telegram' },
      }),
    ).toBe('telegram');
    expect(
      providerForTaskDispatch({
        externalKey: 'telegram:dm:bot-1:user-1:g0',
        source: { im: 'slack' },
      }),
    ).toBeNull();
    expect(
      providerForTaskDispatch({
        externalKey: 'T1:C1:1.1',
        source: { im: 'telegram' },
      }),
    ).toBeNull();
    expect(
      providerForTaskDispatch({
        externalKey: 'discord:channel-1',
        source: { im: 'discord' },
      }),
    ).toBeNull();
    expect(
      providerForTaskDispatch({
        externalKey: 'discord:channel-1',
        source: { im: 'slack' },
      }),
    ).toBeNull();
    expect(providerForTaskDispatch({ externalKey: 'arbitrary-provider:key' })).toBeNull();
    expect(providerForTaskDispatch({ externalKey: 'telegram:dm:bot-1:user-1:g0' })).toBeNull();
  });

  it('routes X dispatches only when source and lane key agree, failing closed on mismatch', () => {
    expect(
      providerForTaskDispatch({
        externalKey: 'x:conv:999:conv-1:111:g1',
        source: { im: 'x' },
      }),
    ).toBe('x');
    // source/key 任一缺失或错配一律 fail closed —— X 不得继承 Slack 语义。
    expect(providerForTaskDispatch({ externalKey: 'x:conv:999:conv-1:111:g1' })).toBeNull();
    expect(
      providerForTaskDispatch({
        externalKey: 'x:conv:999:conv-1:111:g1',
        source: { im: 'slack' },
      }),
    ).toBeNull();
    expect(
      providerForTaskDispatch({
        externalKey: 'x:conv:999:conv-1:111:g1',
        source: { im: 'telegram' },
      }),
    ).toBeNull();
    expect(providerForTaskDispatch({ externalKey: 'T1:C1:1.1', source: { im: 'x' } })).toBeNull();
    expect(
      providerForTaskDispatch({
        externalKey: 'telegram:dm:bot-1:user-1:g0',
        source: { im: 'x' },
      }),
    ).toBeNull();
  });

  it('routes only known provider lane keys for session archive', () => {
    expect(providerForExternalKey('slack:dm:T1:U1:g2')).toBe('slack');
    expect(providerForExternalKey('dm:U1:g2')).toBe('slack');
    expect(providerForExternalKey('dm:T1:U1:g2')).toBe('slack');
    expect(providerForExternalKey('team-slack:C1:1.1')).toBe('slack');
    expect(providerForExternalKey('T1:C1:1.1')).toBe('slack');
    expect(providerForExternalKey('telegram:dm:bot:user:g2')).toBe('telegram');
    expect(providerForExternalKey('x:conv:999:conv-1:111:g1')).toBe('x');
    expect(providerForExternalKey('discord:channel-1')).toBeNull();
    expect(providerForExternalKey('arbitrary')).toBeNull();
  });
});

describe('hook-control transport + manager(真实 ws server)', () => {
  it('JWT 鉴权头 + hello 自报别名 + welcome 后 connected + pong + stub 拒绝 dispatch', async () => {
    const { wss, url } = await startServer();
    const store = memoryStore({ url, workspaces: WORKSPACES });

    const manager = makeManager(store);
    cleanups.push(() => manager.dispose());

    const connPromise = once(wss, 'connection') as Promise<
      [ServerSocket, { headers: Record<string, string | undefined> }]
    >;
    manager.sync();
    const [sock, req] = await connPromise;
    const server = collectFrames(sock);

    // 鉴权头 = 登录 accessToken(不是共享密钥)
    expect(req.headers.authorization).toBe('Bearer jwt-token-1');

    // hello: 只报别名, 绝不带本地路径
    const hello = await server.waitFor('hello');
    if (hello.type !== 'hello') throw new Error('unreachable');
    expect(hello.payload.deviceId).toBe('dev-1');
    expect(hello.payload.lifecycleAnnouncement).toBe(false);
    // 内置「对话」伪目录 chat 恒在清单第一位, 真实别名跟在后面
    expect(hello.payload.workspaces[0]).toBe('chat');
    expect([...hello.payload.workspaces].sort()).toEqual(['blog', 'chat', 'xdmaker']);
    expect(hello.payload.features).toEqual(
      expect.arrayContaining([HOOK_FEATURE_MULTI_TEAM, HOOK_FEATURE_SESSION_PICKER]),
    );
    expect(hello.payload.features).not.toContain(HOOK_FEATURE_PROVIDER_BIND);
    expect(hello.payload.features).not.toContain(HOOK_FEATURE_PROVIDER_PREFS);
    expect(hello.payload.features).not.toContain(HOOK_FEATURE_PROVIDER_TELEGRAM);
    expect(JSON.stringify(hello)).not.toContain('AIWork');

    // welcome -> connected
    sock.send(serializeHookMessage(makeWelcome({ serverName: 'mock', features: [] })));
    await expect.poll(() => manager.snapshot().status, { timeout: 3000 }).toBe('connected');

    // ping -> pong(transport 层自动)
    sock.send(serializeHookMessage(makePing()));
    const pong = await server.waitFor('pong');
    expect(pong.type).toBe('pong');

    // dispatch -> 无 dispatcher 的 stub: rejected(disabled)
    sock.send(
      serializeHookMessage(
        makeTaskDispatch({
          requestId: 'req-1',
          externalKey: 'slack:C1:1.1',
          workspace: 'xdmaker',
          prompt: '干活',
        }),
      ),
    );
    const ack = await server.waitFor('task.ack');
    if (ack.type !== 'task.ack') throw new Error('unreachable');
    expect(ack.payload).toMatchObject({
      requestId: 'req-1',
      result: 'rejected',
      reason: 'disabled',
    });
  });

  it('上下线通知偏好随 hello 上报，并在能力协商后实时更新', async () => {
    const { wss, url } = await startServer();
    const store = memoryStore({ url });
    const manager = makeManager(store);
    cleanups.push(() => manager.dispose());

    const connPromise = once(wss, 'connection') as Promise<[ServerSocket]>;
    manager.sync();
    const [sock] = await connPromise;
    const server = collectFrames(sock);

    const hello = await server.waitFor('hello');
    if (hello.type !== 'hello') throw new Error('unreachable');
    expect(hello.payload.lifecycleAnnouncement).toBe(false);

    // 模拟 hello 已发送、welcome 尚未返回时切换。welcome 能力协商完成后
    // 必须补发最新值，不能让 server 永久停留在 hello 的旧快照。
    manager.setLifecycleAnnouncement(true);
    sock.send(
      serializeHookMessage(
        makeWelcome({
          serverName: 'mock',
          features: [HOOK_FEATURE_LIFECYCLE_ANNOUNCEMENT],
        }),
      ),
    );
    const preference = await server.waitFor('lifecycle.preference');
    if (preference.type !== 'lifecycle.preference') throw new Error('unreachable');
    expect(preference.payload.enabled).toBe(true);
    await expect.poll(() => manager.snapshot().status, { timeout: 3000 }).toBe('connected');
    expect(store.get().lifecycleAnnouncementOverride).toBe(true);
    expect(manager.snapshot().lifecycleAnnouncement).toBe(true);
  });

  it('上下线通知实时更新发送失败时重建连接，并由下一次 hello 同步持久化值', () => {
    const store = memoryStore({ url: 'wss://fake.example' });
    const transportOpts: HookTransportOpts[] = [];
    const disposes: Array<ReturnType<typeof vi.fn>> = [];
    let sendOk = true;
    const manager = makeManager(store, {
      createTransport: (opts) => {
        transportOpts.push(opts);
        const dispose = vi.fn();
        disposes.push(dispose);
        return {
          send: () => sendOk,
          dispose,
        };
      },
    });
    cleanups.push(() => manager.dispose());

    manager.sync();
    const first = transportOpts[0];
    const welcome = makeWelcome({
      serverName: 'mock',
      features: [HOOK_FEATURE_LIFECYCLE_ANNOUNCEMENT],
    });
    first.onWelcome?.(welcome.payload);
    first.onStatus('connected', null);

    sendOk = false;
    manager.setLifecycleAnnouncement(true);

    expect(store.get().lifecycleAnnouncementOverride).toBe(true);
    expect(disposes[0]).toHaveBeenCalledOnce();
    expect(transportOpts).toHaveLength(2);
    expect(transportOpts[1].buildHello().lifecycleAnnouncement).toBe(true);
    expect(manager.snapshot().status).toBe('connecting');
  });

  it('Slack 重连在新 welcome 前不复用旧 capability 发送偏好', () => {
    const store = memoryStore({ url: 'wss://fake.example' });
    const transportOpts: HookTransportOpts[] = [];
    const sends: Array<ReturnType<typeof vi.fn>> = [];
    const manager = makeManager(store, {
      createTransport: (opts) => {
        transportOpts.push(opts);
        const send = vi.fn(() => true);
        sends.push(send);
        return {
          send,
          dispose: vi.fn(),
        };
      },
    });
    cleanups.push(() => manager.dispose());

    manager.sync();
    transportOpts[0].onWelcome?.(
      makeWelcome({
        serverName: 'new-server',
        features: [HOOK_FEATURE_LIFECYCLE_ANNOUNCEMENT],
      }).payload,
    );
    transportOpts[0].onStatus('connected', null);

    manager.sync();
    expect(transportOpts).toHaveLength(2);
    transportOpts[1].onStatus('connected', null);
    manager.setLifecycleAnnouncement(true);
    expect(sends[1]).not.toHaveBeenCalled();

    transportOpts[1].onWelcome?.(
      makeWelcome({
        serverName: 'old-server',
        features: [],
      }).payload,
    );
    expect(sends[1]).not.toHaveBeenCalled();
    expect(store.get().lifecycleAnnouncementOverride).toBe(true);
  });

  it('未登录(token=null): 不发起连接, 状态 error + not logged in', async () => {
    const { wss, url } = await startServer();
    let serverGotConnection = false;
    wss.on('connection', () => {
      serverGotConnection = true;
    });
    const store = memoryStore({ url });
    const manager = makeManager(store, { getAuthToken: async () => null });
    cleanups.push(() => manager.dispose());

    manager.sync();
    await expect.poll(() => manager.snapshot().lastError, { timeout: 3000 }).toBe('not logged in');
    expect(manager.snapshot().status).toBe('error');
    expect(serverGotConnection).toBe(false);
  });

  it('setEnabled(false) + sync 停线, snapshot 状态转 disabled', async () => {
    const { wss, url } = await startServer();
    const store = memoryStore({ url });
    const manager = makeManager(store);
    cleanups.push(() => manager.dispose());

    const connPromise = once(wss, 'connection') as Promise<[ServerSocket]>;
    manager.sync();
    const [sock] = await connPromise;
    const closed = once(sock, 'close');

    store.setEnabled(false);
    manager.sync();
    await closed; // desktop 侧主动断开
    expect(manager.snapshot().status).toBe('disabled');
  });

  it('bindStart(SIWS OIDC): 发空 bind.start, server 回 pending+authorizeUrl, 打开系统浏览器', async () => {
    const { wss, url } = await startServer();
    const store = memoryStore({ url });
    const opened: string[] = [];
    const manager = makeManager(store, { openExternalUrl: (u) => opened.push(u) });
    cleanups.push(() => manager.dispose());

    const connPromise = once(wss, 'connection') as Promise<[ServerSocket]>;
    manager.sync();
    const [sock] = await connPromise;
    const server = collectFrames(sock);
    await server.waitFor('hello');
    sock.send(serializeHookMessage(makeWelcome({ serverName: 'mock', features: [] })));
    await expect.poll(() => manager.snapshot().status, { timeout: 3000 }).toBe('connected');

    // 用户点「连接 Slack」: 发空 bind.start, 乐观置 pending
    expect(manager.bindStart()).toBe(true);
    const bind = await server.waitFor('bind.start');
    if (bind.type !== 'bind.start') throw new Error('unreachable');
    expect(bind.payload.email).toBeUndefined(); // OIDC: 不带邮箱
    expect(manager.snapshot().binding?.state).toBe('pending');

    // server 回 pending + 授权链接 → manager 打开系统浏览器一次, authorizeUrl 入快照
    const authorizeUrl = 'https://slack.example.com/openid/connect/authorize?state=abc';
    sock.send(
      serializeHookMessage(
        makeBindUpdate({
          state: 'pending',
          slackUserId: null,
          slackUserName: null,
          message: null,
          authorizeUrl,
        }),
      ),
    );
    await expect
      .poll(() => manager.snapshot().binding?.authorizeUrl, { timeout: 3000 })
      .toBe(authorizeUrl);
    expect(opened).toEqual([authorizeUrl]);

    // 重连时的 pending 回放不重复弹浏览器(一次性置位)
    sock.send(
      serializeHookMessage(
        makeBindUpdate({
          state: 'pending',
          slackUserId: null,
          slackUserName: null,
          message: null,
          authorizeUrl,
        }),
      ),
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(opened).toEqual([authorizeUrl]); // 仍只开过一次
  });

  it('bind.update(revoked): 自动关开关 + 断开连接, 保留 revoked 绑定态供 UI 展示', async () => {
    const { wss, url } = await startServer();
    const store = memoryStore({ url });
    const manager = makeManager(store);
    cleanups.push(() => manager.dispose());

    const connPromise = once(wss, 'connection') as Promise<[ServerSocket]>;
    manager.sync();
    const [sock] = await connPromise;
    const server = collectFrames(sock);
    await server.waitFor('hello');
    sock.send(serializeHookMessage(makeWelcome({ serverName: 'mock', features: [] })));
    await expect.poll(() => manager.snapshot().status, { timeout: 3000 }).toBe('connected');

    // server 推被顶掉(另一设备绑定成功): 本机应自动下线
    const closed = once(sock, 'close');
    sock.send(
      serializeHookMessage(
        makeBindUpdate({
          state: 'revoked',
          slackUserId: null,
          slackUserName: null,
          message: '你的 Slack 账号已绑定到新设备',
        }),
      ),
    );
    await closed; // desktop 侧主动断开
    expect(store.get().enabled).toBe(false);
    await expect.poll(() => manager.snapshot().status, { timeout: 3000 }).toBe('disabled');
    // 绑定态保留 revoked(含 server 给的原因), 设置页据此显示被踢提示
    expect(manager.snapshot().binding).toMatchObject({
      state: 'revoked',
      message: '你的 Slack 账号已绑定到新设备',
    });
  });

  it('bind.update(denied): 取消授权自动关开关(toggle 弹回)', async () => {
    const { wss, url } = await startServer();
    const store = memoryStore({ url });
    const manager = makeManager(store);
    cleanups.push(() => manager.dispose());

    const connPromise = once(wss, 'connection') as Promise<[ServerSocket]>;
    manager.sync();
    const [sock] = await connPromise;
    const server = collectFrames(sock);
    await server.waitFor('hello');
    sock.send(serializeHookMessage(makeWelcome({ serverName: 'mock', features: [] })));
    await expect.poll(() => manager.snapshot().status, { timeout: 3000 }).toBe('connected');

    // 用户在浏览器取消授权 → server 推 denied → 本机自动下线, toggle 弹回
    const closed = once(sock, 'close');
    sock.send(
      serializeHookMessage(
        makeBindUpdate({ state: 'denied', slackUserId: null, slackUserName: null, message: null }),
      ),
    );
    await closed;
    expect(store.get().enabled).toBe(false);
    await expect.poll(() => manager.snapshot().status, { timeout: 3000 }).toBe('disabled');
    expect(manager.snapshot().binding?.state).toBe('denied');

    // 重开开关(armAutoBind)= 新一轮流程: 清掉残留终止态快照 —— renderer 不会
    // 拿陈旧的失败态误弹提示/确认框, server 连上后推回真实现状
    manager.armAutoBind();
    expect(manager.snapshot().binding).toBeNull();
  });

  it('bind.update(none) 且无授权意图(启动回放/离线期间被解绑): 自动关开关, 不留「已连接·未绑定」僵尸态', async () => {
    const { wss, url } = await startServer();
    const store = memoryStore({ url }); // enabled=true 持久化, 模拟 App 启动拉起
    const manager = makeManager(store);
    cleanups.push(() => manager.dispose());

    const connPromise = once(wss, 'connection') as Promise<[ServerSocket]>;
    manager.sync(); // 启动路径: 不 armAutoBind(意图只在用户手动开 toggle 时置位)
    const [sock] = await connPromise;
    const server = collectFrames(sock);
    await server.waitFor('hello');
    sock.send(serializeHookMessage(makeWelcome({ serverName: 'mock', features: [] })));
    await expect.poll(() => manager.snapshot().status, { timeout: 3000 }).toBe('connected');

    // hello 回放: server 已无此设备绑定(离线期间被顶掉/解绑/服务端数据迁移)→ 推 none
    const closed = once(sock, 'close');
    sock.send(
      serializeHookMessage(
        makeBindUpdate({ state: 'none', slackUserId: null, slackUserName: null, message: null }),
      ),
    );
    await closed; // 开关语义 = 连接 + 绑定齐备才允许保持打开: 无绑定即弹回并断开
    expect(store.get().enabled).toBe(false);
    await expect.poll(() => manager.snapshot().status, { timeout: 3000 }).toBe('disabled');
    // 启动时没有授权意图, 不该自动发起绑定(不能在用户无操作时突然弹浏览器)
    expect(server.frames.some((f) => f.type === 'bind.start')).toBe(false);
  });

  it('reason 常量与 hook-protocol 对齐(shared 层不引协议包, 靠本测试拴住)', async () => {
    const protocol = await import('@cindy/slack-hook-protocol');
    const shared = await import('../../../shared/hookControlIpc');
    expect(shared.HOOK_BIND_REASON_NOT_INSTALLED).toBe(protocol.BIND_FAIL_REASON_NOT_INSTALLED);
  });

  it('failed + not-installed = "等安装"中间态: 不下线, 等 server 装完推 confirmed', async () => {
    const { wss, url } = await startServer();
    const store = memoryStore({ url });
    const manager = makeManager(store);
    cleanups.push(() => manager.dispose());

    const connPromise = once(wss, 'connection') as Promise<[ServerSocket]>;
    manager.sync();
    const [sock] = await connPromise;
    const server = collectFrames(sock);
    await server.waitFor('hello');
    sock.send(serializeHookMessage(makeWelcome({ serverName: 'mock', features: [] })));
    await expect.poll(() => manager.snapshot().status, { timeout: 3000 }).toBe('connected');

    // 授权的 workspace 未安装 App → server 推 failed + 结构化 reason:
    // 保持在线等用户安装(server 装完自动补完绑定), 不弹回 toggle
    sock.send(
      serializeHookMessage(
        makeBindUpdate({
          state: 'failed',
          slackUserId: null,
          slackUserName: null,
          message: 'workspace 未安装',
          reason: 'not-installed',
          installUrl: 'https://hook.example/slack/install-to?team=T_NOAPP',
        }),
      ),
    );
    await expect
      .poll(() => manager.snapshot().binding?.reason, { timeout: 3000 })
      .toBe('not-installed');
    expect(store.get().enabled).toBe(true);
    expect(manager.snapshot().status).toBe('connected');
    // 定制安装链接透传(renderer 优先用它, 安装页预选 workspace)
    expect(manager.snapshot().binding?.installUrl).toBe(
      'https://hook.example/slack/install-to?team=T_NOAPP',
    );

    // 用户装完 App → server 自动补完绑定推 confirmed → 正常已绑定
    sock.send(
      serializeHookMessage(
        makeBindUpdate({
          state: 'confirmed',
          slackUserId: 'U1',
          slackUserName: 'devuser',
          message: null,
        }),
      ),
    );
    await expect.poll(() => manager.snapshot().binding?.state, { timeout: 3000 }).toBe('confirmed');
    expect(store.get().enabled).toBe(true);
  });

  it('安装看门狗: "等安装"超时未 confirmed → toggle 弹回, 保留原因', async () => {
    const { wss, url } = await startServer();
    const store = memoryStore({ url });
    const manager = makeManager(store, { installWaitTimeoutMs: 120 });
    cleanups.push(() => manager.dispose());

    const connPromise = once(wss, 'connection') as Promise<[ServerSocket]>;
    manager.sync();
    const [sock] = await connPromise;
    const server = collectFrames(sock);
    await server.waitFor('hello');
    sock.send(serializeHookMessage(makeWelcome({ serverName: 'mock', features: [] })));
    await expect.poll(() => manager.snapshot().status, { timeout: 3000 }).toBe('connected');

    sock.send(
      serializeHookMessage(
        makeBindUpdate({
          state: 'failed',
          slackUserId: null,
          slackUserName: null,
          message: 'workspace 未安装',
          reason: 'not-installed',
        }),
      ),
    );
    // 用户一直没装(或装到了别的 workspace)→ 看门狗到点弹回
    await expect.poll(() => store.get().enabled, { timeout: 3000 }).toBe(false);
    await expect.poll(() => manager.snapshot().status, { timeout: 3000 }).toBe('disabled');
    // 原因保留供 UI 显示引导行
    expect(manager.snapshot().binding).toMatchObject({ state: 'failed', reason: 'not-installed' });
  });

  it('armAutoBind: 连上后 server 推 none → 自动发空 bind.start 并弹浏览器', async () => {
    const { wss, url } = await startServer();
    const store = memoryStore({ url });
    const opened: string[] = [];
    const manager = makeManager(store, { openExternalUrl: (u) => opened.push(u) });
    cleanups.push(() => manager.dispose());

    manager.armAutoBind(); // 相当于打开 toggle
    const connPromise = once(wss, 'connection') as Promise<[ServerSocket]>;
    manager.sync();
    const [sock] = await connPromise;
    const server = collectFrames(sock);
    await server.waitFor('hello');
    sock.send(serializeHookMessage(makeWelcome({ serverName: 'mock', features: [] })));
    await expect.poll(() => manager.snapshot().status, { timeout: 3000 }).toBe('connected');

    // hello 后 server 推回绑定现状 = none(未绑定) → manager 自动发起绑定
    sock.send(
      serializeHookMessage(
        makeBindUpdate({ state: 'none', slackUserId: null, slackUserName: null, message: null }),
      ),
    );
    const bind = await server.waitFor('bind.start');
    expect(bind.type).toBe('bind.start');
    // server 回授权链接 → 自动弹浏览器一次
    const authorizeUrl = 'https://slack.example.com/openid/connect/authorize?state=z';
    sock.send(
      serializeHookMessage(
        makeBindUpdate({
          state: 'pending',
          slackUserId: null,
          slackUserName: null,
          message: null,
          authorizeUrl,
        }),
      ),
    );
    await expect.poll(() => opened, { timeout: 3000 }).toEqual([authorizeUrl]);
  });

  it('armAutoBind: 已绑定设备连上 server 推 confirmed → 不重发 bind.start、不弹浏览器', async () => {
    const { wss, url } = await startServer();
    const store = memoryStore({ url });
    const opened: string[] = [];
    const manager = makeManager(store, { openExternalUrl: (u) => opened.push(u) });
    cleanups.push(() => manager.dispose());

    manager.armAutoBind();
    const connPromise = once(wss, 'connection') as Promise<[ServerSocket]>;
    manager.sync();
    const [sock] = await connPromise;
    const server = collectFrames(sock);
    await server.waitFor('hello');
    sock.send(serializeHookMessage(makeWelcome({ serverName: 'mock', features: [] })));
    await expect.poll(() => manager.snapshot().status, { timeout: 3000 }).toBe('connected');

    sock.send(
      serializeHookMessage(
        makeBindUpdate({
          state: 'confirmed',
          slackUserId: 'U1',
          slackUserName: 'devuser',
          message: null,
          teamName: 'acme',
        }),
      ),
    );
    await expect.poll(() => manager.snapshot().binding?.state, { timeout: 3000 }).toBe('confirmed');
    await new Promise((r) => setTimeout(r, 50));
    expect(server.frames.some((f) => f.type === 'bind.start')).toBe(false);
    expect(opened).toEqual([]);
    // workspace 名透传进绑定快照(状态行「已绑定 <team> @<name>」数据源)
    expect(manager.snapshot().binding?.teamName).toBe('acme');
  });

  it('cindy_slack provider gate 跟随绑定与 server capability，断线抖动不重复刷新', async () => {
    const { wss, url } = await startServer();
    const store = memoryStore({ url });
    const changes: boolean[] = [];
    const manager = makeManager(store, {
      onSlackToolProviderEnabledChanged: (enabled) => changes.push(enabled),
    });
    cleanups.push(() => manager.dispose());

    const connPromise = once(wss, 'connection') as Promise<[ServerSocket]>;
    manager.sync();
    const [sock] = await connPromise;
    const server = collectFrames(sock);
    await server.waitFor('hello');
    sock.send(serializeHookMessage(makeWelcome({ serverName: 'mock', features: [] })));
    await expect.poll(() => manager.snapshot().status, { timeout: 3000 }).toBe('connected');
    expect(changes).toEqual([]);

    const confirmed = makeBindUpdate({
      state: 'confirmed',
      slackUserId: 'U1',
      slackUserName: 'devuser',
      message: null,
    });
    sock.send(serializeHookMessage(confirmed));
    await expect.poll(() => manager.snapshot().binding?.state, { timeout: 3000 }).toBe('confirmed');
    expect(manager.getSlackToolAvailability()).toMatchObject({
      bound: true,
      serverSupportsTools: false,
    });
    expect(changes).toEqual([]);

    // 同一绑定下，server 能力升级会打开 provider；重复 welcome 不重复刷新。
    sock.send(
      serializeHookMessage(
        makeWelcome({ serverName: 'mock-new', features: [HOOK_FEATURE_SLACK_TOOLS] }),
      ),
    );
    await expect.poll(() => changes, { timeout: 3000 }).toEqual([true]);
    sock.send(
      serializeHookMessage(
        makeWelcome({ serverName: 'mock-new', features: [HOOK_FEATURE_SLACK_TOOLS] }),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(changes).toEqual([true]);

    // 重连到旧 server 时按新 welcome 关闭；再次升级可重新打开。
    sock.send(serializeHookMessage(makeWelcome({ serverName: 'mock-old', features: [] })));
    await expect.poll(() => changes, { timeout: 3000 }).toEqual([true, false]);
    sock.send(
      serializeHookMessage(
        makeWelcome({ serverName: 'mock-new', features: [HOOK_FEATURE_SLACK_TOOLS] }),
      ),
    );
    await expect.poll(() => changes, { timeout: 3000 }).toEqual([true, false, true]);

    // confirmed 回放与短暂连接抖动都不改变最近一次成功能力快照。
    sock.send(serializeHookMessage(confirmed));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(changes).toEqual([true, false, true]);
    sock.close();
    await expect.poll(() => manager.snapshot().status, { timeout: 3000 }).not.toBe('connected');
    expect(manager.getSlackToolAvailability().serverSupportsTools).toBe(true);
    expect(changes).toEqual([true, false, true]);

    manager.revokeAndDisconnect();
    expect(changes).toEqual([true, false, true, false]);
  });

  it('账号停用会立即关闭 cindy_slack provider gate', async () => {
    const { wss, url } = await startServer();
    const store = memoryStore({ url });
    const changes: boolean[] = [];
    const manager = makeManager(store, {
      onSlackToolProviderEnabledChanged: (enabled) => changes.push(enabled),
    });
    cleanups.push(() => manager.dispose());

    const connPromise = once(wss, 'connection') as Promise<[ServerSocket]>;
    manager.sync();
    const [sock] = await connPromise;
    const server = collectFrames(sock);
    await server.waitFor('hello');
    sock.send(
      serializeHookMessage(
        makeWelcome({ serverName: 'mock', features: [HOOK_FEATURE_SLACK_TOOLS] }),
      ),
    );
    sock.send(
      serializeHookMessage(
        makeBindUpdate({
          state: 'confirmed',
          slackUserId: 'U1',
          slackUserName: 'devuser',
          message: null,
        }),
      ),
    );
    await expect.poll(() => changes, { timeout: 3000 }).toEqual([true]);

    await manager.deactivateAccount();
    expect(changes).toEqual([true, false]);
  });

  it('armAutoBind: 重开 toggle 撞上 server 回放的旧 pending → 重新发起并弹新链接', async () => {
    // 场景: 本地看门狗超时(3 分钟)早于 server 侧 pending TTL(10 分钟), toggle
    // 弹回后重开, server 按 hello 回放旧 pending —— 必须重发 bind.start 换新链接
    // 并弹浏览器, 否则用户卡在「授权中」等一个永远不会弹出的授权页
    const { wss, url } = await startServer();
    const store = memoryStore({ url });
    const opened: string[] = [];
    const manager = makeManager(store, { openExternalUrl: (u) => opened.push(u) });
    cleanups.push(() => manager.dispose());

    manager.armAutoBind();
    const connPromise = once(wss, 'connection') as Promise<[ServerSocket]>;
    manager.sync();
    const [sock] = await connPromise;
    const server = collectFrames(sock);
    await server.waitFor('hello');
    sock.send(serializeHookMessage(makeWelcome({ serverName: 'mock', features: [] })));
    await expect.poll(() => manager.snapshot().status, { timeout: 3000 }).toBe('connected');

    // server 回放旧的进行中授权(旧链接)
    sock.send(
      serializeHookMessage(
        makeBindUpdate({
          state: 'pending',
          slackUserId: null,
          slackUserName: null,
          message: null,
          authorizeUrl: 'https://slack.example.com/authorize?state=old',
        }),
      ),
    );
    // 自动重新发起(server 那头会作废旧尝试签新 state)
    await server.waitFor('bind.start');
    expect(opened).toEqual([]); // 旧链接不弹
    const freshUrl = 'https://slack.example.com/authorize?state=fresh';
    sock.send(
      serializeHookMessage(
        makeBindUpdate({
          state: 'pending',
          slackUserId: null,
          slackUserName: null,
          message: null,
          authorizeUrl: freshUrl,
        }),
      ),
    );
    await expect.poll(() => opened, { timeout: 3000 }).toEqual([freshUrl]);
  });

  it('armAutoBind: bind.update 处理中连接恰好掉线(send 失败)→ 意图保留待重连重试, 不弹回开关', async () => {
    // 场景: 用户刚开 toggle, server 回放 bind.update(none) 的同一时刻连接掉了,
    // bind.start 发不出去。旧行为会消费掉 autoBindIntent, 重连回放 none 时走
    // autoDisable 把开关静默弹回(用户视角: 点了开关没弹浏览器又自己关了);
    // 现在意图保留, 重连回放后自动重试发起授权。用 fake transport 精确控制
    // send 失败时机(真 ws 无法确定性模拟"处理帧时掉线")。
    const store = memoryStore({ url: 'wss://fake.example' });
    const sent: HookMessage[] = [];
    let sendOk = false;
    const transportOpts: Parameters<typeof createHookTransport>[0][] = [];
    const manager = makeManager(store, {
      createTransport: (opts) => {
        transportOpts.push(opts);
        return {
          send: (m) => {
            if (!sendOk) return false;
            sent.push(m);
            return true;
          },
          dispose: () => {},
        };
      },
      openExternalUrl: () => {},
    });
    cleanups.push(() => manager.dispose());

    manager.armAutoBind(); // 打开 toggle
    manager.sync();
    const opts = transportOpts[0];
    opts.onStatus('connected', null);
    const none = makeBindUpdate({
      state: 'none',
      slackUserId: null,
      slackUserName: null,
      message: null,
    });
    if (none.type !== 'bind.update') throw new Error('unreachable');

    // 第一帧 none: send 失败(掉线瞬间)→ 不 auto-disable, 意图保留
    opts.onMessage(none, (m) => (sendOk ? (sent.push(m), true) : false));
    expect(store.get().enabled).toBe(true);
    expect(sent.some((f) => f.type === 'bind.start')).toBe(false);

    // 重连回放 none: send 恢复 → 自动重试发起绑定, 开关仍开
    sendOk = true;
    opts.onMessage(none, (m) => (sent.push(m), true));
    expect(sent.some((f) => f.type === 'bind.start')).toBe(true);
    expect(store.get().enabled).toBe(true);
    expect(manager.snapshot().binding?.state).toBe('pending');
  });

  it('授权看门狗: 超时仍 pending(用户关掉浏览器)→ 本地判 expired, toggle 弹回', async () => {
    const { wss, url } = await startServer();
    const store = memoryStore({ url });
    const manager = makeManager(store, {
      openExternalUrl: () => {},
      bindPendingTimeoutMs: 120,
    });
    cleanups.push(() => manager.dispose());

    manager.armAutoBind();
    const connPromise = once(wss, 'connection') as Promise<[ServerSocket]>;
    manager.sync();
    const [sock] = await connPromise;
    const server = collectFrames(sock);
    await server.waitFor('hello');
    sock.send(serializeHookMessage(makeWelcome({ serverName: 'mock', features: [] })));
    await expect.poll(() => manager.snapshot().status, { timeout: 3000 }).toBe('connected');

    sock.send(
      serializeHookMessage(
        makeBindUpdate({ state: 'none', slackUserId: null, slackUserName: null, message: null }),
      ),
    );
    await server.waitFor('bind.start');
    sock.send(
      serializeHookMessage(
        makeBindUpdate({
          state: 'pending',
          slackUserId: null,
          slackUserName: null,
          message: null,
          authorizeUrl: 'https://slack.example.com/authorize?state=z',
        }),
      ),
    );
    // 浏览器被用户直接关掉 = 永远等不到回调 → 看门狗到点本地判 expired 并弹回 toggle
    await expect.poll(() => store.get().enabled, { timeout: 3000 }).toBe(false);
    expect(manager.snapshot().binding?.state).toBe('expired');
    await expect.poll(() => manager.snapshot().status, { timeout: 3000 }).toBe('disabled');
  });

  it('授权看门狗: 超时前授权完成(confirmed)→ 撤计时器, 不误关', async () => {
    const { wss, url } = await startServer();
    const store = memoryStore({ url });
    const manager = makeManager(store, {
      openExternalUrl: () => {},
      bindPendingTimeoutMs: 120,
    });
    cleanups.push(() => manager.dispose());

    manager.armAutoBind();
    const connPromise = once(wss, 'connection') as Promise<[ServerSocket]>;
    manager.sync();
    const [sock] = await connPromise;
    const server = collectFrames(sock);
    await server.waitFor('hello');
    sock.send(serializeHookMessage(makeWelcome({ serverName: 'mock', features: [] })));
    await expect.poll(() => manager.snapshot().status, { timeout: 3000 }).toBe('connected');

    sock.send(
      serializeHookMessage(
        makeBindUpdate({ state: 'none', slackUserId: null, slackUserName: null, message: null }),
      ),
    );
    await server.waitFor('bind.start');
    sock.send(
      serializeHookMessage(
        makeBindUpdate({
          state: 'confirmed',
          slackUserId: 'U1',
          slackUserName: 'devuser',
          message: null,
        }),
      ),
    );
    await expect.poll(() => manager.snapshot().binding?.state, { timeout: 3000 }).toBe('confirmed');
    // 熬过看门狗时限: 已 confirmed 不该被误判超时
    await new Promise((r) => setTimeout(r, 200));
    expect(store.get().enabled).toBe(true);
    expect(manager.snapshot().binding?.state).toBe('confirmed');
    expect(manager.snapshot().status).toBe('connected');
  });

  it('revokeAndDisconnect(关 toggle): 发 bind.revoke 解绑并断开, 本地绑定归零', async () => {
    const { wss, url } = await startServer();
    const store = memoryStore({ url });
    const manager = makeManager(store);
    cleanups.push(() => manager.dispose());

    const connPromise = once(wss, 'connection') as Promise<[ServerSocket]>;
    manager.sync();
    const [sock] = await connPromise;
    const server = collectFrames(sock);
    await server.waitFor('hello');
    sock.send(serializeHookMessage(makeWelcome({ serverName: 'mock', features: [] })));
    await expect.poll(() => manager.snapshot().status, { timeout: 3000 }).toBe('connected');
    sock.send(
      serializeHookMessage(
        makeBindUpdate({
          state: 'confirmed',
          slackUserId: 'U1',
          slackUserName: 'devuser',
          message: null,
        }),
      ),
    );
    await expect.poll(() => manager.snapshot().binding?.state, { timeout: 3000 }).toBe('confirmed');

    // 关 toggle: 解除绑定并断开(再开需重新授权)
    manager.revokeAndDisconnect();
    store.setEnabled(false);
    manager.sync();
    await expect.poll(() => manager.snapshot().status, { timeout: 3000 }).toBe('disabled');
    await expect
      .poll(() => server.frames.some((f) => f.type === 'bind.revoke'), { timeout: 3000 })
      .toBe(true);
    // 本地绑定态归零(stop 后收不到 server 回的 none 帧, 主动置)
    expect(manager.snapshot().binding?.state).toBe('none');
  });

  it('server 不可达时进入 error/connecting 并保持重试, dispose 干净退出', async () => {
    const store = memoryStore({ url: 'ws://127.0.0.1:1' });
    const manager = makeManager(store);
    manager.sync();
    await expect
      .poll(
        () => {
          const s = manager.snapshot().status;
          return s === 'error' || s === 'connecting';
        },
        { timeout: 5000 },
      )
      .toBe(true);
    // dispose 后所有 timer/socket 释放 —— 测试进程能自然退出即证明无泄漏
    manager.dispose();
  });
});

const TELEGRAM_FEATURES = [
  HOOK_FEATURE_PROVIDER_BIND,
  HOOK_FEATURE_PROVIDER_PREFS,
  HOOK_FEATURE_PROVIDER_TELEGRAM,
  HOOK_FEATURE_SESSION_PICKER,
];

const TELEGRAM_PENDING: ProviderBindStatusPayload = {
  provider: 'telegram' as const,
  replyTo: null,
  state: 'pending' as const,
  attemptId: 'attempt-telegram-1',
  bindingId: null,
  principalId: null,
  principalName: null,
  scopeId: 'bot-1',
  scopeName: 'cindy_example_bot',
  connectUrl: 'https://t.me/cindy_example_bot?start=abcdefghijklmnopqrstuvwxyz_0123456789-ABCDE',
  expiresAt: Date.now() + 60_000,
  reason: null,
  remediationUrl: null,
  actions: ['open_connect_url', 'copy_connect_url', 'cancel'],
};

const TELEGRAM_CONFIRMED: ProviderBindStatusPayload = {
  provider: 'telegram' as const,
  replyTo: null,
  state: 'confirmed' as const,
  attemptId: null,
  bindingId: 'binding-telegram-1',
  principalId: 'telegram-user-1',
  principalName: 'Cindy User',
  scopeId: 'bot-1',
  scopeName: 'cindy_example_bot',
  connectUrl: null,
  expiresAt: null,
  reason: null,
  remediationUrl: 'https://t.me/cindy_example_bot',
  actions: ['revoke', 'open_provider', 'add_to_group'],
};

describe('Telegram provider capability, binding and prefs', () => {
  it('冷启动与账号重激活都从缓存恢复 Telegram actions', async () => {
    const store = memoryStore({
      url: 'wss://unused.example',
      enabled: false,
      telegramEnabled: false,
      telegramBindingCache: {
        bindingId: 'binding-telegram-1',
        principalId: 'telegram-user-1',
        principalName: 'Cindy User',
        scopeId: 'bot-1',
        scopeName: 'cindy_example_bot',
      },
    });
    const manager = makeManager(store);
    cleanups.push(() => manager.dispose());

    expect(manager.snapshot().telegram.binding?.actions).toEqual([
      'revoke',
      'open_provider',
      'add_to_group',
    ]);
    await manager.deactivateAccount();
    manager.activateAccount();
    expect(manager.snapshot().telegram.binding?.actions).toEqual([
      'revoke',
      'open_provider',
      'add_to_group',
    ]);
  });

  it('显式开启会等待服务端权威状态，缓存误报 confirmed 时仍自动发起绑定', async () => {
    const { wss, url } = await startServer();
    const store = memoryStore({
      url,
      enabled: false,
      telegramEnabled: false,
      telegramBindingCache: {
        bindingId: 'stale-binding',
        principalId: 'stale-principal',
        principalName: 'Old User',
        scopeId: 'bot-1',
        scopeName: 'cindy_example_bot',
      },
    });
    const manager = makeManager(store);
    cleanups.push(() => manager.dispose());

    const connPromise = once(wss, 'connection') as Promise<[ServerSocket]>;
    manager.setProviderEnabled('telegram', true);
    const [sock] = await connPromise;
    const server = collectFrames(sock);
    await server.waitFor('hello');
    sock.send(
      serializeHookMessage(
        makeWelcome({ serverName: 'telegram-server', features: TELEGRAM_FEATURES }),
      ),
    );
    await expect
      .poll(() => manager.snapshot().telegram.status, { timeout: 3000 })
      .toBe('connected');

    sock.send(
      serializeHookMessage(
        makeProviderBindState({
          ...TELEGRAM_PENDING,
          state: 'none',
          attemptId: null,
          scopeId: null,
          scopeName: null,
          connectUrl: null,
          expiresAt: null,
          actions: [],
        }),
      ),
    );

    const start = await server.waitFor('provider.bind.start');
    expect(start.type === 'provider.bind.start' ? start.payload.provider : null).toBe('telegram');
    expect(manager.snapshot().telegram.binding).toMatchObject({ state: 'pending' });
  });

  it('账号切换会丢弃上一账号尚未消费的 Telegram 自动绑定意图', async () => {
    const { wss, url } = await startServer();
    const store = memoryStore({ url, enabled: false, telegramEnabled: false });
    const manager = makeManager(store);
    cleanups.push(() => manager.dispose());

    const connections: Array<{
      sock: ServerSocket;
      server: ReturnType<typeof collectFrames>;
    }> = [];
    wss.on('connection', (sock) => connections.push({ sock, server: collectFrames(sock) }));

    manager.setProviderEnabled('telegram', true);
    await expect.poll(() => connections.length, { timeout: 3000 }).toBe(1);
    await connections[0].server.waitFor('hello');

    await manager.deactivateAccount();
    manager.activateAccount();
    await expect.poll(() => connections.length, { timeout: 3000 }).toBe(2);

    const nextAccount = connections[1];
    await nextAccount.server.waitFor('hello');
    nextAccount.sock.send(
      serializeHookMessage(
        makeWelcome({ serverName: 'telegram-server', features: TELEGRAM_FEATURES }),
      ),
    );
    await expect
      .poll(() => manager.snapshot().telegram.status, { timeout: 3000 })
      .toBe('connected');
    nextAccount.sock.send(
      serializeHookMessage(
        makeProviderBindState({
          ...TELEGRAM_PENDING,
          state: 'none',
          attemptId: null,
          scopeId: null,
          scopeName: null,
          connectUrl: null,
          expiresAt: null,
          actions: [],
        }),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(
      nextAccount.server.frames.filter((frame) => frame.type === 'provider.bind.start'),
    ).toEqual([]);
  });

  it('未配置 Telegram 独立端点时明确报错，不回退或误连 Slack URL', () => {
    const store = memoryStore({
      url: 'wss://slack-hook.example.test',
      enabled: false,
      telegramEnabled: false,
    });
    const manager = makeManager(store, {
      getTelegramUrl: () => '',
      createTransport: () => {
        throw new Error('transport must not be created without a Telegram endpoint');
      },
    });
    cleanups.push(() => manager.dispose());

    manager.setProviderEnabled('telegram', true);

    expect(manager.snapshot()).toMatchObject({
      status: 'disabled',
      telegram: {
        enabled: true,
        url: '',
        status: 'error',
        available: false,
        capabilityPending: false,
        lastError: 'Telegram service endpoint is not configured',
      },
    });
  });

  it('账号 drain 等待 recent-session 查询，并丢弃旧代 query.response', async () => {
    const { wss, url } = await startServer();
    const store = memoryStore({ url, enabled: false, telegramEnabled: true });
    let resolveSessions: ((sessions: []) => void) | undefined;
    const listRecentSessions = () =>
      new Promise<[]>((resolve) => {
        resolveSessions = resolve;
      });
    const manager = makeManager(store, { listRecentSessions });
    cleanups.push(() => manager.dispose());

    const connPromise = once(wss, 'connection') as Promise<[ServerSocket]>;
    manager.sync();
    const [sock] = await connPromise;
    const server = collectFrames(sock);
    await server.waitFor('hello');
    sock.send(
      serializeHookMessage(
        makeWelcome({ serverName: 'telegram-server', features: TELEGRAM_FEATURES }),
      ),
    );
    await expect
      .poll(() => manager.snapshot().telegram.status, { timeout: 3000 })
      .toBe('connected');
    sock.send(
      serializeHookMessage(makeQueryRequest({ queryId: 'sessions-old', kind: 'sessions' })),
    );
    await expect.poll(() => resolveSessions).toBeTypeOf('function');

    let drained = false;
    const draining = manager.deactivateAccount().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    resolveSessions?.([]);
    await draining;

    expect(server.frames.some((frame) => frame.type === 'query.response')).toBe(false);
  });

  it('更新的账号 teardown 会取消 drain 期间排队的重新激活', async () => {
    const { wss, url } = await startServer();
    const store = memoryStore({ url, enabled: false, telegramEnabled: true });
    let resolveSessions: ((sessions: []) => void) | undefined;
    const manager = makeManager(store, {
      listRecentSessions: () =>
        new Promise<[]>((resolve) => {
          resolveSessions = resolve;
        }),
    });
    cleanups.push(() => manager.dispose());

    let connectionCount = 0;
    wss.on('connection', () => {
      connectionCount += 1;
    });
    const connPromise = once(wss, 'connection') as Promise<[ServerSocket]>;
    manager.sync();
    const [sock] = await connPromise;
    const server = collectFrames(sock);
    await server.waitFor('hello');
    sock.send(
      serializeHookMessage(
        makeWelcome({ serverName: 'telegram-server', features: TELEGRAM_FEATURES }),
      ),
    );
    await expect
      .poll(() => manager.snapshot().telegram.status, { timeout: 3000 })
      .toBe('connected');
    sock.send(
      serializeHookMessage(makeQueryRequest({ queryId: 'keep-drain-open', kind: 'sessions' })),
    );
    await expect.poll(() => resolveSessions).toBeTypeOf('function');

    const firstTeardown = manager.deactivateAccount();
    manager.activateAccount();
    const newerTeardown = manager.deactivateAccount();
    resolveSessions?.([]);
    await Promise.all([firstTeardown, newerTeardown]);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(connectionCount).toBe(1);
  });

  it('Telegram 在线时打开 Slack 会新建独立连接，并由 Slack 状态回放发起绑定', async () => {
    const { wss, url } = await startServer();
    const store = memoryStore({ url, enabled: false, telegramEnabled: true });
    const manager = makeManager(store);
    cleanups.push(() => manager.dispose());

    const connections: Array<{
      sock: ServerSocket;
      server: ReturnType<typeof collectFrames>;
    }> = [];
    wss.on('connection', (sock) => connections.push({ sock, server: collectFrames(sock) }));
    manager.sync();
    await expect.poll(() => connections.length, { timeout: 3000 }).toBe(1);
    const telegram = connections[0];
    const telegramHello = await telegram.server.waitFor('hello');
    if (telegramHello.type !== 'hello') throw new Error('unreachable');
    expect(telegramHello.payload.features).toContain(HOOK_FEATURE_PROVIDER_BIND);
    expect(telegramHello.payload.features).not.toContain(HOOK_FEATURE_MULTI_TEAM);
    telegram.sock.send(
      serializeHookMessage(
        makeWelcome({ serverName: 'telegram-server', features: TELEGRAM_FEATURES }),
      ),
    );
    await expect
      .poll(() => manager.snapshot().telegram.status, { timeout: 3000 })
      .toBe('connected');
    expect(manager.snapshot().status).toBe('disabled');

    manager.armAutoBind();
    manager.setProviderEnabled('slack', true);
    await expect.poll(() => connections.length, { timeout: 3000 }).toBe(2);
    const slack = connections[1];
    const slackHello = await slack.server.waitFor('hello');
    if (slackHello.type !== 'hello') throw new Error('unreachable');
    expect(slackHello.payload.features).toContain(HOOK_FEATURE_MULTI_TEAM);
    expect(slackHello.payload.features).not.toContain(HOOK_FEATURE_PROVIDER_BIND);
    slack.sock.send(
      serializeHookMessage(makeWelcome({ serverName: 'slack-server', features: [] })),
    );
    slack.sock.send(
      serializeHookMessage(
        makeBindUpdate({ state: 'none', slackUserId: null, slackUserName: null, message: null }),
      ),
    );
    const start = await slack.server.waitFor('bind.start');
    expect(start.type).toBe('bind.start');
    expect(store.get()).toMatchObject({ enabled: true, telegramEnabled: true });
    expect(manager.snapshot().binding?.state).toBe('pending');
    expect(manager.snapshot().telegram.status).toBe('connected');
  });

  it('Telegram 服务能力不匹配时保留用户开关，Slack 连接与帧边界保持独立', async () => {
    const { wss, url } = await startServer();
    const store = memoryStore({ url, enabled: true, telegramEnabled: true });
    const listAgentModels = vi.fn(() => []);
    const listRecentSessions = vi.fn(async () => []);
    const manager = makeManager(store, { listAgentModels, listRecentSessions });
    cleanups.push(() => manager.dispose());

    const connections: Array<{
      sock: ServerSocket;
      server: ReturnType<typeof collectFrames>;
      hello?: HookMessage;
    }> = [];
    wss.on('connection', (sock) => connections.push({ sock, server: collectFrames(sock) }));
    manager.sync();
    await expect.poll(() => connections.length, { timeout: 3000 }).toBe(2);
    for (const connection of connections)
      connection.hello = await connection.server.waitFor('hello');
    const telegram = connections.find((connection) => {
      const hello = connection.hello;
      return (
        hello?.type === 'hello' &&
        hello.payload.features?.includes(HOOK_FEATURE_PROVIDER_BIND) === true
      );
    });
    const slack = connections.find((connection) => connection !== telegram);
    if (!telegram || !slack) throw new Error('provider connections not found');

    slack.sock.send(
      serializeHookMessage(makeWelcome({ serverName: 'slack-server', features: [] })),
    );
    telegram.sock.send(
      serializeHookMessage(makeWelcome({ serverName: 'old-telegram-server', features: [] })),
    );

    await expect.poll(() => manager.snapshot().status, { timeout: 3000 }).toBe('connected');
    await expect
      .poll(() => manager.snapshot().telegram.status, { timeout: 3000 })
      .toBe('connected');
    expect(store.get()).toMatchObject({ enabled: true, telegramEnabled: true });
    expect(manager.snapshot().telegram).toMatchObject({
      available: false,
      capabilityPending: false,
      enabled: true,
      status: 'connected',
    });
    expect(slack.sock.readyState).toBe(slack.sock.OPEN);
    expect(telegram.sock.readyState).toBe(telegram.sock.OPEN);

    // An old node has not established a Telegram business capability boundary:
    // even request/response frames must not expose local project/model/session
    // metadata before the negotiated feature set says this is Telegram.
    for (const kind of ['workspaces', 'models', 'sessions'] as const) {
      telegram.sock.send(
        serializeHookMessage(makeQueryRequest({ queryId: `old-node-${kind}`, kind })),
      );
    }
    await expect
      .poll(
        () => telegram.server.frames.filter((frame) => frame.type === 'query.response').length,
        { timeout: 3000 },
      )
      .toBe(3);
    const oldNodeResponses = telegram.server.frames.filter(
      (frame) => frame.type === 'query.response',
    );
    expect(oldNodeResponses.map((frame) => frame.payload)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ queryId: 'old-node-workspaces', ok: false }),
        expect.objectContaining({ queryId: 'old-node-models', ok: false }),
        expect.objectContaining({ queryId: 'old-node-sessions', ok: false }),
      ]),
    );
    expect(listAgentModels).not.toHaveBeenCalled();
    expect(listRecentSessions).not.toHaveBeenCalled();

    // Provider-neutral bind frames arriving on Slack are rejected at the
    // physical transport boundary, even if their payload says Telegram.
    slack.sock.send(serializeHookMessage(makeProviderBindState(TELEGRAM_CONFIRMED)));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(manager.snapshot().telegram.binding).toBeNull();

    slack.sock.send(
      serializeHookMessage(
        makeTaskDispatch({
          requestId: 'wrong-transport-telegram-task',
          externalKey: 'telegram:dm:bot-1:user-1:g0',
          workspace: 'chat',
          prompt: 'must not cross the Slack service boundary',
          source: { im: 'telegram' },
        }),
      ),
    );
    const ack = await slack.server.waitFor('task.ack');
    expect(ack.type === 'task.ack' ? ack.payload : null).toMatchObject({
      requestId: 'wrong-transport-telegram-task',
      result: 'rejected',
      reason: 'invalid',
    });
  });

  it('Telegram 连接到旧节点时保留开关，并在重连到新节点后自动恢复', async () => {
    const { wss, url } = await startServer();
    const store = memoryStore({ url, enabled: false, telegramEnabled: false });
    const manager = makeManager(store, {
      createTransport: (opts) =>
        createHookTransport({
          ...opts,
          timing: { backoffBaseMs: 10, backoffMaxMs: 20, standbyRetryMs: 200 },
        }),
    });
    cleanups.push(() => manager.dispose());

    const connections: Array<{
      sock: ServerSocket;
      server: ReturnType<typeof collectFrames>;
    }> = [];
    wss.on('connection', (sock) => connections.push({ sock, server: collectFrames(sock) }));
    manager.setProviderEnabled('telegram', true);
    await expect.poll(() => connections.length, { timeout: 3000 }).toBe(1);
    await connections[0].server.waitFor('hello');
    connections[0].sock.send(
      serializeHookMessage(makeWelcome({ serverName: 'old-server', features: [] })),
    );

    await expect
      .poll(() => manager.snapshot().telegram.status, { timeout: 3000 })
      .toBe('connected');
    expect(manager.snapshot().telegram).toMatchObject({
      available: false,
      capabilityPending: false,
      enabled: true,
    });
    expect(store.get()).toMatchObject({ enabled: false, telegramEnabled: true });

    connections[0].sock.terminate();
    await expect.poll(() => connections.length, { timeout: 3000 }).toBe(2);
    await connections[1].server.waitFor('hello');
    connections[1].sock.send(
      serializeHookMessage(
        makeWelcome({ serverName: 'telegram-server', features: TELEGRAM_FEATURES }),
      ),
    );

    await expect.poll(() => manager.snapshot().telegram.available, { timeout: 3000 }).toBe(true);
    expect(manager.snapshot().telegram).toMatchObject({
      enabled: true,
      status: 'connected',
    });
    expect(store.get().telegramEnabled).toBe(true);

    connections[1].sock.send(
      serializeHookMessage(
        makeProviderBindState({
          ...TELEGRAM_PENDING,
          state: 'none',
          attemptId: null,
          scopeId: null,
          scopeName: null,
          connectUrl: null,
          expiresAt: null,
          actions: [],
        }),
      ),
    );
    const start = await connections[1].server.waitFor('provider.bind.start');
    expect(start.type === 'provider.bind.start' ? start.payload.provider : null).toBe('telegram');
  });

  it('Telegram 重连时不会沿用上一节点能力在新 welcome 前泄露本机查询数据', async () => {
    const { wss, url } = await startServer();
    const store = memoryStore({ url, enabled: false, telegramEnabled: true });
    const listAgentModels = vi.fn(() => []);
    const manager = makeManager(store, {
      listAgentModels,
      createTransport: (opts) =>
        createHookTransport({
          ...opts,
          timing: { backoffBaseMs: 10, backoffMaxMs: 20, standbyRetryMs: 200 },
        }),
    });
    cleanups.push(() => manager.dispose());

    const connections: Array<{
      sock: ServerSocket;
      server: ReturnType<typeof collectFrames>;
    }> = [];
    wss.on('connection', (sock) => connections.push({ sock, server: collectFrames(sock) }));
    manager.sync();
    await expect.poll(() => connections.length, { timeout: 3000 }).toBe(1);
    await connections[0].server.waitFor('hello');
    connections[0].sock.send(
      serializeHookMessage(
        makeWelcome({ serverName: 'telegram-server', features: TELEGRAM_FEATURES }),
      ),
    );
    await expect.poll(() => manager.snapshot().telegram.available, { timeout: 3000 }).toBe(true);

    connections[0].sock.terminate();
    await expect.poll(() => connections.length, { timeout: 3000 }).toBe(2);
    const reconnect = connections[1];
    await reconnect.server.waitFor('hello');
    reconnect.sock.send(
      serializeHookMessage(makeQueryRequest({ queryId: 'before-new-welcome', kind: 'models' })),
    );

    const response = await reconnect.server.waitFor('query.response');
    expect(response.type === 'query.response' ? response.payload : null).toMatchObject({
      queryId: 'before-new-welcome',
      ok: false,
    });
    expect(listAgentModels).not.toHaveBeenCalled();
  });

  it('Telegram transport 停止时清理已协商能力', async () => {
    const { wss, url } = await startServer();
    const store = memoryStore({ url, enabled: false, telegramEnabled: true });
    const manager = makeManager(store);
    cleanups.push(() => manager.dispose());

    const connPromise = once(wss, 'connection') as Promise<[ServerSocket]>;
    manager.sync();
    const [sock] = await connPromise;
    const server = collectFrames(sock);
    await server.waitFor('hello');
    sock.send(
      serializeHookMessage(
        makeWelcome({ serverName: 'telegram-server', features: TELEGRAM_FEATURES }),
      ),
    );
    await expect.poll(() => manager.snapshot().telegram.available, { timeout: 3000 }).toBe(true);

    manager.setProviderEnabled('telegram', false);

    await expect.poll(() => sock.readyState, { timeout: 3000 }).toBe(sock.CLOSED);
    expect(manager.snapshot().telegram).toMatchObject({
      available: false,
      capabilityPending: false,
      enabled: false,
      status: 'disabled',
    });
  });

  it('Telegram-only 开关建连，none 后发起绑定，且只打开当前请求的一次性 deep link', async () => {
    const { wss, url } = await startServer();
    const store = memoryStore({ url, enabled: false, telegramEnabled: false });
    const opened: string[] = [];
    const manager = makeManager(store, {
      openTelegramUrl: (value) => {
        opened.push(value);
      },
    });
    cleanups.push(() => manager.dispose());

    const connPromise = once(wss, 'connection') as Promise<[ServerSocket]>;
    manager.setProviderEnabled('telegram', true);
    const [sock] = await connPromise;
    const server = collectFrames(sock);
    await server.waitFor('hello');
    sock.send(
      serializeHookMessage(
        makeWelcome({ serverName: 'telegram-server', features: TELEGRAM_FEATURES }),
      ),
    );
    await expect
      .poll(() => manager.snapshot().telegram.status, { timeout: 3000 })
      .toBe('connected');

    sock.send(
      serializeHookMessage(
        makeProviderBindState({
          ...TELEGRAM_PENDING,
          state: 'none',
          attemptId: null,
          scopeId: null,
          scopeName: null,
          connectUrl: null,
          expiresAt: null,
          actions: [],
        }),
      ),
    );
    const start = await server.waitFor('provider.bind.start');
    if (start.type !== 'provider.bind.start') throw new Error('unreachable');
    expect(start.payload.provider).toBe('telegram');

    const pending = { ...TELEGRAM_PENDING, replyTo: start.payload.requestId };
    sock.send(serializeHookMessage(makeProviderBindUpdate(pending)));
    await expect.poll(() => opened, { timeout: 3000 }).toEqual([pending.connectUrl]);
    expect(manager.snapshot().telegram.binding).toMatchObject({
      state: 'pending',
      attemptId: 'attempt-telegram-1',
      scopeName: 'cindy_example_bot',
    });

    // Reconnect/state replay has no replyTo and must never reopen a one-time link.
    sock.send(serializeHookMessage(makeProviderBindState(TELEGRAM_PENDING)));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(opened).toEqual([pending.connectUrl]);

    expect(manager.providerBindCancel('telegram')).toBe(true);
    await expect
      .poll(() => server.frames.some((frame) => frame.type === 'provider.bind.cancel'), {
        timeout: 3000,
      })
      .toBe(true);
    expect(manager.snapshot().telegram.binding).toMatchObject({
      state: 'failed',
      reason: 'cancelled',
    });
    expect(store.get()).toMatchObject({ enabled: false, telegramEnabled: true });
  });

  it('拒绝把非规范或冒充其它 bot 的绑定链接暴露给 renderer', async () => {
    const { wss, url } = await startServer();
    const store = memoryStore({ url, enabled: false, telegramEnabled: false });
    const opened: string[] = [];
    const manager = makeManager(store, {
      openTelegramUrl: (value) => {
        opened.push(value);
      },
    });
    cleanups.push(() => manager.dispose());

    const connPromise = once(wss, 'connection') as Promise<[ServerSocket]>;
    manager.setProviderEnabled('telegram', true);
    const [sock] = await connPromise;
    const server = collectFrames(sock);
    await server.waitFor('hello');
    sock.send(
      serializeHookMessage(
        makeWelcome({ serverName: 'telegram-server', features: TELEGRAM_FEATURES }),
      ),
    );
    await expect
      .poll(() => manager.snapshot().telegram.status, { timeout: 3000 })
      .toBe('connected');
    sock.send(
      serializeHookMessage(
        makeProviderBindState({
          ...TELEGRAM_PENDING,
          state: 'none',
          attemptId: null,
          scopeId: null,
          scopeName: null,
          connectUrl: null,
          expiresAt: null,
          actions: [],
        }),
      ),
    );
    const start = await server.waitFor('provider.bind.start');
    if (start.type !== 'provider.bind.start') throw new Error('unreachable');

    sock.send(
      serializeHookMessage(
        makeProviderBindUpdate({
          ...TELEGRAM_PENDING,
          replyTo: start.payload.requestId,
          connectUrl: `https://example.com/cindy_example_bot?start=${'a'.repeat(43)}`,
        }),
      ),
    );

    await expect
      .poll(() => manager.snapshot().telegram.binding?.reason, { timeout: 3000 })
      .toBe('invalid-connect-url');
    expect(manager.snapshot().telegram.binding).toMatchObject({
      state: 'failed',
      connectUrl: null,
      actions: ['retry'],
    });
    expect(opened).toEqual([]);
  });

  it('welcome 后先到的实时确认不会被迟到的初始 none 快照回滚', async () => {
    const { wss, url } = await startServer();
    const store = memoryStore({ url, enabled: false, telegramEnabled: true });
    const manager = makeManager(store);
    cleanups.push(() => manager.dispose());

    const connPromise = once(wss, 'connection') as Promise<[ServerSocket]>;
    manager.sync();
    const [sock] = await connPromise;
    const server = collectFrames(sock);
    await server.waitFor('hello');
    sock.send(
      serializeHookMessage(
        makeWelcome({ serverName: 'telegram-server', features: TELEGRAM_FEATURES }),
      ),
    );
    await expect
      .poll(() => manager.snapshot().telegram.status, { timeout: 3000 })
      .toBe('connected');

    sock.send(serializeHookMessage(makeProviderBindUpdate(TELEGRAM_CONFIRMED)));
    await expect
      .poll(() => manager.snapshot().telegram.binding?.state, { timeout: 3000 })
      .toBe('confirmed');
    sock.send(
      serializeHookMessage(
        makeProviderBindState({
          ...TELEGRAM_PENDING,
          state: 'none',
          attemptId: null,
          scopeId: null,
          scopeName: null,
          connectUrl: null,
          expiresAt: null,
          actions: [],
        }),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(manager.snapshot().telegram.binding).toMatchObject({
      state: 'confirmed',
      bindingId: 'binding-telegram-1',
    });
    expect(store.get().telegramBindingCache).toMatchObject({
      bindingId: 'binding-telegram-1',
    });
  });

  it('本地绑定缓存写失败时仍保留并广播服务端确认态', async () => {
    const { wss, url } = await startServer();
    const store = memoryStore({ url, enabled: false, telegramEnabled: true });
    store.setProviderBindingCache = () => {
      throw new Error('disk full');
    };
    const warnings: string[] = [];
    const manager = makeManager(store, {
      log: { info: () => {}, warn: (message) => warnings.push(message) },
    });
    cleanups.push(() => manager.dispose());

    const connPromise = once(wss, 'connection') as Promise<[ServerSocket]>;
    manager.sync();
    const [sock] = await connPromise;
    const server = collectFrames(sock);
    await server.waitFor('hello');
    sock.send(
      serializeHookMessage(
        makeWelcome({ serverName: 'telegram-server', features: TELEGRAM_FEATURES }),
      ),
    );
    await expect
      .poll(() => manager.snapshot().telegram.status, { timeout: 3000 })
      .toBe('connected');

    sock.send(serializeHookMessage(makeProviderBindUpdate(TELEGRAM_CONFIRMED)));

    await expect
      .poll(() => manager.snapshot().telegram.binding?.state, { timeout: 3000 })
      .toBe('confirmed');
    expect(manager.snapshot().telegram.binding).toMatchObject({
      bindingId: 'binding-telegram-1',
      principalId: 'telegram-user-1',
    });
    expect(warnings).toContain('persist Telegram binding cache failed (Error)');
  });

  it('丢弃旧 start/cancel/revoke 与旧 binding 状态，不覆盖最新 Telegram 绑定', async () => {
    const { wss, url } = await startServer();
    const store = memoryStore({ url, enabled: false, telegramEnabled: false });
    const opened: string[] = [];
    const manager = makeManager(store, {
      openTelegramUrl: (value) => {
        opened.push(value);
      },
    });
    cleanups.push(() => manager.dispose());

    const connPromise = once(wss, 'connection') as Promise<[ServerSocket]>;
    manager.setProviderEnabled('telegram', true);
    const [sock] = await connPromise;
    const server = collectFrames(sock);
    await server.waitFor('hello');
    sock.send(
      serializeHookMessage(
        makeWelcome({ serverName: 'telegram-server', features: TELEGRAM_FEATURES }),
      ),
    );
    await expect
      .poll(() => manager.snapshot().telegram.status, { timeout: 3000 })
      .toBe('connected');
    sock.send(
      serializeHookMessage(
        makeProviderBindState({
          ...TELEGRAM_PENDING,
          state: 'none',
          attemptId: null,
          scopeId: null,
          scopeName: null,
          connectUrl: null,
          expiresAt: null,
          actions: [],
        }),
      ),
    );
    await expect
      .poll(() => server.frames.filter((frame) => frame.type === 'provider.bind.start').length)
      .toBe(1);
    const firstStart = server.frames.find((frame) => frame.type === 'provider.bind.start');
    if (firstStart?.type !== 'provider.bind.start') throw new Error('unreachable');

    expect(manager.providerBindStart('telegram')).toBe(true);
    await expect
      .poll(() => server.frames.filter((frame) => frame.type === 'provider.bind.start').length)
      .toBe(2);
    const secondStart = server.frames.filter((frame) => frame.type === 'provider.bind.start')[1];
    if (secondStart?.type !== 'provider.bind.start') throw new Error('unreachable');

    sock.send(
      serializeHookMessage(
        makeProviderBindUpdate({
          ...TELEGRAM_PENDING,
          replyTo: firstStart.payload.requestId,
          attemptId: 'attempt-old-start',
        }),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(manager.snapshot().telegram.binding).toMatchObject({
      state: 'pending',
      attemptId: null,
    });
    expect(opened).toEqual([]);

    sock.send(
      serializeHookMessage(
        makeProviderBindUpdate({
          ...TELEGRAM_PENDING,
          replyTo: secondStart.payload.requestId,
          attemptId: 'attempt-current',
        }),
      ),
    );
    await expect
      .poll(() => manager.snapshot().telegram.binding?.attemptId, { timeout: 3000 })
      .toBe('attempt-current');
    expect(opened).toHaveLength(1);

    expect(manager.providerBindCancel('telegram')).toBe(true);
    await expect
      .poll(() => server.frames.filter((frame) => frame.type === 'provider.bind.cancel').length)
      .toBe(1);
    const cancel = server.frames.find((frame) => frame.type === 'provider.bind.cancel');
    if (cancel?.type !== 'provider.bind.cancel') throw new Error('unreachable');
    expect(manager.providerBindStart('telegram')).toBe(true);
    await expect
      .poll(() => server.frames.filter((frame) => frame.type === 'provider.bind.start').length)
      .toBe(3);
    const retry = server.frames.filter((frame) => frame.type === 'provider.bind.start')[2];
    if (retry?.type !== 'provider.bind.start') throw new Error('unreachable');

    sock.send(
      serializeHookMessage(
        makeProviderBindUpdate({
          ...TELEGRAM_PENDING,
          replyTo: cancel.payload.requestId,
          state: 'failed',
          attemptId: 'attempt-current',
          connectUrl: null,
          expiresAt: null,
          reason: 'cancelled',
          actions: ['retry'],
        }),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(manager.snapshot().telegram.binding).toMatchObject({
      state: 'pending',
      attemptId: null,
    });

    sock.send(
      serializeHookMessage(
        makeProviderBindUpdate({
          ...TELEGRAM_PENDING,
          replyTo: retry.payload.requestId,
          attemptId: 'attempt-retry',
        }),
      ),
    );
    await expect
      .poll(() => manager.snapshot().telegram.binding?.attemptId, { timeout: 3000 })
      .toBe('attempt-retry');

    const confirmed = {
      ...TELEGRAM_CONFIRMED,
      bindingId: 'binding-current',
      principalId: 'telegram-user-current',
    };
    sock.send(serializeHookMessage(makeProviderBindUpdate(confirmed)));
    await expect
      .poll(() => manager.snapshot().telegram.binding?.bindingId, { timeout: 3000 })
      .toBe('binding-current');

    sock.send(
      serializeHookMessage(
        makeProviderBindUpdate({
          ...confirmed,
          state: 'revoked',
          bindingId: 'binding-old',
          reason: 'user-revoked',
          actions: ['retry'],
        }),
      ),
    );
    sock.send(
      serializeHookMessage(
        makeProviderBindState({
          ...TELEGRAM_PENDING,
          state: 'none',
          attemptId: null,
          scopeId: null,
          scopeName: null,
          connectUrl: null,
          expiresAt: null,
          actions: [],
        }),
      ),
    );
    sock.send(
      serializeHookMessage(
        makeProviderBindUpdate({ ...TELEGRAM_CONFIRMED, bindingId: 'binding-old' }),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(manager.snapshot().telegram.binding).toMatchObject({
      state: 'confirmed',
      bindingId: 'binding-current',
      principalId: 'telegram-user-current',
    });
    expect(store.get().telegramBindingCache).toMatchObject({ bindingId: 'binding-current' });

    expect(manager.providerBindRevoke('telegram')).toBe(true);
    await expect
      .poll(() => server.frames.filter((frame) => frame.type === 'provider.bind.revoke').length)
      .toBe(1);
    const revoke = server.frames.find((frame) => frame.type === 'provider.bind.revoke');
    if (revoke?.type !== 'provider.bind.revoke') throw new Error('unreachable');
    sock.send(
      serializeHookMessage(
        makeProviderBindUpdate({
          ...TELEGRAM_PENDING,
          replyTo: revoke.payload.requestId,
          state: 'failed',
          attemptId: revoke.payload.requestId,
          connectUrl: null,
          expiresAt: null,
          reason: 'binding-not-found',
          actions: ['retry'],
        }),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(manager.snapshot().telegram.binding).toMatchObject({
      state: 'confirmed',
      bindingId: 'binding-current',
    });
  });

  it('confirmed 绑定持久化、provider 偏好隔离读写，并可显式解绑', async () => {
    const { wss, url } = await startServer();
    const store = memoryStore({ url, enabled: false, telegramEnabled: true });
    const notified: unknown[] = [];
    const opened: string[] = [];
    let rejectOpen = false;
    const manager = makeManager(store, {
      notifyProviderPrefs: (view) => notified.push(view),
      openTelegramUrl: async (value) => {
        if (rejectOpen) throw new Error('no system URL handler');
        opened.push(value);
      },
    });
    cleanups.push(() => manager.dispose());

    const connPromise = once(wss, 'connection') as Promise<[ServerSocket]>;
    manager.sync();
    const [sock] = await connPromise;
    const server = collectFrames(sock);
    await server.waitFor('hello');
    sock.send(
      serializeHookMessage(
        makeWelcome({ serverName: 'telegram-server', features: TELEGRAM_FEATURES }),
      ),
    );
    await expect
      .poll(() => manager.snapshot().telegram.status, { timeout: 3000 })
      .toBe('connected');
    sock.send(serializeHookMessage(makeProviderBindState(TELEGRAM_CONFIRMED)));
    await expect
      .poll(() => manager.snapshot().telegram.binding?.state, { timeout: 3000 })
      .toBe('confirmed');
    const startsBeforeDuplicate = server.frames.filter(
      (frame) => frame.type === 'provider.bind.start',
    ).length;
    expect(manager.providerBindStart('telegram')).toBe(false);
    expect(server.frames.filter((frame) => frame.type === 'provider.bind.start')).toHaveLength(
      startsBeforeDuplicate,
    );
    expect(store.get().telegramBindingCache).toMatchObject({
      bindingId: 'binding-telegram-1',
      principalId: 'telegram-user-1',
      scopeId: 'bot-1',
    });
    await expect(manager.openProviderAction('telegram', 'connect')).resolves.toBe(false);
    await expect(manager.openProviderAction('telegram', 'provider')).resolves.toBe(true);
    await expect(manager.openProviderAction('telegram', 'add-to-group')).resolves.toBe(true);
    expect(opened).toEqual([
      'https://t.me/cindy_example_bot',
      'https://t.me/cindy_example_bot?startgroup=true',
    ]);
    rejectOpen = true;
    await expect(manager.openProviderAction('telegram', 'provider')).rejects.toThrow('no system URL handler');

    const prefs = {
      provider: 'telegram' as const,
      bindingId: 'binding-telegram-1',
      scopeId: null,
      bound: true,
      prefs: [
        {
          workspace: 'xdmaker',
          model: 'gpt-5.6',
          effort: 'high',
          agentKind: 'codex',
          permissionMode: 'full-access',
        },
      ],
    };
    const readPromise = manager.getProviderWorkspacePrefs('telegram');
    const get = await server.waitFor('provider.prefs.get');
    if (get.type !== 'provider.prefs.get') throw new Error('unreachable');
    expect(get.payload).toMatchObject({
      provider: 'telegram',
      bindingId: 'binding-telegram-1',
      scopeId: null,
    });
    sock.send(
      serializeHookMessage(makeProviderPrefsState({ ...prefs, replyTo: get.payload.requestId })),
    );
    await expect(readPromise).resolves.toEqual(prefs);

    const writePromise = manager.setProviderWorkspacePrefs('telegram', 'xdmaker', {
      effort: 'low',
      permissionMode: null,
    });
    const set = await server.waitFor('provider.prefs.set');
    if (set.type !== 'provider.prefs.set') throw new Error('unreachable');
    expect(set.payload).toMatchObject({
      provider: 'telegram',
      bindingId: 'binding-telegram-1',
      scopeId: null,
      workspace: 'xdmaker',
      effort: 'low',
      permissionMode: null,
    });
    expect('model' in set.payload).toBe(false);
    sock.send(
      serializeHookMessage(makeProviderPrefsState({ ...prefs, replyTo: set.payload.requestId })),
    );
    await expect(writePromise).resolves.toEqual(prefs);
    expect(notified).toEqual([prefs, prefs]);

    expect(manager.providerBindRevoke('telegram')).toBe(true);
    await expect
      .poll(() => server.frames.some((frame) => frame.type === 'provider.bind.revoke'), {
        timeout: 3000,
      })
      .toBe(true);
    const revoke = server.frames.find((frame) => frame.type === 'provider.bind.revoke');
    if (revoke?.type !== 'provider.bind.revoke') throw new Error('unreachable');
    expect(revoke.payload).toMatchObject({
      provider: 'telegram',
      bindingId: 'binding-telegram-1',
    });
  });

  it('provider prefs 回执 bindingId 不匹配时立即拒绝，旧绑定迟到帧不能串入', async () => {
    const { wss, url } = await startServer();
    const store = memoryStore({ url, enabled: false, telegramEnabled: true });
    const notified: unknown[] = [];
    const manager = makeManager(store, {
      prefsTimeoutMs: 60_000,
      notifyProviderPrefs: (view) => notified.push(view),
    });
    cleanups.push(() => manager.dispose());

    const connPromise = once(wss, 'connection') as Promise<[ServerSocket]>;
    manager.sync();
    const [sock] = await connPromise;
    const server = collectFrames(sock);
    await server.waitFor('hello');
    sock.send(
      serializeHookMessage(
        makeWelcome({ serverName: 'telegram-server', features: TELEGRAM_FEATURES }),
      ),
    );
    await expect
      .poll(() => manager.snapshot().telegram.status, { timeout: 3000 })
      .toBe('connected');
    sock.send(serializeHookMessage(makeProviderBindState(TELEGRAM_CONFIRMED)));
    await expect
      .poll(() => manager.snapshot().telegram.binding?.state, { timeout: 3000 })
      .toBe('confirmed');

    const promise = manager.getProviderWorkspacePrefs('telegram');
    const get = await server.waitFor('provider.prefs.get');
    if (get.type !== 'provider.prefs.get') throw new Error('unreachable');
    sock.send(
      serializeHookMessage(
        makeProviderPrefsState({
          provider: 'telegram',
          bindingId: 'binding-from-old-generation',
          scopeId: null,
          replyTo: get.payload.requestId,
          bound: true,
          prefs: [],
        }),
      ),
    );
    await expect(promise).rejects.toBeInstanceOf(HookNotConnectedError);
    expect(notified).toEqual([]);

    // 同一 binding 的回执若已超时，也属于未知旧请求，不能重新广播进设置页。
    sock.send(
      serializeHookMessage(
        makeProviderPrefsState({
          provider: 'telegram',
          bindingId: 'binding-telegram-1',
          scopeId: null,
          replyTo: get.payload.requestId,
          bound: true,
          prefs: [],
        }),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(notified).toEqual([]);
  });

  it('provider prefs 请求期间绑定被替换时，旧绑定回执立即拒绝且不广播', async () => {
    const { wss, url } = await startServer();
    const store = memoryStore({ url, enabled: false, telegramEnabled: true });
    const notified: unknown[] = [];
    const manager = makeManager(store, {
      prefsTimeoutMs: 60_000,
      notifyProviderPrefs: (view) => notified.push(view),
    });
    cleanups.push(() => manager.dispose());

    const connPromise = once(wss, 'connection') as Promise<[ServerSocket]>;
    manager.sync();
    const [sock] = await connPromise;
    const server = collectFrames(sock);
    await server.waitFor('hello');
    sock.send(
      serializeHookMessage(
        makeWelcome({ serverName: 'telegram-server', features: TELEGRAM_FEATURES }),
      ),
    );
    await expect
      .poll(() => manager.snapshot().telegram.status, { timeout: 3000 })
      .toBe('connected');
    sock.send(serializeHookMessage(makeProviderBindState(TELEGRAM_CONFIRMED)));
    await expect
      .poll(() => manager.snapshot().telegram.binding?.bindingId, { timeout: 3000 })
      .toBe('binding-telegram-1');

    const promise = manager.getProviderWorkspacePrefs('telegram');
    const rejection = promise.catch((error: unknown) => error);
    const get = await server.waitFor('provider.prefs.get');
    if (get.type !== 'provider.prefs.get') throw new Error('unreachable');

    // A fresh welcome makes its first state snapshot authoritative. This
    // models a reconnect discovering that the principal now belongs to B.
    sock.send(
      serializeHookMessage(
        makeWelcome({ serverName: 'telegram-server-2', features: TELEGRAM_FEATURES }),
      ),
    );
    sock.send(
      serializeHookMessage(
        makeProviderBindState({
          ...TELEGRAM_CONFIRMED,
          bindingId: 'binding-telegram-2',
          principalId: 'telegram-user-2',
          principalName: 'New User',
        }),
      ),
    );
    await expect
      .poll(() => manager.snapshot().telegram.binding?.bindingId, { timeout: 3000 })
      .toBe('binding-telegram-2');
    expect(await rejection).toBeInstanceOf(HookNotConnectedError);

    sock.send(
      serializeHookMessage(
        makeProviderPrefsState({
          provider: 'telegram',
          bindingId: 'binding-telegram-1',
          scopeId: null,
          replyTo: get.payload.requestId,
          bound: true,
          prefs: [],
        }),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(notified).toEqual([]);
  });

  it('sessions 查询只在 session-picker-v1 协商后读取最小化数据源', async () => {
    const { wss, url } = await startServer();
    const store = memoryStore({ url, enabled: true });
    const rows = [
      {
        id: 'session-1',
        title: 'Release task',
        workspace: 'xdmaker',
        lastActiveAt: 1_800_000_000_000,
      },
    ];
    let reads = 0;
    const manager = makeManager(store, {
      listRecentSessions: () => {
        reads += 1;
        return rows;
      },
    });
    cleanups.push(() => manager.dispose());

    const connPromise = once(wss, 'connection') as Promise<[ServerSocket]>;
    manager.sync();
    const [sock] = await connPromise;
    const server = collectFrames(sock);
    await server.waitFor('hello');
    sock.send(serializeHookMessage(makeWelcome({ serverName: 'old-server', features: [] })));
    await expect.poll(() => manager.snapshot().status, { timeout: 3000 }).toBe('connected');

    sock.send(
      serializeHookMessage(makeQueryRequest({ queryId: 'sessions-old', kind: 'sessions' })),
    );
    await expect
      .poll(
        () =>
          server.frames.find(
            (frame) => frame.type === 'query.response' && frame.payload.queryId === 'sessions-old',
          ),
        { timeout: 3000 },
      )
      .toMatchObject({ payload: { ok: false } });
    expect(reads).toBe(0);

    sock.send(
      serializeHookMessage(
        makeWelcome({ serverName: 'new-server', features: [HOOK_FEATURE_SESSION_PICKER] }),
      ),
    );
    sock.send(
      serializeHookMessage(makeQueryRequest({ queryId: 'sessions-new', kind: 'sessions' })),
    );
    await expect
      .poll(
        () =>
          server.frames.find(
            (frame) => frame.type === 'query.response' && frame.payload.queryId === 'sessions-new',
          ),
        { timeout: 3000 },
      )
      .toMatchObject({ payload: { ok: true, sessions: rows } });
    expect(reads).toBe(1);
  });
});

describe('目录偏好远程读写(prefs.get / prefs.set / prefs.state 往返)', () => {
  /** 建连到 connected 的快捷流程, 返回 server socket + 帧收集器。 */
  async function connect(
    manager: ReturnType<typeof createHookControlManager>,
    wss: WebSocketServer,
  ): Promise<{ sock: ServerSocket; server: ReturnType<typeof collectFrames> }> {
    const connPromise = once(wss, 'connection') as Promise<[ServerSocket]>;
    manager.sync();
    const [sock] = await connPromise;
    const server = collectFrames(sock);
    sock.send(serializeHookMessage(makeWelcome({ serverName: 'mock', features: [] })));
    await expect.poll(() => manager.snapshot().status, { timeout: 3000 }).toBe('connected');
    return { sock, server };
  }

  const PREFS_VIEW = {
    bound: true,
    prefs: [
      {
        workspace: 'xdmaker',
        model: 'claude-opus-4-8',
        effort: 'high',
        agentKind: 'claude-code',
        permissionMode: 'ask',
      },
    ],
  };

  it('getWorkspacePrefs: 发 prefs.get(带 requestId), replyTo 配对 resolve 并广播', async () => {
    const { wss, url } = await startServer();
    const store = memoryStore({ url });
    const notified: unknown[] = [];
    const manager = makeManager(store, { notifyPrefs: (v) => notified.push(v) });
    cleanups.push(() => manager.dispose());
    const { sock, server } = await connect(manager, wss);

    const promise = manager.getWorkspacePrefs();
    const get = await server.waitFor('prefs.get');
    if (get.type !== 'prefs.get') throw new Error('unreachable');
    expect(get.payload.requestId.length).toBeGreaterThan(0);
    sock.send(
      serializeHookMessage(makePrefsState({ replyTo: get.payload.requestId, ...PREFS_VIEW })),
    );
    await expect(promise).resolves.toEqual(PREFS_VIEW);
    expect(notified).toEqual([PREFS_VIEW]); // 回执同样广播(多窗口同步)
  });

  it('setWorkspacePrefs: 帧只含已定义 patch 字段(undefined 不进帧, null 保留)', async () => {
    const { wss, url } = await startServer();
    const store = memoryStore({ url });
    const manager = makeManager(store);
    cleanups.push(() => manager.dispose());
    const { sock, server } = await connect(manager, wss);

    const promise = manager.setWorkspacePrefs('xdmaker', { effort: 'low', permissionMode: null });
    const set = await server.waitFor('prefs.set');
    if (set.type !== 'prefs.set') throw new Error('unreachable');
    expect(set.payload.workspace).toBe('xdmaker');
    expect(set.payload.effort).toBe('low');
    expect(set.payload.permissionMode).toBeNull();
    expect('model' in set.payload).toBe(false);
    expect('agentKind' in set.payload).toBe(false);
    sock.send(
      serializeHookMessage(makePrefsState({ replyTo: set.payload.requestId, ...PREFS_VIEW })),
    );
    await expect(promise).resolves.toEqual(PREFS_VIEW);
  });

  it('server 静默(旧版本丢 prefs 帧): 按注入的短超时拒绝 HookPrefsTimeoutError', async () => {
    const { wss, url } = await startServer();
    const store = memoryStore({ url });
    const manager = makeManager(store, { prefsTimeoutMs: 100 });
    cleanups.push(() => manager.dispose());
    await connect(manager, wss);

    await expect(manager.getWorkspacePrefs()).rejects.toBeInstanceOf(HookPrefsTimeoutError);
  });

  it('未连接: 立即拒绝 HookNotConnectedError(provider=slack)', async () => {
    const store = memoryStore({ url: 'ws://127.0.0.1:1', enabled: false });
    const manager = makeManager(store);
    cleanups.push(() => manager.dispose());
    const rejection = await manager.getWorkspacePrefs().catch((err: unknown) => err);
    expect(rejection).toBeInstanceOf(HookNotConnectedError);
    // Slack prefs 失败必须携带 slack provider —— IPC 层据此映射 Slack 文案。
    expect((rejection as HookNotConnectedError).provider).toBe('slack');
  });

  it('主动推送(replyTo null): 只广播, 不惊动在途请求', async () => {
    const { wss, url } = await startServer();
    const store = memoryStore({ url });
    const notified: unknown[] = [];
    const manager = makeManager(store, {
      notifyPrefs: (v) => notified.push(v),
      prefsTimeoutMs: 300,
    });
    cleanups.push(() => manager.dispose());
    const { sock, server } = await connect(manager, wss);

    const promise = manager.getWorkspacePrefs();
    await server.waitFor('prefs.get');
    // /model 卡改动触发的主动推送先到 —— 广播但不 resolve 在途请求
    sock.send(serializeHookMessage(makePrefsState({ replyTo: null, ...PREFS_VIEW })));
    await expect.poll(() => notified.length, { timeout: 2000 }).toBe(1);
    await expect(promise).rejects.toBeInstanceOf(HookPrefsTimeoutError); // 无回执, 到点超时
  });

  it('断线在途请求快速失败(不挂满超时)', async () => {
    const { wss, url } = await startServer();
    const store = memoryStore({ url });
    const manager = makeManager(store, { prefsTimeoutMs: 60_000 });
    cleanups.push(() => manager.dispose());
    const { sock, server } = await connect(manager, wss);

    const promise = manager.getWorkspacePrefs();
    await server.waitFor('prefs.get');
    sock.close(); // server 掉线
    await expect(promise).rejects.toBeInstanceOf(HookNotConnectedError);
  });
});

describe('provider-specific not-connected 映射(issue #279)', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const c of cleanups.splice(0)) c();
  });

  it('IPC 文案随 provider 区分: Telegram 不再复用 Slack 文案', () => {
    expect(hookNotConnectedIpcMessage('telegram')).toBe('Telegram provider is not connected');
    expect(hookNotConnectedIpcMessage('slack')).toBe('slack hook is not connected');
    // 未指定 provider(null = 通用 Hook 失败)返回中性文案, 不把非 Slack 失败
    // 误报成 Slack —— 与 HookNotConnectedError 的 null 语义一致(issue #279 review)。
    expect(hookNotConnectedIpcMessage(null)).toBe('hook is not connected');
  });

  it('Telegram 未启用: getProviderWorkspacePrefs 拒绝 HookNotConnectedError(provider=telegram)', async () => {
    const store = memoryStore({
      url: 'ws://127.0.0.1:1',
      enabled: true,
      telegramEnabled: false,
    });
    const manager = makeManager(store);
    cleanups.push(() => manager.dispose());
    const rejection = await manager
      .getProviderWorkspacePrefs('telegram')
      .catch((err: unknown) => err);
    expect(rejection).toBeInstanceOf(HookNotConnectedError);
    // Telegram 偏好失败必须指向 Telegram provider —— 否则 Slack 在线时会被误诊断线。
    expect((rejection as HookNotConnectedError).provider).toBe('telegram');
    expect(hookNotConnectedIpcMessage((rejection as HookNotConnectedError).provider)).toBe(
      'Telegram provider is not connected',
    );
  });
});

describe('refreshHello(工作目录变更在线重报, 不重建连接)', () => {
  it('已连接: 原连接上重发 hello 携带最新别名清单; 连接不断', async () => {
    const { wss, url } = await startServer();
    const store = memoryStore({ url, workspaces: { xdmaker: 'E:\\AIWork\\Lizi' } });
    const manager = makeManager(store);
    cleanups.push(() => manager.dispose());

    const connPromise = once(wss, 'connection') as Promise<[ServerSocket]>;
    manager.sync();
    const [sock] = await connPromise;
    const server = collectFrames(sock);
    sock.send(serializeHookMessage(makeWelcome({ serverName: 'mock', features: [] })));
    await expect.poll(() => manager.snapshot().status, { timeout: 3000 }).toBe('connected');

    let closed = false;
    sock.on('close', () => (closed = true));
    store.setWorkspaces({ xdmaker: 'E:\\AIWork\\Lizi', blog: 'D:\\repos\\blog' });
    expect(manager.refreshHello()).toBe(true);

    await expect
      .poll(() => server.frames.filter((f) => f.type === 'hello').length, { timeout: 3000 })
      .toBe(2);
    const second = server.frames.filter((f) => f.type === 'hello').at(-1);
    if (second?.type !== 'hello') throw new Error('unreachable');
    expect([...second.payload.workspaces].sort()).toEqual(['blog', 'chat', 'xdmaker']);
    expect(closed).toBe(false); // 连接原地不动 —— 这是与 sync() 重建的本质区别
    expect(manager.snapshot().status).toBe('connected');
  });

  it('未连接: 返回 false(调用方回退 sync)', async () => {
    const store = memoryStore({ url: 'ws://127.0.0.1:1', enabled: false });
    const manager = makeManager(store);
    cleanups.push(() => manager.dispose());
    expect(manager.refreshHello()).toBe(false);
  });
});

describe('内置 chat 伪目录的清单注入', () => {
  it("query 'workspaces' 应答含 chat 且排第一; 与真实别名去重", async () => {
    const { wss, url } = await startServer();
    const store = memoryStore({ url, workspaces: WORKSPACES });
    const manager = makeManager(store);
    cleanups.push(() => manager.dispose());

    const connPromise = once(wss, 'connection') as Promise<[ServerSocket]>;
    manager.sync();
    const [sock] = await connPromise;
    const server = collectFrames(sock);
    sock.send(serializeHookMessage(makeWelcome({ serverName: 'mock', features: [] })));
    await expect.poll(() => manager.snapshot().status, { timeout: 3000 }).toBe('connected');

    sock.send(serializeHookMessage(makeQueryRequest({ queryId: 'q-ws', kind: 'workspaces' })));
    const resp = await server.waitFor('query.response');
    if (resp.type !== 'query.response') throw new Error('unreachable');
    expect(resp.payload.workspaces?.[0]).toBe('chat');
    expect([...(resp.payload.workspaces ?? [])].sort()).toEqual(['blog', 'chat', 'xdmaker']);
    // 去重: 即便(历史遗留)存量配置里有 chat 键, 也只出现一次
    expect(resp.payload.workspaces?.filter((w) => w === 'chat')).toHaveLength(1);
  });
});

describe('Slack 网关工具代理(tool.request/tool.response)', () => {
  /** 建连 -> welcome(带/不带 slack-tools)-> 绑定 confirmed 的通用起手。 */
  async function connectWithTools(opts: {
    features?: string[];
    confirmed?: boolean;
    toolTimeoutMs?: number;
  }) {
    const { wss, url } = await startServer();
    const store = memoryStore({ url, workspaces: WORKSPACES });
    const manager = makeManager(store, {
      ...(opts.toolTimeoutMs !== undefined ? { toolTimeoutMs: opts.toolTimeoutMs } : {}),
    });
    cleanups.push(() => manager.dispose());

    const connPromise = once(wss, 'connection') as Promise<[ServerSocket]>;
    manager.sync();
    const [sock] = await connPromise;
    const server = collectFrames(sock);
    sock.send(
      serializeHookMessage(
        makeWelcome({ serverName: 'mock', features: opts.features ?? [HOOK_FEATURE_SLACK_TOOLS] }),
      ),
    );
    await expect.poll(() => manager.snapshot().status, { timeout: 3000 }).toBe('connected');
    if (opts.confirmed !== false) {
      sock.send(
        serializeHookMessage(
          makeBindUpdate({
            state: 'confirmed',
            slackUserId: 'U1',
            slackUserName: 'tester',
            message: null,
          }),
        ),
      );
      await expect
        .poll(() => manager.snapshot().binding?.state, { timeout: 3000 })
        .toBe('confirmed');
    }
    return { manager, sock, server };
  }

  it('成功往返: tool.request 携带 tool/args, replyTo 配对 resolve 结果', async () => {
    const { manager, sock, server } = await connectWithTools({});
    const pending = manager.callSlackTool('callTool', { name: 'search', arguments: { q: 'x' } });
    const req = await server.waitFor('tool.request');
    if (req.type !== 'tool.request') throw new Error('unreachable');
    expect(req.payload.tool).toBe('callTool');
    expect(req.payload.args).toEqual({ name: 'search', arguments: { q: 'x' } });
    sock.send(
      serializeHookMessage(
        makeToolResponse({ replyTo: req.payload.requestId, ok: true, result: { hit: 1 } }),
      ),
    );
    expect(await pending).toEqual({ ok: true, result: { hit: 1 } });
    // 可用性快照三真
    expect(manager.getSlackToolAvailability()).toMatchObject({
      connected: true,
      bound: true,
      serverSupportsTools: true,
    });
  });

  it('server 侧结构化错误透传(code/message 原样)', async () => {
    const { manager, sock, server } = await connectWithTools({});
    const pending = manager.callSlackTool('listTools');
    const req = await server.waitFor('tool.request');
    if (req.type !== 'tool.request') throw new Error('unreachable');
    sock.send(
      serializeHookMessage(
        makeToolResponse({
          replyTo: req.payload.requestId,
          ok: false,
          error: { code: 'NO_USER_TOKEN', message: '需重新授权' },
        }),
      ),
    );
    const r = await pending;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toEqual({ code: 'NO_USER_TOKEN', message: '需重新授权' });
  });

  it('SERVER_TOO_OLD: welcome 未宣告 slack-tools 时短路, 不发帧', async () => {
    const { manager, server } = await connectWithTools({ features: [] });
    const r = await manager.callSlackTool('status');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('SERVER_TOO_OLD');
    expect(server.frames.some((f) => f.type === 'tool.request')).toBe(false);
  });

  it('NOT_BOUND: 未绑定时短路, 不发帧', async () => {
    const { manager, server } = await connectWithTools({ confirmed: false });
    const r = await manager.callSlackTool('status');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('NOT_BOUND');
    expect(server.frames.some((f) => f.type === 'tool.request')).toBe(false);
  });

  it('HOOK_NOT_CONNECTED: 未连接时短路', async () => {
    const store = memoryStore({ url: 'ws://127.0.0.1:1', enabled: false });
    const manager = makeManager(store);
    cleanups.push(() => manager.dispose());
    const r = await manager.callSlackTool('status');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('HOOK_NOT_CONNECTED');
  });

  it('TIMEOUT: server 不应答时按注入超时收口; 迟到应答静默丢弃', async () => {
    const { manager, sock, server } = await connectWithTools({ toolTimeoutMs: 60 });
    const pending = manager.callSlackTool('listTools');
    const req = await server.waitFor('tool.request');
    if (req.type !== 'tool.request') throw new Error('unreachable');
    const r = await pending;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('TIMEOUT');
    // 迟到帧: 不抛不炸(replyTo 已无配对)
    sock.send(
      serializeHookMessage(
        makeToolResponse({ replyTo: req.payload.requestId, ok: true, result: 1 }),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  it('断线 drain: 在途请求 resolve HOOK_NOT_CONNECTED; 能力保留到下一次 welcome 覆盖', async () => {
    const { manager, sock, server } = await connectWithTools({});
    const pending = manager.callSlackTool('listTools');
    await server.waitFor('tool.request');
    sock.close();
    const r = await pending;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('HOOK_NOT_CONNECTED');
    // 瞬时断线只让调用期 fail-closed，不触发 Codex 工具清单抖动；下一次 welcome
    // 会整组覆盖能力快照。
    expect(manager.getSlackToolAvailability()).toMatchObject({
      connected: false,
      serverSupportsTools: true,
    });
  });
});

describe('多 workspace 绑定(multi-team)', () => {
  const T1 = { teamId: 'T1', teamName: 'acme', slackUserId: 'U1', slackUserName: 'devuser' };
  const T2 = { teamId: 'T2', teamName: 'sideproj', slackUserId: 'U2', slackUserName: 'lizi2' };

  /** 建连到 connected 的 multi-team 起手(welcome 宣告 multi-team [+ 可选 slack-tools])。 */
  async function connectMulti(opts?: {
    managerOverrides?: Partial<HookControlManagerDeps>;
    features?: string[];
  }) {
    const { wss, url } = await startServer();
    const store = memoryStore({ url });
    const manager = makeManager(store, opts?.managerOverrides ?? {});
    cleanups.push(() => manager.dispose());
    const connPromise = once(wss, 'connection') as Promise<[ServerSocket]>;
    manager.sync();
    const [sock] = await connPromise;
    const server = collectFrames(sock);
    await server.waitFor('hello');
    sock.send(
      serializeHookMessage(
        makeWelcome({
          serverName: 'mock-multi',
          features: opts?.features ?? [HOOK_FEATURE_MULTI_TEAM],
        }),
      ),
    );
    await expect.poll(() => manager.snapshot().status, { timeout: 3000 }).toBe('connected');
    return { manager, store, sock, server, wss, url };
  }

  it('hello 声明 multi-team 能力; bind.state 快照整体对齐 + 写本地缓存 + legacy binding 映射', async () => {
    const { manager, store, sock, server } = await connectMulti();
    const hello = server.frames.find((f) => f.type === 'hello');
    if (hello?.type !== 'hello') throw new Error('unreachable');
    expect(hello.payload.features).toContain(HOOK_FEATURE_MULTI_TEAM);

    sock.send(serializeHookMessage(makeBindState({ bindings: [T1, T2] })));
    await expect.poll(() => manager.snapshot().bindings.length, { timeout: 3000 }).toBe(2);
    const snap = manager.snapshot();
    expect(snap.serverMultiTeam).toBe(true);
    expect(snap.bindings).toEqual([
      { ...T1, displaced: false },
      { ...T2, displaced: false },
    ]);
    // legacy binding 字段映射为首个可用绑定(老消费点兼容)
    expect(snap.binding).toMatchObject({
      state: 'confirmed',
      slackUserId: 'U1',
      teamName: 'acme',
    });
    // 本地缓存随快照落盘
    expect(store.get().bindingsCache).toEqual([T1, T2]);
  });

  it('addBinding: 发空 bind.start, pending 落 pendingBind 并弹浏览器; confirmed(teamId) upsert 行 + 清 pendingBind', async () => {
    const opened: string[] = [];
    const { manager, sock, server } = await connectMulti({
      managerOverrides: { openExternalUrl: (u) => opened.push(u) },
    });
    sock.send(serializeHookMessage(makeBindState({ bindings: [T1] })));
    await expect.poll(() => manager.snapshot().bindings.length, { timeout: 3000 }).toBe(1);

    expect(manager.addBinding()).toBe(true);
    const bind = await server.waitFor('bind.start');
    if (bind.type !== 'bind.start') throw new Error('unreachable');
    expect(bind.payload.teamId).toBeUndefined(); // 添加新 workspace: 授权页自选
    expect(manager.snapshot().pendingBind?.state).toBe('pending');

    const authorizeUrl = 'https://slack.example.com/authorize?state=add';
    sock.send(
      serializeHookMessage(
        makeBindUpdate({
          state: 'pending',
          slackUserId: null,
          slackUserName: null,
          message: null,
          authorizeUrl,
        }),
      ),
    );
    await expect
      .poll(() => manager.snapshot().pendingBind?.authorizeUrl, { timeout: 3000 })
      .toBe(authorizeUrl);
    expect(opened).toEqual([authorizeUrl]);
    // 已有真在途授权时重复 addBinding 幂等忽略(不重发帧)
    expect(manager.addBinding()).toBe(true);
    expect(server.frames.filter((f) => f.type === 'bind.start')).toHaveLength(1);

    sock.send(
      serializeHookMessage(
        makeBindUpdate({
          state: 'confirmed',
          slackUserId: 'U2',
          slackUserName: 'lizi2',
          message: null,
          teamId: 'T2',
          teamName: 'sideproj',
        }),
      ),
    );
    await expect.poll(() => manager.snapshot().bindings.length, { timeout: 3000 }).toBe(2);
    expect(manager.snapshot().pendingBind).toBeNull();
    expect(manager.snapshot().bindings[1]).toEqual({ ...T2, displaced: false });
  });

  it('rebindTeam: bind.start 带 teamId(pin 授权页)', async () => {
    const { manager, sock, server } = await connectMulti();
    sock.send(serializeHookMessage(makeBindState({ bindings: [T1] })));
    await expect.poll(() => manager.snapshot().bindings.length, { timeout: 3000 }).toBe(1);
    expect(manager.rebindTeam('T1')).toBe(true);
    const bind = await server.waitFor('bind.start');
    if (bind.type !== 'bind.start') throw new Error('unreachable');
    expect(bind.payload.teamId).toBe('T1');
    expect(manager.snapshot().pendingBind).toMatchObject({ state: 'pending', teamId: 'T1' });
  });

  it('revoked(teamId, reason=superseded): 行保留标注 displaced, 不弹开关不掉线', async () => {
    const { manager, store, sock } = await connectMulti();
    sock.send(serializeHookMessage(makeBindState({ bindings: [T1, T2] })));
    await expect.poll(() => manager.snapshot().bindings.length, { timeout: 3000 }).toBe(2);

    sock.send(
      serializeHookMessage(
        makeBindUpdate({
          state: 'revoked',
          slackUserId: null,
          slackUserName: null,
          message: '已在另一台设备绑定',
          teamId: 'T1',
          reason: 'superseded',
        }),
      ),
    );
    await expect
      .poll(() => manager.snapshot().bindings.find((b) => b.teamId === 'T1')?.displaced, {
        timeout: 3000,
      })
      .toBe(true);
    // 另一行不受影响; 总开关不弹回, 连接保持
    expect(manager.snapshot().bindings.find((b) => b.teamId === 'T2')?.displaced).toBe(false);
    expect(store.get().enabled).toBe(true);
    expect(manager.snapshot().status).toBe('connected');
  });

  it('revoked(teamId, 无 reason): 行直接移除', async () => {
    const { manager, sock } = await connectMulti();
    sock.send(serializeHookMessage(makeBindState({ bindings: [T1, T2] })));
    await expect.poll(() => manager.snapshot().bindings.length, { timeout: 3000 }).toBe(2);
    sock.send(
      serializeHookMessage(
        makeBindUpdate({
          state: 'revoked',
          slackUserId: null,
          slackUserName: null,
          message: null,
          teamId: 'T1',
        }),
      ),
    );
    await expect.poll(() => manager.snapshot().bindings.length, { timeout: 3000 }).toBe(1);
    expect(manager.snapshot().bindings[0].teamId).toBe('T2');
  });

  it('revokeTeam: 发 bind.revoke{teamId} 并乐观移除; displaced 行删除 = 仅清本地', async () => {
    const { manager, store, sock, server } = await connectMulti();
    sock.send(serializeHookMessage(makeBindState({ bindings: [T1, T2] })));
    await expect.poll(() => manager.snapshot().bindings.length, { timeout: 3000 }).toBe(2);

    expect(manager.revokeTeam('T1')).toBe(true);
    const revoke = await server.waitFor('bind.revoke');
    if (revoke.type !== 'bind.revoke') throw new Error('unreachable');
    expect(revoke.payload.teamId).toBe('T1');
    expect(manager.snapshot().bindings.map((b) => b.teamId)).toEqual(['T2']);
    expect(store.get().bindingsCache.map((b) => b.teamId)).toEqual(['T2']);

    // displaced 行删除: 不发帧, 只清本地缓存
    sock.send(
      serializeHookMessage(
        makeBindUpdate({
          state: 'revoked',
          slackUserId: null,
          slackUserName: null,
          message: null,
          teamId: 'T2',
          reason: 'superseded',
        }),
      ),
    );
    await expect
      .poll(() => manager.snapshot().bindings.find((b) => b.teamId === 'T2')?.displaced, {
        timeout: 3000,
      })
      .toBe(true);
    const framesBefore = server.frames.filter((f) => f.type === 'bind.revoke').length;
    expect(manager.revokeTeam('T2')).toBe(true);
    expect(manager.snapshot().bindings).toEqual([]);
    expect(store.get().bindingsCache).toEqual([]);
    await new Promise((r) => setTimeout(r, 30));
    expect(server.frames.filter((f) => f.type === 'bind.revoke')).toHaveLength(framesBefore);
  });

  it('cancelPendingBind: 本地清 pendingBind + 发 bind.revoke{pendingOnly}', async () => {
    const { manager, sock, server } = await connectMulti({
      managerOverrides: { openExternalUrl: () => {} },
    });
    sock.send(serializeHookMessage(makeBindState({ bindings: [T1] })));
    await expect.poll(() => manager.snapshot().bindings.length, { timeout: 3000 }).toBe(1);
    manager.addBinding();
    await server.waitFor('bind.start');
    expect(manager.snapshot().pendingBind?.state).toBe('pending');

    expect(manager.cancelPendingBind()).toBe(true);
    expect(manager.snapshot().pendingBind).toBeNull();
    const revoke = await server.waitFor('bind.revoke');
    if (revoke.type !== 'bind.revoke') throw new Error('unreachable');
    expect(revoke.payload.pendingOnly).toBe(true);
    expect(revoke.payload.teamId ?? null).toBeNull();
  });

  it('关开关(multi-team): 不发全量 bind.revoke, 绑定保留, 重开秒恢复', async () => {
    const gateChanges: boolean[] = [];
    const { manager, store, sock, server } = await connectMulti({
      features: [HOOK_FEATURE_MULTI_TEAM, HOOK_FEATURE_SLACK_TOOLS],
      managerOverrides: {
        onSlackToolProviderEnabledChanged: (enabled) => gateChanges.push(enabled),
      },
    });
    sock.send(serializeHookMessage(makeBindState({ bindings: [T1, T2] })));
    await expect.poll(() => manager.snapshot().bindings.length, { timeout: 3000 }).toBe(2);
    expect(gateChanges).toEqual([true]);

    // ipc SET_ENABLED(false) 的真实编排: revokeAndDisconnect -> setProviderEnabled.
    // revoke 时 store 仍是 enabled，必须在 enabled 位翻转后再关闭工具 gate。
    manager.revokeAndDisconnect();
    manager.setProviderEnabled('slack', false);
    await expect.poll(() => manager.snapshot().status, { timeout: 3000 }).toBe('disabled');
    expect(gateChanges).toEqual([true, false]);
    // 没有任何 bind.revoke 帧(无在途授权时连 pendingOnly 也不发)
    expect(server.frames.some((f) => f.type === 'bind.revoke')).toBe(false);
    // 绑定与缓存保留 —— 「已关闭 · N 个绑定已保留」的数据源
    expect(manager.snapshot().bindings).toHaveLength(2);
    expect(store.get().bindingsCache).toHaveLength(2);
  });

  it('本地缓存 diff: 服务端快照缺失的 team 生成 displaced 行(离线期间被顶)', async () => {
    const { wss, url } = await startServer();
    const store = memoryStore({ url, bindingsCache: [T1, T2] });
    const manager = makeManager(store);
    cleanups.push(() => manager.dispose());
    // 冷启动(未连接)即可从缓存显示绑定行
    expect(manager.snapshot().bindings).toHaveLength(2);

    const connPromise = once(wss, 'connection') as Promise<[ServerSocket]>;
    manager.sync();
    const [sock] = await connPromise;
    const server = collectFrames(sock);
    await server.waitFor('hello');
    sock.send(
      serializeHookMessage(
        makeWelcome({ serverName: 'mock', features: [HOOK_FEATURE_MULTI_TEAM] }),
      ),
    );
    await expect.poll(() => manager.snapshot().status, { timeout: 3000 }).toBe('connected');

    // 服务端只剩 T2(T1 在离线期间被另一台设备顶掉)
    sock.send(serializeHookMessage(makeBindState({ bindings: [T2] })));
    await expect
      .poll(() => manager.snapshot().bindings.find((b) => b.teamId === 'T1')?.displaced, {
        timeout: 3000,
      })
      .toBe(true);
    expect(manager.snapshot().bindings.find((b) => b.teamId === 'T2')?.displaced).toBe(false);
    // displaced 行的 team 信息留在缓存(重启后仍能显示与重绑)
    expect(
      store
        .get()
        .bindingsCache.map((b) => b.teamId)
        .sort(),
    ).toEqual(['T1', 'T2']);
  });

  it('老 server 回落: welcome 无 multi-team 时清掉缓存行, 多绑定动作全部拒绝', async () => {
    const { wss, url } = await startServer();
    const store = memoryStore({ url, bindingsCache: [T1] });
    const manager = makeManager(store);
    cleanups.push(() => manager.dispose());
    const connPromise = once(wss, 'connection') as Promise<[ServerSocket]>;
    manager.sync();
    const [sock] = await connPromise;
    const server = collectFrames(sock);
    await server.waitFor('hello');
    sock.send(serializeHookMessage(makeWelcome({ serverName: 'mock-old', features: [] })));
    await expect.poll(() => manager.snapshot().status, { timeout: 3000 }).toBe('connected');

    // 老 server 是单绑定权威: 缓存行清空, UI 回落单绑定样式
    expect(manager.snapshot().serverMultiTeam).toBe(false);
    expect(manager.snapshot().bindings).toEqual([]);
    expect(store.get().bindingsCache).toEqual([]);
    // 多绑定动作 no-op(不发帧)
    expect(manager.addBinding()).toBe(false);
    expect(manager.rebindTeam('T1')).toBe(false);
    await new Promise((r) => setTimeout(r, 30));
    expect(server.frames.some((f) => f.type === 'bind.start')).toBe(false);
  });

  it('armAutoBind + 空 bind.state: 延迟窗后自动发起首绑(server 无 pending 回放)', async () => {
    const opened: string[] = [];
    const { manager, sock, server } = await connectMulti({
      managerOverrides: { openExternalUrl: (u) => opened.push(u) },
    });
    manager.armAutoBind();
    sock.send(serializeHookMessage(makeBindState({ bindings: [] })));
    // 测试注入 5ms 延迟窗后发起；生产默认仍为 300ms。
    const bind = await server.waitFor('bind.start');
    expect(bind.type).toBe('bind.start');
    const authorizeUrl = 'https://slack.example.com/authorize?state=first';
    sock.send(
      serializeHookMessage(
        makeBindUpdate({
          state: 'pending',
          slackUserId: null,
          slackUserName: null,
          message: null,
          authorizeUrl,
        }),
      ),
    );
    await expect.poll(() => opened, { timeout: 3000 }).toEqual([authorizeUrl]);
  });

  it('armAutoBind + 空 bind.state 后紧跟 pending 回放: 重新发起换新链接, 不用旧链接弹浏览器', async () => {
    const opened: string[] = [];
    let resolveOpened!: () => void;
    const openedPromise = new Promise<void>((resolve) => {
      resolveOpened = resolve;
    });
    const { manager, sock, server } = await connectMulti({
      managerOverrides: {
        openExternalUrl: (u) => {
          opened.push(u);
          resolveOpened();
        },
      },
    });
    vi.useFakeTimers();
    try {
      manager.armAutoBind();
      sock.send(serializeHookMessage(makeBindState({ bindings: [] })));
      // server 回放旧的进行中授权(旧链接) —— 在延迟窗内先到
      sock.send(
        serializeHookMessage(
          makeBindUpdate({
            state: 'pending',
            slackUserId: null,
            slackUserName: null,
            message: null,
            authorizeUrl: 'https://slack.example.com/authorize?state=stale',
          }),
        ),
      );
      await server.waitFor('bind.start');
      expect(opened).toEqual([]); // 旧链接不弹
      const freshUrl = 'https://slack.example.com/authorize?state=fresh';
      sock.send(
        serializeHookMessage(
          makeBindUpdate({
            state: 'pending',
            slackUserId: null,
            slackUserName: null,
            message: null,
            authorizeUrl: freshUrl,
          }),
        ),
      );
      await openedPromise;
      expect(opened).toEqual([freshUrl]);
      // 精确推进测试注入的延迟窗；旧 timer 已在 pending 回放路径清除,
      // 因此不会再发第二个 bind.start。
      await vi.advanceTimersByTimeAsync(5);
      expect(server.frames.filter((f) => f.type === 'bind.start')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('首绑终止态(denied): 开关弹回后快照保留 pendingBind 终止态(设置页兜底行数据源)', async () => {
    const { manager, store, sock, server } = await connectMulti();
    manager.armAutoBind();
    sock.send(serializeHookMessage(makeBindState({ bindings: [] })));
    await server.waitFor('bind.start');
    sock.send(
      serializeHookMessage(
        makeBindUpdate({
          state: 'pending',
          slackUserId: null,
          slackUserName: null,
          message: null,
          authorizeUrl: 'https://slack.example.com/authorize?state=x',
        }),
      ),
    );
    await expect
      .poll(() => manager.snapshot().pendingBind?.state, { timeout: 3000 })
      .toBe('pending');
    // 用户在授权页点取消 → server 推 denied → 首绑(0 绑定)自动关开关,
    // 但终止态必须留在快照里 —— 渲染层靠它显示失败原因与重试提示,
    // 否则用户只看到开关静默弹回(review P1)
    sock.send(
      serializeHookMessage(
        makeBindUpdate({ state: 'denied', slackUserId: null, slackUserName: null, message: null }),
      ),
    );
    await expect.poll(() => store.get().enabled, { timeout: 3000 }).toBe(false);
    const snap = manager.snapshot();
    expect(snap.pendingBind?.state).toBe('denied');
    expect(snap.bindings).toEqual([]);
  });

  it('添加流授权落在已绑定 team: 合成 already-bound 终止态提示; 指定 team 重绑不提示', async () => {
    const { manager, sock, server } = await connectMulti();
    sock.send(serializeHookMessage(makeBindState({ bindings: [T1] })));
    await expect.poll(() => manager.snapshot().bindings.length, { timeout: 3000 }).toBe(1);

    // 「添加 workspace」流: 用户在授权页没切 workspace, confirmed 回的还是 T1
    expect(manager.addBinding()).toBe(true);
    await server.waitFor('bind.start');
    sock.send(
      serializeHookMessage(
        makeBindUpdate({
          state: 'confirmed',
          slackUserId: 'U1',
          slackUserName: 'devuser',
          message: null,
          teamId: 'T1',
          teamName: 'acme',
        }),
      ),
    );
    await expect
      .poll(() => manager.snapshot().pendingBind?.reason, { timeout: 3000 })
      .toBe('already-bound');
    const snap = manager.snapshot();
    expect(snap.pendingBind?.state).toBe('failed');
    expect(snap.pendingBind?.teamId).toBe('T1');
    expect(snap.bindings).toHaveLength(1);

    // 指定 team 的重绑(刷新授权)回到同 team 是预期动作, 不合成提示
    expect(manager.cancelPendingBind()).toBe(true);
    expect(manager.rebindTeam('T1')).toBe(true);
    await expect
      .poll(() => server.frames.filter((f) => f.type === 'bind.start').length, { timeout: 3000 })
      .toBe(2);
    sock.send(
      serializeHookMessage(
        makeBindUpdate({
          state: 'confirmed',
          slackUserId: 'U1',
          slackUserName: 'devuser',
          message: null,
          teamId: 'T1',
          teamName: 'acme',
        }),
      ),
    );
    await expect.poll(() => manager.snapshot().pendingBind, { timeout: 3000 }).toBeNull();
    expect(manager.snapshot().bindings).toHaveLength(1);
  });

  it('tool.request 携带 teamId; bound 判据 = 存在可用绑定(无需 legacy confirmed)', async () => {
    const { manager, sock, server } = await connectMulti({
      features: [HOOK_FEATURE_MULTI_TEAM, HOOK_FEATURE_SLACK_TOOLS],
    });
    sock.send(serializeHookMessage(makeBindState({ bindings: [T1, T2] })));
    await expect.poll(() => manager.snapshot().bindings.length, { timeout: 3000 }).toBe(2);
    expect(manager.getSlackToolAvailability()).toMatchObject({
      bound: true,
      multiTeam: true,
      bindings: [
        { teamId: 'T1', teamName: 'acme' },
        { teamId: 'T2', teamName: 'sideproj' },
      ],
    });

    const pending = manager.callSlackTool('callTool', { name: 'search' }, 'T2');
    const req = await server.waitFor('tool.request');
    if (req.type !== 'tool.request') throw new Error('unreachable');
    expect(req.payload.teamId).toBe('T2');
    sock.send(
      serializeHookMessage(
        makeToolResponse({ replyTo: req.payload.requestId, ok: true, result: 1 }),
      ),
    );
    expect(await pending).toEqual({ ok: true, result: 1 });

    // 不带 teamId 的调用(如 status 总览)不注入字段
    const pending2 = manager.callSlackTool('status');
    const req2 = await new Promise<HookMessage>((resolve) => {
      const check = (): void => {
        const hits = server.frames.filter((f) => f.type === 'tool.request');
        if (hits.length >= 2) resolve(hits[1]);
        else setTimeout(check, 10);
      };
      check();
    });
    if (req2.type !== 'tool.request') throw new Error('unreachable');
    expect('teamId' in req2.payload).toBe(false);
    sock.send(
      serializeHookMessage(
        makeToolResponse({ replyTo: req2.payload.requestId, ok: true, result: 2 }),
      ),
    );
    expect(await pending2).toEqual({ ok: true, result: 2 });
  });

  it('prefs.set 携带 teamId(multi-team 下偏好归属)', async () => {
    const { manager, sock, server } = await connectMulti();
    sock.send(serializeHookMessage(makeBindState({ bindings: [T1] })));
    await expect.poll(() => manager.snapshot().bindings.length, { timeout: 3000 }).toBe(1);

    const promise = manager.setWorkspacePrefs('xdmaker', { effort: 'low' }, 'T1');
    const set = await server.waitFor('prefs.set');
    if (set.type !== 'prefs.set') throw new Error('unreachable');
    expect(set.payload.teamId).toBe('T1');
    expect(set.payload.effort).toBe('low');
    sock.send(
      serializeHookMessage(
        makePrefsState({ replyTo: set.payload.requestId, bound: true, prefs: [] }),
      ),
    );
    await expect(promise).resolves.toEqual({ bound: true, prefs: [] });
  });
});
