import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => ''),
    isPackaged: false,
  },
}));

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../maker-host/logger-adapter.js', () => ({
  desktopMakerLogger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
    }),
  },
}));

const osMock = vi.hoisted(() => ({
  setPriority: vi.fn(),
}));
vi.mock('node:os', () => {
  const constants = { priority: { PRIORITY_BELOW_NORMAL: 10, PRIORITY_LOW: 19, PRIORITY_NORMAL: 0 } };
  return {
    default: { setPriority: osMock.setPriority, constants },
    setPriority: osMock.setPriority,
    constants,
  };
});

import { allUserDataDirNames } from '@cindy/maker-shared/brand-identity';

import {
  __testing,
  classifyAgentCommandLine,
  createAgentProcessPriorityWatcher,
  parsePosixAgentProcesses,
  registerUserDataMarkers,
  type AgentProcessRow,
  type ApplyPriorityResult,
} from '../agent-process-priority';
import type { AgentProcessPriority } from '../maker-host/agent-resource-settings-store';
import { CURRENT_CINDY_REGION } from '../../shared/brandRegion.js';

const fakeLog = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };

function makeWatcher(opts: {
  priority: () => AgentProcessPriority;
  rows: () => AgentProcessRow[];
  applyResult?: (pid: number) => ApplyPriorityResult;
}) {
  const scan = vi.fn(async () => opts.rows());
  const apply = vi.fn(
    async (
      pid: number,
      _tier: AgentProcessPriority,
      _prev: AgentProcessPriority | undefined,
    ): Promise<ApplyPriorityResult> => (opts.applyResult ? opts.applyResult(pid) : 'applied'),
  );
  const watcher = createAgentProcessPriorityWatcher({
    readPriority: opts.priority,
    scanAgentProcesses: scan,
    applyPriority: apply,
    log: fakeLog,
  });
  return { watcher, scan, apply };
}

