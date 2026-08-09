import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type TestMode = 'signed-out' | 'local' | 'cloud';

const harness = vi.hoisted(() => ({
  root: '',
  session: {
    mode: 'cloud' as TestMode,
    dataOwnerId: 'owner-a' as string | null,
    generation: 1,
  },
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  listeners: new Map<string, (...args: unknown[]) => unknown>(),
  send: vi.fn(),
  sendSecond: vi.fn(),
  untrustedSend: vi.fn(),
  destroyedSend: vi.fn(),
  assertTrusted: vi.fn(),
  legacyClaimReady: true,
  legacyClaimedByOtherOwner: false,
  loggerInfo: vi.fn(),
  loggerError: vi.fn(),
  loggerWarn: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { getPath: () => harness.root },
  BrowserWindow: {
    getAllWindows: () => [
      { appContent: true, isDestroyed: () => false, webContents: { send: harness.send } },
      { appContent: true, isDestroyed: () => false, webContents: { send: harness.sendSecond } },
      {
        appContent: false,
        isDestroyed: () => false,
        webContents: { send: harness.untrustedSend },
      },
      {
        appContent: true,
        isDestroyed: () => true,
        webContents: { send: harness.destroyedSend },
      },
    ],
  },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      harness.handlers.set(channel, handler);
    },
    on: (channel: string, listener: (...args: unknown[]) => unknown) => {
      harness.listeners.set(channel, listener);
    },
  },
}));

vi.mock('../appSessionState.js', () => ({
  activeOwnerScopeKey: () =>
    `${harness.session.mode}:${harness.session.dataOwnerId ?? 'none'}:${harness.session.generation}`,
  dataOwnerStorageKey: (ownerId: string) => `key-${ownerId}`,
  getActiveAppSession: () => ({ ...harness.session }),
  getActiveDataOwnerPushStamp: () => ({
    dataOwnerId: harness.session.dataOwnerId,
    ownerGeneration: harness.session.generation,
  }),
  isAppSessionBoundaryPending: () => false,
  ownerScopedUserDataPath: (...parts: string[]) =>
    path.join(harness.root, 'owners', `key-${harness.session.dataOwnerId ?? 'none'}`, ...parts),
}));

vi.mock('../ownerNamespaceMigration.js', () => ({
  hasLegacyOwnerNamespaceClaim: () => harness.legacyClaimReady,
  isLegacyOwnerNamespaceClaimedByOtherOwner: () => harness.legacyClaimedByOtherOwner,
}));

vi.mock('../logger.js', () => ({
  createLogger: () => ({
    info: harness.loggerInfo,
    warn: harness.loggerWarn,
    error: harness.loggerError,
  }),
}));

vi.mock('../security/trustedAppRenderer.js', () => ({
  assertTrustedAppRendererEvent: (...args: unknown[]) => harness.assertTrusted(...args),
}));

vi.mock('../windowFocusClassifier.js', () => ({
  isAppContentWindow: (window: { appContent?: boolean; isDestroyed: () => boolean }) =>
    window.appContent === true && !window.isDestroyed(),
}));

const originalPlatform = process.platform;

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

function setSession(mode: TestMode, dataOwnerId: string | null): void {
  harness.session = {
    mode,
    dataOwnerId,
    generation: harness.session.generation + 1,
  };
}

function ownerFile(ownerId = harness.session.dataOwnerId): string {
  return path.join(harness.root, 'owners', `key-${ownerId}`, 'sidebar-settings.json');
}

function request<T extends object>(value: T) {
  return {
    dataOwnerId: harness.session.dataOwnerId,
    ownerGeneration: harness.session.generation,
    ...value,
  };
}

async function pinnedHandler(payload: unknown): Promise<string[]> {
  const handler = harness.handlers.get('sidebar-settings:save-pinned-order');
  expect(handler).toBeDefined();
  return (await handler?.({}, payload)) as string[];
}

async function hiddenHandler(payload: unknown): Promise<boolean> {
  const handler = harness.handlers.get('sidebar-settings:set-project-hidden');
  expect(handler).toBeDefined();
  return (await handler?.({}, payload)) as boolean;
}

function loadSnapshot(): {
  dataOwnerId: string | null;
  ownerGeneration: number;
  pinnedOrder: string[];
  hiddenProjectKeys: string[];
} {
  const listener = harness.listeners.get('sidebar-settings:load-snapshot-sync');
  const event: { returnValue?: ReturnType<typeof loadSnapshot> } = {};
  listener?.(event);
  return event.returnValue as ReturnType<typeof loadSnapshot>;
}

