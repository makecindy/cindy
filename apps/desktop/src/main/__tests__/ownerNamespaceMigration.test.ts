import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { dataOwnerStorageKey } from '../appSessionState.js';
import {
  claimLegacyOwnerNamespace,
  getLegacyGhostRecoveryStatus,
  hasLegacyOwnerNamespaceClaim,
  hasExclusiveSharedLegacyUserDataAccess,
  isLegacyOwnerNamespaceClaimOwnedBy,
  isLegacyOwnerNamespaceClaimedByOtherOwner,
  listLegacyGhostTombstoneRoots,
  recoverLegacyGhostPlugins,
  __testing,
} from '../ownerNamespaceMigration.js';

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-namespace-migration-'));
  roots.push(root);
  return root;
}

/**
 * Chromium uses a relative file symlink for SingletonLock on macOS/Linux.
 * Windows local test hosts may not have file-symlink privileges, so use a
 * directory junction whose readlink target preserves the same trailing PID.
 */
async function writeSingletonLock(root: string, pid: number): Promise<void> {
  const lockTarget = `myhost-${pid}`;
  if (process.platform === 'win32') {
    const junctionTarget = path.join(root, 'singleton-lock-targets', lockTarget);
    await fs.mkdir(junctionTarget, { recursive: true });
    await fs.symlink(junctionTarget, path.join(root, 'SingletonLock'), 'junction');
    return;
  }
  await fs.symlink(lockTarget, path.join(root, 'SingletonLock'));
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

beforeEach(() => {
  __testing.resetLegacyGhostRecoveryState();
});

describe('claimLegacyOwnerNamespace', () => {
  it.each(['local', 'signed-out'] as const)('%s never resolves or scans userData', async (mode) => {
    const userDataDir = vi.fn(() => {
      throw new Error('must not resolve userData');
    });
    await expect(
      claimLegacyOwnerNamespace(
        { mode, dataOwnerId: mode === 'local' ? 'local-v1' : null, user: null },
        { userDataDir } as never,
      ),
    ).resolves.toEqual({ status: 'skipped', moved: 0, conflicts: 0 });
    expect(userDataDir).not.toHaveBeenCalled();
  });

  it('moves known legacy paths without overwriting existing scoped data', async () => {
    const root = await tempRoot();
    const ownerId = 'cloud-a';
    const targetRoot = path.join(root, 'owners', dataOwnerStorageKey(ownerId));
    await fs.mkdir(path.join(root, 'ghost-kv'), { recursive: true });
    await fs.writeFile(path.join(root, 'ghost-kv', 'moved.json'), 'legacy');
    await fs.writeFile(path.join(root, 'ghost-kv', 'conflict.json'), 'legacy-conflict');
    await fs.mkdir(path.join(targetRoot, 'ghost-kv'), { recursive: true });
    await fs.writeFile(path.join(targetRoot, 'ghost-kv', 'conflict.json'), 'scoped');
    await fs.writeFile(path.join(root, 'ghost-cindy-prefs.json'), 'legacy-prefs');
    await fs.mkdir(path.join(root, 'learn'), { recursive: true });
    await fs.writeFile(path.join(root, 'learn', 'runs.json'), 'legacy-runs');
    await fs.writeFile(path.join(root, 'slack-hook.json'), 'legacy-hook');
    await fs.writeFile(path.join(root, 'hook-bindings.json'), 'legacy-bindings');
    await fs.writeFile(path.join(root, 'voice-input-models.json'), 'legacy-voice-models');
    await fs.writeFile(path.join(root, 'voice-input-data.v1.json'), 'legacy-voice-data');
    await fs.writeFile(path.join(root, 'subagent-model-settings.json'), 'legacy-subagent-models');
    await fs.mkdir(path.join(root, 'cindy-brain', 'user-plugin'), { recursive: true });
    await fs.writeFile(path.join(root, 'cindy-brain', 'user-plugin', 'manifest.json'), '{}');
    await fs.mkdir(path.join(root, 'maker-contacts'), { recursive: true });
    await fs.writeFile(path.join(root, 'maker-contacts', 'contacts.db'), 'legacy-contacts');

    const result = await claimLegacyOwnerNamespace(
      { mode: 'cloud', dataOwnerId: ownerId, user: { id: ownerId } },
      realFsDeps(root),
    );

    expect(result).toMatchObject({ status: 'migrated', conflicts: 1 });
    await expect(fs.readFile(path.join(targetRoot, 'ghost-kv', 'moved.json'), 'utf-8')).resolves.toBe('legacy');
    await expect(fs.readFile(path.join(targetRoot, 'ghost-kv', 'conflict.json'), 'utf-8')).resolves.toBe('scoped');
    await expect(fs.readFile(path.join(root, 'ghost-kv', 'conflict.json'), 'utf-8')).resolves.toBe('legacy-conflict');
    await expect(fs.readFile(path.join(targetRoot, 'ghost-cindy-prefs.json'), 'utf-8')).resolves.toBe('legacy-prefs');
    await expect(fs.readFile(path.join(targetRoot, 'learn', 'runs.json'), 'utf-8')).resolves.toBe('legacy-runs');
    await expect(fs.readFile(path.join(targetRoot, 'slack-hook.json'), 'utf-8')).resolves.toBe('legacy-hook');
    await expect(fs.readFile(path.join(targetRoot, 'hook-bindings.json'), 'utf-8')).resolves.toBe('legacy-bindings');
    await expect(fs.readFile(path.join(targetRoot, 'voice-input-models.json'), 'utf-8')).resolves.toBe('legacy-voice-models');
    await expect(fs.readFile(path.join(targetRoot, 'voice-input-data.v1.json'), 'utf-8')).resolves.toBe('legacy-voice-data');
    await expect(fs.readFile(path.join(targetRoot, 'subagent-model-settings.json'), 'utf-8')).resolves.toBe('legacy-subagent-models');
    await expect(fs.readFile(path.join(targetRoot, 'maker-contacts', 'contacts.db'), 'utf-8')).resolves.toBe('legacy-contacts');
    await expect(fs.readFile(path.join(targetRoot, 'cindy-brain', 'user-plugin', 'manifest.json'), 'utf-8')).resolves.toBe('{}');
  });

  it('passive shared-userData instance defers the claim without touching anything', async () => {
    const root = await tempRoot();
    await fs.writeFile(path.join(root, 'slack-hook.json'), 'legacy-hook');

    const result = await claimLegacyOwnerNamespace(
      { mode: 'cloud', dataOwnerId: 'cloud-a', user: { id: 'cloud-a' } },
      realFsDeps(root, { passiveSharedUserData: () => true }),
    );

    expect(result).toEqual({
      status: 'deferred',
      moved: 0,
      conflicts: 0,
      deferredReason: 'passive-shared-user-data',
    });
    // 文件留在原地、marker 未创建:被动实例保持只读,不打断共享同一 userData 的旧版本实例。
    await expect(fs.readFile(path.join(root, 'slack-hook.json'), 'utf-8')).resolves.toBe('legacy-hook');
    await expect(fs.access(path.join(root, __testing.CLAIM_MARKER))).rejects.toThrow();
    expect(hasLegacyOwnerNamespaceClaim('cloud-a', root)).toBe(false);
  });

  it('defers the claim while another live instance shares this userData', async () => {
    const root = await tempRoot();
    await fs.writeFile(path.join(root, 'slack-hook.json'), 'legacy-hook');
    await writeDevInstanceRecord(root, 4242);
    await writeDevInstanceRecord(root, process.pid); // 自己的记录不算并发

    const result = await claimLegacyOwnerNamespace(
      { mode: 'cloud', dataOwnerId: 'cloud-a', user: { id: 'cloud-a' } },
      realFsDeps(root, { isPidAlive: (pid) => pid === 4242 }),
    );

    expect(result).toEqual({
      status: 'deferred',
      moved: 0,
      conflicts: 0,
      deferredReason: 'concurrent-live-instances',
    });
    await expect(fs.readFile(path.join(root, 'slack-hook.json'), 'utf-8')).resolves.toBe('legacy-hook');
    await expect(fs.access(path.join(root, __testing.CLAIM_MARKER))).rejects.toThrow();
  });

  it('fails closed (defers) when a registry record exists but cannot be read', async () => {
    const root = await tempRoot();
    await fs.writeFile(path.join(root, 'slack-hook.json'), 'legacy-hook');
    await writeDevInstanceRecord(root, 4242);
    const recordPath = path.join(root, '.dev-instances', '4242.json');

    const result = await claimLegacyOwnerNamespace(
      { mode: 'cloud', dataOwnerId: 'cloud-a', user: { id: 'cloud-a' } },
      realFsDeps(root, undefined, {
        readFile: (file: string) =>
          file === recordPath
            ? Promise.reject(Object.assign(new Error('EACCES'), { code: 'EACCES' }))
            : fs.readFile(file, 'utf-8'),
      }),
    );

    // 读不到的记录后面可能藏着活实例:按独占迁移契约 fail closed,推迟而不是忽略。
    expect(result).toEqual({
      status: 'deferred',
      moved: 0,
      conflicts: 0,
      deferredReason: 'concurrent-live-instances',
    });
    await expect(fs.readFile(path.join(root, 'slack-hook.json'), 'utf-8')).resolves.toBe('legacy-hook');
  });

  it('interrupts mid-claim when an instance registers during the move, then resumes next exclusive start', async () => {
    const root = await tempRoot();
    // LEGACY_PATHS 顺序:ghost-cindy-prefs.json 在 slack-hook.json 之前。
    await fs.writeFile(path.join(root, 'ghost-cindy-prefs.json'), 'legacy-prefs');
    await fs.writeFile(path.join(root, 'slack-hook.json'), 'legacy-hook');
    let scans = 0;
    // 前两次扫描(入口 guard + 第一个存在 path 前)无并发;之后模拟窗口内新实例登记。
    const racedDeps = realFsDeps(
      root,
      { isPidAlive: (pid) => pid === 9999 },
      {
        readdir: (dir: string) => {
          if (path.basename(dir) === '.dev-instances') {
            scans += 1;
            return Promise.resolve(scans <= 2 ? [] : ['9999.json']);
          }
          return fs.readdir(dir);
        },
        readFile: (file: string) =>
          path.basename(file) === '9999.json'
            ? Promise.resolve(JSON.stringify({ pid: 9999, userDataDir: root }))
            : fs.readFile(file, 'utf-8'),
      },
    );

    const raced = await claimLegacyOwnerNamespace(
      { mode: 'cloud', dataOwnerId: 'cloud-a', user: { id: 'cloud-a' } },
      racedDeps,
    );

    const targetRoot = path.join(root, 'owners', dataOwnerStorageKey('cloud-a'));
    expect(raced).toMatchObject({ status: 'partial', moved: 1 });
    await expect(fs.readFile(path.join(targetRoot, 'ghost-cindy-prefs.json'), 'utf-8')).resolves.toBe('legacy-prefs');
    // 后续 path 未搬,留在 legacy 根;marker 保持未 complete。
    await expect(fs.readFile(path.join(root, 'slack-hook.json'), 'utf-8')).resolves.toBe('legacy-hook');
    expect(hasLegacyOwnerNamespaceClaim('cloud-a', root)).toBe(false);

    // 下次独占启动续跑:剩余 path 补齐,claim 完成。
    const resumed = await claimLegacyOwnerNamespace(
      { mode: 'cloud', dataOwnerId: 'cloud-a', user: { id: 'cloud-a' } },
      realFsDeps(root),
    );
    expect(resumed).toMatchObject({ status: 'migrated' });
    await expect(fs.readFile(path.join(targetRoot, 'slack-hook.json'), 'utf-8')).resolves.toBe('legacy-hook');
    expect(hasLegacyOwnerNamespaceClaim('cloud-a', root)).toBe(true);
  });

  it('keeps rollback-compatible sidebar state at the legacy path after claiming it', async () => {
    const root = await tempRoot();
    const ownerId = 'cloud-a';
    const legacySidebar = path.join(root, 'sidebar-settings.json');
    const scopedSidebar = path.join(
      root,
      'owners',
      dataOwnerStorageKey(ownerId),
      'sidebar-settings.json',
    );
    await fs.writeFile(legacySidebar, JSON.stringify({ pinnedOrder: ['legacy-session'] }));

    const result = await claimLegacyOwnerNamespace(
      { mode: 'cloud', dataOwnerId: ownerId, user: { id: ownerId } },
      realFsDeps(root),
    );

    expect(result).toEqual({ status: 'migrated', moved: 0, conflicts: 0 });
    await expect(fs.readFile(legacySidebar, 'utf-8')).resolves.toContain('legacy-session');
    await expect(fs.access(scopedSidebar)).rejects.toThrow();
    expect(hasLegacyOwnerNamespaceClaim(ownerId, root)).toBe(true);
    expect(isLegacyOwnerNamespaceClaimOwnedBy(ownerId, root)).toBe(true);
  });

  it('defers when a pre-patch packaged instance holds a live SingletonLock', async () => {
    const root = await tempRoot();
    await fs.writeFile(path.join(root, 'slack-hook.json'), 'legacy-hook');
    // 历史 packaged build 不写 .dev-instances,但持有 Chromium 单例锁 symlink。
    await writeSingletonLock(root, 4242);

    const result = await claimLegacyOwnerNamespace(
      { mode: 'cloud', dataOwnerId: 'cloud-a', user: { id: 'cloud-a' } },
      realFsDeps(
        root,
        { isPidAlive: (pid) => pid === 4242 },
        { readlink: () => Promise.resolve('myhost-4242') },
      ),
    );

    expect(result).toEqual({
      status: 'deferred',
      moved: 0,
      conflicts: 0,
      deferredReason: 'concurrent-live-instances',
    });
    await expect(fs.readFile(path.join(root, 'slack-hook.json'), 'utf-8')).resolves.toBe('legacy-hook');
  });

  it('ignores a stale SingletonLock whose pid is dead and migrates normally', async () => {
    const root = await tempRoot();
    await fs.writeFile(path.join(root, 'slack-hook.json'), 'legacy-hook');
    await writeSingletonLock(root, 4242);

    const result = await claimLegacyOwnerNamespace(
      { mode: 'cloud', dataOwnerId: 'cloud-a', user: { id: 'cloud-a' } },
      realFsDeps(root, {}, { readlink: () => Promise.resolve('myhost-4242') }),
      // isPidAlive 恒 false = 崩溃残留
    );

    expect(result).toMatchObject({ status: 'migrated' });
    const targetRoot = path.join(root, 'owners', dataOwnerStorageKey('cloud-a'));
    await expect(fs.readFile(path.join(targetRoot, 'slack-hook.json'), 'utf-8')).resolves.toBe('legacy-hook');
  });

  it('interrupts a long directory merge when an instance registers mid-recursion', async () => {
    const root = await tempRoot();
    // dialogues 目录与 target 同名目录并存 → 走逐子项合并递归(而非单次 rename)。
    await fs.mkdir(path.join(root, 'dialogues'), { recursive: true });
    await fs.writeFile(path.join(root, 'dialogues', 'a.json'), 'a');
    await fs.writeFile(path.join(root, 'dialogues', 'b.json'), 'b');
    const targetRoot = path.join(root, 'owners', dataOwnerStorageKey('cloud-a'));
    await fs.mkdir(path.join(targetRoot, 'dialogues'), { recursive: true });

    let scans = 0;
    // 前两次注册表扫描(入口 guard + dialogues per-path)无并发;递归内复查时出现。
    const racedDeps = realFsDeps(
      root,
      { isPidAlive: (pid) => pid === 9999 },
      {
        readdir: (dir: string) => {
          if (path.basename(dir) === '.dev-instances') {
            scans += 1;
            return Promise.resolve(scans <= 2 ? [] : ['9999.json']);
          }
          return fs.readdir(dir);
        },
        readFile: (file: string) =>
          path.basename(file) === '9999.json'
            ? Promise.resolve(JSON.stringify({ pid: 9999, userDataDir: root }))
            : fs.readFile(file, 'utf-8'),
      },
    );
    // 节流窗口 500ms:mock 时钟让每次取时前进 1s,保证递归内复查真实执行。
    let fakeNow = 1_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => {
      fakeNow += 1000;
      return fakeNow;
    });
    try {
      const result = await claimLegacyOwnerNamespace(
        { mode: 'cloud', dataOwnerId: 'cloud-a', user: { id: 'cloud-a' } },
        racedDeps,
      );
      expect(result).toMatchObject({ status: 'partial' });
    } finally {
      nowSpy.mockRestore();
    }
    // 递归首个子项前中断:目录内容未搬,marker 未 complete,下次独占启动续跑。
    await expect(fs.readFile(path.join(root, 'dialogues', 'a.json'), 'utf-8')).resolves.toBe('a');
    expect(hasLegacyOwnerNamespaceClaim('cloud-a', root)).toBe(false);

    const resumed = await claimLegacyOwnerNamespace(
      { mode: 'cloud', dataOwnerId: 'cloud-a', user: { id: 'cloud-a' } },
      realFsDeps(root),
    );
    expect(resumed).toMatchObject({ status: 'migrated' });
    await expect(fs.readFile(path.join(targetRoot, 'dialogues', 'a.json'), 'utf-8')).resolves.toBe('a');
    await expect(fs.readFile(path.join(targetRoot, 'dialogues', 'b.json'), 'utf-8')).resolves.toBe('b');
  });

  it('breaks the whole migration when a mid-recursion registry scan becomes unreadable', async () => {
    const root = await tempRoot();
    await fs.mkdir(path.join(root, 'dialogues'), { recursive: true });
    await fs.writeFile(path.join(root, 'dialogues', 'a.json'), 'a');
    // dialogues 之后的 LEGACY_PATHS 条目:递归内扫描失败后必须 break,不得搬它。
    await fs.writeFile(path.join(root, 'slack-hook.json'), 'legacy-hook');
    const targetRoot = path.join(root, 'owners', dataOwnerStorageKey('cloud-a'));
    await fs.mkdir(path.join(targetRoot, 'dialogues'), { recursive: true });

    let scans = 0;
    const deps = realFsDeps(root, undefined, {
      readdir: (dir: string) => {
        if (path.basename(dir) === '.dev-instances') {
          scans += 1;
          if (scans <= 2) return Promise.resolve([]);
          return Promise.reject(Object.assign(new Error('EACCES'), { code: 'EACCES' }));
        }
        return fs.readdir(dir);
      },
    });
    let fakeNow = 2_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => {
      fakeNow += 1000;
      return fakeNow;
    });
    try {
      const result = await claimLegacyOwnerNamespace(
        { mode: 'cloud', dataOwnerId: 'cloud-a', user: { id: 'cloud-a' } },
        deps,
      );
      expect(result).toMatchObject({ status: 'partial' });
    } finally {
      nowSpy.mockRestore();
    }
    // fail closed:注册表读不了时整个搬迁中断,后续 path 原封不动。
    await expect(fs.readFile(path.join(root, 'slack-hook.json'), 'utf-8')).resolves.toBe('legacy-hook');
    expect(hasLegacyOwnerNamespaceClaim('cloud-a', root)).toBe(false);
  });

  it('leaves an empty claim incomplete when a peer registers before completion', async () => {
    const root = await tempRoot();
    // 没有任何 legacy 文件:搬迁循环全 continue,唯一的复查机会是写 complete 前。
    let scans = 0;
    const deps = realFsDeps(
      root,
      { isPidAlive: (pid) => pid === 9999 },
      {
        readdir: (dir: string) => {
          if (path.basename(dir) === '.dev-instances') {
            scans += 1;
            return Promise.resolve(scans <= 1 ? [] : ['9999.json']);
          }
          return fs.readdir(dir);
        },
        readFile: (file: string) =>
          path.basename(file) === '9999.json'
            ? Promise.resolve(JSON.stringify({ pid: 9999, userDataDir: root }))
            : fs.readFile(file, 'utf-8'),
      },
    );

    const result = await claimLegacyOwnerNamespace(
      { mode: 'cloud', dataOwnerId: 'cloud-a', user: { id: 'cloud-a' } },
      deps,
    );

    expect(result).toMatchObject({ status: 'partial' });
    expect(hasLegacyOwnerNamespaceClaim('cloud-a', root)).toBe(false);

    const resumed = await claimLegacyOwnerNamespace(
      { mode: 'cloud', dataOwnerId: 'cloud-a', user: { id: 'cloud-a' } },
      realFsDeps(root),
    );
    expect(resumed).toMatchObject({ status: 'migrated' });
    expect(hasLegacyOwnerNamespaceClaim('cloud-a', root)).toBe(true);
  });

  it('reports migrated (not deferred) when the claim already completed, even with live neighbors', async () => {
    const root = await tempRoot();
    await claimLegacyOwnerNamespace(
      { mode: 'cloud', dataOwnerId: 'cloud-a', user: { id: 'cloud-a' } },
      realFsDeps(root),
    );
    await writeDevInstanceRecord(root, 4242);

    const again = await claimLegacyOwnerNamespace(
      { mode: 'cloud', dataOwnerId: 'cloud-a', user: { id: 'cloud-a' } },
      realFsDeps(root, { passiveSharedUserData: () => true, isPidAlive: () => true }),
    );

    expect(again).toEqual({ status: 'migrated', moved: 0, conflicts: 0 });
  });

  it('ignores stale registry records and records from other userData dirs', async () => {
    const root = await tempRoot();
    await fs.writeFile(path.join(root, 'slack-hook.json'), 'legacy-hook');
    await writeDevInstanceRecord(root, 4242); // isPidAlive=false → 已退出的残留
    await writeDevInstanceRecord(root, 5353, '/somewhere/else'); // 异常拷贝进来的他库记录
    await fs.writeFile(path.join(root, '.dev-instances', 'torn.json'), '{not-json', 'utf-8');

    const result = await claimLegacyOwnerNamespace(
      { mode: 'cloud', dataOwnerId: 'cloud-a', user: { id: 'cloud-a' } },
      realFsDeps(root, { isPidAlive: (pid) => pid === 5353 }),
    );

    expect(result).toMatchObject({ status: 'migrated' });
    const targetRoot = path.join(root, 'owners', dataOwnerStorageKey('cloud-a'));
    await expect(fs.readFile(path.join(targetRoot, 'slack-hook.json'), 'utf-8')).resolves.toBe('legacy-hook');
  });

  it('allows only the first verified cloud owner to claim remaining legacy data', async () => {
    const root = await tempRoot();
    await fs.writeFile(path.join(root, 'builtin-tools-settings.json'), 'legacy');

    await claimLegacyOwnerNamespace(
      { mode: 'cloud', dataOwnerId: 'cloud-a', user: { id: 'cloud-a' } },
      realFsDeps(root),
    );
    await fs.writeFile(path.join(root, 'ghost-workdir-prefs.json'), 'left-behind');
    const second = await claimLegacyOwnerNamespace(
      { mode: 'cloud', dataOwnerId: 'cloud-b', user: { id: 'cloud-b' } },
      realFsDeps(root),
    );

    expect(second).toEqual({ status: 'claimed-by-other-owner', moved: 0, conflicts: 0 });
    const secondRoot = path.join(root, 'owners', dataOwnerStorageKey('cloud-b'));
    await expect(fs.access(path.join(secondRoot, 'ghost-workdir-prefs.json'))).rejects.toThrow();
    const marker = JSON.parse(
      await fs.readFile(path.join(root, __testing.CLAIM_MARKER), 'utf-8'),
    ) as { ownerKey: string };
    expect(marker.ownerKey).toBe(dataOwnerStorageKey('cloud-a'));
    expect(hasLegacyOwnerNamespaceClaim('cloud-a', root)).toBe(true);
    expect(hasLegacyOwnerNamespaceClaim('cloud-b', root)).toBe(false);
  });
});

