import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { WorktreeMeta } from '../worktree/types';

const gitExecMock = vi.fn();
const storeMap = new Map<string, WorktreeMeta>();
const storeSetMock = vi.fn();
const profile = vi.hoisted(() => ({ root: '' }));
const checkoutLease = vi.hoisted(() => ({
  record: vi.fn(),
  release: vi.fn(),
  runtimePaths: new Set<string>(),
  trackActivePaths: false,
}));
vi.mock('electron', () => ({ app: { getPath: () => profile.root } }));
vi.mock('../localDb/client/current', () => ({ getDbClient: () => ({ readLocalWorktreeReferences: async () => [] }) }));
vi.mock('../worktree/piSubagentReferences', () => ({ readPiSubagentWorktreeReferences: async () => new Map() }));
vi.mock('../worktree/runtimeLeases', () => ({
  readWorktreeRuntimePaths: async () => new Set(checkoutLease.runtimePaths),
  acquireWorktreeRuntimeLease: async (_id: string, cwd: string) => {
    if (checkoutLease.trackActivePaths) checkoutLease.runtimePaths.add(cwd);
    return {};
  },
  recordWorktreeRuntimeLeaseChild: checkoutLease.record,
  releaseWorktreeRuntimeLease: (...args: unknown[]) => {
    if (checkoutLease.trackActivePaths) checkoutLease.runtimePaths.clear();
    return checkoutLease.release(...args);
  },
  reclaimOrphanedWorktreeRuntimeLeases: async () => 0,
}));
const includeMock = vi.hoisted(() => vi.fn(async () => []));

vi.mock('../worktree/gitExec', () => ({
  gitExec: (...args: unknown[]) => gitExecMock(...args),
  GitExecError: class GitExecError extends Error {
    readonly cleanupUnconfirmed: boolean;
    constructor(opts?: { cleanupUnconfirmed?: boolean; stderr?: string } | string) {
      super(typeof opts === 'string' ? opts : (opts?.stderr ?? 'git failed'));
      this.cleanupUnconfirmed = typeof opts === 'object' && opts !== null ? Boolean(opts.cleanupUnconfirmed) : false;
    }
  },
  globalSafeDirectoryLockPath: () => path.join(profile.root, 'git-config.lock'),
  safeDirectorySpellings: (value: string) => [value],
}));

vi.mock('../worktree/includePatternsEngine', () => ({
  applyWorktreeIncludeFile: includeMock,
  listChangedWorktreeIncludeFiles: vi.fn(async () => []),
}));

vi.mock('../worktree/worktreeStore', () => ({
  get: (sessionId: string) => storeMap.get(sessionId) ?? null,
  getAll: () => [...storeMap.values()],
  getAllPaths: () => [...storeMap.values()].map((meta) => meta.path),
  set: (...args: unknown[]) => storeSetMock(...args),
  del: (sessionId: string) => storeMap.delete(sessionId),
  addPendingSafeDirectoryCleanups: async () => {},
  removePendingSafeDirectoryCleanups: async () => {},
}));

