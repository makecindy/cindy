import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => {
  let nextWebContentsId = 1;
  type RegisteredSession = {
    permissionRequest: ReturnType<typeof vi.fn>;
    permissionCheck: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    beforeRequest: ReturnType<typeof vi.fn>;
    protocolHandle: ReturnType<typeof vi.fn>;
    downloadHandler?: (event: { preventDefault(): void }) => void;
  };
  const sessions = new Map<string, RegisteredSession>();
  return {
    activeOwner: {
      mode: 'cloud' as 'signed-out' | 'local' | 'cloud',
      dataOwnerId: 'owner-a' as string | null,
      generation: 1,
    },
    sessions,
    fromPartition: vi.fn((partition: string) => {
      const existing = sessions.get(partition);
      if (existing) return existing;
      const created: RegisteredSession = {
        permissionRequest: vi.fn(),
        permissionCheck: vi.fn(),
        on: vi.fn((event: string, handler: (event: { preventDefault(): void }) => void) => {
          if (event === 'will-download') created.downloadHandler = handler;
        }),
        beforeRequest: vi.fn(),
        protocolHandle: vi.fn(),
      };
      sessions.set(partition, created);
      return {
        setPermissionRequestHandler: created.permissionRequest,
        setPermissionCheckHandler: created.permissionCheck,
        on: created.on,
        webRequest: { onBeforeRequest: created.beforeRequest },
        protocol: { handle: created.protocolHandle },
      };
    }),
    browserWindowOptions: [] as Array<Record<string, unknown>>,
    BrowserWindow: vi.fn(function BrowserWindow(options: Record<string, unknown>) {
      harness.browserWindowOptions.push(options);
      return {
        webContents: {
          id: nextWebContentsId++,
          on: vi.fn(),
          isDestroyed: vi.fn(() => false),
          forcefullyCrashRenderer: vi.fn(),
        },
        loadURL: vi.fn().mockResolvedValue(undefined),
        isDestroyed: vi.fn(() => false),
        destroy: vi.fn(),
      };
    }),
  };
});

vi.mock('electron', () => ({
  BrowserWindow: harness.BrowserWindow,
  session: { fromPartition: harness.fromPartition },
  webContents: { fromId: vi.fn(() => null) },
}));

vi.mock('node:fs', () => ({ createReadStream: vi.fn() }));
vi.mock('node:fs/promises', () => ({
  default: {
    readFile: vi.fn(),
    stat: vi.fn().mockResolvedValue({ isFile: () => true, size: 0 }),
  },
}));
vi.mock('../../../appSessionState', () => ({
  dataOwnerStorageKey: (ownerId: string) => `opaque-${ownerId}`,
  getActiveAppSession: () => ({ ...harness.activeOwner }),
}));
vi.mock('../../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../../cindy-media/blobStore', () => ({
  readBlob: vi.fn(),
  resolveHashRef: vi.fn(),
}));
vi.mock('../../../cindy-media/ledger', () => ({
  ghostCanRead: vi.fn(),
  listGhostGallery: vi.fn().mockResolvedValue([]),
}));

import type { InstalledGhost } from '../../../../shared/ghost';
import { electronSandboxAdapter, ensureGhostProtocolRegistered } from '../electronSandboxAdapter';

function ghost(id: string): InstalledGhost {
  return {
    dir: `/plugins/${id}`,
    enabled: true,
    approval: { state: 'approved', revision: '00000000-0000-4000-8000-000000000001' },
    manifest: {
      schemaVersion: 2,
      id,
      name: id,
      version: '1.0.0',
      kind: 'chip',
      entry: 'main.js',
      slots: ['panel'],
      panel: { html: 'panel.html' },
    },
  };
}

beforeEach(() => {
  harness.activeOwner = { mode: 'cloud', dataOwnerId: 'owner-a', generation: 1 };
  harness.sessions.clear();
  harness.fromPartition.mockClear();
  harness.BrowserWindow.mockClear();
  harness.browserWindowOptions.length = 0;
});

describe('electronSandboxAdapter owner partition', () => {
  it('同 ghostId 的不同 owner 使用不同的非持久 session，并显式拒绝权限和下载', () => {
    const installed = ghost('same-ghost');
    ensureGhostProtocolRegistered(installed, {
      mode: 'cloud',
      dataOwnerId: 'owner-a',
      generation: 1,
    });
    ensureGhostProtocolRegistered(installed, {
      mode: 'cloud',
      dataOwnerId: 'owner-b',
      generation: 2,
    });

    const sessionA = harness.sessions.get(
      'cindy-ghost-owner:cloud:opaque-owner-a:same-ghost',
    );
    const sessionB = harness.sessions.get(
      'cindy-ghost-owner:cloud:opaque-owner-b:same-ghost',
    );
    for (const registered of [sessionA, sessionB]) {
      expect(registered).toBeDefined();
      const permissionCallback = vi.fn();
      registered?.permissionRequest.mock.calls[0]?.[0](null, 'camera', permissionCallback);
      expect(permissionCallback).toHaveBeenCalledWith(false);
      expect(registered?.permissionCheck.mock.calls[0]?.[0]()).toBe(false);
      const downloadEvent = { preventDefault: vi.fn() };
      registered?.downloadHandler?.(downloadEvent);
      expect(downloadEvent.preventDefault).toHaveBeenCalledOnce();
    }
  });

  it('同 owner 只增加 generation 时复用原 partition', () => {
    const installed = ghost('generation-stable');
    ensureGhostProtocolRegistered(installed, {
      mode: 'cloud',
      dataOwnerId: 'owner-a',
      generation: 1,
    });
    ensureGhostProtocolRegistered(installed, {
      mode: 'cloud',
      dataOwnerId: 'owner-a',
      generation: 2,
    });

    expect(harness.fromPartition).toHaveBeenCalledOnce();
    expect([...harness.sessions.keys()]).toEqual([
      'cindy-ghost-owner:cloud:opaque-owner-a:generation-stable',
    ]);
  });

  it('逻辑沙箱也使用当前 owner 的同一非持久 partition', () => {
    harness.activeOwner = { mode: 'local', dataOwnerId: 'local-owner', generation: 4 };
    const handle = electronSandboxAdapter.create(ghost('panel-owner'));

    expect(harness.browserWindowOptions[0]?.webPreferences).toMatchObject({
      partition: 'cindy-ghost-owner:local:opaque-local-owner:panel-owner',
    });
    expect(
      (harness.browserWindowOptions[0]?.webPreferences as { partition: string }).partition,
    ).not.toMatch(/^persist:/);
    handle.destroy();
  });
});
