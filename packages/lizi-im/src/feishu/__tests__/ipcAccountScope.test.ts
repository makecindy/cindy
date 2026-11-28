import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { IMHost } from '../../types.js';

const mocks = vi.hoisted(() => ({
  stop: vi.fn(async () => undefined),
  start: vi.fn(async () => 'connected' as const),
  getCurrentStatus: vi.fn<
    () => 'idle' | 'testing' | 'connected' | 'reconnecting' | 'conflict' | 'error'
  >(() => 'idle'),
  getCurrentError: vi.fn<() => string | undefined>(() => undefined),
  readCredentials: vi.fn(
    () =>
      null as {
        appId: string;
        appSecret: string;
        service: 'feishu' | 'lark';
      } | null,
  ),
  writeCredentials: vi.fn(() => true),
  writeLifecycleAnnouncement: vi.fn(),
  setLifecycleAnnouncement: vi.fn(),
  writeOwnerOpenId: vi.fn(() => true),
  clearAll: vi.fn(),
  clearOwner: vi.fn(),
  loadOwner: vi.fn(),
  requestRegistration: vi.fn(),
  pollRegistration: vi.fn(),
}));

vi.mock('../wsClient.js', () => ({
  QUIT_OFFLINE_ANNOUNCE_TIMEOUT_MS: 4500,
  getCurrentStatus: mocks.getCurrentStatus,
  getCurrentError: mocks.getCurrentError,
  setLifecycleAnnouncement: mocks.setLifecycleAnnouncement,
  clearOrphanRetriesForCredentialClear: vi.fn(),
  stop: mocks.stop,
  start: mocks.start,
}));

vi.mock('../storage.js', () => ({
  readCredentials: mocks.readCredentials,
  readOwnerOpenId: vi.fn(() => null),
  readLifecycleAnnouncement: vi.fn(() => true),
  writeLifecycleAnnouncement: mocks.writeLifecycleAnnouncement,
  writeCredentials: mocks.writeCredentials,
  writeOwnerOpenId: mocks.writeOwnerOpenId,
  clearAll: mocks.clearAll,
}));

vi.mock('../ownerGuard.js', () => ({
  loadFromDisk: mocks.loadOwner,
  firstAllowed: vi.fn(() => null),
  clear: mocks.clearOwner,
}));

vi.mock('../appRegistration.js', () => ({
  requestAppRegistration: mocks.requestRegistration,
  pollAppRegistration: mocks.pollRegistration,
}));

import { FeishuIM } from '../index.js';
import {
  cancelAppRegistration,
  clearAndDisconnect,
  reconnectSavedCredentials,
  saveAndConnect,
} from '../ipc.js';

type IpcHandler = (payload?: unknown) => Promise<unknown> | unknown;

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const handlers = new Map<string, IpcHandler>();
const broadcasts = vi.fn();
const accountRun = vi.fn();
let active = true;
let accountToken = 1;
let operationGate: Promise<void> | null = null;

const host = {
  paths: { feishuMediaDir: '/tmp/@cindy/im-feishu-test' },
  secrets: {
    isAvailable: () => false,
    write: () => false,
    read: () => null,
    remove: () => {},
  },
  ipc: {
    throwIpcError: (code: 'INVALID_PARAMS', message: string) => {
      throw new Error(`[${code}] ${message}`);
    },
    handle: (channel: string, handler: IpcHandler) => {
      handlers.set(channel, handler);
    },
    broadcast: broadcasts,
  },
  accountScope: {
    capture: () => (active ? accountToken : null),
    isCurrent: (token: unknown) => active && token === accountToken,
    async run<T>(token: unknown, operation: () => Promise<T>): Promise<T> {
      accountRun(token);
      if (operationGate) await operationGate;
      if (!active || token !== accountToken) {
        throw new Error('[IM_NOT_READY] stale account generation');
      }
      return operation();
    },
  },
  httpPostForm: async () => ({ status: 200, body: {} }),
  createLogger: () => ({
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  }),
} as unknown as IMHost;

const im = new FeishuIM(host);

beforeAll(() => {
  im.registerIpc();
});

