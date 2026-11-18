vi.mock('../../../projectCreation.js', () => ({ projectCreationRoot: async () => '/Projects' }));
/**
 * Test value: real snapshot/mutation handlers expose only host-owned names and scoped invalidations.
 * Regression: project renames never reached device-link; existing SQLite tests did not exercise
 * IPC authorization or broadcasts. Minimal input is one local/SSH alias plus a device override,
 * or an owner change during the awaited read/write. Unit tier with injected DB/renderer boundaries.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  trusted: { isDestroyed: () => false, webContents: { send: vi.fn() } },
  untrusted: { webContents: { send: vi.fn() } },
  ownerStamp: { dataOwnerId: 'owner-a', ownerGeneration: 2 },
  scopeCurrent: true,
  read: vi.fn(),
  tx: vi.fn(),
  tap: vi.fn(),
  handle: vi.fn(),
  sheet: vi.fn(),
  assertTrusted: vi.fn(),
  remoteInvoke: false,
}));
vi.mock('../../../appSessionState.js', async (original) => ({ ...await original<typeof import('../../../appSessionState.js')>(), getActiveDataOwnerPushStamp: () => h.ownerStamp, isAppSessionBoundaryPending: () => false }));
vi.mock('../../../projectDirectoryStore.js', () => ({ readProjectDirectories: () => ({}) }));
vi.mock('../../../projectIconStore.js', () => ({
  readProjectIcons: () => ({}),
  setProjectIcon: vi.fn(),
}));
vi.mock('../../../projectInfoCore.js', () => ({
  updateProjectInfo: vi.fn(),
  readProjectIconImage: vi.fn(),
}));
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [h.trusted, h.untrusted], fromWebContents: () => h.trusted },
  dialog: { showMessageBox: h.sheet },
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
import { checkForwardedProjectWrite, forwardProjectWrite } from '../../../host-platform/project-writes.desktop.js';
import { updateProjectInfo as writeCore } from '../../../projectInfoCore.js';

describe('project alias remote snapshot and owner boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.scopeCurrent = true;
    h.remoteInvoke = false;
    h.assertTrusted.mockReset();
    h.read.mockResolvedValue([]);
    h.tx.mockResolvedValue(null);
  });

  // PR #11126: the IPC adapter, not request data, supplies core authorization.
  // Unit handler regression; existing snapshot tests did not exercise mutation admission.
  it('binds local writes to the actual sender and only trusts authenticated remote dispatch', async () => {
    registerProjectAliasesIpc();
    const handler = h.handle.mock.calls.find(
      ([channel]) => channel === 'sidebar-settings:set-project-info',
    )![1];
    const input = { ...h.ownerStamp, projectGrantScope: 'form', authorization: { kind: 'host' }, field: 'profile' };
    vi.mocked(writeCore).mockResolvedValue({ aliases: [], platform: process.platform });
    await handler({ sender: { id: 42 } }, input);
    expect(writeCore).toHaveBeenLastCalledWith(input, {
      kind: 'renderer',
      assertCurrent: expect.any(Function),
      check: expect.any(Function),
    });
    const authorization = vi.mocked(writeCore).mock.lastCall![1];
    if (authorization?.kind !== 'renderer') throw new Error('missing renderer confirmation');
    h.sheet.mockResolvedValueOnce({ response: 0 });
    await expect(authorization.check({
      kind: 'repository', url: 'https://gitlab.com/team/demo.git', directory: '/Projects/demo-2',
    })).rejects.toThrow('MUTATION_CANCELLED');
    expect(h.sheet).toHaveBeenCalledWith(h.trusted, expect.objectContaining({
      cancelId: 0, defaultId: 0, detail: expect.stringMatching(/gitlab\.com\/team\/demo\.git[\s\S]*\/Projects\/demo-2/),
    }));
    h.remoteInvoke = true;
    await handler({}, input);
    expect(writeCore).toHaveBeenLastCalledWith(input, { kind: 'host' });
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
      icons: {},
      settingsSupported: true,
      settingsVersion: 7,
      creationRoot: '/Projects',
      directories: {},
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

// Unit: a split Host must call back into the original Main window before importing;
// a stale request cannot reopen the sheet or consume another form's picker selection.
it('checks delegated consent in the original window only while its request is open', async () => {
  let id = '';
  const signal = new AbortController().signal;
  const check = { kind: 'repository' as const, url: 'https://gitlab.com/team/demo.git', directory: '/Projects/demo-2' };
  const input = { ...h.ownerStamp, create: true, projectKey: 'local:', repositoryUrl: check.url };
  const client = { async request(route: string, body: unknown) {
    expect(route).toBe('/api/project-info/desktop-set');
    const envelope = body as { requestId: string; input: unknown };
    expect(envelope.input).toEqual(input);
    id = envelope.requestId;
    await expect(checkForwardedProjectWrite(id, { kind: 'picker', selection: {
      requestedDirs: ['/Projects/art'], projectPaths: ['/Projects/art'],
    } }, signal)).rejects.toThrow('AUTHORIZATION_REQUIRED');
    return checkForwardedProjectWrite(id, check, signal);
  } };
  h.sheet.mockResolvedValueOnce({ response: 1 });
  const event = { sender: { id: 42 } } as import('electron').IpcMainInvokeEvent;
  await expect(forwardProjectWrite(client, event, input)).resolves.toBe(true);
  await expect(checkForwardedProjectWrite(id, check, signal)).rejects.toThrow('PERMISSION_DENIED');
  expect(h.sheet).toHaveBeenCalledTimes(1);
});
