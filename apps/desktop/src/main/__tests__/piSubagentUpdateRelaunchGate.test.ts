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

const source = readSourceNormalized('../updateService.ts');
const macScript = readSourceNormalized('../updateScriptMacOS.ts');

/**
 * An update relaunch is the same credential boundary as quit: this process is
 * about to be replaced, and a runner it cannot confirm stopped keeps running on
 * the BYOM credentials it inherited, with the relaunched app holding no handle
 * to it.
 */
describe('PI Subagent reclaim before an update relaunch', () => {
  it('reclaims with the escalation scope on a bounded budget', () => {
    const reclaim = source.slice(
      source.indexOf('async function reclaimSubagentRunnersOnce('),
      source.indexOf('async function reclaimSubagentRunnersForRelaunch()'),
    );
    expect(reclaim).toContain('killUnresponsiveRunners: true');
    expect(reclaim).toContain('hostPid: process.pid');
    expect(reclaim).toMatch(/stopAllPiSubagentRunsForExit\(agentHome, 2_000,/);
    // A hard ceiling, so a wedged probe cannot hold the update open — and the
    // catch keeps any throw from reaching a native dialog.
    expect(reclaim).toContain('Promise.race([');
    expect(reclaim).toContain('setTimeout(() => resolve(false), 4_000)');
    expect(reclaim).toContain('catch (err)');
  });

  it('reclaims until the agent home is stable, not just until one pass succeeds', () => {
    // The parent task keeps running while the gate works, so it can launch
    // another durable runner between the last scan and process.exit — that one
    // would survive the update holding credentials nobody is left to revoke.
    const loop = source.slice(
      source.indexOf('async function reclaimSubagentRunnersForRelaunch()'),
      source.indexOf('async function executeRelaunch('),
    );
    expect(loop).toContain('SUBAGENT_RECLAIM_MAX_ROUNDS');
    // A pass that succeeds is not the verdict; the re-scan after it is.
    expect(loop).toMatch(/if \(!await reclaimSubagentRunnersOnce\(agentHome\)\) return false;/);
    expect(loop).toContain('hasActivePiSubagentRunsSync(agentHome, { hostPid: process.pid })');
    expect(loop).toMatch(/if \(!stillActive\) return true;/);
    // Out of rounds or out of time is a refusal, never a silent pass.
    const tail = loop.slice(loop.lastIndexOf('if (Date.now() >= deadline) break;'));
    expect(tail).toContain('return false;');
    expect(source).toContain('const SUBAGENT_RECLAIM_TOTAL_MS = 6_000;');
  });

  it('raises a cross-process fence before the first sweep and drops it on refusal', () => {
    // Re-scanning can only narrow the window; the spawn it must prevent happens
    // inside the Pi process. The fence is what actually closes it.
    const loop = source.slice(
      source.indexOf('async function reclaimSubagentRunnersForRelaunch()'),
      source.indexOf('async function executeRelaunch('),
    );
    const fence = loop.indexOf('acquirePiSubagentLaunchFence(agentHome)');
    const firstSweep = loop.indexOf('reclaimSubagentRunnersOnce(agentHome)');
    expect(fence).toBeGreaterThan(-1);
    expect(firstSweep).toBeGreaterThan(fence);
    // A fence we could not raise is a refusal, not a silent pass.
    expect(loop).toContain('if (!releaseSubagentLaunchFence) return false;');
    // Every non-exit path takes it down again, or this host could never launch
    // a Subagent afterwards.
    const wrapper = source.slice(
      source.indexOf('async function executeRelaunch('),
      source.indexOf('async function executeRelaunchUnguarded('),
    );
    expect(wrapper).toMatch(/finally \{[\s\S]*clearSubagentLaunchFence\(\)/);
  });

  it('drops the fence on the failures that land after the executor returned', () => {
    // The Windows executor registers its `error` and 5s spawn-timeout callbacks
    // and returns immediately, so `isRelaunching` was still true when the outer
    // `finally` tested it and the fence was skipped. It then stood for the rest
    // of the process's life and every durable Subagent launch was refused as
    // "Cindy is restarting". Both callbacks — and every synchronous refusal —
    // converge on `handleApplyFailure`, which is where the release belongs.
    const handler = source.slice(
      source.indexOf('function handleApplyFailure(reason: string): void {'),
    );
    const body = handler.slice(0, handler.indexOf("setStatus('error'"));
    expect(body).toContain('clearSubagentLaunchFence()');
    // The two asynchronous exits really do route here.
    const windows = source.slice(
      source.indexOf('function executeUpdateWindows('),
      source.indexOf('function executeUpdateMacOS('),
    );
    expect(windows).toContain("handleApplyFailure('spawn_timeout');");
    expect(windows).toContain("handleApplyFailure(err.code ?? 'unknown');");
    // And the success path does not: a spawned updater force-quits, and the
    // fence is meant to stand until the process is gone.
    const spawned = windows.slice(windows.indexOf("child.on('spawn'"), windows.indexOf("child.on('error'"));
    expect(spawned).toContain('forceQuit();');
    expect(spawned).not.toContain('handleApplyFailure');
    // Still released through the lease-aware entry point, never a bare unlink.
    expect(body).not.toContain('fs.rm');
    expect(source).toContain('async function clearSubagentLaunchFence(): Promise<void> {');
  });

  it('gates before the updater is spawned, because a later refusal is not one', () => {
    // The spawned updater polls our pid and SIGKILLs it; deciding not to exit
    // after that point does not keep this process alive.
    expect(macScript).toContain('exitKillAfterSeconds');
    const relaunch = source.slice(source.indexOf('async function executeRelaunch('));
    const gate = relaunch.indexOf('if (!await reclaimSubagentRunnersForRelaunch())');
    const attempts = relaunch.indexOf('incrementApplyAttempts();');
    const windows = relaunch.indexOf('executeUpdateWindows(readyFilePath, theme);');
    const mac = relaunch.indexOf('executeUpdateMacOS(readyFilePath);');
    expect(gate).toBeGreaterThan(-1);
    expect(attempts).toBeGreaterThan(gate);
    expect(windows).toBeGreaterThan(gate);
    expect(mac).toBeGreaterThan(gate);
  });

  it('cancels the relaunch instead of exiting when the reclaim is unconfirmed', () => {
    const relaunch = source.slice(source.indexOf('async function executeRelaunch('));
    const gate = relaunch.indexOf('if (!await reclaimSubagentRunnersForRelaunch())');
    const branch = relaunch.slice(gate, relaunch.indexOf('incrementApplyAttempts();', gate));
    // Propagated to the renderer as a failed update, so the user can retry.
    expect(branch).toContain("handleApplyFailure('subagent_reclaim_unconfirmed')");
    expect(branch).toContain('return;');
    expect(branch).toMatch(/could not be confirmed stopped/);
  });

  it('never rejects, because both entry points are fire-and-forget', () => {
    // Async + `void` means any throw is an unhandled rejection, which vitest
    // fails the whole run on and production turns into a silent dead end.
    expect(source).toContain('async function executeRelaunch(');
    const wrapper = source.slice(
      source.indexOf('async function executeRelaunch('),
      source.indexOf('async function executeRelaunchUnguarded('),
    );
    expect(wrapper).toMatch(/try \{\s*await executeRelaunchUnguarded\(theme\);\s*\} catch/);
    expect(wrapper).toContain("handleApplyFailure('relaunch_failed')");
    // The gate and everything after it live in the guarded body.
    const guarded = source.slice(source.indexOf('async function executeRelaunchUnguarded('));
    expect(guarded.indexOf('reclaimSubagentRunnersForRelaunch()')).toBeGreaterThan(-1);
    expect(guarded.indexOf('fs.statSync(readyFilePath).size')).toBeGreaterThan(-1);
  });

  it('keeps every relaunch entry point on the awaited path', () => {
    // `executeRelaunch` is now async; a forgotten `void` would silently drop
    // the gate's rejection handling.
    expect([...source.matchAll(/(?<!void )executeRelaunch\(resolved\)/g)]).toHaveLength(0);
    expect([...source.matchAll(/(?<!void )executeRelaunch\(theme\)/g)]).toHaveLength(0);
    expect(source).toContain('void executeRelaunch(resolved);');
    expect(source).toContain('void executeRelaunch(theme);');
  });
});
