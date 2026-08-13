import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { WorktreeMeta } from '../types';
import {
  _resetSafeDirectoryStateForTests,
  _setGlobalConfigWriteOriginProviderForTests,
  _setActiveWorktreesProviderForTests,
  _setSafeDirectoryCrossProcessLockRunnerForTests,
  _setLiveSessionPathKeysProviderForTests,
  _setSafeDirectoryGitRunnerForTests,
  _setSafeDirectoryHomePathProviderForTests,
  _setSafeDirectoryLedgerStoreForTests,
  _setSafeDirectoryProfilePathProviderForTests,
  _setSafeDirectoryProcessProvidersForTests,
  ensureSafeDirectory,
  reconcileSafeDirectories,
  resolveSafeDirectorySharedStateRoot,
  retainSafeDirectoryUsage,
  withSafeDirectoryRetention,
  withSafeDirectoryWitnessRefresh,
} from '../safeDirectory';

class ConfigFailure extends Error {
  readonly exitCode: number;

  constructor(exitCode: number, message: string) {
    super(message);
    this.exitCode = exitCode;
  }
}

class MemoryLedgerStore {
  grants: unknown[] = [];
  profileRetentions: unknown[] = [];
  profileRetentionRevision = 0;

  constructor(readonly path: string) {}

  get(
    key: 'grants' | 'profileRetentions' | 'profileRetentionRevision',
    defaultValue: unknown,
  ): unknown {
    return this[key] ?? defaultValue;
  }

  set(key: 'grants' | 'profileRetentions' | 'profileRetentionRevision', value: unknown): void {
    if (key === 'profileRetentionRevision') {
      this.profileRetentionRevision = value as number;
      return;
    }
    this[key] = structuredClone(value as unknown[]);
  }
}

interface ConfigEntry {
  filePath: string;
  value: string;
}

function makeMeta(baseRepo: string, worktreePath: string): WorktreeMeta {
  return {
    sessionId: 'session-1',
    name: path.basename(worktreePath),
    path: worktreePath,
    baseRepo,
    branch: `cindy/${path.basename(worktreePath)}`,
    sourceBranch: 'main',
    createdAt: '2026-08-13T00:00:00.000Z',
  };
}

