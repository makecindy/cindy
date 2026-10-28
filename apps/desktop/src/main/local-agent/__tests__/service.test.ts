/**
 * 测试价值：Main 主进程授权和撤销必须显示申请方、只作用于选中的服务端授权。
 * 依据：通用应用授权边界；socket 测试不经过 Electron 弹窗或设置 adapter。
 * 最小失败输入：名称含替换元字符、两个授权只撤销其一、取消、非法或过期编号。
 * tier: unit（注入 Electron 与服务，不读取 profile、不使用模型或网络）。
 */
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  deps: undefined as any,
  owner: 'owner-a',
  generation: 1,
  startupError: undefined as Error | undefined,
  confirm: vi.fn(async (..._args: any[]) => true),
  window: undefined as any,
  handlers: new Map<string, (...args: any[]) => any>(),
  revoke: vi.fn(async (_id: string) => true),
  revokeAll: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
  send: vi.fn(),
  trusted: true,
  lockHeld: true,
  packaged: false,
  personal: false,
  region: 'cn',
  nonce: 0,
  startupGate: undefined as Promise<void> | undefined,
}));
vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return mock.packaged;
    },
    getVersion: () => 'test',
    getPath: () => 'unused',
    getPreferredSystemLanguages: () => ['zh-CN'],
  },
  BrowserWindow: {
    getAllWindows: () => [mock.window],
    fromWebContents: (contents: any) => contents === mock.window.webContents ? mock.window : null,
  },
  ipcMain: { handle: (channel: string, handler: (...args: any[]) => any) => mock.handlers.set(channel, handler) },
}));
vi.mock('../../../shared/brandRegion.js', () => ({
  get CURRENT_CINDY_REGION() {
    return mock.region;
  },
}));
vi.mock('../../cindy-make/versionRuntimeIdentity.js', () => ({
  isCindyPersonalRuntime: () => mock.personal,
}));
vi.mock('node:fs/promises', () => ({ default: { mkdir: async () => {} } }));
vi.mock('../../device-link/crossProcessLock.js', () => ({
  withCrossProcessLock: async (
    _path: string,
    _options: unknown,
    task: (status: unknown) => Promise<unknown>,
  ) => task({ held: mock.lockHeld, reason: 'busy' }),
}));
vi.mock('../../appSessionState.js', () => ({
  getActiveAppSession: () => ({ mode: 'local', dataOwnerId: mock.owner }),
  activeOwnerScopeKey: () => `local:${mock.owner}:${mock.generation}`,
  isAppSessionBoundaryPending: () => false,
  ownerScopedUserDataPath: () => 'unused',
}));
vi.mock('../../windowFocusClassifier.js', () => ({
  isAppContentWindow: (window: any) => window === mock.window && mock.trusted,
}));
vi.mock('../../maker-host/createDesktopProviderService.js', () => ({
  getDesktopProviderService: vi.fn(),
}));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ warn: vi.fn() }) }));
vi.mock('../runtime.js', () => ({ openLocalAgentRuntime: vi.fn() }));
vi.mock('../server.js', () => ({
  LocalAgentError: class extends Error {
    constructor(
      public code: string,
      message: string,
    ) {
      super(message);
    }
  },
  createLocalAgentServer: async (deps: any) => {
    mock.deps = deps;
    await mock.startupGate;
    if (mock.startupError) throw mock.startupError;
    return {
      rpc: { protocol: 1, port: 12345, instance: 'n'.repeat(42) + (++mock.nonce % 10) },
      connections: () => [
        { id: 'grant-a', name: 'Notes', clientId: 'notes' },
        { id: 'grant-b', name: 'Board', clientId: 'board' },
      ],
      revoke: mock.revoke,
      revokeAll: mock.revokeAll,
      close: mock.close,
    };
  },
}));
import { registerLocalAgentConfirmationIpc, cancelLocalAgentConfirmations } from '../confirmation.js';

function answer(requestId: string, value: unknown, event?: any) {
  const contents = mock.window.webContents;
  return mock.handlers.get('local-agent:confirmation:answer')!(event ?? { sender: contents, senderFrame: contents.mainFrame }, requestId, value);
}

