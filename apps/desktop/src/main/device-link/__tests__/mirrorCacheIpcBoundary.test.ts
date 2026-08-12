/**
 * 镜像冷缓存 IPC 的授权边界。
 *
 * 这五个 handler 能读出缓存的远程聊天正文、也能改写 / 抹掉 owner 作用域的落盘数据,
 * 属于新增特权入口:按 docs/dev-rules/electron-security-and-process-boundaries.md,
 * 执行副作用前必须做 sender 断言 —— capability 只证明「当前登着云账号」,不证明调用者是
 * Cindy 自己的顶层页面(带 preload 的窗口被导航到不可信内容时同样能发 IPC)。
 *
 * 另一条同样要钉住的:**clear 不能被 capability 拦**。登出清理恰好发生在 capability 掉下去
 * 之后,拦住就再也清不掉上一个账号的缓存。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  trusted: true,
  canUseDeviceLink: true,
  cache: {
    readMessages: vi.fn(async () => [] as Record<string, unknown>[]),
    readMessagesWithInvalidation: vi.fn(async () => ({
      messages: [] as Record<string, unknown>[],
      invalidation: 0,
    })),
    writeMessages: vi.fn(async () => ({ invalidation: 0 })),
    readSessionList: vi.fn(async () => [] as unknown[]),
    readSessionListWithInvalidation: vi.fn(async () => ({
      devices: [] as unknown[],
      ownerRoot: '/data/owners/x/device-link-mirror-cache',
      accountCounter: 0,
    })),
    writeSessionList: vi.fn(async () => undefined),
    clearDevice: vi.fn(async () => undefined),
    clearAll: vi.fn(async () => undefined),
  },
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      h.handlers.set(channel, handler);
    }),
  },
}));
vi.mock('../../logger', () => ({
  createLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));
// 读路径要比对 owner 作用域路径(账号边界复核),这里给个稳定值即可。
vi.mock('../../appSessionState', () => ({
  activeOwnerScopeKey: (): string => 'cloud:owner-x:1',
  ownerScopedUserDataPath: (...parts: string[]): string => ['/data/owners/x', ...parts].join('/'),
}));
// 读路径还会查 purge 队列是否有待清记录;边界测试只关心授权,给"干净"。
vi.mock('../mirrorCachePurgeQueue', () => ({
  enqueuePurge: vi.fn(async () => undefined),
  hasPendingPurgeRecords: async (): Promise<boolean> => false,
}));
vi.mock('../../security/trustedAppRenderer', () => ({
  assertTrustedAppRendererEvent: () => {
    if (!h.trusted) throw new Error('[PERMISSION_DENIED] 此操作只能从 Cindy 主页面发起');
  },
}));
// ipc.ts 用 '../appCapabilities.js' 引入;这里按测试文件相对路径挂桩(两种写法都挂,
// 免得 specifier 后缀差异导致漏拦而悄悄跑到真实实现上)。
vi.mock('../../appCapabilities.js', () => ({
  getAppCapabilities: () => ({ canUseDeviceLink: h.canUseDeviceLink }),
}));
vi.mock('../../appCapabilities', () => ({
  getAppCapabilities: () => ({ canUseDeviceLink: h.canUseDeviceLink }),
}));
vi.mock('../mirrorCacheStore', () => ({
  getMirrorCache: () => h.cache,
}));
vi.mock('../../serverApiClient', () => ({
  serverApiFetch: vi.fn(),
  ServerApiError: class ServerApiError extends Error {},
}));
vi.mock('../index', () => ({
  getDeviceLinkStatus: () => 'online',
  getDeviceLinkConnectionIssue: () => null,
  clearDeviceResponsiveness: vi.fn(),
  setRemoteControlEnabled: vi.fn(),
  setKeepAwakeEnabled: vi.fn(),
  openRemoteLink: vi.fn(),
  closeRemoteLink: vi.fn(),
  remoteInvoke: vi.fn(),
  remoteSubscribe: vi.fn(),
  remoteUnsubscribe: vi.fn(),
  disconnectAllControllers: vi.fn(),
  revokeController: vi.fn(),
  restoreController: vi.fn(),
  broadcast: vi.fn(),
  deviceLinkApiBase: 'https://example.invalid',
}));
vi.mock('../dispatch', () => ({ getActiveControllers: () => [] }));
vi.mock('../outboundMedia', () => ({ rewriteOutboundMedia: vi.fn(async (_c, a) => a) }));
vi.mock('../outboundSessionReferences', () => ({
  outboundSessionReferencesRequested: () => false,
  rewriteOutboundSessionReferences: vi.fn(async (_c, a) => a),
}));
vi.mock('../settings-store', () => ({
  isPlaceholderDeviceName: () => false,
  readDeviceLinkSettings: () => ({
    remoteControlEnabled: true,
    keepAwake: false,
    revokedControllers: [],
    disabledControlDeviceIds: [],
    lastKnownDeviceNames: {},
  }),
  readLastKnownDeviceNames: () => ({}),
  rememberLastKnownDeviceName: vi.fn(),
  setDeviceControlEnabled: vi.fn(),
}));
vi.mock('../subscriptionRefcount', () => ({
  recordSubscribe: vi.fn(),
  recordUnsubscribe: vi.fn(() => []),
  recordWindowGone: vi.fn(() => []),
  resetDevice: vi.fn(),
  resetAll: vi.fn(),
}));

import { DEVICE_LINK_INVOKE } from '../../../shared/deviceLinkIpc';
import { registerDeviceLinkIpc } from '../ipc';

const EVENT = {} as Electron.IpcMainInvokeEvent;

/** 五个 channel 与一份能过运行期校验的最小 payload。 */
const MIRROR_CACHE_CALLS: Array<[string, unknown]> = [
  [DEVICE_LINK_INVOKE.MIRROR_CACHE_GET_MESSAGES, { deviceId: 'dev-1', sessionId: 'sess-1' }],
  [
    DEVICE_LINK_INVOKE.MIRROR_CACHE_PUT_MESSAGES,
    { deviceId: 'dev-1', sessionId: 'sess-1', messages: [] },
  ],
  [DEVICE_LINK_INVOKE.MIRROR_CACHE_GET_SESSION_LIST, undefined],
  [DEVICE_LINK_INVOKE.MIRROR_CACHE_PUT_SESSION_LIST, { devices: [] }],
  [DEVICE_LINK_INVOKE.MIRROR_CACHE_CLEAR, { deviceId: 'dev-1' }],
];