beforeEach(() => {
  cancelAppRegistration();
  active = true;
  accountToken += 1;
  operationGate = null;
  vi.clearAllMocks();
  mocks.getCurrentStatus.mockReturnValue('idle');
  mocks.getCurrentError.mockReturnValue(undefined);
  mocks.readCredentials.mockReturnValue(null);
  mocks.stop.mockResolvedValue(undefined);
  mocks.start.mockResolvedValue('connected');
  mocks.writeCredentials.mockReturnValue(true);
  mocks.writeOwnerOpenId.mockReturnValue(true);
});

afterEach(() => {
  vi.useRealTimers();
});

// Unit regression: opening settings after a failure must retain its cause.
// Existing tests cover account boundaries, not the get-state error snapshot.
it('returns the connection failure reason when settings opens after the status event', async () => {
  mocks.getCurrentStatus.mockReturnValue('error');
  mocks.getCurrentError.mockReturnValue('connect ETIMEDOUT');
  await expect(Promise.resolve(handlers.get('feishuBot:get-state')?.())).resolves.toMatchObject({
    status: 'error',
    error: 'connect ETIMEDOUT',
  });
});

describe('Feishu IPC account scope', () => {
  // Unit: real settings IPC, with a refused storage result. The transport
  // preference is allowed to change only after the new value is committed.
  it('leaves Feishu lifecycle behavior unchanged when the preference cannot be saved', async () => {
    const handle = handlers.get('feishuBot:set-lifecycle-announcement')!;
    mocks.writeLifecycleAnnouncement.mockReturnValueOnce(false).mockReturnValueOnce(true);
    await expect(handle({ enabled: false })).rejects.toThrow('could not be saved');
    expect(mocks.setLifecycleAnnouncement).not.toHaveBeenCalled();
    await expect(handle({ enabled: false })).resolves.toEqual({ ok: true });
    expect(mocks.setLifecycleAnnouncement).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('starts app registration with the selected verification service', async () => {
    mocks.requestRegistration.mockResolvedValue({
      deviceCode: 'device-code',
      userCode: 'user-code',
      verificationUrl: 'https://example.test',
      interval: 60,
      expiresIn: 60,
    });
    const begin = handlers.get('feishuBot:registration-begin');

    // runId 必须回给 renderer: 它是"这一轮是第几次"的唯一凭据,
    // renderer 据此丢弃旧轮次的收尾结果(否则旧授权会打断新授权)。
    const result = await Promise.resolve(begin?.({ service: 'lark' }));
    expect(result).toMatchObject({ ok: true, runId: expect.any(Number) });

    expect(mocks.requestRegistration).toHaveBeenCalledWith(host.httpPostForm, 'lark');
    cancelAppRegistration();
  });

  it('ignores a stale cancel from a superseded window', async () => {
    vi.useFakeTimers();
    mocks.requestRegistration.mockResolvedValue({
      deviceCode: 'device-code',
      userCode: 'user-code',
      verificationUrl: 'https://example.test',
      interval: 60,
      expiresIn: 60,
    });
    const begin = handlers.get('feishuBot:registration-begin');
    const cancel = handlers.get('feishuBot:registration-cancel');
    const first = (await begin?.({ service: 'feishu' })) as { runId: number };
    const second = (await begin?.({ service: 'feishu' })) as { runId: number };
    broadcasts.mockClear();

    // 旧窗口只知道自己那一轮: 取消它不能作废当前轮次。
    await cancel?.({ runId: first.runId });
    const cancelled = () =>
      broadcasts.mock.calls
        .filter(([channel]) => channel === 'feishuBot:registration-status')
        .map(([, payload]) => (payload as { status: string }).status);
    expect(cancelled()).not.toContain('cancelled');

    await cancel?.({ runId: second.runId });
    expect(cancelled()).toContain('cancelled');
  });

  it('switches to Lark immediately when Feishu reports the tenant while pending', async () => {
    vi.useFakeTimers();
    mocks.requestRegistration.mockResolvedValue({
      deviceCode: 'device-code',
      userCode: 'user-code',
      verificationUrl: 'https://open.larksuite.com/page/cli',
      interval: 1,
      expiresIn: 600,
    });
    mocks.pollRegistration
      .mockResolvedValueOnce({
        status: 'pending',
        tenantBrand: 'lark',
      })
      .mockResolvedValueOnce({
        status: 'pending',
      })
      .mockResolvedValueOnce({
        status: 'success',
        result: {
          clientId: 'cli_lark',
          clientSecret: 'lark-secret',
          tenantBrand: null,
          ownerOpenId: 'ou_lark_owner',
        },
      });

    const begin = handlers.get('feishuBot:registration-begin');
    await expect(
      Promise.resolve(begin?.({ service: 'lark' })),
    ).resolves.toMatchObject({
      ok: true,
    });
    await vi.advanceTimersByTimeAsync(1000);

    expect(mocks.pollRegistration).toHaveBeenNthCalledWith(
      1,
      host.httpPostForm,
      'feishu',
      'device-code',
      1,
    );
    expect(mocks.pollRegistration).toHaveBeenNthCalledWith(
      2,
      host.httpPostForm,
      'lark',
      'device-code',
      1,
    );
    expect(mocks.writeCredentials).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);

    expect(mocks.pollRegistration).toHaveBeenNthCalledWith(
      3,
      host.httpPostForm,
      'lark',
      'device-code',
      1,
    );
    expect(mocks.writeCredentials).toHaveBeenCalledWith({
      appId: 'cli_lark',
      appSecret: 'lark-secret',
      service: 'lark',
    });
  });

  it('keeps polling Lark when the first cross-domain poll is still pending', async () => {
    vi.useFakeTimers();
    mocks.requestRegistration.mockResolvedValue({
      deviceCode: 'device-code',
      userCode: 'user-code',
      verificationUrl: 'https://open.larksuite.com/page/cli',
      interval: 1,
      expiresIn: 600,
    });
    mocks.pollRegistration
      .mockResolvedValueOnce({
        status: 'success',
        result: {
          clientId: 'cli_lark',
          clientSecret: '',
          tenantBrand: 'lark',
          ownerOpenId: 'ou_lark_owner',
        },
      })
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({
        status: 'success',
        result: {
          clientId: 'cli_lark',
          clientSecret: 'lark-secret',
          tenantBrand: 'lark',
          ownerOpenId: 'ou_lark_owner',
        },
      });

    const begin = handlers.get('feishuBot:registration-begin');
    await expect(
      Promise.resolve(begin?.({ service: 'lark' })),
    ).resolves.toMatchObject({
      ok: true,
    });
    await vi.advanceTimersByTimeAsync(1000);

    expect(mocks.pollRegistration).toHaveBeenNthCalledWith(
      1,
      host.httpPostForm,
      'feishu',
      'device-code',
      1,
    );
    expect(mocks.pollRegistration).toHaveBeenNthCalledWith(
      2,
      host.httpPostForm,
      'lark',
      'device-code',
      1,
    );
    expect(mocks.writeCredentials).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);

    expect(mocks.pollRegistration).toHaveBeenNthCalledWith(
      3,
      host.httpPostForm,
      'lark',
      'device-code',
      1,
    );
    expect(mocks.writeCredentials).toHaveBeenCalledWith({
      appId: 'cli_lark',
      appSecret: 'lark-secret',
      service: 'lark',
    });
  });

  it('does not reconnect when credential save loses its account generation', async () => {
    const gate = deferred<void>();
    operationGate = gate.promise;
    const save = handlers.get('feishuBot:save');
    expect(save).toBeDefined();

    const saving = Promise.resolve(
      save?.({ appId: 'cli_test', appSecret: 'secret', service: 'feishu' }),
    );
    await vi.waitFor(() => expect(accountRun).toHaveBeenCalledWith(accountToken));

    active = false;
    accountToken += 1;
    gate.resolve();

    await expect(saving).rejects.toThrow('[IM_NOT_READY]');
    expect(mocks.writeCredentials).not.toHaveBeenCalled();
    expect(mocks.stop).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it('drops an in-flight registration result after account disposal', async () => {
    vi.useFakeTimers();
    const poll = deferred<{
      status: 'success';
      result: {
        clientId: string;
        clientSecret: string;
        tenantBrand: 'feishu';
        ownerOpenId: string;
      };
    }>();
    mocks.requestRegistration.mockResolvedValue({
      deviceCode: 'device-code',
      userCode: 'user-code',
      verificationUri: 'https://example.test',
      interval: 1,
      expiresIn: 600,
    });
    mocks.pollRegistration.mockReturnValue(poll.promise);

    const begin = handlers.get('feishuBot:registration-begin');
    await expect(Promise.resolve(begin?.({ service: 'feishu' }))).resolves.toMatchObject({
      ok: true,
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.pollRegistration).toHaveBeenCalledOnce();

    await im.dispose();
    poll.resolve({
      status: 'success',
      result: {
        clientId: 'cli_registered',
        clientSecret: 'registered-secret',
        tenantBrand: 'feishu',
        ownerOpenId: 'ou_owner',
      },
    });
    await vi.runAllTimersAsync();

    expect(mocks.writeOwnerOpenId).not.toHaveBeenCalled();
    expect(mocks.writeCredentials).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it('does not save a registration cancelled while the credential save is queued', async () => {
    vi.useFakeTimers();
    const gate = deferred<void>();
    operationGate = gate.promise;
    mocks.requestRegistration.mockResolvedValue({
      deviceCode: 'device-code',
      userCode: 'user-code',
      verificationUrl: 'https://example.test',
      interval: 1,
      expiresIn: 600,
    });
    mocks.pollRegistration.mockResolvedValueOnce({
      status: 'success',
      result: {
        clientId: 'cli_queued',
        clientSecret: 'queued-secret',
        tenantBrand: 'feishu',
        ownerOpenId: 'ou_queued',
      },
    });

    const begin = handlers.get('feishuBot:registration-begin');
    await expect(Promise.resolve(begin?.({ service: 'feishu' }))).resolves.toMatchObject({
      ok: true,
    });
    await vi.advanceTimersByTimeAsync(1000);
    // 保存已经排进连接生命周期队列, 但还没执行。
    await vi.waitFor(() => expect(accountRun).toHaveBeenCalled());

    cancelAppRegistration();
    gate.resolve();
    await vi.runAllTimersAsync();

    // 被取消的授权不得落盘, 更不能把连接拉起来。
    expect(mocks.writeCredentials).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
    const statuses = broadcasts.mock.calls
      .filter(([channel]) => channel === 'feishuBot:registration-status')
      .map(([, payload]) => (payload as { status: string }).status);
    expect(statuses).not.toContain('success');
  });

  it('reports a credential persistence failure instead of success', async () => {
    vi.useFakeTimers();
    mocks.writeCredentials.mockReturnValue(false);
    mocks.requestRegistration.mockResolvedValue({
      deviceCode: 'device-code',
      userCode: 'user-code',
      verificationUrl: 'https://example.test',
      interval: 1,
      expiresIn: 600,
    });
    mocks.pollRegistration.mockResolvedValueOnce({
      status: 'success',
      result: {
        clientId: 'cli_save_failed',
        clientSecret: 'save-failed-secret',
        tenantBrand: 'feishu',
        ownerOpenId: 'ou_save_failed',
      },
    });

    const begin = handlers.get('feishuBot:registration-begin');
    await expect(Promise.resolve(begin?.({ service: 'feishu' }))).resolves.toMatchObject({
      ok: true,
    });
    await vi.advanceTimersByTimeAsync(1000);
    await vi.runAllTimersAsync();

    // 凭证没落盘时不能报成功, 否则界面会切到"已绑定"卡片。
    expect(mocks.start).not.toHaveBeenCalled();
    const terminal = broadcasts.mock.calls
      .filter(([channel]) => channel === 'feishuBot:registration-status')
      .map(([, payload]) => payload as { status: string; error?: string })
      .find((payload) => payload.status !== 'pending');
    expect(terminal).toMatchObject({
      status: 'error',
      error: 'CREDENTIAL_SAVE_FAILED',
    });
  });
});

  it('does not leave a bot bound when the round is cancelled during the handshake', async () => {
    vi.useFakeTimers();
    const connecting = deferred<'connected'>();
    mocks.start.mockReturnValueOnce(connecting.promise as never);
    mocks.writeCredentials.mockImplementation((((creds: {
      appId: string;
      appSecret: string;
      service: 'feishu' | 'lark';
    }) => {
      mocks.readCredentials.mockReturnValue(creds as never);
      return true;
    }) as never));
    mocks.requestRegistration.mockResolvedValue({
      deviceCode: 'device-code',
      userCode: 'user-code',
      verificationUrl: 'https://example.test',
      interval: 1,
      expiresIn: 600,
    });
    mocks.pollRegistration.mockResolvedValueOnce({
      status: 'success',
      result: {
        clientId: 'cli_cancelled',
        clientSecret: 'cancelled-secret',
        tenantBrand: 'feishu',
        ownerOpenId: 'ou_cancelled',
      },
    });

    const begin = handlers.get('feishuBot:registration-begin');
    await expect(Promise.resolve(begin?.({ service: 'feishu' }))).resolves.toMatchObject({
      ok: true,
    });
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(mocks.start).toHaveBeenCalledOnce());

    // 凭证已经写盘、连接还在握手: 用户这时取消授权。
    cancelAppRegistration();
    connecting.resolve('connected');
    await vi.runAllTimersAsync();

    // 界面显示"已取消"时不能留下实际生效的机器人: 这一轮写下的凭证与连接要撤回。
    expect(mocks.stop).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'registration-cancelled' }),
    );
    expect(mocks.clearAll).toHaveBeenCalled();
    const statuses = broadcasts.mock.calls
      .filter(([channel]) => channel === 'feishuBot:registration-status')
      .map(([, payload]) => (payload as { status: string }).status);
    expect(statuses).not.toContain('success');
  });

  it('keeps a fresh binding when the cancelled round finishes its handshake later', async () => {
    vi.useFakeTimers();
    const firstConnecting = deferred<'connected'>();
    mocks.start
      .mockReturnValueOnce(firstConnecting.promise as never)
      .mockResolvedValue('connected');
    mocks.writeCredentials.mockImplementation((((creds: {
      appId: string;
      appSecret: string;
      service: 'feishu' | 'lark';
    }) => {
      mocks.readCredentials.mockReturnValue(creds as never);
      return true;
    }) as never));
    mocks.requestRegistration.mockResolvedValue({
      deviceCode: 'device-code',
      userCode: 'user-code',
      verificationUrl: 'https://example.test',
      interval: 1,
      expiresIn: 600,
    });
    mocks.pollRegistration
      .mockResolvedValueOnce({
        status: 'success',
        result: {
          clientId: 'cli_old',
          clientSecret: 'old-secret',
          tenantBrand: 'feishu',
          ownerOpenId: 'ou_old',
        },
      })
      .mockResolvedValueOnce({
        status: 'success',
        result: {
          clientId: 'cli_new',
          clientSecret: 'new-secret',
          tenantBrand: 'feishu',
          ownerOpenId: 'ou_new',
        },
      });

    const begin = handlers.get('feishuBot:registration-begin');
    await expect(Promise.resolve(begin?.({ service: 'feishu' }))).resolves.toMatchObject({
      ok: true,
    });
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(1));

    // 旧一轮还在握手时取消, 并立刻重新扫码走完新一轮。
    cancelAppRegistration();
    await expect(Promise.resolve(begin?.({ service: 'feishu' }))).resolves.toMatchObject({
      ok: true,
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.writeCredentials).toHaveBeenLastCalledWith({
      appId: 'cli_new',
      appSecret: 'new-secret',
      service: 'feishu',
    });
    const stopsAfterNewBinding = mocks.stop.mock.calls.length;

    // 旧轮次这时才握手结束: 清理不能动新的凭证和连接。
    firstConnecting.resolve('connected');
    await vi.runAllTimersAsync();

    // 旧轮次确实走到了清理路径(排队执行), 但因为绑定已换人而跳过。
    expect(accountRun).toHaveBeenCalledTimes(3);
    expect(mocks.readCredentials()).toMatchObject({ appId: 'cli_new' });
    expect(mocks.clearAll).not.toHaveBeenCalled();
    expect(mocks.stop.mock.calls.length).toBe(stopsAfterNewBinding);
  });

describe('Feishu credential connection semantics', () => {
  const credentials = {
    appId: 'cli_test',
    appSecret: 'secret',
    service: 'feishu' as const,
  };

  it('delegates owner clearing to stop before the idle status is broadcast', async () => {
    await clearAndDisconnect();

    expect(mocks.stop).toHaveBeenCalledWith({
      reason: 'credentials-cleared',
      clearOwnerBeforeIdle: true,
      discardPendingTopicLeases: true,
    });
    expect(mocks.clearOwner).not.toHaveBeenCalled();
    expect(mocks.clearAll).toHaveBeenCalledOnce();
  });

  it('keeps an already-connected transport untouched when credentials are unchanged', async () => {
    mocks.readCredentials.mockReturnValue(credentials);
    mocks.getCurrentStatus.mockReturnValue('connected');

    await expect(saveAndConnect(credentials.appId, credentials.appSecret)).resolves.toEqual({
      verdict: 'connected',
    });

    expect(mocks.writeCredentials).not.toHaveBeenCalled();
    expect(mocks.stop).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it('persists a registration owner before returning for unchanged credentials', async () => {
    mocks.readCredentials.mockReturnValue(credentials);
    mocks.getCurrentStatus.mockReturnValue('connected');

    await expect(
      saveAndConnect(credentials.appId, credentials.appSecret, credentials.service, {
        replacementOwnerOpenId: 'ou_registered_owner',
      }),
    ).resolves.toEqual({ verdict: 'connected' });

    expect(mocks.writeOwnerOpenId).toHaveBeenCalledWith('ou_registered_owner');
    expect(mocks.loadOwner).toHaveBeenCalledOnce();
    expect(mocks.stop).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it('fails closed when an unchanged registration owner cannot be persisted', async () => {
    mocks.readCredentials.mockReturnValue(credentials);
    mocks.getCurrentStatus.mockReturnValue('connected');
    mocks.writeOwnerOpenId.mockReturnValue(false);

    await expect(
      saveAndConnect(credentials.appId, credentials.appSecret, credentials.service, {
        replacementOwnerOpenId: 'ou_registered_owner',
      }),
    ).rejects.toThrow('[OWNER_PERSIST_FAILED]');

    expect(mocks.loadOwner).not.toHaveBeenCalled();
    expect(mocks.stop).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it.each(['testing', 'reconnecting'] as const)(
    'keeps an in-flight %s transport untouched when credentials are unchanged',
    async (status) => {
      mocks.readCredentials.mockReturnValue(credentials);
      mocks.getCurrentStatus.mockReturnValue(status);

      await expect(saveAndConnect(credentials.appId, credentials.appSecret)).resolves.toEqual({
        verdict: 'pending',
      });

      expect(mocks.writeCredentials).not.toHaveBeenCalled();
      expect(mocks.stop).not.toHaveBeenCalled();
      expect(mocks.start).not.toHaveBeenCalled();
    },
  );

  it('recovers an unchanged saved binding without lifecycle announcements', async () => {
    mocks.readCredentials.mockReturnValue(credentials);
    mocks.getCurrentStatus.mockReturnValue('error');

    await expect(saveAndConnect(credentials.appId, credentials.appSecret)).resolves.toEqual({
      verdict: 'connected',
    });

    expect(mocks.writeCredentials).not.toHaveBeenCalled();
    expect(mocks.stop).toHaveBeenCalledWith({
      announceOffline: false,
      reason: 'manual-reconnect',
      nextAccount: { appId: credentials.appId, service: credentials.service },
    });
    expect(mocks.start).toHaveBeenCalledWith(credentials, {
      announceLifecycle: false,
      reason: 'manual-reconnect',
    });
  });

  it('suppresses lifecycle announcements for an explicit manual reconnect', async () => {
    mocks.readCredentials.mockReturnValue(credentials);

    await expect(reconnectSavedCredentials()).resolves.toEqual({
      verdict: 'connected',
    });

    expect(mocks.stop).toHaveBeenCalledWith({
      announceOffline: false,
      reason: 'manual-reconnect',
      nextAccount: { appId: credentials.appId, service: credentials.service },
    });
    expect(mocks.start).toHaveBeenCalledWith(credentials, {
      announceLifecycle: false,
      reason: 'manual-reconnect',
    });
  });

  it('clears the per-app owner before connecting a different app ID', async () => {
    mocks.readCredentials.mockReturnValue(credentials);

    await expect(saveAndConnect('cli_other', 'other-secret')).resolves.toEqual({
      verdict: 'connected',
    });

    expect(mocks.stop).toHaveBeenCalledWith({
      reason: 'credentials-replaced',
      clearOwnerBeforeIdle: true,
      nextAccount: { appId: 'cli_other', service: 'feishu' },
    });
    expect(mocks.start).toHaveBeenCalledWith(
      { appId: 'cli_other', appSecret: 'other-secret', service: 'feishu' },
      { reason: 'credentials-replaced' },
    );
  });

  it('treats switching between Feishu and Lark as a new owner boundary', async () => {
    mocks.readCredentials.mockReturnValue(credentials);

    await expect(saveAndConnect(credentials.appId, credentials.appSecret, 'lark')).resolves.toEqual(
      { verdict: 'connected' },
    );

    expect(mocks.writeCredentials).toHaveBeenCalledWith({
      appId: credentials.appId,
      appSecret: credentials.appSecret,
      service: 'lark',
    });
    expect(mocks.stop).toHaveBeenCalledWith({
      reason: 'credentials-replaced',
      clearOwnerBeforeIdle: true,
      nextAccount: { appId: credentials.appId, service: 'lark' },
    });
    expect(mocks.start).toHaveBeenCalledWith(
      {
        appId: credentials.appId,
        appSecret: credentials.appSecret,
        service: 'lark',
      },
      { reason: 'credentials-replaced' },
    );
  });

  it('installs a replacement app registration owner after clearing the previous owner', async () => {
    mocks.readCredentials.mockReturnValue(credentials);

    await expect(
      saveAndConnect('cli_registered', 'registered-secret', 'feishu', {
        replacementOwnerOpenId: 'ou_registered_owner',
      }),
    ).resolves.toEqual({ verdict: 'connected' });

    expect(mocks.stop).toHaveBeenCalledWith({
      reason: 'credentials-replaced',
      clearOwnerBeforeIdle: true,
      nextAccount: { appId: 'cli_registered', service: 'feishu' },
    });
    expect(mocks.writeOwnerOpenId).toHaveBeenCalledWith('ou_registered_owner');
    expect(mocks.loadOwner).toHaveBeenCalledOnce();
    expect(mocks.stop.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.writeOwnerOpenId.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it('does not connect when a replacement registration owner cannot be persisted', async () => {
    mocks.readCredentials.mockReturnValue(credentials);
    mocks.writeOwnerOpenId.mockReturnValue(false);

    await expect(
      saveAndConnect('cli_registered', 'registered-secret', 'feishu', {
        replacementOwnerOpenId: 'ou_registered_owner',
      }),
    ).rejects.toThrow('[OWNER_PERSIST_FAILED]');

    expect(mocks.loadOwner).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it('preserves the owner when only the secret changes for the same app ID', async () => {
    mocks.readCredentials.mockReturnValue(credentials);

    await expect(saveAndConnect(credentials.appId, 'rotated-secret')).resolves.toEqual({
      verdict: 'connected',
    });

    expect(mocks.stop).toHaveBeenCalledWith({
      reason: 'credentials-replaced',
      clearOwnerBeforeIdle: false,
      nextAccount: { appId: credentials.appId, service: credentials.service },
    });
    expect(mocks.writeOwnerOpenId).not.toHaveBeenCalled();
    expect(mocks.loadOwner).not.toHaveBeenCalled();
  });

  it('does not tear down the current transport when saving new credentials fails', async () => {
    mocks.readCredentials.mockReturnValue(credentials);
    mocks.writeCredentials.mockReturnValue(false);

    await expect(saveAndConnect('cli_other', 'other-secret')).resolves.toEqual({
      verdict: 'error',
    });

    expect(mocks.stop).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
  });
});
