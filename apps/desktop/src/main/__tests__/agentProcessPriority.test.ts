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

import { allUserDataDirNames } from '@cindy/maker-shared/brand-identity';

import {
  classifyAgentCommandLine,
  createAgentProcessPriorityWatcher,
  parsePosixAgentProcesses,
  type AgentProcessRow,
} from '../agent-process-priority';
import type { AgentProcessPriority } from '../maker-host/agent-resource-settings-store';
import { CURRENT_CINDY_REGION } from '../../shared/brandRegion.js';

const fakeLog = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };

function makeWatcher(opts: {
  priority: () => AgentProcessPriority;
  rows: () => AgentProcessRow[];
  applyResult?: (pid: number) => boolean;
}) {
  const scan = vi.fn(async () => opts.rows());
  const apply = vi.fn(
    async (pid: number, _tier: AgentProcessPriority, _prev: AgentProcessPriority | undefined) =>
      opts.applyResult ? opts.applyResult(pid) : true,
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
      applyResult: (pid) => pid !== 22, // 22 在 apply 时已退出
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

  it('survives a throwing scan without breaking later ticks', async () => {
    let shouldThrow = true;
    const apply = vi.fn(async () => true);
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
