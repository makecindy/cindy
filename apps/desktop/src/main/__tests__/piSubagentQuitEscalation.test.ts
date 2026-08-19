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
    // Failing to raise it must not block a logout.
    expect(teardown.slice(raise, shutdown)).toMatch(/authBoundaryLog\.warn/);
    // Released on every path — unlike quit, this process keeps running and the
    // next owner has to be able to launch. A fence left up after a completed
    // handover, or after an aborted one, would refuse its own durable runs.
    const release = teardown.indexOf('releaseBoundaryLaunchFence = null;');
    expect(release).toBeGreaterThan(sweep);
    const finallyBlock = teardown.lastIndexOf('} finally {', release);
    expect(finallyBlock).toBeGreaterThan(-1);
    expect(finallyBlock).toBeLessThan(release);
    // The abort path throws from inside that try, so the same finally covers it.
    expect(teardown.indexOf('throw new PiSubagentAccountBoundaryError(reason);'))
      .toBeLessThan(finallyBlock);
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