/**
 * 注册的 handler 是普通函数:闸门失败时**同步抛出**(Electron 的 ipcMain.handle 会把它转成
 * renderer 侧的 rejection)。测试侧用 async 包一层,让同步抛也表现为 rejected promise。
 */
async function call(channel: string, payload: unknown): Promise<unknown> {
  const handler = h.handlers.get(channel);
  if (!handler) throw new Error(`handler not registered: ${channel}`);
  return handler(EVENT, payload);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.handlers.clear();
  h.trusted = true;
  h.canUseDeviceLink = true;
  registerDeviceLinkIpc();
});

describe('mirror-cache IPC 授权边界', () => {
  it('五个 channel 都已注册', () => {
    for (const [channel] of MIRROR_CACHE_CALLS) {
      expect(h.handlers.has(channel)).toBe(true);
    }
  });

  it('sender 不可信 → 每个 channel 都拒绝,且不碰缓存', async () => {
    h.trusted = false;
    for (const [channel, payload] of MIRROR_CACHE_CALLS) {
      await expect(call(channel, payload)).rejects.toThrow(/PERMISSION_DENIED/);
    }
    expect(h.cache.readMessages).not.toHaveBeenCalled();
    expect(h.cache.readMessagesWithInvalidation).not.toHaveBeenCalled();
    expect(h.cache.writeMessages).not.toHaveBeenCalled();
    expect(h.cache.readSessionList).not.toHaveBeenCalled();
    expect(h.cache.writeSessionList).not.toHaveBeenCalled();
    expect(h.cache.clearDevice).not.toHaveBeenCalled();
    expect(h.cache.clearAll).not.toHaveBeenCalled();
  });

  it('sender 可信 + 有 device-link capability → 正常放行', async () => {
    for (const [channel, payload] of MIRROR_CACHE_CALLS) {
      await expect(call(channel, payload)).resolves.toBeDefined();
    }
    // 读路径现在走 readMessagesWithInvalidation(它会带回 main 侧的会话级作废计数)。
    expect(h.cache.readMessagesWithInvalidation).toHaveBeenCalledTimes(1);
    expect(h.cache.clearDevice).toHaveBeenCalledTimes(1);
  });

  it('无 device-link capability → 读写被拒', async () => {
    h.canUseDeviceLink = false;
    for (const [channel, payload] of MIRROR_CACHE_CALLS.filter(
      ([c]) => c !== DEVICE_LINK_INVOKE.MIRROR_CACHE_CLEAR,
    )) {
      await expect(call(channel, payload)).rejects.toThrow(/PERMISSION_DENIED/);
    }
  });

  it('无 device-link capability 时 clear 仍放行(设备撤销可能发生在 capability 掉下去之后)', async () => {
    h.canUseDeviceLink = false;
    await expect(
      call(DEVICE_LINK_INVOKE.MIRROR_CACHE_CLEAR, { deviceId: 'dev-1' }),
    ).resolves.toEqual({ ok: true });
    expect(h.cache.clearDevice).toHaveBeenCalledWith('dev-1');
    expect(h.cache.clearAll).not.toHaveBeenCalled();
  });

  it('clear 这个 IPC 永远碰不到 clearAll(整体清理只在 main 内部)', async () => {
    await call(DEVICE_LINK_INVOKE.MIRROR_CACHE_CLEAR, { deviceId: 'dev-1' });
    await expect(call(DEVICE_LINK_INVOKE.MIRROR_CACHE_CLEAR, {})).rejects.toThrow(/INVALID_PARAMS/);
    expect(h.cache.clearAll).not.toHaveBeenCalled();
  });
});
