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
  boundaryPending: false,
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  listeners: new Map<string, (...args: unknown[]) => unknown>(),
  send: vi.fn(),
  sendSecond: vi.fn(),
  untrustedSend: vi.fn(),
  destroyedSend: vi.fn(),
  assertTrusted: vi.fn(),
  sharedLegacyExclusive: true,
  legacyClaimOwner: 'current' as 'current' | 'other' | 'missing',
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
  isAppSessionBoundaryPending: () => harness.boundaryPending,
  ownerScopedUserDataPath: (...parts: string[]) =>
    path.join(harness.root, 'owners', `key-${harness.session.dataOwnerId ?? 'none'}`, ...parts),
}));

vi.mock('../ownerNamespaceMigration.js', () => ({
  hasExclusiveSharedLegacyUserDataAccess: () =>
    process.env.XDT_PASSIVE_SHARED_USER_DATA !== '1' && harness.sharedLegacyExclusive,
  isLegacyOwnerNamespaceClaimOwnedBy: () => harness.legacyClaimOwner === 'current',
  isLegacyOwnerNamespaceClaimedByOtherOwner: () => harness.legacyClaimOwner === 'other',
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

async function mainViewHiddenHandler(payload: unknown): Promise<string[]> {
  const handler = harness.handlers.get('sidebar-settings:set-main-view-hidden');
  expect(handler).toBeDefined();
  return (await handler?.({}, payload)) as string[];
}

function loadSnapshot(): {
  dataOwnerId: string | null;
  ownerGeneration: number;
  pinnedOrderIsAuthoritative: boolean;
  pinnedOrder: string[];
  hiddenProjectKeys: string[];
  hiddenMainViewGhostIds: string[];
} {
  const listener = harness.listeners.get('sidebar-settings:load-snapshot-sync');
  const event: { returnValue?: ReturnType<typeof loadSnapshot> } = {};
  listener?.(event);
  return event.returnValue as ReturnType<typeof loadSnapshot>;
}

function claimLegacyRendererOwner(): {
  dataOwnerId: string | null;
  ownerGeneration: number;
  claimed: boolean;
  canInitialize: boolean;
  pinnedLegacyConsumed: boolean;
} {
  const listener = harness.listeners.get('sidebar-settings:claim-renderer-legacy-owner-sync');
  const event: { returnValue?: ReturnType<typeof claimLegacyRendererOwner> } = {};
  listener?.(event);
  return event.returnValue as ReturnType<typeof claimLegacyRendererOwner>;
}

describe('sidebarSettingsStore', () => {
  beforeEach(async () => {
    setPlatform('win32');
    harness.root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-sidebar-owner-state-'));
    harness.session = { mode: 'cloud', dataOwnerId: 'owner-a', generation: 1 };
    harness.boundaryPending = false;
    harness.handlers.clear();
    harness.listeners.clear();
    harness.send.mockReset();
    harness.sendSecond.mockReset();
    harness.untrustedSend.mockReset();
    harness.destroyedSend.mockReset();
    harness.assertTrusted.mockReset();
    harness.sharedLegacyExclusive = true;
    harness.legacyClaimOwner = 'current';
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
    await mainViewHiddenHandler(request({ ghostId: 'xd-sites', hidden: true }));
    expect(loadSnapshot()).toMatchObject({
      dataOwnerId: 'owner-a',
      pinnedOrder: ['project:local:/workspace/a', 'session-a'],
      hiddenProjectKeys: ['local:C:/workspace/alpha'],
      hiddenMainViewGhostIds: ['xd-sites'],
    });

    setSession('cloud', 'owner-b');
    harness.legacyClaimOwner = 'other';
    expect(loadSnapshot()).toMatchObject({
      dataOwnerId: 'owner-b',
      pinnedOrder: [],
      hiddenProjectKeys: [],
      hiddenMainViewGhostIds: [],
    });
    await pinnedHandler(request({ mutation: { kind: 'migrate-legacy', order: ['session-b'] } }));

    setSession('cloud', 'owner-a');
    harness.legacyClaimOwner = 'current';
    expect(loadSnapshot()).toMatchObject({
      dataOwnerId: 'owner-a',
      pinnedOrder: ['project:local:/workspace/a', 'session-a'],
      hiddenProjectKeys: ['local:C:/workspace/alpha'],
      hiddenMainViewGhostIds: ['xd-sites'],
    });
    expect(JSON.parse(fs.readFileSync(ownerFile('owner-b'), 'utf-8'))).toMatchObject({
      pinnedOrder: ['session-b'],
    });
  });

  it('atomically gives the shared Renderer legacy namespace to one owner', () => {
    expect(claimLegacyRendererOwner()).toEqual({
      dataOwnerId: 'owner-a',
      ownerGeneration: 1,
      claimed: true,
      canInitialize: true,
      pinnedLegacyConsumed: false,
    });
    const markerPath = path.join(harness.root, sidebarTesting.LEGACY_RENDERER_OWNER_MARKER_FILE);
    expect(JSON.parse(fs.readFileSync(markerPath, 'utf-8'))).toEqual({
      version: 1,
      ownerKey: 'key-owner-a',
      pinnedLegacyConsumed: false,
    });

    setSession('cloud', 'owner-b');
    expect(claimLegacyRendererOwner()).toMatchObject({
      dataOwnerId: 'owner-b',
      claimed: false,
      pinnedLegacyConsumed: false,
    });

    setSession('cloud', 'owner-a');
    expect(claimLegacyRendererOwner()).toMatchObject({
      dataOwnerId: 'owner-a',
      claimed: true,
    });
  });

  it('allows a stable local owner to claim Renderer legacy state without a cloud claim', () => {
    setSession('local', 'local-v1');
    harness.legacyClaimOwner = 'missing';

    expect(claimLegacyRendererOwner()).toMatchObject({
      dataOwnerId: 'local-v1',
      claimed: true,
    });
  });

  it('durably records that Main consumed legacy Renderer pins', async () => {
    expect(claimLegacyRendererOwner()).toMatchObject({
      claimed: true,
      pinnedLegacyConsumed: false,
    });

    await pinnedHandler(
      request({ mutation: { kind: 'migrate-legacy', order: ['legacy-session'] } }),
    );

    expect(claimLegacyRendererOwner()).toMatchObject({
      claimed: true,
      pinnedLegacyConsumed: true,
    });
    const markerPath = path.join(harness.root, sidebarTesting.LEGACY_RENDERER_OWNER_MARKER_FILE);
    expect(JSON.parse(fs.readFileSync(markerPath, 'utf-8'))).toMatchObject({
      ownerKey: 'key-owner-a',
      pinnedLegacyConsumed: true,
    });

    fs.unlinkSync(ownerFile());
    expect(claimLegacyRendererOwner()).toMatchObject({
      claimed: true,
      pinnedLegacyConsumed: true,
    });
  });

  it('treats copied explicit empty root pins as authoritative without removing the root', () => {
    const legacy = path.join(harness.root, 'sidebar-settings.json');
    const legacyContents = '{"pinnedOrder":[],"hiddenProjectKeys":[]}';
    fs.writeFileSync(legacy, legacyContents, 'utf-8');

    expect(claimLegacyRendererOwner()).toMatchObject({
      claimed: true,
      pinnedLegacyConsumed: true,
    });
    expect(fs.readFileSync(legacy, 'utf-8')).toBe(legacyContents);
    expect(fs.readFileSync(ownerFile(), 'utf-8')).toBe(legacyContents);
  });

  it('restores the Renderer legacy owner marker from its atomic backup', () => {
    const markerPath = path.join(harness.root, sidebarTesting.LEGACY_RENDERER_OWNER_MARKER_FILE);
    fs.writeFileSync(
      `${markerPath}.bak`,
      JSON.stringify({
        version: 1,
        ownerKey: 'key-owner-a',
        pinnedLegacyConsumed: true,
      }),
      'utf-8',
    );

    expect(claimLegacyRendererOwner()).toMatchObject({
      claimed: true,
      pinnedLegacyConsumed: true,
    });
    expect(fs.existsSync(markerPath)).toBe(true);
    expect(fs.existsSync(`${markerPath}.bak`)).toBe(false);
  });

  it('reads but never mutates the Renderer legacy marker in passive shared-userData mode', () => {
    const previous = process.env.XDT_PASSIVE_SHARED_USER_DATA;
    const markerPath = path.join(harness.root, sidebarTesting.LEGACY_RENDERER_OWNER_MARKER_FILE);
    const backupPath = `${markerPath}.bak`;
    try {
      fs.writeFileSync(
        backupPath,
        JSON.stringify({
          version: 1,
          ownerKey: 'key-owner-a',
          pinnedLegacyConsumed: true,
        }),
        'utf-8',
      );
      process.env.XDT_PASSIVE_SHARED_USER_DATA = '1';
      expect(claimLegacyRendererOwner()).toMatchObject({
        claimed: true,
        canInitialize: false,
        pinnedLegacyConsumed: true,
      });
      expect(fs.existsSync(markerPath)).toBe(false);
      expect(fs.existsSync(backupPath)).toBe(true);

      delete process.env.XDT_PASSIVE_SHARED_USER_DATA;
      expect(claimLegacyRendererOwner()).toMatchObject({
        claimed: true,
        canInitialize: true,
      });

      process.env.XDT_PASSIVE_SHARED_USER_DATA = '1';
      expect(claimLegacyRendererOwner()).toMatchObject({
        claimed: true,
        canInitialize: false,
      });
      expect(fs.existsSync(markerPath)).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.XDT_PASSIVE_SHARED_USER_DATA;
      else process.env.XDT_PASSIVE_SHARED_USER_DATA = previous;
    }
  });

  it('does not touch the Renderer legacy marker while another instance may be live', () => {
    const markerPath = path.join(harness.root, sidebarTesting.LEGACY_RENDERER_OWNER_MARKER_FILE);

    harness.sharedLegacyExclusive = false;
    expect(claimLegacyRendererOwner()).toMatchObject({
      claimed: false,
      canInitialize: false,
    });
    expect(fs.existsSync(markerPath)).toBe(false);

    harness.sharedLegacyExclusive = true;
    expect(claimLegacyRendererOwner()).toMatchObject({
      claimed: true,
      canInitialize: true,
    });
    const markerBeforePeer = fs.readFileSync(markerPath, 'utf-8');

    harness.sharedLegacyExclusive = false;
    fs.mkdirSync(path.dirname(ownerFile()), { recursive: true });
    fs.writeFileSync(ownerFile(), JSON.stringify({ pinnedOrder: [] }), 'utf-8');
    expect(claimLegacyRendererOwner()).toMatchObject({
      claimed: true,
      canInitialize: false,
    });
    expect(fs.readFileSync(markerPath, 'utf-8')).toBe(markerBeforePeer);
  });

  it('does not claim the Renderer legacy namespace during an owner boundary', () => {
    harness.boundaryPending = true;
    const markerPath = path.join(harness.root, sidebarTesting.LEGACY_RENDERER_OWNER_MARKER_FILE);

    expect(claimLegacyRendererOwner()).toMatchObject({ claimed: false });
    expect(fs.existsSync(markerPath)).toBe(false);
  });

  it('rejects an untrusted Renderer before touching the legacy owner marker', () => {
    harness.assertTrusted.mockImplementationOnce(() => {
      throw new Error('untrusted renderer');
    });
    const markerPath = path.join(harness.root, sidebarTesting.LEGACY_RENDERER_OWNER_MARKER_FILE);

    expect(() => claimLegacyRendererOwner()).toThrow('untrusted renderer');
    expect(fs.existsSync(markerPath)).toBe(false);
  });

  it('fails closed when the Renderer legacy owner marker is malformed', () => {
    const markerPath = path.join(harness.root, sidebarTesting.LEGACY_RENDERER_OWNER_MARKER_FILE);
    fs.writeFileSync(markerPath, '{broken', 'utf-8');

    expect(claimLegacyRendererOwner()).toMatchObject({
      claimed: false,
      pinnedLegacyConsumed: false,
    });
    expect(fs.readFileSync(markerPath, 'utf-8')).toBe('{broken');
  });

  it('rejects an oversized Renderer legacy owner marker before reading it', () => {
    const markerPath = path.join(harness.root, sidebarTesting.LEGACY_RENDERER_OWNER_MARKER_FILE);
    fs.writeFileSync(
      markerPath,
      'x'.repeat(sidebarTesting.MAX_LEGACY_RENDERER_OWNER_MARKER_BYTES + 1),
      'utf-8',
    );
    const readFileSync = vi.spyOn(fs, 'readFileSync');

    try {
      expect(claimLegacyRendererOwner()).toMatchObject({
        claimed: false,
        canInitialize: false,
      });
      expect(readFileSync.mock.calls.some(([file]) => file === markerPath)).toBe(false);
    } finally {
      readFileSync.mockRestore();
    }
  });

  it('does not publish a partial Renderer legacy owner marker', () => {
    fs.mkdirSync(path.dirname(ownerFile()), { recursive: true });
    fs.writeFileSync(ownerFile(), '{}', 'utf-8');
    const markerPath = path.join(harness.root, sidebarTesting.LEGACY_RENDERER_OWNER_MARKER_FILE);
    const originalLinkSync = fs.linkSync.bind(fs);
    const linkSync = vi.spyOn(fs, 'linkSync').mockImplementation((from, to) => {
      if (to === markerPath) throw Object.assign(new Error('link failed'), { code: 'EIO' });
      return originalLinkSync(from, to);
    });

    try {
      expect(claimLegacyRendererOwner()).toMatchObject({ claimed: false });
      expect(fs.existsSync(markerPath)).toBe(false);
      expect(
        fs
          .readdirSync(harness.root)
          .filter((entry) => entry.startsWith(`${path.basename(markerPath)}.init-`)),
      ).toEqual([]);
    } finally {
      linkSync.mockRestore();
    }
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
    harness.legacyClaimOwner = 'other';
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
    expect(fs.readFileSync(file, 'utf-8')).toBe('{}');
    expect(fs.existsSync(ownerFile('owner-b'))).toBe(false);
    expect(harness.send).not.toHaveBeenCalled();
  });

  it('keeps initialized scoped access after the instance becomes passive', async () => {
    const file = ownerFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      `${file}.lock`,
      JSON.stringify({ pid: process.pid, startedAt: Date.now() }),
      'utf-8',
    );

    const writing = pinnedHandler(request({ mutation: { kind: 'promote', entryId: 'session-a' } }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    harness.sharedLegacyExclusive = false;
    fs.unlinkSync(`${file}.lock`);

    await expect(writing).resolves.toEqual(['session-a']);
    expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toEqual({
      pinnedOrder: ['session-a'],
    });
    expect(harness.send).toHaveBeenCalled();
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

  it('merges main-view visibility writes and broadcasts the durable snapshot', async () => {
    await expect(
      mainViewHiddenHandler(request({ ghostId: 'xd-sites', hidden: true })),
    ).resolves.toEqual(['xd-sites']);
    await expect(
      mainViewHiddenHandler(request({ ghostId: 'workspace-tools', hidden: true })),
    ).resolves.toEqual(['xd-sites', 'workspace-tools']);

    expect(loadSnapshot().hiddenMainViewGhostIds).toEqual(['xd-sites', 'workspace-tools']);
    const stamp = { dataOwnerId: 'owner-a', ownerGeneration: 1 };
    expect(harness.send).toHaveBeenLastCalledWith(
      'sidebar-settings:hidden-main-view-ghost-ids-changed',
      ['xd-sites', 'workspace-tools'],
      stamp,
    );
    expect(harness.sendSecond).toHaveBeenLastCalledWith(
      'sidebar-settings:hidden-main-view-ghost-ids-changed',
      ['xd-sites', 'workspace-tools'],
      stamp,
    );
    expect(harness.untrustedSend).not.toHaveBeenCalled();
    expect(harness.destroyedSend).not.toHaveBeenCalled();
  });

  it('removes the hidden main-view override while preserving the scoped tombstone', async () => {
    await mainViewHiddenHandler(request({ ghostId: 'xd-sites', hidden: true }));
    harness.send.mockClear();
    harness.sendSecond.mockClear();

    await expect(
      mainViewHiddenHandler(request({ ghostId: 'xd-sites', hidden: false })),
    ).resolves.toEqual([]);
    expect(loadSnapshot().hiddenMainViewGhostIds).toEqual([]);
    expect(JSON.parse(fs.readFileSync(ownerFile(), 'utf-8'))).toMatchObject({
      hiddenMainViewGhostIds: [],
    });
    expect(harness.send).toHaveBeenCalledWith(
      'sidebar-settings:hidden-main-view-ghost-ids-changed',
      [],
      { dataOwnerId: 'owner-a', ownerGeneration: 1 },
    );
  });

  it('rejects malformed and stale main-view visibility mutations', async () => {
    await expect(
      mainViewHiddenHandler(request({ ghostId: 'XD Sites', hidden: true })),
    ).rejects.toThrow('[INVALID_PARAMS] invalid main-view plugin id');
    await expect(
      mainViewHiddenHandler(request({ ghostId: 'xd-sites', hidden: 'yes' })),
    ).rejects.toThrow('[INVALID_PARAMS] invalid main-view hidden state');

    const staleRequest = request({ ghostId: 'xd-sites', hidden: true });
    setSession('cloud', 'owner-b');
    await expect(mainViewHiddenHandler(staleRequest)).rejects.toThrow('[PRECONDITION_FAILED]');
    expect(fs.existsSync(ownerFile('owner-a'))).toBe(false);
    expect(fs.existsSync(ownerFile('owner-b'))).toBe(false);
    expect(harness.send).not.toHaveBeenCalled();
  });

  it('drops a queued main-view write when the same owner advances generation', async () => {
    const file = ownerFile('owner-a');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      `${file}.lock`,
      JSON.stringify({ pid: process.pid, startedAt: Date.now() }),
      'utf-8',
    );

    const writing = mainViewHiddenHandler(
      request({ ghostId: 'xd-sites', hidden: true }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    setSession('cloud', 'owner-a');
    fs.unlinkSync(`${file}.lock`);

    await expect(writing).rejects.toThrow('[PRECONDITION_FAILED]');
    expect(fs.readFileSync(file, 'utf-8')).toBe('{}');
    expect(harness.send).not.toHaveBeenCalled();
    expect(harness.sendSecond).not.toHaveBeenCalled();
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

  it('persists an empty legacy migration as an authoritative scoped snapshot', async () => {
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
    fs.unlinkSync(file);
    fs.writeFileSync(backup, '{"pinnedOrder":["backup-session"]}', 'utf-8');
    fs.unlinkSync(`${file}.lock`);

    await expect(migrating).rejects.toThrow(
      '[PRECONDITION_FAILED] sidebar settings migration is pending',
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

  it('copies legacy state only to the first cloud owner while later owners remain writable', async () => {
    const legacy = path.join(harness.root, 'sidebar-settings.json');
    const legacySettings = { pinnedOrder: ['legacy-session'], hiddenProjectKeys: [] };
    fs.writeFileSync(legacy, JSON.stringify(legacySettings), 'utf-8');

    setSession('local', 'local-v1');
    expect(loadSnapshot().pinnedOrder).toEqual([]);
    expect(fs.existsSync(legacy)).toBe(true);

    setSession('cloud', 'owner-a');
    expect(loadSnapshot().pinnedOrder).toEqual(['legacy-session']);
    expect(JSON.parse(fs.readFileSync(legacy, 'utf-8'))).toEqual(legacySettings);

    setSession('cloud', 'owner-b');
    harness.legacyClaimOwner = 'other';
    expect(loadSnapshot().pinnedOrder).toEqual([]);
    await expect(
      pinnedHandler(request({ mutation: { kind: 'promote', entryId: 'owner-b-session' } })),
    ).resolves.toEqual(['owner-b-session']);
    expect(JSON.parse(fs.readFileSync(ownerFile('owner-b'), 'utf-8'))).toMatchObject({
      pinnedOrder: ['owner-b-session'],
    });
  });

  it('records an empty first migration before a parent release recreates the root file', () => {
    const legacy = path.join(harness.root, 'sidebar-settings.json');

    expect(loadSnapshot()).toMatchObject({
      pinnedOrderIsAuthoritative: false,
      pinnedOrder: [],
      hiddenProjectKeys: [],
    });
    expect(fs.readFileSync(ownerFile(), 'utf-8')).toBe('{}');

    const parentState = {
      pinnedOrder: ['changed-by-parent-release'],
      hiddenProjectKeys: ['local:/workspace/from-parent'],
    };
    fs.writeFileSync(legacy, JSON.stringify(parentState), 'utf-8');

    expect(loadSnapshot()).toMatchObject({ pinnedOrder: [], hiddenProjectKeys: [] });
    expect(JSON.parse(fs.readFileSync(legacy, 'utf-8'))).toEqual(parentState);
    expect(fs.readFileSync(ownerFile(), 'utf-8')).toBe('{}');
  });

  it('does not publish a partial scoped initialization file', async () => {
    const legacy = path.join(harness.root, 'sidebar-settings.json');
    const legacyContents = '{"pinnedOrder":["legacy-session"]}';
    fs.writeFileSync(legacy, legacyContents, 'utf-8');
    const linkSync = vi.spyOn(fs, 'linkSync').mockImplementation(() => {
      throw Object.assign(new Error('link failed'), { code: 'EIO' });
    });

    try {
      expect(loadSnapshot()).toMatchObject({ pinnedOrder: [], hiddenProjectKeys: [] });
      expect(fs.existsSync(ownerFile())).toBe(false);
      expect(
        fs
          .readdirSync(path.dirname(ownerFile()))
          .filter((entry) => entry.startsWith('sidebar-settings.json.init-')),
      ).toEqual([]);
      await expect(
        pinnedHandler(request({ mutation: { kind: 'promote', entryId: 'new-session' } })),
      ).rejects.toThrow('[PRECONDITION_FAILED] sidebar settings migration is pending');
      expect(fs.existsSync(ownerFile())).toBe(false);
      expect(fs.readFileSync(legacy, 'utf-8')).toBe(legacyContents);
    } finally {
      linkSync.mockRestore();
    }
  });

  it.each(['{broken', '[]', 'null'])(
    'does not publish an invalid legacy root into scoped state: %s',
    async (legacyContents) => {
      const legacy = path.join(harness.root, 'sidebar-settings.json');
      fs.writeFileSync(legacy, legacyContents, 'utf-8');

      expect(loadSnapshot()).toMatchObject({ pinnedOrder: [], hiddenProjectKeys: [] });
      expect(fs.existsSync(ownerFile())).toBe(false);
      expect(fs.readFileSync(legacy, 'utf-8')).toBe(legacyContents);
      await expect(
        pinnedHandler(request({ mutation: { kind: 'promote', entryId: 'new-session' } })),
      ).rejects.toThrow('[PRECONDITION_FAILED] sidebar settings migration is pending');
    },
  );

  it('does not read or publish an oversized legacy root', () => {
    const legacy = path.join(harness.root, 'sidebar-settings.json');
    fs.writeFileSync(legacy, '', 'utf-8');
    fs.truncateSync(legacy, sidebarTesting.MAX_SETTINGS_BYTES + 1);
    const readFileSync = vi.spyOn(fs, 'readFileSync');

    try {
      expect(loadSnapshot()).toMatchObject({ pinnedOrder: [], hiddenProjectKeys: [] });
      expect(readFileSync.mock.calls.some(([file]) => file === legacy)).toBe(false);
      expect(fs.existsSync(ownerFile())).toBe(false);
      expect(fs.statSync(legacy).size).toBe(sidebarTesting.MAX_SETTINGS_BYTES + 1);
    } finally {
      readFileSync.mockRestore();
    }
  });

  it('does not import unowned writes recreated by a parent release after migration', async () => {
    const legacy = path.join(harness.root, 'sidebar-settings.json');
    fs.writeFileSync(
      legacy,
      JSON.stringify({ pinnedOrder: ['legacy-session'], hiddenProjectKeys: [] }),
      'utf-8',
    );

    expect(loadSnapshot().pinnedOrder).toEqual(['legacy-session']);
    await expect(
      pinnedHandler(request({ mutation: { kind: 'promote', entryId: 'owner-a-session' } })),
    ).resolves.toEqual(['owner-a-session', 'legacy-session']);

    // The parent release has one global, unowned slot. Recreating it after a
    // downgrade must not override or contaminate either owner's scoped state.
    const parentState = {
      pinnedOrder: ['changed-by-parent-release'],
      hiddenProjectKeys: ['local:/workspace/from-parent'],
    };
    fs.writeFileSync(legacy, JSON.stringify(parentState), 'utf-8');
    expect(loadSnapshot()).toMatchObject({
      pinnedOrder: ['owner-a-session', 'legacy-session'],
      hiddenProjectKeys: [],
    });

    setSession('cloud', 'owner-b');
    harness.legacyClaimOwner = 'other';
    expect(loadSnapshot()).toMatchObject({ pinnedOrder: [], hiddenProjectKeys: [] });
    await expect(
      pinnedHandler(request({ mutation: { kind: 'promote', entryId: 'owner-b-session' } })),
    ).resolves.toEqual(['owner-b-session']);
    expect(JSON.parse(fs.readFileSync(legacy, 'utf-8'))).toEqual(parentState);
  });

  it('defers scoped writes until the active owner can claim legacy sidebar state', async () => {
    const legacy = path.join(harness.root, 'sidebar-settings.json');
    const legacySettings = {
      pinnedOrder: ['legacy-session'],
      hiddenProjectKeys: ['local:/workspace/legacy'],
    };
    fs.writeFileSync(legacy, JSON.stringify(legacySettings), 'utf-8');
    harness.legacyClaimOwner = 'missing';

    expect(loadSnapshot()).toMatchObject({
      pinnedOrderIsAuthoritative: false,
      pinnedOrder: [],
      hiddenProjectKeys: [],
    });
    expect(fs.existsSync(ownerFile())).toBe(false);
    await expect(
      pinnedHandler(request({ mutation: { kind: 'promote', entryId: 'new-session' } })),
    ).rejects.toThrow('[PRECONDITION_FAILED] sidebar settings migration is pending');
    expect(JSON.parse(fs.readFileSync(legacy, 'utf-8'))).toEqual(legacySettings);
    expect(fs.existsSync(ownerFile())).toBe(false);

    harness.legacyClaimOwner = 'current';
    expect(loadSnapshot()).toMatchObject(legacySettings);
    expect(JSON.parse(fs.readFileSync(legacy, 'utf-8'))).toEqual(legacySettings);
    await expect(
      pinnedHandler(request({ mutation: { kind: 'promote', entryId: 'new-session' } })),
    ).resolves.toEqual(['new-session', 'legacy-session']);
  });

  it('copies a readable root for an exclusive partial claim owned by the current owner', () => {
    const legacy = path.join(harness.root, 'sidebar-settings.json');
    const legacyContents = '{"pinnedOrder":["legacy-session"]}';
    fs.writeFileSync(legacy, legacyContents, 'utf-8');
    harness.legacyClaimOwner = 'current';

    expect(loadSnapshot().pinnedOrder).toEqual(['legacy-session']);
    expect(fs.readFileSync(legacy, 'utf-8')).toBe(legacyContents);
    expect(fs.readFileSync(ownerFile(), 'utf-8')).toBe(legacyContents);
  });

  it('lets another owner use scoped state without consuming a foreign legacy file', async () => {
    const legacy = path.join(harness.root, 'sidebar-settings.json');
    fs.writeFileSync(legacy, JSON.stringify({ pinnedOrder: ['foreign-legacy'] }), 'utf-8');
    harness.legacyClaimOwner = 'other';

    expect(loadSnapshot().pinnedOrder).toEqual([]);
    await expect(
      pinnedHandler(request({ mutation: { kind: 'promote', entryId: 'owner-session' } })),
    ).resolves.toEqual(['owner-session']);
    expect(fs.existsSync(legacy)).toBe(true);
    expect(JSON.parse(fs.readFileSync(ownerFile(), 'utf-8'))).toMatchObject({
      pinnedOrder: ['owner-session'],
    });
  });

  it('lets a passive same-owner instance use fully migrated scoped state', async () => {
    fs.mkdirSync(path.dirname(ownerFile()), { recursive: true });
    fs.writeFileSync(
      ownerFile(),
      JSON.stringify({ pinnedOrder: ['scoped-session'], hiddenProjectKeys: [] }),
      'utf-8',
    );
    harness.legacyClaimOwner = 'current';
    harness.sharedLegacyExclusive = false;

    expect(loadSnapshot().pinnedOrder).toEqual(['scoped-session']);
    await expect(
      pinnedHandler(request({ mutation: { kind: 'promote', entryId: 'new-session' } })),
    ).resolves.toEqual(['new-session', 'scoped-session']);
    await expect(
      hiddenHandler(request({ projectKey: 'local:/workspace/passive', hidden: true })),
    ).resolves.toBe(true);
    expect(JSON.parse(fs.readFileSync(ownerFile(), 'utf-8'))).toMatchObject({
      pinnedOrder: ['new-session', 'scoped-session'],
      hiddenProjectKeys: ['local:/workspace/passive'],
    });
  });

  it('uses scoped state after the current owner already initialized the sidebar file', async () => {
    fs.mkdirSync(path.dirname(ownerFile()), { recursive: true });
    fs.writeFileSync(
      ownerFile(),
      JSON.stringify({ pinnedOrder: ['scoped-session'], hiddenProjectKeys: [] }),
      'utf-8',
    );
    harness.legacyClaimOwner = 'current';

    expect(loadSnapshot().pinnedOrder).toEqual(['scoped-session']);
    await expect(
      pinnedHandler(request({ mutation: { kind: 'promote', entryId: 'new-session' } })),
    ).resolves.toEqual(['new-session', 'scoped-session']);
    await expect(
      hiddenHandler(request({ projectKey: 'local:/workspace/partial', hidden: true })),
    ).resolves.toBe(true);
    expect(JSON.parse(fs.readFileSync(ownerFile(), 'utf-8'))).toMatchObject({
      pinnedOrder: ['new-session', 'scoped-session'],
      hiddenProjectKeys: ['local:/workspace/partial'],
    });
  });

  it('keeps a passive same-owner instance blocked while shared legacy state remains', async () => {
    const legacy = path.join(harness.root, 'sidebar-settings.json');
    fs.writeFileSync(legacy, JSON.stringify({ pinnedOrder: ['legacy-session'] }), 'utf-8');
    harness.legacyClaimOwner = 'current';
    harness.sharedLegacyExclusive = false;

    expect(loadSnapshot().pinnedOrder).toEqual([]);
    await expect(
      pinnedHandler(request({ mutation: { kind: 'promote', entryId: 'new-session' } })),
    ).rejects.toThrow('[PRECONDITION_FAILED] sidebar settings migration is pending');
    expect(JSON.parse(fs.readFileSync(legacy, 'utf-8'))).toEqual({
      pinnedOrder: ['legacy-session'],
    });
    expect(fs.existsSync(ownerFile())).toBe(false);
  });

  it('keeps a passive same-owner instance blocked while the root is temporarily missing', async () => {
    harness.legacyClaimOwner = 'current';
    harness.sharedLegacyExclusive = false;

    expect(loadSnapshot()).toMatchObject({ pinnedOrder: [], hiddenProjectKeys: [] });
    expect(fs.existsSync(ownerFile())).toBe(false);
    await expect(
      pinnedHandler(request({ mutation: { kind: 'promote', entryId: 'new-session' } })),
    ).rejects.toThrow('[PRECONDITION_FAILED] sidebar settings migration is pending');
    expect(fs.existsSync(ownerFile())).toBe(false);
  });

  it('treats a dangling shared legacy symlink as present in passive mode', async () => {
    const legacy = path.join(harness.root, 'sidebar-settings.json');
    harness.legacyClaimOwner = 'current';
    harness.sharedLegacyExclusive = false;
    const originalLstatSync = fs.lstatSync.bind(fs);
    const lstatSync = vi.spyOn(fs, 'lstatSync').mockImplementation((file) => {
      if (file === legacy) return { isFile: () => false } as fs.Stats;
      return originalLstatSync(file);
    });

    try {
      expect(loadSnapshot().pinnedOrder).toEqual([]);
      await expect(
        pinnedHandler(request({ mutation: { kind: 'promote', entryId: 'new-session' } })),
      ).rejects.toThrow('[PRECONDITION_FAILED] sidebar settings migration is pending');
      expect(fs.existsSync(ownerFile())).toBe(false);
    } finally {
      lstatSync.mockRestore();
    }
  });

  it('does not replace an orphaned root backup while legacy migration is pending', async () => {
    const backup = path.join(harness.root, 'sidebar-settings.json.bak');
    const backupContents = '{"pinnedOrder":["recoverable-session"]}';
    fs.writeFileSync(backup, backupContents, 'utf-8');

    expect(loadSnapshot().pinnedOrder).toEqual([]);
    await expect(
      pinnedHandler(request({ mutation: { kind: 'promote', entryId: 'new-session' } })),
    ).rejects.toThrow('[PRECONDITION_FAILED] sidebar settings migration is pending');
    expect(fs.readFileSync(backup, 'utf-8')).toBe(backupContents);
    expect(fs.existsSync(ownerFile())).toBe(false);
  });

  it('fails closed when the shared legacy path cannot be inspected', async () => {
    const legacy = path.join(harness.root, 'sidebar-settings.json');
    harness.legacyClaimOwner = 'current';
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
      ).rejects.toThrow('[PRECONDITION_FAILED] sidebar settings migration is pending');
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

  it('keeps scoped state authoritative and preserves conflicting legacy bytes', async () => {
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
    harness.legacyClaimOwner = 'current';

    expect(loadSnapshot()).toMatchObject({
      pinnedOrder: ['scoped-session'],
      hiddenProjectKeys: ['local:/workspace/scoped'],
    });
    expect(fs.readFileSync(legacy, 'utf-8')).toBe(legacyContents);
    await expect(
      pinnedHandler(request({ mutation: { kind: 'promote', entryId: 'new-session' } })),
    ).resolves.toEqual(['new-session', 'scoped-session']);
    expect(JSON.parse(fs.readFileSync(ownerFile(), 'utf-8'))).toMatchObject({
      pinnedOrder: ['new-session', 'scoped-session'],
      hiddenProjectKeys: ['local:/workspace/scoped'],
    });
    expect(fs.readFileSync(legacy, 'utf-8')).toBe(legacyContents);
  });

  it('keeps explicit empty scoped snapshots authoritative for clears and no-ops', async () => {
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
    harness.legacyClaimOwner = 'current';

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
      ).rejects.toThrow('[PRECONDITION_FAILED] sidebar settings migration is pending');
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
      ).rejects.toThrow('[PRECONDITION_FAILED] sidebar settings migration is pending');
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
      harness.legacyClaimOwner = 'other';

      expect(loadSnapshot()).toMatchObject({
        pinnedOrderIsAuthoritative: false,
        pinnedOrder: [],
        hiddenProjectKeys: [],
      });
      await expect(
        pinnedHandler(request({ mutation: { kind: 'promote', entryId: 'new-session' } })),
      ).rejects.toThrow('[PRECONDITION_FAILED] sidebar settings migration is pending');
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
    expect(fs.readFileSync(ownerFile(), 'utf-8')).toBe('{}');
    expect(harness.send).not.toHaveBeenCalled();
  });

  it('ignores an obsolete sidebar marker and follows the global owner claim', () => {
    const legacy = path.join(harness.root, 'sidebar-settings.json');
    const obsoleteMarker = path.join(harness.root, 'sidebar-settings-legacy-owner.v1.json');
    fs.writeFileSync(legacy, '{"pinnedOrder":["legacy"]}');
    fs.writeFileSync(obsoleteMarker, 'broken');

    expect(loadSnapshot().pinnedOrder).toEqual(['legacy']);
    expect(fs.readFileSync(legacy, 'utf-8')).toBe('{"pinnedOrder":["legacy"]}');
    expect(fs.readFileSync(obsoleteMarker, 'utf-8')).toBe('broken');
    expect(JSON.parse(fs.readFileSync(ownerFile(), 'utf-8'))).toMatchObject({
      pinnedOrder: ['legacy'],
    });
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
