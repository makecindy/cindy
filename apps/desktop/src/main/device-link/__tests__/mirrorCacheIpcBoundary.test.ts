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
import { EventEmitter } from 'node:events';

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  trusted: true,
  ownerGeneration: 1,
  invalidations: new Set<() => void>(),
  senderDestroyed: false,
  selectFile: vi.fn(),
  canUseDeviceLink: true,
  diagnosticsInfo: vi.fn(),
  quitHandlers: new Map<string, { fn: () => void; phase: string }>(),
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
  BrowserWindow: { fromWebContents: () => ({ isDestroyed: () => false }) },
  dialog: { showOpenDialog: h.selectFile },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      h.handlers.set(channel, handler);
    }),
  },
}));
vi.mock('../../logger', () => ({
  createLogger: (scope: string) => ({ warn: vi.fn(), error: vi.fn(), info: scope === 'device-link:ipc-diagnostics' ? h.diagnosticsInfo : vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../lifecycle', () => ({
  onQuit: (name: string, fn: () => void, phase: string) => {
    h.quitHandlers.set(name, { fn, phase });
  },
}));
// 读路径要比对 owner 作用域路径(账号边界复核),这里给个稳定值即可。
vi.mock('../../appSessionState', () => ({
  onAppSessionInvalidated: (cancel: () => void) => { h.invalidations.add(cancel); return () => h.invalidations.delete(cancel); },
  getActiveAppSession: () => ({ dataOwnerId: 'owner-x', generation: h.ownerGeneration, mode: 'cloud' }),
  isAppSessionBoundaryPending: () => false,
  activeOwnerScopeKey: (): string => 'cloud:owner-x:1',
  ownerScopedUserDataPath: (...parts: string[]): string => ['/data/owners/x', ...parts].join('/'),
}));
vi.mock('../../i18n', () => ({ t: (key: string) => key }));
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
// Authorization bridge dependencies are outside the mirror-cache IPC boundary.
// Keep registration in memory without loading the real credential/runtime stack.
vi.mock('../../authManager.js', () => ({
  getAccessToken: vi.fn(),
  getCurrentUserId: vi.fn(),
  getDeviceId: vi.fn(),
  getActiveAuthRealm: vi.fn(),
}));
vi.mock('../../clientEndpointsService.js', () => ({
  getClientEndpoint: vi.fn(),
}));
vi.mock('../index', () => ({
  getDeviceLinkStatus: () => 'online',
  getDeviceLinkConnectionIssue: () => null,
  isDeviceLinkStandby: () => false,
  getUnresponsiveDeviceIds: () => [],
  clearDeviceResponsiveness: vi.fn(),
  setRemoteControlEnabled: vi.fn(),
  setKeepAwakeEnabled: vi.fn(),
  openRemoteLink: vi.fn(),
  closeRemoteLink: vi.fn(),
  closeLegacyBackgroundLinkIfIdle: vi.fn(),
  retainForegroundLink: vi.fn(() => () => {}),
  remoteInvoke: vi.fn(),
  providerShareHostInvoke: vi.fn(),
  remoteSubscribe: vi.fn(),
  remoteUnsubscribe: vi.fn(),
  disconnectAllControllers: vi.fn(),
  revokeController: vi.fn(),
  restoreController: vi.fn(),
  broadcast: vi.fn(),
  deviceLinkApiBase: 'https://example.invalid',
  applyControllerDisplayNameListSnapshot: vi.fn(),
  applyControllerPresenceListSnapshot: vi.fn(),
  beginControllerDisplayNameDirectoryRefresh: vi.fn(() => 1),
  captureControllerDisplayNameRequestEpoch: () => 0,
  captureControllerPresenceRequestEpoch: () => 0,
  isLatestControllerDisplayNameDirectoryRefresh: vi.fn(() => true),
  waitForNewerControllerDisplayNameDirectoryRefresh: vi.fn(async () => {}),
  readControllerDisplayNameFreshnessSince: () => ({
    changedAfterRequest: false,
    authoritativeName: null,
  }),
}));
vi.mock('../dispatch', () => ({ getActiveControllers: () => [] }));
vi.mock('../filePeer', () => ({ tryUploadPeerAttachment: vi.fn(async () => null) }));
vi.mock('../outboundMedia', () => ({
  rewriteOutboundMedia: vi.fn(async (_c, a) => a),
  withPeerAttachmentUpload: (_upload: unknown, operation: () => unknown) => operation(),
}));
vi.mock('../outboundSessionReferences', () => ({
  outboundSessionReferencesRequested: () => false,
  rewriteOutboundSessionReferences: vi.fn(async (_c, a) => a),
}));
vi.mock('../settings-store', () => ({
  forgetLastKnownDeviceName: vi.fn(),
  isPlaceholderDeviceName: () => false,
  normalizeCachedDeviceName: (name: string) => name.trim() || null,
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
import { readWithSourceFileAccessRecovery, sourceFileAccessTransferOptions, onSourceFileAccessDiscard } from '../sourceFileAccessRecovery';
import { rewriteOutboundMedia } from '../outboundMedia';
import { DeviceLinkError, REMOTE_INVOKE_ALLOWLIST } from '@cindy/device-link';
import { DESKTOP_LOCAL } from '../../../shared/remoteDesktop';
import {
  setRemoteControlEnabled,
  revokeController,
  restoreController,
  disconnectAllControllers,
  remoteInvoke,
} from '../index';
import { setDeviceControlEnabled } from '../settings-store';

const senderEvents = new EventEmitter();
const FRAME = { detached: false };
const EVENT = {
  sender: Object.assign(senderEvents, { id: 42, isDestroyed: () => h.senderDestroyed, mainFrame: FRAME }),
  senderFrame: FRAME,
} as unknown as Electron.IpcMainInvokeEvent;

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
  vi.mocked(remoteInvoke).mockReset();
  vi.mocked(rewriteOutboundMedia).mockReset().mockImplementation(async (_channel, args) => args);
  h.selectFile.mockReset();
  senderEvents.removeAllListeners();
  h.invalidations.clear();
  h.handlers.clear();
  h.quitHandlers.clear();
  h.trusted = true;
  h.ownerGeneration = 1;
  h.senderDestroyed = false;
  h.canUseDeviceLink = true;
  registerDeviceLinkIpc();
});

// #6530 native recovery is installed only by the trusted foreground send adapter.
// The real rewrite/read boundary is covered in outboundMedia.test.ts; here the
// observable contract is exactly one final message, or none on cancellation/staleness.
describe('attachment access confirmation IPC', () => {
  const source = '/private/wechat/test.pdf';
  const payload = { deviceId: 'receiver', channel: 'maker:send', args: ['session', { content: [] }] };
  const denied = () => Object.assign(new Error('source denied'), { code: 'EPERM', syscall: 'open', path: source });
  function installReadFailure() {
    const read = vi.fn().mockRejectedValueOnce(denied()).mockResolvedValue('uploaded-ref');
    vi.mocked(rewriteOutboundMedia).mockImplementationOnce(async (_channel, args) => {
      const ref = await readWithSourceFileAccessRecovery(source, read);
      return [args[0], { content: [{ type: 'file', path: ref }] }];
    });
    return read;
  }

  it('continues the original send exactly once after selecting its source', async () => {
    const read = installReadFailure();
    h.selectFile.mockResolvedValueOnce({ canceled: false, filePaths: [source] });
    vi.mocked(remoteInvoke).mockResolvedValueOnce({ ok: true, result: 'accepted' });
    await expect(call(DEVICE_LINK_INVOKE.INVOKE, payload)).resolves.toBe('accepted');
    expect(read).toHaveBeenCalledTimes(2);
    expect(h.selectFile).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ defaultPath: source, properties: ['openFile'] }));
    expect(remoteInvoke).toHaveBeenCalledOnce();
    expect(vi.mocked(remoteInvoke).mock.calls[0][2]).toEqual(['session', { content: [{ type: 'file', path: 'uploaded-ref' }] }]);
  });

  it('keeps uploaded bytes when a dispatched message has an uncertain result', async () => {
    const discard = vi.fn();
    vi.mocked(rewriteOutboundMedia).mockImplementationOnce(async (_channel, args) => {
      onSourceFileAccessDiscard(discard);
      return args;
    });
    vi.mocked(remoteInvoke).mockRejectedValueOnce(new DeviceLinkError('INVOKE_TIMEOUT', 'uncertain'));
    await expect(call(DEVICE_LINK_INVOKE.INVOKE, payload)).rejects.toThrow();
    expect(remoteInvoke).toHaveBeenCalledOnce();
    expect(discard).not.toHaveBeenCalled();
  });

  it.each([false, true])('queue content edits recover only in the foreground (background=%s)', async background => {
    const read = installReadFailure();
    h.selectFile.mockResolvedValueOnce({ canceled: false, filePaths: [source] });
    vi.mocked(remoteInvoke).mockResolvedValueOnce({ ok: true, result: { sessionId: 'session', pendingQueue: [{ clientId: 'queued', files: [] }] } });
    vi.mocked(remoteInvoke).mockResolvedValueOnce({ ok: true, result: 'updated' });
    const edited = { ...payload, channel: 'maker:input:update-content', args: ['session', 'queued', { files: [{ path: source }] }], scheduling: { background } };
    if (background) {
      await expect(call(DEVICE_LINK_INVOKE.INVOKE, edited)).rejects.toThrow();
      expect(h.selectFile).not.toHaveBeenCalled();
      expect(read).toHaveBeenCalledOnce();
      expect(remoteInvoke).toHaveBeenCalledOnce();
    } else {
      await expect(call(DEVICE_LINK_INVOKE.INVOKE, edited)).resolves.toBe('updated');
      expect(h.selectFile).toHaveBeenCalledOnce();
      expect(read).toHaveBeenCalledTimes(2);
      expect(remoteInvoke).toHaveBeenCalledTimes(2);
      expect(vi.mocked(remoteInvoke).mock.calls[1][1]).toBe('maker:input:update-content');
    }
  });

  it.each(['owner', 'window', 'navigation'])('cancels the confirmed upload immediately on %s invalidation', async invalidation => {
    let attempts = 0;
    const read = vi.fn(async () => {
      if (++attempts === 1) throw denied();
      const { signal } = sourceFileAccessTransferOptions();
      expect(signal).toBeDefined();
      const cancelled = new Promise<never>((_resolve, reject) => signal!.addEventListener('abort', () => reject(new Error('UPLOAD_CANCELLED')), { once: true }));
      if (invalidation === 'owner') {
        h.ownerGeneration++;
        for (const cancel of h.invalidations) cancel();
      } else if (invalidation === 'window') senderEvents.emit('destroyed');
      else senderEvents.emit('did-start-navigation', {}, 'https://other.test', false, true);
      expect(signal!.aborted).toBe(true);
      return cancelled;
    });
    vi.mocked(rewriteOutboundMedia).mockImplementationOnce(async () => { await readWithSourceFileAccessRecovery(source, read); return []; });
    h.selectFile.mockResolvedValueOnce({ canceled: false, filePaths: [source] });
    await expect(call(DEVICE_LINK_INVOKE.INVOKE, payload)).rejects.toThrow('PERMISSION_DENIED');
    expect(read).toHaveBeenCalledTimes(2);
    expect(remoteInvoke).not.toHaveBeenCalled();
    expect(h.invalidations.size).toBe(0);
    expect(senderEvents.listenerCount('destroyed')).toBe(0);
    expect(senderEvents.listenerCount('did-start-navigation')).toBe(0);
  });

  it.each(['cancel', 'wrong-file', 'owner-change', 'window-closed', 'page-changed'])('does not dispatch after %s', async outcome => {
    const read = installReadFailure();
    h.selectFile.mockImplementationOnce(async () => {
      if (outcome === 'owner-change') h.ownerGeneration++;
      if (outcome === 'window-closed') h.senderDestroyed = true;
      if (outcome === 'page-changed') h.trusted = false;
      return { canceled: outcome === 'cancel', filePaths: [outcome === 'wrong-file' ? '/private/other.pdf' : source] };
    });
    await expect(call(DEVICE_LINK_INVOKE.INVOKE, payload)).rejects.toThrow();
    expect(read).toHaveBeenCalledOnce();
    expect(remoteInvoke).not.toHaveBeenCalled();
  });

  it('rejects an untrusted sender before opening a picker or forwarding', async () => {
    h.trusted = false;
    await expect(call(DEVICE_LINK_INVOKE.INVOKE, payload)).rejects.toThrow('PERMISSION_DENIED');
    expect(h.selectFile).not.toHaveBeenCalled();
    expect(remoteInvoke).not.toHaveBeenCalled();
  });

  it('keeps background sends noninteractive', async () => {
    const read = installReadFailure();
    await expect(call(DEVICE_LINK_INVOKE.INVOKE, { ...payload, scheduling: { background: true } })).rejects.toThrow();
    expect(read).toHaveBeenCalledOnce();
    expect(h.selectFile).not.toHaveBeenCalled();
    expect(remoteInvoke).not.toHaveBeenCalled();
  });
});

