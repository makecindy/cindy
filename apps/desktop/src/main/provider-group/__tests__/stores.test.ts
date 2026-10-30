/**
 * 组设置与任务绑定的本机存储：坏形态清洗与容量淘汰；读写链路走真文件(临时目录)。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

const scope = vi.hoisted(() => ({ boundaryPending: false }));

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-group-store-test-'));
let activeOwner = 'owner-test';

vi.mock('electron', () => ({ app: { getPath: () => tmpDir } }));
vi.mock('../../maker-host/logger-adapter.js', () => ({
  desktopMakerLogger: { child: () => ({ info: () => {}, warn: () => {}, error: () => {} }) },
}));
vi.mock('../../appSessionState.js', () => ({
  ownerScopedUserDataPath: (name: string) => activeOwner === 'owner-test' ? path.join(tmpDir, name) : path.join(tmpDir, activeOwner, name),
  activeOwnerScopeKey: () => activeOwner,
  isAppSessionBoundaryPending: () => scope.boundaryPending,
}));

const store = await import('../store.js');
const bindings = await import('../bindings.js');
const locks = await import('../../device-link/crossProcessLock.js');

afterEach(() => { scope.boundaryPending = false; activeOwner = 'owner-test'; vi.restoreAllMocks(); });
afterAll(async () => { await fs.promises.rm(tmpDir, { recursive: true, force: true }); });

describe('provider group store', () => {
  it.each(['save', 'delete'])('does not %s when teardown starts before the file lock is acquired', async (action) => {
    const initial = (await store.writeProviderGroup('boundary', { members: [{ kind: 'local' }] }))!;
    const pending = store.writeProviderGroup('boundary', action === 'delete' ? null : { ...initial, autoSwitch: false }, initial);
    // updateAtomic 已开始等待写锁，但 owner key 尚未推进。
    scope.boundaryPending = true;
    await expect(pending).rejects.toThrow(/PRECONDITION_FAILED/);
    expect(store.readProviderGroup('boundary')).toEqual(initial);
  });

  it.each(['remove', 'delete'].flatMap((action) => ['owner', 'teardown'].map((boundary) => ({ action, boundary }))))(
    'keeps committed $action cleanup through $boundary, restart and rejoin', async ({ action, boundary }) => {
      const providerId = `committed-${action}-${boundary}`;
      const sessionId = `${providerId}-task`;
      const initial = (await store.writeProviderGroup(providerId, {
        members: [{ kind: 'local' }, { kind: 'device', agentDeviceId: 'mini', providerId }],
      }))!;
      const removedKey = initial.members[1].key;
      await bindings.writeProviderGroupBinding(sessionId, { providerId, memberKey: removedKey }, 1);
      await bindings.writeProviderGroupBinding(`${sessionId}-kept`, { providerId, memberKey: 'local' }, 1);
      const withLock = locks.withCrossProcessLock;
      vi.spyOn(locks, 'withCrossProcessLock').mockImplementationOnce(async (...args) => {
        const result = await withLock(...args);
        if (boundary === 'owner') activeOwner = 'new-owner';
        else scope.boundaryPending = true;
        return result;
      });
      const next = action === 'delete' ? null : { ...initial, members: [initial.members[0]] };
      await expect(store.writeProviderGroup(providerId, next)).rejects.toThrow(/PRECONDITION_FAILED/);
      if (boundary === 'owner') {
        expect(store.readProviderGroup(providerId)).toBeNull();
        expect(bindings.readProviderGroupBinding(sessionId)).toBeNull();
        expect(bindings.isProviderGroupReleased(sessionId, { providerId })).toBe(false);
      }
      activeOwner = 'owner-test';
      scope.boundaryPending = false;
      expect(store.readProviderGroup(providerId)).toEqual(next);
      // 模拟请求被账号边界拒绝，IPC 根本没有执行 pruneBindings；切回后先把成员加回来。
      await store.writeProviderGroup(providerId, initial);
      // reset-modules: verify binding cleanup survives a fresh process after the account boundary.
      vi.resetModules();
      const restarted = await import('../bindings.js');
      expect(restarted.readProviderGroupBinding(sessionId)).toBeNull();
      expect(restarted.isProviderGroupReleased(sessionId, { providerId })).toBe(true);
      expect(restarted.listProviderGroupBindings()[sessionId]).toBeUndefined();
      expect(restarted.isProviderGroupReleased(`${sessionId}-kept`, { providerId })).toBe(action === 'delete');
      // 新分配先完成旧清理，不能把新绑定吞掉；原任务只有显式重新分配才回到组里。
      await restarted.writeProviderGroupBinding(`${sessionId}-new`, { providerId, memberKey: removedKey }, 2);
      expect(restarted.readProviderGroupBinding(`${sessionId}-new`)).not.toBeNull();
      expect(restarted.isProviderGroupReleased(sessionId, { providerId })).toBe(true);
      await restarted.writeProviderGroupBinding(sessionId, { providerId, memberKey: removedKey }, 3);
      expect(restarted.readProviderGroupBinding(sessionId)).not.toBeNull();
      expect(restarted.isProviderGroupReleased(sessionId, { providerId })).toBe(false);
    },
  );

  it('drops invalid groups and empty groups when reading', () => {
    expect(store.__testing.normalize({
      groups: {
        anthropic: { strategy: 'least', members: [{ kind: 'local' }] },
        'bad id': { members: [{ kind: 'local' }] },
        empty: { members: [] },
      },
    })).toEqual({
      groups: {
        anthropic: {
          strategy: 'least',
          autoSwitch: true,
          members: [{ key: 'local', kind: 'local', agentDeviceId: null, providerId: 'anthropic', limit: 4, weight: 1, paused: false }],
        },
      },
    });
  });

  it('writes, reads back and deletes a group', async () => {
    const written = await store.writeProviderGroup('anthropic', {
      strategy: 'order',
      members: [{ kind: 'local' }, { kind: 'device', agentDeviceId: 'mini', providerId: 'anthropic-1a2b3c4d' }],
    });
    expect(written?.members).toHaveLength(2);
    expect(store.readProviderGroup('anthropic')?.strategy).toBe('order');
    await store.writeProviderGroup('anthropic', null);
    expect(store.readProviderGroup('anthropic')).toBeNull();
  });

  it('preserves another editor’s members and limits instead of overwriting them with an old snapshot', async () => {
    const initial = (await store.writeProviderGroup('stale', { members: [{ kind: 'local' }] }))!;
    const updated = (await store.writeProviderGroup('stale', {
      ...initial,
      members: [{ ...initial.members[0], limit: 8 }, { kind: 'device', agentDeviceId: 'mini', providerId: 'stale' }],
    }, initial))!;
    await expect(store.writeProviderGroup('stale', { ...initial, autoSwitch: false }, initial))
      .rejects.toThrow('[PROVIDER_GROUP_CHANGED]');
    await expect(store.writeProviderGroup('stale', null, initial)).rejects.toThrow('[PROVIDER_GROUP_CHANGED]');
    expect(store.readProviderGroup('stale')).toEqual(updated);
    // 重新读取后由用户再次修改，保留另一台已添加的电脑和上限。
    const saved = await store.writeProviderGroup('stale', { ...updated, autoSwitch: false }, updated);
    expect(saved).toEqual({ ...updated, autoSwitch: false });
  });

  it('compares under the file lock so only one of two concurrent edits can use the same snapshot', async () => {
    const initial = (await store.writeProviderGroup('concurrent', { members: [{ kind: 'local' }] }))!;
    const edits = [{ ...initial, autoSwitch: false }, { ...initial, strategy: 'round' as const }];
    const results = await Promise.allSettled(edits.map((config) => store.writeProviderGroup('concurrent', config, initial)));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ code: 'PROVIDER_GROUP_CHANGED' }) }),
    ]);
    expect(store.readProviderGroup('concurrent')).toEqual(edits[results.findIndex((result) => result.status === 'fulfilled')]);
  });

  it('protects concurrent creation and does not recreate a group deleted after it was read', async () => {
    const config = { members: [{ kind: 'local' }] };
    const created = await store.writeProviderGroup('creation', config, null);
    await expect(store.writeProviderGroup('creation', { ...config, autoSwitch: false }, null))
      .rejects.toThrow('[PROVIDER_GROUP_CHANGED]');
    expect(store.readProviderGroup('creation')).toEqual(created);
    await store.writeProviderGroup('creation', null, created);
    await expect(store.writeProviderGroup('creation', created, created)).rejects.toThrow('[PROVIDER_GROUP_CHANGED]');
    expect(store.readProviderGroup('creation')).toBeNull();
  });

  it('persists cleanup with group removal and retains it through restart, rejoin, and stale acknowledgements', async () => {
    const config = { strategy: 'least', members: [{ kind: 'local' }, { kind: 'share', agentDeviceId: 'share:a1', providerId: 'anthropic' }] };
    await store.writeProviderGroup('anthropic', config);
    await store.writeProviderGroup('anthropic', null);
    const token = store.listProviderGroupReshareCleanups()['share:a1'];
    expect(token).toBeDefined();
    const file = path.join(tmpDir, 'provider-group-prefs.json');
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ reshareCleanups: { 'share:a1': token } });
    // 重新创建存储实例，不复用缓存，证明清理来自磁盘。
    // reset-modules: reload the store to prove the cleanup token is restored from disk.
    vi.resetModules();
    const restarted = await import('../store.js');
    expect(restarted.listProviderGroupReshareCleanups()['share:a1']).toBe(token);
    await restarted.writeProviderGroup('anthropic', config);
    expect(restarted.listProviderGroupReshareCleanups()['share:a1']).toBe(token);
    await restarted.writeProviderGroup('anthropic', null);
    const nextToken = restarted.listProviderGroupReshareCleanups()['share:a1'];
    expect(nextToken).not.toBe(token);
    await restarted.completeProviderGroupReshareCleanup('share:a1', token);
    expect(restarted.listProviderGroupReshareCleanups()['share:a1']).toBe(nextToken);
    await restarted.completeProviderGroupReshareCleanup('share:a1', nextToken);
    expect(restarted.listProviderGroupReshareCleanups()).toEqual({});
  });

  it('only queues cleanup when a shared computer leaves its last group', async () => {
    const config = { members: [{ kind: 'share', agentDeviceId: 'share:overlap', providerId: 'anthropic' }] };
    await store.writeProviderGroup('anthropic', config);
    await store.writeProviderGroup('openai', config);
    await store.writeProviderGroup('anthropic', null);
    expect(store.listProviderGroupReshareCleanups()['share:overlap']).toBeUndefined();
    await store.writeProviderGroup('openai', null);
    expect(store.listProviderGroupReshareCleanups()['share:overlap']).toBeDefined();
  });

  it('preserves an unreadable file instead of overwriting its pending cleanups', async () => {
    const file = path.join(tmpDir, 'provider-group-prefs.json');
    const previous = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, '{broken-json');
    try {
      store.listProviderGroupReshareCleanups();
      await expect(store.writeProviderGroup('anthropic', null)).rejects.toThrow(/unreadable/);
      expect(fs.readFileSync(file, 'utf8')).toBe('{broken-json');
    } finally {
      fs.writeFileSync(file, previous);
    }
  });

  it('retains every removed member across rejoin and ignores an older cleanup acknowledgement', async () => {
    const providerId = 'successive-cleanups';
    const initial = (await store.writeProviderGroup(providerId, { members: [
      { kind: 'local' },
      { kind: 'device', agentDeviceId: 'mini', providerId },
      { kind: 'device', agentDeviceId: 'studio', providerId },
    ] }))!;
    for (const member of initial.members) {
      await bindings.writeProviderGroupBinding(`successive-${member.kind === 'local' ? 'local' : member.agentDeviceId}`,
        { providerId, memberKey: member.key }, 1);
    }
    await store.writeProviderGroup(providerId, { ...initial, members: [initial.members[0], initial.members[2]] });
    const first = store.listProviderGroupBindingCleanups()[providerId];
    await store.writeProviderGroup(providerId, initial);
    expect(store.listProviderGroupBindingCleanups()[providerId].token).toBe(first.token);
    await store.writeProviderGroup(providerId, { ...initial, members: [initial.members[0], initial.members[1]] });
    const second = store.listProviderGroupBindingCleanups()[providerId];
    expect(second.token).not.toBe(first.token);
    await store.completeProviderGroupBindingCleanup(providerId, first.token);
    expect(store.listProviderGroupBindingCleanups()[providerId].token).toBe(second.token);
    expect(bindings.readProviderGroupBinding('successive-local')).not.toBeNull();
    expect(bindings.readProviderGroupBinding('successive-mini')).toBeNull();
    expect(bindings.readProviderGroupBinding('successive-studio')).toBeNull();
    await bindings.writeProviderGroupBinding('successive-new', { providerId, memberKey: 'local' }, 2);
    expect(bindings.isProviderGroupReleased('successive-mini', { providerId })).toBe(true);
    expect(bindings.isProviderGroupReleased('successive-studio', { providerId })).toBe(true);
    expect(store.listProviderGroupBindingCleanups()[providerId]).toBeUndefined();
  });

  it('keeps the committed cleanup active if writing the binding release fails', async () => {
    const providerId = 'pending-write-failure';
    const config = (await store.writeProviderGroup(providerId, { members: [{ kind: 'local' }] }))!;
    await bindings.writeProviderGroupBinding('pending-old', { providerId, memberKey: 'local' }, 1);
    await store.writeProviderGroup(providerId, null);
    await store.writeProviderGroup(providerId, config);
    const pending = store.listProviderGroupBindingCleanups()[providerId];
    const file = path.join(tmpDir, 'provider-group-bindings.json');
    const before = fs.readFileSync(file, 'utf8');
    const rename = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation((source, target) => {
      if (target === file) throw new Error('disk unavailable');
      rename(source, target);
    });
    await expect(bindings.writeProviderGroupBinding('pending-new', { providerId, memberKey: 'local' }, 2))
      .rejects.toThrow('disk unavailable');
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(store.listProviderGroupBindingCleanups()[providerId]).toEqual(pending);
    expect(bindings.readProviderGroupBinding('pending-old')).toBeNull();
    expect(bindings.isProviderGroupReleased('pending-old', { providerId })).toBe(true);
    vi.restoreAllMocks();
    await bindings.writeProviderGroupBinding('pending-new', { providerId, memberKey: 'local' }, 2);
    expect(store.listProviderGroupBindingCleanups()[providerId]).toBeUndefined();
    expect(bindings.isProviderGroupReleased('pending-old', { providerId })).toBe(true);
    expect(bindings.readProviderGroupBinding('pending-new')).not.toBeNull();
  });

  it('retains pending binding cleanup through an older group-settings writer', async () => {
    const providerId = 'legacy-pending';
    const config = (await store.writeProviderGroup(providerId, { members: [{ kind: 'local' }] }))!;
    await bindings.writeProviderGroupBinding('legacy-pending-task', { providerId, memberKey: 'local' }, 1);
    await store.writeProviderGroup(providerId, null);
    const pending = store.listProviderGroupBindingCleanups()[providerId];
    const { createOverrideSettingsFile } = await import('../../maker-host/override-settings-file.js');
    const legacy = createOverrideSettingsFile<{ groups: Record<string, unknown> }>({
      filePath: () => path.join(tmpDir, 'provider-group-prefs.json'),
      defaults: { groups: {} },
      normalize: (raw) => ({ groups: (raw as { groups?: Record<string, unknown> })?.groups ?? {} }),
      log: { info: () => {}, warn: () => {} },
      label: 'legacy-provider-group',
    });
    legacy.writePatch({ groups: { ...legacy.read().groups, [providerId]: config } });
    // reset-modules: reload bindings after a legacy writer changes the on-disk schema.
    vi.resetModules();
    const restarted = await import('../bindings.js');
    expect(store.listProviderGroupBindingCleanups()[providerId]).toEqual(pending);
    expect(restarted.readProviderGroupBinding('legacy-pending-task')).toBeNull();
    expect(restarted.isProviderGroupReleased('legacy-pending-task', { providerId })).toBe(true);
  });

  it('replays an unacknowledged cleanup if teardown begins after the release was committed', async () => {
    const providerId = 'pending-ack';
    const config = (await store.writeProviderGroup(providerId, { members: [{ kind: 'local' }] }))!;
    await bindings.writeProviderGroupBinding('pending-ack-old', { providerId, memberKey: 'local' }, 1);
    await store.writeProviderGroup(providerId, null);
    const pending = store.listProviderGroupBindingCleanups()[providerId];
    const withLock = locks.withCrossProcessLock;
    let interrupted = false;
    vi.spyOn(locks, 'withCrossProcessLock').mockImplementation(async (...args) => {
      const result = await withLock(...args);
      if (!interrupted && args[0].endsWith('provider-group-bindings.json.lock')) {
        interrupted = true;
        scope.boundaryPending = true;
      }
      return result;
    });
    await expect(bindings.pruneProviderGroupBindings(providerId, null)).rejects.toThrow(/PRECONDITION_FAILED/);
    expect(store.listProviderGroupBindingCleanups()[providerId]).toEqual(pending);
    const file = JSON.parse(fs.readFileSync(path.join(tmpDir, 'provider-group-bindings.json'), 'utf8'));
    expect(file.released['pending-ack-old'].providerId).toBe(providerId);
    scope.boundaryPending = false;
    await store.writeProviderGroup(providerId, config);
    await bindings.writeProviderGroupBinding('pending-ack-new', { providerId, memberKey: 'local' }, 2);
    expect(store.listProviderGroupBindingCleanups()[providerId]).toBeUndefined();
    expect(bindings.isProviderGroupReleased('pending-ack-old', { providerId })).toBe(true);
    expect(bindings.readProviderGroupBinding('pending-ack-new')).not.toBeNull();
  });

  it('does not let a concurrent stale cleanup remove a fresh assignment', async () => {
    const providerId = 'concurrent-pending';
    const config = (await store.writeProviderGroup(providerId, { members: [{ kind: 'local' }] }))!;
    await bindings.writeProviderGroupBinding('concurrent-pending-old', { providerId, memberKey: 'local' }, 1);
    await store.writeProviderGroup(providerId, null);
    await store.writeProviderGroup(providerId, config);
    const withLock = locks.withCrossProcessLock;
    let queued = false;
    let startingSecond = false;
    let second: Promise<void> | undefined;
    let resumeSecond!: () => void;
    const pauseSecond = new Promise<void>((resolve) => { resumeSecond = resolve; });
    vi.spyOn(locks, 'withCrossProcessLock').mockImplementation(async (...args) => {
      if (args[0].endsWith('provider-group-bindings.json.lock')) {
        if (!queued) {
          const result = await withLock(...args);
          queued = true;
          // 第一轮已解除旧绑定、尚未确认意图；另一写方此时仍可看到待清理快照。
          startingSecond = true;
          second = bindings.writeProviderGroupBinding('concurrent-pending-b', { providerId, memberKey: 'local' }, 3);
          startingSecond = false;
          return result;
        }
        if (startingSecond) await pauseSecond;
      }
      return withLock(...args);
    });
    try {
      await bindings.writeProviderGroupBinding('concurrent-pending-a', { providerId, memberKey: 'local' }, 2);
    } finally {
      resumeSecond();
    }
    await second;
    expect(bindings.readProviderGroupBinding('concurrent-pending-a')).not.toBeNull();
    expect(bindings.readProviderGroupBinding('concurrent-pending-b')).not.toBeNull();
    expect(bindings.isProviderGroupReleased('concurrent-pending-old', { providerId })).toBe(true);
  });

  it('does not prune a fresh assignment when an older delete command resumes after group recreation', async () => {
    const providerId = 'late-delete';
    const config = (await store.writeProviderGroup(providerId, { members: [{ kind: 'local' }] }))!;
    await bindings.writeProviderGroupBinding('late-delete-old', { providerId, memberKey: 'local' }, 1);
    await store.writeProviderGroup(providerId, null);
    await store.writeProviderGroup(providerId, config);
    await bindings.writeProviderGroupBinding('late-delete-new', { providerId, memberKey: 'local' }, 2);
    // 之前的 delete 请求刚从 writeGroup 返回，此时不应再按旧的 null 快照解除新绑定。
    await bindings.pruneProviderGroupBindings(providerId, null, 3);
    expect(bindings.isProviderGroupReleased('late-delete-old', { providerId })).toBe(true);
    expect(bindings.readProviderGroupBinding('late-delete-new')).not.toBeNull();
  });
});

describe('provider group bindings', () => {
  it('keeps bindings and release records unchanged when teardown starts during the write-lock wait', async () => {
    await bindings.writeProviderGroupBinding('boundary-task', { providerId: 'boundary', memberKey: 'local' }, 1);
    const pending = bindings.pruneProviderGroupBindings('boundary', null);
    scope.boundaryPending = true;
    await expect(pending).rejects.toThrow(/PRECONDITION_FAILED/);
    expect(bindings.readProviderGroupBinding('boundary-task')).toMatchObject({ providerId: 'boundary', memberKey: 'local' });
    expect(bindings.isProviderGroupReleased('boundary-task', { providerId: 'boundary' })).toBe(false);
  });

  it('keeps only well-formed bindings', () => {
    expect(bindings.__testing.normalize({
      sessions: {
        s1: { providerId: 'anthropic', memberKey: 'local', at: 5 },
        's 2': { providerId: 'anthropic', memberKey: 'local', at: 5 },
        s3: { providerId: 'bad id', memberKey: 'local' },
      },
    })).toEqual({ sessions: { s1: { providerId: 'anthropic', memberKey: 'local', at: 5 } } });
  });

  it('evicts the oldest bindings beyond capacity', () => {
    const sessions = Object.fromEntries(
      Array.from({ length: bindings.MAX_PROVIDER_GROUP_BINDINGS + 3 }, (_, i) => [`s${i}`, { providerId: 'p', memberKey: 'local', at: i }]),
    );
    const pruned = bindings.__testing.prune(sessions);
    expect(Object.keys(pruned)).toHaveLength(bindings.MAX_PROVIDER_GROUP_BINDINGS);
    expect(pruned.s0).toBeUndefined();
    expect(pruned[`s${bindings.MAX_PROVIDER_GROUP_BINDINGS + 2}`]).toBeDefined();
  });

  it('writes and clears a binding', async () => {
    await bindings.writeProviderGroupBinding('s1', { providerId: 'anthropic', memberKey: 'device:mini:x' }, 42);
    expect(bindings.readProviderGroupBinding('s1')).toEqual({ providerId: 'anthropic', memberKey: 'device:mini:x', at: 42 });
    await bindings.writeProviderGroupBinding('s1', null);
    expect(bindings.readProviderGroupBinding('s1')).toBeNull();
  });

  it('releases bindings of removed computers and of deleted groups only', async () => {
    await bindings.writeProviderGroupBinding('a', { providerId: 'anthropic', memberKey: 'local' }, 1);
    await bindings.writeProviderGroupBinding('b', { providerId: 'anthropic', memberKey: 'device:mini:x' }, 2);
    await bindings.writeProviderGroupBinding('c', { providerId: 'openai', memberKey: 'device:mini:y' }, 3);
    await bindings.pruneProviderGroupBindings('anthropic', new Set(['local']));
    expect(bindings.readProviderGroupBinding('a')).not.toBeNull();
    expect(bindings.readProviderGroupBinding('b')).toBeNull();
    expect(bindings.readProviderGroupBinding('c')).not.toBeNull();
    await bindings.pruneProviderGroupBindings('anthropic', null);
    expect(bindings.readProviderGroupBinding('a')).toBeNull();
    expect(bindings.readProviderGroupBinding('c')).not.toBeNull();
  });

  it('does not write old cleanup releases into the new account after the binding write lock is released', async () => {
    activeOwner = 'new-owner';
    await bindings.writeProviderGroupBinding('scope-task', { providerId: 'anthropic', memberKey: 'local' }, 1);
    activeOwner = 'owner-test';
    await bindings.writeProviderGroupBinding('scope-task', { providerId: 'anthropic', memberKey: 'local' }, 1);
    const withLock = locks.withCrossProcessLock;
    vi.spyOn(locks, 'withCrossProcessLock').mockImplementationOnce(async (...args) => {
      const result = await withLock(...args);
      // 落盘成功，但释放锁的异步收尾返回前切账号。
      activeOwner = 'new-owner';
      return result;
    });
    await bindings.pruneProviderGroupBindings('anthropic', null, 10);
    expect(bindings.readProviderGroupBinding('scope-task')).not.toBeNull();
    expect(bindings.isProviderGroupReleased('scope-task', { providerId: 'anthropic' })).toBe(false);
    activeOwner = 'owner-test';
    expect(bindings.readProviderGroupBinding('scope-task')).toBeNull();
    expect(bindings.isProviderGroupReleased('scope-task', { providerId: 'anthropic' })).toBe(true);
    // 切回原账号并重建运行时，解除记录仍须保留，不能把任务重新自动纳入。
    // reset-modules: account switch must be observed by a newly loaded bindings runtime.
    vi.resetModules();
    const restarted = await import('../bindings.js');
    expect(restarted.readProviderGroupBinding('scope-task')).toBeNull();
    expect(restarted.isProviderGroupReleased('scope-task', { providerId: 'anthropic' })).toBe(true);
  });

  it('persists the release with binding removal if teardown begins during lock release', async () => {
    await bindings.writeProviderGroupBinding('teardown-release', { providerId: 'boundary-release', memberKey: 'local' }, 1);
    const withLock = locks.withCrossProcessLock;
    vi.spyOn(locks, 'withCrossProcessLock').mockImplementationOnce(async (...args) => {
      const result = await withLock(...args);
      scope.boundaryPending = true;
      return result;
    });
    await bindings.pruneProviderGroupBindings('boundary-release', null, 10);
    expect(bindings.readProviderGroupBinding('teardown-release')).toBeNull();
    expect(bindings.isProviderGroupReleased('teardown-release', { providerId: 'boundary-release' })).toBe(true);
    const persisted = JSON.parse(fs.readFileSync(path.join(tmpDir, 'provider-group-bindings.json'), 'utf8'));
    expect(persisted.sessions?.['teardown-release']).toBeUndefined();
    expect(persisted.released['teardown-release']).toEqual({ providerId: 'boundary-release', at: 10 });
  });

  it('keeps the binding and release unchanged if the atomic replacement fails', async () => {
    await bindings.writeProviderGroupBinding('failed-release', { providerId: 'failed-release', memberKey: 'local' }, 1);
    const file = path.join(tmpDir, 'provider-group-bindings.json');
    const before = fs.readFileSync(file, 'utf8');
    const rename = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation((source, target) => {
      if (target === file) throw new Error('disk unavailable');
      rename(source, target);
    });
    await expect(bindings.pruneProviderGroupBindings('failed-release', null, 10)).rejects.toThrow('disk unavailable');
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(bindings.readProviderGroupBinding('failed-release')).toMatchObject({ providerId: 'failed-release', at: 1 });
    expect(bindings.isProviderGroupReleased('failed-release', { providerId: 'failed-release' })).toBe(false);
  });

  it('remembers, per group, the tasks released by removing a computer or deleting the group', async () => {
    await bindings.writeProviderGroupBinding('x1', { providerId: 'anthropic', memberKey: 'device:mini:x' }, 1);
    await bindings.writeProviderGroupBinding('x2', { providerId: 'anthropic', memberKey: 'local' }, 2);
    await bindings.pruneProviderGroupBindings('anthropic', new Set(['local']), 10);
    expect(bindings.isProviderGroupReleased('x1', { providerId: 'anthropic' })).toBe(true);
    expect(bindings.isProviderGroupReleased('x1', { providerId: 'anthropic', groupDeviceId: 'mini' })).toBe(false);
    expect(bindings.isProviderGroupReleased('x1', { providerId: 'openai' })).toBe(false);
    expect(bindings.isProviderGroupReleased('x2', { providerId: 'anthropic' })).toBe(false);

    await bindings.markProviderGroupReleased('x3', { providerId: 'anthropic', groupDeviceId: 'mini' }, 11);
    expect(bindings.isProviderGroupReleased('x3', { providerId: 'anthropic', groupDeviceId: 'mini' })).toBe(true);
    expect(bindings.isProviderGroupReleased('x3', { providerId: 'anthropic', groupDeviceId: null })).toBe(false);
    // 单独一个文件：旧版本只读绑定文件，读不到也改写不到它。
    expect(fs.existsSync(path.join(tmpDir, 'provider-group-released.json'))).toBe(true);

    // 由同一个组重新分配(例如清空后当作新任务)时作废；别的组的分配不影响。
    await bindings.writeProviderGroupBinding('x1', { providerId: 'openai', memberKey: 'local' }, 12);
    expect(bindings.isProviderGroupReleased('x1', { providerId: 'anthropic' })).toBe(true);
    await bindings.writeProviderGroupBinding('x1', { providerId: 'anthropic', memberKey: 'local' }, 13);
    expect(bindings.isProviderGroupReleased('x1', { providerId: 'anthropic' })).toBe(false);
  });

  it('keeps only well-formed release records', () => {
    expect(bindings.__testing.normalizeReleased({
      sessions: {
        a: { providerId: 'anthropic', at: 1 },
        b: { providerId: 'anthropic', groupDeviceId: 'mini', at: 2 },
        c: { providerId: 'bad id', at: 3 },
        d: { providerId: 'anthropic', groupDeviceId: 'bad id', at: 4 },
        'e e': { providerId: 'anthropic', at: 5 },
      },
    })).toEqual({
      sessions: {
        a: { providerId: 'anthropic', at: 1 },
        b: { providerId: 'anthropic', groupDeviceId: 'mini', at: 2 },
      },
    });
  });

  it('normalizes inline local releases without accepting another computer’s group', () => {
    expect(bindings.__testing.normalize({
      sessions: { valid: { providerId: 'anthropic', memberKey: 'local', at: 20 } },
      released: {
        valid: { providerId: 'anthropic', at: 10 },
        remote: { providerId: 'anthropic', groupDeviceId: 'mini', at: 10 },
        invalid: { providerId: 'bad id', at: 10 },
      },
    })).toEqual({ sessions: {}, released: { valid: { providerId: 'anthropic', at: 10 } } });
  });

  it('retains inline releases through an older writer and clears them on explicit reassignment', async () => {
    await bindings.writeProviderGroupBinding('legacy-release', { providerId: 'legacy-group', memberKey: 'local' }, 1);
    await bindings.pruneProviderGroupBindings('legacy-group', null, 10);
    const { createOverrideSettingsFile } = await import('../../maker-host/override-settings-file.js');
    // 旧版本只认识 sessions；共享存储基座仍须原样保留未知 released 根字段。
    const legacy = createOverrideSettingsFile<{ sessions: Record<string, unknown> }>({
      filePath: () => path.join(tmpDir, 'provider-group-bindings.json'),
      defaults: { sessions: {} },
      normalize: (raw) => ({ sessions: (raw as { sessions?: Record<string, unknown> }).sessions ?? {} }),
      label: 'legacy-bindings',
      log: { info: () => {}, warn: () => {} },
    });
    legacy.writePatch({ sessions: { ...legacy.read().sessions, 'legacy-release': { providerId: 'legacy-group', memberKey: 'local', at: 20 } } });
    // reset-modules: reload bindings to exercise compatibility with the older writer's persisted shape.
    vi.resetModules();
    const restarted = await import('../bindings.js');
    expect(restarted.readProviderGroupBinding('legacy-release')).toBeNull();
    expect(restarted.isProviderGroupReleased('legacy-release', { providerId: 'legacy-group' })).toBe(true);
    await restarted.writeProviderGroupBinding('legacy-release', { providerId: 'legacy-group', memberKey: 'local' }, 30);
    expect(restarted.readProviderGroupBinding('legacy-release')).toMatchObject({ providerId: 'legacy-group', at: 30 });
    expect(restarted.isProviderGroupReleased('legacy-release', { providerId: 'legacy-group' })).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(tmpDir, 'provider-group-bindings.json'), 'utf8')).released?.['legacy-release']).toBeUndefined();
  });

  it('preserves an unreadable binding file and refuses to overwrite its release records', async () => {
    const file = path.join(tmpDir, 'provider-group-bindings.json');
    const previous = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, '{broken-json');
    try {
      await expect(bindings.writeProviderGroupBinding('unreadable-release', { providerId: 'anthropic', memberKey: 'local' })).rejects.toThrow(/unreadable/);
      expect(fs.readFileSync(file, 'utf8')).toBe('{broken-json');
    } finally {
      fs.writeFileSync(file, previous);
    }
  });

  it('keeps bindings to a group on another computer in their own file, one group per task', async () => {
    await bindings.writeProviderGroupBinding('r1', { providerId: 'anthropic', memberKey: 'local', groupDeviceId: 'mini' }, 7);
    expect(bindings.readProviderGroupBinding('r1')).toEqual({ providerId: 'anthropic', memberKey: 'local', groupDeviceId: 'mini', at: 7 });
    // 本机的组只数本机那份：另一台电脑的组不进本机分配器的统计，也不被本机删组时清掉。
    expect(bindings.listProviderGroupBindings().r1).toBeUndefined();
    expect(bindings.listRemoteProviderGroupBindings().r1).toBeDefined();
    await bindings.pruneProviderGroupBindings('anthropic', null);
    expect(bindings.readProviderGroupBinding('r1')).not.toBeNull();
    // 降级后的旧版本只读本机那份，读不到它。
    const localFile = JSON.parse(fs.readFileSync(path.join(tmpDir, 'provider-group-bindings.json'), 'utf8'));
    expect(localFile.sessions?.r1).toBeUndefined();
    // 改归本机的组时另一份里的同一任务一并清掉。
    await bindings.writeProviderGroupBinding('r1', { providerId: 'anthropic', memberKey: 'local' }, 8);
    expect(bindings.readProviderGroupBinding('r1')).toEqual({ providerId: 'anthropic', memberKey: 'local', at: 8 });
    expect(bindings.listRemoteProviderGroupBindings().r1).toBeUndefined();
    await bindings.writeProviderGroupBinding('r1', null);
    expect(bindings.readProviderGroupBinding('r1')).toBeNull();
  });

  it('drops remote bindings without a valid group computer', () => {
    expect(bindings.__testing.normalizeRemote({
      sessions: {
        r1: { providerId: 'anthropic', memberKey: 'local', groupDeviceId: 'mini', at: 1 },
        r2: { providerId: 'anthropic', memberKey: 'local' },
        r3: { providerId: 'anthropic', memberKey: 'local', groupDeviceId: 'bad id' },
      },
    })).toEqual({ sessions: { r1: { providerId: 'anthropic', memberKey: 'local', groupDeviceId: 'mini', at: 1 } } });
  });
});
