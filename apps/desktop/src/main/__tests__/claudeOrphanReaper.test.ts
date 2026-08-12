/**
 * claudeOrphanReaper.test.ts
 * ---------------------------------------------------------------------------
 * 单测只覆盖同步 reaper 的识别 / 容错语义。真实 taskkill / pgrep / kill 由
 * 平台集成验证兜底，避免测试环境误碰本机进程树。
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

type ExecFileSyncMock = ReturnType<typeof vi.fn>;
type SpawnSyncMock = ReturnType<typeof vi.fn>;

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
  execFileSync?: ExecFileSyncMock;
  spawnSync?: SpawnSyncMock;
}) {
  vi.resetModules();
  setPlatform(options.platform);
  vi.doMock('../logger', () => ({
    createLogger: () => logger,
  }));
  vi.doMock('node:child_process', () => ({
    execFileSync: options.execFileSync ?? vi.fn(),
    spawnSync: options.spawnSync ?? vi.fn(),
  }));
  return import('../claude-orphan-reaper');
}

describe('reapClaudeOrphansSync', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('../logger');
    vi.doUnmock('node:child_process');
    restorePlatform();
    logger.debug.mockReset();
    logger.info.mockReset();
    logger.warn.mockReset();
  });

  it('kills current main-process children and historical same-region orphans', async () => {
    const selfChildPid = 111;
    const historicalPid = 222;
    const livePeerPid = 333;
    const externalPid = 444;
    const execFileSync = vi.fn((file: string) => {
      if (file === 'taskkill') return '';
      return [
        `${selfChildPid}|${process.pid}|C:\\tools\\claude.exe`,
        `${historicalPid}|99999|C:\\Users\\me\\AppData\\Roaming\\CindyGlobal\\claude-code\\claude.exe`,
        `${livePeerPid}|88888|C:\\Users\\me\\AppData\\Roaming\\CindyGlobal\\claude-code\\claude.exe`,
        `${externalPid}|77777|C:\\Users\\me\\.local\\bin\\claude.exe`,
      ].join('\n');
    });
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number) => {
      if (pid === 99999 || pid === 77777) {
        const err = new Error('missing') as NodeJS.ErrnoException;
        err.code = 'ESRCH';
        throw err;
      }
      return true;
    }) as typeof process.kill);
    const { reapClaudeOrphansSync } = await importReaper({ platform: 'win32', execFileSync });

    const result = reapClaudeOrphansSync();

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
    const execFileSync = vi.fn((file: string) => {
      if (file === 'taskkill') return '';
      return [
        `${systemOrphanPid}|4|C:\\Users\\me\\AppData\\Roaming\\CindyGlobal\\claude-code\\claude.exe`,
        `${selfChildPid}|${process.pid}|C:\\Users\\me\\AppData\\Roaming\\CindyGlobal\\claude-code\\claude.exe`,
      ].join('\n');
    });
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((() => true) as typeof process.kill);
    const { reapClaudeOrphansSync } = await importReaper({ platform: 'win32', execFileSync });

    const result = reapClaudeOrphansSync();

    expect(result.killedHistoricalOrphans).toBe(1);
    expect(result.killedSelfSpawned).toBe(1);
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('matches all current Global Claude binary path marker shapes', async () => {
    const pids = [701, 702, 703];
    const execFileSync = vi.fn((file: string) => {
      if (file === 'taskkill') return '';
      return [
        `${pids[0]}|4|C:\\Users\\me\\AppData\\Roaming\\CindyGlobal\\claude-code\\claude.exe`,
        `${pids[1]}|4|C:/Users/me/AppData/Roaming/CindyGlobal/claude-code/claude.exe`,
        `${pids[2]}|4|/Users/me/Library/Application Support/CindyGlobal/claude-code/claude`,
      ].join('\n');
    });
    const { reapClaudeOrphansSync } = await importReaper({ platform: 'win32', execFileSync });

    const result = reapClaudeOrphansSync();

    expect(result.killedHistoricalOrphans).toBe(3);
    for (const pid of pids) {
      expect(execFileSync).toHaveBeenCalledWith(
        'taskkill',
        ['/T', '/F', '/PID', String(pid)],
        expect.objectContaining({ stdio: 'ignore' }),
      );
    }
  });

  it('does not claim historical CN xdt-maker processes from a Global build', async () => {
    const cnHistoricalPid = 704;
    const execFileSync = vi.fn((file: string) => {
      if (file === 'taskkill') return '';
      return `${cnHistoricalPid}|4|C:\\Users\\me\\AppData\\Roaming\\xdt-maker\\claude-code\\claude.exe`;
    });
    const { reapClaudeOrphansSync } = await importReaper({ platform: 'win32', execFileSync });

    const result = reapClaudeOrphansSync();

    expect(result.killedHistoricalOrphans).toBe(0);
    expect(execFileSync).not.toHaveBeenCalledWith(
      'taskkill',
      expect.anything(),
      expect.anything(),
    );
  });

  it('does not throw when scanning fails', async () => {
    const execFileSync = vi.fn(() => {
      throw new Error('scan failed');
    });
    const { reapClaudeOrphansSync } = await importReaper({ platform: 'win32', execFileSync });

    expect(() => reapClaudeOrphansSync()).not.toThrow();
    expect(reapClaudeOrphansSync().scannedTotal).toBe(0);
    expect(logger.debug).toHaveBeenCalled();
  });

  it('does not throw when killing fails', async () => {
    const execFileSync = vi.fn((file: string) => {
      if (file === 'taskkill') throw new Error('already gone');
      return `${process.pid + 10}|${process.pid}|C:\\tools\\claude.exe`;
    });
    const { reapClaudeOrphansSync } = await importReaper({ platform: 'win32', execFileSync });

    let result: ReturnType<typeof reapClaudeOrphansSync> | undefined;
    expect(() => { result = reapClaudeOrphansSync(); }).not.toThrow();
    expect(result?.killedSelfSpawned).toBe(0);
    expect(logger.debug).toHaveBeenCalled();
  });

  it('buildClaudePathMarkers 为每个 userData 目录名(含历史值)生成三种路径形态', async () => {
    // 品牌改名迁移窗口期,老安装 spawn 的 claude 命令行里仍是旧目录名——
    // 标记表必须同时覆盖 brand-identity 的当前值与 legacyUserDataDirNames。
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

  it('pipes Get-CimInstance into ForEach-Object in the Windows scan script', async () => {
    // 回归锚(2026-07-14):管道符缺失时两条语句独立执行,ForEach-Object 拿不到
    // 输入,扫描永远 0 行且不报错——收割器在 Windows 上静默失明。
    // 带参数签名的 mock:零参 vi.fn 会把 mock.calls 推成空元组,下标访问过不了 typecheck。
    const execFileSync = vi.fn((_file: string, _args?: string[], _opts?: unknown) => '');
    const { reapClaudeOrphansSync } = await importReaper({ platform: 'win32', execFileSync });

    reapClaudeOrphansSync();

    const psCall = execFileSync.mock.calls.find(([file]) => file === 'powershell.exe');
    expect(psCall).toBeDefined();
    const script = (psCall![1] as string[])[3];
    expect(script).toMatch(/\|\s*ForEach-Object/);
    expect(psCall![2]).toEqual(expect.objectContaining({ timeout: 5000 }));
  });

  it('warns when scan output is non-empty but unparseable (format drift self-check)', async () => {
    // 无管道符时 PowerShell 输出的就是这种格式化表格:有行、无 | 分隔。
    const execFileSync = vi.fn((file: string) => {
      if (file === 'taskkill') return '';
      return [
        'ProcessId Name       HandleCount',
        '--------- ----       -----------',
        '47140     claude.exe 1219',
      ].join('\n');
    });
    const { reapClaudeOrphansSync } = await importReaper({ platform: 'win32', execFileSync });

    const result = reapClaudeOrphansSync();

    expect(result.scannedTotal).toBe(0);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('unparseable'),
      expect.objectContaining({ lineCount: 3 }),
    );
  });

  it('does not warn when scan output is genuinely empty', async () => {
    const execFileSync = vi.fn(() => '');
    const { reapClaudeOrphansSync } = await importReaper({ platform: 'win32', execFileSync });

    expect(reapClaudeOrphansSync().scannedTotal).toBe(0);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('reaps dev-checkout orphans launched from apps/claude-code-bin', async () => {
    const devOrphanPid = process.pid + 10;
    const worktreeOrphanPid = process.pid + 11;
    const liveDevPeerPid = process.pid + 12;
    const execFileSync = vi.fn((file: string) => {
      if (file === 'taskkill') return '';
      return [
        `${devOrphanPid}|99999|E:\\AIWork\\Lizi\\apps\\claude-code-bin\\win32-x64\\claude.exe --output-format stream-json`,
        `${worktreeOrphanPid}|99999|E:/AIWork/Lizi/.xdt-worktrees/foo/apps/claude-code-bin/win32-x64/claude.exe`,
        `${liveDevPeerPid}|88888|E:\\Other\\Lizi\\apps\\claude-code-bin\\win32-x64\\claude.exe`,
      ].join('\n');
    });
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number) => {
      if (pid === 99999) {
        const err = new Error('missing') as NodeJS.ErrnoException;
        err.code = 'ESRCH';
        throw err;
      }
      return true; // 88888 alive → 另一个活着的 checkout 实例,必须放过
    }) as typeof process.kill);
    const { reapClaudeOrphansSync } = await importReaper({ platform: 'win32', execFileSync });

    const result = reapClaudeOrphansSync();

    expect(result.killedHistoricalOrphans).toBe(2);
    expect(killSpy).toHaveBeenCalledWith(88888, 0);
    expect(execFileSync).not.toHaveBeenCalledWith(
      'taskkill',
      ['/T', '/F', '/PID', String(liveDevPeerPid)],
      expect.anything(),
    );
  });

  it('matches Windows path markers case-insensitively', async () => {
    const lowercasePid = 801;
    const execFileSync = vi.fn((file: string) => {
      if (file === 'taskkill') return '';
      return `${lowercasePid}|4|C:\\users\\me\\appdata\\roaming\\cindyglobal\\claude-code\\claude.exe`;
    });
    const { reapClaudeOrphansSync } = await importReaper({ platform: 'win32', execFileSync });

    const result = reapClaudeOrphansSync();
    expect(result.killedHistoricalOrphans).toBe(1);
  });

  it('scans POSIX, walks the in-memory ppid map, and skips external claude installs', async () => {
    const claudePid = process.pid + 20;
    const childPid = process.pid + 21;
    const grandchildPid = process.pid + 22;
    const externalClaudePid = process.pid + 30;
    const spawnSync = vi.fn((file: string, _args: readonly string[] = []) => {
      void _args;
      if (file === 'ps') {
        return {
          status: 0,
          stdout: [
            // Class A: current-process child via xdt-maker bundled claude
            `${claudePid} ${process.pid} /Users/me/Library/Application Support/xdt-maker/claude-code/claude`,
            // Descendants of claudePid (cmd/npx-like)
            `${childPid} ${claudePid} /bin/sh -c lark-mcp`,
            `${grandchildPid} ${childPid} node lark-mcp`,
            // External claude install — must NOT be killed
            `${externalClaudePid} 1 /usr/local/bin/claude --help`,
          ].join('\n') + '\n',
        };
      }
      return { status: 0, stdout: '' };
    });
    const { reapClaudeOrphansSync } = await importReaper({ platform: 'darwin', spawnSync });

    const result = reapClaudeOrphansSync();

    expect(result.killedSelfSpawned).toBe(1);
    expect(result.killedHistoricalOrphans).toBe(0);
    expect(spawnSync).toHaveBeenCalledWith(
      'ps',
      ['-A', '-o', 'pid=,ppid=,command='],
      expect.objectContaining({ encoding: 'utf8' }),
    );
    // Tree-walk produced root + child + grandchild from the in-memory map, no pgrep involved.
    expect(spawnSync).toHaveBeenCalledWith(
      'kill',
      ['-9', String(claudePid), String(childPid), String(grandchildPid)],
      expect.objectContaining({ timeout: 1000 }),
    );
    // External claude must not be in any kill invocation.
    const killCalls = spawnSync.mock.calls.filter(([file]) => file === 'kill');
    for (const [, args] of killCalls) {
      expect(args).not.toContain(String(externalClaudePid));
    }
    // pgrep is no longer used — the old recursive walk is gone.
    expect(spawnSync).not.toHaveBeenCalledWith('pgrep', expect.anything(), expect.anything());
  });
});
