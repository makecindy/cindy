import { appendFile, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  canHostControlPiSubagentRun,
  controlPiSubagentRuns,
  hasActivePiSubagentRunsSync,
  killVerifiedPiSubagentRunner,
  listPiSubagentRunDiagnostics,
  listPiSubagentRuns,
  acquirePiSubagentLaunchFence,
  clearStalePiSubagentLaunchFence,
  isPiSubagentLaunchFenceActive,
  isPiSubagentRunStale,
  piSubagentControlOwnership,
  piSubagentLaunchFencePath,
  piSubagentOwnerHostPid,
  piSubagentOwnerIdentity,
  piSubagentRunRoot,
  piSubagentRuntimeOwnerId,
  requestStopAllPiSubagentRunsSync,
  readPiSubagentTranscriptPage,
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

const roots: string[] = [];

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
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('PI durable subagent run store', () => {
  it('derives a contained parent-session root and rejects traversal ids', () => {
    expect(piSubagentRunRoot('/agent-home', 'session-1')).toBe(
      path.join('/agent-home', 'runtime', 'pi-subagent-runs', 'session-1'),
    );
    expect(() => piSubagentRunRoot('/agent-home', '../escape')).toThrow(/unsafe/);
    expect(() => piSubagentRunRoot('/agent-home', 'a\\b')).toThrow(/unsafe/);
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
     * differently: `ps -o etime=` yields *elapsed* time, the Windows CIM query
     * yields an *absolute* epoch second. A stub that returned one shape for
     * both made this suite pass on POSIX and fail on Windows, where the elapsed
     * seconds were read as an epoch and every comparison mismatched.
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
    function stubKill(options: { reapedByKill?: boolean } = {}): void {
      const real = process.kill.bind(process);
      let reaped = false;
      const spy = vi.spyOn(process, 'kill').mockImplementation(
        ((pid: number, signal?: NodeJS.Signals | number) => {
          if (Math.abs(pid) !== runnerPid) return real(pid, signal);
          if (signal === 0) {
            if (!reaped) return true;
            throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
          }
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
          // POSIX passes ['-p', '<pid>', '-o', 'args=']; Windows embeds the pid
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
        nodeExecutable: process.execPath,
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
        nodeExecutable: process.execPath,
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
        nodeExecutable: process.execPath,
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
    await expect(syncPiSubagentPermissions(root, { mode: 'ask', readOnlyRoots: [] })).resolves.toBe(1);
    await expect(readFile(path.join(root, activeId, 'permission.json'), 'utf8')).resolves.toContain('"mode":"ask"');
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
      { mode: 'bypassPermissions', readOnlyRoots: [] },
      'owner-a',
    )).resolves.toBe(1);
    await expect(readFile(path.join(root, ownedId, 'permission.json'), 'utf8'))
      .resolves.toContain('bypassPermissions');
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

  it.skipIf(process.platform === 'win32')('refuses a control mailbox redirected through a symlink', async () => {
    const root = await makeRoot();
    const runId = '123e4567-e89b-42d3-a456-426614174014';
    const outside = await makeRoot();
    await writeStatus(root, status(runId));
    await symlink(outside, path.join(root, runId, 'controls'), 'dir');

    await expect(controlPiSubagentRuns(root, runId, 'stop')).rejects.toThrow(/control directory is unavailable/);
    await expect(readdir(outside)).resolves.toEqual([]);
  });
});
