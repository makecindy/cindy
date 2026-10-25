import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RemotePluginManagement, type RemotePluginManagementDeps } from '../remotePluginManagement';
import { ghostInstallApprovalToken, type InstalledGhost } from '../../../shared/ghost';
import { installedGhostStoragePart } from '../../../shared/pluginIdentity';
import type { PluginManagementReceipt } from '../../../shared/pluginManagement';

function fixture() {
  let owner = 'owner-a',
    epoch = 0;
  const revoked = new Set<string>();
  const ghosts: InstalledGhost[] = [null, 'org-acme'].map((namespace) => ({
    manifest: {
      schemaVersion: 3,
      minCindyVersion: '0.1.61',
      id: 'weather',
      name: 'Weather',
      version: '1.0.0',
      kind: 'chip',
      entry: 'main.js',
    },
    dir: namespace ? '/test/_ns/org-acme/weather' : '/test/weather',
    namespace,
    enabled: true,
    approval: { state: 'approved', revision: '00000000-0000-4000-8000-000000000001' },
  }));
  const deps: RemotePluginManagementDeps = {
    list: () => ghosts,
    capture: (peer) => {
      const start = owner,
        generation = epoch;
      return () => owner === start && generation === epoch && !revoked.has(peer);
    },
    captureReceipt: (peer) => {
      const start = owner;
      return () => owner === start && !revoked.has(peer);
    },
    market: {
      snapshot: vi.fn(async () => ({
        items: [],
        unavailableReason: null,
        customSourceNames: [],
        unavailableCustomSourceNames: [],
      })),
      detail: vi.fn(async () => ({}) as never),
      install: vi.fn(async () => {}),
    },
    setEnabled: vi.fn(async (id, enabled, _approval, current) => {
      current();
      ghosts.find((g) => installedGhostStoragePart(g) === id)!.enabled = enabled;
    }),
    uninstall: vi.fn(async (id, _approval, current) => {
      current();
      ghosts.splice(
        ghosts.findIndex((g) => installedGhostStoragePart(g) === id),
        1,
      );
    }),
  };
  const service = new RemotePluginManagement(deps);
  const invoke = async (
    action: string,
    input: Record<string, unknown>,
    peer = 'desktop-a',
    target?: string,
  ) =>
    (
      await service.invoke(peer, {
        collectionId: 'plugins',
        actionId: `management:${action}`,
        input,
        client: { protocolVersion: 1, primitives: ['action'] },
        ...(target ? { resourceRef: { collectionId: 'plugins', kind: 'plugin', id: target } } : {}),
      })
    ).result as PluginManagementReceipt;
  const begin = (kind: string, id: string, index = 0, peer?: string) =>
    invoke(
      'begin',
      {
        operationId: id,
        kind,
        expectedInstalledApproval: ghostInstallApprovalToken(ghosts[index].approval),
      },
      peer,
      installedGhostStoragePart(ghosts[index]),
    );
  return {
    deps,
    service,
    ghosts,
    invoke,
    begin,
    revoke: (peer: string) => revoked.add(peer),
    disconnect: () => epoch++,
    switchOwner: () => {
      owner = 'owner-b';
    },
  };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

/*
 * 测试价值（unit，内存依赖 + 假时钟；不启动 Host）：
 * - 生产入口/结果：RemotePluginManagement.invoke；回执到期/服务重建返回 NOT_FOUND，
 *   真实已提交状态仍可读，取消不能把提交成功改成取消。
 * - 依据：remotePluginManagement 的 15min 回执、进程内生命周期及提交后事实优先合同；
 *   engineering-conventions §3.2 的公开入口与时序结果要求。
 * - 缺口：已有用例仅覆盖重连保留回执及提交前取消，未覆盖到期、服务重建、提交后取消。
 * - 最小输入：一条等待确认/已成功操作跨过 TTL；同一持久状态重建服务；提交与完成之间取消。
 * - 实测耗时：本机单文件 Vitest 0.65s（35 项测试执行 16ms）；无真实等待/网络/用户数据。
 */
describe('remote plugin management receipt lifetime', () => {
  it('expires a waiting confirmation at 15 minutes even when its receipt was just read', async () => {
    const f = fixture();
    const committed: string[] = [];
    f.deps.market.install = vi.fn(async (id, _options, prompt, current) => {
      const accepted = await prompt({
        initiator: 'user',
        origin: 'market',
        facts: { kind: 'install', name: 'QA plugin', version: '1', permissions: [] },
      });
      if (!accepted) throw { code: 'MUTATION_CANCELLED' };
      current();
      committed.push(id);
    });
    await f.invoke('begin', {
      operationId: 'expires-pending',
      kind: 'install',
      pluginId: 'qa-plugin',
      expectedReleaseId: 'qa-release',
    });
    await vi.advanceTimersByTimeAsync(15 * 60_000 - 1);
    const receipt = await f.invoke('operation', { operationId: 'expires-pending' });
    expect(receipt.phase).toBe('confirmation');
    const requestId = receipt.consent!.requestId;
    await vi.advanceTimersByTimeAsync(1);
    await expect(f.invoke('operation', { operationId: 'expires-pending' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(
      f.invoke('answer', {
        operationId: 'expires-pending',
        requestId,
        confirmed: true,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(committed).toEqual([]);
    expect(f.deps.market.install).toHaveBeenCalledTimes(1);
  });

  it('forgets a completed receipt at 15 minutes without undoing or replaying its mutation', async () => {
    const f = fixture();
    await f.begin('disable', 'expires-completed');
    await flush();
    await vi.advanceTimersByTimeAsync(15 * 60_000 - 1);
    expect((await f.invoke('operation', { operationId: 'expires-completed' })).phase).toBe('succeeded');
    await vi.advanceTimersByTimeAsync(1);
    await expect(f.invoke('operation', { operationId: 'expires-completed' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect((await f.service.invoke('desktop-a', {
      collectionId: 'plugins',
      actionId: 'management:snapshot',
      client: { protocolVersion: 1, primitives: ['action'] },
      input: {},
    })).result).toMatchObject({ ghosts: [{ enabled: false }, { enabled: true }] });
    expect(f.deps.setEnabled).toHaveBeenCalledTimes(1);
  });

  it('exposes committed Host facts after service reconstruction without recovering an old receipt', async () => {
    const f = fixture();
    await f.begin('disable', 'before-restart');
    await flush();
    // Model a new Host service against the same installed state, not a real app restart.
    const restarted = new RemotePluginManagement(f.deps);
    const client = { protocolVersion: 1 as const, primitives: ['action'] };
    await expect(restarted.invoke('desktop-a', {
      collectionId: 'plugins',
      actionId: 'management:operation',
      client,
      input: { operationId: 'before-restart' },
    })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await restarted.invoke('desktop-a', {
      collectionId: 'plugins',
      actionId: 'management:snapshot',
      client,
      input: {},
    })).result).toMatchObject({ ghosts: [{ enabled: false }, { enabled: true }] });
    expect(f.deps.setEnabled).toHaveBeenCalledTimes(1);
  });

  it('keeps a committed result successful when cancellation arrives before the executor returns', async () => {
    const f = fixture();
    let finish!: () => void;
    f.deps.setEnabled = vi.fn(async (id, enabled, _approval, current) => {
      current();
      f.ghosts.find((ghost) => installedGhostStoragePart(ghost) === id)!.enabled = enabled;
      await new Promise<void>((resolve) => { finish = resolve; });
    });
    await f.begin('disable', 'cancel-after-commit');
    expect(f.ghosts.map((ghost) => ghost.enabled)).toEqual([false, true]);
    await f.invoke('cancel', { operationId: 'cancel-after-commit' });
    finish();
    await flush();
    expect((await f.invoke('operation', { operationId: 'cancel-after-commit' })).phase).toBe('succeeded');
    expect((await f.invoke('cancel', { operationId: 'cancel-after-commit' })).phase).toBe('succeeded');
    expect(f.ghosts.map((ghost) => ghost.enabled)).toEqual([false, true]);
    expect(f.deps.setEnabled).toHaveBeenCalledTimes(1);
  });
});

describe('remote plugin management receipt boundaries', () => {
  it('binds preference reads and writes to the physical instance, approval and live controller', async () => {
    const f = fixture();
    const read = vi.fn(() => ({ revision: 'a'.repeat(64), configurationRefs: [] }));
    const update = vi.fn(
      async (
        _id: string,
        _ghost: InstalledGhost,
        _input: Record<string, unknown>,
        current: () => void,
      ) => {
        current();
        return read();
      },
    );
    f.deps.preferences = { read, update } as never;
    const input = { expectedInstalledApproval: ghostInstallApprovalToken(f.ghosts[1].approval) };
    const target = installedGhostStoragePart(f.ghosts[1]);
    await f.invoke('preferences', input, 'desktop-a', target);
    expect(read).toHaveBeenCalledWith(target, f.ghosts[1]);
    await f.invoke(
      'preferences-set',
      { ...input, expectedRevision: 'a'.repeat(64), kind: 'sidebar', visible: true },
      'desktop-a',
      target,
    );
    expect(update.mock.calls[0][0]).toBe(target);
    f.ghosts[1].approval = { state: 'approved', revision: '00000000-0000-4000-8000-000000000002' };
    await expect(f.invoke('preferences-set', input, 'desktop-a', target)).rejects.toThrow();
    f.revoke('desktop-a');
    await expect(
      f.invoke(
        'preferences',
        { expectedInstalledApproval: ghostInstallApprovalToken(f.ghosts[0].approval) },
        'desktop-a',
        installedGhostStoragePart(f.ghosts[0]),
      ),
    ).rejects.toThrow();
    expect(update).toHaveBeenCalledOnce();
  });
  function projectsFixture() {
    const f = fixture();
    const projects = [
      { id: 'project-a', name: 'Cindy', path: '/host/project-a', workdir: '/host/project-a' },
      { id: 'project-b', name: 'Cindy', workdir: 'C:\\host\\project-b' },
    ];
    const disabled = new Map<string, string[]>();
    f.deps.projects = {
      list: vi.fn(async () => projects),
      disabled: (workdir) => disabled.get(workdir) ?? [],
      setDisabled: vi.fn((workdir, id, value, current) => {
        current();
        const next = new Set(disabled.get(workdir));
        if (value) next.add(id);
        else next.delete(id);
        disabled.set(workdir, [...next]);
      }),
    };
    const read = (projectId = 'project-a') =>
      f.invoke('project-state', { projectId }) as unknown as Promise<{
        projectId: string;
        revision: string;
        disabled: string[];
      }>;
    const toggle = async (
      operationId: string,
      kind: string,
      state: Awaited<ReturnType<typeof read>>,
      index = 0,
      peer?: string,
    ) =>
      f.invoke(
        'begin',
        {
          operationId,
          kind,
          projectId: state.projectId,
          expectedProjectRevision: state.revision,
          expectedInstalledApproval: ghostInstallApprovalToken(f.ghosts[index].approval),
        },
        peer,
        installedGhostStoragePart(f.ghosts[index]),
      );
    return { ...f, projects, disabled, read, toggle };
  }
  it('projects Host-issued identities and read-only display paths without exposing internal records', async () => {
    const f = projectsFixture();
    const value = (await f.invoke('snapshot', {})) as unknown as { projects: unknown[] };
    expect(value.projects).toEqual([
      { id: 'project-a', name: 'Cindy', path: '/host/project-a' },
      { id: 'project-b', name: 'Cindy' },
    ]);
    expect(value.projects[0]).not.toHaveProperty('workdir');
    const old = await fixture().invoke('snapshot', {});
    expect(old).not.toHaveProperty('projects');
  });
  it('resolves a browsed target directory once as a scope, then uses only its Host id for project writes', async () => {
    const f = projectsFixture();
    const browsed = {
      id: 'browsed',
      name: 'Other',
      path: '/target/other',
      workdir: '/target/other',
    };
    f.deps.projects!.resolve = vi.fn(async () => browsed);
    expect(await f.invoke('snapshot', {})).toHaveProperty('projectBrowse', true);
    expect(await f.invoke('project-select', { path: browsed.path })).toEqual({
      id: 'browsed',
      name: 'Other',
      path: browsed.path,
    });
    expect(f.deps.projects!.resolve).toHaveBeenCalledWith(browsed.path);
    expect(f.projects).toHaveLength(2); // Browsing must not create a task or persist a recent project.
    await expect(
      f.invoke('project-state', { projectId: browsed.id }, 'desktop-b'),
    ).rejects.toThrow();
    await expect(f.read(browsed.path)).rejects.toThrow();
    await f.toggle('browsed-disable', 'disable', await f.read(browsed.id));
    await flush();
    expect(f.disabled.get(browsed.workdir)).toEqual(['weather']);
    expect(f.ghosts[0].enabled).toBe(true);
    expect(f.deps.setEnabled).not.toHaveBeenCalled();
    f.deps.projects!.resolve = vi.fn(async () => {
      throw new Error('directory removed');
    });
    await expect(f.read(browsed.id)).rejects.toThrow('directory removed');
    f.switchOwner();
    expect((await f.invoke('snapshot', {})) as unknown as { projects: unknown[] }).toHaveProperty(
      'projects',
      [
        { id: 'project-a', name: 'Cindy', path: '/host/project-a' },
        { id: 'project-b', name: 'Cindy' },
      ],
    );
    await expect(f.read(browsed.id)).rejects.toThrow();
  });
  it('rejects unsupported browsing and late directory resolutions after owner or connection changes', async () => {
    const old = projectsFixture();
    await expect(old.invoke('project-select', { path: '/target/project' })).rejects.toThrow();
    for (const transition of ['switchOwner', 'disconnect'] as const) {
      const f = projectsFixture();
      let resolve!: (value: { id: string; name: string; workdir: string }) => void;
      f.deps.projects!.resolve = vi.fn(
        () =>
          new Promise<{ id: string; name: string; workdir: string }>((done) => {
            resolve = done;
          }),
      );
      const request = f.invoke('project-select', { path: '/target/project' });
      f[transition]();
      resolve({ id: 'late', name: 'Late', workdir: '/target/project' });
      await expect(request).rejects.toThrow();
      await expect(f.read('late')).rejects.toThrow();
    }
  });
  it('writes only the selected project and physical namespace, preserving global and other project switches', async () => {
    const f = projectsFixture();
    await f.toggle('project-disable', 'disable', await f.read(), 1);
    await flush();
    expect(f.ghosts.map((ghost) => ghost.enabled)).toEqual([true, true]);
    expect((await f.read()).disabled).toEqual([installedGhostStoragePart(f.ghosts[1])]);
    expect((await f.read('project-b')).disabled).toEqual([]);
    expect(f.deps.setEnabled).not.toHaveBeenCalled();
    await f.toggle('project-enable', 'enable', await f.read(), 1);
    await flush();
    expect((await f.read()).disabled).toEqual([]);
  });
  it('rejects stale project revision from another controller instead of overwriting exceptions', async () => {
    const f = projectsFixture();
    const state = await f.read();
    await f.toggle('controller-a', 'disable', state, 0);
    await f.toggle('controller-b', 'disable', state, 1, 'desktop-b');
    await flush();
    expect((await f.invoke('operation', { operationId: 'controller-b' }, 'desktop-b')).phase).toBe(
      'failed',
    );
    expect((await f.read()).disabled).toEqual([installedGhostStoragePart(f.ghosts[0])]);
    expect(f.deps.projects!.setDisabled).toHaveBeenCalledTimes(1);
  });
  it('rejects removed projects, arbitrary paths, malformed scope and scoped installation', async () => {
    const f = projectsFixture();
    const state = await f.read();
    f.projects.splice(0, 1);
    await f.toggle('removed', 'disable', state);
    await flush();
    expect((await f.invoke('operation', { operationId: 'removed' })).phase).toBe('failed');
    await expect(f.read('/controller/local-project')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      f.invoke('begin', { operationId: 'bad', kind: 'disable', projectId: 'project-b' }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await expect(
      f.invoke('begin', {
        operationId: 'install-scope',
        kind: 'install',
        projectId: 'project-b',
        expectedProjectRevision: state.revision,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    expect(f.deps.projects!.setDisabled).not.toHaveBeenCalled();
  });
  it('cannot enable a globally disabled plugin through project settings', async () => {
    const f = projectsFixture();
    const state = await f.read();
    f.ghosts[0].enabled = false;
    await f.toggle('global-off', 'enable', state);
    await flush();
    expect((await f.invoke('operation', { operationId: 'global-off' })).phase).toBe('failed');
    expect(f.deps.projects!.setDisabled).not.toHaveBeenCalled();
    expect(f.ghosts[0].enabled).toBe(false);
  });
  it.each(['disconnect', 'revoke', 'owner', 'approval'])(
    'invalidates pending project mutation on %s',
    async (change) => {
      const f = projectsFixture();
      const state = await f.read();
      let resolve!: (value: typeof f.projects) => void;
      f.deps.projects!.list = vi.fn<() => Promise<typeof f.projects>>(
        () =>
          new Promise<typeof f.projects>((done) => {
            resolve = done;
          }),
      );
      await f.toggle('late-project', 'disable', state);
      if (change === 'disconnect') f.disconnect();
      if (change === 'revoke') f.revoke('desktop-a');
      if (change === 'owner') f.switchOwner();
      if (change === 'approval')
        f.ghosts[0].approval = {
          state: 'approved',
          revision: '00000000-0000-4000-8000-000000000002',
        };
      resolve(f.projects);
      await flush();
      expect(f.deps.projects!.setDisabled).not.toHaveBeenCalled();
    },
  );
  it('uses physical identity for same-name plugins and does not alter the other namespace', async () => {
    const f = fixture();
    await f.begin('disable', 'one', 1);
    await flush();
    expect(f.ghosts.map((g) => g.enabled)).toEqual([true, false]);
    expect((await f.invoke('operation', { operationId: 'one' })).phase).toBe('succeeded');
    await expect(f.invoke('operation', { operationId: 'one' }, 'desktop-b')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
  it('rejects stale approval before any mutation', async () => {
    const f = fixture();
    await expect(
      f.invoke(
        'begin',
        {
          operationId: 'stale',
          kind: 'uninstall',
          expectedInstalledApproval: 'approved:00000000-0000-4000-8000-000000000002',
        },
        undefined,
        installedGhostStoragePart(f.ghosts[0]),
      ),
    ).rejects.toBeTruthy();
    expect(f.deps.uninstall).not.toHaveBeenCalled();
  });
  it('repeated begin returns its receipt after uninstall without executing again', async () => {
    const f = fixture();
    const target = installedGhostStoragePart(f.ghosts[0]);
    const input = {
      operationId: 'delete',
      kind: 'uninstall',
      expectedInstalledApproval: ghostInstallApprovalToken(f.ghosts[0].approval),
    };
    await f.invoke('begin', input, undefined, target);
    await flush();
    expect((await f.invoke('begin', input, undefined, target)).phase).toBe('succeeded');
    expect(f.deps.uninstall).toHaveBeenCalledTimes(1);
  });
  it('keeps a committed receipt across reconnect but invalidates it on owner change or revocation', async () => {
    const f = fixture();
    await f.begin('disable', 'done');
    await flush();
    f.disconnect();
    expect((await f.invoke('operation', { operationId: 'done' })).phase).toBe('succeeded');
    f.revoke('desktop-a');
    await expect(f.invoke('operation', { operationId: 'done' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    const g = fixture();
    await g.begin('enable', 'old');
    await flush();
    g.switchOwner();
    await expect(g.invoke('operation', { operationId: 'old' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
  it('queries unknown results instead of replaying installation', async () => {
    const f = fixture();
    let finish!: () => void;
    f.deps.market.install = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await f.invoke('begin', {
      operationId: 'install',
      kind: 'install',
      pluginId: 'market-weather',
      expectedReleaseId: 'r1',
    });
    expect((await f.invoke('operation', { operationId: 'install' })).phase).toBe('running');
    f.disconnect();
    finish();
    await flush();
    expect((await f.invoke('operation', { operationId: 'install' })).phase).toBe('succeeded');
    expect(f.deps.market.install).toHaveBeenCalledTimes(1);
  });
  it('binds actual package confirmation to its controller and refuses replacement after confirmation', async () => {
    const f = fixture();
    let committed = false;
    f.deps.market.install = vi.fn(async (_id, _options, prompt, current) => {
      const accepted = await prompt({
        initiator: 'user',
        origin: 'market',
        facts: { kind: 'install', name: 'Weather', version: '2.0.0', permissions: [] },
      });
      if (!accepted) throw { code: 'MUTATION_CANCELLED' };
      current();
      committed = true;
    });
    const input = {
      operationId: 'update',
      kind: 'install',
      pluginId: 'weather-market',
      expectedReleaseId: 'r2',
      expectedInstalledApproval: ghostInstallApprovalToken(f.ghosts[0].approval),
    };
    await f.invoke('begin', input, undefined, installedGhostStoragePart(f.ghosts[0]));
    const receipt = await f.invoke('operation', { operationId: 'update' });
    expect(receipt.phase).toBe('confirmation');
    await expect(
      f.invoke(
        'answer',
        { operationId: 'update', requestId: receipt.consent!.requestId, confirmed: true },
        'desktop-b',
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    f.ghosts[0].approval = { state: 'approved', revision: '00000000-0000-4000-8000-000000000002' };
    await f.invoke('answer', {
      operationId: 'update',
      requestId: receipt.consent!.requestId,
      confirmed: true,
    });
    await flush();
    expect(committed).toBe(false);
    expect((await f.invoke('operation', { operationId: 'update' })).phase).toBe('failed');
  });
  it('routes a transferred file to the original peer and physical instance without treating it as a host path', async () => {
    const f = fixture();
    f.deps.installFile = vi.fn(async (_peer, _attachment, _target, _approval, _prompt, current) => {
      current();
    });
    const target = installedGhostStoragePart(f.ghosts[0]);
    const token = ghostInstallApprovalToken(f.ghosts[0].approval);
    await f.invoke(
      'begin',
      {
        operationId: 'file',
        kind: 'install-file',
        attachment: 'attachment:fixture',
        expectedInstalledApproval: token,
      },
      'desktop-a',
      target,
    );
    await flush();
    expect(f.deps.installFile).toHaveBeenCalledExactlyOnceWith(
      'desktop-a',
      'attachment:fixture',
      target,
      token,
      expect.any(Function),
      expect.any(Function),
    );
    expect((await f.invoke('operation', { operationId: 'file' })).phase).toBe('succeeded');
  });

  it('keeps file-update authorization valid while the installer swaps the approved package', async () => {
    const f = fixture();
    const token = ghostInstallApprovalToken(f.ghosts[0].approval);
    f.deps.installFile = vi.fn(
      async (_peer, _attachment, _target, expectedApproval, _prompt, current) => {
        // The installer checks this token in its mutation lock, then stages the new
        // directory before beforePackageCommit. The old receipt no longer describes it.
        expect(expectedApproval).toBe(token);
        current();
        f.ghosts[0].manifest.version = '1.0.1';
        f.ghosts[0].approval = { state: 'invalid' };
        current();
        f.ghosts[0].approval = {
          state: 'approved',
          revision: '00000000-0000-4000-8000-000000000002',
        };
      },
    );
    await f.invoke(
      'begin',
      {
        operationId: 'file-update',
        kind: 'install-file',
        attachment: 'attachment:fixture',
        expectedInstalledApproval: token,
      },
      'desktop-a',
      installedGhostStoragePart(f.ghosts[0]),
    );
    await flush();
    expect((await f.invoke('operation', { operationId: 'file-update' })).phase).toBe('succeeded');
    expect(f.ghosts[0].manifest.version).toBe('1.0.1');
  });

  it.each(['disconnect', 'revoke', 'owner', 'cancel'])(
    'still rejects file-update commit after %s',
    async (change) => {
      const f = fixture();
      let resume!: () => void;
      let committed = false;
      const gate = new Promise<void>((resolve) => {
        resume = resolve;
      });
      f.deps.installFile = vi.fn(
        async (_peer, _attachment, _target, _approval, _prompt, current) => {
          await gate;
          current();
          committed = true;
        },
      );
      await f.invoke(
        'begin',
        {
          operationId: 'file-update',
          kind: 'install-file',
          attachment: 'attachment:fixture',
          expectedInstalledApproval: ghostInstallApprovalToken(f.ghosts[0].approval),
        },
        'desktop-a',
        installedGhostStoragePart(f.ghosts[0]),
      );
      if (change === 'disconnect') f.disconnect();
      if (change === 'revoke') f.revoke('desktop-a');
      if (change === 'owner') f.switchOwner();
      if (change === 'cancel') await f.invoke('cancel', { operationId: 'file-update' });
      resume();
      await flush();
      expect(committed).toBe(false);
    },
  );

  it.each(['disconnect', 'revoke', 'owner', 'cancel', 'package-swap'])(
    'checks market-install scope at the late commit after %s',
    async (change) => {
      const f = fixture();
      let resume!: () => void;
      const gate = new Promise<void>((resolve) => {
        resume = resolve;
      });
      let committed = false;
      f.deps.market.install = vi.fn(async (_id, _options, _prompt, current, scope) => {
        current();
        await gate;
        scope();
        committed = true;
      });
      await f.invoke(
        'begin',
        {
          operationId: 'market-update',
          kind: 'install',
          pluginId: 'market-plugin',
          expectedReleaseId: 'release',
          expectedInstalledApproval: ghostInstallApprovalToken(f.ghosts[0].approval),
        },
        'desktop-a',
        installedGhostStoragePart(f.ghosts[0]),
      );
      if (change === 'disconnect') f.disconnect();
      if (change === 'revoke') f.revoke('desktop-a');
      if (change === 'owner') f.switchOwner();
      if (change === 'cancel') await f.invoke('cancel', { operationId: 'market-update' });
      if (change === 'package-swap') f.ghosts[0].approval = { state: 'invalid' };
      resume();
      await flush();
      expect(committed).toBe(change === 'package-swap');
    },
  );
  it('rejects the superseded task-card configuration action', async () => {
    const f = fixture();
    await expect(f.begin('configure', 'configure')).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
    });
  });
  it('revokes an offline prompt while retaining a queryable cancelled receipt', async () => {
    const f = fixture();
    f.deps.market.install = vi.fn(async (_id, _opts, prompt) => {
      if (
        !(await prompt({
          initiator: 'user',
          origin: 'market',
          facts: { kind: 'install', name: 'Weather', version: '2', permissions: [] },
        }))
      )
        throw { code: 'MUTATION_CANCELLED' };
    });
    await f.invoke('begin', {
      operationId: 'pending',
      kind: 'install',
      pluginId: 'm',
      expectedReleaseId: 'r',
    });
    f.disconnect();
    f.service.invalidate();
    await flush();
    expect((await f.invoke('operation', { operationId: 'pending' })).phase).toBe('cancelled');
  });
});