import {
  disposeLocalAgentHost,
  installLocalAgentHost,
  localAgentConnections,
  localAgentDeveloperConnection,
  revokeLocalAgentConnections,
} from '../service.js';

beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubGlobal('MAIN_WINDOW_VITE_DEV_SERVER_URL', 'http://localhost:5173');
  vi.stubGlobal('MAIN_WINDOW_VITE_NAME', 'main_window');
  const contents = Object.assign(new EventEmitter(), { id: 1, send: mock.send, isDestroyed: () => false,
    mainFrame: { url: 'http://localhost:5173', parent: null } });
  mock.window = Object.assign(new EventEmitter(), { webContents: contents, isVisible: () => true, isDestroyed: () => false });
  registerLocalAgentConfirmationIpc(() => mock.window);
  mock.send.mockImplementation((channel: string, payload: any) => {
    if (channel === 'local-agent:confirmation') void mock.confirm(payload).then(value => answer(payload.requestId, value));
  });
  mock.owner = 'owner-a';
  mock.generation = 1;
  mock.trusted = true;
  mock.lockHeld = true;
  mock.packaged = false;
  mock.personal = false;
  mock.region = 'cn';
  mock.nonce = 0;
  mock.startupGate = undefined;
  mock.startupError = undefined;
  mock.confirm.mockResolvedValue(true);
  installLocalAgentHost({} as any);
  await localAgentConnections();
  mock.send.mockClear();
});
afterEach(async () => {
  await disposeLocalAgentHost();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('generic local app Cindy authorization', () => {
  // Regression: the old OS dialog owned cancellation. The shared Renderer round trip
  // must now retire the exact request, including queued prompts and late replies.
  it.each(['abort', 'close', 'destroyed', 'render-process-gone', 'navigation', 'in-page', 'timeout', 'owner'] as const)(
    'retires a pending confirmation on %s and rejects its late approval', async reason => {
      vi.useFakeTimers();
      mock.confirm.mockImplementationOnce(() => new Promise<boolean>(() => {}));
      const controller = new AbortController();
      const pending = mock.deps.approve(controller.signal, { id: 'notes', name: 'Notes' });
      const id = mock.confirm.mock.calls[0][0].requestId;
      const contents = mock.window.webContents;
      if (reason === 'abort') controller.abort();
      else if (reason === 'close') mock.window.emit('close');
      else if (reason === 'navigation' || reason === 'in-page')
        contents.emit('did-start-navigation', {}, 'http://localhost:5173/#/elsewhere', reason === 'in-page', true);
      else if (reason === 'timeout') await vi.runOnlyPendingTimersAsync();
      else if (reason === 'owner') { mock.generation++; cancelLocalAgentConfirmations(); }
      else contents.emit(reason);
      expect(await pending).toBe(false);
      expect(answer(id, true)).toBe(false);
      expect(mock.send).toHaveBeenCalledWith('local-agent:confirmation:dismissed', id);
    },
  );

  it('rejects subframe, foreign window and malformed replies without approving the pending request', async () => {
    mock.confirm.mockImplementationOnce(() => new Promise<boolean>(() => {}));
    const pending = mock.deps.approve(new AbortController().signal, { id: 'notes', name: 'Notes' });
    const id = mock.confirm.mock.calls[0][0].requestId;
    const contents = mock.window.webContents;
    expect(() => answer(id, true, { sender: contents, senderFrame: { ...contents.mainFrame, parent: contents.mainFrame } })).toThrow('PERMISSION_DENIED');
    const foreign = { ...contents, id: 999, mainFrame: contents.mainFrame };
    expect(() => answer(id, true, { sender: foreign, senderFrame: foreign.mainFrame })).toThrow('PERMISSION_DENIED');
    expect(answer(id, 'true')).toBe(false);
    expect(answer('unknown-request', true)).toBe(false);
    expect(answer(id, false)).toBe(true);
    expect(await pending).toBe(false);
  });

  it('keeps concurrent allow and revoke decisions separate and cancels all on host disposal', async () => {
    mock.confirm.mockImplementation(() => new Promise<boolean>(() => {}));
    const allow = mock.deps.approve(new AbortController().signal, { id: 'notes', name: 'Notes' });
    const revoke = revokeLocalAgentConnections('grant-b');
    await Promise.resolve();
    const [a, b] = mock.confirm.mock.calls.map(call => call[0].requestId);
    expect(a).not.toBe(b);
    expect(answer(b, true)).toBe(true);
    expect(await revoke).toBe(true);
    expect(mock.revoke).toHaveBeenCalledExactlyOnceWith('grant-b');
    await disposeLocalAgentHost();
    expect(await allow).toBe(false);
    expect(answer(a, true)).toBe(false);
  });

  it('shows the unverified client identity literally without expanding replacement metacharacters', async () => {
    expect(
      await mock.deps.approve(new AbortController().signal, {
        id: 'org.example.notes',
        name: 'Notes $&',
        version: '1.2',
      }),
    ).toBe(true);
    const options = mock.confirm.mock.calls[0][0];
    expect(options.message).toContain('Notes $&');
    expect(options.message).not.toContain('{{app}}');
    expect(options.detail).toContain('org.example.notes');
    expect(options.detail).toContain('工作目录不限制访问范围');
    expect(options.detail).toContain('1.2');
    expect(options.detail).not.toMatch(/\{\{(?:id|version)\}\}/);
  });
  it('revokes only the selected connection through the Cindy confirmation', async () => {
    expect(await revokeLocalAgentConnections('grant-b')).toBe(true);
    expect(mock.revoke).toHaveBeenCalledWith('grant-b');
    expect(mock.revokeAll).not.toHaveBeenCalled();
    expect(mock.confirm.mock.calls[0][0].message).toContain('Board');
  });
  it('keeps connections on cancellation and does not turn invalid IDs into revoke-all', async () => {
    mock.confirm.mockResolvedValue(false);
    expect(await revokeLocalAgentConnections('grant-a')).toBe(false);
    expect(await revokeLocalAgentConnections('gone')).toBe(false);
    await expect(revokeLocalAgentConnections({})).rejects.toThrow('INVALID_PARAMS');
    expect(mock.revoke).not.toHaveBeenCalled();
    expect(mock.revokeAll).not.toHaveBeenCalled();
  });
  it('rejects Cindy consent if the account changed while the prompt was open', async () => {
    mock.confirm.mockImplementationOnce(async () => {
      mock.owner = 'owner-b';
      return true;
    });
    expect(
      await mock.deps.approve(new AbortController().signal, { id: 'notes', name: 'Notes' }),
    ).toBe(false);
  });
  it('notifies local settings without sending app identities and suppresses notifications after account changes', () => {
    mock.deps.changed();
    expect(mock.send).toHaveBeenCalledWith('local-agent:connections-changed');
    mock.owner = 'owner-b';
    mock.deps.changed();
    expect(mock.send).toHaveBeenCalledTimes(1);
  });
  // appSessionState.activeOwnerScopeKey includes generation: A→B→A cannot revive an old approval.
  it('rejects stale consent after the same owner is recommitted', async () => {
    mock.confirm.mockImplementationOnce(async () => {
      mock.generation++;
      return true;
    });
    expect(
      await mock.deps.approve(new AbortController().signal, { id: 'notes', name: 'Notes' }),
    ).toBe(false);
  });
  it('rechecks the IPC caller after Cindy confirmation and keeps raw storage errors out of IPC', async () => {
    const assertCaller = vi.fn();
    mock.confirm.mockImplementationOnce(async () => {
      assertCaller.mockImplementation(() => {
        throw new Error('caller navigated');
      });
      return true;
    });
    await expect(revokeLocalAgentConnections('grant-a', assertCaller)).rejects.toThrow(
      '[INTERNAL]',
    );
    expect(mock.revoke).not.toHaveBeenCalled();
    mock.revoke.mockRejectedValueOnce(new Error('PRIVATE storage path or credential'));
    await expect(revokeLocalAgentConnections('grant-a')).rejects.toThrow('[INTERNAL]');
  });
  it('uses trusted app windows for Cindy consent and local notifications', async () => {
    mock.trusted = false;
    expect(
      await mock.deps.approve(new AbortController().signal, { id: 'notes', name: 'Notes' }),
    ).toBe(false);
    mock.deps.changed();
    expect(mock.confirm).not.toHaveBeenCalled();
    expect(mock.send).not.toHaveBeenCalled();
  });
  it('does not load another grant snapshot when a shared-profile instance already owns discovery', async () => {
    await disposeLocalAgentHost();
    mock.lockHeld = false;
    mock.deps = undefined;
    installLocalAgentHost({} as any);
    await expect(localAgentConnections()).rejects.toThrow('[PRECONDITION_FAILED]');
    expect(mock.deps).toBeUndefined();
    expect(await localAgentDeveloperConnection()).toEqual({ state: 'host-in-use' });
  });
  it('waits for the previous endpoint to close before replacing Maker on the same profile', async () => {
    const previous = mock.deps;
    const oldCode = await localAgentDeveloperConnection();
    let finish!: () => void;
    mock.close.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const stopping = disposeLocalAgentHost();
    expect(await localAgentDeveloperConnection()).toEqual({ state: 'stopped' });
    installLocalAgentHost({} as any);
    expect(await localAgentDeveloperConnection()).toEqual({ state: 'starting' });
    const connections = localAgentConnections();
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    expect(mock.deps).toBe(previous);
    finish();
    await stopping;
    await connections;
    expect(mock.deps).not.toBe(previous);
    expect(await localAgentDeveloperConnection()).not.toEqual(oldCode);
  });
  // Build identity, never the shared-profile path/version, controls the developer entry.
  it.each([
    [true, false, 'cn', 'installed'],
    [true, false, 'global', 'installed'],
    [false, false, 'cn', 'development'],
    [true, true, 'global', 'development'],
    [true, false, 'dev', 'development'],
  ])('projects build identity %s/%s/%s as %s', async (packaged, personal, region, kind) => {
    await disposeLocalAgentHost();
    Object.assign(mock, { packaged, personal, region });
    installLocalAgentHost({} as any);
    await localAgentConnections();
    expect(mock.deps.instanceInfo).toEqual({ kind, region });
    const value = await localAgentDeveloperConnection();
    if (kind === 'installed') expect(value).toBeNull();
    else
      expect(value).toEqual({
        state: 'ready',
        code: 'cindy-local:v1:12345:' + 'n'.repeat(42) + '2',
      });
  });
  it('never returns an old owner endpoint or raw startup error from the code query', async () => {
    mock.generation++;
    expect(await localAgentDeveloperConnection()).toEqual({ state: 'owner-unavailable' });
    await disposeLocalAgentHost();
    mock.owner = '';
    expect(await localAgentDeveloperConnection()).toEqual({ state: 'owner-unavailable' });
    mock.owner = 'owner-a';
    mock.startupError = new Error('PRIVATE PATH');
    installLocalAgentHost({} as any);
    await expect(localAgentConnections()).rejects.toThrow('[INTERNAL]');
    expect(await localAgentDeveloperConnection()).toEqual({ state: 'failed' });
    await expect(
      localAgentDeveloperConnection(() => {
        throw new Error('untrusted');
      }),
    ).rejects.toThrow('[INTERNAL]');
  });
  it('closes a late startup instead of publishing its code after the host was retired', async () => {
    await disposeLocalAgentHost();
    let release!: () => void;
    mock.startupGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mock.deps = undefined;
    installLocalAgentHost({} as any);
    const query = localAgentConnections().catch(() => undefined);
    await vi.waitFor(() => expect(mock.deps).toBeDefined());
    const stopping = disposeLocalAgentHost();
    release();
    await stopping;
    await query;
    expect(await localAgentDeveloperConnection()).toEqual({ state: 'stopped' });
    expect(mock.close).toHaveBeenCalled();
  });
});
