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

interface CapturingLogger {
  info: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

interface MockSdkOptions {
  logger: CapturingLogger;
  onReady?: () => void;
  onError?: (error: Error) => void;
}

const mocks = {
  options: [] as MockSdkOptions[],
  start: vi.fn(async () => undefined),
  close: vi.fn(),
  bindClient: vi.fn(),
  unbindClient: vi.fn(),
  getBoundClient: vi.fn(() => null),
  sendText: vi.fn(),
  firstAllowed: vi.fn(() => null),
  checkOwner: vi.fn(() => true),
  tryClaimOwner: vi.fn(() => false),
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
    register(): this {
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
  check: mocks.checkOwner,
  tryClaimOwner: mocks.tryClaimOwner,
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
  vi.clearAllMocks();
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
