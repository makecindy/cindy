import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createShadowSavepoint } from '../git-snapshot/gitSnapshotService';
import { currentOperationBudget, OperationBudget } from '../utils/operationBudget';

const mocks = vi.hoisted(() => ({
  git: vi.fn<(args: readonly string[], cwd?: string, opts?: { deadlineAtMs?: number }) => Promise<{ stdout: string; stderr: string }>>(),
  plan: vi.fn(),
}));
vi.mock('../logger', () => ({ createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }) }));
vi.mock('../worktree/gitExec', () => ({ gitExec: mocks.git, GitExecError: class extends Error {} }));
vi.mock('../git-snapshot/isolatedGitExec', () => ({ isolatedGitExec: vi.fn(), snapshotGitIsolationArgs: vi.fn() }));
vi.mock('../git-snapshot/snapshotFileFilter', async (original) => ({
  ...await original<typeof import('../git-snapshot/snapshotFileFilter')>(),
  buildSnapshotFilePlan: mocks.plan,
}));

const markers = ['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'];
const reasons = ['merge', 'rebase', 'rebase', 'cherry-pick', 'revert'];
const repo = path.resolve('fake-snapshot-repo');
const planReached = new Error('stop before any index or worktree mutation');
let gitDir: string;
let present: Set<string>;
let readPaths: string[];
const output = (args: readonly string[]) => ({
  stdout: args.filter((_, i) => args[i - 1] === '--git-path').map(marker => `${gitDir}/${marker}\n`).join(''),
  stderr: '',
});
const capture = () => createShadowSavepoint(repo, {
  sessionId: 's1', label: 'baseline', meta: { kind: 'turn-start' },
  captureBudget: { maxFiles: 10, maxTotalBytes: 100, timeoutMs: 5_000 },
});

beforeEach(() => {
  vi.resetAllMocks();
  gitDir = '.git';
  present = new Set();
  readPaths = [];
  mocks.git.mockImplementation(async (args) => output(args));
  mocks.plan.mockRejectedValue(planReached);
  vi.spyOn(fs, 'lstat').mockImplementation(async (file) => {
    readPaths.push(String(file));
    if (present.has(String(file))) return {} as never;
    throw Object.assign(new Error('absent'), { code: 'ENOENT' });
  });
});
afterEach(() => vi.restoreAllMocks());

