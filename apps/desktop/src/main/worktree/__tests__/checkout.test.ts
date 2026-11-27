/** Test value: large repositories must not fail branch status reads on a 5s timeout or stream
 * tens of thousands of dirty files on every read.
 * Existing checkout.git-integration.test.ts runs small real-Git repos only and never exercises
 * scan timeout propagation, bounded fingerprint fallback, or concurrent status coalescing.
 * Minimal inputs: mocked gitExec with real disposable files in os.tmpdir().
 * Tier: unit (no Git subprocesses or Electron); measured standalone: 65ms; imports createCheckoutService once.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createCheckoutService } from '../checkout';
import { GitExecError } from '../gitExec';

const mocks = vi.hoisted(() => ({
  gitExec: vi.fn(),
  fetchCheckoutSource: vi.fn(),
  withBranchMutation: vi.fn(async (_repo: string, fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../gitExec', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../gitExec')>();
  return {
    ...actual,
    gitExec: mocks.gitExec,
  };
});

vi.mock('../branchSync', () => ({
  fetchCheckoutSource: mocks.fetchCheckoutSource,
  withBranchMutation: mocks.withBranchMutation,
}));

let root: string;
let seq = 0;

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-checkout-unit-')));
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeRepoDir() {
  const repo = path.join(root, `repo-${++seq}`);
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  return repo;
}

function stubBasicGit(
  repo: string,
  overrides: {
    porcelain?: string;
    onCall?: (args: readonly string[], opts?: { timeoutMs?: number }) => { stdout: string } | Promise<{ stdout: string }> | undefined;
  } = {},
) {
  const gitDir = path.join(repo, '.git');
  mocks.gitExec.mockImplementation(async (args: readonly string[], _cwd?: string, opts?: { timeoutMs?: number }) => {
    const custom = overrides.onCall?.(args, opts);
    if (custom !== undefined) return custom;
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return { stdout: `${repo}\n`, stderr: '' };
    if (args[0] === 'rev-parse' && args[2] === '--git-common-dir') return { stdout: `${gitDir}\n`, stderr: '' };
    if (args[0] === 'rev-parse' && args[1] === '--absolute-git-dir') return { stdout: `${gitDir}\n`, stderr: '' };
    if (args[0] === 'rev-parse' && args[1] === '--verify') return { stdout: 'deadbeef\n', stderr: '' };
    if (args[0] === 'check-ref-format') return { stdout: '', stderr: '' };
    if (args[0] === 'symbolic-ref') return { stdout: 'main\n', stderr: '' };
    if (args[0] === 'worktree' && args[1] === 'list')
      return { stdout: `worktree ${repo}\0HEAD deadbeef\0branch refs/heads/main\0\0`, stderr: '' };
    if (args[0] === 'status') return { stdout: overrides.porcelain ?? '', stderr: '' };
    if (args[0] === 'diff' && args[1] === '--cached') return { stdout: '', stderr: '' };
    if (args[0] === 'diff' && args[1] === '--name-only') return { stdout: '', stderr: '' };
    if (args[0] === '--literal-pathspecs') return { stdout: '', stderr: '' };
    if (args[0] === 'read-tree') return { stdout: '', stderr: '' };
    if (args[0] === 'ls-files') return { stdout: '', stderr: '' };
    if (args[0] === 'stash' && args[1] === 'list') return { stdout: '', stderr: '' };
    if (args[0] === 'stash' && args[1] === 'create') return { stdout: 'abc123\n', stderr: '' };
    if (args[0] === 'switch') return { stdout: '', stderr: '' };
    return { stdout: '', stderr: '' };
  });
}

it('uses wider 25s scan timeout for full-tree scans and no read timeout for stash create', async () => {
  const repo = makeRepoDir();
  fs.writeFileSync(path.join(repo, 'a.txt'), 'hello\n');
  stubBasicGit(repo, {
    porcelain: ' M a.txt\0',
    onCall: (args) => {
      if (args[0] === 'ls-files') return { stdout: 'ignored-dir/\0' };
      return undefined;
    },
  });

  const service = createCheckoutService(async () => []);
  const status = await service.status(repo, 'feature');
  await service.switch(repo, 'feature', status.current, status.fingerprint, 'carry');

  const timeoutFor = (cmd: string, second?: string) =>
    mocks.gitExec.mock.calls.find(
      ([args]) => args[0] === cmd && (second === undefined || args[1] === second),
    )?.[2]?.timeoutMs;

  expect(timeoutFor('status')).toBe(25_000);
  expect(timeoutFor('diff', '--cached')).toBe(25_000);
  expect(timeoutFor('read-tree')).toBe(25_000);
  expect(timeoutFor('ls-files')).toBe(25_000);
  expect(timeoutFor('diff', '--name-only')).toBe(25_000);
  expect(timeoutFor('rev-parse')).toBe(5_000);
  expect(timeoutFor('stash', 'create')).toBeUndefined();
});

it('propagates read-tree and ls-files timeouts instead of masking them as conflict or git error', async () => {
  const repo = makeRepoDir();
  fs.writeFileSync(path.join(repo, 'a.txt'), 'hello\n');
  const service = createCheckoutService(async () => []);

  stubBasicGit(repo, {
    porcelain: ' M a.txt\0',
    onCall: (args) => {
      if (args[0] === 'read-tree') {
        throw new GitExecError({ args, exitCode: null, stdout: '', stderr: '', timedOut: true });
      }
      return undefined;
    },
  });
  await expect(service.status(repo, 'feature')).rejects.toMatchObject({ timedOut: true });

  stubBasicGit(repo, {
    porcelain: '',
    onCall: (args) => {
      if (args[0] === 'ls-files') {
        throw new GitExecError({ args, exitCode: null, stdout: '', stderr: '', timedOut: true });
      }
      return undefined;
    },
  });
  await expect(service.status(repo, 'feature')).rejects.toMatchObject({ timedOut: true });
});

it('falls back from content streaming to lstat metadata when dirty count or byte budget is exceeded', async () => {
  const repo = makeRepoDir();
  const files = ['f1.bin', 'f2.bin', 'f3.bin'];
  for (const name of files) fs.writeFileSync(path.join(repo, name), 'initial-content\n');
  stubBasicGit(repo, { porcelain: files.map((f) => ` M ${f}\0`).join('') });

  const streamSpy = vi.spyOn(fs, 'createReadStream');

  // Within limits: content-hashed, so rewriting identical bytes with a newer mtime preserves fingerprint.
  const exact = createCheckoutService(async () => [], {
    fingerprintContentFileLimit: 3,
    fingerprintContentByteBudget: 1024,
  });
  const s1 = await exact.status(repo);
  expect(streamSpy).toHaveBeenCalledTimes(3);
  const f1Path = path.join(repo, 'f1.bin');
  fs.writeFileSync(f1Path, 'initial-content\n');
  const bumped = new Date(Date.now() + 5_000);
  fs.utimesSync(f1Path, bumped, bumped);
  const s2 = await exact.status(repo);
  expect(s2.fingerprint).toBe(s1.fingerprint);

  // Over file-count limit: skips createReadStream completely and detects edits via lstat metadata.
  streamSpy.mockClear();
  const cappedByCount = createCheckoutService(async () => [], {
    fingerprintContentFileLimit: 2,
    fingerprintContentByteBudget: 1024,
  });
  const m1 = await cappedByCount.status(repo);
  const m2 = await cappedByCount.status(repo);
  expect(streamSpy).not.toHaveBeenCalled();
  expect(m2.fingerprint).toBe(m1.fingerprint);
  fs.writeFileSync(f1Path, 'modified-content-longer\n');
  const m3 = await cappedByCount.status(repo);
  expect(streamSpy).not.toHaveBeenCalled();
  expect(m3.fingerprint).not.toBe(m1.fingerprint);

  // Over byte budget for an oversized file: skips streaming the large file while hashing smaller ones.
  streamSpy.mockClear();
  const cappedByBytes = createCheckoutService(async () => [], {
    fingerprintContentFileLimit: 10,
    fingerprintContentByteBudget: 20,
  });
  await cappedByBytes.status(repo);
  // f1.bin is 24 bytes (> 20 byte budget, skipped); f2.bin is 16 bytes (streamed, leaves 4 bytes); f3.bin is 16 bytes (> 4, skipped).
  expect(streamSpy).toHaveBeenCalledTimes(1);
  expect(streamSpy.mock.calls[0]?.[0]).toBe(path.join(repo, 'f2.bin'));
  expect(streamSpy.mock.calls[0]?.[1]).toEqual({ start: 0, end: 20 });
});

it('caps actual bytes read and falls back to fresh lstat when a file grows between lstat and streaming', async () => {
  const repo = makeRepoDir();
  const growing = path.join(repo, 'growing.log');
  const trailing = path.join(repo, 'small.txt');
  fs.writeFileSync(growing, 'tiny');
  fs.writeFileSync(trailing, 'ok');
  stubBasicGit(repo, { porcelain: ' M growing.log\0 M small.txt\0' });

  const realCreateReadStream = fs.createReadStream.bind(fs);
  let bytesActuallyRead = 0;
  let grewOnce = false;
  const streamSpy = vi.spyOn(fs, 'createReadStream').mockImplementation((filePath, opts) => {
    if (!grewOnce && filePath === growing) {
      grewOnce = true;
      // Simulate a writer expanding the file well past the 20-byte budget after lstat ran.
      fs.writeFileSync(growing, 'x'.repeat(4096));
    }
    const stream = realCreateReadStream(filePath, opts);
    stream.on('data', (chunk) => {
      bytesActuallyRead += Buffer.byteLength(chunk);
    });
    return stream;
  });

  const service = createCheckoutService(async () => [], {
    fingerprintContentFileLimit: 10,
    fingerprintContentByteBudget: 20,
  });
  const s1 = await service.status(repo);
  // Only growing.log was opened, read capped at budget + 1 (21 bytes), and small.txt skipped once budget hit 0.
  expect(streamSpy).toHaveBeenCalledTimes(1);
  expect(streamSpy.mock.calls[0]?.[0]).toBe(growing);
  expect(bytesActuallyRead).toBeLessThanOrEqual(21);

  // Subsequent status hashes the now-4096-byte growing.log via lstat metadata (matching s1) and detects further growth.
  streamSpy.mockClear();
  const s2 = await service.status(repo);
  expect(streamSpy).toHaveBeenCalledTimes(1);
  expect(streamSpy.mock.calls[0]?.[0]).toBe(trailing);
  fs.appendFileSync(growing, 'more');
  const s3 = await service.status(repo);
  expect(s3.fingerprint).not.toBe(s2.fingerprint);
  expect(s1.fingerprint).not.toBe(s3.fingerprint);
});

it('coalesces concurrent external status scans for the same repo and target without caching settled reads', async () => {
  const repo = makeRepoDir();
  let releaseStatus!: () => void;
  let statusCalls = 0;
  stubBasicGit(repo, {
    onCall: (args) => {
      if (args[0] === 'status') {
        statusCalls++;
        if (statusCalls === 1) {
          return new Promise<{ stdout: string }>((resolve) => {
            releaseStatus = () => resolve({ stdout: '' });
          });
        }
        return { stdout: '' };
      }
      return undefined;
    },
  });

  const service = createCheckoutService(async () => []);
  const first = service.status(repo);
  const second = service.status(repo);
  const targeted = service.status(repo, 'feature');

  // Wait for both rev-parse prefixes to reach status().
  await vi.waitFor(() => expect(statusCalls).toBe(2));
  releaseStatus();
  const [r1, r2, r3] = await Promise.all([first, second, targeted]);
  expect(r1).toEqual(r2);
  expect(r3.current).toBe('main');
  expect(statusCalls).toBe(2);

  // Settled reads are never cached: a subsequent call runs fresh.
  await service.status(repo);
  expect(statusCalls).toBe(3);
});
