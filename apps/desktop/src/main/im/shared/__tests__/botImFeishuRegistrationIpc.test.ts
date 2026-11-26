import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, payload?: unknown) => unknown>(),
  request: vi.fn(),
  poll: vi.fn(),
  add: vi.fn(),
  remove: vi.fn(),
  readStatus: vi.fn(),
  send: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, payload?: unknown) => unknown) => {
      mocks.handlers.set(channel, handler);
    },
  },
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: mocks.send } }],
  },
}));
vi.mock('../../host', () => ({ postForm: vi.fn() }));
vi.mock('@cindy/im', () => ({
  requestFeishuAppRegistration: mocks.request,
  pollFeishuAppRegistration: mocks.poll,
}));
vi.mock('../../../security/trustedAppRenderer', () => ({
  assertTrustedAppRendererEvent: vi.fn(),
}));
vi.mock('../../../appSessionState', () => ({
  activeOwnerScopeKey: () => 'owner-1',
  isAppSessionBoundaryPending: () => false,
}));
vi.mock('../../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../botImConnectionRuntime', () => ({
  addBotImConnection: mocks.add,
  readBotProfileStatus: mocks.readStatus,
  removeBotImConnection: mocks.remove,
}));

import { registerBotImFeishuRegistrationIpc } from '../botImFeishuRegistrationIpc';

const begin = {
  deviceCode: 'device-code',
  userCode: 'user-code',
  verificationUrl: 'https://example.test/authorize',
  expiresIn: 600,
  interval: 1,
};

function handler(channel: string) {
  const found = mocks.handlers.get(channel);
  if (!found) throw new Error('missing handler ' + channel);
  return found;
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.request.mockReset().mockResolvedValue(begin);
  mocks.poll.mockReset();
  mocks.add.mockReset();
  mocks.remove.mockReset();
  mocks.readStatus.mockReset().mockResolvedValue('active');
  mocks.send.mockReset();
  registerBotImFeishuRegistrationIpc();
  handler('botImConnection:feishu-registration-cancel')({});
  mocks.send.mockClear();
});

describe('伙伴飞书扫码授权 IPC', () => {
  it('rejects a bot that is gone before starting authorization', async () => {
    mocks.readStatus.mockResolvedValue(null);

    await expect(
      handler('botImConnection:feishu-registration-begin')(
        {},
        { botId: 'bot-1', service: 'feishu' },
      ),
    ).rejects.toThrow(/BOT_NOT_FOUND/);
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it('rejects with a decodable IPC error when the registration request fails', async () => {
    mocks.request.mockRejectedValue(new Error('network down'));

    await expect(
      handler('botImConnection:feishu-registration-begin')(
        {},
        { botId: 'bot-1', service: 'feishu' },
      ),
    ).rejects.toThrow(/network down/);
  });

  it('creates the partner connection in main and binds the scanning user as owner', async () => {
    mocks.poll.mockResolvedValue({
      status: 'success',
      result: {
        clientId: 'cli_registered',
        clientSecret: 'registered-secret',
        tenantBrand: 'lark',
        ownerOpenId: 'ou_owner',
      },
    });
    mocks.add.mockResolvedValue({
      connections: [],
      connection: { id: 'abcdef123456' },
    });

    await expect(
      handler('botImConnection:feishu-registration-begin')(
        {},
        { botId: 'bot-1', service: 'feishu' },
      ),
    ).resolves.toMatchObject({ ok: true, runId: expect.any(Number) });
    await vi.advanceTimersByTimeAsync(1000);

    expect(mocks.add).toHaveBeenCalledWith(
      {
        botId: 'bot-1',
        channel: 'feishu',
        appId: 'cli_registered',
        appSecret: 'registered-secret',
        service: 'lark',
      },
      { ownerUserId: 'ou_owner', shouldProceed: expect.any(Function) },
    );
    expect(mocks.send).toHaveBeenLastCalledWith(
      'botImConnection:feishu-registration-status',
      expect.objectContaining({ status: 'success' }),
    );
  });

  it('rolls back a connection created after the user cancelled', async () => {
    mocks.poll.mockResolvedValue({
      status: 'success',
      result: {
        clientId: 'cli_slow',
        clientSecret: 'slow-secret',
        tenantBrand: 'feishu',
        ownerOpenId: null,
      },
    });
    let resolveAdd!: (value: unknown) => void;
    mocks.add.mockReturnValue(
      new Promise((resolve) => {
        resolveAdd = resolve;
      }),
    );

    await handler('botImConnection:feishu-registration-begin')(
      {},
      { botId: 'bot-1', service: 'feishu' },
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.add).toHaveBeenCalled();

    handler('botImConnection:feishu-registration-cancel')({});
    resolveAdd({ connections: [], connection: { id: 'rolling-back' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.remove).toHaveBeenCalledWith('rolling-back');
    expect(mocks.send).not.toHaveBeenCalledWith(
      'botImConnection:feishu-registration-status',
      expect.objectContaining({ status: 'success' }),
    );
  });
});
