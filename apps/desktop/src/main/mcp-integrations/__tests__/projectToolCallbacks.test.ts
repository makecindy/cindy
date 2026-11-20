// Unit: the shared production tool router was previously embedded in Desktop.
// Cover full profiles, target capability/version and account revocation using
// fake transport/storage ports; no real devices, Git or user files are touched.
import { expect, it, vi } from 'vitest';
import { createProjectToolCallbacks, type ProjectToolPorts } from '../projectToolCallbacks.js';
import type { HostProjectAliasesSnapshot } from '@cindy/maker-shared/project-alias-sync';

function fixture(version = 7) {
  let current = true;
  const snapshot: HostProjectAliasesSnapshot = {
    aliases: [{ projectKey: 'local:/repo', alias: 'Demo' }],
    icons: {},
    directories: { 'local:/repo': [{ path: '/reference', access: 'write' }] },
    platform: 'linux',
    settingsSupported: true,
    settingsVersion: version,
    ownerStamp: { dataOwnerId: 'target-owner', ownerGeneration: 4 },
  };
  const assertCurrent = async () => {
    if (!current) throw new Error('OWNER_SCOPE_CHANGED');
  };
  const createProject = vi.fn(async () => ({ ok: true as const, workingDir: '/repo' }));
  const updateProjectInfo = vi.fn(async () => snapshot);
  let afterRead = () => {};
  const invokeRemote = vi.fn<ProjectToolPorts['invokeRemote']>(
    async (_device, channel, _args, options) => {
      await options?.preSend?.();
      if (channel === 'sidebar-settings:get-project-aliases') {
        afterRead();
        return { ok: true, result: snapshot };
      }
      return { ok: true, result: { ...snapshot, createdProjectKey: 'local:/allocated' } };
    },
  );
  const tools = createProjectToolCallbacks({
    deviceId: () => 'this-host',
    invokeRemote,
    withAccountDataAccess: async (_id, operation) => {
      await assertCurrent();
      const result = await operation(assertCurrent);
      await assertCurrent();
      return result;
    },
    local: { createProject, updateProjectInfo, readProjectInfo: async () => snapshot },
  });
  return {
    tools,
    createProject,
    updateProjectInfo,
    invokeRemote,
    snapshot,
    revoke: () => {
      current = false;
    },
    onRead: (callback: () => void) => {
      afterRead = callback;
    },
  };
}

it('imports a repository with its full profile only on the selected computer', async () => {
  const f = fixture();
  const profile = {
    name: 'Demo',
    icon: 'symbol:Code',
    directories: [{ path: '/reference', access: 'write' as const }],
  };
  expect(
    await f.tools.createProject!({
      callerSessionId: 'task',
      device: 'remote-host',
      repositoryUrl: 'git@gitlab.com:group/demo.git',
      ...profile,
    }),
  ).toEqual({ ok: true, workingDir: '/allocated' });
  expect(f.createProject).not.toHaveBeenCalled();
  expect(f.invokeRemote).toHaveBeenLastCalledWith(
    'remote-host',
    'sidebar-settings:set-project-info',
    [
      {
        ...f.snapshot.ownerStamp,
        create: true,
        projectKey: 'local:',
        repositoryUrl: 'git@gitlab.com:group/demo.git',
        field: 'profile',
        value: profile,
      },
    ],
    { preSend: expect.any(Function) },
  );
});

it('routes a local device identity through the same creation and settings callbacks', async () => {
  const f = fixture();
  const input = {
    callerSessionId: 'task',
    workingDir: '/repo',
    name: 'Demo',
    icon: '🌿',
    directories: [{ path: '/reference', access: 'write' as const }],
  };
  expect(await f.tools.createProject!({ ...input, device: 'this-host' })).toEqual({
    ok: true,
    workingDir: '/repo',
  });
  expect(f.createProject).toHaveBeenCalledWith(input);
  const value = { name: 'New', directories: [] };
  expect(
    await f.tools.projectManagement!.updateInfo!({
      callerSessionId: 'task',
      device: 'this-host',
      projectKey: 'local:/repo',
      field: 'profile',
      value,
    }),
  ).toMatchObject({ ok: true, saved: true });
  expect(f.updateProjectInfo).toHaveBeenCalledWith(
    { ...f.snapshot.ownerStamp, projectKey: 'local:/repo', field: 'profile', value },
    { kind: 'host', assertCurrent: undefined },
  );
  expect(f.invokeRemote).not.toHaveBeenCalled();
});

it('keeps explicit-folder creation on v6 but rejects unsupported allocation, clone and directory writes', async () => {
  const f = fixture(6);
  for (const request of [
    { name: 'Demo' },
    { workingDir: '/repo', repositoryUrl: 'https://github.com/g/demo' },
  ]) {
    expect(
      await f.tools.createProject!({ callerSessionId: 'task', device: 'remote-host', ...request }),
    ).toMatchObject({ ok: false, errorCode: 'UNSUPPORTED_CAPABILITY' });
  }
  expect(
    f.invokeRemote.mock.calls.every((call) => call[1] === 'sidebar-settings:get-project-aliases'),
  ).toBe(true);
  expect(
    await f.tools.createProject!({
      callerSessionId: 'task',
      device: 'remote-host',
      workingDir: '/repo',
    }),
  ).toMatchObject({ ok: true });
  const old = fixture(5);
  expect(
    await old.tools.projectManagement!.updateInfo!({
      callerSessionId: 'task',
      device: 'remote-host',
      projectKey: 'local:/repo',
      field: 'profile',
      value: { directories: [] },
    }),
  ).toMatchObject({ ok: false, errorCode: 'UNSUPPORTED_CAPABILITY' });
  expect(old.invokeRemote).toHaveBeenCalledTimes(1);
});

it('returns main directory, ordered access and capabilities from the target computer', async () => {
  const f = fixture();
  expect(
    await f.tools.projectManagement!.readInfo!({
      callerSessionId: 'task',
      device: 'remote-host',
      projectKey: 'local:/repo',
    }),
  ).toEqual({
    ok: true,
    project: {
      project_key: 'local:/repo',
      device: 'remote-host',
      main_directory: '/repo',
      settings_version: 7,
      directories_supported: true,
      name: 'Demo',
      icon: null,
      directories: [{ path: '/reference', access: 'write' }],
    },
  });
});

it('rechecks authority between target lookup and mutation; never falls back to local creation', async () => {
  const f = fixture();
  f.onRead(f.revoke);
  await expect(
    f.tools.createProject!({ callerSessionId: 'task', device: 'remote-host', name: 'Demo' }),
  ).rejects.toThrow('OWNER_SCOPE_CHANGED');
  expect(f.createProject).not.toHaveBeenCalled();
  expect(f.updateProjectInfo).not.toHaveBeenCalled();
  // The second transport attempt checks the pre-send guard before any target write.
  expect(f.invokeRemote).toHaveBeenCalledTimes(2);
});
