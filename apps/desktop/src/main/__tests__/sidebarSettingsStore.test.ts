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
  legacyClaimReady: false,
  legacyClaimedByOtherOwner: true,
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
let sidebarTesting: (typeof import('../sidebarSettingsStore'))['__testing'];

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
  pinnedOrderIsAuthoritative: boolean;
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
    harness.legacyClaimReady = false;
    harness.legacyClaimedByOtherOwner = true;
    harness.loggerInfo.mockReset();
    harness.loggerError.mockReset();
    harness.loggerWarn.mockReset();
    vi.resetModules();

    const { registerSidebarSettingsIpc, __testing } = await import('../sidebarSettingsStore');
    sidebarTesting = __testing;
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
    await pinnedHandler(request({ mutation: { kind: 'migrate-legacy', order: ['session-b'] } }));

    setSession('cloud', 'owner-a');
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

  it('releases settled per-owner write chains after success and failure', async () => {
    expect(sidebarTesting.pendingWriteChainCount()).toBe(0);
    await pinnedHandler(request({ mutation: { kind: 'promote', entryId: 'session-a' } }));
    expect(sidebarTesting.pendingWriteChainCount()).toBe(0);

    setSession('cloud', 'owner-b');
    harness.legacyClaimReady = false;
    harness.legacyClaimedByOtherOwner = true;
    fs.mkdirSync(path.dirname(ownerFile()), { recursive: true });
    fs.writeFileSync(ownerFile(), '{broken', 'utf-8');
    await expect(
      pinnedHandler(request({ mutation: { kind: 'promote', entryId: 'session-b' } })),
    ).rejects.toThrow('[INTERNAL] failed to persist sidebar settings');
    expect(sidebarTesting.pendingWriteChainCount()).toBe(0);
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

    const writing = pinnedHandler(request({ mutation: { kind: 'promote', entryId: 'session-a' } }));
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

    const writing = pinnedHandler(request({ mutation: { kind: 'promote', entryId: 'session-a' } }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    harness.legacyClaimReady = false;
    harness.legacyClaimedByOtherOwner = false;
    fs.unlinkSync(`${file}.lock`);

    await expect(writing).rejects.toThrow(
      '[PRECONDITION_FAILED] sidebar settings owner claim is pending',
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
      pinnedHandler(request({ mutation: { kind: 'migrate-legacy', order: ['legacy-session'] } })),
    ).resolves.toEqual(['new-session']);
    expect(loadSnapshot().pinnedOrder).toEqual(['new-session']);
  });

  it('persists an empty legacy migration as an authoritative owner snapshot', async () => {
    expect(loadSnapshot()).toMatchObject({
      pinnedOrderIsAuthoritative: false,
      pinnedOrder: [],
    });

    await expect(
      pinnedHandler(request({ mutation: { kind: 'migrate-legacy', order: [] } })),
    ).resolves.toEqual([]);
    expect(JSON.parse(fs.readFileSync(ownerFile(), 'utf-8'))).toEqual({ pinnedOrder: [] });
    expect(loadSnapshot()).toMatchObject({
      pinnedOrderIsAuthoritative: true,
      pinnedOrder: [],
    });

    await expect(
      pinnedHandler(request({ mutation: { kind: 'migrate-legacy', order: ['stale-session'] } })),
    ).resolves.toEqual([]);
    expect(JSON.parse(fs.readFileSync(ownerFile(), 'utf-8')).pinnedOrder).toEqual([]);
    expect(harness.send).not.toHaveBeenCalled();
    expect(harness.sendSecond).not.toHaveBeenCalled();
  });

  it('keeps a historical stored empty order authoritative over stale Renderer data', async () => {
    fs.mkdirSync(path.dirname(ownerFile()), { recursive: true });
    fs.writeFileSync(
      ownerFile(),
      JSON.stringify({ pinnedOrder: [], hiddenProjectKeys: [] }),
      'utf-8',
    );

    expect(loadSnapshot()).toMatchObject({
      pinnedOrderIsAuthoritative: true,
      pinnedOrder: [],
    });
    await expect(
      pinnedHandler(request({ mutation: { kind: 'migrate-legacy', order: ['stale-session'] } })),
    ).resolves.toEqual([]);
    expect(JSON.parse(fs.readFileSync(ownerFile(), 'utf-8')).pinnedOrder).toEqual([]);
    expect(harness.send).not.toHaveBeenCalled();
    expect(harness.sendSecond).not.toHaveBeenCalled();
  });

  it('rechecks migration authority after waiting for another writer', async () => {
    const file = ownerFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      `${file}.lock`,
      JSON.stringify({ pid: process.pid, startedAt: Date.now() }),
      'utf-8',
    );

    const migrating = pinnedHandler(
      request({ mutation: { kind: 'migrate-legacy', order: ['stale-session'] } }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    fs.writeFileSync(file, JSON.stringify({ pinnedOrder: [], hiddenProjectKeys: [] }), 'utf-8');
    fs.unlinkSync(`${file}.lock`);

    await expect(migrating).resolves.toEqual([]);
    expect(JSON.parse(fs.readFileSync(file, 'utf-8')).pinnedOrder).toEqual([]);
    expect(harness.send).not.toHaveBeenCalled();
    expect(harness.sendSecond).not.toHaveBeenCalled();
  });

  it('rejects migration when scoped access becomes blocked inside the file lock', async () => {
    const file = ownerFile();
    const backup = `${file}.bak`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      `${file}.lock`,
      JSON.stringify({ pid: process.pid, startedAt: Date.now() }),
      'utf-8',
    );

    const migrating = pinnedHandler(
      request({ mutation: { kind: 'migrate-legacy', order: ['legacy-session'] } }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    fs.writeFileSync(backup, '{"pinnedOrder":["backup-session"]}', 'utf-8');
    fs.unlinkSync(`${file}.lock`);

    await expect(migrating).rejects.toThrow(
      '[PRECONDITION_FAILED] sidebar settings owner claim is pending',
    );
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.readFileSync(backup, 'utf-8')).toBe('{"pinnedOrder":["backup-session"]}');
    expect(harness.send).not.toHaveBeenCalled();
    expect(harness.sendSecond).not.toHaveBeenCalled();
  });

  it('keeps pinned migration pending for a hidden-only scoped snapshot', async () => {
    await expect(
      hiddenHandler(request({ projectKey: 'local:/workspace/hidden', hidden: true })),
    ).resolves.toBe(true);
    expect(loadSnapshot()).toMatchObject({
      pinnedOrderIsAuthoritative: false,
      pinnedOrder: [],
      hiddenProjectKeys: ['local:/workspace/hidden'],
    });

    await expect(
      pinnedHandler(request({ mutation: { kind: 'migrate-legacy', order: ['legacy-session'] } })),
    ).resolves.toEqual(['legacy-session']);
    expect(loadSnapshot()).toMatchObject({
      pinnedOrderIsAuthoritative: true,
      pinnedOrder: ['legacy-session'],
      hiddenProjectKeys: ['local:/workspace/hidden'],
    });
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
      pinnedHandler(request({ mutation: { kind: 'migrate-legacy', order: ['valid', 42] } })),
    ).rejects.toThrow('[INVALID_PARAMS] invalid sidebar pinned order');
    await expect(
      hiddenHandler(request({ projectKey: 'device:missing-working-dir', hidden: true })),
    ).rejects.toThrow('[INVALID_PARAMS]');
    expect(fs.existsSync(ownerFile())).toBe(false);
  });

  it('logs pinned persistence failures, exposes a stable error, and does not broadcast', async () => {
    fs.mkdirSync(path.dirname(ownerFile()), { recursive: true });
    fs.writeFileSync(ownerFile(), '{broken', 'utf-8');
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

  it('keeps the first cloud owner on the rollback-compatible root file', async () => {
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
    harness.legacyClaimReady = true;
    harness.legacyClaimedByOtherOwner = false;
    expect(loadSnapshot().pinnedOrder).toEqual(['legacy-session']);
    await expect(
      pinnedHandler(request({ mutation: { kind: 'promote', entryId: 'new-session' } })),
    ).resolves.toEqual(['new-session', 'legacy-session']);
    await expect(
      hiddenHandler(request({ projectKey: 'local:/workspace/new', hidden: true })),
    ).resolves.toBe(true);
    expect(JSON.parse(fs.readFileSync(legacy, 'utf-8'))).toEqual({
      pinnedOrder: ['new-session', 'legacy-session'],
      hiddenProjectKeys: ['local:/workspace/new'],
    });
    expect(fs.existsSync(ownerFile('owner-a'))).toBe(false);

    // Simulate the parent release changing the same file during a downgrade.
    const downgraded = {
      pinnedOrder: ['changed-by-parent-release'],
      hiddenProjectKeys: ['local:/workspace/from-parent'],
    };
    fs.writeFileSync(legacy, JSON.stringify(downgraded), 'utf-8');
    const future = new Date(Date.now() + 1_000);
    fs.utimesSync(legacy, future, future);
    expect(loadSnapshot()).toMatchObject(downgraded);

    setSession('cloud', 'owner-b');
    harness.legacyClaimReady = false;
    harness.legacyClaimedByOtherOwner = true;
    expect(loadSnapshot().pinnedOrder).toEqual([]);
    await expect(
      pinnedHandler(request({ mutation: { kind: 'promote', entryId: 'owner-b-session' } })),
    ).resolves.toEqual(['owner-b-session']);
    expect(JSON.parse(fs.readFileSync(ownerFile('owner-b'), 'utf-8'))).toMatchObject({
      pinnedOrder: ['owner-b-session'],
    });
    expect(JSON.parse(fs.readFileSync(legacy, 'utf-8'))).toEqual(downgraded);
  });

  it('blocks cloud writes until the global owner claim is complete and exclusive', async () => {
    const legacy = path.join(harness.root, 'sidebar-settings.json');
    const legacySettings = {
      pinnedOrder: ['legacy-session'],
      hiddenProjectKeys: ['local:/workspace/legacy'],
    };
    fs.writeFileSync(legacy, JSON.stringify(legacySettings), 'utf-8');
    harness.legacyClaimReady = false;
    harness.legacyClaimedByOtherOwner = false;

    expect(loadSnapshot()).toMatchObject({
      pinnedOrderIsAuthoritative: false,
      pinnedOrder: [],
      hiddenProjectKeys: [],
    });
    expect(fs.existsSync(ownerFile())).toBe(false);
    await expect(
      pinnedHandler(request({ mutation: { kind: 'promote', entryId: 'new-session' } })),
    ).rejects.toThrow('[PRECONDITION_FAILED] sidebar settings owner claim is pending');
    expect(JSON.parse(fs.readFileSync(legacy, 'utf-8'))).toEqual(legacySettings);
    expect(fs.existsSync(ownerFile())).toBe(false);

    harness.legacyClaimReady = true;
    expect(loadSnapshot()).toMatchObject(legacySettings);
    await expect(
      pinnedHandler(request({ mutation: { kind: 'promote', entryId: 'new-session' } })),
    ).resolves.toEqual(['new-session', 'legacy-session']);
    expect(fs.existsSync(legacy)).toBe(true);
    expect(fs.existsSync(ownerFile())).toBe(false);
  });

  it('creates the first cloud owner snapshot at the root even without legacy bytes', async () => {
    const legacy = path.join(harness.root, 'sidebar-settings.json');
    harness.legacyClaimReady = false;
    harness.legacyClaimedByOtherOwner = false;

    await expect(
      pinnedHandler(request({ mutation: { kind: 'promote', entryId: 'new-session' } })),
    ).rejects.toThrow('[PRECONDITION_FAILED] sidebar settings owner claim is pending');
    harness.legacyClaimReady = true;
    await expect(
      pinnedHandler(request({ mutation: { kind: 'promote', entryId: 'new-session' } })),
    ).resolves.toEqual(['new-session']);
    expect(JSON.parse(fs.readFileSync(legacy, 'utf-8'))).toMatchObject({
      pinnedOrder: ['new-session'],
    });

    await expect(
      pinnedHandler(request({ mutation: { kind: 'remove', entryId: 'new-session' } })),
    ).resolves.toEqual([]);
    await expect(
      pinnedHandler(request({ mutation: { kind: 'migrate-legacy', order: ['stale-session'] } })),
    ).resolves.toEqual([]);
    expect(JSON.parse(fs.readFileSync(legacy, 'utf-8'))).toEqual({ pinnedOrder: [] });
    expect(fs.existsSync(ownerFile())).toBe(false);
  });

  it('keeps a claim owner blocked for a non-regular root path', async () => {
    const legacy = path.join(harness.root, 'sidebar-settings.json');
    harness.legacyClaimReady = true;
    harness.legacyClaimedByOtherOwner = false;
    const originalLstatSync = fs.lstatSync.bind(fs);
    const lstatSync = vi.spyOn(fs, 'lstatSync').mockImplementation((file) => {
      if (file === legacy) return { isFile: () => false } as fs.Stats;
      return originalLstatSync(file);
    });

    try {
      expect(loadSnapshot().pinnedOrder).toEqual([]);
      await expect(
        pinnedHandler(request({ mutation: { kind: 'promote', entryId: 'new-session' } })),
      ).rejects.toThrow('[PRECONDITION_FAILED] sidebar settings owner claim is pending');
      expect(fs.existsSync(ownerFile())).toBe(false);
    } finally {
      lstatSync.mockRestore();
    }
  });

  it('does not replace an orphaned root backup for the claim owner', async () => {
    const backup = path.join(harness.root, 'sidebar-settings.json.bak');
    fs.writeFileSync(backup, '{"pinnedOrder":["recoverable-session"]}', 'utf-8');
    harness.legacyClaimReady = true;
    harness.legacyClaimedByOtherOwner = false;

    expect(loadSnapshot().pinnedOrder).toEqual([]);
    await expect(
      pinnedHandler(request({ mutation: { kind: 'promote', entryId: 'new-session' } })),
    ).rejects.toThrow('[PRECONDITION_FAILED] sidebar settings owner claim is pending');
    expect(fs.readFileSync(backup, 'utf-8')).toBe(
      '{"pinnedOrder":["recoverable-session"]}',
    );
    expect(fs.existsSync(path.join(harness.root, 'sidebar-settings.json'))).toBe(false);
  });

  it('fails closed when the shared legacy path cannot be inspected', async () => {
    const legacy = path.join(harness.root, 'sidebar-settings.json');
    harness.legacyClaimReady = true;
    harness.legacyClaimedByOtherOwner = false;
    const originalLstatSync = fs.lstatSync.bind(fs);
    const lstatSync = vi.spyOn(fs, 'lstatSync').mockImplementation((file) => {
      if (file === legacy) {
        throw Object.assign(new Error('private path detail'), { code: 'EACCES' });
      }
      return originalLstatSync(file);
    });

    try {
      expect(loadSnapshot().pinnedOrder).toEqual([]);
      await expect(
        pinnedHandler(request({ mutation: { kind: 'promote', entryId: 'new-session' } })),
      ).rejects.toThrow('[PRECONDITION_FAILED] sidebar settings owner claim is pending');
      expect(fs.existsSync(ownerFile())).toBe(false);
    } finally {
      lstatSync.mockRestore();
    }
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

  it('does not overwrite malformed scoped state when a mutation arrives', async () => {
    const legacy = path.join(harness.root, 'sidebar-settings.json');
    const legacyContents = '{"pinnedOrder":["legacy-session"]}';
    const malformed = '{"pinnedOrder":[private-sidebar-sentinel]}';
    fs.writeFileSync(legacy, legacyContents, 'utf-8');
    fs.mkdirSync(path.dirname(ownerFile()), { recursive: true });
    fs.writeFileSync(ownerFile(), malformed, 'utf-8');

    expect(loadSnapshot()).toMatchObject({ pinnedOrder: [], hiddenProjectKeys: [] });
    await expect(
      pinnedHandler(request({ mutation: { kind: 'promote', entryId: 'new-session' } })),
    ).rejects.toThrow('[INTERNAL] failed to persist sidebar settings');
    await expect(
      hiddenHandler(request({ projectKey: 'local:/workspace/new', hidden: true })),
    ).rejects.toThrow('[INTERNAL] failed to persist sidebar settings');
    expect(fs.readFileSync(ownerFile(), 'utf-8')).toBe(malformed);
    expect(fs.readFileSync(legacy, 'utf-8')).toBe(legacyContents);
    expect(harness.send).not.toHaveBeenCalled();

    fs.writeFileSync(
      ownerFile(),
      JSON.stringify({ pinnedOrder: ['repaired-session'], hiddenProjectKeys: [] }),
      'utf-8',
    );
    await expect(
      pinnedHandler(request({ mutation: { kind: 'promote', entryId: 'new-session' } })),
    ).resolves.toEqual(['new-session', 'repaired-session']);
    expect(fs.readFileSync(legacy, 'utf-8')).toBe(legacyContents);
  });

  it('keeps the claimed root authoritative over unreleased scoped residue', async () => {
    const legacy = path.join(harness.root, 'sidebar-settings.json');
    const legacyContents = JSON.stringify({
      pinnedOrder: ['legacy-session'],
      hiddenProjectKeys: ['local:/workspace/legacy'],
    });
    fs.writeFileSync(legacy, legacyContents, 'utf-8');
    fs.mkdirSync(path.dirname(ownerFile()), { recursive: true });
    fs.writeFileSync(
      ownerFile(),
      JSON.stringify({
        pinnedOrder: ['scoped-session'],
        hiddenProjectKeys: ['local:/workspace/scoped'],
      }),
      'utf-8',
    );
    harness.legacyClaimReady = true;
    harness.legacyClaimedByOtherOwner = false;

    expect(loadSnapshot()).toMatchObject({
      pinnedOrder: ['legacy-session'],
      hiddenProjectKeys: ['local:/workspace/legacy'],
    });
    await expect(
      pinnedHandler(request({ mutation: { kind: 'promote', entryId: 'new-session' } })),
    ).resolves.toEqual(['new-session', 'legacy-session']);
    expect(JSON.parse(fs.readFileSync(legacy, 'utf-8'))).toEqual({
      pinnedOrder: ['new-session', 'legacy-session'],
      hiddenProjectKeys: ['local:/workspace/legacy'],
    });
    expect(JSON.parse(fs.readFileSync(ownerFile(), 'utf-8'))).toEqual({
      pinnedOrder: ['scoped-session'],
      hiddenProjectKeys: ['local:/workspace/scoped'],
    });
  });

  it('keeps explicit empty scoped snapshots authoritative for a non-claim owner', async () => {
    const legacy = path.join(harness.root, 'sidebar-settings.json');
    const legacyContents = JSON.stringify({
      pinnedOrder: ['legacy-session'],
      hiddenProjectKeys: ['local:/workspace/legacy'],
    });
    fs.writeFileSync(legacy, legacyContents, 'utf-8');
    fs.mkdirSync(path.dirname(ownerFile()), { recursive: true });
    fs.writeFileSync(
      ownerFile(),
      JSON.stringify({
        pinnedOrder: ['scoped-session'],
        hiddenProjectKeys: ['local:/workspace/scoped'],
      }),
      'utf-8',
    );
    harness.legacyClaimReady = false;
    harness.legacyClaimedByOtherOwner = true;

    await pinnedHandler(request({ mutation: { kind: 'remove', entryId: 'scoped-session' } }));
    await hiddenHandler(request({ projectKey: 'local:/workspace/scoped', hidden: false }));
    expect(JSON.parse(fs.readFileSync(ownerFile(), 'utf-8'))).toEqual({
      pinnedOrder: [],
      hiddenProjectKeys: [],
    });

    fs.writeFileSync(ownerFile(), '{}', 'utf-8');
    harness.send.mockClear();
    harness.sendSecond.mockClear();
    await pinnedHandler(request({ mutation: { kind: 'migrate-legacy', order: [] } }));
    await hiddenHandler(request({ projectKey: 'local:/workspace/missing', hidden: false }));
    expect(JSON.parse(fs.readFileSync(ownerFile(), 'utf-8'))).toEqual({
      pinnedOrder: [],
      hiddenProjectKeys: [],
    });
    expect(harness.send).not.toHaveBeenCalled();
    expect(harness.sendSecond).not.toHaveBeenCalled();
    expect(fs.readFileSync(legacy, 'utf-8')).toBe(legacyContents);

    expect(loadSnapshot()).toMatchObject({ pinnedOrder: [], hiddenProjectKeys: [] });
    expect(fs.readFileSync(legacy, 'utf-8')).toBe(legacyContents);
  });

  it.each([['null'], ['[]'], ['42']] as const)(
    'ignores an invalid legacy root once scoped state exists: %s',
    async (invalidContents) => {
      const legacy = path.join(harness.root, 'sidebar-settings.json');
      const scopedContents = '{"pinnedOrder":["scoped-session"]}';
      fs.writeFileSync(legacy, invalidContents, 'utf-8');
      fs.mkdirSync(path.dirname(ownerFile()), { recursive: true });
      fs.writeFileSync(ownerFile(), scopedContents, 'utf-8');

      expect(loadSnapshot()).toMatchObject({
        pinnedOrder: ['scoped-session'],
        hiddenProjectKeys: [],
      });
      expect(fs.readFileSync(legacy, 'utf-8')).toBe(invalidContents);
      expect(fs.readFileSync(ownerFile(), 'utf-8')).toBe(scopedContents);
      await expect(
        pinnedHandler(request({ mutation: { kind: 'promote', entryId: 'new-session' } })),
      ).resolves.toEqual(['new-session', 'scoped-session']);
      expect(fs.readFileSync(legacy, 'utf-8')).toBe(invalidContents);
      expect(JSON.parse(fs.readFileSync(ownerFile(), 'utf-8'))).toMatchObject({
        pinnedOrder: ['new-session', 'scoped-session'],
      });
    },
  );

  it('does not fall back to legacy when scoped state is oversized', async () => {
    const legacy = path.join(harness.root, 'sidebar-settings.json');
    const legacyContents = '{"pinnedOrder":["legacy-session"]}';
    fs.writeFileSync(legacy, legacyContents, 'utf-8');
    fs.mkdirSync(path.dirname(ownerFile()), { recursive: true });
    fs.writeFileSync(ownerFile(), '');
    fs.truncateSync(ownerFile(), sidebarTesting.MAX_SETTINGS_BYTES + 1);
    const readFileSync = vi.spyOn(fs, 'readFileSync');

    try {
      expect(loadSnapshot()).toMatchObject({
        pinnedOrderIsAuthoritative: false,
        pinnedOrder: [],
        hiddenProjectKeys: [],
      });
      expect(readFileSync).not.toHaveBeenCalled();
      expect(fs.statSync(ownerFile()).size).toBe(sidebarTesting.MAX_SETTINGS_BYTES + 1);
      expect(fs.readFileSync(legacy, 'utf-8')).toBe(legacyContents);
      expect(harness.loggerWarn).toHaveBeenCalledWith(
        'sidebar settings read failed; falling back to defaults',
        { path: ownerFile() },
      );
      await expect(
        pinnedHandler(request({ mutation: { kind: 'promote', entryId: 'new-session' } })),
      ).rejects.toThrow('[INTERNAL] failed to persist sidebar settings');
    } finally {
      readFileSync.mockRestore();
    }
  });

  it.each(['cloud', 'local'] as const)(
    'blocks a non-regular scoped path for a %s owner',
    async (mode) => {
      if (mode === 'local') setSession('local', 'local-v1');
      const legacy = path.join(harness.root, 'sidebar-settings.json');
      const legacyContents = '{"pinnedOrder":["legacy-session"]}';
      fs.writeFileSync(legacy, legacyContents, 'utf-8');
      fs.mkdirSync(ownerFile(), { recursive: true });

      expect(loadSnapshot()).toMatchObject({
        pinnedOrderIsAuthoritative: false,
        pinnedOrder: [],
        hiddenProjectKeys: [],
      });
      await expect(
        pinnedHandler(request({ mutation: { kind: 'promote', entryId: 'new-session' } })),
      ).rejects.toThrow('[PRECONDITION_FAILED] sidebar settings owner claim is pending');
      expect(fs.lstatSync(ownerFile()).isDirectory()).toBe(true);
      expect(fs.readFileSync(legacy, 'utf-8')).toBe(legacyContents);
    },
  );

  it('fails closed when the scoped path cannot be inspected', async () => {
    const legacy = path.join(harness.root, 'sidebar-settings.json');
    const legacyContents = '{"pinnedOrder":["legacy-session"]}';
    fs.writeFileSync(legacy, legacyContents, 'utf-8');
    const scoped = ownerFile();
    const originalLstatSync = fs.lstatSync.bind(fs);
    const lstatSync = vi.spyOn(fs, 'lstatSync').mockImplementation((file) => {
      if (file === scoped) {
        throw Object.assign(new Error('private path detail'), { code: 'EACCES' });
      }
      return originalLstatSync(file);
    });

    try {
      expect(loadSnapshot()).toMatchObject({
        pinnedOrderIsAuthoritative: false,
        pinnedOrder: [],
        hiddenProjectKeys: [],
      });
      await expect(
        pinnedHandler(request({ mutation: { kind: 'promote', entryId: 'new-session' } })),
      ).rejects.toThrow('[PRECONDITION_FAILED] sidebar settings owner claim is pending');
      expect(fs.readFileSync(legacy, 'utf-8')).toBe(legacyContents);
      expect(fs.existsSync(scoped)).toBe(false);
    } finally {
      lstatSync.mockRestore();
    }
  });

  it.each(['cloud', 'local'] as const)(
    'keeps an orphaned scoped backup from being replaced for a %s owner',
    async (mode) => {
      if (mode === 'local') setSession('local', 'local-v1');
      const legacy = path.join(harness.root, 'sidebar-settings.json');
      const backup = `${ownerFile()}.bak`;
      const legacyContents = '{"pinnedOrder":["legacy-session"]}';
      const backupContents = '{"pinnedOrder":["backup-session"]}';
      fs.writeFileSync(legacy, legacyContents, 'utf-8');
      fs.mkdirSync(path.dirname(backup), { recursive: true });
      fs.writeFileSync(backup, backupContents, 'utf-8');
      harness.legacyClaimReady = false;
      harness.legacyClaimedByOtherOwner = true;

      expect(loadSnapshot()).toMatchObject({
        pinnedOrderIsAuthoritative: false,
        pinnedOrder: [],
        hiddenProjectKeys: [],
      });
      await expect(
        pinnedHandler(request({ mutation: { kind: 'promote', entryId: 'new-session' } })),
      ).rejects.toThrow('[PRECONDITION_FAILED] sidebar settings owner claim is pending');
      expect(fs.existsSync(ownerFile())).toBe(false);
      expect(fs.readFileSync(backup, 'utf-8')).toBe(backupContents);
      expect(fs.readFileSync(legacy, 'utf-8')).toBe(legacyContents);
    },
  );

  it('rejects a pinned mutation that exceeds the durable settings byte limit', async () => {
    const oversizedOrder = Array.from(
      { length: 1_100 },
      (_, index) => `${index}:${'x'.repeat(4_080)}`,
    );

    await expect(
      pinnedHandler(request({ mutation: { kind: 'migrate-legacy', order: oversizedOrder } })),
    ).rejects.toThrow('[INTERNAL] failed to persist sidebar settings');
    expect(fs.existsSync(ownerFile())).toBe(false);
    expect(harness.send).not.toHaveBeenCalled();
  });

  it('ignores an obsolete sidebar marker and follows the global owner claim', () => {
    const legacy = path.join(harness.root, 'sidebar-settings.json');
    const obsoleteMarker = path.join(harness.root, 'sidebar-settings-legacy-owner.v1.json');
    fs.writeFileSync(legacy, '{"pinnedOrder":["legacy"]}');
    fs.writeFileSync(obsoleteMarker, 'broken');
    harness.legacyClaimReady = true;
    harness.legacyClaimedByOtherOwner = false;

    expect(loadSnapshot().pinnedOrder).toEqual(['legacy']);
    expect(fs.existsSync(legacy)).toBe(true);
    expect(fs.readFileSync(obsoleteMarker, 'utf-8')).toBe('broken');
    expect(fs.existsSync(ownerFile())).toBe(false);
  });

  it('checks the trusted sender before accepting a mutation', async () => {
    harness.assertTrusted.mockImplementationOnce(() => {
      throw new Error('untrusted renderer');
    });

    await expect(
      pinnedHandler(request({ mutation: { kind: 'promote', entryId: 'session-a' } })),
    ).rejects.toThrow('untrusted renderer');
    expect(fs.existsSync(ownerFile())).toBe(false);
  });
});
