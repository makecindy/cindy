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