describe('legacy Ghost plugin recovery', () => {
  it('does not follow a linked legacy repository root', async () => {
    const root = await tempRoot();
    const externalRoot = await tempRoot();
    await writeGhostDirAtPath(
      path.join(externalRoot, 'external-plugin'),
      'external-plugin',
    );
    await fs.symlink(
      externalRoot,
      path.join(root, 'brain'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    await expect(
      recoverLegacyGhostPlugins(
        { mode: 'cloud', dataOwnerId: 'cloud-a', user: { id: 'cloud-a' } },
        realFsDeps(root),
      ),
    ).resolves.toEqual({ status: 'skipped', moved: 0, conflicts: 0 });
    await expect(
      fs.readFile(path.join(externalRoot, 'external-plugin', 'ghost.json'), 'utf-8'),
    ).resolves.toContain('"id":"external-plugin"');
    await expect(
      fs.access(
        path.join(
          root,
          'owners',
          dataOwnerStorageKey('cloud-a'),
          'cindy-brain',
          'external-plugin',
        ),
      ),
    ).rejects.toThrow();
  });

  it('does not move linked legacy plugin directories', async () => {
    const root = await tempRoot();
    const externalRoot = await tempRoot();
    const linkedPlugin = path.join(externalRoot, 'linked-plugin');
    await writeGhostDirAtPath(linkedPlugin, 'linked-plugin');
    await fs.mkdir(path.join(root, 'brain'), { recursive: true });
    await fs.symlink(
      linkedPlugin,
      path.join(root, 'brain', 'linked-plugin'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    await expect(
      recoverLegacyGhostPlugins(
        { mode: 'cloud', dataOwnerId: 'cloud-a', user: { id: 'cloud-a' } },
        realFsDeps(root),
      ),
    ).resolves.toEqual({ status: 'skipped', moved: 0, conflicts: 0 });
    await expect(
      fs.readFile(path.join(linkedPlugin, 'ghost.json'), 'utf-8'),
    ).resolves.toContain('"id":"linked-plugin"');
    await expect(
      fs.access(
        path.join(
          root,
          'owners',
          dataOwnerStorageKey('cloud-a'),
          'cindy-brain',
          'linked-plugin',
        ),
      ),
    ).rejects.toThrow();
  });

  it('does not follow a linked owner-scoped recovery destination', async () => {
    const root = await tempRoot();
    const externalRoot = await tempRoot();
    const ownerId = 'cloud-a';
    const ownerKey = dataOwnerStorageKey(ownerId);
    await writeGhostDir(root, 'brain', 'legacy-plugin');
    const ownerRoot = path.join(root, 'owners', ownerKey);
    await fs.mkdir(ownerRoot, { recursive: true });
    await fs.symlink(
      externalRoot,
      path.join(ownerRoot, 'cindy-brain'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    expect(
      getLegacyGhostRecoveryStatus(
        { mode: 'cloud', dataOwnerId: ownerId, user: { id: ownerId } },
        root,
      ),
    ).toEqual({
      state: 'partial',
      legacyPluginCount: 1,
      canRetry: false,
    });
    await expect(
      recoverLegacyGhostPlugins(
        { mode: 'cloud', dataOwnerId: ownerId, user: { id: ownerId } },
        realFsDeps(root),
      ),
    ).resolves.toMatchObject({ status: 'partial', moved: 0, conflicts: 1 });
    await expect(
      fs.readFile(path.join(root, 'brain', 'legacy-plugin', 'ghost.json'), 'utf-8'),
    ).resolves.toContain('"id":"legacy-plugin"');
    await expect(fs.access(path.join(externalRoot, 'legacy-plugin'))).rejects.toThrow();
  });

  it('does not restore plugins whose command conflicts with an installed plugin', async () => {
    const root = await tempRoot();
    const ownerId = 'cloud-a';
    const ownerKey = dataOwnerStorageKey(ownerId);
    await writeGhostDirAtPath(
      path.join(root, 'brain', 'legacy-plugin'),
      'legacy-plugin',
      'Draw',
    );
    const targetRoot = path.join(root, 'owners', ownerKey, 'cindy-brain');
    await writeGhostDirAtPath(
      path.join(targetRoot, 'current-plugin'),
      'current-plugin',
      'draw',
    );

    expect(
      getLegacyGhostRecoveryStatus(
        { mode: 'cloud', dataOwnerId: ownerId, user: { id: ownerId } },
        root,
      ),
    ).toEqual({
      state: 'partial',
      legacyPluginCount: 1,
      canRetry: false,
    });
    await expect(
      recoverLegacyGhostPlugins(
        { mode: 'cloud', dataOwnerId: ownerId, user: { id: ownerId } },
        realFsDeps(root),
      ),
    ).resolves.toMatchObject({ status: 'partial', moved: 0, conflicts: 1 });
    await expect(
      fs.readFile(path.join(root, 'brain', 'legacy-plugin', 'ghost.json'), 'utf-8'),
    ).resolves.toContain('"command":"Draw"');
    await expect(fs.access(path.join(targetRoot, 'legacy-plugin'))).rejects.toThrow();
    await expect(fs.access(path.join(root, __testing.CLAIM_MARKER))).rejects.toThrow();
  });

  it('does not restore plugins whose command is reserved for a builtin seed', async () => {
    const root = await tempRoot();
    const ownerId = 'cloud-a';
    await writeGhostDirAtPath(
      path.join(root, 'brain', 'custom-plugin'),
      'custom-plugin',
      'Draw',
    );

    await expect(
      recoverLegacyGhostPlugins(
        { mode: 'cloud', dataOwnerId: ownerId, user: { id: ownerId } },
        realFsDeps(root),
        { reservedCommands: new Set(['draw']) },
      ),
    ).resolves.toMatchObject({ status: 'partial', moved: 0, conflicts: 1 });
    await expect(
      fs.readFile(path.join(root, 'brain', 'custom-plugin', 'ghost.json'), 'utf-8'),
    ).resolves.toContain('"command":"Draw"');
  });

  it('derives retryability from bundled command reservations', async () => {
    const root = await tempRoot();
    const ownerId = 'cloud-a';
    await writeGhostDirAtPath(
      path.join(root, 'brain', 'custom-plugin'),
      'custom-plugin',
      'Draw',
    );

    expect(
      getLegacyGhostRecoveryStatus(
        { mode: 'cloud', dataOwnerId: ownerId, user: { id: ownerId } },
        root,
        false,
        { reservedCommands: new Set(['draw']) },
      ),
    ).toEqual({
      state: 'partial',
      legacyPluginCount: 1,
      canRetry: false,
    });
  });

  it('ignores tombstones from a foreign shared root during recovery planning', async () => {
    const root = await tempRoot();
    const ownerId = 'cloud-a';
    const foreignOwnerKey = dataOwnerStorageKey('cloud-b');
    const scopedRoot = path.join(root, 'owners', dataOwnerStorageKey(ownerId), 'brain');
    await writeGhostDir(root, 'brain', 'shared-plugin');
    await writeGhostDirAtPath(path.join(scopedRoot, 'scoped-plugin'), 'scoped-plugin', 'Draw');
    await fs.writeFile(
      path.join(root, __testing.CLAIM_MARKER),
      JSON.stringify({ version: 1, ownerKey: foreignOwnerKey, complete: true }),
    );
    await fs.writeFile(
      path.join(root, 'brain', '.builtin-provisioning.json'),
      JSON.stringify({ removed: ['draw'] }),
    );

    expect(listLegacyGhostTombstoneRoots(ownerId, root)).toEqual([scopedRoot]);
  });

  it('does not restore reserved plugin IDs when packaged recovery protection is enabled', async () => {
    const root = await tempRoot();
    const ownerId = 'cloud-a';
    await writeGhostDir(root, 'brain', 'cindy-untrusted');

    await expect(
      recoverLegacyGhostPlugins(
        { mode: 'cloud', dataOwnerId: ownerId, user: { id: ownerId } },
        realFsDeps(root),
        { rejectReservedIds: true },
      ),
    ).resolves.toEqual({ status: 'skipped', moved: 0, conflicts: 0 });
    expect(
      getLegacyGhostRecoveryStatus(
        { mode: 'cloud', dataOwnerId: ownerId, user: { id: ownerId } },
        root,
        false,
        { rejectReservedIds: true },
      ),
    ).toEqual({ state: 'none', legacyPluginCount: 0, canRetry: false });
    await expect(
      fs.readFile(path.join(root, 'brain', 'cindy-untrusted', 'ghost.json'), 'utf-8'),
    ).resolves.toContain('"id":"cindy-untrusted"');
    await expect(fs.access(path.join(root, __testing.CLAIM_MARKER))).rejects.toThrow();
  });

  it('moves builtin provisioning state with plugins before reconciliation', async () => {
    const root = await tempRoot();
    const ownerId = 'cloud-a';
    const ownerKey = dataOwnerStorageKey(ownerId);
    await writeGhostDir(root, 'brain', 'seeded-plugin');
    const state = {
      removed: ['removed-builtin'],
      seeded: ['seeded-plugin'],
    };
    await fs.writeFile(
      path.join(root, 'brain', '.builtin-provisioning.json'),
      JSON.stringify(state),
    );

    await expect(
      recoverLegacyGhostPlugins(
        { mode: 'cloud', dataOwnerId: ownerId, user: { id: ownerId } },
        realFsDeps(root),
      ),
    ).resolves.toMatchObject({
      status: 'migrated',
      moved: 1,
      conflicts: 0,
      provisioningStateMoved: true,
    });
    await expect(
      fs.readFile(
        path.join(
          root,
          'owners',
          ownerKey,
          'cindy-brain',
          '.builtin-provisioning.json',
        ),
        'utf-8',
      ),
    ).resolves.toBe(JSON.stringify(state));
    await expect(
      fs.access(path.join(root, 'brain', '.builtin-provisioning.json')),
    ).rejects.toThrow();
  });

  it('does not move plugins when builtin provisioning state would conflict', async () => {
    const root = await tempRoot();
    const ownerId = 'cloud-a';
    const ownerKey = dataOwnerStorageKey(ownerId);
    await writeGhostDir(root, 'brain', 'seeded-plugin');
    await fs.writeFile(
      path.join(root, 'brain', '.builtin-provisioning.json'),
      JSON.stringify({ removed: ['legacy'], seeded: [] }),
    );
    const targetRoot = path.join(root, 'owners', ownerKey, 'cindy-brain');
    await fs.mkdir(targetRoot, { recursive: true });
    await fs.writeFile(
      path.join(targetRoot, '.builtin-provisioning.json'),
      JSON.stringify({ removed: ['current'], seeded: [] }),
    );

    expect(
      getLegacyGhostRecoveryStatus(
        { mode: 'cloud', dataOwnerId: ownerId, user: { id: ownerId } },
        root,
      ),
    ).toEqual({
      state: 'partial',
      legacyPluginCount: 1,
      canRetry: false,
    });
    await expect(
      recoverLegacyGhostPlugins(
        { mode: 'cloud', dataOwnerId: ownerId, user: { id: ownerId } },
        realFsDeps(root),
      ),
    ).resolves.toMatchObject({ status: 'partial', moved: 0, conflicts: 1 });
    await expect(
      fs.readFile(path.join(root, 'brain', 'seeded-plugin', 'ghost.json'), 'utf-8'),
    ).resolves.toContain('"id":"seeded-plugin"');
    await expect(
      fs.readFile(path.join(targetRoot, '.builtin-provisioning.json'), 'utf-8'),
    ).resolves.toContain('current');
  });

  it('does not reserve commands from roots blocked by provisioning preflight', async () => {
    const root = await tempRoot();
    const ownerId = 'cloud-a';
    const ownerKey = dataOwnerStorageKey(ownerId);
    const blockedRoot = path.join(root, 'cindy-brain');
    const safeRoot = path.join(root, 'brain');
    const targetRoot = path.join(root, 'owners', ownerKey, 'cindy-brain');
    await writeGhostDirAtPath(
      path.join(blockedRoot, 'blocked-plugin'),
      'blocked-plugin',
      'Draw',
    );
    await writeGhostDirAtPath(path.join(safeRoot, 'safe-plugin'), 'safe-plugin', 'draw');
    await fs.mkdir(targetRoot, { recursive: true });
    await fs.writeFile(
      path.join(blockedRoot, '.builtin-provisioning.json'),
      JSON.stringify({ removed: [], seeded: ['blocked-plugin'] }),
    );
    await fs.writeFile(
      path.join(targetRoot, '.builtin-provisioning.json'),
      JSON.stringify({ removed: [], seeded: [] }),
    );

    await expect(
      recoverLegacyGhostPlugins(
        { mode: 'cloud', dataOwnerId: ownerId, user: { id: ownerId } },
        realFsDeps(root),
      ),
    ).resolves.toMatchObject({ status: 'partial', moved: 1, conflicts: 1 });
    await expect(
      fs.readFile(path.join(targetRoot, 'safe-plugin', 'ghost.json'), 'utf-8'),
    ).resolves.toContain('"id":"safe-plugin"');
    await expect(
      fs.readFile(path.join(blockedRoot, 'blocked-plugin', 'ghost.json'), 'utf-8'),
    ).resolves.toContain('"id":"blocked-plugin"');
  });

  it('aborts before moving builtin provisioning state when the owner changes', async () => {
    const root = await tempRoot();
    const ownerId = 'cloud-a';
    const ownerKey = dataOwnerStorageKey(ownerId);
    await writeGhostDir(root, 'brain', 'seeded-plugin');
    await fs.writeFile(
      path.join(root, 'brain', '.builtin-provisioning.json'),
      JSON.stringify({ removed: [], seeded: ['seeded-plugin'] }),
    );
    let checks = 0;

    const result = await recoverLegacyGhostPlugins(
      { mode: 'cloud', dataOwnerId: ownerId, user: { id: ownerId } },
      realFsDeps(root),
      { shouldAbort: () => ++checks >= 4 },
    );

    expect(result).toMatchObject({ status: 'partial', moved: 0 });
    await expect(
      fs.readFile(path.join(root, 'brain', '.builtin-provisioning.json'), 'utf-8'),
    ).resolves.toContain('seeded-plugin');
    await expect(
      fs.access(
        path.join(root, 'owners', ownerKey, 'cindy-brain', '.builtin-provisioning.json'),
      ),
    ).rejects.toThrow();
  });

  it('rolls back builtin provisioning state when the owner changes during rename', async () => {
    const root = await tempRoot();
    const ownerId = 'cloud-a';
    const ownerKey = dataOwnerStorageKey(ownerId);
    await writeGhostDir(root, 'brain', 'seeded-plugin');
    const sourceState = path.join(root, 'brain', '.builtin-provisioning.json');
    const targetState = path.join(
      root,
      'owners',
      ownerKey,
      'cindy-brain',
      '.builtin-provisioning.json',
    );
    await fs.writeFile(
      sourceState,
      JSON.stringify({ removed: [], seeded: ['seeded-plugin'] }),
    );
    let boundaryPending = false;
    const deps = realFsDeps(
      root,
      {},
      {
        rename: async (source: string, target: string) => {
          await fs.rename(source, target);
          if (source === sourceState && target === targetState) boundaryPending = true;
        },
      },
    );

    const result = await recoverLegacyGhostPlugins(
      { mode: 'cloud', dataOwnerId: ownerId, user: { id: ownerId } },
      deps,
      { shouldAbort: () => boundaryPending },
    );

    expect(result).toMatchObject({ status: 'partial', moved: 0 });
    await expect(fs.readFile(sourceState, 'utf-8')).resolves.toContain('seeded-plugin');
    await expect(fs.access(targetState)).rejects.toThrow();
    await expect(
      fs.readFile(path.join(root, 'brain', 'seeded-plugin', 'ghost.json'), 'utf-8'),
    ).resolves.toContain('seeded-plugin');
  });

  it('keeps moved provisioning state when a peer appears before rollback', async () => {
    const root = await tempRoot();
    const ownerId = 'cloud-a';
    const ownerKey = dataOwnerStorageKey(ownerId);
    await writeGhostDir(root, 'brain', 'seeded-plugin');
    await writeDevInstanceRecord(root, 4242);
    const sourceState = path.join(root, 'brain', '.builtin-provisioning.json');
    const targetState = path.join(
      root,
      'owners',
      ownerKey,
      'cindy-brain',
      '.builtin-provisioning.json',
    );
    await fs.writeFile(
      sourceState,
      JSON.stringify({ removed: [], seeded: ['seeded-plugin'] }),
    );
    let boundaryPending = false;
    let peerStarted = false;
    const deps = realFsDeps(
      root,
      { isPidAlive: (pid) => peerStarted && pid === 4242 },
      {
        rename: async (source: string, target: string) => {
          await fs.rename(source, target);
          if (source === sourceState && target === targetState) {
            boundaryPending = true;
            peerStarted = true;
          }
        },
      },
    );

    const result = await recoverLegacyGhostPlugins(
      { mode: 'cloud', dataOwnerId: ownerId, user: { id: ownerId } },
      deps,
      { shouldAbort: () => boundaryPending },
    );

    expect(result).toMatchObject({
      status: 'partial',
      moved: 0,
      provisioningStateMoved: true,
    });
    await expect(fs.access(sourceState)).rejects.toThrow();
    await expect(fs.readFile(targetState, 'utf-8')).resolves.toContain('seeded-plugin');
  });

  it('reports a provisioning-state move even when the plugin rename fails', async () => {
    const root = await tempRoot();
    const ownerId = 'cloud-a';
    const ownerKey = dataOwnerStorageKey(ownerId);
    await writeGhostDir(root, 'brain', 'seeded-plugin');
    await fs.writeFile(
      path.join(root, 'brain', '.builtin-provisioning.json'),
      JSON.stringify({ removed: [], seeded: ['seeded-plugin'] }),
    );
    const deps = realFsDeps(
      root,
      {},
      {
        rename: (source: string, target: string) =>
          path.basename(source) === '.builtin-provisioning.json'
            ? fs.rename(source, target)
            : Promise.reject(Object.assign(new Error('rename denied'), { code: 'EACCES' })),
      },
    );

    await expect(
      recoverLegacyGhostPlugins(
        { mode: 'cloud', dataOwnerId: ownerId, user: { id: ownerId } },
        deps,
      ),
    ).resolves.toMatchObject({
      status: 'partial',
      moved: 0,
      conflicts: 0,
      provisioningStateMoved: true,
    });
    await expect(
      fs.readFile(
        path.join(root, 'owners', ownerKey, 'cindy-brain', '.builtin-provisioning.json'),
        'utf-8',
      ),
    ).resolves.toContain('seeded-plugin');
    await expect(
      fs.readFile(path.join(root, 'brain', 'seeded-plugin', 'ghost.json'), 'utf-8'),
    ).resolves.toContain('seeded-plugin');
  });

  it('moves only valid legacy plugins and leaves other owner data in place', async () => {
    const root = await tempRoot();
    const ownerId = 'cloud-a';
    await writeGhostDir(root, 'cindy-brain', 'valid-plugin');
    await fs.mkdir(path.join(root, 'cindy-brain', 'invalid-plugin'), { recursive: true });
    await fs.writeFile(path.join(root, 'cindy-brain', 'invalid-plugin', 'ghost.json'), '{ nope');
    await fs.mkdir(path.join(root, 'dialogues'), { recursive: true });
    await fs.writeFile(path.join(root, 'dialogues', 'session.json'), 'legacy-dialogue');

    const result = await recoverLegacyGhostPlugins(
      { mode: 'cloud', dataOwnerId: ownerId, user: { id: ownerId } },
      realFsDeps(root),
    );

    const targetRoot = path.join(root, 'owners', dataOwnerStorageKey(ownerId));
    expect(result).toMatchObject({ status: 'migrated', moved: 1, conflicts: 0 });
    await expect(
      fs.readFile(path.join(targetRoot, 'cindy-brain', 'valid-plugin', 'ghost.json'), 'utf-8'),
    ).resolves.toContain('"id":"valid-plugin"');
    await expect(
      fs.readFile(path.join(root, 'cindy-brain', 'invalid-plugin', 'ghost.json'), 'utf-8'),
    ).resolves.toBe('{ nope');
    await expect(fs.readFile(path.join(root, 'dialogues', 'session.json'), 'utf-8')).resolves.toBe(
      'legacy-dialogue',
    );
  });

  it('removes a newly created empty target when every plugin rename fails', async () => {
    const root = await tempRoot();
    const ownerId = 'cloud-a';
    const ownerKey = dataOwnerStorageKey(ownerId);
    await writeGhostDirAtPath(
      path.join(root, 'owners', ownerKey, 'brain', 'legacy-plugin'),
      'legacy-plugin',
    );
    const deps = realFsDeps(
      root,
      {},
      {
        rename: () =>
          Promise.reject(Object.assign(new Error('rename denied'), { code: 'EACCES' })),
      },
    );

    await expect(
      recoverLegacyGhostPlugins(
        { mode: 'cloud', dataOwnerId: ownerId, user: { id: ownerId } },
        deps,
      ),
    ).resolves.toMatchObject({ status: 'partial', moved: 0 });
    await expect(
      fs.access(path.join(root, 'owners', ownerKey, 'cindy-brain')),
    ).rejects.toThrow();
    await expect(
      fs.readFile(
        path.join(root, 'owners', ownerKey, 'brain', 'legacy-plugin', 'ghost.json'),
        'utf-8',
      ),
    ).resolves.toContain('"id":"legacy-plugin"');
  });

  it('does not overwrite an existing scoped plugin', async () => {
    const root = await tempRoot();
    const ownerId = 'cloud-a';
    await writeGhostDir(root, 'cindy-brain', 'valid-plugin');
    const target = path.join(root, 'owners', dataOwnerStorageKey(ownerId), 'cindy-brain', 'valid-plugin');
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, 'ghost.json'), 'scoped');

    const result = await recoverLegacyGhostPlugins(
      { mode: 'cloud', dataOwnerId: ownerId, user: { id: ownerId } },
      realFsDeps(root),
    );
    const status = getLegacyGhostRecoveryStatus(
      { mode: 'cloud', dataOwnerId: ownerId, user: { id: ownerId } },
      root,
    );

    expect(result).toMatchObject({ status: 'partial', moved: 0, conflicts: 1 });
    expect(status).toEqual({
      state: 'partial',
      legacyPluginCount: 1,
      canRetry: false,
    });
    await expect(fs.readFile(path.join(target, 'ghost.json'), 'utf-8')).resolves.toBe('scoped');
    await expect(
      fs.readFile(path.join(root, 'cindy-brain', 'valid-plugin', 'ghost.json'), 'utf-8'),
    ).resolves.toContain('"id":"valid-plugin"');
    await expect(fs.access(path.join(root, __testing.CLAIM_MARKER))).rejects.toThrow();
  });

  it('does not claim legacy owner data when no valid plugin can be recovered', async () => {
    const root = await tempRoot();
    await fs.mkdir(path.join(root, 'cindy-brain', 'invalid-plugin'), { recursive: true });
    await fs.writeFile(path.join(root, 'cindy-brain', 'invalid-plugin', 'ghost.json'), '{ nope');
    await fs.mkdir(path.join(root, 'dialogues'), { recursive: true });
    await fs.writeFile(path.join(root, 'dialogues', 'session.json'), 'legacy-dialogue');

    const result = await recoverLegacyGhostPlugins(
      { mode: 'cloud', dataOwnerId: 'cloud-a', user: { id: 'cloud-a' } },
      realFsDeps(root),
    );

    expect(result).toEqual({ status: 'skipped', moved: 0, conflicts: 0 });
    await expect(fs.access(path.join(root, __testing.CLAIM_MARKER))).rejects.toThrow();
    await expect(fs.readFile(path.join(root, 'dialogues', 'session.json'), 'utf-8')).resolves.toBe(
      'legacy-dialogue',
    );
  });

  it('consolidates plugins left in the current owner scoped brain directory', async () => {
    const root = await tempRoot();
    const ownerId = 'cloud-a';
    const ownerKey = dataOwnerStorageKey(ownerId);
    const legacyPluginDir = path.join(
      root,
      'owners',
      ownerKey,
      'brain',
      'scoped-legacy-plugin',
    );
    await writeGhostDirAtPath(legacyPluginDir, 'scoped-legacy-plugin');
    await fs.writeFile(
      path.join(root, __testing.CLAIM_MARKER),
      JSON.stringify({ version: 1, ownerKey, complete: true }),
    );

    expect(
      getLegacyGhostRecoveryStatus(
        { mode: 'cloud', dataOwnerId: ownerId, user: { id: ownerId } },
        root,
      ),
    ).toEqual({
      state: 'partial',
      legacyPluginCount: 1,
      canRetry: true,
    });

    const result = await recoverLegacyGhostPlugins(
      { mode: 'cloud', dataOwnerId: ownerId, user: { id: ownerId } },
      realFsDeps(root),
    );

    expect(result).toMatchObject({ status: 'migrated', moved: 1, conflicts: 0 });
    await expect(
      fs.readFile(
        path.join(root, 'owners', ownerKey, 'cindy-brain', 'scoped-legacy-plugin', 'ghost.json'),
        'utf-8',
      ),
    ).resolves.toContain('"id":"scoped-legacy-plugin"');
    await expect(
      fs.access(path.join(root, 'owners', ownerKey, 'brain', 'scoped-legacy-plugin')),
    ).rejects.toThrow();
  });

  it('recovers current-owner scoped plugins without changing another owner global claim', async () => {
    const root = await tempRoot();
    const ownerId = 'cloud-b';
    const ownerKey = dataOwnerStorageKey(ownerId);
    const otherOwnerKey = dataOwnerStorageKey('cloud-a');
    await writeGhostDirAtPath(
      path.join(root, 'owners', ownerKey, 'brain', 'scoped-legacy-plugin'),
      'scoped-legacy-plugin',
    );
    await fs.writeFile(
      path.join(root, __testing.CLAIM_MARKER),
      JSON.stringify({ version: 1, ownerKey: otherOwnerKey, complete: true }),
    );

    expect(
      getLegacyGhostRecoveryStatus(
        { mode: 'cloud', dataOwnerId: ownerId, user: { id: ownerId } },
        root,
      ),
    ).toEqual({
      state: 'partial',
      legacyPluginCount: 1,
      canRetry: true,
    });

    await expect(
      recoverLegacyGhostPlugins(
        { mode: 'cloud', dataOwnerId: ownerId, user: { id: ownerId } },
        realFsDeps(root),
      ),
    ).resolves.toMatchObject({ status: 'migrated', moved: 1, conflicts: 0 });
    await expect(
      fs.readFile(
        path.join(root, 'owners', ownerKey, 'cindy-brain', 'scoped-legacy-plugin', 'ghost.json'),
        'utf-8',
      ),
    ).resolves.toContain('"id":"scoped-legacy-plugin"');
    await expect(
      fs.readFile(path.join(root, __testing.CLAIM_MARKER), 'utf-8'),
    ).resolves.toContain(otherOwnerKey);
  });

  it('fails closed when the global claim marker is unreadable', async () => {
    const root = await tempRoot();
    const ownerId = 'cloud-a';
    await writeGhostDir(root, 'cindy-brain', 'valid-plugin');
    await fs.writeFile(path.join(root, __testing.CLAIM_MARKER), '{ invalid');

    expect(
      getLegacyGhostRecoveryStatus(
        { mode: 'cloud', dataOwnerId: ownerId, user: { id: ownerId } },
        root,
      ),
    ).toEqual({
      state: 'partial',
      legacyPluginCount: 1,
      canRetry: false,
    });

    await expect(
      recoverLegacyGhostPlugins(
        { mode: 'cloud', dataOwnerId: ownerId, user: { id: ownerId } },
        realFsDeps(root),
      ),
    ).resolves.toEqual({ status: 'partial', moved: 0, conflicts: 1 });
    await expect(
      fs.readFile(path.join(root, 'cindy-brain', 'valid-plugin', 'ghost.json'), 'utf-8'),
    ).resolves.toContain('"id":"valid-plugin"');
  });

  it('preserves successful moves when empty legacy root cleanup fails', async () => {
    const root = await tempRoot();
    const ownerId = 'cloud-a';
    const ownerKey = dataOwnerStorageKey(ownerId);
    await writeGhostDir(root, 'cindy-brain', 'valid-plugin');
    const deps = realFsDeps(
      root,
      {},
      {
        rmdir: (dir: string) =>
          path.basename(dir) === 'cindy-brain'
            ? Promise.reject(Object.assign(new Error('cleanup denied'), { code: 'EACCES' }))
            : fs.rmdir(dir),
      },
    );

    await expect(
      recoverLegacyGhostPlugins(
        { mode: 'cloud', dataOwnerId: ownerId, user: { id: ownerId } },
        deps,
      ),
    ).resolves.toMatchObject({ status: 'migrated', moved: 1, conflicts: 0 });
    await expect(
      fs.readFile(
        path.join(root, 'owners', ownerKey, 'cindy-brain', 'valid-plugin', 'ghost.json'),
        'utf-8',
      ),
    ).resolves.toContain('"id":"valid-plugin"');
  });

  it('defers without writing a marker while another live instance shares userData', async () => {
    const root = await tempRoot();
    await writeGhostDir(root, 'cindy-brain', 'valid-plugin');
    await writeDevInstanceRecord(root, 4242);

    expect(
      getLegacyGhostRecoveryStatus(
        { mode: 'cloud', dataOwnerId: 'cloud-a', user: { id: 'cloud-a' } },
        root,
        false,
        {},
        (pid) => pid === 4242,
      ),
    ).toEqual({
      state: 'deferred',
      legacyPluginCount: 1,
      canRetry: false,
    });

    const result = await recoverLegacyGhostPlugins(
      { mode: 'cloud', dataOwnerId: 'cloud-a', user: { id: 'cloud-a' } },
      realFsDeps(root, { isPidAlive: (pid) => pid === 4242 }),
    );

    expect(result).toEqual({
      status: 'deferred',
      moved: 0,
      conflicts: 0,
      deferredReason: 'concurrent-live-instances',
    });
    await expect(fs.access(path.join(root, __testing.CLAIM_MARKER))).rejects.toThrow();
    await expect(
      fs.readFile(path.join(root, 'cindy-brain', 'valid-plugin', 'ghost.json'), 'utf-8'),
    ).resolves.toContain('"id":"valid-plugin"');
  });

  it('interrupts plugin recovery when an instance registers before the next plugin move', async () => {
    const root = await tempRoot();
    await writeGhostDir(root, 'cindy-brain', 'first-plugin');
    await writeGhostDir(root, 'brain', 'second-plugin');
    let scans = 0;
    const racedDeps = realFsDeps(
      root,
      { isPidAlive: (pid) => pid === 9999 },
      {
        readdir: (dir: string) => {
          if (path.basename(dir) === '.dev-instances') {
            scans += 1;
            return Promise.resolve(scans <= 2 ? [] : ['9999.json']);
          }
          return fs.readdir(dir);
        },
        readFile: (file: string) =>
          path.basename(file) === '9999.json'
            ? Promise.resolve(JSON.stringify({ pid: 9999, userDataDir: root }))
            : fs.readFile(file, 'utf-8'),
      },
    );

    const result = await recoverLegacyGhostPlugins(
      { mode: 'cloud', dataOwnerId: 'cloud-a', user: { id: 'cloud-a' } },
      racedDeps,
    );

    const targetRoot = path.join(root, 'owners', dataOwnerStorageKey('cloud-a'), 'cindy-brain');
    expect(result).toMatchObject({
      status: 'partial',
      moved: 1,
      conflicts: 0,
      deferredReason: 'concurrent-live-instances',
    });
    await expect(
      fs.readFile(path.join(targetRoot, 'first-plugin', 'ghost.json'), 'utf-8'),
    ).resolves.toContain('"id":"first-plugin"');
    await expect(
      fs.readFile(path.join(root, 'brain', 'second-plugin', 'ghost.json'), 'utf-8'),
    ).resolves.toContain('"id":"second-plugin"');
    await expect(fs.access(path.join(root, 'cindy-brain'))).resolves.toBeUndefined();
    expect(hasLegacyOwnerNamespaceClaim('cloud-a', root)).toBe(false);
  });

  it('ignores foreign-owned shared plugins and never moves them across accounts', async () => {
    const root = await tempRoot();
    await writeGhostDir(root, 'cindy-brain', 'valid-plugin');
    await fs.writeFile(
      path.join(root, __testing.CLAIM_MARKER),
      JSON.stringify({ version: 1, ownerKey: dataOwnerStorageKey('cloud-a'), complete: true }),
    );

    const result = await recoverLegacyGhostPlugins(
      { mode: 'cloud', dataOwnerId: 'cloud-b', user: { id: 'cloud-b' } },
      realFsDeps(root),
    );
    const status = getLegacyGhostRecoveryStatus(
      { mode: 'cloud', dataOwnerId: 'cloud-b', user: { id: 'cloud-b' } },
      root,
    );

    expect(result).toEqual({ status: 'claimed-by-other-owner', moved: 0, conflicts: 0 });
    expect(status).toEqual({ state: 'none', legacyPluginCount: 0, canRetry: false });
    await expect(
      fs.access(path.join(root, 'owners', dataOwnerStorageKey('cloud-b'), 'cindy-brain')),
    ).rejects.toThrow();
    await expect(
      fs.readFile(path.join(root, 'cindy-brain', 'valid-plugin', 'ghost.json'), 'utf-8'),
    ).resolves.toContain('"id":"valid-plugin"');
  });

  it('reports retryable partial status when legacy plugins appear after a completed owner claim', async () => {
    const root = await tempRoot();
    await writeGhostDir(root, 'cindy-brain', 'valid-plugin');
    await fs.writeFile(
      path.join(root, __testing.CLAIM_MARKER),
      JSON.stringify({ version: 1, ownerKey: dataOwnerStorageKey('cloud-a'), complete: true }),
    );

    expect(
      getLegacyGhostRecoveryStatus(
        { mode: 'cloud', dataOwnerId: 'cloud-a', user: { id: 'cloud-a' } },
        root,
      ),
    ).toEqual({
      state: 'partial',
      legacyPluginCount: 1,
      canRetry: true,
    });
  });

  it('disables manual recovery retry in passive shared-userData mode', async () => {
    const root = await tempRoot();
    await writeGhostDir(root, 'cindy-brain', 'valid-plugin');
    process.env.XDT_PASSIVE_SHARED_USER_DATA = '1';
    try {
      expect(
        getLegacyGhostRecoveryStatus(
          { mode: 'cloud', dataOwnerId: 'cloud-a', user: { id: 'cloud-a' } },
          root,
        ),
      ).toEqual({
        state: 'deferred',
        legacyPluginCount: 1,
        canRetry: false,
      });
    } finally {
      delete process.env.XDT_PASSIVE_SHARED_USER_DATA;
    }
  });

  it('aborts before the first write when the owner generation guard changes', async () => {
    const root = await tempRoot();
    await writeGhostDir(root, 'cindy-brain', 'valid-plugin');

    const result = await recoverLegacyGhostPlugins(
      { mode: 'cloud', dataOwnerId: 'cloud-a', user: { id: 'cloud-a' } },
      realFsDeps(root),
      { shouldAbort: () => true },
    );

    expect(result).toEqual({ status: 'deferred', moved: 0, conflicts: 0 });
    await expect(fs.access(path.join(root, __testing.CLAIM_MARKER))).rejects.toThrow();
    await expect(
      fs.readFile(path.join(root, 'cindy-brain', 'valid-plugin', 'ghost.json'), 'utf-8'),
    ).resolves.toContain('"id":"valid-plugin"');
  });
});

describe('hasLegacyOwnerNamespaceClaim', () => {
  beforeEach(() => {
    // 防外部 shell 的 ambient env 污染断言(该函数直接读 env)。
    delete process.env.XDT_PASSIVE_SHARED_USER_DATA;
  });

  it('requires a COMPLETED claim: partial markers keep legacy importers waiting', async () => {
    const root = await tempRoot();
    await fs.writeFile(
      path.join(root, __testing.CLAIM_MARKER),
      JSON.stringify({ version: 1, ownerKey: dataOwnerStorageKey('cloud-a'), complete: false }),
    );
    expect(hasLegacyOwnerNamespaceClaim('cloud-a', root)).toBe(false);

    await fs.writeFile(
      path.join(root, __testing.CLAIM_MARKER),
      JSON.stringify({ version: 1, ownerKey: dataOwnerStorageKey('cloud-a'), complete: true }),
    );
    expect(hasLegacyOwnerNamespaceClaim('cloud-a', root)).toBe(true);
  });

  it('distinguishes another owner claim even while that claim is incomplete', async () => {
    const root = await tempRoot();
    expect(isLegacyOwnerNamespaceClaimedByOtherOwner('cloud-a', root)).toBe(false);

    await fs.writeFile(
      path.join(root, __testing.CLAIM_MARKER),
      JSON.stringify({ version: 1, ownerKey: dataOwnerStorageKey('cloud-b'), complete: false }),
    );
    expect(isLegacyOwnerNamespaceClaimedByOtherOwner('cloud-a', root)).toBe(true);
    expect(isLegacyOwnerNamespaceClaimedByOtherOwner('cloud-b', root)).toBe(false);

    await fs.writeFile(path.join(root, __testing.CLAIM_MARKER), '{ invalid');
    expect(isLegacyOwnerNamespaceClaimedByOtherOwner('cloud-a', root)).toBe(false);
  });

  it('reads a same-owner marker without granting migration permission', async () => {
    const root = await tempRoot();
    expect(isLegacyOwnerNamespaceClaimOwnedBy('cloud-a', root)).toBe(false);
    await fs.writeFile(
      path.join(root, __testing.CLAIM_MARKER),
      JSON.stringify({ version: 1, ownerKey: dataOwnerStorageKey('cloud-a'), complete: true }),
    );
    process.env.XDT_PASSIVE_SHARED_USER_DATA = '1';
    try {
      expect(isLegacyOwnerNamespaceClaimOwnedBy('cloud-a', root)).toBe(true);
      expect(isLegacyOwnerNamespaceClaimOwnedBy('cloud-b', root)).toBe(false);
      expect(hasLegacyOwnerNamespaceClaim('cloud-a', root)).toBe(false);
    } finally {
      delete process.env.XDT_PASSIVE_SHARED_USER_DATA;
    }

    await fs.writeFile(
      path.join(root, __testing.CLAIM_MARKER),
      JSON.stringify({ version: 1, ownerKey: dataOwnerStorageKey('cloud-a'), complete: false }),
    );
    expect(isLegacyOwnerNamespaceClaimOwnedBy('cloud-a', root)).toBe(true);
    await fs.writeFile(path.join(root, __testing.CLAIM_MARKER), '{ invalid');
    expect(isLegacyOwnerNamespaceClaimOwnedBy('cloud-a', root)).toBe(false);
  });

  it('answers false while another live instance shares this userData, true again after it exits', async () => {
    const root = await tempRoot();
    await fs.writeFile(
      path.join(root, __testing.CLAIM_MARKER),
      JSON.stringify({ version: 1, ownerKey: dataOwnerStorageKey('cloud-a'), complete: true }),
    );
    await writeDevInstanceRecord(root, 4242);
    // complete 于过去 ≠ 此刻独占:并发实例存活期间 legacy 导入必须等待
    // (2026-07-23 safe-storage 事故形态:旧 build 后启动,secret 被搬走)。
    expect(hasLegacyOwnerNamespaceClaim('cloud-a', root, (pid) => pid === 4242)).toBe(false);
    // 同一记录,进程已退出 → 恢复放行。
    expect(hasLegacyOwnerNamespaceClaim('cloud-a', root, () => false)).toBe(true);
  });

  it('answers false while a pre-registry packaged instance holds a live SingletonLock', async () => {
    const root = await tempRoot();
    await fs.writeFile(
      path.join(root, __testing.CLAIM_MARKER),
      JSON.stringify({ version: 1, ownerKey: dataOwnerStorageKey('cloud-a'), complete: true }),
    );
    await writeSingletonLock(root, 4242);
    expect(hasLegacyOwnerNamespaceClaim('cloud-a', root, (pid) => pid === 4242)).toBe(false);
    expect(hasLegacyOwnerNamespaceClaim('cloud-a', root, () => false)).toBe(true);
  });

  it('always answers false on a passive shared-userData instance', async () => {
    const root = await tempRoot();
    await fs.writeFile(
      path.join(root, __testing.CLAIM_MARKER),
      JSON.stringify({ version: 1, ownerKey: dataOwnerStorageKey('cloud-a'), complete: true }),
    );
    process.env.XDT_PASSIVE_SHARED_USER_DATA = '1';
    try {
      expect(hasLegacyOwnerNamespaceClaim('cloud-a', root)).toBe(false);
    } finally {
      delete process.env.XDT_PASSIVE_SHARED_USER_DATA;
    }
    expect(hasLegacyOwnerNamespaceClaim('cloud-a', root)).toBe(true);
  });
});

describe('hasExclusiveSharedLegacyUserDataAccess', () => {
  beforeEach(() => {
    delete process.env.XDT_PASSIVE_SHARED_USER_DATA;
  });

  it('does not require a cloud owner claim when the shared profile is exclusive', async () => {
    const root = await tempRoot();

    expect(hasExclusiveSharedLegacyUserDataAccess(root)).toBe(true);

    process.env.XDT_PASSIVE_SHARED_USER_DATA = '1';
    try {
      expect(hasExclusiveSharedLegacyUserDataAccess(root)).toBe(false);
    } finally {
      delete process.env.XDT_PASSIVE_SHARED_USER_DATA;
    }
  });

  it('fails closed while another live instance shares the profile', async () => {
    const root = await tempRoot();
    await writeDevInstanceRecord(root, 4242);

    expect(hasExclusiveSharedLegacyUserDataAccess(root, (pid) => pid === 4242)).toBe(false);
    expect(hasExclusiveSharedLegacyUserDataAccess(root, () => false)).toBe(true);
  });
});

describe('isSameUserDataDir', () => {
  it('folds case on the case-insensitive-by-default platforms (win32, darwin), byte-exact on linux', () => {
    const { isSameUserDataDir } = __testing;
    expect(isSameUserDataDir('/Users/a/Data', '/users/a/data', 'win32')).toBe(true);
    expect(isSameUserDataDir('/Users/a/Data', '/users/a/data', 'darwin')).toBe(true);
    expect(isSameUserDataDir('/Users/a/Data', '/users/a/data', 'linux')).toBe(false);
    expect(isSameUserDataDir('/Users/a/Data', '/Users/a/Data', 'linux')).toBe(true);
    expect(isSameUserDataDir('/Users/a/Data', '/Users/b/Data', 'win32')).toBe(false);
  });
});

describe('pathExistsNoFollowSync', () => {
  it('treats any lstat-visible entry as occupied, including links', () => {
    const lstat = vi.fn(() => ({}) as never);
    expect(__testing.pathExistsNoFollowSync('destination', lstat)).toBe(true);
    expect(lstat).toHaveBeenCalledWith('destination');
  });

  it('returns missing only for ENOENT and fails closed for other lstat errors', () => {
    expect(
      __testing.pathExistsNoFollowSync('missing', () => {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      }),
    ).toBe(false);
    expect(
      __testing.pathExistsNoFollowSync('unreadable', () => {
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
      }),
    ).toBe(true);
  });
});

function realFsDeps(
  root: string,
  guardOverrides: Partial<GuardDeps> = {},
  fsOverrides: Record<string, unknown> = {},
) {
  return {
    userDataDir: () => root,
    readFile: (file: string) => fs.readFile(file, 'utf-8'),
    writeFileExclusive: (file: string, text: string) =>
      fs.writeFile(file, text, { encoding: 'utf-8', flag: 'wx' }),
    writeFile: (file: string, text: string) => fs.writeFile(file, text, 'utf-8'),
    lstat: (file: string) => fs.lstat(file),
    readdir: (dir: string) => fs.readdir(dir),
    mkdir: async (dir: string) => {
      await fs.mkdir(dir, { recursive: true });
    },
    rename: (source: string, target: string) => fs.rename(source, target),
    rmdir: (dir: string) => fs.rmdir(dir),
    readlink: (file: string) => fs.readlink(file),
    passiveSharedUserData: () => false,
    selfPid: () => process.pid,
    isPidAlive: () => false,
    ...guardOverrides,
    ...fsOverrides,
  };
}

interface GuardDeps {
  passiveSharedUserData: () => boolean;
  selfPid: () => number;
  isPidAlive: (pid: number) => boolean;
}

async function writeDevInstanceRecord(
  root: string,
  pid: number,
  userDataDir: string = root,
): Promise<void> {
  const registryDir = path.join(root, '.dev-instances');
  await fs.mkdir(registryDir, { recursive: true });
  await fs.writeFile(
    path.join(registryDir, `${pid}.json`),
    JSON.stringify({ schemaVersion: 1, pid, userDataDir, passive: false }),
    'utf-8',
  );
}

async function writeGhostDir(root: string, rootName: 'cindy-brain' | 'brain', id: string): Promise<void> {
  const dir = path.join(root, rootName, id);
  await writeGhostDirAtPath(dir, id);
}

async function writeGhostDirAtPath(
  dir: string,
  id: string,
  command?: string,
): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'ghost.json'),
    JSON.stringify({
      schemaVersion: 2,
      id,
      name: `Plugin ${id}`,
      version: '1.0.0',
      kind: 'chip',
      entry: 'main.js',
      slots: ['tool'],
      tools: [{ name: 'do_thing', description: 'Do something' }],
      ...(command === undefined ? {} : { command }),
    }),
    'utf-8',
  );
  await fs.writeFile(path.join(dir, 'main.js'), 'export default {};', 'utf-8');
}
