import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../bootstrap-electron.ts', import.meta.url), 'utf8');

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

  it('keeps the account-boundary sweep on the same escalation contract', () => {
    // Two entry points, one rule: the app going away and the account going away
    // are both "this runtime's children must not outlive it".
    const boundary = source.slice(
      source.indexOf('const stopped = await stopAllPiSubagentRunsForExit('),
    );
    expect(boundary.slice(0, 800)).toContain('killUnresponsiveRunners: true');
  });
});
