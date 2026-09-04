/**
 * pre-run-hook 执行器测试:exit code 协议(0 放行 / 2 跳过 / 其它 fail-closed)、
 * stdin JSON 上下文、超时拦截、输出捕获。
 * 全部用 `node -e` 保证 macOS / Windows 双平台可跑(shell:true 下 cmd.exe 只
 * 识别双引号,内嵌 JS 一律用单引号字符串)。
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';

import {
  buildSkipResultText,
  executePreRunHook,
  formatPreRunHookFailure,
  resolvePreRunHookTimeoutMs,
  type PreRunHookStdinPayload,
} from '../pre-run-hook';

const payload: PreRunHookStdinPayload = {
  event: 'schedule-pre-run',
  scheduleId: 's1',
  scheduleName: 'test schedule',
  runId: 'r1',
  firedAt: 1_700_000_000_000,
  workingDir: undefined,
};

describe('executePreRunHook', () => {
  it('exit 0 → decision run', async () => {
    const result = await executePreRunHook({
      command: 'node -e "process.exit(0)"',
      stdinPayload: payload,
    });
    expect(result.decision).toBe('run');
    expect(result.status).toBe('passed');
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.spawnError).toBeUndefined();
  });

  it('exit 2 → decision skip', async () => {
    const result = await executePreRunHook({
      command: 'node -e "process.exit(2)"',
      stdinPayload: payload,
    });
    expect(result.decision).toBe('skip');
    expect(result.status).toBe('skipped');
    expect(result.exitCode).toBe(2);
  });

  it('其它退出码 fail-closed → decision block', async () => {
    const result = await executePreRunHook({
      command: 'node -e "process.exit(3)"',
      stdinPayload: payload,
    });
    expect(result.decision).toBe('block');
    expect(result.status).toBe('failed');
    expect(result.exitCode).toBe(3);
  });

  it('stdin 能读到 JSON 上下文(按 scheduleId 决策)', async () => {
    const js =
      "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const j=JSON.parse(d);console.log('sid='+j.scheduleId);process.exit(j.scheduleId==='s1'?2:0)})";
    const result = await executePreRunHook({
      command: `node -e "${js}"`,
      stdinPayload: payload,
    });
    expect(result.decision).toBe('skip');
    expect(result.stdout).toContain('sid=s1');
  });

  it('超时 fail-closed → decision block + timedOut', async () => {
    const result = await executePreRunHook({
      command: 'node -e "setTimeout(function(){process.exit(2)},30000)"',
      timeoutMs: 400,
      stdinPayload: payload,
    });
    expect(result.timedOut).toBe(true);
    expect(result.decision).toBe('block');
    expect(result.status).toBe('timed_out');
  }, 15_000);

  it('命令不存在(shell 报错退出)fail-closed → decision block', async () => {
    const result = await executePreRunHook({
      command: 'definitely-not-a-real-command-xdmaker-test',
      stdinPayload: payload,
    });
    expect(result.decision).toBe('block');
    expect(result.status).toBe('failed');
    expect(result.exitCode).not.toBe(2);
  });

  it('stdout / stderr 分别捕获', async () => {
    const result = await executePreRunHook({
      command: "node -e \"console.log('to-out');console.error('to-err');process.exit(0)\"",
      stdinPayload: payload,
    });
    expect(result.stdout).toContain('to-out');
    expect(result.stderr).toContain('to-err');
  });

  it('JavaScript 语法错误会阻止执行', async () => {
    const result = await executePreRunHook({
      command: 'node -e "const ="',
      stdinPayload: payload,
    });
    expect(result.status).toBe('failed');
    expect(result.decision).toBe('block');
    expect(result.exitCode).not.toBe(0);
  });

  it('spawn 失败会保留启动错误并阻止执行', async () => {
    const result = await executePreRunHook({
      command: 'node -e "process.exit(0)"',
      cwd: 'Z:/definitely/not/a/real/pre-run-hook-directory',
      stdinPayload: payload,
    });
    expect(result.status).toBe('failed');
    expect(result.decision).toBe('block');
    expect(result.spawnError || result.error).toBeTruthy();
  });

  it('stdout 超过 8KB 会截断并留下标记', async () => {
    const result = await executePreRunHook({
      command: 'node -e "process.stdout.write(\'x\'.repeat(9000))"',
      stdinPayload: payload,
    });
    expect(result.status).toBe('passed');
    expect(result.stdout).toHaveLength(8 * 1024);
    expect(result.stdoutTruncated).toBe(true);
  });

  it('信号已 abort(任务已 pause/delete)→ 不 spawn 直接返回 aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await executePreRunHook({
      command: 'node -e "process.exit(2)"',
      signal: controller.signal,
      stdinPayload: payload,
    });
    expect(result.aborted).toBe(true);
    expect(result.status).toBe('aborted');
    expect(result.decision).toBe('block');
    expect(result.exitCode).toBeNull();
  });

  it('执行中 abort → 树杀进程并及时 settle(不等满超时)', async () => {
    const controller = new AbortController();
    const startedAt = Date.now();
    const pending = executePreRunHook({
      command: 'node -e "setTimeout(function(){process.exit(2)},30000)"',
      timeoutMs: 60_000,
      signal: controller.signal,
      stdinPayload: payload,
    });
    setTimeout(() => controller.abort(), 300);
    const result = await pending;
    expect(result.aborted).toBe(true);
    expect(result.status).toBe('aborted');
    expect(result.decision).toBe('block');
    // 树杀 + 1s 强制 settle 兜底:远小于 60s 超时即返回
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  }, 15_000);
});

describe('formatPreRunHookFailure', () => {
  it('失败摘要是人话，不含 pre-run hook', () => {
    expect(
      formatPreRunHookFailure({
        status: 'failed',
        decision: 'block',
        exitCode: 1,
        durationMs: 10,
        stdout: '',
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
        timedOut: false,
        aborted: false,
      }),
    ).toBe('前置检查失败（exit 1）');
  });
});

describe('buildSkipResultText', () => {
  const hook = {
    status: 'skipped' as const,
    decision: 'skip' as const,
    exitCode: 2,
    durationMs: 125,
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    aborted: false,
  };

  it('有 stdout 时用人话全文，不加机器前缀', () => {
    const text = buildSkipResultText({
      ...hook,
      stdout: 'Worktree 跟上轮一致，没清。\n',
    });
    expect(text).toBe('Worktree 跟上轮一致，没清。');
    expect(text).not.toContain('pre-run hook exit');
  });

  it('空 stdout 时仍给一行人话', () => {
    const text = buildSkipResultText(hook);
    expect(text).toContain('本轮跳过');
    expect(text).not.toContain('pre-run hook exit');
  });
});

describe('resolvePreRunHookTimeoutMs(无默认超时)', () => {
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
});

describe('resolveHookCommand(xdt-node 前缀解析)', () => {
  it('xdt-node 前缀 → 替换为当前运行时 execPath + ELECTRON_RUN_AS_NODE', async () => {
    const { resolveHookCommand } = await import('../pre-run-hook');
    const resolved = resolveHookCommand('xdt-node "C:/x/check.mjs"');
    expect(resolved.command).toBe(`"${process.execPath}" "C:/x/check.mjs"`);
    expect(resolved.extraEnv).toEqual({ ELECTRON_RUN_AS_NODE: '1' });
  });

  it('普通命令原样透传,无额外 env', async () => {
    const { resolveHookCommand } = await import('../pre-run-hook');
    const resolved = resolveHookCommand('node check.mjs');
    expect(resolved.command).toBe('node check.mjs');
    expect(resolved.extraEnv).toEqual({});
  });

  it('端到端:xdt-node 命令真实执行(测试环境 execPath 即 node)→ exit 2 = skip', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const pathMod = await import('node:path');
    const dir = mkdtempSync(pathMod.join(tmpdir(), 'xdt-node-hook-'));
    try {
      const script = pathMod.join(dir, 'gate.mjs');
      writeFileSync(script, 'process.exit(2)\n', 'utf8');
      const result = await executePreRunHook({
        command: `xdt-node "${script}"`,
        stdinPayload: payload,
      });
      expect(result.decision).toBe('skip');
      expect(result.exitCode).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
