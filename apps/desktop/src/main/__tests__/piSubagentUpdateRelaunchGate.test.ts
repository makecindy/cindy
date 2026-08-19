import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../updateService.ts', import.meta.url), 'utf8');
const macScript = readFileSync(new URL('../updateScriptMacOS.ts', import.meta.url), 'utf8');

/**
 * An update relaunch is the same credential boundary as quit: this process is
 * about to be replaced, and a runner it cannot confirm stopped keeps running on
 * the BYOM credentials it inherited, with the relaunched app holding no handle
 * to it.
 */
describe('PI Subagent reclaim before an update relaunch', () => {
  it('reclaims with the escalation scope on a bounded budget', () => {
    const reclaim = source.slice(
      source.indexOf('async function reclaimSubagentRunnersForRelaunch()'),
      source.indexOf('async function executeRelaunch('),
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

  it('keeps every relaunch entry point on the awaited path', () => {
    // `executeRelaunch` is now async; a forgotten `void` would silently drop
    // the gate's rejection handling.
    expect([...source.matchAll(/(?<!void )executeRelaunch\(resolved\)/g)]).toHaveLength(0);
    expect([...source.matchAll(/(?<!void )executeRelaunch\(theme\)/g)]).toHaveLength(0);
    expect(source).toContain('void executeRelaunch(resolved);');
    expect(source).toContain('void executeRelaunch(theme);');
  });
});
