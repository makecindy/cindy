// Unit tier: project settings mutations must reject stale accounts and controller identities;
// the old alias tests did not cover icon writes or the new remote entry point.
import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('../projectCreation.js', () => ({ projectCreationRoot: async () => '/Projects', prepareNewProject: vi.fn(async () => ({ directory: '/Projects/Created', cleanup: vi.fn() })) }));
const h = vi.hoisted(() => ({
  stamp: { dataOwnerId: 'a', ownerGeneration: 1 },
  pending: false,
  icons: { 'local:/repo': '🚀' },
  read: vi.fn(),
  set: vi.fn(),
  rename: vi.fn(),
  importImage: vi.fn(),
  cleanup: vi.fn(),
  readImage: vi.fn(),
  setDirectories: vi.fn(),
  validateDirectories: vi.fn(),
  register: vi.fn(),
  validateRoot: vi.fn(),
}));
vi.mock('../appSessionState.js', () => ({
  ownerScopedUserDataPath: (file: string) => '/mock/' + file,
  getActiveDataOwnerPushStamp: () => h.stamp,
  isAppSessionBoundaryPending: () => h.pending,
}));
vi.mock('../device-link/crossProcessLock.js', () => ({
  withCrossProcessLock: async (
    _p: string,
    _o: unknown,
    fn: (status: { held: true }) => Promise<void>,
  ) => fn({ held: true }),
}));
vi.mock('../projectDirectoryStore.js', () => ({
  readProjectDirectories: () => ({}),
  setProjectDirectories: h.setDirectories,
}));
vi.mock('../localDb/ipc/recentWorkdirsCore.js', () => ({
  upsertRecentWorkdir: h.register,
  hasRecentWorkdir: async () => false,
  removeRecentWorkdir: vi.fn(),
}));
vi.mock('../sidebarSettingsStore.js', () => ({ restoreLocalProjectVisibility: vi.fn() }));
vi.mock('../projectDirectoryValidation.js', () => ({
  validateProjectDirectories: h.validateDirectories,
}));
vi.mock('../projectDirectoryRoot.js', () => ({
  validateLocalProjectDirectory: (workingDir: string) => ({ ok: true, workingDir }),
  validateExistingLocalProjectDirectory: h.validateRoot,
}));
vi.mock('../projectIconMedia.js', () => ({
  importProjectIcon: h.importImage,
  releasePreviousProjectImages: h.cleanup,
  readProjectIconBytes: h.readImage,
}));
vi.mock('../projectIconStore.js', () => ({
  readProjectIcons: () => h.icons,
  setProjectIcon: h.set,
}));
vi.mock('../localDb/ipc/projectAliasesCore.js', () => ({
  listProjectAliases: h.read,
  upsertProjectAlias: h.rename,
}));
vi.mock('../localDb/client/current.js', () => ({ getDbClient: () => ({}) }));
import { readProjectIconImage, readProjectInfo, updateProjectInfo } from '../projectInfoCore';
beforeEach(() => {
  vi.resetAllMocks();
  h.cleanup.mockResolvedValue(undefined);
  h.register.mockResolvedValue(true);
  h.validateRoot.mockResolvedValue({ ok: true, workingDir: '/repo' });
  h.setDirectories.mockResolvedValue(undefined);
  h.validateDirectories.mockResolvedValue(undefined);
  h.rename.mockResolvedValue(undefined);
  h.importImage.mockResolvedValue(`cindy-media://blobs/${'a'.repeat(64)}.png`);
  h.icons['local:/repo'] = '🚀';
  h.pending = false;
  h.stamp = { dataOwnerId: 'a', ownerGeneration: 1 };
  h.read.mockResolvedValue([]);
  h.set.mockResolvedValue(undefined);
});
it('saves and resets only the addressed icon, preserving names', async () => {
  const request = { ...h.stamp, projectKey: 'local:/repo', field: 'icon', value: '🚀' };
  expect(await updateProjectInfo(request)).toMatchObject({
    settingsSupported: true,
    icons: { 'local:/repo': '🚀' },
  });
  await updateProjectInfo({ ...request, value: null });
  expect(h.set.mock.calls.map((args) => args.slice(0, 2))).toEqual([
    ['local:/repo', '🚀'],
    ['local:/repo', null],
  ]);
  expect(h.rename).not.toHaveBeenCalled();
});
it('rejects stale owners and controller-local identities before any write', async () => {
  await expect(
    updateProjectInfo({
      dataOwnerId: 'a',
      ownerGeneration: 0,
      projectKey: 'local:/repo',
      field: 'icon',
      value: null,
    }),
  ).rejects.toThrow('PRECONDITION_FAILED');
  await expect(
    updateProjectInfo({ ...h.stamp, projectKey: 'device:other:/repo', field: 'icon', value: null }),
  ).rejects.toThrow('INVALID_PARAMS');
  expect(h.set).not.toHaveBeenCalled();
});
it('cannot publish a read from the previous account', async () => {
  h.read.mockImplementationOnce(async () => {
    h.stamp = { dataOwnerId: 'b', ownerGeneration: 2 };
    return [];
  });
  await expect(readProjectInfo()).rejects.toThrow('PRECONDITION_FAILED');
});

