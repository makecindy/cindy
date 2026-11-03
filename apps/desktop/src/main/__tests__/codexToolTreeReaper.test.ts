/**
 * codexToolTreeReaper.test.ts
 * ---------------------------------------------------------------------------
 * 只验证归属判定与杀树范围；ps / kill 全部 mock，不碰本机进程。
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

const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

async function importReaper(options: {
  platform: NodeJS.Platform;
  spawnSync: ReturnType<typeof vi.fn>;
}) {
  vi.resetModules();
  setPlatform(options.platform);
  vi.doMock('../logger', () => ({ createLogger: () => logger }));
  vi.doMock('node:child_process', () => ({
    execFileSync: vi.fn(),
    spawnSync: options.spawnSync,
  }));
  const registry = await import('../process-monitor/codex-process-registry');
  const reaper = await import('../codex-tool-tree-reaper');
  return { ...registry, ...reaper };
}

function psSpawn(rows: Array<[number, number]>) {
  return vi.fn((file: string) => {
    if (file === 'ps') {
      return { status: 0, stdout: rows.map(([pid, ppid]) => `  ${pid}   ${ppid}`).join('\n') };
    }
    return { status: 0, stdout: '' };
  });
}

function killedPids(spawnSync: ReturnType<typeof vi.fn>): number[][] {
  return spawnSync.mock.calls
    .filter(([file]) => file === 'kill')
    .map(([, args]) =>
      (args as string[])
        .slice(1)
        .map(Number)
        .sort((a, b) => a - b),
    );
}

describe('reapCodexToolTreesSync', () => {
  afterEach(() => {
    vi.doUnmock('../logger');
    vi.doUnmock('node:child_process');
    setPlatform(originalPlatform);
    logger.debug.mockReset();
    logger.info.mockReset();
  });

  it('kills tool trees below own app-servers but keeps app-server itself for EOF close', async () => {
    const self = process.pid;
    const spawnSync = psSpawn([
      [100, self], // registered app-server
      [101, 100], // xcodebuild
      [102, 101], // build service
      [103, 102], // swift-frontend
      [104, 100], // MCP server
      [200, self], // unregistered sibling (e.g. claude)
      [201, 200],
    ]);
    const { registerCodexProcessRole, reapCodexToolTreesSync } = await importReaper({
      platform: 'darwin',
      spawnSync,
    });
    registerCodexProcessRole(100, 'task-host');

    const result = reapCodexToolTreesSync();

    expect(result).toMatchObject({ appServers: 1, killedToolTrees: 2 });
    expect(killedPids(spawnSync)).toEqual([[101, 102, 103], [104]]);
  });

  it('ignores an exited app-server whose pid is reused by another own child', async () => {
    const spawnSync = psSpawn([
      [100, process.pid], // e.g. quit watchdog shell reusing the old app-server pid
      [101, 100],
    ]);
    const { registerCodexProcessRole, reapCodexToolTreesSync } = await importReaper({
      platform: 'darwin',
      spawnSync,
    });
    const dispose = registerCodexProcessRole(100, 'task-host');
    dispose(); // transport confirmed the app-server exited

    reapCodexToolTreesSync();
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it('skips a registered pid whose parent is no longer this process (pid reuse)', async () => {
    const spawnSync = psSpawn([
      [100, 1],
      [101, 100],
    ]);
    const { registerCodexProcessRole, reapCodexToolTreesSync } = await importReaper({
      platform: 'darwin',
      spawnSync,
    });
    registerCodexProcessRole(100, 'task-host');

    expect(reapCodexToolTreesSync()).toMatchObject({ appServers: 0, killedToolTrees: 0 });
    expect(killedPids(spawnSync)).toEqual([]);
  });

  it('does not scan without registered app-servers or on Windows', async () => {
    const spawnSync = psSpawn([]);
    const first = await importReaper({ platform: 'darwin', spawnSync });
    first.reapCodexToolTreesSync();
    expect(spawnSync).not.toHaveBeenCalled();

    const second = await importReaper({ platform: 'win32', spawnSync });
    second.registerCodexProcessRole(100, 'task-host');
    second.reapCodexToolTreesSync();
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it('does not throw when scanning fails', async () => {
    const spawnSync = vi.fn(() => ({ error: new Error('ps missing') }));
    const { registerCodexProcessRole, reapCodexToolTreesSync } = await importReaper({
      platform: 'darwin',
      spawnSync,
    });
    registerCodexProcessRole(100, 'task-host');

    expect(() => reapCodexToolTreesSync()).not.toThrow();
    expect(logger.debug).toHaveBeenCalledWith('failed to scan processes', { error: 'ps missing' });
  });
});