describe('sidebarSettingsStore', () => {
  beforeEach(async () => {
    setPlatform('win32');
    harness.root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-sidebar-owner-state-'));
    harness.session = { mode: 'cloud', dataOwnerId: 'owner-a', generation: 1 };
    harness.handlers.clear();
    harness.listeners.clear();
    harness.send.mockReset();
    harness.sendSecond.mockReset();
    harness.untrustedSend.mockReset();
    harness.destroyedSend.mockReset();
    harness.assertTrusted.mockReset();
    harness.legacyClaimReady = true;
    harness.legacyClaimedByOtherOwner = false;
    harness.loggerInfo.mockReset();
    harness.loggerError.mockReset();
    harness.loggerWarn.mockReset();
    vi.resetModules();

    const { registerSidebarSettingsIpc } = await import('../sidebarSettingsStore');
    registerSidebarSettingsIpc();
  });

  afterAll(() => {
    setPlatform(originalPlatform);
  });

  afterEach(() => {
    fs.rmSync(harness.root, { recursive: true, force: true });
  });

  it('isolates pinned and hidden state by owner', async () => {
    await pinnedHandler(
      request({
        mutation: {
          kind: 'migrate-legacy',
          order: ['project:local:/workspace/a', 'session-a'],
        },
      }),
    );
    await hiddenHandler(request({ projectKey: 'C:\\workspace\\alpha\\', hidden: true }));
    expect(loadSnapshot()).toMatchObject({
      dataOwnerId: 'owner-a',
      pinnedOrder: ['project:local:/workspace/a', 'session-a'],
      hiddenProjectKeys: ['local:C:/workspace/alpha'],
    });

    setSession('cloud', 'owner-b');
    harness.legacyClaimReady = false;
    harness.legacyClaimedByOtherOwner = true;
    expect(loadSnapshot()).toMatchObject({
      dataOwnerId: 'owner-b',
      pinnedOrder: [],
      hiddenProjectKeys: [],
    });
    await pinnedHandler(
      request({ mutation: { kind: 'migrate-legacy', order: ['session-b'] } }),
    );

    setSession('cloud', 'owner-a');
    harness.legacyClaimReady = true;
    harness.legacyClaimedByOtherOwner = false;
    expect(loadSnapshot()).toMatchObject({
      dataOwnerId: 'owner-a',
      pinnedOrder: ['project:local:/workspace/a', 'session-a'],
      hiddenProjectKeys: ['local:C:/workspace/alpha'],
    });
    expect(JSON.parse(fs.readFileSync(ownerFile('owner-b'), 'utf-8'))).toMatchObject({
      pinnedOrder: ['session-b'],
    });
  });

  it('broadcasts only after a durable owner-stamped pinned write', async () => {
    const order = ['project:local:/workspace/a', 'session-b'];
    await pinnedHandler(request({ mutation: { kind: 'migrate-legacy', order } }));

    const stamp = { dataOwnerId: 'owner-a', ownerGeneration: 1 };
    expect(harness.send).toHaveBeenCalledWith(
      'sidebar-settings:pinned-order-changed',
      order,
      stamp,
    );
    expect(harness.sendSecond).toHaveBeenCalledWith(
      'sidebar-settings:pinned-order-changed',
      order,
      stamp,
    );
    expect(harness.untrustedSend).not.toHaveBeenCalled();
    expect(harness.destroyedSend).not.toHaveBeenCalled();
  });

  it('rejects stale owner and generation stamps without touching either owner', async () => {
    const staleOwner = request({ mutation: { kind: 'promote', entryId: 'session-a' } });
    setSession('cloud', 'owner-b');

    await expect(pinnedHandler(staleOwner)).rejects.toThrow(
      '[PRECONDITION_FAILED] active account changed during sidebar mutation',
    );
    await expect(
      pinnedHandler({
        dataOwnerId: 'owner-b',
        ownerGeneration: harness.session.generation - 1,
        mutation: { kind: 'promote', entryId: 'session-b' },
      }),
    ).rejects.toThrow('[PRECONDITION_FAILED]');
    expect(fs.existsSync(ownerFile('owner-a'))).toBe(false);
    expect(fs.existsSync(ownerFile('owner-b'))).toBe(false);
    expect(harness.send).not.toHaveBeenCalled();
  });

  it('drops a queued write when the owner changes while it waits for the file lock', async () => {
    const file = ownerFile('owner-a');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      `${file}.lock`,
      JSON.stringify({ pid: process.pid, startedAt: Date.now() }),
      'utf-8',
    );

    const writing = pinnedHandler(
      request({ mutation: { kind: 'promote', entryId: 'session-a' } }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    setSession('cloud', 'owner-b');
    fs.unlinkSync(`${file}.lock`);

    await expect(writing).rejects.toThrow('[PRECONDITION_FAILED]');
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(ownerFile('owner-b'))).toBe(false);
    expect(harness.send).not.toHaveBeenCalled();
  });

  it('rechecks the legacy claim after waiting for the file lock', async () => {
    const file = ownerFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      `${file}.lock`,
      JSON.stringify({ pid: process.pid, startedAt: Date.now() }),
      'utf-8',
    );

    const writing = pinnedHandler(
      request({ mutation: { kind: 'promote', entryId: 'session-a' } }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    harness.legacyClaimReady = false;
    fs.unlinkSync(`${file}.lock`);

    await expect(writing).rejects.toThrow(
      '[PRECONDITION_FAILED] sidebar settings migration is pending',
    );
    expect(fs.existsSync(file)).toBe(false);
    expect(harness.send).not.toHaveBeenCalled();
  });

  it('merges sequential hidden intents against the latest main snapshot', async () => {
    await hiddenHandler(request({ projectKey: 'local:/workspace/alpha', hidden: true }));
    await hiddenHandler(request({ projectKey: 'local:/workspace/beta', hidden: true }));

    expect(loadSnapshot().hiddenProjectKeys).toEqual([
      'local:/workspace/alpha',
      'local:/workspace/beta',
    ]);
    expect(harness.send).toHaveBeenLastCalledWith(
      'sidebar-settings:hidden-project-keys-changed',
      ['local:/workspace/alpha', 'local:/workspace/beta'],
      { dataOwnerId: 'owner-a', ownerGeneration: 1 },
    );
  });

  it('merges concurrent promote intents against the latest pinned order', async () => {
    await expect(
      pinnedHandler(request({ mutation: { kind: 'promote', entryId: 'project:a' } })),
    ).resolves.toEqual(['project:a']);
    await expect(
      pinnedHandler(request({ mutation: { kind: 'promote', entryId: 'project:b' } })),
    ).resolves.toEqual(['project:b', 'project:a']);

    expect(loadSnapshot().pinnedOrder).toEqual(['project:b', 'project:a']);
  });

  it('does not let a delayed legacy migration overwrite newer pinned state', async () => {
    await pinnedHandler(request({ mutation: { kind: 'promote', entryId: 'new-session' } }));

    await expect(
      pinnedHandler(
        request({ mutation: { kind: 'migrate-legacy', order: ['legacy-session'] } }),
      ),
    ).resolves.toEqual(['new-session']);
    expect(loadSnapshot().pinnedOrder).toEqual(['new-session']);
  });

  it('rebases a stale drag without losing a pin from another window', async () => {
    await pinnedHandler(
      request({ mutation: { kind: 'migrate-legacy', order: ['session-a', 'session-b'] } }),
    );
    await pinnedHandler(request({ mutation: { kind: 'promote', entryId: 'session-c' } }));

    await expect(
      pinnedHandler(
        request({
          mutation: {
            kind: 'reorder',
            baseOrder: ['session-a', 'session-b'],
            order: ['session-b', 'session-a'],
          },
        }),
      ),
    ).resolves.toEqual(['session-c', 'session-b', 'session-a']);
  });

  it('treats repeated hidden intents as no-ops without broadcasting', async () => {
    await hiddenHandler(request({ projectKey: 'local:/workspace/alpha', hidden: true }));
    harness.send.mockClear();

    await expect(
      hiddenHandler(request({ projectKey: 'local:/workspace/alpha/', hidden: true })),
    ).resolves.toBe(false);
    expect(harness.send).not.toHaveBeenCalled();
  });

  it('rejects malformed writes before persistence', async () => {
    await expect(
      pinnedHandler(
        request({ mutation: { kind: 'migrate-legacy', order: ['valid', 42] } }),
      ),
    ).rejects.toThrow(
      '[INVALID_PARAMS] invalid sidebar pinned order',
    );
    await expect(
      hiddenHandler(request({ projectKey: 'device:missing-working-dir', hidden: true })),
    ).rejects.toThrow('[INVALID_PARAMS]');
    expect(fs.existsSync(ownerFile())).toBe(false);
  });

  it('logs pinned persistence failures, exposes a stable error, and does not broadcast', async () => {
    fs.mkdirSync(ownerFile(), { recursive: true });
    const sensitivePath = ownerFile();

    let thrown: unknown;
    try {
      await pinnedHandler(request({ mutation: { kind: 'promote', entryId: 'session-a' } }));
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe('[INTERNAL] failed to persist sidebar settings');
    expect((thrown as Error).message).not.toContain(sensitivePath);
    expect(harness.loggerError).toHaveBeenCalledWith(
      'failed to persist sidebar pinned order',
      expect.any(Error),
    );
    expect(harness.send).not.toHaveBeenCalled();
  });

  it('moves the shared legacy file only into the first verified cloud owner', () => {
    const legacy = path.join(harness.root, 'sidebar-settings.json');
    fs.writeFileSync(
      legacy,
      JSON.stringify({ pinnedOrder: ['legacy-session'], hiddenProjectKeys: [] }),
      'utf-8',
    );

    setSession('local', 'local-v1');
    expect(loadSnapshot().pinnedOrder).toEqual([]);
    expect(fs.existsSync(legacy)).toBe(true);

    setSession('cloud', 'owner-a');
    expect(loadSnapshot().pinnedOrder).toEqual(['legacy-session']);
    expect(fs.existsSync(legacy)).toBe(false);

    setSession('cloud', 'owner-b');
    expect(loadSnapshot().pinnedOrder).toEqual([]);
    expect(
      JSON.parse(
        fs.readFileSync(path.join(harness.root, 'sidebar-settings-legacy-owner.v1.json'), 'utf-8'),
      ),
    ).toEqual({ version: 1, ownerKey: 'key-owner-a' });
  });

  it('defers scoped writes until the active owner can claim legacy sidebar state', async () => {
    const legacy = path.join(harness.root, 'sidebar-settings.json');
    const legacySettings = {
      pinnedOrder: ['legacy-session'],
      hiddenProjectKeys: ['local:/workspace/legacy'],
    };
    fs.writeFileSync(legacy, JSON.stringify(legacySettings), 'utf-8');
    harness.legacyClaimReady = false;

    expect(loadSnapshot()).toMatchObject({ pinnedOrder: [], hiddenProjectKeys: [] });
    expect(fs.existsSync(ownerFile())).toBe(false);
    await expect(
      pinnedHandler(request({ mutation: { kind: 'promote', entryId: 'new-session' } })),
    ).rejects.toThrow('[PRECONDITION_FAILED] sidebar settings migration is pending');
    expect(JSON.parse(fs.readFileSync(legacy, 'utf-8'))).toEqual(legacySettings);
    expect(fs.existsSync(ownerFile())).toBe(false);

    harness.legacyClaimReady = true;
    expect(loadSnapshot()).toMatchObject(legacySettings);
    expect(fs.existsSync(legacy)).toBe(false);
    await expect(
      pinnedHandler(request({ mutation: { kind: 'promote', entryId: 'new-session' } })),
    ).resolves.toEqual(['new-session', 'legacy-session']);
  });

  it('lets another owner use scoped state without consuming a foreign legacy file', async () => {
    const legacy = path.join(harness.root, 'sidebar-settings.json');
    fs.writeFileSync(legacy, JSON.stringify({ pinnedOrder: ['foreign-legacy'] }), 'utf-8');
    harness.legacyClaimReady = false;
    harness.legacyClaimedByOtherOwner = true;

    expect(loadSnapshot().pinnedOrder).toEqual([]);
    await expect(
      pinnedHandler(request({ mutation: { kind: 'promote', entryId: 'owner-session' } })),
    ).resolves.toEqual(['owner-session']);
    expect(fs.existsSync(legacy)).toBe(true);
    expect(JSON.parse(fs.readFileSync(ownerFile(), 'utf-8'))).toMatchObject({
      pinnedOrder: ['owner-session'],
    });
  });

  it('does not expose sidebar identity values through the uploadable settings logger', async () => {
    const sensitiveSession = 'private-session-sentinel';
    const sensitiveProject = 'local:/workspace/private-project-sentinel';
    fs.mkdirSync(path.dirname(ownerFile()), { recursive: true });
    fs.writeFileSync(
      ownerFile(),
      JSON.stringify({
        pinnedOrder: [sensitiveSession],
        hiddenProjectKeys: [sensitiveProject],
      }),
      'utf-8',
    );

    expect(loadSnapshot()).toMatchObject({
      pinnedOrder: [sensitiveSession],
      hiddenProjectKeys: [sensitiveProject],
    });
    await pinnedHandler(request({ mutation: { kind: 'promote', entryId: 'safe-session' } }));

    expect(harness.loggerInfo).toHaveBeenCalledWith('sidebar settings loaded', {
      path: ownerFile(),
      isCustomized: true,
    });
    const logged = JSON.stringify(harness.loggerInfo.mock.calls);
    expect(logged).not.toContain(sensitiveSession);
    expect(logged).not.toContain(sensitiveProject);
  });

  it('does not expose malformed sidebar contents through the uploadable settings logger', () => {
    const sensitiveValue = 'local:/workspace/private-broken-sentinel';
    fs.mkdirSync(path.dirname(ownerFile()), { recursive: true });
    fs.writeFileSync(ownerFile(), `{"pinnedOrder":[${sensitiveValue}]}`, 'utf-8');

    expect(loadSnapshot()).toMatchObject({ pinnedOrder: [], hiddenProjectKeys: [] });
    expect(harness.loggerWarn).toHaveBeenCalledWith(
      'sidebar settings read failed; falling back to defaults',
      { path: ownerFile() },
    );
    expect(JSON.stringify(harness.loggerWarn.mock.calls)).not.toContain(sensitiveValue);
    expect(fs.existsSync(ownerFile())).toBe(true);
  });

  it('atomically reconciles legacy and scoped sidebar files', async () => {
    const legacy = path.join(harness.root, 'sidebar-settings.json');
    fs.writeFileSync(
      legacy,
      JSON.stringify({
        pinnedOrder: ['legacy-session'],
        hiddenProjectKeys: ['local:/workspace/legacy'],
      }),
      'utf-8',
    );
    fs.mkdirSync(path.dirname(ownerFile()), { recursive: true });
    fs.writeFileSync(
      ownerFile(),
      JSON.stringify({
        pinnedOrder: ['scoped-session'],
        hiddenProjectKeys: ['local:/workspace/scoped'],
      }),
      'utf-8',
    );

    expect(loadSnapshot()).toMatchObject({
      pinnedOrder: ['scoped-session', 'legacy-session'],
      hiddenProjectKeys: ['local:/workspace/scoped', 'local:/workspace/legacy'],
    });
    expect(fs.existsSync(legacy)).toBe(false);
    await expect(
      pinnedHandler(request({ mutation: { kind: 'promote', entryId: 'new-session' } })),
    ).resolves.toEqual(['new-session', 'scoped-session', 'legacy-session']);
    expect(JSON.parse(fs.readFileSync(ownerFile(), 'utf-8'))).toMatchObject({
      pinnedOrder: ['new-session', 'scoped-session', 'legacy-session'],
      hiddenProjectKeys: ['local:/workspace/scoped', 'local:/workspace/legacy'],
    });
  });

  it('rejects an oversized scoped file before reconciliation reads it', () => {
    const legacy = path.join(harness.root, 'sidebar-settings.json');
    fs.writeFileSync(legacy, '{"pinnedOrder":["legacy-session"]}', 'utf-8');
    fs.mkdirSync(path.dirname(ownerFile()), { recursive: true });
    fs.writeFileSync(ownerFile(), '');
    fs.truncateSync(ownerFile(), 64 * 1024 * 1024 + 1);
    const readFileSync = vi.spyOn(fs, 'readFileSync');

    try {
      expect(loadSnapshot()).toMatchObject({ pinnedOrder: [], hiddenProjectKeys: [] });
      expect(readFileSync).not.toHaveBeenCalled();
      expect(fs.existsSync(legacy)).toBe(true);
      expect(harness.loggerWarn).toHaveBeenCalledWith(
        'failed to reconcile legacy and owner-scoped sidebar settings',
        { ownerKey: 'key-owner-a', errorCode: 'INVALID_SETTINGS' },
      );
    } finally {
      readFileSync.mockRestore();
    }
  });

  it('fails closed when the sidebar legacy owner marker is malformed', () => {
    fs.writeFileSync(
      path.join(harness.root, 'sidebar-settings.json'),
      '{"pinnedOrder":["legacy"]}',
    );
    fs.writeFileSync(path.join(harness.root, 'sidebar-settings-legacy-owner.v1.json'), 'broken');

    expect(loadSnapshot().pinnedOrder).toEqual([]);
    expect(fs.existsSync(path.join(harness.root, 'sidebar-settings.json'))).toBe(true);
  });

  it('checks the trusted sender before accepting a mutation', async () => {
    harness.assertTrusted.mockImplementationOnce(() => {
      throw new Error('untrusted renderer');
    });

    await expect(
      pinnedHandler(request({ mutation: { kind: 'promote', entryId: 'session-a' } })),
    ).rejects.toThrow(
      'untrusted renderer',
    );
    expect(fs.existsSync(ownerFile())).toBe(false);
  });
});