describe('createWorktree naming authority', () => {
  let manager: typeof import('../worktree/WorktreeManager');
  let tmpRoot: string;
  let baseRepo: string;
  let randomSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-worktree-create-'));
    profile.root = path.join(tmpRoot, 'profile');
    fs.mkdirSync(profile.root);
    baseRepo = path.join(tmpRoot, 'repo');
    fs.mkdirSync(baseRepo, { recursive: true });
    storeMap.clear();
    checkoutLease.runtimePaths.clear();
    checkoutLease.trackActivePaths = false;
    includeMock.mockReset().mockResolvedValue([]);
    storeSetMock.mockReset().mockImplementation(async (sessionId: string, meta: WorktreeMeta) => {
      storeMap.set(sessionId, meta);
    });
    randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    gitExecMock.mockReset().mockImplementation(async (args: string[], cwd?: string) => {
      if (args[0] === 'symbolic-ref') {
        const meta = [...storeMap.values()].find((value) => value.path === cwd);
        return { stdout: `refs/heads/${meta?.branch ?? 'main'}\n`, stderr: '' };
      }
      if (args[0] === '--version') {
        return { stdout: 'git version 2.50.0\n', stderr: '' };
      }
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
        return { stdout: `${baseRepo}\n`, stderr: '' };
      }
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') {
        return { stdout: 'main\n', stderr: '' };
      }
      if (args[0] === 'rev-parse' && args[1] === '--git-path') {
        return { stdout: '.git/info/exclude\n', stderr: '' };
      }
      if (args[0] === 'rev-parse' && (args[1] === '--git-dir' || args[1] === '--git-common-dir')) {
        return { stdout: '.git\n', stderr: '' };
      }
      if (args[0] === 'branch' && args[1] === '--format=%(refname:short)') {
        return { stdout: 'main\n', stderr: '' };
      }
      if (args[0] === 'branch' && args[1] === '--all') {
        return { stdout: '', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });
    await import('../worktree/WorktreeManagerPorts.desktop');
    manager = await import('../worktree/WorktreeManager');
  });

  afterEach(() => {
    randomSpy.mockRestore();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  async function create(name: string, sessionId = 'session-1') {
    return manager.createWorktree({
      sessionId,
      baseRepo,
      name,
      sourceBranch: 'main',
    });
  }

  // #7259: creation must keep managed checkouts out of the parent's untracked scan.
  // Existing naming tests do not inspect the local exclude file. Two creates with an
  // existing rule and no final newline cover preservation and idempotence (unit tier).
  // Windows 2026-10-26: this file alone took 3.05s wall clock (Vitest 1.43s).
  it('appends the managed directory exclusion once without changing existing rules or .gitignore', async () => {
    const exclude = path.join(baseRepo, '.git', 'info', 'exclude');
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    fs.writeFileSync(exclude, '# user rules\r\nlocal-cache/');
    fs.writeFileSync(path.join(baseRepo, '.gitignore'), 'build/\n');

    await expect(create('first')).resolves.toMatchObject({ ok: true });
    await expect(create('second', 'session-2')).resolves.toMatchObject({ ok: true });

    expect(fs.readFileSync(exclude, 'utf8')).toBe('# user rules\r\nlocal-cache/\r\n/.cindy-worktrees/\r\n');
    expect(fs.readFileSync(path.join(baseRepo, '.gitignore'), 'utf8')).toBe('build/\n');
  });

  // A read/write failure in this optimization must not prevent starting a task.
  it('still creates the worktree when the local exclude cannot be updated', async () => {
    const exclude = path.join(baseRepo, '.git', 'info', 'exclude');
    fs.mkdirSync(exclude, { recursive: true });
    await expect(create('exclude-unavailable')).resolves.toMatchObject({ ok: true });
    expect(fs.statSync(exclude).isDirectory()).toBe(true);
  });

  it('records the background checkout child and holds its lease until completion', async () => {
    const previousGit = gitExecMock.getMockImplementation()!;
    let finishCheckout!: () => void;
    const checkout = new Promise<{ stdout: string; stderr: string }>((resolve) => {
      finishCheckout = () => resolve({ stdout: '', stderr: '' });
    });
    const stagedPids = [4241, 4242, 4243];
    let stagedIndex = 0;
    gitExecMock.mockImplementation((args: string[], cwd?: string, opts?: { onSpawn?: (pid: number) => void }) => {
      if (opts?.onSpawn && (args[0] === 'ls-tree' || args[0] === 'checkout')) {
        opts.onSpawn(stagedPids[stagedIndex++]!);
      }
      if (args[0] === 'ls-tree') return { stdout: 'AGENTS.md\\n', stderr: '' };
      if (args[0] === 'checkout' && args.includes(':(exclude).sivi')) return checkout;
      return previousGit(args, cwd, opts);
    });
    try {
      await expect(create('background')).resolves.toMatchObject({ ok: true });
      expect(checkoutLease.record).toHaveBeenCalledTimes(3);
      expect(checkoutLease.record.mock.calls.map((call) => call[1])).toEqual(stagedPids);
      expect(checkoutLease.release).not.toHaveBeenCalled();
    } finally {
      finishCheckout();
    }
    await vi.waitFor(() => expect(checkoutLease.release).toHaveBeenCalledExactlyOnceWith({}));
  });

  // A caller that hands the directory to a running agent must not get it before the tree is complete.
  it('awaitFullCheckout returns only after the full checkout, and fails with a rollback if it fails', async () => {
    const previousGit = gitExecMock.getMockImplementation()!;
    let enteredCheckout!: () => void;
    const checkoutStarted = new Promise<void>((resolve) => { enteredCheckout = resolve; });
    let finishCheckout!: (fail: boolean) => void;
    const checkout = new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      finishCheckout = (fail) => (fail ? reject(new Error('checkout failed')) : resolve({ stdout: '', stderr: '' }));
    });
    gitExecMock.mockImplementation((args: string[], ...rest: unknown[]) => {
      if (args[0] === 'checkout' && args.includes('.')) {
        enteredCheckout();
        return checkout;
      }
      return previousGit(args, ...rest);
    });
    let settled = false;
    const creating = manager.createWorktree({ sessionId: 'full-checkout', baseRepo, name: 'full', sourceBranch: 'main' }, { awaitFullCheckout: true })
      .finally(() => { settled = true; });
    try {
      // Reaching checkout includes real temporary-directory I/O. Its latency
      // is not the wait/rollback contract; synchronize on the actual Git edge.
      await checkoutStarted;
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(settled).toBe(false);
    } finally {
      // Do not leak the writer into the next test if an assertion fails.
      finishCheckout(true);
      await creating;
    }
    await expect(creating).resolves.toMatchObject({ ok: false });
    expect(gitExecMock.mock.calls.some(([args]) => args[0] === 'worktree' && args[1] === 'remove')).toBe(true);
  });

  // Worker failure compensation must wait for checkout; successful creation must not.
  // Existing lease tests do not exercise the new opt-in wait handle (unit tier, fake I/O).
  it.each([false, true])('tracks checkout without delaying success; setup failure=%s waits before rollback', async (failSetup) => {
    const previousGit = gitExecMock.getMockImplementation()!;
    let finishCheckout!: () => void;
    const checkout = new Promise<{stdout: string; stderr: string}>(resolve => {
      finishCheckout = () => resolve({stdout: '', stderr: ''});
    });
    let reachedSetup!: () => void;
    const setup = new Promise<void>(resolve => { reachedSetup = resolve; });
    gitExecMock.mockImplementation((args: string[], ...rest: unknown[]) => {
      if (args[0] === 'checkout' && args.includes(':(exclude).sivi')) return checkout;
      return previousGit(args, ...rest);
    });
    // #11157 removes the hooks write; keep exercising failure compensation at
    // the remaining fatal metadata-persistence boundary (unit tier).
    const previousSet = storeSetMock.getMockImplementation()!;
    storeSetMock.mockImplementation((...args: unknown[]) => {
      reachedSetup();
      if (failSetup) return Promise.reject(new Error('metadata failed'));
      return previousSet(...args);
    });
    const sessionId = `tracked-${failSetup}`;
    const creating = manager.createWorktree({sessionId, baseRepo, name: 'tracked', sourceBranch: 'main'}, {trackBackgroundCheckout: true});
    await setup;
    let waited = false;
    const waiting = manager.awaitBackgroundCheckout(sessionId).then(() => { waited = true; });
    try {
      if (!failSetup) await expect(creating).resolves.toMatchObject({ok: true});
      await Promise.resolve();
      expect(waited).toBe(false);
      expect(gitExecMock.mock.calls.some(([args]) => args[0] === 'worktree' && args[1] === 'remove')).toBe(false);
    } finally {
      finishCheckout();
      await waiting;
    }
    await expect(creating).resolves.toMatchObject({ok: !failSetup});
    expect(checkoutLease.release).toHaveBeenCalledOnce();
    expect(gitExecMock.mock.calls.some(([args]) => args[0] === 'worktree' && args[1] === 'remove')).toBe(failSetup);
    await manager.awaitBackgroundCheckout(sessionId);
  });

  it('waits for checkout before rolling back an unpublished registry rejection', async () => {
    const previousGit = gitExecMock.getMockImplementation()!;
    let finishCheckout!: () => void;
    const checkout = new Promise<{ stdout: string; stderr: string }>((resolve) => {
      finishCheckout = () => resolve({ stdout: '', stderr: '' });
    });
    gitExecMock.mockImplementation((args: string[], ...rest: unknown[]) => {
      if (args[0] === 'checkout' && args.includes(':(exclude).sivi')) return checkout;
      return previousGit(args, ...rest);
    });
    let reachedPersist!: () => void;
    const persist = new Promise<void>((resolve) => { reachedPersist = resolve; });
    storeSetMock.mockImplementation(async (...args: unknown[]) => {
      reachedPersist();
      // The real store invokes this under its registry lock.
      await (args[2] as (() => Promise<void>) | undefined)?.();
    });
    let guardCalls = 0;
    let settled = false;
    const creating = manager.createWorktree({
      sessionId: 'locked-rejection', baseRepo, name: 'guarded', sourceBranch: 'main',
    }, {
      assertWriteAllowed: () => {
        guardCalls++;
        if (guardCalls === 3) throw new Error('profile held');
      },
    }).finally(() => { settled = true; });
    await persist;
    try {
      expect(settled).toBe(false);
      expect(storeMap.has('locked-rejection')).toBe(false);
    } finally {
      finishCheckout();
    }
    await expect(creating).resolves.toMatchObject({ ok: false });
    expect(storeMap.has('locked-rejection')).toBe(false);
    expect(gitExecMock.mock.calls.some(([args]) => args[0] === 'worktree' && args[1] === 'remove')).toBe(true);
  });

  it.each(['', '   \t'])('generates a meaningful final name for blank input %j', async (name) => {
    const result = await create(name);

    expect(result).toMatchObject({
      ok: true,
      meta: {
        name: 'pensive-lederberg',
        path: path.join(baseRepo, '.cindy-worktrees', 'pensive-lederberg'),
        branch: 'cindy/pensive-lederberg',
      },
    });
  });

  it('preserves an explicit legal auto-* name', async () => {
    const result = await create('auto-abc123');

    expect(result).toMatchObject({
      ok: true,
      meta: {
        name: 'auto-abc123',
        path: path.join(baseRepo, '.cindy-worktrees', 'auto-abc123'),
        branch: 'cindy/auto-abc123',
      },
    });
    expect(storeMap.get('session-1')).toEqual(result.ok ? result.meta : undefined);
  });

  it('preserves an explicit legal name and still rejects an explicit illegal name', async () => {
    await expect(create('fix-login')).resolves.toMatchObject({
      ok: true,
      meta: {
        name: 'fix-login',
        path: path.join(baseRepo, '.cindy-worktrees', 'fix-login'),
        branch: 'cindy/fix-login',
      },
    });

    gitExecMock.mockClear();
    await expect(create('Bad Name', 'session-2')).resolves.toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('worktree 名称非法') },
    });
    expect(gitExecMock).not.toHaveBeenCalled();
  });

  it('generates against getTakenNames and avoids a meaningful-name collision', async () => {
    const takenName = 'pensive-lederberg';
    storeMap.set('existing-session', {
      sessionId: 'existing-session',
      name: takenName,
      path: path.join(baseRepo, '.cindy-worktrees', takenName),
      baseRepo,
      branch: `cindy/${takenName}`,
      sourceBranch: 'main',
      createdAt: '2026-08-09T00:00:00.000Z',
    });

    const result = await create('');

    expect(result).toMatchObject({
      ok: true,
      meta: {
        name: 'pensive-lederberg-2',
        path: path.join(baseRepo, '.cindy-worktrees', 'pensive-lederberg-2'),
        branch: 'cindy/pensive-lederberg-2',
      },
    });
  });

  it.each(['setup', 'metadata'])('serializes cancellation from a separate manager while creation awaits %s', async (stage) => {
    // Independent module instances model separate process-local queues. The
    // profile lock and cancellation marker are real shared filesystem state.
    const creator = manager;
    vi.resetModules();
    await import('../worktree/WorktreeManagerPorts.desktop');
    const canceller = await import('../worktree/WorktreeManager');
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const pause = new Promise<void>((resolve) => { release = resolve; });
    if (stage === 'setup') {
      includeMock.mockImplementationOnce(async () => { entered(); await pause; return []; });
    } else {
      storeSetMock.mockImplementationOnce(async (id: string, meta: WorktreeMeta) => {
        entered(); await pause; storeMap.set(id, meta);
      });
    }
    const request = { sessionId: 'cross-process', baseRepo, name: 'race', sourceBranch: 'main', recoveryKey: 'cross-process-recovery' };
    const creating = creator.createWorktree(request);
    await ready;
    let cancellation: ReturnType<typeof manager.cancelPrecreatedWorktree> | undefined;
    try {
      cancellation = canceller.cancelPrecreatedWorktree(request.sessionId,
        { recoveryKey: request.recoveryKey }, { canRemove: async () => true });
      expect(await Promise.race([
        cancellation.then(() => 'cancelled'),
        new Promise<string>((resolve) => setTimeout(() => resolve('waiting'), 100)),
      ])).toBe('waiting');
      await expect(canceller.createWorktree({ ...request, sessionId: 'other-task', name: 'other' }))
        .resolves.toMatchObject({ ok: true });
    } finally {
      release();
      await creating;
      await cancellation;
    }
    expect(await creating).toMatchObject({ ok: true });
    expect(await cancellation).toMatchObject({ status: 'discarded' });
    expect(storeMap.has(request.sessionId)).toBe(false);
    expect(storeMap.has('other-task')).toBe(true);
    await expect(creator.createWorktree(request)).rejects.toThrow('PRECONDITION_FAILED');
  });

  it('rechecks a cancellation published during setup before registering metadata', async () => {
    const { sealPrecreatedSessionCancellation } = await import('../worktree/precreatedCancellation');
    const previousGit = gitExecMock.getMockImplementation()!;
    let finishCheckout!: () => void;
    const checkout = new Promise<{ stdout: string; stderr: string }>((resolve) => {
      finishCheckout = () => resolve({ stdout: '', stderr: '' });
    });
    gitExecMock.mockImplementation((args: string[], ...rest: unknown[]) =>
      args[0] === 'checkout' && args.includes(':(exclude).sivi') ? checkout : previousGit(args, ...rest));
    let marked!: () => void;
    const markReady = new Promise<void>((resolve) => { marked = resolve; });
    includeMock.mockImplementationOnce(async () => {
      // A peer on an older version may not participate in the new lock yet.
      sealPrecreatedSessionCancellation('cancel-during-setup');
      marked();
      return [];
    });
    const creating = create('cancelled', 'cancel-during-setup');
    await markReady;
    try {
      expect(await Promise.race([
        creating.then(() => 'completed'),
        new Promise<string>((resolve) => setTimeout(() => resolve('waiting'), 100)),
      ])).toBe('waiting');
      expect(gitExecMock).not.toHaveBeenCalledWith(['worktree', 'remove', path.join(baseRepo, '.cindy-worktrees', 'cancelled')], baseRepo);
    } finally {
      finishCheckout();
      await creating;
    }
    expect(await creating).toMatchObject({ ok: false });
    expect(storeSetMock).not.toHaveBeenCalled();
    expect(storeMap.has('cancel-during-setup')).toBe(false);
    expect(gitExecMock).toHaveBeenCalledWith(['worktree', 'remove', path.join(baseRepo, '.cindy-worktrees', 'cancelled')], baseRepo);
  });

  // Multibox backend (worktree/multibox.ts). Rule: use `git multibox add` only when the repo
  // has .multibox.toml AND the command is installed; it must not carry --no-checkout (multibox
  // then silently degrades to a plain worktree without caches) and must not be followed by the
  // deferred checkout. Existing tests only cover the native path. Unit tier, Git faked.
  describe('multibox backend', () => {
    const isMultiboxAdd = (args: string[]) => args.includes('multibox') && args.includes('add');
    const isWorktreeAdd = (args: string[]) => args[0] === '-c' && args[2] === 'worktree' && args[3] === 'add';

    function useMultiboxRepo({ config = true, installed = true, addError }: { config?: boolean; installed?: boolean; addError?: string } = {}) {
      if (config) fs.writeFileSync(path.join(baseRepo, '.multibox.toml'), '[carry]\n');
      const previousGit = gitExecMock.getMockImplementation()!;
      gitExecMock.mockImplementation(async (args: string[], ...rest: unknown[]) => {
        if (args[0] === 'multibox' && args[1] === '--version') {
          if (!installed) throw new Error("git: 'multibox' is not a git command");
          return { stdout: 'git-multibox 0.1.3\n', stderr: '' };
        }
        if (isMultiboxAdd(args)) {
          if (addError) throw new Error(addError);
          return { stdout: '{"method":"reflink","seconds":1.5,"environment":{"UNITY_PROJECT_PATH":"x"},"warnings":[]}\n', stderr: '' };
        }
        return previousGit(args, ...rest);
      });
    }

    it.each([
      { config: true, installed: true, expected: 'multibox' },
      { config: true, installed: false, expected: 'worktree' },
      { config: false, installed: true, expected: 'worktree' },
    ])('config=$config installed=$installed creates with git $expected', async ({ config, installed, expected }) => {
      useMultiboxRepo({ config, installed });

      await expect(create('mb')).resolves.toMatchObject({ ok: true, meta: { branch: 'cindy/mb' } });

      const calls = gitExecMock.mock.calls.map(([args]) => args as string[]);
      const worktreePath = path.join(baseRepo, '.cindy-worktrees', 'mb');
      if (expected === 'multibox') {
        expect(calls.filter(isMultiboxAdd)).toEqual([[
          '-c', 'core.longpaths=true', 'multibox', 'add', '--json', '--no-track', '-b', 'cindy/mb', worktreePath, 'main',
        ]]);
        expect(calls.some(isWorktreeAdd)).toBe(false);
        // Multibox returns a complete tree: no staged or background checkout afterwards.
        expect(calls.some((args) => args[0] === 'checkout')).toBe(false);
        expect(includeMock).toHaveBeenCalledWith(baseRepo, worktreePath, { overwriteExisting: false });
      } else {
        expect(calls.some(isMultiboxAdd)).toBe(false);
        expect(calls.filter(isWorktreeAdd)[0]).toContain('--no-checkout');
        // Ordinary repositories (no config file) pay no extra Git process for the probe.
        if (!config) expect(calls.some((args) => args[0] === 'multibox')).toBe(false);
      }
    });

    // Choose by "enabled", not by "failed": a -b retry through plain git would hit the
    // branch multibox may already have created and hide the real error from the user.
    it('returns the multibox error as-is without retrying through git worktree add', async () => {
      useMultiboxRepo({ addError: 'is on another volume' });

      await expect(create('mb-fail')).resolves.toMatchObject({
        ok: false,
        error: { kind: 'unknown', rawStderr: expect.stringContaining('is on another volume') },
      });
      const calls = gitExecMock.mock.calls.map(([args]) => args as string[]);
      expect(calls.some(isWorktreeAdd)).toBe(false);
      expect(storeSetMock).not.toHaveBeenCalled();
    });

    // Compensation after a later setup failure must keep the dirty check (no -f) and wait
    // for the deletion (--wait). The carried engine caches came from the base checkout in
    // this same create, so they must not block it (the native rollback would preserve a
    // worktree whose ignored file differs from base) nor be compared byte by byte.
    it('rolls back a failed setup with multibox remove --wait, without force, despite carried caches', async () => {
      useMultiboxRepo();
      storeSetMock.mockRejectedValueOnce(new Error('metadata failed'));
      const previousGit = gitExecMock.getMockImplementation()!;
      gitExecMock.mockImplementation(async (args: string[], ...rest: unknown[]) => {
        if (args[0] === 'ls-files' && args.includes('--ignored')) {
          return { stdout: 'client/Library/ArtifactDB\0', stderr: '' };
        }
        return previousGit(args, ...rest);
      });

      await expect(create('mb-rollback')).resolves.toMatchObject({ ok: false });
      expect(gitExecMock).toHaveBeenCalledWith(
        ['-c', 'core.longpaths=true', 'multibox', 'remove', '--wait', path.join(baseRepo, '.cindy-worktrees', 'mb-rollback')],
        baseRepo,
      );
    });
  });

  // Regression: an abandoned remote precreated worktree whose staged background checkout is
  // still running previously self-blocked its own discard because its own `checkout:` lease
  // triggered live-session preservation and its partial checkout looked dirty to plain `git status`.
  // Unit tier, fake Git I/O.
  it('discardPrecreatedWorktreeByRecoveryKey aborts an in-flight staged checkout only when unclaimed and removes the incomplete worktree', async () => {
    checkoutLease.trackActivePaths = true;
    const { GitExecError } = await import('../worktree/gitExec');
    const previousGit = gitExecMock.getMockImplementation()!;
    let capturedSignal: AbortSignal | undefined;
    gitExecMock.mockImplementation((args: string[], cwd?: string, opts?: { signal?: AbortSignal }) => {
      if (args[0] === 'checkout' && args.includes(':(exclude).sivi')) {
        capturedSignal = opts?.signal;
        return new Promise((_resolve, reject) => {
          opts?.signal?.addEventListener('abort', () => {
            reject(new GitExecError({ stderr: 'cancelled; process tree terminated', cleanupUnconfirmed: false } as unknown as ConstructorParameters<typeof GitExecError>[0]));
          }, { once: true });
        });
      }
      if (args[0] === 'status' && args[1] === '--porcelain') {
        // Real partial --no-checkout state appears dirty to plain `git status --porcelain`.
        return Promise.resolve({ stdout: 'D  README.md\n', stderr: '' });
      }
      if (args[0] === 'status' && args[1] === '--porcelain=v1') {
        // Temp HEAD index shows only working-tree-missing tracked files.
        return Promise.resolve({ stdout: ' D README.md\0', stderr: '' });
      }
      if (args[0] === 'rev-parse' && args[1] === '--verify') {
        return Promise.resolve({ stdout: 'abc123\n', stderr: '' });
      }
      if (args[0] === 'rev-list') {
        return Promise.resolve({ stdout: '0\n', stderr: '' });
      }
      return previousGit(args, cwd, opts);
    });

    const recoveryKey = 'bg-discard-recovery-key';
    const created = await manager.createWorktree({
      sessionId: 'bg-session',
      baseRepo,
      name: 'bg-stuck',
      sourceBranch: 'main',
      recoveryKey,
    });
    expect(created).toMatchObject({ ok: true, meta: { backgroundCheckoutPending: true } });
    expect(capturedSignal?.aborted).toBe(false);
    expect(checkoutLease.runtimePaths.size).toBe(1);

    // If a session already claimed the worktree, discard must NOT abort its background checkout.
    await expect(
      manager.discardPrecreatedWorktreeByRecoveryKey('bg-session', recoveryKey, {
        canRemove: async () => false,
      }),
    ).resolves.toEqual({ status: 'preserved' });
    expect(capturedSignal?.aborted).toBe(false);
    expect(checkoutLease.release).not.toHaveBeenCalled();

    // Unclaimed discard aborts the background checkout, releases its lease, and removes the directory.
    await expect(
      manager.discardPrecreatedWorktreeByRecoveryKey('bg-session', recoveryKey, {
        canRemove: async () => true,
      }),
    ).resolves.toEqual({ status: 'discarded', branchDeleted: true });
    expect(capturedSignal?.aborted).toBe(true);
    expect(checkoutLease.release).toHaveBeenCalledTimes(1);
    expect(storeMap.has('bg-session')).toBe(false);
    expect(gitExecMock).toHaveBeenCalledWith(
      ['worktree', 'remove', '--force', path.join(baseRepo, '.cindy-worktrees', 'bg-stuck')],
      baseRepo,
    );
  });

  it('keeps the checkout lease protective and preserves the worktree when abort cleanup is unconfirmed', async () => {
    checkoutLease.trackActivePaths = true;
    const { GitExecError } = await import('../worktree/gitExec');
    const previousGit = gitExecMock.getMockImplementation()!;
    gitExecMock.mockImplementation((args: string[], cwd?: string, opts?: { signal?: AbortSignal }) => {
      if (args[0] === 'checkout' && args.includes(':(exclude).sivi')) {
        return new Promise((_resolve, reject) => {
          opts?.signal?.addEventListener('abort', () => {
            reject(new GitExecError({ stderr: 'cancelled; process tree cleanup unconfirmed', cleanupUnconfirmed: true } as unknown as ConstructorParameters<typeof GitExecError>[0]));
          }, { once: true });
        });
      }
      return previousGit(args, cwd, opts);
    });

    const recoveryKey = 'bg-unconfirmed-recovery';
    await expect(manager.createWorktree({
      sessionId: 'bg-unconfirmed',
      baseRepo,
      name: 'bg-unconfirmed',
      sourceBranch: 'main',
      recoveryKey,
    })).resolves.toMatchObject({ ok: true });

    await expect(
      manager.discardPrecreatedWorktreeByRecoveryKey('bg-unconfirmed', recoveryKey, {
        canRemove: async () => true,
      }),
    ).resolves.toEqual({ status: 'preserved' });
    expect(checkoutLease.release).not.toHaveBeenCalled();
    expect(storeMap.has('bg-unconfirmed')).toBe(true);
    expect(gitExecMock).not.toHaveBeenCalledWith(
      expect.arrayContaining(['worktree', 'remove']),
      baseRepo,
    );
  });
});
