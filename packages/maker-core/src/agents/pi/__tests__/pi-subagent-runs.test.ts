import { appendFile, chmod, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  canHostControlPiSubagentRun,
  controlPiSubagentRuns,
  hasActivePiSubagentRunsSync,
  killVerifiedPiSubagentRunner,
  verifyPiSubagentRunnerIdentity,
  listPiSubagentRunDiagnostics,
  listPiSubagentRuns,
  acquirePiSubagentLaunchFence,
  clearStalePiSubagentLaunchFence,
  isPiSubagentLaunchFenceActive,
  piSubagentDeletedTombstonePath,
  writePiSubagentDeletedTombstone,
  clearPiSubagentDeletedTombstone,
  isPiSubagentRunStale,
  piSubagentControlOwnership,
  piSubagentLaunchFencePath,
  piSubagentOwnerHostPid,
  piSubagentOwnerIdentity,
  piSubagentRunRoot,
  piSubagentRuntimeOwnerId,
  requestStopAllPiSubagentRunsSync,
  readPiSubagentTranscriptPage,
  PiSubagentRunnerExitUnconfirmedError,
  recordPiSubagentRunnerFailure,
  resumePiSubagentRun,
  stopAllPiSubagentRunsForExit,
  stopAndRemovePiSubagentRuns,
  stopPiSubagentRunsForAccountBoundary,
  syncPiSubagentPermissions,
  type PiSubagentRunStatus,
} from '../pi-subagent-runs.js';

/**
 * The identity probe and the Windows kill both go through `child_process`, and
 * both have to be observable to test "did we really reclaim it?". Nothing else
 * in this file spawns, so the default implementation just reports an empty
 * command line.
 */
interface SpawnSyncStub {
  status?: number | null;
  stdout?: string;
  error?: Error;
}
const childProcess = vi.hoisted(() => ({
  spawn: vi.fn(),
  spawnSync: vi.fn((..._args: unknown[]) => ({ status: 0, stdout: '' } as {
    status?: number | null;
    stdout?: string;
    error?: Error;
  })),
  /**
   * The reclaim path probes asynchronously so several runners can be confirmed
   * at once. Route it through the same stub the synchronous probe uses, so a
   * case only has to describe the process once — `execFile` is consumed through
   * `promisify`, hence the callback shape.
   */
  /** Delay every async probe by this much; tests raise it to expose ordering. */
  probeDelayMs: 0,
  execFile: Object.assign(
    vi.fn(),
    {
      // `promisify` reads this symbol *once*, when the module under test is
      // imported, and the real `execFile` uses it to resolve `{ stdout, stderr }`
      // rather than a bare string. So the shape has to be right here, and any
      // per-case behaviour has to come from state this closure reads later.
      [Symbol.for('nodejs.util.promisify.custom')]: async (file: string, args: string[]) => {
        if (childProcess.probeDelayMs > 0) {
          await new Promise((resolve) => { setTimeout(resolve, childProcess.probeDelayMs); });
        }
        const result = childProcess.spawnSync(file, args) as {
          status?: number | null;
          stdout?: string;
          error?: Error;
        };
        if (result.error) throw result.error;
        if ((result.status ?? 0) !== 0) throw new Error(`probe exited ${result.status}`);
        return { stdout: result.stdout ?? '', stderr: '' };
      },
    },
  ),
}));
vi.mock('node:child_process', () => childProcess);

/**
 * One-shot `writeFile` failure, for the paths that have to survive a write that
 * fails mid-way (a Windows sharing conflict is the real one). Injected here
 * rather than by removing a directory's write bit, because the rollback under
 * test has to be able to *delete* a file — a read-only directory would block
 * that too, and the test would be measuring the environment.
 */
const fsKnobs = vi.hoisted(() => ({
  failWriteFileOnce: false,
  /** Suspends the next `rm`, so a deletion can be held open across other work. */
  holdRmOnce: null as null | Promise<void>,
  onRmHeld: null as null | (() => void),
  /** Fails the next `remaining` unlinks with `code`, the shape of a file lock. */
  rmFailures: null as null | { remaining: number; code: string },
  rmAttempts: 0,
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const writeFile: typeof actual.writeFile = async (...args) => {
    if (fsKnobs.failWriteFileOnce) {
      fsKnobs.failWriteFileOnce = false;
      throw Object.assign(new Error('EPERM: simulated sharing conflict'), { code: 'EPERM' });
    }
    return actual.writeFile(...args);
  };
  const rm: typeof actual.rm = async (...args) => {
    const gate = fsKnobs.holdRmOnce;
    if (gate) {
      fsKnobs.holdRmOnce = null;
      fsKnobs.onRmHeld?.();
      await gate;
    }
    fsKnobs.rmAttempts += 1;
    const failures = fsKnobs.rmFailures;
    if (failures && failures.remaining > 0) {
      failures.remaining -= 1;
      throw Object.assign(new Error(`${failures.code}: simulated file lock`), {
        code: failures.code,
      });
    }
    return actual.rm(...args);
  };
  return { ...actual, default: { ...actual, writeFile, rm }, writeFile, rm };
});

const roots: string[] = [];
const noopRunnerLaunch = async (): Promise<void> => undefined;

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cindy-pi-subagent-runs-'));
  roots.push(root);
  return root;
}

function status(runId: string, overrides: Partial<PiSubagentRunStatus> = {}): PiSubagentRunStatus {
  return {
    version: 1,
    runId,
    taskId: 'tool-1',
    parentSessionId: 'session-1',
    runtimeOwnerId: 'owner-a',
    runnerInstanceId: 'runner-1',
    runnerPid: process.pid,
    state: 'running',
    startedAt: 10,
    updatedAt: 20,
    tasks: [{
      childId: `${runId}-1`,
      sessionId: `${runId}-1`,
      agent: 'scout',
      status: 'running',
    }],
    ...overrides,
  };
}

async function writeStatus(root: string, value: PiSubagentRunStatus): Promise<void> {
  const dir = path.join(root, value.runId);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'status.json'), `${JSON.stringify(value)}\n`);
}

async function readControls(root: string, runId: string): Promise<Array<Record<string, unknown>>> {
  const dir = path.join(root, runId, 'controls');
  const files = (await readdir(dir)).filter((file) => file.endsWith('.json'));
  return Promise.all(files.map(async (file) => JSON.parse(
    await readFile(path.join(dir, file), 'utf8'),
  ) as Record<string, unknown>));
}

