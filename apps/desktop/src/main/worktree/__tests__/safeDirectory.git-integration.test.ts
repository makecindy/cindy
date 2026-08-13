import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { WorktreeMeta } from '../types';
import { gitExec } from '../gitExec';
import {
  _resetSafeDirectoryStateForTests,
  _setActiveWorktreesProviderForTests,
  _setSafeDirectoryCrossProcessLockRunnerForTests,
  _setLiveSessionPathKeysProviderForTests,
  _setSafeDirectoryLedgerStoreForTests,
  _setSafeDirectoryProfilePathProviderForTests,
  reconcileSafeDirectories,
  withSafeDirectoryWitnessRefresh,
} from '../safeDirectory';

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

function invokeGit(
  args: readonly string[],
  cwd?: string,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [...args],
      { cwd, encoding: 'utf8', env: process.env },
      (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(error, { stdout, stderr }));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
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

describe('safe.directory real Git lifecycle', () => {
  const environmentKeys = [
    'HOME',
    'XDG_CONFIG_HOME',
    'GIT_CONFIG_NOSYSTEM',
    'GIT_TEST_ASSUME_DIFFERENT_OWNER',
    'LC_ALL',
  ] as const;
  let previousEnvironment: Partial<Record<(typeof environmentKeys)[number], string>>;
  let tmpRoot: string;
  let globalConfig: string;
  let activeWorktrees: WorktreeMeta[];
  let liveSessionPathKeys: Set<string> | null;
  let ledger: MemoryLedgerStore;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-safe-directory-git-'));
    activeWorktrees = [];
    liveSessionPathKeys = new Set();
    ledger = new MemoryLedgerStore(path.join(tmpRoot, 'ledger.json'));
    previousEnvironment = {};
    for (const key of environmentKeys) {
      if (process.env[key] !== undefined) previousEnvironment[key] = process.env[key];
    }

    process.env.HOME = path.join(tmpRoot, 'home');
    process.env.XDG_CONFIG_HOME = path.join(tmpRoot, 'xdg');
    globalConfig = path.join(process.env.HOME, '.gitconfig');
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    delete process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER;
    process.env.LC_ALL = 'C';
    fs.mkdirSync(process.env.HOME, { recursive: true });
    fs.mkdirSync(process.env.XDG_CONFIG_HOME, { recursive: true });

    _setSafeDirectoryLedgerStoreForTests(ledger);
    _setActiveWorktreesProviderForTests(() => activeWorktrees);
    _setLiveSessionPathKeysProviderForTests(async () => liveSessionPathKeys);
    _setSafeDirectoryProfilePathProviderForTests(() => path.join(tmpRoot, 'profile'));
    _setSafeDirectoryCrossProcessLockRunnerForTests((_lockPath, _options, task) =>
      task({ held: true }),
    );
  });

  afterEach(() => {
    _resetSafeDirectoryStateForTests();
    for (const key of environmentKeys) {
      const previous = previousEnvironment[key];
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  async function createRepository(name: string): Promise<string> {
    const baseRepo = path.join(tmpRoot, `base-${name}`);
    fs.mkdirSync(baseRepo, { recursive: true });
    await invokeGit(['init', '--initial-branch=main'], baseRepo);
    fs.writeFileSync(path.join(baseRepo, 'README.md'), 'test\n');
    await invokeGit(['add', 'README.md'], baseRepo);
    await invokeGit(
      [
        '-c',
        'user.name=Cindy Test',
        '-c',
        'user.email=cindy@example.invalid',
        'commit',
        '--no-gpg-sign',
        '-m',
        'initial',
      ],
      baseRepo,
    );
    return baseRepo;
  }

  async function createLinkedWorktree(name: string): Promise<{
    baseRepo: string;
    worktreePath: string;
    trustedPath: string;
  }> {
    const baseRepo = await createRepository(name);
    const worktreePath = path.join(baseRepo, '.cindy-worktrees', name);
    await invokeGit(['worktree', 'add', '-b', 'feature', worktreePath], baseRepo);
    return { baseRepo, worktreePath, trustedPath: fs.realpathSync(worktreePath) };
  }

  it('adds only after a real dubious error, keeps while active, and cleans after manual deletion', async () => {
    const { baseRepo, worktreePath, trustedPath } =
      await createLinkedWorktree("worktree with 'quote'");
    activeWorktrees = [makeMeta(baseRepo, worktreePath)];
    process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER = '1';

    await expect(invokeGit(['status', '--short'], worktreePath)).rejects.toMatchObject({
      stderr: expect.stringContaining('dubious ownership'),
    });

    await expect(gitExec(['status', '--short'], worktreePath)).resolves.toMatchObject({
      stdout: '',
    });
    await expect(
      invokeGit(['config', '--global', '--get-all', 'safe.directory']),
    ).resolves.toMatchObject({ stdout: `${trustedPath}\n` });
    expect(ledger.grants).toEqual([
      expect.objectContaining({ value: trustedPath, state: 'owned', origin: globalConfig }),
    ]);

    await reconcileSafeDirectories();
    await expect(
      invokeGit(['config', '--global', '--get-all', 'safe.directory']),
    ).resolves.toMatchObject({ stdout: `${trustedPath}\n` });

    // 模拟会话先归档、用户随后在终端自行删除 worktree；store 中仍留有历史记录。
    fs.rmSync(worktreePath, { recursive: true, force: true });
    await reconcileSafeDirectories();

    await expect(
      invokeGit(['config', '--global', '--get-all', 'safe.directory']),
    ).rejects.toMatchObject({ code: 1 });
    expect(ledger.grants).toEqual([]);
  });

  it('keeps a real Git grant while an ordinary task works inside the repository', async () => {
    const repositoryPath = await createRepository('ordinary-task');
    const trustedPath = fs.realpathSync(repositoryPath);
    const workingDir = path.join(repositoryPath, 'packages', 'desktop');
    fs.mkdirSync(workingDir, { recursive: true });
    liveSessionPathKeys = new Set([workingDir]);
    process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER = '1';

    await expect(gitExec(['status', '--short'], repositoryPath)).resolves.toMatchObject({
      stdout: '',
    });
    await reconcileSafeDirectories();
    await expect(
      invokeGit(['config', '--global', '--get-all', 'safe.directory']),
    ).resolves.toMatchObject({ stdout: `${trustedPath}\n` });

    liveSessionPathKeys = new Set();
    await reconcileSafeDirectories();

    await expect(
      invokeGit(['config', '--global', '--get-all', 'safe.directory']),
    ).rejects.toMatchObject({ code: 1 });
    expect(ledger.grants).toEqual([]);
  });

  it('owns and cleans a grant when the global config is a symbolic link', async () => {
    const dotfilesDir = path.join(tmpRoot, 'dotfiles');
    const configTarget = path.join(dotfilesDir, 'gitconfig');
    fs.mkdirSync(dotfilesDir, { recursive: true });
    fs.writeFileSync(configTarget, '[user]\n\tname = Existing User\n');
    const resolvedConfigTarget = fs.realpathSync(configTarget);
    fs.symlinkSync(configTarget, globalConfig);
    const repositoryPath = await createRepository('symlinked-global-config');
    const trustedPath = fs.realpathSync(repositoryPath);
    process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER = '1';

    await expect(gitExec(['status', '--short'], repositoryPath)).resolves.toMatchObject({
      stdout: '',
    });
    expect(fs.lstatSync(globalConfig).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(globalConfig)).toBe(resolvedConfigTarget);
    expect(ledger.grants).toEqual([
      expect.objectContaining({
        value: trustedPath,
        state: 'owned',
        origin: globalConfig,
        originWitness: expect.objectContaining({
          realPath: resolvedConfigTarget,
          symbolicLink: expect.objectContaining({ target: configTarget }),
        }),
      }),
    ]);

    await reconcileSafeDirectories();

    await expect(
      invokeGit(['config', '--global', '--get-all', 'safe.directory']),
    ).rejects.toMatchObject({ code: 1 });
    expect(fs.lstatSync(globalConfig).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(configTarget, 'utf8')).toContain('Existing User');
    expect(ledger.grants).toEqual([]);
  });

  it('preserves a same-value entry after the global config link is switched externally', async () => {
    const dotfilesDir = path.join(tmpRoot, 'dotfiles-switch');
    const originalTarget = path.join(dotfilesDir, 'original.gitconfig');
    const replacementTarget = path.join(dotfilesDir, 'replacement.gitconfig');
    fs.mkdirSync(dotfilesDir, { recursive: true });
    fs.writeFileSync(originalTarget, '');
    fs.symlinkSync(originalTarget, globalConfig);
    const repositoryPath = await createRepository('switched-global-config-link');
    const trustedPath = fs.realpathSync(repositoryPath);
    process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER = '1';

    await gitExec(['status', '--short'], repositoryPath);
    await invokeGit([
      'config',
      '--file',
      replacementTarget,
      '--add',
      'safe.directory',
      trustedPath,
    ]);
    fs.renameSync(globalConfig, `${globalConfig}.cindy-original-link`);
    fs.symlinkSync(replacementTarget, globalConfig);

    await reconcileSafeDirectories();

    await expect(
      invokeGit(['config', '--global', '--get-all', 'safe.directory']),
    ).resolves.toMatchObject({ stdout: `${trustedPath}\n` });
    expect(ledger.grants).toEqual([
      expect.objectContaining({ value: trustedPath, state: 'owned', origin: globalConfig }),
    ]);
  });

  it('recovers a real dubious-ownership path containing a newline', async () => {
    const repositoryPath = await createRepository('line\nbreak');
    const trustedPath = fs.realpathSync(repositoryPath);
    process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER = '1';

    await expect(gitExec(['status', '--short'], repositoryPath)).resolves.toMatchObject({
      stdout: '',
    });
    await expect(
      invokeGit(['config', '--global', '--null', '--get-all', 'safe.directory']),
    ).resolves.toMatchObject({ stdout: `${trustedPath}\0` });

    await reconcileSafeDirectories();
    await expect(
      invokeGit(['config', '--global', '--get-all', 'safe.directory']),
    ).rejects.toMatchObject({ code: 1 });
  });

  it('cleans an owned grant after another known Cindy global config write', async () => {
    const repositoryPath = await createRepository('global-config-write');
    process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER = '1';

    await gitExec(['status', '--short'], repositoryPath);
    await withSafeDirectoryWitnessRefresh(() =>
      invokeGit(['config', '--global', 'core.longpaths', 'true']),
    );
    await reconcileSafeDirectories();

    await expect(
      invokeGit(['config', '--global', '--get-all', 'safe.directory']),
    ).rejects.toMatchObject({ code: 1 });
    expect(ledger.grants).toEqual([]);
  });

  it('preserves a same-value global entry recreated outside Cindy', async () => {
    const { worktreePath, trustedPath } = await createLinkedWorktree('user-recreated');
    process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER = '1';

    await gitExec(['status', '--short'], worktreePath);
    await invokeGit([
      'config',
      '--global',
      '--fixed-value',
      '--unset',
      'safe.directory',
      trustedPath,
    ]);
    await invokeGit(['config', '--global', '--add', 'safe.directory', trustedPath]);

    await reconcileSafeDirectories();

    await expect(
      invokeGit(['config', '--global', '--get-all', 'safe.directory']),
    ).resolves.toMatchObject({ stdout: `${trustedPath}\n` });
    expect(ledger.grants).toEqual([
      expect.objectContaining({ value: trustedPath, state: 'owned' }),
    ]);
  });

  it('uses command-scoped trust when an earlier exact value was invalidated by an empty reset', async () => {
    const { worktreePath, trustedPath } = await createLinkedWorktree('after-reset');
    process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER = '1';
    await invokeGit(['config', '--global', '--add', 'safe.directory', trustedPath]);
    await invokeGit(['config', '--global', '--add', 'safe.directory', '']);

    await expect(invokeGit(['status', '--short'], worktreePath)).rejects.toMatchObject({
      stderr: expect.stringContaining('dubious ownership'),
    });
    await expect(gitExec(['status', '--short'], worktreePath)).resolves.toMatchObject({
      stdout: '',
    });

    await expect(
      invokeGit(['config', '--global', '--null', '--get-all', 'safe.directory']),
    ).resolves.toMatchObject({ stdout: `${trustedPath}\0\0` });
    expect(ledger.grants).toEqual([]);
  });
});
