import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { IMHost } from '../../types.js';

const mocks = vi.hoisted(() => ({
  stop: vi.fn(async () => undefined),
  start: vi.fn(async () => 'connected' as const),
  getCurrentStatus: vi.fn<
    () => 'idle' | 'testing' | 'connected' | 'reconnecting' | 'conflict' | 'error'
  >(() => 'idle'),
  readCredentials: vi.fn(
    () =>
      null as {
        appId: string;
        appSecret: string;
        service: 'feishu' | 'lark';
      } | null,
  ),
  writeCredentials: vi.fn(() => true),
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
  setLifecycleAnnouncement: vi.fn(),
  clearOrphanRetriesForCredentialClear: vi.fn(),
  stop: mocks.stop,
  start: mocks.start,
}));

vi.mock('../storage.js', () => ({
  readCredentials: mocks.readCredentials,
  readOwnerOpenId: vi.fn(() => null),
  readLifecycleAnnouncement: vi.fn(() => true),
  writeLifecycleAnnouncement: vi.fn(),
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
  mocks.readCredentials.mockReturnValue(null);
  mocks.stop.mockResolvedValue(undefined);
  mocks.start.mockResolvedValue('connected');
  mocks.writeCredentials.mockReturnValue(true);
  mocks.writeOwnerOpenId.mockReturnValue(true);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Feishu IPC account scope', () => {
  it('starts app registration with the selected verification service', async () => {
    mocks.requestRegistration.mockResolvedValue({
      deviceCode: 'device-code',
      userCode: 'user-code',
      verificationUrl: 'https://example.test',
      interval: 60,
      expiresIn: 60,
    });
    const begin = handlers.get('feishuBot:registration-begin');

    await expect(Promise.resolve(begin?.({ service: 'lark' }))).resolves.toMatchObject({
      ok: true,
    });

    expect(mocks.requestRegistration).toHaveBeenCalledWith(host.httpPostForm, 'lark');
    cancelAppRegistration();
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