afterEach(async () => {
  // Disarm the fs injections, so an assertion that failed mid-scenario cannot
  // leave the next case holding a suspended unlink.
  fsKnobs.failWriteFileOnce = false;
  fsKnobs.holdRmOnce = null;
  fsKnobs.onRmHeld = null;
  fsKnobs.rmFailures = null;
  fsKnobs.rmAttempts = 0;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('PI durable subagent run store', () => {
  it('records a host-observed runner failure without rewriting completed child results', async () => {
    const root = await makeRoot();
    const runId = '123e4567-e89b-42d3-a456-4266141740ab';
    const runDir = path.join(root, runId);
    const completedChild = `${runId}-1`;
    const runningChild = `${runId}-2`;
    await mkdir(runDir, { recursive: true });
    await writeFile(path.join(runDir, 'config.json'), `${JSON.stringify({
      version: 1,
      runId,
      taskId: 'tool-host-failure',
      parentSessionId: 'session-1',
      runtimeOwnerId: 'owner-a',
      runDir,
      cwd: root,
      binary: '/pi',
      tasks: [
        { childId: completedChild, sessionId: completedChild, agent: 'scout', task: 'a', tools: 'read', profilePrompt: 'a', provider: 'cindy' },
        { childId: runningChild, sessionId: runningChild, agent: 'scout', task: 'b', tools: 'read', profilePrompt: 'b', provider: 'cindy' },
      ],
    })}\n`);
    await writeFile(path.join(runDir, 'status.json'), `${JSON.stringify({
      ...status(runId),
      taskId: 'tool-host-failure',
      tasks: [
        { childId: completedChild, sessionId: completedChild, agent: 'scout', status: 'completed', output: 'done', endedAt: 30 },
        { childId: runningChild, sessionId: runningChild, agent: 'scout', status: 'running' },
      ],
    })}\n`);

    await recordPiSubagentRunnerFailure(runDir, 'host process exited');
    const [recorded] = await listPiSubagentRuns(root);
    expect(recorded?.state).toBe('failed');
    expect(recorded?.tasks[0]).toMatchObject({ status: 'completed', output: 'done', endedAt: 30 });
    expect(recorded?.tasks[1]).toMatchObject({ status: 'failed', error: 'host process exited' });
  });

  it('derives a contained parent-session root and rejects traversal ids', () => {
    expect(piSubagentRunRoot('/agent-home', 'session-1')).toBe(
      path.join('/agent-home', 'runtime', 'pi-subagent-runs', 'session-1'),
    );
    expect(() => piSubagentRunRoot('/agent-home', '../escape')).toThrow(/unsafe/);
    expect(() => piSubagentRunRoot('/agent-home', 'a\\b')).toThrow(/unsafe/);
  });

  it('keeps the deleted-task tombstone outside the run root and rejects traversal ids', async () => {
    expect(piSubagentDeletedTombstonePath('/agent-home', 'session-1')).toBe(
      path.join('/agent-home', 'runtime', 'pi-subagent-deleted', 'session-1'),
    );
    expect(piSubagentDeletedTombstonePath('/agent-home', 'session-1')).not.toContain(
      `${path.sep}pi-subagent-runs${path.sep}`,
    );
    expect(() => piSubagentDeletedTombstonePath('/agent-home', '../escape')).toThrow(/unsafe/);
    const agentHome = await mkdtemp(path.join(os.tmpdir(), 'cindy-pi-tombstone-'));
    roots.push(agentHome);
    await writePiSubagentDeletedTombstone(agentHome, 'session-1');
    expect(existsSync(piSubagentDeletedTombstonePath(agentHome, 'session-1'))).toBe(true);
    await clearPiSubagentDeletedTombstone(agentHome, 'session-1');
    expect(existsSync(piSubagentDeletedTombstonePath(agentHome, 'session-1'))).toBe(false);
    await expect(clearPiSubagentDeletedTombstone(agentHome, 'session-1')).resolves.toBeUndefined();
  });

  it('refuses host resume after a deleted-task tombstone is published', async () => {
    const agentHome = await mkdtemp(path.join(os.tmpdir(), 'cindy-pi-resume-tombstone-'));
    roots.push(agentHome);
    const root = piSubagentRunRoot(agentHome, 'session-1');
    const runId = '123e4567-e89b-42d3-a456-4266141740aa';
    await writeStatus(root, status(runId, { state: 'completed' }));
    await writePiSubagentDeletedTombstone(agentHome, 'session-1');
    await expect(resumePiSubagentRun(root, 'tool-1', 'continue', {
      launchRunner: noopRunnerLaunch,
      env: {},
      runtimeOwnerId: 'owner-a',
      permissionSnapshot: { mode: 'ask', readOnlyRoots: [] },
    })).rejects.toThrow(/parent task was deleted/i);
  });

  it('checks the deleted-task tombstone after publishing queued on host resume', () => {
    const source = readFileSync(new URL('../pi-subagent-runs.ts', import.meta.url), 'utf8')
      .replace(/\r\n/g, '\n');
    const claimed = source.indexOf('async function resumeClaimedPiSubagentRun(');
    const publish = source.indexOf("state: 'queued'", claimed);
    const spawned = source.indexOf('await launch.launchRunner', claimed);
    const firstTombstone = source.indexOf(
      'isPiSubagentDeletedTombstonePresent(agentHome, path.basename(root))',
      claimed,
    );
    const lastTombstone = source.lastIndexOf(
      'isPiSubagentDeletedTombstonePresent(agentHome, path.basename(root))',
      spawned,
    );
    const lastStaging = source.lastIndexOf(
      "await writeAtomicJson(path.join(runDir, 'config.json')",
      spawned,
    );
    expect(publish).toBeGreaterThan(claimed);
    expect(firstTombstone).toBeGreaterThan(publish);
    expect(source.indexOf('recordPiSubagentRunnerFailure(runDir', spawned))
      .toBeGreaterThan(spawned);
    expect(source.indexOf('instanceof PiSubagentRunnerExitUnconfirmedError', spawned))
      .toBeGreaterThan(spawned);
    expect(source.indexOf('instanceof PiSubagentRunnerExitUnconfirmedError', spawned))
      .toBeLessThan(source.indexOf('recordPiSubagentRunnerFailure(runDir', spawned));
    expect(lastStaging).toBeGreaterThan(firstTombstone);
    expect(lastTombstone).toBeGreaterThan(lastStaging);
    expect(spawned).toBeGreaterThan(lastTombstone);
  });

  it('keeps unconfirmed runner-exit errors distinguishable from ordinary launch failures', () => {
    const error = new PiSubagentRunnerExitUnconfirmedError('PI Subagent runner did not become ready');
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(PiSubagentRunnerExitUnconfirmedError);
    expect(error.name).toBe('PiSubagentRunnerExitUnconfirmedError');
  });

  it('reports UUID-contained corrupt runs without trusting disk PIDs', async () => {
    const root = await makeRoot();
    const runId = '123e4567-e89b-42d3-a456-426614174099';
    const dir = path.join(root, runId);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'status.json'), '{not-json');
    await writeFile(path.join(dir, 'config.json'), JSON.stringify({
      taskId: 'opaque-task', parentSessionId: 'session-1', title: 'Recover this task',
      runnerPid: 12345,
    }));

    await expect(listPiSubagentRunDiagnostics(root)).resolves.toEqual([
      expect.objectContaining({
        runId,
        taskId: 'opaque-task',
        parentSessionId: 'session-1',
        title: 'Recover this task',
        message: expect.stringContaining('not resumed or signaled'),
      }),
    ]);
  });

  it('lists only validated UUID-contained status records', async () => {
    const root = await makeRoot();
    const runId = '123e4567-e89b-42d3-a456-426614174000';
    await writeStatus(root, status(runId));
    await mkdir(path.join(root, '..-escape'), { recursive: true });
    await writeFile(path.join(root, '..-escape', 'status.json'), '{}');

    await expect(listPiSubagentRuns(root)).resolves.toEqual([
      expect.objectContaining({ runId, taskId: 'tool-1', state: 'running' }),
    ]);
  });

  it('projects a dead runner with an expired heartbeat as a stale diagnostic', async () => {
    const root = await makeRoot();
    const runId = '123e4567-e89b-42d3-a456-426614174011';
    await writeStatus(root, status(runId, {
      runnerPid: 2_147_483_647,
      startedAt: Date.now() - 60_000,
      updatedAt: Date.now() - 30_000,
    }));

    await expect(listPiSubagentRuns(root)).resolves.toEqual([]);
    await expect(listPiSubagentRunDiagnostics(root)).resolves.toEqual([
      expect.objectContaining({
        kind: 'stale',
        runId,
        taskId: 'tool-1',
        message: expect.stringContaining('stopped unexpectedly'),
      }),
    ]);
    await expect(stopAndRemovePiSubagentRuns(root, 100)).resolves.toBe(true);
  });

  it('treats an abandoned launch-pending status without a runner pid as stale', async () => {
    const root = await makeRoot();
    const runId = '123e4567-e89b-42d3-a456-426614174013';
    await writeStatus(root, status(runId, {
      runnerInstanceId: `launch-pending-${runId}`,
      runnerPid: undefined,
      state: 'queued',
      startedAt: Date.now() - 60_000,
      updatedAt: Date.now() - 30_000,
    }));

    await expect(listPiSubagentRuns(root)).resolves.toEqual([]);
    await expect(listPiSubagentRunDiagnostics(root)).resolves.toEqual([
      expect.objectContaining({ kind: 'stale', runId }),
    ]);
  });

  it('does not treat a live-owner launch-pending record as stale before a runner pid exists', async () => {
    const root = await makeRoot();
    const runId = '123e4567-e89b-42d3-a456-426614174014';
    await writeStatus(root, status(runId, {
      runnerInstanceId: `launch-pending-${runId}`,
      runnerPid: undefined,
      runtimeOwnerId: piSubagentRuntimeOwnerId(process.pid, 'session-1'),
      state: 'queued',
      startedAt: Date.now() - 60_000,
      updatedAt: Date.now() - 30_000,
    }));
    await expect(listPiSubagentRuns(root)).resolves.toEqual([
      expect.objectContaining({ runId, state: 'queued' }),
    ]);
  });

  it('detects and synchronously requests stop for active runners on force exit', async () => {
    const agentHome = await makeRoot();
    const root = piSubagentRunRoot(agentHome, 'session-1');
    const runId = '123e4567-e89b-42d3-a456-426614174005';
    await writeStatus(root, status(runId));

    expect(hasActivePiSubagentRunsSync(agentHome)).toBe(true);
    expect(requestStopAllPiSubagentRunsSync(agentHome)).toBe(1);
    const control = JSON.parse(await readFile(path.join(root, runId, 'control.json'), 'utf8')) as {
      action: string;
    };
    expect(control.action).toBe('stop');
  });

  it('only treats a missing runs directory as idle; other scan failures stay active', () => {
    expect(hasActivePiSubagentRunsSync(path.join(os.tmpdir(), 'cindy-pi-no-such-home'))).toBe(false);
    const source = readFileSync(new URL('../pi-subagent-runs.ts', import.meta.url), 'utf8')
      .replace(/\r\n/g, '\n');
    const fn = source.slice(
      source.indexOf('export function hasActivePiSubagentRunsSync('),
      source.indexOf('export function requestStopAllPiSubagentRunsSync('),
    );
    expect(fn).toContain("code === 'ENOENT') return false");
    expect(fn).toContain('return true;');
    expect(fn).not.toMatch(/readdirSync\(parentRoot[\s\S]*?catch \{ return false; \}/);
  });

  /**
   * An expired heartbeat plus a live pid is not evidence the runner is alive —
   * only that *something* holds that pid. A recycled one makes the record read
   * as running forever, routes controls to a process that never consumes them,
   * and deadlocks the account-boundary sweep: the kill correctly refuses to
   * signal the replacement, so `killedAll` never becomes true.
   */
  describe('stale detection after an expired heartbeat', () => {
    /** Distinct per case: the identity memo is keyed by pid + script. */
    let runnerPid = 910_001;
    const runnerScript = '/runs/cindy-subagent-runner.cjs';
    const restores: Array<() => void> = [];

    beforeEach(() => { runnerPid += 1; });

    /** The identity memo is keyed by pid; a fresh pid is a fresh answer. */
    function runnerIdentityCacheBust(): void {
      runnerPid += 1;
      stubAliveRunner();
    }

    function stubAliveRunner(): void {
      const real = process.kill.bind(process);
      const spy = vi.spyOn(process, 'kill').mockImplementation(
        ((pid: number, signal?: NodeJS.Signals | number) => (
          signal === 0 && pid === runnerPid ? true : real(pid, signal)
        )) as typeof process.kill,
      );
      restores.push(() => spy.mockRestore());
    }

    /** The live process at that pid is (or is not) still the recorded runner. */
    function stubCommandLine(matches: boolean): void {
      childProcess.spawnSync.mockImplementation(() => ({
        status: 0,
        stdout: matches ? `node ${runnerScript} config.json` : 'node /some/other/program.js',
      }));
    }

    const expired = (overrides: Partial<PiSubagentRunStatus> = {}): PiSubagentRunStatus =>
      status('123e4567-e89b-42d3-a456-4266141740b0', {
        runnerPid,
        runnerScript,
        startedAt: Date.now() - 600_000,
        updatedAt: Date.now() - 600_000,
        ...overrides,
      });

    afterEach(() => {
      restores.splice(0).forEach((restore) => restore());
      childProcess.spawnSync.mockReset();
      childProcess.spawnSync.mockImplementation((..._args: unknown[]) => ({ status: 0, stdout: '' }));
    });

    it('treats a recycled runner pid as stale and stops blocking the sweep', async () => {
      stubAliveRunner();
      stubCommandLine(false);
      const root = await makeRoot();
      await writeStatus(root, expired());

      // Hidden from the live list, reported as a diagnostic instead.
      await expect(listPiSubagentRuns(root)).resolves.toEqual([]);
      await expect(listPiSubagentRunDiagnostics(root)).resolves.toEqual([
        expect.objectContaining({ kind: 'stale' }),
      ]);
      // And the boundary completes: a stale run is out of scope for the kill,
      // so it can no longer hold `killedAll` at false forever.
      await expect(stopPiSubagentRunsForAccountBoundary(root, { timeoutMs: 0 }))
        .resolves.toBe(true);
    });

    it('keeps a run active when the pid is still that runner', async () => {
      stubAliveRunner();
      stubCommandLine(true);
      const root = await makeRoot();
      await writeStatus(root, expired());

      await expect(listPiSubagentRuns(root)).resolves.toEqual([
        expect.objectContaining({ state: 'running' }),
      ]);
    });

    it('asks ps for untruncated arguments so utility-process command lines still match', () => {
      stubAliveRunner();
      const seen: string[][] = [];
      childProcess.spawnSync.mockImplementation((file: unknown, args?: unknown) => {
        if (file === 'ps' && Array.isArray(args)) seen.push(args as string[]);
        return { status: 0, stdout: `node ${runnerScript} config.json` };
      });
      expect(verifyPiSubagentRunnerIdentity(expired())).toBe(true);
      if (seen.length > 0) {
        expect(seen[0]).toEqual(expect.arrayContaining(['-ww']));
      }
    });

    it('treats another Subagent utility process at a recycled pid as gone', async () => {
      stubAliveRunner();
      childProcess.spawnSync.mockImplementation(() => ({
        status: 0,
        stdout: '/Applications/Cindy.app/Contents/Frameworks/Cindy Helper.app/Contents/MacOS/Cindy Helper --utility-sub-type=node /app/piSubagentRunnerProcess.js /runs/other-run/runner.cjs',
      }));
      const root = await makeRoot();
      await writeStatus(root, expired());

      await expect(listPiSubagentRuns(root)).resolves.toEqual([]);
      await expect(stopPiSubagentRunsForAccountBoundary(root, { timeoutMs: 0 }))
        .resolves.toBe(true);
    });

    it('still treats another Cindy utility process as a recycled pid', async () => {
      stubAliveRunner();
      childProcess.spawnSync.mockImplementation(() => ({
        status: 0,
        stdout: '/Applications/Cindy.app/Contents/Frameworks/Cindy Helper.app/Contents/MacOS/Cindy Helper --utility-sub-type=node /app/watcherHostProcess.js',
      }));
      const root = await makeRoot();
      await writeStatus(root, expired());

      await expect(listPiSubagentRuns(root)).resolves.toEqual([]);
      await expect(stopPiSubagentRunsForAccountBoundary(root, { timeoutMs: 0 }))
        .resolves.toBe(true);
    });

    it('keeps an unverifiable runner active rather than declaring it stale', async () => {
      // The probe failing is not evidence the runner died. Calling it stale
      // hides a live run from the sweep — which then reports a success it did
      // not achieve — and makes deleting the parent task take the metadata of a
      // run that is still going.
      stubAliveRunner();
      childProcess.spawnSync.mockImplementation(() => ({
        status: null,
        stdout: '',
        error: Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' }),
      }));
      const agentHome = await makeRoot();
      const root = piSubagentRunRoot(agentHome, 'session-1');
      await writeStatus(root, expired());

      await expect(listPiSubagentRuns(root)).resolves.toEqual([
        expect.objectContaining({ state: 'running' }),
      ]);
      // The boundary fails honestly instead of claiming a clean sweep.
      await expect(stopAllPiSubagentRunsForExit(agentHome, 0, { killUnresponsiveRunners: true }))
        .resolves.toBe(false);
      // And deleting the parent task leaves the record alone.
      await expect(stopAndRemovePiSubagentRuns(root, 0)).resolves.toBe(false);
      await expect(readdir(root)).resolves.toContain(
        '123e4567-e89b-42d3-a456-4266141740b0',
      );
    });

    it('answers the same as the reclaim path for the same process', async () => {
      // Two classifiers, one judgement. They are mirrored rather than shared
      // because one has to block; a drift between them would mean the list and
      // the sweep disagree about whether a run exists.
      stubAliveRunner();
      for (const [label, matches] of [['running', true], ['gone', false]] as const) {
        stubCommandLine(matches);
        runnerIdentityCacheBust();
        expect(isPiSubagentRunStale(expired())).toBe(label === 'gone');
        expect(await killVerifiedPiSubagentRunner(expired())).toBe(label === 'gone');
      }
    });

    it('keeps legacy records without a runner script on the pid-only answer', async () => {
      stubAliveRunner();
      stubCommandLine(false);
      const root = await makeRoot();
      await writeStatus(root, expired({ runnerScript: undefined }));

      await expect(listPiSubagentRuns(root)).resolves.toEqual([
        expect.objectContaining({ state: 'running' }),
      ]);
    });

    it('drops a cached identity the moment the runner exits', async () => {
      // The end-to-end guarantee: a run whose runner exits on its own must go
      // stale on the very next read — not when the identity memo expires — so
      // the boundary it was blocking completes. (The immediacy comes from the
      // liveness check that runs ahead of the memo in `isPiSubagentRunStale`;
      // the kill side of the same story is covered by the case below.)
      const real = process.kill.bind(process);
      let alive = true;
      const spy = vi.spyOn(process, 'kill').mockImplementation(
        ((pid: number, signal?: NodeJS.Signals | number) => {
          if (pid !== runnerPid) return real(pid, signal);
          if (signal === 0 && !alive) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
          return true;
        }) as typeof process.kill,
      );
      restores.push(() => spy.mockRestore());
      stubCommandLine(true);
      const agentHome = await makeRoot();
      const root = piSubagentRunRoot(agentHome, 'session-1');
      await writeStatus(root, expired());

      // Alive and verified: cached as "still the runner".
      await expect(listPiSubagentRuns(root)).resolves.toEqual([
        expect.objectContaining({ state: 'running' }),
      ]);
      expect(childProcess.spawnSync).toHaveBeenCalledTimes(1);

      // The runner exits well inside the memo's TTL.
      alive = false;
      await expect(listPiSubagentRuns(root)).resolves.toEqual([]);
      // Still no second probe — liveness alone settled it.
      expect(childProcess.spawnSync).toHaveBeenCalledTimes(1);
      // And the boundary completes instead of blocking on a finished run.
      await expect(stopAllPiSubagentRunsForExit(agentHome, 0, { killUnresponsiveRunners: true }))
        .resolves.toBe(true);
    });

    it('reports a reclaim when the recorded pid now runs something else', async () => {
      // Nothing of ours is left at that pid, and the replacement is not ours to
      // signal — refusing forever would wedge every boundary behind it.
      stubAliveRunner();
      stubCommandLine(false);
      await expect(killVerifiedPiSubagentRunner(expired())).resolves.toBe(true);
    });

    it('never probes while the heartbeat is fresh', async () => {
      stubAliveRunner();
      stubCommandLine(false);
      const root = await makeRoot();
      await writeStatus(root, expired({ updatedAt: Date.now() }));

      await expect(listPiSubagentRuns(root)).resolves.toEqual([
        expect.objectContaining({ state: 'running' }),
      ]);
      // The panel polls this once a second for every run; a probe here would be
      // a `ps`/CIM spawn per run per second.
      expect(childProcess.spawnSync).not.toHaveBeenCalled();
    });
  });

  /**
   * A pid alone cannot say whether the owning *instance* is still running: the
   * OS recycles pids, and a recycled one makes a crashed instance's orphan read
   * as "owned by another live window". The sweep then skips it forever and the
   * user cannot stop it from the UI, while the runner keeps spending the BYOM
   * credentials it inherited. The owner id therefore carries the owner's
   * process start time, and liveness compares it.
   */
  describe('owner instance identity', () => {
    /** A synthetic pid, kept distinct per case so the probe memo cannot bleed. */
    let nextOwnerPid = 900_001;
    const restores: Array<() => void> = [];

    /** Report `pid` as live to signal-0 probes; every other pid keeps the truth. */
    function stubAliveOwner(pid: number): void {
      const real = process.kill.bind(process);
      const spy = vi.spyOn(process, 'kill').mockImplementation(
        ((target: number, signal?: NodeJS.Signals | number) => (
          signal === 0 && target === pid ? true : real(target, signal)
        )) as typeof process.kill,
      );
      restores.push(() => spy.mockRestore());
    }

    /**
     * Make the probe report that the process started at `startTimeSec`, or fail
     * outright when null.
     *
     * Answers in each platform's own dialect, because the probe parses them
     * differently: `ps -o etime=` yields *elapsed* time, the Windows
     * Get-Process StartTime query yields an *absolute* epoch second. A stub
     * that returned one shape for both made this suite pass on POSIX and fail
     * on Windows, where the elapsed seconds were read as an epoch and every
     * comparison mismatched.
     */
    function stubStartProbe(startTimeSec: number | null): void {
      childProcess.spawnSync.mockImplementation((...args: unknown[]) => {
        if (startTimeSec === null) return { status: 1, stdout: '' };
        if (args[0] !== 'ps') return { status: 0, stdout: String(startTimeSec) };
        const elapsed = Math.max(0, Math.round(Date.now() / 1_000) - startTimeSec);
        return {
          status: 0,
          stdout: `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`,
        };
      });
    }

    /** Owner id as a *foreign* instance would have written it. */
    function foreignOwnerId(pid: number, startTimeSec: number): string {
      return `${pid}.${startTimeSec}:scope-foreign`;
    }

    const nowSec = (): number => Math.round(Date.now() / 1_000);
    const run = (runtimeOwnerId: string): PiSubagentRunStatus =>
      status('123e4567-e89b-42d3-a456-426614174090', { runtimeOwnerId });

    afterEach(() => {
      restores.splice(0).forEach((restore) => restore());
      childProcess.spawnSync.mockReset();
      childProcess.spawnSync.mockImplementation((..._args: unknown[]) => ({ status: 0, stdout: '' }));
    });

    it('round-trips the minted id and still parses the legacy two-part form', () => {
      const identity = piSubagentOwnerIdentity(piSubagentRuntimeOwnerId(process.pid, 'scope-mine'));
      expect(identity?.pid).toBe(process.pid);
      expect(identity?.startTimeSec).toBeGreaterThan(0);
      // Within a second or two of what the runtime reports for this process.
      expect(Math.abs((identity?.startTimeSec ?? 0) - (nowSec() - Math.round(process.uptime()))))
        .toBeLessThanOrEqual(2);
      // Ids written before the start time existed keep working.
      expect(piSubagentOwnerIdentity('4242:scope-legacy')).toEqual({ pid: 4242 });
      expect(piSubagentOwnerHostPid('4242:scope-legacy')).toBe(4242);
      expect(piSubagentOwnerHostPid(piSubagentRuntimeOwnerId(process.pid, 'x'))).toBe(process.pid);
      expect(piSubagentOwnerIdentity('not-an-owner')).toBeNull();
    });

    it('keeps the owner id stable when later start-time samples cross a rounding boundary', () => {
      const nowSpy = vi.spyOn(Date, 'now')
        .mockReturnValueOnce(1_700_000_100_499)
        .mockReturnValueOnce(1_700_000_100_501);
      const uptimeSpy = vi.spyOn(process, 'uptime').mockReturnValue(100);
      restores.push(() => nowSpy.mockRestore(), () => uptimeSpy.mockRestore());

      const first = piSubagentRuntimeOwnerId(process.pid, 'scope-stable');
      const second = piSubagentRuntimeOwnerId(process.pid, 'scope-stable');

      expect(second).toBe(first);
    });

    it('treats a recycled pid as a dead owner, so the orphan stays reclaimable', async () => {
      const ownerPid = nextOwnerPid++;
      stubAliveOwner(ownerPid);
      // The live process at that pid started long after the run was recorded.
      stubStartProbe(nowSec() - 30);
      const owner = foreignOwnerId(ownerPid, nowSec() - 86_400);

      expect(piSubagentControlOwnership(run(owner), process.pid)).toBe('orphaned');
      expect(canHostControlPiSubagentRun(run(owner), process.pid)).toBe(true);

      const agentHome = await makeRoot();
      const root = piSubagentRunRoot(agentHome, 'session-1');
      const runId = '123e4567-e89b-42d3-a456-426614174091';
      await writeStatus(root, status(runId, { runtimeOwnerId: owner }));
      await expect(stopAllPiSubagentRunsForExit(agentHome, 150, { hostPid: process.pid }))
        .resolves.toBe(false);
      await expect(readControls(root, runId)).resolves.toEqual([
        expect.objectContaining({ action: 'stop' }),
      ]);
    });

    it('never steals a run from an instance whose start time still matches', async () => {
      const ownerPid = nextOwnerPid++;
      const startTimeSec = nowSec() - 600;
      stubAliveOwner(ownerPid);
      stubStartProbe(startTimeSec);
      const owner = foreignOwnerId(ownerPid, startTimeSec);

      expect(piSubagentControlOwnership(run(owner), process.pid)).toBe('foreign-live');
      expect(canHostControlPiSubagentRun(run(owner), process.pid)).toBe(false);

      const agentHome = await makeRoot();
      const root = piSubagentRunRoot(agentHome, 'session-1');
      const runId = '123e4567-e89b-42d3-a456-426614174092';
      await writeStatus(root, status(runId, { runtimeOwnerId: owner }));
      await expect(stopAllPiSubagentRunsForExit(agentHome, 150, { hostPid: process.pid }))
        .resolves.toBe(true);
      await expect(readdir(path.join(root, runId))).resolves.toEqual(['status.json']);
    });

    it('keeps a legacy id conservative: a live pid is still a live owner', () => {
      const ownerPid = nextOwnerPid++;
      stubAliveOwner(ownerPid);
      // Would report a mismatch if anything asked — nothing may ask.
      stubStartProbe(nowSec() - 30);

      expect(piSubagentControlOwnership(run(`${ownerPid}:scope-foreign`), process.pid))
        .toBe('foreign-live');
      expect(childProcess.spawnSync).not.toHaveBeenCalled();
    });

    it('stays conservative when the start time cannot be read', () => {
      const ownerPid = nextOwnerPid++;
      stubAliveOwner(ownerPid);
      stubStartProbe(null);

      expect(piSubagentControlOwnership(run(foreignOwnerId(ownerPid, nowSec() - 86_400)), process.pid))
        .toBe('foreign-live');
    });

    it('probes a given owner pid once per pass, not once per run', async () => {
      const ownerPid = nextOwnerPid++;
      stubAliveOwner(ownerPid);
      stubStartProbe(nowSec() - 30);
      const owner = foreignOwnerId(ownerPid, nowSec() - 86_400);
      const agentHome = await makeRoot();
      const root = piSubagentRunRoot(agentHome, 'session-1');
      for (const suffix of ['a1', 'a2', 'a3']) {
        await writeStatus(root, status(`123e4567-e89b-42d3-a456-4266141740${suffix}`, {
          runtimeOwnerId: owner,
        }));
      }

      // A zero timeout is exactly one pass, so the count is unambiguous.
      await expect(stopAllPiSubagentRunsForExit(agentHome, 0, { hostPid: process.pid }))
        .resolves.toBe(false);
      // Three runs, one owner pid, one spawn. Without the memo this is a `ps`
      // per run per pass, which shows up as logout latency.
      expect(childProcess.spawnSync).toHaveBeenCalledTimes(1);
    });

    it('re-probes on the next sweep, so a recycled pid cannot hide behind a memo', async () => {
      // The memo is scoped to one pass on purpose. A process-wide cache with a
      // TTL keeps answering with the dead owner's start time for as long as it
      // lives — and that is the very value the recorded id was minted with, so
      // the orphan reads as another live instance and is skipped. Time cannot
      // detect reuse; only a fresh probe can.
      const ownerPid = nextOwnerPid++;
      stubAliveOwner(ownerPid);
      const startTimeSec = nowSec() - 600;
      stubStartProbe(startTimeSec);
      const owner = foreignOwnerId(ownerPid, startTimeSec);
      const agentHome = await makeRoot();
      const root = piSubagentRunRoot(agentHome, 'session-1');
      const runId = '123e4567-e89b-42d3-a456-4266141740d0';
      await writeStatus(root, status(runId, { runtimeOwnerId: owner }));

      // First sweep: the owner is genuinely alive, so its run is left alone.
      await expect(stopAllPiSubagentRunsForExit(agentHome, 0, { hostPid: process.pid }))
        .resolves.toBe(true);
      expect(piSubagentControlOwnership(run(owner), process.pid)).toBe('foreign-live');

      // The owner dies and its pid is handed to something else, well inside any
      // TTL a cache would have used.
      stubStartProbe(nowSec() - 5);
      expect(piSubagentControlOwnership(run(owner), process.pid)).toBe('orphaned');
      await expect(stopAllPiSubagentRunsForExit(agentHome, 0, { hostPid: process.pid }))
        .resolves.toBe(false);
      await expect(readControls(root, runId)).resolves.toEqual([
        expect.objectContaining({ action: 'stop' }),
      ]);
    });
  });

  /**
   * Control is the mirror image of the sweep: a sweep is automatic and fails
   * closed, a control is the user asking for something now. Only a run owned by
   * a different *live* instance may be refused — everything else has to stay
   * controllable or a run left behind by a crashed instance could never be
   * stopped from the UI.
   */
  describe('control ownership', () => {
    const foreignLivePid = process.ppid;
    const deadPid = 4_194_303;
    const run = (runtimeOwnerId?: string): PiSubagentRunStatus =>
      status('123e4567-e89b-42d3-a456-426614174070', { runtimeOwnerId });

    it('allows this process to control its own run', () => {
      const owned = run(piSubagentRuntimeOwnerId(process.pid, 'scope-mine'));
      expect(piSubagentControlOwnership(owned, process.pid)).toBe('self');
      expect(canHostControlPiSubagentRun(owned, process.pid)).toBe(true);
    });

    it('allows recovering a run orphaned by a dead instance', () => {
      const orphan = run(piSubagentRuntimeOwnerId(deadPid, 'scope-crashed'));
      expect(piSubagentControlOwnership(orphan, process.pid)).toBe('orphaned');
      expect(canHostControlPiSubagentRun(orphan, process.pid)).toBe(true);
    });

    it('allows a run whose owner cannot be attributed', () => {
      for (const ownerId of ['owner-a', undefined]) {
        const legacy = run(ownerId);
        expect(piSubagentControlOwnership(legacy, process.pid)).toBe('unattributable');
        expect(canHostControlPiSubagentRun(legacy, process.pid)).toBe(true);
      }
    });

    it('refuses a run owned by another live instance, and stays stable on repeat', () => {
      const foreign = run(piSubagentRuntimeOwnerId(foreignLivePid, 'scope-foreign'));
      expect(piSubagentControlOwnership(foreign, process.pid)).toBe('foreign-live');
      expect(canHostControlPiSubagentRun(foreign, process.pid)).toBe(false);
      // Repeated triggers are pure: no state, same answer.
      expect(canHostControlPiSubagentRun(foreign, process.pid)).toBe(false);
    });
  });

  /**
   * `pi-agent-home` is shared by dev + packaged + every `--passive` instance, so
   * an unscoped exit sweep stops another *running* instance's Subagents. The
   * host pid encoded in the owner id is what makes that decidable.
   */
  describe('agent-home sweeps scoped to the owning host process', () => {
    const foreignLivePid = process.ppid;
    /** A pid that is certainly not running: 2^22 is above every OS pid_max. */
    const deadPid = 4_194_303;

    async function homeWithRuns(): Promise<{ agentHome: string; root: string }> {
      const agentHome = await makeRoot();
      const root = piSubagentRunRoot(agentHome, 'session-1');
      return { agentHome, root };
    }

    it('leaves a live foreign instance\'s run alone on the awaited exit sweep', async () => {
      const { agentHome, root } = await homeWithRuns();
      const mine = '123e4567-e89b-42d3-a456-426614174060';
      const foreign = '123e4567-e89b-42d3-a456-426614174061';
      await writeStatus(root, status(mine, {
        runtimeOwnerId: piSubagentRuntimeOwnerId(process.pid, 'scope-mine'),
      }));
      await writeStatus(root, status(foreign, {
        runtimeOwnerId: piSubagentRuntimeOwnerId(foreignLivePid, 'scope-foreign'),
      }));

      // Times out because our own run never goes terminal; what matters is who
      // got a stop request.
      await expect(stopAllPiSubagentRunsForExit(agentHome, 150, { hostPid: process.pid }))
        .resolves.toBe(false);

      await expect(readControls(root, mine)).resolves.toEqual([
        expect.objectContaining({ action: 'stop' }),
      ]);
      await expect(readdir(path.join(root, foreign))).resolves.toEqual(['status.json']);
    });

    it('still sweeps an orphan whose owning process is gone', async () => {
      const { agentHome, root } = await homeWithRuns();
      const orphan = '123e4567-e89b-42d3-a456-426614174062';
      await writeStatus(root, status(orphan, {
        runtimeOwnerId: piSubagentRuntimeOwnerId(deadPid, 'scope-crashed'),
      }));

      await expect(stopAllPiSubagentRunsForExit(agentHome, 150, { hostPid: process.pid }))
        .resolves.toBe(false);
      await expect(readControls(root, orphan)).resolves.toEqual([
        expect.objectContaining({ action: 'stop' }),
      ]);
    });

    it('fails closed on a legacy owner id that carries no host prefix', async () => {
      const { agentHome, root } = await homeWithRuns();
      const legacy = '123e4567-e89b-42d3-a456-426614174063';
      await writeStatus(root, status(legacy, { runtimeOwnerId: 'owner-a' }));

      await expect(stopAllPiSubagentRunsForExit(agentHome, 150, { hostPid: process.pid }))
        .resolves.toBe(false);
      await expect(readControls(root, legacy)).resolves.toEqual([
        expect.objectContaining({ action: 'stop' }),
      ]);
    });

    it('applies the same scope to the synchronous force-quit sweep and the busy probe', async () => {
      const { agentHome, root } = await homeWithRuns();
      const mine = '123e4567-e89b-42d3-a456-426614174064';
      const foreign = '123e4567-e89b-42d3-a456-426614174065';
      await writeStatus(root, status(foreign, {
        runtimeOwnerId: piSubagentRuntimeOwnerId(foreignLivePid, 'scope-foreign'),
      }));

      // Only the foreign run exists: this host has nothing to stop and must not
      // claim to be busy on someone else's behalf.
      expect(hasActivePiSubagentRunsSync(agentHome, { hostPid: process.pid })).toBe(false);
      expect(requestStopAllPiSubagentRunsSync(agentHome, { hostPid: process.pid })).toBe(0);
      // Unscoped callers keep the old, instance-blind behaviour.
      expect(hasActivePiSubagentRunsSync(agentHome)).toBe(true);

      await writeStatus(root, status(mine, {
        runtimeOwnerId: piSubagentRuntimeOwnerId(process.pid, 'scope-mine'),
      }));
      expect(hasActivePiSubagentRunsSync(agentHome, { hostPid: process.pid })).toBe(true);
      expect(requestStopAllPiSubagentRunsSync(agentHome, { hostPid: process.pid })).toBe(1);
      const control = JSON.parse(
        await readFile(path.join(root, mine, 'control.json'), 'utf8'),
      ) as { action: string };
      expect(control.action).toBe('stop');
      await expect(readdir(path.join(root, foreign))).resolves.toEqual(['status.json']);
    });
  });

  /**
   * The account boundary escalates to killing the runner because a durable
   * child holds unrevocable BYOM credentials. "Reclaimed" therefore has to mean
   * the process is gone, not that a signal was accepted: `taskkill` reports
   * failure through its exit status, and a sweep that believes it would let the
   * account switch proceed with the outgoing credentials still in use.
   */
  describe('verified runner reclaim', () => {
    const runId = '123e4567-e89b-42d3-a456-426614174080';
    const runnerPid = 424_242;
    const runnerScript = `/runs/${runId}/cindy-subagent-runner.cjs`;
    const restores: Array<() => void> = [];

    function usePlatform(value: NodeJS.Platform): void {
      const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
      Object.defineProperty(process, 'platform', { ...original, value });
      restores.push(() => Object.defineProperty(process, 'platform', original));
    }

    /**
     * Swallow the actual kills, and answer a liveness probe for the runner pid
     * the way the OS answers one for a zombie: still there. Other pids (owner
     * attribution, staleness) keep the real answer.
     *
     * `reapedByKill` models the ordinary outcome instead: the process is alive
     * until a real signal reaches it, then ESRCH like any reaped process. The
     * default (never reaped) is the zombie/stubborn case.
     */
    let sentSignals: Array<NodeJS.Signals | number> = [];
    let sentKillPids: number[] = [];
    const killSignals = (): Array<NodeJS.Signals | number> => sentSignals;

    function stubKill(options: { reapedByKill?: boolean } = {}): void {
      const real = process.kill.bind(process);
      sentSignals = [];
      sentKillPids = [];
      let reaped = false;
      const spy = vi.spyOn(process, 'kill').mockImplementation(
        ((pid: number, signal?: NodeJS.Signals | number) => {
          if (Math.abs(pid) !== runnerPid) return real(pid, signal);
          if (signal === 0) {
            if (!reaped) return true;
            throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
          }
          sentKillPids.push(pid);
          sentSignals.push(signal ?? 'unknown');
          if (options.reapedByKill) reaped = true;
          return true;
        }) as typeof process.kill,
      );
      restores.push(() => spy.mockRestore());
    }

    /**
     * The runner's command line stays visible for `aliveProbes` identity checks
     * and then reads as `deadCommandLine` — which is how a reaped process, a
     * zombie, and a recycled pid all look to the probe.
     */
    function stubProbes(options: {
      aliveProbes: number;
      taskkill?: SpawnSyncStub;
      deadCommandLine?: string;
    }): void {
      let probes = 0;
      childProcess.spawnSync.mockImplementation((...args: unknown[]) => {
        if (args[0] === 'taskkill') return options.taskkill ?? { status: 0 };
        probes += 1;
        return {
          status: 0,
          stdout: probes <= options.aliveProbes
            ? `node ${runnerScript} config.json`
            : options.deadCommandLine ?? '',
        };
      });
    }

    const runner = (overrides: Partial<PiSubagentRunStatus> = {}): PiSubagentRunStatus =>
      status(runId, { runnerPid, runnerScript, ...overrides });

    afterEach(() => {
      restores.splice(0).forEach((restore) => restore());
      childProcess.probeDelayMs = 0;
      childProcess.spawnSync.mockReset();
      childProcess.spawnSync.mockImplementation((..._args: unknown[]) => ({ status: 0, stdout: '' }));
    });

    it.each([
      ['a non-zero exit status', { status: 1 }],
      ['a spawn error', { status: null, error: new Error('spawn taskkill ENOENT') }],
      ['a timeout', { status: null, error: new Error('ETIMEDOUT') }],
    ])('reports failure when taskkill fails with %s and the runner survives', async (_label, taskkill) => {
      usePlatform('win32');
      stubKill();
      stubProbes({ aliveProbes: Number.MAX_SAFE_INTEGER, taskkill });

      await expect(killVerifiedPiSubagentRunner(runner())).resolves.toBe(false);
    });

    it('reports success when taskkill claims failure but the runner is actually gone', async () => {
      usePlatform('win32');
      // taskkill reports failure, yet the process really is gone afterwards.
      stubKill({ reapedByKill: true });
      // Only the pre-kill identity check sees it: on Windows a dead pid makes
      // the CIM query return nothing, exactly like a reaped POSIX process.
      stubProbes({ aliveProbes: 1, taskkill: { status: 1 } });

      await expect(killVerifiedPiSubagentRunner(runner())).resolves.toBe(true);
    });

    it('treats a runner that exits during the command-line probe as gone', async () => {
      usePlatform('linux');
      const real = process.kill.bind(process);
      let liveChecks = 0;
      sentSignals = [];
      sentKillPids = [];
      const spy = vi.spyOn(process, 'kill').mockImplementation(
        ((pid: number, signal?: NodeJS.Signals | number) => {
          if (Math.abs(pid) !== runnerPid) return real(pid, signal);
          if (signal === 0) {
            liveChecks += 1;
            if (liveChecks === 1) return true;
            throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
          }
          sentKillPids.push(pid);
          sentSignals.push(signal ?? 'unknown');
          return true;
        }) as typeof process.kill,
      );
      restores.push(() => spy.mockRestore());
      stubProbes({ aliveProbes: 0 });

      await expect(killVerifiedPiSubagentRunner(runner())).resolves.toBe(true);
      expect(killSignals()).toEqual([]);
    });

    it('treats a zombie left by the kill as reclaimed', async () => {
      usePlatform('linux');
      stubKill();
      // `kill(pid, 0)` still succeeds for a zombie, so confirming with it would
      // report this reclaimed runner as unreclaimed forever.
      stubProbes({ aliveProbes: 1, deadCommandLine: '[node] <defunct>' });

      await expect(killVerifiedPiSubagentRunner(runner())).resolves.toBe(true);
    });

    it('reports failure when the runner survives the kill', async () => {
      usePlatform('linux');
      stubKill();
      stubProbes({ aliveProbes: Number.MAX_SAFE_INTEGER });

      await expect(killVerifiedPiSubagentRunner(runner())).resolves.toBe(false);
      // One pre-kill identity check plus the bounded confirmation poll.
      expect(childProcess.spawnSync.mock.calls.length).toBeGreaterThan(1);
    });

    it('signals the runner pid with SIGTERM before SIGKILL and never a process group', async () => {
      usePlatform('linux');
      stubKill();
      stubProbes({ aliveProbes: Number.MAX_SAFE_INTEGER });

      await expect(killVerifiedPiSubagentRunner(runner())).resolves.toBe(false);
      expect(sentKillPids.length).toBeGreaterThan(0);
      expect(sentKillPids.every((pid) => pid > 0)).toBe(true);
      expect(killSignals()[0]).toBe('SIGTERM');
      expect(killSignals()).toContain('SIGKILL');
    });

    it('waits after SIGKILL until the runner is gone', async () => {
      usePlatform('linux');
      stubKill();
      let postKillProbes = 0;
      childProcess.spawnSync.mockImplementation((...args: unknown[]) => {
        if (args[0] === 'taskkill') return { status: 0 };
        const killed = killSignals().includes('SIGKILL');
        if (!killed) return { status: 0, stdout: `node ${runnerScript} config.json` };
        postKillProbes += 1;
        // The first post-SIGKILL listing still matches: the process has not
        // been scheduled out yet. A single immediate probe would report false.
        // Empty stdout is unreadable/unverifiable, not gone — use a listing
        // that is readable and does not carry this run's script.
        return {
          status: 0,
          stdout: postKillProbes <= 1 ? `node ${runnerScript} config.json` : 'other-process',
        };
      });

      await expect(killVerifiedPiSubagentRunner(runner())).resolves.toBe(true);
      expect(killSignals()[0]).toBe('SIGTERM');
      expect(killSignals()).toContain('SIGKILL');
      expect(postKillProbes).toBeGreaterThan(1);
    });

    it('does not report an account-boundary sweep as complete while a runner survives', async () => {
      const root = await makeRoot();
      usePlatform('linux');
      stubKill();
      stubProbes({ aliveProbes: Number.MAX_SAFE_INTEGER });
      await writeStatus(root, runner({ updatedAt: Date.now() }));

      await expect(stopPiSubagentRunsForAccountBoundary(root, { timeoutMs: 0 }))
        .resolves.toBe(false);
    });

    /**
     * Parent deletion is the one caller that also removes the durable files, and
     * it is the one with no upper bound on retrying: a runner that stays alive
     * without ever turning its event loop back to the control mailbox never sees
     * the stop, so every attempt re-posted the same message and timed out again.
     * For a deleted task that is a child spending its credentials and editing
     * its workspace forever, with the metadata never reclaimed.
     */
    describe('deleting a parent task whose runner ignores its mailbox', () => {
      it('escalates to a verified kill and only then removes the files', async () => {
        const root = await makeRoot();
        usePlatform('linux');
        // Alive until a real signal lands — the ordinary stubborn runner.
        stubKill({ reapedByKill: true });
        stubProbes({ aliveProbes: Number.MAX_SAFE_INTEGER });
        await writeStatus(root, runner({ updatedAt: Date.now() }));

        // Zero grace: the mailbox was posted and not consumed, which is the
        // whole precondition. The escalation is what has to follow.
        await expect(stopAndRemovePiSubagentRuns(root, 0)).resolves.toBe(true);

        // The stop was still asked for first — the control file was written —
        // and only the unconsumed mailbox escalated to a signal.
        expect(killSignals()).toContain('SIGTERM');
        expect(existsSync(root)).toBe(false);
      });

      it('leaves the metadata alone when the runner cannot be identified', async () => {
        // No `runnerPid`/`runnerScript` to verify against: the header forbids
        // signalling a pid we cannot prove is ours, and blindly deleting the
        // record would drop the only trace of a child that may still be live.
        const root = await makeRoot();
        usePlatform('linux');
        stubKill();
        stubProbes({ aliveProbes: 0 });
        await writeStatus(root, status(runId, { updatedAt: Date.now() }));

        await expect(stopAndRemovePiSubagentRuns(root, 0)).resolves.toBe(false);

        expect(existsSync(path.join(root, runId, 'status.json'))).toBe(true);
        expect(killSignals()).toEqual([]);
      });

      it('still removes a root whose runs are all terminal without signalling anything', async () => {
        const root = await makeRoot();
        usePlatform('linux');
        stubKill();
        stubProbes({ aliveProbes: Number.MAX_SAFE_INTEGER });
        await writeStatus(root, runner({ state: 'completed', updatedAt: Date.now() }));

        await expect(stopAndRemovePiSubagentRuns(root, 0)).resolves.toBe(true);

        expect(existsSync(root)).toBe(false);
        expect(killSignals()).toEqual([]);
      });
    });

    /**
     * Quit gets one bounded async phase and then the process exits regardless,
     * so the escalation has to fit inside it. Serialising the reclaims made the
     * worst case scale with the number of runners; the probe is async now, so
     * they overlap, and a total budget caps whatever is left.
     */
    describe('reclaim budget', () => {
      const pids = [940_001, 940_002, 940_003, 940_004];

      /** Those pids are live; a real signal reaps them if `reaped` is set. */
      function stubRunnerLiveness(reapedByKill: boolean): void {
        const real = process.kill.bind(process);
        const dead = new Set<number>();
        const spy = vi.spyOn(process, 'kill').mockImplementation(
          ((pid: number, signal?: NodeJS.Signals | number) => {
            const target = Math.abs(pid);
            if (!pids.includes(target)) return real(pid, signal);
            if (signal === 0) {
              if (dead.has(target)) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
              return true;
            }
            if (reapedByKill) dead.add(target);
            return true;
          }) as typeof process.kill,
        );
        restores.push(() => spy.mockRestore());
      }

      /** Every probe answers after `delayMs`, so serial vs parallel is visible. */
      function stubSlowProbes(delayMs: number): void {
        childProcess.probeDelayMs = delayMs;
        restores.push(() => { childProcess.probeDelayMs = 0; });
        childProcess.spawnSync.mockImplementation((...args: unknown[]) => {
          // POSIX passes ['-ww', '-p', '<pid>', '-o', 'args=']; Windows embeds the pid
          // in the CIM filter. Either way it is the only all-digit fragment.
          const flat = (args[1] as string[] | undefined) ?? [];
          const pid = flat
            .map((arg) => (/^\d+$/.test(arg) ? arg : (/ProcessId=(\d+)/.exec(arg)?.[1] ?? '')))
            .find((value) => value.length > 0) ?? '';
          return { status: 0, stdout: `node /runs/runner-${pid}.cjs config.json` };
        });
      }

      async function homeWithRunners(count: number): Promise<string> {
        const agentHome = await makeRoot();
        const root = piSubagentRunRoot(agentHome, 'session-1');
        for (let index = 0; index < count; index += 1) {
          const pid = pids[index]!;
          await writeStatus(root, status(`123e4567-e89b-42d3-a456-42661417${4200 + index}`, {
            runnerPid: pid,
            runnerScript: `/runs/runner-${pid}.cjs`,
            updatedAt: Date.now(),
          }));
        }
        return agentHome;
      }

      it('reclaims several runners concurrently rather than one after another', async () => {
        usePlatform('linux');
        stubRunnerLiveness(true);
        // 150ms per probe. Serial would be at least one probe per runner before
        // any of them can be confirmed; overlapped, they share the wait.
        stubSlowProbes(150);
        const agentHome = await homeWithRunners(4);

        const startedAt = Date.now();
        await expect(stopAllPiSubagentRunsForExit(agentHome, 0, {
          killUnresponsiveRunners: true,
          killBudgetMs: 5_000,
        })).resolves.toBe(true);
        expect(Date.now() - startedAt).toBeLessThan(150 * 4);
      });

      it('reports the runners it could not finish inside the budget', async () => {
        usePlatform('linux');
        // Nothing is ever reaped and every probe is slower than the budget.
        stubRunnerLiveness(false);
        stubSlowProbes(5_000);
        const agentHome = await homeWithRunners(2);

        await expect(stopAllPiSubagentRunsForExit(agentHome, 0, {
          killUnresponsiveRunners: true,
          killBudgetMs: 200,
        })).resolves.toBe(false);
      });
    });

    /**
     * The stop pass counts every run *directory*, so an unreadable status keeps
     * the sweep waiting; the kill pass used to walk only parsed statuses, so the
     * very same run silently left the escalation and the boundary reported
     * itself complete. That is the worst possible direction for this failure:
     * the runs we cannot read are exactly the ones most likely to be wedged.
     */
    describe('runs whose status cannot be read', () => {
      async function homeWithUnreadableRun(write: (dir: string) => Promise<void>): Promise<string> {
        const agentHome = await makeRoot();
        const dir = path.join(piSubagentRunRoot(agentHome, 'session-1'), runId);
        await mkdir(dir, { recursive: true });
        await write(dir);
        return agentHome;
      }

      const cases: Array<[string, (dir: string) => Promise<void>]> = [
        ['is missing entirely', async () => {}],
        ['is not valid JSON', async (dir) => writeFile(path.join(dir, 'status.json'), '{broken')],
        [
          'exceeds the readable size bound',
          async (dir) => writeFile(path.join(dir, 'status.json'), 'x'.repeat(3 * 1024 * 1024)),
        ],
      ];

      it.each(cases)('reports the boundary as incomplete when status %s', async (_label, write) => {
        usePlatform('linux');
        stubKill();
        // Nothing should be signalled: an unverifiable run must not be killed by
        // a pid read off disk — only reported.
        stubProbes({ aliveProbes: 0 });
        const agentHome = await homeWithUnreadableRun(write);

        await expect(stopAllPiSubagentRunsForExit(agentHome, 0, { killUnresponsiveRunners: true }))
          .resolves.toBe(false);
      });

      it('still reports success once every run is readable and reclaimed', async () => {
        usePlatform('linux');
        // Verifiable once, then reaped by the kill: a confirmed reclaim.
        stubKill({ reapedByKill: true });
        stubProbes({ aliveProbes: 1 });
        const agentHome = await makeRoot();
        await writeStatus(
          piSubagentRunRoot(agentHome, 'session-1'),
          runner({ updatedAt: Date.now() }),
        );

        await expect(stopAllPiSubagentRunsForExit(agentHome, 0, { killUnresponsiveRunners: true }))
          .resolves.toBe(true);
      });
    });
  });

  /**
   * The spawn that an update relaunch has to prevent happens inside the Pi
   * process, in an injected extension the Host never calls — so the agreement
   * between them is a file. See `piSubagentLaunchFencePath`.
   */
  describe('launch fence', () => {
    const runId = '123e4567-e89b-42d3-a456-4266141740e0';

    /** Write `hostPid`'s own fence file, as that host's process would. */
    async function writeFenceFor(agentHome: string, hostPid: number): Promise<void> {
      await mkdir(path.dirname(piSubagentLaunchFencePath(agentHome, hostPid)), { recursive: true });
      await writeFile(
        piSubagentLaunchFencePath(agentHome, hostPid),
        `${JSON.stringify({ version: 1, hostPid, createdAt: Date.now() })}\n`,
      );
    }

    async function fenceHome(hostPid: number): Promise<string> {
      const agentHome = await makeRoot();
      await writeFenceFor(agentHome, hostPid);
      return agentHome;
    }

    it('refuses a resume while a run in the same task root is unreadable', async () => {
      // The generation most likely to be briefly unreadable is the newest one —
      // a sharing conflict on a status.json being rewritten is enough. Listing
      // only parseable records showed just the previous, terminal generation and
      // let a second runner start on the same PI session directories.
      const agentHome = await makeRoot();
      const root = piSubagentRunRoot(agentHome, 'session-1');
      await writeStatus(root, status(runId, { state: 'completed' }));
      const opaque = path.join(root, '123e4567-e89b-42d3-a456-4266141740c9');
      await mkdir(opaque, { recursive: true });
      await writeFile(path.join(opaque, 'status.json'), '{not-json');

      await expect(resumePiSubagentRun(root, 'tool-1', 'continue', {
        launchRunner: noopRunnerLaunch,
        env: {},
        runtimeOwnerId: 'owner-a',
        permissionSnapshot: { mode: 'ask', readOnlyRoots: [] },
      })).rejects.toThrow(/cannot be read right now/i);

      // Once it reads again as a terminal record, resume is no longer blocked
      // by it — the refusal is about not being able to tell, not about the run.
      await writeFile(
        path.join(opaque, 'status.json'),
        `${JSON.stringify(status('123e4567-e89b-42d3-a456-4266141740c9', {
          taskId: 'other-tool', state: 'completed',
        }))}\n`,
      );
      await expect(resumePiSubagentRun(root, 'tool-1', 'continue', {
        launchRunner: noopRunnerLaunch,
        env: {},
        runtimeOwnerId: 'owner-a',
        permissionSnapshot: { mode: 'ask', readOnlyRoots: [] },
      })).rejects.not.toThrow(/cannot be read right now/i);
    });

    it('refuses a resume while this host holds the fence', async () => {
      const agentHome = await fenceHome(process.pid);
      const root = piSubagentRunRoot(agentHome, 'session-1');
      await writeStatus(root, status(runId, { state: 'completed' }));

      expect(isPiSubagentLaunchFenceActive(agentHome, process.pid)).toBe(true);
      await expect(resumePiSubagentRun(root, 'tool-1', 'continue', {
        launchRunner: noopRunnerLaunch,
        env: {},
        runtimeOwnerId: 'owner-a',
        permissionSnapshot: { mode: 'ask', readOnlyRoots: [] },
      })).rejects.toThrow(/restarting for an update/i);
    });

    it('ignores a fence owned by another instance or by a dead process', async () => {
      // 2^22 is above every OS pid_max, so this owner is provably gone.
      const deadHome = await fenceHome(4_194_303);
      expect(isPiSubagentLaunchFenceActive(deadHome, 4_194_303)).toBe(false);
      // A live fence that names someone else must not block us either: the
      // agent home is shared by dev, packaged and every --passive instance.
      const foreignHome = await fenceHome(process.ppid);
      expect(isPiSubagentLaunchFenceActive(foreignHome, process.pid)).toBe(false);
    });

    it('counts a launch that published its run directory before the fence went up', async () => {
      // The other half of the ordering argument, from the Host's side: a
      // launcher that got as far as writing its `queued` status *must* be
      // visible to every scan the relaunch performs, so the stability check
      // refuses instead of exiting behind its back.
      const agentHome = await makeRoot();
      const root = piSubagentRunRoot(agentHome, 'session-1');
      await writeStatus(root, status(runId, {
        state: 'queued',
        runnerInstanceId: `launch-pending-${runId}`,
        runnerPid: undefined,
        startedAt: Date.now(),
        updatedAt: Date.now(),
      }));
      // The fence goes up afterwards — the interleaving the launcher's read
      // could have missed.
      const release = await acquirePiSubagentLaunchFence(agentHome);

      expect(hasActivePiSubagentRunsSync(agentHome, { hostPid: process.pid })).toBe(true);
      await release();
    });

    /**
     * One process, several boundaries. An update reclaim the user quits out of,
     * or an account teardown overlapping a quit, both raise the *same* fence
     * file: per-host naming settled who owns it but not how two owners share it.
     */
    describe('a fence that cannot be read', () => {
      it('blocks the resume path instead of reading as no fence', async () => {
        // Collapsing "absent" and "unreadable" is what let a Windows sharing
        // conflict — the Host rewriting the file — read as "nothing is fencing
        // me", after the boundary sweep had already run.
        const agentHome = await makeRoot();
        const file = piSubagentLaunchFencePath(agentHome, process.pid);
        await mkdir(file, { recursive: true });
        try {
          // A directory where the file belongs: readFileSync fails, and not
          // with ENOENT.
          expect(isPiSubagentLaunchFenceActive(agentHome, process.pid)).toBe(true);
        } finally {
          await rm(file, { recursive: true, force: true });
        }
        // And a genuinely absent one still lets a launch through.
        expect(isPiSubagentLaunchFenceActive(agentHome, process.pid)).toBe(false);
      });

      it('blocks on content that exists but does not parse', async () => {
        const agentHome = await makeRoot();
        const file = piSubagentLaunchFencePath(agentHome, process.pid);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, '{"version":1,');

        expect(isPiSubagentLaunchFenceActive(agentHome, process.pid)).toBe(true);
        await rm(file, { force: true });
      });

      it.skipIf(process.platform === 'win32' || (process.getuid?.() ?? 0) === 0)(
        'will not sweep away a fence it could not read',
        async () => {
          // The launch check now obeys an unreadable fence, so deleting one on a
          // transient read error would open the window its owner is holding shut.
          // Unreadable as a *file* on purpose: a directory in its place would
          // survive the old unconditional `rm` too (no `recursive`), and prove
          // nothing about the branch this pins.
          const agentHome = await makeRoot();
          const file = piSubagentLaunchFencePath(agentHome, process.pid);
          await mkdir(path.dirname(file), { recursive: true });
          await writeFile(file, JSON.stringify({ version: 1, hostPid: 4_194_303, createdAt: 1 }));
          await chmod(file, 0o000);

          await clearStalePiSubagentLaunchFence(agentHome);

          expect(existsSync(file)).toBe(true);
          await chmod(file, 0o600);
          await rm(file, { force: true });
        },
      );

      it('still sweeps away debris that is readable and malformed', async () => {
        // The one case that must go: nothing atomic publishes unparseable
        // content, so it names no owner — and leaving it would now block this
        // host's durable launches for good.
        const agentHome = await makeRoot();
        const file = piSubagentLaunchFencePath(agentHome, process.pid);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, 'not json at all');

        await clearStalePiSubagentLaunchFence(agentHome);

        expect(existsSync(file)).toBe(false);
      });
    });

    describe('overlapping boundaries in one process', () => {
      it('keeps the fence up until the last holder releases it', async () => {
        const agentHome = await makeRoot();
        const releaseFirst = await acquirePiSubagentLaunchFence(agentHome);
        const releaseSecond = await acquirePiSubagentLaunchFence(agentHome);

        // Whichever finishes first used to delete the file outright, taking
        // down the fence the other boundary was still relying on.
        await releaseFirst();
        expect(isPiSubagentLaunchFenceActive(agentHome, process.pid)).toBe(true);
        expect(existsSync(piSubagentLaunchFencePath(agentHome, process.pid))).toBe(true);

        await releaseSecond();
        expect(isPiSubagentLaunchFenceActive(agentHome, process.pid)).toBe(false);
        expect(existsSync(piSubagentLaunchFencePath(agentHome, process.pid))).toBe(false);
      });

      it('stays idempotent, so a double release cannot drop a live holder', async () => {
        const agentHome = await makeRoot();
        const releaseFirst = await acquirePiSubagentLaunchFence(agentHome);
        const releaseSecond = await acquirePiSubagentLaunchFence(agentHome);

        await releaseFirst();
        await releaseFirst();
        expect(isPiSubagentLaunchFenceActive(agentHome, process.pid)).toBe(true);

        await releaseSecond();
        expect(isPiSubagentLaunchFenceActive(agentHome, process.pid)).toBe(false);
      });

      /**
       * Two boundaries of one process really do start together — an update
       * reclaim the user quits out of, an account teardown overlapping a quit.
       * Registering the holder only after the write left both of them reading
       * an empty Map, minting separate leases, and each replacing the other's
       * entry and file; the Map ended up knowing about a single holder, and
       * whichever boundary owned that entry took the fence down on its own
       * release while the other was still reclaiming.
       *
       * Repeated, and driven from both release orders, because *which* of the
       * two ends up owning the Map entry and the file is a genuine race — the
       * atomic write's rename is not ordered — and each end state is only
       * visible from one of the orders. One pair therefore reproduces the old
       * behaviour about half the time; a run of them makes it certain. With the
       * reservation taken synchronously there is no race left to sample: both
       * calls share one lease, every iteration.
       */
      it.each([
        ['the second holder finishes first', 'second-first'],
        ['the first holder finishes first', 'first-first'],
      ] as const)('composes two acquisitions that start in the same tick (%s)', async (_label, order) => {
        for (let iteration = 0; iteration < 16; iteration += 1) {
          const agentHome = await makeRoot();
          // Deliberately not awaited in between: this is the interleaving.
          const firstAcquire = acquirePiSubagentLaunchFence(agentHome);
          const secondAcquire = acquirePiSubagentLaunchFence(agentHome);
          const [releaseFirst, releaseSecond] = await Promise.all([firstAcquire, secondAcquire]);
          const file = piSubagentLaunchFencePath(agentHome, process.pid);
          const [earlier, later] = order === 'second-first'
            ? [releaseSecond, releaseFirst]
            : [releaseFirst, releaseSecond];

          await earlier();
          expect(existsSync(file)).toBe(true);
          expect(isPiSubagentLaunchFenceActive(agentHome, process.pid)).toBe(true);

          await later();
          expect(existsSync(file)).toBe(false);
          expect(isPiSubagentLaunchFenceActive(agentHome, process.pid)).toBe(false);
        }
      });

      it.skipIf(process.platform === 'win32' || (process.getuid?.() ?? 0) === 0)(
        'gives back its reservation when the write fails under a concurrent holder',
        async () => {
          // Reserving before the write is what makes the composition sound, so
          // the failure path has to hand that reservation back — and hand back
          // only its own, since another boundary may have incremented in the
          // meantime. Leaking it would leave the survivor's release decrementing
          // to a holder that does not exist, and the fence up for good.
          const agentHome = await makeRoot();
          const release = await acquirePiSubagentLaunchFence(agentHome);
          const file = piSubagentLaunchFencePath(agentHome, process.pid);
          const dir = path.dirname(file);
          // A read-only directory: the atomic write cannot create its temp file.
          await chmod(dir, 0o500);
          await expect(acquirePiSubagentLaunchFence(agentHome)).rejects.toThrow();
          await chmod(dir, 0o700);

          await release();

          expect(existsSync(file)).toBe(false);
        },
      );

      /**
       * Removing a fence is read-then-delete, and the delete is an await. The
       * read saw our own lease; by the time the `rm` ran, a new boundary could
       * have published its own file into the same path — and the delete then
       * took *that* fence down while its holder was counted and believed itself
       * fenced. The launcher inside Pi reads the file, finds nothing, and
       * spawns: a parent Pi survives the boundary's final sweep holding the
       * credentials it inherited.
       *
       * These hold the unlink open across the new publish, which is the whole
       * window, and check the terminal invariant: a counted holder implies a
       * file on disk.
       */
      describe('a release that overlaps the next acquire', () => {
        async function heldRelease(agentHome: string): Promise<{
          releasing: Promise<void>;
          rmHeld: Promise<void>;
          letRmRun: () => void;
        }> {
          const release = await acquirePiSubagentLaunchFence(agentHome);
          let openHeld!: () => void;
          let letRmRun!: () => void;
          const rmHeld = new Promise<void>((resolve) => { openHeld = resolve; });
          fsKnobs.onRmHeld = openHeld;
          fsKnobs.holdRmOnce = new Promise<void>((resolve) => { letRmRun = resolve; });
          return { releasing: release(), rmHeld, letRmRun };
        }

        it('does not delete the fence the next boundary published', async () => {
          const agentHome = await makeRoot();
          const file = piSubagentLaunchFencePath(agentHome, process.pid);
          const held = await heldRelease(agentHome);
          await held.rmHeld;

          // The next boundary starts while the unlink is suspended. Its
          // reservation is synchronous — that part is deliberately not
          // serialised — so the Map already counts a holder here.
          const acquiringNext = acquirePiSubagentLaunchFence(agentHome);
          // Long enough for an unserialised publish to land inside the window.
          await new Promise((resolve) => { setTimeout(resolve, 150); });
          held.letRmRun();
          const releaseNext = await acquiringNext;
          await held.releasing;

          expect(existsSync(file)).toBe(true);
          expect(isPiSubagentLaunchFenceActive(agentHome, process.pid)).toBe(true);

          await releaseNext();
          expect(existsSync(file)).toBe(false);
          expect(isPiSubagentLaunchFenceActive(agentHome, process.pid)).toBe(false);
        });

        it('leaves nothing behind when the overlapping acquire fails instead', async () => {
          // Same window, rollback variant: the failing acquire is the last
          // holder, so its removal is queued too and the terminal state is
          // "no holder, no file" rather than a fence nobody owns.
          const agentHome = await makeRoot();
          const file = piSubagentLaunchFencePath(agentHome, process.pid);
          const held = await heldRelease(agentHome);
          await held.rmHeld;

          fsKnobs.failWriteFileOnce = true;
          const acquiringNext = acquirePiSubagentLaunchFence(agentHome);
          await new Promise((resolve) => { setTimeout(resolve, 150); });
          held.letRmRun();
          await expect(acquiringNext).rejects.toThrow(/EPERM/);
          await held.releasing;

          expect(existsSync(file)).toBe(false);
          expect(isPiSubagentLaunchFenceActive(agentHome, process.pid)).toBe(false);
        });
      });

      /**
       * The stale sweep can reach this process's *own* fence path after pid
       * reuse: the OS hands our pid back to us, the file the previous
       * incarnation left is correctly judged stale, and its unlink then sits in
       * the event loop while a quit or account boundary publishes a new fence on
       * the very same path. Unserialised, the stale unlink removes that new
       * fence and the boundary believes a door is shut that is standing open.
       */
      describe('the stale sweep against this process own path', () => {
        async function writePreviousIncarnationFence(agentHome: string): Promise<string> {
          const file = piSubagentLaunchFencePath(agentHome, process.pid);
          await mkdir(path.dirname(file), { recursive: true });
          // Our pid, someone else's start second: exactly what pid reuse leaves.
          await writeFile(file, `${JSON.stringify({
            version: 1,
            hostPid: process.pid,
            hostStartTimeSec: 1,
            leaseId: 'previous-life',
            createdAt: 1,
          })}\n`);
          return file;
        }

        it('does not delete the fence a boundary published while its unlink was pending', async () => {
          const agentHome = await makeRoot();
          const file = await writePreviousIncarnationFence(agentHome);
          let openHeld!: () => void;
          let letRmRun!: () => void;
          const rmHeld = new Promise<void>((resolve) => { openHeld = resolve; });
          fsKnobs.onRmHeld = openHeld;
          fsKnobs.holdRmOnce = new Promise<void>((resolve) => { letRmRun = resolve; });

          const sweeping = clearStalePiSubagentLaunchFence(agentHome);
          await rmHeld;
          // A boundary starts while the stale unlink is suspended.
          const acquiring = acquirePiSubagentLaunchFence(agentHome);
          // Long enough for an unserialised publish to land inside the window.
          await new Promise((resolve) => { setTimeout(resolve, 150); });
          letRmRun();
          const release = await acquiring;
          await sweeping;

          expect(existsSync(file)).toBe(true);
          expect(isPiSubagentLaunchFenceActive(agentHome, process.pid)).toBe(true);

          await release();
          expect(existsSync(file)).toBe(false);
        });

        it('still clears the previous incarnation when no boundary intervenes', async () => {
          const agentHome = await makeRoot();
          const file = await writePreviousIncarnationFence(agentHome);

          await clearStalePiSubagentLaunchFence(agentHome);

          expect(existsSync(file)).toBe(false);
        });

        it('leaves a fence this process just published alone', async () => {
          // The other interleaving: the publish is already in the chain when the
          // sweep queues behind it, so the sweep re-reads a fence whose start
          // time is this incarnation's and keeps it.
          const agentHome = await makeRoot();
          await writePreviousIncarnationFence(agentHome);
          const release = await acquirePiSubagentLaunchFence(agentHome);
          const file = piSubagentLaunchFencePath(agentHome, process.pid);

          await clearStalePiSubagentLaunchFence(agentHome);

          expect(existsSync(file)).toBe(true);
          expect(isPiSubagentLaunchFenceActive(agentHome, process.pid)).toBe(true);
          await release();
        });
      });

      /**
       * Swallowing a locked unlink is not harmless: the in-memory lease is gone
       * by then, so the file left behind names a *live* pid with nobody holding
       * it, every durable launch is refused as "restarting", and the stale sweep
       * will not clean it either because it only clears dead owners.
       */
      describe('a fence unlink that hits a transient lock', () => {
        it('rides out a lock that clears', async () => {
          const agentHome = await makeRoot();
          const release = await acquirePiSubagentLaunchFence(agentHome);
          const file = piSubagentLaunchFencePath(agentHome, process.pid);
          fsKnobs.rmFailures = { remaining: 3, code: 'EBUSY' };

          await release();

          // The consequence first: a swallowed lock leaves a fence naming a live
          // pid that nothing will clean, and every durable launch is refused.
          expect(existsSync(file)).toBe(false);
          expect(isPiSubagentLaunchFenceActive(agentHome, process.pid)).toBe(false);
          expect(fsKnobs.rmAttempts).toBeGreaterThan(3);
        });

        it('gives up quietly on a lock that does not, and heals on the next boundary', async () => {
          const agentHome = await makeRoot();
          const release = await acquirePiSubagentLaunchFence(agentHome);
          const file = piSubagentLaunchFencePath(agentHome, process.pid);
          fsKnobs.rmFailures = { remaining: Number.MAX_SAFE_INTEGER, code: 'EBUSY' };

          // Documented residue: bounded retries, no throw, file still there.
          await expect(release()).resolves.toBeUndefined();
          expect(existsSync(file)).toBe(true);

          // Self-healing rather than permanent: the next boundary rewrites the
          // path with its own lease, and that holder's release takes it down.
          fsKnobs.rmFailures = null;
          const next = await acquirePiSubagentLaunchFence(agentHome);
          await next();
          expect(existsSync(file)).toBe(false);
          expect(isPiSubagentLaunchFenceActive(agentHome, process.pid)).toBe(false);
        });

        it('does not retry a permanent error', async () => {
          const agentHome = await makeRoot();
          const release = await acquirePiSubagentLaunchFence(agentHome);
          fsKnobs.rmFailures = { remaining: Number.MAX_SAFE_INTEGER, code: 'EROFS' };
          fsKnobs.rmAttempts = 0;

          await release();

          expect(fsKnobs.rmAttempts).toBe(1);
        });
      });

      it('takes the file down when the failing acquire was the last holder', async () => {
        // The reservation is taken before the write, so the *last* holder can be
        // one whose own write failed while an earlier holder had already
        // published the file and released. Dropping only the Map entry left a
        // fence naming a live pid with nobody behind it — every durable launch
        // refused for the rest of the process's life, and the stale sweep will
        // not touch it because it only clears dead owners.
        //
        // The failure is injected at `fs.writeFile` rather than by taking the
        // directory's write bit away: the rollback has to be able to delete the
        // file, and a read-only directory would block that too, testing the
        // environment instead of the code.
        const agentHome = await makeRoot();
        const releaseFirst = await acquirePiSubagentLaunchFence(agentHome);
        const file = piSubagentLaunchFencePath(agentHome, process.pid);
        expect(existsSync(file)).toBe(true);

        // Second boundary reserves synchronously, so its holder is counted
        // before the first one lets go.
        fsKnobs.failWriteFileOnce = true;
        const second = acquirePiSubagentLaunchFence(agentHome);
        await releaseFirst();
        await expect(second).rejects.toThrow(/EPERM/);
        expect(fsKnobs.failWriteFileOnce).toBe(false);

        expect(existsSync(file)).toBe(false);
        expect(isPiSubagentLaunchFenceActive(agentHome, process.pid)).toBe(false);
      });

      it('refuses to delete a fence file it did not write', async () => {
        // Defence in depth for what the counter cannot see: the payload was
        // replaced after this holder acquired, so the file on disk belongs to
        // someone else's lease and is not this release's to drop.
        const agentHome = await makeRoot();
        const release = await acquirePiSubagentLaunchFence(agentHome);
        const file = piSubagentLaunchFencePath(agentHome, process.pid);
        await writeFile(file, `${JSON.stringify({
          version: 1,
          hostPid: process.pid,
          hostStartTimeSec: 1,
          leaseId: 'someone-elses-lease',
          createdAt: Date.now(),
        })}\n`);

        await release();

        expect(existsSync(file)).toBe(true);
        await rm(file, { force: true });
      });

      it('leaves no holder behind when the acquire itself fails', async () => {
        const agentHome = await makeRoot();
        const file = piSubagentLaunchFencePath(agentHome, process.pid);
        // A directory where the fence file belongs: the write fails, and a
        // counter incremented before it would have pinned the fence up for the
        // rest of the process's life.
        await mkdir(file, { recursive: true });
        await expect(acquirePiSubagentLaunchFence(agentHome)).rejects.toThrow();
        await rm(file, { recursive: true, force: true });

        const release = await acquirePiSubagentLaunchFence(agentHome);
        await release();
        expect(isPiSubagentLaunchFenceActive(agentHome, process.pid)).toBe(false);
      });
    });

    /**
     * `pi-agent-home` is shared by dev, packaged and every `--passive` launch,
     * so two instances can be updating at the same moment. A single shared
     * fence file made that a data race: the later writer replaced the earlier
     * one's fence, and either instance's cancellation deleted it outright —
     * after which the still-restarting instance's own launcher read a fence
     * naming somebody else, ignored it, and spawned straight through.
     */
    describe('two instances updating at once', () => {
      const otherHostPid = process.ppid;

      it('keeps each host to its own file, so neither can clobber the other', async () => {
        const agentHome = await makeRoot();
        const release = await acquirePiSubagentLaunchFence(agentHome);
        await writeFenceFor(agentHome, otherHostPid);

        // Both fences exist, under different names, and each blocks its owner.
        expect(isPiSubagentLaunchFenceActive(agentHome, process.pid)).toBe(true);
        expect(isPiSubagentLaunchFenceActive(agentHome, otherHostPid)).toBe(true);
        expect(piSubagentLaunchFencePath(agentHome, process.pid))
          .not.toBe(piSubagentLaunchFencePath(agentHome, otherHostPid));
        await release();
      });

      it('leaves the other instance fenced when this one cancels', async () => {
        const agentHome = await makeRoot();
        const release = await acquirePiSubagentLaunchFence(agentHome);
        await writeFenceFor(agentHome, otherHostPid);

        // This instance gives up on its relaunch.
        await release();

        expect(isPiSubagentLaunchFenceActive(agentHome, process.pid)).toBe(false);
        // The one still restarting must still be fenced — its launcher would
        // otherwise sail through the window this cancellation had nothing to
        // do with.
        expect(isPiSubagentLaunchFenceActive(agentHome, otherHostPid)).toBe(true);
      });

      it('collects a run that appeared after an earlier sweep already finished', async () => {
        // The shape of quit's two passes: the first sweep runs while a parent Pi
        // process may still be alive and can see an empty directory; the run it
        // was about to launch lands afterwards. The second pass, which runs once
        // that process is gone, is what collects it — and reports honestly when
        // it cannot.
        const agentHome = await makeRoot();
        const root = piSubagentRunRoot(agentHome, 'session-1');

        // First pass: nothing on disk, so it completes clean.
        await expect(stopAllPiSubagentRunsForExit(agentHome, 0, {
          hostPid: process.pid,
          killUnresponsiveRunners: true,
        })).resolves.toBe(true);

        // The launch that was already in flight publishes its directory now.
        const lateRunId = '123e4567-e89b-42d3-a456-4266141740e7';
        await writeStatus(root, status(lateRunId, {
          state: 'queued',
          runnerInstanceId: `launch-pending-${lateRunId}`,
          runnerPid: undefined,
          updatedAt: Date.now(),
        }));

        // The second pass sees it — the stop control it writes is the proof.
        // (A launch-pending record carries no runner pid yet, so there is no
        // process to confirm dead and the sweep can still answer true; what
        // matters is that the run is no longer invisible.)
        await stopAllPiSubagentRunsForExit(agentHome, 0, {
          hostPid: process.pid,
          killUnresponsiveRunners: true,
        });
        await expect(readControls(root, lateRunId)).resolves.toEqual([
          expect.objectContaining({ action: 'stop' }),
        ]);

        // And once that record names a live pid whose command line cannot be
        // read, the second pass refuses to call the quit clean. Do not use
        // `process.pid` here: Linux `/proc/<pid>/cmdline` would bypass the
        // spawnSync stub and treat a non-matching listing as a recycled pid.
        const unverifiablePid = 424_424;
        const realKill = process.kill.bind(process);
        const killSpy = vi.spyOn(process, 'kill').mockImplementation(
          ((pid: number, signal?: NodeJS.Signals | number) => {
            if (pid === unverifiablePid && signal === 0) return true;
            return realKill(pid, signal);
          }) as typeof process.kill,
        );
        childProcess.spawnSync.mockImplementation(() => ({
          status: null,
          stdout: '',
          error: Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' }),
        }));
        try {
          await writeStatus(root, status(lateRunId, {
            state: 'running',
            runnerPid: unverifiablePid,
            runnerScript: '/runs/never-matches.cjs',
            updatedAt: Date.now(),
          }));
          await expect(stopAllPiSubagentRunsForExit(agentHome, 0, {
            hostPid: process.pid,
            killUnresponsiveRunners: true,
          })).resolves.toBe(false);
        } finally {
          killSpy.mockRestore();
        }
      });

      it('sweeps only the fences whose owner is gone', async () => {
        const agentHome = await makeRoot();
        await writeFenceFor(agentHome, 4_194_303);
        await writeFenceFor(agentHome, otherHostPid);

        await clearStalePiSubagentLaunchFence(agentHome);

        await expect(readFile(piSubagentLaunchFencePath(agentHome, 4_194_303), 'utf8'))
          .rejects.toMatchObject({ code: 'ENOENT' });
        expect(isPiSubagentLaunchFenceActive(agentHome, otherHostPid)).toBe(true);
      });

      it('ignores and sweeps a fence its pid inherited from a previous life', async () => {
        // A crash leaves the file behind and the OS hands the same pid to the
        // next instance. Without a start time that instance's own fence check
        // matches forever — every durable launch refused for its whole life,
        // and the stale sweep keeps the file because the pid is alive.
        const agentHome = await makeRoot();
        await mkdir(path.dirname(piSubagentLaunchFencePath(agentHome)), { recursive: true });
        await writeFile(
          piSubagentLaunchFencePath(agentHome),
          `${JSON.stringify({
            version: 1,
            hostPid: process.pid,
            hostStartTimeSec: 1,
            createdAt: Date.now(),
          })}\n`,
        );

        expect(isPiSubagentLaunchFenceActive(agentHome, process.pid)).toBe(false);
        await clearStalePiSubagentLaunchFence(agentHome);
        await expect(readFile(piSubagentLaunchFencePath(agentHome), 'utf8'))
          .rejects.toMatchObject({ code: 'ENOENT' });
      });

      it('still blocks on its own fence when the start time matches', async () => {
        const agentHome = await makeRoot();
        const release = await acquirePiSubagentLaunchFence(agentHome);
        expect(isPiSubagentLaunchFenceActive(agentHome, process.pid)).toBe(true);
        // And the sweep leaves a genuinely current fence alone.
        await clearStalePiSubagentLaunchFence(agentHome);
        expect(isPiSubagentLaunchFenceActive(agentHome, process.pid)).toBe(true);
        await release();
      });

      it('keeps pid-only behaviour for a fence with no recorded start time', async () => {
        const agentHome = await makeRoot();
        await writeFenceFor(agentHome, process.pid);
        expect(isPiSubagentLaunchFenceActive(agentHome, process.pid)).toBe(true);
        await clearStalePiSubagentLaunchFence(agentHome);
        expect(isPiSubagentLaunchFenceActive(agentHome, process.pid)).toBe(true);
      });

      it('still honours a fence written under the pre-per-host name', async () => {
        // Half-upgraded pair: the other build writes the shared name. Ours must
        // keep obeying it, or the upgrade itself opens the window.
        const agentHome = await makeRoot();
        const legacy = path.join(
          path.dirname(piSubagentLaunchFencePath(agentHome)),
          '.launch-fence.json',
        );
        await mkdir(path.dirname(legacy), { recursive: true });
        await writeFile(
          legacy,
          `${JSON.stringify({ version: 1, hostPid: process.pid, createdAt: Date.now() })}\n`,
        );

        expect(isPiSubagentLaunchFenceActive(agentHome, process.pid)).toBe(true);
        // And a legacy fence owned by a dead host is swept like any other.
        await writeFile(
          legacy,
          `${JSON.stringify({ version: 1, hostPid: 4_194_303, createdAt: Date.now() })}\n`,
        );
        await clearStalePiSubagentLaunchFence(agentHome);
        await expect(readFile(legacy, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      });
    });

    it('blocks launches for as long as the quit sweep holds it, and no longer', async () => {
      // Quit raises the same fence the relaunch does, around its sweep. While
      // it is up this host may not start a durable run; the moment the disposer
      // releases it — a cancelled quit — launches are allowed again, or the
      // instance would be unable to start one for the rest of its life.
      const agentHome = await makeRoot();
      const release = await acquirePiSubagentLaunchFence(agentHome);
      expect(isPiSubagentLaunchFenceActive(agentHome, process.pid)).toBe(true);

      const root = piSubagentRunRoot(agentHome, 'session-1');
      await writeStatus(root, status(runId, { state: 'completed' }));
      await expect(resumePiSubagentRun(root, 'tool-1', 'continue', {
        launchRunner: noopRunnerLaunch,
        env: {},
        runtimeOwnerId: 'owner-a',
        permissionSnapshot: { mode: 'ask', readOnlyRoots: [] },
      })).rejects.toThrow(/restarting for an update/i);

      await release();
      expect(isPiSubagentLaunchFenceActive(agentHome, process.pid)).toBe(false);
    });

    it('raises, releases, and cleans up after a departed owner', async () => {
      const agentHome = await makeRoot();
      const release = await acquirePiSubagentLaunchFence(agentHome);
      expect(isPiSubagentLaunchFenceActive(agentHome, process.pid)).toBe(true);
      // Idempotent: a cancelled relaunch may unwind more than once.
      await release();
      await release();
      expect(isPiSubagentLaunchFenceActive(agentHome, process.pid)).toBe(false);

      // Startup cleanup drops a dead owner's fence, keeps a live one.
      const staleHome = await fenceHome(4_194_303);
      await clearStalePiSubagentLaunchFence(staleHome);
      await expect(readFile(piSubagentLaunchFencePath(staleHome), 'utf8'))
        .rejects.toMatchObject({ code: 'ENOENT' });
      const liveHome = await fenceHome(process.pid);
      await clearStalePiSubagentLaunchFence(liveHome);
      await expect(readFile(piSubagentLaunchFencePath(liveHome), 'utf8')).resolves.toContain('"version":1');
    });
  });

  it('hot-syncs permission snapshots into every active durable run', async () => {
    const root = await makeRoot();
    const activeId = '123e4567-e89b-42d3-a456-426614174006';
    const terminalId = '123e4567-e89b-42d3-a456-426614174007';
    await writeStatus(root, status(activeId));
    await writeStatus(root, status(terminalId, { state: 'completed' }));
    await expect(syncPiSubagentPermissions(root, {
      mode: 'auto',
      readOnlyRoots: ['/ref'],
      writableRoots: ['/out'],
    })).resolves.toBe(1);
    await expect(readFile(path.join(root, activeId, 'permission.json'), 'utf8')).resolves.toBe(
      '{"mode":"auto","readOnlyRoots":["/ref"],"writableRoots":["/out"]}\n',
    );
    await expect(readFile(path.join(root, terminalId, 'permission.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('hot-syncs permissions only into active runs owned by the current runtime', async () => {
    const root = await makeRoot();
    const ownedId = '123e4567-e89b-42d3-a456-426614174014';
    const foreignId = '123e4567-e89b-42d3-a456-426614174015';
    const legacyId = '123e4567-e89b-42d3-a456-426614174016';
    await writeStatus(root, status(ownedId, { runtimeOwnerId: 'owner-a' }));
    await writeStatus(root, status(foreignId, { runtimeOwnerId: 'owner-b' }));
    await writeStatus(root, status(legacyId, { runtimeOwnerId: undefined }));

    await expect(syncPiSubagentPermissions(
      root,
      { mode: 'bypassPermissions', readOnlyRoots: ['/ref'], writableRoots: ['/out'] },
      'owner-a',
    )).resolves.toBe(1);
    await expect(readFile(path.join(root, ownedId, 'permission.json'), 'utf8'))
      .resolves.toBe(
        '{"mode":"bypassPermissions","readOnlyRoots":["/ref"],"writableRoots":["/out"]}\n',
      );
    await expect(readFile(path.join(root, foreignId, 'permission.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(path.join(root, legacyId, 'permission.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('writes controls only into active runs owned by the current runtime', async () => {
    const root = await makeRoot();
    const ownedId = '123e4567-e89b-42d3-a456-426614174017';
    const foreignId = '123e4567-e89b-42d3-a456-426614174018';
    const legacyId = '123e4567-e89b-42d3-a456-426614174019';
    await writeStatus(root, status(ownedId, { runtimeOwnerId: 'owner-a' }));
    await writeStatus(root, status(foreignId, { runtimeOwnerId: 'owner-b' }));
    await writeStatus(root, status(legacyId, { runtimeOwnerId: undefined }));

    await expect(controlPiSubagentRuns(root, 'tool-1', 'stop', {
      runtimeOwnerId: 'owner-a',
    })).resolves.toBe(0);
    await expect(readControls(root, ownedId)).resolves.toEqual([
      expect.objectContaining({ action: 'stop' }),
    ]);
    await expect(readdir(path.join(root, foreignId, 'controls')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readdir(path.join(root, legacyId, 'controls')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  /**
   * A caller that checks an account fence before calling this has already lost
   * the window: discovery and the run-directory guard are several awaits, and a
   * teardown can start *and finish its stop sweep* inside them. The answer then
   * lands anyway, and the child may act on an `allow` with credentials that
   * belong to the account that just went away. The check has to sit next to the
   * write, which is what `beforeMailboxWrite` is.
   */
  describe('mailbox write gate', () => {
    const gateRunId = '123e4567-e89b-42d3-a456-426614174090';

    async function runAwaitingApproval(root: string): Promise<void> {
      await writeStatus(root, status(gateRunId, {
        tasks: [{
          childId: `${gateRunId}-1`,
          sessionId: `${gateRunId}-1`,
          agent: 'worker',
          status: 'running',
          pendingApproval: { id: 'approval-gate', method: 'confirm', title: 'cindy:permission' },
        }],
      }));
    }

    it('does not write the answer when the gate has closed by write time', async () => {
      const root = await makeRoot();
      await runAwaitingApproval(root);
      const gate = vi.fn(() => false);

      await expect(controlPiSubagentRuns(root, 'tool-1', 'approval', {
        childId: `${gateRunId}-1`,
        approvalId: 'approval-gate',
        confirmed: true,
        beforeMailboxWrite: gate,
      })).resolves.toBe(0);

      // Consulted — so this is a run the helper had already matched, not a
      // no-op — and nothing reached the mailbox.
      expect(gate).toHaveBeenCalled();
      await expect(readdir(path.join(root, gateRunId, 'controls')))
        .rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('is consulted per matched run, after discovery, not once up front', async () => {
      // A task that matches nothing never reaches a write, so the gate is never
      // asked. That is what places the check *after* the awaits rather than
      // beside the caller's own pre-call check.
      const root = await makeRoot();
      await runAwaitingApproval(root);
      const gate = vi.fn(() => true);

      await expect(controlPiSubagentRuns(root, 'no-such-task', 'approval', {
        approvalId: 'approval-gate',
        confirmed: true,
        beforeMailboxWrite: gate,
      })).resolves.toBe(0);

      expect(gate).not.toHaveBeenCalled();
    });

    it('writes exactly as before when the gate stays open', async () => {
      const root = await makeRoot();
      await runAwaitingApproval(root);
      const settled: string[] = [];

      await controlPiSubagentRuns(root, 'tool-1', 'approval', {
        childId: `${gateRunId}-1`,
        approvalId: 'approval-gate',
        confirmed: true,
        beforeMailboxWrite: () => true,
        onMailboxWritesSettled: () => settled.push('writes'),
      });

      await expect(readControls(root, gateRunId)).resolves.toEqual([
        expect.objectContaining({ action: 'approval', confirmed: true }),
      ]);
      // The write phase reports separately from acknowledgement, so a teardown
      // can wait for the bounded half without waiting on the runner.
      expect(settled).toEqual(['writes']);
    });

    it('leaves other actions untouched when no gate is supplied', async () => {
      const root = await makeRoot();
      await writeStatus(root, status(gateRunId));

      await controlPiSubagentRuns(root, 'tool-1', 'stop');

      await expect(readControls(root, gateRunId)).resolves.toEqual([
        expect.objectContaining({ action: 'stop' }),
      ]);
    });
  });

  it('leaves corrupt run directories untouched instead of guessing their lifecycle', async () => {
    const root = await makeRoot();
    const corruptId = '123e4567-e89b-42d3-a456-426614174008';
    await mkdir(path.join(root, corruptId), { recursive: true });
    await writeFile(path.join(root, corruptId, 'status.json'), '{broken');

    await expect(syncPiSubagentPermissions(root, { mode: 'ask', readOnlyRoots: [] })).resolves.toBe(0);
    await expect(readFile(path.join(root, corruptId, 'permission.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('writes control inside the discovered run directory without treating taskId as a path', async () => {
    const root = await makeRoot();
    const runId = '123e4567-e89b-42d3-a456-426614174001';
    const traversalLookingTaskId = '../../../../tmp/not-a-path';
    await writeStatus(root, status(runId, { taskId: traversalLookingTaskId }));

    await expect(controlPiSubagentRuns(root, traversalLookingTaskId, 'stop')).resolves.toBe(0);
    const [control] = await readControls(root, runId);
    expect(control).toMatchObject({ action: 'stop' });
    expect(control?.seq).toEqual(expect.any(Number));
    await expect(readFile(path.join(root, 'control.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not write controls for terminal or unknown tasks', async () => {
    const root = await makeRoot();
    const runId = '123e4567-e89b-42d3-a456-426614174002';
    await writeStatus(root, status(runId, { state: 'completed' }));

    await expect(controlPiSubagentRuns(root, 'tool-1', 'stop')).resolves.toBe(0);
    await expect(controlPiSubagentRuns(root, 'missing', 'stop')).resolves.toBe(0);
    await expect(readdir(path.join(root, runId, 'controls'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not report success for an unknown or already-ended child target', async () => {
    const root = await makeRoot();
    const runId = '123e4567-e89b-42d3-a456-426614174012';
    const running = status(runId, {
      tasks: [
        {
          childId: `${runId}-done`,
          sessionId: `${runId}-done`,
          agent: 'scout',
          status: 'completed',
        },
        {
          childId: `${runId}-active`,
          sessionId: `${runId}-active`,
          agent: 'reviewer',
          status: 'running',
        },
      ],
    });
    await writeStatus(root, running);

    await expect(controlPiSubagentRuns(root, runId, 'steer', {
      childId: `${runId}-done`,
      message: 'too late',
    })).resolves.toBe(0);
    await expect(controlPiSubagentRuns(root, runId, 'stop', {
      childId: 'missing-child',
    })).resolves.toBe(0);
    await expect(controlPiSubagentRuns(root, runId, 'steer', {
      childId: `${runId}-active`,
      message: 'valid direction',
    })).resolves.toBe(0);
    const controls = await readControls(root, runId);
    expect(controls).toEqual([
      expect.objectContaining({
        action: 'steer',
        childId: `${runId}-active`,
        message: 'valid direction',
      }),
    ]);
  });

  it('pages normalized transcript entries from a UUID-contained run', async () => {
    const root = await makeRoot();
    const runId = '123e4567-e89b-42d3-a456-426614174004';
    await writeStatus(root, status(runId));
    const transcript = [
      { type: 'cindy.subagent.child_event', at: 100, childId: 'child-1', event: {
        type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'first answer' }] },
      } },
      { type: 'cindy.subagent.child_event', at: 110, childId: 'child-1', event: {
        type: 'tool_execution_start', toolName: 'read', args: { path: '/tmp/a' },
      } },
      { type: 'cindy.subagent.control', at: 120, control: { action: 'steer', message: 'check b too' } },
    ].map((entry) => JSON.stringify(entry)).join('\n') + '\n';
    await writeFile(path.join(root, runId, 'transcript.jsonl'), transcript);

    const first = await readPiSubagentTranscriptPage(root, runId, { limit: 2 });
    expect(first).toMatchObject({
      supported: true,
      entries: [
        expect.objectContaining({ role: 'subagent', content: 'first answer', occurredAt: 100 }),
        expect.objectContaining({ role: 'tool', toolName: 'read', occurredAt: 110 }),
      ],
    });
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await readPiSubagentTranscriptPage(root, runId, { cursor: first.nextCursor });
    expect(second).toEqual({
      supported: true,
      entries: [expect.objectContaining({
        role: 'parent',
        content: 'check b too',
        controlAction: 'steer',
      })],
      tailCursor: expect.any(String),
    });
    await expect(readPiSubagentTranscriptPage(root, '../escape')).resolves.toEqual({
      supported: false,
      entries: [],
    });
  });

  it('normalizes tool frames into paired card data instead of raw event JSON', async () => {
    const root = await makeRoot();
    const runId = '123e4567-e89b-42d3-a456-426614174020';
    await writeStatus(root, status(runId));
    const transcript = [
      { type: 'cindy.subagent.child_event', at: 100, childId: 'child-1', event: {
        type: 'tool_execution_start',
        toolCallId: 'call-1',
        toolName: 'read',
        args: { file_path: '/tmp/a.ts', limit: 20 },
      } },
      { type: 'cindy.subagent.child_event', at: 110, childId: 'child-1', event: {
        type: 'tool_execution_end',
        toolCallId: 'call-1',
        isError: false,
        result: { content: [{ type: 'text', text: 'file body' }] },
      } },
      { type: 'cindy.subagent.child_event', at: 120, childId: 'child-1', event: {
        type: 'tool_execution_start', toolCallId: 'call-2', toolName: 'bash', args: { command: 'pnpm test' },
      } },
      { type: 'cindy.subagent.child_event', at: 130, childId: 'child-1', event: {
        type: 'tool_execution_end', toolCallId: 'call-2', isError: true, result: { content: [] },
      } },
    ].map((entry) => JSON.stringify(entry)).join('\n') + '\n';
    await writeFile(path.join(root, runId, 'transcript.jsonl'), transcript);

    const page = await readPiSubagentTranscriptPage(root, runId, { limit: 200 });
    expect(page.entries).toEqual([
      expect.objectContaining({
        role: 'tool',
        toolPhase: 'start',
        toolCallId: 'call-1',
        toolName: 'read',
        content: 'read(/tmp/a.ts)',
        toolInputJson: '{"file_path":"/tmp/a.ts","limit":20}',
      }),
      expect.objectContaining({
        role: 'tool',
        toolPhase: 'end',
        toolCallId: 'call-1',
        content: 'file body',
        isError: false,
      }),
      expect.objectContaining({
        role: 'tool',
        toolPhase: 'start',
        toolCallId: 'call-2',
        content: 'bash(pnpm test)',
      }),
      // An empty failed result must still be recorded, or its card would stay
      // stuck in the running state forever.
      expect.objectContaining({
        role: 'tool',
        toolPhase: 'end',
        toolCallId: 'call-2',
        content: '',
        isError: true,
      }),
    ]);
    for (const entry of page.entries) {
      expect(entry.content).not.toContain('tool_execution');
    }
  });

  it('records a message-less control as a readable system line without a text prefix', async () => {
    const root = await makeRoot();
    const runId = '123e4567-e89b-42d3-a456-426614174021';
    await writeStatus(root, status(runId));
    const transcript = [
      { type: 'cindy.subagent.control', at: 100, control: { action: 'stop' } },
      { type: 'cindy.subagent.control', at: 110, control: { action: 'follow_up', message: 'also run tests' } },
      { type: 'cindy.subagent.stdout', at: 120, childId: 'child-1', line: 'raw runner noise' },
    ].map((entry) => JSON.stringify(entry)).join('\n') + '\n';
    await writeFile(path.join(root, runId, 'transcript.jsonl'), transcript);

    const page = await readPiSubagentTranscriptPage(root, runId, { limit: 200 });
    expect(page.entries).toEqual([
      expect.objectContaining({ role: 'system', controlAction: 'stop' }),
      expect.objectContaining({
        role: 'parent',
        controlAction: 'follow_up',
        content: 'also run tests',
      }),
      expect.objectContaining({ role: 'system', content: 'raw runner noise' }),
    ]);
    expect(page.entries[0]?.content).not.toContain('[stop]');
    expect(page.entries[1]?.content).not.toContain('[follow_up]');
  });

  it('tags the system lines it writes itself, and only those', async () => {
    // Synthesised copy cannot stay English in a durable record: it is written
    // once and read back by a UI in whatever language the user picked. The
    // English sentence stays in `content` so an older client is unaffected.
    const root = await makeRoot();
    const runId = '123e4567-e89b-42d3-a456-4266141740c0';
    await writeStatus(root, status(runId));
    const transcript = [
      { type: 'cindy.subagent.control', at: 100, control: { action: 'stop' } },
      { type: 'cindy.subagent.control', at: 105, control: { action: 'approval' } },
      { type: 'cindy.subagent.transcript_truncated', at: 110 },
      { type: 'cindy.subagent.child_event', at: 120, event: { type: 'agent_end' } },
      { type: 'cindy.subagent.child_event', at: 130, event: { type: 'response', success: false } },
      // Harness-supplied text is not ours to localize.
      { type: 'cindy.subagent.child_event', at: 140, event: {
        type: 'response', success: false, error: 'pi said no',
      } },
      { type: 'cindy.subagent.stdout', at: 150, line: 'raw runner noise' },
    ].map((entry) => JSON.stringify(entry)).join('\n') + '\n';
    await writeFile(path.join(root, runId, 'transcript.jsonl'), transcript);

    const page = await readPiSubagentTranscriptPage(root, runId, { limit: 200 });
    expect(page.entries.map((entry) => entry.systemEvent?.kind)).toEqual([
      'stop-requested',
      'control-requested',
      'transcript-truncated',
      'turn-ended',
      'command-refused',
      undefined,
      undefined,
    ]);
    // Every tagged line keeps a readable English fallback for older clients.
    for (const entry of page.entries) {
      expect(entry.content.trim().length).toBeGreaterThan(0);
    }
    expect(page.entries[0]?.content).toBe('A stop was requested from the parent task.');
    expect(page.entries[5]?.content).toBe('pi said no');
  });

  it('resumes a tail read from the EOF cursor and returns only appended entries', async () => {
    const root = await makeRoot();
    const runId = '123e4567-e89b-42d3-a456-426614174022';
    await writeStatus(root, status(runId));
    const transcriptPath = path.join(root, runId, 'transcript.jsonl');
    const line = (at: number, text: string): string => `${JSON.stringify({
      type: 'cindy.subagent.child_event',
      at,
      childId: 'child-1',
      event: { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }] } },
    })}\n`;
    await writeFile(transcriptPath, line(100, 'first answer'));

    const first = await readPiSubagentTranscriptPage(root, runId, { limit: 200 });
    expect(first.entries).toHaveLength(1);
    expect(first.nextCursor).toBeUndefined();
    expect(first.tailCursor).toEqual(expect.any(String));

    const empty = await readPiSubagentTranscriptPage(root, runId, { cursor: first.tailCursor });
    expect(empty.entries).toEqual([]);
    expect(empty.tailCursor).toBe(first.tailCursor);

    await appendFile(transcriptPath, line(200, 'second answer'));
    const tail = await readPiSubagentTranscriptPage(root, runId, { cursor: first.tailCursor });
    expect(tail.entries).toEqual([
      expect.objectContaining({ role: 'subagent', content: 'second answer', occurredAt: 200 }),
    ]);
    expect(tail.tailCursor).not.toBe(first.tailCursor);
  });

  it('reads a resumed task as one conversation across its generations', async () => {
    // A follow-up starts a new run directory. Reading only the newest — what
    // the panel used to do — dropped the original task, its reply and its tool
    // cards the moment the user continued the conversation.
    const root = await makeRoot();
    const first = '123e4567-e89b-42d3-a456-426614174060';
    const second = '123e4567-e89b-42d3-a456-426614174061';
    await writeStatus(root, status(first, { state: 'completed' }));
    await writeStatus(root, status(second));
    const line = (at: number, text: string): string => `${JSON.stringify({
      type: 'cindy.subagent.child_event',
      at,
      childId: 'child-1',
      event: { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }] } },
    })}\n`;
    await writeFile(path.join(root, first, 'transcript.jsonl'), line(100, 'gen one') + line(110, 'gen one tail'));
    await writeFile(path.join(root, second, 'transcript.jsonl'), line(200, 'gen two'));

    const page = await readPiSubagentTranscriptPage(root, [first, second], { limit: 200 });
    expect(page.entries.map((entry) => entry.content)).toEqual(['gen one', 'gen one tail', 'gen two']);
    expect(page.nextCursor).toBeUndefined();
    // Every entry stays addressable by its own generation, so an overlapping
    // page merges by id instead of colliding on a shared byte offset.
    expect(page.entries[0]!.id.startsWith(`${first}:`)).toBe(true);
    expect(page.entries[2]!.id.startsWith(`${second}:`)).toBe(true);

    // The tail cursor sits on the newest generation, so an incremental read
    // picks up only what was appended there.
    const idle = await readPiSubagentTranscriptPage(root, [first, second], { cursor: page.tailCursor });
    expect(idle.entries).toEqual([]);
    await appendFile(path.join(root, second, 'transcript.jsonl'), line(210, 'gen two more'));
    const tail = await readPiSubagentTranscriptPage(root, [first, second], { cursor: page.tailCursor });
    expect(tail.entries.map((entry) => entry.content)).toEqual(['gen two more']);
  });

  it('pages across a generation boundary and honours a cursor from an older generation', async () => {
    const root = await makeRoot();
    const first = '123e4567-e89b-42d3-a456-426614174062';
    const second = '123e4567-e89b-42d3-a456-426614174063';
    await writeStatus(root, status(first, { state: 'completed' }));
    await writeStatus(root, status(second));
    const line = (at: number, text: string): string => `${JSON.stringify({
      type: 'cindy.subagent.child_event',
      at,
      childId: 'child-1',
      event: { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }] } },
    })}\n`;
    await writeFile(path.join(root, first, 'transcript.jsonl'), line(100, 'a') + line(110, 'b'));
    await writeFile(path.join(root, second, 'transcript.jsonl'), line(200, 'c') + line(210, 'd'));

    const collected: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const response = await readPiSubagentTranscriptPage(root, [first, second], { cursor, limit: 1 });
      collected.push(...response.entries.map((entry) => entry.content));
      cursor = response.nextCursor;
      if (!cursor) break;
    }
    expect(collected).toEqual(['a', 'b', 'c', 'd']);

    // A cursor minted against the older generation — by an earlier read, or by
    // a client that has been holding it since before the follow-up — resumes
    // there and rolls forward into the newer one.
    const mid = await readPiSubagentTranscriptPage(root, [first, second], { limit: 1 });
    const resumed = await readPiSubagentTranscriptPage(root, [first, second], { cursor: mid.nextCursor });
    expect(resumed.entries.map((entry) => entry.content)).toEqual(['b', 'c', 'd']);
  });

  it('marks a generation it cannot read instead of losing the ones it can', async () => {
    const root = await makeRoot();
    const first = '123e4567-e89b-42d3-a456-426614174064';
    const second = '123e4567-e89b-42d3-a456-426614174065';
    await writeStatus(root, status(first, { state: 'completed' }));
    await writeStatus(root, status(second));
    // First generation's transcript never made it to disk.
    await writeFile(path.join(root, second, 'transcript.jsonl'), `${JSON.stringify({
      type: 'cindy.subagent.child_event',
      at: 200,
      childId: 'child-1',
      event: { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'gen two' }] } },
    })}\n`);

    const page = await readPiSubagentTranscriptPage(root, [first, second], { limit: 200 });
    expect(page.entries).toEqual([
      expect.objectContaining({ role: 'system', systemEvent: { kind: 'generation-unreadable' } }),
      expect.objectContaining({ content: 'gen two' }),
    ]);
    // A single generation keeps answering exactly as it did: not supported.
    await expect(readPiSubagentTranscriptPage(root, [first], { limit: 200 })).resolves.toEqual({
      supported: false,
      entries: [],
    });
  });

  describe('paging past a generation that cannot be read', () => {
    const line = (at: number, text: string): string => `${JSON.stringify({
      type: 'cindy.subagent.child_event',
      at,
      childId: 'child-1',
      event: { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }] } },
    })}\n`;

    /** Read the whole thing one entry at a time, the cadence that exposes this. */
    async function pageThrough(
      root: string,
      generations: readonly string[],
    ): Promise<{ contents: string[]; pages: number }> {
      const contents: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      for (; pages < 20; pages += 1) {
        const page = await readPiSubagentTranscriptPage(root, generations, { cursor, limit: 1 });
        contents.push(...page.entries.map((entry) => entry.content));
        cursor = page.nextCursor;
        if (!cursor) break;
      }
      return { contents, pages };
    }

    it('advances past the placeholder instead of repeating it', async () => {
      // The marker is that generation's entire contribution, so a cursor still
      // naming it makes the next page re-emit the same marker and get no
      // further. `limit: 1` puts the marker exactly on the page bound every
      // time, which is what turned it into an unbounded repeat — the resumed
      // generations behind it were unreachable.
      const root = await makeRoot();
      const missing = '123e4567-e89b-42d3-a456-426614174070';
      const later = '123e4567-e89b-42d3-a456-426614174071';
      await writeStatus(root, status(missing, { state: 'completed' }));
      await writeStatus(root, status(later));
      await writeFile(path.join(root, later, 'transcript.jsonl'), line(200, 'after the gap'));

      const { contents } = await pageThrough(root, [missing, later]);

      expect(contents).toEqual([
        'An earlier part of this conversation could not be read.',
        'after the gap',
      ]);
    });

    it('walks a run of unreadable generations one at a time', async () => {
      const root = await makeRoot();
      const first = '123e4567-e89b-42d3-a456-426614174072';
      const second = '123e4567-e89b-42d3-a456-426614174073';
      const later = '123e4567-e89b-42d3-a456-426614174074';
      await writeStatus(root, status(first, { state: 'completed' }));
      await writeStatus(root, status(second, { state: 'completed' }));
      await writeStatus(root, status(later));
      await writeFile(path.join(root, later, 'transcript.jsonl'), line(300, 'the survivor'));

      const { contents } = await pageThrough(root, [first, second, later]);

      // One marker per damaged generation, then the readable one.
      expect(contents).toEqual([
        'An earlier part of this conversation could not be read.',
        'An earlier part of this conversation could not be read.',
        'the survivor',
      ]);
    });

    it('ends the transcript when the newest generation is the unreadable one', async () => {
      const root = await makeRoot();
      const readable = '123e4567-e89b-42d3-a456-426614174075';
      const missing = '123e4567-e89b-42d3-a456-426614174076';
      await writeStatus(root, status(readable, { state: 'completed' }));
      await writeStatus(root, status(missing));
      await writeFile(path.join(root, readable, 'transcript.jsonl'), line(100, 'the only reply'));

      const { contents } = await pageThrough(root, [readable, missing]);

      expect(contents).toEqual([
        'the only reply',
        'An earlier part of this conversation could not be read.',
      ]);
      // Nothing beyond it: the last page has no continuation.
      const last = await readPiSubagentTranscriptPage(root, [readable, missing], { limit: 200 });
      expect(last.nextCursor).toBeUndefined();
    });
  });

  it('keeps skipping unparsable and unknown transcript lines', async () => {
    const root = await makeRoot();
    const runId = '123e4567-e89b-42d3-a456-426614174023';
    await writeStatus(root, status(runId));
    const transcript = [
      '{not json',
      JSON.stringify({ type: 'cindy.subagent.unknown_kind', at: 100 }),
      JSON.stringify({ type: 'cindy.subagent.child_event', at: 110, event: { type: 'thinking_delta' } }),
      JSON.stringify({ type: 'cindy.subagent.child_event', at: 120, event: {
        type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '   ' }] },
      } }),
      JSON.stringify({ type: 'cindy.subagent.child_event', at: 130, event: { type: 'agent_end' } }),
    ].join('\n') + '\n';
    await writeFile(path.join(root, runId, 'transcript.jsonl'), transcript);

    const page = await readPiSubagentTranscriptPage(root, runId, { limit: 200 });
    expect(page.entries).toEqual([
      expect.objectContaining({ role: 'system', content: 'Subagent turn ended.' }),
    ]);
  });

  it('requires a message and preserves concurrent control requests without overwriting', async () => {
    const root = await makeRoot();
    const runId = '123e4567-e89b-42d3-a456-426614174003';
    await writeStatus(root, status(runId));

    await expect(controlPiSubagentRuns(root, 'tool-1', 'steer')).rejects.toThrow(/non-empty message/);
    await expect(Promise.all([
      controlPiSubagentRuns(root, 'tool-1', 'steer', { message: 'change direction' }),
      controlPiSubagentRuns(root, runId, 'follow_up', { message: 'also run tests' }),
    ])).resolves.toEqual([0, 0]);
    const controls = await readControls(root, runId);
    expect(controls).toHaveLength(2);
    expect(controls).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'steer', message: 'change direction' }),
      expect.objectContaining({ action: 'follow_up', message: 'also run tests' }),
    ]));
    expect(new Set(controls.map((control) => control.requestId)).size).toBe(2);
  });

  it('refuses a control mailbox redirected through a symlink', async () => {
    const root = await makeRoot();
    const runId = '123e4567-e89b-42d3-a456-426614174014';
    const outside = await makeRoot();
    await writeStatus(root, status(runId));
    await symlink(
      outside,
      path.join(root, runId, 'controls'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    await expect(controlPiSubagentRuns(root, runId, 'stop')).rejects.toThrow(/control directory is unavailable/);
    await expect(readdir(outside)).resolves.toEqual([]);
  });
});
