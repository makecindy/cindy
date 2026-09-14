import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/**
 * Read a source file with line endings normalised.
 *
 * A Windows checkout has CRLF on disk, so any multi-line literal an assertion
 * matches against ("onQuit(\n  'pi-subagent-runners'," and friends) silently
 * misses there while passing everywhere else — three of these went red on the
 * Windows runner alone.
 */
function readSourceNormalized(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
}

const source = readSourceNormalized('../bootstrap-electron.ts');

/**
 * The quit hook is Electron wiring in a module that cannot be imported under
 * test, so the wiring itself is asserted on the source — same approach as
 * `updateServiceIOSSimulatorExit.test.ts`.
 *
 * What is being protected is not a style rule: without the escalation the sweep
 * only *asks* runners to stop, logs one line when they do not, and lets the app
 * exit. A wedged runner then keeps running on the BYOM credentials it inherited
 * through its spawn env — credentials no token revocation can reach — with no
 * supervising process left.
 */
describe('PI Subagent quit sweep', () => {
  function quitHookSource(): string {
    const start = source.indexOf("onQuit(\n  'pi-subagent-runners',");
    expect(start).toBeGreaterThanOrEqual(0);
    const end = source.indexOf("  'async',\n);", start);
    expect(end).toBeGreaterThan(start);
    return source.slice(start, end);
  }

  it('escalates to the identity-verified kill, like the account boundary does', () => {
    const hook = quitHookSource();
    expect(hook).toContain('killUnresponsiveRunners: true');
    // Still scoped to this process: a concurrent instance sharing the agent home
    // must never have its runners killed by our quit.
    expect(hook).toContain('hostPid: process.pid');
  });

  it('raises the launch fence before the sweep and keeps holding it', () => {
    // This disposer and `shutdown-maker` are both `async`, so they run at the
    // same time: a parent Pi process can still be alive here and can enter
    // `launchDurableRun` while the sweep walks an empty directory. Scanning
    // harder cannot close that — the run directory is created inside Pi, by an
    // extension the Host never calls. Only the fence can, and it has to be up
    // before the first scan for the ordering argument to hold.
    const hook = quitHookSource();
    const fence = hook.indexOf('acquirePiSubagentLaunchFence(agentHome)');
    const sweep = hook.indexOf('stopAllPiSubagentRunsForExit(agentHome');
    expect(fence).toBeGreaterThan(-1);
    expect(sweep).toBeGreaterThan(fence);
    // A fence we cannot raise must not hold up the quit: the sweep still runs.
    const acquire = hook.slice(fence, sweep);
    expect(acquire).toContain('catch');
    expect(acquire).toMatch(/piSubagentLog\.warn/);
    // Releasing it here would re-open durable launches for the rest of the
    // quit, with no later sweep to collect whatever appeared. The handle goes
    // to the post-async pass instead.
    expect(hook).toContain('releaseQuitLaunchFence = await acquirePiSubagentLaunchFence');
    // No teardown block of any shape here — the handle is handed on, and the
    // release happens exactly once, in the post-async pass.
    expect(hook).not.toContain('} finally {');
    expect([...source.matchAll(/releaseQuitLaunchFence = null;/g)]).toHaveLength(1);
    expect(hook).not.toContain('releaseQuitLaunchFence = null;');
  });

  it('finishes with a post-async sweep that is the one to drop the fence', () => {
    // post-async only starts once the async phase settled or hit its budget, so
    // it is the first point at which `shutdown-maker` — and with it every Pi
    // process — is known to be finished.
    const start = source.indexOf("onQuit(\n  'pi-subagent-final-sweep',");
    expect(start).toBeGreaterThanOrEqual(0);
    const end = source.indexOf("  'post-async',\n);", start);
    expect(end).toBeGreaterThan(start);
    const hook = source.slice(start, end);
    expect(hook).toContain('killUnresponsiveRunners: true');
    expect(hook).toContain('hostPid: process.pid');
    // Short budget: this phase races each disposer against the same 6s.
    expect(hook).toMatch(/stopAllPiSubagentRunsForExit\(agentHome, 1_000,/);
    expect(hook).toContain('killBudgetMs: 1_500');
    // Survivors of *this* pass are the ones nothing else will collect.
    expect(hook).toMatch(/piSubagentLog\.error/);
    // The fence comes down only once the parent is provably down. Asserted
    // structurally rather than by matching a phrase: every release site in this
    // hook must sit inside the settle guard, so rewriting the call shape cannot
    // quietly restore an unconditional release.
    const guard = hook.indexOf('if (makerShutdownSettled) {');
    expect(guard).toBeGreaterThan(-1);
    const guardEnd = hook.indexOf('} else {', guard);
    expect(guardEnd).toBeGreaterThan(guard);
    const releaseSites = [...hook.matchAll(/releaseQuitLaunchFence = null;/g)];
    expect(releaseSites).toHaveLength(1);
    expect(releaseSites[0]!.index!).toBeGreaterThan(guard);
    expect(releaseSites[0]!.index!).toBeLessThan(guardEnd);
    // The other branch has to say so, or a held fence looks like a silent hang.
    expect(hook.slice(guardEnd)).toMatch(/piSubagentLog\.error/);
  });

  /**
   * The async phase raises the fence once and, if that throws, carries on
   * fenceless. The whole mutual-exclusion argument (fence, then scan, against
   * the launcher's publish, then read) is void in that state — and a
   * concurrent `shutdown-maker` that times out or reports a failed detach
   * leaves a parent Pi alive to exploit it.
   */
  describe('a quit that could not raise its fence', () => {
    function finalSweepSource(): string {
      const start = source.indexOf("onQuit(\n  'pi-subagent-final-sweep',");
      expect(start).toBeGreaterThanOrEqual(0);
      const end = source.indexOf("  'post-async',\n);", start);
      expect(end).toBeGreaterThan(start);
      return source.slice(start, end);
    }

    it('tracks whether the fence really went up, not just whether it was released', () => {
      // `releaseQuitLaunchFence` is also null after a *successful* release, so
      // it cannot answer "was one ever raised" — which is the question both the
      // retry and the final log depend on.
      expect(source).toContain('let quitLaunchFenceRaised = false;');
      const asyncHook = source.slice(
        source.indexOf("onQuit(\n  'pi-subagent-runners',"),
        source.indexOf("onQuit(\n  'shutdown-maker',"),
      );
      expect(asyncHook).toContain('quitLaunchFenceRaised = true;');
    });

    it('retries the fence before the final scan, and scans after it', () => {
      // Restores the ordering the argument rests on, and confines the fenceless
      // window to the async phase instead of the whole quit.
      const hook = finalSweepSource();
      const retry = hook.indexOf('if (!quitLaunchFenceRaised) {');
      const acquire = hook.indexOf('acquirePiSubagentLaunchFence(agentHome)', retry);
      const scan = hook.indexOf('stopAllPiSubagentRunsForExit(agentHome, 1_000,');
      expect(retry).toBeGreaterThan(-1);
      expect(acquire).toBeGreaterThan(retry);
      expect(scan).toBeGreaterThan(acquire);
      expect(hook.slice(acquire, scan)).toContain('quitLaunchFenceRaised = true;');
    });

    it('keeps re-scanning while fenceless and the parent is unproven', () => {
      // Nothing runs after this disposer, so a single pass would leave "after
      // the last scan" wide open. Repetition narrows it to the gap between two
      // scans, and each round is another chance for a slow `shutdown-maker` to
      // finish — which ends the loop.
      const hook = finalSweepSource();
      const loop = hook.indexOf('if (!quitLaunchFenceRaised && !makerShutdownSettled) {');
      expect(loop).toBeGreaterThan(-1);
      expect(hook.slice(loop)).toContain('while (!makerShutdownSettled && Date.now() < deadline)');
      // Bounded, and tighter per round than the conclusive pass, so it fits the
      // post-async budget rather than being cut off by it.
      expect(source).toContain('const FENCELESS_QUIT_RESWEEP_BUDGET_MS = 2_500;');
      expect(hook.slice(loop)).toContain('stopAllPiSubagentRunsForExit(agentHome, 300,');
    });

    it('does not claim to hold a fence it never raised', () => {
      const hook = finalSweepSource();
      // The hold branch is now conditional on one actually existing.
      expect(hook).toContain('} else if (quitLaunchFenceRaised) {');
      const holding = hook.indexOf('holding the PI Subagent ');
      const fenceless = hook.indexOf('no PI Subagent launch fence and no proof the parent is down');
      expect(holding).toBeGreaterThan(-1);
      expect(fenceless).toBeGreaterThan(holding);
      // The fenceless branch states the exposure instead of implying a closed
      // door, and the old wording is not what it reaches for.
      const fencelessBranch = hook.slice(hook.lastIndexOf('} else {', fenceless));
      expect(fencelessBranch).not.toContain('holding the PI Subagent');
      expect(fencelessBranch).toContain('could still publish a durable runner after the last scan');
    });
  });

  it('only calls the parent down when shutdownMaker actually finished', () => {
    // `shutdownMaker` awaits `waitForTurnChangeSetActions()` before it ever
    // reaches `maker.shutdown`, so a rejection can mean the Maker was never
    // shut down and every parent Pi process is still alive. Treating a
    // rejection as settled would lower the fence in exactly that case.
    expect([...source.matchAll(/let makerShutdownSettled = false;/g)]).toHaveLength(1);
    const start = source.indexOf("onQuit(\n  'shutdown-maker',");
    expect(start).toBeGreaterThanOrEqual(0);
    const hook = source.slice(start, source.indexOf("  'async',\n);", start));
    const awaited = hook.indexOf('await shutdownMaker();');
    const marked = hook.indexOf('makerShutdownSettled = true;');
    expect(awaited).toBeGreaterThan(-1);
    expect(marked).toBeGreaterThan(awaited);
    // No error handling around it: a `finally` (or a swallowing `catch`) would
    // let a rejection through as settled, which is exactly the case this
    // distinction exists to catch.
    expect(hook).not.toContain('try {');
    // And it is set exactly once, so no other path can claim the parent is down.
    expect([...source.matchAll(/makerShutdownSettled = true;/g)]).toHaveLength(1);
    // Fulfilment alone is not the proof it reads as: `Maker.shutdown` reports
    // per-session detach failures rather than throwing, so it can resolve with
    // a PI parent still alive and able to publish a durable run. That case must
    // leave the fence up too, so the settle flag has to sit behind the report.
    const guard = hook.indexOf('if (piSessionFailures > 0) {');
    expect(guard).toBeGreaterThan(awaited);
    expect(guard).toBeLessThan(marked);
    expect(hook.slice(guard, marked)).toContain('return;');
    expect(hook.slice(guard, marked)).toMatch(/piSubagentLog\.error/);
    // Ordered ahead of the bridge and the SSH pool teardown.
    expect(start).toBeLessThan(source.indexOf("onQuit('pi-env'"));
    expect(start).toBeLessThan(source.indexOf("onQuit('remote-ssh-pool'"));
  });

  it('leaves a stop budget that fits inside the bounded async quit phase', () => {
    // The kill confirmation is bounded but not free (~0.8s per surviving
    // runner), so the stop wait cannot also use the whole phase.
    expect(quitHookSource()).toMatch(/stopAllPiSubagentRunsForExit\(agentHome, 2_500,/);
    expect(source).toContain('installQuitHandler(6000);');
  });

  it('reports survivors as an error rather than an acknowledged stop', () => {
    // The old wording ("did not all acknowledge stop") read like a timing note.
    // After the escalation, a false return means runners we could not confirm
    // dead are still running — that must not be logged as routine.
    const hook = quitHookSource();
    const failureBranch = hook.slice(hook.indexOf('if (!stopped)'));
    expect(failureBranch).toContain('piSubagentLog.error');
    expect(failureBranch).toMatch(/survived stop and identity-verified kill/);
  });

  it('aborts the account boundary when runners cannot be confirmed stopped', () => {
    // Everything after this point in the teardown hands the runtime over: the
    // Maker is discarded, the outgoing DB is disposed, the app session commits
    // to a new account. Logging and continuing would leave a runner spending
    // the previous account's BYOM credentials with nobody supervising it.
    expect(source).toContain('class PiSubagentAccountBoundaryError extends Error');
    const teardown = source.slice(
      source.indexOf('async function teardownAuthAccountBoundary(reason: string)'),
    );
    const sweep = teardown.indexOf('const stopped = await stopAllPiSubagentRunsForExit(');
    const body = teardown.slice(sweep, teardown.indexOf('resetMaker();', sweep));
    expect(sweep).toBeGreaterThan(-1);
    // Both failure shapes abort: a false verdict and a throwing sweep.
    expect(body).toContain('throw new PiSubagentAccountBoundaryError(reason, err);');
    expect(body).toContain('if (!stopped) throw new PiSubagentAccountBoundaryError(reason);');
    // The surrounding catch deliberately downgrades everything else to
    // non-fatal — this one must not be laundered with it.
    const handler = teardown.slice(teardown.indexOf('} catch (err) {', sweep));
    const rethrow = handler.indexOf('throw err;');
    const nonFatal = handler.indexOf('(non-fatal)');
    expect(rethrow).toBeGreaterThan(-1);
    expect(rethrow).toBeLessThan(nonFatal);
    // The abort has to land before the handover steps, not after them.
    expect(teardown.indexOf('resetMaker();', sweep)).toBeGreaterThan(sweep);
    expect(teardown.indexOf('lifecycleDbClientManager.dispose(reason)', sweep)).toBeGreaterThan(sweep);
  });

  it('disposes goals before waiting for the account-boundary fence', () => {
    const teardown = source.slice(
      source.indexOf('async function teardownAuthAccountBoundary(reason: string)'),
      source.indexOf('authManager.setAccountSwitchTeardown('),
    );
    const reset = teardown.indexOf('resetGoalController();');
    const firstAwait = teardown.indexOf('await ');
    const acquire = teardown.indexOf('acquirePiSubagentLaunchFence(');
    expect(reset).toBeGreaterThan(-1);
    expect(firstAwait).toBeGreaterThan(reset);
    expect(acquire).toBeGreaterThan(firstAwait);
    // Fence acquisition can queue behind filesystem work. The synchronous reset
    // must already have cancelled continuation and usage-resume timers while it waits.
    expect(teardown.slice(firstAwait, acquire)).toBe('await ');
  });

  it('restores the outgoing account goals when launch-fence acquisition aborts', () => {
    const teardown = source.slice(
      source.indexOf('async function teardownAuthAccountBoundary(reason: string)'),
      source.indexOf('authManager.setAccountSwitchTeardown('),
    );
    const acquire = teardown.indexOf('acquirePiSubagentLaunchFence(');
    const acquireCatch = teardown.indexOf('} catch (err) {', acquire);
    const abort = teardown.indexOf('throw new PiSubagentAccountBoundaryError(', acquireCatch);
    const restore = teardown.indexOf('startGoalController({', acquireCatch);
    expect(acquireCatch).toBeGreaterThan(acquire);
    expect(restore).toBeGreaterThan(acquireCatch);
    expect(restore).toBeLessThan(abort);
    const recovery = teardown.slice(acquireCatch, abort);
    expect(recovery).toContain('const maker = getMakerCore();');
    expect(recovery).toContain('getDb: () => getDbClient().drizzle');
    expect(recovery).toContain('createAutomationUserTurnGitBaselineHooks()');
    // Goal IPC is restored synchronously, while the full Scheduler/Goal/Learn
    // startup is queued behind any superseded in-flight attempt. The original
    // fence error is still surfaced without awaiting that background recovery.
    expect(recovery).toContain('void attemptStartScheduler();');
    expect(recovery).not.toContain('await attemptStartScheduler()');
    const startup = source.slice(
      source.indexOf('let attemptStartSchedulerBarrier: Promise<void>'),
      source.indexOf('const _scheduleIpcRegistered'),
    );
    expect(startup).toContain(
      'attemptStartSchedulerBarrier.then(() => attemptStartSchedulerOnce())',
    );
    expect(startup).toContain('attemptStartSchedulerBarrier = attempt.catch(() => undefined)');
  });

  it('raises the account-boundary fence before the remaining destructive teardown', () => {
    // Failing to raise it aborts the handover. It used to do that from the
    // middle of the teardown: input device slots suspended, the custom provider
    // catalog cleared, IM / scheduler / embedding / Ghost projection already
    // stopped — and the abort path rebuilds none of them, so the user was left
    // on a half-dismantled account until a restart. Raised first, the abort
    // leaves only the deliberately synchronous GoalController invalidation done;
    // no owner-scoped service has been drained or discarded yet.
    const teardown = source.slice(
      source.indexOf('async function teardownAuthAccountBoundary(reason: string)'),
      source.indexOf('authManager.setAccountSwitchTeardown('),
    );
    const acquire = teardown.indexOf('acquirePiSubagentLaunchFence(');
    expect(acquire).toBeGreaterThan(-1);
    for (const destructive of [
      'suspendInputDeviceTaskSlots();',
      'skillhubAutoSyncService.cancelInFlight();',
      'setCustomProviders([]);',
      'clearModelVisibilityMirror();',
      'await getMirrorCache().clearAll();',
      'stopImConnection(reason)',
      'resetSchedulerReady();',
      'lifecycleDbClientManager.dispose(reason)',
    ]) {
      expect(teardown.indexOf(destructive)).toBeGreaterThan(acquire);
    }
    // Still fail-closed, and still released on every exit — the abort throws
    // from inside the try whose finally lowers it.
    expect(teardown.slice(acquire)).toContain("'the PI Subagent launch fence could not be raised'");
    const release = teardown.indexOf('const releaseFence = releaseBoundaryLaunchFence;');
    expect(release).toBeGreaterThan(teardown.indexOf('lifecycleDbClientManager.dispose(reason)'));
    expect(teardown.lastIndexOf('} finally {', release)).toBeGreaterThan(acquire);
  });

  it('replaces the shut-down Maker when it aborts the handover with nothing attached', () => {
    // `Maker.shutdown` sets `shutdownStarted` on entry and never clears it, so
    // after it runs every `createSession` is refused. Completing the handover
    // replaces the instance; aborting it used to rethrow straight past
    // `resetMaker()`, leaving the user on the old account unable to start a
    // task until the app restarted.
    const teardown = source.slice(
      source.indexOf('async function teardownAuthAccountBoundary(reason: string)'),
    );
    const handler = teardown.slice(teardown.indexOf('if (err instanceof PiSubagentAccountBoundaryError) {'));
    const reset = handler.indexOf('if (shutdownRan && retainedPiSessions === 0) resetMaker();');
    const rethrow = handler.indexOf('throw err;');
    expect(reset).toBeGreaterThan(-1);
    // Before the rethrow, or it never runs.
    expect(rethrow).toBeGreaterThan(reset);

    // Marked before the await, because entry is what poisons the singleton.
    const shutdownCall = teardown.indexOf("await maker.shutdown({ reason: 'account-boundary' })");
    expect(teardown.indexOf('if (maker) shutdownRan = true;')).toBeLessThan(shutdownCall);
    // And it starts false, so the fence-acquisition throw — which happens
    // before the Maker is touched at all — cannot reset a healthy instance.
    expect(teardown).toContain('let shutdownRan = false;');
    expect(teardown.indexOf('let shutdownRan = false;'))
      .toBeGreaterThan(teardown.indexOf('the PI Subagent launch fence could not be raised'));
  });

  it('records that a handover aborted after teardown had already run', () => {
    // The abort keeps the user on the old account, but the custom provider
    // catalog is already cleared and IM / scheduler / embedding / Ghost / Learn
    // are already stopped — and their construction duals hang off the login and
    // DB-ready sequence, which nothing on this path re-runs. Both abort
    // sub-paths (a failed sweep and a failed detach) reach the same marker;
    // only the pre-teardown fence failure does not, because nothing has been
    // taken apart yet when it throws.
    const teardown = source.slice(
      source.indexOf('function markAccountBoundaryAbortedMidTeardown('),
      source.indexOf('authManager.setAccountSwitchTeardown('),
    );
    const handler = teardown.slice(teardown.indexOf('if (err instanceof PiSubagentAccountBoundaryError) {'));
    const mark = handler.indexOf('markAccountBoundaryAbortedMidTeardown(reason);');
    expect(mark).toBeGreaterThan(-1);
    expect(handler.indexOf('throw err;')).toBeGreaterThan(mark);
    // One handler for both abort shapes: the sweep verdict and the detach
    // failure both throw the same error type into it.
    expect(teardown).toContain('if (!stopped) throw new PiSubagentAccountBoundaryError(reason);');
    expect(teardown).toContain('if (piSessionFailures.length > 0) {');
    // The fence-acquisition throw happens before the marker exists in the flow.
    expect(source.indexOf("'the PI Subagent launch fence could not be raised'"))
      .toBeLessThan(source.indexOf('markAccountBoundaryAbortedMidTeardown(reason);'));
    // Says which services are down rather than only that something failed.
    for (const named of ['custom provider catalog', 'IM, scheduler,', 'restarted']) {
      expect(source).toContain(named);
    }
    // Once per abort: the marker is set first and an already-set marker returns.
    // A restart dialog is a product decision and is not smuggled in here.
    const marker = source.slice(
      source.indexOf('function markAccountBoundaryAbortedMidTeardown('),
      source.indexOf('async function teardownAuthAccountBoundary(reason: string)'),
    );
    expect(marker).not.toContain('showAccountBoundaryAbortNotice');
    expect(marker).not.toContain('accountBoundaryAbort.title');
    const guard = marker.indexOf('if (accountBoundaryAbortedMidTeardown !== null) return;');
    expect(guard).toBeGreaterThan(-1);
    // A completed handover takes the blocking state back down.
    expect(source).toContain('clearAccountBoundaryAbortMark();');
    const teardownBody = source.slice(
      source.indexOf('async function teardownAuthAccountBoundary(reason: string)'),
      source.indexOf('authManager.setAccountSwitchTeardown('),
    );
    expect(teardownBody.indexOf('clearAccountBoundaryAbortMark();'))
      .toBeGreaterThan(teardownBody.indexOf('if (blockingFailures.length > 0) {'));
  });

  it('keeps the Maker when a session it still holds failed to detach', () => {
    // `Session.detach` leaves a failed session in `error`, not `closed`, so the
    // Maker keeps its status listener and its active-session slot on purpose
    // and a later `shutdown()` retries it. Discarding the instance there would
    // orphan a live PI process still spending the outgoing account's
    // credentials — the one case where staying poisoned is the lesser harm.
    const teardown = source.slice(
      source.indexOf('async function teardownAuthAccountBoundary(reason: string)'),
    );
    const assign = teardown.indexOf('retainedPiSessions = piSessionFailures.length;');
    const abort = teardown.indexOf('if (piSessionFailures.length > 0) {');
    expect(assign).toBeGreaterThan(-1);
    // Recorded before the branch that throws on it, so the handler can read it.
    expect(abort).toBeGreaterThan(assign);
    expect(teardown).toContain('let retainedPiSessions = 0;');
  });

  it('fences durable launches across the whole account boundary, and always lowers it', () => {
    // `Maker.shutdown` collects per-session detach failures instead of throwing,
    // so a parent Pi can outlive it — and a survivor could publish a fresh run
    // after the one-shot sweep had already scanned, handing the incoming owner a
    // runner holding the previous account's credentials. Same fence, same
    // ordering argument, as quit and the update relaunch.
    const teardown = source.slice(
      source.indexOf('async function teardownAuthAccountBoundary(reason: string)'),
    );
    const raise = teardown.indexOf('acquirePiSubagentLaunchFence(');
    const shutdown = teardown.indexOf("maker.shutdown({ reason: 'account-boundary' })");
    const sweep = teardown.indexOf('stopAllPiSubagentRunsForExit(');
    expect(raise).toBeGreaterThan(-1);
    // Before the shutdown, so it covers the shutdown *and* the sweep.
    expect(shutdown).toBeGreaterThan(raise);
    expect(sweep).toBeGreaterThan(shutdown);
    expect(raise).toBeLessThan(teardown.indexOf('suspendInputDeviceTaskSlots();'));
    // Failing to raise it aborts the handover instead of warning and carrying
    // on. Quit and the update relaunch are allowed to continue fenceless — the
    // process is about to disappear, or the operation is cancelled outright.
    // Here the process keeps running and changes owner, so the window the fence
    // closes is exactly the one still open. A logout can be retried.
    const acquire = teardown.slice(raise, teardown.indexOf('suspendInputDeviceTaskSlots();'));
    expect(acquire).not.toMatch(/authBoundaryLog\.warn/);
    expect(acquire).toContain('throw new PiSubagentAccountBoundaryError(');
    expect(acquire).toContain("'the PI Subagent launch fence could not be raised'");
    // Released on every path — unlike quit, this process keeps running and the
    // next owner has to be able to launch. A fence left up after a completed
    // handover, or after an aborted one, would refuse its own durable runs.
    const release = teardown.indexOf('releaseBoundaryLaunchFence = null;');
    expect(release).toBeGreaterThan(sweep);
    const finallyBlock = teardown.lastIndexOf('} finally {', release);
    expect(finallyBlock).toBeGreaterThan(-1);
    expect(finallyBlock).toBeLessThan(release);
    // The abort path throws from inside that try, so the same finally covers
    // it. The acquisition now sits above the whole teardown, so its own
    // fail-closed throw is checked by the ordering case instead.
    expect(teardown.indexOf('throw new PiSubagentAccountBoundaryError(reason);'))
      .toBeLessThan(finallyBlock);
    // The suppression counter is process-global, so a throw must never skip its
    // release. That used to require the acquisition to sit inside the
    // suppression's try; now the acquisition happens before the suppression
    // exists at all, and its own try/finally is the outer one — so an
    // acquisition failure cannot leak a counter it has not taken yet, and every
    // later throw is inside both.
    const suppression = teardown.indexOf('const releaseEndedSuppression = beginSessionTurnEndedSuppression();');
    expect(suppression).toBeGreaterThan(raise);
    const suppressionTry = teardown.indexOf('try {', suppression);
    const suppressionRelease = teardown.indexOf('releaseEndedSuppression();');
    expect(suppressionTry).toBeLessThan(suppressionRelease);
    expect(teardown.lastIndexOf('} finally {', suppressionRelease)).toBeGreaterThan(suppressionTry);
    // And the fence's own finally wraps that one.
    expect(finallyBlock).toBeGreaterThan(suppressionRelease);
  });

  it('treats a PI session that would not detach as a failed reclaim', () => {
    // `Maker.shutdown` reports per-session detach failures instead of throwing,
    // so it can resolve with a PI process still alive — and that process owns
    // durable children holding BYOM credentials this account cannot revoke.
    // Resolving is not the same statement as "nothing survived".
    const teardown = source.slice(
      source.indexOf('async function teardownAuthAccountBoundary(reason: string)'),
    );
    const shutdown = teardown.indexOf("await maker.shutdown({ reason: 'account-boundary' })");
    const collect = teardown.indexOf("(shutdownReport?.sessionFailures ?? [])");
    const sweep = teardown.indexOf('const stopped = await stopAllPiSubagentRunsForExit(');
    const abort = teardown.indexOf('if (piSessionFailures.length > 0) {');
    expect(shutdown).toBeGreaterThan(-1);
    // Collected before the sweep, acted on after it: the sweep is still worth
    // running — best-effort reclaim has value — but it cannot make this go away.
    expect(collect).toBeGreaterThan(shutdown);
    expect(sweep).toBeGreaterThan(collect);
    expect(abort).toBeGreaterThan(sweep);
    expect(teardown.slice(collect, sweep)).toContain("failure.agentKind === 'pi'");
    // And the abort lands before the handover steps, like the sweep verdict does.
    expect(teardown.indexOf('resetMaker();', sweep)).toBeGreaterThan(abort);
    // Only PI escalates: it is filtered out of the report rather than read as
    // "something failed". Every other agent's children die with the parent, so
    // their detach failures stay non-fatal exactly as before.
    expect(teardown.slice(collect, sweep)).toContain('.filter(');
    expect(teardown.slice(abort)).toContain('(non-fatal)');
  });

  it('keeps the account-boundary sweep on the same escalation contract', () => {
    // Two entry points, one rule: the app going away and the account going away
    // are both "this runtime's children must not outlive it".
    const boundary = source.slice(
      source.indexOf('const stopped = await stopAllPiSubagentRunsForExit('),
    );
    expect(boundary.slice(0, 800)).toContain('killUnresponsiveRunners: true');
  });
});
