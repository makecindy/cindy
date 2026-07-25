import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { dataOwnerStorageKey } from '../appSessionState.js';
import {
  claimLegacyOwnerNamespace,
  hasLegacyOwnerNamespaceClaim,
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

  it('defers when a pre-patch packaged instance holds a live SingletonLock', async () => {
    const root = await tempRoot();
    await fs.writeFile(path.join(root, 'slack-hook.json'), 'legacy-hook');
    // 历史 packaged build 不写 .dev-instances,但持有 Chromium 单例锁 symlink。
    await writeSingletonLock(root, 4242);

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
  });

  it('ignores a stale SingletonLock whose pid is dead and migrates normally', async () => {
    const root = await tempRoot();
    await fs.writeFile(path.join(root, 'slack-hook.json'), 'legacy-hook');
    await writeSingletonLock(root, 4242);

    const result = await claimLegacyOwnerNamespace(
      { mode: 'cloud', dataOwnerId: 'cloud-a', user: { id: 'cloud-a' } },
      realFsDeps(root), // isPidAlive 恒 false = 崩溃残留
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
