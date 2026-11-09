import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAuthService, type AuthState } from '../authService';

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn() }),
}));

// 真实服务入口的 unit 回归：旧服务重复初始化且不回放快照；推送后的旧返回会倒退身份。
// 相邻 AuthContext 测试替换了服务，无法覆盖此顺序。最小输入是未完成初始化 + 一次新推送。
const signedOut: AuthState = {
  user: null,
  mode: 'signed-out',
  dataOwnerId: null,
  ownerGeneration: 0,
  ownerBoundaryPending: false,
  canEnterApp: false,
  isAuthenticated: false,
  isCanary: false,
  deviceId: 'device',
  hasAccountDeletionReceipt: false,
  accountDeletionRestored: false,
  credentialStoreUnavailable: false,
};
const local: AuthState = {
  ...signedOut,
  mode: 'local',
  dataOwnerId: 'local',
  ownerGeneration: 1,
  canEnterApp: true,
};

let push: (state: AuthState) => void;
let resolve: (state: AuthState) => void;
let reject: (error: Error) => void;
let initialize: ReturnType<typeof vi.fn>;
let unsubscribe: ReturnType<typeof vi.fn>;

beforeEach(() => {
  initialize = vi.fn(() => new Promise<AuthState>((done, fail) => {
    resolve = done;
    reject = fail;
  }));
  unsubscribe = vi.fn();
  vi.stubGlobal('window', {
    electronAPI: {
      authInitialize: initialize,
      onAuthStateChange: vi.fn((listener) => {
        push = listener;
        return unsubscribe;
      }),
    },
  });
});

afterEach(() => {
  createAuthService().dispose();
  vi.unstubAllGlobals();
});

describe('renderer auth service', () => {
  it('shares one initialization and replays the accepted snapshot to late observers', async () => {
    const service = createAuthService();
    const first = service.initialize();
    const second = createAuthService().initialize();
    expect(initialize).toHaveBeenCalledTimes(1);
    resolve(local);
    await expect(first).resolves.toEqual(local);
    await expect(second).resolves.toEqual(local);
    const listener = vi.fn();
    service.onAuthStateChange(listener);
    expect(listener).toHaveBeenCalledWith(local, 'snapshot');
    expect(service.getSnapshot()).toEqual(local);
    await expect(service.initialize()).resolves.toEqual(local);
    expect(initialize).toHaveBeenCalledTimes(1);
  });

  it.each(['resolve', 'reject'] as const)('keeps a newer push when an older initialize %ss', async (completion) => {
    const service = createAuthService();
    const pending = service.initialize();
    const listener = vi.fn();
    service.onAuthStateChange(listener);
    push(local);
    if (completion === 'resolve') resolve(signedOut);
    else reject(new Error('old request failed'));
    await expect(pending).resolves.toEqual(local);
    expect(service.getSnapshot()).toEqual(local);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('preserves a pending boundary until a subsequent stable push', async () => {
    const service = createAuthService();
    const pending = service.initialize();
    resolve({ ...signedOut, ownerBoundaryPending: true });
    expect((await pending).ownerBoundaryPending).toBe(true);
    const listener = vi.fn();
    service.onAuthStateChange(listener);
    expect(listener.mock.lastCall?.[0].ownerBoundaryPending).toBe(true);
    push(local);
    expect(service.getSnapshot()).toEqual(local);
  });

  it('only removes the departing observer; renderer disposal releases IPC and the cache', () => {
    const service = createAuthService();
    const first = vi.fn();
    const second = vi.fn();
    const stop = service.onAuthStateChange(first);
    service.onAuthStateChange(second);
    stop();
    push(local);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith(local, 'push');
    expect(unsubscribe).not.toHaveBeenCalled();
    service.dispose();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(createAuthService().getSnapshot()).toBeNull();
  });

  it('propagates a real initialization failure without inventing an auth snapshot', async () => {
    const service = createAuthService();
    const pending = service.initialize();
    reject(new Error('unavailable'));
    await expect(pending).rejects.toThrow('unavailable');
    expect(service.getSnapshot()).toBeNull();
  });
});
