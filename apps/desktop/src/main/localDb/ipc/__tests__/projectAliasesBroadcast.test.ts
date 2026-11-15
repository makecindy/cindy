/**
 * Test value: real snapshot/mutation handlers expose only host-owned names and scoped invalidations.
 * Regression: project renames never reached device-link; existing SQLite tests did not exercise
 * IPC authorization or broadcasts. Minimal input is one local/SSH alias plus a device override,
 * or an owner change during the awaited read/write. Unit tier with injected DB/renderer boundaries.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  trusted: { webContents: { send: vi.fn() } },
  untrusted: { webContents: { send: vi.fn() } },
  ownerStamp: { dataOwnerId: 'owner-a', ownerGeneration: 2 },
  scopeCurrent: true,
  read: vi.fn(),
  tx: vi.fn(),
  tap: vi.fn(),
  handle: vi.fn(),
  assertTrusted: vi.fn(),
  remoteInvoke: false,
}));
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [h.trusted, h.untrusted] },
  ipcMain: { handle: h.handle },
}));
vi.mock('../../client/current', () => ({
  getDbClient: () => ({
    drizzle: { select: () => ({ from: () => ({ orderBy: h.read }) }) },
    tx: h.tx,
  }),
}));
vi.mock('../../../device-link/broadcast-tap.js', () => ({
  captureDataOwnerBroadcastScope: () => ({ ownerScopeKey: 'owner-a:2', ownerStamp: h.ownerStamp }),
  isDataOwnerBroadcastScopeCurrent: () => h.scopeCurrent,
  tapWindowBroadcast: h.tap,
}));
vi.mock('../../../security/trustedAppRenderer.js', () => ({
  assertTrustedAppRendererEvent: h.assertTrusted,
  isTrustedAppRendererWindow: (window: unknown) => window === h.trusted,
}));
vi.mock('../../../device-link/invoke-context.js', () => ({
  isDeviceLinkInvoke: () => h.remoteInvoke,
}));

import {
  readHostProjectAliasesSnapshot,
  registerProjectAliasesIpc,
  upsertProjectAlias,
} from '../projectAliases';

describe('project alias remote snapshot and owner boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.scopeCurrent = true;
    h.remoteInvoke = false;
    h.assertTrusted.mockReset();
    h.read.mockResolvedValue([]);
    h.tx.mockResolvedValue(null);
  });

  it('requires a trusted local sender while permitting already-authorized device-link invocations', async () => {
    registerProjectAliasesIpc();
    const handler = h.handle.mock.calls.find(([channel]) => channel === 'sidebar-settings:get-project-aliases')![1];
    h.assertTrusted.mockImplementationOnce(() => { throw new Error('UNAUTHORIZED'); });
    await expect(handler({})).rejects.toThrow('UNAUTHORIZED');
    expect(h.read).not.toHaveBeenCalled();
    h.remoteInvoke = true;
    await expect(handler({})).resolves.toMatchObject({ aliases: [] });
    expect(h.assertTrusted).toHaveBeenCalledTimes(1);
  });

  it('registers a separate snapshot and excludes controller-local device overrides', async () => {
    h.read.mockResolvedValue([
      { projectKey: 'local:C:/Repo', alias: 'Local project', updatedAt: 1 },
      { projectKey: 'remote:ssh-a:/repo', alias: 'SSH project', updatedAt: 2 },
      { projectKey: 'device:other:/repo', alias: 'Private override', updatedAt: 3 },
    ]);
    registerProjectAliasesIpc();
    expect(h.handle).toHaveBeenCalledWith('sidebar-settings:get-project-aliases', expect.any(Function));
    expect(await readHostProjectAliasesSnapshot()).toEqual({
      aliases: [
        { projectKey: 'local:C:/Repo', alias: 'Local project' },
        { projectKey: 'remote:ssh-a:/repo', alias: 'SSH project' },
      ],
      platform: process.platform,
      ownerStamp: h.ownerStamp,
    });
  });

  it.each([false, true])('keeps the legacy list contract while filtering remote viewer overrides (remote=%s)', async (remote) => {
    const rows = [
      { projectKey: 'local:/repo', alias: 'Local', updatedAt: 1 },
      { projectKey: 'remote:ssh:/repo', alias: 'SSH', updatedAt: 2 },
      { projectKey: 'device:viewer:/repo', alias: 'Private', updatedAt: 3 },
    ];
    h.read.mockResolvedValue(rows);
    h.remoteInvoke = remote;
    registerProjectAliasesIpc();
    const handler = h.handle.mock.calls.find(([channel]) => channel === 'local-db:project-aliases:list')![1];
    expect(await handler({})).toEqual((remote ? rows.slice(0, 2) : rows)
      .map(row => ({ ...row, updatedAt: new Date(row.updatedAt).toISOString() })));
  });

  it('broadcasts persisted rename and deletion invalidations with the captured owner stamp', async () => {
    await upsertProjectAlias('local:/repo', 'New name');
    await upsertProjectAlias('local:/repo', '');
    expect(h.tap).toHaveBeenCalledTimes(2);
    expect(h.tap).toHaveBeenLastCalledWith('local-db:project-aliases:changed', {}, h.ownerStamp);
    expect(h.trusted.webContents.send).toHaveBeenLastCalledWith(
      'local-db:project-aliases:changed', {}, h.ownerStamp,
    );
    expect(h.untrusted.webContents.send).not.toHaveBeenCalled();
  });

  it('does not emit an old owner write after an account switch', async () => {
    let complete!: (value: null) => void;
    h.tx.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    const pending = upsertProjectAlias('local:/repo', 'Old account name');
    h.scopeCurrent = false;
    complete(null);
    await pending;
    expect(h.tap).not.toHaveBeenCalled();
    expect(h.trusted.webContents.send).not.toHaveBeenCalled();
  });

  it('rejects a snapshot that finishes after its owner becomes stale', async () => {
    h.read.mockImplementationOnce(async () => {
      h.scopeCurrent = false;
      return [{ projectKey: 'local:/repo', alias: 'Old account name', updatedAt: 1 }];
    });
    await expect(readHostProjectAliasesSnapshot()).rejects.toThrow('PRECONDITION_FAILED');
  });

  it('does not broadcast a failed mutation or hide a failed snapshot read', async () => {
    h.tx.mockRejectedValueOnce(new Error('write failed'));
    await expect(upsertProjectAlias('local:/repo', 'Name')).rejects.toThrow('write failed');
    expect(h.tap).not.toHaveBeenCalled();
    h.read.mockRejectedValueOnce(new Error('read failed'));
    await expect(readHostProjectAliasesSnapshot()).rejects.toThrow('read failed');
  });
});
