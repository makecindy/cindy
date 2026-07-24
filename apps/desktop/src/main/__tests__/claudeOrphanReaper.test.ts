/**
 * claudeOrphanReaper.test.ts
 * ---------------------------------------------------------------------------
 * 单测覆盖异步 reaper 的识别 / 容错语义。真实 taskkill / Win32 snapshot /
 * ps / kill 由平台集成验证兜底，避免测试环境误碰本机进程树。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
};

interface WindowsProcessRow {
  name: string;
  pid: number;
  ppid: number;
  commandLine?: string;
}

type ExecFileSyncMock = ReturnType<typeof vi.fn>;
type SpawnSyncMock = ReturnType<typeof vi.fn>;
type GetAllProcessesMock = ReturnType<typeof vi.fn>;

const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    value: platform,
    configurable: true,
  });
}

function restorePlatform(): void {
  Object.defineProperty(process, 'platform', {
    value: originalPlatform,
    configurable: true,
  });
}

async function importReaper(options: {
  platform: NodeJS.Platform;
  windowsProcesses?: WindowsProcessRow[];
  getAllProcesses?: GetAllProcessesMock;
  execFileSync?: ExecFileSyncMock;
  spawnSync?: SpawnSyncMock;
}) {
  vi.resetModules();
  setPlatform(options.platform);
  vi.doMock('../logger', () => ({
    createLogger: () => logger,
  }));
  vi.doMock('@vscode/windows-process-tree', () => ({
    ProcessDataFlag: { None: 0, Memory: 1, CommandLine: 2 },
    getAllProcesses:
      options.getAllProcesses ??
      vi.fn((callback: (processes: WindowsProcessRow[]) => void) => {
        callback(options.windowsProcesses ?? []);
      }),
  }));
  vi.doMock('node:child_process', () => ({
    execFileSync: options.execFileSync ?? vi.fn(),
    spawnSync: options.spawnSync ?? vi.fn(),
  }));
  return import('../claude-orphan-reaper');
}

describe('reapClaudeOrphans', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('../logger');
    vi.doUnmock('@vscode/windows-process-tree');
    vi.doUnmock('node:child_process');
    restorePlatform();
    logger.debug.mockReset();
    logger.info.mockReset();
    logger.warn.mockReset();
  });

  it('kills current main-process children and historical Cindy orphans', async () => {
    const selfChildPid = 111;
    const historicalPid = 222;
    const livePeerPid = 333;
    const externalPid = 444;
    const execFileSync = vi.fn();
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number) => {
      if (pid === 99999 || pid === 77777) {
        const err = new Error('missing') as NodeJS.ErrnoException;
        err.code = 'ESRCH';
        throw err;
      }
      return true;
    }) as typeof process.kill);
    const { reapClaudeOrphans } = await importReaper({
      platform: 'win32',
      execFileSync,
      windowsProcesses: [
        {
          name: 'claude.exe',
          pid: selfChildPid,
          ppid: process.pid,
          commandLine: 'C:\\tools\\claude.exe',
        },
        {
          name: 'claude.exe',
          pid: historicalPid,
          ppid: 99999,
          commandLine: 'C:\\Users\\me\\AppData\\Roaming\\xdt-maker\\claude-code\\claude.exe',
        },
        {
          name: 'CLAUDE.EXE',
          pid: livePeerPid,
          ppid: 88888,
          commandLine: 'C:\\Users\\me\\AppData\\Roaming\\xdt-maker\\claude-code\\claude.exe',
        },
        {
          name: 'claude.exe',
          pid: externalPid,
          ppid: 77777,
          commandLine: 'C:\\Users\\me\\.local\\bin\\claude.exe',
        },
        {
          name: 'notepad.exe',
          pid: 555,
          ppid: process.pid,
          commandLine: 'C:\\Windows\\notepad.exe',
        },
      ],
    });

    const result = await reapClaudeOrphans();

    expect(result.scannedTotal).toBe(4);
    expect(result.killedSelfSpawned).toBe(1);
    expect(result.killedHistoricalOrphans).toBe(1);
    expect(killSpy).toHaveBeenCalledWith(99999, 0);
    expect(killSpy).toHaveBeenCalledWith(88888, 0);
    expect(execFileSync).toHaveBeenCalledWith(
      'taskkill',
      ['/T', '/F', '/PID', String(selfChildPid)],
      expect.objectContaining({ stdio: 'ignore' }),
    );
    expect(execFileSync).toHaveBeenCalledWith(
      'taskkill',
      ['/T', '/F', '/PID', String(historicalPid)],
      expect.objectContaining({ stdio: 'ignore' }),
    );
    expect(execFileSync).not.toHaveBeenCalledWith(
      'taskkill',
      ['/T', '/F', '/PID', String(livePeerPid)],
      expect.anything(),
    );
    expect(execFileSync).not.toHaveBeenCalledWith(
      'taskkill',
      ['/T', '/F', '/PID', String(externalPid)],
      expect.anything(),
    );
  });

  it('treats PPID <= 4 as dead and PPID === process.pid as alive without probing', async () => {
    const systemOrphanPid = 555;
    const selfChildPid = 666;
    const killSpy = vi
      .spyOn(process, 'kill')
      .mockImplementation((() => true) as typeof process.kill);
    const { reapClaudeOrphans } = await importReaper({
      platform: 'win32',
      windowsProcesses: [
        {
          name: 'claude.exe',
          pid: systemOrphanPid,
          ppid: 4,
          commandLine: 'C:\\Users\\me\\AppData\\Roaming\\xdt-maker\\claude-code\\claude.exe',
        },
        {
          name: 'claude.exe',
          pid: selfChildPid,
          ppid: process.pid,
          commandLine: 'C:\\Users\\me\\AppData\\Roaming\\xdt-maker\\claude-code\\claude.exe',
        },
      ],
    });

    const result = await reapClaudeOrphans();

    expect(result.killedHistoricalOrphans).toBe(1);
    expect(result.killedSelfSpawned).toBe(1);
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('matches all Cindy Claude binary path markers', async () => {
    const pids = [701, 702, 703];
    const execFileSync = vi.fn();
    const { reapClaudeOrphans } = await importReaper({
      platform: 'win32',
      execFileSync,
      windowsProcesses: [
        {
          name: 'claude.exe',
          pid: pids[0],
          ppid: 4,
          commandLine: 'C:\\Users\\me\\AppData\\Roaming\\xdt-maker\\claude-code\\claude.exe',
        },
        {
          name: 'claude.exe',
          pid: pids[1],
          ppid: 4,
          commandLine: 'C:/Users/me/AppData/Roaming/xdt-maker/claude-code/claude.exe',
        },
        {
          name: 'claude.exe',
          pid: pids[2],
          ppid: 4,
          commandLine: '/Users/me/Library/Application Support/xdt-maker/claude-code/claude',
        },
      ],
    });

    const result = await reapClaudeOrphans();

    expect(result.killedHistoricalOrphans).toBe(3);
    for (const pid of pids) {
      expect(execFileSync).toHaveBeenCalledWith(
        'taskkill',
        ['/T', '/F', '/PID', String(pid)],
        expect.objectContaining({ stdio: 'ignore' }),
      );
    }
  });

  it('does not throw when the native Windows scan fails', async () => {
    const getAllProcesses = vi.fn(() => {
      throw new Error('scan failed');
    });
    const { reapClaudeOrphans } = await importReaper({
      platform: 'win32',
      getAllProcesses,
    });

    await expect(reapClaudeOrphans()).resolves.toEqual(
      expect.objectContaining({ scannedTotal: 0 }),
    );
    expect(logger.debug).toHaveBeenCalled();
  });

  it('does not throw when killing fails', async () => {
    const execFileSync = vi.fn(() => {
      throw new Error('already gone');
    });
    const { reapClaudeOrphans } = await importReaper({
      platform: 'win32',
      execFileSync,
      windowsProcesses: [
        {
          name: 'claude.exe',
          pid: process.pid + 10,
          ppid: process.pid,
          commandLine: 'C:\\tools\\claude.exe',
        },
      ],
    });

    const result = await reapClaudeOrphans();

    expect(result.killedSelfSpawned).toBe(0);
    expect(logger.debug).toHaveBeenCalled();
  });

  it('buildClaudePathMarkers 为每个 userData 目录名(含历史值)生成三种路径形态', async () => {
    const { buildClaudePathMarkers } = await importReaper({ platform: 'win32' });
    const markers = buildClaudePathMarkers(['Cindy', 'xdt-maker']);
    expect(markers).toEqual([
      'appdata\\roaming\\cindy\\claude-code\\',
      'appdata/roaming/cindy/claude-code/',
      '/library/application support/cindy/claude-code/',
      'appdata\\roaming\\xdt-maker\\claude-code\\',
      'appdata/roaming/xdt-maker/claude-code/',
      '/library/application support/xdt-maker/claude-code/',
    ]);
  });

  it('uses a native command-line snapshot without launching PowerShell', async () => {
    const getAllProcesses = vi.fn((callback: (processes: WindowsProcessRow[]) => void) => {
      callback([]);
    });
    const execFileSync = vi.fn();
    const { reapClaudeOrphans } = await importReaper({
      platform: 'win32',
      getAllProcesses,
      execFileSync,
    });

    await reapClaudeOrphans();

    expect(getAllProcesses).toHaveBeenCalledWith(expect.any(Function), 2);
    expect(execFileSync.mock.calls.some(([file]) => file === 'powershell.exe')).toBe(false);
  });

  it('reaps dev-checkout orphans launched from apps/claude-code-bin', async () => {
    const devOrphanPid = 901;
    const worktreeOrphanPid = 902;
    const liveDevPeerPid = 903;
    const execFileSync = vi.fn();
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number) => {
      if (pid === 99999) {
        const err = new Error('missing') as NodeJS.ErrnoException;
        err.code = 'ESRCH';
        throw err;
      }
      return true;
    }) as typeof process.kill);
    const { reapClaudeOrphans } = await importReaper({
      platform: 'win32',
      execFileSync,
      windowsProcesses: [
        {
          name: 'claude.exe',
          pid: devOrphanPid,
          ppid: 99999,
          commandLine:
            'E:\\AIWork\\Lizi\\apps\\claude-code-bin\\win32-x64\\claude.exe --output-format stream-json',
        },
        {
          name: 'claude.exe',
          pid: worktreeOrphanPid,
          ppid: 99999,
          commandLine:
            'E:/AIWork/Lizi/.xdt-worktrees/foo/apps/claude-code-bin/win32-x64/claude.exe',
        },
        {
          name: 'claude.exe',
          pid: liveDevPeerPid,
          ppid: 88888,
          commandLine: 'E:\\Other\\Lizi\\apps\\claude-code-bin\\win32-x64\\claude.exe',
        },
      ],
    });

    const result = await reapClaudeOrphans();

    expect(result.killedHistoricalOrphans).toBe(2);
    expect(killSpy).toHaveBeenCalledWith(88888, 0);
    expect(execFileSync).not.toHaveBeenCalledWith(
      'taskkill',
      ['/T', '/F', '/PID', String(liveDevPeerPid)],
      expect.anything(),
    );
  });

  it('matches Windows path markers case-insensitively', async () => {
    const { reapClaudeOrphans } = await importReaper({
      platform: 'win32',
      windowsProcesses: [
        {
          name: 'claude.exe',
          pid: 801,
          ppid: 4,
          commandLine: 'C:\\users\\me\\appdata\\roaming\\xdt-maker\\claude-code\\claude.exe',
        },
      ],
    });

    const result = await reapClaudeOrphans();
    expect(result.killedHistoricalOrphans).toBe(1);
  });

  it('scans POSIX, walks the in-memory ppid map, and skips external Claude installs', async () => {
    const claudePid = process.pid + 20;
    const childPid = process.pid + 21;
    const grandchildPid = process.pid + 22;
    const externalClaudePid = process.pid + 30;
    const spawnSync = vi.fn((file: string, _args: readonly string[] = []) => {
      void _args;
      if (file === 'ps') {
        return {
          status: 0,
          stdout:
            [
              `${claudePid} ${process.pid} /Users/me/Library/Application Support/xdt-maker/claude-code/claude`,
              `${childPid} ${claudePid} /bin/sh -c lark-mcp`,
              `${grandchildPid} ${childPid} node lark-mcp`,
              `${externalClaudePid} 1 /usr/local/bin/claude --help`,
            ].join('\n') + '\n',
        };
      }
      return { status: 0, stdout: '' };
    });
    const { reapClaudeOrphans } = await importReaper({
      platform: 'darwin',
      spawnSync,
    });

    const result = await reapClaudeOrphans();

    expect(result.killedSelfSpawned).toBe(1);
    expect(result.killedHistoricalOrphans).toBe(0);
    expect(spawnSync).toHaveBeenCalledWith(
      'ps',
      ['-A', '-o', 'pid=,ppid=,command='],
      expect.objectContaining({ encoding: 'utf8' }),
    );
    expect(spawnSync).toHaveBeenCalledWith(
      'kill',
      ['-9', String(claudePid), String(childPid), String(grandchildPid)],
      expect.objectContaining({ timeout: 1000 }),
    );
    const killCalls = spawnSync.mock.calls.filter(([file]) => file === 'kill');
    for (const [, args] of killCalls) {
      expect(args).not.toContain(String(externalClaudePid));
    }
    expect(spawnSync).not.toHaveBeenCalledWith('pgrep', expect.anything(), expect.anything());
  });
});
