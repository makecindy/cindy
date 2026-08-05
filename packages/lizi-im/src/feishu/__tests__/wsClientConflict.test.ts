import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { feishuEvents } from '../events.js';
import { messages as transportMessages } from '../messages.js';

interface CapturingLogger {
  info: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

interface MockSdkOptions {
  logger: CapturingLogger;
  onReady?: () => void;
  onError?: (error: Error) => void;
}

type EventHandler = (data: unknown) => Promise<unknown> | unknown;

const mocks = {
  options: [] as MockSdkOptions[],
  start: vi.fn(async () => undefined),
  close: vi.fn(),
  bindClient: vi.fn(),
  unbindClient: vi.fn(),
  getBoundClient: vi.fn(() => null),
  sendText: vi.fn(),
  firstAllowed: vi.fn<() => string | null>(() => null),
  readOwnerOpenId: vi.fn<() => string | null>(() => null),
  clearOwner: vi.fn(),
  checkOwner: vi.fn(() => true),
  tryClaimOwner: vi.fn(() => false),
  eventHandlers: {} as Record<string, EventHandler>,
  log: {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
};

vi.doMock('@larksuiteoapi/node-sdk', () => ({
  WSClient: class {
    readonly start = mocks.start;
    readonly close = mocks.close;

    constructor(options: MockSdkOptions) {
      mocks.options.push(options);
    }
  },
  EventDispatcher: class {
    register(handlers: Record<string, EventHandler>): this {
      mocks.eventHandlers = handlers;
      return this;
    }
  },
  LoggerLevel: { info: 'info' },
}));

vi.doMock('../outbound.js', () => ({
  bindClient: mocks.bindClient,
  unbindClient: mocks.unbindClient,
  getBoundClient: mocks.getBoundClient,
  sendText: mocks.sendText,
}));

vi.doMock('../ownerGuard.js', () => ({
  firstAllowed: mocks.firstAllowed,
  clear: mocks.clearOwner,
  check: mocks.checkOwner,
  tryClaimOwner: mocks.tryClaimOwner,
}));

vi.doMock('../storage.js', () => ({
  readOwnerOpenId: mocks.readOwnerOpenId,
}));

vi.doMock('../moduleScope.js', () => ({
  getLog: () => mocks.log,
}));

let wsClient: typeof import('../wsClient.js');

const credentials = {
  appId: 'cli_conflict_test',
  appSecret: 'secret',
};

function latestClient() {
  const options = mocks.options.at(-1);
  if (!options) throw new Error('expected WSClient to be constructed');
  return {
    options,
    logger: options.logger,
    start: mocks.start,
    close: mocks.close,
  };
}

beforeEach(async () => {
  await wsClient.stop({ announceOffline: false, reason: 'test-reset' });
  mocks.options.length = 0;
  mocks.eventHandlers = {};
  vi.clearAllMocks();
  mocks.firstAllowed.mockReturnValue(null);
  mocks.readOwnerOpenId.mockReturnValue(null);
});

afterEach(async () => {
  await wsClient.stop({ announceOffline: false, reason: 'test-cleanup' });
});

beforeAll(async () => {
  wsClient = await import('../wsClient.js');
});

afterAll(() => {
  vi.doUnmock('@larksuiteoapi/node-sdk');
  vi.doUnmock('../outbound.js');
  vi.doUnmock('../ownerGuard.js');
  vi.doUnmock('../storage.js');
  vi.doUnmock('../moduleScope.js');
});

describe('Feishu WebSocket conflict handling', () => {
  it('maps exceed_conn_limit during initial connection to conflict and closes the socket', async () => {
    const onConflict = vi.fn();
    feishuEvents.on('conflict', onConflict);

    try {
      const connecting = wsClient.start(credentials, { announceLifecycle: false });
      const sdkClient = latestClient();

      sdkClient.options.onError?.(
        new Error(
          'pullConnectConfig failed: code=1000040350, msg=exceed_conn_limit',
        ),
      );
      sdkClient.options.onReady?.();
      expect(wsClient.getCurrentStatus()).not.toBe('connected');

      await expect(connecting).resolves.toBe('conflict');
      expect(wsClient.getCurrentStatus()).toBe('conflict');
      expect(sdkClient.close).toHaveBeenCalledWith({ force: true });
      expect(onConflict).toHaveBeenCalledOnce();
      expect(onConflict).toHaveBeenCalledWith({ appId: credentials.appId });
    } finally {
      feishuEvents.off('conflict', onConflict);
    }
  });

  it('revokes an already-ready connection when a late conflict signal arrives', async () => {
    const onConflict = vi.fn();
    feishuEvents.on('conflict', onConflict);

    try {
      const connecting = wsClient.start(credentials, { announceLifecycle: false });
      const sdkClient = latestClient();
      sdkClient.options.onReady?.();

      await expect(connecting).resolves.toBe('connected');
      expect(wsClient.getCurrentStatus()).toBe('connected');

      sdkClient.options.onError?.(new Error('exceed_conn_limit'));

      await vi.waitFor(() => expect(wsClient.getCurrentStatus()).toBe('conflict'));
      expect(sdkClient.close).toHaveBeenCalledWith({ force: true });
      expect(onConflict).toHaveBeenCalledOnce();
      expect(onConflict).toHaveBeenCalledWith({ appId: credentials.appId });
    } finally {
      feishuEvents.off('conflict', onConflict);
    }
  });

  it('keeps SDK error-log parsing as a conflict fallback', async () => {
    const connecting = wsClient.start(credentials, { announceLifecycle: false });
    const sdkClient = latestClient();

    sdkClient.logger.error('[ws]', 'code: 1000040350, exceed_conn_limit');

    await expect(connecting).resolves.toBe('conflict');
    expect(wsClient.getCurrentStatus()).toBe('conflict');
    expect(sdkClient.close).toHaveBeenCalledWith({ force: true });
  });
});

describe('Feishu owner binding updates', () => {
  it('falls back to the persisted owner before the in-memory guard is loaded', async () => {
    mocks.firstAllowed.mockReturnValue(null);
    mocks.readOwnerOpenId.mockReturnValue('ou_persisted_owner');
    const onStatus = vi.fn();
    feishuEvents.on('status', onStatus);

    try {
      const connecting = wsClient.start(credentials, { announceLifecycle: false });
      latestClient().options.onReady?.();
      await expect(connecting).resolves.toBe('connected');

      expect(onStatus).toHaveBeenLastCalledWith({
        status: 'connected',
        error: undefined,
        botAppId: credentials.appId,
        ownerOpenId: 'ou_persisted_owner',
      });
    } finally {
      feishuEvents.off('status', onStatus);
    }
  });

  it('emits the claimed owner after the first valid p2p message', async () => {
    mocks.tryClaimOwner.mockReturnValueOnce(true);
    mocks.firstAllowed.mockReturnValueOnce(null).mockReturnValue('ou_new_owner');
    mocks.sendText.mockResolvedValueOnce({ messageId: 'welcome-message' });
    const onStatus = vi.fn();

    try {
      const connecting = wsClient.start(credentials, { announceLifecycle: false });
      latestClient().options.onReady?.();
      await expect(connecting).resolves.toBe('connected');
      feishuEvents.on('status', onStatus);

      const handleMessage = mocks.eventHandlers['im.message.receive_v1'];
      expect(handleMessage).toBeDefined();
      await handleMessage?.({
        sender: { sender_id: { open_id: 'ou_new_owner' } },
        message: {
          message_id: 'om_first',
          chat_id: 'oc_owner_chat',
          chat_type: 'p2p',
          message_type: 'text',
          content: JSON.stringify({ text: 'hello' }),
        },
      });

      expect(onStatus).toHaveBeenCalledOnce();
      expect(onStatus).toHaveBeenCalledWith({
        status: 'connected',
        error: undefined,
        botAppId: credentials.appId,
        ownerOpenId: 'ou_new_owner',
      });
    } finally {
      feishuEvents.off('status', onStatus);
    }
  });

  it('clears the owner before broadcasting the credentials-cleared idle state', async () => {
    mocks.firstAllowed.mockReturnValue('ou_previous_owner');
    mocks.clearOwner.mockImplementationOnce(() => {
      mocks.firstAllowed.mockReturnValue(null);
    });
    const connecting = wsClient.start(credentials, { announceLifecycle: false });
    latestClient().options.onReady?.();
    await expect(connecting).resolves.toBe('connected');
    const onStatus = vi.fn();
    feishuEvents.on('status', onStatus);

    try {
      await wsClient.stop({
        announceOffline: false,
        clearOwnerBeforeIdle: true,
        reason: 'credentials-cleared',
      });

      expect(mocks.clearOwner).toHaveBeenCalledOnce();
      expect(onStatus).toHaveBeenLastCalledWith({
        status: 'idle',
        error: undefined,
        botAppId: null,
        ownerOpenId: null,
      });
    } finally {
      feishuEvents.off('status', onStatus);
    }
  });

  it('does not carry an old binding offline notice into a replacement app', async () => {
    mocks.firstAllowed.mockReturnValue('ou_previous_owner');
    mocks.clearOwner.mockImplementationOnce(() => {
      mocks.firstAllowed.mockReturnValue(null);
    });
    mocks.sendText.mockResolvedValue({ messageId: 'om_lifecycle' });

    const connecting = wsClient.start(credentials, { announceLifecycle: false });
    latestClient().options.onReady?.();
    await expect(connecting).resolves.toBe('connected');
    await wsClient.stop({
      clearOwnerBeforeIdle: true,
      reason: 'credentials-replaced',
    });

    mocks.tryClaimOwner.mockImplementationOnce(() => {
      mocks.firstAllowed.mockReturnValue('ou_replacement_owner');
      return true;
    });
    const replacementCredentials = {
      appId: 'cli_replacement',
      appSecret: 'replacement-secret',
    };
    const replacementConnecting = wsClient.start(replacementCredentials, {
      announceLifecycle: false,
    });
    latestClient().options.onReady?.();
    await expect(replacementConnecting).resolves.toBe('connected');

    await mocks.eventHandlers['im.message.receive_v1']?.({
      sender: { sender_id: { open_id: 'ou_replacement_owner' } },
      message: {
        message_id: 'om_first_replacement',
        chat_id: 'oc_replacement',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: 'hello' }),
      },
    });

    expect(mocks.sendText).not.toHaveBeenCalledWith(
      'ou_replacement_owner',
      transportMessages.lifecycle.offlineNotice,
    );
  });
});