it('rejects Renderer-supplied remote Skill approval before forwarding any request', async () => {
  await expect(call(DEVICE_LINK_INVOKE.INVOKE, {
    deviceId: 'private-peer', channel: 'maker:remote-resources:invoke',
    args: [{ collectionId: 'skills', actionId: 'management:answer', input: { accepted: true } }],
  })).rejects.toThrow('PERMISSION_DENIED');
  expect(remoteInvoke).not.toHaveBeenCalled();
});

it.each([1_000, 30_000])('flushes completed calls on quit after %i ms without duplicate summaries', async (elapsed) => {
  vi.useFakeTimers();
  try {
    const payload = { deviceId: 'private-peer', channel: 'local-db:sessions:list', args: [] };
    vi.mocked(remoteInvoke).mockResolvedValueOnce({ ok: true, result: [] });
    await call(DEVICE_LINK_INVOKE.INVOKE, payload);
    vi.mocked(remoteInvoke).mockRejectedValueOnce(new DeviceLinkError('NOT_CONNECTED', 'offline'));
    await expect(call(DEVICE_LINK_INVOKE.INVOKE, payload)).rejects.toThrow('DEVICE_LINK_NOT_CONNECTED');
    await vi.advanceTimersByTimeAsync(elapsed);
    const quit = h.quitHandlers.get('device-link-ipc-diagnostics');
    expect(quit?.phase).toBe('sync');
    quit!.fn();
    const summaries = h.diagnosticsInfo.mock.calls.filter(([event]) => event.startsWith('transport summary'));
    // Failing buckets stay per bucket; successes fold into one baseline line.
    expect(summaries.map(([event, fields]) => [event, fields.code, fields.completed])).toEqual([
      ['transport summary', 'NOT_CONNECTED', 1], ['transport summary ok', undefined, 1],
    ]);
    const count = h.diagnosticsInfo.mock.calls.length;
    quit!.fn();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.diagnosticsInfo).toHaveBeenCalledTimes(count);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it('records the originating window and raw error before the IPC adapter maps it', async () => {
  vi.useFakeTimers();
  try {
    vi.mocked(remoteInvoke).mockRejectedValueOnce(new DeviceLinkError('BACKPRESSURE', 'private failure'));
    await expect(call(DEVICE_LINK_INVOKE.INVOKE, {
      deviceId: 'private-peer', channel: 'local-db:sessions:list', args: ['private argument'],
    })).rejects.toThrow('DEVICE_LINK_BUSY');
    expect(h.diagnosticsInfo).toHaveBeenCalledWith('transport first failure', expect.objectContaining({
      windowId: 42, operation: 'invoke', channel: 'local-db:sessions:list', code: 'BACKPRESSURE', completed: 1,
    }));
    expect(JSON.stringify(h.diagnosticsInfo.mock.calls)).not.toContain('private');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.diagnosticsInfo).toHaveBeenCalledWith('transport summary', expect.objectContaining({ code: 'BACKPRESSURE', completed: 1 }));
  } finally {
    vi.useRealTimers();
  }
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

describe('local control authorization IPC boundary', () => {
  const calls = [
    [DEVICE_LINK_INVOKE.SET_ENABLED, true, setRemoteControlEnabled],
    [DEVICE_LINK_INVOKE.SET_ENABLED, false, setRemoteControlEnabled],
    [
      DEVICE_LINK_INVOKE.SET_DEVICE_CONTROL_ENABLED,
      { deviceId: 'peer', enabled: true },
      setDeviceControlEnabled,
    ],
    [
      DEVICE_LINK_INVOKE.SET_DEVICE_CONTROL_ENABLED,
      { deviceId: 'peer', enabled: false },
      setDeviceControlEnabled,
    ],
    [DEVICE_LINK_INVOKE.RESTORE, { deviceId: 'peer' }, restoreController],
    [DEVICE_LINK_INVOKE.REVOKE, { deviceId: 'peer' }, revokeController],
    [DEVICE_LINK_INVOKE.DISCONNECT_ALL, undefined, disconnectAllControllers],
  ] as const;

  it.each(calls)(
    'rejects foreign senders before %s can change authority',
    async (channel, payload, effect) => {
      h.trusted = false;
      await expect(call(channel, payload)).rejects.toThrow(/PERMISSION_DENIED/);
      expect(effect).not.toHaveBeenCalled();
    },
  );

  it.each(calls)(
    'keeps %s available to the local app without another confirmation',
    async (channel, payload, effect) => {
      await call(channel, payload);
      expect(effect).toHaveBeenCalledTimes(1);
    },
  );

  it.each(calls)('still requires account capability for %s', async (channel, payload, effect) => {
    h.canUseDeviceLink = false;
    await expect(call(channel, payload)).rejects.toThrow(/PERMISSION_DENIED/);
    expect(effect).not.toHaveBeenCalled();
  });

  it('never exposes local grants, revocation or capture IPC to remote invokes', () => {
    for (const channel of [...calls.map(([channel]) => channel), ...Object.values(DESKTOP_LOCAL)]) {
      expect(REMOTE_INVOKE_ALLOWLIST.has(channel), channel).toBe(false);
    }
  });
});
