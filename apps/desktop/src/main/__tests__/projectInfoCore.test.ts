// Unit tier: project settings mutations must reject stale accounts and controller identities;
// the old alias tests did not cover icon writes or the new remote entry point.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../projectCreation.js', () => ({
  projectCreationRoot: async () => '/Projects',
  prepareNewProject: vi.fn(async () => ({ directory: '/Projects/Created', cleanup: vi.fn() })),
}));
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
  directories: {} as Record<string, Array<{ path: string; access: 'read' | 'write' }>>,
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
  readProjectDirectories: () => h.directories,
  setProjectDirectories: h.setDirectories,
}));
vi.mock('../localDb/ipc/recentWorkdirsCore.js', () => ({
  upsertRecentWorkdir: h.register,
  hasRecentWorkdir: async () => false,
  removeRecentWorkdir: vi.fn(),
}));
vi.mock('../sidebarSettingsStoreCore.js', () => ({ restoreLocalProjectVisibility: vi.fn() }));
vi.mock('../projectDirectoryValidation.js', async (original) => ({
  ...await original<typeof import('../projectDirectoryValidation.js')>(),
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
import { prepareNewProject } from '../projectCreation.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { projectDirectoryGrantScope, projectRendererAuthorization } from '../projectInfoAuthorization';
import {
  clearWritableDirectoryPickerGrantsForTesting,
  issueWritableDirectoryPickerGrant,
} from '../maker-ipc/writableDirectoryPickerGrant';
const saveFromHost = (input: unknown) => updateProjectInfo(input, { kind: 'host' });
afterEach(() => vi.restoreAllMocks());
beforeEach(() => {
  vi.resetAllMocks();
  clearWritableDirectoryPickerGrantsForTesting();
  h.directories = {};
  h.cleanup.mockResolvedValue(undefined);
  h.register.mockResolvedValue(true);
  h.validateRoot.mockImplementation(async (workingDir) => ({ ok: true, workingDir }));
  h.setDirectories.mockResolvedValue(undefined);
  h.validateDirectories.mockImplementation(async (_key, directories) => directories);
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
  expect(await saveFromHost(request)).toMatchObject({
    settingsSupported: true,
    icons: { 'local:/repo': '🚀' },
  });
  await saveFromHost({ ...request, value: null });
  expect(h.set.mock.calls.map((args) => args.slice(0, 2))).toEqual([
    ['local:/repo', '🚀'],
    ['local:/repo', null],
  ]);
  expect(h.rename).not.toHaveBeenCalled();
});
it('rejects stale owners and controller-local identities before any write', async () => {
  await expect(
    saveFromHost({
      dataOwnerId: 'a',
      ownerGeneration: 0,
      projectKey: 'local:/repo',
      field: 'icon',
      value: null,
    }),
  ).rejects.toThrow('PRECONDITION_FAILED');
  await expect(
    saveFromHost({ ...h.stamp, projectKey: 'device:other:/repo', field: 'icon', value: null }),
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
    saveFromHost({ ...h.stamp, projectKey: 'local:/repo', field: 'icon', value: '🚀' }),
  ).rejects.toThrow('PRECONDITION_FAILED');
});

it('validates the entire profile before writing either field', async () => {
  await expect(
    saveFromHost({
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
    saveFromHost({
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
    saveFromHost({
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
    saveFromHost({
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
  await saveFromHost({
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
    await saveFromHost({
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
    saveFromHost({
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
    saveFromHost({
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
  await saveFromHost(request);
  expect(h.register).toHaveBeenCalledWith(
    '/repo',
    expect.any(Number),
    process.platform,
    expect.any(Object),
  );
  h.register.mockClear();
  h.setDirectories.mockClear();
  h.validateRoot.mockResolvedValueOnce({ ok: false, message: 'Managed workspace' });
  await expect(saveFromHost(request)).rejects.toThrow('Managed workspace');
  expect(h.register).not.toHaveBeenCalled();
  expect(h.setDirectories).not.toHaveBeenCalled();
});
it('compensates the profile when registering the new project fails', async () => {
  h.register.mockResolvedValueOnce(false);
  await expect(
    saveFromHost({
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
    saveFromHost({
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
  const result = await saveFromHost({
    ...h.stamp,
    create: true,
    projectKey: 'local:',
    field: 'profile',
    value: { name: 'Created', directories: [] },
  });
  expect(result.createdProjectKey).toBe('local:/Projects/Created');
  expect(h.register).toHaveBeenCalled();
});

// PR #11126: actual core writes previously trusted arbitrary Renderer paths.
// Existing profile tests checked validation/rollback, not caller authority. Unit tier:
// fake realpath is the filesystem boundary; the real Main picker ledger is exercised.
it('rejects forged caller flags and clone requests before any side effect', async () => {
  const request = {
    ...h.stamp,
    projectKey: 'local:/repo',
    field: 'profile',
    value: { name: 'Changed', directories: [{ path: '/private', access: 'write' }] },
    source: 'host',
    authorized: true,
    projectGrantScope: 'forged',
  };
  await expect(updateProjectInfo(request)).rejects.toThrow('AUTHORIZATION_REQUIRED');
  await expect(
    updateProjectInfo({
      ...request,
      create: true,
      repositoryUrl: 'https://gitlab.com/team/private',
    }),
  ).rejects.toThrow('AUTHORIZATION_REQUIRED');
  expect(h.setDirectories).not.toHaveBeenCalled();
  expect(h.rename).not.toHaveBeenCalled();
  expect(prepareNewProject).not.toHaveBeenCalled();
});

it('consumes only this window, form and account generation picker proof', async () => {
  vi.spyOn(fs, 'realpath').mockImplementation(async (value) => String(value));
  const directory = path.resolve('project-reference');
  const request = {
    ...h.stamp,
    projectKey: 'local:/repo',
    field: 'profile',
    value: { directories: [{ path: directory, access: 'write' }] },
  };
  const forForm = (sender: number, scope: string) => projectRendererAuthorization(sender, scope, h.stamp, vi.fn(), () => {});
  const authorization = forForm(7, 'form');
  const issue = async (stamp = h.stamp) =>
    issueWritableDirectoryPickerGrant({
      useCanonicalPath: true,
      scopeId: projectDirectoryGrantScope(stamp, 'form'),
      senderId: 7,
      directory,
    });
  await issue({ ...h.stamp, ownerGeneration: 0 });
  await expect(updateProjectInfo(request, authorization)).rejects.toThrow('AUTHORIZATION_REQUIRED');
  await issue();
  for (const foreign of [
    forForm(8, 'form'),
    forForm(7, 'other-form'),
  ])
    await expect(updateProjectInfo(request, foreign)).rejects.toThrow('AUTHORIZATION_REQUIRED');
  expect(h.setDirectories).not.toHaveBeenCalled();
  await updateProjectInfo(request, authorization);
  expect(h.setDirectories).toHaveBeenCalledWith(
    'local:/repo',
    request.value.directories,
    expect.any(Function),
  );
  // The fake store does not retain the directory: a second write needs fresh proof.
  await expect(updateProjectInfo(request, authorization)).rejects.toThrow('AUTHORIZATION_REQUIRED');
});

it('retains/revokes existing access without a picker but requires proof for a read-to-write upgrade', async () => {
  const directory = path.resolve('project-reference');
  h.directories = { 'local:/repo': [{ path: directory, access: 'read' }] };
  const request = { ...h.stamp, projectKey: 'local:/repo', field: 'profile' };
  await updateProjectInfo({ ...request, value: { directories: h.directories['local:/repo'] } });
  await expect(
    updateProjectInfo({
      ...request,
      value: { directories: [{ path: directory, access: 'write' }] },
    }),
  ).rejects.toThrow('AUTHORIZATION_REQUIRED');
  await updateProjectInfo({ ...request, value: { directories: [] } });
  expect(h.setDirectories.mock.calls.map((args) => args[1])).toEqual([
    h.directories['local:/repo'],
    [],
  ]);
});

it('authorizes supplied roots before cloning, then saves the same complete profile', async () => {
  vi.spyOn(fs, 'realpath').mockImplementation(async (value) => String(value));
  const directory = path.resolve('project-reference');
  const confirm = vi.fn();
  const authorization = projectRendererAuthorization(7, 'create', h.stamp, confirm, () => {});
  const request = {
    ...h.stamp,
    create: true,
    projectKey: 'local:',
    repositoryUrl: 'https://gitlab.com/team/demo',
    field: 'profile',
    value: { name: 'Demo', icon: '🚀', directories: [{ path: directory, access: 'write' }] },
  };
  await expect(updateProjectInfo(request, authorization)).rejects.toThrow('AUTHORIZATION_REQUIRED');
  expect(prepareNewProject).not.toHaveBeenCalled();
  await issueWritableDirectoryPickerGrant({
    useCanonicalPath: true,
      scopeId: projectDirectoryGrantScope(h.stamp, 'create'),
    senderId: 7,
    directory,
  });
  const prepared = vi.mocked(prepareNewProject);
  prepared.mockImplementation(async ({ confirmImport }) => {
    await confirmImport!('https://gitlab.com/team/demo.git', '/Projects/Created');
    return { directory: '/Projects/Created', cleanup: vi.fn() };
  });
  confirm.mockRejectedValueOnce(new Error('cancelled'));
  await expect(updateProjectInfo(request, authorization)).rejects.toThrow('cancelled');
  expect(h.setDirectories).not.toHaveBeenCalled();
  const result = await updateProjectInfo(request, authorization);
  expect(result.createdProjectKey).toBe('local:/Projects/Created');
  expect(h.setDirectories).toHaveBeenCalledWith(
    result.createdProjectKey,
    request.value.directories,
    expect.any(Function),
  );
  expect(h.set).toHaveBeenCalledWith(result.createdProjectKey, '🚀', expect.any(Function));
});

// Unit: the profile entry must bind native SSH consent to the actual save and access level.
it('confirms only new SSH access and never writes a cancelled or stale request', async () => {
  const key = 'remote:build%20host:/work/project';
  const read = { path: '/data/art', access: 'read' as const };
  const write = { ...read, access: 'write' as const };
  const confirm = vi.fn();
  const save = (directories: typeof h.directories[string]) => updateProjectInfo({
    ...h.stamp, projectKey: key, field: 'profile', value: { directories },
  }, projectRendererAuthorization(7, 'form', h.stamp, confirm, () => {}));
  h.directories = { [key]: [read] };
  await save([read]);
  await save([]);
  expect(confirm).not.toHaveBeenCalled();
  h.setDirectories.mockClear();
  confirm.mockRejectedValueOnce(new Error('cancelled'));
  await expect(save([write])).rejects.toThrow('cancelled');
  expect(confirm).toHaveBeenCalledWith({ kind: 'ssh', host: 'build host', project: '/work/project', directories: [write] }, undefined);
  expect(h.setDirectories).not.toHaveBeenCalled();
  confirm.mockImplementationOnce(() => { h.stamp = { ...h.stamp, ownerGeneration: 2 }; });
  await expect(save([write])).rejects.toThrow('PRECONDITION_FAILED');
  expect(h.setDirectories).not.toHaveBeenCalled();
  await save([write]);
  expect(h.setDirectories).toHaveBeenCalledWith(key, [write], expect.any(Function));
});