it('rejects an account switch while an icon write waits for the file lock', async () => {
  h.set.mockImplementationOnce(async (_key, _icon, assertCurrent) => {
    h.stamp = { dataOwnerId: 'b', ownerGeneration: 2 };
    assertCurrent();
  });
  await expect(
    updateProjectInfo({ ...h.stamp, projectKey: 'local:/repo', field: 'icon', value: '🚀' }),
  ).rejects.toThrow('PRECONDITION_FAILED');
});

it('validates the entire profile before writing either field', async () => {
  await expect(
    updateProjectInfo({
      ...h.stamp,
      projectKey: 'local:/repo',
      field: 'profile',
      value: { name: 'Updated', icon: 'file:///secret' },
    }),
  ).rejects.toThrow('INVALID_PARAMS');
  expect(h.rename).not.toHaveBeenCalled();
  expect(h.set).not.toHaveBeenCalled();
});
it('keeps the name if image ingestion fails', async () => {
  h.importImage.mockRejectedValueOnce(new Error('Invalid image'));
  await expect(
    updateProjectInfo({
      ...h.stamp,
      projectKey: 'local:/repo',
      field: 'profile',
      value: { name: 'Updated', icon: 'data:image/png;base64,AAAA' },
    }),
  ).rejects.toThrow('Invalid image');
  expect(h.rename).not.toHaveBeenCalled();
  expect(h.set).not.toHaveBeenCalled();
});
it('restores the previous icon if the alias transaction fails', async () => {
  h.rename.mockRejectedValueOnce(new Error('DB unavailable'));
  await expect(
    updateProjectInfo({
      ...h.stamp,
      projectKey: 'local:/repo',
      field: 'profile',
      value: { name: 'Updated', icon: 'symbol:Rocket' },
    }),
  ).rejects.toThrow('DB unavailable');
  expect(h.set.mock.calls.map((args) => args.slice(0, 2))).toEqual([
    ['local:/repo', 'symbol:Rocket'],
    ['local:/repo', '🚀'],
  ]);
  expect(h.cleanup).toHaveBeenCalledWith('local:/repo', '🚀', expect.any(Function));
});
it('rejects a media address from a different project before reading or writing bytes', async () => {
  await expect(
    updateProjectInfo({
      ...h.stamp,
      projectKey: 'local:/repo',
      field: 'icon',
      value: `cindy-media://blobs/${'a'.repeat(64)}.png`,
    }),
  ).rejects.toThrow('INVALID_PARAMS');
  expect(h.set).not.toHaveBeenCalled();
  expect(h.importImage).not.toHaveBeenCalled();
});
it('stores an uploaded image address together with the name, then releases the old reference', async () => {
  await updateProjectInfo({
    ...h.stamp,
    projectKey: 'local:/repo',
    field: 'profile',
    value: { name: 'Updated', icon: 'data:image/png;base64,AAAA' },
  });
  expect(h.set).toHaveBeenCalledWith(
    'local:/repo',
    `cindy-media://blobs/${'a'.repeat(64)}.png`,
    expect.any(Function),
  );
  expect(h.rename).toHaveBeenCalledWith(
    'local:/repo',
    'Updated',
    process.platform,
    expect.any(Object),
  );
  expect(h.cleanup).toHaveBeenCalledTimes(1);
});

it('reads only the image attached to the requested project', async () => {
  h.icons['local:/repo'] = `cindy-media://blobs/${'a'.repeat(64)}.png`;
  expect(await readProjectIconImage({ projectKey: 'local:/different' })).toBeNull();
  expect(h.readImage).not.toHaveBeenCalled();
});
it('never returns image bytes after the account changes during a read', async () => {
  h.icons['local:/repo'] = `cindy-media://blobs/${'a'.repeat(64)}.png`;
  h.readImage.mockImplementationOnce(async () => {
    h.stamp = { dataOwnerId: 'b', ownerGeneration: 2 };
    return 'data:image/png;base64,AAAA';
  });
  await expect(readProjectIconImage({ projectKey: 'local:/repo' })).rejects.toThrow(
    'PRECONDITION_FAILED',
  );
});