describe('safe.directory ownership ledger', () => {
  let tmpRoot: string;
  let globalConfig: string;
  let entries: ConfigEntry[];
  let activeWorktrees: WorktreeMeta[];
  let liveSessionPathKeys: Set<string> | null;
  let currentProfilePath: string;
  let currentProcessId: number;
  let processLiveness: Map<number, 'alive' | 'missing' | 'unknown'>;
  let ledger: MemoryLedgerStore;
  let duplicateOnAdd: boolean;
  let recreateAfterNextAdd: boolean;
  let recreateBeforeNextShowOrigin: boolean;
  let executeConfig: ReturnType<typeof vi.fn>;
  let persistEntries: (replaceFile?: boolean) => void;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-safe-directory-'));
    globalConfig = path.join(tmpRoot, 'global.gitconfig');
    entries = [];
    activeWorktrees = [];
    liveSessionPathKeys = new Set();
    currentProfilePath = path.join(tmpRoot, 'profile-a');
    currentProcessId = 101;
    processLiveness = new Map([[101, 'alive']]);
    ledger = new MemoryLedgerStore(path.join(tmpRoot, 'ledger.json'));
    duplicateOnAdd = false;
    recreateAfterNextAdd = false;
    recreateBeforeNextShowOrigin = false;
    persistEntries = (replaceFile = false) => {
      const contents = JSON.stringify(entries);
      if (!replaceFile) {
        fs.writeFileSync(globalConfig, contents);
        return;
      }
      const replacement = `${globalConfig}.replacement`;
      fs.writeFileSync(replacement, contents);
      fs.renameSync(replacement, globalConfig);
    };

    executeConfig = vi.fn(async (args: readonly string[]) => {
      if (args.includes('--show-origin')) {
        if (recreateBeforeNextShowOrigin && entries.length > 0) {
          recreateBeforeNextShowOrigin = false;
          const recreated = entries.at(-1)!;
          entries = [];
          persistEntries(true);
          entries = [recreated];
          persistEntries(true);
        }
        if (entries.length === 0) throw new ConfigFailure(1, 'missing key');
        return {
          stdout: entries.map((entry) => `file:${entry.filePath}\0${entry.value}\0`).join(''),
          stderr: '',
        };
      }

      if (args.includes('--file') && args.includes('--add')) {
        const filePath = args[args.indexOf('--file') + 1];
        const value = args.at(-1)!;
        entries.push({ filePath: globalConfig, value });
        if (duplicateOnAdd) entries.push({ filePath: globalConfig, value });
        if (recreateAfterNextAdd) {
          recreateAfterNextAdd = false;
          recreateBeforeNextShowOrigin = true;
        }
        fs.writeFileSync(filePath, JSON.stringify(entries));
        return { stdout: '', stderr: '' };
      }

      if (args.includes('--file') && args.includes('--get-all')) {
        const filePath = args[args.indexOf('--file') + 1];
        const values = entries
          .filter((entry) => entry.filePath === filePath)
          .map((entry) => entry.value);
        if (values.length === 0) throw new ConfigFailure(1, 'missing key');
        return { stdout: values.map((value) => `${value}\0`).join(''), stderr: '' };
      }

      if (args.includes('--file') && args.includes('--unset')) {
        const filePath = args[args.indexOf('--file') + 1];
        const realGlobalConfig = fs.realpathSync(globalConfig);
        const isCindyStagingFile = filePath.startsWith(`${realGlobalConfig}.lock.cindy-`);
        const entryOrigin = isCindyStagingFile ? globalConfig : filePath;
        const value = args.at(-1)!;
        const matches = entries.filter(
          (entry) => entry.filePath === entryOrigin && entry.value === value,
        );
        if (matches.length !== 1) throw new ConfigFailure(5, 'multiple matches');
        const index = entries.findIndex(
          (entry) => entry.filePath === entryOrigin && entry.value === value,
        );
        entries.splice(index, 1);
        fs.writeFileSync(filePath, JSON.stringify(entries));
        return { stdout: '', stderr: '' };
      }

      throw new Error(`unexpected git config args: ${args.join(' ')}`);
    });

    _setSafeDirectoryLedgerStoreForTests(ledger);
    _setSafeDirectoryGitRunnerForTests(executeConfig);
    _setGlobalConfigWriteOriginProviderForTests(async () => globalConfig);
    _setActiveWorktreesProviderForTests(() => activeWorktrees);
    _setLiveSessionPathKeysProviderForTests(async () => liveSessionPathKeys);
    _setSafeDirectoryProfilePathProviderForTests(() => currentProfilePath);
    _setSafeDirectoryProcessProvidersForTests(
      () => currentProcessId,
      (processId) => processLiveness.get(processId) ?? 'missing',
    );
    _setSafeDirectoryCrossProcessLockRunnerForTests((_lockPath, _options, task) =>
      task({ held: true }),
    );
  });

  afterEach(() => {
    _resetSafeDirectoryStateForTests();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('does not claim or remove an exact value that already existed', async () => {
    const repositoryPath = path.join(tmpRoot, "repo with 'quote'");
    entries.push({ filePath: globalConfig, value: repositoryPath });

    await ensureSafeDirectory(repositoryPath);
    await reconcileSafeDirectories();

    expect(entries).toEqual([{ filePath: globalConfig, value: repositoryPath }]);
    expect(ledger.grants).toEqual([]);
    expect(executeConfig.mock.calls.some(([args]) => args.includes('--add'))).toBe(false);
  });

  it('uses command scope after an empty reset when the same value cannot be uniquely owned', async () => {
    const repositoryPath = path.join(tmpRoot, 'repo');
    entries.push(
      { filePath: globalConfig, value: repositoryPath },
      { filePath: globalConfig, value: '' },
    );
    persistEntries();

    await expect(ensureSafeDirectory(repositoryPath)).resolves.toBe('command');

    expect(entries).toEqual([
      { filePath: globalConfig, value: repositoryPath },
      { filePath: globalConfig, value: '' },
    ]);
    expect(ledger.grants).toEqual([]);
    expect(executeConfig.mock.calls.some(([args]) => args.includes('--add'))).toBe(false);
  });

  it('uses the app home path when a Windows-style environment has no HOME', async () => {
    globalConfig = path.join(tmpRoot, '.gitconfig');
    _setGlobalConfigWriteOriginProviderForTests(null);
    _setSafeDirectoryHomePathProviderForTests(() => tmpRoot);
    const repositoryPath = path.join(tmpRoot, 'repo');

    await ensureSafeDirectory(repositoryPath, {
      HOME: '',
      USERPROFILE: tmpRoot,
      XDG_CONFIG_HOME: path.join(tmpRoot, 'missing-xdg'),
    });

    expect(entries).toEqual([{ filePath: globalConfig, value: repositoryPath }]);
    expect(ledger.grants).toEqual([
      expect.objectContaining({ value: repositoryPath, state: 'owned', origin: globalConfig }),
    ]);
  });

  it('keeps an owned value for an active worktree, then removes it after out-of-band deletion', async () => {
    const baseRepo = path.join(tmpRoot, 'repo');
    const worktreePath = path.join(baseRepo, '.cindy-worktrees', 'feature');
    const unrelatedPath = path.join(tmpRoot, 'user-owned-repo');
    fs.mkdirSync(worktreePath, { recursive: true });
    activeWorktrees = [makeMeta(baseRepo, worktreePath)];
    entries.push({ filePath: globalConfig, value: unrelatedPath });

    await ensureSafeDirectory(worktreePath);
    await reconcileSafeDirectories();

    expect(entries).toEqual([
      { filePath: globalConfig, value: unrelatedPath },
      { filePath: globalConfig, value: worktreePath },
    ]);
    expect(ledger.grants).toEqual([
      expect.objectContaining({ value: worktreePath, state: 'owned', origin: globalConfig }),
    ]);

    // 模拟用户绕过 Cindy，在终端直接删除目录，但 worktree store 仍残留旧记录。
    fs.rmSync(worktreePath, { recursive: true, force: true });
    await reconcileSafeDirectories();

    expect(entries).toEqual([{ filePath: globalConfig, value: unrelatedPath }]);
    expect(ledger.grants).toEqual([]);
    const unsetCall = executeConfig.mock.calls.find(([args]) => args.includes('--unset'))?.[0];
    expect(unsetCall).toEqual([
      'config',
      '--file',
      expect.stringMatching(
        new RegExp(
          `^${fs.realpathSync(globalConfig).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.lock\\.cindy-`,
        ),
      ),
      '--fixed-value',
      '--unset',
      'safe.directory',
      worktreePath,
    ]);
    expect(executeConfig.mock.calls.some(([args]) => args.includes('--unset-all'))).toBe(false);
  });

  it('keeps an owned value while an ordinary task works inside the repository', async () => {
    const repositoryPath = path.join(tmpRoot, 'ordinary-repo');
    const workingDir = path.join(repositoryPath, 'packages', 'desktop');
    fs.mkdirSync(workingDir, { recursive: true });
    liveSessionPathKeys = new Set([workingDir]);

    await ensureSafeDirectory(repositoryPath);
    await reconcileSafeDirectories();

    expect(entries).toEqual([{ filePath: globalConfig, value: repositoryPath }]);
    expect(ledger.grants).toEqual([
      expect.objectContaining({ value: repositoryPath, state: 'owned', origin: globalConfig }),
    ]);

    liveSessionPathKeys = new Set();
    await reconcileSafeDirectories();

    expect(entries).toEqual([]);
    expect(ledger.grants).toEqual([]);
  });

  it('ignores an archived session path after its worktree is definitively gone', async () => {
    const repositoryPath = path.join(tmpRoot, 'archived-repo');
    fs.mkdirSync(repositoryPath, { recursive: true });
    liveSessionPathKeys = new Set([path.join(repositoryPath, '.cindy-worktrees', 'archived')]);

    await ensureSafeDirectory(repositoryPath);
    await reconcileSafeDirectories();

    expect(entries).toEqual([]);
    expect(ledger.grants).toEqual([]);
  });

  it('preserves owned values when live session references cannot be loaded', async () => {
    const repositoryPath = path.join(tmpRoot, 'ordinary-repo');
    fs.mkdirSync(repositoryPath, { recursive: true });
    liveSessionPathKeys = null;

    await ensureSafeDirectory(repositoryPath);
    await reconcileSafeDirectories();

    expect(entries).toEqual([{ filePath: globalConfig, value: repositoryPath }]);
    expect(ledger.grants).toEqual([
      expect.objectContaining({ value: repositoryPath, state: 'owned', origin: globalConfig }),
    ]);
    expect(executeConfig.mock.calls.some(([args]) => args.includes('--unset'))).toBe(false);
  });

  it('preserves duplicate exact values because ownership is ambiguous', async () => {
    const repositoryPath = path.join(tmpRoot, 'repo');
    await ensureSafeDirectory(repositoryPath);
    entries.push({ filePath: globalConfig, value: repositoryPath });
    persistEntries(true);

    await reconcileSafeDirectories();

    expect(entries).toHaveLength(2);
    expect(ledger.grants).toEqual([
      expect.objectContaining({ value: repositoryPath, state: 'owned' }),
    ]);
    expect(executeConfig.mock.calls.some(([args]) => args.includes('--unset'))).toBe(false);
  });

  it('does not delete a same-value entry recreated by the user', async () => {
    const repositoryPath = path.join(tmpRoot, 'repo');
    await ensureSafeDirectory(repositoryPath);

    // 最终 value + origin 与 Cindy 写入时完全相同，但配置文件已被外部删除并重建。
    entries = [];
    persistEntries(true);
    entries = [{ filePath: globalConfig, value: repositoryPath }];
    persistEntries(true);

    await reconcileSafeDirectories();

    expect(entries).toEqual([{ filePath: globalConfig, value: repositoryPath }]);
    expect(ledger.grants).toEqual([
      expect.objectContaining({ value: repositoryPath, state: 'owned' }),
    ]);
    expect(executeConfig.mock.calls.some(([args]) => args.includes('--unset'))).toBe(false);
  });

  it('does not claim a same-value entry recreated after the atomic add', async () => {
    const repositoryPath = path.join(tmpRoot, 'repo');
    recreateAfterNextAdd = true;

    await ensureSafeDirectory(repositoryPath);
    await reconcileSafeDirectories();

    expect(entries).toEqual([{ filePath: globalConfig, value: repositoryPath }]);
    expect(ledger.grants).toEqual([
      expect.objectContaining({ value: repositoryPath, state: 'pending' }),
    ]);
    expect(executeConfig.mock.calls.some(([args]) => args.includes('--unset'))).toBe(false);
  });

  it('rechecks the witness after acquiring the Git config lock', async () => {
    const repositoryPath = path.join(tmpRoot, 'repo');
    await ensureSafeDirectory(repositoryPath);
    const open = fs.promises.open.bind(fs.promises);
    const openSpy = vi.spyOn(fs.promises, 'open').mockImplementationOnce(async (...args) => {
      // 模拟外部工具在锁取得前删除并重建同值配置；锁内见证必须让删除失效。
      entries = [];
      persistEntries(true);
      entries = [{ filePath: globalConfig, value: repositoryPath }];
      persistEntries(true);
      return open(...args);
    });

    try {
      await reconcileSafeDirectories();
    } finally {
      openSpy.mockRestore();
    }
    expect(entries).toEqual([{ filePath: globalConfig, value: repositoryPath }]);
    expect(ledger.grants).toEqual([
      expect.objectContaining({ value: repositoryPath, state: 'owned' }),
    ]);
    expect(executeConfig.mock.calls.some(([args]) => args.includes('--unset'))).toBe(false);
  });

  it('keeps all same-value claims when owned and pending records overlap', async () => {
    const repositoryPath = path.join(tmpRoot, 'repo');
    await ensureSafeDirectory(repositoryPath);
    const owned = ledger.grants[0] as Record<string, unknown>;
    ledger.grants.push({
      ...owned,
      id: 'pending-overlap',
      state: 'pending',
      origin: undefined,
      originWitness: undefined,
    });

    await reconcileSafeDirectories();

    expect(entries).toEqual([{ filePath: globalConfig, value: repositoryPath }]);
    expect(ledger.grants).toHaveLength(2);
    expect(executeConfig.mock.calls.some(([args]) => args.includes('--unset'))).toBe(false);
  });

  it('refreshes witnesses across multiple Cindy additions and removals in one config file', async () => {
    const firstPath = path.join(tmpRoot, 'first');
    const secondPath = path.join(tmpRoot, 'second');

    await ensureSafeDirectory(firstPath);
    await ensureSafeDirectory(secondPath);
    await reconcileSafeDirectories();

    expect(entries).toEqual([]);
    expect(ledger.grants).toEqual([]);
    expect(executeConfig.mock.calls.filter(([args]) => args.includes('--unset'))).toHaveLength(2);
  });

  it('refreshes owned witnesses after another known Cindy global config write', async () => {
    const repositoryPath = path.join(tmpRoot, 'repo');
    await ensureSafeDirectory(repositoryPath);

    await withSafeDirectoryWitnessRefresh(async () => {
      // `git config --global core.longpaths true` rewrites the same file without
      // changing the effective safe.directory entries.
      persistEntries(true);
    });
    await reconcileSafeDirectories();

    expect(entries).toEqual([]);
    expect(ledger.grants).toEqual([]);
    expect(executeConfig.mock.calls.filter(([args]) => args.includes('--unset'))).toHaveLength(1);
  });

  it('never deletes a grant made ambiguous by a concurrent duplicate, but compacts A after B is gone', async () => {
    const repositoryPath = path.join(tmpRoot, 'repo');
    duplicateOnAdd = true;

    await ensureSafeDirectory(repositoryPath);
    await reconcileSafeDirectories();

    expect(entries).toHaveLength(2);
    expect(ledger.grants).toEqual([
      expect.objectContaining({ value: repositoryPath, state: 'ambiguous' }),
    ]);
    expect(executeConfig.mock.calls.some(([args]) => args.includes('--unset'))).toBe(false);

    entries = [];
    await reconcileSafeDirectories();
    expect(ledger.grants).toEqual([]);
  });

  it('treats an in-flight creation claim as C until worktree metadata can be persisted', async () => {
    const worktreePath = path.join(tmpRoot, 'repo', '.cindy-worktrees', 'creating');
    await withSafeDirectoryRetention({ subtreePaths: [worktreePath] }, async () => {
      await ensureSafeDirectory(worktreePath);
      await reconcileSafeDirectories();
      expect(entries).toEqual([{ filePath: globalConfig, value: worktreePath }]);
    });
    await reconcileSafeDirectories();
    expect(entries).toEqual([]);
  });

  it('keeps a shared global grant while another profile still publishes a dependency', async () => {
    const repositoryPath = path.join(tmpRoot, 'repo');
    const nestedWorkingDirectory = path.join(repositoryPath, 'packages', 'desktop');
    fs.mkdirSync(nestedWorkingDirectory, { recursive: true });
    await ensureSafeDirectory(repositoryPath);

    currentProfilePath = path.join(tmpRoot, 'profile-b');
    currentProcessId = 202;
    processLiveness.set(202, 'alive');
    liveSessionPathKeys = new Set();
    await retainSafeDirectoryUsage(nestedWorkingDirectory);
    await retainSafeDirectoryUsage(path.join(tmpRoot, 'other-repo'));

    currentProfilePath = path.join(tmpRoot, 'profile-a');
    currentProcessId = 101;
    liveSessionPathKeys = new Set();
    await reconcileSafeDirectories();
    expect(entries).toEqual([{ filePath: globalConfig, value: repositoryPath }]);

    currentProfilePath = path.join(tmpRoot, 'profile-b');
    currentProcessId = 202;
    liveSessionPathKeys = new Set();
    await reconcileSafeDirectories();
    expect(entries).toEqual([]);
  });

  it('drops another profile snapshot only after its process is definitively missing', async () => {
    const repositoryPath = path.join(tmpRoot, 'stale-profile-repo');
    fs.mkdirSync(repositoryPath, { recursive: true });
    await ensureSafeDirectory(repositoryPath);

    currentProfilePath = path.join(tmpRoot, 'profile-b');
    currentProcessId = 202;
    processLiveness.set(202, 'alive');
    await retainSafeDirectoryUsage(repositoryPath);

    currentProfilePath = path.join(tmpRoot, 'profile-a');
    currentProcessId = 101;
    liveSessionPathKeys = new Set();
    await reconcileSafeDirectories();
    expect(entries).toEqual([{ filePath: globalConfig, value: repositoryPath }]);

    processLiveness.set(202, 'unknown');
    await reconcileSafeDirectories();
    expect(entries).toEqual([{ filePath: globalConfig, value: repositoryPath }]);

    processLiveness.set(202, 'missing');
    await reconcileSafeDirectories();

    expect(entries).toEqual([]);
    expect(ledger.profileRetentions).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ profilePath: path.join(tmpRoot, 'profile-b'), processId: 202 }),
      ]),
    );
  });

  it('keeps slow reconciliation inspection outside the mutation lock', async () => {
    const repositoryPath = path.join(tmpRoot, 'slow-inspection-repo');
    await ensureSafeDirectory(repositoryPath);

    let mutationLockHeld = false;
    const mutationWaits: number[] = [];
    _setSafeDirectoryCrossProcessLockRunnerForTests(async (lockPath, options, task) => {
      if (!lockPath.endsWith('.mutation.lock')) return task({ held: true });
      mutationWaits.push(options.waitMs ?? 0);
      mutationLockHeld = true;
      try {
        return await task({ held: true });
      } finally {
        mutationLockHeld = false;
      }
    });

    const originalExecuteConfig = executeConfig.getMockImplementation()!;
    const slowInspectionLockStates: boolean[] = [];
    executeConfig.mockImplementation(async (args: readonly string[]) => {
      if (args.includes('--show-origin') || args.includes('--get-all')) {
        slowInspectionLockStates.push(mutationLockHeld);
      }
      return originalExecuteConfig(args);
    });

    await reconcileSafeDirectories();

    expect(slowInspectionLockStates).not.toHaveLength(0);
    expect(slowInspectionLockStates.every((held) => !held)).toBe(true);
    expect(mutationWaits.every((waitMs) => waitMs > 10_000)).toBe(true);
    expect(entries).toEqual([]);
  });

  it('keeps the final retention proof outside the mutation lock', async () => {
    const repositoryPath = path.join(tmpRoot, 'final-proof-repo');
    let mutationLockHeld = false;
    _setSafeDirectoryCrossProcessLockRunnerForTests(async (lockPath, _options, task) => {
      if (!lockPath.endsWith('.mutation.lock')) return task({ held: true });
      mutationLockHeld = true;
      try {
        return await task({ held: true });
      } finally {
        mutationLockHeld = false;
      }
    });

    const lookupLockStates: boolean[] = [];
    _setLiveSessionPathKeysProviderForTests(async () => {
      lookupLockStates.push(mutationLockHeld);
      return new Set();
    });
    await ensureSafeDirectory(repositoryPath);
    lookupLockStates.length = 0;

    await reconcileSafeDirectories();

    expect(lookupLockStates.length).toBeGreaterThan(0);
    expect(lookupLockStates.every((held) => !held)).toBe(true);
    expect(entries).toEqual([]);
  });

  it('abandons removal when the profile retention revision changes during the final proof', async () => {
    const repositoryPath = path.join(tmpRoot, 'retention-revision-repo');
    let lookupCount = 0;
    _setLiveSessionPathKeysProviderForTests(async () => {
      lookupCount += 1;
      if (lookupCount === 3) {
        const originalRecords = structuredClone(ledger.profileRetentions);
        ledger.profileRetentions.push({
          profilePath: path.join(tmpRoot, 'profile-b'),
          processId: 202,
          roots: [{ path: repositoryPath, mode: 'exact' }],
          liveSessionPaths: [],
        });
        ledger.profileRetentionRevision += 1;
        ledger.profileRetentions = originalRecords;
        ledger.profileRetentionRevision += 1;
      }
      return new Set();
    });
    await ensureSafeDirectory(repositoryPath);
    lookupCount = 0;

    await reconcileSafeDirectories();

    expect(lookupCount).toBeGreaterThanOrEqual(3);
    expect(entries).toEqual([{ filePath: globalConfig, value: repositoryPath }]);
    expect(ledger.grants).toEqual([
      expect.objectContaining({ value: repositoryPath, state: 'owned' }),
    ]);
  });

  it('does not keep lock-free inspection in the local mutation queue', async () => {
    const repositoryPath = path.join(tmpRoot, 'hot-path-repo');
    await ensureSafeDirectory(repositoryPath);

    let signalInspectionStarted!: () => void;
    let releaseInspection!: () => void;
    const inspectionStarted = new Promise<void>((resolve) => {
      signalInspectionStarted = resolve;
    });
    const inspectionRelease = new Promise<void>((resolve) => {
      releaseInspection = resolve;
    });
    const originalExecuteConfig = executeConfig.getMockImplementation()!;
    let pauseInspection = true;
    executeConfig.mockImplementation(async (args: readonly string[]) => {
      const result = await originalExecuteConfig(args);
      if (pauseInspection && args.includes('--show-origin')) {
        pauseInspection = false;
        signalInspectionStarted();
        await inspectionRelease;
      }
      return result;
    });

    const reconciliation = reconcileSafeDirectories();
    await inspectionStarted;

    let signalTaskStarted!: () => void;
    let releaseTask!: () => void;
    const taskStarted = new Promise<void>((resolve) => {
      signalTaskStarted = resolve;
    });
    const taskRelease = new Promise<void>((resolve) => {
      releaseTask = resolve;
    });
    const retention = withSafeDirectoryRetention({ exactPaths: [repositoryPath] }, async () => {
      signalTaskStarted();
      await taskRelease;
    });

    let startTimeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        taskStarted,
        new Promise<never>((_, reject) => {
          startTimeout = setTimeout(
            () => reject(new Error('retention publication was blocked by lock-free inspection')),
            1_000,
          );
        }),
      ]);
      releaseInspection();
      await reconciliation;
      expect(entries).toEqual([{ filePath: globalConfig, value: repositoryPath }]);
    } finally {
      if (startTimeout) clearTimeout(startTimeout);
      releaseInspection();
      releaseTask();
      await Promise.allSettled([reconciliation, retention]);
    }

    await reconcileSafeDirectories();
    expect(entries).toEqual([]);
  });

  it('rechecks a cross-profile claim published during lock-free inspection', async () => {
    const repositoryPath = path.join(tmpRoot, 'late-cross-profile-claim');
    await ensureSafeDirectory(repositoryPath);

    const originalExecuteConfig = executeConfig.getMockImplementation()!;
    let published = false;
    executeConfig.mockImplementation(async (args: readonly string[]) => {
      const result = await originalExecuteConfig(args);
      if (!published && args.includes('--show-origin')) {
        published = true;
        processLiveness.set(202, 'alive');
        ledger.profileRetentions.push({
          profilePath: path.join(tmpRoot, 'profile-b'),
          processId: 202,
          roots: [{ path: repositoryPath, mode: 'exact' }],
          liveSessionPaths: [],
        });
      }
      return result;
    });

    await reconcileSafeDirectories();

    expect(published).toBe(true);
    expect(entries).toEqual([{ filePath: globalConfig, value: repositoryPath }]);
    expect(executeConfig.mock.calls.some(([args]) => args.includes('--unset'))).toBe(false);
  });

  it('holds the mutation lock only while publishing and withdrawing the persistent claim', async () => {
    let mutationLockHeld = false;
    _setSafeDirectoryCrossProcessLockRunnerForTests(async (lockPath, _options, task) => {
      if (!lockPath.endsWith('.mutation.lock')) return task({ held: true });
      mutationLockHeld = true;
      try {
        return await task({ held: true });
      } finally {
        mutationLockHeld = false;
      }
    });

    const dynamicallyAddedPath = path.join(tmpRoot, 'dynamic-worktree');
    await withSafeDirectoryRetention({ exactPaths: [tmpRoot] }, async (retention) => {
      expect(mutationLockHeld).toBe(false);
      await retention.addSubtree(dynamicallyAddedPath);
      expect(mutationLockHeld).toBe(false);
      expect(ledger.profileRetentions).toEqual([
        expect.objectContaining({
          roots: expect.arrayContaining([
            expect.objectContaining({ path: dynamicallyAddedPath, mode: 'subtree' }),
          ]),
        }),
      ]);
    });
  });

  it('keeps creation available when shared retention publication is unavailable', async () => {
    const repositoryPath = path.join(tmpRoot, 'repo');
    const dynamicallyAddedPath = path.join(repositoryPath, '.cindy-worktrees', 'creating');
    _setSafeDirectoryCrossProcessLockRunnerForTests((lockPath, _options, task) =>
      task(lockPath.endsWith('.mutation.lock') ? { held: false, reason: 'busy' } : { held: true }),
    );

    const result = await withSafeDirectoryRetention(
      { exactPaths: [repositoryPath] },
      async (retention) => {
        await retention.addSubtree(dynamicallyAddedPath);
        return 'created';
      },
    );

    expect(result).toBe('created');
    expect(ledger.profileRetentions).toEqual([]);
    expect(entries).toEqual([]);
  });

  it('derives one stable shared state root independently of profile userData', () => {
    const appDataPath = path.join(tmpRoot, 'app-data');
    expect(resolveSafeDirectorySharedStateRoot(appDataPath)).toBe(
      path.join(appDataPath, 'CindyShared'),
    );
  });

  it('does not mutate the ledger or global config without the cross-process mutation lock', async () => {
    const repositoryPath = path.join(tmpRoot, 'repo');
    _setSafeDirectoryCrossProcessLockRunnerForTests((lockPath, _options, task) =>
      task(lockPath.endsWith('.mutation.lock') ? { held: false, reason: 'busy' } : { held: true }),
    );

    await expect(ensureSafeDirectory(repositoryPath)).rejects.toThrow(
      'safe.directory mutation lock busy',
    );
    expect(entries).toEqual([]);
    expect(ledger.grants).toEqual([]);
    expect(executeConfig.mock.calls.some(([args]) => args.includes('--add'))).toBe(false);
  });
});