describe('snapshot blocked-state preflight', () => {
  it('resolves all five marker paths with one Git child before the file plan', async () => {
    await expect(capture()).rejects.toBe(planReached);
    expect(mocks.git).toHaveBeenCalledTimes(1);
    expect(readPaths).toEqual(markers.map(marker => path.resolve(repo, '.git', marker)));
    expect(mocks.plan).toHaveBeenCalledOnce();
  });

  it.each(markers.map((marker, i) => [marker, reasons[i]]))('blocks %s before status or staging', async (marker, reason) => {
    const markerPath = path.resolve(repo, '.git', marker);
    present.add(markerPath);
    await expect(capture()).rejects.toMatchObject({ state: { reason, marker, markerPath } });
    expect(mocks.plan).not.toHaveBeenCalled();
    expect(mocks.git).toHaveBeenCalledTimes(1);
  });

  it('retains the first blocked marker and does not probe later files', async () => {
    for (const marker of markers) present.add(path.resolve(repo, '.git', marker));
    await expect(capture()).rejects.toMatchObject({ state: { reason: 'merge', marker: 'MERGE_HEAD' } });
    expect(readPaths).toEqual([path.resolve(repo, '.git', 'MERGE_HEAD')]);
    expect(mocks.plan).not.toHaveBeenCalled();
  });

  it.each([' leading 空格 & apostrophe\'s ', path.resolve('linked 空格', '.git', 'worktrees', ' other ')])(
    'preserves the Git-supplied special-character directory %s', async (directory) => {
      gitDir = directory;
      present.add(path.resolve(repo, gitDir, 'REVERT_HEAD'));
      await expect(capture()).rejects.toMatchObject({ state: { marker: 'REVERT_HEAD', markerPath: path.resolve(repo, gitDir, 'REVERT_HEAD') } });
      expect(mocks.git).toHaveBeenCalledTimes(1);
    },
  );

  it.runIf(process.platform === 'win32')('accepts CRLF record separators without trimming paths', async () => {
    gitDir = ' trailing space ';
    mocks.git.mockImplementation(async (args) => ({ ...output(args), stdout: output(args).stdout.replaceAll('\n', '\r\n') }));
    await expect(capture()).rejects.toBe(planReached);
    expect(mocks.git).toHaveBeenCalledTimes(1);
    expect(readPaths).toEqual(markers.map(marker => path.resolve(repo, gitDir, marker)));
  });

  it.each(['line\nnext', 'carriage\rreturn'])('preserves control characters in a single Git path: %j', async (directory) => {
    gitDir = directory;
    const markerPath = path.resolve(repo, gitDir, 'REVERT_HEAD');
    present.add(markerPath);
    await expect(capture()).rejects.toMatchObject({ state: { marker: 'REVERT_HEAD', markerPath } });
    expect(readPaths).toEqual(markers.map(marker => path.resolve(repo, gitDir, marker)));
    const deadlines = mocks.git.mock.calls.map(([, , opts]) => opts?.deadlineAtMs);
    expect(new Set(deadlines).size).toBe(1);
  });

  it.each(['partial', 'wrong-marker', 'missing-terminator'])(
    'falls back on %s batch output without accepting partial paths or renewing its deadline', async (shape) => {
      mocks.git.mockImplementation(async (args) => {
        if (args.length <= 3) return output(args);
        const stdout = output(args).stdout;
        return { stdout: shape === 'partial' ? '.git/MERGE_HEAD\n'
          : shape === 'wrong-marker' ? stdout.replace('/MERGE_HEAD', '/wrongMERGE_HEAD')
            : stdout.slice(0, -1), stderr: '' };
      });
      present.add(path.resolve(repo, '.git', 'REVERT_HEAD'));
      await expect(capture()).rejects.toMatchObject({ state: { marker: 'REVERT_HEAD' } });
      expect(mocks.git).toHaveBeenCalledTimes(6);
      const deadlines = mocks.git.mock.calls.map(([, , opts]) => opts?.deadlineAtMs);
      expect(deadlines.every(deadline => typeof deadline === 'number')).toBe(true);
      expect(new Set(deadlines).size).toBe(1);
      expect(mocks.plan).not.toHaveBeenCalled();
    },
  );

  it.each([{ exitCode: 128 }, { timedOut: true }, { cleanupUnconfirmed: true }])(
    'propagates Git failure without fallback or filesystem probes: %j', async (fields) => {
      const error = Object.assign(new Error('Git failed'), fields);
      mocks.git.mockRejectedValue(error);
      await expect(capture()).rejects.toBe(error);
      expect(mocks.git).toHaveBeenCalledTimes(1);
      expect(readPaths).toEqual([]);
      expect(mocks.plan).not.toHaveBeenCalled();
    },
  );

  it('keeps a cancelled Git child owned until cleanup and ignores its late paths', async () => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    mocks.git.mockImplementation((args) => {
      const child = gate.then(() => output(args));
      entered();
      return currentOperationBudget()!.track(child);
    });
    const budget = new OperationBudget(1_000);
    const reason = new Error('cancel snapshot');
    let finished = false;
    const result = budget.run(capture).catch(error => error).finally(() => { finished = true; });
    await started;
    budget.cancel(reason);
    await Promise.resolve();
    expect(finished).toBe(false);
    release();
    expect(await result).toBe(reason);
    expect(mocks.git).toHaveBeenCalledTimes(1);
    expect(readPaths).toEqual([]);
    expect(mocks.plan).not.toHaveBeenCalled();
  });

  it('does not start fallback or the file plan after the shared capture deadline expires', async () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(100);
    mocks.git.mockImplementation(async () => {
      clock.mockReturnValue(5_101);
      return { stdout: 'ambiguous\n', stderr: '' };
    });
    await expect(capture()).rejects.toMatchObject({ name: 'SnapshotCaptureBudgetExceededError', reason: 'deadline' });
    expect(mocks.git).toHaveBeenCalledTimes(1);
    expect(readPaths).toEqual([]);
    expect(mocks.plan).not.toHaveBeenCalled();
  });

  it.each(['cancel', 'deadline'])('rejects %s during marker lstat before reporting a blocked state', async (mode) => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(100);
    const budget = new OperationBudget(10_000);
    const reason = new Error('stop during lstat');
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(fs.lstat).mockImplementation(async () => {
      entered();
      await gate;
      return {} as never;
    });
    const result = budget.run(capture).catch(error => error);
    await started;
    if (mode === 'cancel') budget.cancel(reason);
    else clock.mockReturnValue(5_101);
    release();
    const error = await result;
    if (mode === 'cancel') expect(error).toBe(reason);
    else expect(error).toMatchObject({ name: 'SnapshotCaptureBudgetExceededError', reason: 'deadline' });
    expect(fs.lstat).toHaveBeenCalledTimes(1);
    expect(mocks.git).toHaveBeenCalledTimes(1);
    expect(mocks.plan).not.toHaveBeenCalled();
  });
});
