/** Default unit coverage: pure contracts and one real Node/stdin smoke. */
import { describe, expect, it, vi } from 'vitest';
import { executePreRunHook, resolveHookCommand, resolvePreRunHookTimeoutMs } from '../pre-run-hook';
import { readPreRunNodeReport } from '../pre-run-node';

vi.mock('electron', () => ({ app: { getPreferredSystemLanguages: () => ['en'] } }));

const payload = {
  event: 'schedule-pre-run' as const,
  scheduleId: 's1', scheduleName: 'smoke', runId: 'r1', firedAt: 1_700_000_000_000,
};

describe('pre-run hook unit contracts', () => {
  it.each([0, 2])('accepts completed protocol only with matching native exits (%s)', (code) => {
    const report = { version: 1, entered: true, completed: code, nodeExit: code, shellExit: code, valid: true };
    expect(readPreRunNodeReport(JSON.stringify(report), code)).toEqual(report);
  });

  it.each([
    { entered: false }, { completed: -1 }, { nodeExit: 1 }, { shellExit: 2 }, { version: 2 },
  ])('rejects inconsistent completion %j', (override) => {
    const report = { version: 1, entered: true, completed: 0, nodeExit: 0, shellExit: 0, valid: true, ...override };
    expect(readPreRunNodeReport(JSON.stringify(report), 0)).toBeUndefined();
  });

  it('rejects absent, malformed, oversized or independently failed supervisor reports', () => {
    for (const text of ['', 'null', 'not JSON', 'x'.repeat(1025)]) expect(readPreRunNodeReport(text, 0)).toBeUndefined();
    expect(readPreRunNodeReport(JSON.stringify({ version: 1, entered: true, completed: 0, nodeExit: 0, shellExit: 0, valid: true }), 125)).toBeUndefined();
  });

  it('未传 / 非法 / ≤0 → undefined(不限时,不回落任何默认值)', () => {
    expect(resolvePreRunHookTimeoutMs(undefined)).toBeUndefined();
    expect(resolvePreRunHookTimeoutMs(Number.NaN)).toBeUndefined();
    expect(resolvePreRunHookTimeoutMs(0)).toBeUndefined();
    expect(resolvePreRunHookTimeoutMs(-5)).toBeUndefined();
  });

  it('显式正数原样生效(取整,无上限钳制)', () => {
    expect(resolvePreRunHookTimeoutMs(400.9)).toBe(400);
    expect(resolvePreRunHookTimeoutMs(10 * 60_000)).toBe(10 * 60_000);
  });

  it('普通命令原样透传,无额外 env', () => {
    expect(resolveHookCommand('node check.mjs')).toEqual({ command: 'node check.mjs', extraEnv: {} });
  });

  it('already aborted calls block before spawning', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await executePreRunHook({ command: 'node check.mjs', signal: controller.signal, stdinPayload: payload });
    expect(result.status).toBe('aborted');
    expect(result.decision).toBe('block');
    expect(result.exitCode).toBeNull();
  });

  it('real Node smoke reads JSON stdin and returns the successful quiet protocol', async () => {
    const script = "let data='';process.stdin.on('data',chunk=>data+=chunk);process.stdin.on('end',()=>{console.log(JSON.parse(data).scheduleId);console.log('CINDY_PRECHECK_OK')})";
    const result = await executePreRunHook({
      command: '"' + process.execPath + '" -e "' + script + '"', stdinPayload: payload, timeoutMs: 5_000,
    });
    expect(result.status).toBe('passed');
    expect(result.decision).toBe('run');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('s1\nCINDY_PRECHECK_OK\n');
    expect(result.stderr).toBe('');
    expect(result.checkSucceeded).toBe(true);
  });
});