it.each(['symbol:Rocket:blue', 'text:CY:blue', 'text:中A:white', 'text:CY'])(
  'saves %s through the profile endpoint without renaming the project',
  async (icon) => {
    await updateProjectInfo({
      ...h.stamp,
      projectKey: 'local:/repo',
      field: 'profile',
      value: { icon },
    });
    expect(h.set).toHaveBeenCalledWith('local:/repo', icon, expect.any(Function));
    expect(h.rename).not.toHaveBeenCalled();
  },
);

it('validates every directory before changing any profile field', async () => {
  h.validateDirectories.mockRejectedValueOnce(new Error('Project directories must not overlap'));
  await expect(
    updateProjectInfo({
      ...h.stamp,
      projectKey: 'local:/repo',
      field: 'profile',
      value: {
        name: 'Updated',
        icon: '🚀',
        directories: [{ path: '/repo/child', access: 'write' }],
      },
    }),
  ).rejects.toThrow('overlap');
  expect(h.rename).not.toHaveBeenCalled();
  expect(h.set).not.toHaveBeenCalled();
  expect(h.setDirectories).not.toHaveBeenCalled();
});
it('rolls back directory settings if alias save fails', async () => {
  h.rename.mockRejectedValueOnce(new Error('DB unavailable'));
  await expect(
    updateProjectInfo({
      ...h.stamp,
      projectKey: 'local:/repo',
      field: 'profile',
      value: { name: 'Updated', directories: [{ path: '/reference', access: 'read' }] },
    }),
  ).rejects.toThrow('DB unavailable');
  expect(h.setDirectories.mock.calls.map((args) => args.slice(0, 2))).toEqual([
    ['local:/repo', [{ path: '/reference', access: 'read' }]],
    ['local:/repo', undefined],
  ]);
});
it('creates the project with the saved profile and rejects managed workspaces before any write', async () => {
  const request = {
    ...h.stamp,
    create: true,
    projectKey: 'local:/repo',
    field: 'profile',
    value: { name: 'Updated', directories: [] },
  };
  await updateProjectInfo(request);
  expect(h.register).toHaveBeenCalledWith(
    '/repo',
    expect.any(Number),
    process.platform,
    expect.any(Object),
  );
  h.register.mockClear();
  h.setDirectories.mockClear();
  h.validateRoot.mockResolvedValueOnce({ ok: false, message: 'Managed workspace' });
  await expect(updateProjectInfo(request)).rejects.toThrow('Managed workspace');
  expect(h.register).not.toHaveBeenCalled();
  expect(h.setDirectories).not.toHaveBeenCalled();
});
it('compensates the profile when registering the new project fails', async () => {
  h.register.mockResolvedValueOnce(false);
  await expect(
    updateProjectInfo({
      ...h.stamp,
      create: true,
      projectKey: 'local:/repo',
      field: 'profile',
      value: { name: 'Updated', directories: [] },
    }),
  ).rejects.toThrow('register');
  expect(h.rename.mock.calls.map((args) => args.slice(0, 2))).toEqual([
    ['local:/repo', 'Updated'],
    ['local:/repo', ''],
  ]);
  expect(h.setDirectories.mock.calls.map((args) => args.slice(0, 2))).toEqual([
    ['local:/repo', []],
    ['local:/repo', undefined],
  ]);
});

it('does not silently collapse a selected task worktree into a new project registration', async () => {
  await expect(
    updateProjectInfo({
      ...h.stamp,
      create: true,
      projectKey: 'local:/repo/.cindy-worktrees/task',
      field: 'profile',
      value: { directories: [] },
    }),
  ).rejects.toThrow('main directory');
  expect(h.register).not.toHaveBeenCalled();
  expect(h.setDirectories).not.toHaveBeenCalled();
});

it('allocates an automatic project and returns its real identity', async () => {
  const result = await updateProjectInfo({ ...h.stamp, create: true, projectKey: 'local:', field: 'profile', value: { name: 'Created', directories: [] } });
  expect(result.createdProjectKey).toBe('local:/Projects/Created');
  expect(h.register).toHaveBeenCalled();
});
