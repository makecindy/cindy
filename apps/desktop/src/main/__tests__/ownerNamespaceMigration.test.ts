import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { dataOwnerStorageKey } from '../appSessionState.js';
import {
  acknowledgeRecoveredLegacyGhosts,
  claimLegacyOwnerNamespace,
  getLegacyGhostRecoveryStatus,
  hasExclusiveSharedLegacyUserDataAccess,
  hasLegacyOwnerNamespaceClaim,
  isLegacyOwnerNamespaceClaimOwnedBy,
  isLegacyOwnerNamespaceClaimedByOtherOwner,
  listLegacyGhostTombstoneRoots,
  listLegacyOwnerProjectionRoots,
  recoverLegacyGhostPlugins,
  __testing,
} from '../ownerNamespaceMigration.js';

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-namespace-migration-'));
  roots.push(root);
  return root;
}

async function canCreateFileSymlink(): Promise<boolean> {
  const probeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-namespace-symlink-probe-'));
  try {
    const target = path.join(probeRoot, 'target.txt');
    const link = path.join(probeRoot, 'link.txt');
    await fs.writeFile(target, 'probe');
    await fs.symlink(target, link, process.platform === 'win32' ? 'file' : undefined);
    return true;
  } catch {
    return false;
  } finally {
    await fs.rm(probeRoot, { recursive: true, force: true });
  }
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
    await expect(
      fs.access(
        path.join(
          root,
          'owners',
          dataOwnerStorageKey('cloud-a'),
          __testing.LEGACY_GHOST_RECOVERY_MARKER,
        ),
      ),
    ).rejects.toThrow();
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

  it('ignores a live pid that OS provenance proves was reused by another app', async () => {
    const root = await tempRoot();
    const startedAtMs = 1_000_000;
    await fs.writeFile(path.join(root, 'slack-hook.json'), 'legacy-hook');
    await writeDevInstanceRecord(root, 4242, root, {
      startedAtMs,
      rootDir: '/Applications/Old Cindy.app/Contents/Resources/app.asar',
    });

    const result = await claimLegacyOwnerNamespace(
      { mode: 'cloud', dataOwnerId: 'cloud-a', user: { id: 'cloud-a' } },
      realFsDeps(root, {
        isPidAlive: (pid) => pid === 4242,
        readProcessIdentity: () => ({
          startedAtMs: startedAtMs + 120_000,
          command: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        }),
      }),
    );

    expect(result).toMatchObject({ status: 'migrated' });
    await expect(
      fs.readFile(
        path.join(root, 'owners', dataOwnerStorageKey('cloud-a'), 'slack-hook.json'),
        'utf-8',
      ),
    ).resolves.toBe('legacy-hook');
  });

  it('does not permanently defer when a pid is reused by another app shortly after exit', async () => {
    const root = await tempRoot();
    const startedAtMs = 1_000_000;
    await fs.writeFile(path.join(root, 'slack-hook.json'), 'legacy-hook');
    await writeDevInstanceRecord(root, 4242, root, { startedAtMs });

    const result = await claimLegacyOwnerNamespace(
      { mode: 'cloud', dataOwnerId: 'cloud-a', user: { id: 'cloud-a' } },
      realFsDeps(root, {
        isPidAlive: (pid) => pid === 4242,
        readProcessIdentity: () => ({
          startedAtMs: startedAtMs + 2_500,
          command: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        }),
      }),
    );

    expect(result).toMatchObject({ status: 'migrated' });
  });

  it('warms stale-pid provenance before side-channel importers inspect a completed claim', async () => {
    const root = await tempRoot();
    const startedAtMs = 1_000_000;
    await fs.writeFile(
      path.join(root, __testing.CLAIM_MARKER),
      JSON.stringify({ version: 1, ownerKey: dataOwnerStorageKey('cloud-a'), complete: true }),
    );
    await writeDevInstanceRecord(root, 4242, root, { startedAtMs });

    const result = await claimLegacyOwnerNamespace(
      { mode: 'cloud', dataOwnerId: 'cloud-a', user: { id: 'cloud-a' } },
      realFsDeps(root, {
        isPidAlive: (pid) => pid === 4242,
        readProcessIdentity: () => ({
          startedAtMs: startedAtMs + 120_000,
          command: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        }),
      }),
    );

    expect(result).toEqual({ status: 'migrated', moved: 0, conflicts: 0 });
    // Omit the synchronous identity reader: this assertion must consume the
    // proof produced by claimLegacyOwnerNamespace's async warm-up.
    expect(hasExclusiveSharedLegacyUserDataAccess(root, (pid) => pid === 4242)).toBe(true);
  });

  it('warms stale-pid provenance for local startup before synchronous guards inspect it', async () => {
    const root = await tempRoot();
    const startedAtMs = 1_000_000;
    await writeDevInstanceRecord(root, 4242, root, { startedAtMs });

    await __testing.warmStaleProcessProvenance(
      root,
      realFsDeps(root, {
        isPidAlive: (pid) => pid === 4242,
        readProcessIdentity: () => ({
          startedAtMs: startedAtMs + 120_000,
          command: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        }),
      }),
    );

    expect(hasExclusiveSharedLegacyUserDataAccess(root, (pid) => pid === 4242)).toBe(true);
  });

  it('does not delete a registry record after proving that its PID was reused', async () => {
    const root = await tempRoot();
    const startedAtMs = 1_000_000;
    const recordPath = path.join(root, '.dev-instances', '4242.json');
    await writeDevInstanceRecord(root, 4242, root, {
      instanceId: 'stale-instance',
      startedAtMs,
    });

    await __testing.warmStaleProcessProvenance(
      root,
      realFsDeps(root, {
        isPidAlive: (pid) => pid === 4242,
        readProcessIdentity: () => ({
          startedAtMs: startedAtMs + 120_000,
          command: 'C:\\Windows\\System32\\OpenConsole.exe --server',
        }),
      }),
    );

    expect(hasExclusiveSharedLegacyUserDataAccess(root, (pid) => pid === 4242)).toBe(true);
    await expect(fs.access(recordPath)).resolves.toBeUndefined();
  });

  it('keeps local startup fail-closed when provenance warmup cannot read identity', async () => {
    const root = await tempRoot();
    await writeDevInstanceRecord(root, 4242, root, { startedAtMs: 1_000_000 });

    await __testing.warmStaleProcessProvenance(
      root,
      realFsDeps(root, {
        isPidAlive: (pid) => pid === 4242,
        readProcessIdentity: () => {
          throw new Error('process inspection denied');
        },
      }),
    );

    expect(hasExclusiveSharedLegacyUserDataAccess(root, (pid) => pid === 4242)).toBe(false);
  });

  it('keeps deferring when a reused pid now belongs to another Cindy process', async () => {
    const root = await tempRoot();
    const startedAtMs = 1_000_000;
    await fs.writeFile(path.join(root, 'slack-hook.json'), 'legacy-hook');
    await writeDevInstanceRecord(root, 4242, root, { startedAtMs });

    const result = await claimLegacyOwnerNamespace(
      { mode: 'cloud', dataOwnerId: 'cloud-a', user: { id: 'cloud-a' } },
      realFsDeps(root, {
        isPidAlive: (pid) => pid === 4242,
        readProcessIdentity: () => ({
          startedAtMs: startedAtMs + 120_000,
          command: '/Applications/Cindy.app/Contents/MacOS/Cindy',
        }),
      }),
    );

    expect(result).toMatchObject({
      status: 'deferred',
      deferredReason: 'concurrent-live-instances',
    });
    await expect(fs.readFile(path.join(root, 'slack-hook.json'), 'utf-8')).resolves.toBe('legacy-hook');
  });

  it('fails closed when process identity cannot be read', async () => {
    const root = await tempRoot();
    await fs.writeFile(path.join(root, 'slack-hook.json'), 'legacy-hook');
    await writeDevInstanceRecord(root, 4242, root, { startedAtMs: 1_000_000 });

    const result = await claimLegacyOwnerNamespace(
      { mode: 'cloud', dataOwnerId: 'cloud-a', user: { id: 'cloud-a' } },
      realFsDeps(root, {
        isPidAlive: (pid) => pid === 4242,
        readProcessIdentity: () => {
          throw new Error('process inspection denied');
        },
      }),
    );

    expect(result).toMatchObject({
      status: 'deferred',
      deferredReason: 'concurrent-live-instances',
    });
    await expect(fs.readFile(path.join(root, 'slack-hook.json'), 'utf-8')).resolves.toBe('legacy-hook');
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

  it('rechecks the canonical registry record when its backup vanishes during exchange', async () => {
    const root = await tempRoot();
    await fs.writeFile(path.join(root, 'slack-hook.json'), 'legacy-hook');
    await writeDevInstanceRecord(root, 4242);
    const recordPath = path.join(root, '.dev-instances', '4242.json');
    const backupPath = `${recordPath}.bak`;
    const recordRaw = await fs.readFile(recordPath, 'utf-8');
    let canonicalReads = 0;

    const result = await claimLegacyOwnerNamespace(
      { mode: 'cloud', dataOwnerId: 'cloud-a', user: { id: 'cloud-a' } },
      realFsDeps(
        root,
        { isPidAlive: (pid) => pid === 4242 },
        {
          readFile: (file: string) => {
            if (file === recordPath) {
              canonicalReads += 1;
              if (canonicalReads === 1) {
                return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
              }
              return Promise.resolve(recordRaw);
            }
            if (file === backupPath) {
              return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
            }
            return fs.readFile(file, 'utf-8');
          },
        },
      ),
    );

    expect(canonicalReads).toBeGreaterThanOrEqual(2);
    expect(result).toEqual({
      status: 'deferred',
      moved: 0,
      conflicts: 0,
      deferredReason: 'concurrent-live-instances',
    });
    await expect(fs.readFile(path.join(root, 'slack-hook.json'), 'utf-8')).resolves.toBe('legacy-hook');
  });

  it.each([
    ['unparseable', '{not-json'],
    ['missing pid', '{}'],
    ['non-numeric pid', JSON.stringify({ pid: '4242' })],
  ])('fails closed when a registry record payload is %s', async (_label, payload) => {
    const root = await tempRoot();
    await fs.writeFile(path.join(root, 'slack-hook.json'), 'legacy-hook');
    await fs.mkdir(path.join(root, '.dev-instances'), { recursive: true });
    await fs.writeFile(path.join(root, '.dev-instances', '4242.json'), payload, 'utf-8');

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
    await expect(
      fs.readFile(path.join(root, '.dev-instances', '4242.json'), 'utf-8'),
    ).resolves.toBe(payload);
  });

  it.each([
    ['current process', process.pid],
    ['dead replacement', 9999],
  ])('uses the registry filename pid when payload names the %s', async (_label, payloadPid) => {
    const root = await tempRoot();
    await fs.writeFile(path.join(root, 'slack-hook.json'), 'legacy-hook');
    await fs.mkdir(path.join(root, '.dev-instances'), { recursive: true });
    await fs.writeFile(
      path.join(root, '.dev-instances', '4242.json'),
      JSON.stringify({ schemaVersion: 1, pid: payloadPid, userDataDir: root, passive: false }),
      'utf-8',
    );

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

  it('ignores a stale SingletonLock whose live pid has been reused by another app', async () => {
    const root = await tempRoot();
    await fs.writeFile(path.join(root, 'slack-hook.json'), 'legacy-hook');
    await writeSingletonLock(root, 4242);
    const lockMtimeMs = (await fs.lstat(path.join(root, 'SingletonLock'))).mtimeMs;

    const result = await claimLegacyOwnerNamespace(
      { mode: 'cloud', dataOwnerId: 'cloud-a', user: { id: 'cloud-a' } },
      realFsDeps(
        root,
        {
          isPidAlive: (pid) => pid === 4242,
          readProcessIdentity: () => ({
            startedAtMs: lockMtimeMs + 120_000,
            command: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          }),
        },
        { readlink: () => Promise.resolve('myhost-4242') },
      ),
    );

    expect(result).toMatchObject({ status: 'migrated' });
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
  it('keeps the claim marker valid if the completion rename fails', async () => {
    const root = await tempRoot();
    const ownerId = 'cloud-a';
    const markerPath = path.join(root, __testing.CLAIM_MARKER);
    await fs.writeFile(path.join(root, 'ghost-workdir-prefs.json'), 'legacy-prefs');
    let failCompletionRename = true;

    await expect(
      claimLegacyOwnerNamespace(
        { mode: 'cloud', dataOwnerId: ownerId, user: { id: ownerId } },
        realFsDeps(root, {}, {
          rename: async (source: string, target: string) => {
            if (target === markerPath && failCompletionRename) {
              failCompletionRename = false;
              throw Object.assign(new Error('simulated completion failure'), { code: 'EIO' });
            }
            return fs.rename(source, target);
          },
        }),
      ),
    ).rejects.toThrow('simulated completion failure');
    await expect(fs.readFile(markerPath, 'utf8').then(JSON.parse)).resolves.toMatchObject({
      version: 1,
      ownerKey: dataOwnerStorageKey(ownerId),
      complete: false,
    });
  });

  it('does not move a symlinked legacy credential into the owner namespace', async () => {
    if (!(await canCreateFileSymlink())) return;
    const root = await tempRoot();
    const external = await tempRoot();
    const source = path.join(root, 'model-access-credentials.json');
    await fs.writeFile(path.join(external, 'credentials.json'), '{"secret":"external"}');
    await fs.symlink(
      path.join(external, 'credentials.json'),
      source,
      process.platform === 'win32' ? 'file' : undefined,
    );

    const result = await claimLegacyOwnerNamespace(
      { mode: 'cloud', dataOwnerId: 'cloud-a', user: { id: 'cloud-a' } },
      realFsDeps(root),
    );
    const target = path.join(
      root,
      'owners',
      dataOwnerStorageKey('cloud-a'),
      'model-access-credentials.json',
    );

    expect(result).toMatchObject({ status: 'migrated', moved: 0, conflicts: 1 });
    expect((await fs.lstat(source)).isSymbolicLink()).toBe(true);
    await expect(fs.access(target)).rejects.toThrow();
  });

  it('does not write legacy data through a linked owner target root', async () => {
    const root = await tempRoot();
    const external = await tempRoot();
    const ownerKey = dataOwnerStorageKey('cloud-a');
    await fs.writeFile(path.join(root, 'slack-hook.json'), 'legacy-hook');
    await fs.mkdir(path.join(root, 'owners'), { recursive: true });
    await fs.symlink(
      external,
      path.join(root, 'owners', ownerKey),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const result = await claimLegacyOwnerNamespace(
      { mode: 'cloud', dataOwnerId: 'cloud-a', user: { id: 'cloud-a' } },
      realFsDeps(root),
    );

    expect(result).toMatchObject({ status: 'partial', moved: 0, conflicts: 1 });
    await expect(fs.readFile(path.join(root, 'slack-hook.json'), 'utf8')).resolves.toBe('legacy-hook');
    await expect(fs.access(path.join(external, 'slack-hook.json'))).rejects.toThrow();
  });
});

it('fails closed when owner projection roots cannot be enumerated', () => {
  const readdir = vi.spyOn(fsSync, 'readdirSync').mockImplementationOnce(() => {
    throw Object.assign(new Error('denied'), { code: 'EACCES' });
  });
  try {
    expect(() => listLegacyOwnerProjectionRoots('C:\\cindy-user-data')).toThrow('denied');
  } finally {
    readdir.mockRestore();
  }
});

it('lstats owner projection namespaces when readdir returns unknown Dirent types', async () => {
  const root = await tempRoot();
  const ownerKey = dataOwnerStorageKey('cloud-a');
  await fs.mkdir(path.join(root, 'owners', ownerKey), { recursive: true });
  const directoryType = vi.spyOn(fsSync.Dirent.prototype, 'isDirectory').mockReturnValue(false);
  try {
    expect(listLegacyOwnerProjectionRoots(root)).toEqual(expect.arrayContaining([
      path.join(root, 'owners', ownerKey, 'brain'),
      path.join(root, 'owners', ownerKey, 'cindy-brain'),
      path.join(root, 'owners', ownerKey, 'ghost-install-state'),
    ]));
  } finally {
    directoryType.mockRestore();
  }
});

it('fails closed when an owner projection namespace is replaced by a link', async () => {
  const root = await tempRoot();
  const external = await tempRoot();
  const ownerKey = dataOwnerStorageKey('cloud-a');
  await fs.mkdir(path.join(root, 'owners'), { recursive: true });
  try {
    await fs.symlink(
      external,
      path.join(root, 'owners', ownerKey),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  } catch {
    return;
  }
  expect(() => listLegacyOwnerProjectionRoots(root)).toThrow(
    'owner projection namespace is not a regular directory',
  );
});

describe('legacy Ghost plugin recovery', () => {
  it('persists a durable backfill queue before moving a legacy plugin', async () => {
    const root = await tempRoot();
    const ownerId = 'cloud-a';
    const ownerKey = dataOwnerStorageKey(ownerId);
    const source = path.join(root, 'brain', 'legacy-plugin');
    const target = path.join(root, 'owners', ownerKey, 'cindy-brain', 'legacy-plugin');
    const markerPath = path.join(
      root,
      'owners',
      ownerKey,
      __testing.LEGACY_GHOST_RECOVERY_MARKER,
    );
    await writeGhostDirAtPath(source, 'legacy-plugin');
    let interrupted = false;
    let markerPendingAtRename: string[] | null = null;
    let markerProjectionAtRename: string | null = null;

    const result = await recoverLegacyGhostPlugins(
      { mode: 'cloud', dataOwnerId: ownerId, user: { id: ownerId } },
      realFsDeps(root, {}, {
        rename: async (from: string, to: string) => {
          if (from === source && to === target) {
            const marker = (
              JSON.parse(await fs.readFile(markerPath, 'utf-8')) as {
                pendingIds: string[];
                approvalProjectionSha256ById: Record<string, string>;
              }
            );
            markerPendingAtRename = marker.pendingIds;
            markerProjectionAtRename =
              marker.approvalProjectionSha256ById['legacy-plugin'] ?? null;
          }
          await fs.rename(from, to);
          if (from === source && to === target && !interrupted) {
            interrupted = true;
            throw Object.assign(new Error('simulated process interruption'), { code: 'EIO' });
          }
        },
      }),
    );

    expect(result).toMatchObject({
      status: 'partial',
      moved: 0,
    });
    expect(markerPendingAtRename).toEqual(['legacy-plugin']);
    expect(markerProjectionAtRename).toMatch(/^[a-f0-9]{64}$/);
    await expect(fs.access(source)).rejects.toThrow();
    await expect(fs.readFile(path.join(target, 'ghost.json'), 'utf-8')).resolves.toContain(
      '"id":"legacy-plugin"',
    );
    const marker = JSON.parse(
      await fs.readFile(
        markerPath,
        'utf-8',
      ),
    ) as {
      ownerKey: string;
      pendingIds: string[];
      approvalProjectionSha256ById: Record<string, string>;
    };
    expect(marker).toMatchObject({
      version: 2,
      ownerKey,
      pendingIds: ['legacy-plugin'],
    });
    expect(marker.approvalProjectionSha256ById['legacy-plugin']).toMatch(/^[a-f0-9]{64}$/);
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
    ).resolves.toMatchObject({
      status: 'partial',
      moved: 0,
      recoveredIds: ['legacy-plugin'],
      recoveredApprovalProjectionSha256ById: {
        'legacy-plugin': marker.approvalProjectionSha256ById['legacy-plugin'],
      },
    });
  });

  it('refreshes a stale frozen projection on a later retry while the source still exists', async () => {
    const root = await tempRoot();
    const ownerId = 'cloud-a';
    const ownerKey = dataOwnerStorageKey(ownerId);
    const source = path.join(root, 'brain', 'legacy-plugin');
    const target = path.join(root, 'owners', ownerKey, 'cindy-brain', 'legacy-plugin');
    const markerPath = path.join(
      root,
      'owners',
      ownerKey,
      __testing.LEGACY_GHOST_RECOVERY_MARKER,
    );
    await writeGhostDirAtPath(source, 'legacy-plugin');
    let mutated = false;

    const first = await recoverLegacyGhostPlugins(
      { mode: 'cloud', dataOwnerId: ownerId, user: { id: ownerId } },
      realFsDeps(root, {}, {
        rename: async (from: string, to: string) => {
          await fs.rename(from, to);
          if (path.resolve(to) !== path.resolve(markerPath) || mutated) return;
          mutated = true;
          await fs.writeFile(
            path.join(source, 'ghost.json'),
            JSON.stringify({
              schemaVersion: 2,
              id: 'legacy-plugin',
              name: 'Plugin legacy-plugin',
              version: '1.0.1',
              kind: 'chip',
              entry: 'main.js',
              slots: ['tool'],
              tools: [
                { name: 'do_thing', description: 'Do something' },
                { name: 'new_thing', description: 'New thing' },
              ],
            }),
          );
        },
      }),
    );

    expect(mutated).toBe(true);
    expect(first).toMatchObject({ status: 'partial', moved: 0, conflicts: 1 });
    await expect(fs.access(source)).resolves.toBeUndefined();
    await expect(fs.access(target)).rejects.toThrow();
    const firstMarker = JSON.parse(await fs.readFile(markerPath, 'utf8')) as {
      approvalProjectionSha256ById: Record<string, string>;
    };
    const staleDigest = firstMarker.approvalProjectionSha256ById['legacy-plugin'];
    expect(staleDigest).toMatch(/^[a-f0-9]{64}$/);

    __testing.resetLegacyGhostRecoveryState();
    const second = await recoverLegacyGhostPlugins(
      { mode: 'cloud', dataOwnerId: ownerId, user: { id: ownerId } },
      realFsDeps(root),
    );

    const secondMarker = JSON.parse(await fs.readFile(markerPath, 'utf8')) as {
      approvalProjectionSha256ById: Record<string, string>;
    };
    const refreshedDigest = secondMarker.approvalProjectionSha256ById['legacy-plugin'];
    expect(refreshedDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(refreshedDigest).not.toBe(staleDigest);
    expect(second).toMatchObject({
      status: 'migrated',
      moved: 1,
      conflicts: 0,
      recoveredIds: ['legacy-plugin'],
      recoveredApprovalProjectionSha256ById: {
        'legacy-plugin': refreshedDigest,
      },
    });
    await expect(fs.access(source)).rejects.toThrow();
    await expect(fs.access(target)).resolves.toBeUndefined();
  });

  it('re-freezes an empty digest map when the legacy source still exists', async () => {
    const root = await tempRoot();
    const ownerId = 'cloud-a';
    const ownerKey = dataOwnerStorageKey(ownerId);
    const source = path.join(root, 'brain', 'legacy-plugin');
    const target = path.join(root, 'owners', ownerKey, 'cindy-brain', 'legacy-plugin');
    const markerPath = path.join(
      root,
      'owners',
      ownerKey,
      __testing.LEGACY_GHOST_RECOVERY_MARKER,
    );
    await writeGhostDirAtPath(source, 'legacy-plugin');
    await fs.mkdir(path.dirname(markerPath), { recursive: true });
    await fs.writeFile(
      markerPath,
      JSON.stringify({
        version: 1,
        ownerKey,
        pendingIds: ['legacy-plugin'],
        approvalProjectionSha256ById: {},
      }),
    );

    expect(
      getLegacyGhostRecoveryStatus(
        { mode: 'cloud', dataOwnerId: ownerId, user: { id: ownerId } },
        root,
      ),
    ).toMatchObject({ state: 'partial', legacyPluginCount: 1, canRetry: true });

    const result = await recoverLegacyGhostPlugins(
      { mode: 'cloud', dataOwnerId: ownerId, user: { id: ownerId } },
      realFsDeps(root),
    );
    const marker = JSON.parse(await fs.readFile(markerPath, 'utf8')) as {
      approvalProjectionSha256ById: Record<string, string>;
    };
    const refreshedDigest = marker.approvalProjectionSha256ById['legacy-plugin'];

    expect(refreshedDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(result).toMatchObject({
      status: 'migrated',
      moved: 1,
      conflicts: 0,
      recoveredIds: ['legacy-plugin'],
      recoveredApprovalProjectionSha256ById: {
        'legacy-plugin': refreshedDigest,
      },
    });
    await expect(fs.access(source)).rejects.toThrow();
    await expect(fs.access(target)).resolves.toBeUndefined();
  });

  it('keeps a target-only recovery marker with an empty digest map fail closed', async () => {
    const root = await tempRoot();
    const ownerId = 'cloud-a';
    const ownerKey = dataOwnerStorageKey(ownerId);
    const target = path.join(root, 'owners', ownerKey, 'cindy-brain', 'legacy-plugin');
    const markerPath = path.join(
      root,
      'owners',
      ownerKey,
      __testing.LEGACY_GHOST_RECOVERY_MARKER,
    );
    await writeGhostDirAtPath(target, 'legacy-plugin');
    await fs.mkdir(path.dirname(markerPath), { recursive: true });
    await fs.writeFile(
      markerPath,
      JSON.stringify({
        version: 1,
        ownerKey,
        pendingIds: ['legacy-plugin'],
        approvalProjectionSha256ById: {},
      }),
    );

    expect(
      getLegacyGhostRecoveryStatus(
        { mode: 'cloud', dataOwnerId: ownerId, user: { id: ownerId } },
        root,
      ),
    ).toMatchObject({ state: 'partial', legacyPluginCount: 1, canRetry: false });

    const result = await recoverLegacyGhostPlugins(
      { mode: 'cloud', dataOwnerId: ownerId, user: { id: ownerId } },
      realFsDeps(root),
    );

    expect(result).toEqual({ status: 'partial', moved: 0, conflicts: 1 });
    await expect(fs.readFile(markerPath, 'utf8').then(JSON.parse)).resolves.toMatchObject({
      version: 2,
      ownerKey,
      pendingIds: ['legacy-plugin'],
    });
    await expect(fs.readFile(path.join(target, 'ghost.json'), 'utf-8')).resolves.toContain(
      '"id":"legacy-plugin"',
    );
  });

  it('keeps a target-only legacy marker without frozen digests fail closed', async () => {
    const root = await tempRoot();
    const ownerId = 'cloud-a';
    const ownerKey = dataOwnerStorageKey(ownerId);
    const target = path.join(root, 'owners', ownerKey, 'cindy-brain', 'legacy-plugin');
    const markerPath = path.join(
      root,
      'owners',
      ownerKey,
      __testing.LEGACY_GHOST_RECOVERY_MARKER,
    );
    await writeGhostDirAtPath(target, 'legacy-plugin');
    await fs.mkdir(path.dirname(markerPath), { recursive: true });
    await fs.writeFile(
      markerPath,
      JSON.stringify({
        version: 1,
        ownerKey,
        pendingIds: ['legacy-plugin'],
      }),
    );

    const result = await recoverLegacyGhostPlugins(
      { mode: 'cloud', dataOwnerId: ownerId, user: { id: ownerId } },
      realFsDeps(root),
    );

    expect(result).toEqual({
      status: 'partial',
      moved: 0,
      conflicts: 1,
    });
    await expect(fs.readFile(markerPath, 'utf8').then(JSON.parse)).resolves.toMatchObject({
      version: 2,
      ownerKey,
      pendingIds: ['legacy-plugin'],
    });
    await expect(fs.readFile(path.join(target, 'ghost.json'), 'utf-8')).resolves.toContain(
      '"id":"legacy-plugin"',
    );
  });

  it('upgrades a target-only v1 marker before returning its frozen projection', async () => {
    const root = await tempRoot();
    const ownerId = 'cloud-a';
    const ownerKey = dataOwnerStorageKey(ownerId);
    const target = path.join(root, 'owners', ownerKey, 'cindy-brain', 'legacy-plugin');
    const markerPath = path.join(
      root,
      'owners',
      ownerKey,
      __testing.LEGACY_GHOST_RECOVERY_MARKER,
    );
    const frozenDigest = 'a'.repeat(64);
    await writeGhostDirAtPath(target, 'legacy-plugin');
    await fs.mkdir(path.dirname(markerPath), { recursive: true });
    await fs.writeFile(
      markerPath,
      JSON.stringify({
        version: 1,
        ownerKey,
        pendingIds: ['legacy-plugin'],
        approvalProjectionSha256ById: { 'legacy-plugin': frozenDigest },
      }),
    );

    await expect(
      recoverLegacyGhostPlugins(
        { mode: 'cloud', dataOwnerId: ownerId, user: { id: ownerId } },
        realFsDeps(root),
      ),
    ).resolves.toMatchObject({
      status: 'partial',
      moved: 0,
      recoveredIds: ['legacy-plugin'],
      recoveredApprovalProjectionSha256ById: { 'legacy-plugin': frozenDigest },
    });
    await expect(fs.readFile(markerPath, 'utf8').then(JSON.parse)).resolves.toEqual({
      version: 2,
      ownerKey,
      pendingIds: ['legacy-plugin'],
      approvalProjectionSha256ById: { 'legacy-plugin': frozenDigest },
    });
  });

  it('keeps target-only recovery retryable when a live registry pid was reused', async () => {
    const root = await tempRoot();
    const ownerId = 'cloud-a';
    const ownerKey = dataOwnerStorageKey(ownerId);
    const target = path.join(root, 'owners', ownerKey, 'cindy-brain', 'legacy-plugin');
    const markerPath = path.join(
      root,
      'owners',
      ownerKey,
      __testing.LEGACY_GHOST_RECOVERY_MARKER,
    );
    const startedAtMs = 1_000_000;
    await writeGhostDirAtPath(target, 'legacy-plugin');
    await fs.mkdir(path.dirname(markerPath), { recursive: true });
    await fs.writeFile(
      markerPath,
      JSON.stringify({
        version: 2,
        ownerKey,
        pendingIds: ['legacy-plugin'],
        approvalProjectionSha256ById: { 'legacy-plugin': 'a'.repeat(64) },
      }),
    );
    await writeDevInstanceRecord(root, 4242, root, { startedAtMs });

    expect(
      getLegacyGhostRecoveryStatus(
        { mode: 'cloud', dataOwnerId: ownerId, user: { id: ownerId } },
        root,
        false,
        {},
        (pid) => pid === 4242,
        () => ({
          startedAtMs: startedAtMs + 120_000,
          command: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        }),
      ),
    ).toEqual({
      state: 'partial',
      legacyPluginCount: 1,
      canRetry: true,
    });
  });

  it.each(['manifest', 'disabled', 'trust', 'locale', 'icon', 'skill'] as const)(
    'refuses an in-place %s approval projection change after the durable freeze',
    async (kind) => {
      const root = await tempRoot();
      const ownerId = 'cloud-a';
      const ownerKey = dataOwnerStorageKey(ownerId);
      const source = path.join(root, 'brain', 'legacy-plugin');
      const target = path.join(root, 'owners', ownerKey, 'cindy-brain', 'legacy-plugin');
      const markerPath = path.join(
        root,
        'owners',
        ownerKey,
        __testing.LEGACY_GHOST_RECOVERY_MARKER,
      );
      await writeGhostDirAtPath(source, 'legacy-plugin');
      const manifest = {
        schemaVersion: 2,
        id: 'legacy-plugin',
        name: 'Legacy plugin',
        version: '1.0.0',
        kind: 'chip',
        entry: 'main.js',
        icon: 'assets/icon.png',
        locales: { en: 'locales/en.json' },
        slots: ['tool', 'skill'],
        tools: [{ name: 'do_thing', description: 'Do something' }],
        skill: {
          items: [{ dir: 'skills/demo', name: 'demo', description: 'Demo skill' }],
        },
      };
      await fs.writeFile(path.join(source, 'ghost.json'), JSON.stringify(manifest));
      await fs.mkdir(path.join(source, 'assets'), { recursive: true });
      await fs.writeFile(path.join(source, 'assets', 'icon.png'), 'ORIGINAL ICON');
      await fs.mkdir(path.join(source, 'locales'), { recursive: true });
      await fs.writeFile(
        path.join(source, 'locales', 'en.json'),
        JSON.stringify({ name: 'Original name' }),
      );
      await fs.mkdir(path.join(source, 'skills', 'demo'), { recursive: true });
      await fs.writeFile(
        path.join(source, 'skills', 'demo', 'SKILL.md'),
        '---\nname: demo\ndescription: Demo skill\n---\n\nOriginal instructions\n',
      );
      let mutated = false;

      const result = await recoverLegacyGhostPlugins(
        { mode: 'cloud', dataOwnerId: ownerId, user: { id: ownerId } },
        realFsDeps(root, {}, {
          rename: async (from: string, to: string) => {
            await fs.rename(from, to);
            if (path.resolve(to) !== path.resolve(markerPath) || mutated) return;
            mutated = true;
            if (kind === 'manifest') {
              await fs.writeFile(
                path.join(source, 'ghost.json'),
                JSON.stringify({
                  ...manifest,
                  tools: [
                    ...manifest.tools,
                    { name: 'new_thing', description: 'New privileged tool' },
                  ],
                }),
              );
            } else if (kind === 'disabled') {
              await fs.writeFile(path.join(source, '.disabled'), '');
            } else if (kind === 'trust') {
              await fs.writeFile(
                path.join(source, '.cindy-trust.json'),
                JSON.stringify({
                  level: 'verified-publisher',
                  publisherSigned: true,
                  publisherVerified: true,
                  reviewed: false,
                }),
              );
            } else if (kind === 'locale') {
              await fs.writeFile(
                path.join(source, 'locales', 'en.json'),
                JSON.stringify({ name: 'Replaced name' }),
              );
            } else if (kind === 'icon') {
              await fs.writeFile(path.join(source, 'assets', 'icon.png'), 'REPLACED ICON');
            } else {
              await fs.writeFile(
                path.join(source, 'skills', 'demo', 'SKILL.md'),
                '---\nname: demo\ndescription: Demo skill\n---\n\nReplaced instructions\n',
              );
            }
          },
        }),
      );

      expect(mutated).toBe(true);
      expect(result).toMatchObject({ status: 'partial', moved: 0, conflicts: 1 });
      await expect(fs.access(source)).resolves.toBeUndefined();
      await expect(fs.access(target)).rejects.toThrow();
      const marker = JSON.parse(await fs.readFile(markerPath, 'utf8')) as {
        approvalProjectionSha256ById: Record<string, string>;
      };
      expect(marker.approvalProjectionSha256ById['legacy-plugin']).toMatch(/^[a-f0-9]{64}$/);
    },
  );

  it('does not backfill a target that appeared while the legacy source still exists', async () => {
    const root = await tempRoot();
    const ownerId = 'cloud-a';
    const ownerKey = dataOwnerStorageKey(ownerId);
    const source = path.join(root, 'brain', 'legacy-plugin');
    const target = path.join(root, 'owners', ownerKey, 'cindy-brain', 'legacy-plugin');
    await writeGhostDirAtPath(source, 'legacy-plugin');

    const result = await recoverLegacyGhostPlugins(
      { mode: 'cloud', dataOwnerId: ownerId, user: { id: ownerId } },
      realFsDeps(root, {}, {
        rename: async (from: string, to: string) => {
          if (from === source && to === target) {
            await writeGhostDirAtPath(target, 'legacy-plugin');
            throw Object.assign(new Error('target appeared before rename'), { code: 'EEXIST' });
          }
          await fs.rename(from, to);
        },
      }),
    );

    expect(result).toMatchObject({ status: 'partial', moved: 0 });
    expect(result.recoveredIds).toBeUndefined();
    await expect(fs.access(source)).resolves.toBeUndefined();
    await expect(
      recoverLegacyGhostPlugins(
        { mode: 'cloud', dataOwnerId: ownerId, user: { id: ownerId } },
        realFsDeps(root),
      ),
    ).resolves.toMatchObject({ status: 'partial', moved: 0 });
  });

  it('does not let a stale pending id expand the frozen recovery whitelist', async () => {
    const root = await tempRoot();
    const ownerId = 'cloud-a';
    const ownerKey = dataOwnerStorageKey(ownerId);
    const markerPath = path.join(
      root,
      'owners',
      ownerKey,
      __testing.LEGACY_GHOST_RECOVERY_MARKER,
    );
    await fs.mkdir(path.dirname(markerPath), { recursive: true });
    await fs.writeFile(
      markerPath,
      JSON.stringify({ version: 1, ownerKey, pendingIds: ['stale-plugin'] }),
    );
    await writeGhostDirAtPath(path.join(root, 'brain', 'new-plugin'), 'new-plugin');

    await expect(
      recoverLegacyGhostPlugins(
        { mode: 'cloud', dataOwnerId: ownerId, user: { id: ownerId } },
        realFsDeps(root),
      ),
    ).resolves.toMatchObject({ status: 'partial', moved: 0 });
    await expect(
      fs.access(path.join(root, 'brain', 'new-plugin')),
    ).resolves.toBeUndefined();
    await expect(
      fs.readFile(markerPath, 'utf8').then(JSON.parse),
    ).resolves.toEqual({
      version: 2,
      ownerKey,
      pendingIds: ['stale-plugin'],
    });
  });

  it('continues only source-present ids in a mixed recovery marker', async () => {
    const root = await tempRoot();
    const ownerId = 'cloud-a';
    const ownerKey = dataOwnerStorageKey(ownerId);
    const markerPath = path.join(
      root,
      'owners',
      ownerKey,
      __testing.LEGACY_GHOST_RECOVERY_MARKER,
    );
    await fs.mkdir(path.dirname(markerPath), { recursive: true });
    await fs.writeFile(
      markerPath,
      JSON.stringify({ version: 1, ownerKey, pendingIds: ['already-moved', 'still-legacy'] }),
    );
    await writeGhostDirAtPath(
      path.join(root, 'owners', ownerKey, 'cindy-brain', 'already-moved'),
      'already-moved',
    );
    await writeGhostDirAtPath(path.join(root, 'brain', 'still-legacy'), 'still-legacy');

    await expect(
      recoverLegacyGhostPlugins(
        { mode: 'cloud', dataOwnerId: ownerId, user: { id: ownerId } },
        realFsDeps(root),
      ),
    ).resolves.toMatchObject({
      status: 'partial',
      moved: 1,
      conflicts: 1,
      recoveredIds: ['still-legacy'],
    });
    const marker = JSON.parse(await fs.readFile(markerPath, 'utf8')) as {
      approvalProjectionSha256ById: Record<string, string>;
    };
    expect(marker.approvalProjectionSha256ById).not.toHaveProperty('already-moved');
    expect(marker.approvalProjectionSha256ById['still-legacy']).toMatch(/^[a-f0-9]{64}$/);
    await expect(
      fs.access(path.join(root, 'owners', ownerKey, 'cindy-brain', 'still-legacy')),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(root, 'owners', ownerKey, 'cindy-brain', 'already-moved')),
    ).resolves.toBeUndefined();
  });

  it('does not pick one of duplicate legacy sources for the same id', async () => {
    const root = await tempRoot();
    const ownerId = 'cloud-a';
    const ownerKey = dataOwnerStorageKey(ownerId);
    await writeGhostDirAtPath(path.join(root, 'brain', 'duplicate-plugin'), 'duplicate-plugin');
    await writeGhostDirAtPath(
      path.join(root, 'owners', ownerKey, 'brain', 'duplicate-plugin'),
      'duplicate-plugin',
    );

    await expect(
      recoverLegacyGhostPlugins(
        { mode: 'cloud', dataOwnerId: ownerId, user: { id: ownerId } },
        realFsDeps(root),
      ),
    ).resolves.toMatchObject({ status: 'partial', moved: 0, conflicts: 2 });
    await expect(fs.access(path.join(root, 'brain', 'duplicate-plugin'))).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(root, 'owners', ownerKey, 'brain', 'duplicate-plugin')),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(root, 'owners', ownerKey, 'cindy-brain', 'duplicate-plugin')),
    ).rejects.toThrow();
  });

  it('acknowledges only completed durable backfill ids', async () => {
    const root = await tempRoot();
    const ownerId = 'cloud-a';
    const ownerKey = dataOwnerStorageKey(ownerId);
    const markerPath = path.join(
      root,
      'owners',
      ownerKey,
      __testing.LEGACY_GHOST_RECOVERY_MARKER,
    );
    await fs.mkdir(path.dirname(markerPath), { recursive: true });
    await fs.writeFile(
      markerPath,
      JSON.stringify({
        version: 1,
        ownerKey,
        pendingIds: ['completed-plugin', 'retry-plugin'],
      }),
    );

    await acknowledgeRecoveredLegacyGhosts(
      ownerId,
      ['completed-plugin'],
      realFsDeps(root),
    );

    await expect(fs.readFile(markerPath, 'utf-8').then(JSON.parse)).resolves.toEqual({
      version: 2,
      ownerKey,
      pendingIds: ['retry-plugin'],
    });
  });

  it('removes the recovery marker after the last pending id is acknowledged', async () => {
    const root = await tempRoot();
    const ownerId = 'cloud-a';
    const ownerKey = dataOwnerStorageKey(ownerId);
    const markerPath = path.join(
      root,
      'owners',
      ownerKey,
      __testing.LEGACY_GHOST_RECOVERY_MARKER,
    );
    await fs.mkdir(path.dirname(markerPath), { recursive: true });
    await fs.writeFile(
      markerPath,
      JSON.stringify({
        version: 1,
        ownerKey,
        pendingIds: ['completed-plugin'],
        approvalProjectionSha256ById: {
          'completed-plugin': 'a'.repeat(64),
        },
      }),
    );

    await acknowledgeRecoveredLegacyGhosts(
      ownerId,
      ['completed-plugin'],
      realFsDeps(root),
    );

    await expect(fs.access(markerPath)).rejects.toThrow();
  });

  it('writes an empty recovery marker when final acknowledge cannot unlink', async () => {
    const root = await tempRoot();
    const ownerId = 'cloud-a';
    const ownerKey = dataOwnerStorageKey(ownerId);
    const markerPath = path.join(
      root,
      'owners',
      ownerKey,
      __testing.LEGACY_GHOST_RECOVERY_MARKER,
    );
    await fs.mkdir(path.dirname(markerPath), { recursive: true });
    await fs.writeFile(
      markerPath,
      JSON.stringify({
        version: 1,
        ownerKey,
        pendingIds: ['completed-plugin'],
        approvalProjectionSha256ById: {
          'completed-plugin': 'a'.repeat(64),
        },
      }),
    );

    await acknowledgeRecoveredLegacyGhosts(
      ownerId,
      ['completed-plugin'],
      realFsDeps(root, {}, {
        unlink: async () => {
          throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        },
      }),
    );

    await expect(fs.readFile(markerPath, 'utf8').then(JSON.parse)).resolves.toEqual({
      version: 2,
      ownerKey,
      pendingIds: [],
    });
  });

  it('treats a legacy empty recovery marker as absent for fresh discovery', async () => {
    const root = await tempRoot();
    const ownerId = 'cloud-a';
    const ownerKey = dataOwnerStorageKey(ownerId);
    const markerPath = path.join(
      root,
      'owners',
      ownerKey,
      __testing.LEGACY_GHOST_RECOVERY_MARKER,
    );
    await fs.mkdir(path.dirname(markerPath), { recursive: true });
    await fs.writeFile(markerPath, JSON.stringify({ version: 1, ownerKey, pendingIds: [] }));
    await writeGhostDirAtPath(path.join(root, 'brain', 'fresh-plugin'), 'fresh-plugin');

    await expect(
      recoverLegacyGhostPlugins(
        { mode: 'cloud', dataOwnerId: ownerId, user: { id: ownerId } },
        realFsDeps(root),
      ),
    ).resolves.toMatchObject({
      status: 'migrated',
      moved: 1,
      conflicts: 0,
      recoveredIds: ['fresh-plugin'],
    });
    await expect(
      fs.access(path.join(root, 'owners', ownerKey, 'cindy-brain', 'fresh-plugin')),
    ).resolves.toBeUndefined();
  });

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
    ).resolves.toEqual({ status: 'partial', moved: 0, conflicts: 1 });
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
    ).resolves.toEqual({ status: 'partial', moved: 0, conflicts: 1 });
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
    ).resolves.toMatchObject({ status: 'partial', moved: 0, conflicts: 1 });
    await expect(
      fs.readFile(path.join(root, 'brain', 'cindy-untrusted', 'ghost.json'), 'utf-8'),
    ).resolves.toContain('"id":"cindy-untrusted"');
    await expect(fs.access(path.join(root, __testing.CLAIM_MARKER))).rejects.toThrow();
  });

  it('keeps corrupt reserved sources out of a newly frozen recovery marker', async () => {
    const root = await tempRoot();
    const ownerId = 'cloud-a';
    const ownerKey = dataOwnerStorageKey(ownerId);
    const markerPath = path.join(
      root,
      'owners',
      ownerKey,
      __testing.LEGACY_GHOST_RECOVERY_MARKER,
    );
    await writeGhostDir(root, 'brain', 'recoverable-plugin');
    await fs.mkdir(path.join(root, 'brain', 'cindy-corrupt'), { recursive: true });
    await fs.writeFile(path.join(root, 'brain', 'cindy-corrupt', 'ghost.json'), '{ nope');

    await expect(
      recoverLegacyGhostPlugins(
        { mode: 'cloud', dataOwnerId: ownerId, user: { id: ownerId } },
        realFsDeps(root),
        { rejectReservedIds: true },
      ),
    ).resolves.toMatchObject({ status: 'partial', moved: 1, conflicts: 1 });

    const marker = JSON.parse(await fs.readFile(markerPath, 'utf8')) as {
      pendingIds: string[];
      failedIds?: string[];
      approvalProjectionSha256ById?: Record<string, string>;
    };
    expect(marker.pendingIds).toEqual(['recoverable-plugin']);
    expect(marker.failedIds ?? []).not.toContain('cindy-corrupt');
    expect(marker.approvalProjectionSha256ById ?? {}).not.toHaveProperty('cindy-corrupt');
    await expect(
      fs.readFile(path.join(root, 'brain', 'cindy-corrupt', 'ghost.json'), 'utf8'),
    ).resolves.toBe('{ nope');
  });

  it('removes reserved ids from a dirty marker before later fresh discovery', async () => {
    const root = await tempRoot();
    const ownerId = 'cloud-a';
    const ownerKey = dataOwnerStorageKey(ownerId);
    const markerPath = path.join(
      root,
      'owners',
      ownerKey,
      __testing.LEGACY_GHOST_RECOVERY_MARKER,
    );
    await fs.mkdir(path.dirname(markerPath), { recursive: true });
    await fs.writeFile(markerPath, JSON.stringify({
      version: 2,
      ownerKey,
      pendingIds: ['cindy-reserved'],
      failedIds: ['cindy-reserved'],
      approvalProjectionSha256ById: { 'cindy-reserved': 'a'.repeat(64) },
    }));

    await expect(
      recoverLegacyGhostPlugins(
        { mode: 'cloud', dataOwnerId: ownerId, user: { id: ownerId } },
        realFsDeps(root),
        { rejectReservedIds: true },
      ),
    ).resolves.toMatchObject({ moved: 0 });
    await expect(fs.access(markerPath)).rejects.toThrow();

    await writeGhostDir(root, 'brain', 'later-plugin');
    await expect(
      recoverLegacyGhostPlugins(
        { mode: 'cloud', dataOwnerId: ownerId, user: { id: ownerId } },
        realFsDeps(root),
        { rejectReservedIds: true },
      ),
    ).resolves.toMatchObject({ moved: 1, recoveredIds: ['later-plugin'] });
  });

  it('does not freeze fresh legacy recovery behind a marker containing only reserved ids', async () => {
    const root = await tempRoot();
    const ownerId = 'cloud-a';
    const ownerKey = dataOwnerStorageKey(ownerId);
    const markerPath = path.join(
      root,
      'owners',
      ownerKey,
      __testing.LEGACY_GHOST_RECOVERY_MARKER,
    );
    await fs.mkdir(path.dirname(markerPath), { recursive: true });
    await fs.writeFile(markerPath, JSON.stringify({
      version: 2,
      ownerKey,
      pendingIds: ['cindy-reserved'],
      failedIds: ['cindy-reserved'],
      approvalProjectionSha256ById: { 'cindy-reserved': 'a'.repeat(64) },
    }));
    await writeGhostDir(root, 'brain', 'later-plugin');

    await expect(
      getLegacyGhostRecoveryStatus(
        { mode: 'cloud', dataOwnerId: ownerId, user: { id: ownerId } },
        root,
        false,
        { rejectReservedIds: true },
      ),
    ).toEqual({ state: 'partial', legacyPluginCount: 1, canRetry: true });
  });

  it('recovers fresh legacy plugins in the same pass when the marker only contains reserved ids', async () => {
    const root = await tempRoot();
    const ownerId = 'cloud-a';
    const ownerKey = dataOwnerStorageKey(ownerId);
    const markerPath = path.join(
      root,
      'owners',
      ownerKey,
      __testing.LEGACY_GHOST_RECOVERY_MARKER,
    );
    await fs.mkdir(path.dirname(markerPath), { recursive: true });
    await fs.writeFile(markerPath, JSON.stringify({
      version: 2,
      ownerKey,
      pendingIds: ['cindy-reserved'],
      failedIds: ['cindy-reserved'],
      approvalProjectionSha256ById: { 'cindy-reserved': 'a'.repeat(64) },
    }));
    await writeGhostDir(root, 'brain', 'later-plugin');

    await expect(
      recoverLegacyGhostPlugins(
        { mode: 'cloud', dataOwnerId: ownerId, user: { id: ownerId } },
        realFsDeps(root),
        { rejectReservedIds: true },
      ),
    ).resolves.toMatchObject({ status: 'migrated', moved: 1, recoveredIds: ['later-plugin'] });
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
          path.basename(source) === '.builtin-provisioning.json' ||
          path.basename(target) === __testing.LEGACY_GHOST_RECOVERY_MARKER
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
    expect(result).toMatchObject({ status: 'partial', moved: 1, conflicts: 1 });
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

  it('recovers legacy manual metadata from shared and owner-scoped roots without weakening other validation', async () => {
    const root = await tempRoot();
    const ownerId = 'cloud-a';
    const ownerKey = dataOwnerStorageKey(ownerId);
    await writeGhostDirWithManifest(
      path.join(root, 'brain', 'legacy-string'),
      'legacy-string',
      { manual: 'old notes' },
    );
    await writeGhostDirWithManifest(
      path.join(root, 'owners', ownerKey, 'brain', 'legacy-object'),
      'legacy-object',
      { manual: { arbitrary: 'old metadata' } },
    );
    await writeGhostDirWithManifest(
      path.join(root, 'brain', 'invalid-other-field'),
      'invalid-other-field',
      { manual: 'old notes', name: 42 },
    );

    expect(
      getLegacyGhostRecoveryStatus(
        { mode: 'cloud', dataOwnerId: ownerId, user: { id: ownerId } },
        root,
      ),
    // Legacy manual metadata is ignored only for compatibility. The manifest
    // with an invalid known field remains visible as a fail-closed conflict.
    ).toEqual({ state: 'partial', legacyPluginCount: 3, canRetry: true });

    await expect(
      recoverLegacyGhostPlugins(
        { mode: 'cloud', dataOwnerId: ownerId, user: { id: ownerId } },
        realFsDeps(root),
      ),
    ).resolves.toMatchObject({ status: 'partial', moved: 2, conflicts: 1 });
    const targetRoot = path.join(root, 'owners', ownerKey, 'cindy-brain');
    await expect(fs.access(path.join(targetRoot, 'legacy-string'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(targetRoot, 'legacy-object'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(root, 'brain', 'invalid-other-field'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(targetRoot, 'invalid-other-field'))).rejects.toThrow();
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
        rename: (source: string, target: string) =>
          path.basename(target) === __testing.LEGACY_GHOST_RECOVERY_MARKER
            ? fs.rename(source, target)
            : Promise.reject(Object.assign(new Error('rename denied'), { code: 'EACCES' })),
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

    expect(result).toEqual({ status: 'partial', moved: 0, conflicts: 1 });
    await expect(fs.access(path.join(root, __testing.CLAIM_MARKER))).rejects.toThrow();
    await expect(fs.readFile(path.join(root, 'dialogues', 'session.json'), 'utf-8')).resolves.toBe(
      'legacy-dialogue',
    );
  });

  it('defers the whole recovery when a legacy root cannot be enumerated', async () => {
    const root = await tempRoot();
    const ownerId = 'cloud-a';
    await writeGhostDir(root, 'cindy-brain', 'ready-plugin');
    await writeGhostDir(root, 'brain', 'unreadable-plugin');
    const blockedRoot = path.join(root, 'brain');
    const originalReaddir = fsSync.readdirSync.bind(fsSync);
    const readdirSpy = vi.spyOn(fsSync, 'readdirSync').mockImplementation((dir, options) => {
      if (path.resolve(String(dir)) === path.resolve(blockedRoot)) {
        throw Object.assign(new Error('scan denied'), { code: 'EACCES' });
      }
      return originalReaddir(dir as never, options as never) as never;
    });
    try {
      expect(
        getLegacyGhostRecoveryStatus(
          { mode: 'cloud', dataOwnerId: ownerId, user: { id: ownerId } },
          root,
        ),
      ).toEqual({
        state: 'deferred',
        legacyPluginCount: 2,
        canRetry: true,
        deferredReason: 'legacy-discovery-incomplete',
      });
      await expect(
        recoverLegacyGhostPlugins(
          { mode: 'cloud', dataOwnerId: ownerId, user: { id: ownerId } },
          realFsDeps(root),
        ),
      ).resolves.toEqual({
        status: 'deferred',
        moved: 0,
        conflicts: 0,
        deferredReason: 'legacy-discovery-incomplete',
      });
    } finally {
      readdirSpy.mockRestore();
    }
    await expect(
      fs.readFile(path.join(root, 'cindy-brain', 'ready-plugin', 'ghost.json'), 'utf-8'),
    ).resolves.toContain('"id":"ready-plugin"');
    await expect(
      fs.access(path.join(root, 'owners', dataOwnerStorageKey(ownerId), 'cindy-brain')),
    ).rejects.toThrow();
  });

  it('defers recovery when a legacy manifest is temporarily unreadable', async () => {
    const root = await tempRoot();
    const ownerId = 'cloud-a';
    await writeGhostDir(root, 'cindy-brain', 'unreadable-manifest');
    const manifestPath = path.join(root, 'cindy-brain', 'unreadable-manifest', 'ghost.json');
    const boundedModule = await import('../utils/readBoundedFile.js');
    const originalNoFollowSync = boundedModule.readBoundedFileNoFollowSync;
    const noFollowSpy = vi
      .spyOn(boundedModule, 'readBoundedFileNoFollowSync')
      .mockImplementation(
        (file: string, maxBytes?: number, options?: { containWithin?: string; nonBlocking?: boolean }) => {
          if (path.resolve(String(file)) === path.resolve(manifestPath)) {
            throw Object.assign(new Error('manifest locked'), { code: 'EACCES' });
          }
          return originalNoFollowSync(file, maxBytes!, options!);
        },
      );
    try {
      expect(
        getLegacyGhostRecoveryStatus(
          { mode: 'cloud', dataOwnerId: ownerId, user: { id: ownerId } },
          root,
        ),
      ).toMatchObject({
        state: 'deferred',
        legacyPluginCount: 1,
        canRetry: true,
        deferredReason: 'legacy-discovery-incomplete',
      });
      await expect(
        recoverLegacyGhostPlugins(
          { mode: 'cloud', dataOwnerId: ownerId, user: { id: ownerId } },
          realFsDeps(root),
        ),
      ).resolves.toMatchObject({
        status: 'deferred',
        moved: 0,
        deferredReason: 'legacy-discovery-incomplete',
      });
    } finally {
      noFollowSpy.mockRestore();
    }
    await expect(fs.access(manifestPath)).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(root, 'owners', dataOwnerStorageKey(ownerId), 'cindy-brain')),
    ).rejects.toThrow();
  });

  it('defers and keeps the queue when the recovery marker is temporarily unreadable', async () => {
    const root = await tempRoot();
    const ownerId = 'cloud-a';
    const ownerKey = dataOwnerStorageKey(ownerId);
    const markerPath = path.join(
      root,
      'owners',
      ownerKey,
      __testing.LEGACY_GHOST_RECOVERY_MARKER,
    );
    await fs.mkdir(path.dirname(markerPath), { recursive: true });
    await fs.writeFile(
      markerPath,
      JSON.stringify({ version: 1, ownerKey, pendingIds: ['queued-plugin'] }),
    );
    await writeGhostDir(root, 'brain', 'queued-plugin');
    // readLegacyGhostRecoveryMarker now uses readBoundedFileNoFollow;
    // inject EACCES at the bounded reader so the marker stays unreadable.
    const boundedModule = await import('../utils/readBoundedFile.js');
    const readerSpy = vi
      .spyOn(boundedModule, 'readBoundedFileNoFollow')
      .mockRejectedValueOnce(
        Object.assign(new Error('marker locked'), { code: 'EACCES' }),
      );
    try {
      const result = await recoverLegacyGhostPlugins(
        { mode: 'cloud', dataOwnerId: ownerId, user: { id: ownerId } },
        realFsDeps(root),
      );
      expect(result).toEqual({
        status: 'deferred',
        moved: 0,
        conflicts: 0,
        deferredReason: 'legacy-discovery-incomplete',
      });
    } finally {
      readerSpy.mockRestore();
    }
    await expect(fs.access(path.join(root, 'brain', 'queued-plugin'))).resolves.toBeUndefined();
  });

  it('does not let a reserved deferred target id block visible recovery status', async () => {
    const root = await tempRoot();
    const ownerId = 'cloud-a';
    const ownerKey = dataOwnerStorageKey(ownerId);
    const markerPath = path.join(
      root,
      'owners',
      ownerKey,
      __testing.LEGACY_GHOST_RECOVERY_MARKER,
    );
    const reservedManifestPath = path.join(
      root,
      'owners',
      ownerKey,
      'cindy-brain',
      'cindy-reserved',
      'ghost.json',
    );
    await fs.mkdir(path.dirname(markerPath), { recursive: true });
    await fs.writeFile(
      markerPath,
      JSON.stringify({
        version: 1,
        ownerKey,
        pendingIds: ['cindy-reserved', 'recoverable-plugin'],
      }),
    );
    await writeGhostDirAtPath(path.dirname(reservedManifestPath), 'cindy-reserved');
    await writeGhostDir(root, 'brain', 'recoverable-plugin');

    const boundedModule = await import('../utils/readBoundedFile.js');
    const originalNoFollowSync = boundedModule.readBoundedFileNoFollowSync;
    const noFollowSpy = vi
      .spyOn(boundedModule, 'readBoundedFileNoFollowSync')
      .mockImplementation(
        (file: string, maxBytes?: number, options?: { containWithin?: string; nonBlocking?: boolean }) => {
          if (path.resolve(String(file)) === path.resolve(reservedManifestPath)) {
            throw Object.assign(new Error('reserved manifest locked'), { code: 'EACCES' });
          }
          return originalNoFollowSync(file, maxBytes!, options!);
        },
      );
    try {
      expect(
        getLegacyGhostRecoveryStatus(
          { mode: 'cloud', dataOwnerId: ownerId, user: { id: ownerId } },
          root,
          false,
          { rejectReservedIds: true },
        ),
      ).toEqual({ state: 'partial', legacyPluginCount: 1, canRetry: true });
    } finally {
      noFollowSpy.mockRestore();
    }
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

  it('recovers plugins when a live registry pid was reused by another app', async () => {
    const root = await tempRoot();
    const ownerId = 'cloud-a';
    const ownerKey = dataOwnerStorageKey(ownerId);
    const startedAtMs = 1_000_000;
    await writeGhostDir(root, 'cindy-brain', 'valid-plugin');
    await writeDevInstanceRecord(root, 4242, root, { startedAtMs });

    const result = await recoverLegacyGhostPlugins(
      { mode: 'cloud', dataOwnerId: ownerId, user: { id: ownerId } },
      realFsDeps(root, {
        isPidAlive: (pid) => pid === 4242,
        readProcessIdentity: () => ({
          startedAtMs: startedAtMs + 120_000,
          command: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        }),
      }),
    );

    expect(result).toMatchObject({ status: 'migrated', moved: 1 });
    await expect(
      fs.readFile(
        path.join(root, 'owners', ownerKey, 'cindy-brain', 'valid-plugin', 'ghost.json'),
        'utf-8',
      ),
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

  it('keeps a pending but invalid moved target visible for recovery', async () => {
    const root = await tempRoot();
    const ownerId = 'cloud-a';
    const ownerKey = dataOwnerStorageKey(ownerId);
    const markerPath = path.join(root, 'owners', ownerKey, __testing.LEGACY_GHOST_RECOVERY_MARKER);
    const targetDir = path.join(root, 'owners', ownerKey, 'cindy-brain', 'broken-plugin');
    await fs.mkdir(targetDir, { recursive: true });
    await fs.writeFile(path.join(targetDir, 'ghost.json'), '{ broken');
    await fs.mkdir(path.dirname(markerPath), { recursive: true });
    await fs.writeFile(
      markerPath,
      JSON.stringify({ version: 1, ownerKey, pendingIds: ['broken-plugin'] }),
    );

    expect(
      getLegacyGhostRecoveryStatus(
        { mode: 'cloud', dataOwnerId: ownerId, user: { id: ownerId } },
        root,
      ),
    ).toMatchObject({ state: 'partial', legacyPluginCount: 1, canRetry: false });
  });

  it('keeps pending recovery visible when the target root itself becomes invalid', async () => {
    const root = await tempRoot();
    const ownerId = 'cloud-a';
    const ownerKey = dataOwnerStorageKey(ownerId);
    const ownerRoot = path.join(root, 'owners', ownerKey);
    const markerPath = path.join(ownerRoot, __testing.LEGACY_GHOST_RECOVERY_MARKER);
    await fs.mkdir(ownerRoot, { recursive: true });
    await fs.writeFile(path.join(ownerRoot, 'cindy-brain'), 'replaced target root');
    await fs.writeFile(
      markerPath,
      JSON.stringify({ version: 1, ownerKey, pendingIds: ['moved-plugin'] }),
    );

    expect(
      getLegacyGhostRecoveryStatus(
        { mode: 'cloud', dataOwnerId: ownerId, user: { id: ownerId } },
        root,
      ),
    ).toEqual({ state: 'partial', legacyPluginCount: 1, canRetry: false });
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
    expect(status).toEqual({
      state: 'claimed-by-other-owner',
      legacyPluginCount: 1,
      canRetry: false,
    });
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

  it.each([
    ['unparseable', '{not-json'],
    ['missing pid', '{}'],
    ['non-numeric pid', JSON.stringify({ pid: '4242' })],
  ])('fails closed when a shared instance registry payload is %s', async (_label, payload) => {
    const root = await tempRoot();
    await fs.mkdir(path.join(root, '.dev-instances'), { recursive: true });
    await fs.writeFile(path.join(root, '.dev-instances', '4242.json'), payload, 'utf-8');

    expect(hasExclusiveSharedLegacyUserDataAccess(root, (pid) => pid === 4242)).toBe(false);
    expect(hasExclusiveSharedLegacyUserDataAccess(root, () => false)).toBe(true);
  });

  it.each([
    ['current process', process.pid],
    ['dead replacement', 9999],
  ])('uses the registry filename pid when the shared payload names the %s', async (_label, payloadPid) => {
    const root = await tempRoot();
    await fs.mkdir(path.join(root, '.dev-instances'), { recursive: true });
    await fs.writeFile(
      path.join(root, '.dev-instances', '4242.json'),
      JSON.stringify({ schemaVersion: 1, pid: payloadPid, userDataDir: root, passive: false }),
      'utf-8',
    );

    expect(hasExclusiveSharedLegacyUserDataAccess(root, (pid) => pid === 4242)).toBe(false);
    expect(hasExclusiveSharedLegacyUserDataAccess(root, () => false)).toBe(true);
  });

  it('restores an atomic-write backup before deciding that a live instance vanished', async () => {
    const root = await tempRoot();
    await writeDevInstanceRecord(root, 4242);
    const recordPath = path.join(root, '.dev-instances', '4242.json');
    await fs.rename(recordPath, `${recordPath}.bak`);

    expect(hasExclusiveSharedLegacyUserDataAccess(root, (pid) => pid === 4242)).toBe(false);
    await expect(fs.access(recordPath)).resolves.toBeUndefined();
    await expect(fs.access(`${recordPath}.bak`)).rejects.toThrow();
  });

  it('ignores a registry pid that was reused by another app', async () => {
    const root = await tempRoot();
    const startedAtMs = 1_000_000;
    await writeDevInstanceRecord(root, 4242, root, { startedAtMs });

    expect(
      hasExclusiveSharedLegacyUserDataAccess(
        root,
        (pid) => pid === 4242,
        () => ({
          startedAtMs: startedAtMs + 120_000,
          command: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        }),
      ),
    ).toBe(true);
  });

  it('reuses async stale-pid proof in sync guards and invalidates it when the record changes', async () => {
    const root = await tempRoot();
    const startedAtMs = 1_000_000;
    const recordPath = path.join(root, '.dev-instances', '4242.json');
    await writeDevInstanceRecord(root, 4242, root, {
      instanceId: 'stale-instance',
      startedAtMs,
    });

    await claimLegacyOwnerNamespace(
      { mode: 'cloud', dataOwnerId: 'cloud-a', user: { id: 'cloud-a' } },
      realFsDeps(root, {
        isPidAlive: (pid) => pid === 4242,
        readProcessIdentity: () => ({
          startedAtMs: startedAtMs + 120_000,
          command: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        }),
      }),
    );

    expect(hasExclusiveSharedLegacyUserDataAccess(root, (pid) => pid === 4242)).toBe(true);

    const replacementRaw = JSON.stringify({
      schemaVersion: 1,
      instanceId: 'replacement-instance',
      pid: 4242,
      userDataDir: root,
      passive: false,
      startedAtMs: startedAtMs + 1,
    });
    const replacementPath = `${recordPath}.replacement`;
    await fs.writeFile(replacementPath, replacementRaw, 'utf-8');
    await fs.rename(replacementPath, recordPath);

    expect(hasExclusiveSharedLegacyUserDataAccess(root, (pid) => pid === 4242)).toBe(false);
    await expect(fs.readFile(recordPath, 'utf-8')).resolves.toBe(replacementRaw);
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
    unlink: (file: string) => fs.unlink(file),
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
    readProcessIdentity: () => null,
    ...guardOverrides,
    ...fsOverrides,
  };
}

interface GuardDeps {
  passiveSharedUserData: () => boolean;
  selfPid: () => number;
  isPidAlive: (pid: number) => boolean;
  readProcessIdentity: (pid: number) => { startedAtMs: number; command: string } | null;
}

async function writeDevInstanceRecord(
  root: string,
  pid: number,
  userDataDir: string = root,
  options: { startedAtMs?: number; rootDir?: string; instanceId?: string } = {},
): Promise<void> {
  const registryDir = path.join(root, '.dev-instances');
  await fs.mkdir(registryDir, { recursive: true });
  await fs.writeFile(
    path.join(registryDir, `${pid}.json`),
    JSON.stringify({ schemaVersion: 1, pid, userDataDir, passive: false, ...options }),
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
  await writeGhostDirWithManifest(dir, id, command === undefined ? {} : { command });
}

async function writeGhostDirWithManifest(
  dir: string,
  id: string,
  extra: Record<string, unknown>,
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
      ...extra,
    }),
    'utf-8',
  );
  await fs.writeFile(path.join(dir, 'main.js'), 'export default {};', 'utf-8');
}
