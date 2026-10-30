/**
 * pre-run-hook 执行器测试:exit code 协议(0 放行 / 2 跳过 / 其它 fail-closed)、
 * stdin JSON 上下文、超时拦截、输出捕获。
 * 全部用 `node -e` 保证 macOS / Windows 双平台可跑(shell:true 下 cmd.exe 只
 * 识别双引号,内嵌 JS 一律用单引号字符串)。
 *
 * @vitest-environment node
 */

import { describe, expect, it, vi } from 'vitest';

// 透传真实 spawn,只计数:用来断言某些路径根本没有启动真实命令。
const spawnCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: ((...args: Parameters<typeof actual.spawn>) => {
      spawnCalls.count += 1;
      return actual.spawn(...args);
    }) as typeof actual.spawn,
  };
});

import {
  assertPreRunHookCommandSyntax,
  executePreRunHook,
  findShellSyntaxError,
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
  it.each([0, 1, 2])('only successful exits can attest healthy checks (exit %s)', async (exitCode) => {
    const result = await executePreRunHook({
      command: `node -e "console.log('CINDY_PRECHECK_OK'); process.exit(${exitCode})"`,
      stdinPayload: payload,
    });
    expect(result.checkSucceeded).toBe(exitCode === 1 ? undefined : true);
  });
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
    expect(result.checkSucceeded).toBeUndefined();
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
      command: 'node -e "console.log(\'to-out\');console.error(\'to-err\');process.exit(0)"',
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

  it.skipIf(process.platform === 'win32')(
    'shell 语法错误(sh 退出码同为 2)按失败阻止,不当成跳过',
    async () => {
      const result = await executePreRunHook({
        // 2026-10 真实事故:单引号没配平,sh 以 2 退出,被误记为"本轮跳过"
        command: `node -e "process.exit(0)" '//`,
        stdinPayload: payload,
      });
      expect(result.status).toBe('failed');
      expect(result.decision).toBe('block');
      expect(result.error).toMatch(/^shell syntax error in command: /);
      expect(result.stderr).not.toBe('');
      expect(formatPreRunHookFailure(result)).toContain('shell syntax error');
    },
  );

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

describe.skipIf(process.platform === 'win32')('前置检查命令语法预检', () => {
  it('语法正确的命令(含引号路径、管道、heredoc)不报错,且不会被执行', async () => {
    await expect(findShellSyntaxError(`node '/a b/x.mjs' --flag`)).resolves.toBeUndefined();
    await expect(findShellSyntaxError('git fetch -q && python3 - scan <<EOF\nx\nEOF')).resolves.toBeUndefined();
    // -n 只解析:即使命令会失败也不报语法错误
    await expect(findShellSyntaxError('exit 7')).resolves.toBeUndefined();
  });

  it('引号未配平 / 结构未闭合 → 返回 shell 报错', async () => {
    await expect(findShellSyntaxError(`node '/a b/x.mjs'//'`)).resolves.toBeTruthy();
    await expect(findShellSyntaxError('if true; then echo')).resolves.toBeTruthy();
  });

  it('命令含 NUL:预检不同步抛错,执行仍折叠成失败结果', async () => {
    await expect(findShellSyntaxError('node -e "1"\0')).resolves.toBeUndefined();
    const result = await executePreRunHook({ command: 'node -e "1"\0', stdinPayload: payload });
    expect(result.status).toBe('failed');
    expect(result.decision).toBe('block');
    expect(result.spawnError || result.error).toBeTruthy();
  });

  it('预检耗尽超时预算 → 直接 timed_out,不再启动真实命令', async () => {
    spawnCalls.count = 0;
    const result = await executePreRunHook({
      command: 'node -e "process.exit(0)"',
      timeoutMs: 1,
      stdinPayload: payload,
    });
    expect(result.status).toBe('timed_out');
    expect(result.decision).toBe('block');
    expect(result.timedOut).toBe(true);
    expect(spawnCalls.count).toBe(0);
  });

  it('预检响应取消信号:已取消时不再预检,执行返回 aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(findShellSyntaxError(`node '/a b/x.mjs'//'`, { signal: controller.signal }))
      .resolves.toBeUndefined();
  });

  it('保存时校验:语法错误抛 invalid,正确命令放行', async () => {
    await expect(assertPreRunHookCommandSyntax(`node '/a b/x.mjs'//'`)).rejects.toThrow(
      /^invalid pre-run hook configuration: shell syntax error in command: /,
    );
    await expect(assertPreRunHookCommandSyntax(`xdt-node '/a b/x.mjs'`)).resolves.toBeUndefined();
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
