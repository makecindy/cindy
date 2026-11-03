/**
 * browserExtensionSlot.test — 浏览器扩展槽(browserExtension)的假 deps 单测。
 *
 * 测试价值
 * - 生产入口与可观察结果:GhostBrowserExtensionSlot.reconcile / handleRequest / getPageControl;
 *   桥接按插件启停、native host 注册、策略持久化与恢复、转交事件投递与离线回退。
 * - 规则依据:docs/dev-rules/plugin-security-and-authoring.md(能力声明即授权边界;
 *   停用/卸载即休眠)与 2026-10-27 桥接迁入宿主的决定(翻译等转交必须到达插件)。
 * - 现有覆盖缺口:新槽。
 * - 最小失败输入:未声明能力的插件发请求;策略文件存在但桥接未恢复;逻辑页离线且拉起失败。
 * - tier:unit(假桥接、临时目录);Windows 单文件 2.14 秒、用例执行 1.20 秒(2026-10-30)。
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  BrowserExtensionBridgeOptions,
  BrowserExtensionRelayNotice,
} from '../../browser-extension/bridge';
import { defaultBrowserExtensionPolicy } from '../../browser-extension/policy';
import type { InstalledGhost } from '../../../shared/ghost';
import { GhostBrowserExtensionSlot, type BrowserExtensionSlotDeps } from '../browserExtensionSlot';

const CHROME_ID = 'a'.repeat(32);

function extGhost(
  options: {
    id?: string;
    enabled?: boolean;
    declare?: boolean;
    pageControl?: boolean;
    nativeHost?: boolean;
    version?: string;
  } = {},
): InstalledGhost {
  const id = options.id ?? 'my-browser';
  return {
    manifest: {
      schemaVersion: 3,
      id,
      name: 'Ext Ghost',
      version: options.version ?? '1.0.0',
      entry: 'main.js',
      node: { entry: 'node/worker.cjs' },
      ...(options.declare !== false
        ? {
            browserExtension: {
              protocol: 'cindy-browser-extension/3',
              extensionIds: [CHROME_ID],
              ...(options.nativeHost !== false
                ? { nativeHost: { name: 'com.makecindy.browser', binary: 'native-host/bin' } }
                : {}),
              ...(options.pageControl !== false ? { pageControl: true as const } : {}),
            },
          }
        : {}),
    },
    dir: `/fake/${id}`,
    instanceKey: `_root__${id}`,
    enabled: options.enabled ?? true,
    approval: { state: 'approved', revision: 1 },
  } as unknown as InstalledGhost;
}

class FakeBridge {
  started = false;
  closed = false;
  listeningPort = 0;
  policy = defaultBrowserExtensionPolicy();
  calls: Array<[string, unknown[]]> = [];
  constructor(readonly options: BrowserExtensionBridgeOptions) {}
  async start() {
    this.started = true;
    this.listeningPort = 18810;
  }
  async close() {
    this.closed = true;
  }
  async status() {
    return {
      ok: true as const,
      version: '0',
      protocol: 3,
      port: this.listeningPort,
      extension_connected: true,
      extension_ids: [CHROME_ID],
      policy: this.policy,
      pending: 0,
      clients: [],
    };
  }
  connectedClients() {
    return [];
  }
  async act(action: unknown, payload: unknown) {
    this.calls.push(['act', [action, payload]]);
    return { ok: true, text: 'hello' };
  }
  setPolicy() {
    this.calls.push(['setPolicy', []]);
    return { ok: true as const, policy: this.policy };
  }
  setTrustedClients(clients: unknown) {
    this.calls.push(['setTrustedClients', [clients]]);
    return { ok: true as const };
  }
  relayActive(id: string) {
    this.calls.push(['relayActive', [id]]);
    return { ok: true as const, active: true };
  }
  relayProgress(id: string, progress: unknown) {
    this.calls.push(['relayProgress', [id, progress]]);
    return { ok: true as const };
  }
  relayResult(id: string, result: unknown) {
    this.calls.push(['relayResult', [id, result]]);
    return { ok: true as const };
  }
  emitRelay(notice: BrowserExtensionRelayNotice) {
    this.options.onRelay?.(notice);
  }
}

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeSlot(
  overrides: Partial<BrowserExtensionSlotDeps> = {},
  ghosts: InstalledGhost[] = [extGhost()],
) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-browser-extension-slot-'));
  dirs.push(dir);
  const bridges: FakeBridge[] = [];
  const natives: Array<{
    token: string;
    install: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    status: () => 'ready';
  }> = [];
  const sent: Array<[string, unknown]> = [];
  const deps: BrowserExtensionSlotDeps = {
    getGhost: (id) => ghosts.find((g) => g.instanceKey === id || g.manifest.id === id) ?? null,
    sendToGhost: vi.fn((ghostId, payload) => {
      sent.push([ghostId, payload]);
      return true;
    }),
    policyDir: () => dir,
    isVerifiedOfficial: () => true,
    ownerScopeKey: () => 'owner-a',
    createBridge: (options) => {
      const bridge = new FakeBridge(options);
      bridges.push(bridge);
      return bridge as unknown as ReturnType<NonNullable<BrowserExtensionSlotDeps['createBridge']>>;
    },
    createNativeBinding: () => {
      const native = {
        token: 'f'.repeat(64),
        install: vi.fn(async () => ({ ok: true as const })),
        close: vi.fn(async () => undefined),
        status: () => 'ready' as const,
      };
      natives.push(native);
      return native;
    },
    ...overrides,
  };
  const slot = new GhostBrowserExtensionSlot(deps);
  // 桥接就绪链里有真实文件读取(恢复策略),给几个事件循环周期让它落定。
  const settle = () => new Promise((r) => setTimeout(r, 25));
  return { slot, deps, bridges, natives, sent, dir, ghosts, settle };
}

describe('browserExtensionSlot · 桥接随花名册启停', () => {
  it('已启用且声明能力的插件各开一份桥接并注册 native host;停用即关;换版即重建', async () => {
    const ghosts = [
      extGhost(),
      extGhost({ id: 'plain', declare: false }),
      extGhost({ id: 'off', enabled: false }),
    ];
    const { slot, bridges, natives, settle } = await makeSlot({}, ghosts);
    slot.reconcile(ghosts);
    await settle();
    expect(bridges).toHaveLength(1);
    expect(bridges[0].options).toMatchObject({
      ghostId: 'my-browser',
      installedVersion: '1.0.0',
      extensionIds: [CHROME_ID],
      nativeToken: 'f'.repeat(64),
    });
    expect(bridges[0].started).toBe(true);
    expect(natives[0].install).toHaveBeenCalledWith(18810, [CHROME_ID]);
    expect(slot.getPageControl()).toMatchObject({
      ghostId: 'my-browser',
      instanceId: '_root__my-browser',
      pluginName: 'Ext Ghost',
    });
    // 幂等:同一份花名册不重建。
    slot.reconcile(ghosts);
    await settle();
    expect(bridges).toHaveLength(1);
    // 换版:关旧开新。
    const upgraded = [extGhost({ version: '1.1.0' })];
    slot.reconcile(upgraded);
    await settle();
    expect(bridges[0].closed).toBe(true);
    expect(natives[0].close).toHaveBeenCalledOnce();
    expect(bridges).toHaveLength(2);
    expect(bridges[1].options.installedVersion).toBe('1.1.0');
    // 停用:关掉,不再提供页面控制。
    slot.reconcile([extGhost({ version: '1.1.0', enabled: false })]);
    await settle();
    expect(bridges[1].closed).toBe(true);
    expect(slot.getPageControl()).toBeNull();
  });

  // Review 2026-10-29 (re-review): on an update the old bridge's stop and the new one's start ran
  // concurrently, so the old binding saw no live connection and withdrew the new registration.
  it('换版时新桥接等旧桥接与 native 注册关完后才安装', async () => {
    const order: string[] = [];
    const { slot, natives } = await makeSlot();
    const wrapNative = (n: (typeof natives)[number], i: number) => {
      n.install.mockImplementation(async () => {
        order.push(`install${i}`);
        return { ok: true as const };
      });
      n.close.mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 30));
        order.push(`close${i}`);
      });
    };
    slot.reconcile([extGhost()]);
    await vi.waitFor(() => expect(natives[0]).toBeDefined());
    wrapNative(natives[0], 0);
    await vi
      .waitFor(() => expect(order).toContain('install0'), { timeout: 2000 })
      .catch(() => undefined);
    order.length = 0;
    slot.reconcile([extGhost({ version: '1.1.0' })]);
    await vi.waitFor(() => expect(natives[1]).toBeDefined());
    wrapNative(natives[1], 1);
    await vi.waitFor(() => expect(order).toContain('install1'));
    expect(order.indexOf('close0')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('close0')).toBeLessThan(order.indexOf('install1'));
  });

  // Native hosts run outside the sandbox and share one registration per account, so a plugin that
  // is not the official Cindy Chrome must not get one, even under the official name.
  it('只有官方 Cindy Chrome 能装 native host;其它插件声明了也只开桥接', async () => {
    const ghosts = [extGhost({ id: 'impostor' })];
    const { slot, bridges, natives, settle } = await makeSlot({}, ghosts);
    slot.reconcile(ghosts);
    await settle();
    expect(bridges).toHaveLength(1);
    expect(bridges[0].started).toBe(true);
    expect(bridges[0].options.nativeToken).toBeUndefined();
    expect(natives).toHaveLength(0);
  });

  it('没有 pageControl 的声明只做通道,不成为 Browser Use 执行端', async () => {
    const ghosts = [extGhost({ pageControl: false, nativeHost: false })];
    const { slot, bridges, natives, settle } = await makeSlot({}, ghosts);
    slot.reconcile(ghosts);
    await settle();
    expect(bridges).toHaveLength(1);
    expect(bridges[0].options.nativeToken).toBeUndefined();
    expect(natives).toHaveLength(0);
    expect(slot.getPageControl()).toBeNull();
  });

  // 2026-10-30: only the official Cindy Chrome takes over My browser; another plugin's declaration is ignored.
  it('其它插件声明 pageControl 也不会成为「我的浏览器」', async () => {
    const ghosts = [extGhost({ id: 'other-browser', nativeHost: false })];
    const { slot, bridges, settle } = await makeSlot({}, ghosts);
    slot.reconcile(ghosts);
    await settle();
    expect(bridges).toHaveLength(1);
    expect(slot.getPageControl()).toBeNull();
  });
});

describe('browserExtensionSlot · 管子上行', () => {
  it('未声明能力 / 未启用的插件一律 PERMISSION_DENIED;桥接未就绪 HOST_NOT_READY', async () => {
    const ghosts = [
      extGhost(),
      extGhost({ id: 'plain', declare: false }),
      extGhost({ id: 'off', enabled: false }),
    ];
    const { slot } = await makeSlot({}, ghosts);
    expect(await slot.handleRequest('_root__plain', { kind: 'status' })).toMatchObject({
      ok: false,
      errorCode: 'PERMISSION_DENIED',
    });
    expect(await slot.handleRequest('_root__off', { kind: 'status' })).toMatchObject({
      ok: false,
      errorCode: 'PERMISSION_DENIED',
    });
    expect(await slot.handleRequest('_root__my-browser', { kind: 'status' })).toMatchObject({
      ok: false,
      errorCode: 'HOST_NOT_READY',
    });
  });

  it('status / act / setTrustedClients / relay* 原样转给桥接;旧插件的 setPolicy 应答不落盘;配对重启后恢复', async () => {
    const { slot, bridges, dir, ghosts, settle } = await makeSlot();
    slot.reconcile(ghosts);
    await settle();
    const id = '_root__my-browser';
    expect(await slot.handleRequest(id, 'nope')).toMatchObject({
      ok: false,
      errorCode: 'INVALID_REQUEST',
    });
    expect(await slot.handleRequest(id, { kind: 'status' })).toMatchObject({
      ok: true,
      port: 18810,
      host: true,
      nativeBinding: 'ready',
    });
    expect(
      await slot.handleRequest(id, {
        kind: 'act',
        action: 'text',
        payload: { url: 'https://example.test' },
      }),
    ).toMatchObject({ ok: true, text: 'hello' });
    expect(bridges[0].calls.at(-1)).toEqual(['act', ['text', { url: 'https://example.test' }]]);
    // Site lists were removed (2026-10-30): a plugin that still pushes one gets an acknowledgement.
    const policy = {
      read: { block: ['blocked.test'] },
      interact: { allow: ['example.test'], block: [] },
    };
    expect(await slot.handleRequest(id, { kind: 'setPolicy', policy })).toMatchObject({
      ok: true,
      policy: { read: { block: [] } },
    });
    expect(await slot.handleRequest(id, { kind: 'setTrustedClients', clients: [] })).toEqual({
      ok: true,
    });
    expect(
      JSON.parse(await fs.readFile(path.join(dir, encodeURIComponent(id) + '.json'), 'utf8')),
    ).toEqual({ version: 1, source: '[null,null]', trustedClients: [] });
    expect(await slot.handleRequest(id, { kind: 'relayActive', id: 'r1' })).toEqual({
      ok: true,
      active: true,
    });
    expect(
      await slot.handleRequest(id, {
        kind: 'relayProgress',
        id: 'r1',
        progress: { stage: 'model' },
      }),
    ).toEqual({ ok: true });
    expect(
      await slot.handleRequest(id, { kind: 'relayResult', id: 'r1', result: { ok: true } }),
    ).toEqual({ ok: true });
    expect(await slot.handleRequest(id, { kind: 'relayResult' })).toMatchObject({
      ok: false,
      errorCode: 'INVALID_REQUEST',
    });
    expect(await slot.handleRequest(id, { kind: 'mystery' })).toMatchObject({
      ok: false,
      errorCode: 'INVALID_REQUEST',
    });
    // 重启(新槽、同目录):先恢复配对再 start,不再向插件索要;旧版本存下的名单被忽略。
    await fs.writeFile(
      path.join(dir, encodeURIComponent(id) + '.json'),
      JSON.stringify({ version: 1, policy, trustedClients: [] }),
    );
    const again = await makeSlot({ policyDir: () => dir });
    again.slot.reconcile(again.ghosts);
    await vi.waitFor(() => expect(again.bridges[0]?.started).toBe(true));
    expect(again.bridges[0].calls).toEqual([['setTrustedClients', [[]]]]);
    expect(
      again.sent.some(
        ([, payload]) => (payload as { name?: string }).name === 'browser-extension-policy-request',
      ),
    ).toBe(false);
  });

  // Review 2026-10-30 (Codex P2): a native install that failed for a passing reason is retried on status.
  it('原生连接程序安装失败后,status 请求按 30 秒节流重试', async () => {
    let now = 1_000_000;
    let installs = 0;
    let state: 'ready' | 'unavailable' = 'unavailable';
    const { slot, bridges, settle, ghosts } = await makeSlot({
      now: () => now,
      createNativeBinding: () => ({
        token: 'f'.repeat(64),
        install: vi.fn(async () => {
          installs++;
          if (installs >= 2) state = 'ready';
          return state === 'ready'
            ? { ok: true as const }
            : { ok: false as const, error: 'NATIVE_BINDING_UNAVAILABLE' as const, reason: 'EBUSY' };
        }),
        close: vi.fn(async () => undefined),
        status: () => state,
      }),
    });
    slot.reconcile(ghosts);
    await settle();
    expect(installs).toBe(1);
    await slot.handleRequest('_root__my-browser', { kind: 'status' });
    expect(installs).toBe(2);
    expect(bridges).toHaveLength(1);
    await slot.handleRequest('_root__my-browser', { kind: 'status' });
    expect(installs).toBe(2);
  });

  // Review 2026-10-30 (Codex P1): stopping waits for a native install retry, so it cannot write after the close.
  it('原生安装重试进行中停用插件时,等重试结束后才撤销注册', async () => {
    const order: string[] = [];
    let finishRetry: () => void = () => undefined;
    let installs = 0;
    const { slot, settle, ghosts } = await makeSlot({
      createNativeBinding: () => ({
        token: 'f'.repeat(64),
        install: vi.fn(async () => {
          installs++;
          if (installs === 1)
            return {
              ok: false as const,
              error: 'NATIVE_BINDING_UNAVAILABLE' as const,
              reason: 'EBUSY',
            };
          await new Promise<void>((resolve) => (finishRetry = resolve));
          order.push('install-done');
          return { ok: true as const };
        }),
        close: vi.fn(async () => {
          order.push('close');
        }),
        status: () => 'unavailable' as const,
      }),
    });
    slot.reconcile(ghosts);
    await settle();
    const pending = slot.handleRequest('_root__my-browser', { kind: 'status' });
    await vi.waitFor(() => expect(installs).toBe(2));
    slot.reconcile([]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order).toEqual([]);
    finishRetry();
    await pending.catch(() => undefined);
    await vi.waitFor(() => expect(order).toEqual(['install-done', 'close']));
  });

  // Review 2026-10-30 (Codex P1): a request that waited for startup must not act after the plugin went away.
  it('等待启动期间插件被停用时,旧请求不再执行', async () => {
    let finishStart: () => void = () => undefined;
    const { slot, bridges, settle, ghosts } = await makeSlot();
    slot.reconcile(ghosts);
    await vi.waitFor(() => expect(bridges).toHaveLength(1));
    bridges[0].start = () => new Promise<void>((resolve) => (finishStart = resolve));
    await settle();
    const pending = slot.handleRequest('_root__my-browser', {
      kind: 'setTrustedClients',
      clients: [],
    });
    slot.reconcile([]);
    finishStart();
    expect(await pending).toMatchObject({ ok: false, errorCode: 'HOST_NOT_READY' });
    expect(bridges[0].calls.some(([name]) => name === 'setTrustedClients')).toBe(false);
  });

  // Review 2026-10-30 (Codex P2): a failed startup is rebuilt by the next request instead of staying failed.
  it('启动失败后下一次请求重建整套启动流程', async () => {
    const { slot, bridges, natives, settle, ghosts } = await makeSlot();
    slot.reconcile(ghosts);
    await vi.waitFor(() => expect(bridges).toHaveLength(1));
    // The first start fails (for example every compatible port is busy).
    bridges[0].start = async () => {
      throw new Error('ports busy');
    };
    await settle();
    expect(await slot.handleRequest('_root__my-browser', { kind: 'status' })).toMatchObject({
      ok: false,
      errorCode: 'HOST_NOT_READY',
    });
    // The request rebuilt the whole sequence: a new bridge started and the native binding was installed.
    await vi.waitFor(() => expect(bridges.at(-1)?.started).toBe(true));
    expect(bridges.length).toBeGreaterThan(1);
    expect(natives.length).toBeGreaterThan(0);
    expect(await slot.handleRequest('_root__my-browser', { kind: 'status' })).toMatchObject({
      ok: true,
    });
  });

  // Review 2026-10-30 (Codex P1): a package that only claims the official id cannot pair browsers.
  it('只自称官方 id 的未核验包不能保存配对', async () => {
    const clients = [
      {
        id: 'c1',
        origin: 'chrome-extension://' + CHROME_ID,
        extensionId: CHROME_ID,
        publicKey: 'k',
      },
    ];
    const { slot, bridges, settle, ghosts } = await makeSlot({ isVerifiedOfficial: () => false });
    slot.reconcile(ghosts);
    await settle();
    expect(
      await slot.handleRequest('_root__my-browser', { kind: 'setTrustedClients', clients }),
    ).toMatchObject({
      ok: false,
      errorCode: 'PERMISSION_DENIED',
    });
    expect(bridges[0].calls.some(([name]) => name === 'setTrustedClients')).toBe(false);
    // Another plugin id is not an official claimant: its pairings work as before.
    const other = [extGhost({ id: 'other-browser', nativeHost: false })];
    const b = await makeSlot({ isVerifiedOfficial: () => false }, other);
    b.slot.reconcile(other);
    await b.settle();
    expect(
      await b.slot.handleRequest('_root__other-browser', {
        kind: 'setTrustedClients',
        clients: [],
      }),
    ).toEqual({ ok: true });
  });

  // Review 2026-10-30 (Codex P1): raw DevTools commands from a plugin that is not the verified official one.
  it('非官方插件不能经管子发原始 DevTools 命令', async () => {
    const payload = {
      kind: 'act',
      action: 'cdp',
      payload: {
        url: 'https://example.test',
        tabId: 1,
        op: 'command',
        method: 'DOM.setFileInputFiles',
        params: { files: ['/etc/hosts'] },
      },
    };
    const other = [extGhost({ id: 'other-browser', nativeHost: false })];
    const a = await makeSlot({}, other);
    a.slot.reconcile(other);
    await a.settle();
    expect(await a.slot.handleRequest('_root__other-browser', payload)).toMatchObject({
      ok: false,
      errorCode: 'INVALID_REQUEST',
    });
    expect(a.bridges[0].calls.some(([name]) => name === 'act')).toBe(false);
    const official = await makeSlot();
    official.slot.reconcile(official.ghosts);
    await official.settle();
    await official.slot.handleRequest('_root__my-browser', payload);
    expect(official.bridges[0].calls.some(([name]) => name === 'act')).toBe(true);
  });

  // Review 2026-10-30 (Codex P1): a plugin cannot name host paths for Chrome to open.
  it('插件管子不能按路径上传', async () => {
    const { slot, bridges, settle, ghosts } = await makeSlot();
    slot.reconcile(ghosts);
    await settle();
    const refused = await slot.handleRequest('_root__my-browser', {
      kind: 'act',
      action: 'upload',
      payload: { url: 'https://example.test', tabId: 1, selector: 'input', paths: ['/etc/hosts'] },
    });
    expect(refused).toMatchObject({ ok: false, errorCode: 'INVALID_REQUEST' });
    expect(bridges[0].calls.some(([name]) => name === 'act')).toBe(false);
  });

  // Review 2026-10-30 (Codex P1): a manifest that merely claims the official id must not get the native
  // host, My browser or saved pairings.
  it('未核验来源的包不装 native host、不接管「我的浏览器」、不继承配对', async () => {
    const clients = [
      {
        id: 'c1',
        origin: 'chrome-extension://' + CHROME_ID,
        extensionId: CHROME_ID,
        publicKey: 'k',
      },
    ];
    const { slot, bridges, natives, dir } = await makeSlot({ isVerifiedOfficial: () => false });
    await fs.writeFile(
      path.join(dir, encodeURIComponent('_root__my-browser') + '.json'),
      JSON.stringify({ version: 1, source: '[null,null]', trustedClients: clients }),
    );
    slot.reconcile([extGhost()]);
    await vi.waitFor(() => expect(bridges[0]?.started).toBe(true));
    expect(natives).toHaveLength(0);
    expect(slot.getPageControl()).toBeNull();
    expect(bridges[0].calls.some(([name]) => name === 'setTrustedClients')).toBe(false);
  });

  // A pairing cache written before sources were recorded is stamped when first read.
  // Windows CI #41050204850: polling the destination races the background rename
  // (and may hold the file open during replacement). Wait for the real rename,
  // then verify both provenance and retained clients without another write request.
  it('没有来源记录的旧配对缓存读到后立即补上来源', async () => {
    const clients = [
      {
        id: 'c1',
        origin: 'chrome-extension://' + CHROME_ID,
        extensionId: CHROME_ID,
        publicKey: 'k',
      },
    ];
    const { slot, bridges, dir } = await makeSlot();
    const file = path.join(dir, encodeURIComponent('_root__my-browser') + '.json');
    await fs.writeFile(file, JSON.stringify({ version: 1, trustedClients: clients }));
    const originalRename = fs.rename.bind(fs);
    let complete!: () => void;
    let fail!: (error: unknown) => void;
    const persisted = new Promise<void>((resolve, reject) => {
      complete = resolve;
      fail = reject;
    });
    const rename = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      try {
        await originalRename(from, to);
        if (to === file) complete();
      } catch (error) {
        if (to === file) fail(error);
        throw error;
      }
    });
    try {
      slot.reconcile([extGhost()]);
      await persisted;
      await vi.waitFor(() => expect(bridges[0]?.started).toBe(true));
      expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({
        version: 1,
        source: '[null,null]',
        trustedClients: clients,
      });
    } finally {
      await slot.dispose();
      rename.mockRestore();
    }
  });

  // Review 2026-10-29 (Codex P1): a package from another source reused the old package's pairings.
  it('换成其它来源的包时不沿用旧配对', async () => {
    const { slot, bridges, sent, dir } = await makeSlot();
    const clients = [
      {
        id: 'c1',
        origin: 'chrome-extension://' + CHROME_ID,
        extensionId: CHROME_ID,
        publicKey: 'k',
      },
    ];
    await fs.writeFile(
      path.join(dir, encodeURIComponent('_root__my-browser') + '.json'),
      JSON.stringify({
        version: 1,
        source: JSON.stringify([{ kind: 'local', source: 'manual' }, null]),
        trustedClients: clients,
      }),
    );
    slot.reconcile([extGhost()]);
    await vi.waitFor(() => expect(bridges[0]?.started).toBe(true));
    expect(bridges[0].calls.some(([name]) => name === 'setTrustedClients')).toBe(false);
    expect(sent).toContainEqual([
      '_root__my-browser',
      { type: 'event', name: 'browser-extension-policy-request' },
    ]);
  });

  // Review 2026-10-29 (Codex P2): disabling the plugin while its bridge was still starting left queued
  // jobs deliverable until startup finished.
  it('启动未完成就停用时立即关闭桥接', async () => {
    let finishStart: () => void = () => undefined;
    const { slot, bridges } = await makeSlot();
    const ghost = extGhost();
    slot.reconcile([ghost]);
    await vi.waitFor(() => expect(bridges).toHaveLength(1));
    bridges[0].start = () => new Promise<void>((resolve) => (finishStart = resolve));
    // The slot awaits the cached read before start; give it time to reach the held start.
    await new Promise((r) => setTimeout(r, 25));
    const stopping = slot.reconcile([]);
    expect(bridges[0].closed).toBe(true);
    finishStart();
    await stopping;
  });

  it('没有配对缓存时向插件索要一次;配对单独落盘', async () => {
    const { slot, bridges, sent, dir } = await makeSlot();
    slot.reconcile([extGhost()]);
    await vi.waitFor(() => expect(bridges[0]?.started).toBe(true));
    expect(sent).toContainEqual([
      '_root__my-browser',
      { type: 'event', name: 'browser-extension-policy-request' },
    ]);
    const clients = [
      {
        id: 'c1',
        origin: 'chrome-extension://' + CHROME_ID,
        extensionId: CHROME_ID,
        publicKey: 'k',
      },
    ];
    expect(
      await slot.handleRequest('_root__my-browser', { kind: 'setTrustedClients', clients }),
    ).toEqual({ ok: true });
    expect(
      JSON.parse(
        await fs.readFile(
          path.join(dir, encodeURIComponent('_root__my-browser') + '.json'),
          'utf8',
        ),
      ),
    ).toEqual({ version: 1, source: '[null,null]', trustedClients: clients });
  });
});

describe('browserExtensionSlot · 转交扩展请求', () => {
  it('在线直接投递;离线先拉起再投递;仍失败则回 PLUGIN_UNAVAILABLE 给扩展', async () => {
    let online = true;
    const wake = vi.fn(async () => {
      online = true;
      return true;
    });
    const { slot, bridges, sent, ghosts, settle, deps } = await makeSlot({
      sendToGhost: vi.fn((ghostId, payload) => {
        if (!online) return false;
        sent.push([ghostId, payload]);
        return true;
      }),
      wake,
    });
    const relays = () =>
      sent.filter(
        ([, payload]) => (payload as { name?: string }).name === 'browser-extension-relay',
      );
    slot.reconcile(ghosts);
    await settle();
    const notice = {
      id: 'req-1',
      clientId: 'client-1',
      request: { op: 'translate', source: { url: '', title: '' }, text: 'hi' },
    };
    bridges[0].emitRelay(notice);
    await settle();
    expect(relays()).toHaveLength(1);
    expect(relays()[0][0]).toBe('_root__my-browser');
    expect(relays()[0][1]).toMatchObject({
      type: 'event',
      name: 'browser-extension-relay',
      id: 'req-1',
      clientId: 'client-1',
      request: notice.request,
    });
    online = false;
    bridges[0].emitRelay({ ...notice, id: 'req-2' });
    await settle();
    expect(wake).toHaveBeenCalledOnce();
    expect(relays()).toHaveLength(2);
    online = false;
    wake.mockResolvedValueOnce(false);
    bridges[0].emitRelay({ ...notice, id: 'req-3' });
    await settle();
    expect(relays()).toHaveLength(2);
    expect(bridges[0].calls.at(-1)).toEqual([
      'relayResult',
      ['req-3', { ok: false, error: 'PLUGIN_UNAVAILABLE' }],
    ]);
    expect(deps.sendToGhost).toHaveBeenCalled();
  });
});
