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
    // 稳定的一次扫描才是结论。而 PI 后台命令的清扫必须在这一支里(确实要重启),
    // 不能提到函数开头:上面任何一条 return false 都会取消重启,那时杀掉用户正在跑的
    // dev server / 长构建是白杀。
    const stableStart = loop.indexOf('if (!stillActive) {');
    const stableEnd = loop.indexOf('return true;', stableStart);
    expect(stableStart).toBeGreaterThan(-1);
    expect(stableEnd).toBeGreaterThan(stableStart);
    expect(loop.slice(stableStart, stableEnd)).toContain('stopAllPiBackgroundCommandsForExit(');
    // Out of rounds or out of time is a refusal, never a silent pass.
    const tail = loop.slice(loop.lastIndexOf('if (Date.now() >= deadline) break;'));
    expect(tail).toContain('return false;');
    expect(source).toContain('const SUBAGENT_RECLAIM_TOTAL_MS = 6_000;');
  });

  it('cancels the relaunch when background commands cannot be confirmed stopped', () => {
    const reclaim = source.slice(
      source.indexOf('async function reclaimSubagentRunnersForRelaunch()'),
      source.indexOf('async function executeRelaunch('),
    );
    // 与 subagent 同口径 fail closed:确认不了退出就不放行重启 —— 那些是 detached
    // 进程组,会带着旧版本 env 活到新版本旁边、占着端口与锁。
    const sweepStart = reclaim.indexOf('stopAllPiBackgroundCommandsForExit(');
    expect(sweepStart).toBeGreaterThan(-1);
    const afterSweep = reclaim.slice(sweepStart);
    expect(afterSweep).toMatch(/if \(unconfirmed > 0\)/);
    expect(afterSweep).toContain('return false;');
    // 读不到结果(sweep 抛错)同样按未确认处理:初值必须是"未确认",不能是 0。
    expect(reclaim).toMatch(/let unconfirmed = 1;/);
  });

  it('sweeps PI background commands synchronously inside forceQuit', () => {
    const forceQuitBody = source.slice(
      source.indexOf('function forceQuit('),
      source.indexOf('function executeUpdateMacOS('),
    );
    // forceQuit 绕过 lifecycle 的 before-quit 链,bootstrap 的异步清扫不会跑;
    // 后台命令是 detached 进程组,父进程退出带不走它们。这里必须与 subagent 的
    // requestStopAllPiSubagentRunsSync 一样做同步收口 —— 覆盖「reclaim 扫过之后、
    // process.exit(0) 之前」那段父 Pi 会话仍活着、还能起新命令的窗口。
    expect(forceQuitBody).toContain('requestStopAllPiSubagentRunsSync(');
    expect(forceQuitBody).toContain('stopAllPiBackgroundCommandsForExitSync(');
    // 同步收口不得 await(会卡住 updater 的 pid 轮询、拖延重启)。
    expect(forceQuitBody).not.toMatch(/await stopAllPiBackgroundCommandsForExitSync\(/);
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
    // 归因必须区分两条防线:后台命令清扫挡住时报 background,否则报 subagent
    // (用户按错误码去查的时候不能指错地方)。
    expect(branch).toContain("relaunchReclaimBlockedBy === 'background'");
    expect(branch).toContain("'pi_background_commands_unconfirmed'");
    expect(branch).toContain("'subagent_reclaim_unconfirmed'");
    expect(source).toContain("relaunchReclaimBlockedBy = 'background';");
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
    expect(wrapper).toMatch(/try \{\s*await executeRelaunchUnguarded\(theme, checkForBinaryUpdates\);\s*\} catch/);
    expect(wrapper).toContain("handleApplyFailure('relaunch_failed')");
    // The gate and everything after it live in the guarded body.
    const guarded = source.slice(source.indexOf('async function executeRelaunchUnguarded('));
    expect(guarded.indexOf('reclaimSubagentRunnersForRelaunch()')).toBeGreaterThan(-1);
    expect(guarded.indexOf('fs.statSync(readyFilePath).size')).toBeGreaterThan(-1);
  });

  it('keeps every relaunch entry point on the awaited path', () => {
    // `executeRelaunch` is now async; a forgotten `void` would silently drop
    // the gate's rejection handling.
    expect([...source.matchAll(/(?<!void )executeRelaunch\((?:resolved|theme)(?:,[^)]*)?\)/g)]).toHaveLength(0);
    expect(source).toContain('void executeRelaunch(resolved, true);');
    expect(source).toContain('void executeRelaunch(theme);');
  });
});