describe('agent process priority watcher', () => {
  it('does not even scan when priority is normal and nothing was touched', async () => {
    const { watcher, scan, apply } = makeWatcher({
      priority: () => 'normal',
      rows: () => [{ pid: 1, kind: 'claude' }],
    });
    await watcher.tickOnce();
    expect(scan).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  it('lowers discovered agent processes once and does not re-apply the same tier', async () => {
    const { watcher, apply } = makeWatcher({
      priority: () => 'low',
      rows: () => [
        { pid: 11, kind: 'claude' },
        { pid: 22, kind: 'codex' },
      ],
    });
    await watcher.tickOnce();
    expect(apply).toHaveBeenCalledTimes(2);
    expect(apply).toHaveBeenCalledWith(11, 'low', undefined);
    expect(apply).toHaveBeenCalledWith(22, 'low', undefined);

    await watcher.tickOnce();
    expect(apply).toHaveBeenCalledTimes(2); // 已在目标档,不重复调
  });

  it('re-applies when the tier changes and passes the previous tier through', async () => {
    let tier: AgentProcessPriority = 'lowest';
    const { watcher, apply } = makeWatcher({
      priority: () => tier,
      rows: () => [{ pid: 11, kind: 'claude' }],
    });
    await watcher.tickOnce();
    expect(apply).toHaveBeenLastCalledWith(11, 'lowest', undefined);

    tier = 'low';
    await watcher.tickOnce();
    // prevTier='lowest' 让实现知道要清 macOS taskpolicy 背景钳制
    expect(apply).toHaveBeenLastCalledWith(11, 'low', 'lowest');
  });

  it('restores only processes it previously touched when switching back to normal', async () => {
    let tier: AgentProcessPriority = 'low';
    let rows: AgentProcessRow[] = [{ pid: 11, kind: 'claude' }];
    const { watcher, apply, scan } = makeWatcher({ priority: () => tier, rows: () => rows });
    await watcher.tickOnce();

    tier = 'normal';
    rows = [
      { pid: 11, kind: 'claude' },
      { pid: 33, kind: 'claude' }, // 从未被动过的进程,normal 下绝不碰
    ];
    await watcher.tickOnce();
    expect(apply).toHaveBeenCalledTimes(2);
    expect(apply).toHaveBeenLastCalledWith(11, 'normal', 'low');

    // 恢复完成后账本清空 → 回到零成本快路径
    const scanCallsSoFar = scan.mock.calls.length;
    await watcher.tickOnce();
    expect(scan.mock.calls.length).toBe(scanCallsSoFar);
  });

  it('drops processes that disappeared and ones apply reports as gone', async () => {
    let rows: AgentProcessRow[] = [
      { pid: 11, kind: 'claude' },
      { pid: 22, kind: 'codex' },
    ];
    const { watcher, apply } = makeWatcher({
      priority: () => 'low',
      rows: () => rows,
      applyResult: (pid) => (pid === 22 ? 'process-gone' : 'applied'), // 22 在 apply 时已退出
    });
    await watcher.tickOnce();
    expect(apply).toHaveBeenCalledTimes(2);

    // 22 未入账 → 再次出现会重试;11 已入账不重试
    await watcher.tickOnce();
    expect(apply).toHaveBeenCalledTimes(3);
    expect(apply).toHaveBeenLastCalledWith(22, 'low', undefined);

    // 11 退出后从账本移除;若再回来(pid 复用)会重新降档
    rows = [];
    await watcher.tickOnce();
    rows = [{ pid: 11, kind: 'claude' }];
    await watcher.tickOnce();
    expect(apply).toHaveBeenLastCalledWith(11, 'low', undefined);
  });

  it('records nice-stuck raises truthfully and does not retry them every tick', async () => {
    // lowest → low 是 POSIX 升档:nice 卡在 19,只有钳制被调整
    let tier: AgentProcessPriority = 'lowest';
    const { watcher, apply } = makeWatcher({
      priority: () => tier,
      rows: () => [{ pid: 11, kind: 'claude' }],
      applyResult: () => (tier === 'low' ? 'nice-raise-refused' : 'applied'),
    });
    await watcher.tickOnce();
    expect(fakeLog.info).toHaveBeenCalledWith(
      'agent process priority lowered',
      expect.objectContaining({ pid: 11, tier: 'lowest' }),
    );

    tier = 'low';
    fakeLog.info.mockClear();
    await watcher.tickOnce();
    // 不写"lowered"假成功日志,改记 warn 说明 nice 卡档
    expect(fakeLog.info).not.toHaveBeenCalledWith(
      'agent process priority lowered',
      expect.anything(),
    );
    expect(fakeLog.warn).toHaveBeenCalledWith(
      expect.stringContaining('nice stuck'),
      expect.objectContaining({ pid: 11, requestedTier: 'low', stuckAtTier: 'lowest' }),
    );

    // 已按目标档入账:下一 tick 不再空转重试
    const applyCalls = apply.mock.calls.length;
    await watcher.tickOnce();
    expect(apply.mock.calls.length).toBe(applyCalls);
  });

  it('survives a throwing scan without breaking later ticks', async () => {
    let shouldThrow = true;
    const apply = vi.fn(async (): Promise<ApplyPriorityResult> => 'applied');
    const watcher = createAgentProcessPriorityWatcher({
      readPriority: () => 'low',
      scanAgentProcesses: async () => {
        if (shouldThrow) throw new Error('ps blew up');
        return [{ pid: 11, kind: 'claude' as const }];
      },
      applyPriority: apply,
      log: fakeLog,
    });
    await watcher.tickOnce();
    expect(fakeLog.warn).toHaveBeenCalled();
    shouldThrow = false;
    await watcher.tickOnce();
    expect(apply).toHaveBeenCalledWith(11, 'low', undefined);
  });
});

describe('agent process discovery', () => {
  // userData 目录名按当前构建区域取(测试环境默认 global → CindyGlobal),不写死区域
  const userDataDir = allUserDataDirNames(CURRENT_CINDY_REGION)[0].toLowerCase();
  const claudeCmd = `/users/me/library/application support/${userDataDir}/claude-code/2.1.219/claude --setting-sources user`;
  const codexCmd = `/users/me/library/application support/${userDataDir}/codex/0.145.0/codex app-server`;
  const devClaudeCmd = '/repo/apps/claude-code-bin/darwin-arm64/claude';
  const externalClaudeCmd = '/usr/local/bin/claude';

  it('classifies bundled claude/codex command lines and rejects external installs', () => {
    expect(classifyAgentCommandLine(claudeCmd)).toBe('claude');
    expect(classifyAgentCommandLine(codexCmd)).toBe('codex');
    expect(classifyAgentCommandLine(devClaudeCmd)).toBe('claude');
    expect(classifyAgentCommandLine(externalClaudeCmd)).toBeNull();
    expect(classifyAgentCommandLine('/usr/bin/node some-script.js')).toBeNull();
  });

  it('classifies packaged Linux layouts (legacy managed + agent-runtime fallback)', () => {
    // Linux userData 在 ~/.config/<dir>/;linux-runtime-fallback 的 privateBinaryPath
    // 布局是 <userData>/agent-runtime/<kind>/bin/<cmd>
    expect(
      classifyAgentCommandLine(`/home/u/.config/${userDataDir}/agent-runtime/claude-code/bin/claude`),
    ).toBe('claude');
    expect(
      classifyAgentCommandLine(`/home/u/.config/${userDataDir}/agent-runtime/codex/bin/codex`),
    ).toBe('codex');
    expect(
      classifyAgentCommandLine(`/home/u/.config/${userDataDir}/claude-code/2.1.219/claude`),
    ).toBe('claude');
    expect(
      classifyAgentCommandLine(`/home/u/.config/${userDataDir}/codex/0.145.0/codex app-server`),
    ).toBe('codex');
    // 外部安装(不带 userData 目录)仍不认领
    expect(classifyAgentCommandLine('/home/u/.local/bin/claude')).toBeNull();
  });

  it('classifies redirected userData layouts after registerUserDataMarkers (XDG/--user-data-dir)', () => {
    // XDG_CONFIG_HOME 重定向后 userData 不在 ~/.config 下,静态品牌 marker 失配
    const redirected = '/mnt/data/xdg-alt/CindyCustom';
    expect(
      classifyAgentCommandLine(`${redirected.toLowerCase()}/agent-runtime/claude-code/bin/claude`),
    ).toBeNull(); // 注册前:不认识
    registerUserDataMarkers(redirected);
    expect(
      classifyAgentCommandLine(`${redirected.toLowerCase()}/agent-runtime/claude-code/bin/claude`),
    ).toBe('claude');
    expect(
      classifyAgentCommandLine(`${redirected.toLowerCase()}/agent-runtime/codex/bin/codex`),
    ).toBe('codex');
    expect(
      classifyAgentCommandLine(`${redirected.toLowerCase()}/claude-code/2.1.219/claude`),
    ).toBe('claude');
    // 重复注册整组替换(幂等):旧路径不残留
    registerUserDataMarkers('/somewhere/else/Cindy2');
    expect(
      classifyAgentCommandLine(`${redirected.toLowerCase()}/agent-runtime/claude-code/bin/claude`),
    ).toBeNull();
  });

  it('maps setPriority errno to apply results (default implementation)', async () => {
    const applyPriority = __testing.makeDefaultApplyPriority(fakeLog);
    const errWith = (code: string) => Object.assign(new Error(code), { code });
    // Node 真实形态:libuv 失败被包成 SystemError,顶层 code 恒为 ERR_SYSTEM_ERROR,
    // 真 errno 在 info.code
    const systemErrWith = (code: string) =>
      Object.assign(new Error(`A system error occurred: uv_os_setpriority returned ${code}`), {
        code: 'ERR_SYSTEM_ERROR',
        info: { code, errno: -1, syscall: 'uv_os_setpriority' },
      });

    for (const make of [errWith, systemErrWith]) {
      osMock.setPriority.mockImplementationOnce(() => {
        throw make('ESRCH');
      });
      await expect(applyPriority(11, 'low', undefined)).resolves.toBe('process-gone');

      osMock.setPriority.mockImplementationOnce(() => {
        throw make('EPERM');
      });
      await expect(applyPriority(11, 'low', undefined)).resolves.toBe('nice-raise-refused');

      osMock.setPriority.mockImplementationOnce(() => {
        throw make('EACCES');
      });
      await expect(applyPriority(11, 'low', undefined)).resolves.toBe('nice-raise-refused');
    }

    osMock.setPriority.mockImplementationOnce(() => {});
    await expect(applyPriority(11, 'low', undefined)).resolves.toBe('applied');
  });

  it('parses ps output and keeps only direct children of this process', () => {
    const selfPid = 4242;
    const psOutput = [
      `  100  ${selfPid} ${claudeCmd}`,
      `  101  ${selfPid} ${codexCmd}`,
      `  102  9999 ${claudeCmd}`, // 别的进程的孩子(如另一个 Cindy 实例)
      `  103  ${selfPid} ${externalClaudeCmd}`,
      `  104  ${selfPid} /applications/cindy.app/contents/macos/cindy helper`,
      'garbage line',
    ].join('\n');
    expect(parsePosixAgentProcesses(psOutput, selfPid)).toEqual([
      { pid: 100, kind: 'claude' },
      { pid: 101, kind: 'codex' },
    ]);
  });
});
